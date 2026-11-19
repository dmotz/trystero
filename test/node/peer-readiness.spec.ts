import assert from 'node:assert/strict'
import {test} from 'node:test'
import createPeer from '../../packages/core/src/peer.ts'
import {MockDataChannel, MockRTCPeerConnection} from './peer-harness.ts'

const offer = {type: 'offer', sdp: 'a=fingerprint:sha-256 AA:BB\r\n'} as const
const answer = {type: 'answer', sdp: 'a=fingerprint:sha-256 CC:DD\r\n'} as const

class NativePeer extends MockRTCPeerConnection {
  channel = new MockDataChannel()
  applyAnswer = Promise.withResolvers<void>()

  override createDataChannel() {
    return this.channel
  }

  override async setLocalDescription(description?: RTCSessionDescriptionInit) {
    await super.setLocalDescription(
      description ?? (this.remoteDescription ? answer : offer)
    )
  }

  override async setRemoteDescription(description?: RTCSessionDescriptionInit) {
    if (description?.type === 'answer') {
      this.openChannel()
      await this.applyAnswer.promise
    }
    await super.setRemoteDescription(description)
  }

  openChannel() {
    this.channel.readyState = 'open'
    this.channel.onopen?.()
  }

  notifySignalingState() {
    this.listeners['signalingstatechange']?.forEach(listener => listener())
  }
}

const setup = (initiator: boolean) => {
  const peer = createPeer(initiator, {
    appId: 'test',
    rtcPolyfill: NativePeer as unknown as typeof RTCPeerConnection
  })
  const pc = peer.connection as unknown as NativePeer
  const connections: [string | undefined, string | undefined][] = []
  const connect = () => {
    connections.push([pc.localDescription?.sdp, pc.remoteDescription?.sdp])
  }
  return {peer, pc, connect, connections}
}

void test('waits for the native remote answer after an early channel open', async t => {
  const {peer, pc, connect, connections} = setup(true)
  t.after(() => peer.destroy())
  assert.deepEqual(await peer.getOffer(), offer)
  peer.setHandlers({connect})

  const pendingAnswer = peer.signal(answer)
  assert.equal(pc.channel.readyState, 'open')
  const beforeAnswer = connections.slice()
  pc.applyAnswer.resolve()
  await pendingAnswer
  assert.deepEqual(beforeAnswer, [])
  assert.deepEqual(connections, [[offer.sdp, answer.sdp]])
  pc.channel.onopen?.()
  pc.notifySignalingState()
  peer.setHandlers({connect})
  assert.deepEqual(connections, [[offer.sdp, answer.sdp]])
})

void test('processes an initial offer when the channel is already open', async t => {
  const {peer, pc, connect, connections} = setup(false)
  t.after(() => peer.destroy())
  peer.setHandlers({connect})
  pc.openChannel()
  pc.ondatachannel?.({channel: pc.channel})
  assert.deepEqual(connections, [])

  const localAnswer = await peer.signal(offer)
  assert.deepEqual(localAnswer, answer)
  assert.deepEqual(connections, [[answer.sdp, offer.sdp]])
  pc.channel.onopen?.()
  assert.deepEqual(connections, [[answer.sdp, offer.sdp]])
})

void test('connects once on channel open when SDP is already observable', async t => {
  const {peer, pc, connect, connections} = setup(false)
  t.after(() => peer.destroy())
  peer.setHandlers({connect})
  pc.ondatachannel?.({channel: pc.channel})
  assert.deepEqual(await peer.signal(offer), answer)
  assert.deepEqual(connections, [])

  pc.openChannel()
  assert.deepEqual(connections, [[answer.sdp, offer.sdp]])
  pc.channel.onopen?.()
  pc.notifySignalingState()
  assert.deepEqual(connections, [[answer.sdp, offer.sdp]])
})

for (const lateHandler of [false, true]) {
  void test(`connects once for an already-open incoming channel with ${lateHandler ? 'a late' : 'an existing'} handler`, async t => {
    const {peer, pc, connect, connections} = setup(false)
    t.after(() => peer.destroy())
    assert.deepEqual(await peer.signal(offer), answer)
    if (!lateHandler) {
      peer.setHandlers({connect})
    }
    pc.openChannel()
    pc.ondatachannel?.({channel: pc.channel})

    if (lateHandler) {
      assert.deepEqual(connections, [])
      peer.setHandlers({connect})
    }
    assert.deepEqual(connections, [[answer.sdp, offer.sdp]])
    pc.channel.onopen?.()
    peer.setHandlers({connect})
    assert.deepEqual(connections, [[answer.sdp, offer.sdp]])
  })
}

void test('connects when a signaling event makes the local description observable', async t => {
  const {peer, pc, connect, connections} = setup(false)
  t.after(() => peer.destroy())
  peer.setHandlers({connect})
  pc.ondatachannel?.({channel: pc.channel})
  pc.openChannel()
  pc.remoteDescription = offer
  pc.notifySignalingState()
  assert.deepEqual(connections, [])

  pc.localDescription = answer
  pc.notifySignalingState()
  pc.notifySignalingState()
  assert.deepEqual(connections, [[answer.sdp, offer.sdp]])
})

for (const teardown of ['close', 'destroy'] as const) {
  void test(`ignores late SDP and channel events after ${teardown}`, async t => {
    const {peer, pc, connect, connections} = setup(true)
    t.after(() => peer.destroy())
    await peer.getOffer()
    peer.setHandlers({connect})
    const pendingAnswer = peer.signal(answer)
    if (teardown === 'close') {
      pc.channel.close()
    } else {
      peer.destroy()
    }

    pc.applyAnswer.resolve()
    await pendingAnswer
    pc.notifySignalingState()
    pc.channel.onopen?.()
    peer.setHandlers({connect})
    assert.deepEqual(connections, [])
  })
}
