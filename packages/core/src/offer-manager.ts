import type {OfferCheckoutFn, OfferRecord} from './internal-types'
import {all, alloc, genId, mkErr, resetTimer, unrefTimer} from './utils'
import type {PeerHandle} from './types'

const offerLeaseTtlMs = 180_000
const defaultOfferIdSize = 20
const offerRoomLeftErr = /*@__PURE__*/ mkErr('room left while preparing offer')

export type OfferManager = {
  checkout: OfferCheckoutFn
  getOffers: (
    n: number,
    encryptOffer: (peer: PeerHandle, offerId: string) => Promise<string>
  ) => Promise<OfferRecord[]>
  claimLeased: (peer: PeerHandle) => void
  reclaimLeased: (peer: PeerHandle) => void
  destroy: () => void
}

export const createOfferManager = (
  makeOffer: () => PeerHandle
): OfferManager => {
  const leased = new Map<PeerHandle, ReturnType<typeof setTimeout>>()
  let destroyed = false

  const claimLeased = (peer: PeerHandle): void => {
    const timer = leased.get(peer)
    if (timer) {
      resetTimer(timer)
      leased.delete(peer)
    }
  }

  const reclaimLeased = (peer: PeerHandle): void => {
    if (leased.has(peer)) {
      claimLeased(peer)
      peer.destroy()
    }
  }

  const checkout: OfferCheckoutFn = (
    n,
    leaseOffers,
    encryptOffer,
    offerIdSize = defaultOfferIdSize
  ) => {
    const toRecord = async (didRetry = false): Promise<OfferRecord> => {
      if (destroyed) {
        throw offerRoomLeftErr
      }
      const peer = makeOffer()
      const offerId = genId(offerIdSize)
      try {
        const offer = await encryptOffer(peer, offerId)
        if (destroyed) {
          throw offerRoomLeftErr
        }
        if (leaseOffers) {
          const timer = setTimeout(() => {
            leased.delete(peer)
            peer.destroy()
          }, offerLeaseTtlMs)
          unrefTimer(timer)
          leased.set(peer, timer)
          return {
            peer,
            offer,
            offerId,
            claim: () => claimLeased(peer),
            reclaim: () => reclaimLeased(peer)
          }
        }
        return {peer, offer, offerId}
      } catch (error) {
        peer.destroy()
        if (!didRetry && !destroyed) {
          return toRecord(true)
        }
        throw error
      }
    }
    return all(alloc(n, () => toRecord()))
  }

  return {
    checkout,
    getOffers: (n, encryptOffer) => checkout(n, true, encryptOffer),
    claimLeased,
    reclaimLeased,
    destroy: () => {
      destroyed = true
      leased.forEach((timer, peer) => {
        resetTimer(timer)
        peer.destroy()
      })
      leased.clear()
    }
  }
}
