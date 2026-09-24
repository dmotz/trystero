// @ts-nocheck
import assert from 'node:assert/strict'
import test from 'node:test'
import {makeSocket} from '../../packages/core/src/utils.ts'

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
      globalThis.setTimeout = (fn, delay) => {
        scheduledDelays.push(delay)
        pendingInit = fn
        return 0
      }
      globalThis.WebSocket = FailingSocket

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

    try {
      globalThis.setTimeout = fn => {
        pendingInit = fn
        return 0
      }
      globalThis.WebSocket = ControlledSocket

      const client = makeSocket(`ws://test-ready-${Date.now()}`, () => {})
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
      globalThis.setTimeout = realSetTimeout
      globalThis.WebSocket = realWebSocket
    }
  }
)
