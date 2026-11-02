import {initActionManager} from './actions'
import {
  createHandshakeManager,
  initIdentityHandshake,
  type HandshakeReadyPayload,
  type VerifiedPeerIdentity
} from './handshake'
import {
  type EndpointIdentity,
  getDefaultEndpointIdentity,
  isEphemeralIdentityConfig,
  resolveUserIdentity
} from './identity'
import type {
  InternalRoomContext,
  KernelRolesProvider,
  KernelScaleProvider
} from './internal-types'
import {initMediaManager, type InternalMediaMeta} from './media'
import {
  createDirectPeerTransport,
  type PeerDataTransport
} from './peer-registry'
import {internalPluginSymbol, signalingBridgeSymbol} from './primitives'
import {initStateManager, jwkToCompactPub} from './state'
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
  all,
  cmpStr,
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
  mkBannedErr,
  mkErr,
  noOp,
  peerBannedErr,
  peerBannedMsg,
  peerDisconnectedErr,
  peerDisconnectedMsg,
  peerLeftRoomErr,
  requiresRolesErr,
  reservedRoomPropertyNames,
  resetTimer,
  roomFullErr,
  roomFullMsg,
  roomLeftErr,
  selfCertifyingRoomRegex,
  selfCertRoomRolesErr,
  toError,
  toErrorMessage,
  unrefTimer,
  warnEphemeralAdmin,
  warnNoPeer
} from './utils'

const defaultHandshakeTimeoutMs = 10_000
const unloadEvent = 'beforeunload'
const beforeUnloadRoomCleanups = /*@__PURE__*/ new Set<() => void>()

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

type InternalPluginMeta = {
  kind: 'roles' | 'scale' | 'internal'
  selfAsAdmin?: boolean
  setup: (
    kernel: InternalRoomContext,
    getPre?: () => unknown
  ) => Record<string, unknown> | void
}

const getInternalPluginMeta = (
  plugin: RoomPlugin<string, any>
): InternalPluginMeta | undefined =>
  (
    plugin as RoomPlugin<string, any> & {
      [internalPluginSymbol]?: InternalPluginMeta
    }
  )[internalPluginSymbol]

const isBanError = (err?: Error | string): boolean =>
  Boolean(
    err && (typeof err === 'string' ? err : err.message).includes(peerBannedMsg)
  )

export const validateAndPreparePlugins = (
  use: readonly RoomPlugin<string, any>[] | undefined,
  initialRoomId: string,
  identity: UserIdentityConfig | undefined,
  skipEphemeralWarn = false
): readonly [plugins: RoomPlugin<string, any>[], hasRolesPlugin: boolean] => {
  const plugins = getConfiguredPlugins(use)
  const hasRolesPlugin = plugins.some(
    p => getInternalPluginMeta(p)?.kind === 'roles' || p.name === 'roles'
  )
  if (!hasRolesPlugin && selfCertifyingRoomRegex.test(initialRoomId)) {
    throw selfCertRoomRolesErr
  }
  if (
    !skipEphemeralWarn &&
    plugins.some(
      p =>
        Boolean(getInternalPluginMeta(p)?.selfAsAdmin) || isSelfAsAdminPlugin(p)
    ) &&
    isEphemeralIdentityConfig(identity)
  ) {
    warnEphemeralAdmin()
  }
  return [plugins, hasRolesPlugin]
}

export const bootstrapIdentityAndPlugins = (
  appId: string,
  initialRoomId: string,
  identityConfig: {identity?: UserIdentityConfig} | undefined,
  clientOrSelfId: string | undefined,
  existingUserIdentityP: Promise<UserIdentity> | undefined,
  use: readonly RoomPlugin<string, any>[] | undefined,
  skipResolvePlugins: boolean,
  emitError: (error: KernelRoomErrorInput) => void
): readonly [
  userIdentityP: Promise<UserIdentity>,
  preResolvedPlugins: Map<RoomPlugin, unknown> | undefined,
  effectiveRoomIdP: Promise<string> | undefined,
  didReportSetupError: () => boolean
] => {
  let didReportError = false
  const reportErr = (
    code: 'identity-failed' | 'plugin-failed',
    fallback: string,
    cause: unknown,
    plugin?: string
  ): void => {
    didReportError = true
    queueMicrotask(() =>
      emitError({
        code,
        ...(plugin ? {plugin} : {}),
        message: toErrorMessage(cause, fallback),
        cause
      })
    )
  }
  const userIdentityP =
    existingUserIdentityP ??
    resolveUserIdentity(
      appId,
      initialRoomId,
      identityConfig,
      clientOrSelfId
    ).catch(err => {
      reportErr('identity-failed', 'identity resolution failed', err)
      throw err
    })
  void userIdentityP.catch(noOp)

  if (skipResolvePlugins || !use?.length) {
    return [userIdentityP, undefined, undefined, () => didReportError]
  }

  const preResolvedPlugins = new Map<RoomPlugin, unknown>()
  let chain: Promise<string> | undefined
  for (const plugin of use) {
    const resolveFn = plugin.resolveRoomId
    if (!resolveFn) {
      continue
    }
    const prevP = chain
    chain = (async (): Promise<string> => {
      const currentRoomId = prevP ? await prevP : initialRoomId
      const res = await resolveFn({
        appId,
        roomId: currentRoomId,
        userIdentityP
      })
      if (!res) {
        return currentRoomId
      }
      preResolvedPlugins.set(plugin, res.state)
      return res.effectiveRoomId
    })().catch(err => {
      if (!didReportError && !existingUserIdentityP) {
        reportErr('plugin-failed', 'room resolution failed', err, plugin.name)
      }
      throw err
    })
  }
  void chain?.catch(noOp)
  return [userIdentityP, preResolvedPlugins, chain, () => didReportError]
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

type DirectSession = [
  peer: PeerHandle,
  transport: PeerDataTransport,
  active: boolean,
  rejectTimer: ReturnType<typeof setTimeout> | null
]

type PeerEntry = {
  d: DirectSession | null
  v: PeerDataTransport | null
  r: string | null // registered userId in activeUserPeers
  u?: string // userId
  k?: JsonWebKey // peerPubKey
  p?: string // userPubCompact
  f: boolean // identity verified
  q?: HandshakeReadyPayload // deferred ready payload
}

export const createRoomWithBridge = <
  const TPlugins extends readonly RoomPlugin<string, any>[] | undefined =
    undefined
>(
  onPeer: (f: (peer: PeerHandle, id: string) => void) => void,
  onPeerLeave: (id: string) => void,
  onSelfLeave: () => void,
  roomOptions: RoomOptions & {use?: TPlugins} = {}
): readonly [room: RoomWithPlugins<TPlugins>, bridge: RoomSignalingBridge] => {
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
  const [plugins, hasRolesPlugin] = validateAndPreparePlugins(
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
  let leavePromise: Promise<void> | null = null

  const emitRoomError = (error: KernelRoomErrorInput): void => {
    if (!leavePromise) {
      emitError({
        ...error,
        appId,
        roomId: effectiveRoomId
      } as RoomError)
    }
  }

  const setEffectiveRoomId = (rid: string): void => {
    if (rid && rid !== effectiveRoomId) {
      effectiveRoomId = rid
      emitRoomIdChanged(rid)
    }
  }

  let localUserId = ''
  const peerEntries = new Map<string, PeerEntry>()
  const activeUserPeers = new Map<string, Set<string>>()

  const [rawUserIdentityP, localPreResolvedPlugins, localEffectiveRoomIdP] =
    bootstrapIdentityAndPlugins(
      appId,
      initialRoomId,
      identity === undefined ? undefined : {identity},
      explicitSelfId,
      userIdentityP,
      roomOptions.use,
      Boolean(roomOptions.didResolvePluginRoomIds),
      emitRoomError
    )
  const resolvedUserIdentityP = rawUserIdentityP.then(resolvedId => {
    localUserId = resolvedId.userId
    return resolvedId
  })
  void resolvedUserIdentityP.catch(noOp)

  const preResolvedPlugins =
    roomOptions.preResolvedPlugins ?? localPreResolvedPlugins
  const effectiveRoomIdP = roomOptions.effectiveRoomIdP ?? localEffectiveRoomIdP

  if (effectiveRoomIdP) {
    void effectiveRoomIdP.then(rid => {
      if (!leavePromise) {
        setEffectiveRoomId(rid)
      }
    }, noOp)
  }

  // --- Unified single-Map peer table helpers ---
  const ensureEntry = (id: string): PeerEntry => {
    let e = peerEntries.get(id)
    if (!e) {
      e = {d: null, v: null, r: null, f: false}
      peerEntries.set(id, e)
    }
    return e
  }

  const pruneIfEmpty = (id: string, e: PeerEntry): void => {
    if (!e.d && !e.v && !e.u && !e.k && !e.f && e.q === undefined) {
      peerEntries.delete(id)
    }
  }

  const isActiveEntry = (e: PeerEntry | undefined): boolean =>
    Boolean(e && (e.d?.[2] || e.v))

  const hasSessionEntry = (
    e: PeerEntry | undefined,
    includePending: boolean
  ) => (includePending ? Boolean(e && (e.d || e.v)) : isActiveEntry(e))

  const clearDirectRejectTimer = (
    s: DirectSession | null | undefined
  ): void => {
    if (s?.[3]) {
      s[3] = resetTimer(s[3])
    }
  }

  const addPeerToUserSet = (id: string, e: PeerEntry): [string, boolean] => {
    const uid = e.u ?? id
    e.u = uid
    if (e.r && e.r !== uid) {
      const prev = activeUserPeers.get(e.r)
      if (prev) {
        prev.delete(id)
        if (!prev.size) {
          activeUserPeers.delete(e.r)
        }
      }
    }
    let set = activeUserPeers.get(uid)
    const isFirst = !set || !set.size
    if (!set) {
      set = new Set()
      activeUserPeers.set(uid, set)
    }
    set.add(id)
    e.r = uid
    return [uid, isFirst]
  }

  const removePeerFromUserSet = (
    id: string,
    e: PeerEntry
  ): [string, boolean] => {
    const uid = e.r ?? e.u ?? id
    let isLast = false
    if (e.r) {
      const set = activeUserPeers.get(e.r)
      if (set) {
        set.delete(id)
        if (!set.size) {
          activeUserPeers.delete(e.r)
          isLast = true
        }
      }
      e.r = null
    }
    return [uid, isLast]
  }

  const getPeerUserId = (id: string): string =>
    id === localSelfId ? localUserId : (peerEntries.get(id)?.u ?? id)
  const getKnownPeerUserId = (id: string): string | undefined =>
    id === localSelfId ? localUserId : peerEntries.get(id)?.u
  const setPeerUserId = (id: string, uid: string): void => {
    if (!uid) {
      return
    }
    const e = ensureEntry(id)
    e.u = uid
    if (isActiveEntry(e) && e.r !== uid) {
      addPeerToUserSet(id, e)
    }
  }

  const isDirectPeer = (id: string): boolean =>
    Boolean(peerEntries.get(id)?.d?.[2])
  const isPeerActive = (id: string): boolean =>
    isActiveEntry(peerEntries.get(id))
  const hasAnyPeer = (id: string): boolean =>
    hasSessionEntry(peerEntries.get(id), true)
  const getDirectPeer = (
    id: string,
    includePending = false
  ): PeerHandle | undefined => {
    const d = peerEntries.get(id)?.d
    return d && (includePending || d[2]) ? d[0] : undefined
  }
  const getPeerIds = (includePending = false): string[] => {
    const ids: string[] = []
    for (const [id, e] of peerEntries) {
      if (hasSessionEntry(e, includePending)) {
        ids.push(id)
      }
    }
    return ids
  }
  const getDirectPeerEntries = (activeOnly = true): [string, PeerHandle][] => {
    const list: [string, PeerHandle][] = []
    for (const [id, e] of peerEntries) {
      if (e.d && (!activeOnly || e.d[2])) {
        list.push([id, e.d[0]])
      }
    }
    return list
  }
  const getDirectPeerIds = (activeOnly = true): string[] =>
    getDirectPeerEntries(activeOnly).map(p => p[0])
  const clearVerifiedFields = (e: PeerEntry): void => {
    e.f = false
    delete e.p
    delete e.q
  }
  const resetDirectEntry = (id: string, e: PeerEntry): void => {
    clearDirectRejectTimer(e.d)
    e.d = null
    clearVerifiedFields(e)
    pruneIfEmpty(id, e)
  }
  const findPeersForUser = (uid: string, includePending: boolean): string[] => {
    const matching: string[] = []
    for (const [pid, e] of peerEntries) {
      if (hasSessionEntry(e, includePending) && getPeerUserId(pid) === uid) {
        matching.push(pid)
      }
    }
    return matching
  }
  const getUserPeerIds = (uid: string): string[] => {
    const set = activeUserPeers.get(uid)
    return set?.size ? [...set] : findPeersForUser(uid, true)
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
        const userPeers = activeUserPeers.get(id)
        const matched = userPeers?.size
          ? [...userPeers].filter(pid =>
              hasSessionEntry(peerEntries.get(pid), includePending)
            )
          : findPeersForUser(id, includePending)
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
    rolesProvider?.getPeerRoles(id) ?? []

  const emitActivatedEvents = (
    peerId: string,
    uid: string,
    isFirstForUser: boolean
  ): void => {
    onStatePeerJoined(peerId, uid, isDirectPeer(peerId))
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
    onStatePeerDisconnected(peerId)
    emitPeerDeactivated(peerId)
    emitPeerLeave({peerId, userId: uid})
    if (isLastForUser && uid !== localUserId) {
      emitUserLeave({userId: uid, peerId})
      onStateUserLeft(uid)
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

  const kickPeer = (id: string, peer?: PeerHandle, reason?: Error): void => {
    const cur = getDirectPeer(id, true)
    if (cur && (!peer || cur === peer || isBanError(reason))) {
      void leaveAction.send('', id).catch(noOp)
    }
    exitPeer(id, peer, reason)
  }

  const reportPeerError = (id: string, error: Error): void => {
    if (!isBanError(error)) {
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

  const [
    addMediaStream,
    removeMediaStream,
    replaceMediaTrack,
    receiveStreamMeta,
    receiveRemoteStream,
    clearMediaPeer,
    clearMediaListeners,
    onPeerStream
  ] = initMediaManager(
    iterate,
    isPeerActive,
    onPeerError,
    id => {
      const direct = getDirectPeer(id, false)
      return direct
        ? Promise.resolve(direct)
        : scaleProvider?.prepareMediaPeer
          ? scaleProvider.prepareMediaPeer(id)
          : Promise.reject(peerDisconnectedErr)
    },
    getPeerUserId
  )

  const ensureRolesProvider = async (): Promise<KernelRolesProvider | null> => {
    if (!rolesProvider && hasRolesPlugin) {
      await pluginSetupP
    }
    return rolesProvider
  }

  const withRoles = <T>(
    fn: (p: KernelRolesProvider) => Promise<T>,
    fb: () => T
  ): Promise<T> => ensureRolesProvider().then(p => (p ? fn(p) : fb()))

  const openVerifyResult = (wireMetadata?: unknown) => ({
    valid: true,
    ...(wireMetadata === undefined
      ? {}
      : {userMetadata: wireMetadata as never}),
    roles: [] as string[]
  })

  const [
    makeAction,
    makeActionInternal,
    handleData,
    clearActionPeer,
    clearActionListeners
  ] = initActionManager(
    getPeerIds,
    (id, receiveWhilePending) =>
      !isPeerBanned(id) &&
      (isPeerActive(id) || hsCanReceiveFromPeer(id, receiveWhilePending)),
    onPeerError,
    (id, includePending) => {
      const e = peerEntries.get(id)
      return e
        ? ((e.d && (includePending || e.d[2]) ? e.d[1] : undefined) ??
            e.v ??
            undefined)
        : undefined
    },
    (frame, onProgress) =>
      scaleProvider
        ? scaleProvider.broadcastInline(frame, onProgress)
        : Promise.resolve(false),
    (namespace, roles) => {
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
    (namespace, requiredRoles, data, userMetadata) =>
      withRoles(
        p => p.signActionPayload(namespace, requiredRoles, data, userMetadata),
        () => userMetadata ?? null
      ),
    (namespace, peerId, requiredRoles, wireMetadata) =>
      withRoles(
        p =>
          p.verifyActionOffer(namespace, peerId, requiredRoles, wireMetadata),
        () => openVerifyResult(wireMetadata)
      ),
    (namespace, peerId, requiredRoles, data, wireMetadata) =>
      withRoles(
        p =>
          p.verifyActionPayload(
            namespace,
            peerId,
            requiredRoles,
            data,
            wireMetadata
          ),
        () => openVerifyResult(wireMetadata)
      ),
    peerId => getPeerRoles(peerId),
    getPeerUserId,
    resolveSendTarget,
    resolveRequestTarget,
    () => {
      scaleProvider?.recordSignatureFailure()
    },
    maxReceiveBytes
  )

  const awaitSelfState = async () => {
    const [, u] = await all([localEndpointP, resolvedUserIdentityP, roomReadyP])
    if (pluginSetupError) {
      throw pluginSetupError
    }
    return [u, await rolesProvider?.getAuthorityInfo()] as const
  }

  const [hitStatePenalty, resetStatePenalty] = createWindowCounter(512, 8)

  const [
    makeState,
    makeUserState,
    prepareHandshakeReady,
    stageHandshakeUserState,
    onStatePeerJoined,
    onStatePeerDisconnected,
    onStateUserLeft,
    purgeBannedUserState,
    clearStatePeer,
    destroyStateManager
  ] = initStateManager(
    appId,
    () => effectiveRoomId,
    () => localSelfId,
    () => localUserId,
    async () => {
      const [u, info] = await awaitSelfState()
      return [localSelfId, u, info?.roomId ?? effectiveRoomId]
    },
    () => hasRolesPlugin,
    () => rolesProvider,
    () => scaleProvider,
    isPeerActive,
    peerId => Boolean(hsGetPeer(peerId) && !isDirectPeer(peerId)),
    isDirectPeer,
    () => getDirectPeerIds(true),
    uid =>
      Boolean(
        (localUserId && uid === localUserId) ||
        (activeUserPeers.get(uid)?.size ?? 0) > 0
      ),
    getKnownPeerUserId,
    peerOrUserId => Boolean(peerOrUserId && isPeerBanned(peerOrUserId)),
    peerOrUserId => getPeerRoles(peerOrUserId),
    makeActionInternal,
    fromPeerId => {
      scaleProvider?.recordSignatureFailure()
      if (!fromPeerId || fromPeerId === localSelfId) {
        return
      }
      if (hitStatePenalty(fromPeerId)) {
        resetStatePenalty(fromPeerId)
        onPeerError(fromPeerId, mkErr('excessive invalid state records'))
      }
    }
  )

  const removePeerEntry = (
    id: string
  ): [boolean, boolean, string, PeerHandle | undefined] => {
    const e = peerEntries.get(id)
    if (!e) {
      return [false, false, getPeerUserId(id), undefined]
    }
    const wasActive = isActiveEntry(e)
    const directPeer = e.d?.[0]
    const vt = e.v
    clearDirectRejectTimer(e.d)
    e.d = null
    e.v = null
    vt?.close?.()
    clearVerifiedFields(e)
    const [uid, isLast] = wasActive
      ? removePeerFromUserSet(id, e)
      : [getPeerUserId(id), false]
    pruneIfEmpty(id, e)
    return [wasActive, isLast, uid, directPeer]
  }

  const exitPeer = (id: string, peer?: PeerHandle, reason?: Error): void => {
    const err = toError(reason, peerDisconnectedMsg)
    const banned = isBanError(reason) || isBanError(err)
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
      Boolean(existingEntry?.v)
    ) {
      clearPendingPeer(id, err)
      clearStatePeer(id)
      if (
        existingEntry &&
        existingEntry.d?.[0] === currentDirect &&
        !existingEntry.d[2]
      ) {
        resetDirectEntry(id, existingEntry)
      }
      currentDirect.destroy()
      scaleProvider?.removeDirectPeer(id, currentDirect, err)
      onPeerLeave(id)
      return
    }

    if (banned) {
      scaleProvider?.markPeerBanned(id)
    }

    clearPendingPeer(id, err)
    clearSubsystems(id, err)
    const [wasActive, isLast, uid, directPeer] = removePeerEntry(id)

    if (directPeer) {
      if (banned && !leavePromise) {
        directPeer.setHandlers({
          data: noOp,
          stream: noOp,
          close: noOp,
          error: noOp
        })
        const timer = setTimeout(() => {
          deferredBanDestroyPeers.delete(directPeer)
          directPeer.destroy()
        }, 40)
        unrefTimer(timer)
        deferredBanDestroyPeers.set(directPeer, timer)
      } else {
        directPeer.destroy()
      }
      scaleProvider?.removeDirectPeer(id, directPeer, err)
      onPeerLeave(id)
    }

    emitDeactivatedEvents(id, wasActive, isLast, uid)
  }

  const leave = (): Promise<void> =>
    (leavePromise ??= (async () => {
      onBeforeLeave?.()
      reservedAdmissionUsers.clear()
      for (const [, waiterResolve] of admissionWaiters.values()) {
        waiterResolve(false)
      }
      admissionWaiters.clear()
      pendingRoomFullPeerId = null
      for (const id of getPeerIds(true)) {
        hsClearPeer(id, roomLeftErr)
      }
      emitLeave()
      scaleProvider?.announceLeave()
      const leaveTargets = scaleProvider ? getDirectPeerIds(false) : undefined
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
        for (const [peer, timer] of deferredBanDestroyPeers) {
          clearTimeout(timer)
          peer.destroy()
        }
        deferredBanDestroyPeers.clear()
        const allPeerIds = getPeerIds(true)
        for (const e of peerEntries.values()) {
          clearDirectRejectTimer(e.d)
          e.d?.[0].destroy()
          e.v?.close?.()
        }
        peerEntries.clear()
        activeUserPeers.clear()
        for (const id of allPeerIds) {
          clearSubsystems(id, roomLeftErr)
        }
      } finally {
        for (const fn of [
          ...cleanups,
          clearMediaListeners,
          clearActionListeners,
          destroyStateManager
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

  // --- Admission & handshake coordination ---
  const reservedAdmissionUsers = new Map<string, string>()
  const admissionWaiters = new Map<
    string,
    [peer: PeerHandle, resolve: (ok: boolean) => void]
  >()
  let didReportRoomFull = false
  let pendingRoomFullPeerId: string | null = null

  const clearSubsystems = (id: string, err: Error): void => {
    clearStatePeer(id)
    clearActionPeer(id, err)
    clearMediaPeer(id)
  }

  const getUsersSet = (
    includeReserved = false,
    excludePeerId?: string
  ): Set<string> => {
    const users = new Set<string>([localUserId])
    for (const [pid, e] of peerEntries) {
      if (isActiveEntry(e)) {
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
    if (limit === undefined || isPeerActive(id)) {
      return false
    }
    const users = getUsersSet(includeReserved, id)
    return !users.has(getPeerUserId(id)) && users.size >= limit
  }

  const canConnectPeer = (peerId: string): boolean =>
    !isPeerBanned(peerId) &&
    !(peerEntries.get(peerId)?.u !== undefined && isFullForPeer(peerId, true))

  const flushPendingRoomFullIfSettled = (): void => {
    if (!pendingRoomFullPeerId || didReportRoomFull || leavePromise) {
      return
    }
    if (getPeerIds(false).length > 0 && isFullForPeer(pendingRoomFullPeerId)) {
      pendingRoomFullPeerId = null
      return
    }
    if (hsHasNoPending()) {
      const rejectedBy = pendingRoomFullPeerId
      pendingRoomFullPeerId = null
      didReportRoomFull = true
      emitRoomError({
        code: 'room-full',
        peerId: rejectedBy,
        message: roomFullMsg
      })
    }
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
    }
    const banReason = isBan
      ? (rolesProvider?.getBanReason?.(getPeerUserId(id)) ??
        rolesProvider?.getBanReason?.(id))
      : undefined
    hsClearPeer(id, errObj)
    clearStatePeer(id)
    releaseAdmissionSlot(id)
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
          clearDirectRejectTimer(peerEntries.get(id)?.d)
          if (getDirectPeer(id, true) !== peer) {
            return
          }
          if (isBan) {
            kickPeer(id, peer, errObj)
          } else {
            exitPeer(id, peer, errObj)
          }
        }
        if (!verifyPeerIdentity || leavePromise) {
          closeNow()
          return
        }
        const direct = peerEntries.get(id)?.d
        if (direct) {
          clearDirectRejectTimer(direct)
          const timer = setTimeout(closeNow, 40)
          unrefTimer(timer)
          direct[3] = timer
        }
      })
  }

  const tryAdmitPeer = (id: string, peer: PeerHandle): boolean | null => {
    if (isPeerBanned(id)) {
      rejectPeer(id, peer, peerBannedMsg)
      return false
    }
    if (limit === undefined || isPeerActive(id)) {
      return true
    }
    if (isFullForPeer(id)) {
      rejectPeer(id, peer, roomFullMsg)
      return false
    }
    const uid = getPeerUserId(id)
    const allUsers = getUsersSet(true, id)
    if (allUsers.has(uid) || allUsers.size < limit) {
      reservedAdmissionUsers.set(id, uid)
      return true
    }
    return null
  }

  const drainAdmissionWaiters = (): void => {
    for (const [id, [waiterPeer, waiterResolve]] of admissionWaiters) {
      if (
        leavePromise ||
        hsGetPeer(id) !== waiterPeer ||
        getDirectPeer(id, true) !== waiterPeer
      ) {
        admissionWaiters.delete(id)
        waiterResolve(false)
        continue
      }
      const res = tryAdmitPeer(id, waiterPeer)
      if (res !== null) {
        admissionWaiters.delete(id)
        waiterResolve(res)
      }
    }
  }

  const releaseAdmissionSlot = (id: string): void => {
    const hadReserved = reservedAdmissionUsers.delete(id)
    const waiter = admissionWaiters.get(id)
    if (waiter) {
      admissionWaiters.delete(id)
      waiter[1](false)
    }
    if (hadReserved || admissionWaiters.size > 0) {
      drainAdmissionWaiters()
    }
    flushPendingRoomFullIfSettled()
  }

  const clearPendingPeer = (id: string, reason: Error): void => {
    hsClearPeer(id, reason)
    releaseAdmissionSlot(id)
  }

  const deliverHandshakeReady = (
    data: HandshakeReadyPayload,
    id: string
  ): void => {
    if (data && typeof data === 'object' && data.ok === true) {
      if (!isPeerBanned(id) && !isFullForPeer(id)) {
        void stageHandshakeUserState(id, data, () => {
          if (!leavePromise && hsGetPeer(id)) {
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
    verified: VerifiedPeerIdentity
  ): void => {
    setPeerUserId(peerId, verified.userId)
    if (isPeerBanned(peerId) || isPeerBanned(verified.userId)) {
      scaleProvider?.markPeerBanned(peerId)
      throw peerBannedErr
    }
    const e = ensureEntry(peerId)
    e.u = verified.userId
    e.k = verified.peerPubKey
    e.p = jwkToCompactPub(verified.userPubKey)
    e.f = true
    if (isActiveEntry(e) && e.r !== verified.userId) {
      addPeerToUserSet(peerId, e)
    }
    scaleProvider?.setPeerSignPublicKey(peerId, verified.peerPubKey)
    rolesProvider?.registerPeerPublicKey(peerId, verified.userPubKey)
    if (e.q !== undefined) {
      const readyPayload = e.q
      delete e.q
      queueMicrotask(() => {
        if (peerEntries.get(peerId)?.f) {
          deliverHandshakeReady(readyPayload, peerId)
        }
      })
    }
  }

  const getAdmissionPeerHandle = (peerId: string): PeerHandle | undefined =>
    hsGetPeer(peerId) ?? getDirectPeer(peerId, true)

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
    getPeerPublicKey: id => peerEntries.get(id)?.k,
    getActivePeerIds: () => getPeerIds(false),
    getAllPeerIds: () => getPeerIds(true),
    isPeerActive,
    getPeerHandle: getDirectPeer,
    resolveSendTarget,
    resolveRequestTarget,
    kickPeer: (peerId, reason) => kickPeer(peerId, undefined, reason),
    emitError: emitRoomError,
    makeAction,
    makeInternalAction: makeActionInternal,
    getRolesProvider: () => rolesProvider,
    getScaleProvider: () => scaleProvider,
    onPeerActivated: (cb, options) =>
      subPeerActivated(cb, options, () => getDirectPeerEntries(true)),
    onPeerDeactivated: subPeerDeactivated,
    onRoomIdChanged: subRoomIdChanged,
    onLeave: subLeave
  }

  const internalKernel = Object.assign(Object.create(publicKernel), {
    ...(effectiveRoomIdP === undefined ? {} : {effectiveRoomIdP}),
    setEffectiveRoomId,
    setPeerUserId,
    setPeerPublicKey: (peerId: string, pubKey: JsonWebKey) => {
      ensureEntry(peerId).k = pubKey
      scaleProvider?.setPeerSignPublicKey(peerId, pubKey)
    },
    getDirectActivePeerIds: () => getDirectPeerIds(true),
    deliverRawData: (originPeerId: string, data: ArrayBuffer) => {
      if (isPeerBanned(originPeerId)) {
        scaleProvider?.recordSignatureFailure()
        return
      }
      handleData(originPeerId, data)
    },
    registerRolesProvider: (provider: KernelRolesProvider) => {
      rolesProvider = provider
    },
    registerScaleProvider: (provider: KernelScaleProvider) => {
      scaleProvider = provider
      if (scaleTargetsChangedCallback) {
        provider.setOnTargetsChanged(scaleTargetsChangedCallback)
      }
      for (const [ns, roles] of pendingActionAuthorities) {
        provider.registerActionAuthority(ns, roles)
      }
      for (const [pid, e] of peerEntries) {
        if (e.k) {
          provider.setPeerSignPublicKey(pid, e.k)
        }
      }
      for (const [id, peer] of getDirectPeerEntries(true)) {
        provider.addDirectPeer(id, peer)
      }
    },
    activateVirtualPeer: (peerId: string, transport: PeerDataTransport) => {
      if (isPeerBanned(peerId) || isFullForPeer(peerId, true)) {
        transport.close?.()
        return false
      }
      if (isDirectPeer(peerId)) {
        transport.close?.()
        return true
      }
      const e = ensureEntry(peerId)
      const wasActive = isActiveEntry(e)
      e.v = transport
      if (!wasActive) {
        const [uid, isFirst] = addPeerToUserSet(peerId, e)
        emitActivatedEvents(peerId, uid, isFirst)
      }
      return true
    },
    deactivateVirtualPeer: (peerId: string, reason?: Error) => {
      if (isDirectPeer(peerId)) {
        return
      }
      const e = peerEntries.get(peerId)
      if (!e?.v) {
        return
      }
      const err = toError(reason, peerDisconnectedMsg)
      const vt = e.v
      e.v = null
      vt.close?.()
      const [uid, isLast] = removePeerFromUserSet(peerId, e)
      pruneIfEmpty(peerId, e)
      if (!hasAnyPeer(peerId)) {
        clearSubsystems(peerId, err)
      }
      emitDeactivatedEvents(peerId, true, isLast, uid)
    },
    purgeBannedUserState
  }) as InternalRoomContext

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
        const internalMeta = getInternalPluginMeta(plugin)
        const api = internalMeta
          ? internalMeta.setup(internalKernel, () =>
              preResolvedPlugins?.get(plugin)
            )
          : plugin.setup(publicKernel, preResolvedPlugins?.get(plugin))
        if (api && typeof api === 'object') {
          for (const key of keys(api)) {
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
    const preSetupP = effectiveRoomIdP
      ? all([localEndpointP, effectiveRoomIdP]).then(
          ([, rid]) => {
            if (!leavePromise) {
              setEffectiveRoomId(rid)
            }
          },
          err => {
            onSelfLeave()
            throw err
          }
        )
      : localEndpointP.then(noOp)
    pluginSetupP = preSetupP.then(() => {
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

  const roomReadyP =
    localSelfId && effectiveRoomIdP
      ? all([pluginSetupP, effectiveRoomIdP]).then(noOp)
      : pluginSetupP
  void roomReadyP.catch(noOp)

  const effectivePeerHandshake = runIdentityHandshake
    ? initIdentityHandshake(
        localEndpointP,
        appId,
        effectiveRoomIdP ?? initialRoomId,
        () => resolvedUserIdentityP,
        getAdmissionPeerHandle,
        onPeerIdentityVerified
      )[1](onPeerHandshake)
    : onPeerHandshake

  const [
    hsAddPeer,
    hsClearPeer,
    hsCanReceiveFromPeer,
    hsStart,
    hsReceiveData,
    hsReceiveReady,
    hsHasNoPending,
    hsGetPeer
  ] = createHandshakeManager(
    localSelfId,
    localSelfIdP,
    effectivePeerHandshake,
    (peerId, error, cause) => {
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
    },
    handshakeTimeoutMs,
    limit !== undefined,
    handshakeDataAction.send,
    handshakeReadyAction.send,
    (id, peer) => {
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
    (id, peer) => {
      if (getDirectPeer(id, true) !== peer || leavePromise) {
        return false
      }
      const res = tryAdmitPeer(id, peer)
      if (res !== null) {
        return res
      }
      return new Promise<boolean>(resolve => {
        const prev = admissionWaiters.get(id)
        if (prev) {
          admissionWaiters.delete(id)
          prev[1](false)
        }
        admissionWaiters.set(id, [peer, resolve])
      })
    },
    (id, peer) =>
      getDirectPeer(id, true) === peer && !isPeerBanned(id)
        ? prepareHandshakeReady(id)
        : undefined,
    (id, peer) => {
      if (isPeerBanned(id)) {
        releaseAdmissionSlot(id)
        kickPeer(id, peer, peerBannedErr)
        return
      }
      if (isFullForPeer(id)) {
        rejectPeer(id, peer, roomFullMsg)
        return
      }
      const e = peerEntries.get(id)
      reservedAdmissionUsers.delete(id)
      if (!e || e.d?.[0] !== peer) {
        drainAdmissionWaiters()
        flushPendingRoomFullIfSettled()
        return
      }
      const wasActive = isActiveEntry(e)
      e.d[2] = true
      e.v = null
      let uid = getPeerUserId(id)
      let isFirst = false
      if (!wasActive) {
        ;[uid, isFirst] = addPeerToUserSet(id, e)
      }
      scaleProvider?.addDirectPeer(id, peer)
      emitPeerActivated(id, peer)
      drainAdmissionWaiters()
      flushPendingRoomFullIfSettled()
      peer.setHandlers({
        signal: sdp => {
          if (getDirectPeer(id, false) === peer) {
            void signalAction
              .send(sdp as unknown as DataPayload, id)
              .catch(noOp)
          }
        }
      })
      if (!wasActive) {
        emitActivatedEvents(id, uid, isFirst)
      } else {
        onStatePeerJoined(id, uid, true)
      }
    },
    (id, peer, reason) => {
      releaseAdmissionSlot(id)
      if (isBanError(reason)) {
        rejectPeer(id, peer, peerBannedMsg)
        return
      }
      kickPeer(id, peer, reason)
    }
  )

  const processHandshakeReady = (
    data: HandshakeReadyPayload,
    id: string
  ): void => {
    if (leavePromise) {
      return
    }
    if (data && typeof data === 'object' && data.ok === false) {
      if (!hsGetPeer(id) || isDirectPeer(id)) {
        return
      }
      if (data.err === roomFullMsg) {
        hsClearPeer(id, roomFullErr)
        if (
          !didReportRoomFull &&
          !(getPeerIds(false).length > 0 && isFullForPeer(id))
        ) {
          pendingRoomFullPeerId ??= id
        }
        exitPeer(id, getDirectPeer(id, true), roomFullErr)
        releaseAdmissionSlot(id)
        return
      }
      if (data.err === peerBannedMsg) {
        const reason =
          typeof data.reason === 'string' && data.reason.length <= 512
            ? data.reason
            : undefined
        hsClearPeer(id, peerBannedErr)
        releaseAdmissionSlot(id)
        emitRoomError(mkBannedErr(reason, id))
        kickPeer(id, getDirectPeer(id, true), peerBannedErr)
        return
      }
    }
    hsReceiveReady(id)
  }

  signalAction.onMessage((sdp, id) => {
    void getDirectPeer(id, false)?.signal(sdp as never)
  })

  streamMetaAction.onMessage(receiveStreamMeta)

  leaveAction.onMessage((_, id) => exitPeer(id, undefined, peerLeftRoomErr))

  handshakeDataAction.onMessage((data, id, metadata) => {
    if (!leavePromise) {
      hsReceiveData(data, id, metadata)
    }
  })

  handshakeReadyAction.onMessage((data, id) => {
    if (leavePromise) {
      return
    }
    const e = peerEntries.get(id)
    if (verifyPeerIdentity && !e?.f) {
      if (hsGetPeer(id) && !isDirectPeer(id)) {
        ensureEntry(id).q = data
      }
      return
    }
    deliverHandshakeReady(data, id)
  })

  onPeer((peer, id) => {
    if (leavePromise) {
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
        scaleProvider?.removeDirectPeer(id, existingDirect, replacedErr)
        emitDeactivatedEvents(id, wasActive, isLast, uid)
      } else {
        clearStatePeer(id)
        const ex = peerEntries.get(id)
        if (ex && ex.d?.[0] === existingDirect) {
          resetDirectEntry(id, ex)
        }
      }
    } else {
      const ex = peerEntries.get(id)
      if (ex?.v) {
        clearStatePeer(id)
        clearVerifiedFields(ex)
      }
    }

    const entry = ensureEntry(id)
    clearDirectRejectTimer(entry.d)
    const session: DirectSession = [
      peer,
      createDirectPeerTransport(peer, () => peerEntries.get(id)?.d === session),
      false,
      null
    ]
    entry.d = session
    hsAddPeer(id, peer)

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
          receiveRemoteStream(id, stream)
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

    hsStart(id, peer)
  })

  if (isBrowser) {
    unregisterBeforeUnloadCleanup = registerBeforeUnloadCleanup(() =>
      leave().catch(noOp)
    )
  }

  const roomInstance: Room = {
    ready: roomReadyP,
    makeAction,
    makeState,
    makeUserState,
    leave,

    ping: async target => {
      const start = Date.now()
      await pingAction.request('', {target})
      return Date.now() - start
    },

    getSelf: async (): Promise<SelfInfo> => {
      const [u, info] = await awaitSelfState()
      return {
        peerId: localSelfId,
        userId: u.userId,
        persisted: u.persisted ?? false,
        identityPersistence: u.persistence ?? 'none',
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
              roles: getPeerRoles(id)
            }
          ]
        })
      ),

    getUsers: () => {
      const result: Record<string, UserInfo> = {}
      for (const peerId of getPeerIds(false)) {
        const userId = getPeerUserId(peerId)
        if (userId === localUserId) {
          continue
        }
        ;(result[userId] ??= {
          peerIds: [],
          roles: getPeerRoles(userId)
        }).peerIds.push(peerId)
      }
      return result
    },

    addStream: (stream, options: AddMediaOptions = {}) =>
      addMediaStream(stream, options, streamMetaAction.send),

    removeStream: (stream, options: RemoveMediaOptions = {}) => {
      removeMediaStream(stream, options.target)
    },

    replaceTrack: (oldTrack, newTrack, options: RemoveMediaOptions = {}) =>
      replaceMediaTrack(oldTrack, newTrack, options.target),

    ...pluginApis,

    onPeerJoin: (handler, options) =>
      subPeerJoin(handler, options, () =>
        getPeerIds(false).map((peerId): [PeerJoinContext] => [
          {
            peerId,
            userId: getPeerUserId(peerId),
            roles: getPeerRoles(peerId)
          }
        ])
      ),

    onPeerLeave: subPeerLeave,

    onUserJoin: (handler, options) =>
      subUserJoin(handler, options, () => {
        const items: [UserJoinContext][] = []
        for (const [userId, peerIds] of activeUserPeers) {
          if (userId !== localUserId) {
            const [firstPeerId] = peerIds
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
        }
        return items
      }),

    onUserLeave: subUserLeave,

    onPeerStream,

    onError: subError
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
    canConnectPeer,
    onPeerIdentityVerified,
    getPeerHandle: getAdmissionPeerHandle,
    emitError: err => {
      if (!leavePromise) {
        emitError(err)
      }
    }
  }

  Object.defineProperty(roomInstance, signalingBridgeSymbol, {
    value: bridge,
    enumerable: false
  })

  return [roomInstance as RoomWithPlugins<TPlugins>, bridge]
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
  createRoomWithBridge(onPeer, onPeerLeave, onSelfLeave, roomOptions)[0]
