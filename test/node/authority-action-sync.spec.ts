import assert from 'node:assert/strict'
import test from './test.ts'
import {
  createRoomAuthority,
  signPeerBan,
  signRoleCertificate,
  signRoleRevocation,
  signStateRecord,
  verifyRoleCertificateChain,
  verifyRoleRevocation,
  validateRoleCertificateShape
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
