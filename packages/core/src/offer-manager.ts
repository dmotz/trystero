import type {
  CandidateSignal,
  OfferCheckoutFn,
  OfferRecord,
  PeerHandle,
  SignalContext,
  Timeout
} from './internal-types'
import {
  all,
  alloc,
  candidateType,
  genId,
  mkErr,
  noOp,
  resetTimer,
  unreachable,
  unrefTimer
} from './utils'

const offerLeaseTtlMs = 180_000
const defaultOfferIdSize = 20
const maxQueuedCandidates = 128
const offerRoomLeftErr = /*@__PURE__*/ mkErr('room left while preparing offer')

type LeaseEntryState =
  | {
      readonly phase: 'leased'
      readonly offerId: string
      readonly timer: Timeout
    }
  | {readonly phase: 'claimed'; readonly offerId: string}
  | {
      readonly phase: 'answered'
      readonly offerId: string
      readonly peerId: string
    }
  | {readonly phase: 'closed'}

type EncryptCandidate = (
  signal: CandidateSignal,
  offerId: string
) => Promise<string>

const offerCandidates = (
  peer: PeerHandle,
  offerId: string,
  encryptCandidate: EncryptCandidate,
  isActive: () => boolean
): NonNullable<OfferRecord['onCandidate']> => {
  let started = false
  return send => {
    if (started || !isActive()) {
      return noOp
    }
    started = true
    const queue: CandidateSignal[] = []
    let sender: typeof send | undefined = send
    let draining = false

    const stop = (): void => {
      sender = undefined
      queue.length = 0
    }

    const drain = async (): Promise<void> => {
      draining = true
      let signal: CandidateSignal | undefined
      while (sender && isActive() && (signal = queue.shift())) {
        try {
          const candidate = await encryptCandidate(signal, offerId)
          if (sender && isActive()) {
            await sender(candidate)
          }
        } catch {
          stop()
        }
      }
      if (!isActive()) {
        stop()
      }
      draining = false
    }

    peer.setHandlers({
      signal: signal => {
        if (!isActive()) {
          stop()
        } else if (
          sender &&
          signal.type === candidateType &&
          queue.length < maxQueuedCandidates
        ) {
          queue.push(signal)
          if (!draining) {
            void drain()
          }
        }
      }
    })
    return stop
  }
}

export type OfferManager = {
  checkout: OfferCheckoutFn
  getOffers: (
    n: number,
    encryptOffer: (peer: PeerHandle, offerId: string) => Promise<string>,
    candidates?: {encrypt: EncryptCandidate; isActive: () => boolean}
  ) => Promise<OfferRecord[]>
  acceptsSignal: NonNullable<SignalContext['acceptsLeasedSignal']>
  claimLeased: SignalContext['claimLeasedOffer']
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

  const acceptsSignal: OfferManager['acceptsSignal'] = (
    peer,
    offerId,
    peerId,
    type
  ) => {
    if (destroyed || peer.isDead) {
      return false
    }
    const entry = leaseStates.get(peer)
    return (
      !entry ||
      (entry.phase !== 'closed' &&
        entry.offerId === offerId &&
        (entry.phase !== 'answered' ||
          (type === candidateType && entry.peerId === peerId)))
    )
  }

  const claimLeased: OfferManager['claimLeased'] = (peer, answer) => {
    if (destroyed || peer.isDead) {
      return false
    }
    const entry = leaseStates.get(peer)
    if (!entry) {
      return true
    }
    if (
      answer &&
      !acceptsSignal(peer, answer.offerId, answer.peerId, 'answer')
    ) {
      return false
    }
    switch (entry.phase) {
      case 'leased':
        resetTimer(entry.timer)
        activeLeases.delete(peer)
        leaseStates.set(peer, {phase: 'claimed', offerId: entry.offerId})
        break
      case 'claimed':
      case 'answered':
        break
      case 'closed':
        return false
      default:
        return unreachable(entry)
    }
    if (answer) {
      leaseStates.set(peer, {phase: 'answered', ...answer})
    }
    return true
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
          leaseStates.set(peer, {phase: 'leased', offerId, timer})
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
    getOffers: (n, encryptOffer, candidates) => {
      const offerRecords = checkout(n, true, encryptOffer)
      if (!candidates) {
        return offerRecords
      }
      return offerRecords.then(records => {
        for (const record of records) {
          const {peer, offerId} = record
          record.onCandidate = offerCandidates(
            peer,
            offerId,
            candidates.encrypt,
            () =>
              !destroyed &&
              !peer.isDead &&
              peer.channel?.readyState !== 'open' &&
              candidates.isActive()
          )
        }
        return records
      })
    },
    acceptsSignal,
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
