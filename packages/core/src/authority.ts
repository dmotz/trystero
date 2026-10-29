import {ecdsaSign, sha256} from './crypto'
import {
  canonicalizePubJwk,
  computeUserIdFingerprint,
  getVerifiedPubKeyRecord,
  isValidUserId,
  pubJwkToUncompressedBytes,
  resolveUserIdentity,
  verifyWithP256
} from './identity'
import type {
  AuthoritativeState,
  AuthoritativeStateRecord,
  DataPayload,
  JsonValue,
  KernelRolesProvider,
  MaybePromise,
  PeerBanRecord,
  RoleCertificate,
  RoleRevocationRecord,
  RolesConfig,
  RolesPluginApi,
  RoomPlugin,
  StateChangeContext,
  StateConfig,
  UserIdentity,
  UserIdentityConfig,
  Widen
} from './types'
import {
  authMetaKey,
  definePlugin,
  encodeBytes,
  fromBase64Url,
  genId,
  insufficientAuthPrefix,
  invalidP256KeyErr,
  keys,
  mkErr,
  noOp,
  peerBannedErr,
  requiredErr,
  selfCertifyingRoomRegex,
  toBase64Url,
  toHex,
  toJson
} from './utils'

type Signer = CryptoKey | ((payload: Uint8Array) => MaybePromise<Uint8Array>)

const maxClockSkewMs = 60_000
const zeroHash = '00000000000000000000000000000000'
const digestChunkBytes = 256 * 1024
const hex32Re = /^[0-9a-f]{32}$/

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
  mkErr(`${scope}: delegated admin cannot ${verb} a root admin`)
const canonTag = (tag: string, items: unknown[]): string =>
  toJson([`trystero:${tag}:v1`, ...items])

const hasFiniteNums = (
  v: unknown,
  d = 0,
  seen = new Set<object>()
): boolean => {
  if (d > 64) {
    return false
  }
  if (v === null || typeof v === 'string' || typeof v === 'boolean') {
    return true
  }
  if (typeof v === 'number') {
    return Number.isFinite(v)
  }
  if (typeof v !== 'object' || seen.has(v)) {
    return false
  }
  seen.add(v)
  const list = Array.isArray(v) ? v : isObj(v) ? Object.values(v) : null
  return Boolean(list?.every(x => hasFiniteNums(x, d + 1, seen)))
}

let lastIssuedTs = 0
const nextMonotonicTs = (): number => {
  const now = Date.now()
  return (lastIssuedTs = now > lastIssuedTs ? now : lastIssuedTs + 1)
}

const signWith = async (signer: Signer, payload: string): Promise<string> => {
  const b = encodeBytes(payload)
  const s =
    typeof signer === 'function'
      ? await signer(b)
      : await ecdsaSign(signer, b as BufferSource)
  return toBase64Url(s)
}

const verifySig = async (
  pub: JsonWebKey | string,
  payload: string,
  sig: string
): Promise<boolean> => {
  try {
    return await verifyWithP256(fromBase64Url(sig), encodeBytes(payload), pub)
  } catch {
    return false
  }
}

export const computePublicKeyFingerprint = async (
  pubKey: JsonWebKey | string
): Promise<string> => {
  const rec = await getVerifiedPubKeyRecord(pubKey)
  if (!rec) {
    throw invalidP256KeyErr
  }
  return rec.fingerprint
}

export const parseSelfCertifyingRoomId = (
  roomId: string
): {baseRoomId: string; fingerprint: string | null} => {
  const m = selfCertifyingRoomRegex.exec(roomId)
  return m?.[1] && m[2]
    ? {baseRoomId: m[1], fingerprint: m[2]}
    : {baseRoomId: roomId, fingerprint: null}
}

export const formatSelfCertifyingRoomId = (base: string, fp: string): string =>
  `${parseSelfCertifyingRoomId(base).baseRoomId}~${fp}`

export type AdminRoomInfo = {
  roomId: string
  baseRoomId: string
  fingerprint: string
  userId: string
  identity: UserIdentity
}

export const createAdminRoom = async (
  appId: string,
  baseRoomId: string,
  options?: {identity?: UserIdentityConfig}
): Promise<AdminRoomInfo> => {
  if (typeof appId !== 'string' || !appId.trim()) {
    throw requiredErr('createAdminRoom: appId')
  }
  if (typeof baseRoomId !== 'string' || !baseRoomId.trim()) {
    throw requiredErr('createAdminRoom: baseRoomId')
  }
  const {baseRoomId: cleanBase} = parseSelfCertifyingRoomId(baseRoomId)
  const identity = await resolveUserIdentity(appId, cleanBase, {
    identity: options?.identity ?? 'local'
  })
  const fingerprint = computeUserIdFingerprint(identity.userId)
  return {
    roomId: formatSelfCertifyingRoomId(cleanBase, fingerprint),
    baseRoomId: cleanBase,
    fingerprint,
    userId: identity.userId,
    identity
  }
}

const normalizeRolesConfig = (config?: RolesConfig): RolesConfig => {
  if (isObj(config)) {
    for (const k of keys(config)) {
      if (k !== 'selfAsAdmin' && k !== 'admins') {
        throw mkErr(`Unknown roles config option "${k}"`)
      }
    }
  }
  return {
    ...(config?.selfAsAdmin ? {selfAsAdmin: true} : {}),
    ...(config?.admins?.length ? {admins: [...config.admins]} : {})
  }
}

export const isSelfAsAdminPlugin = (use?: RoomPlugin | RoomPlugin[]): boolean =>
  Boolean(
    use &&
    (Array.isArray(use) ? use : [use]).some(
      p =>
        isObj(p) &&
        p['name'] === 'roles' &&
        (p as Record<string, unknown>)['selfAsAdmin'] === true
    )
  )

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
    certId: genId(16),
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
  rootFps: Set<string>,
  rootUids?: Set<string>
): Promise<{valid: boolean; roles: string[]}> => {
  if (
    !validateRoleCertificateShape(cert) ||
    cert.appId !== appId ||
    cert.roomId !== roomId ||
    cert.iat > Date.now() + maxClockSkewMs
  ) {
    return {valid: false, roles: []}
  }
  const iss = await getVerifiedPubKeyRecord(cert.issuerPubKey)
  if (!iss || (!rootFps.has(iss.fingerprint) && !rootUids?.has(iss.userId))) {
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
  rootFps: Set<string>,
  rootUids?: Set<string>
): Promise<boolean> => {
  if (
    rec.appId !== appId ||
    rec.roomId !== roomId ||
    rec.ts > Date.now() + maxClockSkewMs ||
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
    rootFps,
    rootUids
  )
  return certRes.valid && (await verifySig(rec.signerPubKey, payload, rec.sig))
}

export const verifyRoleRevocation = async (
  rev: RoleRevocationRecord,
  appId: string,
  roomId: string,
  rootFps: Set<string>,
  rootUids?: Set<string>
): Promise<boolean> =>
  validateRoleRevocationShape(rev) &&
  verifyAdminRec(
    rev,
    revocationCanonicalPayload(rev),
    appId,
    roomId,
    rootFps,
    rootUids
  )

export const verifyPeerBan = async (
  ban: PeerBanRecord,
  appId: string,
  roomId: string,
  rootFps: Set<string>,
  rootUids?: Set<string>
): Promise<boolean> =>
  validatePeerBanShape(ban) &&
  verifyAdminRec(
    ban,
    banCanonicalPayload(ban),
    appId,
    roomId,
    rootFps,
    rootUids
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
  if (!isBlob && (tag !== 0x02 || totalLen <= digestChunkBytes)) {
    return packDigest(tag, rawB, metaB)
  }
  const nChunks = Math.ceil(totalLen / digestChunkBytes)
  const body = new Uint8Array(4 + nChunks * 32)
  new DataView(body.buffer).setUint32(0, totalLen, false)
  for (let i = 0, off = 0; off < totalLen; i++, off += digestChunkBytes) {
    const end = Math.min(off + digestChunkBytes, totalLen)
    const part = isBlob
      ? new Uint8Array(await data.slice(off, end).arrayBuffer())
      : rawB.subarray(off, end)
    body.set(await sha256(part as BufferSource), 4 + i * 32)
  }
  return packDigest(0x02, body, metaB)
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
  rootFingerprints: Set<string>
  rootUserIds?: Set<string>
  skipDigestCheck?: boolean
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
    p.rootFingerprints,
    p.rootUserIds
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

const canonicalizeJson = (val: JsonValue): string =>
  val === null || typeof val !== 'object'
    ? toJson(val)
    : Array.isArray(val)
      ? `[${val.map(canonicalizeJson).join(',')}]`
      : `{${keys(val)
          .sort()
          .map(k => `${toJson(k)}:${canonicalizeJson(val[k] as JsonValue)}`)
          .join(',')}}`

const stateRecordPayload = (
  r: Omit<AuthoritativeStateRecord, 'sig' | 'hash'>
): string =>
  canonTag('state-record', [
    r.v,
    r.appId,
    r.roomId,
    r.namespace,
    r.seq,
    r.prevHash,
    r.ts,
    r.updatedBy,
    r.userId,
    r.cert.sig,
    canonicalizeJson(r.value)
  ])

const computeStateHash = async (payload: string): Promise<string> =>
  toHex((await sha256(payload)).subarray(0, 16))

export const validateStateRecordShape = (
  r: unknown
): r is AuthoritativeStateRecord =>
  isObj(r) &&
  r['v'] === 1 &&
  hasStrs(r, ['appId', 'roomId', 'namespace', 'updatedBy', 'userId']) &&
  isPosInt(r['seq']) &&
  typeof r['prevHash'] === 'string' &&
  hex32Re.test(r['prevHash']) &&
  isPosInt(r['ts']) &&
  isValidJwk(r['signerPubKey']) &&
  validateRoleCertificateShape(r['cert']) &&
  r['value'] !== undefined &&
  hasFiniteNums(r['value']) &&
  isValidSig(r['sig']) &&
  typeof r['hash'] === 'string' &&
  hex32Re.test(r['hash'])

export type StateSignParams<T = JsonValue> = {
  appId: string
  roomId: string
  namespace: string
  seq: number
  prevHash: string
  ts?: number
  updatedBy: string
  userId?: string
  value: T
  now?: number
}

export const signStateRecord = async <T = JsonValue>(
  signer: Signer,
  pubJwk: JsonWebKey,
  cert: RoleCertificate,
  p: StateSignParams<T>
): Promise<AuthoritativeStateRecord<T>> => {
  const u: Omit<AuthoritativeStateRecord<T>, 'sig' | 'hash'> = {
    v: 1,
    appId: p.appId,
    roomId: p.roomId,
    namespace: p.namespace,
    seq: p.seq,
    prevHash: p.prevHash,
    ts: p.ts ?? p.now ?? nextMonotonicTs(),
    updatedBy: p.updatedBy,
    userId: p.userId ?? cert.subUserId,
    signerPubKey: toCleanJwk(pubJwk),
    cert,
    value: p.value
  }
  const canon = stateRecordPayload(
    u as Omit<AuthoritativeStateRecord, 'sig' | 'hash'>
  )
  const [sig, hash] = await Promise.all([
    signWith(signer, canon),
    computeStateHash(canon)
  ])
  return {...u, sig, hash}
}

export const verifyStateRecord = async (
  rec: AuthoritativeStateRecord,
  appId: string,
  roomId: string,
  requiredRoles: readonly string[],
  rootFps: Set<string>,
  rootUids?: Set<string>
): Promise<boolean> => {
  if (
    !validateStateRecordShape(rec) ||
    rec.appId !== appId ||
    rec.roomId !== roomId ||
    rec.ts > Date.now() + maxClockSkewMs ||
    rec.cert.subUserId !== rec.userId
  ) {
    return false
  }
  const signer = await getVerifiedPubKeyRecord(rec.signerPubKey)
  if (!signer || signer.userId !== rec.userId) {
    return false
  }
  const certRes = await verifyRoleCertificate(
    rec.cert,
    appId,
    roomId,
    rootFps,
    rootUids
  )
  if (!certRes.valid || !requiredRoles.some(r => certRes.roles.includes(r))) {
    return false
  }
  const canon = stateRecordPayload(rec)
  return (
    (await computeStateHash(canon)) === rec.hash &&
    (await verifySig(rec.signerPubKey, canon, rec.sig))
  )
}

export const compareStateRecords = (
  a: AuthoritativeStateRecord,
  b: AuthoritativeStateRecord
): number => {
  if (a.seq !== b.seq) {
    return a.seq - b.seq
  }
  if (a.ts !== b.ts) {
    return a.ts - b.ts
  }
  const ak = a.userId || a.updatedBy
  const bk = b.userId || b.updatedBy
  return ak !== bk
    ? ak < bk
      ? -1
      : 1
    : a.hash < b.hash
      ? -1
      : a.hash > b.hash
        ? 1
        : 0
}

type StateSlot = {
  namespace: string
  value: JsonValue
  record: AuthoritativeStateRecord | null
  requiredRoles: string[]
  validate?:
    | ((next: JsonValue, prev: JsonValue, ctx: StateChangeContext) => boolean)
    | undefined
  onChange:
    | ((val: JsonValue, prev: JsonValue, ctx: StateChangeContext) => void)
    | null
  api: unknown
  writeChain: Promise<void>
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
  | {t: 'cert'; cert: RoleCertificate}
  | {t: 'revoke'; revocation: RoleRevocationRecord}
  | {t: 'ban'; ban: PeerBanRecord}
  | {t: 'state'; record: AuthoritativeStateRecord}

export type RoomAuthority = Omit<
  KernelRolesProvider,
  'onPeerDescriptorCert'
> & {
  verifyAndApplyCert: (cert: RoleCertificate) => Promise<boolean>
  verifyAndApplyRevocation: (rev: RoleRevocationRecord) => Promise<boolean>
  verifyAndApplyBan: (ban: PeerBanRecord) => Promise<boolean>
  verifyAndApplyStateRecord: (rec: AuthoritativeStateRecord) => Promise<boolean>
  buildSyncMessage: (forceFull?: boolean) => Promise<AuthControlMessage | null>
  makeState: <T extends JsonValue>(
    namespace: string,
    initialValue: T,
    config: StateConfig<Widen<T>> | undefined,
    broadcastState: (rec: AuthoritativeStateRecord) => void
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
  onPeerBanned?: (userId: string) => void
  onSignatureFailure?: () => void
}

export const createRoomAuthority = (init: RoomAuthorityInit): RoomAuthority => {
  const {selfId, appId, initialRoomId} = init
  const admin = normalizeRolesConfig(init.admin)
  const certs = new Map<string, RoleCertificate>()
  const revocations = new Map<string, RoleRevocationRecord[]>()
  const allRevocations = new Map<string, RoleRevocationRecord>()
  const bans = new Map<string, PeerBanRecord>()
  const peerToUserId = new Map<string, string>()
  const stateSlots = new Map<string, StateSlot>()
  const latestStates = new Map<string, AuthoritativeStateRecord>()
  const lastSeenActionSeq = new Map<string, number>()

  let localCert: RoleCertificate | null = null
  let localModSeq = 0
  let localActSeq = 0
  let effectiveRoomId = initialRoomId
  let {baseRoomId, fingerprint} = parseSelfCertifyingRoomId(initialRoomId)
  const rootFps = new Set<string>(fingerprint ? [fingerprint] : [])
  const rootUids = new Set<string>()
  let localUser: UserIdentity | null = null
  for (const raw of admin.admins ?? []) {
    const e = raw.trim()
    if (/^[0-9A-Za-z]{16}$/.test(e)) {
      rootFps.add(e)
    } else if (e) {
      rootUids.add(e)
    }
  }

  const failSig = (): false => (init.onSignatureFailure?.(), false)
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

  const isRootUid = (uid: string): boolean =>
    rootUids.has(uid) ||
    (isValidUserId(uid) && rootFps.has(computeUserIdFingerprint(uid)))

  const effectiveRoles = (cert: RoleCertificate): string[] => {
    const revoked = new Set<string>()
    for (const r of revocations.get(cert.subUserId) ?? []) {
      if (r.targetCertId === cert.certId || r.ts >= cert.iat) {
        if (!r.role || r.role === '*') {
          return []
        }
        revoked.add(r.role)
      }
    }
    return cert.roles.filter(role => !revoked.has(role))
  }

  const toStateCtx = (
    r: AuthoritativeStateRecord,
    roles = effectiveRoles(r.cert)
  ): StateChangeContext => ({
    updatedBy: r.updatedBy,
    userId: r.userId,
    roles,
    seq: r.seq,
    timestamp: r.ts,
    hash: r.hash
  })

  const getPeerRoles = (peerOrUserId = selfId): string[] => {
    for (const uid of candidateUids(peerOrUserId)) {
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

  const isPeerBanned = (peerOrUserId: string): boolean =>
    Boolean(
      init.isOverlayPeerBanned?.(peerOrUserId) ||
      candidateUids(peerOrUserId).some(uid => bans.has(uid))
    )

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
      if (bans.has(rec.userId)) {
        init.onPeerBanned?.(rec.userId)
      }
    })
  }

  let resolvedP: Promise<void> | null = null
  const ensureResolved = (): Promise<void> =>
    (resolvedP ??= (async () => {
      localUser = init.getLocalUserIdentity
        ? await init.getLocalUserIdentity()
        : null
      const localFp = localUser
        ? computeUserIdFingerprint(localUser.userId)
        : null
      if (!fingerprint && admin.selfAsAdmin && localUser && localFp) {
        fingerprint = localFp
        baseRoomId = initialRoomId
        effectiveRoomId = formatSelfCertifyingRoomId(initialRoomId, fingerprint)
        rootFps.add(fingerprint)
        rootUids.add(localUser.userId)
        init.onRoomIdResolved?.(effectiveRoomId)
      }
      if (!localUser) {
        return
      }
      peerToUserId.set(selfId, localUser.userId)
      if (
        rootUids.has(localUser.userId) ||
        (localFp !== null && rootFps.has(localFp))
      ) {
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
        certs.set(localUser.userId, rootCert)
        localCert = rootCert
        init.onLocalRoleCertificate?.(rootCert)
      } else if (certs.has(localUser.userId)) {
        localCert = certs.get(localUser.userId)!
        init.onLocalRoleCertificate?.(localCert)
      }
    })())
  void ensureResolved().catch(noOp)

  const guardApply = (fn: () => Promise<boolean>): Promise<boolean> =>
    ensureResolved().then(fn).catch(failSig)

  const verifyAndApplyCert = (cert: RoleCertificate): Promise<boolean> =>
    guardApply(async () => {
      const res = await verifyRoleCertificate(
        cert,
        appId,
        effectiveRoomId,
        rootFps,
        rootUids
      )
      if (!res.valid) {
        return failSig()
      }
      const prev = certs.get(cert.subUserId)
      if (prev && (prev.sig === cert.sig || prev.iat >= cert.iat)) {
        return false
      }
      certs.set(cert.subUserId, cert)
      if (localUser && cert.subUserId === localUser.userId) {
        localCert = cert
        init.onLocalRoleCertificate?.(cert)
      }
      return true
    })

  const canAdminActOn = (rec: RoleRevocationRecord | PeerBanRecord): boolean =>
    effectiveRoles(rec.issuerCert).includes('admin') &&
    (!isRootUid(rec.targetUserId) || isRootUid(rec.issuerUserId))

  const verifyAndApplyRevocation = (
    rev: RoleRevocationRecord
  ): Promise<boolean> =>
    guardApply(async () => {
      if (
        !(await verifyRoleRevocation(
          rev,
          appId,
          effectiveRoomId,
          rootFps,
          rootUids
        )) ||
        !canAdminActOn(rev)
      ) {
        return failSig()
      }
      if (allRevocations.has(rev.sig)) {
        return false
      }
      if (!certs.has(rev.issuerUserId)) {
        certs.set(rev.issuerUserId, rev.issuerCert)
      }
      allRevocations.set(rev.sig, rev)
      const list = revocations.get(rev.targetUserId) ?? []
      list.push(rev)
      revocations.set(rev.targetUserId, list)
      if (
        localCert &&
        rev.targetUserId === localCert.subUserId &&
        !effectiveRoles(localCert).length
      ) {
        localCert = null
        init.onLocalRoleCertificate?.(null)
      }
      return true
    })

  const verifyAndApplyBan = (ban: PeerBanRecord): Promise<boolean> =>
    guardApply(async () => {
      if (
        !(await verifyPeerBan(
          ban,
          appId,
          effectiveRoomId,
          rootFps,
          rootUids
        )) ||
        !canAdminActOn(ban)
      ) {
        return failSig()
      }
      const prev = bans.get(ban.targetUserId)
      if (prev && (prev.sig === ban.sig || prev.ts >= ban.ts)) {
        return false
      }
      if (!certs.has(ban.issuerUserId)) {
        certs.set(ban.issuerUserId, ban.issuerCert)
      }
      bans.set(ban.targetUserId, ban)
      init.onPeerBanned?.(ban.targetUserId)
      return true
    })

  const verifyAndApplyStateRecord = (
    rec: AuthoritativeStateRecord
  ): Promise<boolean> =>
    guardApply(async () => {
      const slot = stateSlots.get(rec?.namespace)
      const reqRoles = slot?.requiredRoles ?? ['admin']
      const ok = await verifyStateRecord(
        rec,
        appId,
        effectiveRoomId,
        reqRoles,
        rootFps,
        rootUids
      )
      const roles = ok ? effectiveRoles(rec.cert) : []
      if (
        !ok ||
        isPeerBanned(rec.userId) ||
        !roles.some(r => reqRoles.includes(r))
      ) {
        return failSig()
      }
      if (!certs.has(rec.userId)) {
        certs.set(rec.userId, rec.cert)
      }
      const cur = slot?.record ?? latestStates.get(rec.namespace)
      if (cur) {
        if (compareStateRecords(rec, cur) <= 0) {
          return false
        }
        if (
          (rec.userId === cur.userId || rec.updatedBy === cur.updatedBy) &&
          rec.seq === cur.seq + 1 &&
          rec.prevHash !== cur.hash
        ) {
          return failSig()
        }
      } else if (rec.seq === 1 && rec.prevHash !== zeroHash) {
        return failSig()
      }
      if (slot) {
        const prevVal = slot.value
        const ctx = toStateCtx(rec, roles)
        if (slot.validate && !slot.validate(rec.value, prevVal, ctx)) {
          return failSig()
        }
        slot.record = rec
        slot.value = rec.value
        latestStates.set(rec.namespace, rec)
        slot.onChange?.(rec.value, prevVal, ctx)
      } else {
        latestStates.set(rec.namespace, rec)
      }
      return true
    })

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
    const res = await verifyActionAuth(env, {
      appId,
      roomId: effectiveRoomId,
      namespace,
      peerId,
      data,
      requiredRoles,
      rootFingerprints: rootFps,
      rootUserIds: rootUids,
      ...(isOffer ? {skipDigestCheck: true} : {})
    })
    const roles = res.valid ? effectiveRoles(env.cert) : []
    const replayKey = `${peerId}\u0000${namespace}`
    const prevSeq = lastSeenActionSeq.get(replayKey)
    if (
      !res.valid ||
      (!isOffer && prevSeq !== undefined && env.seq <= prevSeq) ||
      !requiredRoles.some(r => roles.includes(r))
    ) {
      return {valid: false, roles: []}
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
    getAuthorityInfo: async () => {
      await ensureResolved()
      const roles = getPeerRoles(selfId)
      return {
        userId: localUser?.userId ?? resolveUid(selfId),
        roomId: effectiveRoomId,
        baseRoomId,
        fingerprint,
        isAdmin: roles.includes('admin'),
        roles
      }
    },
    getPeerRoles,
    isPeerBanned,
    registerPeerPublicKey,
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
      return verifyAndApplyCert(inlineCert).then(ok => {
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
      const certList = [...certs.values()]
      const revList = [...allRevocations.values()]
      const banList = [...bans.values()]
      const stateList = [...latestStates.values()]
      if (
        !forceFull &&
        !certList.length &&
        !revList.length &&
        !banList.length &&
        !stateList.length
      ) {
        return {t: 'sync' as const, pubKey: localUser.signPubJwk}
      }
      return {
        t: 'sync' as const,
        pubKey: localUser.signPubJwk,
        ...(certList.length ? {certs: certList} : {}),
        ...(revList.length ? {revocations: revList} : {}),
        ...(banList.length ? {bans: banList} : {}),
        ...(stateList.length ? {states: stateList} : {})
      }
    },
    makeState: <T extends JsonValue>(
      namespace: string,
      initialValue: T,
      config: StateConfig<Widen<T>> | undefined,
      broadcastState: (rec: AuthoritativeStateRecord) => void
    ): AuthoritativeState<Widen<T>> => {
      type W = Widen<T>
      if (!isStr(namespace)) {
        throw mkErr('makeState requires a non-empty namespace string')
      }
      const existing = stateSlots.get(namespace)
      if (existing) {
        return existing.api as AuthoritativeState<W>
      }
      const requiredRoles = config?.roles
        ? Array.isArray(config.roles)
          ? [...config.roles]
          : [config.roles]
        : ['admin']
      const slot: StateSlot = {
        namespace,
        value: initialValue,
        record: null,
        requiredRoles,
        ...(config?.validate
          ? {validate: config.validate as StateSlot['validate']}
          : {}),
        onChange: null,
        api: null as unknown as AuthoritativeState<JsonValue>,
        writeChain: Promise.resolve()
      }
      const api: AuthoritativeState<W> = {
        get: () => slot.value as W,
        set: (nextOrFn: W | ((prev: W) => W)) => {
          const op = slot.writeChain.then(async () => {
            await ensureResolved()
            const myRoles = getPeerRoles(selfId)
            if (!slot.requiredRoles.some(r => myRoles.includes(r))) {
              throw mkErr(
                `${insufficientAuthPrefix} to update state "${namespace}": requires [${slot.requiredRoles.join(', ')}]`
              )
            }
            if (!localCert || !localUser) {
              throw mkErr(
                `missing local role certificate for state "${namespace}"`
              )
            }
            const prevVal = slot.value as W
            const nextVal =
              typeof nextOrFn === 'function'
                ? (nextOrFn as (prev: W) => W)(prevVal)
                : nextOrFn
            if (!hasFiniteNums(nextVal)) {
              throw mkErr(
                `state "${namespace}" value must contain only finite JSON numbers`
              )
            }
            const rec = await signStateRecord<W>(
              localUser.sign,
              localUser.signPubJwk,
              localCert,
              {
                appId,
                roomId: effectiveRoomId,
                namespace,
                seq: (slot.record?.seq ?? 0) + 1,
                prevHash: slot.record?.hash ?? zeroHash,
                updatedBy: selfId,
                userId: localUser.userId,
                value: nextVal
              }
            )
            const ctx = toStateCtx(rec, myRoles)
            if (config?.validate && !config.validate(nextVal, prevVal, ctx)) {
              throw mkErr(`state validation failed for "${namespace}"`)
            }
            slot.record = rec
            slot.value = nextVal
            latestStates.set(namespace, rec)
            slot.onChange?.(nextVal, prevVal, ctx)
            broadcastState(rec)
          })
          slot.writeChain = op.catch(noOp)
          return op
        },
        getMeta: () => (slot.record ? toStateCtx(slot.record) : null),
        get onChange() {
          return slot.onChange as AuthoritativeState<W>['onChange']
        },
        set onChange(fn: AuthoritativeState<W>['onChange']) {
          slot.onChange = fn as StateSlot['onChange']
        }
      }
      slot.api = api
      stateSlots.set(namespace, slot)
      const prevRec = latestStates.get(namespace)
      if (prevRec) {
        const ctx = toStateCtx(prevRec)
        if (
          ctx.roles.some(r => requiredRoles.includes(r)) &&
          (!slot.validate || slot.validate(prevRec.value, slot.value, ctx))
        ) {
          slot.record = prevRec
          slot.value = prevRec.value
        }
      }
      return api
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
      if (isRootUid(targetUid) && !isRootUid(user.userId)) {
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
      if (isRootUid(targetUid) && !isRootUid(user.userId)) {
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
        !parseSelfCertifyingRoomId(roomId).fingerprint &&
        userIdentityP
      ) {
        const user = await userIdentityP
        return {
          effectiveRoomId: formatSelfCertifyingRoomId(
            roomId,
            computeUserIdFingerprint(user.userId)
          )
        }
      }
      return {effectiveRoomId: roomId}
    },
    setup: kernel => {
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
        onPeerBanned: bannedUid => {
          kernel.getScaleProvider()?.markPeerBanned(bannedUid)
          const toKick = new Set<string>(kernel.getUserPeerIds(bannedUid))
          for (const pid of kernel.getAllPeerIds()) {
            if (authority.isPeerBanned(pid)) {
              toKick.add(pid)
            }
          }
          for (const pid of toKick) {
            kernel.getScaleProvider()?.markPeerBanned(pid)
            kernel.kickPeer(pid, peerBannedErr)
          }
        },
        onSignatureFailure: () =>
          kernel.getScaleProvider()?.recordSignatureFailure()
      })

      const rawAuth = kernel.makeInternalAction<JsonValue>('auth', {
        maxPayloadBytes: 256 * 1024
      })
      const sendAuth = (msg: AuthControlMessage, targets?: string | string[]) =>
        rawAuth.send(msg as unknown as JsonValue, targets)
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
        if (!isObj(msg) || authority.isPeerBanned(fromPeerId)) {
          return
        }
        if (msg.t === 'sync') {
          if (msg.pubKey) {
            authority.registerPeerPublicKey(fromPeerId, msg.pubKey)
          }
          void (async () => {
            const certs: RoleCertificate[] = []
            const revocations: RoleRevocationRecord[] = []
            const bans: PeerBanRecord[] = []
            for (const c of msg.certs ?? []) {
              if (await authority.verifyAndApplyCert(c)) {
                certs.push(c)
              }
            }
            for (const r of msg.revocations ?? []) {
              if (await authority.verifyAndApplyRevocation(r)) {
                revocations.push(r)
              }
            }
            for (const b of msg.bans ?? []) {
              if (await authority.verifyAndApplyBan(b)) {
                bans.push(b)
              }
            }
            for (const s of msg.states ?? []) {
              await authority.verifyAndApplyStateRecord(s)
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
          void authority.verifyAndApplyCert(msg.cert)
        } else if (msg.t === 'revoke') {
          void authority.verifyAndApplyRevocation(msg.revocation)
        } else if (msg.t === 'ban') {
          void authority.verifyAndApplyBan(msg.ban)
        } else if (msg.t === 'state') {
          void authority.verifyAndApplyStateRecord(msg.record)
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
            void authority.verifyAndApplyCert(cert)
          }
        }
      })

      kernel.onPeerActivated(pid => void sendSync(pid, true))
      for (const pid of kernel.getActivePeerIds()) {
        void sendSync(pid, true)
      }

      return {
        makeState: (ns, initVal, stateCfg) =>
          authority.makeState(
            ns,
            initVal,
            stateCfg,
            rec => void sendAuth({t: 'state', record: rec}).catch(noOp)
          ),
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
  })
  return normalized.selfAsAdmin ? {...plugin, selfAsAdmin: true} : plugin
}
