const encoder = /*@__PURE__*/ new TextEncoder()
const decoder = /*@__PURE__*/ new TextDecoder()

export const libName = 'Trystero'
export const libId = 'trystero'

export const mkErr = (msg: string): Error => new Error(`${libName}: ${msg}`)

export const toJson: typeof JSON.stringify = JSON.stringify

export const fromJson = <T>(s: string): T => {
  try {
    return JSON.parse(s) as T
  } catch {
    throw mkErr(`failed to parse JSON: ${s}`)
  }
}

export const encodeBytes = (txt: string): Uint8Array => encoder.encode(txt)

export const decodeBytes = (buf: ArrayBufferLike | ArrayBufferView): string =>
  decoder.decode(buf)

export const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')

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
export const userIdLength = 22
export const base64UrlRe: RegExp = /^[A-Za-z0-9_-]+$/

export const bytesToBigInt = (bytes: Uint8Array): bigint => {
  let res = 0n
  for (const b of bytes) {
    res = (res << 8n) | BigInt(b)
  }
  return res
}

export const bytesMatch = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.byteLength !== b.byteLength) {
    return false
  }
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) {
      return false
    }
  }
  return true
}

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

export type BoundedCache<K, V> = {
  get: (key: K) => V | undefined
  has: (key: K) => boolean
  set: (key: K, value: V) => void
  delete: (key: K) => boolean
}

export const createBoundedCache = <K, V>(
  maxSize = 4_096
): BoundedCache<K, V> => {
  const map = new Map<K, V>()
  return {
    get: key => {
      const value = map.get(key)
      if (value !== undefined || map.has(key)) {
        map.delete(key)
        map.set(key, value as V)
      }
      return value
    },
    has: key => map.has(key),
    set: (key, value) => {
      if (map.has(key)) {
        map.delete(key)
      } else if (map.size >= maxSize) {
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

export type BoundedSet<T> = {
  has: (value: T) => boolean
  add: (value: T) => boolean
}

export const createBoundedSet = <T>(maxSize = 4_096): BoundedSet<T> => {
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
