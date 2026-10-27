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
const strToSha1: Record<string, string> = {}

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
  new Uint8Array(await crypto.subtle.sign(ecdsaSignAlgo, privateKey, data))

export const ecdsaVerify = (
  publicKey: CryptoKey,
  sig: BufferSource,
  data: BufferSource
): Promise<boolean> => crypto.subtle.verify(ecdsaSignAlgo, publicKey, sig, data)

export const sha1 = async (str: string): Promise<string> =>
  (strToSha1[str] ??= Array.from(await hashWith('SHA-1', str))
    .map(b => b.toString(36))
    .join(''))

export const genKey = async (
  secret: string,
  appId: string,
  roomId: string
): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    'raw',
    (await sha256(`${secret}:${appId}:${roomId}`)) as BufferSource,
    {name: algo},
    false,
    ['encrypt', 'decrypt']
  )

const joinChar = '$'
const ivJoinChar = ','

export const encrypt = async (
  keyP: Promise<CryptoKey>,
  plaintext: string
): Promise<string> => {
  const iv = crypto.getRandomValues(new Uint8Array(16))

  return (
    iv.join(ivJoinChar) +
    joinChar +
    toBase64(
      new Uint8Array(
        await crypto.subtle.encrypt(
          {name: algo, iv},
          await keyP,
          encodeBytes(plaintext) as BufferSource
        )
      )
    )
  )
}

export const decrypt = async (
  keyP: Promise<CryptoKey>,
  raw: string
): Promise<string> => {
  const [iv, c] = raw.split(joinChar)

  return decodeBytes(
    await crypto.subtle.decrypt(
      {name: algo, iv: new Uint8Array(iv?.split(ivJoinChar).map(Number) ?? [])},
      await keyP,
      fromBase64(c ?? '') as BufferSource
    )
  )
}
