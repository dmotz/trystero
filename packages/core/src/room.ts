import {
  entries,
  extractPlugins,
  fromEntries,
  genId,
  isBrowser,
  keys,
  libName,
  mkErr,
  noOp,
  selfCertifyingRoomRegex,
  selfId as defaultSelfId,
  toError
} from './utils'
import {createActionManager} from './actions'
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
import type {
  AddMediaOptions,
  AuthoritativeState,
  DataPayload,
  JsonValue,
  KernelRolesProvider,
  KernelScaleProvider,
  PeerHandle,
  PeerHandshake,
  PeerJoinContext,
  PeerLeaveContext,
  Room,
  RoomKernel,
  RoomPlugin,
  SelfInfo,
  SharedMediaPeer,
  StateConfig,
  TargetPeers,
  TopologySnapshot,
  UserIdentity,
  UserIdentityConfig,
  UserInfo,
  UserJoinContext,
  UserLeaveContext
} from './types'

const unloadEvent = 'beforeunload'
const defaultHandshakeTimeoutMs = 10_000
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
  getScaleProvider: () => KernelScaleProvider | null
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
  scale?: RoomPlugin<'scale'>
  roles?: RoomPlugin<'roles'>
  plugins?: RoomPlugin[]
  preResolvedPlugins?: Map<RoomPlugin, unknown>
  identity?: UserIdentityConfig
  userIdentityP?: Promise<UserIdentity>
  verifyPeerIdentity?: boolean
  maxReceiveBytes?: number
  onPeerHandshake?: PeerHandshake
  onHandshakeError?: (peerId: string, error: string) => void
  handshakeTimeoutMs?: number
  isPassive?: boolean
  onBeforeLeave?: () => void
  [key: string]: unknown
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

export default (
  onPeer: (f: (peer: PeerHandle, id: string) => void) => void,
  onPeerLeave: (id: string) => void,
  onSelfLeave: () => void,
  roomOptions: RoomOptions = {}
): Room => {
  const {
    selfId: localSelfId = defaultSelfId,
    appId = '',
    roomId: initialRoomId = '',
    password = '',
    limit,
    preResolvedPlugins,
    identity,
    userIdentityP,
    verifyPeerIdentity = false,
    onPeerHandshake,
    onHandshakeError,
    handshakeTimeoutMs = defaultHandshakeTimeoutMs,
    maxReceiveBytes,
    isPassive = false,
    onBeforeLeave
  } = roomOptions
  const peerMap: Record<string, PeerHandle> = {}
  const activePeerMap: Record<string, PeerHandle> = {}
  const peerUserIds = new Map<string, string>()
  const peerPubKeys = new Map<string, JsonWebKey>()
  const activeUserPeers = new Map<string, Set<string>>()
  let effectiveRoomId = initialRoomId
  let rolesProvider: KernelRolesProvider | null = null
  let scaleProvider: KernelScaleProvider | null = null
  const peerActivatedListeners: Array<
    (peerId: string, peer: PeerHandle) => void
  > = []
  const peerDeactivatedListeners: Array<(peerId: string) => void> = []
  const roomIdChangedListeners: Array<(roomId: string) => void> = []
  const leaveListeners: Array<() => void> = []
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
      const aDirect = !(scaleProvider?.isVirtualPeer(a) ?? false)
      const bDirect = !(scaleProvider?.isVirtualPeer(b) ?? false)
      if (aDirect !== bDirect) {
        return aDirect ? -1 : 1
      }
      return a < b ? -1 : a > b ? 1 : 0
    })
    return candidates[0]
  }

  const isDirectPeer = (id: string): boolean =>
    scaleProvider ? scaleProvider.isDirectPeer(id) : Boolean(activePeerMap[id])

  const isVirtualPeer = (id: string): boolean =>
    scaleProvider?.isVirtualPeer(id) ?? false

  const isPeerBanned = (id: string): boolean =>
    rolesProvider?.isPeerBanned(id) ?? false

  const getPeerRoles = (id = localSelfId): string[] =>
    rolesProvider?.getPeerRoles(id) ?? []

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
    if (isDirectPeer(id)) {
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
          scaleProvider?.requireDirectPeer(id)
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
    const roles = getPeerRoles(peerId)
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
    for (const cb of peerDeactivatedListeners) {
      cb(peerId)
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
      if (scaleProvider?.isOverlayActive() && broadcast) {
        scaleProvider.registerBroadcastStream(
          originPeerId,
          key,
          stream,
          metadata
        )
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
        scaleProvider?.isOverlayActive() &&
        broadcast &&
        (isReplace || (metaTrackId && metaTrackId !== track.id))
      ) {
        const oldEntry = metaTrackId
          ? knownBroadcastTracks.get(metaTrackId)
          : undefined
        if (replacementId) {
          knownBroadcastTracks.set(replacementId, {track, stream})
        }
        scaleProvider.replaceBroadcastTrack(
          originPeerId,
          oldEntry?.track ?? track,
          track,
          metadata
        )
        if (typeof track.id === 'string') {
          knownBroadcastTracks.set(track.id, {track, stream})
        }
        const targets = scaleProvider.getMediaTargets(originPeerId)
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
      if (scaleProvider?.isOverlayActive() && broadcast) {
        scaleProvider.registerBroadcastTrack(
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
      !isPeerBanned(id) &&
      (Boolean(activePeerMap[id]) ||
        handshakeManager.canReceiveFromPeer(id, receiveWhilePending)),
    broadcastInline: (frame, onProgress) =>
      scaleProvider
        ? scaleProvider.broadcastInline(frame, onProgress)
        : Promise.resolve(false),
    registerActionAuthority: (namespace, roles) => {
      if (!rolesProvider) {
        throw mkErr('action role gating requires roles() in joinRoom config')
      }
      scaleProvider?.registerActionAuthority(namespace, roles)
    },
    getPeerRoles: peerId => getPeerRoles(peerId),
    onUnauthorizedAction: () => {
      scaleProvider?.recordSignatureFailure()
    },
    signActionPayload: (namespace, requiredRoles, data, userMetadata) =>
      rolesProvider
        ? rolesProvider.signActionPayload(
            namespace,
            requiredRoles,
            data,
            userMetadata
          )
        : Promise.resolve(userMetadata ?? null),
    verifyActionOffer: (namespace, peerId, requiredRoles, wireMetadata) =>
      rolesProvider
        ? rolesProvider.verifyActionOffer(
            namespace,
            peerId,
            requiredRoles,
            wireMetadata
          )
        : Promise.resolve({
            valid: true,
            ...(wireMetadata === undefined ? {} : {userMetadata: wireMetadata}),
            roles: []
          }),
    verifyActionPayload: (
      namespace,
      peerId,
      requiredRoles,
      data,
      wireMetadata
    ) =>
      rolesProvider
        ? rolesProvider.verifyActionPayload(
            namespace,
            peerId,
            requiredRoles,
            data,
            wireMetadata
          )
        : Promise.resolve({
            valid: true,
            ...(wireMetadata === undefined ? {} : {userMetadata: wireMetadata}),
            roles: []
          })
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
    const wasVirtual = isVirtualPeer(id)
    const wasDirect = isDirectPeer(id)

    clearPeerState(id, reason)
    current.destroy()

    if (scaleProvider) {
      if (wasDirect) {
        if (wasActive) {
          suppressVirtualJoin.add(id)
        }
        const keptAsVirtual = scaleProvider.removeDirectPeer(id, current)
        suppressVirtualJoin.delete(id)
        if (keptAsVirtual) {
          onPeerLeave(id)
          return
        }
      } else if (!wasVirtual) {
        scaleProvider.removeDirectPeer(id)
      }
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
      for (const cb of leaveListeners) {
        cb()
      }
      scaleProvider?.announceLeave()
      const controller = new AbortController()
      void leaveAction
        .send('', undefined, undefined, undefined, controller.signal)
        .catch(noOp)
      if (!didRejectSelfAsFull) {
        await new Promise<void>(res => setTimeout(res, 99))
      }
      controller.abort()

      try {
        scaleProvider?.destroy()
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

  const pingAction = makeActionInternal<string>('ping')
  const pongAction = makeActionInternal<string>('pong')
  const signalAction = makeActionInternal('signal')
  const streamMetaAction = makeActionInternal<InternalMediaMeta>('stream', {
    maxPayloadBytes: 64 * 1024
  })
  const trackMetaAction = makeActionInternal<InternalMediaMeta>('track', {
    maxPayloadBytes: 64 * 1024
  })
  const mediaControlAction = makeActionInternal<MediaControlMessage>('mctrl')
  const leaveAction = makeActionInternal<string>('leave', {
    sendToPending: true,
    receiveWhilePending: true
  })
  const handshakeDataAction = makeActionInternal<DataPayload>('hsdata', {
    sendToPending: true,
    receiveWhilePending: true,
    maxPayloadBytes: 64 * 1024
  })
  const handshakeReadyAction = makeActionInternal<HandshakeReadyPayload>(
    'hsready',
    {sendToPending: true, receiveWhilePending: true, maxPayloadBytes: 64 * 1024}
  )

  const kernel: RoomKernel = {
    selfId: localSelfId,
    appId,
    initialRoomId,
    password,
    getRoomId: () => effectiveRoomId,
    setEffectiveRoomId: rid => {
      if (rid && rid !== effectiveRoomId) {
        effectiveRoomId = rid
        for (const cb of roomIdChangedListeners) {
          cb(rid)
        }
      }
    },
    getLocalUserIdentity: () => resolvedUserIdentityP,
    getPeerUserId,
    getKnownPeerUserId: peerId => {
      if (peerId === localSelfId) {
        return localUserId
      }
      let userId = peerUserIds.get(peerId)
      DEV: if (!userId && peerId in peerMap) {
        userId = getDefaultTestUserIdentityUserIdSync(peerId)
      }
      return userId
    },
    setPeerUserId: (peerId, userId) => {
      if (userId) {
        peerUserIds.set(peerId, userId)
      }
    },
    getUserPeerIds,
    getPeerPublicKey: peerId =>
      peerPubKeys.get(peerId) ?? scaleProvider?.getPeerSignPublicKey(peerId),
    setPeerPublicKey: (peerId, pubKey) => {
      peerPubKeys.set(peerId, pubKey)
      scaleProvider?.setPeerSignPublicKey(peerId, pubKey)
    },
    getActivePeerIds: () => keys(activePeerMap),
    getAllPeerIds: () => keys(peerMap),
    isPeerActive: peerId => Boolean(activePeerMap[peerId]),
    getPeerHandle: (peerId, includePending = false) =>
      (includePending ? peerMap : activePeerMap)[peerId],
    resolveSendTarget,
    resolveRequestTarget,
    kickPeer: (peerId, reason) => kickPeer(peerId, undefined, reason),
    makeAction,
    makeInternalAction: makeActionInternal,
    deliverRawData: (originPeerId, data) => {
      if (isPeerBanned(originPeerId)) {
        scaleProvider?.recordSignatureFailure()
        return
      }
      handleData(originPeerId, data)
    },
    registerRolesProvider: provider => {
      rolesProvider = provider
      for (const [pid, pubKey] of peerPubKeys.entries()) {
        provider.registerPeerPublicKey(pid, pubKey)
      }
    },
    registerScaleProvider: provider => {
      scaleProvider = provider
      for (const [pid, pubKey] of peerPubKeys.entries()) {
        provider.setPeerSignPublicKey(pid, pubKey)
      }
    },
    getRolesProvider: () => rolesProvider,
    getScaleProvider: () => scaleProvider,
    onPeerActivated: cb => {
      peerActivatedListeners.push(cb)
    },
    onPeerDeactivated: cb => {
      peerDeactivatedListeners.push(cb)
    },
    onRoomIdChanged: cb => {
      roomIdChangedListeners.push(cb)
    },
    onLeave: cb => {
      leaveListeners.push(cb)
    },
    activateVirtualPeer: (peerId, vPeer) => {
      if (isPeerBanned(peerId)) {
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
    deactivateVirtualPeer: (peerId, reason) => {
      const current = peerMap[peerId]
      if (!current || isDirectPeer(peerId)) {
        return
      }
      const wasActive = Boolean(activePeerMap[peerId])
      clearPeerState(peerId, reason)
      current.destroy()
      if (wasActive) {
        notifyPeerDeactivated(peerId)
      }
    },
    relayMediaStream: (
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
    relayMediaTrack: (
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
  }

  const plugins = extractPlugins(roomOptions)
  const pluginApis: Record<string, unknown> = {}
  for (const plugin of plugins) {
    const preState = preResolvedPlugins?.get(plugin)
    const api = plugin.setup(kernel, preState)
    if (api && typeof api === 'object') {
      Object.assign(pluginApis, api)
    }
  }

  if (!rolesProvider && selfCertifyingRoomRegex.test(initialRoomId)) {
    throw mkErr('self-certifying room ID requires roles() in joinRoom config')
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
      if (isPeerBanned(id)) {
        kickPeer(id, peer, mkErr('peer banned'))
        return
      }
      isEstablished = true
      const alreadyJoined = promotedFromVirtual.delete(id)
      activePeerMap[id] = peer
      scaleProvider?.addDirectPeer(id, peer)
      pendingMediaPeers.get(id)?.resolve(peer as SharedMediaPeer)
      for (const cb of peerActivatedListeners) {
        cb(id, peer)
      }
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
      scaleProvider?.requireDirectPeer(id)
      return
    }
    if (msg.o !== id || typeof msg.id !== 'string') {
      return
    }
    if (msg.op === 'rmStream') {
      const removed = scaleProvider?.unregisterBroadcastStreamById(
        msg.o,
        msg.id
      )
      if (removed && removed.targets.length > 0) {
        mediaManager.removeStream(removed.stream, removed.targets)
      }
    } else if (msg.op === 'rmTrack') {
      const trackKeys = Array.isArray(msg.keys)
        ? msg.keys.filter(key => typeof key === 'string')
        : []
      const trackId = knownBroadcastTracks.get(msg.id)?.track.id ?? msg.id
      if (scaleProvider) {
        for (const removed of scaleProvider.unregisterBroadcastTrack(
          id,
          trackId,
          trackKeys
        )) {
          mediaManager.removeTrack(removed.track, removed.targets)
        }
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
    if (isPeerBanned(id)) {
      peer.destroy()
      return
    }
    const existingPeer = peerMap[id]
    const wasVirtual = Boolean(existingPeer && isVirtualPeer(id))

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
        if (peerMap[id] === peer && !isPeerBanned(id)) {
          if (scaleProvider?.isOverlayFrame(d)) {
            if (activePeerMap[id]) {
              scaleProvider.handleOverlayFrame(id, d)
            }
          } else {
            handleData(id, d)
          }
        }
      },
      stream: stream => {
        if (!isPeerBanned(id)) {
          mediaManager.receiveRemoteStream(id, stream)
        }
      },
      track: (track, stream) => {
        if (!isPeerBanned(id)) {
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

  const requireRolesModule = (): never => {
    throw mkErr('roles() module is required in joinRoom config')
  }

  const roomInstance: Room = {
    makeAction,

    makeState: <T extends JsonValue = JsonValue>(
      _namespace: string,
      _initialValue: T,
      _config?: StateConfig<T>
    ): AuthoritativeState<T> => requireRolesModule(),

    grantRole: async () => requireRolesModule(),

    revokeRole: async () => requireRolesModule(),

    getRoles: (peerId?: string) => getPeerRoles(peerId ?? localSelfId),

    ban: async () => requireRolesModule(),

    isBanned: peerId => isPeerBanned(peerId),

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

    getSelf: async (): Promise<SelfInfo> => {
      const userId = (await resolvedUserIdentityP).userId
      if (rolesProvider) {
        const auth = await rolesProvider.getAuthorityInfo()
        return {
          peerId: localSelfId,
          userId,
          roomId: auth.roomId,
          baseRoomId: auth.baseRoomId,
          fingerprint: auth.fingerprint,
          isAdmin: auth.isAdmin,
          roles: auth.roles
        }
      }
      return {
        peerId: localSelfId,
        userId,
        roomId: effectiveRoomId,
        baseRoomId: initialRoomId,
        fingerprint: null,
        isAdmin: false,
        roles: []
      }
    },

    getPeers: () =>
      fromEntries(
        entries(activePeerMap).map(([id, peer]) => {
          const direct = !isVirtualPeer(id)
          const hops = direct ? 1 : (scaleProvider?.getRoute(id)?.hops ?? 2)
          return [
            id,
            {
              userId: getPeerUserId(id),
              connection: direct ? peer.connection : null,
              direct,
              hops,
              roles: getPeerRoles(id)
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
            roles: getPeerRoles(userId)
          }
          result[userId] = entry
        }
        entry.peerIds.push(peerId)
      }
      return result
    },

    getTopology: (): TopologySnapshot => {
      if (scaleProvider) {
        return scaleProvider.getSnapshot()
      }
      const directPeerIds = keys(activePeerMap).sort()
      return {
        mode: 'mesh',
        activeMode: 'mesh',
        selfId: localSelfId,
        directPeerIds,
        roomPeerIds: directPeerIds,
        routes: {},
        mediaTrees: {
          [localSelfId]: {
            broadcasterId: localSelfId,
            parentId: null,
            childrenIds: []
          }
        },
        stats: {
          messagesSent: 0,
          messagesReceived: 0,
          messagesForwarded: 0,
          duplicatesDropped: 0,
          signatureFailures: 0,
          lazyRepairsSent: 0,
          lazyRepairsResolved: 0,
          treeReparents: 0
        }
      }
    },

    addStream: (stream, options: AddMediaOptions = {}) => {
      recordStreamTracks(stream)
      if (scaleProvider?.isOverlayActive() && !options.target) {
        const streamKey = genId(20)
        scaleProvider.registerBroadcastStream(
          localSelfId,
          streamKey,
          stream,
          options.metadata
        )
        const targets = scaleProvider.getMediaTargets(localSelfId)
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
      if (scaleProvider?.isOverlayActive() && !options.target) {
        const targets = scaleProvider.unregisterBroadcastStream(
          localSelfId,
          stream
        )
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
      if (scaleProvider?.isOverlayActive() && !options.target) {
        const trackKey = genId(20)
        scaleProvider.registerBroadcastTrack(
          localSelfId,
          trackKey,
          track,
          stream,
          options.metadata
        )
        const targets = scaleProvider.getMediaTargets(localSelfId)
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
      if (!options.target && scaleProvider) {
        const removed = scaleProvider.unregisterBroadcastTrack(
          localSelfId,
          track.id
        )
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
      if (scaleProvider?.isOverlayActive() && !options.target) {
        const sp = scaleProvider
        const trackKey = genId(20)
        const targets = sp.getMediaTargets(localSelfId)
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
            sp.replaceBroadcastTrack(
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

    ...pluginApis,

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
            roles: getPeerRoles(peerId)
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
              roles: getPeerRoles(userId)
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
    getScaleProvider: () => scaleProvider,
    getAnnounceExtra: () =>
      rolesProvider
        ? rolesProvider.getAnnounceExtra()
        : Promise.resolve(undefined),
    onSignalingPayload: (peerId, payload) =>
      rolesProvider?.onSignalingPayload(peerId, payload),
    checkCapacityAfterPassword: peerId => {
      if (isAlreadyFullForPeer(peerId)) {
        throw roomFullHostRejectErr
      }
    },
    onPeerIdentityVerified: (peerId, verified) => {
      peerUserIds.set(peerId, verified.userId)
      if (isPeerBanned(peerId) || isPeerBanned(verified.userId)) {
        scaleProvider?.markPeerBanned(peerId)
        throw mkErr('peer banned')
      }
      peerPubKeys.set(peerId, verified.peerPubKey)
      scaleProvider?.setPeerSignPublicKey(peerId, verified.peerPubKey)
      rolesProvider?.registerPeerPublicKey(peerId, verified.peerPubKey)
    },
    getPeerHandle: peerId => handshakeManager.getPeer(peerId) ?? peerMap[peerId]
  })

  return roomInstance
}
