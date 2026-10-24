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
  type HandshakeReadyPayload,
  type VerifiedPeerIdentity
} from './handshake'
import {
  defaultUserIdentity,
  getDefaultTestUserIdentity,
  getDefaultTestUserIdentityUserIdSync,
  resolveUserIdentity
} from './identity'
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
  PeerJoinContext,
  PeerLeaveContext,
  RoleCertificate,
  RoleRevocationRecord,
  Room,
  RoomAuthorityInfo,
  SelfInfo,
  SharedMediaPeer,
  StateConfig,
  TargetPeers,
  TopologyConfig,
  TopologyMode,
  UserIdentity,
  UserIdentityConfig,
  UserInfo,
  UserJoinContext,
  UserLeaveContext
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
  onPeerIdentityVerified: (
    peerId: string,
    verified: VerifiedPeerIdentity
  ) => void
  getPeerHandle: (peerId: string) => PeerHandle | undefined
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
  admin?: boolean | string | string[] | AuthorityConfig
  identity?: UserIdentityConfig
  resolvedAuthorityP?: Promise<ResolvedRoomAuthority>
  userIdentityP?: Promise<UserIdentity>
  verifyPeerIdentity?: boolean
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

type MediaControlMessage =
  | {op: 'connect'}
  | {
      op: 'rmStream' | 'rmTrack'
      o: string
      id: string
      keys?: string[]
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
    identity,
    resolvedAuthorityP,
    userIdentityP,
    verifyPeerIdentity = false,
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
  const peerUserIds = new Map<string, string>()
  const activeUserPeers = new Map<string, Set<string>>()
  let localUserId = defaultUserIdentity.userId
  DEV: localUserId = getDefaultTestUserIdentityUserIdSync(localSelfId)
  let defaultIdentityP: Promise<UserIdentity> | undefined
  DEV: if (!userIdentityP && identity === undefined) {
    defaultIdentityP = getDefaultTestUserIdentity(localSelfId)
  }
  const resolvedUserIdentityP = (
    userIdentityP ??
    defaultIdentityP ??
    resolveUserIdentity(
      appId,
      initialRoomId,
      identity === undefined ? undefined : {identity},
      localSelfId
    )
  ).then(resolvedId => {
    localUserId = resolvedId.userId
    return resolvedId
  })

  const getPeerUserId = (peerId: string): string => {
    if (peerId === localSelfId) {
      return localUserId
    }
    let userId = peerUserIds.get(peerId)
    DEV: userId ??= getDefaultTestUserIdentityUserIdSync(peerId)
    return userId ?? peerId
  }

  const getUserPeerIds = (userId: string): string[] => {
    const set = activeUserPeers.get(userId)
    if (set && set.size > 0) {
      return [...set]
    }
    const matching: string[] = []
    for (const pid of keys(peerMap)) {
      if (getPeerUserId(pid) === userId) {
        matching.push(pid)
      }
    }
    return matching
  }

  const resolveSendTarget = (
    targets: TargetPeers,
    includePending = false
  ): TargetPeers => {
    if (!targets) {
      return undefined
    }
    const map = includePending ? peerMap : activePeerMap
    const list = Array.isArray(targets) ? targets : [targets]
    const resolved: string[] = []
    const seen = new Set<string>()
    const addPeer = (pid: string): void => {
      if (!seen.has(pid)) {
        seen.add(pid)
        resolved.push(pid)
      }
    }

    for (const id of list) {
      if (map[id]) {
        addPeer(id)
        continue
      }
      const userPeers = activeUserPeers.get(id)
      if (userPeers && userPeers.size > 0) {
        for (const pid of userPeers) {
          if (map[pid]) {
            addPeer(pid)
          }
        }
        continue
      }
      let matchedByUser = false
      for (const pid of keys(map)) {
        if (getPeerUserId(pid) === id) {
          addPeer(pid)
          matchedByUser = true
        }
      }
      if (!matchedByUser) {
        addPeer(id)
      }
    }
    return resolved
  }

  const resolveRequestTarget = (
    target: string,
    includePending = false
  ): string | undefined => {
    const map = includePending ? peerMap : activePeerMap
    if (map[target]) {
      return target
    }
    const candidates: string[] = []
    for (const pid of keys(map)) {
      if (getPeerUserId(pid) === target) {
        candidates.push(pid)
      }
    }
    if (candidates.length === 0) {
      return undefined
    }
    candidates.sort((a, b) => {
      const aDirect = !overlay.isVirtualPeer(a)
      const bDirect = !overlay.isVirtualPeer(b)
      if (aDirect !== bDirect) {
        return aDirect ? -1 : 1
      }
      return a < b ? -1 : a > b ? 1 : 0
    })
    return candidates[0]
  }

  const pendingPongs: Record<string, PendingPongWaiter[] | undefined> = {}
  const promotedFromVirtual = new Set<string>()
  const suppressVirtualJoin = new Set<string>()
  const knownBroadcastTracks = new Map<
    string,
    {track: MediaStreamTrack; stream: MediaStream}
  >()
  const pendingMediaPeers = new Map<
    string,
    {
      promise: Promise<SharedMediaPeer>
      resolve: (peer: SharedMediaPeer) => void
      reject: (reason: Error) => void
    }
  >()

  const ensureMediaPeer = (
    id: string,
    peer: SharedMediaPeer
  ): Promise<SharedMediaPeer> => {
    if (overlay.isDirectPeer(id)) {
      return Promise.resolve(peer)
    }
    const pending = pendingMediaPeers.get(id)
    if (pending) {
      return pending.promise
    }
    let resolve!: (peer: SharedMediaPeer) => void
    let reject!: (reason: Error) => void
    const promise = new Promise<SharedMediaPeer>((res, rej) => {
      resolve = res
      reject = rej
    })
    const timer = setTimeout(
      () => reject(mkErr('timed out connecting media peer')),
      handshakeTimeoutMs
    )
    const settled = promise.finally(() => {
      clearTimeout(timer)
      pendingMediaPeers.delete(id)
    })
    pendingMediaPeers.set(id, {promise: settled, resolve, reject})
    void mediaControlAction
      .send({op: 'connect'}, id)
      .then(() => {
        if (!leavePromise) {
          overlay.requireDirectPeer(id)
        }
      })
      .catch(err => reject(toError(err, 'failed connecting media peer')))
    return settled
  }
  const listeners = {
    onPeerJoin: null as ((context: PeerJoinContext) => void) | null,
    onPeerLeave: null as ((context: PeerLeaveContext) => void) | null,
    onUserJoin: null as ((context: UserJoinContext) => void) | null,
    onUserLeave: null as ((context: UserLeaveContext) => void) | null
  }

  const notifyPeerActivated = (peerId: string): void => {
    const userId = getPeerUserId(peerId)
    peerUserIds.set(peerId, userId)
    let peers = activeUserPeers.get(userId)
    const isFirstForUser = !peers || peers.size === 0
    if (!peers) {
      peers = new Set()
      activeUserPeers.set(userId, peers)
    }
    peers.add(peerId)
    const roles = authority.getPeerRoles(peerId)
    listeners.onPeerJoin?.({peerId, userId, roles})
    if (isFirstForUser && userId !== localUserId) {
      listeners.onUserJoin?.({userId, peerId, roles})
    }
  }

  const notifyPeerDeactivated = (peerId: string): void => {
    const userId = getPeerUserId(peerId)
    const peers = activeUserPeers.get(userId)
    let isLastForUser = false
    if (peers) {
      peers.delete(peerId)
      if (peers.size === 0) {
        activeUserPeers.delete(userId)
        isLastForUser = true
      }
    }
    listeners.onPeerLeave?.({peerId, userId})
    if (isLastForUser && userId !== localUserId) {
      listeners.onUserLeave?.({userId, peerId})
    }
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
  ): Promise<void>[] => {
    const resolvedTargets = resolveSendTarget(targets)
    return (
      resolvedTargets
        ? Array.isArray(resolvedTargets)
          ? resolvedTargets
          : [resolvedTargets]
        : keys(activePeerMap)
    ).flatMap(id => {
      const peer = activePeerMap[id]

      if (!peer) {
        console.warn(`${libName}: no peer with id ${id} found`)
        return []
      }

      return [Promise.resolve(f(id, peer))]
    })
  }

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
    getLocalUserIdentity: () => resolvedUserIdentityP,
    onVirtualPeerJoin: (peerId, vPeer) => {
      if (authority.isPeerBanned(peerId)) {
        vPeer.destroy()
        return
      }
      const alreadyActive =
        Boolean(activePeerMap[peerId]) || suppressVirtualJoin.has(peerId)
      if (peerMap[peerId] && peerMap[peerId] !== activePeerMap[peerId]) {
        // Preserve the physical transport while its room handshake completes.
        promotedFromVirtual.add(peerId)
      } else {
        peerMap[peerId] = vPeer
      }
      activePeerMap[peerId] = vPeer
      if (!alreadyActive) {
        notifyPeerActivated(peerId)
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
        notifyPeerDeactivated(peerId)
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
    onPeerDescriptorCert: (peerId, signPubKey, cert, userId, _userPubKey) => {
      if (userId) {
        peerUserIds.set(peerId, userId)
      }
      if (
        authority.isPeerBanned(peerId) ||
        (userId && authority.isPeerBanned(userId))
      ) {
        overlay.markPeerBanned(peerId)
        return
      }
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
      streamKey,
      tracks
    ) => {
      void mediaManager.addStream(
        stream,
        {
          target: targetPeerIds,
          ...(metadata === undefined ? {} : {metadata})
        },
        streamMetaAction.send,
        broadcasterId,
        streamKey,
        tracks
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
    getLocalUserIdentity: () => resolvedUserIdentityP,
    getOverlayPeerPublicKey: peerId => overlay.getPeerSignPublicKey(peerId),
    isOverlayPeerBanned: peerId => overlay.isPeerBanned(peerId),
    getPeerUserId: peerId => {
      if (peerId === localSelfId) {
        return localUserId
      }
      let userId = peerUserIds.get(peerId)
      DEV: if (!userId && peerId in peerMap) {
        userId = getDefaultTestUserIdentityUserIdSync(peerId)
      }
      return userId
    },
    getUserPeerIds: userId => getUserPeerIds(userId),
    onRoomIdResolved: effectiveRoomId => overlay.setRoomId(effectiveRoomId),
    onPeerPublicKey: (peerId, pubKey) =>
      overlay.setPeerSignPublicKey(peerId, pubKey),
    onLocalRoleCertificate: cert => overlay.setLocalRoleCertificate(cert),
    onPrivilegedPeer: (peerId, isPriv) =>
      overlay.setPrivilegedPeer(peerId, isPriv),
    onPeerBanned: (peerId, keyThumbprint, targetUserId) => {
      overlay.markPeerBanned(peerId, keyThumbprint)
      if (peerId !== localSelfId && peerMap[peerId]) {
        kickPeer(peerId, undefined, mkErr('peer banned'))
      }
      if (targetUserId) {
        for (const pid of keys(peerMap)) {
          if (pid !== localSelfId && getPeerUserId(pid) === targetUserId) {
            overlay.markPeerBanned(pid)
            kickPeer(pid, undefined, mkErr('peer banned'))
          }
        }
      }
    },
    onSignatureFailure: () => overlay.recordSignatureFailure()
  })

  const mediaManager = createMediaManager({
    onPeerError,
    getPeerUserId,
    preparePeer: ensureMediaPeer,
    iterate: (targets, f) =>
      iterate(targets, (id, peer) => f(id, peer as SharedMediaPeer)),
    isActive: id => Boolean(activePeerMap[id]),
    getSharedMediaPeer: id =>
      (peerMap[id] as SharedMediaPeer | undefined) ?? null,
    onRemoteStream: (stream, {originPeerId, metadata, key, broadcast}) => {
      recordStreamTracks(stream)
      if (overlay.isOverlayActive() && broadcast) {
        overlay.registerBroadcastStream(originPeerId, key, stream, metadata)
      }
    },
    onRemoteTrack: (
      track,
      stream,
      {
        originPeerId,
        metadata,
        key,
        trackId: metaTrackId,
        replacementId,
        isReplace,
        broadcast
      }
    ) => {
      if (
        overlay.isOverlayActive() &&
        broadcast &&
        (isReplace || (metaTrackId && metaTrackId !== track.id))
      ) {
        const oldEntry = metaTrackId
          ? knownBroadcastTracks.get(metaTrackId)
          : undefined
        if (replacementId) {
          knownBroadcastTracks.set(replacementId, {track, stream})
        }
        overlay.replaceBroadcastTrack(
          originPeerId,
          oldEntry?.track ?? track,
          track,
          metadata
        )
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
            key,
            replacementId
          )
        }
        return
      }

      if (typeof track.id === 'string') {
        knownBroadcastTracks.set(track.id, {track, stream})
      }
      if (overlay.isOverlayActive() && broadcast) {
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
    getPeerUserId,
    resolveSendTarget,
    resolveRequestTarget,
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
    pendingMediaPeers.get(id)?.reject(err)
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
      notifyPeerDeactivated(id)
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
      entries(peerMap).forEach(([id]) => {
        handshakeManager.clearPeer(id, mkErr('room left'))
      })
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
        activeUserPeers.clear()
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

        if (Array.isArray(msg.certs)) {
          for (const c of msg.certs) {
            if (await authority.verifyAndApplyCert(c)) {
              newCerts.push(c)
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
        if (Array.isArray(msg.bans)) {
          for (const b of msg.bans) {
            if (await authority.verifyAndApplyBan(b)) {
              newBans.push(b)
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
        sendAuthAckIfRequested(msg, fromPeerId)
        if (!applied && !authority.hasCertForPeer(msg.cert?.subPeerId)) {
          overlay.recordSignatureFailure()
        }
      })
      return
    }
    if (msg.t === 'revoke') {
      void authority.verifyAndApplyRevocation(msg.revocation).then(applied => {
        sendAuthAckIfRequested(msg, fromPeerId)
        if (!applied && !authority.hasRevocationSig(msg.revocation?.sig)) {
          overlay.recordSignatureFailure()
        }
      })
      return
    }
    if (msg.t === 'ban') {
      void authority.verifyAndApplyBan(msg.ban).then(applied => {
        sendAuthAckIfRequested(msg, fromPeerId)
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

  const sendAuthAckIfRequested = (
    msg: {reqId?: string; ackPeers?: string[]},
    fromPeerId: string
  ): void => {
    if (msg.reqId && (!msg.ackPeers || msg.ackPeers.includes(localSelfId))) {
      void authAction.send({t: 'ack', reqId: msg.reqId}, fromPeerId).catch(noOp)
    }
  }

  const broadcastAuthWithAck = async (
    payload:
      | {t: 'cert'; cert: RoleCertificate}
      | {t: 'revoke'; revocation: RoleRevocationRecord}
      | {t: 'ban'; ban: PeerBanRecord},
    allCandidatePeers: string[],
    extraAckPeer?: string,
    excludePeers?: ReadonlySet<string>
  ): Promise<void> => {
    const reqId = genId(12)
    const boundedAckPeers =
      allCandidatePeers.length > 16
        ? [
            ...new Set([
              ...overlay
                .getSnapshot()
                .directPeerIds.filter(id => !excludePeers?.has(id)),
              ...(extraAckPeer ? [extraAckPeer] : [])
            ])
          ]
        : undefined
    const ackWait = waitForAuthAck(reqId, boundedAckPeers ?? allCandidatePeers)
    await authAction
      .send({
        ...payload,
        reqId,
        ...(boundedAckPeers ? {ackPeers: boundedAckPeers} : {})
      })
      .catch(noOp)
    await ackWait
  }

  const getActiveUniqueUsers = (): Set<string> => {
    const users = new Set<string>([localUserId])
    for (const pid of keys(activePeerMap)) {
      users.add(getPeerUserId(pid))
    }
    return users
  }

  const isAlreadyFullForPeer = (id: string): boolean => {
    if (activePeerMap[id] || promotedFromVirtual.has(id)) {
      return false
    }
    if (effectiveLimit === undefined) {
      return false
    }
    const peerUserId = getPeerUserId(id)
    const activeUsers = getActiveUniqueUsers()
    if (activeUsers.has(peerUserId)) {
      return false
    }
    return effectiveLimit === 1
      ? isEstablished
      : activeUsers.size >= effectiveLimit
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
    if (isEstablished || keys(activePeerMap).length > 0) {
      if (peerMap[byPeerId]) {
        exitPeer(byPeerId, peerMap[byPeerId], mkErr('room full'))
      }
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

    const localAlreadyEstablished =
      isEstablished || keys(activePeerMap).length > 0

    const rankPeer = (id: string): {id: string; est: boolean; t: number} => {
      if (id === localSelfId) {
        return {
          id,
          est: localAlreadyEstablished,
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

    const winningUsers = new Set<string>()
    const winners = new Set<string>()
    if (localAlreadyEstablished) {
      winningUsers.add(localUserId)
      winners.add(localSelfId)
      for (const activeId of keys(activePeerMap)) {
        const uid = getPeerUserId(activeId)
        if (winningUsers.has(uid) || winningUsers.size < effectiveLimit) {
          winningUsers.add(uid)
          winners.add(activeId)
        }
      }
    }
    for (const c of sorted) {
      const uid = getPeerUserId(c.id)
      if (winningUsers.has(uid) || winningUsers.size < effectiveLimit) {
        winningUsers.add(uid)
        winners.add(c.id)
      }
    }

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
      const uid = getPeerUserId(id)
      const currentUsers = getActiveUniqueUsers()
      if (
        winners.has(id) &&
        (currentUsers.has(uid) || currentUsers.size < effectiveLimit)
      ) {
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

  let effectiveOnPeerHandshake = onPeerHandshake
  DEV: if (
    !verifyPeerIdentity &&
    (localSelfId !== defaultSelfId ||
      identity !== undefined ||
      userIdentityP !== undefined)
  ) {
    effectiveOnPeerHandshake = async (id, send, receive, isInitiator) => {
      await Promise.all([
        resolvedUserIdentityP,
        id === defaultSelfId ? undefined : getDefaultTestUserIdentity(id)
      ])
      await onPeerHandshake?.(id, send, receive, isInitiator)
    }
  }

  const handshakeManager = createHandshakeManager({
    selfId: localSelfId,
    ...(effectiveOnPeerHandshake === undefined
      ? {}
      : {onPeerHandshake: effectiveOnPeerHandshake}),
    ...(onHandshakeError === undefined ? {} : {onHandshakeError}),
    handshakeTimeoutMs,
    sendHandshakeData: handshakeDataAction.send,
    sendHandshakeReady: handshakeReadyAction.send,
    canAcceptBeforeHandshake: id =>
      Boolean(password) || verifyPeerIdentity || !isAlreadyFullForPeer(id),
    onRejectFull: (id, peer) => rejectPeerAsFull(id, peer),
    onLocalHandshakePassed: (id, peer) => {
      if (isAlreadyFullForPeer(id)) {
        rejectPeerAsFull(id, peer)
        return null
      }
      if (effectiveLimit !== undefined) {
        scheduleCapacityCheck()
      }
      return {
        ok: true,
        ...(effectiveLimit === undefined ? {} : {limit: effectiveLimit}),
        t: localJoinedAt,
        est: isEstablished || keys(activePeerMap).length > 0
      }
    },
    onRemoteHandshakeReady: (id, peer, data) => {
      const localAlreadyEstablished =
        isEstablished || keys(activePeerMap).length > 0
      if (data && typeof data === 'object') {
        if (
          typeof data.limit === 'number' &&
          Number.isSafeInteger(data.limit) &&
          data.limit >= 1
        ) {
          if (localAlreadyEstablished) {
            const activeUsers = getActiveUniqueUsers()
            const peerUserId = getPeerUserId(id)
            if (
              !activeUsers.has(peerUserId) &&
              activeUsers.size >= data.limit
            ) {
              rejectPeerAsFull(id, peer)
              return true
            }
          } else {
            effectiveLimit =
              effectiveLimit === undefined
                ? data.limit
                : Math.min(effectiveLimit, data.limit)
          }
        }
        if (!data.ok && data.err === 'room full') {
          handleSelfRejectedAsFull(id)
          return true
        }
        if (!data.ok && data.err === 'peer banned') {
          handshakeManager.clearPeer(id, mkErr('peer banned'))
          onHandshakeError?.(id, 'peer banned')
          kickPeer(id, peer, mkErr('peer banned'))
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
      pendingMediaPeers.get(id)?.resolve(peer as SharedMediaPeer)
      void sendAuthSyncToPeer(id)
      if (
        effectiveLimit !== undefined &&
        getActiveUniqueUsers().size >= effectiveLimit
      ) {
        for (const pendingId of handshakeManager.getPendingIds()) {
          if (
            !activePeerMap[pendingId] &&
            !pendingFullRejectTimers.has(pendingId) &&
            (!verifyPeerIdentity || peerUserIds.has(pendingId)) &&
            isAlreadyFullForPeer(pendingId)
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
        notifyPeerActivated(id)
      }
    },
    onFailure: (id, peer, reason) => {
      if (/peer banned/.test(reason.message)) {
        void handshakeReadyAction
          .send({ok: false, err: 'peer banned'}, id)
          .catch(noOp)
        handshakeManager.clearPeer(id, reason)
        peerJoinMeta.delete(id)
        const timer = setTimeout(() => {
          pendingFullRejectTimers.delete(id)
          kickPeer(id, peer, reason)
        }, 50)
        pendingFullRejectTimers.set(id, timer)
        return
      }
      kickPeer(id, peer, reason)
    }
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

  mediaControlAction.onMessage((msg, id) => {
    if (!msg || typeof msg !== 'object') {
      return
    }
    if (msg.op === 'connect') {
      overlay.requireDirectPeer(id)
      return
    }
    if (msg.o !== id || typeof msg.id !== 'string') {
      return
    }
    if (msg.op === 'rmStream') {
      const removed = overlay.unregisterBroadcastStreamById(msg.o, msg.id)
      if (removed && removed.targets.length > 0) {
        mediaManager.removeStream(removed.stream, removed.targets)
      }
    } else if (msg.op === 'rmTrack') {
      const trackKeys = Array.isArray(msg.keys)
        ? msg.keys.filter(key => typeof key === 'string')
        : []
      const trackId = knownBroadcastTracks.get(msg.id)?.track.id ?? msg.id
      for (const removed of overlay.unregisterBroadcastTrack(
        id,
        trackId,
        trackKeys
      )) {
        mediaManager.removeTrack(removed.track, removed.targets)
      }
      knownBroadcastTracks.delete(msg.id)
    }
  })

  leaveAction.onMessage((_, id) =>
    exitPeer(id, undefined, mkErr('peer left room'))
  )

  handshakeDataAction.onMessage((data, id, metadata) => {
    if (!leavePromise) {
      handshakeManager.receiveHandshakeData(data, id, metadata)
    }
  })

  handshakeReadyAction.onMessage((data, id) => {
    if (!leavePromise) {
      handshakeManager.receiveHandshakeReady(id, data)
    }
  })

  onPeer((peer, id) => {
    if (leavePromise) {
      return
    }
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
        if (peerMap[id] === peer && !authority.isPeerBanned(id)) {
          if (overlay.isOverlayFrame(d)) {
            if (activePeerMap[id]) {
              overlay.handleOverlayFrame(id, d)
            }
          } else {
            handleData(id, d)
          }
        }
      },
      stream: stream => {
        if (!authority.isPeerBanned(id)) {
          mediaManager.receiveRemoteStream(id, stream)
        }
      },
      track: (track, stream) => {
        if (!authority.isPeerBanned(id)) {
          mediaManager.receiveRemoteTrack(id, track, stream)
        }
      },
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
      const targetPeerId = resolveRequestTarget(peerId) ?? peerId
      const cert = await authority.issueRoleCertificate(
        peerId,
        role,
        options,
        () => {
          void authAction.send({t: 'whois'}, targetPeerId).catch(noOp)
        }
      )
      await broadcastAuthWithAck(
        {t: 'cert', cert},
        keys(activePeerMap),
        targetPeerId
      )
      return cert
    },

    revokeRole: async (peerId, role) => {
      const targetPeerId = resolveRequestTarget(peerId) ?? peerId
      const revocation = await authority.issueRoleRevocation(peerId, role)
      await broadcastAuthWithAck(
        {t: 'revoke', revocation},
        keys(activePeerMap),
        targetPeerId
      )
    },

    getPeerRoles: (peerId?: string) =>
      authority.getPeerRoles(peerId ?? localSelfId),

    banPeer: async (peerId, options) => {
      const targetPeers = new Set(
        Array.isArray(resolveSendTarget(peerId))
          ? (resolveSendTarget(peerId) as string[])
          : [peerId]
      )
      const otherPeers = keys(activePeerMap).filter(id => !targetPeers.has(id))
      const ban = await authority.issuePeerBan(peerId, options)
      await broadcastAuthWithAck(
        {t: 'ban', ban},
        otherPeers,
        undefined,
        targetPeers
      )
    },

    isBanned: peerId => authority.isPeerBanned(peerId),

    leave,

    ping: async id => {
      const targetId = resolveRequestTarget(id) ?? id
      if (!activePeerMap[targetId]) {
        throw mkErr(`no active peer with id ${id}`)
      }

      const start = Date.now()

      await new Promise<void>((resolve, reject) => {
        const queue = (pendingPongs[targetId] ??= [])

        const clearFromQueue = (): void => {
          const currentQueue = pendingPongs[targetId]

          if (!currentQueue) {
            return
          }

          const i = currentQueue.indexOf(waiter)

          if (i > -1) {
            currentQueue.splice(i, 1)
          }

          if (!currentQueue.length) {
            delete pendingPongs[targetId]
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
          .send('', targetId)
          .catch(err => waiter.reject(toError(err, 'peer disconnected')))
      })

      return Date.now() - start
    },

    isPassive: () => isPassive,

    getSelf: async (): Promise<SelfInfo> => ({
      peerId: localSelfId,
      userId: (await resolvedUserIdentityP).userId
    }),

    getPeers: () =>
      fromEntries(
        entries(activePeerMap).map(([id, peer]) => {
          const direct = !overlay.isVirtualPeer(id)
          const hops = direct ? 1 : (overlay.getRoute(id)?.hops ?? 2)
          return [
            id,
            {
              userId: getPeerUserId(id),
              connection: direct ? peer.connection : null,
              direct,
              hops,
              roles: authority.getPeerRoles(id)
            }
          ]
        })
      ),

    getUsers: () => {
      const result: Record<string, UserInfo> = {}
      for (const peerId of keys(activePeerMap)) {
        const userId = getPeerUserId(peerId)
        if (userId === localUserId) {
          continue
        }
        let entry = result[userId]
        if (!entry) {
          entry = {
            peerIds: [],
            roles: authority.getPeerRoles(userId)
          }
          result[userId] = entry
        }
        entry.peerIds.push(peerId)
      }
      return result
    },

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
      if (!options.target) {
        const removed = overlay.unregisterBroadcastTrack(localSelfId, track.id)
        knownBroadcastTracks.delete(track.id)
        if (removed.length > 0) {
          void mediaControlAction
            .send({
              op: 'rmTrack',
              o: localSelfId,
              id: track.id,
              keys: removed.map(entry => entry.key)
            })
            .catch(noOp)
        }
      }
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
        const replacements = mediaManager.replaceTrack(
          oldTrack,
          newTrack,
          {...options, target: targets},
          trackMetaAction.send,
          localSelfId,
          trackKey
        )
        return [
          Promise.all(replacements).then(() => {
            overlay.replaceBroadcastTrack(
              localSelfId,
              oldTrack,
              newTrack,
              options.metadata
            )
          })
        ]
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
        keys(activePeerMap).forEach(peerId =>
          handler({
            peerId,
            userId: getPeerUserId(peerId),
            roles: authority.getPeerRoles(peerId)
          })
        )
      }
    },

    get onPeerLeave() {
      return listeners.onPeerLeave
    },

    set onPeerLeave(handler) {
      listeners.onPeerLeave = handler
    },

    get onUserJoin() {
      return listeners.onUserJoin
    },

    set onUserJoin(handler) {
      listeners.onUserJoin = handler

      if (handler) {
        for (const [userId, peerIds] of activeUserPeers.entries()) {
          if (userId === localUserId) {
            continue
          }
          const firstPeerId = [...peerIds][0]
          if (firstPeerId) {
            handler({
              userId,
              peerId: firstPeerId,
              roles: authority.getPeerRoles(userId)
            })
          }
        }
      }
    },

    get onUserLeave() {
      return listeners.onUserLeave
    },

    set onUserLeave(handler) {
      listeners.onUserLeave = handler
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
    },
    onPeerIdentityVerified: (peerId, verified) => {
      peerUserIds.set(peerId, verified.userId)
      if (
        authority.isPeerBanned(peerId) ||
        authority.isPeerBanned(verified.userId)
      ) {
        overlay.markPeerBanned(peerId)
        throw mkErr('peer banned')
      }
      authority.registerPeerPublicKey(peerId, verified.peerPubKey)
    },
    getPeerHandle: peerId => handshakeManager.getPeer(peerId) ?? peerMap[peerId]
  })

  return roomInstance
}
