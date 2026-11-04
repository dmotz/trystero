import {createAntiEntropySync} from './anti-entropy'
import {
  compactPubToJwk,
  getVerifiedPubKeyRecord,
  isValidUserId,
  jwkToCompactPub
} from './identity'
import type {
  InternalRoomContext,
  KernelRolesProvider,
  PeerModerationRecord,
  RoleRevocationRecord,
  RolesPluginSlot,
  TargetPeers
} from './internal-types'
import {pluginSlotSymbol} from './primitives'
import {
  canonTag,
  createMonotonicClock,
  defaultMaxClockSkewMs,
  invalidRoles,
  roleCertPayload,
  signRoleCertInternal,
  signWith,
  verifySig
} from './signed-record'
import type {
  JsonValue,
  ReplayListenerOptions,
  RoleCertificate,
  RoleChangeContext,
  RoleChangeHandler,
  RolesConfig,
  RolesPluginApi,
  RoomPlugin,
  Unsubscribe,
  UserIdentity
} from './types'
import {
  cmpStr,
  createBoundedCache,
  createEventEmitter,
  createWindowCounter,
  insufficientAuthPrefix,
  isObj,
  isPosSafeInt,
  isStr,
  isValidSig,
  keys,
  lockMethods,
  mkBannedErr,
  mkErr,
  noOp,
  peerBannedErr,
  selfCertifyingRoomRegex,
  validateRoleCertificateShape
} from './utils'

const authSyncPageSize = 256
const maxStoredTargets = 1_024
export const maxStoredModerations = 4_096
const authPullFanout = 2
const authPullTimeoutMs = 1_500

const frozenEmptyRoles: string[] = Object.freeze([] as string[]) as string[]

const freezeRoles = (roles: readonly string[]): string[] =>
  roles.length === 0
    ? frozenEmptyRoles
    : (Object.freeze([...roles]) as string[])

const rolesEqual = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i])

const hasStrs = (
  obj: Record<string, unknown>,
  fieldNames: readonly string[]
): boolean => fieldNames.every(name => isStr(obj[name]))

const hasAnyRole = (
  held: readonly string[],
  required: readonly string[]
): boolean => required.some(role => held.includes(role))

const sig8 = (item: {sig: string}): string => item.sig.slice(0, 8)

const rootAdminProtectErr = (scope: string, verb: string): Error =>
  mkErr(`${scope}: cannot ${verb} a root admin`)

const splitSelfCertRoom = (
  roomId: string
): readonly [base: string, uid: string | null] => {
  const match = selfCertifyingRoomRegex.exec(roomId)
  return match?.[1] && match[2] ? [match[1], match[2]] : [roomId, null]
}

export const parseSelfCertifyingRoomId = (
  roomId: string
): {baseRoomId: string; userId: string | null} => {
  const [baseRoomId, userId] = splitSelfCertRoom(roomId)
  return {baseRoomId, userId}
}

export const formatSelfCertifyingRoomId = (
  base: string,
  userId: string
): string => `${splitSelfCertRoom(base)[0]}~${userId}`

const normalizeRolesConfig = (config?: RolesConfig): RolesConfig => {
  if (!isObj(config)) {
    return {}
  }
  for (const key of keys(config)) {
    if (key !== 'selfAsAdmin' && key !== 'admins') {
      throw mkErr(`Unknown roles config option "${key}"`)
    }
  }
  let admins: string[] | undefined
  if (config.admins !== undefined) {
    if (!Array.isArray(config.admins)) {
      throw mkErr('roles admins must be an array of userIds')
    }
    admins = config.admins.map(raw => {
      const entry = isStr(raw) ? raw.trim() : ''
      if (!isValidUserId(entry)) {
        throw mkErr(
          `invalid admin userId "${String(raw)}"; expected a 22-character Base62 userId`
        )
      }
      return entry
    })
    if (!admins.length) {
      admins = undefined
    }
  }
  return {
    ...(config.selfAsAdmin ? {selfAsAdmin: true} : {}),
    ...(admins ? {admins} : {})
  }
}

export const revocationCanonicalPayload = (
  rev: Omit<RoleRevocationRecord, 'sig'>
): string =>
  canonTag('role-revoke', [
    rev.v,
    rev.appId,
    rev.roomId,
    rev.issuerUserId,
    rev.targetUserId,
    rev.role ?? '*',
    rev.seq,
    rev.ts
  ])

export const moderationCanonicalPayload = (
  mod: Omit<PeerModerationRecord, 'sig'>
): string =>
  canonTag('peer-mod', [
    mod.v,
    mod.op,
    mod.appId,
    mod.roomId,
    mod.issuerUserId,
    mod.targetUserId,
    mod.reason ?? '',
    mod.seq,
    mod.ts
  ])

const isRootAdminRecordBase = (rec: Record<string, unknown>): boolean =>
  rec['v'] === 1 &&
  hasStrs(rec, ['appId', 'roomId', 'issuerUserId', 'targetUserId']) &&
  isPosSafeInt(rec['seq']) &&
  isPosSafeInt(rec['ts']) &&
  typeof rec['signerPubKey'] === 'string' &&
  Boolean(compactPubToJwk(rec['signerPubKey'])) &&
  isValidSig(rec['sig'])

export const validateRoleRevocationShape = (
  rec: unknown
): rec is RoleRevocationRecord =>
  isObj(rec) &&
  isRootAdminRecordBase(rec) &&
  (rec['role'] === undefined || isStr(rec['role']))

export const validatePeerModerationShape = (
  rec: unknown
): rec is PeerModerationRecord =>
  isObj(rec) &&
  isRootAdminRecordBase(rec) &&
  (rec['op'] === 'ban' || rec['op'] === 'unban') &&
  (rec['reason'] === undefined || typeof rec['reason'] === 'string')

const compareCertOrder = (a: RoleCertificate, b: RoleCertificate): number =>
  a.iat - b.iat ||
  a.seq - b.seq ||
  cmpStr(a.issuerPubKey, b.issuerPubKey) ||
  cmpStr(a.sig, b.sig)

const compareRevocationOrder = (
  a: RoleRevocationRecord,
  b: RoleRevocationRecord
): number =>
  a.ts - b.ts ||
  a.seq - b.seq ||
  cmpStr(a.issuerUserId, b.issuerUserId) ||
  cmpStr(a.sig, b.sig)

const compareModerationOrder = (
  a: PeerModerationRecord,
  b: PeerModerationRecord
): number =>
  a.ts - b.ts ||
  a.seq - b.seq ||
  cmpStr(a.issuerUserId, b.issuerUserId) ||
  (a.op === b.op ? 0 : a.op === 'ban' ? 1 : -1) ||
  cmpStr(a.sig, b.sig)

type AuthPullMessage = {
  t: 'pull'
  s?: string[]
  c?: string
}

type AuthSyncMessage = {
  t: 'sync'
  certs?: RoleCertificate[]
  revocations?: RoleRevocationRecord[]
  moderations?: PeerModerationRecord[]
  n?: string
  f?: 1
}

type AuthControlMessage =
  | AuthPullMessage
  | AuthSyncMessage
  | {t: 'cert'; cert: RoleCertificate}
  | {t: 'revoke'; revocation: RoleRevocationRecord}
  | {t: 'mod'; moderation: PeerModerationRecord}

type AuthSyncBatchInput = {
  certs?: readonly RoleCertificate[]
  revocations?: readonly RoleRevocationRecord[]
  moderations?: readonly PeerModerationRecord[]
}

type AuthSyncBatchResult = {
  certs: RoleCertificate[]
  revocations: RoleRevocationRecord[]
  moderations: PeerModerationRecord[]
}

type SortedAuthItem =
  | readonly [key: string, kind: 'c', item: RoleCertificate]
  | readonly [key: string, kind: 'r', item: RoleRevocationRecord]
  | readonly [key: string, kind: 'm', item: PeerModerationRecord]

export type RoomAuthorityInit = {
  selfId: string | (() => string)
  appId: string
  initialRoomId: string
  effectiveRoomIdP?: Promise<string>
  admin?: RolesConfig
  getLocalUserIdentity?: () => Promise<UserIdentity>
  isOverlayPeerBanned?: (peerId: string) => boolean
  getKnownPeerUserId?: (peerId: string) => string | undefined
  onRoomIdResolved?: (effectiveRoomId: string) => void
  onLocalRoleCertificate?: (cert: RoleCertificate | null) => void
  onRolesChanged?: () => void
  onPeerBanned?: (
    userId: string,
    record: PeerModerationRecord,
    fromPeerId?: string
  ) => void
  onPeerUnbanned?: (
    userId: string,
    record: PeerModerationRecord,
    fromPeerId?: string
  ) => void
  onSignatureFailure?: (fromPeerId?: string) => void
}

export type RoomAuthority = Omit<
  KernelRolesProvider,
  'onPeerDescriptorCert'
> & {
  onRoleChange: (
    handler: RoleChangeHandler,
    options?: ReplayListenerOptions
  ) => Unsubscribe
  clearRoleListeners: () => void
  verifyAndApplyCert: (
    cert: RoleCertificate,
    fromPeerId?: string
  ) => Promise<boolean>
  verifyAndApplyRevocation: (
    rev: RoleRevocationRecord,
    fromPeerId?: string
  ) => Promise<boolean>
  verifyAndApplyModeration: (
    mod: PeerModerationRecord,
    fromPeerId?: string
  ) => Promise<boolean>
  applySyncBatch: (
    batch: AuthSyncBatchInput,
    fromPeerId?: string,
    shouldAbort?: () => boolean
  ) => Promise<AuthSyncBatchResult>
  hasUnknownRecordSigs: (remoteSigs?: readonly string[]) => boolean
  buildPullMessage: (cursor?: string) => Promise<AuthPullMessage>
  buildDiffSyncMessage: (
    knownSigs?: readonly string[],
    cursor?: string
  ) => Promise<AuthSyncMessage | null>
  buildPushSyncMessages: () => Promise<AuthSyncMessage[]>
  rememberPeerUser: (peerId: string, userId: string) => void
  issueRoleCertificate: (
    targetId: string,
    role: string | readonly string[]
  ) => Promise<RoleCertificate>
  issueRoleRevocation: (
    targetId: string,
    role?: string
  ) => Promise<RoleRevocationRecord>
  issuePeerModeration: (
    op: 'ban' | 'unban',
    targetId: string,
    options?: {reason?: string}
  ) => Promise<PeerModerationRecord>
}

const mkSyncMsg = (
  certs: RoleCertificate[],
  revocations: RoleRevocationRecord[],
  moderations: PeerModerationRecord[],
  nextCursor?: string,
  forwarded?: boolean
): AuthSyncMessage | null =>
  certs.length || revocations.length || moderations.length || nextCursor
    ? {
        t: 'sync',
        ...(certs.length ? {certs} : {}),
        ...(revocations.length ? {revocations} : {}),
        ...(moderations.length ? {moderations} : {}),
        ...(nextCursor ? {n: nextCursor} : {}),
        ...(forwarded ? {f: 1 as const} : {})
      }
    : null

export const createRoomAuthority = ({
  selfId,
  appId,
  initialRoomId,
  effectiveRoomIdP,
  admin: rawAdmin,
  getLocalUserIdentity,
  isOverlayPeerBanned,
  getKnownPeerUserId,
  onRoomIdResolved,
  onLocalRoleCertificate,
  onRolesChanged,
  onPeerBanned,
  onPeerUnbanned,
  onSignatureFailure
}: RoomAuthorityInit): RoomAuthority => {
  const admin = normalizeRolesConfig(rawAdmin)
  const clockSkewMs = defaultMaxClockSkewMs
  const clock = createMonotonicClock()
  const certs = new Map<string, RoleCertificate>()
  const revocationsByTarget = new Map<
    string,
    Map<string, RoleRevocationRecord>
  >()
  const moderations = new Map<string, PeerModerationRecord>()
  const verifiedCertCache = createBoundedCache<string, string[]>(512)
  const knownPeerUsers = createBoundedCache<string, string>(2048)
  const roleSnapshotCache = new Map<string, string[]>()
  const lastKnownRoles = new Map<string, string[]>()
  const pendingReplayHandlers = new Set<
    [handler: RoleChangeHandler, replayedUids: Set<string>]
  >()
  const [subRoleChange, emitRoleChange, clearRoleChange] = createEventEmitter<
    [RoleChangeContext]
  >('role change handler')

  const rememberPeerUser = (peerId: string, userId: string): void => {
    if (peerId && userId && peerId !== userId) {
      knownPeerUsers.set(peerId, userId)
    }
  }

  const lookupPeerUid = (id: string): string | undefined => {
    const live = getKnownPeerUserId?.(id)
    if (live) {
      rememberPeerUser(id, live)
      return live
    }
    return knownPeerUsers.get(id)
  }

  let localCert: RoleCertificate | null = null
  let localModSeq = 0
  let effectiveRoomId = initialRoomId
  let baseRoomId = initialRoomId
  let roomAdminUserId: string | null = null
  let isResolved = false
  const rootUserIds = new Set<string>(admin.admins)
  let localUser: UserIdentity | null = null

  const syncRoomIds = (rid: string): void => {
    const [base, uid] = splitSelfCertRoom(rid)
    baseRoomId = base
    if (uid) {
      roomAdminUserId = uid
      rootUserIds.add(uid)
    }
  }
  syncRoomIds(initialRoomId)

  const failSig = (fromPeerId?: string): false => (
    onSignatureFailure?.(fromPeerId),
    false
  )

  const getSelfId = typeof selfId === 'function' ? selfId : () => selfId

  const resolveUid = (id?: string): string => {
    const curSelf = getSelfId()
    const target = id ?? curSelf
    if (!target) {
      return localUser?.userId ?? ''
    }
    return target === curSelf && localUser
      ? localUser.userId
      : (lookupPeerUid(target) ?? target)
  }

  const candidateUids = (id?: string): string[] => {
    const curSelf = getSelfId()
    const target = id ?? curSelf
    const resolved = resolveUid(target)
    const set = new Set<string>()
    if (resolved) {
      set.add(resolved)
    }
    if (target) {
      set.add(target)
      const mapped = lookupPeerUid(target)
      if (mapped) {
        set.add(mapped)
      }
    }
    return [...set]
  }

  const isRootUid = (uid: string): boolean => rootUserIds.has(uid)

  const isTargetBanned = (uid: string): boolean =>
    !isRootUid(uid) && moderations.get(uid)?.op === 'ban'

  const effectiveRoles = (cert: RoleCertificate): string[] => {
    const subUid = cert.subUserId
    const isRoot = isRootUid(subUid)
    const mod = moderations.get(subUid)
    if (
      mod &&
      !isRoot &&
      (mod.op === 'ban' ||
        cert.iat < mod.ts ||
        (cert.iat === mod.ts && cert.seq <= mod.seq))
    ) {
      return []
    }
    const revoked = new Set<string>()
    const revMap = revocationsByTarget.get(subUid)
    if (revMap) {
      for (const [roleKey, rev] of revMap) {
        if (rev.ts > cert.iat || (rev.ts === cert.iat && rev.seq >= cert.seq)) {
          if (roleKey === '*') {
            return isRoot ? ['admin'] : []
          }
          if (!isRoot || roleKey !== 'admin') {
            revoked.add(roleKey)
          }
        }
      }
    }
    const active = cert.roles.filter(role => !revoked.has(role))
    return isRoot && !active.includes('admin') ? ['admin', ...active] : active
  }

  const computeRolesForUid = (uid: string): string[] => {
    if (!uid || isTargetBanned(uid)) {
      return frozenEmptyRoles
    }
    const cached = roleSnapshotCache.get(uid)
    if (cached) {
      return cached
    }
    const cert = certs.get(uid)
    const raw = cert ? effectiveRoles(cert) : isRootUid(uid) ? ['admin'] : []
    const frozen = freezeRoles(raw)
    if (frozen.length > 0) {
      roleSnapshotCache.set(uid, frozen)
    }
    return frozen
  }

  const seedRootKnownRoles = (): string[] => {
    const newlySeeded: string[] = []
    for (const rootUid of rootUserIds) {
      if (!lastKnownRoles.has(rootUid)) {
        const roles = computeRolesForUid(rootUid)
        if (roles.length > 0) {
          lastKnownRoles.set(rootUid, roles)
          newlySeeded.push(rootUid)
        }
      }
    }
    return newlySeeded
  }
  seedRootKnownRoles()

  const reconcileRoleChanges = (local: boolean): void => {
    roleSnapshotCache.clear()
    const allTracked = new Set<string>([
      ...rootUserIds,
      ...certs.keys(),
      ...lastKnownRoles.keys()
    ])
    let anyChanged = false
    for (const uid of allTracked) {
      const prev = lastKnownRoles.get(uid) ?? frozenEmptyRoles
      const next = computeRolesForUid(uid)
      if (!rolesEqual(prev, next)) {
        anyChanged = true
        if (next.length > 0) {
          lastKnownRoles.set(uid, next)
        } else {
          lastKnownRoles.delete(uid)
        }
        emitRoleChange({
          userId: uid,
          roles: next,
          previousRoles: prev,
          local
        })
      }
    }
    if (anyChanged) {
      onRolesChanged?.()
    }
  }

  const syncLocalCert = (): void => {
    if (!localUser) {
      return
    }
    const stored = certs.get(localUser.userId)
    const activeRoles = stored ? effectiveRoles(stored) : []
    const nonIntrinsicRoles = isRootUid(localUser.userId)
      ? activeRoles.filter(r => r !== 'admin')
      : activeRoles
    const canHold =
      stored &&
      !isTargetBanned(localUser.userId) &&
      nonIntrinsicRoles.length > 0
    if (!canHold) {
      if (localCert !== null) {
        localCert = null
        onLocalRoleCertificate?.(null)
      }
      return
    }
    if (localCert?.sig !== stored.sig) {
      localCert = stored
      onLocalRoleCertificate?.(stored)
    }
  }

  const certCacheKey = (cert: RoleCertificate): string =>
    `${roleCertPayload(cert)}\u0000${cert.sig}`

  const verifyCertCached = async (
    cert: RoleCertificate
  ): Promise<{valid: boolean; roles: string[]}> => {
    if (
      !validateRoleCertificateShape(cert) ||
      cert.appId !== appId ||
      cert.roomId !== effectiveRoomId ||
      cert.iat > Date.now() + clockSkewMs ||
      (rootUserIds.has(cert.subUserId)
        ? !cert.roles.includes('admin')
        : cert.roles.includes('admin'))
    ) {
      return invalidRoles()
    }
    const cacheKey = certCacheKey(cert)
    const cachedRoles = verifiedCertCache.get(cacheKey)
    if (cachedRoles) {
      return {valid: true, roles: [...cachedRoles]}
    }
    const issuer = await getVerifiedPubKeyRecord(cert.issuerPubKey)
    if (!issuer || !rootUserIds.has(issuer.userId)) {
      return invalidRoles()
    }
    if (
      !(await verifySig(cert.issuerPubKey, roleCertPayload(cert), cert.sig))
    ) {
      return invalidRoles()
    }
    verifiedCertCache.set(cacheKey, [...cert.roles])
    return {valid: true, roles: [...cert.roles]}
  }

  const verifyRootAdminRecord = async (
    rec: RoleRevocationRecord | PeerModerationRecord,
    payload: string
  ): Promise<boolean> => {
    if (
      rec.appId !== appId ||
      rec.roomId !== effectiveRoomId ||
      rec.ts > Date.now() + clockSkewMs ||
      !isRootUid(rec.issuerUserId)
    ) {
      return false
    }
    const signer = await getVerifiedPubKeyRecord(rec.signerPubKey)
    if (!signer || signer.userId !== rec.issuerUserId) {
      return false
    }
    return verifySig(rec.signerPubKey, payload, rec.sig)
  }

  const nonRootUids = (id: string): string[] | null => {
    const uids = candidateUids(id)
    return uids.some(isRootUid) ? null : uids
  }

  const getPeerRoles = (...args: [peerOrUserId?: string]): string[] => {
    if (args.length > 0 && !args[0]) {
      return frozenEmptyRoles
    }
    let target: string
    if (args.length === 0) {
      target = localUser?.userId ?? getSelfId()
      if (!target) {
        return frozenEmptyRoles
      }
    } else {
      target = args[0]!
    }
    const uids = candidateUids(target)
    if (uids.some(isTargetBanned)) {
      return frozenEmptyRoles
    }
    for (const uid of uids) {
      if (certs.has(uid) || isRootUid(uid)) {
        return computeRolesForUid(uid)
      }
    }
    return frozenEmptyRoles
  }

  const isPeerBanned = (peerOrUserId: string): boolean => {
    const uids = nonRootUids(peerOrUserId)
    return Boolean(
      uids && (isOverlayPeerBanned?.(peerOrUserId) || uids.some(isTargetBanned))
    )
  }

  const getBanReason = (peerOrUserId: string): string | undefined => {
    for (const uid of nonRootUids(peerOrUserId) ?? []) {
      const rec = moderations.get(uid)
      if (rec?.op === 'ban' && rec.reason !== undefined) {
        return rec.reason
      }
    }
    return undefined
  }

  let resolvedP: Promise<void> | null = null
  const ensureResolved = (): Promise<void> =>
    (resolvedP ??= (async () => {
      localUser = getLocalUserIdentity ? await getLocalUserIdentity() : null
      if (effectiveRoomIdP) {
        const resolvedRid = await effectiveRoomIdP
        if (resolvedRid && resolvedRid !== effectiveRoomId) {
          effectiveRoomId = resolvedRid
          onRoomIdResolved?.(effectiveRoomId)
        }
        syncRoomIds(effectiveRoomId)
      } else if (!roomAdminUserId && admin.selfAsAdmin && localUser) {
        roomAdminUserId = localUser.userId
        baseRoomId = initialRoomId
        effectiveRoomId = formatSelfCertifyingRoomId(
          initialRoomId,
          roomAdminUserId
        )
        rootUserIds.add(roomAdminUserId)
        onRoomIdResolved?.(effectiveRoomId)
      }
      isResolved = true
      roleSnapshotCache.clear()
      const newlySeeded = seedRootKnownRoles()
      if (newlySeeded.length > 0) {
        onRolesChanged?.()
        for (const [handler, replayed] of pendingReplayHandlers) {
          for (const uid of newlySeeded) {
            if (!replayed.has(uid)) {
              replayed.add(uid)
              const roles = computeRolesForUid(uid)
              if (roles.length > 0) {
                try {
                  handler({
                    userId: uid,
                    roles,
                    previousRoles: frozenEmptyRoles,
                    local: false
                  })
                } catch {
                  // ignore userland handler error during deferred replay
                }
              }
            }
          }
        }
      }
      pendingReplayHandlers.clear()
      syncLocalCert()
    })())
  void ensureResolved().catch(noOp)

  const onRoleChange = (
    handler: RoleChangeHandler,
    options?: ReplayListenerOptions
  ): Unsubscribe => {
    let trackedEntry: [RoleChangeHandler, Set<string>] | null = null
    const unsub = subRoleChange(handler, options, () => {
      const items: Array<[RoleChangeContext]> = []
      const replayed = new Set<string>()
      const uids = new Set<string>([...rootUserIds, ...certs.keys()])
      for (const uid of uids) {
        const roles = computeRolesForUid(uid)
        if (roles.length > 0) {
          replayed.add(uid)
          items.push([
            {
              userId: uid,
              roles,
              previousRoles: frozenEmptyRoles,
              local: false
            }
          ])
        }
      }
      if (!isResolved) {
        trackedEntry = [handler, replayed]
        pendingReplayHandlers.add(trackedEntry)
      }
      return items
    })
    return () => {
      if (trackedEntry) {
        pendingReplayHandlers.delete(trackedEntry)
      }
      unsub()
    }
  }

  const guardApply = <T>(fn: () => Promise<T>, fallback: () => T): Promise<T> =>
    ensureResolved().then(fn).catch(fallback)

  const evictOldestTargetIfNeeded = <T>(
    map: Map<string, T>,
    limit: number,
    canEvict?: (val: T) => boolean
  ): boolean => {
    if (map.size < limit) {
      return true
    }
    for (const [k, val] of map) {
      if (!canEvict || canEvict(val)) {
        map.delete(k)
        return true
      }
    }
    return false
  }

  const stageCertInternal = async (
    cert: RoleCertificate,
    fromPeerId?: string
  ): Promise<boolean> => {
    if (
      !validateRoleCertificateShape(cert) ||
      cert.appId !== appId ||
      cert.roomId !== effectiveRoomId ||
      cert.iat > Date.now() + clockSkewMs
    ) {
      return failSig(fromPeerId)
    }
    const prev = certs.get(cert.subUserId)
    if (prev && (prev.sig === cert.sig || compareCertOrder(cert, prev) <= 0)) {
      return false
    }
    if (!prev && !evictOldestTargetIfNeeded(certs, maxStoredTargets)) {
      return false
    }
    if (!(await verifyCertCached(cert)).valid) {
      return failSig(fromPeerId)
    }
    clock.observe(cert.iat)
    certs.set(cert.subUserId, cert)
    return true
  }

  const canRevokeTarget = (rev: RoleRevocationRecord): boolean => {
    if (!isRootUid(rev.targetUserId)) {
      return true
    }
    return Boolean(rev.role && rev.role !== '*' && rev.role !== 'admin')
  }

  const stageRevocationInternal = async (
    rev: RoleRevocationRecord,
    fromPeerId?: string
  ): Promise<boolean> => {
    if (!validateRoleRevocationShape(rev) || !canRevokeTarget(rev)) {
      return failSig(fromPeerId)
    }
    const roleKey = rev.role ?? '*'
    const existingMap = revocationsByTarget.get(rev.targetUserId)
    const prev = existingMap?.get(roleKey)
    if (
      prev &&
      (prev.sig === rev.sig || compareRevocationOrder(rev, prev) <= 0)
    ) {
      return false
    }
    if (
      !existingMap &&
      !evictOldestTargetIfNeeded(revocationsByTarget, maxStoredTargets)
    ) {
      return false
    }
    if (!(await verifyRootAdminRecord(rev, revocationCanonicalPayload(rev)))) {
      return failSig(fromPeerId)
    }
    clock.observe(rev.ts)
    let targetMap = revocationsByTarget.get(rev.targetUserId)
    if (!targetMap) {
      targetMap = new Map()
      revocationsByTarget.set(rev.targetUserId, targetMap)
    }
    targetMap.set(roleKey, rev)
    return true
  }

  const stageModerationInternal = async (
    mod: PeerModerationRecord,
    fromPeerId?: string
  ): Promise<'ban' | 'unban' | 'updated' | false> => {
    if (!validatePeerModerationShape(mod) || isRootUid(mod.targetUserId)) {
      return failSig(fromPeerId)
    }
    const prev = moderations.get(mod.targetUserId)
    if (
      prev &&
      (prev.sig === mod.sig || compareModerationOrder(mod, prev) <= 0)
    ) {
      return false
    }
    if (
      !prev &&
      !evictOldestTargetIfNeeded(
        moderations,
        maxStoredModerations,
        val => val.op === 'unban'
      )
    ) {
      return false
    }
    if (!(await verifyRootAdminRecord(mod, moderationCanonicalPayload(mod)))) {
      return failSig(fromPeerId)
    }
    clock.observe(mod.ts)
    const wasBanned = prev?.op === 'ban'
    moderations.set(mod.targetUserId, mod)
    if (!wasBanned && mod.op === 'ban') {
      return 'ban'
    }
    if (wasBanned && mod.op === 'unban') {
      return 'unban'
    }
    return 'updated'
  }

  const applyCertWithOrigin = (
    cert: RoleCertificate,
    local: boolean,
    fromPeerId?: string
  ): Promise<boolean> =>
    guardApply(
      async () => {
        if (!(await stageCertInternal(cert, fromPeerId))) {
          return false
        }
        syncLocalCert()
        reconcileRoleChanges(local)
        return true
      },
      () => failSig(fromPeerId)
    )

  const verifyAndApplyCert: RoomAuthority['verifyAndApplyCert'] = (
    cert,
    fromPeerId
  ) => applyCertWithOrigin(cert, false, fromPeerId)

  const applyRevocationWithOrigin = (
    rev: RoleRevocationRecord,
    local: boolean,
    fromPeerId?: string
  ): Promise<boolean> =>
    guardApply(
      async () => {
        if (!(await stageRevocationInternal(rev, fromPeerId))) {
          return false
        }
        syncLocalCert()
        reconcileRoleChanges(local)
        return true
      },
      () => failSig(fromPeerId)
    )

  const verifyAndApplyRevocation: RoomAuthority['verifyAndApplyRevocation'] = (
    rev,
    fromPeerId
  ) => applyRevocationWithOrigin(rev, false, fromPeerId)

  const notifyModerationTransition = (
    transition: 'ban' | 'unban' | 'updated',
    mod: PeerModerationRecord,
    local: boolean,
    fromPeerId?: string
  ): void => {
    syncLocalCert()
    reconcileRoleChanges(local)
    if (transition === 'ban') {
      onPeerBanned?.(mod.targetUserId, mod, fromPeerId)
    } else if (transition === 'unban') {
      onPeerUnbanned?.(mod.targetUserId, mod, fromPeerId)
    }
  }

  const applyModerationWithOrigin = (
    mod: PeerModerationRecord,
    local: boolean,
    fromPeerId?: string
  ): Promise<boolean> =>
    guardApply(
      async () => {
        const res = await stageModerationInternal(mod, fromPeerId)
        if (!res) {
          return false
        }
        notifyModerationTransition(res, mod, local, fromPeerId)
        return true
      },
      () => failSig(fromPeerId)
    )

  const verifyAndApplyModeration: RoomAuthority['verifyAndApplyModeration'] = (
    mod,
    fromPeerId
  ) => applyModerationWithOrigin(mod, false, fromPeerId)

  const applySyncBatch: RoomAuthority['applySyncBatch'] = (
    batch,
    fromPeerId,
    shouldAbort
  ) =>
    guardApply(
      async () => {
        const takeArr = <T>(val: unknown, max: number): T[] =>
          Array.isArray(val) ? val.slice(0, max) : []
        const appliedCerts: RoleCertificate[] = []
        const appliedRevs: RoleRevocationRecord[] = []
        const appliedMods: Array<
          [mod: PeerModerationRecord, res: 'ban' | 'unban' | 'updated']
        > = []

        for (const cert of takeArr<RoleCertificate>(
          batch.certs,
          authSyncPageSize
        )) {
          if (shouldAbort?.()) {
            break
          }
          if (await stageCertInternal(cert, fromPeerId)) {
            appliedCerts.push(cert)
          }
        }
        for (const rev of takeArr<RoleRevocationRecord>(
          batch.revocations,
          authSyncPageSize
        )) {
          if (shouldAbort?.()) {
            break
          }
          if (await stageRevocationInternal(rev, fromPeerId)) {
            appliedRevs.push(rev)
          }
        }
        for (const mod of takeArr<PeerModerationRecord>(
          batch.moderations,
          authSyncPageSize
        )) {
          if (shouldAbort?.()) {
            break
          }
          const res = await stageModerationInternal(mod, fromPeerId)
          if (res) {
            appliedMods.push([mod, res])
          }
        }

        if (
          appliedCerts.length > 0 ||
          appliedRevs.length > 0 ||
          appliedMods.length > 0
        ) {
          syncLocalCert()
          reconcileRoleChanges(false)
          for (const [mod, res] of appliedMods) {
            if (res === 'ban') {
              onPeerBanned?.(mod.targetUserId, mod, fromPeerId)
            } else if (res === 'unban') {
              onPeerUnbanned?.(mod.targetUserId, mod, fromPeerId)
            }
          }
        }

        return {
          certs: appliedCerts,
          revocations: appliedRevs,
          moderations: appliedMods.map(([mod]) => mod)
        }
      },
      () => {
        failSig(fromPeerId)
        return {certs: [], revocations: [], moderations: []}
      }
    )

  const getSortedAuthItems = (): SortedAuthItem[] => {
    const items: SortedAuthItem[] = []
    for (const [uid, cert] of certs) {
      items.push([`c:${uid}`, 'c', cert])
    }
    for (const [uid, targetMap] of revocationsByTarget) {
      for (const [roleKey, rev] of targetMap) {
        items.push([`r:${uid}\u0000${roleKey}`, 'r', rev])
      }
    }
    for (const [uid, mod] of moderations) {
      items.push([`m:${uid}`, 'm', mod])
    }
    items.sort((a, b) => cmpStr(a[0], b[0]))
    return items
  }

  const collectKnownSig8Set = (): Set<string> => {
    const set = new Set<string>()
    for (const cert of certs.values()) {
      set.add(sig8(cert))
    }
    for (const targetMap of revocationsByTarget.values()) {
      for (const rev of targetMap.values()) {
        set.add(sig8(rev))
      }
    }
    for (const mod of moderations.values()) {
      set.add(sig8(mod))
    }
    return set
  }

  const hasUnknownRecordSigs = (remoteSigs?: readonly string[]): boolean => {
    if (!Array.isArray(remoteSigs) || remoteSigs.length === 0) {
      return false
    }
    const localSet = collectKnownSig8Set()
    return remoteSigs.some(sig => isStr(sig) && !localSet.has(sig))
  }

  const buildPullMessage: RoomAuthority['buildPullMessage'] = async cursor => {
    await ensureResolved()
    const items = getSortedAuthItems().filter(
      ([k]) => cursor === undefined || cmpStr(k, cursor) > 0
    )
    const s = items.slice(0, authSyncPageSize).map(([, , item]) => sig8(item))
    return {
      t: 'pull' as const,
      ...(s.length ? {s} : {}),
      ...(cursor !== undefined ? {c: cursor} : {})
    }
  }

  const buildDiffSyncMessage: RoomAuthority['buildDiffSyncMessage'] = async (
    knownSigs,
    cursor
  ) => {
    await ensureResolved()
    const known = new Set(
      Array.isArray(knownSigs) ? knownSigs.filter(isStr) : []
    )
    const afterCursor = getSortedAuthItems().filter(
      ([k]) => cursor === undefined || cmpStr(k, cursor) > 0
    )
    const page = afterCursor.slice(0, authSyncPageSize)
    const nextCursor =
      afterCursor.length > authSyncPageSize
        ? page[page.length - 1]![0]
        : undefined
    const outCerts: RoleCertificate[] = []
    const outRevs: RoleRevocationRecord[] = []
    const outMods: PeerModerationRecord[] = []
    for (const [, kind, item] of page) {
      if (known.has(sig8(item))) {
        continue
      }
      if (kind === 'c') {
        outCerts.push(item)
      } else if (kind === 'r') {
        outRevs.push(item)
      } else {
        outMods.push(item)
      }
    }
    return mkSyncMsg(outCerts, outRevs, outMods, nextCursor)
  }

  const buildPushSyncMessages: RoomAuthority['buildPushSyncMessages'] =
    async () => {
      await ensureResolved()
      const items = getSortedAuthItems()
      const msgs: AuthSyncMessage[] = []
      for (let i = 0; i < items.length; i += authSyncPageSize) {
        const slice = items.slice(i, i + authSyncPageSize)
        const outCerts: RoleCertificate[] = []
        const outRevs: RoleRevocationRecord[] = []
        const outMods: PeerModerationRecord[] = []
        for (const [, kind, item] of slice) {
          if (kind === 'c') {
            outCerts.push(item)
          } else if (kind === 'r') {
            outRevs.push(item)
          } else {
            outMods.push(item)
          }
        }
        const msg = mkSyncMsg(outCerts, outRevs, outMods, undefined, true)
        if (msg) {
          msgs.push(msg)
        }
      }
      return msgs
    }

  const requireLocalCertOrIntrinsicAdmin = (
    requiredRoles: readonly string[],
    forState: boolean,
    namespace: string
  ): readonly [RoleCertificate | null, string[]] => {
    const myRoles = getPeerRoles()
    if (!hasAnyRole(myRoles, requiredRoles)) {
      throw mkErr(
        `${insufficientAuthPrefix} ${forState ? 'to update state' : 'for action'} "${namespace}": requires [${requiredRoles.join(', ')}]`
      )
    }
    if (localCert) {
      return [localCert, [...myRoles]]
    }
    if (
      localUser &&
      isRootUid(localUser.userId) &&
      requiredRoles.includes('admin')
    ) {
      return [null, [...myRoles]]
    }
    throw mkErr(
      `missing local role certificate for ${forState ? 'state' : 'action'} "${namespace}"`
    )
  }

  const getLocalActionCert: KernelRolesProvider['getLocalActionCert'] = async (
    requiredRoles,
    namespace = ''
  ) => {
    await ensureResolved()
    if (!requiredRoles.length) {
      return null
    }
    const [cert] = requireLocalCertOrIntrinsicAdmin(
      requiredRoles,
      false,
      namespace
    )
    return cert
  }

  const authorizePeerAction: KernelRolesProvider['authorizePeerAction'] = (
    peerId,
    requiredRoles,
    inlineCert
  ) => {
    if (isPeerBanned(peerId)) {
      return false
    }
    if (!requiredRoles.length) {
      return true
    }
    if (!isResolved) {
      return ensureResolved().then(() =>
        authorizePeerAction(peerId, requiredRoles, inlineCert)
      )
    }
    const peerUid = lookupPeerUid(peerId)
    if (!peerUid || isTargetBanned(peerUid)) {
      return false
    }
    if (hasAnyRole(getPeerRoles(peerUid), requiredRoles)) {
      return true
    }
    if (!inlineCert || inlineCert.subUserId !== peerUid) {
      return false
    }
    return verifyAndApplyCert(inlineCert, peerId).then(
      () =>
        !isPeerBanned(peerId) &&
        !isTargetBanned(peerUid) &&
        hasAnyRole(getPeerRoles(peerUid), requiredRoles)
    )
  }

  const getStateWriteCert: KernelRolesProvider['getStateWriteCert'] = async (
    requiredRoles,
    namespace
  ) => {
    await ensureResolved()
    if (!requiredRoles || requiredRoles.length === 0) {
      const myRoles = [...getPeerRoles()]
      const cert =
        localCert && !isTargetBanned(localCert.subUserId) && myRoles.length
          ? localCert
          : null
      return {cert, roles: myRoles}
    }
    const [cert, roles] = requireLocalCertOrIntrinsicAdmin(
      requiredRoles,
      true,
      namespace
    )
    return {cert, roles}
  }

  const verifyStateRecordRoles: KernelRolesProvider['verifyStateRecordRoles'] =
    async (rec, requiredRoles, fromPeerId) => {
      await ensureResolved()
      if (isPeerBanned(rec.userId)) {
        return invalidRoles()
      }
      if (rec.cert) {
        if (
          !(await verifyCertCached(rec.cert)).valid ||
          rec.cert.subUserId !== rec.userId ||
          rec.hlc[0] < rec.cert.iat
        ) {
          failSig(fromPeerId)
          return invalidRoles()
        }
        const prev = certs.get(rec.userId)
        if (!prev || compareCertOrder(rec.cert, prev) > 0) {
          clock.observe(rec.cert.iat)
          certs.set(rec.userId, rec.cert)
          syncLocalCert()
          reconcileRoleChanges(false)
        }
        const roles = effectiveRoles(rec.cert)
        return requiredRoles?.length && !hasAnyRole(roles, requiredRoles)
          ? invalidRoles()
          : {valid: true, roles}
      }
      if (requiredRoles?.length) {
        const intrinsicRoles = isRootUid(rec.userId) ? ['admin'] : []
        return hasAnyRole(intrinsicRoles, requiredRoles)
          ? {valid: true, roles: [...getPeerRoles(rec.userId)]}
          : invalidRoles()
      }
      return {valid: true, roles: [...getPeerRoles(rec.userId)]}
    }

  const requireRootSigner = async (
    errMsg: string,
    targetId: string
  ): Promise<readonly [UserIdentity, string]> => {
    await ensureResolved()
    if (!localUser || !isRootUid(localUser.userId)) {
      throw mkErr(errMsg)
    }
    return [localUser, resolveUid(targetId)]
  }

  const advanceFloor = (
    cur: readonly [ts: number, seq: number],
    ts: number,
    seq: number
  ): readonly [ts: number, seq: number] =>
    ts > cur[0] || (ts === cur[0] && seq > cur[1]) ? [ts, seq] : cur

  const nextAuthorityStamp = (
    floor: readonly [ts: number, seq: number]
  ): readonly [ts: number, seq: number] => {
    const safeCeiling = Math.max(floor[0], Date.now() + clockSkewMs - 2_000)
    if (floor[0] <= 0) {
      const ts = Math.min(clock.next(), safeCeiling)
      return [ts, ++localModSeq]
    }
    const desiredTs = Math.max(clock.next(), floor[0] + 1)
    const ts = Math.min(desiredTs, safeCeiling)
    const seq = Math.max(++localModSeq, floor[1] + 1)
    localModSeq = seq
    return [ts, seq]
  }

  const issueRoleCertificate: RoomAuthority['issueRoleCertificate'] = async (
    targetId,
    role
  ) => {
    const rolesToGrant = [role].flat().filter(Boolean)
    if (!rolesToGrant.length) {
      throw mkErr('grantRole requires at least one non-empty role name')
    }
    const [user, targetUserId] = await requireRootSigner(
      `${insufficientAuthPrefix} to grant role [${rolesToGrant.join(', ')}]`,
      targetId
    )
    if (!isRootUid(targetUserId) && rolesToGrant.includes('admin')) {
      throw mkErr("'admin' role is reserved for room root admins")
    }
    if (isTargetBanned(targetUserId)) {
      throw mkErr('cannot grant role to a banned user')
    }
    const mergedRoles = [
      ...new Set([...getPeerRoles(targetUserId), ...rolesToGrant])
    ]
    let floor: readonly [number, number] = [0, 0]
    const prevCert = certs.get(targetUserId)
    if (prevCert) {
      floor = advanceFloor(floor, prevCert.iat, prevCert.seq)
    }
    const prevMod = moderations.get(targetUserId)
    if (prevMod) {
      floor = advanceFloor(floor, prevMod.ts, prevMod.seq)
    }
    for (const rev of revocationsByTarget.get(targetUserId)?.values() ?? []) {
      floor = advanceFloor(floor, rev.ts, rev.seq)
    }
    const [iat, seq] = nextAuthorityStamp(floor)
    const cert = await signRoleCertInternal(
      user.sign,
      user.signPubJwk,
      targetUserId,
      appId,
      effectiveRoomId,
      mergedRoles,
      iat,
      seq
    )
    if (!(await applyCertWithOrigin(cert, true))) {
      throw mkErr('failed to apply issued role certificate')
    }
    return cert
  }

  const issueRoleRevocation: RoomAuthority['issueRoleRevocation'] = async (
    targetId,
    role
  ) => {
    const [user, targetUid] = await requireRootSigner(
      `${insufficientAuthPrefix} to revoke role`,
      targetId
    )
    if (isRootUid(targetUid) && (!role || role === '*' || role === 'admin')) {
      throw rootAdminProtectErr('authority', 'revoke')
    }
    const roleKey = role ?? '*'
    let floor: readonly [number, number] = [0, 0]
    const prevCert = certs.get(targetUid)
    if (prevCert) {
      floor = advanceFloor(floor, prevCert.iat, prevCert.seq)
    }
    const prevRev = revocationsByTarget.get(targetUid)?.get(roleKey)
    if (prevRev) {
      floor = advanceFloor(floor, prevRev.ts, prevRev.seq)
    }
    const [ts, seq] = nextAuthorityStamp(floor)
    const unsigned: Omit<RoleRevocationRecord, 'sig'> = {
      v: 1,
      appId,
      roomId: effectiveRoomId,
      issuerUserId: user.userId,
      targetUserId: targetUid,
      ...(role ? {role} : {}),
      seq,
      ts,
      signerPubKey: jwkToCompactPub(user.signPubJwk)
    }
    const rev: RoleRevocationRecord = {
      ...unsigned,
      sig: await signWith(user.sign, revocationCanonicalPayload(unsigned))
    }
    if (!(await applyRevocationWithOrigin(rev, true))) {
      throw mkErr('failed to apply issued role revocation')
    }
    return rev
  }

  const issuePeerModeration: RoomAuthority['issuePeerModeration'] = async (
    op,
    targetId,
    options
  ) => {
    const [user, targetUid] = await requireRootSigner(
      `${insufficientAuthPrefix}: only a root admin can ${op} a peer`,
      targetId
    )
    if (isRootUid(targetUid)) {
      throw rootAdminProtectErr(op, op)
    }
    const prevMod = moderations.get(targetUid)
    if (
      !prevMod &&
      moderations.size >= maxStoredModerations &&
      ![...moderations.values()].some(m => m.op === 'unban')
    ) {
      throw mkErr(
        `moderation capacity reached (${maxStoredModerations} active bans)`
      )
    }
    let floor: readonly [number, number] = [0, 0]
    const prevCert = certs.get(targetUid)
    if (prevCert) {
      floor = advanceFloor(floor, prevCert.iat, prevCert.seq)
    }
    if (prevMod) {
      floor = advanceFloor(floor, prevMod.ts, prevMod.seq)
    }
    const [ts, seq] = nextAuthorityStamp(floor)
    const unsigned: Omit<PeerModerationRecord, 'sig'> = {
      v: 1,
      op,
      appId,
      roomId: effectiveRoomId,
      issuerUserId: user.userId,
      targetUserId: targetUid,
      ...(op === 'ban' && options?.reason ? {reason: options.reason} : {}),
      seq,
      ts,
      signerPubKey: jwkToCompactPub(user.signPubJwk)
    }
    const mod: PeerModerationRecord = {
      ...unsigned,
      sig: await signWith(user.sign, moderationCanonicalPayload(unsigned))
    }
    if (!(await applyModerationWithOrigin(mod, true))) {
      throw mkErr(`failed to apply issued ${op} record`)
    }
    return mod
  }

  return {
    isAuthorityResolved: () => isResolved,
    getEffectiveRoomId: () => effectiveRoomId,
    getAuthorityInfo: async () => {
      await ensureResolved()
      const roles = [...getPeerRoles()]
      return {
        userId: localUser?.userId ?? resolveUid(getSelfId()),
        roomId: effectiveRoomId,
        baseRoomId,
        isAdmin: roles.includes('admin'),
        roles
      }
    },
    getPeerRoles,
    isPeerBanned,
    getBanReason,
    getLocalActionCert,
    authorizePeerAction,
    getStateWriteCert,
    verifyStateRecordRoles,
    onRoleChange,
    clearRoleListeners: () => {
      pendingReplayHandlers.clear()
      clearRoleChange()
    },
    verifyAndApplyCert,
    verifyAndApplyRevocation,
    verifyAndApplyModeration,
    applySyncBatch,
    hasUnknownRecordSigs,
    buildPullMessage,
    buildDiffSyncMessage,
    buildPushSyncMessages,
    rememberPeerUser,
    issueRoleCertificate,
    issueRoleRevocation,
    issuePeerModeration
  }
}

export const roles = (
  config?: RolesConfig
): RoomPlugin<'roles', RolesPluginApi> => {
  const normalized = normalizeRolesConfig(config)
  const setup = (
    kernel: InternalRoomContext,
    effectiveRoomIdP?: Promise<string>
  ): {provider: KernelRolesProvider; api: RolesPluginApi} => {
    const [hitAuthFailure, , overAuthFailure] = createWindowCounter(512, 8)
    const [hitAuthSyncQuota] = createWindowCounter(512, 96)
    const scaleProv = () => kernel.getScaleProvider()
    let destroyed = false
    let didReportSelfBan = false
    let resolvedLocalUid: string | undefined
    void kernel.getLocalUserIdentity().then(u => {
      resolvedLocalUid = u.userId
    }, noOp)

    const recordPeerAuthFailure = (fromPeerId?: string): void => {
      if (!fromPeerId || fromPeerId === kernel.selfId) {
        return
      }
      if (hitAuthFailure(fromPeerId)) {
        const err = mkErr('excessive invalid authority records')
        kernel.emitError({
          code: 'peer-error',
          peerId: fromPeerId,
          message: err.message,
          cause: err
        })
        kernel.kickPeer(fromPeerId, err)
      }
    }

    const rawAuth = kernel.makeInternalAction<JsonValue>('auth', {
      maxPayloadBytes: 256 * 1024
    })
    const sendAuth = (msg: AuthControlMessage, targets?: TargetPeers) =>
      rawAuth
        .send(
          msg as unknown as JsonValue,
          targets === undefined ? undefined : {target: targets}
        )
        .catch(noOp)

    const bannedPeerIdsByUser = new Map<string, Set<string>>()
    const banKick = (pid: string, uid?: string): void => {
      if (uid) {
        authority.rememberPeerUser(pid, uid)
        let set = bannedPeerIdsByUser.get(uid)
        if (!set) {
          set = new Set()
          bannedPeerIdsByUser.set(uid, set)
        }
        set.add(pid)
      }
      scaleProv()?.markPeerBanned(pid)
      kernel.kickPeer(pid, peerBannedErr)
    }

    const authority = createRoomAuthority({
      selfId: () => kernel.selfId,
      appId: kernel.appId,
      initialRoomId: kernel.getRoomId(),
      ...(effectiveRoomIdP ? {effectiveRoomIdP} : {}),
      admin: normalized,
      getLocalUserIdentity: kernel.getLocalUserIdentity,
      isOverlayPeerBanned: pid => scaleProv()?.isPeerBanned(pid) ?? false,
      getKnownPeerUserId: kernel.getKnownPeerUserId,
      onRoomIdResolved: kernel.setEffectiveRoomId,
      onLocalRoleCertificate: cert =>
        scaleProv()?.setLocalRoleCertificate(cert),
      onRolesChanged: kernel.onRolesChanged,
      onPeerBanned: (bannedUid, banRec, fromPeerId) => {
        const curSelf = kernel.selfId
        const localUid =
          resolvedLocalUid ??
          (curSelf ? kernel.getKnownPeerUserId(curSelf) : undefined)
        if (
          (curSelf && bannedUid === curSelf) ||
          (localUid && bannedUid === localUid)
        ) {
          if (!didReportSelfBan) {
            didReportSelfBan = true
            kernel.emitError(mkBannedErr(banRec.reason, fromPeerId))
          }
          return
        }
        kernel.purgeBannedUserState(bannedUid)
        scaleProv()?.markPeerBanned(bannedUid)
        const toKick = new Set<string>(kernel.getUserPeerIds(bannedUid))
        for (const pid of kernel.getAllPeerIds()) {
          if (authority.isPeerBanned(pid)) {
            toKick.add(pid)
          }
        }
        const activeKickTargets = [...toKick].filter(kernel.isPeerActive)
        if (activeKickTargets.length > 0) {
          void sendAuth({t: 'mod', moderation: banRec}, activeKickTargets)
        }
        toKick.forEach(pid => banKick(pid, bannedUid))
      },
      onPeerUnbanned: unbannedUid => {
        scaleProv()?.unmarkPeerBanned(unbannedUid)
        const unbanPeers = new Set<string>(kernel.getUserPeerIds(unbannedUid))
        const prevBanned = bannedPeerIdsByUser.get(unbannedUid)
        if (prevBanned) {
          bannedPeerIdsByUser.delete(unbannedUid)
          prevBanned.forEach(pid => unbanPeers.add(pid))
        }
        for (const pid of unbanPeers) {
          scaleProv()?.unmarkPeerBanned(pid)
        }
      },
      onSignatureFailure: recordPeerAuthFailure
    })

    const isDirectSendable = (pid: string): boolean =>
      kernel.getDirectActivePeerIds().includes(pid) &&
      !authority.isPeerBanned(pid)

    const antiEntropy = createAntiEntropySync({
      fanout: authPullFanout,
      pullTimeoutMs: authPullTimeoutMs,
      getDirectPeers: kernel.getDirectActivePeerIds,
      isPeerSendable: isDirectSendable,
      sendPull: async (peerId, cursor) => {
        const payload = await authority.buildPullMessage(cursor)
        if (!destroyed && isDirectSendable(peerId)) {
          await rawAuth.send(payload as unknown as JsonValue, {target: peerId})
        }
      }
    })

    rawAuth.onMessage((raw, {peerId: fromPeerId}) => {
      const msg = raw as unknown as AuthControlMessage
      if (
        destroyed ||
        !isObj(msg) ||
        authority.isPeerBanned(fromPeerId) ||
        overAuthFailure(fromPeerId)
      ) {
        return
      }
      if (
        (msg.t === 'pull' || msg.t === 'sync') &&
        hitAuthSyncQuota(fromPeerId)
      ) {
        return
      }
      const arrOver = (arr: unknown, max: number): boolean =>
        Array.isArray(arr) && arr.length > max

      if (msg.t === 'pull') {
        if (
          arrOver(msg.s, authSyncPageSize) ||
          (msg.c !== undefined &&
            (typeof msg.c !== 'string' || msg.c.length > 512))
        ) {
          recordPeerAuthFailure(fromPeerId)
          return
        }
        if (msg.c === undefined && authority.hasUnknownRecordSigs(msg.s)) {
          antiEntropy.pullPeer(fromPeerId, true)
        } else if (msg.c === undefined) {
          antiEntropy.fillFanout()
        }
        void authority.buildDiffSyncMessage(msg.s, msg.c).then(diff => {
          if (
            !destroyed &&
            kernel.isPeerActive(fromPeerId) &&
            !authority.isPeerBanned(fromPeerId)
          ) {
            void sendAuth(diff ?? {t: 'sync'}, fromPeerId)
          }
        })
      } else if (msg.t === 'sync') {
        if (
          arrOver(msg.certs, authSyncPageSize) ||
          arrOver(msg.revocations, authSyncPageSize) ||
          arrOver(msg.moderations, authSyncPageSize) ||
          (msg.n !== undefined &&
            (typeof msg.n !== 'string' || msg.n.length > 512))
        ) {
          recordPeerAuthFailure(fromPeerId)
          return
        }
        if (!msg.f) {
          antiEntropy.onSyncPage(fromPeerId, msg.n)
        }
        void authority
          .applySyncBatch(
            {
              ...(msg.certs !== undefined ? {certs: msg.certs} : {}),
              ...(msg.revocations !== undefined
                ? {revocations: msg.revocations}
                : {}),
              ...(msg.moderations !== undefined
                ? {moderations: msg.moderations}
                : {})
            },
            fromPeerId,
            () => overAuthFailure(fromPeerId)
          )
          .then(({certs, revocations, moderations}) => {
            const fwd = mkSyncMsg(
              certs,
              revocations,
              moderations,
              undefined,
              true
            )
            if (!fwd || destroyed) {
              return
            }
            const directOthers = kernel
              .getDirectActivePeerIds()
              .filter(id => id !== fromPeerId && !authority.isPeerBanned(id))
            if (directOthers.length > 0) {
              void sendAuth(fwd, directOthers)
            }
          })
      } else if (msg.t === 'cert') {
        void authority.verifyAndApplyCert(msg.cert, fromPeerId)
      } else if (msg.t === 'revoke') {
        void authority.verifyAndApplyRevocation(msg.revocation, fromPeerId)
      } else if (msg.t === 'mod') {
        void authority.verifyAndApplyModeration(msg.moderation, fromPeerId)
      }
    })

    const provider: KernelRolesProvider = {
      ...authority,
      onPeerDescriptorCert: (pid, uid, cert) => {
        authority.rememberPeerUser(pid, uid)
        if (authority.isPeerBanned(pid) || authority.isPeerBanned(uid)) {
          banKick(pid, uid)
        } else if (cert && cert.subUserId === uid) {
          void authority.verifyAndApplyCert(cert, pid)
        }
      }
    }

    let syncedOfflineRecords = false

    kernel.onPeerActivated(
      pid => {
        if (!kernel.getDirectActivePeerIds().includes(pid)) {
          return
        }
        if (!syncedOfflineRecords) {
          syncedOfflineRecords = true
          void authority.buildPushSyncMessages().then(msgs => {
            if (!destroyed && isDirectSendable(pid)) {
              for (const msg of msgs) {
                void sendAuth(msg, pid)
              }
            }
          })
        }
        antiEntropy.onPeerJoined(pid, true, Boolean(scaleProv()))
      },
      {replay: true}
    )

    kernel.onPeerDeactivated(pid => {
      if (kernel.getDirectActivePeerIds().length === 0) {
        syncedOfflineRecords = false
      }
      antiEntropy.onPeerDisconnected(pid)
    })

    kernel.onLeave(() => {
      destroyed = true
      antiEntropy.destroy()
      authority.clearRoleListeners()
    })

    const api = lockMethods(
      {
        grantRole: async (id, role) => {
          const cert = await authority.issueRoleCertificate(id, role)
          await sendAuth({t: 'cert', cert})
          return cert
        },
        revokeRole: async (id, role) => {
          const revocation = await authority.issueRoleRevocation(id, role)
          await sendAuth({t: 'revoke', revocation})
        },
        getRoles: (...args: [targetId?: string]) =>
          authority.getPeerRoles(...args),
        ban: async (id, opts) => {
          const moderation = await authority.issuePeerModeration(
            'ban',
            id,
            opts
          )
          await sendAuth({t: 'mod', moderation})
        },
        unban: async id => {
          const moderation = await authority.issuePeerModeration('unban', id)
          await sendAuth({t: 'mod', moderation})
        },
        isBanned: authority.isPeerBanned,
        onRoleChange: authority.onRoleChange
      } satisfies RolesPluginApi,
      ['onRoleChange']
    )

    return {provider, api}
  }

  const plugin = {name: 'roles'} as RoomPlugin<'roles', RolesPluginApi>
  const slot: RolesPluginSlot = {
    kind: 'roles',
    selfAsAdmin: Boolean(normalized.selfAsAdmin),
    setup
  }
  Object.defineProperty(plugin, pluginSlotSymbol, {
    value: slot,
    enumerable: false
  })
  return plugin
}
