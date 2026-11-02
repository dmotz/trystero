import assert from 'node:assert/strict'
import test from './test.ts'
import {encrypt, genKey} from '../../packages/core/src/crypto.ts'
import type {StrategyOnMessage} from '../../packages/core/src/index.ts'
import {buildSignalAad} from '../../packages/core/src/signal-handler.ts'
import createStrategy from '../../packages/core/src/strategy.ts'
import {MockRTCPeerConnection, waitFor} from './peer-harness.ts'

type Subscriber = {
  rootTopic: string
  selfTopic: string
  onMessage: StrategyOnMessage
}

class FailingRTCPeerConnection extends MockRTCPeerConnection {
  static instances: FailingRTCPeerConnection[] = []

  constructor() {
    super()
    FailingRTCPeerConnection.instances.push(this)
  }

  override async setLocalDescription(description?: RTCSessionDescriptionInit) {
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

const nextHigherPeerId = (selfId: string): string =>
  String.fromCharCode(selfId.charCodeAt(0) + 1) + selfId.slice(1)

void test(
  'Trystero: reports TURN guidance when an answered offer fails to connect',
  {timeout: 5_000},
  async () => {
    FailingRTCPeerConnection.instances = []
    const subscribers: Subscriber[] = []
    const appId = `turn-offer-failure-${Date.now()}`
    const roomId = 'turn-offer-room'
    const joinRoom = createTestStrategy(subscribers)
    const errors: Array<{
      code: string
      message: string
      turnConfigured?: boolean
    }> = []
    const room = joinRoom(
      {
        appId,
        rtcPolyfill:
          FailingRTCPeerConnection as unknown as typeof RTCPeerConnection
      },
      roomId
    )
    room.onError(err =>
      errors.push({
        code: err.code,
        message: err.message,
        ...(err.code === 'peer-connect-failed'
          ? {turnConfigured: err.turnConfigured}
          : {})
      })
    )

    try {
      const {peerId: selfId} = await room.getSelf()
      const remotePeerId = nextHigherPeerId(selfId)
      await waitFor(() => subscribers.length >= 1)
      const sub = subscribers[0]!
      let offerPayload = null as {offer?: string; offerId?: string} | null

      await sub.onMessage(
        sub.rootTopic,
        {peerId: remotePeerId},
        (_topic, msg) => {
          offerPayload = JSON.parse(msg) as {offer?: string; offerId?: string}
        }
      )

      assert.ok(offerPayload?.offer, 'expected outgoing offer')
      assert.ok(offerPayload.offerId, 'expected outgoing offer id')

      const encryptedAnswer = await encrypt(
        genKey('', appId, roomId),
        'mock-answer',
        buildSignalAad('answer', remotePeerId, offerPayload.offerId)
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
      assert.equal(errors[0]!.code, 'peer-connect-failed')
      assert.equal(errors[0]!.turnConfigured, false)
      assert.match(errors[0]!.message, /could not connect to peer/)
      assert.match(errors[0]!.message, /after exchanging SDP/)
      assert.match(errors[0]!.message, /TURN/)
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
    const errors: Array<{
      code: string
      message: string
      turnConfigured?: boolean
    }> = []
    const room = joinRoom(
      {
        appId,
        rtcPolyfill:
          FailingRTCPeerConnection as unknown as typeof RTCPeerConnection
      },
      roomId
    )
    room.onError(err =>
      errors.push({
        code: err.code,
        message: err.message,
        ...(err.code === 'peer-connect-failed'
          ? {turnConfigured: err.turnConfigured}
          : {})
      })
    )

    try {
      await waitFor(() => subscribers.length >= 1)
      const sub = subscribers[0]!
      const encryptedOffer = await encrypt(
        genKey('', appId, roomId),
        'mock-offer',
        buildSignalAad('offer', remotePeerId, 'offer-1')
      )
      let answerPayload = null as {answer?: string} | null

      await sub.onMessage(
        sub.selfTopic,
        {
          peerId: remotePeerId,
          offerId: 'offer-1',
          offer: encryptedOffer
        },
        (_topic, msg) => {
          answerPayload = JSON.parse(msg) as {answer?: string}
        }
      )

      await waitFor(() => Boolean(answerPayload?.answer))
      const answerPeerConnection = FailingRTCPeerConnection.instances.find(
        pc => pc.remoteDescription?.type === 'offer'
      )
      assert.ok(answerPeerConnection, 'expected answer peer connection')
      answerPeerConnection.failIce()

      await waitFor(() => errors.length > 0)
      assert.equal(errors[0]!.code, 'peer-connect-failed')
      assert.equal(errors[0]!.turnConfigured, false)
      assert.match(errors[0]!.message, /could not connect to peer/)
      assert.match(errors[0]!.message, /after exchanging SDP/)
      assert.match(errors[0]!.message, /TURN/)
    } finally {
      await room.leave().catch(() => {})
    }
  }
)

for (const failure of ['decrypt', 'remote SDP'] as const) {
  void test(`Trystero: failed ${failure} disposes answering peers before room leave`, async () => {
    class RejectedOfferConnection extends FailingRTCPeerConnection {
      override async setRemoteDescription(description?: {
        type: string
        sdp?: string
      }) {
        if (failure === 'remote SDP') {
          throw new Error('invalid remote SDP')
        }
        await super.setRemoteDescription(description)
      }
    }
    FailingRTCPeerConnection.instances = []
    const subscribers: Subscriber[] = []
    const appId = `failed-answer-${failure}`
    const roomId = 'room'
    const room = createTestStrategy(subscribers)(
      {appId, rtcPolyfill: RejectedOfferConnection as never},
      roomId
    )
    try {
      await waitFor(() => subscribers.length > 0)
      const roomKey = genKey('', appId, roomId)
      for (let i = 0; i < 3; i++) {
        const offerId = String(i)
        const offer =
          failure === 'decrypt'
            ? 'invalid ciphertext'
            : await encrypt(
                roomKey,
                'invalid SDP',
                buildSignalAad('offer', 'remote', offerId)
              )
        await subscribers[0]!.onMessage(
          subscribers[0]!.rootTopic,
          {peerId: 'remote', offer, offerId},
          () => {}
        )
      }
      assert.equal(
        FailingRTCPeerConnection.instances.length,
        failure === 'decrypt' ? 0 : 3
      )
      assert.ok(
        FailingRTCPeerConnection.instances.every(
          pc => pc.connectionState === 'closed'
        )
      )
      await room.leave()
      assert.ok(
        FailingRTCPeerConnection.instances.every(
          pc => pc.connectionState === 'closed'
        )
      )
    } finally {
      await room.leave()
      FailingRTCPeerConnection.instances.forEach(pc => pc.close())
    }
  })
}
