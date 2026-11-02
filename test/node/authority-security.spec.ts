import assert from 'node:assert/strict'
import test from './test.ts'
import {
  createRoomAuthority,
  roles,
  signRoleRevocation,
  verifyRoleRevocation
} from '../../packages/core/src/authority.ts'
import {
  ecdsaKeyAlgo,
  ecdsaSign,
  ecdsaSignAlgo,
  isLowSP256Signature,
  p256N
} from '../../packages/core/src/crypto.ts'
import {createIdentityHandshake} from '../../packages/core/src/handshake.ts'
import {
  createUserIdentity,
  fromBase64Url,
  getDefaultEndpointIdentity,
  toBase64Url,
  verifyWithP256
} from '../../packages/core/src/identity.ts'
import createRoom, {
  getRoomSignalingBridge
} from '../../packages/core/src/room.ts'
import type {
  JsonValue,
  PeerHandle,
  RoleCertificate,
  Room
} from '../../packages/core/src/types.ts'
import {
  definePlugin,
  encodeBytes,
  toJson
} from '../../packages/core/src/utils.ts'
import {linkHandles} from './overlay-harness.ts'
import {wait, waitFor} from './peer-harness.ts'

void test('S2: delegated or co-admin cannot demote root admin via cert replacement, revocation, or ban', async () => {
  const rootUser = await createUserIdentity()
  const modUser = await createUserIdentity()
  const s2RoomId = `s2-room~${rootUser.userId}`

  const rootAuth = createRoomAuthority({
    selfId: 'root-ep',
    appId: 's2-app',
    initialRoomId: s2RoomId,
    admin: {selfAsAdmin: true},
    getLocalUserIdentity: async () => rootUser
  })
  const modAuth = createRoomAuthority({
    selfId: 'mod-ep',
    appId: 's2-app',
    initialRoomId: s2RoomId,
    admin: {},
    getLocalUserIdentity: async () => modUser
  })
  const guestUser = await createUserIdentity()
  const guestAuth = createRoomAuthority({
    selfId: 'guest-ep',
    appId: 's2-app',
    initialRoomId: s2RoomId,
    admin: {},
    getLocalUserIdentity: async () => guestUser
  })
  await Promise.all([
    rootAuth.getAuthorityInfo(),
    modAuth.getAuthorityInfo(),
    guestAuth.getAuthorityInfo()
  ])

  // Root grants moderator + admin roles to modUser
  const modCert = await rootAuth.issueRoleCertificate(modUser.userId, [
    'admin',
    'moderator'
  ])
  assert.equal(await modAuth.verifyAndApplyCert(modCert), true)
  assert.equal(await guestAuth.verifyAndApplyCert(modCert), true)

  // Delegated admin cannot issue certificates at all, nor demote root
  await assert.rejects(
    () => modAuth.issueRoleCertificate(rootUser.userId, ['dj']),
    /insufficient authority/i
  )
  await assert.rejects(
    () => modAuth.issueRoleRevocation(rootUser.userId, 'admin'),
    /cannot revoke a root admin/i
  )
  await assert.rejects(
    () => modAuth.issuePeerBan(rootUser.userId),
    /cannot ban a root admin/i
  )

  // Even a forged RoleCertificate signed by modUser targeting rootUser with newer iat is rejected
  const forgedPayload = toJson([
    'trystero:auth:v1',
    'role-cert',
    1,
    'forged-cert-id-123456',
    's2-app',
    s2RoomId,
    rootUser.userId,
    modUser.userId,
    ['dj'],
    Date.now() + 5_000
  ])
  const forgedSig = toBase64Url(await modUser.sign(encodeBytes(forgedPayload)))
  const forgedCert = {
    v: 1 as const,
    certId: 'forged-cert-id-123456',
    appId: 's2-app',
    roomId: s2RoomId,
    subUserId: rootUser.userId,
    issUserId: modUser.userId,
    issPubKey: modUser.signPubJwk,
    roles: ['dj'],
    iat: Date.now() + 5_000,
    sig: forgedSig
  } as unknown as RoleCertificate
  assert.equal(await guestAuth.verifyAndApplyCert(forgedCert), false)
  assert.equal(await rootAuth.verifyAndApplyCert(forgedCert), false)
  assert.equal(rootAuth.getPeerRoles('root-ep').includes('admin'), true)
})

void test('S11: multi-tab admin and multi-tab delegated moderator operate across tabs with zero signature failures', async () => {
  const rootUser = await createUserIdentity()
  const modUser = await createUserIdentity()
  const targetUser = await createUserIdentity()
  const s11RoomId = `s11-room~${rootUser.userId}`

  let sigFailures = 0
  const mkAuth = (
    selfId: string,
    user: Awaited<ReturnType<typeof createUserIdentity>>,
    selfAsAdmin = false
  ) =>
    createRoomAuthority({
      selfId,
      appId: 's11-app',
      initialRoomId: s11RoomId,
      admin: selfAsAdmin ? {selfAsAdmin: true} : {},
      getLocalUserIdentity: async () => user,
      onSignatureFailure: () => {
        sigFailures++
      }
    })

  const rootTab1 = mkAuth('root-tab-1', rootUser, true)
  const rootTab2 = mkAuth('root-tab-2', rootUser, true)
  const modTab1 = mkAuth('mod-tab-1', modUser)
  const modTab2 = mkAuth('mod-tab-2', modUser)
  const observer = mkAuth('observer-1', targetUser)
  await Promise.all([
    rootTab1.getAuthorityInfo(),
    rootTab2.getAuthorityInfo(),
    modTab1.getAuthorityInfo(),
    modTab2.getAuthorityInfo(),
    observer.getAuthorityInfo()
  ])

  // Root Tab 2 grants 'admin' to modUser; Mod Tab 1 receives cert, Mod Tab 2 receives cert and issues ban
  const modCert = await rootTab2.issueRoleCertificate(modUser.userId, ['admin'])
  assert.equal(await modTab1.verifyAndApplyCert(modCert), true)
  assert.equal(await modTab2.verifyAndApplyCert(modCert), true)
  assert.equal(await observer.verifyAndApplyCert(modCert), true)

  const banRec = await modTab2.issuePeerBan(targetUser.userId, {reason: 'test'})
  assert.equal(await observer.verifyAndApplyBan(banRec), true)
  assert.equal(observer.isPeerBanned(targetUser.userId), true)
  assert.equal(sigFailures, 0)
})

void test('S12: concurrent mutual bans/revocations between two delegated admins converge regardless of arrival order', async () => {
  const rootUser = await createUserIdentity()
  const adminA = await createUserIdentity()
  const adminB = await createUserIdentity()
  const observer1User = await createUserIdentity()
  const observer2User = await createUserIdentity()
  const s12RoomId = `s12-room~${rootUser.userId}`

  const mk = (
    selfId: string,
    user: Awaited<ReturnType<typeof createUserIdentity>>,
    selfAsAdmin = false
  ) =>
    createRoomAuthority({
      selfId,
      appId: 's12-app',
      initialRoomId: s12RoomId,
      admin: selfAsAdmin ? {selfAsAdmin: true} : {},
      getLocalUserIdentity: async () => user
    })

  const root = mk('root-ep', rootUser, true)
  const authA = mk('admin-a', adminA)
  const authB = mk('admin-b', adminB)
  const obs1 = mk('obs-1', observer1User)
  const obs2 = mk('obs-2', observer2User)
  await Promise.all([
    root.getAuthorityInfo(),
    authA.getAuthorityInfo(),
    authB.getAuthorityInfo(),
    obs1.getAuthorityInfo(),
    obs2.getAuthorityInfo()
  ])

  const certA = await root.issueRoleCertificate(adminA.userId, ['admin'])
  const certB = await root.issueRoleCertificate(adminB.userId, ['admin'])
  for (const node of [authA, authB, obs1, obs2]) {
    await node.verifyAndApplyCert(certA)
    await node.verifyAndApplyCert(certB)
  }

  // Admin A bans Admin B first (earlier timestamp), Admin B concurrently bans Admin A (later timestamp)
  const banB = await authA.issuePeerBan(adminB.userId, {reason: 'first'})
  await wait(5)
  const banA = await authB.issuePeerBan(adminA.userId, {reason: 'second'})

  // Observer 1 sees (banB, then banA); Observer 2 sees (banA, then banB)!
  await obs1.verifyAndApplyBan(banB)
  await obs1.verifyAndApplyBan(banA)

  await obs2.verifyAndApplyBan(banA)
  await obs2.verifyAndApplyBan(banB)

  assert.equal(
    obs1.isPeerBanned(adminA.userId),
    obs2.isPeerBanned(adminA.userId)
  )
  assert.equal(
    obs1.isPeerBanned(adminB.userId),
    obs2.isPeerBanned(adminB.userId)
  )
  assert.equal(obs1.isPeerBanned(adminB.userId), true)
  assert.equal(obs1.isPeerBanned(adminA.userId), false)
})

void test('S13: garbage sync flood kicks abusive peer after <= 8 failures and chunked role-gated actions verify signature once', async () => {
  const adminUser = await createUserIdentity()
  const attackerUser = await createUserIdentity()

  let hostReg: ((p: PeerHandle, id: string) => void) | null = null
  let atkReg: ((p: PeerHandle, id: string) => void) | null = null

  const hostRoom = createRoom(
    f => {
      hostReg = f
    },
    () => {},
    () => {},
    {
      selfId: 'host-s13',
      appId: 's13-app',
      roomId: 's13-fixed-room',
      identity: adminUser,
      use: [roles({admins: [adminUser.userId]})]
    }
  )
  const rawAuthProbe = definePlugin('rawAuthProbe', {
    setup: kernel => ({
      sendAuth: kernel.makeInternalAction<JsonValue>('auth').send
    })
  })
  const atkRoom = createRoom(
    f => {
      atkReg = f
    },
    () => {},
    () => {},
    {
      selfId: 'atk-s13',
      appId: 's13-app',
      roomId: 's13-fixed-room',
      identity: attackerUser,
      use: [rawAuthProbe]
    }
  )

  try {
    const {peerA, peerB} = linkHandles()
    hostReg!(peerA, 'atk-s13')
    atkReg!(peerB, 'host-s13')
    await waitFor(() => 'atk-s13' in hostRoom.getPeers(), 2_000)

    // Send a sync message containing 50 garbage certs from atkRoom over internal 'auth' action
    const garbageCerts = Array.from({length: 50}, (_, i) => ({
      v: 1,
      certId: `bad-${i}`,
      appId: 'wrong-app',
      roomId: 's13-fixed-room',
      subUserId: attackerUser.userId,
      issUserId: adminUser.userId,
      issPubKey: adminUser.signPubJwk,
      roles: ['admin'],
      iat: Date.now(),
      sig: 'A'.repeat(86)
    }))
    await atkRoom
      .sendAuth({t: 'sync', certs: garbageCerts} as unknown as JsonValue)
      .catch(() => {})

    await waitFor(() => !('atk-s13' in hostRoom.getPeers()), 2_000)
    assert.equal('atk-s13' in hostRoom.getPeers(), false)

    // Also verify verifiedActionSigCache deduplicates ECDSA signature verification between offer and payload
    const receiverUser = await createUserIdentity()
    const senderEp = await getDefaultEndpointIdentity(undefined, 's13-sender')
    const recvEp = await getDefaultEndpointIdentity(undefined, 's13-recv')
    let r1Reg: ((p: PeerHandle, id: string) => void | Promise<void>) | null =
      null
    let r2Reg: ((p: PeerHandle, id: string) => void | Promise<void>) | null =
      null
    const s13RoomId = `s13-room~${adminUser.userId}`
    let senderRoomRef: Room | null = null
    let receiverRoomRef: Room | null = null
    const senderHs = createIdentityHandshake({
      endpointIdentityP: Promise.resolve(senderEp),
      appId: 's13-app',
      roomId: s13RoomId,
      getUserIdentity: async () => adminUser,
      getPeerHandle: pid =>
        getRoomSignalingBridge(senderRoomRef!)?.getPeerHandle(pid),
      onVerified: (pid, v) =>
        getRoomSignalingBridge(senderRoomRef!)?.onPeerIdentityVerified(pid, v)
    })
    const recvHs = createIdentityHandshake({
      endpointIdentityP: Promise.resolve(recvEp),
      appId: 's13-app',
      roomId: s13RoomId,
      getUserIdentity: async () => receiverUser,
      getPeerHandle: pid =>
        getRoomSignalingBridge(receiverRoomRef!)?.getPeerHandle(pid),
      onVerified: (pid, v) =>
        getRoomSignalingBridge(receiverRoomRef!)?.onPeerIdentityVerified(pid, v)
    })
    const senderRoom = createRoom(
      f => {
        r1Reg = f
      },
      () => {},
      () => {},
      {
        selfId: senderEp.peerId,
        endpointIdentityP: Promise.resolve(senderEp),
        appId: 's13-app',
        roomId: s13RoomId,
        verifyPeerIdentity: true,
        identity: adminUser,
        onPeerHandshake: senderHs.compose(),
        use: [roles({selfAsAdmin: true})]
      }
    )
    senderRoomRef = senderRoom
    const receiverRoom = createRoom(
      f => {
        r2Reg = f
      },
      () => {},
      () => {},
      {
        selfId: recvEp.peerId,
        endpointIdentityP: Promise.resolve(recvEp),
        appId: 's13-app',
        roomId: s13RoomId,
        verifyPeerIdentity: true,
        identity: receiverUser,
        onPeerHandshake: recvHs.compose(),
        use: [roles()]
      }
    )
    receiverRoomRef = receiverRoom
    const senderBig = senderRoom.makeAction<Uint8Array>('big-act', {
      roles: ['admin']
    })
    let gotBytes = 0
    const recvBig = receiverRoom.makeAction<Uint8Array>('big-act', {
      roles: ['admin']
    })
    recvBig.onMessage(data => {
      gotBytes = data.byteLength
    })

    const {peerA: p1, peerB: p2} = linkHandles()
    void r1Reg!(p1, recvEp.peerId)
    void r2Reg!(p2, senderEp.peerId)
    await waitFor(() => recvEp.peerId in senderRoom.getPeers(), 2_000)
    await waitFor(
      () => receiverRoom.getRoles(senderEp.peerId).includes('admin'),
      2_000
    )

    const origVerify = crypto.subtle.verify.bind(crypto.subtle)
    let verifyCount = 0
    crypto.subtle.verify = (async (...args: Parameters<typeof origVerify>) => {
      verifyCount++
      return origVerify(...args)
    }) as typeof crypto.subtle.verify

    try {
      const payload = new Uint8Array(40 * 1024).fill(7) // multi-chunk (> 16 KiB)
      await senderBig.send(payload)
      await waitFor(() => gotBytes === payload.byteLength, 2_000)
      // Cert cached + action sig verified once at offer, cached on final payload => <= 2 verify calls total
      assert.ok(
        verifyCount <= 2,
        `expected <= 2 WebCrypto verify calls for chunked role action, got ${verifyCount}`
      )
    } finally {
      crypto.subtle.verify = origVerify
      await Promise.all([senderRoom.leave(), receiverRoom.leave()])
    }
  } finally {
    await Promise.all([hostRoom.leave(), atkRoom.leave()])
  }
})

void test('S17: high-S P-256 signatures are rejected and revocation dedupe is immune to signature malleability', async () => {
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

  // Verify RoleRevocationRecord also rejects high-S and deduplicates by content
  const rootUser = await createUserIdentity()
  const targetUser = await createUserIdentity()
  const s17RoomId = `s17-room~${rootUser.userId}`
  const auth = createRoomAuthority({
    selfId: 'root-s17',
    appId: 's17-app',
    initialRoomId: s17RoomId,
    admin: {selfAsAdmin: true},
    getLocalUserIdentity: async () => rootUser
  })
  await auth.getAuthorityInfo()
  const rootCert = await auth.issueRoleCertificate(rootUser.userId, ['admin'])
  const rev = await signRoleRevocation(
    rootUser.sign,
    rootUser.signPubJwk,
    rootCert,
    {
      appId: 's17-app',
      roomId: s17RoomId,
      issuerUserId: rootUser.userId,
      targetUserId: targetUser.userId,
      role: 'dj',
      seq: 1
    }
  )
  const rawRevBytes = fromBase64Url(rev.sig)
  let revS = 0n
  for (let i = 32; i < 64; i++) {
    revS = (revS << 8n) | BigInt(rawRevBytes[i]!)
  }
  let revHighS = p256N - revS
  const highRevBytes = rawRevBytes.slice()
  for (let i = 63; i >= 32; i--) {
    highRevBytes[i] = Number(revHighS & 0xffn)
    revHighS >>= 8n
  }
  const malleableRev = {...rev, sig: toBase64Url(highRevBytes)}

  assert.equal(
    await verifyRoleRevocation(
      malleableRev,
      's17-app',
      s17RoomId,
      new Set([rootUser.userId])
    ),
    false
  )
  assert.equal(await auth.verifyAndApplyRevocation(rev), true)
  assert.equal(await auth.verifyAndApplyRevocation(rev), false)
  assert.equal(await auth.verifyAndApplyRevocation(malleableRev), false)
})
