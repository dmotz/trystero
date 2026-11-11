import {verifyRoomAuth} from '../crypto'
import {
  pubJwkToUncompressedBytes,
  toCompactPub,
  verifyPeerIdKey,
  verifyUserEndpointProof
} from '../identity'
import type {MaybePromise, Timeout} from '../internal-types'
import {isValidSignalPeerId} from '../signal-handler'
import {createTokenBucketLimiter} from '../signed-record'
import type {RoleCertificate, UserIdentity} from '../types'
import {
  cmpStr,
  createBoundedCache,
  encodeBytes,
  isPosSafeInt,
  isStr,
  noOp,
  peerDisconnectedErr,
  peerLeftRoomErr,
  resetTimer,
  unreachable,
  unrefTimer
} from '../utils'
import {
  buildOverlaySignedBytes,
  canonicalLeaveHeader,
  descriptorCanonicalPayload,
  maxDescriptorNeighbors,
  packGossipControlFrames,
  packOverlayControl,
  signPeerDescriptor,
  verifyBase64Sig,
  type CryptoIdentity,
  type OverlayControlMessage,
  type PeerDescriptor
} from './crypto-frame'
import type {OverlaySequencer} from './seq'

const maxTrackedOverlayPeers = 2_048
const maxPeersPerUser = 16
const maxGossipEntriesPerFrame = 64
const replaySeedCushionPackets = 32
const emptyBytes = /*@__PURE__*/ new Uint8Array(0)

type ActiveRemoteDescriptor = {
  descriptor: PeerDescriptor
  receivedAt: number
}

type LocalPublishState =
  | {readonly phase: 'idle'}
  | {readonly phase: 'queued'; readonly promise: Promise<void>}
  | {
      readonly phase: 'signing'
      readonly token: symbol
      readonly promise: Promise<void>
      readonly dirty: boolean
    }

export type DescriptorStoreDeps = {
  appId: string
  password: string
  descriptorTtlMs: number
  maxUsers?: number | undefined
  seq: OverlaySequencer
  isDestroyed: () => boolean
  canPublish?: (() => boolean) | undefined
  getSelfId: () => string
  getRoomId: () => string
  getLocalUserId: () => string | undefined
  getLocalUserIdentity?: (() => MaybePromise<UserIdentity>) | undefined
  loadLocalCryptoIdentity: () => Promise<CryptoIdentity>
  syncSelfIdFromIdentity: (peerId: string) => void
  isDirectPeer: (peerId: string) => boolean
  isVirtualPeer: (peerId: string) => boolean
  getDirectPeerIds: () => IterableIterator<string>
  getDirectPeerCount: () => number
  getDiscoveredCandidateCount: () => number
  computeEffectiveTargets: () => Set<string>
  sendToDirectNeighbor: (peerId: string, frame: Uint8Array) => boolean
  isPeerBanned: (peerId: string) => boolean
  recordSignatureFailure: () => void
  onTopologyChanged: () => void
  onEvictVirtualPeer: (peerId: string, reason: Error) => void
  onOriginDescriptorVerified: (peerId: string, encKeyRotated: boolean) => void
  hasBufferedFramesForOrigin?: ((peerId: string) => boolean) | undefined
  onPeerDescriptorCert?:
    | ((
        peerId: string,
        signPubKey: string,
        cert?: RoleCertificate,
        userId?: string
      ) => void)
    | undefined
  onError?: ((error: unknown) => void) | undefined
}

export type DescriptorStore = {
  hasDescriptor: (peerId: string) => boolean
  getDescriptor: (peerId: string) => PeerDescriptor | undefined
  getDescriptorCount: () => number
  getKnownRoster: () => Set<string>
  addKnownPeer: (peerId: string) => void
  deleteKnownPeer: (peerId: string) => void
  hasLeft: (peerId: string) => boolean
  markLeft: (peerId: string, seq?: number) => void
  clearLeft: (peerId: string) => void
  getAdjacency: () => Map<string, Set<string>>
  setLocalAdjacency: (neighbors: Iterable<string>) => void
  onDirectPeerDisconnected: (peerId: string) => void
  syncSelfIdChange: (prevSelfId: string, nextSelfId: string) => void
  resetForRoomIdChange: (activeDirectPeerIds: Iterable<string>) => void
  flushPendingTopology: () => void
  hasConvergedComponent: () => boolean
  hasConvergedDirectMesh: () => boolean
  getSignPubKey: (peerId: string) => string | undefined
  isPinnedKeyMatch: (peerId: string, pubKey: JsonWebKey | string) => boolean
  setPeerSignPublicKey: (peerId: string, pubKey: JsonWebKey | string) => void
  setLocalRoleCertificate: (cert: RoleCertificate | null) => void
  touchOriginActivity: (originPeerId: string) => void
  publishLocalDescriptor: () => Promise<void>
  sendInitialKnownDescriptors: (peerId: string) => void
  dispatchControlMessage: (
    fromPeerId: string,
    msg: OverlayControlMessage
  ) => void
  purgePeer: (peerId: string) => void
  destroy: () => void
}

export const createDescriptorStore = (
  deps: DescriptorStoreDeps
): DescriptorStore => {
  const {
    appId,
    password,
    descriptorTtlMs,
    maxUsers,
    seq,
    isDestroyed,
    canPublish,
    getSelfId,
    getRoomId,
    getLocalUserId,
    getLocalUserIdentity,
    loadLocalCryptoIdentity,
    syncSelfIdFromIdentity,
    isDirectPeer,
    isVirtualPeer,
    getDirectPeerIds,
    getDirectPeerCount,
    getDiscoveredCandidateCount,
    computeEffectiveTargets,
    sendToDirectNeighbor,
    isPeerBanned,
    recordSignatureFailure,
    onTopologyChanged,
    onEvictVirtualPeer,
    onOriginDescriptorVerified,
    hasBufferedFramesForOrigin,
    onPeerDescriptorCert,
    onError
  } = deps

  const remoteDescriptors = new Map<string, ActiveRemoteDescriptor>()
  const adjacency = new Map<string, Set<string>>()
  const initialSelf = getSelfId()
  const knownRoster = new Set<string>(initialSelf ? [initialSelf] : [])
  const pinnedSignKeys = createBoundedCache<string, string>(
    maxTrackedOverlayPeers
  )
  const leftPeersSeq = createBoundedCache<string, number>(
    maxTrackedOverlayPeers
  )
  const descLimiter = createTokenBucketLimiter(8, 16, maxTrackedOverlayPeers)
  const senderInvalidDescCounts = createBoundedCache<string, number>(512)
  const inFlightDescriptors = new Map<string, Promise<boolean>>()
  const pendingUserAdmissions = new Map<string, number>()

  let localDescriptor: PeerDescriptor | null = null
  let lastLocalPublishAt = 0
  let localRoleCert: RoleCertificate | null = null
  let localPublishState: LocalPublishState = {phase: 'idle'}
  let descriptorEpoch = 0

  const pendingGossipDescriptors = new Map<string, PeerDescriptor>()
  const pendingGossipSources = new Set<string>()
  let gossipFlush: Timeout | 'microtask' | null = null
  let pendingTopologyDirty = false

  const isPublishAllowed = (): boolean =>
    !isDestroyed() && (canPublish ? canPublish() : true)

  const failSig = (): false => {
    recordSignatureFailure()
    return false
  }

  const recordSenderInvalid = (fromPeerId: string): void => {
    senderInvalidDescCounts.set(
      fromPeerId,
      (senderInvalidDescCounts.get(fromPeerId) ?? 0) + 1
    )
  }

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

  const getDescriptorCount = (): number =>
    remoteDescriptors.size + (localDescriptor ? 1 : 0)

  const getAnyDescriptor = (peerId: string): PeerDescriptor | undefined => {
    if (localDescriptor && peerId === getSelfId()) {
      return localDescriptor
    }
    return remoteDescriptors.get(peerId)?.descriptor
  }

  const purgeActiveRemoteDescriptor = (peerId: string): void => {
    remoteDescriptors.delete(peerId)
    adjacency.delete(peerId)
    knownRoster.delete(peerId)
    for (const set of adjacency.values()) {
      set.delete(peerId)
    }
  }

  const markPeerLeft = (peerId: string, seqVal?: number): void => {
    if (!peerId || peerId === getSelfId()) {
      return
    }
    const activeSeq = remoteDescriptors.get(peerId)?.descriptor.seq ?? 0
    const prevLeftSeq = leftPeersSeq.get(peerId) ?? 0
    const tombstoneSeq = Math.max(seqVal ?? activeSeq, activeSeq, prevLeftSeq)
    purgeActiveRemoteDescriptor(peerId)
    pendingGossipDescriptors.delete(peerId)
    leftPeersSeq.set(peerId, tombstoneSeq)
  }

  const cancelGossipFlush = (): void => {
    if (gossipFlush !== null && gossipFlush !== 'microtask') {
      resetTimer(gossipFlush)
    }
    gossipFlush = null
  }

  const flushPendingTopology = (): void => {
    if (!pendingTopologyDirty || isDestroyed()) {
      return
    }
    pendingTopologyDirty = false
    onTopologyChanged()
  }

  const findEvictable = (
    now: number,
    limit: number,
    filter?: (d: PeerDescriptor) => boolean
  ): string | null | false => {
    let count = 0
    if (localDescriptor && (!filter || filter(localDescriptor))) {
      count++
    }
    let oldestId: string | null = null
    let oldestTime = Infinity
    for (const {descriptor: d, receivedAt} of remoteDescriptors.values()) {
      if (!filter || filter(d)) {
        count++
        if (!isDirectPeer(d.peerId) && receivedAt < oldestTime) {
          oldestTime = receivedAt
          oldestId = d.peerId
        }
      }
    }
    return count < limit
      ? null
      : oldestId && now - oldestTime > descriptorTtlMs
        ? oldestId
        : false
  }

  const canAdmitWithinUserLimit = (d: PeerDescriptor, now: number): boolean => {
    if (maxUsers === undefined) {
      return true
    }
    const selfId = getSelfId()
    const activeIdentityKeys = new Set<string>([
      getLocalUserId() ?? localDescriptor?.userId ?? (selfId || '__self__')
    ])
    for (const directId of getDirectPeerIds()) {
      activeIdentityKeys.add(
        remoteDescriptors.get(directId)?.descriptor.userId ?? directId
      )
    }
    for (const [descPeerId, entry] of remoteDescriptors.entries()) {
      if (
        isDirectPeer(descPeerId) ||
        now - entry.receivedAt <= descriptorTtlMs
      ) {
        activeIdentityKeys.add(entry.descriptor.userId ?? descPeerId)
      }
    }
    for (const pendingKey of pendingUserAdmissions.keys()) {
      activeIdentityKeys.add(pendingKey)
    }
    const candidateKey = d.userId ?? d.peerId
    return (
      activeIdentityKeys.has(candidateKey) || activeIdentityKeys.size < maxUsers
    )
  }

  const tryAdmitNewDescriptor = (
    d: PeerDescriptor,
    commitEvictions: boolean
  ): boolean => {
    if (isDirectPeer(d.peerId)) {
      return true
    }
    const now = Date.now()
    if (!canAdmitWithinUserLimit(d, now)) {
      return false
    }
    if (d.userId) {
      const evictUidPeer = findEvictable(
        now,
        maxPeersPerUser,
        item => item.peerId !== d.peerId && item.userId === d.userId
      )
      if (evictUidPeer === false) {
        return false
      }
      if (commitEvictions && evictUidPeer) {
        onEvictVirtualPeer(evictUidPeer, peerDisconnectedErr)
      }
    }
    const evictStale =
      getDescriptorCount() < maxTrackedOverlayPeers
        ? null
        : findEvictable(now, maxTrackedOverlayPeers)
    if (evictStale === false) {
      return false
    }
    if (commitEvictions && evictStale) {
      onEvictVirtualPeer(evictStale, peerDisconnectedErr)
    }
    return true
  }

  const hasValidDescriptorShape = (
    d: PeerDescriptor
  ): d is PeerDescriptor & {signPubKey: string; sig: string} =>
    Boolean(
      d &&
      isValidSignalPeerId(d.peerId) &&
      isPosSafeInt(d.seq) &&
      (d.pktSeq === undefined ||
        (Number.isSafeInteger(d.pktSeq) && d.pktSeq >= 0)) &&
      isStr(d.signPubKey) &&
      Boolean(pubJwkToUncompressedBytes(d.signPubKey)) &&
      isStr(d.sig) &&
      Array.isArray(d.neighbors) &&
      d.neighbors.length <= maxDescriptorNeighbors &&
      d.neighbors.every(n => isValidSignalPeerId(n) && n !== d.peerId) &&
      (d.encPubKey === undefined ||
        (isStr(d.encPubKey) &&
          Boolean(pubJwkToUncompressedBytes(d.encPubKey)))) &&
      (d.userPubKey === undefined ||
        (isStr(d.userPubKey) &&
          Boolean(pubJwkToUncompressedBytes(d.userPubKey))))
    )

  const verifyDescriptor = (
    d: PeerDescriptor & {signPubKey: string; sig: string},
    expectedRoomId: string
  ): boolean | Promise<boolean> => {
    const keyThumbprint = d.signPubKey
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
        roomId: expectedRoomId,
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
        encodeBytes(descriptorCanonicalPayload(d, appId, expectedRoomId)),
        d.signPubKey
      )
      const done = (ok: boolean): boolean => {
        if (isDestroyed() || getRoomId() !== expectedRoomId) {
          return false
        }
        const latest = pinnedSignKeys.get(d.peerId)
        if (!ok || (latest && latest !== keyThumbprint)) {
          return failSig()
        }
        pinnedSignKeys.set(d.peerId, keyThumbprint)
        onPeerDescriptorCert?.(d.peerId, d.signPubKey, d.cert, d.userId)
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
          expectedRoomId,
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
    for (const neighborId of getDirectPeerIds()) {
      if (neighborId !== excludePeerId) {
        for (const packet of packets) {
          sendToDirectNeighbor(neighborId, packet)
        }
      }
    }
  }

  const buildLocalDescriptor = async (): Promise<{
    descriptor: PeerDescriptor
    roomId: string
  }> => {
    const id = await loadLocalCryptoIdentity()
    const userIdentity = getLocalUserIdentity
      ? await getLocalUserIdentity()
      : null
    syncSelfIdFromIdentity(id.peerId)

    const selfId = getSelfId()
    const signingRoomId = getRoomId()
    const descSeq = seq.nextDescSeq()
    const pktSeq = seq.peekPktSeq()
    const allDirect = [...getDirectPeerIds()]
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

    const descriptor = await signPeerDescriptor(
      {
        peerId: selfId,
        seq: descSeq,
        pktSeq,
        neighbors,
        signPubKey: id.signPubKey,
        encPubKey: id.encPubKey,
        ...(localRoleCert ? {cert: localRoleCert} : {})
      },
      id,
      appId,
      signingRoomId,
      password,
      userIdentity
    )
    return {descriptor, roomId: signingRoomId}
  }

  const runPublishLoop = async (
    promise: Promise<void>,
    resolve: () => void
  ): Promise<void> => {
    if (
      !isPublishAllowed() ||
      localPublishState.phase !== 'queued' ||
      localPublishState.promise !== promise
    ) {
      resolve()
      return
    }
    const token = Symbol()
    localPublishState = {phase: 'signing', token, promise, dirty: false}
    try {
      while (
        isPublishAllowed() &&
        localPublishState.phase === 'signing' &&
        localPublishState.token === token
      ) {
        localPublishState = {phase: 'signing', token, promise, dirty: false}
        const {descriptor: signedDescriptor, roomId: signedRoomId} =
          await buildLocalDescriptor()
        if (
          !isPublishAllowed() ||
          localPublishState.phase !== 'signing' ||
          localPublishState.token !== token
        ) {
          break
        }
        if (getRoomId() !== signedRoomId) {
          if (localPublishState.dirty || getDirectPeerCount() > 0) {
            continue
          }
          break
        }
        const selfId = getSelfId()
        localDescriptor = signedDescriptor
        lastLocalPublishAt = Date.now()
        if (selfId) {
          adjacency.set(selfId, new Set(signedDescriptor.neighbors))
        }
        onTopologyChanged()
        if (!localPublishState.dirty) {
          sendGossipToNeighbors([signedDescriptor])
          break
        }
      }
    } catch (err) {
      if (!isDestroyed()) {
        onError?.(err)
      }
    } finally {
      if (
        localPublishState.phase === 'signing' &&
        localPublishState.token === token
      ) {
        localPublishState = {phase: 'idle'}
      }
      resolve()
    }
  }

  const publishLocalDescriptor = (): Promise<void> => {
    if (!isPublishAllowed()) {
      return Promise.resolve()
    }
    switch (localPublishState.phase) {
      case 'queued':
        return localPublishState.promise
      case 'signing':
        localPublishState = {...localPublishState, dirty: true}
        return localPublishState.promise
      case 'idle': {
        const {promise, resolve} = Promise.withResolvers<void>()
        localPublishState = {phase: 'queued', promise}
        queueMicrotask(() => {
          void runPublishLoop(promise, resolve)
        })
        return promise
      }
      default:
        return unreachable(localPublishState)
    }
  }

  const flushPendingGossip = (): void => {
    if (gossipFlush === null) {
      return
    }
    cancelGossipFlush()
    const shouldRecompute = pendingTopologyDirty
    pendingTopologyDirty = false
    if (isDestroyed()) {
      pendingGossipDescriptors.clear()
      pendingGossipSources.clear()
      return
    }
    const batch = [...pendingGossipDescriptors.values()]
    const excludeId =
      pendingGossipSources.size === 1 ? [...pendingGossipSources][0] : undefined
    pendingGossipDescriptors.clear()
    pendingGossipSources.clear()
    if (shouldRecompute) {
      onTopologyChanged()
    }
    if (batch.length > 0) {
      sendGossipToNeighbors(batch, excludeId)
    }
  }

  const scheduleGossipFlush = (): void => {
    if (gossipFlush !== null || isDestroyed()) {
      return
    }
    if (getDescriptorCount() > 32 || getDiscoveredCandidateCount() > 32) {
      const handle = setTimeout(flushPendingGossip, 8)
      unrefTimer(handle)
      gossipFlush = handle
    } else {
      gossipFlush = 'microtask'
      queueMicrotask(flushPendingGossip)
    }
  }

  const isStaleOrLeftSeq = (id: string, descSeq: number): boolean => {
    const leftSeq = leftPeersSeq.get(id)
    return (
      (leftSeq !== undefined && descSeq <= leftSeq) ||
      (remoteDescriptors.get(id)?.descriptor.seq ?? 0) >= descSeq
    )
  }

  const applyVerifiedDescriptor = (
    fromPeerId: string,
    d: PeerDescriptor,
    isValid: boolean,
    expectedEpoch: number
  ): void => {
    if (
      expectedEpoch !== descriptorEpoch ||
      isDestroyed() ||
      !isValid ||
      d.peerId === getSelfId() ||
      isPeerBanned(d.peerId) ||
      isStaleOrLeftSeq(d.peerId, d.seq)
    ) {
      if (!isValid && !isDestroyed() && expectedEpoch === descriptorEpoch) {
        recordSenderInvalid(fromPeerId)
      }
      return
    }

    const latest = remoteDescriptors.get(d.peerId)?.descriptor
    if (!latest && !tryAdmitNewDescriptor(d, true)) {
      return
    }

    const encKeyRotated = Boolean(
      !latest ||
      (latest.encPubKey && d.encPubKey && latest.encPubKey !== d.encPubKey)
    )

    if (!latest && d.pktSeq && d.pktSeq > replaySeedCushionPackets) {
      seq.originReplay.seed(d.peerId, d.pktSeq - replaySeedCushionPackets)
    }

    const selfId = getSelfId()
    const wasMarkedLeft = leftPeersSeq.has(d.peerId)
    const prevAdj = adjacency.get(d.peerId)
    leftPeersSeq.delete(d.peerId)
    knownRoster.add(d.peerId)
    remoteDescriptors.set(d.peerId, {descriptor: d, receivedAt: Date.now()})
    const nextAdj = new Set(
      d.neighbors.filter(
        n =>
          !leftPeersSeq.has(n) &&
          !isPeerBanned(n) &&
          (n !== selfId || isDirectPeer(d.peerId))
      )
    )
    let adjChanged = !prevAdj || prevAdj.size !== nextAdj.size
    if (!adjChanged && prevAdj) {
      for (const n of nextAdj) {
        if (!prevAdj.has(n)) {
          adjChanged = true
          break
        }
      }
    }
    adjacency.set(d.peerId, nextAdj)
    if (wasMarkedLeft) {
      for (const [otherId, {descriptor: otherDesc}] of remoteDescriptors) {
        if (
          otherId !== d.peerId &&
          !leftPeersSeq.has(otherId) &&
          otherDesc.neighbors.includes(d.peerId)
        ) {
          addMapSet(adjacency, otherId, d.peerId)
          adjChanged = true
        }
      }
    }
    if (
      !latest ||
      wasMarkedLeft ||
      adjChanged ||
      encKeyRotated ||
      (!isDirectPeer(d.peerId) && !isVirtualPeer(d.peerId))
    ) {
      pendingTopologyDirty = true
    }

    if (
      pendingTopologyDirty &&
      (hasBufferedFramesForOrigin
        ? hasBufferedFramesForOrigin(d.peerId)
        : !latest)
    ) {
      flushPendingTopology()
    }
    onOriginDescriptorVerified(d.peerId, encKeyRotated)

    const prev = pendingGossipDescriptors.get(d.peerId)
    if (!prev || prev.seq < d.seq) {
      pendingGossipDescriptors.set(d.peerId, d)
    }
    pendingGossipSources.add(fromPeerId)
    scheduleGossipFlush()
  }

  const processDescriptorStep = (
    fromPeerId: string,
    d: PeerDescriptor
  ): void | Promise<void> => {
    if (
      isDestroyed() ||
      !d ||
      d.peerId === getSelfId() ||
      isPeerBanned(d.peerId) ||
      isStaleOrLeftSeq(d.peerId, d.seq)
    ) {
      return
    }
    const existing = remoteDescriptors.get(d.peerId)?.descriptor

    if (!hasValidDescriptorShape(d)) {
      failSig()
      recordSenderInvalid(fromPeerId)
      return
    }

    const expectedRoomId = getRoomId()
    const expectedEpoch = descriptorEpoch
    const descInFlightKey = `${expectedEpoch}\0${d.peerId}:${d.seq}:${d.sig}`
    const existingInFlight = inFlightDescriptors.get(descInFlightKey)
    if (!existingInFlight) {
      if (existing) {
        if (!descLimiter.consume(d.peerId)) {
          return
        }
      } else {
        if ((senderInvalidDescCounts.get(fromPeerId) ?? 0) >= 16) {
          return
        }
        if (!tryAdmitNewDescriptor(d, false)) {
          return
        }
      }
    }

    const verifyRes = existingInFlight ?? verifyDescriptor(d, expectedRoomId)
    if (typeof verifyRes === 'boolean') {
      applyVerifiedDescriptor(fromPeerId, d, verifyRes, expectedEpoch)
      return
    }

    const reservedUserKey =
      !existingInFlight &&
      !existing &&
      !isDirectPeer(d.peerId) &&
      maxUsers !== undefined
        ? (d.userId ?? d.peerId)
        : null
    if (reservedUserKey) {
      pendingUserAdmissions.set(
        reservedUserKey,
        (pendingUserAdmissions.get(reservedUserKey) ?? 0) + 1
      )
    }
    if (!existingInFlight) {
      inFlightDescriptors.set(descInFlightKey, verifyRes)
    }
    return verifyRes
      .then(isValid => {
        applyVerifiedDescriptor(fromPeerId, d, isValid, expectedEpoch)
      })
      .finally(() => {
        if (inFlightDescriptors.get(descInFlightKey) === verifyRes) {
          inFlightDescriptors.delete(descInFlightKey)
        }
        if (reservedUserKey && expectedEpoch === descriptorEpoch) {
          const next = (pendingUserAdmissions.get(reservedUserKey) ?? 1) - 1
          if (next <= 0) {
            pendingUserAdmissions.delete(reservedUserKey)
          } else {
            pendingUserAdmissions.set(reservedUserKey, next)
          }
        }
      })
  }

  const getSignPubKey = (peerId: string): string | undefined =>
    pinnedSignKeys.get(peerId) ?? getAnyDescriptor(peerId)?.signPubKey

  const isPinnedKeyMatch = (
    peerId: string,
    pubKey: JsonWebKey | string
  ): boolean => {
    const compact = toCompactPub(pubKey)
    if (!compact) {
      return false
    }
    const pinned = pinnedSignKeys.get(peerId)
    return !pinned || pinned === compact
  }

  const verifyControlLeave = async (
    leavingId: string,
    leaveSeq: number,
    sig: string,
    expectedRoomId: string
  ): Promise<boolean> => {
    const signPubKey = getSignPubKey(leavingId)
    if (!signPubKey || !isPinnedKeyMatch(leavingId, signPubKey)) {
      return failSig()
    }
    const ok = await verifyBase64Sig(
      sig,
      buildOverlaySignedBytes(
        canonicalLeaveHeader(leavingId, leaveSeq, appId, expectedRoomId),
        emptyBytes
      ),
      signPubKey
    )
    if (isDestroyed() || getRoomId() !== expectedRoomId) {
      return false
    }
    return ok ? true : failSig()
  }

  const baseHeartbeatMs = Math.max(
    200,
    Math.min(30_000, Math.floor(descriptorTtlMs / 3))
  )
  const heartbeatIntervalMs =
    baseHeartbeatMs >= 2_000
      ? baseHeartbeatMs +
        Math.floor(Math.random() * Math.floor(baseHeartbeatMs * 0.5))
      : baseHeartbeatMs
  const heartbeatTimer = setInterval(() => {
    if (isDestroyed()) {
      return
    }
    const now = Date.now()
    let expiredAny = false
    for (const [peerId, entry] of Array.from(remoteDescriptors.entries())) {
      if (!isDirectPeer(peerId) && now - entry.receivedAt > descriptorTtlMs) {
        markPeerLeft(peerId, entry.descriptor.seq)
        onEvictVirtualPeer(peerId, peerDisconnectedErr)
        expiredAny = true
      }
    }
    if (expiredAny) {
      onTopologyChanged()
    }
    if (
      isPublishAllowed() &&
      getDirectPeerCount() > 0 &&
      now - lastLocalPublishAt >= Math.floor(baseHeartbeatMs * 0.75)
    ) {
      void publishLocalDescriptor().catch(noOp)
    }
  }, heartbeatIntervalMs)
  unrefTimer(heartbeatTimer)

  return {
    hasDescriptor: peerId =>
      peerId === getSelfId()
        ? localDescriptor !== null
        : remoteDescriptors.has(peerId),
    getDescriptor: getAnyDescriptor,
    getDescriptorCount,
    getKnownRoster: () => knownRoster,
    addKnownPeer: peerId => {
      if (peerId) {
        knownRoster.add(peerId)
      }
    },
    deleteKnownPeer: peerId => {
      knownRoster.delete(peerId)
    },
    hasLeft: peerId => leftPeersSeq.has(peerId),
    markLeft: (peerId, seqVal) => {
      markPeerLeft(peerId, seqVal)
    },
    clearLeft: peerId => {
      leftPeersSeq.delete(peerId)
    },
    getAdjacency: () => adjacency,
    setLocalAdjacency: neighbors => {
      const selfId = getSelfId()
      if (selfId) {
        adjacency.set(selfId, new Set(neighbors))
      }
    },
    onDirectPeerDisconnected: peerId => {
      const selfId = getSelfId()
      if (selfId) {
        adjacency.get(selfId)?.delete(peerId)
        adjacency.get(peerId)?.delete(selfId)
      }
    },
    syncSelfIdChange: (prevSelfId, nextSelfId) => {
      if (prevSelfId) {
        knownRoster.delete(prevSelfId)
        adjacency.delete(prevSelfId)
      }
      if (localDescriptor && localDescriptor.peerId !== nextSelfId) {
        localDescriptor = null
        lastLocalPublishAt = 0
      }
      if (nextSelfId) {
        knownRoster.add(nextSelfId)
      }
    },
    resetForRoomIdChange: activeDirectPeerIds => {
      descriptorEpoch++
      cancelGossipFlush()
      pendingTopologyDirty = false
      pendingGossipDescriptors.clear()
      pendingGossipSources.clear()
      localDescriptor = null
      lastLocalPublishAt = 0
      if (localPublishState.phase === 'signing') {
        localPublishState = {...localPublishState, dirty: true}
      }
      remoteDescriptors.clear()
      leftPeersSeq.clear()
      descLimiter.clear()
      senderInvalidDescCounts.clear()
      inFlightDescriptors.clear()
      pendingUserAdmissions.clear()
      adjacency.clear()
      knownRoster.clear()
      const selfId = getSelfId()
      if (selfId) {
        knownRoster.add(selfId)
      }
      const directSet = new Set<string>()
      for (const directId of activeDirectPeerIds) {
        if (directId) {
          knownRoster.add(directId)
          directSet.add(directId)
        }
      }
      if (selfId) {
        adjacency.set(selfId, directSet)
      }
    },
    flushPendingTopology,
    hasConvergedComponent: () => {
      if (getDirectPeerCount() === 0) {
        return false
      }
      const selfId = getSelfId()
      for (const dId of getDirectPeerIds()) {
        if (!remoteDescriptors.has(dId)) {
          return false
        }
      }
      if (localDescriptor) {
        for (const nId of localDescriptor.neighbors) {
          if (
            nId !== selfId &&
            !leftPeersSeq.has(nId) &&
            !isPeerBanned(nId) &&
            !remoteDescriptors.has(nId)
          ) {
            return false
          }
        }
      }
      for (const {descriptor: desc} of remoteDescriptors.values()) {
        for (const nId of desc.neighbors) {
          if (
            nId !== selfId &&
            !leftPeersSeq.has(nId) &&
            !isPeerBanned(nId) &&
            !remoteDescriptors.has(nId)
          ) {
            return false
          }
        }
      }
      return true
    },
    hasConvergedDirectMesh: () => {
      if (getDirectPeerCount() === 0) {
        return false
      }
      const selfId = getSelfId()
      for (const dId of getDirectPeerIds()) {
        const desc = remoteDescriptors.get(dId)?.descriptor
        if (!desc) {
          return false
        }
        for (const nId of desc.neighbors) {
          if (
            nId !== selfId &&
            !isDirectPeer(nId) &&
            !leftPeersSeq.has(nId) &&
            !isPeerBanned(nId)
          ) {
            return false
          }
        }
      }
      return true
    },
    getSignPubKey,
    isPinnedKeyMatch,
    setPeerSignPublicKey: (peerId, pubKey) => {
      if (isDestroyed()) {
        return
      }
      const compact = toCompactPub(pubKey)
      if (!isValidSignalPeerId(peerId) || !compact) {
        return
      }
      const existing = pinnedSignKeys.get(peerId)
      if (existing !== undefined) {
        return
      }
      const commitKey = (ok: boolean): void => {
        if (!ok || isDestroyed()) {
          return
        }
        const latest = pinnedSignKeys.get(peerId)
        if (!latest) {
          pinnedSignKeys.set(peerId, compact)
        }
      }
      const res = verifyPeerIdKey(peerId, compact)
      if (typeof res === 'boolean') {
        commitKey(res)
      } else {
        void res.then(commitKey).catch(noOp)
      }
    },
    setLocalRoleCertificate: cert => {
      localRoleCert = cert
      if (getDirectPeerCount() > 0) {
        void publishLocalDescriptor().catch(noOp)
      }
    },
    touchOriginActivity: originPeerId => {
      const entry = remoteDescriptors.get(originPeerId)
      if (entry) {
        entry.receivedAt = Date.now()
      }
    },
    publishLocalDescriptor,
    sendInitialKnownDescriptors: peerId => {
      const initialKnownIds = new Set<string>()
      for (const remoteId of remoteDescriptors.keys()) {
        if (remoteId !== peerId) {
          initialKnownIds.add(remoteId)
        }
      }
      void publishLocalDescriptor()
        .then(() => {
          if (isDestroyed() || !initialKnownIds.size) {
            return
          }
          const initialKnown: PeerDescriptor[] = []
          for (const knownId of initialKnownIds) {
            const d = remoteDescriptors.get(knownId)?.descriptor
            if (d) {
              initialKnown.push(d)
            }
          }
          for (const packet of packGossipControlFrames(initialKnown)) {
            sendToDirectNeighbor(peerId, packet)
          }
        })
        .catch(noOp)
    },
    dispatchControlMessage: (fromPeerId, msg) => {
      if (isDestroyed() || !msg || typeof msg !== 'object') {
        return
      }
      const selfId = getSelfId()

      if (msg.t === 'leave') {
        const leavingId = msg.peerId
        if (!isValidSignalPeerId(leavingId) || leavingId === selfId) {
          return
        }
        if (!isPosSafeInt(msg.seq) || !isStr(msg.sig)) {
          failSig()
          return
        }
        const existingDesc = remoteDescriptors.get(leavingId)?.descriptor
        const prevLeftSeq = leftPeersSeq.get(leavingId)
        if (
          (existingDesc && msg.seq < existingDesc.seq) ||
          (prevLeftSeq !== undefined && msg.seq <= prevLeftSeq)
        ) {
          return
        }
        const knownKey = getSignPubKey(leavingId)
        if (!knownKey || !isPinnedKeyMatch(leavingId, knownKey)) {
          failSig()
          return
        }
        const leaveSeq = msg.seq
        const leaveSig = msg.sig
        const expectedRoomId = getRoomId()
        const expectedEpoch = descriptorEpoch
        seq.enqueuePeerTask(`ctrl:${fromPeerId}`, async () => {
          if (
            isDestroyed() ||
            expectedEpoch !== descriptorEpoch ||
            getRoomId() !== expectedRoomId
          ) {
            return
          }
          const curDesc = remoteDescriptors.get(leavingId)?.descriptor
          const curLeftSeq = leftPeersSeq.get(leavingId)
          if (
            (curDesc && leaveSeq < curDesc.seq) ||
            (curLeftSeq !== undefined && leaveSeq <= curLeftSeq)
          ) {
            return
          }
          const valid = await verifyControlLeave(
            leavingId,
            leaveSeq,
            leaveSig,
            expectedRoomId
          )
          if (
            !valid ||
            isDestroyed() ||
            expectedEpoch !== descriptorEpoch ||
            getRoomId() !== expectedRoomId
          ) {
            return
          }
          markPeerLeft(leavingId, leaveSeq)
          onEvictVirtualPeer(leavingId, peerLeftRoomErr)
          onTopologyChanged()
          const fwd = packOverlayControl(msg)
          for (const neighborId of getDirectPeerIds()) {
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
          seq.enqueuePeerTask(`ctrl:${fromPeerId}`, () =>
            Promise.resolve(processDescriptorStep(fromPeerId, desc))
          )
        }
      }
    },
    purgePeer: peerId => {
      purgeActiveRemoteDescriptor(peerId)
      pendingGossipDescriptors.delete(peerId)
      descLimiter.delete(peerId)
      senderInvalidDescCounts.delete(peerId)
    },
    destroy: () => {
      descriptorEpoch++
      resetTimer(heartbeatTimer)
      cancelGossipFlush()
      pendingTopologyDirty = false
      localPublishState = {phase: 'idle'}
      localDescriptor = null
      lastLocalPublishAt = 0
      remoteDescriptors.clear()
      adjacency.clear()
      knownRoster.clear()
      pinnedSignKeys.clear()
      leftPeersSeq.clear()
      descLimiter.clear()
      senderInvalidDescCounts.clear()
      inFlightDescriptors.clear()
      pendingUserAdmissions.clear()
      pendingGossipDescriptors.clear()
      pendingGossipSources.clear()
    }
  }
}
