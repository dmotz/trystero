// @ts-nocheck
import assert from 'node:assert/strict'
import test from 'node:test'
import createStrategy from '../../packages/core/src/strategy.ts'

class MockDataChannel {
  readyState = 'connecting'
  binaryType = 'arraybuffer'
  bufferedAmountLowThreshold = 0
  onmessage = null
  onopen = null
  onclose = null
  onerror = null

  close() {
    this.readyState = 'closed'
    this.onclose?.()
  }

  send() {}
}

class MockRTCPeerConnection {
  iceGatheringState = 'complete'
  connectionState = 'new'
  iceConnectionState = 'new'
  signalingState = 'stable'
  localDescription = null
  onconnectionstatechange = null
  listeners = {}

  createDataChannel() {
    return new MockDataChannel()
  }

  addEventListener(event, fn) {
    ;(this.listeners[event] ??= new Set()).add(fn)
  }

  removeEventListener(event, fn) {
    this.listeners[event]?.delete(fn)
  }

  restartIce() {}

  async createOffer() {
    return {type: 'offer', sdp: `mock-offer-${Math.random()}`}
  }

  async setLocalDescription(description) {
    if (description?.type === 'rollback') {
      this.signalingState = 'stable'
      return
    }

    const next = description ?? (await this.createOffer())
    this.localDescription = next
    this.signalingState = next.type === 'offer' ? 'have-local-offer' : 'stable'
    this.listeners['icegatheringstatechange']?.forEach(fn => fn())
  }

  async setRemoteDescription() {
    this.signalingState = 'stable'
  }

  close() {
    this.connectionState = 'closed'
    this.iceConnectionState = 'closed'
    this.onconnectionstatechange?.()
  }

  getSenders() {
    return []
  }

  addTrack() {
    return {}
  }

  removeTrack() {}
}

void test(
  'Trystero: announce loop continues after a single announce rejection',
  {timeout: 5_000},
  async () => {
    let announceCount = 0
    const joinErrors = []
    const warnings = []
    const realWarn = console.warn

    // Without the fix, queueAnnounce throws an unhandled rejection that
    // node:test would catch first. Swallow it so the assertion runs.
    const realEmit = process.emit.bind(process)
    process.emit = (event, ...args) => {
      if (event === 'unhandledRejection') {
        return true
      }

      return realEmit(event, ...args)
    }
    console.warn = (...args) => warnings.push(args)

    const joinRoom = createStrategy({
      init: () => ({}),
      subscribe: () => () => {},
      announce: () => {
        announceCount += 1

        if (announceCount === 1) {
          return Promise.reject(new Error('simulated announce failure'))
        }

        return undefined
      }
    })

    const room = joinRoom(
      {
        appId: `trystero-announce-supervision-${Date.now()}-${Math.random()}`,
        password: 'announce-supervision-test',
        rtcPolyfill: MockRTCPeerConnection
      },
      'r'
    )

    try {
      await new Promise(res => setTimeout(res, 800))

      assert.ok(
        announceCount >= 2,
        `expected the announce loop to keep firing after a rejection, but it stopped after ${announceCount} call(s)`
      )

      assert.equal(
        warnings.length,
        1,
        'first announce failure in a streak should be logged once'
      )
    } finally {
      console.warn = realWarn
      process.emit = realEmit
      await room.leave()
    }
  }
)
