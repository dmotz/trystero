import assert from 'node:assert/strict'
import test from './test.ts'
import {
  createRoomAuthority,
  moderationCanonicalPayload,
  revocationCanonicalPayload,
  roles,
  validatePeerModerationShape,
  validateRoleRevocationShape
} from '../../packages/core/src/authority.ts'
import {createUserIdentity} from '../../packages/core/src/identity.ts'
import type {
  PeerModerationRecord,
  RoleRevocationRecord
} from '../../packages/core/src/internal-types.ts'
import {scale} from '../../packages/core/src/scale/index.ts'
import {
  signRoleCertInternal,
  signWith,
  toCleanJwk,
  verifyRoleCertificate
} from '../../packages/core/src/signed-record.ts'
import {
  createStateManager,
  signStateRecord
} from '../../packages/core/src/state.ts'
import type {RoomError, UserIdentity} from '../../packages/core/src/types.ts'
import {validateRoleCertificateShape} from '../../packages/core/src/utils.ts'
import {createMemorySignalBus} from './memory-rtc.ts'
import {testPeerId, wait, waitFor} from './peer-harness.ts'

const signRevocation = async (
  signer: UserIdentity,
  params: {
    appId: string
    roomId: string
    targetUserId: string
    role?: string
    seq: number
    ts?: number
  }
): Promise<RoleRevocationRecord> => {
  const unsigned: Omit<RoleRevocationRecord, 'sig'> = {
    v: 1,
    appId: params.appId,
    roomId: params.roomId,
    issuerUserId: signer.userId,
    targetUserId: params.targetUserId,
    ...(params.role !== undefined ? {role: params.role} : {}),
    seq: params.seq,
    ts: params.ts ?? Date.now(),
    signerPubKey: toCleanJwk(signer.signPubJwk)
  }
  return {
    ...unsigned,
    sig: await signWith(signer.sign, revocationCanonicalPayload(unsigned))
  }
}

const signModeration = async (
  signer: UserIdentity,
  params: {
    op: 'ban' | 'unban'
    appId: string
    roomId: string
    targetUserId: string
    reason?: string
    seq: number
    ts?: number
  }
): Promise<PeerModerationRecord> => {
  const unsigned: Omit<PeerModerationRecord, 'sig'> = {
    v: 1,
    op: params.op,
    appId: params.appId,
    roomId: params.roomId,
    issuerUserId: signer.userId,
    targetUserId: params.targetUserId,
    ...(params.reason !== undefined ? {reason: params.reason} : {}),
    seq: params.seq,
    ts: params.ts ?? Date.now(),
    signerPubKey: toCleanJwk(signer.signPubJwk)
  }
  return {
    ...unsigned,
    sig: await signWith(signer.sign, moderationCanonicalPayload(unsigned))
  }
}

const setup = async () => {
  const [root, coRoot, moderator, target] = await Promise.all([
    createUserIdentity(),
    createUserIdentity(),
    createUserIdentity(),
    createUserIdentity()
  ])
  const scope = {appId: 'moderation-test', roomId: 'room'}
  const ownerPeerId = testPeerId('mod-owner')
  const coRootPeerId = testPeerId('mod-coroot')
  const modPeerId = testPeerId('mod-delegate')
  const targetPeerId = testPeerId('mod-target')

  const peerUsers: Record<string, string> = {
    [ownerPeerId]: root.userId,
    [coRootPeerId]: coRoot.userId,
    [modPeerId]: moderator.userId,
    [targetPeerId]: target.userId
  }

  const authority = createRoomAuthority({
    selfId: ownerPeerId,
    appId: scope.appId,
    initialRoomId: scope.roomId,
    admin: {admins: [root.userId, coRoot.userId]},
    getLocalUserIdentity: async () => root,
    isOverlayPeerBanned: () => false,
    getKnownPeerUserId: pid => peerUsers[pid],
    onRoomIdResolved: () => {},
    onLocalRoleCertificate: () => {},
    onPeerBanned: () => {},
    onPeerUnbanned: () => {},
    onSignatureFailure: () => {}
  })
  const modAuthority = createRoomAuthority({
    selfId: modPeerId,
    appId: scope.appId,
    initialRoomId: scope.roomId,
    admin: {admins: [root.userId, coRoot.userId]},
    getLocalUserIdentity: async () => moderator,
    isOverlayPeerBanned: () => false,
    getKnownPeerUserId: pid => peerUsers[pid]
  })
  await Promise.all([
    authority.getAuthorityInfo(),
    modAuthority.getAuthorityInfo()
  ])

  const stateManager = createStateManager({
    appId: scope.appId,
    getRoomId: () => authority.getEffectiveRoomId(),
    getSelfId: () => ownerPeerId,
    getLocalUserId: () => root.userId,
    ensureReady: async () => ({
      selfId: ownerPeerId,
      user: root,
      roomId: authority.getEffectiveRoomId()
    }),
    hasRolesPlugin: () => true,
    getRolesProvider: () => ({...authority, onPeerDescriptorCert: () => {}}),
    isPeerActive: () => true,
    isDirectPeer: () => true,
    getDirectPeerIds: () => [],
    isUserOnline: () => true,
    getKnownPeerUserId: pid => peerUsers[pid],
    isPeerBanned: id => authority.isPeerBanned(id),
    getPeerRoles: id => authority.getPeerRoles(id)
  })
  stateManager.makeState('cfg', {}, {roles: ['admin', 'moderator']})
  stateManager.makeState('clock-test', '')

  const grant = async (identity: UserIdentity, grantedRoles: string[]) => {
    const cert = await signRoleCertInternal(
      root.sign,
      root.signPubJwk,
      identity.userId,
      scope.appId,
      scope.roomId,
      grantedRoles,
      Date.now()
    )
    await authority.verifyAndApplyCert(cert)
    await modAuthority.verifyAndApplyCert(cert)
    return cert
  }

  return {
    authority,
    modAuthority,
    stateManager,
    root: {...root, peerId: ownerPeerId},
    coRoot: {...coRoot, peerId: coRootPeerId},
    moderator: {...moderator, peerId: modPeerId},
    target: {...target, peerId: targetPeerId},
    scope,
    grant
  }
}

void test('1-tier root-admin authority: non-root role holders cannot grantRole, revokeRole, ban, or unban, and "admin" cannot be granted to non-root users', async () => {
  const {
    authority,
    modAuthority,
    stateManager,
    root,
    moderator,
    target,
    scope,
    grant
  } = await setup()

  try {
    await grant(moderator, ['moderator'])
    await grant(target, ['player', 'viewer'])
    assert.deepEqual(authority.getPeerRoles(moderator.peerId), ['moderator'])
    assert.deepEqual(authority.getPeerRoles(target.peerId), [
      'player',
      'viewer'
    ])

    // Root admin cannot grant reserved 'admin' role to non-root user, and forged 'admin' cert for non-root is rejected
    await assert.rejects(
      () => authority.issueRoleCertificate(moderator.userId, 'admin'),
      /'admin' role is reserved for room root admins/
    )
    const forgedAdminForNonRoot = await signRoleCertInternal(
      root.sign,
      root.signPubJwk,
      moderator.userId,
      scope.appId,
      scope.roomId,
      ['admin', 'moderator'],
      Date.now() + 1_000
    )
    assert.equal(
      (
        await verifyRoleCertificate(
          forgedAdminForNonRoot,
          scope.appId,
          scope.roomId,
          new Set([root.userId])
        )
      ).valid,
      false
    )
    assert.equal(
      await authority.verifyAndApplyCert(forgedAdminForNonRoot),
      false
    )

    // Non-root 'moderator' cannot call issueRoleCertificate, issueRoleRevocation, or issuePeerModeration('ban' | 'unban')
    await assert.rejects(
      () => modAuthority.issueRoleCertificate(target.userId, 'helper'),
      /insufficient authority/i
    )
    await assert.rejects(
      () => modAuthority.issueRoleRevocation(target.userId, 'player'),
      /insufficient authority/i
    )
    await assert.rejects(
      () => modAuthority.issuePeerModeration('ban', target.userId),
      /insufficient authority/i
    )
    await assert.rejects(
      () => modAuthority.issuePeerModeration('unban', target.userId),
      /insufficient authority/i
    )

    // Forged wire records signed by non-root 'moderator' (cert, revocations, ban, unban) are strictly rejected
    const forgedCert = await signRoleCertInternal(
      moderator.sign,
      moderator.signPubJwk,
      target.userId,
      scope.appId,
      scope.roomId,
      ['helper'],
      Date.now() + 2_000
    )
    assert.equal(await authority.verifyAndApplyCert(forgedCert), false)

    for (const role of ['player', 'viewer', '*', undefined]) {
      const forgedRev = await signRevocation(moderator, {
        ...scope,
        targetUserId: target.userId,
        seq: 1,
        ...(role === undefined ? {} : {role})
      })
      assert.equal(await authority.verifyAndApplyRevocation(forgedRev), false)
    }

    const forgedBan = await signModeration(moderator, {
      op: 'ban',
      ...scope,
      targetUserId: target.userId,
      seq: 2
    })
    assert.equal(await authority.verifyAndApplyModeration(forgedBan), false)
    assert.equal(authority.isPeerBanned(target.peerId), false)

    // Even after root bans target, non-root 'moderator' cannot unban target
    const validBan = await authority.issuePeerModeration('ban', target.userId, {
      reason: 'rule-violation'
    })
    assert.equal(validBan.op, 'ban')
    assert.equal(authority.isPeerBanned(target.peerId), true)

    const forgedUnban = await signModeration(moderator, {
      op: 'unban',
      ...scope,
      targetUserId: target.userId,
      seq: 3,
      ts: validBan.ts + 5_000
    })
    assert.equal(await authority.verifyAndApplyModeration(forgedUnban), false)
    assert.equal(authority.isPeerBanned(target.peerId), true)
  } finally {
    stateManager.destroy()
  }
})

void test('C3 regression: RoleRevocationRecord cannot be re-wrapped as a PeerModerationRecord (and vice versa), and op tampering fails verification', async () => {
  const {authority, stateManager, root, target, scope, grant} = await setup()

  try {
    await grant(target, ['moderator'])
    assert.deepEqual(authority.getPeerRoles(target.peerId), ['moderator'])

    const revocation = await signRevocation(root, {
      ...scope,
      targetUserId: target.userId,
      role: 'moderator',
      seq: 1
    })

    const forgedModFromRevocation: PeerModerationRecord = {
      v: revocation.v,
      op: 'ban',
      appId: revocation.appId,
      roomId: revocation.roomId,
      issuerUserId: revocation.issuerUserId,
      targetUserId: revocation.targetUserId,
      ...(revocation.role ? {reason: revocation.role} : {}),
      seq: revocation.seq,
      ts: revocation.ts,
      signerPubKey: revocation.signerPubKey,
      sig: revocation.sig
    }

    assert.notEqual(
      revocationCanonicalPayload(revocation),
      moderationCanonicalPayload(forgedModFromRevocation),
      'revocation and moderation canonical payloads must be domain-separated'
    )
    assert.equal(
      await authority.verifyAndApplyModeration(forgedModFromRevocation),
      false,
      'verifyAndApplyModeration must reject a re-wrapped RoleRevocationRecord'
    )
    assert.equal(authority.isPeerBanned(target.peerId), false)
    assert.equal(authority.isPeerBanned(target.userId), false)

    // Valid PeerModerationRecord cannot be re-wrapped as a RoleRevocationRecord, nor have op flipped ('ban' -> 'unban')
    const validMod = await signModeration(root, {
      op: 'ban',
      ...scope,
      targetUserId: target.userId,
      reason: 'moderator',
      seq: 2
    })
    const forgedRevocationFromMod: RoleRevocationRecord = {
      v: validMod.v,
      appId: validMod.appId,
      roomId: validMod.roomId,
      issuerUserId: validMod.issuerUserId,
      targetUserId: validMod.targetUserId,
      ...(validMod.reason ? {role: validMod.reason} : {}),
      seq: validMod.seq,
      ts: validMod.ts,
      signerPubKey: validMod.signerPubKey,
      sig: validMod.sig
    }
    assert.equal(
      await authority.verifyAndApplyRevocation(forgedRevocationFromMod),
      false,
      'verifyAndApplyRevocation must reject a re-wrapped PeerModerationRecord'
    )
    assert.deepEqual(authority.getPeerRoles(target.peerId), ['moderator'])

    // Apply valid ban, then attempt to replay its signature with op flipped to 'unban' and newer ts -> fails!
    assert.equal(await authority.verifyAndApplyModeration(validMod), true)
    assert.equal(authority.isPeerBanned(target.peerId), true)
    assert.equal(
      await authority.verifyAndApplyModeration({
        ...validMod,
        op: 'unban',
        seq: validMod.seq + 1,
        ts: validMod.ts + 1_000
      }),
      false,
      'flipping PeerModerationRecord op must invalidate signature'
    )
    assert.equal(authority.isPeerBanned(target.peerId), true)
  } finally {
    stateManager.destroy()
  }
})

void test('inline action cert spoofing, malformed records, stale cert deduplication, state Infinity/cert.iat bounds, co-root protection, and multi-tab root moderation', async () => {
  const {
    authority,
    stateManager,
    root,
    coRoot,
    moderator,
    target,
    scope,
    grant
  } = await setup()

  try {
    // 1. Inline cert role spoofing: peer with stored 'speaker' cert presents tampered inline cert (same certId, forged roles: ['moderator'])
    const speakerCert = await grant(target, ['speaker'])
    assert.deepEqual(authority.getPeerRoles(target.peerId), ['speaker'])

    const spoofedInlineCert = {
      ...speakerCert,
      iat: speakerCert.iat + 1_000,
      roles: ['moderator']
    }
    const authRes = await authority.authorizePeerAction(
      target.peerId,
      ['moderator'],
      spoofedInlineCert
    )
    assert.equal(
      authRes,
      false,
      'authorizePeerAction must reject tampered inline cert spoofing roles'
    )
    assert.deepEqual(authority.getPeerRoles(target.peerId), ['speaker'])

    // 2. Malformed records return false without throwing TypeError
    assert.equal(
      await authority.verifyAndApplyRevocation({
        v: 1,
        ...scope,
        issuerUserId: root.userId,
        targetUserId: target.userId,
        seq: 1,
        ts: 100,
        signerPubKey: {} as never,
        sig: 'AAAA'
      }),
      false
    )
    assert.equal(
      await authority.verifyAndApplyModeration({
        v: 1,
        op: 'ban',
        ...scope,
        issuerUserId: root.userId,
        targetUserId: target.userId,
        seq: 1,
        ts: 100,
        signerPubKey: {} as never,
        sig: 'AAAA'
      }),
      false
    )
    assert.equal(
      await stateManager.verifyAndApplyStateRecord({
        v: 1,
        k: 's',
        ...scope,
        ns: 'cfg',
        hlc: 100,
        peerId: moderator.peerId,
        userId: moderator.userId,
        pub: 'bad',
        cert: {} as never,
        val: {step: 1},
        sig: 'AAAA'
      }),
      false
    )
    assert.equal(
      (
        await verifyRoleCertificate(
          {
            ...speakerCert,
            roles: []
          },
          scope.appId,
          scope.roomId,
          new Set([root.userId])
        )
      ).valid,
      false
    )

    // 3. verifyAndApplyCert returns false for stale certs (iat < existing.iat) to prevent sync re-broadcast storms
    const newerCert = await signRoleCertInternal(
      root.sign,
      root.signPubJwk,
      moderator.userId,
      scope.appId,
      scope.roomId,
      ['moderator'],
      Date.now() + 5_000
    )
    const olderCert = await signRoleCertInternal(
      root.sign,
      root.signPubJwk,
      moderator.userId,
      scope.appId,
      scope.roomId,
      ['helper'],
      Date.now() - 5_000
    )
    assert.equal(await authority.verifyAndApplyCert(newerCert), true)
    assert.equal(
      await authority.verifyAndApplyCert(olderCert),
      false,
      'stale certificate must return false from verifyAndApplyCert'
    )

    // 4. State records: reject Infinity hlc, enforce hlc >= cert.iat, and reject tampered values
    const stateRec1 = await signStateRecord(
      moderator.sign,
      moderator.signPubJwk,
      {
        ...scope,
        ns: 'cfg',
        hlc: newerCert.iat + 10,
        peerId: moderator.peerId,
        userId: moderator.userId,
        val: {step: 1},
        cert: newerCert
      }
    )
    assert(!stateRec1.del)
    const infStateRec = {
      ...stateRec1,
      hlc: Number.POSITIVE_INFINITY
    }
    assert.equal(
      await stateManager.verifyAndApplyStateRecord(infStateRec),
      false,
      'state record with hlc: Infinity must be rejected'
    )
    assert.equal(await stateManager.verifyAndApplyStateRecord(stateRec1), true)

    const preCertRec = await signStateRecord(
      moderator.sign,
      moderator.signPubJwk,
      {
        ...scope,
        ns: 'cfg',
        hlc: newerCert.iat - 1,
        peerId: moderator.peerId,
        userId: moderator.userId,
        val: {step: 2},
        cert: newerCert
      }
    )
    assert.equal(
      await stateManager.verifyAndApplyStateRecord(preCertRec),
      false,
      'state record backdated before cert.iat must be rejected'
    )
    assert.equal(
      await stateManager.verifyAndApplyStateRecord({
        ...stateRec1,
        hlc: stateRec1.hlc + 1,
        val: {step: 2}
      }),
      false,
      'tampered state record payload must be rejected'
    )

    // 5. Co-root admin cannot ban or revoke another root admin even on a fresh peer
    const freshAuthority = createRoomAuthority({
      selfId: testPeerId('mod-fresh'),
      appId: scope.appId,
      initialRoomId: scope.roomId,
      admin: {admins: [root.userId, coRoot.userId]},
      isOverlayPeerBanned: () => false,
      getKnownPeerUserId: pid => (pid === root.peerId ? root.userId : undefined)
    })
    await freshAuthority.getAuthorityInfo()

    const banAgainstRoot = await signModeration(coRoot, {
      op: 'ban',
      ...scope,
      targetUserId: root.userId,
      seq: 10
    })
    assert.equal(
      await freshAuthority.verifyAndApplyModeration(banAgainstRoot),
      false,
      'co-root admin must not be able to ban another root admin'
    )
    assert.equal(freshAuthority.isPeerBanned(root.peerId), false)
    assert.equal(freshAuthority.isPeerBanned(root.userId), false)

    // 6. Multi-device root admin tab can issue ban and unban using their shared UserIdentity
    const multiTabBan = await signModeration(coRoot, {
      op: 'ban',
      ...scope,
      targetUserId: target.userId,
      reason: 'multi-tab-ban',
      seq: 1,
      ts: Date.now()
    })
    assert.equal(await authority.verifyAndApplyModeration(multiTabBan), true)
    assert.equal(authority.isPeerBanned(target.peerId), true)
    assert.equal(authority.getBanReason(target.peerId), 'multi-tab-ban')

    const multiTabUnban = await signModeration(root, {
      op: 'unban',
      ...scope,
      targetUserId: target.userId,
      seq: 2,
      ts: multiTabBan.ts + 50
    })
    assert.equal(await authority.verifyAndApplyModeration(multiTabUnban), true)
    assert.equal(authority.isPeerBanned(target.peerId), false)
    assert.equal(authority.getBanReason(target.peerId), undefined)

    // 7. Schema validators per record type & resilience on verifyAndApply*
    assert.equal(validateRoleCertificateShape(newerCert), true)
    assert.equal(
      validateRoleCertificateShape({...newerCert, roles: [123]}),
      false
    )
    assert.equal(validateRoleCertificateShape({...newerCert, iat: -1}), false)
    assert.equal(validatePeerModerationShape(multiTabBan), true)
    assert.equal(validatePeerModerationShape(multiTabUnban), true)
    assert.equal(
      validatePeerModerationShape({...multiTabBan, op: 'kick' as never}),
      false
    )
    assert.equal(
      validateRoleRevocationShape({
        ...multiTabBan,
        role: 123
      }),
      false
    )
    assert.equal(
      await authority.verifyAndApplyCert({
        ...newerCert,
        roles: [] as never
      }),
      false
    )
    assert.equal(
      await authority.verifyAndApplyModeration({
        ...multiTabBan,
        signerPubKey: {corrupted: true} as never
      }),
      false
    )
    assert.equal(
      await stateManager.verifyAndApplyStateRecord({
        ...stateRec1,
        cert: {corrupted: true} as never
      }),
      false
    )
  } finally {
    stateManager.destroy()
  }
})

void test('H8: full room.ban() -> purge/repull -> room.unban() -> clean rejoin lifecycle', async () => {
  const {makeJoinRoom, rtcPolyfill} = createMemorySignalBus()
  const [adminUser, goodUser, troubleUser] = await Promise.all([
    createUserIdentity(),
    createUserIdentity(),
    createUserIdentity()
  ])

  const adminRoom = makeJoinRoom('h8-admin')(
    {
      appId: 'h8-lifecycle-app',
      rtcPolyfill,
      identity: adminUser,
      use: [roles({selfAsAdmin: true}), scale()]
    },
    'h8-lobby'
  )
  const adminSelf = await adminRoom.getSelf()
  const effectiveRoomId = adminSelf.roomId

  const goodRoom = makeJoinRoom('h8-good')(
    {
      appId: 'h8-lifecycle-app',
      rtcPolyfill,
      identity: goodUser,
      use: [roles(), scale()]
    },
    effectiveRoomId
  )
  const troubleRoom1 = makeJoinRoom('h8-trouble-1')(
    {
      appId: 'h8-lifecycle-app',
      rtcPolyfill,
      identity: troubleUser,
      use: [roles(), scale()]
    },
    effectiveRoomId
  )

  const troubleErrors: RoomError[] = []
  troubleRoom1.onError(err => troubleErrors.push(err))

  let troubleBlockedRoom: typeof goodRoom | null = null
  let troubleRejoinRoom: typeof goodRoom | null = null

  try {
    await waitFor(
      () =>
        Object.keys(adminRoom.getUsers()).length === 2 &&
        Object.keys(goodRoom.getUsers()).length === 2 &&
        Object.keys(troubleRoom1.getUsers()).length === 2
    )

    // Root admin grants 'editor' to goodUser and troubleUser; non-root goodRoom cannot moderate
    await adminRoom.grantRole(goodUser.userId, 'editor')
    await adminRoom.grantRole(troubleUser.userId, 'editor')
    await waitFor(
      () =>
        goodRoom.getRoles(goodUser.userId).includes('editor') &&
        troubleRoom1.getRoles(troubleUser.userId).includes('editor') &&
        goodRoom.getRoles(troubleUser.userId).includes('editor')
    )

    await assert.rejects(
      () => goodRoom.grantRole(troubleUser.userId, 'moderator'),
      /insufficient authority/i
    )
    await assert.rejects(
      () => goodRoom.revokeRole(troubleUser.userId, 'editor'),
      /insufficient authority/i
    )
    await assert.rejects(
      () => goodRoom.ban(troubleUser.userId),
      /insufficient authority/i
    )
    await assert.rejects(
      () => goodRoom.unban(troubleUser.userId),
      /insufficient authority/i
    )

    // Register shared & user state slots across all 3 peers
    const adminBio = adminRoom.makeUserState('bio', '')
    const goodBio = goodRoom.makeUserState('bio', '')
    const troubleBio1 = troubleRoom1.makeUserState('bio', '')

    const adminSolo = adminRoom.makeState('solo-shared', 'default-solo', {
      roles: ['admin', 'editor']
    })
    const goodSolo = goodRoom.makeState('solo-shared', 'default-solo', {
      roles: ['admin', 'editor']
    })
    const troubleSolo1 = troubleRoom1.makeState('solo-shared', 'default-solo', {
      roles: ['admin', 'editor']
    })

    // goodRoom validates repull-shared to reject 'vandal:*', preserving 'clean-by-good' for repull recovery!
    const adminRepull = adminRoom.makeState('repull-shared', 'default-repull', {
      roles: ['admin', 'editor']
    })
    const goodRepull = goodRoom.makeState('repull-shared', 'default-repull', {
      roles: ['admin', 'editor'],
      validate: next => !next.startsWith('vandal:')
    })
    const troubleRepull1 = troubleRoom1.makeState(
      'repull-shared',
      'default-repull',
      {
        roles: ['admin', 'editor']
      }
    )

    await goodBio.set('GoodBio')
    await troubleBio1.set('SpamBio')
    await goodRepull.set('clean-by-good')
    await waitFor(
      () =>
        adminRepull.get() === 'clean-by-good' &&
        troubleRepull1.get() === 'clean-by-good'
    )

    await wait(5)
    await troubleSolo1.set('trouble-solo-doc')
    await troubleRepull1.set('vandal:defaced')
    await waitFor(
      () =>
        adminBio.get(troubleUser.userId) === 'SpamBio' &&
        goodBio.get(troubleUser.userId) === 'SpamBio' &&
        adminSolo.get() === 'trouble-solo-doc' &&
        goodSolo.get() === 'trouble-solo-doc' &&
        adminRepull.get() === 'vandal:defaced'
    )
    assert.equal(goodRepull.get(), 'clean-by-good')

    // Step 1: Root admin bans troubleUser -> evicted, roles cleared, makeUserState & makeState purged + repull recovers 'clean-by-good'!
    await adminRoom.ban(troubleUser.userId, {reason: 'vandalism'})
    assert.equal(adminRoom.isBanned(troubleUser.userId), true)

    await waitFor(
      () =>
        goodRoom.isBanned(troubleUser.userId) === true &&
        !(troubleUser.userId in adminRoom.getUsers()) &&
        !(troubleUser.userId in goodRoom.getUsers()) &&
        troubleErrors.some(e => e.code === 'banned') &&
        adminSolo.get() === 'default-solo' &&
        goodSolo.get() === 'default-solo' &&
        adminRepull.get() === 'clean-by-good'
    )
    assert.deepEqual(adminRoom.getRoles(troubleUser.userId), [])
    assert.deepEqual(goodRoom.getRoles(troubleUser.userId), [])
    assert.equal(adminBio.has(troubleUser.userId), false)
    assert.equal(goodBio.has(troubleUser.userId), false)
    assert.equal(adminBio.get(goodUser.userId), 'GoodBio')

    await troubleRoom1.leave()

    // Step 2: Rejoining while still banned is blocked
    const blockedErrors: RoomError[] = []
    troubleBlockedRoom = makeJoinRoom('h8-trouble-blocked')(
      {
        appId: 'h8-lifecycle-app',
        rtcPolyfill,
        identity: troubleUser,
        use: [roles(), scale()]
      },
      effectiveRoomId
    )
    troubleBlockedRoom.onError(err => blockedErrors.push(err))
    await waitFor(() => blockedErrors.some(e => e.code === 'banned'), 3_000)
    assert.equal(troubleUser.userId in adminRoom.getUsers(), false)
    await troubleBlockedRoom.leave()
    troubleBlockedRoom = null

    // Step 3: Root admin calls room.unban(troubleUser.userId) -> isBanned flips to false across peers
    await adminRoom.unban(troubleUser.userId)
    assert.equal(adminRoom.isBanned(troubleUser.userId), false)
    await waitFor(() => goodRoom.isBanned(troubleUser.userId) === false)

    // Step 4: Unbanned user rejoins cleanly, pre-ban role remains cleared until re-granted, and state/userState work cleanly
    const rejoinErrors: RoomError[] = []
    troubleRejoinRoom = makeJoinRoom('h8-trouble-rejoin')(
      {
        appId: 'h8-lifecycle-app',
        rtcPolyfill,
        identity: troubleUser,
        use: [roles(), scale()]
      },
      effectiveRoomId
    )
    troubleRejoinRoom.onError(err => rejoinErrors.push(err))
    const troubleBio2 = troubleRejoinRoom.makeUserState('bio', '')
    const troubleSolo2 = troubleRejoinRoom.makeState(
      'solo-shared',
      'default-solo',
      {
        roles: ['admin', 'editor']
      }
    )
    const troubleRepull2 = troubleRejoinRoom.makeState(
      'repull-shared',
      'default-repull',
      {
        roles: ['admin', 'editor']
      }
    )

    await waitFor(
      () =>
        troubleUser.userId in adminRoom.getUsers() &&
        troubleUser.userId in goodRoom.getUsers() &&
        Object.keys(troubleRejoinRoom!.getUsers()).length === 2 &&
        troubleRepull2.get() === 'clean-by-good' &&
        troubleBio2.get(goodUser.userId) === 'GoodBio',
      3_000
    )
    assert.equal(rejoinErrors.length, 0)
    assert.deepEqual(adminRoom.getRoles(troubleUser.userId), [])
    assert.deepEqual(troubleRejoinRoom.getRoles(troubleUser.userId), [])

    await troubleBio2.set('ReformedBio')
    await waitFor(
      () =>
        adminBio.get(troubleUser.userId) === 'ReformedBio' &&
        goodBio.get(troubleUser.userId) === 'ReformedBio'
    )

    // Pre-ban 'editor' role is still cleared -> role-gated makeState rejects until admin re-grants 'editor'
    await assert.rejects(
      () => troubleSolo2.set('unauthorized-before-regrant'),
      /insufficient authority|missing local role certificate/i
    )
    await adminRoom.grantRole(troubleUser.userId, 'editor')
    await waitFor(() =>
      troubleRejoinRoom!.getRoles(troubleUser.userId).includes('editor')
    )
    await troubleSolo2.set('restored-contribution')
    await waitFor(
      () =>
        adminSolo.get() === 'restored-contribution' &&
        goodSolo.get() === 'restored-contribution'
    )
  } finally {
    await Promise.all([
      adminRoom.leave(),
      goodRoom.leave(),
      troubleRoom1.leave(),
      troubleBlockedRoom?.leave(),
      troubleRejoinRoom?.leave()
    ])
  }
})
