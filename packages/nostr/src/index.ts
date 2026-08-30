import {schnorr} from '@noble/secp256k1'
import {
  createRelayManager,
  createTopicStrategy,
  fromJson,
  genId,
  getRelays,
  hashWith,
  libName,
  makeSocket,
  pauseRelayReconnection,
  resumeRelayReconnection,
  selfId,
  strToNum,
  toHex,
  toJson,
  type JoinRoom,
  type JoinRoomConfig,
  type SocketClient
} from '@trystero-p2p/core'

const relayManager = createRelayManager<SocketClient>(client => client.socket)
const defaultRedundancy = 5
const tag = 'x'
const eventMsgType = 'EVENT'
const {secretKey, publicKey} = schnorr.keygen()
const pubkey = toHex(publicKey)
const subIdToTopic: Record<string, string> = {}
const msgHandlers: Record<
  string,
  ((topic: string, data: string) => void) | undefined
> = {}
const kindCache: Record<string, number> = {}
const maxTopicsPerSubscription = 250

// Newcomers announce immediately and wake subscribed incumbents, so the fast
// cadence is only needed during startup. Keep a low-rate heartbeat for relay
// reconnect and missed-subscription recovery.
const steadyAnnounceIntervalMs = 60_000
const maxRelayBackoffMs = 15 * 60_000
const relayAckTimeoutMs = 5_333

type RelayBackoffState = {
  delayMs: number
  untilMs: number
}

const relayBackoffs = new WeakMap<SocketClient, RelayBackoffState>()
const pendingAnnouncementAcks = new WeakMap<
  SocketClient,
  {eventIds: Set<string>; timer: ReturnType<typeof setTimeout>}
>()

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

const trackAnnouncementAck = (client: SocketClient, eventId: string): void => {
  const pending = pendingAnnouncementAcks.get(client)

  if (pending) {
    clearTimeout(pending.timer)
    pending.eventIds.add(eventId)
  }

  const eventIds = pending?.eventIds ?? new Set([eventId])
  const timer = setTimeout(() => {
    pendingAnnouncementAcks.delete(client)
  }, relayAckTimeoutMs)

  pendingAnnouncementAcks.set(client, {eventIds, timer})
}

const acknowledgeEvent = (client: SocketClient, eventId: string): boolean => {
  const pending = pendingAnnouncementAcks.get(client)

  if (!pending?.eventIds.has(eventId)) {
    return false
  }

  clearTimeout(pending.timer)
  pendingAnnouncementAcks.delete(client)
  return true
}

export type NostrRoomConfig = JoinRoomConfig

const now = (): number => Math.floor(Date.now() / 1000)

const topicToKind = (topic: string): number =>
  (kindCache[topic] ??= strToNum(topic, 10_000) + 20_000)

export const createEvent = async (
  topic: string,
  content: string
): Promise<string> => {
  const payload = {
    kind: topicToKind(topic),
    tags: [[tag, topic]],
    created_at: now(),
    content,
    pubkey
  }

  const id = await hashWith(
    'SHA-256',
    toJson([
      0,
      payload.pubkey,
      payload.created_at,
      payload.kind,
      payload.tags,
      payload.content
    ])
  )

  return toJson([
    eventMsgType,
    {
      ...payload,
      id: toHex(id),
      sig: toHex(await schnorr.signAsync(id, secretKey))
    }
  ])
}

export const subscribe = (subId: string, topic: string): string => {
  subIdToTopic[subId] = topic

  return toJson([
    'REQ',
    subId,
    {
      kinds: [topicToKind(topic)],
      since: now(),
      ['#' + tag]: [topic]
    }
  ])
}

type TopicHandler = (topic: string, data: string) => void

type BatchState = {
  subIds: string[]
  topics: Map<string, TopicHandler>
  updateTimer: ReturnType<typeof setTimeout> | null
  flushWaiters: Set<() => void>
}

const batchers: Record<string, BatchState> = {}

const resolveBatchFlush = (batcher: BatchState): void => {
  batcher.flushWaiters.forEach(resolve => resolve())
  batcher.flushWaiters.clear()
}

const batchAdd = (
  client: SocketClient,
  topic: string,
  handler: TopicHandler
): void => {
  const batcher = (batchers[client.url] ??= {
    subIds: [],
    topics: new Map(),
    updateTimer: null,
    flushWaiters: new Set()
  })

  batcher.topics.set(topic, handler)
  scheduleBatchFlush(client, batcher)
}

const batchRemove = (client: SocketClient, topic: string): void => {
  const batcher = batchers[client.url]

  if (!batcher) {
    return
  }

  batcher.topics.delete(topic)

  if (batcher.topics.size === 0) {
    if (batcher.updateTimer !== null) {
      clearTimeout(batcher.updateTimer)
      batcher.updateTimer = null
    }

    resolveBatchFlush(batcher)

    batcher.subIds.forEach(subId => client.send(toJson(['CLOSE', subId])))
    delete batchers[client.url]
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
  const batcher = batchers[client.url]

  if (!batcher || batcher.updateTimer === null) {
    return Promise.resolve()
  }

  return new Promise(resolve => batcher.flushWaiters.add(resolve))
}

const flushBatch = (client: SocketClient): void => {
  const batcher = batchers[client.url]

  if (!batcher || batcher.topics.size === 0) {
    return
  }

  const topics = [...batcher.topics.keys()]
  const chunks: string[][] = []
  const since = now()

  for (let i = 0; i < topics.length; i += maxTopicsPerSubscription) {
    chunks.push(topics.slice(i, i + maxTopicsPerSubscription))
  }

  while (batcher.subIds.length > chunks.length) {
    const subId = batcher.subIds.pop()

    if (subId) {
      client.send(toJson(['CLOSE', subId]))
    }
  }

  chunks.forEach((chunk, i) => {
    const subId = (batcher.subIds[i] ??= genId(64))

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
  const batcher = batchers[client.url]

  if (batcher && batcher.topics.size > 0) {
    flushBatch(client)
  }
}

export const joinRoom: JoinRoom<NostrRoomConfig> = createTopicStrategy({
  init: config =>
    getRelays(config, defaultRelayUrls, defaultRedundancy, true).map(url => {
      const client = relayManager.register(url, () =>
        makeSocket(
          url,
          data => {
            const [msgType, subId, payload, relayMsg] =
              fromJson<
                [
                  string,
                  string,
                  {content: string; tags?: string[][]} | boolean,
                  string
                ]
              >(data)

            if (msgType !== eventMsgType) {
              const prefix = `${libName}: relay failure from ${client.url} - `
              const isRateLimited =
                msgType === 'OK' &&
                !payload &&
                typeof relayMsg === 'string' &&
                relayMsg.startsWith('rate-limited:')

              const didAcknowledgeAnnouncement =
                msgType === 'OK' && acknowledgeEvent(client, subId)

              if (isRateLimited || (didAcknowledgeAnnouncement && !payload)) {
                backoffRelay(client)
              } else if (didAcknowledgeAnnouncement) {
                relayBackoffs.delete(client)
              }

              if (config.relayConfig?.warnOnRelayFailure !== false) {
                if (msgType === 'NOTICE') {
                  console.warn(prefix + subId)
                } else if (msgType === 'OK' && !payload) {
                  console.warn(prefix + relayMsg)
                }
              }

              return
            }

            if (
              payload &&
              typeof payload === 'object' &&
              'content' in payload
            ) {
              const {content} = payload
              const handler = msgHandlers[subId]

              if (handler) {
                handler(subIdToTopic[subId] ?? '', content)
                return
              }

              const batcher = batchers[client.url]

              if (batcher?.subIds.includes(subId) && payload.tags) {
                const topicTag = payload.tags.find(t => t[0] === tag)

                if (topicTag?.[1]) {
                  batcher.topics.get(topicTag[1])?.(topicTag[1], content)
                }
              }
            }
          },
          () => resubscribeOnReconnect(client)
        )
      )

      return client.ready
    }),

  subscribeTopic: (client, topic, onMessage, context) => {
    const handler: TopicHandler = (topic, data) => void onMessage(topic, data)

    batchAdd(client, topic, handler)

    const cleanup = () => {
      batchRemove(client, topic)
    }

    // Active rooms add the self topic before the root topic. Waiting only on
    // the root keeps both topics in one batch while guaranteeing the REQ is
    // written before createStrategy starts announcing.
    return context.kind === 'root'
      ? waitForBatchFlush(client).then(() => cleanup)
      : cleanup
  },

  publishTopic: async (client, topic, msg, context) => {
    if (context.kind === 'announce') {
      const remainingBackoffMs = getRelayBackoffMs(client)

      if (remainingBackoffMs > 0) {
        return nextAnnounce(
          Math.max(steadyAnnounceIntervalMs, remainingBackoffMs)
        )
      }
    }

    const event = await createEvent(
      topic,
      typeof msg === 'string' ? msg : toJson(msg)
    )
    const didSend = client.socket.readyState === 1
    client.send(event)

    if (context.kind !== 'announce') {
      return
    }

    if (!didSend) {
      return nextAnnounce(backoffRelay(client))
    }

    const eventId = fromJson<[string, {id: string}]>(event)[1].id
    trackAnnouncementAck(client, eventId)

    return nextAnnounce(steadyAnnounceIntervalMs)
  }
})

export const getRelaySockets = relayManager.getSockets

export {pauseRelayReconnection, resumeRelayReconnection, selfId}

export const defaultRelayUrls = [
  'basspistol.org',
  'bucket.coracle.social',
  'chorus.pjv.me',
  'koru.bitcointxoko.org',
  'nos.lol',
  'nostr-01.uid.ovh',
  'nostr-01.yakihonne.com',
  'nostr-relay.corb.net',
  'nostr.data.haus',
  'nostr.islandarea.net',
  'nostr.sathoarder.com',
  'nostr.tegila.com.br',
  'nostr.vulpem.com',
  'purplerelay.com',
  'relay-can.zombi.cloudrodion.com',
  'relay-rpi.edufeed.org',
  'relay.agorist.space',
  'relay.artio.inf.unibe.ch',
  'relay.mostr.pub',
  'relay.mostro.network',
  'relay.sigit.io',
  'relay02.lnfi.network',
  'schnorr.me',
  'social.amanah.eblessing.co',
  'staging.yabu.me',
  'strfry.shock.network',
  'top.testrelay.top',
  'yabu.me/v2'
].map(url => 'wss://' + url)

export type * from '@trystero-p2p/core'
