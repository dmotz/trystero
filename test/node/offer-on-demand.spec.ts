import assert from 'node:assert/strict'
import test from './test.ts'
import {createOfferManager} from '../../packages/core/src/offer-manager.ts'
import createStrategy from '../../packages/core/src/strategy.ts'
import type {PeerHandle} from '../../packages/core/src/types.ts'

void test(
  'Trystero: strategy creates offers on demand and reclaims unused peers',
  {timeout: 10_000},
  async () => {
    class MockDataChannel {
      readyState = 'connecting'
      binaryType = 'arraybuffer'
      bufferedAmountLowThreshold = 0
      onmessage: ((ev: {data: unknown}) => void) | null = null
      onopen: (() => void) | null = null
      onclose: (() => void) | null = null
      onerror: ((ev: unknown) => void) | null = null

      close() {
        this.readyState = 'closed'
        this.onclose?.()
      }

      send() {}
    }

    class CountingRTCPeerConnection {
      static created = 0
      static closed = 0

      iceGatheringState = 'complete'
      connectionState = 'new'
      iceConnectionState = 'new'
      signalingState = 'stable'
      localDescription: {type: string; sdp?: string} | null = null
      onnegotiationneeded: (() => void) | null = null
      onconnectionstatechange: (() => void) | null = null
      ontrack: ((ev: unknown) => void) | null = null
      ondatachannel: ((ev: unknown) => void) | null = null
      offerNum = 0
      listeners: Record<string, Set<() => void>> = {}

      constructor() {
        CountingRTCPeerConnection.created += 1
      }

      createDataChannel() {
        return new MockDataChannel()
      }

      addEventListener(event: string, fn: () => void) {
        ;(this.listeners[event] ??= new Set()).add(fn)
      }

      removeEventListener(event: string, fn: () => void) {
        this.listeners[event]?.delete(fn)
      }

      restartIce() {}

      async createOffer() {
        this.offerNum += 1
        return {type: 'offer', sdp: `mock-offer-${this.offerNum}`}
      }

      async setLocalDescription(description?: {type: string; sdp?: string}) {
        if (description?.type === 'rollback') {
          this.signalingState = 'stable'
          return
        }

        const nextDescription = description ?? (await this.createOffer())
        this.localDescription = nextDescription
        this.signalingState =
          nextDescription.type === 'offer' ? 'have-local-offer' : 'stable'

        this.listeners['icegatheringstatechange']?.forEach(listener => {
          listener()
        })
      }

      async setRemoteDescription() {
        this.signalingState = 'stable'
      }

      close() {
        CountingRTCPeerConnection.closed += 1
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

    let complete: (() => void) | undefined
    let createdBeforeRequest = -1
    let createdAfterRequest = -1
    let closedAfterReclaim = -1
    const completePromise = new Promise<void>(res => {
      complete = res
    })

    const joinRoom = createStrategy({
      init: () => ({}),
      subscribe: async (_, _root, _self, _onMessage, getOffers) => {
        createdBeforeRequest = CountingRTCPeerConnection.created
        const offers = await getOffers(3)
        createdAfterRequest = CountingRTCPeerConnection.created
        offers.forEach(offer => offer.reclaim?.())
        closedAfterReclaim = CountingRTCPeerConnection.closed
        complete?.()
        return () => {}
      },
      announce: () => {}
    })

    const room = joinRoom(
      {
        appId: `trystero-on-demand-offers-${Date.now()}`,
        password: 'offer-test',
        rtcPolyfill:
          CountingRTCPeerConnection as unknown as typeof RTCPeerConnection
      },
      'room'
    )

    try {
      assert.equal(CountingRTCPeerConnection.created, 0)
      await completePromise
      assert.equal(createdBeforeRequest, 0)
      assert.equal(createdAfterRequest, 3)
      assert.equal(closedAfterReclaim, 3)
    } finally {
      await room.leave()
    }
  }
)

void test('Trystero: leaving during offer creation closes the pending peer', async () => {
  let release!: (offer: string) => void
  let closed = 0
  const pendingOffer = new Promise<string>(resolve => (release = resolve))
  const manager = createOfferManager(
    () => ({destroy: () => (closed += 1)}) as unknown as PeerHandle
  )

  const result = manager.checkout(1, false, async () => pendingOffer)
  manager.destroy()
  release('offer')

  await assert.rejects(result, /room left while preparing offer/)
  assert.equal(closed, 1)
})

void test('Trystero: createOfferManager retries once on encrypt failure and manages leased peers', async () => {
  let created = 0
  let destroyed = 0
  const makeFakePeer = () => {
    created += 1
    let isDead = false
    return {
      get isDead() {
        return isDead
      },
      destroy() {
        if (!isDead) {
          isDead = true
          destroyed += 1
        }
      }
    } as unknown as PeerHandle
  }

  const manager = createOfferManager(makeFakePeer)
  let attempts = 0
  const [retriedRecord] = await manager.getOffers(1, async () => {
    attempts += 1
    if (attempts === 1) {
      throw new Error('transient encrypt failure')
    }
    return 'encrypted-offer'
  })

  assert.equal(
    created,
    2,
    'should allocate a second peer after transient failure'
  )
  assert.equal(
    destroyed,
    1,
    'failed first peer should be destroyed immediately'
  )
  assert.equal(retriedRecord!.offer, 'encrypted-offer')

  // Claiming a leased offer keeps the peer alive even when manager.destroy() runs
  retriedRecord!.claim?.()
  const [unclaimedRecord] = await manager.getOffers(1, async () => 'offer-2')
  assert.equal(created, 3)

  manager.destroy()
  assert.equal(retriedRecord!.peer.isDead, false, 'claimed peer stays open')
  assert.equal(
    unclaimedRecord!.peer.isDead,
    true,
    'unclaimed leased peer is destroyed on manager.destroy()'
  )
})
