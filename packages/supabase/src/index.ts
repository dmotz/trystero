import {
  createClient,
  type RealtimeChannel,
  type SupabaseClient
} from '@supabase/supabase-js'
import {
  createStrategy,
  selfId,
  type BaseRoomConfig,
  type JoinRoom
} from '@trystero/core'

const events = {
  broadcast: 'broadcast',
  join: 'join',
  sdp: 'sdp'
} as const

export type SupabaseRoomConfig = BaseRoomConfig & {
  supabaseKey: string
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
    Object.values(entry.listeners[event] ?? {}).forEach(listener =>
      listener(payload)
    )
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

    if (Object.keys(listeners).length === 0) {
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
  Object.values(entry.listeners).some(
    listeners => Object.keys(listeners).length > 0
  )

const removeUnusedChannels = (client: SupabaseClient): void => {
  const cache = getChannelCache(client)

  Object.entries(cache.channels).forEach(([topic, entry]) => {
    if (hasListeners(entry)) {
      return
    }

    void client.removeChannel(entry.channel)
    delete cache.channels[topic]
  })
}

export const joinRoom: JoinRoom<SupabaseRoomConfig> = createStrategy({
  init: config => createClient(config.appId, config.supabaseKey),

  subscribe: async (client, rootTopic, selfTopic, onMessage) => {
    const handleMessage = (peerTopic: string, signal: string): void => {
      const entry = getOrCreateChannel(client, peerTopic)

      void entry.ready.then(chan => {
        void chan.send({
          type: events.broadcast,
          event: events.sdp,
          payload: signal
        })
      })
    }

    const selfEntry = getOrCreateChannel(client, selfTopic)
    const rootEntry = getOrCreateChannel(client, rootTopic)
    const removeSelfListener = addListener(selfEntry, events.sdp, payload => {
      void onMessage(
        selfTopic,
        payload as Record<string, unknown>,
        handleMessage
      )
    })
    const removeRootListener = addListener(rootEntry, events.join, payload => {
      void onMessage(
        rootTopic,
        payload as Record<string, unknown>,
        handleMessage
      )
    })

    await Promise.all([selfEntry.ready, rootEntry.ready])

    return () => {
      removeSelfListener()
      removeRootListener()
      removeUnusedChannels(client)
    }
  },

  announce: (client, rootTopic) =>
    getOrCreateChannel(client, rootTopic).ready.then(chan =>
      chan
        .send({
          type: events.broadcast,
          event: events.join,
          payload: {peerId: selfId}
        })
        .then(() => undefined)
    )
})

export {selfId}

export type * from '@trystero/core'
