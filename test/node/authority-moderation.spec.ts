import assert from 'node:assert/strict'
import test from './test.ts'
import {
  banCanonicalPayload,
  createRoomAuthority,
  revocationCanonicalPayload,
  signActionAuth,
  signPeerBan,
  signRoleCertificate,
  signRoleRevocation,
  signStateRecord,
  verifyActionAuth,
  verifyPeerBan,
  verifyRoleCertificateChain,
  verifyRoleRevocation,
  verifyStateRecord,
  validateActionAuthShape,
  validatePeerBanShape,
  validateRoleCertificateShape,
  validateRoleRevocationShape,
  validateStateRecordShape
} from '../../packages/core/src/authority.ts'
import {createActionManager} from '../../packages/core/src/actions.ts'
import {createUserIdentity} from '../../packages/core/src/identity.ts'
import {createStateManager} from '../../packages/core/src/state.ts'
import {wait, waitFor} from './peer-harness.ts'

const setup = async () => {
  const [root, delegate, target] = await Promise.all([
    createUserIdentity(),
    createUserIdentity(),
    createUserIdentity()
  ])
  const scope = {appId: 'moderation-test', roomId: 'room'}
  const peerUsers: Record<string, string> = {
    'peer-owner': root.userId,
    'peer-delegate': delegate.userId,
    'peer-target': target.userId
  }
  const authority = createRoomAuthority({
    selfId: 'peer-owner',
    appId: scope.appId,
    initialRoomId: scope.roomId,
    admin: {admins: [root.userId]},
    getLocalUserIdentity: async () => root,
    isOverlayPeerBanned: () => false,
    getPeerUserId: pid => peerUsers[pid],
    onRoomIdResolved: () => {},
    onPeerPublicKey: () => {},
    onLocalRoleCertificate: () => {},
    onPeerBanned: () => {},
    onSignatureFailure: () => {}
  })
  await authority.getAuthorityInfo()
  const stateManager = createStateManager({
    appId: scope.appId,
    getRoomId: () => authority.getEffectiveRoomId(),
    getSelfId: () => 'peer-owner',
    getLocalUserId: () => root.userId,
    ensureReady: async () => ({
      selfId: 'peer-owner',
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
  stateManager.makeState('cfg', {})
  stateManager.makeState('clock-test', '')
  const grant = async (identity: typeof delegate, roles: string[]) => {
    const cert = await signRoleCertificate(root.sign, root.signPubJwk, {
      ...scope,
      subUserId: identity.userId,
      roles
    })
    await authority.verifyAndApplyCert(cert)
    return cert
  }
  return {
    authority,
    stateManager,
    root,
    delegate: {...delegate, peerId: 'peer-delegate'},
    target: {...target, peerId: 'peer-target'},
    scope,
    grant
  }
}

void test('revoked admins cannot issue new bans or revocations', async () => {
  const {authority, delegate, target, scope, grant} = await setup()
  const cert = await grant(delegate, ['admin'])
  await grant(target, ['player'])
  await authority.issueRoleRevocation(delegate.peerId, 'admin')
  assert.deepEqual(authority.getPeerRoles(delegate.peerId), [])

  const ban = await signPeerBan(delegate.sign, delegate.signPubJwk, cert, {
    ...scope,
    issuerUserId: delegate.userId,
    targetUserId: target.userId,
    seq: 1
  })
  assert.equal(await authority.verifyAndApplyBan(ban), false)
  assert.equal(authority.isPeerBanned(target.peerId), false)

  const revocation = await signRoleRevocation(
    delegate.sign,
    delegate.signPubJwk,
    cert,
    {
      ...scope,
      issuerUserId: delegate.userId,
      targetUserId: target.userId,
      seq: 2
    }
  )
  assert.equal(await authority.verifyAndApplyRevocation(revocation), false)
  assert.deepEqual(authority.getPeerRoles(target.peerId), ['player'])
})

void test('non-admin roles cannot issue revocations or bans', async () => {
  const {authority, delegate, target, scope, grant} = await setup()
  const cert = await grant(delegate, ['viewer'])
  await grant(target, ['admin', 'viewer'])

  for (const role of ['admin', 'viewer', '*', undefined]) {
    const revocation = await signRoleRevocation(
      delegate.sign,
      delegate.signPubJwk,
      cert,
      {
        ...scope,
        issuerUserId: delegate.userId,
        targetUserId: target.userId,
        seq: 1,
        ...(role === undefined ? {} : {role})
      }
    )
    assert.equal(await authority.verifyAndApplyRevocation(revocation), false)
  }

  const ban = await signPeerBan(delegate.sign, delegate.signPubJwk, cert, {
    ...scope,
    issuerUserId: delegate.userId,
    targetUserId: target.userId,
    seq: 2
  })
  assert.equal(await authority.verifyAndApplyBan(ban), false)
  assert.deepEqual(authority.getPeerRoles(target.peerId), ['admin', 'viewer'])
})

void test('delegated admins cannot issue role certificates (2-tier authority model)', async () => {
  const {authority, delegate, target, scope, grant} = await setup()
  await grant(delegate, ['admin'])
  const forgedCert = await signRoleCertificate(
    delegate.sign,
    delegate.signPubJwk,
    {
      ...scope,
      subUserId: target.userId,
      roles: ['admin']
    }
  )
  assert.equal(await authority.verifyAndApplyCert(forgedCert), false)
  assert.deepEqual(authority.getPeerRoles(target.peerId), [])
})

void test('C3 regression: RoleRevocationRecord cannot be re-wrapped as a PeerBanRecord (and vice versa)', async () => {
  const {authority, root, delegate, target, scope, grant} = await setup()
  const adminCert = await grant(delegate, ['admin'])
  const modCert = await grant(target, ['moderator'])
  assert.deepEqual(authority.getPeerRoles(target.peerId), ['moderator'])

  const revocation = await signRoleRevocation(
    delegate.sign,
    delegate.signPubJwk,
    adminCert,
    {
      ...scope,
      issuerUserId: delegate.userId,
      targetUserId: target.userId,
      targetCertId: modCert.certId,
      role: 'moderator',
      seq: 1
    }
  )

  const forgedBanFromRevocation = {
    v: revocation.v,
    appId: revocation.appId,
    roomId: revocation.roomId,
    issuerUserId: revocation.issuerUserId,
    targetUserId: revocation.targetUserId,
    ...(revocation.role ? {reason: revocation.role} : {}),
    seq: revocation.seq,
    ts: revocation.ts,
    issuerCert: revocation.issuerCert,
    signerPubKey: revocation.signerPubKey,
    sig: revocation.sig
  }

  assert.notEqual(
    revocationCanonicalPayload(revocation),
    banCanonicalPayload(forgedBanFromRevocation),
    'revocation and ban canonical payloads must be domain-separated'
  )

  assert.equal(
    await verifyPeerBan(
      forgedBanFromRevocation,
      scope.appId,
      scope.roomId,
      new Set([root.userId])
    ),
    false,
    'verifyPeerBan must reject a re-wrapped RoleRevocationRecord'
  )
  assert.equal(
    await authority.verifyAndApplyBan(forgedBanFromRevocation),
    false,
    'verifyAndApplyBan must reject a re-wrapped RoleRevocationRecord'
  )
  assert.equal(authority.isPeerBanned(target.peerId), false)
  assert.equal(authority.isPeerBanned(target.userId), false)

  // Also verify that a valid PeerBanRecord cannot be re-wrapped as a RoleRevocationRecord
  const validBan = await signPeerBan(
    delegate.sign,
    delegate.signPubJwk,
    adminCert,
    {
      ...scope,
      issuerUserId: delegate.userId,
      targetUserId: target.userId,
      reason: 'moderator',
      seq: 2
    }
  )
  const forgedRevocationFromBan = {
    v: validBan.v,
    appId: validBan.appId,
    roomId: validBan.roomId,
    issuerUserId: validBan.issuerUserId,
    targetUserId: validBan.targetUserId,
    ...(validBan.reason ? {role: validBan.reason} : {}),
    seq: validBan.seq,
    ts: validBan.ts,
    issuerCert: validBan.issuerCert,
    signerPubKey: validBan.signerPubKey,
    sig: validBan.sig
  }
  assert.equal(
    await verifyRoleRevocation(
      forgedRevocationFromBan,
      scope.appId,
      scope.roomId,
      new Set([root.userId])
    ),
    false,
    'verifyRoleRevocation must reject a re-wrapped PeerBanRecord'
  )
  assert.equal(
    await authority.verifyAndApplyRevocation(forgedRevocationFromBan),
    false,
    'verifyAndApplyRevocation must reject a re-wrapped PeerBanRecord'
  )
  assert.deepEqual(authority.getPeerRoles(target.peerId), ['moderator'])
})

void test('offer-time role spoofing via matching certId, malformed records, stale cert deduplication, state Infinity/prevHash/hash, and multi-device admin ban', async () => {
  const {authority, stateManager, root, delegate, target, scope, grant} =
    await setup()

  // 1. Offer-time role spoofing: peer with stored 'speaker' cert sends offer with tampered wire cert (same certId, forged roles: ['admin'])
  const speakerCert = await grant(target, ['speaker'])
  assert.deepEqual(authority.getPeerRoles(target.peerId), ['speaker'])

  const validEnv = await signActionAuth(
    target.sign,
    target.signPubJwk,
    speakerCert,
    {
      ...scope,
      namespace: 'admin-cmd',
      peerId: target.peerId,
      userId: target.userId,
      seq: 1,
      data: new Uint8Array([1, 2, 3])
    }
  )
  const spoofedWireMeta = {
    __trysteroAuth: {
      ...validEnv,
      cert: {
        ...speakerCert,
        roles: ['admin']
      }
    }
  }
  const offerRes = await authority.verifyActionOffer(
    'admin-cmd',
    target.peerId,
    ['admin'],
    spoofedWireMeta as any
  )
  assert.equal(
    offerRes.valid,
    false,
    'verifyActionOffer must reject wire cert that spoofs roles while reusing stored certId'
  )
  assert.deepEqual(offerRes.roles, [])

  // 2. Malformed records return false without throwing TypeError
  assert.equal(
    await verifyRoleRevocation(
      {
        v: 1,
        ...scope,
        issuerUserId: delegate.userId,
        targetUserId: target.userId,
        seq: 1,
        ts: 100,
        issuerCert: {} as any,
        signerPubKey: {} as any,
        sig: 'AAAA'
      },
      scope.appId,
      scope.roomId,
      new Set([root.userId])
    ),
    false
  )
  assert.equal(
    await verifyPeerBan(
      {
        v: 1,
        ...scope,
        issuerUserId: delegate.userId,
        targetUserId: target.userId,
        seq: 1,
        ts: 100,
        issuerCert: {} as any,
        signerPubKey: {} as any,
        sig: 'AAAA'
      },
      scope.appId,
      scope.roomId,
      new Set([root.userId])
    ),
    false
  )
  assert.equal(
    (
      await verifyActionAuth(
        {
          v: 1,
          seq: 1,
          digest: '00',
          cert: {} as any,
          sig: 'AAAA'
        } as any,
        {
          ...scope,
          namespace: 'x',
          peerId: target.peerId,
          data: 'hi',
          requiredRoles: ['admin'],
          rootUserIds: new Set([root.userId])
        }
      )
    ).valid,
    false
  )
  assert.equal(
    await verifyStateRecord(
      {
        v: 1,
        k: 's',
        ...scope,
        ns: 's',
        hlc: 100,
        peerId: delegate.peerId,
        userId: delegate.userId,
        pub: 'bad',
        cert: {} as any,
        val: 1,
        sig: 'AAAA'
      },
      scope.appId,
      scope.roomId,
      ['admin'],
      new Set([root.userId])
    ),
    false
  )
  assert.equal(
    (
      await verifyRoleCertificateChain(
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
  const newerCert = await signRoleCertificate(root.sign, root.signPubJwk, {
    ...scope,
    subUserId: delegate.userId,
    roles: ['admin'],
    now: Date.now() + 5_000
  })
  const olderCert = await signRoleCertificate(root.sign, root.signPubJwk, {
    ...scope,
    subUserId: delegate.userId,
    roles: ['moderator'],
    now: Date.now() - 5_000
  })
  assert.equal(await authority.verifyAndApplyCert(newerCert), true)
  assert.equal(
    await authority.verifyAndApplyCert(olderCert),
    false,
    'stale certificate must return false from verifyAndApplyCert'
  )

  // 4. State records: reject Infinity hlc, enforce hlc >= cert.iat, and reject tampered values
  const stateRec1 = await signStateRecord(delegate.sign, delegate.signPubJwk, {
    ...scope,
    ns: 'cfg',
    hlc: newerCert.iat + 10,
    peerId: delegate.peerId,
    userId: delegate.userId,
    val: {step: 1},
    cert: newerCert
  })
  const infStateRec = await signStateRecord(
    delegate.sign,
    delegate.signPubJwk,
    {
      ...scope,
      ns: 'cfg',
      hlc: Number.POSITIVE_INFINITY,
      peerId: delegate.peerId,
      userId: delegate.userId,
      val: {step: 999},
      cert: newerCert
    }
  )
  assert.equal(
    await verifyStateRecord(
      infStateRec,
      scope.appId,
      scope.roomId,
      ['admin'],
      new Set([root.userId])
    ),
    false,
    'state record with hlc: Infinity must be rejected'
  )
  assert.equal(await stateManager.verifyAndApplyStateRecord(stateRec1), true)

  const preCertRec = await signStateRecord(delegate.sign, delegate.signPubJwk, {
    ...scope,
    ns: 'cfg',
    hlc: newerCert.iat - 1,
    peerId: delegate.peerId,
    userId: delegate.userId,
    val: {step: 2},
    cert: newerCert
  })
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

  // 5. Delegated admin cannot ban or revoke root admin even on a peer that has not yet seen the root cert
  const freshAuthority = createRoomAuthority({
    selfId: 'peer-fresh',
    appId: scope.appId,
    initialRoomId: scope.roomId,
    admin: {admins: [root.userId]},
    isOverlayPeerBanned: () => false,
    getPeerUserId: pid => (pid === 'peer-owner' ? root.userId : undefined),
    onRoomIdResolved: () => {},
    onPeerPublicKey: () => {},
    onLocalRoleCertificate: () => {},
    onPeerBanned: () => {},
    onSignatureFailure: () => {}
  })
  await freshAuthority.getAuthorityInfo()

  const banAgainstRoot = await signPeerBan(
    delegate.sign,
    delegate.signPubJwk,
    newerCert,
    {
      ...scope,
      issuerUserId: delegate.userId,
      targetUserId: root.userId,
      seq: 10
    }
  )
  assert.equal(
    await freshAuthority.verifyAndApplyBan(banAgainstRoot),
    false,
    'delegated admin must not be able to ban root admin even before root cert is received'
  )
  assert.equal(freshAuthority.isPeerBanned('peer-owner'), false)
  assert.equal(freshAuthority.isPeerBanned(root.userId), false)

  // 6. Multi-device delegated admin can issue revocations and bans from any tab using their UserIdentity
  const adminUser2 = await createUserIdentity()
  const tab1Cert = await signRoleCertificate(root.sign, root.signPubJwk, {
    ...scope,
    subUserId: adminUser2.userId,
    roles: ['admin']
  })
  await authority.verifyAndApplyCert(tab1Cert)
  const multiTabBan = await signPeerBan(
    adminUser2.sign,
    adminUser2.signPubJwk,
    tab1Cert,
    {
      ...scope,
      issuerUserId: adminUser2.userId,
      targetUserId: target.userId,
      seq: 1
    }
  )
  assert.equal(
    await authority.verifyAndApplyBan(multiTabBan),
    true,
    'multi-device admin tab must be able to issue a valid ban using user identity'
  )
  assert.equal(authority.isPeerBanned(target.peerId), true)

  // 7. Schema validators per record type & try/catch resilience on verifyAndApply*
  assert.equal(validateRoleCertificateShape(tab1Cert), true)
  assert.equal(validateRoleCertificateShape({...tab1Cert, roles: [123]}), false)
  assert.equal(validateRoleCertificateShape({...tab1Cert, iat: -1}), false)
  assert.equal(validatePeerBanShape(multiTabBan), true)
  assert.equal(
    validatePeerBanShape({...multiTabBan, issuerCert: {} as never}),
    false
  )
  assert.equal(
    validateRoleRevocationShape({
      ...multiTabBan,
      targetCertId: ''
    }),
    false
  )
  assert.equal(validateActionAuthShape(null), false)
  assert.equal(
    validateStateRecordShape({
      ...stateRec1,
      hlc: Number.POSITIVE_INFINITY
    }),
    false
  )
  assert.equal(
    await authority.verifyAndApplyCert({
      ...tab1Cert,
      roles: [] as never
    }),
    false
  )
  assert.equal(
    await authority.verifyAndApplyBan({
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
})

void test('clock skew hardening and 2-tier authority enforcement: reject future-dated records, floor re-granted cert iat above skewed revocations, and reject non-root cert issuance', async () => {
  const {authority, stateManager, root, delegate, target, scope, grant} =
    await setup()
  const adminCert = await grant(delegate, ['admin'])
  await grant(target, ['player'])
  authority.registerPeerPublicKey(target.peerId, target.signPubJwk)

  // 1. Poison-pill future timestamps (> Date.now() + 60_000) on revocations, bans, and state records are rejected
  const poisonRevocation = await signRoleRevocation(
    delegate.sign,
    delegate.signPubJwk,
    adminCert,
    {
      ...scope,
      issuerUserId: delegate.userId,
      targetUserId: target.userId,
      role: 'player',
      seq: 1,
      ts: Number.MAX_SAFE_INTEGER
    }
  )
  assert.equal(
    await verifyRoleRevocation(
      poisonRevocation,
      scope.appId,
      scope.roomId,
      new Set([root.userId])
    ),
    false,
    'future-dated revocation must be rejected by verifyRoleRevocation'
  )
  assert.equal(
    await authority.verifyAndApplyRevocation(poisonRevocation),
    false
  )
  assert.deepEqual(authority.getPeerRoles(target.peerId), ['player'])

  const futureBan = await signPeerBan(
    delegate.sign,
    delegate.signPubJwk,
    adminCert,
    {
      ...scope,
      issuerUserId: delegate.userId,
      targetUserId: target.userId,
      seq: 2,
      ts: Date.now() + 120_000
    }
  )
  assert.equal(await authority.verifyAndApplyBan(futureBan), false)
  assert.equal(authority.isPeerBanned(target.peerId), false)

  const futureState = await signStateRecord(
    delegate.sign,
    delegate.signPubJwk,
    {
      ...scope,
      ns: 'clock-test',
      hlc: Date.now() + 120_000,
      peerId: delegate.peerId,
      userId: delegate.userId,
      val: 'future',
      cert: adminCert
    }
  )
  assert.equal(await stateManager.verifyAndApplyStateRecord(futureState), false)

  // 2. Re-granting a role via issueRoleCertificate floors iat above a revocation from a slightly fast clock
  const skewedRevocation = await signRoleRevocation(
    delegate.sign,
    delegate.signPubJwk,
    adminCert,
    {
      ...scope,
      issuerUserId: delegate.userId,
      targetUserId: target.userId,
      role: 'player',
      seq: 3,
      ts: Date.now() + 30_000
    }
  )
  assert.equal(await authority.verifyAndApplyRevocation(skewedRevocation), true)
  assert.deepEqual(authority.getPeerRoles(target.peerId), [])

  const regrantedCert = await authority.issueRoleCertificate(
    target.peerId,
    'player'
  )
  assert.ok(
    regrantedCert.iat > skewedRevocation.ts,
    're-granted cert iat must supersede skewed revocation ts'
  )
  assert.deepEqual(authority.getPeerRoles(target.peerId), ['player'])

  // 3. 2-tier authority: only root admins can issue role certificates
  const subMod = await createUserIdentity()
  const nonRootCert = await signRoleCertificate(
    delegate.sign,
    delegate.signPubJwk,
    {
      ...scope,
      subUserId: subMod.userId,
      roles: ['moderator']
    }
  )
  assert.equal(validateRoleCertificateShape(nonRootCert), true)
  assert.equal(
    (
      await verifyRoleCertificateChain(
        nonRootCert,
        scope.appId,
        scope.roomId,
        new Set([root.userId])
      )
    ).valid,
    false,
    'verifyRoleCertificateChain must reject certificates signed by non-root issuers'
  )
  assert.equal(await authority.verifyAndApplyCert(nonRootCert), false)
})

void test('Role-gated actions accept out-of-order seq arrivals across concurrent multi-chunk and inline transfers while rejecting replays', async () => {
  const [root, receiverId] = await Promise.all([
    createUserIdentity(),
    createUserIdentity()
  ])
  const appId = 'action-replay-window-test'
  const roomId = 'room-ooo'
  const senderPeerId = 'peer-sender'
  const receiverPeerId = 'peer-receiver'

  let sigFailures = 0
  const senderAuth = createRoomAuthority({
    selfId: senderPeerId,
    appId,
    initialRoomId: roomId,
    admin: {admins: [root.userId]},
    getLocalUserIdentity: async () => root,
    isOverlayPeerBanned: () => false,
    getPeerUserId: pid =>
      pid === senderPeerId
        ? root.userId
        : pid === receiverPeerId
          ? receiverId.userId
          : undefined
  })
  const receiverAuth = createRoomAuthority({
    selfId: receiverPeerId,
    appId,
    initialRoomId: roomId,
    admin: {admins: [root.userId]},
    getLocalUserIdentity: async () => receiverId,
    isOverlayPeerBanned: () => false,
    getPeerUserId: pid =>
      pid === senderPeerId
        ? root.userId
        : pid === receiverPeerId
          ? receiverId.userId
          : undefined,
    onSignatureFailure: () => {
      sigFailures++
    }
  })
  await Promise.all([
    senderAuth.getAuthorityInfo(),
    receiverAuth.getAuthorityInfo()
  ])

  // 1. Direct verifyActionOffer + out-of-order verifyActionPayload + replay rejection
  const largeBuf = new Uint8Array(64 * 1024)
  for (let i = 0; i < largeBuf.length; i++) {
    largeBuf[i] = i & 0xff
  }
  const meta1 = await senderAuth.signActionPayload('cmd', ['admin'], largeBuf, {
    tag: 1
  })
  const meta2 = await senderAuth.signActionPayload(
    'cmd',
    ['admin'],
    'inline-2',
    {tag: 2}
  )
  const meta3 = await senderAuth.signActionPayload(
    'cmd',
    ['admin'],
    'inline-3',
    {tag: 3}
  )
  const meta4 = await senderAuth.signActionPayload(
    'cmd',
    ['admin'],
    'inline-4',
    {tag: 4}
  )

  // Offer for seq=1 arrives first; inline payloads seq=4, seq=2, seq=3 arrive before seq=1 finishes reassembly
  assert.equal(
    (
      await receiverAuth.verifyActionOffer(
        'cmd',
        senderPeerId,
        ['admin'],
        meta1 ?? undefined
      )
    ).valid,
    true
  )
  assert.equal(
    (
      await receiverAuth.verifyActionPayload(
        'cmd',
        senderPeerId,
        ['admin'],
        'inline-4',
        meta4 ?? undefined
      )
    ).valid,
    true
  )
  assert.equal(
    (
      await receiverAuth.verifyActionPayload(
        'cmd',
        senderPeerId,
        ['admin'],
        'inline-2',
        meta2 ?? undefined
      )
    ).valid,
    true
  )
  assert.equal(
    (
      await receiverAuth.verifyActionPayload(
        'cmd',
        senderPeerId,
        ['admin'],
        'inline-3',
        meta3 ?? undefined
      )
    ).valid,
    true
  )
  // Now seq=1 finishes reassembly and verifies cleanly despite higher seqs already committed
  const res1 = await receiverAuth.verifyActionPayload(
    'cmd',
    senderPeerId,
    ['admin'],
    largeBuf,
    meta1 ?? undefined
  )
  assert.equal(res1.valid, true)
  assert.deepEqual(res1.userMetadata, {tag: 1})

  // Replaying offer or payload for already-accepted seqs is strictly rejected
  assert.equal(
    (
      await receiverAuth.verifyActionOffer(
        'cmd',
        senderPeerId,
        ['admin'],
        meta1 ?? undefined
      )
    ).valid,
    false
  )
  assert.equal(
    (
      await receiverAuth.verifyActionPayload(
        'cmd',
        senderPeerId,
        ['admin'],
        largeBuf,
        meta1 ?? undefined
      )
    ).valid,
    false
  )
  assert.equal(
    (
      await receiverAuth.verifyActionPayload(
        'cmd',
        senderPeerId,
        ['admin'],
        'inline-2',
        meta2 ?? undefined
      )
    ).valid,
    false
  )
  assert.equal(sigFailures, 0)

  // 2. End-to-end action-wire pipeline: delay multi-chunk data frames so inline messages overtake a 96KB binary transfer
  const peerErrors: unknown[] = []
  const leftPeer = {
    sendData: (bytes: Uint8Array) => {
      const copy = bytes.slice().buffer
      const kind = bytes[1]! & 15
      if (kind === 2) {
        // Delay chunk frames so inline (kind === 0) frames overtake the multi-chunk transfer
        setTimeout(() => rightMgr.handleData(senderPeerId, copy), 20)
      } else {
        queueMicrotask(() => rightMgr.handleData(senderPeerId, copy))
      }
    },
    destroy: () => {}
  }
  const rightPeer = {
    sendData: (bytes: Uint8Array) => {
      const copy = bytes.slice().buffer
      queueMicrotask(() => leftMgr.handleData(receiverPeerId, copy))
    },
    destroy: () => {}
  }
  const leftMgr = createActionManager({
    onPeerError: (_id, err) => peerErrors.push(err),
    getPeer: () => leftPeer as never,
    getPeerIds: () => [receiverPeerId],
    canReceiveFromPeer: () => true,
    registerActionAuthority: () => {},
    signActionPayload: senderAuth.signActionPayload
  })
  const rightMgr = createActionManager({
    onPeerError: (_id, err) => peerErrors.push(err),
    getPeer: () => rightPeer as never,
    getPeerIds: () => [senderPeerId],
    canReceiveFromPeer: () => true,
    registerActionAuthority: () => {},
    getPeerRoles: receiverAuth.getPeerRoles,
    verifyActionOffer: receiverAuth.verifyActionOffer,
    verifyActionPayload: receiverAuth.verifyActionPayload
  })

  const sendBin = leftMgr.makeAction<Uint8Array>('bin-gated', {
    roles: ['admin']
  })
  const recvBin = rightMgr.makeAction<Uint8Array>('bin-gated', {
    roles: ['admin']
  })
  const receivedSizes: number[] = []
  recvBin.onMessage(data => {
    receivedSizes.push(data.byteLength)
  })

  const chunkedPayload = new Uint8Array(96 * 1024).fill(7)
  await Promise.all([
    sendBin.send(chunkedPayload),
    sendBin.send(new Uint8Array([1, 2, 3])),
    sendBin.send(new Uint8Array([4, 5, 6, 7])),
    sendBin.send(new Uint8Array([8, 9]))
  ])

  await waitFor(() => receivedSizes.length === 4, 2_000)
  assert.equal(peerErrors.length, 0)
  // All 3 inline frames (sizes 2, 3, 4) arrived BEFORE the 96KB multi-chunk transfer completed!
  assert.deepEqual(
    receivedSizes.slice(0, 3).sort((a, b) => a - b),
    [2, 3, 4]
  )
  assert.equal(receivedSizes[3], 96 * 1024)
})

void test('applySyncBatch resolves unsorted mutual admin bans without spurious ban side-effects and isolates monotonic clocks per room', async () => {
  const [root, adminA, adminB] = await Promise.all([
    createUserIdentity(),
    createUserIdentity(),
    createUserIdentity()
  ])
  const scope = {appId: 'batch-ban-test', roomId: 'room-batch'}

  const certA = await signRoleCertificate(root.sign, root.signPubJwk, {
    ...scope,
    subUserId: adminA.userId,
    roles: ['admin'],
    now: 1_000
  })
  const certB = await signRoleCertificate(root.sign, root.signPubJwk, {
    ...scope,
    subUserId: adminB.userId,
    roles: ['admin'],
    now: 1_000
  })

  // AdminB bans AdminA FIRST at ts=2_000; AdminA attempts a retaliatory ban against AdminB LATER at ts=3_000
  const banA_by_B_at_2000 = await signPeerBan(
    adminB.sign,
    adminB.signPubJwk,
    certB,
    {
      ...scope,
      issuerUserId: adminB.userId,
      targetUserId: adminA.userId,
      reason: 'first-strike',
      seq: 1,
      ts: 2_000
    }
  )
  const banB_by_A_at_3000 = await signPeerBan(
    adminA.sign,
    adminA.signPubJwk,
    certA,
    {
      ...scope,
      issuerUserId: adminA.userId,
      targetUserId: adminB.userId,
      reason: 'retaliation-after-ban',
      seq: 1,
      ts: 3_000
    }
  )

  const bannedSideEffects: Array<{uid: string; reason?: string}> = []
  let sigFailures = 0
  const observer = createRoomAuthority({
    selfId: 'peer-observer',
    appId: scope.appId,
    initialRoomId: scope.roomId,
    admin: {admins: [root.userId]},
    isOverlayPeerBanned: () => false,
    onPeerBanned: (uid, rec) => {
      bannedSideEffects.push({
        uid,
        ...(rec.reason !== undefined ? {reason: rec.reason} : {})
      })
    },
    onSignatureFailure: () => {
      sigFailures++
    }
  })

  // Feed bans in REVERSE causal order: retaliatory ts=3_000 first, winning ts=2_000 second!
  const batchRes = await observer.applySyncBatch({
    certs: [certA, certB],
    bans: [banB_by_A_at_3000, banA_by_B_at_2000]
  })

  assert.equal(sigFailures, 0)
  assert.equal(observer.isPeerBanned(adminA.userId), true)
  assert.equal(observer.isPeerBanned(adminB.userId), false)
  assert.deepEqual(
    bannedSideEffects,
    [{uid: adminA.userId, reason: 'first-strike'}],
    'onPeerBanned must never fire transiently for surviving AdminB'
  )
  assert.equal(batchRes.bans.length, 1)
  assert.equal(batchRes.bans[0]?.targetUserId, adminA.userId)

  // Per-room monotonic clock isolation: future skew in room 1 does not advance room 2's clock
  const skewedRoomAuth = createRoomAuthority({
    selfId: 'peer-root-1',
    appId: scope.appId,
    initialRoomId: 'skewed-room',
    admin: {admins: [root.userId]},
    getLocalUserIdentity: async () => root,
    isOverlayPeerBanned: () => false,
    getPeerUserId: pid => (pid === 'peer-a' ? adminA.userId : undefined)
  })
  const cleanRoomAuth = createRoomAuthority({
    selfId: 'peer-root-2',
    appId: scope.appId,
    initialRoomId: 'clean-room',
    admin: {admins: [root.userId]},
    getLocalUserIdentity: async () => root,
    isOverlayPeerBanned: () => false,
    getPeerUserId: pid => (pid === 'peer-b' ? adminB.userId : undefined)
  })

  const skewedDelegateCert = await skewedRoomAuth.issueRoleCertificate(
    'peer-a',
    'admin'
  )
  const skewedRev = await signRoleRevocation(
    adminA.sign,
    adminA.signPubJwk,
    skewedDelegateCert,
    {
      appId: scope.appId,
      roomId: 'skewed-room',
      issuerUserId: adminA.userId,
      targetUserId: adminB.userId,
      role: 'mod',
      seq: 1,
      ts: Date.now() + 45_000
    }
  )
  await wait(2)
  assert.equal(await skewedRoomAuth.verifyAndApplyRevocation(skewedRev), true)
  const skewedRegrant = await skewedRoomAuth.issueRoleCertificate(
    adminB.userId,
    'mod'
  )
  assert.ok(skewedRegrant.iat > Date.now() + 40_000)

  const beforeClean = Date.now()
  const cleanCert = await cleanRoomAuth.issueRoleCertificate('peer-b', 'mod')
  assert.ok(
    cleanCert.iat <= Date.now() + 1_000 && cleanCert.iat >= beforeClean - 50,
    `expected cleanRoomAuth clock to remain near wall-clock, got delta ${cleanCert.iat - beforeClean}ms`
  )
})
