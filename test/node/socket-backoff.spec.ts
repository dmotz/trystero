import assert from 'node:assert/strict'
import test from 'node:test'
import {
  makeSocket,
  setRelayConnectivity
} from '../../packages/core/src/utils.ts'
import {setRelayConnectivity as nostrSetRelayConnectivity} from '../../packages/nostr/src/index.ts'
import {setRelayConnectivity as torrentSetRelayConnectivity} from '../../packages/torrent/src/index.ts'
import {setRelayConnectivity as trysteroSetRelayConnectivity} from '../../packages/trystero/src/index.ts'
import {setRelayConnectivity as wsRelaySetRelayConnectivity} from '../../packages/ws-relay/src/index.ts'

const tick = () => Promise.resolve()

void test(
  'Trystero: temporary outages retain capped retries until explicitly closed',
  {timeout: 5_000},
  async () => {
    const realRandom = Math.random
    const realSetTimeout = globalThis.setTimeout
    const realWebSocket = globalThis.WebSocket

    const scheduledDelays = []
    let pendingInit = null
    let allowClose = true

    class FailingSocket {
      url = ''
      readyState = 0
      onclose = null
      onopen = null
      onmessage = null

      constructor(url) {
        this.url = url
        queueMicrotask(() => {
          if (allowClose) {
            this.onclose?.()
          }
        })
      }

      send() {}
      close() {}
    }

    try {
      // makeSocket has no injection seam for WebSocket or its retry timer.
      Math.random = () => 1
      globalThis.setTimeout = ((fn, delay) => {
        scheduledDelays.push(delay)
        pendingInit = fn
        return 0
      }) as any
      globalThis.WebSocket = FailingSocket as any

      const client = makeSocket(`ws://test-backoff-${Date.now()}`, () => {})

      for (let i = 0; i < 8; i += 1) {
        await tick()
        assert.ok(
          pendingInit,
          `expected a retry to be scheduled after attempt ${i + 1}`
        )

        const next = pendingInit
        pendingInit = null
        next()
      }

      await tick()
      assert.ok(pendingInit, 'a recovered endpoint must remain reachable')
      assert.equal(client.isClosed, false)
      assert.deepEqual(
        scheduledDelays.slice(0, 5),
        [3_333, 6_666, 13_332, 26_664, 53_328]
      )
      assert.ok(scheduledDelays.slice(5).every(delay => delay === 60_000))
      client.close()
      assert.equal(client.isClosed, true)
    } finally {
      allowClose = false
      Math.random = realRandom
      globalThis.setTimeout = realSetTimeout
      globalThis.WebSocket = realWebSocket
    }
  }
)

void test(
  'Trystero: socket ready resolves after pre-open reconnect succeeds',
  {timeout: 5_000},
  async () => {
    const realSetTimeout = globalThis.setTimeout
    const realWebSocket = globalThis.WebSocket

    const sockets = []
    let pendingInit = null

    class ControlledSocket {
      url = ''
      readyState = 0
      onclose = null
      onopen = null
      onmessage = null

      constructor(url) {
        this.url = url
        sockets.push(this)
      }

      send() {}

      open() {
        this.readyState = 1
        this.onopen?.()
      }

      close() {
        this.readyState = 3
        this.onclose?.()
      }
    }

    let client
    try {
      globalThis.setTimeout = (fn => {
        pendingInit = fn
        return 0
      }) as any
      globalThis.WebSocket = ControlledSocket as any

      client = makeSocket(`ws://test-ready-${Date.now()}`, () => {})
      const firstReady = client.ready

      sockets[0].close()
      assert.ok(pendingInit, 'expected retry to be scheduled')

      const retry = pendingInit
      pendingInit = null
      retry()
      sockets[1].open()

      const readyClient = await Promise.race([
        firstReady,
        new Promise(res => realSetTimeout(() => res(null), 50))
      ])

      assert.equal(
        readyClient,
        client,
        'original ready promise should resolve when a retry opens'
      )
      assert.equal(
        firstReady,
        client.ready,
        'makeSocket should keep a stable ready promise across retries'
      )
    } finally {
      client?.close()
      globalThis.setTimeout = realSetTimeout
      globalThis.WebSocket = realWebSocket
    }
  }
)

void test(
  'Trystero: setRelayConnectivity controls offline hold, immediate online reconnect with backoff reset, and auto watcher',
  {timeout: 5_000},
  async () => {
    assert.equal(typeof nostrSetRelayConnectivity, 'function')
    assert.equal(torrentSetRelayConnectivity, nostrSetRelayConnectivity)
    assert.equal(wsRelaySetRelayConnectivity, nostrSetRelayConnectivity)
    assert.equal(trysteroSetRelayConnectivity, nostrSetRelayConnectivity)
    assert.equal(setRelayConnectivity(), 'auto')

    const realRandom = Math.random
    const realSetTimeout = globalThis.setTimeout
    const realClearTimeout = globalThis.clearTimeout
    const realWebSocket = globalThis.WebSocket
    const realAddEventListener = globalThis.addEventListener

    const sockets = []
    const timers = new Map()
    let nextTimerId = 1
    const scheduledDelays = []
    const windowListeners = new Map()

    class ControlledSocket {
      url = ''
      readyState = 0
      closeCalls = 0
      onclose = null
      onopen = null
      onmessage = null

      constructor(url) {
        this.url = url
        sockets.push(this)
      }

      send() {}

      open() {
        this.readyState = 1
        this.onopen?.()
      }

      fail() {
        this.readyState = 3
        this.onclose?.()
      }

      close() {
        this.closeCalls += 1
        this.readyState = 3
        this.onclose?.()
      }
    }

    const emitWindowEvent = type => {
      for (const listener of windowListeners.get(type) ?? []) {
        listener()
      }
    }

    let clientA
    let clientB
    try {
      Math.random = () => 1
      globalThis.setTimeout = ((fn, delay) => {
        const id = nextTimerId++
        timers.set(id, fn)
        scheduledDelays.push(delay)
        return id
      }) as any
      globalThis.clearTimeout = id => {
        timers.delete(id)
      }
      globalThis.WebSocket = ControlledSocket as any
      globalThis.addEventListener = (type, listener, options) => {
        const set = windowListeners.get(type) ?? new Set()
        set.add(listener)
        windowListeners.set(type, set)
        options?.signal?.addEventListener('abort', () => {
          set.delete(listener)
        })
      }

      let reconnectsA = 0
      clientA = makeSocket(
        `ws://test-connectivity-a-${Date.now()}`,
        () => {},
        () => {
          reconnectsA += 1
        }
      )
      assert.equal(sockets.length, 1)
      sockets[0].open()
      assert.equal(windowListeners.get('online')?.size, 1)
      assert.equal(windowListeners.get('offline')?.size, 1)

      // Escalate backoff on clientA over two failures (3333 -> 6666).
      sockets[0].fail()
      assert.equal(timers.size, 1)
      assert.equal(scheduledDelays.at(-1), 3_333)
      const firstRetry = [...timers.values()][0]
      timers.clear()
      firstRetry()
      assert.equal(sockets.length, 2)

      sockets[1].fail()
      assert.equal(timers.size, 1)
      assert.equal(scheduledDelays.at(-1), 6_666)

      // Transition to 'offline': cancels pending retry timer, closes open sockets,
      // detaches browser watcher, and holds reconnection.
      assert.equal(setRelayConnectivity('offline'), 'offline')
      assert.equal(setRelayConnectivity(), 'offline')
      assert.equal(timers.size, 0, 'pending retry timer must be cancelled')
      assert.equal(
        windowListeners.get('online')?.size ?? 0,
        0,
        'online watcher must be detached in manual offline mode'
      )
      assert.equal(
        windowListeners.get('offline')?.size ?? 0,
        0,
        'offline watcher must be detached in manual offline mode'
      )

      // Idempotent repeat of 'offline' must not re-close already closed sockets.
      const closeCallsBeforeRepeat = sockets[1].closeCalls
      assert.equal(setRelayConnectivity('offline'), 'offline')
      assert.equal(sockets[1].closeCalls, closeCallsBeforeRepeat)

      // Browser 'online' event must be ignored while in manual 'offline' mode.
      emitWindowEvent('online')
      assert.equal(sockets.length, 2)

      // Sockets created while 'offline' are held until connectivity returns.
      clientB = makeSocket(`ws://test-connectivity-b-${Date.now()}`, () => {})
      assert.equal(
        sockets.length,
        2,
        'new socket client must be held while connectivity is offline'
      )

      // Transition to 'online': reconnects immediately (both held clients),
      // resets backoff, and stays under manual control (watcher remains detached).
      assert.equal(setRelayConnectivity('online'), 'online')
      assert.equal(setRelayConnectivity(), 'online')
      assert.equal(sockets.length, 4)
      assert.equal(windowListeners.get('online')?.size ?? 0, 0)

      // Calling 'online' again while sockets are already connecting/open is a no-op.
      assert.equal(setRelayConnectivity('online'), 'online')
      assert.equal(sockets.length, 4)

      sockets[2].open()
      sockets[3].open()
      assert.equal(reconnectsA, 1)

      // Browser 'offline' event must be ignored while in manual 'online' mode.
      emitWindowEvent('offline')
      assert.equal(sockets[2].readyState, 1)

      // Backoff was reset on 'online': if socket fails now, delay starts at 3333.
      sockets[2].fail()
      assert.equal(scheduledDelays.at(-1), 3_333)
      const nextRetry = [...timers.values()][0]
      timers.clear()
      nextRetry()
      assert.equal(sockets.length, 5)
      sockets[4].fail()
      assert.equal(scheduledDelays.at(-1), 6_666)

      // Calling 'online' while a socket is waiting on backoff retries immediately
      // and resets backoff again without disturbing healthy clientB (sockets[3]).
      assert.equal(setRelayConnectivity('online'), 'online')
      assert.equal(timers.size, 0)
      assert.equal(sockets.length, 6)
      assert.equal(sockets[3].closeCalls, 0)
      sockets[5].fail()
      assert.equal(
        scheduledDelays.at(-1),
        3_333,
        'backoff must be reset by setRelayConnectivity("online") even if immediate retry fails'
      )

      // Transition to 'auto' re-attaches the browser online/offline watcher.
      assert.equal(setRelayConnectivity('auto'), 'auto')
      assert.equal(setRelayConnectivity(), 'auto')
      assert.equal(windowListeners.get('online')?.size, 1)
      assert.equal(windowListeners.get('offline')?.size, 1)

      // In 'auto' mode, an 'online' event acts as a hint to reset backoff and retry now.
      emitWindowEvent('online')
      assert.equal(timers.size, 0)
      assert.equal(sockets.length, 7)
      sockets[6].open()

      // In 'auto' mode, an 'offline' event closes sockets and holds reconnection
      // until 'online' (or setRelayConnectivity('online')).
      emitWindowEvent('offline')
      assert.equal(sockets[6].readyState, 3)
      assert.equal(sockets[3].readyState, 3)
      assert.equal(timers.size, 0)

      emitWindowEvent('online')
      assert.equal(sockets.length, 9)
      sockets[7].open()
      sockets[8].open()

      assert.throws(
        // @ts-expect-error invalid connectivity mode is rejected at runtime
        () => setRelayConnectivity('invalid'),
        /invalid relay connectivity mode/
      )
    } finally {
      clientA?.close()
      clientB?.close()
      setRelayConnectivity('auto')
      Math.random = realRandom
      globalThis.setTimeout = realSetTimeout
      globalThis.clearTimeout = realClearTimeout
      globalThis.WebSocket = realWebSocket
      globalThis.addEventListener = realAddEventListener
    }
  }
)
