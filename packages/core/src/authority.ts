import {ecdsaSign, ecdsaVerify, sha256} from './crypto'
import {
  canonicalizePubJwk,
  computeUserIdFingerprint,
  createUserIdentity,
  decodePublicKey,
  defaultUserIdentity,
  encodePublicKey,
  fromBase64Url,
  getCachedPubKeyRecord,
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
  createBoundedSet,
  definePlugin,
  encodeBytes,
  genId,
  mkErr,
  noOp,
  selfCertifyingRoomRegex,
  toHex,
  toJson
} from './utils'
import type {
  AuthorityConfig,
  AuthoritativeState,
  AuthoritativeStateRecord,
  DataPayload,
  JsonValue,
  MaybePromise,
  PeerBanRecord,
  RoleCertificate,
  RoleRevocationRecord,
  RolesInput,
  RoomAuthorityInfo,
  RoomPlugin,
  StateChangeContext,
  StateConfig,
  TargetPeers,
  UserIdentity,
  UserIdentityConfig
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

export const computePublicKeyFingerprint = async (
  pubKeyOrJwk: JsonWebKey | string
): Promise<string> => {
  if (typeof pubKeyOrJwk === 'string' && isValidUserId(pubKeyOrJwk)) {
    return computeUserIdFingerprint(pubKeyOrJwk)
  }
  const rec = await getVerifiedPubKeyRecord(pubKeyOrJwk)
  if (!rec) {
    throw mkErr('invalid ECDSA P-256 public key')
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
    throw mkErr('fingerprint must be a 16-character Base62 string')
  }
  const parsed = parseSelfCertifyingRoomId(baseRoomId)
  if (parsed.fingerprint === fingerprint) {
    return baseRoomId
  }
  return `${baseRoomId}.${fingerprint}`
}

export const createAdminRoom = async (
  baseRoomId: string,
  options?: {
    appId?: string
    identity?: UserIdentityConfig
  }
): Promise<{
  roomId: string
  baseRoomId: string
  fingerprint: string
  userId: string
  identity: UserIdentity
}> => {
  if (!baseRoomId || typeof baseRoomId !== 'string') {
    throw mkErr('baseRoomId is required')
  }
  const parsed = parseSelfCertifyingRoomId(baseRoomId)
  const cleanBase = parsed.baseRoomId
  const identity =
    options?.identity !== undefined || options?.appId !== undefined
      ? await resolveUserIdentity(options.appId ?? '', cleanBase, options)
      : await createUserIdentity()
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
  signalingProofs: boolean
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

export const normalizeRolesConfig = (
  input?: RolesInput
): AuthorityConfig | undefined => {
  if (input === undefined) {
    return undefined
  }
  if (input === true) {
    return {create: true}
  }
  if (input === false) {
    return {}
  }
  if (typeof input === 'string') {
    return {users: [input]}
  }
  if (Array.isArray(input)) {
    return {users: input}
  }
  if (typeof input === 'object') {
    const create = Boolean(input.create || input.admin === true)
    const users = Array.isArray(input.users)
      ? input.users
      : typeof input.admin === 'string'
        ? [input.admin]
        : Array.isArray(input.admin)
          ? input.admin
          : undefined
    return {
      ...(create ? {create: true} : {}),
      ...(users ? {users} : {}),
      ...(input.signalingProofs === false ? {signalingProofs: false} : {})
    }
  }
  return undefined
}

export const resolveRoomAuthority = async (
  rawRoomId: string,
  adminOption?: RolesInput,
  localUserP?: Promise<UserIdentity>
): Promise<ResolvedRoomAuthority> => {
  const normalized = normalizeRolesConfig(adminOption)
  const parsed = parseSelfCertifyingRoomId(rawRoomId)
  const rootFingerprints = new Set<string>()
  const rootUserIds = new Set<string>()
  let effectiveRoomId = rawRoomId
  let roomFingerprint = parsed.fingerprint
  let signalingProofs = true

  if (parsed.fingerprint) {
    rootFingerprints.add(parsed.fingerprint)
  }

  let resolvedLocalUser: UserIdentity | null = null
  const getLocalUser = async (): Promise<UserIdentity> => {
    if (!resolvedLocalUser) {
      resolvedLocalUser = localUserP ? await localUserP : defaultUserIdentity
    }
    return resolvedLocalUser
  }

  if (normalized) {
    if (normalized.signalingProofs === false) {
      signalingProofs = false
    }
    if (normalized.create && !parsed.fingerprint) {
      const user = await getLocalUser()
      roomFingerprint = computeUserIdFingerprint(user.userId)
      effectiveRoomId = formatSelfCertifyingRoomId(rawRoomId, roomFingerprint)
      rootFingerprints.add(roomFingerprint)
      rootUserIds.add(user.userId)
    }
    if (!parsed.fingerprint && Array.isArray(normalized.users)) {
      for (const entry of normalized.users) {
        if (typeof entry === 'string') {
          await addRootEntry(entry, rootFingerprints, rootUserIds)
        }
      }
    }
  }

  const localUser =
    rootFingerprints.size > 0 || rootUserIds.size > 0 || localUserP
      ? await getLocalUser()
      : defaultUserIdentity
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
    hasAuthorityAnchor,
    signalingProofs
  }
}

const roleCertCanonicalPayload = (cert: Omit<RoleCertificate, 'sig'>): string =>
  toJson([
    'trystero-role-cert-v1',
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
  const sigBytes =
    typeof signer === 'function'
      ? await signer(canonicalBytes)
      : await ecdsaSign(signer, canonicalBytes as BufferSource)
  return {
    ...unsigned,
    sig: toBase64Url(sigBytes)
  }
}

const maxCertClockSkewMs = 60_000

export const verifyRoleCertificateChain = async (
  cert: RoleCertificate,
  appId: string,
  roomId: string,
  rootFingerprints: ReadonlySet<string>,
  rootUserIds?: ReadonlySet<string>,
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
    !(await verifyPeerIdKey(cert.subPeerId, cert.subPubKey)) ||
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
    typeof parent !== 'object' ||
    !parent.canDelegate ||
    !parent.subPubKey ||
    !Array.isArray(parent.roles)
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
    'trystero-role-revoke-v1',
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
    signerPubKey?: JsonWebKey
    userPubKey?: JsonWebKey
    userProof?: string
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
    !rev ||
    rev.v !== 1 ||
    rev.appId !== appId ||
    rev.roomId !== roomId ||
    !rev.issuerPeerId ||
    !rev.targetPeerId ||
    typeof rev.seq !== 'number' ||
    !Number.isSafeInteger(rev.seq) ||
    rev.seq <= 0 ||
    typeof rev.ts !== 'number' ||
    !Number.isSafeInteger(rev.ts) ||
    rev.ts <= 0 ||
    !rev.issuerCert ||
    typeof rev.issuerCert !== 'object' ||
    !Array.isArray(rev.issuerCert.roles) ||
    !rev.issuerCert.subPubKey ||
    typeof rev.sig !== 'string' ||
    'targetKeyThumbprint' in rev ||
    'reason' in rev
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
    'trystero-peer-ban-v1',
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
    signerPubKey?: JsonWebKey
    userPubKey?: JsonWebKey
    userProof?: string
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
    !ban ||
    ban.v !== 1 ||
    ban.appId !== appId ||
    ban.roomId !== roomId ||
    !ban.issuerPeerId ||
    !ban.targetPeerId ||
    typeof ban.seq !== 'number' ||
    !Number.isSafeInteger(ban.seq) ||
    ban.seq <= 0 ||
    typeof ban.ts !== 'number' ||
    !Number.isSafeInteger(ban.ts) ||
    ban.ts <= 0 ||
    !ban.issuerCert ||
    typeof ban.issuerCert !== 'object' ||
    !Array.isArray(ban.issuerCert.roles) ||
    !ban.issuerCert.subPubKey ||
    typeof ban.sig !== 'string' ||
    'targetCertId' in ban ||
    'role' in ban
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
    'trystero-action-auth-v1',
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
  if (
    !env ||
    env.v !== 1 ||
    typeof env.seq !== 'number' ||
    !Number.isSafeInteger(env.seq) ||
    env.seq <= 0 ||
    typeof env.digest !== 'string' ||
    !env.cert ||
    typeof env.cert !== 'object' ||
    !Array.isArray(env.cert.roles) ||
    !env.cert.subPubKey ||
    typeof env.sig !== 'string'
  ) {
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

export const stateRecordCanonicalPayload = <T extends JsonValue = JsonValue>(
  rec: Omit<AuthoritativeStateRecord<T>, 'sig' | 'hash'>
): string =>
  toJson([
    'trystero-state-record-v1',
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

export const verifyStateRecord = async <T extends JsonValue = JsonValue>(
  rec: AuthoritativeStateRecord<T>,
  appId: string,
  roomId: string,
  requiredRoles: readonly string[],
  rootFingerprints: ReadonlySet<string>,
  rootUserIds?: ReadonlySet<string>
): Promise<boolean> => {
  if (
    !rec ||
    rec.v !== 1 ||
    rec.appId !== appId ||
    rec.roomId !== roomId ||
    typeof rec.namespace !== 'string' ||
    !rec.namespace ||
    typeof rec.seq !== 'number' ||
    !Number.isSafeInteger(rec.seq) ||
    rec.seq <= 0 ||
    typeof rec.epoch !== 'number' ||
    !Number.isSafeInteger(rec.epoch) ||
    rec.epoch <= 0 ||
    typeof rec.ts !== 'number' ||
    !Number.isSafeInteger(rec.ts) ||
    rec.ts <= 0 ||
    typeof rec.prevHash !== 'string' ||
    !rec.prevHash ||
    (rec.epoch === 1 &&
      rec.seq === 1 &&
      rec.prevHash !== '00000000000000000000000000000000') ||
    typeof rec.updatedBy !== 'string' ||
    !rec.updatedBy ||
    typeof rec.hash !== 'string' ||
    !rec.cert ||
    typeof rec.cert !== 'object' ||
    !Array.isArray(rec.cert.roles) ||
    !rec.cert.subPubKey ||
    !rec.signerPubKey ||
    typeof rec.signerPubKey !== 'object' ||
    typeof rec.sig !== 'string'
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
  admin?: RolesInput
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
        (uid && uid === getPeerUserId?.(localSelfId)))
    ) {
      const normalized = normalizeRolesConfig(admin)
      if (normalized?.create) {
        return ['admin']
      }
      const localUid = getPeerUserId?.(localSelfId)
      if (localUid && isValidUserId(localUid)) {
        const localFp = computeUserIdFingerprint(localUid)
        const parsedInit = parseSelfCertifyingRoomId(initialRoomId)
        if (parsedInit.fingerprint === localFp) {
          return ['admin']
        }
        const entries = normalized?.users ?? []
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
    if (resolved.hasAuthorityAnchor || localAdminUser) {
      const cryptoId = await getLocalCryptoIdentity()
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
        !(localCert?.subPeerId === localSelfId && localCert.isRoot) &&
        (!localCert || localCert.iat <= cert.iat))
    ) {
      localCert = cert
      onLocalRoleCertificate(cert)
    }
    return true
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
    if (!rev || typeof rev !== 'object' || allRevocations.has(rev.sig)) {
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
      rootUserIds
    )
    if (!valid || !getEffectiveRolesForCert(ban.issuerCert).includes('admin')) {
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
      rootUserIds
    )
    if (!isValid) {
      onSignatureFailure()
      return false
    }
    const current = instance?.record ?? latestStateRecords.get(record.namespace)
    if (current) {
      if (compareStateRecords(record, current) <= 0) {
        return false
      }
      if (
        record.epoch === current.epoch &&
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
    if (
      !env ||
      !env.cert ||
      typeof env.cert !== 'object' ||
      !Array.isArray(env.cert.roles) ||
      !env.cert.subPubKey
    ) {
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
      const rawAuth = config?.roles ?? 'admin'
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
        userId: resolved.localUser.userId
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
        Boolean(localAdminUser) ||
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
        localAdminUser ? localAdminUser.sign : cryptoId.signPrivateKey,
        localAdminUser ? localAdminUser.signPubJwk : cryptoId.signPubJwk,
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
      if (
        !localCert?.isRoot &&
        isTargetRootAuthority(peerId, targetUserId, targetCert)
      ) {
        throw mkErr('delegated authority cannot revoke a root admin')
      }
      if (!localCert || !canRevokeRoles(localCert, targetCert, role)) {
        throw mkErr('insufficient authority to revoke role')
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
        throw mkErr('insufficient authority to revoke role')
      }
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
      if (
        !localCert.isRoot &&
        isTargetRootAuthority(peerId, targetUserId, targetCert)
      ) {
        throw mkErr('delegated admin cannot ban a root admin')
      }
      const targetPubKey =
        peerSignKeys.get(peerId) ?? getOverlayPeerPublicKey(peerId)
      const targetKeyThumbprint = targetPubKey
        ? toJson(targetPubKey)
        : undefined
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
        ...(targetKeyThumbprint ? {targetKeyThumbprint} : {}),
        ...(options?.reason ? {reason: options.reason} : {}),
        seq: ++localAuthSeq,
        ...userProofFields
      })
      if (!(await verifyAndApplyBan(ban))) {
        throw mkErr('only an admin can ban a peer')
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
      reqId?: string
      ackPeers?: string[]
    }
  | {
      t: 'revoke'
      revocation: RoleRevocationRecord
      reqId?: string
      ackPeers?: string[]
    }
  | {
      t: 'ban'
      ban: PeerBanRecord
      reqId?: string
      ackPeers?: string[]
    }
  | {
      t: 'state'
      record: AuthoritativeStateRecord
    }
  | {
      t: 'ack'
      reqId: string
    }

export const roles = (
  config?: RolesInput
): RoomPlugin<
  'roles',
  {
    makeState: <T extends JsonValue = JsonValue>(
      namespace: string,
      initialValue: T,
      stateConfig?: StateConfig<T>
    ) => AuthoritativeState<T>
    grantRole: (
      targetId: string,
      role: string | string[],
      options?: {canDelegate?: boolean; expiresInMs?: number}
    ) => Promise<RoleCertificate>
    revokeRole: (targetId: string, role?: string) => Promise<void>
    getRoles: (targetId?: string) => string[]
    ban: (targetId: string, options?: {reason?: string}) => Promise<void>
    isBanned: (targetId: string) => boolean
  }
> =>
  definePlugin('roles', {
    resolveRoomId: ({roomId, userIdentityP}) => {
      const resolvedP = resolveRoomAuthority(roomId, config, userIdentityP)
      return resolvedP.then(resolved => ({
        effectiveRoomId: resolved.effectiveRoomId,
        state: resolvedP
      }))
    },
    setup: (kernel, preResolvedState) => {
      const resolvedAuthorityP = preResolvedState as
        | Promise<ResolvedRoomAuthority>
        | undefined
      const pendingAuthAckWaiters = new Map<
        string,
        {
          expectedPeers: Set<string>
          resolve: () => void
          timer: ReturnType<typeof setTimeout>
        }
      >()

      const authority = createRoomAuthority({
        selfId: kernel.selfId,
        appId: kernel.appId,
        initialRoomId: kernel.initialRoomId,
        ...(config === undefined ? {} : {admin: config}),
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
        onPrivilegedPeer: (peerId, isPriv) =>
          kernel.getScaleProvider()?.setPrivilegedPeer(peerId, isPriv),
        onPeerBanned: (peerId, keyThumbprint, targetUserId) => {
          const sp = kernel.getScaleProvider()
          sp?.markPeerBanned(peerId, keyThumbprint)
          if (peerId !== kernel.selfId && kernel.getPeerHandle(peerId, true)) {
            kernel.kickPeer(peerId, mkErr('peer banned'))
          }
          if (targetUserId) {
            for (const pid of kernel.getAllPeerIds()) {
              if (
                pid !== kernel.selfId &&
                kernel.getPeerUserId(pid) === targetUserId
              ) {
                sp?.markPeerBanned(pid)
                kernel.kickPeer(pid, mkErr('peer banned'))
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

      const waitForAuthAck = (
        reqId: string,
        targetPeers: string[],
        timeoutMs = 150
      ): Promise<void> => {
        const activeTargets = targetPeers.filter(
          id => id !== kernel.selfId && kernel.isPeerActive(id)
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

      const sendAuthAckIfRequested = (
        msg: {reqId?: string; ackPeers?: string[]},
        fromPeerId: string
      ): void => {
        if (
          msg.reqId &&
          (!msg.ackPeers || msg.ackPeers.includes(kernel.selfId))
        ) {
          void authAction
            .send({t: 'ack', reqId: msg.reqId}, fromPeerId)
            .catch(noOp)
        }
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
            sendAuthAckIfRequested(msg, fromPeerId)
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
              sendAuthAckIfRequested(msg, fromPeerId)
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
            sendAuthAckIfRequested(msg, fromPeerId)
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

      const broadcastAuthWithAck = async (
        payload:
          | {t: 'cert'; cert: RoleCertificate}
          | {t: 'revoke'; revocation: RoleRevocationRecord}
          | {t: 'ban'; ban: PeerBanRecord},
        allCandidatePeers: string[],
        extraAckPeer?: string,
        excludePeers?: ReadonlySet<string>
      ): Promise<void> => {
        const reqId = genId(12)
        const directIds =
          kernel.getScaleProvider()?.getSnapshot().directPeerIds ??
          kernel.getActivePeerIds()
        const boundedAckPeers =
          allCandidatePeers.length > 16
            ? [
                ...new Set([
                  ...directIds.filter(id => !excludePeers?.has(id)),
                  ...(extraAckPeer ? [extraAckPeer] : [])
                ])
              ]
            : undefined
        const ackWait = waitForAuthAck(
          reqId,
          boundedAckPeers ?? allCandidatePeers
        )
        await authAction
          .send({
            ...payload,
            reqId,
            ...(boundedAckPeers ? {ackPeers: boundedAckPeers} : {})
          })
          .catch(noOp)
        await ackWait
      }

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
        getAuthorityInfo: authority.getAuthorityInfo,
        getAnnounceExtra: authority.getAnnounceExtra,
        onSignalingPayload: authority.onSignalingPayload
      })

      kernel.onPeerActivated(peerId => {
        void sendAuthSyncToPeer(peerId)
      })

      return {
        makeState: <T extends JsonValue = JsonValue>(
          namespace: string,
          initialValue: T,
          stateConfig?: StateConfig<T>
        ): AuthoritativeState<T> =>
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
          await broadcastAuthWithAck(
            {t: 'cert', cert},
            kernel.getActivePeerIds(),
            targetPeerId
          )
          return cert
        },

        revokeRole: async (peerId, role) => {
          const targetPeerId = kernel.resolveRequestTarget(peerId) ?? peerId
          const revocation = await authority.issueRoleRevocation(peerId, role)
          await broadcastAuthWithAck(
            {t: 'revoke', revocation},
            kernel.getActivePeerIds(),
            targetPeerId
          )
        },

        getRoles: (peerId?: string) =>
          authority.getPeerRoles(peerId ?? kernel.selfId),

        ban: async (peerId, options) => {
          const resolvedSend = kernel.resolveSendTarget(peerId)
          const targetPeers = new Set(
            Array.isArray(resolvedSend) ? resolvedSend : [peerId]
          )
          const otherPeers = kernel
            .getActivePeerIds()
            .filter(id => !targetPeers.has(id))
          const ban = await authority.issuePeerBan(peerId, options)
          await broadcastAuthWithAck(
            {t: 'ban', ban},
            otherPeers,
            undefined,
            targetPeers
          )
        },

        isBanned: (peerId: string) => authority.isPeerBanned(peerId)
      }
    }
  })
