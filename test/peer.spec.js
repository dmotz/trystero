import {test, expect} from '@playwright/test'
import initPeer from '../src/peer.js'

test('waitForIceGathering cleans up ice listener on timeout', async () => {
  const iceStateEvent = 'icegatheringstatechange'

  let pc

  class MockRTCPeerConnection {
    constructor() {
      pc = this
      this.canTrickleIceCandidates = true
      this.connectionState = 'connected'
      this.signalingState = 'stable'
      this.iceGatheringState = 'gathering'
      this.localDescription = {
        type: 'offer',
        sdp: 'a=ice-options:trickle \nplaceholder'
      }
      this._listeners = new Map()
    }

    addEventListener(event, handler) {
      this._listeners.set(event, handler)
      if (event === iceStateEvent) {
        this.addedListener = true
      }
    }

    removeEventListener(event, handler) {
      this.removedCount = (this.removedCount || 0) + 1
      if (event === iceStateEvent) {
        this.removedMatchedHandler = handler === this._listeners.get(event)
      }
    }

    createDataChannel() {
      throw new Error('createDataChannel should not be called in this test')
    }

    setRemoteDescription() {
      this.signalingState = 'stable'
      return Promise.resolve()
    }

    setLocalDescription() {
      this.localDescription = {
        type: 'answer',
        sdp: 'a=ice-options:trickle \nhello'
      }
      return Promise.resolve()
    }

    close() {}
  }

  const originalSetTimeout = globalThis.setTimeout
  try {
    globalThis.setTimeout = cb => {
      cb()
      return 1
    }

    const peer = initPeer(false, {
      rtcConfig: {},
      rtcPolyfill: MockRTCPeerConnection,
      turnConfig: []
    })

    await peer.signal({type: 'offer', sdp: 'v=0'})

    expect(pc.addedListener).toBe(true)
    expect(pc.removedCount).toBeGreaterThan(0)
  } finally {
    globalThis.setTimeout = originalSetTimeout
  }
})

test('peer.signal returns answer with RTCIceCandidate mismatch', async () => {
  class GlobalIceCandidate {}
  class PolyfillIceCandidate {}

  globalThis.RTCIceCandidate = GlobalIceCandidate

  class MockRTCPeerConnection {
    constructor() {
      this.canTrickleIceCandidates = true
      this.connectionState = 'connected'
      this.signalingState = 'stable'
      this._iceGatheringState = 'complete'
      this.localDescription = {
        type: 'offer',
        sdp: 'a=ice-options:trickle \nplaceholder'
      }
    }

    get iceGatheringState() {
      return this._iceGatheringState
    }

    addEventListener() {}
    removeEventListener() {}

    createDataChannel() {
      throw new Error('createDataChannel should not be called in this test')
    }

    setRemoteDescription() {
      if (globalThis.RTCIceCandidate !== PolyfillIceCandidate) {
        throw new Error('RTCIceCandidate mismatch')
      }
      this.signalingState = 'stable'
      return Promise.resolve()
    }

    setLocalDescription() {
      this.localDescription = {
        type: 'answer',
        sdp: 'a=ice-options:trickle \nhello'
      }
      return Promise.resolve()
    }

    close() {}
  }

  try {
    const peer = initPeer(false, {
      rtcConfig: {},
      rtcPolyfill: MockRTCPeerConnection,
      turnConfig: []
    })

    const answer = await peer.signal({type: 'offer', sdp: 'v=0'})

    expect(answer).toBeDefined()
    expect(answer.type).toBe('answer')
  } finally {
    delete globalThis.RTCIceCandidate
  }
})

