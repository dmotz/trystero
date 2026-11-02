import assert from 'node:assert/strict'
import test from './test.ts'
import {
  type JsonValue,
  type Room,
  type RoomError,
  type SharedState,
  type UserIdentity,
  type UserState,
  createUserIdentity,
  roles,
  scale
} from '../../packages/core/src/index.ts'
import {
  compareStateRecords,
  createStateManager,
  jwkToCompactPub,
  maxUserStateNamespacesPerUser,
  signStateRecord
} from '../../packages/core/src/state.ts'
import {decodeBytes} from '../../packages/core/src/utils.ts'
import {
  createMemorySignalBus,
  type MemoryRtcConnectionInstance
} from './memory-rtc.ts'
import {createSortedJoinRooms, wait, waitFor} from './peer-harness.ts'

void test('State engine hardening: same-ms tie-break pull sync, unregistered poisoning defense, LRU bounds, per-user quotas, rate limits, and invalid-record peer kick', async () => {
  const [alice, bob, mallory, rootAdmin] = await Promise.all([
    createUserIdentity(),
    createUserIdentity(),
    createUserIdentity(),
    createUserIdentity()
  ])
  const appId = 'hardening-app'
  const roomId = 'hardening-room'
  const peerA = '11111111111111111111'
  const peerB = '22222222222222222222'
  const peerM = '33333333333333333333'

  // 1. Same-millisecond HLC tie-break convergence when userId order disagrees with sig prefix
  const fixedHlc = Date.now()
  const recA = await signStateRecord(alice.sign, alice.signPubJwk, {
    kind: 's',
    appId,
    roomId,
    ns: 'tie',
    hlc: fixedHlc,
    peerId: peerA,
    userId: alice.userId,
    val: 'alice'
  })
  const recB = await signStateRecord(bob.sign, bob.signPubJwk, {
    kind: 's',
    appId,
    roomId,
    ns: 'tie',
    hlc: fixedHlc,
    peerId: peerB,
    userId: bob.userId,
    val: 'bob'
  })
  const expectedWinner = compareStateRecords(recA, recB) > 0 ? 'alice' : 'bob'

  const handlers = new Map<string, (raw: JsonValue, from: string) => void>()
  const makeHarnessMgr = (
    selfId: string,
    user: UserIdentity,
    onInvalid?: (from?: string) => void
  ) =>
    createStateManager({
      appId,
      getRoomId: () => roomId,
      getSelfId: () => selfId,
      getLocalUserId: () => user.userId,
      ensureReady: async () => ({selfId, user, roomId}),
      hasRolesPlugin: () => false,
      getRolesProvider: () => null,
      isPeerActive: () => true,
      isDirectPeer: () => true,
      getDirectPeerIds: () => [peerA, peerB].filter(p => p !== selfId),
      isUserOnline: () => true,
      getKnownPeerUserId: pid =>
        pid === peerA
          ? alice.userId
          : pid === peerB
            ? bob.userId
            : mallory.userId,
      isPeerBanned: () => false,
      getPeerRoles: () => [],
      makeInternalAction: <T extends JsonValue>(ns: string) => {
        const key = `${selfId}:${ns}`
        return {
          send: async (data: T, targets?: string | string[] | null) => {
            const list = targets
              ? Array.isArray(targets)
                ? targets
                : [targets]
              : [peerA, peerB].filter(p => p !== selfId)
            for (const t of list) {
              queueMicrotask(() => {
                handlers.get(`${t}:${ns}`)?.(data, selfId)
              })
            }
          },
          onMessage: (fn: (data: T, peerId: string) => void) => {
            handlers.set(key, fn as (raw: JsonValue, from: string) => void)
            return () => handlers.delete(key)
          },
          onReceive: () => () => {},
          onReceiveProgress: () => () => {}
        } as never
      },
      ...(onInvalid ? {onInvalidRecord: onInvalid} : {})
    })

  const mgrA = makeHarnessMgr(peerA, alice)
  const mgrB = makeHarnessMgr(peerB, bob)
  const tieA = mgrA.makeState('tie', 'init')
  const tieB = mgrB.makeState('tie', 'init')
  await mgrA.verifyAndApplyStateRecord(recA)
  await mgrB.verifyAndApplyStateRecord(recB)
  mgrA.onPeerJoined(peerB, bob.userId, true)
  await waitFor(
    () => tieA.get() === expectedWinner && tieB.get() === expectedWinner
  )
  mgrA.destroy()
  mgrB.destroy()

  // 2. Unregistered namespaces drop silently without penalty, and lazy verify-before-relay catches forged direct signatures before relaying
  const invalidFrom: Array<string | undefined> = []
  const peerPubs: Record<string, string> = {
    [peerA]: jwkToCompactPub(alice.signPubJwk),
    [peerB]: jwkToCompactPub(bob.signPubJwk),
    [peerM]: jwkToCompactPub(mallory.signPubJwk)
  }
  const makeLazyMgr = (
    selfId: string,
    user: UserIdentity,
    onInvalid?: (from?: string) => void
  ) =>
    createStateManager({
      appId,
      getRoomId: () => roomId,
      getSelfId: () => selfId,
      getLocalUserId: () => user.userId,
      ensureReady: async () => ({selfId, user, roomId}),
      hasRolesPlugin: () => false,
      getRolesProvider: () => null,
      isPeerActive: () => true,
      isDirectPeer: () => true,
      getDirectPeerIds: () => [peerA, peerB, peerM].filter(p => p !== selfId),
      isUserOnline: () => true,
      getKnownPeerUserId: pid =>
        pid === peerA
          ? alice.userId
          : pid === peerB
            ? bob.userId
            : mallory.userId,
      getPeerUserPub: pid => peerPubs[pid],
      isPeerBanned: () => false,
      getPeerRoles: () => [],
      makeInternalAction: <T extends JsonValue>(ns: string) => {
        const key = `${selfId}:${ns}`
        return {
          send: async (data: T, targets?: string | string[] | null) => {
            const list = targets
              ? Array.isArray(targets)
                ? targets
                : [targets]
              : [peerA, peerB, peerM].filter(p => p !== selfId)
            for (const t of list) {
              queueMicrotask(() => {
                handlers.get(`${t}:${ns}`)?.(data, selfId)
              })
            }
          },
          onMessage: (fn: (data: T, peerId: string) => void) => {
            handlers.set(key, fn as (raw: JsonValue, from: string) => void)
            return () => handlers.delete(key)
          },
          onReceive: () => () => {},
          onReceiveProgress: () => () => {}
        } as never
      },
      ...(onInvalid ? {onInvalidRecord: onInvalid} : {})
    })

  const mgrGuard = makeLazyMgr(peerB, bob, from => {
    invalidFrom.push(from)
  })
  const mgrNewcomer = makeLazyMgr(peerA, alice)

  // Unregistered namespace record is dropped without incrementing invalidFrom
  const unregRec = await signStateRecord(alice.sign, alice.signPubJwk, {
    kind: 's',
    appId,
    roomId,
    ns: 'unregistered-ns',
    hlc: fixedHlc,
    peerId: peerA,
    userId: alice.userId,
    val: 42
  })
  assert.equal(await mgrGuard.verifyAndApplyStateRecord(unregRec), false)
  assert.equal(invalidFrom.length, 0)

  // Mallory sends a direct live 'rec' with valid identity binding (peerM + mallory.userId + mallory.pub) but a forged 86-char signature.
  // Eager signature verification rejects it before mutating slot.entries or emitting onChange, preserving Alice's valid value.
  const guardedSlot = mgrGuard.makeState('lazy-check', 'clean')
  const newcomerSlot = mgrNewcomer.makeState('lazy-check', 'clean')
  await newcomerSlot.set('alice-valid')
  await waitFor(() => guardedSlot.get() === 'alice-valid')
  const observedOnGuard: string[] = []
  guardedSlot.onChange(val => {
    observedOnGuard.push(val)
  })
  handlers.get(`${peerB}:state`)?.(
    {
      t: 'rec',
      r: {
        v: 1,
        k: 's',
        ns: 'lazy-check',
        hlc: fixedHlc + 50_000,
        peerId: peerM,
        userId: mallory.userId,
        pub: peerPubs[peerM]!,
        val: 'forged-direct',
        sig: 'A'.repeat(86)
      }
    },
    peerM
  )
  await waitFor(() => invalidFrom.length === 1)
  await wait(30)
  assert.equal(guardedSlot.get(), 'alice-valid')
  assert.equal(newcomerSlot.get(), 'alice-valid')
  assert.deepEqual(observedOnGuard, [])
  assert.deepEqual(invalidFrom, [peerM])
  mgrNewcomer.destroy()

  // 3. Per-user userState namespace cap (32 namespaces per user) enforced locally
  const mgrQuota = makeHarnessMgr(peerA, alice)
  for (let i = 0; i < maxUserStateNamespacesPerUser; i++) {
    await mgrQuota.makeUserState(`u-ns-${i}`, 0).set(i + 1)
  }
  await assert.rejects(
    () => mgrQuota.makeUserState('u-ns-overflow', 0).set(999),
    /quota/
  )
  mgrQuota.destroy()

  // 4. Forged signatures trigger peer-error and kick after 8 invalid state records, while >25 valid burst only drops excess
  const {makeJoinRoom, rtcPolyfill} = createMemorySignalBus()
  const joinVictim = makeJoinRoom('sec-victim')
  const joinAttacker = makeJoinRoom('sec-attacker')

  const victimErrors: RoomError[] = []
  const victimRoom = joinVictim(
    {appId: 'sec-kick-app', rtcPolyfill, identity: rootAdmin},
    'sec-room'
  )
  victimRoom.onError(err => victimErrors.push(err))

  const attackerRoom = joinAttacker(
    {appId: 'sec-kick-app', rtcPolyfill, identity: mallory},
    'sec-room'
  )
  try {
    const victimLive = victimRoom.makeState('burst', 0)
    const attackerLive = attackerRoom.makeState('burst', 0)

    await waitFor(() => Object.keys(victimRoom.getUsers()).length === 1)

    // Burst 35 valid records back-to-back via distinct awaits — token bucket drops excess without kicking!
    for (let i = 1; i <= 35; i++) {
      await attackerLive.set(i)
    }
    await wait(50)
    assert.equal(victimErrors.length, 0)
    assert.equal(Object.keys(victimRoom.getUsers()).length, 1)
    assert.ok(victimLive.get() >= 1)

    // Refill live rate-limit tokens (~9 tokens at 20/s), then inject 8 forged @_state records -> peer-error & kick!
    await wait(450)
    const attackerSelf = await attackerRoom.getSelf()
    const forgedMsg = JSON.stringify({
      t: 'rec',
      r: {
        v: 1,
        k: 's',
        ns: 'burst',
        hlc: Date.now(),
        peerId: attackerSelf.peerId,
        userId: mallory.userId,
        pub: 'bad',
        val: 999,
        sig: 'bad-sig'
      }
    })
    const typeBytes = new TextEncoder().encode('@_state')
    const bodyBytes = new TextEncoder().encode(forgedMsg)
    const rawFrame = new Uint8Array(36 + bodyBytes.byteLength)
    rawFrame[0] = 2
    rawFrame[1] = 1 << 4 // jsonFormat inline frame
    rawFrame.set(typeBytes, 2)
    rawFrame.set(bodyBytes, 36)

    const victimPc = victimRoom.getPeers()[attackerSelf.peerId]
      ?.connection as unknown as MemoryRtcConnectionInstance | undefined
    const attackerChannel = victimPc?.partnerPc?.dataChannel
    assert.ok(attackerChannel && attackerChannel.readyState === 'open')

    let kickedPeers = 0
    let kickedUsers = 0
    victimRoom.onPeerLeave(({peerId}) => {
      if (peerId === attackerSelf.peerId) {
        kickedPeers += 1
      }
    })
    victimRoom.onUserLeave(({userId}) => {
      if (userId === mallory.userId) {
        kickedUsers += 1
      }
    })

    for (let k = 0; k < 8; k++) {
      attackerChannel.send(rawFrame)
    }

    await waitFor(
      () =>
        victimErrors.some(
          e =>
            e.code === 'peer-error' &&
            /excessive invalid state records/.test(e.message)
        ) &&
        kickedPeers >= 1 &&
        kickedUsers >= 1
    )
  } finally {
    mgrGuard.destroy()
    await Promise.all([victimRoom.leave(), attackerRoom.leave()])
  }
})

void test('Sync scalability & multi-hop overlay: bounded pull fanout on 10th mesh peer join and convergence across scale({mode: "gossip"})', async () => {
  // Part A: 9-peer mesh -> 10th peer joins with O(1) pull fanout rather than 9 full pushes
  const {makeJoinRoom, rtcPolyfill, setSendObserver} = createMemorySignalBus()
  const meshPeers = await createSortedJoinRooms(
    10,
    () => makeJoinRoom(),
    'scale-sync-app'
  )
  const rooms: Room[] = []
  const names: Array<UserState<string>> = []

  for (let i = 0; i < 9; i++) {
    const r = meshPeers[i]!.joinRoom(
      {appId: 'scale-sync-app', rtcPolyfill},
      'mesh-10'
    )
    r.makeState('stage', 'ready')
    const n = r.makeUserState('name', '')
    void n.set(`User-${i}`)
    rooms.push(r)
    names.push(n)
  }

  const shared0 = rooms[0]!.makeState('stage', 'ready')
  await shared0.set('live-match')

  await waitFor(
    () =>
      rooms.every(r => Object.keys(r.getUsers()).length === 8) &&
      rooms.every(r => r.makeState('stage', 'ready').get() === 'live-match') &&
      names.every(n => Object.keys(n.getAll()).length === 9),
    5_000
  )

  // Measure @_state 'sync' batch replies sent when the 10th peer joins
  let syncReplyFrames = 0
  setSendObserver(payload => {
    if (!(payload instanceof ArrayBuffer) || payload.byteLength < 36) {
      return
    }
    const header = decodeBytes(new Uint8Array(payload, 2, 32)).replace(
      /\0+$/,
      ''
    )
    if (header !== '@_state') {
      return
    }
    const body = decodeBytes(new Uint8Array(payload, 36))
    if (body.includes('"t":"sync"')) {
      syncReplyFrames++
    }
  })

  try {
    const r10 = meshPeers[9]!.joinRoom(
      {appId: 'scale-sync-app', rtcPolyfill},
      'mesh-10'
    )
    const stage10 = r10.makeState('stage', 'ready')
    const name10 = r10.makeUserState('name', '')
    void name10.set('User-9')
    rooms.push(r10)
    names.push(name10)

    await waitFor(
      () =>
        stage10.get() === 'live-match' &&
        Object.keys(name10.getAll()).length === 10 &&
        names.every(n => Object.keys(n.getAll()).length === 10),
      5_000
    )

    // Under old O(N) push-from-every-peer, 9 existing peers + newcomer would exchange >= 9-18 full syncs;
    // with k=2 bounded pull fanout, sync replies stay small (typically 2-5).
    assert.ok(
      syncReplyFrames <= 7,
      `expected bounded O(1) sync replies on 10th peer join, got ${syncReplyFrames}`
    )
  } finally {
    setSendObserver(null)
    await Promise.all(rooms.map(r => r.leave()))
  }

  // Part B: Multi-hop gossip mode (`scale({mode: 'gossip', maxConnections: 4})`) converges shared & user state across non-adjacent peers
  const {makeJoinRoom: makeGossipJoin} = createMemorySignalBus()
  const gossipPeers = await createSortedJoinRooms(
    12,
    () => makeGossipJoin(),
    'gossip-state-app'
  )
  const gossipRooms: Array<
    ReturnType<ReturnType<typeof makeGossipJoin>> & {
      getTopology: () => {
        activeMode: string
        directPeerIds: string[]
        roomPeerIds: string[]
      }
    }
  > = []
  const gossipStates: Array<SharedState<string>> = []
  const gossipProfiles: Array<UserState<string>> = []

  try {
    for (let i = 0; i < 12; i++) {
      const gr = gossipPeers[i]!.joinRoom(
        {
          appId: 'gossip-state-app',
          rtcPolyfill,
          use: [scale({mode: 'gossip', maxConnections: 4})]
        },
        'gossip-room'
      )
      gossipStates.push(gr.makeState('banner', 'init'))
      const prof = gr.makeUserState('handle', '')
      void prof.set(`gossip-user-${i}`)
      gossipProfiles.push(prof)
      gossipRooms.push(gr as never)
      await gr.ready
      await wait(15)
    }

    await waitFor(
      () =>
        gossipRooms.every(r => r.getTopology().roomPeerIds.length === 11) &&
        gossipRooms.some(r =>
          Object.values(r.getPeers()).some(p => !p.direct && p.hops >= 2)
        ),
      8_000
    )

    await gossipStates[0]!.set('hello-across-hops')
    await waitFor(
      () =>
        gossipStates.every(s => s.get() === 'hello-across-hops') &&
        gossipProfiles.every(p => Object.keys(p.getAll()).length === 12),
      8_000
    )
  } finally {
    await Promise.all(gossipRooms.map(r => r.leave()))
  }
})

void test('Handshake ready enrichment resilience: hung state sign degrades to live sync, hot set() loop resolves on first batch, and 32 certified namespaces respect hsready cap', async () => {
  // 1. Hung state sign() never blocks peer connectivity; value arrives once sign unblocks
  {
    const {makeJoinRoom, rtcPolyfill} = createMemorySignalBus()
    const baseId = await createUserIdentity()
    let releaseStateSign!: () => void
    const stateSignGate = new Promise<void>(r => {
      releaseStateSign = r
    })
    const stalledIdentity: UserIdentity = {
      ...baseId,
      sign: async payload => {
        if (decodeBytes(payload).includes(':state:')) {
          await stateSignGate
        }
        return baseId.sign(payload)
      }
    }

    const rA = makeJoinRoom('hs-stall-a')(
      {appId: 'hs-resilience-app', rtcPolyfill, identity: stalledIdentity},
      'stall-room'
    )
    const nameA = rA.makeUserState('name', '')
    const pendingSet = nameA.set('DelayedAlice')

    const t0 = Date.now()
    const rB = makeJoinRoom('hs-stall-b')(
      {appId: 'hs-resilience-app', rtcPolyfill},
      'stall-room'
    )
    const nameB = rB.makeUserState('name', '')
    const observedChanges: string[] = []
    nameB.onChange((val, ctx) => {
      if (ctx.userId === baseId.userId && val) {
        observedChanges.push(val)
      }
    })

    try {
      await waitFor(
        () =>
          Object.keys(rA.getPeers()).length === 1 &&
          Object.keys(rB.getPeers()).length === 1,
        2_000
      )
      const connectMs = Date.now() - t0
      assert.ok(
        connectMs < 1_500,
        `expected stalled state sign to degrade within deadline, took ${connectMs}ms`
      )
      assert.equal(nameB.has(baseId.userId), false)

      releaseStateSign()
      await pendingSet
      await waitFor(() => nameB.get(baseId.userId) === 'DelayedAlice', 2_000)
      assert.deepEqual(observedChanges, ['DelayedAlice'])
    } finally {
      releaseStateSign()
      await Promise.all([rA.leave(), rB.leave()])
    }
  }

  // 2. Continuous hot set() loop during handshake does not starve prepareHandshakeReady
  {
    const {makeJoinRoom, rtcPolyfill} = createMemorySignalBus()
    const baseHotId = await createUserIdentity()
    const slowStepIdentity: UserIdentity = {
      ...baseHotId,
      sign: async payload => {
        if (decodeBytes(payload).includes(':state:')) {
          await wait(35)
        }
        return baseHotId.sign(payload)
      }
    }

    const rHot = makeJoinRoom('hs-hot-a')(
      {appId: 'hs-resilience-app', rtcPolyfill, identity: slowStepIdentity},
      'hot-loop-room'
    )
    const cursorHot = rHot.makeUserState<number>('cursor', 0)
    void cursorHot.set(1)
    await wait(5)
    const ticker = setInterval(() => {
      void cursorHot.set(prev => prev + 1)
    }, 10)

    let joinObservedCursor = 0
    const t0 = Date.now()
    const rReader = makeJoinRoom('hs-hot-b')(
      {appId: 'hs-resilience-app', rtcPolyfill},
      'hot-loop-room'
    )
    const cursorReader = rReader.makeUserState<number>('cursor', 0)
    rReader.onUserJoin(({userId}) => {
      joinObservedCursor = cursorReader.get(userId)
    })

    try {
      await waitFor(() => Object.keys(rReader.getPeers()).length === 1, 1_500)
      const elapsed = Date.now() - t0
      assert.ok(
        elapsed < 380,
        `expected single-batch stepP to resolve without waiting for 400ms deadline, took ${elapsed}ms`
      )
      assert.ok(
        joinObservedCursor >= 1,
        `expected pre-join cursor value >= 1 on onUserJoin, got ${joinObservedCursor}`
      )
      clearInterval(ticker)
      await waitFor(
        () =>
          cursorReader.get(baseHotId.userId) ===
          cursorHot.get(baseHotId.userId),
        2_000
      )
    } finally {
      clearInterval(ticker)
      await Promise.all([rHot.leave(), rReader.leave()])
    }
  }

  // 3. 32 certified user-state namespaces near quota cap never exceed @_hsready wire limit and converge completely
  {
    const {makeJoinRoom, rtcPolyfill} = createMemorySignalBus()
    const adminId = await createUserIdentity()
    const nsNames = Array.from(
      {length: maxUserStateNamespacesPerUser},
      (_, i) =>
        `certified-slot-${String(i).padStart(2, '0')}-${'x'.repeat(160)}`
    )
    const rAdmin = makeJoinRoom('hs-cap-admin')(
      {
        appId: 'hs-resilience-app',
        rtcPolyfill,
        identity: adminId,
        use: [roles({admins: [adminId.userId]})]
      },
      'cap-room'
    )
    const adminSlots = nsNames.map(ns =>
      rAdmin.makeUserState<string>(ns, '', {roles: ['admin']})
    )
    await rAdmin.ready
    await Promise.all(
      adminSlots.map((slot, i) => slot.set(`${i}:${'v'.repeat(1_950)}`))
    )

    const rPeer = makeJoinRoom('hs-cap-peer')(
      {
        appId: 'hs-resilience-app',
        rtcPolyfill,
        use: [roles({admins: [adminId.userId]})]
      },
      'cap-room'
    )
    const peerSlots = nsNames.map(ns =>
      rPeer.makeUserState<string>(ns, '', {roles: ['admin']})
    )

    try {
      await waitFor(
        () =>
          Object.keys(rPeer.getPeers()).length === 1 &&
          peerSlots.every(
            (slot, i) =>
              slot.get(adminId.userId) === `${i}:${'v'.repeat(1_950)}`
          ),
        4_000
      )
    } finally {
      await Promise.all([rAdmin.leave(), rPeer.leave()])
    }
  }
})
