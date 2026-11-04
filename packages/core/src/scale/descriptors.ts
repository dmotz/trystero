import {verifyRoomAuth} from '../crypto'
import {
  pubJwkToUncompressedBytes,
  toCompactPub,
  verifyPeerIdKey,
  verifyUserEndpointProof
} from '../identity'
import type {MaybePromise} from '../internal-types'
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

const maxVerifiedDescriptors = 2_048
const maxPeersPerUser = 16
const maxGossipEntriesPerFrame = 64
const replaySeedCushionPackets = 32
const emptyBytes = /*@__PURE__*/ new Uint8Array(0)

export type DescriptorStoreDeps = {
  appId: string
  password: string
  descriptorTtlMs: number
  maxUsers?: number | undefined
  seq: OverlaySequencer
  isDestroyed: () => boolean
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
    onPeerDescriptorCert,
    onError
  } = deps

  const descriptors = new Map<string, PeerDescriptor>()
  const descriptorReceivedAt = new Map<string, number>()
  const adjacency = new Map<string, Set<string>>()
  const initialSelf = getSelfId()
  const knownRoster = new Set<string>(initialSelf ? [initialSelf] : [])
  const pinnedSignKeys = createBoundedCache<string, string>(
    maxVerifiedDescriptors
  )
  const leftPeersSeq = createBoundedCache<string, number>(1_024)
  const descLimiter = createTokenBucketLimiter(8, 16, maxVerifiedDescriptors)
  const senderInvalidDescCounts = createBoundedCache<string, number>(512)
  const inFlightDescriptors = new Map<string, Promise<boolean>>()
  const pendingUserAdmissions = new Map<string, number>()

  let localRoleCert: RoleCertificate | null = null
  let pendingPublishPromise: Promise<void> | null = null
  let publishDirty = false

  const pendingGossipDescriptors = new Map<string, PeerDescriptor>()
  const pendingGossipSources = new Set<string>()
  let gossipFlushScheduled = false
  let pendingTopologyDirty = false

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

  const findEvictable = (
    now: number,
    limit: number,
    filter?: (d: PeerDescriptor) => boolean
  ): string | null | false => {
    const selfId = getSelfId()
    let count = 0
    let oldestId: string | null = null
    let oldestTime = Infinity
    for (const d of descriptors.values()) {
      if (!filter || filter(d)) {
        count++
        if (d.peerId !== selfId && !isDirectPeer(d.peerId)) {
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

  const canAdmitWithinUserLimit = (d: PeerDescriptor, now: number): boolean => {
    if (maxUsers === undefined) {
      return true
    }
    const selfId = getSelfId()
    const activeIdentityKeys = new Set<string>([
      getLocalUserId() ??
        descriptors.get(selfId)?.userId ??
        (selfId || '__self__')
    ])
    for (const directId of getDirectPeerIds()) {
      activeIdentityKeys.add(descriptors.get(directId)?.userId ?? directId)
    }
    for (const [descPeerId, existingDesc] of descriptors.entries()) {
      if (descPeerId === selfId) {
        continue
      }
      const receivedAt = descriptorReceivedAt.get(descPeerId) ?? 0
      if (isDirectPeer(descPeerId) || now - receivedAt <= descriptorTtlMs) {
        activeIdentityKeys.add(existingDesc.userId ?? descPeerId)
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
      descriptors.size < maxVerifiedDescriptors
        ? null
        : findEvictable(now, maxVerifiedDescriptors)
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
    d: PeerDescriptor & {signPubKey: string; sig: string}
  ): boolean | Promise<boolean> => {
    const curRoomId = getRoomId()
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
    for (const neighborId of getDirectPeerIds()) {
      if (neighborId !== excludePeerId) {
        for (const packet of packets) {
          sendToDirectNeighbor(neighborId, packet)
        }
      }
    }
  }

  const buildLocalDescriptor = async (): Promise<PeerDescriptor> => {
    const id = await loadLocalCryptoIdentity()
    const userIdentity = getLocalUserIdentity
      ? await getLocalUserIdentity()
      : null
    syncSelfIdFromIdentity(id.peerId)

    publishDirty = false
    const selfId = getSelfId()
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

    return signPeerDescriptor(
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
      getRoomId(),
      password,
      userIdentity
    )
  }

  const publishLocalDescriptor = (): Promise<void> => {
    if (isDestroyed()) {
      return Promise.resolve()
    }
    publishDirty = true
    if (!pendingPublishPromise) {
      pendingPublishPromise = new Promise<void>(resolve => {
        queueMicrotask(() => {
          void (async () => {
            try {
              while (publishDirty && !isDestroyed()) {
                const signedDescriptor = await buildLocalDescriptor()
                if (isDestroyed()) {
                  break
                }
                const selfId = getSelfId()
                descriptors.set(selfId, signedDescriptor)
                descriptorReceivedAt.set(selfId, Date.now())
                adjacency.set(selfId, new Set(signedDescriptor.neighbors))
                onTopologyChanged()
                if (!publishDirty) {
                  sendGossipToNeighbors([signedDescriptor])
                }
              }
            } catch (err) {
              if (!isDestroyed()) {
                onError?.(err)
              }
            } finally {
              pendingPublishPromise = null
              resolve()
            }
          })()
        })
      })
    }
    return pendingPublishPromise
  }

  const flushPendingGossip = (): void => {
    gossipFlushScheduled = false
    const shouldRecompute = pendingTopologyDirty
    pendingTopologyDirty = false
    if (isDestroyed()) {
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
    sendGossipToNeighbors(batch, excludeId)
  }

  const applyVerifiedDescriptor = (
    fromPeerId: string,
    d: PeerDescriptor,
    isValid: boolean
  ): void => {
    if (!isValid || isDestroyed() || isPeerBanned(d.peerId)) {
      if (!isValid && !isDestroyed()) {
        recordSenderInvalid(fromPeerId)
      }
      return
    }

    const latest = descriptors.get(d.peerId)
    if (latest && latest.seq >= d.seq) {
      return
    }

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
    descriptors.set(d.peerId, d)
    descriptorReceivedAt.set(d.peerId, Date.now())
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
      for (const [otherId, otherDesc] of descriptors.entries()) {
        if (
          otherId !== selfId &&
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

    onOriginDescriptorVerified(d.peerId, encKeyRotated)

    const prev = pendingGossipDescriptors.get(d.peerId)
    if (!prev || prev.seq < d.seq) {
      pendingGossipDescriptors.set(d.peerId, d)
    }
    pendingGossipSources.add(fromPeerId)
    if (!gossipFlushScheduled) {
      gossipFlushScheduled = true
      if (descriptors.size > 32 || getDiscoveredCandidateCount() > 32) {
        unrefTimer(setTimeout(flushPendingGossip, 8))
      } else {
        queueMicrotask(flushPendingGossip)
      }
    }
  }

  const isStaleOrLeftSeq = (id: string, descSeq: number): boolean => {
    const leftSeq = leftPeersSeq.get(id)
    return (
      (leftSeq !== undefined && descSeq <= leftSeq) ||
      (descriptors.get(id)?.seq ?? 0) >= descSeq
    )
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

    const verifyRes = existingInFlight ?? verifyDescriptor(d)
    if (typeof verifyRes === 'boolean') {
      applyVerifiedDescriptor(fromPeerId, d, verifyRes)
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
        applyVerifiedDescriptor(fromPeerId, d, isValid)
      })
      .finally(() => {
        if (inFlightDescriptors.get(descInFlightKey) === verifyRes) {
          inFlightDescriptors.delete(descInFlightKey)
        }
        if (reservedUserKey) {
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
    pinnedSignKeys.get(peerId) ?? descriptors.get(peerId)?.signPubKey

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
    sig: string
  ): Promise<boolean> => {
    const signPubKey = getSignPubKey(leavingId)
    if (!signPubKey || !isPinnedKeyMatch(leavingId, signPubKey)) {
      return failSig()
    }
    const ok = await verifyBase64Sig(
      sig,
      buildOverlaySignedBytes(
        canonicalLeaveHeader(leavingId, leaveSeq, appId, getRoomId()),
        emptyBytes
      ),
      signPubKey
    )
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
    const selfId = getSelfId()
    const now = Date.now()
    let expiredAny = false
    for (const [peerId, receivedAt] of descriptorReceivedAt.entries()) {
      if (
        peerId !== selfId &&
        !isDirectPeer(peerId) &&
        now - receivedAt > descriptorTtlMs
      ) {
        const desc = descriptors.get(peerId)
        if (desc) {
          leftPeersSeq.set(peerId, desc.seq)
        }
        onEvictVirtualPeer(peerId, peerDisconnectedErr)
        expiredAny = true
      }
    }
    if (expiredAny) {
      onTopologyChanged()
    }
    const lastOwnPublishAt = descriptorReceivedAt.get(selfId) ?? 0
    if (
      getDirectPeerCount() > 0 &&
      now - lastOwnPublishAt >= Math.floor(baseHeartbeatMs * 0.75)
    ) {
      void publishLocalDescriptor().catch(noOp)
    }
  }, heartbeatIntervalMs)
  unrefTimer(heartbeatTimer)

  return {
    hasDescriptor: peerId => descriptors.has(peerId),
    getDescriptor: peerId => descriptors.get(peerId),
    getDescriptorCount: () => descriptors.size,
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
      leftPeersSeq.set(peerId, seqVal ?? descriptors.get(peerId)?.seq ?? 0)
    },
    clearLeft: peerId => {
      leftPeersSeq.delete(peerId)
    },
    getAdjacency: () => adjacency,
    setLocalAdjacency: neighbors => {
      adjacency.set(getSelfId(), new Set(neighbors))
    },
    hasConvergedComponent: () => {
      if (getDirectPeerCount() === 0) {
        return false
      }
      const selfId = getSelfId()
      for (const dId of getDirectPeerIds()) {
        if (!descriptors.has(dId)) {
          return false
        }
      }
      for (const desc of descriptors.values()) {
        for (const nId of desc.neighbors) {
          if (
            nId !== selfId &&
            !leftPeersSeq.has(nId) &&
            !isPeerBanned(nId) &&
            !descriptors.has(nId)
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
        const desc = descriptors.get(dId)
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
      const compact = toCompactPub(pubKey)
      if (!isValidSignalPeerId(peerId) || !compact) {
        return
      }
      const commitKey = (ok: boolean): void => {
        if (ok) {
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
      if (descriptors.has(originPeerId)) {
        descriptorReceivedAt.set(originPeerId, Date.now())
      }
    },
    publishLocalDescriptor,
    sendInitialKnownDescriptors: peerId => {
      const selfId = getSelfId()
      const initialKnownIds = new Set<string>()
      for (const d of descriptors.values()) {
        if (d.peerId !== selfId && d.peerId !== peerId) {
          initialKnownIds.add(d.peerId)
        }
      }
      void publishLocalDescriptor()
        .then(() => {
          if (isDestroyed() || !initialKnownIds.size) {
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
        const existingDesc = descriptors.get(leavingId)
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
        seq.enqueuePeerTask(`ctrl:${fromPeerId}`, async () => {
          if (isDestroyed()) {
            return
          }
          const curDesc = descriptors.get(leavingId)
          const curLeftSeq = leftPeersSeq.get(leavingId)
          if (
            (curDesc && leaveSeq < curDesc.seq) ||
            (curLeftSeq !== undefined && leaveSeq <= curLeftSeq)
          ) {
            return
          }
          const valid = await verifyControlLeave(leavingId, leaveSeq, leaveSig)
          if (!valid || isDestroyed()) {
            return
          }
          leftPeersSeq.set(
            leavingId,
            Math.max(leaveSeq, descriptors.get(leavingId)?.seq ?? 0)
          )
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
      descriptors.delete(peerId)
      descriptorReceivedAt.delete(peerId)
      descLimiter.delete(peerId)
      senderInvalidDescCounts.delete(peerId)
      adjacency.delete(peerId)
      knownRoster.delete(peerId)
      for (const set of adjacency.values()) {
        set.delete(peerId)
      }
    },
    destroy: () => {
      resetTimer(heartbeatTimer)
      descriptors.clear()
      descriptorReceivedAt.clear()
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
