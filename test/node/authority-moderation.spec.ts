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
import {createUserIdentity} from '../../packages/core/src/identity.ts'

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
  const {authority, root, delegate, target, scope, grant} = await setup()

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
        ...scope,
        namespace: 's',
        seq: 1,
        prevHash: '00000000000000000000000000000000',
        ts: 100,
        updatedBy: delegate.peerId,
        userId: delegate.userId,
        signerPubKey: {} as any,
        cert: {} as any,
        value: 1,
        sig: 'AAAA',
        hash: '00'
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

  // 4. State records: reject Infinity seq, enforce prevHash continuity, and compute deterministic hash from canonical payload
  const stateRec1 = await signStateRecord(
    delegate.sign,
    delegate.signPubJwk,
    newerCert,
    {
      ...scope,
      namespace: 'cfg',
      seq: 1,
      prevHash: '00000000000000000000000000000000',
      updatedBy: delegate.peerId,
      userId: delegate.userId,
      value: {step: 1}
    }
  )
  const infStateRec = await signStateRecord(
    delegate.sign,
    delegate.signPubJwk,
    newerCert,
    {
      ...scope,
      namespace: 'cfg',
      seq: Number.POSITIVE_INFINITY,
      prevHash: stateRec1.hash,
      updatedBy: delegate.peerId,
      userId: delegate.userId,
      value: {step: 999}
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
    'state record with seq: Infinity must be rejected'
  )
  assert.equal(await authority.verifyAndApplyStateRecord(stateRec1), true)

  const badPrevHashRec = await signStateRecord(
    delegate.sign,
    delegate.signPubJwk,
    newerCert,
    {
      ...scope,
      namespace: 'cfg',
      seq: 2,
      prevHash: 'deadbeefdeadbeefdeadbeefdeadbeef',
      updatedBy: delegate.peerId,
      userId: delegate.userId,
      value: {step: 2}
    }
  )
  assert.equal(
    await authority.verifyAndApplyStateRecord(badPrevHashRec),
    false,
    'sequential same-writer state update with mismatched prevHash must be rejected'
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
      ...badPrevHashRec,
      seq: Number.POSITIVE_INFINITY
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
    await authority.verifyAndApplyStateRecord({
      ...badPrevHashRec,
      cert: {corrupted: true} as never
    }),
    false
  )
})

void test('clock skew hardening and 2-tier authority enforcement: reject future-dated records, floor re-granted cert iat above skewed revocations, and reject non-root cert issuance', async () => {
  const {authority, root, delegate, target, scope, grant} = await setup()
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
    adminCert,
    {
      ...scope,
      namespace: 'clock-test',
      seq: 1,
      prevHash: '00000000000000000000000000000000',
      ts: Date.now() + 120_000,
      updatedBy: delegate.peerId,
      userId: delegate.userId,
      value: 'future'
    }
  )
  assert.equal(await authority.verifyAndApplyStateRecord(futureState), false)

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
