import {
  clearUserIdentity,
  createRelayManager,
  createRelayScopedStore,
  createStrategy,
  createUserIdentity,
  exportUserIdentity,
  fromJson,
  getRelays,
  hashTopic,
  importUserIdentity,
  libName,
  makeSocket,
  roles,
  scale,
  setRelayConnectivity,
  toJson,
  unrefTimer,
  type JoinRoom,
  type JoinRoomConfig,
  type OfferRecord,
  type SocketClient
} from '@trystero-p2p/core'

const relayManager = /*@__PURE__*/ createRelayManager<SocketClient>(
  client => client.socket,
  client => client.close?.()
)
const topicToInfoHash = new Map<string, string>()
const infoHashToTopic = new Map<string, string>()
type TopicState = {
  announce: () => void | Promise<void>
  announceMs: number
  handler: (data: TrackerMessage) => void
  peerId: string
  token: symbol
}

const handledSignals = new Map<string, number>()
const topicStates = /*@__PURE__*/ createRelayScopedStore<TopicState>()
const roomOutstandingOffers = new Map<
  string,
  Map<string, OfferRecord & {createdAt: number}>
>()
const roomOfferGenerationPromises = new Map<string, Promise<void>>()
const roomSubscriberCounts = new Map<string, number>()
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
  const existing = topicToInfoHash.get(topic)
  if (existing) {
    return existing
  }

  const hash = (await hashTopic(topic)).slice(0, hashLimit)
  topicToInfoHash.set(topic, hash)
  infoHashToTopic.set(hash, topic)

  return hash
}

const send = async (
  client: SocketClient,
  topic: string,
  peerId: string,
  payload: Record<string, unknown>
): Promise<void> =>
  client.send(
    toJson({
      action: trackerAction,
      info_hash: await getInfoHash(topic),
      peer_id: peerId,
      ...payload
    })
  )

const warn = (url: string, msg: string, didFail = false): void =>
  console.warn(
    `${libName}: torrent tracker ${didFail ? 'failure' : 'warning'} from ${url} - ${msg}`
  )

const getRoomOutstandingOffers = (
  rootTopic: string
): Map<string, OfferRecord & {createdAt: number}> => {
  let offers = roomOutstandingOffers.get(rootTopic)
  if (!offers) {
    offers = new Map()
    roomOutstandingOffers.set(rootTopic, offers)
  }
  return offers
}

const deleteRoomOfferBookkeeping = (rootTopic: string): void => {
  roomOutstandingOffers.delete(rootTopic)
  roomOfferGenerationPromises.delete(rootTopic)
}

const takeOutstandingOffer = (
  rootTopic: string,
  offerId: string,
  action: 'claim' | 'reclaim'
): OfferRecord | undefined => {
  const outstandingOffers = roomOutstandingOffers.get(rootTopic)
  const offer = outstandingOffers?.get(offerId)

  if (!offer || !outstandingOffers) {
    return undefined
  }

  outstandingOffers.delete(offerId)
  offer[action]?.()

  if (outstandingOffers.size === 0 && !roomSubscriberCounts.get(rootTopic)) {
    deleteRoomOfferBookkeeping(rootTopic)
  }

  return offer
}

const reclaimAllOutstandingOffers = (rootTopic: string): void => {
  ;[...getRoomOutstandingOffers(rootTopic).keys()].forEach(offerId =>
    takeOutstandingOffer(rootTopic, offerId, 'reclaim')
  )
  deleteRoomOfferBookkeeping(rootTopic)
}

const pruneOutstandingOffers = (rootTopic: string): void => {
  const now = Date.now()

  for (const [offerId, offer] of getRoomOutstandingOffers(rootTopic)) {
    if (now - offer.createdAt > offerRetentionMs) {
      takeOutstandingOffer(rootTopic, offerId, 'reclaim')
    }
  }
}

const ensureOutstandingOffers = async (
  rootTopic: string,
  getOffers: (n: number) => Promise<OfferRecord[]>
): Promise<Map<string, OfferRecord & {createdAt: number}>> => {
  while (roomOfferGenerationPromises.get(rootTopic)) {
    await roomOfferGenerationPromises.get(rootTopic)
  }

  const nextPromise = (async () => {
    pruneOutstandingOffers(rootTopic)

    const outstandingOffers = getRoomOutstandingOffers(rootTopic)
    const missingOffers = Math.max(
      0,
      offersPerAnnounce - outstandingOffers.size
    )

    if (missingOffers > 0) {
      ;(await getOffers(missingOffers)).forEach(peerAndOffer => {
        outstandingOffers.set(peerAndOffer.offerId, {
          ...peerAndOffer,
          createdAt: Date.now()
        })
      })
    }
  })().finally(() => {
    if (roomOfferGenerationPromises.get(rootTopic) === nextPromise) {
      roomOfferGenerationPromises.delete(rootTopic)
    }
  })

  roomOfferGenerationPromises.set(rootTopic, nextPromise)
  await nextPromise

  return getRoomOutstandingOffers(rootTopic)
}

export const joinRoom: JoinRoom<TorrentRoomConfig> =
  /*@__PURE__*/ createStrategy<SocketClient, TorrentRoomConfig>({
    defaultConfig: {trickleIce: false},
    init: config =>
      getRelays(config, defaultRelayUrls, defaultRedundancy).map(rawUrl => {
        const client = relayManager.register(rawUrl, () => {
          const created = makeSocket(
            rawUrl,
            rawData => {
              const parsed = fromJson<unknown>(rawData)
              if (
                !parsed ||
                typeof parsed !== 'object' ||
                Array.isArray(parsed)
              ) {
                return
              }
              const data = parsed as TrackerMessage
              const errMsg = data['failure reason']
              const warnMsg = data['warning message']
              const {interval} = data
              const topic =
                typeof data.info_hash === 'string'
                  ? infoHashToTopic.get(data.info_hash)
                  : undefined

              if (errMsg) {
                if (config.relayConfig?.warnOnRelayFailure !== false) {
                  warn(created.url, errMsg, true)
                }

                return
              }

              if (warnMsg && config.relayConfig?.warnOnRelayFailure !== false) {
                warn(created.url, warnMsg)
              }

              const state = topic
                ? topicStates.forRelay(created)[topic]
                : undefined

              if (interval && state) {
                state.announceMs = Math.min(
                  Math.max(interval * 1000, defaultAnnounceMs),
                  offerRetentionMs
                )
              }

              if ((data.offer || data.answer) && topic && data.offer_id) {
                if (state?.peerId && data.peer_id === state.peerId) {
                  return
                }

                const signalType = data.offer ? 'offer' : 'answer'
                const signalKey = `${topic}:${signalType}:${data.offer_id}:${data.peer_id ?? ''}`
                const nowMs = Date.now()
                const lastHandledMs = handledSignals.get(signalKey)

                if (
                  typeof lastHandledMs === 'number' &&
                  nowMs - lastHandledMs < signalDedupeWindowMs
                ) {
                  return
                }

                handledSignals.set(signalKey, nowMs)

                for (const [key, handledAtMs] of handledSignals) {
                  if (nowMs - handledAtMs > signalDedupeWindowMs * 6) {
                    handledSignals.delete(key)
                  }
                }

                state?.handler(data)
              }
            },
            () =>
              Object.values(topicStates.forRelay(created)).forEach(
                state => void state.announce()
              )
          )
          return created
        })

        return relayManager.lease(client, client.ready)
      }),

    subscribe: (client, rootTopic, _, onMessage, getOffers, context) => {
      const states = topicStates.forRelay(client)
      const subscriptionToken = Symbol(rootTopic)
      const isPassive = Boolean(context?.config.passive)

      roomSubscriberCounts.set(
        rootTopic,
        (roomSubscriberCounts.get(rootTopic) ?? 0) + 1
      )

      let passiveAnnounceTimeout: ReturnType<typeof setTimeout> | undefined
      const peerId = context?.peerId ?? ''
      const topicState: TopicState = {
        announce: async () => {
          if (states[rootTopic]?.token !== subscriptionToken) {
            return
          }

          if (isPassive) {
            void send(client, rootTopic, peerId, {
              left: 0,
              numwant: requestedPeers,
              offers: []
            })
            return
          }

          let outstandingOffers: Map<string, OfferRecord & {createdAt: number}>

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

          if (states[rootTopic]?.token !== subscriptionToken) {
            return
          }

          const offers = [...outstandingOffers.entries()].map(
            ([id, {offer}]) => ({
              offer_id: id,
              offer: {type: 'offer', sdp: offer}
            })
          )

          void send(client, rootTopic, peerId, {
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
                void send(client, rootTopic, peerId, {
                  answer: {
                    type: 'answer',
                    sdp: fromJson<{answer: string}>(signal).answer
                  },
                  offer_id: data.offer_id,
                  to_peer_id: data.peer_id
                })
            )
          } else if (data.answer && data.offer_id && data.peer_id) {
            const offer = takeOutstandingOffer(
              rootTopic,
              data.offer_id,
              'claim'
            )

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
        peerId,
        token: subscriptionToken
      }

      states[rootTopic] = topicState

      if (isPassive) {
        const schedulePassiveAnnounce = (): void => {
          clearTimeout(passiveAnnounceTimeout)

          if (states[rootTopic]?.token !== subscriptionToken) {
            return
          }

          void topicState.announce()
          passiveAnnounceTimeout = setTimeout(
            schedulePassiveAnnounce,
            Math.max(topicState.announceMs, dormantAnnounceMs)
          )
          unrefTimer(passiveAnnounceTimeout)
        }

        schedulePassiveAnnounce()
      }

      return () => {
        clearTimeout(passiveAnnounceTimeout)
        const nextCount = Math.max(
          0,
          (roomSubscriberCounts.get(rootTopic) ?? 1) - 1
        )
        if (nextCount > 0) {
          roomSubscriberCounts.set(rootTopic, nextCount)
        } else {
          roomSubscriberCounts.delete(rootTopic)
          reclaimAllOutstandingOffers(rootTopic)
          const hash = topicToInfoHash.get(rootTopic)
          if (hash !== undefined) {
            topicToInfoHash.delete(rootTopic)
            infoHashToTopic.delete(hash)
          }
        }

        if (states[rootTopic]?.token === subscriptionToken) {
          delete states[rootTopic]
        }
      }
    },

    announce: async (client, rootTopic) => {
      const state = topicStates.forRelay(client)[rootTopic]

      await state?.announce()

      return state?.announceMs ?? defaultAnnounceMs
    }
  })

export const getRelaySockets = (): Record<string, WebSocket> =>
  relayManager.getSockets()

export {
  clearUserIdentity,
  createUserIdentity,
  exportUserIdentity,
  importUserIdentity,
  roles,
  scale,
  setRelayConnectivity
}
export type * from '@trystero-p2p/core/types'

export const defaultRelayUrls: string[] = [
  'wss://open.ftorrent.com',
  'wss://tracker.webtorrent.dev',
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.btorrent.xyz',
  'wss://tracker.files.fm:7073/announce'
]
