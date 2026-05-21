import assert from 'node:assert/strict'
import test from './test.ts'
// @ts-expect-error
import {encrypt, genKey} from '../../packages/core/src/crypto.ts'
// @ts-expect-error
import createStrategy from '../../packages/core/src/strategy.ts'
// @ts-expect-error
import {selfId} from '../../packages/core/src/utils.ts'
import {MockRTCPeerConnection, waitFor} from './peer-harness.ts'

type Subscriber = {
  rootTopic: string
  selfTopic: string
  onMessage: (
    topic: string,
    msg: unknown,
    signalPeer: (peerTopic: string, signal: string) => void
  ) => Promise<void> | void
}

class FailingRTCPeerConnection extends MockRTCPeerConnection {
  static instances: FailingRTCPeerConnection[] = []

  constructor() {
    super()
    FailingRTCPeerConnection.instances.push(this)
  }

  async setLocalDescription(description?: RTCSessionDescriptionInit) {
    if (!description && this.remoteDescription?.type === 'offer') {
      this.localDescription = {
        type: 'answer',
        sdp: `mock-answer-${Math.random()}`
      }
      this.signalingState = 'stable'
      this.listeners['icegatheringstatechange']?.forEach(listener => listener())
      return
    }

    await super.setLocalDescription(description)
  }

  failIce() {
    this.connectionState = 'failed'
    this.iceConnectionState = 'failed'
    this.onconnectionstatechange?.()
    this.listeners['iceconnectionstatechange']?.forEach(listener => listener())
  }
}

const createTestStrategy = (subscribers: Subscriber[]) =>
  createStrategy({
    init: () => ({}),
    subscribe: async (_relay, rootTopic, selfTopic, onMessage) => {
      subscribers.push({rootTopic, selfTopic, onMessage})
      return () => {}
    },
    announce: () => {}
  })

const nextHigherPeerId = (): string =>
  String.fromCharCode(selfId.charCodeAt(0) + 1) + selfId.slice(1)

void test(
  'Trystero: reports TURN guidance when an answered offer fails to connect',
  {timeout: 5_000},
  async () => {
    FailingRTCPeerConnection.instances = []
    const subscribers: Subscriber[] = []
    const appId = `turn-offer-failure-${Date.now()}`
    const roomId = 'turn-offer-room'
    const remotePeerId = nextHigherPeerId()
    const joinRoom = createTestStrategy(subscribers)
    const errors: string[] = []
    const room = joinRoom(
      {appId, rtcPolyfill: FailingRTCPeerConnection as any},
      roomId,
      {onJoinError: details => errors.push(details.error)}
    )

    try {
      await waitFor(() => subscribers.length >= 1)
      const sub = subscribers[0]
      let offerPayload: Record<string, string> | null = null

      await sub.onMessage(
        sub.rootTopic,
        {peerId: remotePeerId},
        (_topic, msg) => {
          offerPayload = JSON.parse(msg) as Record<string, string>
        }
      )

      assert.ok(offerPayload?.offer, 'expected outgoing offer')
      assert.ok(offerPayload.offerId, 'expected outgoing offer id')

      const encryptedAnswer = await encrypt(
        genKey('', appId, roomId),
        'mock-answer'
      )

      await sub.onMessage(
        sub.selfTopic,
        {
          peerId: remotePeerId,
          offerId: offerPayload.offerId,
          answer: encryptedAnswer
        },
        () => {}
      )

      await waitFor(() =>
        FailingRTCPeerConnection.instances.some(pc => pc.remoteDescription)
      )
      const offerPeerConnection = FailingRTCPeerConnection.instances.find(
        pc => pc.remoteDescription?.type === 'answer'
      )
      assert.ok(offerPeerConnection, 'expected offer peer connection')
      offerPeerConnection.failIce()

      await waitFor(() => errors.length > 0)
      assert.match(errors[0], /could not connect to peer/)
      assert.match(errors[0], /after exchanging SDP/)
      assert.match(errors[0], /TURN/)
    } finally {
      await room.leave().catch(() => {})
    }
  }
)

void test(
  'Trystero: reports TURN guidance when a sent answer fails to connect',
  {timeout: 5_000},
  async () => {
    FailingRTCPeerConnection.instances = []
    const subscribers: Subscriber[] = []
    const appId = `turn-answer-failure-${Date.now()}`
    const roomId = 'turn-answer-room'
    const remotePeerId = 'remote-peer'
    const joinRoom = createTestStrategy(subscribers)
    const errors: string[] = []
    const room = joinRoom(
      {appId, rtcPolyfill: FailingRTCPeerConnection as any},
      roomId,
      {onJoinError: details => errors.push(details.error)}
    )

    try {
      await waitFor(() => subscribers.length >= 1)
      const sub = subscribers[0]
      const encryptedOffer = await encrypt(
        genKey('', appId, roomId),
        'mock-offer'
      )
      let answerPayload: Record<string, string> | null = null

      await sub.onMessage(
        sub.selfTopic,
        {
          peerId: remotePeerId,
          offerId: 'offer-1',
          offer: encryptedOffer
        },
        (_topic, msg) => {
          answerPayload = JSON.parse(msg) as Record<string, string>
        }
      )

      await waitFor(() => Boolean(answerPayload?.answer))
      const answerPeerConnection = FailingRTCPeerConnection.instances.find(
        pc => pc.remoteDescription?.type === 'offer'
      )
      assert.ok(answerPeerConnection, 'expected answer peer connection')
      answerPeerConnection.failIce()

      await waitFor(() => errors.length > 0)
      assert.match(errors[0], /could not connect to peer/)
      assert.match(errors[0], /after exchanging SDP/)
      assert.match(errors[0], /TURN/)
    } finally {
      await room.leave().catch(() => {})
    }
  }
)
