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

export const toBase64 = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))

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

export const createBoundedCache = <K, V>(
  maxSize = 4_096
): {
  get: (key: K) => V | undefined
  has: (key: K) => boolean
  set: (key: K, value: V) => void
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
    }
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

export const ecdsaSignAlgo: EcdsaParams = {
  name: 'ECDSA',
  hash: 'SHA-256'
}

const algo = 'AES-GCM'
const pbkdf2Iterations = 600_000
const strToSha1 = createBoundedCache<string, string>(4_096)
const derivedKeyCache = createBoundedCache<string, Promise<CryptoKey>>(64)

export const p256N =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
const p256HalfN = p256N >> 1n

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

export const sha1 = async (str: string): Promise<string> => {
  const cached = strToSha1.get(str)
  if (cached !== undefined) {
    return cached
  }
  const digest = Array.from(await hashWith('SHA-1', str))
    .map(b => b.toString(36))
    .join('')
  strToSha1.set(str, digest)
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
      (await sha256(`:${appId}:${roomId}`)) as BufferSource,
      {name: algo},
      false,
      ['encrypt', 'decrypt']
    )
  }

  const cacheKey = `${secret}\u0000${appId}\u0000${roomId}`
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
      sha256(`${libId}:pbkdf2:v1:${appId}\u0000${roomId}`)
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

  derivedKeyCache.set(cacheKey, deriveP)
  return deriveP
}

const joinChar = '$'
const ivJoinChar = ','

export const encrypt = async (
  keyP: Promise<CryptoKey>,
  plaintext: string,
  aad?: string
): Promise<string> => {
  const iv = crypto.getRandomValues(new Uint8Array(16))

  return (
    iv.join(ivJoinChar) +
    joinChar +
    toBase64(
      new Uint8Array(
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
    )
  )
}

export const decrypt = async (
  keyP: Promise<CryptoKey>,
  raw: string,
  aad?: string
): Promise<string> => {
  if (typeof raw !== 'string') {
    throw mkErr('invalid ciphertext')
  }
  const sep = raw.indexOf(joinChar)
  if (sep <= 0 || raw.indexOf(joinChar, sep + 1) !== -1) {
    throw mkErr('invalid ciphertext')
  }
  const ivParts = raw.slice(0, sep).split(ivJoinChar)
  const c = raw.slice(sep + 1)
  if (ivParts.length !== 16 || !c) {
    throw mkErr('invalid ciphertext')
  }
  const iv = new Uint8Array(16)
  for (let i = 0; i < 16; i++) {
    const n = Number(ivParts[i])
    if (!Number.isInteger(n) || n < 0 || n > 255 || ivParts[i] === '') {
      throw mkErr('invalid ciphertext')
    }
    iv[i] = n
  }

  return decodeBytes(
    await crypto.subtle.decrypt(
      aad === undefined
        ? {name: algo, iv}
        : {name: algo, iv, additionalData: encodeBytes(aad) as BufferSource},
      await keyP,
      fromBase64(c) as BufferSource
    )
  )
}
