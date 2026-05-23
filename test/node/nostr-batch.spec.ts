// @ts-nocheck
import assert from 'node:assert/strict'
import test from 'node:test'
import {joinRoom} from '../../packages/nostr/src/index.ts'

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

    setTimeout(() => {
      this.readyState = 1
      this.onopen?.()
    }, 0)
  }

  send(data) {
    this.sent.push(JSON.parse(data))
  }

  close() {
    this.readyState = 3
    this.onclose?.()
  }
}

const wait = (ms: number) => new Promise(res => setTimeout(res, ms))

const waitFor = async (
  check: () => boolean,
  timeoutMs = 2_000
): Promise<void> => {
  const start = Date.now()

  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for condition')
    }

    await wait(10)
  }
}

void test(
  'Trystero: nostr batches many passive room subscriptions into bounded filters',
  {timeout: 10_000},
  async () => {
    const originalWebSocket = globalThis.WebSocket

    globalThis.WebSocket = MockWebSocket
    MockWebSocket.sockets.length = 0

    const appId = `nostr-batch-${Date.now()}`
    const roomCount = 251
    const rooms = []

    try {
      for (let i = 0; i < roomCount; i++) {
        rooms.push(
          joinRoom(
            {
              appId,
              passive: true,
              relayConfig: {urls: ['wss://nostr-batch.test']}
            },
            `room-${i}`
          )
        )
      }

      await waitFor(() =>
        MockWebSocket.sockets.some(
          socket => socket.sent.filter(msg => msg[0] === 'REQ').length === 2
        )
      )

      const socket = MockWebSocket.sockets[0]
      const reqs = socket.sent.filter(msg => msg[0] === 'REQ')

      assert.equal(reqs.length, 2, '251 topics should be split into 2 REQs')
      assert.equal(reqs[0][2]['#x'].length, 250)
      assert.equal(reqs[1][2]['#x'].length, 1)
      assert.equal(
        Math.max(...reqs.map(req => req[2]['#x'].length)),
        250,
        'nostr batch filters should stay capped at 250 topics'
      )
    } finally {
      await Promise.all(rooms.map(room => room.leave().catch(() => {})))
      globalThis.WebSocket = originalWebSocket
    }
  }
)
