import type {BoundedCache} from '../primitives'
import {createTokenBucketLimiter} from '../signed-record'
import {createBoundedCache} from '../utils'
import type {PeerHandle} from '../types'
import type {PeerDescriptor} from './crypto-frame'
import {
  capRosterPeersPerUser,
  computeTargetNeighbors,
  defaultMinConnections,
  isAssignedGatekeeper,
  type ResolvedTopologyConfig
} from './topology'

const maxDiscoveredCandidates = 512
const maxLocalRequiredPeers = 2_048
const remoteConnectTtlMs = 15_000
const maxActiveRemoteConnectsPerUser = 2

export type ConnectionPolicyDeps = {
  config: ResolvedTopologyConfig
  directPeers: Map<string, PeerHandle>
  knownRoster: Set<string>
  bannedPeers: Set<string>
  capacityRejectedPeers: Set<string>
  descriptors: Map<string, PeerDescriptor>
  leftPeersSeq: BoundedCache<string, number>
  getSelfId: () => string
  getRoomSalt: () => string
  isAllowedTargetPeer: (peerId: string) => boolean
  isDestroyed: () => boolean
  getActiveMode: () => 'mesh' | 'gossip'
  updateActiveMode: () => void
  getTopologyVersion: () => number
  bumpTopologyVersion: () => void
  hasConvergedComponentDescriptors: () => boolean
}

export type ConnectionPolicy = {
  discoveredCandidates: BoundedCache<string, true>
  localRequiredPeers: Set<string>
  remoteConnectRequests: BoundedCache<string, {ts: number; userId?: string}>
  computeEffectiveTargets: () => Set<string>
  scheduleTargetsNotification: () => void
  hasTargetsCallback: () => boolean
  setOnTargetsChanged: (cb: (targetPeerIds: string[]) => void) => void
  requireDirectPeer: (peerId: string, options?: {dial?: boolean}) => void
  acceptMediaConnectRequest: (fromPeerId: string) => boolean
  notePeerDiscovered: (peerId: string) => boolean
  shouldConnectPeer: (
    peerId: string,
    direction: 'outbound' | 'inbound'
  ) => boolean
  purgePeer: (peerId: string) => void
  clearTransientState: () => void
}

export const createConnectionPolicy = (
  deps: ConnectionPolicyDeps
): ConnectionPolicy => {
  const {
    config,
    directPeers,
    knownRoster,
    bannedPeers,
    capacityRejectedPeers,
    descriptors,
    leftPeersSeq,
    getSelfId,
    getRoomSalt,
    isAllowedTargetPeer,
    isDestroyed,
    getActiveMode,
    updateActiveMode,
    getTopologyVersion,
    bumpTopologyVersion,
    hasConvergedComponentDescriptors
  } = deps

  let targetsChangedCallback: ((targetPeerIds: string[]) => void) | null = null
  let hasCompletedInitialBootstrap = false
  let cachedTargetsVersion = -1
  let cachedEffectiveTargets: Set<string> | null = null
  let targetsNotifyScheduled = false

  const discoveredCandidates = createBoundedCache<string, true>(
    maxDiscoveredCandidates
  )
  const localRequiredPeers = new Set<string>()
  const remoteConnectRateLimiter = createTokenBucketLimiter(0.5, 2, 512)
  const remoteConnectRequests = createBoundedCache<
    string,
    {ts: number; userId?: string}
  >(Math.max(16, config.maxConnections * 2))

  const hasActiveRemoteConnectRequest = (peerId: string): boolean => {
    const req = remoteConnectRequests.get(peerId)
    if (!req) {
      return false
    }
    if (Date.now() - req.ts > remoteConnectTtlMs) {
      remoteConnectRequests.delete(peerId)
      return false
    }
    return true
  }

  const getActiveRemoteConnectIds = (): string[] => {
    const now = Date.now()
    const active: string[] = []
    for (const [id, req] of remoteConnectRequests.entries()) {
      if (now - req.ts <= remoteConnectTtlMs) {
        active.push(id)
      } else {
        remoteConnectRequests.delete(id)
      }
    }
    return active
  }

  const computeEffectiveTargets = (): Set<string> => {
    updateActiveMode()
    if (!hasCompletedInitialBootstrap && hasConvergedComponentDescriptors()) {
      hasCompletedInitialBootstrap = true
      bumpTopologyVersion()
    }
    const ver = getTopologyVersion()
    if (cachedEffectiveTargets && cachedTargetsVersion === ver) {
      return cachedEffectiveTargets
    }
    const activeMode = getActiveMode()
    const selfId = getSelfId()
    const useVerifiedOnly =
      (activeMode === 'mesh' && knownRoster.size > 1) ||
      hasCompletedInitialBootstrap
    const rawRoster = useVerifiedOnly
      ? knownRoster
      : new Set<string>([...knownRoster, ...discoveredCandidates.keys()])
    const rosterForRing = capRosterPeersPerUser(
      rawRoster,
      selfId,
      activeMode,
      config.maxConnections,
      id => descriptors.get(id)?.userId
    )
    const targets = computeTargetNeighbors(
      selfId,
      rosterForRing,
      activeMode,
      config.maxConnections,
      getRoomSalt()
    )
    for (const reqId of localRequiredPeers) {
      targets.add(reqId)
    }
    cachedEffectiveTargets = targets
    cachedTargetsVersion = getTopologyVersion()
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
      updateActiveMode()
      if (getActiveMode() === 'mesh') {
        return
      }
      const candidates =
        directPeers.size >= config.maxConnections
          ? new Set([...localRequiredPeers, ...getActiveRemoteConnectIds()])
          : computeEffectiveTargets()
      const missing = [...candidates].filter(id => !directPeers.has(id))
      if (missing.length > 0) {
        targetsChangedCallback(missing)
      }
    })
  }

  const requireDirectPeer = (
    peerId: string,
    options?: {dial?: boolean}
  ): void => {
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
      bumpTopologyVersion()
    }
    if (options?.dial !== false && !directPeers.has(peerId)) {
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
    if (!remoteConnectRateLimiter.consume(userId ?? fromPeerId)) {
      return false
    }
    const now = Date.now()
    if (userId && !remoteConnectRequests.has(fromPeerId)) {
      let activeForUser = 0
      for (const [id, req] of remoteConnectRequests.entries()) {
        if (now - req.ts > remoteConnectTtlMs) {
          remoteConnectRequests.delete(id)
          continue
        }
        if (req.userId === userId) {
          activeForUser++
        }
      }
      if (activeForUser >= maxActiveRemoteConnectsPerUser) {
        return false
      }
    }
    remoteConnectRequests.set(fromPeerId, {
      ts: now,
      ...(userId !== undefined ? {userId} : {})
    })
    targetsChangedCallback?.([fromPeerId])
    return true
  }

  return {
    discoveredCandidates,
    localRequiredPeers,
    remoteConnectRequests,
    computeEffectiveTargets,
    scheduleTargetsNotification,
    hasTargetsCallback: (): boolean => Boolean(targetsChangedCallback),
    setOnTargetsChanged: (cb: (targetPeerIds: string[]) => void): void => {
      targetsChangedCallback = cb
    },
    requireDirectPeer,
    acceptMediaConnectRequest,
    notePeerDiscovered: (peerId: string): boolean => {
      if (
        !isAllowedTargetPeer(peerId) ||
        knownRoster.has(peerId) ||
        discoveredCandidates.has(peerId)
      ) {
        return false
      }
      discoveredCandidates.set(peerId, true)
      bumpTopologyVersion()
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
        directPeers.size < config.maxConnections * 3
      ) {
        return true
      }
      if (!knownRoster.has(peerId) && !discoveredCandidates.has(peerId)) {
        discoveredCandidates.set(peerId, true)
        bumpTopologyVersion()
      }
      updateActiveMode()
      const activeMode = getActiveMode()
      if (activeMode === 'mesh') {
        return true
      }

      const targets = computeEffectiveTargets()
      const minDirectPeers = Math.min(
        defaultMinConnections,
        config.maxConnections
      )
      if (
        (targets.has(peerId) && directPeers.size < config.maxConnections) ||
        directPeers.size < minDirectPeers
      ) {
        return true
      }
      const selfId = getSelfId()
      if (direction === 'outbound') {
        return Boolean(
          hasCompletedInitialBootstrap &&
          !knownRoster.has(peerId) &&
          !leftPeersSeq.has(peerId) &&
          !capacityRejectedPeers.has(peerId) &&
          selfId < peerId &&
          directPeers.size < config.maxConnections + 2 &&
          isAssignedGatekeeper(
            selfId,
            peerId,
            capRosterPeersPerUser(
              knownRoster,
              selfId,
              activeMode,
              config.maxConnections,
              id => descriptors.get(id)?.userId
            ),
            getRoomSalt(),
            u => bannedPeers.has(u) || leftPeersSeq.has(u)
          )
        )
      }
      return directPeers.size < config.maxConnections * 2
    },
    purgePeer: (peerId: string): void => {
      localRequiredPeers.delete(peerId)
      remoteConnectRequests.delete(peerId)
      discoveredCandidates.delete(peerId)
    },
    clearTransientState: (): void => {
      localRequiredPeers.clear()
      remoteConnectRequests.clear()
    }
  }
}
