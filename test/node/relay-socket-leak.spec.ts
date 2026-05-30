// @ts-nocheck
import assert from 'node:assert/strict'
import test from 'node:test'
import {makeSocket} from '../../packages/core/src/utils.ts'
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

void test(
  'Trystero: a socket client can be torn down so it stops reconnecting',
  {timeout: 5_000},
  async () => {
    const realWebSocket = globalThis.WebSocket
    const realSetTimeout = globalThis.setTimeout

    const sockets = []
    let pendingInit = null

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
      // Capture the reconnect timer so we can fire it deterministically.
      globalThis.setTimeout = fn => {
        pendingInit = fn
        return 0
      }

      const client = makeSocket(`ws://socket-teardown-${Date.now()}`, () => {})
      assert.equal(sockets.length, 1, 'makeSocket should open one socket')

      assert.equal(
        typeof client.close,
        'function',
        'makeSocket should expose a close() teardown so a discarded client can be stopped'
      )

      // Drop the socket so makeSocket schedules a reconnect, then tear the
      // client down. The pending reconnect must not resurrect the socket —
      // this is the loop that, left running across re-joins, exhausts the
      // browser's per-host WebSocket budget ("Insufficient resources").
      sockets[0].close()
      client.close()

      if (pendingInit) {
        const stale = pendingInit
        pendingInit = null
        stale()
      }

      assert.equal(
        sockets.length,
        1,
        'a closed socket client must not open further sockets, even if a reconnect was already scheduled'
      )
    } finally {
      globalThis.WebSocket = realWebSocket
      globalThis.setTimeout = realSetTimeout
    }
  }
)

// Every socket-backed transport shares the same relay lifecycle: leaving the
// last room resets the strategy's didInit, so the next join re-runs init and
// opens fresh sockets. If leave() doesn't close the sockets init() opened, each
// cycle orphans a live socket (and its reconnect loop) until the browser
// refuses new ones with "Insufficient resources".
const runSocketLeakTests = (
  strategy: string,
  joinRoom: typeof joinNostrRoom
): void => {
  const makeConfig = (suffix: string) => ({
    appId: `socket-leak-${strategy}-${suffix}-${Date.now()}`,
    passive: true,
    relayConfig: {urls: [`wss://socket-leak-${strategy}-${suffix}.test`]}
  })

  void test(
    `Trystero: ${strategy} leaving a room closes its relay sockets`,
    {timeout: 10_000},
    async () => {
      const realWebSocket = globalThis.WebSocket

      globalThis.WebSocket = AutoOpenWebSocket
      AutoOpenWebSocket.sockets.length = 0

      try {
        const room = joinRoom(makeConfig('leave'), 'room')
        await waitFor(() => AutoOpenWebSocket.sockets.length >= 1)
        await room.leave().catch(() => {})

        assert.equal(
          openSockets().length,
          0,
          `${strategy}: room.leave() should close every relay socket it opened`
        )
      } finally {
        globalThis.WebSocket = realWebSocket
      }
    }
  )

  void test(
    `Trystero: ${strategy} repeated join/leave cycles do not accumulate open relay sockets`,
    {timeout: 15_000},
    async () => {
      const realWebSocket = globalThis.WebSocket

      globalThis.WebSocket = AutoOpenWebSocket
      AutoOpenWebSocket.sockets.length = 0

      const config = makeConfig('cycles')

      try {
        for (let cycle = 0; cycle < 5; cycle += 1) {
          const room = joinRoom(config, 'room')
          await waitFor(() => AutoOpenWebSocket.sockets.length >= cycle + 1)

          assert.ok(
            openSockets().length <= 1,
            `${strategy} cycle ${cycle}: expected at most one open relay socket, found ${openSockets().length}`
          )

          await room.leave().catch(() => {})
        }
      } finally {
        globalThis.WebSocket = realWebSocket
      }
    }
  )
}

runSocketLeakTests('nostr', joinNostrRoom)
runSocketLeakTests('torrent', joinTorrentRoom)
runSocketLeakTests('ws-relay', joinWsRelayRoom)
