import {maxRoomFrameBytes} from '../data-limits'
import {
  createEndpointIdentity,
  jwkToCompactPub,
  type EndpointIdentity
} from '../identity'
import type {MaybePromise, PeerHandle} from '../internal-types'
import type {PeerDataTransport} from '../peer-transport'
import type {
  RoleCertificate,
  ScaleConfig,
  TopologyRoute,
  TopologySnapshot,
  TopologyStats,
  UserIdentity
} from '../types'
import {
  all,
  decodeBytes,
  fromJson,
  isProtocolViolation,
  noOp,
  peerBannedErr,
  peerDisconnectedErr,
  peerLeftRoomErr
} from '../utils'
import {
  canonicalLeaveHeader,
  isPeerUsable,
  overlayBroadcastKind,
  overlayControlKind,
  overlayFrameVersion,
  overlayUnicastKind,
  packOverlayControl,
  signOverlayPayload,
  unpackOverlayFrame,
  type CryptoIdentity,
  type OverlayControlMessage
} from './crypto-frame'
import {createOverlayDataPlane} from './data-plane'
import {createDescriptorStore} from './descriptors'
import {
  createOverlayRouter,
  defaultQuarantineTtlMs,
  defaultRequiredPeerIdleTtlMs,
  type OverlayRouter
} from './routing'
import {createOverlaySequencer} from './seq'
import {
  defaultDescriptorTtlMs,
  defaultUnreachableGraceMs,
  normalizeTopologyConfig,
  type ResolvedTopologyConfig
} from './topology'

const emptyBytes = /*@__PURE__*/ new Uint8Array(0)

export type OverlayManagerDeps = {
  selfId?: string
  appId?: string
  roomId?: string
  password?: string
  config?: ScaleConfig
  descriptorTtlMs?: number
  unreachableGraceMs?: number
  requiredPeerIdleTtlMs?: number
  quarantineTtlMs?: number
  maxUsers?: number
  getLocalEndpointIdentity?: () => MaybePromise<EndpointIdentity>
  getLocalUserIdentity?: () => MaybePromise<UserIdentity>
  onVirtualPeerJoin: (peerId: string, transport: PeerDataTransport) => unknown
  onVirtualPeerLeave: (peerId: string, reason?: Error) => void
  onDeliverData: (originPeerId: string, data: ArrayBuffer) => void
  authorizePeerAction?: (
    peerId: string,
    requiredRoles: readonly string[],
    inlineCert?: RoleCertificate
  ) => MaybePromise<boolean>
  onPeerDescriptorCert?: (
    peerId: string,
    signPubKey: string,
    cert?: RoleCertificate,
    userId?: string
  ) => void
  onError?: (error: unknown) => void
}

export type OverlayManager = {
  config: ResolvedTopologyConfig
  isOverlayFrame: (data: ArrayBuffer) => boolean
  handleOverlayFrame: (fromPeerId: string, data: ArrayBuffer) => void
  handleFrame: (fromPeerId: string, data: ArrayBuffer) => boolean
  addDirectPeer: (peerId: string, peer: PeerHandle) => void
  removeDirectPeer: (peerId: string, peer?: PeerHandle, reason?: Error) => void
  isDirectPeer: (peerId: string) => boolean
  isVirtualPeer: (peerId: string) => boolean
  canBroadcastDirectMesh: () => boolean
  getRoute: (peerId: string) => TopologyRoute | undefined
  broadcastInline: (
    frame: Uint8Array,
    onProgress?: (peerId: string) => void,
    signal?: AbortSignal
  ) => boolean | Promise<boolean>
  sendUnicast: (targetPeerId: string, frame: Uint8Array) => void
  requireDirectPeer: (peerId: string, options?: {dial?: boolean}) => void
  setPeerMediaPinned: (peerId: string, pinned: boolean) => void
  acceptMediaConnectRequest: (fromPeerId: string) => boolean
  notePeerDiscovered: (peerId: string) => boolean
  shouldConnectPeer: (
    peerId: string,
    direction: 'outbound' | 'inbound'
  ) => boolean
  getTargetNeighbors: () => Set<string>
  setOnTargetsChanged: (cb: (targetPeerIds: string[]) => void) => void
  announceLeave: () => Promise<void>
  destroy: () => void
  getSnapshot: () => TopologySnapshot
  getLocalCryptoIdentity: () => Promise<CryptoIdentity>
  getPeerUserId: (peerId: string) => string | undefined
  getPeerSignPublicKey: (peerId: string) => string | undefined
  setPeerSignPublicKey: (peerId: string, pubKey: JsonWebKey | string) => void
  setLocalRoleCertificate: (cert: RoleCertificate | null) => void
  markPeerBanned: (peerId: string) => void
  unmarkPeerBanned: (peerId: string) => void
  isPeerBanned: (peerId: string) => boolean
  registerActionAuthority: (actionType: string, roles: string[]) => void
  setRoomId: (effectiveRoomId: string) => void
}

export const createOverlayManager = ({
  selfId: initialSelfId,
  appId = '',
  roomId: initialRoomId = '',
  password = '',
  config: rawConfig,
  descriptorTtlMs = defaultDescriptorTtlMs,
  unreachableGraceMs = defaultUnreachableGraceMs,
  requiredPeerIdleTtlMs = defaultRequiredPeerIdleTtlMs,
  quarantineTtlMs = defaultQuarantineTtlMs,
  maxUsers,
  getLocalEndpointIdentity,
  getLocalUserIdentity,
  onVirtualPeerJoin,
  onVirtualPeerLeave,
  onDeliverData,
  authorizePeerAction,
  onPeerDescriptorCert,
  onError
}: OverlayManagerDeps): OverlayManager => {
  const config = normalizeTopologyConfig(rawConfig)
  let selfId = initialSelfId ?? ''
  let roomId = initialRoomId
  let isDestroyed = false

  const directPeers = new Map<string, PeerHandle>()
  const pendingFramesByPeer = new Map<string, ArrayBuffer[]>()
  const bannedPeers = new Set<string>()
  const actionAuthorities = new Map<string, string[]>()

  const stats: TopologyStats = {
    messagesSent: 0,
    messagesReceived: 0,
    messagesForwarded: 0,
    duplicatesDropped: 0,
    signatureFailures: 0
  }

  let localUserId: string | undefined
  if (getLocalUserIdentity) {
    void Promise.resolve(getLocalUserIdentity())
      .then(u => {
        if (u?.userId) {
          localUserId = u.userId
        }
      })
      .catch(noOp)
  }

  const sendToDirectNeighbor = (peerId: string, frame: Uint8Array): boolean => {
    const peer = directPeers.get(peerId)
    if (!isPeerUsable(peer)) {
      return false
    }
    try {
      peer.sendData(frame)
      return true
    } catch {
      return false
    }
  }

  const hasUsableDirectPeer = (): boolean => {
    for (const peer of directPeers.values()) {
      if (isPeerUsable(peer)) {
        return true
      }
    }
    return false
  }

  const seq = createOverlaySequencer({
    getAppId: () => appId,
    getRoomId: () => roomId,
    getSelfId: () => selfId,
    isPinnedOrigin: k => directPeers.has(k) || descriptors.hasDescriptor(k)
  })
  if (selfId) {
    seq.syncSeqFloor(selfId)
  }

  const syncSelfIdFromIdentity = (peerId: string): void => {
    if (!initialSelfId && peerId && peerId !== selfId) {
      descriptors.deleteKnownPeer(selfId)
      selfId = peerId
      descriptors.addKnownPeer(selfId)
      router?.bumpTopologyVersion()
    }
    seq.syncSeqFloor(selfId)
  }

  if (getLocalEndpointIdentity) {
    void Promise.resolve(getLocalEndpointIdentity())
      .then(ep => {
        if (ep?.peerId) {
          syncSelfIdFromIdentity(ep.peerId)
        }
      })
      .catch(noOp)
  }

  let localCryptoIdentityP: Promise<CryptoIdentity> | null = null
  const loadLocalCryptoIdentity = (): Promise<CryptoIdentity> =>
    (localCryptoIdentityP ??= (async () => {
      const [endpointId, encPair] = await all([
        getLocalEndpointIdentity
          ? Promise.resolve(getLocalEndpointIdentity())
          : createEndpointIdentity(),
        crypto.subtle.generateKey({name: 'ECDH', namedCurve: 'P-256'}, false, [
          'deriveKey',
          'deriveBits'
        ])
      ])
      const rawEncPubJwk = await crypto.subtle.exportKey(
        'jwk',
        encPair.publicKey
      )
      syncSelfIdFromIdentity(endpointId.peerId)
      const res: CryptoIdentity = {
        peerId: endpointId.peerId,
        signPrivateKey: endpointId.signPrivateKey,
        signPubKey: jwkToCompactPub(endpointId.signPubJwk),
        encPrivateKey: encPair.privateKey,
        encPubKey: jwkToCompactPub(rawEncPubJwk)
      }
      if (!isDestroyed && directPeers.size > 0) {
        void descriptors.publishLocalDescriptor().catch(noOp)
      }
      return res
    })().catch(err => {
      localCryptoIdentityP = null
      throw err
    }))

  const isPeerBanned = (id: string): boolean => bannedPeers.has(id)

  const descriptors = createDescriptorStore({
    appId,
    password,
    descriptorTtlMs,
    maxUsers,
    seq,
    isDestroyed: () => isDestroyed,
    getSelfId: () => selfId,
    getRoomId: () => roomId,
    getLocalUserId: () => localUserId,
    getLocalUserIdentity,
    loadLocalCryptoIdentity,
    syncSelfIdFromIdentity,
    isDirectPeer: id => directPeers.has(id),
    isVirtualPeer: id => router.isVirtualPeer(id),
    getDirectPeerIds: () => directPeers.keys(),
    getDirectPeerCount: () => directPeers.size,
    getDiscoveredCandidateCount: () => router.getDiscoveredCandidateCount(),
    computeEffectiveTargets: () => router.computeEffectiveTargets(),
    sendToDirectNeighbor,
    isPeerBanned,
    recordSignatureFailure: () => {
      stats.signatureFailures++
    },
    onTopologyChanged: () => router.recomputeTopologyAndRoutes(),
    onEvictVirtualPeer: (peerId, reason) => {
      dataPlane.purgePeerDataState(peerId)
      router.evictVirtualPeerNow(peerId, reason)
    },
    onOriginDescriptorVerified: (peerId, encKeyRotated) => {
      if (encKeyRotated) {
        dataPlane.invalidatePairwiseKey(peerId)
      }
      dataPlane.replayEarlyFramesForOrigin(peerId)
    },
    onPeerDescriptorCert,
    onError
  })

  const dataPlane = createOverlayDataPlane({
    appId,
    seq,
    descriptors,
    getRouter: () => router,
    stats,
    isDestroyed: () => isDestroyed,
    getSelfId: () => selfId,
    getRoomId: () => roomId,
    loadLocalCryptoIdentity,
    syncSelfIdFromIdentity,
    getDirectPeer: id => directPeers.get(id),
    isDirectPeer: id => directPeers.has(id),
    getDirectPeerIds: () => directPeers.keys(),
    getDirectPeerCount: () => directPeers.size,
    hasUsableDirectPeer,
    sendToDirectNeighbor,
    isPeerBanned,
    getActionRequiredRoles: type => actionAuthorities.get(type),
    authorizePeerAction,
    onDeliverData
  })

  const router: OverlayRouter = createOverlayRouter({
    appId,
    password,
    maxDirectPeers: config.maxDirectPeers,
    unreachableGraceMs,
    requiredPeerIdleTtlMs,
    quarantineTtlMs,
    descriptors,
    isDestroyed: () => isDestroyed,
    getSelfId: () => selfId,
    getRoomId: () => roomId,
    getDirectPeer: id => directPeers.get(id),
    isDirectPeer: id => directPeers.has(id),
    getDirectPeerIds: () => directPeers.keys(),
    getDirectPeerCount: () => directPeers.size,
    isPeerBanned: id => bannedPeers.has(id),
    createVirtualTransport: id => dataPlane.createVirtualTransport(id),
    onVirtualPeerJoin,
    onVirtualPeerLeave,
    onVirtualPeerReady: id => dataPlane.flushBufferedForOrigin(id)
  })

  void loadLocalCryptoIdentity().catch(err => {
    if (!isDestroyed) {
      onError?.(err)
    }
  })

  const purgePeerFromGraph = (peerId: string): void => {
    descriptors.purgePeer(peerId)
    router.purgePeerRoutingState(peerId)
    dataPlane.purgePeerDataState(peerId)
  }

  const isOverlayFrame = (data: ArrayBuffer): boolean =>
    data.byteLength >= 2 &&
    new Uint8Array(data, 0, 1)[0] === overlayFrameVersion

  const handleOverlayFrame = (fromPeerId: string, data: ArrayBuffer): void => {
    if (data.byteLength > maxRoomFrameBytes) {
      return
    }
    if (bannedPeers.has(fromPeerId)) {
      stats.signatureFailures++
      return
    }
    const bytes = new Uint8Array(data)
    if (bytes.byteLength < 2 || bytes[0] !== overlayFrameVersion) {
      return
    }
    const kind = bytes[1]!
    if (kind === overlayControlKind) {
      try {
        descriptors.dispatchControlMessage(
          fromPeerId,
          fromJson<OverlayControlMessage>(decodeBytes(bytes.subarray(2)))
        )
      } catch {
        // Ignore malformed control payload
      }
      return
    }
    if (kind === overlayBroadcastKind || kind === overlayUnicastKind) {
      const parsed = unpackOverlayFrame(bytes.slice())
      if (!parsed) {
        return
      }
      seq.enqueuePeerTask(fromPeerId, () =>
        dataPlane.handleOverlayBinary(fromPeerId, parsed)
      )
    }
  }

  return {
    config,
    isOverlayFrame,
    handleOverlayFrame,
    handleFrame: (fromPeerId, data) => {
      if (!isOverlayFrame(data)) {
        return false
      }
      if (data.byteLength > maxRoomFrameBytes) {
        return true
      }
      if (!directPeers.has(fromPeerId)) {
        let q = pendingFramesByPeer.get(fromPeerId)
        if (!q) {
          q = []
          pendingFramesByPeer.set(fromPeerId, q)
        }
        if (q.length < 32) {
          q.push(data.slice(0))
        }
        return true
      }
      handleOverlayFrame(fromPeerId, data)
      return true
    },
    addDirectPeer: (peerId, peer) => {
      router.clearQuarantined(peerId)
      if (!router.isAllowedTargetPeer(peerId)) {
        return
      }
      descriptors.clearLeft(peerId)
      router.clearCapacityRejected(peerId)
      descriptors.addKnownPeer(peerId)
      router.bumpTopologyVersion()
      router.clearUnreachableTimer(peerId)

      router.detachVirtualTransport(peerId)
      directPeers.set(peerId, peer)
      router.recomputeTopologyAndRoutes()

      const queued = pendingFramesByPeer.get(peerId)
      if (queued) {
        pendingFramesByPeer.delete(peerId)
        for (const frame of queued) {
          handleOverlayFrame(peerId, frame)
        }
      }

      descriptors.sendInitialKnownDescriptors(peerId)
    },
    removeDirectPeer: (peerId, peer, reason) => {
      const current = directPeers.get(peerId)
      if (!current || (peer && current !== peer)) {
        if (!current) {
          pendingFramesByPeer.delete(peerId)
          const existingVTransport = router.getVirtualTransport(peerId)
          if (peer) {
            if (existingVTransport && router.getRoute(peerId)) {
              onVirtualPeerJoin(peerId, existingVTransport)
            } else if (!existingVTransport) {
              if (!descriptors.hasDescriptor(peerId)) {
                purgePeerFromGraph(peerId)
              }
              router.recomputeTopologyAndRoutes()
            }
          } else {
            const desc = descriptors.getDescriptor(peerId)
            if (reason === peerLeftRoomErr || reason === peerBannedErr) {
              if (reason === peerLeftRoomErr) {
                descriptors.markLeft(peerId, desc?.seq ?? 0)
              }
              dataPlane.purgePeerDataState(peerId)
              router.evictVirtualPeerNow(peerId, reason)
              router.recomputeTopologyAndRoutes()
            } else {
              const violation = isProtocolViolation(reason)
              if (violation) {
                router.quarantinePeer(peerId)
              }
              router.deactivateVirtualPeerNow(
                peerId,
                reason ?? peerDisconnectedErr
              )
              if (violation) {
                router.recomputeTopologyAndRoutes()
              }
            }
          }
        }
        return
      }

      pendingFramesByPeer.delete(peerId)
      directPeers.delete(peerId)
      router.clearCapacityRejected()
      router.bumpTopologyVersion()
      descriptors.markLeft(peerId)
      purgePeerFromGraph(peerId)
      router.recomputeTopologyAndRoutes()
      if (directPeers.size > 0) {
        void descriptors.publishLocalDescriptor().catch(noOp)
      }
    },
    isDirectPeer: peerId => directPeers.has(peerId),
    isVirtualPeer: peerId => router.isVirtualPeer(peerId),
    canBroadcastDirectMesh: () =>
      directPeers.size === 0 ||
      (router.getVirtualPeerCount() === 0 &&
        descriptors.hasConvergedDirectMesh()),
    getRoute: peerId => router.getRoute(peerId),
    broadcastInline: dataPlane.broadcastInline,
    sendUnicast: dataPlane.sendUnicast,
    requireDirectPeer: (peerId, options) =>
      router.requireDirectPeer(peerId, options?.dial !== false),
    setPeerMediaPinned: router.setPeerMediaPinned,
    acceptMediaConnectRequest: router.acceptMediaConnectRequest,
    notePeerDiscovered: router.notePeerDiscovered,
    shouldConnectPeer: router.shouldConnectPeer,
    getTargetNeighbors: router.getTargetNeighbors,
    setOnTargetsChanged: router.setOnTargetsChanged,
    announceLeave: async () => {
      if (isDestroyed || !directPeers.size) {
        return
      }
      const leaveSeq = seq.nextDescSeq()
      try {
        const id = await loadLocalCryptoIdentity()
        syncSelfIdFromIdentity(id.peerId)
        const sig = await signOverlayPayload(
          id.signPrivateKey,
          canonicalLeaveHeader(selfId, leaveSeq, appId, roomId),
          emptyBytes
        )
        if (isDestroyed) {
          return
        }
        const packet = packOverlayControl({
          t: 'leave',
          peerId: selfId,
          seq: leaveSeq,
          sig
        })
        for (const neighborId of directPeers.keys()) {
          sendToDirectNeighbor(neighborId, packet)
        }
      } catch {
        // Ignore leave signature failure during teardown
      }
    },
    destroy: () => {
      isDestroyed = true
      descriptors.destroy()
      router.destroy()
      dataPlane.destroy()
      seq.clear()
      pendingFramesByPeer.clear()
      directPeers.clear()
      bannedPeers.clear()
      actionAuthorities.clear()
    },
    getSnapshot: () => {
      const directPeerIds = [...directPeers.keys()].sort()
      return {
        peerId: selfId,
        directPeerIds,
        roomPeerIds: [
          ...new Set<string>([...directPeerIds, ...router.getVirtualPeerIds()])
        ].sort(),
        routes: router.getRoutesCopy(),
        stats: {...stats}
      }
    },
    getLocalCryptoIdentity: loadLocalCryptoIdentity,
    getPeerUserId: peerId => descriptors.getDescriptor(peerId)?.userId,
    getPeerSignPublicKey: descriptors.getSignPubKey,
    setPeerSignPublicKey: descriptors.setPeerSignPublicKey,
    setLocalRoleCertificate: descriptors.setLocalRoleCertificate,
    markPeerBanned: peerId => {
      bannedPeers.add(peerId)
      router.purgeConnectionPolicyPeer(peerId)
      descriptors.markLeft(
        peerId,
        descriptors.getDescriptor(peerId)?.seq ?? Number.MAX_SAFE_INTEGER
      )
      dataPlane.invalidatePairwiseKey(peerId)
      router.evictVirtualPeerNow(peerId, peerBannedErr)
      router.recomputeTopologyAndRoutes()
      if (directPeers.size > 0) {
        void descriptors.publishLocalDescriptor().catch(noOp)
      }
    },
    unmarkPeerBanned: peerId => {
      if (!bannedPeers.delete(peerId)) {
        return
      }
      descriptors.clearLeft(peerId)
      router.bumpTopologyVersion()
      router.recomputeTopologyAndRoutes()
    },
    isPeerBanned: peerId => bannedPeers.has(peerId),
    registerActionAuthority: (actionType, roles) => {
      if (roles.length > 0) {
        actionAuthorities.set(actionType, [...roles])
      } else {
        actionAuthorities.delete(actionType)
      }
    },
    setRoomId: effectiveRoomId => {
      if (effectiveRoomId && effectiveRoomId !== roomId) {
        roomId = effectiveRoomId
        router.refreshPasswordSalt()
        seq.resetFloor()
        dataPlane.resetRoomCryptoState()
        router.resetForRoomIdChange()
        for (const existingPeerId of Array.from(descriptors.getKnownRoster())) {
          if (existingPeerId !== selfId) {
            router.evictVirtualPeerNow(existingPeerId, peerDisconnectedErr)
          }
        }
        router.recomputeTopologyAndRoutes()
        if (directPeers.size > 0) {
          void descriptors.publishLocalDescriptor().catch(noOp)
        }
      }
    }
  }
}
