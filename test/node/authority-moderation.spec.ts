import assert from 'node:assert/strict'
import test from './test.ts'
import {
  createRoomAuthority,
  signPeerBan,
  signRoleCertificate,
  signRoleRevocation
  // @ts-expect-error Internal source import crosses a referenced package boundary.
} from '../../packages/core/src/authority.ts'
import {
  createUserIdentity,
  getOrCreateEndpointIdentity
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
    admin: [root.userId],
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
  return {authority, delegate, target, scope, grant}
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
