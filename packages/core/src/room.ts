import {
  createEventEmitter,
  createWindowCounter,
  entries,
  fromEntries,
  getConfiguredPlugins,
  internalActionPrefix,
  isBrowser,
  isSelfAsAdminPlugin,
  keys,
  lockMethods,
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
  toErrorMessage,
  warnEphemeralAdmin,
  warnNoPeer
} from './utils'
import {createActionManager} from './actions'
import {
  createHandshakeManager,
  type HandshakeReadyPayload,
  type VerifiedPeerIdentity
} from './handshake'
import {
  type EndpointIdentity,
  getDefaultEndpointIdentity,
  isEphemeralIdentityConfig,
  resolveUserIdentity
} from './identity'
import {createMediaManager, type InternalMediaMeta} from './media'
import {
  createPeerRegistry,
  type PeerActivationResult,
  type PeerDeactivationResult
} from './peer-registry'
import {createStateManager, jwkToCompactPub} from './state'
import type {
  AddMediaOptions,
  DataPayload,
  KernelRolesProvider,
  KernelRoomErrorInput,
  KernelScaleProvider,
  PeerHandle,
  PeerHandshake,
  PeerJoinContext,
  PeerLeaveContext,
  RemoveMediaOptions,
  Room,
  RoomError,
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

const isBanError = (err?: Error | string): boolean => {
  if (!err) {
    return false
  }
  if (err === peerBannedErr || err === peerBannedMsg) {
    return true
  }
  const msg = typeof err === 'string' ? err : err.message
  return (
    msg === peerBannedMsg ||
    msg === peerBannedErr.message ||
    msg.includes(peerBannedMsg)
  )
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
  emitError: (error: RoomError) => void
}

const roomSignalingBridges = new WeakMap<Room, RoomSignalingBridge>()

export const getRoomSignalingBridge = (
  room: Room
): RoomSignalingBridge | undefined => roomSignalingBridges.get(room)

type RoomOptions = {
  selfId?: string
  endpointIdentityP?: Promise<EndpointIdentity>
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
    endpointIdentityP,
    appId = '',
    roomId: initialRoomId = '',
    password = '',
    limit,
    preResolvedPlugins,
    identity,
    userIdentityP,
    verifyPeerIdentity = false,
    onPeerHandshake,
    handshakeTimeoutMs = defaultHandshakeTimeoutMs,
    maxReceiveBytes,
    onBeforeLeave
  } = roomOptions
  let localSelfId = explicitSelfId ?? ''
  const localEndpointP = (
    endpointIdentityP ?? getDefaultEndpointIdentity(explicitSelfId, appId)
  ).then(ep => {
    if (!explicitSelfId) {
      localSelfId = ep.peerId
    }
    return ep
  })
  const localSelfIdP = explicitSelfId
    ? Promise.resolve(explicitSelfId)
    : localEndpointP.then(ep => ep.peerId)
  const deferredBanDestroyPeers = new Map<
    PeerHandle,
    ReturnType<typeof setTimeout>
  >()
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
  const peerActivatedEmitter = createEventEmitter<[string, PeerHandle]>(
    'peer activated handler'
  )
  const peerDeactivatedEmitter = createEventEmitter<[string]>(
    'peer deactivated handler'
  )
  const roomIdChangedEmitter = createEventEmitter<[string]>(
    'room id changed handler'
  )
  const leaveEmitter = createEventEmitter<[]>('leave handler')
  const peerJoinEmitter = createEventEmitter<[PeerJoinContext]>('onPeerJoin')
  const peerLeaveEmitter = createEventEmitter<[PeerLeaveContext]>('onPeerLeave')
  const userJoinEmitter = createEventEmitter<[UserJoinContext]>('onUserJoin')
  const userLeaveEmitter = createEventEmitter<[UserLeaveContext]>('onUserLeave')
  const errorEmitter = createEventEmitter<[RoomError]>('onError')
  let leavePromise: Promise<void> | null = null

  const emitRoomError = (error: KernelRoomErrorInput): void => {
    if (!leavePromise) {
      errorEmitter.emit({
        ...error,
        appId,
        roomId: effectiveRoomId
      } as RoomError)
    }
  }

  let localUserId = ''
  const peerRegistry = createPeerRegistry({
    getSelfId: () => localSelfId,
    getLocalUserId: () => localUserId
  })

  const resolvedUserIdentityP = (
    userIdentityP ??
    resolveUserIdentity(
      appId,
      initialRoomId,
      identity === undefined ? undefined : {identity},
      explicitSelfId
    ).catch(err => {
      queueMicrotask(() => {
        emitRoomError({
          code: 'identity-failed',
          message: toErrorMessage(err, 'identity resolution failed'),
          cause: err
        })
      })
      throw err
    })
  ).then(resolvedId => {
    localUserId = resolvedId.userId
    return resolvedId
  })
  void resolvedUserIdentityP.catch(noOp)

  const {
    getPeerUserId,
    getKnownPeerUserId,
    getUserPeerIds,
    resolveSendTarget,
    resolveRequestTarget
  } = peerRegistry

  const isDirectPeer = (id: string): boolean => peerRegistry.isDirectActive(id)

  const isPeerBanned = (id: string): boolean =>
    rolesProvider?.isPeerBanned(id) ?? false

  const getPeerRoles = (id = localSelfId): string[] =>
    rolesProvider?.getPeerRoles(id) ?? []

  const reportHandshakeError = (
    peerId: string,
    error: string,
    cause?: Error
  ): void => {
    const cleanMsg = error.replace(/^handshake failed: /, '')
    if (isBanError(cleanMsg) || isBanError(cause) || isPeerBanned(peerId)) {
      return
    }
    emitRoomError({
      code: 'handshake-failed',
      peerId,
      message: cleanMsg,
      ...(cause !== undefined ? {cause} : {})
    })
  }

  const emitActivatedEvents = (
    peerId: string,
    res: PeerActivationResult
  ): void => {
    if (!res.becameRoomActive) {
      return
    }
    stateManager.onPeerJoined(peerId, res.userId, isDirectPeer(peerId))
    const roles = getPeerRoles(peerId)
    peerJoinEmitter.emit({peerId, userId: res.userId, roles})
    if (res.isFirstForUser && res.userId !== localUserId) {
      userJoinEmitter.emit({userId: res.userId, peerId, roles})
    }
  }

  const emitDeactivatedEvents = (
    peerId: string,
    res: PeerDeactivationResult
  ): void => {
    if (!res.wasRoomActive) {
      return
    }
    stateManager.onPeerDisconnected(peerId)
    peerDeactivatedEmitter.emit(peerId)
    peerLeaveEmitter.emit({peerId, userId: res.userId})
    if (res.isLastForUser && res.userId !== localUserId) {
      userLeaveEmitter.emit({userId: res.userId, peerId})
      stateManager.onUserLeft(res.userId)
    }
  }

  let unregisterBeforeUnloadCleanup: () => void = noOp
  let didReportRoomFull = false

  const iterate = (
    targets: TargetPeers,
    f: (id: string, directPeer?: PeerHandle) => Promise<void> | void
  ): Promise<void>[] => {
    const resolvedTargets = resolveSendTarget(targets)
    return (
      resolvedTargets
        ? Array.isArray(resolvedTargets)
          ? resolvedTargets
          : [resolvedTargets]
        : peerRegistry.getPeerIds(false)
    ).flatMap(id => {
      if (!peerRegistry.isRoomActive(id)) {
        warnNoPeer(id)
        return []
      }
      return [Promise.resolve(f(id, peerRegistry.getDirectPeer(id, false)))]
    })
  }

  const kickPeer = (id: string, peer?: PeerHandle, reason?: Error): void => {
    const banned = isBanError(reason)
    const currentDirect = peerRegistry.getDirectPeer(id, true)
    if (peer) {
      if (currentDirect !== peer && !banned) {
        return
      }
    } else if (!peerRegistry.hasAnyPeer(id)) {
      if (banned) {
        scaleProvider?.markPeerBanned(id)
      }
      return
    }

    if (currentDirect) {
      void leaveAction.send('', id).catch(noOp)
    }
    exitPeer(id, peer, reason)
  }

  const onPeerError = (id: string, error: Error): void => {
    if (peerRegistry.hasAnyPeer(id) && !isBanError(error)) {
      emitRoomError({
        code: 'peer-error',
        peerId: id,
        message: toErrorMessage(error, 'peer error'),
        cause: error
      })
    }
    kickPeer(id, undefined, error)
  }

  const mediaManager = createMediaManager({
    onPeerError,
    getPeerUserId,
    preparePeer: id => {
      const direct = peerRegistry.getDirectPeer(id, false)
      if (direct) {
        return Promise.resolve(direct)
      }
      if (scaleProvider?.prepareMediaPeer) {
        return scaleProvider.prepareMediaPeer(id)
      }
      return Promise.reject(peerDisconnectedErr)
    },
    iterate,
    isActive: id => peerRegistry.isRoomActive(id)
  })

  const actionManager = createActionManager({
    onPeerError,
    ...(maxReceiveBytes === undefined ? {} : {maxReceiveBytes}),
    getTransport: peerRegistry.getTransport,
    getPeerIds: peerRegistry.getPeerIds,
    getPeerUserId,
    resolveSendTarget,
    resolveRequestTarget,
    canReceiveFromPeer: (id, receiveWhilePending) =>
      !isPeerBanned(id) &&
      (peerRegistry.isRoomActive(id) ||
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

  const peerStatePenalty = createWindowCounter(512, 8)

  const recordPeerStateFailure = (fromPeerId?: string): void => {
    scaleProvider?.recordSignatureFailure()
    if (!fromPeerId || fromPeerId === localSelfId) {
      return
    }
    if (peerStatePenalty.hit(fromPeerId)) {
      peerStatePenalty.reset(fromPeerId)
      onPeerError(fromPeerId, mkErr('excessive invalid state records'))
    }
  }

  const stateManager = createStateManager({
    appId,
    getRoomId: () => effectiveRoomId,
    getSelfId: () => localSelfId,
    getLocalUserId: () => localUserId,
    ensureReady: async () => {
      const [, resolvedUser] = await Promise.all([
        localEndpointP,
        resolvedUserIdentityP,
        pluginSetupP
      ])
      if (pluginSetupError) {
        throw pluginSetupError
      }
      if (rolesProvider) {
        const auth = await rolesProvider.getAuthorityInfo()
        return {
          selfId: localSelfId,
          user: resolvedUser,
          roomId: auth.roomId
        }
      }
      return {
        selfId: localSelfId,
        user: resolvedUser,
        roomId: effectiveRoomId
      }
    },
    hasRolesPlugin: () => hasRolesPlugin,
    getRolesProvider: () => rolesProvider,
    getScaleProvider: () => scaleProvider,
    isPeerActive: peerId => peerRegistry.isRoomActive(peerId),
    isPeerPendingHandshake: peerId =>
      Boolean(handshakeManager.getPeer(peerId) && !isDirectPeer(peerId)),
    isDirectPeer,
    getDirectPeerIds: () => peerRegistry.getDirectPeerIds(true),
    isUserOnline: peerRegistry.isUserOnline,
    getKnownPeerUserId,
    getPeerUserPub: peerRegistry.getVerifiedUserPub,
    isPeerBanned: peerOrUserId =>
      Boolean(peerOrUserId && isPeerBanned(peerOrUserId)),
    getPeerRoles: peerOrUserId => getPeerRoles(peerOrUserId),
    makeInternalAction: makeActionInternal,
    onInvalidRecord: recordPeerStateFailure
  })

  const destroyDirectHandle = (peer: PeerHandle, banned: boolean): void => {
    if (banned && !leavePromise) {
      peer.setHandlers({
        data: noOp,
        stream: noOp,
        close: noOp,
        error: noOp
      })
      const timer = setTimeout(() => {
        deferredBanDestroyPeers.delete(peer)
        peer.destroy()
      }, 40)
      ;(timer as {unref?: () => void}).unref?.()
      deferredBanDestroyPeers.set(peer, timer)
    } else {
      peer.destroy()
    }
  }

  const exitPeer = (id: string, peer?: PeerHandle, reason?: Error): void => {
    const err = toError(reason, peerDisconnectedMsg)
    const banned = isBanError(reason) || isBanError(err)
    const currentDirect = peerRegistry.getDirectPeer(id, true)

    if (peer) {
      if (currentDirect !== peer) {
        if (banned) {
          scaleProvider?.markPeerBanned(id)
          if (!peerRegistry.hasAnyPeer(id)) {
            return
          }
        } else {
          return
        }
      }
    } else if (!peerRegistry.hasAnyPeer(id)) {
      if (banned) {
        scaleProvider?.markPeerBanned(id)
      }
      return
    }

    // Unbanned failure of a pending direct promotion while virtual overlay route stays active
    if (
      !banned &&
      currentDirect &&
      !peerRegistry.isDirectActive(id) &&
      peerRegistry.hasVirtual(id)
    ) {
      handshakeManager.clearPeer(id, err)
      stateManager.clearPeer(id)
      peerRegistry.removePendingDirectOnly(id, currentDirect)
      currentDirect.destroy()
      scaleProvider?.removeDirectPeer(id, currentDirect, err)
      onPeerLeave(id)
      return
    }

    if (banned) {
      scaleProvider?.markPeerBanned(id)
    }

    handshakeManager.clearPeer(id, err)
    stateManager.clearPeer(id)
    actionManager.clearPeer(id, err)
    mediaManager.clearPeer(id)
    const removed = peerRegistry.removePeer(id)

    if (removed.directPeer) {
      destroyDirectHandle(removed.directPeer, banned)
      scaleProvider?.removeDirectPeer(id, removed.directPeer, err)
      onPeerLeave(id)
    }

    emitDeactivatedEvents(id, removed)
  }

  const leave = (): Promise<void> =>
    (leavePromise ??= (async () => {
      onBeforeLeave?.()
      for (const id of peerRegistry.getPeerIds(true)) {
        handshakeManager.clearPeer(id, roomLeftErr)
      }
      leaveEmitter.emit()
      scaleProvider?.announceLeave()
      const leaveTargets = scaleProvider
        ? peerRegistry.getDirectPeerIds(false)
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
        for (const [peer, timer] of deferredBanDestroyPeers.entries()) {
          clearTimeout(timer)
          peer.destroy()
        }
        deferredBanDestroyPeers.clear()
        const allPeerIds = peerRegistry.getPeerIds(true)
        const directHandles = peerRegistry.clearAll()
        for (const peer of directHandles) {
          peer.destroy()
        }
        for (const id of allPeerIds) {
          stateManager.clearPeer(id)
          actionManager.clearPeer(id, roomLeftErr)
          mediaManager.clearPeer(id)
        }
      } finally {
        peerActivatedEmitter.clear()
        peerDeactivatedEmitter.clear()
        roomIdChangedEmitter.clear()
        leaveEmitter.clear()
        peerJoinEmitter.clear()
        peerLeaveEmitter.clear()
        userJoinEmitter.clear()
        userLeaveEmitter.clear()
        errorEmitter.clear()
        mediaManager.clearListeners()
        actionManager.clearListeners()
        stateManager.destroy()
        try {
          unregisterBeforeUnloadCleanup()
        } finally {
          onSelfLeave()
        }
      }
    })())

  const pingAction = makeAction<string, string>(`${internalActionPrefix}ping`, {
    kind: 'request'
  })
  pingAction.onRequest(() => '')
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
    {
      sendToPending: true,
      receiveWhilePending: true,
      maxPayloadBytes: 128 * 1024
    }
  )

  const kernel: RoomKernel = {
    get selfId() {
      return localSelfId
    },
    appId,
    initialRoomId,
    password,
    ...(limit === undefined ? {} : {limit}),
    getRoomId: () => effectiveRoomId,
    setEffectiveRoomId: rid => {
      if (rid && rid !== effectiveRoomId) {
        effectiveRoomId = rid
        roomIdChangedEmitter.emit(rid)
      }
    },
    getLocalUserIdentity: () => resolvedUserIdentityP,
    getPeerUserId,
    getKnownPeerUserId,
    setPeerUserId: peerRegistry.setPeerUserId,
    getUserPeerIds,
    getPeerPublicKey: peerRegistry.getPeerPubKey,
    setPeerPublicKey: (peerId, pubKey) => {
      peerRegistry.setPeerPubKey(peerId, pubKey)
      scaleProvider?.setPeerSignPublicKey(peerId, pubKey)
    },
    getActivePeerIds: () => peerRegistry.getDirectPeerIds(true),
    getAllPeerIds: () => peerRegistry.getPeerIds(true),
    isPeerActive: peerId => peerRegistry.isRoomActive(peerId),
    getPeerHandle: (peerId, includePending = false) =>
      peerRegistry.getDirectPeer(peerId, includePending),
    resolveSendTarget,
    resolveRequestTarget,
    kickPeer: (peerId, reason) => kickPeer(peerId, undefined, reason),
    purgeBannedUserState: userId => stateManager.purgeBannedUser(userId),
    emitError: err => emitRoomError(err),
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
      for (const [pid, pubKey] of peerRegistry.getPubKeyEntries()) {
        provider.setPeerSignPublicKey(pid, pubKey)
      }
      for (const [id, peer] of peerRegistry.getDirectPeerEntries(true)) {
        provider.addDirectPeer(id, peer)
      }
    },
    getRolesProvider: () => rolesProvider,
    getScaleProvider: () => scaleProvider,
    onPeerActivated: (cb, options) =>
      peerActivatedEmitter.subscribe(cb, options, () =>
        peerRegistry.getDirectPeerEntries(true)
      ),
    onPeerDeactivated: (cb, options) =>
      peerDeactivatedEmitter.subscribe(cb, options),
    onRoomIdChanged: (cb, options) =>
      roomIdChangedEmitter.subscribe(cb, options),
    onLeave: (cb, options) => leaveEmitter.subscribe(cb, options),
    activateVirtualPeer: (peerId, transport) => {
      if (isPeerBanned(peerId) || isAlreadyFullForPeer(peerId)) {
        transport.close?.()
        return false
      }
      if (peerRegistry.isDirectActive(peerId)) {
        transport.close?.()
        return true
      }
      const res = peerRegistry.activateVirtual(peerId, transport)
      emitActivatedEvents(peerId, res)
      return true
    },
    deactivateVirtualPeer: (peerId, reason) => {
      if (peerRegistry.isDirectActive(peerId)) {
        return
      }
      const err = toError(reason, peerDisconnectedMsg)
      const res = peerRegistry.deactivateVirtual(peerId)
      if (!res.wasRoomActive) {
        return
      }
      if (!peerRegistry.hasAnyPeer(peerId)) {
        stateManager.clearPeer(peerId)
        actionManager.clearPeer(peerId, err)
        mediaManager.clearPeer(peerId)
      }
      emitDeactivatedEvents(peerId, res)
    }
  }

  if (
    !userIdentityP &&
    plugins.some(isSelfAsAdminPlugin) &&
    isEphemeralIdentityConfig(identity)
  ) {
    warnEphemeralAdmin()
  }
  const pluginApis: Record<string, unknown> = {}
  let didRunPluginSetup = false
  let pluginSetupError: unknown = null
  let failedPluginName: string | undefined
  const runPluginSetup = (): void => {
    if (didRunPluginSetup) {
      if (pluginSetupError) {
        throw pluginSetupError
      }
      return
    }
    didRunPluginSetup = true
    let activePluginName: string | undefined
    try {
      const seenPluginApiKeys = new Set<string>()
      for (const plugin of plugins) {
        activePluginName = plugin.name
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
      activePluginName = undefined
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
      failedPluginName = activePluginName
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
        emitRoomError({
          code: 'plugin-failed',
          ...(failedPluginName !== undefined ? {plugin: failedPluginName} : {}),
          message: toErrorMessage(err, 'plugin setup failed'),
          cause: err
        })
        onSelfLeave()
        throw err
      }
    })
    void pluginSetupP.catch(noOp)
  }

  const isAlreadyFullForPeer = (id: string): boolean => {
    if (limit === undefined || peerRegistry.isRoomActive(id)) {
      return false
    }
    const activeUsers = peerRegistry.getActiveUniqueUsers()
    return !activeUsers.has(getPeerUserId(id)) && activeUsers.size >= limit
  }

  const rejectPeer = (
    id: string,
    peer: PeerHandle,
    err: typeof roomFullMsg | typeof peerBannedMsg
  ): void => {
    if (peerRegistry.getDirectPeer(id, true) !== peer) {
      return
    }
    const errObj = err === peerBannedMsg ? peerBannedErr : roomFullErr
    if (err === peerBannedMsg) {
      scaleProvider?.markPeerBanned(id)
    }
    const banReason =
      err === peerBannedMsg
        ? (rolesProvider?.getBanReason?.(getPeerUserId(id)) ??
          rolesProvider?.getBanReason?.(id))
        : undefined
    handshakeManager.clearPeer(id, errObj)
    stateManager.clearPeer(id)
    void handshakeReadyAction
      .send(
        {
          ok: false,
          err,
          ...(banReason !== undefined ? {reason: banReason} : {})
        },
        id
      )
      .catch(noOp)
      .finally(() => {
        const closeNow = (): void => {
          peerRegistry.clearRejectTimer(id)
          if (peerRegistry.getDirectPeer(id, true) !== peer) {
            return
          }
          if (err === peerBannedMsg) {
            kickPeer(id, peer, errObj)
          } else {
            exitPeer(id, peer, errObj)
          }
        }
        if (!verifyPeerIdentity || leavePromise) {
          closeNow()
          return
        }
        const timer = setTimeout(closeNow, 40)
        ;(timer as {unref?: () => void}).unref?.()
        peerRegistry.setRejectTimer(id, timer)
      })
  }

  const handshakeManager = createHandshakeManager({
    selfId: localSelfId,
    selfIdP: localSelfIdP,
    ...(onPeerHandshake === undefined ? {} : {onPeerHandshake}),
    onHandshakeError: reportHandshakeError,
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
    beforeSendHandshakeReady: (id, peer) =>
      peerRegistry.getDirectPeer(id, true) === peer && !isPeerBanned(id)
        ? stateManager.prepareHandshakeReady(id)
        : undefined,
    onActivate: (id, peer) => {
      if (isPeerBanned(id)) {
        kickPeer(id, peer, peerBannedErr)
        return
      }
      if (isAlreadyFullForPeer(id)) {
        rejectPeer(id, peer, roomFullMsg)
        return
      }
      const res = peerRegistry.activateDirect(id, peer)
      if (!res) {
        return
      }
      scaleProvider?.addDirectPeer(id, peer)
      peerActivatedEmitter.emit(id, peer)
      if (
        limit !== undefined &&
        peerRegistry.getActiveUniqueUsers().size >= limit
      ) {
        for (const pendingId of handshakeManager.getPendingIds()) {
          if (
            !peerRegistry.isRoomActive(pendingId) &&
            (!verifyPeerIdentity || peerRegistry.hasKnownUserId(pendingId)) &&
            isAlreadyFullForPeer(pendingId)
          ) {
            const pendingPeer =
              handshakeManager.getPeer(pendingId) ??
              peerRegistry.getDirectPeer(pendingId, true)
            if (pendingPeer) {
              rejectPeer(pendingId, pendingPeer, roomFullMsg)
            }
          }
        }
      }
      peer.setHandlers({
        signal: sdp => {
          if (peerRegistry.getDirectPeer(id, false) === peer) {
            void signalAction
              .send(sdp as unknown as DataPayload, id)
              .catch(noOp)
          }
        }
      })
      if (res.becameRoomActive) {
        emitActivatedEvents(id, res)
      } else {
        stateManager.onPeerJoined(id, res.userId, true)
      }
    },
    onFailure: (id, peer, reason) => {
      if (isBanError(reason)) {
        rejectPeer(id, peer, peerBannedMsg)
        return
      }
      kickPeer(id, peer, reason)
    }
  })

  signalAction.onMessage((sdp, id) => {
    void peerRegistry.getDirectPeer(id, false)?.signal(sdp as never)
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

  const processHandshakeReady = (
    data: HandshakeReadyPayload,
    id: string
  ): void => {
    if (leavePromise) {
      return
    }
    if (data && typeof data === 'object' && data.ok === false) {
      if (data.err === roomFullMsg) {
        if (!handshakeManager.getPeer(id) || isDirectPeer(id)) {
          return
        }
        handshakeManager.clearPeer(id, roomFullErr)
        if (
          !didReportRoomFull &&
          !(
            peerRegistry.getPeerIds(false).length > 0 &&
            isAlreadyFullForPeer(id)
          )
        ) {
          didReportRoomFull = true
          emitRoomError({
            code: 'room-full',
            peerId: id,
            message: roomFullMsg
          })
        }
        exitPeer(id, peerRegistry.getDirectPeer(id, true), roomFullErr)
        return
      }
      if (data.err === peerBannedMsg) {
        if (!handshakeManager.getPeer(id) || isDirectPeer(id)) {
          return
        }
        const reason =
          typeof data.reason === 'string' && data.reason.length <= 512
            ? data.reason
            : undefined
        const msg = reason ? `${peerBannedMsg}: ${reason}` : peerBannedMsg
        handshakeManager.clearPeer(id, peerBannedErr)
        emitRoomError({
          code: 'banned',
          peerId: id,
          ...(reason !== undefined ? {reason} : {}),
          message: msg
        })
        kickPeer(id, peerRegistry.getDirectPeer(id, true), peerBannedErr)
        return
      }
    }
    handshakeManager.receiveHandshakeReady(id)
  }

  const deliverHandshakeReady = (
    data: HandshakeReadyPayload,
    id: string
  ): void => {
    if (data && typeof data === 'object' && data.ok === true) {
      if (!isPeerBanned(id) && !isAlreadyFullForPeer(id)) {
        void stateManager.stageHandshakeUserState(id, data, () => {
          if (!leavePromise && handshakeManager.getPeer(id)) {
            processHandshakeReady('', id)
          }
        })
        return
      }
      processHandshakeReady('', id)
      return
    }
    processHandshakeReady(data, id)
  }

  handshakeReadyAction.onMessage((data, id) => {
    if (leavePromise) {
      return
    }
    if (verifyPeerIdentity && !peerRegistry.isVerified(id)) {
      if (handshakeManager.getPeer(id) && !isDirectPeer(id)) {
        peerRegistry.setDeferredReady(id, data)
      }
      return
    }
    deliverHandshakeReady(data, id)
  })

  onPeer((peer, id) => {
    if (leavePromise) {
      return
    }
    if (
      isPeerBanned(id) ||
      (peerRegistry.hasKnownUserId(id) && isAlreadyFullForPeer(id))
    ) {
      peer.destroy()
      return
    }
    const existingDirect = peerRegistry.getDirectPeer(id, true)
    if (existingDirect) {
      if (existingDirect === peer) {
        return
      }
      const wasDirectActive = peerRegistry.isDirectActive(id)
      const replacedErr = mkErr('peer replaced')
      existingDirect.destroy()
      handshakeManager.clearPeer(id, replacedErr)
      stateManager.clearPeer(id)
      if (wasDirectActive) {
        const removed = peerRegistry.removePeer(id)
        actionManager.clearPeer(id, replacedErr)
        mediaManager.clearPeer(id)
        scaleProvider?.removeDirectPeer(id, existingDirect, replacedErr)
        emitDeactivatedEvents(id, removed)
      } else {
        peerRegistry.removePendingDirectOnly(id, existingDirect)
      }
    } else if (peerRegistry.hasVirtual(id)) {
      stateManager.clearPeer(id)
      peerRegistry.clearDirectHandshakeState(id)
    }

    peerRegistry.addPendingDirect(id, peer)
    handshakeManager.addPeer(id, peer)

    peer.setHandlers({
      data: d => {
        if (
          peerRegistry.getDirectPeer(id, true) === peer &&
          !isPeerBanned(id)
        ) {
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
        if (peerRegistry.getDirectPeer(id, true) === peer && !isBanError(err)) {
          emitRoomError({
            code: 'peer-error',
            peerId: id,
            message: toErrorMessage(err, 'peer error'),
            cause: err
          })
        }
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

    makeState: stateManager.makeState,

    makeUserState: stateManager.makeUserState,

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
      const persisted = resolvedUser.persisted ?? false
      const identityPersistence = resolvedUser.persistence ?? 'none'
      if (rolesProvider) {
        const auth = await rolesProvider.getAuthorityInfo()
        return {
          peerId: localSelfId,
          userId,
          persisted,
          identityPersistence,
          roomId: auth.roomId,
          baseRoomId: auth.baseRoomId,
          isAdmin: auth.isAdmin,
          roles: auth.roles
        }
      }
      return {
        peerId: localSelfId,
        userId,
        persisted,
        identityPersistence,
        roomId: effectiveRoomId,
        baseRoomId: initialRoomId,
        isAdmin: false,
        roles: []
      }
    },

    getPeers: () =>
      fromEntries(
        peerRegistry.getPeerIds(false).map(id => {
          const directPeer = peerRegistry.getDirectPeer(id, false)
          const direct = Boolean(directPeer)
          const hops = direct ? 1 : (scaleProvider?.getRoute(id)?.hops ?? 2)
          return [
            id,
            {
              userId: getPeerUserId(id),
              connection: directPeer ? directPeer.connection : null,
              direct,
              hops,
              roles: getPeerRoles(id)
            }
          ]
        })
      ),

    getUsers: () => {
      const result: Record<string, UserInfo> = {}
      for (const peerId of peerRegistry.getPeerIds(false)) {
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

    onPeerJoin: (handler, options) =>
      peerJoinEmitter.subscribe(handler, options, () =>
        peerRegistry.getPeerIds(false).map((peerId): [PeerJoinContext] => [
          {
            peerId,
            userId: getPeerUserId(peerId),
            roles: getPeerRoles(peerId)
          }
        ])
      ),

    onPeerLeave: (handler, options) =>
      peerLeaveEmitter.subscribe(handler, options),

    onUserJoin: (handler, options) =>
      userJoinEmitter.subscribe(handler, options, () => {
        const items: [UserJoinContext][] = []
        for (const [userId, peerIds] of peerRegistry.getActiveUserEntries()) {
          if (userId === localUserId) {
            continue
          }
          const firstPeerId = [...peerIds][0]
          if (firstPeerId) {
            items.push([
              {
                userId,
                peerId: firstPeerId,
                roles: getPeerRoles(firstPeerId)
              }
            ])
          }
        }
        return items
      }),

    onUserLeave: (handler, options) =>
      userLeaveEmitter.subscribe(handler, options),

    onPeerStream: (handler, options) =>
      mediaManager.onPeerStream(handler, options),

    onError: (handler, options) => errorEmitter.subscribe(handler, options)
  }

  lockMethods(roomInstance, [
    'onPeerJoin',
    'onPeerLeave',
    'onUserJoin',
    'onUserLeave',
    'onPeerStream',
    'onError'
  ])

  roomInstanceRef = roomInstance

  roomSignalingBridges.set(roomInstance, {
    getScaleProvider: () => scaleProvider,
    setOnScaleTargetsChanged: cb => {
      scaleTargetsChangedCallback = cb
      scaleProvider?.setOnTargetsChanged(cb)
    },
    canConnectPeer: peerId =>
      !isPeerBanned(peerId) &&
      !(peerRegistry.hasKnownUserId(peerId) && isAlreadyFullForPeer(peerId)),
    onPeerIdentityVerified: (peerId, verified) => {
      peerRegistry.setPeerUserId(peerId, verified.userId)
      if (isPeerBanned(peerId) || isPeerBanned(verified.userId)) {
        scaleProvider?.markPeerBanned(peerId)
        throw peerBannedErr
      }
      peerRegistry.setVerifiedIdentity(
        peerId,
        verified.userId,
        verified.peerPubKey,
        jwkToCompactPub(verified.userPubKey)
      )
      scaleProvider?.setPeerSignPublicKey(peerId, verified.peerPubKey)
      rolesProvider?.registerPeerPublicKey(peerId, verified.userPubKey)
      const readyPayload = peerRegistry.takeDeferredReady(peerId)
      if (readyPayload !== undefined) {
        queueMicrotask(() => {
          if (peerRegistry.isVerified(peerId)) {
            deliverHandshakeReady(readyPayload, peerId)
          }
        })
      }
    },
    getPeerHandle: peerId =>
      handshakeManager.getPeer(peerId) ??
      peerRegistry.getDirectPeer(peerId, true),
    emitError: err => {
      if (!leavePromise) {
        errorEmitter.emit(err)
      }
    }
  })

  return roomInstance as RoomWithPlugins<TPlugins>
}
