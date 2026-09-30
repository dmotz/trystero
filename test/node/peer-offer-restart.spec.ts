import assert from 'node:assert/strict'
import test from './test.ts'
import {MockRTCPeerConnection} from './peer-harness.ts'
// @ts-expect-error Internal source import crosses a referenced package boundary.
import initPeer from '../../packages/core/src/peer.ts'
// @ts-expect-error Internal source import crosses a referenced package boundary.
import {SharedPeerManager} from '../../packages/core/src/shared-peer.ts'

void test('a prewarmed offer does not replay and destroy its connected room peer', async t => {
  const peer = initPeer(true, {
    appId: 'prewarmed-offer-test',
    rtcPolyfill: MockRTCPeerConnection as never
  })
  const manager = new SharedPeerManager()
  let joins = 0
  const room = manager.registerRoom(
    'prewarmed-offer-test',
    'room',
    Promise.resolve('room-token'),
    {
      active: true,
      onPeer: proxy => {
        joins++
        proxy.setHandlers({signal: () => {}})
      },
      onDetach: () => {}
    }
  )
  t.after(() => {
    room.leave()
    peer.destroy()
  })

  const offer = await peer.getOffer()
  assert.ok(offer)
  assert.equal(offer.type, 'offer')
  room.connect('remote', peer, 60_000)
  assert.equal(joins, 1)
  assert.equal(peer.isDead, false)
})

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
