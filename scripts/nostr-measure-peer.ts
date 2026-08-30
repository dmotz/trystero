import {RTCPeerConnection} from 'werift'
import WebSocket from 'ws'
import {joinRoom} from '@trystero-p2p/nostr'

globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket

const configJson = process.env['TRYSTERO_NOSTR_MEASURE_CONFIG']
const roomId = process.env['TRYSTERO_NOSTR_MEASURE_ROOM']
const role = process.env['TRYSTERO_NOSTR_MEASURE_ROLE']

if (!configJson || !roomId || !role) {
  throw new Error('missing Nostr measurement peer configuration')
}

const joinedAt = performance.now()
const room = joinRoom(
  {
    ...JSON.parse(configJson),
    rtcPolyfill: RTCPeerConnection
  },
  roomId
)

room.onPeerJoin = peerId => {
  console.log(
    JSON.stringify({
      type: 'connected',
      role,
      peerId,
      connectionMs: Math.round(performance.now() - joinedAt)
    })
  )
}

const shutdown = async (): Promise<void> => {
  await room.leave().catch(() => {})
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
