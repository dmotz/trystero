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
  mkErr,
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

type Timeout = ReturnType<typeof setTimeout>

const unreachable = (x: never): never => {
  throw mkErr(`unreachable: ${String(x)}`)
}

type StoredOffer = OfferRecord & {readonly createdAt: number}

type OfferPoolState =
  | {
      readonly phase: 'idle'
      readonly offers: Map<string, StoredOffer>
    }
  | {
      readonly phase: 'generating'
      readonly offers: Map<string, StoredOffer>
      readonly promise: Promise<void>
      readonly generation: number
    }
  | {
      readonly phase: 'closed'
    }

type PeerOfferSession = {
  subscriberCount: number
  nextGeneration: number
  pool: OfferPoolState
}

type TorrentTopicSession = {
  readonly rootTopic: string
  closed: boolean
  infoHash: string | null
  infoHashP: Promise<string | null> | null
  readonly peers: Map<string, PeerOfferSession>
}

type RelayTopicState = {
  readonly announce: () => Promise<void>
  announceMs: number
  readonly handler: (data: TrackerMessage) => void
  readonly peerId: string
  passiveTimer: Timeout | null
  readonly token: symbol
}

const relayManager = /*@__PURE__*/ createRelayManager<SocketClient>(
  client => client.socket,
  client => client.close?.()
)
const topicSessions = /*@__PURE__*/ new Map<string, TorrentTopicSession>()
const infoHashToTopic = /*@__PURE__*/ new Map<string, string>()
const handledSignals = /*@__PURE__*/ new Map<string, number>()
const topicStates =
  /*@__PURE__*/ createRelayScopedStore<Map<string, RelayTopicState>>()

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
  to_peer_id?: string
  info_hash?: string
  interval?: number
  ['failure reason']?: string
  ['warning message']?: string
}

const resolveSessionInfoHash = (
  topicSession: TorrentTopicSession
): Promise<string | null> => {
  if (topicSession.closed) {
    return Promise.resolve(null)
  }
  if (topicSession.infoHash !== null) {
    return Promise.resolve(topicSession.infoHash)
  }
  return (topicSession.infoHashP ??= hashTopic(topicSession.rootTopic).then(
    fullHash => {
      if (topicSession.closed) {
        return null
      }
      const hash = fullHash.slice(0, hashLimit)
      topicSession.infoHash = hash
      infoHashToTopic.set(hash, topicSession.rootTopic)
      return hash
    },
    err => {
      topicSession.infoHashP = null
      throw err
    }
  ))
}

const acquirePeerSession = (
  rootTopic: string,
  peerId: string
): {topicSession: TorrentTopicSession; peerSession: PeerOfferSession} => {
  let topicSession = topicSessions.get(rootTopic)
  if (!topicSession || topicSession.closed) {
    topicSession = {
      rootTopic,
      closed: false,
      infoHash: null,
      infoHashP: null,
      peers: new Map()
    }
    topicSessions.set(rootTopic, topicSession)
    void resolveSessionInfoHash(topicSession).catch(() => {})
  }

  let peerSession = topicSession.peers.get(peerId)
  if (!peerSession) {
    peerSession = {
      subscriberCount: 0,
      nextGeneration: 0,
      pool: {phase: 'idle', offers: new Map()}
    }
    topicSession.peers.set(peerId, peerSession)
  }
  peerSession.subscriberCount += 1

  return {topicSession, peerSession}
}

const disposeOfferPool = (peerSession: PeerOfferSession): void => {
  switch (peerSession.pool.phase) {
    case 'idle':
    case 'generating': {
      const existingOffers = [...peerSession.pool.offers.values()]
      peerSession.pool.offers.clear()
      peerSession.pool = {phase: 'closed'}
      existingOffers.forEach(offer => {
        offer.reclaim?.()
      })
      return
    }
    case 'closed':
      return
    default:
      unreachable(peerSession.pool)
  }
}

const releasePeerSession = (
  topicSession: TorrentTopicSession,
  peerId: string,
  peerSession: PeerOfferSession
): void => {
  peerSession.subscriberCount = Math.max(0, peerSession.subscriberCount - 1)
  if (peerSession.subscriberCount === 0) {
    disposeOfferPool(peerSession)
    if (topicSession.peers.get(peerId) === peerSession) {
      topicSession.peers.delete(peerId)
    }
  }

  if (topicSession.peers.size === 0 && !topicSession.closed) {
    topicSession.closed = true
    if (topicSession.infoHash !== null) {
      infoHashToTopic.delete(topicSession.infoHash)
    }
    if (topicSessions.get(topicSession.rootTopic) === topicSession) {
      topicSessions.delete(topicSession.rootTopic)
    }
  }
}

const send = (
  client: SocketClient,
  topicSession: TorrentTopicSession,
  peerId: string,
  payload: Record<string, unknown>
): Promise<void> => {
  const transmit = (infoHash: string | null): void => {
    if (infoHash === null || client.isClosed) {
      return
    }
    client.send(
      toJson({
        action: trackerAction,
        info_hash: infoHash,
        peer_id: peerId,
        ...payload
      })
    )
  }
  if (topicSession.infoHash !== null && !topicSession.closed) {
    transmit(topicSession.infoHash)
    return Promise.resolve()
  }
  return resolveSessionInfoHash(topicSession).then(transmit)
}

const warn = (url: string, msg: string, didFail = false): void =>
  console.warn(
    `${libName}: torrent tracker ${didFail ? 'failure' : 'warning'} from ${url} - ${msg}`
  )

const takeOutstandingOffer = (
  peerSession: PeerOfferSession,
  offerId: string,
  action: 'claim' | 'reclaim'
): StoredOffer | undefined => {
  if (peerSession.pool.phase === 'closed') {
    return undefined
  }

  const offer = peerSession.pool.offers.get(offerId)
  if (!offer) {
    return undefined
  }

  peerSession.pool.offers.delete(offerId)
  offer[action]?.()
  return offer
}

const pruneOutstandingOffers = (peerSession: PeerOfferSession): void => {
  if (peerSession.pool.phase === 'closed') {
    return
  }

  const now = Date.now()
  for (const [offerId, offer] of peerSession.pool.offers) {
    if (now - offer.createdAt > offerRetentionMs) {
      takeOutstandingOffer(peerSession, offerId, 'reclaim')
    }
  }
}

const ensureOutstandingOffers = async (
  peerSession: PeerOfferSession,
  getOffers: (n: number) => Promise<OfferRecord[]>
): Promise<Map<string, StoredOffer> | null> => {
  while (peerSession.pool.phase === 'generating') {
    await peerSession.pool.promise
  }

  if (peerSession.pool.phase === 'closed') {
    return null
  }

  pruneOutstandingOffers(peerSession)

  if (peerSession.pool.phase !== 'idle') {
    return null
  }

  const {offers} = peerSession.pool
  const missingOffers = Math.max(0, offersPerAnnounce - offers.size)

  if (missingOffers === 0) {
    return offers
  }

  const generation = ++peerSession.nextGeneration
  const {promise, resolve} = Promise.withResolvers<void>()
  peerSession.pool = {
    phase: 'generating',
    offers,
    promise,
    generation
  }

  try {
    const allocated = await getOffers(missingOffers)

    if (
      peerSession.pool.phase !== 'generating' ||
      peerSession.pool.generation !== generation
    ) {
      allocated.forEach(offer => {
        offer.reclaim?.()
      })
      return null
    }

    const createdAt = Date.now()
    allocated.forEach(peerAndOffer => {
      offers.set(peerAndOffer.offerId, {
        ...peerAndOffer,
        createdAt
      })
    })
    peerSession.pool = {phase: 'idle', offers}
    return offers
  } catch (err) {
    if (
      peerSession.pool.phase === 'generating' &&
      peerSession.pool.generation === generation
    ) {
      peerSession.pool = {phase: 'idle', offers}
    }
    throw err
  } finally {
    resolve()
  }
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

              const peerMap = topic
                ? topicStates.forRelay(created)[topic]
                : undefined

              if (!peerMap || !topic) {
                return
              }

              if (interval) {
                const clampedMs = Math.min(
                  Math.max(interval * 1000, defaultAnnounceMs),
                  offerRetentionMs
                )
                peerMap.forEach(state => {
                  state.announceMs = clampedMs
                })
              }

              if ((data.offer || data.answer) && data.offer_id) {
                const signalType = data.offer ? 'offer' : 'answer'
                const nowMs = Date.now()

                for (const [key, handledAtMs] of handledSignals) {
                  if (nowMs - handledAtMs > signalDedupeWindowMs * 6) {
                    handledSignals.delete(key)
                  }
                }

                for (const state of peerMap.values()) {
                  if (state.peerId && data.peer_id === state.peerId) {
                    continue
                  }
                  if (
                    data.to_peer_id &&
                    state.peerId &&
                    data.to_peer_id !== state.peerId
                  ) {
                    continue
                  }

                  const signalKey = `${topic}:${state.peerId}:${signalType}:${data.offer_id}:${data.peer_id ?? ''}`
                  const lastHandledMs = handledSignals.get(signalKey)

                  if (
                    typeof lastHandledMs === 'number' &&
                    nowMs - lastHandledMs < signalDedupeWindowMs
                  ) {
                    continue
                  }

                  handledSignals.set(signalKey, nowMs)
                  state.handler(data)
                }
              }
            },
            () =>
              Object.values(topicStates.forRelay(created)).forEach(peerMap =>
                peerMap.forEach(state => void state.announce())
              )
          )
          return created
        })

        return relayManager.lease(client, client.ready)
      }),

    subscribe: (client, rootTopic, _, onMessage, getOffers, context) => {
      const relayTopics = topicStates.forRelay(client)
      const subscriptionToken = Symbol(rootTopic)
      const isPassive = Boolean(context?.config.passive)
      const peerId = context?.peerId ?? ''
      const {topicSession, peerSession} = acquirePeerSession(rootTopic, peerId)
      const peerMap = (relayTopics[rootTopic] ??= new Map())

      const prevState = peerMap.get(peerId)
      if (prevState && prevState.passiveTimer !== null) {
        clearTimeout(prevState.passiveTimer)
        prevState.passiveTimer = null
      }

      const topicState: RelayTopicState = {
        announce: async () => {
          if (peerMap.get(peerId)?.token !== subscriptionToken) {
            return
          }

          if (isPassive) {
            await send(client, topicSession, peerId, {
              left: 0,
              numwant: requestedPeers,
              offers: []
            })
            return
          }

          let outstandingOffers: Map<string, StoredOffer> | null
          try {
            outstandingOffers = await ensureOutstandingOffers(
              peerSession,
              getOffers
            )
          } catch (error) {
            if (peerMap.get(peerId)?.token !== subscriptionToken) {
              return
            }
            throw error
          }

          if (
            !outstandingOffers ||
            peerMap.get(peerId)?.token !== subscriptionToken
          ) {
            return
          }

          const offers = [...outstandingOffers.entries()].map(
            ([id, {offer}]) => ({
              offer_id: id,
              offer: {type: 'offer', sdp: offer}
            })
          )

          await send(client, topicSession, peerId, {
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
                void send(client, topicSession, peerId, {
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
              peerSession,
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
        passiveTimer: null,
        token: subscriptionToken
      }

      peerMap.set(peerId, topicState)

      if (isPassive) {
        const schedulePassiveAnnounce = (): void => {
          if (peerMap.get(peerId)?.token !== subscriptionToken) {
            return
          }
          void topicState.announce()
          if (peerMap.get(peerId)?.token !== subscriptionToken) {
            return
          }
          if (topicState.passiveTimer !== null) {
            clearTimeout(topicState.passiveTimer)
          }
          topicState.passiveTimer = setTimeout(
            schedulePassiveAnnounce,
            Math.max(topicState.announceMs, dormantAnnounceMs)
          )
          unrefTimer(topicState.passiveTimer)
        }

        schedulePassiveAnnounce()
      }

      let closed = false
      return () => {
        if (closed) {
          return
        }
        closed = true
        if (topicState.passiveTimer !== null) {
          clearTimeout(topicState.passiveTimer)
          topicState.passiveTimer = null
        }

        if (peerMap.get(peerId)?.token === subscriptionToken) {
          peerMap.delete(peerId)
          if (peerMap.size === 0 && relayTopics[rootTopic] === peerMap) {
            delete relayTopics[rootTopic]
          }
        }

        releasePeerSession(topicSession, peerId, peerSession)
      }
    },

    announce: async (client, rootTopic, _selfTopic, context) => {
      const state = topicStates
        .forRelay(client)
        [rootTopic]?.get(context?.peerId ?? '')

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
