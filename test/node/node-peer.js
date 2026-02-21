import {joinRoom} from '@trystero/nostr'
import {RTCPeerConnection} from 'werift'

const role = process.env['TRYSTERO_NODE_ROLE']
const appId = process.env['TRYSTERO_NODE_APP_ID']
const roomId = process.env['TRYSTERO_NODE_ROOM_ID']

if (!role || !appId || !roomId) {
  console.error('missing peer test env vars')
  process.exit(1)
}

const room = joinRoom(
  {
    appId,
    rtcPolyfill: RTCPeerConnection
  },
  roomId
)

const [sendPing, getPing] = room.makeAction('ping')
const [sendPong, getPong] = room.makeAction('pong')

let sentPing = false
let finished = false
let pingTimer = null

const done = async (type, message) => {
  if (finished) {
    return
  }

  finished = true
  clearTimeout(timeout)

  if (pingTimer) {
    clearInterval(pingTimer)
  }

  console.log(JSON.stringify({type, role, message}))

  try {
    await room.leave()
  } catch {}

  process.exit(type === 'success' ? 0 : 1)
}

const timeout = setTimeout(() => {
  void done('failure', 'timed out waiting for peer communication')
}, 60_000)

room.onPeerJoin(peerId => {
  if (role !== 'initiator' || sentPing) {
    return
  }

  sentPing = true
  const send = () =>
    void sendPing('hello-from-initiator', peerId).catch(() => {})
  send()
  pingTimer = setInterval(send, 1_500)
})

getPing((payload, peerId) => {
  if (role !== 'responder') {
    return
  }

  if (payload !== 'hello-from-initiator') {
    void done('failure', `unexpected ping payload: ${String(payload)}`)
    return
  }

  void sendPong('pong-from-responder', peerId)
    .then(() => done('success', 'received ping'))
    .catch(() => done('failure', 'failed sending pong'))
})

getPong(payload => {
  if (role !== 'initiator') {
    return
  }

  if (payload !== 'pong-from-responder') {
    void done('failure', `unexpected pong payload: ${String(payload)}`)
    return
  }

  if (pingTimer) {
    clearInterval(pingTimer)
  }

  void done('success', 'received pong')
})
