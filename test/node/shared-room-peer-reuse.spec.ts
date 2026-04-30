// @ts-nocheck
import assert from 'node:assert/strict'
import test from 'node:test'
import {encrypt, genKey} from '../../packages/core/src/crypto.ts'
import createRoom from '../../packages/core/src/room.ts'
import {SharedPeerManager} from '../../packages/core/src/shared-peer.ts'
import createStrategy from '../../packages/core/src/strategy.ts'
import {selfId} from '../../packages/core/src/utils.ts'

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

class LinkedMediaPeer {
  created = Date.now()
  isDead = false
  handlers = {}
  offerPromise = Promise.resolve()
  partner = null
  addStreamCalls = 0
  connection = {
    connectionState: 'connected',
    iceConnectionState: 'connected',
    getSenders: () => []
  }
  channel = {
    readyState: 'open',
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0
  }
  remoteStreams = new Map()

  async getOffer() {}

  async signal() {}

  sendData(data) {
    this.partner?.handlers.data?.(data.slice().buffer)
  }

  destroy() {
    if (this.isDead) {
      return
    }

    this.isDead = true
    this.connection.connectionState = 'closed'
    this.connection.iceConnectionState = 'closed'
    this.handlers.close?.()
  }

  setHandlers(newHandlers) {
    Object.assign(this.handlers, newHandlers)
  }

  ensureRemoteTrack(track, stream) {
    let streamEntry = this.remoteStreams.get(stream.id)

    if (!streamEntry) {
      const tracksById = new Map()
      const remoteStream = {
        id: stream.id,
        getTracks: () => Array.from(tracksById.values())
      }

      streamEntry = {stream: remoteStream, tracksById}
      this.remoteStreams.set(stream.id, streamEntry)
    }

    const existingTrack = streamEntry.tracksById.get(track.id)

    if (existingTrack) {
      return {stream: streamEntry.stream, track: existingTrack, isNew: false}
    }

    const remoteTrack = {id: track.id}
    streamEntry.tracksById.set(track.id, remoteTrack)

    return {stream: streamEntry.stream, track: remoteTrack, isNew: true}
  }

  addStream(stream) {
    this.addStreamCalls += 1

    stream.getTracks().forEach(track => {
      const remote = this.partner?.ensureRemoteTrack(track, stream)

      if (remote?.isNew) {
        this.partner.handlers.track?.(remote.track, remote.stream)
      }
    })
  }

  removeStream() {}

  addTrack(track, stream) {
    const remote = this.partner?.ensureRemoteTrack(track, stream)

    if (remote?.isNew) {
      this.partner.handlers.track?.(remote.track, remote.stream)
    }

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

const withTimeout = (promise, ms = 500) =>
  Promise.race([
    promise,
    wait(ms).then(() => {
      throw new Error('timed out waiting for result')
    })
  ])

const createSharedMediaRooms = async (
  managerA,
  managerB,
  sharedA,
  sharedB,
  roomId
) => {
  let registerPeerA = null
  let registerPeerB = null
  const roomA = createRoom(
    f => {
      registerPeerA = f
    },
    () => {},
    () => {}
  )
  const roomB = createRoom(
    f => {
      registerPeerB = f
    },
    () => {},
    () => {}
  )
  const joinA = new Promise(resolve => (roomA.onPeerJoin = resolve))
  const joinB = new Promise(resolve => (roomB.onPeerJoin = resolve))
  const token = `${roomId}-token`
  const {proxy: proxyA} = managerA.bind(
    roomId,
    Promise.resolve(token),
    sharedA,
    {
      onDetach: () => {}
    }
  )
  const {proxy: proxyB} = managerB.bind(
    roomId,
    Promise.resolve(token),
    sharedB,
    {
      onDetach: () => {}
    }
  )

  assert.ok(registerPeerA, 'expected first room to register its peer callback')
  assert.ok(registerPeerB, 'expected second room to register its peer callback')
  registerPeerA(proxyA, 'peer-b')
  registerPeerB(proxyB, 'peer-a')

  await Promise.all([joinA, joinB])

  return {roomA, roomB}
}

void test(
  'Trystero: reuses shared peer across rooms without SDP and tears down after idle timeout',
  {timeout: 10_000},
  async () => {
    const subscribers: Subscriber[] = []
    const appId = `shared-peer-reuse-${Date.now()}`
    const roomA = 'room-a'
    const roomB = 'room-b'
    const remotePeerId = 'remote-peer'

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
      rtcPolyfill: MockRTCPeerConnection,
      _test_only_sharedPeerIdleMs: 60
    }

    const primaryRoom = joinRoom(config, roomA)
    let overlappingRoom = null
    const mockPeer = new MockPeer()

    try {
      await waitFor(() => subscribers.length >= 1)

      const primarySub = subscribers[0]
      assert.ok(primarySub, 'expected first room subscriber')

      const encryptedAnswer = await encrypt(
        genKey('', appId, roomA),
        'answer-sdp'
      )

      await primarySub.onMessage(
        primarySub.rootTopic,
        {
          peerId: remotePeerId,
          answer: encryptedAnswer,
          peer: mockPeer
        },
        () => {}
      )

      overlappingRoom = joinRoom(config, roomB)
      await waitFor(() => subscribers.length >= 2)

      const overlapSub = subscribers[1]
      assert.ok(overlapSub, 'expected second room subscriber')

      let roomBOfferSignals = 0

      await overlapSub.onMessage(
        overlapSub.rootTopic,
        {peerId: remotePeerId},
        (_peerTopic, rawSignal) => {
          const parsed = JSON.parse(rawSignal)

          if (parsed.offer || parsed.answer || parsed.candidate) {
            roomBOfferSignals += 1
          }
        }
      )

      assert.equal(
        roomBOfferSignals,
        0,
        'overlapping room should reuse shared peer without new relay SDP'
      )

      await overlappingRoom.leave()
      overlappingRoom = null
      assert.equal(
        mockPeer.destroyCount,
        0,
        'leaving one overlapping room must not close shared peer'
      )

      await primaryRoom.leave()
      assert.equal(
        mockPeer.destroyCount,
        0,
        'shared peer should remain open until idle timeout expires'
      )

      await wait(120)
      assert.equal(
        mockPeer.destroyCount,
        1,
        'shared peer should close after idle timeout once all rooms are gone'
      )
    } finally {
      await overlappingRoom?.leave().catch(() => {})
      await primaryRoom.leave().catch(() => {})
    }
  }
)

void test(
  'Trystero: shared peer re-emits cached remote streams in later rooms',
  {timeout: 10_000},
  async () => {
    const appId = `shared-media-reuse-${Date.now()}`
    const managerA = new SharedPeerManager()
    const managerB = new SharedPeerManager()
    const peerA = new LinkedMediaPeer()
    const peerB = new LinkedMediaPeer()
    const localTrack = {id: 'camera-track'}
    const localStream = {id: 'camera-stream', getTracks: () => [localTrack]}
    let firstRooms = null
    let secondRooms = null

    peerA.partner = peerB
    peerB.partner = peerA

    const sharedA = managerA.register(appId, 'peer-b', peerA, 60_000)
    const sharedB = managerB.register(appId, 'peer-a', peerB, 60_000)

    try {
      firstRooms = await createSharedMediaRooms(
        managerA,
        managerB,
        sharedA,
        sharedB,
        'media-room-a'
      )

      const firstStream = new Promise(resolve => {
        firstRooms.roomB.onPeerStream = (stream, peerId, metadata) =>
          resolve({streamId: stream.id, peerId, metadata})
      })

      await Promise.all(
        firstRooms.roomA.addStream(localStream, {
          target: 'peer-b',
          metadata: {phase: 'first'}
        })
      )

      assert.deepEqual(await withTimeout(firstStream), {
        streamId: 'camera-stream',
        peerId: 'peer-a',
        metadata: {phase: 'first'}
      })

      await Promise.all([firstRooms.roomA.leave(), firstRooms.roomB.leave()])
      firstRooms = null

      secondRooms = await createSharedMediaRooms(
        managerA,
        managerB,
        sharedA,
        sharedB,
        'media-room-b'
      )

      const secondStream = new Promise(resolve => {
        secondRooms.roomB.onPeerStream = (stream, peerId, metadata) =>
          resolve({streamId: stream.id, peerId, metadata})
      })

      await Promise.all(
        secondRooms.roomA.addStream(localStream, {
          target: 'peer-b',
          metadata: {phase: 'second'}
        })
      )

      assert.deepEqual(await withTimeout(secondStream), {
        streamId: 'camera-stream',
        peerId: 'peer-a',
        metadata: {phase: 'second'}
      })
      assert.equal(peerA.addStreamCalls, 2)
    } finally {
      await firstRooms?.roomA.leave().catch(() => {})
      await firstRooms?.roomB.leave().catch(() => {})
      await secondRooms?.roomA.leave().catch(() => {})
      await secondRooms?.roomB.leave().catch(() => {})
      managerA.clear(appId, 'peer-b', {destroyPeer: true})
      managerB.clear(appId, 'peer-a', {destroyPeer: true})
    }
  }
)

void test(
  'Trystero: isolates same roomId across appIds on one strategy instance',
  {timeout: 10_000},
  async () => {
    const subscribers: Subscriber[] = []
    let initCount = 0

    const joinRoom = createStrategy({
      init: () => {
        initCount += 1
        return {}
      },
      subscribe: async (_relay, rootTopic, selfTopic, onMessage) => {
        subscribers.push({rootTopic, selfTopic, onMessage})
        return () => {}
      },
      announce: () => {}
    })

    const roomId = 'shared-room'
    const appAConfig = {
      appId: `app-a-${Date.now()}`,
      rtcPolyfill: MockRTCPeerConnection
    }
    const appBConfig = {
      appId: `app-b-${Date.now()}`,
      relayConfig: {urls: ['wss://ignored-for-second-app.example']},
      rtcPolyfill: MockRTCPeerConnection
    }

    const appARoom = joinRoom(appAConfig, roomId)
    const appBRoom = joinRoom(appBConfig, roomId)

    try {
      await waitFor(() => subscribers.length >= 2)

      const appASub = subscribers[0]
      const appBSub = subscribers[1]

      assert.equal(
        initCount,
        1,
        'strategy init should run once for a shared createStrategy instance'
      )
      assert.notEqual(
        appARoom,
        appBRoom,
        'same roomId in different appIds should not reuse the same room instance'
      )
      assert.notEqual(
        appASub.rootTopic,
        appBSub.rootTopic,
        'root topics should be app-scoped for same roomId'
      )
      assert.notEqual(
        appASub.selfTopic,
        appBSub.selfTopic,
        'self topics should be app-scoped for same roomId'
      )

      let crossSignalCount = 0

      await appASub.onMessage(
        appBSub.rootTopic,
        {peerId: 'peer-from-app-b'},
        () => {
          crossSignalCount += 1
        }
      )
      await appBSub.onMessage(
        appASub.rootTopic,
        {peerId: 'peer-from-app-a'},
        () => {
          crossSignalCount += 1
        }
      )

      assert.equal(
        crossSignalCount,
        0,
        'cross-app announcements should be ignored when topics do not match the room app scope'
      )
    } finally {
      await appARoom.leave().catch(() => {})
      await appBRoom.leave().catch(() => {})
    }
  }
)

void test(
  'higher-ID peer replies with own announcement to lower-ID peer selfTopic',
  {timeout: 5_000},
  async () => {
    const subscribers: Subscriber[] = []
    const appId = `reply-announce-${Date.now()}`
    const lowerPeerId =
      String.fromCharCode(selfId.charCodeAt(0) - 1) + selfId.slice(1)

    const joinRoom = createStrategy({
      init: () => ({}),
      subscribe: async (_relay, rootTopic, selfTopic, onMessage) => {
        subscribers.push({rootTopic, selfTopic, onMessage})
        return () => {}
      },
      announce: () => {}
    })

    const room = joinRoom(
      {appId, rtcPolyfill: MockRTCPeerConnection},
      'reply-room'
    )

    try {
      await waitFor(() => subscribers.length >= 1)
      const sub = subscribers[0]

      const signalCalls: {topic: string; signal: string}[] = []

      await sub.onMessage(
        sub.rootTopic,
        {peerId: lowerPeerId},
        (topic, signal) => signalCalls.push({topic, signal})
      )

      await wait(50)

      assert.equal(signalCalls.length, 1, 'should reply to lower-ID peer')

      const payload = JSON.parse(signalCalls[0].signal)
      assert.equal(payload.peerId, selfId, 'reply should contain our peerId')
      assert.ok(
        !payload.offer && !payload.answer && !payload.candidate,
        'reply should only contain peerId, not SDP fields.'
      )
    } finally {
      await room.leave().catch(() => {})
    }
  }
)

void test(
  'lower-ID peer does not reply to announcement from higher-ID peer',
  {timeout: 5_000},
  async () => {
    const subscribers: Subscriber[] = []
    const appId = `no-reply-${Date.now()}`
    const higherPeerId =
      String.fromCharCode(selfId.charCodeAt(0) + 1) + selfId.slice(1)

    const joinRoom = createStrategy({
      init: () => ({}),
      subscribe: async (_relay, rootTopic, selfTopic, onMessage) => {
        subscribers.push({rootTopic, selfTopic, onMessage})
        return () => {}
      },
      announce: () => {}
    })

    const room = joinRoom(
      {appId, rtcPolyfill: MockRTCPeerConnection},
      'no-reply-room'
    )

    try {
      await waitFor(() => subscribers.length >= 1)
      const sub = subscribers[0]

      const replyCalls: string[] = []

      await sub.onMessage(
        sub.rootTopic,
        {peerId: higherPeerId},
        (_topic, signal) => {
          const parsed = JSON.parse(signal)

          if (!parsed.offer && !parsed.answer && !parsed.candidate) {
            replyCalls.push(signal)
          }
        }
      )

      await wait(50)

      assert.equal(replyCalls.length, 0, 'lower-ID peer should not reply.')
    } finally {
      await room.leave().catch(() => {})
    }
  }
)
