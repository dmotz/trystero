import {ecdsaSign, normalizeLowSP256Signature} from './crypto'
import {
  getVerifiedPubKeyRecord,
  jwkToCompactPub,
  pubJwkToUncompressedBytes,
  verifyWithP256
} from './identity'
import {hash32} from './primitives'
import type {JsonValue, MaybePromise, RoleCertificate} from './types'
import {
  cmpStr,
  createBoundedCache,
  encodeBytes,
  fromBase64Url,
  isObj,
  keys,
  mkErr,
  toBase64Url,
  toJson,
  validateRoleCertificateShape
} from './utils'

export type StateSigner =
  | CryptoKey
  | ((payload: Uint8Array) => MaybePromise<Uint8Array>)

export const defaultMaxClockSkewMs = 60_000
export const maxObservedClockDragMs = 5_000

const maxJsonDepth = 64

export const canonTag = (tag: string, items: unknown[]): string =>
  toJson([`trystero:${tag}:v1`, ...items])

export const isValidJwk = (value: unknown): value is JsonWebKey =>
  isObj(value) && Boolean(pubJwkToUncompressedBytes(value as JsonWebKey))

export const toCleanJwk = (jwk: JsonWebKey): JsonWebKey => ({
  kty: 'EC',
  crv: 'P-256',
  x: jwk.x ?? '',
  y: jwk.y ?? ''
})

export const signWith = async (
  signer: StateSigner,
  payload: string
): Promise<string> => {
  const bytes = encodeBytes(payload)
  const signature =
    typeof signer === 'function'
      ? normalizeLowSP256Signature(await signer(bytes))
      : await ecdsaSign(signer, bytes as BufferSource)
  return toBase64Url(signature)
}

export const verifySig = (
  pub: JsonWebKey | string,
  payload: string,
  sig: string
): boolean | Promise<boolean> => {
  try {
    const res = verifyWithP256(fromBase64Url(sig), encodeBytes(payload), pub)
    return typeof res === 'boolean' ? res : res.catch(() => false)
  } catch {
    return false
  }
}

/**
 * Returns `[canonicalJson, utf8ByteLength]` on success, `0` for invalid JSON,
 * or `1` when exceeding `maxBytes`.
 */
export const canonicalizeAndMeasureJson = (
  value: unknown,
  maxBytes: number = Number.POSITIVE_INFINITY
): readonly [json: string, bytes: number] | 0 | 1 => {
  const seen = new Set<object>()

  const walk = (item: unknown, depth: number): string | null => {
    if (depth > maxJsonDepth) {
      return null
    }
    if (item === null || typeof item === 'boolean') {
      return String(item)
    }
    if (typeof item === 'number') {
      return Number.isFinite(item) ? toJson(item) : null
    }
    if (typeof item === 'string') {
      return toJson(item)
    }
    if (typeof item !== 'object') {
      return null
    }
    const obj = item as object
    if (seen.has(obj)) {
      return null
    }
    const isArr = Array.isArray(obj)
    if (!isArr) {
      const proto = Object.getPrototypeOf(obj)
      if (proto !== Object.prototype && proto !== null) {
        return null
      }
    }
    seen.add(obj)
    try {
      if (isArr) {
        const parts: string[] = []
        for (let i = 0; i < obj.length; i++) {
          const serialized = walk(obj[i], depth + 1)
          if (serialized === null) {
            return null
          }
          parts.push(serialized)
        }
        return `[${parts.join(',')}]`
      }
      const record = obj as Record<string, unknown>
      const sortedKeys = keys(record).sort()
      const parts: string[] = []
      for (let i = 0; i < sortedKeys.length; i++) {
        const key = sortedKeys[i]!
        const prop = record[key]
        if (prop === undefined) {
          return null
        }
        const serialized = walk(prop, depth + 1)
        if (serialized === null) {
          return null
        }
        parts.push(`${toJson(key)}:${serialized}`)
      }
      return `{${parts.join(',')}}`
    } finally {
      seen.delete(obj)
    }
  }

  const json = walk(value, 0)
  if (json === null) {
    return 0
  }
  const bytes = encodeBytes(json).byteLength
  return bytes > maxBytes ? 1 : [json, bytes]
}

export const canonicalizeJson = (value: JsonValue): string => {
  const res = canonicalizeAndMeasureJson(value)
  if (!Array.isArray(res)) {
    throw mkErr('value must be valid finite JSON')
  }
  return res[0]
}

export type MonotonicClock = {
  peek: () => number
  observe: (ts: number, maxForwardMs?: number) => void
  next: (minTs?: number) => number
  nextBounded: (ns: string, minTs?: number, maxSkewMs?: number) => number
}

export const createMonotonicClock = (initial = 0): MonotonicClock => {
  let last = initial
  return {
    peek: () => last,
    observe: (ts, maxForwardMs = maxObservedClockDragMs) => {
      const bounded = Math.min(ts, Date.now() + maxForwardMs)
      if (bounded > last) {
        last = bounded
      }
    },
    next: (minTs = 0) => {
      last = Math.max(Date.now(), last + 1, minTs)
      return last
    },
    nextBounded: (ns, minTs = 0, maxSkewMs = defaultMaxClockSkewMs) => {
      const now = Date.now()
      const candidate = Math.max(now, last + 1, minTs)
      if (candidate > now + maxSkewMs) {
        throw mkErr(`state clock skew exceeded for "${ns}"`)
      }
      const maxGlobal = now + maxObservedClockDragMs
      if (candidate <= maxGlobal) {
        last = candidate
      } else if (maxGlobal > last) {
        last = maxGlobal
      }
      return candidate
    }
  }
}

export const selectPullFanoutPeers = (
  selfId: string,
  directPeerIds: readonly string[],
  isBanned: (peerId: string) => boolean
): string[] =>
  directPeerIds
    .filter(id => !isBanned(id))
    .sort(
      (a, b) =>
        hash32(`${selfId}:${a}`) - hash32(`${selfId}:${b}`) || cmpStr(a, b)
    )

export const roleCertPayload = (cert: Omit<RoleCertificate, 'sig'>): string =>
  canonTag('role-cert', [
    cert.v,
    cert.certId,
    cert.issuerPubKey,
    cert.subUserId,
    cert.appId,
    cert.roomId,
    [...cert.roles].sort(),
    cert.iat
  ])

export const invalidRoles = (): {valid: false; roles: string[]} => ({
  valid: false,
  roles: []
})

export const signRoleCertInternal = async (
  signer: StateSigner,
  issuerPubJwk: JsonWebKey,
  subUserId: string,
  appId: string,
  roomId: string,
  roles: string[],
  iat: number
): Promise<RoleCertificate> => {
  const unsigned: Omit<RoleCertificate, 'sig'> = {
    v: 1,
    certId: crypto.randomUUID(),
    issuerPubKey: jwkToCompactPub(issuerPubJwk),
    subUserId,
    appId,
    roomId,
    roles: [...new Set(roles)].sort(),
    iat
  }
  return {...unsigned, sig: await signWith(signer, roleCertPayload(unsigned))}
}

export const verifyRoleCertificate = async (
  cert: RoleCertificate,
  appId: string,
  roomId: string,
  rootUserIds: Set<string>,
  clockSkewMs: number = defaultMaxClockSkewMs
): Promise<{valid: boolean; roles: string[]}> => {
  if (
    !validateRoleCertificateShape(cert) ||
    cert.appId !== appId ||
    cert.roomId !== roomId ||
    cert.iat > Date.now() + clockSkewMs ||
    (!rootUserIds.has(cert.subUserId) && cert.roles.includes('admin'))
  ) {
    return invalidRoles()
  }
  const issuer = await getVerifiedPubKeyRecord(cert.issuerPubKey)
  if (!issuer || !rootUserIds.has(issuer[6])) {
    return invalidRoles()
  }
  return (await verifySig(cert.issuerPubKey, roleCertPayload(cert), cert.sig))
    ? {valid: true, roles: [...cert.roles]}
    : invalidRoles()
}

export type SlidingReplayWindow = {
  has: (key: string, seq: number) => boolean
  record: (key: string, seq: number) => boolean
  seed: (key: string, seq: number) => void
  delete: (key: string) => void
  clear: () => void
}

type ReplayEntry = [maxSeq: number, windowBits: bigint, lastSeenAt: number]

export const createSlidingReplayWindow = (
  maxKeys: number,
  isPinnedKey?: (key: string) => boolean,
  windowBits = 256n
): SlidingReplayWindow => {
  const windowMask = (1n << windowBits) - 1n
  const map = new Map<string, ReplayEntry>()

  const evictIfFull = (): void => {
    if (map.size < maxKeys) {
      return
    }
    if (isPinnedKey) {
      let oldestKey: string | null = null
      let oldestTime = Infinity
      for (const [k, v] of map) {
        if (!isPinnedKey(k) && v[2] < oldestTime) {
          oldestTime = v[2]
          oldestKey = k
        }
      }
      if (oldestKey !== null) {
        map.delete(oldestKey)
      }
    } else {
      const oldest = map.keys().next().value
      if (oldest !== undefined) {
        map.delete(oldest)
      }
    }
  }

  return {
    has: (key, seq) => {
      const state = map.get(key)
      if (!state || seq > state[0]) {
        return false
      }
      if (seq === state[0]) {
        return true
      }
      const offset = BigInt(state[0] - seq)
      return offset >= windowBits || (state[1] & (1n << offset)) !== 0n
    },
    record: (key, seq) => {
      const now = Date.now()
      const state = map.get(key)
      if (!state) {
        evictIfFull()
        map.set(key, [seq, 1n, now])
        return true
      }

      if (seq > state[0]) {
        const shift = BigInt(seq - state[0])
        state[1] =
          shift >= windowBits ? 1n : ((state[1] << shift) | 1n) & windowMask
        state[0] = seq
        state[2] = now
        return true
      }

      if (seq === state[0]) {
        return false
      }

      const offset = BigInt(state[0] - seq)
      if (offset >= windowBits) {
        return false
      }
      const bit = 1n << offset
      if ((state[1] & bit) !== 0n) {
        return false
      }
      state[1] |= bit
      state[2] = now
      return true
    },
    seed: (key, seq) => {
      if (seq <= 0) {
        return
      }
      const now = Date.now()
      const state = map.get(key)
      if (!state) {
        evictIfFull()
        map.set(key, [seq, windowMask, now])
      } else if (seq > state[0]) {
        state[0] = seq
        state[1] = windowMask
        state[2] = now
      }
    },
    delete: key => {
      map.delete(key)
    },
    clear: () => {
      map.clear()
    }
  }
}

export type TokenBucketLimiter = {
  consume: (key: string, cost?: number) => boolean
  delete: (key: string) => void
  clear: () => void
}

export const createTokenBucketLimiter = (
  ratePerSec: number,
  burst: number,
  maxKeys = 512
): TokenBucketLimiter => {
  const buckets = createBoundedCache<
    string,
    [tokens: number, lastRefillMs: number]
  >(maxKeys)

  return {
    consume: (key, cost = 1) => {
      const now = Date.now()
      const cur = buckets.get(key)
      if (!cur) {
        if (burst < cost) {
          return false
        }
        buckets.set(key, [burst - cost, now])
        return true
      }
      const elapsedSec = Math.max(0, now - cur[1]) / 1_000
      if (elapsedSec > 0) {
        cur[0] = Math.min(burst, cur[0] + elapsedSec * ratePerSec)
        cur[1] = now
      }
      if (cur[0] < cost) {
        return false
      }
      cur[0] -= cost
      return true
    },
    delete: key => {
      buckets.delete(key)
    },
    clear: () => {
      buckets.clear()
    }
  }
}
