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

void test('a restarted prewarmed offer does not queue in pendingSignals or destroy its shared peer', async t => {
  const peer = initPeer(true, {
    appId: 'restarted-prewarmed-offer-test',
    rtcPolyfill: MockRTCPeerConnection as never
  })
  const manager = new SharedPeerManager()
  let joins = 0
  const replayedSignals: unknown[] = []
  const room = manager.registerRoom(
    'restarted-prewarmed-offer-test',
    'room',
    Promise.resolve('room-token'),
    {
      active: true,
      onPeer: proxy => {
        joins++
        proxy.setHandlers({signal: signal => replayedSignals.push(signal)})
      },
      onDetach: () => {}
    }
  )
  t.after(() => {
    room.leave()
    peer.destroy()
  })

  await peer.getOffer()
  const restarted = await peer.getOffer(true)
  assert.ok(restarted)
  assert.equal(restarted.type, 'offer')

  room.connect('remote', peer, 60_000)
  assert.equal(joins, 1)
  assert.equal(peer.isDead, false)
  assert.deepEqual(replayedSignals, [])
})

void test('spurious negotiationneeded while have-local-offer does not create a conflicting offer', async t => {
  class StrictRTCPeerConnection extends MockRTCPeerConnection {
    offerCalls = 0

    override async createOffer() {
      this.offerCalls++
      return super.createOffer()
    }
  }

  const peer = initPeer(true, {
    appId: 'spurious-negotiation-test',
    rtcPolyfill: StrictRTCPeerConnection as never
  })
  t.after(() => peer.destroy())
  const errors: Error[] = []
  peer.setHandlers({error: error => errors.push(error)})
  const pc = peer.connection as unknown as StrictRTCPeerConnection

  await peer.getOffer()
  assert.equal(pc.signalingState, 'have-local-offer')
  assert.equal(pc.offerCalls, 1)

  pc.onnegotiationneeded?.()
  await Promise.resolve()
  assert.equal(pc.offerCalls, 1)
  assert.deepEqual(errors, [])
})

void test('non-trickle offer resolves once gathered candidates settle without waiting for full iceTimeout', async t => {
  class StalledGatheringRTCPeerConnection extends MockRTCPeerConnection {
    override iceGatheringState = 'gathering'

    override async setLocalDescription(description) {
      const nextDescription = description ?? (await this.createOffer())
      this.localDescription = {
        type: nextDescription.type,
        sdp: 'v=0\r\na=candidate:1 1 udp 2113937151 127.0.0.1 50000 typ host\r\n'
      }
      this.signalingState = 'have-local-offer'
      this.listeners['icegatheringstatechange']?.forEach(listener => listener())

      queueMicrotask(() => {
        const candidateLine =
          'candidate:2 1 udp 1677729535 203.0.113.5 50000 typ srflx raddr 0.0.0.0 rport 0'
        this.localDescription = {
          type: 'offer',
          sdp: `${this.localDescription.sdp}a=${candidateLine}\r\n`
        }
        this.listeners['icecandidate']?.forEach(listener =>
          listener({candidate: {candidate: candidateLine}})
        )
      })
    }
  }

  const start = Date.now()
  const peer = initPeer(true, {
    appId: 'stalled-gathering-settle-test',
    trickleIce: false,
    rtcPolyfill: StalledGatheringRTCPeerConnection as never
  })
  t.after(() => peer.destroy())

  const offer = await peer.getOffer()
  const elapsedMs = Date.now() - start

  assert.ok(offer)
  assert.equal(offer.type, 'offer')
  assert.match(offer.sdp, /typ srflx/)
  assert.ok(
    elapsedMs < 1_500,
    `expected non-trickle offer to settle quickly (<1500ms), got ${elapsedMs}ms`
  )
})

void test('polite peer glare offer while makingOffer in stable state answers without invalid rollback', async t => {
  let resolveCreateOffer:
    | ((offer: {type: string; sdp: string}) => void)
    | null = null

  class PoliteGlareRTCPeerConnection extends MockRTCPeerConnection {
    answersCreated = 0

    override async createOffer(): Promise<{type: string; sdp: string}> {
      return new Promise(resolve => {
        resolveCreateOffer = resolve
      })
    }

    async createAnswer() {
      this.answersCreated++
      return {type: 'answer', sdp: 'polite-answer'}
    }

    override async setRemoteDescription(description) {
      this.remoteDescription = description
      this.signalingState =
        description?.type === 'offer' ? 'have-remote-offer' : 'stable'
    }

    override async setLocalDescription(description) {
      if (
        description?.type === 'rollback' &&
        this.signalingState === 'stable'
      ) {
        throw new Error('Cannot rollback in stable state')
      }
      if (!description && this.signalingState === 'have-remote-offer') {
        const answer = await this.createAnswer()
        this.localDescription = answer
        this.signalingState = 'stable'
        return
      }
      await super.setLocalDescription(description)
    }
  }

  const peer = initPeer(false, {
    appId: 'polite-glare-stable-test',
    rtcPolyfill: PoliteGlareRTCPeerConnection as never
  })
  t.after(() => peer.destroy())
  const errors: Error[] = []
  const signals: Array<{type?: string; sdp?: string}> = []
  peer.setHandlers({
    error: error => errors.push(error),
    signal: signal => signals.push(signal as never)
  })
  const pc = peer.connection as unknown as PoliteGlareRTCPeerConnection

  pc.onnegotiationneeded?.()
  assert.equal(pc.signalingState, 'stable')

  await peer.signal({type: 'offer', sdp: 'v=0\r\na=ice-ufrag:newufrag\r\n'})
  resolveCreateOffer?.({type: 'offer', sdp: 'stale-local-offer'})

  assert.deepEqual(errors, [])
  assert.equal(pc.answersCreated, 1)
  assert.ok(signals.some(signal => signal.type === 'answer'))
})

void test('initial getOffer settles when createOffer rejects or peer is destroyed early', async () => {
  class FailingOfferRTCPeerConnection extends MockRTCPeerConnection {
    override async createOffer(): Promise<{type: string; sdp: string}> {
      throw new Error('createOffer failed')
    }
  }

  const failingPeer = initPeer(true, {
    appId: 'failing-initial-offer-test',
    rtcPolyfill: FailingOfferRTCPeerConnection as never
  })
  const failedOffer = await failingPeer.getOffer()
  assert.equal(failedOffer, undefined)
  failingPeer.destroy()

  class HangingOfferRTCPeerConnection extends MockRTCPeerConnection {
    override async createOffer(): Promise<{type: string; sdp: string}> {
      return new Promise(() => {})
    }
  }

  const destroyedPeer = initPeer(true, {
    appId: 'destroyed-initial-offer-test',
    rtcPolyfill: HangingOfferRTCPeerConnection as never
  })
  const offerPromise = destroyedPeer.getOffer()
  destroyedPeer.destroy()
  assert.equal(await offerPromise, undefined)
})

void test('queued remote candidates drop stale ufrags and evict oldest entries at capacity', async t => {
  class CandidateTrackingRTCPeerConnection extends MockRTCPeerConnection {
    addedCandidates: Array<{candidate: string; usernameFragment?: string}> = []

    async addIceCandidate(candidate) {
      this.addedCandidates.push(candidate)
    }
  }

  const peer = initPeer(true, {
    appId: 'candidate-queue-test',
    rtcPolyfill: CandidateTrackingRTCPeerConnection as never
  })
  t.after(() => peer.destroy())
  const pc = peer.connection as unknown as CandidateTrackingRTCPeerConnection

  await peer.getOffer()

  await peer.signal({
    type: 'candidate',
    sdp: JSON.stringify({
      candidate: 'candidate:stale 1 udp 1 127.0.0.1 4000 typ host',
      usernameFragment: 'stale-ufrag'
    })
  })

  for (let i = 0; i < 260; i++) {
    await peer.signal({
      type: 'candidate',
      sdp: JSON.stringify({
        candidate: `candidate:${i} 1 udp 1 127.0.0.1 ${5000 + i} typ host`,
        usernameFragment: 'active-ufrag'
      })
    })
  }

  await peer.signal({
    type: 'answer',
    sdp: 'v=0\r\na=ice-ufrag:active-ufrag\r\n'
  })

  assert.equal(pc.addedCandidates.length, 128)
  assert.ok(
    pc.addedCandidates.every(c => c.usernameFragment === 'active-ufrag')
  )
  assert.match(pc.addedCandidates[0].candidate, /^candidate:132 /)
  assert.match(pc.addedCandidates.at(-1)!.candidate, /^candidate:259 /)
})
