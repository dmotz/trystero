import {ecdsaSign, hash32, normalizeLowSP256Signature} from './crypto'
import {
  getVerifiedPubKeyRecord,
  isValidUserId,
  pubJwkToUncompressedBytes,
  verifyWithP256
} from './identity'
import {isValidSignalPeerId} from './signal-handler'
import type {
  ActionOptions,
  AuthoritativeStateRecord,
  DataPayload,
  InternalAction,
  JsonValue,
  KernelRolesProvider,
  KernelScaleProvider,
  MaybePromise,
  ReplayListenerOptions,
  RoleCertificate,
  SharedState,
  StateChangeContext,
  StateConfig,
  UserIdentity,
  UserState,
  UserStateChangeContext,
  UserStateConfig,
  UserStateGetAllOptions,
  Widen
} from './types'
import {
  createBoundedCache,
  createBoundedSet,
  createEventEmitter,
  encodeBytes,
  entries,
  fromBase64Url,
  insufficientAuthPrefix,
  keys,
  lockMethods,
  mkErr,
  noOp,
  posSafeIntErr,
  requiresRolesErr,
  resetTimer,
  toBase64Url,
  toJson
} from './utils'

export type StateSigner =
  | CryptoKey
  | ((payload: Uint8Array) => MaybePromise<Uint8Array>)

export const defaultMaxClockSkewMs = 60_000
export const defaultMaxStateBytes: number = 16 * 1024
export const maxAllowedStateBytes: number = 64 * 1024
export const maxUserStateNamespacesPerUser = 32
export const maxUserStateBytesPerUser: number = 64 * 1024
export const maxUnregisteredSlots = 256
export const maxUnregisteredBytes: number = 2 * 1024 * 1024
export const defaultRetainTtlMs = 86_400_000
export const defaultRetainMaxUsers = 256

const maxLiveRecordsPerSec = 20
const maxLiveRecordBurst = 25
const maxSyncRecordsPerBatch = 1_024
const maxUnregisteredCandidatesPerSharedNs = 4
const syncPullFanout = 2
const syncPullTimeoutMs = 1_500
const maxTimerDelayMs = 2_147_483_647

const allowedRecordKeys = new Set([
  'v',
  'k',
  'appId',
  'roomId',
  'ns',
  'hlc',
  'peerId',
  'userId',
  'pub',
  'val',
  'del',
  'ret',
  'cert',
  'sig'
])

const isObj = (v: unknown): v is Record<string, unknown> =>
  Boolean(v && typeof v === 'object' && !Array.isArray(v))

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0

const isPosSafeInt = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n > 0

const isValidSig = (s: unknown): s is string =>
  typeof s === 'string' && s.length >= 64 && s.length <= 128

export const hasFiniteNums = (
  v: unknown,
  d = 0,
  seen: Set<object> = new Set<object>()
): boolean => {
  if (d > 64) {
    return false
  }
  if (v === null || typeof v === 'string' || typeof v === 'boolean') {
    return true
  }
  if (typeof v === 'number') {
    return Number.isFinite(v)
  }
  if (typeof v !== 'object' || seen.has(v)) {
    return false
  }
  seen.add(v)
  const list = Array.isArray(v) ? v : isObj(v) ? Object.values(v) : null
  return Boolean(list?.every(x => hasFiniteNums(x, d + 1, seen)))
}

export const canonicalizeJson = (val: JsonValue): string =>
  val === null || typeof val !== 'object'
    ? toJson(val)
    : Array.isArray(val)
      ? `[${val.map(canonicalizeJson).join(',')}]`
      : `{${keys(val)
          .sort()
          .map(k => `${toJson(k)}:${canonicalizeJson(val[k] as JsonValue)}`)
          .join(',')}}`

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

export const verifySig = async (
  pub: JsonWebKey | string,
  payload: string,
  sig: string
): Promise<boolean> => {
  try {
    return await verifyWithP256(fromBase64Url(sig), encodeBytes(payload), pub)
  } catch {
    return false
  }
}

export const jwkToCompactPub = (jwk: JsonWebKey): string => {
  if (!pubJwkToUncompressedBytes(jwk) || !jwk.x || !jwk.y) {
    throw mkErr('invalid P-256 public key')
  }
  return `${jwk.x}.${jwk.y}`
}

export const compactPubToJwk = (pub: string): JsonWebKey | null => {
  if (typeof pub !== 'string' || pub.length !== 87 || pub[43] !== '.') {
    return null
  }
  const jwk: JsonWebKey = {
    crv: 'P-256',
    kty: 'EC',
    x: pub.slice(0, 43),
    y: pub.slice(44)
  }
  return pubJwkToUncompressedBytes(jwk) ? jwk : null
}

const isCertLike = (c: unknown): c is RoleCertificate =>
  isObj(c) &&
  c['v'] === 1 &&
  isStr(c['certId']) &&
  isStr(c['issuerPubKey']) &&
  isValidUserId(c['subUserId'] as string) &&
  isStr(c['appId']) &&
  isStr(c['roomId']) &&
  Array.isArray(c['roles']) &&
  c['roles'].length > 0 &&
  c['roles'].every(isStr) &&
  isPosSafeInt(c['iat']) &&
  isValidSig(c['sig'])

export const stateRecordPayload = (
  r: Omit<AuthoritativeStateRecord, 'sig'>
): string =>
  toJson([
    'trystero:state:v1',
    r.v,
    r.k,
    r.appId,
    r.roomId,
    r.ns,
    r.hlc,
    r.peerId,
    r.userId,
    r.pub,
    r.del ? null : canonicalizeJson((r.val ?? null) as JsonValue),
    r.del === true ? 1 : 0,
    r.ret ?? 0,
    r.cert?.sig ?? ''
  ])

export const validateStateRecordShape = (
  r: unknown
): r is AuthoritativeStateRecord => {
  if (!isObj(r)) {
    return false
  }
  for (const k of keys(r)) {
    if (!allowedRecordKeys.has(k)) {
      return false
    }
  }
  if (
    r['v'] !== 1 ||
    (r['k'] !== 's' && r['k'] !== 'u') ||
    !isStr(r['appId']) ||
    !isStr(r['roomId']) ||
    !isStr(r['ns']) ||
    (r['ns'] as string).length > 256 ||
    !isPosSafeInt(r['hlc']) ||
    !isValidSignalPeerId(r['peerId']) ||
    !isValidUserId(r['userId'] as string) ||
    typeof r['pub'] !== 'string' ||
    !compactPubToJwk(r['pub']) ||
    !isValidSig(r['sig'])
  ) {
    return false
  }
  if (r['del'] !== undefined) {
    if (r['del'] !== true || r['k'] !== 'u' || r['val'] !== undefined) {
      return false
    }
  } else if (
    !('val' in r) ||
    r['val'] === undefined ||
    !hasFiniteNums(r['val'])
  ) {
    return false
  }
  if (r['ret'] !== undefined && (r['k'] !== 'u' || !isPosSafeInt(r['ret']))) {
    return false
  }
  if (r['cert'] !== undefined && !isCertLike(r['cert'])) {
    return false
  }
  return true
}

export type StateSignParams<T = JsonValue> = {
  kind?: 's' | 'u'
  appId: string
  roomId: string
  ns: string
  hlc?: number
  peerId: string
  userId: string
  val?: T
  del?: true
  ret?: number
  cert?: RoleCertificate | null
}

export const signStateRecord = async <T = JsonValue>(
  signer: StateSigner,
  pubJwk: JsonWebKey,
  p: StateSignParams<T>
): Promise<AuthoritativeStateRecord<T>> => {
  const k = p.kind ?? 's'
  const u: Omit<AuthoritativeStateRecord<T>, 'sig'> = {
    v: 1,
    k,
    appId: p.appId,
    roomId: p.roomId,
    ns: p.ns,
    hlc: p.hlc ?? Date.now(),
    peerId: p.peerId,
    userId: p.userId,
    pub: jwkToCompactPub(pubJwk),
    ...(p.del === true ? {del: true as const} : {val: p.val as T}),
    ...(p.ret !== undefined ? {ret: p.ret} : {}),
    ...(p.cert ? {cert: p.cert} : {})
  }
  const canon = stateRecordPayload(u as Omit<AuthoritativeStateRecord, 'sig'>)
  const sig = await signWith(signer, canon)
  return {...u, sig}
}

export const verifyStateRecordSignature = async (
  rec: AuthoritativeStateRecord,
  appId: string,
  roomId: string,
  clockSkewMs: number = defaultMaxClockSkewMs,
  sigCache?: {has: (value: string) => boolean; add: (value: string) => boolean}
): Promise<boolean> => {
  if (
    !validateStateRecordShape(rec) ||
    rec.appId !== appId ||
    rec.roomId !== roomId ||
    rec.hlc > Date.now() + clockSkewMs
  ) {
    return false
  }
  if (
    rec.cert &&
    (rec.cert.subUserId !== rec.userId || rec.hlc < rec.cert.iat)
  ) {
    return false
  }
  const jwk = compactPubToJwk(rec.pub)
  if (!jwk) {
    return false
  }
  const signer = await getVerifiedPubKeyRecord(jwk)
  if (!signer || signer.userId !== rec.userId) {
    return false
  }
  const canon = stateRecordPayload(rec)
  const cacheKey = `${canon}\u0000${rec.sig}`
  if (sigCache?.has(cacheKey)) {
    return true
  }
  const ok = await verifySig(jwk, canon, rec.sig)
  if (ok) {
    sigCache?.add(cacheKey)
  }
  return ok
}

export const compareStateRecords = (
  a: AuthoritativeStateRecord,
  b: AuthoritativeStateRecord
): number => {
  if (a.hlc !== b.hlc) {
    return a.hlc - b.hlc
  }
  const au = a.userId || a.peerId
  const bu = b.userId || b.peerId
  if (au !== bu) {
    return au < bu ? -1 : 1
  }
  if (a.peerId !== b.peerId) {
    return a.peerId < b.peerId ? -1 : 1
  }
  return a.sig < b.sig ? -1 : a.sig > b.sig ? 1 : 0
}

type WireStateRecord = Omit<
  AuthoritativeStateRecord,
  'appId' | 'roomId' | 'pub'
> & {
  pub?: string
}

type DigestEntry = [hlc: number, sig8: string]

type StateControlMessage =
  | {t: 'rec'; r: WireStateRecord; f?: 1}
  | {t: 'pull'; d: Record<string, DigestEntry>}
  | {
      t: 'sync'
      p: Record<string, string>
      r: WireStateRecord[]
      w?: string[]
    }
  | {
      t: 'push'
      p: Record<string, string>
      r: WireStateRecord[]
    }

type PreJoinUserPayload = {
  p: Record<string, string>
  r: WireStateRecord[]
}

type PendingSharedOp<T = JsonValue> = {
  nextOrFn: T | ((prev: T) => T)
  resolve: () => void
  reject: (err: unknown) => void
}

type PendingUserOp<T = JsonValue> =
  | {
      kind: 'set'
      nextOrFn: T | ((prev: T) => T)
      resolve: () => void
      reject: (err: unknown) => void
    }
  | {
      kind: 'clear'
      resolve: () => void
      reject: (err: unknown) => void
    }

type SharedSlot = {
  namespace: string
  initialValue: JsonValue
  value: JsonValue
  prevValue: JsonValue
  record: AuthoritativeStateRecord | null
  roles: string[]
  requiredRoles: string[] | null
  maxBytes: number
  validate?: ((next: JsonValue, ctx: StateChangeContext) => boolean) | undefined
  emitChange: (val: JsonValue, ctx: StateChangeContext) => void
  clearListeners: () => void
  api: SharedState<JsonValue>
  pendingOps: PendingSharedOp[]
  flushing: boolean
}

type UserSlotEntry = {
  record: AuthoritativeStateRecord
  value: JsonValue
  prevValue: JsonValue
  roles: string[]
  byteLength: number
  expiresAt: number | null
  lastTouched: number
}

type UserTombstone = {
  record: AuthoritativeStateRecord
  byteLength: number
  expiresAt: number
}

type UserSlot = {
  namespace: string
  initialValue: JsonValue
  requiredRoles: string[] | null
  maxBytes: number
  retain: {ttlMs: number; maxUsers: number} | null
  validate?:
    | ((next: JsonValue, ctx: UserStateChangeContext) => boolean)
    | undefined
  entries: Map<string, UserSlotEntry>
  tombstones: Map<string, UserTombstone>
  snapshotAll: Readonly<Record<string, JsonValue>> | null
  snapshotOnline: Readonly<Record<string, JsonValue>> | null
  emitChange: (val: JsonValue | undefined, ctx: UserStateChangeContext) => void
  clearListeners: () => void
  api: UserState<JsonValue>
  pendingOps: PendingUserOp[]
  flushing: boolean
  activeFlushP: Promise<void> | null
}

type UnregisteredCandidate = {
  record: AuthoritativeStateRecord
  roles: string[]
  byteLength: number
  expiresAt: number | null
  lastTouched: number
}

type UnregisteredSlot =
  | {
      kind: 's'
      namespace: string
      candidates: UnregisteredCandidate[]
      totalBytes: number
    }
  | {
      kind: 'u'
      namespace: string
      byUser: Map<string, UnregisteredCandidate>
      totalBytes: number
    }

type StagedRecord = {
  record: AuthoritativeStateRecord
  roles: string[]
  byteLength: number
}

export type StateManagerDeps = {
  appId: string
  getRoomId: () => string
  getSelfId: () => string
  getLocalUserId: () => string
  ensureReady: () => Promise<{
    selfId: string
    user: UserIdentity
    roomId: string
  }>
  hasRolesPlugin: () => boolean
  getRolesProvider: () => KernelRolesProvider | null
  getScaleProvider?: () => KernelScaleProvider | null
  maxClockSkewMs?: number | undefined
  isPeerActive: (peerId: string) => boolean
  isDirectPeer: (peerId: string) => boolean
  getDirectPeerIds: () => string[]
  isUserOnline: (userId: string) => boolean
  getKnownPeerUserId: (peerId: string) => string | undefined
  isPeerBanned: (peerOrUserId: string) => boolean
  getPeerRoles: (peerOrUserId?: string) => string[]
  makeInternalAction?: <T extends DataPayload = DataPayload>(
    namespace: string,
    options?: Partial<ActionOptions>
  ) => InternalAction<T>
  onBroadcastRecord?: (rec: AuthoritativeStateRecord) => void
  onInvalidRecord?: (fromPeerId?: string) => void
}

export type StateManager = {
  makeState: RoomMakeState
  makeUserState: RoomMakeUserState
  verifyAndApplyStateRecord: (
    rec: AuthoritativeStateRecord,
    fromPeerId?: string
  ) => Promise<boolean>
  sendPreJoinUserState: (peerId: string) => Promise<void> | undefined
  getPendingPreJoin: (peerId: string) => Promise<void> | undefined
  onPeerJoined: (peerId: string, userId: string, isDirect: boolean) => void
  onPeerDisconnected: (peerId: string) => void
  onUserLeft: (userId: string) => void
  purgeBannedUser: (userId: string) => void
  clearPeer: (peerId: string) => void
  destroy: () => void
}

type RoomMakeState = <T extends JsonValue = JsonValue>(
  namespace: string,
  initialValue?: T | null,
  config?: StateConfig<Widen<T>>
) => SharedState<Widen<T>>

type RoomMakeUserState = <T extends JsonValue = JsonValue>(
  namespace: string,
  initialValue?: T | null,
  config?: UserStateConfig<Widen<T>>
) => UserState<Widen<T>>

const measureRecordBytes = (rec: AuthoritativeStateRecord): number =>
  rec.del ? 32 : encodeBytes(toJson(rec.val ?? null)).byteLength

const toWireRecord = (
  rec: AuthoritativeStateRecord,
  includePub: boolean
): WireStateRecord => ({
  v: rec.v,
  k: rec.k,
  ns: rec.ns,
  hlc: rec.hlc,
  peerId: rec.peerId,
  userId: rec.userId,
  ...(includePub ? {pub: rec.pub} : {}),
  ...(rec.val !== undefined ? {val: rec.val} : {}),
  ...(rec.del === true ? {del: true} : {}),
  ...(rec.ret !== undefined ? {ret: rec.ret} : {}),
  ...(rec.cert !== undefined ? {cert: rec.cert} : {}),
  sig: rec.sig
})

const fromWireRecord = (
  raw: unknown,
  appId: string,
  roomId: string,
  pubMap?: Record<string, unknown>
): AuthoritativeStateRecord | null => {
  if (!isObj(raw)) {
    return null
  }
  for (const k of keys(raw)) {
    if (!allowedRecordKeys.has(k) || k === 'appId' || k === 'roomId') {
      return null
    }
  }
  const uid = raw['userId']
  const pub =
    typeof raw['pub'] === 'string'
      ? raw['pub']
      : typeof uid === 'string' && pubMap && typeof pubMap[uid] === 'string'
        ? (pubMap[uid] as string)
        : ''
  return {
    v: raw['v'] as 1,
    k: raw['k'] as 's' | 'u',
    appId,
    roomId,
    ns: raw['ns'] as string,
    hlc: raw['hlc'] as number,
    peerId: raw['peerId'] as string,
    userId: uid as string,
    pub,
    ...(raw['val'] !== undefined ? {val: raw['val'] as JsonValue} : {}),
    ...(raw['del'] === true ? {del: true as const} : {}),
    ...(raw['ret'] !== undefined ? {ret: raw['ret'] as number} : {}),
    ...(raw['cert'] !== undefined
      ? {cert: raw['cert'] as RoleCertificate}
      : {}),
    sig: raw['sig'] as string
  }
}

const validateMaxBytesOpt = (
  maxBytes: number | undefined,
  label: string
): number => {
  if (maxBytes === undefined) {
    return defaultMaxStateBytes
  }
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > maxAllowedStateBytes
  ) {
    throw mkErr(
      `${label} maxBytes must be a positive integer <= ${maxAllowedStateBytes}`
    )
  }
  return maxBytes
}

const normalizeRequiredRoles = (
  rolesOpt: string | readonly string[] | undefined,
  rolesLoaded: boolean,
  defaultClosed: boolean,
  featureLabel: string
): string[] | null => {
  if (rolesOpt !== undefined && !rolesLoaded) {
    throw requiresRolesErr(featureLabel)
  }
  if (!rolesLoaded) {
    return null
  }
  if (rolesOpt === undefined) {
    return defaultClosed ? ['admin'] : null
  }
  if (rolesOpt === '*' || (Array.isArray(rolesOpt) && rolesOpt.includes('*'))) {
    return null
  }
  const list = (Array.isArray(rolesOpt) ? rolesOpt : [rolesOpt]).filter(Boolean)
  if (list.length === 0) {
    throw mkErr(`${featureLabel} roles must not be empty; use "*" for open`)
  }
  return list
}

const isSubsetRoles = (
  sub: readonly string[],
  sup: readonly string[]
): boolean => sub.every(r => sup.includes(r))

export const createStateManager = (deps: StateManagerDeps): StateManager => {
  const sharedSlots = new Map<string, SharedSlot>()
  const userSlots = new Map<string, UserSlot>()
  const unregisteredSlots = new Map<string, UnregisteredSlot>()
  const userQuotaByUid = new Map<string, Map<string, number>>()
  const verifiedSigCache = createBoundedSet(1_024)
  const forwardedRecSigs = createBoundedSet(1_024)
  const peerRateBuckets = createBoundedCache<
    string,
    {tokens: number; lastRefillMs: number}
  >(512)
  const peerSyncCounts = createBoundedCache<
    string,
    {count: number; windowStart: number}
  >(512)

  const pendingPreJoinByPeer = new Map<string, Promise<void>>()
  const stagedPreJoinByPeer = new Map<string, StagedRecord[]>()
  const completedSyncPeers = new Set<string>()
  const inFlightPullTimers = new Map<string, ReturnType<typeof setTimeout>>()

  let unregisteredTotalBytes = 0
  let lastSeenHlc = 0
  let localPublishedUserCount = 0
  let expiryTimer: ReturnType<typeof setTimeout> | null = null
  let nextScheduledExpiryAt = Number.POSITIVE_INFINITY
  let destroyed = false

  const getMaxClockSkewMs = (): number =>
    deps.maxClockSkewMs ??
    deps.getRolesProvider()?.getMaxClockSkewMs?.() ??
    defaultMaxClockSkewMs

  const observeVerifiedHlc = (hlc: number): void => {
    if (hlc > lastSeenHlc) {
      lastSeenHlc = hlc
    }
  }

  const nextLocalHlc = (namespace: string): number => {
    const now = Date.now()
    const candidate = Math.max(now, lastSeenHlc + 1)
    if (candidate > now + getMaxClockSkewMs()) {
      throw mkErr(`state clock skew exceeded for "${namespace}"`)
    }
    lastSeenHlc = candidate
    return candidate
  }

  const checkUserQuota = (
    userId: string,
    ns: string,
    nextBytes: number
  ): boolean => {
    const nsMap = userQuotaByUid.get(userId)
    const prevBytes = nsMap?.get(ns) ?? 0
    if (
      nextBytes > 0 &&
      !nsMap?.has(ns) &&
      (nsMap?.size ?? 0) >= maxUserStateNamespacesPerUser
    ) {
      return false
    }
    let total = 0
    if (nsMap) {
      for (const b of nsMap.values()) {
        total += b
      }
    }
    return total - prevBytes + nextBytes <= maxUserStateBytesPerUser
  }

  const setUserQuota = (userId: string, ns: string, bytes: number): void => {
    let nsMap = userQuotaByUid.get(userId)
    if (bytes <= 0) {
      if (!nsMap) {
        return
      }
      nsMap.delete(ns)
      if (nsMap.size === 0) {
        userQuotaByUid.delete(userId)
      }
      return
    }
    if (!nsMap) {
      nsMap = new Map()
      userQuotaByUid.set(userId, nsMap)
    }
    nsMap.set(ns, bytes)
  }

  const touchUnregisteredSlot = (key: string, slot: UnregisteredSlot): void => {
    unregisteredSlots.delete(key)
    unregisteredSlots.set(key, slot)
  }

  const removeUnregisteredSlot = (
    key: string
  ): UnregisteredSlot | undefined => {
    const slot = unregisteredSlots.get(key)
    if (!slot) {
      return undefined
    }
    unregisteredSlots.delete(key)
    unregisteredTotalBytes = Math.max(
      0,
      unregisteredTotalBytes - slot.totalBytes
    )
    if (slot.kind === 'u') {
      for (const uid of slot.byUser.keys()) {
        if (!userSlots.has(slot.namespace)) {
          setUserQuota(uid, slot.namespace, 0)
        }
      }
    }
    return slot
  }

  const enforceUnregisteredCacheBounds = (): void => {
    while (
      unregisteredSlots.size > maxUnregisteredSlots ||
      unregisteredTotalBytes > maxUnregisteredBytes
    ) {
      const oldestKey = unregisteredSlots.keys().next().value
      if (oldestKey === undefined) {
        break
      }
      removeUnregisteredSlot(oldestKey)
    }
  }

  const scheduleExpiryTimer = (): void => {
    if (destroyed) {
      return
    }
    let earliest = Number.POSITIVE_INFINITY
    for (const slot of userSlots.values()) {
      for (const entry of slot.entries.values()) {
        if (entry.expiresAt !== null && entry.expiresAt < earliest) {
          earliest = entry.expiresAt
        }
      }
      for (const tomb of slot.tombstones.values()) {
        if (tomb.expiresAt < earliest) {
          earliest = tomb.expiresAt
        }
      }
    }
    for (const slot of unregisteredSlots.values()) {
      if (slot.kind === 'u') {
        for (const cand of slot.byUser.values()) {
          if (cand.expiresAt !== null && cand.expiresAt < earliest) {
            earliest = cand.expiresAt
          }
        }
      }
    }
    if (earliest === nextScheduledExpiryAt) {
      return
    }
    expiryTimer = resetTimer(expiryTimer)
    nextScheduledExpiryAt = earliest
    if (!Number.isFinite(earliest)) {
      return
    }
    const delay = Math.min(Math.max(1, earliest - Date.now()), maxTimerDelayMs)
    expiryTimer = setTimeout(() => {
      expiryTimer = null
      nextScheduledExpiryAt = Number.POSITIVE_INFINITY
      purgeExpiredEntries(Date.now())
    }, delay)
    ;(expiryTimer as {unref?: () => void}).unref?.()
  }

  const purgeExpiredEntries = (now = Date.now()): void => {
    const localUid = deps.getLocalUserId()
    for (const slot of userSlots.values()) {
      let mutated = false
      const evictedEvents: Array<[undefined, UserStateChangeContext]> = []
      for (const [uid, entry] of slot.entries.entries()) {
        if (entry.expiresAt !== null && entry.expiresAt <= now) {
          slot.entries.delete(uid)
          setUserQuota(uid, slot.namespace, 0)
          mutated = true
          evictedEvents.push([
            undefined,
            {
              prev: entry.value,
              peerId: entry.record.peerId,
              userId: uid,
              roles: [...entry.roles],
              timestamp: now,
              self: Boolean(localUid && uid === localUid),
              online: false,
              removed: true
            }
          ])
        }
      }
      for (const [uid, tomb] of slot.tombstones.entries()) {
        if (tomb.expiresAt <= now) {
          slot.tombstones.delete(uid)
          if (!slot.entries.has(uid)) {
            setUserQuota(uid, slot.namespace, 0)
          }
        }
      }
      if (mutated) {
        slot.snapshotAll = null
        slot.snapshotOnline = null
        for (const [val, ctx] of evictedEvents) {
          slot.emitChange(val, ctx)
        }
      }
    }
    for (const [key, slot] of unregisteredSlots.entries()) {
      if (slot.kind !== 'u') {
        continue
      }
      for (const [uid, cand] of slot.byUser.entries()) {
        if (cand.expiresAt !== null && cand.expiresAt <= now) {
          slot.byUser.delete(uid)
          slot.totalBytes = Math.max(0, slot.totalBytes - cand.byteLength)
          unregisteredTotalBytes = Math.max(
            0,
            unregisteredTotalBytes - cand.byteLength
          )
          setUserQuota(uid, slot.namespace, 0)
        }
      }
      if (slot.byUser.size === 0) {
        unregisteredSlots.delete(key)
      }
    }
    scheduleExpiryTimer()
  }

  const maybePurgeExpiredFast = (): void => {
    if (Date.now() >= nextScheduledExpiryAt) {
      purgeExpiredEntries(Date.now())
    }
  }

  const enforceOfflineMaxUsers = (slot: UserSlot): void => {
    if (!slot.retain) {
      return
    }
    const offlineEntries: Array<[string, UserSlotEntry]> = []
    for (const [uid, entry] of slot.entries.entries()) {
      if (!deps.isUserOnline(uid)) {
        offlineEntries.push([uid, entry])
      }
    }
    if (offlineEntries.length <= slot.retain.maxUsers) {
      return
    }
    offlineEntries.sort((a, b) => a[1].lastTouched - b[1].lastTouched)
    const toEvict = offlineEntries.length - slot.retain.maxUsers
    const localUid = deps.getLocalUserId()
    const now = Date.now()
    for (let i = 0; i < toEvict; i++) {
      const [uid, entry] = offlineEntries[i]!
      slot.entries.delete(uid)
      setUserQuota(uid, slot.namespace, 0)
      slot.snapshotAll = null
      slot.snapshotOnline = null
      slot.emitChange(undefined, {
        prev: entry.value,
        peerId: entry.record.peerId,
        userId: uid,
        roles: [...entry.roles],
        timestamp: now,
        self: Boolean(localUid && uid === localUid),
        online: false,
        removed: true
      })
    }
  }

  const toSharedCtx = <T = JsonValue>(
    rec: AuthoritativeStateRecord,
    prev: T,
    roles: string[]
  ): StateChangeContext<T> => ({
    prev,
    peerId: rec.peerId,
    userId: rec.userId,
    roles: [...roles],
    timestamp: rec.hlc
  })

  const toUserCtx = <T = JsonValue>(
    rec: AuthoritativeStateRecord,
    prev: T,
    roles: string[],
    removed: boolean
  ): UserStateChangeContext<T> => {
    const localUid = deps.getLocalUserId()
    return {
      prev,
      peerId: rec.peerId,
      userId: rec.userId,
      roles: [...roles],
      timestamp: rec.hlc,
      self: Boolean(localUid && rec.userId === localUid),
      online: deps.isUserOnline(rec.userId),
      removed
    }
  }

  const isRecordCurrentlyAuthorized = (
    rec: AuthoritativeStateRecord,
    requiredRoles: readonly string[] | null
  ): {ok: boolean; roles: string[]} => {
    if (deps.isPeerBanned(rec.userId)) {
      return {ok: false, roles: []}
    }
    const rolesProvider = deps.getRolesProvider()
    if (!requiredRoles) {
      return {
        ok: true,
        roles: rolesProvider ? rolesProvider.getPeerRoles(rec.userId) : []
      }
    }
    if (!rec.cert || !rolesProvider) {
      return {ok: false, roles: []}
    }
    const activeRoles = rolesProvider.getPeerRoles(rec.userId)
    const certRoles = rec.cert.roles.filter(r => activeRoles.includes(r))
    return {
      ok: requiredRoles.some(r => certRoles.includes(r)),
      roles: certRoles
    }
  }

  const stateAction = deps.makeInternalAction
    ? deps.makeInternalAction<JsonValue>('state', {
        maxPayloadBytes: 256 * 1024
      })
    : null

  const preJoinAction = deps.makeInternalAction
    ? deps.makeInternalAction<JsonValue>('ustate0', {
        sendToPending: true,
        receiveWhilePending: true,
        maxPayloadBytes: 128 * 1024
      })
    : null

  const broadcastLiveRecord = (rec: AuthoritativeStateRecord): void => {
    forwardedRecSigs.add(rec.sig)
    deps.onBroadcastRecord?.(rec)
    if (stateAction) {
      const msg: StateControlMessage = {t: 'rec', r: toWireRecord(rec, true)}
      void stateAction.send(msg as unknown as JsonValue).catch(noOp)
    }
  }

  const forwardAppliedRecordToOthers = (
    rec: AuthoritativeStateRecord,
    excludePeerId: string
  ): void => {
    if (!stateAction || forwardedRecSigs.has(rec.sig)) {
      return
    }
    forwardedRecSigs.add(rec.sig)
    const targets = deps
      .getDirectPeerIds()
      .filter(pid => pid !== excludePeerId && !deps.isPeerBanned(pid))
    if (targets.length > 0) {
      const msg: StateControlMessage = {
        t: 'rec',
        r: toWireRecord(rec, true),
        f: 1
      }
      void stateAction.send(msg as unknown as JsonValue, targets).catch(noOp)
    }
  }

  const verifyRecordCryptoAndRoles = async (
    rec: AuthoritativeStateRecord,
    requiredRoles: readonly string[] | null,
    fromPeerId?: string
  ): Promise<
    | {status: 'ok'; roles: string[]; byteLength: number}
    | {status: 'invalid'}
    | {status: 'dropped'}
  > => {
    const roomId = deps.getRoomId()
    const sigOk = await verifyStateRecordSignature(
      rec,
      deps.appId,
      roomId,
      getMaxClockSkewMs(),
      verifiedSigCache
    )
    if (!sigOk) {
      return {status: 'invalid'}
    }
    const byteLength = measureRecordBytes(rec)
    if (byteLength > maxAllowedStateBytes) {
      return {status: 'invalid'}
    }
    if (deps.isPeerBanned(rec.userId)) {
      return {status: 'dropped'}
    }
    const rolesProvider = deps.getRolesProvider()
    if (rolesProvider?.verifyStateRecordRoles) {
      const roleRes = await rolesProvider.verifyStateRecordRoles(
        rec,
        requiredRoles,
        fromPeerId
      )
      if (!roleRes.valid) {
        return {status: 'dropped'}
      }
      observeVerifiedHlc(rec.hlc)
      return {status: 'ok', roles: roleRes.roles, byteLength}
    }
    if (requiredRoles && requiredRoles.length > 0) {
      return {status: 'dropped'}
    }
    observeVerifiedHlc(rec.hlc)
    return {status: 'ok', roles: [], byteLength}
  }

  const applyVerifiedSharedRecord = (
    rec: AuthoritativeStateRecord,
    roles: string[],
    byteLength: number
  ): boolean => {
    const slot = sharedSlots.get(rec.ns)
    if (slot) {
      if (byteLength > slot.maxBytes) {
        return false
      }
      if (slot.record && compareStateRecords(rec, slot.record) <= 0) {
        return false
      }
      const prevVal = slot.value
      const ctx = toSharedCtx(rec, prevVal, roles)
      if (slot.validate && !slot.validate(rec.val as JsonValue, ctx)) {
        return false
      }
      slot.prevValue = prevVal
      slot.record = rec
      slot.value = rec.val as JsonValue
      slot.roles = [...roles]
      slot.emitChange(slot.value, ctx)
      return true
    }

    const unregKey = `s:${rec.ns}`
    const existing = unregisteredSlots.get(unregKey)
    const list = existing?.kind === 's' ? existing.candidates : []
    for (const c of list) {
      if (
        c.record.userId === rec.userId &&
        compareStateRecords(c.record, rec) >= 0 &&
        isSubsetRoles(roles, c.roles)
      ) {
        return false
      }
    }
    const filtered = list.filter(
      c =>
        !(
          c.record.userId === rec.userId &&
          compareStateRecords(rec, c.record) >= 0 &&
          isSubsetRoles(c.roles, roles)
        )
    )
    filtered.push({
      record: rec,
      roles: [...roles],
      byteLength,
      expiresAt: null,
      lastTouched: Date.now()
    })
    const certified = filtered
      .filter(c => c.roles.length > 0)
      .sort((a, b) => compareStateRecords(b.record, a.record))
      .slice(0, maxUnregisteredCandidatesPerSharedNs)
    const open = filtered
      .filter(c => c.roles.length === 0)
      .sort((a, b) => compareStateRecords(b.record, a.record))
      .slice(0, maxUnregisteredCandidatesPerSharedNs)
    const surviving = [...certified, ...open].sort((a, b) =>
      compareStateRecords(b.record, a.record)
    )
    const prevTotal = existing?.totalBytes ?? 0
    const nextTotal = surviving.reduce((sum, c) => sum + c.byteLength, 0)
    unregisteredTotalBytes = Math.max(
      0,
      unregisteredTotalBytes - prevTotal + nextTotal
    )
    touchUnregisteredSlot(unregKey, {
      kind: 's',
      namespace: rec.ns,
      candidates: surviving,
      totalBytes: nextTotal
    })
    enforceUnregisteredCacheBounds()
    return true
  }

  const applyVerifiedUserRecord = (
    rec: AuthoritativeStateRecord,
    roles: string[],
    byteLength: number
  ): boolean => {
    maybePurgeExpiredFast()
    const uid = rec.userId
    const online = deps.isUserOnline(uid)
    const now = Date.now()
    const localUid = deps.getLocalUserId()
    const slot = userSlots.get(rec.ns)

    if (slot) {
      if (!online && !slot.retain) {
        return false
      }
      const curEntry = slot.entries.get(uid)
      const curTomb = slot.tombstones.get(uid)
      const curRec = curEntry?.record ?? curTomb?.record ?? null
      if (curRec && compareStateRecords(rec, curRec) <= 0) {
        return false
      }
      if (!rec.del && byteLength > slot.maxBytes) {
        return false
      }
      if (!checkUserQuota(uid, rec.ns, byteLength)) {
        return false
      }

      if (rec.del) {
        const hadEntry = Boolean(curEntry)
        const prevVal = curEntry ? curEntry.value : slot.initialValue
        slot.entries.delete(uid)
        if (localUid && uid === localUid && hadEntry) {
          localPublishedUserCount = Math.max(0, localPublishedUserCount - 1)
        }
        const tombTtl = slot.retain?.ttlMs ?? defaultRetainTtlMs
        slot.tombstones.set(uid, {
          record: rec,
          byteLength,
          expiresAt: now + tombTtl
        })
        setUserQuota(uid, rec.ns, byteLength)
        if (hadEntry) {
          slot.snapshotAll = null
          slot.snapshotOnline = null
          slot.emitChange(undefined, toUserCtx(rec, prevVal, roles, true))
        }
        scheduleExpiryTimer()
        return true
      }

      const prevVal = curEntry ? curEntry.value : slot.initialValue
      const ctx = toUserCtx(rec, prevVal, roles, false)
      if (slot.validate && !slot.validate(rec.val as JsonValue, ctx)) {
        return false
      }
      slot.tombstones.delete(uid)
      const expiresAt = !online && slot.retain ? now + slot.retain.ttlMs : null
      slot.entries.set(uid, {
        record: rec,
        value: rec.val as JsonValue,
        prevValue: prevVal,
        roles: [...roles],
        byteLength,
        expiresAt,
        lastTouched: now
      })
      if (localUid && uid === localUid && !curEntry) {
        localPublishedUserCount++
      }
      setUserQuota(uid, rec.ns, byteLength)
      slot.snapshotAll = null
      slot.snapshotOnline = null
      slot.emitChange(rec.val as JsonValue, ctx)
      if (!online) {
        enforceOfflineMaxUsers(slot)
      }
      scheduleExpiryTimer()
      return true
    }

    const retainTtlMs = rec.ret
    if (!online && !retainTtlMs) {
      return false
    }
    const unregKey = `u:${rec.ns}`
    const existingSlot = unregisteredSlots.get(unregKey)
    const byUser =
      existingSlot?.kind === 'u'
        ? existingSlot.byUser
        : new Map<string, UnregisteredCandidate>()
    const curCand = byUser.get(uid)
    if (curCand && compareStateRecords(rec, curCand.record) <= 0) {
      return false
    }
    if (!checkUserQuota(uid, rec.ns, byteLength)) {
      return false
    }
    const prevCandBytes = curCand?.byteLength ?? 0
    const expiresAt = online ? null : now + (retainTtlMs ?? defaultRetainTtlMs)
    byUser.set(uid, {
      record: rec,
      roles: [...roles],
      byteLength,
      expiresAt,
      lastTouched: now
    })
    setUserQuota(uid, rec.ns, byteLength)
    const prevSlotBytes = existingSlot?.totalBytes ?? 0
    let nextSlotBytes = prevSlotBytes - prevCandBytes + byteLength

    if (!online) {
      const offlineCands: Array<[string, UnregisteredCandidate]> = []
      for (const [kUid, cand] of byUser.entries()) {
        if (!deps.isUserOnline(kUid)) {
          offlineCands.push([kUid, cand])
        }
      }
      if (offlineCands.length > defaultRetainMaxUsers) {
        offlineCands.sort((a, b) => a[1].lastTouched - b[1].lastTouched)
        const excess = offlineCands.length - defaultRetainMaxUsers
        for (let i = 0; i < excess; i++) {
          const [evUid, evCand] = offlineCands[i]!
          byUser.delete(evUid)
          nextSlotBytes = Math.max(0, nextSlotBytes - evCand.byteLength)
          setUserQuota(evUid, rec.ns, 0)
        }
      }
    }

    unregisteredTotalBytes = Math.max(
      0,
      unregisteredTotalBytes - prevSlotBytes + nextSlotBytes
    )
    touchUnregisteredSlot(unregKey, {
      kind: 'u',
      namespace: rec.ns,
      byUser,
      totalBytes: nextSlotBytes
    })
    enforceUnregisteredCacheBounds()
    scheduleExpiryTimer()
    return true
  }

  const verifyAndApplyStateRecord = async (
    rec: AuthoritativeStateRecord,
    fromPeerId?: string
  ): Promise<boolean> => {
    if (destroyed) {
      return false
    }
    if (!validateStateRecordShape(rec)) {
      deps.onInvalidRecord?.(fromPeerId)
      return false
    }
    const requiredRoles =
      rec.k === 's'
        ? (sharedSlots.get(rec.ns)?.requiredRoles ?? null)
        : (userSlots.get(rec.ns)?.requiredRoles ?? null)

    const verified = await verifyRecordCryptoAndRoles(
      rec,
      requiredRoles,
      fromPeerId
    )
    if (verified.status === 'invalid') {
      deps.onInvalidRecord?.(fromPeerId)
      return false
    }
    if (verified.status === 'dropped') {
      return false
    }
    return rec.k === 's'
      ? applyVerifiedSharedRecord(rec, verified.roles, verified.byteLength)
      : applyVerifiedUserRecord(rec, verified.roles, verified.byteLength)
  }

  const collectSyncableRecords = (): Map<string, AuthoritativeStateRecord> => {
    maybePurgeExpiredFast()
    const out = new Map<string, AuthoritativeStateRecord>()
    for (const [ns, slot] of sharedSlots.entries()) {
      if (
        slot.record &&
        isRecordCurrentlyAuthorized(slot.record, slot.requiredRoles).ok
      ) {
        out.set(`s:${ns}`, slot.record)
      }
    }
    for (const [ns, slot] of userSlots.entries()) {
      for (const [uid, entry] of slot.entries.entries()) {
        if (
          (deps.isUserOnline(uid) || slot.retain) &&
          isRecordCurrentlyAuthorized(entry.record, slot.requiredRoles).ok
        ) {
          out.set(`u:${ns}\u0000${uid}`, entry.record)
        }
      }
      for (const [uid, tomb] of slot.tombstones.entries()) {
        if (
          (deps.isUserOnline(uid) || slot.retain) &&
          isRecordCurrentlyAuthorized(tomb.record, slot.requiredRoles).ok
        ) {
          out.set(`u:${ns}\u0000${uid}`, tomb.record)
        }
      }
    }
    for (const slot of unregisteredSlots.values()) {
      if (slot.kind === 's') {
        const key = `s:${slot.namespace}`
        const certKey = `s:${slot.namespace}#c`
        for (const cand of slot.candidates) {
          if (deps.isPeerBanned(cand.record.userId)) {
            continue
          }
          if (!out.has(key)) {
            out.set(key, cand.record)
          } else if (
            cand.roles.length > 0 &&
            !out.has(certKey) &&
            out.get(key)?.sig !== cand.record.sig
          ) {
            out.set(certKey, cand.record)
          }
        }
      } else {
        for (const [uid, cand] of slot.byUser.entries()) {
          if (
            !deps.isPeerBanned(uid) &&
            (deps.isUserOnline(uid) || cand.record.ret)
          ) {
            out.set(`u:${slot.namespace}\u0000${uid}`, cand.record)
          }
        }
      }
    }
    return out
  }

  const buildDigestMap = (): Record<string, DigestEntry> => {
    const map = collectSyncableRecords()
    const digest: Record<string, DigestEntry> = {}
    let count = 0
    for (const [k, rec] of map.entries()) {
      if (count >= maxSyncRecordsPerBatch) {
        break
      }
      digest[k] = [rec.hlc, rec.sig.slice(0, 8)]
      count++
    }
    return digest
  }

  const packBatchRecords = (
    records: AuthoritativeStateRecord[]
  ): {p: Record<string, string>; r: WireStateRecord[]} => {
    const p: Record<string, string> = {}
    const r: WireStateRecord[] = []
    for (const rec of records.slice(0, maxSyncRecordsPerBatch)) {
      p[rec.userId] = rec.pub
      r.push(toWireRecord(rec, false))
    }
    return {p, r}
  }

  const getPreferredDirectNeighbors = (): string[] => {
    const selfId = deps.getSelfId()
    const peers = deps.getDirectPeerIds().filter(id => !deps.isPeerBanned(id))
    peers.sort((a, b) => {
      const ha = hash32(`${selfId}:${a}`)
      const hb = hash32(`${selfId}:${b}`)
      return ha !== hb ? ha - hb : a < b ? -1 : a > b ? 1 : 0
    })
    return peers
  }

  const sendPullToPeer = (peerId: string): void => {
    if (
      !stateAction ||
      destroyed ||
      !deps.isDirectPeer(peerId) ||
      deps.isPeerBanned(peerId) ||
      inFlightPullTimers.has(peerId)
    ) {
      return
    }
    const timer = setTimeout(() => {
      inFlightPullTimers.delete(peerId)
      if (!destroyed && completedSyncPeers.size < syncPullFanout) {
        for (const candidate of getPreferredDirectNeighbors()) {
          if (
            !completedSyncPeers.has(candidate) &&
            !inFlightPullTimers.has(candidate)
          ) {
            sendPullToPeer(candidate)
            break
          }
        }
      }
    }, syncPullTimeoutMs)
    ;(timer as {unref?: () => void}).unref?.()
    inFlightPullTimers.set(peerId, timer)

    const msg: StateControlMessage = {t: 'pull', d: buildDigestMap()}
    void stateAction.send(msg as unknown as JsonValue, peerId).catch(() => {
      const t = inFlightPullTimers.get(peerId)
      if (t !== undefined) {
        clearTimeout(t)
        inFlightPullTimers.delete(peerId)
      }
    })
  }

  const consumeLiveRateToken = (peerId: string): boolean => {
    const now = Date.now()
    const existing = peerRateBuckets.get(peerId)
    if (!existing) {
      peerRateBuckets.set(peerId, {
        tokens: maxLiveRecordBurst - 1,
        lastRefillMs: now
      })
      return true
    }
    const elapsedSec = Math.max(0, (now - existing.lastRefillMs) / 1_000)
    existing.tokens = Math.min(
      maxLiveRecordBurst,
      existing.tokens + elapsedSec * maxLiveRecordsPerSec
    )
    existing.lastRefillMs = now
    if (existing.tokens < 1) {
      return false
    }
    existing.tokens -= 1
    return true
  }

  const consumeSyncQuota = (peerId: string): boolean => {
    const now = Date.now()
    const cur = peerSyncCounts.get(peerId)
    if (!cur || now - cur.windowStart > 30_000) {
      peerSyncCounts.set(peerId, {count: 1, windowStart: now})
      return true
    }
    if (cur.count >= 24) {
      return false
    }
    cur.count++
    return true
  }

  if (stateAction) {
    stateAction.onMessage((raw, fromPeerId) => {
      if (destroyed || deps.isPeerBanned(fromPeerId) || !isObj(raw)) {
        return
      }
      const msg = raw as unknown as StateControlMessage
      if (msg.t === 'rec') {
        if (!consumeLiveRateToken(fromPeerId)) {
          return
        }
        const isForwarded = msg.f === 1
        void (async () => {
          let roomId = deps.getRoomId()
          try {
            const ready = await deps.ensureReady()
            roomId = ready.roomId
          } catch {
            return
          }
          if (destroyed || deps.isPeerBanned(fromPeerId)) {
            return
          }
          const rec = fromWireRecord(msg.r, deps.appId, roomId)
          if (!rec) {
            deps.onInvalidRecord?.(fromPeerId)
            return
          }
          if (
            !isForwarded &&
            deps.isDirectPeer(fromPeerId) &&
            rec.peerId === fromPeerId
          ) {
            const knownUid = deps.getKnownPeerUserId(fromPeerId)
            if (knownUid && knownUid !== rec.userId) {
              deps.onInvalidRecord?.(fromPeerId)
              return
            }
          }
          const applied = await verifyAndApplyStateRecord(rec, fromPeerId)
          if (
            applied &&
            isForwarded &&
            deps.getScaleProvider?.()?.getActiveMode() === 'gossip'
          ) {
            forwardAppliedRecordToOthers(rec, fromPeerId)
          }
        })()
        return
      }

      if (msg.t === 'pull') {
        if (!consumeSyncQuota(fromPeerId) || !isObj(msg.d)) {
          return
        }
        const dEntries = entries(msg.d as Record<string, unknown>)
        if (dEntries.length > maxSyncRecordsPerBatch) {
          deps.onInvalidRecord?.(fromPeerId)
          return
        }
        const remoteDigest = new Map<string, DigestEntry>()
        for (const [k, v] of dEntries) {
          if (
            !Array.isArray(v) ||
            v.length !== 2 ||
            !isPosSafeInt(v[0]) ||
            typeof v[1] !== 'string' ||
            v[1].length > 16
          ) {
            deps.onInvalidRecord?.(fromPeerId)
            return
          }
          remoteDigest.set(k, [v[0], v[1]])
        }
        const localMap = collectSyncableRecords()
        const toSend: AuthoritativeStateRecord[] = []
        const wantKeys: string[] = []
        for (const [k, localRec] of localMap.entries()) {
          const rem = remoteDigest.get(k)
          const sig8 = localRec.sig.slice(0, 8)
          if (
            !rem ||
            localRec.hlc > rem[0] ||
            (localRec.hlc === rem[0] && sig8 !== rem[1])
          ) {
            toSend.push(localRec)
          }
        }
        for (const [k, rem] of remoteDigest.entries()) {
          const localRec = localMap.get(k)
          const sig8 = localRec ? localRec.sig.slice(0, 8) : ''
          if (
            !localRec ||
            rem[0] > localRec.hlc ||
            (rem[0] === localRec.hlc && rem[1] !== sig8)
          ) {
            wantKeys.push(k)
          }
        }
        const packed = packBatchRecords(toSend)
        const reply: StateControlMessage = {
          t: 'sync',
          p: packed.p,
          r: packed.r,
          ...(wantKeys.length > 0
            ? {w: wantKeys.slice(0, maxSyncRecordsPerBatch)}
            : {})
        }
        void stateAction
          .send(reply as unknown as JsonValue, fromPeerId)
          .catch(noOp)
        return
      }

      if (msg.t === 'sync' || msg.t === 'push') {
        if (
          !consumeSyncQuota(fromPeerId) ||
          !isObj(msg.p) ||
          !Array.isArray(msg.r)
        ) {
          return
        }
        if (msg.r.length > maxSyncRecordsPerBatch) {
          deps.onInvalidRecord?.(fromPeerId)
          return
        }
        if (msg.t === 'sync') {
          const t = inFlightPullTimers.get(fromPeerId)
          if (t !== undefined) {
            clearTimeout(t)
            inFlightPullTimers.delete(fromPeerId)
          }
          completedSyncPeers.add(fromPeerId)
        }
        const pubMap = msg.p as Record<string, unknown>
        const wantList =
          msg.t === 'sync' && Array.isArray(msg.w)
            ? msg.w
                .filter((x): x is string => typeof x === 'string')
                .slice(0, maxSyncRecordsPerBatch)
            : []

        void (async () => {
          let roomId = deps.getRoomId()
          try {
            const ready = await deps.ensureReady()
            roomId = ready.roomId
          } catch {
            return
          }
          for (const wireRec of msg.r) {
            if (destroyed || deps.isPeerBanned(fromPeerId)) {
              return
            }
            const fullRec = fromWireRecord(wireRec, deps.appId, roomId, pubMap)
            if (!fullRec) {
              deps.onInvalidRecord?.(fromPeerId)
              return
            }
            const applied = await verifyAndApplyStateRecord(fullRec, fromPeerId)
            if (
              applied &&
              (msg.t === 'push' ||
                deps.getScaleProvider?.()?.getActiveMode() === 'gossip')
            ) {
              forwardAppliedRecordToOthers(fullRec, fromPeerId)
            }
          }
          if (
            wantList.length > 0 &&
            !destroyed &&
            deps.isPeerActive(fromPeerId)
          ) {
            const localMap = collectSyncableRecords()
            const pushRecs: AuthoritativeStateRecord[] = []
            for (const k of wantList) {
              const rec = localMap.get(k)
              if (rec) {
                pushRecs.push(rec)
              }
            }
            if (pushRecs.length > 0) {
              const packed = packBatchRecords(pushRecs)
              const pushMsg: StateControlMessage = {
                t: 'push',
                p: packed.p,
                r: packed.r
              }
              void stateAction
                .send(pushMsg as unknown as JsonValue, fromPeerId)
                .catch(noOp)
            }
          }
        })()
      }
    })
  }

  if (preJoinAction) {
    preJoinAction.onMessage((raw, fromPeerId) => {
      if (
        destroyed ||
        deps.isPeerBanned(fromPeerId) ||
        deps.isPeerActive(fromPeerId) ||
        !isObj(raw)
      ) {
        return
      }
      const payload = raw as unknown as PreJoinUserPayload
      if (
        !isObj(payload.p) ||
        !Array.isArray(payload.r) ||
        payload.r.length > maxUserStateNamespacesPerUser
      ) {
        deps.onInvalidRecord?.(fromPeerId)
        return
      }
      const pubMap = payload.p as Record<string, unknown>
      const task = (async () => {
        let roomId = deps.getRoomId()
        try {
          const ready = await deps.ensureReady()
          roomId = ready.roomId
        } catch {
          return
        }
        const verifiedList: StagedRecord[] = []
        let totalBytes = 0
        for (const wireRec of payload.r) {
          if (destroyed || deps.isPeerBanned(fromPeerId)) {
            return
          }
          const fullRec = fromWireRecord(wireRec, deps.appId, roomId, pubMap)
          if (!fullRec || fullRec.k !== 'u') {
            deps.onInvalidRecord?.(fromPeerId)
            return
          }
          const slot = userSlots.get(fullRec.ns)
          const requiredRoles = slot ? slot.requiredRoles : null
          const res = await verifyRecordCryptoAndRoles(
            fullRec,
            requiredRoles,
            fromPeerId
          )
          if (res.status === 'invalid') {
            deps.onInvalidRecord?.(fromPeerId)
            return
          }
          if (res.status === 'dropped') {
            continue
          }
          totalBytes += res.byteLength
          if (totalBytes > maxUserStateBytesPerUser) {
            return
          }
          verifiedList.push({
            record: fullRec,
            roles: res.roles,
            byteLength: res.byteLength
          })
        }
        if (
          !destroyed &&
          !deps.isPeerBanned(fromPeerId) &&
          verifiedList.length
        ) {
          if (deps.isPeerActive(fromPeerId)) {
            const knownUid = deps.getKnownPeerUserId(fromPeerId)
            for (const item of verifiedList) {
              if (!knownUid || item.record.userId === knownUid) {
                applyVerifiedUserRecord(
                  item.record,
                  item.roles,
                  item.byteLength
                )
              }
            }
          } else {
            stagedPreJoinByPeer.set(fromPeerId, verifiedList)
          }
        }
      })().finally(() => {
        if (pendingPreJoinByPeer.get(fromPeerId) === task) {
          pendingPreJoinByPeer.delete(fromPeerId)
        }
      })
      pendingPreJoinByPeer.set(fromPeerId, task)
    })
  }

  const obtainWriteAuth = async (
    requiredRoles: readonly string[] | null,
    namespace: string,
    userId: string
  ): Promise<{cert: RoleCertificate | null; roles: string[]}> => {
    const rolesProvider = deps.getRolesProvider()
    if (rolesProvider?.getStateWriteCert) {
      return rolesProvider.getStateWriteCert(requiredRoles, namespace)
    }
    if (requiredRoles && requiredRoles.length > 0) {
      throw mkErr(
        `${insufficientAuthPrefix} to update state "${namespace}": requires [${requiredRoles.join(', ')}]`
      )
    }
    return {cert: null, roles: deps.getPeerRoles(userId)}
  }

  const flushSharedSlot = async (slot: SharedSlot): Promise<void> => {
    if (slot.flushing) {
      return
    }
    slot.flushing = true
    try {
      while (slot.pendingOps.length > 0) {
        let ready: {selfId: string; user: UserIdentity; roomId: string}
        let auth: {cert: RoleCertificate | null; roles: string[]}
        try {
          ready = await deps.ensureReady()
          auth = await obtainWriteAuth(
            slot.requiredRoles,
            slot.namespace,
            ready.user.userId
          )
        } catch (err) {
          const failedBatch = slot.pendingOps.splice(0)
          for (const op of failedBatch) {
            op.reject(err)
          }
          continue
        }

        const batch = slot.pendingOps.splice(0)
        if (batch.length === 0) {
          continue
        }

        const prevBeforeSign = slot.value
        let simVal = prevBeforeSign
        const acceptedOps: PendingSharedOp[] = []
        const tentativeTs = Math.max(Date.now(), lastSeenHlc + 1)

        for (const op of batch) {
          let candidate: JsonValue
          try {
            candidate =
              typeof op.nextOrFn === 'function'
                ? (op.nextOrFn as (prev: JsonValue) => JsonValue)(simVal)
                : op.nextOrFn
          } catch (err) {
            op.reject(err)
            continue
          }
          if (!hasFiniteNums(candidate)) {
            op.reject(
              mkErr(
                `state "${slot.namespace}" value must contain only finite JSON numbers`
              )
            )
            continue
          }
          const bytes = encodeBytes(toJson(candidate)).byteLength
          if (bytes > slot.maxBytes) {
            op.reject(
              mkErr(
                `state "${slot.namespace}" exceeds maxBytes (${slot.maxBytes})`
              )
            )
            continue
          }
          if (slot.validate) {
            const simCtx: StateChangeContext = {
              prev: simVal,
              peerId: ready.selfId,
              userId: ready.user.userId,
              roles: [...auth.roles],
              timestamp: tentativeTs
            }
            if (!slot.validate(candidate, simCtx)) {
              op.reject(
                mkErr(`state validation failed for "${slot.namespace}"`)
              )
              continue
            }
          }
          simVal = candidate
          acceptedOps.push(op)
        }

        if (acceptedOps.length === 0) {
          continue
        }

        let rec: AuthoritativeStateRecord
        try {
          const hlc = nextLocalHlc(slot.namespace)
          rec = await signStateRecord(ready.user.sign, ready.user.signPubJwk, {
            kind: 's',
            appId: deps.appId,
            roomId: ready.roomId,
            ns: slot.namespace,
            hlc,
            peerId: ready.selfId,
            userId: ready.user.userId,
            val: simVal,
            cert: auth.cert
          })
          verifiedSigCache.add(`${stateRecordPayload(rec)}\u0000${rec.sig}`)
        } catch (err) {
          for (const op of acceptedOps) {
            op.reject(err)
          }
          continue
        }

        if (slot.record && compareStateRecords(rec, slot.record) <= 0) {
          broadcastLiveRecord(rec)
          for (const op of acceptedOps) {
            op.resolve()
          }
          continue
        }

        const currentPrev = slot.value
        const effectiveCtx = toSharedCtx(rec, currentPrev, auth.roles)
        if (
          currentPrev !== prevBeforeSign &&
          slot.validate &&
          !slot.validate(simVal, effectiveCtx)
        ) {
          const err = mkErr(`state validation failed for "${slot.namespace}"`)
          for (const op of acceptedOps) {
            op.reject(err)
          }
          continue
        }

        slot.prevValue = currentPrev
        slot.record = rec
        slot.value = simVal
        slot.roles = [...auth.roles]
        slot.emitChange(simVal, effectiveCtx)
        broadcastLiveRecord(rec)
        for (const op of acceptedOps) {
          op.resolve()
        }
      }
    } finally {
      slot.flushing = false
    }
  }

  const flushUserSlot = (slot: UserSlot): Promise<void> => {
    if (slot.activeFlushP) {
      return slot.activeFlushP
    }
    slot.flushing = true
    const p = (async () => {
      try {
        while (slot.pendingOps.length > 0) {
          let ready: {selfId: string; user: UserIdentity; roomId: string}
          let auth: {cert: RoleCertificate | null; roles: string[]}
          try {
            ready = await deps.ensureReady()
            auth = await obtainWriteAuth(
              slot.requiredRoles,
              slot.namespace,
              ready.user.userId
            )
          } catch (err) {
            const failedBatch = slot.pendingOps.splice(0)
            for (const op of failedBatch) {
              op.reject(err)
            }
            continue
          }

          const batch = slot.pendingOps.splice(0)
          if (batch.length === 0) {
            continue
          }

          const uid = ready.user.userId
          const curBeforeSign = slot.entries.get(uid)
          let simVal = curBeforeSign ? curBeforeSign.value : slot.initialValue
          let finalKind: 'set' | 'clear' | null = null
          let finalBytes = 0
          const acceptedOps: PendingUserOp[] = []
          const tentativeTs = Math.max(Date.now(), lastSeenHlc + 1)

          for (const op of batch) {
            if (op.kind === 'clear') {
              if (!checkUserQuota(uid, slot.namespace, 32)) {
                op.reject(
                  mkErr(
                    `user state "${slot.namespace}" exceeds per-user state quota`
                  )
                )
                continue
              }
              simVal = slot.initialValue
              finalKind = 'clear'
              finalBytes = 32
              acceptedOps.push(op)
              continue
            }

            let candidate: JsonValue
            try {
              candidate =
                typeof op.nextOrFn === 'function'
                  ? (op.nextOrFn as (prev: JsonValue) => JsonValue)(simVal)
                  : op.nextOrFn
            } catch (err) {
              op.reject(err)
              continue
            }
            if (!hasFiniteNums(candidate)) {
              op.reject(
                mkErr(
                  `user state "${slot.namespace}" value must contain only finite JSON numbers`
                )
              )
              continue
            }
            const bytes = encodeBytes(toJson(candidate)).byteLength
            if (bytes > slot.maxBytes) {
              op.reject(
                mkErr(
                  `user state "${slot.namespace}" exceeds maxBytes (${slot.maxBytes})`
                )
              )
              continue
            }
            if (!checkUserQuota(uid, slot.namespace, bytes)) {
              op.reject(
                mkErr(
                  `user state "${slot.namespace}" exceeds per-user state quota`
                )
              )
              continue
            }
            if (slot.validate) {
              const simCtx: UserStateChangeContext = {
                prev: simVal,
                peerId: ready.selfId,
                userId: uid,
                roles: [...auth.roles],
                timestamp: tentativeTs,
                self: true,
                online: true,
                removed: false
              }
              if (!slot.validate(candidate, simCtx)) {
                op.reject(
                  mkErr(`user state validation failed for "${slot.namespace}"`)
                )
                continue
              }
            }
            simVal = candidate
            finalKind = 'set'
            finalBytes = bytes
            acceptedOps.push(op)
          }

          if (acceptedOps.length === 0 || !finalKind) {
            continue
          }

          let rec: AuthoritativeStateRecord
          try {
            const hlc = nextLocalHlc(slot.namespace)
            rec = await signStateRecord(
              ready.user.sign,
              ready.user.signPubJwk,
              {
                kind: 'u',
                appId: deps.appId,
                roomId: ready.roomId,
                ns: slot.namespace,
                hlc,
                peerId: ready.selfId,
                userId: uid,
                ...(finalKind === 'clear' ? {del: true} : {val: simVal}),
                ...(slot.retain ? {ret: slot.retain.ttlMs} : {}),
                cert: auth.cert
              }
            )
            verifiedSigCache.add(`${stateRecordPayload(rec)}\u0000${rec.sig}`)
          } catch (err) {
            for (const op of acceptedOps) {
              op.reject(err)
            }
            continue
          }

          const latestEntry = slot.entries.get(uid)
          const latestTomb = slot.tombstones.get(uid)
          const latestRec = latestEntry?.record ?? latestTomb?.record ?? null
          if (latestRec && compareStateRecords(rec, latestRec) <= 0) {
            broadcastLiveRecord(rec)
            for (const op of acceptedOps) {
              op.resolve()
            }
            continue
          }

          const now = Date.now()
          if (finalKind === 'clear') {
            const hadEntry = Boolean(latestEntry)
            const prevVal = latestEntry ? latestEntry.value : slot.initialValue
            slot.entries.delete(uid)
            if (hadEntry) {
              localPublishedUserCount = Math.max(0, localPublishedUserCount - 1)
            }
            slot.tombstones.set(uid, {
              record: rec,
              byteLength: finalBytes,
              expiresAt: now + (slot.retain?.ttlMs ?? defaultRetainTtlMs)
            })
            setUserQuota(uid, slot.namespace, finalBytes)
            if (hadEntry) {
              slot.snapshotAll = null
              slot.snapshotOnline = null
              slot.emitChange(
                undefined,
                toUserCtx(rec, prevVal, auth.roles, true)
              )
            }
            scheduleExpiryTimer()
            broadcastLiveRecord(rec)
            for (const op of acceptedOps) {
              op.resolve()
            }
            continue
          }

          const currentPrev = latestEntry
            ? latestEntry.value
            : slot.initialValue
          const effectiveCtx = toUserCtx(rec, currentPrev, auth.roles, false)
          if (
            latestEntry !== curBeforeSign &&
            slot.validate &&
            !slot.validate(simVal, effectiveCtx)
          ) {
            const err = mkErr(
              `user state validation failed for "${slot.namespace}"`
            )
            for (const op of acceptedOps) {
              op.reject(err)
            }
            continue
          }

          slot.tombstones.delete(uid)
          if (!latestEntry) {
            localPublishedUserCount++
          }
          slot.entries.set(uid, {
            record: rec,
            value: simVal,
            prevValue: currentPrev,
            roles: [...auth.roles],
            byteLength: finalBytes,
            expiresAt: null,
            lastTouched: now
          })
          setUserQuota(uid, slot.namespace, finalBytes)
          slot.snapshotAll = null
          slot.snapshotOnline = null
          slot.emitChange(simVal, effectiveCtx)
          broadcastLiveRecord(rec)
          for (const op of acceptedOps) {
            op.resolve()
          }
        }
      } finally {
        slot.flushing = false
        slot.activeFlushP = null
      }
    })()
    slot.activeFlushP = p
    return p
  }

  const makeState: RoomMakeState = <T extends JsonValue = JsonValue>(
    namespace: string,
    initialValue?: T | null,
    config?: StateConfig<Widen<T>>
  ): SharedState<Widen<T>> => {
    type W = Widen<T>
    if (!isStr(namespace) || namespace.length > 256) {
      throw mkErr('makeState requires a non-empty namespace string')
    }
    const existing = sharedSlots.get(namespace)
    if (existing) {
      return existing.api as unknown as SharedState<W>
    }
    const initVal = (
      initialValue === undefined ? null : initialValue
    ) as JsonValue
    if (!hasFiniteNums(initVal)) {
      throw mkErr(`state "${namespace}" initialValue must be valid JSON`)
    }
    const maxBytes = validateMaxBytesOpt(
      config?.maxBytes,
      `state "${namespace}"`
    )
    const rolesLoaded =
      deps.hasRolesPlugin() || Boolean(deps.getRolesProvider())
    const requiredRoles = normalizeRequiredRoles(
      config?.roles,
      rolesLoaded,
      true,
      'state role gating'
    )
    const changeEmitter =
      createEventEmitter<[W, StateChangeContext<W>]>('state handler')

    const slot: SharedSlot = {
      namespace,
      initialValue: initVal,
      value: initVal,
      prevValue: initVal,
      record: null,
      roles: [],
      requiredRoles,
      maxBytes,
      ...(config?.validate
        ? {validate: config.validate as SharedSlot['validate']}
        : {}),
      emitChange: (val, ctx) =>
        changeEmitter.emit(val as W, ctx as StateChangeContext<W>),
      clearListeners: () => changeEmitter.clear(),
      api: null as unknown as SharedState<JsonValue>,
      pendingOps: [],
      flushing: false
    }

    const api = lockMethods(
      {
        get: () => slot.value as W,
        set: (nextOrFn: W | ((prev: W) => W)) =>
          new Promise<void>((resolve, reject) => {
            slot.pendingOps.push({
              nextOrFn: nextOrFn as
                | JsonValue
                | ((prev: JsonValue) => JsonValue),
              resolve,
              reject
            })
            void flushSharedSlot(slot)
          }),
        getMeta: () =>
          slot.record
            ? toSharedCtx<W>(slot.record, slot.prevValue as W, slot.roles)
            : null,
        onChange: (
          handler: (value: W, context: StateChangeContext<W>) => unknown,
          options?: ReplayListenerOptions
        ) =>
          changeEmitter.subscribe(handler, options, () =>
            slot.record
              ? [
                  [
                    slot.value as W,
                    toSharedCtx<W>(slot.record, slot.prevValue as W, slot.roles)
                  ]
                ]
              : []
          )
      } satisfies SharedState<W>,
      ['onChange']
    )

    slot.api = api as unknown as SharedState<JsonValue>
    sharedSlots.set(namespace, slot)

    const popped = removeUnregisteredSlot(`s:${namespace}`)
    if (popped?.kind === 's') {
      for (const cand of popped.candidates) {
        if (cand.byteLength > slot.maxBytes) {
          continue
        }
        const authCheck = isRecordCurrentlyAuthorized(
          cand.record,
          slot.requiredRoles
        )
        if (!authCheck.ok) {
          continue
        }
        const effectiveRoles = authCheck.roles.length
          ? authCheck.roles
          : cand.roles
        if (
          slot.requiredRoles &&
          !slot.requiredRoles.some(r => effectiveRoles.includes(r))
        ) {
          continue
        }
        const ctx = toSharedCtx(cand.record, initVal, effectiveRoles)
        if (
          slot.validate &&
          !slot.validate(cand.record.val as JsonValue, ctx)
        ) {
          continue
        }
        slot.prevValue = initVal
        slot.record = cand.record
        slot.value = cand.record.val as JsonValue
        slot.roles = [...effectiveRoles]
        break
      }
    }

    return api
  }

  const makeUserState: RoomMakeUserState = <T extends JsonValue = JsonValue>(
    namespace: string,
    initialValue?: T | null,
    config?: UserStateConfig<Widen<T>>
  ): UserState<Widen<T>> => {
    type W = Widen<T>
    if (!isStr(namespace) || namespace.length > 256) {
      throw mkErr('makeUserState requires a non-empty namespace string')
    }
    const existing = userSlots.get(namespace)
    if (existing) {
      return existing.api as unknown as UserState<W>
    }
    const initVal = (
      initialValue === undefined ? null : initialValue
    ) as JsonValue
    if (!hasFiniteNums(initVal)) {
      throw mkErr(`user state "${namespace}" initialValue must be valid JSON`)
    }
    const maxBytes = validateMaxBytesOpt(
      config?.maxBytes,
      `user state "${namespace}"`
    )
    let retain: {ttlMs: number; maxUsers: number} | null = null
    if (config?.retain === true) {
      retain = {ttlMs: defaultRetainTtlMs, maxUsers: defaultRetainMaxUsers}
    } else if (isObj(config?.retain)) {
      const {ttlMs, maxUsers} = config.retain
      if (ttlMs !== undefined && !isPosSafeInt(ttlMs)) {
        throw posSafeIntErr('retain.ttlMs')
      }
      if (maxUsers !== undefined && !isPosSafeInt(maxUsers)) {
        throw posSafeIntErr('retain.maxUsers')
      }
      retain = {
        ttlMs: ttlMs ?? defaultRetainTtlMs,
        maxUsers: maxUsers ?? defaultRetainMaxUsers
      }
    }
    const rolesLoaded =
      deps.hasRolesPlugin() || Boolean(deps.getRolesProvider())
    const requiredRoles = normalizeRequiredRoles(
      config?.roles,
      rolesLoaded,
      false,
      'user state role gating'
    )

    const changeEmitter =
      createEventEmitter<[W | undefined, UserStateChangeContext<W>]>(
        'user state handler'
      )

    const slot: UserSlot = {
      namespace,
      initialValue: initVal,
      requiredRoles,
      maxBytes,
      retain,
      ...(config?.validate
        ? {validate: config.validate as UserSlot['validate']}
        : {}),
      entries: new Map(),
      tombstones: new Map(),
      snapshotAll: null,
      snapshotOnline: null,
      emitChange: (val, ctx) =>
        changeEmitter.emit(
          val as W | undefined,
          ctx as UserStateChangeContext<W>
        ),
      clearListeners: () => changeEmitter.clear(),
      api: null as unknown as UserState<JsonValue>,
      pendingOps: [],
      flushing: false,
      activeFlushP: null
    }

    const resolveTargetUid = (id?: string): string | undefined => {
      if (id === undefined) {
        return deps.getLocalUserId() || undefined
      }
      if (!id) {
        return undefined
      }
      const selfId = deps.getSelfId()
      if (selfId && id === selfId) {
        return deps.getLocalUserId() || undefined
      }
      if (slot.entries.has(id)) {
        return id
      }
      return deps.getKnownPeerUserId(id) ?? id
    }

    const getAll = (
      options?: UserStateGetAllOptions
    ): Readonly<Record<string, W>> => {
      maybePurgeExpiredFast()
      if (options?.onlineOnly) {
        if (!slot.snapshotOnline) {
          const out: Record<string, JsonValue> = {}
          for (const [uid, entry] of slot.entries.entries()) {
            if (deps.isUserOnline(uid)) {
              out[uid] = entry.value
            }
          }
          slot.snapshotOnline = Object.freeze(out)
        }
        return slot.snapshotOnline as Readonly<Record<string, W>>
      }
      if (!slot.snapshotAll) {
        const out: Record<string, JsonValue> = {}
        for (const [uid, entry] of slot.entries.entries()) {
          out[uid] = entry.value
        }
        slot.snapshotAll = Object.freeze(out)
      }
      return slot.snapshotAll as Readonly<Record<string, W>>
    }

    const api = lockMethods(
      {
        get: (id?: string): W => {
          maybePurgeExpiredFast()
          const uid = resolveTargetUid(id)
          if (uid !== undefined) {
            const entry = slot.entries.get(uid)
            if (entry) {
              return entry.value as W
            }
          }
          return slot.initialValue as W
        },
        getAll,
        has: (id?: string): boolean => {
          maybePurgeExpiredFast()
          const uid = resolveTargetUid(id)
          return uid !== undefined && slot.entries.has(uid)
        },
        set: (nextOrFn: W | ((prev: W) => W)) =>
          new Promise<void>((resolve, reject) => {
            slot.pendingOps.push({
              kind: 'set',
              nextOrFn: nextOrFn as
                | JsonValue
                | ((prev: JsonValue) => JsonValue),
              resolve,
              reject
            })
            void flushUserSlot(slot)
          }),
        clear: () =>
          new Promise<void>((resolve, reject) => {
            slot.pendingOps.push({kind: 'clear', resolve, reject})
            void flushUserSlot(slot)
          }),
        getMeta: (id?: string): UserStateChangeContext<W> | null => {
          maybePurgeExpiredFast()
          const uid = resolveTargetUid(id)
          if (!uid) {
            return null
          }
          const entry = slot.entries.get(uid)
          return entry
            ? toUserCtx<W>(
                entry.record,
                entry.prevValue as W,
                entry.roles,
                false
              )
            : null
        },
        onChange: (
          handler: (
            value: W | undefined,
            context: UserStateChangeContext<W>
          ) => unknown,
          options?: ReplayListenerOptions
        ) =>
          changeEmitter.subscribe(handler, options, () => {
            maybePurgeExpiredFast()
            const items: Array<[W | undefined, UserStateChangeContext<W>]> = []
            for (const entry of slot.entries.values()) {
              items.push([
                entry.value as W,
                toUserCtx<W>(
                  entry.record,
                  entry.prevValue as W,
                  entry.roles,
                  false
                )
              ])
            }
            return items
          })
      } satisfies UserState<W>,
      ['onChange']
    )

    slot.api = api as unknown as UserState<JsonValue>
    userSlots.set(namespace, slot)

    const popped = removeUnregisteredSlot(`u:${namespace}`)
    if (popped?.kind === 'u') {
      const now = Date.now()
      const localUid = deps.getLocalUserId()
      for (const [uid, cand] of popped.byUser.entries()) {
        if (cand.expiresAt !== null && cand.expiresAt <= now) {
          continue
        }
        const online = deps.isUserOnline(uid)
        if (!online && !slot.retain) {
          continue
        }
        const authCheck = isRecordCurrentlyAuthorized(
          cand.record,
          slot.requiredRoles
        )
        if (!authCheck.ok) {
          continue
        }
        const effectiveRoles = authCheck.roles.length
          ? authCheck.roles
          : cand.roles
        if (
          slot.requiredRoles &&
          !slot.requiredRoles.some(r => effectiveRoles.includes(r))
        ) {
          continue
        }
        if (!checkUserQuota(uid, namespace, cand.byteLength)) {
          continue
        }
        if (cand.record.del) {
          slot.tombstones.set(uid, {
            record: cand.record,
            byteLength: cand.byteLength,
            expiresAt: now + (slot.retain?.ttlMs ?? defaultRetainTtlMs)
          })
          setUserQuota(uid, namespace, cand.byteLength)
          continue
        }
        if (cand.byteLength > slot.maxBytes) {
          continue
        }
        const ctx = toUserCtx(cand.record, initVal, effectiveRoles, false)
        if (
          slot.validate &&
          !slot.validate(cand.record.val as JsonValue, ctx)
        ) {
          continue
        }
        slot.entries.set(uid, {
          record: cand.record,
          value: cand.record.val as JsonValue,
          prevValue: initVal,
          roles: [...effectiveRoles],
          byteLength: cand.byteLength,
          expiresAt: !online && slot.retain ? now + slot.retain.ttlMs : null,
          lastTouched: cand.lastTouched
        })
        if (localUid && uid === localUid) {
          localPublishedUserCount++
        }
        setUserQuota(uid, namespace, cand.byteLength)
      }
      enforceOfflineMaxUsers(slot)
      scheduleExpiryTimer()
    }

    return api
  }

  const hasPendingLocalUserWrites = (): boolean => {
    for (const slot of userSlots.values()) {
      if (slot.pendingOps.length > 0 || slot.flushing) {
        return true
      }
    }
    return false
  }

  const sendPreJoinUserState = (peerId: string): Promise<void> | undefined => {
    if (
      !preJoinAction ||
      destroyed ||
      (localPublishedUserCount === 0 && !hasPendingLocalUserWrites())
    ) {
      return undefined
    }
    return (async () => {
      const flushes: Promise<void>[] = []
      for (const slot of userSlots.values()) {
        if (slot.activeFlushP) {
          flushes.push(slot.activeFlushP)
        } else if (slot.pendingOps.length > 0) {
          flushes.push(flushUserSlot(slot))
        }
      }
      if (flushes.length > 0) {
        await Promise.allSettled(flushes)
      }
      const localUid = deps.getLocalUserId()
      if (!localUid || destroyed || deps.isPeerBanned(peerId)) {
        return
      }
      const records: AuthoritativeStateRecord[] = []
      for (const slot of userSlots.values()) {
        const entry = slot.entries.get(localUid)
        if (entry) {
          records.push(entry.record)
        }
      }
      if (records.length === 0) {
        return
      }
      const packed = packBatchRecords(records)
      const payload: PreJoinUserPayload = {p: packed.p, r: packed.r}
      await preJoinAction
        .send(payload as unknown as JsonValue, peerId)
        .catch(noOp)
    })()
  }

  const onPeerJoined = (
    peerId: string,
    userId: string,
    isDirect: boolean
  ): void => {
    if (destroyed) {
      return
    }
    let expiryChanged = false
    for (const slot of userSlots.values()) {
      const entry = slot.entries.get(userId)
      if (entry) {
        if (entry.expiresAt !== null) {
          entry.expiresAt = null
          expiryChanged = true
        }
        entry.lastTouched = Date.now()
        slot.snapshotOnline = null
      }
    }
    for (const slot of unregisteredSlots.values()) {
      if (slot.kind === 'u') {
        const cand = slot.byUser.get(userId)
        if (cand && cand.expiresAt !== null) {
          cand.expiresAt = null
          expiryChanged = true
        }
      }
    }
    if (expiryChanged) {
      scheduleExpiryTimer()
    }

    const staged = stagedPreJoinByPeer.get(peerId)
    if (staged) {
      stagedPreJoinByPeer.delete(peerId)
      for (const item of staged) {
        if (item.record.userId === userId) {
          applyVerifiedUserRecord(item.record, item.roles, item.byteLength)
          if (deps.getScaleProvider?.()?.getActiveMode() === 'gossip') {
            forwardAppliedRecordToOthers(item.record, peerId)
          }
        } else {
          deps.onInvalidRecord?.(peerId)
        }
      }
    }

    if (!isDirect || !stateAction) {
      return
    }
    const selfId = deps.getSelfId()
    const needInitialSync =
      completedSyncPeers.size + inFlightPullTimers.size < syncPullFanout
    const activeMode = deps.getScaleProvider?.()?.getActiveMode() ?? 'mesh'
    if (needInitialSync) {
      sendPullToPeer(peerId)
      return
    }
    if (selfId && selfId < peerId) {
      if (activeMode === 'gossip') {
        sendPullToPeer(peerId)
        return
      }
      const top2 = getPreferredDirectNeighbors().slice(0, syncPullFanout)
      if (top2.includes(peerId)) {
        sendPullToPeer(peerId)
      }
    }
  }

  const onPeerDisconnected = (peerId: string): void => {
    for (const slot of userSlots.values()) {
      slot.snapshotOnline = null
    }
    const timer = inFlightPullTimers.get(peerId)
    if (timer !== undefined) {
      clearTimeout(timer)
      inFlightPullTimers.delete(peerId)
    }
    completedSyncPeers.delete(peerId)
    stagedPreJoinByPeer.delete(peerId)
    pendingPreJoinByPeer.delete(peerId)
    if (!destroyed && completedSyncPeers.size < syncPullFanout) {
      for (const candidate of getPreferredDirectNeighbors()) {
        if (
          !completedSyncPeers.has(candidate) &&
          !inFlightPullTimers.has(candidate)
        ) {
          sendPullToPeer(candidate)
          if (
            completedSyncPeers.size + inFlightPullTimers.size >=
            syncPullFanout
          ) {
            break
          }
        }
      }
    }
  }

  const onUserLeft = (userId: string): void => {
    if (destroyed || deps.isUserOnline(userId)) {
      return
    }
    const now = Date.now()
    const localUid = deps.getLocalUserId()
    let needsTimerUpdate = false

    for (const slot of userSlots.values()) {
      const entry = slot.entries.get(userId)
      if (!entry) {
        continue
      }
      slot.snapshotOnline = null
      if (slot.retain) {
        entry.expiresAt = now + slot.retain.ttlMs
        entry.lastTouched = now
        enforceOfflineMaxUsers(slot)
        needsTimerUpdate = true
      } else {
        slot.entries.delete(userId)
        setUserQuota(userId, slot.namespace, 0)
        slot.snapshotAll = null
        slot.emitChange(undefined, {
          prev: entry.value,
          peerId: entry.record.peerId,
          userId,
          roles: [...entry.roles],
          timestamp: now,
          self: Boolean(localUid && userId === localUid),
          online: false,
          removed: true
        })
      }
    }

    for (const [key, slot] of unregisteredSlots.entries()) {
      if (slot.kind !== 'u') {
        continue
      }
      const cand = slot.byUser.get(userId)
      if (!cand) {
        continue
      }
      if (cand.record.ret) {
        cand.expiresAt = now + cand.record.ret
        cand.lastTouched = now
        needsTimerUpdate = true
      } else {
        slot.byUser.delete(userId)
        slot.totalBytes = Math.max(0, slot.totalBytes - cand.byteLength)
        unregisteredTotalBytes = Math.max(
          0,
          unregisteredTotalBytes - cand.byteLength
        )
        setUserQuota(userId, slot.namespace, 0)
        if (slot.byUser.size === 0) {
          unregisteredSlots.delete(key)
        }
      }
    }

    if (needsTimerUpdate) {
      scheduleExpiryTimer()
    }
  }

  const purgeBannedUser = (bannedUid: string): void => {
    if (destroyed) {
      return
    }
    const now = Date.now()
    const localUid = deps.getLocalUserId()

    for (const slot of sharedSlots.values()) {
      if (slot.record?.userId === bannedUid) {
        const prevVal = slot.value
        slot.record = null
        slot.roles = []
        slot.prevValue = prevVal
        slot.value = slot.initialValue
        slot.emitChange(slot.initialValue, {
          prev: prevVal,
          peerId: deps.getSelfId(),
          userId: bannedUid,
          roles: [],
          timestamp: now
        })
      }
    }

    for (const slot of userSlots.values()) {
      const tomb = slot.tombstones.get(bannedUid)
      if (tomb) {
        slot.tombstones.delete(bannedUid)
        setUserQuota(bannedUid, slot.namespace, 0)
      }
      const entry = slot.entries.get(bannedUid)
      if (entry) {
        slot.entries.delete(bannedUid)
        if (localUid && bannedUid === localUid) {
          localPublishedUserCount = Math.max(0, localPublishedUserCount - 1)
        }
        setUserQuota(bannedUid, slot.namespace, 0)
        slot.snapshotAll = null
        slot.snapshotOnline = null
        slot.emitChange(undefined, {
          prev: entry.value,
          peerId: entry.record.peerId,
          userId: bannedUid,
          roles: [],
          timestamp: now,
          self: Boolean(localUid && bannedUid === localUid),
          online: false,
          removed: true
        })
      }
    }

    for (const [key, slot] of unregisteredSlots.entries()) {
      if (slot.kind === 's') {
        const kept = slot.candidates.filter(c => c.record.userId !== bannedUid)
        if (kept.length !== slot.candidates.length) {
          const nextBytes = kept.reduce((s, c) => s + c.byteLength, 0)
          unregisteredTotalBytes = Math.max(
            0,
            unregisteredTotalBytes - slot.totalBytes + nextBytes
          )
          if (kept.length === 0) {
            unregisteredSlots.delete(key)
          } else {
            slot.candidates = kept
            slot.totalBytes = nextBytes
          }
        }
      } else {
        const cand = slot.byUser.get(bannedUid)
        if (cand) {
          slot.byUser.delete(bannedUid)
          slot.totalBytes = Math.max(0, slot.totalBytes - cand.byteLength)
          unregisteredTotalBytes = Math.max(
            0,
            unregisteredTotalBytes - cand.byteLength
          )
          setUserQuota(bannedUid, slot.namespace, 0)
          if (slot.byUser.size === 0) {
            unregisteredSlots.delete(key)
          }
        }
      }
    }
    scheduleExpiryTimer()
  }

  return {
    makeState,
    makeUserState,
    verifyAndApplyStateRecord,
    sendPreJoinUserState,
    getPendingPreJoin: peerId => pendingPreJoinByPeer.get(peerId),
    onPeerJoined,
    onPeerDisconnected,
    onUserLeft,
    purgeBannedUser,
    clearPeer: peerId => {
      stagedPreJoinByPeer.delete(peerId)
      pendingPreJoinByPeer.delete(peerId)
      const timer = inFlightPullTimers.get(peerId)
      if (timer !== undefined) {
        clearTimeout(timer)
        inFlightPullTimers.delete(peerId)
      }
      completedSyncPeers.delete(peerId)
    },
    destroy: () => {
      destroyed = true
      expiryTimer = resetTimer(expiryTimer)
      for (const timer of inFlightPullTimers.values()) {
        clearTimeout(timer)
      }
      inFlightPullTimers.clear()
      completedSyncPeers.clear()
      stagedPreJoinByPeer.clear()
      pendingPreJoinByPeer.clear()
      for (const slot of sharedSlots.values()) {
        slot.clearListeners()
      }
      for (const slot of userSlots.values()) {
        slot.clearListeners()
      }
    }
  }
}
