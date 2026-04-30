import {RTCPeerConnection} from 'werift'

const role = process.env['TRYSTERO_NODE_ROLE']
const strategy = process.env['TRYSTERO_NODE_STRATEGY']
const roomId = process.env['TRYSTERO_NODE_ROOM_ID']
const roomConfigJson = process.env['TRYSTERO_NODE_ROOM_CONFIG']

if (!role || !strategy || !roomId || !roomConfigJson) {
  console.error('missing peer test env vars')
  process.exit(1)
}

const roomConfig = {
  ...JSON.parse(roomConfigJson),
  rtcPolyfill: RTCPeerConnection
}

const {joinRoom} = await import(`@trystero-p2p/${strategy}`)

const room = joinRoom(roomConfig, roomId)

const ping = room.makeAction('ping')
const pong = room.makeAction('pong')

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

room.onPeerJoin = peerId => {
  if (role !== 'initiator' || sentPing) {
    return
  }

  sentPing = true
  const send = () =>
    void ping.send('hello-from-initiator', {target: peerId}).catch(() => {})
  send()
  pingTimer = setInterval(send, 1_500)
}

ping.onMessage = (payload, {peerId}) => {
  if (role !== 'responder') {
    return
  }

  if (payload !== 'hello-from-initiator') {
    void done('failure', `unexpected ping payload: ${String(payload)}`)
    return
  }

  void pong
    .send('pong-from-responder', {target: peerId})
    .then(() => done('success', 'received ping'))
    .catch(() => done('failure', 'failed sending pong'))
}

pong.onMessage = payload => {
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
}
