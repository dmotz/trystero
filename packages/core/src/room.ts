import {
  entries,
  fromEntries,
  genId,
  isBrowser,
  keys,
  libName,
  mkErr,
  noOp,
  selfId as defaultSelfId,
  toError
} from './utils'
import {createActionManager} from './actions'
import {createRoomAuthority, type ResolvedRoomAuthority} from './authority'
import {
  createHandshakeManager,
  roomFullHostRejectErr,
  type HandshakeReadyPayload
} from './handshake'
import {createMediaManager, type InternalMediaMeta} from './media'
import {createOverlayManager, type OverlayManager} from './overlay'
import type {
  AddMediaOptions,
  AuthorityConfig,
  AuthoritativeState,
  AuthoritativeStateRecord,
  DataPayload,
  JsonValue,
  PeerBanRecord,
  PeerHandle,
  PeerHandshake,
  RoleCertificate,
  RoleRevocationRecord,
  Room,
  RoomAuthorityInfo,
  SharedMediaPeer,
  StateConfig,
  TargetPeers,
  TopologyConfig,
  TopologyMode
} from './types'

const unloadEvent = 'beforeunload'
const defaultHandshakeTimeoutMs = 10_000
const internalNs = (ns: string): string => '@_' + ns
const beforeUnloadRoomCleanups = new Set<() => void>()

const cleanupActiveRoomsOnBeforeUnload = (): void =>
  beforeUnloadRoomCleanups.forEach(cleanup => cleanup())

const registerBeforeUnloadCleanup = (cleanup: () => void): (() => void) => {
  beforeUnloadRoomCleanups.add(cleanup)

  if (beforeUnloadRoomCleanups.size === 1) {
    addEventListener(unloadEvent, cleanupActiveRoomsOnBeforeUnload)
  }

  return (): void => {
    beforeUnloadRoomCleanups.delete(cleanup)

    if (!beforeUnloadRoomCleanups.size) {
      removeEventListener(unloadEvent, cleanupActiveRoomsOnBeforeUnload)
    }
  }
}

export type RoomSignalingBridge = {
  overlay: OverlayManager
  getAnnounceExtra: () => Promise<Record<string, unknown> | undefined>
  onSignalingPayload: (
    peerId: string,
    payload: Record<string, unknown>
  ) => Promise<void> | void
  checkCapacityAfterPassword: (peerId: string) => void
}

const roomSignalingBridges = new WeakMap<Room, RoomSignalingBridge>()

export const getRoomSignalingBridge = (
  room: Room
): RoomSignalingBridge | undefined => roomSignalingBridges.get(room)

type RoomOptions = {
  selfId?: string
  appId?: string
  roomId?: string
  password?: string
  limit?: number
  topology?: TopologyMode | TopologyConfig
  admin?: boolean | string | AuthorityConfig
  resolvedAuthorityP?: Promise<ResolvedRoomAuthority>
  maxReceiveBytes?: number
  onPeerHandshake?: PeerHandshake
  onHandshakeError?: (peerId: string, error: string) => void
  handshakeTimeoutMs?: number
  isPassive?: boolean
  onBeforeLeave?: () => void
}

type PendingPongWaiter = {
  resolve: () => void
  reject: (error: Error) => void
}

type MediaControlMessage = {
  op: 'rmStream' | 'rmTrack'
  o: string
  id: string
}

type AuthControlMessage =
  | {
      t: 'sync'
      pubKey?: JsonWebKey
      certs?: RoleCertificate[]
      revocations?: RoleRevocationRecord[]
      bans?: PeerBanRecord[]
      states?: AuthoritativeStateRecord[]
    }
  | {
      t: 'whois'
    }
  | {
      t: 'cert'
      cert: RoleCertificate
      reqId?: string
      ackPeers?: string[]
    }
  | {
      t: 'revoke'
      revocation: RoleRevocationRecord
      reqId?: string
      ackPeers?: string[]
    }
  | {
      t: 'ban'
      ban: PeerBanRecord
      reqId?: string
      ackPeers?: string[]
    }
  | {
      t: 'state'
      record: AuthoritativeStateRecord
    }
  | {
      t: 'ack'
      reqId: string
    }

export default (
  onPeer: (f: (peer: PeerHandle, id: string) => void) => void,
  onPeerLeave: (id: string) => void,
  onSelfLeave: () => void,
  {
    selfId: localSelfId = defaultSelfId,
    appId = '',
    roomId: initialRoomId = '',
    password = '',
    limit,
    topology,
    admin,
    resolvedAuthorityP,
    onPeerHandshake,
    onHandshakeError,
    handshakeTimeoutMs = defaultHandshakeTimeoutMs,
    maxReceiveBytes,
    isPassive = false,
    onBeforeLeave
  }: RoomOptions = {}
): Room => {
  const peerMap: Record<string, PeerHandle> = {}
  const activePeerMap: Record<string, PeerHandle> = {}
  const pendingPongs: Record<string, PendingPongWaiter[] | undefined> = {}
  const promotedFromVirtual = new Set<string>()
  const suppressVirtualJoin = new Set<string>()
  const knownBroadcastTracks = new Map<
    string,
    {track: MediaStreamTrack; stream: MediaStream}
  >()
  const listeners = {
    onPeerJoin: null as ((peerId: string) => void) | null,
    onPeerLeave: null as ((peerId: string) => void) | null
  }
  let unregisterBeforeUnloadCleanup: () => void = noOp
  let leavePromise: Promise<void> | null = null
  let effectiveLimit: number | undefined = limit
  const localJoinedAt = Date.now()
  let isEstablished = false
  let didRejectSelfAsFull = false
  let capacityEvalTimer: ReturnType<typeof setTimeout> | null = null
  const peerJoinMeta = new Map<string, {t: number; est: boolean}>()
  const pendingFullRejectTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >()
  const pendingAuthAckWaiters = new Map<
    string,
    {
      expectedPeers: Set<string>
      resolve: () => void
      timer: ReturnType<typeof setTimeout>
    }
  >()

  const iterate = (
    targets: TargetPeers,
    f: (id: string, peer: PeerHandle) => Promise<void> | void
  ): Promise<void>[] =>
    (targets
      ? Array.isArray(targets)
        ? targets
        : [targets]
      : keys(activePeerMap)
    ).flatMap(id => {
      const peer = activePeerMap[id]

      if (!peer) {
        console.warn(`${libName}: no peer with id ${id} found`)
        return []
      }

      return [Promise.resolve(f(id, peer))]
    })

  const kickPeer = (id: string, peer?: PeerHandle, reason?: Error): void => {
    const current = peerMap[id]

    if (!current || (peer && current !== peer)) {
      return
    }

    void leaveAction.send('', id).catch(noOp)
    exitPeer(id, current, reason)
  }

  const onPeerError = (id: string, error: Error): void =>
    kickPeer(id, undefined, error)

  const recordStreamTracks = (stream: MediaStream): void => {
    stream.getTracks?.().forEach(track => {
      if (track && typeof track.id === 'string') {
        knownBroadcastTracks.set(track.id, {track, stream})
      }
    })
  }

  const overlay = createOverlayManager({
    selfId: localSelfId,
    appId,
    roomId: initialRoomId,
    password,
    ...(topology === undefined ? {} : {topology}),
    onVirtualPeerJoin: (peerId, vPeer) => {
      if (authority.isPeerBanned(peerId)) {
        vPeer.destroy()
        return
      }
      const alreadyActive =
        Boolean(activePeerMap[peerId]) || suppressVirtualJoin.has(peerId)
      peerMap[peerId] = vPeer
      activePeerMap[peerId] = vPeer
      if (!alreadyActive) {
        listeners.onPeerJoin?.(peerId)
      }
    },
    onVirtualPeerLeave: (peerId, reason) => {
      const current = peerMap[peerId]
      if (!current || overlay.isDirectPeer(peerId)) {
        return
      }
      const wasActive = Boolean(activePeerMap[peerId])
      clearPeerState(peerId, reason)
      current.destroy()
      if (wasActive) {
        listeners.onPeerLeave?.(peerId)
      }
    },
    onDeliverData: (originPeerId, data) => {
      if (authority.isPeerBanned(originPeerId)) {
        overlay.recordSignatureFailure()
        return
      }
      handleData(originPeerId, data)
    },
    canPeerSendAction: (peerId, requiredRoles, inlineCert) =>
      authority.canPeerSendAction(peerId, requiredRoles, inlineCert),
    onPeerDescriptorCert: (peerId, signPubKey, cert) => {
      authority.registerPeerPublicKey(peerId, signPubKey)
      if (cert) {
        void authority.verifyAndApplyCert(cert)
      }
    },
    onRelayMediaStream: (
      broadcasterId,
      stream,
      metadata,
      targetPeerIds,
      streamKey
    ) => {
      void mediaManager.addStream(
        stream,
        {
          target: targetPeerIds,
          ...(metadata === undefined ? {} : {metadata})
        },
        streamMetaAction.send,
        broadcasterId,
        streamKey
      )
    },
    onRelayMediaTrack: (
      broadcasterId,
      track,
      stream,
      metadata,
      targetPeerIds,
      trackKey
    ) => {
      void mediaManager.addTrack(
        track,
        stream,
        {
          target: targetPeerIds,
          ...(metadata === undefined ? {} : {metadata})
        },
        trackMetaAction.send,
        broadcasterId,
        trackKey
      )
    }
  })

  const authority = createRoomAuthority({
    selfId: localSelfId,
    appId,
    initialRoomId,
    ...(admin === undefined ? {} : {admin}),
    ...(resolvedAuthorityP === undefined ? {} : {resolvedAuthorityP}),
    getLocalCryptoIdentity: () => overlay.getLocalCryptoIdentity(),
    getOverlayPeerPublicKey: peerId => overlay.getPeerSignPublicKey(peerId),
    isOverlayPeerBanned: peerId => overlay.isPeerBanned(peerId),
    onRoomIdResolved: effectiveRoomId => overlay.setRoomId(effectiveRoomId),
    onPeerPublicKey: (peerId, pubKey) =>
      overlay.setPeerSignPublicKey(peerId, pubKey),
    onLocalRoleCertificate: cert => overlay.setLocalRoleCertificate(cert),
    onPrivilegedPeer: (peerId, isPriv) =>
      overlay.setPrivilegedPeer(peerId, isPriv),
    onPeerBanned: (peerId, keyThumbprint) => {
      overlay.markPeerBanned(peerId, keyThumbprint)
      if (peerId !== localSelfId && peerMap[peerId]) {
        kickPeer(peerId, undefined, mkErr('peer banned'))
      }
    },
    onSignatureFailure: () => overlay.recordSignatureFailure()
  })

  const mediaManager = createMediaManager({
    onPeerError,
    iterate: (targets, f) =>
      iterate(targets, (id, peer) => f(id, peer as SharedMediaPeer)),
    isActive: id => Boolean(activePeerMap[id]),
    getSharedMediaPeer: id =>
      (peerMap[id] as SharedMediaPeer | undefined) ?? null,
    onRemoteStream: (_fromPeerId, originPeerId, stream, metadata, key) => {
      recordStreamTracks(stream)
      if (overlay.isOverlayActive() && key) {
        overlay.registerBroadcastStream(originPeerId, key, stream, metadata)
      }
    },
    onRemoteTrack: (
      _fromPeerId,
      originPeerId,
      track,
      stream,
      metadata,
      key,
      metaTrackId,
      isReplace
    ) => {
      if (
        overlay.isOverlayActive() &&
        key &&
        (isReplace || (metaTrackId && metaTrackId !== track.id))
      ) {
        const oldEntry = metaTrackId
          ? knownBroadcastTracks.get(metaTrackId)
          : undefined
        if (typeof track.id === 'string') {
          knownBroadcastTracks.set(track.id, {track, stream})
        }
        const targets = overlay.getMediaTargets(originPeerId)
        if (targets.length > 0) {
          void mediaManager.replaceTrack(
            oldEntry?.track ?? track,
            track,
            {
              target: targets,
              ...(metadata === undefined ? {} : {metadata})
            },
            trackMetaAction.send,
            originPeerId,
            key
          )
        }
        return
      }

      if (typeof track.id === 'string') {
        knownBroadcastTracks.set(track.id, {track, stream})
      }
      if (overlay.isOverlayActive() && key) {
        overlay.registerBroadcastTrack(
          originPeerId,
          key,
          track,
          stream,
          metadata
        )
      }
    }
  })

  const actionManager = createActionManager({
    onPeerError,
    ...(maxReceiveBytes === undefined ? {} : {maxReceiveBytes}),
    getPeer: (id, includePending) =>
      (includePending ? peerMap : activePeerMap)[id],
    getPeerIds: includePending =>
      keys(includePending ? peerMap : activePeerMap),
    canReceiveFromPeer: (id, receiveWhilePending) =>
      !authority.isPeerBanned(id) &&
      (Boolean(activePeerMap[id]) ||
        handshakeManager.canReceiveFromPeer(id, receiveWhilePending)),
    broadcastInline: (frame, onProgress) =>
      overlay.broadcastInline(frame, onProgress),
    registerActionAuthority: (namespace, roles) =>
      overlay.registerActionAuthority(namespace, roles),
    getPeerRoles: peerId => authority.getPeerRoles(peerId),
    onUnauthorizedAction: () => {
      overlay.recordSignatureFailure()
    },
    signActionPayload: (namespace, requiredRoles, data, userMetadata) =>
      authority.signActionPayload(namespace, requiredRoles, data, userMetadata),
    verifyActionOffer: (namespace, peerId, requiredRoles, wireMetadata) =>
      authority.verifyActionOffer(
        namespace,
        peerId,
        requiredRoles,
        wireMetadata
      ),
    verifyActionPayload: (
      namespace,
      peerId,
      requiredRoles,
      data,
      wireMetadata
    ) =>
      authority.verifyActionPayload(
        namespace,
        peerId,
        requiredRoles,
        data,
        wireMetadata
      )
  })
  const makeActionInternal = actionManager.makeInternalAction
  const handleData = actionManager.handleData
  const makeAction = actionManager.makeAction

  const clearPeerState = (
    id: string,
    reason: Error = mkErr('peer disconnected'),
    recheckCapacity = true
  ): void => {
    const err = toError(reason, 'peer disconnected')
    const rejectTimer = pendingFullRejectTimers.get(id)
    if (rejectTimer) {
      clearTimeout(rejectTimer)
      pendingFullRejectTimers.delete(id)
    }

    handshakeManager.clearPeer(id, err)
    delete peerMap[id]
    delete activePeerMap[id]
    peerJoinMeta.delete(id)
    actionManager.clearPeer(id, err)
    pendingPongs[id]?.splice(0).forEach(waiter => waiter.reject(err))
    delete pendingPongs[id]
    mediaManager.clearPeer(id)

    if (recheckCapacity && effectiveLimit !== undefined && !leavePromise) {
      scheduleCapacityCheck()
    }
  }

  const exitPeer = (id: string, peer?: PeerHandle, reason?: Error): void => {
    const current = peerMap[id]

    if (!current) {
      return
    }

    if (peer && current !== peer) {
      return
    }

    const wasActive =
      Boolean(activePeerMap[id]) || promotedFromVirtual.delete(id)
    const wasVirtual = overlay.isVirtualPeer(id)
    const wasDirect = overlay.isDirectPeer(id)

    clearPeerState(id, reason)
    current.destroy()

    if (wasDirect) {
      if (wasActive) {
        suppressVirtualJoin.add(id)
      }
      const keptAsVirtual = overlay.removeDirectPeer(id, current)
      suppressVirtualJoin.delete(id)
      if (keptAsVirtual) {
        onPeerLeave(id)
        return
      }
    } else if (!wasVirtual) {
      overlay.removeDirectPeer(id)
    }

    if (wasActive) {
      listeners.onPeerLeave?.(id)
    }

    if (!wasVirtual) {
      onPeerLeave(id)
    }
  }

  const leave = (): Promise<void> =>
    (leavePromise ??= (async () => {
      onBeforeLeave?.()
      if (capacityEvalTimer) {
        clearTimeout(capacityEvalTimer)
        capacityEvalTimer = null
      }
      for (const timer of pendingFullRejectTimers.values()) {
        clearTimeout(timer)
      }
      pendingFullRejectTimers.clear()
      overlay.announceLeave()
      const controller = new AbortController()
      void leaveAction
        .send('', undefined, undefined, undefined, controller.signal)
        .catch(noOp)
      if (!didRejectSelfAsFull) {
        await new Promise<void>(res => setTimeout(res, 99))
      }
      controller.abort()

      try {
        overlay.destroy()
        entries(peerMap).forEach(([id, peer]) => {
          peer.destroy()
          clearPeerState(id, mkErr('room left'), false)
        })
      } finally {
        try {
          unregisterBeforeUnloadCleanup()
        } finally {
          onSelfLeave()
        }
      }
    })())

  const pingAction = makeActionInternal<string>(internalNs('ping'))
  const pongAction = makeActionInternal<string>(internalNs('pong'))
  const signalAction = makeActionInternal(internalNs('signal'))
  const streamMetaAction = makeActionInternal<InternalMediaMeta>(
    internalNs('stream'),
    {maxPayloadBytes: 64 * 1024}
  )
  const trackMetaAction = makeActionInternal<InternalMediaMeta>(
    internalNs('track'),
    {maxPayloadBytes: 64 * 1024}
  )
  const mediaControlAction = makeActionInternal<MediaControlMessage>(
    internalNs('mctrl')
  )
  const leaveAction = makeActionInternal<string>(internalNs('leave'), {
    sendToPending: true,
    receiveWhilePending: true
  })
  const handshakeDataAction = makeActionInternal<DataPayload>(
    internalNs('hsdata'),
    {sendToPending: true, receiveWhilePending: true, maxPayloadBytes: 64 * 1024}
  )
  const handshakeReadyAction = makeActionInternal<HandshakeReadyPayload>(
    internalNs('hsready'),
    {sendToPending: true, receiveWhilePending: true, maxPayloadBytes: 64 * 1024}
  )
  const rawAuthAction = makeActionInternal<JsonValue>(internalNs('auth'), {
    maxPayloadBytes: 256 * 1024
  })
  const authAction = {
    send: (msg: AuthControlMessage, targets?: TargetPeers) =>
      rawAuthAction.send(msg as unknown as JsonValue, targets),
    onMessage: (f: (data: AuthControlMessage, peerId: string) => void) =>
      rawAuthAction.onMessage((data, peerId) =>
        f(data as unknown as AuthControlMessage, peerId)
      )
  }

  const sendAuthSyncToPeer = async (
    targetPeerId: string,
    force = false
  ): Promise<void> => {
    if (
      !targetPeerId ||
      targetPeerId === localSelfId ||
      authority.isPeerBanned(targetPeerId)
    ) {
      return
    }
    const syncPayload = await authority.buildSyncMessage(force)
    if (!syncPayload || !activePeerMap[targetPeerId]) {
      return
    }
    await authAction
      .send(
        {
          t: 'sync',
          ...syncPayload
        },
        targetPeerId
      )
      .catch(noOp)
  }

  const waitForAuthAck = (
    reqId: string,
    targetPeers: string[],
    timeoutMs = 150
  ): Promise<void> => {
    const activeTargets = targetPeers.filter(
      id => id !== localSelfId && Boolean(activePeerMap[id])
    )
    if (activeTargets.length === 0) {
      return Promise.resolve()
    }
    return new Promise<void>(resolve => {
      const expectedPeers = new Set(activeTargets)
      const timer = setTimeout(() => {
        pendingAuthAckWaiters.delete(reqId)
        resolve()
      }, timeoutMs)
      pendingAuthAckWaiters.set(reqId, {
        expectedPeers,
        resolve: () => {
          clearTimeout(timer)
          pendingAuthAckWaiters.delete(reqId)
          resolve()
        },
        timer
      })
    })
  }

  authAction.onMessage((msg, fromPeerId) => {
    if (!msg || typeof msg !== 'object') {
      return
    }
    if (msg.t === 'ack' && typeof msg.reqId === 'string') {
      const waiter = pendingAuthAckWaiters.get(msg.reqId)
      if (waiter) {
        waiter.expectedPeers.delete(fromPeerId)
        if (waiter.expectedPeers.size === 0) {
          waiter.resolve()
        }
      }
      return
    }
    if (msg.t === 'whois') {
      void sendAuthSyncToPeer(fromPeerId, true)
      return
    }
    if (msg.t === 'sync') {
      void (async () => {
        if (msg.pubKey) {
          authority.registerPeerPublicKey(fromPeerId, msg.pubKey)
        }
        const newBans: PeerBanRecord[] = []
        const newRevs: RoleRevocationRecord[] = []
        const newCerts: RoleCertificate[] = []
        const newStates: AuthoritativeStateRecord[] = []

        if (Array.isArray(msg.bans)) {
          for (const b of msg.bans) {
            if (await authority.verifyAndApplyBan(b)) {
              newBans.push(b)
            }
          }
        }
        if (Array.isArray(msg.revocations)) {
          for (const r of msg.revocations) {
            if (await authority.verifyAndApplyRevocation(r)) {
              newRevs.push(r)
            }
          }
        }
        if (Array.isArray(msg.certs)) {
          for (const c of msg.certs) {
            if (await authority.verifyAndApplyCert(c)) {
              newCerts.push(c)
            }
          }
        }
        if (Array.isArray(msg.states)) {
          for (const s of msg.states) {
            if (await authority.verifyAndApplyStateRecord(s)) {
              newStates.push(s)
            }
          }
        }

        if (
          newBans.length > 0 ||
          newRevs.length > 0 ||
          newCerts.length > 0 ||
          newStates.length > 0
        ) {
          const directNeighbors = overlay
            .getSnapshot()
            .directPeerIds.filter(id => id !== fromPeerId && id !== localSelfId)
          if (directNeighbors.length > 0) {
            void authAction
              .send(
                {
                  t: 'sync',
                  ...(newCerts.length > 0 ? {certs: newCerts} : {}),
                  ...(newRevs.length > 0 ? {revocations: newRevs} : {}),
                  ...(newBans.length > 0 ? {bans: newBans} : {}),
                  ...(newStates.length > 0 ? {states: newStates} : {})
                },
                directNeighbors
              )
              .catch(noOp)
          }
        }
      })()
      return
    }
    if (msg.t === 'cert') {
      void authority.verifyAndApplyCert(msg.cert).then(applied => {
        if (
          msg.reqId &&
          (!msg.ackPeers || msg.ackPeers.includes(localSelfId))
        ) {
          void authAction
            .send({t: 'ack', reqId: msg.reqId}, fromPeerId)
            .catch(noOp)
        }
        if (!applied && !authority.hasCertForPeer(msg.cert?.subPeerId)) {
          overlay.recordSignatureFailure()
        }
      })
      return
    }
    if (msg.t === 'revoke') {
      void authority.verifyAndApplyRevocation(msg.revocation).then(applied => {
        if (
          msg.reqId &&
          (!msg.ackPeers || msg.ackPeers.includes(localSelfId))
        ) {
          void authAction
            .send({t: 'ack', reqId: msg.reqId}, fromPeerId)
            .catch(noOp)
        }
        if (!applied && !authority.hasRevocationSig(msg.revocation?.sig)) {
          overlay.recordSignatureFailure()
        }
      })
      return
    }
    if (msg.t === 'ban') {
      void authority.verifyAndApplyBan(msg.ban).then(applied => {
        if (
          msg.reqId &&
          (!msg.ackPeers || msg.ackPeers.includes(localSelfId))
        ) {
          void authAction
            .send({t: 'ack', reqId: msg.reqId}, fromPeerId)
            .catch(noOp)
        }
        if (
          !applied &&
          !authority.hasBanSig(msg.ban?.targetPeerId, msg.ban?.sig)
        ) {
          overlay.recordSignatureFailure()
        }
      })
      return
    }
    if (msg.t === 'state') {
      void authority.verifyAndApplyStateRecord(msg.record)
    }
  })

  const isAlreadyFullForPeer = (id: string): boolean => {
    if (activePeerMap[id] || promotedFromVirtual.has(id)) {
      return false
    }
    if (effectiveLimit === undefined) {
      return false
    }
    return effectiveLimit === 1
      ? isEstablished
      : keys(activePeerMap).length + 1 >= effectiveLimit
  }

  const rejectPeerAsFull = (id: string, peer: PeerHandle): void => {
    if (pendingFullRejectTimers.has(id) || peerMap[id] !== peer) {
      return
    }
    void handshakeReadyAction
      .send(
        {
          ok: false,
          err: 'room full',
          ...(effectiveLimit === undefined ? {} : {limit: effectiveLimit})
        },
        id
      )
      .catch(noOp)
    handshakeManager.clearPeer(id, mkErr('room full'))
    peerJoinMeta.delete(id)
    const timer = setTimeout(() => {
      pendingFullRejectTimers.delete(id)
      exitPeer(id, peer, mkErr('room full'))
    }, 50)
    pendingFullRejectTimers.set(id, timer)
  }

  const handleSelfRejectedAsFull = (byPeerId: string): void => {
    if (didRejectSelfAsFull || leavePromise) {
      return
    }
    didRejectSelfAsFull = true
    entries(peerMap).forEach(([pid]) => {
      handshakeManager.clearPeer(pid, mkErr('room full'))
    })
    void leave().catch(noOp)
    onHandshakeError?.(byPeerId, 'room full')
  }

  const evaluateCapacityAdmissions = (): void => {
    if (effectiveLimit === undefined || didRejectSelfAsFull || leavePromise) {
      return
    }

    const readyIds = handshakeManager
      .getReadyPendingIds()
      .filter(id => !pendingFullRejectTimers.has(id))

    if (readyIds.length === 0) {
      return
    }

    const rankPeer = (id: string): {id: string; est: boolean; t: number} => {
      if (id === localSelfId) {
        return {
          id,
          est: isEstablished || keys(activePeerMap).length > 0,
          t: localJoinedAt
        }
      }
      const meta = peerJoinMeta.get(id)
      return {
        id,
        est: Boolean(activePeerMap[id]) || Boolean(meta?.est),
        t: meta?.t ?? localJoinedAt
      }
    }

    const candidateIds = new Set<string>([
      localSelfId,
      ...keys(activePeerMap),
      ...readyIds
    ])
    const sorted = [...candidateIds].map(rankPeer).sort((a, b) => {
      if (a.est !== b.est) {
        return a.est ? -1 : 1
      }
      if (a.t !== b.t) {
        return a.t - b.t
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })

    const winners = new Set(sorted.slice(0, effectiveLimit).map(c => c.id))

    if (!winners.has(localSelfId)) {
      const winnerPeerId =
        sorted.find(c => c.id !== localSelfId && winners.has(c.id))?.id ??
        readyIds[0] ??
        localSelfId
      handleSelfRejectedAsFull(winnerPeerId)
      return
    }

    if (effectiveLimit === 1) {
      isEstablished = true
    }

    for (const id of readyIds) {
      const peer = handshakeManager.getPeer(id) ?? peerMap[id]
      if (!peer) {
        continue
      }
      if (winners.has(id) && keys(activePeerMap).length + 1 < effectiveLimit) {
        handshakeManager.activate(id)
      } else {
        rejectPeerAsFull(id, peer)
      }
    }
  }

  const scheduleCapacityCheck = (): void => {
    if (effectiveLimit === undefined || didRejectSelfAsFull || leavePromise) {
      return
    }
    if (capacityEvalTimer) {
      clearTimeout(capacityEvalTimer)
    }
    capacityEvalTimer = setTimeout(() => {
      capacityEvalTimer = null
      evaluateCapacityAdmissions()
    }, 25)
  }

  const handshakeManager = createHandshakeManager({
    selfId: localSelfId,
    ...(onPeerHandshake === undefined ? {} : {onPeerHandshake}),
    ...(onHandshakeError === undefined ? {} : {onHandshakeError}),
    handshakeTimeoutMs,
    sendHandshakeData: handshakeDataAction.send,
    sendHandshakeReady: handshakeReadyAction.send,
    canAcceptBeforeHandshake: id =>
      Boolean(password) || !isAlreadyFullForPeer(id),
    onRejectFull: (id, peer) => rejectPeerAsFull(id, peer),
    onLocalHandshakePassed: (id, peer) => {
      if (isAlreadyFullForPeer(id)) {
        rejectPeerAsFull(id, peer)
        return null
      }
      if (effectiveLimit === undefined) {
        return ''
      }
      scheduleCapacityCheck()
      return {
        ok: true,
        limit: effectiveLimit,
        t: localJoinedAt,
        est: isEstablished || keys(activePeerMap).length > 0
      }
    },
    onRemoteHandshakeReady: (id, _peer, data) => {
      if (data && typeof data === 'object') {
        if (
          typeof data.limit === 'number' &&
          Number.isSafeInteger(data.limit) &&
          data.limit >= 1
        ) {
          effectiveLimit =
            effectiveLimit === undefined
              ? data.limit
              : Math.min(effectiveLimit, data.limit)
        }
        if (!data.ok && data.err === 'room full') {
          handleSelfRejectedAsFull(id)
          return true
        }
        peerJoinMeta.set(id, {
          t: typeof data.t === 'number' ? data.t : Date.now(),
          est: Boolean(activePeerMap[id]) || Boolean(data.est)
        })
      }
      if (effectiveLimit !== undefined) {
        scheduleCapacityCheck()
        return true
      }
      return false
    },
    onActivate: (id, peer) => {
      if (authority.isPeerBanned(id)) {
        kickPeer(id, peer, mkErr('peer banned'))
        return
      }
      isEstablished = true
      const alreadyJoined = promotedFromVirtual.delete(id)
      activePeerMap[id] = peer
      overlay.addDirectPeer(id, peer)
      void sendAuthSyncToPeer(id)
      if (
        effectiveLimit !== undefined &&
        keys(activePeerMap).length + 1 >= effectiveLimit
      ) {
        for (const pendingId of handshakeManager.getPendingIds()) {
          if (
            !activePeerMap[pendingId] &&
            !pendingFullRejectTimers.has(pendingId)
          ) {
            const pendingPeer =
              handshakeManager.getPeer(pendingId) ?? peerMap[pendingId]
            if (pendingPeer) {
              rejectPeerAsFull(pendingId, pendingPeer)
            }
          }
        }
      }
      peer.setHandlers({
        signal: sdp => {
          if (activePeerMap[id] === peer) {
            void signalAction
              .send(sdp as unknown as DataPayload, id)
              .catch(noOp)
          }
        }
      })
      if (!alreadyJoined) {
        listeners.onPeerJoin?.(id)
      }
    },
    onFailure: (id, peer, reason) => kickPeer(id, peer, reason)
  })

  pingAction.onMessage((_, id) => {
    void pongAction.send('', id).catch(noOp)
  })

  pongAction.onMessage((_, id) => {
    const queue = pendingPongs[id]
    const waiter = queue?.shift()

    waiter?.resolve()

    if (queue && !queue.length) {
      delete pendingPongs[id]
    }
  })

  signalAction.onMessage((sdp, id) => {
    void activePeerMap[id]?.signal(sdp as never)
  })

  streamMetaAction.onMessage((meta, id) =>
    mediaManager.receiveStreamMeta(meta, id)
  )

  trackMetaAction.onMessage((meta, id) =>
    mediaManager.receiveTrackMeta(meta, id)
  )

  mediaControlAction.onMessage(msg => {
    if (!msg || typeof msg !== 'object') {
      return
    }
    if (msg.op === 'rmStream' && typeof msg.o === 'string') {
      const removed = overlay.unregisterBroadcastStreamById(msg.o, msg.id)
      if (removed && removed.targets.length > 0) {
        mediaManager.removeStream(removed.stream, removed.targets)
      }
    }
  })

  leaveAction.onMessage((_, id) =>
    exitPeer(id, undefined, mkErr('peer left room'))
  )

  handshakeDataAction.onMessage((data, id, metadata) =>
    handshakeManager.receiveHandshakeData(data, id, metadata)
  )

  handshakeReadyAction.onMessage((data, id) =>
    handshakeManager.receiveHandshakeReady(id, data)
  )

  onPeer((peer, id) => {
    if (authority.isPeerBanned(id)) {
      peer.destroy()
      return
    }
    const existingPeer = peerMap[id]
    const wasVirtual = Boolean(existingPeer && overlay.isVirtualPeer(id))

    if (existingPeer) {
      if (existingPeer === peer) {
        return
      }

      existingPeer.destroy()
      if (wasVirtual) {
        promotedFromVirtual.add(id)
        delete peerMap[id]
      } else {
        clearPeerState(id, mkErr('peer replaced'))
      }
    }

    peerMap[id] = peer
    handshakeManager.addPeer(id, peer)

    peer.setHandlers({
      data: d => {
        if (peerMap[id] === peer) {
          if (overlay.isOverlayFrame(d)) {
            overlay.handleOverlayFrame(id, d)
          } else {
            handleData(id, d)
          }
        }
      },
      stream: stream => mediaManager.receiveRemoteStream(id, stream),
      track: (track, stream) =>
        mediaManager.receiveRemoteTrack(id, track, stream),
      close: () => exitPeer(id, peer, mkErr('peer disconnected')),
      error: (err: Error) => {
        console.error(`${libName} peer error:`, err)
        exitPeer(id, peer, err)
      }
    })

    handshakeManager.start(id, peer)
  })

  if (isBrowser) {
    unregisterBeforeUnloadCleanup = registerBeforeUnloadCleanup(() =>
      leave().catch(noOp)
    )
  }

  const roomInstance: Room = {
    makeAction,

    makeState: <T extends JsonValue = JsonValue>(
      namespace: string,
      initialValue: T,
      config?: StateConfig<T>
    ): AuthoritativeState<T> =>
      authority.makeState(namespace, initialValue, config, async record => {
        await authAction
          .send({
            t: 'state',
            record
          })
          .catch(noOp)
      }),

    getAuthority: (): Promise<RoomAuthorityInfo> =>
      authority.getAuthorityInfo(),

    grantRole: async (peerId, role, options) => {
      const cert = await authority.issueRoleCertificate(
        peerId,
        role,
        options,
        () => {
          void authAction.send({t: 'whois'}, peerId).catch(noOp)
        }
      )
      const reqId = genId(12)
      const allActive = keys(activePeerMap)
      const boundedAckPeers =
        allActive.length > 16
          ? [...new Set([...overlay.getSnapshot().directPeerIds, peerId])]
          : undefined
      const ackWait = waitForAuthAck(reqId, boundedAckPeers ?? allActive)
      await authAction
        .send({
          t: 'cert',
          cert,
          reqId,
          ...(boundedAckPeers ? {ackPeers: boundedAckPeers} : {})
        })
        .catch(noOp)
      await ackWait
      return cert
    },

    revokeRole: async (peerId, role) => {
      const revocation = await authority.issueRoleRevocation(peerId, role)
      const reqId = genId(12)
      const allActive = keys(activePeerMap)
      const boundedAckPeers =
        allActive.length > 16
          ? [...new Set([...overlay.getSnapshot().directPeerIds, peerId])]
          : undefined
      const ackWait = waitForAuthAck(reqId, boundedAckPeers ?? allActive)
      await authAction
        .send({
          t: 'revoke',
          revocation,
          reqId,
          ...(boundedAckPeers ? {ackPeers: boundedAckPeers} : {})
        })
        .catch(noOp)
      await ackWait
    },

    getPeerRoles: (peerId?: string) =>
      authority.getPeerRoles(peerId ?? localSelfId),

    banPeer: async (peerId, options) => {
      const otherPeers = keys(activePeerMap).filter(id => id !== peerId)
      const ban = await authority.issuePeerBan(peerId, options)
      const reqId = genId(12)
      const boundedAckPeers =
        otherPeers.length > 16
          ? overlay.getSnapshot().directPeerIds.filter(id => id !== peerId)
          : undefined
      const ackWait = waitForAuthAck(reqId, boundedAckPeers ?? otherPeers)
      await authAction
        .send({
          t: 'ban',
          ban,
          reqId,
          ...(boundedAckPeers ? {ackPeers: boundedAckPeers} : {})
        })
        .catch(noOp)
      await ackWait
    },

    isBanned: peerId => authority.isPeerBanned(peerId),

    leave,

    ping: async id => {
      if (!activePeerMap[id]) {
        throw mkErr(`no active peer with id ${id}`)
      }

      const start = Date.now()

      await new Promise<void>((resolve, reject) => {
        const queue = (pendingPongs[id] ??= [])

        const clearFromQueue = (): void => {
          const currentQueue = pendingPongs[id]

          if (!currentQueue) {
            return
          }

          const i = currentQueue.indexOf(waiter)

          if (i > -1) {
            currentQueue.splice(i, 1)
          }

          if (!currentQueue.length) {
            delete pendingPongs[id]
          }
        }

        const waiter: PendingPongWaiter = {
          resolve: () => {
            clearFromQueue()
            resolve()
          },
          reject: reason => {
            clearFromQueue()
            reject(reason)
          }
        }

        queue.push(waiter)
        void pingAction
          .send('', id)
          .catch(err => waiter.reject(toError(err, 'peer disconnected')))
      })

      return Date.now() - start
    },

    isPassive: () => isPassive,

    getPeers: () =>
      fromEntries(
        entries(activePeerMap).map(([id, peer]) => {
          const direct = !overlay.isVirtualPeer(id)
          const hops = direct ? 1 : (overlay.getRoute(id)?.hops ?? 2)
          return [
            id,
            {
              connection: direct ? peer.connection : null,
              direct,
              hops,
              roles: authority.getPeerRoles(id)
            }
          ]
        })
      ),

    getTopology: () => overlay.getSnapshot(),

    addStream: (stream, options: AddMediaOptions = {}) => {
      recordStreamTracks(stream)
      if (overlay.isOverlayActive() && !options.target) {
        const streamKey = genId(20)
        overlay.registerBroadcastStream(
          localSelfId,
          streamKey,
          stream,
          options.metadata
        )
        const targets = overlay.getMediaTargets(localSelfId)
        if (!targets.length) {
          return []
        }
        return mediaManager.addStream(
          stream,
          {...options, target: targets},
          streamMetaAction.send,
          localSelfId,
          streamKey
        )
      }
      return mediaManager.addStream(stream, options, streamMetaAction.send)
    },

    removeStream: (stream, options = {}) => {
      if (overlay.isOverlayActive() && !options.target) {
        const targets = overlay.unregisterBroadcastStream(localSelfId, stream)
        if (targets.length > 0) {
          mediaManager.removeStream(stream, targets)
        }
        if (typeof stream.id === 'string') {
          void mediaControlAction
            .send({op: 'rmStream', o: localSelfId, id: stream.id})
            .catch(noOp)
        }
        return
      }
      mediaManager.removeStream(stream, options.target)
    },

    addTrack: (track, stream, options: AddMediaOptions = {}) => {
      if (typeof track.id === 'string') {
        knownBroadcastTracks.set(track.id, {track, stream})
      }
      if (overlay.isOverlayActive() && !options.target) {
        const trackKey = genId(20)
        overlay.registerBroadcastTrack(
          localSelfId,
          trackKey,
          track,
          stream,
          options.metadata
        )
        const targets = overlay.getMediaTargets(localSelfId)
        if (!targets.length) {
          return []
        }
        return mediaManager.addTrack(
          track,
          stream,
          {...options, target: targets},
          trackMetaAction.send,
          localSelfId,
          trackKey
        )
      }
      return mediaManager.addTrack(track, stream, options, trackMetaAction.send)
    },

    removeTrack: (track, options = {}) => {
      mediaManager.removeTrack(track, options.target)
    },

    replaceTrack: (oldTrack, newTrack, options: AddMediaOptions = {}) => {
      const existing =
        typeof oldTrack.id === 'string'
          ? knownBroadcastTracks.get(oldTrack.id)
          : undefined
      if (typeof newTrack.id === 'string') {
        knownBroadcastTracks.set(newTrack.id, {
          track: newTrack,
          stream: existing?.stream ?? ({} as MediaStream)
        })
      }
      if (overlay.isOverlayActive() && !options.target) {
        const trackKey = genId(20)
        const targets = overlay.getMediaTargets(localSelfId)
        if (!targets.length) {
          return []
        }
        return mediaManager.replaceTrack(
          oldTrack,
          newTrack,
          {...options, target: targets},
          trackMetaAction.send,
          localSelfId,
          trackKey
        )
      }
      return mediaManager.replaceTrack(
        oldTrack,
        newTrack,
        options,
        trackMetaAction.send
      )
    },

    get onPeerJoin() {
      return listeners.onPeerJoin
    },

    set onPeerJoin(handler) {
      listeners.onPeerJoin = handler

      if (handler) {
        keys(activePeerMap).forEach(peerId => handler(peerId))
      }
    },

    get onPeerLeave() {
      return listeners.onPeerLeave
    },

    set onPeerLeave(handler) {
      listeners.onPeerLeave = handler
    },

    get onPeerStream() {
      return mediaManager.onPeerStream
    },

    set onPeerStream(handler) {
      mediaManager.onPeerStream = handler
    },

    get onPeerTrack() {
      return mediaManager.onPeerTrack
    },

    set onPeerTrack(handler) {
      mediaManager.onPeerTrack = handler
    }
  }

  roomSignalingBridges.set(roomInstance, {
    overlay,
    getAnnounceExtra: authority.getAnnounceExtra,
    onSignalingPayload: authority.onSignalingPayload,
    checkCapacityAfterPassword: peerId => {
      if (isAlreadyFullForPeer(peerId)) {
        throw roomFullHostRejectErr
      }
    }
  })

  return roomInstance
}
