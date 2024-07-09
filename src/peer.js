import Peer from '@thaunknown/simple-peer'
import {alloc} from './utils.js'

const dataEvent = 'data'
const signalEvent = 'signal'

export default (initiator, config) => {
  const peer = new Peer({
    ...{iceServers: [{urls: defaultIceServers}]},
    ...config,
    initiator,
    trickle: false
  })
  const onData = d => earlyDataBuffer.push(d)

  let earlyDataBuffer = []

  peer.on(dataEvent, onData)

  return {
    id: peer._id,

    created: Date.now(),

    connection: peer._pc,

    get channel() {
      return peer._channel
    },

    get isDead() {
      return peer.destroyed
    },

    signal: sdp =>
      new Promise(res => {
        if (!initiator) {
          peer.on(signalEvent, res)
        }
        peer.signal(sdp)
      }),

    sendData: data => peer.send(data),

    destroy: () => peer.destroy(),

    setHandlers: handlers =>
      Object.entries(handlers).forEach(([event, fn]) => peer.on(event, fn)),

    offerPromise: initiator
      ? new Promise(res => peer.on(signalEvent, res))
      : Promise.resolve(),

    addStream: stream => peer.addStream(stream),

    removeStream: stream => peer.removeStream(stream),

    addTrack: (track, stream) => peer.addTrack(track, stream),

    removeTrack: (track, stream) => peer.removeTrack(track, stream),

    replaceTrack: (oldTrack, newTrack, stream) =>
      peer.replaceTrack(oldTrack, newTrack, stream),

    drainEarlyData: f => {
      peer.off(dataEvent, onData)
      earlyDataBuffer.forEach(f)
      earlyDataBuffer = null
    }
  }
}

export const defaultIceServers = [
  ...alloc(5, (_, i) => `stun:stun${i || ''}.l.google.com:19302`),
  'stun:global.stun.twilio.com:3478'
]
