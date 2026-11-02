import assert from 'node:assert/strict'
import test from './test.ts'
import type {
  RolesPluginApi,
  Room,
  ScalePluginApi
} from '../../packages/core/src/index.ts'
import {
  formatSelfCertifyingRoomId,
  parseSelfCertifyingRoomId,
  roles
} from '../../packages/core/src/authority.ts'
import {
  createUserIdentity,
  deriveUserId,
  exportUserIdentity,
  importUserIdentity
} from '../../packages/core/src/identity.ts'
import {scale} from '../../packages/core/src/scale/index.ts'
import createRoom from '../../packages/core/src/room.ts'
import createTopicStrategy from '../../packages/core/src/topic-strategy.ts'
import {decodeBytes, encodeBytes} from '../../packages/core/src/utils.ts'
import {
  allocTestPeerIds,
  joinAsTestPeer,
  LinkedPeer,
  linkPeers,
  MockRTCPeerConnection,
  testPeerId,
  wait,
  waitFor
} from './peer-harness.ts'

void test('Authority bootstrap: Self-certifying room IDs, on-the-fly joinRoom({ use: [roles({selfAsAdmin: true})] }), UserIdentity.userId, and userId-pinned rooms', async () => {
  // 1. UserIdentity exposes 22-char Base62 userId directly for offline room ID formatting
  const provisionedIdentity = await createUserIdentity()
  assert.match(provisionedIdentity.userId, /^[0-9A-Za-z]{22}$/)
  assert.equal('fingerprint' in provisionedIdentity, false)
  const provisionedRoomId = `watch-party~${provisionedIdentity.userId}`
  assert.equal(
    provisionedRoomId,
    formatSelfCertifyingRoomId('watch-party', provisionedIdentity.userId)
  )
  const parsed = parseSelfCertifyingRoomId(provisionedRoomId)
  assert.deepEqual(parsed, {
    baseRoomId: 'watch-party',
    userId: provisionedIdentity.userId
  })
  assert.equal(
    await deriveUserId(provisionedIdentity.publicKey),
    provisionedIdentity.userId
  )

  // 2. On-the-fly admin room creation via joinRoom({ appId, use: [roles({selfAsAdmin: true})] }, 'lobby')
  const topicSubs = new Map<string, Set<(topic: string, msg: string) => void>>()
  const makeJoinRoom = (peerId: string) =>
    joinAsTestPeer(
      peerId,
      createTopicStrategy({
        init: () => ({}),
        subscribeTopic: (_relay, topic, onMessage) => {
          let set = topicSubs.get(topic)
          if (!set) {
            set = new Set()
            topicSubs.set(topic, set)
          }
          const handler = (t: string, m: string) => {
            void onMessage(t, m)
          }
          set.add(handler)
          return () => {
            set?.delete(handler)
          }
        },
        publishTopic: (_relay, topic, msg) => {
          const handlers = topicSubs.get(topic)
          if (handlers) {
            const text = typeof msg === 'string' ? msg : JSON.stringify(msg)
            for (const h of handlers) {
              queueMicrotask(() => h(topic, text))
            }
          }
        }
      })
    )

  const createdRooms: Room[] = []
  try {
    const hostIdentity = await createUserIdentity()
    const hostRoom = makeJoinRoom('host-peer')(
      {
        appId: 'auth-bootstrap-app',
        identity: hostIdentity,
        use: [roles({selfAsAdmin: true})],
        rtcPolyfill: MockRTCPeerConnection as any
      },
      'game-lobby'
    )
    createdRooms.push(hostRoom)

    const hostAuth = await hostRoom.getSelf()
    assert.equal(hostAuth.baseRoomId, 'game-lobby')
    assert.equal('fingerprint' in hostAuth, false)
    assert.match(hostAuth.userId, /^[0-9A-Za-z]{22}$/)
    assert.equal(hostAuth.userId, hostIdentity.userId)
    assert.equal(hostAuth.roomId, `game-lobby~${hostAuth.userId}`)
    assert.equal(hostAuth.isAdmin, true)
    assert.deepEqual(hostAuth.roles, ['admin'])

    // Room IDs with a single dot + 22 alphanumeric chars (e.g. lobby-${Math.random()}) must NOT throw without roles()
    const dottedRoom = makeJoinRoom('dotted-room-peer')(
      {
        appId: 'auth-bootstrap-app',
        rtcPolyfill: MockRTCPeerConnection as any
      },
      `lobby-0.${hostAuth.userId}`
    )
    createdRooms.push(dottedRoom)

    // Joining a self-certifying roomId (~ separator) WITHOUT roles() throws an error
    assert.throws(
      () =>
        makeJoinRoom('missing-roles-peer')(
          {
            appId: 'auth-bootstrap-app',
            rtcPolyfill: MockRTCPeerConnection as any
          },
          hostAuth.roomId
        ),
      /self-certifying room ID requires roles\(\) in joinRoom config/
    )

    // Guest joins using the self-certifying roomId with roles()
    const guestRoom = makeJoinRoom('guest-peer')(
      {
        appId: 'auth-bootstrap-app',
        use: [roles()],
        rtcPolyfill: MockRTCPeerConnection as any
      },
      hostAuth.roomId
    )
    createdRooms.push(guestRoom)
    const guestAuth = await guestRoom.getSelf()
    assert.equal(guestAuth.roomId, hostAuth.roomId)
    assert.equal(guestAuth.baseRoomId, 'game-lobby')
    assert.equal('fingerprint' in guestAuth, false)
    assert.equal(guestAuth.isAdmin, false)
    assert.deepEqual(guestAuth.roles, [])

    // Impostor whose userId does not match the self-certifying roomId and is not in admins[] does not get admin status
    const impostorIdentity = await createUserIdentity()
    const impostorRoom = makeJoinRoom('impostor-peer')(
      {
        appId: 'auth-bootstrap-app',
        identity: impostorIdentity,
        use: [roles()],
        rtcPolyfill: MockRTCPeerConnection as any
      },
      hostAuth.roomId
    )
    createdRooms.push(impostorRoom)
    const impostorAuth = await impostorRoom.getSelf()
    assert.equal(
      impostorAuth.isAdmin,
      false,
      'a userId that does not match the self-certifying roomId must not grant admin status'
    )

    // Configured co-admins in admins: [...] ARE honored even in self-certifying rooms
    const coAdminIdentity = await createUserIdentity()
    const coAdminRoom = makeJoinRoom('coadmin-peer')(
      {
        appId: 'auth-bootstrap-app',
        identity: coAdminIdentity,
        use: [roles({admins: [coAdminIdentity.userId]})],
        rtcPolyfill: MockRTCPeerConnection as any
      },
      hostAuth.roomId
    )
    createdRooms.push(coAdminRoom)
    const coAdminAuth = await coAdminRoom.getSelf()
    assert.equal(
      coAdminAuth.isAdmin,
      true,
      'configured co-admins in admins: [...] must be honored in self-certifying rooms'
    )

    // Rejoining with the saved host UserIdentity automatically restores root admin status on the same roomId (with roles())
    const rejoinedHostRoom = makeJoinRoom('host-rejoined')(
      {
        appId: 'auth-bootstrap-app',
        identity: await importUserIdentity(exportUserIdentity(hostIdentity)),
        use: [roles()],
        rtcPolyfill: MockRTCPeerConnection as any
      },
      hostAuth.roomId
    )
    createdRooms.push(rejoinedHostRoom)
    const rejoinedAuth = await rejoinedHostRoom.getSelf()
    assert.equal(rejoinedAuth.isAdmin, true)
    assert.equal(rejoinedAuth.roomId, hostAuth.roomId)
    assert.equal(rejoinedAuth.userId, hostIdentity.userId)

    // 3. Mode B: Fixed room slug with trusted admin userId(s)
    const fixedHostRoom = makeJoinRoom('fixed-host-peer')(
      {
        appId: 'auth-bootstrap-app',
        identity: hostIdentity,
        use: [roles({admins: [hostIdentity.userId]})],
        rtcPolyfill: MockRTCPeerConnection as any
      },
      'clean-slug'
    )
    createdRooms.push(fixedHostRoom)
    const fixedHostAuth = await fixedHostRoom.getSelf()
    assert.equal(fixedHostAuth.roomId, 'clean-slug')
    assert.equal('fingerprint' in fixedHostAuth, false)
    assert.equal(fixedHostAuth.isAdmin, true)
    assert.deepEqual(fixedHostAuth.roles, ['admin'])

    const fixedGuestRoom = makeJoinRoom('fixed-guest-peer')(
      {
        appId: 'auth-bootstrap-app',
        use: [roles({admins: [hostIdentity.userId]})],
        rtcPolyfill: MockRTCPeerConnection as any
      },
      'clean-slug'
    )
    createdRooms.push(fixedGuestRoom)
    const fixedGuestAuth = await fixedGuestRoom.getSelf()
    assert.equal(fixedGuestAuth.roomId, 'clean-slug')
    assert.equal(fixedGuestAuth.isAdmin, false)
  } finally {
    await Promise.all(createdRooms.map(r => r.leave()))
  }
})

void test('Privileged actions, role delegation, sub-delegation, and revocation across mesh and multi-hop overlays', async () => {
  const adminIdentity = await createUserIdentity()
  const roomId = `raid-room~${adminIdentity.userId}`
  const appId = 'priv-action-app'

  // Set up a 4-peer multi-hop chain in small-world overlay:
  // admin <-> bob <-> carol <-> mallory
  const adminId = testPeerId('priv-admin')
  const bobId = testPeerId('priv-bob')
  const carolId = testPeerId('priv-carol')
  const malloryId = testPeerId('priv-mallory')
  const peers = [adminId, bobId, carolId, malloryId] as const
  const regMap = new Map<string, (peer: any, id: string) => void>()
  const rooms = new Map<string, Room & RolesPluginApi & ScalePluginApi>()

  for (const id of peers) {
    const peerIdentity =
      id === adminId ? adminIdentity : await createUserIdentity()
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

  try {
    const connectDirect = (a: string, b: string) => {
      const {peerA, peerB} = linkPeers(new LinkedPeer(), new LinkedPeer())
      regMap.get(a)!(peerA, b)
      regMap.get(b)!(peerB, a)
    }

    connectDirect(adminId, bobId)
    connectDirect(bobId, carolId)
    connectDirect(carolId, malloryId)

    await waitFor(
      () =>
        peers.every(
          id =>
            rooms.get(id)!.getTopology().roomPeerIds.length === peers.length - 1
        ),
      3_000
    )

    const receivedAlerts = new Map<
      string,
      Array<{data: any; from: string; meta: any; roles: string[]}>
    >()
    const actions = new Map<string, any>()

    for (const id of peers) {
      receivedAlerts.set(id, [])
      const alertAction = rooms
        .get(id)!
        .makeAction<{msg: string}>('mod-alert', {
          roles: ['admin', 'moderator']
        })
      alertAction.onMessage((data, {peerId, metadata, roles}) => {
        receivedAlerts.get(id)!.push({
          data,
          from: peerId,
          meta: metadata,
          roles: roles ?? []
        })
      })
      actions.set(id, alertAction)
    }

    // 1. Admin sends a privileged broadcast across the multi-hop overlay with user metadata
    await actions
      .get(adminId)
      .send({msg: 'boss-phase-1'}, {metadata: {priority: 'high'}})
    await waitFor(
      () =>
        receivedAlerts.get(bobId)!.length === 1 &&
        receivedAlerts.get(carolId)!.length === 1 &&
        receivedAlerts.get(malloryId)!.length === 1,
      2_000
    )
    assert.deepEqual(receivedAlerts.get(malloryId)![0], {
      data: {msg: 'boss-phase-1'},
      from: adminId,
      meta: {priority: 'high'},
      roles: ['admin']
    })

    // 2. Non-privileged Mallory attempts to send on 'mod-alert' -> rejected locally
    await assert.rejects(
      () => actions.get(malloryId).send({msg: 'forged-alert'}),
      /insufficient authority/
    )

    // Wait for initial authority sync to settle
    await waitFor(
      () => rooms.get(malloryId)!.getRoles(adminId).includes('admin'),
      2_000
    )

    // 3. Root admin grants 'moderator' to Bob
    await rooms.get(adminId)!.grantRole(bobId, 'moderator')
    await waitFor(
      () =>
        rooms.get(bobId)!.getRoles(bobId).includes('moderator') &&
        rooms.get(carolId)!.getRoles(bobId).includes('moderator') &&
        rooms.get(malloryId)!.getRoles(bobId).includes('moderator'),
      2_000
    )

    // Bob can now broadcast on 'mod-alert'
    await actions.get(bobId).send({msg: 'mod-warning-1'})
    await waitFor(
      () =>
        receivedAlerts
          .get(adminId)!
          .some(a => a.data.msg === 'mod-warning-1') &&
        receivedAlerts
          .get(malloryId)!
          .some(a => a.data.msg === 'mod-warning-1'),
      2_000
    )
    const bobAlertOnMallory = receivedAlerts
      .get(malloryId)!
      .find(a => a.data.msg === 'mod-warning-1')!
    assert.deepEqual(bobAlertOnMallory.roles, ['moderator'])

    // 4. Bob cannot grant roles (2-tier model: only root admins can grant roles), while root admin grants 'moderator' to Carol
    await assert.rejects(
      () => rooms.get(bobId)!.grantRole(carolId, 'admin'),
      /insufficient authority/
    )
    await assert.rejects(
      () => rooms.get(bobId)!.grantRole(carolId, 'moderator'),
      /insufficient authority/
    )
    await rooms.get(adminId)!.grantRole(carolId, 'moderator')
    await waitFor(
      () =>
        rooms.get(carolId)!.getRoles(carolId).includes('moderator') &&
        rooms.get(adminId)!.getRoles(carolId).includes('moderator'),
      2_000
    )

    // Carol can now broadcast on 'mod-alert'
    await actions.get(carolId).send({msg: 'carol-mod-notice'})
    await waitFor(
      () =>
        receivedAlerts
          .get(adminId)!
          .some(a => a.data.msg === 'carol-mod-notice'),
      2_000
    )

    // 5. Non-admin moderator Bob cannot revoke root admin
    await assert.rejects(
      () => rooms.get(bobId)!.revokeRole(adminId),
      /insufficient authority/
    )

    // 6. Root admin revokes Carol's 'moderator' role
    await rooms.get(adminId)!.revokeRole(carolId, 'moderator')
    await waitFor(
      () =>
        !rooms.get(carolId)!.getRoles(carolId).includes('moderator') &&
        !rooms.get(adminId)!.getRoles(carolId).includes('moderator') &&
        !rooms.get(bobId)!.getRoles(carolId).includes('moderator'),
      2_000
    )

    // Carol can no longer send on 'mod-alert'
    await assert.rejects(
      () => actions.get(carolId).send({msg: 'after-revocation'}),
      /insufficient authority/
    )
  } finally {
    await Promise.all(peers.map(id => rooms.get(id)!.leave()))
  }
})

void test('C3 regression: live room rejects a RoleRevocationRecord re-wrapped as a PeerBanRecord', async () => {
  const c3AdminIdentity = await createUserIdentity()
  const roomId = `c3-live-room~${c3AdminIdentity.userId}`
  const appId = 'c3-live-app'
  const [modUser, attackerUser] = await Promise.all([
    createUserIdentity(),
    createUserIdentity()
  ])
  const [adminPeerId, attackerPeerId, modPeerId] = allocTestPeerIds(3)
  const peerIds = [adminPeerId!, modPeerId!, attackerPeerId!]
  const usersByPeer: Record<string, any> = {
    [adminPeerId!]: c3AdminIdentity,
    [modPeerId!]: modUser,
    [attackerPeerId!]: attackerUser
  }
  const registerCallbacks = new Map<string, (peer: any, id: string) => void>()
  const rooms = new Map<string, Room & RolesPluginApi & ScalePluginApi>()
  const directLinks = new Map<string, {peerA: LinkedPeer; peerB: LinkedPeer}>()
  const capturedAuthFrames: Uint8Array[] = []

  const connectPair = (idA: string, idB: string) => {
    const key = idA < idB ? `${idA}<->${idB}` : `${idB}<->${idA}`
    if (directLinks.has(key)) {
      return
    }
    const {peerA, peerB} = linkPeers(new LinkedPeer(), new LinkedPeer())
    if (idA === adminPeerId && idB === attackerPeerId) {
      const origSend = peerA.sendData.bind(peerA)
      peerA.sendData = (data: Uint8Array) => {
        if (decodeBytes(data).includes('{"t":"revoke"')) {
          capturedAuthFrames.push(data.slice())
        }
        origSend(data)
      }
    }
    directLinks.set(key, {peerA, peerB})
    registerCallbacks.get(idA)!(peerA, idB)
    registerCallbacks.get(idB)!(peerB, idA)
  }

  for (const id of peerIds) {
    const room = createRoom(
      peerRegister => {
        registerCallbacks.set(id, peerRegister)
      },
      () => {},
      () => {},
      {
        selfId: id,
        appId,
        roomId,
        use: [scale(), roles()],
        identity: usersByPeer[id]!
      }
    )
    rooms.set(id, room as any)
  }

  try {
    connectPair(adminPeerId!, modPeerId!)
    connectPair(adminPeerId!, attackerPeerId!)
    connectPair(modPeerId!, attackerPeerId!)

    await waitFor(
      () =>
        rooms.get(adminPeerId!)!.getTopology().directPeerIds.length === 2 &&
        rooms.get(modPeerId!)!.getTopology().directPeerIds.length === 2 &&
        rooms.get(attackerPeerId!)!.getTopology().directPeerIds.length === 2,
      2_000
    )

    const adminRoom = rooms.get(adminPeerId!)!
    const modRoom = rooms.get(modPeerId!)!
    const attackerRoom = rooms.get(attackerPeerId!)!

    await waitFor(
      () =>
        modRoom.getRoles(adminPeerId!).includes('admin') &&
        attackerRoom.getRoles(adminPeerId!).includes('admin'),
      2_000
    )

    // Admin grants 'moderator' to mod-peer, then revokes 'moderator'
    await adminRoom.grantRole(modPeerId!, 'moderator')
    await waitFor(
      () => attackerRoom.getRoles(modPeerId!).includes('moderator'),
      2_000
    )

    capturedAuthFrames.length = 0
    await adminRoom.revokeRole(modPeerId!, 'moderator')
    await waitFor(
      () =>
        !attackerRoom.getRoles(modPeerId!).includes('moderator') &&
        capturedAuthFrames.length >= 1,
      2_000
    )

    // Extract the signed RoleRevocationRecord from the captured '$auth' frame
    let capturedRevocation: any = null
    for (const frame of capturedAuthFrames) {
      const text = decodeBytes(frame)
      const jsonStart = text.indexOf('{"t":"revoke"')
      if (jsonStart !== -1) {
        capturedRevocation = JSON.parse(text.slice(jsonStart)).revocation
      }
    }
    assert.ok(
      capturedRevocation,
      'expected attacker to capture signed RoleRevocationRecord from wire'
    )

    // Attacker re-wraps the captured RoleRevocationRecord into a PeerBanRecord with the same signature
    const forgedBan = {
      v: capturedRevocation.v,
      appId: capturedRevocation.appId,
      roomId: capturedRevocation.roomId,
      issuerUserId: capturedRevocation.issuerUserId,
      targetUserId: capturedRevocation.targetUserId,
      ...(capturedRevocation.role ? {reason: capturedRevocation.role} : {}),
      seq: capturedRevocation.seq,
      ts: capturedRevocation.ts,
      issuerCert: capturedRevocation.issuerCert,
      signerPubKey: capturedRevocation.signerPubKey,
      sig: capturedRevocation.sig
    }

    // Craft a raw '$auth' wire frame carrying {t: 'ban', ban: forgedBan} and inject it into admin-peer and mod-peer
    const revokeFrame = capturedAuthFrames.find(f =>
      decodeBytes(f).includes('{"t":"revoke"')
    )!
    const revokeText = decodeBytes(revokeFrame)
    const jsonOffset = revokeText.indexOf('{"t":"revoke"')
    const frameHeaderPrefix = revokeFrame.subarray(
      0,
      encodeBytes(revokeText.slice(0, jsonOffset)).byteLength
    )
    const forgedBanBodyBytes = encodeBytes(
      JSON.stringify({t: 'ban', ban: forgedBan})
    )
    const forgedBanWireFrame = new Uint8Array(
      frameHeaderPrefix.byteLength + forgedBanBodyBytes.byteLength
    )
    forgedBanWireFrame.set(frameHeaderPrefix, 0)
    forgedBanWireFrame.set(forgedBanBodyBytes, frameHeaderPrefix.byteLength)

    const adminSigFailBefore = adminRoom.getTopology().stats.signatureFailures
    directLinks
      .get(`${adminPeerId!}<->${attackerPeerId!}`)!
      .peerB.sendData(forgedBanWireFrame)
    directLinks
      .get(`${attackerPeerId!}<->${modPeerId!}`)!
      .peerA.sendData(forgedBanWireFrame)
    await wait(60)

    assert.equal(
      adminRoom.isBanned(modPeerId!),
      false,
      'adminRoom must not ban mod-peer from a re-wrapped revocation'
    )
    assert.equal(
      adminRoom.isBanned(modUser.userId),
      false,
      'adminRoom must not ban modUser from a re-wrapped revocation'
    )
    assert.equal(
      modRoom.isBanned(modPeerId!),
      false,
      'modRoom must not ban mod-peer from a re-wrapped revocation'
    )
    assert.ok(
      adminRoom.getTopology().stats.signatureFailures > adminSigFailBefore,
      'forged ban from revocation must increment signatureFailures'
    )
    assert.ok(
      adminRoom.getTopology().directPeerIds.includes(modPeerId!),
      'mod-peer must remain connected in adminRoom'
    )
  } finally {
    await Promise.all([...rooms.values()].map(r => r.leave()))
  }
})
