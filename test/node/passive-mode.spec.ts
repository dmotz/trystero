import assert from 'node:assert/strict'
import test from 'node:test'
import {encrypt, genKey} from '../../packages/core/src/crypto.ts'
import {
  buildSignalAad,
  prunePeerStates
} from '../../packages/core/src/signal-handler.ts'
import createStrategy from '../../packages/core/src/strategy.ts'
import {
  BufferedPeer,
  joinAsTestPeer,
  linkPeers,
  MockPeer,
  MockRTCPeerConnection,
  wait,
  waitFor
} from './peer-harness.ts'

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
  'Trystero: passive peer never announces on rootTopic',
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
      rtcPolyfill: MockRTCPeerConnection as any
    }

    const room = joinRoom(config, 'test-room')

    try {
      await waitFor(() => subscribers.length >= 1)
      await wait(300)

      assert.equal(announceCount, 0, 'passive peer should not announce on join')
      assert.equal('isPassive' in room, false)

      const sub = subscribers[0]
      await sub.onMessage(sub.rootTopic, {peerId: 'active-peer-1'}, () => {})

      const encryptedOffer = await encrypt(
        genKey('', appId, 'test-room'),
        JSON.stringify({type: 'offer', sdp: 'offer-sdp'}),
        buildSignalAad('offer', 'active-peer-2', 'offer-1')
      )
      await sub.onMessage(
        sub.selfTopic,
        {peerId: 'active-peer-2', offerId: 'offer-1', offer: encryptedOffer},
        () => {}
      )

      await wait(300)
      assert.equal(
        announceCount,
        0,
        'passive peer should never announce even after interacting with active peers'
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
      rtcPolyfill: MockRTCPeerConnection as any
    }

    const room = joinRoom(config, 'test-room')

    try {
      await waitFor(() => subscribers.length >= 1)
      await waitFor(() => announceCount > 0)

      assert.ok(announceCount > 0, 'non-passive peer should announce')
      assert.equal('isPassive' in room, false)
    } finally {
      await room.leave().catch(() => {})
    }
  }
)

void test(
  'Trystero: passive peer responds with an offer when leading (selfId < peerId)',
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

    const appId = `passive-offer-leader-${Date.now()}`
    const room = joinRoom(
      {
        appId,
        passive: true,
        rtcPolyfill: MockRTCPeerConnection as any
      },
      'test-room'
    )

    try {
      await waitFor(() => subscribers.length >= 1)
      const sub = subscribers[0]

      await sub.onMessage(
        sub.rootTopic,
        {peerId: '~active-peer'},
        (_topic, signal) => {
          signalPayloads.push(signal)
        }
      )

      await waitFor(() => signalPayloads.length > 0, 5_000)

      const firstSignal = JSON.parse(signalPayloads[0])
      assert.equal(typeof firstSignal.offer, 'string')
      assert.equal('passive' in firstSignal, false)
    } finally {
      await room.leave().catch(() => {})
    }
  }
)

void test(
  'Trystero: passive peer responds with a unicast counter-announcement when following (selfId > peerId)',
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

    const appId = `passive-counter-announce-${Date.now()}`
    const room = joinRoom(
      {
        appId,
        passive: true,
        rtcPolyfill: MockRTCPeerConnection as any
      },
      'test-room'
    )

    try {
      const {peerId: selfId} = await room.getSelf()
      await waitFor(() => subscribers.length >= 1)
      const sub = subscribers[0]

      await sub.onMessage(
        sub.rootTopic,
        {peerId: '!active-peer'},
        (_topic, signal) => {
          signalPayloads.push(signal)
        }
      )

      await waitFor(() => signalPayloads.length === 1)

      const reply = JSON.parse(signalPayloads[0])
      assert.deepEqual(reply, {peerId: selfId})
    } finally {
      await room.leave().catch(() => {})
    }
  }
)

void test(
  'Trystero: passive peer ignores malformed and wrong-topic discovery messages',
  {timeout: 10_000},
  async () => {
    let signalsSent = 0
    const subscribers: Subscriber[] = []

    const joinRoom = createStrategy({
      init: () => ({}),
      subscribe: async (_relay, rootTopic, selfTopic, onMessage) => {
        subscribers.push({rootTopic, selfTopic, onMessage})
        return () => {}
      },
      announce: () => {}
    })

    const appId = `passive-ignore-invalid-${Date.now()}`
    const room = joinRoom(
      {
        appId,
        passive: true,
        rtcPolyfill: MockRTCPeerConnection as any
      },
      'test-room'
    )

    try {
      await waitFor(() => subscribers.length >= 1)
      const sub = subscribers[0]
      const onSignal = () => {
        signalsSent++
      }

      await sub.onMessage(sub.rootTopic, {}, onSignal)
      await sub.onMessage('wrong-topic', {peerId: 'active-peer'}, onSignal)
      await sub.onMessage('not json', 'not-json', onSignal)
      await sub.onMessage(sub.rootTopic, null, onSignal)
      await sub.onMessage(
        sub.rootTopic,
        {peerId: 'active-peer', offer: {sdp: 'not-a-string'}},
        onSignal
      )
      await wait(200)

      assert.equal(signalsSent, 0)
    } finally {
      await room.leave().catch(() => {})
    }
  }
)

void test(
  'Trystero: two passive peers in the same room never announce or connect to each other',
  {timeout: 10_000},
  async () => {
    const subscribers: Subscriber[] = []
    let announces = 0

    const makeJoinRoom = (peerId: string) =>
      joinAsTestPeer(
        peerId,
        createStrategy({
          init: () => ({}),
          subscribe: async (_relay, rootTopic, selfTopic, onMessage) => {
            subscribers.push({rootTopic, selfTopic, onMessage})
            return () => {}
          },
          announce: () => {
            announces++
          }
        })
      )

    const appId = `two-passives-${Date.now()}`
    const roomA = makeJoinRoom('passive-a')(
      {
        appId,
        passive: true,
        rtcPolyfill: MockRTCPeerConnection as any
      },
      'test-room'
    )
    const roomB = makeJoinRoom('passive-b')(
      {
        appId,
        passive: true,
        rtcPolyfill: MockRTCPeerConnection as any
      },
      'test-room'
    )

    try {
      await waitFor(() => subscribers.length === 2)
      await wait(300)

      assert.equal(announces, 0)
      assert.deepEqual(roomA.getPeers(), {})
      assert.deepEqual(roomB.getPeers(), {})
    } finally {
      await roomA.leave().catch(() => {})
      await roomB.leave().catch(() => {})
    }
  }
)

void test(
  'Trystero: leaving a passive room succeeds cleanly',
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

    const config = {
      appId: `passive-leave-${Date.now()}`,
      passive: true,
      rtcPolyfill: MockRTCPeerConnection as any
    }

    const room = joinRoom(config, 'test-room')

    await waitFor(() => subscribers.length >= 1)
    await wait(50)
    await room.leave()

    const room2 = joinRoom(config, 'test-room-2')
    assert.notEqual(room2, room)
    await room2.leave().catch(() => {})
  }
)

void test('Trystero: prunePeerStates deletes only completely idle peer states', () => {
  const peerStates: Record<string, any> = {
    idle: {
      answeringPeer: null,
      connectedPeer: null,
      lastExchangeAt: 100,
      offerId: null,
      offerInitPromise: null,
      offerPeer: null,
      offerRelays: []
    },
    connected: {
      answeringPeer: null,
      connectedPeer: new MockPeer(),
      lastExchangeAt: 100,
      offerId: null,
      offerInitPromise: null,
      offerPeer: null,
      offerRelays: []
    },
    retrying: {
      answeringPeer: null,
      connectedPeer: null,
      lastExchangeAt: 100,
      offerId: 'offer-1',
      offerInitPromise: null,
      offerPeer: new MockPeer(),
      offerRelays: [{timeout: setTimeout(() => {}, 1000)}]
    }
  }

  try {
    prunePeerStates(peerStates)
    assert.equal('idle' in peerStates, false)
    assert.equal('connected' in peerStates, true)
    assert.equal('retrying' in peerStates, true)

    peerStates.connected.connectedPeer = null
    clearTimeout(peerStates.retrying.offerRelays[0].timeout)
    peerStates.retrying.offerRelays = []
    peerStates.retrying.offerPeer = null

    prunePeerStates(peerStates)
    assert.deepEqual(peerStates, {})
  } finally {
    clearTimeout(peerStates.retrying?.offerRelays?.[0]?.timeout)
  }
})

void test(
  'Trystero: passive peer disconnects cleanly when active peer sends graceful @_leave',
  {timeout: 10_000},
  async () => {
    const subscribers: Subscriber[] = []

    const joinRoom = joinAsTestPeer(
      'passive-peer',
      createStrategy({
        init: () => ({}),
        subscribe: async (_relay, rootTopic, selfTopic, onMessage) => {
          subscribers.push({rootTopic, selfTopic, onMessage})
          return () => {}
        },
        announce: () => {}
      })
    )

    const appId = `passive-graceful-leave-${Date.now()}`
    const room = joinRoom(
      {
        appId,
        passive: true,
        rtcPolyfill: MockRTCPeerConnection as any
      },
      'test-room'
    )
    let activeRoom: any = null
    const {peerA, peerB} = linkPeers(new BufferedPeer(), new BufferedPeer())

    try {
      await waitFor(() => subscribers.length >= 1)

      const sub = subscribers[0]
      const roomKey = genKey('', appId, 'test-room')
      const encryptedAnswerForPassive = await encrypt(
        roomKey,
        'answer-sdp',
        buildSignalAad('answer', 'active-peer', 'offer-1')
      )
      await sub.onMessage(
        sub.rootTopic,
        {
          peerId: 'active-peer',
          offerId: 'offer-1',
          answer: encryptedAnswerForPassive,
          peer: peerA
        },
        () => {}
      )

      activeRoom = joinAsTestPeer(
        'active-peer',
        createStrategy({
          init: () => ({}),
          subscribe: async (_relay, rootTopic, selfTopic, onMessage) => {
            subscribers.push({rootTopic, selfTopic, onMessage})
            return () => {}
          },
          announce: () => {}
        })
      )(
        {
          appId,
          rtcPolyfill: MockRTCPeerConnection as any
        },
        'test-room'
      )

      await waitFor(() => subscribers.length >= 2)
      const encryptedAnswerForActive = await encrypt(
        roomKey,
        'answer-sdp',
        buildSignalAad('answer', 'passive-peer', 'offer-1')
      )
      await subscribers[1].onMessage(
        subscribers[1].rootTopic,
        {
          peerId: 'passive-peer',
          offerId: 'offer-1',
          answer: encryptedAnswerForActive,
          peer: peerB
        },
        () => {}
      )

      await waitFor(() => 'active-peer' in room.getPeers())
      await activeRoom.leave()

      await waitFor(() => Object.keys(room.getPeers()).length === 0)
      assert.equal(peerA.isDead, true)
    } finally {
      await activeRoom?.leave().catch(() => {})
      await room.leave().catch(() => {})
      peerA.destroy()
      peerB.destroy()
    }
  }
)
