import assert from 'node:assert/strict'
import test from './test.ts'
import {createActionManager} from '../../packages/core/src/actions.ts'
import {
  createRoomAuthority,
  moderationCanonicalPayload,
  revocationCanonicalPayload
} from '../../packages/core/src/authority.ts'
import {createUserIdentity} from '../../packages/core/src/identity.ts'
import type {
  PeerModerationRecord,
  RoleRevocationRecord
} from '../../packages/core/src/internal-types.ts'
import {
  defaultMaxClockSkewMs,
  maxObservedClockDragMs,
  signRoleCertInternal,
  signWith,
  toCleanJwk,
  verifyRoleCertificate
} from '../../packages/core/src/signed-record.ts'
import {
  createStateManager,
  signStateRecord
} from '../../packages/core/src/state.ts'
import type {UserIdentity} from '../../packages/core/src/types.ts'
import {
  encodeBytes,
  validateRoleCertificateShape
} from '../../packages/core/src/utils.ts'
import {actionStartFrame, testPeerId, wait, waitFor} from './peer-harness.ts'

const makeSignedRevocation = async (
  signer: UserIdentity,
  params: {
    appId: string
    roomId: string
    targetUserId: string
    role?: string
    seq: number
    ts: number
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
    ts: params.ts,
    signerPubKey: toCleanJwk(signer.signPubJwk)
  }
  return {
    ...unsigned,
    sig: await signWith(signer.sign, revocationCanonicalPayload(unsigned))
  }
}

const makeSignedModeration = async (
  signer: UserIdentity,
  params: {
    op: 'ban' | 'unban'
    appId: string
    roomId: string
    targetUserId: string
    reason?: string
    seq: number
    ts: number
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
    ts: params.ts,
    signerPubKey: toCleanJwk(signer.signPubJwk)
  }
  return {
    ...unsigned,
    sig: await signWith(signer.sign, moderationCanonicalPayload(unsigned))
  }
}

void test('clock skew hardening and 1-tier root-admin authority: reject future-dated records, bound clock drag, floor re-granted cert iat above skewed revocations, and reject non-root cert issuance', async () => {
  const [rootA, rootB, moderator, target, bystander] = await Promise.all([
    createUserIdentity(),
    createUserIdentity(),
    createUserIdentity(),
    createUserIdentity(),
    createUserIdentity()
  ])
  const scope = {appId: 'moderation-test', roomId: 'room'}
  const ownerPeerId = testPeerId('aas-owner')
  const coRootPeerId = testPeerId('aas-coroot')
  const modPeerId = testPeerId('aas-mod')
  const targetPeerId = testPeerId('aas-target')
  const bystanderPeerId = testPeerId('aas-bystander')

  const peerUsers: Record<string, string> = {
    [ownerPeerId]: rootA.userId,
    [coRootPeerId]: rootB.userId,
    [modPeerId]: moderator.userId,
    [targetPeerId]: target.userId,
    [bystanderPeerId]: bystander.userId
  }

  const authority = createRoomAuthority({
    selfId: ownerPeerId,
    appId: scope.appId,
    initialRoomId: scope.roomId,
    admin: {admins: [rootA.userId, rootB.userId]},
    getLocalUserIdentity: async () => rootA,
    isOverlayPeerBanned: () => false,
    getKnownPeerUserId: pid => peerUsers[pid]
  })
  await authority.getAuthorityInfo()

  const stateManager = createStateManager({
    appId: scope.appId,
    getRoomId: () => authority.getEffectiveRoomId(),
    getSelfId: () => ownerPeerId,
    getLocalUserId: () => rootA.userId,
    ensureReady: async () => ({
      selfId: ownerPeerId,
      user: rootA,
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

  try {
    stateManager.makeState('clock-test', '')

    // 'admin' role is reserved strictly for root admins and cannot be granted to non-root users
    await assert.rejects(
      () => authority.issueRoleCertificate(moderator.userId, ['admin']),
      /'admin' role is reserved for room root admins/
    )

    await authority.issueRoleCertificate(moderator.userId, ['moderator'])
    await authority.issueRoleCertificate(target.userId, ['player'])
    assert.deepEqual(authority.getPeerRoles(targetPeerId), ['player'])

    // 1. Poison-pill future timestamps (> Date.now() + defaultMaxClockSkewMs) on revocations, moderations, and state records are rejected
    const poisonRevocation = await makeSignedRevocation(rootB, {
      ...scope,
      targetUserId: target.userId,
      role: 'player',
      seq: 1,
      ts: Number.MAX_SAFE_INTEGER
    })
    assert.equal(
      await authority.verifyAndApplyRevocation(poisonRevocation),
      false,
      'future-dated revocation must be rejected'
    )
    assert.deepEqual(authority.getPeerRoles(targetPeerId), ['player'])

    const futureBan = await makeSignedModeration(rootB, {
      op: 'ban',
      ...scope,
      targetUserId: target.userId,
      seq: 2,
      ts: Date.now() + defaultMaxClockSkewMs + 60_000
    })
    assert.equal(await authority.verifyAndApplyModeration(futureBan), false)
    assert.equal(authority.isPeerBanned(targetPeerId), false)

    const futureState = await signStateRecord(rootB.sign, rootB.signPubJwk, {
      ...scope,
      ns: 'clock-test',
      hlc: Date.now() + defaultMaxClockSkewMs + 60_000,
      peerId: coRootPeerId,
      userId: rootB.userId,
      val: 'future'
    })
    assert.equal(
      await stateManager.verifyAndApplyStateRecord(futureState),
      false
    )

    // 2. Observing a +30s revocation clamps global clock drag to maxObservedClockDragMs (5_000ms),
    // while re-granting the revoked target floors iat strictly above skewedRevocation.ts
    const skewedRevocation = await makeSignedRevocation(rootB, {
      ...scope,
      targetUserId: target.userId,
      role: 'player',
      seq: 3,
      ts: Date.now() + 30_000
    })
    assert.equal(
      await authority.verifyAndApplyRevocation(skewedRevocation),
      true
    )
    assert.deepEqual(authority.getPeerRoles(targetPeerId), [])

    const bystanderCert = await authority.issueRoleCertificate(
      bystanderPeerId,
      'viewer'
    )
    assert.ok(
      bystanderCert.iat <= Date.now() + maxObservedClockDragMs + 1_000,
      `expected unrelated cert iat bounded by maxObservedClockDragMs (${maxObservedClockDragMs}ms), got +${bystanderCert.iat - Date.now()}ms`
    )

    const regrantedCert = await authority.issueRoleCertificate(
      targetPeerId,
      'player'
    )
    assert.ok(
      regrantedCert.iat > skewedRevocation.ts,
      're-granted cert iat must supersede skewed revocation ts'
    )
    assert.deepEqual(authority.getPeerRoles(targetPeerId), ['player'])

    // 3. 1-tier authority: non-root role holders ('moderator') cannot sign RoleCertificates
    const subMod = await createUserIdentity()
    const nonRootCert = await signRoleCertInternal(
      moderator.sign,
      moderator.signPubJwk,
      subMod.userId,
      scope.appId,
      scope.roomId,
      ['helper'],
      Date.now()
    )
    assert.equal(validateRoleCertificateShape(nonRootCert), true)
    assert.equal(
      (
        await verifyRoleCertificate(
          nonRootCert,
          scope.appId,
          scope.roomId,
          new Set([rootA.userId, rootB.userId])
        )
      ).valid,
      false,
      'verifyRoleCertificate must reject certificates signed by non-root issuers'
    )
    assert.equal(await authority.verifyAndApplyCert(nonRootCert), false)
  } finally {
    stateManager.destroy()
  }
})

void test('Q5: role-gated makeAction preserves synchronous ordered delivery in mesh, bootstraps inline RoleCertificate, and lets inline messages overtake chunked transfers', async () => {
  const [root, modUser, guestUser, receiverId] = await Promise.all([
    createUserIdentity(),
    createUserIdentity(),
    createUserIdentity(),
    createUserIdentity()
  ])
  const appId = 'action-sync-delivery-test'
  const roomId = 'room-q5'
  const rootPeerId = testPeerId('q5-root-sender')
  const modPeerId = testPeerId('q5-mod-sender')
  const guestPeerId = testPeerId('q5-guest-sender')
  const receiverPeerId = testPeerId('q5-receiver')

  const peerUsers: Record<string, string> = {
    [rootPeerId]: root.userId,
    [modPeerId]: modUser.userId,
    [guestPeerId]: guestUser.userId,
    [receiverPeerId]: receiverId.userId
  }

  let sigFailures = 0
  const mkAuth = (selfId: string, user: UserIdentity) =>
    createRoomAuthority({
      selfId,
      appId,
      initialRoomId: roomId,
      admin: {admins: [root.userId]},
      getLocalUserIdentity: async () => user,
      isOverlayPeerBanned: () => false,
      getKnownPeerUserId: pid => peerUsers[pid],
      onSignatureFailure: () => {
        sigFailures++
      }
    })

  const rootAuth = mkAuth(rootPeerId, root)
  const modAuth = mkAuth(modPeerId, modUser)
  const guestAuth = mkAuth(guestPeerId, guestUser)
  const receiverAuth = mkAuth(receiverPeerId, receiverId)
  await Promise.all([
    rootAuth.getAuthorityInfo(),
    modAuth.getAuthorityInfo(),
    guestAuth.getAuthorityInfo(),
    receiverAuth.getAuthorityInfo()
  ])

  // Grant 'moderator' to modUser and apply on modAuth ONLY (receiverAuth learns it inline on first action!)
  const modCert = await rootAuth.issueRoleCertificate(modUser.userId, [
    'moderator'
  ])
  assert.equal(await modAuth.verifyAndApplyCert(modCert), true)
  assert.deepEqual(receiverAuth.getPeerRoles(modPeerId), [])

  // 1. Synchronous mesh transport: verify inline cert bootstrap + synchronous same-tick ordered delivery once cert is known
  const syncPeerErrors: Error[] = []
  const deliverSynchronously = true
  let syncDeliveryCountOnCallStack = 0
  const receivedModMsgs: Array<{
    seq: number
    meta: unknown
    roles: string[]
    userId: string
  }> = []
  const receivedAdminSeqs: number[] = []

  const makeSenderToReceiverPeer = (fromPeerId: string) => ({
    channel: {
      readyState: 'open',
      bufferedAmount: 0,
      bufferedAmountLowThreshold: 0
    },
    sendData: (bytes: Uint8Array) => {
      const copy = bytes.slice().buffer
      if (deliverSynchronously) {
        const before = receivedModMsgs.length + receivedAdminSeqs.length
        recvMgr.handleData(fromPeerId, copy)
        const after = receivedModMsgs.length + receivedAdminSeqs.length
        if (after > before) {
          syncDeliveryCountOnCallStack += after - before
        }
      } else {
        queueMicrotask(() => recvMgr.handleData(fromPeerId, copy))
      }
    },
    destroy: () => {}
  })

  const makeReceiverToSenderPeer = (
    targetMgr: () => ReturnType<typeof createActionManager>
  ) => ({
    channel: {
      readyState: 'open',
      bufferedAmount: 0,
      bufferedAmountLowThreshold: 0
    },
    sendData: (bytes: Uint8Array) => {
      const copy = bytes.slice().buffer
      queueMicrotask(() => targetMgr().handleData(receiverPeerId, copy))
    },
    destroy: () => {}
  })

  const rootToRecv = makeSenderToReceiverPeer(rootPeerId)
  const modToRecv = makeSenderToReceiverPeer(modPeerId)
  const guestToRecv = makeSenderToReceiverPeer(guestPeerId)

  const rootMgr = createActionManager({
    onPeerError: (_id, err) => syncPeerErrors.push(err),
    getPeer: () => rootToRecv as never,
    getPeerIds: () => [receiverPeerId],
    canReceiveFromPeer: () => true,
    getLocalActionCert: rootAuth.getLocalActionCert,
    authorizePeerAction: rootAuth.authorizePeerAction,
    getPeerRoles: rootAuth.getPeerRoles,
    getPeerUserId: pid => peerUsers[pid] ?? pid
  })
  const modMgr = createActionManager({
    onPeerError: (_id, err) => syncPeerErrors.push(err),
    getPeer: () => modToRecv as never,
    getPeerIds: () => [receiverPeerId],
    canReceiveFromPeer: () => true,
    getLocalActionCert: modAuth.getLocalActionCert,
    authorizePeerAction: modAuth.authorizePeerAction,
    getPeerRoles: modAuth.getPeerRoles,
    getPeerUserId: pid => peerUsers[pid] ?? pid
  })
  const guestMgr = createActionManager({
    onPeerError: (_id, err) => syncPeerErrors.push(err),
    getPeer: () => guestToRecv as never,
    getPeerIds: () => [receiverPeerId],
    canReceiveFromPeer: () => true,
    getLocalActionCert: guestAuth.getLocalActionCert,
    authorizePeerAction: guestAuth.authorizePeerAction,
    getPeerRoles: guestAuth.getPeerRoles,
    getPeerUserId: pid => peerUsers[pid] ?? pid
  })

  const recvPeers: Record<string, unknown> = {
    [rootPeerId]: makeReceiverToSenderPeer(() => rootMgr),
    [modPeerId]: makeReceiverToSenderPeer(() => modMgr),
    [guestPeerId]: makeReceiverToSenderPeer(() => guestMgr)
  }
  const recvMgr = createActionManager({
    onPeerError: (_id, err) => syncPeerErrors.push(err),
    getPeer: id => recvPeers[id] as never,
    getPeerIds: () => [rootPeerId, modPeerId, guestPeerId],
    canReceiveFromPeer: () => true,
    getLocalActionCert: receiverAuth.getLocalActionCert,
    authorizePeerAction: receiverAuth.authorizePeerAction,
    getPeerRoles: receiverAuth.getPeerRoles,
    getPeerUserId: pid => peerUsers[pid] ?? pid
  })

  const recvModAct = recvMgr.makeAction<{seq: number}>('mod-cmd', {
    roles: ['moderator']
  })
  recvModAct.onMessage((data, ctx) => {
    receivedModMsgs.push({
      seq: data.seq,
      meta: ctx.metadata,
      roles: ctx.roles,
      userId: ctx.userId
    })
  })

  const recvAdminAct = recvMgr.makeAction<number>('admin-cmd', {
    roles: ['admin']
  })
  recvAdminAct.onMessage(seq => {
    receivedAdminSeqs.push(seq)
  })

  const sendModAct = modMgr.makeAction<{seq: number}>('mod-cmd', {
    roles: ['moderator']
  })
  const sendAdminAct = rootMgr.makeAction<number>('admin-cmd', {
    roles: ['admin']
  })
  const sendGuestAct = guestMgr.makeAction<{seq: number}>('mod-cmd', {
    roles: ['moderator']
  })

  // (a) First moderator message bootstraps modCert inline and strips __trysteroAuth while preserving user metadata
  await sendModAct.send({seq: 0}, {metadata: {tag: 'bootstrap'}})
  await waitFor(() => receivedModMsgs.length === 1)
  assert.deepEqual(receivedModMsgs[0], {
    seq: 0,
    meta: {tag: 'bootstrap'},
    roles: ['moderator'],
    userId: modUser.userId
  })
  assert.deepEqual(receiverAuth.getPeerRoles(modPeerId), ['moderator'])

  // (b) Subsequent moderator messages AND intrinsic root-admin messages deliver SYNCHRONOUSLY inside handleData in exact FIFO order!
  syncDeliveryCountOnCallStack = 0
  for (let i = 1; i <= 5; i++) {
    await sendModAct.send({seq: i}, {metadata: {step: i}})
  }
  for (let i = 1; i <= 4; i++) {
    await sendAdminAct.send(i)
  }
  assert.equal(
    syncDeliveryCountOnCallStack,
    9,
    'all 5 synced-role messages and 4 intrinsic-admin messages must deliver synchronously inside handleData'
  )
  assert.deepEqual(
    receivedModMsgs.map(m => m.seq),
    [0, 1, 2, 3, 4, 5]
  )
  assert.deepEqual(receivedAdminSeqs, [1, 2, 3, 4])

  // (c) Unauthorized sender is rejected on send() and raw spoofed wire frames are dropped synchronously
  await assert.rejects(
    () => sendGuestAct.send({seq: 99}),
    /insufficient authority/i
  )
  recvMgr.handleData(
    guestPeerId,
    actionStartFrame(0, 0, {
      type: 'mod-cmd',
      payload: encodeBytes(JSON.stringify({seq: 99})),
      format: 1
    })
  )
  assert.equal(receivedModMsgs.length, 6)

  // (d) Revoking 'moderator' immediately blocks further messages synchronously
  const revMod = await rootAuth.issueRoleRevocation(modUser.userId, 'moderator')
  assert.equal(await receiverAuth.verifyAndApplyRevocation(revMod), true)
  recvMgr.handleData(
    modPeerId,
    actionStartFrame(0, 0, {
      type: 'mod-cmd',
      payload: encodeBytes(JSON.stringify({seq: 6})),
      format: 1
    })
  )
  assert.equal(receivedModMsgs.length, 6)
  assert.equal(syncPeerErrors.length, 0)
  assert.equal(sigFailures, 0)

  // 2. End-to-end action-wire pipeline: delay multi-chunk data frames so inline messages overtake a 96 KiB binary transfer
  const peerErrors: unknown[] = []
  const leftPeer = {
    channel: {
      readyState: 'open',
      bufferedAmount: 0,
      bufferedAmountLowThreshold: 0
    },
    sendData: (bytes: Uint8Array) => {
      const copy = bytes.slice().buffer
      const kind = bytes[1]! & 15
      if (kind === 2) {
        setTimeout(() => rightMgr.handleData(rootPeerId, copy), 20)
      } else {
        queueMicrotask(() => rightMgr.handleData(rootPeerId, copy))
      }
    },
    destroy: () => {}
  }
  const rightPeer = {
    channel: {
      readyState: 'open',
      bufferedAmount: 0,
      bufferedAmountLowThreshold: 0
    },
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
    getLocalActionCert: rootAuth.getLocalActionCert,
    authorizePeerAction: rootAuth.authorizePeerAction,
    getPeerRoles: rootAuth.getPeerRoles,
    getPeerUserId: pid => peerUsers[pid] ?? pid
  })
  const rightMgr = createActionManager({
    onPeerError: (_id, err) => peerErrors.push(err),
    getPeer: () => rightPeer as never,
    getPeerIds: () => [rootPeerId],
    canReceiveFromPeer: () => true,
    getLocalActionCert: receiverAuth.getLocalActionCert,
    authorizePeerAction: receiverAuth.authorizePeerAction,
    getPeerRoles: receiverAuth.getPeerRoles,
    getPeerUserId: pid => peerUsers[pid] ?? pid
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
  // All 3 inline frames (sizes 3, 4, 2) arrived in FIFO order BEFORE the 96 KiB multi-chunk transfer completed!
  assert.deepEqual(receivedSizes.slice(0, 3), [3, 4, 2])
  assert.equal(receivedSizes[3], 96 * 1024)
})

void test('applySyncBatch resolves unsorted co-root PeerModerationRecords without spurious ban side-effects and isolates monotonic clocks per room', async () => {
  const [rootA, rootB, targetA, targetB, targetTie] = await Promise.all([
    createUserIdentity(),
    createUserIdentity(),
    createUserIdentity(),
    createUserIdentity(),
    createUserIdentity()
  ])
  const scope = {appId: 'batch-ban-test', roomId: 'room-batch'}

  // Target A: rootB banned at ts=2_000, rootA unbanned later at ts=3_000 -> net state is UNBANNED (zero onPeerBanned calls when fed [unban@3000, ban@2000])
  const banTargetA_at_2000 = await makeSignedModeration(rootB, {
    op: 'ban',
    ...scope,
    targetUserId: targetA.userId,
    reason: 'first-strike',
    seq: 1,
    ts: 2_000
  })
  const unbanTargetA_at_3000 = await makeSignedModeration(rootA, {
    op: 'unban',
    ...scope,
    targetUserId: targetA.userId,
    seq: 1,
    ts: 3_000
  })

  // Target B: rootA unbanned at ts=1_000, rootB banned later at ts=2_500 -> net state is BANNED
  const unbanTargetB_at_1000 = await makeSignedModeration(rootA, {
    op: 'unban',
    ...scope,
    targetUserId: targetB.userId,
    seq: 2,
    ts: 1_000
  })
  const banTargetB_at_2500 = await makeSignedModeration(rootB, {
    op: 'ban',
    ...scope,
    targetUserId: targetB.userId,
    reason: 'escalated',
    seq: 2,
    ts: 2_500
  })

  // Target Tie: identical (ts, seq, issuerUserId) -> 'ban' wins tie-break over 'unban'
  const unbanTie = await makeSignedModeration(rootA, {
    op: 'unban',
    ...scope,
    targetUserId: targetTie.userId,
    seq: 5,
    ts: 4_000
  })
  const banTie = await makeSignedModeration(rootA, {
    op: 'ban',
    ...scope,
    targetUserId: targetTie.userId,
    reason: 'tie-wins',
    seq: 5,
    ts: 4_000
  })

  const bannedSideEffects: Array<{uid: string; reason?: string}> = []
  const unbannedSideEffects: string[] = []
  let sigFailures = 0
  const observer = createRoomAuthority({
    selfId: testPeerId('batch-observer'),
    appId: scope.appId,
    initialRoomId: scope.roomId,
    admin: {admins: [rootA.userId, rootB.userId]},
    isOverlayPeerBanned: () => false,
    onPeerBanned: (uid, rec) => {
      bannedSideEffects.push({
        uid,
        ...(rec.reason !== undefined ? {reason: rec.reason} : {})
      })
    },
    onPeerUnbanned: uid => {
      unbannedSideEffects.push(uid)
    },
    onSignatureFailure: () => {
      sigFailures++
    }
  })

  const batchRes = await observer.applySyncBatch({
    moderations: [
      unbanTargetA_at_3000,
      banTargetA_at_2000,
      banTargetB_at_2500,
      unbanTargetB_at_1000,
      unbanTie,
      banTie
    ]
  })

  assert.equal(sigFailures, 0)
  assert.equal(observer.isPeerBanned(targetA.userId), false)
  assert.equal(observer.isPeerBanned(targetB.userId), true)
  assert.equal(observer.getBanReason(targetB.userId), 'escalated')
  assert.equal(observer.isPeerBanned(targetTie.userId), true)
  assert.equal(observer.getBanReason(targetTie.userId), 'tie-wins')
  assert.deepEqual(
    bannedSideEffects,
    [
      {uid: targetB.userId, reason: 'escalated'},
      {uid: targetTie.userId, reason: 'tie-wins'}
    ],
    'onPeerBanned must never fire for targetA whose newer unban arrived first in batch'
  )
  assert.deepEqual(unbannedSideEffects, [])
  assert.equal(batchRes.moderations.length, 4)

  // Per-room monotonic clock isolation: future skew in room 1 does not advance room 2's clock
  const peerTargetA = testPeerId('clock-iso-a')
  const peerTargetB = testPeerId('clock-iso-b')
  const skewedRoomAuth = createRoomAuthority({
    selfId: testPeerId('clock-root-1'),
    appId: scope.appId,
    initialRoomId: 'skewed-room',
    admin: {admins: [rootA.userId, rootB.userId]},
    getLocalUserIdentity: async () => rootA,
    isOverlayPeerBanned: () => false,
    getKnownPeerUserId: pid =>
      pid === peerTargetA ? targetA.userId : undefined
  })
  const cleanRoomAuth = createRoomAuthority({
    selfId: testPeerId('clock-root-2'),
    appId: scope.appId,
    initialRoomId: 'clean-room',
    admin: {admins: [rootA.userId, rootB.userId]},
    getLocalUserIdentity: async () => rootA,
    isOverlayPeerBanned: () => false,
    getKnownPeerUserId: pid =>
      pid === peerTargetB ? targetB.userId : undefined
  })

  const skewedRev = await makeSignedRevocation(rootB, {
    appId: scope.appId,
    roomId: 'skewed-room',
    targetUserId: targetA.userId,
    role: 'mod',
    seq: 1,
    ts: Date.now() + 45_000
  })
  await wait(2)
  assert.equal(await skewedRoomAuth.verifyAndApplyRevocation(skewedRev), true)
  const skewedRegrant = await skewedRoomAuth.issueRoleCertificate(
    peerTargetA,
    'mod'
  )
  assert.ok(skewedRegrant.iat > Date.now() + 40_000)

  const beforeClean = Date.now()
  const cleanCert = await cleanRoomAuth.issueRoleCertificate(peerTargetB, 'mod')
  assert.ok(
    cleanCert.iat <= Date.now() + 1_000 && cleanCert.iat >= beforeClean - 50,
    `expected cleanRoomAuth clock to remain near wall-clock, got delta ${cleanCert.iat - beforeClean}ms`
  )
})
