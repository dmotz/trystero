import {createClient} from '@supabase/supabase-js'
import strategy from './strategy.js'
import {selfId, values} from './utils.js'

const events = {
  broadcast: 'broadcast',
  join: 'join',
  sdp: 'sdp'
}

const clientChannels = new WeakMap()

const getChannelName = topic => `room:${topic}:messages`

const getChannelCache = client => {
  if (!clientChannels.has(client)) {
    clientChannels.set(client, {channels: {}, pending: {}})
  }
  return clientChannels.get(client)
}

const getOrCreateChannel = (client, topic, event, onPayload) => {
  const cache = getChannelCache(client)

  if (cache.channels[topic]) {
    return Promise.resolve(cache.channels[topic])
  }

  if (cache.pending[topic]) {
    return cache.pending[topic]
  }

  cache.pending[topic] = new Promise(res => {
    const chan = client.channel(getChannelName(topic), {
      config: {broadcast: {self: false}}
    })

    chan
      .on('broadcast', {event}, ({payload}) => onPayload?.(payload))
      .subscribe(status => {
        if (status === 'SUBSCRIBED') {
          cache.channels[topic] = chan
          delete cache.pending[topic]
          res(chan)
        }
      })
  })

  return cache.pending[topic]
}

export const joinRoom = strategy({
  init: config =>
    // @TODO reusing client instances makes the tests fail
    createClient(config.appId, config.supabaseKey),

  subscribe: (client, rootTopic, selfTopic, onMessage) => {
    const handleMessage = (peerTopic, signal) =>
      getOrCreateChannel(client, peerTopic, events.sdp).then(chan =>
        chan.send({
          type: events.broadcast,
          event: events.sdp,
          payload: signal
        })
      )

    getOrCreateChannel(client, selfTopic, events.sdp, payload =>
      onMessage(selfTopic, payload, handleMessage)
    )

    getOrCreateChannel(client, rootTopic, events.join, payload =>
      onMessage(rootTopic, payload, handleMessage)
    )

    return () => {
      const cache = getChannelCache(client)
      values(cache.channels).forEach(chan => client.removeChannel(chan))
      cache.channels = {}
      cache.pending = {}
    }
  },

  announce: (client, rootTopic) =>
    getOrCreateChannel(client, rootTopic, events.join).then(chan =>
      chan.send({
        type: events.broadcast,
        event: events.join,
        payload: {peerId: selfId}
      })
    )
})

export {selfId} from './utils.js'
