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
  mkErr,
  roles,
  scale,
  setRelayConnectivity,
  toJson,
  unrefTimer,
  type JoinRoom,
  type JoinRoomConfig,
  type SocketClient,
  type Timeout
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

type RelayHealthState =
  | {readonly phase: 'healthy'}
  | {
      readonly phase: 'cooldown'
      readonly delayMs: number
      readonly untilMs: number
    }
  | {readonly phase: 'probation'; readonly lastDelayMs: number}
  | {readonly phase: 'retired'}

type RoomSignerEntry = {
  refs: number
  signer: NostrSigner | null
}

type AnnouncementRecord = {
  readonly payload: string
  readonly getSigner: () => NostrSigner
}

type TopicHandler = (topic: string, data: string) => void

type BatchSyncState =
  | {readonly phase: 'unsynced'}
  | {
      readonly phase: 'awaiting-eose'
      readonly pendingSubIds: Set<string>
      readonly requestedAt: number
    }
  | {readonly phase: 'synced'}

type BatchState = {
  subIds: string[]
  topics: Map<string, Set<TopicHandler>>
  flushTimer: Timeout | null
  flushWaiters: Set<() => void>
  sync: BatchSyncState
  retryTimer: Timeout | null
  retryMs: number
}

const unreachable = (x: never): never => {
  throw mkErr(`unreachable: ${String(x)}`)
}

const cancelTimer = (timer: Timeout | null): null => {
  if (timer !== null) {
    clearTimeout(timer)
  }
  return null
}

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

const roomSigners = /*@__PURE__*/ new Map<string, RoomSignerEntry>()
const relayHealth = /*@__PURE__*/ new WeakMap<SocketClient, RelayHealthState>()
const announcementMessages =
  /*@__PURE__*/ createRelayScopedStore<AnnouncementRecord>()
const batchers = /*@__PURE__*/ new WeakMap<SocketClient, BatchState>()

const getRoomKey = (rootTopic: string, selfTopic: string): string =>
  `${rootTopic}\0${selfTopic}`

const getRoomSigner = (key: string): NostrSigner => {
  const entry = roomSigners.get(key)
  if (!entry) {
    return createSigner()
  }
  return (entry.signer ??= createSigner())
}

const getRelayHealth = (client: SocketClient): RelayHealthState => {
  const state = relayHealth.get(client)
  if (!state) {
    return {phase: 'healthy'}
  }
  if (state.phase === 'cooldown' && Date.now() >= state.untilMs) {
    const next: RelayHealthState = {
      phase: 'probation',
      lastDelayMs: state.delayMs
    }
    relayHealth.set(client, next)
    return next
  }
  return state
}

const backoffRelay = (client: SocketClient): number => {
  const current = getRelayHealth(client)
  switch (current.phase) {
    case 'retired':
      return maxRelayBackoffMs
    case 'healthy': {
      const delayMs = steadyAnnounceIntervalMs
      relayHealth.set(client, {
        phase: 'cooldown',
        delayMs,
        untilMs: Date.now() + delayMs
      })
      return delayMs
    }
    case 'cooldown':
    case 'probation': {
      const prevDelay =
        current.phase === 'cooldown' ? current.delayMs : current.lastDelayMs
      const delayMs = Math.min(
        Math.max(steadyAnnounceIntervalMs, prevDelay * 2),
        maxRelayBackoffMs
      )
      relayHealth.set(client, {
        phase: 'cooldown',
        delayMs,
        untilMs: Date.now() + delayMs
      })
      return delayMs
    }
    default:
      return unreachable(current)
  }
}

const acknowledgeRelaySuccess = (client: SocketClient): void => {
  if (getRelayHealth(client).phase === 'probation') {
    relayHealth.set(client, {phase: 'healthy'})
  }
}

const getRelayCooldownMs = (client: SocketClient): number => {
  const current = getRelayHealth(client)
  return current.phase === 'cooldown'
    ? Math.max(0, current.untilMs - Date.now())
    : 0
}

const nextAnnounce = (nextAnnounceMs: number) => ({nextAnnounceMs})
const stopAnnouncing = {stopAnnouncing: true} as const

const retireRelay = (client: SocketClient): boolean => {
  if (getRelayHealth(client).phase === 'retired') {
    return false
  }

  relayHealth.set(client, {phase: 'retired'})
  relayManager.evict(client)
  cleanupClientBatcher(client)
  client.close?.()
  return true
}

export type NostrRoomConfig = JoinRoomConfig

const resolveBatchFlush = (batcher: BatchState): void => {
  batcher.flushWaiters.forEach(resolve => resolve())
  batcher.flushWaiters.clear()
}

const cleanupClientBatcher = (client: SocketClient): void => {
  const batcher = batchers.get(client)
  if (!batcher) {
    return
  }
  batcher.flushTimer = cancelTimer(batcher.flushTimer)
  batcher.retryTimer = cancelTimer(batcher.retryTimer)
  batcher.sync = {phase: 'unsynced'}
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
      flushTimer: null,
      flushWaiters: new Set(),
      sync: {phase: 'unsynced'},
      retryTimer: null,
      retryMs: subscriptionRetryMs
    }
    batchers.set(client, batcher)
  }

  let handlers = batcher.topics.get(topic)
  const isNewTopic = !handlers
  if (!handlers) {
    handlers = new Set()
    batcher.topics.set(topic, handlers)
  }
  handlers.add(handler)

  if (isNewTopic || batcher.sync.phase === 'unsynced') {
    scheduleBatchFlush(client, batcher)
  }
}

const batchRemove = (
  client: SocketClient,
  topic: string,
  handler: TopicHandler
): boolean => {
  const batcher = batchers.get(client)
  if (!batcher) {
    return false
  }

  const handlers = batcher.topics.get(topic)
  if (!handlers || !handlers.delete(handler)) {
    return false
  }

  if (handlers.size > 0) {
    return true
  }

  batcher.topics.delete(topic)
  delete announcementMessages.forRelay(client)[topic]

  if (batcher.topics.size === 0) {
    batcher.subIds.forEach(subId => client.send(toJson(['CLOSE', subId])))
    cleanupClientBatcher(client)
    return true
  }

  scheduleBatchFlush(client, batcher)
  return true
}

const scheduleBatchFlush = (
  client: SocketClient,
  batcher: BatchState
): void => {
  if (batcher.flushTimer !== null) {
    return
  }
  batcher.flushTimer = setTimeout(() => {
    batcher.flushTimer = null
    try {
      flushBatch(client)
    } finally {
      resolveBatchFlush(batcher)
    }
  }, 0)
}

const waitForBatchFlush = (client: SocketClient): Promise<void> => {
  const batcher = batchers.get(client)
  if (!batcher || batcher.flushTimer === null) {
    return Promise.resolve()
  }
  return new Promise(resolve => {
    batcher.flushWaiters.add(resolve)
  })
}

const flushBatch = (client: SocketClient): void => {
  const batcher = batchers.get(client)
  if (!batcher || batcher.topics.size === 0) {
    return
  }

  batcher.flushTimer = cancelTimer(batcher.flushTimer)
  batcher.retryTimer = cancelTimer(batcher.retryTimer)

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

  const pendingSubIds = new Set<string>()
  const requestedAt = Date.now()
  chunks.forEach((chunk, i) => {
    const subId = (batcher.subIds[i] ??= genId(64))
    pendingSubIds.add(subId)

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

  batcher.sync = {
    phase: 'awaiting-eose',
    pendingSubIds,
    requestedAt
  }
  resolveBatchFlush(batcher)
}

const resubscribeOnReconnect = (client: SocketClient): void => {
  const batcher = batchers.get(client)
  if (batcher && batcher.topics.size > 0 && !client.isClosed) {
    if (getRelayCooldownMs(client) > 0) {
      retrySubscription(client, true)
      return
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

const getPublishBlockedResult = (
  client: SocketClient,
  isAnnouncement: boolean
): typeof stopAnnouncing | {nextAnnounceMs: number} | undefined | null => {
  const health = getRelayHealth(client)
  if (health.phase === 'retired' || client.isClosed) {
    return isAnnouncement ? stopAnnouncing : undefined
  }
  const remaining =
    health.phase === 'cooldown' ? Math.max(0, health.untilMs - Date.now()) : 0
  if (remaining > 0 || client.socket?.readyState !== 1) {
    return isAnnouncement
      ? nextAnnounce(Math.max(steadyAnnounceIntervalMs, remaining))
      : undefined
  }
  return null
}

const publishMessage = async (
  client: SocketClient,
  topic: string,
  payload: string,
  isAnnouncement: boolean,
  getSigner: () => NostrSigner
) => {
  const preBlocked = getPublishBlockedResult(client, isAnnouncement)
  if (preBlocked !== null) {
    return preBlocked
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

  // Feedback or disconnection can arrive while another event is being signed.
  const postBlocked = getPublishBlockedResult(client, isAnnouncement)
  if (postBlocked !== null) {
    return postBlocked
  }

  if (isAnnouncement && !batchers.get(client)?.topics.has(topic)) {
    return nextAnnounce(steadyAnnounceIntervalMs)
  }

  client.send(event)
  return isAnnouncement ? nextAnnounce(steadyAnnounceIntervalMs) : undefined
}

const retrySubscription = (
  client: SocketClient,
  rateLimited: boolean
): void => {
  const batcher = batchers.get(client)
  if (!batcher || batcher.topics.size === 0 || client.isClosed) {
    return
  }

  if (batcher.retryTimer !== null && !rateLimited) {
    return
  }

  const delay = rateLimited ? getRelayCooldownMs(client) : batcher.retryMs
  batcher.retryMs = Math.min(batcher.retryMs * 2, steadyAnnounceIntervalMs)
  if (batcher.sync.phase === 'synced') {
    batcher.sync = {phase: 'unsynced'}
  }
  batcher.retryTimer = cancelTimer(batcher.retryTimer)
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
                if (
                  msgType === 'CLOSED' &&
                  !batchers.get(created)?.subIds.includes(subId)
                ) {
                  return
                }

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

                if (msgType === 'OK' && payload === true) {
                  acknowledgeRelaySuccess(created)
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
                    batcher &&
                    batcher.sync.phase === 'awaiting-eose' &&
                    batcher.sync.pendingSubIds.delete(subId) &&
                    batcher.sync.pendingSubIds.size === 0
                  ) {
                    const {requestedAt} = batcher.sync
                    batcher.retryTimer = cancelTimer(batcher.retryTimer)
                    batcher.retryMs = subscriptionRetryMs
                    batcher.sync = {phase: 'synced'}
                    // Do not wait for EOSE on the fast path. If installation was
                    // slow, announce once when all batched subscriptions are ready.
                    if (Date.now() - requestedAt >= 1_000) {
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
                    const matchedTopic = topicTag[1]
                    batcher.topics.get(matchedTopic)?.forEach(handler => {
                      handler(matchedTopic, payload.content)
                    })
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
      const existingSigner = roomSigners.get(key)
      if (existingSigner) {
        existingSigner.refs += 1
      } else {
        roomSigners.set(key, {refs: 1, signer: null})
      }
      let released = false
      const handler: TopicHandler = (receivedTopic, data) =>
        void onMessage(receivedTopic, data)

      batchAdd(client, topic, handler)

      const cleanup = (): void => {
        if (released) {
          return
        }
        released = true

        const entry = roomSigners.get(key)
        if (entry) {
          if (entry.refs <= 1) {
            roomSigners.delete(key)
          } else {
            entry.refs -= 1
          }
        }

        batchRemove(client, topic, handler)
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

      if (kind === 'announce' && batchers.get(client)?.topics.has(topic)) {
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
