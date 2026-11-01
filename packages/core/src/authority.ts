import {sha256} from './crypto'
import {
  canonicalizePubJwk,
  getVerifiedPubKeyRecord,
  isValidUserId,
  pubJwkToUncompressedBytes
} from './identity'
import {
  compareStateRecords,
  createStateManager,
  defaultMaxClockSkewMs,
  signStateRecord,
  signWith,
  validateStateRecordShape,
  verifySig,
  verifyStateRecordSignature,
  type StateManager,
  type StateSignParams,
  type StateSigner
} from './state'
import type {
  AuthoritativeState,
  AuthoritativeStateRecord,
  DataPayload,
  JsonValue,
  KernelRolesProvider,
  PeerBanRecord,
  RoleCertificate,
  RoleRevocationRecord,
  RolesConfig,
  RolesPluginApi,
  RoomPlugin,
  StateConfig,
  UserIdentity,
  Widen
} from './types'
import {
  authMetaKey,
  createBoundedCache,
  createBoundedSet,
  definePlugin,
  encodeBytes,
  insufficientAuthPrefix,
  isSelfAsAdminPlugin,
  keys,
  mkErr,
  noOp,
  peerBannedErr,
  peerBannedMsg,
  posSafeIntErr,
  selfCertifyingRoomRegex,
  toBase64Url,
  toJson
} from './utils'

export {
  compareStateRecords,
  isSelfAsAdminPlugin,
  signStateRecord,
  validateStateRecordShape,
  type StateSignParams
}

type Signer = StateSigner

const maxSyncCerts = 128
const maxSyncModerationRecords = 256
const maxStoredModerationRecords = 512
const maxRevocationsPerPairRole = 4
const digestChunkBytes = 256 * 1024

const isObj = (v: unknown): v is Record<string, unknown> =>
  Boolean(v && typeof v === 'object' && !Array.isArray(v))
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const hasStrs = (o: Record<string, unknown>, ks: string[]): boolean =>
  ks.every(k => isStr(o[k]))
const isPosInt = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n > 0
const isValidSig = (s: unknown): s is string =>
  typeof s === 'string' && s.length >= 64 && s.length <= 128
const isValidJwk = (v: unknown): v is JsonWebKey =>
  isObj(v) && Boolean(pubJwkToUncompressedBytes(v as JsonWebKey))
const toCleanJwk = (j: JsonWebKey): JsonWebKey => ({
  kty: 'EC',
  crv: 'P-256',
  x: j.x ?? '',
  y: j.y ?? ''
})
const rootAdminProtectErr = (scope: string, verb: string) =>
  mkErr(`${scope}: cannot ${verb} a root admin`)
const canonTag = (tag: string, items: unknown[]): string =>
  toJson([`trystero:${tag}:v1`, ...items])

let lastIssuedTs = 0
const nextMonotonicTs = (): number => {
  const now = Date.now()
  return (lastIssuedTs = now > lastIssuedTs ? now : lastIssuedTs + 1)
}

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
      if (k !== 'selfAsAdmin' && k !== 'admins' && k !== 'maxClockSkewMs') {
        throw mkErr(`Unknown roles config option "${k}"`)
      }
    }
    if (
      config.maxClockSkewMs !== undefined &&
      (typeof config.maxClockSkewMs !== 'number' ||
        !Number.isSafeInteger(config.maxClockSkewMs) ||
        config.maxClockSkewMs <= 0)
    ) {
      throw posSafeIntErr('maxClockSkewMs')
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
    ...(admins ? {admins} : {}),
    ...(config?.maxClockSkewMs !== undefined
      ? {maxClockSkewMs: config.maxClockSkewMs}
      : {})
  }
}

const roleCertPayload = (c: Omit<RoleCertificate, 'sig'>): string =>
  canonTag('role-cert', [
    c.v,
    c.certId,
    c.issuerPubKey,
    c.subUserId,
    c.appId,
    c.roomId,
    [...c.roles].sort(),
    c.iat
  ])

export type CertSignParams = {
  subUserId: string
  appId: string
  roomId: string
  roles: string[]
  now?: number
}

export const signRoleCertificate = async (
  signer: Signer,
  issuerPubJwk: JsonWebKey,
  p: CertSignParams
): Promise<RoleCertificate> => {
  const u: Omit<RoleCertificate, 'sig'> = {
    v: 1,
    certId: crypto.randomUUID(),
    issuerPubKey: canonicalizePubJwk(issuerPubJwk),
    subUserId: p.subUserId,
    appId: p.appId,
    roomId: p.roomId,
    roles: [...new Set(p.roles)].sort(),
    iat: p.now ?? nextMonotonicTs()
  }
  return {...u, sig: await signWith(signer, roleCertPayload(u))}
}

export const validateRoleCertificateShape = (
  c: unknown
): c is RoleCertificate =>
  isObj(c) &&
  c['v'] === 1 &&
  hasStrs(c, ['certId', 'issuerPubKey', 'subUserId', 'appId', 'roomId']) &&
  Array.isArray(c['roles']) &&
  c['roles'].length > 0 &&
  c['roles'].every(isStr) &&
  isPosInt(c['iat']) &&
  isValidSig(c['sig'])

export const verifyRoleCertificate = async (
  cert: RoleCertificate,
  appId: string,
  roomId: string,
  rootUserIds: Set<string>,
  clockSkewMs: number = defaultMaxClockSkewMs
): Promise<{valid: boolean; roles: string[]}> => {
  if (
    !validateRoleCertificateShape(cert) ||
    cert.appId !== appId ||
    cert.roomId !== roomId ||
    cert.iat > Date.now() + clockSkewMs
  ) {
    return {valid: false, roles: []}
  }
  const iss = await getVerifiedPubKeyRecord(cert.issuerPubKey)
  if (!iss || !rootUserIds.has(iss.userId)) {
    return {valid: false, roles: []}
  }
  return (await verifySig(cert.issuerPubKey, roleCertPayload(cert), cert.sig))
    ? {valid: true, roles: [...cert.roles]}
    : {valid: false, roles: []}
}

export const verifyRoleCertificateChain: typeof verifyRoleCertificate =
  verifyRoleCertificate

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
  isPosInt(r['seq']) &&
  isPosInt(r['ts']) &&
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

const signModRec = async <T>(
  signer: Signer,
  pubJwk: JsonWebKey,
  cert: RoleCertificate,
  p: AdminSignParams,
  extra: Record<string, unknown>,
  canon: (u: any) => string
): Promise<T> => {
  const u = {
    v: 1 as const,
    appId: p.appId,
    roomId: p.roomId,
    issuerUserId: p.issuerUserId ?? cert.subUserId,
    targetUserId: p.targetUserId,
    ...extra,
    seq: p.seq,
    ts: p.ts ?? p.now ?? Math.max(nextMonotonicTs(), cert.iat, p.minTs ?? 0),
    issuerCert: cert,
    signerPubKey: toCleanJwk(pubJwk)
  }
  return {...u, sig: await signWith(signer, canon(u))} as unknown as T
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
  clockSkewMs: number = defaultMaxClockSkewMs
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
  const certRes = await verifyRoleCertificate(
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
  const isBlob = typeof Blob !== 'undefined' && data instanceof Blob
  let rawB: Uint8Array = new Uint8Array(0)
  let tag = 0x02
  if (!isBlob) {
    if (data instanceof Uint8Array) {
      rawB = data
    } else if (data instanceof ArrayBuffer) {
      rawB = new Uint8Array(data)
    } else if (ArrayBuffer.isView(data)) {
      rawB = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    } else if (typeof data === 'string') {
      rawB = encodeBytes(data)
      tag = 0x01
    } else {
      rawB = encodeBytes(toJson(data))
      tag = 0x03
    }
  }
  const totalLen = isBlob ? data.size : rawB.byteLength
  if (tag !== 0x02 || totalLen <= digestChunkBytes) {
    if (isBlob) {
      rawB = new Uint8Array(await data.arrayBuffer())
    }
    return packDigest(tag, rawB, metaB)
  }
  const nChunks = Math.ceil(totalLen / digestChunkBytes)
  const body = new Uint8Array(8 + nChunks * 32)
  new DataView(body.buffer).setBigUint64(0, BigInt(totalLen), false)
  for (let i = 0, off = 0; off < totalLen; i++, off += digestChunkBytes) {
    const end = Math.min(off + digestChunkBytes, totalLen)
    const part = isBlob
      ? new Uint8Array(await data.slice(off, end).arrayBuffer())
      : rawB.subarray(off, end)
    body.set(await sha256(part as BufferSource), 8 + i * 32)
  }
  return packDigest(0x04, body, metaB)
}

const actionAuthPayload = (
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
  isPosInt(e['seq']) &&
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

export const signActionAuth = async (
  signer: Signer,
  pubJwk: JsonWebKey,
  cert: RoleCertificate,
  p: ActionSignParams
): Promise<ActionAuthEnvelope> => {
  const u: Omit<ActionAuthEnvelope, 'sig'> = {
    v: 1,
    appId: p.appId,
    roomId: p.roomId,
    namespace: p.namespace,
    peerId: p.peerId,
    userId: p.userId ?? cert.subUserId,
    seq: p.seq,
    digest: await computePayloadDigest(p.data, p.meta),
    cert,
    signerPubKey: toCleanJwk(pubJwk),
    ...(p.meta === undefined ? {} : {meta: p.meta})
  }
  return {...u, sig: await signWith(signer, actionAuthPayload(u))}
}

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
  maxClockSkewMs?: number
}

export const verifyActionAuth = async (
  env: ActionAuthEnvelope,
  p: ActionVerifyParams
): Promise<{valid: boolean; roles: string[]}> => {
  if (
    !validateActionAuthShape(env) ||
    env.appId !== p.appId ||
    env.roomId !== p.roomId ||
    env.namespace !== p.namespace ||
    env.peerId !== p.peerId ||
    env.cert.subUserId !== env.userId ||
    (p.expectedUserId !== undefined && env.userId !== p.expectedUserId)
  ) {
    return {valid: false, roles: []}
  }
  const signer = await getVerifiedPubKeyRecord(env.signerPubKey)
  if (!signer || signer.userId !== env.userId) {
    return {valid: false, roles: []}
  }
  const certRes = await verifyRoleCertificate(
    env.cert,
    p.appId,
    p.roomId,
    p.rootUserIds,
    p.maxClockSkewMs
  )
  if (!certRes.valid || !p.requiredRoles.some(r => certRes.roles.includes(r))) {
    return {valid: false, roles: []}
  }
  if (
    !p.skipDigestCheck &&
    (await computePayloadDigest(p.data, env.meta)) !== env.digest
  ) {
    return {valid: false, roles: []}
  }
  return (await verifySig(env.signerPubKey, actionAuthPayload(env), env.sig))
    ? {valid: true, roles: certRes.roles}
    : {valid: false, roles: []}
}

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

type AuthControlMessage =
  | {
      t: 'sync'
      pubKey?: JsonWebKey
      certs?: RoleCertificate[]
      revocations?: RoleRevocationRecord[]
      bans?: PeerBanRecord[]
    }
  | {t: 'cert'; cert: RoleCertificate}
  | {t: 'revoke'; revocation: RoleRevocationRecord}
  | {t: 'ban'; ban: PeerBanRecord}

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
  verifyAndApplyStateRecord: (
    rec: AuthoritativeStateRecord,
    fromPeerId?: string
  ) => Promise<boolean>
  buildSyncMessage: (forceFull?: boolean) => Promise<AuthControlMessage | null>
  makeState: <T extends JsonValue>(
    namespace: string,
    initialValue: T,
    config?: StateConfig<Widen<T>>,
    broadcastState?: (rec: AuthoritativeStateRecord) => void
  ) => AuthoritativeState<Widen<T>>
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
  clearListeners: () => void
}

export type RoomAuthorityInit = {
  selfId: string
  appId: string
  initialRoomId: string
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

const compareModCausalOrder = (
  a: RoleRevocationRecord | PeerBanRecord,
  aKind: 'ban' | 'revoke',
  b: RoleRevocationRecord | PeerBanRecord,
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
  const clockSkewMs = admin.maxClockSkewMs ?? defaultMaxClockSkewMs
  const certs = new Map<string, RoleCertificate>()
  const revocations = new Map<string, RoleRevocationRecord[]>()
  const rawRevocations = new Map<string, RoleRevocationRecord>()
  const revPairRoleCounts = new Map<string, number>()
  const bans = new Map<string, PeerBanRecord>()
  const rawBans = new Map<string, PeerBanRecord>()
  const peerToUserId = new Map<string, string>()
  const lastSeenActionSeq = new Map<string, number>()
  const verifiedCertCache = createBoundedCache<string, string[]>(512)
  const verifiedActionSigCache = createBoundedSet(512)
  const standaloneBroadcastCallbacks = new Map<
    string,
    (rec: AuthoritativeStateRecord) => void
  >()
  const standaloneRegisteredShared = new Set<string>()
  let standaloneState: StateManager | null = null

  let localCert: RoleCertificate | null = null
  let localModSeq = 0
  let localActSeq = 0
  let effectiveRoomId = initialRoomId
  let {baseRoomId, userId: roomAdminUserId} =
    parseSelfCertifyingRoomId(initialRoomId)
  const rootUserIds = new Set<string>(roomAdminUserId ? [roomAdminUserId] : [])
  let localUser: UserIdentity | null = null
  for (const uid of admin.admins ?? []) {
    rootUserIds.add(uid)
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

    if (
      localCert &&
      (bans.has(localCert.subUserId) || !effectiveRoles(localCert).length)
    ) {
      localCert = null
      init.onLocalRoleCertificate?.(null)
    } else if (!localCert && localUser) {
      const stored = certs.get(localUser.userId)
      if (
        stored &&
        !bans.has(localUser.userId) &&
        effectiveRoles(stored).length
      ) {
        localCert = stored
        init.onLocalRoleCertificate?.(stored)
      }
    }

    for (const [bannedUid, banRec] of bans.entries()) {
      if (!prevBannedUids.has(bannedUid)) {
        standaloneState?.purgeBannedUser(bannedUid)
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
      if (!roomAdminUserId && admin.selfAsAdmin && localUser) {
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
            roles: ['admin']
          }
        )
        verifiedCertCache.set(
          `${roleCertPayload(rootCert)}\u0000${rootCert.sig}`,
          [...rootCert.roles]
        )
        certs.set(localUser.userId, rootCert)
        localCert = rootCert
        init.onLocalRoleCertificate?.(rootCert)
      } else if (certs.has(localUser.userId)) {
        localCert = certs.get(localUser.userId)!
        init.onLocalRoleCertificate?.(localCert)
      }
    })())
  void ensureResolved().catch(noOp)

  const guardApply = (
    fn: () => Promise<boolean>,
    fromPeerId?: string
  ): Promise<boolean> =>
    ensureResolved()
      .then(fn)
      .catch(() => failSig(fromPeerId))

  const verifyAndApplyCert = (
    cert: RoleCertificate,
    fromPeerId?: string
  ): Promise<boolean> =>
    guardApply(async () => {
      if (
        !validateRoleCertificateShape(cert) ||
        cert.appId !== appId ||
        cert.roomId !== effectiveRoomId ||
        cert.iat > Date.now() + clockSkewMs ||
        (isRootUid(cert.subUserId) && !cert.roles.includes('admin'))
      ) {
        return failSig(fromPeerId)
      }
      const prev = certs.get(cert.subUserId)
      if (prev && (prev.sig === cert.sig || prev.iat >= cert.iat)) {
        return false
      }
      const res = await verifyCertCached(cert)
      if (!res.valid) {
        return failSig(fromPeerId)
      }
      certs.set(cert.subUserId, cert)
      if (localUser && cert.subUserId === localUser.userId) {
        if (!bans.has(localUser.userId) && effectiveRoles(cert).length) {
          localCert = cert
          init.onLocalRoleCertificate?.(cert)
        }
      }
      return true
    }, fromPeerId)

  const verifyModRecCached = async (
    rec: RoleRevocationRecord | PeerBanRecord,
    payload: string
  ): Promise<boolean> => {
    if (
      rec.appId !== appId ||
      rec.roomId !== effectiveRoomId ||
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
    const certRes = await verifyCertCached(rec.issuerCert)
    return (
      certRes.valid && (await verifySig(rec.signerPubKey, payload, rec.sig))
    )
  }

  const verifyAndApplyRevocation = (
    rev: RoleRevocationRecord,
    fromPeerId?: string
  ): Promise<boolean> =>
    guardApply(async () => {
      if (!validateRoleRevocationShape(rev) || !canIssuerRevokeTarget(rev)) {
        return failSig(fromPeerId)
      }
      const key = revContentKey(rev)
      if (rawRevocations.has(key)) {
        return false
      }
      const pairKey = revPairRoleKey(rev)
      if (
        (revPairRoleCounts.get(pairKey) ?? 0) >= maxRevocationsPerPairRole ||
        rawRevocations.size >= maxStoredModerationRecords
      ) {
        return false
      }
      if (!(await verifyModRecCached(rev, revocationCanonicalPayload(rev)))) {
        return failSig(fromPeerId)
      }
      if (!certs.has(rev.issuerUserId)) {
        certs.set(rev.issuerUserId, rev.issuerCert)
      }
      rawRevocations.set(key, rev)
      revPairRoleCounts.set(pairKey, (revPairRoleCounts.get(pairKey) ?? 0) + 1)
      const {effectiveRevKeys} = recomputeModerationState()
      if (!effectiveRevKeys.has(key)) {
        return failSig(fromPeerId)
      }
      return true
    }, fromPeerId)

  const verifyAndApplyBan = (
    ban: PeerBanRecord,
    fromPeerId?: string
  ): Promise<boolean> =>
    guardApply(async () => {
      if (!validatePeerBanShape(ban) || isRootUid(ban.targetUserId)) {
        return failSig(fromPeerId)
      }
      const rawKey = `${ban.issuerUserId}\u0000${ban.targetUserId}`
      const prevRaw = rawBans.get(rawKey)
      if (
        prevRaw &&
        (prevRaw.sig === ban.sig ||
          compareModCausalOrder(prevRaw, 'ban', ban, 'ban') <= 0)
      ) {
        return false
      }
      if (!prevRaw && rawBans.size >= maxStoredModerationRecords) {
        return false
      }
      if (!(await verifyModRecCached(ban, banCanonicalPayload(ban)))) {
        return failSig(fromPeerId)
      }
      if (!certs.has(ban.issuerUserId)) {
        certs.set(ban.issuerUserId, ban.issuerCert)
      }
      rawBans.set(rawKey, ban)
      const {effectiveBanSigs} = recomputeModerationState(fromPeerId)
      if (!effectiveBanSigs.has(ban.sig)) {
        // If another admin ALREADY banned targetUserId earlier, ban is benignly redundant rather than invalid unless issuer itself lacked authority
        if (
          bans.has(ban.targetUserId) &&
          getPeerRoles(ban.issuerUserId).includes('admin')
        ) {
          return false
        }
        return failSig(fromPeerId)
      }
      return true
    }, fromPeerId)

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

  const rolesProviderHooks: KernelRolesProvider = {
    getEffectiveRoomId: () => effectiveRoomId,
    getMaxClockSkewMs: () => clockSkewMs,
    getPeerRoles,
    isPeerBanned,
    getBanReason,
    registerPeerPublicKey,
    getStateWriteCert,
    verifyStateRecordRoles,
    onPeerDescriptorCert: noOp,
    canPeerSendAction: () => false,
    signActionPayload: async () => null,
    verifyActionOffer: async () => ({valid: false, roles: []}),
    verifyActionPayload: async () => ({valid: false, roles: []}),
    getAuthorityInfo: async () => ({
      userId: '',
      roomId: effectiveRoomId,
      baseRoomId,
      isAdmin: false,
      roles: []
    })
  }

  const getStandaloneState = (): StateManager =>
    (standaloneState ??= createStateManager({
      appId,
      getRoomId: () => effectiveRoomId,
      getSelfId: () => selfId,
      getLocalUserId: () => localUser?.userId ?? '',
      ensureReady: async () => {
        await ensureResolved()
        if (!localUser) {
          throw mkErr('missing local user identity')
        }
        return {selfId, user: localUser, roomId: effectiveRoomId}
      },
      hasRolesPlugin: () => true,
      getRolesProvider: () => rolesProviderHooks,
      maxClockSkewMs: clockSkewMs,
      isPeerActive: () => true,
      isDirectPeer: () => true,
      getDirectPeerIds: () => [],
      isUserOnline: () => true,
      getKnownPeerUserId: pid =>
        peerToUserId.get(pid) ?? init.getPeerUserId?.(pid),
      isPeerBanned,
      getPeerRoles,
      onBroadcastRecord: rec => {
        standaloneBroadcastCallbacks.get(rec.ns)?.(rec)
      },
      onInvalidRecord: fromPeerId => {
        failSig(fromPeerId)
      }
    }))

  const verifyAndApplyStateRecord = (
    rec: AuthoritativeStateRecord,
    fromPeerId?: string
  ): Promise<boolean> =>
    guardApply(async () => {
      if (
        validateStateRecordShape(rec) &&
        rec.k === 's' &&
        !standaloneRegisteredShared.has(rec.ns)
      ) {
        const roleCheck = await verifyStateRecordRoles(
          rec,
          ['admin'],
          fromPeerId
        )
        if (!roleCheck.valid) {
          return false
        }
      }
      return getStandaloneState().verifyAndApplyStateRecord(rec, fromPeerId)
    }, fromPeerId)

  const verifyActionInternal = async (
    namespace: string,
    peerId: string,
    requiredRoles: readonly string[],
    data: DataPayload,
    wireMeta: JsonValue | undefined,
    isOffer: boolean
  ) => {
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
    if (
      !validateActionAuthShape(env) ||
      env.appId !== appId ||
      env.roomId !== effectiveRoomId ||
      env.namespace !== namespace ||
      env.peerId !== peerId ||
      env.cert.subUserId !== env.userId ||
      isPeerBanned(env.userId)
    ) {
      return {valid: false, roles: []}
    }
    const knownUid = peerToUserId.get(peerId) ?? init.getPeerUserId?.(peerId)
    if (knownUid && knownUid !== env.userId) {
      return {valid: false, roles: []}
    }
    const replayKey = `${peerId}\u0000${namespace}`
    const prevSeq = lastSeenActionSeq.get(replayKey)
    if (prevSeq !== undefined && env.seq <= prevSeq) {
      return {valid: false, roles: []}
    }
    const roles = effectiveRoles(env.cert)
    if (!requiredRoles.some(r => roles.includes(r))) {
      return {valid: false, roles: []}
    }
    const signer = await getVerifiedPubKeyRecord(env.signerPubKey)
    if (!signer || signer.userId !== env.userId) {
      return {valid: false, roles: []}
    }
    const certRes = await verifyCertCached(env.cert)
    if (!certRes.valid || !requiredRoles.some(r => certRes.roles.includes(r))) {
      return {valid: false, roles: []}
    }
    if (
      !isOffer &&
      (await computePayloadDigest(data, env.meta)) !== env.digest
    ) {
      return {valid: false, roles: []}
    }
    const sigCacheKey = `${actionAuthPayload(env)}\u0000${env.sig}`
    if (!verifiedActionSigCache.has(sigCacheKey)) {
      if (
        !(await verifySig(env.signerPubKey, actionAuthPayload(env), env.sig))
      ) {
        return {valid: false, roles: []}
      }
      verifiedActionSigCache.add(sigCacheKey)
    }
    if (!isOffer) {
      if (lastSeenActionSeq.size >= 2048) {
        const oldest = lastSeenActionSeq.keys().next().value
        if (oldest !== undefined) {
          lastSeenActionSeq.delete(oldest)
        }
      }
      lastSeenActionSeq.set(replayKey, env.seq)
      peerToUserId.set(peerId, env.userId)
      if (!certs.has(env.userId)) {
        certs.set(env.userId, env.cert)
      }
    }
    return {
      valid: true,
      ...(env.meta === undefined ? {} : {userMetadata: env.meta}),
      roles
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
    getMaxClockSkewMs: () => clockSkewMs,
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
    verifyAndApplyStateRecord,
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
          seq: ++localActSeq,
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
    buildSyncMessage: async (forceFull = false) => {
      await ensureResolved()
      if (!localUser) {
        return null
      }
      const certList = [...certs.values()].slice(0, maxSyncCerts)
      const revList = [...rawRevocations.values()].slice(
        0,
        maxSyncModerationRecords
      )
      const banList = [...rawBans.values()].slice(0, maxSyncModerationRecords)
      if (
        !forceFull &&
        !certList.length &&
        !revList.length &&
        !banList.length
      ) {
        return {t: 'sync' as const, pubKey: localUser.signPubJwk}
      }
      return {
        t: 'sync' as const,
        pubKey: localUser.signPubJwk,
        ...(certList.length ? {certs: certList} : {}),
        ...(revList.length ? {revocations: revList} : {}),
        ...(banList.length ? {bans: banList} : {})
      }
    },
    makeState: <T extends JsonValue>(
      namespace: string,
      initialValue: T,
      config?: StateConfig<Widen<T>>,
      broadcastState?: (rec: AuthoritativeStateRecord) => void
    ): AuthoritativeState<Widen<T>> => {
      standaloneRegisteredShared.add(namespace)
      if (broadcastState) {
        standaloneBroadcastCallbacks.set(namespace, broadcastState)
      }
      return getStandaloneState().makeState(namespace, initialValue, config)
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
          now: Math.max(nextMonotonicTs(), minTs + 1)
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
        ...(tc ? {targetCertId: tc.certId, minTs: tc.iat} : {}),
        ...(role ? {role} : {}),
        seq: ++localModSeq
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
        seq: ++localModSeq
      })
      await verifyAndApplyBan(ban)
      return ban
    },
    clearListeners: () => {
      standaloneState?.destroy()
    }
  }
}

export const roles = (
  config?: RolesConfig
): RoomPlugin<'roles', RolesPluginApi> & {selfAsAdmin?: boolean} => {
  const normalized = normalizeRolesConfig(config)
  const plugin = definePlugin<'roles', RolesPluginApi>('roles', {
    resolveRoomId: async ({roomId, userIdentityP}) => {
      if (
        normalized.selfAsAdmin &&
        !parseSelfCertifyingRoomId(roomId).userId &&
        userIdentityP
      ) {
        const user = await userIdentityP
        return {
          effectiveRoomId: formatSelfCertifyingRoomId(roomId, user.userId)
        }
      }
      return {effectiveRoomId: roomId}
    },
    setup: kernel => {
      const peerAuthPenalty = createBoundedCache<
        string,
        {failures: number; syncs: number; windowStart: number}
      >(512)
      const getPenaltyEntry = (peerId: string) => {
        const now = Date.now()
        const existing = peerAuthPenalty.get(peerId)
        if (!existing || now - existing.windowStart > 30_000) {
          const fresh = {failures: 0, syncs: 0, windowStart: now}
          peerAuthPenalty.set(peerId, fresh)
          return fresh
        }
        return existing
      }
      const isAuthAbusive = (peerId: string): boolean =>
        (peerAuthPenalty.get(peerId)?.failures ?? 0) >= 8

      const recordPeerAuthFailure = (fromPeerId?: string) => {
        kernel.getScaleProvider()?.recordSignatureFailure()
        if (!fromPeerId || fromPeerId === kernel.selfId) {
          return
        }
        const entry = getPenaltyEntry(fromPeerId)
        entry.failures += 1
        if (entry.failures >= 8) {
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
      const sendAuth = (msg: AuthControlMessage, targets?: string | string[]) =>
        rawAuth.send(msg as unknown as JsonValue, targets)
      let didReportSelfBan = false

      const authority = createRoomAuthority({
        selfId: kernel.selfId,
        appId: kernel.appId,
        initialRoomId: kernel.initialRoomId,
        admin: normalized,
        getLocalUserIdentity: () => kernel.getLocalUserIdentity(),
        isOverlayPeerBanned: pid =>
          kernel.getScaleProvider()?.isPeerBanned(pid) ?? false,
        getPeerUserId: pid => kernel.getKnownPeerUserId(pid),
        onRoomIdResolved: id => kernel.setEffectiveRoomId(id),
        onPeerPublicKey: (pid, _key, uid) => {
          if (uid) {
            kernel.setPeerUserId(pid, uid)
          }
        },
        onLocalRoleCertificate: cert =>
          kernel.getScaleProvider()?.setLocalRoleCertificate(cert),
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
          kernel.purgeBannedUserState?.(bannedUid)
          kernel.getScaleProvider()?.markPeerBanned(bannedUid)
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
            void sendAuth({t: 'ban', ban: banRec}, activeKickTargets).catch(
              noOp
            )
          }
          for (const pid of toKick) {
            kernel.getScaleProvider()?.markPeerBanned(pid)
            kernel.kickPeer(pid, peerBannedErr)
          }
        },
        onSignatureFailure: recordPeerAuthFailure
      })
      const sendSync = async (peerId: string, force = false) => {
        if (!kernel.isPeerActive(peerId) || authority.isPeerBanned(peerId)) {
          return
        }
        const payload = await authority.buildSyncMessage(force)
        if (payload) {
          void sendAuth(payload, peerId).catch(noOp)
        }
      }

      rawAuth.onMessage((raw, fromPeerId) => {
        const msg = raw as unknown as AuthControlMessage
        if (
          !isObj(msg) ||
          authority.isPeerBanned(fromPeerId) ||
          isAuthAbusive(fromPeerId)
        ) {
          return
        }
        if (msg.t === 'sync') {
          const penalty = getPenaltyEntry(fromPeerId)
          penalty.syncs += 1
          if (penalty.syncs > 12) {
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
          void (async () => {
            const certs: RoleCertificate[] = []
            const revocations: RoleRevocationRecord[] = []
            const bans: PeerBanRecord[] = []
            for (const c of Array.isArray(msg.certs)
              ? msg.certs.slice(0, maxSyncCerts)
              : []) {
              if (isAuthAbusive(fromPeerId)) {
                return
              }
              if (await authority.verifyAndApplyCert(c, fromPeerId)) {
                certs.push(c)
              }
            }
            for (const r of Array.isArray(msg.revocations)
              ? msg.revocations.slice(0, maxSyncModerationRecords)
              : []) {
              if (isAuthAbusive(fromPeerId)) {
                return
              }
              if (await authority.verifyAndApplyRevocation(r, fromPeerId)) {
                revocations.push(r)
              }
            }
            for (const b of Array.isArray(msg.bans)
              ? msg.bans.slice(0, maxSyncModerationRecords)
              : []) {
              if (isAuthAbusive(fromPeerId)) {
                return
              }
              if (await authority.verifyAndApplyBan(b, fromPeerId)) {
                bans.push(b)
              }
            }
            if (certs.length || revocations.length || bans.length) {
              const others = kernel
                .getAllPeerIds()
                .filter(id => id !== fromPeerId && !authority.isPeerBanned(id))
              if (others.length) {
                void sendAuth(
                  {
                    t: 'sync',
                    ...(certs.length ? {certs} : {}),
                    ...(revocations.length ? {revocations} : {}),
                    ...(bans.length ? {bans} : {})
                  },
                  others
                ).catch(noOp)
              }
            }
          })()
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
            kernel.getScaleProvider()?.markPeerBanned(pid)
            kernel.kickPeer(pid, peerBannedErr)
          } else if (cert) {
            void authority.verifyAndApplyCert(cert, pid)
          }
        }
      })

      kernel.onPeerActivated(pid => void sendSync(pid, true), {replay: true})
      kernel.onLeave(() => authority.clearListeners())

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
      } satisfies Omit<
        RolesPluginApi,
        'makeState' | 'makeUserState'
      > as unknown as RolesPluginApi
    }
  })
  return normalized.selfAsAdmin ? {...plugin, selfAsAdmin: true} : plugin
}
