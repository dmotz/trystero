import {
  entries,
  fromEntries,
  getConfiguredPlugins,
  internalActionPrefix,
  isBrowser,
  keys,
  logErr,
  mkErr,
  noOp,
  peerBannedErr,
  peerBannedMsg,
  peerDisconnectedErr,
  peerDisconnectedMsg,
  peerLeftRoomErr,
  requiresRolesErr,
  reservedRoomPropertyNames,
  roomFullErr,
  roomFullMsg,
  roomLeftErr,
  selfCertifyingRoomRegex,
  selfCertRoomRolesErr,
  toError,
  warnEphemeralAdmin,
  warnNoPeer
} from './utils'
import {createActionManager} from './actions'
import {isSelfAsAdminPlugin} from './authority'
import {
  createHandshakeManager,
  type HandshakeReadyPayload,
  type VerifiedPeerIdentity
} from './handshake'
import {
  getDefaultTestUserIdentity,
  getDefaultTestUserIdentityUserIdSync,
  getOrCreateEndpointIdentity,
  resolveUserIdentity
} from './identity'
import {createMediaManager, type InternalMediaMeta} from './media'
import type {
  AddMediaOptions,
  DataPayload,
  KernelRolesProvider,
  KernelScaleProvider,
  PeerHandle,
  PeerHandshake,
  PeerJoinContext,
  PeerLeaveContext,
  RemoveMediaOptions,
  Room,
  RoomKernel,
  RoomPlugin,
  RoomWithPlugins,
  SelfInfo,
  TargetPeers,
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
  setOnScaleTargetsChanged: (cb: (targetPeerIds: string[]) => void) => void
  canConnectPeer: (peerId: string) => boolean
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
  use?: readonly RoomPlugin<string, any>[]
  preResolvedPlugins?: Map<RoomPlugin, unknown>
  identity?: UserIdentityConfig
  userIdentityP?: Promise<UserIdentity>
  verifyPeerIdentity?: boolean
  maxReceiveBytes?: number
  onPeerHandshake?: PeerHandshake
  onHandshakeError?: (peerId: string, error: string) => void
  handshakeTimeoutMs?: number
  onBeforeLeave?: () => void
}

export default <
  const TPlugins extends readonly RoomPlugin<string, any>[] | undefined =
    undefined
>(
  onPeer: (f: (peer: PeerHandle, id: string) => void) => void,
  onPeerLeave: (id: string) => void,
  onSelfLeave: () => void,
  roomOptions: RoomOptions & {use?: TPlugins} = {}
): RoomWithPlugins<TPlugins> => {
  const {
    selfId: explicitSelfId,
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
    onBeforeLeave
  } = roomOptions
  let localSelfId = explicitSelfId ?? ''
  const localEndpointP = getOrCreateEndpointIdentity(explicitSelfId).then(
    ep => {
      if (!explicitSelfId) {
        localSelfId = ep.peerId
      }
      return ep
    }
  )
  const localSelfIdP = explicitSelfId
    ? Promise.resolve(explicitSelfId)
    : localEndpointP.then(ep => ep.peerId)
  const peerMap: Record<string, PeerHandle> = {}
  const activePeerMap: Record<string, PeerHandle> = {}
  const peerUserIds = new Map<string, string>()
  const peerPubKeys = new Map<string, JsonWebKey>()
  const activeUserPeers = new Map<string, Set<string>>()
  const pendingActionAuthorities = new Map<string, string[]>()
  const plugins = getConfiguredPlugins(roomOptions.use)
  const hasRolesPlugin = plugins.some(p => p.name === 'roles')
  if (!hasRolesPlugin && selfCertifyingRoomRegex.test(initialRoomId)) {
    throw selfCertRoomRolesErr
  }
  let effectiveRoomId = initialRoomId
  let rolesProvider: KernelRolesProvider | null = null
  let scaleProvider: KernelScaleProvider | null = null
  let scaleTargetsChangedCallback: ((targetPeerIds: string[]) => void) | null =
    null
  let roomInstanceRef: Room | null = null
  const peerActivatedListeners: Array<
    (peerId: string, peer: PeerHandle) => void
  > = []
  const peerDeactivatedListeners: Array<(peerId: string) => void> = []
  const roomIdChangedListeners: Array<(roomId: string) => void> = []
  const leaveListeners: Array<() => void> = []
  let localUserId = ''
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

  const virtualPeerIds = new Set<string>()

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
      const aDirect = !virtualPeerIds.has(a)
      const bDirect = !virtualPeerIds.has(b)
      if (aDirect !== bDirect) {
        return aDirect ? -1 : 1
      }
      return a < b ? -1 : a > b ? 1 : 0
    })
    return candidates[0]
  }

  const isDirectPeer = (id: string): boolean =>
    Boolean(activePeerMap[id]) && !virtualPeerIds.has(id)

  const isVirtualPeer = (id: string): boolean => virtualPeerIds.has(id)

  const isPeerBanned = (id: string): boolean =>
    rolesProvider?.isPeerBanned(id) ?? false

  const getPeerRoles = (id = localSelfId): string[] =>
    rolesProvider?.getPeerRoles(id) ?? []

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
  let didReportRoomFull = false

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
        warnNoPeer(id)
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

  const mediaManager = createMediaManager({
    onPeerError,
    getPeerUserId,
    preparePeer: (id, peer) =>
      scaleProvider?.prepareMediaPeer
        ? scaleProvider.prepareMediaPeer(id, peer)
        : Promise.resolve(peer),
    iterate,
    isActive: id => Boolean(activePeerMap[id])
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
      if (!rolesProvider && !hasRolesPlugin) {
        throw requiresRolesErr('action role gating')
      }
      if (roles.length > 0) {
        pendingActionAuthorities.set(namespace, [...roles])
      } else {
        pendingActionAuthorities.delete(namespace)
      }
      scaleProvider?.registerActionAuthority(namespace, roles)
    },
    getPeerRoles: peerId => getPeerRoles(peerId),
    onUnauthorizedAction: () => {
      scaleProvider?.recordSignatureFailure()
    },
    signActionPayload: async (namespace, requiredRoles, data, userMetadata) => {
      if (!rolesProvider && hasRolesPlugin) {
        await pluginSetupP
      }
      return rolesProvider
        ? rolesProvider.signActionPayload(
            namespace,
            requiredRoles,
            data,
            userMetadata
          )
        : (userMetadata ?? null)
    },
    verifyActionOffer: async (
      namespace,
      peerId,
      requiredRoles,
      wireMetadata
    ) => {
      if (!rolesProvider && hasRolesPlugin) {
        await pluginSetupP
      }
      return rolesProvider
        ? rolesProvider.verifyActionOffer(
            namespace,
            peerId,
            requiredRoles,
            wireMetadata
          )
        : {
            valid: true,
            ...(wireMetadata === undefined ? {} : {userMetadata: wireMetadata}),
            roles: []
          }
    },
    verifyActionPayload: async (
      namespace,
      peerId,
      requiredRoles,
      data,
      wireMetadata
    ) => {
      if (!rolesProvider && hasRolesPlugin) {
        await pluginSetupP
      }
      return rolesProvider
        ? rolesProvider.verifyActionPayload(
            namespace,
            peerId,
            requiredRoles,
            data,
            wireMetadata
          )
        : {
            valid: true,
            ...(wireMetadata === undefined ? {} : {userMetadata: wireMetadata}),
            roles: []
          }
    }
  })
  const makeActionInternal = actionManager.makeInternalAction
  const handleData = actionManager.handleData
  const makeAction = actionManager.makeAction

  const clearPeerState = (
    id: string,
    reason: Error = peerDisconnectedErr
  ): void => {
    const err = toError(reason, peerDisconnectedMsg)
    handshakeManager.clearPeer(id, err)
    virtualPeerIds.delete(id)
    delete peerMap[id]
    delete activePeerMap[id]
    actionManager.clearPeer(id, err)
    mediaManager.clearPeer(id)
  }

  const exitPeer = (id: string, peer?: PeerHandle, reason?: Error): void => {
    const current = peerMap[id]

    if (!current || (peer && current !== peer)) {
      return
    }

    const err = toError(reason, peerDisconnectedMsg)
    const wasVirtual = isVirtualPeer(id)
    const existingVirtual =
      wasVirtual && activePeerMap[id] && activePeerMap[id] !== current
        ? activePeerMap[id]
        : undefined

    if (existingVirtual && err.message !== peerBannedMsg) {
      handshakeManager.clearPeer(id, err)
      peerMap[id] = existingVirtual
      current.destroy()
      scaleProvider?.removeDirectPeer(id, current, err)
      onPeerLeave(id)
      return
    }

    const wasActive = Boolean(activePeerMap[id]) || wasVirtual

    clearPeerState(id, err)
    current.destroy()
    scaleProvider?.removeDirectPeer(id, current, err)

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
      entries(peerMap).forEach(([id]) => {
        handshakeManager.clearPeer(id, roomLeftErr)
      })
      for (const cb of leaveListeners) {
        cb()
      }
      scaleProvider?.announceLeave()
      const leaveTargets = scaleProvider
        ? keys(peerMap).filter(id => !virtualPeerIds.has(id))
        : undefined
      const controller = new AbortController()
      if (!leaveTargets || leaveTargets.length > 0) {
        void leaveAction
          .send('', leaveTargets, undefined, undefined, controller.signal)
          .catch(noOp)
      }
      await new Promise<void>(res => setTimeout(res, 99))
      controller.abort()

      try {
        scaleProvider?.destroy()
        entries(peerMap).forEach(([id, peer]) => {
          peer.destroy()
          clearPeerState(id, roomLeftErr)
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

  const pingAction = makeAction<string, string>(`${internalActionPrefix}ping`, {
    kind: 'request',
    onRequest: () => ''
  })
  const signalAction = makeActionInternal('signal')
  const streamMetaAction = makeActionInternal<InternalMediaMeta>('stream', {
    maxPayloadBytes: 64 * 1024
  })
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
    get selfId() {
      return localSelfId
    },
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
    getPeerPublicKey: peerId => peerPubKeys.get(peerId),
    setPeerPublicKey: (peerId, pubKey) => {
      peerPubKeys.set(peerId, pubKey)
      scaleProvider?.setPeerSignPublicKey(peerId, pubKey)
    },
    getActivePeerIds: () =>
      keys(activePeerMap).filter(id => !virtualPeerIds.has(id)),
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
    },
    registerScaleProvider: provider => {
      scaleProvider = provider
      if (scaleTargetsChangedCallback) {
        provider.setOnTargetsChanged(scaleTargetsChangedCallback)
      }
      for (const [ns, roles] of pendingActionAuthorities.entries()) {
        provider.registerActionAuthority(ns, roles)
      }
      for (const [pid, pubKey] of peerPubKeys.entries()) {
        provider.setPeerSignPublicKey(pid, pubKey)
      }
      for (const [id, peer] of entries(activePeerMap)) {
        if (!virtualPeerIds.has(id)) {
          provider.addDirectPeer(id, peer)
        }
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
      if (isPeerBanned(peerId) || isAlreadyFullForPeer(peerId)) {
        vPeer.destroy()
        return
      }
      if (activePeerMap[peerId] && !virtualPeerIds.has(peerId)) {
        return
      }
      const alreadyActive = Boolean(activePeerMap[peerId])
      if (!handshakeManager.getPeer(peerId)) {
        peerMap[peerId] = vPeer
      }
      virtualPeerIds.add(peerId)
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
      const activeVirtual = activePeerMap[peerId]
      if (activeVirtual && activeVirtual !== current) {
        virtualPeerIds.delete(peerId)
        delete activePeerMap[peerId]
        activeVirtual.destroy()
        notifyPeerDeactivated(peerId)
        return
      }
      const wasActive = Boolean(activeVirtual)
      clearPeerState(peerId, reason)
      current.destroy()
      if (wasActive) {
        notifyPeerDeactivated(peerId)
      }
    }
  }

  if (
    !userIdentityP &&
    plugins.some(isSelfAsAdminPlugin) &&
    (identity === undefined || identity === 'session' || identity === 'none')
  ) {
    warnEphemeralAdmin()
  }
  const pluginApis: Record<string, unknown> = {}
  let didRunPluginSetup = false
  let pluginSetupError: unknown = null
  const runPluginSetup = (): void => {
    if (didRunPluginSetup) {
      if (pluginSetupError) {
        throw pluginSetupError
      }
      return
    }
    didRunPluginSetup = true
    try {
      const seenPluginApiKeys = new Set<string>()
      for (const plugin of plugins) {
        const preState = preResolvedPlugins?.get(plugin)
        const api = plugin.setup(kernel, preState)
        if (api && typeof api === 'object') {
          for (const key of keys(api as Record<string, unknown>)) {
            const propErr = (msg: string): Error =>
              mkErr(`plugin "${plugin.name}" ${msg} room property "${key}"`)
            if (reservedRoomPropertyNames.has(key)) {
              throw propErr('cannot override reserved')
            }
            if (seenPluginApiKeys.has(key)) {
              throw propErr('defines duplicate')
            }
            seenPluginApiKeys.add(key)
          }
          Object.assign(pluginApis, api)
        }
      }
      if (!rolesProvider && selfCertifyingRoomRegex.test(initialRoomId)) {
        throw selfCertRoomRolesErr
      }
      if (roomInstanceRef) {
        for (const [k, v] of entries(pluginApis)) {
          if (!reservedRoomPropertyNames.has(k)) {
            ;(roomInstanceRef as Record<string, unknown>)[k] = v
          }
        }
      }
    } catch (err) {
      pluginSetupError = err
      throw err
    }
  }

  let pluginSetupP: Promise<void>
  if (localSelfId) {
    runPluginSetup()
    pluginSetupP = Promise.resolve()
  } else {
    pluginSetupP = localEndpointP.then(() => {
      try {
        runPluginSetup()
      } catch (err) {
        onSelfLeave()
        throw err
      }
    })
    void pluginSetupP.catch(noOp)
  }

  const getActiveUniqueUsers = (): Set<string> => {
    const users = new Set<string>([localUserId])
    for (const pid of keys(activePeerMap)) {
      users.add(getPeerUserId(pid))
    }
    return users
  }

  const isAlreadyFullForPeer = (id: string): boolean => {
    if (limit === undefined || activePeerMap[id] || virtualPeerIds.has(id)) {
      return false
    }
    const activeUsers = getActiveUniqueUsers()
    return !activeUsers.has(getPeerUserId(id)) && activeUsers.size >= limit
  }

  const rejectPeer = (
    id: string,
    peer: PeerHandle,
    err: typeof roomFullMsg | typeof peerBannedMsg
  ): void => {
    if (peerMap[id] !== peer) {
      return
    }
    const errObj = err === peerBannedMsg ? peerBannedErr : roomFullErr
    handshakeManager.clearPeer(id, errObj)
    void handshakeReadyAction
      .send({ok: false, err}, id)
      .catch(noOp)
      .finally(() =>
        err === peerBannedMsg
          ? kickPeer(id, peer, errObj)
          : exitPeer(id, peer, errObj)
      )
  }

  let effectiveOnPeerHandshake = onPeerHandshake
  DEV: if (
    !verifyPeerIdentity &&
    (limit !== undefined ||
      identity !== undefined ||
      userIdentityP !== undefined)
  ) {
    effectiveOnPeerHandshake = async (id, send, receive, isInitiator) => {
      const resolvedSelfId = await localSelfIdP
      await Promise.all([
        resolvedUserIdentityP,
        id === resolvedSelfId ? undefined : getDefaultTestUserIdentity(id)
      ])
      await onPeerHandshake?.(id, send, receive, isInitiator)
    }
  }

  const handshakeManager = createHandshakeManager({
    selfId: localSelfId,
    selfIdP: localSelfIdP,
    ...(effectiveOnPeerHandshake === undefined
      ? {}
      : {onPeerHandshake: effectiveOnPeerHandshake}),
    ...(onHandshakeError === undefined ? {} : {onHandshakeError}),
    handshakeTimeoutMs,
    sendHandshakeData: handshakeDataAction.send,
    sendHandshakeReady: handshakeReadyAction.send,
    onLocalHandshakePassed: (id, peer) => {
      if (isAlreadyFullForPeer(id)) {
        rejectPeer(id, peer, roomFullMsg)
        return false
      }
      return true
    },
    onActivate: (id, peer) => {
      if (isPeerBanned(id)) {
        kickPeer(id, peer, peerBannedErr)
        return
      }
      if (isAlreadyFullForPeer(id)) {
        rejectPeer(id, peer, roomFullMsg)
        return
      }
      const alreadyJoined = virtualPeerIds.delete(id)
      activePeerMap[id] = peer
      scaleProvider?.addDirectPeer(id, peer)
      for (const cb of peerActivatedListeners) {
        cb(id, peer)
      }
      if (limit !== undefined && getActiveUniqueUsers().size >= limit) {
        for (const pendingId of handshakeManager.getPendingIds()) {
          if (
            !activePeerMap[pendingId] &&
            (!verifyPeerIdentity || peerUserIds.has(pendingId)) &&
            isAlreadyFullForPeer(pendingId)
          ) {
            const pendingPeer =
              handshakeManager.getPeer(pendingId) ?? peerMap[pendingId]
            if (pendingPeer) {
              rejectPeer(pendingId, pendingPeer, roomFullMsg)
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
      if (reason.message.includes(peerBannedMsg)) {
        rejectPeer(id, peer, peerBannedMsg)
        return
      }
      kickPeer(id, peer, reason)
    }
  })

  signalAction.onMessage((sdp, id) => {
    void activePeerMap[id]?.signal(sdp as never)
  })

  streamMetaAction.onMessage((meta, id) =>
    mediaManager.receiveStreamMeta(meta, id)
  )

  leaveAction.onMessage((_, id) => exitPeer(id, undefined, peerLeftRoomErr))

  handshakeDataAction.onMessage((data, id, metadata) => {
    if (!leavePromise) {
      handshakeManager.receiveHandshakeData(data, id, metadata)
    }
  })

  handshakeReadyAction.onMessage((data, id) => {
    if (!leavePromise) {
      if (data && typeof data === 'object' && !data.ok) {
        if (data.err === roomFullMsg) {
          if (!handshakeManager.getPeer(id) || activePeerMap[id]) {
            return
          }
          handshakeManager.clearPeer(id, roomFullErr)
          if (
            !didReportRoomFull &&
            !(keys(activePeerMap).length > 0 && isAlreadyFullForPeer(id))
          ) {
            didReportRoomFull = true
            onHandshakeError?.(id, roomFullMsg)
          }
          exitPeer(id, peerMap[id], roomFullErr)
          return
        }
        if (data.err === peerBannedMsg) {
          handshakeManager.clearPeer(id, peerBannedErr)
          onHandshakeError?.(id, peerBannedMsg)
          kickPeer(id, peerMap[id], peerBannedErr)
          return
        }
      }
      handshakeManager.receiveHandshakeReady(id)
    }
  })

  onPeer((peer, id) => {
    if (leavePromise) {
      return
    }
    if (isPeerBanned(id) || (peerUserIds.has(id) && isAlreadyFullForPeer(id))) {
      peer.destroy()
      return
    }
    const existingPeer = peerMap[id]
    const wasVirtual = Boolean(existingPeer && isVirtualPeer(id))

    if (existingPeer) {
      if (existingPeer === peer) {
        return
      }

      if (wasVirtual) {
        delete peerMap[id]
      } else {
        existingPeer.destroy()
        clearPeerState(id, mkErr('peer replaced'))
      }
    }

    peerMap[id] = peer
    handshakeManager.addPeer(id, peer)

    peer.setHandlers({
      data: d => {
        if (peerMap[id] === peer && !isPeerBanned(id)) {
          if (!scaleProvider?.handleFrame(id, d)) {
            handleData(id, d)
          }
        }
      },
      stream: stream => {
        if (!isPeerBanned(id)) {
          mediaManager.receiveRemoteStream(id, stream)
        }
      },
      close: () => exitPeer(id, peer, peerDisconnectedErr),
      error: (err: Error) => {
        logErr('peer', err)
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
    ready: pluginSetupP,

    makeAction,

    leave,

    ping: async target => {
      const start = Date.now()
      await pingAction.request('', {target})
      return Date.now() - start
    },

    getSelf: async (): Promise<SelfInfo> => {
      const [, resolvedUser] = await Promise.all([
        localEndpointP,
        resolvedUserIdentityP,
        pluginSetupP
      ])
      if (pluginSetupError) {
        throw pluginSetupError
      }
      const userId = resolvedUser.userId
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

    addStream: (stream, options: AddMediaOptions = {}) =>
      mediaManager.addStream(stream, options, streamMetaAction.send),

    removeStream: (stream, options: RemoveMediaOptions = {}) => {
      mediaManager.removeStream(stream, options.target)
    },

    replaceTrack: (oldTrack, newTrack, options: RemoveMediaOptions = {}) =>
      mediaManager.replaceTrack(oldTrack, newTrack, options.target),

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
    }
  }

  roomInstanceRef = roomInstance

  roomSignalingBridges.set(roomInstance, {
    getScaleProvider: () => scaleProvider,
    setOnScaleTargetsChanged: cb => {
      scaleTargetsChangedCallback = cb
      scaleProvider?.setOnTargetsChanged(cb)
    },
    canConnectPeer: peerId =>
      !isPeerBanned(peerId) &&
      !(peerUserIds.has(peerId) && isAlreadyFullForPeer(peerId)),
    onPeerIdentityVerified: (peerId, verified) => {
      peerUserIds.set(peerId, verified.userId)
      if (isPeerBanned(peerId) || isPeerBanned(verified.userId)) {
        scaleProvider?.markPeerBanned(peerId)
        throw peerBannedErr
      }
      peerPubKeys.set(peerId, verified.peerPubKey)
      scaleProvider?.setPeerSignPublicKey(peerId, verified.peerPubKey)
      rolesProvider?.registerPeerPublicKey(peerId, verified.userPubKey)
    },
    getPeerHandle: peerId => handshakeManager.getPeer(peerId) ?? peerMap[peerId]
  })

  return roomInstance as RoomWithPlugins<TPlugins>
}
