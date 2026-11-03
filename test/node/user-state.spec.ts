import assert from 'node:assert/strict'
import test from './test.ts'
import {
  type RoomError,
  type UserIdentity,
  createUserIdentity
} from '../../packages/core/src/index.ts'
import {decodeBytes} from '../../packages/core/src/utils.ts'
import {createMemorySignalBus} from './memory-rtc.ts'
import {wait, waitFor} from './peer-harness.ts'

void test('makeUserState semantics: null vs explicit default, has(), frozen reference-stable getAll(), self inclusion, clear() tombstones, write coalescing, and multi-tab convergence', async () => {
  const {makeJoinRoom, rtcPolyfill} = createMemorySignalBus()
  const aliceId = await createUserIdentity()
  const bobId = await createUserIdentity()

  let aliceSignCalls = 0
  const instrumentedAliceId: UserIdentity = {
    ...aliceId,
    sign: async payload => {
      aliceSignCalls++
      return aliceId.sign(payload)
    }
  }

  const joinAliceTab1 = makeJoinRoom('u-alice-1')
  const joinAliceTab2 = makeJoinRoom('u-alice-2')
  const joinBob = makeJoinRoom('u-bob-1')

  const aliceTab1 = joinAliceTab1(
    {appId: 'user-state-app', rtcPolyfill, identity: instrumentedAliceId},
    'lobby'
  )
  const bobRoom = joinBob(
    {appId: 'user-state-app', rtcPolyfill, identity: bobId},
    'lobby'
  )

  const statusA1 = aliceTab1.makeUserState<string | null>('status')
  const statusBob = bobRoom.makeUserState<string | null>('status')
  const counterA1 = aliceTab1.makeUserState('clicks', 0)
  const counterBob = bobRoom.makeUserState('clicks', 0)

  // Before publishing: has() is false, get() returns initialValue, getAll() is empty & frozen & reference-stable
  await aliceTab1.ready
  assert.equal(statusA1.has(), false)
  assert.equal(statusA1.get(), null)
  assert.equal(counterA1.has(), false)
  assert.equal(counterA1.get(), 0)

  const emptySnap1 = statusA1.getAll()
  const emptySnap2 = statusA1.getAll()
  assert.equal(Object.is(emptySnap1, emptySnap2), true)
  assert.equal(Object.isFrozen(emptySnap1), true)
  assert.deepEqual(emptySnap1, {})

  await waitFor(() => Object.keys(aliceTab1.getUsers()).length === 1)

  // Explicit null publish sets has() === true and includes self in getAll()
  await statusA1.set(null)
  assert.equal(statusA1.has(), true)
  assert.equal(statusA1.get(), null)
  const selfSnap = statusA1.getAll()
  assert.notEqual(selfSnap, emptySnap1)
  assert.equal(Object.is(selfSnap, statusA1.getAll()), true)
  assert.deepEqual(selfSnap, {[aliceId.userId]: null})

  await waitFor(() => statusBob.has(aliceId.userId))
  assert.equal(statusBob.get(aliceId.userId), null)

  // Pending Batch Fold write coalescing: 50 rapid synchronous functional updates fold into <= 2 ECDSA signatures!
  const signsBeforeBurst = aliceSignCalls
  const burstPromises = Array.from({length: 50}, () =>
    counterA1.set(n => n + 1)
  )
  await Promise.all(burstPromises)
  const signsUsed = aliceSignCalls - signsBeforeBurst
  assert.ok(
    signsUsed >= 1 && signsUsed <= 2,
    `expected <= 2 signatures for 50 synchronous updates, got ${signsUsed}`
  )
  assert.equal(counterA1.get(), 50)
  await waitFor(() => counterBob.get(aliceId.userId) === 50)

  // Lookup by peerId as well as userId
  const aliceSelf = await aliceTab1.getSelf()
  assert.equal(counterA1.get(aliceSelf.peerId), 50)
  assert.equal(counterBob.get(aliceSelf.peerId), 50)
  assert.equal(counterA1.getMeta()?.self, true)
  assert.equal(counterBob.getMeta(aliceId.userId)?.self, false)

  // Multi-tab: Alice opens Tab 2 WITHOUT calling set() — must NOT clobber Tab 1, and receives Tab 1's state!
  await statusA1.set('coding')
  await waitFor(() => statusBob.get(aliceId.userId) === 'coding')

  const aliceTab2 = joinAliceTab2(
    {appId: 'user-state-app', rtcPolyfill, identity: aliceId},
    'lobby'
  )
  const statusA2 = aliceTab2.makeUserState<string | null>('status')
  await waitFor(() => statusA2.get() === 'coding')
  assert.equal(statusA2.has(), true)
  assert.equal(statusBob.get(aliceId.userId), 'coding')

  // Tab 2 updates Alice's state -> Tab 1 and Bob both converge
  await statusA2.set('in-tab-2')
  await waitFor(
    () =>
      statusA1.get() === 'in-tab-2' &&
      statusBob.get(aliceId.userId) === 'in-tab-2'
  )

  // Closing Tab 1 while Tab 2 remains open must NOT evict Alice's presence-scoped state on Bob or Tab 2!
  let bobSawAliceLeave = false
  bobRoom.onUserLeave(({userId}) => {
    if (userId === aliceId.userId) {
      bobSawAliceLeave = true
    }
  })
  await aliceTab1.leave()
  await wait(80)
  assert.equal(bobSawAliceLeave, false)
  assert.equal(statusBob.get(aliceId.userId), 'in-tab-2')
  assert.equal(statusA2.get(), 'in-tab-2')

  // clear() publishes a signed tombstone removing the entry everywhere
  const removalsOnBob: boolean[] = []
  statusBob.onChange((val, ctx) => {
    if (ctx.userId === aliceId.userId && ctx.removed) {
      assert.equal(val, undefined)
      assert.equal(ctx.prev, 'in-tab-2')
      removalsOnBob.push(true)
    }
  })
  await statusA2.clear()
  assert.equal(statusA2.has(), false)
  assert.equal(statusA2.get(), null)
  assert.deepEqual(statusA2.getAll(), {})
  await waitFor(() => !statusBob.has(aliceId.userId))
  assert.equal(removalsOnBob.length, 1)
  assert.deepEqual(statusBob.getAll(), {})

  await Promise.all([aliceTab2.leave(), bobRoom.leave()])
})

void test('Presence ordering: pre-join flush populates userState before onUserJoin/onPeerJoin, state remains readable inside onUserLeave then evicts, and room-full peers never leak userState', async () => {
  const {makeJoinRoom, rtcPolyfill} = createMemorySignalBus()
  const hostId = await createUserIdentity()
  const guestId = await createUserIdentity()
  const extraId = await createUserIdentity()

  const join1 = makeJoinRoom('ord-1')
  const join2 = makeJoinRoom('ord-2')
  const join3 = makeJoinRoom('ord-3')

  const room1 = join1(
    {appId: 'order-app', rtcPolyfill, identity: hostId, maxUsers: 2},
    'duel'
  )
  const name1 = room1.makeUserState('name', 'Stranger')
  void name1.set('HostOne')

  let nameAtPeerJoin = ''
  let nameAtUserJoin = ''
  let nameDuringUserLeave = ''
  let snapHadGuestDuringLeave = false

  room1.onPeerJoin(({userId}) => {
    if (userId === guestId.userId) {
      nameAtPeerJoin = name1.get(userId)
    }
  })
  room1.onUserJoin(({userId}) => {
    if (userId === guestId.userId) {
      nameAtUserJoin = name1.get(userId)
    }
  })
  room1.onUserLeave(({userId}) => {
    if (userId === guestId.userId) {
      nameDuringUserLeave = name1.get(userId)
      snapHadGuestDuringLeave = userId in name1.getAll()
    }
  })

  // Guest sets name synchronously right after joinRoom() -> piggybacked on @_hsready!
  const room2 = join2(
    {appId: 'order-app', rtcPolyfill, identity: guestId, maxUsers: 2},
    'duel'
  )
  const name2 = room2.makeUserState('name', 'Stranger')
  void name2.set('GuestTwo')

  let hostNameAtGuestJoin = ''
  room2.onUserJoin(({userId}) => {
    if (userId === hostId.userId) {
      hostNameAtGuestJoin = name2.get(userId)
    }
  })

  await waitFor(
    () =>
      Object.keys(room1.getUsers()).length === 1 &&
      Object.keys(room2.getUsers()).length === 1
  )

  assert.equal(
    nameAtPeerJoin,
    'GuestTwo',
    'userState must be populated synchronously inside onPeerJoin'
  )
  assert.equal(
    nameAtUserJoin,
    'GuestTwo',
    'userState must be populated synchronously inside onUserJoin'
  )
  assert.equal(
    hostNameAtGuestJoin,
    'HostOne',
    'initiator userState must also be populated inside responder onUserJoin'
  )

  // 3rd user attempts to join a full room (maxUsers: 2) with pre-join userState -> rejected, never leaks!
  const errors3: RoomError[] = []
  const room3 = join3(
    {appId: 'order-app', rtcPolyfill, identity: extraId, maxUsers: 2},
    'duel'
  )
  room3.onError(err => errors3.push(err))
  const name3 = room3.makeUserState('name', 'Stranger')
  void name3.set('IntruderThree')

  await waitFor(() => errors3.some(e => e.code === 'room-full'))
  assert.equal(name1.has(extraId.userId), false)
  assert.equal(name2.has(extraId.userId), false)
  await room3.leave()

  // Guest leaves -> readable DURING onUserLeave, and evicted immediately after!
  const leaveEvictions: Array<{prev: string; removed: boolean}> = []
  name1.onChange((val, ctx) => {
    if (ctx.userId === guestId.userId && ctx.removed) {
      assert.equal(val, undefined)
      leaveEvictions.push({prev: ctx.prev, removed: ctx.removed})
    }
  })

  await room2.leave()
  await waitFor(() => Object.keys(room1.getUsers()).length === 0)

  assert.equal(nameDuringUserLeave, 'GuestTwo')
  assert.equal(snapHadGuestDuringLeave, true)
  assert.equal(name1.has(guestId.userId), false)
  assert.equal(name1.get(guestId.userId), 'Stranger')
  assert.deepEqual(leaveEvictions, [{prev: 'GuestTwo', removed: true}])

  await room1.leave()
})

void test('Idle-room silence, microtask-batched late registration re-pull, declared passive: true relay peer, and byte-paged >256 KiB sync', async () => {
  const {makeJoinRoom, rtcPolyfill, setSendObserver} = createMemorySignalBus()
  const u1 = await createUserIdentity()
  const u2 = await createUserIdentity()

  // 1. Idle rooms (0 makeState / makeUserState calls) send ZERO @_state control frames on join
  let stateFramesOnIdleJoin = 0
  setSendObserver(payload => {
    if (!(payload instanceof ArrayBuffer) || payload.byteLength < 36) {
      return
    }
    const header = decodeBytes(new Uint8Array(payload, 2, 32)).replace(
      /\0+$/,
      ''
    )
    if (header === '@_state') {
      stateFramesOnIdleJoin++
    }
  })

  const idleA = makeJoinRoom('idle-a')(
    {appId: 'simplified-sync-app', rtcPolyfill, identity: u1},
    'idle-and-late'
  )
  const idleB = makeJoinRoom('idle-b')(
    {appId: 'simplified-sync-app', rtcPolyfill, identity: u2},
    'idle-and-late'
  )

  try {
    await waitFor(
      () =>
        Object.keys(idleA.getUsers()).length === 1 &&
        Object.keys(idleB.getUsers()).length === 1
    )
    await wait(50)
    assert.equal(
      stateFramesOnIdleJoin,
      0,
      'idle rooms with no registered state slots must send zero @_state frames'
    )

    // 2. Late registration after peers are already connected: A registers & writes, then B registers later and hydrates via batched re-pull
    const sharedA = idleA.makeState('doc', 'init')
    const nickA = idleA.makeUserState('nick', '')
    await sharedA.set('written-before-B-registered')
    await nickA.set('AliceLate')
    await wait(30)

    let pullsFromB = 0
    setSendObserver(payload => {
      if (!(payload instanceof ArrayBuffer) || payload.byteLength < 36) {
        return
      }
      const header = decodeBytes(new Uint8Array(payload, 2, 32)).replace(
        /\0+$/,
        ''
      )
      if (header === '@_state') {
        const body = decodeBytes(new Uint8Array(payload, 36))
        if (body.includes('"t":"pull"')) {
          pullsFromB++
        }
      }
    })

    const sharedB = idleB.makeState('doc', 'init')
    const nickB = idleB.makeUserState('nick', '')

    await waitFor(
      () =>
        sharedB.get() === 'written-before-B-registered' &&
        nickB.get(u1.userId) === 'AliceLate'
    )
    assert.equal(
      pullsFromB,
      1,
      'synchronous late makeState + makeUserState calls must coalesce into a single batched pull'
    )
  } finally {
    setSendObserver(null)
    await Promise.all([idleA.leave(), idleB.leave()])
  }

  // 3. Declared-namespace passive: true relay peer persists shared state across empty rooms while presence-scoped userState evicts on leave, plus >256 KiB byte-paged sync
  const passiveRelay = makeJoinRoom('relay-passive')(
    {appId: 'simplified-sync-app', rtcPolyfill, passive: true},
    'persistent-room'
  )
  passiveRelay.makeState('board', 'empty')
  for (let i = 0; i < 6; i++) {
    passiveRelay.makeState(`big-${i}`, '', {maxBytes: 64 * 1024})
  }
  await passiveRelay.ready

  const room1 = makeJoinRoom('ret-u1')(
    {appId: 'simplified-sync-app', rtcPolyfill, identity: u1},
    'persistent-room'
  )
  const board1 = room1.makeState('board', 'empty')
  const cursor1 = room1.makeUserState<{x: number} | null>('cursor')
  const bigChunk = 'x'.repeat(50 * 1024)
  const bigWriters = Array.from({length: 6}, (_, i) =>
    room1.makeState(`big-${i}`, '', {maxBytes: 64 * 1024})
  )

  await waitFor(() => Object.keys(room1.getPeers()).length === 1)
  await board1.set('pinned-by-u1')
  await cursor1.set({x: 42})
  for (let i = 0; i < 6; i++) {
    await bigWriters[i]!.set(`${i}:${bigChunk}`)
  }
  await wait(50)
  await room1.leave()
  await waitFor(() => Object.keys(passiveRelay.getUsers()).length === 0)

  const lateRoom = makeJoinRoom('ret-late')(
    {appId: 'simplified-sync-app', rtcPolyfill},
    'persistent-room'
  )
  const boardLate = lateRoom.makeState('board', 'empty')
  const cursorLate = lateRoom.makeUserState<{x: number} | null>('cursor')
  const bigReaders = Array.from({length: 6}, (_, i) =>
    lateRoom.makeState(`big-${i}`, '', {maxBytes: 64 * 1024})
  )

  await waitFor(
    () =>
      boardLate.get() === 'pinned-by-u1' &&
      bigReaders.every((s, i) => s.get() === `${i}:${bigChunk}`),
    5_000
  )
  assert.equal(
    cursorLate.has(u1.userId),
    false,
    'presence-scoped userState must be evicted when author disconnects'
  )

  await Promise.all([lateRoom.leave(), passiveRelay.leave()])
})
