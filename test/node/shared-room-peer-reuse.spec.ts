// @ts-nocheck
import assert from 'node:assert/strict'
import test from 'node:test'
import {createStrategy, encrypt, genKey} from '@trystero/core'

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

class FakePeer {
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
    const fakePeer = new FakePeer()

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
          peer: fakePeer
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
        fakePeer.destroyCount,
        0,
        'leaving one overlapping room must not close shared peer'
      )

      await primaryRoom.leave()
      assert.equal(
        fakePeer.destroyCount,
        0,
        'shared peer should remain open until idle timeout expires'
      )

      await wait(120)
      assert.equal(
        fakePeer.destroyCount,
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
      relayUrls: ['wss://ignored-for-second-app.example'],
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
