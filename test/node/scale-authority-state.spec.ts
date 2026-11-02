import assert from 'node:assert/strict'
import test from './test.ts'
import type {
  RolesPluginApi,
  Room,
  ScalePluginApi
} from '../../packages/core/src/index.ts'
import {compareStateRecords, roles} from '../../packages/core/src/authority.ts'
import {createUserIdentity} from '../../packages/core/src/identity.ts'
import {
  createOverlayManager,
  overlayBroadcastKind,
  unpackOverlayBinary
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

  const regMap = new Map<string, (peer: any, id: string) => void>()
  const makePeerRoom = (
    id: string,
    identity: typeof adminUser1
  ): Room & RolesPluginApi =>
    createRoom(
      f => regMap.set(id, f),
      () => {},
      () => {},
      {
        selfId: id,
        appId,
        roomId,
        identity,
        use: [roles({admins: coAdmins})]
      }
    )

  const directHandles = new Map<string, LinkedPeer>()
  const connectDirect = (a: string, b: string) => {
    const {peerA, peerB} = linkPeers(new LinkedPeer(), new LinkedPeer())
    directHandles.set(`${a}->${b}`, peerA)
    directHandles.set(`${b}->${a}`, peerB)
    regMap.get(a)!(peerA, b)
    regMap.get(b)!(peerB, a)
  }

  const admin1 = makePeerRoom('admin-1', adminUser1)
  const admin2 = makePeerRoom('admin-2', adminUser2)
  const viewer1 = makePeerRoom('viewer-1', viewerUser1)

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

  connectDirect('admin-1', 'admin-2')
  connectDirect('admin-1', 'viewer-1')
  connectDirect('admin-2', 'viewer-1')

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
  assert.equal(stateViewer1.getMeta()?.peerId, 'admin-1')
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

  const viewer2 = makePeerRoom('viewer-2', viewerUser2)
  const stateViewer2 = viewer2.makeState<GameState>(
    'game',
    {round: 0, leader: 'none'},
    {validate: validateGame}
  )
  connectDirect('viewer-1', 'viewer-2')

  await waitFor(() => stateViewer2.get().round === 3, 2_000)
  assert.deepEqual(stateViewer2.get(), finalExpectedState)
  assert.equal(stateViewer2.getMeta()?.timestamp, finalExpectedTs)

  // Verify compareStateRecords deterministic ordering
  assert.equal(
    compareStateRecords(
      {hlc: 200, userId: 'a', peerId: 'p1', sig: '11'} as any,
      {hlc: 100, userId: 'b', peerId: 'p2', sig: '22'} as any
    ) > 0,
    true
  )

  await Promise.all([viewer1.leave(), viewer2.leave()])
})

void test('Hop-1 unauthorized broadcast drop and multi-layer room.ban enforcement', async () => {
  // 1. Hop-1 relay drops unauthorized overlay broadcast before forwarding downstream
  const forwardedToDownstream: Uint8Array[] = []
  const malloryOvId = testPeerId('mallory-ov')
  const relayOvId = testPeerId('relay-ov')
  const adminOvId = testPeerId('admin-ov')
  const downstreamOvId = testPeerId('downstream-ov')
  const malloryOverlay = createOverlayManager({
    selfId: malloryOvId,
    appId: 'hop1-app',
    roomId: 'hop1-room',
    topology: {mode: 'gossip', maxConnections: 4},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })
  const hop1RelayOverlay = createOverlayManager({
    selfId: relayOvId,
    appId: 'hop1-app',
    roomId: 'hop1-room',
    topology: {mode: 'gossip', maxConnections: 4},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {},
    canPeerSendAction: peerId => peerId === adminOvId
  })
  hop1RelayOverlay.registerActionAuthority('admin-cmd', ['admin'])

  const makeSimplePipe = (
    fromId: string,
    toManager: ReturnType<typeof createOverlayManager>
  ) => ({
    isDead: false,
    connection: {} as any,
    channel: {readyState: 'open'} as any,
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
    addTrack: () => ({}) as any,
    removeTrack: () => {},
    replaceTrack: async () => {}
  })

  malloryOverlay.addDirectPeer(
    relayOvId,
    makeSimplePipe(malloryOvId, hop1RelayOverlay)
  )
  hop1RelayOverlay.addDirectPeer(
    malloryOvId,
    makeSimplePipe(relayOvId, malloryOverlay)
  )
  hop1RelayOverlay.addDirectPeer(downstreamOvId, {
    ...makeSimplePipe(relayOvId, malloryOverlay),
    sendData: (data: Uint8Array) => {
      const parsed = unpackOverlayBinary(data)
      if (parsed?.kind === overlayBroadcastKind) {
        forwardedToDownstream.push(data.slice())
      }
    }
  })

  await waitFor(
    () => hop1RelayOverlay.getSnapshot().directPeerIds.includes(malloryOvId),
    1_000
  )
  await wait(40)

  // Mallory broadcasts an action wire frame (v2 header: byte[0]=2, bytes[2..34]=namespace) claiming privileged action 'admin-cmd'
  const fakePrivPayload = new Uint8Array(40)
  fakePrivPayload[0] = 2
  fakePrivPayload.set(encodeBytes('admin-cmd'), 2)
  const relaySigFailBefore =
    hop1RelayOverlay.getSnapshot().stats.signatureFailures
  await malloryOverlay.broadcastInline(fakePrivPayload)
  await wait(50)
  assert.equal(
    hop1RelayOverlay.getSnapshot().stats.signatureFailures,
    relaySigFailBefore + 1,
    'Hop-1 relay must reject unauthorized broadcast on privileged action and increment signatureFailures'
  )
  assert.equal(
    forwardedToDownstream.length,
    0,
    'Hop-1 relay must NOT forward unauthorized privileged broadcast downstream'
  )
  malloryOverlay.destroy()
  hop1RelayOverlay.destroy()

  // 3. Multi-layer room.ban(peerId) enforcement
  const banAdminIdentity = await createUserIdentity()
  const roomId = `ban-test-room~${banAdminIdentity.userId}`
  const appId = 'ban-test-app'

  const regMap = new Map<string, (peer: any, id: string) => void>()
  const rooms = new Map<string, Room & RolesPluginApi & ScalePluginApi>()
  const peerIds = ['admin', 'honest', 'mallory']

  for (const id of peerIds) {
    const peerIdentity =
      id === 'admin' ? banAdminIdentity : await createUserIdentity()
    const room = createRoom(
      f => regMap.set(id, f),
      () => {},
      () => {},
      {
        selfId: id,
        appId,
        roomId,
        use: [roles()],
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
    connectDirect('admin', 'honest')
    connectDirect('admin', 'mallory')
    connectDirect('honest', 'mallory')

    await waitFor(
      () =>
        Object.keys(rooms.get('admin')!.getPeers()).length === 2 &&
        Object.keys(rooms.get('honest')!.getPeers()).length === 2,
      2_000
    )

    const honestChatReceived: Array<{msg: string; from: string}> = []
    for (const id of peerIds) {
      const chatAction = rooms.get(id)!.makeAction<string>('chat')
      chatAction.onMessage((msg, {peerId}) => {
        if (id === 'honest') {
          honestChatReceived.push({msg, from: peerId})
        }
      })
      ;(rooms.get(id) as any).sendChat = chatAction.send
    }

    // Non-admin cannot ban a peer
    await assert.rejects(
      () => rooms.get('honest')!.ban('mallory'),
      /only an admin can ban a peer/
    )

    // Admin bans Mallory
    await rooms.get('admin')!.ban('mallory', {reason: 'abusive behavior'})
    await waitFor(
      () =>
        rooms.get('admin')!.isBanned('mallory') &&
        rooms.get('honest')!.isBanned('mallory'),
      2_000
    )

    assert.equal(rooms.get('admin')!.isBanned('mallory'), true)
    assert.equal(rooms.get('honest')!.isBanned('mallory'), true)
    assert.equal(
      'mallory' in rooms.get('honest')!.getPeers(),
      false,
      'banned peer must be immediately disconnected from honest peers'
    )

    // Even if Mallory tries to reconnect to Honest with a new peer connection, Honest immediately rejects/destroys it
    connectDirect('honest', 'mallory')
    await wait(50)
    assert.equal(
      'mallory' in rooms.get('honest')!.getPeers(),
      false,
      'banned peer reconnection attempt must be rejected'
    )
  } finally {
    await Promise.all(peerIds.map(id => rooms.get(id)!.leave()))
  }
})
