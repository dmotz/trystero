// @ts-nocheck
import assert from 'node:assert/strict'
import test from 'node:test'
import {createStrategy} from '@trystero/core'

void test(
  'Trystero: strategy reuses offer peers across repeated batch allocations',
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

    const runScenario = async (reuseOffers: boolean): Promise<number> => {
      CountingRTCPeerConnection.created = 0

      let complete = null
      const completePromise = new Promise(res => {
        complete = res
      })

      const joinRoom = createStrategy({
        init: () => ({}),
        subscribe: async (_, _root, _self, _onMessage, getOffers) => {
          for (let i = 0; i < 8; i += 1) {
            const offers = await getOffers(10)

            if (reuseOffers) {
              offers.forEach(offer => offer.reclaim?.())
            }

            await new Promise(res => setTimeout(res, 0))
          }

          complete?.()

          return () => {}
        },
        announce: () => {}
      })

      const room = joinRoom(
        {
          appId: `trystero-offer-reuse-${Date.now()}-${Math.random()}`,
          password: 'reuse-test',
          rtcPolyfill: CountingRTCPeerConnection
        },
        `room-${Math.random().toString(16).slice(2)}`
      )

      try {
        await completePromise
      } finally {
        await room.leave()
      }

      return CountingRTCPeerConnection.created
    }

    const unreclaimedConnections = await runScenario(false)
    const reclaimedConnections = await runScenario(true)

    assert.ok(
      reclaimedConnections < unreclaimedConnections,
      `expected reuse to lower allocations, got ${String(unreclaimedConnections)} without reuse vs ${String(reclaimedConnections)} with reuse`
    )
    assert.ok(
      reclaimedConnections <= 30,
      `expected <= 30 peer connections with reuse but saw ${String(reclaimedConnections)}`
    )
  }
)
