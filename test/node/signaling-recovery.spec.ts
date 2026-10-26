// @ts-nocheck
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createSignalHandler,
  resetOfferState
} from '../../packages/core/src/signal-handler.ts'
import initPeer from '../../packages/core/src/peer.ts'
import {OfferManager} from '../../packages/core/src/offer-manager.ts'
import createStrategy from '../../packages/core/src/strategy.ts'
import {MockRTCPeerConnection, wait, waitFor} from './peer-harness.ts'

const selfId = 'K'.repeat(20)

const settle = async () => {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve()
  }
}

const fixture = t => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date']})
  const messages = []
  let leaving = false
  const peer = () => ({
    isDead: false,
    connection: {},
    handlers: {},
    setHandlers(handlers) {
      Object.assign(this.handlers, handlers)
    },
    destroy() {
      this.isDead = true
    },
    async signal(signal) {
      if (signal.type === 'offer') {
        this.handlers.signal?.({type: 'answer', sdp: 'answer'})
        this.handlers.signal?.({type: 'candidate', sdp: 'candidate'})
      }
    }
  })
  const ctx = {
    appId: 'recovery-test',
    roomId: 'room',
    config: {},
    peerStates: {},
    rootTopicPlaintext: 'root',
    rootTopicP: Promise.resolve('root'),
    selfTopicP: Promise.resolve('self'),
    toPlain: async signal => signal,
    toCipher: async signal => signal,
    isLeaving: () => leaving,
    isPassive: false,
    isActive: true,
    offerManager: {
      checkout: async () => [{peer: peer(), offer: 'offer'}],
      claimLeased() {},
      reclaimLeased() {}
    },
    initPeer: peer,
    checkDeactivate() {},
    connectPeer() {},
    disconnectPeer() {},
    announceIntervals: [],
    announceIntervalMs: 5333,
    selfId
  }
  const receive = createSignalHandler(ctx)(0)
  const send = (_, message) => messages.push(JSON.parse(message))
  return {
    ctx,
    messages,
    leave: () => {
      leaving = true
    },
    receive: payload => receive('root', payload, send)
  }
}

void test('unanswered offers retry without discovery traffic and stop after two retries', async t => {
  const f = fixture(t)
  await f.receive({peerId: selfId + 'z'})
  assert.equal(f.messages.filter(msg => msg.offer).length, 1)
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(4800)
    await settle()
  }
  const offers = f.messages.filter(msg => msg.offer)
  assert.equal(offers.length, 3)
  assert.equal(new Set(offers.map(msg => msg.offerId)).size, 1)
  t.mock.timers.tick(20000)
  await settle()
  assert.equal(f.messages.filter(msg => msg.offer).length, 3)
})

void test('offer retries stop after an answer or room leave', async t => {
  const f = fixture(t)
  const peerId = selfId + 'z'
  await f.receive({peerId})
  await f.receive({peerId, offerId: f.messages[0].offerId, answer: 'answer'})
  t.mock.timers.tick(5000)
  await settle()
  assert.equal(f.messages.length, 1)
  await f.receive({peerId: peerId + 'z'})
  f.leave()
  t.mock.timers.tick(5000)
  await settle()
  assert.equal(f.messages.length, 2)
})

void test('a pending outgoing offer is discarded after its state resets', async t => {
  const f = fixture(t)
  const peerId = selfId + 'z'
  const outgoingPeer = f.ctx.initPeer()
  let resolveOffer
  f.ctx.offerManager.checkout = () =>
    new Promise(resolve => (resolveOffer = resolve))

  const pendingAnnouncement = f.receive({peerId})
  await settle()
  resetOfferState(f.ctx.peerStates[peerId])
  resolveOffer([{peer: outgoingPeer, offer: 'outgoing-offer'}])
  await pendingAnnouncement

  assert.equal(outgoingPeer.isDead, true)
  assert.equal(f.ctx.peerStates[peerId].offerPeer, null)
})

void test('offer candidates gathered before signaling handlers attach are published after the offer', async t => {
  const f = fixture(t)
  const peerId = selfId + 'z'
  let offerPeer
  let releaseEncryption
  let offerReady
  const encryptedOffer = new Promise(resolve => (releaseEncryption = resolve))
  const preparedOffer = new Promise(resolve => (offerReady = resolve))
  const emitCandidate = port =>
    offerPeer.connection.onicecandidate({
      candidate: {
        toJSON: () => ({
          candidate: `candidate:1 1 udp 1 127.0.0.1 ${port} typ host`,
          sdpMLineIndex: 0
        })
      }
    })

  const manager = new OfferManager(() => {
    offerPeer = initPeer(true, {rtcPolyfill: MockRTCPeerConnection})
    emitCandidate(10001)
    return offerPeer
  })
  f.ctx.offerManager = manager
  f.ctx.encryptOffer = async peer => {
    const offer = await peer.getOffer()
    assert.equal(offer.type, 'offer')
    offerReady()
    return encryptedOffer
  }

  try {
    const announcement = f.receive({peerId})
    await preparedOffer
    emitCandidate(10002)
    assert.deepEqual(f.messages, [])
    releaseEncryption('encrypted-offer')
    await announcement
    await settle()
    emitCandidate(10003)
    await settle()

    const [offer, ...candidates] = f.messages
    assert.equal(offer.offer, 'encrypted-offer')
    assert.deepEqual(
      candidates.map(message => JSON.parse(message.candidate).candidate),
      [10001, 10002, 10003].map(
        port => `candidate:1 1 udp 1 127.0.0.1 ${port} typ host`
      )
    )
    assert.ok(candidates.every(message => message.offerId === offer.offerId))
  } finally {
    f.leave()
    resetOfferState(f.ctx.peerStates[peerId])
    manager.destroy()
  }
})

void test('first topic retry is prompt but later retries retain their spacing', async t => {
  const f = fixture(t)
  await f.receive({peerId: selfId + 'z'})
  t.mock.timers.tick(1999)
  await settle()
  assert.equal(f.messages.filter(msg => msg.offer).length, 1)
  t.mock.timers.tick(1)
  await settle()
  assert.equal(f.messages.filter(msg => msg.offer).length, 2)
  t.mock.timers.tick(2000)
  await settle()
  assert.equal(f.messages.filter(msg => msg.offer).length, 2)
  t.mock.timers.tick(2800)
  await settle()
  assert.equal(f.messages.filter(msg => msg.offer).length, 3)
})

void test('numeric relay pacing is not shortened by the prompt topic retry', async t => {
  const f = fixture(t)
  f.ctx.announceIntervals[0] = 10000
  await f.receive({peerId: selfId + 'z'})
  t.mock.timers.tick(2000)
  await settle()
  assert.equal(f.messages.filter(msg => msg.offer).length, 1)
  t.mock.timers.tick(7000)
  await settle()
  assert.equal(f.messages.filter(msg => msg.offer).length, 2)
})

void test('a pending retry does not prematurely deactivate a passive room', async t => {
  const f = fixture(t)
  f.ctx.isPassive = true
  f.ctx.checkDeactivate = () => {
    if (
      !Object.values(f.ctx.peerStates).some(state =>
        state.offerRelays.some(Boolean)
      )
    ) {
      f.ctx.isActive = false
    }
  }
  await f.receive({peerId: selfId + 'z'})
  t.mock.timers.tick(4800)
  await settle()
  assert.equal(f.ctx.isActive, true)
  assert.equal(f.messages.filter(msg => msg.offer).length, 2)
})

void test('a matching repeated offer replays its answer and candidates, not a new peer', async t => {
  const f = fixture(t)
  const offer = {peerId: selfId + 'z', offer: 'offer', offerId: 'exchange'}
  await f.receive(offer)
  await settle()
  const initial = [...f.messages]
  assert.equal(initial.filter(msg => msg.answer).length, 1)
  const answeringPeer = f.ctx.peerStates[offer.peerId].answeringPeer
  await f.receive(offer)
  assert.deepEqual(
    f.messages,
    initial,
    'rapid duplicates must not amplify traffic'
  )
  const relay1Messages = []
  await createSignalHandler(f.ctx)(1)('root', offer, (_, message) =>
    relay1Messages.push(JSON.parse(message))
  )
  assert.deepEqual(
    relay1Messages,
    initial,
    'distinct relays must immediately receive the replayed answer and candidates'
  )
  t.mock.timers.tick(5000)
  await f.receive({...offer, offerId: 'wrong-exchange'})
  assert.deepEqual(f.messages, initial)
  await f.receive({...offer, offer: 'different-sdp'})
  assert.deepEqual(f.messages, initial)
  await f.receive(offer)
  assert.deepEqual(f.messages, [...initial, ...initial])
  assert.equal(f.ctx.peerStates[offer.peerId].answeringPeer, answeringPeer)
})

void test('stray candidates do not retain peer states or offer IDs', async t => {
  const f = fixture(t)

  for (let i = 0; i < 50; i++) {
    await f.receive({
      peerId: `unknown-${i}`,
      offerId: `offer-${i}`,
      candidate: 'candidate'
    })
  }

  assert.equal(Object.keys(f.ctx.peerStates).length, 0)

  const peerId = selfId + 'z'
  await f.receive({peerId})
  const state = f.ctx.peerStates[peerId]

  for (let i = 0; i < 50; i++) {
    await f.receive({peerId, offerId: `wrong-${i}`, candidate: 'candidate'})
  }

  assert.equal(state.pendingCandidates, undefined)

  const received = []
  state.offerPeer.signal = async signal => received.push(signal)
  await f.receive({
    peerId,
    offerId: f.messages[0].offerId,
    candidate: 'candidate'
  })
  assert.deepEqual(received, [{type: 'candidate', sdp: 'candidate'}])

  const incomingId = 'incoming-peer'
  await f.receive({
    peerId: incomingId,
    offerId: 'incoming-offer',
    offer: 'offer'
  })
  const incoming = []
  f.ctx.peerStates[incomingId].answeringPeer.signal = async signal =>
    incoming.push(signal)

  await f.receive({
    peerId: incomingId,
    offerId: 'wrong-offer',
    candidate: 'candidate'
  })
  await f.receive({
    peerId: incomingId,
    offerId: 'incoming-offer',
    candidate: 'candidate'
  })
  assert.deepEqual(incoming, [{type: 'candidate', sdp: 'candidate'}])
})

void test('pre-allocated offer answers tie-break deterministically against active answering peers', async t => {
  const f = fixture(t)
  const higherPeerId = `${selfId}z`
  const lowerPeerId =
    String.fromCharCode(selfId.charCodeAt(0) - 1) + selfId.slice(1)

  // When selfId < peerId (leader), receiving an answer for our pre-allocated
  // offer supersedes the in-flight answeringPeer.
  await f.receive({
    peerId: higherPeerId,
    offerId: 'remote-offer-1',
    offer: 'offer'
  })
  const leaderAnsweringPeer = f.ctx.peerStates[higherPeerId].answeringPeer
  assert.ok(leaderAnsweringPeer)
  assert.equal(leaderAnsweringPeer.isDead, false)

  const leaderOfferPeer = f.ctx.initPeer()
  await f.receive({
    peerId: higherPeerId,
    offerId: 'local-offer-1',
    answer: 'answer',
    peer: leaderOfferPeer
  })
  assert.equal(leaderAnsweringPeer.isDead, true)
  assert.equal(leaderOfferPeer.isDead, false)
  assert.equal(f.ctx.peerStates[higherPeerId].offerPeer, leaderOfferPeer)
  assert.equal(f.ctx.peerStates[higherPeerId].answeringPeer, null)

  // When selfId > peerId (follower), the existing answeringPeer wins and the
  // redundant pre-allocated offer peer is destroyed.
  await f.receive({
    peerId: lowerPeerId,
    offerId: 'remote-offer-2',
    offer: 'offer'
  })
  const followerAnsweringPeer = f.ctx.peerStates[lowerPeerId].answeringPeer
  assert.ok(followerAnsweringPeer)
  assert.equal(followerAnsweringPeer.isDead, false)

  const followerOfferPeer = f.ctx.initPeer()
  await f.receive({
    peerId: lowerPeerId,
    offerId: 'local-offer-2',
    answer: 'answer',
    peer: followerOfferPeer
  })
  assert.equal(followerAnsweringPeer.isDead, false)
  assert.equal(followerOfferPeer.isDead, true)
  assert.equal(
    f.ctx.peerStates[lowerPeerId].answeringPeer,
    followerAnsweringPeer
  )
})

void test('untrusted serialized or non-handle peer fields and array payloads are ignored', async t => {
  const f = fixture(t)
  const peerId = `${selfId}z`
  let claimed = 0
  f.ctx.offerManager.claimLeased = () => {
    claimed++
  }

  await f.receive(
    JSON.stringify({
      peerId,
      offerId: 'spoofed-1',
      answer: 'answer',
      peer: {signal: 'not-a-function'}
    })
  )
  await f.receive({
    peerId,
    offerId: 'spoofed-2',
    answer: 'answer',
    peer: {isDead: false}
  })
  await f.receive([{peerId, answer: 'answer'}])

  assert.equal(claimed, 0)
  assert.equal(Object.keys(f.ctx.peerStates).length, 0)
})

type Subscriber = {
  rootTopic: string
  selfTopic: string
  onMessage: (
    topic: string,
    msg: unknown,
    signalPeer: (peerTopic: string, signal: string) => void
  ) => Promise<void> | void
}

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
      rtcPolyfill: MockRTCPeerConnection as any
    }
    const appBConfig = {
      appId: `app-b-${Date.now()}`,
      relayConfig: {urls: ['wss://ignored-for-second-app.example']},
      rtcPolyfill: MockRTCPeerConnection as any
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

    const joinRoom = createStrategy({
      init: () => ({}),
      subscribe: async (_relay, rootTopic, selfTopic, onMessage) => {
        subscribers.push({rootTopic, selfTopic, onMessage})
        return () => {}
      },
      announce: () => {}
    })

    const room = joinRoom(
      {appId, rtcPolyfill: MockRTCPeerConnection as any},
      'reply-room'
    )

    try {
      const {peerId: selfId} = await room.getSelf()
      const lowerPeerId =
        String.fromCharCode(selfId.charCodeAt(0) - 1) + selfId.slice(1)
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

    const joinRoom = createStrategy({
      init: () => ({}),
      subscribe: async (_relay, rootTopic, selfTopic, onMessage) => {
        subscribers.push({rootTopic, selfTopic, onMessage})
        return () => {}
      },
      announce: () => {}
    })

    const room = joinRoom(
      {appId, rtcPolyfill: MockRTCPeerConnection as any},
      'no-reply-room'
    )

    try {
      const {peerId: selfId} = await room.getSelf()
      const higherPeerId =
        String.fromCharCode(selfId.charCodeAt(0) + 1) + selfId.slice(1)
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
