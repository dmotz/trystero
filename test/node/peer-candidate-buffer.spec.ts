import assert from 'node:assert/strict'
import test from 'node:test'
import initPeer from '../../packages/core/src/peer.ts'

class MockRTCPeerConnection {
  connectionState = 'new'
  signalingState = 'stable'
  remoteDescription = null
  localDescription = null
  iceGatheringState = 'complete'
  candidates = []

  addEventListener() {}
  removeEventListener() {}

  async addIceCandidate(candidate) {
    this.candidates.push(candidate)
  }

  async setRemoteDescription(description) {
    this.remoteDescription = description
  }

  async setLocalDescription() {
    this.localDescription = {type: 'answer', sdp: 'answer'}
  }

  close() {
    this.connectionState = 'closed'
  }
}

void test('remote candidates queued before an offer have a bounded count and size', async () => {
  const peer = initPeer(false, {
    appId: 'test',
    rtcPolyfill: MockRTCPeerConnection as any
  })
  const candidate = (value: string) => ({
    type: 'candidate' as const,
    sdp: JSON.stringify({candidate: value, sdpMLineIndex: 0})
  })

  try {
    await peer.signal(candidate('x'.repeat(9_000)))

    for (let i = 0; i < 200; i++) {
      await peer.signal(candidate(`candidate:${i}`))
    }

    await peer.signal({type: 'offer', sdp: 'm=audio 9 UDP/TLS/RTP/SAVPF 0'})

    const conn = peer.connection as unknown as MockRTCPeerConnection
    assert.equal(conn.candidates.length, 128)
    assert.equal(
      conn.candidates.some(({candidate: value}) => value.length > 8_192),
      false
    )
  } finally {
    peer.destroy()
  }
})
