import {
  computePayloadDigest,
  signActionAuth,
  validateActionAuthShape,
  verifyActionAuth,
  type ActionAuthEnvelope,
  type ActionSignParams,
  type ActionVerifyParams
} from './action-auth'
import {getVerifiedPubKeyRecord, isValidUserId} from './identity'
import {
  canonTag,
  createMonotonicClock,
  createSlidingReplayWindow,
  defaultMaxClockSkewMs,
  getSignerClock,
  isValidJwk,
  roleCertPayload,
  signRoleCertificate,
  signWith,
  toCleanJwk,
  verifyRoleCertificate,
  verifyRoleCertificateChain,
  verifySig,
  type CertSignParams,
  type StateSigner
} from './signed-record'
import {
  compareStateRecords,
  signStateRecord,
  validateStateRecordShape,
  verifyStateRecordSignature,
  type StateSignParams
} from './state'
import type {
  AuthoritativeStateRecord,
  InternalRoomContext,
  KernelRolesProvider,
  PeerBanRecord,
  RoleRevocationRecord
} from './internal-types'
import {internalPluginSymbol} from './primitives'
import type {
  DataPayload,
  JsonValue,
  RoleCertificate,
  RolesConfig,
  RolesPluginApi,
  RoomPlugin,
  TargetPeers,
  UserIdentity
} from './types'
import {
  authMetaKey,
  createBoundedCache,
  createWindowCounter,
  definePlugin,
  insufficientAuthPrefix,
  isObj,
  isPosSafeInt,
  isSelfAsAdminPlugin,
  isStr,
  isValidSig,
  keys,
  mkErr,
  noOp,
  peerBannedErr,
  peerBannedMsg,
  selfCertifyingRoomRegex,
  validateRoleCertificateShape
} from './utils'

export {
  compareStateRecords,
  computePayloadDigest,
  isSelfAsAdminPlugin,
  roleCertPayload,
  signActionAuth,
  signRoleCertificate,
  signStateRecord,
  validateActionAuthShape,
  validateRoleCertificateShape,
  validateStateRecordShape,
  verifyActionAuth,
  verifyRoleCertificate,
  verifyRoleCertificateChain,
  type ActionAuthEnvelope,
  type ActionSignParams,
  type ActionVerifyParams,
  type CertSignParams,
  type StateSignParams,
  type StateSigner
}

type Signer = StateSigner

const maxSyncCerts = 128
const maxSyncModerationRecords = 256
const maxStoredModerationRecords = 512
const maxRevocationsPerPairRole = 4
const actionReplayWindowBits = 512n

const lastLocalActSeqByRoomPeer = /*@__PURE__*/ createBoundedCache<
  string,
  number
>(256)

const hasStrs = (o: Record<string, unknown>, ks: readonly string[]): boolean =>
  ks.every(k => isStr(o[k]))

const rootAdminProtectErr = (scope: string, verb: string) =>
  mkErr(`${scope}: cannot ${verb} a root admin`)

export const parseSelfCertifyingRoomId = (
  roomId: string
): {baseRoomId: string; userId: string | null} => {
  const m = selfCertifyingRoomRegex.exec(roomId)
  return m?.[1] && m[2]
    ? {baseRoomId: m[1], userId: m[2]}
    : {baseRoomId: roomId, userId: null}
}

export const formatSelfCertifyingRoomId = (
  base: string,
  userId: string
): string => `${parseSelfCertifyingRoomId(base).baseRoomId}~${userId}`

const normalizeRolesConfig = (config?: RolesConfig): RolesConfig => {
  let admins: string[] | undefined
  if (isObj(config)) {
    for (const k of keys(config)) {
      if (k !== 'selfAsAdmin' && k !== 'admins') {
        throw mkErr(`Unknown roles config option "${k}"`)
      }
    }
    if (config.admins !== undefined) {
      if (!Array.isArray(config.admins)) {
        throw mkErr('roles admins must be an array of userIds')
      }
      const validated: string[] = []
      for (const raw of config.admins) {
        const entry = typeof raw === 'string' ? raw.trim() : ''
        if (!isValidUserId(entry)) {
          throw mkErr(
            `invalid admin userId "${String(raw)}"; expected a 22-character Base62 userId`
          )
        }
        validated.push(entry)
      }
      if (validated.length) {
        admins = validated
      }
    }
  }
  return {
    ...(config?.selfAsAdmin ? {selfAsAdmin: true} : {}),
    ...(admins ? {admins} : {})
  }
}

export const revocationCanonicalPayload = (
  r: Omit<RoleRevocationRecord, 'sig'>
): string =>
  canonTag('role-revoke', [
    r.v,
    r.appId,
    r.roomId,
    r.issuerUserId,
    r.targetUserId,
    r.targetCertId ?? '',
    r.role ?? '*',
    r.seq,
    r.ts,
    r.issuerCert.sig
  ])

export const banCanonicalPayload = (b: Omit<PeerBanRecord, 'sig'>): string =>
  canonTag('peer-ban', [
    b.v,
    b.appId,
    b.roomId,
    b.issuerUserId,
    b.targetUserId,
    b.reason ?? '',
    b.seq,
    b.ts,
    b.issuerCert.sig
  ])

const isAdminRecBase = (r: Record<string, unknown>): boolean =>
  r['v'] === 1 &&
  hasStrs(r, ['appId', 'roomId', 'issuerUserId', 'targetUserId']) &&
  isPosSafeInt(r['seq']) &&
  isPosSafeInt(r['ts']) &&
  validateRoleCertificateShape(r['issuerCert']) &&
  isValidJwk(r['signerPubKey']) &&
  isValidSig(r['sig'])

export const validateRoleRevocationShape = (
  r: unknown
): r is RoleRevocationRecord =>
  isObj(r) &&
  isAdminRecBase(r) &&
  (r['targetCertId'] === undefined || isStr(r['targetCertId'])) &&
  (r['role'] === undefined || isStr(r['role']))

export const validatePeerBanShape = (b: unknown): b is PeerBanRecord =>
  isObj(b) &&
  isAdminRecBase(b) &&
  (b['reason'] === undefined || typeof b['reason'] === 'string')

export type AdminSignParams = {
  appId: string
  roomId: string
  issuerUserId?: string
  targetUserId: string
  targetCertId?: string
  role?: string
  reason?: string
  seq: number
  now?: number
  minTs?: number
  ts?: number
}

const signModRec = async <T extends RoleRevocationRecord | PeerBanRecord>(
  signer: Signer,
  pubJwk: JsonWebKey,
  cert: RoleCertificate,
  p: AdminSignParams,
  extra: Record<string, unknown>,
  canon: (u: Omit<T, 'sig'>) => string
): Promise<T> => {
  const u = {
    v: 1 as const,
    appId: p.appId,
    roomId: p.roomId,
    issuerUserId: p.issuerUserId ?? cert.subUserId,
    targetUserId: p.targetUserId,
    ...extra,
    seq: p.seq,
    ts:
      p.ts ??
      p.now ??
      getSignerClock(signer).next(Math.max(cert.iat, p.minTs ?? 0)),
    issuerCert: cert,
    signerPubKey: toCleanJwk(pubJwk)
  } as unknown as Omit<T, 'sig'>
  return {...u, sig: await signWith(signer, canon(u))} as T
}

export const signRoleRevocation = (
  signer: Signer,
  pubJwk: JsonWebKey,
  cert: RoleCertificate,
  p: AdminSignParams
): Promise<RoleRevocationRecord> =>
  signModRec(
    signer,
    pubJwk,
    cert,
    p,
    {
      ...(p.targetCertId ? {targetCertId: p.targetCertId} : {}),
      ...(p.role ? {role: p.role} : {})
    },
    revocationCanonicalPayload
  )

export const signPeerBan = (
  signer: Signer,
  pubJwk: JsonWebKey,
  cert: RoleCertificate,
  p: AdminSignParams
): Promise<PeerBanRecord> =>
  signModRec(
    signer,
    pubJwk,
    cert,
    p,
    p.reason ? {reason: p.reason} : {},
    banCanonicalPayload
  )

const verifyAdminRec = async (
  rec: RoleRevocationRecord | PeerBanRecord,
  payload: string,
  appId: string,
  roomId: string,
  rootUserIds: Set<string>,
  clockSkewMs: number = defaultMaxClockSkewMs,
  certVerifier?: (
    cert: RoleCertificate
  ) => Promise<{valid: boolean; roles: string[]}>
): Promise<boolean> => {
  if (
    rec.appId !== appId ||
    rec.roomId !== roomId ||
    rec.ts > Date.now() + clockSkewMs ||
    rec.ts < rec.issuerCert.iat ||
    rec.issuerCert.subUserId !== rec.issuerUserId ||
    !rec.issuerCert.roles.includes('admin')
  ) {
    return false
  }
  const signer = await getVerifiedPubKeyRecord(rec.signerPubKey)
  if (!signer || signer.userId !== rec.issuerUserId) {
    return false
  }
  const certRes = certVerifier
    ? await certVerifier(rec.issuerCert)
    : await verifyRoleCertificate(
        rec.issuerCert,
        appId,
        roomId,
        rootUserIds,
        clockSkewMs
      )
  return certRes.valid && (await verifySig(rec.signerPubKey, payload, rec.sig))
}

export const verifyRoleRevocation = async (
  rev: RoleRevocationRecord,
  appId: string,
  roomId: string,
  rootUserIds: Set<string>,
  clockSkewMs: number = defaultMaxClockSkewMs
): Promise<boolean> =>
  validateRoleRevocationShape(rev) &&
  verifyAdminRec(
    rev,
    revocationCanonicalPayload(rev),
    appId,
    roomId,
    rootUserIds,
    clockSkewMs
  )

export const verifyPeerBan = async (
  ban: PeerBanRecord,
  appId: string,
  roomId: string,
  rootUserIds: Set<string>,
  clockSkewMs: number = defaultMaxClockSkewMs
): Promise<boolean> =>
  validatePeerBanShape(ban) &&
  verifyAdminRec(
    ban,
    banCanonicalPayload(ban),
    appId,
    roomId,
    rootUserIds,
    clockSkewMs
  )

export const verifyStateRecord = async (
  rec: AuthoritativeStateRecord,
  appId: string,
  roomId: string,
  requiredRoles: readonly string[] = ['admin'],
  rootUserIds: Set<string> = new Set(),
  clockSkewMs: number = defaultMaxClockSkewMs
): Promise<boolean> => {
  if (!(await verifyStateRecordSignature(rec, appId, roomId, clockSkewMs))) {
    return false
  }
  if (!requiredRoles.length && !rec.cert) {
    return true
  }
  if (!rec.cert) {
    return false
  }
  const certRes = await verifyRoleCertificate(
    rec.cert,
    appId,
    roomId,
    rootUserIds,
    clockSkewMs
  )
  return (
    certRes.valid &&
    (!requiredRoles.length ||
      requiredRoles.some(r => certRes.roles.includes(r)))
  )
}

export type AuthPullMessage = {
  t: 'pull'
  pubKey?: JsonWebKey
  s?: string[]
}

export type AuthSyncMessage = {
  t: 'sync'
  pubKey?: JsonWebKey
  certs?: RoleCertificate[]
  revocations?: RoleRevocationRecord[]
  bans?: PeerBanRecord[]
}

export type AuthControlMessage =
  | AuthPullMessage
  | AuthSyncMessage
  | {t: 'cert'; cert: RoleCertificate}
  | {t: 'revoke'; revocation: RoleRevocationRecord}
  | {t: 'ban'; ban: PeerBanRecord}

export type AuthSyncBatchInput = {
  certs?: readonly RoleCertificate[]
  revocations?: readonly RoleRevocationRecord[]
  bans?: readonly PeerBanRecord[]
}

export type AuthSyncBatchResult = {
  certs: RoleCertificate[]
  revocations: RoleRevocationRecord[]
  bans: PeerBanRecord[]
}

export type RoomAuthority = Omit<
  KernelRolesProvider,
  'onPeerDescriptorCert'
> & {
  verifyAndApplyCert: (
    cert: RoleCertificate,
    fromPeerId?: string
  ) => Promise<boolean>
  verifyAndApplyRevocation: (
    rev: RoleRevocationRecord,
    fromPeerId?: string
  ) => Promise<boolean>
  verifyAndApplyBan: (
    ban: PeerBanRecord,
    fromPeerId?: string
  ) => Promise<boolean>
  applySyncBatch: (
    batch: AuthSyncBatchInput,
    fromPeerId?: string,
    shouldAbort?: () => boolean
  ) => Promise<AuthSyncBatchResult>
  buildPullMessage: () => Promise<AuthPullMessage | null>
  buildDiffSyncMessage: (
    knownSigs?: readonly string[]
  ) => Promise<AuthSyncMessage | null>
  issueRoleCertificate: (
    targetId: string,
    role: string | string[]
  ) => Promise<RoleCertificate>
  issueRoleRevocation: (
    targetId: string,
    role?: string
  ) => Promise<RoleRevocationRecord>
  issuePeerBan: (
    targetId: string,
    options?: {reason?: string}
  ) => Promise<PeerBanRecord>
}

export type RoomAuthorityPreResolvedState = {
  adminUserId?: string
  baseRoomId?: string
}

export type RoomAuthorityInit = {
  selfId: string
  appId: string
  initialRoomId: string
  effectiveRoomIdP?: Promise<string>
  getPreResolvedState?: () => RoomAuthorityPreResolvedState | undefined
  admin?: RolesConfig
  getLocalCryptoIdentity?: () => Promise<unknown>
  getLocalUserIdentity?: () => Promise<UserIdentity>
  getOverlayPeerPublicKey?: (peerId: string) => JsonWebKey | undefined
  isOverlayPeerBanned?: (peerId: string) => boolean
  getPeerUserId?: (peerId: string) => string | undefined
  onRoomIdResolved?: (effectiveRoomId: string) => void
  onPeerPublicKey?: (
    peerId: string,
    pubKey: JsonWebKey,
    userId?: string
  ) => void
  onLocalRoleCertificate?: (cert: RoleCertificate | null) => void
  onPeerBanned?: (
    userId: string,
    banRecord: PeerBanRecord,
    fromPeerId?: string
  ) => void
  onSignatureFailure?: (fromPeerId?: string) => void
}

const revContentKey = (r: RoleRevocationRecord): string =>
  `${r.issuerUserId}\u0000${r.targetUserId}\u0000${r.targetCertId ?? ''}\u0000${r.role ?? '*'}\u0000${r.seq}\u0000${r.ts}`

const revPairRoleKey = (r: RoleRevocationRecord): string =>
  `${r.issuerUserId}\u0000${r.targetUserId}\u0000${r.role ?? '*'}`

const banPairKey = (b: Pick<PeerBanRecord, 'issuerUserId' | 'targetUserId'>) =>
  `${b.issuerUserId}\u0000${b.targetUserId}`

const compareModCausalOrder = (
  a: Pick<
    RoleRevocationRecord | PeerBanRecord,
    'ts' | 'seq' | 'issuerUserId' | 'targetUserId' | 'sig'
  >,
  aKind: 'ban' | 'revoke',
  b: Pick<
    RoleRevocationRecord | PeerBanRecord,
    'ts' | 'seq' | 'issuerUserId' | 'targetUserId' | 'sig'
  >,
  bKind: 'ban' | 'revoke'
): number => {
  if (a.ts !== b.ts) {
    return a.ts - b.ts
  }
  if (a.seq !== b.seq) {
    return a.seq - b.seq
  }
  if (aKind !== bKind) {
    return aKind === 'ban' ? -1 : 1
  }
  if (a.issuerUserId !== b.issuerUserId) {
    return a.issuerUserId < b.issuerUserId ? -1 : 1
  }
  if (a.targetUserId !== b.targetUserId) {
    return a.targetUserId < b.targetUserId ? -1 : 1
  }
  return a.sig < b.sig ? -1 : a.sig > b.sig ? 1 : 0
}

export const createRoomAuthority = (init: RoomAuthorityInit): RoomAuthority => {
  const {selfId, appId, initialRoomId} = init
  const admin = normalizeRolesConfig(init.admin)
  const clockSkewMs = defaultMaxClockSkewMs
  const clock = createMonotonicClock()
  const certs = new Map<string, RoleCertificate>()
  const revocations = new Map<string, RoleRevocationRecord[]>()
  const rawRevocations = new Map<string, RoleRevocationRecord>()
  const revPairRoleCounts = new Map<string, number>()
  const bans = new Map<string, PeerBanRecord>()
  const rawBans = new Map<string, PeerBanRecord>()
  const peerToUserId = new Map<string, string>()
  const actionReplayWindow = createSlidingReplayWindow(
    2_048,
    undefined,
    actionReplayWindowBits
  )
  const acceptedOffers = createBoundedCache<string, string>(512)
  const verifiedCertCache = createBoundedCache<string, string[]>(512)

  const initialPreResolved = init.getPreResolvedState?.()
  let localCert: RoleCertificate | null = null
  let localModSeq = 0
  let localActSeq = 0
  let didSyncActSeqFloor = false
  let effectiveRoomId = initialRoomId
  const initialParsed = parseSelfCertifyingRoomId(initialRoomId)
  let baseRoomId = initialPreResolved?.baseRoomId ?? initialParsed.baseRoomId
  let roomAdminUserId = initialPreResolved?.adminUserId ?? initialParsed.userId
  const rootUserIds = new Set<string>(roomAdminUserId ? [roomAdminUserId] : [])
  let localUser: UserIdentity | null = null
  for (const uid of admin.admins ?? []) {
    rootUserIds.add(uid)
  }

  const nextLocalActSeq = (): number => {
    const floorKey = `${appId}\u0000${effectiveRoomId}\u0000${selfId}`
    if (!didSyncActSeqFloor) {
      didSyncActSeqFloor = true
      const prev = lastLocalActSeqByRoomPeer.get(floorKey)
      if (prev !== undefined) {
        localActSeq = Math.max(localActSeq, prev + 512)
      }
    }
    const next = ++localActSeq
    lastLocalActSeqByRoomPeer.set(floorKey, next)
    return next
  }

  const failSig = (fromPeerId?: string): false => (
    init.onSignatureFailure?.(fromPeerId),
    false
  )
  const resolveUid = (id = selfId): string =>
    id === selfId && localUser
      ? localUser.userId
      : (peerToUserId.get(id) ?? init.getPeerUserId?.(id) ?? id)

  const candidateUids = (id = selfId): string[] => {
    const s = new Set<string>([resolveUid(id), id])
    const mapped = init.getPeerUserId?.(id)
    if (mapped) {
      s.add(mapped)
    }
    return [...s]
  }

  const isRootUid = (uid: string): boolean => rootUserIds.has(uid)

  const canIssuerRevokeTarget = (rev: RoleRevocationRecord): boolean => {
    if (!isRootUid(rev.targetUserId)) {
      return true
    }
    if (!isRootUid(rev.issuerUserId)) {
      return false
    }
    return Boolean(rev.role && rev.role !== '*' && rev.role !== 'admin')
  }

  const effectiveRolesFromMap = (
    cert: RoleCertificate,
    revMap: Map<string, RoleRevocationRecord[]>
  ): string[] => {
    const isRoot = isRootUid(cert.subUserId)
    const revoked = new Set<string>()
    for (const r of revMap.get(cert.subUserId) ?? []) {
      if (r.targetCertId === cert.certId || r.ts >= cert.iat) {
        if (!r.role || r.role === '*') {
          return isRoot ? ['admin'] : []
        }
        if (!isRoot || r.role !== 'admin') {
          revoked.add(r.role)
        }
      }
    }
    const active = cert.roles.filter(role => !revoked.has(role))
    return isRoot && !active.includes('admin') ? ['admin', ...active] : active
  }

  const effectiveRoles = (cert: RoleCertificate): string[] =>
    effectiveRolesFromMap(cert, revocations)

  const syncLocalCert = (): void => {
    if (!localUser) {
      return
    }
    const stored = certs.get(localUser.userId)
    const canHold =
      stored && !bans.has(localUser.userId) && effectiveRoles(stored).length > 0
    if (!canHold) {
      if (localCert !== null) {
        localCert = null
        init.onLocalRoleCertificate?.(null)
      }
      return
    }
    if (localCert?.sig !== stored.sig) {
      localCert = stored
      init.onLocalRoleCertificate?.(stored)
    }
  }

  const recomputeModerationState = (
    fromPeerId?: string
  ): {
    effectiveRevKeys: Set<string>
    effectiveBanSigs: Set<string>
  } => {
    const prevBannedUids = new Set(bans.keys())
    const events: Array<
      | {kind: 'ban'; rec: PeerBanRecord}
      | {kind: 'revoke'; rec: RoleRevocationRecord}
    > = []
    for (const b of rawBans.values()) {
      events.push({kind: 'ban', rec: b})
    }
    for (const r of rawRevocations.values()) {
      events.push({kind: 'revoke', rec: r})
    }
    events.sort((a, b) => compareModCausalOrder(a.rec, a.kind, b.rec, b.kind))

    const nextRevocations = new Map<string, RoleRevocationRecord[]>()
    const nextBans = new Map<string, PeerBanRecord>()
    const effectiveRevKeys = new Set<string>()
    const effectiveBanSigs = new Set<string>()

    const hasAdminAtEvent = (cert: RoleCertificate): boolean => {
      const uid = cert.subUserId
      if (isRootUid(uid)) {
        return true
      }
      if (nextBans.has(uid)) {
        return false
      }
      return effectiveRolesFromMap(cert, nextRevocations).includes('admin')
    }

    for (const ev of events) {
      if (ev.kind === 'ban') {
        if (
          !isRootUid(ev.rec.targetUserId) &&
          hasAdminAtEvent(ev.rec.issuerCert) &&
          !nextBans.has(ev.rec.targetUserId)
        ) {
          nextBans.set(ev.rec.targetUserId, ev.rec)
          effectiveBanSigs.add(ev.rec.sig)
        }
      } else if (
        canIssuerRevokeTarget(ev.rec) &&
        hasAdminAtEvent(ev.rec.issuerCert)
      ) {
        const list = nextRevocations.get(ev.rec.targetUserId) ?? []
        list.push(ev.rec)
        nextRevocations.set(ev.rec.targetUserId, list)
        effectiveRevKeys.add(revContentKey(ev.rec))
      }
    }

    revocations.clear()
    for (const [k, v] of nextRevocations) {
      revocations.set(k, v)
    }
    bans.clear()
    for (const [k, v] of nextBans) {
      bans.set(k, v)
    }

    syncLocalCert()

    for (const [bannedUid, banRec] of bans.entries()) {
      if (!prevBannedUids.has(bannedUid)) {
        init.onPeerBanned?.(bannedUid, banRec, fromPeerId)
      }
    }

    return {effectiveRevKeys, effectiveBanSigs}
  }

  const verifyCertCached = async (
    cert: RoleCertificate
  ): Promise<{valid: boolean; roles: string[]}> => {
    if (
      !validateRoleCertificateShape(cert) ||
      cert.appId !== appId ||
      cert.roomId !== effectiveRoomId ||
      cert.iat > Date.now() + clockSkewMs
    ) {
      return {valid: false, roles: []}
    }
    const cacheKey = `${roleCertPayload(cert)}\u0000${cert.sig}`
    const cachedRoles = verifiedCertCache.get(cacheKey)
    if (cachedRoles) {
      return {valid: true, roles: [...cachedRoles]}
    }
    const res = await verifyRoleCertificate(
      cert,
      appId,
      effectiveRoomId,
      rootUserIds,
      clockSkewMs
    )
    if (res.valid) {
      verifiedCertCache.set(cacheKey, [...res.roles])
    }
    return res
  }

  const getPeerRoles = (peerOrUserId = selfId): string[] => {
    const uids = candidateUids(peerOrUserId)
    if (uids.some(uid => !isRootUid(uid) && bans.has(uid))) {
      return []
    }
    for (const uid of uids) {
      const cert = certs.get(uid)
      if (cert) {
        return effectiveRoles(cert)
      }
      if (isRootUid(uid)) {
        return ['admin']
      }
    }
    return []
  }

  const isPeerBanned = (peerOrUserId: string): boolean => {
    const uids = candidateUids(peerOrUserId)
    if (uids.some(isRootUid)) {
      return false
    }
    return Boolean(
      init.isOverlayPeerBanned?.(peerOrUserId) ||
      uids.some(uid => bans.has(uid))
    )
  }

  const getBanReason = (peerOrUserId: string): string | undefined => {
    const uids = candidateUids(peerOrUserId)
    if (uids.some(isRootUid)) {
      return undefined
    }
    for (const uid of uids) {
      const rec = bans.get(uid)
      if (rec?.reason !== undefined) {
        return rec.reason
      }
    }
    return undefined
  }

  const registerPeerPublicKey = (peerId: string, pubKey: JsonWebKey): void => {
    if (!peerId || !isValidJwk(pubKey)) {
      return
    }
    void getVerifiedPubKeyRecord(pubKey).then(rec => {
      if (!rec) {
        return
      }
      peerToUserId.set(peerId, rec.userId)
      init.onPeerPublicKey?.(peerId, rec.cleanJwk, rec.userId)
      const banRec = bans.get(rec.userId)
      if (!isRootUid(rec.userId) && banRec) {
        init.onPeerBanned?.(rec.userId, banRec, peerId)
      }
    })
  }

  let resolvedP: Promise<void> | null = null
  const ensureResolved = (): Promise<void> =>
    (resolvedP ??= (async () => {
      localUser = init.getLocalUserIdentity
        ? await init.getLocalUserIdentity()
        : null
      if (init.effectiveRoomIdP) {
        const resolvedRid = await init.effectiveRoomIdP
        const preResolved = init.getPreResolvedState?.()
        if (resolvedRid && resolvedRid !== effectiveRoomId) {
          effectiveRoomId = resolvedRid
          init.onRoomIdResolved?.(effectiveRoomId)
        }
        const parsed = parseSelfCertifyingRoomId(effectiveRoomId)
        baseRoomId = preResolved?.baseRoomId ?? parsed.baseRoomId
        const resolvedAdminUid = preResolved?.adminUserId ?? parsed.userId
        if (resolvedAdminUid) {
          roomAdminUserId = resolvedAdminUid
          rootUserIds.add(resolvedAdminUid)
        }
      } else if (!roomAdminUserId && admin.selfAsAdmin && localUser) {
        roomAdminUserId = localUser.userId
        baseRoomId = initialRoomId
        effectiveRoomId = formatSelfCertifyingRoomId(
          initialRoomId,
          roomAdminUserId
        )
        rootUserIds.add(roomAdminUserId)
        init.onRoomIdResolved?.(effectiveRoomId)
      }
      if (!localUser) {
        return
      }
      peerToUserId.set(selfId, localUser.userId)
      if (rootUserIds.has(localUser.userId)) {
        const rootCert = await signRoleCertificate(
          localUser.sign,
          localUser.signPubJwk,
          {
            subUserId: localUser.userId,
            appId,
            roomId: effectiveRoomId,
            roles: ['admin'],
            now: clock.next()
          }
        )
        verifiedCertCache.set(
          `${roleCertPayload(rootCert)}\u0000${rootCert.sig}`,
          [...rootCert.roles]
        )
        certs.set(localUser.userId, rootCert)
        localCert = rootCert
        init.onLocalRoleCertificate?.(rootCert)
      } else {
        syncLocalCert()
      }
    })())
  void ensureResolved().catch(noOp)

  const guardApply = <T>(fn: () => Promise<T>, fallback: () => T): Promise<T> =>
    ensureResolved().then(fn).catch(fallback)

  const stageCertInternal = async (
    cert: RoleCertificate,
    fromPeerId?: string
  ): Promise<'applied' | 'duplicate' | 'invalid'> => {
    if (
      !validateRoleCertificateShape(cert) ||
      cert.appId !== appId ||
      cert.roomId !== effectiveRoomId ||
      cert.iat > Date.now() + clockSkewMs ||
      (isRootUid(cert.subUserId) && !cert.roles.includes('admin'))
    ) {
      failSig(fromPeerId)
      return 'invalid'
    }
    const prev = certs.get(cert.subUserId)
    if (prev && (prev.sig === cert.sig || prev.iat >= cert.iat)) {
      return 'duplicate'
    }
    const res = await verifyCertCached(cert)
    if (!res.valid) {
      failSig(fromPeerId)
      return 'invalid'
    }
    certs.set(cert.subUserId, cert)
    return 'applied'
  }

  const stageRevocationInternal = async (
    rev: RoleRevocationRecord,
    fromPeerId?: string
  ): Promise<
    {status: 'staged'; key: string} | {status: 'duplicate' | 'invalid'}
  > => {
    if (!validateRoleRevocationShape(rev) || !canIssuerRevokeTarget(rev)) {
      failSig(fromPeerId)
      return {status: 'invalid'}
    }
    const key = revContentKey(rev)
    if (rawRevocations.has(key)) {
      return {status: 'duplicate'}
    }
    const pairKey = revPairRoleKey(rev)
    if (
      (revPairRoleCounts.get(pairKey) ?? 0) >= maxRevocationsPerPairRole ||
      rawRevocations.size >= maxStoredModerationRecords
    ) {
      return {status: 'duplicate'}
    }
    if (
      !(await verifyAdminRec(
        rev,
        revocationCanonicalPayload(rev),
        appId,
        effectiveRoomId,
        rootUserIds,
        clockSkewMs,
        verifyCertCached
      ))
    ) {
      failSig(fromPeerId)
      return {status: 'invalid'}
    }
    if (!certs.has(rev.issuerUserId)) {
      certs.set(rev.issuerUserId, rev.issuerCert)
    }
    rawRevocations.set(key, rev)
    revPairRoleCounts.set(pairKey, (revPairRoleCounts.get(pairKey) ?? 0) + 1)
    return {status: 'staged', key}
  }

  const stageBanInternal = async (
    ban: PeerBanRecord,
    fromPeerId?: string
  ): Promise<'staged' | 'duplicate' | 'invalid'> => {
    if (!validatePeerBanShape(ban) || isRootUid(ban.targetUserId)) {
      failSig(fromPeerId)
      return 'invalid'
    }
    const rawKey = banPairKey(ban)
    const prevRaw = rawBans.get(rawKey)
    if (
      prevRaw &&
      (prevRaw.sig === ban.sig ||
        compareModCausalOrder(prevRaw, 'ban', ban, 'ban') <= 0)
    ) {
      return 'duplicate'
    }
    if (!prevRaw && rawBans.size >= maxStoredModerationRecords) {
      return 'duplicate'
    }
    if (
      !(await verifyAdminRec(
        ban,
        banCanonicalPayload(ban),
        appId,
        effectiveRoomId,
        rootUserIds,
        clockSkewMs,
        verifyCertCached
      ))
    ) {
      failSig(fromPeerId)
      return 'invalid'
    }
    if (!certs.has(ban.issuerUserId)) {
      certs.set(ban.issuerUserId, ban.issuerCert)
    }
    rawBans.set(rawKey, ban)
    return 'staged'
  }

  const verifyAndApplyCert = (
    cert: RoleCertificate,
    fromPeerId?: string
  ): Promise<boolean> =>
    guardApply(
      async () => {
        const res = await stageCertInternal(cert, fromPeerId)
        if (res !== 'applied') {
          return false
        }
        syncLocalCert()
        return true
      },
      () => failSig(fromPeerId)
    )

  const verifyAndApplyRevocation = (
    rev: RoleRevocationRecord,
    fromPeerId?: string
  ): Promise<boolean> =>
    guardApply(
      async () => {
        const res = await stageRevocationInternal(rev, fromPeerId)
        if (res.status !== 'staged') {
          return false
        }
        const {effectiveRevKeys} = recomputeModerationState()
        if (!effectiveRevKeys.has(res.key)) {
          return failSig(fromPeerId)
        }
        return true
      },
      () => failSig(fromPeerId)
    )

  const verifyAndApplyBan = (
    ban: PeerBanRecord,
    fromPeerId?: string
  ): Promise<boolean> =>
    guardApply(
      async () => {
        const res = await stageBanInternal(ban, fromPeerId)
        if (res !== 'staged') {
          return false
        }
        const {effectiveBanSigs} = recomputeModerationState(fromPeerId)
        if (!effectiveBanSigs.has(ban.sig)) {
          if (
            bans.has(ban.targetUserId) &&
            getPeerRoles(ban.issuerUserId).includes('admin')
          ) {
            return false
          }
          return failSig(fromPeerId)
        }
        return true
      },
      () => failSig(fromPeerId)
    )

  const applySyncBatch = (
    batch: AuthSyncBatchInput,
    fromPeerId?: string,
    shouldAbort?: () => boolean
  ): Promise<AuthSyncBatchResult> =>
    guardApply(
      async () => {
        const appliedCerts: RoleCertificate[] = []
        const stagedRevs: Array<{rev: RoleRevocationRecord; key: string}> = []
        const stagedBans: PeerBanRecord[] = []

        for (const c of (batch.certs ?? []).slice(0, maxSyncCerts)) {
          if (shouldAbort?.()) {
            break
          }
          if ((await stageCertInternal(c, fromPeerId)) === 'applied') {
            appliedCerts.push(c)
          }
        }
        for (const r of (batch.revocations ?? []).slice(
          0,
          maxSyncModerationRecords
        )) {
          if (shouldAbort?.()) {
            break
          }
          const res = await stageRevocationInternal(r, fromPeerId)
          if (res.status === 'staged') {
            stagedRevs.push({rev: r, key: res.key})
          }
        }
        for (const b of (batch.bans ?? []).slice(0, maxSyncModerationRecords)) {
          if (shouldAbort?.()) {
            break
          }
          if ((await stageBanInternal(b, fromPeerId)) === 'staged') {
            stagedBans.push(b)
          }
        }

        if (stagedRevs.length > 0 || stagedBans.length > 0) {
          const {effectiveRevKeys, effectiveBanSigs} =
            recomputeModerationState(fromPeerId)
          return {
            certs: appliedCerts,
            revocations: stagedRevs
              .filter(item => effectiveRevKeys.has(item.key))
              .map(item => item.rev),
            bans: stagedBans.filter(b => effectiveBanSigs.has(b.sig))
          }
        }

        if (appliedCerts.length > 0) {
          syncLocalCert()
        }
        return {certs: appliedCerts, revocations: [], bans: []}
      },
      () => {
        failSig(fromPeerId)
        return {certs: [], revocations: [], bans: []}
      }
    )

  const getStateWriteCert = async (
    requiredRoles: readonly string[] | null,
    namespace: string
  ): Promise<{cert: RoleCertificate | null; roles: string[]}> => {
    await ensureResolved()
    const myRoles = getPeerRoles(selfId)
    if (!requiredRoles || requiredRoles.length === 0) {
      const cert =
        localCert && !bans.has(localCert.subUserId) && myRoles.length
          ? localCert
          : null
      return {cert, roles: myRoles}
    }
    if (!requiredRoles.some(r => myRoles.includes(r))) {
      throw mkErr(
        `${insufficientAuthPrefix} to update state "${namespace}": requires [${requiredRoles.join(', ')}]`
      )
    }
    if (!localCert || !localUser) {
      throw mkErr(`missing local role certificate for state "${namespace}"`)
    }
    return {cert: localCert, roles: myRoles}
  }

  const verifyStateRecordRoles = async (
    rec: AuthoritativeStateRecord,
    requiredRoles: readonly string[] | null,
    fromPeerId?: string
  ): Promise<{valid: boolean; roles: string[]}> => {
    await ensureResolved()
    if (isPeerBanned(rec.userId)) {
      return {valid: false, roles: []}
    }
    if (rec.cert) {
      if (
        !validateRoleCertificateShape(rec.cert) ||
        rec.cert.subUserId !== rec.userId ||
        rec.hlc < rec.cert.iat
      ) {
        failSig(fromPeerId)
        return {valid: false, roles: []}
      }
      const certRes = await verifyCertCached(rec.cert)
      if (!certRes.valid) {
        failSig(fromPeerId)
        return {valid: false, roles: []}
      }
      if (!certs.has(rec.userId)) {
        certs.set(rec.userId, rec.cert)
      }
      const roles = effectiveRoles(rec.cert)
      if (
        requiredRoles &&
        requiredRoles.length > 0 &&
        !requiredRoles.some(r => roles.includes(r))
      ) {
        return {valid: false, roles: []}
      }
      return {valid: true, roles}
    }
    if (requiredRoles && requiredRoles.length > 0) {
      return {valid: false, roles: []}
    }
    return {valid: true, roles: getPeerRoles(rec.userId)}
  }

  const verifyActionInternal = async (
    namespace: string,
    peerId: string,
    requiredRoles: readonly string[],
    data: DataPayload,
    wireMeta: JsonValue | undefined,
    isOffer: boolean
  ): Promise<{valid: boolean; userMetadata?: JsonValue; roles: string[]}> => {
    if (isPeerBanned(peerId)) {
      return {valid: false, roles: []}
    }
    if (!requiredRoles.length) {
      return {
        valid: true,
        ...(wireMeta === undefined ? {} : {userMetadata: wireMeta}),
        roles: getPeerRoles(peerId)
      }
    }
    await ensureResolved()
    if (!isObj(wireMeta) || !(authMetaKey in wireMeta)) {
      return {valid: false, roles: []}
    }
    const env = wireMeta[authMetaKey] as unknown as ActionAuthEnvelope
    if (!validateActionAuthShape(env) || isPeerBanned(env.userId)) {
      return {valid: false, roles: []}
    }
    const knownUid = peerToUserId.get(peerId) ?? init.getPeerUserId?.(peerId)
    const replayKey = `${peerId}\u0000${namespace}`
    const offerKey = `${replayKey}\u0000${env.seq}`
    let hasPreVerifiedOffer = false
    if (!isOffer) {
      const preSig = acceptedOffers.get(offerKey)
      if (preSig !== undefined && preSig === env.sig) {
        acceptedOffers.delete(offerKey)
        hasPreVerifiedOffer = true
      }
    }
    if (!hasPreVerifiedOffer && actionReplayWindow.has(replayKey, env.seq)) {
      return {valid: false, roles: []}
    }

    const res = await verifyActionAuth(env, {
      appId,
      roomId: effectiveRoomId,
      namespace,
      peerId,
      ...(knownUid !== undefined ? {expectedUserId: knownUid} : {}),
      data,
      requiredRoles,
      rootUserIds,
      skipDigestCheck: isOffer,
      skipSigCheck: hasPreVerifiedOffer,
      maxClockSkewMs: clockSkewMs,
      certVerifier: async cert => {
        const certRes = await verifyCertCached(cert)
        return certRes.valid
          ? {valid: true, roles: effectiveRoles(cert)}
          : certRes
      }
    })
    if (!res.valid || isPeerBanned(peerId) || isPeerBanned(env.userId)) {
      return {valid: false, roles: []}
    }

    if (isOffer) {
      if (!actionReplayWindow.record(replayKey, env.seq)) {
        return {valid: false, roles: []}
      }
      acceptedOffers.set(offerKey, env.sig)
    } else {
      if (
        !hasPreVerifiedOffer &&
        !actionReplayWindow.record(replayKey, env.seq)
      ) {
        return {valid: false, roles: []}
      }
      peerToUserId.set(peerId, env.userId)
      if (!certs.has(env.userId)) {
        certs.set(env.userId, env.cert)
      }
    }

    return {
      valid: true,
      ...(env.meta === undefined ? {} : {userMetadata: env.meta}),
      roles: res.roles
    }
  }

  const requireAdminSigner = async (errMsg: string, targetId: string) => {
    await ensureResolved()
    if (!getPeerRoles(selfId).includes('admin') || !localCert || !localUser) {
      throw mkErr(errMsg)
    }
    return {user: localUser, cert: localCert, targetUid: resolveUid(targetId)}
  }

  return {
    getEffectiveRoomId: () => effectiveRoomId,
    getAuthorityInfo: async () => {
      await ensureResolved()
      const roles = getPeerRoles(selfId)
      return {
        userId: localUser?.userId ?? resolveUid(selfId),
        roomId: effectiveRoomId,
        baseRoomId,
        isAdmin: roles.includes('admin'),
        roles
      }
    },
    getPeerRoles,
    isPeerBanned,
    getBanReason,
    registerPeerPublicKey,
    getStateWriteCert,
    verifyStateRecordRoles,
    verifyAndApplyCert,
    verifyAndApplyRevocation,
    verifyAndApplyBan,
    applySyncBatch,
    canPeerSendAction: (peerId, requiredRoles, inlineCert) => {
      if (isPeerBanned(peerId)) {
        return false
      }
      if (
        !requiredRoles.length ||
        requiredRoles.some(r => getPeerRoles(peerId).includes(r))
      ) {
        return true
      }
      if (!inlineCert) {
        return false
      }
      return verifyAndApplyCert(inlineCert, peerId).then(ok => {
        if (!ok) {
          return false
        }
        peerToUserId.set(peerId, inlineCert.subUserId)
        return requiredRoles.some(r => getPeerRoles(peerId).includes(r))
      })
    },
    signActionPayload: async (namespace, requiredRoles, data, userMeta) => {
      await ensureResolved()
      if (!requiredRoles.length) {
        return userMeta ?? null
      }
      if (!requiredRoles.some(r => getPeerRoles(selfId).includes(r))) {
        throw mkErr(
          `${insufficientAuthPrefix} for action "${namespace}": requires [${requiredRoles.join(', ')}]`
        )
      }
      if (!localCert || !localUser) {
        throw mkErr(`missing local role certificate for action "${namespace}"`)
      }
      const env = await signActionAuth(
        localUser.sign,
        localUser.signPubJwk,
        localCert,
        {
          appId,
          roomId: effectiveRoomId,
          namespace,
          peerId: selfId,
          userId: localUser.userId,
          seq: nextLocalActSeq(),
          data,
          ...(userMeta === undefined ? {} : {meta: userMeta})
        }
      )
      return {[authMetaKey]: env} as unknown as JsonValue
    },
    verifyActionOffer: (ns, peerId, reqRoles, wireMeta) =>
      verifyActionInternal(ns, peerId, reqRoles, '', wireMeta, true),
    verifyActionPayload: (ns, peerId, reqRoles, data, wireMeta) =>
      verifyActionInternal(ns, peerId, reqRoles, data, wireMeta, false),
    buildPullMessage: async () => {
      await ensureResolved()
      if (!localUser) {
        return null
      }
      const s: string[] = []
      for (const c of [...certs.values()].slice(0, maxSyncCerts)) {
        s.push(c.sig.slice(0, 8))
      }
      for (const r of [...rawRevocations.values()].slice(
        0,
        maxSyncModerationRecords
      )) {
        s.push(r.sig.slice(0, 8))
      }
      for (const b of [...rawBans.values()].slice(
        0,
        maxSyncModerationRecords
      )) {
        s.push(b.sig.slice(0, 8))
      }
      return {
        t: 'pull' as const,
        pubKey: localUser.signPubJwk,
        ...(s.length ? {s} : {})
      }
    },
    buildDiffSyncMessage: async knownSigs => {
      await ensureResolved()
      const known = new Set(
        Array.isArray(knownSigs)
          ? knownSigs.filter((x): x is string => typeof x === 'string')
          : []
      )
      const outCerts = [...certs.values()]
        .slice(0, maxSyncCerts)
        .filter(c => !known.has(c.sig.slice(0, 8)))
      const outRevs = [...rawRevocations.values()]
        .slice(0, maxSyncModerationRecords)
        .filter(r => !known.has(r.sig.slice(0, 8)))
      const outBans = [...rawBans.values()]
        .slice(0, maxSyncModerationRecords)
        .filter(b => !known.has(b.sig.slice(0, 8)))
      return outCerts.length || outRevs.length || outBans.length
        ? {
            t: 'sync' as const,
            ...(outCerts.length ? {certs: outCerts} : {}),
            ...(outRevs.length ? {revocations: outRevs} : {}),
            ...(outBans.length ? {bans: outBans} : {})
          }
        : null
    },
    issueRoleCertificate: async (targetId, role) => {
      await ensureResolved()
      const rolesToGrant = (Array.isArray(role) ? role : [role]).filter(Boolean)
      if (!rolesToGrant.length) {
        throw mkErr('grantRole requires at least one non-empty role name')
      }
      if (!localUser || !isRootUid(localUser.userId)) {
        throw mkErr(
          `${insufficientAuthPrefix} to grant role [${rolesToGrant.join(', ')}]`
        )
      }
      const targetUserId = resolveUid(targetId)
      if (isRootUid(targetUserId) && !rolesToGrant.includes('admin')) {
        throw rootAdminProtectErr('authority', 'demote')
      }
      let minTs = certs.get(targetUserId)?.iat ?? 0
      for (const r of revocations.get(targetUserId) ?? []) {
        if (r.ts > minTs) {
          minTs = r.ts
        }
      }
      const cert = await signRoleCertificate(
        localUser.sign,
        localUser.signPubJwk,
        {
          subUserId: targetUserId,
          appId,
          roomId: effectiveRoomId,
          roles: rolesToGrant,
          now: clock.next(minTs + 1)
        }
      )
      await verifyAndApplyCert(cert)
      return cert
    },
    issueRoleRevocation: async (targetId, role) => {
      const {user, cert, targetUid} = await requireAdminSigner(
        `${insufficientAuthPrefix} to revoke role`,
        targetId
      )
      if (
        isRootUid(targetUid) &&
        (!isRootUid(user.userId) || !role || role === '*' || role === 'admin')
      ) {
        throw rootAdminProtectErr('authority', 'revoke')
      }
      const tc = certs.get(targetUid)
      const rev = await signRoleRevocation(user.sign, user.signPubJwk, cert, {
        appId,
        roomId: effectiveRoomId,
        issuerUserId: user.userId,
        targetUserId: targetUid,
        ...(tc ? {targetCertId: tc.certId} : {}),
        ...(role ? {role} : {}),
        seq: ++localModSeq,
        ts: clock.next(Math.max(cert.iat, tc?.iat ?? 0))
      })
      await verifyAndApplyRevocation(rev)
      return rev
    },
    issuePeerBan: async (targetId, options) => {
      const {user, cert, targetUid} = await requireAdminSigner(
        `${insufficientAuthPrefix}: only an admin can ban a peer`,
        targetId
      )
      if (isRootUid(targetUid)) {
        throw rootAdminProtectErr('ban', 'ban')
      }
      const ban = await signPeerBan(user.sign, user.signPubJwk, cert, {
        appId,
        roomId: effectiveRoomId,
        issuerUserId: user.userId,
        targetUserId: targetUid,
        ...(options?.reason ? {reason: options.reason} : {}),
        seq: ++localModSeq,
        ts: clock.next(cert.iat)
      })
      await verifyAndApplyBan(ban)
      return ban
    }
  }
}

export const roles = (
  config?: RolesConfig
): RoomPlugin<'roles', RolesPluginApi> & {selfAsAdmin?: boolean} => {
  const normalized = normalizeRolesConfig(config)
  const setupInternal = (
    kernel: InternalRoomContext,
    preResolvedState?: unknown,
    getPreResolvedState?: () => unknown
  ): RolesPluginApi => {
    const authFailures = createWindowCounter(512, 8)
    const authSyncQuota = createWindowCounter(512, 24)
    const sentPullPeers = new Set<string>()

    const recordPeerAuthFailure = (fromPeerId?: string) => {
      kernel.getInternalScaleProvider()?.recordSignatureFailure()
      if (!fromPeerId || fromPeerId === kernel.selfId) {
        return
      }
      if (authFailures.hit(fromPeerId)) {
        const err = mkErr('excessive invalid authority records')
        kernel.emitError({
          code: 'peer-error',
          peerId: fromPeerId,
          message: err.message,
          cause: err
        })
        kernel.kickPeer(fromPeerId, err)
      }
    }

    const rawAuth = kernel.makeInternalAction<JsonValue>('auth', {
      maxPayloadBytes: 256 * 1024
    })
    const sendAuth = (msg: AuthControlMessage, targets?: TargetPeers) =>
      rawAuth.send(msg as unknown as JsonValue, targets)
    let didReportSelfBan = false

    const authority = createRoomAuthority({
      selfId: kernel.selfId,
      appId: kernel.appId,
      initialRoomId: kernel.getRoomId(),
      ...(kernel.effectiveRoomIdP === undefined
        ? {}
        : {effectiveRoomIdP: kernel.effectiveRoomIdP}),
      getPreResolvedState: () =>
        (getPreResolvedState?.() ?? preResolvedState) as
          | RoomAuthorityPreResolvedState
          | undefined,
      admin: normalized,
      getLocalUserIdentity: () => kernel.getLocalUserIdentity(),
      isOverlayPeerBanned: pid =>
        kernel.getInternalScaleProvider()?.isPeerBanned(pid) ?? false,
      getPeerUserId: pid => kernel.getKnownPeerUserId(pid),
      onRoomIdResolved: id => kernel.setEffectiveRoomId(id),
      onPeerPublicKey: (pid, _key, uid) => {
        if (uid) {
          kernel.setPeerUserId(pid, uid)
        }
      },
      onLocalRoleCertificate: cert =>
        kernel.getInternalScaleProvider()?.setLocalRoleCertificate(cert),
      onPeerBanned: (bannedUid, banRec, fromPeerId) => {
        const localUid = kernel.getKnownPeerUserId(kernel.selfId)
        if (
          bannedUid === kernel.selfId ||
          (localUid && bannedUid === localUid)
        ) {
          if (!didReportSelfBan) {
            didReportSelfBan = true
            kernel.emitError({
              code: 'banned',
              message: banRec.reason
                ? `${peerBannedMsg}: ${banRec.reason}`
                : peerBannedMsg,
              ...(banRec.reason !== undefined ? {reason: banRec.reason} : {}),
              ...(fromPeerId ? {peerId: fromPeerId} : {})
            })
          }
          return
        }
        kernel.purgeBannedUserState(bannedUid)
        kernel.getInternalScaleProvider()?.markPeerBanned(bannedUid)
        const toKick = new Set<string>(kernel.getUserPeerIds(bannedUid))
        for (const pid of kernel.getAllPeerIds()) {
          if (authority.isPeerBanned(pid)) {
            toKick.add(pid)
          }
        }
        const activeKickTargets = [...toKick].filter(pid =>
          kernel.isPeerActive(pid)
        )
        if (activeKickTargets.length > 0) {
          void sendAuth({t: 'ban', ban: banRec}, activeKickTargets).catch(noOp)
        }
        for (const pid of toKick) {
          kernel.getInternalScaleProvider()?.markPeerBanned(pid)
          kernel.kickPeer(pid, peerBannedErr)
        }
      },
      onSignatureFailure: recordPeerAuthFailure
    })

    const sendPull = async (peerId: string) => {
      if (
        sentPullPeers.has(peerId) ||
        !kernel.isPeerActive(peerId) ||
        authority.isPeerBanned(peerId)
      ) {
        return
      }
      sentPullPeers.add(peerId)
      const payload = await authority.buildPullMessage()
      if (
        payload &&
        kernel.isPeerActive(peerId) &&
        !authority.isPeerBanned(peerId)
      ) {
        void sendAuth(payload, peerId).catch(noOp)
      }
    }

    rawAuth.onMessage((raw, fromPeerId) => {
      const msg = raw as unknown as AuthControlMessage
      if (
        !isObj(msg) ||
        authority.isPeerBanned(fromPeerId) ||
        authFailures.over(fromPeerId)
      ) {
        return
      }
      if (msg.t === 'pull') {
        if (authSyncQuota.hit(fromPeerId)) {
          return
        }
        if (msg.pubKey) {
          authority.registerPeerPublicKey(fromPeerId, msg.pubKey)
        }
        if (
          Array.isArray(msg.s) &&
          msg.s.length > maxSyncCerts + maxSyncModerationRecords * 2
        ) {
          recordPeerAuthFailure(fromPeerId)
          return
        }
        if (!sentPullPeers.has(fromPeerId)) {
          void sendPull(fromPeerId)
        }
        void authority.buildDiffSyncMessage(msg.s).then(diff => {
          if (
            diff &&
            kernel.isPeerActive(fromPeerId) &&
            !authority.isPeerBanned(fromPeerId)
          ) {
            void sendAuth(diff, fromPeerId).catch(noOp)
          }
        })
      } else if (msg.t === 'sync') {
        if (authSyncQuota.hit(fromPeerId)) {
          return
        }
        if (msg.pubKey) {
          authority.registerPeerPublicKey(fromPeerId, msg.pubKey)
        }
        if (
          (Array.isArray(msg.certs) && msg.certs.length > maxSyncCerts) ||
          (Array.isArray(msg.revocations) &&
            msg.revocations.length > maxSyncModerationRecords) ||
          (Array.isArray(msg.bans) &&
            msg.bans.length > maxSyncModerationRecords)
        ) {
          recordPeerAuthFailure(fromPeerId)
        }
        void authority
          .applySyncBatch(
            {
              ...(Array.isArray(msg.certs) ? {certs: msg.certs} : {}),
              ...(Array.isArray(msg.revocations)
                ? {revocations: msg.revocations}
                : {}),
              ...(Array.isArray(msg.bans) ? {bans: msg.bans} : {})
            },
            fromPeerId,
            () => authFailures.over(fromPeerId)
          )
          .then(({certs, revocations, bans}) => {
            if (!certs.length && !revocations.length && !bans.length) {
              return
            }
            const directOthers = kernel
              .getDirectActivePeerIds()
              .filter(id => id !== fromPeerId && !authority.isPeerBanned(id))
            if (directOthers.length > 0) {
              void sendAuth(
                {
                  t: 'sync',
                  ...(certs.length ? {certs} : {}),
                  ...(revocations.length ? {revocations} : {}),
                  ...(bans.length ? {bans} : {})
                },
                directOthers
              ).catch(noOp)
            }
          })
      } else if (msg.t === 'cert') {
        void authority.verifyAndApplyCert(msg.cert, fromPeerId)
      } else if (msg.t === 'revoke') {
        void authority.verifyAndApplyRevocation(msg.revocation, fromPeerId)
      } else if (msg.t === 'ban') {
        void authority.verifyAndApplyBan(msg.ban, fromPeerId)
      }
    })

    kernel.registerRolesProvider({
      ...authority,
      onPeerDescriptorCert: (pid, _key, cert, uid) => {
        if (
          authority.isPeerBanned(pid) ||
          (uid && authority.isPeerBanned(uid))
        ) {
          kernel.getInternalScaleProvider()?.markPeerBanned(pid)
          kernel.kickPeer(pid, peerBannedErr)
        } else if (cert) {
          void authority.verifyAndApplyCert(cert, pid)
        }
      }
    })

    kernel.onPeerActivated(pid => void sendPull(pid), {replay: true})
    kernel.onPeerDeactivated(pid => {
      sentPullPeers.delete(pid)
    })

    return {
      grantRole: async (id, role) => {
        const cert = await authority.issueRoleCertificate(id, role)
        await sendAuth({t: 'cert', cert}).catch(noOp)
        return cert
      },
      revokeRole: async (id, role) => {
        const revocation = await authority.issueRoleRevocation(id, role)
        await sendAuth({t: 'revoke', revocation}).catch(noOp)
      },
      getRoles: id => authority.getPeerRoles(id ?? kernel.selfId),
      ban: async (id, opts) => {
        const ban = await authority.issuePeerBan(id, opts)
        await sendAuth({t: 'ban', ban}).catch(noOp)
      },
      isBanned: id => authority.isPeerBanned(id)
    }
  }

  const basePlugin = definePlugin<'roles', RolesPluginApi>('roles', {
    resolveRoomId: async ({roomId, userIdentityP}) => {
      const parsed = parseSelfCertifyingRoomId(roomId)
      if (parsed.userId) {
        return {
          effectiveRoomId: roomId,
          state: {
            adminUserId: parsed.userId,
            baseRoomId: parsed.baseRoomId
          } satisfies RoomAuthorityPreResolvedState
        }
      }
      if (normalized.selfAsAdmin && userIdentityP) {
        const user = await userIdentityP
        return {
          effectiveRoomId: formatSelfCertifyingRoomId(roomId, user.userId),
          state: {
            adminUserId: user.userId,
            baseRoomId: roomId
          } satisfies RoomAuthorityPreResolvedState
        }
      }
      return {effectiveRoomId: roomId}
    },
    setup: () => {
      throw mkErr('roles() must be registered via joinRoom({use: [roles()]})')
    }
  })
  const plugin: RoomPlugin<'roles', RolesPluginApi> & {selfAsAdmin?: boolean} =
    normalized.selfAsAdmin ? {...basePlugin, selfAsAdmin: true} : basePlugin
  Object.defineProperty(plugin, internalPluginSymbol, {
    value: {
      kind: 'roles' as const,
      selfAsAdmin: Boolean(normalized.selfAsAdmin),
      setup: setupInternal
    },
    enumerable: false
  })
  return plugin
}
