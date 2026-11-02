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

/**
 * Returns `[canonicalJson, utf8ByteLength]` on success, `0` for invalid JSON,
 * or `1` when exceeding `maxBytes`.
 */
export const canonicalizeAndMeasureJson = (
  val: unknown,
  maxBytes: number = Number.POSITIVE_INFINITY
): readonly [json: string, bytes: number] | 0 | 1 => {
  let minBytes = 0
  const seen = new Set<object>()
  const addMin = (n: number): boolean => (minBytes += n) <= maxBytes

  const walk = (v: unknown, depth: number): string | false | null => {
    if (depth > maxJsonDepth) {
      return null
    }
    if (v === null || typeof v === 'boolean') {
      const s = String(v)
      return addMin(s.length) ? s : false
    }
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) {
        return null
      }
      const s = toJson(v)
      return addMin(s.length) ? s : false
    }
    if (typeof v === 'string') {
      return addMin(v.length + 2) ? toJson(v) : false
    }
    if (typeof v !== 'object') {
      return null
    }
    const obj = v as object
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
    const items = isArr ? obj : keys(obj as Record<string, unknown>).sort()
    if (
      !addMin(2 + Math.max(0, isArr ? items.length - 1 : items.length * 2 - 1))
    ) {
      return false
    }
    seen.add(obj)
    try {
      const parts: string[] = []
      for (let i = 0; i < items.length; i++) {
        let elem = items[i]
        let prefix = ''
        if (!isArr) {
          const k = elem as string
          elem = (obj as Record<string, unknown>)[k]
          if (elem === undefined) {
            return null
          }
          if (!addMin(k.length + 2)) {
            return false
          }
          prefix = `${toJson(k)}:`
        }
        const s = walk(elem, depth + 1)
        if (typeof s !== 'string') {
          return s
        }
        parts.push(prefix + s)
      }
      return isArr ? `[${parts.join(',')}]` : `{${parts.join(',')}}`
    } finally {
      seen.delete(obj)
    }
  }

  const json = walk(val, 0)
  if (json === null) {
    return 0
  }
  if (json === false) {
    return 1
  }
  const bytes = encodeBytes(json).byteLength
  return bytes > maxBytes ? 1 : [json, bytes]
}

export const hasFiniteNums = (val: unknown): boolean =>
  Array.isArray(canonicalizeAndMeasureJson(val))

export const canonicalizeJson = (val: JsonValue): string => {
  const res = canonicalizeAndMeasureJson(val)
  return Array.isArray(res) ? res[0] : toJson(val)
}

export type MonotonicClock = readonly [
  peek: () => number,
  observe: (ts: number) => void,
  next: (minTs?: number) => number,
  nextBounded: (ns: string, maxSkewMs?: number) => number
]

export const createMonotonicClock = (initial = 0): MonotonicClock => {
  let last = initial
  return [
    () => last,
    ts => {
      if (ts > last) {
        last = ts
      }
    },
    (minTs = 0) => (last = Math.max(Date.now(), last + 1, minTs)),
    (ns, maxSkewMs = defaultMaxClockSkewMs) => {
      const now = Date.now()
      const cand = Math.max(now, last + 1)
      if (cand > now + maxSkewMs) {
        throw mkErr(`state clock skew exceeded for "${ns}"`)
      }
      return (last = cand)
    }
  ]
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
  const u: Omit<RoleCertificate, 'sig'> = {
    v: 1,
    certId: crypto.randomUUID(),
    issuerPubKey: jwkToCompactPub(issuerPubJwk),
    subUserId,
    appId,
    roomId,
    roles: [...new Set(roles)].sort(),
    iat
  }
  return {...u, sig: await signWith(signer, roleCertPayload(u))}
}

export const signRoleCertificate = (
  signer: StateSigner,
  issuerPubJwk: JsonWebKey,
  p: CertSignParams
): Promise<RoleCertificate> =>
  signRoleCertInternal(
    signer,
    issuerPubJwk,
    p.subUserId,
    p.appId,
    p.roomId,
    p.roles,
    p.now ?? getSignerClock(signer)[2]()
  )

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
    return invalidRoles()
  }
  const iss = await getVerifiedPubKeyRecord(cert.issuerPubKey)
  if (!iss || !rootUserIds.has(iss[6])) {
    return invalidRoles()
  }
  return (await verifySig(cert.issuerPubKey, roleCertPayload(cert), cert.sig))
    ? {valid: true, roles: [...cert.roles]}
    : invalidRoles()
}

export const verifyRoleCertificateChain: typeof verifyRoleCertificate =
  verifyRoleCertificate

export type SlidingReplayWindow = readonly [
  has: (key: string, seq: number) => boolean,
  record: (key: string, seq: number) => boolean,
  del: (key: string) => void,
  clear: () => void
]

type ReplayEntry = [maxSeq: number, windowBits: bigint, lastSeenAt: number]

export const createSlidingReplayWindow = (
  maxKeys: number,
  isPinnedKey?: (key: string) => boolean,
  windowBits = 256n
): SlidingReplayWindow => {
  const windowMask = (1n << windowBits) - 1n
  const map = new Map<string, ReplayEntry>()

  return [
    (key, seq) => {
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
    (key, seq) => {
      const now = Date.now()
      const state = map.get(key)
      if (!state) {
        if (map.size >= maxKeys) {
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
    key => {
      map.delete(key)
    },
    () => {
      map.clear()
    }
  ]
}

export type TokenBucketLimiter = readonly [
  consume: (key: string, cost?: number) => boolean,
  del: (key: string) => void,
  clear: () => void
]

export const createTokenBucketLimiter = (
  ratePerSec: number,
  burst: number,
  maxKeys = 512
): TokenBucketLimiter => {
  const buckets = createBoundedCache<
    string,
    [tokens: number, lastRefillMs: number]
  >(maxKeys)

  return [
    (key, cost = 1) => {
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
    key => {
      buckets.delete(key)
    },
    () => {
      buckets.clear()
    }
  ]
}
