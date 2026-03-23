import {all, alloc, noOp, resetTimer} from './utils'
import type {OfferRecord, PeerHandle} from './types'

export const offerTtl = 57_333

const offerLeaseTtlMs = 180_000
const poolSize = 20

export class OfferPool {
  private pool: PeerHandle[] = []
  private pooled = new Set<PeerHandle>()
  private leased = new Map<PeerHandle, ReturnType<typeof setTimeout>>()
  private recycling = new Set<PeerHandle>()
  private cleanupTimer: ReturnType<typeof setInterval> | null = null
  private active = false

  constructor(private makeOffer: () => PeerHandle) {}

  get isActive(): boolean {
    return this.active
  }

  warmup(): void {
    this.pool = []
    this.pooled.clear()
    alloc(poolSize, this.makeOffer).forEach(p => this.push(p))
    this.active = true

    this.cleanupTimer = setInterval(() => {
      this.pool = this.pool.filter(peer => {
        if (peer.isDead) {
          this.pooled.delete(peer)
          return false
        }

        return true
      })
    }, offerTtl)
  }

  push(peer: PeerHandle): void {
    if (peer.isDead || this.pooled.has(peer) || this.leased.has(peer)) {
      return
    }

    this.pool.push(peer)
    this.pooled.add(peer)
  }

  shift(n: number): PeerHandle[] {
    const peers: PeerHandle[] = []

    while (peers.length < n && this.pool.length > 0) {
      const peer = this.pool.shift()

      if (!peer) {
        break
      }

      this.pooled.delete(peer)
      peers.push(peer)
    }

    return peers
  }

  claimLeased(peer: PeerHandle): void {
    const timer = this.leased.get(peer)

    if (timer) {
      resetTimer(timer)
      this.leased.delete(peer)
    }
  }

  recycle(peer: PeerHandle): void {
    if (peer.isDead || this.recycling.has(peer)) {
      return
    }

    if (peer.connection.remoteDescription) {
      peer.destroy()
      return
    }

    if (!this.active) {
      peer.destroy()
      return
    }

    this.recycling.add(peer)

    peer.setHandlers({
      connect: noOp,
      close: noOp,
      error: noOp
    })

    void peer
      .getOffer(true)
      .then(offer => {
        if (!offer || offer.type !== 'offer' || peer.isDead || !this.active) {
          peer.destroy()
          return
        }

        this.push(peer)
      })
      .catch(() => peer.destroy())
      .finally(() => this.recycling.delete(peer))
  }

  reclaimLeased(peer: PeerHandle): void {
    const timer = this.leased.get(peer)

    if (!timer) {
      return
    }

    resetTimer(timer)
    this.leased.delete(peer)
    this.recycle(peer)
  }

  private lease(peer: PeerHandle): void {
    this.claimLeased(peer)

    this.leased.set(
      peer,
      setTimeout(() => {
        this.leased.delete(peer)
        this.recycle(peer)
      }, offerLeaseTtlMs)
    )
  }

  checkout(
    n: number,
    leaseOffers: boolean,
    encryptOffer: (peer: PeerHandle) => Promise<string>
  ): Promise<OfferRecord[]> {
    const peers = this.shift(n)
    const missing = Math.max(0, n - peers.length)

    if (missing > 0) {
      peers.push(...alloc(missing, this.makeOffer))
    }

    const toRecord = async (
      candidate: PeerHandle,
      didRetry = false
    ): Promise<OfferRecord> => {
      try {
        const offer = await encryptOffer(candidate)

        if (leaseOffers) {
          this.lease(candidate)

          return {
            peer: candidate,
            offer,
            claim: () => this.claimLeased(candidate),
            reclaim: () => this.reclaimLeased(candidate)
          }
        }

        return {peer: candidate, offer}
      } catch (err) {
        this.claimLeased(candidate)
        this.pooled.delete(candidate)
        candidate.destroy()

        if (!didRetry) {
          return toRecord(this.makeOffer(), true)
        }

        throw err
      }
    }

    return all(peers.map(peer => toRecord(peer)))
  }

  getOffers(
    n: number,
    encryptOffer: (peer: PeerHandle) => Promise<string>
  ): Promise<OfferRecord[]> {
    return this.checkout(n, true, encryptOffer)
  }

  destroy(): void {
    this.active = false

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }

    this.pool.forEach(peer => peer.destroy())
    this.pool = []
    this.pooled.clear()

    this.leased.forEach((timeout, peer) => {
      resetTimer(timeout)
      peer.destroy()
    })
    this.leased.clear()
    this.recycling.forEach(peer => peer.destroy())
    this.recycling.clear()
  }
}
