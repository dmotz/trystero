import {
  createClient,
  type RealtimeChannel,
  type SupabaseClient
} from '@supabase/supabase-js'
import {
  clearUserIdentity,
  createTopicStrategy,
  createUserIdentity,
  exportUserIdentity,
  fromJson,
  importUserIdentity,
  mkErr,
  roles,
  scale,
  unrefTimer,
  type BaseRelayConfig,
  type BaseRoomConfig,
  type JoinRoom,
  type Timeout
} from '@trystero-p2p/core'

const unreachable = (x: never): never => {
  throw mkErr(`unreachable: ${String(x)}`)
}

const {entries, keys, values} = Object
const idleSignalChannelMs = 30_000

const events = {
  broadcast: 'broadcast',
  join: 'join',
  sdp: 'sdp'
} as const

export type SupabaseRelayConfig = BaseRelayConfig & {
  supabaseKey: string
}

export type SupabaseRoomConfig = BaseRoomConfig & {
  relayConfig: SupabaseRelayConfig
}

type ChannelLifecycleState =
  | {
      readonly phase: 'connecting'
      readonly ready: Promise<RealtimeChannel>
      readonly resolve: (channel: RealtimeChannel) => void
      readonly reject: (err: Error) => void
    }
  | {
      readonly phase: 'subscribed'
      readonly ready: Promise<RealtimeChannel>
    }
  | {
      readonly phase: 'closed'
      readonly ready: Promise<RealtimeChannel>
    }

type ChannelEntry = {
  readonly channel: RealtimeChannel
  lifecycle: ChannelLifecycleState
  announcement: {readonly payload: unknown} | null
  lastPublishedAt: number | null
  listeners: Record<string, Record<string, (payload: unknown) => void>>
  boundEvents: Set<string>
  nextListenerId: number
}

type ChannelCache = {
  channels: Record<string, ChannelEntry>
  sweepTimer: Timeout | null
  sweepExpiresAt: number
}

const clients = /*@__PURE__*/ new Map<string, SupabaseClient>()
const clientKeys = /*@__PURE__*/ new WeakMap<SupabaseClient, string>()
const clientChannels = /*@__PURE__*/ new WeakMap<SupabaseClient, ChannelCache>()

const getOrCreateClient = (config: SupabaseRoomConfig): SupabaseClient => {
  const key = JSON.stringify([config.appId, config.relayConfig.supabaseKey])
  let client = clients.get(key)
  if (!client) {
    client = createClient(config.appId, config.relayConfig.supabaseKey)
    clients.set(key, client)
    clientKeys.set(client, key)
  }
  return client
}

const getChannelName = (topic: string): string => `room:${topic}:messages`

const getChannelCache = (client: SupabaseClient): ChannelCache => {
  let cache = clientChannels.get(client)
  if (!cache) {
    cache = {
      channels: {},
      sweepTimer: null,
      sweepExpiresAt: Infinity
    }
    clientChannels.set(client, cache)
  }
  return cache
}

const bindEvent = (entry: ChannelEntry, event: string): void => {
  if (entry.boundEvents.has(event)) {
    return
  }

  entry.boundEvents.add(event)
  entry.channel.on('broadcast', {event}, ({payload}) => {
    values(entry.listeners[event] ?? {}).forEach(listener => listener(payload))
  })
}

const addListener = (
  entry: ChannelEntry,
  event: string,
  onPayload: (payload: unknown) => void
): (() => void) => {
  entry.listeners[event] ??= {}
  const listenerId = String(entry.nextListenerId++)
  entry.listeners[event][listenerId] = onPayload
  bindEvent(entry, event)

  return () => {
    const listeners = entry.listeners[event]
    if (!listeners) {
      return
    }
    delete listeners[listenerId]
    if (keys(listeners).length === 0) {
      delete entry.listeners[event]
    }
  }
}

const disposeChannelEntry = (
  client: SupabaseClient,
  cache: ChannelCache,
  topic: string,
  entry: ChannelEntry,
  err?: Error
): void => {
  if (cache.channels[topic] === entry) {
    delete cache.channels[topic]
  }

  switch (entry.lifecycle.phase) {
    case 'connecting': {
      const {ready, reject} = entry.lifecycle
      entry.lifecycle = {phase: 'closed', ready}
      reject(err ?? new Error(`Supabase channel closed: ${topic}`))
      void client.removeChannel(entry.channel)
      return
    }
    case 'subscribed':
      entry.lifecycle = {phase: 'closed', ready: entry.lifecycle.ready}
      void client.removeChannel(entry.channel)
      return
    case 'closed':
      return
    default:
      unreachable(entry.lifecycle)
  }
}

const createChannelEntry = (
  client: SupabaseClient,
  topic: string
): ChannelEntry => {
  const {
    promise: ready,
    resolve,
    reject
  } = Promise.withResolvers<RealtimeChannel>()
  void ready.catch(() => {})

  const channel = client.channel(getChannelName(topic), {
    config: {broadcast: {self: false}}
  })

  const entry: ChannelEntry = {
    channel,
    lifecycle: {
      phase: 'connecting',
      ready,
      resolve,
      reject
    },
    announcement: null,
    lastPublishedAt: null,
    listeners: {},
    boundEvents: new Set(),
    nextListenerId: 0
  }

  channel.subscribe((status, err) => {
    if (
      status === 'CHANNEL_ERROR' ||
      status === 'TIMED_OUT' ||
      status === 'CLOSED'
    ) {
      if (entry.lifecycle.phase === 'connecting') {
        disposeChannelEntry(
          client,
          getChannelCache(client),
          topic,
          entry,
          err instanceof Error ? err : new Error(`Supabase channel ${status}`)
        )
      }
      return
    }

    if (status !== 'SUBSCRIBED') {
      return
    }

    switch (entry.lifecycle.phase) {
      case 'closed':
        return
      case 'connecting': {
        const {ready: readyP, resolve: resolveReady} = entry.lifecycle
        entry.lifecycle = {phase: 'subscribed', ready: readyP}
        resolveReady(channel)
        return
      }
      case 'subscribed':
        if (entry.announcement !== null) {
          void channel.send({
            type: events.broadcast,
            event: events.join,
            payload: entry.announcement.payload
          })
        }
        return
      default:
        unreachable(entry.lifecycle)
    }
  })

  return entry
}

const getOrCreateChannel = (
  client: SupabaseClient,
  topic: string
): ChannelEntry => {
  const cache = getChannelCache(client)
  const existing = cache.channels[topic]
  if (existing && existing.lifecycle.phase !== 'closed') {
    return existing
  }

  const created = createChannelEntry(client, topic)
  cache.channels[topic] = created
  return created
}

const hasListeners = (entry: ChannelEntry): boolean =>
  values(entry.listeners).some(listeners => keys(listeners).length > 0)

const computeEarliestIdleExpiry = (cache: ChannelCache): number => {
  let earliestExpiresAt = Infinity
  values(cache.channels).forEach(entry => {
    if (!hasListeners(entry) && entry.lastPublishedAt !== null) {
      earliestExpiresAt = Math.min(
        earliestExpiresAt,
        entry.lastPublishedAt + idleSignalChannelMs
      )
    }
  })
  return earliestExpiresAt
}

const syncSweepTimer = (
  client: SupabaseClient,
  cache: ChannelCache,
  earliestExpiresAt: number,
  now: number
): void => {
  if (earliestExpiresAt === Infinity) {
    if (cache.sweepTimer !== null) {
      clearTimeout(cache.sweepTimer)
      cache.sweepTimer = null
    }
    cache.sweepExpiresAt = Infinity
    return
  }

  if (cache.sweepTimer !== null && cache.sweepExpiresAt === earliestExpiresAt) {
    return
  }

  if (cache.sweepTimer !== null) {
    clearTimeout(cache.sweepTimer)
  }
  cache.sweepExpiresAt = earliestExpiresAt
  cache.sweepTimer = setTimeout(
    () => {
      cache.sweepTimer = null
      cache.sweepExpiresAt = Infinity
      removeUnusedChannels(client, Math.max(Date.now(), earliestExpiresAt))
    },
    Math.max(0, earliestExpiresAt - now)
  )
  unrefTimer(cache.sweepTimer)
}

const removeUnusedChannels = (
  client: SupabaseClient,
  now = Date.now()
): void => {
  const cache = getChannelCache(client)
  const hasActiveListeners = values(cache.channels).some(hasListeners)
  let earliestExpiresAt = Infinity

  entries(cache.channels).forEach(([topic, entry]) => {
    if (hasListeners(entry)) {
      return
    }

    if (hasActiveListeners && entry.lastPublishedAt !== null) {
      const expiresAt = entry.lastPublishedAt + idleSignalChannelMs
      if (now - entry.lastPublishedAt < idleSignalChannelMs) {
        earliestExpiresAt = Math.min(earliestExpiresAt, expiresAt)
        return
      }
    }

    disposeChannelEntry(client, cache, topic, entry)
  })

  syncSweepTimer(client, cache, earliestExpiresAt, now)

  if (keys(cache.channels).length === 0) {
    const key = clientKeys.get(client)
    if (key && clients.get(key) === client) {
      clients.delete(key)
    }
  }
}

const scheduleIdleSignalSweep = (client: SupabaseClient, now: number): void => {
  const cache = getChannelCache(client)
  syncSweepTimer(client, cache, computeEarliestIdleExpiry(cache), now)
}

export const joinRoom: JoinRoom<SupabaseRoomConfig> =
  /*@__PURE__*/ createTopicStrategy<SupabaseClient, SupabaseRoomConfig>({
    init: getOrCreateClient,

    subscribeTopic: async (client, topic, onMessage, {kind}) => {
      const entry = getOrCreateChannel(client, topic)
      const removeListener = addListener(
        entry,
        kind === 'root' ? events.join : events.sdp,
        payload => {
          void onMessage(topic, payload as Record<string, unknown>)
        }
      )

      try {
        await entry.lifecycle.ready
      } catch (err) {
        removeListener()
        removeUnusedChannels(client)
        throw err
      }

      return () => {
        removeListener()
        removeUnusedChannels(client)
      }
    },

    publishTopic: (client, topic, msg, {kind}) => {
      const entry = getOrCreateChannel(client, topic)
      const payload =
        kind === 'announce' && typeof msg === 'string'
          ? fromJson<Record<string, unknown>>(msg)
          : msg

      if (kind === 'announce') {
        entry.announcement = {payload}
      } else {
        const now = Date.now()
        entry.lastPublishedAt = now
        if (!hasListeners(entry)) {
          scheduleIdleSignalSweep(client, now)
        }
      }

      return entry.lifecycle.ready.then(async chan => {
        await chan.send({
          type: events.broadcast,
          event: kind === 'announce' ? events.join : events.sdp,
          payload
        })
      })
    }
  })

export {
  clearUserIdentity,
  createUserIdentity,
  exportUserIdentity,
  importUserIdentity,
  roles,
  scale
}
export type * from '@trystero-p2p/core/types'
