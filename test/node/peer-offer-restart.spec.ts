import assert from 'node:assert/strict'
import test from './test.ts'
import {MockRTCPeerConnection} from './peer-harness.ts'
// @ts-expect-error Internal source import crosses a referenced package boundary.
import initPeer from '../../packages/core/src/peer.ts'

void test('unanswered offer restarts preserve the pending data channel without rollback', async t => {
  class TrackingRTCPeerConnection extends MockRTCPeerConnection {
    rollbacks = 0

    async setLocalDescription(description) {
      if (description?.type === 'rollback') {
        this.rollbacks++
      }
      await super.setLocalDescription(description)
    }
  }

  const peer = initPeer(true, {
    appId: 'offer-restart-test',
    rtcPolyfill: TrackingRTCPeerConnection as never
  })
  t.after(() => peer.destroy())
  const pc = peer.connection as unknown as TrackingRTCPeerConnection

  await peer.getOffer()
  assert.equal(pc.signalingState, 'have-local-offer')
  assert.equal(pc.remoteDescription, null)
  await peer.getOffer(true)
  assert.equal(pc.rollbacks, 0)
  assert.equal(pc.signalingState, 'have-local-offer')

  await peer.signal({type: 'answer', sdp: 'mock-answer'})
  assert.equal(pc.signalingState, 'stable')
  await peer.getOffer(true)
  await peer.getOffer(true)
  assert.equal(pc.rollbacks, 1)
})
