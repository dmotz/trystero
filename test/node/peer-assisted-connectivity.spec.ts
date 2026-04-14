// @ts-nocheck
import assert from 'node:assert/strict'
import test from 'node:test'
import {encrypt, genKey} from '../../packages/core/src/crypto.ts'
import createStrategy from '../../packages/core/src/strategy.ts'
import {PeerAssistedConnectivity} from '../../packages/core/src/strategies/peer-assisted.ts'

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
  bufferedAmount = 0
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

  async createAnswer() {
    return {type: 'answer', sdp: `mock-answer-${Math.random()}`}
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
  _linked = null

  async getOffer() {}

  async signal() {
    this.handlers.connect?.()
  }

  sendData(data) {
    if (this._linked) {
      const remote = this._linked
      const buf =
        data instanceof Uint8Array
          ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
          : data instanceof ArrayBuffer
            ? data
            : data.buffer
      setTimeout(() => remote.handlers.data?.(buf), 1)
    }
  }

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

const linkPeers = (a, b) => {
  a._linked = b
  b._linked = a
}

const wait = (ms: number) => new Promise(res => setTimeout(res, ms))

const waitFor = async (
  check: () => boolean,
  timeoutMs = 5_000
): Promise<void> => {
  const start = Date.now()

  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for condition')
    }

    await wait(10)
  }
}

const makeEncryptedAnswer = (appId: string, roomId: string) =>
  encrypt(genKey('', appId, roomId), 'answer-sdp')

const connectMockPeerPair = async (
  subLocal: Subscriber,
  subRemote: Subscriber,
  localPeerId: string,
  remotePeerId: string,
  appId: string,
  roomId: string
): Promise<{localPeer: MockPeer; remotePeer: MockPeer}> => {
  const localPeer = new MockPeer()
  const remotePeer = new MockPeer()
  linkPeers(localPeer, remotePeer)

  const encLocal = await makeEncryptedAnswer(appId, roomId)
  const encRemote = await makeEncryptedAnswer(appId, roomId)

  await subLocal.onMessage(
    subLocal.rootTopic,
    {peerId: remotePeerId, answer: encLocal, peer: localPeer},
    () => {}
  )

  await subRemote.onMessage(
    subRemote.rootTopic,
    {peerId: localPeerId, answer: encRemote, peer: remotePeer},
    () => {}
  )

  return {localPeer, remotePeer}
}

void test(
  'PeerAssistedConnectivity: is a valid RoomStrategy with configurable gossip interval',
  {timeout: 5_000},
  () => {
    const pac = new PeerAssistedConnectivity()
    assert.ok(pac instanceof PeerAssistedConnectivity)
    assert.ok(typeof pac.init === 'function')

    const pacWithOpts = new PeerAssistedConnectivity({gossipIntervalMs: 5000})
    assert.ok(pacWithOpts instanceof PeerAssistedConnectivity)
  }
)

void test(
  'PeerAssistedConnectivity: peers connect and are visible via getPeers with handshake completion',
  {timeout: 10_000},
  async () => {
    const subsAlice: Subscriber[] = []
    const subsBob: Subscriber[] = []
    const appId = `pac-handshake-${Date.now()}`
    const roomId = 'room-hs'

    const joinRoomAlice = createStrategy({
      init: () => ({}),
      subscribe: async (_relay, rootTopic, selfTopic, onMessage) => {
        subsAlice.push({rootTopic, selfTopic, onMessage})
        return () => {}
      },
      announce: () => {}
    })

    const joinRoomBob = createStrategy({
      init: () => ({}),
      subscribe: async (_relay, rootTopic, selfTopic, onMessage) => {
        subsBob.push({rootTopic, selfTopic, onMessage})
        return () => {}
      },
      announce: () => {}
    })

    const pac = new PeerAssistedConnectivity({gossipIntervalMs: 60_000})
    const config = {
      appId,
      rtcPolyfill: MockRTCPeerConnection,
      strategies: [pac]
    }

    const roomAlice = joinRoomAlice(config, roomId)
    const roomBob = joinRoomBob(config, roomId)

    try {
      await waitFor(() => subsAlice.length >= 1 && subsBob.length >= 1)

      const {localPeer: aliceSidePeer, remotePeer: bobSidePeer} =
        await connectMockPeerPair(
          subsAlice[0],
          subsBob[0],
          'alice-self-id',
          'bob-self-id',
          appId,
          roomId
        )

      await wait(300)

      const alicePeers = roomAlice.getPeers()
      const bobPeers = roomBob.getPeers()

      assert.ok(
        'bob-self-id' in alicePeers,
        'alice should see bob after handshake'
      )
      assert.ok(
        'alice-self-id' in bobPeers,
        'bob should see alice after handshake'
      )
    } finally {
      await roomAlice.leave().catch(() => {})
      await roomBob.leave().catch(() => {})
    }
  }
)

void test(
  'PeerAssistedConnectivity: onPeerJoin/onPeerLeave chaining allows user and strategy listeners',
  {timeout: 10_000},
  async () => {
    const subsA: Subscriber[] = []
    const subsB: Subscriber[] = []
    const appId = `pac-chain-${Date.now()}`
    const roomId = 'room-chain'

    const joinRoomA = createStrategy({
      init: () => ({}),
      subscribe: async (_relay, rootTopic, selfTopic, onMessage) => {
        subsA.push({rootTopic, selfTopic, onMessage})
        return () => {}
      },
      announce: () => {}
    })

    const joinRoomB = createStrategy({
      init: () => ({}),
      subscribe: async (_relay, rootTopic, selfTopic, onMessage) => {
        subsB.push({rootTopic, selfTopic, onMessage})
        return () => {}
      },
      announce: () => {}
    })

    const pac = new PeerAssistedConnectivity({gossipIntervalMs: 60_000})
    const config = {
      appId,
      rtcPolyfill: MockRTCPeerConnection,
      strategies: [pac]
    }

    const roomA = joinRoomA(config, roomId)
    const roomB = joinRoomB(config, roomId)

    const userJoinedA: string[] = []
    const userLeftA: string[] = []

    roomA.onPeerJoin(id => userJoinedA.push(id))
    roomA.onPeerLeave(id => userLeftA.push(id))

    try {
      await waitFor(() => subsA.length >= 1 && subsB.length >= 1)

      const {localPeer} = await connectMockPeerPair(
        subsA[0],
        subsB[0],
        'self-a',
        'peer-b',
        appId,
        roomId
      )

      await wait(300)

      assert.ok(
        userJoinedA.includes('peer-b'),
        'user onPeerJoin should fire for peer-b (chaining works)'
      )

      localPeer.destroy()
      await wait(100)

      assert.ok(
        userLeftA.includes('peer-b'),
        'user onPeerLeave should fire for peer-b (chaining works)'
      )
    } finally {
      await roomA.leave().catch(() => {})
      await roomB.leave().catch(() => {})
    }
  }
)

void test(
  'PeerAssistedConnectivity: cleanup runs on leave and destroys shared peer after idle',
  {timeout: 10_000},
  async () => {
    const subsA: Subscriber[] = []
    const subsB: Subscriber[] = []
    const appId = `pac-cleanup-${Date.now()}`
    const roomId = 'room-cleanup'

    const joinRoomA = createStrategy({
      init: () => ({}),
      subscribe: async (_relay, rootTopic, selfTopic, onMessage) => {
        subsA.push({rootTopic, selfTopic, onMessage})
        return () => {}
      },
      announce: () => {}
    })

    const joinRoomB = createStrategy({
      init: () => ({}),
      subscribe: async (_relay, rootTopic, selfTopic, onMessage) => {
        subsB.push({rootTopic, selfTopic, onMessage})
        return () => {}
      },
      announce: () => {}
    })

    const pac = new PeerAssistedConnectivity({gossipIntervalMs: 60_000})
    const config = {
      appId,
      rtcPolyfill: MockRTCPeerConnection,
      strategies: [pac],
      _test_only_sharedPeerIdleMs: 50
    }

    const roomA = joinRoomA(config, roomId)
    const roomB = joinRoomB(config, roomId)

    try {
      await waitFor(() => subsA.length >= 1 && subsB.length >= 1)

      const {localPeer} = await connectMockPeerPair(
        subsA[0],
        subsB[0],
        'self-a',
        'peer-b',
        appId,
        roomId
      )

      await wait(300)

      assert.ok(
        'peer-b' in roomA.getPeers(),
        'peer-b should be connected before leave'
      )

      await roomA.leave()

      assert.equal(
        localPeer.destroyCount,
        0,
        'shared peer should not be destroyed immediately (idle timeout pending)'
      )

      await wait(150)

      assert.equal(
        localPeer.destroyCount,
        1,
        'shared peer should be destroyed after idle timeout'
      )
    } finally {
      await roomA.leave().catch(() => {})
      await roomB.leave().catch(() => {})
    }
  }
)

void test(
  'PeerAssistedConnectivity: strategies field in config is optional',
  {timeout: 5_000},
  async () => {
    const subscribers: Subscriber[] = []
    const appId = `pac-optional-${Date.now()}`
    const roomId = 'room-optional'

    const joinRoom = createStrategy({
      init: () => ({}),
      subscribe: async (_relay, rootTopic, selfTopic, onMessage) => {
        subscribers.push({rootTopic, selfTopic, onMessage})
        return () => {}
      },
      announce: () => {}
    })

    const config = {
      appId,
      rtcPolyfill: MockRTCPeerConnection
    }

    const room = joinRoom(config, roomId)

    try {
      await waitFor(() => subscribers.length >= 1)
      assert.ok(room, 'room should be created without strategies')
    } finally {
      await room.leave().catch(() => {})
    }
  }
)
