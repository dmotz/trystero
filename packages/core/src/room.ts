import {createActionManager} from './actions'
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
  formatSelfCertifyingRoomId,
  fromEntries,
  isBrowser,
  isPosSafeInt,
  lockMethods,
  logErr,
  mkBannedErr,
  mkErr,
  mkViolationErr,
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
  unreachable,
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

type RoomLifecycleState =
  | {readonly phase: 'active'}
  | {readonly phase: 'setup-failed'}
  | {readonly phase: 'leaving'; readonly promise: Promise<void>}
  | {readonly phase: 'left'; readonly promise: Promise<void>}

type PeerTransportSession =
  | {
      readonly phase: 'virtual-only'
      readonly virtual: PeerDataTransport
    }
  | {
      readonly phase: 'direct-pending'
      readonly peer: PeerHandle
      readonly transport: PeerDataTransport
      readonly verified: boolean
    }
  | {
      readonly phase: 'virtual-upgrading'
      readonly virtual: PeerDataTransport
      readonly peer: PeerHandle
      readonly transport: PeerDataTransport
      readonly verified: boolean
    }
  | {
      readonly phase: 'direct-active'
      readonly peer: PeerHandle
      readonly transport: PeerDataTransport
    }

type PeerEntry = {
  session: PeerTransportSession
  userId?: string
  /** User ID last announced via onPeerJoin/onUserJoin for this peer; may lag userId before promotion. */
  emittedUserId?: string
  deferredReady?: HandshakeReadyPayload
}

const isRoomLeavingOrLeft = (
  state: RoomLifecycleState
): state is Extract<RoomLifecycleState, {phase: 'leaving' | 'left'}> =>
  state.phase === 'leaving' || state.phase === 'left'

const isPendingDirectSession = (
  session: PeerTransportSession
): session is Extract<
  PeerTransportSession,
  {phase: 'direct-pending' | 'virtual-upgrading'}
> => session.phase === 'direct-pending' || session.phase === 'virtual-upgrading'

const hasVirtualSession = (
  session: PeerTransportSession
): session is Extract<
  PeerTransportSession,
  {phase: 'virtual-only' | 'virtual-upgrading'}
> => session.phase === 'virtual-only' || session.phase === 'virtual-upgrading'

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

  const syncEndpoint =
    endpointIdentity && !isPromiseLike(endpointIdentity)
      ? endpointIdentity
      : undefined

  const effectiveClientId =
    clientId ?? (syncEndpoint ? syncEndpoint.peerId : createIdentityClientId())

  let localSelfId = syncEndpoint ? syncEndpoint.peerId : ''
  let localUserId = ''
  let roomLifecycle: RoomLifecycleState = {phase: 'active'}
  let didReportSetupError = false
  let effectiveRoomId = initialRoomId
  let rolesProvider: KernelRolesProvider | null = null
  let scaleProvider: KernelScaleProvider | null = null
  let cachedUsersSnapshot: Readonly<Record<string, UserInfo>> | null = null

  const getLocalSelfId = (): string => localSelfId

  const getLocalUserId = (): string => localUserId

  const isLeavingOrLeft = (): boolean => isRoomLeavingOrLeft(roomLifecycle)

  const canAcceptPeers = (): boolean => roomLifecycle.phase === 'active'

  const invalidateUsersSnapshot = (): void => {
    cachedUsersSnapshot = null
  }

  const pendingFlushDestroys = new Set<() => void>()
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
    if (!isLeavingOrLeft()) {
      emitError({
        ...error,
        appId,
        roomId: effectiveRoomId
      } as RoomError)
    }
  }

  const failSetup = (error: KernelRoomErrorInput): void => {
    if (didReportSetupError || roomLifecycle.phase !== 'active') {
      return
    }
    didReportSetupError = true
    roomLifecycle = {phase: 'setup-failed'}
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

  const peerEntries = new Map<string, PeerEntry>()

  const resolvedUserIdentityP = resolveUserIdentity(
    appId,
    initialRoomId,
    identity === undefined ? undefined : {identity},
    effectiveClientId
  ).then(
    resolvedId => {
      localUserId = resolvedId.userId
      if (!isLeavingOrLeft()) {
        stateMgr?.setUserPresence(localUserId, true)
      }
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
          if (!isLeavingOrLeft()) {
            setEffectiveRoomId(rid)
          }
          return rid
        })
      : undefined
  void effectiveRoomIdP?.catch(noOp)

  const isActiveEntry = (entry: PeerEntry | undefined): boolean =>
    Boolean(entry && entry.session.phase !== 'direct-pending')

  const hasSessionEntry = (
    entry: PeerEntry | undefined,
    includePending: boolean
  ): boolean => (includePending ? Boolean(entry) : isActiveEntry(entry))

  const isEntryVerified = (entry: PeerEntry): boolean =>
    entry.session.phase === 'direct-active' ||
    (isPendingDirectSession(entry.session) && entry.session.verified)

  const getPeerUserId = (id: string): string => {
    const selfId = getLocalSelfId()
    return selfId && id === selfId
      ? getLocalUserId()
      : (peerEntries.get(id)?.userId ?? scaleProvider?.getPeerUserId(id) ?? id)
  }

  const getKnownPeerUserId = (id: string): string | undefined => {
    const selfId = getLocalSelfId()
    return selfId && id === selfId
      ? getLocalUserId() || undefined
      : (peerEntries.get(id)?.userId ?? scaleProvider?.getPeerUserId(id))
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

  const reconcileUserChangeOnActiveEntry = (
    peerId: string,
    entry: PeerEntry,
    nextUid: string
  ): void => {
    const prevEmitted = entry.emittedUserId
    if (!prevEmitted || prevEmitted === nextUid) {
      entry.emittedUserId = nextUid
      if (!prevEmitted && !isLeavingOrLeft()) {
        stateMgr?.setUserPresence(nextUid, true)
      }
      return
    }
    const localUid = getLocalUserId()
    const wasLastForPrev = countActivePeersForUser(prevEmitted, peerId) === 0
    const isFirstForNext = countActivePeersForUser(nextUid, peerId) === 0
    entry.emittedUserId = nextUid
    if (!isLeavingOrLeft()) {
      if (wasLastForPrev && (!localUid || prevEmitted !== localUid)) {
        emitUserLeave({userId: prevEmitted, peerId})
        stateMgr?.setUserPresence(prevEmitted, false)
        stateMgr?.onUserLeft(prevEmitted)
      }
      if (isFirstForNext && (!localUid || nextUid !== localUid)) {
        stateMgr?.setUserPresence(nextUid, true)
        stateMgr?.onPeerJoined(peerId, nextUid, isDirectPeer(peerId))
        emitUserJoin({
          userId: nextUid,
          peerId,
          roles: getPeerRoles(peerId)
        })
      }
    }
  }

  const setPeerUserId = (id: string, uid: string): void => {
    if (!uid) {
      return
    }
    const entry = peerEntries.get(id)
    if (!entry || isEntryVerified(entry)) {
      return
    }
    if (entry.userId !== uid) {
      entry.userId = uid
      invalidateUsersSnapshot()
      if (isActiveEntry(entry)) {
        reconcileUserChangeOnActiveEntry(id, entry, uid)
      }
    }
  }

  const isDirectPeer = (id: string): boolean =>
    peerEntries.get(id)?.session.phase === 'direct-active'

  const isPeerActive = (id: string): boolean =>
    isActiveEntry(peerEntries.get(id))

  const hasAnyPeer = (id: string): boolean => peerEntries.has(id)

  const getDirectPeer = (
    id: string,
    includePending = false
  ): PeerHandle | undefined => {
    const session = peerEntries.get(id)?.session
    if (!session || session.phase === 'virtual-only') {
      return undefined
    }
    if (session.phase === 'direct-active') {
      return session.peer
    }
    return includePending ? session.peer : undefined
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
    for (const id of peerEntries.keys()) {
      const peer = getDirectPeer(id, !activeOnly)
      if (peer) {
        list.push([id, peer])
      }
    }
    return list
  }

  const getDirectPeerIds = (activeOnly = true): string[] =>
    getDirectPeerEntries(activeOnly).map(pair => pair[0])

  const resetDirectSessionOnEntry = (id: string, entry: PeerEntry): void => {
    delete entry.deferredReady
    switch (entry.session.phase) {
      case 'virtual-upgrading': {
        entry.session = {
          phase: 'virtual-only',
          virtual: entry.session.virtual
        }
        invalidateUsersSnapshot()
        return
      }
      case 'direct-pending':
      case 'direct-active': {
        peerEntries.delete(id)
        invalidateUsersSnapshot()
        return
      }
      case 'virtual-only':
        return
      default:
        unreachable(entry.session)
    }
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
    Boolean(id && rolesProvider?.isPeerBanned(id))

  const getPeerRoles = (id = getLocalSelfId()): string[] =>
    rolesProvider?.getPeerRoles(id) ?? frozenEmptyRoles

  let stateMgr: StateManager | null = null

  const emitActivatedEvents = (
    peerId: string,
    uid: string,
    isFirstForUser: boolean
  ): void => {
    if (isLeavingOrLeft()) {
      return
    }
    const localUid = getLocalUserId()
    if (isFirstForUser && (!localUid || uid !== localUid)) {
      stateMgr?.setUserPresence(uid, true)
    }
    stateMgr?.onPeerJoined(peerId, uid, isDirectPeer(peerId))
    const roles = getPeerRoles(peerId)
    emitPeerJoin({peerId, userId: uid, roles})
    if (isFirstForUser && (!localUid || uid !== localUid)) {
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
    const localUid = getLocalUserId()
    stateMgr?.onPeerDisconnected(peerId)
    emitPeerDeactivated(peerId)
    if (!isLeavingOrLeft()) {
      emitPeerLeave({peerId, userId: uid})
      if (isLastForUser && (!localUid || uid !== localUid)) {
        emitUserLeave({userId: uid, peerId})
        stateMgr?.setUserPresence(uid, false)
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
    const finishNow = (): void => {
      cancel()
    }
    const cancel = destroyAfterFlush(peer, 40, 150, () => {
      completed = true
      pendingFlushDestroys.delete(finishNow)
    })
    if (!completed) {
      pendingFlushDestroys.add(finishNow)
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

  const getEntryTransport = (
    id: string,
    includePending?: boolean
  ): PeerDataTransport | undefined => {
    const session = peerEntries.get(id)?.session
    if (!session) {
      return undefined
    }
    switch (session.phase) {
      case 'direct-active':
        return session.transport
      case 'direct-pending':
        return includePending ? session.transport : undefined
      case 'virtual-upgrading':
        return includePending ? session.transport : session.virtual
      case 'virtual-only':
        return session.virtual
      default:
        return unreachable(session)
    }
  }

  const actionManager = createActionManager({
    getPeerIds,
    canReceiveFromPeer: (id, receiveWhilePending) =>
      !isPeerBanned(id) &&
      (isPeerActive(id) || hs.canReceiveFromPeer(id, receiveWhilePending)),
    onPeerError,
    getTransport: getEntryTransport,
    broadcastInline: (frame, onProgress, signal) =>
      scaleProvider
        ? scaleProvider.broadcastInline(frame, onProgress, signal)
        : false,
    registerActionAuthority: (namespace, roles) => {
      if (!rolesProvider) {
        throw requiresRolesErr('action role gating')
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
    onUnknownType: type => {
      if (type === '@_state' && !isLeavingOrLeft()) {
        ensureStateManager()
      }
    },
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
    await roomReadyP
    return [
      await resolvedUserIdentityP,
      await rolesProvider?.getAuthorityInfo()
    ] as const
  }

  const [hitStatePenalty, resetStatePenalty] = createWindowCounter(512, 8)

  const ensureStateManager = (): StateManager => {
    if (!stateMgr) {
      const created = createStateManager({
        appId,
        getRoomId: () => effectiveRoomId,
        getSelfId: getLocalSelfId,
        getLocalUserId,
        ensureReady: async () => {
          const [user, info] = await awaitSelfState()
          return {
            selfId: getLocalSelfId(),
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
        isUserOnline: uid => {
          const localUid = getLocalUserId()
          return Boolean(
            (localUid && uid === localUid) || countActivePeersForUser(uid) > 0
          )
        },
        getKnownPeerUserId,
        isPeerBanned: peerOrUserId =>
          Boolean(peerOrUserId && isPeerBanned(peerOrUserId)),
        getPeerRoles: peerOrUserId => getPeerRoles(peerOrUserId),
        makeInternalAction,
        onInvalidRecord: fromPeerId => {
          const selfId = getLocalSelfId()
          if (!fromPeerId || fromPeerId === selfId) {
            return
          }
          if (hitStatePenalty(fromPeerId)) {
            resetStatePenalty(fromPeerId)
            onPeerError(
              fromPeerId,
              mkViolationErr('excessive invalid state records')
            )
          }
        }
      })
      if (isLeavingOrLeft()) {
        created.destroy()
      } else {
        if (localUserId) {
          created.setUserPresence(localUserId, true)
        }
        for (const [pid, entry] of peerEntries) {
          if (isActiveEntry(entry)) {
            created.setUserPresence(getPeerUserId(pid), true)
          }
        }
      }
      stateMgr = created
    }
    return stateMgr
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
    const uid =
      entry.emittedUserId ??
      entry.userId ??
      scaleProvider?.getPeerUserId(id) ??
      id
    const directPeer =
      entry.session.phase === 'virtual-only' ? undefined : entry.session.peer
    const virtualTransport = hasVirtualSession(entry.session)
      ? entry.session.virtual
      : null
    peerEntries.delete(id)
    virtualTransport?.close?.()
    const isLast = wasActive && countActivePeersForUser(uid, id) === 0
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
    const err =
      reason === undefined
        ? peerDisconnectedErr
        : toError(reason, peerDisconnectedMsg)
    const banned = err === peerBannedErr
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
      existingEntry?.session.phase === 'virtual-upgrading'
    ) {
      clearPendingPeer(id, err)
      stateMgr?.clearPeer(id)
      resetDirectSessionOnEntry(id, existingEntry)
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
      if ((banned || reason === roomFullErr) && !isLeavingOrLeft()) {
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

  const leave = (): Promise<void> => {
    if (isRoomLeavingOrLeft(roomLifecycle)) {
      return roomLifecycle.promise
    }
    const {promise, resolve, reject} = Promise.withResolvers<void>()
    roomLifecycle = {phase: 'leaving', promise}
    ;(async () => {
      onBeforeLeave?.()
      reservedAdmissionUsers.clear()
      for (const id of getPeerIds(true)) {
        hs.clearPeer(id, roomLeftErr)
      }
      emitLeave()
      const leaveTargets = scaleProvider
        ? getDirectPeerIds(false).filter(id => {
            const session = peerEntries.get(id)?.session
            return (
              session &&
              session.phase !== 'virtual-only' &&
              session.transport.isOpen
            )
          })
        : undefined
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
      }
      if (scaleProvider) {
        await scaleProvider.announceLeave()
      }
      if (hasOpenPeers) {
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
        for (const id of allPeerIds) {
          const cur = peerEntries.get(id)
          if (!cur) {
            continue
          }
          const direct =
            cur.session.phase === 'virtual-only' ? null : cur.session.peer
          const virtual = hasVirtualSession(cur.session)
            ? cur.session.virtual
            : null
          peerEntries.delete(id)
          direct?.destroy()
          virtual?.close?.()
        }
        peerEntries.clear()
        invalidateUsersSnapshot()
        for (const id of allPeerIds) {
          clearSubsystems(id, roomLeftErr)
        }
      } finally {
        roomLifecycle = {phase: 'left', promise}
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
    })().then(resolve, reject)
    return promise
  }

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
    const users = new Set<string>([getLocalUserId()])
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
      !isPeerBanned(getLocalSelfId()) &&
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
          if (!isLeavingOrLeft() && hs.getPeer(id)) {
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
    if (!entry || !isPendingDirectSession(entry.session)) {
      return
    }
    entry.userId = verified.userId
    invalidateUsersSnapshot()
    if (isPeerBanned(peerId) || isPeerBanned(verified.userId)) {
      scaleProvider?.markPeerBanned(peerId)
      throw peerBannedErr
    }
    const deferredReady = entry.deferredReady
    delete entry.deferredReady
    entry.session = {...entry.session, verified: true}
    scaleProvider?.setPeerSignPublicKey(peerId, verified.peerPubKey)
    if (deferredReady !== undefined) {
      queueMicrotask(() => {
        const cur = peerEntries.get(peerId)
        if (
          cur &&
          isEntryVerified(cur) &&
          (!peer || getDirectPeer(peerId, true) === peer)
        ) {
          deliverHandshakeReady(deferredReady, peerId)
        }
      })
    }
  }

  const internalKernel: InternalRoomContext = {
    get selfId() {
      return getLocalSelfId()
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
    kickPeer: (peerId, reason) => kickPeer(peerId, undefined, reason),
    emitError: emitRoomError,
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
      if (
        !canAcceptPeers() ||
        isPeerBanned(peerId) ||
        isFullForPeer(peerId, true)
      ) {
        transport.close?.()
        return false
      }
      if (isDirectPeer(peerId)) {
        transport.close?.()
        return true
      }
      const existing = peerEntries.get(peerId)
      const wasActive = isActiveEntry(existing)
      const uid =
        existing?.userId ?? scaleProvider?.getPeerUserId(peerId) ?? peerId
      const isFirst = !wasActive && countActivePeersForUser(uid, peerId) === 0

      if (!existing) {
        peerEntries.set(peerId, {
          session: {phase: 'virtual-only', virtual: transport},
          userId: uid,
          emittedUserId: uid
        })
      } else {
        existing.userId = uid
        switch (existing.session.phase) {
          case 'virtual-only': {
            if (existing.session.virtual !== transport) {
              existing.session.virtual.close?.()
            }
            existing.session = {phase: 'virtual-only', virtual: transport}
            break
          }
          case 'virtual-upgrading': {
            if (existing.session.virtual !== transport) {
              existing.session.virtual.close?.()
            }
            existing.session = {
              ...existing.session,
              virtual: transport
            }
            break
          }
          case 'direct-pending': {
            existing.session = {
              phase: 'virtual-upgrading',
              virtual: transport,
              peer: existing.session.peer,
              transport: existing.session.transport,
              verified: existing.session.verified
            }
            existing.emittedUserId = uid
            break
          }
          case 'direct-active':
            break
          default:
            unreachable(existing.session)
        }
      }

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
      if (!entry || !hasVirtualSession(entry.session)) {
        return
      }
      const err = toError(reason, peerDisconnectedMsg)
      const uid =
        entry.emittedUserId ??
        entry.userId ??
        scaleProvider?.getPeerUserId(peerId) ??
        peerId
      const vt = entry.session.virtual
      if (entry.session.phase === 'virtual-upgrading') {
        entry.session = {
          phase: 'direct-pending',
          peer: entry.session.peer,
          transport: entry.session.transport,
          verified: entry.session.verified
        }
        delete entry.emittedUserId
      } else {
        peerEntries.delete(peerId)
      }
      vt.close?.()
      const isLast = countActivePeersForUser(uid, peerId) === 0
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
      if (getDirectPeer(id, true) !== peer || isLeavingOrLeft()) {
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
      if (
        !entry ||
        !isPendingDirectSession(entry.session) ||
        entry.session.peer !== peer
      ) {
        return
      }
      const wasActive = entry.session.phase === 'virtual-upgrading'
      const prevVirtual =
        entry.session.phase === 'virtual-upgrading'
          ? entry.session.virtual
          : null
      const uid = entry.userId ?? id
      entry.userId = uid
      delete entry.deferredReady
      const isFirst = !wasActive && countActivePeersForUser(uid, id) === 0
      entry.session = {
        phase: 'direct-active',
        peer,
        transport: entry.session.transport
      }
      prevVirtual?.close?.()
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
        entry.emittedUserId = uid
        emitActivatedEvents(id, uid, isFirst)
      } else {
        reconcileUserChangeOnActiveEntry(id, entry, uid)
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

  let rolesApi: RolesPluginApi | undefined
  let scaleApi: ScalePluginApi | undefined
  let pluginSetupFailure: {error: unknown} | null = null

  if (rolesSlot) {
    try {
      const res = rolesSlot.setup(internalKernel, effectiveRoomIdP)
      rolesProvider = res.provider
      rolesApi = res.api
    } catch (err) {
      pluginSetupFailure = {error: err}
      failSetup({
        code: 'plugin-failed',
        plugin: 'roles',
        message: toErrorMessage(err, 'roles setup failed'),
        cause: err
      })
    }
  }

  if (scaleSlot && !pluginSetupFailure) {
    try {
      const res = scaleSlot.setup(internalKernel)
      scaleProvider = res.provider
      scaleApi = res.api
    } catch (err) {
      pluginSetupFailure = {error: err}
      failSetup({
        code: 'plugin-failed',
        plugin: 'scale',
        message: toErrorMessage(err, 'scale setup failed'),
        cause: err
      })
    }
  }

  const roomReadyP = pluginSetupFailure
    ? Promise.reject(pluginSetupFailure.error)
    : all([
        localEndpointP,
        resolvedUserIdentityP,
        ...(effectiveRoomIdP ? [effectiveRoomIdP] : [])
      ]).then(noOp)
  void roomReadyP.catch(noOp)

  if (scaleProvider && !pluginSetupFailure) {
    ensureStateManager()
  }

  const processHandshakeReady = (
    data: HandshakeReadyPayload,
    id: string
  ): void => {
    if (isLeavingOrLeft()) {
      return
    }
    if (data && typeof data === 'object' && data.ok === false) {
      if (!hs.getPeer(id) || isDirectPeer(id)) {
        return
      }
      if (data.err === roomFullMsg) {
        hs.clearPeer(id, roomFullErr)
        emitRoomError({
          code: 'room-full',
          peerId: id,
          message: roomFullMsg
        })
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
    if (!isLeavingOrLeft()) {
      hs.receiveData(data, id, metadata)
    }
  })

  handshakeReadyAction.onMessage((data, {peerId: id}) => {
    if (isLeavingOrLeft()) {
      return
    }
    const entry = peerEntries.get(id)
    if (!entry || !isEntryVerified(entry)) {
      if (
        entry &&
        isPendingDirectSession(entry.session) &&
        !entry.session.verified &&
        hs.getPeer(id)
      ) {
        entry.deferredReady = data
      }
      return
    }
    deliverHandshakeReady(data, id)
  })

  onPeer((peer, id) => {
    if (!canAcceptPeers()) {
      peer.destroy()
      return
    }
    if (!canConnectPeer(id)) {
      peer.destroy()
      return
    }
    const existing = peerEntries.get(id)
    if (existing) {
      switch (existing.session.phase) {
        case 'virtual-only':
          stateMgr?.clearPeer(id)
          break
        case 'direct-pending':
        case 'virtual-upgrading': {
          const existingDirect = existing.session.peer
          if (existingDirect === peer) {
            return
          }
          const replacedErr = mkErr('peer replaced')
          existingDirect.destroy()
          clearPendingPeer(id, replacedErr)
          stateMgr?.clearPeer(id)
          const ex = peerEntries.get(id)
          if (ex && getDirectPeer(id, true) === existingDirect) {
            resetDirectSessionOnEntry(id, ex)
          }
          break
        }
        case 'direct-active': {
          const existingDirect = existing.session.peer
          if (existingDirect === peer) {
            return
          }
          const replacedErr = mkErr('peer replaced')
          existingDirect.destroy()
          clearPendingPeer(id, replacedErr)
          const [wasActive, isLast, uid] = removePeerEntry(id)
          clearSubsystems(id, replacedErr)
          emitDeactivatedEvents(id, wasActive, isLast, uid)
          scaleProvider?.removeDirectPeer(id, existingDirect, replacedErr)
          break
        }
        default:
          unreachable(existing.session)
      }
    }

    const transport = createDirectPeerTransport(peer, () => {
      const curSession = peerEntries.get(id)?.session
      return Boolean(
        curSession &&
        curSession.phase !== 'virtual-only' &&
        curSession.transport === transport
      )
    })

    const existingEntry = peerEntries.get(id)
    if (existingEntry?.session.phase === 'virtual-only') {
      delete existingEntry.deferredReady
      existingEntry.session = {
        phase: 'virtual-upgrading',
        virtual: existingEntry.session.virtual,
        peer,
        transport,
        verified: false
      }
    } else {
      peerEntries.set(id, {
        session: {
          phase: 'direct-pending',
          peer,
          transport,
          verified: false
        }
      })
    }

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
        peerId: getLocalSelfId(),
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
      const localUid = getLocalUserId()
      const raw: Record<string, {peerIds: string[]; roles: string[]}> = {}
      for (const peerId of getPeerIds(false)) {
        const userId = getPeerUserId(peerId)
        if (localUid && userId === localUid) {
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
        const localUid = getLocalUserId()
        const items: [UserJoinContext][] = []
        const seenUsers = new Set<string>()
        for (const peerId of getPeerIds(false)) {
          const userId = getPeerUserId(peerId)
          if ((!localUid || userId !== localUid) && !seenUsers.has(userId)) {
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
      scaleProvider?.setOnTargetsChanged(cb)
    },
    canConnectPeer,
    emitError: err => {
      if (!isLeavingOrLeft()) {
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
