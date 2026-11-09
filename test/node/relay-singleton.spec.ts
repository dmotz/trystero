import assert from 'node:assert/strict'
import test from './test.ts'
import {
  createRelayManager,
  makeSocket,
  releaseRelayLease
} from '../../packages/core/src/relay-manager.ts'
import type {SocketClient} from '../../packages/core/src/internal-types.ts'
import type {Room, RoomError} from '../../packages/core/src/types.ts'
import {joinRoom as joinNostrRoom} from '../../packages/nostr/src/index.ts'
import {joinRoom as joinTorrentRoom} from '../../packages/torrent/src/index.ts'
import {joinRoom as joinWsRelayRoom} from '../../packages/ws-relay/src/index.ts'
import {MockRTCPeerConnection} from './peer-harness.ts'

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

class AutoOpenWebSocket {
  static sockets: AutoOpenWebSocket[] = []

  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: {data: string}) => void) | null = null
  url: string

  constructor(url: string) {
    this.url = url
    AutoOpenWebSocket.sockets.push(this)

    setTimeout(() => {
      this.readyState = 1
      this.onopen?.()
    }, 0)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.readyState = 3
    this.onclose?.()
  }
}

const openSockets = () =>
  AutoOpenWebSocket.sockets.filter(socket => socket.readyState !== 3)

void test('Trystero: relay manager registers each relay once', () => {
  const manager = createRelayManager<{socket?: WebSocket}>(
    relay => relay.socket
  )
  let creates = 0

  const first = manager.register('relay', () => {
    creates += 1
    return {}
  })
  const second = manager.register('relay', () => {
    creates += 1
    return {}
  })

  assert.equal(creates, 1)
  assert.equal(second, first)
})

void test('Trystero: relay manager replaces closed relay clients and omits them from getSockets', async () => {
  const realWebSocket = globalThis.WebSocket
  globalThis.WebSocket = AutoOpenWebSocket as unknown as typeof WebSocket
  AutoOpenWebSocket.sockets.length = 0

  try {
    const manager = createRelayManager<SocketClient>(
      relay => relay.socket,
      relay => relay.close?.()
    )
    const url = `wss://relay-replace-closed-${Date.now()}.test`
    const createClient = () => makeSocket(url, () => {})

    const first = manager.register(url, createClient)
    const firstLease = manager.lease(first, first.ready)
    await firstLease
    assert.ok(manager.getSockets()[url])

    first.close?.()
    assert.equal(first.isClosed, true)
    assert.equal(
      manager.getSockets()[url],
      undefined,
      'closed client should not be exposed by getSockets()'
    )

    const second = manager.register(url, createClient)
    assert.notEqual(
      second,
      first,
      'register must replace a closed relay client instead of reusing it'
    )
    assert.equal(second.isClosed, false)
    const secondLease = manager.lease(second, second.ready)
    await secondLease
    assert.equal(manager.getSockets()[url], second.socket)

    // Releasing the stale lease from the evicted first client must not affect the replacement.
    releaseRelayLease(firstLease)
    assert.equal(second.isClosed, false)
    assert.equal(manager.getSockets()[url], second.socket)

    releaseRelayLease(secondLease)
    assert.equal(second.isClosed, true)
    assert.equal(manager.getSockets()[url], undefined)
  } finally {
    globalThis.WebSocket = realWebSocket
  }
})

void test(
  'Trystero: socket client owns a single reconnect timer',
  {timeout: 5_000},
  async () => {
    const realWebSocket = globalThis.WebSocket
    const realSetTimeout = globalThis.setTimeout

    const sockets: ManualSocket[] = []
    const pendingReconnects: Array<() => void> = []

    class ManualSocket {
      readyState = 0
      onopen: (() => void) | null = null
      onclose: (() => void) | null = null
      onmessage: ((event: {data: string}) => void) | null = null
      url: string

      constructor(url: string) {
        this.url = url
        sockets.push(this)
      }

      send() {}

      close() {
        this.readyState = 3
        this.onclose?.()
      }
    }

    try {
      globalThis.WebSocket = ManualSocket as unknown as typeof WebSocket
      globalThis.setTimeout = ((fn: () => void) => {
        pendingReconnects.push(fn)
        return {}
      }) as unknown as typeof setTimeout

      makeSocket(`ws://socket-singleton-${Date.now()}`, () => {})

      sockets[0]!.close()
      sockets[0]!.close()
      pendingReconnects.forEach(fn => fn())

      assert.equal(
        pendingReconnects.length,
        1,
        'a socket should only schedule one reconnect while reconnect is pending'
      )
      assert.equal(
        sockets.length,
        2,
        'only one replacement socket should be opened'
      )
    } finally {
      globalThis.WebSocket = realWebSocket
      globalThis.setTimeout = realSetTimeout
    }
  }
)

type RelayReuseConfig = {
  appId: string
  rtcPolyfill: typeof RTCPeerConnection
  relayConfig: {urls: string[]; warnOnRelayFailure?: boolean}
}

const runRelayReuseTests = (
  strategy: string,
  joinRoom: (config: RelayReuseConfig, roomId: string) => Room
): void => {
  const makeConfig = (suffix: string): RelayReuseConfig => ({
    appId: `relay-singleton-${strategy}-${suffix}-${Date.now()}`,
    rtcPolyfill: MockRTCPeerConnection as unknown as typeof RTCPeerConnection,
    relayConfig: {urls: [`wss://relay-singleton-${strategy}-${suffix}.test`]}
  })

  void test(
    `Trystero: ${strategy} shares relay sockets across concurrent rooms and closes on last leave`,
    {timeout: 10_000},
    async () => {
      const realWebSocket = globalThis.WebSocket

      globalThis.WebSocket = AutoOpenWebSocket as unknown as typeof WebSocket
      AutoOpenWebSocket.sockets.length = 0

      const config = makeConfig('cycles')
      let roomA: Room | undefined
      let roomB: Room | undefined
      let roomC: Room | undefined

      try {
        roomA = joinRoom(config, 'room-a')
        roomB = joinRoom(config, 'room-b')

        await waitFor(() => AutoOpenWebSocket.sockets.length >= 1)

        assert.equal(
          AutoOpenWebSocket.sockets.length,
          1,
          `${strategy}: expected concurrent rooms to share a single relay socket`
        )
        assert.equal(openSockets().length, 1)

        await roomA.leave()
        assert.equal(
          openSockets().length,
          1,
          `${strategy}: socket stays open while activeRooms >= 1`
        )

        await roomB.leave()
        assert.equal(
          openSockets().length,
          0,
          `${strategy}: socket closes when activeRooms reaches 0`
        )

        roomC = joinRoom(config, 'room-c')
        await waitFor(() => AutoOpenWebSocket.sockets.length >= 2)
        assert.equal(AutoOpenWebSocket.sockets.length, 2)
        assert.equal(
          openSockets().length,
          1,
          `${strategy}: socket reopens cleanly on subsequent joinRoom`
        )
        await roomC.leave()
        assert.equal(openSockets().length, 0)
      } finally {
        await roomA?.leave().catch(() => {})
        await roomB?.leave().catch(() => {})
        await roomC?.leave().catch(() => {})
        globalThis.WebSocket = realWebSocket
      }
    }
  )

  void test(
    `Trystero: ${strategy} wakes capped-backoff shared sockets on new joinRoom and reports relay-failed while unreachable`,
    {timeout: 10_000},
    async t => {
      t.mock.timers.enable({apis: ['setTimeout', 'Date']})
      const realWebSocket = globalThis.WebSocket
      const realRandom = Math.random

      let reachable = true
      const created: ToggleSocket[] = []

      class ToggleSocket {
        readyState = 0
        sent: string[] = []
        onopen: (() => void) | null = null
        onclose: (() => void) | null = null
        onmessage: ((event: {data: string}) => void) | null = null
        url: string

        constructor(url: string) {
          this.url = url
          created.push(this)
          setTimeout(() => {
            if (reachable) {
              this.readyState = 1
              this.onopen?.()
            } else {
              this.readyState = 3
              this.onclose?.()
            }
          }, 5)
        }

        send(data: string) {
          this.sent.push(data)
        }

        close() {
          this.readyState = 3
          this.onclose?.()
        }
      }

      const flushAsync = () => new Promise<void>(res => setImmediate(res))

      const advance = async (totalMs: number, stepMs = 100) => {
        for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
          t.mock.timers.tick(Math.min(stepMs, totalMs - elapsed))
          await flushAsync()
        }
      }

      globalThis.WebSocket = ToggleSocket as unknown as typeof WebSocket
      Math.random = () => 0.99

      const config: RelayReuseConfig = {
        ...makeConfig('outage-recovery'),
        relayConfig: {
          urls: [`wss://relay-outage-${strategy}-${Date.now()}.test`],
          warnOnRelayFailure: false
        }
      }

      let roomA: Room | undefined
      let roomB: Room | undefined
      let roomC: Room | undefined

      try {
        roomA = joinRoom(config, 'room-a')
        await advance(100, 10)
        assert.equal(created.length, 1)
        assert.equal(created[0]!.readyState, 1)

        // Simulate >2.5 minutes of background network cutoff (navigator.onLine stays true):
        // backoff reaches maxRetryMs (60s) and sits on a ~59.4s retry timer without retiring.
        reachable = false
        created[0]!.close()
        await advance(175_000, 500)
        assert.ok(
          created.length >= 6,
          `${strategy}: expected repeated retries across 175s outage`
        )
        assert.equal(
          created.some(s => s.readyState === 1),
          false,
          `${strategy}: all sockets should be closed during outage`
        )

        // Joining roomB while the shared relay is still unreachable must dial immediately
        // and emit 'relay-failed' rather than silently pretending the stale socket is healthy.
        const dialsBeforeRoomB = created.length
        const roomBErrors: RoomError[] = []
        roomB = joinRoom(config, 'room-b')
        roomB.onError(err => roomBErrors.push(err))
        await advance(100, 10)

        assert.equal(
          created.length,
          dialsBeforeRoomB + 1,
          `${strategy}: roomB should wake the sleeping shared socket immediately`
        )
        assert.equal(
          roomBErrors.some(err => err.code === 'relay-failed'),
          true,
          `${strategy}: roomB must receive relay-failed when shared relay remains unreachable`
        )

        // Connectivity returns while the shared socket still has ~59s left on its retry timer.
        // Joining roomC must reconnect immediately and restore traffic for all open rooms.
        reachable = true
        const dialsBeforeRoomC = created.length
        roomC = joinRoom(config, 'room-c')
        await advance(250, 10)

        assert.equal(
          created.length,
          dialsBeforeRoomC + 1,
          `${strategy}: roomC should immediately reconnect the shared socket`
        )
        const activeSocket = created.at(-1)!
        assert.equal(activeSocket.readyState, 1)
        const parsedFrames = activeSocket.sent.map(
          raw => JSON.parse(raw) as unknown
        )
        if (strategy === 'nostr') {
          const reqs = parsedFrames.filter(
            (f): f is ['REQ', string, {'#x': string[]}] =>
              Array.isArray(f) && f[0] === 'REQ'
          )
          const events = parsedFrames.filter(
            (f): f is ['EVENT', {tags: string[][]}] =>
              Array.isArray(f) && f[0] === 'EVENT'
          )
          assert.equal(
            reqs.at(-1)?.[2]['#x'].length,
            6,
            'nostr: all 3 rooms (6 topics) must be subscribed on the recovered socket'
          )
          const announcedTopics = new Set(
            events.map(e => e[1].tags.find(tag => tag[0] === 'x')?.[1] ?? '')
          )
          assert.equal(
            announcedTopics.size,
            3,
            'nostr: all 3 rooms must announce on the recovered socket'
          )
        } else if (strategy === 'torrent') {
          const infoHashes = new Set(
            parsedFrames.map(f => (f as {info_hash?: string}).info_hash ?? '')
          )
          assert.equal(
            infoHashes.size,
            3,
            'torrent: all 3 rooms must announce their info_hash on the recovered socket'
          )
        } else {
          const subscribedTopics = new Set(
            parsedFrames
              .filter(f => (f as {type?: string}).type === 'subscribe')
              .map(f => (f as {topic: string}).topic)
          )
          const publishedTopics = new Set(
            parsedFrames
              .filter(f => (f as {type?: string}).type === 'publish')
              .map(f => (f as {topic: string}).topic)
          )
          assert.equal(
            subscribedTopics.size,
            6,
            'ws-relay: all 3 rooms (6 topics) must subscribe on the recovered socket'
          )
          assert.equal(
            publishedTopics.size,
            3,
            'ws-relay: all 3 rooms must publish announcements on the recovered socket'
          )
        }
      } finally {
        Math.random = realRandom
        await roomA?.leave().catch(() => {})
        await roomB?.leave().catch(() => {})
        await roomC?.leave().catch(() => {})
        globalThis.WebSocket = realWebSocket
      }
    }
  )
}

runRelayReuseTests('nostr', joinNostrRoom)
runRelayReuseTests('torrent', joinTorrentRoom)
runRelayReuseTests('ws-relay', joinWsRelayRoom)
