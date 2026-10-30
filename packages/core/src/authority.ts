import {ecdsaSign, normalizeLowSP256Signature, sha256} from './crypto'
import {
  canonicalizePubJwk,
  getVerifiedPubKeyRecord,
  isValidUserId,
  pubJwkToUncompressedBytes,
  verifyWithP256
} from './identity'
import {isValidSignalPeerId} from './signal-handler'
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
  Widen
} from './types'
import {
  authMetaKey,
  createBoundedCache,
  createBoundedSet,
  definePlugin,
  encodeBytes,
  fromBase64Url,
  insufficientAuthPrefix,
  keys,
  mkErr,
  noOp,
  peerBannedErr,
  posSafeIntErr,
  selfCertifyingRoomRegex,
  toBase64Url,
  toHex,
  toJson
} from './utils'

type Signer = CryptoKey | ((payload: Uint8Array) => MaybePromise<Uint8Array>)

const defaultMaxClockSkewMs = 60_000
const maxSyncCerts = 128
const maxSyncModerationRecords = 256
const maxSyncStates = 128
const maxStoredModerationRecords = 512
const maxRevocationsPerPairRole = 4
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
  mkErr(`${scope}: cannot ${verb} a root admin`)
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
      ? normalizeLowSP256Signature(await signer(b))
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
    canonicalizeJson(r.value),
    ...(r.epoch === undefined ? [] : [r.epoch])
  ])

const computeStateHash = async (payload: string): Promise<string> =>
  toHex((await sha256(payload)).subarray(0, 16))

export const validateStateRecordShape = (
  r: unknown
): r is AuthoritativeStateRecord =>
  isObj(r) &&
  r['v'] === 1 &&
  hasStrs(r, ['appId', 'roomId', 'namespace', 'updatedBy', 'userId']) &&
  isValidSignalPeerId(r['updatedBy']) &&
  isValidUserId(r['userId'] as string) &&
  isPosInt(r['seq']) &&
  (r['epoch'] === undefined || isPosInt(r['epoch'])) &&
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
  epoch?: number
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
    ...(p.epoch === undefined ? {} : {epoch: p.epoch}),
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
  rootUserIds: Set<string>,
  clockSkewMs: number = defaultMaxClockSkewMs
): Promise<boolean> => {
  if (
    !validateStateRecordShape(rec) ||
    rec.appId !== appId ||
    rec.roomId !== roomId ||
    rec.ts > Date.now() + clockSkewMs ||
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
    rootUserIds,
    clockSkewMs
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
  const ae = a.epoch ?? 0
  const be = b.epoch ?? 0
  if (ae !== be) {
    return ae - be
  }
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
  const stateSlots = new Map<string, StateSlot>()
  const latestStates = new Map<string, AuthoritativeStateRecord>()
  const lastSeenActionSeq = new Map<string, number>()
  const verifiedCertCache = createBoundedCache<string, string[]>(512)
  const verifiedActionSigCache = createBoundedSet(512)

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

  const recomputeModerationState = (): {
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

    for (const bannedUid of bans.keys()) {
      if (!prevBannedUids.has(bannedUid)) {
        init.onPeerBanned?.(bannedUid)
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
      if (!isRootUid(rec.userId) && bans.has(rec.userId)) {
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
      const {effectiveBanSigs} = recomputeModerationState()
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

  const verifyAndApplyStateRecord = (
    rec: AuthoritativeStateRecord,
    fromPeerId?: string
  ): Promise<boolean> =>
    guardApply(async () => {
      if (
        !validateStateRecordShape(rec) ||
        rec.appId !== appId ||
        rec.roomId !== effectiveRoomId ||
        rec.ts > Date.now() + clockSkewMs ||
        rec.cert.subUserId !== rec.userId ||
        (rec.seq === 1 && rec.prevHash !== zeroHash) ||
        isPeerBanned(rec.userId)
      ) {
        return failSig(fromPeerId)
      }
      const slot = stateSlots.get(rec.namespace)
      const reqRoles = slot?.requiredRoles ?? ['admin']
      const roles = effectiveRoles(rec.cert)
      if (!roles.some(r => reqRoles.includes(r))) {
        return failSig(fromPeerId)
      }
      const cur = slot?.record ?? latestStates.get(rec.namespace)
      if (cur) {
        if (compareStateRecords(rec, cur) <= 0) {
          return false
        }
        if (
          (rec.epoch ?? 0) === (cur.epoch ?? 0) &&
          (rec.userId === cur.userId || rec.updatedBy === cur.updatedBy) &&
          rec.seq === cur.seq + 1 &&
          rec.prevHash !== cur.hash
        ) {
          return failSig(fromPeerId)
        }
      }
      const signer = await getVerifiedPubKeyRecord(rec.signerPubKey)
      if (!signer || signer.userId !== rec.userId) {
        return failSig(fromPeerId)
      }
      const certRes = await verifyCertCached(rec.cert)
      if (!certRes.valid) {
        return failSig(fromPeerId)
      }
      const canon = stateRecordPayload(rec)
      if (
        (await computeStateHash(canon)) !== rec.hash ||
        !(await verifySig(rec.signerPubKey, canon, rec.sig))
      ) {
        return failSig(fromPeerId)
      }
      const latestCur = slot?.record ?? latestStates.get(rec.namespace)
      if (latestCur && compareStateRecords(rec, latestCur) <= 0) {
        return false
      }
      if (!certs.has(rec.userId)) {
        certs.set(rec.userId, rec.cert)
      }
      if (slot) {
        const prevVal = slot.value
        const ctx = toStateCtx(rec, roles)
        if (slot.validate && !slot.validate(rec.value, prevVal, ctx)) {
          return failSig(fromPeerId)
        }
        slot.record = rec
        slot.value = rec.value
        latestStates.set(rec.namespace, rec)
        slot.onChange?.(rec.value, prevVal, ctx)
      } else {
        latestStates.set(rec.namespace, rec)
      }
      return true
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
      const stateList = [...latestStates.values()].slice(0, maxSyncStates)
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
            const nextEpoch = slot.record
              ? (slot.record.epoch ?? 1)
              : nextMonotonicTs()
            const rec = await signStateRecord<W>(
              localUser.sign,
              localUser.signPubJwk,
              localCert,
              {
                appId,
                roomId: effectiveRoomId,
                namespace,
                seq: (slot.record?.seq ?? 0) + 1,
                epoch: nextEpoch,
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
            if (slot.record && compareStateRecords(rec, slot.record) <= 0) {
              broadcastState(rec)
              return
            }
            const currentPrevVal = slot.value as W
            if (
              currentPrevVal !== prevVal &&
              config?.validate &&
              !config.validate(nextVal, currentPrevVal, ctx)
            ) {
              throw mkErr(`state validation failed for "${namespace}"`)
            }
            slot.record = rec
            slot.value = nextVal
            latestStates.set(namespace, rec)
            slot.onChange?.(nextVal, currentPrevVal, ctx)
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
          kernel.kickPeer(
            fromPeerId,
            mkErr('excessive invalid authority records')
          )
        }
      }

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
        onSignatureFailure: recordPeerAuthFailure
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
              msg.bans.length > maxSyncModerationRecords) ||
            (Array.isArray(msg.states) && msg.states.length > maxSyncStates)
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
            for (const s of Array.isArray(msg.states)
              ? msg.states.slice(0, maxSyncStates)
              : []) {
              if (isAuthAbusive(fromPeerId)) {
                return
              }
              await authority.verifyAndApplyStateRecord(s, fromPeerId)
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
        } else if (msg.t === 'state') {
          void authority.verifyAndApplyStateRecord(msg.record, fromPeerId)
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
