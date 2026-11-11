import assert from 'node:assert/strict'
import test from './test.ts'
import {joinRoom} from '../../packages/nostr/src/index.ts'

type SdpInit = {type: string; sdp?: string}

class MockDataChannel {
  readyState = 'connecting'
  binaryType = 'arraybuffer'
  bufferedAmountLowThreshold = 0
  onmessage: ((event: {data: unknown}) => void) | null = null
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((event: unknown) => void) | null = null

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
  localDescription: SdpInit | null = null
  onconnectionstatechange: (() => void) | null = null
  listeners: Record<string, Set<() => void>> = {}

  createDataChannel() {
    return new MockDataChannel()
  }

  addEventListener(event: string, fn: () => void) {
    ;(this.listeners[event] ??= new Set()).add(fn)
  }

  removeEventListener(event: string, fn: () => void) {
    this.listeners[event]?.delete(fn)
  }

  restartIce() {}

  async createOffer() {
    return {type: 'offer', sdp: `mock-offer-${Math.random()}`}
  }

  async setLocalDescription(description?: SdpInit) {
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

    const sockets: ControlledSocket[] = []
    let allowClose = true
    const stubbedTimers: Array<() => void> = []

    class ControlledSocket {
      url = ''
      readyState = 0
      onopen: (() => void) | null = null
      onclose: (() => void) | null = null
      onmessage: ((event: {data: string}) => void) | null = null
      sent: string[] = []

      constructor(url: string) {
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

      send(data: string) {
        this.sent.push(data)
      }

      close() {
        this.triggerClose()
      }
    }

    // makeSocket has no injection seam for WebSocket or its retry timer; the
    // setTimeout shim queues every timer so the jittered reconnect and batched
    // flushBatch (scheduled with setTimeout(0)) can be fired on demand.
    globalThis.WebSocket = ControlledSocket as unknown as typeof WebSocket
    globalThis.setTimeout = ((fn: () => void) => {
      stubbedTimers.push(fn)
      return stubbedTimers.length - 1
    }) as unknown as typeof setTimeout

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

    const isReqFrame = (frame: unknown): frame is string =>
      typeof frame === 'string' && frame.startsWith('["REQ"')

    const waitForSocketFrame = async (
      socket: ControlledSocket,
      predicate: (frame: string) => boolean,
      timeoutMs = 5_000
    ): Promise<void> => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        drainTimers()
        if (socket.sent.some(predicate)) {
          return
        }
        await tick(10)
      }
      drainTimers()
    }

    let room: ReturnType<typeof joinRoom> | undefined
    try {
      room = joinRoom(
        {
          appId: `trystero-nostr-resubscribe-${Date.now()}`,
          password: 'resubscribe-test',
          relayConfig: {urls: [`ws://test-nostr-${Date.now()}`], redundancy: 1},
          rtcPolyfill:
            MockRTCPeerConnection as unknown as typeof RTCPeerConnection
        },
        'r'
      )

      await tick(0)
      assert.equal(sockets.length, 1, 'expected one socket to be created')

      const first = sockets[0]!
      first.open()
      // Let the subscribe chain resolve and queue the batched flushBatch.
      await waitForSocketFrame(first, isReqFrame)

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
      await tick(20)

      assert.equal(
        sockets.length,
        2,
        'expected the retry to create a new socket'
      )

      const second = sockets[1]!
      second.open()
      await waitForSocketFrame(second, frame => frame.startsWith('["EVENT"'))

      const reqOnSecond = second.sent.filter(isReqFrame)
      assert.ok(
        second.sent.some(frame => frame.startsWith('["EVENT"')),
        'restoring subscriptions must also replay room discovery'
      )
      assert.ok(
        second.sent.findIndex(isReqFrame) <
          second.sent.findIndex(frame => frame.startsWith('["EVENT"'))
      )
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
