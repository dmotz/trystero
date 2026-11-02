import {signRoomAuth} from '../crypto'
import {getDefaultEndpointIdentity} from '../identity'
import type {PeerDataTransport} from '../peer-registry'
import {isValidSignalPeerId} from '../signal-handler'
import {
  decodeBytes,
  fromJson,
  keys,
  noOp,
  peerBannedErr,
  peerDisconnectedErr,
  peerLeftRoomErr,
  resetTimer,
  toJson
} from '../utils'
import type {
  PeerHandle,
  RoleCertificate,
  ScaleConfig,
  TopologyMode,
  TopologyRoute,
  TopologySnapshot,
  TopologyStats,
  UserIdentity
} from '../types'
import {createConnectionPolicy} from './connection-policy'
import {
  canonicalLeaveHeader,
  createCryptoIdentityLoader,
  createOriginTaskQueue,
  createSessionSeqTracker,
  overlayBroadcastKind,
  overlayControlKind,
  overlayFrameVersion,
  overlayUnicastKind,
  packOverlayControl,
  type CryptoIdentity,
  type OverlayControlMessage
} from './crypto-frame'
import {createDescriptorStore} from './descriptors'
import {createOverlayRouter} from './router'
import {
  computeShortestPathRoutes,
  defaultDescriptorTtlMs,
  defaultUnreachableGraceMs,
  deriveMaxHops,
  normalizeTopologyConfig,
  type ResolvedTopologyConfig
} from './topology'

export type OverlayManagerDeps = {
  selfId?: string
  appId?: string
  roomId?: string
  password?: string
  topology?: TopologyMode | ScaleConfig
  descriptorTtlMs?: number
  unreachableGraceMs?: number
  maxUsers?: number
  getLocalUserIdentity?: () => Promise<UserIdentity> | UserIdentity
  onVirtualPeerJoin: (peerId: string, transport: PeerDataTransport) => unknown
  onVirtualPeerLeave: (peerId: string, reason?: Error) => void
  onDeliverData: (originPeerId: string, data: ArrayBuffer) => void
  prepareMediaPeer?: (peerId: string) => Promise<PeerHandle>
  onRemoveDirectPeer?: (peerId: string, reason?: Error) => void
  canPeerSendAction?: (
    peerId: string,
    requiredRoles: readonly string[],
    inlineCert?: RoleCertificate
  ) => Promise<boolean> | boolean
  onPeerDescriptorCert?: (
    peerId: string,
    signPubKey: JsonWebKey,
    cert?: RoleCertificate,
    userId?: string,
    userPubKey?: JsonWebKey
  ) => void
}

export type OverlayManager = {
  config: ResolvedTopologyConfig
  isOverlayActive: () => boolean
  getActiveMode: () => 'mesh' | 'gossip'
  isOverlayFrame: (data: ArrayBuffer) => boolean
  handleOverlayFrame: (fromPeerId: string, data: ArrayBuffer) => void
  handleFrame: (fromPeerId: string, data: ArrayBuffer) => boolean
  addDirectPeer: (peerId: string, peer: PeerHandle) => void
  removeDirectPeer: (peerId: string, peer?: PeerHandle, reason?: Error) => void
  prepareMediaPeer?: (peerId: string) => Promise<PeerHandle>
  isDirectPeer: (peerId: string) => boolean
  isVirtualPeer: (peerId: string) => boolean
  getRoute: (peerId: string) => TopologyRoute | undefined
  broadcastInline: (
    frame: Uint8Array,
    onProgress?: (peerId: string) => void
  ) => Promise<boolean>
  sendUnicast: (targetPeerId: string, frame: Uint8Array) => void
  requireDirectPeer: (peerId: string, options?: {dial?: boolean}) => void
  acceptMediaConnectRequest: (fromPeerId: string) => boolean
  notePeerDiscovered: (peerId: string) => boolean
  shouldConnectPeer: (
    peerId: string,
    direction: 'outbound' | 'inbound'
  ) => boolean
  getTargetNeighbors: () => Set<string>
  setOnTargetsChanged: (cb: (targetPeerIds: string[]) => void) => void
  announceLeave: () => void
  destroy: () => void
  getSnapshot: () => TopologySnapshot
  getLocalCryptoIdentity: () => Promise<CryptoIdentity>
  getPeerSignPublicKey: (peerId: string) => JsonWebKey | undefined
  setPeerSignPublicKey: (peerId: string, pubKey: JsonWebKey) => void
  setLocalRoleCertificate: (cert: RoleCertificate | null) => void
  markPeerBanned: (peerId: string) => void
  isPeerBanned: (peerId: string) => boolean
  registerActionAuthority: (actionType: string, roles: string[]) => void
  recordSignatureFailure: () => void
  setRoomId: (effectiveRoomId: string) => void
}

export const createOverlayManager = ({
  selfId: initialSelfId,
  appId = '',
  roomId: initialRoomId = '',
  password = '',
  topology,
  descriptorTtlMs = defaultDescriptorTtlMs,
  unreachableGraceMs = defaultUnreachableGraceMs,
  maxUsers,
  getLocalUserIdentity,
  onVirtualPeerJoin,
  onVirtualPeerLeave,
  onDeliverData,
  prepareMediaPeer,
  onRemoveDirectPeer,
  canPeerSendAction,
  onPeerDescriptorCert
}: OverlayManagerDeps): OverlayManager => {
  let selfId = initialSelfId ?? ''
  let roomId = initialRoomId
  const config = normalizeTopologyConfig(topology)
  const directPeers = new Map<string, PeerHandle>()
  const pendingFramesByPeer = new Map<string, ArrayBuffer[]>()
  const virtualTransports = new Map<string, PeerDataTransport>()
  const capacityRejectedPeers = new Set<string>()
  // Verified roster only: selfId + connected directPeers + verified descriptors.
  const knownRoster = new Set<string>(selfId ? [selfId] : [])
  const bannedPeers = new Set<string>()
  const actionAuthorities = new Map<string, string[]>()
  let localRoleCert: RoleCertificate | null = null
  const adjacency = new Map<string, Set<string>>()
  const hadRoutePeers = new Set<string>()
  const everConfirmedNeighbors = new Map<string, Set<string>>()
  const unreachableTimers = new Map<string, ReturnType<typeof setTimeout>>()

  let isDestroyed = false
  let currentActiveMode: 'mesh' | 'gossip' =
    config.mode === 'auto' ? 'mesh' : config.mode
  let hadVerifiedAboveThreshold = false
  let routes: Record<string, TopologyRoute> = {}
  let topologyVersion = 0

  const seqTracker = createSessionSeqTracker(
    appId,
    () => roomId,
    () => selfId
  )
  const syncSelfIdFromIdentity = (peerId: string): void => {
    if (!initialSelfId && peerId && peerId !== selfId) {
      knownRoster.delete(selfId)
      selfId = peerId
      knownRoster.add(selfId)
      topologyVersion++
    }
    seqTracker.syncFloor(selfId)
  }
  if (selfId) {
    seqTracker.syncFloor(selfId)
  }
  void getDefaultEndpointIdentity(initialSelfId, appId).then(ep => {
    if (!isDestroyed) {
      syncSelfIdFromIdentity(ep.peerId)
    }
  })

  const stats: TopologyStats = {
    messagesSent: 0,
    messagesReceived: 0,
    messagesForwarded: 0,
    duplicatesDropped: 0,
    signatureFailures: 0
  }

  let passwordTopologySalt = ''
  let passwordSaltToken = 0
  const getRoomSalt = (): string =>
    passwordTopologySalt
      ? toJson([appId, roomId, passwordTopologySalt])
      : appId || roomId
        ? toJson([appId, roomId])
        : ''

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

  const cryptoIdentityLoader = createCryptoIdentityLoader(
    () => selfId || initialSelfId,
    appId,
    () => {
      if (!isDestroyed && config.mode === 'gossip' && directPeers.size > 0) {
        void descriptorStore.publishLocalDescriptor()
      }
    }
  )

  const verifiedClusterSize = (): number =>
    Math.max(
      knownRoster.size,
      descriptorStore.descriptors.size + 1,
      directPeers.size + 1
    )
  const currentMaxHops = (): number =>
    deriveMaxHops(verifiedClusterSize(), config.maxConnections)

  // eslint-disable-next-line prefer-const
  let connectionPolicy: ReturnType<typeof createConnectionPolicy>
  // eslint-disable-next-line prefer-const
  let router: ReturnType<typeof createOverlayRouter>

  const updateActiveMode = (): void => {
    const prevMode = currentActiveMode
    if (config.mode === 'gossip') {
      currentActiveMode = 'gossip'
    } else {
      const verifiedCount = verifiedClusterSize()
      if (verifiedCount > config.autoThreshold) {
        hadVerifiedAboveThreshold = true
      }
      const effectiveCount =
        verifiedCount > 1
          ? verifiedCount
          : 1 + connectionPolicy.discoveredCandidates.size
      if (
        currentActiveMode === 'mesh' &&
        effectiveCount > config.autoThreshold
      ) {
        currentActiveMode = 'gossip'
      } else if (currentActiveMode !== 'mesh' && verifiedCount > 1) {
        const returnToMeshThreshold = hadVerifiedAboveThreshold
          ? Math.max(2, Math.floor(config.autoThreshold * 0.75))
          : config.autoThreshold
        if (
          verifiedCount <= returnToMeshThreshold &&
          (hadVerifiedAboveThreshold ||
            descriptorStore.descriptors.size > 0 ||
            directPeers.size < config.maxConnections)
        ) {
          currentActiveMode = 'mesh'
        }
      }
    }
    if (currentActiveMode !== prevMode) {
      topologyVersion++
    }
  }

  const isOverlayActive = (): boolean => {
    updateActiveMode()
    return (
      config.mode !== 'auto' ||
      currentActiveMode !== 'mesh' ||
      directPeers.size >= 2 ||
      knownRoster.size > 2 ||
      descriptorStore.descriptors.size > 0
    )
  }

  const isAllowedTargetPeer = (peerId: string): boolean =>
    !isDestroyed &&
    isValidSignalPeerId(peerId) &&
    peerId !== selfId &&
    !bannedPeers.has(peerId)

  const clearUnreachableTimer = (peerId: string): void => {
    const timer = unreachableTimers.get(peerId)
    if (timer) {
      resetTimer(timer)
      unreachableTimers.delete(peerId)
    }
  }

  const purgePeerFromGraph = (peerId: string): void => {
    descriptorStore.purgePeerState(peerId)
    router.purgePeerState(peerId)
    connectionPolicy.purgePeer(peerId)
    adjacency.delete(peerId)
    knownRoster.delete(peerId)
    hadRoutePeers.delete(peerId)
    everConfirmedNeighbors.delete(peerId)
    for (const set of adjacency.values()) {
      set.delete(peerId)
    }
    for (const set of everConfirmedNeighbors.values()) {
      set.delete(peerId)
    }
    topologyVersion++
  }

  const closeVirtualTransport = (peerId: string): boolean => {
    const existing = virtualTransports.get(peerId)
    if (!existing) {
      return false
    }
    capacityRejectedPeers.clear()
    existing.close?.()
    virtualTransports.delete(peerId)
    return true
  }

  const deactivateVirtualPeerNow = (peerId: string, reason: Error): void => {
    clearUnreachableTimer(peerId)
    hadRoutePeers.delete(peerId)
    if (closeVirtualTransport(peerId)) {
      onVirtualPeerLeave(peerId, reason)
    }
  }

  const evictVirtualPeerNow = (peerId: string, reason: Error): void => {
    clearUnreachableTimer(peerId)
    const closed = closeVirtualTransport(peerId)
    purgePeerFromGraph(peerId)
    if (closed) {
      onVirtualPeerLeave(peerId, reason)
    }
  }

  const recomputeTopologyAndRoutes = (): void => {
    if (isDestroyed) {
      return
    }
    topologyVersion++
    updateActiveMode()
    adjacency.set(selfId, new Set(directPeers.keys()))

    for (const [u, uNeighbors] of adjacency.entries()) {
      for (const v of uNeighbors) {
        if (adjacency.get(v)?.has(u)) {
          let uSet = everConfirmedNeighbors.get(u)
          if (!uSet) {
            uSet = new Set<string>()
            everConfirmedNeighbors.set(u, uSet)
          }
          uSet.add(v)
        }
      }
    }

    routes = computeShortestPathRoutes(
      selfId,
      adjacency,
      directPeers.keys(),
      currentMaxHops()
    )
    if (!isOverlayActive()) {
      return
    }

    for (const peerId of keys(routes)) {
      if (peerId === selfId) {
        continue
      }
      hadRoutePeers.add(peerId)
      clearUnreachableTimer(peerId)
      if (
        !directPeers.has(peerId) &&
        descriptorStore.descriptors.has(peerId) &&
        !capacityRejectedPeers.has(peerId)
      ) {
        if (!virtualTransports.has(peerId)) {
          const vTransport = router.createVirtualTransport(peerId)
          if (onVirtualPeerJoin(peerId, vTransport) === false) {
            vTransport.close?.()
            virtualTransports.delete(peerId)
            capacityRejectedPeers.add(peerId)
            continue
          }
        }
        if (descriptorStore.descriptors.get(peerId)?.encPubKey) {
          router.flushBufferedBroadcasts(peerId)
        }
      }
    }

    const nonDirectCandidates = new Set<string>([
      ...virtualTransports.keys(),
      ...hadRoutePeers
    ])
    for (const peerId of nonDirectCandidates) {
      if (peerId === selfId || directPeers.has(peerId) || routes[peerId]) {
        continue
      }
      const desc = descriptorStore.descriptors.get(peerId)
      const confirmedSet = everConfirmedNeighbors.get(peerId)
      let anyConfirmedNeighborDropped = false
      const allKnownNeighborsDropped = Boolean(
        desc &&
        desc.neighbors.length > 0 &&
        confirmedSet &&
        confirmedSet.size > 0 &&
        desc.neighbors.every(n => {
          if (!confirmedSet.has(n)) {
            return false
          }
          if (n === selfId) {
            if (!directPeers.has(peerId)) {
              anyConfirmedNeighborDropped = true
              return true
            }
            return false
          }
          const nDesc = descriptorStore.descriptors.get(n)
          if (nDesc && !nDesc.neighbors.includes(peerId)) {
            anyConfirmedNeighborDropped = true
            return true
          }
          return !directPeers.has(n) && !routes[n]
        }) &&
        anyConfirmedNeighborDropped
      )

      if (allKnownNeighborsDropped) {
        if (desc) {
          descriptorStore.recordLeftPeer(peerId, desc.seq)
        }
        evictVirtualPeerNow(peerId, peerDisconnectedErr)
      } else if (!unreachableTimers.has(peerId)) {
        const timer = setTimeout(() => {
          unreachableTimers.delete(peerId)
          if (!isDestroyed && !directPeers.has(peerId) && !routes[peerId]) {
            deactivateVirtualPeerNow(peerId, peerDisconnectedErr)
          }
        }, unreachableGraceMs)
        ;(timer as {unref?: () => void}).unref?.()
        unreachableTimers.set(peerId, timer)
      }
    }

    if (connectionPolicy.hasTargetsCallback() && currentActiveMode !== 'mesh') {
      connectionPolicy.scheduleTargetsNotification()
    }
  }

  const ensureOriginVirtualPeer = (
    origin: string,
    fromPeerId: string
  ): boolean => {
    if (directPeers.has(origin) || virtualTransports.has(origin)) {
      return true
    }
    if (capacityRejectedPeers.has(origin)) {
      return false
    }
    knownRoster.add(origin)
    topologyVersion++
    if (!routes[origin]) {
      routes[origin] = {nextHop: fromPeerId, hops: 2}
    }
    const vTransport = router.createVirtualTransport(origin)
    if (onVirtualPeerJoin(origin, vTransport) === false) {
      vTransport.close?.()
      virtualTransports.delete(origin)
      capacityRejectedPeers.add(origin)
      return false
    }
    return true
  }

  const originTasks = createOriginTaskQueue()

  const descriptorStore = createDescriptorStore({
    appId,
    password,
    descriptorTtlMs,
    maxConnections: config.maxConnections,
    maxUsers,
    stats,
    getSelfId: () => selfId,
    syncSelfIdFromIdentity,
    getRoomId: () => roomId,
    isDestroyed: () => isDestroyed,
    isOverlayActive,
    directPeers,
    knownRoster,
    bannedPeers,
    adjacency,
    getLocalCryptoIdentity: () => cryptoIdentityLoader.load(),
    getLocalUserIdentity,
    getLocalUserId: () => localUserId,
    getLocalRoleCert: () => localRoleCert,
    nextDescSeq: () => seqTracker.nextDescSeq(),
    computeEffectiveTargets: () => connectionPolicy.computeEffectiveTargets(),
    recomputeTopologyAndRoutes,
    sendToDirectNeighbor: (peerId, frame) =>
      router.sendToDirectNeighbor(peerId, frame),
    evictVirtualPeerNow,
    verifyUnicastOrBroadcast: (origin, canonical, payload, sig) =>
      router.verifyUnicastOrBroadcast(origin, canonical, payload, sig),
    onEncPubKeyRotated: peerId => router.onEncPubKeyRotated(peerId),
    originTasks,
    hasManyDiscoveredCandidates: () =>
      connectionPolicy.discoveredCandidates.size > 32,
    onPeerDescriptorCert,
    peerDisconnectedErr,
    peerLeftRoomErr
  })

  connectionPolicy = createConnectionPolicy({
    config,
    directPeers,
    knownRoster,
    bannedPeers,
    capacityRejectedPeers,
    descriptors: descriptorStore.descriptors,
    leftPeersSeq: descriptorStore.leftPeersSeq,
    getSelfId: () => selfId,
    getRoomSalt,
    isAllowedTargetPeer,
    isDestroyed: () => isDestroyed,
    getActiveMode: () => currentActiveMode,
    updateActiveMode,
    getTopologyVersion: () => topologyVersion,
    bumpTopologyVersion: () => {
      topologyVersion++
    },
    hasConvergedComponentDescriptors: () =>
      descriptorStore.hasConvergedComponentDescriptors()
  })

  router = createOverlayRouter({
    appId,
    stats,
    getSelfId: () => selfId,
    syncSelfIdFromIdentity,
    getRoomId: () => roomId,
    isDestroyed: () => isDestroyed,
    isOverlayActive,
    getActiveMode: () => {
      updateActiveMode()
      return currentActiveMode
    },
    currentMaxHops,
    nextPktSeq: () => seqTracker.nextPktSeq(),
    directPeers,
    virtualTransports,
    bannedPeers,
    descriptors: descriptorStore.descriptors,
    pinnedSignKeys: descriptorStore.pinnedSignKeys,
    isLeftPeer: peerId => descriptorStore.leftPeersSeq.has(peerId),
    getPeerSignPublicKey: peerId =>
      descriptorStore.getPeerSignPublicKey(peerId),
    touchOriginActivity: origin => descriptorStore.touchOriginActivity(origin),
    getRoutes: () => routes,
    getLocalCryptoIdentity: () => cryptoIdentityLoader.load(),
    requireDirectPeer: peerId => connectionPolicy.requireDirectPeer(peerId),
    ensureOriginVirtualPeer,
    onDeliverData,
    actionAuthorities,
    originTasks,
    canPeerSendAction
  })

  void cryptoIdentityLoader.load().catch(noOp)

  const isOverlayFrame = (data: ArrayBuffer): boolean =>
    data.byteLength >= 2 &&
    new Uint8Array(data, 0, 1)[0] === overlayFrameVersion

  const handleOverlayFrame = (fromPeerId: string, data: ArrayBuffer): void => {
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
        const parsed = fromJson<OverlayControlMessage>(
          decodeBytes(bytes.subarray(2))
        )
        descriptorStore.dispatchControlMessage(fromPeerId, parsed)
      } catch {
        // Ignore malformed control payload
      }
      return
    }
    if (kind === overlayBroadcastKind || kind === overlayUnicastKind) {
      router.dispatchBinaryFrame(fromPeerId, bytes)
    }
  }

  const refreshPasswordSalt = (): void => {
    const token = ++passwordSaltToken
    if (!password) {
      passwordTopologySalt = ''
      return
    }
    const targetRoomId = roomId
    void signRoomAuth(password, appId, targetRoomId, '@topology', 0)
      .then(salt => {
        if (
          !isDestroyed &&
          token === passwordSaltToken &&
          roomId === targetRoomId &&
          passwordTopologySalt !== salt
        ) {
          passwordTopologySalt = salt
          recomputeTopologyAndRoutes()
          connectionPolicy.scheduleTargetsNotification()
        }
      })
      .catch(noOp)
  }
  refreshPasswordSalt()

  return {
    config,
    isOverlayActive,
    getActiveMode: () => {
      updateActiveMode()
      return currentActiveMode
    },
    isOverlayFrame,
    handleOverlayFrame,
    handleFrame: (fromPeerId: string, data: ArrayBuffer): boolean => {
      if (!isOverlayFrame(data)) {
        return false
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
    addDirectPeer: (peerId: string, peer: PeerHandle): void => {
      if (!isAllowedTargetPeer(peerId)) {
        return
      }
      descriptorStore.leftPeersSeq.delete(peerId)
      capacityRejectedPeers.delete(peerId)
      connectionPolicy.remoteConnectRequests.delete(peerId)
      knownRoster.add(peerId)
      topologyVersion++
      clearUnreachableTimer(peerId)

      // Detach virtual transport from map without closing it so any in-flight
      // pinned multi-chunk transfer finishes cleanly over the overlay route.
      virtualTransports.delete(peerId)
      directPeers.set(peerId, peer)
      recomputeTopologyAndRoutes()

      const queued = pendingFramesByPeer.get(peerId)
      if (queued) {
        pendingFramesByPeer.delete(peerId)
        for (const frame of queued) {
          handleOverlayFrame(peerId, frame)
        }
      }

      if (isOverlayActive()) {
        const initialKnownIds = new Set<string>()
        for (const d of descriptorStore.descriptors.values()) {
          if (d.peerId !== selfId && d.peerId !== peerId) {
            initialKnownIds.add(d.peerId)
          }
        }
        void descriptorStore.publishLocalDescriptor().then(() => {
          descriptorStore.sendInitialDescriptorsTo(peerId, initialKnownIds)
        })
      }
    },
    removeDirectPeer: (
      peerId: string,
      peer?: PeerHandle,
      reason?: Error
    ): void => {
      onRemoveDirectPeer?.(peerId, reason)
      const current = directPeers.get(peerId)
      if (!current || (peer && current !== peer)) {
        if (!current) {
          pendingFramesByPeer.delete(peerId)
          const existingVTransport = virtualTransports.get(peerId)
          if (existingVTransport && routes[peerId]) {
            onVirtualPeerJoin(peerId, existingVTransport)
            return
          }
          if (!existingVTransport) {
            const lastSeq = descriptorStore.descriptors.get(peerId)?.seq ?? 0
            if (lastSeq > 0 || reason?.message === peerLeftRoomErr.message) {
              descriptorStore.recordLeftPeer(peerId, lastSeq)
            }
            purgePeerFromGraph(peerId)
            recomputeTopologyAndRoutes()
          }
        }
        return
      }

      pendingFramesByPeer.delete(peerId)
      directPeers.delete(peerId)
      capacityRejectedPeers.clear()
      topologyVersion++

      if (!isOverlayActive()) {
        purgePeerFromGraph(peerId)
        recomputeTopologyAndRoutes()
        return
      }

      const lastSeq = descriptorStore.descriptors.get(peerId)?.seq ?? 0
      descriptorStore.recordLeftPeer(peerId, lastSeq)
      purgePeerFromGraph(peerId)
      recomputeTopologyAndRoutes()
      void descriptorStore.publishLocalDescriptor()
    },
    ...(prepareMediaPeer ? {prepareMediaPeer} : {}),
    isDirectPeer: (peerId: string): boolean => directPeers.has(peerId),
    isVirtualPeer: (peerId: string): boolean => virtualTransports.has(peerId),
    getRoute: (peerId: string): TopologyRoute | undefined => routes[peerId],
    broadcastInline: router.broadcastInline,
    sendUnicast: router.sendUnicast,
    requireDirectPeer: connectionPolicy.requireDirectPeer,
    acceptMediaConnectRequest: connectionPolicy.acceptMediaConnectRequest,
    notePeerDiscovered: connectionPolicy.notePeerDiscovered,
    shouldConnectPeer: connectionPolicy.shouldConnectPeer,
    getTargetNeighbors: (): Set<string> =>
      new Set(connectionPolicy.computeEffectiveTargets()),
    setOnTargetsChanged: connectionPolicy.setOnTargetsChanged,
    getLocalCryptoIdentity: (): Promise<CryptoIdentity> =>
      cryptoIdentityLoader.load(),
    getPeerSignPublicKey: (peerId: string): JsonWebKey | undefined =>
      descriptorStore.getPeerSignPublicKey(peerId),
    setPeerSignPublicKey: (peerId: string, pubKey: JsonWebKey): void => {
      descriptorStore.setPeerSignPublicKey(peerId, pubKey)
    },
    setLocalRoleCertificate: (cert: RoleCertificate | null): void => {
      localRoleCert = cert
      if (isOverlayActive()) {
        void descriptorStore.publishLocalDescriptor()
      }
    },
    markPeerBanned: (peerId: string): void => {
      bannedPeers.add(peerId)
      connectionPolicy.purgePeer(peerId)
      const lastSeq =
        descriptorStore.descriptors.get(peerId)?.seq ?? Number.MAX_SAFE_INTEGER
      descriptorStore.recordLeftPeer(peerId, lastSeq)
      evictVirtualPeerNow(peerId, peerBannedErr)
      recomputeTopologyAndRoutes()
      if (isOverlayActive()) {
        void descriptorStore.publishLocalDescriptor()
      }
    },
    isPeerBanned: (peerId: string): boolean => bannedPeers.has(peerId),
    registerActionAuthority: (actionType: string, roles: string[]): void => {
      if (roles.length > 0) {
        actionAuthorities.set(actionType, [...roles])
      } else {
        actionAuthorities.delete(actionType)
      }
    },
    recordSignatureFailure: (): void => {
      stats.signatureFailures++
    },
    setRoomId: (effectiveRoomId: string): void => {
      if (effectiveRoomId && effectiveRoomId !== roomId) {
        roomId = effectiveRoomId
        refreshPasswordSalt()
        seqTracker.resetFloorFlag()
        seqTracker.syncFloor(selfId)
        router.resetRoomCryptoState()
        capacityRejectedPeers.clear()
        connectionPolicy.remoteConnectRequests.clear()
        const existingPeerIds: string[] = []
        for (const existingPeerId of descriptorStore.descriptors.keys()) {
          if (existingPeerId !== selfId) {
            existingPeerIds.push(existingPeerId)
          }
        }
        for (const existingPeerId of existingPeerIds) {
          evictVirtualPeerNow(existingPeerId, peerDisconnectedErr)
        }
        recomputeTopologyAndRoutes()
        if (isOverlayActive()) {
          void descriptorStore.publishLocalDescriptor()
        }
      }
    },
    announceLeave: (): void => {
      if (isDestroyed || !isOverlayActive() || directPeers.size === 0) {
        return
      }
      const seq = seqTracker.nextDescSeq()
      void router
        .signUnicastOrBroadcast(
          canonicalLeaveHeader(selfId, seq, appId, roomId),
          new Uint8Array()
        )
        .then(sig => {
          if (isDestroyed) {
            return
          }
          const packet = packOverlayControl({
            t: 'leave',
            peerId: selfId,
            seq,
            sig
          })
          for (const neighborId of directPeers.keys()) {
            router.sendToDirectNeighbor(neighborId, packet)
          }
        })
    },
    destroy: (): void => {
      isDestroyed = true
      descriptorStore.destroy()
      router.destroy()
      pendingFramesByPeer.clear()
      capacityRejectedPeers.clear()
      connectionPolicy.clearTransientState()
      for (const timer of unreachableTimers.values()) {
        resetTimer(timer)
      }
      unreachableTimers.clear()
      for (const vTransport of virtualTransports.values()) {
        vTransport.close?.()
      }
      virtualTransports.clear()
      directPeers.clear()
    },
    getSnapshot: (): TopologySnapshot => {
      updateActiveMode()
      const directPeerIds = [...directPeers.keys()].sort()
      const roomPeerSet = new Set<string>([
        ...directPeerIds,
        ...virtualTransports.keys()
      ])
      return {
        mode: config.mode,
        activeMode: currentActiveMode,
        selfId,
        directPeerIds,
        roomPeerIds: [...roomPeerSet].sort(),
        routes: {...routes},
        stats: {...stats}
      }
    }
  }
}
