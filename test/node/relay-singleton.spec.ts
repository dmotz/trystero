// @ts-nocheck
import assert from 'node:assert/strict'
import test from 'node:test'
import {createRelayManager, makeSocket} from '../../packages/core/src/utils.ts'
import {joinRoom as joinNostrRoom} from '../../packages/nostr/src/index.ts'
import {joinRoom as joinTorrentRoom} from '../../packages/torrent/src/index.ts'
import {joinRoom as joinWsRelayRoom} from '../../packages/ws-relay/src/index.ts'

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
  static sockets = []

  readyState = 0
  sent = []
  onopen = null
  onclose = null
  onmessage = null
  url

  constructor(url) {
    this.url = url
    AutoOpenWebSocket.sockets.push(this)

    setTimeout(() => {
      this.readyState = 1
      this.onopen?.()
    }, 0)
  }

  send(data) {
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

    const sockets = []
    const pendingReconnects = []

    class ManualSocket {
      readyState = 0
      onopen = null
      onclose = null
      onmessage = null
      url

      constructor(url) {
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
      globalThis.WebSocket = ManualSocket
      globalThis.setTimeout = fn => {
        pendingReconnects.push(fn)
        return {}
      }

      makeSocket(`ws://socket-singleton-${Date.now()}`, () => {})

      sockets[0].close()
      sockets[0].close()
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

const runRelayReuseTests = (
  strategy: string,
  joinRoom: typeof joinNostrRoom
): void => {
  const makeConfig = (suffix: string) => ({
    appId: `relay-singleton-${strategy}-${suffix}-${Date.now()}`,
    passive: true,
    relayConfig: {urls: [`wss://relay-singleton-${strategy}-${suffix}.test`]}
  })

  void test(
    `Trystero: ${strategy} reuses relay sockets across join/leave cycles`,
    {timeout: 10_000},
    async () => {
      const realWebSocket = globalThis.WebSocket

      globalThis.WebSocket = AutoOpenWebSocket
      AutoOpenWebSocket.sockets.length = 0

      const config = makeConfig('cycles')

      try {
        for (let cycle = 0; cycle < 5; cycle += 1) {
          const room = joinRoom(config, 'room')

          await waitFor(() => AutoOpenWebSocket.sockets.length >= 1)

          assert.equal(
            AutoOpenWebSocket.sockets.length,
            1,
            `${strategy} cycle ${cycle}: expected the same relay socket to be reused`
          )
          assert.equal(
            openSockets().length,
            1,
            `${strategy} cycle ${cycle}: expected the relay socket to stay open`
          )

          await room.leave().catch(() => {})
        }
      } finally {
        globalThis.WebSocket = realWebSocket
      }
    }
  )
}

runRelayReuseTests('nostr', joinNostrRoom)
runRelayReuseTests('torrent', joinTorrentRoom)
runRelayReuseTests('ws-relay', joinWsRelayRoom)
