import assert from 'node:assert/strict'
import test from './test.ts'
import {joinRoom} from '../../packages/nostr/src/index.ts'

type NostrReqFilter = {
  kinds: number[]
  since: number
  '#x': string[]
}

type NostrSignedEvent = {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

type NostrReqFrame = ['REQ', string, NostrReqFilter]
type NostrCloseFrame = ['CLOSE', string]
type NostrEventFrame = ['EVENT', NostrSignedEvent]
type NostrClientFrame = NostrReqFrame | NostrCloseFrame | NostrEventFrame

class MockWebSocket {
  static sockets: MockWebSocket[] = []

  readyState = 0
  sent: NostrClientFrame[] = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: {data: string}) => void) | null = null
  url: string

  constructor(url: string) {
    this.url = url
    MockWebSocket.sockets.push(this)

    setTimeout(() => {
      this.readyState = 1
      this.onopen?.()
    }, 0)
  }

  send(data: string) {
    this.sent.push(JSON.parse(data) as NostrClientFrame)
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

const getLatestReqs = (reqs: NostrReqFrame[]): NostrReqFrame[] => [
  ...new Map(reqs.map(req => [req[1], req])).values()
]

void test(
  'Trystero: nostr batches many room subscriptions into bounded filters',
  {timeout: 10_000},
  async () => {
    const originalWebSocket = globalThis.WebSocket

    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket
    MockWebSocket.sockets.length = 0

    const appId = `nostr-batch-${Date.now()}`
    const roomCount = 126
    const topicCount = roomCount * 2
    const rooms: Array<ReturnType<typeof joinRoom>> = []

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

      const socket = MockWebSocket.sockets[0]!
      let reqs: NostrReqFrame[] = []
      let latestReqs: NostrReqFrame[] = []

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
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket
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
  const timer = t.mock.method(globalThis, 'setTimeout', ((
    fn: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    if (ms === 0) {
      pending.push(() => fn(...args))
      return originalTimer(() => {}, 0)
    }
    return originalTimer(fn, ms, ...args)
  }) as unknown as typeof setTimeout)
  let second: ReturnType<typeof joinRoom> | undefined
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
    const socket = MockWebSocket.sockets[0]!
    const requests = socket.sent.filter(message => message[0] === 'REQ')
    assert.ok(requests.length > 0)
    const latest = requests.at(-1)!
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

void test('Trystero: nostr generates isolated per-room keypairs lazily and rotates after leave', async t => {
  const originalSocket = globalThis.WebSocket
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket
  t.after(() => {
    globalThis.WebSocket = originalSocket
  })
  MockWebSocket.sockets.length = 0

  const url = `wss://nostr-room-keys-${Date.now()}.test`
  const config = {
    appId: `nostr-room-keys-${Date.now()}`,
    relayConfig: {urls: [url]}
  }

  const roomA = joinRoom(config, 'room-a')
  const roomB = joinRoom(config, 'room-b')

  try {
    let socket: MockWebSocket | undefined
    await waitFor(() => {
      socket = MockWebSocket.sockets[0]
      return (socket?.sent.filter(msg => msg[0] === 'EVENT').length ?? 0) >= 2
    })

    const initialEvents = socket!.sent
      .filter(msg => msg[0] === 'EVENT')
      .map(msg => msg[1])
    const pubkeysByTopic = new Map<string, string>()

    for (const ev of initialEvents) {
      const topic = ev.tags.find((tag: string[]) => tag[0] === 'x')?.[1]
      if (topic) {
        pubkeysByTopic.set(topic, ev.pubkey)
      }
    }

    assert.equal(pubkeysByTopic.size, 2)
    const [pubkeyA, pubkeyB] = [...pubkeysByTopic.values()]
    assert.notEqual(
      pubkeyA,
      pubkeyB,
      'separate rooms must not share a Nostr pubkey'
    )

    // Reconnect replay for active rooms keeps each room's own pubkey
    const beforeReplayCount = socket!.sent.filter(
      msg => msg[0] === 'EVENT'
    ).length
    socket!.onopen?.()
    await waitFor(
      () =>
        socket!.sent.filter(msg => msg[0] === 'EVENT').length >=
        beforeReplayCount + 2
    )
    const replayedEvents = socket!.sent
      .filter(msg => msg[0] === 'EVENT')
      .slice(beforeReplayCount)
      .map(msg => msg[1])

    for (const ev of replayedEvents) {
      const topic = ev.tags.find((tag: string[]) => tag[0] === 'x')?.[1]
      assert.equal(ev.pubkey, pubkeysByTopic.get(topic!))
    }

    // Leaving room-a and rejoining generates a fresh unlinkable pubkey
    await roomA.leave()
    const beforeRejoinCount = socket!.sent.filter(
      msg => msg[0] === 'EVENT'
    ).length
    const roomARejoined = joinRoom(config, 'room-a')
    try {
      await waitFor(
        () =>
          socket!.sent.filter(msg => msg[0] === 'EVENT').length >=
          beforeRejoinCount + 1
      )
      const rejoinEv = socket!.sent
        .filter(msg => msg[0] === 'EVENT')
        .slice(beforeRejoinCount)
        .map(msg => msg[1])[0]!
      assert.notEqual(
        rejoinEv.pubkey,
        pubkeyA,
        'rejoining after leave() must rotate to a fresh Nostr pubkey'
      )
      assert.notEqual(rejoinEv.pubkey, pubkeyB)
    } finally {
      await roomARejoined.leave()
    }
  } finally {
    await roomA.leave()
    await roomB.leave()
  }
})
