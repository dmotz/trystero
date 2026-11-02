import {
  type BoundedCache,
  type BoundedSet,
  base62Alphabet,
  base64UrlRe,
  bytesMatch,
  bytesToBigInt,
  createBoundedCache,
  createBoundedSet,
  decodeBytes,
  encodeBytes,
  fromBase64,
  fromBase64Url,
  fromJson,
  hash32,
  libId,
  libName,
  mkErr,
  peerIdLength,
  toBase64,
  toBase64Url,
  toHex,
  toJson,
  userIdLength
} from './primitives'

export {
  type BoundedCache,
  type BoundedSet,
  base62Alphabet,
  base64UrlRe,
  bytesMatch,
  bytesToBigInt,
  createBoundedCache,
  createBoundedSet,
  decodeBytes,
  encodeBytes,
  fromBase64,
  fromBase64Url,
  fromJson,
  hash32,
  libId,
  libName,
  mkErr,
  peerIdLength,
  toBase64,
  toBase64Url,
  toHex,
  toJson,
  userIdLength
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
const topicHashCache = /*@__PURE__*/ createBoundedCache<string, string>(4_096)
const derivedKeyCache = /*@__PURE__*/ createBoundedCache<
  string,
  Promise<CryptoKey>
>(64)
const derivedAuthKeyCache = /*@__PURE__*/ createBoundedCache<
  string,
  Promise<CryptoKey>
>(64)

export const p256N =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
const p256HalfN = p256N >> 1n
const p256NBytes = /*@__PURE__*/ new Uint8Array([
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

export const normalizeLowSP256Signature = (sig: Uint8Array): Uint8Array => {
  if (sig.byteLength !== 64) {
    return sig
  }
  const s = bytesToBigInt(sig.subarray(32, 64))
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
  const r = bytesToBigInt(sig.subarray(0, 32))
  const s = bytesToBigInt(sig.subarray(32, 64))
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

const derivePbkdf2Key = (
  cache: BoundedCache<string, Promise<CryptoKey>>,
  domainTag: string,
  secret: string,
  appId: string,
  roomId: string,
  derivedKeyType: AesKeyGenParams | HmacKeyGenParams,
  keyUsages: KeyUsage[]
): Promise<CryptoKey> => {
  const cacheKey = toJson([secret, appId, roomId])
  const existing = cache.get(cacheKey)
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
      sha256(toJson([domainTag, appId, roomId]))
    ])
    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt as BufferSource,
        iterations: pbkdf2Iterations,
        hash: 'SHA-256'
      },
      baseKey,
      derivedKeyType,
      false,
      keyUsages
    )
  })()

  deriveP.catch(() => {
    cache.delete(cacheKey)
  })
  cache.set(cacheKey, deriveP)
  return deriveP
}

export const genKey = async (
  secret: string,
  appId: string,
  roomId: string
): Promise<CryptoKey> =>
  secret
    ? derivePbkdf2Key(
        derivedKeyCache,
        `${libId}:pbkdf2:v2`,
        secret,
        appId,
        roomId,
        {name: algo, length: 256},
        ['encrypt', 'decrypt']
      )
    : crypto.subtle.importKey(
        'raw',
        (await sha256(
          toJson([`${libId}:room-key:v2`, appId, roomId])
        )) as BufferSource,
        {name: algo},
        false,
        ['encrypt', 'decrypt']
      )

export const genAuthKey = (
  secret: string,
  appId: string,
  roomId: string
): Promise<CryptoKey> =>
  derivePbkdf2Key(
    derivedAuthKeyCache,
    `${libId}:pbkdf2-auth:v1`,
    secret,
    appId,
    roomId,
    {name: hmacAlgo, hash: 'SHA-256', length: 256},
    ['sign', 'verify']
  )

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
