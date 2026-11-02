import {verifyRoomAuth} from '../crypto'
import {
  canonicalizePubJwk,
  pubJwkToUncompressedBytes,
  verifyPeerIdKey,
  verifyUserEndpointProof
} from '../identity'
import type {BoundedCache} from '../primitives'
import {isValidSignalPeerId} from '../signal-handler'
import {createTokenBucketLimiter} from '../signed-record'
import {createBoundedCache, encodeBytes, resetTimer} from '../utils'
import type {
  PeerHandle,
  RoleCertificate,
  TopologyStats,
  UserIdentity
} from '../types'
import {
  canonicalLeaveHeader,
  descriptorCanonicalPayload,
  packGossipControlFrames,
  packOverlayControl,
  signPeerDescriptor,
  verifyBase64Sig,
  type CryptoIdentity,
  type OriginTaskQueue,
  type OverlayControlMessage,
  type PeerDescriptor
} from './crypto-frame'

const maxVerifiedDescriptors = 2_048
const maxPeersPerUser = 16
const descriptorUpdateRatePerSec = 8
const descriptorUpdateBurstCap = 16
const maxGossipEntriesPerFrame = 64

export type DescriptorStoreDeps = {
  appId: string
  password: string
  descriptorTtlMs: number
  maxConnections: number
  maxUsers?: number | undefined
  stats: TopologyStats
  getSelfId: () => string
  syncSelfIdFromIdentity: (peerId: string) => void
  getRoomId: () => string
  isDestroyed: () => boolean
  isOverlayActive: () => boolean
  directPeers: Map<string, PeerHandle>
  knownRoster: Set<string>
  bannedPeers: Set<string>
  adjacency: Map<string, Set<string>>
  getLocalCryptoIdentity: () => Promise<CryptoIdentity>
  getLocalUserIdentity?:
    | (() => Promise<UserIdentity> | UserIdentity)
    | undefined
  getLocalUserId: () => string | undefined
  getLocalRoleCert: () => RoleCertificate | null
  nextDescSeq: () => number
  computeEffectiveTargets: () => Set<string>
  recomputeTopologyAndRoutes: () => void
  sendToDirectNeighbor: (peerId: string, frame: Uint8Array) => boolean
  evictVirtualPeerNow: (peerId: string, reason: Error) => void
  verifyUnicastOrBroadcast: (
    originPeerId: string,
    canonicalHeader: string,
    payload: Uint8Array,
    sig: string | undefined
  ) => Promise<boolean>
  onEncPubKeyRotated: (peerId: string) => void
  originTasks: OriginTaskQueue
  hasManyDiscoveredCandidates: () => boolean
  onPeerDescriptorCert?:
    | ((
        peerId: string,
        signPubKey: JsonWebKey,
        cert?: RoleCertificate,
        userId?: string,
        userPubKey?: JsonWebKey
      ) => void)
    | undefined
  peerDisconnectedErr: Error
  peerLeftRoomErr: Error
}

export type DescriptorStore = {
  descriptors: Map<string, PeerDescriptor>
  descriptorReceivedAt: Map<string, number>
  peerSignPubKeys: Map<string, JsonWebKey>
  pinnedSignKeys: Map<string, string>
  leftPeersSeq: BoundedCache<string, number>
  recordLeftPeer: (peerId: string, seq: number) => void
  publishLocalDescriptor: () => Promise<void>
  dispatchControlMessage: (
    fromPeerId: string,
    msg: OverlayControlMessage
  ) => void
  touchOriginActivity: (origin: string) => void
  getPeerSignPublicKey: (peerId: string) => JsonWebKey | undefined
  setPeerSignPublicKey: (peerId: string, pubKey: JsonWebKey) => void
  purgePeerState: (peerId: string) => void
  hasConvergedComponentDescriptors: () => boolean
  sendInitialDescriptorsTo: (
    peerId: string,
    initialKnownIds: Set<string>
  ) => void
  destroy: () => void
}

export const createDescriptorStore = (
  deps: DescriptorStoreDeps
): DescriptorStore => {
  const {
    appId,
    password,
    descriptorTtlMs,
    maxConnections,
    maxUsers,
    stats,
    directPeers,
    knownRoster,
    bannedPeers,
    adjacency,
    peerDisconnectedErr,
    peerLeftRoomErr
  } = deps
  const {
    getSelfId,
    getRoomId,
    isDestroyed,
    isOverlayActive,
    recomputeTopologyAndRoutes,
    sendToDirectNeighbor,
    evictVirtualPeerNow,
    originTasks
  } = deps

  const maxDescriptorNeighbors = Math.max(16, maxConnections * 3)
  const descriptors = new Map<string, PeerDescriptor>()
  const descriptorReceivedAt = new Map<string, number>()
  const peerSignPubKeys = new Map<string, JsonWebKey>()
  const pinnedSignKeys = new Map<string, string>()
  const leftPeersSeq = createBoundedCache<string, number>(1_024)
  const descUpdateLimiter = createTokenBucketLimiter(
    descriptorUpdateRatePerSec,
    descriptorUpdateBurstCap,
    maxVerifiedDescriptors
  )
  const senderInvalidDescCounts = createBoundedCache<string, number>(512)
  const inFlightDescriptors = new Map<string, Promise<boolean>>()
  const pendingUserAdmissions = new Set<string>()

  const recordLeftPeer = (peerId: string, seq: number): void => {
    leftPeersSeq.set(peerId, seq)
  }

  const recordSenderInvalid = (fromPeerId: string): void => {
    senderInvalidDescCounts.set(
      fromPeerId,
      (senderInvalidDescCounts.get(fromPeerId) ?? 0) + 1
    )
  }

  const findEvictableUserPeer = (
    userId: string,
    candidatePeerId: string,
    now: number
  ): {canAdmit: boolean; evictPeerId: string | null} => {
    const selfId = getSelfId()
    let userPeerCount = 0
    let oldestUserPeerId: string | null = null
    let oldestUserTime = Infinity
    for (const existingDesc of descriptors.values()) {
      if (
        existingDesc.peerId !== candidatePeerId &&
        existingDesc.userId === userId
      ) {
        userPeerCount++
        if (
          existingDesc.peerId !== selfId &&
          !directPeers.has(existingDesc.peerId)
        ) {
          const t = descriptorReceivedAt.get(existingDesc.peerId) ?? 0
          if (t < oldestUserTime) {
            oldestUserTime = t
            oldestUserPeerId = existingDesc.peerId
          }
        }
      }
    }
    if (userPeerCount < maxPeersPerUser) {
      return {canAdmit: true, evictPeerId: null}
    }
    if (!oldestUserPeerId || now - oldestUserTime <= descriptorTtlMs) {
      return {canAdmit: false, evictPeerId: null}
    }
    return {canAdmit: true, evictPeerId: oldestUserPeerId}
  }

  const findEvictableStaleDescriptor = (
    now: number
  ): {canAdmit: boolean; evictPeerId: string | null} => {
    if (descriptors.size < maxVerifiedDescriptors) {
      return {canAdmit: true, evictPeerId: null}
    }
    const selfId = getSelfId()
    let oldestPeerId: string | null = null
    let oldestTime = Infinity
    for (const existingId of descriptors.keys()) {
      if (existingId !== selfId && !directPeers.has(existingId)) {
        const t = descriptorReceivedAt.get(existingId) ?? 0
        if (t < oldestTime) {
          oldestTime = t
          oldestPeerId = existingId
        }
      }
    }
    if (!oldestPeerId || now - oldestTime <= descriptorTtlMs) {
      return {canAdmit: false, evictPeerId: null}
    }
    return {canAdmit: true, evictPeerId: oldestPeerId}
  }

  const canAdmitWithinUserLimit = (d: PeerDescriptor, now: number): boolean => {
    if (maxUsers === undefined) {
      return true
    }
    const selfId = getSelfId()
    const activeIdentityKeys = new Set<string>([
      deps.getLocalUserId() ??
        descriptors.get(selfId)?.userId ??
        (selfId || '__self__')
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

  const isValidDescriptorNeighbors = (
    peerId: string,
    neighbors: unknown
  ): neighbors is string[] =>
    Array.isArray(neighbors) &&
    neighbors.length <= maxDescriptorNeighbors &&
    neighbors.every(n => isValidSignalPeerId(n) && n !== peerId)

  const hasValidDescriptorShape = (
    d: PeerDescriptor
  ): d is PeerDescriptor & {signPubKey: JsonWebKey; sig: string} =>
    Boolean(
      d &&
      isValidSignalPeerId(d.peerId) &&
      typeof d.seq === 'number' &&
      Number.isSafeInteger(d.seq) &&
      d.seq > 0 &&
      d.signPubKey &&
      typeof d.sig === 'string' &&
      d.sig &&
      isValidDescriptorNeighbors(d.peerId, d.neighbors) &&
      (d.encPubKey === undefined ||
        Boolean(pubJwkToUncompressedBytes(d.encPubKey))) &&
      !bannedPeers.has(d.peerId)
    )

  const needsUserProof = (d: PeerDescriptor): boolean =>
    Boolean(deps.getLocalUserIdentity) ||
    d.userId !== undefined ||
    d.userPubKey !== undefined ||
    d.userProof !== undefined

  const commitVerifiedDescriptor = (
    d: PeerDescriptor & {signPubKey: JsonWebKey; sig: string},
    keyThumbprint: string
  ): true => {
    pinnedSignKeys.set(d.peerId, keyThumbprint)
    peerSignPubKeys.set(d.peerId, d.signPubKey)
    deps.onPeerDescriptorCert?.(
      d.peerId,
      d.signPubKey,
      d.cert,
      d.userId,
      d.userPubKey
    )
    return true
  }

  const verifyDescriptor = (d: PeerDescriptor): boolean | Promise<boolean> => {
    const roomId = getRoomId()
    if (!hasValidDescriptorShape(d)) {
      stats.signatureFailures++
      return false
    }
    const keyThumbprint = canonicalizePubJwk(d.signPubKey)
    const pinned = pinnedSignKeys.get(d.peerId)
    if (pinned && pinned !== keyThumbprint) {
      stats.signatureFailures++
      return false
    }
    const checkUser = needsUserProof(d)
    if (
      (checkUser && (!d.userId || !d.userPubKey || !d.userProof)) ||
      (password && (typeof d.roomAuth !== 'string' || !d.roomAuth))
    ) {
      stats.signatureFailures++
      return false
    }
    const checkEndpointProof = (): boolean | Promise<boolean> =>
      verifyUserEndpointProof({
        appId,
        roomId,
        peerId: d.peerId,
        peerPubJwk: d.signPubKey,
        userId: d.userId!,
        userPubJwk: d.userPubKey!,
        proof: d.userProof!,
        seq: d.seq
      })
    const peerOk = password ? null : verifyPeerIdKey(d.peerId, d.signPubKey)
    if (peerOk === false) {
      stats.signatureFailures++
      return false
    }
    const userOk =
      peerOk === true && checkUser
        ? checkEndpointProof()
        : checkUser
          ? null
          : true
    if (userOk === false) {
      stats.signatureFailures++
      return false
    }
    if (peerOk === true && userOk === true) {
      const canonicalBytes = encodeBytes(
        descriptorCanonicalPayload(d, appId, roomId)
      )
      const sigOk = verifyBase64Sig(d.sig, canonicalBytes, d.signPubKey)
      if (typeof sigOk === 'boolean') {
        if (!sigOk) {
          stats.signatureFailures++
          return false
        }
        return commitVerifiedDescriptor(d, keyThumbprint)
      }
      return sigOk.then(ok => {
        if (!ok) {
          stats.signatureFailures++
          return false
        }
        return commitVerifiedDescriptor(d, keyThumbprint)
      })
    }

    return (async () => {
      if (
        password &&
        !(await verifyRoomAuth(
          password,
          appId,
          roomId,
          d.peerId,
          d.seq,
          d.roomAuth!
        ))
      ) {
        stats.signatureFailures++
        return false
      }
      if (!(await (peerOk ?? verifyPeerIdKey(d.peerId, d.signPubKey)))) {
        stats.signatureFailures++
        return false
      }
      if (checkUser && !(await (userOk ?? checkEndpointProof()))) {
        stats.signatureFailures++
        return false
      }
      const latestPinned = pinnedSignKeys.get(d.peerId)
      if (latestPinned && latestPinned !== keyThumbprint) {
        stats.signatureFailures++
        return false
      }
      const canonicalBytes = encodeBytes(
        descriptorCanonicalPayload(d, appId, roomId)
      )
      if (!(await verifyBase64Sig(d.sig, canonicalBytes, d.signPubKey))) {
        stats.signatureFailures++
        return false
      }
      return commitVerifiedDescriptor(d, keyThumbprint)
    })()
  }

  const sendGossipToNeighbors = (
    list: PeerDescriptor[],
    excludePeerId?: string
  ): void => {
    const packets = packGossipControlFrames(list)
    if (packets.length === 0) {
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
    const id = await deps.getLocalCryptoIdentity()
    const userIdentity = deps.getLocalUserIdentity
      ? await deps.getLocalUserIdentity()
      : null
    deps.syncSelfIdFromIdentity(id.peerId)
    const selfId = getSelfId()
    const roomId = getRoomId()

    publishDirty = false
    const seq = deps.nextDescSeq()
    const allDirect = [...directPeers.keys()]
    const targets =
      allDirect.length <= maxDescriptorNeighbors
        ? null
        : deps.computeEffectiveTargets()
    const neighbors = (
      !targets
        ? allDirect
        : allDirect
            .sort(
              (a, b) =>
                Number(targets.has(b)) - Number(targets.has(a)) ||
                a.localeCompare(b)
            )
            .slice(0, maxDescriptorNeighbors)
    ).sort()

    const localRoleCert = deps.getLocalRoleCert()
    const descriptor: PeerDescriptor = {
      peerId: selfId,
      seq,
      neighbors,
      signPubKey: id.signPubJwk,
      encPubKey: id.encPubJwk,
      ...(localRoleCert ? {cert: localRoleCert} : {})
    }
    return signPeerDescriptor(
      descriptor,
      id,
      appId,
      roomId,
      password,
      userIdentity
    )
  }

  const publishLocalDescriptor = (): Promise<void> => {
    if (isDestroyed() || !isOverlayActive()) {
      return Promise.resolve()
    }
    publishDirty = true
    if (!pendingPublishPromise) {
      pendingPublishPromise = new Promise<void>(resolve => {
        queueMicrotask(async () => {
          try {
            while (publishDirty && !isDestroyed() && isOverlayActive()) {
              const signedDescriptor = await buildLocalDescriptor()
              if (isDestroyed()) {
                break
              }
              const selfId = getSelfId()
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
    if (isDestroyed()) {
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

  const scheduleGossipFlush = (
    desc: PeerDescriptor,
    fromPeerId: string
  ): void => {
    const prev = pendingGossipDescriptors.get(desc.peerId)
    if (!prev || prev.seq < desc.seq) {
      pendingGossipDescriptors.set(desc.peerId, desc)
    }
    pendingGossipSources.add(fromPeerId)

    if (!gossipFlushScheduled) {
      gossipFlushScheduled = true
      if (descriptors.size > 32 || deps.hasManyDiscoveredCandidates()) {
        const t = setTimeout(flushPendingGossip, 2)
        ;(t as {unref?: () => void}).unref?.()
      } else {
        queueMicrotask(flushPendingGossip)
      }
    }
  }

  const applyVerifiedDescriptor = (
    fromPeerId: string,
    d: PeerDescriptor,
    isValid: boolean
  ): void => {
    if (!isValid || isDestroyed()) {
      if (!isValid && !isDestroyed()) {
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
        const userCap = findEvictableUserPeer(d.userId, d.peerId, now)
        if (!userCap.canAdmit) {
          return
        }
        if (userCap.evictPeerId) {
          evictVirtualPeerNow(userCap.evictPeerId, peerDisconnectedErr)
        }
      }
      const descCap = findEvictableStaleDescriptor(now)
      if (!descCap.canAdmit) {
        return
      }
      if (descCap.evictPeerId) {
        evictVirtualPeerNow(descCap.evictPeerId, peerDisconnectedErr)
      }
    }

    if (
      latest?.encPubKey &&
      d.encPubKey &&
      canonicalizePubJwk(latest.encPubKey) !== canonicalizePubJwk(d.encPubKey)
    ) {
      deps.onEncPubKeyRotated(d.peerId)
    }
    const wasMarkedLeft = leftPeersSeq.has(d.peerId)
    leftPeersSeq.delete(d.peerId)
    knownRoster.add(d.peerId)
    descriptors.set(d.peerId, d)
    descriptorReceivedAt.set(d.peerId, Date.now())
    const currentSelfId = getSelfId()
    adjacency.set(
      d.peerId,
      new Set(
        d.neighbors.filter(
          n =>
            !leftPeersSeq.has(n) &&
            !bannedPeers.has(n) &&
            (n !== currentSelfId || directPeers.has(d.peerId))
        )
      )
    )
    if (wasMarkedLeft && !bannedPeers.has(d.peerId)) {
      for (const [otherId, otherDesc] of descriptors.entries()) {
        if (
          otherId !== currentSelfId &&
          otherId !== d.peerId &&
          !leftPeersSeq.has(otherId) &&
          otherDesc.neighbors.includes(d.peerId)
        ) {
          let set = adjacency.get(otherId)
          if (!set) {
            set = new Set<string>()
            adjacency.set(otherId, set)
          }
          set.add(d.peerId)
        }
      }
    }
    scheduleGossipFlush(d, fromPeerId)
  }

  const processDescriptorStep = (
    fromPeerId: string,
    d: PeerDescriptor
  ): void | Promise<void> => {
    const selfId = getSelfId()
    if (isDestroyed() || !d || d.peerId === selfId) {
      return
    }
    const leftSeq = leftPeersSeq.get(d.peerId)
    if (leftSeq !== undefined && d.seq <= leftSeq) {
      return
    }
    const existing = descriptors.get(d.peerId)
    if (existing && existing.seq >= d.seq) {
      return
    }

    if (!hasValidDescriptorShape(d)) {
      stats.signatureFailures++
      recordSenderInvalid(fromPeerId)
      return
    }

    const descInFlightKey = `${d.peerId}:${d.seq}:${d.sig}`
    const existingInFlight = inFlightDescriptors.get(descInFlightKey)
    if (!existingInFlight) {
      if (existing) {
        if (!descUpdateLimiter.consume(d.peerId)) {
          stats.signatureFailures++
          return
        }
      } else {
        if ((senderInvalidDescCounts.get(fromPeerId) ?? 0) >= 16) {
          stats.signatureFailures++
          return
        }
        if (!directPeers.has(d.peerId)) {
          const now = Date.now()
          if (
            (d.userId &&
              !findEvictableUserPeer(d.userId, d.peerId, now).canAdmit) ||
            !canAdmitWithinUserLimit(d, now) ||
            !findEvictableStaleDescriptor(now).canAdmit
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
    if (isDestroyed() || !msg || typeof msg !== 'object') {
      return
    }

    if (msg.t === 'leave') {
      const leavingId = msg.peerId
      if (!isValidSignalPeerId(leavingId) || leavingId === getSelfId()) {
        return
      }
      originTasks.enqueue(`ctrl:${leavingId}`, async () => {
        if (isDestroyed()) {
          return
        }
        if (
          typeof msg.seq !== 'number' ||
          !Number.isSafeInteger(msg.seq) ||
          msg.seq <= 0 ||
          typeof msg.sig !== 'string' ||
          !msg.sig
        ) {
          stats.signatureFailures++
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
        const valid = await deps.verifyUnicastOrBroadcast(
          leavingId,
          canonicalLeaveHeader(leavingId, msg.seq, appId, getRoomId()),
          new Uint8Array(),
          msg.sig
        )
        if (!valid || isDestroyed()) {
          return
        }
        const lastSeq = Math.max(msg.seq, descriptors.get(leavingId)?.seq ?? 0)
        recordLeftPeer(leavingId, lastSeq)
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
      // Deduplicate by peerId (highest seq) within the frame and process each origin independently
      // so one slow PBKDF2/ECDSA verification never causes HOL blocking for other origins.
      const dedupedByOrigin = new Map<string, PeerDescriptor>()
      for (const d of msg.descriptors.slice(0, maxGossipEntriesPerFrame)) {
        if (!d || typeof d !== 'object') {
          continue
        }
        if (typeof d.peerId !== 'string' || !isValidSignalPeerId(d.peerId)) {
          stats.signatureFailures++
          recordSenderInvalid(fromPeerId)
          continue
        }
        const prev = dedupedByOrigin.get(d.peerId)
        if (!prev || (typeof d.seq === 'number' && d.seq > prev.seq)) {
          dedupedByOrigin.set(d.peerId, d)
        }
      }
      const selfId = getSelfId()
      for (const [originId, desc] of dedupedByOrigin.entries()) {
        if (originId === selfId) {
          continue
        }
        const leftSeq = leftPeersSeq.get(originId)
        if (leftSeq !== undefined && desc.seq <= leftSeq) {
          continue
        }
        const existing = descriptors.get(originId)
        if (existing && existing.seq >= desc.seq) {
          continue
        }
        const queueKey = `ctrl:${originId}`
        if (!originTasks.has(queueKey)) {
          const stepRes = processDescriptorStep(fromPeerId, desc)
          if (stepRes) {
            originTasks.enqueue(queueKey, () => stepRes)
          }
        } else {
          originTasks.enqueue(queueKey, () =>
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
    if (isDestroyed()) {
      return
    }
    const selfId = getSelfId()
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
          recordLeftPeer(peerId, desc.seq)
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
  ;(heartbeatTimer as {unref?: () => void}).unref?.()

  return {
    descriptors,
    descriptorReceivedAt,
    peerSignPubKeys,
    pinnedSignKeys,
    leftPeersSeq,
    recordLeftPeer,
    publishLocalDescriptor,
    dispatchControlMessage,
    touchOriginActivity: (origin: string): void => {
      if (descriptors.has(origin)) {
        descriptorReceivedAt.set(origin, Date.now())
      }
    },
    getPeerSignPublicKey: (peerId: string): JsonWebKey | undefined =>
      peerSignPubKeys.get(peerId) ?? descriptors.get(peerId)?.signPubKey,
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
    purgePeerState: (peerId: string): void => {
      descriptors.delete(peerId)
      descriptorReceivedAt.delete(peerId)
      descUpdateLimiter.delete(peerId)
      senderInvalidDescCounts.delete(peerId)
    },
    hasConvergedComponentDescriptors: (): boolean => {
      if (directPeers.size === 0) {
        return false
      }
      for (const dId of directPeers.keys()) {
        if (!descriptors.has(dId)) {
          return false
        }
      }
      const selfId = getSelfId()
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
    },
    sendInitialDescriptorsTo: (
      peerId: string,
      initialKnownIds: Set<string>
    ): void => {
      if (initialKnownIds.size === 0) {
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
    },
    destroy: (): void => {
      resetTimer(heartbeatTimer)
      pendingGossipDescriptors.clear()
      pendingGossipSources.clear()
      inFlightDescriptors.clear()
      pendingUserAdmissions.clear()
    }
  }
}
