import {all, alloc, genId, mkErr, resetTimer} from './utils'
import type {OfferRecord, PeerHandle} from './types'

const offerLeaseTtlMs = 180_000
const defaultOfferIdSize = 20
const offerRoomLeftErr = mkErr('room left while preparing offer')

export class OfferManager {
  private leased = new Map<PeerHandle, ReturnType<typeof setTimeout>>()
  private destroyed = false
  private makeOffer: () => PeerHandle

  constructor(makeOffer: () => PeerHandle) {
    this.makeOffer = makeOffer
  }

  claimLeased(peer: PeerHandle): void {
    const timer = this.leased.get(peer)

    if (timer) {
      resetTimer(timer)
      this.leased.delete(peer)
    }
  }

  reclaimLeased(peer: PeerHandle): void {
    if (this.leased.has(peer)) {
      this.claimLeased(peer)
      peer.destroy()
    }
  }

  checkout(
    n: number,
    leaseOffers: boolean,
    encryptOffer: (peer: PeerHandle, offerId: string) => Promise<string>,
    offerIdSize: number = defaultOfferIdSize
  ): Promise<OfferRecord[]> {
    const toRecord = async (didRetry = false): Promise<OfferRecord> => {
      if (this.destroyed) {
        throw offerRoomLeftErr
      }

      const peer = this.makeOffer()
      const offerId = genId(offerIdSize)

      try {
        const offer = await encryptOffer(peer, offerId)

        if (this.destroyed) {
          throw offerRoomLeftErr
        }

        if (leaseOffers) {
          this.leased.set(
            peer,
            setTimeout(() => {
              this.leased.delete(peer)
              peer.destroy()
            }, offerLeaseTtlMs)
          )

          return {
            peer,
            offer,
            offerId,
            claim: () => this.claimLeased(peer),
            reclaim: () => this.reclaimLeased(peer)
          }
        }

        return {peer, offer, offerId}
      } catch (error) {
        peer.destroy()

        if (!didRetry && !this.destroyed) {
          return toRecord(true)
        }

        throw error
      }
    }

    return all(alloc(n, () => toRecord()))
  }

  getOffers(
    n: number,
    encryptOffer: (peer: PeerHandle, offerId: string) => Promise<string>
  ): Promise<OfferRecord[]> {
    return this.checkout(n, true, encryptOffer)
  }

  destroy(): void {
    this.destroyed = true
    this.leased.forEach((timer, peer) => {
      resetTimer(timer)
      peer.destroy()
    })
    this.leased.clear()
  }
}
