import {
  createClient,
  type RealtimeChannel,
  type SupabaseClient
} from '@supabase/supabase-js'
import {
  createTopicStrategy,
  entries,
  fromJson,
  keys,
  selfId,
  values,
  type BaseRelayConfig,
  type BaseRoomConfig,
  type JoinRoom
} from '@trystero-p2p/core'

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
}

type ChannelEntry = {
  channel: RealtimeChannel
  ready: Promise<RealtimeChannel>
  listeners: Record<string, Record<string, (payload: unknown) => void>>
  boundEvents: Record<string, boolean>
  nextListenerId: number
}

const clientChannels = new WeakMap<SupabaseClient, ChannelCache>()

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
  onPayload?: (payload: unknown) => void
): (() => void) => {
  if (!onPayload) {
    return () => {}
  }

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
  const ready = new Promise<RealtimeChannel>(res => {
    resolveReady = res
  })

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

  channel.subscribe(status => {
    if (status === 'SUBSCRIBED' && resolveReady) {
      resolveReady(channel)
      resolveReady = null
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

const removeUnusedChannels = (client: SupabaseClient): void => {
  const cache = getChannelCache(client)

  entries(cache.channels).forEach(([topic, entry]) => {
    if (hasListeners(entry)) {
      return
    }

    void client.removeChannel(entry.channel)
    delete cache.channels[topic]
  })
}

let client: SupabaseClient | null = null

export const joinRoom: JoinRoom<SupabaseRoomConfig> = createTopicStrategy({
  init: config =>
    (client ||= createClient(config.appId, config.relayConfig.supabaseKey)),

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

  publishTopic: (client, topic, msg, {kind}) =>
    getOrCreateChannel(client, topic).ready.then(chan =>
      chan
        .send({
          type: events.broadcast,
          event: kind === 'announce' ? events.join : events.sdp,
          payload:
            kind === 'announce' && typeof msg === 'string'
              ? fromJson<Record<string, unknown>>(msg)
              : msg
        })
        .then(() => undefined)
    )
})

export {selfId}

export type * from '@trystero-p2p/core'
