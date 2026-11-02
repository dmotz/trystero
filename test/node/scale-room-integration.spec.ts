import assert from 'node:assert/strict'
import test from './test.ts'
import type {
  RolesPluginApi,
  Room,
  ScalePluginApi
} from '../../packages/core/src/index.ts'
import {
  computePayloadDigest,
  roles,
  signRoleCertificate,
  verifyRoleCertificateChain
} from '../../packages/core/src/authority.ts'
import {
  createUserIdentity,
  exportUserIdentity,
  importUserIdentity
} from '../../packages/core/src/identity.ts'
import {inspectActionWireHeader} from '../../packages/core/src/action-wire.ts'
import {
  buildOverlaySignedBytes,
  canonicalUnicastHeader,
  createOverlayManager,
  overlayUnicastKind,
  packOverlayBinary,
  scale
} from '../../packages/core/src/scale/index.ts'
import createRoom from '../../packages/core/src/room.ts'
import {encodeBytes} from '../../packages/core/src/utils.ts'
import {
  LinkedPeer,
  linkPeers,
  testPeerId,
  wait,
  waitFor
} from './peer-harness.ts'

void test('PeerInfo in room.getPeers(), UserIdentity userId reuse, cascading delegator revocation, anti-replay, offer-time role rejection, plaintext unicast rejection, and concurrent makeState serialization', async () => {
  // 1. UserIdentity deterministically preserves the same userId across export/import and room formatting
  const hostUser = await createUserIdentity()
  const reimportedHostUser = await importUserIdentity(
    exportUserIdentity(hostUser)
  )
  const otherUser = await createUserIdentity()
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

  // 2. Chunked computePayloadDigest (> 256 KiB) matches across Blob and Uint8Array without full-Blob copy
  const largeBytes = new Uint8Array(300_000)
  for (let i = 0; i < largeBytes.length; i++) {
    largeBytes[i] = (i * 31) & 0xff
  }
  const largeBlob = new Blob([largeBytes])
  const digestUint8 = await computePayloadDigest(largeBytes)
  const digestBlob = await computePayloadDigest(largeBlob)
  assert.equal(
    digestBlob,
    digestUint8,
    'chunked Blob digest must match Uint8Array digest for payloads > 256 KiB'
  )
  const digestUint8Meta = await computePayloadDigest(largeBytes, {tag: 'v1'})
  const digestBlobMeta = await computePayloadDigest(largeBlob, {tag: 'v1'})
  assert.equal(
    digestBlobMeta,
    digestUint8Meta,
    'chunked Blob digest with metadata must match Uint8Array digest with metadata'
  )
  assert.notEqual(digestUint8, digestUint8Meta)

  // 3. Future-iat RoleCertificate rejection in verifyRoleCertificateChain
  const rootId = await createUserIdentity()
  const subId = await createUserIdentity()
  const futureCert = await signRoleCertificate(rootId.sign, rootId.signPubJwk, {
    subUserId: subId.userId,
    appId: 'test-app',
    roomId: 'test-room',
    roles: ['moderator'],
    now: Date.now() + 3_600_000 // 1 hour in the future (> 60s skew allowance)
  })
  const futureRes = await verifyRoleCertificateChain(
    futureCert,
    'test-app',
    'test-room',
    new Set([rootId.userId])
  )
  assert.equal(
    futureRes.valid,
    false,
    'certificate with far-future iat must be rejected'
  )

  // 4. Multi-hop topology: room.getPeers() PeerInfo, cascading delegator revocation,
  //    offer-stage bulk rejection on role-protected actions, and serialized concurrent state.set()
  //    Line topology: admin -- bob -- carol -- mallory
  const auditAdminIdentity = await createUserIdentity()
  const roomId = `audit-room~${auditAdminIdentity.userId}`
  const appId = 'audit-app'
  const adminId = testPeerId('audit-admin')
  const bobId = testPeerId('audit-bob')
  const carolId = testPeerId('audit-carol')
  const malloryId = testPeerId('audit-mallory')
  const peerIds = [adminId, bobId, carolId, malloryId]
  const regMap = new Map<string, (peer: any, id: string) => void>()
  const rooms = new Map<string, Room & RolesPluginApi & ScalePluginApi>()

  for (const id of peerIds) {
    const peerIdentity =
      id === adminId ? auditAdminIdentity : await createUserIdentity()
    const room = createRoom(
      f => regMap.set(id, f),
      () => {},
      () => {},
      {
        selfId: id,
        appId,
        roomId,
        use: [scale({mode: 'gossip', maxConnections: 4}), roles()],
        identity: peerIdentity
      }
    )
    rooms.set(id, room as any)
  }

  const directHandles = new Map<string, LinkedPeer>()
  const connectDirect = (a: string, b: string) => {
    const {peerA, peerB} = linkPeers(new LinkedPeer(), new LinkedPeer())
    directHandles.set(`${a}->${b}`, peerA)
    directHandles.set(`${b}->${a}`, peerB)
    regMap.get(a)!(peerA, b)
    regMap.get(b)!(peerB, a)
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
    const modSenders = new Map<string, any>()
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

    // Also verify Carol's local send on 'mod-file' is blocked after cascading revocation:
    await assert.rejects(
      () => modSenders.get(carolId)(new Uint8Array([1, 2, 3])),
      /insufficient authority/
    )

    // Anti-replay enforcement on ActionAuthEnvelope:
    // Capture a valid targeted 'mod-file' action wire frame from admin -> bob, then replay the exact wire frame
    const adminToBobPeer = directHandles.get(`${adminId}->${bobId}`)!
    const capturedModFrames: Uint8Array[] = []
    const origSend = adminToBobPeer.sendData.bind(adminToBobPeer)
    adminToBobPeer.sendData = (data: Uint8Array) => {
      const h = inspectActionWireHeader(data)
      if (h?.type === 'mod-file') {
        capturedModFrames.push(data.slice())
      }
      origSend(data)
    }
    await modSenders.get(adminId)(new Uint8Array([42, 43]), {target: bobId})
    await waitFor(() => receivedModPayloads.get(bobId)!.length === 1, 1_000)
    assert.equal(capturedModFrames.length, 1)

    const bobSigFailBefore = rooms.get(bobId)!.getTopology()
      .stats.signatureFailures
    origSend(capturedModFrames[0]!)
    await wait(40)
    assert.equal(
      receivedModPayloads.get(bobId)!.length,
      1,
      'replayed ActionAuthEnvelope frame must NOT be delivered a second time'
    )
    assert.equal(
      rooms.get(bobId)!.getTopology().stats.signatureFailures,
      bobSigFailBefore + 1,
      'replayed ActionAuthEnvelope frame must increment signatureFailures'
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

  // 5. Plaintext unicast downgrade (missing iv) is rejected by overlay
  const ovAId = testPeerId('ov-a')
  const ovBId = testPeerId('ov-b')
  const ovA = createOverlayManager({
    selfId: ovAId,
    appId: 'unicast-app',
    roomId: 'unicast-room',
    topology: {mode: 'gossip', maxConnections: 4},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () =>
      assert.fail('plaintext unicast must never be delivered')
  })
  const ovB = createOverlayManager({
    selfId: ovBId,
    appId: 'unicast-app',
    roomId: 'unicast-room',
    topology: {mode: 'gossip', maxConnections: 4},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () =>
      assert.fail('plaintext unicast must never be delivered')
  })
  const idA = await ovA.getLocalCryptoIdentity()
  ovB.setPeerSignPublicKey(ovAId, idA.signPubJwk)

  // Craft a signed unicast packet from ov-a to ov-b WITHOUT an 'iv' header field
  const rawPayload = encodeBytes('plaintext-attempt')
  const msgId = `${ovAId}:downgrade-1`
  const canonical = canonicalUnicastHeader(
    ovAId,
    ovBId,
    msgId,
    '',
    1,
    'unicast-app',
    'unicast-room'
  )
  const combined = buildOverlaySignedBytes(canonical, rawPayload)
  const sigBuf = await crypto.subtle.sign(
    {name: 'ECDSA', hash: 'SHA-256'},
    idA.signPrivateKey,
    combined as BufferSource
  )
  const sigB64 = Buffer.from(sigBuf).toString('base64')
  const downgradePacket = packOverlayBinary(
    overlayUnicastKind,
    6,
    {o: ovAId, d: ovBId, q: 1, m: msgId, s: sigB64},
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

  // 6. inspectActionWireHeader parses v2 inline/offer frames cleanly
  const sampleMeta = encodeBytes(JSON.stringify({hello: 'world'}))
  const sampleFrame = new Uint8Array(36 + sampleMeta.byteLength + 4)
  sampleFrame[0] = 2
  sampleFrame[1] = 0
  sampleFrame.set(encodeBytes('chat'), 2)
  new DataView(sampleFrame.buffer).setUint16(34, sampleMeta.byteLength)
  sampleFrame.set(sampleMeta, 36)
  const headerInfo = inspectActionWireHeader(sampleFrame)
  assert.deepEqual(headerInfo, {type: 'chat', metadata: {hello: 'world'}})
})
