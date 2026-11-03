import {createEventEmitter, initSingleHandler} from './emitter'
import type {KernelRoomErrorInput} from './internal-types'
import {
  base62Alphabet,
  createBoundedCache,
  createBoundedSet,
  decodeBytes,
  domainTag,
  encodeBytes,
  fromBase64,
  fromBase64Url,
  fromJson,
  hash32,
  libId,
  libName,
  mkErr,
  toBase64,
  toBase64Url,
  toJson,
  userIdLength
} from './primitives'
import type {DataPayload, RoleCertificate} from './types'

export {
  createBoundedCache,
  createBoundedSet,
  createEventEmitter,
  decodeBytes,
  domainTag,
  encodeBytes,
  fromBase64,
  fromBase64Url,
  fromJson,
  initSingleHandler,
  libId,
  libName,
  mkErr,
  toBase64,
  toBase64Url,
  toJson
}

export const lockMethods = <T extends object>(
  target: T,
  methodNames: readonly (keyof T & string)[]
): T => {
  for (const name of methodNames) {
    const fn = target[name]
    Object.defineProperty(target, name, {
      get: () => fn,
      set: () => {
        throw new TypeError(
          `${libName}: ${name} is a method; call ${name}(handler), which returns an unsubscribe function`
        )
      },
      enumerable: true,
      configurable: true
    })
  }
  return target
}

export const authMetaKey: string = `__${libId}Auth`
export const cmpStr = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0
export const internalActionPrefix = '@_'

export const warn = (msg: string): void => console.warn(`${libName}: ${msg}`)

export const warnNoPeer = (id: string): void =>
  warn(`no peer with id ${id} found`)

export const warnEphemeralAdmin = (): void =>
  warn(
    "roles({selfAsAdmin: true}) with an ephemeral identity orphans the room on close; use identity: 'local' or an imported UserIdentity"
  )

export const logErr = (kind: string, err: unknown): void =>
  console.error(`${libName} ${kind} error:`, err)

export const logActionHandlerErr = (err: unknown): void =>
  logErr('action handler', err)

export const peerDisconnectedMsg = 'peer disconnected'
export const peerDisconnectedErr: Error =
  /*@__PURE__*/ mkErr(peerDisconnectedMsg)
export const peerBannedMsg = 'peer banned'
export const peerBannedErr: Error = /*@__PURE__*/ mkErr(peerBannedMsg)
export const mkBannedErr = (
  reason?: string,
  peerId?: string
): KernelRoomErrorInput => ({
  code: 'banned',
  message: reason ? `${peerBannedMsg}: ${reason}` : peerBannedMsg,
  ...(reason !== undefined ? {reason} : {}),
  ...(peerId ? {peerId} : {})
})
export const peerLeftRoomErr: Error = /*@__PURE__*/ mkErr('peer left room')
export const roomLeftErr: Error = /*@__PURE__*/ mkErr('room left')
export const roomFullMsg = 'room full'
export const roomFullErr: Error = /*@__PURE__*/ mkErr(roomFullMsg)
export const operationAbortedMsg = 'operation aborted'
export const insufficientAuthPrefix = 'insufficient authority'
export const invalidP256KeyErr: Error = /*@__PURE__*/ mkErr(
  'invalid ECDSA P-256 public key'
)

export const posSafeIntErr = (name: string): Error =>
  mkErr(`${name} must be a positive safe integer`)

export const requiresRolesErr = (feature: string): Error =>
  mkErr(`${feature} requires roles() in joinRoom config`)

export const selfCertRoomRolesErr: Error = /*@__PURE__*/ requiresRolesErr(
  'self-certifying room ID'
)

export const actionRedefinedErr = (type: string): Error =>
  mkErr(`action type "${type}" cannot be redefined`)

export const invalidActionMsg = (what: string): string =>
  `invalid action ${what}`

export const noActivePeerMsg = (id: string): string =>
  `no active peer with id ${id}`

export const requiredErr = (field: string): Error =>
  mkErr(`${field} is required`)

const {floor} = Math

export const alloc = <T>(n: number, f: (v: undefined, i: number) => T): T[] =>
  Array(n).fill(undefined).map(f)

const base62UnbiasedLimit = 248 // 62 * 4 (largest multiple of 62 <= 256)

export const genId = (n: number): string => {
  if (n <= 0) {
    return ''
  }
  const buf = new Uint8Array(Math.ceil(n * 1.15) + 4)
  let out = ''
  while (out.length < n) {
    crypto.getRandomValues(buf)
    for (let i = 0; i < buf.byteLength && out.length < n; i++) {
      const b = buf[i]!
      if (b < base62UnbiasedLimit) {
        out += base62Alphabet[b % 62]!
      }
    }
  }
  return out
}

export const all: typeof Promise.all = /*@__PURE__*/ Promise.all.bind(Promise)

export const isBrowser: boolean = typeof window !== 'undefined'

export const entries: typeof Object.entries = Object.entries
export const fromEntries: typeof Object.fromEntries = Object.fromEntries
export const keys: typeof Object.keys = Object.keys
export const values: typeof Object.values = Object.values

export const noOp = (): void => {}

export const candidateType = 'candidate'

export const resetTimer = (
  timer: ReturnType<typeof setTimeout> | null | undefined
): null => {
  if (timer !== null && timer !== undefined) {
    clearTimeout(timer)
  }

  return null
}

export const unrefTimer = (t: unknown): void => {
  ;(t as {unref?: () => void})?.unref?.()
}

export const toErrorMessage = (reason: unknown, fallback: string): string => {
  if (reason instanceof Error && reason.message) {
    return reason.message
  }

  if (typeof reason === 'string' && reason) {
    return reason
  }

  return toJson(reason ?? fallback)
}

export const toError = (reason: unknown, fallback: string): Error =>
  reason instanceof Error ? reason : mkErr(toErrorMessage(reason, fallback))

export const topicPath = (...parts: string[]): string => toJson(parts)

export const shuffle = <T>(xs: readonly T[], seed: number): T[] => {
  const a = [...xs]
  let state = (Math.trunc(seed) || 1) >>> 0
  const rand = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000
  }

  let i = a.length

  while (i) {
    const j = floor(rand() * i--)
    const tmp = a[i]
    a[i] = a[j] as T
    a[j] = tmp as T
  }

  return a
}

export const strToNum = (
  str: string,
  limit: number = Number.MAX_SAFE_INTEGER
): number => hash32(str) % limit

export const userIdRegex: RegExp = /*@__PURE__*/ new RegExp(
  `^[0-9A-Za-z]{${userIdLength}}$`
)

export const selfCertifyingRoomRegex: RegExp = /*@__PURE__*/ new RegExp(
  `^(.+)~([0-9A-Za-z]{${userIdLength}})$`
)

export const toPayloadSource = (
  data: DataPayload
): readonly [format: 0 | 1 | 2, source: Blob | Uint8Array] => {
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return [2, data]
  }
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    return [
      2,
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    ]
  }
  const isText = typeof data === 'string'
  return [isText ? 0 : 1, encodeBytes(isText ? data : toJson(data))]
}

export const hasIceUrl = (
  servers: readonly RTCIceServer[],
  pattern: RegExp
): boolean =>
  servers.some(({urls}) => [urls].flat().some(url => pattern.test(url)))

export const isObj = (v: unknown): v is Record<string, unknown> =>
  Boolean(v && typeof v === 'object' && !Array.isArray(v))

export const isStr = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0

export const isPosSafeInt = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n > 0

export const isValidSig = (s: unknown): s is string =>
  typeof s === 'string' && s.length >= 64 && s.length <= 128

export const validateRoleCertificateShape = (
  c: unknown
): c is RoleCertificate =>
  isObj(c) &&
  c['v'] === 1 &&
  isStr(c['certId']) &&
  isStr(c['issuerPubKey']) &&
  isStr(c['subUserId']) &&
  isStr(c['appId']) &&
  isStr(c['roomId']) &&
  Array.isArray(c['roles']) &&
  c['roles'].length > 0 &&
  c['roles'].every(isStr) &&
  isPosSafeInt(c['iat']) &&
  isValidSig(c['sig'])

export type WindowCounter = readonly [
  hit: (id: string) => boolean,
  reset: (id: string) => void,
  over: (id: string) => boolean
]

export const createWindowCounter = (
  maxEntries: number,
  limit: number,
  windowMs = 30_000
): WindowCounter => {
  const map = createBoundedCache<string, [n: number, t: number]>(maxEntries)
  return [
    id => {
      const now = Date.now()
      let cur = map.get(id)
      if (!cur || now - cur[1] > windowMs) {
        cur = [0, now]
        map.set(id, cur)
      }
      return ++cur[0] >= limit
    },
    id => {
      map.delete(id)
    },
    id => {
      const cur = map.get(id)
      return Boolean(cur && Date.now() - cur[1] <= windowMs && cur[0] >= limit)
    }
  ]
}
