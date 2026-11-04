import assert from 'node:assert/strict'
import test from './test.ts'
import type {
  MessageAction,
  PeerHandle,
  RolesPluginApi,
  Room,
  ScalePluginApi
} from '../../packages/core/src/index.ts'
import {
  actionWireVersion,
  inspectActionWireHeader
} from '../../packages/core/src/action-wire.ts'
import {createRoomAuthority, roles} from '../../packages/core/src/authority.ts'
import {
  createUserIdentity,
  exportUserIdentity,
  importUserIdentity
} from '../../packages/core/src/identity.ts'
import createRoom from '../../packages/core/src/room.ts'
import {
  buildOverlaySignedBytes,
  canonicalUnicastHeader,
  createOverlayManager,
  overlayUnicastKind,
  packOverlayBinary,
  scale,
  unpackOverlayFrame
} from '../../packages/core/src/scale/index.ts'
import {signRoleCertInternal} from '../../packages/core/src/signed-record.ts'
import {encodeBytes, toBase64Url} from '../../packages/core/src/utils.ts'
import {
  getTestEndpointByPeerId,
  LinkedPeer,
  linkPeers,
  testPeerId,
  wait,
  waitFor
} from './peer-harness.ts'

void test('PeerInfo in room.getPeers(), UserIdentity userId reuse, RoleCertificate validation, overlay anti-replay, offer-time role rejection, maxUsers admission, plaintext unicast rejection, and concurrent makeState serialization', async () => {
  // 1. UserIdentity deterministically preserves the same userId and signPubJwk across export/import
  const hostUser = await createUserIdentity()
  const reimportedHostUser = await importUserIdentity(
    exportUserIdentity(hostUser)
  )
  const otherUser = await createUserIdentity()
  assert.equal('publicKey' in hostUser, false)
  assert.equal(hostUser.signPubJwk.kty, 'EC')
  assert.equal(
    hostUser.userId,
    reimportedHostUser.userId,
    'same UserIdentity must deterministically derive the same self-certifying userId'
  )
  assert.notEqual(
    hostUser.userId,
    otherUser.userId,
    'different UserIdentities must derive distinct userIds'
  )

  // 2. RoleCertificate validation: future-iat rejection and reserved 'admin' role rejection
  const rootId = await createUserIdentity()
  const subId = await createUserIdentity()
  const certChecker = createRoomAuthority({
    selfId: testPeerId('cert-checker'),
    appId: 'test-app',
    initialRoomId: 'test-room',
    admin: {admins: [rootId.userId]},
    getLocalUserIdentity: async () => subId
  })
  await certChecker.getAuthorityInfo()

  const validModCert = await signRoleCertInternal(
    rootId.sign,
    rootId.signPubJwk,
    subId.userId,
    'test-app',
    'test-room',
    ['moderator'],
    Date.now()
  )
  assert.equal(await certChecker.verifyAndApplyCert(validModCert), true)
  assert.deepEqual(certChecker.getPeerRoles(subId.userId), ['moderator'])

  const futureSubId = await createUserIdentity()
  const futureCert = await signRoleCertInternal(
    rootId.sign,
    rootId.signPubJwk,
    futureSubId.userId,
    'test-app',
    'test-room',
    ['moderator'],
    Date.now() + 3_600_000 // 1 hour in the future (> 60s skew allowance)
  )
  assert.equal(
    await certChecker.verifyAndApplyCert(futureCert),
    false,
    'certificate with far-future iat must be rejected'
  )

  const delegatedSubId = await createUserIdentity()
  const delegatedAdminCert = await signRoleCertInternal(
    rootId.sign,
    rootId.signPubJwk,
    delegatedSubId.userId,
    'test-app',
    'test-room',
    ['admin'],
    Date.now()
  )
  assert.equal(
    await certChecker.verifyAndApplyCert(delegatedAdminCert),
    false,
    "certificate granting reserved 'admin' role to non-root user must be rejected"
  )

  // 3. Multi-hop topology: room.getPeers() PeerInfo, role grant/revocation,
  //    offer-stage bulk rejection on role-protected actions, overlay packet anti-replay,
  //    and serialized concurrent state.set()
  //    Line topology: admin -- bob -- carol -- mallory
  const auditAdminIdentity = await createUserIdentity()
  const roomId = `audit-room~${auditAdminIdentity.userId}`
  const appId = 'audit-app'
  const adminId = testPeerId('audit-admin')
  const bobId = testPeerId('audit-bob')
  const carolId = testPeerId('audit-carol')
  const malloryId = testPeerId('audit-mallory')
  const peerIds = [adminId, bobId, carolId, malloryId]
  const regMap = new Map<string, (peer: PeerHandle, id: string) => void>()
  const rooms = new Map<string, Room & RolesPluginApi & ScalePluginApi>()

  for (const id of peerIds) {
    const peerIdentity =
      id === adminId ? auditAdminIdentity : await createUserIdentity()
    const room = createRoom(
      f => regMap.set(id, f),
      () => {},
      () => {},
      {
        endpointIdentity: getTestEndpointByPeerId(id),
        appId,
        roomId,
        use: [scale({maxDirectPeers: 4}), roles()],
        identity: peerIdentity
      }
    )
    rooms.set(id, room as unknown as Room & RolesPluginApi & ScalePluginApi)
  }

  const directHandles = new Map<string, LinkedPeer>()
  const connectDirect = (a: string, b: string) => {
    const {peerA, peerB} = linkPeers(new LinkedPeer(), new LinkedPeer())
    directHandles.set(`${a}->${b}`, peerA)
    directHandles.set(`${b}->${a}`, peerB)
    regMap.get(a)!(peerA as unknown as PeerHandle, b)
    regMap.get(b)!(peerB as unknown as PeerHandle, a)
  }

  try {
    connectDirect(adminId, bobId)
    connectDirect(bobId, carolId)
    connectDirect(carolId, malloryId)

    await waitFor(
      () =>
        peerIds.every(
          id =>
            rooms.get(id)!.getTopology().roomPeerIds.length ===
            peerIds.length - 1
        ),
      3_000
    )

    // Verify room.getPeers() returns PeerInfo with connection, direct, hops, and roles
    await waitFor(
      () => rooms.get(malloryId)!.getRoles(adminId).includes('admin'),
      2_000
    )
    const adminPeers = rooms.get(adminId)!.getPeers()
    assert.ok(adminPeers[bobId], 'direct neighbor bob must be in getPeers()')
    assert.equal(adminPeers[bobId]!.direct, true)
    assert.equal(adminPeers[bobId]!.hops, 1)
    assert.notEqual(adminPeers[bobId]!.connection, null)

    assert.ok(
      adminPeers[carolId],
      '2-hop virtual peer carol must be in getPeers()'
    )
    assert.equal(adminPeers[carolId]!.direct, false)
    assert.equal(adminPeers[carolId]!.hops, 2)
    assert.equal(adminPeers[carolId]!.connection, null)

    assert.ok(
      adminPeers[malloryId],
      '3-hop virtual peer mallory must be in getPeers()'
    )
    assert.equal(adminPeers[malloryId]!.direct, false)
    assert.equal(adminPeers[malloryId]!.hops, 3)
    assert.equal(adminPeers[malloryId]!.connection, null)

    const malloryPeers = rooms.get(malloryId)!.getPeers()
    assert.deepEqual(malloryPeers[adminId]?.roles, ['admin'])

    // Register a role-protected action 'mod-file' (requires 'moderator' or 'admin')
    const receivedModPayloads = new Map<string, Uint8Array[]>()
    const modSenders = new Map<string, MessageAction<Uint8Array>['send']>()
    for (const id of peerIds) {
      receivedModPayloads.set(id, [])
      const act = rooms.get(id)!.makeAction<Uint8Array>('mod-file', {
        roles: ['admin', 'moderator']
      })
      act.onMessage(data => {
        receivedModPayloads
          .get(id)!
          .push(
            data instanceof Uint8Array
              ? data
              : new Uint8Array(data as ArrayBuffer)
          )
      })
      modSenders.set(id, act.send)
    }

    // Grant 'moderator' to Bob and Carol
    await rooms.get(adminId)!.grantRole(bobId, 'moderator')
    await rooms.get(adminId)!.grantRole(carolId, 'moderator')
    await waitFor(
      () =>
        rooms.get(carolId)!.getRoles(bobId).includes('moderator') &&
        rooms.get(adminId)!.getRoles(carolId).includes('moderator') &&
        rooms.get(malloryId)!.getRoles(carolId).includes('moderator'),
      2_000
    )
    assert.deepEqual(rooms.get(adminId)!.getPeers()[carolId]?.roles, [
      'moderator'
    ])

    // Admin revokes Bob's and Carol's 'moderator' roles
    await rooms.get(adminId)!.revokeRole(bobId, 'moderator')
    await rooms.get(adminId)!.revokeRole(carolId, 'moderator')
    await waitFor(
      () =>
        !rooms.get(adminId)!.getRoles(bobId).includes('moderator') &&
        !rooms.get(adminId)!.getRoles(carolId).includes('moderator') &&
        !rooms.get(carolId)!.getRoles(carolId).includes('moderator'),
      2_000
    )
    assert.deepEqual(
      rooms.get(adminId)!.getPeers()[carolId]?.roles,
      [],
      'revoking role from carol must strip role across peers'
    )

    // Offer-stage bulk transfer rejection on role-protected action:
    // Mallory registers 'mod-bulk' without local authority config (simulating a modified client),
    // while Carol protects 'mod-bulk' with roles: ['admin', 'moderator'].
    // When Mallory sends a 64 KB multi-chunk payload to Carol, Carol rejects the offer at admission time!
    rooms
      .get(carolId)!
      .makeAction<Uint8Array>('mod-bulk', {
        roles: ['admin', 'moderator']
      })
      .onMessage(() =>
        assert.fail('unauthorized bulk transfer must be rejected at offer time')
      )
    const malloryBulk = rooms.get(malloryId)!.makeAction<Uint8Array>('mod-bulk')
    await assert.rejects(
      () => malloryBulk.send(new Uint8Array(64_000), {target: carolId}),
      {kind: 'rejected'}
    )

    // Also verify Carol's local send on 'mod-file' is blocked after revocation:
    await assert.rejects(
      () => modSenders.get(carolId)!(new Uint8Array([1, 2, 3])),
      /insufficient authority/
    )

    // Anti-replay enforcement on multi-hop overlay unicast packets:
    // Capture a signed+encrypted overlay unicast frame from admin -> bob destined for 2-hop carol,
    // then replay the exact wire frame on admin -> bob.
    const adminToBobPeer = directHandles.get(`${adminId}->${bobId}`)!
    const capturedUnicastFrames: Uint8Array[] = []
    const origSend = adminToBobPeer.sendData.bind(adminToBobPeer)
    adminToBobPeer.sendData = (data: Uint8Array) => {
      const unpacked = unpackOverlayFrame(data)
      if (
        unpacked?.[0] === overlayUnicastKind &&
        unpacked[2]['o'] === adminId &&
        unpacked[2]['d'] === carolId
      ) {
        capturedUnicastFrames.push(data.slice())
      }
      origSend(data)
    }
    await modSenders.get(adminId)!(new Uint8Array([42, 43]), {target: carolId})
    await waitFor(() => receivedModPayloads.get(carolId)!.length === 1, 1_000)
    assert.ok(capturedUnicastFrames.length >= 1)

    const bobDupsBefore = rooms.get(bobId)!.getTopology()
      .stats.duplicatesDropped
    origSend(capturedUnicastFrames[0]!)
    await wait(40)
    assert.equal(
      receivedModPayloads.get(carolId)!.length,
      1,
      'replayed overlay unicast packet must NOT be delivered a second time'
    )
    assert.equal(
      rooms.get(bobId)!.getTopology().stats.duplicatesDropped,
      bobDupsBefore + 1,
      'replayed overlay unicast packet must increment duplicatesDropped'
    )

    // Verify concurrent state.set(prev => ...) calls serialize cleanly without dropping updates
    const counterAdmin = rooms
      .get(adminId)!
      .makeState<{count: number; log: number[]}>('counter', {
        count: 0,
        log: []
      })
    const counterMallory = rooms
      .get(malloryId)!
      .makeState<{count: number; log: number[]}>('counter', {
        count: 0,
        log: []
      })

    await Promise.all([
      counterAdmin.set(prev => ({
        count: prev.count + 1,
        log: [...prev.log, 1]
      })),
      counterAdmin.set(prev => ({
        count: prev.count + 1,
        log: [...prev.log, 2]
      })),
      counterAdmin.set(prev => ({
        count: prev.count + 1,
        log: [...prev.log, 3]
      })),
      counterAdmin.set(prev => ({
        count: prev.count + 1,
        log: [...prev.log, 4]
      })),
      counterAdmin.set(prev => ({
        count: prev.count + 1,
        log: [...prev.log, 5]
      }))
    ])

    assert.equal(counterAdmin.get().count, 5)
    assert.deepEqual(counterAdmin.get().log, [1, 2, 3, 4, 5])
    assert.equal(typeof counterAdmin.getMeta()?.timestamp, 'number')

    await waitFor(() => counterMallory.get().count === 5, 2_000)
    assert.deepEqual(counterMallory.get().log, [1, 2, 3, 4, 5])
  } finally {
    await Promise.all(peerIds.map(id => rooms.get(id)!.leave()))
  }

  // 4. maxUsers admission limit is enforced with scale()
  const maxUIds = [
    testPeerId('maxu-1'),
    testPeerId('maxu-2'),
    testPeerId('maxu-3')
  ]
  const maxURegs = new Map<string, (peer: PeerHandle, id: string) => void>()
  const maxURooms = new Map<string, Room & ScalePluginApi>()
  for (const id of maxUIds) {
    const u = await createUserIdentity()
    maxURooms.set(
      id,
      createRoom(
        f => maxURegs.set(id, f),
        () => {},
        () => {},
        {
          endpointIdentity: getTestEndpointByPeerId(id),
          appId: 'maxu-app',
          roomId: 'maxu-room',
          maxUsers: 2,
          identity: u,
          use: [scale({maxDirectPeers: 4})]
        }
      ) as unknown as Room & ScalePluginApi
    )
  }
  try {
    const link12 = linkPeers(new LinkedPeer(), new LinkedPeer())
    maxURegs.get(maxUIds[0]!)!(
      link12.peerA as unknown as PeerHandle,
      maxUIds[1]!
    )
    maxURegs.get(maxUIds[1]!)!(
      link12.peerB as unknown as PeerHandle,
      maxUIds[0]!
    )
    await waitFor(
      () => Object.keys(maxURooms.get(maxUIds[0]!)!.getPeers()).length === 1,
      1_500
    )

    const link13 = linkPeers(new LinkedPeer(), new LinkedPeer())
    maxURegs.get(maxUIds[0]!)!(
      link13.peerA as unknown as PeerHandle,
      maxUIds[2]!
    )
    maxURegs.get(maxUIds[2]!)!(
      link13.peerB as unknown as PeerHandle,
      maxUIds[0]!
    )
    await wait(60)
    assert.equal(
      maxUIds[2]! in maxURooms.get(maxUIds[0]!)!.getPeers(),
      false,
      '3rd distinct user must be rejected when maxUsers === 2'
    )
  } finally {
    await Promise.all(maxUIds.map(id => maxURooms.get(id)!.leave()))
  }

  // 5. Plaintext unicast downgrade (missing iv) is rejected by overlay
  const ovAId = testPeerId('ov-a')
  const ovBId = testPeerId('ov-b')
  const ovA = createOverlayManager({
    selfId: ovAId,
    appId: 'unicast-app',
    roomId: 'unicast-room',
    config: {maxDirectPeers: 4},
    getLocalEndpointIdentity: () => getTestEndpointByPeerId(ovAId),
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () =>
      assert.fail('plaintext unicast must never be delivered')
  })
  const ovB = createOverlayManager({
    selfId: ovBId,
    appId: 'unicast-app',
    roomId: 'unicast-room',
    config: {maxDirectPeers: 4},
    getLocalEndpointIdentity: () => getTestEndpointByPeerId(ovBId),
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () =>
      assert.fail('plaintext unicast must never be delivered')
  })
  const idA = await ovA.getLocalCryptoIdentity()
  ovB.setPeerSignPublicKey(ovAId, idA.signPubKey)

  // Craft a signed unicast packet from ov-a to ov-b WITHOUT an 'iv' header field
  const rawPayload = encodeBytes('plaintext-attempt')
  const msgId = `${ovAId}:downgrade-1`
  const ts = Date.now()
  const canonical = canonicalUnicastHeader(
    ovAId,
    ovBId,
    msgId,
    '',
    1,
    ts,
    'unicast-app',
    'unicast-room'
  )
  const combined = buildOverlaySignedBytes(canonical, rawPayload)
  const sigBuf = await crypto.subtle.sign(
    {name: 'ECDSA', hash: 'SHA-256'},
    idA.signPrivateKey,
    combined as BufferSource
  )
  const sigB64 = toBase64Url(new Uint8Array(sigBuf))
  const downgradePacket = packOverlayBinary(
    overlayUnicastKind,
    6,
    {o: ovAId, d: ovBId, q: 1, m: msgId, t: ts, s: sigB64},
    rawPayload
  )
  const sigFailBefore = ovB.getSnapshot().stats.signatureFailures
  ovB.handleOverlayFrame(ovAId, downgradePacket.slice().buffer)
  await wait(40)
  assert.equal(
    ovB.getSnapshot().stats.signatureFailures,
    sigFailBefore + 1,
    'unicast packet missing iv must be rejected and increment signatureFailures'
  )
  ovA.destroy()
  ovB.destroy()

  // 6. inspectActionWireHeader parses v3 inline/offer frames cleanly and rejects v2
  const sampleMeta = encodeBytes(JSON.stringify({hello: 'world'}))
  const sampleFrame = new Uint8Array(36 + sampleMeta.byteLength + 4)
  sampleFrame[0] = actionWireVersion
  sampleFrame[1] = 0
  sampleFrame.set(encodeBytes('chat'), 2)
  new DataView(sampleFrame.buffer).setUint16(34, sampleMeta.byteLength)
  sampleFrame.set(sampleMeta, 36)
  const headerInfo = inspectActionWireHeader(sampleFrame)
  assert.deepEqual(headerInfo, {type: 'chat', metadata: {hello: 'world'}})

  const legacyV2Frame = sampleFrame.slice()
  legacyV2Frame[0] = 2
  assert.equal(inspectActionWireHeader(legacyV2Frame), null)
})
