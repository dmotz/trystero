import {ecdsaSign, normalizeLowSP256Signature} from './crypto'
import {
  getVerifiedPubKeyRecord,
  jwkToCompactPub,
  pubJwkToUncompressedBytes,
  verifyWithP256
} from './identity'
import type {JsonValue, MaybePromise, RoleCertificate} from './types'
import {
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

const maxJsonDepth = 64

export const canonTag = (tag: string, items: unknown[]): string =>
  toJson([`trystero:${tag}:v1`, ...items])

export const isValidJwk = (v: unknown): v is JsonWebKey =>
  isObj(v) && Boolean(pubJwkToUncompressedBytes(v as JsonWebKey))

export const toCleanJwk = (j: JsonWebKey): JsonWebKey => ({
  kty: 'EC',
  crv: 'P-256',
  x: j.x ?? '',
  y: j.y ?? ''
})

export const signWith = async (
  signer: StateSigner,
  payload: string
): Promise<string> => {
  const b = encodeBytes(payload)
  const s =
    typeof signer === 'function'
      ? normalizeLowSP256Signature(await signer(b))
      : await ecdsaSign(signer, b as BufferSource)
  return toBase64Url(s)
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

export type CanonicalJsonResult =
  | {ok: true; json: string; bytes: number}
  | {ok: false; reason: 'invalid' | 'max-bytes'}

export const canonicalizeAndMeasureJson = (
  val: unknown,
  maxBytes: number = Number.POSITIVE_INFINITY
): CanonicalJsonResult => {
  let minBytes = 0
  let seen: Set<object> | null = null

  const walk = (v: unknown, depth: number): string | false | null => {
    if (depth > maxJsonDepth) {
      return null
    }
    if (v === null || typeof v === 'boolean') {
      const s = String(v)
      return (minBytes += s.length) > maxBytes ? false : s
    }
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) {
        return null
      }
      const s = toJson(v)
      return (minBytes += s.length) > maxBytes ? false : s
    }
    if (typeof v === 'string') {
      return (minBytes += v.length + 2) > maxBytes ? false : toJson(v)
    }
    if (typeof v !== 'object') {
      return null
    }
    const obj = v as object
    seen ??= new Set<object>()
    if (seen.has(obj)) {
      return null
    }
    if (Array.isArray(obj)) {
      if ((minBytes += 2 + Math.max(0, obj.length - 1)) > maxBytes) {
        return false
      }
      seen.add(obj)
      const parts: string[] = []
      for (let i = 0; i < obj.length; i++) {
        const s = walk(obj[i], depth + 1)
        if (typeof s !== 'string') {
          seen.delete(obj)
          return s
        }
        parts.push(s)
      }
      seen.delete(obj)
      return `[${parts.join(',')}]`
    }
    const proto = Object.getPrototypeOf(obj)
    if (proto !== Object.prototype && proto !== null) {
      return null
    }
    const sorted = keys(obj as Record<string, unknown>).sort()
    if ((minBytes += 2 + Math.max(0, sorted.length * 2 - 1)) > maxBytes) {
      return false
    }
    seen.add(obj)
    const parts: string[] = []
    for (let i = 0; i < sorted.length; i++) {
      const k = sorted[i]!
      const pv = (obj as Record<string, unknown>)[k]
      if (pv === undefined || (minBytes += k.length + 2) > maxBytes) {
        seen.delete(obj)
        return pv === undefined ? null : false
      }
      const s = walk(pv, depth + 1)
      if (typeof s !== 'string') {
        seen.delete(obj)
        return s
      }
      parts.push(`${toJson(k)}:${s}`)
    }
    seen.delete(obj)
    return `{${parts.join(',')}}`
  }

  const json = walk(val, 0)
  if (json === null) {
    return {ok: false, reason: 'invalid'}
  }
  if (json === false) {
    return {ok: false, reason: 'max-bytes'}
  }
  const bytes = encodeBytes(json).byteLength
  return bytes > maxBytes
    ? {ok: false, reason: 'max-bytes'}
    : {ok: true, json, bytes}
}

export const hasFiniteNums = (val: unknown): boolean =>
  canonicalizeAndMeasureJson(val).ok

export const canonicalizeJson = (val: JsonValue): string => {
  const res = canonicalizeAndMeasureJson(val)
  return res.ok ? res.json : toJson(val)
}

export type MonotonicClock = {
  peek: () => number
  observe: (ts: number) => void
  next: (minTs?: number) => number
  nextBounded: (ns: string, maxSkewMs?: number) => number
}

export const createMonotonicClock = (initial = 0): MonotonicClock => {
  let last = initial
  return {
    peek: () => last,
    observe: ts => {
      if (ts > last) {
        last = ts
      }
    },
    next: (minTs = 0) => {
      const cand = Math.max(Date.now(), last + 1, minTs)
      return (last = cand)
    },
    nextBounded: (ns, maxSkewMs = defaultMaxClockSkewMs) => {
      const now = Date.now()
      const cand = Math.max(now, last + 1)
      if (cand > now + maxSkewMs) {
        throw mkErr(`state clock skew exceeded for "${ns}"`)
      }
      return (last = cand)
    }
  }
}

const signerClocks = /*@__PURE__*/ new WeakMap<object, MonotonicClock>()

export const getSignerClock = (signer: StateSigner): MonotonicClock => {
  const key = signer as object
  let clock = signerClocks.get(key)
  if (!clock) {
    clock = createMonotonicClock()
    signerClocks.set(key, clock)
  }
  return clock
}

export const roleCertPayload = (c: Omit<RoleCertificate, 'sig'>): string =>
  canonTag('role-cert', [
    c.v,
    c.certId,
    c.issuerPubKey,
    c.subUserId,
    c.appId,
    c.roomId,
    [...c.roles].sort(),
    c.iat
  ])

export type CertSignParams = {
  subUserId: string
  appId: string
  roomId: string
  roles: string[]
  now?: number
}

export const signRoleCertificate = async (
  signer: StateSigner,
  issuerPubJwk: JsonWebKey,
  p: CertSignParams
): Promise<RoleCertificate> => {
  const u: Omit<RoleCertificate, 'sig'> = {
    v: 1,
    certId: crypto.randomUUID(),
    issuerPubKey: jwkToCompactPub(issuerPubJwk),
    subUserId: p.subUserId,
    appId: p.appId,
    roomId: p.roomId,
    roles: [...new Set(p.roles)].sort(),
    iat: p.now ?? getSignerClock(signer).next()
  }
  return {...u, sig: await signWith(signer, roleCertPayload(u))}
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
    cert.iat > Date.now() + clockSkewMs
  ) {
    return {valid: false, roles: []}
  }
  const iss = await getVerifiedPubKeyRecord(cert.issuerPubKey)
  if (!iss || !rootUserIds.has(iss.userId)) {
    return {valid: false, roles: []}
  }
  return (await verifySig(cert.issuerPubKey, roleCertPayload(cert), cert.sig))
    ? {valid: true, roles: [...cert.roles]}
    : {valid: false, roles: []}
}

export const verifyRoleCertificateChain: typeof verifyRoleCertificate =
  verifyRoleCertificate

export type SlidingReplayWindow = {
  has: (key: string, seq: number) => boolean
  record: (key: string, seq: number) => boolean
  delete: (key: string) => void
  clear: () => void
}

type ReplayEntry = {
  maxSeq: number
  windowBits: bigint
  lastSeenAt: number
}

export const createSlidingReplayWindow = (
  maxKeys: number,
  isPinnedKey?: (key: string) => boolean,
  windowBits = 256n
): SlidingReplayWindow => {
  const windowMask = (1n << windowBits) - 1n
  const map = new Map<string, ReplayEntry>()

  const has = (key: string, seq: number): boolean => {
    const state = map.get(key)
    if (!state || seq > state.maxSeq) {
      return false
    }
    if (seq === state.maxSeq) {
      return true
    }
    const offset = BigInt(state.maxSeq - seq)
    if (offset >= windowBits) {
      return true
    }
    return (state.windowBits & (1n << offset)) !== 0n
  }

  const record = (key: string, seq: number): boolean => {
    const now = Date.now()
    const state = map.get(key)
    if (!state) {
      if (map.size >= maxKeys) {
        if (isPinnedKey) {
          let oldestKey: string | null = null
          let oldestTime = Infinity
          for (const [k, v] of map.entries()) {
            if (!isPinnedKey(k) && v.lastSeenAt < oldestTime) {
              oldestTime = v.lastSeenAt
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
      map.set(key, {maxSeq: seq, windowBits: 1n, lastSeenAt: now})
      return true
    }

    if (seq > state.maxSeq) {
      const shift = BigInt(seq - state.maxSeq)
      state.windowBits =
        shift >= windowBits
          ? 1n
          : ((state.windowBits << shift) | 1n) & windowMask
      state.maxSeq = seq
      state.lastSeenAt = now
      return true
    }

    if (seq === state.maxSeq) {
      return false
    }

    const offset = BigInt(state.maxSeq - seq)
    if (offset >= windowBits) {
      return false
    }
    const bit = 1n << offset
    if ((state.windowBits & bit) !== 0n) {
      return false
    }
    state.windowBits |= bit
    state.lastSeenAt = now
    return true
  }

  return {
    has,
    record,
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
    {tokens: number; lastRefillMs: number}
  >(maxKeys)

  return {
    consume: (key, cost = 1) => {
      const now = Date.now()
      const cur = buckets.get(key)
      if (!cur) {
        if (burst < cost) {
          return false
        }
        buckets.set(key, {tokens: burst - cost, lastRefillMs: now})
        return true
      }
      const elapsedSec = Math.max(0, now - cur.lastRefillMs) / 1_000
      if (elapsedSec > 0) {
        cur.tokens = Math.min(burst, cur.tokens + elapsedSec * ratePerSec)
        cur.lastRefillMs = now
      }
      if (cur.tokens < cost) {
        return false
      }
      cur.tokens -= cost
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
