// @ts-nocheck
import assert from 'node:assert/strict'
import test from 'node:test'
import {encrypt, genKey} from '../../packages/core/src/crypto.ts'
import createStrategy from '../../packages/core/src/strategy.ts'

type Subscriber = {
  rootTopic: string
  selfTopic: string
  onMessage: (
    topic: string,
    msg: unknown,
    signalPeer: (peerTopic: string, signal: string) => void
  ) => Promise<void> | void
}

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
    if (description?.type === 'rollback') {
      this.signalingState = 'stable'
      return
    }

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

class MockPeer {
  created = Date.now()
  isDead = false
  destroyCount = 0
  handlers = {}
  offerPromise = Promise.resolve()
  connection = {
    connectionState: 'connected',
    iceConnectionState: 'connected',
    getSenders: () => []
  }
  channel = {readyState: 'open'}

  async getOffer() {}

  async signal() {
    this.handlers.connect?.()
  }

  sendData() {}

  destroy() {
    if (this.isDead) {
      return
    }

    this.isDead = true
    this.destroyCount += 1
    this.connection.connectionState = 'closed'
    this.connection.iceConnectionState = 'closed'
    this.handlers.close?.()
  }

  setHandlers(newHandlers) {
    Object.assign(this.handlers, newHandlers)
  }

  addStream() {}
  removeStream() {}
  addTrack() {
    return {}
  }
  removeTrack() {}
  replaceTrack() {}
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
  'Trystero: joining 1000 passive rooms uses minimal resources',
  {timeout: 120_000},
  async () => {
    const roomCount = 1_000
    let announceCount = 0
    let subscribeCount = 0
    const subscribers: Subscriber[] = []

    const joinRoom = createStrategy({
      init: () => ({}),
      subscribe: async (_relay, rootTopic, selfTopic, onMessage) => {
        subscribeCount++
        subscribers.push({rootTopic, selfTopic, onMessage})
        return () => {}
      },
      announce: () => {
        announceCount++
      }
    })

    const appId = `scale-passive-${Date.now()}`
    const config = {
      appId,
      passive: true,
      rtcPolyfill: MockRTCPeerConnection
    }

    const memBefore = process.memoryUsage()
    const timeBefore = performance.now()

    const rooms = []
    for (let i = 0; i < roomCount; i++) {
      rooms.push(joinRoom(config, `room-${i}`))
    }

    // Wait for all subscriptions to be set up (each room hashes 2 topics
    // asynchronously, so this can take a while for 1000 rooms)
    await waitFor(() => subscribers.length >= roomCount, 60_000)

    const readyTimeMs = performance.now() - timeBefore
    const memAfter = process.memoryUsage()
    const heapGrowthMb =
      (memAfter.heapUsed - memBefore.heapUsed) / (1024 * 1024)

    // Allow subscriptions to settle
    await wait(500)

    console.log(`  ready time: ${readyTimeMs.toFixed(0)}ms for ${roomCount} rooms`)
    console.log(`  heap growth: ${heapGrowthMb.toFixed(1)}MB`)
    console.log(`  subscriptions: ${subscribeCount}`)
    console.log(`  announces: ${announceCount}`)

    // Passive rooms should not have announced at all
    assert.equal(
      announceCount,
      0,
      'passive rooms should not announce while dormant'
    )

    // Each room creates one subscription per relay (1 relay here)
    assert.equal(
      subscribeCount,
      roomCount,
      `expected ${roomCount} subscriptions`
    )

    // Sanity: all rooms report as passive
    assert.ok(
      rooms.every(r => r.isPassive()),
      'all rooms should be passive'
    )

    // All rooms should be ready (subscribed) within 60 seconds
    assert.ok(
      readyTimeMs < 60_000,
      `${roomCount} rooms took ${readyTimeMs.toFixed(0)}ms to be ready, expected < 60000ms`
    )

    // Heap growth should stay reasonable (< 200MB for 1000 rooms)
    assert.ok(
      heapGrowthMb < 200,
      `heap grew by ${heapGrowthMb.toFixed(1)}MB, expected < 200MB`
    )

    // Clean up
    for (const room of rooms) {
      await room.leave().catch(() => {})
    }
  }
)

void test(
  'Trystero: 1000 passive rooms share a single connection per peer',
  {timeout: 120_000},
  async () => {
    const roomCount = 1_000
    const subscribers: Subscriber[] = []

    // Count RTCPeerConnection instantiations to verify connection sharing
    let rtcCreated = 0
    class CountingRTCPeerConnection extends MockRTCPeerConnection {
      constructor(...args) {
        super(...args)
        rtcCreated++
      }
    }

    const joinRoom = createStrategy({
      init: () => ({}),
      subscribe: async (_relay, rootTopic, selfTopic, onMessage) => {
        subscribers.push({rootTopic, selfTopic, onMessage})
        return () => {}
      },
      announce: () => {}
    })

    const appId = `scale-shared-${Date.now()}`
    const config = {
      appId,
      passive: true,
      rtcPolyfill: CountingRTCPeerConnection
    }

    const rooms = []
    for (let i = 0; i < roomCount; i++) {
      rooms.push(joinRoom(config, `room-${i}`))
    }

    await waitFor(() => subscribers.length >= roomCount, 60_000)

    const rtcBeforeConnect = rtcCreated

    // Activate room-0 and connect a mock peer
    const sub0 = subscribers[0]
    await sub0.onMessage(
      sub0.rootTopic,
      {peerId: 'active-peer'},
      () => {}
    )

    const mockPeer = new MockPeer()
    const encryptedAnswer = await encrypt(
      genKey('', appId, 'room-0'),
      'answer-sdp'
    )

    await sub0.onMessage(
      sub0.rootTopic,
      {peerId: 'active-peer', answer: encryptedAnswer, peer: mockPeer},
      () => {}
    )

    await wait(100)

    const rtcAfterFirstConnect = rtcCreated

    // Now send announcements from the same peer to all other rooms.
    // The shared peer manager should reuse the existing WebRTC connection
    // rather than creating new ones.
    for (let i = 1; i < roomCount; i++) {
      const sub = subscribers[i]
      await sub.onMessage(
        sub.rootTopic,
        {peerId: 'active-peer'},
        () => {}
      )
    }

    await wait(500)

    const rtcAfterAllRooms = rtcCreated

    // The mock peer should not have been destroyed/recreated
    assert.equal(
      mockPeer.destroyCount,
      0,
      'shared peer should not be destroyed when reused across rooms'
    )

    // No additional RTCPeerConnections should be created when reusing the
    // shared peer across rooms 1-999
    assert.equal(
      rtcAfterAllRooms - rtcAfterFirstConnect,
      0,
      `expected 0 new RTCPeerConnections for rooms 1-999, ` +
        `got ${rtcAfterAllRooms - rtcAfterFirstConnect}`
    )

    console.log(
      `  ${roomCount} rooms, ` +
        `${rtcAfterFirstConnect - rtcBeforeConnect} RTC connection(s) for first room, ` +
        `${rtcAfterAllRooms - rtcAfterFirstConnect} additional for remaining ${roomCount - 1} rooms`
    )

    // Clean up
    for (const room of rooms) {
      await room.leave().catch(() => {})
    }
  }
)

void test(
  'Trystero: activating one passive room does not activate all passive rooms',
  {timeout: 120_000},
  async () => {
    const roomCount = 100
    const announcePayloads: Map<string, number> = new Map()
    const subscribers: Subscriber[] = []

    const joinRoom = createStrategy({
      init: () => ({}),
      subscribe: async (_relay, rootTopic, selfTopic, onMessage) => {
        subscribers.push({rootTopic, selfTopic, onMessage})
        return () => {}
      },
      announce: (_relay, rootTopic) => {
        announcePayloads.set(
          rootTopic,
          (announcePayloads.get(rootTopic) ?? 0) + 1
        )
      }
    })

    const appId = `scale-selective-activation-${Date.now()}`
    const config = {
      appId,
      passive: true,
      rtcPolyfill: MockRTCPeerConnection
    }

    const rooms = []
    for (let i = 0; i < roomCount; i++) {
      rooms.push(joinRoom(config, `room-${i}`))
    }

    await waitFor(() => subscribers.length >= roomCount, 60_000)

    // Activate only room-0 by sending it an announcement
    const sub0 = subscribers[0]
    await sub0.onMessage(
      sub0.rootTopic,
      {peerId: 'active-peer'},
      () => {}
    )

    await waitFor(() => announcePayloads.size > 0, 5_000)
    await wait(300)

    // Only room-0's topic should have announced
    assert.equal(
      announcePayloads.size,
      1,
      `expected 1 topic to announce, got ${announcePayloads.size}`
    )
    assert.ok(
      announcePayloads.has(sub0.rootTopic),
      'only the activated room should announce'
    )

    console.log(
      `  activated 1 of ${roomCount} rooms, ` +
        `${announcePayloads.size} topic(s) announced`
    )

    // Clean up
    for (const room of rooms) {
      await room.leave().catch(() => {})
    }
  }
)

void test(
  'Trystero: leaving 1000 passive rooms cleans up without leaks',
  {timeout: 120_000},
  async () => {
    const roomCount = 1_000
    const subscribers: Subscriber[] = []
    const unsubCalls: (() => void)[] = []

    const joinRoom = createStrategy({
      init: () => ({}),
      subscribe: async (_relay, rootTopic, selfTopic, onMessage) => {
        subscribers.push({rootTopic, selfTopic, onMessage})
        const unsub = () => {
          unsubCalls.push(unsub)
        }
        return unsub
      },
      announce: () => {}
    })

    const appId = `scale-cleanup-${Date.now()}`
    const config = {
      appId,
      passive: true,
      rtcPolyfill: MockRTCPeerConnection
    }

    const rooms = []
    for (let i = 0; i < roomCount; i++) {
      rooms.push(joinRoom(config, `room-${i}`))
    }

    await waitFor(() => subscribers.length >= roomCount, 60_000)

    const memBeforeLeave = process.memoryUsage().heapUsed

    // Leave all rooms
    const leaveStart = performance.now()
    await Promise.all(rooms.map(r => r.leave().catch(() => {})))
    const leaveTimeMs = performance.now() - leaveStart

    // Force GC if available
    if (global.gc) {
      global.gc()
      await wait(100)
    }

    const memAfterLeave = process.memoryUsage().heapUsed
    const freedMb = (memBeforeLeave - memAfterLeave) / (1024 * 1024)

    console.log(`  leave time: ${leaveTimeMs.toFixed(0)}ms for ${roomCount} rooms`)
    console.log(`  memory freed: ${freedMb.toFixed(1)}MB`)
    console.log(`  unsub calls: ${unsubCalls.length}`)

    // All subscriptions should have been cleaned up
    assert.equal(
      unsubCalls.length,
      roomCount,
      `expected ${roomCount} unsub calls, got ${unsubCalls.length}`
    )

    // Leaving should be fast
    assert.ok(
      leaveTimeMs < 10_000,
      `leaving ${roomCount} rooms took ${leaveTimeMs.toFixed(0)}ms, expected < 10000ms`
    )

    // Should be able to join fresh rooms after full cleanup
    const freshRoom = joinRoom(config, 'fresh-room')
    assert.equal(freshRoom.isPassive(), true)
    await freshRoom.leave().catch(() => {})
  }
)
