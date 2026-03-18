import test from 'node:test'
import assert from 'node:assert/strict'
import initPeer from '../src/peer.js'

if (typeof globalThis.RTCIceCandidate === 'undefined') {
  globalThis.RTCIceCandidate = class RTCIceCandidate {
    constructor(c) {
      Object.assign(this, c)
    }
  }
}

const makeMockPc = ({supportsTrickle}) => {
  const events = {}
  const pc = {
    iceGatheringState: 'new',
    localDescription: null,
    signalingState: 'stable',
    connectionState: 'new',
    canTrickleIceCandidates: supportsTrickle,
    addEventListener: (name, fn) => {
      events[name] = fn
    },
    removeEventListener: name => {
      delete events[name]
    },
    setLocalDescription: async desc => {
      pc.localDescription =
        desc ||
        ({
          type: 'offer',
          sdp: 'v=0\r\na=ice-options:trickle\r\n'
        })
      pc.iceGatheringState = 'complete'
      if (events.icegatheringstatechange) {
        events.icegatheringstatechange()
      }
    },
    setRemoteDescription: async () => {},
    addIceCandidate: async () => {},
    createDataChannel: () => ({
      bufferedAmountLowThreshold: 0xffff,
      addEventListener: () => {},
      removeEventListener: () => {}
    }),
    close: () => {}
  }

  return pc
}

test('peer uses non-trickle ICE by default', async () => {
  global.RTCPeerConnection = function () {
    return makeMockPc({supportsTrickle: true})
  }

  const signals = []

  const peer = initPeer(true, {})
  peer.setHandlers({
    signal: s => signals.push(s)
  })

  await peer.connection.onnegotiationneeded()

  assert.equal(signals.length, 1)
  assert.ok(!signals[0].sdp.includes('a=ice-options:trickle'))
})

test('peer uses trickle ICE when config.trickle is true', async () => {
  global.RTCPeerConnection = function () {
    return makeMockPc({supportsTrickle: true})
  }

  const signals = []

  const peer = initPeer(true, {trickle: true})
  peer.setHandlers({
    signal: s => signals.push(s)
  })

  await peer.connection.onnegotiationneeded()

  assert.equal(signals[0].type, 'offer')
  assert.ok(signals[0].sdp.includes('a=ice-options:trickle'))
})

test('peer in trickle mode sends SDP then candidate(s) when onicecandidate fires', async () => {
  const signals = []
  const pc = {
    iceGatheringState: 'new',
    localDescription: null,
    signalingState: 'stable',
    connectionState: 'new',
    canTrickleIceCandidates: true,
    addEventListener: () => {},
    removeEventListener: () => {},
    setLocalDescription: async () => {
      pc.localDescription = {
        type: 'offer',
        sdp: 'v=0\r\na=ice-options:trickle\r\n'
      }
      pc.iceGatheringState = 'complete'
      setImmediate(() => {
        if (pc.onicecandidate) {
          pc.onicecandidate({candidate: {candidate: 'c1', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: null}})
          pc.onicecandidate({candidate: null})
        }
      })
    },
    setRemoteDescription: async () => {},
    addIceCandidate: async () => {},
    createDataChannel: () => ({
      bufferedAmountLowThreshold: 0xffff,
      addEventListener: () => {},
      removeEventListener: () => {}
    }),
    close: () => {}
  }
  global.RTCPeerConnection = function () {
    return pc
  }

  const peer = initPeer(true, {trickle: true})
  peer.setHandlers({signal: s => signals.push(s)})

  await peer.connection.onnegotiationneeded()
  await new Promise(res => setImmediate(res))

  const sdpSignals = signals.filter(s => s.type === 'offer' || s.type === 'answer')
  const candidateSignals = signals.filter(s => s.type === 'candidate')
  assert.ok(sdpSignals.length >= 1, 'at least one SDP signal')
  assert.ok(sdpSignals[0].sdp.includes('a=ice-options:trickle'))
  assert.ok(candidateSignals.length >= 1, 'at least one candidate signal')
})

test('peer.signal with type candidate calls addIceCandidate when trickle is true', async () => {
  let addIceCandidateCalls = []
  const pc = {
    iceGatheringState: 'complete',
    localDescription: {type: 'offer', sdp: 'v=0\r\n'},
    signalingState: 'stable',
    connectionState: 'new',
    canTrickleIceCandidates: true,
    addEventListener: () => {},
    removeEventListener: () => {},
    setLocalDescription: async () => {},
    setRemoteDescription: async () => {},
    addIceCandidate: async c => {
      addIceCandidateCalls.push(c)
    },
    createDataChannel: () => ({
      bufferedAmountLowThreshold: 0xffff,
      addEventListener: () => {},
      removeEventListener: () => {}
    }),
    close: () => {}
  }
  global.RTCPeerConnection = function () {
    return pc
  }

  const peer = initPeer(false, {trickle: true})
  await peer.signal({
    type: 'candidate',
    candidate: {candidate: 'candidate', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: null}
  })

  assert.equal(addIceCandidateCalls.length, 1)
  assert.equal(addIceCandidateCalls[0].candidate, 'candidate')
})

test('peer.signal with type candidate is no-op when trickle is false', async () => {
  let addIceCandidateCalls = []
  const pc = {
    iceGatheringState: 'complete',
    localDescription: {type: 'offer', sdp: 'v=0\r\n'},
    signalingState: 'stable',
    connectionState: 'new',
    canTrickleIceCandidates: false,
    addEventListener: () => {},
    removeEventListener: () => {},
    setLocalDescription: async () => {},
    setRemoteDescription: async () => {},
    addIceCandidate: async c => {
      addIceCandidateCalls.push(c)
    },
    createDataChannel: () => ({
      bufferedAmountLowThreshold: 0xffff,
      addEventListener: () => {},
      removeEventListener: () => {}
    }),
    close: () => {}
  }
  global.RTCPeerConnection = function () {
    return pc
  }

  const peer = initPeer(false, {trickle: false})
  await peer.signal({
    type: 'candidate',
    candidate: {candidate: 'candidate', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: null}
  })

  assert.equal(addIceCandidateCalls.length, 0)
})

