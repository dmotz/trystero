import {
  ecdsaKeyAlgo,
  ecdsaSign,
  ecdsaVerify,
  isLowSP256Signature,
  isValidP256PrivateScalar,
  normalizeLowSP256Signature,
  sha256
} from './crypto'
import {
  base62Alphabet,
  bytesMatch,
  bytesToBigInt,
  createBoundedCache,
  decodeBytes,
  encodeBytes,
  fromBase64Url,
  fromJson,
  libId,
  mkErr,
  peerIdLength,
  toBase64,
  toBase64Url,
  toHex,
  toJson,
  userIdLength
} from './primitives'
import {
  buildUserIdentityFromIdbRecord,
  deleteIdbIdentity,
  loadOrCreateIdbIdentity,
  type StoredIdbIdentityRecord
} from './identity-idb'
import {invalidP256KeyErr, noOp, requiredErr, userIdRegex, warn} from './utils'
import type {
  ResolvedIdentityPersistence,
  UserIdentity,
  UserIdentityConfig,
  UserIdentityPersistence
} from './types'

export {
  base62Alphabet,
  decodeBytes,
  encodeBytes,
  fromBase64Url,
  peerIdLength,
  toBase64Url,
  userIdLength
}

const base62Radix = 62n
const userKeyPrefix = `${libId}_uk_`
const maxCachedSigPayloadBytes = 4_096
const keyPairTestPayload = /*@__PURE__*/ new Uint8Array([0x74])

const invalidKeyMaterialErr = /*@__PURE__*/ mkErr(
  'invalid user identity key material; expected exported userKey or P-256 JWK'
)
const userIdMismatchErr = /*@__PURE__*/ mkErr(
  'invalid custom user identity; userId does not match signPubJwk'
)
const invalidCustomIdentityErr = /*@__PURE__*/ mkErr(
  'invalid custom user identity; use "local", "none", loader, or importUserIdentity()'
)

export const encodeBase62 = (bytes: Uint8Array, length: number): string => {
  const modulus = base62Radix ** BigInt(length)
  let val = bytesToBigInt(bytes) % modulus
  let out = ''
  for (let i = 0; i < length; i++) {
    out = base62Alphabet[Number(val % base62Radix)]! + out
    val /= base62Radix
  }
  return out
}

export const pubJwkToUncompressedBytes = (
  jwk: JsonWebKey
): Uint8Array | null => {
  if (
    !jwk ||
    jwk.d !== undefined ||
    (jwk.kty && jwk.kty !== 'EC') ||
    (jwk.crv && jwk.crv !== 'P-256') ||
    typeof jwk.x !== 'string' ||
    typeof jwk.y !== 'string' ||
    !jwk.x ||
    !jwk.y
  ) {
    return null
  }
  try {
    const xBytes = fromBase64Url(jwk.x)
    const yBytes = fromBase64Url(jwk.y)
    if (
      xBytes.byteLength !== 32 ||
      yBytes.byteLength !== 32 ||
      toBase64Url(xBytes) !== jwk.x ||
      toBase64Url(yBytes) !== jwk.y
    ) {
      return null
    }
    const uncompressed = new Uint8Array(65)
    uncompressed[0] = 0x04
    uncompressed.set(xBytes, 1)
    uncompressed.set(yBytes, 33)
    return uncompressed
  } catch {
    return null
  }
}

const makeP256Jwk = (
  x = '',
  y = '',
  crv = 'P-256',
  kty = 'EC'
): JsonWebKey => ({crv, kty, x, y})

export const canonicalizePubJwk = (jwk: JsonWebKey): string =>
  toJson(
    makeP256Jwk(jwk.x ?? '', jwk.y ?? '', jwk.crv ?? 'P-256', jwk.kty ?? 'EC')
  )

export const jwkToCompactPub = (jwk: JsonWebKey): string => {
  if (!pubJwkToUncompressedBytes(jwk) || !jwk.x || !jwk.y) {
    throw invalidP256KeyErr
  }
  return `${jwk.x}.${jwk.y}`
}

export const compactPubToJwk = (pub: string): JsonWebKey | null => {
  if (typeof pub !== 'string' || pub.length !== 87 || pub[43] !== '.') {
    return null
  }
  const jwk = makeP256Jwk(pub.slice(0, 43), pub.slice(44))
  return pubJwkToUncompressedBytes(jwk) ? jwk : null
}

export const encodePublicKey = (jwk: JsonWebKey): string =>
  toBase64Url(encodeBytes(canonicalizePubJwk(jwk)))

export const decodePublicKey = (encoded: string): JsonWebKey | null => {
  if (typeof encoded !== 'string') {
    return null
  }
  const trimmed = encoded.trim()
  const compact = compactPubToJwk(trimmed)
  if (compact) {
    return compact
  }
  try {
    const parsed = fromJson<JsonWebKey>(
      trimmed.startsWith('{') ? trimmed : decodeBytes(fromBase64Url(trimmed))
    )
    return parsed && parsed.kty === 'EC' && parsed.x && parsed.y ? parsed : null
  } catch {
    return null
  }
}

export type VerifiedPubKeyRecord = readonly [
  canonicalJwk: string,
  compactPub: string,
  cleanJwk: JsonWebKey,
  verifyKey: CryptoKey,
  digest: Uint8Array,
  peerId: string,
  userId: string
]

const resolvedPubKeyCache = /*@__PURE__*/ createBoundedCache<
  string,
  VerifiedPubKeyRecord
>()
const cleanJwkRecordCache = /*@__PURE__*/ new WeakMap<
  JsonWebKey,
  VerifiedPubKeyRecord
>()
const pendingPubKeyCache = new Map<
  string,
  Promise<VerifiedPubKeyRecord | null>
>()

export const getCachedPubKeyRecord = (
  pubKeyOrJwk: JsonWebKey | string
): VerifiedPubKeyRecord | undefined => {
  if (typeof pubKeyOrJwk === 'object' && pubKeyOrJwk !== null) {
    const byRef = cleanJwkRecordCache.get(pubKeyOrJwk)
    if (byRef) {
      return byRef
    }
  }
  const jwk =
    typeof pubKeyOrJwk === 'string' ? decodePublicKey(pubKeyOrJwk) : pubKeyOrJwk
  return jwk && typeof jwk.x === 'string' && typeof jwk.y === 'string'
    ? resolvedPubKeyCache.get(canonicalizePubJwk(jwk))
    : undefined
}

export const getVerifiedPubKeyRecord = (
  pubKeyOrJwk: JsonWebKey | string,
  preimportedVerifyKey?: CryptoKey
): Promise<VerifiedPubKeyRecord | null> => {
  if (typeof pubKeyOrJwk === 'object' && pubKeyOrJwk !== null) {
    const byRef = cleanJwkRecordCache.get(pubKeyOrJwk)
    if (byRef) {
      return Promise.resolve(byRef)
    }
  }
  const jwk =
    typeof pubKeyOrJwk === 'string' ? decodePublicKey(pubKeyOrJwk) : pubKeyOrJwk
  const uncompressed = jwk ? pubJwkToUncompressedBytes(jwk) : null
  if (!jwk || !uncompressed) {
    return Promise.resolve(null)
  }
  const canonicalJwk = canonicalizePubJwk(jwk)
  const existing = resolvedPubKeyCache.get(canonicalJwk)
  if (existing) {
    return Promise.resolve(existing)
  }
  const inflight = pendingPubKeyCache.get(canonicalJwk)
  if (inflight) {
    return inflight
  }

  const p = (async (): Promise<VerifiedPubKeyRecord | null> => {
    try {
      const [verifyKey, digest] = await Promise.all([
        preimportedVerifyKey
          ? Promise.resolve(preimportedVerifyKey)
          : crypto.subtle.importKey(
              'raw',
              uncompressed as BufferSource,
              ecdsaKeyAlgo,
              false,
              ['verify']
            ),
        sha256(canonicalJwk)
      ])
      const cleanJwk = Object.freeze(makeP256Jwk(jwk.x!, jwk.y!))
      const record: VerifiedPubKeyRecord = [
        canonicalJwk,
        `${jwk.x!}.${jwk.y!}`,
        cleanJwk,
        verifyKey,
        digest,
        encodeBase62(digest, peerIdLength),
        encodeBase62(digest, userIdLength)
      ]
      cleanJwkRecordCache.set(cleanJwk, record)
      resolvedPubKeyCache.set(canonicalJwk, record)
      return record
    } catch {
      return null
    } finally {
      pendingPubKeyCache.delete(canonicalJwk)
    }
  })()

  pendingPubKeyCache.set(canonicalJwk, p)
  return p
}

const deriveId = async (
  pubKeyOrJwk: JsonWebKey | string,
  idx: 5 | 6
): Promise<string> => {
  const rec = await getVerifiedPubKeyRecord(pubKeyOrJwk)
  if (!rec) {
    throw invalidP256KeyErr
  }
  return rec[idx]
}

export const derivePeerId = (
  pubKeyOrJwk: JsonWebKey | string
): Promise<string> => deriveId(pubKeyOrJwk, 5)

export const deriveUserId = (
  pubKeyOrJwk: JsonWebKey | string
): Promise<string> => deriveId(pubKeyOrJwk, 6)

export const isValidUserId = (id: string): boolean =>
  typeof id === 'string' && userIdRegex.test(id)

const verifiedSigPayloads = /*@__PURE__*/ createBoundedCache<
  string,
  Uint8Array
>(8_192)
const inFlightSigVerifies = new Map<
  string,
  [bytes: Uint8Array, promise: Promise<boolean>]
>()

export const verifyWithP256 = (
  sigBytes: Uint8Array,
  payload: Uint8Array,
  pubKeyOrJwk: JsonWebKey | string
): boolean | Promise<boolean> => {
  if (!sigBytes || sigBytes.byteLength !== 64) {
    return false
  }
  const cachedRec = getCachedPubKeyRecord(pubKeyOrJwk)
  if (cachedRec && payload.byteLength <= maxCachedSigPayloadBytes) {
    const cached = verifiedSigPayloads.get(
      `${cachedRec[1]}:${toBase64(sigBytes)}`
    )
    if (cached) {
      return bytesMatch(cached, payload)
    }
  }
  return verifyWithP256Async(sigBytes, payload, pubKeyOrJwk, cachedRec)
}

const verifyWithP256Async = async (
  sigBytes: Uint8Array,
  payload: Uint8Array,
  pubKeyOrJwk: JsonWebKey | string,
  cachedRec?: VerifiedPubKeyRecord
): Promise<boolean> => {
  const rec = cachedRec ?? (await getVerifiedPubKeyRecord(pubKeyOrJwk))
  if (!rec) {
    return false
  }
  if (payload.byteLength > maxCachedSigPayloadBytes) {
    if (!isLowSP256Signature(sigBytes)) {
      return false
    }
    try {
      return await ecdsaVerify(
        rec[3],
        sigBytes as BufferSource,
        payload as BufferSource
      )
    } catch {
      return false
    }
  }

  const cacheKey = `${rec[1]}:${toBase64(sigBytes)}`
  const cached = verifiedSigPayloads.get(cacheKey)
  if (cached) {
    return bytesMatch(cached, payload)
  }
  if (!isLowSP256Signature(sigBytes)) {
    return false
  }
  const inFlight = inFlightSigVerifies.get(cacheKey)
  if (inFlight && bytesMatch(inFlight[0], payload)) {
    return inFlight[1]
  }

  const snapshot = payload.slice()
  const promise = ecdsaVerify(
    rec[3],
    sigBytes as BufferSource,
    snapshot as BufferSource
  )
    .then(
      ok => {
        if (ok) {
          verifiedSigPayloads.set(cacheKey, snapshot)
        }
        return ok
      },
      () => false
    )
    .finally(() => {
      if (inFlightSigVerifies.get(cacheKey)?.[1] === promise) {
        inFlightSigVerifies.delete(cacheKey)
      }
    })

  if (!inFlight) {
    inFlightSigVerifies.set(cacheKey, [snapshot, promise])
  }
  return promise
}

const verifyIdKey = (
  id: string,
  pubKeyOrJwk: JsonWebKey | string,
  idx: 5 | 6
): boolean | Promise<boolean> => {
  const cached = getCachedPubKeyRecord(pubKeyOrJwk)
  return cached
    ? cached[idx] === id
    : getVerifiedPubKeyRecord(pubKeyOrJwk).then(rec =>
        Boolean(rec && rec[idx] === id)
      )
}

export const verifyPeerIdKey = (
  peerId: string,
  pubKeyOrJwk: JsonWebKey | string
): boolean | Promise<boolean> =>
  Boolean(peerId && typeof peerId === 'string') &&
  verifyIdKey(peerId, pubKeyOrJwk, 5)

export const verifyUserIdKey = (
  userId: string,
  pubKeyOrJwk: JsonWebKey | string
): boolean | Promise<boolean> =>
  isValidUserId(userId) && verifyIdKey(userId, pubKeyOrJwk, 6)

export type EndpointIdentity = {
  peerId: string
  signPrivateKey: CryptoKey
  signPublicKey: CryptoKey
  signPubJwk: JsonWebKey
  sign: (payload: Uint8Array) => Promise<Uint8Array>
}

const generateP256KeyMaterial = async (
  extractable: boolean
): Promise<
  [keyPair: CryptoKeyPair, rawJwk: JsonWebKey, rec: VerifiedPubKeyRecord]
> => {
  const keyPair = await crypto.subtle.generateKey(ecdsaKeyAlgo, extractable, [
    'sign',
    'verify'
  ])
  const rawJwk = await crypto.subtle.exportKey(
    'jwk',
    extractable ? keyPair.privateKey : keyPair.publicKey
  )
  const rec = await getVerifiedPubKeyRecord(
    makeP256Jwk(rawJwk.x, rawJwk.y),
    keyPair.publicKey
  )
  if (!rec) {
    throw invalidP256KeyErr
  }
  return [keyPair, rawJwk, rec]
}

const appIdentityEpoch = /*@__PURE__*/ createBoundedCache<string, number>(256)
const appEndpointCache = /*@__PURE__*/ createBoundedCache<
  string,
  Promise<EndpointIdentity>
>()
const ownEndpointCache = /*@__PURE__*/ createBoundedCache<
  string,
  Promise<EndpointIdentity>
>()
const runtimeUserIdentityBySlot = /*@__PURE__*/ createBoundedCache<
  string,
  Promise<UserIdentity>
>()

let nextIdentityClientSeq = 0
export const createIdentityClientId = (): string =>
  `c${++nextIdentityClientSeq}`

const slotForApp = (appId?: string, clientId = ''): string => {
  const normalizedApp = appId || '__default__'
  return `${clientId}\0${appIdentityEpoch.get(normalizedApp) ?? 0}\0${normalizedApp}`
}

export const createEndpointIdentity = (): Promise<EndpointIdentity> => {
  const promise = generateP256KeyMaterial(false).then(([keyPair, , rec]) => ({
    peerId: rec[5],
    signPrivateKey: keyPair.privateKey,
    signPublicKey: keyPair.publicKey,
    signPubJwk: rec[2],
    sign: (payload: Uint8Array) =>
      ecdsaSign(keyPair.privateKey, payload as BufferSource)
  }))
  return promise.then(id => {
    ownEndpointCache.set(id.peerId, promise)
    return id
  })
}

export const getDefaultEndpointIdentity = (
  peerId?: string,
  appId?: string,
  clientId?: string
): Promise<EndpointIdentity> => {
  if (peerId) {
    const own = ownEndpointCache.get(peerId)
    if (own) {
      return own
    }
  }
  const slot = slotForApp(appId, clientId)
  const existing = appEndpointCache.get(slot)
  if (existing) {
    return existing
  }
  const created = createEndpointIdentity()
  appEndpointCache.set(slot, created)
  return created
}

export const resolveSelfId = (
  explicitSelfId?: string,
  appId?: string,
  clientId?: string
): Promise<string> =>
  explicitSelfId
    ? Promise.resolve(explicitSelfId)
    : getDefaultEndpointIdentity(undefined, appId, clientId).then(
        id => id.peerId
      )

const extractableUserKeys = new WeakMap<UserIdentity, string>()

const buildExtractableUserIdentity = (
  privateKey: CryptoKey,
  rec: VerifiedPubKeyRecord,
  secretScalarD: string
): UserIdentity => {
  const cleanJwk = rec[2]
  const userKey =
    userKeyPrefix +
    toBase64Url(
      encodeBytes(
        toJson({
          d: secretScalarD,
          x: cleanJwk.x,
          y: cleanJwk.y
        })
      )
    )
  const identity: UserIdentity = {
    userId: rec[6],
    publicKey: encodePublicKey(cleanJwk),
    signPubJwk: cleanJwk,
    sign: (payload: Uint8Array) =>
      ecdsaSign(privateKey, payload as BufferSource)
  }
  extractableUserKeys.set(identity, userKey)
  return identity
}

export const createUserIdentity = async (): Promise<UserIdentity> => {
  const [keyPair, rawJwk, rec] = await generateP256KeyMaterial(true)
  return buildExtractableUserIdentity(keyPair.privateKey, rec, rawJwk.d ?? '')
}

const generateNonExtractableIdbRecord =
  async (): Promise<StoredIdbIdentityRecord> => {
    const [keyPair, , rec] = await generateP256KeyMaterial(false)
    return {
      userId: rec[6],
      publicKey: encodePublicKey(rec[2]),
      signPubJwk: rec[2],
      privateKey: keyPair.privateKey
    }
  }

const createNonExtractableUserIdentity = (): Promise<UserIdentity> =>
  generateNonExtractableIdbRecord().then(buildUserIdentityFromIdbRecord)

const tryParsePrivateJwk = (
  keyOrJwk: string | JsonWebKey
): [d: string, x: string, y: string] | null => {
  try {
    let jwkObj: {
      crv?: string
      kty?: string
      d?: string
      x?: string
      y?: string
    } | null = null

    if (typeof keyOrJwk === 'string') {
      const trimmed = keyOrJwk.trim()
      if (!trimmed) {
        return null
      }
      jwkObj = trimmed.startsWith(userKeyPrefix)
        ? fromJson(
            decodeBytes(fromBase64Url(trimmed.slice(userKeyPrefix.length)))
          )
        : trimmed.startsWith('{')
          ? fromJson(trimmed)
          : null
    } else if (keyOrJwk && typeof keyOrJwk === 'object') {
      jwkObj = keyOrJwk
    }

    if (
      !jwkObj ||
      typeof jwkObj.d !== 'string' ||
      !jwkObj.d ||
      typeof jwkObj.x !== 'string' ||
      !jwkObj.x ||
      typeof jwkObj.y !== 'string' ||
      !jwkObj.y ||
      (jwkObj.kty && jwkObj.kty !== 'EC') ||
      (jwkObj.crv && jwkObj.crv !== 'P-256')
    ) {
      return null
    }

    const secretKey = fromBase64Url(jwkObj.d)
    const canonicalSecret =
      secretKey.byteLength === 32 &&
      toBase64Url(secretKey) === jwkObj.d &&
      isValidP256PrivateScalar(secretKey)
    secretKey.fill(0)
    return canonicalSecret &&
      pubJwkToUncompressedBytes(makeP256Jwk(jwkObj.x, jwkObj.y))
      ? [jwkObj.d, jwkObj.x, jwkObj.y]
      : null
  } catch {
    return null
  }
}

const importedUserIdentityCache = /*@__PURE__*/ createBoundedCache<
  string,
  Promise<UserIdentity>
>(256)

export const importUserIdentity = async (
  keyOrJwk: string | JsonWebKey
): Promise<UserIdentity> => {
  const parsed = tryParsePrivateJwk(keyOrJwk)
  if (!parsed) {
    throw invalidKeyMaterialErr
  }
  const cacheKey = toHex(await sha256(toJson(parsed)))
  const existing = importedUserIdentityCache.get(cacheKey)
  if (existing) {
    return existing
  }

  const p = (async (): Promise<UserIdentity> => {
    try {
      const [privateKey, rec] = await Promise.all([
        crypto.subtle.importKey(
          'jwk',
          {
            crv: 'P-256',
            d: parsed[0],
            ext: true,
            key_ops: ['sign'],
            kty: 'EC',
            x: parsed[1],
            y: parsed[2]
          },
          ecdsaKeyAlgo,
          true,
          ['sign']
        ),
        getVerifiedPubKeyRecord(makeP256Jwk(parsed[1], parsed[2]))
      ])
      if (
        !rec ||
        !(await ecdsaVerify(
          rec[3],
          (await ecdsaSign(privateKey, keyPairTestPayload)) as BufferSource,
          keyPairTestPayload
        ))
      ) {
        throw invalidKeyMaterialErr
      }
      return buildExtractableUserIdentity(privateKey, rec, parsed[0])
    } catch {
      importedUserIdentityCache.delete(cacheKey)
      throw invalidKeyMaterialErr
    }
  })()

  importedUserIdentityCache.set(cacheKey, p)
  return p
}

export const exportUserIdentity = (identity: UserIdentity): string => {
  const userKey = identity ? extractableUserKeys.get(identity) : undefined
  if (!userKey) {
    throw mkErr('user identity private key is non-extractable')
  }
  return userKey
}

const isUserIdentityObjectStructural = (val: unknown): val is UserIdentity =>
  Boolean(
    val &&
    typeof val === 'object' &&
    typeof (val as UserIdentity).userId === 'string' &&
    isValidUserId((val as UserIdentity).userId) &&
    (val as UserIdentity).signPubJwk &&
    pubJwkToUncompressedBytes((val as UserIdentity).signPubJwk) &&
    typeof (val as UserIdentity).sign === 'function'
  )

const withPersistence = (
  val: UserIdentity,
  persistence: ResolvedIdentityPersistence,
  persisted: boolean
): UserIdentity => ({
  userId: val.userId,
  publicKey: val.publicKey,
  signPubJwk: val.signPubJwk,
  sign:
    persistence === 'custom'
      ? async (payload: Uint8Array) =>
          normalizeLowSP256Signature(new Uint8Array(await val.sign(payload)))
      : val.sign,
  persisted,
  persistence
})

const coerceCustomUserIdentity = async (
  val: unknown
): Promise<UserIdentity> => {
  if (isUserIdentityObjectStructural(val)) {
    if (await verifyUserIdKey(val.userId, val.signPubJwk)) {
      return withPersistence(
        val,
        val.persistence ?? 'custom',
        val.persisted ?? true
      )
    }
    throw userIdMismatchErr
  }
  throw invalidCustomIdentityErr
}

const hasIndexedDB = (): boolean => {
  try {
    return (
      typeof globalThis !== 'undefined' &&
      'indexedDB' in globalThis &&
      Boolean((globalThis as {indexedDB?: IDBFactory}).indexedDB)
    )
  } catch {
    return false
  }
}

export const canPersistLocalIdentity: () => boolean = hasIndexedDB

export const isEphemeralIdentityConfig = (
  identity?: UserIdentityConfig
): boolean =>
  identity === 'none' ||
  ((identity === undefined || identity === 'local') && !hasIndexedDB())

export const validateIdentityConfig = (config?: {identity?: unknown}): void => {
  const raw = config?.identity
  if (
    raw === undefined ||
    raw === 'none' ||
    raw === 'local' ||
    typeof raw === 'function'
  ) {
    return
  }
  if (isUserIdentityObjectStructural(raw)) {
    const cached = getCachedPubKeyRecord(raw.signPubJwk)
    if (cached && cached[6] !== raw.userId) {
      throw userIdMismatchErr
    }
    return
  }
  throw invalidCustomIdentityErr
}

const getOrCreateRuntimeUserIdentity = (
  appId?: string,
  clientId?: string
): Promise<UserIdentity> => {
  const slot = slotForApp(appId, clientId)
  const existing = runtimeUserIdentityBySlot.get(slot)
  if (existing) {
    return existing
  }
  const created = createNonExtractableUserIdentity()
  runtimeUserIdentityBySlot.set(slot, created)
  return created
}

export const getDefaultUserIdentity = (): Promise<UserIdentity> =>
  getOrCreateRuntimeUserIdentity()

const inflightLocalLoadByApp = new Map<string, Promise<UserIdentity>>()
const localOpTailByApp = new Map<string, Promise<unknown>>()

const enqueueLocalOp = <T>(appId: string, fn: () => Promise<T>): Promise<T> => {
  const prev = localOpTailByApp.get(appId)
  const promise = (prev ? prev.catch(noOp).then(fn) : fn()).finally(() => {
    if (localOpTailByApp.get(appId) === promise) {
      localOpTailByApp.delete(appId)
    }
  })
  localOpTailByApp.set(appId, promise)
  return promise
}

const loadOrCreateLocalIdentity = (appId: string): Promise<UserIdentity> => {
  const inflight = inflightLocalLoadByApp.get(appId)
  if (inflight) {
    return inflight
  }
  const promise = enqueueLocalOp(appId, async () =>
    withPersistence(
      await loadOrCreateIdbIdentity(
        appId,
        generateNonExtractableIdbRecord,
        verifyUserIdKey,
        verifyWithP256
      ),
      'local',
      true
    )
  ).finally(() => {
    if (inflightLocalLoadByApp.get(appId) === promise) {
      inflightLocalLoadByApp.delete(appId)
    }
  })
  inflightLocalLoadByApp.set(appId, promise)
  return promise
}

const bumpAppIdentityEpoch = (appId: string): void => {
  const normalizedApp = appId || '__default__'
  appIdentityEpoch.set(
    normalizedApp,
    (appIdentityEpoch.get(normalizedApp) ?? 0) + 1
  )
}

export const clearUserIdentity = async (appId: string): Promise<void> => {
  if (typeof appId !== 'string' || !appId.trim()) {
    throw requiredErr('clearUserIdentity: appId')
  }
  inflightLocalLoadByApp.delete(appId)
  bumpAppIdentityEpoch(appId)

  return enqueueLocalOp(appId, async () => {
    bumpAppIdentityEpoch(appId)
    if (hasIndexedDB()) {
      await deleteIdbIdentity(appId)
    }
  })
}

export const resolveUserIdentity = async (
  appId: string,
  roomId: string,
  config?: {identity?: UserIdentityConfig},
  clientId?: string
): Promise<UserIdentity> => {
  const raw = config?.identity

  if (typeof raw === 'function') {
    return coerceCustomUserIdentity(await raw({appId, roomId}))
  }
  if (raw !== undefined && raw !== 'none' && raw !== 'local') {
    return coerceCustomUserIdentity(raw)
  }

  const mode: UserIdentityPersistence =
    raw === 'none' || raw === 'local' ? raw : hasIndexedDB() ? 'local' : 'none'

  const fallbackToNone = async (
    shouldWarn?: boolean
  ): Promise<UserIdentity> => {
    if (shouldWarn) {
      warn("IndexedDB unavailable; falling back to identity: 'none'")
    }
    return withPersistence(
      await getOrCreateRuntimeUserIdentity(appId, clientId),
      'none',
      false
    )
  }

  if (mode === 'none') {
    return fallbackToNone()
  }
  if (!hasIndexedDB()) {
    return fallbackToNone(true)
  }
  try {
    return await loadOrCreateLocalIdentity(appId)
  } catch {
    return fallbackToNone(true)
  }
}

export const userEndpointProofPayload = (params: {
  appId: string
  roomId: string
  peerId: string
  peerPubJwk: JsonWebKey
  seq?: number
}): Uint8Array =>
  encodeBytes(
    toJson([
      `${libId}-user-proof-v1`,
      params.appId,
      params.roomId,
      params.peerId,
      canonicalizePubJwk(params.peerPubJwk),
      params.seq ?? 0
    ])
  )

export const signUserEndpointProof = async (
  userIdentity: UserIdentity,
  params: {
    appId: string
    roomId: string
    peerId: string
    peerPubJwk: JsonWebKey
    seq?: number
  }
): Promise<string> =>
  toBase64Url(
    normalizeLowSP256Signature(
      new Uint8Array(await userIdentity.sign(userEndpointProofPayload(params)))
    )
  )

export const verifyUserEndpointProof = (params: {
  appId: string
  roomId: string
  peerId: string
  peerPubJwk: JsonWebKey
  userId: string
  userPubJwk: JsonWebKey
  proof: string
  seq?: number
}): boolean | Promise<boolean> => {
  const userPub = params.userPubJwk
  if (!params.proof || typeof params.proof !== 'string' || !userPub) {
    return false
  }
  const peerOk = verifyPeerIdKey(params.peerId, params.peerPubJwk)
  const userOk = verifyUserIdKey(params.userId, userPub)
  if (peerOk === false || userOk === false) {
    return false
  }
  const verifySig = (): boolean | Promise<boolean> => {
    try {
      return verifyWithP256(
        fromBase64Url(params.proof),
        userEndpointProofPayload(params),
        userPub
      )
    } catch {
      return false
    }
  }
  return peerOk === true && userOk === true
    ? verifySig()
    : Promise.all([peerOk, userOk]).then(([p, u]) =>
        p && u ? verifySig() : false
      )
}
