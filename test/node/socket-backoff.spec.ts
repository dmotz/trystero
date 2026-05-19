// @ts-nocheck
import assert from 'node:assert/strict'
import test from 'node:test'
import {makeSocket} from '../../packages/core/src/utils.ts'

const tick = () => Promise.resolve()

void test(
  'Trystero: socket reconnect backoff is capped at a sane maximum',
  {timeout: 5_000},
  async () => {
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
      globalThis.setTimeout = (fn, delay) => {
        scheduledDelays.push(delay)
        pendingInit = fn
        return 0
      }
      globalThis.WebSocket = FailingSocket

      makeSocket(`ws://test-backoff-${Date.now()}`, () => {})

      for (let i = 0; i < 15; i += 1) {
        await tick()
        assert.ok(
          pendingInit,
          `expected a retry to be scheduled after attempt ${i + 1}`
        )

        const next = pendingInit
        pendingInit = null
        next()
      }

      const maxDelay = Math.max(...scheduledDelays)
      assert.ok(
        maxDelay <= 60_000,
        `expected reconnect delay to be capped at 60s, but max was ${maxDelay}ms`
      )
    } finally {
      allowClose = false
      globalThis.setTimeout = realSetTimeout
      globalThis.WebSocket = realWebSocket
    }
  }
)
