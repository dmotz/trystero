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
  'Trystero: nostr batches many room subscriptions into bounded filters',
  {timeout: 10_000},
  async () => {
    const originalWebSocket = globalThis.WebSocket

    globalThis.WebSocket = MockWebSocket as any
    MockWebSocket.sockets.length = 0

    const appId = `nostr-batch-${Date.now()}`
    const roomCount = 126
    const topicCount = roomCount * 2
    const rooms = []

    try {
      for (let i = 0; i < roomCount; i++) {
        rooms.push(
          joinRoom(
            {
              appId,
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
          latestReqs.some(req => req[2]['#x'].length === 2)
        )
      })

      const finalTopics = new Set(latestReqs.flatMap(req => req[2]['#x']))

      assert.equal(finalTopics.size, topicCount)
      assert.equal(
        latestReqs.length,
        2,
        '252 topics should be split into 2 active REQs'
      )
      assert.deepEqual(
        latestReqs.map(req => req[2]['#x'].length).sort((a, b) => b - a),
        [250, 2]
      )
      assert.equal(
        Math.max(...reqs.map(req => req[2]['#x'].length)),
        250,
        'nostr batch filters should stay capped at 250 topics'
      )
      const nowSec = Math.floor(Date.now() / 1000)
      for (const req of latestReqs) {
        assert.ok(
          req[2].since <= nowSec - 55 && req[2].since >= nowSec - 65,
          `expected REQ since (${req[2].since}) to include ~60s clock-skew leeway from now (${nowSec})`
        )
      }
    } finally {
      await Promise.all(rooms.map(room => room.leave().catch(() => {})))
      globalThis.WebSocket = originalWebSocket
    }
  }
)

void test('Trystero: late Nostr subscription cleanup preserves a replacement room', async t => {
  const originalTimer = globalThis.setTimeout
  const originalSocket = globalThis.WebSocket
  globalThis.WebSocket = MockWebSocket as any
  t.after(() => {
    globalThis.WebSocket = originalSocket
  })
  MockWebSocket.sockets.length = 0
  const config = {
    appId: 'nostr-late-cleanup',
    relayConfig: {urls: ['wss://nostr-late-cleanup.test']}
  }
  const first = joinRoom(config, 'room')
  const pending: Array<() => void> = []
  const timer = t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
    if (ms === 0) {
      pending.push(() => fn(...args))
      return originalTimer(() => {}, 0)
    }
    return originalTimer(fn, ms, ...args)
  })
  let second
  try {
    await waitFor(() => pending.length > 0)
    const leaving = first.leave()
    second = joinRoom(config, 'room')
    // Let the replacement reach the same pending batch before resolving it.
    await wait(30)
    timer.mock.restore()
    pending.splice(0).forEach(flush => flush())
    await leaving
    await wait(20)
    const socket = MockWebSocket.sockets[0]
    const requests = socket.sent.filter(message => message[0] === 'REQ')
    assert.ok(requests.length > 0)
    const latest = requests.at(-1)
    assert.equal(
      socket.sent.some(
        message => message[0] === 'CLOSE' && message[1] === latest[1]
      ),
      false
    )
    await second.leave()
    assert.ok(
      socket.sent.some(
        message => message[0] === 'CLOSE' && message[1] === latest[1]
      )
    )
  } finally {
    timer.mock.restore()
    pending.splice(0).forEach(flush => flush())
    await first.leave()
    await second?.leave()
  }
})
