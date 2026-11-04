import assert from 'node:assert/strict'
import test from './test.ts'
import {
  createRelayManager,
  makeSocket
} from '../../packages/core/src/relay-manager.ts'
import type {Room} from '../../packages/core/src/types.ts'
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
  relayConfig: {urls: string[]}
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
}

runRelayReuseTests('nostr', joinNostrRoom)
runRelayReuseTests('torrent', joinTorrentRoom)
runRelayReuseTests('ws-relay', joinWsRelayRoom)
