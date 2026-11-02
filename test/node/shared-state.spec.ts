import assert from 'node:assert/strict'
import test from './test.ts'
import {
  type JsonValue,
  type Room,
  type SharedState,
  type UserIdentity,
  type UserState,
  createUserIdentity,
  roles
} from '../../packages/core/src/index.ts'
import {decodeBytes} from '../../packages/core/src/utils.ts'
import {createMemorySignalBus} from './memory-rtc.ts'
import {wait, waitFor} from './peer-harness.ts'

void test('Role gating on makeState and makeUserState: runtime requires roles() plugin when omitted, and RoomWithPlugins remains assignable to Room', () => {
  const {makeJoinRoom, rtcPolyfill} = createMemorySignalBus()
  const joinRoom = makeJoinRoom()

  const openRoom = joinRoom(
    {appId: 'ts-check-app', rtcPolyfill},
    'open-ts-room'
  )
  const implicitNullState: SharedState<JsonValue> =
    openRoom.makeState('implicit')
  assert.equal(implicitNullState.get(), null)

  const implicitNullUser: UserState<JsonValue> =
    openRoom.makeUserState('implicit-u')
  assert.equal(implicitNullUser.get(), null)

  assert.throws(() => {
    openRoom.makeState('bad-roles', 0, {roles: ['admin']})
  }, /requires roles\(\)/)

  assert.throws(() => {
    openRoom.makeUserState('bad-user-roles', 0, {roles: ['admin']})
  }, /requires roles\(\)/)

  const rolesRoom = joinRoom(
    {appId: 'ts-check-app', rtcPolyfill, use: [roles({selfAsAdmin: true})]},
    'roles-ts-room'
  )
  const gatedState = rolesRoom.makeState('ok-roles', 0, {roles: ['admin']})
  const openInRoles = rolesRoom.makeState('open-override', 0, {roles: '*'})
  const gatedUser = rolesRoom.makeUserState('ok-user-roles', '', {
    roles: ['speaker']
  })
  assert.equal(gatedState.get(), 0)
  assert.equal(openInRoles.get(), 0)
  assert.equal(gatedUser.get(), '')

  // Variance check: RoomWithPlugins<[typeof roles(...)]> is assignable to base Room
  const asBaseRoom: Room = rolesRoom
  assert.equal(typeof asBaseRoom.makeState, 'function')
  assert.equal(typeof asBaseRoom.makeUserState, 'function')

  void openRoom.leave()
  void rolesRoom.leave()
})

void test('Open makeState (without roles()): synchronous availability, null default, multi-member convergence, late-joiner relay after author leaves, validate, maxBytes, and onChange options', async () => {
  const {makeJoinRoom, rtcPolyfill} = createMemorySignalBus()
  const joinA = makeJoinRoom('open-state-a')
  const joinB = makeJoinRoom('open-state-b')
  const joinC = makeJoinRoom('open-state-c')

  const roomA = joinA({appId: 'open-state-app', rtcPolyfill}, 'room-1')
  const roomB = joinB({appId: 'open-state-app', rtcPolyfill}, 'room-1')

  // Available synchronously right after joinRoom() without awaiting room.ready
  const implicitA = roomA.makeState('implicit-ns')
  assert.equal(implicitA.get(), null)
  assert.equal(implicitA.getMeta(), null)

  // lockMethods prevents direct property overwrite on onChange
  assert.throws(() => {
    ;(implicitA as unknown as {onChange: unknown}).onChange = () => {}
  })

  assert.throws(
    () => roomA.makeState('too-big-cfg', 0, {maxBytes: 128 * 1024}),
    /maxBytes/
  )

  const counterA = roomA.makeState(
    'counter',
    {count: 0, note: 'init'},
    {
      maxBytes: 256,
      validate: next => next.count >= 0
    }
  )
  const counterB = roomB.makeState(
    'counter',
    {count: 0, note: 'init'},
    {
      maxBytes: 256,
      validate: next => next.count >= 0
    }
  )

  const seenB: Array<{val: {count: number; note: string}; prevCount: number}> =
    []
  counterB.onChange((val, ctx) => {
    seenB.push({val, prevCount: ctx.prev.count})
  })

  await waitFor(() => Object.keys(roomA.getUsers()).length === 1)

  // Any member can write in open mode
  await counterA.set({count: 1, note: 'from-a'})
  await waitFor(() => counterB.get().count === 1)
  assert.deepEqual(counterB.get(), {count: 1, note: 'from-a'})

  const selfA = await roomA.getSelf()
  assert.equal(counterB.getMeta()?.userId, selfA.userId)
  assert.equal(counterB.getMeta()?.peerId, selfA.peerId)
  assert.deepEqual(counterB.getMeta()?.roles, [])

  // Bob updates the same shared state without roles()
  await counterB.set(prev => ({count: prev.count + 4, note: 'from-b'}))
  await waitFor(() => counterA.get().count === 5)
  assert.deepEqual(counterA.get(), {count: 5, note: 'from-b'})
  assert.equal(seenB.length, 2)
  assert.equal(seenB[1]?.prevCount, 1)

  // Local validation failure and maxBytes failure reject
  await assert.rejects(
    () => counterA.set({count: -1, note: 'bad'}),
    /validation failed/
  )
  await assert.rejects(
    () => counterA.set({count: 6, note: 'x'.repeat(400)}),
    /maxBytes/
  )

  // Remote validation divergence defense: roomA writes via a permissive view on another namespace
  const strictB = roomB.makeState<number>('strict-even', 0, {
    validate: next => next % 2 === 0
  })
  const laxA = roomA.makeState<number>('strict-even', 0)
  await laxA.set(3) // invalid on B
  await wait(40)
  assert.equal(strictB.get(), 0)
  await laxA.set(4) // valid on B — views converge cleanly because validate checks next rather than local prev equality
  await waitFor(() => strictB.get() === 4)

  // Replay + once + AbortSignal options on onChange
  const replayed: number[] = []
  const unsubOnce = strictB.onChange(val => replayed.push(val), {
    replay: true,
    once: true
  })
  assert.deepEqual(replayed, [4])
  unsubOnce()

  const ac = new AbortController()
  const abortedSeen: number[] = []
  strictB.onChange(val => abortedSeen.push(val), {signal: ac.signal})
  ac.abort()
  await laxA.set(6)
  await waitFor(() => strictB.get() === 6)
  assert.deepEqual(abortedSeen, [])

  // Author B leaves, then late joiner C connects only to A and still receives B's signed state
  await roomB.leave()
  await waitFor(() => Object.keys(roomA.getUsers()).length === 0)

  const roomC = joinC({appId: 'open-state-app', rtcPolyfill}, 'room-1')
  const counterC = roomC.makeState('counter', {count: 0, note: 'init'})
  await waitFor(() => counterC.get().count === 5)
  assert.deepEqual(counterC.get(), {count: 5, note: 'from-b'})

  await Promise.all([roomA.leave(), roomC.leave()])
})

void test('makeState + roles(): fail-closed admin default, roles: "*" open override, custom roles, revocation, selfAsAdmin sync registration, and ban state purge', async () => {
  const {makeJoinRoom, rtcPolyfill} = createMemorySignalBus()
  const hostId = await createUserIdentity()
  const modId = await createUserIdentity()
  const guestId = await createUserIdentity()

  const joinHost = makeJoinRoom('roles-host')
  const joinMod = makeJoinRoom('roles-mod')
  const joinGuest = makeJoinRoom('roles-guest')

  const hostRoom = joinHost(
    {
      appId: 'roles-state-app',
      rtcPolyfill,
      identity: hostId,
      use: [roles({selfAsAdmin: true})]
    },
    'arena'
  )

  // Registered synchronously BEFORE awaiting hostRoom.ready on selfAsAdmin room!
  const hostScore = hostRoom.makeState('score', 0)
  const hostChatTopic = hostRoom.makeState('open-topic', 'general', {
    roles: '*'
  })
  const hostModNotice = hostRoom.makeState('mod-notice', 'none', {
    roles: ['admin', 'mod']
  })
  const hostNick = hostRoom.makeUserState<string>('nick')
  void hostNick.set('HostAdmin')
  await hostScore.set(10)

  const {roomId: fullRoomId} = await hostRoom.getSelf()

  const modRoom = joinMod(
    {
      appId: 'roles-state-app',
      rtcPolyfill,
      identity: modId,
      use: [roles()]
    },
    fullRoomId
  )
  const guestRoom = joinGuest(
    {
      appId: 'roles-state-app',
      rtcPolyfill,
      identity: guestId,
      use: [roles()]
    },
    fullRoomId
  )

  const guestScore = guestRoom.makeState('score', 0)
  const guestChatTopic = guestRoom.makeState('open-topic', 'general', {
    roles: '*'
  })
  const modNoticeOnMod = modRoom.makeState('mod-notice', 'none', {
    roles: ['admin', 'mod']
  })
  const modNoticeOnGuest = guestRoom.makeState('mod-notice', 'none', {
    roles: ['admin', 'mod']
  })
  const guestNick = guestRoom.makeUserState<string>('nick')
  const hostNickOnHost = hostNick

  await Promise.all([modRoom.ready, guestRoom.ready])
  await waitFor(
    () =>
      Object.keys(hostRoom.getUsers()).length === 2 &&
      guestScore.get() === 10 &&
      guestNick.get(hostId.userId) === 'HostAdmin'
  )

  // 1. Fail-closed default: unprivileged guest cannot write to makeState('score', 0)
  await assert.rejects(() => guestScore.set(999), /insufficient authority/)
  assert.equal(hostScore.get(), 10)

  // 2. Open override (`roles: '*'`) inside a roles() room allows guest to write!
  await guestChatTopic.set('music-chat')
  await waitFor(() => hostChatTopic.get() === 'music-chat')
  assert.equal(hostChatTopic.getMeta()?.userId, guestId.userId)

  // Guest also publishes user state
  await guestNick.set('RowdyGuest')
  await waitFor(() => hostNickOnHost.get(guestId.userId) === 'RowdyGuest')

  // 3. Granting custom 'mod' role enables writing mod-gated state; revoking blocks subsequent writes
  await hostRoom.grantRole(modId.userId, 'mod')
  await waitFor(() => modRoom.getRoles().includes('mod'))

  await modNoticeOnMod.set('be-kind')
  await waitFor(
    () =>
      modNoticeOnGuest.get() === 'be-kind' && hostModNotice.get() === 'be-kind'
  )
  assert.deepEqual(modNoticeOnGuest.getMeta()?.roles, ['mod'])

  await hostRoom.revokeRole(modId.userId, 'mod')
  await waitFor(() => !modRoom.getRoles().includes('mod'))
  await assert.rejects(
    () => modNoticeOnMod.set('after-revoke'),
    /insufficient authority/
  )

  // 4. Banning guest immediately purges guest's open makeState record AND guest's makeUserState!
  const removedNicks: Array<{userId: string; removed: boolean}> = []
  hostNickOnHost.onChange((_val, ctx) => {
    if (ctx.removed) {
      removedNicks.push({userId: ctx.userId, removed: ctx.removed})
    }
  })

  await hostRoom.ban(guestId.userId, {reason: 'griefing'})
  await waitFor(() => hostChatTopic.get() === 'general')
  assert.equal(hostNickOnHost.has(guestId.userId), false)
  assert.equal(hostNickOnHost.get(guestId.userId), null)
  assert.ok(removedNicks.some(e => e.userId === guestId.userId && e.removed))

  await Promise.all([hostRoom.leave(), modRoom.leave(), guestRoom.leave()])
})

void test('Concurrent functional set(prev => ...) re-evaluates on top of higher-HLC remote write committed while sign() is in flight', async () => {
  const {makeJoinRoom, rtcPolyfill} = createMemorySignalBus()
  const baseAlice = await createUserIdentity()
  const bobId = await createUserIdentity()

  let notifySignEntered!: () => void
  const signEntered = new Promise<void>(r => {
    notifySignEntered = r
  })
  let releaseSign!: () => void
  const signGate = new Promise<void>(r => {
    releaseSign = r
  })
  let pauseNextCountSign = false

  const pausedAlice: UserIdentity = {
    ...baseAlice,
    sign: async payload => {
      const txt = decodeBytes(payload)
      if (pauseNextCountSign && txt.includes(':state:')) {
        pauseNextCountSign = false
        notifySignEntered()
        await signGate
      }
      return baseAlice.sign(payload)
    }
  }

  const rA = makeJoinRoom('cas-alice')(
    {appId: 'cas-retry-app', rtcPolyfill, identity: pausedAlice},
    'cas-room'
  )
  const rB = makeJoinRoom('cas-bob')(
    {appId: 'cas-retry-app', rtcPolyfill, identity: bobId},
    'cas-room'
  )
  const countA = rA.makeState<number>('count', 0)
  const countB = rB.makeState<number>('count', 0)

  try {
    await waitFor(
      () =>
        Object.keys(rA.getPeers()).length === 1 &&
        Object.keys(rB.getPeers()).length === 1,
      2_000
    )

    pauseNextCountSign = true
    const aliceIncrement = countA.set(n => n + 1)
    await signEntered

    // While Alice's signature for val=1 is suspended, Bob commits val=10 with a newer HLC
    await wait(5)
    await countB.set(10)
    await waitFor(() => countA.get() === 10, 2_000)

    // Unblock Alice: flushSlot must detect the newer remote HLC, re-evaluate (10 => 11), re-sign, and converge!
    releaseSign()
    await aliceIncrement

    assert.equal(countA.get(), 11)
    await waitFor(() => countB.get() === 11, 2_000)
  } finally {
    releaseSign()
    await Promise.all([rA.leave(), rB.leave()])
  }
})
