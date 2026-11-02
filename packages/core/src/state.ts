import {ecdsaSign, hash32, normalizeLowSP256Signature} from './crypto'
import {
  compactPubToJwk,
  getVerifiedPubKeyRecord,
  isValidUserId,
  jwkToCompactPub,
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
  Widen
} from './types'
import {
  createBoundedCache,
  createBoundedSet,
  createEventEmitter,
  createWindowCounter,
  encodeBytes,
  entries,
  fromBase64Url,
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
  toBase64Url,
  toJson,
  validateRoleCertificateShape
} from './utils'

export type StateSigner =
  | CryptoKey
  | ((payload: Uint8Array) => MaybePromise<Uint8Array>)

export const defaultMaxClockSkewMs = 60_000
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
  'cert',
  'sig'
])

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

export {compactPubToJwk, jwkToCompactPub}

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
  return r['cert'] === undefined || validateRoleCertificateShape(r['cert'])
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
  p: StateSignParams<T>
): Promise<AuthoritativeStateRecord<T>> => {
  const u: Omit<AuthoritativeStateRecord<T>, 'sig'> = {
    v: 1,
    k: p.kind ?? 's',
    appId: p.appId,
    roomId: p.roomId,
    ns: p.ns,
    hlc: p.hlc ?? Date.now(),
    peerId: p.peerId,
    userId: p.userId,
    pub: jwkToCompactPub(pubJwk),
    ...(p.del === true ? {del: true as const} : {val: p.val as T}),
    ...(p.cert ? {cert: p.cert} : {})
  }
  const sig = await signWith(
    signer,
    stateRecordPayload(u as Omit<AuthoritativeStateRecord, 'sig'>)
  )
  return {...u, sig}
}

export const verifyStateRecordSignature = async (
  rec: AuthoritativeStateRecord,
  appId: string,
  roomId: string,
  clockSkewMs: number = defaultMaxClockSkewMs
): Promise<boolean> => {
  if (
    !validateStateRecordShape(rec) ||
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
  return verifySig(rec.pub, stateRecordPayload(rec), rec.sig)
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
  sigOk: boolean
}

type Slot = {
  kind: 's' | 'u'
  ns: string
  init: JsonValue
  reqRoles: string[] | null
  maxBytes: number
  validate?: ((next: JsonValue, ctx: any) => boolean) | undefined
  entries: Map<string, SlotEntry>
  snap: Readonly<Record<string, JsonValue>> | null
  emit: (val: any, ctx: any) => void
  clear: () => void
  api: unknown
  ops: PendingOp[]
  flushP: Promise<void> | null
  stepP: Promise<void> | null
}

type StagedHsItem = {
  slot: Slot
  rec: AuthoritativeStateRecord
  roles: string[]
  bytes: number
  sigOk: boolean
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
    ...(raw['cert'] !== undefined
      ? {cert: raw['cert'] as RoleCertificate}
      : {}),
    sig: raw['sig'] as string
  }
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
  if (!hasFiniteNums(initVal)) {
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

export const createStateManager = (deps: StateManagerDeps): StateManager => {
  const slots = new Map<string, Slot>()
  const forwardedRecSigs = createBoundedSet(1_024)
  const peerRateBuckets = createBoundedCache<
    string,
    {tokens: number; lastRefillMs: number}
  >(512)
  const syncQuota = createWindowCounter(512, 49)
  const stagedHs = new Map<string, StagedHsItem[]>()
  const pendingJoinWaiters = new Map<
    string,
    {p: Promise<boolean>; res: (ok: boolean) => void; n: number}
  >()
  const completedSyncPeers = new Set<string>()
  const inFlightPullTimers = new Map<string, ReturnType<typeof setTimeout>>()

  let lastSeenHlc = 0
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

  const observeVerifiedHlc = (hlc: number): void => {
    if (hlc > lastSeenHlc) {
      lastSeenHlc = hlc
    }
  }

  const nextLocalHlc = (ns: string): number => {
    const now = Date.now()
    const cand = Math.max(now, lastSeenHlc + 1)
    if (cand > now + defaultMaxClockSkewMs) {
      throw mkErr(`state clock skew exceeded for "${ns}"`)
    }
    return (lastSeenHlc = cand)
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

  const ensureEntrySigVerified = async (
    slot: Slot,
    key: string,
    entry: SlotEntry
  ): Promise<boolean> => {
    if (entry.sigOk) {
      return true
    }
    const ok = await verifySig(
      entry.rec.pub,
      stateRecordPayload(entry.rec),
      entry.rec.sig
    )
    if (ok) {
      entry.sigOk = true
      return true
    }
    if (slot.entries.get(key) === entry) {
      evictEntry(slot, key, entry, Date.now(), [])
    }
    deps.onInvalidRecord?.(entry.rec.peerId)
    return false
  }

  const stateAction = deps.makeInternalAction
    ? deps.makeInternalAction<JsonValue>('state', {
        receiveWhilePending: true,
        maxPayloadBytes: 256 * 1024
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

  const forwardAppliedEntry = async (
    slot: Slot,
    key: string,
    entry: SlotEntry,
    excludePeerId: string
  ): Promise<void> => {
    if (!stateAction || forwardedRecSigs.has(entry.rec.sig)) {
      return
    }
    if (!(await ensureEntrySigVerified(slot, key, entry))) {
      return
    }
    if (forwardedRecSigs.has(entry.rec.sig)) {
      return
    }
    forwardedRecSigs.add(entry.rec.sig)
    const targets = deps
      .getDirectPeerIds()
      .filter(pid => pid !== excludePeerId && !deps.isPeerBanned(pid))
    if (targets.length > 0) {
      const msg: StateControlMessage = {
        t: 'rec',
        r: toWireRecord(entry.rec, true),
        f: 1
      }
      void stateAction.send(msg as unknown as JsonValue, targets).catch(noOp)
    }
  }

  const verifyIncomingRecord = async (
    rec: AuthoritativeStateRecord,
    reqRoles: readonly string[] | null,
    fromPeerId: string | undefined,
    allowLazyDirect: boolean
  ): Promise<
    | {status: 'ok'; roles: string[]; bytes: number; sigOk: boolean}
    | {status: 'invalid'}
    | {status: 'dropped'}
  > => {
    const roomId = deps.getRoomId()
    const canLazy =
      allowLazyDirect &&
      fromPeerId !== undefined &&
      rec.peerId === fromPeerId &&
      deps.getKnownPeerUserId(fromPeerId) === rec.userId &&
      deps.getPeerUserPub?.(fromPeerId) === rec.pub

    if (canLazy) {
      if (
        rec.appId !== deps.appId ||
        rec.roomId !== roomId ||
        rec.hlc > Date.now() + defaultMaxClockSkewMs ||
        (rec.cert &&
          (rec.cert.subUserId !== rec.userId || rec.hlc < rec.cert.iat))
      ) {
        return {status: 'invalid'}
      }
    } else if (
      !(await verifyStateRecordSignature(
        rec,
        deps.appId,
        roomId,
        defaultMaxClockSkewMs
      ))
    ) {
      return {status: 'invalid'}
    }

    const bytes = measureRecordBytes(rec)
    if (bytes > maxAllowedStateBytes) {
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
      observeVerifiedHlc(rec.hlc)
      return {status: 'ok', roles: roleRes.roles, bytes, sigOk: !canLazy}
    }
    if (reqRoles && reqRoles.length > 0) {
      return {status: 'dropped'}
    }
    observeVerifiedHlc(rec.hlc)
    return {status: 'ok', roles: [], bytes, sigOk: !canLazy}
  }

  const commitEntry = (
    slot: Slot,
    rec: AuthoritativeStateRecord,
    roles: string[],
    bytes: number,
    sigOk: boolean,
    skipValidate = false
  ): SlotEntry | null => {
    const key = slot.kind === 's' ? '' : rec.userId
    if (slot.kind === 'u' && !deps.isUserOnline(key)) {
      return null
    }
    const curRaw = slot.entries.get(key)
    if (curRaw && compareStateRecords(rec, curRaw.rec) <= 0) {
      return null
    }
    const curLive = curRaw && !curRaw.rec.del ? curRaw : undefined
    const prevVal = curLive ? curLive.val : slot.init

    if (rec.del) {
      if (!withinUserQuota(key, slot, bytes)) {
        return null
      }
      const next: SlotEntry = {
        rec,
        val: slot.init,
        prev: prevVal,
        roles: [...roles],
        bytes,
        sigOk
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
    const ctx =
      slot.kind === 's'
        ? toSharedCtx(rec, prevVal, roles)
        : toUserCtx(rec, prevVal, roles, false)
    if (!skipValidate && slot.validate && !slot.validate(rec.val!, ctx)) {
      return null
    }
    const next: SlotEntry = {
      rec,
      val: rec.val as JsonValue,
      prev: prevVal,
      roles: [...roles],
      bytes,
      sigOk
    }
    slot.entries.set(key, next)
    slot.snap = null
    slot.emit(next.val, ctx)
    return next
  }

  const applyIncoming = async (
    rec: AuthoritativeStateRecord,
    fromPeerId: string | undefined,
    allowLazyDirect: boolean
  ): Promise<{slot: Slot; key: string; entry: SlotEntry} | null> => {
    if (destroyed) {
      return null
    }
    if (!validateStateRecordShape(rec)) {
      deps.onInvalidRecord?.(fromPeerId)
      return null
    }
    const slot = slots.get(`${rec.k}:${rec.ns}`)
    if (!slot) {
      return null
    }
    const verified = await verifyIncomingRecord(
      rec,
      slot.reqRoles,
      fromPeerId,
      allowLazyDirect
    )
    if (verified.status === 'invalid') {
      deps.onInvalidRecord?.(fromPeerId)
      return null
    }
    if (verified.status === 'dropped') {
      return null
    }
    const entry = commitEntry(
      slot,
      rec,
      verified.roles,
      verified.bytes,
      verified.sigOk
    )
    return entry
      ? {slot, key: slot.kind === 's' ? '' : rec.userId, entry}
      : null
  }

  const verifyAndApplyStateRecord = async (
    rec: AuthoritativeStateRecord,
    fromPeerId?: string
  ): Promise<boolean> => Boolean(await applyIncoming(rec, fromPeerId, false))

  const iterAuthorizedSlotEntries = function* (): Generator<
    [digestKey: string, slot: Slot, entryKey: string, entry: SlotEntry]
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
            slot,
            entryKey,
            entry
          ]
        }
      }
    }
  }

  const buildDigestMap = (): Record<string, DigestEntry> => {
    const digest: Record<string, DigestEntry> = {}
    let count = 0
    for (const [dKey, , , entry] of iterAuthorizedSlotEntries()) {
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
      const msg: StateControlMessage = {
        t: 'sync',
        p: {},
        r: [],
        ...(wants ? {w: wants} : {}),
        ...(propagate ? {u: 1} : {})
      }
      void stateAction.send(msg as unknown as JsonValue, peerId).catch(noOp)
      return
    }
    const chunks: Array<{p: Record<string, string>; r: WireStateRecord[]}> = []
    let curP: Record<string, string> = {}
    let curR: WireStateRecord[] = []
    let curBytes = 0
    for (const rec of capped) {
      const wire = toWireRecord(rec, false)
      const est = encodeBytes(toJson(wire)).byteLength + 120
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
      const msg: StateControlMessage = {
        t: 'sync',
        p: chunk.p,
        r: chunk.r,
        ...(isLast && wants ? {w: wants} : {}),
        ...(propagate ? {u: 1} : {})
      }
      void stateAction.send(msg as unknown as JsonValue, peerId).catch(noOp)
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

  const consumeLiveRateToken = (peerId: string): boolean => {
    const now = Date.now()
    const cur = peerRateBuckets.get(peerId)
    if (!cur) {
      peerRateBuckets.set(peerId, {
        tokens: maxLiveRecordBurst - 1,
        lastRefillMs: now
      })
      return true
    }
    cur.tokens = Math.min(
      maxLiveRecordBurst,
      cur.tokens +
        (Math.max(0, now - cur.lastRefillMs) / 1_000) * maxLiveRecordsPerSec
    )
    cur.lastRefillMs = now
    if (cur.tokens < 1) {
      return false
    }
    cur.tokens -= 1
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
        const waitP = waitPeerReady(fromPeerId)
        if (waitP === false) {
          return
        }
        const isForwarded = msg.f === 1
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
          const isDirectAuthor =
            !isForwarded &&
            deps.isDirectPeer(fromPeerId) &&
            rec.peerId === fromPeerId
          if (isDirectAuthor) {
            const knownUid = deps.getKnownPeerUserId(fromPeerId)
            if (knownUid && knownUid !== rec.userId) {
              deps.onInvalidRecord?.(fromPeerId)
              return
            }
          }
          const res = await applyIncoming(rec, fromPeerId, isDirectAuthor)
          if (
            res &&
            isForwarded &&
            deps.getScaleProvider?.()?.getActiveMode() === 'gossip'
          ) {
            await forwardAppliedEntry(res.slot, res.key, res.entry, fromPeerId)
          }
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
            [...iterAuthorizedSlotEntries()]
              .slice(0, maxSyncRecordsPerBatch)
              .map(([k, slot, entryKey, entry]) => [k, {slot, entryKey, entry}])
          )
          const toSend: AuthoritativeStateRecord[] = []
          const wantKeys: string[] = []
          for (const [k, item] of localEntries.entries()) {
            const localRec = item.entry.rec
            const rem = remoteDigest.get(k)
            if (
              !rem ||
              localRec.hlc > rem[0] ||
              (localRec.hlc === rem[0] && localRec.sig.slice(0, 8) !== rem[1])
            ) {
              if (
                item.slot.entries.get(item.entryKey) === item.entry &&
                (await ensureEntrySigVerified(
                  item.slot,
                  item.entryKey,
                  item.entry
                ))
              ) {
                toSend.push(localRec)
              } else {
                localEntries.delete(k)
              }
            }
          }
          for (const [k, rem] of remoteDigest.entries()) {
            if (!isRegisteredDigestKey(k)) {
              continue
            }
            const localRec = localEntries.get(k)?.entry.rec
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
            const res = await applyIncoming(fullRec, fromPeerId, false)
            if (res && shouldForward) {
              await forwardAppliedEntry(
                res.slot,
                res.key,
                res.entry,
                fromPeerId
              )
            }
          }
          if (
            wantList.length > 0 &&
            !destroyed &&
            deps.isPeerActive(fromPeerId)
          ) {
            const wantSet = new Set(wantList)
            const matched: Array<[Slot, string, SlotEntry]> = []
            for (const [
              dKey,
              slot,
              entryKey,
              entry
            ] of iterAuthorizedSlotEntries()) {
              if (wantSet.has(dKey)) {
                matched.push([slot, entryKey, entry])
              }
            }
            const pushRecs: AuthoritativeStateRecord[] = []
            for (const [slot, entryKey, entry] of matched) {
              if (
                slot.entries.get(entryKey) === entry &&
                (await ensureEntrySigVerified(slot, entryKey, entry))
              ) {
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

            const batch = slot.ops.splice(0)
            if (!batch.length) {
              continue
            }
            const uid = ready.user.userId
            const entryKey = slot.kind === 's' ? '' : uid
            const cur = getLiveEntry(slot, entryKey)
            let simVal = cur ? cur.val : slot.init
            let finalMode: 'set' | 'del' | null = null
            let finalBytes = 0
            const accepted: PendingOp[] = []
            const tentativeTs = Math.max(Date.now(), lastSeenHlc + 1)

            for (const op of batch) {
              if (op.del) {
                if (!withinUserQuota(uid, slot, 32)) {
                  op.rej(mkErr(`state "${slot.ns}" exceeds user quota`))
                  continue
                }
                simVal = slot.init
                finalMode = 'del'
                finalBytes = 32
                accepted.push(op)
                continue
              }
              let cand: JsonValue
              try {
                cand =
                  typeof op.next === 'function'
                    ? (op.next as (prev: JsonValue) => JsonValue)(simVal)
                    : (op.next as JsonValue)
              } catch (err) {
                op.rej(err)
                continue
              }
              if (!hasFiniteNums(cand)) {
                op.rej(
                  mkErr(
                    `state "${slot.ns}" value must contain only finite JSON numbers`
                  )
                )
                continue
              }
              const bytes = encodeBytes(toJson(cand)).byteLength
              if (bytes > slot.maxBytes) {
                op.rej(
                  mkErr(
                    `state "${slot.ns}" exceeds maxBytes (${slot.maxBytes})`
                  )
                )
                continue
              }
              if (slot.kind === 'u' && !withinUserQuota(uid, slot, bytes)) {
                op.rej(mkErr(`state "${slot.ns}" exceeds user quota`))
                continue
              }
              if (slot.validate) {
                const simCtx =
                  slot.kind === 's'
                    ? {
                        prev: simVal,
                        peerId: ready.selfId,
                        userId: uid,
                        roles: [...auth.roles],
                        timestamp: tentativeTs
                      }
                    : {
                        prev: simVal,
                        peerId: ready.selfId,
                        userId: uid,
                        roles: [...auth.roles],
                        timestamp: tentativeTs,
                        self: true,
                        online: true,
                        removed: false
                      }
                if (!slot.validate(cand, simCtx)) {
                  op.rej(mkErr(`state validation failed for "${slot.ns}"`))
                  continue
                }
              }
              simVal = cand
              finalMode = 'set'
              finalBytes = bytes
              accepted.push(op)
            }

            if (!accepted.length || !finalMode) {
              continue
            }

            let rec: AuthoritativeStateRecord
            try {
              rec = await signStateRecord(
                ready.user.sign,
                ready.user.signPubJwk,
                {
                  kind: slot.kind,
                  appId: deps.appId,
                  roomId: ready.roomId,
                  ns: slot.ns,
                  hlc: nextLocalHlc(slot.ns),
                  peerId: ready.selfId,
                  userId: uid,
                  ...(finalMode === 'del' ? {del: true} : {val: simVal}),
                  cert: auth.cert
                }
              )
            } catch (err) {
              for (const op of accepted) {
                op.rej(err)
              }
              continue
            }

            if (destroyed) {
              for (const op of accepted) {
                op.res()
              }
              continue
            }
            if (!isRecordAuthorizedNow(rec, slot.reqRoles)) {
              const err = mkErr(
                `${insufficientAuthPrefix} to update state "${slot.ns}"`
              )
              for (const op of accepted) {
                op.rej(err)
              }
              continue
            }
            if (commitEntry(slot, rec, auth.roles, finalBytes, true, true)) {
              broadcastLiveRecord(rec)
            }
            for (const op of accepted) {
              op.res()
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
    const slot: Slot = {
      kind: 's',
      ns: namespace,
      init: initVal,
      reqRoles,
      maxBytes,
      ...(config?.validate
        ? {validate: config.validate as Slot['validate']}
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
    const slot: Slot = {
      kind: 'u',
      ns: namespace,
      init: initVal,
      reqRoles,
      maxBytes,
      ...(config?.validate
        ? {validate: config.validate as Slot['validate']}
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
          const est = encodeBytes(toJson(wire)).byteLength + 120
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
      const staged: StagedHsItem[] = []
      let totalBytes = 0
      for (const wireRec of payload.r) {
        if (destroyed || deps.isPeerBanned(fromPeerId)) {
          return
        }
        const rec = fromWireRecord(wireRec, deps.appId, roomId, pubMap)
        if (!rec || rec.k !== 'u' || !validateStateRecordShape(rec)) {
          deps.onInvalidRecord?.(fromPeerId)
          return
        }
        const slot = slots.get(`u:${rec.ns}`)
        if (!slot) {
          continue
        }
        const res = await verifyIncomingRecord(
          rec,
          slot.reqRoles,
          fromPeerId,
          true
        )
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
          rec,
          roles: res.roles,
          bytes: res.bytes,
          sigOk: res.sigOk
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
          const entry = commitEntry(
            item.slot,
            item.rec,
            item.roles,
            item.bytes,
            item.sigOk
          )
          if (entry && isGossip) {
            void forwardAppliedEntry(item.slot, userId, entry, peerId)
          }
        } else {
          deps.onInvalidRecord?.(peerId)
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
