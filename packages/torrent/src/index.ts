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
  type JoinRoom,
  type JoinRoomConfig,
  type OfferRecord,
  type SocketClient
} from '@trystero-p2p/core'

const relayManager = createRelayManager<SocketClient>(client => client.socket)
const topicToInfoHash: Record<string, string> = {}
const infoHashToTopic: Record<string, string> = {}
type TopicState = {
  announce: () => void | Promise<void>
  announceMs: number
  handler: (data: TrackerMessage) => void
  isActive: boolean
  startPassiveAnnouncements: () => void
  stopPassiveAnnouncements: () => void
  token: symbol
}

const handledSignals: Record<string, number> = {}
const topicStates = relayManager.scoped<TopicState>()
const roomOutstandingOffers: Record<
  string,
  Record<string, OfferRecord & {createdAt: number}>
> = {}
const roomOfferGenerationPromises: Record<string, Promise<void> | undefined> =
  {}
const roomSubscriberCounts: Record<string, number> = {}
const trackerAction = 'announce'
const hashLimit = 20
const offersPerAnnounce = 1
const requestedPeers = 3
const defaultAnnounceMs = 10_000
const dormantAnnounceMs = 120_000
const offerRetentionMs = 120_000
const signalDedupeWindowMs = 4_000
const defaultRedundancy = 3

export type TorrentRoomConfig = JoinRoomConfig

type TrackerMessage = {
  offer?: {
    type: 'offer'
    sdp: string
  }
  answer?: {
    type: 'answer'
    sdp: string
  }
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

const takeOutstandingOffer = (
  rootTopic: string,
  offerId: string,
  action: 'claim' | 'reclaim'
): OfferRecord | undefined => {
  const outstandingOffers = roomOutstandingOffers[rootTopic]
  const offer = outstandingOffers?.[offerId]

  if (!offer) {
    return
  }

  delete outstandingOffers[offerId]
  offer[action]?.()

  if (!keys(outstandingOffers).length && !roomSubscriberCounts[rootTopic]) {
    deleteRoomOfferBookkeeping(rootTopic)
  }

  return offer
}

const reclaimAllOutstandingOffers = (rootTopic: string): void => {
  keys(getRoomOutstandingOffers(rootTopic)).forEach(offerId =>
    takeOutstandingOffer(rootTopic, offerId, 'reclaim')
  )
  deleteRoomOfferBookkeeping(rootTopic)
}

const pruneOutstandingOffers = (rootTopic: string): void => {
  const now = Date.now()

  entries(getRoomOutstandingOffers(rootTopic)).forEach(([offerId, offer]) => {
    if (now - offer.createdAt > offerRetentionMs) {
      takeOutstandingOffer(rootTopic, offerId, 'reclaim')
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
    const missingOffers = Math.max(0, offersPerAnnounce - outstandingCount)

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
      const client = relayManager.register(rawUrl, () =>
        makeSocket(
          rawUrl,
          rawData => {
            const data = fromJson<TrackerMessage>(rawData)
            const errMsg = data['failure reason']
            const warnMsg = data['warning message']
            const {interval} = data
            const topic = data.info_hash
              ? infoHashToTopic[data.info_hash]
              : undefined

            if (errMsg) {
              if (config.relayConfig?.warnOnRelayFailure !== false) {
                warn(client.url, errMsg, true)
              }

              return
            }

            if (warnMsg && config.relayConfig?.warnOnRelayFailure !== false) {
              warn(client.url, warnMsg)
            }

            const state = topic ? topicStates.forKey(rawUrl)[topic] : undefined

            if (interval && state) {
              state.announceMs = Math.min(
                Math.max(interval * 1000, defaultAnnounceMs),
                offerRetentionMs
              )
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

              state?.handler(data)
            }
          },
          () =>
            Object.values(topicStates.forKey(rawUrl)).forEach(
              state => void state.announce()
            )
        )
      )

      return client.ready
    }),

  subscribe: (client, rootTopic, _, onMessage, getOffers, context) => {
    const states = topicStates.forRelay(client)
    const subscriptionToken = Symbol(rootTopic)

    roomSubscriberCounts[rootTopic] = (roomSubscriberCounts[rootTopic] ?? 0) + 1

    let passiveAnnounceTimeout: ReturnType<typeof setTimeout> | undefined
    const stopPassiveAnnouncements = (): void => {
      clearTimeout(passiveAnnounceTimeout)
      passiveAnnounceTimeout = undefined
    }
    const topicState: TopicState = {
      announce: async () => {
        if (states[rootTopic]?.token !== subscriptionToken) {
          return
        }

        if (!topicState.isActive) {
          void send(client, rootTopic, {
            left: 0,
            numwant: requestedPeers,
            offers: []
          })
          return
        }

        let outstandingOffers: Record<string, OfferRecord & {createdAt: number}>

        try {
          outstandingOffers = await ensureOutstandingOffers(
            rootTopic,
            getOffers
          )
        } catch (error) {
          if (states[rootTopic]?.token !== subscriptionToken) {
            return
          }

          throw error
        }

        if (
          states[rootTopic]?.token !== subscriptionToken ||
          !topicState.isActive
        ) {
          return
        }

        const offers = entries(outstandingOffers).map(([id, {offer}]) => ({
          offer_id: id,
          offer: {type: 'offer', sdp: offer}
        }))

        void send(client, rootTopic, {
          numwant: requestedPeers,
          offers
        })
      },
      announceMs: defaultAnnounceMs,
      handler: (data: TrackerMessage): void => {
        if (data.offer && data.peer_id && data.offer_id) {
          void onMessage(
            rootTopic,
            {
              offer: data.offer.sdp,
              offerId: data.offer_id,
              peerId: data.peer_id
            },
            (_, signal) =>
              void send(client, rootTopic, {
                answer: {
                  type: 'answer',
                  sdp: fromJson<{answer: string}>(signal).answer
                },
                offer_id: data.offer_id,
                to_peer_id: data.peer_id
              })
          )
        } else if (data.answer && data.offer_id && data.peer_id) {
          const offer = takeOutstandingOffer(rootTopic, data.offer_id, 'claim')

          if (offer) {
            void onMessage(
              rootTopic,
              {
                answer: data.answer.sdp,
                offerId: data.offer_id,
                peerId: data.peer_id,
                peer: offer.peer
              },
              () => {}
            )
            void topicState.announce()
          }
        }
      },
      isActive: !context?.isPassive,
      startPassiveAnnouncements: (): void => {
        stopPassiveAnnouncements()

        if (
          states[rootTopic]?.token !== subscriptionToken ||
          topicState.isActive
        ) {
          return
        }

        void topicState.announce()
        passiveAnnounceTimeout = setTimeout(
          topicState.startPassiveAnnouncements,
          Math.max(topicState.announceMs, dormantAnnounceMs)
        )
      },
      stopPassiveAnnouncements,
      token: subscriptionToken
    }

    states[rootTopic] = topicState

    if (!topicState.isActive) {
      topicState.startPassiveAnnouncements()
    }

    return () => {
      topicState.stopPassiveAnnouncements()
      roomSubscriberCounts[rootTopic] = Math.max(
        0,
        (roomSubscriberCounts[rootTopic] ?? 1) - 1
      )

      if (!roomSubscriberCounts[rootTopic]) {
        delete roomSubscriberCounts[rootTopic]
        reclaimAllOutstandingOffers(rootTopic)
      }

      if (states[rootTopic]?.token === subscriptionToken) {
        delete states[rootTopic]
      }
    }
  },

  announce: async (client, rootTopic) => {
    const state = topicStates.forRelay(client)[rootTopic]

    if (state) {
      state.stopPassiveAnnouncements()
      state.isActive = true
      await state.announce()
    }

    return state?.announceMs ?? defaultAnnounceMs
  },

  deactivate: (client, rootTopic) => {
    const state = topicStates.forRelay(client)[rootTopic]

    if (state) {
      state.isActive = false
    }

    reclaimAllOutstandingOffers(rootTopic)

    state?.startPassiveAnnouncements()
  }
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
  'open.ftorrent.com',
  'tracker.webtorrent.dev',
  'tracker.openwebtorrent.com',
  'tracker.btorrent.xyz',
  'tracker.files.fm:7073/announce'
].map(url => 'wss://' + url)

export type * from '@trystero-p2p/core'
