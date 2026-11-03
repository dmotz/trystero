import {
  compactPubToJwk,
  getVerifiedPubKeyRecord,
  isValidUserId,
  jwkToCompactPub
} from './identity'
import type {
  ActionOptions,
  AuthoritativeStateRecord,
  InternalAction,
  KernelRolesProvider,
  KernelScaleProvider,
  TargetPeers
} from './internal-types'
import {isValidSignalPeerId} from './signal-handler'
import {
  canonTag,
  canonicalizeAndMeasureJson,
  canonicalizeJson,
  createMonotonicClock,
  createTokenBucketLimiter,
  defaultMaxClockSkewMs,
  selectPullFanoutPeers,
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

const defaultMaxStateBytes: number = 16 * 1024
const maxAllowedStateBytes: number = 64 * 1024
export const maxUserStateNamespacesPerUser = 32
const maxUserStateBytesPerUser: number = 64 * 1024

const minSlotBroadcastIntervalMs = 40
const maxLiveRecordsPerSec = 60
const maxLiveRecordBurst = 120
const maxSyncRecordsPerBatch = 1_024
const maxPullPages = 16
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

const stateRecordPayload = (
  record: UnsignedStateRecord,
  canonVal?: string
): string =>
  canonTag('state', [
    record.v,
    record.k,
    record.appId,
    record.roomId,
    record.ns,
    record.hlc,
    record.peerId,
    record.userId,
    record.pub,
    record.del === true ? null : (canonVal ?? canonicalizeJson(record.val)),
    record.del === true ? 1 : 0,
    record.cert?.sig ?? ''
  ])

type ParsedRecord = {
  rec: AuthoritativeStateRecord
  bytes: number
  canonVal: string | undefined
}

const validateAndMeasureRecord = (
  raw: unknown,
  maxBytes = Number.POSITIVE_INFINITY
): ParsedRecord | null => {
  if (!isObj(raw) || keys(raw).some(k => !allowedRecordKeys.has(k))) {
    return null
  }
  if (
    raw['v'] !== 1 ||
    (raw['k'] !== 's' && raw['k'] !== 'u') ||
    !isStr(raw['appId']) ||
    !isStr(raw['roomId']) ||
    !isStr(raw['ns']) ||
    (raw['ns'] as string).length > 256 ||
    !isPosSafeInt(raw['hlc']) ||
    !isValidSignalPeerId(raw['peerId']) ||
    !isValidUserId(raw['userId'] as string) ||
    typeof raw['pub'] !== 'string' ||
    !compactPubToJwk(raw['pub']) ||
    !isValidSig(raw['sig']) ||
    (raw['cert'] !== undefined && !validateRoleCertificateShape(raw['cert']))
  ) {
    return null
  }
  if (raw['del'] !== undefined) {
    return raw['del'] === true && raw['k'] === 'u' && raw['val'] === undefined
      ? {
          rec: raw as AuthoritativeStateRecord,
          bytes: tombstoneBytes,
          canonVal: undefined
        }
      : null
  }
  if (!('val' in raw) || raw['val'] === undefined) {
    return null
  }
  const measured = canonicalizeAndMeasureJson(raw['val'], maxBytes)
  return Array.isArray(measured)
    ? {
        rec: raw as AuthoritativeStateRecord,
        bytes: measured[1],
        canonVal: measured[0]
      }
    : null
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
  cert?: RoleCertificate | null
}

export const signStateRecord = async <T = JsonValue>(
  signer: StateSigner,
  pubJwk: JsonWebKey,
  params: StateSignParams<T>,
  canonVal?: string
): Promise<AuthoritativeStateRecord<T>> => {
  const base = {
    v: 1 as const,
    appId: params.appId,
    roomId: params.roomId,
    ns: params.ns,
    hlc: params.hlc ?? Date.now(),
    peerId: params.peerId,
    userId: params.userId,
    pub: jwkToCompactPub(pubJwk),
    ...(params.cert ? {cert: params.cert} : {})
  }
  const unsigned: UnsignedStateRecord<T> =
    params.del === true
      ? {...base, k: 'u', del: true}
      : {...base, k: params.kind ?? 's', val: params.val as T}
  const sig = await signWith(
    signer,
    stateRecordPayload(unsigned as UnsignedStateRecord, canonVal)
  )
  return {...unsigned, sig} as AuthoritativeStateRecord<T>
}

export const compareStateRecords = (
  a: AuthoritativeStateRecord,
  b: AuthoritativeStateRecord
): number =>
  a.hlc - b.hlc ||
  cmpStr(a.userId, b.userId) ||
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
  | {t: 'pull'; d: Record<string, DigestEntry>; c?: string}
  | {
      t: 'sync'
      p: Record<string, string>
      r: WireStateRecord[]
      n?: string
    }

type PendingOp = {
  del: boolean
  next: JsonValue | ((prev: JsonValue) => JsonValue) | undefined
  resolve: () => void
  reject: (err: unknown) => void
}

type SlotEntry = {
  rec: AuthoritativeStateRecord
  value: JsonValue
  prev: JsonValue
  roles: string[]
  bytes: number
}

type SlotBase = {
  namespace: string
  initialValue: JsonValue
  requiredRoles: string[] | null
  maxBytes: number
  entries: Map<string, SlotEntry>
  snapshot: Readonly<Record<string, JsonValue>> | null
  clearListeners: () => void
  api: unknown
  ops: PendingOp[]
  flushPromise: Promise<void> | null
  stepPromise: Promise<void> | null
  lastBroadcastAt: number
  skipNextPace: boolean
  wakePace: (() => void) | null
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

type HandshakeStatePayload = {
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
  isPeerBanned: (peerOrUserId: string) => boolean
  getPeerRoles: (peerOrUserId?: string) => string[]
  makeInternalAction?: <T extends DataPayload = DataPayload>(
    namespace: string,
    options?: Partial<ActionOptions>
  ) => InternalAction<T>
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
  const entry = slot.entries.get(key)
  return entry && !entry.rec.del ? entry : undefined
}

const estimateWireRecordBytes = (wire: WireStateRecord): number =>
  encodeBytes(toJson(wire)).byteLength + 120

const sig8 = (rec: AuthoritativeStateRecord): string => rec.sig.slice(0, 8)
const quotaErr = (ns: string): Error =>
  mkErr(`state "${ns}" exceeds user quota`)

export const createStateManager = ({
  appId,
  getRoomId,
  getSelfId,
  getLocalUserId,
  ensureReady,
  hasRolesPlugin,
  getRolesProvider,
  getScaleProvider,
  isPeerActive,
  isPeerPendingHandshake,
  isDirectPeer,
  getDirectPeerIds,
  isUserOnline,
  getKnownPeerUserId,
  isPeerBanned,
  getPeerRoles,
  makeInternalAction,
  onInvalidRecord
}: StateManagerDeps): StateManager => {
  const slots = new Map<string, Slot>()
  const forwardedRecSigs = createBoundedSet(1_024)
  const liveRateLimiter = createTokenBucketLimiter(
    maxLiveRecordsPerSec,
    maxLiveRecordBurst,
    512
  )
  const [hitSyncQuota] = createWindowCounter(512, 49)
  const stagedHandshake = new Map<string, StagedUserItem[]>()
  const sentHandshakeSigs = new Map<string, Set<string>>()
  const pendingOfflineUserRecs = createBoundedCache<
    string,
    Map<string, StagedUserItem>
  >(128)
  const pendingJoinWaiters = new Map<
    string,
    {promise: Promise<boolean>; resolve: (ok: boolean) => void; count: number}
  >()
  const completedSyncPeers = new Set<string>()
  const inFlightPulls = new Map<
    string,
    {timer: ReturnType<typeof setTimeout>; pages: number}
  >()
  const clock = createMonotonicClock()

  let repullQueued = false
  let destroyed = false

  const isScaleActive = (): boolean => Boolean(getScaleProvider?.())

  const resolvePendingJoin = (peerId: string, ok: boolean): void => {
    const waiter = pendingJoinWaiters.get(peerId)
    if (waiter) {
      pendingJoinWaiters.delete(peerId)
      waiter.resolve(ok)
    }
  }

  const waitPeerReady = (peerId: string): Promise<boolean> | false | null => {
    if (!isPeerPendingHandshake?.(peerId)) {
      return isPeerActive(peerId) ? null : false
    }
    let waiter = pendingJoinWaiters.get(peerId)
    if (!waiter) {
      let resolve!: (ok: boolean) => void
      const promise = new Promise<boolean>(r => {
        resolve = r
      })
      waiter = {promise, resolve, count: 0}
      pendingJoinWaiters.set(peerId, waiter)
    }
    if (waiter.count >= 8) {
      return false
    }
    waiter.count++
    return waiter.promise
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
      ;({roomId} = await ensureReady())
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
    for (const slot of slots.values()) {
      if (slot.kind !== 'u' || slot === target) {
        continue
      }
      const entry = slot.entries.get(uid)
      if (entry) {
        count++
        bytes += entry.bytes
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
    if (!rp) {
      return false
    }
    const active = rp.getPeerRoles(rec.userId)
    if (rec.cert) {
      return reqRoles.some(
        r => rec.cert!.roles.includes(r) && active.includes(r)
      )
    }
    return reqRoles.some(r => active.includes(r))
  }

  const evictEntry = (
    slot: Slot,
    key: string,
    entry: SlotEntry,
    now: number,
    roles: string[]
  ): void => {
    slot.entries.delete(key)
    slot.snapshot = null
    if (slot.kind === 's') {
      slot.emit(
        slot.initialValue,
        mkCtxBase(entry.value, getSelfId(), entry.rec.userId, roles, now)
      )
    } else if (!entry.rec.del) {
      slot.emit(
        undefined,
        toUserCtx(entry.rec, entry.value, roles, true, now, false)
      )
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
      void stateAction
        .send(
          msg as unknown as JsonValue,
          targets === undefined ? undefined : {target: targets}
        )
        .catch(noOp)
    }
  }

  const broadcastLiveRecord = (rec: AuthoritativeStateRecord): void => {
    forwardedRecSigs.add(rec.sig)
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
    if (isScaleActive()) {
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
    {rec, bytes, canonVal}: ParsedRecord,
    reqRoles: readonly string[] | null,
    fromPeerId: string | undefined
  ): Promise<
    | {rec: AuthoritativeStateRecord; roles: string[]; bytes: number}
    | 'invalid'
    | 'drop'
  > => {
    const roomId = getRoomId()
    if (
      rec.appId !== appId ||
      rec.roomId !== roomId ||
      (rec.cert && rec.cert.subUserId !== rec.userId)
    ) {
      return 'invalid'
    }
    const signer = await getVerifiedPubKeyRecord(rec.pub)
    if (!signer || signer[6] !== rec.userId) {
      return 'invalid'
    }
    if (
      !(await verifySig(rec.pub, stateRecordPayload(rec, canonVal), rec.sig))
    ) {
      return 'invalid'
    }
    if (
      rec.hlc > Date.now() + defaultMaxClockSkewMs ||
      (rec.cert && rec.hlc < rec.cert.iat)
    ) {
      return 'drop'
    }
    if (isPeerBanned(rec.userId)) {
      return 'drop'
    }
    const rp = getRolesProvider()
    if (rp) {
      const roleRes = await rp.verifyStateRecordRoles(rec, reqRoles, fromPeerId)
      if (!roleRes.valid) {
        return 'drop'
      }
      clock.observe(rec.hlc)
      return {rec, roles: roleRes.roles, bytes}
    }
    if (reqRoles && reqRoles.length > 0) {
      return 'drop'
    }
    clock.observe(rec.hlc)
    return {rec, roles: [], bytes}
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
      !byNs.has(slot.namespace) &&
      byNs.size >= maxUserStateNamespacesPerUser
    ) {
      return
    }
    const prev = byNs.get(slot.namespace)
    if (
      prev &&
      now - prev.seenAt < offlineStagingTtlMs &&
      compareStateRecords(rec, prev.rec) <= 0
    ) {
      return
    }
    byNs.set(slot.namespace, {
      slot,
      rec,
      roles: [...roles],
      bytes,
      seenAt: now
    })
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
    if (slot.kind === 'u' && !isUserOnline(key)) {
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
    const prevVal = curLive ? curLive.value : slot.initialValue

    if (rec.del) {
      if (slot.kind !== 'u' || !withinUserQuota(key, slot, bytes)) {
        return null
      }
      const next: SlotEntry = {
        rec,
        value: slot.initialValue,
        prev: prevVal,
        roles: [...roles],
        bytes
      }
      slot.entries.set(key, next)
      if (curLive) {
        slot.snapshot = null
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
      value: nextVal,
      prev: prevVal,
      roles: [...roles],
      bytes
    }

    if (slot.kind === 's') {
      const ctx = toSharedCtx(rec, prevVal, roles)
      if (!skipValidate && slot.validate) {
        let valid = false
        try {
          valid = slot.validate(nextVal, ctx)
        } catch {
          valid = false
        }
        if (!valid) {
          return null
        }
      }
      slot.entries.set(key, next)
      slot.snapshot = null
      slot.emit(nextVal, ctx)
      return next
    }

    const ctx = toUserCtx(rec, prevVal, roles, false)
    if (!skipValidate && slot.validate) {
      let valid = false
      try {
        valid = slot.validate(nextVal, ctx)
      } catch {
        valid = false
      }
      if (!valid) {
        return null
      }
    }
    slot.entries.set(key, next)
    slot.snapshot = null
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
      onInvalidRecord?.(fromPeerId)
      return null
    }
    if (isPeerBanned(parsed.rec.userId)) {
      return null
    }
    const slot = slots.get(`${parsed.rec.k}:${parsed.rec.ns}`)
    if (!slot) {
      return null
    }
    if (!parsed.rec.del && parsed.bytes > slot.maxBytes) {
      return null
    }
    const entryKey = slot.kind === 's' ? '' : parsed.rec.userId
    if (slot.kind === 's' || isUserOnline(entryKey)) {
      const curRaw = slot.entries.get(entryKey)
      if (curRaw && compareStateRecords(parsed.rec, curRaw.rec) <= 0) {
        return null
      }
      if (!withinUserQuota(entryKey, slot, parsed.bytes) && slot.kind === 'u') {
        return null
      }
    }

    const verified = await verifyParsedRecord(
      parsed,
      slot.requiredRoles,
      fromPeerId
    )
    if (verified === 'invalid') {
      onInvalidRecord?.(fromPeerId)
      return null
    }
    if (verified === 'drop') {
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

  const getAuthorizedEntriesSorted = (): Array<
    [digestKey: string, entry: SlotEntry]
  > => {
    const list: Array<[string, SlotEntry]> = []
    for (const slot of slots.values()) {
      for (const [entryKey, entry] of slot.entries) {
        if (slot.kind === 'u' && !isUserOnline(entryKey)) {
          continue
        }
        if (isRecordAuthorizedNow(entry.rec, slot.requiredRoles)) {
          list.push([
            slot.kind === 's'
              ? `s:${slot.namespace}`
              : `u:${slot.namespace}\u0000${entryKey}`,
            entry
          ])
        }
      }
    }
    list.sort((a, b) => cmpStr(a[0], b[0]))
    return list
  }

  const buildDigestMap = (cursor?: string): Record<string, DigestEntry> => {
    const digest: Record<string, DigestEntry> = {}
    let count = 0
    for (const [dKey, entry] of getAuthorizedEntriesSorted()) {
      if (cursor !== undefined && cmpStr(dKey, cursor) <= 0) {
        continue
      }
      if (count >= maxSyncRecordsPerBatch) {
        break
      }
      digest[dKey] = [entry.rec.hlc, sig8(entry.rec)]
      count++
    }
    return digest
  }

  const sendSyncBatches = (
    peerId: string,
    records: AuthoritativeStateRecord[],
    nextCursor?: string
  ): void => {
    if (!stateAction || destroyed || !isPeerActive(peerId)) {
      return
    }
    const sendSyncMsg = (
      p: Record<string, string>,
      r: WireStateRecord[],
      includeCursor: boolean
    ): void =>
      sendState(
        {
          t: 'sync',
          p,
          r,
          ...(includeCursor && nextCursor ? {n: nextCursor} : {})
        },
        peerId
      )

    if (!records.length) {
      sendSyncMsg({}, [], true)
      return
    }
    const chunks: Array<[p: Record<string, string>, r: WireStateRecord[]]> = []
    let curP: Record<string, string> = {}
    let curR: WireStateRecord[] = []
    let curBytes = 0
    for (const rec of records) {
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

  const clearPullTimer = (peerId: string): void => {
    const pull = inFlightPulls.get(peerId)
    if (pull) {
      resetTimer(pull.timer)
      inFlightPulls.delete(peerId)
    }
  }

  const fillPullFanout = (): void => {
    for (const candidate of selectPullFanoutPeers(
      getSelfId(),
      getDirectPeerIds(),
      isPeerBanned
    )) {
      if (completedSyncPeers.size + inFlightPulls.size >= syncPullFanout) {
        break
      }
      if (!completedSyncPeers.has(candidate) && !inFlightPulls.has(candidate)) {
        sendPullToPeer(candidate)
      }
    }
  }

  const sendPullToPeer = (peerId: string, cursor?: string, pages = 0): void => {
    if (
      !stateAction ||
      destroyed ||
      slots.size === 0 ||
      pages >= maxPullPages ||
      !isDirectPeer(peerId) ||
      isPeerBanned(peerId) ||
      (cursor === undefined && inFlightPulls.has(peerId))
    ) {
      return
    }
    clearPullTimer(peerId)
    const timer = setTimeout(() => {
      inFlightPulls.delete(peerId)
      if (!destroyed && completedSyncPeers.size < syncPullFanout) {
        fillPullFanout()
      }
    }, syncPullTimeoutMs)
    unrefTimer(timer)
    inFlightPulls.set(peerId, {timer, pages: pages + 1})

    const msg: StateControlMessage = {
      t: 'pull',
      d: buildDigestMap(cursor),
      ...(cursor !== undefined ? {c: cursor} : {})
    }
    void stateAction
      .send(msg as unknown as JsonValue, {target: peerId})
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
      fn: (roomId: string) => Promise<void> | void
    ): void => {
      const waitP = waitPeerReady(peerId)
      if (waitP === false) {
        return
      }
      void readyRoomForPeer(peerId, waitP)
        .then(rid => (rid !== null ? fn(rid) : undefined))
        .catch(noOp)
    }

    stateAction.onMessage((raw, {peerId: fromPeerId}) => {
      if (destroyed || isPeerBanned(fromPeerId) || !isObj(raw)) {
        return
      }
      const msg = raw as unknown as StateControlMessage
      if (msg.t === 'rec') {
        if (!liveRateLimiter.consume(fromPeerId)) {
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
          const applied = await applyIncoming(rec, fromPeerId, true)
          if (applied && isScaleActive()) {
            rebroadcastAppliedRecord(applied.rec, fromPeerId)
          }
        })
        return
      }

      if (msg.t === 'pull') {
        if (hitSyncQuota(fromPeerId) || !isObj(msg.d)) {
          return
        }
        if (
          msg.c !== undefined &&
          (typeof msg.c !== 'string' || msg.c.length > 512)
        ) {
          onInvalidRecord?.(fromPeerId)
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
        const cursor = msg.c
        runWhenReady(fromPeerId, () => {
          const afterCursor = getAuthorizedEntriesSorted().filter(
            ([k]) => cursor === undefined || cmpStr(k, cursor) > 0
          )
          const page = afterCursor.slice(0, maxSyncRecordsPerBatch)
          const nextCursor =
            afterCursor.length > maxSyncRecordsPerBatch
              ? page[page.length - 1]![0]
              : undefined
          const isNewerDigest = (
            hA: number,
            sA: string,
            hB: number,
            sB: string
          ): boolean => hA > hB || (hA === hB && sA !== sB)
          const toSend: AuthoritativeStateRecord[] = []
          for (const [k, entry] of page) {
            const localRec = entry.rec
            const rem = remoteDigest.get(k)
            if (
              !rem ||
              isNewerDigest(localRec.hlc, sig8(localRec), rem[0], rem[1])
            ) {
              toSend.push(localRec)
            }
          }
          sendSyncBatches(fromPeerId, toSend, nextCursor)
          if (cursor === undefined && !inFlightPulls.has(fromPeerId)) {
            for (const [k, rem] of remoteDigest) {
              let slot: Slot | undefined
              let entryKey = ''
              if (k.startsWith('s:')) {
                const candidate = slots.get(k)
                if (candidate?.kind === 's') {
                  slot = candidate
                }
              } else if (k.startsWith('u:')) {
                const sep = k.indexOf('\u0000')
                if (sep > 2) {
                  const uid = k.slice(sep + 1)
                  const candidate = slots.get(k.slice(0, sep))
                  if (candidate?.kind === 'u' && isUserOnline(uid)) {
                    slot = candidate
                    entryKey = uid
                  }
                }
              }
              if (!slot) {
                continue
              }
              const localEntry = slot.entries.get(entryKey)
              const validLocal =
                localEntry &&
                isRecordAuthorizedNow(localEntry.rec, slot.requiredRoles)
                  ? localEntry.rec
                  : undefined
              if (
                !validLocal ||
                isNewerDigest(rem[0], rem[1], validLocal.hlc, sig8(validLocal))
              ) {
                sendPullToPeer(fromPeerId)
                break
              }
            }
          }
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
        if (
          msg.r.length > maxSyncRecordsPerBatch ||
          (msg.n !== undefined &&
            (typeof msg.n !== 'string' || msg.n.length > 512))
        ) {
          onInvalidRecord?.(fromPeerId)
          return
        }
        const pullState = inFlightPulls.get(fromPeerId)
        const nextCursor = msg.n
        if (pullState) {
          if (nextCursor) {
            sendPullToPeer(fromPeerId, nextCursor, pullState.pages)
          } else {
            clearPullTimer(fromPeerId)
            completedSyncPeers.add(fromPeerId)
          }
        }
        const pubMap = msg.p as Record<string, unknown>

        runWhenReady(fromPeerId, async roomId => {
          const shouldForward = isScaleActive()
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
              rebroadcastAppliedRecord(applied.rec, fromPeerId)
            }
          }
        })
      }
    })
  }

  const obtainWriteAuth = async (
    reqRoles: readonly string[] | null,
    ns: string,
    uid: string
  ): Promise<[cert: RoleCertificate | null, roles: string[]]> => {
    const rp = getRolesProvider()
    if (rp) {
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
      op.reject(err)
    }
  }

  const waitForSlotPace = (slot: Slot): Promise<void> | void => {
    if (slot.skipNextPace || slot.lastBroadcastAt <= 0 || destroyed) {
      slot.skipNextPace = false
      return
    }
    const waitMs =
      minSlotBroadcastIntervalMs - (Date.now() - slot.lastBroadcastAt)
    if (waitMs <= 0) {
      return
    }
    return new Promise<void>(resolve => {
      const finish = (): void => {
        slot.wakePace = null
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(finish, waitMs)
      unrefTimer(timer)
      slot.wakePace = finish
    })
  }

  const flushSlot = (slot: Slot): Promise<void> => {
    if (slot.flushPromise) {
      return slot.flushPromise
    }
    const p = (async () => {
      try {
        while (slot.ops.length > 0) {
          const paceWait = waitForSlotPace(slot)
          if (paceWait) {
            await paceWait
          }
          if (slot.ops.length === 0) {
            break
          }

          let doneStep!: () => void
          slot.stepPromise = new Promise<void>(r => {
            doneStep = r
          })
          try {
            let readySelfId: string
            let readyUser: UserIdentity
            let readyRoomId: string
            let authCert: RoleCertificate | null
            let authRoles: string[]
            try {
              ;({
                selfId: readySelfId,
                user: readyUser,
                roomId: readyRoomId
              } = await ensureReady())
              ;[authCert, authRoles] = await obtainWriteAuth(
                slot.requiredRoles,
                slot.namespace,
                readyUser.userId
              )
            } catch (err) {
              rejectOps(slot.ops.splice(0), err)
              continue
            }

            if (authCert) {
              clock.observe(authCert.iat)
            }

            let remainingOps = slot.ops.splice(0)
            if (!remainingOps.length) {
              continue
            }
            const uid = readyUser.userId
            const entryKey = slot.kind === 's' ? '' : uid

            for (
              let attempt = 0;
              attempt < maxFlushRetries && remainingOps.length > 0;
              attempt++
            ) {
              const curRaw = slot.entries.get(entryKey)
              const curLive = curRaw && !curRaw.rec.del ? curRaw : undefined
              let simVal = curLive ? curLive.value : slot.initialValue
              let finalMode: 'set' | 'del' | null = null
              let finalBytes = 0
              let finalCanonJson: string | undefined
              const accepted: PendingOp[] = []
              const minHlc = Math.max(
                (curRaw?.rec.hlc ?? 0) + 1,
                authCert?.iat ?? 0
              )
              const tentativeTs = Math.max(Date.now(), clock.peek() + 1, minHlc)

              for (const op of remainingOps) {
                if (op.del) {
                  if (!withinUserQuota(uid, slot, tombstoneBytes)) {
                    op.reject(quotaErr(slot.namespace))
                    continue
                  }
                  simVal = slot.initialValue
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
                  op.reject(err)
                  continue
                }
                const measured = canonicalizeAndMeasureJson(cand, slot.maxBytes)
                if (!Array.isArray(measured)) {
                  op.reject(
                    measured === 1 &&
                      Array.isArray(canonicalizeAndMeasureJson(cand))
                      ? mkErr(
                          `state "${slot.namespace}" exceeds maxBytes (${slot.maxBytes})`
                        )
                      : mkErr(
                          `state "${slot.namespace}" value must contain only finite JSON numbers`
                        )
                  )
                  continue
                }
                const [json, bytes] = measured
                if (slot.kind === 'u' && !withinUserQuota(uid, slot, bytes)) {
                  op.reject(quotaErr(slot.namespace))
                  continue
                }
                if (slot.validate) {
                  const baseCtx = mkCtxBase(
                    simVal,
                    readySelfId,
                    uid,
                    authRoles,
                    tentativeTs
                  )
                  let isValid = false
                  try {
                    isValid =
                      slot.kind === 's'
                        ? slot.validate(cand, baseCtx)
                        : slot.validate(cand, {
                            ...baseCtx,
                            self: true,
                            online: true,
                            removed: false
                          })
                  } catch (err) {
                    op.reject(err)
                    continue
                  }
                  if (!isValid) {
                    op.reject(
                      mkErr(`state validation failed for "${slot.namespace}"`)
                    )
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
                rec = await signStateRecord(
                  readyUser.sign,
                  readyUser.signPubJwk,
                  {
                    kind: slot.kind,
                    appId,
                    roomId: readyRoomId,
                    ns: slot.namespace,
                    hlc: clock.nextBounded(slot.namespace, minHlc),
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
                  op.resolve()
                }
                remainingOps = []
                break
              }
              if (!isRecordAuthorizedNow(rec, slot.requiredRoles)) {
                rejectOps(
                  accepted,
                  mkErr(
                    `${insufficientAuthPrefix} to update state "${slot.namespace}"`
                  )
                )
                remainingOps = []
                break
              }

              const latestRaw = slot.entries.get(entryKey)
              if (latestRaw && compareStateRecords(rec, latestRaw.rec) <= 0) {
                clock.observe(latestRaw.rec.hlc)
                remainingOps = accepted
                continue
              }

              if (commitEntry(slot, rec, authRoles, finalBytes, true)) {
                slot.lastBroadcastAt = Date.now()
                broadcastLiveRecord(rec)
              }
              for (const op of accepted) {
                op.resolve()
              }
              remainingOps = []
              break
            }

            if (remainingOps.length > 0) {
              rejectOps(
                remainingOps,
                mkErr(
                  `concurrent state contention exceeded for "${slot.namespace}"`
                )
              )
            }
          } finally {
            slot.stepPromise = null
            doneStep()
          }
        }
      } finally {
        slot.flushPromise = null
      }
    })()
    slot.flushPromise = p
    return p
  }

  const enqueueSlotOp = (
    slot: Slot,
    del: boolean,
    next?: JsonValue | ((prev: JsonValue) => JsonValue)
  ): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      slot.ops.push({del, next, resolve, reject})
      void flushSlot(slot)
    })

  const createSlotBase = (
    namespace: string,
    initialValue: JsonValue,
    requiredRoles: string[] | null,
    maxBytes: number,
    clearListeners: () => void
  ): SlotBase => ({
    namespace,
    initialValue,
    requiredRoles,
    maxBytes,
    entries: new Map<string, SlotEntry>(),
    snapshot: null,
    clearListeners,
    api: null,
    ops: [],
    flushPromise: null,
    stepPromise: null,
    lastBroadcastAt: 0,
    skipNextPace: false,
    wakePace: null
  })

  const registerSlot = <T>(mapKey: string, slot: Slot, api: T): T => {
    slot.api = api
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
      return existing.api as SharedState<W>
    }
    const [initVal, maxBytes, reqRoles] = validateSlotArgs(
      namespace,
      initialValue as JsonValue | undefined,
      config?.maxBytes,
      config?.roles,
      hasRolesPlugin() || Boolean(getRolesProvider()),
      true,
      'makeState',
      'state role gating'
    )
    const [subEmitter, emitEmitter, clearEmitter] =
      createEventEmitter<[W, StateChangeContext<W>]>('state handler')
    const validate = config?.validate as
      | ((next: JsonValue, ctx: StateChangeContext<JsonValue>) => boolean)
      | undefined
    const slot: SharedSlot = {
      ...createSlotBase(namespace, initVal, reqRoles, maxBytes, clearEmitter),
      kind: 's',
      ...(validate ? {validate} : {}),
      emit: emitEmitter as SharedSlot['emit']
    }
    return registerSlot(
      mapKey,
      slot,
      lockMethods(
        {
          get: () => (slot.entries.get('')?.value ?? slot.initialValue) as W,
          set: (next: W | ((prev: W) => W)) =>
            enqueueSlotOp(
              slot,
              false,
              next as JsonValue | ((prev: JsonValue) => JsonValue)
            ),
          getMeta: () => {
            const entry = slot.entries.get('')
            return entry
              ? toSharedCtx<W>(entry.rec, entry.prev as W, entry.roles)
              : null
          },
          onChange: (
            handler: (value: W, context: StateChangeContext<W>) => unknown,
            options?: ReplayListenerOptions
          ) =>
            subEmitter(handler, options, () => {
              const entry = slot.entries.get('')
              return entry
                ? [
                    [
                      entry.value as W,
                      toSharedCtx<W>(entry.rec, entry.prev as W, entry.roles)
                    ]
                  ]
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
      return existing.api as UserState<W>
    }
    const [initVal, maxBytes, reqRoles] = validateSlotArgs(
      namespace,
      initialValue as JsonValue | undefined,
      config?.maxBytes,
      config?.roles,
      hasRolesPlugin() || Boolean(getRolesProvider()),
      false,
      'makeUserState',
      'user state role gating'
    )
    const [subEmitter, emitEmitter, clearEmitter] =
      createEventEmitter<[W | undefined, UserStateChangeContext<W>]>(
        'user state handler'
      )
    const validate = config?.validate as
      | ((next: JsonValue, ctx: UserStateChangeContext<JsonValue>) => boolean)
      | undefined
    const slot: UserSlot = {
      ...createSlotBase(namespace, initVal, reqRoles, maxBytes, clearEmitter),
      kind: 'u',
      ...(validate ? {validate} : {}),
      emit: emitEmitter as UserSlot['emit']
    }
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
                ? (getLiveEntry(slot, uid)?.value ?? slot.initialValue)
                : slot.initialValue
            ) as W
          },
          getAll: (): Readonly<Record<string, W>> => {
            if (!slot.snapshot) {
              const out: Record<string, JsonValue> = {}
              for (const [uid, entry] of slot.entries) {
                if (!entry.rec.del) {
                  out[uid] = entry.value
                }
              }
              slot.snapshot = Object.freeze(out)
            }
            return slot.snapshot as Readonly<Record<string, W>>
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
            const entry = uid ? getLiveEntry(slot, uid) : undefined
            return entry
              ? toUserCtx<W>(entry.rec, entry.prev as W, entry.roles, false)
              : null
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
              for (const entry of slot.entries.values()) {
                if (!entry.rec.del) {
                  items.push([
                    entry.value as W,
                    toUserCtx<W>(entry.rec, entry.prev as W, entry.roles, false)
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
    for (const slot of slots.values()) {
      if (
        slot.kind === 'u' &&
        (slot.stepPromise ||
          slot.ops.length > 0 ||
          Boolean(localUid && getLiveEntry(slot, localUid)))
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
        for (const slot of slots.values()) {
          if (slot.kind === 'u') {
            if (slot.ops.length > 0) {
              slot.skipNextPace = true
              slot.wakePace?.()
              if (!slot.stepPromise) {
                void flushSlot(slot)
              }
            }
            if (slot.stepPromise) {
              steps.push(slot.stepPromise)
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
        const sentSigs = new Set<string>()
        let usedBytes = 0
        for (const slot of slots.values()) {
          if (slot.kind !== 'u') {
            continue
          }
          const entry = getLiveEntry(slot, uid)
          if (!entry) {
            continue
          }
          const wire = toWireRecord(entry.rec, false)
          const est = estimateWireRecordBytes(wire)
          if (usedBytes + est > maxHandshakeStateBytes) {
            continue
          }
          p[entry.rec.userId] = entry.rec.pub
          r.push(wire)
          sentSigs.add(entry.rec.sig)
          usedBytes += est
        }
        if (sentSigs.size > 0) {
          sentHandshakeSigs.set(peerId, sentSigs)
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
        ;({roomId} = await ensureReady())
      } catch {
        return
      }
      const pubMap = payload.p as Record<string, unknown>
      const knownUid = getKnownPeerUserId(fromPeerId)
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
        if (!parsed || (knownUid && parsed.rec.userId !== knownUid)) {
          onInvalidRecord?.(fromPeerId)
          return
        }
        const slot = slots.get(`u:${parsed.rec.ns}`)
        if (!slot || slot.kind !== 'u') {
          continue
        }
        if (parsed.bytes > slot.maxBytes) {
          continue
        }
        const res = await verifyParsedRecord(
          parsed,
          slot.requiredRoles,
          fromPeerId
        )
        if (res === 'invalid') {
          onInvalidRecord?.(fromPeerId)
          return
        }
        if (res === 'drop') {
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
      if (!destroyed && !isPeerBanned(fromPeerId) && staged.length > 0) {
        stagedHandshake.set(fromPeerId, staged)
      }
    } finally {
      onReady?.()
    }
  }

  const sendLocalRecordsToPeer = (
    peerId: string,
    alreadySent?: ReadonlySet<string>
  ): void => {
    const localUid = getLocalUserId()
    if (!localUid || !stateAction) {
      return
    }
    for (const slot of slots.values()) {
      const entry = slot.entries.get(slot.kind === 's' ? '' : localUid)
      if (
        entry &&
        entry.rec.userId === localUid &&
        !alreadySent?.has(entry.rec.sig) &&
        isRecordAuthorizedNow(entry.rec, slot.requiredRoles)
      ) {
        sendState({t: 'rec', r: toWireRecord(entry.rec, true)}, peerId)
      }
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
    const alreadySent = sentHandshakeSigs.get(peerId)
    sentHandshakeSigs.delete(peerId)
    const staged = stagedHandshake.get(peerId)
    if (staged) {
      stagedHandshake.delete(peerId)
      const shouldForward = isScaleActive()
      for (const item of staged) {
        if (item.rec.userId === userId) {
          const entry = commitEntry(item.slot, item.rec, item.roles, item.bytes)
          if (entry && shouldForward) {
            rebroadcastAppliedRecord(entry.rec, peerId)
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
          now - item.seenAt < offlineStagingTtlMs &&
          slots.get(`u:${item.slot.namespace}`) === item.slot &&
          isRecordAuthorizedNow(item.rec, item.slot.requiredRoles)
        ) {
          commitEntry(item.slot, item.rec, item.roles, item.bytes)
        }
      }
    }

    resolvePendingJoin(peerId, true)

    if (isDirect && stateAction && slots.size > 0) {
      sendLocalRecordsToPeer(peerId, alreadySent)
      if (
        completedSyncPeers.size + inFlightPulls.size < syncPullFanout ||
        isScaleActive()
      ) {
        sendPullToPeer(peerId)
      }
    }
  }

  const clearPeer = (peerId: string): void => {
    stagedHandshake.delete(peerId)
    sentHandshakeSigs.delete(peerId)
    liveRateLimiter.delete(peerId)
    resolvePendingJoin(peerId, false)
    clearPullTimer(peerId)
    completedSyncPeers.delete(peerId)
  }

  const onPeerDisconnected = (peerId: string): void => {
    clearPeer(peerId)
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
      if (slot.kind === 'u') {
        const entry = slot.entries.get(userId)
        if (entry) {
          evictEntry(slot, userId, entry, now, [...entry.roles])
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
    let evictedShared = false
    for (const slot of slots.values()) {
      const key = slot.kind === 's' ? '' : bannedUid
      const entry = slot.entries.get(key)
      if (entry && (slot.kind === 'u' || entry.rec.userId === bannedUid)) {
        evictEntry(slot, key, entry, now, [])
        if (slot.kind === 's') {
          evictedShared = true
        }
      }
    }
    if (evictedShared) {
      scheduleRepull()
    }
  }

  const destroy = (): void => {
    destroyed = true
    inFlightPulls.forEach(pull => resetTimer(pull.timer))
    inFlightPulls.clear()
    completedSyncPeers.clear()
    stagedHandshake.clear()
    sentHandshakeSigs.clear()
    pendingOfflineUserRecs.clear()
    liveRateLimiter.clear()
    pendingJoinWaiters.forEach(waiter => waiter.resolve(false))
    pendingJoinWaiters.clear()
    slots.forEach(slot => {
      slot.wakePace?.()
      slot.clearListeners()
    })
  }

  return {
    makeState,
    makeUserState,
    verifyAndApplyStateRecord: async (rec, fromPeerId) =>
      Boolean(await applyIncoming(rec, fromPeerId)),
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
