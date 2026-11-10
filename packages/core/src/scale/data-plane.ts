import {actionWireVersion, inspectActionWireHeader} from '../action-wire'
import {derivePairwiseAesKey} from '../crypto'
import {pubJwkToUncompressedBytes} from '../identity'
import type {MaybePromise, PeerHandle} from '../internal-types'
import {
  waitForBufferedAmountLow,
  type PeerDataTransport
} from '../peer-transport'
import {toBase64Url} from '../primitives'
import {isValidSignalPeerId} from '../signal-handler'
import {defaultMaxClockSkewMs} from '../signed-record'
import type {RoleCertificate, TopologyStats} from '../types'
import {
  authMetaKey,
  base64UrlRe,
  createBoundedCache,
  genId,
  isObj,
  isPosSafeInt,
  isStr,
  noOp,
  peerDisconnectedErr,
  unreachable,
  validateRoleCertificateShape
} from '../utils'
import {
  buildOverlaySignedBytes,
  canonicalBroadcastHeader,
  canonicalUnicastHeader,
  decryptUnicastPayload,
  encryptUnicastPayload,
  getPeerBufferedBytes,
  isPeerUsable,
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

type PairwiseKeyEntry = {
  readonly roomId: string
  readonly encPubKey: string
  readonly keyPromise: Promise<CryptoKey>
}

type OutboundUnicastState = {
  readonly token: symbol
  tail: Promise<void>
  depth: number
}

type VirtualTransportPhase = 'active' | 'detached' | 'closed'

type VirtualTransportControl = {
  getState: () => VirtualTransportPhase
  markDetached: () => void
}

type BufferedEarlyFrame = readonly [
  fromPeerId: string,
  frame: UnpackedOverlayFrame
]

type OriginBufferEntry = {
  early: BufferedEarlyFrame[]
  replayToken: symbol | null
  verified: ArrayBuffer[]
}

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
  onVirtualTransportDetached: (
    peerId: string,
    transport: PeerDataTransport
  ) => void
  hasBufferedFrames: (origin: string) => boolean
  broadcastInline: (
    frame: Uint8Array,
    onProgress?: (peerId: string) => void,
    signal?: AbortSignal
  ) => boolean | Promise<boolean>
  sendUnicast: (targetPeerId: string, frame: Uint8Array) => void
  handleOverlayBinary: (
    fromPeerId: string,
    frame: UnpackedOverlayFrame,
    isReplay?: boolean
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

  const pairwiseKeys = createBoundedCache<string, PairwiseKeyEntry>(512)
  const outboundUnicastByPeer = new Map<string, OutboundUnicastState>()
  const originBuffers = createBoundedCache<string, OriginBufferEntry>(
    maxBufferedEarlyOrigins
  )
  const virtualTransportControls = new WeakMap<
    PeerDataTransport,
    VirtualTransportControl
  >()
  // Tracks per-message inbound/outbound neighbor hops for transit unicasts (bounded
  // to <= 4 outbound attempts) so packets reroute around newly dead hops during the
  // <= 1.2s window before topology recomputation without looping on a single edge.
  const forwardedUnicastEdges = createBoundedCache<
    string,
    {inbound: Set<string>; outbound: Set<string>}
  >(4_096)

  let roomEpoch = 0

  const failSig = (): false => {
    stats.signatureFailures++
    return false
  }

  const invalidatePairwiseKey = (peerId: string): void => {
    pairwiseKeys.delete(peerId)
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
    const existing = pairwiseKeys.get(remotePeerId)
    if (
      existing &&
      existing.roomId === curRoomId &&
      existing.encPubKey === remoteKey
    ) {
      return existing.keyPromise
    }

    const keyPromise = loadLocalCryptoIdentity().then(id =>
      derivePairwiseAesKey(
        id.encPrivateKey,
        remoteUncompressed,
        appId,
        curRoomId,
        id.peerId,
        remotePeerId
      )
    )
    const entry: PairwiseKeyEntry = {
      roomId: curRoomId,
      encPubKey: remoteKey,
      keyPromise
    }
    pairwiseKeys.set(remotePeerId, entry)
    void keyPromise.catch(() => {
      if (pairwiseKeys.get(remotePeerId) === entry) {
        pairwiseKeys.delete(remotePeerId)
      }
    })
    return keyPromise
  }

  const verifyPacketSig = async (
    originPeerId: string,
    signPubKey: string,
    canonicalHeader: string,
    payload: Uint8Array,
    sig: string | undefined
  ): Promise<boolean> => {
    if (!sig || !descriptors.isPinnedKeyMatch(originPeerId, signPubKey)) {
      return failSig()
    }
    const ok = await verifyBase64Sig(
      sig,
      buildOverlaySignedBytes(canonicalHeader, payload),
      signPubKey
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

  const trySendDirect = (targetPeerId: string, frame: Uint8Array): boolean => {
    if (
      isDirectPeer(targetPeerId) &&
      sendToDirectNeighbor(targetPeerId, frame)
    ) {
      stats.messagesSent++
      return true
    }
    return false
  }

  const isOriginInvalid = (origin: string, expectedEpoch: number): boolean =>
    isDestroyed() ||
    expectedEpoch !== roomEpoch ||
    descriptors.hasLeft(origin) ||
    isPeerBanned(origin)

  const sendUnicastInternal = (
    targetPeerId: string,
    frame: Uint8Array,
    promoteDirect: boolean,
    strict: boolean
  ): void => {
    if (isOriginInvalid(targetPeerId, roomEpoch)) {
      if (strict) {
        throw peerDisconnectedErr
      }
      return
    }

    const router = getRouter()
    const existingState = outboundUnicastByPeer.get(targetPeerId)
    if (
      !(existingState && existingState.depth > 0) &&
      trySendDirect(targetPeerId, frame)
    ) {
      return
    }

    if (promoteDirect) {
      router.requireDirectPeer(targetPeerId, true)
    }

    if (!isDirectPeer(targetPeerId)) {
      const initialKeyP = getPairwiseKey(targetPeerId)
      if (!initialKeyP || !router.resolveHealthyNextHopId(targetPeerId)) {
        if (strict) {
          throw peerDisconnectedErr
        }
        return
      }
    }

    const enqueuedEpoch = roomEpoch
    const frameCopy = frame.slice()
    let state = outboundUnicastByPeer.get(targetPeerId)
    if (!state) {
      state = {
        token: Symbol(),
        tail: Promise.resolve(),
        depth: 0
      }
      outboundUnicastByPeer.set(targetPeerId, state)
    }
    const stateRef = state
    stateRef.depth++

    const isStillActive = (): boolean =>
      !isOriginInvalid(targetPeerId, enqueuedEpoch) &&
      outboundUnicastByPeer.get(targetPeerId)?.token === stateRef.token

    const nextTail = stateRef.tail
      .then(async () => {
        if (!isStillActive() || trySendDirect(targetPeerId, frameCopy)) {
          return
        }

        const latestKeyP = getPairwiseKey(targetPeerId)
        if (!latestKeyP) {
          return
        }

        let aesKey: CryptoKey
        let localId: CryptoIdentity
        try {
          ;[aesKey, localId] = await Promise.all([
            latestKeyP,
            loadLocalCryptoIdentity()
          ])
        } catch {
          return
        }
        syncSelfIdFromIdentity(localId.peerId)
        if (!isStillActive() || trySendDirect(targetPeerId, frameCopy)) {
          return
        }

        const curSelfId = getSelfId()
        const curRoomId = getRoomId()
        const pktSeq = seq.nextPktSeq()
        const msgId = `${curSelfId}:${pktSeq}:${genId(8)}`
        seq.originReplay.record(curSelfId, pktSeq)
        seq.seenMsgIds.add(msgId)

        const ts = Date.now()
        const iv = crypto.getRandomValues(new Uint8Array(12))
        const ivB64 = toBase64Url(iv)
        const canonical = canonicalUnicastHeader(
          curSelfId,
          targetPeerId,
          msgId,
          ivB64,
          pktSeq,
          ts,
          appId,
          curRoomId
        )

        let payloadToSend: Uint8Array
        let sig: string
        try {
          payloadToSend = await encryptUnicastPayload(
            aesKey,
            iv,
            canonical,
            frameCopy
          )
          sig = await signOverlayPayload(
            localId.signPrivateKey,
            canonical,
            payloadToSend
          )
        } catch {
          return
        }
        if (!isStillActive() || trySendDirect(targetPeerId, frameCopy)) {
          return
        }
        const packet = packOverlayBinary(
          overlayUnicastKind,
          router.currentMaxHops(),
          {
            o: curSelfId,
            d: targetPeerId,
            q: pktSeq,
            t: ts,
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
        if (outboundUnicastByPeer.get(targetPeerId)?.token !== stateRef.token) {
          return
        }
        stateRef.depth--
        if (stateRef.depth <= 0 && stateRef.tail === nextTail) {
          outboundUnicastByPeer.delete(targetPeerId)
        }
      })
    stateRef.tail = nextTail
  }

  const createVirtualTransport = (peerId: string): PeerDataTransport => {
    const router = getRouter()
    const existing = router.getVirtualTransport(peerId)
    const existingControl = existing
      ? virtualTransportControls.get(existing)
      : undefined
    if (
      existing &&
      existingControl &&
      existingControl.getState() === 'active'
    ) {
      return existing
    }

    let state: VirtualTransportPhase = 'active'

    const isReachable = (): boolean => {
      if (isOriginInvalid(peerId, roomEpoch)) {
        return false
      }
      switch (state) {
        case 'active':
          return Boolean(router.resolveHealthyNextHopId(peerId))
        // Allow in-flight chunked transfers started on a virtual transport to seamlessly
        // finish over a newly upgraded direct DataChannel after virtual detachment/close.
        case 'detached':
        case 'closed':
          return isDirectPeer(peerId) && isPeerUsable(getDirectPeer(peerId))
        default:
          return unreachable(state)
      }
    }

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
        const outState = outboundUnicastByPeer.get(peerId)
        const queuePromise =
          outState && outState.depth >= maxQueuedUnicastBeforeBackpressure
            ? outState.tail
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
              const ac = new AbortController()
              const abortP = new Promise<false>(res => {
                signal.addEventListener('abort', () => res(false), {
                  once: true,
                  signal: ac.signal
                })
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
                ac.abort()
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
        if (state === 'closed') {
          return
        }
        state = 'closed'
        router.detachVirtualTransport(peerId, transport)
      }
    }

    virtualTransportControls.set(transport, {
      getState: () => state,
      markDetached: () => {
        if (state === 'active') {
          state = 'detached'
        }
      }
    })
    router.setVirtualTransport(peerId, transport)
    return transport
  }

  const ensureOriginBuffer = (origin: string): OriginBufferEntry => {
    let entry = originBuffers.get(origin)
    if (!entry) {
      entry = {early: [], replayToken: null, verified: []}
      originBuffers.set(origin, entry)
    }
    return entry
  }

  const flushBufferedForOrigin = (origin: string): void => {
    const entry = originBuffers.get(origin)
    if (!entry || entry.verified.length === 0) {
      return
    }
    const broadcasts = entry.verified.splice(0)
    if (entry.early.length === 0 && entry.replayToken === null) {
      originBuffers.delete(origin)
    }
    for (const buf of broadcasts) {
      if (isOriginInvalid(origin, roomEpoch)) {
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
    const entry = ensureOriginBuffer(origin)
    if (entry.early.length < maxBufferedEarlyFramesPerOrigin) {
      entry.early.push([
        fromPeerId,
        [frame[0], frame[1], frame[2], frame[3].slice()]
      ])
    }
  }

  const bufferVerifiedBroadcast = (
    origin: string,
    payload: Uint8Array
  ): void => {
    const entry = ensureOriginBuffer(origin)
    if (entry.verified.length < maxBufferedEarlyFramesPerOrigin) {
      entry.verified.push(payload.slice().buffer)
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
    const expectedEpoch = roomEpoch

    return (async (): Promise<boolean> => {
      const id = await loadLocalCryptoIdentity()
      syncSelfIdFromIdentity(id.peerId)
      if (isDestroyed() || signal?.aborted || expectedEpoch !== roomEpoch) {
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
      if (isDestroyed() || signal?.aborted || expectedEpoch !== roomEpoch) {
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
    frame: UnpackedOverlayFrame,
    isReplay = false
  ): Promise<void> => {
    if (isDestroyed()) {
      return
    }
    const [kind, rawTtl, header, payload] = frame
    const router = getRouter()
    const ttl = Math.min(rawTtl, maxAllowedHops)
    const curSelfId = getSelfId()
    const curRoomId = getRoomId()
    const expectedEpoch = roomEpoch
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

    const isTransitUnicast =
      kind === overlayUnicastKind && header['d'] !== curSelfId
    if (isTransitUnicast) {
      if (forwardedUnicastEdges.get(msgId)?.inbound.has(fromPeerId)) {
        stats.duplicatesDropped++
        return
      }
    } else if (
      seq.originReplay.has(origin, pktSeq) ||
      seq.seenMsgIds.has(msgId)
    ) {
      stats.duplicatesDropped++
      return
    }

    const signPubKey = descriptors.getSignPubKey(origin)
    const bufEntry = originBuffers.get(origin)
    if (
      !signPubKey ||
      (!isReplay &&
        bufEntry &&
        (bufEntry.early.length > 0 || bufEntry.replayToken !== null))
    ) {
      if (!isReplay) {
        bufferEarlyUnverifiedFrame(origin, fromPeerId, frame)
      }
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
        signPubKey,
        canonicalBroadcastHeader(origin, msgId, pktSeq, ts, appId, curRoomId),
        payload,
        sig
      )
      if (!valid || isOriginInvalid(origin, expectedEpoch)) {
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
          if (!allowed || isOriginInvalid(origin, expectedEpoch)) {
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
      } else if (!router.isPeerQuarantined(origin)) {
        bufferVerifiedBroadcast(origin, payload)
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
      const ts = header['t']

      if (!isValidSignalPeerId(dest) || descriptors.hasLeft(dest)) {
        return
      }
      if (
        !ivB64 ||
        ivB64.length !== 16 ||
        !base64UrlRe.test(ivB64) ||
        !isPosSafeInt(ts) ||
        isPeerBanned(dest)
      ) {
        failSig()
        return
      }
      if (Math.abs(Date.now() - ts) > defaultMaxClockSkewMs) {
        return
      }

      const canonical = canonicalUnicastHeader(
        origin,
        dest,
        msgId,
        ivB64,
        pktSeq,
        ts,
        appId,
        curRoomId
      )

      if (dest !== curSelfId) {
        if (
          ttl <= 1 ||
          !(await verifyPacketSig(
            origin,
            signPubKey,
            canonical,
            payload,
            sig
          )) ||
          isDestroyed() ||
          expectedEpoch !== roomEpoch ||
          descriptors.hasLeft(origin) ||
          descriptors.hasLeft(dest)
        ) {
          return
        }
        let edgeState = forwardedUnicastEdges.get(msgId)
        if (edgeState?.inbound.has(fromPeerId)) {
          stats.duplicatesDropped++
          return
        }
        if (!edgeState) {
          edgeState = {inbound: new Set(), outbound: new Set()}
          forwardedUnicastEdges.set(msgId, edgeState)
        }
        edgeState.inbound.add(fromPeerId)
        if (edgeState.outbound.size >= 4) {
          return
        }
        descriptors.touchOriginActivity(origin)

        const exclude = new Set<string>(edgeState.outbound)
        for (const inId of edgeState.inbound) {
          exclude.add(inId)
        }
        let hop = router.resolveHealthyNextHopId(dest, exclude)
        if (
          !hop &&
          !edgeState.outbound.has(fromPeerId) &&
          isPeerUsable(getDirectPeer(fromPeerId))
        ) {
          hop = fromPeerId
        }
        if (hop) {
          edgeState.outbound.add(hop)
          if (
            sendToDirectNeighbor(
              hop,
              packOverlayBinary(overlayUnicastKind, ttl - 1, header, payload)
            )
          ) {
            stats.messagesForwarded++
          }
        }
        return
      }

      if (
        router.isPeerQuarantined(origin) ||
        !(await verifyPacketSig(origin, signPubKey, canonical, payload, sig)) ||
        isOriginInvalid(origin, expectedEpoch)
      ) {
        return
      }

      const pairwiseKeyP = getPairwiseKey(origin)
      if (!pairwiseKeyP) {
        if (!isReplay && !descriptors.hasDescriptor(origin)) {
          bufferEarlyUnverifiedFrame(origin, fromPeerId, frame)
        }
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
        isOriginInvalid(origin, expectedEpoch) ||
        router.isPeerQuarantined(origin)
      ) {
        return
      }

      if (seq.originReplay.has(origin, pktSeq) || seq.seenMsgIds.has(msgId)) {
        stats.duplicatesDropped++
        return
      }
      if (!router.ensureOriginVirtualPeer(origin, fromPeerId)) {
        return
      }
      if (!commitPacketReplay()) {
        return
      }
      flushBufferedForOrigin(origin)

      stats.messagesReceived++
      onDeliverData(origin, plainPayload.slice().buffer)
    }
  }

  return {
    createVirtualTransport,
    onVirtualTransportDetached: (_peerId, transport) => {
      virtualTransportControls.get(transport)?.markDetached()
    },
    hasBufferedFrames: origin => {
      const entry = originBuffers.get(origin)
      return Boolean(
        entry && (entry.early.length > 0 || entry.verified.length > 0)
      )
    },
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
      const current = originBuffers.get(origin)
      if (!current || current.replayToken !== null) {
        return
      }
      if (current.early.length === 0) {
        if (current.verified.length === 0) {
          originBuffers.delete(origin)
        }
        return
      }
      const token = Symbol()
      const replayEpoch = roomEpoch
      current.replayToken = token
      const drainNext = (): void => {
        const active = originBuffers.get(origin)
        if (!active || active.replayToken !== token) {
          return
        }
        if (isDestroyed() || replayEpoch !== roomEpoch) {
          active.early.length = 0
          active.replayToken = null
          if (active.verified.length === 0) {
            originBuffers.delete(origin)
          }
          return
        }
        const item = active.early.shift()
        if (!item) {
          active.replayToken = null
          if (active.verified.length === 0) {
            originBuffers.delete(origin)
          }
          return
        }
        seq.enqueuePeerTask(item[0], async () => {
          try {
            const latest = originBuffers.get(origin)
            if (
              !latest ||
              latest.replayToken !== token ||
              isDestroyed() ||
              replayEpoch !== roomEpoch
            ) {
              return
            }
            await handleOverlayBinary(item[0], item[1], true)
          } finally {
            drainNext()
          }
        })
      }
      drainNext()
    },
    invalidatePairwiseKey,
    purgePeerDataState: peerId => {
      invalidatePairwiseKey(peerId)
      outboundUnicastByPeer.delete(peerId)
      originBuffers.delete(peerId)
    },
    resetRoomCryptoState: () => {
      roomEpoch++
      pairwiseKeys.clear()
      outboundUnicastByPeer.clear()
      originBuffers.clear()
      forwardedUnicastEdges.clear()
    },
    destroy: () => {
      roomEpoch++
      pairwiseKeys.clear()
      outboundUnicastByPeer.clear()
      originBuffers.clear()
      forwardedUnicastEdges.clear()
    }
  }
}
