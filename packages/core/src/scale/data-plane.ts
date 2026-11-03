import {actionWireVersion, inspectActionWireHeader} from '../action-wire'
import {derivePairwiseAesKey} from '../crypto'
import {canonicalizePubJwk, pubJwkToUncompressedBytes} from '../identity'
import {
  waitForBufferedAmountLow,
  type PeerDataTransport
} from '../peer-transport'
import {isValidSignalPeerId} from '../signal-handler'
import {defaultMaxClockSkewMs} from '../signed-record'
import type {
  MaybePromise,
  PeerHandle,
  RoleCertificate,
  TopologyStats
} from '../types'
import {
  authMetaKey,
  createBoundedCache,
  genId,
  isObj,
  isPosSafeInt,
  isStr,
  noOp,
  peerDisconnectedErr,
  toBase64,
  validateRoleCertificateShape
} from '../utils'
import {
  buildOverlaySignedBytes,
  canonicalBroadcastHeader,
  canonicalUnicastHeader,
  decryptUnicastPayload,
  encryptUnicastPayload,
  getPeerBufferedBytes,
  isValidOverlayMsgId,
  overlayBroadcastKind,
  overlayUnicastKind,
  packOverlayBinary,
  signOverlayPayload,
  verifyBase64Sig,
  type BroadcastEnvelopeHeader,
  type CryptoIdentity,
  type UnpackedOverlayFrame
} from './crypto-frame'
import type {DescriptorStore} from './descriptors'
import type {OverlayRouter} from './routing'
import type {OverlaySequencer} from './seq'
import {maxAllowedHops} from './topology'

const maxQueuedUnicastBeforeBackpressure = 4
const maxBufferedEarlyOrigins = 64
const maxBufferedEarlyFramesPerOrigin = 8

export type OverlayDataPlaneDeps = {
  appId: string
  seq: OverlaySequencer
  descriptors: DescriptorStore
  getRouter: () => OverlayRouter
  stats: TopologyStats
  isDestroyed: () => boolean
  getSelfId: () => string
  getRoomId: () => string
  loadLocalCryptoIdentity: () => Promise<CryptoIdentity>
  syncSelfIdFromIdentity: (peerId: string) => void
  getDirectPeer: (peerId: string) => PeerHandle | undefined
  isDirectPeer: (peerId: string) => boolean
  getDirectPeerIds: () => IterableIterator<string>
  getDirectPeerCount: () => number
  hasUsableDirectPeer: () => boolean
  sendToDirectNeighbor: (peerId: string, frame: Uint8Array) => boolean
  isPeerBanned: (peerId: string) => boolean
  getActionRequiredRoles: (actionType: string) => readonly string[] | undefined
  authorizePeerAction?:
    | ((
        peerId: string,
        requiredRoles: readonly string[],
        inlineCert?: RoleCertificate
      ) => MaybePromise<boolean>)
    | undefined
  onDeliverData: (originPeerId: string, data: ArrayBuffer) => void
}

export type OverlayDataPlane = {
  createVirtualTransport: (peerId: string) => PeerDataTransport
  broadcastInline: (
    frame: Uint8Array,
    onProgress?: (peerId: string) => void,
    signal?: AbortSignal
  ) => boolean | Promise<boolean>
  sendUnicast: (targetPeerId: string, frame: Uint8Array) => void
  handleOverlayBinary: (
    fromPeerId: string,
    frame: UnpackedOverlayFrame
  ) => Promise<void>
  flushBufferedForOrigin: (origin: string) => void
  replayEarlyFramesForOrigin: (origin: string) => void
  invalidatePairwiseKey: (peerId: string) => void
  purgePeerDataState: (peerId: string) => void
  resetRoomCryptoState: () => void
  destroy: () => void
}

export const createOverlayDataPlane = (
  deps: OverlayDataPlaneDeps
): OverlayDataPlane => {
  const {
    appId,
    seq,
    descriptors,
    getRouter,
    stats,
    isDestroyed,
    getSelfId,
    getRoomId,
    loadLocalCryptoIdentity,
    syncSelfIdFromIdentity,
    getDirectPeer,
    isDirectPeer,
    getDirectPeerIds,
    getDirectPeerCount,
    hasUsableDirectPeer,
    sendToDirectNeighbor,
    isPeerBanned,
    getActionRequiredRoles,
    authorizePeerAction,
    onDeliverData
  } = deps

  const derivedPairwiseKeys = createBoundedCache<string, Promise<CryptoKey>>(
    512
  )
  const pairwiseKeyIdByPeer = new Map<string, string>()
  const outboundUnicastQueues = new Map<string, Promise<void>>()
  const outboundQueueDepth = new Map<string, number>()
  const pendingVerifiedBroadcasts = createBoundedCache<string, ArrayBuffer[]>(
    maxBufferedEarlyOrigins
  )
  const pendingEarlyFrames = createBoundedCache<
    string,
    Array<[fromPeerId: string, frame: UnpackedOverlayFrame]>
  >(maxBufferedEarlyOrigins)

  const failSig = (): false => {
    stats.signatureFailures++
    return false
  }

  const invalidatePairwiseKey = (peerId: string): void => {
    const keyId = pairwiseKeyIdByPeer.get(peerId)
    if (keyId !== undefined) {
      derivedPairwiseKeys.delete(keyId)
      pairwiseKeyIdByPeer.delete(peerId)
    }
  }

  const getPairwiseKey = (remotePeerId: string): Promise<CryptoKey> | null => {
    const remoteKey = descriptors.getDescriptor(remotePeerId)?.encPubKey
    const remoteUncompressed = remoteKey
      ? pubJwkToUncompressedBytes(remoteKey)
      : null
    if (!remoteKey || !remoteUncompressed) {
      return null
    }
    const curRoomId = getRoomId()
    const cacheKey = `${curRoomId}\0${remotePeerId}\0${canonicalizePubJwk(remoteKey)}`
    const prevKey = pairwiseKeyIdByPeer.get(remotePeerId)
    if (prevKey && prevKey !== cacheKey) {
      derivedPairwiseKeys.delete(prevKey)
    }
    pairwiseKeyIdByPeer.set(remotePeerId, cacheKey)

    let cached = derivedPairwiseKeys.get(cacheKey)
    if (!cached) {
      cached = loadLocalCryptoIdentity().then(id =>
        derivePairwiseAesKey(
          id.encPrivateKey,
          remoteUncompressed,
          appId,
          curRoomId,
          id.peerId,
          remotePeerId
        )
      )
      cached.catch(() => {
        if (derivedPairwiseKeys.get(cacheKey) === cached) {
          derivedPairwiseKeys.delete(cacheKey)
        }
      })
      derivedPairwiseKeys.set(cacheKey, cached)
    }
    return cached
  }

  const signPacket = async (
    canonicalHeader: string,
    payload: Uint8Array
  ): Promise<string> => {
    const id = await loadLocalCryptoIdentity()
    syncSelfIdFromIdentity(id.peerId)
    return signOverlayPayload(id.signPrivateKey, canonicalHeader, payload)
  }

  const verifyPacketSig = async (
    originPeerId: string,
    signPubJwk: JsonWebKey,
    canonicalHeader: string,
    payload: Uint8Array,
    sig: string | undefined
  ): Promise<boolean> => {
    if (!sig || !descriptors.isPinnedKeyMatch(originPeerId, signPubJwk)) {
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
    excludePeerId?: string
  ): boolean => {
    const hop = getRouter().resolveHealthyNextHopId(destPeerId, excludePeerId)
    return Boolean(hop && sendToDirectNeighbor(hop, packet))
  }

  const sendUnicastInternal = (
    targetPeerId: string,
    frame: Uint8Array,
    promoteDirect: boolean,
    strict: boolean
  ): void => {
    if (isDestroyed()) {
      if (strict) {
        throw peerDisconnectedErr
      }
      return
    }

    const router = getRouter()
    const hasPendingQueue = (outboundQueueDepth.get(targetPeerId) ?? 0) > 0
    if (!hasPendingQueue && isDirectPeer(targetPeerId)) {
      if (sendToDirectNeighbor(targetPeerId, frame)) {
        stats.messagesSent++
        return
      }
    }

    if (promoteDirect) {
      router.requireDirectPeer(targetPeerId, true)
    }

    const pairwiseKeyP = getPairwiseKey(targetPeerId)
    if (!pairwiseKeyP || !router.resolveHealthyNextHopId(targetPeerId)) {
      if (strict) {
        throw peerDisconnectedErr
      }
      return
    }

    const curSelfId = getSelfId()
    const curRoomId = getRoomId()
    const pktSeq = seq.nextPktSeq()
    const msgId = `${curSelfId}:${pktSeq}:${genId(8)}`
    seq.originReplay.record(curSelfId, pktSeq)
    seq.seenMsgIds.add(msgId)

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
        if (
          isDirectPeer(targetPeerId) &&
          sendToDirectNeighbor(targetPeerId, frameCopy)
        ) {
          stats.messagesSent++
          return
        }

        const latestKeyP = getPairwiseKey(targetPeerId) ?? pairwiseKeyP
        let payloadToSend: Uint8Array
        let ivB64: string
        let canonical: string

        try {
          const aesKey = await latestKeyP
          const iv = crypto.getRandomValues(new Uint8Array(12))
          ivB64 = toBase64(iv)
          canonical = canonicalUnicastHeader(
            curSelfId,
            targetPeerId,
            msgId,
            ivB64,
            pktSeq,
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

        const sig = await signPacket(canonical, payloadToSend)
        if (isDestroyed()) {
          return
        }
        const packet = packOverlayBinary(
          overlayUnicastKind,
          router.currentMaxHops(),
          {
            o: curSelfId,
            d: targetPeerId,
            q: pktSeq,
            m: msgId,
            iv: ivB64,
            s: sig
          },
          payloadToSend
        )
        if (routeUnicastPacket(targetPeerId, packet)) {
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
    const router = getRouter()
    const existing = router.getVirtualTransport(peerId)
    if (existing && existing.isOpen) {
      return existing
    }

    let closed = false

    const isReachable = (): boolean =>
      !closed &&
      !isDestroyed() &&
      !isPeerBanned(peerId) &&
      !descriptors.hasLeft(peerId) &&
      Boolean(router.resolveHealthyNextHopId(peerId))

    const transport: PeerDataTransport = {
      get isOpen(): boolean {
        return isReachable()
      },
      get bufferedAmount(): number {
        if (!isReachable()) {
          return 0
        }
        const hop = router.resolveHealthyNextHopId(peerId)
        return hop ? getPeerBufferedBytes(getDirectPeer(hop)) : 0
      },
      sendFrame: (bytes, transferId, isOffer) => {
        if (!isReachable()) {
          throw peerDisconnectedErr
        }
        if (transferId !== undefined) {
          router.requireDirectPeer(peerId, Boolean(isOffer))
        }
        sendUnicastInternal(peerId, bytes, false, true)
      },
      waitForDrain: signal => {
        if (signal?.aborted || !isReachable()) {
          return false
        }
        const hop = router.resolveHealthyNextHopId(peerId)
        const hopChannel = hop ? getDirectPeer(hop)?.channel : null
        const depth = outboundQueueDepth.get(peerId) ?? 0
        const queuePromise =
          depth >= maxQueuedUnicastBeforeBackpressure
            ? outboundUnicastQueues.get(peerId)
            : undefined
        const channelNeedsWait = Boolean(
          hopChannel &&
          (hopChannel.readyState !== 'open' ||
            hopChannel.bufferedAmount >
              (hopChannel.bufferedAmountLowThreshold ?? 0))
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
          const latestHop = router.resolveHealthyNextHopId(peerId)
          const latestChannel = latestHop
            ? getDirectPeer(latestHop)?.channel
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
        router.detachVirtualTransport(peerId, transport)
      }
    }

    router.setVirtualTransport(peerId, transport)
    return transport
  }

  const flushBufferedForOrigin = (origin: string): void => {
    const buffered = pendingVerifiedBroadcasts.get(origin)
    if (!buffered || !buffered.length) {
      return
    }
    pendingVerifiedBroadcasts.delete(origin)
    for (const buf of buffered) {
      if (
        isDestroyed() ||
        isPeerBanned(origin) ||
        descriptors.hasLeft(origin)
      ) {
        break
      }
      stats.messagesReceived++
      onDeliverData(origin, buf)
    }
  }

  const bufferEarlyUnverifiedFrame = (
    origin: string,
    fromPeerId: string,
    frame: UnpackedOverlayFrame
  ): void => {
    let queue = pendingEarlyFrames.get(origin)
    if (!queue) {
      queue = []
      pendingEarlyFrames.set(origin, queue)
    }
    if (queue.length < maxBufferedEarlyFramesPerOrigin) {
      queue.push([fromPeerId, [frame[0], frame[1], frame[2], frame[3].slice()]])
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
    for (const neighborId of getDirectPeerIds()) {
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

  const broadcastInline = (
    frame: Uint8Array,
    onProgress?: (peerId: string) => void,
    signal?: AbortSignal
  ): boolean | Promise<boolean> => {
    if (isDestroyed() || signal?.aborted) {
      return false
    }
    if (getDirectPeerCount() === 0 || !hasUsableDirectPeer()) {
      return false
    }
    const router = getRouter()

    return (async (): Promise<boolean> => {
      const id = await loadLocalCryptoIdentity()
      syncSelfIdFromIdentity(id.peerId)
      if (isDestroyed() || signal?.aborted) {
        return false
      }

      const curSelfId = getSelfId()
      const pktSeq = seq.nextPktSeq()
      const ts = Date.now()
      const msgId = `${curSelfId}:${pktSeq}:${genId(8)}`
      seq.originReplay.record(curSelfId, pktSeq)
      seq.seenMsgIds.add(msgId)

      const sig = await signOverlayPayload(
        id.signPrivateKey,
        canonicalBroadcastHeader(
          curSelfId,
          msgId,
          pktSeq,
          ts,
          appId,
          getRoomId()
        ),
        frame
      )
      if (isDestroyed() || signal?.aborted) {
        return false
      }
      const sentCount = forwardBroadcastPacket(
        curSelfId,
        router.currentMaxHops(),
        {o: curSelfId, q: pktSeq, m: msgId, t: ts, s: sig},
        frame
      )
      if (sentCount === 0) {
        return false
      }
      stats.messagesSent++

      if (onProgress) {
        for (const peerId of router.getReachablePeerIds()) {
          onProgress(peerId)
        }
      }
      return true
    })()
  }

  const handleOverlayBinary = async (
    fromPeerId: string,
    frame: UnpackedOverlayFrame
  ): Promise<void> => {
    if (isDestroyed()) {
      return
    }
    const [kind, rawTtl, header, payload] = frame
    const router = getRouter()
    const ttl = Math.min(rawTtl, maxAllowedHops)
    const curSelfId = getSelfId()
    const curRoomId = getRoomId()
    const origin = isStr(header['o']) ? header['o'] : ''
    const pktSeq = header['q']
    const msgId = isStr(header['m']) ? header['m'] : ''
    const sig = isStr(header['s']) ? header['s'] : undefined

    if (
      !isValidSignalPeerId(origin) ||
      !msgId ||
      origin === curSelfId ||
      descriptors.hasLeft(origin)
    ) {
      return
    }

    if (
      !isValidOverlayMsgId(msgId) ||
      !isPosSafeInt(pktSeq) ||
      isPeerBanned(origin) ||
      isPeerBanned(fromPeerId)
    ) {
      failSig()
      return
    }

    if (seq.originReplay.has(origin, pktSeq) || seq.seenMsgIds.has(msgId)) {
      stats.duplicatesDropped++
      return
    }

    const signPubJwk = descriptors.getSignPubKey(origin)
    if (!signPubJwk) {
      bufferEarlyUnverifiedFrame(origin, fromPeerId, frame)
      return
    }

    const commitPacketReplay = (): boolean => {
      if (
        !seq.originReplay.record(origin, pktSeq) ||
        !seq.seenMsgIds.add(msgId)
      ) {
        stats.duplicatesDropped++
        return false
      }
      descriptors.touchOriginActivity(origin)
      return true
    }

    if (kind === overlayBroadcastKind) {
      const ts = header['t']
      if (!isPosSafeInt(ts)) {
        failSig()
        return
      }
      if (Math.abs(Date.now() - ts) > defaultMaxClockSkewMs) {
        return
      }

      const valid = await verifyPacketSig(
        origin,
        signPubJwk,
        canonicalBroadcastHeader(origin, msgId, pktSeq, ts, appId, curRoomId),
        payload,
        sig
      )
      if (!valid || isDestroyed() || descriptors.hasLeft(origin)) {
        return
      }

      const wireHeader = inspectActionWireHeader(payload)
      if (wireHeader) {
        const requiredRoles = getActionRequiredRoles(wireHeader.type)
        if (requiredRoles && requiredRoles.length > 0 && authorizePeerAction) {
          const rawCert = isObj(wireHeader.metadata)
            ? wireHeader.metadata[authMetaKey]
            : undefined
          const inlineCert = validateRoleCertificateShape(rawCert)
            ? rawCert
            : undefined
          const allowed = await authorizePeerAction(
            origin,
            requiredRoles,
            inlineCert
          )
          if (!allowed || isDestroyed()) {
            return
          }
        }
      }

      if (!commitPacketReplay()) {
        return
      }

      if (
        isDirectPeer(origin) ||
        router.isVirtualPeer(origin) ||
        Boolean(descriptors.getDescriptor(origin)?.encPubKey)
      ) {
        if (router.ensureOriginVirtualPeer(origin, fromPeerId)) {
          flushBufferedForOrigin(origin)
          stats.messagesReceived++
          onDeliverData(origin, payload.slice().buffer)
        }
      } else {
        let queue = pendingVerifiedBroadcasts.get(origin)
        if (!queue) {
          queue = []
          pendingVerifiedBroadcasts.set(origin, queue)
        }
        if (queue.length < maxBufferedEarlyFramesPerOrigin) {
          queue.push(payload.slice().buffer)
        }
      }

      if (
        ttl > 1 &&
        forwardBroadcastPacket(
          origin,
          ttl - 1,
          {o: origin, q: pktSeq, m: msgId, t: ts, ...(sig ? {s: sig} : {})},
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

      if (!isValidSignalPeerId(dest) || descriptors.hasLeft(dest)) {
        return
      }
      if (!ivB64 || isPeerBanned(dest)) {
        failSig()
        return
      }

      const canonical = canonicalUnicastHeader(
        origin,
        dest,
        msgId,
        ivB64,
        pktSeq,
        appId,
        curRoomId
      )

      if (dest !== curSelfId) {
        if (
          ttl <= 1 ||
          !(await verifyPacketSig(
            origin,
            signPubJwk,
            canonical,
            payload,
            sig
          )) ||
          isDestroyed() ||
          descriptors.hasLeft(origin) ||
          descriptors.hasLeft(dest) ||
          !commitPacketReplay()
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
        !(await verifyPacketSig(origin, signPubJwk, canonical, payload, sig)) ||
        isDestroyed() ||
        descriptors.hasLeft(origin)
      ) {
        return
      }

      const pairwiseKeyP = getPairwiseKey(origin)
      if (!pairwiseKeyP) {
        bufferEarlyUnverifiedFrame(origin, fromPeerId, frame)
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
        !router.ensureOriginVirtualPeer(origin, fromPeerId)
      ) {
        return
      }
      flushBufferedForOrigin(origin)

      stats.messagesReceived++
      onDeliverData(origin, plainPayload.slice().buffer)
    }
  }

  return {
    createVirtualTransport,
    broadcastInline,
    sendUnicast: (targetPeerId, frame) => {
      const isChunkedAction =
        frame.byteLength >= 2 &&
        frame[0] === actionWireVersion &&
        ((frame[1]! & 0xf) === 1 || (frame[1]! & 0xf) === 2)
      sendUnicastInternal(targetPeerId, frame, isChunkedAction, false)
    },
    handleOverlayBinary,
    flushBufferedForOrigin,
    replayEarlyFramesForOrigin: origin => {
      const early = pendingEarlyFrames.get(origin)
      if (!early || !early.length) {
        return
      }
      pendingEarlyFrames.delete(origin)
      for (const [fromPeerId, rawFrame] of early) {
        seq.enqueueOriginTask(origin, () =>
          handleOverlayBinary(fromPeerId, rawFrame)
        )
      }
    },
    invalidatePairwiseKey,
    purgePeerDataState: peerId => {
      invalidatePairwiseKey(peerId)
      pendingVerifiedBroadcasts.delete(peerId)
      pendingEarlyFrames.delete(peerId)
    },
    resetRoomCryptoState: () => {
      derivedPairwiseKeys.clear()
      pairwiseKeyIdByPeer.clear()
      pendingVerifiedBroadcasts.clear()
      pendingEarlyFrames.clear()
    },
    destroy: () => {
      derivedPairwiseKeys.clear()
      pairwiseKeyIdByPeer.clear()
      outboundUnicastQueues.clear()
      outboundQueueDepth.clear()
      pendingVerifiedBroadcasts.clear()
      pendingEarlyFrames.clear()
    }
  }
}
