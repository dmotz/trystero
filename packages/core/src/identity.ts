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
  buildUserIdentityFromIdbRecord,
  deleteIdbIdentity,
  loadOrCreateIdbIdentity,
  type StoredIdbIdentityRecord
} from './identity-idb'
import type {
  ResolvedIdentityPersistence,
  UserIdentityPersistence
} from './internal-types'
import {
  base62Alphabet,
  bytesMatch,
  bytesToBigInt,
  createBoundedCache,
  decodeBytes,
  domainTag,
  encodeBytes,
  fromBase64Url,
  fromJson,
  libId,
  mkErr,
  peerIdLength,
  toBase64Url,
  toJson,
  userIdLength
} from './primitives'
import type {UserIdentity, UserIdentityConfig} from './types'
import {invalidP256KeyErr, noOp, requiredErr, userIdRegex, warn} from './utils'

const base62Radix = 62n
const userKeyPrefix = `${libId}_uk_`
const maxCachedSigPayloadBytes = 4_096
const maxSigCacheTotalBytes = 2 * 1024 * 1024
const maxSigCacheEntries = 8_192
const keyPairTestPayload = /*@__PURE__*/ encodeBytes(
  domainTag('identity-self-test', 1)
)

const invalidKeyMaterialErr = /*@__PURE__*/ mkErr(
  'invalid user identity key material; expected exported userKey or P-256 JWK'
)
const userIdMismatchErr = /*@__PURE__*/ mkErr(
  'invalid custom user identity; userId does not match signPubJwk'
)
const invalidCustomIdentityErr = /*@__PURE__*/ mkErr(
  'invalid custom user identity; use "local", "none", loader, or importUserIdentity()'
)
const invalidCustomSignatureErr = /*@__PURE__*/ mkErr(
  'invalid custom user identity signature; sign() must return a valid 64-byte IEEE P1363 ECDSA P-256 SHA-256 signature'
)

const encodeBase62 = (bytes: Uint8Array, length: number): string => {
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
  pubKeyOrJwk: JsonWebKey | string
): Uint8Array | null => {
  let x: string | undefined
  let y: string | undefined
  if (typeof pubKeyOrJwk === 'string') {
    if (pubKeyOrJwk.length !== 87 || pubKeyOrJwk[43] !== '.') {
      return null
    }
    x = pubKeyOrJwk.slice(0, 43)
    y = pubKeyOrJwk.slice(44)
  } else {
    if (
      !pubKeyOrJwk ||
      typeof pubKeyOrJwk !== 'object' ||
      pubKeyOrJwk.d !== undefined ||
      (pubKeyOrJwk.kty && pubKeyOrJwk.kty !== 'EC') ||
      (pubKeyOrJwk.crv && pubKeyOrJwk.crv !== 'P-256') ||
      typeof pubKeyOrJwk.x !== 'string' ||
      typeof pubKeyOrJwk.y !== 'string' ||
      !pubKeyOrJwk.x ||
      !pubKeyOrJwk.y
    ) {
      return null
    }
    x = pubKeyOrJwk.x
    y = pubKeyOrJwk.y
  }
  try {
    const xBytes = fromBase64Url(x)
    const yBytes = fromBase64Url(y)
    if (
      xBytes.byteLength !== 32 ||
      yBytes.byteLength !== 32 ||
      toBase64Url(xBytes) !== x ||
      toBase64Url(yBytes) !== y
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

export const toCompactPub = (
  pubKeyOrJwk: JsonWebKey | string
): string | null => {
  if (typeof pubKeyOrJwk === 'object' && pubKeyOrJwk !== null) {
    const byRef = cleanJwkRecordCache.get(pubKeyOrJwk)
    if (byRef) {
      return byRef.compactPub
    }
  }
  if (!pubJwkToUncompressedBytes(pubKeyOrJwk)) {
    return null
  }
  return typeof pubKeyOrJwk === 'string'
    ? pubKeyOrJwk
    : `${pubKeyOrJwk.x!}.${pubKeyOrJwk.y!}`
}

export const jwkToCompactPub = (pubKeyOrJwk: JsonWebKey | string): string => {
  const compact = toCompactPub(pubKeyOrJwk)
  if (!compact) {
    throw invalidP256KeyErr
  }
  return compact
}

export const compactPubToJwk = (pub: string): JsonWebKey | null =>
  typeof pub === 'string' && pubJwkToUncompressedBytes(pub)
    ? makeP256Jwk(pub.slice(0, 43), pub.slice(44))
    : null

export type VerifiedPubKeyRecord = {
  readonly compactPub: string
  readonly cleanJwk: JsonWebKey
  readonly verifyKey: CryptoKey
  readonly peerId: string
  readonly userId: string
}

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

const getCachedPubKeyRecord = (
  pubKeyOrJwk: JsonWebKey | string
): VerifiedPubKeyRecord | undefined => {
  if (typeof pubKeyOrJwk === 'object' && pubKeyOrJwk !== null) {
    const byRef = cleanJwkRecordCache.get(pubKeyOrJwk)
    if (byRef) {
      return byRef
    }
  }
  const compactPub = toCompactPub(pubKeyOrJwk)
  return compactPub ? resolvedPubKeyCache.get(compactPub) : undefined
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
  const uncompressed = pubJwkToUncompressedBytes(pubKeyOrJwk)
  if (!uncompressed) {
    return Promise.resolve(null)
  }
  const x =
    typeof pubKeyOrJwk === 'string' ? pubKeyOrJwk.slice(0, 43) : pubKeyOrJwk.x!
  const y =
    typeof pubKeyOrJwk === 'string' ? pubKeyOrJwk.slice(44) : pubKeyOrJwk.y!
  const compactPub = `${x}.${y}`
  const existing = resolvedPubKeyCache.get(compactPub)
  if (existing) {
    return Promise.resolve(existing)
  }
  const inflight = pendingPubKeyCache.get(compactPub)
  if (inflight) {
    return inflight
  }

  const p = (async (): Promise<VerifiedPubKeyRecord | null> => {
    try {
      const [verifyKey, peerDigest, userDigest] = await Promise.all([
        preimportedVerifyKey
          ? Promise.resolve(preimportedVerifyKey)
          : crypto.subtle.importKey(
              'raw',
              uncompressed as BufferSource,
              ecdsaKeyAlgo,
              false,
              ['verify']
            ),
        sha256(`${domainTag('pid', 1)}:${compactPub}`),
        sha256(`${domainTag('uid', 1)}:${compactPub}`)
      ])
      const cleanJwk = Object.freeze(makeP256Jwk(x, y))
      const record: VerifiedPubKeyRecord = {
        compactPub,
        cleanJwk,
        verifyKey,
        peerId: encodeBase62(peerDigest, peerIdLength),
        userId: encodeBase62(userDigest, userIdLength)
      }
      cleanJwkRecordCache.set(cleanJwk, record)
      resolvedPubKeyCache.set(compactPub, record)
      return record
    } catch {
      return null
    } finally {
      pendingPubKeyCache.delete(compactPub)
    }
  })()

  pendingPubKeyCache.set(compactPub, p)
  return p
}

const deriveId = async (
  pubKeyOrJwk: JsonWebKey | string,
  field: 'peerId' | 'userId'
): Promise<string> => {
  const rec = await getVerifiedPubKeyRecord(pubKeyOrJwk)
  if (!rec) {
    throw invalidP256KeyErr
  }
  return rec[field]
}

export const derivePeerId = (
  pubKeyOrJwk: JsonWebKey | string
): Promise<string> => deriveId(pubKeyOrJwk, 'peerId')

export const deriveUserId = (
  pubKeyOrJwk: JsonWebKey | string
): Promise<string> => deriveId(pubKeyOrJwk, 'userId')

export const isValidUserId = (id: string): boolean =>
  typeof id === 'string' && userIdRegex.test(id)

const createByteBoundedPayloadCache = () => {
  const map = new Map<string, Uint8Array>()
  let totalBytes = 0
  return {
    get: (key: string): Uint8Array | undefined => {
      const val = map.get(key)
      if (val !== undefined) {
        map.delete(key)
        map.set(key, val)
      }
      return val
    },
    set: (key: string, val: Uint8Array): void => {
      const prev = map.get(key)
      if (prev !== undefined) {
        totalBytes -= prev.byteLength
        map.delete(key)
      }
      while (
        map.size >= maxSigCacheEntries ||
        (map.size > 0 && totalBytes + val.byteLength > maxSigCacheTotalBytes)
      ) {
        const oldestKey = map.keys().next().value
        if (oldestKey === undefined) {
          break
        }
        const oldestVal = map.get(oldestKey)
        if (oldestVal) {
          totalBytes -= oldestVal.byteLength
        }
        map.delete(oldestKey)
      }
      map.set(key, val)
      totalBytes += val.byteLength
    }
  }
}

const verifiedSigPayloads = /*@__PURE__*/ createByteBoundedPayloadCache()
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
      `${cachedRec.compactPub}:${toBase64Url(sigBytes)}`
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
        rec.verifyKey,
        sigBytes as BufferSource,
        payload as BufferSource
      )
    } catch {
      return false
    }
  }

  const cacheKey = `${rec.compactPub}:${toBase64Url(sigBytes)}`
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
    rec.verifyKey,
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
  field: 'peerId' | 'userId'
): boolean | Promise<boolean> => {
  const cached = getCachedPubKeyRecord(pubKeyOrJwk)
  return cached
    ? cached[field] === id
    : getVerifiedPubKeyRecord(pubKeyOrJwk).then(rec =>
        Boolean(rec && rec[field] === id)
      )
}

export const verifyPeerIdKey = (
  peerId: string,
  pubKeyOrJwk: JsonWebKey | string
): boolean | Promise<boolean> =>
  Boolean(peerId && typeof peerId === 'string') &&
  verifyIdKey(peerId, pubKeyOrJwk, 'peerId')

export const verifyUserIdKey = (
  userId: string,
  pubKeyOrJwk: JsonWebKey | string
): boolean | Promise<boolean> =>
  isValidUserId(userId) && verifyIdKey(userId, pubKeyOrJwk, 'userId')

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

const appIdentityEpoch = new Map<string, number>()
const appEndpointCache = /*@__PURE__*/ createBoundedCache<
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

export const createEndpointIdentity = (): Promise<EndpointIdentity> =>
  generateP256KeyMaterial(false).then(([keyPair, , rec]) => ({
    peerId: rec.peerId,
    signPrivateKey: keyPair.privateKey,
    signPublicKey: keyPair.publicKey,
    signPubJwk: rec.cleanJwk,
    sign: (payload: Uint8Array) =>
      ecdsaSign(keyPair.privateKey, payload as BufferSource)
  }))

export const getDefaultEndpointIdentity = (
  appId?: string,
  clientId?: string
): Promise<EndpointIdentity> => {
  const slot = slotForApp(appId, clientId)
  const existing = appEndpointCache.get(slot)
  if (existing) {
    return existing
  }
  const created = createEndpointIdentity()
  created.catch(() => {
    if (appEndpointCache.get(slot) === created) {
      appEndpointCache.delete(slot)
    }
  })
  appEndpointCache.set(slot, created)
  return created
}

const extractableUserKeys = new WeakMap<UserIdentity, string>()
const trustedUserIdentities = new WeakSet<UserIdentity>()

const buildExtractableUserIdentity = (
  privateKey: CryptoKey,
  rec: VerifiedPubKeyRecord,
  secretScalarD: string
): UserIdentity => {
  const {cleanJwk} = rec
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
    userId: rec.userId,
    signPubJwk: cleanJwk,
    sign: (payload: Uint8Array) =>
      ecdsaSign(privateKey, payload as BufferSource)
  }
  extractableUserKeys.set(identity, userKey)
  trustedUserIdentities.add(identity)
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
      userId: rec.userId,
      signPubJwk: rec.cleanJwk,
      privateKey: keyPair.privateKey
    }
  }

const createNonExtractableUserIdentity = (): Promise<UserIdentity> =>
  generateNonExtractableIdbRecord().then(rec => {
    const id = buildUserIdentityFromIdbRecord(rec)
    trustedUserIdentities.add(id)
    return id
  })

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

export const importUserIdentity = async (
  keyOrJwk: string | JsonWebKey
): Promise<UserIdentity> => {
  const parsed = tryParsePrivateJwk(keyOrJwk)
  if (!parsed) {
    throw invalidKeyMaterialErr
  }
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
        rec.verifyKey,
        (await ecdsaSign(
          privateKey,
          keyPairTestPayload as BufferSource
        )) as BufferSource,
        keyPairTestPayload as BufferSource
      ))
    ) {
      throw invalidKeyMaterialErr
    }
    return buildExtractableUserIdentity(privateKey, rec, parsed[0])
  } catch {
    throw invalidKeyMaterialErr
  }
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
  cleanJwk: JsonWebKey = val.signPubJwk
): UserIdentity => {
  const isKnownTrusted = trustedUserIdentities.has(val)
  const wrapped: UserIdentity = {
    userId: val.userId,
    signPubJwk: cleanJwk,
    sign: isKnownTrusted
      ? val.sign
      : async (payload: Uint8Array) =>
          normalizeLowSP256Signature(new Uint8Array(await val.sign(payload))),
    persistence
  }
  const userKey = extractableUserKeys.get(val)
  if (userKey !== undefined) {
    extractableUserKeys.set(wrapped, userKey)
  }
  if (isKnownTrusted) {
    trustedUserIdentities.add(wrapped)
  }
  return wrapped
}

const coerceCustomUserIdentity = async (
  val: unknown
): Promise<UserIdentity> => {
  if (!isUserIdentityObjectStructural(val)) {
    throw invalidCustomIdentityErr
  }
  const rec = await getVerifiedPubKeyRecord(val.signPubJwk)
  if (!rec || rec.userId !== val.userId) {
    throw userIdMismatchErr
  }
  if (!trustedUserIdentities.has(val)) {
    let rawSig: Uint8Array
    try {
      rawSig = new Uint8Array(await val.sign(keyPairTestPayload.slice()))
    } catch (cause) {
      throw mkErr(
        `custom user identity sign() failed startup check: ${cause instanceof Error ? cause.message : String(cause)}`
      )
    }
    const normalizedSig = normalizeLowSP256Signature(rawSig)
    if (
      normalizedSig.byteLength !== 64 ||
      !(await ecdsaVerify(
        rec.verifyKey,
        normalizedSig as BufferSource,
        keyPairTestPayload as BufferSource
      ))
    ) {
      throw invalidCustomSignatureErr
    }
  }
  return withPersistence(val, val.persistence ?? 'custom', rec.cleanJwk)
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
    if (cached && cached.userId !== raw.userId) {
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
  created.catch(() => {
    if (runtimeUserIdentityBySlot.get(slot) === created) {
      runtimeUserIdentityBySlot.delete(slot)
    }
  })
  runtimeUserIdentityBySlot.set(slot, created)
  return created
}

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
  const promise = enqueueLocalOp(appId, async () => {
    const id = await loadOrCreateIdbIdentity(
      appId,
      generateNonExtractableIdbRecord,
      verifyUserIdKey,
      verifyWithP256
    )
    trustedUserIdentities.add(id)
    return withPersistence(id, 'local')
  }).finally(() => {
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
      'none'
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
  peerPubJwk: JsonWebKey | string
  seq?: number
}): Uint8Array =>
  encodeBytes(
    toJson([
      domainTag('user-proof', 3),
      params.appId,
      params.roomId,
      params.peerId,
      jwkToCompactPub(params.peerPubJwk),
      params.seq ?? 0
    ])
  )

export const signUserEndpointProof = async (
  userIdentity: UserIdentity,
  params: {
    appId: string
    roomId: string
    peerId: string
    peerPubJwk: JsonWebKey | string
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
  peerPubJwk: JsonWebKey | string
  userId: string
  userPubJwk: JsonWebKey | string
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
