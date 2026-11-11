const encoder = /*@__PURE__*/ new TextEncoder()
const decoder = /*@__PURE__*/ new TextDecoder()

export const libName = 'Trystero'
export const libId = 'trystero'

export const domainTag = (name: string, version: number): string =>
  `${libId}:${name}:v${version}`

export const socketInitialFailureSymbol: unique symbol =
  /*@__PURE__*/ Symbol.for(`${libId}.socketInitialFailure`) as never
export const pluginSlotSymbol: unique symbol = /*@__PURE__*/ Symbol.for(
  `${libId}.slot`
) as never

export const mkErr = (msg: string): Error => new Error(`${libName}: ${msg}`)

// State-machine conventions: dispatch on phase -> switch + default: unreachable; predicates -> named type guards; never negative phase lists.
export const unreachable = (x: never): never => {
  throw mkErr(x)
}

export const toJson: typeof JSON.stringify = JSON.stringify

export const fromJson = <T>(s: string): T => {
  try {
    return JSON.parse(s) as T
  } catch {
    throw mkErr(`failed to parse JSON (${s.length} bytes)`)
  }
}

export const encodeBytes = (txt: string): Uint8Array => encoder.encode(txt)

export const encodeBytesInto = (
  txt: string,
  dest: Uint8Array
): TextEncoderEncodeIntoResult => encoder.encodeInto(txt, dest)

export const utf8ByteLength = (txt: string): number => {
  let bytes = 0
  for (let i = 0; i < txt.length; i++) {
    const code = txt.charCodeAt(i)
    if (code < 0x80) {
      bytes += 1
    } else if (code < 0x800) {
      bytes += 2
    } else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      i + 1 < txt.length &&
      (txt.charCodeAt(i + 1) & 0xfc00) === 0xdc00
    ) {
      bytes += 4
      i++
    } else {
      bytes += 3
    }
  }
  return bytes
}

export const decodeBytes = (buf: ArrayBufferLike | ArrayBufferView): string =>
  decoder.decode(buf)

const b64UrlEncodeOpts = {alphabet: 'base64url', omitPadding: true} as const
const b64UrlDecodeOpts = {alphabet: 'base64url'} as const

const nativeToBase64 = (
  Uint8Array.prototype as Uint8Array & {
    toBase64?: (options?: typeof b64UrlEncodeOpts) => string
  }
).toBase64

const nativeFromBase64 = (
  Uint8Array as Uint8ArrayConstructor & {
    fromBase64?: (b64: string, options?: typeof b64UrlDecodeOpts) => Uint8Array
  }
).fromBase64

export const toBase64Url: (bytes: Uint8Array) => string =
  typeof nativeToBase64 === 'function'
    ? bytes => nativeToBase64.call(bytes, b64UrlEncodeOpts)
    : bytes => {
        let bin = ''
        for (let i = 0; i < bytes.byteLength; i++) {
          bin += String.fromCharCode(bytes[i]!)
        }
        return btoa(bin)
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/g, '')
      }

export const fromBase64Url: (b64url: string) => Uint8Array =
  typeof nativeFromBase64 === 'function'
    ? b64url => nativeFromBase64(b64url, b64UrlDecodeOpts)
    : b64url => {
        const padded = b64url.replace(/-/g, '+').replace(/_/g, '/')
        const bin = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
        const out = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) {
          out[i] = bin.charCodeAt(i)
        }
        return out
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
  readonly size: number
  get: (key: K) => V | undefined
  has: (key: K) => boolean
  set: (key: K, value: V) => void
  delete: (key: K) => boolean
  clear: () => void
  keys: () => K[]
  entries: () => [K, V][]
}

export const createBoundedCache = <K, V>(
  maxSize = 4_096
): BoundedCache<K, V> => {
  const map = new Map<K, V>()
  return {
    get size() {
      return map.size
    },
    get: key => {
      if (!map.has(key)) {
        return undefined
      }
      const value = map.get(key) as V
      map.delete(key)
      map.set(key, value)
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
    delete: key => map.delete(key),
    clear: () => map.clear(),
    keys: () => [...map.keys()],
    entries: () => [...map.entries()]
  }
}

export type BoundedSet<T> = {
  has: (value: T) => boolean
  add: (value: T) => boolean
  clear: () => void
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
    },
    clear: () => set.clear()
  }
}
