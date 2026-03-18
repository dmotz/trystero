import test from 'node:test'
import assert from 'node:assert/strict'
import strategy from '../src/strategy.js'
import {encrypt, genKey, sha1} from '../src/crypto.js'
import {libName, selfId, topicPath, toJson} from '../src/utils.js'

if (typeof globalThis.RTCIceCandidate === 'undefined') {
  globalThis.RTCIceCandidate = class RTCIceCandidate {
    constructor(c) {
      Object.assign(this, c)
    }
  }
}

test('strategy queues trickle candidates until a peer exists', async () => {
  const addIceCandidateCalls = []

  globalThis.RTCPeerConnection = function () {
    return {
      iceGatheringState: 'complete',
      localDescription: {type: 'answer', sdp: 'v=0\r\n'},
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
        removeEventListener: () => {},
        close: () => {}
      }),
      close: () => {}
    }
  }

  let onMessage

  const joinRoom = strategy({
    trickle: true,
    init: () => Promise.resolve({}),
    subscribe: async (_relay, _rootTopic, _selfTopic, handler) => {
      onMessage = handler
      return () => {}
    },
    announce: async () => {}
  })

  const config = {appId: 'test-app', password: 'pw'}
  const r = joinRoom(config, 'room-1')

  // allow subscribe() (and async sha1()) to run and capture handler
  for (let i = 0; i < 100 && !onMessage; i++) {
    await new Promise(res => setTimeout(res, 10))
  }
  assert.ok(onMessage, 'subscribe should provide onMessage handler')

  const rootTopicPlaintext = topicPath(libName, config.appId, 'room-1')
  const selfTopic = await sha1(topicPath(rootTopicPlaintext, selfId))
  const key = genKey(config.password, config.appId, 'room-1')

  const remotePeerId = 'remote-peer'

  const plainCandidate = {
    type: 'candidate',
    candidate: {
      candidate: 'c1',
      sdpMid: '0',
      sdpMLineIndex: 0,
      usernameFragment: null
    }
  }

  const candidateMsg = toJson({
    peerId: remotePeerId,
    candidate: {
      type: 'candidate',
      candidate: await encrypt(key, toJson(plainCandidate.candidate))
    }
  })

  // candidate arrives before any offer/answer peer object exists
  await onMessage(selfTopic, candidateMsg, () => {})
  assert.equal(addIceCandidateCalls.length, 0)

  const offerSdp = 'v=0\r\na=ice-options:trickle\r\n'
  const offerMsg = toJson({
    peerId: remotePeerId,
    offer: {
      type: 'offer',
      sdp: await encrypt(key, offerSdp)
    }
  })

  const sentSignals = []
  await onMessage(selfTopic, offerMsg, (topic, signal) =>
    sentSignals.push({topic, signal})
  )

  assert.ok(sentSignals.length >= 1, 'offer should produce an answer signal')
  assert.equal(addIceCandidateCalls.length, 1)
  assert.equal(addIceCandidateCalls[0].candidate, 'c1')

  await r.leave()
})

