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
  peerLeftRoomErr,
  unreachable
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
const maxBufferedPreDirectPeers = 256
const maxBufferedPreDirectFramesPerPeer = 32

type ManagerLifecycle = 'active' | 'leaving' | 'closed'

type NeighborSlotState =
  | {readonly phase: 'buffered'; readonly frames: ArrayBuffer[]}
  | {readonly phase: 'direct'; readonly peer: PeerHandle}
  | {readonly phase: 'banned'}

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

const createNeighborSlots = () => {
  const slots = new Map<string, NeighborSlotState>()
  const direct = new Map<string, PeerHandle>()
  let buffered = 0
  return {
    get: (id: string): NeighborSlotState | undefined => slots.get(id),
    entries: () => slots.entries(),
    directPeers: direct as ReadonlyMap<string, PeerHandle>,
    bufferedCount: (): number => buffered,
    clear: (): void => {
      slots.clear()
      direct.clear()
      buffered = 0
    },
    transition: (peerId: string, next: NeighborSlotState | null): void => {
      const prev = slots.get(peerId)
      if (prev?.phase === 'buffered') {
        buffered--
      }
      if (next === null) {
        slots.delete(peerId)
        direct.delete(peerId)
        return
      }
      switch (next.phase) {
        case 'buffered':
          buffered++
          direct.delete(peerId)
          break
        case 'direct':
          direct.set(peerId, next.peer)
          break
        case 'banned':
          direct.delete(peerId)
          break
        default:
          unreachable(next)
      }
      slots.set(peerId, next)
    }
  }
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
  let lifecycle: ManagerLifecycle = 'active'
  let localCryptoIdentityP: Promise<CryptoIdentity> | null = null

  const neighbors = createNeighborSlots()
  const activeDirectPeers = neighbors.directPeers
  const transitionNeighborSlot = neighbors.transition
  const actionAuthorities = new Map<string, string[]>()

  const isDestroyed = (): boolean => lifecycle === 'closed'

  const isPeerBanned = (id: string): boolean =>
    neighbors.get(id)?.phase === 'banned'

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
        if (u?.userId && !isDestroyed()) {
          localUserId = u.userId
        }
      })
      .catch(noOp)
  }

  const sendToDirectNeighbor = (peerId: string, frame: Uint8Array): boolean => {
    const peer = activeDirectPeers.get(peerId)
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
    for (const peer of activeDirectPeers.values()) {
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
    isPinnedOrigin: k =>
      activeDirectPeers.has(k) || descriptors.hasDescriptor(k)
  })
  if (selfId) {
    seq.syncSeqFloor(selfId)
  }

  const syncSelfIdFromIdentity = (peerId: string): void => {
    if (!initialSelfId && peerId && peerId !== selfId) {
      const prevSelfId = selfId
      selfId = peerId
      descriptors?.syncSelfIdChange(prevSelfId, selfId)
      seq.syncSeqFloor(selfId)
      router?.recomputeTopologyAndRoutes()
      router?.scheduleTargetsNotification()
      return
    }
    seq.syncSeqFloor(selfId)
  }

  if (getLocalEndpointIdentity) {
    void Promise.resolve(getLocalEndpointIdentity())
      .then(ep => {
        if (ep?.peerId && !isDestroyed()) {
          syncSelfIdFromIdentity(ep.peerId)
        }
      })
      .catch(noOp)
  }

  const maybePublishDescriptor = (): void => {
    if (lifecycle === 'active' && activeDirectPeers.size > 0) {
      void descriptors.publishLocalDescriptor().catch(noOp)
    }
  }

  const loadLocalCryptoIdentity = (): Promise<CryptoIdentity> =>
    (localCryptoIdentityP ??= (async (): Promise<CryptoIdentity> => {
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
      const identity: CryptoIdentity = {
        peerId: endpointId.peerId,
        signPrivateKey: endpointId.signPrivateKey,
        signPubKey: jwkToCompactPub(endpointId.signPubJwk),
        encPrivateKey: encPair.privateKey,
        encPubKey: jwkToCompactPub(rawEncPubJwk)
      }
      maybePublishDescriptor()
      return identity
    })().catch(err => {
      localCryptoIdentityP = null
      throw err
    }))

  const descriptors = createDescriptorStore({
    appId,
    password,
    descriptorTtlMs,
    maxUsers,
    seq,
    isDestroyed,
    canPublish: () => lifecycle === 'active',
    getSelfId: () => selfId,
    getRoomId: () => roomId,
    getLocalUserId: () => localUserId,
    getLocalUserIdentity,
    loadLocalCryptoIdentity,
    syncSelfIdFromIdentity,
    isDirectPeer: id => activeDirectPeers.has(id),
    isVirtualPeer: id => router.isVirtualPeer(id),
    getDirectPeerIds: () => activeDirectPeers.keys(),
    getDirectPeerCount: () => activeDirectPeers.size,
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
    hasBufferedFramesForOrigin: peerId => dataPlane.hasBufferedFrames(peerId),
    onPeerDescriptorCert,
    onError
  })

  const dataPlane = createOverlayDataPlane({
    appId,
    seq,
    descriptors,
    getRouter: () => router,
    stats,
    isDestroyed,
    getSelfId: () => selfId,
    getRoomId: () => roomId,
    loadLocalCryptoIdentity,
    syncSelfIdFromIdentity,
    getDirectPeer: id => activeDirectPeers.get(id),
    isDirectPeer: id => activeDirectPeers.has(id),
    getDirectPeerIds: () => activeDirectPeers.keys(),
    getDirectPeerCount: () => activeDirectPeers.size,
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
    isDestroyed,
    getSelfId: () => selfId,
    getRoomId: () => roomId,
    getDirectPeer: id => activeDirectPeers.get(id),
    isDirectPeer: id => activeDirectPeers.has(id),
    getDirectPeerIds: () => activeDirectPeers.keys(),
    getDirectPeerCount: () => activeDirectPeers.size,
    isPeerBanned,
    createVirtualTransport: id => dataPlane.createVirtualTransport(id),
    onVirtualTransportDetached: (id, transport) =>
      dataPlane.onVirtualTransportDetached(id, transport),
    onVirtualPeerJoin,
    onVirtualPeerLeave,
    onVirtualPeerReady: id => dataPlane.flushBufferedForOrigin(id)
  })

  void loadLocalCryptoIdentity().catch(err => {
    if (!isDestroyed()) {
      onError?.(err)
    }
  })

  const purgePeerFromGraph = (peerId: string): void => {
    descriptors.purgePeer(peerId)
    router.purgePeerRoutingState(peerId)
    dataPlane.purgePeerDataState(peerId)
  }

  const applyPeerBan = (peerId: string): void => {
    const wasDirect = neighbors.get(peerId)?.phase === 'direct'
    transitionNeighborSlot(peerId, {phase: 'banned'})
    if (wasDirect) {
      router.clearCapacityRejected()
    }
    router.purgeConnectionPolicyPeer(peerId)
    descriptors.markLeft(
      peerId,
      descriptors.getDescriptor(peerId)?.seq ?? Number.MAX_SAFE_INTEGER
    )
    router.purgePeerRoutingState(peerId)
    dataPlane.purgePeerDataState(peerId)
    router.evictVirtualPeerNow(peerId, peerBannedErr)
    router.recomputeTopologyAndRoutes()
    maybePublishDescriptor()
  }

  const isOverlayFrame = (data: ArrayBuffer): boolean =>
    data.byteLength >= 2 &&
    new Uint8Array(data, 0, 1)[0] === overlayFrameVersion

  const handleOverlayFrame = (fromPeerId: string, data: ArrayBuffer): void => {
    if (isDestroyed() || data.byteLength > maxRoomFrameBytes) {
      return
    }
    if (isPeerBanned(fromPeerId)) {
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
      if (isDestroyed() || data.byteLength > maxRoomFrameBytes) {
        return true
      }
      const slot = neighbors.get(fromPeerId)
      if (!slot) {
        if (neighbors.bufferedCount() >= maxBufferedPreDirectPeers) {
          for (const [id, candidate] of neighbors.entries()) {
            if (candidate.phase === 'buffered') {
              transitionNeighborSlot(id, null)
              break
            }
          }
        }
        transitionNeighborSlot(fromPeerId, {
          phase: 'buffered',
          frames: [data.slice(0)]
        })
        return true
      }
      switch (slot.phase) {
        case 'banned':
          stats.signatureFailures++
          return true
        case 'direct':
          handleOverlayFrame(fromPeerId, data)
          return true
        case 'buffered':
          if (slot.frames.length < maxBufferedPreDirectFramesPerPeer) {
            slot.frames.push(data.slice(0))
          }
          return true
        default:
          return unreachable(slot)
      }
    },
    addDirectPeer: (peerId, peer) => {
      if (isDestroyed()) {
        return
      }
      router.clearQuarantined(peerId)
      const prevSlot = neighbors.get(peerId)
      if (!router.isAllowedTargetPeer(peerId)) {
        if (prevSlot?.phase === 'buffered') {
          transitionNeighborSlot(peerId, null)
        }
        return
      }
      const queuedFrames =
        prevSlot?.phase === 'buffered' ? prevSlot.frames : undefined

      descriptors.clearLeft(peerId)
      router.clearCapacityRejected(peerId)
      descriptors.addKnownPeer(peerId)
      router.bumpTopologyVersion()
      router.clearUnreachableTimer(peerId)

      router.detachVirtualTransport(peerId)
      transitionNeighborSlot(peerId, {phase: 'direct', peer})
      router.recomputeTopologyAndRoutes()

      if (queuedFrames) {
        for (const frame of queuedFrames) {
          if (neighbors.get(peerId)?.phase !== 'direct') {
            break
          }
          handleOverlayFrame(peerId, frame)
        }
      }

      if (lifecycle === 'active' && neighbors.get(peerId)?.phase === 'direct') {
        descriptors.sendInitialKnownDescriptors(peerId)
      }
    },
    removeDirectPeer: (peerId, peer, reason) => {
      if (isDestroyed()) {
        return
      }
      if (reason === peerBannedErr) {
        applyPeerBan(peerId)
        return
      }
      const slot = neighbors.get(peerId)
      if (slot?.phase === 'banned') {
        return
      }
      if (slot?.phase === 'direct' && peer && slot.peer !== peer) {
        return
      }

      if (slot?.phase !== 'direct') {
        if (slot?.phase === 'buffered') {
          transitionNeighborSlot(peerId, null)
        }
        const violation = isProtocolViolation(reason)
        if (peer) {
          if (violation) {
            router.quarantinePeer(peerId)
            dataPlane.purgePeerDataState(peerId)
            router.deactivateVirtualPeerNow(peerId, reason!)
            router.recomputeTopologyAndRoutes()
            return
          }
          const existingVTransport = router.getVirtualTransport(peerId)
          if (existingVTransport && router.getRoute(peerId)) {
            onVirtualPeerJoin(peerId, existingVTransport)
          } else if (!existingVTransport) {
            if (!descriptors.hasDescriptor(peerId)) {
              purgePeerFromGraph(peerId)
            }
            router.recomputeTopologyAndRoutes()
          }
          return
        }

        if (reason === peerLeftRoomErr) {
          descriptors.markLeft(
            peerId,
            descriptors.getDescriptor(peerId)?.seq ?? 0
          )
          dataPlane.purgePeerDataState(peerId)
          router.evictVirtualPeerNow(peerId, reason)
          router.recomputeTopologyAndRoutes()
          return
        }
        if (violation) {
          router.quarantinePeer(peerId)
          dataPlane.purgePeerDataState(peerId)
        }
        router.deactivateVirtualPeerNow(peerId, reason ?? peerDisconnectedErr)
        if (violation) {
          router.recomputeTopologyAndRoutes()
        }
        return
      }

      transitionNeighborSlot(peerId, null)
      router.clearCapacityRejected()
      router.bumpTopologyVersion()
      if (isProtocolViolation(reason)) {
        router.quarantinePeer(peerId)
      }
      descriptors.markLeft(peerId)
      purgePeerFromGraph(peerId)
      if (reason === peerLeftRoomErr) {
        router.evictVirtualPeerNow(peerId, reason)
      }
      router.recomputeTopologyAndRoutes()
      maybePublishDescriptor()
    },
    isDirectPeer: peerId => activeDirectPeers.has(peerId),
    isVirtualPeer: peerId => router.isVirtualPeer(peerId),
    canBroadcastDirectMesh: () =>
      activeDirectPeers.size === 0 ||
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
      if (lifecycle !== 'active') {
        return
      }
      lifecycle = 'leaving'
      if (!activeDirectPeers.size) {
        return
      }
      const leaveSeq = seq.nextDescSeq()
      try {
        const id = await loadLocalCryptoIdentity()
        syncSelfIdFromIdentity(id.peerId)
        if (isDestroyed() || !selfId) {
          return
        }
        const sig = await signOverlayPayload(
          id.signPrivateKey,
          canonicalLeaveHeader(selfId, leaveSeq, appId, roomId),
          emptyBytes
        )
        if (isDestroyed() || !activeDirectPeers.size) {
          return
        }
        const packet = packOverlayControl({
          t: 'leave',
          peerId: selfId,
          seq: leaveSeq,
          sig
        })
        for (const neighborId of activeDirectPeers.keys()) {
          sendToDirectNeighbor(neighborId, packet)
        }
      } catch {
        // Ignore leave signature failure during teardown
      }
    },
    destroy: () => {
      if (lifecycle === 'closed') {
        return
      }
      lifecycle = 'closed'
      descriptors.destroy()
      router.destroy()
      dataPlane.destroy()
      seq.clear()
      neighbors.clear()
      actionAuthorities.clear()
    },
    getSnapshot: () => {
      const directPeerIds = [...activeDirectPeers.keys()].sort()
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
      if (isDestroyed()) {
        return
      }
      applyPeerBan(peerId)
    },
    unmarkPeerBanned: peerId => {
      if (isDestroyed() || neighbors.get(peerId)?.phase !== 'banned') {
        return
      }
      transitionNeighborSlot(peerId, null)
      descriptors.clearLeft(peerId)
      router.bumpTopologyVersion()
      router.recomputeTopologyAndRoutes()
    },
    isPeerBanned,
    registerActionAuthority: (actionType, roles) => {
      if (roles.length > 0) {
        actionAuthorities.set(actionType, [...roles])
      } else {
        actionAuthorities.delete(actionType)
      }
    },
    setRoomId: effectiveRoomId => {
      if (isDestroyed() || !effectiveRoomId || effectiveRoomId === roomId) {
        return
      }
      roomId = effectiveRoomId

      for (const vPeerId of Array.from(router.getVirtualPeerIds())) {
        if (!activeDirectPeers.has(vPeerId)) {
          dataPlane.purgePeerDataState(vPeerId)
          router.evictVirtualPeerNow(vPeerId, peerDisconnectedErr)
        }
      }

      seq.originReplay.clear()
      seq.seenMsgIds.clear()
      seq.resetFloor()

      descriptors.resetForRoomIdChange(activeDirectPeers.keys())
      dataPlane.resetRoomCryptoState()
      router.resetForRoomIdChange()
      router.refreshPasswordSalt()
      router.recomputeTopologyAndRoutes()
      maybePublishDescriptor()
    }
  }
}
