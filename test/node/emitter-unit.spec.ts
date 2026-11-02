import assert from 'node:assert/strict'
import test from './test.ts'
import {
  createUserIdentity,
  roles,
  type ReplayListenerOptions
} from '../../packages/core/src/index.ts'
import {createMediaManager} from '../../packages/core/src/media.ts'
import createRoom from '../../packages/core/src/room.ts'
import type {
  PeerHandle,
  PeerJoinContext,
  PeerLeaveContext,
  Room,
  RolesPluginApi,
  UserJoinContext,
  UserLeaveContext
} from '../../packages/core/src/types.ts'
import {
  connectVerifiedPeers,
  createLinkedHandlePair,
  linkedActions,
  makeStream,
  turn,
  waitFor
} from './peer-harness.ts'

void test('Multi-listener fan-out, independent unsubscribe, and idempotent unsubscribe across Room, Action, and State', async () => {
  const regMap = new Map<string, (peer: PeerHandle, id: string) => void>()
  const [hostIdentity, bobIdentity, carolIdentity] = await Promise.all([
    createUserIdentity(),
    createUserIdentity(),
    createUserIdentity()
  ])
  const appId = `multi-listener-${Date.now()}`
  const effectiveRoomId = `fanout-room~${hostIdentity.userId}`

  const makePeerRoom = (
    id: string,
    identity: typeof hostIdentity
  ): Room & RolesPluginApi =>
    createRoom(
      f => regMap.set(id, f),
      () => {},
      () => {},
      {
        selfId: id,
        appId,
        roomId: effectiveRoomId,
        identity,
        verifyPeerIdentity: true,
        use: [roles()]
      }
    ) as Room & RolesPluginApi

  const hostRoom = makePeerRoom('peer-host', hostIdentity)
  await hostRoom.getSelf()

  const userJoinA: UserJoinContext[] = []
  const userJoinB: UserJoinContext[] = []
  const userLeaveA: UserLeaveContext[] = []
  const userLeaveB: UserLeaveContext[] = []
  const peerJoinA: PeerJoinContext[] = []
  const peerJoinB: PeerJoinContext[] = []
  const peerLeaveA: PeerLeaveContext[] = []
  const peerLeaveB: PeerLeaveContext[] = []

  const unsubUserJoinA = hostRoom.onUserJoin(ctx => userJoinA.push(ctx))
  const unsubUserJoinB = hostRoom.onUserJoin(ctx => userJoinB.push(ctx))
  const unsubUserLeaveA = hostRoom.onUserLeave(ctx => userLeaveA.push(ctx))
  hostRoom.onUserLeave(ctx => userLeaveB.push(ctx))

  const unsubPeerJoinA = hostRoom.onPeerJoin(ctx => peerJoinA.push(ctx))
  hostRoom.onPeerJoin(ctx => peerJoinB.push(ctx))
  const unsubPeerLeaveA = hostRoom.onPeerLeave(ctx => peerLeaveA.push(ctx))
  hostRoom.onPeerLeave(ctx => peerLeaveB.push(ctx))

  const chatHost = hostRoom.makeAction<string>('chat')
  const msgA: string[] = []
  const msgB: string[] = []
  const unsubMsgA = chatHost.onMessage((msg, ctx) =>
    msgA.push(`${ctx.peerId}:${msg}`)
  )
  chatHost.onMessage((msg, ctx) => msgB.push(`${ctx.peerId}:${msg}`))

  const progressA: number[] = []
  const progressB: number[] = []
  const binHost = hostRoom.makeAction<Uint8Array>('bin')
  binHost.onMessage(() => {})
  const unsubProgA = binHost.onReceiveProgress(pct => progressA.push(pct))
  binHost.onReceiveProgress(pct => progressB.push(pct))

  const scoreHost = hostRoom.makeState('score', 0)

  const bobRoom = makePeerRoom('peer-bob-1', bobIdentity)
  await bobRoom.getSelf()

  const scoreBob = bobRoom.makeState('score', 0)
  const stateChangesA: Array<{val: number; prev: number; peerId: string}> = []
  const stateChangesB: Array<{val: number; prev: number; peerId: string}> = []
  const unsubStateA = scoreBob.onChange((val, ctx) =>
    stateChangesA.push({val, prev: ctx.prev, peerId: ctx.peerId})
  )
  scoreBob.onChange((val, ctx) =>
    stateChangesB.push({val, prev: ctx.prev, peerId: ctx.peerId})
  )

  try {
    connectVerifiedPeers(
      regMap,
      hostRoom,
      'peer-host',
      hostIdentity,
      bobRoom,
      'peer-bob-1',
      bobIdentity
    )

    await waitFor(
      () =>
        'peer-bob-1' in hostRoom.getPeers() &&
        'peer-host' in bobRoom.getPeers(),
      3_000
    )

    assert.equal(userJoinA.length, 1)
    assert.equal(userJoinB.length, 1)
    assert.equal(peerJoinA.length, 1)
    assert.equal(peerJoinB.length, 1)

    const chatBob = bobRoom.makeAction<string>('chat')
    const binBob = bobRoom.makeAction<Uint8Array>('bin')

    await chatBob.send('first')
    await waitFor(() => msgA.length === 1 && msgB.length === 1)

    await binBob.send(new Uint8Array(40 * 1024).fill(3))
    await waitFor(() => progressA.at(-1) === 1 && progressB.at(-1) === 1)

    await scoreHost.set(10)
    await waitFor(
      () => stateChangesA.length === 1 && stateChangesB.length === 1
    )
    assert.deepEqual(stateChangesA[0], {
      val: 10,
      prev: 0,
      peerId: 'peer-host'
    })
    assert.deepEqual(stateChangesB[0], {
      val: 10,
      prev: 0,
      peerId: 'peer-host'
    })

    // Unsubscribe all "A" listeners (and call twice to verify idempotence)
    unsubUserJoinA()
    unsubUserJoinA()
    unsubUserLeaveA()
    unsubUserLeaveA()
    unsubPeerJoinA()
    unsubPeerJoinA()
    unsubPeerLeaveA()
    unsubPeerLeaveA()
    unsubMsgA()
    unsubMsgA()
    unsubProgA()
    unsubProgA()
    unsubStateA()
    unsubStateA()

    const prevProgACount = progressA.length
    const prevProgBCount = progressB.length

    await chatBob.send('second')
    await waitFor(() => msgB.length === 2)
    assert.deepEqual(msgA, ['peer-bob-1:first'])
    assert.deepEqual(msgB, ['peer-bob-1:first', 'peer-bob-1:second'])

    await binBob.send(new Uint8Array(40 * 1024).fill(9))
    await waitFor(() => progressB.length > prevProgBCount)
    assert.equal(progressA.length, prevProgACount)

    await scoreHost.set(25)
    await waitFor(() => stateChangesB.length === 2)
    assert.equal(stateChangesA.length, 1)
    assert.deepEqual(stateChangesB[1], {
      val: 25,
      prev: 10,
      peerId: 'peer-host'
    })

    // Bob leaves and Carol joins: only "B" listeners fire
    await bobRoom.leave()
    await waitFor(() => peerLeaveB.length === 1 && userLeaveB.length === 1)
    assert.equal(peerLeaveA.length, 0)
    assert.equal(userLeaveA.length, 0)

    const carolRoom = makePeerRoom('peer-carol', carolIdentity)
    await carolRoom.getSelf()
    try {
      connectVerifiedPeers(
        regMap,
        hostRoom,
        'peer-host',
        hostIdentity,
        carolRoom,
        'peer-carol',
        carolIdentity
      )

      await waitFor(() => 'peer-carol' in hostRoom.getPeers(), 3_000)
      assert.equal(userJoinA.length, 1)
      assert.equal(userJoinB.length, 2)
      assert.equal(peerJoinA.length, 1)
      assert.equal(peerJoinB.length, 2)
      unsubUserJoinB()
    } finally {
      await carolRoom.leave()
    }
  } finally {
    await Promise.all([
      hostRoom.leave().catch(() => {}),
      bobRoom.leave().catch(() => {})
    ])
  }
})

void test('ListenerOptions ({once, signal}): pre-aborted signals, mid-replay abort, queued message draining with {once: true}, and AbortSignal listener cleanup', async () => {
  const pair = linkedActions()

  try {
    // 1. Queued inbound messages while 0 listeners are attached: {once: true} consumes ONLY 1 message!
    const sender = pair.left.makeAction<string>('queue-test')
    const receiver = pair.right.makeAction<string>('queue-test')

    await sender.send('m1')
    await sender.send('m2')
    await sender.send('m3')
    await turn()

    // Pre-aborted signal must NOT drain any queued messages
    const preAbortedGot: string[] = []
    const unsubAborted = receiver.onMessage(msg => preAbortedGot.push(msg), {
      signal: AbortSignal.abort()
    })
    unsubAborted()
    assert.deepEqual(preAbortedGot, [])

    // {once: true} drains only 'm1' and leaves 'm2', 'm3' buffered for the next subscriber
    const firstOnceGot: string[] = []
    receiver.onMessage(msg => firstOnceGot.push(msg), {once: true})
    assert.deepEqual(firstOnceGot, ['m1'])

    // Next subscriber receives remaining 'm2', 'm3' in order
    const restGot: string[] = []
    const unsubRest = receiver.onMessage(msg => restGot.push(msg))
    assert.deepEqual(restGot, ['m2', 'm3'])
    unsubRest()
  } finally {
    pair.close()
  }

  // 2. Mid-replay abort and AbortSignal listener leak prevention across unsub(), once, and room.leave()
  const regMap = new Map<string, (peer: PeerHandle, id: string) => void>()
  const roomA = createRoom(
    f => regMap.set('a', f),
    () => {},
    () => {},
    {selfId: 'peer-a', appId: 'sig-app', roomId: 'sig-room'}
  )
  const roomB = createRoom(
    f => regMap.set('b', f),
    () => {},
    () => {},
    {selfId: 'peer-b', appId: 'sig-app', roomId: 'sig-room'}
  )
  const roomC = createRoom(
    f => regMap.set('c', f),
    () => {},
    () => {},
    {selfId: 'peer-c', appId: 'sig-app', roomId: 'sig-room'}
  )

  try {
    const ab = createLinkedHandlePair()
    regMap.get('a')!(ab.peerA, 'peer-b')
    regMap.get('b')!(ab.peerB, 'peer-a')

    const ac = createLinkedHandlePair()
    regMap.get('a')!(ac.peerA, 'peer-c')
    regMap.get('c')!(ac.peerB, 'peer-a')

    await waitFor(() => Object.keys(roomA.getPeers()).length === 2, 2_000)

    // Pre-aborted signal with {replay: true} does NOT replay
    const abortedReplay: string[] = []
    roomA.onPeerJoin(ctx => abortedReplay.push(ctx.peerId), {
      replay: true,
      signal: AbortSignal.abort()
    })
    assert.deepEqual(abortedReplay, [])

    // Aborting inside the 1st replay callback stops remaining replay items and skips live registration
    const midAbortController = new AbortController()
    const midAbortReplay: string[] = []
    roomA.onPeerJoin(
      ctx => {
        midAbortReplay.push(ctx.peerId)
        midAbortController.abort()
      },
      {replay: true, signal: midAbortController.signal}
    )
    assert.equal(midAbortReplay.length, 1)

    // Track addEventListener / removeEventListener on a long-lived AbortSignal
    const longController = new AbortController()
    const signal = longController.signal
    let activeAbortListeners = 0
    const origAdd = signal.addEventListener.bind(signal)
    const origRemove = signal.removeEventListener.bind(signal)
    signal.addEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      opts?: boolean | AddEventListenerOptions
    ) => {
      if (type === 'abort') {
        activeAbortListeners++
      }
      return origAdd(type, listener, opts)
    }) as typeof signal.addEventListener
    signal.removeEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      opts?: boolean | EventListenerOptions
    ) => {
      if (type === 'abort') {
        activeAbortListeners--
      }
      return origRemove(type, listener, opts)
    }) as typeof signal.removeEventListener

    // Manual unsub() removes 'abort' listener
    const u1 = roomA.onPeerLeave(() => {}, {signal})
    assert.equal(activeAbortListeners, 1)
    u1()
    assert.equal(activeAbortListeners, 0)

    // {once: true} removes 'abort' listener upon firing
    roomA.onPeerJoin(() => {}, {replay: true, once: true, signal})
    assert.equal(activeAbortListeners, 0)

    // Subscriptions still active when room.leave() runs clean up their 'abort' listeners
    roomA.onUserLeave(() => {}, {signal})
    roomA.onError(() => {}, {signal})
    const act = roomA.makeAction('cleanup-act', {kind: 'request'})
    act.onRequest(() => 'ok', {signal})
    act.onReceive(() => true, {signal})
    assert.equal(activeAbortListeners, 4)

    await roomA.leave()
    assert.equal(
      activeAbortListeners,
      0,
      'room.leave() must detach all AbortSignal listeners across room and action subscriptions'
    )
  } finally {
    await Promise.all([
      roomA.leave().catch(() => {}),
      roomB.leave().catch(() => {}),
      roomC.leave().catch(() => {})
    ])
  }
})

void test('Error isolation: throwing or async-rejecting listeners do not block sibling listeners', async () => {
  const pair = linkedActions()
  const loggedErrors: unknown[][] = []
  const origError = console.error
  console.error = (...args: unknown[]) => {
    loggedErrors.push(args)
  }

  try {
    const sender = pair.left.makeAction<string>('iso')
    const receiver = pair.right.makeAction<string>('iso')

    const seenByHealthy: string[] = []
    receiver.onMessage(() => {
      throw new Error('sync listener failure')
    })
    receiver.onMessage(async () => {
      throw new Error('async listener failure')
    })
    receiver.onMessage(msg => {
      seenByHealthy.push(msg)
    })

    await sender.send('still-delivered')
    await turn()
    await new Promise(res => setTimeout(res, 20))

    assert.deepEqual(seenByHealthy, ['still-delivered'])
    assert.equal(loggedErrors.length, 2)
  } finally {
    console.error = origError
    pair.close()
  }
})

void test('Duplicate registration, async listener return types, ReplayListenerOptions, and eager remote stream pruning', async () => {
  const pair = linkedActions()

  try {
    const sender = pair.left.makeAction<string>('dup-test')
    const receiver = pair.right.makeAction<string>('dup-test')

    // 1. Registering the exact same function twice creates 2 independent subscriptions
    const hits: string[] = []
    const sharedHandler = async (msg: string): Promise<void> => {
      await Promise.resolve()
      hits.push(msg)
    }
    const off1 = receiver.onMessage(sharedHandler)
    const off2 = receiver.onMessage(sharedHandler)

    await sender.send('first')
    await waitFor(() => hits.length === 2, 1_000)
    assert.deepEqual(hits, ['first', 'first'])

    // Unsubscribing off1 removes only the first registration; off2 still fires
    off1()
    await sender.send('second')
    await waitFor(() => hits.length === 3, 1_000)
    assert.deepEqual(hits, ['first', 'first', 'second'])
    off2()
  } finally {
    pair.close()
  }

  // 2. Eager remote stream pruning on track 'ended' event + ReplayListenerOptions type check
  const trackListeners = new Map<string, Set<() => void>>()
  let trackState: MediaStreamTrackState = 'live'
  const liveTrack = {
    id: 't-eager',
    kind: 'video',
    get readyState() {
      return trackState
    },
    addEventListener: (evt: string, fn: () => void) => {
      let set = trackListeners.get(evt)
      if (!set) {
        set = new Set()
        trackListeners.set(evt, set)
      }
      set.add(fn)
    },
    removeEventListener: (evt: string, fn: () => void) => {
      trackListeners.get(evt)?.delete(fn)
    }
  } as unknown as MediaStreamTrack

  const remoteStream = makeStream('s-eager', [liveTrack], true)
  const media = createMediaManager({
    onPeerError: () => {},
    iterate: () => [],
    isActive: () => true,
    getPeerUserId: id => `user-${id}`
  })

  media.receiveStreamMeta({k: 'k1', s: 's-eager', m: {cam: 1}}, 'peer-1')
  media.receiveRemoteStream('peer-1', remoteStream)
  assert.equal(trackListeners.get('ended')?.size, 1)

  const replayOpts: ReplayListenerOptions = {replay: true}
  const beforeEnd: string[] = []
  media.onPeerStream(async s => {
    beforeEnd.push(s.id)
  }, replayOpts)()
  assert.deepEqual(beforeEnd, ['s-eager'])

  // Ending the track eagerly prunes peerActiveStreams and detaches its 'ended' listener immediately
  trackState = 'ended'
  for (const fn of Array.from(trackListeners.get('ended') ?? [])) {
    fn()
  }
  assert.equal(
    trackListeners.get('ended')?.size,
    0,
    'track ended listener must be detached immediately when stream becomes inactive'
  )

  const afterEnd: string[] = []
  media.onPeerStream(s => {
    afterEnd.push(s.id)
  }, replayOpts)()
  assert.deepEqual(afterEnd, [])
})
