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

class MockWebSocket {
  static sockets = []
  static rateLimitAnnouncements = false
  static rejectAnnouncements = false

  readyState = 0
  sent = []
  onopen = null
  onclose = null
  onmessage = null
  url

  constructor(url) {
    this.url = url
    MockWebSocket.sockets.push(this)

    queueMicrotask(() => {
      this.readyState = 1
      this.onopen?.()
    })
  }

  send(data) {
    const msg = JSON.parse(data)
    this.sent.push(msg)

    if (
      (MockWebSocket.rateLimitAnnouncements ||
        MockWebSocket.rejectAnnouncements) &&
      msg[0] === 'EVENT'
    ) {
      const payload = JSON.parse(msg[1].content)

      if (
        payload.peerId &&
        !payload.offer &&
        !payload.answer &&
        !payload.candidate
      ) {
        queueMicrotask(() =>
          this.onmessage?.({
            data: JSON.stringify([
              'OK',
              msg[1].id,
              false,
              MockWebSocket.rateLimitAnnouncements
                ? 'rate-limited: test cooldown'
                : 'blocked: event kind not accepted'
            ])
          })
        )
      }
    }
  }

  close() {
    this.readyState = 3
    this.onclose?.()
  }
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const waitFor = async (
  check: () => boolean,
  timeoutMs = 2_000,
  sleep: (ms: number) => Promise<void> = wait
): Promise<void> => {
  const startedAt = Date.now()

  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('timed out waiting for condition')
    }

    await sleep(10)
  }
}

const announcementCount = (socket: MockWebSocket): number =>
  socket.sent.filter(msg => {
    if (msg[0] !== 'EVENT') {
      return false
    }

    const payload = JSON.parse(msg[1].content)

    return (
      payload.peerId && !payload.offer && !payload.answer && !payload.candidate
    )
  }).length

const joinTestRoom = (url: string) =>
  joinRoom(
    {
      appId: `nostr-announcement-rate-${Date.now()}-${Math.random()}`,
      relayConfig: {urls: [url], warnOnRelayFailure: false},
      rtcPolyfill: MockRTCPeerConnection
    },
    'room'
  )

void test(
  'Trystero: nostr writes its batched subscription before its first announcement',
  {timeout: 5_000},
  async () => {
    const originalWebSocket = globalThis.WebSocket
    const originalSetTimeout = globalThis.setTimeout
    const heldZeroDelayTimers = []
    const nativeWait = ms =>
      new Promise(resolve => originalSetTimeout(resolve, ms))

    MockWebSocket.sockets.length = 0
    MockWebSocket.rateLimitAnnouncements = false
    globalThis.WebSocket = MockWebSocket
    globalThis.setTimeout = (fn, delay, ...args) => {
      if (delay === 0) {
        heldZeroDelayTimers.push(() => fn(...args))
        return {heldZeroDelayTimer: heldZeroDelayTimers.length}
      }

      return originalSetTimeout(fn, delay, ...args)
    }

    const room = joinTestRoom(
      `wss://nostr-subscription-order-${Date.now()}.test`
    )

    try {
      const socket = MockWebSocket.sockets[0]
      const publishWonRace = await Promise.race([
        waitFor(() => announcementCount(socket) > 0, 1_000, nativeWait).then(
          () => true
        ),
        nativeWait(250).then(() => false)
      ])

      assert.equal(
        publishWonRace,
        false,
        'announcement must wait while the subscription batch is unflushed'
      )

      heldZeroDelayTimers.splice(0).forEach(run => run())
      await waitFor(() => announcementCount(socket) > 0, 2_000, nativeWait)

      const firstReqIndex = socket.sent.findIndex(msg => msg[0] === 'REQ')
      const firstAnnouncementIndex = socket.sent.findIndex(msg => {
        if (msg[0] !== 'EVENT') {
          return false
        }

        const payload = JSON.parse(msg[1].content)
        return payload.peerId && !payload.offer && !payload.answer
      })

      assert.ok(firstReqIndex >= 0)
      assert.ok(firstReqIndex < firstAnnouncementIndex)
      assert.equal(
        socket.sent[firstReqIndex][2]['#x'].length,
        2,
        'self and root topics should remain in one batched subscription'
      )
    } finally {
      heldZeroDelayTimers.splice(0).forEach(run => run())
      globalThis.setTimeout = originalSetTimeout
      await room.leave().catch(() => {})
      globalThis.WebSocket = originalWebSocket
    }
  }
)

void test(
  'Trystero: nostr keeps the fast announcement warmup but slows steady state',
  {timeout: 12_000},
  async () => {
    const originalWebSocket = globalThis.WebSocket
    MockWebSocket.sockets.length = 0
    MockWebSocket.rateLimitAnnouncements = false
    globalThis.WebSocket = MockWebSocket

    const room = joinTestRoom(`wss://nostr-healthy-${Date.now()}.test`)

    try {
      await wait(2_500)
      const socket = MockWebSocket.sockets[0]

      assert.equal(
        announcementCount(socket),
        4,
        'the startup burst should remain unchanged'
      )

      await wait(5_500)
      assert.equal(
        announcementCount(socket),
        4,
        'steady announcements should no longer fire every 5.333 seconds'
      )
    } finally {
      await room.leave().catch(() => {})
      globalThis.WebSocket = originalWebSocket
    }
  }
)

void test(
  'Trystero: nostr rate-limit feedback cools down only that relay',
  {timeout: 5_000},
  async () => {
    const originalWebSocket = globalThis.WebSocket
    MockWebSocket.sockets.length = 0
    MockWebSocket.rateLimitAnnouncements = true
    globalThis.WebSocket = MockWebSocket

    const room = joinTestRoom(`wss://nostr-rate-limited-${Date.now()}.test`)

    try {
      await wait(2_500)

      assert.equal(
        announcementCount(MockWebSocket.sockets[0]),
        1,
        'rate-limited relay should suppress the rest of the startup burst'
      )
    } finally {
      await room.leave().catch(() => {})
      globalThis.WebSocket = originalWebSocket
    }
  }
)

void test(
  'Trystero: nostr rejection feedback suppresses the rest of the startup burst',
  {timeout: 5_000},
  async () => {
    const originalWebSocket = globalThis.WebSocket
    MockWebSocket.sockets.length = 0
    MockWebSocket.rateLimitAnnouncements = false
    MockWebSocket.rejectAnnouncements = true
    globalThis.WebSocket = MockWebSocket

    const room = joinTestRoom(`wss://nostr-rejecting-${Date.now()}.test`)

    try {
      await wait(2_500)

      assert.equal(
        announcementCount(MockWebSocket.sockets[0]),
        1,
        'rejecting relay should suppress the rest of the startup burst'
      )
    } finally {
      await room.leave().catch(() => {})
      MockWebSocket.rejectAnnouncements = false
      globalThis.WebSocket = originalWebSocket
    }
  }
)

void test(
  'Trystero: nostr missing acknowledgement does not suppress retry room startup',
  {timeout: 12_000},
  async () => {
    const originalWebSocket = globalThis.WebSocket
    MockWebSocket.sockets.length = 0
    MockWebSocket.rateLimitAnnouncements = false
    globalThis.WebSocket = MockWebSocket

    const url = `wss://nostr-missing-ack-${Date.now()}.test`
    const firstRoom = joinTestRoom(url)

    try {
      await wait(8_000)
      await firstRoom.leave()

      const socket = MockWebSocket.sockets[0]
      const previousCount = announcementCount(socket)
      const retryRoom = joinTestRoom(url)

      try {
        await waitFor(() => announcementCount(socket) > previousCount)
      } finally {
        await retryRoom.leave().catch(() => {})
      }
    } finally {
      await firstRoom.leave().catch(() => {})
      globalThis.WebSocket = originalWebSocket
    }
  }
)
