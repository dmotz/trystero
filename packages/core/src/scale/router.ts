import {inspectActionWireHeader} from '../action-wire'
import {canonicalizePubJwk} from '../identity'
import type {PeerDataTransport} from '../peer-registry'
import {isValidSignalPeerId} from '../signal-handler'
import {createSlidingReplayWindow} from '../signed-record'
import {
  authMetaKey,
  createBoundedCache,
  createBoundedSet,
  genId,
  keys,
  noOp,
  peerDisconnectedErr,
  toBase64
} from '../utils'
import type {
  PeerHandle,
  RoleCertificate,
  TopologyRoute,
  TopologyStats
} from '../types'
import {
  buildOverlaySignedBytes,
  canonicalBroadcastHeader,
  canonicalUnicastHeader,
  canonicalUnicastLeaseHeader,
  createPairwiseKeyCache,
  decryptUnicastPayload,
  encryptUnicastPayload,
  isValidOverlayMsgId,
  overlayBroadcastKind,
  overlayUnicastKind,
  packOverlayBinary,
  parseUnicastLease,
  signOverlayPayload,
  unpackOverlayBinary,
  verifyBase64Sig,
  type BroadcastEnvelopeHeader,
  type CryptoIdentity,
  type OriginTaskQueue,
  type PeerDescriptor,
  type UnicastEnvelopeHeader,
  type UnicastLeaseTuple
} from './crypto-frame'
import {maxAllowedHops} from './topology'
import {
  createVirtualTransportFactory,
  getPeerBufferedBytes,
  isPeerUsable
} from './virtual-transport'

export {getPeerBufferedBytes, isPeerUsable} from './virtual-transport'

const nextHopCongestionBytes = 256 * 1024
const unicastLeaseWindowPackets = 256
const maxTrackedOrigins = 2_048
const maxBufferedEarlyBroadcastOrigins = 64
const maxBufferedEarlyBroadcastsPerOrigin = 8

export type OverlayRouterDeps = {
  appId: string
  stats: TopologyStats
  getSelfId: () => string
  syncSelfIdFromIdentity: (peerId: string) => void
  getRoomId: () => string
  isDestroyed: () => boolean
  isOverlayActive: () => boolean
  getActiveMode: () => 'mesh' | 'gossip'
  currentMaxHops: () => number
  nextPktSeq: () => number
  directPeers: Map<string, PeerHandle>
  virtualTransports: Map<string, PeerDataTransport>
  bannedPeers: Set<string>
  descriptors: Map<string, PeerDescriptor>
  pinnedSignKeys: Map<string, string>
  isLeftPeer: (peerId: string) => boolean
  getPeerSignPublicKey: (peerId: string) => JsonWebKey | undefined
  touchOriginActivity: (origin: string) => void
  getRoutes: () => Record<string, TopologyRoute>
  getLocalCryptoIdentity: () => Promise<CryptoIdentity>
  requireDirectPeer: (peerId: string) => void
  ensureOriginVirtualPeer: (origin: string, fromPeerId: string) => boolean
  onDeliverData: (originPeerId: string, data: ArrayBuffer) => void
  actionAuthorities: Map<string, string[]>
  originTasks: OriginTaskQueue
  canPeerSendAction?:
    | ((
        peerId: string,
        requiredRoles: readonly string[],
        inlineCert?: RoleCertificate
      ) => Promise<boolean> | boolean)
    | undefined
}

export type OverlayRouter = {
  resolveHealthyNextHopId: (
    destPeerId: string,
    excludePeerId?: string
  ) => string | undefined
  sendToDirectNeighbor: (peerId: string, frame: Uint8Array) => boolean
  signUnicastOrBroadcast: (
    canonicalHeader: string,
    payload: Uint8Array
  ) => Promise<string>
  verifyUnicastOrBroadcast: (
    originPeerId: string,
    canonicalHeader: string,
    payload: Uint8Array,
    sig: string | undefined
  ) => Promise<boolean>
  broadcastInline: (
    frame: Uint8Array,
    onProgress?: (peerId: string) => void
  ) => Promise<boolean>
  sendUnicast: (targetPeerId: string, frame: Uint8Array) => void
  createVirtualTransport: (peerId: string) => PeerDataTransport
  flushBufferedBroadcasts: (origin: string) => void
  dispatchBinaryFrame: (fromPeerId: string, bytes: Uint8Array) => void
  onEncPubKeyRotated: (peerId: string) => void
  purgePeerState: (peerId: string) => void
  resetRoomCryptoState: () => void
  destroy: () => void
}

export const createOverlayRouter = (deps: OverlayRouterDeps): OverlayRouter => {
  const {
    appId,
    stats,
    getSelfId,
    getRoomId,
    isDestroyed,
    isOverlayActive,
    directPeers,
    virtualTransports,
    bannedPeers,
    descriptors,
    pinnedSignKeys,
    isLeftPeer,
    touchOriginActivity,
    getRoutes,
    getLocalCryptoIdentity,
    ensureOriginVirtualPeer,
    onDeliverData
  } = deps

  const originReplay = createSlidingReplayWindow(
    maxTrackedOrigins,
    k => directPeers.has(k) || descriptors.has(k)
  )
  const relayLeaseReplay = createSlidingReplayWindow(maxTrackedOrigins)
  const seenMsgIds = createBoundedSet<string>(4_096)
  const pairwiseKeys = createPairwiseKeyCache(
    appId,
    getRoomId,
    getSelfId,
    getLocalCryptoIdentity,
    peerId => descriptors.get(peerId)?.encPubKey
  )
  const outboundUnicastLeases = new Map<
    string,
    {lo: number; hi: number; sig: string}
  >()
  const outboundUnicastQueues = new Map<string, Promise<void>>()
  const outboundQueueDepth = new Map<string, number>()
  const lastUnicastSeqByTarget = new Map<string, number>()
  const pendingEarlyBroadcasts = createBoundedCache<
    string,
    Array<{fromPeerId: string; payload: ArrayBuffer}>
  >(maxBufferedEarlyBroadcastOrigins)

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
    const route = getRoutes()[destPeerId]
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

  const signUnicastOrBroadcast = async (
    canonicalHeader: string,
    payload: Uint8Array
  ): Promise<string> => {
    const id = await getLocalCryptoIdentity()
    deps.syncSelfIdFromIdentity(id.peerId)
    return signOverlayPayload(id.signPrivateKey, canonicalHeader, payload)
  }

  const verifyUnicastOrBroadcast = async (
    originPeerId: string,
    canonicalHeader: string,
    payload: Uint8Array,
    sig: string | undefined
  ): Promise<boolean> => {
    const signPubJwk = sig ? deps.getPeerSignPublicKey(originPeerId) : undefined
    if (!sig || !signPubJwk) {
      stats.signatureFailures++
      return false
    }
    const pinned = pinnedSignKeys.get(originPeerId)
    if (pinned && pinned !== canonicalizePubJwk(signPubJwk)) {
      stats.signatureFailures++
      return false
    }

    const combined = buildOverlaySignedBytes(canonicalHeader, payload)
    const ok = await verifyBase64Sig(sig, combined, signPubJwk)
    if (!ok) {
      stats.signatureFailures++
      return false
    }
    return true
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
      if (neighborId !== fromPeerId && neighborId !== originPeerId) {
        if (sendToDirectNeighbor(neighborId, packet)) {
          sentCount++
        }
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
      (deps.getActiveMode() === 'mesh' && virtualTransports.size === 0)
    ) {
      return false
    }

    let hasUsableNeighbor = false
    for (const peer of directPeers.values()) {
      if (isPeerUsable(peer)) {
        hasUsableNeighbor = true
        break
      }
    }
    if (
      !hasUsableNeighbor &&
      (directPeers.size > 0 || virtualTransports.size > 0)
    ) {
      return false
    }

    const selfId = getSelfId()
    const roomId = getRoomId()
    const seq = deps.nextPktSeq()
    const msgId = `${selfId}:${seq}:${genId(8)}`
    originReplay.record(selfId, seq)
    seenMsgIds.add(msgId)

    const canonical = canonicalBroadcastHeader(
      selfId,
      msgId,
      seq,
      appId,
      roomId
    )
    const sig = await signUnicastOrBroadcast(canonical, frame)
    const header: BroadcastEnvelopeHeader = {
      o: selfId,
      q: seq,
      m: msgId,
      ...(sig ? {s: sig} : {})
    }

    const sentCount = forwardBroadcastPacket(
      selfId,
      deps.currentMaxHops(),
      header,
      frame
    )
    if (
      sentCount === 0 &&
      (directPeers.size > 0 || virtualTransports.size > 0)
    ) {
      return false
    }
    stats.messagesSent++

    if (onProgress) {
      const allRoomPeers = new Set([
        ...directPeers.keys(),
        ...keys(getRoutes())
      ])
      for (const peerId of allRoomPeers) {
        if (resolveHealthyNextHopId(peerId)) {
          onProgress(peerId)
        }
      }
    }

    return true
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

    const route = getRoutes()[destPeerId]
    if (
      route &&
      route.nextHop !== excludePeerId &&
      route.nextHop !== preferredHop &&
      sendToDirectNeighbor(route.nextHop, packet)
    ) {
      return true
    }

    if (
      route?.backupNextHop &&
      route.backupNextHop !== excludePeerId &&
      route.backupNextHop !== preferredHop &&
      sendToDirectNeighbor(route.backupNextHop, packet)
    ) {
      return true
    }

    return false
  }

  const sendUnicastInternal = (
    targetPeerId: string,
    frame: Uint8Array,
    options?: {
      forceOverlay?: boolean
      pinnedHopId?: string
      promoteDirect?: boolean
      strict?: boolean
    }
  ): void => {
    if (isDestroyed()) {
      if (options?.strict) {
        throw peerDisconnectedErr
      }
      return
    }

    const hasPendingQueue = (outboundQueueDepth.get(targetPeerId) ?? 0) > 0
    if (
      !options?.forceOverlay &&
      !hasPendingQueue &&
      directPeers.has(targetPeerId)
    ) {
      if (sendToDirectNeighbor(targetPeerId, frame)) {
        stats.messagesSent++
        return
      }
    }

    if (options?.promoteDirect) {
      deps.requireDirectPeer(targetPeerId)
    }

    const pairwiseKeyP = pairwiseKeys.get(targetPeerId)
    if (!pairwiseKeyP || !resolveHealthyNextHopId(targetPeerId)) {
      if (options?.strict) {
        throw peerDisconnectedErr
      }
      return
    }

    const selfId = getSelfId()
    const roomId = getRoomId()
    const seq = deps.nextPktSeq()
    const prevTargetSeq = lastUnicastSeqByTarget.get(targetPeerId)
    lastUnicastSeqByTarget.set(targetPeerId, seq)
    const useStreamLease =
      Boolean(options?.promoteDirect || options?.forceOverlay) ||
      (prevTargetSeq !== undefined &&
        seq - prevTargetSeq <= unicastLeaseWindowPackets)

    const msgId = `${selfId}:${seq}:${genId(8)}`
    originReplay.record(selfId, seq)
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
        if (isDestroyed()) {
          return
        }
        let payloadToSend: Uint8Array
        let ivB64: string
        let canonical: string

        const latestKeyP = pairwiseKeys.get(targetPeerId) ?? pairwiseKeyP
        try {
          const aesKey = await latestKeyP
          const iv = crypto.getRandomValues(new Uint8Array(12))
          ivB64 = toBase64(iv)
          canonical = canonicalUnicastHeader(
            selfId,
            targetPeerId,
            msgId,
            ivB64,
            seq,
            appId,
            roomId
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

        let header: UnicastEnvelopeHeader
        let activeLease = outboundUnicastLeases.get(targetPeerId)
        if (
          useStreamLease ||
          (activeLease && seq >= activeLease.lo && seq <= activeLease.hi)
        ) {
          if (!activeLease || seq < activeLease.lo || seq > activeLease.hi) {
            const lo = seq
            const hi = seq + unicastLeaseWindowPackets - 1
            const leaseSig = await signUnicastOrBroadcast(
              canonicalUnicastLeaseHeader(
                selfId,
                targetPeerId,
                lo,
                hi,
                appId,
                roomId
              ),
              new Uint8Array()
            )
            activeLease = {lo, hi, sig: leaseSig}
            outboundUnicastLeases.set(targetPeerId, activeLease)
          }
          if (isDestroyed()) {
            return
          }
          header = {
            o: selfId,
            d: targetPeerId,
            q: seq,
            m: msgId,
            iv: ivB64,
            l: [activeLease.lo, activeLease.hi, activeLease.sig]
          }
        } else {
          const sig = await signUnicastOrBroadcast(canonical, payloadToSend)
          if (isDestroyed()) {
            return
          }
          header = {
            o: selfId,
            d: targetPeerId,
            q: seq,
            m: msgId,
            iv: ivB64,
            s: sig
          }
        }
        const packet = packOverlayBinary(
          overlayUnicastKind,
          deps.currentMaxHops(),
          header,
          payloadToSend
        )
        if (
          routeUnicastPacket(
            targetPeerId,
            packet,
            undefined,
            options?.pinnedHopId
          )
        ) {
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

  const createVirtualTransport = createVirtualTransportFactory({
    directPeers,
    virtualTransports,
    bannedPeers,
    isDestroyed,
    isLeftPeer,
    resolveHealthyNextHopId,
    getOutboundQueueState: peerId => ({
      depth: outboundQueueDepth.get(peerId) ?? 0,
      tail: outboundUnicastQueues.get(peerId)
    }),
    sendUnicastInternal
  })

  const flushBufferedBroadcasts = (origin: string): void => {
    const buffered = pendingEarlyBroadcasts.get(origin)
    if (!buffered || buffered.length === 0) {
      return
    }
    pendingEarlyBroadcasts.delete(origin)
    for (const item of buffered) {
      if (isDestroyed() || bannedPeers.has(origin) || isLeftPeer(origin)) {
        break
      }
      stats.messagesReceived++
      onDeliverData(origin, item.payload)
    }
  }

  const handleOverlayBinary = async (
    fromPeerId: string,
    parsed: NonNullable<ReturnType<typeof unpackOverlayBinary>>
  ): Promise<void> => {
    if (isDestroyed()) {
      return
    }

    const {kind, ttl: rawTtl, header, payload} = parsed
    const ttl = Math.min(rawTtl, maxAllowedHops)
    const selfId = getSelfId()
    const roomId = getRoomId()

    if (kind === overlayBroadcastKind) {
      const origin = typeof header['o'] === 'string' ? header['o'] : ''
      const seq = typeof header['q'] === 'number' ? header['q'] : Number.NaN
      const msgId = typeof header['m'] === 'string' ? header['m'] : ''
      const sig = typeof header['s'] === 'string' ? header['s'] : undefined

      if (
        !isValidSignalPeerId(origin) ||
        !msgId ||
        origin === selfId ||
        isLeftPeer(origin)
      ) {
        return
      }

      if (
        !isValidOverlayMsgId(msgId) ||
        !Number.isSafeInteger(seq) ||
        seq < 1 ||
        bannedPeers.has(origin) ||
        bannedPeers.has(fromPeerId)
      ) {
        stats.signatureFailures++
        return
      }

      if (originReplay.has(origin, seq) || seenMsgIds.has(msgId)) {
        stats.duplicatesDropped++
        return
      }

      const valid = await verifyUnicastOrBroadcast(
        origin,
        canonicalBroadcastHeader(origin, msgId, seq, appId, roomId),
        payload,
        sig
      )
      if (!valid || isDestroyed() || isLeftPeer(origin)) {
        return
      }

      const wireHeader = inspectActionWireHeader(payload)
      if (wireHeader) {
        const requiredRoles = deps.actionAuthorities.get(wireHeader.type)
        if (
          requiredRoles &&
          requiredRoles.length > 0 &&
          deps.canPeerSendAction
        ) {
          const metaObj =
            wireHeader.metadata && typeof wireHeader.metadata === 'object'
              ? (wireHeader.metadata as Record<string, unknown>)
              : undefined
          const authEnv = metaObj?.[authMetaKey] as
            | {cert?: RoleCertificate}
            | undefined
          const allowed = await deps.canPeerSendAction(
            origin,
            requiredRoles,
            authEnv?.cert
          )
          if (!allowed || isDestroyed()) {
            stats.signatureFailures++
            return
          }
        }
      }

      if (!originReplay.record(origin, seq) || !seenMsgIds.add(msgId)) {
        stats.duplicatesDropped++
        return
      }

      touchOriginActivity(origin)

      // Only activate a virtual peer once we have its PeerDescriptor (encPubKey),
      // preventing premature onPeerJoin before E2EE unicast replies can be encrypted.
      const canDeliverImmediately =
        directPeers.has(origin) ||
        virtualTransports.has(origin) ||
        Boolean(descriptors.get(origin)?.encPubKey)

      if (canDeliverImmediately) {
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
          queue.push({fromPeerId, payload: payload.slice().buffer})
        }
      }

      if (ttl > 1) {
        const forwardedCount = forwardBroadcastPacket(
          origin,
          ttl - 1,
          {o: origin, q: seq, m: msgId, ...(sig ? {s: sig} : {})},
          payload,
          fromPeerId
        )
        if (forwardedCount > 0) {
          stats.messagesForwarded++
        }
      }
      return
    }

    if (kind === overlayUnicastKind) {
      const origin = typeof header['o'] === 'string' ? header['o'] : ''
      const dest = typeof header['d'] === 'string' ? header['d'] : ''
      const seq = typeof header['q'] === 'number' ? header['q'] : Number.NaN
      const msgId = typeof header['m'] === 'string' ? header['m'] : ''
      const ivB64 = typeof header['iv'] === 'string' ? header['iv'] : undefined
      const sig = typeof header['s'] === 'string' ? header['s'] : undefined
      const rawLease = header['l']

      if (
        !isValidSignalPeerId(origin) ||
        !isValidSignalPeerId(dest) ||
        !msgId ||
        origin === selfId ||
        isLeftPeer(origin) ||
        isLeftPeer(dest)
      ) {
        return
      }

      if (
        !isValidOverlayMsgId(msgId) ||
        !ivB64 ||
        !Number.isSafeInteger(seq) ||
        seq < 1 ||
        bannedPeers.has(origin) ||
        bannedPeers.has(fromPeerId) ||
        bannedPeers.has(dest)
      ) {
        stats.signatureFailures++
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
          stats.signatureFailures++
          return
        }
        lease = parsedLease
      }

      const relayLeaseKey = `${origin}\0${dest}`
      if (dest !== selfId && lease) {
        if (relayLeaseReplay.has(relayLeaseKey, seq) || seenMsgIds.has(msgId)) {
          stats.duplicatesDropped++
          return
        }
      } else if (originReplay.has(origin, seq) || seenMsgIds.has(msgId)) {
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
        roomId
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
                roomId
              ),
              new Uint8Array(),
              lease[2]
            )
          : verifyUnicastOrBroadcast(origin, canonical, payload, sig)

      if (dest !== selfId) {
        if (ttl <= 1) {
          return
        }
        const validRelaySig = await verifyPacketAuth()
        if (
          !validRelaySig ||
          isDestroyed() ||
          isLeftPeer(origin) ||
          isLeftPeer(dest)
        ) {
          return
        }
        const recorded = lease
          ? relayLeaseReplay.record(relayLeaseKey, seq)
          : originReplay.record(origin, seq)
        if (!recorded || !seenMsgIds.add(msgId)) {
          stats.duplicatesDropped++
          return
        }
        touchOriginActivity(origin)
        const forwarded = packOverlayBinary(
          overlayUnicastKind,
          ttl - 1,
          header,
          payload
        )
        if (routeUnicastPacket(dest, forwarded, fromPeerId)) {
          stats.messagesForwarded++
        }
        return
      }

      const valid = await verifyPacketAuth()
      if (!valid || isDestroyed() || isLeftPeer(origin)) {
        return
      }

      const pairwiseKeyP = pairwiseKeys.get(origin)
      if (!pairwiseKeyP) {
        stats.signatureFailures++
        return
      }
      let plainPayload: Uint8Array
      try {
        const aesKey = await pairwiseKeyP
        plainPayload = await decryptUnicastPayload(
          aesKey,
          ivB64,
          canonical,
          payload
        )
      } catch {
        stats.signatureFailures++
        return
      }

      if (!originReplay.record(origin, seq) || !seenMsgIds.add(msgId)) {
        stats.duplicatesDropped++
        return
      }

      touchOriginActivity(origin)
      if (!ensureOriginVirtualPeer(origin, fromPeerId)) {
        return
      }
      flushBufferedBroadcasts(origin)

      stats.messagesReceived++
      onDeliverData(origin, plainPayload.slice().buffer)
    }
  }

  const dispatchBinaryFrame = (fromPeerId: string, bytes: Uint8Array): void => {
    const copy = bytes.slice()
    const parsed = unpackOverlayBinary(copy)
    if (!parsed) {
      return
    }
    const origin =
      typeof parsed.header['o'] === 'string' &&
      isValidSignalPeerId(parsed.header['o'])
        ? parsed.header['o']
        : fromPeerId
    deps.originTasks.enqueue(`data:${origin}`, () =>
      handleOverlayBinary(fromPeerId, parsed)
    )
  }

  return {
    resolveHealthyNextHopId,
    sendToDirectNeighbor,
    signUnicastOrBroadcast,
    verifyUnicastOrBroadcast,
    broadcastInline,
    sendUnicast: (targetPeerId: string, frame: Uint8Array): void => {
      const isChunkedAction =
        frame.byteLength >= 2 &&
        frame[0] === 2 &&
        ((frame[1]! & 0xf) === 1 || (frame[1]! & 0xf) === 2)
      sendUnicastInternal(targetPeerId, frame, {promoteDirect: isChunkedAction})
    },
    createVirtualTransport,
    flushBufferedBroadcasts,
    dispatchBinaryFrame,
    onEncPubKeyRotated: (peerId: string): void => {
      pairwiseKeys.invalidate(peerId)
    },
    purgePeerState: (peerId: string): void => {
      outboundUnicastLeases.delete(peerId)
      pendingEarlyBroadcasts.delete(peerId)
    },
    resetRoomCryptoState: (): void => {
      pairwiseKeys.clear()
      outboundUnicastLeases.clear()
      lastUnicastSeqByTarget.clear()
      relayLeaseReplay.clear()
      pendingEarlyBroadcasts.clear()
    },
    destroy: (): void => {
      deps.originTasks.clear()
      outboundUnicastQueues.clear()
      outboundQueueDepth.clear()
      outboundUnicastLeases.clear()
      lastUnicastSeqByTarget.clear()
      relayLeaseReplay.clear()
      pendingEarlyBroadcasts.clear()
    }
  }
}
