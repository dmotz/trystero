import {createActionManager} from './actions'
import {formatSelfCertifyingRoomId} from './authority'
import {
  createHandshakeManager,
  createIdentityHandshake,
  type HandshakeReadyPayload,
  type VerifiedPeerIdentity
} from './handshake'
import {
  createIdentityClientId,
  type EndpointIdentity,
  getDefaultEndpointIdentity,
  isEphemeralIdentityConfig,
  resolveUserIdentity,
  validateIdentityConfig
} from './identity'
import type {
  ActionOptions,
  InternalAction,
  InternalMessageContext,
  InternalPluginSlot,
  InternalRoomContext,
  KernelRolesProvider,
  KernelRoomErrorInput,
  KernelScaleProvider,
  PeerDataTransport,
  PeerHandle,
  RolesPluginSlot,
  ScalePluginSlot,
  TargetPeers
} from './internal-types'
import {createMediaManager, type InternalMediaMeta} from './media'
import {createDirectPeerTransport, destroyAfterFlush} from './peer-transport'
import {createBoundedCache, pluginSlotSymbol} from './primitives'
import {createStateManager, type StateManager} from './state'
import type {
  AddMediaOptions,
  AnyRoomPlugin,
  DataPayload,
  PeerJoinContext,
  PeerLeaveContext,
  RemoveMediaOptions,
  ReplaceTrackOptions,
  RolesPluginApi,
  Room,
  RoomError,
  RoomWithPlugins,
  ScalePluginApi,
  SelfInfo,
  UserIdentityConfig,
  UserInfo,
  UserJoinContext,
  UserLeaveContext
} from './types'
import {
  all,
  cmpStr,
  createEventEmitter,
  createWindowCounter,
  entries,
  fromEntries,
  isBrowser,
  isPosSafeInt,
  lockMethods,
  logErr,
  mkBannedErr,
  mkErr,
  noOp,
  peerBannedErr,
  peerBannedMsg,
  peerDisconnectedErr,
  peerDisconnectedMsg,
  peerLeftRoomErr,
  posSafeIntErr,
  requiresRolesErr,
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

const leaveFlushGraceMs = 50
const unloadEvent = 'beforeunload'
const beforeUnloadRoomCleanups = /*@__PURE__*/ new Set<() => void>()
const frozenEmptyRoles: string[] = Object.freeze([] as string[]) as string[]

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

const isPromiseLike = <T>(val: T | Promise<T>): val is Promise<T> =>
  Boolean(
    val &&
    typeof val === 'object' &&
    typeof (val as PromiseLike<unknown>).then === 'function'
  )

const extractPluginSlots = (
  use: readonly AnyRoomPlugin[] | undefined,
  initialRoomId: string,
  identity: UserIdentityConfig | undefined
): readonly [
  rolesSlot: RolesPluginSlot | null,
  scaleSlot: ScalePluginSlot | null
] => {
  if (use !== undefined && !Array.isArray(use)) {
    throw mkErr('use must be an array of room plugins')
  }
  let rolesSlot: RolesPluginSlot | null = null
  let scaleSlot: ScalePluginSlot | null = null
  for (const item of use ?? []) {
    const slot =
      item && typeof item === 'object'
        ? (item as {[pluginSlotSymbol]?: InternalPluginSlot})[pluginSlotSymbol]
        : undefined
    if (!slot) {
      throw mkErr('invalid plugin in use[]; expected roles() or scale()')
    }
    if (slot.kind === 'roles') {
      if (rolesSlot) {
        throw mkErr('duplicate plugin "roles" in use[]')
      }
      rolesSlot = slot
    } else {
      if (scaleSlot) {
        throw mkErr('duplicate plugin "scale" in use[]')
      }
      scaleSlot = slot
    }
  }
  if (!rolesSlot && selfCertifyingRoomRegex.test(initialRoomId)) {
    throw selfCertRoomRolesErr
  }
  if (rolesSlot?.selfAsAdmin && isEphemeralIdentityConfig(identity)) {
    warnEphemeralAdmin()
  }
  return [rolesSlot, scaleSlot]
}

export type RoomSignalingBridge = {
  readonly localEndpointP: Promise<EndpointIdentity>
  readonly effectiveRoomIdP: Promise<string> | undefined
  hasSetupFailed: () => boolean
  getScaleProvider: () => KernelScaleProvider | null
  setOnScaleTargetsChanged: (cb: (targetPeerIds: string[]) => void) => void
  canConnectPeer: (peerId: string) => boolean
  emitError: (error: RoomError) => void
}

export type RoomOptions = {
  endpointIdentity?: EndpointIdentity | Promise<EndpointIdentity>
  clientId?: string
  appId?: string
  roomId?: string
  password?: string
  maxUsers?: number
  use?: readonly AnyRoomPlugin[]
  identity?: UserIdentityConfig
  maxReceiveBytes?: number
  onBeforeLeave?: () => void
}

type DirectSession = {
  peer: PeerHandle
  transport: PeerDataTransport
  active: boolean
}

type PeerEntry = {
  direct: DirectSession | null
  virtual: PeerDataTransport | null
  userId?: string
  verified: boolean
  deferredReady?: HandshakeReadyPayload
}

export const createRoomWithBridge = <
  const TPlugins extends readonly AnyRoomPlugin[] | undefined = undefined
>(
  onPeer: (f: (peer: PeerHandle, id: string) => void) => void,
  onPeerLeave: (id: string, shouldReannounce?: boolean) => void,
  onSelfLeave: () => void,
  roomOptions: RoomOptions & {use?: TPlugins} = {}
): readonly [room: RoomWithPlugins<TPlugins>, bridge: RoomSignalingBridge] => {
  const {
    endpointIdentity,
    clientId,
    appId = '',
    roomId: initialRoomId = '',
    password = '',
    maxUsers,
    identity,
    maxReceiveBytes,
    onBeforeLeave
  } = roomOptions

  if (maxUsers !== undefined && !isPosSafeInt(maxUsers)) {
    throw posSafeIntErr('maxUsers')
  }
  if (identity !== undefined) {
    validateIdentityConfig({identity})
  }

  const [rolesSlot, scaleSlot] = extractPluginSlots(
    roomOptions.use,
    initialRoomId,
    identity
  )
  const hasRolesPlugin = Boolean(rolesSlot)
  const hasScalePlugin = Boolean(scaleSlot)

  const effectiveClientId =
    clientId ??
    (endpointIdentity && !isPromiseLike(endpointIdentity)
      ? endpointIdentity.peerId
      : createIdentityClientId())

  let localSelfId =
    endpointIdentity && !isPromiseLike(endpointIdentity)
      ? endpointIdentity.peerId
      : ''

  let leavePromise: Promise<void> | null = null
  let didReportSetupError = false
  let effectiveRoomId = initialRoomId
  let rolesProvider: KernelRolesProvider | null = null
  let scaleProvider: KernelScaleProvider | null = null
  let scaleTargetsChangedCallback: ((targetPeerIds: string[]) => void) | null =
    null
  let cachedUsersSnapshot: Readonly<Record<string, UserInfo>> | null = null
  const invalidateUsersSnapshot = (): void => {
    cachedUsersSnapshot = null
  }
  const pendingFlushDestroys = new Set<() => void>()
  const pendingActionAuthorities = new Map<string, string[]>()
  const cleanups: Array<() => void> = []

  const mkEv = <T extends unknown[]>(name: string) => {
    const [sub, emit, clear] = createEventEmitter<T>(name)
    cleanups.push(clear)
    return [sub, emit] as const
  }

  const [subPeerActivated, emitPeerActivated] =
    mkEv<[string, PeerHandle]>('onPeerActivated')
  const [subPeerDeactivated, emitPeerDeactivated] =
    mkEv<[string]>('onPeerDeactivated')
  const [subRoomIdChanged, emitRoomIdChanged] =
    mkEv<[string]>('onRoomIdChanged')
  const [subLeave, emitLeave] = mkEv<[]>('onLeave')
  const [subPeerJoin, emitPeerJoin] = mkEv<[PeerJoinContext]>('onPeerJoin')
  const [subPeerLeave, emitPeerLeave] = mkEv<[PeerLeaveContext]>('onPeerLeave')
  const [subUserJoin, emitUserJoin] = mkEv<[UserJoinContext]>('onUserJoin')
  const [subUserLeave, emitUserLeave] = mkEv<[UserLeaveContext]>('onUserLeave')
  const [subError, emitError] = mkEv<[RoomError]>('onError')

  const emitRoomError = (error: KernelRoomErrorInput): void => {
    if (!leavePromise) {
      emitError({
        ...error,
        appId,
        roomId: effectiveRoomId
      } as RoomError)
    }
  }

  const failSetup = (error: KernelRoomErrorInput): void => {
    if (didReportSetupError || leavePromise) {
      return
    }
    didReportSetupError = true
    queueMicrotask(() => {
      emitRoomError(error)
      void leave()
    })
  }

  const localEndpointP: Promise<EndpointIdentity> = (
    endpointIdentity
      ? Promise.resolve(endpointIdentity)
      : getDefaultEndpointIdentity(appId, effectiveClientId)
  ).then(
    ep => {
      localSelfId = ep.peerId
      return ep
    },
    err => {
      failSetup({
        code: 'identity-failed',
        message: toErrorMessage(err, 'endpoint identity resolution failed'),
        cause: err
      })
      throw err
    }
  )
  void localEndpointP.catch(noOp)

  const localSelfIdP = localSelfId
    ? Promise.resolve(localSelfId)
    : localEndpointP.then(ep => ep.peerId)
  void localSelfIdP.catch(noOp)

  const setEffectiveRoomId = (rid: string): void => {
    if (rid && rid !== effectiveRoomId) {
      effectiveRoomId = rid
      emitRoomIdChanged(rid)
    }
  }

  let localUserId = ''
  const peerEntries = new Map<string, PeerEntry>()

  const resolvedUserIdentityP = resolveUserIdentity(
    appId,
    initialRoomId,
    identity === undefined ? undefined : {identity},
    effectiveClientId
  ).then(
    resolvedId => {
      localUserId = resolvedId.userId
      invalidateUsersSnapshot()
      return resolvedId
    },
    err => {
      failSetup({
        code: 'identity-failed',
        message: toErrorMessage(err, 'identity resolution failed'),
        cause: err
      })
      throw err
    }
  )
  void resolvedUserIdentityP.catch(noOp)

  const effectiveRoomIdP: Promise<string> | undefined =
    rolesSlot?.selfAsAdmin && !selfCertifyingRoomRegex.test(initialRoomId)
      ? resolvedUserIdentityP.then(u => {
          const rid = formatSelfCertifyingRoomId(initialRoomId, u.userId)
          if (!leavePromise) {
            setEffectiveRoomId(rid)
          }
          return rid
        })
      : undefined
  void effectiveRoomIdP?.catch(noOp)

  const ensureEntry = (id: string): PeerEntry => {
    let entry = peerEntries.get(id)
    if (!entry) {
      entry = {direct: null, virtual: null, verified: false}
      peerEntries.set(id, entry)
    }
    return entry
  }

  const pruneIfDisconnected = (id: string, entry: PeerEntry): void => {
    if (!entry.direct && !entry.virtual) {
      peerEntries.delete(id)
    }
  }

  const isActiveEntry = (entry: PeerEntry | undefined): boolean =>
    Boolean(entry && (entry.direct?.active || entry.virtual))

  const hasSessionEntry = (
    entry: PeerEntry | undefined,
    includePending: boolean
  ): boolean =>
    includePending
      ? Boolean(entry && (entry.direct || entry.virtual))
      : isActiveEntry(entry)

  const getPeerUserId = (id: string): string =>
    id === localSelfId
      ? localUserId
      : (peerEntries.get(id)?.userId ?? scaleProvider?.getPeerUserId(id) ?? id)

  const getKnownPeerUserId = (id: string): string | undefined =>
    id === localSelfId
      ? localUserId
      : (peerEntries.get(id)?.userId ?? scaleProvider?.getPeerUserId(id))

  const setPeerUserId = (id: string, uid: string): void => {
    if (!uid) {
      return
    }
    const entry = peerEntries.get(id)
    if (!entry || entry.verified) {
      return
    }
    if (entry.userId !== uid) {
      entry.userId = uid
      invalidateUsersSnapshot()
    }
  }

  const countActivePeersForUser = (
    uid: string,
    excludePeerId?: string
  ): number => {
    let count = 0
    for (const [pid, entry] of peerEntries) {
      if (
        pid !== excludePeerId &&
        isActiveEntry(entry) &&
        getPeerUserId(pid) === uid
      ) {
        count++
      }
    }
    return count
  }

  const isDirectPeer = (id: string): boolean =>
    Boolean(peerEntries.get(id)?.direct?.active)

  const isPeerActive = (id: string): boolean =>
    isActiveEntry(peerEntries.get(id))

  const hasAnyPeer = (id: string): boolean =>
    hasSessionEntry(peerEntries.get(id), true)

  const getDirectPeer = (
    id: string,
    includePending = false
  ): PeerHandle | undefined => {
    const direct = peerEntries.get(id)?.direct
    return direct && (includePending || direct.active) ? direct.peer : undefined
  }

  const getPeerIds = (includePending = false): string[] => {
    const ids: string[] = []
    for (const [id, entry] of peerEntries) {
      if (hasSessionEntry(entry, includePending)) {
        ids.push(id)
      }
    }
    return ids
  }

  const getDirectPeerEntries = (activeOnly = true): [string, PeerHandle][] => {
    const list: [string, PeerHandle][] = []
    for (const [id, entry] of peerEntries) {
      if (entry.direct && (!activeOnly || entry.direct.active)) {
        list.push([id, entry.direct.peer])
      }
    }
    return list
  }

  const getDirectPeerIds = (activeOnly = true): string[] =>
    getDirectPeerEntries(activeOnly).map(pair => pair[0])

  const clearVerifiedFields = (entry: PeerEntry): void => {
    entry.verified = false
    delete entry.deferredReady
  }

  const resetDirectEntry = (id: string, entry: PeerEntry): void => {
    entry.direct = null
    clearVerifiedFields(entry)
    pruneIfDisconnected(id, entry)
    invalidateUsersSnapshot()
  }

  const findPeersForUser = (uid: string, includePending: boolean): string[] => {
    const matching: string[] = []
    for (const [pid, entry] of peerEntries) {
      if (
        hasSessionEntry(entry, includePending) &&
        getPeerUserId(pid) === uid
      ) {
        matching.push(pid)
      }
    }
    return matching
  }

  const getUserPeerIds = (uid: string): string[] => {
    const active = findPeersForUser(uid, false)
    return active.length ? active : findPeersForUser(uid, true)
  }

  const resolveSendTarget = (
    targets: TargetPeers,
    includePending = false
  ): TargetPeers => {
    if (!targets) {
      return undefined
    }
    const resolved: string[] = []
    const seen = new Set<string>()
    const addPeer = (pid: string): void => {
      if (!seen.has(pid)) {
        seen.add(pid)
        resolved.push(pid)
      }
    }
    for (const id of Array.isArray(targets) ? targets : [targets]) {
      if (hasSessionEntry(peerEntries.get(id), includePending)) {
        addPeer(id)
      } else {
        const matched = findPeersForUser(id, includePending)
        if (matched.length) {
          matched.forEach(addPeer)
        } else {
          addPeer(id)
        }
      }
    }
    return resolved
  }

  const resolveRequestTarget = (
    target: string,
    includePending = false
  ): string | undefined =>
    hasSessionEntry(peerEntries.get(target), includePending)
      ? target
      : findPeersForUser(target, includePending).sort((a, b) => {
          const aDirect = isDirectPeer(a)
          return aDirect !== isDirectPeer(b) ? (aDirect ? -1 : 1) : cmpStr(a, b)
        })[0]

  const isPeerBanned = (id: string): boolean =>
    Boolean(rolesProvider?.isPeerBanned(id))

  const getPeerRoles = (id = localSelfId): string[] =>
    rolesProvider?.getPeerRoles(id) ?? frozenEmptyRoles

  let stateMgr: StateManager | null = null

  const emitActivatedEvents = (
    peerId: string,
    uid: string,
    isFirstForUser: boolean
  ): void => {
    if (leavePromise) {
      return
    }
    stateMgr?.onPeerJoined(peerId, uid, isDirectPeer(peerId))
    const roles = getPeerRoles(peerId)
    emitPeerJoin({peerId, userId: uid, roles})
    if (isFirstForUser && uid !== localUserId) {
      emitUserJoin({userId: uid, peerId, roles})
    }
  }

  const emitDeactivatedEvents = (
    peerId: string,
    wasActive: boolean,
    isLastForUser: boolean,
    uid: string
  ): void => {
    if (!wasActive) {
      return
    }
    stateMgr?.onPeerDisconnected(peerId)
    emitPeerDeactivated(peerId)
    if (!leavePromise) {
      emitPeerLeave({peerId, userId: uid})
      if (isLastForUser && uid !== localUserId) {
        emitUserLeave({userId: uid, peerId})
        stateMgr?.onUserLeft(uid)
      }
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
        : getPeerIds(false)
    ).flatMap(id => {
      if (!isPeerActive(id)) {
        warnNoPeer(id)
        return []
      }
      return [Promise.resolve(f(id, getDirectPeer(id, false)))]
    })
  }

  const scheduleFlushDestroy = (peer: PeerHandle): void => {
    let completed = false
    let finish: () => void = noOp
    finish = destroyAfterFlush(peer, 40, 150, () => {
      completed = true
      pendingFlushDestroys.delete(finish)
    })
    if (!completed && finish !== noOp) {
      pendingFlushDestroys.add(finish)
    }
  }

  const kickPeer = (id: string, peer?: PeerHandle, reason?: Error): void => {
    const cur = getDirectPeer(id, true)
    if (cur && (!peer || cur === peer || reason === peerBannedErr)) {
      void leaveAction.send('', {target: id}).catch(noOp)
    }
    exitPeer(id, peer, reason)
  }

  const reportPeerError = (id: string, error: Error): void => {
    if (error !== peerBannedErr) {
      emitRoomError({
        code: 'peer-error',
        peerId: id,
        message: toErrorMessage(error, 'peer error'),
        cause: error
      })
    }
  }

  const onPeerError = (id: string, error: Error): void => {
    if (hasAnyPeer(id)) {
      reportPeerError(id, error)
    }
    kickPeer(id, undefined, error)
  }

  const mediaManager = createMediaManager({
    iterate,
    isActive: isPeerActive,
    onPeerError,
    preparePeer: id => {
      const direct = getDirectPeer(id, false)
      return direct
        ? Promise.resolve(direct)
        : scaleProvider
          ? scaleProvider.prepareMediaPeer(id)
          : Promise.reject(peerDisconnectedErr)
    },
    getPeerUserId,
    onPeerMediaPinChange: (id, pinned) => {
      scaleProvider?.setPeerMediaPinned(id, pinned)
    }
  })

  const actionManager = createActionManager({
    getPeerIds,
    canReceiveFromPeer: (id, receiveWhilePending) =>
      !isPeerBanned(id) &&
      (isPeerActive(id) || hs.canReceiveFromPeer(id, receiveWhilePending)),
    onPeerError,
    getTransport: (id, includePending) => {
      const entry = peerEntries.get(id)
      return entry
        ? ((entry.direct && (includePending || entry.direct.active)
            ? entry.direct.transport
            : undefined) ??
            entry.virtual ??
            undefined)
        : undefined
    },
    broadcastInline: (frame, onProgress, signal) =>
      scaleProvider
        ? scaleProvider.broadcastInline(frame, onProgress, signal)
        : false,
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
    getLocalActionCert: (requiredRoles, namespace) =>
      rolesProvider
        ? rolesProvider.getLocalActionCert(requiredRoles, namespace)
        : Promise.resolve(null),
    authorizePeerAction: (peerId, requiredRoles, inlineCert) =>
      rolesProvider
        ? rolesProvider.authorizePeerAction(peerId, requiredRoles, inlineCert)
        : false,
    getPeerRoles: peerId => getPeerRoles(peerId),
    getPeerUserId,
    resolveSendTarget,
    resolveRequestTarget,
    ...(maxReceiveBytes === undefined ? {} : {maxReceiveBytes})
  })

  const {
    makeAction,
    makeInternalAction,
    makeInternalRequestAction,
    handleData,
    clearPeer: clearActionPeer,
    clearListeners: clearActionListeners
  } = actionManager

  const awaitSelfState = async () => {
    const [, user] = await all([
      localEndpointP,
      resolvedUserIdentityP,
      roomReadyP
    ])
    return [user, await rolesProvider?.getAuthorityInfo()] as const
  }

  const [hitStatePenalty, resetStatePenalty] = createWindowCounter(512, 8)
  const rawStateControlAction = makeInternalAction<DataPayload>('state')
  let stateControlHandler:
    | ((data: DataPayload, context: InternalMessageContext) => unknown)
    | null = null

  rawStateControlAction.onMessage((data, context) => {
    ensureStateManager()
    return stateControlHandler?.(data, context)
  })

  const ensureStateManager = (): StateManager =>
    (stateMgr ??= createStateManager({
      appId,
      getRoomId: () => effectiveRoomId,
      getSelfId: () => localSelfId,
      getLocalUserId: () => localUserId,
      ensureReady: async () => {
        const [user, info] = await awaitSelfState()
        return {
          selfId: localSelfId,
          user,
          roomId: info?.roomId ?? effectiveRoomId
        }
      },
      hasRolesPlugin: () => hasRolesPlugin,
      getRolesProvider: () => rolesProvider,
      getScaleProvider: () => scaleProvider,
      isPeerActive,
      isPeerPendingHandshake: peerId =>
        Boolean(hs.getPeer(peerId) && !isDirectPeer(peerId)),
      isDirectPeer,
      getDirectPeerIds: () => getDirectPeerIds(true),
      isUserOnline: uid =>
        Boolean(
          (localUserId && uid === localUserId) ||
          countActivePeersForUser(uid) > 0
        ),
      getKnownPeerUserId,
      isPeerBanned: peerOrUserId =>
        Boolean(peerOrUserId && isPeerBanned(peerOrUserId)),
      getPeerRoles: peerOrUserId => getPeerRoles(peerOrUserId),
      makeInternalAction: <T extends DataPayload = DataPayload>(
        namespace: string,
        options?: Partial<ActionOptions>
      ): InternalAction<T> =>
        namespace === 'state'
          ? ({
              send: rawStateControlAction.send as InternalAction<T>['send'],
              onReceiveProgress: rawStateControlAction.onReceiveProgress,
              onReceive: rawStateControlAction.onReceive,
              onMessage: (handler, listenerOpts) => {
                if (listenerOpts?.signal?.aborted) {
                  return noOp
                }
                stateControlHandler =
                  handler as unknown as typeof stateControlHandler
                const unsub = () => {
                  if (stateControlHandler === (handler as unknown)) {
                    stateControlHandler = null
                  }
                }
                listenerOpts?.signal?.addEventListener('abort', unsub, {
                  once: true
                })
                return unsub
              }
            } satisfies InternalAction<T>)
          : makeInternalAction<T>(namespace, options),
      onInvalidRecord: fromPeerId => {
        if (!fromPeerId || fromPeerId === localSelfId) {
          return
        }
        if (hitStatePenalty(fromPeerId)) {
          resetStatePenalty(fromPeerId)
          onPeerError(fromPeerId, mkErr('excessive invalid state records'))
        }
      }
    }))

  if (hasScalePlugin) {
    ensureStateManager()
  }

  const removePeerEntry = (
    id: string
  ): [
    wasActive: boolean,
    isLast: boolean,
    uid: string,
    directPeer: PeerHandle | undefined
  ] => {
    const entry = peerEntries.get(id)
    if (!entry) {
      return [false, false, getPeerUserId(id), undefined]
    }
    const wasActive = isActiveEntry(entry)
    const uid = entry.userId ?? scaleProvider?.getPeerUserId(id) ?? id
    const directPeer = entry.direct?.peer
    const virtualTransport = entry.virtual
    entry.direct = null
    entry.virtual = null
    virtualTransport?.close?.()
    clearVerifiedFields(entry)
    const isLast = wasActive && countActivePeersForUser(uid, id) === 0
    pruneIfDisconnected(id, entry)
    if (wasActive) {
      invalidateUsersSnapshot()
    }
    return [wasActive, isLast, uid, directPeer]
  }

  const clearSubsystems = (id: string, err: Error): void => {
    stateMgr?.clearPeer(id)
    clearActionPeer(id, err)
    mediaManager.clearPeer(id)
  }

  const exitPeer = (id: string, peer?: PeerHandle, reason?: Error): void => {
    const err = toError(reason, peerDisconnectedMsg)
    const banned = reason === peerBannedErr || err === peerBannedErr
    const currentDirect = getDirectPeer(id, true)

    if (peer) {
      if (currentDirect !== peer) {
        if (banned) {
          scaleProvider?.markPeerBanned(id)
          if (!hasAnyPeer(id)) {
            return
          }
        } else {
          return
        }
      }
    } else if (!hasAnyPeer(id)) {
      if (banned) {
        scaleProvider?.markPeerBanned(id)
      }
      return
    }

    const existingEntry = peerEntries.get(id)
    if (
      !banned &&
      currentDirect &&
      !isDirectPeer(id) &&
      Boolean(existingEntry?.virtual)
    ) {
      clearPendingPeer(id, err)
      stateMgr?.clearPeer(id)
      if (
        existingEntry &&
        existingEntry.direct?.peer === currentDirect &&
        !existingEntry.direct.active
      ) {
        resetDirectEntry(id, existingEntry)
      }
      currentDirect.destroy()
      scaleProvider?.removeDirectPeer(id, currentDirect, err)
      onPeerLeave(id, false)
      return
    }

    if (banned) {
      scaleProvider?.markPeerBanned(id)
    }

    clearPendingPeer(id, err)
    clearSubsystems(id, err)
    const [wasActive, isLast, uid, directPeer] = removePeerEntry(id)

    emitDeactivatedEvents(id, wasActive, isLast, uid)

    if (directPeer) {
      if ((banned || reason === roomFullErr) && !leavePromise) {
        scheduleFlushDestroy(directPeer)
      } else {
        directPeer.destroy()
      }
      scaleProvider?.removeDirectPeer(id, directPeer, err)
      onPeerLeave(id, !banned && reason !== roomFullErr)
    } else if (wasActive) {
      scaleProvider?.removeDirectPeer(id, undefined, err)
    }
  }

  const leave = (): Promise<void> =>
    (leavePromise ??= (async () => {
      onBeforeLeave?.()
      reservedAdmissionUsers.clear()
      for (const id of getPeerIds(true)) {
        hs.clearPeer(id, roomLeftErr)
      }
      emitLeave()
      if (scaleProvider) {
        await scaleProvider.announceLeave()
      }
      const leaveTargets = scaleProvider ? getDirectPeerIds(false) : undefined
      const hasOpenPeers =
        peerEntries.size > 0 && (!leaveTargets || leaveTargets.length > 0)
      const controller = new AbortController()
      if (hasOpenPeers) {
        void leaveAction
          .send('', {
            ...(leaveTargets ? {target: leaveTargets} : {}),
            signal: controller.signal
          })
          .catch(noOp)
        await new Promise<void>(res => {
          setTimeout(res, leaveFlushGraceMs)
        })
      }
      controller.abort()

      try {
        scaleProvider?.destroy()
        for (const flushNow of pendingFlushDestroys) {
          flushNow()
        }
        pendingFlushDestroys.clear()
        const allPeerIds = getPeerIds(true)
        for (const entry of peerEntries.values()) {
          entry.direct?.peer.destroy()
          entry.virtual?.close?.()
        }
        peerEntries.clear()
        invalidateUsersSnapshot()
        for (const id of allPeerIds) {
          clearSubsystems(id, roomLeftErr)
        }
      } finally {
        for (const fn of [
          ...cleanups,
          mediaManager.clearListeners,
          clearActionListeners,
          () => stateMgr?.destroy()
        ]) {
          fn()
        }
        try {
          unregisterBeforeUnloadCleanup()
        } finally {
          onSelfLeave()
        }
      }
    })())

  const pingAction = makeInternalRequestAction<string, string>('ping')
  pingAction.onRequest(() => '')

  const signalAction = makeInternalAction('signal')
  const streamMetaAction = makeInternalAction<InternalMediaMeta>('stream', {
    maxPayloadBytes: 64 * 1024
  })
  const leaveAction = makeInternalAction<string>('leave', {
    sendToPending: true,
    receiveWhilePending: true
  })
  const handshakeDataAction = makeInternalAction<DataPayload>('hsdata', {
    sendToPending: true,
    receiveWhilePending: true,
    maxPayloadBytes: 64 * 1024
  })
  const handshakeReadyAction = makeInternalAction<HandshakeReadyPayload>(
    'hsready',
    {
      sendToPending: true,
      receiveWhilePending: true,
      maxPayloadBytes: 128 * 1024
    }
  )

  const reservedAdmissionUsers = new Map<string, string>()
  const rejectedFullPeerUsers = createBoundedCache<string, string>(256)

  const getUsersSet = (
    includeReserved = false,
    excludePeerId?: string
  ): Set<string> => {
    const users = new Set<string>([localUserId])
    for (const [pid, entry] of peerEntries) {
      if (isActiveEntry(entry)) {
        users.add(getPeerUserId(pid))
      }
    }
    if (includeReserved) {
      for (const [pid, uid] of reservedAdmissionUsers) {
        if (pid !== excludePeerId) {
          users.add(uid)
        }
      }
    }
    return users
  }

  const isFullForPeer = (id: string, includeReserved = false): boolean => {
    if (maxUsers === undefined || isPeerActive(id)) {
      return false
    }
    const users = getUsersSet(includeReserved, id)
    const candidateUid =
      peerEntries.get(id)?.userId ??
      scaleProvider?.getPeerUserId(id) ??
      rejectedFullPeerUsers.get(id) ??
      id
    return !users.has(candidateUid) && users.size >= maxUsers
  }

  const canConnectPeer = (peerId: string): boolean => {
    const knownUid =
      peerEntries.get(peerId)?.userId ??
      scaleProvider?.getPeerUserId(peerId) ??
      rejectedFullPeerUsers.get(peerId)
    return (
      !isPeerBanned(localSelfId) &&
      !isPeerBanned(peerId) &&
      !(knownUid !== undefined && isFullForPeer(peerId, true))
    )
  }

  const rejectPeer = (
    id: string,
    peer: PeerHandle,
    err: typeof roomFullMsg | typeof peerBannedMsg
  ): void => {
    if (getDirectPeer(id, true) !== peer) {
      return
    }
    const isBan = err === peerBannedMsg
    const errObj = isBan ? peerBannedErr : roomFullErr
    if (isBan) {
      scaleProvider?.markPeerBanned(id)
    } else {
      const knownUid =
        peerEntries.get(id)?.userId ?? scaleProvider?.getPeerUserId(id)
      if (knownUid) {
        rejectedFullPeerUsers.set(id, knownUid)
      }
    }
    const banReason = isBan
      ? (rolesProvider?.getBanReason(getPeerUserId(id)) ??
        rolesProvider?.getBanReason(id))
      : undefined
    hs.clearPeer(id, errObj)
    stateMgr?.clearPeer(id)
    reservedAdmissionUsers.delete(id)
    void handshakeReadyAction
      .send(
        {
          ok: false,
          err,
          ...(banReason !== undefined ? {reason: banReason} : {})
        },
        {target: id}
      )
      .catch(noOp)
      .finally(() => {
        if (getDirectPeer(id, true) !== peer) {
          return
        }
        exitPeer(id, peer, errObj)
      })
  }

  const tryAdmitPeer = (id: string, peer: PeerHandle): boolean => {
    if (isPeerBanned(id)) {
      rejectPeer(id, peer, peerBannedMsg)
      return false
    }
    if (maxUsers === undefined || isPeerActive(id)) {
      return true
    }
    if (isFullForPeer(id, true)) {
      rejectPeer(id, peer, roomFullMsg)
      return false
    }
    reservedAdmissionUsers.set(id, getPeerUserId(id))
    return true
  }

  const clearPendingPeer = (id: string, reason: Error): void => {
    hs.clearPeer(id, reason)
    reservedAdmissionUsers.delete(id)
  }

  const deliverHandshakeReady = (
    data: HandshakeReadyPayload,
    id: string
  ): void => {
    if (data && typeof data === 'object' && data.ok === true) {
      if (
        hs.getPeer(id) &&
        !isDirectPeer(id) &&
        !isPeerBanned(id) &&
        !isFullForPeer(id)
      ) {
        void ensureStateManager().stageHandshakeUserState(id, data, () => {
          if (!leavePromise && hs.getPeer(id)) {
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

  const onPeerIdentityVerified = (
    peerId: string,
    verified: VerifiedPeerIdentity,
    peer?: PeerHandle
  ): void => {
    if (peer && getDirectPeer(peerId, true) !== peer) {
      return
    }
    const entry = peerEntries.get(peerId)
    if (!entry) {
      return
    }
    entry.userId = verified.userId
    invalidateUsersSnapshot()
    if (isPeerBanned(peerId) || isPeerBanned(verified.userId)) {
      scaleProvider?.markPeerBanned(peerId)
      throw peerBannedErr
    }
    entry.verified = true
    scaleProvider?.setPeerSignPublicKey(peerId, verified.peerPubKey)
    if (entry.deferredReady !== undefined) {
      const readyPayload = entry.deferredReady
      delete entry.deferredReady
      queueMicrotask(() => {
        const cur = peerEntries.get(peerId)
        if (cur?.verified && (!peer || getDirectPeer(peerId, true) === peer)) {
          deliverHandshakeReady(readyPayload, peerId)
        }
      })
    }
  }

  const internalKernel: InternalRoomContext = {
    get selfId() {
      return localSelfId
    },
    appId,
    initialRoomId,
    password,
    ...(maxUsers === undefined ? {} : {maxUsers}),
    getRoomId: () => effectiveRoomId,
    setEffectiveRoomId,
    getLocalEndpointIdentity: () => localEndpointP,
    getLocalUserIdentity: () => resolvedUserIdentityP,
    getPeerUserId,
    getKnownPeerUserId,
    getUserPeerIds,
    setPeerUserId,
    getActivePeerIds: () => getPeerIds(false),
    getDirectActivePeerIds: () => getDirectPeerIds(true),
    getAllPeerIds: () => getPeerIds(true),
    isPeerActive,
    getPeerHandle: getDirectPeer,
    resolveSendTarget,
    resolveRequestTarget,
    kickPeer: (peerId, reason) => kickPeer(peerId, undefined, reason),
    emitError: emitRoomError,
    makeAction,
    makeInternalAction,
    deliverRawData: (originPeerId, data) => {
      if (isPeerBanned(originPeerId)) {
        return
      }
      handleData(originPeerId, data)
    },
    getRolesProvider: () => rolesProvider,
    getScaleProvider: () => scaleProvider,
    activateVirtualPeer: (peerId, transport) => {
      if (leavePromise || isPeerBanned(peerId) || isFullForPeer(peerId, true)) {
        transport.close?.()
        const ex = peerEntries.get(peerId)
        if (ex) {
          pruneIfDisconnected(peerId, ex)
        }
        return false
      }
      if (isDirectPeer(peerId)) {
        transport.close?.()
        return true
      }
      const entry = ensureEntry(peerId)
      const wasActive = isActiveEntry(entry)
      const uid = entry.userId ?? scaleProvider?.getPeerUserId(peerId) ?? peerId
      entry.userId = uid
      const isFirst = !wasActive && countActivePeersForUser(uid, peerId) === 0
      entry.virtual = transport
      invalidateUsersSnapshot()
      if (!wasActive) {
        emitActivatedEvents(peerId, uid, isFirst)
      }
      return true
    },
    deactivateVirtualPeer: (peerId, reason) => {
      if (isDirectPeer(peerId)) {
        return
      }
      const entry = peerEntries.get(peerId)
      if (!entry?.virtual) {
        return
      }
      const err = toError(reason, peerDisconnectedMsg)
      const uid = entry.userId ?? scaleProvider?.getPeerUserId(peerId) ?? peerId
      const vt = entry.virtual
      entry.virtual = null
      vt.close?.()
      const isLast = countActivePeersForUser(uid, peerId) === 0
      pruneIfDisconnected(peerId, entry)
      invalidateUsersSnapshot()
      if (!hasAnyPeer(peerId)) {
        clearSubsystems(peerId, err)
      }
      emitDeactivatedEvents(peerId, true, isLast, uid)
    },
    purgeBannedUserState: userId => {
      stateMgr?.purgeBannedUser(userId)
    },
    onRolesChanged: invalidateUsersSnapshot,
    onPeerActivated: (cb, options) =>
      subPeerActivated(cb, options, () => getDirectPeerEntries(true)),
    onPeerDeactivated: subPeerDeactivated,
    onRoomIdChanged: subRoomIdChanged,
    onLeave: subLeave
  }

  let rolesApi: RolesPluginApi | undefined
  let scaleApi: ScalePluginApi | undefined
  let pluginSetupError: unknown
  let hasSetupError = false

  if (rolesSlot) {
    try {
      const res = rolesSlot.setup(internalKernel, effectiveRoomIdP)
      rolesProvider = res.provider
      rolesApi = res.api
    } catch (err) {
      hasSetupError = true
      pluginSetupError = err
      failSetup({
        code: 'plugin-failed',
        plugin: 'roles',
        message: toErrorMessage(err, 'roles setup failed'),
        cause: err
      })
    }
  }

  if (scaleSlot && !hasSetupError) {
    try {
      const res = scaleSlot.setup(internalKernel)
      scaleProvider = res.provider
      scaleApi = res.api
      if (scaleTargetsChangedCallback) {
        scaleProvider.setOnTargetsChanged(scaleTargetsChangedCallback)
      }
      for (const [ns, roles] of pendingActionAuthorities) {
        scaleProvider.registerActionAuthority(ns, roles)
      }
    } catch (err) {
      hasSetupError = true
      pluginSetupError = err
      failSetup({
        code: 'plugin-failed',
        plugin: 'scale',
        message: toErrorMessage(err, 'scale setup failed'),
        cause: err
      })
    }
  }

  const roomReadyP = hasSetupError
    ? Promise.reject(pluginSetupError)
    : all([
        localEndpointP,
        resolvedUserIdentityP,
        ...(effectiveRoomIdP ? [effectiveRoomIdP] : [])
      ]).then(noOp)
  void roomReadyP.catch(noOp)

  const identityHandshake = createIdentityHandshake({
    endpointIdentityP: localEndpointP,
    appId,
    roomId: effectiveRoomIdP ?? initialRoomId,
    getUserIdentity: () => resolvedUserIdentityP,
    onVerified: onPeerIdentityVerified
  })

  const hs = createHandshakeManager({
    selfIdP: localSelfIdP,
    onPeerHandshake: identityHandshake.run,
    onHandshakeError: (peerId, reason) => {
      if (reason === peerBannedErr || isPeerBanned(peerId)) {
        return
      }
      emitRoomError({
        code: 'handshake-failed',
        peerId,
        message: toErrorMessage(reason, 'handshake failed'),
        cause: reason
      })
    },
    deferResponderReady: maxUsers !== undefined,
    sendHandshakeData: (data, peerId, metadata) =>
      handshakeDataAction.send(data, {
        target: peerId,
        ...(metadata === undefined ? {} : {metadata})
      }),
    sendHandshakeReady: (data, peerId) =>
      handshakeReadyAction.send(data, {target: peerId}),
    onLocalHandshakePassed: (id, peer) => {
      if (isPeerBanned(id)) {
        rejectPeer(id, peer, peerBannedMsg)
        return false
      }
      if (isFullForPeer(id)) {
        rejectPeer(id, peer, roomFullMsg)
        return false
      }
      return true
    },
    acquireAdmissionSlot: (id, peer) => {
      if (getDirectPeer(id, true) !== peer || leavePromise) {
        return false
      }
      return tryAdmitPeer(id, peer)
    },
    beforeSendHandshakeReady: (id, peer) =>
      getDirectPeer(id, true) === peer && !isPeerBanned(id) && stateMgr
        ? stateMgr.prepareHandshakeReady(id)
        : undefined,
    onActivate: (id, peer) => {
      if (isPeerBanned(id)) {
        reservedAdmissionUsers.delete(id)
        kickPeer(id, peer, peerBannedErr)
        return
      }
      if (isFullForPeer(id)) {
        rejectPeer(id, peer, roomFullMsg)
        return
      }
      const entry = peerEntries.get(id)
      reservedAdmissionUsers.delete(id)
      if (!entry || entry.direct?.peer !== peer) {
        return
      }
      const wasActive = isActiveEntry(entry)
      const uid = entry.userId ?? id
      entry.userId = uid
      const isFirst = !wasActive && countActivePeersForUser(uid, id) === 0
      entry.direct.active = true
      entry.virtual = null
      invalidateUsersSnapshot()
      scaleProvider?.addDirectPeer(id, peer)
      emitPeerActivated(id, peer)
      peer.setHandlers({
        signal: sdp => {
          if (getDirectPeer(id, false) === peer) {
            void signalAction
              .send(sdp as unknown as DataPayload, {target: id})
              .catch(noOp)
          }
        }
      })
      if (!wasActive) {
        emitActivatedEvents(id, uid, isFirst)
      } else {
        stateMgr?.onPeerJoined(id, uid, true)
      }
    },
    onFailure: (id, peer, reason) => {
      reservedAdmissionUsers.delete(id)
      if (reason === peerBannedErr) {
        rejectPeer(id, peer, peerBannedMsg)
        return
      }
      kickPeer(id, peer, reason)
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
      if (!hs.getPeer(id) || isDirectPeer(id)) {
        return
      }
      if (data.err === roomFullMsg) {
        hs.clearPeer(id, roomFullErr)
        if (!(getPeerIds(false).length > 0 && isFullForPeer(id))) {
          emitRoomError({
            code: 'room-full',
            peerId: id,
            message: roomFullMsg
          })
        }
        exitPeer(id, getDirectPeer(id, true), roomFullErr)
        return
      }
      if (data.err === peerBannedMsg) {
        const reason =
          typeof data.reason === 'string' && data.reason.length <= 512
            ? data.reason
            : undefined
        hs.clearPeer(id, peerBannedErr)
        emitRoomError(mkBannedErr(reason, id))
        kickPeer(id, getDirectPeer(id, true), peerBannedErr)
        return
      }
    }
    hs.receiveReady(id)
  }

  signalAction.onMessage((sdp, {peerId: id}) => {
    void getDirectPeer(id, false)?.signal(sdp as never)
  })

  streamMetaAction.onMessage((meta, {peerId: id}) => {
    mediaManager.receiveStreamMeta(meta, id)
  })

  leaveAction.onMessage((_, {peerId: id}) =>
    exitPeer(id, undefined, peerLeftRoomErr)
  )

  handshakeDataAction.onMessage((data, {peerId: id, metadata}) => {
    if (!leavePromise) {
      hs.receiveData(data, id, metadata)
    }
  })

  handshakeReadyAction.onMessage((data, {peerId: id}) => {
    if (leavePromise) {
      return
    }
    const entry = peerEntries.get(id)
    if (!entry?.verified) {
      if (entry && hs.getPeer(id) && !isDirectPeer(id)) {
        entry.deferredReady = data
      }
      return
    }
    deliverHandshakeReady(data, id)
  })

  onPeer((peer, id) => {
    if (leavePromise) {
      peer.destroy()
      return
    }
    if (!canConnectPeer(id)) {
      peer.destroy()
      return
    }
    const existingDirect = getDirectPeer(id, true)
    if (existingDirect) {
      if (existingDirect === peer) {
        return
      }
      const wasDirectActive = isDirectPeer(id)
      const replacedErr = mkErr('peer replaced')
      existingDirect.destroy()
      clearPendingPeer(id, replacedErr)
      if (wasDirectActive) {
        const [wasActive, isLast, uid] = removePeerEntry(id)
        clearSubsystems(id, replacedErr)
        emitDeactivatedEvents(id, wasActive, isLast, uid)
        scaleProvider?.removeDirectPeer(id, existingDirect, replacedErr)
      } else {
        stateMgr?.clearPeer(id)
        const ex = peerEntries.get(id)
        if (ex && ex.direct?.peer === existingDirect) {
          resetDirectEntry(id, ex)
        }
      }
    } else {
      const ex = peerEntries.get(id)
      if (ex?.virtual) {
        stateMgr?.clearPeer(id)
        clearVerifiedFields(ex)
      }
    }

    const entry = ensureEntry(id)
    const session: DirectSession = {
      peer,
      transport: createDirectPeerTransport(
        peer,
        () => peerEntries.get(id)?.direct === session
      ),
      active: false
    }
    entry.direct = session
    hs.addPeer(id, peer)

    peer.setHandlers({
      data: d => {
        if (getDirectPeer(id, true) === peer && !isPeerBanned(id)) {
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
        if (getDirectPeer(id, true) === peer) {
          reportPeerError(id, err)
        }
        exitPeer(id, peer, err)
      }
    })

    hs.start(id, peer)
  })

  if (isBrowser) {
    unregisterBeforeUnloadCleanup = registerBeforeUnloadCleanup(() => {
      void leave().catch(noOp)
    })
  }

  const roomInstance: Room = {
    ready: roomReadyP,
    makeAction,
    makeState: ((namespace: string, initialValue?: unknown, config?: unknown) =>
      (ensureStateManager().makeState as (...args: unknown[]) => unknown)(
        namespace,
        initialValue,
        config
      )) as Room['makeState'],
    makeUserState: ((
      namespace: string,
      initialValue?: unknown,
      config?: unknown
    ) =>
      (ensureStateManager().makeUserState as (...args: unknown[]) => unknown)(
        namespace,
        initialValue,
        config
      )) as Room['makeUserState'],
    leave,

    ping: async target => {
      const start = Date.now()
      await pingAction.request('', {target})
      return Date.now() - start
    },

    getSelf: async (): Promise<SelfInfo> => {
      const [user, info] = await awaitSelfState()
      return {
        peerId: localSelfId,
        userId: user.userId,
        identityPersistence: user.persistence ?? 'none',
        roomId: info?.roomId ?? effectiveRoomId,
        baseRoomId: info?.baseRoomId ?? initialRoomId,
        isAdmin: info?.isAdmin ?? false,
        roles: info?.roles ?? []
      }
    },

    getPeers: () =>
      fromEntries(
        getPeerIds(false).map(id => {
          const directPeer = getDirectPeer(id, false)
          const direct = Boolean(directPeer)
          return [
            id,
            {
              userId: getPeerUserId(id),
              connection: directPeer ? directPeer.connection : null,
              direct,
              hops: direct ? 1 : (scaleProvider?.getRoute(id)?.hops ?? 2),
              roles: [...getPeerRoles(id)]
            }
          ]
        })
      ),

    getUsers: () => {
      if (cachedUsersSnapshot) {
        return cachedUsersSnapshot
      }
      const raw: Record<string, {peerIds: string[]; roles: string[]}> = {}
      for (const peerId of getPeerIds(false)) {
        const userId = getPeerUserId(peerId)
        if (userId === localUserId) {
          continue
        }
        ;(raw[userId] ??= {
          peerIds: [],
          roles: getPeerRoles(userId)
        }).peerIds.push(peerId)
      }
      const frozen: Record<string, UserInfo> = {}
      for (const [uid, info] of entries(raw)) {
        frozen[uid] = Object.freeze({
          peerIds: Object.freeze(info.peerIds) as unknown as string[],
          roles: Object.isFrozen(info.roles)
            ? info.roles
            : (Object.freeze([...info.roles]) as string[])
        })
      }
      cachedUsersSnapshot = Object.freeze(frozen)
      return cachedUsersSnapshot
    },

    addStream: (stream, options: AddMediaOptions = {}) =>
      mediaManager.addStream(stream, options, streamMetaAction.send),

    removeStream: (stream, options: RemoveMediaOptions = {}) => {
      mediaManager.removeStream(stream, options.target)
    },

    replaceTrack: (oldTrack, newTrack, options: ReplaceTrackOptions = {}) =>
      mediaManager.replaceTrack(oldTrack, newTrack, options.target),

    ...rolesApi,
    ...scaleApi,

    onPeerJoin: (handler, options) =>
      subPeerJoin(handler, options, () =>
        getPeerIds(false).map((peerId): [PeerJoinContext] => [
          {
            peerId,
            userId: getPeerUserId(peerId),
            roles: [...getPeerRoles(peerId)]
          }
        ])
      ),

    onPeerLeave: subPeerLeave,

    onUserJoin: (handler, options) =>
      subUserJoin(handler, options, () => {
        const items: [UserJoinContext][] = []
        const seenUsers = new Set<string>()
        for (const peerId of getPeerIds(false)) {
          const userId = getPeerUserId(peerId)
          if (userId !== localUserId && !seenUsers.has(userId)) {
            seenUsers.add(userId)
            items.push([
              {
                userId,
                peerId,
                roles: [...getPeerRoles(peerId)]
              }
            ])
          }
        }
        return items
      }),

    onUserLeave: subUserLeave,

    onPeerStream: mediaManager.onPeerStream,

    onError: subError
  }

  lockMethods(roomInstance as Record<string, unknown>, [
    'onPeerJoin',
    'onPeerLeave',
    'onUserJoin',
    'onUserLeave',
    'onPeerStream',
    'onError',
    ...(rolesApi ? ['onRoleChange'] : [])
  ])

  const bridge: RoomSignalingBridge = {
    localEndpointP,
    effectiveRoomIdP,
    hasSetupFailed: () => didReportSetupError,
    getScaleProvider: () => scaleProvider,
    setOnScaleTargetsChanged: cb => {
      scaleTargetsChangedCallback = cb
      scaleProvider?.setOnTargetsChanged(cb)
    },
    canConnectPeer,
    emitError: err => {
      if (!leavePromise) {
        emitError(err)
      }
    }
  }

  return [roomInstance as RoomWithPlugins<TPlugins>, bridge]
}

export default <
  const TPlugins extends readonly AnyRoomPlugin[] | undefined = undefined
>(
  onPeer: (f: (peer: PeerHandle, id: string) => void) => void,
  onPeerLeave: (id: string, shouldReannounce?: boolean) => void,
  onSelfLeave: () => void,
  roomOptions: RoomOptions & {use?: TPlugins} = {}
): RoomWithPlugins<TPlugins> =>
  createRoomWithBridge(onPeer, onPeerLeave, onSelfLeave, roomOptions)[0]
