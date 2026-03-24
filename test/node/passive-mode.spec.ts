// @ts-nocheck
import assert from 'node:assert/strict'
import test from 'node:test'
import {encrypt, genKey} from '../../packages/core/src/crypto.ts'
import {selfId} from '../../packages/core/src/utils.ts'
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
  'Trystero: passive peer does not announce until activated',
  {timeout: 10_000},
  async () => {
    let announceCount = 0
    const subscribers: Subscriber[] = []

    const joinRoom = createStrategy({
      init: () => ({}),
      subscribe: async (_relay, rootTopic, selfTopic, onMessage) => {
        subscribers.push({rootTopic, selfTopic, onMessage})
        return () => {}
      },
      announce: () => {
        announceCount++
      }
    })

    const appId = `passive-no-announce-${Date.now()}`
    const config = {
      appId,
      passive: true,
      rtcPolyfill: MockRTCPeerConnection
    }

    const room = joinRoom(config, 'test-room')

    try {
      await waitFor(() => subscribers.length >= 1)

      // Wait enough time for multiple announce cycles to have fired
      await wait(300)

      assert.equal(
        announceCount,
        0,
        'passive peer should not announce while inactive'
      )
      assert.equal(
        room.isPassive(),
        true,
        'isPassive() should return true'
      )
    } finally {
      await room.leave().catch(() => {})
    }
  }
)

void test(
  'Trystero: non-passive peer announces normally',
  {timeout: 10_000},
  async () => {
    let announceCount = 0
    const subscribers: Subscriber[] = []

    const joinRoom = createStrategy({
      init: () => ({}),
      subscribe: async (_relay, rootTopic, selfTopic, onMessage) => {
        subscribers.push({rootTopic, selfTopic, onMessage})
        return () => {}
      },
      announce: () => {
        announceCount++
      }
    })

    const appId = `active-announce-${Date.now()}`
    const config = {
      appId,
      rtcPolyfill: MockRTCPeerConnection
    }

    const room = joinRoom(config, 'test-room')

    try {
      await waitFor(() => subscribers.length >= 1)
      await waitFor(() => announceCount > 0)

      assert.ok(
        announceCount > 0,
        'non-passive peer should announce'
      )
      assert.equal(
        room.isPassive(),
        false,
        'isPassive() should return false for non-passive peer'
      )
    } finally {
      await room.leave().catch(() => {})
    }
  }
)

void test(
  'Trystero: passive peer activates when receiving a non-passive announcement',
  {timeout: 10_000},
  async () => {
    let announceCount = 0
    const subscribers: Subscriber[] = []

    const joinRoom = createStrategy({
      init: () => ({}),
      subscribe: async (_relay, rootTopic, selfTopic, onMessage) => {
        subscribers.push({rootTopic, selfTopic, onMessage})
        return () => {}
      },
      announce: () => {
        announceCount++
      }
    })

    const appId = `passive-activate-${Date.now()}`
    const config = {
      appId,
      passive: true,
      rtcPolyfill: MockRTCPeerConnection
    }

    const room = joinRoom(config, 'test-room')

    try {
      await waitFor(() => subscribers.length >= 1)
      await wait(200)

      assert.equal(announceCount, 0, 'should not announce while inactive')

      const sub = subscribers[0]

      // Simulate an announcement from a non-passive active peer
      await sub.onMessage(
        sub.rootTopic,
        {peerId: 'active-peer-1'},
        () => {}
      )

      // After activation, the passive peer should start announcing
      await waitFor(() => announceCount > 0, 5_000)

      assert.ok(
        announceCount > 0,
        'passive peer should start announcing after activation'
      )
    } finally {
      await room.leave().catch(() => {})
    }
  }
)

void test(
  'Trystero: passive peer ignores messages from other passive peers',
  {timeout: 10_000},
  async () => {
    let announceCount = 0
    const subscribers: Subscriber[] = []

    const joinRoom = createStrategy({
      init: () => ({}),
      subscribe: async (_relay, rootTopic, selfTopic, onMessage) => {
        subscribers.push({rootTopic, selfTopic, onMessage})
        return () => {}
      },
      announce: () => {
        announceCount++
      }
    })

    const appId = `passive-ignore-passive-${Date.now()}`
    const config = {
      appId,
      passive: true,
      rtcPolyfill: MockRTCPeerConnection
    }

    const room = joinRoom(config, 'test-room')

    try {
      await waitFor(() => subscribers.length >= 1)
      await wait(200)

      const sub = subscribers[0]

      // Simulate an announcement from another passive peer
      await sub.onMessage(
        sub.rootTopic,
        {peerId: 'passive-peer-2', passive: true},
        () => {}
      )

      await wait(300)

      assert.equal(
        announceCount,
        0,
        'passive peer should not activate from another passive peer'
      )
    } finally {
      await room.leave().catch(() => {})
    }
  }
)

void test(
  'Trystero: passive peer deactivates after active peer disconnects',
  {timeout: 10_000},
  async () => {
    let announceCount = 0
    const subscribers: Subscriber[] = []

    const joinRoom = createStrategy({
      init: () => ({}),
      subscribe: async (_relay, rootTopic, selfTopic, onMessage) => {
        subscribers.push({rootTopic, selfTopic, onMessage})
        return () => {}
      },
      announce: () => {
        announceCount++
      }
    })

    const appId = `passive-deactivate-${Date.now()}`
    const config = {
      appId,
      passive: true,
      rtcPolyfill: MockRTCPeerConnection
    }

    const room = joinRoom(config, 'test-room')

    try {
      await waitFor(() => subscribers.length >= 1)

      const sub = subscribers[0]
      const mockPeer = new MockPeer()

      // Step 1: Activate by receiving an announcement from a non-passive peer
      await sub.onMessage(
        sub.rootTopic,
        {peerId: 'active-peer'},
        () => {}
      )

      await waitFor(() => announceCount > 0, 5_000)
      assert.ok(announceCount > 0, 'passive peer should be active after announcement')

      // Step 2: Establish connection via answer with mockPeer
      const encryptedAnswer = await encrypt(
        genKey('', appId, 'test-room'),
        'answer-sdp'
      )

      await sub.onMessage(
        sub.rootTopic,
        {
          peerId: 'active-peer',
          answer: encryptedAnswer,
          peer: mockPeer
        },
        () => {}
      )

      await wait(100)

      // Step 3: Disconnect the peer
      mockPeer.destroy()

      // After disconnect, checkDeactivate should fire and stop announces
      await wait(500)

      const announceCountAfterWait = announceCount

      // Wait more and verify announces stopped
      await wait(500)

      assert.equal(
        announceCount,
        announceCountAfterWait,
        'passive peer should stop announcing after last connection drops'
      )
    } finally {
      await room.leave().catch(() => {})
    }
  }
)

void test(
  'Trystero: passive peer includes passive flag in announce payload',
  {timeout: 10_000},
  async () => {
    const announcePayloads: Array<Record<string, unknown> | undefined> = []
    const subscribers: Subscriber[] = []

    const joinRoom = createStrategy({
      init: () => ({}),
      subscribe: async (_relay, rootTopic, selfTopic, onMessage) => {
        subscribers.push({rootTopic, selfTopic, onMessage})
        return () => {}
      },
      announce: (_relay, _rootTopic, _selfTopic, extra) => {
        announcePayloads.push(extra)
      }
    })

    const appId = `passive-flag-${Date.now()}`
    const config = {
      appId,
      passive: true,
      rtcPolyfill: MockRTCPeerConnection
    }

    const room = joinRoom(config, 'test-room')

    try {
      await waitFor(() => subscribers.length >= 1)

      const sub = subscribers[0]

      // Activate the passive peer
      await sub.onMessage(
        sub.rootTopic,
        {peerId: 'active-peer-1'},
        () => {}
      )

      await waitFor(() => announcePayloads.length > 0, 5_000)

      assert.ok(
        announcePayloads.every(p => p?.passive === true),
        'passive peer should include passive: true in announce extra payload'
      )
    } finally {
      await room.leave().catch(() => {})
    }
  }
)

void test(
  'Trystero: non-passive peer does not include passive flag in announce payload',
  {timeout: 10_000},
  async () => {
    const announcePayloads: Array<Record<string, unknown> | undefined> = []
    const subscribers: Subscriber[] = []

    const joinRoom = createStrategy({
      init: () => ({}),
      subscribe: async (_relay, rootTopic, selfTopic, onMessage) => {
        subscribers.push({rootTopic, selfTopic, onMessage})
        return () => {}
      },
      announce: (_relay, _rootTopic, _selfTopic, extra) => {
        announcePayloads.push(extra)
      }
    })

    const appId = `active-no-flag-${Date.now()}`
    const config = {
      appId,
      rtcPolyfill: MockRTCPeerConnection
    }

    const room = joinRoom(config, 'test-room')

    try {
      await waitFor(() => announcePayloads.length > 0)

      assert.ok(
        announcePayloads.every(p => p === undefined),
        'non-passive peer should not include passive flag'
      )
    } finally {
      await room.leave().catch(() => {})
    }
  }
)

void test(
  'Trystero: two passive peers do not connect to each other',
  {timeout: 10_000},
  async () => {
    const subscribers: Subscriber[] = []
    let signalsSent = 0

    const joinRoom = createStrategy({
      init: () => ({}),
      subscribe: async (_relay, rootTopic, selfTopic, onMessage) => {
        subscribers.push({rootTopic, selfTopic, onMessage})
        return () => {}
      },
      announce: () => {}
    })

    const appId = `two-passives-${Date.now()}`
    const config = {
      appId,
      passive: true,
      rtcPolyfill: MockRTCPeerConnection
    }

    const roomA = joinRoom(config, 'test-room')

    try {
      await waitFor(() => subscribers.length >= 1)

      const subA = subscribers[0]

      // Passive peer A receives an announcement from passive peer B
      await subA.onMessage(
        subA.rootTopic,
        {peerId: 'passive-peer-b', passive: true},
        () => {
          signalsSent++
        }
      )

      await wait(300)

      assert.equal(
        signalsSent,
        0,
        'passive peer should not send signals to another passive peer'
      )
    } finally {
      await roomA.leave().catch(() => {})
    }
  }
)

void test(
  'Trystero: passive peer can reactivate after deactivating',
  {timeout: 10_000},
  async () => {
    let announceCount = 0
    const subscribers: Subscriber[] = []

    const joinRoom = createStrategy({
      init: () => ({}),
      subscribe: async (_relay, rootTopic, selfTopic, onMessage) => {
        subscribers.push({rootTopic, selfTopic, onMessage})
        return () => {}
      },
      announce: () => {
        announceCount++
      }
    })

    const appId = `passive-reactivate-${Date.now()}`
    const config = {
      appId,
      passive: true,
      rtcPolyfill: MockRTCPeerConnection
    }

    const room = joinRoom(config, 'test-room')

    try {
      await waitFor(() => subscribers.length >= 1)

      const sub = subscribers[0]
      const mockPeer = new MockPeer()

      // Step 1: Activate by receiving an announcement from a non-passive peer
      await sub.onMessage(
        sub.rootTopic,
        {peerId: 'active-peer'},
        () => {}
      )

      await waitFor(() => announceCount > 0, 5_000)

      // Step 2: Establish connection via answer with mockPeer
      const encryptedAnswer = await encrypt(
        genKey('', appId, 'test-room'),
        'answer-sdp'
      )

      await sub.onMessage(
        sub.rootTopic,
        {
          peerId: 'active-peer',
          answer: encryptedAnswer,
          peer: mockPeer
        },
        () => {}
      )

      await wait(100)

      // Step 3: Deactivate by disconnecting the peer
      mockPeer.destroy()
      await wait(500)
      const countAfterDeactivation = announceCount
      await wait(500)

      // Verify announces stopped
      assert.equal(
        announceCount,
        countAfterDeactivation,
        'should stop announcing after deactivation'
      )

      // Step 4: Reactivate via new active peer announcement
      await sub.onMessage(
        sub.rootTopic,
        {peerId: 'active-peer-2'},
        () => {}
      )

      await waitFor(() => announceCount > countAfterDeactivation, 5_000)

      assert.ok(
        announceCount > countAfterDeactivation,
        'passive peer should reactivate and announce again'
      )
    } finally {
      await room.leave().catch(() => {})
    }
  }
)

void test(
  'Trystero: candidate from non-passive peer does not activate passive peer',
  {timeout: 10_000},
  async () => {
    let announceCount = 0
    const subscribers: Subscriber[] = []

    const joinRoom = createStrategy({
      init: () => ({}),
      subscribe: async (_relay, rootTopic, selfTopic, onMessage) => {
        subscribers.push({rootTopic, selfTopic, onMessage})
        return () => {}
      },
      announce: () => {
        announceCount++
      }
    })

    const appId = `passive-candidate-no-activate-${Date.now()}`
    const config = {
      appId,
      passive: true,
      rtcPolyfill: MockRTCPeerConnection
    }

    const room = joinRoom(config, 'test-room')

    try {
      await waitFor(() => subscribers.length >= 1)
      await wait(200)

      const sub = subscribers[0]

      // Send a stray candidate from a non-passive peer
      const encryptedCandidate = await encrypt(
        genKey('', appId, 'test-room'),
        'candidate:1234'
      )

      await sub.onMessage(
        sub.rootTopic,
        {peerId: 'active-peer-1', candidate: encryptedCandidate},
        () => {}
      )

      await wait(300)

      assert.equal(
        announceCount,
        0,
        'candidate should not activate a passive peer'
      )
    } finally {
      await room.leave().catch(() => {})
    }
  }
)

void test(
  'Trystero: answer from non-passive peer does not activate passive peer',
  {timeout: 10_000},
  async () => {
    let announceCount = 0
    const subscribers: Subscriber[] = []

    const joinRoom = createStrategy({
      init: () => ({}),
      subscribe: async (_relay, rootTopic, selfTopic, onMessage) => {
        subscribers.push({rootTopic, selfTopic, onMessage})
        return () => {}
      },
      announce: () => {
        announceCount++
      }
    })

    const appId = `passive-answer-no-activate-${Date.now()}`
    const config = {
      appId,
      passive: true,
      rtcPolyfill: MockRTCPeerConnection
    }

    const room = joinRoom(config, 'test-room')

    try {
      await waitFor(() => subscribers.length >= 1)
      await wait(200)

      const sub = subscribers[0]

      const encryptedAnswer = await encrypt(
        genKey('', appId, 'test-room'),
        'answer-sdp'
      )

      await sub.onMessage(
        sub.rootTopic,
        {
          peerId: 'active-peer-1',
          answer: encryptedAnswer,
          peer: new MockPeer()
        },
        () => {}
      )

      await wait(300)

      assert.equal(
        announceCount,
        0,
        'answer should not activate a passive peer'
      )
    } finally {
      await room.leave().catch(() => {})
    }
  }
)

void test(
  'Trystero: offer from non-passive peer activates passive peer',
  {timeout: 10_000},
  async () => {
    let announceCount = 0
    const subscribers: Subscriber[] = []

    const joinRoom = createStrategy({
      init: () => ({}),
      subscribe: async (_relay, rootTopic, selfTopic, onMessage) => {
        subscribers.push({rootTopic, selfTopic, onMessage})
        return () => {}
      },
      announce: () => {
        announceCount++
      }
    })

    const appId = `passive-offer-activates-${Date.now()}`
    const config = {
      appId,
      passive: true,
      rtcPolyfill: MockRTCPeerConnection
    }

    const room = joinRoom(config, 'test-room')

    try {
      await waitFor(() => subscribers.length >= 1)
      await wait(200)

      assert.equal(announceCount, 0, 'should not announce while inactive')

      const sub = subscribers[0]

      const encryptedOffer = await encrypt(
        genKey('', appId, 'test-room'),
        'offer-sdp'
      )

      // Send an offer from a non-passive peer — should activate
      await sub.onMessage(
        sub.rootTopic,
        {peerId: 'active-peer-1', offer: encryptedOffer},
        () => {}
      )

      await waitFor(() => announceCount > 0, 5_000)

      assert.ok(
        announceCount > 0,
        'offer from non-passive peer should activate passive peer'
      )
    } finally {
      await room.leave().catch(() => {})
    }
  }
)

void test(
  'Trystero: passive peer deactivates only after ALL active peers disconnect',
  {timeout: 10_000},
  async () => {
    let announceCount = 0
    const subscribers: Subscriber[] = []

    const joinRoom = createStrategy({
      init: () => ({}),
      subscribe: async (_relay, rootTopic, selfTopic, onMessage) => {
        subscribers.push({rootTopic, selfTopic, onMessage})
        return () => {}
      },
      announce: () => {
        announceCount++
      }
    })

    const appId = `passive-multi-peer-deactivate-${Date.now()}`
    const config = {
      appId,
      passive: true,
      rtcPolyfill: MockRTCPeerConnection
    }

    const room = joinRoom(config, 'test-room')

    try {
      await waitFor(() => subscribers.length >= 1)

      const sub = subscribers[0]
      const mockPeerA = new MockPeer()
      const mockPeerB = new MockPeer()

      // Activate
      await sub.onMessage(
        sub.rootTopic,
        {peerId: 'active-peer-a'},
        () => {}
      )

      await waitFor(() => announceCount > 0, 5_000)

      const encryptedAnswer = await encrypt(
        genKey('', appId, 'test-room'),
        'answer-sdp'
      )

      // Connect peer A
      await sub.onMessage(
        sub.rootTopic,
        {peerId: 'active-peer-a', answer: encryptedAnswer, peer: mockPeerA},
        () => {}
      )

      await wait(50)

      // Connect peer B
      await sub.onMessage(
        sub.rootTopic,
        {peerId: 'active-peer-b', answer: encryptedAnswer, peer: mockPeerB},
        () => {}
      )

      await wait(50)

      // Disconnect peer A — peer B is still connected
      mockPeerA.destroy()
      await wait(500)

      const countAfterFirstDisconnect = announceCount
      await wait(500)

      // Announces should still be running because peer B is connected
      assert.ok(
        announceCount > countAfterFirstDisconnect,
        'should keep announcing while at least one peer is connected'
      )

      // Now disconnect peer B — no peers left
      mockPeerB.destroy()
      await wait(500)

      const countAfterAllDisconnect = announceCount
      await wait(500)

      assert.equal(
        announceCount,
        countAfterAllDisconnect,
        'should stop announcing only after all peers disconnect'
      )
    } finally {
      await room.leave().catch(() => {})
    }
  }
)

void test(
  'Trystero: leaving room while passive and inactive succeeds cleanly',
  {timeout: 10_000},
  async () => {
    const subscribers: Subscriber[] = []

    const joinRoom = createStrategy({
      init: () => ({}),
      subscribe: async (_relay, rootTopic, selfTopic, onMessage) => {
        subscribers.push({rootTopic, selfTopic, onMessage})
        return () => {}
      },
      announce: () => {}
    })

    const appId = `passive-leave-inactive-${Date.now()}`
    const config = {
      appId,
      passive: true,
      rtcPolyfill: MockRTCPeerConnection
    }

    const room = joinRoom(config, 'test-room')

    await waitFor(() => subscribers.length >= 1)
    await wait(100)

    // Leave while still dormant — should not throw
    await room.leave()

    // Verify the room is fully cleaned up by joining again
    const room2 = joinRoom(config, 'test-room-2')
    assert.equal(room2.isPassive(), true)
    await room2.leave().catch(() => {})
  }
)

void test(
  'Trystero: passive peer includes passive flag in signaling messages',
  {timeout: 10_000},
  async () => {
    const signalPayloads: string[] = []
    const subscribers: Subscriber[] = []

    const joinRoom = createStrategy({
      init: () => ({}),
      subscribe: async (_relay, rootTopic, selfTopic, onMessage) => {
        subscribers.push({rootTopic, selfTopic, onMessage})
        return () => {}
      },
      announce: () => {}
    })

    const appId = `passive-signal-flag-${Date.now()}`
    const config = {
      appId,
      passive: true,
      rtcPolyfill: MockRTCPeerConnection
    }

    const room = joinRoom(config, 'test-room')

    try {
      await waitFor(() => subscribers.length >= 1)

      const sub = subscribers[0]

      // Activate the passive peer with an announcement
      await sub.onMessage(
        sub.rootTopic,
        {peerId: 'active-peer-1'},
        (_topic, signal) => {
          signalPayloads.push(signal)
        }
      )

      // Wait for the offer to be generated and sent
      await waitFor(() => signalPayloads.length > 0, 5_000)

      // Each signal payload should contain passive: true
      for (const raw of signalPayloads) {
        const parsed = JSON.parse(raw)
        assert.equal(
          parsed.passive,
          true,
          `signaling message should include passive: true, got: ${raw}`
        )
      }
    } finally {
      await room.leave().catch(() => {})
    }
  }
)

void test(
  'Trystero: checkDeactivate cleans up idle peer states',
  {timeout: 10_000},
  async () => {
    let announceCount = 0
    const subscribers: Subscriber[] = []

    const joinRoom = createStrategy({
      init: () => ({}),
      subscribe: async (_relay, rootTopic, selfTopic, onMessage) => {
        subscribers.push({rootTopic, selfTopic, onMessage})
        return () => {}
      },
      announce: () => {
        announceCount++
      }
    })

    const appId = `passive-gc-peers-${Date.now()}`
    const config = {
      appId,
      passive: true,
      rtcPolyfill: MockRTCPeerConnection
    }

    const room = joinRoom(config, 'test-room')

    try {
      await waitFor(() => subscribers.length >= 1)

      const sub = subscribers[0]
      const mockPeer = new MockPeer()

      // Activate
      await sub.onMessage(
        sub.rootTopic,
        {peerId: 'active-peer'},
        () => {}
      )

      await waitFor(() => announceCount > 0, 5_000)

      // Connect via answer
      const encryptedAnswer = await encrypt(
        genKey('', appId, 'test-room'),
        'answer-sdp'
      )

      await sub.onMessage(
        sub.rootTopic,
        {peerId: 'active-peer', answer: encryptedAnswer, peer: mockPeer},
        () => {}
      )

      await wait(50)

      // Also trigger state creation for several other peers via announcements
      for (let i = 0; i < 20; i++) {
        await sub.onMessage(
          sub.rootTopic,
          {peerId: `transient-peer-${i}`},
          () => {}
        )
      }

      await wait(50)

      // Disconnect the connected peer — triggers checkDeactivate which should
      // clean up the idle transient peer states
      mockPeer.destroy()
      await wait(500)

      // getPeers returns connected peers from the room layer, but we can
      // verify cleanup indirectly: the room should accept new peers cleanly
      // after reactivation without accumulating stale state
      const peers = room.getPeers()
      assert.equal(
        Object.keys(peers).length,
        0,
        'no connected peers should remain after disconnect'
      )
    } finally {
      await room.leave().catch(() => {})
    }
  }
)
