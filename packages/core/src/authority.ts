import {sha256} from './crypto'
import {getVerifiedPubKeyRecord, isValidUserId} from './identity'
import {
  canonTag,
  createMonotonicClock,
  createSlidingReplayWindow,
  defaultMaxClockSkewMs,
  getSignerClock,
  invalidRoles,
  isValidJwk,
  roleCertPayload,
  signRoleCertInternal,
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
  cmpStr,
  createBoundedCache,
  createWindowCounter,
  encodeBytes,
  insufficientAuthPrefix,
  isObj,
  isPosSafeInt,
  isSelfAsAdminPlugin,
  isStr,
  isValidSig,
  keys,
  makeInternalPlugin,
  mkBannedErr,
  mkErr,
  noOp,
  peerBannedErr,
  selfCertifyingRoomRegex,
  toBase64Url,
  toJson,
  toPayloadSource,
  validateRoleCertificateShape
} from './utils'

export {
  compareStateRecords,
  isSelfAsAdminPlugin,
  roleCertPayload,
  signRoleCertificate,
  signStateRecord,
  validateRoleCertificateShape,
  validateStateRecordShape,
  verifyRoleCertificate,
  verifyRoleCertificateChain,
  type CertSignParams,
  type StateSignParams,
  type StateSigner
}

type Signer = StateSigner

const digestChunkBytes = 256 * 1024
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
const hasAnyRole = (held: readonly string[], req: readonly string[]): boolean =>
  req.some(r => held.includes(r))
const sig8 = (x: {sig: string}): string => x.sig.slice(0, 8)
const takeMap = <T>(m: Map<string, T>, max: number): T[] =>
  [...m.values()].slice(0, max)

export type ActionAuthEnvelope = {
  v: 1
  appId: string
  roomId: string
  namespace: string
  peerId: string
  userId: string
  seq: number
  digest: string
  cert: RoleCertificate
  signerPubKey: JsonWebKey
  sig: string
  meta?: JsonValue
}

const packDigest = async (
  tag: number,
  body: Uint8Array,
  metaB?: Uint8Array
): Promise<string> => {
  const out = new Uint8Array(
    body.byteLength + (metaB ? 5 + metaB.byteLength : 1)
  )
  out[0] = metaB ? tag | 0x80 : tag
  out.set(body, 1)
  if (metaB) {
    new DataView(out.buffer, 1 + body.byteLength, 4).setUint32(
      0,
      metaB.byteLength,
      false
    )
    out.set(metaB, 5 + body.byteLength)
  }
  return toBase64Url(await sha256(out))
}

export const computePayloadDigest = async (
  data: DataPayload,
  meta?: JsonValue
): Promise<string> => {
  const metaB = meta === undefined ? undefined : encodeBytes(toJson(meta))
  const [fmt, src] = toPayloadSource(data)
  const tag = fmt === 0 ? 1 : fmt === 2 ? 2 : 3
  const isU8 = src instanceof Uint8Array
  const totalLen = isU8 ? src.byteLength : src.size
  if (tag !== 2 || totalLen <= digestChunkBytes) {
    return packDigest(
      tag,
      isU8 ? src : new Uint8Array(await src.arrayBuffer()),
      metaB
    )
  }
  const nChunks = Math.ceil(totalLen / digestChunkBytes)
  const body = new Uint8Array(8 + nChunks * 32)
  new DataView(body.buffer).setBigUint64(0, BigInt(totalLen), false)
  for (let i = 0, off = 0; off < totalLen; i++, off += digestChunkBytes) {
    const end = Math.min(off + digestChunkBytes, totalLen)
    const part = isU8
      ? src.subarray(off, end)
      : new Uint8Array(await src.slice(off, end).arrayBuffer())
    body.set(await sha256(part as BufferSource), 8 + i * 32)
  }
  return packDigest(0x04, body, metaB)
}

export const actionAuthPayload = (
  e: Omit<ActionAuthEnvelope, 'sig' | 'meta'>
): string =>
  canonTag('action-auth', [
    e.v,
    e.appId,
    e.roomId,
    e.namespace,
    e.peerId,
    e.userId,
    e.seq,
    e.digest,
    e.cert.sig
  ])

export const validateActionAuthShape = (e: unknown): e is ActionAuthEnvelope =>
  isObj(e) &&
  e['v'] === 1 &&
  hasStrs(e, ['appId', 'roomId', 'namespace', 'peerId', 'userId', 'digest']) &&
  isPosSafeInt(e['seq']) &&
  validateRoleCertificateShape(e['cert']) &&
  isValidJwk(e['signerPubKey']) &&
  isValidSig(e['sig'])

export type ActionSignParams = {
  appId: string
  roomId: string
  namespace: string
  peerId: string
  userId?: string
  seq: number
  data: DataPayload
  meta?: JsonValue
}

const signActionAuthInternal = async (
  signer: StateSigner,
  pubJwk: JsonWebKey,
  cert: RoleCertificate,
  appId: string,
  roomId: string,
  namespace: string,
  peerId: string,
  userId: string,
  seq: number,
  data: DataPayload,
  meta?: JsonValue
): Promise<ActionAuthEnvelope> => {
  const u: Omit<ActionAuthEnvelope, 'sig'> = {
    v: 1,
    appId,
    roomId,
    namespace,
    peerId,
    userId,
    seq,
    digest: await computePayloadDigest(data, meta),
    cert,
    signerPubKey: toCleanJwk(pubJwk),
    ...(meta === undefined ? {} : {meta})
  }
  return {...u, sig: await signWith(signer, actionAuthPayload(u))}
}

export const signActionAuth = (
  signer: StateSigner,
  pubJwk: JsonWebKey,
  cert: RoleCertificate,
  p: ActionSignParams
): Promise<ActionAuthEnvelope> =>
  signActionAuthInternal(
    signer,
    pubJwk,
    cert,
    p.appId,
    p.roomId,
    p.namespace,
    p.peerId,
    p.userId ?? cert.subUserId,
    p.seq,
    p.data,
    p.meta
  )

export type ActionVerifyParams = {
  appId: string
  roomId: string
  namespace: string
  peerId: string
  expectedUserId?: string
  data: DataPayload
  requiredRoles: readonly string[]
  rootUserIds: Set<string>
  skipDigestCheck?: boolean
  skipSigCheck?: boolean
  maxClockSkewMs?: number
  certVerifier?: (
    cert: RoleCertificate
  ) => Promise<{valid: boolean; roles: string[]}>
}

const verifyActionAuthInternal = async (
  env: ActionAuthEnvelope,
  appId: string,
  roomId: string,
  namespace: string,
  peerId: string,
  expectedUserId: string | undefined,
  data: DataPayload,
  requiredRoles: readonly string[],
  skipDigestCheck: boolean | undefined,
  skipSigCheck: boolean | undefined,
  certVerifier: (
    cert: RoleCertificate
  ) => Promise<{valid: boolean; roles: string[]}>
): Promise<{valid: boolean; roles: string[]}> => {
  if (
    env.appId !== appId ||
    env.roomId !== roomId ||
    env.namespace !== namespace ||
    env.peerId !== peerId ||
    env.cert.subUserId !== env.userId ||
    (expectedUserId !== undefined && env.userId !== expectedUserId)
  ) {
    return invalidRoles()
  }
  if (!skipSigCheck) {
    const signer = await getVerifiedPubKeyRecord(env.signerPubKey)
    if (!signer || signer[6] !== env.userId) {
      return invalidRoles()
    }
  }
  const certRes = await certVerifier(env.cert)
  if (!certRes.valid || !hasAnyRole(certRes.roles, requiredRoles)) {
    return invalidRoles()
  }
  if (
    !skipDigestCheck &&
    (await computePayloadDigest(data, env.meta)) !== env.digest
  ) {
    return invalidRoles()
  }
  if (
    !skipSigCheck &&
    !(await verifySig(env.signerPubKey, actionAuthPayload(env), env.sig))
  ) {
    return invalidRoles()
  }
  return {valid: true, roles: certRes.roles}
}

export const verifyActionAuth = (
  env: ActionAuthEnvelope,
  p: ActionVerifyParams
): Promise<{valid: boolean; roles: string[]}> =>
  validateActionAuthShape(env)
    ? verifyActionAuthInternal(
        env,
        p.appId,
        p.roomId,
        p.namespace,
        p.peerId,
        p.expectedUserId,
        p.data,
        p.requiredRoles,
        p.skipDigestCheck,
        p.skipSigCheck,
        p.certVerifier ??
          (cert =>
            verifyRoleCertificate(
              cert,
              p.appId,
              p.roomId,
              p.rootUserIds,
              p.maxClockSkewMs
            ))
      )
    : Promise.resolve(invalidRoles())

const rootAdminProtectErr = (scope: string, verb: string) =>
  mkErr(`${scope}: cannot ${verb} a root admin`)

const splitSelfCertRoom = (
  roomId: string
): readonly [base: string, uid: string | null] => {
  const m = selfCertifyingRoomRegex.exec(roomId)
  return m?.[1] && m[2] ? [m[1], m[2]] : [roomId, null]
}

export const parseSelfCertifyingRoomId = (
  roomId: string
): {baseRoomId: string; userId: string | null} => {
  const [baseRoomId, userId] = splitSelfCertRoom(roomId)
  return {baseRoomId, userId}
}

export const formatSelfCertifyingRoomId = (
  base: string,
  userId: string
): string => `${splitSelfCertRoom(base)[0]}~${userId}`

const normalizeRolesConfig = (config?: RolesConfig): RolesConfig => {
  if (!isObj(config)) {
    return {}
  }
  for (const k of keys(config)) {
    if (k !== 'selfAsAdmin' && k !== 'admins') {
      throw mkErr(`Unknown roles config option "${k}"`)
    }
  }
  let admins: string[] | undefined
  if (config.admins !== undefined) {
    if (!Array.isArray(config.admins)) {
      throw mkErr('roles admins must be an array of userIds')
    }
    admins = config.admins.map(raw => {
      const entry = isStr(raw) ? raw.trim() : ''
      if (!isValidUserId(entry)) {
        throw mkErr(
          `invalid admin userId "${String(raw)}"; expected a 22-character Base62 userId`
        )
      }
      return entry
    })
    if (!admins.length) {
      admins = undefined
    }
  }
  return {
    ...(config.selfAsAdmin ? {selfAsAdmin: true} : {}),
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
  appId: string,
  roomId: string,
  issuerUserId: string,
  targetUserId: string,
  extra: Record<string, unknown>,
  seq: number,
  ts: number,
  canon: (u: Omit<T, 'sig'>) => string
): Promise<T> => {
  const u = {
    v: 1 as const,
    appId,
    roomId,
    issuerUserId,
    targetUserId,
    ...extra,
    seq,
    ts,
    issuerCert: cert,
    signerPubKey: toCleanJwk(pubJwk)
  } as unknown as Omit<T, 'sig'>
  return {...u, sig: await signWith(signer, canon(u))} as T
}

const resolveModSignTs = (
  signer: Signer,
  cert: RoleCertificate,
  p: AdminSignParams
): number =>
  p.ts ?? p.now ?? getSignerClock(signer)[2](Math.max(cert.iat, p.minTs ?? 0))

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
    p.appId,
    p.roomId,
    p.issuerUserId ?? cert.subUserId,
    p.targetUserId,
    {
      ...(p.targetCertId ? {targetCertId: p.targetCertId} : {}),
      ...(p.role ? {role: p.role} : {})
    },
    p.seq,
    resolveModSignTs(signer, cert, p),
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
    p.appId,
    p.roomId,
    p.issuerUserId ?? cert.subUserId,
    p.targetUserId,
    p.reason ? {reason: p.reason} : {},
    p.seq,
    resolveModSignTs(signer, cert, p),
    banCanonicalPayload
  )

const verifyAdminRec = async (
  rec: RoleRevocationRecord | PeerBanRecord,
  payload: string,
  appId: string,
  roomId: string,
  clockSkewMs: number,
  certVerifier: (
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
  if (!signer || signer[6] !== rec.issuerUserId) {
    return false
  }
  const certRes = await certVerifier(rec.issuerCert)
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
    clockSkewMs,
    cert => verifyRoleCertificate(cert, appId, roomId, rootUserIds, clockSkewMs)
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
    clockSkewMs,
    cert => verifyRoleCertificate(cert, appId, roomId, rootUserIds, clockSkewMs)
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
    (!requiredRoles.length || hasAnyRole(certRes.roles, requiredRoles))
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

const mkSyncMsg = (
  certs: RoleCertificate[],
  revocations: RoleRevocationRecord[],
  bans: PeerBanRecord[]
): AuthSyncMessage | null =>
  certs.length || revocations.length || bans.length
    ? {
        t: 'sync',
        ...(certs.length ? {certs} : {}),
        ...(revocations.length ? {revocations} : {}),
        ...(bans.length ? {bans} : {})
      }
    : null

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
  aIsBan: boolean,
  b: Pick<
    RoleRevocationRecord | PeerBanRecord,
    'ts' | 'seq' | 'issuerUserId' | 'targetUserId' | 'sig'
  >,
  bIsBan: boolean
): number =>
  a.ts - b.ts ||
  a.seq - b.seq ||
  (aIsBan === bIsBan ? 0 : aIsBan ? -1 : 1) ||
  cmpStr(a.issuerUserId, b.issuerUserId) ||
  cmpStr(a.targetUserId, b.targetUserId) ||
  cmpStr(a.sig, b.sig)

const initRoomAuthority = (
  selfId: string,
  appId: string,
  initialRoomId: string,
  effectiveRoomIdP: Promise<string> | undefined,
  getPreState:
    | (() => readonly [base: string, uid: string] | undefined)
    | undefined,
  admin: RolesConfig,
  getLocalUserIdentity: (() => Promise<UserIdentity>) | undefined,
  isOverlayPeerBanned: ((peerId: string) => boolean) | undefined,
  getPeerUserId: ((peerId: string) => string | undefined) | undefined,
  onRoomIdResolved: ((effectiveRoomId: string) => void) | undefined,
  onPeerPublicKey:
    | ((peerId: string, pubKey: JsonWebKey, userId?: string) => void)
    | undefined,
  onLocalRoleCertificate: ((cert: RoleCertificate | null) => void) | undefined,
  onPeerBanned:
    | ((userId: string, banRecord: PeerBanRecord, fromPeerId?: string) => void)
    | undefined,
  onSignatureFailure: ((fromPeerId?: string) => void) | undefined
): readonly [
  providerBase: Omit<KernelRolesProvider, 'onPeerDescriptorCert'>,
  verifyAndApplyCert: RoomAuthority['verifyAndApplyCert'],
  verifyAndApplyRevocation: RoomAuthority['verifyAndApplyRevocation'],
  verifyAndApplyBan: RoomAuthority['verifyAndApplyBan'],
  applySyncBatchTuple: (
    certsIn?: unknown,
    revsIn?: unknown,
    bansIn?: unknown,
    fromPeerId?: string,
    shouldAbort?: () => boolean
  ) => Promise<
    readonly [
      certs: RoleCertificate[],
      revocations: RoleRevocationRecord[],
      bans: PeerBanRecord[]
    ]
  >,
  buildPullMessage: RoomAuthority['buildPullMessage'],
  buildDiffSyncMessage: RoomAuthority['buildDiffSyncMessage'],
  issueRoleCertificate: RoomAuthority['issueRoleCertificate'],
  issueRoleRevocation: RoomAuthority['issueRoleRevocation'],
  issuePeerBan: RoomAuthority['issuePeerBan']
] => {
  const clockSkewMs = defaultMaxClockSkewMs
  const [, , nextClock] = createMonotonicClock()
  const certs = new Map<string, RoleCertificate>()
  let revocations = new Map<string, RoleRevocationRecord[]>()
  const rawRevocations = new Map<string, RoleRevocationRecord>()
  const revPairRoleCounts = new Map<string, number>()
  let bans = new Map<string, PeerBanRecord>()
  const rawBans = new Map<string, PeerBanRecord>()
  const peerToUserId = new Map<string, string>()
  const [hasActionReplay, recordActionReplay] = createSlidingReplayWindow(
    2_048,
    undefined,
    actionReplayWindowBits
  )
  const acceptedOffers = createBoundedCache<string, string>(512)
  const verifiedCertCache = createBoundedCache<string, string[]>(512)

  let localCert: RoleCertificate | null = null
  let localModSeq = 0
  let localActSeq = 0
  let didSyncActSeqFloor = false
  let effectiveRoomId = initialRoomId
  let baseRoomId = initialRoomId
  let roomAdminUserId: string | null = null
  const rootUserIds = new Set<string>(admin.admins)
  let localUser: UserIdentity | null = null
  const syncRoomIds = (rid: string): void => {
    const pre = getPreState?.()
    const [base, uid] = splitSelfCertRoom(rid)
    baseRoomId = pre?.[0] ?? base
    const adminUid = pre?.[1] || uid
    if (adminUid) {
      roomAdminUserId = adminUid
      rootUserIds.add(adminUid)
    }
  }
  syncRoomIds(initialRoomId)

  const cacheIssuerCert = (uid: string, cert: RoleCertificate): void => {
    if (!certs.has(uid)) {
      certs.set(uid, cert)
    }
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
    onSignatureFailure?.(fromPeerId),
    false
  )
  const resolveUid = (id = selfId): string =>
    id === selfId && localUser
      ? localUser.userId
      : (peerToUserId.get(id) ?? getPeerUserId?.(id) ?? id)

  const candidateUids = (id = selfId): string[] => {
    const s = new Set<string>([resolveUid(id), id])
    const mapped = getPeerUserId?.(id)
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
        onLocalRoleCertificate?.(null)
      }
      return
    }
    if (localCert?.sig !== stored.sig) {
      localCert = stored
      onLocalRoleCertificate?.(stored)
    }
  }

  const recomputeModerationState = (
    fromPeerId?: string
  ): readonly [
    effectiveRevKeys: Set<string>,
    effectiveBanSigs: Set<string>
  ] => {
    const prevBannedUids = new Set(bans.keys())
    const events: Array<
      [rec: PeerBanRecord | RoleRevocationRecord, isBan: boolean]
    > = [
      ...[...rawBans.values()].map((b): [PeerBanRecord, boolean] => [b, true]),
      ...[...rawRevocations.values()].map(
        (r): [RoleRevocationRecord, boolean] => [r, false]
      )
    ].sort((a, b) => compareModCausalOrder(a[0], a[1], b[0], b[1]))

    const nextRevocations = new Map<string, RoleRevocationRecord[]>()
    const nextBans = new Map<string, PeerBanRecord>()
    const effectiveRevKeys = new Set<string>()
    const effectiveBanSigs = new Set<string>()

    const hasAdminAtEvent = (cert: RoleCertificate): boolean => {
      const uid = cert.subUserId
      return (
        isRootUid(uid) ||
        (!nextBans.has(uid) &&
          effectiveRolesFromMap(cert, nextRevocations).includes('admin'))
      )
    }

    for (const [rec, isBan] of events) {
      if (!hasAdminAtEvent(rec.issuerCert)) {
        continue
      }
      if (isBan) {
        if (!isRootUid(rec.targetUserId) && !nextBans.has(rec.targetUserId)) {
          nextBans.set(rec.targetUserId, rec as PeerBanRecord)
          effectiveBanSigs.add(rec.sig)
        }
      } else if (canIssuerRevokeTarget(rec as RoleRevocationRecord)) {
        const r = rec as RoleRevocationRecord
        const list = nextRevocations.get(r.targetUserId) ?? []
        list.push(r)
        nextRevocations.set(r.targetUserId, list)
        effectiveRevKeys.add(revContentKey(r))
      }
    }

    revocations = nextRevocations
    bans = nextBans
    syncLocalCert()

    for (const [bannedUid, banRec] of bans) {
      if (!prevBannedUids.has(bannedUid)) {
        onPeerBanned?.(bannedUid, banRec, fromPeerId)
      }
    }

    return [effectiveRevKeys, effectiveBanSigs]
  }

  const isCertHeaderValid = (cert: unknown): cert is RoleCertificate =>
    validateRoleCertificateShape(cert) &&
    cert.appId === appId &&
    cert.roomId === effectiveRoomId &&
    cert.iat <= Date.now() + clockSkewMs

  const certCacheKey = (c: RoleCertificate): string =>
    `${roleCertPayload(c)}\u0000${c.sig}`

  const verifyCertCached = async (
    cert: RoleCertificate
  ): Promise<{valid: boolean; roles: string[]}> => {
    if (!isCertHeaderValid(cert)) {
      return invalidRoles()
    }
    const cacheKey = certCacheKey(cert)
    const cachedRoles = verifiedCertCache.get(cacheKey)
    if (cachedRoles) {
      return {valid: true, roles: [...cachedRoles]}
    }
    const iss = await getVerifiedPubKeyRecord(cert.issuerPubKey)
    if (
      !iss ||
      !rootUserIds.has(iss[6]) ||
      !(await verifySig(cert.issuerPubKey, roleCertPayload(cert), cert.sig))
    ) {
      return invalidRoles()
    }
    const roles = [...cert.roles]
    verifiedCertCache.set(cacheKey, [...roles])
    return {valid: true, roles}
  }

  const nonRootUids = (id: string): string[] | null => {
    const uids = candidateUids(id)
    return uids.some(isRootUid) ? null : uids
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
    const uids = nonRootUids(peerOrUserId)
    return Boolean(
      uids &&
      (isOverlayPeerBanned?.(peerOrUserId) || uids.some(uid => bans.has(uid)))
    )
  }

  const getBanReason = (peerOrUserId: string): string | undefined => {
    for (const uid of nonRootUids(peerOrUserId) ?? []) {
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
      const [, , cleanJwk, , , , uid] = rec
      peerToUserId.set(peerId, uid)
      onPeerPublicKey?.(peerId, cleanJwk, uid)
      const banRec = bans.get(uid)
      if (!isRootUid(uid) && banRec) {
        onPeerBanned?.(uid, banRec, peerId)
      }
    })
  }

  let resolvedP: Promise<void> | null = null
  const ensureResolved = (): Promise<void> =>
    (resolvedP ??= (async () => {
      localUser = getLocalUserIdentity ? await getLocalUserIdentity() : null
      if (effectiveRoomIdP) {
        const resolvedRid = await effectiveRoomIdP
        if (resolvedRid && resolvedRid !== effectiveRoomId) {
          effectiveRoomId = resolvedRid
          onRoomIdResolved?.(effectiveRoomId)
        }
        syncRoomIds(effectiveRoomId)
      } else if (!roomAdminUserId && admin.selfAsAdmin && localUser) {
        roomAdminUserId = localUser.userId
        baseRoomId = initialRoomId
        effectiveRoomId = formatSelfCertifyingRoomId(
          initialRoomId,
          roomAdminUserId
        )
        rootUserIds.add(roomAdminUserId)
        onRoomIdResolved?.(effectiveRoomId)
      }
      if (!localUser) {
        return
      }
      peerToUserId.set(selfId, localUser.userId)
      if (rootUserIds.has(localUser.userId)) {
        const rootCert = await signRoleCertInternal(
          localUser.sign,
          localUser.signPubJwk,
          localUser.userId,
          appId,
          effectiveRoomId,
          ['admin'],
          nextClock()
        )
        verifiedCertCache.set(certCacheKey(rootCert), [...rootCert.roles])
        certs.set(localUser.userId, rootCert)
        localCert = rootCert
        onLocalRoleCertificate?.(rootCert)
      } else {
        syncLocalCert()
      }
    })())
  void ensureResolved().catch(noOp)

  const guardApply = <T>(fn: () => Promise<T>, fallback: () => T): Promise<T> =>
    ensureResolved().then(fn).catch(fallback)

  const verifyMod = async (
    rec: RoleRevocationRecord | PeerBanRecord,
    payload: string,
    fromPeerId?: string
  ): Promise<boolean> => {
    if (
      !(await verifyAdminRec(
        rec,
        payload,
        appId,
        effectiveRoomId,
        clockSkewMs,
        verifyCertCached
      ))
    ) {
      return failSig(fromPeerId)
    }
    cacheIssuerCert(rec.issuerUserId, rec.issuerCert)
    return true
  }

  const stageCertInternal = async (
    cert: RoleCertificate,
    fromPeerId?: string
  ): Promise<boolean> => {
    if (
      !isCertHeaderValid(cert) ||
      (isRootUid(cert.subUserId) && !cert.roles.includes('admin'))
    ) {
      return failSig(fromPeerId)
    }
    const prev = certs.get(cert.subUserId)
    if (prev && (prev.sig === cert.sig || prev.iat >= cert.iat)) {
      return false
    }
    if (!(await verifyCertCached(cert)).valid) {
      return failSig(fromPeerId)
    }
    certs.set(cert.subUserId, cert)
    return true
  }

  const stageRevocationInternal = async (
    rev: RoleRevocationRecord,
    fromPeerId?: string
  ): Promise<string | null> => {
    if (!validateRoleRevocationShape(rev) || !canIssuerRevokeTarget(rev)) {
      failSig(fromPeerId)
      return null
    }
    const key = revContentKey(rev)
    const pairKey = revPairRoleKey(rev)
    if (
      rawRevocations.has(key) ||
      (revPairRoleCounts.get(pairKey) ?? 0) >= maxRevocationsPerPairRole ||
      rawRevocations.size >= maxStoredModerationRecords ||
      !(await verifyMod(rev, revocationCanonicalPayload(rev), fromPeerId))
    ) {
      return null
    }
    rawRevocations.set(key, rev)
    revPairRoleCounts.set(pairKey, (revPairRoleCounts.get(pairKey) ?? 0) + 1)
    return key
  }

  const stageBanInternal = async (
    ban: PeerBanRecord,
    fromPeerId?: string
  ): Promise<boolean> => {
    if (!validatePeerBanShape(ban) || isRootUid(ban.targetUserId)) {
      return failSig(fromPeerId)
    }
    const rawKey = banPairKey(ban)
    const prevRaw = rawBans.get(rawKey)
    if (
      (prevRaw &&
        (prevRaw.sig === ban.sig ||
          compareModCausalOrder(prevRaw, true, ban, true) <= 0)) ||
      (!prevRaw && rawBans.size >= maxStoredModerationRecords) ||
      !(await verifyMod(ban, banCanonicalPayload(ban), fromPeerId))
    ) {
      return false
    }
    rawBans.set(rawKey, ban)
    return true
  }

  const verifyAndApplyCert = (
    cert: RoleCertificate,
    fromPeerId?: string
  ): Promise<boolean> =>
    guardApply(
      async () => {
        if (!(await stageCertInternal(cert, fromPeerId))) {
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
        const key = await stageRevocationInternal(rev, fromPeerId)
        if (!key) {
          return false
        }
        const [effectiveRevKeys] = recomputeModerationState()
        return effectiveRevKeys.has(key) || failSig(fromPeerId)
      },
      () => failSig(fromPeerId)
    )

  const verifyAndApplyBan = (
    ban: PeerBanRecord,
    fromPeerId?: string
  ): Promise<boolean> =>
    guardApply(
      async () => {
        if (!(await stageBanInternal(ban, fromPeerId))) {
          return false
        }
        const [, effectiveBanSigs] = recomputeModerationState(fromPeerId)
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

  const applySyncBatchTuple = (
    certsIn?: unknown,
    revsIn?: unknown,
    bansIn?: unknown,
    fromPeerId?: string,
    shouldAbort?: () => boolean
  ): Promise<
    readonly [RoleCertificate[], RoleRevocationRecord[], PeerBanRecord[]]
  > =>
    guardApply(
      async () => {
        const takeArr = <T>(v: unknown, max: number): T[] =>
          Array.isArray(v) ? v.slice(0, max) : []
        const appliedCerts: RoleCertificate[] = []
        const stagedRevs: Array<[rev: RoleRevocationRecord, key: string]> = []
        const stagedBans: PeerBanRecord[] = []

        for (const c of takeArr<RoleCertificate>(certsIn, maxSyncCerts)) {
          if (shouldAbort?.()) {
            break
          }
          if (await stageCertInternal(c, fromPeerId)) {
            appliedCerts.push(c)
          }
        }
        for (const r of takeArr<RoleRevocationRecord>(
          revsIn,
          maxSyncModerationRecords
        )) {
          if (shouldAbort?.()) {
            break
          }
          const key = await stageRevocationInternal(r, fromPeerId)
          if (key) {
            stagedRevs.push([r, key])
          }
        }
        for (const b of takeArr<PeerBanRecord>(
          bansIn,
          maxSyncModerationRecords
        )) {
          if (shouldAbort?.()) {
            break
          }
          if (await stageBanInternal(b, fromPeerId)) {
            stagedBans.push(b)
          }
        }

        if (stagedRevs.length > 0 || stagedBans.length > 0) {
          const [effectiveRevKeys, effectiveBanSigs] =
            recomputeModerationState(fromPeerId)
          return [
            appliedCerts,
            stagedRevs
              .filter(item => effectiveRevKeys.has(item[1]))
              .map(item => item[0]),
            stagedBans.filter(b => effectiveBanSigs.has(b.sig))
          ] as const
        }

        if (appliedCerts.length > 0) {
          syncLocalCert()
        }
        return [appliedCerts, [], []] as const
      },
      () => {
        failSig(fromPeerId)
        return [[], [], []] as const
      }
    )

  const requireLocalRoleCert = (
    requiredRoles: readonly string[],
    forState: boolean,
    namespace: string
  ): readonly [RoleCertificate, string[]] => {
    const myRoles = getPeerRoles(selfId)
    if (!hasAnyRole(myRoles, requiredRoles)) {
      throw mkErr(
        `${insufficientAuthPrefix} ${forState ? 'to update state' : 'for action'} "${namespace}": requires [${requiredRoles.join(', ')}]`
      )
    }
    if (!localCert || !localUser) {
      throw mkErr(
        `missing local role certificate for ${forState ? 'state' : 'action'} "${namespace}"`
      )
    }
    return [localCert, myRoles]
  }

  const getStateWriteCert = async (
    requiredRoles: readonly string[] | null,
    namespace: string
  ): Promise<{cert: RoleCertificate | null; roles: string[]}> => {
    await ensureResolved()
    if (!requiredRoles || requiredRoles.length === 0) {
      const myRoles = getPeerRoles(selfId)
      const cert =
        localCert && !bans.has(localCert.subUserId) && myRoles.length
          ? localCert
          : null
      return {cert, roles: myRoles}
    }
    const [cert, roles] = requireLocalRoleCert(requiredRoles, true, namespace)
    return {cert, roles}
  }

  const verifyStateRecordRoles = async (
    rec: AuthoritativeStateRecord,
    requiredRoles: readonly string[] | null,
    fromPeerId?: string
  ): Promise<{valid: boolean; roles: string[]}> => {
    await ensureResolved()
    if (isPeerBanned(rec.userId)) {
      return invalidRoles()
    }
    if (rec.cert) {
      if (
        !(await verifyCertCached(rec.cert)).valid ||
        rec.cert.subUserId !== rec.userId ||
        rec.hlc < rec.cert.iat
      ) {
        failSig(fromPeerId)
        return invalidRoles()
      }
      cacheIssuerCert(rec.userId, rec.cert)
      const roles = effectiveRoles(rec.cert)
      return requiredRoles?.length && !hasAnyRole(roles, requiredRoles)
        ? invalidRoles()
        : {valid: true, roles}
    }
    return requiredRoles?.length
      ? invalidRoles()
      : {valid: true, roles: getPeerRoles(rec.userId)}
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
      return invalidRoles()
    }
    const okMeta = (roles: string[], userMetadata?: JsonValue) => ({
      valid: true,
      ...(userMetadata === undefined ? {} : {userMetadata}),
      roles
    })
    if (!requiredRoles.length) {
      return okMeta(getPeerRoles(peerId), wireMeta)
    }
    await ensureResolved()
    if (!isObj(wireMeta) || !(authMetaKey in wireMeta)) {
      return invalidRoles()
    }
    const env = wireMeta[authMetaKey] as unknown as ActionAuthEnvelope
    if (!validateActionAuthShape(env) || isPeerBanned(env.userId)) {
      return invalidRoles()
    }
    const knownUid = peerToUserId.get(peerId) ?? getPeerUserId?.(peerId)
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
    if (!hasPreVerifiedOffer && hasActionReplay(replayKey, env.seq)) {
      return invalidRoles()
    }

    const res = await verifyActionAuthInternal(
      env,
      appId,
      effectiveRoomId,
      namespace,
      peerId,
      knownUid,
      data,
      requiredRoles,
      isOffer,
      hasPreVerifiedOffer,
      async cert => {
        const certRes = await verifyCertCached(cert)
        return certRes.valid
          ? {valid: true, roles: effectiveRoles(cert)}
          : certRes
      }
    )
    if (!res.valid || isPeerBanned(peerId) || isPeerBanned(env.userId)) {
      return invalidRoles()
    }

    if (isOffer) {
      if (!recordActionReplay(replayKey, env.seq)) {
        return invalidRoles()
      }
      acceptedOffers.set(offerKey, env.sig)
    } else {
      if (!hasPreVerifiedOffer && !recordActionReplay(replayKey, env.seq)) {
        return invalidRoles()
      }
      peerToUserId.set(peerId, env.userId)
      cacheIssuerCert(env.userId, env.cert)
    }

    return okMeta(res.roles, env.meta)
  }

  const requireAdminSigner = async (
    errMsg: string,
    targetId: string
  ): Promise<readonly [UserIdentity, RoleCertificate, string]> => {
    await ensureResolved()
    if (!getPeerRoles(selfId).includes('admin') || !localCert || !localUser) {
      throw mkErr(errMsg)
    }
    return [localUser, localCert, resolveUid(targetId)]
  }

  const buildPullMessage: RoomAuthority['buildPullMessage'] = async () => {
    await ensureResolved()
    if (!localUser) {
      return null
    }
    const s = [
      ...takeMap(certs, maxSyncCerts),
      ...takeMap(rawRevocations, maxSyncModerationRecords),
      ...takeMap(rawBans, maxSyncModerationRecords)
    ].map(sig8)
    return {
      t: 'pull' as const,
      pubKey: localUser.signPubJwk,
      ...(s.length ? {s} : {})
    }
  }

  const buildDiffSyncMessage: RoomAuthority['buildDiffSyncMessage'] =
    async knownSigs => {
      await ensureResolved()
      const known = new Set(
        Array.isArray(knownSigs) ? knownSigs.filter(isStr) : []
      )
      const unseen = <T extends {sig: string}>(
        m: Map<string, T>,
        max: number
      ): T[] => takeMap(m, max).filter(x => !known.has(sig8(x)))
      return mkSyncMsg(
        unseen(certs, maxSyncCerts),
        unseen(rawRevocations, maxSyncModerationRecords),
        unseen(rawBans, maxSyncModerationRecords)
      )
    }

  const issueRoleCertificate: RoomAuthority['issueRoleCertificate'] = async (
    targetId,
    role
  ) => {
    await ensureResolved()
    const rolesToGrant = [role].flat().filter(Boolean)
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
    const cert = await signRoleCertInternal(
      localUser.sign,
      localUser.signPubJwk,
      targetUserId,
      appId,
      effectiveRoomId,
      rolesToGrant,
      nextClock(minTs + 1)
    )
    await verifyAndApplyCert(cert)
    return cert
  }

  const issueRoleRevocation: RoomAuthority['issueRoleRevocation'] = async (
    targetId,
    role
  ) => {
    const [user, cert, targetUid] = await requireAdminSigner(
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
    const rev = await signModRec<RoleRevocationRecord>(
      user.sign,
      user.signPubJwk,
      cert,
      appId,
      effectiveRoomId,
      user.userId,
      targetUid,
      {
        ...(tc ? {targetCertId: tc.certId} : {}),
        ...(role ? {role} : {})
      },
      ++localModSeq,
      nextClock(Math.max(cert.iat, tc?.iat ?? 0)),
      revocationCanonicalPayload
    )
    await verifyAndApplyRevocation(rev)
    return rev
  }

  const issuePeerBan: RoomAuthority['issuePeerBan'] = async (
    targetId,
    options
  ) => {
    const [user, cert, targetUid] = await requireAdminSigner(
      `${insufficientAuthPrefix}: only an admin can ban a peer`,
      targetId
    )
    if (isRootUid(targetUid)) {
      throw rootAdminProtectErr('ban', 'ban')
    }
    const ban = await signModRec<PeerBanRecord>(
      user.sign,
      user.signPubJwk,
      cert,
      appId,
      effectiveRoomId,
      user.userId,
      targetUid,
      options?.reason ? {reason: options.reason} : {},
      ++localModSeq,
      nextClock(cert.iat),
      banCanonicalPayload
    )
    await verifyAndApplyBan(ban)
    return ban
  }

  return [
    {
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
      canPeerSendAction: (peerId, requiredRoles, inlineCert) => {
        if (isPeerBanned(peerId)) {
          return false
        }
        if (
          !requiredRoles.length ||
          hasAnyRole(getPeerRoles(peerId), requiredRoles)
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
          return hasAnyRole(getPeerRoles(peerId), requiredRoles)
        })
      },
      signActionPayload: async (namespace, requiredRoles, data, userMeta) => {
        await ensureResolved()
        if (!requiredRoles.length) {
          return userMeta ?? null
        }
        const [cert] = requireLocalRoleCert(requiredRoles, false, namespace)
        const env = await signActionAuthInternal(
          localUser!.sign,
          localUser!.signPubJwk,
          cert,
          appId,
          effectiveRoomId,
          namespace,
          selfId,
          localUser!.userId,
          nextLocalActSeq(),
          data,
          userMeta
        )
        return {[authMetaKey]: env} as unknown as JsonValue
      },
      verifyActionOffer: (ns, peerId, reqRoles, wireMeta) =>
        verifyActionInternal(ns, peerId, reqRoles, '', wireMeta, true),
      verifyActionPayload: (ns, peerId, reqRoles, data, wireMeta) =>
        verifyActionInternal(ns, peerId, reqRoles, data, wireMeta, false)
    },
    verifyAndApplyCert,
    verifyAndApplyRevocation,
    verifyAndApplyBan,
    applySyncBatchTuple,
    buildPullMessage,
    buildDiffSyncMessage,
    issueRoleCertificate,
    issueRoleRevocation,
    issuePeerBan
  ]
}

export const createRoomAuthority = (init: RoomAuthorityInit): RoomAuthority => {
  const [
    providerBase,
    verifyAndApplyCert,
    verifyAndApplyRevocation,
    verifyAndApplyBan,
    applySyncBatchTuple,
    buildPullMessage,
    buildDiffSyncMessage,
    issueRoleCertificate,
    issueRoleRevocation,
    issuePeerBan
  ] = initRoomAuthority(
    init.selfId,
    init.appId,
    init.initialRoomId,
    init.effectiveRoomIdP,
    init.getPreResolvedState
      ? () => {
          const s = init.getPreResolvedState?.()
          return s
            ? [s.baseRoomId ?? init.initialRoomId, s.adminUserId ?? '']
            : undefined
        }
      : undefined,
    normalizeRolesConfig(init.admin),
    init.getLocalUserIdentity ? () => init.getLocalUserIdentity!() : undefined,
    pid => init.isOverlayPeerBanned?.(pid) ?? false,
    pid => init.getPeerUserId?.(pid),
    id => init.onRoomIdResolved?.(id),
    (pid, key, uid) => init.onPeerPublicKey?.(pid, key, uid),
    cert => init.onLocalRoleCertificate?.(cert),
    (uid, ban, from) => init.onPeerBanned?.(uid, ban, from),
    from => init.onSignatureFailure?.(from)
  )
  return {
    ...providerBase,
    verifyAndApplyCert,
    verifyAndApplyRevocation,
    verifyAndApplyBan,
    applySyncBatch: async (batch, fromPeerId, shouldAbort) => {
      const [certs, revocations, bans] = await applySyncBatchTuple(
        batch.certs,
        batch.revocations,
        batch.bans,
        fromPeerId,
        shouldAbort
      )
      return {certs, revocations, bans}
    },
    buildPullMessage,
    buildDiffSyncMessage,
    issueRoleCertificate,
    issueRoleRevocation,
    issuePeerBan
  }
}

export const roles = (
  config?: RolesConfig
): RoomPlugin<'roles', RolesPluginApi> & {selfAsAdmin?: boolean} => {
  const normalized = normalizeRolesConfig(config)
  const setupInternal = (
    kernel: InternalRoomContext,
    getPre?: () => readonly [string, string] | undefined
  ): RolesPluginApi => {
    const [hitAuthFailure, , overAuthFailure] = createWindowCounter(512, 8)
    const [hitAuthSyncQuota] = createWindowCounter(512, 24)
    const sentPullPeers = new Set<string>()
    const scaleProv = () => kernel.getScaleProvider()

    const recordPeerAuthFailure = (fromPeerId?: string) => {
      scaleProv()?.recordSignatureFailure()
      if (!fromPeerId || fromPeerId === kernel.selfId) {
        return
      }
      if (hitAuthFailure(fromPeerId)) {
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
      rawAuth.send(msg as unknown as JsonValue, targets).catch(noOp)
    let didReportSelfBan = false

    const banKick = (pid: string): void => {
      scaleProv()?.markPeerBanned(pid)
      kernel.kickPeer(pid, peerBannedErr)
    }

    const [
      providerBase,
      verifyAndApplyCert,
      verifyAndApplyRevocation,
      verifyAndApplyBan,
      applySyncBatchTuple,
      buildPullMessage,
      buildDiffSyncMessage,
      issueRoleCertificate,
      issueRoleRevocation,
      issuePeerBan
    ] = initRoomAuthority(
      kernel.selfId,
      kernel.appId,
      kernel.getRoomId(),
      kernel.effectiveRoomIdP,
      getPre,
      normalized,
      kernel.getLocalUserIdentity,
      pid => scaleProv()?.isPeerBanned(pid) ?? false,
      kernel.getKnownPeerUserId,
      kernel.setEffectiveRoomId,
      (pid, _key, uid) => {
        if (uid) {
          kernel.setPeerUserId(pid, uid)
        }
      },
      cert => scaleProv()?.setLocalRoleCertificate(cert),
      (bannedUid, banRec, fromPeerId) => {
        const localUid = kernel.getKnownPeerUserId(kernel.selfId)
        if (
          bannedUid === kernel.selfId ||
          (localUid && bannedUid === localUid)
        ) {
          if (!didReportSelfBan) {
            didReportSelfBan = true
            kernel.emitError(mkBannedErr(banRec.reason, fromPeerId))
          }
          return
        }
        kernel.purgeBannedUserState(bannedUid)
        scaleProv()?.markPeerBanned(bannedUid)
        const toKick = new Set<string>(kernel.getUserPeerIds(bannedUid))
        for (const pid of kernel.getAllPeerIds()) {
          if (providerBase.isPeerBanned(pid)) {
            toKick.add(pid)
          }
        }
        const activeKickTargets = [...toKick].filter(kernel.isPeerActive)
        if (activeKickTargets.length > 0) {
          void sendAuth({t: 'ban', ban: banRec}, activeKickTargets)
        }
        toKick.forEach(banKick)
      },
      recordPeerAuthFailure
    )

    const isPeerSendable = (pid: string): boolean =>
      kernel.isPeerActive(pid) && !providerBase.isPeerBanned(pid)

    const sendPull = async (peerId: string) => {
      if (sentPullPeers.has(peerId) || !isPeerSendable(peerId)) {
        return
      }
      sentPullPeers.add(peerId)
      const payload = await buildPullMessage()
      if (payload && isPeerSendable(peerId)) {
        void sendAuth(payload, peerId)
      }
    }

    rawAuth.onMessage((raw, fromPeerId) => {
      const msg = raw as unknown as AuthControlMessage
      if (
        !isObj(msg) ||
        providerBase.isPeerBanned(fromPeerId) ||
        overAuthFailure(fromPeerId)
      ) {
        return
      }
      if (msg.t === 'pull' || msg.t === 'sync') {
        if (hitAuthSyncQuota(fromPeerId)) {
          return
        }
        if (msg.pubKey) {
          providerBase.registerPeerPublicKey(fromPeerId, msg.pubKey)
        }
      }
      const arrOver = (a: unknown, max: number): boolean =>
        Array.isArray(a) && a.length > max
      if (msg.t === 'pull') {
        if (arrOver(msg.s, maxSyncCerts + maxSyncModerationRecords * 2)) {
          recordPeerAuthFailure(fromPeerId)
          return
        }
        if (!sentPullPeers.has(fromPeerId)) {
          void sendPull(fromPeerId)
        }
        void buildDiffSyncMessage(msg.s).then(diff => {
          if (diff && isPeerSendable(fromPeerId)) {
            void sendAuth(diff, fromPeerId)
          }
        })
      } else if (msg.t === 'sync') {
        if (
          arrOver(msg.certs, maxSyncCerts) ||
          arrOver(msg.revocations, maxSyncModerationRecords) ||
          arrOver(msg.bans, maxSyncModerationRecords)
        ) {
          recordPeerAuthFailure(fromPeerId)
        }
        void applySyncBatchTuple(
          msg.certs,
          msg.revocations,
          msg.bans,
          fromPeerId,
          () => overAuthFailure(fromPeerId)
        ).then(([certs, revocations, bans]) => {
          const fwd = mkSyncMsg(certs, revocations, bans)
          if (!fwd) {
            return
          }
          const directOthers = kernel
            .getDirectActivePeerIds()
            .filter(id => id !== fromPeerId && !providerBase.isPeerBanned(id))
          if (directOthers.length > 0) {
            void sendAuth(fwd, directOthers)
          }
        })
      } else if (msg.t === 'cert') {
        void verifyAndApplyCert(msg.cert, fromPeerId)
      } else if (msg.t === 'revoke') {
        void verifyAndApplyRevocation(msg.revocation, fromPeerId)
      } else if (msg.t === 'ban') {
        void verifyAndApplyBan(msg.ban, fromPeerId)
      }
    })

    kernel.registerRolesProvider({
      ...providerBase,
      onPeerDescriptorCert: (pid, _key, cert, uid) => {
        if (
          providerBase.isPeerBanned(pid) ||
          (uid && providerBase.isPeerBanned(uid))
        ) {
          banKick(pid)
        } else if (cert) {
          void verifyAndApplyCert(cert, pid)
        }
      }
    })

    kernel.onPeerActivated(pid => void sendPull(pid), {replay: true})
    kernel.onPeerDeactivated(pid => {
      sentPullPeers.delete(pid)
    })

    return {
      grantRole: async (id, role) => {
        const cert = await issueRoleCertificate(id, role)
        await sendAuth({t: 'cert', cert})
        return cert
      },
      revokeRole: async (id, role) => {
        await sendAuth({
          t: 'revoke',
          revocation: await issueRoleRevocation(id, role)
        })
      },
      getRoles: providerBase.getPeerRoles,
      ban: async (id, opts) => {
        await sendAuth({t: 'ban', ban: await issuePeerBan(id, opts)})
      },
      isBanned: providerBase.isPeerBanned
    }
  }

  return makeInternalPlugin<'roles', RolesPluginApi, {selfAsAdmin?: boolean}>(
    'roles',
    setupInternal,
    {
      resolveRoomId: async ({roomId, userIdentityP}) => {
        const [base, uid] = splitSelfCertRoom(roomId)
        const adminUid =
          uid ??
          (normalized.selfAsAdmin && userIdentityP
            ? (await userIdentityP).userId
            : null)
        return adminUid
          ? {effectiveRoomId: `${base}~${adminUid}`, state: [base, adminUid]}
          : {effectiveRoomId: roomId}
      },
      ...(normalized.selfAsAdmin ? {selfAsAdmin: true} : {})
    },
    Boolean(normalized.selfAsAdmin)
  )
}
