import type {
  OfferCheckoutFn,
  OfferRecord,
  PeerHandle,
  Timeout
} from './internal-types'
import {
  all,
  alloc,
  genId,
  mkErr,
  resetTimer,
  unreachable,
  unrefTimer
} from './utils'

const offerLeaseTtlMs = 180_000
const defaultOfferIdSize = 20
const offerRoomLeftErr = /*@__PURE__*/ mkErr('room left while preparing offer')

type LeaseEntryState =
  | {readonly phase: 'leased'; readonly timer: Timeout}
  | {readonly phase: 'claimed'}
  | {readonly phase: 'closed'}

export type OfferManager = {
  checkout: OfferCheckoutFn
  getOffers: (
    n: number,
    encryptOffer: (peer: PeerHandle, offerId: string) => Promise<string>
  ) => Promise<OfferRecord[]>
  claimLeased: (peer: PeerHandle) => boolean
  reclaimLeased: (peer: PeerHandle) => void
  destroy: () => void
}

export const createOfferManager = (
  makeOffer: () => PeerHandle
): OfferManager => {
  const leaseStates = new WeakMap<PeerHandle, LeaseEntryState>()
  const activeLeases = new Set<PeerHandle>()
  let destroyed = false

  const closeLease = (peer: PeerHandle): void => {
    const entry = leaseStates.get(peer)
    if (entry?.phase === 'leased') {
      resetTimer(entry.timer)
    }
    activeLeases.delete(peer)
    leaseStates.set(peer, {phase: 'closed'})
    peer.destroy()
  }

  const claimLeased = (peer: PeerHandle): boolean => {
    if (destroyed || peer.isDead) {
      return false
    }
    const entry = leaseStates.get(peer)
    if (!entry) {
      return true
    }
    switch (entry.phase) {
      case 'leased':
        resetTimer(entry.timer)
        activeLeases.delete(peer)
        leaseStates.set(peer, {phase: 'claimed'})
        return true
      case 'claimed':
        return true
      case 'closed':
        return false
      default:
        return unreachable(entry)
    }
  }

  const reclaimLeased = (peer: PeerHandle): void => {
    if (leaseStates.get(peer)?.phase === 'leased') {
      closeLease(peer)
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
            if (leaseStates.get(peer)?.phase === 'leased') {
              closeLease(peer)
            }
          }, offerLeaseTtlMs)
          unrefTimer(timer)
          leaseStates.set(peer, {phase: 'leased', timer})
          activeLeases.add(peer)
          return {
            peer,
            offer,
            offerId,
            claim: () => {
              claimLeased(peer)
            },
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
      if (destroyed) {
        return
      }
      destroyed = true
      for (const peer of Array.from(activeLeases)) {
        closeLease(peer)
      }
    }
  }
}
