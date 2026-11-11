import assert from 'node:assert/strict'
import test from './test.ts'
import {
  createTopicStrategy,
  type StrategyMessage
} from '../../packages/core/src/index.ts'
import {encrypt, genKey} from '../../packages/core/src/crypto.ts'
import {buildSignalAad} from '../../packages/core/src/signal-handler.ts'
import {
  MockPeer,
  MockRTCPeerConnection,
  testPeerId,
  waitFor
} from './peer-harness.ts'

for (const channelState of ['closed', 'connecting']) {
  const title = `Trystero: issue 195 can rejoin after ${channelState} channel interrupts leave`

  void test(title, async () => {
    let root = null as {
      topic: string
      onMessage: (topic: string, msg: StrategyMessage) => void | Promise<void>
    } | null
    let initCount = 0
    const joinRoom = createTopicStrategy({
      init: () => {
        initCount++
        return {}
      },
      subscribeTopic: (_relay, topic, onMessage, {kind}) => {
        if (kind === 'root') {
          root = {topic, onMessage}
        }

        return () => {}
      },
      publishTopic: () => {}
    })
    const config = {
      appId: `leave-rejoin-${channelState}-${Date.now()}`,
      rtcPolyfill: MockRTCPeerConnection as unknown as typeof RTCPeerConnection
    }
    const room = joinRoom(config, 'room')
    const peer = new MockPeer()
    let rejoinedRoom: ReturnType<typeof joinRoom> | undefined
    let sendCount = 0

    const remotePeerId = testPeerId('remote-peer')

    try {
      await waitFor(() => Boolean(root))
      const answer = await encrypt(
        genKey('', config.appId, 'room'),
        'answer-sdp',
        buildSignalAad('answer', remotePeerId, 'offer-1')
      )
      await root!.onMessage(root!.topic, {
        peerId: remotePeerId,
        offerId: 'offer-1',
        answer,
        peer
      } as unknown as StrategyMessage)
      await waitFor(() => Boolean(peer.handlers.data))

      peer.sendData = () => {
        sendCount++
        if (peer.channel.readyState !== 'open') {
          throw new DOMException(
            'RTCDataChannel is not open',
            'InvalidStateError'
          )
        }

        if (channelState === 'connecting' && sendCount === 1) {
          queueMicrotask(() => {
            peer.channel.readyState = 'connecting'
          })
        }
      }

      if (channelState === 'closed') {
        peer.channel.readyState = 'closed'
      }

      await room.leave()
      assert.equal(sendCount, channelState === 'closed' ? 0 : 1)
      rejoinedRoom = joinRoom(config, 'room')
      assert.notEqual(rejoinedRoom, room)
      assert.equal(initCount, 2)
      await room.leave()
      assert.throws(() => joinRoom(config, 'room'), /already joined/)
    } finally {
      peer.sendData = () => {}
      await room.leave().catch(() => {})
      await rejoinedRoom?.leave()
    }
  })
}
