import {ecdsaSign, normalizeLowSP256Signature} from './crypto'
import {jwkToCompactPub, verifyWithP256} from './identity'
import type {MaybePromise} from './internal-types'
import type {JsonValue, RoleCertificate} from './types'
import {
  createBoundedCache,
  domainTag,
  encodeBytes,
  fromBase64Url,
  isPosSafeInt,
  keys,
  mkErr,
  toBase64Url,
  toJson,
  utf8ByteLength
} from './utils'

export type StateSigner =
  | CryptoKey
  | ((payload: Uint8Array) => MaybePromise<Uint8Array>)

export type Hlc = readonly [wallMs: number, counter: number]

export const zeroHlc: Hlc = [0, 0]
export const defaultMaxClockSkewMs = 60_000
export const stateMaxFutureSkewMs = 10_000
export const maxObservedClockDragMs = 5_000

const maxJsonDepth = 64

export const canonTag = (tag: string, items: unknown[], version = 1): string =>
  toJson([domainTag(tag, version), ...items])

export const isValidHlc = (v: unknown): v is Hlc =>
  Array.isArray(v) &&
  v.length === 2 &&
  isPosSafeInt(v[0]) &&
  typeof v[1] === 'number' &&
  Number.isSafeInteger(v[1]) &&
  v[1] >= 0

export const compareHlc = (a: Hlc, b: Hlc): number => a[0] - b[0] || a[1] - b[1]

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
          continue
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
  const bytes = utf8ByteLength(json)
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
  nextHlc: (ns: string, minHlc?: Hlc, maxSkewMs?: number) => Hlc
}

export const createMonotonicClock = (initial = 0): MonotonicClock => {
  let lastWall = initial
  let lastCounter = 0
  return {
    peek: () => lastWall,
    observe: (ts, maxForwardMs = maxObservedClockDragMs) => {
      const bounded = Math.min(ts, Date.now() + maxForwardMs)
      if (bounded > lastWall) {
        lastWall = bounded
        lastCounter = 0
      }
    },
    next: (minTs = 0) => {
      const now = Date.now()
      const target = Math.max(now, lastWall + 1, minTs)
      const maxGlobal = now + maxObservedClockDragMs
      if (target <= maxGlobal) {
        lastWall = target
      } else if (maxGlobal > lastWall) {
        lastWall = maxGlobal
      }
      lastCounter = 0
      return target
    },
    nextHlc: (ns, minHlc = zeroHlc, maxSkewMs = stateMaxFutureSkewMs) => {
      const now = Date.now()
      const targetWall = Math.max(now, lastWall, minHlc[0])
      if (targetWall > now + maxSkewMs) {
        throw mkErr(`state clock skew exceeded for "${ns}"`)
      }
      const counter =
        targetWall > lastWall && targetWall > minHlc[0]
          ? 0
          : Math.max(
              targetWall === lastWall ? lastCounter : -1,
              targetWall === minHlc[0] ? minHlc[1] : -1
            ) + 1
      const maxGlobal = now + maxObservedClockDragMs
      if (targetWall <= maxGlobal) {
        lastWall = targetWall
        lastCounter = counter
      } else if (maxGlobal > lastWall) {
        lastWall = maxGlobal
        lastCounter = 0
      }
      return [targetWall, counter]
    }
  }
}

export const roleCertPayload = (cert: Omit<RoleCertificate, 'sig'>): string =>
  canonTag(
    'role-cert',
    [
      cert.v,
      cert.certId,
      cert.issuerPubKey,
      cert.subUserId,
      cert.appId,
      cert.roomId,
      cert.roles.toSorted(),
      cert.seq,
      cert.iat
    ],
    2
  )

export const invalidRoles = (): {valid: false; roles: string[]} => ({
  valid: false,
  roles: []
})

export const signRoleCertInternal = async (
  signer: StateSigner,
  issuerPubJwk: JsonWebKey | string,
  subUserId: string,
  appId: string,
  roomId: string,
  roles: string[],
  iat: number,
  seq = 1
): Promise<RoleCertificate> => {
  const unsigned: Omit<RoleCertificate, 'sig'> = {
    v: 1,
    certId: crypto.randomUUID(),
    issuerPubKey: jwkToCompactPub(issuerPubJwk),
    subUserId,
    appId,
    roomId,
    roles: [...new Set(roles)].sort(),
    seq,
    iat
  }
  return {...unsigned, sig: await signWith(signer, roleCertPayload(unsigned))}
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
