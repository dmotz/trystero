import assert from 'node:assert/strict'
import test from './test.ts'
import {joinRoom} from '../../packages/ws-relay/src/index.ts'
import type {WsRelayClientMessage} from '../../packages/ws-relay/src/protocol.ts'
import {MockRTCPeerConnection, wait, waitFor} from './peer-harness.ts'

class MockWebSocket {
  static sockets: MockWebSocket[] = []

  readyState = 0
  sent: WsRelayClientMessage[] = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: {data: string}) => void) | null = null
  url: string

  constructor(url: string) {
    this.url = url
    MockWebSocket.sockets.push(this)

    queueMicrotask(() => {
      this.readyState = 1
      this.onopen?.()
    })
  }

  send(data: string) {
    this.sent.push(JSON.parse(data) as WsRelayClientMessage)
  }

  close() {
    this.readyState = 3
    this.onclose?.()
  }
}

const announcementCount = (socket: MockWebSocket) =>
  socket.sent.filter(
    msg =>
      msg.type === 'publish' &&
      Boolean(msg.payload) &&
      typeof msg.payload === 'object' &&
      !Array.isArray(msg.payload) &&
      typeof (msg.payload as {peerId?: unknown}).peerId === 'string'
  ).length

void test(
  'Trystero: ws-relay slows steady announcements and restores state on reconnect',
  {timeout: 20_000},
  async () => {
    const originalWebSocket = globalThis.WebSocket
    const originalRandom = Math.random
    MockWebSocket.sockets.length = 0
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket
    Math.random = () => 0

    const room = joinRoom(
      {
        appId: `ws-relay-announcement-rate-${Date.now()}`,
        relayConfig: {urls: [`wss://ws-relay-rate-${Date.now()}.test`]},
        rtcPolyfill:
          MockRTCPeerConnection as unknown as typeof RTCPeerConnection
      },
      'room'
    )

    try {
      await wait(2_500)
      const firstSocket = MockWebSocket.sockets[0]!

      assert.equal(announcementCount(firstSocket), 4)

      await wait(5_500)
      assert.equal(announcementCount(firstSocket), 5)
      await wait(5_500)
      assert.equal(announcementCount(firstSocket), 5)

      firstSocket.close()
      await waitFor(() => MockWebSocket.sockets.length === 2)

      const reconnectFrames = MockWebSocket.sockets[1]!.sent
      assert.deepEqual(
        reconnectFrames.slice(0, 2).map(msg => msg.type),
        ['subscribe', 'subscribe']
      )
      assert.equal(reconnectFrames[2]?.type, 'publish')
      assert.equal(announcementCount(MockWebSocket.sockets[1]!), 1)
    } finally {
      await room.leave().catch(() => {})
      Math.random = originalRandom
      globalThis.WebSocket = originalWebSocket
    }
  }
)
