import assert from 'node:assert/strict'
import test from './test.ts'
import {createRoomAuthority, roles} from '../../packages/core/src/authority.ts'
import {
  ecdsaKeyAlgo,
  ecdsaSign,
  isLowSP256Signature
} from '../../packages/core/src/crypto.ts'
import {
  createUserIdentity,
  jwkToCompactPub,
  verifyWithP256
} from '../../packages/core/src/identity.ts'
import createRoom from '../../packages/core/src/room.ts'
import {roleCertPayload} from '../../packages/core/src/signed-record.ts'
import type {PeerHandle} from '../../packages/core/src/internal-types.ts'
import type {
  JsonValue,
  RoleCertificate,
  RoomError,
  UserIdentity
} from '../../packages/core/src/types.ts'
import {
  encodeBytes,
  fromBase64Url,
  toBase64Url
} from '../../packages/core/src/utils.ts'
import {
  createLinkedHandlePair,
  makeTestPluginSlot,
  testEndpoint,
  testPeerId,
  wait,
  waitFor
} from './peer-harness.ts'

const p256N =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n

const ecdsaSignAlgo: EcdsaParams = {
  name: 'ECDSA',
  hash: 'SHA-256'
}

const toHighSSignatureB64 = (sigB64: string): string => {
  const rawBytes = fromBase64Url(sigB64)
  let s = 0n
  for (let i = 32; i < 64; i++) {
    s = (s << 8n) | BigInt(rawBytes[i]!)
  }
  let highS = p256N - s
  const highBytes = rawBytes.slice()
  for (let i = 63; i >= 32; i--) {
    highBytes[i] = Number(highS & 0xffn)
    highS >>= 8n
  }
  return toBase64Url(highBytes)
}

void test('S2: non-root moderator or co-root admin cannot demote root admin via cert replacement, revocation, or ban', async () => {
  const [rootUser, coRootUser, modUser, guestUser] = await Promise.all([
    createUserIdentity(),
    createUserIdentity(),
    createUserIdentity(),
    createUserIdentity()
  ])
  const rootPeerId = testPeerId('s2-root-ep')
  const coRootPeerId = testPeerId('s2-coroot-ep')
  const modPeerId = testPeerId('s2-mod-ep')
  const guestPeerId = testPeerId('s2-guest-ep')
  const s2RoomId = `s2-room~${rootUser.userId}`

  const rootAuth = createRoomAuthority({
    selfId: rootPeerId,
    appId: 's2-app',
    initialRoomId: s2RoomId,
    admin: {selfAsAdmin: true, admins: [coRootUser.userId]},
    getLocalUserIdentity: async () => rootUser
  })
  const coRootAuth = createRoomAuthority({
    selfId: coRootPeerId,
    appId: 's2-app',
    initialRoomId: s2RoomId,
    admin: {admins: [coRootUser.userId]},
    getLocalUserIdentity: async () => coRootUser
  })
  const modAuth = createRoomAuthority({
    selfId: modPeerId,
    appId: 's2-app',
    initialRoomId: s2RoomId,
    admin: {admins: [coRootUser.userId]},
    getLocalUserIdentity: async () => modUser
  })
  const guestAuth = createRoomAuthority({
    selfId: guestPeerId,
    appId: 's2-app',
    initialRoomId: s2RoomId,
    admin: {admins: [coRootUser.userId]},
    getLocalUserIdentity: async () => guestUser
  })
  await Promise.all([
    rootAuth.getAuthorityInfo(),
    coRootAuth.getAuthorityInfo(),
    modAuth.getAuthorityInfo(),
    guestAuth.getAuthorityInfo()
  ])

  // Root grants 'moderator' to modUser ('admin' is reserved exclusively for root admins)
  await assert.rejects(
    () => rootAuth.issueRoleCertificate(modUser.userId, ['admin', 'moderator']),
    /'admin' role is reserved for room root admins/
  )
  const modCert = await rootAuth.issueRoleCertificate(modUser.userId, [
    'moderator'
  ])
  assert.equal(await modAuth.verifyAndApplyCert(modCert), true)
  assert.equal(await guestAuth.verifyAndApplyCert(modCert), true)

  // Non-root moderator cannot issue certificates, revocations, bans, or unbans
  await assert.rejects(
    () => modAuth.issueRoleCertificate(guestUser.userId, ['dj']),
    /insufficient authority/i
  )
  await assert.rejects(
    () => modAuth.issueRoleRevocation(rootUser.userId, 'admin'),
    /insufficient authority/i
  )
  await assert.rejects(
    () => modAuth.issuePeerModeration('ban', rootUser.userId),
    /insufficient authority/i
  )
  await assert.rejects(
    () => modAuth.issuePeerModeration('unban', rootUser.userId),
    /insufficient authority/i
  )

  // Co-root admin cannot revoke 'admin' / '*' on rootUser or ban/unban rootUser
  await assert.rejects(
    () => coRootAuth.issueRoleRevocation(rootUser.userId, 'admin'),
    /cannot revoke a root admin/i
  )
  await assert.rejects(
    () => coRootAuth.issueRoleRevocation(rootUser.userId),
    /cannot revoke a root admin/i
  )
  await assert.rejects(
    () => coRootAuth.issuePeerModeration('ban', rootUser.userId),
    /cannot ban a root admin/i
  )
  await assert.rejects(
    () => coRootAuth.issuePeerModeration('unban', rootUser.userId),
    /cannot unban a root admin/i
  )

  // Forged RoleCertificate signed by co-root targeting rootUser WITHOUT 'admin' role (attempting demotion) is rejected
  const demotionUnsigned: Omit<RoleCertificate, 'sig'> = {
    v: 1,
    certId: 'forged-demotion-cert-1234',
    issuerPubKey: jwkToCompactPub(coRootUser.signPubJwk),
    subUserId: rootUser.userId,
    appId: 's2-app',
    roomId: s2RoomId,
    roles: ['dj'],
    seq: 1,
    iat: Date.now() + 5_000
  }
  const demotionSig = toBase64Url(
    await coRootUser.sign(encodeBytes(roleCertPayload(demotionUnsigned)))
  )
  const demotionCert: RoleCertificate = {...demotionUnsigned, sig: demotionSig}
  assert.equal(await guestAuth.verifyAndApplyCert(demotionCert), false)
  assert.equal(await rootAuth.verifyAndApplyCert(demotionCert), false)

  // Forged RoleCertificate signed by non-root modUser is also rejected
  const modForgedUnsigned: Omit<RoleCertificate, 'sig'> = {
    v: 1,
    certId: 'forged-mod-cert-5678',
    issuerPubKey: jwkToCompactPub(modUser.signPubJwk),
    subUserId: guestUser.userId,
    appId: 's2-app',
    roomId: s2RoomId,
    roles: ['dj'],
    seq: 1,
    iat: Date.now() + 5_000
  }
  const modForgedCert: RoleCertificate = {
    ...modForgedUnsigned,
    sig: toBase64Url(
      await modUser.sign(encodeBytes(roleCertPayload(modForgedUnsigned)))
    )
  }
  assert.equal(await guestAuth.verifyAndApplyCert(modForgedCert), false)
  assert.equal(rootAuth.getPeerRoles(rootPeerId).includes('admin'), true)
})

void test('S11: multi-tab root admin and multi-tab moderator operate across tabs with zero signature failures', async () => {
  const [rootUser, modUser, targetUser] = await Promise.all([
    createUserIdentity(),
    createUserIdentity(),
    createUserIdentity()
  ])
  const rootTab1Peer = testPeerId('s11-root-tab-1')
  const rootTab2Peer = testPeerId('s11-root-tab-2')
  const modTab1Peer = testPeerId('s11-mod-tab-1')
  const modTab2Peer = testPeerId('s11-mod-tab-2')
  const observerPeer = testPeerId('s11-observer-1')
  const s11RoomId = `s11-room~${rootUser.userId}`

  const peerUsers: Record<string, string> = {
    [rootTab1Peer]: rootUser.userId,
    [rootTab2Peer]: rootUser.userId,
    [modTab1Peer]: modUser.userId,
    [modTab2Peer]: modUser.userId,
    [observerPeer]: targetUser.userId
  }

  let sigFailures = 0
  const mkAuth = (selfId: string, user: UserIdentity, selfAsAdmin = false) =>
    createRoomAuthority({
      selfId,
      appId: 's11-app',
      initialRoomId: s11RoomId,
      admin: selfAsAdmin ? {selfAsAdmin: true} : {},
      getLocalUserIdentity: async () => user,
      getKnownPeerUserId: pid => peerUsers[pid],
      onSignatureFailure: () => {
        sigFailures++
      }
    })

  const rootTab1 = mkAuth(rootTab1Peer, rootUser, true)
  const rootTab2 = mkAuth(rootTab2Peer, rootUser, true)
  const modTab1 = mkAuth(modTab1Peer, modUser)
  const modTab2 = mkAuth(modTab2Peer, modUser)
  const observer = mkAuth(observerPeer, targetUser)
  await Promise.all([
    rootTab1.getAuthorityInfo(),
    rootTab2.getAuthorityInfo(),
    modTab1.getAuthorityInfo(),
    modTab2.getAuthorityInfo(),
    observer.getAuthorityInfo()
  ])

  // Root Tab 2 grants 'moderator' to modUser; both moderator tabs can authorize role-gated actions
  const modCert = await rootTab2.issueRoleCertificate(modUser.userId, [
    'moderator'
  ])
  assert.equal(await modTab1.verifyAndApplyCert(modCert), true)
  assert.equal(await modTab2.verifyAndApplyCert(modCert), true)
  assert.equal(await observer.verifyAndApplyCert(modCert), true)
  assert.equal(observer.authorizePeerAction(modTab1Peer, ['moderator']), true)
  assert.equal(observer.authorizePeerAction(modTab2Peer, ['moderator']), true)

  // Root Tab 2 bans targetUser; Root Tab 1 unbans targetUser; observer converges cleanly with 0 sig failures
  const banRec = await rootTab2.issuePeerModeration('ban', targetUser.userId, {
    reason: 'test'
  })
  assert.equal(await rootTab1.verifyAndApplyModeration(banRec), true)
  assert.equal(await observer.verifyAndApplyModeration(banRec), true)
  assert.equal(observer.isPeerBanned(targetUser.userId), true)

  const unbanRec = await rootTab1.issuePeerModeration(
    'unban',
    targetUser.userId
  )
  assert.equal(await observer.verifyAndApplyModeration(unbanRec), true)
  assert.equal(observer.isPeerBanned(targetUser.userId), false)
  assert.equal(sigFailures, 0)
})

void test('S12: concurrent conflicting moderations and revocations between two root admins converge regardless of arrival order', async () => {
  const [rootA, rootB, target1, target2, observer1User, observer2User] =
    await Promise.all([
      createUserIdentity(),
      createUserIdentity(),
      createUserIdentity(),
      createUserIdentity(),
      createUserIdentity(),
      createUserIdentity()
    ])
  const s12RoomId = `s12-room~${rootA.userId}`

  const mk = (label: string, user: UserIdentity) =>
    createRoomAuthority({
      selfId: testPeerId(label),
      appId: 's12-app',
      initialRoomId: s12RoomId,
      admin: {admins: [rootA.userId, rootB.userId]},
      getLocalUserIdentity: async () => user
    })

  const authA = mk('s12-root-a', rootA)
  const authB = mk('s12-root-b', rootB)
  const obs1 = mk('s12-obs-1', observer1User)
  const obs2 = mk('s12-obs-2', observer2User)
  await Promise.all([
    authA.getAuthorityInfo(),
    authB.getAuthorityInfo(),
    obs1.getAuthorityInfo(),
    obs2.getAuthorityInfo()
  ])

  const certT1 = await authA.issueRoleCertificate(target1.userId, [
    'dj',
    'speaker'
  ])
  const certT2 = await authB.issueRoleCertificate(target2.userId, [
    'dj',
    'speaker'
  ])
  for (const node of [authA, authB, obs1, obs2]) {
    await node.verifyAndApplyCert(certT1)
    await node.verifyAndApplyCert(certT2)
  }

  // Conflicting moderations on target1 (ban first, then unban) and target2 (unban first, then ban), plus revocations
  const banT1 = await authA.issuePeerModeration('ban', target1.userId, {
    reason: 'early-ban'
  })
  const unbanT2 = await authB.issuePeerModeration('unban', target2.userId)
  const revDjT1 = await authA.issueRoleRevocation(target1.userId, 'dj')
  await wait(5)
  const unbanT1 = await authB.issuePeerModeration('unban', target1.userId)
  const banT2 = await authA.issuePeerModeration('ban', target2.userId, {
    reason: 'late-ban'
  })
  const revSpeakerT1 = await authB.issueRoleRevocation(
    target1.userId,
    'speaker'
  )

  // Observer 1 receives in causal order; Observer 2 receives in reverse causal order!
  await obs1.verifyAndApplyModeration(banT1)
  await obs1.verifyAndApplyModeration(unbanT1)
  await obs1.verifyAndApplyModeration(unbanT2)
  await obs1.verifyAndApplyModeration(banT2)
  await obs1.verifyAndApplyRevocation(revDjT1)
  await obs1.verifyAndApplyRevocation(revSpeakerT1)

  await obs2.verifyAndApplyModeration(unbanT1)
  await obs2.verifyAndApplyModeration(banT1)
  await obs2.verifyAndApplyModeration(banT2)
  await obs2.verifyAndApplyModeration(unbanT2)
  await obs2.verifyAndApplyRevocation(revSpeakerT1)
  await obs2.verifyAndApplyRevocation(revDjT1)

  assert.equal(
    obs1.isPeerBanned(target1.userId),
    obs2.isPeerBanned(target1.userId)
  )
  assert.equal(
    obs1.isPeerBanned(target2.userId),
    obs2.isPeerBanned(target2.userId)
  )
  assert.equal(obs1.isPeerBanned(target1.userId), false)
  assert.equal(obs1.isPeerBanned(target2.userId), true)
  assert.equal(obs1.getBanReason(target2.userId), 'late-ban')
  assert.equal(obs2.getBanReason(target2.userId), 'late-ban')
  assert.deepEqual(
    obs1.getPeerRoles(target1.userId),
    obs2.getPeerRoles(target1.userId)
  )
  assert.deepEqual(obs1.getPeerRoles(target1.userId), [])
})

void test('S13: garbage sync flood kicks abusive peer after <= 8 failures and role-gated actions perform zero per-message signature verifies once cert is synced', async () => {
  const [adminUser, attackerUser, modUser, receiverUser] = await Promise.all([
    createUserIdentity(),
    createUserIdentity(),
    createUserIdentity(),
    createUserIdentity()
  ])
  const hostEp = testEndpoint('s13-host-ep')
  const atkEp = testEndpoint('s13-atk-ep')

  let hostReg: ((p: PeerHandle, id: string) => void) | null = null
  let atkReg: ((p: PeerHandle, id: string) => void) | null = null
  const hostErrors: RoomError[] = []

  const hostRoom = createRoom(
    f => {
      hostReg = f
    },
    () => {},
    () => {},
    {
      endpointIdentity: hostEp,
      appId: 's13-app',
      roomId: 's13-fixed-room',
      identity: adminUser,
      use: [roles({admins: [adminUser.userId]})]
    }
  )
  hostRoom.onError(err => hostErrors.push(err))

  let sendAuth: ((data: JsonValue) => Promise<void>) | null = null
  const rawAuthProbe = makeTestPluginSlot('roles', kernel => {
    sendAuth = kernel.makeInternalAction<JsonValue>('auth').send
    return {}
  })
  const atkRoom = createRoom(
    f => {
      atkReg = f
    },
    () => {},
    () => {},
    {
      endpointIdentity: atkEp,
      appId: 's13-app',
      roomId: 's13-fixed-room',
      identity: attackerUser,
      use: [rawAuthProbe]
    }
  )

  try {
    const {peerA, peerB} = createLinkedHandlePair()
    hostReg!(peerA, atkEp.peerId)
    atkReg!(peerB, hostEp.peerId)
    await waitFor(() => atkEp.peerId in hostRoom.getPeers(), 2_000)

    // Flood 50 garbage certs from atkRoom over internal 'auth' action -> kicked after <= 8 failures
    const garbageCerts = Array.from({length: 50}, (_, i) => ({
      v: 1,
      certId: `bad-${i}`,
      issuerPubKey: jwkToCompactPub(adminUser.signPubJwk),
      subUserId: attackerUser.userId,
      appId: 'wrong-app',
      roomId: 's13-fixed-room',
      roles: ['moderator'],
      seq: i + 1,
      iat: Date.now(),
      sig: 'A'.repeat(86)
    }))
    await sendAuth!({
      t: 'sync',
      certs: garbageCerts
    } as unknown as JsonValue).catch(() => {})

    await waitFor(() => !(atkEp.peerId in hostRoom.getPeers()), 2_000)
    assert.equal(atkEp.peerId in hostRoom.getPeers(), false)
    assert.equal(
      hostErrors.some(
        e =>
          e.code === 'peer-error' &&
          /excessive invalid authority records/.test(e.message)
      ),
      true
    )

    // Verify chunked (40 KiB) + inline role-gated actions do zero per-message ECDSA verifies once RoleCertificate is synced
    const adminEp = testEndpoint('s13-admin-ep')
    const senderEp = testEndpoint('s13-sender-ep')
    const recvEp = testEndpoint('s13-recv-ep')
    const s13RoomId = `s13-room~${adminUser.userId}`

    let adminReg: ((p: PeerHandle, id: string) => void) | null = null
    let senderReg: ((p: PeerHandle, id: string) => void) | null = null
    let recvReg: ((p: PeerHandle, id: string) => void) | null = null

    const adminRoom = createRoom(
      f => {
        adminReg = f
      },
      () => {},
      () => {},
      {
        endpointIdentity: adminEp,
        appId: 's13-app',
        roomId: s13RoomId,
        identity: adminUser,
        use: [roles({selfAsAdmin: true})]
      }
    )
    const senderRoom = createRoom(
      f => {
        senderReg = f
      },
      () => {},
      () => {},
      {
        endpointIdentity: senderEp,
        appId: 's13-app',
        roomId: s13RoomId,
        identity: modUser,
        use: [roles()]
      }
    )
    const receiverRoom = createRoom(
      f => {
        recvReg = f
      },
      () => {},
      () => {},
      {
        endpointIdentity: recvEp,
        appId: 's13-app',
        roomId: s13RoomId,
        identity: receiverUser,
        use: [roles()]
      }
    )

    const senderBig = senderRoom.makeAction<Uint8Array>('big-act', {
      roles: ['moderator']
    })
    const receivedByteLengths: number[] = []
    const recvBig = receiverRoom.makeAction<Uint8Array>('big-act', {
      roles: ['moderator']
    })
    recvBig.onMessage(data => {
      receivedByteLengths.push(data.byteLength)
    })

    // Connect admin <-> sender, admin <-> receiver, and sender <-> receiver
    const linkAdminSender = createLinkedHandlePair()
    adminReg!(linkAdminSender.peerA, senderEp.peerId)
    senderReg!(linkAdminSender.peerB, adminEp.peerId)

    const linkAdminRecv = createLinkedHandlePair()
    adminReg!(linkAdminRecv.peerA, recvEp.peerId)
    recvReg!(linkAdminRecv.peerB, adminEp.peerId)

    const linkSenderRecv = createLinkedHandlePair()
    senderReg!(linkSenderRecv.peerA, recvEp.peerId)
    recvReg!(linkSenderRecv.peerB, senderEp.peerId)

    await waitFor(
      () =>
        senderEp.peerId in adminRoom.getPeers() &&
        recvEp.peerId in adminRoom.getPeers() &&
        recvEp.peerId in senderRoom.getPeers(),
      2_000
    )

    await adminRoom.grantRole(modUser.userId, 'moderator')
    await waitFor(
      () =>
        senderRoom.getRoles(modUser.userId).includes('moderator') &&
        receiverRoom.getRoles(modUser.userId).includes('moderator'),
      2_000
    )

    const origVerify = crypto.subtle.verify.bind(crypto.subtle)
    let verifyCount = 0
    crypto.subtle.verify = (async (...args: Parameters<typeof origVerify>) => {
      verifyCount++
      return origVerify(...args)
    }) as typeof crypto.subtle.verify

    try {
      const payload = new Uint8Array(40 * 1024).fill(7)
      await senderBig.send(payload, {target: recvEp.peerId})
      await senderBig.send(new Uint8Array([1, 2, 3]), {target: recvEp.peerId})
      await senderBig.send(new Uint8Array([4, 5, 6, 7]), {
        target: recvEp.peerId
      })
      await waitFor(() => receivedByteLengths.length === 3, 2_000)
      assert.deepEqual(receivedByteLengths, [40 * 1024, 3, 4])
      assert.equal(
        verifyCount,
        0,
        `expected 0 per-message WebCrypto verify calls once RoleCertificate is synced, got ${verifyCount}`
      )
    } finally {
      crypto.subtle.verify = origVerify
      await Promise.all([
        adminRoom.leave(),
        senderRoom.leave(),
        receiverRoom.leave()
      ])
    }
  } finally {
    await Promise.all([hostRoom.leave(), atkRoom.leave()])
  }
})

void test('S17: high-S P-256 signatures are rejected and revocation/moderation dedupe is immune to signature malleability', async () => {
  const kp = await crypto.subtle.generateKey(ecdsaKeyAlgo, true, [
    'sign',
    'verify'
  ])
  const pubJwk = await crypto.subtle.exportKey('jwk', kp.publicKey)
  const msg = encodeBytes('malleability-check')

  const lowSig = await ecdsaSign(kp.privateKey, msg as BufferSource)
  assert.equal(isLowSP256Signature(lowSig), true)
  assert.equal(await verifyWithP256(lowSig, msg, pubJwk), true)

  // Construct malleable high-S twin (r, n - s), which raw WebCrypto accepts but verifyWithP256 must reject
  let s = 0n
  for (let i = 32; i < 64; i++) {
    s = (s << 8n) | BigInt(lowSig[i]!)
  }
  let highS = p256N - s
  const highSig = lowSig.slice()
  for (let i = 63; i >= 32; i--) {
    highSig[i] = Number(highS & 0xffn)
    highS >>= 8n
  }
  assert.equal(isLowSP256Signature(highSig), false)
  assert.equal(
    await crypto.subtle.verify(
      ecdsaSignAlgo,
      kp.publicKey,
      highSig as BufferSource,
      msg as BufferSource
    ),
    true
  )
  assert.equal(await verifyWithP256(highSig, msg, pubJwk), false)

  // Verify RoleRevocationRecord and PeerModerationRecord reject high-S signatures and deduplicate cleanly
  const [rootUser, targetUser] = await Promise.all([
    createUserIdentity(),
    createUserIdentity()
  ])
  const s17RoomId = `s17-room~${rootUser.userId}`
  const issuerAuth = createRoomAuthority({
    selfId: testPeerId('s17-root'),
    appId: 's17-app',
    initialRoomId: s17RoomId,
    admin: {selfAsAdmin: true},
    getLocalUserIdentity: async () => rootUser
  })
  const observerAuth = createRoomAuthority({
    selfId: testPeerId('s17-observer'),
    appId: 's17-app',
    initialRoomId: s17RoomId,
    admin: {}
  })
  await Promise.all([
    issuerAuth.getAuthorityInfo(),
    observerAuth.getAuthorityInfo()
  ])

  const rev = await issuerAuth.issueRoleRevocation(targetUser.userId, 'dj')
  const malleableRev = {...rev, sig: toHighSSignatureB64(rev.sig)}

  assert.equal(await observerAuth.verifyAndApplyRevocation(malleableRev), false)
  assert.equal(await observerAuth.verifyAndApplyRevocation(rev), true)
  assert.equal(await observerAuth.verifyAndApplyRevocation(rev), false)
  assert.equal(await observerAuth.verifyAndApplyRevocation(malleableRev), false)

  const mod = await issuerAuth.issuePeerModeration('ban', targetUser.userId, {
    reason: 'malleability-test'
  })
  const malleableMod = {...mod, sig: toHighSSignatureB64(mod.sig)}

  assert.equal(await observerAuth.verifyAndApplyModeration(malleableMod), false)
  assert.equal(await observerAuth.verifyAndApplyModeration(mod), true)
  assert.equal(await observerAuth.verifyAndApplyModeration(mod), false)
  assert.equal(await observerAuth.verifyAndApplyModeration(malleableMod), false)
})
