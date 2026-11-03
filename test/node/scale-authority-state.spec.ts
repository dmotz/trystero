import assert from 'node:assert/strict'
import test from './test.ts'
import type {
  PeerHandle,
  RolesPluginApi,
  Room,
  ScalePluginApi,
  UserIdentity
} from '../../packages/core/src/index.ts'
import {actionWireVersion} from '../../packages/core/src/action-wire.ts'
import {roles} from '../../packages/core/src/authority.ts'
import {createUserIdentity} from '../../packages/core/src/identity.ts'
import createRoom from '../../packages/core/src/room.ts'
import {
  createOverlayManager,
  overlayBroadcastKind,
  scale,
  unpackOverlayFrame
} from '../../packages/core/src/scale/index.ts'
import {compareStateRecords} from '../../packages/core/src/state.ts'
import {encodeBytes} from '../../packages/core/src/utils.ts'
import {
  getTestEndpointByPeerId,
  LinkedPeer,
  linkPeers,
  testPeerId,
  wait,
  waitFor
} from './peer-harness.ts'

void test('Authoritative state (room.makeState): monotonic updates, custom validation, co-admin LWW convergence, and late-joiner sync after admin leaves', async () => {
  const [adminUser1, adminUser2, viewerUser1, viewerUser2] = await Promise.all([
    createUserIdentity(),
    createUserIdentity(),
    createUserIdentity(),
    createUserIdentity()
  ])
  const roomId = 'state-room'
  const appId = 'state-test-app'
  const coAdmins = [adminUser1.userId, adminUser2.userId]

  const admin1Id = testPeerId('state-admin-1')
  const admin2Id = testPeerId('state-admin-2')
  const viewer1Id = testPeerId('state-viewer-1')
  const viewer2Id = testPeerId('state-viewer-2')

  const regMap = new Map<string, (peer: PeerHandle, id: string) => void>()
  const makePeerRoom = (
    id: string,
    identity: UserIdentity
  ): Room & RolesPluginApi & ScalePluginApi =>
    createRoom(
      f => regMap.set(id, f),
      () => {},
      () => {},
      {
        endpointIdentity: getTestEndpointByPeerId(id),
        appId,
        roomId,
        identity,
        use: [scale({maxDirectPeers: 4}), roles({admins: coAdmins})]
      }
    ) as unknown as Room & RolesPluginApi & ScalePluginApi

  const directHandles = new Map<string, LinkedPeer>()
  const connectDirect = (a: string, b: string) => {
    const {peerA, peerB} = linkPeers(new LinkedPeer(), new LinkedPeer())
    directHandles.set(`${a}->${b}`, peerA)
    directHandles.set(`${b}->${a}`, peerB)
    regMap.get(a)!(peerA as unknown as PeerHandle, b)
    regMap.get(b)!(peerB as unknown as PeerHandle, a)
  }

  const admin1 = makePeerRoom(admin1Id, adminUser1)
  const admin2 = makePeerRoom(admin2Id, adminUser2)
  const viewer1 = makePeerRoom(viewer1Id, viewerUser1)

  type GameState = {round: number; leader: string}
  const validateGame = (next: GameState, {prev}: {prev: GameState}) =>
    next.round >= prev.round

  const stateAdmin1 = admin1.makeState<GameState>(
    'game',
    {round: 0, leader: 'none'},
    {validate: validateGame}
  )
  const stateAdmin2 = admin2.makeState<GameState>(
    'game',
    {round: 0, leader: 'none'},
    {validate: validateGame}
  )
  const stateViewer1 = viewer1.makeState<GameState>(
    'game',
    {round: 0, leader: 'none'},
    {validate: validateGame}
  )

  const viewerChanges: Array<{val: GameState; prev: GameState; by: string}> = []
  stateViewer1.onChange((val, ctx) => {
    viewerChanges.push({val, prev: ctx.prev, by: ctx.peerId})
  })

  connectDirect(admin1Id, admin2Id)
  connectDirect(admin1Id, viewer1Id)
  connectDirect(admin2Id, viewer1Id)

  await waitFor(
    () =>
      Object.keys(admin1.getPeers()).length === 2 &&
      Object.keys(viewer1.getPeers()).length === 2,
    2_000
  )

  // 1. Non-admin viewer cannot mutate authoritative state
  await assert.rejects(
    () => stateViewer1.set({round: 99, leader: 'viewer-1'}),
    /insufficient authority/
  )

  // 2. Admin 1 updates state twice (value and functional updater)
  await stateAdmin1.set({round: 1, leader: 'admin-1'})
  await stateAdmin1.set(prev => ({round: prev.round + 1, leader: 'admin-1'}))

  await waitFor(
    () => stateViewer1.get().round === 2 && stateAdmin2.get().round === 2,
    2_000
  )
  assert.deepEqual(stateViewer1.get(), {round: 2, leader: 'admin-1'})
  assert.equal(stateViewer1.getMeta()?.peerId, admin1Id)
  assert.equal(typeof stateViewer1.getMeta()?.timestamp, 'number')
  assert.ok(viewerChanges.length >= 1)

  // 3. Custom validate hook blocks regressive round update
  await assert.rejects(
    () => stateAdmin1.set({round: 0, leader: 'admin-1'}),
    /state validation failed/
  )

  // 4. Co-admin concurrent updates converge deterministically across all peers
  await Promise.all([
    stateAdmin1.set({round: 3, leader: 'from-admin-1'}),
    stateAdmin2.set({round: 3, leader: 'from-admin-2'})
  ])
  await wait(80)
  assert.deepEqual(stateAdmin1.get(), stateAdmin2.get())
  assert.deepEqual(stateViewer1.get(), stateAdmin1.get())
  assert.equal(
    stateAdmin1.getMeta()?.timestamp,
    stateViewer1.getMeta()?.timestamp
  )
  assert.equal(stateAdmin1.getMeta()?.userId, stateViewer1.getMeta()?.userId)

  // 5. Both admins leave the room, then a late-joiner (viewer-2) connects ONLY to viewer-1!
  // viewer-2 must still receive and verify the signed authoritative state snapshot from viewer-1.
  const finalExpectedState = stateViewer1.get()
  const finalExpectedTs = stateViewer1.getMeta()?.timestamp
  await Promise.all([admin1.leave(), admin2.leave()])

  const viewer2 = makePeerRoom(viewer2Id, viewerUser2)
  const stateViewer2 = viewer2.makeState<GameState>(
    'game',
    {round: 0, leader: 'none'},
    {validate: validateGame}
  )
  connectDirect(viewer1Id, viewer2Id)

  await waitFor(() => stateViewer2.get().round === 3, 2_000)
  assert.deepEqual(stateViewer2.get(), finalExpectedState)
  assert.equal(stateViewer2.getMeta()?.timestamp, finalExpectedTs)

  // Verify compareStateRecords deterministic ordering
  assert.equal(
    compareStateRecords(
      {hlc: 200, userId: 'a', peerId: 'p1', sig: '11'} as Parameters<
        typeof compareStateRecords
      >[0],
      {hlc: 100, userId: 'b', peerId: 'p2', sig: '22'} as Parameters<
        typeof compareStateRecords
      >[1]
    ) > 0,
    true
  )

  await Promise.all([viewer1.leave(), viewer2.leave()])
})

void test('Hop-1 unauthorized broadcast drop and multi-hop room.ban / room.unban enforcement across scale()', async () => {
  // 1. Hop-1 relay drops unauthorized overlay broadcast before forwarding downstream, while forwarding authorized ones
  const forwardedToDownstream: Uint8Array[] = []
  let deliveredOnRelay = 0
  const malloryOvId = testPeerId('mallory-ov')
  const relayOvId = testPeerId('relay-ov')
  const adminOvId = testPeerId('admin-ov')
  const downstreamOvId = testPeerId('downstream-ov')

  const malloryOverlay = createOverlayManager({
    selfId: malloryOvId,
    appId: 'hop1-app',
    roomId: 'hop1-room',
    config: {maxDirectPeers: 4},
    getLocalEndpointIdentity: () => getTestEndpointByPeerId(malloryOvId),
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })
  const adminOverlay = createOverlayManager({
    selfId: adminOvId,
    appId: 'hop1-app',
    roomId: 'hop1-room',
    config: {maxDirectPeers: 4},
    getLocalEndpointIdentity: () => getTestEndpointByPeerId(adminOvId),
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })
  const hop1RelayOverlay = createOverlayManager({
    selfId: relayOvId,
    appId: 'hop1-app',
    roomId: 'hop1-room',
    config: {maxDirectPeers: 4},
    getLocalEndpointIdentity: () => getTestEndpointByPeerId(relayOvId),
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {
      deliveredOnRelay++
    },
    authorizePeerAction: peerId => peerId === adminOvId
  })
  hop1RelayOverlay.registerActionAuthority('admin-cmd', ['admin'])

  const makeSimplePipe = (
    fromId: string,
    toManager: ReturnType<typeof createOverlayManager>
  ): PeerHandle => ({
    isDead: false,
    connection: {} as RTCPeerConnection,
    channel: {readyState: 'open'} as RTCDataChannel,
    getOffer: async () => undefined,
    signal: async () => undefined,
    sendData: (data: Uint8Array) => {
      queueMicrotask(() =>
        toManager.handleOverlayFrame(fromId, data.slice().buffer)
      )
    },
    destroy: () => {},
    setHandlers: () => {},
    addStream: () => {},
    removeStream: () => {},
    addTrack: () => ({}) as RTCRtpSender,
    removeTrack: () => {},
    replaceTrack: async () => {}
  })

  try {
    malloryOverlay.addDirectPeer(
      relayOvId,
      makeSimplePipe(malloryOvId, hop1RelayOverlay)
    )
    hop1RelayOverlay.addDirectPeer(
      malloryOvId,
      makeSimplePipe(relayOvId, malloryOverlay)
    )
    adminOverlay.addDirectPeer(
      relayOvId,
      makeSimplePipe(adminOvId, hop1RelayOverlay)
    )
    hop1RelayOverlay.addDirectPeer(
      adminOvId,
      makeSimplePipe(relayOvId, adminOverlay)
    )
    hop1RelayOverlay.addDirectPeer(downstreamOvId, {
      ...makeSimplePipe(relayOvId, malloryOverlay),
      sendData: (data: Uint8Array) => {
        const parsed = unpackOverlayFrame(data)
        if (parsed?.[0] === overlayBroadcastKind) {
          forwardedToDownstream.push(data.slice())
        }
      }
    })

    await waitFor(
      () =>
        hop1RelayOverlay.getSnapshot().directPeerIds.includes(malloryOvId) &&
        hop1RelayOverlay.getSnapshot().directPeerIds.includes(adminOvId) &&
        Boolean(hop1RelayOverlay.getPeerSignPublicKey(malloryOvId)) &&
        Boolean(hop1RelayOverlay.getPeerSignPublicKey(adminOvId)),
      1_500
    )

    // Mallory broadcasts an action wire frame (v3 header: byte[0]=actionWireVersion, bytes[2..34]=namespace)
    // claiming privileged action 'admin-cmd' -> dropped at Hop-1 without delivering or forwarding
    const fakePrivPayload = new Uint8Array(40)
    fakePrivPayload[0] = actionWireVersion
    fakePrivPayload.set(encodeBytes('admin-cmd'), 2)
    await malloryOverlay.broadcastInline(fakePrivPayload)
    await wait(50)

    assert.equal(
      deliveredOnRelay,
      0,
      'Hop-1 relay must NOT deliver unauthorized privileged broadcast locally'
    )
    assert.equal(
      forwardedToDownstream.length,
      0,
      'Hop-1 relay must NOT forward unauthorized privileged broadcast downstream'
    )

    // Authorized admin broadcast on 'admin-cmd' IS delivered and forwarded downstream
    await adminOverlay.broadcastInline(fakePrivPayload)
    await waitFor(
      () => deliveredOnRelay === 1 && forwardedToDownstream.length === 1,
      1_000
    )
  } finally {
    malloryOverlay.destroy()
    adminOverlay.destroy()
    hop1RelayOverlay.destroy()
  }

  // 2. Multi-hop room.ban and room.unban enforcement across scale() overlay
  //    Line topology: admin -- honest -- relay -- mallory
  const [banAdminIdentity, honestUser, relayUser, malloryUser] =
    await Promise.all([
      createUserIdentity(),
      createUserIdentity(),
      createUserIdentity(),
      createUserIdentity()
    ])
  const roomId = `ban-test-room~${banAdminIdentity.userId}`
  const appId = 'ban-test-app'

  const adminId = testPeerId('ban-admin')
  const honestId = testPeerId('ban-honest')
  const relayId = testPeerId('ban-relay')
  const malloryId = testPeerId('ban-mallory-1')
  const malloryRetryBannedId = testPeerId('ban-mallory-2')
  const malloryRejoinUnbannedId = testPeerId('ban-mallory-3')

  const regMap = new Map<string, (peer: PeerHandle, id: string) => void>()
  const rooms = new Map<string, Room & RolesPluginApi & ScalePluginApi>()
  const directLinks = new Map<string, {peerA: LinkedPeer; peerB: LinkedPeer}>()
  const linkKey = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`)

  const spawnRoom = (id: string, identity: UserIdentity) => {
    const room = createRoom(
      f => regMap.set(id, f),
      pid => {
        const pair = directLinks.get(linkKey(id, pid))
        if (pair) {
          directLinks.delete(linkKey(id, pid))
          pair.peerA.destroy()
          pair.peerB.destroy()
        }
      },
      () => {},
      {
        endpointIdentity: getTestEndpointByPeerId(id),
        appId,
        roomId,
        use: [scale({maxDirectPeers: 4}), roles()],
        identity
      }
    ) as unknown as Room & RolesPluginApi & ScalePluginApi
    rooms.set(id, room)
    return room
  }

  const connectDirect = (a: string, b: string) => {
    const k = linkKey(a, b)
    if (directLinks.has(k)) {
      return
    }
    const {peerA, peerB} = linkPeers(new LinkedPeer(), new LinkedPeer())
    directLinks.set(k, {peerA, peerB})
    regMap.get(a)!(peerA as unknown as PeerHandle, b)
    regMap.get(b)!(peerB as unknown as PeerHandle, a)
  }

  spawnRoom(adminId, banAdminIdentity)
  spawnRoom(honestId, honestUser)
  spawnRoom(relayId, relayUser)
  spawnRoom(malloryId, malloryUser)

  try {
    connectDirect(adminId, honestId)
    connectDirect(honestId, relayId)
    connectDirect(relayId, malloryId)

    await waitFor(
      () =>
        [adminId, honestId, relayId, malloryId].every(
          id => rooms.get(id)!.getTopology().roomPeerIds.length === 3
        ),
      3_000
    )

    // Grant 'moderator' to honestId and verify neither viewer nor moderator can ban/unban (Q6=A)
    await rooms.get(adminId)!.grantRole(honestId, 'moderator')
    await waitFor(
      () => rooms.get(honestId)!.getRoles(honestId).includes('moderator'),
      2_000
    )

    await assert.rejects(
      () => rooms.get(relayId)!.ban(malloryId),
      /insufficient authority: only a root admin can ban a peer/
    )
    await assert.rejects(
      () => rooms.get(honestId)!.ban(malloryId),
      /insufficient authority: only a root admin can ban a peer/
    )
    await assert.rejects(
      () => rooms.get(honestId)!.unban(malloryUser.userId),
      /insufficient authority: only a root admin can unban a peer/
    )
    await assert.rejects(
      () => rooms.get(adminId)!.ban(adminId),
      /cannot ban a root admin/
    )

    // Root admin bans 3-hop virtual peer Mallory
    await rooms.get(adminId)!.ban(malloryId, {reason: 'abusive behavior'})
    await waitFor(
      () =>
        rooms.get(adminId)!.isBanned(malloryUser.userId) &&
        rooms.get(honestId)!.isBanned(malloryUser.userId) &&
        rooms.get(relayId)!.isBanned(malloryUser.userId) &&
        !(malloryId in rooms.get(adminId)!.getPeers()) &&
        !(malloryId in rooms.get(honestId)!.getPeers()) &&
        !(malloryId in rooms.get(relayId)!.getPeers()),
      3_000
    )

    // Even if Mallory tries to rejoin on a fresh endpoint while banned, Relay rejects/evicts her
    spawnRoom(malloryRetryBannedId, malloryUser)
    connectDirect(relayId, malloryRetryBannedId)
    await wait(80)
    assert.equal(
      malloryRetryBannedId in rooms.get(relayId)!.getPeers(),
      false,
      'banned user reconnection attempt on new endpoint must be rejected'
    )

    // Root admin lifts the ban via room.unban(userId) (Q22=A: syncs PeerModerationRecord op='unban' via @_auth)
    await rooms.get(adminId)!.unban(malloryUser.userId)
    await waitFor(
      () =>
        !rooms.get(adminId)!.isBanned(malloryUser.userId) &&
        !rooms.get(honestId)!.isBanned(malloryUser.userId) &&
        !rooms.get(relayId)!.isBanned(malloryUser.userId),
      3_000
    )

    // Unbanned Mallory can now rejoin cleanly and exchange messages across the multi-hop overlay
    const unbannedRoom = spawnRoom(malloryRejoinUnbannedId, malloryUser)
    const adminPingReceived: string[] = []
    rooms
      .get(adminId)!
      .makeAction<string>('rejoin-hello')
      .onMessage((msg, {peerId}) => {
        adminPingReceived.push(`${peerId}:${msg}`)
      })
    const rejoinHello = unbannedRoom.makeAction<string>('rejoin-hello')

    connectDirect(relayId, malloryRejoinUnbannedId)
    await waitFor(
      () =>
        malloryRejoinUnbannedId in rooms.get(relayId)!.getPeers() &&
        malloryRejoinUnbannedId in rooms.get(honestId)!.getPeers() &&
        malloryRejoinUnbannedId in rooms.get(adminId)!.getPeers(),
      3_000
    )

    await rejoinHello.send('back-in-good-standing', {target: adminId})
    await waitFor(() => adminPingReceived.length === 1, 2_000)
    assert.deepEqual(adminPingReceived, [
      `${malloryRejoinUnbannedId}:back-in-good-standing`
    ])
  } finally {
    await Promise.all([...rooms.values()].map(r => r.leave()))
  }
})
