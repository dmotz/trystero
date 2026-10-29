import {
  createBoundedCache,
  createBoundedSet,
  decodeBytes,
  ecdsaKeyAlgo,
  ecdsaSign,
  ecdsaVerify,
  encodeBytes,
  fromBase64Url,
  fromJson,
  isLowSP256Signature,
  libId,
  mkErr,
  normalizeLowSP256Signature,
  p256N,
  sha256,
  toBase64Url,
  toJson
} from './crypto'
import {invalidP256KeyErr, warn} from './utils'
import type {
  ResolvedIdentityPersistence,
  UserIdentity,
  UserIdentityConfig,
  UserIdentityPersistence
} from './types'

export {decodeBytes, encodeBytes, fromBase64Url, toBase64Url}

export const base62Alphabet =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const base62Radix = 62n
export const peerIdLength = 20
export const fingerprintLength = 16
const peerIdRegex = /^[0-9A-Za-z]{20}$/
const userIdRegex = /^[A-Za-z0-9_-]{43}$/

const userKeyPrefix = `${libId}_uk_`
const storagePrefix = `${libId}:user_identity:v1:`
const idbDbName = `${libId}_identity_v1`
const idbStoreName = 'identities'
const invalidKeyMaterialErr = mkErr(
  'invalid user identity key material; expected exported userKey or P-256 JWK'
)
const userIdMismatchErr = mkErr(
  'invalid custom user identity; userId does not match signPubJwk'
)
const invalidCustomIdentityErr = mkErr(
  'invalid custom user identity; use "none", "session", "local", loader, or importUserIdentity()'
)
const idbErr = (op: string): Error => mkErr(`IndexedDB ${op} failed`)
const idbGetErr = idbErr('get')

export const bytesToBigInt = (bytes: Uint8Array): bigint => {
  let res = 0n
  for (const b of bytes) {
    res = (res << 8n) | BigInt(b)
  }
  return res
}

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
    const parsed = fromJson<JsonWebKey>(
      encoded.trim().startsWith('{')
        ? encoded
        : decodeBytes(fromBase64Url(encoded))
    )
    return parsed && parsed.kty === 'EC' && parsed.x && parsed.y ? parsed : null
  } catch {
    return null
  }
}

export const pubJwkToUncompressedBytes = (
  jwk: JsonWebKey
): Uint8Array | null => {
  if (
    !jwk ||
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

export type VerifiedPubKeyRecord = {
  canonicalJwk: string
  cleanJwk: JsonWebKey
  verifyKey: CryptoKey
  digest: Uint8Array
  peerId: string
  userId: string
  fingerprint: string
}

const resolvedPubKeyCache = createBoundedCache<string, VerifiedPubKeyRecord>()
const pendingPubKeyCache = new Map<
  string,
  Promise<VerifiedPubKeyRecord | null>
>()

export const getCachedPubKeyRecord = (
  pubKeyOrJwk: JsonWebKey | string
): VerifiedPubKeyRecord | undefined => {
  const jwk =
    typeof pubKeyOrJwk === 'string' ? decodePublicKey(pubKeyOrJwk) : pubKeyOrJwk
  if (!jwk || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    return undefined
  }
  return resolvedPubKeyCache.get(canonicalizePubJwk(jwk))
}

export const getVerifiedPubKeyRecord = (
  pubKeyOrJwk: JsonWebKey | string,
  preimportedVerifyKey?: CryptoKey
): Promise<VerifiedPubKeyRecord | null> => {
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
      const cleanJwk: JsonWebKey = {
        crv: 'P-256',
        kty: 'EC',
        x: jwk.x!,
        y: jwk.y!
      }
      const record: VerifiedPubKeyRecord = {
        canonicalJwk,
        cleanJwk,
        verifyKey,
        digest,
        peerId: encodeBase62(digest, peerIdLength),
        userId: toBase64Url(digest),
        fingerprint: encodeBase62(digest.subarray(0, 16), fingerprintLength)
      }
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

export const derivePeerId = async (
  pubKeyOrJwk: JsonWebKey | string
): Promise<string> => {
  const rec = await getVerifiedPubKeyRecord(pubKeyOrJwk)
  if (!rec) {
    throw invalidP256KeyErr
  }
  return rec.peerId
}

export const deriveUserId = async (
  pubKeyOrJwk: JsonWebKey | string
): Promise<string> => {
  const rec = await getVerifiedPubKeyRecord(pubKeyOrJwk)
  if (!rec) {
    throw invalidP256KeyErr
  }
  return rec.userId
}

export const isValidPeerId = (id: string): boolean =>
  typeof id === 'string' && peerIdRegex.test(id)

export const isValidUserId = (id: string): boolean =>
  typeof id === 'string' && userIdRegex.test(id)

export const computeUserIdFingerprint = (userId: string): string => {
  const digest = isValidUserId(userId) ? fromBase64Url(userId) : null
  if (!digest || digest.byteLength !== 32) {
    throw mkErr('invalid userId')
  }
  return encodeBase62(digest.subarray(0, 16), fingerprintLength)
}

export const verifyWithP256 = async (
  sigBytes: Uint8Array,
  payload: Uint8Array,
  pubKeyOrJwk: JsonWebKey | string
): Promise<boolean> => {
  if (!sigBytes || !isLowSP256Signature(sigBytes)) {
    return false
  }
  const rec = await getVerifiedPubKeyRecord(pubKeyOrJwk)
  if (!rec) {
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

export type EndpointIdentity = {
  peerId: string
  signPrivateKey: CryptoKey
  signPublicKey: CryptoKey
  signPubJwk: JsonWebKey
  sign: (payload: Uint8Array) => Promise<Uint8Array>
}

export type DevIdentityProvider = {
  getEndpointIdentity: (
    peerId?: string
  ) => Promise<EndpointIdentity> | undefined
  isPeerIdKeyCachedValid: (peerId: string, rec: VerifiedPubKeyRecord) => boolean
  verifyPeerIdKey: (
    peerId: string,
    rec: VerifiedPubKeyRecord
  ) => Promise<boolean> | boolean
  getUserIdentity: (peerId?: string) => Promise<UserIdentity> | undefined
}

let devIdentityProvider: DevIdentityProvider | null = null

export const setDevIdentityProvider = (
  provider: DevIdentityProvider | null
): void => {
  DEV: devIdentityProvider = provider
}

let defaultEndpointIdentityPromise: Promise<EndpointIdentity> | null = null
const appEndpointCache = createBoundedCache<string, Promise<EndpointIdentity>>(
  256
)
const ownEndpointCache = createBoundedCache<string, Promise<EndpointIdentity>>(
  256
)

export const createEndpointIdentity = async (): Promise<EndpointIdentity> => {
  const keyPair = await crypto.subtle.generateKey(ecdsaKeyAlgo, false, [
    'sign',
    'verify'
  ])
  const rawPubJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
  const signPubJwk: JsonWebKey = {
    crv: 'P-256',
    kty: 'EC',
    x: rawPubJwk.x ?? '',
    y: rawPubJwk.y ?? ''
  }
  const rec = await getVerifiedPubKeyRecord(signPubJwk, keyPair.publicKey)
  return {
    peerId: rec!.peerId,
    signPrivateKey: keyPair.privateKey,
    signPublicKey: keyPair.publicKey,
    signPubJwk,
    sign: (payload: Uint8Array) =>
      ecdsaSign(keyPair.privateKey, payload as BufferSource)
  }
}

const rememberOwnEndpoint = (
  promise: Promise<EndpointIdentity>
): Promise<EndpointIdentity> =>
  promise.then(id => {
    ownEndpointCache.set(id.peerId, promise)
    return id
  })

export const getDefaultEndpointIdentity = (
  peerId?: string,
  appId?: string
): Promise<EndpointIdentity> => {
  if (peerId) {
    const own = ownEndpointCache.get(peerId)
    if (own) {
      return own
    }
  }
  DEV: {
    const overridden = devIdentityProvider?.getEndpointIdentity(peerId)
    if (overridden) {
      return overridden
    }
  }
  if (!appId || appId === '__default__') {
    return (defaultEndpointIdentityPromise ??= rememberOwnEndpoint(
      createEndpointIdentity()
    ))
  }
  const existing = appEndpointCache.get(appId)
  if (existing) {
    return existing
  }
  const created = rememberOwnEndpoint(createEndpointIdentity())
  appEndpointCache.set(appId, created)
  return created
}

export const getDefaultSelfId = (): Promise<string> =>
  getDefaultEndpointIdentity().then(id => id.peerId)

export const resolveSelfId = (
  explicitSelfId?: string,
  appId?: string
): Promise<string> =>
  explicitSelfId
    ? Promise.resolve(explicitSelfId)
    : getDefaultEndpointIdentity(undefined, appId).then(id => id.peerId)

export const isPeerIdKeyCachedValid = (
  peerId: string,
  pubKeyOrJwk: JsonWebKey | string
): boolean => {
  if (!peerId || typeof peerId !== 'string') {
    return false
  }
  const rec = getCachedPubKeyRecord(pubKeyOrJwk)
  if (!rec) {
    return false
  }
  if (rec.peerId === peerId) {
    return true
  }
  DEV: if (devIdentityProvider?.isPeerIdKeyCachedValid(peerId, rec)) {
    return true
  }
  return false
}

export const verifyPeerIdKey = async (
  peerId: string,
  pubKeyOrJwk: JsonWebKey | string
): Promise<boolean> => {
  if (isPeerIdKeyCachedValid(peerId, pubKeyOrJwk)) {
    return true
  }
  if (!peerId || typeof peerId !== 'string') {
    return false
  }
  const rec = await getVerifiedPubKeyRecord(pubKeyOrJwk)
  if (!rec) {
    return false
  }
  if (rec.peerId === peerId) {
    return true
  }
  DEV: if (devIdentityProvider) {
    return devIdentityProvider.verifyPeerIdKey(peerId, rec)
  }
  return false
}

export const isUserIdKeyCachedValid = (
  userId: string,
  pubKeyOrJwk: JsonWebKey | string
): boolean => {
  if (!isValidUserId(userId)) {
    return false
  }
  const rec = getCachedPubKeyRecord(pubKeyOrJwk)
  return Boolean(rec && rec.userId === userId)
}

export const verifyUserIdKey = async (
  userId: string,
  pubKeyOrJwk: JsonWebKey | string
): Promise<boolean> => {
  if (isUserIdKeyCachedValid(userId, pubKeyOrJwk)) {
    return true
  }
  if (!isValidUserId(userId)) {
    return false
  }
  const rec = await getVerifiedPubKeyRecord(pubKeyOrJwk)
  return Boolean(rec && rec.userId === userId)
}

const extractableUserKeys = new WeakMap<UserIdentity, string>()

const buildUserIdentityFromKeys = async (
  privateKey: CryptoKey,
  publicKey: CryptoKey | undefined,
  privJwk: {d: string; x: string; y: string}
): Promise<UserIdentity> => {
  const signPubJwk: JsonWebKey = {
    crv: 'P-256',
    kty: 'EC',
    x: privJwk.x,
    y: privJwk.y
  }
  const rec = await getVerifiedPubKeyRecord(signPubJwk, publicKey)
  if (!rec) {
    throw invalidP256KeyErr
  }
  const userId = rec.userId
  const encodedPub = encodePublicKey(signPubJwk)
  const userKey =
    userKeyPrefix +
    toBase64Url(
      encodeBytes(
        toJson({
          d: privJwk.d,
          x: signPubJwk.x,
          y: signPubJwk.y
        })
      )
    )

  const identity: UserIdentity = {
    userId,
    publicKey: encodedPub,
    signPubJwk,
    sign: (payload: Uint8Array) =>
      ecdsaSign(privateKey, payload as BufferSource)
  }
  extractableUserKeys.set(identity, userKey)
  return identity
}

export const createUserIdentity = async (): Promise<UserIdentity> => {
  const keyPair = await crypto.subtle.generateKey(ecdsaKeyAlgo, true, [
    'sign',
    'verify'
  ])
  const privJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey)
  return buildUserIdentityFromKeys(keyPair.privateKey, keyPair.publicKey, {
    d: privJwk.d ?? '',
    x: privJwk.x ?? '',
    y: privJwk.y ?? ''
  })
}

const tryParsePrivateJwk = (
  keyOrJwk: string | JsonWebKey
): {d: string; x: string; y: string} | null => {
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
      if (trimmed.startsWith(userKeyPrefix)) {
        const raw = trimmed.slice(userKeyPrefix.length)
        jwkObj = fromJson(decodeBytes(fromBase64Url(raw)))
      } else if (trimmed.startsWith('{')) {
        jwkObj = fromJson(trimmed)
      } else {
        return null
      }
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
      !jwkObj.y
    ) {
      return null
    }
    if (jwkObj.kty && jwkObj.kty !== 'EC') {
      return null
    }
    if (jwkObj.crv && jwkObj.crv !== 'P-256') {
      return null
    }

    const secretKey = fromBase64Url(jwkObj.d)
    if (secretKey.byteLength !== 32 || toBase64Url(secretKey) !== jwkObj.d) {
      return null
    }
    const scalar = bytesToBigInt(secretKey)
    if (scalar <= 0n || scalar >= p256N) {
      return null
    }

    if (
      !pubJwkToUncompressedBytes({
        crv: 'P-256',
        kty: 'EC',
        x: jwkObj.x,
        y: jwkObj.y
      })
    ) {
      return null
    }

    return {
      d: jwkObj.d,
      x: jwkObj.x,
      y: jwkObj.y
    }
  } catch {
    return null
  }
}

const importedUserIdentityCache = new Map<string, Promise<UserIdentity>>()
const keyPairTestPayload = new Uint8Array([0x74])

export const importUserIdentity = async (
  keyOrJwk: string | JsonWebKey
): Promise<UserIdentity> => {
  const parsed = tryParsePrivateJwk(keyOrJwk)
  if (!parsed) {
    throw invalidKeyMaterialErr
  }
  const cacheKey = `${parsed.d}:${parsed.x}:${parsed.y}`
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
            d: parsed.d,
            ext: true,
            key_ops: ['sign'],
            kty: 'EC',
            x: parsed.x,
            y: parsed.y
          },
          ecdsaKeyAlgo,
          true,
          ['sign']
        ),
        getVerifiedPubKeyRecord({
          crv: 'P-256',
          kty: 'EC',
          x: parsed.x,
          y: parsed.y
        })
      ])
      if (!rec) {
        throw invalidKeyMaterialErr
      }
      const testSig = await ecdsaSign(privateKey, keyPairTestPayload)
      const validPair = await ecdsaVerify(
        rec.verifyKey,
        testSig as BufferSource,
        keyPairTestPayload
      )
      if (!validPair) {
        throw invalidKeyMaterialErr
      }
      return buildUserIdentityFromKeys(privateKey, rec.verifyKey, parsed)
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
  sign: async (payload: Uint8Array) =>
    normalizeLowSP256Signature(new Uint8Array(await val.sign(payload))),
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

const getSessionStorage = (): Storage | null => {
  try {
    const storage =
      typeof globalThis !== 'undefined' && 'sessionStorage' in globalThis
        ? (globalThis as {sessionStorage?: Storage}).sessionStorage
        : undefined
    return storage && typeof storage.getItem === 'function' ? storage : null
  } catch {
    return null
  }
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

export const validateIdentityConfig = (config?: {identity?: unknown}): void => {
  const raw = config?.identity
  if (
    raw === undefined ||
    raw === 'none' ||
    raw === 'session' ||
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

let defaultUserIdentityPromise: Promise<UserIdentity> | null = null

export const getDefaultUserIdentity = (): Promise<UserIdentity> =>
  (defaultUserIdentityPromise ??= createUserIdentity())

const runtimeUserIdentityByScope = new Map<string, Promise<UserIdentity>>()
const sessionMutexByApp = new Map<string, Promise<UserIdentity>>()
const localMutexByApp = new Map<string, Promise<UserIdentity>>()

const getOrCreateRuntimeUserIdentity = (
  appId?: string
): Promise<UserIdentity> => {
  const scopeKey = appId || '__default__'
  if (scopeKey === '__default__') {
    return getDefaultUserIdentity()
  }
  let cached = runtimeUserIdentityByScope.get(scopeKey)
  if (!cached) {
    cached = createUserIdentity()
    runtimeUserIdentityByScope.set(scopeKey, cached)
  }
  return cached
}

type StoredIdbIdentityRecord = {
  userId: string
  publicKey: string
  signPubJwk: JsonWebKey
  privateKey: CryptoKey
}

const buildUserIdentityFromIdbRecord = (
  rec: StoredIdbIdentityRecord
): UserIdentity => ({
  userId: rec.userId,
  publicKey: rec.publicKey,
  signPubJwk: rec.signPubJwk,
  sign: (payload: Uint8Array) =>
    ecdsaSign(rec.privateKey, payload as BufferSource)
})

const generateNonExtractableIdbRecord =
  async (): Promise<StoredIdbIdentityRecord> => {
    const keyPair = await crypto.subtle.generateKey(ecdsaKeyAlgo, false, [
      'sign',
      'verify'
    ])
    const rawPubJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
    const signPubJwk: JsonWebKey = {
      crv: 'P-256',
      kty: 'EC',
      x: rawPubJwk.x ?? '',
      y: rawPubJwk.y ?? ''
    }
    const rec = await getVerifiedPubKeyRecord(signPubJwk, keyPair.publicKey)
    return {
      userId: rec!.userId,
      publicKey: encodePublicKey(signPubJwk),
      signPubJwk,
      privateKey: keyPair.privateKey
    }
  }

const generateRandomTabToken = (): string => {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  let token = ''
  for (const b of bytes) {
    token += base62Alphabet[b % 62]!
  }
  return token
}

const openIdentityDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open(idbDbName, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(idbStoreName)) {
        db.createObjectStore(idbStoreName)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? idbErr('open'))
  })

const idbGetRecord = (
  db: IDBDatabase,
  appId: string
): Promise<StoredIdbIdentityRecord | undefined> =>
  new Promise((resolve, reject) => {
    const tx = db.transaction(idbStoreName, 'readonly')
    const store = tx.objectStore(idbStoreName)
    const req = store.get(appId)
    req.onsuccess = () =>
      resolve(req.result as StoredIdbIdentityRecord | undefined)
    req.onerror = () => reject(req.error ?? idbGetErr)
  })

const idbProbeBytes = encodeBytes(`${libId}:idb-key-probe:v1`)

const isValidStoredIdbRecord = async (
  rec: StoredIdbIdentityRecord | undefined
): Promise<boolean> => {
  if (
    !rec ||
    typeof rec !== 'object' ||
    !rec.userId ||
    !rec.signPubJwk ||
    !rec.privateKey
  ) {
    return false
  }
  if (!(await verifyUserIdKey(rec.userId, rec.signPubJwk))) {
    return false
  }
  try {
    const sig = await ecdsaSign(rec.privateKey, idbProbeBytes as BufferSource)
    return await verifyWithP256(sig, idbProbeBytes, rec.signPubJwk)
  } catch {
    return false
  }
}

const idbPutRecord = (
  db: IDBDatabase,
  appId: string,
  candidate: StoredIdbIdentityRecord
): Promise<StoredIdbIdentityRecord> =>
  new Promise((resolve, reject) => {
    const tx = db.transaction(idbStoreName, 'readwrite')
    const store = tx.objectStore(idbStoreName) as IDBObjectStore & {
      put?: (value: unknown, key?: IDBValidKey) => IDBRequest
      delete?: (key: IDBValidKey) => IDBRequest
    }
    if (typeof store.put === 'function') {
      const putReq = store.put(candidate, appId)
      putReq.onsuccess = () => resolve(candidate)
      putReq.onerror = () => reject(putReq.error ?? idbErr('put'))
      return
    }
    if (typeof store.delete === 'function') {
      const delReq = store.delete(appId)
      delReq.onsuccess = () => {
        const addReq = store.add(candidate, appId)
        addReq.onsuccess = () => resolve(candidate)
        addReq.onerror = () => reject(addReq.error ?? idbErr('add'))
      }
      delReq.onerror = () => reject(delReq.error ?? idbErr('delete'))
      return
    }
    reject(idbErr('put'))
  })

const idbAddOrGetRecord = (
  db: IDBDatabase,
  appId: string,
  candidate: StoredIdbIdentityRecord
): Promise<StoredIdbIdentityRecord> =>
  new Promise((resolve, reject) => {
    const tx = db.transaction(idbStoreName, 'readwrite')
    const store = tx.objectStore(idbStoreName)
    const getReq = store.get(appId)
    getReq.onsuccess = () => {
      const existing = getReq.result as StoredIdbIdentityRecord | undefined
      if (existing !== undefined) {
        isValidStoredIdbRecord(existing).then(valid => {
          if (valid) {
            resolve(existing)
          } else {
            idbPutRecord(db, appId, candidate).then(resolve, reject)
          }
        }, reject)
        return
      }
      const addReq = store.add(candidate, appId)
      addReq.onsuccess = () => resolve(candidate)
      addReq.onerror = event => {
        event?.preventDefault?.()
        // ConstraintError from concurrent tab: read winner in a fresh readonly tx
        idbGetRecord(db, appId).then(winner => {
          if (!winner) {
            reject(addReq.error ?? idbErr('add'))
            return
          }
          isValidStoredIdbRecord(winner).then(valid => {
            if (valid) {
              resolve(winner)
            } else {
              idbPutRecord(db, appId, candidate).then(resolve, reject)
            }
          }, reject)
        }, reject)
      }
    }
    getReq.onerror = () => reject(getReq.error ?? idbGetErr)
  })

const withNavigatorLock = async <T>(
  lockName: string,
  fn: () => Promise<T>
): Promise<T> => {
  const nav =
    typeof navigator !== 'undefined'
      ? (navigator as {
          locks?: {
            request?: <R>(name: string, cb: () => Promise<R>) => Promise<R>
          }
        })
      : undefined
  if (nav?.locks && typeof nav.locks.request === 'function') {
    return nav.locks.request(lockName, fn)
  }
  return fn()
}

const loadOrCreateIdbIdentity = (
  idbKey: string,
  persistence: 'local' | 'session'
): Promise<UserIdentity> =>
  withNavigatorLock(`${storagePrefix}${idbKey}`, async () => {
    const db = await openIdentityDb()
    try {
      const existing = await idbGetRecord(db, idbKey)
      if (existing !== undefined) {
        if (await isValidStoredIdbRecord(existing)) {
          return withPersistence(
            buildUserIdentityFromIdbRecord(existing),
            persistence,
            true
          )
        }
        const repaired = await generateNonExtractableIdbRecord()
        const saved = await idbPutRecord(db, idbKey, repaired)
        return withPersistence(
          buildUserIdentityFromIdbRecord(saved),
          persistence,
          true
        )
      }

      const candidate = await generateNonExtractableIdbRecord()
      const committed = await idbAddOrGetRecord(db, idbKey, candidate)
      return withPersistence(
        buildUserIdentityFromIdbRecord(committed),
        persistence,
        true
      )
    } finally {
      db.close()
    }
  })

const loadOrCreateSessionIdentity = (
  sessionStore: Storage,
  appId: string
): Promise<UserIdentity> => {
  const inflight = sessionMutexByApp.get(appId)
  if (inflight) {
    return inflight
  }

  const tokenKey = `${storagePrefix}session:${appId}`
  const promise = (async (): Promise<UserIdentity> => {
    let tabToken = sessionStore.getItem(tokenKey)
    if (!tabToken || !/^[0-9A-Za-z]{16,64}$/.test(tabToken)) {
      const generated = generateRandomTabToken()
      sessionStore.setItem(tokenKey, generated)
      const verified = sessionStore.getItem(tokenKey)
      tabToken =
        verified && /^[0-9A-Za-z]{16,64}$/.test(verified) ? verified : generated
    }

    return loadOrCreateIdbIdentity(`session:${appId}:${tabToken}`, 'session')
  })().finally(() => {
    sessionMutexByApp.delete(appId)
  })

  sessionMutexByApp.set(appId, promise)
  return promise
}

const loadOrCreateLocalIdentity = (appId: string): Promise<UserIdentity> => {
  const inflight = localMutexByApp.get(appId)
  if (inflight) {
    return inflight
  }

  const promise = loadOrCreateIdbIdentity(appId, 'local').finally(() => {
    localMutexByApp.delete(appId)
  })

  localMutexByApp.set(appId, promise)
  return promise
}

export const canPersistLocalIdentity: () => boolean = hasIndexedDB

export const resolveUserIdentity = async (
  appId: string,
  roomId: string,
  config?: {
    identity?: UserIdentityConfig
    preferLocal?: boolean
  },
  peerId?: string
): Promise<UserIdentity> => {
  const raw = config?.identity

  if (typeof raw === 'function') {
    const loaded = await raw({appId, roomId})
    return coerceCustomUserIdentity(loaded)
  }

  if (
    raw !== undefined &&
    raw !== 'none' &&
    raw !== 'session' &&
    raw !== 'local'
  ) {
    return coerceCustomUserIdentity(raw)
  }

  const defaultMode: UserIdentityPersistence = !canPersistLocalIdentity()
    ? 'none'
    : config?.preferLocal
      ? 'local'
      : getSessionStorage()
        ? 'session'
        : 'none'

  const mode: UserIdentityPersistence =
    (raw as UserIdentityPersistence | undefined) ?? defaultMode

  let devUserOverride: Promise<UserIdentity> | undefined
  DEV: if (!peerId || !ownEndpointCache.has(peerId)) {
    devUserOverride = devIdentityProvider?.getUserIdentity(peerId)
  }

  const fallbackToNone = async (
    shouldWarn?: boolean
  ): Promise<UserIdentity> => {
    if (shouldWarn) {
      warn("IndexedDB unavailable; falling back to identity: 'none'")
    }
    DEV: if (devUserOverride) {
      return withPersistence(await devUserOverride, 'none', false)
    }
    return withPersistence(
      await getOrCreateRuntimeUserIdentity(appId),
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

  if (mode === 'session') {
    const sessionStore = getSessionStorage()
    if (!sessionStore) {
      return fallbackToNone(true)
    }
    try {
      return await loadOrCreateSessionIdentity(sessionStore, appId)
    } catch {
      return fallbackToNone(true)
    }
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

const verifiedUserProofCache = createBoundedSet<string>()

export const signUserEndpointProof = async (
  userIdentity: UserIdentity,
  params: {
    appId: string
    roomId: string
    peerId: string
    peerPubJwk: JsonWebKey
    seq?: number
  }
): Promise<string> => {
  const payload = userEndpointProofPayload(params)
  const sigBytes = normalizeLowSP256Signature(
    new Uint8Array(await userIdentity.sign(payload))
  )
  const proof = toBase64Url(sigBytes)
  const cacheKey = `${params.appId}:${params.roomId}:${params.peerId}:${canonicalizePubJwk(params.peerPubJwk)}:${userIdentity.userId}:${params.seq ?? 0}:${proof}`
  verifiedUserProofCache.add(cacheKey)
  return proof
}

export const isUserEndpointProofCachedValid = (params: {
  appId: string
  roomId: string
  peerId: string
  peerPubJwk: JsonWebKey
  userId: string
  userPubJwk: JsonWebKey
  proof: string
  seq?: number
}): boolean => {
  if (
    !params.proof ||
    typeof params.proof !== 'string' ||
    !params.userPubJwk ||
    !isPeerIdKeyCachedValid(params.peerId, params.peerPubJwk) ||
    !isUserIdKeyCachedValid(params.userId, params.userPubJwk)
  ) {
    return false
  }
  const cacheKey = `${params.appId}:${params.roomId}:${params.peerId}:${canonicalizePubJwk(params.peerPubJwk)}:${params.userId}:${params.seq ?? 0}:${params.proof}`
  return verifiedUserProofCache.has(cacheKey)
}

export const verifyUserEndpointProof = async (params: {
  appId: string
  roomId: string
  peerId: string
  peerPubJwk: JsonWebKey
  userId: string
  userPubJwk: JsonWebKey
  proof: string
  seq?: number
}): Promise<boolean> => {
  if (isUserEndpointProofCachedValid(params)) {
    return true
  }
  const userPub = params.userPubJwk
  if (
    !params.proof ||
    typeof params.proof !== 'string' ||
    !userPub ||
    !(await verifyPeerIdKey(params.peerId, params.peerPubJwk)) ||
    !(await verifyUserIdKey(params.userId, userPub))
  ) {
    return false
  }
  const cacheKey = `${params.appId}:${params.roomId}:${params.peerId}:${canonicalizePubJwk(params.peerPubJwk)}:${params.userId}:${params.seq ?? 0}:${params.proof}`
  if (verifiedUserProofCache.has(cacheKey)) {
    return true
  }
  try {
    const sigBytes = fromBase64Url(params.proof)
    const payload = userEndpointProofPayload(params)
    const ok = await verifyWithP256(sigBytes, payload, userPub)
    if (ok) {
      verifiedUserProofCache.add(cacheKey)
    }
    return ok
  } catch {
    return false
  }
}

export const extractDtlsFingerprints = (sdp?: string | null): string[] => {
  if (!sdp || typeof sdp !== 'string') {
    return []
  }
  const matches = sdp.matchAll(/^a=fingerprint:([^\r\n]+)$/gm)
  const set = new Set<string>()
  for (const m of matches) {
    const val = m[1]?.trim().toLowerCase()
    if (val) {
      set.add(val)
    }
  }
  return [...set].sort()
}
