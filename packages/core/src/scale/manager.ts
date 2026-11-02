import {inspectActionWireHeader} from '../action-wire'
import {
  derivePairwiseAesKey,
  hash32,
  signRoomAuth,
  verifyRoomAuth
} from '../crypto'
import {
  canonicalizePubJwk,
  getDefaultEndpointIdentity,
  pubJwkToUncompressedBytes,
  verifyPeerIdKey,
  verifyUserEndpointProof
} from '../identity'
import type {KernelScaleProvider} from '../internal-types'
import {
  waitForBufferedAmountLow,
  type PeerDataTransport
} from '../peer-registry'
import {isValidSignalPeerId} from '../signal-handler'
import {
  createSlidingReplayWindow,
  createTokenBucketLimiter,
  toCleanJwk
} from '../signed-record'
import {
  all,
  authMetaKey,
  cmpStr,
  createBoundedCache,
  createBoundedSet,
  decodeBytes,
  encodeBytes,
  fromJson,
  genId,
  isObj,
  isPosSafeInt,
  isStr,
  keys,
  noOp,
  peerBannedErr,
  peerDisconnectedErr,
  peerLeftRoomErr,
  resetTimer,
  toBase64,
  toJson,
  unrefTimer
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
import {
  buildOverlaySignedBytes,
  canonicalBroadcastHeader,
  canonicalLeaveHeader,
  canonicalUnicastHeader,
  canonicalUnicastLeaseHeader,
  decryptUnicastPayload,
  descriptorCanonicalPayload,
  encryptUnicastPayload,
  isValidOverlayMsgId,
  overlayBroadcastKind,
  overlayControlKind,
  overlayFrameVersion,
  overlayUnicastKind,
  packGossipControlFrames,
  packOverlayBinary,
  packOverlayControl,
  parseUnicastLease,
  signOverlayPayload,
  signPeerDescriptor,
  unpackOverlayFrame,
  verifyBase64Sig,
  type BroadcastEnvelopeHeader,
  type CryptoIdentity,
  type OverlayControlMessage,
  type PeerDescriptor,
  type UnicastLeaseTuple,
  type UnpackedOverlayFrame
} from './crypto-frame'
import {
  computeShortestPathRoutes,
  computeTargetNeighbors,
  defaultDescriptorTtlMs,
  defaultMinConnections,
  defaultUnreachableGraceMs,
  deriveMaxHops,
  hashRingKey,
  maxAllowedHops,
  normalizeTopologyConfig,
  type ResolvedTopologyConfig
} from './topology'

const maxDiscoveredCandidates = 512
const maxLocalRequiredPeers = 2_048
const remoteConnectTtlMs = 15_000
const maxActiveRemoteConnectsPerUser = 2
const maxVerifiedDescriptors = 2_048
const maxPeersPerUser = 16
const maxGossipEntriesPerFrame = 64
const maxQueuedUnicastBeforeBackpressure = 4
const nextHopCongestionBytes = 256 * 1024
const unicastLeaseWindowPackets = 256
const maxTrackedOrigins = 2_048
const maxBufferedEarlyBroadcastOrigins = 64
const maxBufferedEarlyBroadcastsPerOrigin = 8
const emptyBytes = /*@__PURE__*/ new Uint8Array(0)
const lastLocalSeqByRoomPeer = /*@__PURE__*/ createBoundedCache<
  string,
  [descSeq: number, pktSeq: number]
>(4_096)

export const isPeerUsable = (
  peer: PeerHandle | undefined
): peer is PeerHandle =>
  Boolean(peer && !peer.isDead && peer.channel?.readyState !== 'closed')

export const getPeerBufferedBytes = (peer: PeerHandle | undefined): number =>
  typeof peer?.channel?.bufferedAmount === 'number'
    ? peer.channel.bufferedAmount
    : 0

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

export const initOverlayManager = (
  initialSelfId: string | undefined,
  appId: string,
  initialRoomId: string,
  password: string,
  topology: TopologyMode | ScaleConfig | undefined,
  descriptorTtlMs: number,
  unreachableGraceMs: number,
  maxUsers: number | undefined,
  getLocalUserIdentity:
    | (() => Promise<UserIdentity> | UserIdentity)
    | undefined,
  onVirtualPeerJoin: (peerId: string, transport: PeerDataTransport) => unknown,
  onVirtualPeerLeave: (peerId: string, reason?: Error) => void,
  onDeliverData: (originPeerId: string, data: ArrayBuffer) => void,
  prepareMediaPeer?: (peerId: string) => Promise<PeerHandle>,
  onRemoveDirectPeer?: (peerId: string, reason?: Error) => void,
  canPeerSendAction?: (
    peerId: string,
    requiredRoles: readonly string[],
    inlineCert?: RoleCertificate
  ) => Promise<boolean> | boolean,
  onPeerDescriptorCert?: (
    peerId: string,
    signPubKey: JsonWebKey,
    cert?: RoleCertificate,
    userId?: string,
    userPubKey?: JsonWebKey
  ) => void
): readonly [
  provider: KernelScaleProvider & {
    handleOverlayFrame: (fromPeerId: string, data: ArrayBuffer) => void
    sendUnicast: (targetPeerId: string, frame: Uint8Array) => void
    requireDirectPeer: (peerId: string, options?: {dial?: boolean}) => void
    acceptMediaConnectRequest: (fromPeerId: string) => boolean
  },
  setRoomId: (effectiveRoomId: string) => void,
  config: ResolvedTopologyConfig,
  isOverlayActive: () => boolean,
  isOverlayFrame: (data: ArrayBuffer) => boolean,
  getLocalCryptoIdentity: () => Promise<CryptoIdentity>,
  getPeerSignPublicKey: (peerId: string) => JsonWebKey | undefined
] => {
  let selfId = initialSelfId ?? ''
  let roomId = initialRoomId
  const config = normalizeTopologyConfig(topology)
  const {mode: cfgMode, maxConnections: maxConns, autoThreshold} = config
  const maxDescriptorNeighbors = Math.max(16, maxConns * 3)

  const directPeers = new Map<string, PeerHandle>()
  const pendingFramesByPeer = new Map<string, ArrayBuffer[]>()
  const virtualTransports = new Map<string, PeerDataTransport>()
  const capacityRejectedPeers = new Set<string>()
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
    cfgMode === 'auto' ? 'mesh' : cfgMode
  let hadVerifiedAboveThreshold = false
  let routes: Record<string, TopologyRoute> = {}
  let topologyVersion = 0

  let descSeq = 0
  let pktSeq = 0
  let didInitFloor = false
  const saveSeqs = (id: string = selfId, initFloor?: boolean): void => {
    if (!id) {
      return
    }
    const key = `${appId}\0${roomId}\0${id}`
    const prev = lastLocalSeqByRoomPeer.get(key)
    if (initFloor && !didInitFloor) {
      didInitFloor = true
      if (prev) {
        descSeq = Math.max(descSeq, prev[0] + 1_024)
        pktSeq = Math.max(pktSeq, prev[1] + 1_024)
      }
    }
    lastLocalSeqByRoomPeer.set(key, [
      Math.max(descSeq, prev?.[0] ?? 0),
      Math.max(pktSeq, prev?.[1] ?? 0)
    ])
  }
  const syncSeqFloor = (id?: string): void => saveSeqs(id, true)
  const nextDescSeq = (): number => (++descSeq, saveSeqs(), descSeq)
  const nextPktSeq = (): number => (++pktSeq, saveSeqs(), pktSeq)

  const syncSelfIdFromIdentity = (peerId: string): void => {
    if (!initialSelfId && peerId && peerId !== selfId) {
      knownRoster.delete(selfId)
      selfId = peerId
      knownRoster.add(selfId)
      topologyVersion++
    }
    syncSeqFloor(selfId)
  }
  if (selfId) {
    syncSeqFloor(selfId)
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
  const failSig = (): false => (stats.signatureFailures++, false)

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

  // Descriptor & connection state
  const descriptors = new Map<string, PeerDescriptor>()
  const descriptorReceivedAt = new Map<string, number>()
  const peerSignPubKeys = new Map<string, JsonWebKey>()
  const pinnedSignKeys = new Map<string, string>()
  const leftPeersSeq = createBoundedCache<string, number>(1_024)
  const [consumeDescRate, deleteDescRate] = createTokenBucketLimiter(
    8,
    16,
    maxVerifiedDescriptors
  )
  const senderInvalidDescCounts = createBoundedCache<string, number>(512)
  const inFlightDescriptors = new Map<string, Promise<boolean>>()
  const pendingUserAdmissions = new Set<string>()

  let targetsChangedCallback: ((targetPeerIds: string[]) => void) | null = null
  let hasCompletedInitialBootstrap = false
  let cachedTargetsVersion = -1
  let cachedEffectiveTargets: Set<string> | null = null
  let targetsNotifyScheduled = false

  const discoveredCandidates = createBoundedCache<string, true>(
    maxDiscoveredCandidates
  )
  const localRequiredPeers = new Set<string>()
  const [consumeConnectRate] = createTokenBucketLimiter(0.5, 2, 512)
  const remoteConnectRequests = createBoundedCache<
    string,
    [ts: number, userId: string | undefined]
  >(Math.max(16, maxConns * 2))

  // Router & replay state
  const originQueues = new Map<string, Promise<void>>()
  const enqueueOriginTask = (key: string, fn: () => Promise<void>): void => {
    const qKey =
      originQueues.has(key) || originQueues.size < maxTrackedOrigins
        ? key
        : `overflow:${hash32(key) & 63}`
    const next = (originQueues.get(qKey) ?? Promise.resolve())
      .then(fn)
      .catch(noOp)
      .finally(() => {
        if (originQueues.get(qKey) === next) {
          originQueues.delete(qKey)
        }
      })
    originQueues.set(qKey, next)
  }
  const [hasOriginReplay, recordOriginReplay] = createSlidingReplayWindow(
    maxTrackedOrigins,
    k => directPeers.has(k) || descriptors.has(k)
  )
  const [hasLeaseReplay, recordLeaseReplay, , clearLeaseReplay] =
    createSlidingReplayWindow(maxTrackedOrigins)
  const seenMsgIds = createBoundedSet<string>(4_096)
  const outboundUnicastLeases = new Map<string, UnicastLeaseTuple>()
  const outboundUnicastQueues = new Map<string, Promise<void>>()
  const outboundQueueDepth = new Map<string, number>()
  const lastUnicastSeqByTarget = new Map<string, number>()
  const pendingEarlyBroadcasts = createBoundedCache<string, ArrayBuffer[]>(
    maxBufferedEarlyBroadcastOrigins
  )

  let localCryptoIdentityP: Promise<CryptoIdentity> | null = null
  const loadLocalCryptoIdentity = (): Promise<CryptoIdentity> =>
    (localCryptoIdentityP ??= (async () => {
      const [endpointId, encPair] = await all([
        getDefaultEndpointIdentity(selfId || initialSelfId, appId),
        crypto.subtle.generateKey({name: 'ECDH', namedCurve: 'P-256'}, false, [
          'deriveKey',
          'deriveBits'
        ])
      ])
      const rawEncPubJwk = await crypto.subtle.exportKey(
        'jwk',
        encPair.publicKey
      )
      const res: CryptoIdentity = {
        peerId: endpointId.peerId,
        signPrivateKey: endpointId.signPrivateKey,
        signPublicKey: endpointId.signPublicKey,
        signPubJwk: endpointId.signPubJwk,
        encPrivateKey: encPair.privateKey,
        encPublicKey: encPair.publicKey,
        encPubJwk: toCleanJwk(rawEncPubJwk)
      }
      if (!isDestroyed && cfgMode === 'gossip' && directPeers.size > 0) {
        void publishLocalDescriptor()
      }
      return res
    })())

  const derivedPairwiseKeys = new Map<string, Promise<CryptoKey>>()
  const getPairwiseKey = (remotePeerId: string): Promise<CryptoKey> | null => {
    const remoteKey = descriptors.get(remotePeerId)?.encPubKey
    const remoteUncompressed = remoteKey
      ? pubJwkToUncompressedBytes(remoteKey)
      : null
    if (!remoteUncompressed) {
      return null
    }
    let cached = derivedPairwiseKeys.get(remotePeerId)
    if (!cached) {
      const curRoomId = roomId
      cached = loadLocalCryptoIdentity().then(id =>
        derivePairwiseAesKey(
          id.encPrivateKey,
          remoteUncompressed,
          appId,
          curRoomId,
          selfId,
          remotePeerId
        )
      )
      cached.catch(() => derivedPairwiseKeys.delete(remotePeerId))
      derivedPairwiseKeys.set(remotePeerId, cached)
    }
    return cached
  }

  const verifiedClusterSize = (): number =>
    Math.max(knownRoster.size, descriptors.size + 1, directPeers.size + 1)
  const currentMaxHops = (): number =>
    deriveMaxHops(verifiedClusterSize(), maxConns)

  const updateActiveMode = (): void => {
    const prevMode = currentActiveMode
    if (cfgMode === 'gossip') {
      currentActiveMode = 'gossip'
    } else {
      const verifiedCount = verifiedClusterSize()
      if (verifiedCount > autoThreshold) {
        hadVerifiedAboveThreshold = true
      }
      const effectiveCount =
        verifiedCount > 1 ? verifiedCount : 1 + discoveredCandidates.size
      if (currentActiveMode === 'mesh' && effectiveCount > autoThreshold) {
        currentActiveMode = 'gossip'
      } else if (currentActiveMode !== 'mesh' && verifiedCount > 1) {
        const returnToMeshThreshold = hadVerifiedAboveThreshold
          ? Math.max(2, Math.floor(autoThreshold * 0.75))
          : autoThreshold
        if (
          verifiedCount <= returnToMeshThreshold &&
          (hadVerifiedAboveThreshold ||
            descriptors.size > 0 ||
            directPeers.size < maxConns)
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
      cfgMode !== 'auto' ||
      currentActiveMode !== 'mesh' ||
      directPeers.size >= 2 ||
      knownRoster.size > 2 ||
      descriptors.size > 0
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

  const purgeConnectionPolicyPeer = (peerId: string): void => {
    localRequiredPeers.delete(peerId)
    remoteConnectRequests.delete(peerId)
    discoveredCandidates.delete(peerId)
  }

  const purgePeerFromGraph = (peerId: string): void => {
    descriptors.delete(peerId)
    descriptorReceivedAt.delete(peerId)
    deleteDescRate(peerId)
    senderInvalidDescCounts.delete(peerId)
    outboundUnicastLeases.delete(peerId)
    pendingEarlyBroadcasts.delete(peerId)
    purgeConnectionPolicyPeer(peerId)
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

  const hasConvergedComponentDescriptors = (): boolean => {
    if (!directPeers.size) {
      return false
    }
    for (const dId of directPeers.keys()) {
      if (!descriptors.has(dId)) {
        return false
      }
    }
    for (const desc of descriptors.values()) {
      for (const nId of desc.neighbors) {
        if (
          nId !== selfId &&
          !leftPeersSeq.has(nId) &&
          !bannedPeers.has(nId) &&
          !descriptors.has(nId)
        ) {
          return false
        }
      }
    }
    return true
  }

  const hasActiveRemoteConnectRequest = (peerId: string): boolean => {
    const req = remoteConnectRequests.get(peerId)
    if (!req) {
      return false
    }
    if (Date.now() - req[0] > remoteConnectTtlMs) {
      remoteConnectRequests.delete(peerId)
      return false
    }
    return true
  }

  const getActiveRemoteConnectIds = (): string[] => {
    const now = Date.now()
    const active: string[] = []
    for (const [id, req] of remoteConnectRequests.entries()) {
      if (now - req[0] <= remoteConnectTtlMs) {
        active.push(id)
      } else {
        remoteConnectRequests.delete(id)
      }
    }
    return active
  }

  const capRoster = (base: Set<string>): Set<string> => {
    if (currentActiveMode === 'mesh' || base.size <= maxConns + 1) {
      return base
    }
    const maxSlots = Math.max(1, Math.floor(maxConns / 3))
    const byUser = new Map<string, string[]>()
    for (const id of base) {
      const uid = id !== selfId ? descriptors.get(id)?.userId : undefined
      if (uid) {
        const list = byUser.get(uid) ?? []
        list.push(id)
        byUser.set(uid, list)
      }
    }
    if (!byUser.size) {
      return base
    }
    const filtered = new Set(base)
    for (const peers of byUser.values()) {
      if (peers.length > maxSlots && base.size - 1 - peers.length >= maxConns) {
        for (const id of [...peers].sort().slice(maxSlots)) {
          filtered.delete(id)
        }
      }
    }
    return filtered
  }

  const computeEffectiveTargets = (): Set<string> => {
    updateActiveMode()
    if (!hasCompletedInitialBootstrap && hasConvergedComponentDescriptors()) {
      hasCompletedInitialBootstrap = true
      topologyVersion++
    }
    if (cachedEffectiveTargets && cachedTargetsVersion === topologyVersion) {
      return cachedEffectiveTargets
    }
    const useVerifiedOnly =
      (currentActiveMode === 'mesh' && knownRoster.size > 1) ||
      hasCompletedInitialBootstrap
    const rawRoster = useVerifiedOnly
      ? knownRoster
      : new Set<string>([...knownRoster, ...discoveredCandidates.keys()])
    const targets = computeTargetNeighbors(
      selfId,
      capRoster(rawRoster),
      currentActiveMode,
      maxConns,
      getRoomSalt()
    )
    for (const reqId of localRequiredPeers) {
      targets.add(reqId)
    }
    cachedEffectiveTargets = targets
    cachedTargetsVersion = topologyVersion
    return targets
  }

  const scheduleTargetsNotification = (): void => {
    if (targetsNotifyScheduled || isDestroyed || !targetsChangedCallback) {
      return
    }
    targetsNotifyScheduled = true
    queueMicrotask(() => {
      targetsNotifyScheduled = false
      if (isDestroyed || !targetsChangedCallback) {
        return
      }
      updateActiveMode()
      if (currentActiveMode === 'mesh') {
        return
      }
      const candidates =
        directPeers.size >= maxConns
          ? new Set([...localRequiredPeers, ...getActiveRemoteConnectIds()])
          : computeEffectiveTargets()
      const missing = [...candidates].filter(id => !directPeers.has(id))
      if (missing.length > 0) {
        targetsChangedCallback(missing)
      }
    })
  }

  const requireDirectPeerImpl = (peerId: string, dial = true): void => {
    if (!isAllowedTargetPeer(peerId)) {
      return
    }
    if (!localRequiredPeers.has(peerId)) {
      if (localRequiredPeers.size >= maxLocalRequiredPeers) {
        const oldest = localRequiredPeers.values().next().value
        if (oldest !== undefined) {
          localRequiredPeers.delete(oldest)
        }
      }
      localRequiredPeers.add(peerId)
      topologyVersion++
    }
    if (dial && !directPeers.has(peerId)) {
      targetsChangedCallback?.([peerId])
    }
  }

  const acceptMediaConnectRequest = (fromPeerId: string): boolean => {
    if (!isAllowedTargetPeer(fromPeerId) || leftPeersSeq.has(fromPeerId)) {
      return false
    }
    if (directPeers.has(fromPeerId)) {
      return true
    }
    if (!knownRoster.has(fromPeerId) && !descriptors.has(fromPeerId)) {
      return false
    }
    const userId = descriptors.get(fromPeerId)?.userId
    if (!consumeConnectRate(userId ?? fromPeerId)) {
      return false
    }
    const now = Date.now()
    if (userId && !remoteConnectRequests.has(fromPeerId)) {
      let activeForUser = 0
      for (const [id, req] of remoteConnectRequests.entries()) {
        if (now - req[0] > remoteConnectTtlMs) {
          remoteConnectRequests.delete(id)
          continue
        }
        if (req[1] === userId) {
          activeForUser++
        }
      }
      if (activeForUser >= maxActiveRemoteConnectsPerUser) {
        return false
      }
    }
    remoteConnectRequests.set(fromPeerId, [now, userId])
    targetsChangedCallback?.([fromPeerId])
    return true
  }

  const resolveHealthyNextHopId = (
    destPeerId: string,
    excludePeerId?: string
  ): string | undefined => {
    if (destPeerId !== excludePeerId) {
      const direct = directPeers.get(destPeerId)
      if (isPeerUsable(direct)) {
        return destPeerId
      }
    }
    const route = routes[destPeerId]
    if (!route) {
      return undefined
    }
    const primaryId =
      route.nextHop !== excludePeerId ? route.nextHop : undefined
    const primaryPeer = primaryId ? directPeers.get(primaryId) : undefined
    const primaryUsable = isPeerUsable(primaryPeer)

    const backupId =
      route.backupNextHop && route.backupNextHop !== excludePeerId
        ? route.backupNextHop
        : undefined
    const backupPeer = backupId ? directPeers.get(backupId) : undefined
    const backupUsable = isPeerUsable(backupPeer)

    if (primaryUsable) {
      const primaryBuf = getPeerBufferedBytes(primaryPeer)
      if (
        primaryBuf > nextHopCongestionBytes &&
        backupUsable &&
        getPeerBufferedBytes(backupPeer) < primaryBuf
      ) {
        return backupId
      }
      return primaryId
    }
    return backupUsable ? backupId : undefined
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

  const getPeerSignPublicKey = (peerId: string): JsonWebKey | undefined =>
    peerSignPubKeys.get(peerId) ?? descriptors.get(peerId)?.signPubKey

  const signUnicastOrBroadcast = async (
    canonicalHeader: string,
    payload: Uint8Array
  ): Promise<string> => {
    const id = await loadLocalCryptoIdentity()
    syncSelfIdFromIdentity(id.peerId)
    return signOverlayPayload(id.signPrivateKey, canonicalHeader, payload)
  }

  const verifyUnicastOrBroadcast = async (
    originPeerId: string,
    canonicalHeader: string,
    payload: Uint8Array,
    sig: string | undefined
  ): Promise<boolean> => {
    const signPubJwk = sig ? getPeerSignPublicKey(originPeerId) : undefined
    if (!sig || !signPubJwk) {
      return failSig()
    }
    const pinned = pinnedSignKeys.get(originPeerId)
    if (pinned && pinned !== canonicalizePubJwk(signPubJwk)) {
      return failSig()
    }
    const ok = await verifyBase64Sig(
      sig,
      buildOverlaySignedBytes(canonicalHeader, payload),
      signPubJwk
    )
    return ok ? true : failSig()
  }

  const routeUnicastPacket = (
    destPeerId: string,
    packet: Uint8Array,
    excludePeerId?: string,
    pinnedHopId?: string
  ): boolean => {
    if (
      pinnedHopId &&
      pinnedHopId !== excludePeerId &&
      sendToDirectNeighbor(pinnedHopId, packet)
    ) {
      return true
    }
    const preferredHop = resolveHealthyNextHopId(destPeerId, excludePeerId)
    if (preferredHop && sendToDirectNeighbor(preferredHop, packet)) {
      return true
    }
    const route = routes[destPeerId]
    if (
      route &&
      route.nextHop !== excludePeerId &&
      route.nextHop !== preferredHop &&
      sendToDirectNeighbor(route.nextHop, packet)
    ) {
      return true
    }
    return Boolean(
      route?.backupNextHop &&
      route.backupNextHop !== excludePeerId &&
      route.backupNextHop !== preferredHop &&
      sendToDirectNeighbor(route.backupNextHop, packet)
    )
  }

  const sendUnicastInternal = (
    targetPeerId: string,
    frame: Uint8Array,
    forceOverlay?: boolean,
    pinnedHopId?: string,
    promoteDirect?: boolean,
    strict?: boolean
  ): void => {
    if (isDestroyed) {
      if (strict) {
        throw peerDisconnectedErr
      }
      return
    }

    const hasPendingQueue = (outboundQueueDepth.get(targetPeerId) ?? 0) > 0
    if (!forceOverlay && !hasPendingQueue && directPeers.has(targetPeerId)) {
      if (sendToDirectNeighbor(targetPeerId, frame)) {
        stats.messagesSent++
        return
      }
    }

    if (promoteDirect) {
      requireDirectPeerImpl(targetPeerId)
    }

    const pairwiseKeyP = getPairwiseKey(targetPeerId)
    if (!pairwiseKeyP || !resolveHealthyNextHopId(targetPeerId)) {
      if (strict) {
        throw peerDisconnectedErr
      }
      return
    }

    const curSelfId = selfId
    const curRoomId = roomId
    const seq = nextPktSeq()
    const prevTargetSeq = lastUnicastSeqByTarget.get(targetPeerId)
    lastUnicastSeqByTarget.set(targetPeerId, seq)
    const useStreamLease =
      Boolean(promoteDirect || forceOverlay) ||
      (prevTargetSeq !== undefined &&
        seq - prevTargetSeq <= unicastLeaseWindowPackets)

    const msgId = `${curSelfId}:${seq}:${genId(8)}`
    recordOriginReplay(curSelfId, seq)
    seenMsgIds.add(msgId)

    const frameCopy = frame.slice()
    outboundQueueDepth.set(
      targetPeerId,
      (outboundQueueDepth.get(targetPeerId) ?? 0) + 1
    )
    const prevQueue =
      outboundUnicastQueues.get(targetPeerId) ?? Promise.resolve()
    const nextQueue = prevQueue
      .then(async () => {
        if (isDestroyed) {
          return
        }
        let payloadToSend: Uint8Array
        let ivB64: string
        let canonical: string

        const latestKeyP = getPairwiseKey(targetPeerId) ?? pairwiseKeyP
        try {
          const aesKey = await latestKeyP
          const iv = crypto.getRandomValues(new Uint8Array(12))
          ivB64 = toBase64(iv)
          canonical = canonicalUnicastHeader(
            curSelfId,
            targetPeerId,
            msgId,
            ivB64,
            seq,
            appId,
            curRoomId
          )
          payloadToSend = await encryptUnicastPayload(
            aesKey,
            iv,
            canonical,
            frameCopy
          )
        } catch {
          return
        }

        let activeLease = outboundUnicastLeases.get(targetPeerId)
        const useLease =
          useStreamLease ||
          Boolean(activeLease && seq >= activeLease[0] && seq <= activeLease[1])
        if (
          useLease &&
          (!activeLease || seq < activeLease[0] || seq > activeLease[1])
        ) {
          const hi = seq + unicastLeaseWindowPackets - 1
          activeLease = [
            seq,
            hi,
            await signUnicastOrBroadcast(
              canonicalUnicastLeaseHeader(
                curSelfId,
                targetPeerId,
                seq,
                hi,
                appId,
                curRoomId
              ),
              emptyBytes
            )
          ]
          outboundUnicastLeases.set(targetPeerId, activeLease)
        }
        const sig = useLease
          ? undefined
          : await signUnicastOrBroadcast(canonical, payloadToSend)
        if (isDestroyed) {
          return
        }
        const packet = packOverlayBinary(
          overlayUnicastKind,
          currentMaxHops(),
          {
            o: curSelfId,
            d: targetPeerId,
            q: seq,
            m: msgId,
            iv: ivB64,
            ...(useLease ? {l: activeLease!} : {s: sig!})
          },
          payloadToSend
        )
        if (routeUnicastPacket(targetPeerId, packet, undefined, pinnedHopId)) {
          stats.messagesSent++
        }
      })
      .catch(noOp)
      .finally(() => {
        const nextDepth = (outboundQueueDepth.get(targetPeerId) ?? 1) - 1
        if (nextDepth <= 0) {
          outboundQueueDepth.delete(targetPeerId)
        } else {
          outboundQueueDepth.set(targetPeerId, nextDepth)
        }
        if (outboundUnicastQueues.get(targetPeerId) === nextQueue) {
          outboundUnicastQueues.delete(targetPeerId)
        }
      })
    outboundUnicastQueues.set(targetPeerId, nextQueue)
  }

  const createVirtualTransport = (peerId: string): PeerDataTransport => {
    const existing = virtualTransports.get(peerId)
    if (existing && existing.isOpen) {
      return existing
    }

    let closed = false
    const pinnedTransferHops = createBoundedCache<number, string>(64)

    const isReachable = (): boolean =>
      !closed &&
      !isDestroyed &&
      !bannedPeers.has(peerId) &&
      !leftPeersSeq.has(peerId) &&
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
      sendFrame: (bytes, transferId, isOffer) => {
        if (!isReachable()) {
          throw peerDisconnectedErr
        }
        if (transferId !== undefined) {
          let hop = pinnedTransferHops.get(transferId)
          if (!hop || !isPeerUsable(directPeers.get(hop))) {
            hop = resolveHealthyNextHopId(peerId)
            if (hop) {
              pinnedTransferHops.set(transferId, hop)
            }
          }
          sendUnicastInternal(peerId, bytes, true, hop, Boolean(isOffer), true)
          return
        }
        sendUnicastInternal(peerId, bytes, false, undefined, false, true)
      },
      waitForDrain: signal => {
        if (signal?.aborted || !isReachable()) {
          return false
        }
        const hop = resolveHealthyNextHopId(peerId)
        const hopChannel = hop ? directPeers.get(hop)?.channel : null
        const depth = outboundQueueDepth.get(peerId) ?? 0
        const queuePromise =
          depth >= maxQueuedUnicastBeforeBackpressure
            ? outboundUnicastQueues.get(peerId)
            : undefined
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
          if (
            latestChannel &&
            !(await waitForBufferedAmountLow(latestChannel, signal))
          ) {
            return false
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

  const flushBufferedBroadcasts = (origin: string): void => {
    const buffered = pendingEarlyBroadcasts.get(origin)
    if (!buffered || !buffered.length) {
      return
    }
    pendingEarlyBroadcasts.delete(origin)
    for (const buf of buffered) {
      if (isDestroyed || bannedPeers.has(origin) || leftPeersSeq.has(origin)) {
        break
      }
      stats.messagesReceived++
      onDeliverData(origin, buf)
    }
  }

  const addMapSet = (
    m: Map<string, Set<string>>,
    k: string,
    v: string
  ): void => {
    let s = m.get(k)
    if (!s) {
      m.set(k, (s = new Set()))
    }
    s.add(v)
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
          addMapSet(everConfirmedNeighbors, u, v)
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
        descriptors.has(peerId) &&
        !capacityRejectedPeers.has(peerId)
      ) {
        if (!virtualTransports.has(peerId) && !admitVirtualPeer(peerId)) {
          continue
        }
        if (descriptors.get(peerId)?.encPubKey) {
          flushBufferedBroadcasts(peerId)
        }
      }
    }

    for (const peerId of new Set<string>([
      ...virtualTransports.keys(),
      ...hadRoutePeers
    ])) {
      if (peerId === selfId || directPeers.has(peerId) || routes[peerId]) {
        continue
      }
      const desc = descriptors.get(peerId)
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
          const nDesc = descriptors.get(n)
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
          leftPeersSeq.set(peerId, desc.seq)
        }
        evictVirtualPeerNow(peerId, peerDisconnectedErr)
      } else if (!unreachableTimers.has(peerId)) {
        const timer = setTimeout(() => {
          unreachableTimers.delete(peerId)
          if (!isDestroyed && !directPeers.has(peerId) && !routes[peerId]) {
            deactivateVirtualPeerNow(peerId, peerDisconnectedErr)
          }
        }, unreachableGraceMs)
        unrefTimer(timer)
        unreachableTimers.set(peerId, timer)
      }
    }

    if (targetsChangedCallback && currentActiveMode !== 'mesh') {
      scheduleTargetsNotification()
    }
  }

  const admitVirtualPeer = (peerId: string): boolean => {
    const vTransport = createVirtualTransport(peerId)
    if (onVirtualPeerJoin(peerId, vTransport) === false) {
      vTransport.close?.()
      virtualTransports.delete(peerId)
      capacityRejectedPeers.add(peerId)
      return false
    }
    return true
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
    return admitVirtualPeer(origin)
  }

  const recordSenderInvalid = (fromPeerId: string): void => {
    senderInvalidDescCounts.set(
      fromPeerId,
      (senderInvalidDescCounts.get(fromPeerId) ?? 0) + 1
    )
  }

  const findEvictable = (
    now: number,
    limit: number,
    filter?: (d: PeerDescriptor) => boolean
  ): string | null | false => {
    let count = 0
    let oldestId: string | null = null
    let oldestTime = Infinity
    for (const d of descriptors.values()) {
      if (!filter || filter(d)) {
        count++
        if (d.peerId !== selfId && !directPeers.has(d.peerId)) {
          const t = descriptorReceivedAt.get(d.peerId) ?? 0
          if (t < oldestTime) {
            oldestTime = t
            oldestId = d.peerId
          }
        }
      }
    }
    return count < limit
      ? null
      : oldestId && now - oldestTime > descriptorTtlMs
        ? oldestId
        : false
  }

  const findEvictableUserPeer = (
    userId: string,
    candidatePeerId: string,
    now: number
  ): string | null | false =>
    findEvictable(
      now,
      maxPeersPerUser,
      d => d.peerId !== candidatePeerId && d.userId === userId
    )

  const findEvictableStaleDescriptor = (now: number): string | null | false =>
    descriptors.size < maxVerifiedDescriptors
      ? null
      : findEvictable(now, maxVerifiedDescriptors)

  const canAdmitWithinUserLimit = (d: PeerDescriptor, now: number): boolean => {
    if (maxUsers === undefined) {
      return true
    }
    const activeIdentityKeys = new Set<string>([
      localUserId ?? descriptors.get(selfId)?.userId ?? (selfId || '__self__')
    ])
    for (const directId of directPeers.keys()) {
      activeIdentityKeys.add(descriptors.get(directId)?.userId ?? directId)
    }
    for (const [descPeerId, existingDesc] of descriptors.entries()) {
      if (descPeerId === selfId) {
        continue
      }
      const receivedAt = descriptorReceivedAt.get(descPeerId) ?? 0
      if (directPeers.has(descPeerId) || now - receivedAt <= descriptorTtlMs) {
        activeIdentityKeys.add(existingDesc.userId ?? descPeerId)
      }
    }
    for (const pendingKey of pendingUserAdmissions) {
      activeIdentityKeys.add(pendingKey)
    }
    const candidateKey = d.userId ?? d.peerId
    return (
      activeIdentityKeys.has(candidateKey) || activeIdentityKeys.size < maxUsers
    )
  }

  const hasValidDescriptorShape = (
    d: PeerDescriptor
  ): d is PeerDescriptor & {signPubKey: JsonWebKey; sig: string} =>
    Boolean(
      d &&
      isValidSignalPeerId(d.peerId) &&
      isPosSafeInt(d.seq) &&
      d.signPubKey &&
      isStr(d.sig) &&
      Array.isArray(d.neighbors) &&
      d.neighbors.length <= maxDescriptorNeighbors &&
      d.neighbors.every(n => isValidSignalPeerId(n) && n !== d.peerId) &&
      (d.encPubKey === undefined ||
        Boolean(pubJwkToUncompressedBytes(d.encPubKey))) &&
      !bannedPeers.has(d.peerId)
    )

  const verifyDescriptor = (d: PeerDescriptor): boolean | Promise<boolean> => {
    const curRoomId = roomId
    if (!hasValidDescriptorShape(d)) {
      return failSig()
    }
    const keyThumbprint = canonicalizePubJwk(d.signPubKey)
    const pinned = pinnedSignKeys.get(d.peerId)
    if (pinned && pinned !== keyThumbprint) {
      return failSig()
    }
    const checkUser =
      Boolean(getLocalUserIdentity) ||
      d.userId !== undefined ||
      d.userPubKey !== undefined ||
      d.userProof !== undefined
    if (
      (checkUser && (!d.userId || !d.userPubKey || !d.userProof)) ||
      (password && !isStr(d.roomAuth))
    ) {
      return failSig()
    }
    const checkEndpointProof = (): boolean | Promise<boolean> =>
      verifyUserEndpointProof({
        appId,
        roomId: curRoomId,
        peerId: d.peerId,
        peerPubJwk: d.signPubKey,
        userId: d.userId!,
        userPubJwk: d.userPubKey!,
        proof: d.userProof!,
        seq: d.seq
      })
    const peerOk = password ? null : verifyPeerIdKey(d.peerId, d.signPubKey)
    if (peerOk === false) {
      return failSig()
    }
    const userOk =
      peerOk === true && checkUser
        ? checkEndpointProof()
        : checkUser
          ? null
          : true
    if (userOk === false) {
      return failSig()
    }
    const verifyDescSig = (): boolean | Promise<boolean> => {
      const sigOk = verifyBase64Sig(
        d.sig,
        encodeBytes(descriptorCanonicalPayload(d, appId, curRoomId)),
        d.signPubKey
      )
      const done = (ok: boolean): boolean => {
        const latest = pinnedSignKeys.get(d.peerId)
        if (!ok || (latest && latest !== keyThumbprint)) {
          return failSig()
        }
        pinnedSignKeys.set(d.peerId, keyThumbprint)
        peerSignPubKeys.set(d.peerId, d.signPubKey)
        onPeerDescriptorCert?.(
          d.peerId,
          d.signPubKey,
          d.cert,
          d.userId,
          d.userPubKey
        )
        return true
      }
      return typeof sigOk === 'boolean' ? done(sigOk) : sigOk.then(done)
    }
    if (peerOk === true && userOk === true) {
      return verifyDescSig()
    }

    return (async () => {
      if (
        password &&
        !(await verifyRoomAuth(
          password,
          appId,
          curRoomId,
          d.peerId,
          d.seq,
          d.roomAuth!
        ))
      ) {
        return failSig()
      }
      if (!(await (peerOk ?? verifyPeerIdKey(d.peerId, d.signPubKey)))) {
        return failSig()
      }
      if (checkUser && !(await (userOk ?? checkEndpointProof()))) {
        return failSig()
      }
      return verifyDescSig()
    })()
  }

  const sendGossipToNeighbors = (
    list: PeerDescriptor[],
    excludePeerId?: string
  ): void => {
    const packets = packGossipControlFrames(list)
    if (!packets.length) {
      return
    }
    for (const neighborId of directPeers.keys()) {
      if (neighborId !== excludePeerId) {
        for (const packet of packets) {
          sendToDirectNeighbor(neighborId, packet)
        }
      }
    }
  }

  let pendingPublishPromise: Promise<void> | null = null
  let publishDirty = false

  const buildLocalDescriptor = async (): Promise<PeerDescriptor> => {
    const id = await loadLocalCryptoIdentity()
    const userIdentity = getLocalUserIdentity
      ? await getLocalUserIdentity()
      : null
    syncSelfIdFromIdentity(id.peerId)

    publishDirty = false
    const seq = nextDescSeq()
    const allDirect = [...directPeers.keys()]
    const targets =
      allDirect.length <= maxDescriptorNeighbors
        ? null
        : computeEffectiveTargets()
    const neighbors = (
      !targets
        ? allDirect
        : allDirect
            .sort(
              (a, b) =>
                Number(targets.has(b)) - Number(targets.has(a)) || cmpStr(a, b)
            )
            .slice(0, maxDescriptorNeighbors)
    ).sort()

    return signPeerDescriptor(
      {
        peerId: selfId,
        seq,
        neighbors,
        signPubKey: id.signPubJwk,
        encPubKey: id.encPubJwk,
        ...(localRoleCert ? {cert: localRoleCert} : {})
      },
      id,
      appId,
      roomId,
      password,
      userIdentity
    )
  }

  const publishLocalDescriptor = (): Promise<void> => {
    if (isDestroyed || !isOverlayActive()) {
      return Promise.resolve()
    }
    publishDirty = true
    if (!pendingPublishPromise) {
      pendingPublishPromise = new Promise<void>(resolve => {
        queueMicrotask(async () => {
          try {
            while (publishDirty && !isDestroyed && isOverlayActive()) {
              const signedDescriptor = await buildLocalDescriptor()
              if (isDestroyed) {
                break
              }
              descriptors.set(selfId, signedDescriptor)
              descriptorReceivedAt.set(selfId, Date.now())
              adjacency.set(selfId, new Set(signedDescriptor.neighbors))
              recomputeTopologyAndRoutes()
              if (!publishDirty) {
                sendGossipToNeighbors([signedDescriptor])
              }
            }
          } finally {
            pendingPublishPromise = null
            resolve()
          }
        })
      })
    }
    return pendingPublishPromise
  }

  const pendingGossipDescriptors = new Map<string, PeerDescriptor>()
  const pendingGossipSources = new Set<string>()
  let gossipFlushScheduled = false

  const flushPendingGossip = (): void => {
    gossipFlushScheduled = false
    if (isDestroyed) {
      return
    }
    const batch = [...pendingGossipDescriptors.values()]
    const excludeId =
      pendingGossipSources.size === 1 ? [...pendingGossipSources][0] : undefined
    pendingGossipDescriptors.clear()
    pendingGossipSources.clear()
    recomputeTopologyAndRoutes()
    sendGossipToNeighbors(batch, excludeId)
  }

  const applyVerifiedDescriptor = (
    fromPeerId: string,
    d: PeerDescriptor,
    isValid: boolean
  ): void => {
    if (!isValid || isDestroyed) {
      if (!isValid && !isDestroyed) {
        recordSenderInvalid(fromPeerId)
      }
      return
    }

    const latest = descriptors.get(d.peerId)
    if (latest && latest.seq >= d.seq) {
      return
    }

    if (!latest && !directPeers.has(d.peerId)) {
      const now = Date.now()
      if (d.userId) {
        const evictUidPeer = findEvictableUserPeer(d.userId, d.peerId, now)
        if (evictUidPeer === false) {
          return
        }
        if (evictUidPeer) {
          evictVirtualPeerNow(evictUidPeer, peerDisconnectedErr)
        }
      }
      const evictStale = findEvictableStaleDescriptor(now)
      if (evictStale === false) {
        return
      }
      if (evictStale) {
        evictVirtualPeerNow(evictStale, peerDisconnectedErr)
      }
    }

    if (
      latest?.encPubKey &&
      d.encPubKey &&
      canonicalizePubJwk(latest.encPubKey) !== canonicalizePubJwk(d.encPubKey)
    ) {
      derivedPairwiseKeys.delete(d.peerId)
    }
    const wasMarkedLeft = leftPeersSeq.has(d.peerId)
    leftPeersSeq.delete(d.peerId)
    knownRoster.add(d.peerId)
    descriptors.set(d.peerId, d)
    descriptorReceivedAt.set(d.peerId, Date.now())
    adjacency.set(
      d.peerId,
      new Set(
        d.neighbors.filter(
          n =>
            !leftPeersSeq.has(n) &&
            !bannedPeers.has(n) &&
            (n !== selfId || directPeers.has(d.peerId))
        )
      )
    )
    if (wasMarkedLeft && !bannedPeers.has(d.peerId)) {
      for (const [otherId, otherDesc] of descriptors.entries()) {
        if (
          otherId !== selfId &&
          otherId !== d.peerId &&
          !leftPeersSeq.has(otherId) &&
          otherDesc.neighbors.includes(d.peerId)
        ) {
          addMapSet(adjacency, otherId, d.peerId)
        }
      }
    }

    const prev = pendingGossipDescriptors.get(d.peerId)
    if (!prev || prev.seq < d.seq) {
      pendingGossipDescriptors.set(d.peerId, d)
    }
    pendingGossipSources.add(fromPeerId)
    if (!gossipFlushScheduled) {
      gossipFlushScheduled = true
      if (descriptors.size > 32 || discoveredCandidates.size > 32) {
        unrefTimer(setTimeout(flushPendingGossip, 2))
      } else {
        queueMicrotask(flushPendingGossip)
      }
    }
  }

  const isStaleOrLeftSeq = (id: string, seq: number): boolean => {
    const leftSeq = leftPeersSeq.get(id)
    return (
      (leftSeq !== undefined && seq <= leftSeq) ||
      (descriptors.get(id)?.seq ?? 0) >= seq
    )
  }

  const processDescriptorStep = (
    fromPeerId: string,
    d: PeerDescriptor
  ): void | Promise<void> => {
    if (
      isDestroyed ||
      !d ||
      d.peerId === selfId ||
      isStaleOrLeftSeq(d.peerId, d.seq)
    ) {
      return
    }
    const existing = descriptors.get(d.peerId)

    if (!hasValidDescriptorShape(d)) {
      failSig()
      recordSenderInvalid(fromPeerId)
      return
    }

    const descInFlightKey = `${d.peerId}:${d.seq}:${d.sig}`
    const existingInFlight = inFlightDescriptors.get(descInFlightKey)
    if (!existingInFlight) {
      if (existing) {
        if (!consumeDescRate(d.peerId)) {
          failSig()
          return
        }
      } else {
        if ((senderInvalidDescCounts.get(fromPeerId) ?? 0) >= 16) {
          failSig()
          return
        }
        if (!directPeers.has(d.peerId)) {
          const now = Date.now()
          if (
            (d.userId &&
              findEvictableUserPeer(d.userId, d.peerId, now) === false) ||
            !canAdmitWithinUserLimit(d, now) ||
            findEvictableStaleDescriptor(now) === false
          ) {
            return
          }
        }
      }
    }

    const verifyRes = existingInFlight ?? verifyDescriptor(d)
    if (typeof verifyRes === 'boolean') {
      applyVerifiedDescriptor(fromPeerId, d, verifyRes)
      return
    }

    const reservedUserKey =
      !existing && !directPeers.has(d.peerId) && maxUsers !== undefined
        ? (d.userId ?? d.peerId)
        : null
    if (reservedUserKey) {
      pendingUserAdmissions.add(reservedUserKey)
    }
    if (!existingInFlight) {
      inFlightDescriptors.set(descInFlightKey, verifyRes)
    }
    return verifyRes
      .then(isValid => {
        applyVerifiedDescriptor(fromPeerId, d, isValid)
      })
      .finally(() => {
        if (inFlightDescriptors.get(descInFlightKey) === verifyRes) {
          inFlightDescriptors.delete(descInFlightKey)
        }
        if (reservedUserKey) {
          pendingUserAdmissions.delete(reservedUserKey)
        }
      })
  }

  const dispatchControlMessage = (
    fromPeerId: string,
    msg: OverlayControlMessage
  ): void => {
    if (isDestroyed || !msg || typeof msg !== 'object') {
      return
    }

    if (msg.t === 'leave') {
      const leavingId = msg.peerId
      if (!isValidSignalPeerId(leavingId) || leavingId === selfId) {
        return
      }
      enqueueOriginTask(`ctrl:${leavingId}`, async () => {
        if (isDestroyed) {
          return
        }
        if (!isPosSafeInt(msg.seq) || !isStr(msg.sig)) {
          failSig()
          return
        }
        const existingDesc = descriptors.get(leavingId)
        const prevLeftSeq = leftPeersSeq.get(leavingId)
        if (
          (existingDesc && msg.seq < existingDesc.seq) ||
          (prevLeftSeq !== undefined && msg.seq <= prevLeftSeq)
        ) {
          return
        }
        const valid = await verifyUnicastOrBroadcast(
          leavingId,
          canonicalLeaveHeader(leavingId, msg.seq, appId, roomId),
          emptyBytes,
          msg.sig
        )
        if (!valid || isDestroyed) {
          return
        }
        leftPeersSeq.set(
          leavingId,
          Math.max(msg.seq, descriptors.get(leavingId)?.seq ?? 0)
        )
        evictVirtualPeerNow(leavingId, peerLeftRoomErr)
        recomputeTopologyAndRoutes()
        const fwd = packOverlayControl(msg)
        for (const neighborId of directPeers.keys()) {
          if (neighborId !== fromPeerId && neighborId !== leavingId) {
            sendToDirectNeighbor(neighborId, fwd)
          }
        }
      })
      return
    }

    if (msg.t === 'gossip' && Array.isArray(msg.descriptors)) {
      const dedupedByOrigin = new Map<string, PeerDescriptor>()
      for (const d of msg.descriptors.slice(0, maxGossipEntriesPerFrame)) {
        if (!d || typeof d !== 'object') {
          continue
        }
        if (typeof d.peerId !== 'string' || !isValidSignalPeerId(d.peerId)) {
          failSig()
          recordSenderInvalid(fromPeerId)
          continue
        }
        const prev = dedupedByOrigin.get(d.peerId)
        if (!prev || (typeof d.seq === 'number' && d.seq > prev.seq)) {
          dedupedByOrigin.set(d.peerId, d)
        }
      }
      for (const [originId, desc] of dedupedByOrigin.entries()) {
        if (originId === selfId || isStaleOrLeftSeq(originId, desc.seq)) {
          continue
        }
        const queueKey = `ctrl:${originId}`
        if (!originQueues.has(queueKey)) {
          const stepRes = processDescriptorStep(fromPeerId, desc)
          if (stepRes) {
            enqueueOriginTask(queueKey, () => stepRes)
          }
        } else {
          enqueueOriginTask(queueKey, () =>
            Promise.resolve(processDescriptorStep(fromPeerId, desc))
          )
        }
      }
    }
  }

  const baseHeartbeatMs = Math.max(
    200,
    Math.min(15_000, Math.floor(descriptorTtlMs / 3))
  )
  const heartbeatIntervalMs =
    baseHeartbeatMs >= 2_000
      ? baseHeartbeatMs +
        Math.floor(Math.random() * Math.floor(baseHeartbeatMs * 0.25))
      : baseHeartbeatMs
  const heartbeatTimer = setInterval(() => {
    if (isDestroyed) {
      return
    }
    const now = Date.now()
    let expiredAny = false
    for (const [peerId, receivedAt] of descriptorReceivedAt.entries()) {
      if (
        peerId !== selfId &&
        !directPeers.has(peerId) &&
        now - receivedAt > descriptorTtlMs
      ) {
        const desc = descriptors.get(peerId)
        if (desc) {
          leftPeersSeq.set(peerId, desc.seq)
        }
        evictVirtualPeerNow(peerId, peerDisconnectedErr)
        expiredAny = true
      }
    }
    if (expiredAny) {
      recomputeTopologyAndRoutes()
    }
    const lastOwnPublishAt = descriptorReceivedAt.get(selfId) ?? 0
    if (
      isOverlayActive() &&
      directPeers.size > 0 &&
      now - lastOwnPublishAt >= Math.floor(baseHeartbeatMs * 0.75)
    ) {
      void publishLocalDescriptor()
    }
  }, heartbeatIntervalMs)
  unrefTimer(heartbeatTimer)

  const touchOriginActivity = (origin: string): void => {
    if (descriptors.has(origin)) {
      descriptorReceivedAt.set(origin, Date.now())
    }
  }

  const forwardBroadcastPacket = (
    originPeerId: string,
    ttl: number,
    header: BroadcastEnvelopeHeader,
    payload: Uint8Array,
    fromPeerId?: string
  ): number => {
    if (ttl <= 0) {
      return 0
    }
    const packet = packOverlayBinary(overlayBroadcastKind, ttl, header, payload)
    let sentCount = 0
    for (const neighborId of directPeers.keys()) {
      if (
        neighborId !== fromPeerId &&
        neighborId !== originPeerId &&
        sendToDirectNeighbor(neighborId, packet)
      ) {
        sentCount++
      }
    }
    return sentCount
  }

  const broadcastInline = async (
    frame: Uint8Array,
    onProgress?: (peerId: string) => void
  ): Promise<boolean> => {
    if (
      !isOverlayActive() ||
      (currentActiveMode === 'mesh' && virtualTransports.size === 0)
    ) {
      return false
    }

    const hasPeers = directPeers.size > 0 || virtualTransports.size > 0
    if (hasPeers && ![...directPeers.values()].some(isPeerUsable)) {
      return false
    }

    const curSelfId = selfId
    const seq = nextPktSeq()
    const msgId = `${curSelfId}:${seq}:${genId(8)}`
    recordOriginReplay(curSelfId, seq)
    seenMsgIds.add(msgId)

    const sig = await signUnicastOrBroadcast(
      canonicalBroadcastHeader(curSelfId, msgId, seq, appId, roomId),
      frame
    )
    const sentCount = forwardBroadcastPacket(
      curSelfId,
      currentMaxHops(),
      {o: curSelfId, q: seq, m: msgId, ...(sig ? {s: sig} : {})},
      frame
    )
    if (sentCount === 0 && hasPeers) {
      return false
    }
    stats.messagesSent++

    if (onProgress) {
      for (const peerId of new Set([...directPeers.keys(), ...keys(routes)])) {
        if (resolveHealthyNextHopId(peerId)) {
          onProgress(peerId)
        }
      }
    }

    return true
  }

  const handleOverlayBinary = async (
    fromPeerId: string,
    [kind, rawTtl, header, payload]: UnpackedOverlayFrame
  ): Promise<void> => {
    if (isDestroyed) {
      return
    }

    const ttl = Math.min(rawTtl, maxAllowedHops)
    const curSelfId = selfId
    const curRoomId = roomId
    const origin = isStr(header['o']) ? header['o'] : ''
    const seq = header['q']
    const msgId = isStr(header['m']) ? header['m'] : ''
    const sig = isStr(header['s']) ? header['s'] : undefined

    if (
      !isValidSignalPeerId(origin) ||
      !msgId ||
      origin === curSelfId ||
      leftPeersSeq.has(origin)
    ) {
      return
    }

    if (
      !isValidOverlayMsgId(msgId) ||
      !isPosSafeInt(seq) ||
      bannedPeers.has(origin) ||
      bannedPeers.has(fromPeerId)
    ) {
      failSig()
      return
    }

    const commitPacketReplay = (useLease = false, leaseKey = ''): boolean => {
      if (
        !(useLease
          ? recordLeaseReplay(leaseKey, seq)
          : recordOriginReplay(origin, seq)) ||
        !seenMsgIds.add(msgId)
      ) {
        stats.duplicatesDropped++
        return false
      }
      touchOriginActivity(origin)
      return true
    }

    if (kind === overlayBroadcastKind) {
      if (hasOriginReplay(origin, seq) || seenMsgIds.has(msgId)) {
        stats.duplicatesDropped++
        return
      }

      const valid = await verifyUnicastOrBroadcast(
        origin,
        canonicalBroadcastHeader(origin, msgId, seq, appId, curRoomId),
        payload,
        sig
      )
      if (!valid || isDestroyed || leftPeersSeq.has(origin)) {
        return
      }

      const wireHeader = inspectActionWireHeader(payload)
      if (wireHeader) {
        const requiredRoles = actionAuthorities.get(wireHeader.type)
        if (requiredRoles && requiredRoles.length > 0 && canPeerSendAction) {
          const authEnv = isObj(wireHeader.metadata)
            ? (wireHeader.metadata[authMetaKey] as
                | {cert?: RoleCertificate}
                | undefined)
            : undefined
          const allowed = await canPeerSendAction(
            origin,
            requiredRoles,
            authEnv?.cert
          )
          if (!allowed || isDestroyed) {
            failSig()
            return
          }
        }
      }

      if (!commitPacketReplay()) {
        return
      }

      if (
        directPeers.has(origin) ||
        virtualTransports.has(origin) ||
        Boolean(descriptors.get(origin)?.encPubKey)
      ) {
        if (ensureOriginVirtualPeer(origin, fromPeerId)) {
          flushBufferedBroadcasts(origin)
          stats.messagesReceived++
          onDeliverData(origin, payload.slice().buffer)
        }
      } else {
        let queue = pendingEarlyBroadcasts.get(origin)
        if (!queue) {
          queue = []
          pendingEarlyBroadcasts.set(origin, queue)
        }
        if (queue.length < maxBufferedEarlyBroadcastsPerOrigin) {
          queue.push(payload.slice().buffer)
        }
      }

      if (
        ttl > 1 &&
        forwardBroadcastPacket(
          origin,
          ttl - 1,
          {o: origin, q: seq, m: msgId, ...(sig ? {s: sig} : {})},
          payload,
          fromPeerId
        ) > 0
      ) {
        stats.messagesForwarded++
      }
      return
    }

    if (kind === overlayUnicastKind) {
      const dest = isStr(header['d']) ? header['d'] : ''
      const ivB64 = isStr(header['iv']) ? header['iv'] : undefined
      const rawLease = header['l']

      if (!isValidSignalPeerId(dest) || leftPeersSeq.has(dest)) {
        return
      }

      if (!ivB64 || bannedPeers.has(dest)) {
        failSig()
        return
      }

      let lease: UnicastLeaseTuple | undefined
      if (rawLease !== undefined) {
        const parsedLease = parseUnicastLease(
          rawLease,
          seq,
          unicastLeaseWindowPackets
        )
        if (!parsedLease) {
          failSig()
          return
        }
        lease = parsedLease
      }

      const relayLeaseKey = `${origin}\0${dest}`
      if (
        (dest !== curSelfId && lease
          ? hasLeaseReplay(relayLeaseKey, seq)
          : hasOriginReplay(origin, seq)) ||
        seenMsgIds.has(msgId)
      ) {
        stats.duplicatesDropped++
        return
      }

      const canonical = canonicalUnicastHeader(
        origin,
        dest,
        msgId,
        ivB64,
        seq,
        appId,
        curRoomId
      )
      const verifyPacketAuth = (): Promise<boolean> =>
        lease
          ? verifyUnicastOrBroadcast(
              origin,
              canonicalUnicastLeaseHeader(
                origin,
                dest,
                lease[0],
                lease[1],
                appId,
                curRoomId
              ),
              emptyBytes,
              lease[2]
            )
          : verifyUnicastOrBroadcast(origin, canonical, payload, sig)

      if (dest !== curSelfId) {
        if (
          ttl <= 1 ||
          !(await verifyPacketAuth()) ||
          isDestroyed ||
          leftPeersSeq.has(origin) ||
          leftPeersSeq.has(dest) ||
          !commitPacketReplay(Boolean(lease), relayLeaseKey)
        ) {
          return
        }
        if (
          routeUnicastPacket(
            dest,
            packOverlayBinary(overlayUnicastKind, ttl - 1, header, payload),
            fromPeerId
          )
        ) {
          stats.messagesForwarded++
        }
        return
      }

      if (
        !(await verifyPacketAuth()) ||
        isDestroyed ||
        leftPeersSeq.has(origin)
      ) {
        return
      }

      const pairwiseKeyP = getPairwiseKey(origin)
      if (!pairwiseKeyP) {
        failSig()
        return
      }
      let plainPayload: Uint8Array
      try {
        plainPayload = await decryptUnicastPayload(
          await pairwiseKeyP,
          ivB64,
          canonical,
          payload
        )
      } catch {
        failSig()
        return
      }

      if (
        !commitPacketReplay() ||
        !ensureOriginVirtualPeer(origin, fromPeerId)
      ) {
        return
      }
      flushBufferedBroadcasts(origin)

      stats.messagesReceived++
      onDeliverData(origin, plainPayload.slice().buffer)
    }
  }

  void loadLocalCryptoIdentity().catch(noOp)

  const isOverlayFrame = (data: ArrayBuffer): boolean =>
    data.byteLength >= 2 &&
    new Uint8Array(data, 0, 1)[0] === overlayFrameVersion

  const handleOverlayFrame = (fromPeerId: string, data: ArrayBuffer): void => {
    if (bannedPeers.has(fromPeerId)) {
      failSig()
      return
    }
    const bytes = new Uint8Array(data)
    if (bytes.byteLength < 2 || bytes[0] !== overlayFrameVersion) {
      return
    }
    const kind = bytes[1]!
    if (kind === overlayControlKind) {
      try {
        dispatchControlMessage(
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
      const rawOrigin = parsed[2]['o']
      const origin =
        typeof rawOrigin === 'string' && isValidSignalPeerId(rawOrigin)
          ? rawOrigin
          : fromPeerId
      enqueueOriginTask(`data:${origin}`, () =>
        handleOverlayBinary(fromPeerId, parsed)
      )
    }
  }

  const resetRoomCryptoState = (): void => {
    derivedPairwiseKeys.clear()
    outboundUnicastLeases.clear()
    lastUnicastSeqByTarget.clear()
    clearLeaseReplay()
    pendingEarlyBroadcasts.clear()
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
          scheduleTargetsNotification()
        }
      })
      .catch(noOp)
  }
  refreshPasswordSalt()

  const publishIfActive = (): void => {
    if (isOverlayActive()) {
      void publishLocalDescriptor()
    }
  }

  const setRoomId = (effectiveRoomId: string): void => {
    if (effectiveRoomId && effectiveRoomId !== roomId) {
      roomId = effectiveRoomId
      refreshPasswordSalt()
      didInitFloor = false
      syncSeqFloor(selfId)
      resetRoomCryptoState()
      capacityRejectedPeers.clear()
      remoteConnectRequests.clear()
      descriptors.forEach((_, existingPeerId) => {
        if (existingPeerId !== selfId) {
          evictVirtualPeerNow(existingPeerId, peerDisconnectedErr)
        }
      })
      recomputeTopologyAndRoutes()
      publishIfActive()
    }
  }

  const sendUnicast = (targetPeerId: string, frame: Uint8Array): void => {
    const isChunkedAction =
      frame.byteLength >= 2 &&
      frame[0] === 2 &&
      ((frame[1]! & 0xf) === 1 || (frame[1]! & 0xf) === 2)
    sendUnicastInternal(targetPeerId, frame, false, undefined, isChunkedAction)
  }

  const provider: KernelScaleProvider & {
    handleOverlayFrame: (fromPeerId: string, data: ArrayBuffer) => void
    sendUnicast: (targetPeerId: string, frame: Uint8Array) => void
    requireDirectPeer: (peerId: string, options?: {dial?: boolean}) => void
    acceptMediaConnectRequest: (fromPeerId: string) => boolean
  } = {
    getActiveMode: () => {
      updateActiveMode()
      return currentActiveMode
    },
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
      leftPeersSeq.delete(peerId)
      capacityRejectedPeers.delete(peerId)
      remoteConnectRequests.delete(peerId)
      knownRoster.add(peerId)
      topologyVersion++
      clearUnreachableTimer(peerId)

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
        for (const d of descriptors.values()) {
          if (d.peerId !== selfId && d.peerId !== peerId) {
            initialKnownIds.add(d.peerId)
          }
        }
        void publishLocalDescriptor().then(() => {
          if (!initialKnownIds.size) {
            return
          }
          const initialKnown: PeerDescriptor[] = []
          for (const knownId of initialKnownIds) {
            const d = descriptors.get(knownId)
            if (d) {
              initialKnown.push(d)
            }
          }
          for (const packet of packGossipControlFrames(initialKnown)) {
            sendToDirectNeighbor(peerId, packet)
          }
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
          } else if (!existingVTransport) {
            const lastSeq = descriptors.get(peerId)?.seq ?? 0
            if (lastSeq > 0 || reason?.message === peerLeftRoomErr.message) {
              leftPeersSeq.set(peerId, lastSeq)
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
      const active = isOverlayActive()
      if (active) {
        leftPeersSeq.set(peerId, descriptors.get(peerId)?.seq ?? 0)
      }
      purgePeerFromGraph(peerId)
      recomputeTopologyAndRoutes()
      if (active) {
        void publishLocalDescriptor()
      }
    },
    ...(prepareMediaPeer ? {prepareMediaPeer} : {}),
    isDirectPeer: (peerId: string): boolean => directPeers.has(peerId),
    isVirtualPeer: (peerId: string): boolean => virtualTransports.has(peerId),
    getRoute: (peerId: string): TopologyRoute | undefined => routes[peerId],
    broadcastInline,
    handleOverlayFrame,
    sendUnicast,
    acceptMediaConnectRequest,
    requireDirectPeer: (peerId: string, options?: {dial?: boolean}): void =>
      requireDirectPeerImpl(peerId, options?.dial !== false),
    notePeerDiscovered: (peerId: string): boolean => {
      if (
        !isAllowedTargetPeer(peerId) ||
        knownRoster.has(peerId) ||
        discoveredCandidates.has(peerId)
      ) {
        return false
      }
      discoveredCandidates.set(peerId, true)
      topologyVersion++
      if (descriptors.size <= 1) {
        scheduleTargetsNotification()
      }
      return true
    },
    shouldConnectPeer: (
      peerId: string,
      direction: 'outbound' | 'inbound'
    ): boolean => {
      if (!isAllowedTargetPeer(peerId)) {
        return false
      }
      if (directPeers.has(peerId) || localRequiredPeers.has(peerId)) {
        return true
      }
      if (
        hasActiveRemoteConnectRequest(peerId) &&
        directPeers.size < maxConns * 3
      ) {
        return true
      }
      if (!knownRoster.has(peerId) && !discoveredCandidates.has(peerId)) {
        discoveredCandidates.set(peerId, true)
        topologyVersion++
      }
      updateActiveMode()
      if (currentActiveMode === 'mesh') {
        return true
      }

      const targets = computeEffectiveTargets()
      const minDirectPeers = Math.min(defaultMinConnections, maxConns)
      if (
        (targets.has(peerId) && directPeers.size < maxConns) ||
        directPeers.size < minDirectPeers
      ) {
        return true
      }
      if (
        direction === 'outbound' &&
        hasCompletedInitialBootstrap &&
        !knownRoster.has(peerId) &&
        !leftPeersSeq.has(peerId) &&
        !capacityRejectedPeers.has(peerId) &&
        selfId < peerId &&
        directPeers.size < maxConns + 2
      ) {
        const capped = capRoster(knownRoster)
        if (
          !capped.has(selfId) ||
          bannedPeers.has(selfId) ||
          leftPeersSeq.has(selfId)
        ) {
          return false
        }
        const gateSalt = toJson([getRoomSalt(), 'gate', peerId])
        const selfKey = hashRingKey(gateSalt, selfId)
        let lower = 0
        for (const u of capped) {
          if (
            u < peerId &&
            !bannedPeers.has(u) &&
            !leftPeersSeq.has(u) &&
            hashRingKey(gateSalt, u) < selfKey &&
            ++lower >= 2
          ) {
            return false
          }
        }
        return true
      }
      return direction !== 'outbound' && directPeers.size < maxConns * 2
    },
    getTargetNeighbors: (): Set<string> => new Set(computeEffectiveTargets()),
    setOnTargetsChanged: (cb: (targetPeerIds: string[]) => void): void => {
      targetsChangedCallback = cb
    },
    setPeerSignPublicKey: (peerId: string, pubKey: JsonWebKey): void => {
      if (!isValidSignalPeerId(peerId) || !pubKey) {
        return
      }
      const commitKey = (ok: boolean): void => {
        if (ok) {
          peerSignPubKeys.set(peerId, pubKey)
          pinnedSignKeys.set(peerId, canonicalizePubJwk(pubKey))
        }
      }
      const res = verifyPeerIdKey(peerId, pubKey)
      if (typeof res === 'boolean') {
        commitKey(res)
      } else {
        void res.then(commitKey)
      }
    },
    setLocalRoleCertificate: (cert: RoleCertificate | null): void => {
      localRoleCert = cert
      publishIfActive()
    },
    markPeerBanned: (peerId: string): void => {
      bannedPeers.add(peerId)
      purgeConnectionPolicyPeer(peerId)
      leftPeersSeq.set(
        peerId,
        descriptors.get(peerId)?.seq ?? Number.MAX_SAFE_INTEGER
      )
      evictVirtualPeerNow(peerId, peerBannedErr)
      recomputeTopologyAndRoutes()
      publishIfActive()
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
    announceLeave: (): void => {
      if (isDestroyed || !isOverlayActive() || !directPeers.size) {
        return
      }
      const seq = nextDescSeq()
      void signUnicastOrBroadcast(
        canonicalLeaveHeader(selfId, seq, appId, roomId),
        emptyBytes
      ).then(sig => {
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
          sendToDirectNeighbor(neighborId, packet)
        }
      })
    },
    destroy: (): void => {
      isDestroyed = true
      resetTimer(heartbeatTimer)
      resetRoomCryptoState()
      unreachableTimers.forEach(resetTimer)
      virtualTransports.forEach(v => v.close?.())
      ;[
        pendingGossipDescriptors,
        pendingGossipSources,
        inFlightDescriptors,
        pendingUserAdmissions,
        originQueues,
        outboundUnicastQueues,
        outboundQueueDepth,
        pendingFramesByPeer,
        capacityRejectedPeers,
        localRequiredPeers,
        remoteConnectRequests,
        unreachableTimers,
        virtualTransports,
        directPeers
      ].forEach(c => c.clear())
    },
    getSnapshot: (): TopologySnapshot => {
      updateActiveMode()
      const directPeerIds = [...directPeers.keys()].sort()
      return {
        mode: cfgMode,
        activeMode: currentActiveMode,
        selfId,
        directPeerIds,
        roomPeerIds: [
          ...new Set<string>([...directPeerIds, ...virtualTransports.keys()])
        ].sort(),
        routes: {...routes},
        stats: {...stats}
      }
    }
  }

  return [
    provider,
    setRoomId,
    config,
    isOverlayActive,
    isOverlayFrame,
    loadLocalCryptoIdentity,
    getPeerSignPublicKey
  ]
}

export const createOverlayManager = ({
  selfId,
  appId = '',
  roomId = '',
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
  const [
    provider,
    setRoomId,
    config,
    isOverlayActive,
    isOverlayFrame,
    getLocalCryptoIdentity,
    getPeerSignPublicKey
  ] = initOverlayManager(
    selfId,
    appId,
    roomId,
    password,
    topology,
    descriptorTtlMs,
    unreachableGraceMs,
    maxUsers,
    getLocalUserIdentity,
    onVirtualPeerJoin,
    onVirtualPeerLeave,
    onDeliverData,
    prepareMediaPeer,
    onRemoveDirectPeer,
    canPeerSendAction,
    onPeerDescriptorCert
  )
  return {
    ...(provider as OverlayManager),
    config,
    isOverlayActive,
    isOverlayFrame,
    getLocalCryptoIdentity,
    getPeerSignPublicKey,
    setRoomId
  }
}
