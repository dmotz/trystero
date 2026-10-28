import {ecdsaSign, ecdsaVerify, sha256} from './crypto'
import {
  canPersistLocalIdentity,
  canonicalizePubJwk,
  computeUserIdFingerprint,
  decodePublicKey,
  encodePublicKey,
  fromBase64Url,
  getCachedPubKeyRecord,
  getDefaultUserIdentity,
  getOrCreateEndpointIdentity,
  getVerifiedPubKeyRecord,
  isValidUserId,
  resolveUserIdentity,
  signUserEndpointProof,
  toBase64Url,
  verifyPeerIdKey,
  verifyUserEndpointProof,
  verifyWithP256
} from './identity'
import {
  authMetaKey,
  createBoundedSet,
  definePlugin,
  encodeBytes,
  genId,
  insufficientAuthPrefix,
  invalidP256KeyErr,
  libId,
  mkErr,
  noOp,
  peerBannedErr,
  requiredErr,
  selfCertifyingRoomRegex,
  toHex,
  toJson
} from './utils'
import type {
  AuthoritativeState,
  AuthoritativeStateRecord,
  DataPayload,
  JsonValue,
  MaybePromise,
  PeerBanRecord,
  RoleCertificate,
  RoleRevocationRecord,
  RolesConfig,
  RolesPluginApi,
  RoomPlugin,
  SelfInfo,
  StateChangeContext,
  StateConfig,
  TargetPeers,
  UserIdentity,
  UserIdentityConfig,
  Widen
} from './types'

export {
  canonicalizePubJwk,
  decodePublicKey,
  encodePublicKey,
  fromBase64Url,
  toBase64Url
}

const fingerprintRegex = /^[0-9A-Za-z]{16}$/

const hasRequiredRole = (
  roles: readonly string[],
  requiredRoles: readonly string[]
): boolean =>
  roles.includes('admin') ||
  requiredRoles.includes('*') ||
  requiredRoles.some(r => roles.includes(r))

const isValidDelegatedUserEndpoint = async (params: {
  appId: string
  roomId: string
  peerId: string
  cert: RoleCertificate
  signerPubKey?: JsonWebKey
  userPubKey?: JsonWebKey
  userProof?: string
}): Promise<boolean> =>
  Boolean(
    params.cert.subUserId &&
    params.signerPubKey &&
    params.userPubKey &&
    params.userProof &&
    (await verifyPeerIdKey(params.peerId, params.signerPubKey)) &&
    (await verifyUserEndpointProof({
      appId: params.appId,
      roomId: params.roomId,
      peerId: params.peerId,
      peerPubJwk: params.signerPubKey,
      userId: params.cert.subUserId,
      userPubJwk: params.userPubKey,
      proof: params.userProof
    }))
  )

const rolesConfigPrefix = 'roles config'
const insufficientAuthErr = (to: string): Error =>
  mkErr(`${insufficientAuthPrefix} to ${to}`)
const revokeRoleAuthErr = insufficientAuthErr('revoke role')
const adminOnlyBanErr = mkErr('only an admin can ban a peer')
const requireTargetId = (id: string, action: string): void => {
  if (!id || typeof id !== 'string') {
    throw mkErr(`peerId or userId is required to ${action}`)
  }
}
const rootAdminProtectErr = (who: string, verb: string): Error =>
  mkErr(`delegated ${who} cannot ${verb} a root admin`)

export const computePublicKeyFingerprint = async (
  pubKeyOrJwk: JsonWebKey | string
): Promise<string> => {
  if (typeof pubKeyOrJwk === 'string' && isValidUserId(pubKeyOrJwk)) {
    return computeUserIdFingerprint(pubKeyOrJwk)
  }
  const rec = await getVerifiedPubKeyRecord(pubKeyOrJwk)
  if (!rec) {
    throw invalidP256KeyErr
  }
  return rec.fingerprint
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
    throw mkErr('fingerprint must be 16 Base62 chars')
  }
  const parsed = parseSelfCertifyingRoomId(baseRoomId)
  if (parsed.fingerprint === fingerprint) {
    return baseRoomId
  }
  return `${baseRoomId}.~${fingerprint}`
}

export const createAdminRoom = async (
  appId: string,
  baseRoomId: string,
  options?: {
    identity?: UserIdentityConfig
  }
): Promise<{
  roomId: string
  baseRoomId: string
  fingerprint: string
  userId: string
  identity: UserIdentity
}> => {
  if (!appId || typeof appId !== 'string') {
    throw requiredErr('appId')
  }
  if (!baseRoomId || typeof baseRoomId !== 'string') {
    throw requiredErr('baseRoomId')
  }
  const parsed = parseSelfCertifyingRoomId(baseRoomId)
  const cleanBase = parsed.baseRoomId
  const identity = await resolveUserIdentity(
    appId,
    cleanBase,
    options?.identity !== undefined
      ? {identity: options.identity}
      : {preferLocal: canPersistLocalIdentity()}
  )
  const fingerprint = computeUserIdFingerprint(identity.userId)
  const roomId = formatSelfCertifyingRoomId(cleanBase, fingerprint)

  return {
    roomId,
    baseRoomId: cleanBase,
    fingerprint,
    userId: identity.userId,
    identity
  }
}

export type ResolvedRoomAuthority = {
  effectiveRoomId: string
  baseRoomId: string
  roomFingerprint: string | null
  rootFingerprints: Set<string>
  rootUserIds: Set<string>
  localAdminUser: UserIdentity | null
  localUser: UserIdentity
  hasAuthorityAnchor: boolean
}

const addRootEntry = async (
  entry: string,
  rootFingerprints: Set<string>,
  rootUserIds: Set<string>
): Promise<void> => {
  const trimmed = entry.trim()
  if (!trimmed) {
    return
  }
  if (isValidUserId(trimmed)) {
    rootUserIds.add(trimmed)
    rootFingerprints.add(computeUserIdFingerprint(trimmed))
  } else if (fingerprintRegex.test(trimmed)) {
    rootFingerprints.add(trimmed)
  } else {
    const rec = await getVerifiedPubKeyRecord(trimmed)
    if (rec) {
      rootUserIds.add(rec.userId)
      rootFingerprints.add(rec.fingerprint)
    }
  }
}

const allowedRolesConfigKeys = new Set(['selfAsAdmin', 'admins'])

export const normalizeRolesConfig = (
  input?: RolesConfig
): RolesConfig | undefined => {
  if (input === undefined) {
    return undefined
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw mkErr(`${rolesConfigPrefix} must be an object`)
  }
  const raw = input as Record<string, unknown>
  for (const key of Object.keys(raw)) {
    if (!allowedRolesConfigKeys.has(key)) {
      throw mkErr(`Unknown ${rolesConfigPrefix} option "${key}"`)
    }
  }
  if (
    raw['selfAsAdmin'] !== undefined &&
    typeof raw['selfAsAdmin'] !== 'boolean'
  ) {
    throw mkErr(`${rolesConfigPrefix} "selfAsAdmin" must be a boolean`)
  }
  if (
    raw['admins'] !== undefined &&
    (!Array.isArray(raw['admins']) ||
      raw['admins'].some(item => typeof item !== 'string'))
  ) {
    throw mkErr(`${rolesConfigPrefix} "admins" must be a string[]`)
  }
  return {
    ...(raw['selfAsAdmin'] ? {selfAsAdmin: true} : {}),
    ...(Array.isArray(raw['admins']) ? {admins: [...raw['admins']]} : {})
  }
}

export const resolveRoomAuthority = async (
  rawRoomId: string,
  adminOption?: RolesConfig,
  localUserP?: Promise<UserIdentity>
): Promise<ResolvedRoomAuthority> => {
  const normalized = normalizeRolesConfig(adminOption)
  const parsed = parseSelfCertifyingRoomId(rawRoomId)
  const rootFingerprints = new Set<string>()
  const rootUserIds = new Set<string>()
  let effectiveRoomId = rawRoomId
  let roomFingerprint = parsed.fingerprint

  if (parsed.fingerprint) {
    rootFingerprints.add(parsed.fingerprint)
  }

  let resolvedLocalUser: UserIdentity | null = null
  const getLocalUser = async (): Promise<UserIdentity> => {
    if (!resolvedLocalUser) {
      resolvedLocalUser = localUserP
        ? await localUserP
        : await getDefaultUserIdentity()
    }
    return resolvedLocalUser
  }

  if (normalized) {
    if (normalized.selfAsAdmin && !parsed.fingerprint) {
      const user = await getLocalUser()
      roomFingerprint = computeUserIdFingerprint(user.userId)
      effectiveRoomId = formatSelfCertifyingRoomId(rawRoomId, roomFingerprint)
      rootFingerprints.add(roomFingerprint)
      rootUserIds.add(user.userId)
    }
    if (Array.isArray(normalized.admins)) {
      for (const entry of normalized.admins) {
        if (typeof entry === 'string') {
          await addRootEntry(entry, rootFingerprints, rootUserIds)
        }
      }
    }
  }

  const localUser = await getLocalUser()
  const localFp = computeUserIdFingerprint(localUser.userId)
  const isLocalAdmin =
    rootUserIds.has(localUser.userId) || rootFingerprints.has(localFp)
  const localAdminUser = isLocalAdmin ? localUser : null
  const hasAuthorityAnchor = rootFingerprints.size > 0 || rootUserIds.size > 0

  return {
    effectiveRoomId,
    baseRoomId: parsed.baseRoomId,
    roomFingerprint,
    rootFingerprints,
    rootUserIds,
    localAdminUser,
    localUser,
    hasAuthorityAnchor
  }
}

const roleCertCanonicalPayload = (cert: Omit<RoleCertificate, 'sig'>): string =>
  toJson([
    `${libId}-role-cert-v1`,
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
    cert.parentCert ? cert.parentCert.sig : null,
    ...(cert.subUserId ? [cert.subUserId] : [])
  ])

const maxCertClockSkewMs = 60_000
let lastAuthTimestamp = 0

const nextMonotonicTs = (): number => {
  const now = Date.now()
  if (lastAuthTimestamp > now + maxCertClockSkewMs) {
    lastAuthTimestamp = now
  }
  lastAuthTimestamp = now > lastAuthTimestamp ? now : lastAuthTimestamp + 1
  return lastAuthTimestamp
}

export const signRoleCertificate = async (
  signer: CryptoKey | ((payload: Uint8Array) => MaybePromise<Uint8Array>),
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
    parentCert?: RoleCertificate
    now?: number
  }
): Promise<RoleCertificate> => {
  const now =
    typeof params.now === 'number'
      ? params.now
      : Math.max(nextMonotonicTs(), params.parentCert?.iat ?? 0)
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
    ...(params.parentCert ? {parentCert: params.parentCert} : {})
  }

  const canonicalBytes = encodeBytes(roleCertCanonicalPayload(unsigned))
  const sigBytes =
    typeof signer === 'function'
      ? await signer(canonicalBytes)
      : await ecdsaSign(signer, canonicalBytes as BufferSource)
  return {
    ...unsigned,
    sig: toBase64Url(sigBytes)
  }
}

const isValidPubJwkShape = (jwk: unknown): jwk is JsonWebKey =>
  Boolean(
    jwk &&
    typeof jwk === 'object' &&
    !Array.isArray(jwk) &&
    (jwk as JsonWebKey).kty === 'EC' &&
    (jwk as JsonWebKey).crv === 'P-256' &&
    typeof (jwk as JsonWebKey).x === 'string' &&
    (jwk as JsonWebKey).x!.length > 0 &&
    typeof (jwk as JsonWebKey).y === 'string' &&
    (jwk as JsonWebKey).y!.length > 0
  )

export const validateRoleCertificateShape = (
  cert: unknown,
  depth = 0
): cert is RoleCertificate => {
  if (!cert || typeof cert !== 'object' || Array.isArray(cert) || depth > 1) {
    return false
  }
  const c = cert as Record<string, unknown>
  if (
    c['v'] !== 1 ||
    typeof c['certId'] !== 'string' ||
    !c['certId'] ||
    typeof c['issuerPubKey'] !== 'string' ||
    !c['issuerPubKey'] ||
    typeof c['subPeerId'] !== 'string' ||
    !c['subPeerId'] ||
    (c['subUserId'] !== undefined &&
      (typeof c['subUserId'] !== 'string' || !c['subUserId'])) ||
    !isValidPubJwkShape(c['subPubKey']) ||
    typeof c['appId'] !== 'string' ||
    !c['appId'] ||
    typeof c['roomId'] !== 'string' ||
    !c['roomId'] ||
    !Array.isArray(c['roles']) ||
    c['roles'].length === 0 ||
    c['roles'].some(r => typeof r !== 'string' || !r) ||
    (c['canDelegate'] !== undefined && typeof c['canDelegate'] !== 'boolean') ||
    (c['isRoot'] !== undefined && typeof c['isRoot'] !== 'boolean') ||
    typeof c['iat'] !== 'number' ||
    !Number.isSafeInteger(c['iat']) ||
    c['iat'] <= 0 ||
    typeof c['sig'] !== 'string' ||
    !c['sig']
  ) {
    return false
  }
  if (
    c['parentCert'] !== undefined &&
    !validateRoleCertificateShape(c['parentCert'], depth + 1)
  ) {
    return false
  }
  return true
}

export const verifyRoleCertificateChain = async (
  cert: RoleCertificate,
  appId: string,
  roomId: string,
  rootFingerprints: ReadonlySet<string>,
  rootUserIds?: ReadonlySet<string>,
  depth = 0
): Promise<{valid: boolean; isRoot: boolean; rootFingerprint?: string}> => {
  if (
    !validateRoleCertificateShape(cert, depth) ||
    cert.appId !== appId ||
    cert.roomId !== roomId ||
    !(await verifyPeerIdKey(cert.subPeerId, cert.subPubKey))
  ) {
    return {valid: false, isRoot: false}
  }

  if (cert.iat > Date.now() + maxCertClockSkewMs) {
    return {valid: false, isRoot: false}
  }

  const issuerRec = await getVerifiedPubKeyRecord(cert.issuerPubKey)
  if (!issuerRec) {
    return {valid: false, isRoot: false}
  }

  // Verify signature of this certificate
  try {
    const canonicalBytes = encodeBytes(roleCertCanonicalPayload(cert))
    const ok = await ecdsaVerify(
      issuerRec.verifyKey,
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
    rootFingerprints.has(issuerRec.fingerprint) ||
    Boolean(rootUserIds?.has(issuerRec.userId))

  if (isTrustedRoot) {
    return {
      valid: true,
      isRoot: Boolean(cert.isRoot && cert.roles.includes('admin')),
      rootFingerprint: issuerRec.fingerprint
    }
  }

  // Otherwise must have a valid parent certificate that has canDelegate: true
  const parent = cert.parentCert
  if (
    cert.isRoot ||
    !parent ||
    !validateRoleCertificateShape(parent, depth + 1) ||
    !parent.canDelegate
  ) {
    return {valid: false, isRoot: false}
  }

  if (canonicalizePubJwk(parent.subPubKey) !== issuerRec.canonicalJwk) {
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
    rootUserIds,
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
    `${libId}-role-revoke-v1`,
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

export const validateRoleRevocationShape = (
  rev: unknown
): rev is RoleRevocationRecord => {
  if (!rev || typeof rev !== 'object' || Array.isArray(rev)) {
    return false
  }
  const r = rev as Record<string, unknown>
  if ('reason' in r) {
    return false
  }
  return (
    r['v'] === 1 &&
    typeof r['appId'] === 'string' &&
    Boolean(r['appId']) &&
    typeof r['roomId'] === 'string' &&
    Boolean(r['roomId']) &&
    typeof r['issuerPeerId'] === 'string' &&
    Boolean(r['issuerPeerId']) &&
    typeof r['targetPeerId'] === 'string' &&
    Boolean(r['targetPeerId']) &&
    (r['targetUserId'] === undefined ||
      (typeof r['targetUserId'] === 'string' && Boolean(r['targetUserId']))) &&
    (r['targetCertId'] === undefined ||
      (typeof r['targetCertId'] === 'string' && Boolean(r['targetCertId']))) &&
    (r['role'] === undefined ||
      (typeof r['role'] === 'string' && Boolean(r['role']))) &&
    typeof r['seq'] === 'number' &&
    Number.isSafeInteger(r['seq']) &&
    r['seq'] > 0 &&
    typeof r['ts'] === 'number' &&
    Number.isSafeInteger(r['ts']) &&
    r['ts'] > 0 &&
    validateRoleCertificateShape(r['issuerCert']) &&
    (r['signerPubKey'] === undefined ||
      isValidPubJwkShape(r['signerPubKey'])) &&
    (r['userPubKey'] === undefined || isValidPubJwkShape(r['userPubKey'])) &&
    (r['userProof'] === undefined || typeof r['userProof'] === 'string') &&
    typeof r['sig'] === 'string' &&
    Boolean(r['sig'])
  )
}

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
    ts?: number
    role?: string
    seq: number
    signerPubKey?: JsonWebKey
    userPubKey?: JsonWebKey
    userProof?: string
  }
): Promise<RoleRevocationRecord> => {
  const ts =
    typeof params.ts === 'number'
      ? params.ts
      : Math.max(nextMonotonicTs(), issuerCert.iat, params.minTs ?? 0)
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
    issuerCert,
    ...(params.signerPubKey ? {signerPubKey: params.signerPubKey} : {}),
    ...(params.userPubKey ? {userPubKey: params.userPubKey} : {}),
    ...(params.userProof ? {userProof: params.userProof} : {})
  }
  const canonicalBytes = encodeBytes(revocationCanonicalPayload(unsigned))
  return {
    ...unsigned,
    sig: toBase64Url(
      await ecdsaSign(signerPrivateKey, canonicalBytes as BufferSource)
    )
  }
}

export const verifyRoleRevocation = async (
  rev: RoleRevocationRecord,
  appId: string,
  roomId: string,
  rootFingerprints: ReadonlySet<string>,
  rootUserIds?: ReadonlySet<string>
): Promise<boolean> => {
  if (
    !validateRoleRevocationShape(rev) ||
    rev.appId !== appId ||
    rev.roomId !== roomId ||
    rev.ts > Date.now() + maxCertClockSkewMs
  ) {
    return false
  }

  let verifyPubKeyJwk: JsonWebKey = rev.issuerCert.subPubKey
  if (rev.issuerCert.subPeerId !== rev.issuerPeerId) {
    if (
      !(await isValidDelegatedUserEndpoint({
        appId,
        roomId,
        peerId: rev.issuerPeerId,
        cert: rev.issuerCert,
        ...(rev.signerPubKey ? {signerPubKey: rev.signerPubKey} : {}),
        ...(rev.userPubKey ? {userPubKey: rev.userPubKey} : {}),
        ...(rev.userProof ? {userProof: rev.userProof} : {})
      }))
    ) {
      return false
    }
    verifyPubKeyJwk = rev.signerPubKey!
  }

  if (!rev.issuerCert.roles.includes('admin') && !rev.issuerCert.canDelegate) {
    return false
  }

  const certRes = await verifyRoleCertificateChain(
    rev.issuerCert,
    appId,
    roomId,
    rootFingerprints,
    rootUserIds
  )
  if (!certRes.valid) {
    return false
  }

  try {
    return await verifyWithP256(
      fromBase64Url(rev.sig),
      encodeBytes(revocationCanonicalPayload(rev)),
      verifyPubKeyJwk
    )
  } catch {
    return false
  }
}

export const banCanonicalPayload = (ban: Omit<PeerBanRecord, 'sig'>): string =>
  toJson([
    `${libId}-peer-ban-v1`,
    ban.v,
    ban.appId,
    ban.roomId,
    ban.issuerPeerId,
    ban.targetPeerId,
    ban.reason ?? null,
    ban.seq,
    ban.ts,
    ban.issuerCert.sig,
    ...(ban.targetUserId ? [ban.targetUserId] : [])
  ])

export const validatePeerBanShape = (ban: unknown): ban is PeerBanRecord => {
  if (!ban || typeof ban !== 'object' || Array.isArray(ban)) {
    return false
  }
  const b = ban as Record<string, unknown>
  if ('targetCertId' in b || 'role' in b) {
    return false
  }
  return (
    b['v'] === 1 &&
    typeof b['appId'] === 'string' &&
    Boolean(b['appId']) &&
    typeof b['roomId'] === 'string' &&
    Boolean(b['roomId']) &&
    typeof b['issuerPeerId'] === 'string' &&
    Boolean(b['issuerPeerId']) &&
    typeof b['targetPeerId'] === 'string' &&
    Boolean(b['targetPeerId']) &&
    (b['targetUserId'] === undefined ||
      (typeof b['targetUserId'] === 'string' && Boolean(b['targetUserId']))) &&
    (b['reason'] === undefined || typeof b['reason'] === 'string') &&
    typeof b['seq'] === 'number' &&
    Number.isSafeInteger(b['seq']) &&
    b['seq'] > 0 &&
    typeof b['ts'] === 'number' &&
    Number.isSafeInteger(b['ts']) &&
    b['ts'] > 0 &&
    validateRoleCertificateShape(b['issuerCert']) &&
    (b['signerPubKey'] === undefined ||
      isValidPubJwkShape(b['signerPubKey'])) &&
    (b['userPubKey'] === undefined || isValidPubJwkShape(b['userPubKey'])) &&
    (b['userProof'] === undefined || typeof b['userProof'] === 'string') &&
    typeof b['sig'] === 'string' &&
    Boolean(b['sig'])
  )
}

export const signPeerBan = async (
  signerPrivateKey: CryptoKey,
  issuerCert: RoleCertificate,
  params: {
    appId: string
    roomId: string
    issuerPeerId: string
    targetPeerId: string
    targetUserId?: string
    reason?: string
    seq: number
    ts?: number
    signerPubKey?: JsonWebKey
    userPubKey?: JsonWebKey
    userProof?: string
  }
): Promise<PeerBanRecord> => {
  const ts =
    typeof params.ts === 'number'
      ? params.ts
      : Math.max(nextMonotonicTs(), issuerCert.iat)
  const unsigned: Omit<PeerBanRecord, 'sig'> = {
    v: 1,
    appId: params.appId,
    roomId: params.roomId,
    issuerPeerId: params.issuerPeerId,
    targetPeerId: params.targetPeerId,
    ...(params.targetUserId ? {targetUserId: params.targetUserId} : {}),
    ...(params.reason ? {reason: params.reason} : {}),
    seq: params.seq,
    ts,
    issuerCert,
    ...(params.signerPubKey ? {signerPubKey: params.signerPubKey} : {}),
    ...(params.userPubKey ? {userPubKey: params.userPubKey} : {}),
    ...(params.userProof ? {userProof: params.userProof} : {})
  }
  const canonicalBytes = encodeBytes(banCanonicalPayload(unsigned))
  return {
    ...unsigned,
    sig: toBase64Url(
      await ecdsaSign(signerPrivateKey, canonicalBytes as BufferSource)
    )
  }
}

export const verifyPeerBan = async (
  ban: PeerBanRecord,
  appId: string,
  roomId: string,
  rootFingerprints: ReadonlySet<string>,
  rootUserIds?: ReadonlySet<string>
): Promise<boolean> => {
  if (
    !validatePeerBanShape(ban) ||
    ban.appId !== appId ||
    ban.roomId !== roomId ||
    ban.ts > Date.now() + maxCertClockSkewMs
  ) {
    return false
  }

  let verifyPubKeyJwk: JsonWebKey = ban.issuerCert.subPubKey
  if (ban.issuerCert.subPeerId !== ban.issuerPeerId) {
    if (
      !(await isValidDelegatedUserEndpoint({
        appId,
        roomId,
        peerId: ban.issuerPeerId,
        cert: ban.issuerCert,
        ...(ban.signerPubKey ? {signerPubKey: ban.signerPubKey} : {}),
        ...(ban.userPubKey ? {userPubKey: ban.userPubKey} : {}),
        ...(ban.userProof ? {userProof: ban.userProof} : {})
      }))
    ) {
      return false
    }
    verifyPubKeyJwk = ban.signerPubKey!
  }

  if (!ban.issuerCert.roles.includes('admin')) {
    return false
  }

  const certRes = await verifyRoleCertificateChain(
    ban.issuerCert,
    appId,
    roomId,
    rootFingerprints,
    rootUserIds
  )
  if (!certRes.valid) {
    return false
  }

  try {
    return await verifyWithP256(
      fromBase64Url(ban.sig),
      encodeBytes(banCanonicalPayload(ban)),
      verifyPubKeyJwk
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

export const validateActionAuthShape = (
  env: unknown
): env is ActionAuthEnvelope => {
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    return false
  }
  const e = env as Record<string, unknown>
  return (
    e['v'] === 1 &&
    typeof e['seq'] === 'number' &&
    Number.isSafeInteger(e['seq']) &&
    e['seq'] > 0 &&
    typeof e['digest'] === 'string' &&
    Boolean(e['digest']) &&
    validateRoleCertificateShape(e['cert']) &&
    (e['signerPubKey'] === undefined ||
      isValidPubJwkShape(e['signerPubKey'])) &&
    (e['userPubKey'] === undefined || isValidPubJwkShape(e['userPubKey'])) &&
    (e['userProof'] === undefined || typeof e['userProof'] === 'string') &&
    typeof e['sig'] === 'string' &&
    Boolean(e['sig'])
  )
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
      chunkDigests.set(await sha256(sliceBuf as BufferSource), i * 32)
    }
    if (metaBytes.byteLength > 0) {
      chunkDigests.set(metaBytes, numChunks * 32)
    }
    return toHex((await sha256(chunkDigests as BufferSource)).subarray(0, 16))
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
    return toHex((await sha256(dataBytes as BufferSource)).subarray(0, 16))
  }
  const combined = new Uint8Array(dataBytes.byteLength + metaBytes.byteLength)
  combined.set(dataBytes, 0)
  combined.set(metaBytes, dataBytes.byteLength)
  return toHex((await sha256(combined as BufferSource)).subarray(0, 16))
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
    `${libId}-action-auth-v1`,
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
  return {
    v: 1,
    seq: params.seq,
    digest,
    cert,
    ...(params.signerPubKey ? {signerPubKey: params.signerPubKey} : {}),
    ...(params.userPubKey ? {userPubKey: params.userPubKey} : {}),
    ...(params.userProof ? {userProof: params.userProof} : {}),
    sig: toBase64Url(
      await ecdsaSign(signerPrivateKey, canonicalBytes as BufferSource)
    )
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
    rootUserIds?: ReadonlySet<string>
  }
): Promise<{valid: boolean; roles: string[]}> => {
  if (!validateActionAuthShape(env)) {
    return {valid: false, roles: []}
  }

  let verifyPubKeyJwk: JsonWebKey = env.cert.subPubKey
  if (env.cert.subPeerId !== params.peerId) {
    if (
      !(await isValidDelegatedUserEndpoint({
        appId: params.appId,
        roomId: params.roomId,
        peerId: params.peerId,
        cert: env.cert,
        ...(env.signerPubKey ? {signerPubKey: env.signerPubKey} : {}),
        ...(env.userPubKey ? {userPubKey: env.userPubKey} : {}),
        ...(env.userProof ? {userProof: env.userProof} : {})
      }))
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
    params.rootUserIds
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
    const ok = await verifyWithP256(
      fromBase64Url(env.sig),
      canonicalBytes,
      verifyPubKeyJwk
    )
    return ok
      ? {valid: true, roles: [...env.cert.roles]}
      : {valid: false, roles: []}
  } catch {
    return {valid: false, roles: []}
  }
}

export const stateRecordCanonicalPayload = <T = JsonValue>(
  rec: Omit<AuthoritativeStateRecord<T>, 'sig' | 'hash'>
): string =>
  toJson([
    `${libId}-state-record-v1`,
    rec.v,
    rec.appId,
    rec.roomId,
    rec.namespace,
    rec.seq,
    rec.prevHash,
    rec.ts,
    rec.updatedBy,
    canonicalizePubJwk(rec.signerPubKey),
    rec.cert.sig,
    rec.value
  ])

export const validateStateRecordShape = (
  rec: unknown
): rec is AuthoritativeStateRecord => {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
    return false
  }
  const r = rec as Record<string, unknown>
  return (
    r['v'] === 1 &&
    typeof r['appId'] === 'string' &&
    Boolean(r['appId']) &&
    typeof r['roomId'] === 'string' &&
    Boolean(r['roomId']) &&
    typeof r['namespace'] === 'string' &&
    Boolean(r['namespace']) &&
    typeof r['seq'] === 'number' &&
    Number.isSafeInteger(r['seq']) &&
    r['seq'] > 0 &&
    typeof r['prevHash'] === 'string' &&
    Boolean(r['prevHash']) &&
    !(r['seq'] === 1 && r['prevHash'] !== '00000000000000000000000000000000') &&
    typeof r['ts'] === 'number' &&
    Number.isSafeInteger(r['ts']) &&
    r['ts'] > 0 &&
    typeof r['updatedBy'] === 'string' &&
    Boolean(r['updatedBy']) &&
    (r['userId'] === undefined ||
      (typeof r['userId'] === 'string' && Boolean(r['userId']))) &&
    (r['userPubKey'] === undefined || isValidPubJwkShape(r['userPubKey'])) &&
    (r['userProof'] === undefined || typeof r['userProof'] === 'string') &&
    isValidPubJwkShape(r['signerPubKey']) &&
    validateRoleCertificateShape(r['cert']) &&
    'value' in r &&
    typeof r['sig'] === 'string' &&
    Boolean(r['sig']) &&
    typeof r['hash'] === 'string' &&
    Boolean(r['hash'])
  )
}

export const signStateRecord = async <T = JsonValue>(
  signerPrivateKey: CryptoKey,
  signerPubJwk: JsonWebKey,
  cert: RoleCertificate,
  params: {
    appId: string
    roomId: string
    namespace: string
    seq: number
    prevHash: string
    ts?: number
    updatedBy: string
    userId?: string
    userPubKey?: JsonWebKey
    userProof?: string
    value: T
  }
): Promise<AuthoritativeStateRecord<T>> => {
  const ts =
    typeof params.ts === 'number'
      ? params.ts
      : Math.max(nextMonotonicTs(), cert.iat)
  const unsigned: Omit<AuthoritativeStateRecord<T>, 'sig' | 'hash'> = {
    v: 1,
    appId: params.appId,
    roomId: params.roomId,
    namespace: params.namespace,
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
  const sig = toBase64Url(
    await ecdsaSign(signerPrivateKey, canonicalBytes as BufferSource)
  )
  const hash = toHex(
    (await sha256(canonicalBytes as BufferSource)).subarray(0, 16)
  )
  return {
    ...unsigned,
    sig,
    hash
  }
}

export const verifyStateRecord = async <T = JsonValue>(
  rec: AuthoritativeStateRecord<T>,
  appId: string,
  roomId: string,
  requiredRoles: readonly string[],
  rootFingerprints: ReadonlySet<string>,
  rootUserIds?: ReadonlySet<string>
): Promise<boolean> => {
  if (
    !validateStateRecordShape(rec) ||
    rec.appId !== appId ||
    rec.roomId !== roomId ||
    rec.ts > Date.now() + maxCertClockSkewMs
  ) {
    return false
  }

  const signerCanonical = canonicalizePubJwk(rec.signerPubKey)
  if (!signerCanonical) {
    return false
  }
  if (rec.cert.subPeerId === rec.updatedBy) {
    if (canonicalizePubJwk(rec.cert.subPubKey) !== signerCanonical) {
      return false
    }
  } else if (
    !(await isValidDelegatedUserEndpoint({
      appId,
      roomId,
      peerId: rec.updatedBy,
      cert: rec.cert,
      signerPubKey: rec.signerPubKey,
      ...(rec.userPubKey ? {userPubKey: rec.userPubKey} : {}),
      ...(rec.userProof ? {userProof: rec.userProof} : {})
    }))
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
    rootUserIds
  )
  if (!certRes.valid) {
    return false
  }

  try {
    const canonicalBytes = encodeBytes(stateRecordCanonicalPayload(rec))
    const ok = await verifyWithP256(
      fromBase64Url(rec.sig),
      canonicalBytes,
      rec.signerPubKey
    )
    if (!ok) {
      return false
    }
    const expectedHash = toHex(
      (await sha256(canonicalBytes as BufferSource)).subarray(0, 16)
    )
    return rec.hash === expectedHash
  } catch {
    return false
  }
}

export const compareStateRecords = (
  a: {seq: number; hash: string},
  b: {seq: number; hash: string}
): number => {
  if (a.seq !== b.seq) {
    return a.seq - b.seq
  }
  return a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0
}

type StateInstanceEntry<T = JsonValue> = {
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
  admin?: RolesConfig
  resolvedAuthorityP?: Promise<ResolvedRoomAuthority>
  getLocalCryptoIdentity: () => Promise<{
    peerId?: string
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
  onPeerBanned: (peerId: string, targetUserId?: string) => void
  onSignatureFailure: () => void
}

export type RoomAuthority = {
  ready: Promise<{resolved: ResolvedRoomAuthority}>
  getEffectiveRoomId: () => string
  getPeerRoles: (targetPeerOrUserId?: string) => string[]
  isPeerBanned: (peerOrUserId: string) => boolean
  registerPeerPublicKey: (peerId: string, jwk: JsonWebKey) => void
  hasCertForPeer: (peerId?: string) => boolean
  hasRevocationSig: (sig?: string) => boolean
  hasBanSig: (targetPeerId?: string, sig?: string) => boolean
  verifyAndApplyCert: (cert: RoleCertificate) => Promise<boolean>
  verifyAndApplyRevocation: (rev: RoleRevocationRecord) => Promise<boolean>
  verifyAndApplyBan: (ban: PeerBanRecord) => Promise<boolean>
  verifyAndApplyStateRecord: (
    record: AuthoritativeStateRecord
  ) => Promise<boolean>
  canPeerSendAction: (
    peerId: string,
    requiredRoles: readonly string[],
    inlineCert?: RoleCertificate
  ) => Promise<boolean>
  signActionPayload: (
    namespace: string,
    requiredRoles: readonly string[],
    data: DataPayload,
    userMetadata?: JsonValue
  ) => Promise<JsonValue>
  verifyActionOffer: (
    namespace: string,
    peerId: string,
    requiredRoles: readonly string[],
    wireMetadata?: JsonValue
  ) => Promise<{valid: boolean; userMetadata?: JsonValue; roles: string[]}>
  verifyActionPayload: (
    namespace: string,
    peerId: string,
    requiredRoles: readonly string[],
    data: DataPayload,
    wireMetadata?: JsonValue
  ) => Promise<{valid: boolean; userMetadata?: JsonValue; roles: string[]}>
  buildSyncMessage: (force?: boolean) => Promise<{
    pubKey: JsonWebKey
    certs?: RoleCertificate[]
    revocations?: RoleRevocationRecord[]
    bans?: PeerBanRecord[]
    states?: AuthoritativeStateRecord[]
  } | null>
  makeState: <T extends JsonValue>(
    namespace: string,
    initialValue: T,
    config: StateConfig<Widen<T>> | undefined,
    broadcastRecord: (
      record: AuthoritativeStateRecord<JsonValue>
    ) => Promise<void>
  ) => AuthoritativeState<Widen<T>>
  getAuthorityInfo: () => Promise<Omit<SelfInfo, 'peerId'>>
  issueRoleCertificate: (
    peerOrUserId: string,
    role: string | string[],
    options: {canDelegate?: boolean} | undefined,
    requestWhois: () => void
  ) => Promise<RoleCertificate>
  issueRoleRevocation: (
    peerOrUserId: string,
    role?: string
  ) => Promise<RoleRevocationRecord>
  issuePeerBan: (
    peerOrUserId: string,
    options?: {reason?: string}
  ) => Promise<PeerBanRecord>
}

export const createRoomAuthority = ({
  selfId: initialSelfId,
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
  onPeerBanned,
  onSignatureFailure
}: RoomAuthorityDeps): RoomAuthority => {
  let localSelfId = initialSelfId
  let effectiveRoomId = initialRoomId
  const rootFingerprints = new Set<string>()
  const rootUserIds = new Set<string>()
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
  let localAdminUser: UserIdentity | null = null
  let localCert: RoleCertificate | null = null
  let authResolved = false
  let localAuthSeq = 0

  const actionAuthSeenKeys = createBoundedSet<string>()
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
    if (!actionAuthSeenKeys.add(exactKey)) {
      return false
    }
    if (seq > maxSeq) {
      actionAuthMaxSeq.set(streamKey, seq)
    }
    return true
  }

  const applyVerifiedPeerPublicKey = (
    peerId: string,
    cleanJwk: JsonWebKey
  ): void => {
    peerSignKeys.set(peerId, cleanJwk)
    onPeerPublicKey(peerId, cleanJwk)
    const waiters = pubKeyWaiters.get(peerId)
    if (waiters) {
      pubKeyWaiters.delete(peerId)
      waiters.forEach(w => w(cleanJwk))
    }
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
    const cached = getCachedPubKeyRecord(cleanJwk)
    if (cached && cached.peerId === peerId) {
      applyVerifiedPeerPublicKey(peerId, cleanJwk)
      return
    }
    void verifyPeerIdKey(peerId, cleanJwk).then(ok => {
      if (ok) {
        applyVerifiedPeerPublicKey(peerId, cleanJwk)
      }
    })
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

  const isTargetRootAuthority = (
    targetPeerId: string,
    targetUserId?: string,
    targetCert?: RoleCertificate
  ): boolean => {
    if (targetCert?.isRoot) {
      return true
    }
    const storedCert =
      peerCerts.get(targetPeerId) ??
      (targetUserId ? userCerts.get(targetUserId) : undefined)
    if (storedCert?.isRoot) {
      return true
    }
    const uid =
      targetUserId ??
      targetCert?.subUserId ??
      storedCert?.subUserId ??
      getPeerUserId?.(targetPeerId)
    if (uid) {
      if (rootUserIds.has(uid)) {
        return true
      }
      if (
        isValidUserId(uid) &&
        rootFingerprints.has(computeUserIdFingerprint(uid))
      ) {
        return true
      }
    }
    if (rootUserIds.has(targetPeerId)) {
      return true
    }
    if (
      isValidUserId(targetPeerId) &&
      rootFingerprints.has(computeUserIdFingerprint(targetPeerId))
    ) {
      return true
    }
    return false
  }

  const isPeerBanned = (peerOrUserId: string): boolean => {
    const uid = getPeerUserId?.(peerOrUserId)
    const isRootTarget = isTargetRootAuthority(peerOrUserId, uid)
    const directBan = bannedPeerRecords.get(peerOrUserId)
    if (directBan) {
      if (isRootTarget && !directBan.issuerCert.isRoot) {
        bannedPeerRecords.delete(peerOrUserId)
      } else {
        return true
      }
    }
    if (
      !isRootTarget &&
      (bannedUserIds.has(peerOrUserId) || isOverlayPeerBanned(peerOrUserId))
    ) {
      return true
    }
    if (!isRootTarget && uid && bannedUserIds.has(uid)) {
      return true
    }
    const ownedPeers = getUserPeerIds?.(peerOrUserId)
    if (
      ownedPeers &&
      ownedPeers.some(pid => {
        const b = bannedPeerRecords.get(pid)
        return Boolean(b && (!isRootTarget || b.issuerCert.isRoot))
      })
    ) {
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
        (uid && uid === getPeerUserId?.(localSelfId)))
    ) {
      const normalized = normalizeRolesConfig(admin)
      if (normalized?.selfAsAdmin) {
        return ['admin']
      }
      const localUid = getPeerUserId?.(localSelfId)
      if (localUid && isValidUserId(localUid)) {
        const localFp = computeUserIdFingerprint(localUid)
        const parsedInit = parseSelfCertifyingRoomId(initialRoomId)
        if (parsedInit.fingerprint === localFp) {
          return ['admin']
        }
        const entries = normalized?.admins ?? []
        if (
          entries.some(
            e =>
              typeof e === 'string' &&
              (e.trim() === localUid || e.trim() === localFp)
          )
        ) {
          return ['admin']
        }
      }
    }
    return []
  }

  const ready = (
    resolvedAuthorityP ??
    resolveRoomAuthority(initialRoomId, admin, getLocalUserIdentity?.())
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
    for (const uid of resolved.rootUserIds) {
      rootUserIds.add(uid)
    }
    localAdminUser = resolved.localAdminUser
    if (resolved.hasAuthorityAnchor || localAdminUser || !localSelfId) {
      const cryptoId = await getLocalCryptoIdentity()
      if (
        cryptoId.peerId &&
        (!localSelfId || localSelfId !== cryptoId.peerId)
      ) {
        localSelfId = cryptoId.peerId
      }
      if (resolved.hasAuthorityAnchor || localAdminUser) {
        registerPeerPublicKey(localSelfId, cryptoId.signPubJwk)
        if (localAdminUser) {
          const rootCert = await signRoleCertificate(
            localAdminUser.sign,
            localAdminUser.signPubJwk,
            {
              subPeerId: localSelfId,
              subUserId: localAdminUser.userId,
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
          userCerts.set(localAdminUser.userId, rootCert)
          onLocalRoleCertificate(rootCert)
        }
      }
    }
    authResolved = true
    return {resolved}
  })

  const verifyAndApplyCert = async (
    cert: RoleCertificate
  ): Promise<boolean> => {
    try {
      if (!validateRoleCertificateShape(cert)) {
        return false
      }
      await ready
      const res = await verifyRoleCertificateChain(
        cert,
        appId,
        effectiveRoomId,
        rootFingerprints,
        rootUserIds
      )
      if (!res.valid) {
        return false
      }
      registerPeerPublicKey(cert.subPeerId, cert.subPubKey)
      const existing = peerCerts.get(cert.subPeerId)
      if (
        existing &&
        (existing.iat > cert.iat || existing.certId === cert.certId)
      ) {
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
      const localUid = getPeerUserId?.(localSelfId)
      if (
        cert.subPeerId === localSelfId ||
        (subUid &&
          localUid &&
          subUid === localUid &&
          !(localCert?.subPeerId === localSelfId && localCert.isRoot) &&
          (!localCert || localCert.iat <= cert.iat))
      ) {
        localCert = cert
        onLocalRoleCertificate(cert)
      }
      return true
    } catch {
      return false
    }
  }

  const canRevokeRoles = (
    issuer: RoleCertificate,
    _target: RoleCertificate | undefined,
    role?: string
  ): boolean => {
    const roles = getEffectiveRolesForCert(issuer)
    if (roles.includes('admin')) {
      return true
    }
    if (!issuer.canDelegate || roles.length === 0) {
      return false
    }
    return Boolean(role && role !== '*' && roles.includes(role))
  }

  const verifyAndApplyRevocation = async (
    rev: RoleRevocationRecord
  ): Promise<boolean> => {
    try {
      if (!validateRoleRevocationShape(rev) || allRevocations.has(rev.sig)) {
        return false
      }
      await ready
      const valid = await verifyRoleRevocation(
        rev,
        appId,
        effectiveRoomId,
        rootFingerprints,
        rootUserIds
      )
      if (!valid) {
        return false
      }
      const targetCert =
        peerCerts.get(rev.targetPeerId) ??
        (rev.targetUserId ? userCerts.get(rev.targetUserId) : undefined)
      if (!canRevokeRoles(rev.issuerCert, targetCert, rev.role)) {
        return false
      }
      if (
        !rev.issuerCert.isRoot &&
        isTargetRootAuthority(rev.targetPeerId, rev.targetUserId, targetCert)
      ) {
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
      const localUid = getPeerUserId?.(localSelfId)
      if (
        (rev.targetPeerId === localSelfId ||
          (targetUid && localUid && targetUid === localUid)) &&
        getPeerRoles(localSelfId).length === 0
      ) {
        onLocalRoleCertificate(null)
      }
      return true
    } catch {
      return false
    }
  }

  const verifyAndApplyBan = async (ban: PeerBanRecord): Promise<boolean> => {
    try {
      if (
        !validatePeerBanShape(ban) ||
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
        rootUserIds
      )
      if (
        !valid ||
        !getEffectiveRolesForCert(ban.issuerCert).includes('admin')
      ) {
        return false
      }
      const targetCert =
        peerCerts.get(ban.targetPeerId) ??
        (ban.targetUserId ? userCerts.get(ban.targetUserId) : undefined)
      if (
        !ban.issuerCert.isRoot &&
        isTargetRootAuthority(ban.targetPeerId, ban.targetUserId, targetCert)
      ) {
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
      onPeerBanned(ban.targetPeerId, targetUid)
      return true
    } catch {
      return false
    }
  }

  const verifyAndApplyStateRecord = async (
    record: AuthoritativeStateRecord
  ): Promise<boolean> => {
    try {
      if (!validateStateRecordShape(record)) {
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
        rootUserIds
      )
      if (!isValid) {
        onSignatureFailure()
        return false
      }
      const current =
        instance?.record ?? latestStateRecords.get(record.namespace)
      if (current) {
        if (compareStateRecords(record, current) <= 0) {
          return false
        }
        if (
          record.seq === current.seq + 1 &&
          record.updatedBy === current.updatedBy &&
          record.prevHash !== current.hash
        ) {
          onSignatureFailure()
          return false
        }
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
    } catch {
      return false
    }
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
    try {
      await ready
      if (
        isPeerBanned(peerId) ||
        !wireMetadata ||
        typeof wireMetadata !== 'object' ||
        Array.isArray(wireMetadata) ||
        !(authMetaKey in wireMetadata)
      ) {
        return null
      }
      const env = (wireMetadata as Record<string, unknown>)[authMetaKey]
      if (!validateActionAuthShape(env)) {
        return null
      }
      const userMetadata = Object.hasOwn(wireMetadata, 'm')
        ? (wireMetadata as {m?: JsonValue}).m
        : undefined
      const certApplied = await verifyAndApplyCert(env.cert)
      if (!certApplied) {
        const existingCert = peerCerts.get(env.cert.subPeerId)
        if (
          !existingCert ||
          existingCert.sig !== env.cert.sig ||
          roleCertCanonicalPayload(existingCert) !==
            roleCertCanonicalPayload(env.cert)
        ) {
          const chainRes = await verifyRoleCertificateChain(
            env.cert,
            appId,
            effectiveRoomId,
            rootFingerprints,
            rootUserIds
          )
          if (!chainRes.valid) {
            return null
          }
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
    } catch {
      return null
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
        throw insufficientAuthErr(`send on action "${namespace}"`)
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
        [authMetaKey]: env as unknown as JsonValue,
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
          !(await isValidDelegatedUserEndpoint({
            appId,
            roomId: effectiveRoomId,
            peerId,
            cert: env.cert,
            ...(env.signerPubKey ? {signerPubKey: env.signerPubKey} : {}),
            ...(env.userPubKey ? {userPubKey: env.userPubKey} : {}),
            ...(env.userProof ? {userProof: env.userProof} : {})
          }))) ||
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
        rootUserIds
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

    makeState: <T extends JsonValue>(
      namespace: string,
      initialValue: T,
      config: StateConfig<Widen<T>> | undefined,
      broadcastRecord: (
        record: AuthoritativeStateRecord<JsonValue>
      ) => Promise<void>
    ): AuthoritativeState<Widen<T>> => {
      type W = Widen<T>
      if (!namespace || typeof namespace !== 'string') {
        throw requiredErr('state namespace')
      }
      const rawAuth = config?.roles ?? 'admin'
      const requiredRoles = (
        Array.isArray(rawAuth) ? rawAuth : [rawAuth]
      ).filter(Boolean)

      let entry = stateInstances.get(namespace) as
        | StateInstanceEntry<W>
        | undefined
      if (!entry) {
        entry = {
          namespace,
          value: initialValue as W,
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
          | AuthoritativeStateRecord<W>
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
            AuthoritativeStateRecord<W>
          > => {
            await ready
            const myRoles = getPeerRoles(localSelfId)
            if (!hasRequiredRole(myRoles, entry.requiredRoles) || !localCert) {
              throw insufficientAuthErr(`update state "${namespace}"`)
            }
            const prevValue = entry.value
            const nextValue =
              typeof nextOrUpdater === 'function'
                ? (nextOrUpdater as (prev: W) => W)(prevValue)
                : nextOrUpdater
            const nextSeq = entry.record ? entry.record.seq + 1 : 1
            const prevHash =
              entry.record?.hash ?? '00000000000000000000000000000000'
            const cryptoId = await getLocalCryptoIdentity()
            const localUid = getPeerUserId?.(localSelfId)
            const {userPubKey, userProof} = await buildLocalUserDelegationProof(
              cryptoId.signPubJwk
            )
            const record = await signStateRecord<W>(
              cryptoId.signPrivateKey,
              cryptoId.signPubJwk,
              localCert,
              {
                appId,
                roomId: effectiveRoomId,
                namespace,
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
            handler(entry.value, initialValue as W, entry.meta)
          }
        }
      }
    },

    getAuthorityInfo: async (): Promise<Omit<SelfInfo, 'peerId'>> => {
      const {resolved} = await ready
      const roles = getPeerRoles(localSelfId)
      return {
        roomId: effectiveRoomId,
        baseRoomId: resolved.baseRoomId,
        fingerprint: resolved.roomFingerprint,
        isAdmin: roles.includes('admin'),
        roles,
        userId: resolved.localUser.userId
      }
    },

    issueRoleCertificate: async (
      peerOrUserId: string,
      role: string | string[],
      options: {canDelegate?: boolean} | undefined,
      requestWhois: () => void
    ): Promise<RoleCertificate> => {
      requireTargetId(peerOrUserId, 'grant a role')
      await ready
      const myRoles = getPeerRoles(localSelfId)
      const requestedRoles = (Array.isArray(role) ? role : [role]).filter(
        Boolean
      )
      if (requestedRoles.length === 0) {
        throw mkErr('at least one role must be specified')
      }
      const canGrant =
        Boolean(localAdminUser) ||
        (Boolean(localCert?.canDelegate) &&
          !localCert?.parentCert &&
          (myRoles.includes('admin') ||
            requestedRoles.every(r => myRoles.includes(r))))
      if (!canGrant) {
        throw insufficientAuthErr('grant role')
      }

      const {peerId, userId: subUserId} = resolveTargetIds(peerOrUserId)
      const subPubKey = await waitForPeerPublicKey(peerId, requestWhois)
      const currentRoles = getPeerRoles(peerId)
      const mergedRoles = [...new Set([...currentRoles, ...requestedRoles])]
      const cryptoId = await getLocalCryptoIdentity()
      const existingPeerCert = peerCerts.get(peerId)
      const existingUserCert = subUserId ? userCerts.get(subUserId) : undefined
      const existingRevs = [
        ...(peerRevocations.get(peerId) ?? []),
        ...(subUserId ? (userRevocations.get(subUserId) ?? []) : [])
      ]
      let minIat = localAdminUser ? 0 : (localCert?.iat ?? 0)
      if (existingPeerCert) {
        minIat = Math.max(minIat, existingPeerCert.iat + 1)
      }
      if (existingUserCert) {
        minIat = Math.max(minIat, existingUserCert.iat + 1)
      }
      for (const r of existingRevs) {
        minIat = Math.max(minIat, r.ts + 1)
      }
      const certNow = Math.max(
        nextMonotonicTs(),
        Math.min(minIat, Date.now() + maxCertClockSkewMs)
      )

      const cert = await signRoleCertificate(
        localAdminUser ? localAdminUser.sign : cryptoId.signPrivateKey,
        localAdminUser ? localAdminUser.signPubJwk : cryptoId.signPubJwk,
        {
          subPeerId: peerId,
          ...(subUserId ? {subUserId} : {}),
          subPubKey,
          appId,
          roomId: effectiveRoomId,
          roles: mergedRoles,
          now: certNow,
          ...(options?.canDelegate ? {canDelegate: true} : {}),
          ...(localAdminUser ? {} : {parentCert: localCert!})
        }
      )

      await verifyAndApplyCert(cert)
      return cert
    },

    issueRoleRevocation: async (
      peerOrUserId: string,
      role?: string
    ): Promise<RoleRevocationRecord> => {
      requireTargetId(peerOrUserId, 'revoke a role')
      await ready
      const myRoles = getPeerRoles(localSelfId)
      if (!myRoles.includes('admin') && !localCert?.canDelegate) {
        throw revokeRoleAuthErr
      }
      const {peerId, userId: targetUserId} = resolveTargetIds(peerOrUserId)
      const targetCert =
        peerCerts.get(peerId) ??
        (targetUserId ? userCerts.get(targetUserId) : undefined)
      if (
        !localCert?.isRoot &&
        isTargetRootAuthority(peerId, targetUserId, targetCert)
      ) {
        throw rootAdminProtectErr('authority', 'revoke')
      }
      if (!localCert || !canRevokeRoles(localCert, targetCert, role)) {
        throw revokeRoleAuthErr
      }
      const cryptoId = await getLocalCryptoIdentity()
      const userProofFields = await buildLocalUserDelegationProof(
        cryptoId.signPubJwk
      )
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
          seq: ++localAuthSeq,
          ...userProofFields
        }
      )
      if (!(await verifyAndApplyRevocation(revocation))) {
        throw revokeRoleAuthErr
      }
      return revocation
    },

    issuePeerBan: async (
      peerOrUserId: string,
      options?: {reason?: string}
    ): Promise<PeerBanRecord> => {
      requireTargetId(peerOrUserId, 'ban a peer')
      await ready
      const myRoles = getPeerRoles(localSelfId)
      if (!myRoles.includes('admin') || !localCert) {
        throw adminOnlyBanErr
      }
      const {peerId, userId: targetUserId} = resolveTargetIds(peerOrUserId)
      const targetCert =
        peerCerts.get(peerId) ??
        (targetUserId ? userCerts.get(targetUserId) : undefined)
      if (
        !localCert.isRoot &&
        isTargetRootAuthority(peerId, targetUserId, targetCert)
      ) {
        throw rootAdminProtectErr('admin', 'ban')
      }
      const cryptoId = await getLocalCryptoIdentity()
      const userProofFields = await buildLocalUserDelegationProof(
        cryptoId.signPubJwk
      )
      const ban = await signPeerBan(cryptoId.signPrivateKey, localCert, {
        appId,
        roomId: effectiveRoomId,
        issuerPeerId: localSelfId,
        targetPeerId: peerId,
        ...(targetUserId ? {targetUserId} : {}),
        ...(options?.reason ? {reason: options.reason} : {}),
        seq: ++localAuthSeq,
        ...userProofFields
      })
      if (!(await verifyAndApplyBan(ban))) {
        throw adminOnlyBanErr
      }
      return ban
    }
  }
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
    }
  | {
      t: 'revoke'
      revocation: RoleRevocationRecord
    }
  | {
      t: 'ban'
      ban: PeerBanRecord
    }
  | {
      t: 'state'
      record: AuthoritativeStateRecord
    }

const selfAsAdminPlugins = new WeakSet<RoomPlugin<string, any>>()

export const isSelfAsAdminPlugin = (plugin: RoomPlugin<string, any>): boolean =>
  selfAsAdminPlugins.has(plugin)

export const roles = (
  config?: RolesConfig
): RoomPlugin<'roles', RolesPluginApi> => {
  const normalizedConfig = normalizeRolesConfig(config)
  const plugin = definePlugin<'roles', RolesPluginApi>('roles', {
    resolveRoomId: ({roomId, userIdentityP}) => {
      const resolvedP = resolveRoomAuthority(
        roomId,
        normalizedConfig,
        userIdentityP
      )
      return resolvedP.then(resolved => ({
        effectiveRoomId: resolved.effectiveRoomId,
        state: resolvedP
      }))
    },
    setup: (kernel, preResolvedState) => {
      const resolvedAuthorityP = preResolvedState as
        | Promise<ResolvedRoomAuthority>
        | undefined

      const authority = createRoomAuthority({
        selfId: kernel.selfId,
        appId: kernel.appId,
        initialRoomId: kernel.initialRoomId,
        ...(normalizedConfig === undefined ? {} : {admin: normalizedConfig}),
        ...(resolvedAuthorityP === undefined ? {} : {resolvedAuthorityP}),
        getLocalCryptoIdentity: () =>
          getOrCreateEndpointIdentity(kernel.selfId),
        getLocalUserIdentity: () => kernel.getLocalUserIdentity(),
        getOverlayPeerPublicKey: peerId => kernel.getPeerPublicKey(peerId),
        isOverlayPeerBanned: peerId =>
          kernel.getScaleProvider()?.isPeerBanned(peerId) ?? false,
        getPeerUserId: peerId => kernel.getKnownPeerUserId(peerId),
        getUserPeerIds: userId => kernel.getUserPeerIds(userId),
        onRoomIdResolved: effectiveRoomId =>
          kernel.setEffectiveRoomId(effectiveRoomId),
        onPeerPublicKey: (peerId, pubKey) =>
          kernel.setPeerPublicKey(peerId, pubKey),
        onLocalRoleCertificate: cert =>
          kernel.getScaleProvider()?.setLocalRoleCertificate(cert),
        onPeerBanned: (peerId, targetUserId) => {
          const sp = kernel.getScaleProvider()
          sp?.markPeerBanned(peerId)
          if (peerId !== kernel.selfId && kernel.getPeerHandle(peerId, true)) {
            kernel.kickPeer(peerId, peerBannedErr)
          }
          if (targetUserId) {
            for (const pid of kernel.getAllPeerIds()) {
              if (
                pid !== kernel.selfId &&
                kernel.getPeerUserId(pid) === targetUserId
              ) {
                sp?.markPeerBanned(pid)
                kernel.kickPeer(pid, peerBannedErr)
              }
            }
          }
        },
        onSignatureFailure: () =>
          kernel.getScaleProvider()?.recordSignatureFailure()
      })

      const rawAuthAction = kernel.makeInternalAction<JsonValue>('auth', {
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

      const sendAuthSyncToPeer = async (
        targetPeerId: string,
        force = false
      ): Promise<void> => {
        if (
          !targetPeerId ||
          targetPeerId === kernel.selfId ||
          authority.isPeerBanned(targetPeerId)
        ) {
          return
        }
        const syncPayload = await authority.buildSyncMessage(force)
        if (!syncPayload || !kernel.isPeerActive(targetPeerId)) {
          return
        }
        await authAction
          .send(
            {
              t: 'sync',
              ...syncPayload
            },
            targetPeerId
          )
          .catch(noOp)
      }

      authAction.onMessage((msg, fromPeerId) => {
        if (!msg || typeof msg !== 'object') {
          return
        }
        if (msg.t === 'whois') {
          void sendAuthSyncToPeer(fromPeerId, true)
          return
        }
        if (msg.t === 'sync') {
          void (async () => {
            if (msg.pubKey) {
              authority.registerPeerPublicKey(fromPeerId, msg.pubKey)
            }
            const newBans: PeerBanRecord[] = []
            const newRevs: RoleRevocationRecord[] = []
            const newCerts: RoleCertificate[] = []
            const newStates: AuthoritativeStateRecord[] = []

            if (Array.isArray(msg.certs)) {
              for (const c of msg.certs) {
                if (await authority.verifyAndApplyCert(c)) {
                  newCerts.push(c)
                }
              }
            }
            if (Array.isArray(msg.revocations)) {
              for (const r of msg.revocations) {
                if (await authority.verifyAndApplyRevocation(r)) {
                  newRevs.push(r)
                }
              }
            }
            if (Array.isArray(msg.bans)) {
              for (const b of msg.bans) {
                if (await authority.verifyAndApplyBan(b)) {
                  newBans.push(b)
                }
              }
            }
            if (Array.isArray(msg.states)) {
              for (const s of msg.states) {
                if (await authority.verifyAndApplyStateRecord(s)) {
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
              const directIds =
                kernel.getScaleProvider()?.getSnapshot().directPeerIds ??
                kernel.getActivePeerIds()
              const directNeighbors = directIds.filter(
                id => id !== fromPeerId && id !== kernel.selfId
              )
              if (directNeighbors.length > 0) {
                void authAction
                  .send(
                    {
                      t: 'sync',
                      ...(newCerts.length > 0 ? {certs: newCerts} : {}),
                      ...(newRevs.length > 0 ? {revocations: newRevs} : {}),
                      ...(newBans.length > 0 ? {bans: newBans} : {}),
                      ...(newStates.length > 0 ? {states: newStates} : {})
                    },
                    directNeighbors
                  )
                  .catch(noOp)
              }
            }
          })()
          return
        }
        if (msg.t === 'cert') {
          void authority.verifyAndApplyCert(msg.cert).then(applied => {
            if (!applied && !authority.hasCertForPeer(msg.cert?.subPeerId)) {
              kernel.getScaleProvider()?.recordSignatureFailure()
            }
          })
          return
        }
        if (msg.t === 'revoke') {
          void authority
            .verifyAndApplyRevocation(msg.revocation)
            .then(applied => {
              if (
                !applied &&
                !authority.hasRevocationSig(msg.revocation?.sig)
              ) {
                kernel.getScaleProvider()?.recordSignatureFailure()
              }
            })
          return
        }
        if (msg.t === 'ban') {
          void authority.verifyAndApplyBan(msg.ban).then(applied => {
            if (
              !applied &&
              !authority.hasBanSig(msg.ban?.targetPeerId, msg.ban?.sig)
            ) {
              kernel.getScaleProvider()?.recordSignatureFailure()
            }
          })
          return
        }
        if (msg.t === 'state') {
          void authority.verifyAndApplyStateRecord(msg.record)
        }
      })

      kernel.registerRolesProvider({
        getEffectiveRoomId: authority.getEffectiveRoomId,
        getPeerRoles: authority.getPeerRoles,
        isPeerBanned: authority.isPeerBanned,
        registerPeerPublicKey: authority.registerPeerPublicKey,
        canPeerSendAction: authority.canPeerSendAction,
        onPeerDescriptorCert: (peerId, signPubKey, cert, userId) => {
          if (
            authority.isPeerBanned(peerId) ||
            (userId && authority.isPeerBanned(userId))
          ) {
            kernel.getScaleProvider()?.markPeerBanned(peerId)
            return
          }
          authority.registerPeerPublicKey(peerId, signPubKey)
          if (cert) {
            void authority.verifyAndApplyCert(cert)
          }
        },
        signActionPayload: authority.signActionPayload,
        verifyActionOffer: authority.verifyActionOffer,
        verifyActionPayload: authority.verifyActionPayload,
        getAuthorityInfo: authority.getAuthorityInfo
      })

      for (const peerId of kernel.getActivePeerIds()) {
        void sendAuthSyncToPeer(peerId)
      }
      kernel.onPeerActivated(peerId => {
        void sendAuthSyncToPeer(peerId)
      })

      return {
        makeState: <T extends JsonValue>(
          namespace: string,
          initialValue: T,
          stateConfig?: StateConfig<Widen<T>>
        ): AuthoritativeState<Widen<T>> =>
          authority.makeState(
            namespace,
            initialValue,
            stateConfig,
            async record => {
              await authAction
                .send({
                  t: 'state',
                  record
                })
                .catch(noOp)
            }
          ),

        grantRole: async (peerId, role, options) => {
          const targetPeerId = kernel.resolveRequestTarget(peerId) ?? peerId
          const cert = await authority.issueRoleCertificate(
            peerId,
            role,
            options,
            () => {
              void authAction.send({t: 'whois'}, targetPeerId).catch(noOp)
            }
          )
          await authAction.send({t: 'cert', cert}).catch(noOp)
          return cert
        },

        revokeRole: async (peerId, role) => {
          const revocation = await authority.issueRoleRevocation(peerId, role)
          await authAction.send({t: 'revoke', revocation}).catch(noOp)
        },

        getRoles: (peerId?: string) =>
          authority.getPeerRoles(peerId ?? kernel.selfId),

        ban: async (peerId, options) => {
          const ban = await authority.issuePeerBan(peerId, options)
          await authAction.send({t: 'ban', ban}).catch(noOp)
        },

        isBanned: (peerId: string) => authority.isPeerBanned(peerId)
      }
    }
  })
  if (normalizedConfig?.selfAsAdmin) {
    selfAsAdminPlugins.add(plugin)
  }
  return plugin
}
