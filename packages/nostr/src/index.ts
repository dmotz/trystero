import {
  clearUserIdentity,
  createRelayManager,
  createRelayScopedStore,
  createTopicStrategy,
  createUserIdentity,
  exportUserIdentity,
  fromJson,
  genId,
  getRelays,
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
  type SocketClient
} from '@trystero-p2p/core'
import {
  createEvent,
  createSigner,
  eventMsgType,
  subscribeSince,
  tag,
  topicToKind,
  type NostrSigner
} from './protocol'

const relayManager = /*@__PURE__*/ createRelayManager<SocketClient>(
  client => client.socket,
  client => {
    cleanupClientBatcher(client)
    client.close?.()
  }
)
const defaultRedundancy = 5
const maxTopicsPerSubscription = 250

// Newcomers announce immediately and wake subscribed incumbents, so the fast
// cadence is only needed during startup. Reconnects restore discovery directly;
// keep a low-rate heartbeat as a fallback for missed discovery.
const steadyAnnounceIntervalMs = 60_000
const maxRelayBackoffMs = 15 * 60_000
const subscriptionRetryMs = 5_333

type RelayBackoffState = {
  delayMs: number
  untilMs: number
}

type RoomSignerState = {
  signer?: NostrSigner
  refs: number
}

type AnnouncementRecord = {
  payload: string
  getSigner: () => NostrSigner
}

const roomSigners = new Map<string, RoomSignerState>()
const relayBackoffs = /*@__PURE__*/ new WeakMap<
  SocketClient,
  RelayBackoffState
>()
const announcementMessages =
  /*@__PURE__*/ createRelayScopedStore<AnnouncementRecord>()
const retiredRelays = /*@__PURE__*/ new WeakSet<SocketClient>()

const getRoomKey = (rootTopic: string, selfTopic: string): string =>
  `${rootTopic}\0${selfTopic}`

const getRoomSigner = (key: string): NostrSigner => {
  const state = roomSigners.get(key)

  if (!state) {
    return createSigner()
  }

  return (state.signer ??= createSigner())
}

const backoffRelay = (client: SocketClient): number => {
  const previous = relayBackoffs.get(client)
  const delayMs = Math.min(
    previous?.delayMs
      ? Math.max(steadyAnnounceIntervalMs, previous.delayMs * 2)
      : steadyAnnounceIntervalMs,
    maxRelayBackoffMs
  )

  relayBackoffs.set(client, {delayMs, untilMs: Date.now() + delayMs})

  return delayMs
}

const getRelayBackoffMs = (client: SocketClient): number => {
  const state = relayBackoffs.get(client)

  if (!state) {
    return 0
  }

  const remainingMs = state.untilMs - Date.now()

  if (remainingMs > 0) {
    return remainingMs
  }

  return 0
}

const nextAnnounce = (nextAnnounceMs: number) => ({nextAnnounceMs})
const stopAnnouncing = {stopAnnouncing: true} as const

const retireRelay = (client: SocketClient): boolean => {
  if (retiredRelays.has(client)) {
    return false
  }

  retiredRelays.add(client)
  relayBackoffs.delete(client)
  relayManager.evict(client)
  cleanupClientBatcher(client)
  client.close?.()
  return true
}

export type NostrRoomConfig = JoinRoomConfig

type TopicHandler = (topic: string, data: string) => void

type BatchState = {
  subIds: string[]
  topics: Map<string, TopicHandler>
  updateTimer: ReturnType<typeof setTimeout> | null
  flushWaiters: Set<() => void>
  retryTimer: ReturnType<typeof setTimeout> | null
  retryMs: number
  pendingEose: Set<string>
  requestedAt: number
}

const batchers = /*@__PURE__*/ new WeakMap<SocketClient, BatchState>()

const resolveBatchFlush = (batcher: BatchState): void => {
  batcher.flushWaiters.forEach(resolve => resolve())
  batcher.flushWaiters.clear()
}

const cleanupClientBatcher = (client: SocketClient): void => {
  const batcher = batchers.get(client)
  if (!batcher) {
    return
  }
  if (batcher.retryTimer !== null) {
    clearTimeout(batcher.retryTimer)
    batcher.retryTimer = null
  }
  if (batcher.updateTimer !== null) {
    clearTimeout(batcher.updateTimer)
    batcher.updateTimer = null
  }
  resolveBatchFlush(batcher)
  batchers.delete(client)
}

const batchAdd = (
  client: SocketClient,
  topic: string,
  handler: TopicHandler
): void => {
  let batcher = batchers.get(client)
  if (!batcher) {
    batcher = {
      subIds: [],
      topics: new Map(),
      updateTimer: null,
      flushWaiters: new Set(),
      retryTimer: null,
      retryMs: subscriptionRetryMs,
      pendingEose: new Set(),
      requestedAt: 0
    }
    batchers.set(client, batcher)
  }

  batcher.topics.set(topic, handler)
  scheduleBatchFlush(client, batcher)
}

const batchRemove = (client: SocketClient, topic: string): void => {
  const batcher = batchers.get(client)

  if (!batcher) {
    return
  }

  batcher.topics.delete(topic)
  delete announcementMessages.forRelay(client)[topic]

  if (batcher.topics.size === 0) {
    batcher.subIds.forEach(subId => client.send(toJson(['CLOSE', subId])))
    cleanupClientBatcher(client)
  } else {
    scheduleBatchFlush(client, batcher)
  }
}

const scheduleBatchFlush = (
  client: SocketClient,
  batcher: BatchState
): void => {
  if (batcher.updateTimer !== null) {
    return
  }

  batcher.updateTimer = setTimeout(() => {
    batcher.updateTimer = null

    try {
      flushBatch(client)
    } finally {
      resolveBatchFlush(batcher)
    }
  }, 0)
}

const waitForBatchFlush = (client: SocketClient): Promise<void> => {
  const batcher = batchers.get(client)

  if (!batcher || batcher.updateTimer === null) {
    return Promise.resolve()
  }

  return new Promise(resolve => batcher.flushWaiters.add(resolve))
}

const flushBatch = (client: SocketClient): void => {
  const batcher = batchers.get(client)

  if (!batcher || batcher.topics.size === 0) {
    return
  }

  const topics = [...batcher.topics.keys()]
  const chunks: string[][] = []
  const since = subscribeSince()

  for (let i = 0; i < topics.length; i += maxTopicsPerSubscription) {
    chunks.push(topics.slice(i, i + maxTopicsPerSubscription))
  }

  while (batcher.subIds.length > chunks.length) {
    const subId = batcher.subIds.pop()

    if (subId) {
      client.send(toJson(['CLOSE', subId]))
    }
  }

  batcher.pendingEose.clear()
  batcher.requestedAt = Date.now()
  chunks.forEach((chunk, i) => {
    const subId = (batcher.subIds[i] ??= genId(64))
    batcher.pendingEose.add(subId)

    client.send(
      toJson([
        'REQ',
        subId,
        {
          kinds: [...new Set(chunk.map(topicToKind))],
          since,
          ['#' + tag]: chunk
        }
      ])
    )
  })
}

const resubscribeOnReconnect = (client: SocketClient): void => {
  const batcher = batchers.get(client)

  if (batcher && batcher.topics.size > 0 && !client.isClosed) {
    if (getRelayBackoffMs(client) > 0) {
      retrySubscription(client, true)
      return
    }
    if (batcher.retryTimer !== null) {
      clearTimeout(batcher.retryTimer)
      batcher.retryTimer = null
    }
    flushBatch(client)
    replayAnnouncements(client)
  }
}

const replayAnnouncements = (client: SocketClient): void => {
  Object.entries(announcementMessages.forRelay(client)).forEach(
    ([topic, {payload, getSigner}]) => {
      void publishMessage(client, topic, payload, true, getSigner)
    }
  )
}

const publishMessage = async (
  client: SocketClient,
  topic: string,
  payload: string,
  isAnnouncement: boolean,
  getSigner: () => NostrSigner
) => {
  if (retiredRelays.has(client) || client.isClosed) {
    return isAnnouncement ? stopAnnouncing : undefined
  }
  const remaining = getRelayBackoffMs(client)
  if (remaining > 0 || client.socket?.readyState !== 1) {
    return isAnnouncement
      ? nextAnnounce(Math.max(steadyAnnounceIntervalMs, remaining))
      : undefined
  }
  // Relays deduplicate IDs, and created_at only has second precision. An
  // intentional discovery retry must remain distinct from the previous send.
  const event = await createEvent(
    topic,
    isAnnouncement
      ? toJson({...fromJson<Record<string, unknown>>(payload), nonce: genId(8)})
      : payload,
    getSigner()
  )
  if (isAnnouncement && !batchers.get(client)?.topics.has(topic)) {
    return nextAnnounce(steadyAnnounceIntervalMs)
  }
  // Feedback or disconnection can arrive while another event is being signed.
  if (
    getRelayBackoffMs(client) > 0 ||
    client.isClosed ||
    client.socket?.readyState !== 1
  ) {
    return isAnnouncement ? nextAnnounce(steadyAnnounceIntervalMs) : undefined
  }
  client.send(event)
  if (isAnnouncement) {
    return nextAnnounce(steadyAnnounceIntervalMs)
  }
  return undefined
}

const retrySubscription = (
  client: SocketClient,
  rateLimited: boolean
): void => {
  const batcher = batchers.get(client)
  if (!batcher || (batcher.retryTimer !== null && !rateLimited)) {
    return
  }
  if (batcher.retryTimer !== null) {
    clearTimeout(batcher.retryTimer)
  }
  const delay = rateLimited ? getRelayBackoffMs(client) : batcher.retryMs
  batcher.retryMs = Math.min(batcher.retryMs * 2, steadyAnnounceIntervalMs)
  batcher.retryTimer = setTimeout(
    () => {
      batcher.retryTimer = null
      resubscribeOnReconnect(client)
    },
    Math.max(delay, subscriptionRetryMs)
  )
  unrefTimer(batcher.retryTimer)
}

export const joinRoom: JoinRoom<NostrRoomConfig> =
  /*@__PURE__*/ createTopicStrategy<SocketClient, NostrRoomConfig>({
    init: config =>
      getRelays(config, defaultRelayUrls, defaultRedundancy, true).map(url => {
        const client = relayManager.register(url, () => {
          const created = makeSocket(
            url,
            data => {
              const parsed = fromJson<unknown>(data)
              if (!Array.isArray(parsed)) {
                return
              }
              const [msgType, subId, payload, relayMsg] = parsed as [
                string,
                string,
                {content: string; tags?: string[][]} | boolean | string,
                string
              ]

              if (msgType !== eventMsgType) {
                const prefix = `${libName}: relay failure from ${created.url} - `
                const rejectionReason =
                  msgType === 'CLOSED' && typeof payload === 'string'
                    ? payload
                    : relayMsg
                const didRejectEvent = msgType === 'OK' && payload === false
                const isRateLimited =
                  (didRejectEvent || msgType === 'CLOSED') &&
                  rejectionReason?.startsWith('rate-limited:')
                const isDuplicate =
                  didRejectEvent && rejectionReason?.startsWith('duplicate:')
                const isTerminalRejection =
                  rejectionReason &&
                  /^(blocked|restricted|auth-required|pow):/.test(
                    rejectionReason
                  )

                if (
                  msgType === 'OK' &&
                  payload === true &&
                  getRelayBackoffMs(created) === 0
                ) {
                  relayBackoffs.delete(created)
                }

                if (
                  (didRejectEvent || msgType === 'CLOSED') &&
                  isTerminalRejection &&
                  !retireRelay(created)
                ) {
                  return
                }

                if (isRateLimited) {
                  backoffRelay(created)
                } else if (msgType === 'EOSE') {
                  const batcher = batchers.get(created)
                  if (
                    batcher?.pendingEose.delete(subId) &&
                    batcher.pendingEose.size === 0
                  ) {
                    batcher.retryMs = subscriptionRetryMs
                    if (batcher.retryTimer !== null) {
                      clearTimeout(batcher.retryTimer)
                      batcher.retryTimer = null
                    }
                    // Do not wait for EOSE on the fast path. If installation was
                    // slow, announce once when all batched subscriptions are ready.
                    if (Date.now() - batcher.requestedAt >= 1_000) {
                      replayAnnouncements(created)
                    }
                  }
                }
                if (msgType === 'CLOSED' && !isTerminalRejection) {
                  retrySubscription(created, Boolean(isRateLimited))
                }

                if (
                  !isDuplicate &&
                  config.relayConfig?.warnOnRelayFailure !== false
                ) {
                  if (msgType === 'NOTICE') {
                    console.warn(prefix + subId)
                  } else if (didRejectEvent || msgType === 'CLOSED') {
                    console.warn(prefix + rejectionReason)
                  }
                }

                return
              }

              if (
                payload &&
                typeof payload === 'object' &&
                'content' in payload
              ) {
                const batcher = batchers.get(created)

                if (batcher?.subIds.includes(subId) && payload.tags) {
                  const topicTag = payload.tags.find(
                    t => Array.isArray(t) && t[0] === tag
                  )

                  if (topicTag?.[1]) {
                    batcher.topics.get(topicTag[1])?.(
                      topicTag[1],
                      payload.content
                    )
                  }
                }
              }
            },
            () => resubscribeOnReconnect(created)
          )
          return created
        })

        return relayManager.lease(client, client.ready)
      }),

    subscribeTopic: (client, topic, onMessage, context) => {
      const key = getRoomKey(context.rootTopic, context.selfTopic)
      let signerState = roomSigners.get(key)
      if (!signerState) {
        signerState = {refs: 0}
        roomSigners.set(key, signerState)
      }
      signerState.refs += 1
      let didReleaseSigner = false
      const handler: TopicHandler = (topic, data) => void onMessage(topic, data)

      batchAdd(client, topic, handler)

      const cleanup = () => {
        if (!didReleaseSigner) {
          didReleaseSigner = true
          const state = roomSigners.get(key)

          if (state) {
            state.refs -= 1

            if (state.refs <= 0) {
              roomSigners.delete(key)
            }
          }
        }

        if (batchers.get(client)?.topics.get(topic) === handler) {
          batchRemove(client, topic)
        }
      }

      // Rooms add the self topic before the root topic. Waiting only on
      // the root keeps both topics in one batch while guaranteeing the REQ is
      // written before createStrategy starts announcing.
      return context.kind === 'root'
        ? waitForBatchFlush(client).then(() => cleanup)
        : cleanup
    },

    publishTopic: (client, topic, msg, {kind, rootTopic, selfTopic}) => {
      const payload = typeof msg === 'string' ? msg : toJson(msg)
      const key = getRoomKey(rootTopic, selfTopic)
      const getSigner = () => getRoomSigner(key)

      if (kind === 'announce') {
        announcementMessages.forRelay(client)[topic] = {payload, getSigner}
      }

      return publishMessage(
        client,
        topic,
        payload,
        kind === 'announce',
        getSigner
      )
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
  'wss://bucket.coracle.social',
  'wss://fanfares.nostr1.com',
  'wss://no.str.cr',
  'wss://nostr-01.yakihonne.com',
  'wss://nostr-pub.wellorder.net',
  'wss://nostr.azzamo.net',
  'wss://nostr.chaima.info',
  'wss://nostr.data.haus',
  'wss://nostr.hifish.org',
  'wss://nostr.liberty.fans',
  'wss://nostr.overmind.lol',
  'wss://nostr.sathoarder.com',
  'wss://nostrelay.circum.space',
  'wss://relay.angor.io',
  'wss://relay.ditto.pub',
  'wss://relay.dwadziesciajeden.pl',
  'wss://relay.fundstr.me',
  'wss://relay.guggero.org',
  'wss://relay.masize.com',
  'wss://relay.minibolt.info',
  'wss://relay.mostro.network',
  'wss://relay.nostr.com',
  'wss://relay.nostr.net',
  'wss://relay.nostrhub.fr',
  'wss://relay.notoshi.win',
  'wss://relay.primal.net',
  'wss://relay.snort.social',
  'wss://relay.wavlake.com',
  'wss://soloco.nl',
  'wss://yabu.me'
]
