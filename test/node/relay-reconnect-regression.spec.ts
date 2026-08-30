// @ts-nocheck
import assert from 'node:assert/strict'
import test from 'node:test'
import createStrategy from '../../packages/core/src/strategy.ts'
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
  'Trystero: relay announcements can stop after a terminal failure',
  {timeout: 5_000},
  async () => {
    let announceCalls = 0
    const joinRoom = createStrategy({
      init: () => ({}),
      subscribe: () => () => {},
      announce: () => {
        announceCalls++
        return {stopAnnouncing: true}
      }
    })
    const room = joinRoom(
      {
        appId: `announce-stop-${Date.now()}`,
        rtcPolyfill: MockRTCPeerConnection
      },
      'room'
    )

    try {
      await waitFor(() => announceCalls === 1)
      await wait(300)
      assert.equal(announceCalls, 1)
    } finally {
      await room.leave().catch(() => {})
    }
  }
)
