// @ts-nocheck
import assert from 'node:assert/strict'
import test from 'node:test'
import {createTopicStrategy} from '../../packages/core/src/index.ts'

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
  'Trystero: createTopicStrategy leaves passive self topic unsubscribed until activation',
  {timeout: 10_000},
  async () => {
    const subscriptions = []
    const joinRoom = createTopicStrategy({
      init: () => ({}),
      subscribeTopic: (_relay, topic, onMessage, context) => {
        subscriptions.push({topic, onMessage, kind: context.kind})
        return () => {}
      },
      publishTopic: () => {}
    })
    const room = joinRoom(
      {
        appId: `topic-passive-lazy-${Date.now()}`,
        passive: true,
        rtcPolyfill: MockRTCPeerConnection
      },
      'room'
    )

    try {
      await waitFor(() => subscriptions.length === 1)
      assert.deepEqual(
        subscriptions.map(sub => sub.kind),
        ['root']
      )
    } finally {
      await room.leave().catch(() => {})
    }
  }
)

void test(
  'Trystero: createTopicStrategy subscribes active self topic before root topic',
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
        rtcPolyfill: MockRTCPeerConnection
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
  'Trystero: createTopicStrategy has active self topic ready before first direct SDP',
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
        rtcPolyfill: MockRTCPeerConnection
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
  'Trystero: createTopicStrategy awaits passive self subscription before activation',
  {timeout: 10_000},
  async () => {
    let resolveSelfSubscribe
    let selfSubscribeStarted = false
    const subscriptions = []
    const published = []
    const selfReady = new Promise<void>(res => {
      resolveSelfSubscribe = res
    })
    const joinRoom = createTopicStrategy({
      init: () => ({}),
      subscribeTopic: async (_relay, topic, onMessage, context) => {
        if (context.kind === 'self') {
          selfSubscribeStarted = true
          await selfReady
        }

        subscriptions.push({topic, onMessage, kind: context.kind})
        return () => {}
      },
      publishTopic: (_relay, topic, msg, context) => {
        published.push({topic, msg, kind: context.kind})
      }
    })
    const room = joinRoom(
      {
        appId: `topic-passive-await-self-${Date.now()}`,
        passive: true,
        rtcPolyfill: MockRTCPeerConnection
      },
      'room'
    )

    try {
      await waitFor(() => subscriptions.some(sub => sub.kind === 'root'))

      const root = subscriptions.find(sub => sub.kind === 'root')
      const pending = root.onMessage(root.topic, {peerId: 'active-peer'})

      await wait(50)
      assert.equal(selfSubscribeStarted, true)
      assert.equal(
        published.length,
        0,
        'activation should wait until self-topic subscription is ready'
      )

      resolveSelfSubscribe()
      await pending
      await waitFor(() => published.some(msg => msg.kind === 'announce'))

      const announce = published.find(msg => msg.kind === 'announce')
      assert.equal(JSON.parse(announce.msg).passive, true)
    } finally {
      await room.leave().catch(() => {})
    }
  }
)

void test(
  'Trystero: createTopicStrategy ignores passive discovery without self subscription',
  {timeout: 10_000},
  async () => {
    let selfSubscribeStarted = false
    const subscriptions = []
    const published = []
    const joinRoom = createTopicStrategy({
      init: () => ({}),
      subscribeTopic: (_relay, topic, onMessage, context) => {
        if (context.kind === 'self') {
          selfSubscribeStarted = true
        }

        subscriptions.push({topic, onMessage, kind: context.kind})
        return () => {}
      },
      publishTopic: (_relay, topic, msg, context) => {
        published.push({topic, msg, kind: context.kind})
      }
    })
    const room = joinRoom(
      {
        appId: `topic-passive-ignore-${Date.now()}`,
        passive: true,
        rtcPolyfill: MockRTCPeerConnection
      },
      'room'
    )

    try {
      await waitFor(() => subscriptions.some(sub => sub.kind === 'root'))

      const root = subscriptions.find(sub => sub.kind === 'root')
      await root.onMessage(root.topic, {peerId: 'passive-peer', passive: true})
      await wait(100)

      assert.equal(selfSubscribeStarted, false)
      assert.equal(published.length, 0)
    } finally {
      await room.leave().catch(() => {})
    }
  }
)
