import {createClient} from '@supabase/supabase-js'
import strategy from './strategy.js'
import {selfId} from './utils.js'

const events = {
  broadcast: 'broadcast',
  join: 'join',
  sdp: 'sdp'
}

const whenReady = f => status => status === 'SUBSCRIBED' && f()

export const joinRoom = strategy({
  init: config => createClient(config.appId, config.supabaseKey),

  subscribe: (client, rootTopic, selfTopic, onMessage) => {
    const rootChan = client.channel(rootTopic)
    const selfChan = client.channel(selfTopic)
    const allChans = [rootChan, selfChan]

    const handleMessage = (peerTopic, signal) => {
      const chan = client.channel(peerTopic)

      allChans.push(chan)
      chan.subscribe(
        whenReady(() =>
          chan.send({
            type: events.broadcast,
            event: events.sdp,
            payload: signal
          })
        )
      )
    }

    rootChan
      .on(events.broadcast, {event: events.join}, ({payload}) =>
        onMessage(rootTopic, payload, handleMessage)
      )
      .subscribe(
        whenReady(() =>
          rootChan.send({
            type: events.broadcast,
            event: events.join,
            payload: {peerId: selfId}
          })
        )
      )

    selfChan
      .on(events.broadcast, {event: events.sdp}, ({payload}) =>
        onMessage(selfTopic, payload, handleMessage)
      )
      .subscribe()

    return () => allChans.forEach(chan => chan.untrack())
  }
})

export {selfId} from './utils.js'
