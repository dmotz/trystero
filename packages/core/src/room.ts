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
  toError,
  toJson
} from './utils'
import {createActionManager} from './actions'
import {
  compareStateRecords,
  decodePublicKey,
  encodePublicKey,
  resolveRoomAuthority,
  signActionAuth,
  signPeerBan,
  signRoleCertificate,
  signRoleRevocation,
  signStateRecord,
  verifyActionAuth,
  verifyPeerBan,
  verifyRoleCertificateChain,
  verifyRoleRevocation,
  verifyStateRecord,
  type ActionAuthEnvelope,
  type ResolvedRoomAuthority
} from './authority'
import {createHandshakeManager} from './handshake'
import {createMediaManager, type InternalMediaMeta} from './media'
import {createOverlayManager, type OverlayManager} from './overlay'
import type {
  AddMediaOptions,
  AdminIdentity,
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
  StateChangeContext,
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

export type RoomAuthorityBridge = {
  getAnnounceExtra: () => Promise<Record<string, unknown> | undefined>
  onSignalingPayload: (
    peerId: string,
    payload: Record<string, unknown>
  ) => Promise<void> | void
}

type RoomOptions = {
  selfId?: string
  appId?: string
  roomId?: string
  password?: string
  topology?: TopologyMode | TopologyConfig
  admin?: boolean | string | AuthorityConfig
  resolvedAuthorityP?: Promise<ResolvedRoomAuthority>
  onOverlayReady?: (overlay: OverlayManager) => void
  onAuthorityReady?: (bridge: RoomAuthorityBridge) => void
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
    }
  | {
      t: 'revoke'
      revocation: RoleRevocationRecord
      reqId?: string
    }
  | {
      t: 'ban'
      ban: PeerBanRecord
      reqId?: string
    }
  | {
      t: 'state'
      record: AuthoritativeStateRecord
    }
  | {
      t: 'ack'
      reqId: string
    }

type StateInstanceEntry<T extends JsonValue = JsonValue> = {
  namespace: string
  value: T
  record: AuthoritativeStateRecord<T> | null
  meta: StateChangeContext | null
  requiredRoles: string[]
  validate?: (next: T, prev: T, context: StateChangeContext) => boolean
  onChange: ((value: T, prev: T, context: StateChangeContext) => void) | null
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
    topology,
    admin,
    resolvedAuthorityP,
    onOverlayReady,
    onAuthorityReady,
    onPeerHandshake,
    onHandshakeError,
    handshakeTimeoutMs = defaultHandshakeTimeoutMs,
    maxReceiveBytes,
    isPassive = false,
    onBeforeLeave
  }: RoomOptions = {}
): Room => {
  let effectiveRoomId = initialRoomId
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

  // Authority, role, ban, and authoritative state stores
  const rootFingerprints = new Set<string>()
  const rootPubKeys = new Set<string>()
  const peerSignKeys = new Map<string, JsonWebKey>()
  const pubKeyWaiters = new Map<string, Array<(jwk: JsonWebKey) => void>>()
  const peerCerts = new Map<string, RoleCertificate>()
  const peerRevocations = new Map<string, RoleRevocationRecord[]>()
  const allRevocations = new Map<string, RoleRevocationRecord>()
  const bannedPeerRecords = new Map<string, PeerBanRecord>()
  const latestStateRecords = new Map<string, AuthoritativeStateRecord>()
  const stateInstances = new Map<string, StateInstanceEntry>()
  const pendingAuthAckWaiters = new Map<
    string,
    {
      expectedPeers: Set<string>
      resolve: () => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  let localAdminIdentity: AdminIdentity | null = null
  let localCert: RoleCertificate | null = null
  let authResolved = false
  let localAuthSeq = 0

  const registerPeerPublicKey = (peerId: string, jwk: JsonWebKey): void => {
    if (!peerId || !jwk || jwk.kty !== 'EC' || !jwk.x || !jwk.y) {
      return
    }
    const cleanJwk: JsonWebKey = {
      crv: 'P-256',
      kty: 'EC',
      x: jwk.x,
      y: jwk.y
    }
    peerSignKeys.set(peerId, cleanJwk)
    overlay.setPeerSignPublicKey(peerId, cleanJwk)
    const waiters = pubKeyWaiters.get(peerId)
    if (waiters) {
      pubKeyWaiters.delete(peerId)
      waiters.forEach(w => w(cleanJwk))
    }
  }

  const getEffectiveRolesForCert = (cert: RoleCertificate): string[] => {
    if (
      bannedPeerRecords.has(cert.subPeerId) ||
      overlay.isPeerBanned(cert.subPeerId)
    ) {
      return []
    }
    if (typeof cert.exp === 'number' && Date.now() > cert.exp) {
      return []
    }
    const revs = peerRevocations.get(cert.subPeerId)
    if (!revs || revs.length === 0) {
      return [...cert.roles]
    }
    const revokedRoles = new Set<string>()
    for (const r of revs) {
      if (r.ts >= cert.iat) {
        if (!r.role || r.role === '*') {
          return []
        }
        revokedRoles.add(r.role)
      }
    }
    return cert.roles.filter(role => !revokedRoles.has(role))
  }

  const getPeerRoles = (targetPeerId = localSelfId): string[] => {
    if (
      bannedPeerRecords.has(targetPeerId) ||
      overlay.isPeerBanned(targetPeerId)
    ) {
      return []
    }
    const cert = peerCerts.get(targetPeerId)
    if (cert) {
      return getEffectiveRolesForCert(cert)
    }
    if (
      !authResolved &&
      targetPeerId === localSelfId &&
      (admin === true ||
        (typeof admin === 'string' && admin.length > 0) ||
        (typeof admin === 'object' &&
          Boolean(admin?.create || admin?.credentials)))
    ) {
      return ['admin']
    }
    return []
  }

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
    roomId: effectiveRoomId,
    password,
    ...(topology === undefined ? {} : {topology}),
    onVirtualPeerJoin: (peerId, vPeer) => {
      if (bannedPeerRecords.has(peerId) || overlay.isPeerBanned(peerId)) {
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
      if (
        bannedPeerRecords.has(originPeerId) ||
        overlay.isPeerBanned(originPeerId)
      ) {
        overlay.recordSignatureFailure()
        return
      }
      handleData(originPeerId, data)
    },
    canPeerSendAction: async (peerId, requiredRoles, inlineCert) => {
      await authInfoP
      if (bannedPeerRecords.has(peerId) || overlay.isPeerBanned(peerId)) {
        return false
      }
      if (inlineCert && inlineCert.subPeerId === peerId) {
        await verifyAndApplyCert(inlineCert)
      }
      const roles = getPeerRoles(peerId)
      return (
        roles.includes('admin') ||
        requiredRoles.includes('*') ||
        requiredRoles.some(r => roles.includes(r))
      )
    },
    onPeerDescriptorCert: (peerId, signPubKey, cert) => {
      registerPeerPublicKey(peerId, signPubKey)
      if (cert) {
        void verifyAndApplyCert(cert)
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

  onOverlayReady?.(overlay)

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
      !bannedPeerRecords.has(id) &&
      !overlay.isPeerBanned(id) &&
      (Boolean(activePeerMap[id]) ||
        handshakeManager.canReceiveFromPeer(id, receiveWhilePending)),
    broadcastInline: (frame, onProgress) =>
      overlay.broadcastInline(frame, onProgress),
    registerActionAuthority: (namespace, roles) =>
      overlay.registerActionAuthority(namespace, roles),
    getPeerRoles: peerId => getPeerRoles(peerId),
    onUnauthorizedAction: () => {
      overlay.recordSignatureFailure()
    },
    signActionPayload: async (namespace, requiredRoles, data, userMetadata) => {
      await authInfoP
      const myRoles = getPeerRoles(localSelfId)
      const allowed =
        myRoles.includes('admin') ||
        requiredRoles.includes('*') ||
        requiredRoles.some(r => myRoles.includes(r))
      if (!allowed || !localCert) {
        throw mkErr(`insufficient authority to send on action "${namespace}"`)
      }
      const cryptoId = await overlay.getLocalCryptoIdentity()
      const env = await signActionAuth(cryptoId.signPrivateKey, localCert, {
        appId,
        roomId: effectiveRoomId,
        namespace,
        peerId: localSelfId,
        seq: ++localAuthSeq,
        data,
        ...(userMetadata === undefined ? {} : {userMetadata})
      })
      return {
        __trysteroAuth: env as unknown as JsonValue,
        ...(userMetadata === undefined ? {} : {m: userMetadata})
      }
    },
    verifyActionPayload: async (
      namespace,
      peerId,
      requiredRoles,
      data,
      wireMetadata
    ) => {
      await authInfoP
      if (bannedPeerRecords.has(peerId) || overlay.isPeerBanned(peerId)) {
        return {valid: false, roles: []}
      }
      if (
        !wireMetadata ||
        typeof wireMetadata !== 'object' ||
        Array.isArray(wireMetadata) ||
        !('__trysteroAuth' in wireMetadata)
      ) {
        return {valid: false, roles: []}
      }
      const env = (wireMetadata as {__trysteroAuth?: unknown})
        .__trysteroAuth as ActionAuthEnvelope | undefined
      const userMetadata = Object.hasOwn(wireMetadata, 'm')
        ? (wireMetadata as {m?: JsonValue}).m
        : undefined
      if (!env || !env.cert) {
        return {valid: false, roles: []}
      }
      const certApplied = await verifyAndApplyCert(env.cert)
      if (!certApplied && peerCerts.get(peerId)?.certId !== env.cert.certId) {
        // Still verify chain directly in case a newer cert replaced it
        const chainRes = await verifyRoleCertificateChain(
          env.cert,
          appId,
          effectiveRoomId,
          rootFingerprints,
          rootPubKeys
        )
        if (!chainRes.valid) {
          return {valid: false, roles: []}
        }
      }
      const effectiveRoles = getEffectiveRolesForCert(env.cert)
      const hasRole =
        effectiveRoles.includes('admin') ||
        requiredRoles.includes('*') ||
        requiredRoles.some(r => effectiveRoles.includes(r))
      if (!hasRole) {
        return {valid: false, roles: []}
      }
      const verified = await verifyActionAuth(env, {
        appId,
        roomId: effectiveRoomId,
        namespace,
        peerId,
        data,
        ...(userMetadata === undefined ? {} : {userMetadata}),
        requiredRoles,
        rootFingerprints,
        rootPubKeys
      })
      if (!verified.valid) {
        return {valid: false, roles: []}
      }
      return {
        valid: true,
        ...(userMetadata === undefined ? {} : {userMetadata}),
        roles: effectiveRoles
      }
    }
  })
  const makeActionInternal = actionManager.makeInternalAction
  const handleData = actionManager.handleData
  const makeAction = actionManager.makeAction

  const clearPeerState = (
    id: string,
    reason: Error = mkErr('peer disconnected')
  ): void => {
    const err = toError(reason, 'peer disconnected')

    handshakeManager.clearPeer(id, err)
    delete peerMap[id]
    delete activePeerMap[id]
    actionManager.clearPeer(id, err)
    pendingPongs[id]?.splice(0).forEach(waiter => waiter.reject(err))
    delete pendingPongs[id]
    mediaManager.clearPeer(id)
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
      overlay.announceLeave()
      const controller = new AbortController()
      void leaveAction
        .send('', undefined, undefined, undefined, controller.signal)
        .catch(noOp)
      await new Promise<void>(res => setTimeout(res, 99))
      controller.abort()

      try {
        overlay.destroy()
        entries(peerMap).forEach(([id, peer]) => {
          peer.destroy()
          clearPeerState(id, mkErr('room left'))
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
  const handshakeReadyAction = makeActionInternal<string>(
    internalNs('hsready'),
    {sendToPending: true, receiveWhilePending: true}
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

  const authInfoP = (
    resolvedAuthorityP ?? resolveRoomAuthority(initialRoomId, admin)
  ).then(async resolved => {
    if (
      resolved.effectiveRoomId &&
      resolved.effectiveRoomId !== effectiveRoomId
    ) {
      effectiveRoomId = resolved.effectiveRoomId
      overlay.setRoomId(effectiveRoomId)
    }
    for (const fp of resolved.rootFingerprints) {
      rootFingerprints.add(fp)
    }
    for (const pk of resolved.rootPubKeys) {
      rootPubKeys.add(pk)
    }
    localAdminIdentity = resolved.localIdentity
    if (resolved.hasAuthorityAnchor || localAdminIdentity) {
      const cryptoId = await overlay.getLocalCryptoIdentity()
      registerPeerPublicKey(localSelfId, cryptoId.signPubJwk)
      if (localAdminIdentity) {
        const rootCert = await signRoleCertificate(
          localAdminIdentity.signPrivateKey,
          localAdminIdentity.signPubJwk,
          {
            subPeerId: localSelfId,
            subPubKey: cryptoId.signPubJwk,
            appId,
            roomId: effectiveRoomId,
            roles: ['admin'],
            canDelegate: true,
            isRoot: true
          }
        )
        localCert = rootCert
        peerCerts.set(localSelfId, rootCert)
        overlay.setLocalRoleCertificate(rootCert)
        overlay.setPrivilegedPeer(localSelfId, true)
      }
    }
    authResolved = true
    return {resolved}
  })

  const verifyAndApplyCert = async (
    cert: RoleCertificate
  ): Promise<boolean> => {
    if (!cert || typeof cert !== 'object') {
      return false
    }
    await authInfoP
    const res = await verifyRoleCertificateChain(
      cert,
      appId,
      effectiveRoomId,
      rootFingerprints,
      rootPubKeys
    )
    if (!res.valid) {
      return false
    }
    registerPeerPublicKey(cert.subPeerId, cert.subPubKey)
    const existing = peerCerts.get(cert.subPeerId)
    if (existing && existing.iat > cert.iat) {
      return true
    }
    if (existing && existing.certId === cert.certId) {
      return false
    }
    peerCerts.set(cert.subPeerId, cert)
    const effectiveRoles = getEffectiveRolesForCert(cert)
    overlay.setPrivilegedPeer(cert.subPeerId, effectiveRoles.includes('admin'))
    if (cert.subPeerId === localSelfId) {
      localCert = cert
      overlay.setLocalRoleCertificate(cert)
    }
    return true
  }

  const verifyAndApplyRevocation = async (
    rev: RoleRevocationRecord
  ): Promise<boolean> => {
    if (!rev || typeof rev !== 'object' || allRevocations.has(rev.sig)) {
      return false
    }
    await authInfoP
    const valid = await verifyRoleRevocation(
      rev,
      appId,
      effectiveRoomId,
      rootFingerprints,
      rootPubKeys
    )
    if (!valid) {
      return false
    }
    const targetCert = peerCerts.get(rev.targetPeerId)
    if (targetCert?.isRoot && !rev.issuerCert.isRoot) {
      return false
    }
    allRevocations.set(rev.sig, rev)
    const list = peerRevocations.get(rev.targetPeerId) ?? []
    list.push(rev)
    peerRevocations.set(rev.targetPeerId, list)
    const remainingRoles = getPeerRoles(rev.targetPeerId)
    overlay.setPrivilegedPeer(
      rev.targetPeerId,
      remainingRoles.includes('admin')
    )
    if (rev.targetPeerId === localSelfId && remainingRoles.length === 0) {
      overlay.setLocalRoleCertificate(null)
    }
    return true
  }

  const verifyAndApplyBan = async (ban: PeerBanRecord): Promise<boolean> => {
    if (
      !ban ||
      typeof ban !== 'object' ||
      bannedPeerRecords.get(ban.targetPeerId)?.sig === ban.sig
    ) {
      return false
    }
    await authInfoP
    const valid = await verifyPeerBan(
      ban,
      appId,
      effectiveRoomId,
      rootFingerprints,
      rootPubKeys
    )
    if (!valid) {
      return false
    }
    const targetCert = peerCerts.get(ban.targetPeerId)
    if (targetCert?.isRoot && !ban.issuerCert.isRoot) {
      return false
    }
    bannedPeerRecords.set(ban.targetPeerId, ban)
    overlay.markPeerBanned(ban.targetPeerId, ban.targetKeyThumbprint)
    if (ban.targetPeerId !== localSelfId && peerMap[ban.targetPeerId]) {
      kickPeer(ban.targetPeerId, undefined, mkErr('peer banned'))
    }
    return true
  }

  const verifyAndApplyStateRecord = async (
    record: AuthoritativeStateRecord
  ): Promise<boolean> => {
    if (!record || typeof record !== 'object') {
      return false
    }
    await authInfoP
    if (
      bannedPeerRecords.has(record.updatedBy) ||
      overlay.isPeerBanned(record.updatedBy)
    ) {
      overlay.recordSignatureFailure()
      return false
    }
    await verifyAndApplyCert(record.cert)
    const effectiveRoles = getEffectiveRolesForCert(record.cert)
    const instance = stateInstances.get(record.namespace)
    const requiredRoles = instance?.requiredRoles ?? ['admin']
    const hasRole =
      effectiveRoles.includes('admin') ||
      requiredRoles.includes('*') ||
      requiredRoles.some(r => effectiveRoles.includes(r))
    if (!hasRole) {
      overlay.recordSignatureFailure()
      return false
    }
    const isValid = await verifyStateRecord(
      record,
      appId,
      effectiveRoomId,
      requiredRoles,
      rootFingerprints,
      rootPubKeys
    )
    if (!isValid) {
      overlay.recordSignatureFailure()
      return false
    }
    const current = instance?.record ?? latestStateRecords.get(record.namespace)
    if (current && compareStateRecords(record, current) <= 0) {
      return false
    }
    const changeCtx: StateChangeContext = {
      updatedBy: record.updatedBy,
      roles: effectiveRoles,
      seq: record.seq,
      epoch: record.epoch,
      timestamp: record.ts,
      hash: record.hash
    }
    if (instance) {
      if (
        instance.validate &&
        !instance.validate(record.value, instance.value, changeCtx)
      ) {
        overlay.recordSignatureFailure()
        return false
      }
      const prevValue = instance.value
      instance.value = record.value
      instance.record = record
      instance.meta = changeCtx
      latestStateRecords.set(record.namespace, record)
      instance.onChange?.(instance.value, prevValue, changeCtx)
    } else {
      latestStateRecords.set(record.namespace, record)
    }
    return true
  }

  const sendAuthSyncToPeer = async (
    targetPeerId: string,
    force = false
  ): Promise<void> => {
    if (
      !targetPeerId ||
      targetPeerId === localSelfId ||
      bannedPeerRecords.has(targetPeerId) ||
      overlay.isPeerBanned(targetPeerId)
    ) {
      return
    }
    const {resolved} = await authInfoP
    if (
      !force &&
      !resolved.hasAuthorityAnchor &&
      peerCerts.size === 0 &&
      allRevocations.size === 0 &&
      bannedPeerRecords.size === 0 &&
      latestStateRecords.size === 0
    ) {
      return
    }
    const cryptoId = await overlay.getLocalCryptoIdentity()
    registerPeerPublicKey(localSelfId, cryptoId.signPubJwk)
    if (!activePeerMap[targetPeerId]) {
      return
    }
    const certs = [...peerCerts.values()]
    const revocations = [...allRevocations.values()]
    const bans = [...bannedPeerRecords.values()]
    const states = [...latestStateRecords.values()]
    await authAction
      .send(
        {
          t: 'sync',
          pubKey: cryptoId.signPubJwk,
          ...(certs.length > 0 ? {certs} : {}),
          ...(revocations.length > 0 ? {revocations} : {}),
          ...(bans.length > 0 ? {bans} : {}),
          ...(states.length > 0 ? {states} : {})
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
          registerPeerPublicKey(fromPeerId, msg.pubKey)
        }
        const newBans: PeerBanRecord[] = []
        const newRevs: RoleRevocationRecord[] = []
        const newCerts: RoleCertificate[] = []
        const newStates: AuthoritativeStateRecord[] = []

        if (Array.isArray(msg.bans)) {
          for (const b of msg.bans) {
            if (await verifyAndApplyBan(b)) {
              newBans.push(b)
            }
          }
        }
        if (Array.isArray(msg.revocations)) {
          for (const r of msg.revocations) {
            if (await verifyAndApplyRevocation(r)) {
              newRevs.push(r)
            }
          }
        }
        if (Array.isArray(msg.certs)) {
          for (const c of msg.certs) {
            if (await verifyAndApplyCert(c)) {
              newCerts.push(c)
            }
          }
        }
        if (Array.isArray(msg.states)) {
          for (const s of msg.states) {
            if (await verifyAndApplyStateRecord(s)) {
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
          const otherPeers = keys(activePeerMap).filter(
            id => id !== fromPeerId && id !== localSelfId
          )
          if (otherPeers.length > 0) {
            void authAction
              .send(
                {
                  t: 'sync',
                  ...(newCerts.length > 0 ? {certs: newCerts} : {}),
                  ...(newRevs.length > 0 ? {revocations: newRevs} : {}),
                  ...(newBans.length > 0 ? {bans: newBans} : {}),
                  ...(newStates.length > 0 ? {states: newStates} : {})
                },
                otherPeers
              )
              .catch(noOp)
          }
        }
      })()
      return
    }
    if (msg.t === 'cert') {
      void verifyAndApplyCert(msg.cert).then(applied => {
        if (msg.reqId) {
          void authAction
            .send({t: 'ack', reqId: msg.reqId}, fromPeerId)
            .catch(noOp)
        }
        if (!applied && !peerCerts.has(msg.cert?.subPeerId)) {
          overlay.recordSignatureFailure()
        }
      })
      return
    }
    if (msg.t === 'revoke') {
      void verifyAndApplyRevocation(msg.revocation).then(applied => {
        if (msg.reqId) {
          void authAction
            .send({t: 'ack', reqId: msg.reqId}, fromPeerId)
            .catch(noOp)
        }
        if (!applied && !allRevocations.has(msg.revocation?.sig)) {
          overlay.recordSignatureFailure()
        }
      })
      return
    }
    if (msg.t === 'ban') {
      void verifyAndApplyBan(msg.ban).then(applied => {
        if (msg.reqId) {
          void authAction
            .send({t: 'ack', reqId: msg.reqId}, fromPeerId)
            .catch(noOp)
        }
        if (
          !applied &&
          bannedPeerRecords.get(msg.ban?.targetPeerId)?.sig !== msg.ban?.sig
        ) {
          overlay.recordSignatureFailure()
        }
      })
      return
    }
    if (msg.t === 'state') {
      void verifyAndApplyStateRecord(msg.record)
    }
  })

  onAuthorityReady?.({
    getAnnounceExtra: async () => {
      const {resolved} = await authInfoP
      if (!resolved.hasAuthorityAnchor || !resolved.signalingProofs) {
        return undefined
      }
      const cryptoId = await overlay.getLocalCryptoIdentity()
      registerPeerPublicKey(localSelfId, cryptoId.signPubJwk)
      const bans = [...bannedPeerRecords.values()]
      return {
        pubKey: encodePublicKey(cryptoId.signPubJwk),
        ...(localCert ? {authCert: localCert} : {}),
        ...(bans.length > 0 ? {bans} : {})
      }
    },
    onSignalingPayload: (peerId, payload) => {
      if (!peerId || peerId === localSelfId) {
        return undefined
      }
      if (typeof payload['pubKey'] === 'string') {
        const jwk = decodePublicKey(payload['pubKey'])
        if (jwk) {
          registerPeerPublicKey(peerId, jwk)
        }
      }
      const tasks: Promise<unknown>[] = []
      if (payload['authCert'] && typeof payload['authCert'] === 'object') {
        tasks.push(verifyAndApplyCert(payload['authCert'] as RoleCertificate))
      }
      if (Array.isArray(payload['bans'])) {
        for (const b of payload['bans']) {
          if (b && typeof b === 'object') {
            tasks.push(verifyAndApplyBan(b as PeerBanRecord))
          }
        }
      }
      if (tasks.length > 0) {
        return Promise.all(tasks).then(noOp)
      }
      return undefined
    }
  })

  const handshakeManager = createHandshakeManager({
    selfId: localSelfId,
    ...(onPeerHandshake === undefined ? {} : {onPeerHandshake}),
    ...(onHandshakeError === undefined ? {} : {onHandshakeError}),
    handshakeTimeoutMs,
    sendHandshakeData: handshakeDataAction.send,
    sendHandshakeReady: handshakeReadyAction.send,
    onActivate: (id, peer) => {
      if (bannedPeerRecords.has(id) || overlay.isPeerBanned(id)) {
        kickPeer(id, peer, mkErr('peer banned'))
        return
      }
      const alreadyJoined = promotedFromVirtual.delete(id)
      activePeerMap[id] = peer
      overlay.addDirectPeer(id, peer)
      void sendAuthSyncToPeer(id)
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

  handshakeReadyAction.onMessage((_, id) =>
    handshakeManager.receiveHandshakeReady(id)
  )

  onPeer((peer, id) => {
    if (bannedPeerRecords.has(id) || overlay.isPeerBanned(id)) {
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

  const waitForPeerPublicKey = (
    peerId: string,
    timeoutMs = 2_000
  ): Promise<JsonWebKey> => {
    const known =
      peerSignKeys.get(peerId) ?? overlay.getPeerSignPublicKey(peerId)
    if (known) {
      return Promise.resolve(known)
    }
    void authAction.send({t: 'whois'}, peerId).catch(noOp)
    return new Promise<JsonWebKey>((resolve, reject) => {
      const timer = setTimeout(() => {
        const list = pubKeyWaiters.get(peerId)
        if (list) {
          const idx = list.indexOf(onKey)
          if (idx > -1) {
            list.splice(idx, 1)
          }
        }
        reject(mkErr(`timed out waiting for public key of peer ${peerId}`))
      }, timeoutMs)
      const onKey = (jwk: JsonWebKey): void => {
        clearTimeout(timer)
        resolve(jwk)
      }
      const list = pubKeyWaiters.get(peerId) ?? []
      list.push(onKey)
      pubKeyWaiters.set(peerId, list)
    })
  }

  return {
    makeAction,

    makeState: <T extends JsonValue = JsonValue>(
      namespace: string,
      initialValue: T,
      config?: StateConfig<T>
    ): AuthoritativeState<T> => {
      if (!namespace || typeof namespace !== 'string') {
        throw mkErr('state namespace is required')
      }
      const rawAuth = config?.authority ?? 'admin'
      const requiredRoles = (
        Array.isArray(rawAuth) ? rawAuth : [rawAuth]
      ).filter(Boolean)

      let entry = stateInstances.get(namespace) as
        | StateInstanceEntry<T>
        | undefined
      if (!entry) {
        entry = {
          namespace,
          value: initialValue,
          record: null,
          meta: null,
          requiredRoles: requiredRoles.length > 0 ? requiredRoles : ['admin'],
          ...(config?.validate ? {validate: config.validate} : {}),
          onChange: null
        }
        stateInstances.set(
          namespace,
          entry as unknown as StateInstanceEntry<JsonValue>
        )

        const cachedRecord = latestStateRecords.get(namespace) as
          | AuthoritativeStateRecord<T>
          | undefined
        if (cachedRecord) {
          latestStateRecords.delete(namespace)
          void verifyAndApplyStateRecord(
            cachedRecord as AuthoritativeStateRecord
          )
        }
      }

      return {
        get: () => entry.value,

        set: async nextOrUpdater => {
          await authInfoP
          const myRoles = getPeerRoles(localSelfId)
          const allowed =
            myRoles.includes('admin') ||
            entry.requiredRoles.includes('*') ||
            entry.requiredRoles.some(r => myRoles.includes(r))
          if (!allowed || !localCert) {
            throw mkErr(`insufficient authority to update state "${namespace}"`)
          }
          const prevValue = entry.value
          const nextValue =
            typeof nextOrUpdater === 'function'
              ? (nextOrUpdater as (prev: T) => T)(prevValue)
              : nextOrUpdater
          const nextEpoch = entry.record ? entry.record.epoch : 1
          const nextSeq = entry.record ? entry.record.seq + 1 : 1
          const prevHash =
            entry.record?.hash ?? '00000000000000000000000000000000'
          const cryptoId = await overlay.getLocalCryptoIdentity()
          const record = await signStateRecord<T>(
            cryptoId.signPrivateKey,
            cryptoId.signPubJwk,
            localCert,
            {
              appId,
              roomId: effectiveRoomId,
              namespace,
              epoch: nextEpoch,
              seq: nextSeq,
              prevHash,
              updatedBy: localSelfId,
              value: nextValue
            }
          )
          const changeCtx: StateChangeContext = {
            updatedBy: localSelfId,
            roles: myRoles,
            seq: record.seq,
            epoch: record.epoch,
            timestamp: record.ts,
            hash: record.hash
          }
          if (
            entry.validate &&
            !entry.validate(nextValue, prevValue, changeCtx)
          ) {
            throw mkErr(`state validation failed for "${namespace}"`)
          }
          entry.value = nextValue
          entry.record = record
          entry.meta = changeCtx
          latestStateRecords.set(
            namespace,
            record as AuthoritativeStateRecord<JsonValue>
          )
          entry.onChange?.(nextValue, prevValue, changeCtx)
          await authAction
            .send({
              t: 'state',
              record: record as AuthoritativeStateRecord<JsonValue>
            })
            .catch(noOp)
        },

        getMeta: () => (entry.meta ? {...entry.meta} : null),

        get onChange() {
          return entry.onChange
        },

        set onChange(handler) {
          entry.onChange = handler
          if (handler && entry.record && entry.meta) {
            handler(entry.value, initialValue, entry.meta)
          }
        }
      }
    },

    getAuthority: async (): Promise<RoomAuthorityInfo> => {
      const {resolved} = await authInfoP
      const roles = getPeerRoles(localSelfId)
      return {
        roomId: effectiveRoomId,
        baseRoomId: resolved.baseRoomId,
        fingerprint: resolved.roomFingerprint,
        isAdmin: roles.includes('admin'),
        roles,
        publicKey: localAdminIdentity?.publicKey ?? null,
        adminKey: localAdminIdentity?.adminKey ?? null
      }
    },

    grantRole: async (peerId, role, options) => {
      if (!peerId || typeof peerId !== 'string') {
        throw mkErr('peerId is required to grant a role')
      }
      await authInfoP
      const myRoles = getPeerRoles(localSelfId)
      const requestedRoles = (Array.isArray(role) ? role : [role]).filter(
        Boolean
      )
      if (requestedRoles.length === 0) {
        throw mkErr('at least one role must be specified')
      }
      const canGrant =
        Boolean(localAdminIdentity) ||
        (Boolean(localCert?.canDelegate) &&
          (myRoles.includes('admin') ||
            requestedRoles.every(r => myRoles.includes(r))))
      if (!canGrant) {
        throw mkErr('insufficient authority to grant role')
      }

      const subPubKey = await waitForPeerPublicKey(peerId)
      const currentRoles = getPeerRoles(peerId)
      const mergedRoles = [...new Set([...currentRoles, ...requestedRoles])]
      const cryptoId = await overlay.getLocalCryptoIdentity()

      const cert = localAdminIdentity
        ? await signRoleCertificate(
            localAdminIdentity.signPrivateKey,
            localAdminIdentity.signPubJwk,
            {
              subPeerId: peerId,
              subPubKey,
              appId,
              roomId: effectiveRoomId,
              roles: mergedRoles,
              ...(options?.canDelegate ? {canDelegate: true} : {}),
              ...(typeof options?.expiresInMs === 'number'
                ? {expiresInMs: options.expiresInMs}
                : {})
            }
          )
        : await signRoleCertificate(
            cryptoId.signPrivateKey,
            cryptoId.signPubJwk,
            {
              subPeerId: peerId,
              subPubKey,
              appId,
              roomId: effectiveRoomId,
              roles: mergedRoles,
              ...(options?.canDelegate ? {canDelegate: true} : {}),
              ...(typeof options?.expiresInMs === 'number'
                ? {expiresInMs: options.expiresInMs}
                : {}),
              parentCert: localCert!
            }
          )

      await verifyAndApplyCert(cert)
      const reqId = genId(12)
      const ackWait = waitForAuthAck(reqId, keys(activePeerMap))
      await authAction.send({t: 'cert', cert, reqId}).catch(noOp)
      await ackWait
      return cert
    },

    revokeRole: async (peerId, role) => {
      if (!peerId || typeof peerId !== 'string') {
        throw mkErr('peerId is required to revoke a role')
      }
      await authInfoP
      const myRoles = getPeerRoles(localSelfId)
      if (!myRoles.includes('admin') && !localCert?.canDelegate) {
        throw mkErr('insufficient authority to revoke role')
      }
      const targetCert = peerCerts.get(peerId)
      if (targetCert?.isRoot && !localCert?.isRoot) {
        throw mkErr('delegated authority cannot revoke a root admin')
      }
      const cryptoId = await overlay.getLocalCryptoIdentity()
      const revocation = await signRoleRevocation(
        cryptoId.signPrivateKey,
        localCert!,
        {
          appId,
          roomId: effectiveRoomId,
          issuerPeerId: localSelfId,
          targetPeerId: peerId,
          ...(role ? {role} : {}),
          seq: ++localAuthSeq
        }
      )
      await verifyAndApplyRevocation(revocation)
      const reqId = genId(12)
      const ackWait = waitForAuthAck(reqId, keys(activePeerMap))
      await authAction.send({t: 'revoke', revocation, reqId}).catch(noOp)
      await ackWait
    },

    getPeerRoles: (peerId?: string) => getPeerRoles(peerId ?? localSelfId),

    banPeer: async (peerId, options) => {
      if (!peerId || typeof peerId !== 'string') {
        throw mkErr('peerId is required to ban a peer')
      }
      await authInfoP
      const myRoles = getPeerRoles(localSelfId)
      if (!myRoles.includes('admin') || !localCert) {
        throw mkErr('only an admin can ban a peer')
      }
      const targetCert = peerCerts.get(peerId)
      if (targetCert?.isRoot && !localCert.isRoot) {
        throw mkErr('delegated admin cannot ban a root admin')
      }
      const targetPubKey =
        peerSignKeys.get(peerId) ?? overlay.getPeerSignPublicKey(peerId)
      const targetKeyThumbprint = targetPubKey
        ? toJson(targetPubKey)
        : undefined
      const cryptoId = await overlay.getLocalCryptoIdentity()
      const ban = await signPeerBan(cryptoId.signPrivateKey, localCert, {
        appId,
        roomId: effectiveRoomId,
        issuerPeerId: localSelfId,
        targetPeerId: peerId,
        ...(targetKeyThumbprint ? {targetKeyThumbprint} : {}),
        ...(options?.reason ? {reason: options.reason} : {}),
        seq: ++localAuthSeq
      })
      const otherPeers = keys(activePeerMap).filter(id => id !== peerId)
      await verifyAndApplyBan(ban)
      const reqId = genId(12)
      const ackWait = waitForAuthAck(reqId, otherPeers)
      await authAction.send({t: 'ban', ban, reqId}).catch(noOp)
      await ackWait
    },

    isBanned: peerId =>
      bannedPeerRecords.has(peerId) || overlay.isPeerBanned(peerId),

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
        entries(activePeerMap).map(([id, peer]) => [id, peer.connection])
      ) as Record<string, RTCPeerConnection>,

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
}
