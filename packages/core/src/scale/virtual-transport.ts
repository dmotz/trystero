import {
  waitForBufferedAmountLow,
  type PeerDataTransport
} from '../peer-registry'
import type {PeerHandle} from '../types'
import {createBoundedCache, peerDisconnectedErr} from '../utils'

const maxQueuedUnicastBeforeBackpressure = 4

export const isPeerUsable = (
  peer: PeerHandle | undefined
): peer is PeerHandle =>
  Boolean(peer && !peer.isDead && peer.channel?.readyState !== 'closed')

export const getPeerBufferedBytes = (peer: PeerHandle | undefined): number =>
  typeof peer?.channel?.bufferedAmount === 'number'
    ? peer.channel.bufferedAmount
    : 0

export type VirtualTransportFactoryDeps = {
  directPeers: Map<string, PeerHandle>
  virtualTransports: Map<string, PeerDataTransport>
  bannedPeers: Set<string>
  isDestroyed: () => boolean
  isLeftPeer: (peerId: string) => boolean
  resolveHealthyNextHopId: (
    destPeerId: string,
    excludePeerId?: string
  ) => string | undefined
  getOutboundQueueState: (peerId: string) => {
    depth: number
    tail: Promise<void> | undefined
  }
  sendUnicastInternal: (
    targetPeerId: string,
    frame: Uint8Array,
    options?: {
      forceOverlay?: boolean
      pinnedHopId?: string
      promoteDirect?: boolean
      strict?: boolean
    }
  ) => void
}

export const createVirtualTransportFactory = (
  deps: VirtualTransportFactoryDeps
): ((peerId: string) => PeerDataTransport) => {
  const {
    directPeers,
    virtualTransports,
    bannedPeers,
    isDestroyed,
    isLeftPeer,
    resolveHealthyNextHopId,
    getOutboundQueueState,
    sendUnicastInternal
  } = deps

  return (peerId: string): PeerDataTransport => {
    const existing = virtualTransports.get(peerId)
    if (existing && existing.isOpen) {
      return existing
    }

    let closed = false
    const pinnedTransferHops = createBoundedCache<number, string>(64)

    const isReachable = (): boolean =>
      !closed &&
      !isDestroyed() &&
      !bannedPeers.has(peerId) &&
      !isLeftPeer(peerId) &&
      Boolean(resolveHealthyNextHopId(peerId))

    const transport: PeerDataTransport = {
      get isOpen(): boolean {
        return isReachable()
      },
      get bufferedAmount(): number {
        if (!isReachable()) {
          return 0
        }
        const hop = resolveHealthyNextHopId(peerId)
        return hop ? getPeerBufferedBytes(directPeers.get(hop)) : 0
      },
      sendFrame: (bytes, meta) => {
        if (!isReachable()) {
          throw peerDisconnectedErr
        }
        if (meta?.transferId !== undefined) {
          let hop = pinnedTransferHops.get(meta.transferId)
          if (!hop || !isPeerUsable(directPeers.get(hop))) {
            hop = resolveHealthyNextHopId(peerId)
            if (hop) {
              pinnedTransferHops.set(meta.transferId, hop)
            }
          }
          sendUnicastInternal(peerId, bytes, {
            forceOverlay: true,
            ...(hop ? {pinnedHopId: hop} : {}),
            promoteDirect: meta.kind === 'offer',
            strict: true
          })
          return
        }
        sendUnicastInternal(peerId, bytes, {strict: true})
      },
      waitForDrain: signal => {
        if (signal?.aborted || !isReachable()) {
          return false
        }
        const hop = resolveHealthyNextHopId(peerId)
        const hopChannel = hop ? directPeers.get(hop)?.channel : null
        const {depth, tail} = getOutboundQueueState(peerId)
        const queuePromise =
          depth >= maxQueuedUnicastBeforeBackpressure ? tail : undefined
        const channelNeedsWait = Boolean(
          hopChannel &&
          (hopChannel.readyState !== 'open' ||
            hopChannel.bufferedAmount > hopChannel.bufferedAmountLowThreshold)
        )
        if (!queuePromise && !channelNeedsWait) {
          return true
        }
        return (async () => {
          if (queuePromise) {
            if (signal) {
              let onAbort: (() => void) | undefined
              const abortP = new Promise<false>(res => {
                onAbort = () => res(false)
                signal.addEventListener('abort', onAbort, {once: true})
              })
              try {
                const raced = await Promise.race([
                  queuePromise.then(() => true as const),
                  abortP
                ])
                if (!raced) {
                  return false
                }
              } finally {
                if (onAbort) {
                  signal.removeEventListener('abort', onAbort)
                }
              }
            } else {
              await queuePromise
            }
          }
          if (signal?.aborted || !isReachable()) {
            return false
          }
          const latestHop = resolveHealthyNextHopId(peerId)
          const latestChannel = latestHop
            ? directPeers.get(latestHop)?.channel
            : null
          if (latestChannel) {
            const drained = await waitForBufferedAmountLow(
              latestChannel,
              signal
            )
            if (!drained) {
              return false
            }
          }
          return isReachable()
        })()
      },
      close: () => {
        if (closed) {
          return
        }
        closed = true
        pinnedTransferHops.clear()
        if (virtualTransports.get(peerId) === transport) {
          virtualTransports.delete(peerId)
        }
      }
    }

    virtualTransports.set(peerId, transport)
    return transport
  }
}
