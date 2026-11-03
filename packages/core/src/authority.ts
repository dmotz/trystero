import {getVerifiedPubKeyRecord, isValidUserId} from './identity'
import type {
  InternalRoomContext,
  KernelRolesProvider,
  PeerModerationRecord,
  RoleRevocationRecord,
  TargetPeers
} from './internal-types'
import {makeInternalPlugin} from './plugin'
import {
  canonTag,
  createMonotonicClock,
  defaultMaxClockSkewMs,
  invalidRoles,
  isValidJwk,
  roleCertPayload,
  selectPullFanoutPeers,
  signRoleCertInternal,
  signWith,
  toCleanJwk,
  verifySig
} from './signed-record'
import type {
  JsonValue,
  RoleCertificate,
  RolesConfig,
  RolesPluginApi,
  RoomPlugin,
  UserIdentity
} from './types'
import {
  cmpStr,
  createBoundedCache,
  createWindowCounter,
  insufficientAuthPrefix,
  isObj,
  isPosSafeInt,
  isStr,
  isValidSig,
  keys,
  mkBannedErr,
  mkErr,
  noOp,
  peerBannedErr,
  resetTimer,
  selfCertifyingRoomRegex,
  unrefTimer,
  validateRoleCertificateShape
} from './utils'

const maxSyncCerts = 128
const maxSyncModerationRecords = 256
const maxStoredTargets = 1_024
const authPullFanout = 2
const authPullTimeoutMs = 1_500

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
  isValidJwk(rec['signerPubKey']) &&
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
}

type AuthSyncMessage = {
  t: 'sync'
  certs?: RoleCertificate[]
  revocations?: RoleRevocationRecord[]
  moderations?: PeerModerationRecord[]
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

type RoomAuthorityPreResolvedState = readonly [
  baseRoomId: string,
  adminUserId: string
]

export type RoomAuthorityInit = {
  selfId: string
  appId: string
  initialRoomId: string
  effectiveRoomIdP?: Promise<string>
  getPreResolvedState?: () => RoomAuthorityPreResolvedState | undefined
  admin?: RolesConfig
  getLocalUserIdentity?: () => Promise<UserIdentity>
  isOverlayPeerBanned?: (peerId: string) => boolean
  getKnownPeerUserId?: (peerId: string) => string | undefined
  onRoomIdResolved?: (effectiveRoomId: string) => void
  onLocalRoleCertificate?: (cert: RoleCertificate | null) => void
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
  buildPullMessage: () => Promise<AuthPullMessage>
  buildDiffSyncMessage: (
    knownSigs?: readonly string[]
  ) => Promise<AuthSyncMessage | null>
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
  moderations: PeerModerationRecord[]
): AuthSyncMessage | null =>
  certs.length || revocations.length || moderations.length
    ? {
        t: 'sync',
        ...(certs.length ? {certs} : {}),
        ...(revocations.length ? {revocations} : {}),
        ...(moderations.length ? {moderations} : {})
      }
    : null

export const createRoomAuthority = ({
  selfId,
  appId,
  initialRoomId,
  effectiveRoomIdP,
  getPreResolvedState,
  admin: rawAdmin,
  getLocalUserIdentity,
  isOverlayPeerBanned,
  getKnownPeerUserId,
  onRoomIdResolved,
  onLocalRoleCertificate,
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
    const pre = getPreResolvedState?.()
    const [base, uid] = splitSelfCertRoom(rid)
    baseRoomId = pre?.[0] ?? base
    const adminUid = pre?.[1] || uid
    if (adminUid) {
      roomAdminUserId = adminUid
      rootUserIds.add(adminUid)
    }
  }
  syncRoomIds(initialRoomId)

  const failSig = (fromPeerId?: string): false => (
    onSignatureFailure?.(fromPeerId),
    false
  )

  const resolveUid = (id = selfId): string =>
    id === selfId && localUser ? localUser.userId : (lookupPeerUid(id) ?? id)

  const candidateUids = (id = selfId): string[] => {
    const set = new Set<string>([resolveUid(id), id])
    const mapped = lookupPeerUid(id)
    if (mapped) {
      set.add(mapped)
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
    if (mod && !isRoot && (mod.op === 'ban' || cert.iat <= mod.ts)) {
      return []
    }
    const revoked = new Set<string>()
    const revMap = revocationsByTarget.get(subUid)
    if (revMap) {
      for (const [roleKey, rev] of revMap) {
        if (rev.ts >= cert.iat) {
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

  const isCertHeaderValid = (cert: unknown): cert is RoleCertificate =>
    validateRoleCertificateShape(cert) &&
    cert.appId === appId &&
    cert.roomId === effectiveRoomId &&
    cert.iat <= Date.now() + clockSkewMs &&
    (isRootUid(cert.subUserId)
      ? cert.roles.includes('admin')
      : !cert.roles.includes('admin'))

  const certCacheKey = (cert: RoleCertificate): string =>
    `${roleCertPayload(cert)}\u0000${cert.sig}`

  const verifyCertCached = async (
    cert: RoleCertificate
  ): Promise<{valid: boolean; roles: string[]}> => {
    if (!isCertHeaderValid(cert)) {
      return invalidRoles()
    }
    const cacheKey = certCacheKey(cert)
    const cachedRoles = verifiedCertCache.get(cacheKey)
    if (cachedRoles) {
      return {valid: true, roles: [...cachedRoles]}
    }
    const issuer = await getVerifiedPubKeyRecord(cert.issuerPubKey)
    if (
      !issuer ||
      !isRootUid(issuer[6]) ||
      !(await verifySig(cert.issuerPubKey, roleCertPayload(cert), cert.sig))
    ) {
      return invalidRoles()
    }
    const roles = [...cert.roles]
    verifiedCertCache.set(cacheKey, [...roles])
    return {valid: true, roles}
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
    if (!signer || signer[6] !== rec.issuerUserId) {
      return false
    }
    return verifySig(rec.signerPubKey, payload, rec.sig)
  }

  const nonRootUids = (id: string): string[] | null => {
    const uids = candidateUids(id)
    return uids.some(isRootUid) ? null : uids
  }

  const getPeerRoles = (peerOrUserId = selfId): string[] => {
    const uids = candidateUids(peerOrUserId)
    if (uids.some(isTargetBanned)) {
      return []
    }
    for (const uid of uids) {
      const cert = certs.get(uid)
      if (cert) {
        return effectiveRoles(cert)
      }
      if (isRootUid(uid)) {
        return ['admin']
      }
    }
    return []
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
      syncLocalCert()
    })())
  void ensureResolved().catch(noOp)

  const guardApply = <T>(fn: () => Promise<T>, fallback: () => T): Promise<T> =>
    ensureResolved().then(fn).catch(fallback)

  const evictOldestTargetIfNeeded = <T>(
    map: Map<string, T>,
    canEvict?: (val: T) => boolean
  ): boolean => {
    if (map.size < maxStoredTargets) {
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
    if (!isCertHeaderValid(cert)) {
      return failSig(fromPeerId)
    }
    const prev = certs.get(cert.subUserId)
    if (prev && (prev.sig === cert.sig || prev.iat >= cert.iat)) {
      return false
    }
    if (!prev && !evictOldestTargetIfNeeded(certs)) {
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
    if (!existingMap && !evictOldestTargetIfNeeded(revocationsByTarget)) {
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
      !evictOldestTargetIfNeeded(moderations, val => val.op === 'unban') &&
      !evictOldestTargetIfNeeded(moderations)
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

  const verifyAndApplyCert: RoomAuthority['verifyAndApplyCert'] = (
    cert,
    fromPeerId
  ) =>
    guardApply(
      async () => {
        if (!(await stageCertInternal(cert, fromPeerId))) {
          return false
        }
        syncLocalCert()
        return true
      },
      () => failSig(fromPeerId)
    )

  const verifyAndApplyRevocation: RoomAuthority['verifyAndApplyRevocation'] = (
    rev,
    fromPeerId
  ) =>
    guardApply(
      async () => {
        if (!(await stageRevocationInternal(rev, fromPeerId))) {
          return false
        }
        syncLocalCert()
        return true
      },
      () => failSig(fromPeerId)
    )

  const notifyModerationTransition = (
    transition: 'ban' | 'unban' | 'updated',
    mod: PeerModerationRecord,
    fromPeerId?: string
  ): void => {
    syncLocalCert()
    if (transition === 'ban') {
      onPeerBanned?.(mod.targetUserId, mod, fromPeerId)
    } else if (transition === 'unban') {
      onPeerUnbanned?.(mod.targetUserId, mod, fromPeerId)
    }
  }

  const verifyAndApplyModeration: RoomAuthority['verifyAndApplyModeration'] = (
    mod,
    fromPeerId
  ) =>
    guardApply(
      async () => {
        const res = await stageModerationInternal(mod, fromPeerId)
        if (!res) {
          return false
        }
        notifyModerationTransition(res, mod, fromPeerId)
        return true
      },
      () => failSig(fromPeerId)
    )

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
          maxSyncCerts
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
          maxSyncModerationRecords
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
          maxSyncModerationRecords
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

  const collectAllRevs = (): RoleRevocationRecord[] => {
    const out: RoleRevocationRecord[] = []
    for (const targetMap of revocationsByTarget.values()) {
      for (const rev of targetMap.values()) {
        out.push(rev)
        if (out.length >= maxSyncModerationRecords) {
          return out
        }
      }
    }
    return out
  }

  const collectKnownSig8Set = (): Set<string> => {
    const set = new Set<string>()
    for (const cert of certs.values()) {
      set.add(sig8(cert))
    }
    for (const rev of collectAllRevs()) {
      set.add(sig8(rev))
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

  const buildPullMessage: RoomAuthority['buildPullMessage'] = async () => {
    await ensureResolved()
    const s = [
      ...[...certs.values()].slice(0, maxSyncCerts),
      ...collectAllRevs(),
      ...[...moderations.values()].slice(0, maxSyncModerationRecords)
    ].map(sig8)
    return {
      t: 'pull' as const,
      ...(s.length ? {s} : {})
    }
  }

  const buildDiffSyncMessage: RoomAuthority['buildDiffSyncMessage'] =
    async knownSigs => {
      await ensureResolved()
      const known = new Set(
        Array.isArray(knownSigs) ? knownSigs.filter(isStr) : []
      )
      return mkSyncMsg(
        [...certs.values()]
          .slice(0, maxSyncCerts)
          .filter(x => !known.has(sig8(x))),
        collectAllRevs().filter(x => !known.has(sig8(x))),
        [...moderations.values()]
          .slice(0, maxSyncModerationRecords)
          .filter(x => !known.has(sig8(x)))
      )
    }

  const requireLocalCertOrIntrinsicAdmin = (
    requiredRoles: readonly string[],
    forState: boolean,
    namespace: string
  ): readonly [RoleCertificate | null, string[]] => {
    const myRoles = getPeerRoles(selfId)
    if (!hasAnyRole(myRoles, requiredRoles)) {
      throw mkErr(
        `${insufficientAuthPrefix} ${forState ? 'to update state' : 'for action'} "${namespace}": requires [${requiredRoles.join(', ')}]`
      )
    }
    if (localCert) {
      return [localCert, myRoles]
    }
    if (
      localUser &&
      isRootUid(localUser.userId) &&
      requiredRoles.includes('admin')
    ) {
      return [null, myRoles]
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
    const peerUid = getKnownPeerUserId?.(peerId)
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
      const myRoles = getPeerRoles(selfId)
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
          rec.hlc < rec.cert.iat
        ) {
          failSig(fromPeerId)
          return invalidRoles()
        }
        const prev = certs.get(rec.userId)
        if (!prev || rec.cert.iat > prev.iat) {
          certs.set(rec.userId, rec.cert)
          syncLocalCert()
        }
        const roles = effectiveRoles(rec.cert)
        return requiredRoles?.length && !hasAnyRole(roles, requiredRoles)
          ? invalidRoles()
          : {valid: true, roles}
      }
      if (requiredRoles?.length) {
        const intrinsicRoles = isRootUid(rec.userId) ? ['admin'] : []
        return hasAnyRole(intrinsicRoles, requiredRoles)
          ? {valid: true, roles: getPeerRoles(rec.userId)}
          : invalidRoles()
      }
      return {valid: true, roles: getPeerRoles(rec.userId)}
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

  const maxRevocationTsForTarget = (targetUid: string): number => {
    let maxTs = 0
    for (const rev of revocationsByTarget.get(targetUid)?.values() ?? []) {
      if (rev.ts > maxTs) {
        maxTs = rev.ts
      }
    }
    return maxTs
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
    const minTs = Math.max(
      certs.get(targetUserId)?.iat ?? 0,
      moderations.get(targetUserId)?.ts ?? 0,
      maxRevocationTsForTarget(targetUserId)
    )
    const cert = await signRoleCertInternal(
      user.sign,
      user.signPubJwk,
      targetUserId,
      appId,
      effectiveRoomId,
      mergedRoles,
      clock.next(minTs + 1)
    )
    if (!(await verifyAndApplyCert(cert))) {
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
    const prevRev = revocationsByTarget.get(targetUid)?.get(roleKey)
    const minTs = Math.max(
      certs.get(targetUid)?.iat ?? 0,
      prevRev ? prevRev.ts + 1 : 0
    )
    const unsigned: Omit<RoleRevocationRecord, 'sig'> = {
      v: 1,
      appId,
      roomId: effectiveRoomId,
      issuerUserId: user.userId,
      targetUserId: targetUid,
      ...(role ? {role} : {}),
      seq: ++localModSeq,
      ts: clock.next(minTs),
      signerPubKey: toCleanJwk(user.signPubJwk)
    }
    const rev: RoleRevocationRecord = {
      ...unsigned,
      sig: await signWith(user.sign, revocationCanonicalPayload(unsigned))
    }
    if (!(await verifyAndApplyRevocation(rev))) {
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
    const minTs = Math.max(
      certs.get(targetUid)?.iat ?? 0,
      prevMod ? prevMod.ts + 1 : 0
    )
    const unsigned: Omit<PeerModerationRecord, 'sig'> = {
      v: 1,
      op,
      appId,
      roomId: effectiveRoomId,
      issuerUserId: user.userId,
      targetUserId: targetUid,
      ...(op === 'ban' && options?.reason ? {reason: options.reason} : {}),
      seq: ++localModSeq,
      ts: clock.next(minTs),
      signerPubKey: toCleanJwk(user.signPubJwk)
    }
    const mod: PeerModerationRecord = {
      ...unsigned,
      sig: await signWith(user.sign, moderationCanonicalPayload(unsigned))
    }
    if (!(await verifyAndApplyModeration(mod))) {
      throw mkErr(`failed to apply issued ${op} record`)
    }
    return mod
  }

  return {
    getEffectiveRoomId: () => effectiveRoomId,
    getAuthorityInfo: async () => {
      await ensureResolved()
      const roles = getPeerRoles(selfId)
      return {
        userId: localUser?.userId ?? resolveUid(selfId),
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
    verifyAndApplyCert,
    verifyAndApplyRevocation,
    verifyAndApplyModeration,
    applySyncBatch,
    hasUnknownRecordSigs,
    buildPullMessage,
    buildDiffSyncMessage,
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
  const setupInternal = (
    kernel: InternalRoomContext,
    getPre?: () => RoomAuthorityPreResolvedState | undefined
  ): RolesPluginApi => {
    const [hitAuthFailure, , overAuthFailure] = createWindowCounter(512, 8)
    const [hitAuthSyncQuota] = createWindowCounter(512, 24)
    const completedSyncPeers = new Set<string>()
    const inFlightPullTimers = new Map<string, ReturnType<typeof setTimeout>>()
    const scaleProv = () => kernel.getScaleProvider()
    let destroyed = false
    let didReportSelfBan = false

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
      selfId: kernel.selfId,
      appId: kernel.appId,
      initialRoomId: kernel.getRoomId(),
      ...(kernel.effectiveRoomIdP
        ? {effectiveRoomIdP: kernel.effectiveRoomIdP}
        : {}),
      ...(getPre ? {getPreResolvedState: getPre} : {}),
      admin: normalized,
      getLocalUserIdentity: kernel.getLocalUserIdentity,
      isOverlayPeerBanned: pid => scaleProv()?.isPeerBanned(pid) ?? false,
      getKnownPeerUserId: kernel.getKnownPeerUserId,
      onRoomIdResolved: kernel.setEffectiveRoomId,
      onLocalRoleCertificate: cert =>
        scaleProv()?.setLocalRoleCertificate(cert),
      onPeerBanned: (bannedUid, banRec, fromPeerId) => {
        const localUid = kernel.getKnownPeerUserId(kernel.selfId)
        if (
          bannedUid === kernel.selfId ||
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

    const clearPullTimer = (peerId: string): void => {
      resetTimer(inFlightPullTimers.get(peerId))
      inFlightPullTimers.delete(peerId)
    }

    const fillPullFanout = (): void => {
      if (destroyed) {
        return
      }
      for (const candidate of selectPullFanoutPeers(
        kernel.selfId,
        kernel.getDirectActivePeerIds(),
        authority.isPeerBanned
      )) {
        if (
          completedSyncPeers.size + inFlightPullTimers.size >=
          authPullFanout
        ) {
          break
        }
        if (
          !completedSyncPeers.has(candidate) &&
          !inFlightPullTimers.has(candidate)
        ) {
          void sendPull(candidate)
        }
      }
    }

    const sendPull = async (peerId: string, force = false): Promise<void> => {
      if (
        destroyed ||
        (!force &&
          (completedSyncPeers.has(peerId) || inFlightPullTimers.has(peerId))) ||
        !isDirectSendable(peerId)
      ) {
        return
      }
      clearPullTimer(peerId)
      const timer = setTimeout(() => {
        inFlightPullTimers.delete(peerId)
        if (!destroyed && completedSyncPeers.size < authPullFanout) {
          fillPullFanout()
        }
      }, authPullTimeoutMs)
      unrefTimer(timer)
      inFlightPullTimers.set(peerId, timer)

      const payload = await authority.buildPullMessage()
      if (!destroyed && isDirectSendable(peerId)) {
        await rawAuth
          .send(payload as unknown as JsonValue, {target: peerId})
          .catch(() => clearPullTimer(peerId))
      } else {
        clearPullTimer(peerId)
      }
    }

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
        if (arrOver(msg.s, maxSyncCerts + maxSyncModerationRecords * 2)) {
          recordPeerAuthFailure(fromPeerId)
          return
        }
        if (authority.hasUnknownRecordSigs(msg.s)) {
          void sendPull(fromPeerId, true)
        } else if (
          completedSyncPeers.size + inFlightPullTimers.size < authPullFanout &&
          !completedSyncPeers.has(fromPeerId) &&
          !inFlightPullTimers.has(fromPeerId)
        ) {
          void sendPull(fromPeerId)
        }
        void authority.buildDiffSyncMessage(msg.s).then(diff => {
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
          arrOver(msg.certs, maxSyncCerts) ||
          arrOver(msg.revocations, maxSyncModerationRecords) ||
          arrOver(msg.moderations, maxSyncModerationRecords)
        ) {
          recordPeerAuthFailure(fromPeerId)
          return
        }
        if (inFlightPullTimers.has(fromPeerId)) {
          clearPullTimer(fromPeerId)
          completedSyncPeers.add(fromPeerId)
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
            const fwd = mkSyncMsg(certs, revocations, moderations)
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

    kernel.registerRolesProvider({
      ...authority,
      onPeerDescriptorCert: (pid, uid, cert) => {
        authority.rememberPeerUser(pid, uid)
        if (authority.isPeerBanned(pid) || authority.isPeerBanned(uid)) {
          banKick(pid, uid)
        } else if (cert && cert.subUserId === uid) {
          void authority.verifyAndApplyCert(cert, pid)
        }
      }
    })

    let syncedOfflineRecords = false

    kernel.onPeerActivated(
      pid => {
        if (!kernel.getDirectActivePeerIds().includes(pid)) {
          return
        }
        if (!syncedOfflineRecords) {
          syncedOfflineRecords = true
          void authority.buildDiffSyncMessage().then(initialSync => {
            if (initialSync && !destroyed && isDirectSendable(pid)) {
              void sendAuth(initialSync, pid)
            }
          })
        }
        fillPullFanout()
      },
      {replay: true}
    )

    kernel.onPeerDeactivated(pid => {
      clearPullTimer(pid)
      completedSyncPeers.delete(pid)
      if (kernel.getDirectActivePeerIds().length === 0) {
        syncedOfflineRecords = false
      }
      if (!destroyed && completedSyncPeers.size < authPullFanout) {
        fillPullFanout()
      }
    })

    kernel.onLeave(() => {
      destroyed = true
      inFlightPullTimers.forEach(resetTimer)
      inFlightPullTimers.clear()
      completedSyncPeers.clear()
    })

    return {
      grantRole: async (id, role) => {
        const cert = await authority.issueRoleCertificate(id, role)
        await sendAuth({t: 'cert', cert})
        return cert
      },
      revokeRole: async (id, role) => {
        const revocation = await authority.issueRoleRevocation(id, role)
        await sendAuth({t: 'revoke', revocation})
      },
      getRoles: authority.getPeerRoles,
      ban: async (id, opts) => {
        const moderation = await authority.issuePeerModeration('ban', id, opts)
        await sendAuth({t: 'mod', moderation})
      },
      unban: async id => {
        const moderation = await authority.issuePeerModeration('unban', id)
        await sendAuth({t: 'mod', moderation})
      },
      isBanned: authority.isPeerBanned
    }
  }

  return makeInternalPlugin<
    'roles',
    RolesPluginApi,
    RoomAuthorityPreResolvedState
  >('roles', setupInternal, {
    selfAsAdmin: Boolean(normalized.selfAsAdmin),
    resolveRoomId: async ({roomId, userIdentityP}) => {
      const [base, uid] = splitSelfCertRoom(roomId)
      const adminUid =
        uid ?? (normalized.selfAsAdmin ? (await userIdentityP).userId : null)
      return adminUid
        ? {
            effectiveRoomId: `${base}~${adminUid}`,
            state: [base, adminUid] as const
          }
        : {effectiveRoomId: roomId}
    }
  })
}
