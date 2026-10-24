import {p256} from '@noble/curves/nist.js'
import {sha256} from '@noble/hashes/sha2.js'
import type {
  UserIdentity,
  UserIdentityConfig,
  UserIdentityPersistence
} from './types'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const encodeBytes = (txt: string): Uint8Array => encoder.encode(txt)
const decodeBytes = (buf: ArrayBufferLike | ArrayBufferView): string =>
  decoder.decode(buf)

const mkIdentityErr = (msg: string): Error => new Error(`Trystero: ${msg}`)

const p256N =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n

export const base62Alphabet =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const base62Radix = 62n
export const peerIdLength = 20
const peerIdRegex = /^[0-9A-Za-z]{20}$/
const userIdRegex = /^[A-Za-z0-9_-]{43}$/

export const userKeyPrefix = 'trystero_uk_'
const storagePrefix = 'trystero:user_identity:v1:'
const idbDbName = 'trystero_identity_v1'
const idbStoreName = 'identities'

export const bigintTo32Bytes = (n: bigint): Uint8Array => {
  const hex = n.toString(16).padStart(64, '0')
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

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

export const canonicalizePubJwk = (jwk: JsonWebKey): string =>
  JSON.stringify({
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
      const parsed = JSON.parse(encoded) as JsonWebKey
      return parsed && parsed.kty === 'EC' && parsed.x && parsed.y
        ? parsed
        : null
    }
    const parsed = JSON.parse(decodeBytes(fromBase64Url(encoded))) as JsonWebKey
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
    if (xBytes.byteLength !== 32 || yBytes.byteLength !== 32) {
      return null
    }
    const uncompressed = new Uint8Array(65)
    uncompressed[0] = 0x04
    uncompressed.set(xBytes, 1)
    uncompressed.set(yBytes, 33)
    p256.Point.fromBytes(uncompressed)
    return uncompressed
  } catch {
    return null
  }
}

export const uncompressedBytesToPubJwk = (
  uncompressed: Uint8Array
): JsonWebKey => ({
  crv: 'P-256',
  kty: 'EC',
  x: toBase64Url(uncompressed.subarray(1, 33)),
  y: toBase64Url(uncompressed.subarray(33, 65))
})

const hashPublicKeyJwk = (
  pubKeyOrJwk: JsonWebKey | string,
  label: string
): Uint8Array => {
  const jwk =
    typeof pubKeyOrJwk === 'string' ? decodePublicKey(pubKeyOrJwk) : pubKeyOrJwk
  if (!jwk || !pubJwkToUncompressedBytes(jwk)) {
    throw mkIdentityErr(
      `invalid ECDSA P-256 public key for ${label} derivation`
    )
  }
  return sha256(encodeBytes(canonicalizePubJwk(jwk)))
}

export const derivePeerIdSync = (pubKeyOrJwk: JsonWebKey | string): string =>
  encodeBase62(hashPublicKeyJwk(pubKeyOrJwk, 'peerId'), peerIdLength)

export const derivePeerId = derivePeerIdSync

export const deriveUserIdSync = (pubKeyOrJwk: JsonWebKey | string): string =>
  toBase64Url(hashPublicKeyJwk(pubKeyOrJwk, 'userId'))

export const deriveUserId = deriveUserIdSync

export const isValidPeerId = (id: string): boolean =>
  typeof id === 'string' && peerIdRegex.test(id)

export const isValidUserId = (id: string): boolean =>
  typeof id === 'string' && userIdRegex.test(id)

export const signWithP256Sync = (
  payload: Uint8Array,
  secretKey: Uint8Array
): Uint8Array => p256.sign(payload, secretKey)

export const verifyWithP256Sync = (
  sigBytes: Uint8Array,
  payload: Uint8Array,
  pubKeyOrJwk: JsonWebKey | Uint8Array
): boolean => {
  try {
    const pubBytes =
      pubKeyOrJwk instanceof Uint8Array
        ? pubKeyOrJwk
        : pubJwkToUncompressedBytes(pubKeyOrJwk)
    if (!pubBytes || sigBytes.byteLength !== 64) {
      return false
    }
    return p256.verify(sigBytes, payload, pubBytes, {lowS: false})
  } catch {
    return false
  }
}

export type EndpointIdentity = {
  peerId: string
  signSecretKey: Uint8Array
  signPubBytes: Uint8Array
  signPubJwk: JsonWebKey
  signPrivateJwk: JsonWebKey
  sign: (payload: Uint8Array) => Uint8Array
}

const buildEndpointIdentityFromSecret = (
  secretKey: Uint8Array,
  forcedPeerId?: string
): EndpointIdentity => {
  const uncompressed = p256.getPublicKey(secretKey, false)
  const signPubJwk = uncompressedBytesToPubJwk(uncompressed)
  const signPrivateJwk: JsonWebKey = {
    ...signPubJwk,
    d: toBase64Url(secretKey)
  }
  const peerId = forcedPeerId ?? derivePeerIdSync(signPubJwk)
  return {
    peerId,
    signSecretKey: secretKey,
    signPubBytes: uncompressed,
    signPubJwk,
    signPrivateJwk,
    sign: (payload: Uint8Array) => signWithP256Sync(payload, secretKey)
  }
}

const generateEndpointIdentitySync = (): EndpointIdentity => {
  const {secretKey} = p256.keygen()
  return buildEndpointIdentityFromSecret(secretKey)
}

const endpointIdentityByPeerId = new Map<string, EndpointIdentity>()
const registeredTestForcedPeerIds = new Set<string>()

export const defaultEndpointIdentity: EndpointIdentity =
  generateEndpointIdentitySync()
export const defaultSelfId: string = defaultEndpointIdentity.peerId
endpointIdentityByPeerId.set(defaultSelfId, defaultEndpointIdentity)

const deriveDeterministicSecretBytes = (
  domain: string,
  id: string
): Uint8Array => {
  const seed = sha256(encodeBytes(`${domain}:${id}`))
  const dScalar = (bytesToBigInt(seed) % (p256N - 1n)) + 1n
  return bigintTo32Bytes(dScalar)
}

export const registerTestForcedPeerId = (peerId: string): EndpointIdentity => {
  if (!peerId) {
    return defaultEndpointIdentity
  }
  const existing = endpointIdentityByPeerId.get(peerId)
  if (existing) {
    if (peerId !== defaultSelfId) {
      registeredTestForcedPeerIds.add(peerId)
    }
    return existing
  }
  registeredTestForcedPeerIds.add(peerId)
  const secretKey = deriveDeterministicSecretBytes(
    'trystero-test-endpoint-v1',
    peerId
  )
  const identity = buildEndpointIdentityFromSecret(secretKey, peerId)
  endpointIdentityByPeerId.set(peerId, identity)
  return identity
}

export const getOrCreateEndpointIdentitySync = (
  peerId = defaultSelfId
): EndpointIdentity => {
  const existing = endpointIdentityByPeerId.get(peerId)
  if (existing) {
    return existing
  }
  return registerTestForcedPeerId(peerId)
}

export const verifyPeerIdKey = (
  peerId: string,
  pubKeyOrJwk: JsonWebKey | string
): boolean => {
  if (!peerId || typeof peerId !== 'string') {
    return false
  }
  const jwk =
    typeof pubKeyOrJwk === 'string' ? decodePublicKey(pubKeyOrJwk) : pubKeyOrJwk
  if (!jwk || !pubJwkToUncompressedBytes(jwk)) {
    return false
  }
  try {
    if (derivePeerIdSync(jwk) === peerId) {
      return true
    }
  } catch {
    return false
  }
  if (registeredTestForcedPeerIds.has(peerId)) {
    const expected = getOrCreateEndpointIdentitySync(peerId)
    return canonicalizePubJwk(jwk) === canonicalizePubJwk(expected.signPubJwk)
  }
  return false
}

export const verifyUserIdKey = (
  userId: string,
  pubKeyOrJwk: JsonWebKey | string
): boolean => {
  if (!isValidUserId(userId)) {
    return false
  }
  const jwk =
    typeof pubKeyOrJwk === 'string' ? decodePublicKey(pubKeyOrJwk) : pubKeyOrJwk
  if (!jwk || !pubJwkToUncompressedBytes(jwk)) {
    return false
  }
  try {
    return deriveUserIdSync(jwk) === userId
  } catch {
    return false
  }
}

const buildUserIdentityFromSecretKey = (
  secretKey: Uint8Array
): UserIdentity => {
  if (secretKey.byteLength !== 32) {
    throw mkIdentityErr('invalid P-256 secret key length for user identity')
  }
  const scalar = bytesToBigInt(secretKey)
  if (scalar <= 0n || scalar >= p256N) {
    throw mkIdentityErr('invalid P-256 secret scalar for user identity')
  }
  const uncompressed = p256.getPublicKey(secretKey, false)
  const signPubJwk = uncompressedBytesToPubJwk(uncompressed)
  const userId = deriveUserIdSync(signPubJwk)
  const publicKey = encodePublicKey(signPubJwk)
  const userKey =
    userKeyPrefix +
    toBase64Url(
      encodeBytes(
        JSON.stringify({
          d: toBase64Url(secretKey),
          x: signPubJwk.x,
          y: signPubJwk.y
        })
      )
    )

  return {
    userId,
    publicKey,
    userKey,
    signPubJwk,
    sign: (payload: Uint8Array) => signWithP256Sync(payload, secretKey)
  }
}

export const createUserIdentity = (): UserIdentity => {
  const {secretKey} = p256.keygen()
  return buildUserIdentityFromSecretKey(secretKey)
}

const tryParsePrivateJwk = (
  keyOrJwk: string | JsonWebKey
): {secretKey: Uint8Array; x?: string; y?: string} | null => {
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
        jwkObj = JSON.parse(decodeBytes(fromBase64Url(raw)))
      } else if (trimmed.startsWith('{')) {
        jwkObj = JSON.parse(trimmed)
      } else {
        return null
      }
    } else if (keyOrJwk && typeof keyOrJwk === 'object') {
      jwkObj = keyOrJwk
    }

    if (!jwkObj || typeof jwkObj.d !== 'string' || !jwkObj.d) {
      return null
    }
    if (jwkObj.kty && jwkObj.kty !== 'EC') {
      return null
    }
    if (jwkObj.crv && jwkObj.crv !== 'P-256') {
      return null
    }

    const secretKey = fromBase64Url(jwkObj.d)
    if (secretKey.byteLength !== 32) {
      return null
    }
    const scalar = bytesToBigInt(secretKey)
    if (scalar <= 0n || scalar >= p256N) {
      return null
    }

    const uncompressed = p256.getPublicKey(secretKey, false)
    const derivedPub = uncompressedBytesToPubJwk(uncompressed)
    if (
      (typeof jwkObj.x === 'string' && jwkObj.x !== derivedPub.x) ||
      (typeof jwkObj.y === 'string' && jwkObj.y !== derivedPub.y)
    ) {
      return null
    }

    return {
      secretKey,
      ...(derivedPub.x ? {x: derivedPub.x} : {}),
      ...(derivedPub.y ? {y: derivedPub.y} : {})
    }
  } catch {
    return null
  }
}

export const importUserIdentity = (
  keyOrJwk: string | JsonWebKey
): UserIdentity => {
  const parsed = tryParsePrivateJwk(keyOrJwk)
  if (!parsed) {
    throw mkIdentityErr(
      'invalid user identity key material; expected an exported userKey or valid P-256 private JWK'
    )
  }
  return buildUserIdentityFromSecretKey(parsed.secretKey)
}

export const exportUserIdentity = (identity: UserIdentity): string => {
  if (!identity || typeof identity.userKey !== 'string' || !identity.userKey) {
    throw mkIdentityErr('user identity private key is non-extractable')
  }
  return identity.userKey
}

const isUserIdentityObject = (val: unknown): val is UserIdentity =>
  Boolean(
    val &&
    typeof val === 'object' &&
    typeof (val as UserIdentity).userId === 'string' &&
    isValidUserId((val as UserIdentity).userId) &&
    (val as UserIdentity).signPubJwk &&
    typeof (val as UserIdentity).sign === 'function' &&
    verifyUserIdKey(
      (val as UserIdentity).userId,
      (val as UserIdentity).signPubJwk
    )
  )

const coerceCustomUserIdentity = (val: unknown): UserIdentity => {
  if (isUserIdentityObject(val)) {
    return val
  }
  if (typeof val === 'string' || (val && typeof val === 'object')) {
    return importUserIdentity(val as string | JsonWebKey)
  }
  throw mkIdentityErr(
    'invalid custom user identity; expected a UserIdentity, P-256 private JWK, or exported userKey'
  )
}

const canUseWebStorage = (
  getStorage: () => Storage | undefined
): Storage | null => {
  try {
    const storage = getStorage()
    if (!storage || typeof storage.getItem !== 'function') {
      return null
    }
    return storage
  } catch {
    return null
  }
}

const getSessionStorage = (): Storage | null =>
  canUseWebStorage(() =>
    typeof globalThis !== 'undefined' && 'sessionStorage' in globalThis
      ? (globalThis as {sessionStorage?: Storage}).sessionStorage
      : undefined
  )

const getLocalStorage = (): Storage | null =>
  canUseWebStorage(() =>
    typeof globalThis !== 'undefined' && 'localStorage' in globalThis
      ? (globalThis as {localStorage?: Storage}).localStorage
      : undefined
  )

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
  if (raw === undefined || raw === 'none') {
    return
  }
  if (raw === 'session') {
    if (!getSessionStorage()) {
      throw mkIdentityErr(
        'sessionStorage is not available for "session" identity persistence'
      )
    }
    return
  }
  if (raw === 'local') {
    if (!hasIndexedDB() && !getLocalStorage()) {
      throw mkIdentityErr(
        'persistent local storage (IndexedDB / localStorage) is not available in this environment; provide a custom identity loader instead'
      )
    }
    return
  }
  if (typeof raw === 'function') {
    return
  }
  coerceCustomUserIdentity(raw)
}

const runtimeUserIdentityByScope = new Map<string, UserIdentity>()
const localMutexByApp = new Map<string, Promise<UserIdentity>>()
const testUserIdentityByPeerId = new Map<string, UserIdentity>()

const getOrCreateRuntimeUserIdentity = (appId?: string): UserIdentity => {
  const scopeKey = appId || '__default__'
  let cached = runtimeUserIdentityByScope.get(scopeKey)
  if (!cached) {
    cached = createUserIdentity()
    runtimeUserIdentityByScope.set(scopeKey, cached)
  }
  return cached
}

export const getDefaultTestUserIdentitySync = (
  peerId: string
): UserIdentity => {
  if (peerId === defaultSelfId) {
    return getOrCreateRuntimeUserIdentity()
  }
  let cached = testUserIdentityByPeerId.get(peerId)
  if (!cached) {
    const secretKey = deriveDeterministicSecretBytes(
      'trystero-test-user-v1',
      peerId
    )
    cached = buildUserIdentityFromSecretKey(secretKey)
    testUserIdentityByPeerId.set(peerId, cached)
  }
  return cached
}

const loadOrCreateFromWebStorage = (
  storage: Storage,
  appId: string,
  label: string
): UserIdentity => {
  const key = `${storagePrefix}${appId}`
  try {
    const existing = storage.getItem(key)
    if (existing) {
      try {
        return importUserIdentity(existing)
      } catch {
        /* Stored value was corrupted; regenerate and overwrite below */
      }
    }
    const created = createUserIdentity()
    storage.setItem(key, created.userKey)
    const verifyRead = storage.getItem(key)
    if (verifyRead && verifyRead !== created.userKey) {
      return importUserIdentity(verifyRead)
    }
    return created
  } catch (err) {
    throw mkIdentityErr(
      `failed to persist ${label} user identity for app "${appId}": ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }
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
  userKey: '',
  signPubJwk: rec.signPubJwk,
  sign: async (payload: Uint8Array) => {
    const sigBuf = await crypto.subtle.sign(
      {name: 'ECDSA', hash: 'SHA-256'},
      rec.privateKey,
      payload as BufferSource
    )
    return new Uint8Array(sigBuf)
  }
})

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
    req.onerror = () =>
      reject(req.error ?? new Error('failed to open IndexedDB'))
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
    req.onerror = () => reject(req.error ?? new Error('IndexedDB get failed'))
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
      if (
        existing &&
        existing.userId &&
        existing.signPubJwk &&
        existing.privateKey
      ) {
        resolve(existing)
        return
      }
      const addReq = store.add(candidate, appId)
      addReq.onsuccess = () => resolve(candidate)
      addReq.onerror = event => {
        event.preventDefault()
        // ConstraintError from concurrent tab: read winner in a fresh readonly tx
        idbGetRecord(db, appId).then(winner => {
          if (winner) {
            resolve(winner)
          } else {
            reject(addReq.error ?? new Error('IndexedDB atomic add failed'))
          }
        }, reject)
      }
    }
    getReq.onerror = () =>
      reject(getReq.error ?? new Error('IndexedDB get failed'))
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

const loadOrCreateLocalIdentity = (appId: string): Promise<UserIdentity> => {
  const inflight = localMutexByApp.get(appId)
  if (inflight) {
    return inflight
  }

  const promise = withNavigatorLock(`${storagePrefix}${appId}`, async () => {
    const localStore = getLocalStorage()
    if (localStore) {
      const existingRaw = localStore.getItem(`${storagePrefix}${appId}`)
      if (existingRaw) {
        try {
          return importUserIdentity(existingRaw)
        } catch {
          /* ignore corrupted localStorage entry */
        }
      }
    }

    if (hasIndexedDB()) {
      try {
        const db = await openIdentityDb()
        try {
          const existing = await idbGetRecord(db, appId)
          if (
            existing &&
            existing.userId &&
            existing.signPubJwk &&
            existing.privateKey &&
            verifyUserIdKey(existing.userId, existing.signPubJwk)
          ) {
            return buildUserIdentityFromIdbRecord(existing)
          }

          const keyPair = await crypto.subtle.generateKey(
            {name: 'ECDSA', namedCurve: 'P-256'},
            false,
            ['sign', 'verify']
          )
          const rawPubJwk = await crypto.subtle.exportKey(
            'jwk',
            keyPair.publicKey
          )
          const signPubJwk: JsonWebKey = {
            crv: 'P-256',
            kty: 'EC',
            x: rawPubJwk.x ?? '',
            y: rawPubJwk.y ?? ''
          }
          const userId = deriveUserIdSync(signPubJwk)
          const publicKey = encodePublicKey(signPubJwk)
          const candidate: StoredIdbIdentityRecord = {
            userId,
            publicKey,
            signPubJwk,
            privateKey: keyPair.privateKey
          }
          const committed = await idbAddOrGetRecord(db, appId, candidate)
          return buildUserIdentityFromIdbRecord(committed)
        } finally {
          db.close()
        }
      } catch (err) {
        if (!localStore) {
          throw mkIdentityErr(
            `failed to persist local user identity in IndexedDB for app "${appId}": ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        }
      }
    }

    if (localStore) {
      return loadOrCreateFromWebStorage(localStore, appId, 'local')
    }

    throw mkIdentityErr(
      'persistent local storage (IndexedDB / localStorage) is not available in this environment; provide a custom identity loader instead'
    )
  }).finally(() => {
    localMutexByApp.delete(appId)
  })

  localMutexByApp.set(appId, promise)
  return promise
}

export const resolveUserIdentity = async (
  appId: string,
  roomId: string,
  config?: {
    identity?: UserIdentityConfig
    _test_only_forcedPeerId?: string
  },
  localSelfId = defaultSelfId
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

  const forcedPeerId =
    config?._test_only_forcedPeerId ??
    (localSelfId !== defaultSelfId ? localSelfId : undefined)

  const mode: UserIdentityPersistence =
    raw ?? (getSessionStorage() && !forcedPeerId ? 'session' : 'none')

  if (mode === 'none') {
    if (forcedPeerId) {
      return getDefaultTestUserIdentitySync(forcedPeerId)
    }
    return getOrCreateRuntimeUserIdentity(appId)
  }

  if (mode === 'session') {
    const sessionStore = getSessionStorage()
    if (!sessionStore) {
      if (raw === 'session') {
        throw mkIdentityErr(
          'sessionStorage is not available for "session" identity persistence'
        )
      }
      return getOrCreateRuntimeUserIdentity(appId)
    }
    try {
      return loadOrCreateFromWebStorage(sessionStore, appId, 'session')
    } catch (err) {
      if (raw === 'session') {
        throw err
      }
      return getOrCreateRuntimeUserIdentity(appId)
    }
  }

  return loadOrCreateLocalIdentity(appId)
}

export const userEndpointProofPayload = (params: {
  appId: string
  roomId: string
  peerId: string
  peerPubJwk: JsonWebKey
  seq?: number
}): Uint8Array =>
  encodeBytes(
    JSON.stringify([
      'trystero-user-proof-v1',
      params.appId,
      params.roomId,
      params.peerId,
      canonicalizePubJwk(params.peerPubJwk),
      params.seq ?? 0
    ])
  )

const verifiedUserProofCache = new Set<string>()
const verifiedUserProofOrder: string[] = []
const maxVerifiedUserProofCache = 4_096

const rememberVerifiedUserProof = (cacheKey: string): void => {
  if (verifiedUserProofCache.has(cacheKey)) {
    return
  }
  verifiedUserProofCache.add(cacheKey)
  verifiedUserProofOrder.push(cacheKey)
  if (verifiedUserProofOrder.length > maxVerifiedUserProofCache) {
    const oldest = verifiedUserProofOrder.shift()
    if (oldest) {
      verifiedUserProofCache.delete(oldest)
    }
  }
}

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
  const sigBytes = await userIdentity.sign(payload)
  const proof = toBase64Url(sigBytes)
  const cacheKey = `${params.appId}:${params.roomId}:${params.peerId}:${canonicalizePubJwk(params.peerPubJwk)}:${userIdentity.userId}:${params.seq ?? 0}:${proof}`
  rememberVerifiedUserProof(cacheKey)
  return proof
}

export const verifyUserEndpointProof = (params: {
  appId: string
  roomId: string
  peerId: string
  peerPubJwk: JsonWebKey
  userId: string
  userPubJwk: JsonWebKey
  proof: string
  seq?: number
}): boolean => {
  const userPub = params.userPubJwk
  if (
    !params.proof ||
    typeof params.proof !== 'string' ||
    !userPub ||
    !verifyPeerIdKey(params.peerId, params.peerPubJwk) ||
    !verifyUserIdKey(params.userId, userPub)
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
    const ok = verifyWithP256Sync(sigBytes, payload, userPub)
    if (ok) {
      rememberVerifiedUserProof(cacheKey)
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
