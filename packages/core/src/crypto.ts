const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const libName = 'Trystero'
export const libId: string = libName.toLowerCase()

export const mkErr = (msg: string): Error => new Error(`${libName}: ${msg}`)

export const toJson: typeof JSON.stringify = JSON.stringify

export const fromJson = <T>(s: string): T => {
  try {
    return JSON.parse(s)
  } catch {
    throw mkErr(`failed to parse JSON: ${s}`)
  }
}

export const encodeBytes = (txt: string): Uint8Array => encoder.encode(txt)

export const decodeBytes = (buf: ArrayBufferLike | ArrayBufferView): string =>
  decoder.decode(buf)

export const toHex = (buffer: Uint8Array): string =>
  buffer.reduce((a, c) => a + c.toString(16).padStart(2, '0'), '')

export const toBase64 = (bytes: Uint8Array): string => {
  let bin = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    bin += String.fromCharCode(bytes[i]!)
  }
  return btoa(bin)
}

export const fromBase64 = (b64: string): Uint8Array => {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i)
  }
  return out
}

export const toBase64Url = (bytes: Uint8Array): string =>
  toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')

export const fromBase64Url = (b64url: string): Uint8Array => {
  const padded = b64url.replace(/-/g, '+').replace(/_/g, '/')
  return fromBase64(padded + '='.repeat((4 - (padded.length % 4)) % 4))
}

export const base62Alphabet =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
export const peerIdLength = 20
export const fingerprintLength = 22
const base64UrlRe = /^[A-Za-z0-9_-]+$/

export const hash32 = (str: string): number => {
  const bytes = encodeBytes(str)
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.byteLength; i++) {
    h = Math.imul(h ^ bytes[i]!, 0x01000193)
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}

export const createBoundedCache = <K, V>(
  maxSize = 4_096
): {
  get: (key: K) => V | undefined
  has: (key: K) => boolean
  set: (key: K, value: V) => void
  delete: (key: K) => boolean
} => {
  const map = new Map<K, V>()
  return {
    get: key => map.get(key),
    has: key => map.has(key),
    set: (key, value) => {
      if (!map.has(key) && map.size >= maxSize) {
        const oldest = map.keys().next().value
        if (oldest !== undefined) {
          map.delete(oldest)
        }
      }
      map.set(key, value)
    },
    delete: key => map.delete(key)
  }
}

export const createBoundedSet = <T>(
  maxSize = 4_096
): {
  has: (value: T) => boolean
  add: (value: T) => boolean
} => {
  const set = new Set<T>()
  return {
    has: value => set.has(value),
    add: value => {
      if (set.has(value)) {
        return false
      }
      if (set.size >= maxSize) {
        const oldest = set.keys().next().value
        if (oldest !== undefined) {
          set.delete(oldest)
        }
      }
      set.add(value)
      return true
    }
  }
}

export const ecdsaKeyAlgo: EcKeyImportParams = {
  name: 'ECDSA',
  namedCurve: 'P-256'
}

export const ecdhKeyAlgo: EcKeyImportParams = {
  name: 'ECDH',
  namedCurve: 'P-256'
}

export const ecdsaSignAlgo: EcdsaParams = {
  name: 'ECDSA',
  hash: 'SHA-256'
}

const algo = 'AES-GCM'
const gcmIvBytes = 12
const gcmTagBytes = 16
const hmacAlgo = 'HMAC'
const pbkdf2Iterations = 600_000
const topicHashCache = createBoundedCache<string, string>(4_096)
const derivedKeyCache = createBoundedCache<string, Promise<CryptoKey>>(64)
const derivedAuthKeyCache = createBoundedCache<string, Promise<CryptoKey>>(64)

export const p256N =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
const p256HalfN = p256N >> 1n
const p256NBytes = new Uint8Array([
  0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff,
  0xff, 0xff, 0xff, 0xbc, 0xe6, 0xfa, 0xad, 0xa7, 0x17, 0x9e, 0x84, 0xf3, 0xb9,
  0xca, 0xc2, 0xfc, 0x63, 0x25, 0x51
])

export const isValidP256PrivateScalar = (bytes: Uint8Array): boolean => {
  if (bytes.byteLength !== 32) {
    return false
  }
  let nonZero = 0
  let borrow = 0
  for (let i = 31; i >= 0; i--) {
    const b = bytes[i]!
    nonZero |= b
    borrow = ((b - p256NBytes[i]! - borrow) >> 8) & 1
  }
  return nonZero !== 0 && borrow === 1
}

const sliceToBigInt = (
  bytes: Uint8Array,
  start: number,
  end: number
): bigint => {
  let res = 0n
  for (let i = start; i < end; i++) {
    res = (res << 8n) | BigInt(bytes[i]!)
  }
  return res
}

export const normalizeLowSP256Signature = (sig: Uint8Array): Uint8Array => {
  if (sig.byteLength !== 64) {
    return sig
  }
  const s = sliceToBigInt(sig, 32, 64)
  if (s <= p256HalfN) {
    return sig
  }
  const out = sig.slice()
  let lowS = p256N - s
  for (let i = 63; i >= 32; i--) {
    out[i] = Number(lowS & 0xffn)
    lowS >>= 8n
  }
  return out
}

export const isLowSP256Signature = (sig: Uint8Array): boolean => {
  if (sig.byteLength !== 64) {
    return false
  }
  const r = sliceToBigInt(sig, 0, 32)
  const s = sliceToBigInt(sig, 32, 64)
  return r > 0n && r < p256N && s > 0n && s <= p256HalfN
}

export const hashWith = async (
  algorithm: string,
  input: string | BufferSource
): Promise<Uint8Array> =>
  new Uint8Array(
    await crypto.subtle.digest(
      algorithm,
      typeof input === 'string' ? (encodeBytes(input) as BufferSource) : input
    )
  )

export const sha256 = (input: string | BufferSource): Promise<Uint8Array> =>
  hashWith('SHA-256', input)

export const ecdsaSign = async (
  privateKey: CryptoKey,
  data: BufferSource
): Promise<Uint8Array> =>
  normalizeLowSP256Signature(
    new Uint8Array(await crypto.subtle.sign(ecdsaSignAlgo, privateKey, data))
  )

export const ecdsaVerify = (
  publicKey: CryptoKey,
  sig: BufferSource,
  data: BufferSource
): Promise<boolean> => crypto.subtle.verify(ecdsaSignAlgo, publicKey, sig, data)

export const hashTopic = async (str: string): Promise<string> => {
  const cached = topicHashCache.get(str)
  if (cached !== undefined) {
    return cached
  }
  const digest = toBase64Url(await sha256(str))
  topicHashCache.set(str, digest)
  return digest
}

export const genKey = async (
  secret: string,
  appId: string,
  roomId: string
): Promise<CryptoKey> => {
  if (!secret) {
    return crypto.subtle.importKey(
      'raw',
      (await sha256(
        toJson([`${libId}:room-key:v2`, appId, roomId])
      )) as BufferSource,
      {name: algo},
      false,
      ['encrypt', 'decrypt']
    )
  }

  const cacheKey = toJson([secret, appId, roomId])
  const existing = derivedKeyCache.get(cacheKey)
  if (existing) {
    return existing
  }

  const deriveP = (async () => {
    const [baseKey, salt] = await Promise.all([
      crypto.subtle.importKey(
        'raw',
        encodeBytes(secret) as BufferSource,
        'PBKDF2',
        false,
        ['deriveKey']
      ),
      sha256(toJson([`${libId}:pbkdf2:v2`, appId, roomId]))
    ])
    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt as BufferSource,
        iterations: pbkdf2Iterations,
        hash: 'SHA-256'
      },
      baseKey,
      {name: algo, length: 256},
      false,
      ['encrypt', 'decrypt']
    )
  })()

  deriveP.catch(() => {
    derivedKeyCache.delete(cacheKey)
  })
  derivedKeyCache.set(cacheKey, deriveP)
  return deriveP
}

export const genAuthKey = (
  secret: string,
  appId: string,
  roomId: string
): Promise<CryptoKey> => {
  const cacheKey = toJson([secret, appId, roomId])
  const existing = derivedAuthKeyCache.get(cacheKey)
  if (existing) {
    return existing
  }

  const deriveP = (async () => {
    const [baseKey, salt] = await Promise.all([
      crypto.subtle.importKey(
        'raw',
        encodeBytes(secret) as BufferSource,
        'PBKDF2',
        false,
        ['deriveKey']
      ),
      sha256(toJson([`${libId}:pbkdf2-auth:v1`, appId, roomId]))
    ])
    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt as BufferSource,
        iterations: pbkdf2Iterations,
        hash: 'SHA-256'
      },
      baseKey,
      {name: hmacAlgo, hash: 'SHA-256', length: 256},
      false,
      ['sign', 'verify']
    )
  })()

  deriveP.catch(() => {
    derivedAuthKeyCache.delete(cacheKey)
  })
  derivedAuthKeyCache.set(cacheKey, deriveP)
  return deriveP
}

const roomAuthPayload = (
  appId: string,
  roomId: string,
  peerId: string,
  seq: number
): Uint8Array =>
  encodeBytes(toJson([`${libId}:ov-auth:v2`, appId, roomId, peerId, seq]))

export const signRoomAuth = async (
  secret: string,
  appId: string,
  roomId: string,
  peerId: string,
  seq: number
): Promise<string> => {
  const key = await genAuthKey(secret, appId, roomId)
  const mac = await crypto.subtle.sign(
    hmacAlgo,
    key,
    roomAuthPayload(appId, roomId, peerId, seq) as BufferSource
  )
  return toBase64Url(new Uint8Array(mac))
}

export const verifyRoomAuth = async (
  secret: string,
  appId: string,
  roomId: string,
  peerId: string,
  seq: number,
  token: string
): Promise<boolean> => {
  if (typeof token !== 'string' || !base64UrlRe.test(token)) {
    return false
  }
  try {
    const sigBytes = fromBase64Url(token)
    if (sigBytes.byteLength !== 32 || toBase64Url(sigBytes) !== token) {
      return false
    }
    const key = await genAuthKey(secret, appId, roomId)
    return await crypto.subtle.verify(
      hmacAlgo,
      key,
      sigBytes as BufferSource,
      roomAuthPayload(appId, roomId, peerId, seq) as BufferSource
    )
  } catch {
    return false
  }
}

export const derivePairwiseAesKey = async (
  privateKey: CryptoKey,
  remoteUncompressedPub: Uint8Array,
  appId: string,
  roomId: string,
  peerA: string,
  peerB: string
): Promise<CryptoKey> => {
  const remotePub = await crypto.subtle.importKey(
    'raw',
    remoteUncompressedPub as BufferSource,
    ecdhKeyAlgo,
    false,
    []
  )
  const sharedBits = new Uint8Array(
    await crypto.subtle.deriveBits(
      {name: 'ECDH', public: remotePub},
      privateKey,
      256
    )
  )
  try {
    const [hkdfKey, salt] = await Promise.all([
      crypto.subtle.importKey(
        'raw',
        sharedBits as BufferSource,
        'HKDF',
        false,
        ['deriveKey']
      ),
      sha256(toJson([`${libId}:e2e-salt:v2`, appId, roomId]))
    ])
    const [firstPeer, secondPeer] =
      peerA < peerB ? [peerA, peerB] : [peerB, peerA]
    const info = encodeBytes(
      toJson([`${libId}:e2e-info:v2`, appId, roomId, firstPeer, secondPeer])
    )
    return await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: salt as BufferSource,
        info: info as BufferSource
      },
      hkdfKey,
      {name: algo, length: 256},
      false,
      ['encrypt', 'decrypt']
    )
  } finally {
    sharedBits.fill(0)
  }
}

export const encrypt = async (
  keyP: Promise<CryptoKey>,
  plaintext: string,
  aad?: string
): Promise<string> => {
  const iv = crypto.getRandomValues(new Uint8Array(gcmIvBytes))
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      aad === undefined
        ? {name: algo, iv}
        : {
            name: algo,
            iv,
            additionalData: encodeBytes(aad) as BufferSource
          },
      await keyP,
      encodeBytes(plaintext) as BufferSource
    )
  )
  const packed = new Uint8Array(gcmIvBytes + ct.byteLength)
  packed.set(iv, 0)
  packed.set(ct, gcmIvBytes)
  return toBase64Url(packed)
}

export const decrypt = async (
  keyP: Promise<CryptoKey>,
  raw: string,
  aad?: string
): Promise<string> => {
  if (typeof raw !== 'string' || !base64UrlRe.test(raw)) {
    throw mkErr('invalid ciphertext')
  }
  const packed = fromBase64Url(raw)
  if (
    packed.byteLength < gcmIvBytes + gcmTagBytes ||
    toBase64Url(packed) !== raw
  ) {
    throw mkErr('invalid ciphertext')
  }
  const iv = packed.subarray(0, gcmIvBytes)
  const ct = packed.subarray(gcmIvBytes)

  return decodeBytes(
    await crypto.subtle.decrypt(
      aad === undefined
        ? {name: algo, iv: iv as BufferSource}
        : {
            name: algo,
            iv: iv as BufferSource,
            additionalData: encodeBytes(aad) as BufferSource
          },
      await keyP,
      ct as BufferSource
    )
  )
}
