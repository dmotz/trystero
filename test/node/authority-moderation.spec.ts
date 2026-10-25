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
  // @ts-expect-error Internal source import crosses a referenced package boundary.
} from '../../packages/core/src/authority.ts'
import {
  createUserIdentity,
  getOrCreateEndpointIdentity,
  signUserEndpointProof
  // @ts-expect-error Internal source import crosses a referenced package boundary.
} from '../../packages/core/src/identity.ts'

const setup = async () => {
  const [root, owner, delegate, target] = await Promise.all([
    createUserIdentity(),
    getOrCreateEndpointIdentity('peer-owner'),
    getOrCreateEndpointIdentity('peer-delegate'),
    getOrCreateEndpointIdentity('peer-target')
  ])
  const scope = {appId: 'moderation-test', roomId: 'room'}
  const authority = createRoomAuthority({
    selfId: owner.peerId,
    appId: scope.appId,
    initialRoomId: scope.roomId,
    admin: {admins: [root.userId]},
    getLocalCryptoIdentity: async () => owner,
    getLocalUserIdentity: async () => root,
    getOverlayPeerPublicKey: () => undefined,
    isOverlayPeerBanned: () => false,
    onRoomIdResolved: () => {},
    onPeerPublicKey: () => {},
    onLocalRoleCertificate: () => {},
    onPrivilegedPeer: () => {},
    onPeerBanned: () => {},
    onSignatureFailure: () => {}
  })
  await authority.getAuthorityInfo()
  const grant = async (identity: typeof delegate, roles: string[]) => {
    const cert = await signRoleCertificate(root.sign, root.signPubJwk, {
      ...scope,
      subPeerId: identity.peerId,
      subPubKey: identity.signPubJwk,
      roles,
      canDelegate: true
    })
    await authority.verifyAndApplyCert(cert)
    return cert
  }
  return {authority, root, delegate, target, scope, grant}
}

void test('revoked admins cannot issue new bans or revocations', async () => {
  const {authority, delegate, target, scope, grant} = await setup()
  const cert = await grant(delegate, ['admin'])
  await grant(target, ['player'])
  await authority.issueRoleRevocation(delegate.peerId, 'admin')
  assert.deepEqual(authority.getPeerRoles(delegate.peerId), [])

  const ban = await signPeerBan(delegate.signPrivateKey, cert, {
    ...scope,
    issuerPeerId: delegate.peerId,
    targetPeerId: target.peerId,
    seq: 1
  })
  assert.equal(await authority.verifyAndApplyBan(ban), false)
  assert.equal(authority.isPeerBanned(target.peerId), false)

  const revocation = await signRoleRevocation(delegate.signPrivateKey, cert, {
    ...scope,
    issuerPeerId: delegate.peerId,
    targetPeerId: target.peerId,
    seq: 2
  })
  assert.equal(await authority.verifyAndApplyRevocation(revocation), false)
  assert.deepEqual(authority.getPeerRoles(target.peerId), ['player'])
})

void test('delegators can revoke only roles they currently hold', async () => {
  const {authority, delegate, target, scope, grant} = await setup()
  const cert = await grant(delegate, ['viewer'])
  await grant(target, ['admin', 'viewer'])

  for (const role of ['admin', '*', undefined]) {
    const revocation = await signRoleRevocation(delegate.signPrivateKey, cert, {
      ...scope,
      issuerPeerId: delegate.peerId,
      targetPeerId: target.peerId,
      seq: 1,
      ...(role === undefined ? {} : {role})
    })
    assert.equal(await authority.verifyAndApplyRevocation(revocation), false)
  }
  const allowed = await signRoleRevocation(delegate.signPrivateKey, cert, {
    ...scope,
    issuerPeerId: delegate.peerId,
    targetPeerId: target.peerId,
    role: 'viewer',
    seq: 2
  })
  assert.equal(await authority.verifyAndApplyRevocation(allowed), true)
  assert.deepEqual(authority.getPeerRoles(target.peerId), ['admin'])
})

void test('delegated admins cannot manufacture root certificates', async () => {
  const {authority, delegate, target, scope, grant} = await setup()
  const parentCert = await grant(delegate, ['admin'])
  const forgedRoot = await signRoleCertificate(
    delegate.signPrivateKey,
    delegate.signPubJwk,
    {
      ...scope,
      subPeerId: target.peerId,
      subPubKey: target.signPubJwk,
      roles: ['admin'],
      canDelegate: true,
      parentCert,
      isRoot: true
    }
  )
  assert.equal(await authority.verifyAndApplyCert(forgedRoot), false)
  assert.deepEqual(authority.getPeerRoles(target.peerId), [])
})

void test('C3 regression: RoleRevocationRecord cannot be re-wrapped as a PeerBanRecord (and vice versa)', async () => {
  const {authority, root, delegate, target, scope, grant} = await setup()
  const targetUser = await createUserIdentity()
  const adminCert = await grant(delegate, ['admin'])
  const modCert = await signRoleCertificate(
    delegate.signPrivateKey,
    delegate.signPubJwk,
    {
      ...scope,
      subPeerId: target.peerId,
      subUserId: targetUser.userId,
      subPubKey: target.signPubJwk,
      roles: ['moderator'],
      parentCert: adminCert
    }
  )
  assert.equal(await authority.verifyAndApplyCert(modCert), true)
  assert.deepEqual(authority.getPeerRoles(target.peerId), ['moderator'])

  const revocation = await signRoleRevocation(
    delegate.signPrivateKey,
    adminCert,
    {
      ...scope,
      issuerPeerId: delegate.peerId,
      targetPeerId: target.peerId,
      targetUserId: targetUser.userId,
      targetCertId: modCert.certId,
      role: 'moderator',
      seq: 1
    }
  )

  const forgedBanFromRevocation = {
    v: revocation.v,
    appId: revocation.appId,
    roomId: revocation.roomId,
    issuerPeerId: revocation.issuerPeerId,
    targetPeerId: revocation.targetPeerId,
    ...(revocation.targetUserId ? {targetUserId: revocation.targetUserId} : {}),
    ...(revocation.targetCertId
      ? {targetKeyThumbprint: revocation.targetCertId}
      : {}),
    ...(revocation.role ? {reason: revocation.role} : {}),
    seq: revocation.seq,
    ts: revocation.ts,
    issuerCert: revocation.issuerCert,
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
      new Set<string>(),
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
  assert.equal(authority.isPeerBanned(targetUser.userId), false)

  // Also verify that a valid PeerBanRecord cannot be re-wrapped as a RoleRevocationRecord
  const validBan = await signPeerBan(delegate.signPrivateKey, adminCert, {
    ...scope,
    issuerPeerId: delegate.peerId,
    targetPeerId: target.peerId,
    targetUserId: targetUser.userId,
    targetKeyThumbprint: modCert.certId,
    reason: 'moderator',
    seq: 2
  })
  const forgedRevocationFromBan = {
    v: validBan.v,
    appId: validBan.appId,
    roomId: validBan.roomId,
    issuerPeerId: validBan.issuerPeerId,
    targetPeerId: validBan.targetPeerId,
    ...(validBan.targetUserId ? {targetUserId: validBan.targetUserId} : {}),
    ...(validBan.targetKeyThumbprint
      ? {targetCertId: validBan.targetKeyThumbprint}
      : {}),
    ...(validBan.reason ? {role: validBan.reason} : {}),
    seq: validBan.seq,
    ts: validBan.ts,
    issuerCert: validBan.issuerCert,
    sig: validBan.sig
  }
  assert.equal(
    await verifyRoleRevocation(
      forgedRevocationFromBan,
      scope.appId,
      scope.roomId,
      new Set<string>(),
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

void test('offer-time role spoofing via matching certId, malformed records, stale cert deduplication, state Infinity/prevHash/hash, and delegation edge cases', async () => {
  const {authority, root, delegate, target, scope, grant} = await setup()

  // 1. Offer-time role spoofing: peer with stored 'speaker' cert sends offer with tampered wire cert (same certId, forged roles: ['admin'])
  const speakerCert = await grant(target, ['speaker'])
  assert.deepEqual(authority.getPeerRoles(target.peerId), ['speaker'])

  const validEnv = await signActionAuth(target.signPrivateKey, speakerCert, {
    ...scope,
    namespace: 'admin-cmd',
    peerId: target.peerId,
    seq: 1,
    data: new Uint8Array([1, 2, 3])
  })
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

  // 2. Malformed records (issuerCert: {}, cert: {}, parentCert: {}) return false without throwing TypeError
  assert.equal(
    await verifyRoleRevocation(
      {
        v: 1,
        ...scope,
        issuerPeerId: delegate.peerId,
        targetPeerId: target.peerId,
        seq: 1,
        ts: 100,
        issuerCert: {} as any,
        sig: 'AAAA'
      },
      scope.appId,
      scope.roomId,
      new Set(),
      new Set([root.userId])
    ),
    false
  )
  assert.equal(
    await verifyPeerBan(
      {
        v: 1,
        ...scope,
        issuerPeerId: delegate.peerId,
        targetPeerId: target.peerId,
        seq: 1,
        ts: 100,
        issuerCert: {} as any,
        sig: 'AAAA'
      },
      scope.appId,
      scope.roomId,
      new Set(),
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
        },
        {
          ...scope,
          namespace: 'x',
          peerId: target.peerId,
          data: 'hi',
          requiredRoles: ['admin'],
          rootFingerprints: new Set(),
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
        epoch: 1,
        seq: 1,
        prevHash: '00000000000000000000000000000000',
        ts: 100,
        updatedBy: delegate.peerId,
        signerPubKey: {} as any,
        cert: {} as any,
        value: 1,
        sig: 'AAAA',
        hash: '00'
      },
      scope.appId,
      scope.roomId,
      ['admin'],
      new Set(),
      new Set([root.userId])
    ),
    false
  )
  assert.equal(
    (
      await verifyRoleCertificateChain(
        {
          ...speakerCert,
          parentCert: {canDelegate: true} as any
        },
        scope.appId,
        scope.roomId,
        new Set(),
        new Set()
      )
    ).valid,
    false
  )

  // 3. verifyAndApplyCert returns false for stale certs (iat < existing.iat) to prevent sync re-broadcast storms
  const newerCert = await signRoleCertificate(root.sign, root.signPubJwk, {
    ...scope,
    subPeerId: delegate.peerId,
    subPubKey: delegate.signPubJwk,
    roles: ['admin'],
    canDelegate: true,
    now: Date.now() + 5_000
  })
  const olderCert = await signRoleCertificate(root.sign, root.signPubJwk, {
    ...scope,
    subPeerId: delegate.peerId,
    subPubKey: delegate.signPubJwk,
    roles: ['moderator'],
    canDelegate: true,
    now: Date.now() - 5_000
  })
  assert.equal(await authority.verifyAndApplyCert(newerCert), true)
  assert.equal(
    await authority.verifyAndApplyCert(olderCert),
    false,
    'stale certificate must return false from verifyAndApplyCert'
  )

  // 4. State records: reject Infinity seq/epoch, enforce prevHash continuity, and compute deterministic hash from canonical payload
  const stateRec1 = await signStateRecord(
    delegate.signPrivateKey,
    delegate.signPubJwk,
    newerCert,
    {
      ...scope,
      namespace: 'cfg',
      epoch: 1,
      seq: 1,
      prevHash: '00000000000000000000000000000000',
      updatedBy: delegate.peerId,
      value: {step: 1}
    }
  )
  const infStateRec = await signStateRecord(
    delegate.signPrivateKey,
    delegate.signPubJwk,
    newerCert,
    {
      ...scope,
      namespace: 'cfg',
      epoch: 1,
      seq: Number.POSITIVE_INFINITY,
      prevHash: stateRec1.hash,
      updatedBy: delegate.peerId,
      value: {step: 999}
    }
  )
  assert.equal(
    await verifyStateRecord(
      infStateRec,
      scope.appId,
      scope.roomId,
      ['admin'],
      new Set(),
      new Set([root.userId])
    ),
    false,
    'state record with seq: Infinity must be rejected'
  )
  assert.equal(await authority.verifyAndApplyStateRecord(stateRec1), true)

  const badPrevHashRec = await signStateRecord(
    delegate.signPrivateKey,
    delegate.signPubJwk,
    newerCert,
    {
      ...scope,
      namespace: 'cfg',
      epoch: 1,
      seq: 2,
      prevHash: 'deadbeefdeadbeefdeadbeefdeadbeef',
      updatedBy: delegate.peerId,
      value: {step: 2}
    }
  )
  assert.equal(
    await authority.verifyAndApplyStateRecord(badPrevHashRec),
    false,
    'sequential same-writer state update with mismatched prevHash must be rejected'
  )

  // 5. Delegated admin cannot ban or revoke root admin even on a peer that has not yet seen the root cert
  const freshPeerId = await getOrCreateEndpointIdentity('peer-fresh')
  const freshAuthority = createRoomAuthority({
    selfId: freshPeerId.peerId,
    appId: scope.appId,
    initialRoomId: scope.roomId,
    admin: {admins: [root.userId]},
    getLocalCryptoIdentity: async () => freshPeerId,
    getOverlayPeerPublicKey: () => undefined,
    isOverlayPeerBanned: () => false,
    getPeerUserId: pid => (pid === 'peer-owner' ? root.userId : undefined),
    onRoomIdResolved: () => {},
    onPeerPublicKey: () => {},
    onLocalRoleCertificate: () => {},
    onPrivilegedPeer: () => {},
    onPeerBanned: () => {},
    onSignatureFailure: () => {}
  })
  await freshAuthority.getAuthorityInfo()

  const banAgainstRoot = await signPeerBan(delegate.signPrivateKey, newerCert, {
    ...scope,
    issuerPeerId: delegate.peerId,
    targetPeerId: 'peer-owner',
    targetUserId: root.userId,
    seq: 10
  })
  assert.equal(
    await freshAuthority.verifyAndApplyBan(banAgainstRoot),
    false,
    'delegated admin must not be able to ban root admin even before root cert is received'
  )
  assert.equal(freshAuthority.isPeerBanned('peer-owner'), false)
  assert.equal(freshAuthority.isPeerBanned(root.userId), false)

  // 6. Multi-device delegated admin can issue revocations and bans from a second tab/endpoint using userProof
  const adminUser2 = await createUserIdentity()
  const adminTab1 = await getOrCreateEndpointIdentity('peer-admin2-tab1')
  const adminTab2 = await getOrCreateEndpointIdentity('peer-admin2-tab2')
  const tab1Cert = await signRoleCertificate(root.sign, root.signPubJwk, {
    ...scope,
    subPeerId: adminTab1.peerId,
    subUserId: adminUser2.userId,
    subPubKey: adminTab1.signPubJwk,
    roles: ['admin'],
    canDelegate: true
  })
  await authority.verifyAndApplyCert(tab1Cert)
  const tab2Proof = await signUserEndpointProof(adminUser2, {
    ...scope,
    peerId: adminTab2.peerId,
    peerPubJwk: adminTab2.signPubJwk
  })
  const multiTabBan = await signPeerBan(adminTab2.signPrivateKey, tab1Cert, {
    ...scope,
    issuerPeerId: adminTab2.peerId,
    targetPeerId: target.peerId,
    seq: 1,
    signerPubKey: adminTab2.signPubJwk,
    userPubKey: adminUser2.signPubJwk,
    userProof: tab2Proof
  })
  assert.equal(
    await authority.verifyAndApplyBan(multiTabBan),
    true,
    'multi-device admin tab must be able to issue a valid ban using user endpoint proof'
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
      revId: 'r1',
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
      parentCert: {corrupted: true} as never
    }),
    false
  )
  assert.equal(
    await authority.verifyAndApplyBan({
      ...multiTabBan,
      userProof: {corrupted: true} as never
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
