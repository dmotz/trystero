import type {OfferRecord} from './internal-types'
import {all, alloc, genId, mkErr, resetTimer} from './utils'
import type {PeerHandle} from './types'

const offerLeaseTtlMs = 180_000
const defaultOfferIdSize = 20
const offerRoomLeftErr = /*@__PURE__*/ mkErr('room left while preparing offer')

export type OfferCheckoutFn = (
  n: number,
  leaseOffers: boolean,
  encryptOffer: (peer: PeerHandle, offerId: string) => Promise<string>,
  offerIdSize?: number
) => Promise<OfferRecord[]>

export const initOfferManager = (
  makeOffer: () => PeerHandle
): readonly [
  checkout: OfferCheckoutFn,
  getOffers: (
    n: number,
    encryptOffer: (peer: PeerHandle, offerId: string) => Promise<string>
  ) => Promise<OfferRecord[]>,
  claimLeased: (peer: PeerHandle) => void,
  reclaimLeased: (peer: PeerHandle) => void,
  destroy: () => void
] => {
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
          leased.set(
            peer,
            setTimeout(() => {
              leased.delete(peer)
              peer.destroy()
            }, offerLeaseTtlMs)
          )
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

  return [
    checkout,
    (n, encryptOffer) => checkout(n, true, encryptOffer),
    claimLeased,
    reclaimLeased,
    () => {
      destroyed = true
      leased.forEach((timer, peer) => {
        resetTimer(timer)
        peer.destroy()
      })
      leased.clear()
    }
  ]
}

export class OfferManager {
  claimLeased: (peer: PeerHandle) => void
  reclaimLeased: (peer: PeerHandle) => void
  checkout: OfferCheckoutFn
  getOffers: (
    n: number,
    encryptOffer: (peer: PeerHandle, offerId: string) => Promise<string>
  ) => Promise<OfferRecord[]>
  destroy: () => void

  constructor(makeOffer: () => PeerHandle) {
    ;[
      this.checkout,
      this.getOffers,
      this.claimLeased,
      this.reclaimLeased,
      this.destroy
    ] = initOfferManager(makeOffer)
  }
}
