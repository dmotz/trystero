// @ts-nocheck
import assert from 'node:assert/strict'
import test from './test.ts'
import {createTopicStrategy} from '../../packages/core/src/index.ts'
import {encrypt, genKey} from '../../packages/core/src/crypto.ts'
import {MockPeer, MockRTCPeerConnection, waitFor} from './peer-harness.ts'

for (const channelState of ['closed', 'connecting']) {
  const title = `Trystero: issue 195 can rejoin after ${channelState} channel interrupts leave`

  void test(title, async () => {
    let root
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
      rtcPolyfill: MockRTCPeerConnection,
      _test_only_sharedPeerIdleMs: 10
    }
    const room = joinRoom(config, 'room')
    const peer = new MockPeer()
    let rejoinedRoom
    let sendCount = 0

    try {
      await waitFor(() => Boolean(root))
      const answer = await encrypt(genKey('', config.appId, 'room'), 'answer-sdp')
      await root.onMessage(root.topic, {peerId: 'remote-peer', answer, peer})
      await waitFor(() => Boolean(peer.handlers.data))

      peer.sendData = () => {
        sendCount++
        if (peer.channel.readyState !== 'open') {
          throw new DOMException('RTCDataChannel is not open', 'InvalidStateError')
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
      assert.equal(sendCount, channelState === 'closed' ? 1 : 2)
      rejoinedRoom = joinRoom(config, 'room')
      assert.notEqual(rejoinedRoom, room)
      assert.equal(initCount, 2)
      await room.leave()
      assert.equal(joinRoom(config, 'room'), rejoinedRoom)
    } finally {
      peer.sendData = () => {}
      await room.leave().catch(() => {})
      await rejoinedRoom?.leave()
    }
  })
}
