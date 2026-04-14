import initPeer from '../peer'
import {genId} from '../utils'
import type {
  BaseRoomConfig,
  InternalRoom,
  JsonValue,
  PeerHandle,
  Room,
  RoomStrategy,
  Signal
} from '../types'

const gossipActionNs = '@_pac_gossip'
const bridgeActionNs = '@_pac_bridge'
const offerIdSize = 12
const defaultGossipIntervalMs = 10_000

type BridgePayload = {
  from: string
  target: string
  offer?: string
  answer?: string
  candidate?: string
  offerId?: string
}

type GossipPayload = {
  peers: string[]
}

type PeerAssistedOptions = {
  gossipIntervalMs?: number
}

type PendingBridge = {
  peer: PeerHandle
  offerId: string
  bridgePeerId: string
}

export class PeerAssistedConnectivity implements RoomStrategy {
  private gossipIntervalMs: number

  constructor(options?: PeerAssistedOptions) {
    this.gossipIntervalMs = options?.gossipIntervalMs ?? defaultGossipIntervalMs
  }

  init(
    publicRoom: Room,
    localId: string,
    config: BaseRoomConfig
  ): () => void {
    const room = publicRoom as InternalRoom
    const connectedPeers = new Set<string>()
    const pendingBridges = new Map<string, PendingBridge>()
    const bridgingInProgress = new Set<string>()
    let destroyed = false
    let gossipTimer: ReturnType<typeof setTimeout> | null = null

    const [sendGossip, getGossip] = room.makeAction<GossipPayload>(
      gossipActionNs
    )
    const [sendBridge, getBridge] = room.makeAction<BridgePayload>(
      bridgeActionNs
    )

    const broadcastGossip = (): void => {
      if (destroyed || connectedPeers.size === 0) {
        return
      }

      const peerList = Array.from(connectedPeers)
      void sendGossip({peers: peerList})
    }

    const scheduleGossip = (): void => {
      if (gossipTimer !== null) {
        clearTimeout(gossipTimer)
      }

      gossipTimer = setTimeout(() => {
        if (destroyed) {
          return
        }

        broadcastGossip()
        scheduleGossip()
      }, this.gossipIntervalMs)
    }

    const shouldInitiate = (remotePeerId: string): boolean =>
      localId < remotePeerId

    const initiateBridge = (
      targetPeerId: string,
      bridgePeerId: string
    ): void => {
      if (
        destroyed ||
        bridgingInProgress.has(targetPeerId) ||
        pendingBridges.has(targetPeerId) ||
        connectedPeers.has(targetPeerId)
      ) {
        return
      }

      if (!shouldInitiate(targetPeerId)) {
        return
      }

      bridgingInProgress.add(targetPeerId)

      const peer = initPeer(true, config)
      const offerId = genId(offerIdSize)

      pendingBridges.set(targetPeerId, {peer, offerId, bridgePeerId})

      peer.setHandlers({
        signal: (signal: Signal) => {
          if (destroyed || !pendingBridges.has(targetPeerId)) {
            return
          }

          if (signal.type === 'offer') {
            void sendBridge(
              {
                from: localId,
                target: targetPeerId,
                offer: signal.sdp,
                offerId
              },
              bridgePeerId
            )
          } else if (signal.type === 'candidate') {
            void sendBridge(
              {
                from: localId,
                target: targetPeerId,
                candidate: signal.sdp,
                offerId
              },
              bridgePeerId
            )
          }
        },
        connect: () => {
          bridgingInProgress.delete(targetPeerId)
          const pending = pendingBridges.get(targetPeerId)

          if (!pending || destroyed) {
            return
          }

          pendingBridges.delete(targetPeerId)
          room._injectPeer(peer, targetPeerId)
        },
        close: () => {
          bridgingInProgress.delete(targetPeerId)
          pendingBridges.delete(targetPeerId)
        },
        error: () => {
          bridgingInProgress.delete(targetPeerId)
          const pending = pendingBridges.get(targetPeerId)

          if (pending) {
            pendingBridges.delete(targetPeerId)
            peer.destroy()
          }
        }
      })
    }

    const handleIncomingOffer = (
      fromPeerId: string,
      offer: string,
      offerId: string | undefined,
      bridgePeerId: string
    ): void => {
      if (destroyed || connectedPeers.has(fromPeerId)) {
        return
      }

      if (bridgingInProgress.has(fromPeerId)) {
        if (shouldInitiate(fromPeerId)) {
          return
        }

        const existing = pendingBridges.get(fromPeerId)

        if (existing) {
          existing.peer.destroy()
          pendingBridges.delete(fromPeerId)
          bridgingInProgress.delete(fromPeerId)
        }
      }

      bridgingInProgress.add(fromPeerId)

      const peer = initPeer(false, config)

      pendingBridges.set(fromPeerId, {
        peer,
        offerId: offerId ?? '',
        bridgePeerId
      })

      peer.setHandlers({
        signal: (signal: Signal) => {
          if (destroyed || !pendingBridges.has(fromPeerId)) {
            return
          }

          if (signal.type === 'answer') {
            void sendBridge(
              {
                from: localId,
                target: fromPeerId,
                answer: signal.sdp,
                offerId
              },
              bridgePeerId
            )
          } else if (signal.type === 'candidate') {
            void sendBridge(
              {
                from: localId,
                target: fromPeerId,
                candidate: signal.sdp,
                offerId
              },
              bridgePeerId
            )
          }
        },
        connect: () => {
          bridgingInProgress.delete(fromPeerId)
          const pending = pendingBridges.get(fromPeerId)

          if (!pending || destroyed) {
            return
          }

          pendingBridges.delete(fromPeerId)
          room._injectPeer(peer, fromPeerId)
        },
        close: () => {
          bridgingInProgress.delete(fromPeerId)
          pendingBridges.delete(fromPeerId)
        },
        error: () => {
          bridgingInProgress.delete(fromPeerId)
          const pending = pendingBridges.get(fromPeerId)

          if (pending) {
            pendingBridges.delete(fromPeerId)
            peer.destroy()
          }
        }
      })

      void peer.signal({type: 'offer', sdp: offer})
    }

    getGossip((data: JsonValue, senderPeerId: string) => {
      if (destroyed) {
        return
      }

      const payload = data as unknown as GossipPayload
      const remotePeers = payload.peers

      if (!Array.isArray(remotePeers)) {
        return
      }

      for (const peerId of remotePeers) {
        if (
          peerId === localId ||
          connectedPeers.has(peerId) ||
          bridgingInProgress.has(peerId)
        ) {
          continue
        }

        initiateBridge(peerId, senderPeerId)
      }
    })

    getBridge((data: JsonValue, senderPeerId: string) => {
      if (destroyed) {
        return
      }

      const payload = data as unknown as BridgePayload

      if (payload.target === localId) {
        if (payload.offer) {
          handleIncomingOffer(
            payload.from,
            payload.offer,
            payload.offerId,
            senderPeerId
          )
        } else if (payload.answer) {
          const pending = pendingBridges.get(payload.from)

          if (
            pending &&
            (!payload.offerId || pending.offerId === payload.offerId)
          ) {
            void pending.peer.signal({type: 'answer', sdp: payload.answer})
          }
        } else if (payload.candidate) {
          const pending = pendingBridges.get(payload.from)

          if (
            pending &&
            (!payload.offerId || pending.offerId === payload.offerId)
          ) {
            void pending.peer.signal({
              type: 'candidate',
              sdp: payload.candidate
            })
          }
        }
      } else if (connectedPeers.has(payload.target)) {
        void sendBridge(payload, payload.target)
      }
    })

    room.onPeerJoin((peerId: string) => {
      connectedPeers.add(peerId)
      broadcastGossip()
    })

    room.onPeerLeave((peerId: string) => {
      connectedPeers.delete(peerId)

      const pending = pendingBridges.get(peerId)

      if (pending) {
        pending.peer.destroy()
        pendingBridges.delete(peerId)
        bridgingInProgress.delete(peerId)
      }
    })

    scheduleGossip()

    return () => {
      destroyed = true

      if (gossipTimer !== null) {
        clearTimeout(gossipTimer)
        gossipTimer = null
      }

      for (const [peerId, pending] of pendingBridges) {
        pending.peer.destroy()
        bridgingInProgress.delete(peerId)
      }

      pendingBridges.clear()
      connectedPeers.clear()
    }
  }
}
