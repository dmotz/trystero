import {signRoomAuth} from '../crypto'
import type {PeerHandle, Timeout} from '../internal-types'
import type {PeerDataTransport} from '../peer-transport'
import {isValidSignalPeerId} from '../signal-handler'
import {createTokenBucketLimiter} from '../signed-record'
import type {TopologyRoute} from '../types'
import {
  cmpStr,
  createBoundedCache,
  entries,
  fromEntries,
  keys,
  noOp,
  peerDisconnectedErr,
  resetTimer,
  toJson,
  unreachable,
  unrefTimer
} from '../utils'
import {isPeerUsable} from './crypto-frame'
import type {DescriptorStore} from './descriptors'
import {
  computeShortestPathRoutes,
  computeTargetNeighbors,
  deriveMaxHops,
  hashRingKey,
  isExcludedPeer
} from './topology'

const maxDiscoveredCandidates = 512
const maxLocalRequiredPeers = 2_048
// Safety net if a newcomer's initial ring targets in discoveredCandidates are dead/unreachable:
// wait briefly before dialing non-target candidates so normal joins stay sparse instead of cliquing.
const isolatedDialGraceMs = 1_500
export const defaultRequiredPeerIdleTtlMs = 60_000
export const defaultQuarantineTtlMs = 30_000

type VirtualPeerState =
  | {readonly phase: 'none'}
  | {readonly phase: 'routed-awaiting-descriptor'}
  | {readonly phase: 'capacity-rejected'}
  | {readonly phase: 'active'; readonly transport: PeerDataTransport}

type OverlayPeer = {
  readonly state: VirtualPeerState
  readonly hadRoute: boolean
  readonly grace: Timeout | null
}

const idlePeer: OverlayPeer = {
  state: {phase: 'none'},
  hadRoute: false,
  grace: null
}

export type OverlayRouterDeps = {
  appId: string
  password: string
  maxDirectPeers: number
  unreachableGraceMs: number
  requiredPeerIdleTtlMs: number
  quarantineTtlMs: number
  descriptors: DescriptorStore
  isDestroyed: () => boolean
  getSelfId: () => string
  getRoomId: () => string
  getDirectPeer: (peerId: string) => PeerHandle | undefined
  isDirectPeer: (peerId: string) => boolean
  getDirectPeerIds: () => IterableIterator<string>
  getDirectPeerCount: () => number
  isPeerBanned: (peerId: string) => boolean
  createVirtualTransport: (peerId: string) => PeerDataTransport
  onVirtualTransportDetached?:
    | ((peerId: string, transport: PeerDataTransport) => void)
    | undefined
  onVirtualPeerJoin: (peerId: string, transport: PeerDataTransport) => unknown
  onVirtualPeerLeave: (peerId: string, reason?: Error) => void
  onVirtualPeerReady?: ((peerId: string) => void) | undefined
}

export type OverlayRouter = {
  bumpTopologyVersion: () => void
  currentMaxHops: () => number
  isAllowedTargetPeer: (peerId: string) => boolean
  getDiscoveredCandidateCount: () => number
  computeEffectiveTargets: () => Set<string>
  getTargetNeighbors: () => Set<string>
  setOnTargetsChanged: (cb: (targetPeerIds: string[]) => void) => void
  scheduleTargetsNotification: () => void
  requireDirectPeer: (peerId: string, dial?: boolean) => void
  setPeerMediaPinned: (peerId: string, pinned: boolean) => void
  acceptMediaConnectRequest: (fromPeerId: string) => boolean
  notePeerDiscovered: (peerId: string) => boolean
  shouldConnectPeer: (
    peerId: string,
    direction: 'outbound' | 'inbound'
  ) => boolean
  resolveHealthyNextHopId: (
    destPeerId: string,
    excludePeerIds?: string | ReadonlySet<string>
  ) => string | undefined
  getRoute: (peerId: string) => TopologyRoute | undefined
  getRoutesCopy: () => Record<string, TopologyRoute>
  getReachablePeerIds: () => string[]
  isVirtualPeer: (peerId: string) => boolean
  getVirtualPeerIds: () => IterableIterator<string>
  getVirtualPeerCount: () => number
  getVirtualTransport: (peerId: string) => PeerDataTransport | undefined
  setVirtualTransport: (peerId: string, transport: PeerDataTransport) => void
  detachVirtualTransport: (
    peerId: string,
    transport?: PeerDataTransport
  ) => void
  clearUnreachableTimer: (peerId: string) => void
  clearCapacityRejected: (peerId?: string) => void
  ensureOriginVirtualPeer: (origin: string, fromPeerId: string) => boolean
  recomputeTopologyAndRoutes: () => void
  deactivateVirtualPeerNow: (peerId: string, reason: Error) => void
  evictVirtualPeerNow: (peerId: string, reason: Error) => void
  quarantinePeer: (peerId: string) => void
  clearQuarantined: (peerId: string) => void
  isPeerQuarantined: (peerId: string) => boolean
  purgeConnectionPolicyPeer: (peerId: string) => void
  purgePeerRoutingState: (peerId: string) => void
  refreshPasswordSalt: () => void
  resetForRoomIdChange: () => void
  destroy: () => void
}

export const createOverlayRouter = (deps: OverlayRouterDeps): OverlayRouter => {
  const {
    appId,
    password,
    maxDirectPeers,
    unreachableGraceMs,
    requiredPeerIdleTtlMs,
    quarantineTtlMs,
    descriptors,
    isDestroyed,
    getSelfId,
    getRoomId,
    getDirectPeer,
    isDirectPeer,
    getDirectPeerIds,
    getDirectPeerCount,
    isPeerBanned,
    createVirtualTransport,
    onVirtualTransportDetached,
    onVirtualPeerJoin,
    onVirtualPeerLeave,
    onVirtualPeerReady
  } = deps

  const peers = new Map<string, OverlayPeer>()
  const virtualTransportsView = new Map<string, PeerDataTransport>()
  const everConfirmedNeighbors = new Map<string, Set<string>>()
  const discoveredCandidates = createBoundedCache<string, true>(
    maxDiscoveredCandidates
  )
  const quarantinedPeers = createBoundedCache<string, number>(
    maxDiscoveredCandidates
  )
  const directRequirements = new Map<string, number>()
  const connectLimiter = createTokenBucketLimiter(0.5, 2, 512)

  let routes: Record<string, TopologyRoute> = {}
  let topologyVersion = 0
  let hasCompletedInitialBootstrap = false
  let firstDiscoveryAt = 0
  let derivedSalt = ''
  let saltToken = 0
  let isRecomputing = false

  let cachedTargetsVersion = -1
  let cachedEffectiveTargets: Set<string> | null = null
  let targetsChangedCallback: ((targetPeerIds: string[]) => void) | null = null
  let targetsNotifyScheduled = false

  const setPeer = (peerId: string, patch: Partial<OverlayPeer>): void => {
    const prev = peers.get(peerId) ?? idlePeer
    const next: OverlayPeer = {...prev, ...patch}
    if (prev.grace && prev.grace !== next.grace) {
      resetTimer(prev.grace)
    }
    switch (next.state.phase) {
      case 'active':
        virtualTransportsView.set(peerId, next.state.transport)
        break
      case 'none':
      case 'routed-awaiting-descriptor':
      case 'capacity-rejected':
        virtualTransportsView.delete(peerId)
        break
      default:
        unreachable(next.state)
    }
    if (next.state.phase === 'none' && !next.hadRoute && !next.grace) {
      peers.delete(peerId)
      return
    }
    peers.set(peerId, next)
  }

  const hasCapacityRejectedPeers = (): boolean => {
    for (const rec of peers.values()) {
      if (rec.state.phase === 'capacity-rejected') {
        return true
      }
    }
    return false
  }

  const isPeerCapacityRejected = (peerId: string): boolean =>
    peers.get(peerId)?.state.phase === 'capacity-rejected'

  const getRoomSalt = (): string => {
    const roomId = getRoomId()
    return derivedSalt
      ? toJson([appId, roomId, derivedSalt])
      : appId || roomId
        ? toJson([appId, roomId])
        : ''
  }

  const isPeerQuarantined = (peerId: string): boolean => {
    const expiresAt = quarantinedPeers.get(peerId)
    if (expiresAt === undefined) {
      return false
    }
    if (Date.now() > expiresAt) {
      quarantinedPeers.delete(peerId)
      topologyVersion++
      return false
    }
    return true
  }

  const quarantinePeer = (peerId: string): void => {
    if (
      quarantineTtlMs > 0 &&
      isValidSignalPeerId(peerId) &&
      peerId !== getSelfId()
    ) {
      quarantinedPeers.set(peerId, Date.now() + quarantineTtlMs)
      topologyVersion++
    }
  }

  const clearQuarantined = (peerId: string): void => {
    if (quarantinedPeers.delete(peerId)) {
      topologyVersion++
    }
  }

  const isAllowedTargetPeer = (peerId: string): boolean =>
    !isDestroyed() &&
    isValidSignalPeerId(peerId) &&
    peerId !== getSelfId() &&
    !isPeerBanned(peerId) &&
    !isPeerQuarantined(peerId)

  const pruneExpiredRequiredPeers = (now: number = Date.now()): void => {
    let changed = false
    for (const [peerId, expiresAt] of directRequirements.entries()) {
      if (now > expiresAt) {
        directRequirements.delete(peerId)
        changed = true
      }
    }
    if (changed) {
      topologyVersion++
    }
  }

  const isRequiredDirectPeer = (peerId: string): boolean => {
    const expiresAt = directRequirements.get(peerId)
    if (expiresAt === undefined) {
      return false
    }
    if (Date.now() > expiresAt) {
      directRequirements.delete(peerId)
      topologyVersion++
      return false
    }
    return true
  }

  const getActiveRequiredPeers = (): Set<string> => {
    pruneExpiredRequiredPeers()
    return new Set<string>(directRequirements.keys())
  }

  const capRoster = (base: Set<string>): Set<string> => {
    if (base.size <= maxDirectPeers + 1) {
      return base
    }
    const selfId = getSelfId()
    const maxSlots = Math.max(1, Math.floor(maxDirectPeers / 3))
    const byUser = new Map<string, string[]>()
    for (const id of base) {
      const uid =
        id !== selfId ? descriptors.getDescriptor(id)?.userId : undefined
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
      if (
        peers.length > maxSlots &&
        base.size - 1 - peers.length >= maxDirectPeers
      ) {
        for (const id of [...peers].sort().slice(maxSlots)) {
          filtered.delete(id)
        }
      }
    }
    return filtered
  }

  const computeEffectiveTargets = (): Set<string> => {
    pruneExpiredRequiredPeers()
    if (!hasCompletedInitialBootstrap && descriptors.hasConvergedComponent()) {
      hasCompletedInitialBootstrap = true
      topologyVersion++
    }
    const selfId = getSelfId()
    if (!selfId) {
      return getActiveRequiredPeers()
    }
    if (cachedEffectiveTargets && cachedTargetsVersion === topologyVersion) {
      return cachedEffectiveTargets
    }
    const knownRoster = descriptors.getKnownRoster()
    const rawRoster = hasCompletedInitialBootstrap
      ? knownRoster
      : new Set<string>([...knownRoster, ...discoveredCandidates.keys()])
    const targets = computeTargetNeighbors(
      selfId,
      capRoster(rawRoster),
      maxDirectPeers,
      getRoomSalt()
    )
    for (const reqId of getActiveRequiredPeers()) {
      targets.add(reqId)
    }
    cachedEffectiveTargets = targets
    cachedTargetsVersion = topologyVersion
    return targets
  }

  const scheduleTargetsNotification = (): void => {
    if (targetsNotifyScheduled || isDestroyed() || !targetsChangedCallback) {
      return
    }
    targetsNotifyScheduled = true
    queueMicrotask(() => {
      targetsNotifyScheduled = false
      if (isDestroyed() || !targetsChangedCallback) {
        return
      }
      const candidates =
        getDirectPeerCount() >= maxDirectPeers
          ? getActiveRequiredPeers()
          : computeEffectiveTargets()
      const missing = [...candidates].filter(id => !isDirectPeer(id))
      if (missing.length > 0) {
        targetsChangedCallback(missing)
      }
    })
  }

  const requireDirectPeer = (peerId: string, dial = true): void => {
    if (!isAllowedTargetPeer(peerId)) {
      return
    }
    const now = Date.now()
    pruneExpiredRequiredPeers(now)
    const existing = directRequirements.get(peerId)
    if (existing === Infinity) {
      if (dial && !isDirectPeer(peerId)) {
        targetsChangedCallback?.([peerId])
      }
      return
    }
    if (
      existing === undefined &&
      directRequirements.size >= maxLocalRequiredPeers
    ) {
      for (const [candidate, exp] of directRequirements.entries()) {
        if (exp < Infinity) {
          directRequirements.delete(candidate)
          break
        }
      }
    }
    if (existing !== undefined) {
      directRequirements.delete(peerId)
    }
    directRequirements.set(peerId, now + requiredPeerIdleTtlMs)
    if (existing === undefined) {
      topologyVersion++
    }
    if (dial && !isDirectPeer(peerId)) {
      targetsChangedCallback?.([peerId])
    }
  }

  const setPeerMediaPinned = (peerId: string, pinned: boolean): void => {
    if (!isValidSignalPeerId(peerId) || peerId === getSelfId()) {
      return
    }
    const existing = directRequirements.get(peerId)
    if (pinned) {
      if (!isAllowedTargetPeer(peerId)) {
        return
      }
      if (existing !== Infinity) {
        directRequirements.set(peerId, Infinity)
        topologyVersion++
      }
    } else if (existing === Infinity) {
      directRequirements.delete(peerId)
      directRequirements.set(peerId, Date.now() + requiredPeerIdleTtlMs)
      topologyVersion++
    }
  }

  const acceptMediaConnectRequest = (fromPeerId: string): boolean => {
    if (!isAllowedTargetPeer(fromPeerId) || descriptors.hasLeft(fromPeerId)) {
      return false
    }
    if (isDirectPeer(fromPeerId)) {
      return true
    }
    if (
      !descriptors.getKnownRoster().has(fromPeerId) &&
      !descriptors.hasDescriptor(fromPeerId)
    ) {
      return false
    }
    const activeRequired = getActiveRequiredPeers()
    if (
      !activeRequired.has(fromPeerId) &&
      getDirectPeerCount() + activeRequired.size >= maxDirectPeers * 3
    ) {
      return false
    }
    const userId = descriptors.getDescriptor(fromPeerId)?.userId
    if (!connectLimiter.consume(userId ?? fromPeerId)) {
      return false
    }
    requireDirectPeer(fromPeerId, true)
    return true
  }

  const clearUnreachableTimer = (peerId: string): void => {
    if (peers.get(peerId)?.grace) {
      setPeer(peerId, {grace: null})
    }
  }

  const clearCapacityRejected = (peerId?: string): void => {
    const clearOne = (id: string, rec: OverlayPeer | undefined): void => {
      if (rec?.state.phase === 'capacity-rejected') {
        setPeer(id, {
          state: rec.hadRoute
            ? {phase: 'routed-awaiting-descriptor'}
            : {phase: 'none'},
          grace: null
        })
      }
    }
    if (peerId === undefined) {
      for (const [id, rec] of Array.from(peers.entries())) {
        clearOne(id, rec)
      }
      return
    }
    clearOne(peerId, peers.get(peerId))
  }

  const purgeConnectionPolicyPeer = (peerId: string): void => {
    directRequirements.delete(peerId)
    discoveredCandidates.delete(peerId)
    topologyVersion++
  }

  const purgePeerRoutingState = (peerId: string): void => {
    purgeConnectionPolicyPeer(peerId)
    setPeer(peerId, idlePeer)
    everConfirmedNeighbors.delete(peerId)
    for (const set of everConfirmedNeighbors.values()) {
      set.delete(peerId)
    }
    topologyVersion++
  }

  const closeVirtualTransport = (
    peerId: string
  ): {closed: boolean; hadCapacityRejected: boolean} => {
    const existing = virtualTransportsView.get(peerId)
    if (!existing) {
      return {closed: false, hadCapacityRejected: false}
    }
    const hadCapacityRejected = hasCapacityRejectedPeers()
    clearCapacityRejected()
    setPeer(peerId, {state: {phase: 'none'}, grace: null})
    existing.close?.()
    return {closed: true, hadCapacityRejected}
  }

  const deactivateVirtualPeerNow = (peerId: string, reason: Error): void => {
    const {closed, hadCapacityRejected} = closeVirtualTransport(peerId)
    setPeer(peerId, idlePeer)
    if (!closed) {
      return
    }
    onVirtualPeerLeave(peerId, reason)
    if (hadCapacityRejected && !isRecomputing && !isDestroyed()) {
      recomputeTopologyAndRoutes()
    }
  }

  const evictVirtualPeerNow = (peerId: string, reason: Error): void => {
    const {closed, hadCapacityRejected} = closeVirtualTransport(peerId)
    descriptors.purgePeer(peerId)
    purgePeerRoutingState(peerId)
    if (closed) {
      onVirtualPeerLeave(peerId, reason)
      if (hadCapacityRejected && !isRecomputing && !isDestroyed()) {
        recomputeTopologyAndRoutes()
      }
    }
  }

  const resolveHealthyNextHopId = (
    destPeerId: string,
    excludePeerIds?: string | ReadonlySet<string>
  ): string | undefined => {
    if (
      !isExcludedPeer(destPeerId, excludePeerIds) &&
      isPeerUsable(getDirectPeer(destPeerId))
    ) {
      return destPeerId
    }
    const route = routes[destPeerId]
    if (
      route &&
      !isExcludedPeer(route.nextHop, excludePeerIds) &&
      isPeerUsable(getDirectPeer(route.nextHop))
    ) {
      return route.nextHop
    }
    const usableDirects: string[] = []
    for (const id of getDirectPeerIds()) {
      if (
        !isExcludedPeer(id, excludePeerIds) &&
        isPeerUsable(getDirectPeer(id))
      ) {
        usableDirects.push(id)
      }
    }
    if (!usableDirects.length) {
      return undefined
    }
    const adjacency = descriptors.getAdjacency()
    const maxHops = currentMaxHops()
    const alt = computeShortestPathRoutes(
      getSelfId(),
      adjacency,
      usableDirects,
      maxHops,
      excludePeerIds
    )[destPeerId]
    if (alt) {
      return alt.nextHop
    }
    if (excludePeerIds !== undefined) {
      return computeShortestPathRoutes(
        getSelfId(),
        adjacency,
        usableDirects,
        maxHops,
        excludePeerIds,
        true
      )[destPeerId]?.nextHop
    }
    return undefined
  }

  const admitVirtualPeer = (peerId: string): boolean => {
    const vTransport = createVirtualTransport(peerId)
    if (onVirtualPeerJoin(peerId, vTransport) === false) {
      vTransport.close?.()
      setPeer(peerId, {state: {phase: 'capacity-rejected'}, grace: null})
      return false
    }
    setPeer(peerId, {
      state: {phase: 'active', transport: vTransport},
      grace: null
    })
    return true
  }

  const ensureOriginVirtualPeer = (
    origin: string,
    fromPeerId: string
  ): boolean => {
    if (isDirectPeer(origin)) {
      return true
    }
    if (virtualTransportsView.has(origin)) {
      if (!routes[origin]) {
        routes[origin] = {nextHop: fromPeerId, hops: 2}
      }
      setPeer(origin, {hadRoute: true, grace: null})
      return true
    }
    if (
      isPeerCapacityRejected(origin) ||
      isPeerBanned(origin) ||
      isPeerQuarantined(origin)
    ) {
      return false
    }
    descriptors.addKnownPeer(origin)
    topologyVersion++
    if (!routes[origin]) {
      routes[origin] = {nextHop: fromPeerId, hops: 2}
    }
    setPeer(origin, {hadRoute: true, grace: null})
    return admitVirtualPeer(origin)
  }

  const currentMaxHops = (): number =>
    deriveMaxHops(
      Math.max(
        descriptors.getKnownRoster().size,
        descriptors.getDescriptorCount(),
        getDirectPeerCount() + 1
      ),
      maxDirectPeers
    )

  const addMapSet = (
    m: Map<string, Set<string>>,
    k: string,
    v: string
  ): void => {
    let s = m.get(k)
    if (!s) {
      s = new Set()
      m.set(k, s)
    }
    s.add(v)
  }

  const recomputeTopologyAndRoutes = (): void => {
    if (isDestroyed()) {
      return
    }
    const prevRecomputing = isRecomputing
    isRecomputing = true
    try {
      const selfId = getSelfId()
      topologyVersion++
      descriptors.setLocalAdjacency(getDirectPeerIds())
      if (
        !hasCompletedInitialBootstrap &&
        descriptors.hasConvergedComponent()
      ) {
        hasCompletedInitialBootstrap = true
      }
      const adjacency = descriptors.getAdjacency()

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
        getDirectPeerIds(),
        currentMaxHops()
      )

      for (const peerId of keys(routes)) {
        if (peerId === selfId || isPeerQuarantined(peerId)) {
          continue
        }
        if (isDirectPeer(peerId)) {
          setPeer(peerId, {state: {phase: 'none'}, hadRoute: true, grace: null})
          continue
        }
        setPeer(peerId, {hadRoute: true, grace: null})
        const curState = peers.get(peerId)?.state
        if (curState?.phase === 'capacity-rejected') {
          continue
        }
        if (!descriptors.hasDescriptor(peerId)) {
          if (curState?.phase !== 'active') {
            setPeer(peerId, {state: {phase: 'routed-awaiting-descriptor'}})
          }
          continue
        }
        if (curState?.phase !== 'active' && !admitVirtualPeer(peerId)) {
          continue
        }
        if (descriptors.getDescriptor(peerId)?.encPubKey) {
          onVirtualPeerReady?.(peerId)
        }
      }

      for (const peerId of Array.from(peers.keys())) {
        if (peerId === selfId || isDirectPeer(peerId) || routes[peerId]) {
          continue
        }
        const cur = peers.get(peerId)
        if (!cur) {
          continue
        }

        const desc = descriptors.getDescriptor(peerId)
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
              if (!isDirectPeer(peerId)) {
                anyConfirmedNeighborDropped = true
                return true
              }
              return false
            }
            const nDesc = descriptors.getDescriptor(n)
            if (nDesc && !nDesc.neighbors.includes(peerId)) {
              anyConfirmedNeighborDropped = true
              return true
            }
            return !isDirectPeer(n) && !routes[n]
          }) &&
          anyConfirmedNeighborDropped
        )

        if (allKnownNeighborsDropped) {
          if (desc) {
            descriptors.markLeft(peerId, desc.seq)
          }
          evictVirtualPeerNow(peerId, peerDisconnectedErr)
        } else if (!cur.grace) {
          const timer = setTimeout(() => {
            if (peers.get(peerId)?.grace === timer) {
              setPeer(peerId, {grace: null})
            }
            if (!isDestroyed() && !isDirectPeer(peerId) && !routes[peerId]) {
              deactivateVirtualPeerNow(peerId, peerDisconnectedErr)
            }
          }, unreachableGraceMs)
          unrefTimer(timer)
          setPeer(peerId, {grace: timer})
        }
      }

      if (targetsChangedCallback) {
        scheduleTargetsNotification()
      }
    } finally {
      isRecomputing = prevRecomputing
    }
  }

  const maxBridgePeerDegree = maxDirectPeers * 2

  // Select up to 2 rendezvous bridges per unreachable peer on each side of the tie-breaker:
  // - 'bridge-lo' (selfId < peerId): sends SDP offers to higher-ID newcomers/components.
  // - 'bridge-hi' (selfId > peerId): replies with a direct counter-ping when a lower-ID newcomer
  //   announces (critical under 60 s steady announce intervals where existing peers stay silent).
  const isDesignatedComponentBridge = (
    peerId: string,
    directCount: number
  ): boolean => {
    if (directCount >= maxBridgePeerDegree) {
      return false
    }
    const selfId = getSelfId()
    if (!selfId) {
      return false
    }
    const wantLower = selfId < peerId
    const bridgeSalt = toJson([
      getRoomSalt(),
      wantLower ? 'bridge-lo' : 'bridge-hi',
      peerId
    ])
    const selfKey = hashRingKey(bridgeSalt, selfId)
    const candidates = new Set<string>([
      selfId,
      ...getDirectPeerIds(),
      ...keys(routes)
    ])
    let betterCount = 0
    for (const id of candidates) {
      if (!id || id === selfId) {
        continue
      }
      if (wantLower ? !(id < peerId) : !(id > peerId)) {
        continue
      }
      const knownDeg = descriptors.getDescriptor(id)?.neighbors.length ?? 0
      if (knownDeg >= maxBridgePeerDegree) {
        continue
      }
      if (cmpStr(hashRingKey(bridgeSalt, id), selfKey) < 0) {
        betterCount++
        if (betterCount >= 2) {
          return false
        }
      }
    }
    return true
  }

  const refreshPasswordSalt = (): void => {
    const token = ++saltToken
    derivedSalt = ''
    if (!password) {
      return
    }
    const targetRoomId = getRoomId()
    void signRoomAuth(password, appId, targetRoomId, '@topology', 0)
      .then(salt => {
        if (
          isDestroyed() ||
          saltToken !== token ||
          getRoomId() !== targetRoomId ||
          !salt
        ) {
          return
        }
        derivedSalt = salt
        recomputeTopologyAndRoutes()
        scheduleTargetsNotification()
      })
      .catch(noOp)
  }

  refreshPasswordSalt()

  return {
    bumpTopologyVersion: () => {
      topologyVersion++
    },
    currentMaxHops,
    isAllowedTargetPeer,
    getDiscoveredCandidateCount: () => discoveredCandidates.size,
    computeEffectiveTargets,
    getTargetNeighbors: () => new Set(computeEffectiveTargets()),
    setOnTargetsChanged: cb => {
      targetsChangedCallback = cb
    },
    scheduleTargetsNotification,
    requireDirectPeer,
    setPeerMediaPinned,
    acceptMediaConnectRequest,
    notePeerDiscovered: peerId => {
      if (
        !isAllowedTargetPeer(peerId) ||
        descriptors.getKnownRoster().has(peerId) ||
        discoveredCandidates.has(peerId)
      ) {
        return false
      }
      if (!firstDiscoveryAt) {
        firstDiscoveryAt = Date.now()
      }
      discoveredCandidates.set(peerId, true)
      topologyVersion++
      if (descriptors.getDescriptorCount() <= 1) {
        scheduleTargetsNotification()
      }
      return true
    },
    shouldConnectPeer: (peerId, direction) => {
      if (!isAllowedTargetPeer(peerId)) {
        return false
      }
      if (isDirectPeer(peerId) || isRequiredDirectPeer(peerId)) {
        return true
      }
      const knownRoster = descriptors.getKnownRoster()
      if (!knownRoster.has(peerId) && !discoveredCandidates.has(peerId)) {
        if (!firstDiscoveryAt) {
          firstDiscoveryAt = Date.now()
        }
        discoveredCandidates.set(peerId, true)
        topologyVersion++
      }
      const targets = computeEffectiveTargets()
      const directCount = getDirectPeerCount()
      if (targets.has(peerId) && directCount < maxDirectPeers) {
        return true
      }
      if (
        directCount === 0 &&
        (targets.size === 0 ||
          (firstDiscoveryAt > 0 &&
            Date.now() - firstDiscoveryAt >= isolatedDialGraceMs))
      ) {
        return true
      }
      // Key off !routes[peerId] (not !knownRoster.has) so partitioned components re-bridge
      // immediately even while stale descriptors remain cached within their 180 s TTL.
      if (
        direction === 'outbound' &&
        hasCompletedInitialBootstrap &&
        !routes[peerId] &&
        !descriptors.hasLeft(peerId) &&
        !isPeerCapacityRejected(peerId) &&
        isDesignatedComponentBridge(peerId, directCount)
      ) {
        return true
      }
      return direction === 'inbound' && directCount < maxBridgePeerDegree
    },
    resolveHealthyNextHopId,
    getRoute: peerId => {
      const r = routes[peerId]
      return r ? {...r} : undefined
    },
    getRoutesCopy: () =>
      fromEntries(entries(routes).map(([id, r]) => [id, {...r}])),
    getReachablePeerIds: () => {
      const allReachable = new Set<string>([
        ...getDirectPeerIds(),
        ...keys(routes)
      ])
      const out: string[] = []
      for (const id of allReachable) {
        if (resolveHealthyNextHopId(id)) {
          out.push(id)
        }
      }
      return out
    },
    isVirtualPeer: peerId => virtualTransportsView.has(peerId),
    getVirtualPeerIds: () => virtualTransportsView.keys(),
    getVirtualPeerCount: () => virtualTransportsView.size,
    getVirtualTransport: peerId => virtualTransportsView.get(peerId),
    setVirtualTransport: (peerId, transport) => {
      setPeer(peerId, {
        state: {phase: 'active', transport},
        ...(routes[peerId] ? {hadRoute: true} : {}),
        grace: null
      })
    },
    detachVirtualTransport: (peerId, transport) => {
      const curTransport = virtualTransportsView.get(peerId)
      if (!curTransport) {
        if (transport) {
          onVirtualTransportDetached?.(peerId, transport)
        }
        return
      }
      if (transport && curTransport !== transport) {
        return
      }
      onVirtualTransportDetached?.(peerId, curTransport)
      setPeer(peerId, {state: {phase: 'none'}, grace: null})
    },
    clearUnreachableTimer,
    clearCapacityRejected,
    ensureOriginVirtualPeer,
    recomputeTopologyAndRoutes,
    deactivateVirtualPeerNow,
    evictVirtualPeerNow,
    quarantinePeer,
    clearQuarantined,
    isPeerQuarantined,
    purgeConnectionPolicyPeer,
    purgePeerRoutingState,
    refreshPasswordSalt,
    resetForRoomIdChange: () => {
      for (const [id, rec] of Array.from(peers.entries())) {
        const vt = rec.state.phase === 'active' ? rec.state.transport : null
        setPeer(id, idlePeer)
        vt?.close?.()
      }
      routes = {}
      everConfirmedNeighbors.clear()
      quarantinedPeers.clear()
      directRequirements.clear()
      hasCompletedInitialBootstrap = false
      firstDiscoveryAt = 0
      topologyVersion++
    },
    destroy: () => {
      ++saltToken
      derivedSalt = ''
      for (const [id, rec] of Array.from(peers.entries())) {
        const vt = rec.state.phase === 'active' ? rec.state.transport : null
        setPeer(id, idlePeer)
        vt?.close?.()
      }
      routes = {}
      everConfirmedNeighbors.clear()
      discoveredCandidates.clear()
      quarantinedPeers.clear()
      directRequirements.clear()
      connectLimiter.clear()
    }
  }
}
