// @ts-nocheck
import assert from 'node:assert/strict'
import test from 'node:test'
import {joinRoom} from '../../packages/nostr/src/index.ts'

class MockDataChannel {
  readyState = 'connecting'
  binaryType = 'arraybuffer'
  bufferedAmountLowThreshold = 0
  onmessage = null
  onopen = null
  onclose = null
  onerror = null

  close() {
    this.readyState = 'closed'
    this.onclose?.()
  }

  send() {}
}

class MockRTCPeerConnection {
  iceGatheringState = 'complete'
  connectionState = 'new'
  iceConnectionState = 'new'
  signalingState = 'stable'
  localDescription = null
  onconnectionstatechange = null
  listeners = {}

  createDataChannel() {
    return new MockDataChannel()
  }

  addEventListener(event, fn) {
    ;(this.listeners[event] ??= new Set()).add(fn)
  }

  removeEventListener(event, fn) {
    this.listeners[event]?.delete(fn)
  }

  restartIce() {}

  async createOffer() {
    return {type: 'offer', sdp: `mock-offer-${Math.random()}`}
  }

  async setLocalDescription(description) {
    if (description?.type === 'rollback') {
      this.signalingState = 'stable'
      return
    }

    const next = description ?? (await this.createOffer())
    this.localDescription = next
    this.signalingState = next.type === 'offer' ? 'have-local-offer' : 'stable'
    this.listeners['icegatheringstatechange']?.forEach(fn => fn())
  }

  async setRemoteDescription() {
    this.signalingState = 'stable'
  }

  close() {
    this.connectionState = 'closed'
    this.iceConnectionState = 'closed'
    this.onconnectionstatechange?.()
  }

  getSenders() {
    return []
  }

  addTrack() {
    return {}
  }

  removeTrack() {}
}

void test(
  'Trystero/nostr: REQ frames are re-sent when the relay socket reconnects',
  {timeout: 10_000},
  async () => {
    const realWebSocket = globalThis.WebSocket
    const realSetTimeout = globalThis.setTimeout
    const tick = (ms = 0) => new Promise(res => realSetTimeout(res, ms))

    const sockets = []
    let allowClose = true
    const stubbedTimers = []

    class ControlledSocket {
      url = ''
      readyState = 0
      onopen = null
      onclose = null
      onmessage = null
      sent = []

      constructor(url) {
        this.url = url
        sockets.push(this)
      }

      open() {
        this.readyState = 1
        this.onopen?.()
      }

      triggerClose() {
        if (!allowClose) {
          return
        }

        this.readyState = 3
        this.onclose?.()
      }

      send(data) {
        this.sent.push(data)
      }

      close() {
        this.triggerClose()
      }
    }

    // makeSocket has no injection seam for WebSocket or its retry timer; the
    // setTimeout shim queues every timer so the jittered reconnect and batched
    // flushBatch (scheduled with setTimeout(0)) can be fired on demand.
    globalThis.WebSocket = ControlledSocket
    globalThis.setTimeout = fn => {
      stubbedTimers.push(fn)
      return stubbedTimers.length - 1
    }

    const drainTimers = (limit = 100) => {
      let count = 0

      while (stubbedTimers.length > 0 && count < limit) {
        const fn = stubbedTimers.shift()

        try {
          fn?.()
        } catch {
          // ignore — announce loops may throw without a real relay
        }

        count += 1
      }
    }

    const isReqFrame = frame =>
      typeof frame === 'string' && frame.startsWith('["REQ"')

    let room
    try {
      room = joinRoom(
        {
          appId: `trystero-nostr-resubscribe-${Date.now()}`,
          password: 'resubscribe-test',
          relayConfig: {urls: [`ws://test-nostr-${Date.now()}`], redundancy: 1},
          rtcPolyfill: MockRTCPeerConnection
        },
        'r'
      )

      await tick(0)
      assert.equal(sockets.length, 1, 'expected one socket to be created')

      const first = sockets[0]
      first.open()
      // Let the subscribe chain resolve and queue the batched flushBatch.
      await tick(50)
      drainTimers()
      await tick(50)

      const reqOnFirst = first.sent.filter(isReqFrame)
      assert.ok(
        reqOnFirst.length >= 1,
        `expected at least one batched REQ frame on initial socket, got ${reqOnFirst.length}`
      )

      first.triggerClose()
      await tick(0)

      assert.ok(
        stubbedTimers.length > 0,
        'expected a reconnect to be scheduled after the socket closed'
      )
      drainTimers()
      await tick(50)

      assert.equal(
        sockets.length,
        2,
        'expected the retry to create a new socket'
      )

      const second = sockets[1]
      second.open()
      await tick(50)
      drainTimers()
      await tick(50)

      const reqOnSecond = second.sent.filter(isReqFrame)
      assert.ok(
        reqOnSecond.length >= 1,
        `BUG: expected at least one batched REQ frame to be re-sent on reconnect, but got ${reqOnSecond.length}`
      )
    } finally {
      allowClose = false
      globalThis.WebSocket = realWebSocket
      globalThis.setTimeout = realSetTimeout

      if (room) {
        await room.leave()
      }
    }
  }
)
