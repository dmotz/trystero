import assert from 'node:assert/strict'
import test from './test.ts'
import {
  type Room,
  type RoomError,
  scale
} from '../../packages/core/src/index.ts'
import {createMemorySignalBus} from './memory-rtc.ts'
import {createSortedJoinRooms, wait, waitFor} from './peer-harness.ts'

type RecordedError = RoomError & {peerId?: string | undefined}

void test('Trystero: validates config.limit as a positive safe integer', () => {
  const {makeJoinRoom, rtcPolyfill} = createMemorySignalBus({
    delivery: 'microtask'
  })
  const joinRoom = makeJoinRoom()

  for (const invalidLimit of [0, -1, -100, 1.5, NaN, Infinity, -Infinity]) {
    assert.throws(
      () =>
        joinRoom(
          {
            appId: 'limit-validation-app',
            limit: invalidLimit,
            rtcPolyfill
          },
          'room-1'
        ),
      /Trystero: limit must be a positive safe integer/
    )
  }
})

void test(
  'Trystero: limit: 1 allows a solo occupant, rejects subsequent joiners with "room full", and allows join after occupant leaves',
  {timeout: 10_000},
  async () => {
    const {makeJoinRoom, rtcPolyfill} = createMemorySignalBus({
      delivery: 'microtask'
    })
    const appId = `limit-1-${Date.now()}`
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
        limit: 1,
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
          limit: 1,
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
        'rejected joiner should receive onError once'
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

      // Host leaves and rejected joiner cleans up; now a new peer can join the limit: 1 room
      await lateRoom.leave()
      await hostRoom.leave()
      await wait(50)

      const nextJoin = makeJoinRoom('peer-next')
      const nextErrors: RecordedError[] = []
      nextRoom = nextJoin(
        {
          appId,
          limit: 1,
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
  'Trystero: limit: 2 admits 2 peers, rejects a 3rd with "room full", and admits a 4th after one peer leaves',
  {timeout: 10_000},
  async () => {
    const {makeJoinRoom, rtcPolyfill} = createMemorySignalBus({
      delivery: 'microtask'
    })
    const appId = `limit-2-seq-${Date.now()}`
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
          limit: 2,
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
          limit: 2,
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
          limit: 2,
          rtcPolyfill
        },
        roomId
      )
      roomC.onError(err => errorsC.push(err))
      roomC.onPeerJoin(({peerId}: {peerId: string}) => joinsC.push(peerId))

      await waitFor(() => errorsC.length > 0, 3_000)
      await wait(120)

      assert.equal(
        errorsC.length,
        1,
        'Peer C must receive onError exactly once'
      )
      assert.equal(errorsC[0]!.code, 'room-full')
      assert.equal(errorsC[0]!.message, 'room full')
      assert.equal(errorsC[0]!.appId, appId)
      assert.equal(errorsC[0]!.roomId, roomId)
      assert.ok(
        errorsC[0]!.peerId === peerA || errorsC[0]!.peerId === peerB,
        'rejecting peerId should be one of the existing members'
      )
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

      // Peer D joins and should be admitted into the newly opened seat!
      roomD = joinD(
        {
          appId,
          limit: 2,
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
  'Trystero: advisory burst join caps each peer view at limit without self-eviction, and burst newcomers cannot evict existing peers',
  {timeout: 10_000},
  async () => {
    const {makeJoinRoom, rtcPolyfill} = createMemorySignalBus({
      delivery: 'microtask'
    })
    const appId = `limit-burst-${Date.now()}`
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

    // Launch all 5 peers concurrently in the same tick on an empty limit: 2 room
    for (const {joinRoom, peerId} of initialSlots) {
      const errors: RecordedError[] = []
      const joins: string[] = []
      const leaves: string[] = []
      const room = joinRoom(
        {
          appId,
          limit: 2,
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

      // Every peer enforces its own local limit: 2 cap (at most 1 remote peer/user)
      for (const peerId of peerIds) {
        const {room} = stateByPeer.get(peerId)!
        assert.ok(
          Object.keys(room.getPeers()).length <= 1,
          `${peerId} must never exceed 1 remote peer for limit: 2`
        )
        assert.ok(
          Object.keys(room.getUsers()).length <= 1,
          `${peerId} must never exceed 1 remote user for limit: 2`
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
      assert.deepEqual(stateByPeer.get(pairA)!.errors, [])
      assert.deepEqual(stateByPeer.get(pairB)!.errors, [])
      assert.deepEqual(stateByPeer.get(pairA)!.leaves, [])
      assert.deepEqual(stateByPeer.get(pairB)!.leaves, [])

      // Clean up the other 3 peers and test a burst of newcomers (including a lower peerId 'peer-0')
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
            limit: 2,
            rtcPolyfill
          },
          roomId
        )
        room.onError(err => errs.push(err))
        newcomerRooms.set(newcomerId, room)
        burstNewcomers.push(room)
      }

      // Two of the 3 burst newcomers may pair with each other (suppressing room-full if already at limit: 2),
      // while any unseated newcomer must report 'room full' (at least 1 of the 3).
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
        assert.ok(errs.length <= 1)
        if (peers.length === 0) {
          assert.equal(errs.length, 1)
        }
        if (errs.length === 1) {
          assert.equal(errs[0]!.code, 'room-full')
          assert.equal(errs[0]!.message, 'room full')
        }
      }
      // Existing pair (pairA, pairB) is never evicted by lower peerId 'peer-0'
      assert.deepEqual(Object.keys(stateByPeer.get(pairA)!.room.getPeers()), [
        pairB
      ])
      assert.deepEqual(Object.keys(stateByPeer.get(pairB)!.room.getPeers()), [
        pairA
      ])
      assert.deepEqual(stateByPeer.get(pairA)!.errors, [])
      assert.deepEqual(stateByPeer.get(pairB)!.errors, [])
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
  'Trystero: per-link rejection semantics: one peer claiming room full does not force newcomer to leave or drop other peers even when newcomer has limit set',
  {timeout: 10_000},
  async () => {
    const {makeJoinRoom, rtcPolyfill} = createMemorySignalBus({
      delivery: 'microtask'
    })
    const appId = `limit-asym-${Date.now()}`
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
          limit: 2,
          rtcPolyfill
        },
        roomId
      )
      const guest1Joins: string[] = []
      guest1Room = guest1Slot!.joinRoom(
        {
          appId,
          // guest-1 omits limit and must not adopt unauthenticated limit from host-peer
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
          // guest-2 has limit: 3 and must not self-evict or drop guest-1 when host-peer rejects as full
          limit: 3,
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
  'Trystero: limit with password checks password before capacity',
  {timeout: 10_000},
  async () => {
    const {makeJoinRoom, rtcPolyfill} = createMemorySignalBus({
      delivery: 'microtask'
    })
    const appId = `limit-pw-hs-${Date.now()}`
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
          limit: 2,
          rtcPolyfill
        },
        roomId
      )

      roomB = slotB!.joinRoom(
        {
          appId,
          password: 'correct-password',
          limit: 2,
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
          limit: 2,
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
          limit: 2,
          rtcPolyfill
        },
        roomId
      )
      rightPwFullRoom.onError(err => fullErrors.push(err))

      await waitFor(() => fullErrors.length > 0, 3_000)
      assert.equal(fullErrors.length, 1)
      assert.equal(fullErrors[0]!.code, 'room-full')
      assert.equal(fullErrors[0]!.message, 'room full')
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
  'Trystero: enforces limit across multi-hop overlay topologies',
  {timeout: 10_000},
  async () => {
    const {makeJoinRoom, rtcPolyfill} = createMemorySignalBus({
      delivery: 'microtask'
    })
    const appId = `limit-overlay-${Date.now()}`
    const roomId = 'tree-room'
    const scaleConfig = {mode: 'gossip' as const, maxConnections: 4}

    const slots = await createSortedJoinRooms(7, () => makeJoinRoom(), appId)
    const rooms: Room[] = []
    let fifthRoom: Room | undefined

    try {
      for (const {joinRoom} of slots.slice(0, 6)) {
        const room = joinRoom(
          {
            appId,
            limit: 6,
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

      // 7th peer tries to join the 6-peer multi-hop overlay room
      const fifthErrors: RecordedError[] = []
      fifthRoom = slots[6]!.joinRoom(
        {
          appId,
          limit: 6,
          use: [scale(scaleConfig)],
          rtcPolyfill
        },
        roomId
      )
      fifthRoom.onError(err => fifthErrors.push(err))

      await waitFor(() => fifthErrors.length > 0, 3_000)
      assert.equal(fifthErrors.length, 1)
      assert.equal(fifthErrors[0]!.code, 'room-full')
      assert.equal(fifthErrors[0]!.message, 'room full')
      for (const r of rooms) {
        assert.equal(Object.keys(r.getPeers()).length, 5)
      }
    } finally {
      await Promise.all([
        ...rooms.map(r => r.leave().catch(() => {})),
        fifthRoom?.leave().catch(() => {})
      ])
    }
  }
)
