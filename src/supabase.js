import {createClient} from '@supabase/supabase-js'
import strategy from './strategy.js'
import {selfId} from './utils.js'

const events = {
  broadcast: 'broadcast',
  join: 'join',
  sdp: 'sdp'
}

export const joinRoom = strategy({
  init: config => createClient(config.appId, config.supabaseKey),

  subscribe: (client, rootTopic, selfTopic, onMessage) => {
    const allChans = []
    const subscribe = (topic, cb) => {
      const chan = client.channel(topic)

      chan.subscribe(async status => {
        if (status === 'SUBSCRIBED') {
          if (didUnsub) {
            client.removeChannel(chan)
            return
          }

          allChans.push(chan)
          return cb(chan)
        }

        if (status === 'CLOSED') {
          return
        }

        await client.removeChannel(chan)
        setTimeout(() => subscribe(topic, cb), 999)
      })
    }

    const handleMessage = (peerTopic, signal) =>
      subscribe(peerTopic, chan =>
        chan.send({
          type: events.broadcast,
          event: events.sdp,
          payload: signal
        })
      )

    subscribe(selfTopic, chan =>
      chan.on(events.broadcast, {event: events.sdp}, ({payload}) =>
        onMessage(selfTopic, payload, handleMessage)
      )
    )

    subscribe(rootTopic, chan =>
      chan.on(events.broadcast, {event: events.join}, ({payload}) =>
        onMessage(rootTopic, payload, handleMessage)
      )
    )

    let didUnsub = false

    return () => {
      allChans.forEach(chan => client.removeChannel(chan))
      didUnsub = true
    }
  },

  announce: (client, rootTopic) =>
    client.channel(rootTopic).send({
      type: events.broadcast,
      event: events.join,
      payload: {peerId: selfId}
    })
})

export {selfId} from './utils.js'
