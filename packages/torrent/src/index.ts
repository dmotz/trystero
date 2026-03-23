import {
  createRelayManager,
  createStrategy,
  entries,
  fromJson,
  genId,
  getRelays,
  keys,
  libName,
  makeSocket,
  pauseRelayReconnection,
  resumeRelayReconnection,
  selfId,
  sha1,
  toJson,
  type BaseRoomConfig,
  type JoinRoom,
  type OfferRecord,
  type RelayConfig,
  type SocketClient
} from '@trystero-p2p/core'

const relayManager = createRelayManager<SocketClient>(client => client.socket)
const topicToInfoHash: Record<string, string> = {}
const infoHashToTopic: Record<string, string> = {}
const announceIntervals = relayManager.scoped<ReturnType<typeof setInterval>>()
const announceFns = relayManager.scoped<() => void | Promise<void>>()
const subscriptionTokens = relayManager.scoped<symbol>()
const trackerAnnounceMs: Record<string, number> = {}
const handledSignals: Record<string, number> = {}
const msgHandlers = relayManager.scoped<(data: TrackerMessage) => void>()
const roomOutstandingOffers: Record<
  string,
  Record<string, OfferRecord & {createdAt: number}>
> = {}
const roomOfferGenerationPromises: Record<string, Promise<void> | undefined> =
  {}
const roomSubscriberCounts: Record<string, number> = {}
const trackerAction = 'announce'
const hashLimit = 20
const offerPoolSize = 3
const defaultAnnounceMs = 10_000
const maxAnnounceMs = 20_000
const offerRetentionMs = 120_000
const signalDedupeWindowMs = 4_000
const defaultRedundancy = 3

export type TorrentRoomConfig = BaseRoomConfig & RelayConfig

type TrackerMessage = {
  offer?: unknown
  answer?: unknown
  offer_id?: string
  peer_id?: string
  info_hash?: string
  interval?: number
  ['failure reason']?: string
  ['warning message']?: string
}

const getInfoHash = async (topic: string): Promise<string> => {
  if (topicToInfoHash[topic]) {
    return topicToInfoHash[topic]
  }

  const hash = (await sha1(topic)).slice(0, hashLimit)
  topicToInfoHash[topic] = hash
  infoHashToTopic[hash] = topic

  return hash
}

const send = async (
  client: SocketClient,
  topic: string,
  payload: Record<string, unknown>
): Promise<void> =>
  client.send(
    toJson({
      action: trackerAction,
      info_hash: await getInfoHash(topic),
      peer_id: selfId,
      ...payload
    })
  )

const warn = (url: string, msg: string, didFail = false): void =>
  console.warn(
    `${libName}: torrent tracker ${didFail ? 'failure' : 'warning'} from ${url} - ${msg}`
  )

const getRoomOutstandingOffers = (
  rootTopic: string
): Record<string, OfferRecord & {createdAt: number}> =>
  (roomOutstandingOffers[rootTopic] ??= {})

const deleteRoomOfferBookkeeping = (rootTopic: string): void => {
  delete roomOutstandingOffers[rootTopic]
  delete roomOfferGenerationPromises[rootTopic]
}

const claimOutstandingOffer = (
  rootTopic: string,
  offerId: string
): OfferRecord | undefined => {
  const outstandingOffers = roomOutstandingOffers[rootTopic]
  const offer = outstandingOffers?.[offerId]

  if (!offer) {
    return
  }

  delete outstandingOffers[offerId]
  offer.claim?.()

  if (!keys(outstandingOffers).length && !roomSubscriberCounts[rootTopic]) {
    deleteRoomOfferBookkeeping(rootTopic)
  }

  return offer
}

const reclaimOutstandingOffer = (rootTopic: string, offerId: string): void => {
  const outstandingOffers = roomOutstandingOffers[rootTopic]
  const offer = outstandingOffers?.[offerId]

  if (!offer) {
    return
  }

  delete outstandingOffers[offerId]
  offer.reclaim?.()

  if (!keys(outstandingOffers).length && !roomSubscriberCounts[rootTopic]) {
    deleteRoomOfferBookkeeping(rootTopic)
  }
}

const reclaimAllOutstandingOffers = (rootTopic: string): void => {
  keys(getRoomOutstandingOffers(rootTopic)).forEach(offerId =>
    reclaimOutstandingOffer(rootTopic, offerId)
  )
  deleteRoomOfferBookkeeping(rootTopic)
}

const pruneOutstandingOffers = (rootTopic: string): void => {
  const now = Date.now()

  entries(getRoomOutstandingOffers(rootTopic)).forEach(([offerId, offer]) => {
    if (now - offer.createdAt > offerRetentionMs) {
      reclaimOutstandingOffer(rootTopic, offerId)
    }
  })
}

const ensureOutstandingOffers = async (
  rootTopic: string,
  getOffers: (n: number) => Promise<OfferRecord[]>
): Promise<Record<string, OfferRecord & {createdAt: number}>> => {
  while (roomOfferGenerationPromises[rootTopic]) {
    await roomOfferGenerationPromises[rootTopic]
  }

  const nextPromise = (async () => {
    pruneOutstandingOffers(rootTopic)

    const outstandingOffers = getRoomOutstandingOffers(rootTopic)
    const outstandingCount = keys(outstandingOffers).length
    const missingOffers = Math.max(0, offerPoolSize - outstandingCount)

    if (missingOffers > 0) {
      ;(await getOffers(missingOffers)).forEach(peerAndOffer => {
        outstandingOffers[genId(hashLimit)] = {
          ...peerAndOffer,
          createdAt: Date.now()
        }
      })
    }
  })().finally(() => {
    if (roomOfferGenerationPromises[rootTopic] === nextPromise) {
      delete roomOfferGenerationPromises[rootTopic]
    }
  })

  roomOfferGenerationPromises[rootTopic] = nextPromise
  await nextPromise

  return getRoomOutstandingOffers(rootTopic)
}

const joinRoomStrategy: JoinRoom<TorrentRoomConfig> = createStrategy({
  init: config =>
    getRelays(config, defaultRelayUrls, defaultRedundancy).map(rawUrl => {
      const client = relayManager.register(
        rawUrl,
        makeSocket(rawUrl, rawData => {
          const data = fromJson<TrackerMessage>(rawData)
          const errMsg = data['failure reason']
          const warnMsg = data['warning message']
          const {interval} = data
          const topic = data.info_hash
            ? infoHashToTopic[data.info_hash]
            : undefined

          if (errMsg) {
            warn(client.url, errMsg, true)
            return
          }

          if (warnMsg) {
            warn(client.url, warnMsg)
          }

          if (
            interval &&
            interval * 1000 >
              (trackerAnnounceMs[client.url] ?? defaultAnnounceMs) &&
            topic &&
            announceFns.forKey(rawUrl)[topic]
          ) {
            const nextInterval = Math.min(interval * 1000, maxAnnounceMs)
            const relayIntervals = announceIntervals.forKey(rawUrl)
            const relayFns = announceFns.forKey(rawUrl)

            if (relayIntervals[topic]) {
              clearInterval(relayIntervals[topic])
            }
            trackerAnnounceMs[client.url] = nextInterval
            const relayFn = relayFns[topic]

            if (relayFn) {
              relayIntervals[topic] = setInterval(() => {
                void relayFn()
              }, nextInterval)
            }
          }

          if ((data.offer || data.answer) && topic && data.offer_id) {
            if (data.peer_id === selfId) {
              return
            }

            const signalType = data.offer ? 'offer' : 'answer'
            const signalKey = `${topic}:${signalType}:${data.offer_id}:${data.peer_id ?? ''}`
            const nowMs = Date.now()
            const lastHandledMs = handledSignals[signalKey]

            if (
              typeof lastHandledMs === 'number' &&
              nowMs - lastHandledMs < signalDedupeWindowMs
            ) {
              return
            }

            handledSignals[signalKey] = nowMs

            entries(handledSignals).forEach(([key, handledAtMs]) => {
              if (nowMs - handledAtMs > signalDedupeWindowMs * 6) {
                delete handledSignals[key]
              }
            })

            msgHandlers.forKey(rawUrl)[topic]?.(data)
          }
        })
      )

      return client.ready
    }),

  subscribe: (client, rootTopic, _, onMessage, getOffers) => {
    const handlers = msgHandlers.forRelay(client)
    const relayFns = announceFns.forRelay(client)
    const relayIntervals = announceIntervals.forRelay(client)
    const activeTokens = subscriptionTokens.forRelay(client)
    const subscriptionToken = Symbol(rootTopic)

    activeTokens[rootTopic] = subscriptionToken
    roomSubscriberCounts[rootTopic] = (roomSubscriberCounts[rootTopic] ?? 0) + 1

    const topicHandler = (data: TrackerMessage): void => {
      if (data.offer && data.peer_id && data.offer_id) {
        void onMessage(
          rootTopic,
          {
            offer: data.offer,
            peerId: data.peer_id,
            hasOutgoingOffer:
              keys(getRoomOutstandingOffers(rootTopic)).length > 0
          },
          (_, signal) =>
            void send(client, rootTopic, {
              answer: fromJson<Record<string, unknown>>(signal)['answer'],
              offer_id: data.offer_id,
              to_peer_id: data.peer_id
            })
        )
      } else if (data.answer && data.offer_id && data.peer_id) {
        const offer = claimOutstandingOffer(rootTopic, data.offer_id)

        if (offer) {
          void onMessage(
            rootTopic,
            {
              answer: data.answer,
              peerId: data.peer_id,
              peer: offer.peer
            },
            () => {}
          )
        }
      }
    }

    handlers[rootTopic] = topicHandler

    const announce = async (): Promise<void> => {
      if (activeTokens[rootTopic] !== subscriptionToken) {
        return
      }

      const outstandingOffers = await ensureOutstandingOffers(
        rootTopic,
        getOffers
      )
      const offers = entries(outstandingOffers).map(([id, {offer}]) => ({
        offer_id: id,
        offer
      }))

      void send(client, rootTopic, {
        numwant: offerPoolSize,
        offers
      })
    }

    trackerAnnounceMs[client.url] = defaultAnnounceMs
    relayFns[rootTopic] = announce
    relayIntervals[rootTopic] = setInterval(
      announce,
      trackerAnnounceMs[client.url]
    )
    void announce()

    return () => {
      roomSubscriberCounts[rootTopic] = Math.max(
        0,
        (roomSubscriberCounts[rootTopic] ?? 1) - 1
      )

      if (!roomSubscriberCounts[rootTopic]) {
        delete roomSubscriberCounts[rootTopic]
      }

      if (activeTokens[rootTopic] !== subscriptionToken) {
        if (!roomSubscriberCounts[rootTopic]) {
          reclaimAllOutstandingOffers(rootTopic)
        }

        return
      }

      const interval = relayIntervals[rootTopic]
      if (interval) {
        clearInterval(interval)
        delete relayIntervals[rootTopic]
      }

      if (handlers[rootTopic] === topicHandler) {
        delete handlers[rootTopic]
      }

      if (relayFns[rootTopic] === announce) {
        delete relayFns[rootTopic]
      }

      delete activeTokens[rootTopic]

      if (!roomSubscriberCounts[rootTopic]) {
        reclaimAllOutstandingOffers(rootTopic)
      }
    }
  },

  announce: client => trackerAnnounceMs[client.url]
})

export const joinRoom: JoinRoom<TorrentRoomConfig> = (
  config,
  roomId,
  callbacks
) =>
  joinRoomStrategy(
    {
      ...config,
      trickleIce: config.trickleIce ?? false
    },
    roomId,
    callbacks
  )

export const getRelaySockets = relayManager.getSockets

export {pauseRelayReconnection, resumeRelayReconnection, selfId}

export const defaultRelayUrls = [
  'tracker.webtorrent.dev',
  'tracker.openwebtorrent.com',
  'tracker.btorrent.xyz',
  'tracker.files.fm:7073/announce'
].map(url => 'wss://' + url)

export type * from '@trystero-p2p/core'
