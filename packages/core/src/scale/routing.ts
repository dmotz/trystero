import {signRoomAuth} from '../crypto'
import type {PeerHandle} from '../internal-types'
import type {PeerDataTransport} from '../peer-transport'
import {isValidSignalPeerId} from '../signal-handler'
import {createTokenBucketLimiter} from '../signed-record'
import type {TopologyRoute} from '../types'
import {
  createBoundedCache,
  entries,
  fromEntries,
  keys,
  noOp,
  peerDisconnectedErr,
  resetTimer,
  toJson,
  unrefTimer
} from '../utils'
import {isPeerUsable} from './crypto-frame'
import type {DescriptorStore} from './descriptors'
import {
  computeShortestPathRoutes,
  computeTargetNeighbors,
  defaultMinConnections,
  deriveMaxHops
} from './topology'

const maxDiscoveredCandidates = 512
const maxLocalRequiredPeers = 2_048
export const defaultRequiredPeerIdleTtlMs = 60_000
export const defaultQuarantineTtlMs = 30_000

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
    onVirtualPeerJoin,
    onVirtualPeerLeave,
    onVirtualPeerReady
  } = deps

  const virtualTransports = new Map<string, PeerDataTransport>()
  const capacityRejectedPeers = new Set<string>()
  const hadRoutePeers = new Set<string>()
  const everConfirmedNeighbors = new Map<string, Set<string>>()
  const unreachableTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const discoveredCandidates = createBoundedCache<string, true>(
    maxDiscoveredCandidates
  )
  const quarantinedPeers = createBoundedCache<string, number>(
    maxDiscoveredCandidates
  )
  const localRequiredPeers = new Map<string, number>()
  const mediaPinnedPeers = new Set<string>()
  const connectLimiter = createTokenBucketLimiter(0.5, 2, 512)

  let routes: Record<string, TopologyRoute> = {}
  let topologyVersion = 0
  let hasCompletedInitialBootstrap = false
  let cachedTargetsVersion = -1
  let cachedEffectiveTargets: Set<string> | null = null
  let targetsChangedCallback: ((targetPeerIds: string[]) => void) | null = null
  let targetsNotifyScheduled = false

  let passwordTopologySalt = ''
  let passwordSaltToken = 0

  const getRoomSalt = (): string => {
    const roomId = getRoomId()
    return passwordTopologySalt
      ? toJson([appId, roomId, passwordTopologySalt])
      : appId || roomId
        ? toJson([appId, roomId])
        : ''
  }

  const refreshPasswordSalt = (): void => {
    const token = ++passwordSaltToken
    if (!password) {
      passwordTopologySalt = ''
      return
    }
    const targetRoomId = getRoomId()
    void signRoomAuth(password, appId, targetRoomId, '@topology', 0)
      .then(salt => {
        if (
          !isDestroyed() &&
          token === passwordSaltToken &&
          getRoomId() === targetRoomId &&
          passwordTopologySalt !== salt
        ) {
          passwordTopologySalt = salt
          recomputeTopologyAndRoutes()
          scheduleTargetsNotification()
        }
      })
      .catch(noOp)
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
    for (const [peerId, expiresAt] of localRequiredPeers.entries()) {
      if (!mediaPinnedPeers.has(peerId) && now > expiresAt) {
        localRequiredPeers.delete(peerId)
        changed = true
      }
    }
    if (changed) {
      topologyVersion++
    }
  }

  const isRequiredDirectPeer = (peerId: string): boolean => {
    if (mediaPinnedPeers.has(peerId)) {
      return true
    }
    const expiresAt = localRequiredPeers.get(peerId)
    if (expiresAt === undefined) {
      return false
    }
    if (Date.now() > expiresAt) {
      localRequiredPeers.delete(peerId)
      topologyVersion++
      return false
    }
    return true
  }

  const getActiveRequiredPeers = (): Set<string> => {
    pruneExpiredRequiredPeers()
    const out = new Set<string>(mediaPinnedPeers)
    for (const id of localRequiredPeers.keys()) {
      out.add(id)
    }
    return out
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
    if (cachedEffectiveTargets && cachedTargetsVersion === topologyVersion) {
      return cachedEffectiveTargets
    }
    const knownRoster = descriptors.getKnownRoster()
    const rawRoster = hasCompletedInitialBootstrap
      ? knownRoster
      : new Set<string>([...knownRoster, ...discoveredCandidates.keys()])
    const targets = computeTargetNeighbors(
      getSelfId(),
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
    const wasActive =
      mediaPinnedPeers.has(peerId) || localRequiredPeers.has(peerId)
    if (
      !localRequiredPeers.has(peerId) &&
      localRequiredPeers.size >= maxLocalRequiredPeers
    ) {
      for (const candidate of localRequiredPeers.keys()) {
        if (!mediaPinnedPeers.has(candidate)) {
          localRequiredPeers.delete(candidate)
          break
        }
      }
    }
    localRequiredPeers.set(peerId, now + requiredPeerIdleTtlMs)
    if (!wasActive) {
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
    if (pinned) {
      if (!isAllowedTargetPeer(peerId)) {
        return
      }
      const had = mediaPinnedPeers.has(peerId)
      mediaPinnedPeers.add(peerId)
      localRequiredPeers.set(peerId, Date.now() + requiredPeerIdleTtlMs)
      if (!had) {
        topologyVersion++
      }
    } else if (mediaPinnedPeers.delete(peerId)) {
      localRequiredPeers.set(peerId, Date.now() + requiredPeerIdleTtlMs)
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
    const timer = unreachableTimers.get(peerId)
    if (timer) {
      resetTimer(timer)
      unreachableTimers.delete(peerId)
    }
  }

  const purgeConnectionPolicyPeer = (peerId: string): void => {
    localRequiredPeers.delete(peerId)
    mediaPinnedPeers.delete(peerId)
    discoveredCandidates.delete(peerId)
    topologyVersion++
  }

  const purgePeerRoutingState = (peerId: string): void => {
    purgeConnectionPolicyPeer(peerId)
    hadRoutePeers.delete(peerId)
    everConfirmedNeighbors.delete(peerId)
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
    descriptors.purgePeer(peerId)
    purgePeerRoutingState(peerId)
    if (closed) {
      onVirtualPeerLeave(peerId, reason)
    }
  }

  const resolveHealthyNextHopId = (
    destPeerId: string,
    excludePeerIds?: string | ReadonlySet<string>
  ): string | undefined => {
    const isExcluded = (id: string): boolean =>
      excludePeerIds === undefined
        ? false
        : typeof excludePeerIds === 'string'
          ? id === excludePeerIds
          : excludePeerIds.has(id)

    if (!isExcluded(destPeerId) && isPeerUsable(getDirectPeer(destPeerId))) {
      return destPeerId
    }
    const route = routes[destPeerId]
    if (
      route &&
      !isExcluded(route.nextHop) &&
      isPeerUsable(getDirectPeer(route.nextHop))
    ) {
      return route.nextHop
    }
    const usableDirects: string[] = []
    for (const id of getDirectPeerIds()) {
      if (!isExcluded(id) && isPeerUsable(getDirectPeer(id))) {
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
    if (isDirectPeer(origin) || virtualTransports.has(origin)) {
      return true
    }
    if (
      capacityRejectedPeers.has(origin) ||
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
    const selfId = getSelfId()
    topologyVersion++
    descriptors.setLocalAdjacency(getDirectPeerIds())
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
      hadRoutePeers.add(peerId)
      clearUnreachableTimer(peerId)
      if (
        !isDirectPeer(peerId) &&
        descriptors.hasDescriptor(peerId) &&
        !capacityRejectedPeers.has(peerId)
      ) {
        if (!virtualTransports.has(peerId) && !admitVirtualPeer(peerId)) {
          continue
        }
        if (descriptors.getDescriptor(peerId)?.encPubKey) {
          onVirtualPeerReady?.(peerId)
        }
      }
    }

    for (const peerId of new Set<string>([
      ...virtualTransports.keys(),
      ...hadRoutePeers
    ])) {
      if (peerId === selfId || isDirectPeer(peerId) || routes[peerId]) {
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
      } else if (!unreachableTimers.has(peerId)) {
        const timer = setTimeout(() => {
          unreachableTimers.delete(peerId)
          if (!isDestroyed() && !isDirectPeer(peerId) && !routes[peerId]) {
            deactivateVirtualPeerNow(peerId, peerDisconnectedErr)
          }
        }, unreachableGraceMs)
        unrefTimer(timer)
        unreachableTimers.set(peerId, timer)
      }
    }

    if (targetsChangedCallback) {
      scheduleTargetsNotification()
    }
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
        discoveredCandidates.set(peerId, true)
        topologyVersion++
      }
      const targets = computeEffectiveTargets()
      const directCount = getDirectPeerCount()
      const minDirectPeers = Math.min(defaultMinConnections, maxDirectPeers)
      if (
        (targets.has(peerId) && directCount < maxDirectPeers) ||
        directCount < minDirectPeers
      ) {
        return true
      }
      if (
        direction === 'outbound' &&
        hasCompletedInitialBootstrap &&
        !knownRoster.has(peerId) &&
        !descriptors.hasLeft(peerId) &&
        !capacityRejectedPeers.has(peerId) &&
        getSelfId() < peerId &&
        directCount < maxDirectPeers + 2
      ) {
        return true
      }
      return direction === 'inbound' && directCount < maxDirectPeers * 2
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
    isVirtualPeer: peerId => virtualTransports.has(peerId),
    getVirtualPeerIds: () => virtualTransports.keys(),
    getVirtualPeerCount: () => virtualTransports.size,
    getVirtualTransport: peerId => virtualTransports.get(peerId),
    setVirtualTransport: (peerId, transport) => {
      virtualTransports.set(peerId, transport)
    },
    detachVirtualTransport: (peerId, transport) => {
      if (!transport || virtualTransports.get(peerId) === transport) {
        virtualTransports.delete(peerId)
      }
    },
    clearUnreachableTimer,
    clearCapacityRejected: peerId => {
      if (peerId === undefined) {
        capacityRejectedPeers.clear()
      } else {
        capacityRejectedPeers.delete(peerId)
      }
    },
    ensureOriginVirtualPeer,
    recomputeTopologyAndRoutes,
    evictVirtualPeerNow,
    quarantinePeer,
    clearQuarantined,
    isPeerQuarantined,
    purgeConnectionPolicyPeer,
    purgePeerRoutingState,
    refreshPasswordSalt,
    resetForRoomIdChange: () => {
      capacityRejectedPeers.clear()
      quarantinedPeers.clear()
      localRequiredPeers.clear()
      mediaPinnedPeers.clear()
      hasCompletedInitialBootstrap = false
      topologyVersion++
    },
    destroy: () => {
      unreachableTimers.forEach(resetTimer)
      virtualTransports.forEach(v => v.close?.())
      unreachableTimers.clear()
      virtualTransports.clear()
      capacityRejectedPeers.clear()
      quarantinedPeers.clear()
      hadRoutePeers.clear()
      everConfirmedNeighbors.clear()
      discoveredCandidates.clear()
      localRequiredPeers.clear()
      mediaPinnedPeers.clear()
      connectLimiter.clear()
    }
  }
}
