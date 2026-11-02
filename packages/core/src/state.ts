import {hash32} from './crypto'
import {
  compactPubToJwk,
  getVerifiedPubKeyRecord,
  isValidUserId,
  jwkToCompactPub
} from './identity'
import {isValidSignalPeerId} from './signal-handler'
import {
  canonTag,
  canonicalizeAndMeasureJson,
  canonicalizeJson,
  createMonotonicClock,
  createTokenBucketLimiter,
  defaultMaxClockSkewMs,
  hasFiniteNums,
  signWith,
  verifySig,
  type StateSigner
} from './signed-record'
import type {
  ActionOptions,
  AuthoritativeStateRecord,
  AuthoritativeStateTombstoneRecord,
  AuthoritativeStateValueRecord,
  InternalAction,
  KernelRolesProvider,
  KernelScaleProvider
} from './internal-types'
import type {
  DataPayload,
  JsonValue,
  ReplayListenerOptions,
  RoleCertificate,
  SharedState,
  StateChangeContext,
  StateConfig,
  TargetPeers,
  UserIdentity,
  UserState,
  UserStateChangeContext,
  UserStateConfig,
  Widen
} from './types'
import {
  createBoundedCache,
  createBoundedSet,
  createEventEmitter,
  createWindowCounter,
  encodeBytes,
  entries,
  insufficientAuthPrefix,
  isObj,
  isPosSafeInt,
  isStr,
  isValidSig,
  keys,
  lockMethods,
  logErr,
  mkErr,
  noOp,
  requiresRolesErr,
  toJson,
  validateRoleCertificateShape
} from './utils'

export {
  canonicalizeJson,
  compactPubToJwk,
  defaultMaxClockSkewMs,
  hasFiniteNums,
  jwkToCompactPub,
  signWith,
  verifySig,
  type StateSigner
}

export const defaultMaxStateBytes: number = 16 * 1024
export const maxAllowedStateBytes: number = 64 * 1024
export const maxUserStateNamespacesPerUser = 32
export const maxUserStateBytesPerUser: number = 64 * 1024

const maxLiveRecordsPerSec = 20
const maxLiveRecordBurst = 25
const maxSyncRecordsPerBatch = 1_024
const maxSyncChunkBytes: number = 180 * 1024
const maxHandshakeStateBytes: number = 60 * 1024
const handshakeStateDeadlineMs = 400
const syncPullFanout = 2
const syncPullTimeoutMs = 1_500
const offlineStagingTtlMs = 5_000
const maxFlushRetries = 8
const tombstoneBytes = 32

const allowedRecordKeys = /*@__PURE__*/ new Set([
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
  'cert',
  'sig'
])

type UnsignedStateRecord<T = JsonValue> =
  AuthoritativeStateRecord<T> extends infer R
    ? R extends AuthoritativeStateRecord<T>
      ? Omit<R, 'sig'>
      : never
    : never

export const stateRecordPayload = (
  r: UnsignedStateRecord,
  canonVal?: string
): string =>
  canonTag('state', [
    r.v,
    r.k,
    r.appId,
    r.roomId,
    r.ns,
    r.hlc,
    r.peerId,
    r.userId,
    r.pub,
    r.del === true ? null : (canonVal ?? canonicalizeJson(r.val)),
    r.del === true ? 1 : 0,
    r.cert?.sig ?? ''
  ])

const validateAndMeasureRecord = (
  r: unknown,
  maxBytes = Number.POSITIVE_INFINITY
): {rec: AuthoritativeStateRecord; canonVal?: string; bytes: number} | null => {
  if (!isObj(r)) {
    return null
  }
  for (const k of keys(r)) {
    if (!allowedRecordKeys.has(k)) {
      return null
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
    !isValidSig(r['sig']) ||
    (r['cert'] !== undefined && !validateRoleCertificateShape(r['cert']))
  ) {
    return null
  }
  if (r['del'] !== undefined) {
    if (r['del'] !== true || r['k'] !== 'u' || r['val'] !== undefined) {
      return null
    }
    return {rec: r as AuthoritativeStateRecord, bytes: tombstoneBytes}
  }
  if (!('val' in r) || r['val'] === undefined) {
    return null
  }
  const measured = canonicalizeAndMeasureJson(r['val'], maxBytes)
  if (!measured.ok) {
    return null
  }
  return {
    rec: r as AuthoritativeStateRecord,
    canonVal: measured.json,
    bytes: measured.bytes
  }
}

export const validateStateRecordShape = (
  r: unknown
): r is AuthoritativeStateRecord => validateAndMeasureRecord(r) !== null

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
  cert?: RoleCertificate | null
}

const signStateRecordInternal = async <T = JsonValue>(
  signer: StateSigner,
  pubJwk: JsonWebKey,
  p: StateSignParams<T>,
  canonVal?: string
): Promise<AuthoritativeStateRecord<T>> => {
  const base = {
    v: 1 as const,
    appId: p.appId,
    roomId: p.roomId,
    ns: p.ns,
    hlc: p.hlc ?? Date.now(),
    peerId: p.peerId,
    userId: p.userId,
    pub: jwkToCompactPub(pubJwk),
    ...(p.cert ? {cert: p.cert} : {})
  }
  const u: UnsignedStateRecord<T> =
    p.del === true
      ? {...base, k: 'u', del: true}
      : {...base, k: p.kind ?? 's', val: p.val as T}
  const sig = await signWith(
    signer,
    stateRecordPayload(u as UnsignedStateRecord, canonVal)
  )
  return {...u, sig} as AuthoritativeStateRecord<T>
}

export function signStateRecord(
  signer: StateSigner,
  pubJwk: JsonWebKey,
  p: StateSignParams<never> & {del: true}
): Promise<AuthoritativeStateTombstoneRecord>
export function signStateRecord<T = JsonValue>(
  signer: StateSigner,
  pubJwk: JsonWebKey,
  p: StateSignParams<T> & {del?: false}
): Promise<AuthoritativeStateValueRecord<T>>
export function signStateRecord<T = JsonValue>(
  signer: StateSigner,
  pubJwk: JsonWebKey,
  p: StateSignParams<T>
): Promise<AuthoritativeStateRecord<T>>
export function signStateRecord<T = JsonValue>(
  signer: StateSigner,
  pubJwk: JsonWebKey,
  p: StateSignParams<T>
): Promise<AuthoritativeStateRecord<T>> {
  return signStateRecordInternal(signer, pubJwk, p)
}

const verifyRecordSigWithCanon = async (
  rec: AuthoritativeStateRecord,
  appId: string,
  roomId: string,
  clockSkewMs: number,
  canonVal?: string
): Promise<boolean> => {
  if (
    rec.appId !== appId ||
    rec.roomId !== roomId ||
    rec.hlc > Date.now() + clockSkewMs ||
    (rec.cert && (rec.cert.subUserId !== rec.userId || rec.hlc < rec.cert.iat))
  ) {
    return false
  }
  const signer = await getVerifiedPubKeyRecord(rec.pub)
  if (!signer || signer.userId !== rec.userId) {
    return false
  }
  return verifySig(rec.pub, stateRecordPayload(rec, canonVal), rec.sig)
}

export const verifyStateRecordSignature = async (
  rec: AuthoritativeStateRecord,
  appId: string,
  roomId: string,
  clockSkewMs: number = defaultMaxClockSkewMs
): Promise<boolean> => {
  const parsed = validateAndMeasureRecord(rec)
  return parsed
    ? verifyRecordSigWithCanon(
        parsed.rec,
        appId,
        roomId,
        clockSkewMs,
        parsed.canonVal
      )
    : false
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

type WireStateRecord = {
  v: 1
  k: 's' | 'u'
  ns: string
  hlc: number
  peerId: string
  userId: string
  pub?: string
  val?: JsonValue
  del?: true
  cert?: RoleCertificate
  sig: string
}

type DigestEntry = [hlc: number, sig8: string]

type StateControlMessage =
  | {t: 'rec'; r: WireStateRecord}
  | {t: 'pull'; d: Record<string, DigestEntry>}
  | {
      t: 'sync'
      p: Record<string, string>
      r: WireStateRecord[]
      w?: string[]
      u?: 1
    }

type PendingOp = {
  del?: true
  next?: JsonValue | ((prev: JsonValue) => JsonValue)
  res: () => void
  rej: (err: unknown) => void
}

type SlotEntry = {
  rec: AuthoritativeStateRecord
  val: JsonValue
  prev: JsonValue
  roles: string[]
  bytes: number
}

type SlotBase = {
  ns: string
  init: JsonValue
  reqRoles: string[] | null
  maxBytes: number
  entries: Map<string, SlotEntry>
  snap: Readonly<Record<string, JsonValue>> | null
  clear: () => void
  api: unknown
  ops: PendingOp[]
  flushP: Promise<void> | null
  stepP: Promise<void> | null
}

type SharedSlot = SlotBase & {
  kind: 's'
  validate?: (next: JsonValue, ctx: StateChangeContext<JsonValue>) => boolean
  emit: (val: JsonValue, ctx: StateChangeContext<JsonValue>) => void
}

type UserSlot = SlotBase & {
  kind: 'u'
  validate?: (
    next: JsonValue,
    ctx: UserStateChangeContext<JsonValue>
  ) => boolean
  emit: (
    val: JsonValue | undefined,
    ctx: UserStateChangeContext<JsonValue>
  ) => void
}

type Slot = SharedSlot | UserSlot

type StagedUserItem = {
  slot: UserSlot
  rec: AuthoritativeStateRecord
  roles: string[]
  bytes: number
  seenAt: number
}

export type HandshakeStatePayload = {
  ok: true
  p: Record<string, string>
  r: JsonValue[]
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
  isPeerActive: (peerId: string) => boolean
  isPeerPendingHandshake?: (peerId: string) => boolean
  isDirectPeer: (peerId: string) => boolean
  getDirectPeerIds: () => string[]
  isUserOnline: (userId: string) => boolean
  getKnownPeerUserId: (peerId: string) => string | undefined
  getPeerUserPub?: (peerId: string) => string | undefined
  isPeerBanned: (peerOrUserId: string) => boolean
  getPeerRoles: (peerOrUserId?: string) => string[]
  makeInternalAction?: <T extends DataPayload = DataPayload>(
    namespace: string,
    options?: Partial<ActionOptions>
  ) => InternalAction<T>
  onBroadcastRecord?: (rec: AuthoritativeStateRecord) => void
  onInvalidRecord?: (fromPeerId?: string) => void
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

export type StateManager = {
  makeState: RoomMakeState
  makeUserState: RoomMakeUserState
  verifyAndApplyStateRecord: (
    rec: AuthoritativeStateRecord,
    fromPeerId?: string
  ) => Promise<boolean>
  prepareHandshakeReady: (
    peerId: string
  ) => Promise<HandshakeStatePayload | undefined> | undefined
  stageHandshakeUserState: (
    peerId: string,
    payload: {p: Record<string, string>; r: unknown[]},
    onReady?: () => void
  ) => Promise<void>
  onPeerJoined: (peerId: string, userId: string, isDirect: boolean) => void
  onPeerDisconnected: (peerId: string) => void
  onUserLeft: (userId: string) => void
  purgeBannedUser: (userId: string) => void
  clearPeer: (peerId: string) => void
  destroy: () => void
}

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
  ...(rec.del === true ? {del: true} : {val: rec.val}),
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
        ? pubMap[uid]
        : ''
  const base = {
    v: raw['v'] as 1,
    appId,
    roomId,
    ns: raw['ns'] as string,
    hlc: raw['hlc'] as number,
    peerId: raw['peerId'] as string,
    userId: uid as string,
    pub,
    ...(raw['cert'] !== undefined
      ? {cert: raw['cert'] as RoleCertificate}
      : {}),
    sig: raw['sig'] as string
  }
  if (raw['del'] !== undefined) {
    if (raw['del'] !== true || raw['k'] !== 'u' || raw['val'] !== undefined) {
      return null
    }
    return {...base, k: 'u', del: true}
  }
  if ((raw['k'] !== 's' && raw['k'] !== 'u') || !('val' in raw)) {
    return null
  }
  return {...base, k: raw['k'], val: raw['val'] as JsonValue}
}

const validateSlotArgs = (
  ns: string,
  initialValue: JsonValue | undefined,
  maxBytes: number | undefined,
  rolesOpt: string | readonly string[] | undefined,
  rolesLoaded: boolean,
  defaultClosed: boolean,
  fnName: string,
  roleLabel: string
): {initVal: JsonValue; maxBytes: number; reqRoles: string[] | null} => {
  if (!isStr(ns) || ns.length > 256) {
    throw mkErr(`${fnName} requires a non-empty namespace string`)
  }
  const initVal = (
    initialValue === undefined ? null : initialValue
  ) as JsonValue
  if (!canonicalizeAndMeasureJson(initVal).ok) {
    throw mkErr(`state "${ns}" initialValue must be valid JSON`)
  }
  if (
    maxBytes !== undefined &&
    (!isPosSafeInt(maxBytes) || maxBytes > maxAllowedStateBytes)
  ) {
    throw mkErr(
      `state "${ns}" maxBytes must be a positive integer <= ${maxAllowedStateBytes}`
    )
  }
  if (rolesOpt !== undefined && !rolesLoaded) {
    throw requiresRolesErr(roleLabel)
  }
  let reqRoles: string[] | null = null
  if (rolesLoaded) {
    if (rolesOpt === undefined) {
      reqRoles = defaultClosed ? ['admin'] : null
    } else if (
      rolesOpt !== '*' &&
      !(Array.isArray(rolesOpt) && rolesOpt.includes('*'))
    ) {
      const list = (Array.isArray(rolesOpt) ? rolesOpt : [rolesOpt]).filter(
        Boolean
      )
      if (!list.length) {
        throw mkErr(`${roleLabel} roles must not be empty; use "*" for open`)
      }
      reqRoles = list
    }
  }
  return {initVal, maxBytes: maxBytes ?? defaultMaxStateBytes, reqRoles}
}

const getLiveEntry = (slot: Slot, key: string): SlotEntry | undefined => {
  const e = slot.entries.get(key)
  return e && !e.rec.del ? e : undefined
}

const estimateWireRecordBytes = (wire: WireStateRecord): number =>
  encodeBytes(toJson(wire)).byteLength + 120

export const createStateManager = (deps: StateManagerDeps): StateManager => {
  const slots = new Map<string, Slot>()
  const forwardedRecSigs = createBoundedSet(1_024)
  const liveRateLimiter = createTokenBucketLimiter(
    maxLiveRecordsPerSec,
    maxLiveRecordBurst,
    512
  )
  const syncQuota = createWindowCounter(512, 49)
  const stagedHs = new Map<string, StagedUserItem[]>()
  const pendingOfflineUserRecs = createBoundedCache<
    string,
    Map<string, StagedUserItem>
  >(128)
  const pendingJoinWaiters = new Map<
    string,
    {p: Promise<boolean>; res: (ok: boolean) => void; n: number}
  >()
  const completedSyncPeers = new Set<string>()
  const inFlightPullTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const clock = createMonotonicClock()

  let repullQueued = false
  let destroyed = false

  const resolvePendingJoin = (peerId: string, ok: boolean): void => {
    const w = pendingJoinWaiters.get(peerId)
    if (w) {
      pendingJoinWaiters.delete(peerId)
      w.res(ok)
    }
  }

  const waitPeerReady = (peerId: string): Promise<boolean> | false | null => {
    if (!deps.isPeerPendingHandshake?.(peerId)) {
      return deps.isPeerActive(peerId) ? null : false
    }
    let w = pendingJoinWaiters.get(peerId)
    if (!w) {
      let res!: (ok: boolean) => void
      const p = new Promise<boolean>(r => {
        res = r
      })
      w = {p, res, n: 0}
      pendingJoinWaiters.set(peerId, w)
    }
    if (w.n >= 8) {
      return false
    }
    w.n++
    return w.p
  }

  const withinUserQuota = (
    uid: string,
    target: Slot,
    nextBytes: number
  ): boolean => {
    let count = 0
    let bytes = nextBytes
    for (const s of slots.values()) {
      if (s.kind !== 'u' || s === target) {
        continue
      }
      const e = s.entries.get(uid)
      if (e) {
        count++
        bytes += e.bytes
      }
    }
    return (
      count < maxUserStateNamespacesPerUser && bytes <= maxUserStateBytesPerUser
    )
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
    removed: boolean,
    ts = rec.hlc,
    online = deps.isUserOnline(rec.userId)
  ): UserStateChangeContext<T> => {
    const localUid = deps.getLocalUserId()
    return {
      prev,
      peerId: rec.peerId,
      userId: rec.userId,
      roles: [...roles],
      timestamp: ts,
      self: Boolean(localUid && rec.userId === localUid),
      online,
      removed
    }
  }

  const isRecordAuthorizedNow = (
    rec: AuthoritativeStateRecord,
    reqRoles: readonly string[] | null
  ): boolean => {
    if (deps.isPeerBanned(rec.userId)) {
      return false
    }
    if (!reqRoles) {
      return true
    }
    const rp = deps.getRolesProvider()
    if (!rec.cert || !rp) {
      return false
    }
    const active = rp.getPeerRoles(rec.userId)
    return reqRoles.some(r => rec.cert!.roles.includes(r) && active.includes(r))
  }

  const evictEntry = (
    slot: Slot,
    key: string,
    entry: SlotEntry,
    now: number,
    roles: string[]
  ): void => {
    slot.entries.delete(key)
    slot.snap = null
    if (slot.kind === 's') {
      slot.emit(slot.init, {
        prev: entry.val,
        peerId: deps.getSelfId(),
        userId: entry.rec.userId,
        roles,
        timestamp: now
      })
    } else if (!entry.rec.del) {
      slot.emit(
        undefined,
        toUserCtx(entry.rec, entry.val, roles, true, now, false)
      )
    }
  }

  const stateAction = deps.makeInternalAction
    ? deps.makeInternalAction<JsonValue>('state', {
        receiveWhilePending: true,
        maxPayloadBytes: 256 * 1024
      })
    : null

  const sendState = (msg: StateControlMessage, targets?: TargetPeers): void => {
    if (stateAction) {
      void stateAction.send(msg as unknown as JsonValue, targets).catch(noOp)
    }
  }

  const broadcastLiveRecord = (rec: AuthoritativeStateRecord): void => {
    forwardedRecSigs.add(rec.sig)
    deps.onBroadcastRecord?.(rec)
    sendState({t: 'rec', r: toWireRecord(rec, true)})
  }

  const rebroadcastAppliedRecord = (
    rec: AuthoritativeStateRecord,
    excludePeerId: string
  ): void => {
    if (!stateAction || forwardedRecSigs.has(rec.sig)) {
      return
    }
    forwardedRecSigs.add(rec.sig)
    const msg: StateControlMessage = {t: 'rec', r: toWireRecord(rec, true)}
    if (deps.getScaleProvider?.()?.getActiveMode() === 'gossip') {
      sendState(msg)
      return
    }
    const targets = deps
      .getDirectPeerIds()
      .filter(pid => pid !== excludePeerId && !deps.isPeerBanned(pid))
    if (targets.length > 0) {
      sendState(msg, targets)
    }
  }

  const verifyParsedRecord = async (
    parsed: {rec: AuthoritativeStateRecord; canonVal?: string; bytes: number},
    reqRoles: readonly string[] | null,
    fromPeerId: string | undefined
  ): Promise<
    | {
        status: 'ok'
        rec: AuthoritativeStateRecord
        roles: string[]
        bytes: number
      }
    | {status: 'invalid'}
    | {status: 'dropped'}
  > => {
    const {rec, canonVal, bytes} = parsed
    if (
      !(await verifyRecordSigWithCanon(
        rec,
        deps.appId,
        deps.getRoomId(),
        defaultMaxClockSkewMs,
        canonVal
      ))
    ) {
      return {status: 'invalid'}
    }
    if (deps.isPeerBanned(rec.userId)) {
      return {status: 'dropped'}
    }
    const rp = deps.getRolesProvider()
    if (rp?.verifyStateRecordRoles) {
      const roleRes = await rp.verifyStateRecordRoles(rec, reqRoles, fromPeerId)
      if (!roleRes.valid) {
        return {status: 'dropped'}
      }
      clock.observe(rec.hlc)
      return {status: 'ok', rec, roles: roleRes.roles, bytes}
    }
    if (reqRoles && reqRoles.length > 0) {
      return {status: 'dropped'}
    }
    clock.observe(rec.hlc)
    return {status: 'ok', rec, roles: [], bytes}
  }

  const stageOfflineUserRecord = (
    slot: UserSlot,
    rec: AuthoritativeStateRecord,
    roles: string[],
    bytes: number
  ): void => {
    if (bytes > slot.maxBytes) {
      return
    }
    const now = Date.now()
    let byNs = pendingOfflineUserRecs.get(rec.userId)
    if (!byNs) {
      byNs = new Map()
      pendingOfflineUserRecs.set(rec.userId, byNs)
    } else if (
      !byNs.has(slot.ns) &&
      byNs.size >= maxUserStateNamespacesPerUser
    ) {
      return
    }
    const prev = byNs.get(slot.ns)
    if (
      prev &&
      now - prev.seenAt < offlineStagingTtlMs &&
      compareStateRecords(rec, prev.rec) <= 0
    ) {
      return
    }
    byNs.set(slot.ns, {slot, rec, roles: [...roles], bytes, seenAt: now})
  }

  const commitEntry = (
    slot: Slot,
    rec: AuthoritativeStateRecord,
    roles: string[],
    bytes: number,
    skipValidate = false,
    allowStageOffline = false
  ): SlotEntry | null => {
    const key = slot.kind === 's' ? '' : rec.userId
    if (slot.kind === 'u' && !deps.isUserOnline(key)) {
      if (allowStageOffline) {
        stageOfflineUserRecord(slot, rec, roles, bytes)
      }
      return null
    }
    const curRaw = slot.entries.get(key)
    if (curRaw && compareStateRecords(rec, curRaw.rec) <= 0) {
      return null
    }
    const curLive = curRaw && !curRaw.rec.del ? curRaw : undefined
    const prevVal = curLive ? curLive.val : slot.init

    if (rec.del) {
      if (slot.kind !== 'u' || !withinUserQuota(key, slot, bytes)) {
        return null
      }
      const next: SlotEntry = {
        rec,
        val: slot.init,
        prev: prevVal,
        roles: [...roles],
        bytes
      }
      slot.entries.set(key, next)
      if (curLive) {
        slot.snap = null
        slot.emit(undefined, toUserCtx(rec, prevVal, roles, true))
      }
      return next
    }

    if (
      bytes > slot.maxBytes ||
      (slot.kind === 'u' && !withinUserQuota(key, slot, bytes))
    ) {
      return null
    }
    const nextVal = rec.val
    const next: SlotEntry = {
      rec,
      val: nextVal,
      prev: prevVal,
      roles: [...roles],
      bytes
    }
    if (slot.kind === 's') {
      const ctx = toSharedCtx(rec, prevVal, roles)
      if (!skipValidate && slot.validate && !slot.validate(nextVal, ctx)) {
        return null
      }
      slot.entries.set(key, next)
      slot.snap = null
      slot.emit(nextVal, ctx)
      return next
    }

    const ctx = toUserCtx(rec, prevVal, roles, false)
    if (!skipValidate && slot.validate && !slot.validate(nextVal, ctx)) {
      return null
    }
    slot.entries.set(key, next)
    slot.snap = null
    slot.emit(nextVal, ctx)
    return next
  }

  const applyIncoming = async (
    rawRec: AuthoritativeStateRecord,
    fromPeerId: string | undefined,
    allowStageOffline = false
  ): Promise<SlotEntry | null> => {
    if (destroyed) {
      return null
    }
    const parsed = validateAndMeasureRecord(rawRec, maxAllowedStateBytes)
    if (!parsed) {
      deps.onInvalidRecord?.(fromPeerId)
      return null
    }
    const slot = slots.get(`${parsed.rec.k}:${parsed.rec.ns}`)
    if (!slot) {
      return null
    }
    const verified = await verifyParsedRecord(parsed, slot.reqRoles, fromPeerId)
    if (verified.status === 'invalid') {
      deps.onInvalidRecord?.(fromPeerId)
      return null
    }
    if (verified.status === 'dropped') {
      return null
    }
    return commitEntry(
      slot,
      verified.rec,
      verified.roles,
      verified.bytes,
      false,
      allowStageOffline
    )
  }

  const verifyAndApplyStateRecord = async (
    rec: AuthoritativeStateRecord,
    fromPeerId?: string
  ): Promise<boolean> => Boolean(await applyIncoming(rec, fromPeerId, false))

  const iterAuthorizedSlotEntries = function* (): Generator<
    [digestKey: string, entry: SlotEntry]
  > {
    for (const slot of slots.values()) {
      for (const [entryKey, entry] of slot.entries.entries()) {
        if (slot.kind === 'u' && !deps.isUserOnline(entryKey)) {
          continue
        }
        if (isRecordAuthorizedNow(entry.rec, slot.reqRoles)) {
          yield [
            slot.kind === 's'
              ? `s:${slot.ns}`
              : `u:${slot.ns}\u0000${entryKey}`,
            entry
          ]
        }
      }
    }
  }

  const buildDigestMap = (): Record<string, DigestEntry> => {
    const digest: Record<string, DigestEntry> = {}
    let count = 0
    for (const [dKey, entry] of iterAuthorizedSlotEntries()) {
      if (count >= maxSyncRecordsPerBatch) {
        break
      }
      digest[dKey] = [entry.rec.hlc, entry.rec.sig.slice(0, 8)]
      count++
    }
    return digest
  }

  const isRegisteredDigestKey = (k: string): boolean => {
    if (k.startsWith('s:')) {
      return slots.has(k)
    }
    if (k.startsWith('u:')) {
      const sep = k.indexOf('\u0000')
      return sep > 2 && slots.has(k.slice(0, sep))
    }
    return false
  }

  const sendSyncBatches = (
    peerId: string,
    records: AuthoritativeStateRecord[],
    wantKeys?: string[],
    propagate?: boolean
  ): void => {
    if (!stateAction || destroyed || !deps.isPeerActive(peerId)) {
      return
    }
    const capped = records.slice(0, maxSyncRecordsPerBatch)
    const wants =
      wantKeys && wantKeys.length > 0
        ? wantKeys.slice(0, maxSyncRecordsPerBatch)
        : undefined
    if (capped.length === 0) {
      sendState(
        {
          t: 'sync',
          p: {},
          r: [],
          ...(wants ? {w: wants} : {}),
          ...(propagate ? {u: 1} : {})
        },
        peerId
      )
      return
    }
    const chunks: Array<{p: Record<string, string>; r: WireStateRecord[]}> = []
    let curP: Record<string, string> = {}
    let curR: WireStateRecord[] = []
    let curBytes = 0
    for (const rec of capped) {
      const wire = toWireRecord(rec, false)
      const est = estimateWireRecordBytes(wire)
      if (curR.length > 0 && curBytes + est > maxSyncChunkBytes) {
        chunks.push({p: curP, r: curR})
        curP = {}
        curR = []
        curBytes = 0
      }
      curP[rec.userId] = rec.pub
      curR.push(wire)
      curBytes += est
    }
    if (curR.length > 0) {
      chunks.push({p: curP, r: curR})
    }
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!
      const isLast = i === chunks.length - 1
      sendState(
        {
          t: 'sync',
          p: chunk.p,
          r: chunk.r,
          ...(isLast && wants ? {w: wants} : {}),
          ...(propagate ? {u: 1} : {})
        },
        peerId
      )
    }
  }

  const getPreferredDirectNeighbors = (): string[] => {
    const selfId = deps.getSelfId()
    return deps
      .getDirectPeerIds()
      .filter(id => !deps.isPeerBanned(id))
      .sort((a, b) => {
        const ha = hash32(`${selfId}:${a}`)
        const hb = hash32(`${selfId}:${b}`)
        return ha !== hb ? ha - hb : a < b ? -1 : a > b ? 1 : 0
      })
  }

  const sendPullToPeer = (peerId: string): void => {
    if (
      !stateAction ||
      destroyed ||
      slots.size === 0 ||
      !deps.isDirectPeer(peerId) ||
      deps.isPeerBanned(peerId) ||
      inFlightPullTimers.has(peerId)
    ) {
      return
    }
    const timer = setTimeout(() => {
      inFlightPullTimers.delete(peerId)
      if (!destroyed && completedSyncPeers.size < syncPullFanout) {
        for (const cand of getPreferredDirectNeighbors()) {
          if (!completedSyncPeers.has(cand) && !inFlightPullTimers.has(cand)) {
            sendPullToPeer(cand)
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

  const scheduleRepull = (): void => {
    if (
      repullQueued ||
      destroyed ||
      !stateAction ||
      deps.getDirectPeerIds().length === 0
    ) {
      return
    }
    repullQueued = true
    queueMicrotask(() => {
      repullQueued = false
      if (destroyed || slots.size === 0) {
        return
      }
      completedSyncPeers.clear()
      for (const pid of getPreferredDirectNeighbors()) {
        if (
          completedSyncPeers.size + inFlightPullTimers.size >=
          syncPullFanout
        ) {
          break
        }
        sendPullToPeer(pid)
      }
    })
  }

  if (stateAction) {
    stateAction.onMessage((raw, fromPeerId) => {
      if (destroyed || deps.isPeerBanned(fromPeerId) || !isObj(raw)) {
        return
      }
      const msg = raw as unknown as StateControlMessage
      if (msg.t === 'rec') {
        if (!liveRateLimiter.consume(fromPeerId)) {
          return
        }
        const waitP = waitPeerReady(fromPeerId)
        if (waitP === false) {
          return
        }
        void (async () => {
          if (waitP && !(await waitP)) {
            return
          }
          let roomId = deps.getRoomId()
          try {
            roomId = (await deps.ensureReady()).roomId
          } catch {
            return
          }
          if (
            destroyed ||
            !deps.isPeerActive(fromPeerId) ||
            deps.isPeerBanned(fromPeerId)
          ) {
            return
          }
          const rec = fromWireRecord(msg.r, deps.appId, roomId)
          if (!rec) {
            deps.onInvalidRecord?.(fromPeerId)
            return
          }
          if (deps.isDirectPeer(fromPeerId) && rec.peerId === fromPeerId) {
            const knownUid = deps.getKnownPeerUserId(fromPeerId)
            if (knownUid && knownUid !== rec.userId) {
              deps.onInvalidRecord?.(fromPeerId)
              return
            }
          }
          await applyIncoming(rec, fromPeerId, true)
        })()
        return
      }

      if (msg.t === 'pull') {
        if (syncQuota.hit(fromPeerId) || !isObj(msg.d)) {
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
        const waitP = waitPeerReady(fromPeerId)
        if (waitP === false) {
          return
        }
        void (async () => {
          if (waitP && !(await waitP)) {
            return
          }
          try {
            await deps.ensureReady()
          } catch {
            return
          }
          if (
            destroyed ||
            !deps.isPeerActive(fromPeerId) ||
            deps.isPeerBanned(fromPeerId)
          ) {
            return
          }
          const localEntries = new Map(
            [...iterAuthorizedSlotEntries()].slice(0, maxSyncRecordsPerBatch)
          )
          const toSend: AuthoritativeStateRecord[] = []
          const wantKeys: string[] = []
          for (const [k, entry] of localEntries.entries()) {
            const localRec = entry.rec
            const rem = remoteDigest.get(k)
            if (
              !rem ||
              localRec.hlc > rem[0] ||
              (localRec.hlc === rem[0] && localRec.sig.slice(0, 8) !== rem[1])
            ) {
              toSend.push(localRec)
            }
          }
          for (const [k, rem] of remoteDigest.entries()) {
            if (!isRegisteredDigestKey(k)) {
              continue
            }
            const localRec = localEntries.get(k)?.rec
            const sig8 = localRec ? localRec.sig.slice(0, 8) : ''
            if (
              !localRec ||
              rem[0] > localRec.hlc ||
              (rem[0] === localRec.hlc && rem[1] !== sig8)
            ) {
              wantKeys.push(k)
            }
          }
          sendSyncBatches(fromPeerId, toSend, wantKeys)
        })()
        return
      }

      if (msg.t === 'sync') {
        if (
          syncQuota.hit(fromPeerId) ||
          !isObj(msg.p) ||
          !Array.isArray(msg.r)
        ) {
          return
        }
        if (msg.r.length > maxSyncRecordsPerBatch) {
          deps.onInvalidRecord?.(fromPeerId)
          return
        }
        const waitP = waitPeerReady(fromPeerId)
        if (waitP === false) {
          return
        }
        const t = inFlightPullTimers.get(fromPeerId)
        if (t !== undefined) {
          clearTimeout(t)
          inFlightPullTimers.delete(fromPeerId)
        }
        completedSyncPeers.add(fromPeerId)

        const pubMap = msg.p as Record<string, unknown>
        const propagate = msg.u === 1
        const wantList = Array.isArray(msg.w)
          ? msg.w
              .filter((x): x is string => typeof x === 'string')
              .slice(0, maxSyncRecordsPerBatch)
          : []

        void (async () => {
          if (waitP && !(await waitP)) {
            return
          }
          let roomId = deps.getRoomId()
          try {
            roomId = (await deps.ensureReady()).roomId
          } catch {
            return
          }
          if (
            destroyed ||
            !deps.isPeerActive(fromPeerId) ||
            deps.isPeerBanned(fromPeerId)
          ) {
            return
          }
          const shouldForward =
            propagate || deps.getScaleProvider?.()?.getActiveMode() === 'gossip'
          for (const wireRec of msg.r) {
            if (destroyed || deps.isPeerBanned(fromPeerId)) {
              return
            }
            const fullRec = fromWireRecord(wireRec, deps.appId, roomId, pubMap)
            if (!fullRec) {
              deps.onInvalidRecord?.(fromPeerId)
              return
            }
            const applied = await applyIncoming(fullRec, fromPeerId, true)
            if (applied && shouldForward) {
              rebroadcastAppliedRecord(applied.rec, fromPeerId)
            }
          }
          if (
            wantList.length > 0 &&
            !destroyed &&
            deps.isPeerActive(fromPeerId)
          ) {
            const wantSet = new Set(wantList)
            const pushRecs: AuthoritativeStateRecord[] = []
            for (const [dKey, entry] of iterAuthorizedSlotEntries()) {
              if (wantSet.has(dKey)) {
                pushRecs.push(entry.rec)
              }
            }
            if (pushRecs.length > 0) {
              sendSyncBatches(fromPeerId, pushRecs, undefined, true)
            }
          }
        })()
      }
    })
  }

  const obtainWriteAuth = async (
    reqRoles: readonly string[] | null,
    ns: string,
    uid: string
  ): Promise<{cert: RoleCertificate | null; roles: string[]}> => {
    const rp = deps.getRolesProvider()
    if (rp?.getStateWriteCert) {
      return rp.getStateWriteCert(reqRoles, ns)
    }
    if (reqRoles && reqRoles.length > 0) {
      throw mkErr(
        `${insufficientAuthPrefix} to update state "${ns}": requires [${reqRoles.join(', ')}]`
      )
    }
    return {cert: null, roles: deps.getPeerRoles(uid)}
  }

  const flushSlot = (slot: Slot): Promise<void> => {
    if (slot.flushP) {
      return slot.flushP
    }
    const p = (async () => {
      try {
        while (slot.ops.length > 0) {
          let doneStep!: () => void
          slot.stepP = new Promise<void>(r => {
            doneStep = r
          })
          try {
            let ready: {selfId: string; user: UserIdentity; roomId: string}
            let auth: {cert: RoleCertificate | null; roles: string[]}
            try {
              ready = await deps.ensureReady()
              auth = await obtainWriteAuth(
                slot.reqRoles,
                slot.ns,
                ready.user.userId
              )
            } catch (err) {
              for (const op of slot.ops.splice(0)) {
                op.rej(err)
              }
              continue
            }

            let remainingOps = slot.ops.splice(0)
            if (!remainingOps.length) {
              continue
            }
            const uid = ready.user.userId
            const entryKey = slot.kind === 's' ? '' : uid

            for (
              let attempt = 0;
              attempt < maxFlushRetries && remainingOps.length > 0;
              attempt++
            ) {
              const cur = getLiveEntry(slot, entryKey)
              let simVal = cur ? cur.val : slot.init
              let finalMode: 'set' | 'del' | null = null
              let finalBytes = 0
              let finalCanonJson: string | undefined
              const accepted: PendingOp[] = []
              const tentativeTs = Math.max(Date.now(), clock.peek() + 1)

              for (const op of remainingOps) {
                if (op.del) {
                  if (!withinUserQuota(uid, slot, tombstoneBytes)) {
                    op.rej(mkErr(`state "${slot.ns}" exceeds user quota`))
                    continue
                  }
                  simVal = slot.init
                  finalMode = 'del'
                  finalBytes = tombstoneBytes
                  finalCanonJson = undefined
                  accepted.push(op)
                  continue
                }
                let cand: JsonValue
                try {
                  cand =
                    typeof op.next === 'function'
                      ? op.next(simVal)
                      : (op.next as JsonValue)
                } catch (err) {
                  op.rej(err)
                  continue
                }
                const measured = canonicalizeAndMeasureJson(cand, slot.maxBytes)
                if (measured.ok === false) {
                  if (
                    measured.reason === 'max-bytes' &&
                    canonicalizeAndMeasureJson(cand).ok
                  ) {
                    op.rej(
                      mkErr(
                        `state "${slot.ns}" exceeds maxBytes (${slot.maxBytes})`
                      )
                    )
                  } else {
                    op.rej(
                      mkErr(
                        `state "${slot.ns}" value must contain only finite JSON numbers`
                      )
                    )
                  }
                  continue
                }
                const {bytes, json} = measured
                if (slot.kind === 'u' && !withinUserQuota(uid, slot, bytes)) {
                  op.rej(mkErr(`state "${slot.ns}" exceeds user quota`))
                  continue
                }
                if (slot.validate) {
                  const isValid =
                    slot.kind === 's'
                      ? slot.validate(cand, {
                          prev: simVal,
                          peerId: ready.selfId,
                          userId: uid,
                          roles: [...auth.roles],
                          timestamp: tentativeTs
                        })
                      : slot.validate(cand, {
                          prev: simVal,
                          peerId: ready.selfId,
                          userId: uid,
                          roles: [...auth.roles],
                          timestamp: tentativeTs,
                          self: true,
                          online: true,
                          removed: false
                        })
                  if (!isValid) {
                    op.rej(mkErr(`state validation failed for "${slot.ns}"`))
                    continue
                  }
                }
                simVal = cand
                finalMode = 'set'
                finalBytes = bytes
                finalCanonJson = json
                accepted.push(op)
              }

              if (!accepted.length || !finalMode) {
                remainingOps = []
                break
              }

              let rec: AuthoritativeStateRecord
              try {
                rec = await signStateRecordInternal(
                  ready.user.sign,
                  ready.user.signPubJwk,
                  {
                    kind: slot.kind,
                    appId: deps.appId,
                    roomId: ready.roomId,
                    ns: slot.ns,
                    hlc: clock.nextBounded(slot.ns),
                    peerId: ready.selfId,
                    userId: uid,
                    ...(finalMode === 'del' ? {del: true} : {val: simVal}),
                    cert: auth.cert
                  },
                  finalCanonJson
                )
              } catch (err) {
                for (const op of accepted) {
                  op.rej(err)
                }
                remainingOps = []
                break
              }

              if (destroyed) {
                for (const op of accepted) {
                  op.res()
                }
                remainingOps = []
                break
              }
              if (!isRecordAuthorizedNow(rec, slot.reqRoles)) {
                const err = mkErr(
                  `${insufficientAuthPrefix} to update state "${slot.ns}"`
                )
                for (const op of accepted) {
                  op.rej(err)
                }
                remainingOps = []
                break
              }

              const latestRaw = slot.entries.get(entryKey)
              if (latestRaw && compareStateRecords(rec, latestRaw.rec) <= 0) {
                clock.observe(latestRaw.rec.hlc)
                remainingOps = accepted
                continue
              }

              if (commitEntry(slot, rec, auth.roles, finalBytes, true)) {
                broadcastLiveRecord(rec)
              }
              for (const op of accepted) {
                op.res()
              }
              remainingOps = []
              break
            }

            if (remainingOps.length > 0) {
              const err = mkErr(
                `concurrent state contention exceeded for "${slot.ns}"`
              )
              for (const op of remainingOps) {
                op.rej(err)
              }
            }
          } finally {
            slot.stepP = null
            doneStep()
          }
        }
      } finally {
        slot.flushP = null
      }
    })()
    slot.flushP = p
    return p
  }

  const makeState: RoomMakeState = <T extends JsonValue = JsonValue>(
    namespace: string,
    initialValue?: T | null,
    config?: StateConfig<Widen<T>>
  ): SharedState<Widen<T>> => {
    type W = Widen<T>
    const mapKey = `s:${namespace}`
    const existing = slots.get(mapKey)
    if (existing) {
      return existing.api as SharedState<W>
    }
    const {initVal, maxBytes, reqRoles} = validateSlotArgs(
      namespace,
      initialValue as JsonValue | undefined,
      config?.maxBytes,
      config?.roles,
      deps.hasRolesPlugin() || Boolean(deps.getRolesProvider()),
      true,
      'makeState',
      'state role gating'
    )
    const emitter =
      createEventEmitter<[W, StateChangeContext<W>]>('state handler')
    const slot: SharedSlot = {
      kind: 's',
      ns: namespace,
      init: initVal,
      reqRoles,
      maxBytes,
      ...(config?.validate
        ? {
            validate: (next, ctx) =>
              config.validate!(next as W, ctx as StateChangeContext<W>)
          }
        : {}),
      entries: new Map(),
      snap: null,
      emit: (val, ctx) => emitter.emit(val as W, ctx as StateChangeContext<W>),
      clear: () => emitter.clear(),
      api: null,
      ops: [],
      flushP: null,
      stepP: null
    }
    const api = lockMethods(
      {
        get: () => (slot.entries.get('')?.val ?? slot.init) as W,
        set: (next: W | ((prev: W) => W)) =>
          new Promise<void>((res, rej) => {
            slot.ops.push({
              next: next as JsonValue | ((prev: JsonValue) => JsonValue),
              res,
              rej
            })
            void flushSlot(slot)
          }),
        getMeta: () => {
          const e = slot.entries.get('')
          return e ? toSharedCtx<W>(e.rec, e.prev as W, e.roles) : null
        },
        onChange: (
          handler: (value: W, context: StateChangeContext<W>) => unknown,
          options?: ReplayListenerOptions
        ) =>
          emitter.subscribe(handler, options, () => {
            const e = slot.entries.get('')
            return e
              ? [[e.val as W, toSharedCtx<W>(e.rec, e.prev as W, e.roles)]]
              : []
          })
      } satisfies SharedState<W>,
      ['onChange']
    )
    slot.api = api
    slots.set(mapKey, slot)
    scheduleRepull()
    return api
  }

  const makeUserState: RoomMakeUserState = <T extends JsonValue = JsonValue>(
    namespace: string,
    initialValue?: T | null,
    config?: UserStateConfig<Widen<T>>
  ): UserState<Widen<T>> => {
    type W = Widen<T>
    const mapKey = `u:${namespace}`
    const existing = slots.get(mapKey)
    if (existing) {
      return existing.api as UserState<W>
    }
    const {initVal, maxBytes, reqRoles} = validateSlotArgs(
      namespace,
      initialValue as JsonValue | undefined,
      config?.maxBytes,
      config?.roles,
      deps.hasRolesPlugin() || Boolean(deps.getRolesProvider()),
      false,
      'makeUserState',
      'user state role gating'
    )
    const emitter =
      createEventEmitter<[W | undefined, UserStateChangeContext<W>]>(
        'user state handler'
      )
    const slot: UserSlot = {
      kind: 'u',
      ns: namespace,
      init: initVal,
      reqRoles,
      maxBytes,
      ...(config?.validate
        ? {
            validate: (next, ctx) =>
              config.validate!(next as W, ctx as UserStateChangeContext<W>)
          }
        : {}),
      entries: new Map(),
      snap: null,
      emit: (val, ctx) =>
        emitter.emit(val as W | undefined, ctx as UserStateChangeContext<W>),
      clear: () => emitter.clear(),
      api: null,
      ops: [],
      flushP: null,
      stepP: null
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
      return getLiveEntry(slot, id) ? id : (deps.getKnownPeerUserId(id) ?? id)
    }
    const api = lockMethods(
      {
        get: (id?: string): W => {
          const uid = resolveTargetUid(id)
          return (
            uid !== undefined
              ? (getLiveEntry(slot, uid)?.val ?? slot.init)
              : slot.init
          ) as W
        },
        getAll: (): Readonly<Record<string, W>> => {
          if (!slot.snap) {
            const out: Record<string, JsonValue> = {}
            for (const [uid, entry] of slot.entries.entries()) {
              if (!entry.rec.del) {
                out[uid] = entry.val
              }
            }
            slot.snap = Object.freeze(out)
          }
          return slot.snap as Readonly<Record<string, W>>
        },
        has: (id?: string): boolean => {
          const uid = resolveTargetUid(id)
          return Boolean(uid !== undefined && getLiveEntry(slot, uid))
        },
        set: (next: W | ((prev: W) => W)) =>
          new Promise<void>((res, rej) => {
            slot.ops.push({
              next: next as JsonValue | ((prev: JsonValue) => JsonValue),
              res,
              rej
            })
            void flushSlot(slot)
          }),
        clear: () =>
          new Promise<void>((res, rej) => {
            slot.ops.push({del: true, res, rej})
            void flushSlot(slot)
          }),
        getMeta: (id?: string): UserStateChangeContext<W> | null => {
          const uid = resolveTargetUid(id)
          const e = uid ? getLiveEntry(slot, uid) : undefined
          return e ? toUserCtx<W>(e.rec, e.prev as W, e.roles, false) : null
        },
        onChange: (
          handler: (
            value: W | undefined,
            context: UserStateChangeContext<W>
          ) => unknown,
          options?: ReplayListenerOptions
        ) =>
          emitter.subscribe(handler, options, () => {
            const items: Array<[W | undefined, UserStateChangeContext<W>]> = []
            for (const e of slot.entries.values()) {
              if (!e.rec.del) {
                items.push([
                  e.val as W,
                  toUserCtx<W>(e.rec, e.prev as W, e.roles, false)
                ])
              }
            }
            return items
          })
      } satisfies UserState<W>,
      ['onChange']
    )
    slot.api = api
    slots.set(mapKey, slot)
    scheduleRepull()
    return api
  }

  const prepareHandshakeReady = (
    peerId: string
  ): Promise<HandshakeStatePayload | undefined> | undefined => {
    if (destroyed) {
      return undefined
    }
    const localUid = deps.getLocalUserId()
    let hasUserWork = false
    for (const s of slots.values()) {
      if (
        s.kind === 'u' &&
        (s.stepP ||
          s.ops.length > 0 ||
          Boolean(localUid && getLiveEntry(s, localUid)))
      ) {
        hasUserWork = true
        break
      }
    }
    if (!hasUserWork) {
      return undefined
    }
    return (async () => {
      try {
        const steps: Promise<void>[] = []
        for (const s of slots.values()) {
          if (s.kind === 'u') {
            if (!s.stepP && s.ops.length > 0) {
              void flushSlot(s)
            }
            if (s.stepP) {
              steps.push(s.stepP)
            }
          }
        }
        if (steps.length > 0) {
          let timer: ReturnType<typeof setTimeout> | undefined
          await Promise.race([
            Promise.allSettled(steps),
            new Promise<void>(r => {
              timer = setTimeout(r, handshakeStateDeadlineMs)
              ;(timer as {unref?: () => void}).unref?.()
            })
          ])
          if (timer !== undefined) {
            clearTimeout(timer)
          }
        }
        const uid = deps.getLocalUserId()
        if (!uid || destroyed || deps.isPeerBanned(peerId)) {
          return undefined
        }
        const p: Record<string, string> = {}
        const r: WireStateRecord[] = []
        let usedBytes = 0
        for (const s of slots.values()) {
          if (s.kind !== 'u') {
            continue
          }
          const e = getLiveEntry(s, uid)
          if (!e) {
            continue
          }
          const wire = toWireRecord(e.rec, false)
          const est = estimateWireRecordBytes(wire)
          if (usedBytes + est > maxHandshakeStateBytes) {
            continue
          }
          p[e.rec.userId] = e.rec.pub
          r.push(wire)
          usedBytes += est
        }
        return r.length > 0
          ? {ok: true as const, p, r: r as unknown as JsonValue[]}
          : undefined
      } catch (err) {
        DEV: logErr('handshake state', err)
        return undefined
      }
    })()
  }

  const stageHandshakeUserState = async (
    fromPeerId: string,
    payload: {p: Record<string, string>; r: unknown[]},
    onReady?: () => void
  ): Promise<void> => {
    try {
      if (
        destroyed ||
        deps.isPeerBanned(fromPeerId) ||
        !isObj(payload.p) ||
        !Array.isArray(payload.r) ||
        payload.r.length > maxUserStateNamespacesPerUser
      ) {
        if (
          !destroyed &&
          (!isObj(payload.p) ||
            !Array.isArray(payload.r) ||
            payload.r.length > maxUserStateNamespacesPerUser)
        ) {
          deps.onInvalidRecord?.(fromPeerId)
        }
        return
      }
      let roomId = deps.getRoomId()
      try {
        roomId = (await deps.ensureReady()).roomId
      } catch {
        return
      }
      const pubMap = payload.p as Record<string, unknown>
      const staged: StagedUserItem[] = []
      let totalBytes = 0
      const now = Date.now()
      for (const wireRec of payload.r) {
        if (destroyed || deps.isPeerBanned(fromPeerId)) {
          return
        }
        const rec = fromWireRecord(wireRec, deps.appId, roomId, pubMap)
        const parsed =
          rec && rec.k === 'u'
            ? validateAndMeasureRecord(rec, maxAllowedStateBytes)
            : null
        if (!parsed) {
          deps.onInvalidRecord?.(fromPeerId)
          return
        }
        const slot = slots.get(`u:${parsed.rec.ns}`)
        if (!slot || slot.kind !== 'u') {
          continue
        }
        const res = await verifyParsedRecord(parsed, slot.reqRoles, fromPeerId)
        if (res.status === 'invalid') {
          deps.onInvalidRecord?.(fromPeerId)
          return
        }
        if (res.status === 'dropped') {
          continue
        }
        totalBytes += res.bytes
        if (totalBytes > maxUserStateBytesPerUser) {
          return
        }
        staged.push({
          slot,
          rec: res.rec,
          roles: res.roles,
          bytes: res.bytes,
          seenAt: now
        })
      }
      if (!destroyed && !deps.isPeerBanned(fromPeerId) && staged.length > 0) {
        stagedHs.set(fromPeerId, staged)
      }
    } finally {
      onReady?.()
    }
  }

  const onPeerJoined = (
    peerId: string,
    userId: string,
    isDirect: boolean
  ): void => {
    if (destroyed) {
      return
    }
    const staged = stagedHs.get(peerId)
    if (staged) {
      stagedHs.delete(peerId)
      const isGossip = deps.getScaleProvider?.()?.getActiveMode() === 'gossip'
      for (const item of staged) {
        if (item.rec.userId === userId) {
          const entry = commitEntry(item.slot, item.rec, item.roles, item.bytes)
          if (entry && isGossip) {
            rebroadcastAppliedRecord(entry.rec, peerId)
          }
        } else {
          deps.onInvalidRecord?.(peerId)
        }
      }
    }

    const stagedOffline = pendingOfflineUserRecs.get(userId)
    if (stagedOffline) {
      pendingOfflineUserRecs.delete(userId)
      const now = Date.now()
      for (const item of stagedOffline.values()) {
        if (
          now - item.seenAt < offlineStagingTtlMs &&
          slots.get(`u:${item.slot.ns}`) === item.slot &&
          isRecordAuthorizedNow(item.rec, item.slot.reqRoles)
        ) {
          commitEntry(item.slot, item.rec, item.roles, item.bytes)
        }
      }
    }

    resolvePendingJoin(peerId, true)

    if (!isDirect || !stateAction || slots.size === 0) {
      return
    }
    if (
      completedSyncPeers.size + inFlightPullTimers.size < syncPullFanout ||
      deps.getScaleProvider?.()?.getActiveMode() === 'gossip'
    ) {
      sendPullToPeer(peerId)
    }
  }

  const clearPeerPull = (peerId: string): void => {
    stagedHs.delete(peerId)
    liveRateLimiter.delete(peerId)
    resolvePendingJoin(peerId, false)
    const timer = inFlightPullTimers.get(peerId)
    if (timer !== undefined) {
      clearTimeout(timer)
      inFlightPullTimers.delete(peerId)
    }
    completedSyncPeers.delete(peerId)
  }

  const onPeerDisconnected = (peerId: string): void => {
    clearPeerPull(peerId)
    if (
      !destroyed &&
      slots.size > 0 &&
      completedSyncPeers.size < syncPullFanout
    ) {
      for (const cand of getPreferredDirectNeighbors()) {
        if (!completedSyncPeers.has(cand) && !inFlightPullTimers.has(cand)) {
          sendPullToPeer(cand)
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
    pendingOfflineUserRecs.delete(userId)
    const now = Date.now()
    for (const slot of slots.values()) {
      if (slot.kind !== 'u') {
        continue
      }
      const entry = slot.entries.get(userId)
      if (entry) {
        evictEntry(slot, userId, entry, now, [...entry.roles])
      }
    }
  }

  const purgeBannedUser = (bannedUid: string): void => {
    if (destroyed) {
      return
    }
    pendingOfflineUserRecs.delete(bannedUid)
    const now = Date.now()
    for (const slot of slots.values()) {
      if (slot.kind === 's') {
        const entry = slot.entries.get('')
        if (entry?.rec.userId === bannedUid) {
          evictEntry(slot, '', entry, now, [])
        }
      } else {
        const entry = slot.entries.get(bannedUid)
        if (entry) {
          evictEntry(slot, bannedUid, entry, now, [])
        }
      }
    }
  }

  return {
    makeState,
    makeUserState,
    verifyAndApplyStateRecord,
    prepareHandshakeReady,
    stageHandshakeUserState,
    onPeerJoined,
    onPeerDisconnected,
    onUserLeft,
    purgeBannedUser,
    clearPeer: clearPeerPull,
    destroy: () => {
      destroyed = true
      for (const timer of inFlightPullTimers.values()) {
        clearTimeout(timer)
      }
      inFlightPullTimers.clear()
      completedSyncPeers.clear()
      stagedHs.clear()
      pendingOfflineUserRecs.clear()
      liveRateLimiter.clear()
      for (const w of pendingJoinWaiters.values()) {
        w.res(false)
      }
      pendingJoinWaiters.clear()
      for (const slot of slots.values()) {
        slot.clear()
      }
    }
  }
}
