import {p256} from '@noble/curves/nist.js'
import {hashWith} from './crypto'
import {
  bigintTo32Bytes,
  bytesToBigInt,
  canonicalizePubJwk,
  decodePublicKey,
  encodeBase62,
  encodePublicKey,
  fromBase64Url,
  signUserEndpointProof,
  toBase64Url,
  uncompressedBytesToPubJwk,
  verifyPeerIdKey,
  verifyUserEndpointProof
} from './identity'
import {
  all,
  decodeBytes,
  encodeBytes,
  fromJson,
  genId,
  mkErr,
  noOp,
  toHex,
  toJson
} from './utils'
import type {
  AdminIdentity,
  AuthorityConfig,
  AuthoritativeState,
  AuthoritativeStateRecord,
  DataPayload,
  JsonValue,
  PeerBanRecord,
  RoleCertificate,
  RoleRevocationRecord,
  RoomAuthorityInfo,
  StateChangeContext,
  StateConfig,
  UserIdentity
} from './types'

export {
  canonicalizePubJwk,
  decodePublicKey,
  encodePublicKey,
  fromBase64Url,
  toBase64Url
}

const p256N =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n

const adminKeyPrefix = 'trystero_ak_'
const fingerprintLen = 16
const fingerprintRegex = /^[0-9A-Za-z]{16}$/
const selfCertifyingRoomRegex = /^(.*)\.([0-9A-Za-z]{16})$/

const toBase62Fingerprint = (digestBytes: Uint8Array): string =>
  encodeBase62(digestBytes.subarray(0, 16), fingerprintLen)

const hasRequiredRole = (
  roles: readonly string[],
  requiredRoles: readonly string[]
): boolean =>
  roles.includes('admin') ||
  requiredRoles.includes('*') ||
  requiredRoles.some(r => roles.includes(r))

const isValidDelegatedUserEndpoint = (params: {
  appId: string
  roomId: string
  peerId: string
  cert: RoleCertificate
  signerPubKey?: JsonWebKey
  userPubKey?: JsonWebKey
  userProof?: string
}): boolean =>
  Boolean(
    params.cert.subUserId &&
      params.signerPubKey &&
      params.userPubKey &&
      params.userProof &&
      verifyPeerIdKey(params.peerId, params.signerPubKey) &&
      verifyUserEndpointProof({
        appId: params.appId,
        roomId: params.roomId,
        peerId: params.peerId,
        peerPubJwk: params.signerPubKey,
        userId: params.cert.subUserId,
        userPubJwk: params.userPubKey,
        proof: params.userProof
      })
  )

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

const pbkdf2Iterations = 100_000

const deriveSeedFromPassphrase = async (
  passphrase: string,
  appId = '',
  roomId = ''
): Promise<Uint8Array> => {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    encodeBytes(passphrase) as BufferSource,
    'PBKDF2',
    false,
    ['deriveBits']
  )
  const salt = encodeBytes(`trystero-p256-admin-kdf:v1:${appId}:${roomId}`)
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: salt as BufferSource,
      iterations: pbkdf2Iterations
    },
    baseKey,
    256
  )
  return new Uint8Array(derivedBits)
}

export const createAdminIdentity = async (options?: {
  secret?: string
  passphrase?: string
  credentials?: string
  adminKey?: string
  appId?: string
  roomId?: string
}): Promise<AdminIdentity> => {
  const rawSecret =
    options?.secret ?? options?.passphrase ?? options?.credentials
  const appId = options?.appId ?? ''
  const roomId = options?.roomId
    ? parseSelfCertifyingRoomId(options.roomId).baseRoomId
    : ''
  const cacheKey = options?.adminKey
    ? `ak:${options.adminKey}`
    : typeof rawSecret === 'string' && rawSecret.length > 0
      ? rawSecret.startsWith(adminKeyPrefix)
        ? `ak:${rawSecret}`
        : `kdf:${appId}:${roomId}:${rawSecret}`
      : ''
  if (cacheKey) {
    const existing = identityFromSecretCache.get(cacheKey)
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
      const maybeJwk =
        rawSecret && rawSecret.startsWith(adminKeyPrefix)
          ? tryDecodeAdminKeyJwk(rawSecret)
          : null
      if (maybeJwk) {
        return importIdentityFromPrivateJwk(maybeJwk)
      }

      // Deterministic PBKDF2-HMAC-SHA-256 derivation from passphrase secret
      const seedBytes = await deriveSeedFromPassphrase(
        rawSecret!,
        appId,
        roomId
      )
      const dScalar = (bytesToBigInt(seedBytes) % (p256N - 1n)) + 1n
      const dBytes = bigintTo32Bytes(dScalar)
      const pubJwk = uncompressedBytesToPubJwk(p256.getPublicKey(dBytes, false))
      const privJwk: JsonWebKey = {
        crv: 'P-256',
        d: toBase64Url(dBytes),
        kty: 'EC',
        x: pubJwk.x,
        y: pubJwk.y
      }
      return importIdentityFromPrivateJwk(privJwk)
    })()
    identityFromSecretCache.set(cacheKey, promise)
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
  options?: {
    secret?: string
    passphrase?: string
    credentials?: string
    adminKey?: string
    appId?: string
  }
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
  const identity = await createAdminIdentity(
    options ? {...options, roomId: cleanBase} : undefined
  )
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
  adminOption?: boolean | string | AuthorityConfig,
  appId = ''
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
    localIdentity = await createAdminIdentity({
      secret: adminOption,
      appId,
      roomId: parsed.baseRoomId
    })
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
            ? {
                secret: adminOption.credentials,
                appId,
                roomId: parsed.baseRoomId
              }
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
          ? await createAdminIdentity({
              secret: adminOption.credentials,
              appId,
              roomId: parsed.baseRoomId
            })
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
    cert.parentCert ? cert.parentCert.sig : null,
    ...(cert.subUserId ? [cert.subUserId] : [])
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
    subUserId?: string
    subPubKey: JsonWebKey
    appId: string
    roomId: string
    roles: string[]
    canDelegate?: boolean
    isRoot?: boolean
    expiresInMs?: number
    parentCert?: RoleCertificate
    now?: number
  }
): Promise<RoleCertificate> => {
  const now = typeof params.now === 'number' ? params.now : nextMonotonicTs()
  const unsigned: Omit<RoleCertificate, 'sig'> = {
    v: 1,
    certId: genId(16),
    issuerPubKey: encodePublicKey(signerPubJwk),
    subPeerId: params.subPeerId,
    ...(params.subUserId ? {subUserId: params.subUserId} : {}),
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

const maxCertClockSkewMs = 60_000

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
    !verifyPeerIdKey(cert.subPeerId, cert.subPubKey) ||
    typeof cert.iat !== 'number' ||
    !Number.isSafeInteger(cert.iat) ||
    cert.iat <= 0 ||
    typeof cert.sig !== 'string'
  ) {
    return {valid: false, isRoot: false}
  }

  const now = Date.now()
  if (cert.iat > now + maxCertClockSkewMs) {
    return {valid: false, isRoot: false}
  }

  if (typeof cert.exp === 'number' && now > cert.exp) {
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
    rev.targetCertId ?? null,
    rev.role ?? null,
    rev.seq,
    rev.ts,
    rev.issuerCert.sig,
    ...(rev.targetUserId ? [rev.targetUserId] : [])
  ])

export const signRoleRevocation = async (
  signerPrivateKey: CryptoKey,
  issuerCert: RoleCertificate,
  params: {
    appId: string
    roomId: string
    issuerPeerId: string
    targetPeerId: string
    targetUserId?: string
    targetCertId?: string
    minTs?: number
    role?: string
    seq: number
  }
): Promise<RoleRevocationRecord> => {
  const ts = Math.max(nextMonotonicTs(), params.minTs ?? 0)
  const unsigned: Omit<RoleRevocationRecord, 'sig'> = {
    v: 1,
    appId: params.appId,
    roomId: params.roomId,
    issuerPeerId: params.issuerPeerId,
    targetPeerId: params.targetPeerId,
    ...(params.targetUserId ? {targetUserId: params.targetUserId} : {}),
    ...(params.targetCertId ? {targetCertId: params.targetCertId} : {}),
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
    ban.issuerCert.sig,
    ...(ban.targetUserId ? [ban.targetUserId] : [])
  ])

export const signPeerBan = async (
  signerPrivateKey: CryptoKey,
  issuerCert: RoleCertificate,
  params: {
    appId: string
    roomId: string
    issuerPeerId: string
    targetPeerId: string
    targetUserId?: string
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
    ...(params.targetUserId ? {targetUserId: params.targetUserId} : {}),
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
  signerPubKey?: JsonWebKey
  userPubKey?: JsonWebKey
  userProof?: string
  sig: string
}

const digestChunkBytes = 256 * 1024

export const computePayloadDigest = async (
  data: DataPayload,
  userMetadata?: JsonValue
): Promise<string> => {
  const metaBytes =
    userMetadata === undefined
      ? new Uint8Array()
      : encodeBytes(`:m:${toJson(userMetadata)}`)

  const isBinary =
    data instanceof Blob ||
    data instanceof ArrayBuffer ||
    ArrayBuffer.isView(data)
  const byteLength =
    data instanceof Blob
      ? data.size
      : data instanceof ArrayBuffer
        ? data.byteLength
        : ArrayBuffer.isView(data)
          ? data.byteLength
          : 0

  if (isBinary && byteLength > digestChunkBytes) {
    const numChunks = Math.ceil(byteLength / digestChunkBytes)
    const chunkDigests = new Uint8Array(numChunks * 32 + metaBytes.byteLength)
    const viewBytes =
      data instanceof Blob
        ? null
        : data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(
              (data as ArrayBufferView).buffer,
              (data as ArrayBufferView).byteOffset,
              (data as ArrayBufferView).byteLength
            )
    for (let i = 0; i < numChunks; i++) {
      const start = i * digestChunkBytes
      const end = Math.min(byteLength, start + digestChunkBytes)
      const sliceBuf =
        data instanceof Blob
          ? await data.slice(start, end).arrayBuffer()
          : viewBytes!.subarray(start, end)
      const chunkHash = await crypto.subtle.digest(
        'SHA-256',
        sliceBuf as BufferSource
      )
      chunkDigests.set(new Uint8Array(chunkHash), i * 32)
    }
    if (metaBytes.byteLength > 0) {
      chunkDigests.set(metaBytes, numChunks * 32)
    }
    const finalHash = await crypto.subtle.digest(
      'SHA-256',
      chunkDigests as BufferSource
    )
    return toHex(new Uint8Array(finalHash).subarray(0, 16))
  }

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
  if (metaBytes.byteLength === 0) {
    const hashBuf = await crypto.subtle.digest(
      'SHA-256',
      dataBytes as BufferSource
    )
    return toHex(new Uint8Array(hashBuf).subarray(0, 16))
  }
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
    signerPubKey?: JsonWebKey
    userPubKey?: JsonWebKey
    userProof?: string
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
    ...(params.signerPubKey ? {signerPubKey: params.signerPubKey} : {}),
    ...(params.userPubKey ? {userPubKey: params.userPubKey} : {}),
    ...(params.userProof ? {userProof: params.userProof} : {}),
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

  let verifyPubKeyJwk: JsonWebKey = env.cert.subPubKey
  if (env.cert.subPeerId !== params.peerId) {
    if (
      !isValidDelegatedUserEndpoint({
        appId: params.appId,
        roomId: params.roomId,
        peerId: params.peerId,
        cert: env.cert,
        ...(env.signerPubKey ? {signerPubKey: env.signerPubKey} : {}),
        ...(env.userPubKey ? {userPubKey: env.userPubKey} : {}),
        ...(env.userProof ? {userProof: env.userProof} : {})
      })
    ) {
      return {valid: false, roles: []}
    }
    verifyPubKeyJwk = env.signerPubKey!
  }

  if (!hasRequiredRole(env.cert.roles, params.requiredRoles)) {
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
      canonicalizePubJwk(verifyPubKeyJwk)
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
    userId?: string
    userPubKey?: JsonWebKey
    userProof?: string
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
    ...(params.userId ? {userId: params.userId} : {}),
    ...(params.userPubKey ? {userPubKey: params.userPubKey} : {}),
    ...(params.userProof ? {userProof: params.userProof} : {}),
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

  const signerCanonical = canonicalizePubJwk(rec.signerPubKey)
  if (rec.cert.subPeerId === rec.updatedBy) {
    if (canonicalizePubJwk(rec.cert.subPubKey) !== signerCanonical) {
      return false
    }
  } else if (
    !isValidDelegatedUserEndpoint({
      appId,
      roomId,
      peerId: rec.updatedBy,
      cert: rec.cert,
      signerPubKey: rec.signerPubKey,
      ...(rec.userPubKey ? {userPubKey: rec.userPubKey} : {}),
      ...(rec.userProof ? {userProof: rec.userProof} : {})
    })
  ) {
    return false
  }

  // Check role authorization
  if (!hasRequiredRole(rec.cert.roles, requiredRoles)) {
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

type StateInstanceEntry<T extends JsonValue = JsonValue> = {
  namespace: string
  value: T
  record: AuthoritativeStateRecord<T> | null
  meta: StateChangeContext | null
  requiredRoles: string[]
  validate?: (next: T, prev: T, context: StateChangeContext) => boolean
  onChange: ((value: T, prev: T, context: StateChangeContext) => void) | null
  mutationQueue: Promise<void>
}

export type RoomAuthorityDeps = {
  selfId: string
  appId: string
  initialRoomId: string
  admin?: boolean | string | AuthorityConfig
  resolvedAuthorityP?: Promise<ResolvedRoomAuthority>
  getLocalCryptoIdentity: () => Promise<{
    signPrivateKey: CryptoKey
    signPubJwk: JsonWebKey
  }>
  getLocalUserIdentity?: () => Promise<UserIdentity>
  getOverlayPeerPublicKey: (peerId: string) => JsonWebKey | undefined
  isOverlayPeerBanned: (peerId: string) => boolean
  getPeerUserId?: (peerId: string) => string | undefined
  getUserPeerIds?: (userId: string) => string[]
  onRoomIdResolved: (effectiveRoomId: string) => void
  onPeerPublicKey: (peerId: string, pubKey: JsonWebKey) => void
  onLocalRoleCertificate: (cert: RoleCertificate | null) => void
  onPrivilegedPeer: (peerId: string, isPrivileged: boolean) => void
  onPeerBanned: (
    peerId: string,
    keyThumbprint?: string,
    targetUserId?: string
  ) => void
  onSignatureFailure: () => void
}

export type RoomAuthority = ReturnType<typeof createRoomAuthority>

export const createRoomAuthority = ({
  selfId: localSelfId,
  appId,
  initialRoomId,
  admin,
  resolvedAuthorityP,
  getLocalCryptoIdentity,
  getLocalUserIdentity,
  getOverlayPeerPublicKey,
  isOverlayPeerBanned,
  getPeerUserId,
  getUserPeerIds,
  onRoomIdResolved,
  onPeerPublicKey,
  onLocalRoleCertificate,
  onPrivilegedPeer,
  onPeerBanned,
  onSignatureFailure
}: RoomAuthorityDeps) => {
  let effectiveRoomId = initialRoomId
  const rootFingerprints = new Set<string>()
  const rootPubKeys = new Set<string>()
  const peerSignKeys = new Map<string, JsonWebKey>()
  const pubKeyWaiters = new Map<string, Array<(jwk: JsonWebKey) => void>>()
  const peerCerts = new Map<string, RoleCertificate>()
  const userCerts = new Map<string, RoleCertificate>()
  const peerRevocations = new Map<string, RoleRevocationRecord[]>()
  const userRevocations = new Map<string, RoleRevocationRecord[]>()
  const allRevocations = new Map<string, RoleRevocationRecord>()
  const bannedPeerRecords = new Map<string, PeerBanRecord>()
  const bannedUserIds = new Set<string>()
  const latestStateRecords = new Map<string, AuthoritativeStateRecord>()
  const stateInstances = new Map<string, StateInstanceEntry>()
  let localAdminIdentity: AdminIdentity | null = null
  let localCert: RoleCertificate | null = null
  let authResolved = false
  let localAuthSeq = 0

  const maxActionAuthSeenCache = 4_096
  const actionAuthSeenOrder: string[] = []
  const actionAuthSeenKeys = new Set<string>()
  const actionAuthMaxSeq = new Map<string, number>()
  const actionAuthReplayWindow = 512

  const checkAndRecordActionAuthSeq = (
    signerKeyId: string,
    namespace: string,
    seq: number
  ): boolean => {
    if (!Number.isSafeInteger(seq) || seq <= 0) {
      return false
    }
    const streamKey = `${signerKeyId}:${namespace}`
    const maxSeq = actionAuthMaxSeq.get(streamKey) ?? 0
    if (
      maxSeq > actionAuthReplayWindow &&
      seq < maxSeq - actionAuthReplayWindow
    ) {
      return false
    }
    const exactKey = `${streamKey}:${seq}`
    if (actionAuthSeenKeys.has(exactKey)) {
      return false
    }
    actionAuthSeenKeys.add(exactKey)
    actionAuthSeenOrder.push(exactKey)
    if (actionAuthSeenOrder.length > maxActionAuthSeenCache) {
      const oldest = actionAuthSeenOrder.shift()
      if (oldest) {
        actionAuthSeenKeys.delete(oldest)
      }
    }
    if (seq > maxSeq) {
      actionAuthMaxSeq.set(streamKey, seq)
    }
    return true
  }

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
    if (!verifyPeerIdKey(peerId, cleanJwk)) {
      return
    }
    peerSignKeys.set(peerId, cleanJwk)
    onPeerPublicKey(peerId, cleanJwk)
    const waiters = pubKeyWaiters.get(peerId)
    if (waiters) {
      pubKeyWaiters.delete(peerId)
      waiters.forEach(w => w(cleanJwk))
    }
  }

  const resolveTargetIds = (
    peerOrUserId: string
  ): {peerId: string; userId?: string} => {
    const ownedPeers = getUserPeerIds?.(peerOrUserId)
    if (ownedPeers && ownedPeers.length > 0) {
      const sorted = [...ownedPeers].sort()
      return {peerId: sorted[0]!, userId: peerOrUserId}
    }
    const certForUser = userCerts.get(peerOrUserId)
    if (certForUser) {
      return {peerId: certForUser.subPeerId, userId: peerOrUserId}
    }
    const knownUserId = getPeerUserId?.(peerOrUserId)
    if (
      knownUserId ||
      peerSignKeys.has(peerOrUserId) ||
      peerCerts.has(peerOrUserId) ||
      getOverlayPeerPublicKey(peerOrUserId)
    ) {
      return {
        peerId: peerOrUserId,
        ...(knownUserId ? {userId: knownUserId} : {})
      }
    }
    return {peerId: peerOrUserId}
  }

  const isPeerBanned = (peerOrUserId: string): boolean => {
    if (
      bannedPeerRecords.has(peerOrUserId) ||
      bannedUserIds.has(peerOrUserId) ||
      isOverlayPeerBanned(peerOrUserId)
    ) {
      return true
    }
    const uid = getPeerUserId?.(peerOrUserId)
    if (uid && bannedUserIds.has(uid)) {
      return true
    }
    const ownedPeers = getUserPeerIds?.(peerOrUserId)
    if (ownedPeers && ownedPeers.some(pid => bannedPeerRecords.has(pid))) {
      return true
    }
    return false
  }

  const getEffectiveRolesForCert = (cert: RoleCertificate): string[] => {
    if (
      isPeerBanned(cert.subPeerId) ||
      (cert.subUserId && isPeerBanned(cert.subUserId))
    ) {
      return []
    }
    if (typeof cert.exp === 'number' && Date.now() > cert.exp) {
      return []
    }
    let allowedByParent: Set<string> | null = null
    if (cert.parentCert && !cert.isRoot) {
      const parentEffective = getEffectiveRolesForCert(cert.parentCert)
      if (parentEffective.length === 0) {
        return []
      }
      if (!parentEffective.includes('admin')) {
        allowedByParent = new Set(parentEffective)
      }
    }
    const certUserId = cert.subUserId ?? getPeerUserId?.(cert.subPeerId)
    const revs = [
      ...(peerRevocations.get(cert.subPeerId) ?? []),
      ...(certUserId ? (userRevocations.get(certUserId) ?? []) : [])
    ]
    const revokedRoles = new Set<string>()
    if (revs.length > 0) {
      for (const r of revs) {
        if (r.targetCertId === cert.certId || r.ts >= cert.iat) {
          if (!r.role || r.role === '*') {
            return []
          }
          revokedRoles.add(r.role)
        }
      }
    }
    return cert.roles.filter(
      role =>
        !revokedRoles.has(role) &&
        (!allowedByParent || allowedByParent.has(role))
    )
  }

  const getPeerRoles = (targetPeerOrUserId = localSelfId): string[] => {
    if (isPeerBanned(targetPeerOrUserId)) {
      return []
    }
    const cert = peerCerts.get(targetPeerOrUserId)
    if (cert) {
      return getEffectiveRolesForCert(cert)
    }
    const uCert = userCerts.get(targetPeerOrUserId)
    if (uCert) {
      return getEffectiveRolesForCert(uCert)
    }
    const uid = getPeerUserId?.(targetPeerOrUserId)
    if (uid) {
      const certByUid = userCerts.get(uid)
      if (certByUid) {
        return getEffectiveRolesForCert(certByUid)
      }
    }
    const ownedPeers = getUserPeerIds?.(targetPeerOrUserId)
    if (ownedPeers && ownedPeers.length > 0) {
      const roleSet = new Set<string>()
      for (const pid of ownedPeers) {
        const pCert = peerCerts.get(pid)
        if (pCert) {
          for (const r of getEffectiveRolesForCert(pCert)) {
            roleSet.add(r)
          }
        }
      }
      if (roleSet.size > 0) {
        return [...roleSet].sort()
      }
    }
    if (
      !authResolved &&
      (targetPeerOrUserId === localSelfId ||
        (uid && uid === getPeerUserId?.(localSelfId))) &&
      (admin === true ||
        (typeof admin === 'string' && admin.length > 0) ||
        (typeof admin === 'object' &&
          Boolean(admin?.create || admin?.credentials)))
    ) {
      return ['admin']
    }
    return []
  }

  const ready = (
    resolvedAuthorityP ?? resolveRoomAuthority(initialRoomId, admin, appId)
  ).then(async resolved => {
    if (
      resolved.effectiveRoomId &&
      resolved.effectiveRoomId !== effectiveRoomId
    ) {
      effectiveRoomId = resolved.effectiveRoomId
      onRoomIdResolved(effectiveRoomId)
    }
    for (const fp of resolved.rootFingerprints) {
      rootFingerprints.add(fp)
    }
    for (const pk of resolved.rootPubKeys) {
      rootPubKeys.add(pk)
    }
    localAdminIdentity = resolved.localIdentity
    if (resolved.hasAuthorityAnchor || localAdminIdentity) {
      const cryptoId = await getLocalCryptoIdentity()
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
        onLocalRoleCertificate(rootCert)
        onPrivilegedPeer(localSelfId, true)
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
    await ready
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
    const subUid = cert.subUserId ?? getPeerUserId?.(cert.subPeerId)
    if (subUid) {
      const existingU = userCerts.get(subUid)
      if (!existingU || existingU.iat <= cert.iat) {
        userCerts.set(subUid, cert)
      }
    }
    const effectiveRoles = getEffectiveRolesForCert(cert)
    const isAdminRole = effectiveRoles.includes('admin')
    onPrivilegedPeer(cert.subPeerId, isAdminRole)
    if (subUid) {
      for (const pid of getUserPeerIds?.(subUid) ?? []) {
        onPrivilegedPeer(pid, isAdminRole)
      }
    }
    const localUid = getPeerUserId?.(localSelfId)
    if (
      cert.subPeerId === localSelfId ||
      (subUid &&
        localUid &&
        subUid === localUid &&
        (!localCert || localCert.iat <= cert.iat))
    ) {
      localCert = cert
      onLocalRoleCertificate(cert)
    }
    return true
  }

  const verifyAndApplyRevocation = async (
    rev: RoleRevocationRecord
  ): Promise<boolean> => {
    if (!rev || typeof rev !== 'object' || allRevocations.has(rev.sig)) {
      return false
    }
    await ready
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
    const targetCert =
      peerCerts.get(rev.targetPeerId) ??
      (rev.targetUserId ? userCerts.get(rev.targetUserId) : undefined)
    if (targetCert?.isRoot && !rev.issuerCert.isRoot) {
      return false
    }
    allRevocations.set(rev.sig, rev)
    const list = peerRevocations.get(rev.targetPeerId) ?? []
    list.push(rev)
    peerRevocations.set(rev.targetPeerId, list)
    const targetUid =
      rev.targetUserId ??
      targetCert?.subUserId ??
      getPeerUserId?.(rev.targetPeerId)
    if (targetUid) {
      const uList = userRevocations.get(targetUid) ?? []
      uList.push(rev)
      userRevocations.set(targetUid, uList)
    }
    const remainingRoles = getPeerRoles(rev.targetPeerId)
    onPrivilegedPeer(rev.targetPeerId, remainingRoles.includes('admin'))
    if (targetUid) {
      for (const pid of getUserPeerIds?.(targetUid) ?? []) {
        onPrivilegedPeer(pid, getPeerRoles(pid).includes('admin'))
      }
    }
    const localUid = getPeerUserId?.(localSelfId)
    if (
      (rev.targetPeerId === localSelfId ||
        (targetUid && localUid && targetUid === localUid)) &&
      getPeerRoles(localSelfId).length === 0
    ) {
      onLocalRoleCertificate(null)
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
    await ready
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
    const targetCert =
      peerCerts.get(ban.targetPeerId) ??
      (ban.targetUserId ? userCerts.get(ban.targetUserId) : undefined)
    if (targetCert?.isRoot && !ban.issuerCert.isRoot) {
      return false
    }
    bannedPeerRecords.set(ban.targetPeerId, ban)
    const targetUid =
      ban.targetUserId ??
      targetCert?.subUserId ??
      getPeerUserId?.(ban.targetPeerId)
    if (targetUid) {
      bannedUserIds.add(targetUid)
    }
    onPeerBanned(ban.targetPeerId, ban.targetKeyThumbprint, targetUid)
    return true
  }

  const verifyAndApplyStateRecord = async (
    record: AuthoritativeStateRecord
  ): Promise<boolean> => {
    if (!record || typeof record !== 'object') {
      return false
    }
    await ready
    if (isPeerBanned(record.updatedBy)) {
      onSignatureFailure()
      return false
    }
    await verifyAndApplyCert(record.cert)
    const effectiveRoles = getEffectiveRolesForCert(record.cert)
    const instance = stateInstances.get(record.namespace)
    const requiredRoles = instance?.requiredRoles ?? ['admin']
    if (!hasRequiredRole(effectiveRoles, requiredRoles)) {
      onSignatureFailure()
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
      onSignatureFailure()
      return false
    }
    const current = instance?.record ?? latestStateRecords.get(record.namespace)
    if (current && compareStateRecords(record, current) <= 0) {
      return false
    }
    const updatedByUserId =
      record.userId ??
      record.cert.subUserId ??
      getPeerUserId?.(record.updatedBy)
    const changeCtx: StateChangeContext = {
      updatedBy: record.updatedBy,
      ...(updatedByUserId ? {userId: updatedByUserId} : {}),
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
        onSignatureFailure()
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

  const waitForPeerPublicKey = (
    peerId: string,
    requestWhois: () => void,
    timeoutMs = 2_000
  ): Promise<JsonWebKey> => {
    const known = peerSignKeys.get(peerId) ?? getOverlayPeerPublicKey(peerId)
    if (known) {
      return Promise.resolve(known)
    }
    requestWhois()
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

  const buildLocalUserDelegationProof = async (
    signPubJwk: JsonWebKey
  ): Promise<{
    signerPubKey?: JsonWebKey
    userPubKey?: JsonWebKey
    userProof?: string
  }> => {
    if (
      !localCert ||
      localCert.subPeerId === localSelfId ||
      !localCert.subUserId ||
      !getLocalUserIdentity
    ) {
      return {}
    }
    const userIdentity = await getLocalUserIdentity()
    const userProof = await signUserEndpointProof(userIdentity, {
      appId,
      roomId: effectiveRoomId,
      peerId: localSelfId,
      peerPubJwk: signPubJwk
    })
    return {
      signerPubKey: signPubJwk,
      userPubKey: userIdentity.signPubJwk,
      userProof
    }
  }

  const extractAndVerifyActionEnvelope = async (
    peerId: string,
    requiredRoles: readonly string[],
    wireMetadata?: JsonValue
  ): Promise<{
    env: ActionAuthEnvelope
    userMetadata?: JsonValue
    effectiveRoles: string[]
  } | null> => {
    await ready
    if (
      isPeerBanned(peerId) ||
      !wireMetadata ||
      typeof wireMetadata !== 'object' ||
      Array.isArray(wireMetadata) ||
      !('__trysteroAuth' in wireMetadata)
    ) {
      return null
    }
    const env = (wireMetadata as {__trysteroAuth?: unknown}).__trysteroAuth as
      | ActionAuthEnvelope
      | undefined
    if (!env || !env.cert) {
      return null
    }
    const userMetadata = Object.hasOwn(wireMetadata, 'm')
      ? (wireMetadata as {m?: JsonValue}).m
      : undefined
    const certApplied = await verifyAndApplyCert(env.cert)
    if (!certApplied && peerCerts.get(peerId)?.certId !== env.cert.certId) {
      const chainRes = await verifyRoleCertificateChain(
        env.cert,
        appId,
        effectiveRoomId,
        rootFingerprints,
        rootPubKeys
      )
      if (!chainRes.valid) {
        return null
      }
    }
    const effectiveRoles = getEffectiveRolesForCert(env.cert)
    if (!hasRequiredRole(effectiveRoles, requiredRoles)) {
      return null
    }
    return {
      env,
      ...(userMetadata === undefined ? {} : {userMetadata}),
      effectiveRoles
    }
  }

  return {
    ready,
    getEffectiveRoomId: () => effectiveRoomId,
    getPeerRoles,
    isPeerBanned,
    registerPeerPublicKey,
    hasCertForPeer: (peerId?: string) =>
      Boolean(peerId && peerCerts.has(peerId)),
    hasRevocationSig: (sig?: string) => Boolean(sig && allRevocations.has(sig)),
    hasBanSig: (targetPeerId?: string, sig?: string) =>
      Boolean(
        targetPeerId && sig && bannedPeerRecords.get(targetPeerId)?.sig === sig
      ),
    verifyAndApplyCert,
    verifyAndApplyRevocation,
    verifyAndApplyBan,
    verifyAndApplyStateRecord,

    canPeerSendAction: async (
      peerId: string,
      requiredRoles: readonly string[],
      inlineCert?: RoleCertificate
    ): Promise<boolean> => {
      await ready
      if (isPeerBanned(peerId)) {
        return false
      }
      if (
        inlineCert &&
        (inlineCert.subPeerId === peerId ||
          (inlineCert.subUserId &&
            inlineCert.subUserId === getPeerUserId?.(peerId)))
      ) {
        await verifyAndApplyCert(inlineCert)
      }
      return hasRequiredRole(getPeerRoles(peerId), requiredRoles)
    },

    signActionPayload: async (
      namespace: string,
      requiredRoles: readonly string[],
      data: DataPayload,
      userMetadata?: JsonValue
    ): Promise<JsonValue> => {
      await ready
      const myRoles = getPeerRoles(localSelfId)
      if (!hasRequiredRole(myRoles, requiredRoles) || !localCert) {
        throw mkErr(`insufficient authority to send on action "${namespace}"`)
      }
      const cryptoId = await getLocalCryptoIdentity()
      const userProofFields = await buildLocalUserDelegationProof(
        cryptoId.signPubJwk
      )
      const env = await signActionAuth(cryptoId.signPrivateKey, localCert, {
        appId,
        roomId: effectiveRoomId,
        namespace,
        peerId: localSelfId,
        seq: ++localAuthSeq,
        data,
        ...userProofFields,
        ...(userMetadata === undefined ? {} : {userMetadata})
      })
      return {
        __trysteroAuth: env as unknown as JsonValue,
        ...(userMetadata === undefined ? {} : {m: userMetadata})
      }
    },

    verifyActionOffer: async (
      _namespace: string,
      peerId: string,
      requiredRoles: readonly string[],
      wireMetadata?: JsonValue
    ) => {
      const parsed = await extractAndVerifyActionEnvelope(
        peerId,
        requiredRoles,
        wireMetadata
      )
      if (!parsed) {
        return {valid: false, roles: []}
      }
      const {env, userMetadata, effectiveRoles} = parsed
      if (
        (env.cert.subPeerId !== peerId &&
          !isValidDelegatedUserEndpoint({
            appId,
            roomId: effectiveRoomId,
            peerId,
            cert: env.cert,
            ...(env.signerPubKey ? {signerPubKey: env.signerPubKey} : {}),
            ...(env.userPubKey ? {userPubKey: env.userPubKey} : {}),
            ...(env.userProof ? {userProof: env.userProof} : {})
          })) ||
        typeof env.seq !== 'number' ||
        env.seq <= 0 ||
        typeof env.sig !== 'string'
      ) {
        return {valid: false, roles: []}
      }
      return {
        valid: true,
        ...(userMetadata === undefined ? {} : {userMetadata}),
        roles: effectiveRoles
      }
    },

    verifyActionPayload: async (
      namespace: string,
      peerId: string,
      requiredRoles: readonly string[],
      data: DataPayload,
      wireMetadata?: JsonValue
    ) => {
      const parsed = await extractAndVerifyActionEnvelope(
        peerId,
        requiredRoles,
        wireMetadata
      )
      if (!parsed) {
        return {valid: false, roles: []}
      }
      const {env, userMetadata, effectiveRoles} = parsed
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
      const signerKeyId = canonicalizePubJwk(
        env.signerPubKey ?? env.cert.subPubKey
      )
      if (!checkAndRecordActionAuthSeq(signerKeyId, namespace, env.seq)) {
        return {valid: false, roles: []}
      }
      return {
        valid: true,
        ...(userMetadata === undefined ? {} : {userMetadata}),
        roles: effectiveRoles
      }
    },

    buildSyncMessage: async (force = false) => {
      const {resolved} = await ready
      if (
        !force &&
        !resolved.hasAuthorityAnchor &&
        peerCerts.size === 0 &&
        allRevocations.size === 0 &&
        bannedPeerRecords.size === 0 &&
        latestStateRecords.size === 0
      ) {
        return null
      }
      const cryptoId = await getLocalCryptoIdentity()
      registerPeerPublicKey(localSelfId, cryptoId.signPubJwk)
      const certs = [...peerCerts.values()]
      const revocations = [...allRevocations.values()]
      const bans = [...bannedPeerRecords.values()]
      const states = [...latestStateRecords.values()]
      return {
        pubKey: cryptoId.signPubJwk,
        ...(certs.length > 0 ? {certs} : {}),
        ...(revocations.length > 0 ? {revocations} : {}),
        ...(bans.length > 0 ? {bans} : {}),
        ...(states.length > 0 ? {states} : {})
      }
    },

    getAnnounceExtra: async () => {
      const {resolved} = await ready
      if (!resolved.hasAuthorityAnchor || !resolved.signalingProofs) {
        return undefined
      }
      const cryptoId = await getLocalCryptoIdentity()
      registerPeerPublicKey(localSelfId, cryptoId.signPubJwk)
      const bans = [...bannedPeerRecords.values()]
      return {
        pubKey: encodePublicKey(cryptoId.signPubJwk),
        ...(localCert ? {authCert: localCert} : {}),
        ...(bans.length > 0 ? {bans} : {})
      }
    },

    onSignalingPayload: (
      peerId: string,
      payload: Record<string, unknown>
    ): Promise<void> | undefined => {
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
    },

    makeState: <T extends JsonValue = JsonValue>(
      namespace: string,
      initialValue: T,
      config: StateConfig<T> | undefined,
      broadcastRecord: (
        record: AuthoritativeStateRecord<JsonValue>
      ) => Promise<void>
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
          onChange: null,
          mutationQueue: Promise.resolve()
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
          const runMutation = async (): Promise<
            AuthoritativeStateRecord<T>
          > => {
            await ready
            const myRoles = getPeerRoles(localSelfId)
            if (!hasRequiredRole(myRoles, entry.requiredRoles) || !localCert) {
              throw mkErr(
                `insufficient authority to update state "${namespace}"`
              )
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
            const cryptoId = await getLocalCryptoIdentity()
            const localUid = getPeerUserId?.(localSelfId)
            const {userPubKey, userProof} = await buildLocalUserDelegationProof(
              cryptoId.signPubJwk
            )
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
                ...(localUid ? {userId: localUid} : {}),
                ...(userPubKey ? {userPubKey} : {}),
                ...(userProof ? {userProof} : {}),
                value: nextValue
              }
            )
            const changeCtx: StateChangeContext = {
              updatedBy: localSelfId,
              ...(localUid ? {userId: localUid} : {}),
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
            return record
          }

          const op = entry.mutationQueue.then(runMutation, runMutation)
          entry.mutationQueue = op.then(noOp, noOp)
          const record = await op
          await broadcastRecord(record as AuthoritativeStateRecord<JsonValue>)
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

    getAuthorityInfo: async (): Promise<RoomAuthorityInfo> => {
      const {resolved} = await ready
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

    issueRoleCertificate: async (
      peerOrUserId: string,
      role: string | string[],
      options: {canDelegate?: boolean; expiresInMs?: number} | undefined,
      requestWhois: () => void
    ): Promise<RoleCertificate> => {
      if (!peerOrUserId || typeof peerOrUserId !== 'string') {
        throw mkErr('peerId or userId is required to grant a role')
      }
      await ready
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

      const {peerId, userId: subUserId} = resolveTargetIds(peerOrUserId)
      const subPubKey = await waitForPeerPublicKey(peerId, requestWhois)
      const currentRoles = getPeerRoles(peerId)
      const mergedRoles = [...new Set([...currentRoles, ...requestedRoles])]
      const cryptoId = await getLocalCryptoIdentity()

      const cert = await signRoleCertificate(
        localAdminIdentity
          ? localAdminIdentity.signPrivateKey
          : cryptoId.signPrivateKey,
        localAdminIdentity
          ? localAdminIdentity.signPubJwk
          : cryptoId.signPubJwk,
        {
          subPeerId: peerId,
          ...(subUserId ? {subUserId} : {}),
          subPubKey,
          appId,
          roomId: effectiveRoomId,
          roles: mergedRoles,
          ...(options?.canDelegate ? {canDelegate: true} : {}),
          ...(typeof options?.expiresInMs === 'number'
            ? {expiresInMs: options.expiresInMs}
            : {}),
          ...(localAdminIdentity ? {} : {parentCert: localCert!})
        }
      )

      await verifyAndApplyCert(cert)
      return cert
    },

    issueRoleRevocation: async (
      peerOrUserId: string,
      role?: string
    ): Promise<RoleRevocationRecord> => {
      if (!peerOrUserId || typeof peerOrUserId !== 'string') {
        throw mkErr('peerId or userId is required to revoke a role')
      }
      await ready
      const myRoles = getPeerRoles(localSelfId)
      if (!myRoles.includes('admin') && !localCert?.canDelegate) {
        throw mkErr('insufficient authority to revoke role')
      }
      const {peerId, userId: targetUserId} = resolveTargetIds(peerOrUserId)
      const targetCert =
        peerCerts.get(peerId) ??
        (targetUserId ? userCerts.get(targetUserId) : undefined)
      if (targetCert?.isRoot && !localCert?.isRoot) {
        throw mkErr('delegated authority cannot revoke a root admin')
      }
      const cryptoId = await getLocalCryptoIdentity()
      const revocation = await signRoleRevocation(
        cryptoId.signPrivateKey,
        localCert!,
        {
          appId,
          roomId: effectiveRoomId,
          issuerPeerId: localSelfId,
          targetPeerId: peerId,
          ...(targetUserId ? {targetUserId} : {}),
          ...(targetCert?.certId ? {targetCertId: targetCert.certId} : {}),
          ...(typeof targetCert?.iat === 'number'
            ? {minTs: targetCert.iat}
            : {}),
          ...(role ? {role} : {}),
          seq: ++localAuthSeq
        }
      )
      await verifyAndApplyRevocation(revocation)
      return revocation
    },

    issuePeerBan: async (
      peerOrUserId: string,
      options?: {reason?: string}
    ): Promise<PeerBanRecord> => {
      if (!peerOrUserId || typeof peerOrUserId !== 'string') {
        throw mkErr('peerId or userId is required to ban a peer')
      }
      await ready
      const myRoles = getPeerRoles(localSelfId)
      if (!myRoles.includes('admin') || !localCert) {
        throw mkErr('only an admin can ban a peer')
      }
      const {peerId, userId: targetUserId} = resolveTargetIds(peerOrUserId)
      const targetCert =
        peerCerts.get(peerId) ??
        (targetUserId ? userCerts.get(targetUserId) : undefined)
      if (targetCert?.isRoot && !localCert.isRoot) {
        throw mkErr('delegated admin cannot ban a root admin')
      }
      const targetPubKey =
        peerSignKeys.get(peerId) ?? getOverlayPeerPublicKey(peerId)
      const targetKeyThumbprint = targetPubKey
        ? toJson(targetPubKey)
        : undefined
      const cryptoId = await getLocalCryptoIdentity()
      const ban = await signPeerBan(cryptoId.signPrivateKey, localCert, {
        appId,
        roomId: effectiveRoomId,
        issuerPeerId: localSelfId,
        targetPeerId: peerId,
        ...(targetUserId ? {targetUserId} : {}),
        ...(targetKeyThumbprint ? {targetKeyThumbprint} : {}),
        ...(options?.reason ? {reason: options.reason} : {}),
        seq: ++localAuthSeq
      })
      await verifyAndApplyBan(ban)
      return ban
    }
  }
}
