import assert from 'node:assert/strict'
import test from './test.ts'
import {
  createUserIdentity,
  type PeerHandle,
  type Room,
  type RoomError,
  scale
} from '../../packages/core/src/index.ts'
import createRoom from '../../packages/core/src/room.ts'
import {createMemorySignalBus} from './memory-rtc.ts'
import {
  BufferedPeer,
  allocTestPeerIds,
  createSortedJoinRooms,
  getTestEndpointByPeerId,
  linkPeers,
  wait,
  waitFor
} from './peer-harness.ts'

type RecordedError = RoomError & {peerId?: string | undefined}

const textDecoder = new TextDecoder()

class PausableReadyPeer extends BufferedPeer {
  pauseReady = false
  heldReadyFrames: ArrayBuffer[] = []

  override sendData(data: Uint8Array | ArrayBuffer) {
    const view = data instanceof Uint8Array ? data : new Uint8Array(data)
    if (this.pauseReady && view.byteLength >= 34) {
      const wireType = textDecoder
        .decode(view.subarray(2, 34))
        .replace(/\0+$/, '')
      if (wireType.endsWith('hsready')) {
        this.heldReadyFrames.push(view.slice().buffer)
        return
      }
    }
    super.sendData(data)
  }

  releaseReady() {
    this.pauseReady = false
    for (const frame of this.heldReadyFrames.splice(0)) {
      super.sendData(frame)
    }
  }
}

void test('Trystero: validates config.maxUsers as a positive safe integer', () => {
  const {makeJoinRoom, rtcPolyfill} = createMemorySignalBus({
    delivery: 'microtask'
  })
  const joinRoom = makeJoinRoom()

  for (const invalidMaxUsers of [0, -1, -100, 1.5, NaN, Infinity, -Infinity]) {
    assert.throws(
      () =>
        joinRoom(
          {
            appId: 'max-users-validation-app',
            maxUsers: invalidMaxUsers,
            rtcPolyfill
          },
          'room-1'
        ),
      /Trystero: maxUsers must be a positive safe integer/
    )
    assert.throws(
      () =>
        createRoom(
          () => {},
          () => {},
          () => {},
          {
            appId: 'max-users-validation-app',
            roomId: 'room-1',
            maxUsers: invalidMaxUsers
          }
        ),
      /Trystero: maxUsers must be a positive safe integer/
    )
  }
})

void test(
  'Trystero: maxUsers: 1 allows a solo occupant, rejects subsequent joiners with "room full", and allows join after occupant leaves',
  {timeout: 10_000},
  async () => {
    const {makeJoinRoom, rtcPolyfill} = createMemorySignalBus({
      delivery: 'microtask'
    })
    const appId = `max-users-1-${Date.now()}`
    const roomId = 'solo-room'

    const [hostSlot, lateSlot] = await createSortedJoinRooms(
      2,
      () => makeJoinRoom(),
      appId
    )
    const hostJoin = hostSlot!.joinRoom
    const lateJoin = lateSlot!.joinRoom
    const hostErrors: RecordedError[] = []
    const hostJoins: string[] = []
    const hostLeaves: string[] = []

    const hostRoom = hostJoin(
      {
        appId,
        maxUsers: 1,
        rtcPolyfill
      },
      roomId
    )
    hostRoom.onError(err => hostErrors.push(err))
    hostRoom.onPeerJoin(({peerId}) => hostJoins.push(peerId))
    hostRoom.onPeerLeave(({peerId}) => hostLeaves.push(peerId))

    await wait(60)

    const lateErrors: RecordedError[] = []
    const lateJoins: string[] = []

    let lateRoom: Room | undefined
    let nextRoom: Room | undefined
    try {
      lateRoom = lateJoin(
        {
          appId,
          maxUsers: 1,
          rtcPolyfill
        },
        roomId
      )
      lateRoom.onError(err => lateErrors.push(err))
      lateRoom.onPeerJoin(({peerId}) => lateJoins.push(peerId))

      await waitFor(() => lateErrors.length > 0, 3_000)
      await wait(120)

      assert.equal(
        lateErrors.length,
        1,
        'rejected joiner should receive onError once from solo host'
      )
      assert.equal(lateErrors[0]!.code, 'room-full')
      assert.equal(lateErrors[0]!.message, 'room full')
      assert.equal(lateErrors[0]!.appId, appId)
      assert.equal(lateErrors[0]!.roomId, roomId)
      const {peerId: hostPeerId} = await hostRoom.getSelf()
      assert.equal(lateErrors[0]!.peerId, hostPeerId)
      assert.deepEqual(lateJoins, [])
      assert.deepEqual(hostErrors, [], 'host must not receive onError')
      assert.deepEqual(
        hostJoins,
        [],
        'host must not receive onPeerJoin for rejected peer'
      )
      assert.deepEqual(
        hostLeaves,
        [],
        'host must not receive onPeerLeave for rejected peer'
      )

      // Host leaves and rejected joiner cleans up; now a new peer can join the maxUsers: 1 room
      await lateRoom.leave()
      await hostRoom.leave()
      await wait(50)

      const nextJoin = makeJoinRoom('peer-next')
      const nextErrors: RecordedError[] = []
      nextRoom = nextJoin(
        {
          appId,
          maxUsers: 1,
          rtcPolyfill
        },
        roomId
      )
      nextRoom.onError(err => nextErrors.push(err))

      await wait(150)
      assert.deepEqual(nextErrors, [])
    } finally {
      await Promise.all([
        hostRoom?.leave().catch(() => {}),
        nextRoom?.leave().catch(() => {}),
        lateRoom?.leave().catch(() => {})
      ])
    }
  }
)

void test(
  'Trystero: maxUsers: 2 admits 2 users, emits "room-full" per rejecting peer for a 3rd user, and admits a 4th after one leaves',
  {timeout: 10_000},
  async () => {
    const {makeJoinRoom, rtcPolyfill} = createMemorySignalBus({
      delivery: 'microtask'
    })
    const appId = `max-users-2-seq-${Date.now()}`
    const roomId = 'duel-room'

    const [slotA, slotB, slotC, slotD] = await createSortedJoinRooms(
      4,
      () => makeJoinRoom(),
      appId
    )
    const joinA = slotA!.joinRoom
    const joinB = slotB!.joinRoom
    const joinC = slotC!.joinRoom
    const joinD = slotD!.joinRoom

    const errorsA: RecordedError[] = []
    const errorsB: RecordedError[] = []
    const errorsC: RecordedError[] = []
    const errorsD: RecordedError[] = []

    const joinsA: string[] = []
    const leavesA: string[] = []
    const joinsB: string[] = []
    const leavesB: string[] = []
    const joinsC: string[] = []
    const joinsD: string[] = []

    let roomA: Room | undefined
    let roomB: Room | undefined
    let roomC: Room | undefined
    let roomD: Room | undefined
    try {
      roomA = joinA(
        {
          appId,
          maxUsers: 2,
          rtcPolyfill
        },
        roomId
      )
      roomA.onError(err => errorsA.push(err))
      roomA.onPeerJoin(({peerId}: {peerId: string}) => joinsA.push(peerId))
      roomA.onPeerLeave(({peerId}: {peerId: string}) => leavesA.push(peerId))

      roomB = joinB(
        {
          appId,
          maxUsers: 2,
          rtcPolyfill
        },
        roomId
      )
      roomB.onError(err => errorsB.push(err))
      roomB.onPeerJoin(({peerId}: {peerId: string}) => joinsB.push(peerId))
      roomB.onPeerLeave(({peerId}: {peerId: string}) => leavesB.push(peerId))

      const [{peerId: peerA}, {peerId: peerB}] = await Promise.all([
        roomA.getSelf(),
        roomB.getSelf()
      ])
      await waitFor(
        () => joinsA.includes(peerB) && joinsB.includes(peerA),
        3_000
      )

      // Peer C attempts to join when room is already at capacity (2/2)
      roomC = joinC(
        {
          appId,
          maxUsers: 2,
          rtcPolyfill
        },
        roomId
      )
      roomC.onError(err => errorsC.push(err))
      roomC.onPeerJoin(({peerId}: {peerId: string}) => joinsC.push(peerId))

      await waitFor(() => errorsC.length > 0, 3_000)
      await wait(120)

      assert.ok(
        errorsC.length >= 1 && errorsC.length <= 2,
        `expected 1..2 per-peer room-full errors, got ${errorsC.length}`
      )
      assert.equal(
        new Set(errorsC.map(e => e.peerId)).size,
        errorsC.length,
        'each room-full error must correspond to a distinct rejecting peer'
      )
      for (const err of errorsC) {
        assert.equal(err.code, 'room-full')
        assert.equal(err.message, 'room full')
        assert.equal(err.appId, appId)
        assert.equal(err.roomId, roomId)
        assert.ok(
          err.peerId === peerA || err.peerId === peerB,
          'rejecting peerId should be one of the existing members'
        )
      }
      assert.deepEqual(joinsC, [], 'Peer C must not activate any peers')
      assert.deepEqual(errorsA, [], 'Peer A must not receive onError')
      assert.deepEqual(errorsB, [], 'Peer B must not receive onError')
      assert.deepEqual(joinsA, [peerB], 'Peer A must not fire onPeerJoin for C')
      assert.deepEqual(joinsB, [peerA], 'Peer B must not fire onPeerJoin for C')
      assert.deepEqual<string[]>(
        leavesA,
        [],
        'Peer A must not fire onPeerLeave for C'
      )
      assert.deepEqual(leavesB, [], 'Peer B must not fire onPeerLeave for C')

      // Rejected Peer C cleans up and Peer B leaves, freeing 1 seat (1/2)
      await roomC.leave()
      await roomB.leave()
      await waitFor(() => leavesA.includes(peerB), 2_000)

      // Peer D joins and should be admitted into the newly opened seat
      roomD = joinD(
        {
          appId,
          maxUsers: 2,
          rtcPolyfill
        },
        roomId
      )
      roomD.onError(err => errorsD.push(err))
      roomD.onPeerJoin(({peerId}: {peerId: string}) => joinsD.push(peerId))

      const {peerId: peerD} = await roomD.getSelf()
      await waitFor(
        () => joinsA.includes(peerD) && joinsD.includes(peerA),
        3_000
      )
      assert.deepEqual(errorsD, [])
      assert.deepEqual(Object.keys(roomA.getPeers()), [peerD])
      assert.deepEqual(Object.keys(roomD.getPeers()), [peerA])
    } finally {
      await Promise.all([
        roomA?.leave().catch(() => {}),
        roomB?.leave().catch(() => {}),
        roomC?.leave().catch(() => {}),
        roomD?.leave().catch(() => {})
      ])
    }
  }
)

void test(
  'Trystero: pending handshakes reserve maxUsers admission slots, allow same-userId tabs while pending, and release reserved slots on disconnect',
  {timeout: 10_000},
  async () => {
    const [hostId, b1Id, b2Id, cId, dId] = allocTestPeerIds(5) as [
      string,
      string,
      string,
      string,
      string
    ]
    const [hostUser, bobUser, carolUser, daveUser] = await Promise.all([
      createUserIdentity(),
      createUserIdentity(),
      createUserIdentity(),
      createUserIdentity()
    ])
    const regMap = new Map<string, (peer: PeerHandle, id: string) => void>()
    const errors = new Map<string, RecordedError[]>()

    const makeNode = (id: string, identity: typeof hostUser) => {
      const errs: RecordedError[] = []
      errors.set(id, errs)
      const room = createRoom(
        f => regMap.set(id, f),
        () => {},
        () => {},
        {
          endpointIdentity: getTestEndpointByPeerId(id),
          appId: 'pending-slot-app',
          roomId: 'pending-slot-room',
          identity,
          maxUsers: 2
        }
      )
      room.onError(err => errs.push(err))
      return room
    }

    const hostRoom = makeNode(hostId, hostUser)
    const bobTab1Room = makeNode(b1Id, bobUser)
    const bobTab2Room = makeNode(b2Id, bobUser)
    const carolRoom = makeNode(cId, carolUser)
    const daveRoom = makeNode(dId, daveUser)

    try {
      await Promise.all([
        hostRoom.ready,
        bobTab1Room.ready,
        bobTab2Room.ready,
        carolRoom.ready,
        daveRoom.ready
      ])

      // Start handshake between hostId (< b1Id, so host is initiator and reserves slot upon identity verify)
      // Hold back b1's final hsready frame so b1 stays in pending-handshake state on hostRoom.
      const hostSideB1 = new BufferedPeer()
      const b1Side = new PausableReadyPeer()
      b1Side.pauseReady = true
      linkPeers(hostSideB1, b1Side)

      regMap.get(hostId)!(hostSideB1 as unknown as PeerHandle, b1Id)
      regMap.get(b1Id)!(b1Side as unknown as PeerHandle, hostId)

      await waitFor(() => b1Side.heldReadyFrames.length === 1, 2_000)
      assert.deepEqual(
        Object.keys(hostRoom.getPeers()),
        [],
        'bobTab1 must still be pending handshake on hostRoom'
      )

      // 1. Carol (distinct user) tries to join while bobTab1's handshake is pending -> rejected with 'room-full'
      const linkCarol = linkPeers(new BufferedPeer(), new BufferedPeer())
      regMap.get(hostId)!(linkCarol.peerA as unknown as PeerHandle, cId)
      regMap.get(cId)!(linkCarol.peerB as unknown as PeerHandle, hostId)

      await waitFor(() => (errors.get(cId)?.length ?? 0) === 1, 2_000)
      assert.equal(errors.get(cId)![0]!.code, 'room-full')
      assert.equal(errors.get(cId)![0]!.peerId, hostId)
      assert.deepEqual(Object.keys(carolRoom.getPeers()), [])

      // 2. Bob's second tab (same bobUser.userId as pending bobTab1) joins while bobTab1 is pending -> ADMITTED
      const linkBob2 = linkPeers(new BufferedPeer(), new BufferedPeer())
      regMap.get(hostId)!(linkBob2.peerA as unknown as PeerHandle, b2Id)
      regMap.get(b2Id)!(linkBob2.peerB as unknown as PeerHandle, hostId)

      await waitFor(() => b2Id in hostRoom.getPeers(), 2_000)
      assert.deepEqual(errors.get(b2Id), [])

      // Disconnect bobTab2 AND abort pending bobTab1 before activation -> both slots for bobUser are released
      await bobTab2Room.leave()
      await waitFor(() => !(b2Id in hostRoom.getPeers()), 2_000)
      hostSideB1.destroy()
      b1Side.destroy()
      await wait(20)

      // 3. Dave (new distinct user) joins now that pending bobTab1 disconnected -> ADMITTED
      const linkDave = linkPeers(new BufferedPeer(), new BufferedPeer())
      regMap.get(hostId)!(linkDave.peerA as unknown as PeerHandle, dId)
      regMap.get(dId)!(linkDave.peerB as unknown as PeerHandle, hostId)

      await waitFor(
        () => dId in hostRoom.getPeers() && hostId in daveRoom.getPeers(),
        2_000
      )
      assert.deepEqual(errors.get(dId), [])
      assert.deepEqual(errors.get(hostId), [])
    } finally {
      await Promise.all([
        hostRoom.leave().catch(() => {}),
        bobTab1Room.leave().catch(() => {}),
        bobTab2Room.leave().catch(() => {}),
        carolRoom.leave().catch(() => {}),
        daveRoom.leave().catch(() => {})
      ])
    }
  }
)

void test(
  'Trystero: multi-tab / reconnect of an already-admitted userId is admitted at maxUsers capacity while distinct users are rejected',
  {timeout: 10_000},
  async () => {
    const {makeJoinRoom, rtcPolyfill} = createMemorySignalBus({
      delivery: 'microtask'
    })
    const [aliceUser, bobUser, carolUser] = await Promise.all([
      createUserIdentity(),
      createUserIdentity(),
      createUserIdentity()
    ])

    // 1. maxUsers: 1 admits multiple tabs of the solo user (same userId) while rejecting a second user
    const soloAppId = `max-users-multitab-1-${Date.now()}`
    const soloRoomId = 'solo-tabs-room'
    const [s1, s2, s3] = await createSortedJoinRooms(
      3,
      () => makeJoinRoom(),
      soloAppId
    )

    let aliceSolo1: Room | undefined
    let aliceSolo2: Room | undefined
    let bobRejected: Room | undefined
    try {
      const alice1Errors: RecordedError[] = []
      const alice2Errors: RecordedError[] = []
      const bobErrors: RecordedError[] = []

      aliceSolo1 = s1!.joinRoom(
        {appId: soloAppId, maxUsers: 1, identity: aliceUser, rtcPolyfill},
        soloRoomId
      )
      aliceSolo1.onError(err => alice1Errors.push(err))
      const {peerId: alice1PeerId} = await aliceSolo1.getSelf()

      aliceSolo2 = s2!.joinRoom(
        {appId: soloAppId, maxUsers: 1, identity: aliceUser, rtcPolyfill},
        soloRoomId
      )
      aliceSolo2.onError(err => alice2Errors.push(err))
      const {peerId: alice2PeerId} = await aliceSolo2.getSelf()

      await waitFor(
        () =>
          alice2PeerId in aliceSolo1!.getPeers() &&
          alice1PeerId in aliceSolo2!.getPeers(),
        3_000
      )
      assert.deepEqual(alice1Errors, [])
      assert.deepEqual(alice2Errors, [])
      assert.deepEqual(aliceSolo1.getUsers(), {})

      bobRejected = s3!.joinRoom(
        {appId: soloAppId, maxUsers: 1, identity: bobUser, rtcPolyfill},
        soloRoomId
      )
      bobRejected.onError(err => bobErrors.push(err))

      await waitFor(() => bobErrors.length >= 1, 3_000)
      await wait(100)
      assert.ok(bobErrors.every(e => e.code === 'room-full'))
      assert.deepEqual(bobRejected.getPeers(), {})
    } finally {
      await Promise.all([
        aliceSolo1?.leave().catch(() => {}),
        aliceSolo2?.leave().catch(() => {}),
        bobRejected?.leave().catch(() => {})
      ])
    }

    // 2. maxUsers: 2 at capacity (Alice + Bob) admits Bob's second tab while rejecting Carol
    const duoAppId = `max-users-multitab-2-${Date.now()}`
    const duoRoomId = 'duo-tabs-room'
    const [d1, d2, d3, d4] = await createSortedJoinRooms(
      4,
      () => makeJoinRoom(),
      duoAppId
    )

    let aliceRoom: Room | undefined
    let bobTab1: Room | undefined
    let bobTab2: Room | undefined
    let carolRejected: Room | undefined
    try {
      const bobTab2Errors: RecordedError[] = []
      const carolErrors: RecordedError[] = []

      aliceRoom = d1!.joinRoom(
        {appId: duoAppId, maxUsers: 2, identity: aliceUser, rtcPolyfill},
        duoRoomId
      )
      bobTab1 = d2!.joinRoom(
        {appId: duoAppId, maxUsers: 2, identity: bobUser, rtcPolyfill},
        duoRoomId
      )

      const [{peerId: alicePeerId}, {peerId: bob1PeerId}] = await Promise.all([
        aliceRoom.getSelf(),
        bobTab1.getSelf()
      ])
      await waitFor(
        () =>
          bob1PeerId in aliceRoom!.getPeers() &&
          alicePeerId in bobTab1!.getPeers(),
        3_000
      )

      // Bob opens a 2nd tab at 2/2 user capacity -> must be admitted by both Alice and Bob's 1st tab
      bobTab2 = d3!.joinRoom(
        {appId: duoAppId, maxUsers: 2, identity: bobUser, rtcPolyfill},
        duoRoomId
      )
      bobTab2.onError(err => bobTab2Errors.push(err))
      const {peerId: bob2PeerId} = await bobTab2.getSelf()

      await waitFor(
        () =>
          bob2PeerId in aliceRoom!.getPeers() &&
          bob2PeerId in bobTab1!.getPeers() &&
          alicePeerId in bobTab2!.getPeers() &&
          bob1PeerId in bobTab2!.getPeers(),
        3_000
      )
      assert.deepEqual(bobTab2Errors, [])
      assert.deepEqual(Object.keys(aliceRoom.getUsers()), [bobUser.userId])
      assert.equal(aliceRoom.getUsers()[bobUser.userId]!.peerIds.length, 2)

      // Distinct 3rd user Carol is still rejected with 'room-full'
      carolRejected = d4!.joinRoom(
        {appId: duoAppId, maxUsers: 2, identity: carolUser, rtcPolyfill},
        duoRoomId
      )
      carolRejected.onError(err => carolErrors.push(err))

      await waitFor(() => carolErrors.length >= 1, 3_000)
      await wait(100)
      assert.ok(carolErrors.every(e => e.code === 'room-full'))
      assert.deepEqual(carolRejected.getPeers(), {})
    } finally {
      await Promise.all([
        aliceRoom?.leave().catch(() => {}),
        bobTab1?.leave().catch(() => {}),
        bobTab2?.leave().catch(() => {}),
        carolRejected?.leave().catch(() => {})
      ])
    }
  }
)

void test(
  'Trystero: concurrent burst join caps each peer view at maxUsers without eviction of established peers',
  {timeout: 10_000},
  async () => {
    const {makeJoinRoom, rtcPolyfill} = createMemorySignalBus({
      delivery: 'microtask'
    })
    const appId = `max-users-burst-${Date.now()}`
    const roomId = 'burst-room'
    const slots = await createSortedJoinRooms(8, () => makeJoinRoom(), appId)
    const initialSlots = slots.slice(1, 6)
    const newcomerSlots = [slots[0]!, slots[6]!, slots[7]!]
    const peerIds = initialSlots.map(s => s.peerId)

    const stateByPeer = new Map<
      string,
      {
        room: Room
        errors: RecordedError[]
        joins: string[]
        leaves: string[]
      }
    >()

    // Launch all 5 peers concurrently in the same tick on an empty maxUsers: 2 room
    for (const {joinRoom, peerId} of initialSlots) {
      const errors: RecordedError[] = []
      const joins: string[] = []
      const leaves: string[] = []
      const room = joinRoom(
        {
          appId,
          maxUsers: 2,
          rtcPolyfill
        },
        roomId
      )
      room.onError(err => errors.push(err))
      room.onPeerJoin(({peerId}) => joins.push(peerId))
      room.onPeerLeave(({peerId}) => leaves.push(peerId))
      stateByPeer.set(peerId, {room, errors, joins, leaves})
    }

    const burstNewcomers: Room[] = []
    try {
      await waitFor(
        () =>
          peerIds.every(
            id =>
              Object.keys(stateByPeer.get(id)!.room.getPeers()).length === 1 ||
              stateByPeer.get(id)!.errors.length > 0
          ) &&
          peerIds.some(
            id => Object.keys(stateByPeer.get(id)!.room.getPeers()).length === 1
          ) &&
          peerIds.some(id => stateByPeer.get(id)!.errors.length > 0),
        4_000
      )

      await wait(120)

      // Every peer enforces its own local maxUsers: 2 cap (at most 1 remote peer/user)
      for (const peerId of peerIds) {
        const {room} = stateByPeer.get(peerId)!
        assert.ok(
          Object.keys(room.getPeers()).length <= 1,
          `${peerId} must never exceed 1 remote peer for maxUsers: 2`
        )
        assert.ok(
          Object.keys(room.getUsers()).length <= 1,
          `${peerId} must never exceed 1 remote user for maxUsers: 2`
        )
      }

      const pairA = peerIds.find(
        id => Object.keys(stateByPeer.get(id)!.room.getPeers()).length === 1
      )!
      assert.ok(pairA, 'at least one pair must form during burst join')
      const pairB = Object.keys(stateByPeer.get(pairA)!.room.getPeers())[0]!
      assert.deepEqual(Object.keys(stateByPeer.get(pairB)!.room.getPeers()), [
        pairA
      ])
      assert.deepEqual(stateByPeer.get(pairA)!.leaves, [])
      assert.deepEqual(stateByPeer.get(pairB)!.leaves, [])

      // Clean up the other 3 peers and test a burst of newcomers (including a lower peerId slots[0])
      // against the established pair (pairA, pairB)
      await Promise.all(
        peerIds
          .filter(id => id !== pairA && id !== pairB)
          .map(id =>
            stateByPeer
              .get(id)!
              .room.leave()
              .catch(() => {})
          )
      )
      await wait(60)

      const newcomerIds = newcomerSlots.map(s => s.peerId)
      const newcomerRooms = new Map<string, Room>()
      const newcomerErrors = new Map<string, RecordedError[]>()
      for (const {joinRoom, peerId: newcomerId} of newcomerSlots) {
        const errs: RecordedError[] = []
        newcomerErrors.set(newcomerId, errs)
        const room = joinRoom(
          {
            appId,
            maxUsers: 2,
            rtcPolyfill
          },
          roomId
        )
        room.onError(err => errs.push(err))
        newcomerRooms.set(newcomerId, room)
        burstNewcomers.push(room)
      }

      await waitFor(
        () =>
          newcomerIds.every(
            id =>
              newcomerErrors.get(id)!.length > 0 ||
              Object.keys(newcomerRooms.get(id)!.getPeers()).length === 1
          ) && newcomerIds.some(id => newcomerErrors.get(id)!.length > 0),
        3_000
      )
      await wait(100)

      for (const newcomerId of newcomerIds) {
        const errs = newcomerErrors.get(newcomerId)!
        const peers = Object.keys(newcomerRooms.get(newcomerId)!.getPeers())
        assert.ok(peers.length <= 1)
        if (peers.length === 0) {
          assert.ok(errs.length >= 1)
        }
        for (const err of errs) {
          assert.equal(err.code, 'room-full')
          assert.equal(err.message, 'room full')
        }
      }
      // Existing pair (pairA, pairB) is never evicted by lower peerId newcomer
      assert.deepEqual(Object.keys(stateByPeer.get(pairA)!.room.getPeers()), [
        pairB
      ])
      assert.deepEqual(Object.keys(stateByPeer.get(pairB)!.room.getPeers()), [
        pairA
      ])
      assert.deepEqual(stateByPeer.get(pairA)!.leaves, [])
      assert.deepEqual(stateByPeer.get(pairB)!.leaves, [])
    } finally {
      await Promise.all([
        ...[...stateByPeer.values()].map(({room}) =>
          room.leave().catch(() => {})
        ),
        ...burstNewcomers.map(room => room.leave().catch(() => {}))
      ])
    }
  }
)

void test(
  'Trystero: per-link rejection semantics: one peer claiming room full does not force newcomer to leave or drop other peers even when newcomer has maxUsers set',
  {timeout: 10_000},
  async () => {
    const {makeJoinRoom, rtcPolyfill} = createMemorySignalBus({
      delivery: 'microtask'
    })
    const appId = `max-users-asym-${Date.now()}`
    const roomId = 'asym-room'

    const [guest1Slot, guest2Slot, hostSlot] = await createSortedJoinRooms(
      3,
      () => makeJoinRoom(),
      appId
    )

    let hostRoom: Room | undefined
    let guest1Room: Room | undefined
    let guest2Room: Room | undefined
    try {
      hostRoom = hostSlot!.joinRoom(
        {
          appId,
          maxUsers: 2,
          rtcPolyfill
        },
        roomId
      )
      const guest1Joins: string[] = []
      guest1Room = guest1Slot!.joinRoom(
        {
          appId,
          // guest-1 omits maxUsers and must not adopt unauthenticated maxUsers from host-peer
          rtcPolyfill
        },
        roomId
      )
      guest1Room.onPeerJoin(({peerId}: {peerId: string}) =>
        guest1Joins.push(peerId)
      )

      const [{peerId: hostPeerId}, {peerId: guest1PeerId}] = await Promise.all([
        hostRoom.getSelf(),
        guest1Room.getSelf()
      ])
      await waitFor(
        () =>
          guest1Joins.includes(hostPeerId) &&
          Object.keys(hostRoom!.getPeers()).includes(guest1PeerId),
        3_000
      )

      const guest2Errors: RecordedError[] = []
      guest2Room = guest2Slot!.joinRoom(
        {
          appId,
          // guest-2 has maxUsers: 3 and must not self-evict or drop guest-1 when host-peer rejects as full
          maxUsers: 3,
          rtcPolyfill
        },
        roomId
      )
      guest2Room.onError(err => guest2Errors.push(err))

      const {peerId: guest2PeerId} = await guest2Room.getSelf()
      await waitFor(
        () =>
          guest2Errors.some(e => e.peerId === hostPeerId) &&
          guest1Joins.includes(guest2PeerId) &&
          Object.keys(guest2Room!.getPeers()).includes(guest1PeerId),
        3_000
      )
      assert.equal(guest2Errors[0]!.code, 'room-full')
      assert.equal(guest2Errors[0]!.message, 'room full')
      assert.equal(guest2Errors[0]!.peerId, hostPeerId)
      assert.deepEqual(Object.keys(hostRoom.getPeers()), [guest1PeerId])
      assert.ok(Object.keys(guest1Room.getPeers()).includes(guest2PeerId))
      assert.ok(Object.keys(guest2Room.getPeers()).includes(guest1PeerId))
    } finally {
      await Promise.all([
        hostRoom?.leave().catch(() => {}),
        guest1Room?.leave().catch(() => {}),
        guest2Room?.leave().catch(() => {})
      ])
    }
  }
)

void test(
  'Trystero: maxUsers with password checks password before capacity',
  {timeout: 10_000},
  async () => {
    const {makeJoinRoom, rtcPolyfill} = createMemorySignalBus({
      delivery: 'microtask'
    })
    const appId = `max-users-pw-hs-${Date.now()}`
    const roomId = 'secure-duel'

    const [slotA, slotB, slotC, slotWrongPw] = await createSortedJoinRooms(
      4,
      () => makeJoinRoom(),
      appId
    )

    let roomA: Room | undefined
    let roomB: Room | undefined
    let wrongPwRoom: Room | undefined
    let rightPwFullRoom: Room | undefined
    try {
      roomA = slotA!.joinRoom(
        {
          appId,
          password: 'correct-password',
          maxUsers: 2,
          rtcPolyfill
        },
        roomId
      )

      roomB = slotB!.joinRoom(
        {
          appId,
          password: 'correct-password',
          maxUsers: 2,
          rtcPolyfill
        },
        roomId
      )

      const [{peerId: peerA}, {peerId: peerB}] = await Promise.all([
        roomA.getSelf(),
        roomB.getSelf()
      ])
      await waitFor(
        () =>
          Object.keys(roomA!.getPeers()).includes(peerB) &&
          Object.keys(roomB!.getPeers()).includes(peerA),
        3_000
      )

      // 1. Peer with WRONG password must NOT receive 'room full' (must fail with password error)
      const wrongPwErrors: RecordedError[] = []
      wrongPwRoom = slotWrongPw!.joinRoom(
        {
          appId,
          password: 'wrong-password',
          maxUsers: 2,
          rtcPolyfill
        },
        roomId
      )
      wrongPwRoom.onError(err => wrongPwErrors.push(err))

      await waitFor(() => wrongPwErrors.length > 0, 3_000)
      assert.ok(
        wrongPwErrors.every(e => e.code === 'decrypt-failed'),
        'wrong-password peer must not learn that the room is full'
      )
      await wrongPwRoom.leave().catch(() => {})

      // 2. Peer with CORRECT password when room is full receives 'room full'
      const fullErrors: RecordedError[] = []
      rightPwFullRoom = slotC!.joinRoom(
        {
          appId,
          password: 'correct-password',
          maxUsers: 2,
          rtcPolyfill
        },
        roomId
      )
      rightPwFullRoom.onError(err => fullErrors.push(err))

      await waitFor(() => fullErrors.length > 0, 3_000)
      assert.ok(fullErrors.length >= 1 && fullErrors.length <= 2)
      for (const err of fullErrors) {
        assert.equal(err.code, 'room-full')
        assert.equal(err.message, 'room full')
      }
    } finally {
      await Promise.all([
        roomA?.leave().catch(() => {}),
        roomB?.leave().catch(() => {}),
        wrongPwRoom?.leave().catch(() => {}),
        rightPwFullRoom?.leave().catch(() => {})
      ])
    }
  }
)

void test(
  'Trystero: enforces maxUsers across multi-hop overlay topologies',
  {timeout: 10_000},
  async () => {
    const {makeJoinRoom, rtcPolyfill} = createMemorySignalBus({
      delivery: 'microtask'
    })
    const appId = `max-users-overlay-${Date.now()}`
    const roomId = 'tree-room'
    const scaleConfig = {maxDirectPeers: 4}

    const slots = await createSortedJoinRooms(7, () => makeJoinRoom(), appId)
    const rooms: Room[] = []
    let seventhRoom: Room | undefined

    try {
      for (const {joinRoom} of slots.slice(0, 6)) {
        const room = joinRoom(
          {
            appId,
            maxUsers: 6,
            use: [scale(scaleConfig)],
            rtcPolyfill
          },
          roomId
        )
        rooms.push(room)
      }

      await waitFor(
        () => rooms.every(r => Object.keys(r.getPeers()).length === 5),
        4_000
      )

      // 7th peer tries to join the 6-user multi-hop overlay room
      const seventhErrors: RecordedError[] = []
      seventhRoom = slots[6]!.joinRoom(
        {
          appId,
          maxUsers: 6,
          use: [scale(scaleConfig)],
          rtcPolyfill
        },
        roomId
      )
      seventhRoom.onError(err => seventhErrors.push(err))

      await waitFor(() => seventhErrors.length > 0, 3_000)
      assert.ok(seventhErrors.length >= 1)
      for (const err of seventhErrors) {
        assert.equal(err.code, 'room-full')
        assert.equal(err.message, 'room full')
      }
      for (const r of rooms) {
        assert.equal(Object.keys(r.getPeers()).length, 5)
      }
    } finally {
      await Promise.all([
        ...rooms.map(r => r.leave().catch(() => {})),
        seventhRoom?.leave().catch(() => {})
      ])
    }
  }
)
