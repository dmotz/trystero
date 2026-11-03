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
  roles,
  scale,
  unrefTimer,
  type ActionError,
  type ActionErrorKind,
  type ActionMessageHandler,
  type ActionProgressContext,
  type ActionProgressHandler,
  type ActionReceiveContext,
  type ActionReceiveHandler,
  type ActionRequestHandler,
  type AddMediaOptions,
  type BanOptions,
  type BaseRelayConfig,
  type BaseRoomConfig,
  type DataPayload,
  type JoinRoom,
  type JsonValue,
  type ListenerOptions,
  type MessageAction,
  type MessageActionConfig,
  type MessageContext,
  type PeerInfo,
  type PeerJoinContext,
  type PeerLeaveContext,
  type PeerMediaContext,
  type PeerResult,
  type PeerTarget,
  type RemoveMediaOptions,
  type ReplaceTrackOptions,
  type ReplayListenerOptions,
  type RequestAction,
  type RequestActionConfig,
  type RequestContext,
  type RequestManyOptions,
  type RequestOptions,
  type RoleCertificate,
  type RolesConfig,
  type RolesPluginApi,
  type Room,
  type RoomError,
  type RoomErrorBase,
  type RoomErrorCode,
  type RoomErrorHandler,
  type RoomPlugin,
  type RoomWithPlugins,
  type ScaleConfig,
  type ScalePluginApi,
  type SelfInfo,
  type SendOptions,
  type SharedState,
  type StateChangeContext,
  type StateConfig,
  type TopologyRoute,
  type TopologySnapshot,
  type TopologyStats,
  type TurnServerConfig,
  type Unsubscribe,
  type UserIdentity,
  type UserIdentityConfig,
  type UserIdentityLoader,
  type UserIdentityLoaderContext,
  type UserInfo,
  type UserJoinContext,
  type UserLeaveContext,
  type UserState,
  type UserStateChangeContext,
  type UserStateConfig
} from '@trystero-p2p/core'

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

type ChannelCache = {
  channels: Record<string, ChannelEntry>
  sweepTimer?: ReturnType<typeof setTimeout>
}

type ChannelEntry = {
  channel: RealtimeChannel
  ready: Promise<RealtimeChannel>
  announcement?: unknown
  lastPublishedAt?: number
  listeners: Record<string, Record<string, (payload: unknown) => void>>
  boundEvents: Record<string, boolean>
  nextListenerId: number
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
  if (!clientChannels.has(client)) {
    clientChannels.set(client, {channels: {}})
  }

  return clientChannels.get(client) as ChannelCache
}

const bindEvent = (entry: ChannelEntry, event: string): void => {
  if (entry.boundEvents[event]) {
    return
  }

  entry.boundEvents[event] = true
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

const createChannelEntry = (
  client: SupabaseClient,
  topic: string
): ChannelEntry => {
  let resolveReady: ((chan: RealtimeChannel) => void) | null = null
  let rejectReady: ((err: Error) => void) | null = null
  const ready = new Promise<RealtimeChannel>((res, rej) => {
    resolveReady = res
    rejectReady = rej
  })
  void ready.catch(() => {})

  const channel = client.channel(getChannelName(topic), {
    config: {broadcast: {self: false}}
  })

  const entry: ChannelEntry = {
    channel,
    ready,
    listeners: {},
    boundEvents: {},
    nextListenerId: 0
  }

  let didSubscribe = false

  channel.subscribe((status, err) => {
    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      if (!didSubscribe) {
        const cache = getChannelCache(client)
        if (cache.channels[topic] === entry) {
          delete cache.channels[topic]
        }
        void client.removeChannel(channel)
        rejectReady?.(
          err instanceof Error ? err : new Error(`Supabase channel ${status}`)
        )
        resolveReady = null
        rejectReady = null
      }
      return
    }

    if (status !== 'SUBSCRIBED') {
      return
    }

    if (!didSubscribe) {
      didSubscribe = true
      resolveReady?.(channel)
      resolveReady = null
      rejectReady = null
      return
    }

    if (entry.announcement !== undefined) {
      void channel.send({
        type: events.broadcast,
        event: events.join,
        payload: entry.announcement
      })
    }
  })

  return entry
}

const getOrCreateChannel = (
  client: SupabaseClient,
  topic: string
): ChannelEntry => {
  const cache = getChannelCache(client)
  const entry = cache.channels[topic] ?? createChannelEntry(client, topic)

  if (!cache.channels[topic]) {
    cache.channels[topic] = entry
  }

  return entry
}

const hasListeners = (entry: ChannelEntry): boolean =>
  values(entry.listeners).some(listeners => keys(listeners).length > 0)

const removeUnusedChannels = (
  client: SupabaseClient,
  forceIdleSweep = false
): void => {
  const cache = getChannelCache(client)
  const now = Date.now()
  let hasActiveListeners = false
  let hasPendingIdle = false

  entries(cache.channels).forEach(([, entry]) => {
    if (hasListeners(entry)) {
      hasActiveListeners = true
    }
  })

  entries(cache.channels).forEach(([topic, entry]) => {
    if (hasListeners(entry)) {
      return
    }

    if (
      hasActiveListeners &&
      !forceIdleSweep &&
      entry.lastPublishedAt !== undefined &&
      now - entry.lastPublishedAt < idleSignalChannelMs
    ) {
      hasPendingIdle = true
      return
    }

    void client.removeChannel(entry.channel)
    delete cache.channels[topic]
  })

  if (!hasPendingIdle && cache.sweepTimer) {
    clearTimeout(cache.sweepTimer)
    delete cache.sweepTimer
  }

  if (keys(cache.channels).length === 0) {
    const key = clientKeys.get(client)
    if (key && clients.get(key) === client) {
      clients.delete(key)
    }
  }
}

const scheduleIdleSignalSweep = (client: SupabaseClient): void => {
  const cache = getChannelCache(client)
  if (cache.sweepTimer) {
    return
  }
  const timer = setTimeout(() => {
    delete cache.sweepTimer
    removeUnusedChannels(client, true)
  }, idleSignalChannelMs)
  unrefTimer(timer)
  cache.sweepTimer = timer
}

export const joinRoom: JoinRoom<SupabaseRoomConfig> =
  /*@__PURE__*/ createTopicStrategy({
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

      await entry.ready

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
        entry.announcement = payload
      } else {
        entry.lastPublishedAt = Date.now()
        if (!hasListeners(entry)) {
          scheduleIdleSignalSweep(client)
        }
      }

      return entry.ready.then(async chan => {
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
  scale,
  type ActionError,
  type ActionErrorKind,
  type ActionMessageHandler,
  type ActionProgressContext,
  type ActionProgressHandler,
  type ActionReceiveContext,
  type ActionReceiveHandler,
  type ActionRequestHandler,
  type AddMediaOptions,
  type BanOptions,
  type DataPayload,
  type JsonValue,
  type ListenerOptions,
  type MessageAction,
  type MessageActionConfig,
  type MessageContext,
  type PeerInfo,
  type PeerJoinContext,
  type PeerLeaveContext,
  type PeerMediaContext,
  type PeerResult,
  type PeerTarget,
  type RemoveMediaOptions,
  type ReplaceTrackOptions,
  type ReplayListenerOptions,
  type RequestAction,
  type RequestActionConfig,
  type RequestContext,
  type RequestManyOptions,
  type RequestOptions,
  type RoleCertificate,
  type RolesConfig,
  type RolesPluginApi,
  type Room,
  type RoomError,
  type RoomErrorBase,
  type RoomErrorCode,
  type RoomErrorHandler,
  type RoomPlugin,
  type RoomWithPlugins,
  type ScaleConfig,
  type ScalePluginApi,
  type SelfInfo,
  type SendOptions,
  type SharedState,
  type StateChangeContext,
  type StateConfig,
  type TopologyRoute,
  type TopologySnapshot,
  type TopologyStats,
  type TurnServerConfig,
  type Unsubscribe,
  type UserIdentity,
  type UserIdentityConfig,
  type UserIdentityLoader,
  type UserIdentityLoaderContext,
  type UserInfo,
  type UserJoinContext,
  type UserLeaveContext,
  type UserState,
  type UserStateChangeContext,
  type UserStateConfig
}
