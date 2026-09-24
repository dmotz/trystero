import assert from 'node:assert/strict'
import test from './test.ts'
// @ts-expect-error Internal source import crosses a referenced package boundary.
import {OfferManager} from '../../packages/core/src/offer-manager.ts'
// @ts-expect-error Internal source import crosses a referenced package boundary.
import createStrategy from '../../packages/core/src/strategy.ts'

void test(
  'Trystero: strategy creates offers on demand and reclaims unused peers',
  {timeout: 10_000},
  async () => {
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

    class CountingRTCPeerConnection {
      static created = 0
      static closed = 0

      iceGatheringState = 'complete'
      connectionState = 'new'
      iceConnectionState = 'new'
      signalingState = 'stable'
      localDescription = null
      onnegotiationneeded = null
      onconnectionstatechange = null
      ontrack = null
      ondatachannel = null
      offerNum = 0
      listeners = {}

      constructor(_) {
        CountingRTCPeerConnection.created += 1
      }

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
        this.offerNum += 1
        return {type: 'offer', sdp: `mock-offer-${this.offerNum}`}
      }

      async setLocalDescription(description) {
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

    let complete = null
    let createdBeforeRequest = -1
    let createdAfterRequest = -1
    let closedAfterReclaim = -1
    const completePromise = new Promise(res => {
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
        rtcPolyfill: CountingRTCPeerConnection as any
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
  const manager = new OfferManager(
    () => ({destroy: () => (closed += 1)}) as any
  )

  const result = manager.checkout(1, false, async () => pendingOffer)
  manager.destroy()
  release('offer')

  await assert.rejects(result, /room left while preparing offer/)
  assert.equal(closed, 1)
})
