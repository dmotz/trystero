import assert from 'node:assert/strict'
import test from 'node:test'
import {createTopicStrategy} from '../../packages/core/src/index.ts'
import {encrypt, genKey} from '../../packages/core/src/crypto.ts'
import {buildSignalAad} from '../../packages/core/src/signal-handler.ts'
import {MockPeer} from './peer-harness.ts'

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
  remoteDescription = null
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

  async setRemoteDescription(description) {
    this.remoteDescription = description
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
  'Trystero: createTopicStrategy accepts a custom steady announce interval',
  {timeout: 5_000},
  async () => {
    let announceCount = 0
    const joinRoom = createTopicStrategy({
      steadyAnnounceIntervalMs: 100,
      init: () => ({}),
      subscribeTopic: () => () => {},
      publishTopic: (_relay, _topic, _msg, {kind}) => {
        if (kind === 'announce') {
          announceCount++
        }
      }
    })
    const room = joinRoom(
      {
        appId: `topic-custom-announce-interval-${Date.now()}`,
        rtcPolyfill: MockRTCPeerConnection as any
      },
      'room'
    )

    try {
      await waitFor(() => announceCount >= 3, 500)
    } finally {
      await room.leave().catch(() => {})
    }
  }
)

for (const reannounce of [true, false]) {
  void test(
    `Trystero: quiet-room disconnect reannouncing is ${reannounce ? 'enabled by default' : 'disabled explicitly'}`,
    {timeout: 5_000},
    async () => {
      const subscriptions = []
      let announceCount = 0
      const joinRoom = createTopicStrategy({
        ...(reannounce ? {} : {reannounceOnDisconnect: false}),
        init: () => ({}),
        subscribeTopic: (_relay, topic, onMessage, {kind}) => {
          subscriptions.push({topic, onMessage, kind})
          return () => {}
        },
        publishTopic: (_relay, _topic, _msg, {kind}) => {
          if (kind === 'announce') {
            announceCount++
            return {nextAnnounceMs: 60_000}
          }
          return undefined
        }
      })
      const appId = `topic-reannounce-on-disconnect-${Date.now()}`
      const room = joinRoom(
        {appId, rtcPolyfill: MockRTCPeerConnection as any},
        'room'
      )

      try {
        await waitFor(
          () =>
            announceCount > 0 && subscriptions.some(sub => sub.kind === 'root')
        )

        const root = subscriptions.find(sub => sub.kind === 'root')
        const peers = Array.from({length: 3}, () => new MockPeer())
        const roomKey = genKey('', appId, 'room')

        for (const [i, peer] of peers.entries()) {
          const remotePeerId = `remote-${i}`
          const offerId = `offer-${i}`
          const answer = await encrypt(
            roomKey,
            'answer-sdp',
            buildSignalAad('answer', remotePeerId, offerId)
          )
          await root.onMessage(root.topic, {
            peerId: remotePeerId,
            offerId,
            answer,
            peer
          })
        }
        // No scheduled startup pulse falls in the following observation window.
        await wait(2400)

        const countBeforeDisconnect = announceCount
        peers.forEach(peer => peer.destroy())

        await wait(50)
        assert.equal(announceCount - countBeforeDisconnect, reannounce ? 1 : 0)
        await wait(850)
        assert.equal(announceCount - countBeforeDisconnect, reannounce ? 3 : 0)
      } finally {
        await room.leave().catch(() => {})
      }
    }
  )
}

void test(
  'Trystero: topic strategy uses the prompt first signaling retry',
  {timeout: 4000},
  async () => {
    let root
    let offers = 0
    const joinRoom = createTopicStrategy({
      init: () => ({}),
      subscribeTopic: (_relay, topic, onMessage, {kind}) => {
        if (kind === 'root') {
          root = {topic, onMessage}
        }
        return () => {}
      },
      publishTopic: (_relay, _topic, message, {kind}) => {
        if (
          kind === 'signal' &&
          typeof message === 'string' &&
          JSON.parse(message).offer
        ) {
          offers++
        }
      }
    })
    const room = joinRoom(
      {
        appId: `prompt-retry-${Date.now()}`,
        rtcPolyfill: MockRTCPeerConnection as any
      },
      'room'
    )
    try {
      const {peerId: selfId} = await room.getSelf()
      await waitFor(() => root !== undefined)
      await root.onMessage(root.topic, {peerId: selfId + 'z'})
      await waitFor(() => offers >= 1)
      await waitFor(() => offers === 2, 2500)
    } finally {
      await room.leave()
    }
  }
)

void test(
  'Trystero: createTopicStrategy subscribes passive rooms to self and root without announcing',
  {timeout: 10_000},
  async () => {
    const subscriptions = []
    const published = []
    const joinRoom = createTopicStrategy({
      init: () => ({}),
      subscribeTopic: (_relay, topic, onMessage, context) => {
        subscriptions.push({topic, onMessage, kind: context.kind})
        return () => {}
      },
      publishTopic: (_relay, topic, msg, context) => {
        published.push({topic, msg, kind: context.kind})
      }
    })
    const room = joinRoom(
      {
        appId: `topic-passive-${Date.now()}`,
        passive: true,
        rtcPolyfill: MockRTCPeerConnection as any
      },
      'room'
    )

    try {
      await waitFor(() => subscriptions.length === 2)
      assert.deepEqual(
        subscriptions.map(sub => sub.kind),
        ['self', 'root']
      )
      await wait(100)
      assert.equal(
        published.filter(msg => msg.kind === 'announce').length,
        0,
        'passive room should never publish root announcements'
      )

      const root = subscriptions.find(sub => sub.kind === 'root')
      await root.onMessage(root.topic, {peerId: '~active-peer'})
      await waitFor(() => published.some(msg => msg.kind === 'signal'))
      assert.equal(
        published.filter(msg => msg.kind === 'announce').length,
        0,
        'passive room should respond via signal without starting root announcements'
      )
    } finally {
      await room.leave().catch(() => {})
    }
  }
)

void test(
  'Trystero: createTopicStrategy subscribes self topic before root topic',
  {timeout: 10_000},
  async () => {
    const order = []
    let selfReady = false
    const joinRoom = createTopicStrategy({
      init: () => ({}),
      subscribeTopic: (_relay, _topic, _onMessage, context) => {
        if (context.kind === 'self') {
          selfReady = true
        } else {
          assert.equal(
            selfReady,
            true,
            'root subscription should not start before self subscription'
          )
        }

        order.push(context.kind)
        return () => {}
      },
      publishTopic: () => {}
    })
    const room = joinRoom(
      {
        appId: `topic-active-order-${Date.now()}`,
        rtcPolyfill: MockRTCPeerConnection as any
      },
      'room'
    )

    try {
      await waitFor(() => order.length === 2)
      assert.deepEqual(order, ['self', 'root'])
    } finally {
      await room.leave().catch(() => {})
    }
  }
)

void test(
  'Trystero: createTopicStrategy has self topic ready before first direct SDP',
  {timeout: 10_000},
  async () => {
    let resolveSelfSubscribe
    let selfHandler = null
    let rootSubscribed = false
    let directSdpDropped = false
    const selfReady = new Promise<void>(res => {
      resolveSelfSubscribe = res
    })
    const joinRoom = createTopicStrategy({
      init: () => ({}),
      subscribeTopic: async (_relay, topic, onMessage, context) => {
        if (context.kind === 'self') {
          await selfReady
          selfHandler = onMessage
        } else {
          rootSubscribed = true
          directSdpDropped = !selfHandler

          if (selfHandler) {
            void selfHandler(context.selfTopic, {
              peerId: 'active-peer',
              offer: 'ephemeral-offer'
            })
          }
        }

        return () => {}
      },
      publishTopic: () => {}
    })
    const room = joinRoom(
      {
        appId: `topic-active-direct-sdp-${Date.now()}`,
        rtcPolyfill: MockRTCPeerConnection as any
      },
      'room'
    )

    try {
      await wait(50)
      assert.equal(rootSubscribed, false)

      resolveSelfSubscribe()
      await waitFor(() => rootSubscribed)

      assert.equal(
        directSdpDropped,
        false,
        'ephemeral direct SDP should have a self-topic listener before root discovery begins'
      )
    } finally {
      await room.leave().catch(() => {})
    }
  }
)

void test(
  'Trystero: un-awaited room.leave() followed immediately by joinRoom creates a fresh active room',
  {timeout: 5_000},
  async () => {
    let activeSubscriptions = 0
    let announceCount = 0
    const joinRoom = createTopicStrategy({
      init: () => ({}),
      subscribeTopic: () => {
        activeSubscriptions++
        return () => {
          activeSubscriptions--
        }
      },
      publishTopic: (_relay, _topic, _msg, {kind}) => {
        if (kind === 'announce') {
          announceCount++
        }
      }
    })
    const config = {
      appId: `topic-sync-rejoin-${Date.now()}`,
      rtcPolyfill: MockRTCPeerConnection as any
    }

    const firstRoom = joinRoom(config, 'room')
    await waitFor(() => activeSubscriptions === 2 && announceCount > 0)

    void firstRoom.leave()
    const secondRoom = joinRoom(config, 'room')

    try {
      assert.notEqual(secondRoom, firstRoom)
      const countAtRejoin = announceCount
      await waitFor(() => announceCount > countAtRejoin)
      assert.equal(activeSubscriptions, 2)
    } finally {
      await secondRoom.leave().catch(() => {})
    }

    assert.equal(activeSubscriptions, 0)
  }
)
