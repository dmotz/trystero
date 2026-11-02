import {hash32} from './crypto'
import {
  compactPubToJwk,
  getVerifiedPubKeyRecord,
  isValidUserId,
  jwkToCompactPub
} from './identity'
import type {
  ActionOptions,
  AuthoritativeStateRecord,
  AuthoritativeStateTombstoneRecord,
  AuthoritativeStateValueRecord,
  InternalAction,
  KernelRolesProvider,
  KernelScaleProvider
} from './internal-types'
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
  type StateSigner,
  verifySig
} from './signed-record'
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
  cmpStr,
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
  resetTimer,
  toJson,
  unrefTimer,
  validateRoleCertificateShape
} from './utils'

export {
  canonicalizeJson,
  compactPubToJwk,
  defaultMaxClockSkewMs,
  hasFiniteNums,
  jwkToCompactPub,
  signWith,
  type StateSigner,
  verifySig
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

type ParsedRecord = [
  rec: AuthoritativeStateRecord,
  bytes: number,
  canonVal: string | undefined
]

const validateAndMeasureRecord = (
  r: unknown,
  maxBytes = Number.POSITIVE_INFINITY
): ParsedRecord | null => {
  if (!isObj(r) || keys(r).some(k => !allowedRecordKeys.has(k))) {
    return null
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
    return r['del'] === true && r['k'] === 'u' && r['val'] === undefined
      ? [r as AuthoritativeStateRecord, tombstoneBytes, undefined]
      : null
  }
  if (!('val' in r) || r['val'] === undefined) {
    return null
  }
  const measured = canonicalizeAndMeasureJson(r['val'], maxBytes)
  return Array.isArray(measured)
    ? [r as AuthoritativeStateRecord, measured[1], measured[0]]
    : null
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
  if (!signer || signer[6] !== rec.userId) {
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
    ? verifyRecordSigWithCanon(parsed[0], appId, roomId, clockSkewMs, parsed[2])
    : false
}

export const compareStateRecords = (
  a: AuthoritativeStateRecord,
  b: AuthoritativeStateRecord
): number =>
  a.hlc - b.hlc ||
  cmpStr(a.userId || a.peerId, b.userId || b.peerId) ||
  cmpStr(a.peerId, b.peerId) ||
  cmpStr(a.sig, b.sig)

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

type PendingOp = [
  del: boolean,
  next: JsonValue | ((prev: JsonValue) => JsonValue) | undefined,
  res: () => void,
  rej: (err: unknown) => void
]

type SlotEntry = [
  rec: AuthoritativeStateRecord,
  val: JsonValue,
  prev: JsonValue,
  roles: string[],
  bytes: number
]

type SlotBase = {
  n: string // ns
  i: JsonValue // init
  r: string[] | null // reqRoles
  b: number // maxBytes
  m: Map<string, SlotEntry> // entries
  s: Readonly<Record<string, JsonValue>> | null // snap
  c: () => void // clear
  a: unknown // api
  o: PendingOp[] // ops
  f: Promise<void> | null // flushP
  p: Promise<void> | null // stepP
}

type SharedSlot = SlotBase & {
  k: 's'
  v?: (next: JsonValue, ctx: StateChangeContext<JsonValue>) => boolean
  e: (val: JsonValue, ctx: StateChangeContext<JsonValue>) => void
}

type UserSlot = SlotBase & {
  k: 'u'
  v?: (next: JsonValue, ctx: UserStateChangeContext<JsonValue>) => boolean
  e: (
    val: JsonValue | undefined,
    ctx: UserStateChangeContext<JsonValue>
  ) => void
}

type Slot = SharedSlot | UserSlot

type StagedUserItem = [
  slot: UserSlot,
  rec: AuthoritativeStateRecord,
  roles: string[],
  bytes: number,
  seenAt: number
]

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
  if (!isObj(raw) || 'appId' in raw || 'roomId' in raw) {
    return null
  }
  const uid = raw['userId']
  const pub =
    raw['pub'] === undefined && isStr(uid) ? pubMap?.[uid] : raw['pub']
  return {...raw, appId, roomId, pub} as AuthoritativeStateRecord
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
): [initVal: JsonValue, maxBytes: number, reqRoles: string[] | null] => {
  if (!isStr(ns) || ns.length > 256) {
    throw mkErr(`${fnName} requires a non-empty namespace string`)
  }
  const initVal = (
    initialValue === undefined ? null : initialValue
  ) as JsonValue
  if (!Array.isArray(canonicalizeAndMeasureJson(initVal))) {
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
    } else {
      const raw = [rolesOpt].flat()
      if (!raw.includes('*')) {
        const list = raw.filter(Boolean)
        if (!list.length) {
          throw mkErr(`${roleLabel} roles must not be empty; use "*" for open`)
        }
        reqRoles = list
      }
    }
  }
  return [initVal, maxBytes ?? defaultMaxStateBytes, reqRoles]
}

const getLiveEntry = (slot: Slot, key: string): SlotEntry | undefined => {
  const e = slot.m.get(key)
  return e && !e[0].del ? e : undefined
}

const estimateWireRecordBytes = (wire: WireStateRecord): number =>
  encodeBytes(toJson(wire)).byteLength + 120

const sig8 = (rec: AuthoritativeStateRecord): string => rec.sig.slice(0, 8)
const quotaErr = (ns: string): Error =>
  mkErr(`state "${ns}" exceeds user quota`)

export const initStateManager = (
  appId: string,
  getRoomId: () => string,
  getSelfId: () => string,
  getLocalUserId: () => string,
  ensureReady: () => Promise<
    readonly [selfId: string, user: UserIdentity, roomId: string]
  >,
  hasRolesPlugin: () => boolean,
  getRolesProvider: () => KernelRolesProvider | null,
  getScaleProvider: (() => KernelScaleProvider | null) | undefined,
  isPeerActive: (peerId: string) => boolean,
  isPeerPendingHandshake: ((peerId: string) => boolean) | undefined,
  isDirectPeer: (peerId: string) => boolean,
  getDirectPeerIds: () => string[],
  isUserOnline: (userId: string) => boolean,
  getKnownPeerUserId: (peerId: string) => string | undefined,
  isPeerBanned: (peerOrUserId: string) => boolean,
  getPeerRoles: (peerOrUserId?: string) => string[],
  makeInternalAction:
    | (<T extends DataPayload = DataPayload>(
        namespace: string,
        options?: Partial<ActionOptions>
      ) => InternalAction<T>)
    | undefined,
  onInvalidRecord: ((fromPeerId?: string) => void) | undefined,
  onBroadcastRecord?: (rec: AuthoritativeStateRecord) => void
): readonly [
  makeState: RoomMakeState,
  makeUserState: RoomMakeUserState,
  prepareHandshakeReady: (
    peerId: string
  ) => Promise<HandshakeStatePayload | undefined> | undefined,
  stageHandshakeUserState: (
    peerId: string,
    payload: {p: Record<string, string>; r: unknown[]},
    onReady?: () => void
  ) => Promise<void>,
  onPeerJoined: (peerId: string, userId: string, isDirect: boolean) => void,
  onPeerDisconnected: (peerId: string) => void,
  onUserLeft: (userId: string) => void,
  purgeBannedUser: (userId: string) => void,
  clearPeer: (peerId: string) => void,
  destroy: () => void,
  verifyAndApplyStateRecord: (
    rec: AuthoritativeStateRecord,
    fromPeerId?: string
  ) => Promise<boolean>
] => {
  const slots = new Map<string, Slot>()
  const forwardedRecSigs = createBoundedSet(1_024)
  const [consumeLiveRate, deleteLiveRate, clearLiveRate] =
    createTokenBucketLimiter(maxLiveRecordsPerSec, maxLiveRecordBurst, 512)
  const [hitSyncQuota] = createWindowCounter(512, 49)
  const stagedHs = new Map<string, StagedUserItem[]>()
  const pendingOfflineUserRecs = createBoundedCache<
    string,
    Map<string, StagedUserItem>
  >(128)
  const pendingJoinWaiters = new Map<
    string,
    [p: Promise<boolean>, res: (ok: boolean) => void, n: number]
  >()
  const completedSyncPeers = new Set<string>()
  const inFlightPullTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const [peekClock, observeClock, , nextBoundedClock] = createMonotonicClock()

  let repullQueued = false
  let destroyed = false

  const resolvePendingJoin = (peerId: string, ok: boolean): void => {
    const w = pendingJoinWaiters.get(peerId)
    if (w) {
      pendingJoinWaiters.delete(peerId)
      w[1](ok)
    }
  }

  const waitPeerReady = (peerId: string): Promise<boolean> | false | null => {
    if (!isPeerPendingHandshake?.(peerId)) {
      return isPeerActive(peerId) ? null : false
    }
    let w = pendingJoinWaiters.get(peerId)
    if (!w) {
      let res!: (ok: boolean) => void
      const p = new Promise<boolean>(r => {
        res = r
      })
      w = [p, res, 0]
      pendingJoinWaiters.set(peerId, w)
    }
    if (w[2] >= 8) {
      return false
    }
    w[2]++
    return w[0]
  }

  const readyRoomForPeer = async (
    peerId: string,
    waitP: Promise<boolean> | null
  ): Promise<string | null> => {
    if (waitP && !(await waitP)) {
      return null
    }
    let roomId: string
    try {
      ;[, , roomId] = await ensureReady()
    } catch {
      return null
    }
    return destroyed || !isPeerActive(peerId) || isPeerBanned(peerId)
      ? null
      : roomId
  }

  const withinUserQuota = (
    uid: string,
    target: Slot,
    nextBytes: number
  ): boolean => {
    let count = 0
    let bytes = nextBytes
    for (const s of slots.values()) {
      if (s.k !== 'u' || s === target) {
        continue
      }
      const e = s.m.get(uid)
      if (e) {
        count++
        bytes += e[4]
      }
    }
    return (
      count < maxUserStateNamespacesPerUser && bytes <= maxUserStateBytesPerUser
    )
  }

  const mkCtxBase = <T = JsonValue>(
    prev: T,
    peerId: string,
    userId: string,
    roles: string[],
    timestamp: number
  ): StateChangeContext<T> => ({
    prev,
    peerId,
    userId,
    roles: [...roles],
    timestamp
  })

  const toSharedCtx = <T = JsonValue>(
    rec: AuthoritativeStateRecord,
    prev: T,
    roles: string[]
  ): StateChangeContext<T> =>
    mkCtxBase(prev, rec.peerId, rec.userId, roles, rec.hlc)

  const toUserCtx = <T = JsonValue>(
    rec: AuthoritativeStateRecord,
    prev: T,
    roles: string[],
    removed: boolean,
    ts = rec.hlc,
    online = isUserOnline(rec.userId)
  ): UserStateChangeContext<T> => {
    const localUid = getLocalUserId()
    return {
      ...mkCtxBase(prev, rec.peerId, rec.userId, roles, ts),
      self: Boolean(localUid && rec.userId === localUid),
      online,
      removed
    }
  }

  const isRecordAuthorizedNow = (
    rec: AuthoritativeStateRecord,
    reqRoles: readonly string[] | null
  ): boolean => {
    if (isPeerBanned(rec.userId)) {
      return false
    }
    if (!reqRoles) {
      return true
    }
    const rp = getRolesProvider()
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
    slot.m.delete(key)
    slot.s = null
    if (slot.k === 's') {
      slot.e(
        slot.i,
        mkCtxBase(entry[1], getSelfId(), entry[0].userId, roles, now)
      )
    } else if (!entry[0].del) {
      slot.e(undefined, toUserCtx(entry[0], entry[1], roles, true, now, false))
    }
  }

  const stateAction = makeInternalAction
    ? makeInternalAction<JsonValue>('state', {
        receiveWhilePending: true,
        maxPayloadBytes: 256 * 1024
      })
    : null

  const sendState = (msg: StateControlMessage, targets?: TargetPeers): void => {
    if (stateAction) {
      void stateAction.send(msg as unknown as JsonValue, targets).catch(noOp)
    }
  }

  const isGossipActive = (): boolean =>
    getScaleProvider?.()?.getActiveMode() === 'gossip'

  const broadcastLiveRecord = (rec: AuthoritativeStateRecord): void => {
    forwardedRecSigs.add(rec.sig)
    onBroadcastRecord?.(rec)
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
    if (isGossipActive()) {
      sendState(msg)
      return
    }
    const targets = getDirectPeerIds().filter(
      pid => pid !== excludePeerId && !isPeerBanned(pid)
    )
    if (targets.length > 0) {
      sendState(msg, targets)
    }
  }

  const verifyParsedRecord = async (
    [rec, bytes, canonVal]: ParsedRecord,
    reqRoles: readonly string[] | null,
    fromPeerId: string | undefined
  ): Promise<
    [rec: AuthoritativeStateRecord, roles: string[], bytes: number] | 0 | 1
  > => {
    if (
      !(await verifyRecordSigWithCanon(
        rec,
        appId,
        getRoomId(),
        defaultMaxClockSkewMs,
        canonVal
      ))
    ) {
      return 0
    }
    if (isPeerBanned(rec.userId)) {
      return 1
    }
    const rp = getRolesProvider()
    if (rp?.verifyStateRecordRoles) {
      const roleRes = await rp.verifyStateRecordRoles(rec, reqRoles, fromPeerId)
      if (!roleRes.valid) {
        return 1
      }
      observeClock(rec.hlc)
      return [rec, roleRes.roles, bytes]
    }
    if (reqRoles && reqRoles.length > 0) {
      return 1
    }
    observeClock(rec.hlc)
    return [rec, [], bytes]
  }

  const stageOfflineUserRecord = (
    slot: UserSlot,
    rec: AuthoritativeStateRecord,
    roles: string[],
    bytes: number
  ): void => {
    if (bytes > slot.b) {
      return
    }
    const now = Date.now()
    let byNs = pendingOfflineUserRecs.get(rec.userId)
    if (!byNs) {
      byNs = new Map()
      pendingOfflineUserRecs.set(rec.userId, byNs)
    } else if (
      !byNs.has(slot.n) &&
      byNs.size >= maxUserStateNamespacesPerUser
    ) {
      return
    }
    const prev = byNs.get(slot.n)
    if (
      prev &&
      now - prev[4] < offlineStagingTtlMs &&
      compareStateRecords(rec, prev[1]) <= 0
    ) {
      return
    }
    byNs.set(slot.n, [slot, rec, [...roles], bytes, now])
  }

  const commitEntry = (
    slot: Slot,
    rec: AuthoritativeStateRecord,
    roles: string[],
    bytes: number,
    skipValidate = false,
    allowStageOffline = false
  ): SlotEntry | null => {
    const key = slot.k === 's' ? '' : rec.userId
    if (slot.k === 'u' && !isUserOnline(key)) {
      if (allowStageOffline) {
        stageOfflineUserRecord(slot, rec, roles, bytes)
      }
      return null
    }
    const curRaw = slot.m.get(key)
    if (curRaw && compareStateRecords(rec, curRaw[0]) <= 0) {
      return null
    }
    const curLive = curRaw && !curRaw[0].del ? curRaw : undefined
    const prevVal = curLive ? curLive[1] : slot.i

    if (rec.del) {
      if (slot.k !== 'u' || !withinUserQuota(key, slot, bytes)) {
        return null
      }
      const next: SlotEntry = [rec, slot.i, prevVal, [...roles], bytes]
      slot.m.set(key, next)
      if (curLive) {
        slot.s = null
        slot.e(undefined, toUserCtx(rec, prevVal, roles, true))
      }
      return next
    }

    if (
      bytes > slot.b ||
      (slot.k === 'u' && !withinUserQuota(key, slot, bytes))
    ) {
      return null
    }
    const nextVal = rec.val
    const next: SlotEntry = [rec, nextVal, prevVal, [...roles], bytes]
    const ctx =
      slot.k === 's'
        ? toSharedCtx(rec, prevVal, roles)
        : toUserCtx(rec, prevVal, roles, false)
    if (!skipValidate && slot.v && !slot.v(nextVal, ctx as never)) {
      return null
    }
    slot.m.set(key, next)
    slot.s = null
    slot.e(nextVal, ctx as never)
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
      onInvalidRecord?.(fromPeerId)
      return null
    }
    const slot = slots.get(`${parsed[0].k}:${parsed[0].ns}`)
    if (!slot) {
      return null
    }
    const verified = await verifyParsedRecord(parsed, slot.r, fromPeerId)
    if (verified === 0) {
      onInvalidRecord?.(fromPeerId)
      return null
    }
    if (verified === 1) {
      return null
    }
    return commitEntry(
      slot,
      verified[0],
      verified[1],
      verified[2],
      false,
      allowStageOffline
    )
  }

  const iterAuthorizedSlotEntries = function* (): Generator<
    [digestKey: string, entry: SlotEntry]
  > {
    for (const slot of slots.values()) {
      for (const [entryKey, entry] of slot.m) {
        if (slot.k === 'u' && !isUserOnline(entryKey)) {
          continue
        }
        if (isRecordAuthorizedNow(entry[0], slot.r)) {
          yield [
            slot.k === 's' ? `s:${slot.n}` : `u:${slot.n}\u0000${entryKey}`,
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
      digest[dKey] = [entry[0].hlc, sig8(entry[0])]
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
    if (!stateAction || destroyed || !isPeerActive(peerId)) {
      return
    }
    const capped = records.slice(0, maxSyncRecordsPerBatch)
    const wants =
      wantKeys && wantKeys.length > 0
        ? wantKeys.slice(0, maxSyncRecordsPerBatch)
        : undefined
    const sendSyncMsg = (
      p: Record<string, string>,
      r: WireStateRecord[],
      includeWants?: boolean
    ): void =>
      sendState(
        {
          t: 'sync',
          p,
          r,
          ...(includeWants && wants ? {w: wants} : {}),
          ...(propagate ? {u: 1} : {})
        },
        peerId
      )
    if (!capped.length) {
      sendSyncMsg({}, [], true)
      return
    }
    const chunks: Array<[p: Record<string, string>, r: WireStateRecord[]]> = []
    let curP: Record<string, string> = {}
    let curR: WireStateRecord[] = []
    let curBytes = 0
    for (const rec of capped) {
      const wire = toWireRecord(rec, false)
      const est = estimateWireRecordBytes(wire)
      if (curR.length > 0 && curBytes + est > maxSyncChunkBytes) {
        chunks.push([curP, curR])
        curP = {}
        curR = []
        curBytes = 0
      }
      curP[rec.userId] = rec.pub
      curR.push(wire)
      curBytes += est
    }
    if (curR.length > 0) {
      chunks.push([curP, curR])
    }
    chunks.forEach(([p, r], i) => sendSyncMsg(p, r, i === chunks.length - 1))
  }

  const getPreferredDirectNeighbors = (): string[] => {
    const selfId = getSelfId()
    return getDirectPeerIds()
      .filter(id => !isPeerBanned(id))
      .sort(
        (a, b) =>
          hash32(`${selfId}:${a}`) - hash32(`${selfId}:${b}`) || cmpStr(a, b)
      )
  }

  const fillPullFanout = (): void => {
    for (const cand of getPreferredDirectNeighbors()) {
      if (completedSyncPeers.size + inFlightPullTimers.size >= syncPullFanout) {
        break
      }
      if (!completedSyncPeers.has(cand) && !inFlightPullTimers.has(cand)) {
        sendPullToPeer(cand)
      }
    }
  }

  const clearPullTimer = (peerId: string): void => {
    resetTimer(inFlightPullTimers.get(peerId))
    inFlightPullTimers.delete(peerId)
  }

  const sendPullToPeer = (peerId: string): void => {
    if (
      !stateAction ||
      destroyed ||
      slots.size === 0 ||
      !isDirectPeer(peerId) ||
      isPeerBanned(peerId) ||
      inFlightPullTimers.has(peerId)
    ) {
      return
    }
    const timer = setTimeout(() => {
      inFlightPullTimers.delete(peerId)
      if (!destroyed && completedSyncPeers.size < syncPullFanout) {
        fillPullFanout()
      }
    }, syncPullTimeoutMs)
    unrefTimer(timer)
    inFlightPullTimers.set(peerId, timer)

    const msg: StateControlMessage = {t: 'pull', d: buildDigestMap()}
    void stateAction
      .send(msg as unknown as JsonValue, peerId)
      .catch(() => clearPullTimer(peerId))
  }

  const scheduleRepull = (): void => {
    if (
      repullQueued ||
      destroyed ||
      !stateAction ||
      getDirectPeerIds().length === 0
    ) {
      return
    }
    repullQueued = true
    queueMicrotask(() => {
      repullQueued = false
      if (!destroyed && slots.size > 0) {
        completedSyncPeers.clear()
        fillPullFanout()
      }
    })
  }

  if (stateAction) {
    const runWhenReady = (
      peerId: string,
      fn: (roomId: string) => Promise<void> | void,
      onQueued?: () => void
    ): void => {
      const waitP = waitPeerReady(peerId)
      if (waitP === false) {
        return
      }
      onQueued?.()
      void readyRoomForPeer(peerId, waitP).then(rid => rid !== null && fn(rid))
    }

    stateAction.onMessage((raw, fromPeerId) => {
      if (destroyed || isPeerBanned(fromPeerId) || !isObj(raw)) {
        return
      }
      const msg = raw as unknown as StateControlMessage
      if (msg.t === 'rec') {
        if (!consumeLiveRate(fromPeerId)) {
          return
        }
        runWhenReady(fromPeerId, async roomId => {
          const rec = fromWireRecord(msg.r, appId, roomId)
          if (!rec) {
            onInvalidRecord?.(fromPeerId)
            return
          }
          if (isDirectPeer(fromPeerId) && rec.peerId === fromPeerId) {
            const knownUid = getKnownPeerUserId(fromPeerId)
            if (knownUid && knownUid !== rec.userId) {
              onInvalidRecord?.(fromPeerId)
              return
            }
          }
          await applyIncoming(rec, fromPeerId, true)
        })
        return
      }

      if (msg.t === 'pull') {
        if (hitSyncQuota(fromPeerId) || !isObj(msg.d)) {
          return
        }
        const dEntries = entries(msg.d as Record<string, unknown>)
        if (dEntries.length > maxSyncRecordsPerBatch) {
          onInvalidRecord?.(fromPeerId)
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
            onInvalidRecord?.(fromPeerId)
            return
          }
          remoteDigest.set(k, [v[0], v[1]])
        }
        runWhenReady(fromPeerId, () => {
          const localEntries = new Map(
            [...iterAuthorizedSlotEntries()].slice(0, maxSyncRecordsPerBatch)
          )
          const isNewerDigest = (
            hA: number,
            sA: string,
            hB: number,
            sB: string
          ): boolean => hA > hB || (hA === hB && sA !== sB)
          const toSend: AuthoritativeStateRecord[] = []
          const wantKeys: string[] = []
          for (const [k, entry] of localEntries) {
            const localRec = entry[0]
            const rem = remoteDigest.get(k)
            if (
              !rem ||
              isNewerDigest(localRec.hlc, sig8(localRec), rem[0], rem[1])
            ) {
              toSend.push(localRec)
            }
          }
          for (const [k, rem] of remoteDigest) {
            if (!isRegisteredDigestKey(k)) {
              continue
            }
            const localRec = localEntries.get(k)?.[0]
            if (
              !localRec ||
              isNewerDigest(rem[0], rem[1], localRec.hlc, sig8(localRec))
            ) {
              wantKeys.push(k)
            }
          }
          sendSyncBatches(fromPeerId, toSend, wantKeys)
        })
        return
      }

      if (msg.t === 'sync') {
        if (
          hitSyncQuota(fromPeerId) ||
          !isObj(msg.p) ||
          !Array.isArray(msg.r)
        ) {
          return
        }
        if (msg.r.length > maxSyncRecordsPerBatch) {
          onInvalidRecord?.(fromPeerId)
          return
        }
        const pubMap = msg.p as Record<string, unknown>
        const propagate = msg.u === 1
        const wantList = Array.isArray(msg.w)
          ? msg.w.filter(isStr).slice(0, maxSyncRecordsPerBatch)
          : []

        runWhenReady(
          fromPeerId,
          async roomId => {
            const shouldForward = propagate || isGossipActive()
            for (const wireRec of msg.r) {
              if (destroyed || isPeerBanned(fromPeerId)) {
                return
              }
              const fullRec = fromWireRecord(wireRec, appId, roomId, pubMap)
              if (!fullRec) {
                onInvalidRecord?.(fromPeerId)
                return
              }
              const applied = await applyIncoming(fullRec, fromPeerId, true)
              if (applied && shouldForward) {
                rebroadcastAppliedRecord(applied[0], fromPeerId)
              }
            }
            if (wantList.length > 0 && !destroyed && isPeerActive(fromPeerId)) {
              const wantSet = new Set(wantList)
              const pushRecs: AuthoritativeStateRecord[] = []
              for (const [dKey, entry] of iterAuthorizedSlotEntries()) {
                if (wantSet.has(dKey)) {
                  pushRecs.push(entry[0])
                }
              }
              if (pushRecs.length > 0) {
                sendSyncBatches(fromPeerId, pushRecs, undefined, true)
              }
            }
          },
          () => {
            clearPullTimer(fromPeerId)
            completedSyncPeers.add(fromPeerId)
          }
        )
      }
    })
  }

  const obtainWriteAuth = async (
    reqRoles: readonly string[] | null,
    ns: string,
    uid: string
  ): Promise<[cert: RoleCertificate | null, roles: string[]]> => {
    const rp = getRolesProvider()
    if (rp?.getStateWriteCert) {
      const res = await rp.getStateWriteCert(reqRoles, ns)
      return [res.cert, res.roles]
    }
    if (reqRoles && reqRoles.length > 0) {
      throw mkErr(
        `${insufficientAuthPrefix} to update state "${ns}": requires [${reqRoles.join(', ')}]`
      )
    }
    return [null, getPeerRoles(uid)]
  }

  const rejectOps = (ops: PendingOp[], err: unknown): void => {
    for (const op of ops) {
      op[3](err)
    }
  }

  const flushSlot = (slot: Slot): Promise<void> => {
    if (slot.f) {
      return slot.f
    }
    const p = (async () => {
      try {
        while (slot.o.length > 0) {
          let doneStep!: () => void
          slot.p = new Promise<void>(r => {
            doneStep = r
          })
          try {
            let readySelfId: string
            let readyUser: UserIdentity
            let readyRoomId: string
            let authCert: RoleCertificate | null
            let authRoles: string[]
            try {
              ;[readySelfId, readyUser, readyRoomId] = await ensureReady()
              ;[authCert, authRoles] = await obtainWriteAuth(
                slot.r,
                slot.n,
                readyUser.userId
              )
            } catch (err) {
              rejectOps(slot.o.splice(0), err)
              continue
            }

            let remainingOps = slot.o.splice(0)
            if (!remainingOps.length) {
              continue
            }
            const uid = readyUser.userId
            const entryKey = slot.k === 's' ? '' : uid

            for (
              let attempt = 0;
              attempt < maxFlushRetries && remainingOps.length > 0;
              attempt++
            ) {
              const cur = getLiveEntry(slot, entryKey)
              let simVal = cur ? cur[1] : slot.i
              let finalMode: 'set' | 'del' | null = null
              let finalBytes = 0
              let finalCanonJson: string | undefined
              const accepted: PendingOp[] = []
              const tentativeTs = Math.max(Date.now(), peekClock() + 1)

              for (const op of remainingOps) {
                if (op[0]) {
                  if (!withinUserQuota(uid, slot, tombstoneBytes)) {
                    op[3](quotaErr(slot.n))
                    continue
                  }
                  simVal = slot.i
                  finalMode = 'del'
                  finalBytes = tombstoneBytes
                  finalCanonJson = undefined
                  accepted.push(op)
                  continue
                }
                let cand: JsonValue
                try {
                  cand =
                    typeof op[1] === 'function'
                      ? op[1](simVal)
                      : (op[1] as JsonValue)
                } catch (err) {
                  op[3](err)
                  continue
                }
                const measured = canonicalizeAndMeasureJson(cand, slot.b)
                if (!Array.isArray(measured)) {
                  op[3](
                    measured === 1 &&
                      Array.isArray(canonicalizeAndMeasureJson(cand))
                      ? mkErr(`state "${slot.n}" exceeds maxBytes (${slot.b})`)
                      : mkErr(
                          `state "${slot.n}" value must contain only finite JSON numbers`
                        )
                  )
                  continue
                }
                const [json, bytes] = measured
                if (slot.k === 'u' && !withinUserQuota(uid, slot, bytes)) {
                  op[3](quotaErr(slot.n))
                  continue
                }
                if (slot.v) {
                  const baseCtx = mkCtxBase(
                    simVal,
                    readySelfId,
                    uid,
                    authRoles,
                    tentativeTs
                  )
                  const isValid =
                    slot.k === 's'
                      ? slot.v(cand, baseCtx)
                      : slot.v(cand, {
                          ...baseCtx,
                          self: true,
                          online: true,
                          removed: false
                        })
                  if (!isValid) {
                    op[3](mkErr(`state validation failed for "${slot.n}"`))
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
                  readyUser.sign,
                  readyUser.signPubJwk,
                  {
                    kind: slot.k,
                    appId,
                    roomId: readyRoomId,
                    ns: slot.n,
                    hlc: nextBoundedClock(slot.n),
                    peerId: readySelfId,
                    userId: uid,
                    ...(finalMode === 'del' ? {del: true} : {val: simVal}),
                    cert: authCert
                  },
                  finalCanonJson
                )
              } catch (err) {
                rejectOps(accepted, err)
                remainingOps = []
                break
              }

              if (destroyed) {
                for (const op of accepted) {
                  op[2]()
                }
                remainingOps = []
                break
              }
              if (!isRecordAuthorizedNow(rec, slot.r)) {
                rejectOps(
                  accepted,
                  mkErr(`${insufficientAuthPrefix} to update state "${slot.n}"`)
                )
                remainingOps = []
                break
              }

              const latestRaw = slot.m.get(entryKey)
              if (latestRaw && compareStateRecords(rec, latestRaw[0]) <= 0) {
                observeClock(latestRaw[0].hlc)
                remainingOps = accepted
                continue
              }

              if (commitEntry(slot, rec, authRoles, finalBytes, true)) {
                broadcastLiveRecord(rec)
              }
              for (const op of accepted) {
                op[2]()
              }
              remainingOps = []
              break
            }

            if (remainingOps.length > 0) {
              rejectOps(
                remainingOps,
                mkErr(`concurrent state contention exceeded for "${slot.n}"`)
              )
            }
          } finally {
            slot.p = null
            doneStep()
          }
        }
      } finally {
        slot.f = null
      }
    })()
    slot.f = p
    return p
  }

  const enqueueSlotOp = (
    slot: Slot,
    del: boolean,
    next?: JsonValue | ((prev: JsonValue) => JsonValue)
  ): Promise<void> =>
    new Promise<void>((res, rej) => {
      slot.o.push([del, next, res, rej])
      void flushSlot(slot)
    })

  const initSlot = <K extends 's' | 'u', Args extends unknown[]>(
    k: K,
    namespace: string,
    initialValue: JsonValue | undefined,
    config:
      | {
          maxBytes?: number | undefined
          roles?: string | readonly string[] | undefined
          validate?: ((next: any, ctx: any) => boolean) | undefined
        }
      | undefined
  ) => {
    const isShared = k === 's'
    const label = isShared ? 'state' : 'user state'
    const [initVal, maxBytes, reqRoles] = validateSlotArgs(
      namespace,
      initialValue,
      config?.maxBytes,
      config?.roles,
      hasRolesPlugin() || Boolean(getRolesProvider()),
      isShared,
      isShared ? 'makeState' : 'makeUserState',
      `${label} role gating`
    )
    const [subEmitter, emitEmitter, clearEmitter] = createEventEmitter<Args>(
      `${label} handler`
    )
    const slot = {
      k,
      n: namespace,
      i: initVal,
      r: reqRoles,
      b: maxBytes,
      ...(config?.validate ? {v: config.validate} : {}),
      m: new Map<string, SlotEntry>(),
      s: null,
      e: emitEmitter,
      c: clearEmitter,
      a: null as unknown,
      o: [] as PendingOp[],
      f: null as Promise<void> | null,
      p: null as Promise<void> | null
    } as unknown as K extends 's' ? SharedSlot : UserSlot
    return [slot, subEmitter] as const
  }

  const registerSlot = <T>(mapKey: string, slot: Slot, api: T): T => {
    slot.a = api
    slots.set(mapKey, slot)
    scheduleRepull()
    return api
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
      return existing.a as SharedState<W>
    }
    const [slot, subEmitter] = initSlot<'s', [W, StateChangeContext<W>]>(
      's',
      namespace,
      initialValue as JsonValue | undefined,
      config
    )
    return registerSlot(
      mapKey,
      slot,
      lockMethods(
        {
          get: () => (slot.m.get('')?.[1] ?? slot.i) as W,
          set: (next: W | ((prev: W) => W)) =>
            enqueueSlotOp(
              slot,
              false,
              next as JsonValue | ((prev: JsonValue) => JsonValue)
            ),
          getMeta: () => {
            const e = slot.m.get('')
            return e ? toSharedCtx<W>(e[0], e[2] as W, e[3]) : null
          },
          onChange: (
            handler: (value: W, context: StateChangeContext<W>) => unknown,
            options?: ReplayListenerOptions
          ) =>
            subEmitter(handler, options, () => {
              const e = slot.m.get('')
              return e
                ? [[e[1] as W, toSharedCtx<W>(e[0], e[2] as W, e[3])]]
                : []
            })
        } satisfies SharedState<W>,
        ['onChange']
      )
    )
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
      return existing.a as UserState<W>
    }
    const [slot, subEmitter] = initSlot<
      'u',
      [W | undefined, UserStateChangeContext<W>]
    >('u', namespace, initialValue as JsonValue | undefined, config)
    const resolveTargetUid = (id?: string): string | undefined =>
      id === undefined || (id !== '' && id === getSelfId())
        ? getLocalUserId() || undefined
        : !id
          ? undefined
          : getLiveEntry(slot, id)
            ? id
            : (getKnownPeerUserId(id) ?? id)
    return registerSlot(
      mapKey,
      slot,
      lockMethods(
        {
          get: (id?: string): W => {
            const uid = resolveTargetUid(id)
            return (
              uid !== undefined
                ? (getLiveEntry(slot, uid)?.[1] ?? slot.i)
                : slot.i
            ) as W
          },
          getAll: (): Readonly<Record<string, W>> => {
            if (!slot.s) {
              const out: Record<string, JsonValue> = {}
              for (const [uid, entry] of slot.m) {
                if (!entry[0].del) {
                  out[uid] = entry[1]
                }
              }
              slot.s = Object.freeze(out)
            }
            return slot.s as Readonly<Record<string, W>>
          },
          has: (id?: string): boolean => {
            const uid = resolveTargetUid(id)
            return Boolean(uid !== undefined && getLiveEntry(slot, uid))
          },
          set: (next: W | ((prev: W) => W)) =>
            enqueueSlotOp(
              slot,
              false,
              next as JsonValue | ((prev: JsonValue) => JsonValue)
            ),
          clear: () => enqueueSlotOp(slot, true),
          getMeta: (id?: string): UserStateChangeContext<W> | null => {
            const uid = resolveTargetUid(id)
            const e = uid ? getLiveEntry(slot, uid) : undefined
            return e ? toUserCtx<W>(e[0], e[2] as W, e[3], false) : null
          },
          onChange: (
            handler: (
              value: W | undefined,
              context: UserStateChangeContext<W>
            ) => unknown,
            options?: ReplayListenerOptions
          ) =>
            subEmitter(handler, options, () => {
              const items: Array<[W | undefined, UserStateChangeContext<W>]> =
                []
              for (const e of slot.m.values()) {
                if (!e[0].del) {
                  items.push([
                    e[1] as W,
                    toUserCtx<W>(e[0], e[2] as W, e[3], false)
                  ])
                }
              }
              return items
            })
        } satisfies UserState<W>,
        ['onChange']
      )
    )
  }

  const prepareHandshakeReady = (
    peerId: string
  ): Promise<HandshakeStatePayload | undefined> | undefined => {
    if (destroyed) {
      return undefined
    }
    const localUid = getLocalUserId()
    let hasUserWork = false
    for (const s of slots.values()) {
      if (
        s.k === 'u' &&
        (s.p ||
          s.o.length > 0 ||
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
          if (s.k === 'u') {
            if (!s.p && s.o.length > 0) {
              void flushSlot(s)
            }
            if (s.p) {
              steps.push(s.p)
            }
          }
        }
        if (steps.length > 0) {
          let timer: ReturnType<typeof setTimeout> | undefined
          await Promise.race([
            Promise.allSettled(steps),
            new Promise<void>(r => {
              timer = setTimeout(r, handshakeStateDeadlineMs)
              unrefTimer(timer)
            })
          ])
          if (timer !== undefined) {
            clearTimeout(timer)
          }
        }
        const uid = getLocalUserId()
        if (!uid || destroyed || isPeerBanned(peerId)) {
          return undefined
        }
        const p: Record<string, string> = {}
        const r: WireStateRecord[] = []
        let usedBytes = 0
        for (const s of slots.values()) {
          if (s.k !== 'u') {
            continue
          }
          const e = getLiveEntry(s, uid)
          if (!e) {
            continue
          }
          const wire = toWireRecord(e[0], false)
          const est = estimateWireRecordBytes(wire)
          if (usedBytes + est > maxHandshakeStateBytes) {
            continue
          }
          p[e[0].userId] = e[0].pub
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
      const badShape =
        !isObj(payload.p) ||
        !Array.isArray(payload.r) ||
        payload.r.length > maxUserStateNamespacesPerUser
      if (destroyed || isPeerBanned(fromPeerId) || badShape) {
        if (!destroyed && badShape) {
          onInvalidRecord?.(fromPeerId)
        }
        return
      }
      let roomId: string
      try {
        ;[, , roomId] = await ensureReady()
      } catch {
        return
      }
      const pubMap = payload.p as Record<string, unknown>
      const staged: StagedUserItem[] = []
      let totalBytes = 0
      const now = Date.now()
      for (const wireRec of payload.r) {
        if (destroyed || isPeerBanned(fromPeerId)) {
          return
        }
        const rec = fromWireRecord(wireRec, appId, roomId, pubMap)
        const parsed =
          rec && rec.k === 'u'
            ? validateAndMeasureRecord(rec, maxAllowedStateBytes)
            : null
        if (!parsed) {
          onInvalidRecord?.(fromPeerId)
          return
        }
        const slot = slots.get(`u:${parsed[0].ns}`)
        if (!slot || slot.k !== 'u') {
          continue
        }
        const res = await verifyParsedRecord(parsed, slot.r, fromPeerId)
        if (res === 0) {
          onInvalidRecord?.(fromPeerId)
          return
        }
        if (res === 1) {
          continue
        }
        totalBytes += res[2]
        if (totalBytes > maxUserStateBytesPerUser) {
          return
        }
        staged.push([slot, res[0], res[1], res[2], now])
      }
      if (!destroyed && !isPeerBanned(fromPeerId) && staged.length > 0) {
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
      const isGossip = isGossipActive()
      for (const item of staged) {
        if (item[1].userId === userId) {
          const entry = commitEntry(item[0], item[1], item[2], item[3])
          if (entry && isGossip) {
            rebroadcastAppliedRecord(entry[0], peerId)
          }
        } else {
          onInvalidRecord?.(peerId)
        }
      }
    }

    const stagedOffline = pendingOfflineUserRecs.get(userId)
    if (stagedOffline) {
      pendingOfflineUserRecs.delete(userId)
      const now = Date.now()
      for (const item of stagedOffline.values()) {
        if (
          now - item[4] < offlineStagingTtlMs &&
          slots.get(`u:${item[0].n}`) === item[0] &&
          isRecordAuthorizedNow(item[1], item[0].r)
        ) {
          commitEntry(item[0], item[1], item[2], item[3])
        }
      }
    }

    resolvePendingJoin(peerId, true)

    if (
      isDirect &&
      stateAction &&
      slots.size > 0 &&
      (completedSyncPeers.size + inFlightPullTimers.size < syncPullFanout ||
        isGossipActive())
    ) {
      sendPullToPeer(peerId)
    }
  }

  const clearPeerPull = (peerId: string): void => {
    stagedHs.delete(peerId)
    deleteLiveRate(peerId)
    resolvePendingJoin(peerId, false)
    clearPullTimer(peerId)
    completedSyncPeers.delete(peerId)
  }

  const onPeerDisconnected = (peerId: string): void => {
    clearPeerPull(peerId)
    if (
      !destroyed &&
      slots.size > 0 &&
      completedSyncPeers.size < syncPullFanout
    ) {
      fillPullFanout()
    }
  }

  const onUserLeft = (userId: string): void => {
    if (destroyed || isUserOnline(userId)) {
      return
    }
    pendingOfflineUserRecs.delete(userId)
    const now = Date.now()
    for (const slot of slots.values()) {
      if (slot.k === 'u') {
        const entry = slot.m.get(userId)
        if (entry) {
          evictEntry(slot, userId, entry, now, [...entry[3]])
        }
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
      const key = slot.k === 's' ? '' : bannedUid
      const entry = slot.m.get(key)
      if (entry && (slot.k === 'u' || entry[0].userId === bannedUid)) {
        evictEntry(slot, key, entry, now, [])
      }
    }
  }

  return [
    makeState,
    makeUserState,
    prepareHandshakeReady,
    stageHandshakeUserState,
    onPeerJoined,
    onPeerDisconnected,
    onUserLeft,
    purgeBannedUser,
    clearPeerPull,
    () => {
      destroyed = true
      inFlightPullTimers.forEach(resetTimer)
      inFlightPullTimers.clear()
      completedSyncPeers.clear()
      stagedHs.clear()
      pendingOfflineUserRecs.clear()
      clearLiveRate()
      pendingJoinWaiters.forEach(w => w[1](false))
      pendingJoinWaiters.clear()
      slots.forEach(s => s.c())
    },
    async (rec, fromPeerId) => Boolean(await applyIncoming(rec, fromPeerId))
  ]
}

export const createStateManager = (deps: StateManagerDeps): StateManager => {
  const [
    makeState,
    makeUserState,
    prepareHandshakeReady,
    stageHandshakeUserState,
    onPeerJoined,
    onPeerDisconnected,
    onUserLeft,
    purgeBannedUser,
    clearPeer,
    destroy,
    verifyAndApplyStateRecord
  ] = initStateManager(
    deps.appId,
    deps.getRoomId,
    deps.getSelfId,
    deps.getLocalUserId,
    async () => {
      const r = await deps.ensureReady()
      return [r.selfId, r.user, r.roomId]
    },
    deps.hasRolesPlugin,
    deps.getRolesProvider,
    deps.getScaleProvider,
    deps.isPeerActive,
    deps.isPeerPendingHandshake,
    deps.isDirectPeer,
    deps.getDirectPeerIds,
    deps.isUserOnline,
    deps.getKnownPeerUserId,
    deps.isPeerBanned,
    deps.getPeerRoles,
    deps.makeInternalAction,
    deps.onInvalidRecord,
    deps.onBroadcastRecord
  )
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
    clearPeer,
    destroy
  }
}
