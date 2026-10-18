import {hashWith} from './crypto'
import {
  all,
  decodeBytes,
  encodeBytes,
  fromJson,
  genId,
  mkErr,
  toHex,
  toJson
} from './utils'
import type {
  AdminIdentity,
  AuthorityConfig,
  AuthoritativeStateRecord,
  DataPayload,
  JsonValue,
  PeerBanRecord,
  RoleCertificate,
  RoleRevocationRecord
} from './types'

// NIST P-256 (secp256r1) parameters for deterministic secret-to-JWK derivation
const p256P =
  0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn
const p256N =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
const p256A = p256P - 3n
const p256Gx =
  0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n
const p256Gy =
  0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n

type Point = {x: bigint; y: bigint} | null

const mod = (a: bigint, m: bigint): bigint => ((a % m) + m) % m

const modInv = (a: bigint, m: bigint): bigint => {
  let [oldR, r] = [mod(a, m), m]
  let [oldS, s] = [1n, 0n]
  while (r !== 0n) {
    const q = oldR / r
    ;[oldR, r] = [r, oldR - q * r]
    ;[oldS, s] = [s, oldS - q * s]
  }
  return mod(oldS, m)
}

const pointAdd = (p1: Point, p2: Point): Point => {
  if (!p1) {
    return p2
  }
  if (!p2) {
    return p1
  }
  if (p1.x === p2.x) {
    if (p1.y !== p2.y || p1.y === 0n) {
      return null
    }
    const num = mod(3n * p1.x * p1.x + p256A, p256P)
    const den = modInv(2n * p1.y, p256P)
    const slope = mod(num * den, p256P)
    const x3 = mod(slope * slope - 2n * p1.x, p256P)
    const y3 = mod(slope * (p1.x - x3) - p1.y, p256P)
    return {x: x3, y: y3}
  }
  const num = mod(p2.y - p1.y, p256P)
  const den = modInv(p2.x - p1.x, p256P)
  const slope = mod(num * den, p256P)
  const x3 = mod(slope * slope - p1.x - p2.x, p256P)
  const y3 = mod(slope * (p1.x - x3) - p1.y, p256P)
  return {x: x3, y: y3}
}

const scalarMultP256Base = (scalar: bigint): {x: bigint; y: bigint} => {
  let result: Point = null
  let addend: Point = {x: p256Gx, y: p256Gy}
  let k = scalar
  while (k > 0n) {
    if (k & 1n) {
      result = pointAdd(result, addend)
    }
    addend = pointAdd(addend, addend)
    k >>= 1n
  }
  if (!result) {
    throw mkErr('invalid P-256 scalar')
  }
  return result
}

const bigintTo32Bytes = (n: bigint): Uint8Array => {
  const hex = n.toString(16).padStart(64, '0')
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

const bytesToBigInt = (bytes: Uint8Array): bigint => {
  let res = 0n
  for (const b of bytes) {
    res = (res << 8n) | BigInt(b)
  }
  return res
}

export const toBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')

export const fromBase64Url = (b64url: string): Uint8Array => {
  const padded = b64url.replace(/-/g, '+').replace(/_/g, '/')
  const padLen = (4 - (padded.length % 4)) % 4
  const bin = atob(padded + '='.repeat(padLen))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i)
  }
  return out
}

const adminKeyPrefix = 'trystero_ak_'

export const canonicalizePubJwk = (jwk: JsonWebKey): string =>
  toJson({
    crv: jwk.crv ?? 'P-256',
    kty: jwk.kty ?? 'EC',
    x: jwk.x ?? '',
    y: jwk.y ?? ''
  })

export const encodePublicKey = (jwk: JsonWebKey): string =>
  toBase64Url(encodeBytes(canonicalizePubJwk(jwk)))

export const decodePublicKey = (encoded: string): JsonWebKey | null => {
  try {
    if (encoded.trim().startsWith('{')) {
      const parsed = fromJson<JsonWebKey>(encoded)
      return parsed && parsed.kty === 'EC' && parsed.x && parsed.y
        ? parsed
        : null
    }
    const parsed = fromJson<JsonWebKey>(decodeBytes(fromBase64Url(encoded)))
    return parsed && parsed.kty === 'EC' && parsed.x && parsed.y ? parsed : null
  } catch {
    return null
  }
}

const base62Alphabet =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const base62Radix = 62n
const fingerprintLen = 16
const base62Modulus = base62Radix ** BigInt(fingerprintLen)
const fingerprintRegex = /^[0-9A-Za-z]{16}$/
const selfCertifyingRoomRegex = /^(.*)\.([0-9A-Za-z]{16})$/

const toBase62Fingerprint = (digestBytes: Uint8Array): string => {
  let val = bytesToBigInt(digestBytes.subarray(0, 16)) % base62Modulus
  let out = ''
  for (let i = 0; i < fingerprintLen; i++) {
    out = base62Alphabet[Number(val % base62Radix)]! + out
    val /= base62Radix
  }
  return out
}

export const computePublicKeyFingerprint = async (
  pubKeyOrJwk: JsonWebKey | string
): Promise<string> => {
  const jwk =
    typeof pubKeyOrJwk === 'string' ? decodePublicKey(pubKeyOrJwk) : pubKeyOrJwk
  if (!jwk) {
    throw mkErr('invalid ECDSA P-256 public key')
  }
  const digest = await hashWith('SHA-256', canonicalizePubJwk(jwk))
  return toBase62Fingerprint(digest)
}

export const parseSelfCertifyingRoomId = (
  roomId: string
): {baseRoomId: string; fingerprint: string | null} => {
  const match = selfCertifyingRoomRegex.exec(roomId)
  if (!match || !match[1] || !match[2]) {
    return {baseRoomId: roomId, fingerprint: null}
  }
  return {baseRoomId: match[1], fingerprint: match[2]}
}

export const formatSelfCertifyingRoomId = (
  baseRoomId: string,
  fingerprint: string
): string => {
  if (!fingerprintRegex.test(fingerprint)) {
    throw mkErr('fingerprint must be a 16-character Base62 string')
  }
  const parsed = parseSelfCertifyingRoomId(baseRoomId)
  if (parsed.fingerprint === fingerprint) {
    return baseRoomId
  }
  return `${baseRoomId}.${fingerprint}`
}

const importIdentityFromPrivateJwk = async (
  privJwk: JsonWebKey
): Promise<AdminIdentity> => {
  if (!privJwk.x || !privJwk.y || !privJwk.d) {
    throw mkErr('invalid private JWK for admin identity')
  }
  const pubJwk: JsonWebKey = {
    crv: 'P-256',
    ext: true,
    key_ops: ['verify'],
    kty: 'EC',
    x: privJwk.x,
    y: privJwk.y
  }
  const cleanPrivJwk: JsonWebKey = {
    crv: 'P-256',
    d: privJwk.d,
    ext: true,
    key_ops: ['sign'],
    kty: 'EC',
    x: privJwk.x,
    y: privJwk.y
  }
  const [signPrivateKey, signPublicKey, fingerprint] = await all([
    crypto.subtle.importKey(
      'jwk',
      cleanPrivJwk,
      {name: 'ECDSA', namedCurve: 'P-256'},
      true,
      ['sign']
    ),
    crypto.subtle.importKey(
      'jwk',
      pubJwk,
      {name: 'ECDSA', namedCurve: 'P-256'},
      true,
      ['verify']
    ),
    computePublicKeyFingerprint(pubJwk)
  ])
  const publicKey = encodePublicKey(pubJwk)
  const adminKey =
    adminKeyPrefix +
    toBase64Url(encodeBytes(toJson({d: privJwk.d, x: privJwk.x, y: privJwk.y})))

  return {
    publicKey,
    fingerprint,
    adminKey,
    signPrivateKey,
    signPublicKey,
    signPubJwk: {crv: 'P-256', kty: 'EC', x: privJwk.x, y: privJwk.y}
  }
}

const tryDecodeAdminKeyJwk = (token: string): JsonWebKey | null => {
  try {
    const raw = token.startsWith(adminKeyPrefix)
      ? token.slice(adminKeyPrefix.length)
      : token
    const parsed = fromJson<{d?: string; x?: string; y?: string}>(
      decodeBytes(fromBase64Url(raw))
    )
    if (
      parsed &&
      typeof parsed.d === 'string' &&
      typeof parsed.x === 'string' &&
      typeof parsed.y === 'string'
    ) {
      return {
        crv: 'P-256',
        d: parsed.d,
        kty: 'EC',
        x: parsed.x,
        y: parsed.y
      }
    }
    return null
  } catch {
    return null
  }
}

const identityFromSecretCache = new Map<string, Promise<AdminIdentity>>()
const generatedRoomIdentityCache = new Map<string, Promise<AdminIdentity>>()

export const createAdminIdentity = async (options?: {
  secret?: string
  passphrase?: string
  adminKey?: string
  appId?: string
  roomId?: string
}): Promise<AdminIdentity> => {
  const rawSecret = options?.secret ?? options?.passphrase
  const scopedSecret =
    rawSecret && (options?.appId || options?.roomId)
      ? `${options.appId ?? ''}:${options.roomId ?? ''}:${rawSecret}`
      : rawSecret
  const tokenOrSecret = options?.adminKey ?? scopedSecret
  if (typeof tokenOrSecret === 'string' && tokenOrSecret.length > 0) {
    const existing = identityFromSecretCache.get(tokenOrSecret)
    if (existing) {
      return existing
    }
    const promise = (async () => {
      if (options?.adminKey) {
        const decoded = tryDecodeAdminKeyJwk(options.adminKey)
        if (!decoded) {
          throw mkErr('invalid adminKey token')
        }
        return importIdentityFromPrivateJwk(decoded)
      }
      const maybeJwk = tokenOrSecret.startsWith(adminKeyPrefix)
        ? tryDecodeAdminKeyJwk(tokenOrSecret)
        : null
      if (maybeJwk) {
        return importIdentityFromPrivateJwk(maybeJwk)
      }

      // Deterministic derivation from passphrase secret
      const seedBytes = await hashWith(
        'SHA-256',
        `trystero-p256-admin-seed:v1:${tokenOrSecret}`
      )
      const dScalar = (bytesToBigInt(seedBytes) % (p256N - 1n)) + 1n
      const pubPoint = scalarMultP256Base(dScalar)
      const privJwk: JsonWebKey = {
        crv: 'P-256',
        d: toBase64Url(bigintTo32Bytes(dScalar)),
        kty: 'EC',
        x: toBase64Url(bigintTo32Bytes(pubPoint.x)),
        y: toBase64Url(bigintTo32Bytes(pubPoint.y))
      }
      return importIdentityFromPrivateJwk(privJwk)
    })()
    identityFromSecretCache.set(tokenOrSecret, promise)
    return promise
  }

  const keyPair = await crypto.subtle.generateKey(
    {name: 'ECDSA', namedCurve: 'P-256'},
    true,
    ['sign', 'verify']
  )
  const privJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey)
  return importIdentityFromPrivateJwk(privJwk)
}

export const createAdminRoom = async (
  baseRoomId: string,
  options?: {secret?: string; adminKey?: string}
): Promise<{
  roomId: string
  baseRoomId: string
  fingerprint: string
  publicKey: string
  adminKey: string
  identity: AdminIdentity
}> => {
  if (!baseRoomId || typeof baseRoomId !== 'string') {
    throw mkErr('baseRoomId is required')
  }
  const parsed = parseSelfCertifyingRoomId(baseRoomId)
  const cleanBase = parsed.baseRoomId
  const identity = await createAdminIdentity(options)
  const roomId = formatSelfCertifyingRoomId(cleanBase, identity.fingerprint)
  generatedRoomIdentityCache.set(roomId, Promise.resolve(identity))

  return {
    roomId,
    baseRoomId: cleanBase,
    fingerprint: identity.fingerprint,
    publicKey: identity.publicKey,
    adminKey: identity.adminKey,
    identity
  }
}

export type ResolvedRoomAuthority = {
  effectiveRoomId: string
  baseRoomId: string
  roomFingerprint: string | null
  rootPubKeys: Set<string>
  rootFingerprints: Set<string>
  localIdentity: AdminIdentity | null
  hasAuthorityAnchor: boolean
  signalingProofs: boolean
}

export const resolveRoomAuthority = async (
  rawRoomId: string,
  adminOption?: boolean | string | AuthorityConfig
): Promise<ResolvedRoomAuthority> => {
  const parsed = parseSelfCertifyingRoomId(rawRoomId)
  const rootPubKeys = new Set<string>()
  const rootFingerprints = new Set<string>()
  let localIdentity: AdminIdentity | null = null
  let effectiveRoomId = rawRoomId
  let roomFingerprint = parsed.fingerprint
  let signalingProofs = true

  if (parsed.fingerprint) {
    rootFingerprints.add(parsed.fingerprint)
  }

  if (adminOption === true) {
    if (parsed.fingerprint) {
      const cached = generatedRoomIdentityCache.get(rawRoomId)
      if (cached) {
        const id = await cached
        if (id.fingerprint === parsed.fingerprint) {
          localIdentity = id
          rootPubKeys.add(canonicalizePubJwk(id.signPubJwk))
        }
      }
    } else {
      localIdentity = await createAdminIdentity()
      roomFingerprint = localIdentity.fingerprint
      effectiveRoomId = formatSelfCertifyingRoomId(rawRoomId, roomFingerprint)
      rootFingerprints.add(roomFingerprint)
      rootPubKeys.add(canonicalizePubJwk(localIdentity.signPubJwk))
      generatedRoomIdentityCache.set(
        effectiveRoomId,
        Promise.resolve(localIdentity)
      )
    }
  } else if (typeof adminOption === 'string' && adminOption.length > 0) {
    localIdentity = await createAdminIdentity({secret: adminOption})
    rootPubKeys.add(canonicalizePubJwk(localIdentity.signPubJwk))
    rootFingerprints.add(localIdentity.fingerprint)
  } else if (adminOption && typeof adminOption === 'object') {
    if (adminOption.signalingProofs === false) {
      signalingProofs = false
    }
    if (adminOption.create) {
      if (!parsed.fingerprint) {
        localIdentity = await createAdminIdentity(
          typeof adminOption.credentials === 'string'
            ? {secret: adminOption.credentials}
            : undefined
        )
        roomFingerprint = localIdentity.fingerprint
        effectiveRoomId = formatSelfCertifyingRoomId(rawRoomId, roomFingerprint)
        rootFingerprints.add(roomFingerprint)
        rootPubKeys.add(canonicalizePubJwk(localIdentity.signPubJwk))
        generatedRoomIdentityCache.set(
          effectiveRoomId,
          Promise.resolve(localIdentity)
        )
      }
    }
    if (adminOption.credentials && !localIdentity) {
      localIdentity =
        typeof adminOption.credentials === 'string'
          ? await createAdminIdentity({secret: adminOption.credentials})
          : adminOption.credentials
      if (
        !adminOption.rootPubKeys?.length &&
        (!roomFingerprint || localIdentity.fingerprint === roomFingerprint)
      ) {
        rootPubKeys.add(canonicalizePubJwk(localIdentity.signPubJwk))
        rootFingerprints.add(localIdentity.fingerprint)
      }
    }
    if (Array.isArray(adminOption.rootPubKeys)) {
      for (const rk of adminOption.rootPubKeys) {
        if (fingerprintRegex.test(rk)) {
          rootFingerprints.add(rk)
        } else {
          const jwk = decodePublicKey(rk)
          if (jwk) {
            rootPubKeys.add(canonicalizePubJwk(jwk))
            rootFingerprints.add(await computePublicKeyFingerprint(jwk))
          }
        }
      }
    }
  }

  // If the room has a self-certifying fingerprint, ensure localIdentity matches it
  // (unless additional rootPubKeys were explicitly configured).
  if (
    localIdentity &&
    roomFingerprint &&
    !rootFingerprints.has(localIdentity.fingerprint) &&
    !rootPubKeys.has(canonicalizePubJwk(localIdentity.signPubJwk))
  ) {
    localIdentity = null
  }

  const hasAuthorityAnchor = rootFingerprints.size > 0 || rootPubKeys.size > 0

  return {
    effectiveRoomId,
    baseRoomId: parsed.baseRoomId,
    roomFingerprint,
    rootPubKeys,
    rootFingerprints,
    localIdentity,
    hasAuthorityAnchor,
    signalingProofs
  }
}

const verifyKeyImportCache = new Map<string, Promise<CryptoKey>>()

const importVerifyKeyFromCanonical = (
  canonicalJwk: string
): Promise<CryptoKey> => {
  let cached = verifyKeyImportCache.get(canonicalJwk)
  if (!cached) {
    const jwk = fromJson<JsonWebKey>(canonicalJwk)
    cached = crypto.subtle.importKey(
      'jwk',
      jwk,
      {name: 'ECDSA', namedCurve: 'P-256'},
      false,
      ['verify']
    )
    verifyKeyImportCache.set(canonicalJwk, cached)
  }
  return cached
}

const roleCertCanonicalPayload = (cert: Omit<RoleCertificate, 'sig'>): string =>
  toJson([
    cert.v,
    cert.certId,
    cert.issuerPubKey,
    cert.subPeerId,
    canonicalizePubJwk(cert.subPubKey),
    cert.appId,
    cert.roomId,
    cert.roles,
    Boolean(cert.canDelegate),
    Boolean(cert.isRoot),
    cert.iat,
    cert.exp ?? null,
    cert.parentCert ? cert.parentCert.sig : null
  ])

let lastAuthTimestamp = 0

const nextMonotonicTs = (): number => {
  const now = Date.now()
  lastAuthTimestamp = now > lastAuthTimestamp ? now : lastAuthTimestamp + 1
  return lastAuthTimestamp
}

export const signRoleCertificate = async (
  signerPrivateKey: CryptoKey,
  signerPubJwk: JsonWebKey,
  params: {
    subPeerId: string
    subPubKey: JsonWebKey
    appId: string
    roomId: string
    roles: string[]
    canDelegate?: boolean
    isRoot?: boolean
    expiresInMs?: number
    parentCert?: RoleCertificate
  }
): Promise<RoleCertificate> => {
  const now = nextMonotonicTs()
  const unsigned: Omit<RoleCertificate, 'sig'> = {
    v: 1,
    certId: genId(16),
    issuerPubKey: encodePublicKey(signerPubJwk),
    subPeerId: params.subPeerId,
    subPubKey: {
      crv: 'P-256',
      kty: 'EC',
      x: params.subPubKey.x ?? '',
      y: params.subPubKey.y ?? ''
    },
    appId: params.appId,
    roomId: params.roomId,
    roles: [...new Set(params.roles)].sort(),
    ...(params.canDelegate ? {canDelegate: true} : {}),
    ...(params.isRoot ? {isRoot: true} : {}),
    iat: now,
    ...(typeof params.expiresInMs === 'number'
      ? {exp: now + params.expiresInMs}
      : {}),
    ...(params.parentCert ? {parentCert: params.parentCert} : {})
  }

  const canonicalBytes = encodeBytes(roleCertCanonicalPayload(unsigned))
  const sigBuf = await crypto.subtle.sign(
    {name: 'ECDSA', hash: 'SHA-256'},
    signerPrivateKey,
    canonicalBytes as BufferSource
  )
  return {
    ...unsigned,
    sig: toBase64Url(new Uint8Array(sigBuf))
  }
}

export const verifyRoleCertificateChain = async (
  cert: RoleCertificate,
  appId: string,
  roomId: string,
  rootFingerprints: ReadonlySet<string>,
  rootPubKeys: ReadonlySet<string>,
  depth = 0
): Promise<{valid: boolean; isRoot: boolean; rootFingerprint?: string}> => {
  if (
    !cert ||
    cert.v !== 1 ||
    depth > 3 ||
    cert.appId !== appId ||
    cert.roomId !== roomId ||
    !Array.isArray(cert.roles) ||
    cert.roles.length === 0 ||
    !cert.subPeerId ||
    !cert.subPubKey ||
    typeof cert.sig !== 'string'
  ) {
    return {valid: false, isRoot: false}
  }

  if (typeof cert.exp === 'number' && Date.now() > cert.exp) {
    return {valid: false, isRoot: false}
  }

  const issuerJwk = decodePublicKey(cert.issuerPubKey)
  if (!issuerJwk) {
    return {valid: false, isRoot: false}
  }
  const issuerCanonical = canonicalizePubJwk(issuerJwk)
  const issuerFingerprint = await computePublicKeyFingerprint(issuerJwk)

  // Verify signature of this certificate
  try {
    const verifyKey = await importVerifyKeyFromCanonical(issuerCanonical)
    const canonicalBytes = encodeBytes(roleCertCanonicalPayload(cert))
    const ok = await crypto.subtle.verify(
      {name: 'ECDSA', hash: 'SHA-256'},
      verifyKey,
      fromBase64Url(cert.sig) as BufferSource,
      canonicalBytes as BufferSource
    )
    if (!ok) {
      return {valid: false, isRoot: false}
    }
  } catch {
    return {valid: false, isRoot: false}
  }

  const isTrustedRoot =
    rootFingerprints.has(issuerFingerprint) || rootPubKeys.has(issuerCanonical)

  if (isTrustedRoot) {
    return {
      valid: true,
      isRoot: Boolean(cert.isRoot && cert.roles.includes('admin')),
      rootFingerprint: issuerFingerprint
    }
  }

  // Otherwise must have a valid parent certificate that has canDelegate: true
  const parent = cert.parentCert
  if (!parent || !parent.canDelegate) {
    return {valid: false, isRoot: false}
  }

  if (canonicalizePubJwk(parent.subPubKey) !== issuerCanonical) {
    return {valid: false, isRoot: false}
  }

  // Parent can only delegate roles it possesses (unless parent holds 'admin')
  if (
    !parent.roles.includes('admin') &&
    !cert.roles.every(r => parent.roles.includes(r))
  ) {
    return {valid: false, isRoot: false}
  }

  const parentResult = await verifyRoleCertificateChain(
    parent,
    appId,
    roomId,
    rootFingerprints,
    rootPubKeys,
    depth + 1
  )
  return {
    valid: parentResult.valid,
    isRoot: false,
    ...(parentResult.rootFingerprint
      ? {rootFingerprint: parentResult.rootFingerprint}
      : {})
  }
}

export const revocationCanonicalPayload = (
  rev: Omit<RoleRevocationRecord, 'sig'>
): string =>
  toJson([
    rev.v,
    rev.appId,
    rev.roomId,
    rev.issuerPeerId,
    rev.targetPeerId,
    rev.role ?? null,
    rev.seq,
    rev.ts,
    rev.issuerCert.sig
  ])

export const signRoleRevocation = async (
  signerPrivateKey: CryptoKey,
  issuerCert: RoleCertificate,
  params: {
    appId: string
    roomId: string
    issuerPeerId: string
    targetPeerId: string
    role?: string
    seq: number
  }
): Promise<RoleRevocationRecord> => {
  const ts = nextMonotonicTs()
  const unsigned: Omit<RoleRevocationRecord, 'sig'> = {
    v: 1,
    appId: params.appId,
    roomId: params.roomId,
    issuerPeerId: params.issuerPeerId,
    targetPeerId: params.targetPeerId,
    ...(params.role ? {role: params.role} : {}),
    seq: params.seq,
    ts,
    issuerCert
  }
  const canonicalBytes = encodeBytes(revocationCanonicalPayload(unsigned))
  const sigBuf = await crypto.subtle.sign(
    {name: 'ECDSA', hash: 'SHA-256'},
    signerPrivateKey,
    canonicalBytes as BufferSource
  )
  return {
    ...unsigned,
    sig: toBase64Url(new Uint8Array(sigBuf))
  }
}

export const verifyRoleRevocation = async (
  rev: RoleRevocationRecord,
  appId: string,
  roomId: string,
  rootFingerprints: ReadonlySet<string>,
  rootPubKeys: ReadonlySet<string>
): Promise<boolean> => {
  if (
    !rev ||
    rev.v !== 1 ||
    rev.appId !== appId ||
    rev.roomId !== roomId ||
    !rev.issuerPeerId ||
    !rev.targetPeerId ||
    typeof rev.seq !== 'number' ||
    !rev.issuerCert ||
    typeof rev.sig !== 'string'
  ) {
    return false
  }

  if (rev.issuerCert.subPeerId !== rev.issuerPeerId) {
    return false
  }

  if (!rev.issuerCert.roles.includes('admin') && !rev.issuerCert.canDelegate) {
    return false
  }

  const certRes = await verifyRoleCertificateChain(
    rev.issuerCert,
    appId,
    roomId,
    rootFingerprints,
    rootPubKeys
  )
  if (!certRes.valid) {
    return false
  }

  try {
    const verifyKey = await importVerifyKeyFromCanonical(
      canonicalizePubJwk(rev.issuerCert.subPubKey)
    )
    const canonicalBytes = encodeBytes(revocationCanonicalPayload(rev))
    return await crypto.subtle.verify(
      {name: 'ECDSA', hash: 'SHA-256'},
      verifyKey,
      fromBase64Url(rev.sig) as BufferSource,
      canonicalBytes as BufferSource
    )
  } catch {
    return false
  }
}

export const banCanonicalPayload = (ban: Omit<PeerBanRecord, 'sig'>): string =>
  toJson([
    ban.v,
    ban.appId,
    ban.roomId,
    ban.issuerPeerId,
    ban.targetPeerId,
    ban.targetKeyThumbprint ?? null,
    ban.reason ?? null,
    ban.seq,
    ban.ts,
    ban.issuerCert.sig
  ])

export const signPeerBan = async (
  signerPrivateKey: CryptoKey,
  issuerCert: RoleCertificate,
  params: {
    appId: string
    roomId: string
    issuerPeerId: string
    targetPeerId: string
    targetKeyThumbprint?: string
    reason?: string
    seq: number
  }
): Promise<PeerBanRecord> => {
  const ts = nextMonotonicTs()
  const unsigned: Omit<PeerBanRecord, 'sig'> = {
    v: 1,
    appId: params.appId,
    roomId: params.roomId,
    issuerPeerId: params.issuerPeerId,
    targetPeerId: params.targetPeerId,
    ...(params.targetKeyThumbprint
      ? {targetKeyThumbprint: params.targetKeyThumbprint}
      : {}),
    ...(params.reason ? {reason: params.reason} : {}),
    seq: params.seq,
    ts,
    issuerCert
  }
  const canonicalBytes = encodeBytes(banCanonicalPayload(unsigned))
  const sigBuf = await crypto.subtle.sign(
    {name: 'ECDSA', hash: 'SHA-256'},
    signerPrivateKey,
    canonicalBytes as BufferSource
  )
  return {
    ...unsigned,
    sig: toBase64Url(new Uint8Array(sigBuf))
  }
}

export const verifyPeerBan = async (
  ban: PeerBanRecord,
  appId: string,
  roomId: string,
  rootFingerprints: ReadonlySet<string>,
  rootPubKeys: ReadonlySet<string>
): Promise<boolean> => {
  if (
    !ban ||
    ban.v !== 1 ||
    ban.appId !== appId ||
    ban.roomId !== roomId ||
    !ban.issuerPeerId ||
    !ban.targetPeerId ||
    typeof ban.seq !== 'number' ||
    !ban.issuerCert ||
    typeof ban.sig !== 'string'
  ) {
    return false
  }

  if (ban.issuerCert.subPeerId !== ban.issuerPeerId) {
    return false
  }

  if (!ban.issuerCert.roles.includes('admin')) {
    return false
  }

  const certRes = await verifyRoleCertificateChain(
    ban.issuerCert,
    appId,
    roomId,
    rootFingerprints,
    rootPubKeys
  )
  if (!certRes.valid) {
    return false
  }

  try {
    const verifyKey = await importVerifyKeyFromCanonical(
      canonicalizePubJwk(ban.issuerCert.subPubKey)
    )
    const canonicalBytes = encodeBytes(banCanonicalPayload(ban))
    return await crypto.subtle.verify(
      {name: 'ECDSA', hash: 'SHA-256'},
      verifyKey,
      fromBase64Url(ban.sig) as BufferSource,
      canonicalBytes as BufferSource
    )
  } catch {
    return false
  }
}

export type ActionAuthEnvelope = {
  v: 1
  seq: number
  digest: string
  cert: RoleCertificate
  sig: string
}

export const computePayloadDigest = async (
  data: DataPayload,
  userMetadata?: JsonValue
): Promise<string> => {
  let dataBytes: Uint8Array
  if (data instanceof Blob) {
    dataBytes = new Uint8Array(await data.arrayBuffer())
  } else if (data instanceof ArrayBuffer) {
    dataBytes = new Uint8Array(data)
  } else if (ArrayBuffer.isView(data)) {
    dataBytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  } else if (typeof data === 'string') {
    dataBytes = encodeBytes(`s:${data}`)
  } else {
    dataBytes = encodeBytes(`j:${toJson(data)}`)
  }
  const metaBytes =
    userMetadata === undefined
      ? new Uint8Array()
      : encodeBytes(`:m:${toJson(userMetadata)}`)
  const combined = new Uint8Array(dataBytes.byteLength + metaBytes.byteLength)
  combined.set(dataBytes, 0)
  combined.set(metaBytes, dataBytes.byteLength)
  const hashBuf = await crypto.subtle.digest(
    'SHA-256',
    combined as BufferSource
  )
  return toHex(new Uint8Array(hashBuf).subarray(0, 16))
}

const actionAuthCanonicalPayload = (params: {
  appId: string
  roomId: string
  namespace: string
  peerId: string
  seq: number
  digest: string
  certSig: string
}): string =>
  toJson([
    1,
    params.appId,
    params.roomId,
    params.namespace,
    params.peerId,
    params.seq,
    params.digest,
    params.certSig
  ])

export const signActionAuth = async (
  signerPrivateKey: CryptoKey,
  cert: RoleCertificate,
  params: {
    appId: string
    roomId: string
    namespace: string
    peerId: string
    seq: number
    data: DataPayload
    userMetadata?: JsonValue
  }
): Promise<ActionAuthEnvelope> => {
  const digest = await computePayloadDigest(params.data, params.userMetadata)
  const canonicalBytes = encodeBytes(
    actionAuthCanonicalPayload({
      appId: params.appId,
      roomId: params.roomId,
      namespace: params.namespace,
      peerId: params.peerId,
      seq: params.seq,
      digest,
      certSig: cert.sig
    })
  )
  const sigBuf = await crypto.subtle.sign(
    {name: 'ECDSA', hash: 'SHA-256'},
    signerPrivateKey,
    canonicalBytes as BufferSource
  )
  return {
    v: 1,
    seq: params.seq,
    digest,
    cert,
    sig: toBase64Url(new Uint8Array(sigBuf))
  }
}

export const verifyActionAuth = async (
  env: ActionAuthEnvelope,
  params: {
    appId: string
    roomId: string
    namespace: string
    peerId: string
    data: DataPayload
    userMetadata?: JsonValue
    requiredRoles: readonly string[]
    rootFingerprints: ReadonlySet<string>
    rootPubKeys: ReadonlySet<string>
  }
): Promise<{valid: boolean; roles: string[]}> => {
  if (
    !env ||
    env.v !== 1 ||
    typeof env.seq !== 'number' ||
    typeof env.digest !== 'string' ||
    !env.cert ||
    typeof env.sig !== 'string'
  ) {
    return {valid: false, roles: []}
  }

  if (env.cert.subPeerId !== params.peerId) {
    return {valid: false, roles: []}
  }

  const hasRole =
    env.cert.roles.includes('admin') ||
    params.requiredRoles.includes('*') ||
    params.requiredRoles.some(r => env.cert.roles.includes(r))
  if (!hasRole) {
    return {valid: false, roles: []}
  }

  const certRes = await verifyRoleCertificateChain(
    env.cert,
    params.appId,
    params.roomId,
    params.rootFingerprints,
    params.rootPubKeys
  )
  if (!certRes.valid) {
    return {valid: false, roles: []}
  }

  const expectedDigest = await computePayloadDigest(
    params.data,
    params.userMetadata
  )
  if (env.digest !== expectedDigest) {
    return {valid: false, roles: []}
  }

  try {
    const verifyKey = await importVerifyKeyFromCanonical(
      canonicalizePubJwk(env.cert.subPubKey)
    )
    const canonicalBytes = encodeBytes(
      actionAuthCanonicalPayload({
        appId: params.appId,
        roomId: params.roomId,
        namespace: params.namespace,
        peerId: params.peerId,
        seq: env.seq,
        digest: env.digest,
        certSig: env.cert.sig
      })
    )
    const ok = await crypto.subtle.verify(
      {name: 'ECDSA', hash: 'SHA-256'},
      verifyKey,
      fromBase64Url(env.sig) as BufferSource,
      canonicalBytes as BufferSource
    )
    return ok
      ? {valid: true, roles: [...env.cert.roles]}
      : {valid: false, roles: []}
  } catch {
    return {valid: false, roles: []}
  }
}

export const stateRecordCanonicalPayload = <T extends JsonValue = JsonValue>(
  rec: Omit<AuthoritativeStateRecord<T>, 'sig' | 'hash'>
): string =>
  toJson([
    rec.v,
    rec.appId,
    rec.roomId,
    rec.namespace,
    rec.epoch,
    rec.seq,
    rec.prevHash,
    rec.ts,
    rec.updatedBy,
    canonicalizePubJwk(rec.signerPubKey),
    rec.cert.sig,
    rec.value
  ])

export const signStateRecord = async <T extends JsonValue = JsonValue>(
  signerPrivateKey: CryptoKey,
  signerPubJwk: JsonWebKey,
  cert: RoleCertificate,
  params: {
    appId: string
    roomId: string
    namespace: string
    epoch: number
    seq: number
    prevHash: string
    updatedBy: string
    value: T
  }
): Promise<AuthoritativeStateRecord<T>> => {
  const ts = nextMonotonicTs()
  const unsigned: Omit<AuthoritativeStateRecord<T>, 'sig' | 'hash'> = {
    v: 1,
    appId: params.appId,
    roomId: params.roomId,
    namespace: params.namespace,
    epoch: params.epoch,
    seq: params.seq,
    prevHash: params.prevHash,
    ts,
    updatedBy: params.updatedBy,
    signerPubKey: {
      crv: 'P-256',
      kty: 'EC',
      x: signerPubJwk.x ?? '',
      y: signerPubJwk.y ?? ''
    },
    cert,
    value: params.value
  }
  const canonicalBytes = encodeBytes(stateRecordCanonicalPayload(unsigned))
  const sigBuf = await crypto.subtle.sign(
    {name: 'ECDSA', hash: 'SHA-256'},
    signerPrivateKey,
    canonicalBytes as BufferSource
  )
  const sig = toBase64Url(new Uint8Array(sigBuf))
  const hash = toHex((await hashWith('SHA-256', sig)).subarray(0, 16))
  return {
    ...unsigned,
    sig,
    hash
  }
}

export const verifyStateRecord = async <T extends JsonValue = JsonValue>(
  rec: AuthoritativeStateRecord<T>,
  appId: string,
  roomId: string,
  requiredRoles: readonly string[],
  rootFingerprints: ReadonlySet<string>,
  rootPubKeys: ReadonlySet<string>
): Promise<boolean> => {
  if (
    !rec ||
    rec.v !== 1 ||
    rec.appId !== appId ||
    rec.roomId !== roomId ||
    typeof rec.namespace !== 'string' ||
    typeof rec.seq !== 'number' ||
    typeof rec.epoch !== 'number' ||
    !rec.cert ||
    !rec.signerPubKey ||
    typeof rec.sig !== 'string'
  ) {
    return false
  }

  if (rec.cert.subPeerId !== rec.updatedBy) {
    return false
  }

  const signerCanonical = canonicalizePubJwk(rec.signerPubKey)
  if (canonicalizePubJwk(rec.cert.subPubKey) !== signerCanonical) {
    return false
  }

  // Check role authorization
  const hasAllowedRole =
    rec.cert.roles.includes('admin') ||
    requiredRoles.includes('*') ||
    requiredRoles.some(r => rec.cert.roles.includes(r))
  if (!hasAllowedRole) {
    return false
  }

  const certRes = await verifyRoleCertificateChain(
    rec.cert,
    appId,
    roomId,
    rootFingerprints,
    rootPubKeys
  )
  if (!certRes.valid) {
    return false
  }

  try {
    const verifyKey = await importVerifyKeyFromCanonical(signerCanonical)
    const canonicalBytes = encodeBytes(stateRecordCanonicalPayload(rec))
    const ok = await crypto.subtle.verify(
      {name: 'ECDSA', hash: 'SHA-256'},
      verifyKey,
      fromBase64Url(rec.sig) as BufferSource,
      canonicalBytes as BufferSource
    )
    if (!ok) {
      return false
    }
    const expectedHash = toHex(
      (await hashWith('SHA-256', rec.sig)).subarray(0, 16)
    )
    return rec.hash === expectedHash
  } catch {
    return false
  }
}

export const compareStateRecords = (
  a: {epoch: number; seq: number; hash: string},
  b: {epoch: number; seq: number; hash: string}
): number => {
  if (a.epoch !== b.epoch) {
    return a.epoch - b.epoch
  }
  if (a.seq !== b.seq) {
    return a.seq - b.seq
  }
  return a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0
}
