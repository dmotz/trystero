import {createActionManager} from './actions'
import type {HandshakeReadyPayload, VerifiedPeerIdentity} from './handshake'
import {
  type EndpointIdentity,
  getDefaultEndpointIdentity,
  resolveUserIdentity
} from './identity'
import type {
  InternalRoomContext,
  KernelRolesProvider,
  KernelScaleProvider
} from './internal-types'
import {createMediaManager, type InternalMediaMeta} from './media'
import {
  createPeerRegistry,
  type PeerActivationResult,
  type PeerDeactivationResult
} from './peer-registry'
import {signalingBridgeSymbol} from './primitives'
import {createRoomAdmission} from './room-admission'
import {
  directMeshPolicy,
  isBanError,
  openAuthPolicy,
  registerBeforeUnloadCleanup,
  resolvePluginRoomIds,
  setupRoomPlugins,
  validateAndPreparePlugins
} from './room-bootstrap'
import {createStateManager} from './state'
import type {
  AddMediaOptions,
  DataPayload,
  KernelRoomErrorInput,
  PeerHandle,
  PeerHandshake,
  PeerJoinContext,
  PeerLeaveContext,
  PluginContext,
  RemoveMediaOptions,
  Room,
  RoomError,
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
import {
  createEventEmitter,
  createWindowCounter,
  fromEntries,
  internalActionPrefix,
  isBrowser,
  lockMethods,
  logErr,
  mkErr,
  noOp,
  peerDisconnectedErr,
  peerDisconnectedMsg,
  peerLeftRoomErr,
  requiresRolesErr,
  roomLeftErr,
  toError,
  toErrorMessage,
  warnNoPeer
} from './utils'

const defaultHandshakeTimeoutMs = 10_000

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

export const getRoomSignalingBridge = (
  room: Room
): RoomSignalingBridge | undefined =>
  (room as Room & {[signalingBridgeSymbol]?: RoomSignalingBridge})[
    signalingBridgeSymbol
  ]

export type RoomOptions = {
  selfId?: string
  endpointIdentityP?: Promise<EndpointIdentity>
  appId?: string
  roomId?: string
  effectiveRoomIdP?: Promise<string>
  password?: string
  limit?: number
  use?: readonly RoomPlugin<string, any>[]
  preResolvedPlugins?: Map<RoomPlugin, unknown>
  didResolvePluginRoomIds?: boolean
  identity?: UserIdentityConfig
  userIdentityP?: Promise<UserIdentity>
  verifyPeerIdentity?: boolean
  runIdentityHandshake?: boolean
  maxReceiveBytes?: number
  onPeerHandshake?: PeerHandshake
  handshakeTimeoutMs?: number
  onBeforeLeave?: () => void
}

export const createRoomWithBridge = <
  const TPlugins extends readonly RoomPlugin<string, any>[] | undefined =
    undefined
>(
  onPeer: (f: (peer: PeerHandle, id: string) => void) => void,
  onPeerLeave: (id: string) => void,
  onSelfLeave: () => void,
  roomOptions: RoomOptions & {use?: TPlugins} = {}
): {room: RoomWithPlugins<TPlugins>; bridge: RoomSignalingBridge} => {
  const {
    selfId: explicitSelfId,
    endpointIdentityP,
    appId = '',
    roomId: initialRoomId = '',
    password = '',
    limit,
    identity,
    userIdentityP,
    verifyPeerIdentity = false,
    runIdentityHandshake = false,
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
  const {plugins, resolveOrderPlugins, hasRolesPlugin} =
    validateAndPreparePlugins(
      roomOptions.use,
      initialRoomId,
      identity,
      Boolean(userIdentityP)
    )
  let effectiveRoomId = initialRoomId
  let rolesProvider: KernelRolesProvider | null = null
  let scaleProvider: KernelScaleProvider | null = null
  let scaleTargetsChangedCallback: ((targetPeerIds: string[]) => void) | null =
    null
  let roomInstanceRef: Room | null = null
  const auth = (): KernelRolesProvider => rolesProvider ?? openAuthPolicy
  const mesh = (): KernelScaleProvider => scaleProvider ?? directMeshPolicy
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

  const setEffectiveRoomId = (rid: string): void => {
    if (rid && rid !== effectiveRoomId) {
      effectiveRoomId = rid
      roomIdChangedEmitter.emit(rid)
    }
  }

  let localUserId = ''
  const peerRegistry = createPeerRegistry({
    getSelfId: () => localSelfId,
    getLocalUserId: () => localUserId
  })

  let didReportLocalIdentityError = false
  const resolvedUserIdentityP = (
    userIdentityP ??
    resolveUserIdentity(
      appId,
      initialRoomId,
      identity === undefined ? undefined : {identity},
      explicitSelfId
    ).catch(err => {
      didReportLocalIdentityError = true
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

  const localResolvedPlugins = roomOptions.didResolvePluginRoomIds
    ? {
        preResolvedPlugins: roomOptions.preResolvedPlugins,
        effectiveRoomIdP: roomOptions.effectiveRoomIdP
      }
    : resolvePluginRoomIds(
        resolveOrderPlugins,
        appId,
        initialRoomId,
        resolvedUserIdentityP,
        (pluginName, err) => {
          if (!didReportLocalIdentityError && !roomOptions.userIdentityP) {
            queueMicrotask(() => {
              emitRoomError({
                code: 'plugin-failed',
                plugin: pluginName,
                message: toErrorMessage(err, 'room resolution failed'),
                cause: err
              })
            })
          }
        }
      )
  const preResolvedPlugins =
    roomOptions.preResolvedPlugins ?? localResolvedPlugins.preResolvedPlugins
  const effectiveRoomIdP =
    roomOptions.effectiveRoomIdP ?? localResolvedPlugins.effectiveRoomIdP

  if (effectiveRoomIdP) {
    void effectiveRoomIdP.then(rid => {
      if (!leavePromise) {
        setEffectiveRoomId(rid)
      }
    }, noOp)
  }

  const {
    getPeerUserId,
    getKnownPeerUserId,
    getUserPeerIds,
    resolveSendTarget,
    resolveRequestTarget
  } = peerRegistry

  const isDirectPeer = (id: string): boolean => peerRegistry.isDirectActive(id)
  const isPeerBanned = (id: string): boolean => auth().isPeerBanned(id)
  const getPeerRoles = (id = localSelfId): string[] => auth().getPeerRoles(id)

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
        mesh().markPeerBanned(id)
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
        admission.canReceiveFromPeer(id, receiveWhilePending)),
    broadcastInline: (frame, onProgress) =>
      mesh().broadcastInline(frame, onProgress),
    registerActionAuthority: (namespace, roles) => {
      if (!rolesProvider && !hasRolesPlugin) {
        throw requiresRolesErr('action role gating')
      }
      if (roles.length > 0) {
        pendingActionAuthorities.set(namespace, [...roles])
      } else {
        pendingActionAuthorities.delete(namespace)
      }
      mesh().registerActionAuthority(namespace, roles)
    },
    getPeerRoles: peerId => getPeerRoles(peerId),
    onUnauthorizedAction: () => {
      mesh().recordSignatureFailure()
    },
    signActionPayload: async (namespace, requiredRoles, data, userMetadata) =>
      (await ensureRolesReady()).signActionPayload(
        namespace,
        requiredRoles,
        data,
        userMetadata
      ),
    verifyActionOffer: async (namespace, peerId, requiredRoles, wireMetadata) =>
      (await ensureRolesReady()).verifyActionOffer(
        namespace,
        peerId,
        requiredRoles,
        wireMetadata
      ),
    verifyActionPayload: async (
      namespace,
      peerId,
      requiredRoles,
      data,
      wireMetadata
    ) =>
      (await ensureRolesReady()).verifyActionPayload(
        namespace,
        peerId,
        requiredRoles,
        data,
        wireMetadata
      )
  })
  const ensureRolesReady = async (): Promise<KernelRolesProvider> => {
    if (!rolesProvider && hasRolesPlugin) {
      await pluginSetupP
    }
    return auth()
  }
  const makeActionInternal = actionManager.makeInternalAction
  const handleData = actionManager.handleData
  const makeAction = actionManager.makeAction

  const peerStatePenalty = createWindowCounter(512, 8)

  const recordPeerStateFailure = (fromPeerId?: string): void => {
    mesh().recordSignatureFailure()
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
        pluginSetupP,
        ...(effectiveRoomIdP ? [effectiveRoomIdP] : [])
      ])
      const pluginSetupError = getPluginSetupError()
      if (pluginSetupError) {
        throw pluginSetupError
      }
      if (rolesProvider) {
        const info = await rolesProvider.getAuthorityInfo()
        return {
          selfId: localSelfId,
          user: resolvedUser,
          roomId: info.roomId
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
      Boolean(admission.getPendingPeer(peerId) && !isDirectPeer(peerId)),
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
          mesh().markPeerBanned(id)
          if (!peerRegistry.hasAnyPeer(id)) {
            return
          }
        } else {
          return
        }
      }
    } else if (!peerRegistry.hasAnyPeer(id)) {
      if (banned) {
        mesh().markPeerBanned(id)
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
      admission.clearPendingPeer(id, err)
      stateManager.clearPeer(id)
      peerRegistry.removePendingDirectOnly(id, currentDirect)
      currentDirect.destroy()
      mesh().removeDirectPeer(id, currentDirect, err)
      onPeerLeave(id)
      return
    }

    if (banned) {
      mesh().markPeerBanned(id)
    }

    admission.clearPendingPeer(id, err)
    stateManager.clearPeer(id)
    actionManager.clearPeer(id, err)
    mediaManager.clearPeer(id)
    const removed = peerRegistry.removePeer(id)

    if (removed.directPeer) {
      destroyDirectHandle(removed.directPeer, banned)
      mesh().removeDirectPeer(id, removed.directPeer, err)
      onPeerLeave(id)
    }

    emitDeactivatedEvents(id, removed)
  }

  const leave = (): Promise<void> =>
    (leavePromise ??= (async () => {
      onBeforeLeave?.()
      admission.clearAllAdmission(roomLeftErr)
      leaveEmitter.emit()
      mesh().announceLeave()
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
        mesh().destroy()
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

  const publicKernel: PluginContext = {
    get selfId() {
      return localSelfId
    },
    appId,
    initialRoomId,
    password,
    ...(limit === undefined ? {} : {limit}),
    getRoomId: () => effectiveRoomId,
    getLocalUserIdentity: () => resolvedUserIdentityP,
    getPeerUserId,
    getKnownPeerUserId,
    getUserPeerIds,
    getPeerPublicKey: peerRegistry.getPeerPubKey,
    getActivePeerIds: () => peerRegistry.getPeerIds(false),
    getAllPeerIds: () => peerRegistry.getPeerIds(true),
    isPeerActive: peerId => peerRegistry.isRoomActive(peerId),
    getPeerHandle: (peerId, includePending = false) =>
      peerRegistry.getDirectPeer(peerId, includePending),
    resolveSendTarget,
    resolveRequestTarget,
    kickPeer: (peerId, reason) => kickPeer(peerId, undefined, reason),
    emitError: err => emitRoomError(err),
    makeAction,
    makeInternalAction: makeActionInternal,
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
    onLeave: (cb, options) => leaveEmitter.subscribe(cb, options)
  }

  const internalKernel: InternalRoomContext = {
    ...publicKernel,
    get selfId() {
      return localSelfId
    },
    ...(effectiveRoomIdP === undefined ? {} : {effectiveRoomIdP}),
    setEffectiveRoomId,
    setPeerUserId: peerRegistry.setPeerUserId,
    setPeerPublicKey: (peerId, pubKey) => {
      peerRegistry.setPeerPubKey(peerId, pubKey)
      mesh().setPeerSignPublicKey(peerId, pubKey)
    },
    getDirectActivePeerIds: () => peerRegistry.getDirectPeerIds(true),
    deliverRawData: (originPeerId, data) => {
      if (isPeerBanned(originPeerId)) {
        mesh().recordSignatureFailure()
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
    getInternalRolesProvider: () => rolesProvider,
    getInternalScaleProvider: () => scaleProvider,
    activateVirtualPeer: (peerId, transport) => {
      if (isPeerBanned(peerId) || admission.isAlreadyFullForPeer(peerId)) {
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
    },
    purgeBannedUserState: userId => stateManager.purgeBannedUser(userId)
  }

  const {pluginApis, pluginSetupP, roomReadyP, getPluginSetupError} =
    setupRoomPlugins({
      plugins,
      preResolvedPlugins,
      initialRoomId,
      hasImmediateSelfId: Boolean(localSelfId),
      localEndpointP,
      effectiveRoomIdP,
      isLeaving: () => Boolean(leavePromise),
      setEffectiveRoomId,
      onSelfLeave,
      emitRoomError,
      publicKernel,
      internalKernel,
      hasRolesProvider: () => Boolean(rolesProvider),
      getRoomInstance: () => roomInstanceRef
    })

  const admission = createRoomAdmission({
    appId,
    initialRoomId,
    effectiveRoomIdP,
    limit,
    verifyPeerIdentity,
    runIdentityHandshake,
    handshakeTimeoutMs,
    onPeerHandshake,
    getSelfId: () => localSelfId,
    selfIdP: localSelfIdP,
    endpointIdentityP: localEndpointP,
    getUserIdentity: () => resolvedUserIdentityP,
    isLeaving: () => Boolean(leavePromise),
    peerRegistry,
    isPeerBanned,
    getBanReason: peerOrUserId => rolesProvider?.getBanReason?.(peerOrUserId),
    getRolesProvider: () => rolesProvider,
    getScaleProvider: () => scaleProvider,
    prepareHandshakeReady: id => stateManager.prepareHandshakeReady(id),
    stageHandshakeUserState: (id, data, done) =>
      stateManager.stageHandshakeUserState(id, data, done),
    clearStatePeer: id => stateManager.clearPeer(id),
    onStatePeerJoined: (id, userId, isDirect) =>
      stateManager.onPeerJoined(id, userId, isDirect),
    sendHandshakeData: handshakeDataAction.send,
    sendHandshakeReady: handshakeReadyAction.send,
    sendSignal: signalAction.send,
    emitRoomError,
    emitPeerActivated: (id, peer) => peerActivatedEmitter.emit(id, peer),
    emitActivatedEvents,
    kickPeer,
    exitPeer
  })

  signalAction.onMessage((sdp, id) => {
    void peerRegistry.getDirectPeer(id, false)?.signal(sdp as never)
  })

  streamMetaAction.onMessage((meta, id) =>
    mediaManager.receiveStreamMeta(meta, id)
  )

  leaveAction.onMessage((_, id) => exitPeer(id, undefined, peerLeftRoomErr))

  handshakeDataAction.onMessage((data, id, metadata) =>
    admission.receiveHandshakeData(data, id, metadata)
  )

  handshakeReadyAction.onMessage((data, id) =>
    admission.receiveHandshakeReadyMessage(data, id)
  )

  onPeer((peer, id) => {
    if (leavePromise) {
      return
    }
    if (
      isPeerBanned(id) ||
      (peerRegistry.hasKnownUserId(id) && admission.isAlreadyFullForPeer(id))
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
      admission.clearPendingPeer(id, replacedErr)
      stateManager.clearPeer(id)
      if (wasDirectActive) {
        const removed = peerRegistry.removePeer(id)
        actionManager.clearPeer(id, replacedErr)
        mediaManager.clearPeer(id)
        mesh().removeDirectPeer(id, existingDirect, replacedErr)
        emitDeactivatedEvents(id, removed)
      } else {
        peerRegistry.removePendingDirectOnly(id, existingDirect)
      }
    } else if (peerRegistry.hasVirtual(id)) {
      stateManager.clearPeer(id)
      peerRegistry.clearDirectHandshakeState(id)
    }

    peerRegistry.addPendingDirect(id, peer)
    admission.addPendingPeer(id, peer)

    peer.setHandlers({
      data: d => {
        if (
          peerRegistry.getDirectPeer(id, true) === peer &&
          !isPeerBanned(id)
        ) {
          if (!mesh().handleFrame(id, d)) {
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

    admission.startPeer(id, peer)
  })

  if (isBrowser) {
    unregisterBeforeUnloadCleanup = registerBeforeUnloadCleanup(() =>
      leave().catch(noOp)
    )
  }

  const roomInstance: Room = {
    ready: roomReadyP,

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
        roomReadyP
      ])
      const pluginSetupError = getPluginSetupError()
      if (pluginSetupError) {
        throw pluginSetupError
      }
      const userId = resolvedUser.userId
      const persisted = resolvedUser.persisted ?? false
      const identityPersistence = resolvedUser.persistence ?? 'none'
      if (rolesProvider) {
        const info = await rolesProvider.getAuthorityInfo()
        return {
          peerId: localSelfId,
          userId,
          persisted,
          identityPersistence,
          roomId: info.roomId,
          baseRoomId: info.baseRoomId,
          isAdmin: info.isAdmin,
          roles: info.roles
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
          const hops = direct ? 1 : (mesh().getRoute(id)?.hops ?? 2)
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

  const bridge: RoomSignalingBridge = {
    getScaleProvider: () => scaleProvider,
    setOnScaleTargetsChanged: cb => {
      scaleTargetsChangedCallback = cb
      scaleProvider?.setOnTargetsChanged(cb)
    },
    canConnectPeer: peerId =>
      !isPeerBanned(peerId) &&
      !(
        peerRegistry.hasKnownUserId(peerId) &&
        admission.isAlreadyFullForPeer(peerId)
      ),
    onPeerIdentityVerified: admission.onPeerIdentityVerified,
    getPeerHandle: admission.getPeerHandle,
    emitError: err => {
      if (!leavePromise) {
        errorEmitter.emit(err)
      }
    }
  }

  Object.defineProperty(roomInstance, signalingBridgeSymbol, {
    value: bridge,
    enumerable: false
  })

  return {
    room: roomInstance as RoomWithPlugins<TPlugins>,
    bridge
  }
}

export default <
  const TPlugins extends readonly RoomPlugin<string, any>[] | undefined =
    undefined
>(
  onPeer: (f: (peer: PeerHandle, id: string) => void) => void,
  onPeerLeave: (id: string) => void,
  onSelfLeave: () => void,
  roomOptions: RoomOptions & {use?: TPlugins} = {}
): RoomWithPlugins<TPlugins> =>
  createRoomWithBridge(onPeer, onPeerLeave, onSelfLeave, roomOptions).room
