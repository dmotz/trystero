// @ts-nocheck
import assert from 'node:assert/strict'
import test from 'node:test'
import createStrategy from '../../packages/core/src/strategy.ts'
import {makeSocket} from '../../packages/core/src/utils.ts'
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
  onnegotiationneeded = null
  onconnectionstatechange = null
  ontrack = null
  ondatachannel = null
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
    const nextDescription = description ?? (await this.createOffer())
    this.localDescription = nextDescription
    this.signalingState =
      nextDescription.type === 'offer' ? 'have-local-offer' : 'stable'
    this.listeners['icegatheringstatechange']?.forEach(listener => listener())
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
    this.sent.push(JSON.parse(data))
  }

  close() {
    this.readyState = 3
    this.onclose?.()
  }
}

class ManualWebSocket {
  static sockets = []

  readyState = 0
  sent = []
  onopen = null
  onclose = null
  onmessage = null
  url

  constructor(url) {
    this.url = url
    ManualWebSocket.sockets.push(this)
  }

  send(data) {
    this.sent.push(data)
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

void test(
  'Trystero: nostr re-sends batched subscriptions after relay socket reconnect',
  {timeout: 10_000},
  async () => {
    const originalWebSocket = globalThis.WebSocket

    globalThis.WebSocket = AutoOpenWebSocket
    AutoOpenWebSocket.sockets.length = 0

    const room = joinRoom(
      {
        appId: `nostr-resubscribe-${Date.now()}`,
        passive: true,
        relayConfig: {urls: ['wss://nostr-resubscribe.test']}
      },
      'room'
    )

    try {
      await waitFor(() =>
        AutoOpenWebSocket.sockets[0]?.sent.some(msg => msg[0] === 'REQ')
      )

      const firstSocket = AutoOpenWebSocket.sockets[0]
      firstSocket.close()

      await waitFor(() => AutoOpenWebSocket.sockets.length >= 2, 5_000)
      await wait(50)

      const secondSocket = AutoOpenWebSocket.sockets[1]
      const resentReqs = secondSocket.sent.filter(msg => msg[0] === 'REQ')

      assert.ok(
        resentReqs.length >= 1,
        'reconnected nostr socket should receive the existing batched REQ'
      )
    } finally {
      await room.leave().catch(() => {})
      globalThis.WebSocket = originalWebSocket
    }
  }
)

void test(
  'Trystero: relay announcements keep retrying after a rejected announce',
  {timeout: 10_000},
  async () => {
    const unhandledRejections = []
    const onUnhandledRejection = reason => {
      unhandledRejections.push(reason)
    }

    process.prependListener('unhandledRejection', onUnhandledRejection)

    let announceCalls = 0
    const joinRoom = createStrategy({
      init: () => ({}),
      subscribe: () => () => {},
      announce: async () => {
        announceCalls++

        if (announceCalls === 1) {
          throw new Error('transient announce failure')
        }
      }
    })

    const room = joinRoom(
      {
        appId: `announce-supervision-${Date.now()}`,
        rtcPolyfill: MockRTCPeerConnection
      },
      'room'
    )

    try {
      await waitFor(() => announceCalls >= 2, 1_000)
      assert.equal(
        unhandledRejections.length,
        0,
        'announce rejection should be supervised instead of escaping'
      )
    } finally {
      process.removeListener('unhandledRejection', onUnhandledRejection)
      await room.leave().catch(() => {})
    }
  }
)

void test(
  'Trystero: socket reconnect backoff stays capped',
  {timeout: 10_000},
  async () => {
    const originalWebSocket = globalThis.WebSocket
    const originalSetTimeout = globalThis.setTimeout
    const retryDelays = []

    globalThis.WebSocket = ManualWebSocket
    ManualWebSocket.sockets.length = 0
    globalThis.setTimeout = (fn, ms, ...args) => {
      retryDelays.push(ms)

      return originalSetTimeout(fn, 0, ...args)
    }

    try {
      const client = makeSocket('wss://socket-backoff.test', () => {})

      for (let i = 0; i < 16; i++) {
        const socket = ManualWebSocket.sockets.at(-1)
        socket.close()

        await waitFor(() => ManualWebSocket.sockets.length === i + 2)
      }

      assert.ok(client.socket)
      assert.ok(
        Math.max(...retryDelays) <= 60_000,
        `expected retry delay to stay capped at 60000ms, got ${Math.max(
          ...retryDelays
        )}ms`
      )
    } finally {
      globalThis.setTimeout = originalSetTimeout
      globalThis.WebSocket = originalWebSocket
    }
  }
)
