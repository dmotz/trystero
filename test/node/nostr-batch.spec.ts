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

const getLatestReqs = (reqs: unknown[][]): unknown[][] => [
  ...new Map(reqs.map(req => [req[1], req])).values()
]

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

      const socket = MockWebSocket.sockets[0]
      let reqs = []
      let latestReqs = []

      await waitFor(() => {
        reqs = socket.sent.filter(msg => msg[0] === 'REQ')
        latestReqs = getLatestReqs(reqs)

        return (
          latestReqs.length === 2 &&
          latestReqs.some(req => req[2]['#x'].length === 250) &&
          latestReqs.some(req => req[2]['#x'].length === 1)
        )
      })

      const finalTopics = new Set(latestReqs.flatMap(req => req[2]['#x']))

      assert.equal(finalTopics.size, roomCount)
      assert.equal(
        latestReqs.length,
        2,
        '251 topics should be split into 2 active REQs'
      )
      assert.deepEqual(
        latestReqs.map(req => req[2]['#x'].length).sort((a, b) => b - a),
        [250, 1]
      )
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
