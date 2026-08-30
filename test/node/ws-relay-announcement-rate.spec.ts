// @ts-nocheck
import assert from 'node:assert/strict'
import test from 'node:test'
import {joinRoom} from '../../packages/ws-relay/src/index.ts'
import {MockRTCPeerConnection, wait, waitFor} from './peer-harness.ts'

class MockWebSocket {
  static sockets = []

  readyState = 0
  sent = []
  onopen = null
  onclose = null
  onmessage = null
  url

  constructor(url) {
    this.url = url
    MockWebSocket.sockets.push(this)

    queueMicrotask(() => {
      this.readyState = 1
      this.onopen?.()
    })
  }

  send(data) {
    this.sent.push(JSON.parse(data))
  }

  close() {
    this.readyState = 3
    this.onclose?.()
  }
}

const announcementCount = socket =>
  socket.sent.filter(
    msg =>
      msg.type === 'publish' &&
      typeof msg.payload === 'string' &&
      JSON.parse(msg.payload).peerId
  ).length

void test(
  'Trystero: ws-relay slows steady announcements and restores state on reconnect',
  {timeout: 12_000},
  async () => {
    const originalWebSocket = globalThis.WebSocket
    const originalRandom = Math.random
    MockWebSocket.sockets.length = 0
    globalThis.WebSocket = MockWebSocket
    Math.random = () => 0

    const room = joinRoom(
      {
        appId: `ws-relay-announcement-rate-${Date.now()}`,
        relayConfig: {urls: [`wss://ws-relay-rate-${Date.now()}.test`]},
        rtcPolyfill: MockRTCPeerConnection
      },
      'room'
    )

    try {
      await wait(2_500)
      const firstSocket = MockWebSocket.sockets[0]

      assert.equal(announcementCount(firstSocket), 4)

      await wait(5_500)
      assert.equal(announcementCount(firstSocket), 4)

      firstSocket.close()
      await waitFor(() => MockWebSocket.sockets.length === 2)

      const reconnectFrames = MockWebSocket.sockets[1].sent
      assert.deepEqual(
        reconnectFrames.slice(0, 2).map(msg => msg.type),
        ['subscribe', 'subscribe']
      )
      assert.equal(reconnectFrames[2]?.type, 'publish')
      assert.equal(announcementCount(MockWebSocket.sockets[1]), 1)
    } finally {
      await room.leave().catch(() => {})
      Math.random = originalRandom
      globalThis.WebSocket = originalWebSocket
    }
  }
)
