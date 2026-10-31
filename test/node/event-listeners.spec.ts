import assert from 'node:assert/strict'
import test from './test.ts'
import {
  createTopicStrategy,
  createUserIdentity,
  definePlugin,
  makeSocket,
  roles,
  type SocketClient
} from '../../packages/core/src/index.ts'
import createRoom, {
  getRoomSignalingBridge
} from '../../packages/core/src/room.ts'
import createStrategy from '../../packages/core/src/strategy.ts'
import {joinRoom as joinSupabaseRoom} from '../../packages/supabase/src/index.ts'
import {joinRoom as joinTorrentRoom} from '../../packages/torrent/src/index.ts'
import type {
  PeerHandle,
  PeerJoinContext,
  PeerLeaveContext,
  PeerMediaContext,
  Room,
  RoomError,
  RolesPluginApi,
  StateChangeContext,
  UserIdentity,
  UserJoinContext,
  UserLeaveContext
} from '../../packages/core/src/types.ts'
import {
  MockRTCPeerConnection,
  linkedActions,
  turn,
  waitFor
} from './peer-harness.ts'

const makeTrack = (
  id: string,
  readyState: MediaStreamTrackState = 'live'
): MediaStreamTrack =>
  ({
    id,
    kind: 'video',
    readyState
  }) as unknown as MediaStreamTrack

const makeStream = (
  id: string,
  tracks: MediaStreamTrack[],
  active?: boolean
): MediaStream =>
  ({
    id,
    ...(active === undefined ? {} : {active}),
    getTracks: () => tracks
  }) as unknown as MediaStream

const createLinkedHandlePair = () => {
  let handlersA: Parameters<PeerHandle['setHandlers']>[0] = {}
  let handlersB: Parameters<PeerHandle['setHandlers']>[0] = {}
  let deadA = false
  let deadB = false

  const makeEndpoint = (
    isA: boolean
  ): PeerHandle & {
    emitRemoteStream: (stream: MediaStream) => void
  } => ({
    get isDead() {
      return isA ? deadA : deadB
    },
    connection: {
      connectionState: 'connected',
      iceConnectionState: 'connected',
      signalingState: 'stable',
      getSenders: () => [],
      getTransceivers: () => []
    } as unknown as RTCPeerConnection,
    channel: {
      readyState: 'open',
      bufferedAmount: 0,
      bufferedAmountLowThreshold: 0,
      addEventListener: () => {},
      removeEventListener: () => {}
    } as unknown as RTCDataChannel,
    getOffer: async () => undefined,
    signal: async () => undefined,
    sendData: data => {
      const copy = new Uint8Array(data.byteLength)
      copy.set(
        data instanceof Uint8Array
          ? data
          : new Uint8Array(data as ArrayBufferLike)
      )
      queueMicrotask(() => {
        const target = isA ? handlersB : handlersA
        const targetDead = isA ? deadB : deadA
        if (!targetDead) {
          target.data?.(copy.buffer)
        }
      })
    },
    destroy: () => {
      if (isA) {
        if (deadA) {
          return
        }
        deadA = true
        queueMicrotask(() => {
          if (!deadB) {
            deadB = true
            handlersB.close?.()
          }
        })
      } else {
        if (deadB) {
          return
        }
        deadB = true
        queueMicrotask(() => {
          if (!deadA) {
            deadA = true
            handlersA.close?.()
          }
        })
      }
    },
    setHandlers: next => {
      if (isA) {
        handlersA = {...handlersA, ...next}
      } else {
        handlersB = {...handlersB, ...next}
      }
    },
    addStream: stream => {
      const target = isA ? handlersB : handlersA
      queueMicrotask(() => {
        target.stream?.(stream)
      })
    },
    removeStream: () => {},
    addTrack: (_track, stream) => {
      const target = isA ? handlersB : handlersA
      queueMicrotask(() => {
        target.stream?.(stream)
      })
      return {} as RTCRtpSender
    },
    removeTrack: () => {},
    replaceTrack: async () => {},
    emitRemoteStream: stream => {
      const local = isA ? handlersA : handlersB
      local.stream?.(stream)
    }
  })

  return {
    peerA: makeEndpoint(true),
    peerB: makeEndpoint(false)
  }
}

const connectVerifiedPeers = (
  regMap: Map<string, (peer: PeerHandle, id: string) => void>,
  roomA: Room,
  idA: string,
  userA: UserIdentity,
  roomB: Room,
  idB: string,
  userB: UserIdentity
) => {
  const link = createLinkedHandlePair()
  regMap.get(idA)!(link.peerA, idB)
  regMap.get(idB)!(link.peerB, idA)
  getRoomSignalingBridge(roomA)!.onPeerIdentityVerified(idB, {
    userId: userB.userId,
    peerPubKey: userB.signPubJwk,
    userPubKey: userB.signPubJwk
  })
  getRoomSignalingBridge(roomB)!.onPeerIdentityVerified(idA, {
    userId: userA.userId,
    peerPubKey: userA.signPubJwk,
    userPubKey: userA.signPubJwk
  })
  return link
}

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

void test('Live-only default vs {replay: true} on onUserJoin, onPeerJoin, onPeerStream, and state.onChange', async () => {
  const regMap = new Map<string, (peer: PeerHandle, id: string) => void>()
  const [adminUser, aliceUser] = await Promise.all([
    createUserIdentity(),
    createUserIdentity()
  ])
  const appId = 'replay-semantics-app'
  const roomId = `replay-room~${adminUser.userId}`

  const makePeerRoom = (
    id: string,
    identity: typeof adminUser
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
        verifyPeerIdentity: true,
        use: [roles()]
      }
    ) as Room & RolesPluginApi

  const roomAdmin = makePeerRoom('peer-admin', adminUser)
  const roomAlice1 = makePeerRoom('peer-alice-1', aliceUser)
  const roomAlice2 = makePeerRoom('peer-alice-2', aliceUser)

  try {
    await Promise.all([
      roomAdmin.getSelf(),
      roomAlice1.getSelf(),
      roomAlice2.getSelf()
    ])
    connectVerifiedPeers(
      regMap,
      roomAdmin,
      'peer-admin',
      adminUser,
      roomAlice1,
      'peer-alice-1',
      aliceUser
    )
    connectVerifiedPeers(
      regMap,
      roomAdmin,
      'peer-admin',
      adminUser,
      roomAlice2,
      'peer-alice-2',
      aliceUser
    )

    await waitFor(() => Object.keys(roomAdmin.getPeers()).length === 2, 2_000)

    // 1. Presence: default is strictly live-only; {replay: true} synchronously emits active peers/users
    const liveOnlyPeers: string[] = []
    const liveOnlyUsers: string[] = []
    roomAdmin.onPeerJoin(ctx => liveOnlyPeers.push(ctx.peerId))
    roomAdmin.onUserJoin(ctx => liveOnlyUsers.push(ctx.userId))
    assert.deepEqual(liveOnlyPeers, [])
    assert.deepEqual(liveOnlyUsers, [])

    const replayedPeers: string[] = []
    const replayedUsers: string[] = []
    roomAdmin.onPeerJoin(ctx => replayedPeers.push(ctx.peerId), {replay: true})
    roomAdmin.onUserJoin(ctx => replayedUsers.push(ctx.userId), {replay: true})
    assert.deepEqual(replayedPeers.sort(), ['peer-alice-1', 'peer-alice-2'])
    assert.deepEqual(replayedUsers, [aliceUser.userId])

    // {replay: true, once: true} with 2 active peers replays only 1 item and unsubscribes
    const replayOncePeers: string[] = []
    roomAdmin.onPeerJoin(ctx => replayOncePeers.push(ctx.peerId), {
      replay: true,
      once: true
    })
    assert.equal(replayOncePeers.length, 1)

    // 2. Media stream replay: tracks latest metadata and skips ended/inactive streams
    const track1 = makeTrack('cam-track-1', 'live')
    const stream1 = makeStream('alice-cam', [track1], true)
    await roomAlice1.addStream(stream1, {
      target: 'peer-admin',
      metadata: {label: 'initial-cam'}
    })

    // Update stream metadata before subscribing with {replay: true}
    await roomAlice1.addStream(stream1, {
      target: 'peer-admin',
      metadata: {label: 'updated-cam'}
    })

    // Wait until stream arrives on roomAdmin using a probe or waitFor
    await waitFor(() => {
      let seen = false
      const u = roomAdmin.onPeerStream(
        (_s, ctx) => {
          if (
            (ctx.metadata as {label?: string} | undefined)?.label ===
            'updated-cam'
          ) {
            seen = true
          }
        },
        {replay: true}
      )
      u()
      return seen
    }, 2_000)

    const liveStreams: PeerMediaContext[] = []
    roomAdmin.onPeerStream((_s, ctx) => liveStreams.push(ctx))
    assert.deepEqual(liveStreams, [])

    const replayedStreams: Array<{id: string; ctx: PeerMediaContext}> = []
    roomAdmin.onPeerStream((s, ctx) => replayedStreams.push({id: s.id, ctx}), {
      replay: true
    })
    assert.equal(replayedStreams.length, 1)
    assert.equal(replayedStreams[0]!.id, 'alice-cam')
    assert.equal(replayedStreams[0]!.ctx.peerId, 'peer-alice-1')
    assert.equal(replayedStreams[0]!.ctx.userId, aliceUser.userId)
    assert.deepEqual(replayedStreams[0]!.ctx.metadata, {label: 'updated-cam'})

    // Mark track as ended -> {replay: true} must NOT replay ended remote streams
    ;(track1 as {readyState: MediaStreamTrackState}).readyState = 'ended'
    const afterEndedReplay: string[] = []
    roomAdmin.onPeerStream(s => afterEndedReplay.push(s.id), {replay: true})
    assert.deepEqual(afterEndedReplay, [])

    // 3. Authoritative state replay & useSyncExternalStore compatibility
    const phaseAdmin = roomAdmin.makeState('phase', 'lobby')
    const phaseAlice = roomAlice1.makeState('phase', 'lobby')

    // At initialValue (getMeta() === null), {replay: true} does NOT fire
    assert.equal(phaseAlice.getMeta(), null)
    const initialReplays: string[] = []
    phaseAlice.onChange(val => initialReplays.push(val), {replay: true})
    assert.deepEqual(initialReplays, [])

    // 1-arg useSyncExternalStore subscription pattern
    let externalStoreNotifications = 0
    const unsubStore = phaseAlice.onChange(() => {
      externalStoreNotifications++
    })

    await phaseAdmin.set('round-1')
    await waitFor(() => phaseAlice.get() === 'round-1', 2_000)
    assert.equal(externalStoreNotifications, 1)

    // Now getMeta() !== null -> {replay: true} fires synchronously with full StateChangeContext
    const postUpdateReplays: Array<{
      val: string
      ctx: StateChangeContext<string>
    }> = []
    const unsubReplay = phaseAlice.onChange(
      (val, ctx) => postUpdateReplays.push({val, ctx}),
      {replay: true}
    )
    assert.equal(postUpdateReplays.length, 1)
    assert.equal(postUpdateReplays[0]!.val, 'round-1')
    assert.equal(postUpdateReplays[0]!.ctx.prev, 'lobby')
    assert.equal(postUpdateReplays[0]!.ctx.peerId, 'peer-admin')
    assert.equal(postUpdateReplays[0]!.ctx.userId, adminUser.userId)
    assert.deepEqual(postUpdateReplays[0]!.ctx.roles, ['admin'])
    assert.equal(postUpdateReplays[0]!.ctx.seq, 1)
    unsubReplay()
    unsubStore()

    // Pre-hydrated state on roomAlice2 (state synced before makeState('phase', ...) is called)
    await waitFor(() => {
      const s = roomAlice2.makeState('phase', 'lobby')
      return s.get() === 'round-1'
    }, 2_000)
    const phaseAlice2 = roomAlice2.makeState('phase', 'lobby')
    const hydratedReplays: Array<{
      val: string
      ctx: StateChangeContext<string>
    }> = []
    phaseAlice2.onChange((val, ctx) => hydratedReplays.push({val, ctx}), {
      replay: true,
      once: true
    })
    assert.equal(hydratedReplays.length, 1)
    assert.equal(hydratedReplays[0]!.val, 'round-1')
    assert.equal(hydratedReplays[0]!.ctx.prev, 'lobby')
    assert.equal(hydratedReplays[0]!.ctx.peerId, 'peer-admin')
  } finally {
    await Promise.all([
      roomAdmin.leave(),
      roomAlice1.leave(),
      roomAlice2.leave()
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

void test('Single-handler enforcement on action.onRequest and action.onReceive', async () => {
  const pair = linkedActions()

  try {
    const reqSender = pair.left.makeAction<number, number>('double-rpc', {
      kind: 'request'
    })
    const reqReceiver = pair.right.makeAction<number, number>('double-rpc', {
      kind: 'request'
    })

    // Pre-aborted signal does not occupy the slot
    reqReceiver.onRequest(x => x * 10, {signal: AbortSignal.abort()})
    reqReceiver.onReceive(() => false, {signal: AbortSignal.abort()})

    // 1. Registering a second active handler throws an explicit Error
    const unsubReq1 = reqReceiver.onRequest(x => x * 2)
    assert.throws(
      () => reqReceiver.onRequest(x => x * 3),
      /onRequest handler already registered; unsubscribe first/
    )

    const unsubRecv1 = reqReceiver.onReceive(() => true)
    assert.throws(
      () => reqReceiver.onReceive(() => false),
      /onReceive handler already registered; unsubscribe first/
    )

    assert.equal(await reqSender.request(21, {target: 'right'}), 42)

    // 2. After unsub(), re-registration succeeds
    unsubReq1()
    unsubRecv1()

    // 3. {once: true} handles 1 call and immediately frees the slot for re-registration
    reqReceiver.onRequest(x => x + 1, {once: true})
    reqReceiver.onReceive(() => true, {once: true})
    assert.equal(await reqSender.request(9, {target: 'right'}), 10)

    const controller = new AbortController()
    reqReceiver.onRequest(x => x + 100, {signal: controller.signal})
    reqReceiver.onReceive(() => true, {signal: controller.signal})
    assert.equal(await reqSender.request(5, {target: 'right'}), 105)

    // 4. Aborting signal frees the slot for re-registration
    controller.abort()
    const unsubFinal = reqReceiver.onRequest(x => x * 10)
    assert.equal(await reqSender.request(7, {target: 'right'}), 70)
    unsubFinal()
  } finally {
    pair.close()
  }

  // 5. room.leave() clears active single-handler slots
  const room = createRoom(
    () => {},
    () => {},
    () => {},
    {selfId: 'leave-slot-peer', appId: 'slot-app', roomId: 'slot-room'}
  )
  const rpc = room.makeAction('rpc', {kind: 'request'})
  rpc.onRequest(() => 'v1')
  rpc.onReceive(() => true)
  await room.leave()
  const unsubAfterLeave = rpc.onRequest(() => 'v2')
  unsubAfterLeave()
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

void test('Fast-fail guardrails: 3-arg joinRoom, handler-in-config makeAction, non-function handlers, non-writable .on* methods, cached room.onError, and reserved onError plugin name', async () => {
  let storedRootTopic = ''
  let storedSubscriber:
    | ((
        topic: string,
        msg: unknown,
        signalPeer: (peerTopic: string, signal: string) => void
      ) => Promise<void> | void)
    | null = null

  const joinCustom = createStrategy({
    init: () => ({}),
    subscribe: async (_relay, rootTopic, _selfTopic, onMessage) => {
      storedRootTopic = rootTopic
      storedSubscriber = onMessage
      return () => {}
    },
    announce: () => {}
  })

  const joinTopic = createTopicStrategy({
    init: () => Promise.resolve({}),
    subscribeTopic: async () => () => {},
    publishTopic: async () => {}
  })

  // 1. Passing 3rd argument to joinRoom throws across core strategies, supabase, and torrent
  for (const fn of [
    joinCustom,
    joinTopic,
    joinSupabaseRoom,
    joinTorrentRoom
  ] as unknown as Array<(...args: unknown[]) => unknown>) {
    assert.throws(
      () =>
        fn(
          {
            appId: 'https://example.supabase.co',
            relayConfig: {supabaseKey: 'anon-key'},
            rtcPolyfill: MockRTCPeerConnection
          },
          'guardrail-room',
          {onError: () => {}}
        ),
      /joinRoom takes 2 arguments; register error listeners via room\.onError/
    )
  }

  // 2. Cached room instance returned by a 2nd joinRoom() call still supports room.onError
  const cfg = {
    appId: 'cached-join-err-app',
    password: 'correct-password',
    rtcPolyfill: MockRTCPeerConnection as unknown as typeof RTCPeerConnection
  }
  const room1 = joinCustom(cfg, 'cached-room')
  const room2 = joinCustom(cfg, 'cached-room')
  assert.equal(room1, room2)

  try {
    await room1.getSelf()
    await waitFor(() => storedSubscriber !== null)
    const errors1: RoomError[] = []
    const errors2: RoomError[] = []
    room1.onError(err => errors1.push(err))
    room2.onError(err => errors2.push(err))

    assert.ok(storedSubscriber)
    await storedSubscriber(
      storedRootTopic,
      {
        peerId: 'remote-peer',
        offerId: 'bad-offer-1',
        offer: 'corrupted-ciphertext'
      },
      () => {}
    )

    assert.equal(errors1.length, 1)
    assert.equal(errors2.length, 1)
    assert.equal(errors1[0]!.code, 'decrypt-failed')
    if (errors1[0]!.code === 'decrypt-failed') {
      assert.equal(errors1[0]!.stage, 'offer')
      assert.equal(errors1[0]!.peerId, 'remote-peer')
    }
    assert.match(errors1[0]!.message, /incorrect password/)

    // 3. makeAction rejects event handlers passed in config
    for (const badConfig of [
      {onMessage: () => {}},
      {kind: 'request', onRequest: () => 'x'},
      {onReceive: () => true},
      {onReceiveProgress: () => {}}
    ]) {
      assert.throws(
        () => room1.makeAction('bad-cfg', badConfig as never),
        /makeAction config does not accept event handlers/
      )
    }

    // 4. Non-function handlers throw immediately
    assert.throws(
      () => room1.onUserJoin(null as never),
      /onUserJoin handler must be a function/
    )
    assert.throws(
      () => room1.onError(null as never),
      /onError handler must be a function/
    )
    const validMsgAction = room1.makeAction('valid-msg')
    assert.throws(
      () => validMsgAction.onMessage(null as never),
      /action handler must be a function/
    )
    const validReqAction = room1.makeAction('valid-req', {kind: 'request'})
    assert.throws(
      () => validReqAction.onRequest(null as never),
      /onRequest handler must be a function/
    )

    // 5. Assigning to .on* methods throws TypeError (writable: false)
    for (const [obj, prop] of [
      [room1, 'onUserJoin'],
      [room1, 'onUserLeave'],
      [room1, 'onPeerJoin'],
      [room1, 'onPeerLeave'],
      [room1, 'onPeerStream'],
      [room1, 'onError'],
      [validMsgAction, 'onMessage'],
      [validMsgAction, 'onReceive'],
      [validMsgAction, 'onReceiveProgress'],
      [validReqAction, 'onRequest'],
      [validReqAction, 'onReceive'],
      [validReqAction, 'onReceiveProgress']
    ] as const) {
      assert.throws(() => {
        ;(obj as Record<string, unknown>)[prop] = () => {}
      }, TypeError)
    }
  } finally {
    await room1.leave()
  }

  // 6. Plugin safety: 'onError' is reserved, while custom plugins and makeState.onChange lock properly
  assert.throws(
    () => definePlugin('onError', {setup: () => ({})}),
    /plugin name "onError" is a reserved room property/
  )

  const shadowErrPlugin = definePlugin('shadow-on-err', {
    setup: () => ({
      onError: () => () => {}
    })
  })
  const badPluginErrors: RoomError[] = []
  const badPluginRoom = joinTopic(
    {
      appId: 'plugin-guard-app',
      use: [shadowErrPlugin],
      rtcPolyfill: MockRTCPeerConnection as unknown as typeof RTCPeerConnection
    },
    'plugin-guard-room'
  )
  badPluginRoom.onError(err => badPluginErrors.push(err))
  await assert.rejects(
    () => badPluginRoom.ready,
    /cannot override reserved room property "onError"/
  )
  assert.equal(badPluginErrors.length, 1)
  assert.equal(badPluginErrors[0]!.code, 'plugin-failed')
  if (badPluginErrors[0]!.code === 'plugin-failed') {
    assert.equal(badPluginErrors[0]!.plugin, 'shadow-on-err')
  }
  await badPluginRoom.leave().catch(() => {})

  // Custom plugin + roles() work alongside locked .on* methods, and state.onChange is also locked
  const customPlugin = definePlugin('hello-ext', {
    setup: () => ({
      greet: () => 'hi'
    })
  })
  const extRoom = joinTopic(
    {
      appId: 'ext-room-app',
      use: [roles({selfAsAdmin: true}), customPlugin],
      rtcPolyfill: MockRTCPeerConnection as unknown as typeof RTCPeerConnection
    },
    'ext-room'
  )
  try {
    await extRoom.ready
    assert.equal(extRoom.greet(), 'hi')
    const st = extRoom.makeState('s', 1)
    assert.throws(() => {
      ;(st as unknown as Record<string, unknown>)['onChange'] = () => {}
    }, TypeError)
  } finally {
    await extRoom.leave()
  }
})

void test('RoomKernel lifecycle hooks return Unsubscribe and support {replay, once, signal}', async () => {
  const regMap = new Map<string, (peer: PeerHandle, id: string) => void>()
  const activatedLive: string[] = []
  const activatedReplayed: string[] = []
  const deactivated: string[] = []
  const roomIds: string[] = []
  let leaveCount = 0

  let lateSubscribeReplay: (() => void) | null = null

  const lifecyclePlugin = definePlugin('lifecycle-probe', {
    setup(kernel) {
      const unsubAct = kernel.onPeerActivated(id => activatedLive.push(id))
      const unsubDeact = kernel.onPeerDeactivated(id => deactivated.push(id), {
        once: true
      })
      kernel.onRoomIdChanged(rid => roomIds.push(rid), {once: true})
      const leaveAbort = new AbortController()
      kernel.onLeave(
        () => {
          leaveCount++
        },
        {signal: leaveAbort.signal}
      )
      const unsubLeave2 = kernel.onLeave(() => {
        leaveCount += 10
      })

      lateSubscribeReplay = () => {
        kernel.onPeerActivated(id => activatedReplayed.push(id), {replay: true})
        unsubAct()
        unsubLeave2()
      }

      return {
        triggerRoomIdChange: (next: string) => kernel.setEffectiveRoomId(next),
        abortFirstLeaveHook: () => leaveAbort.abort(),
        unsubDeact
      }
    }
  })

  const roomA = createRoom(
    f => regMap.set('a', f),
    () => {},
    () => {},
    {
      selfId: 'peer-a',
      appId: 'kernel-hooks-app',
      roomId: 'room-v1',
      use: [lifecyclePlugin]
    }
  ) as Room & {
    triggerRoomIdChange: (next: string) => void
    abortFirstLeaveHook: () => void
    unsubDeact: () => void
  }

  const roomB = createRoom(
    f => regMap.set('b', f),
    () => {},
    () => {},
    {selfId: 'peer-b', appId: 'kernel-hooks-app', roomId: 'room-v1'}
  )
  const roomC = createRoom(
    f => regMap.set('c', f),
    () => {},
    () => {},
    {selfId: 'peer-c', appId: 'kernel-hooks-app', roomId: 'room-v1'}
  )

  try {
    await roomA.ready

    roomA.triggerRoomIdChange('room-v2')
    roomA.triggerRoomIdChange('room-v3')
    assert.deepEqual(roomIds, ['room-v2'], '{once: true} on onRoomIdChanged')

    const ab = createLinkedHandlePair()
    regMap.get('a')!(ab.peerA, 'peer-b')
    regMap.get('b')!(ab.peerB, 'peer-a')
    await waitFor(() => 'peer-b' in roomA.getPeers(), 2_000)
    assert.deepEqual(activatedLive, ['peer-b'])

    // Replay active direct peer and unsubscribe first activated hook
    lateSubscribeReplay!()
    assert.deepEqual(activatedReplayed, ['peer-b'])

    const ac = createLinkedHandlePair()
    regMap.get('a')!(ac.peerA, 'peer-c')
    regMap.get('c')!(ac.peerB, 'peer-a')
    await waitFor(() => 'peer-c' in roomA.getPeers(), 2_000)
    assert.deepEqual(
      activatedLive,
      ['peer-b'],
      'unsubscribed onPeerActivated hook must not fire for peer-c'
    )

    // Deactivate both B and C -> {once: true} on onPeerDeactivated captures only the first
    await roomB.leave()
    await waitFor(() => !('peer-b' in roomA.getPeers()), 2_000)
    await roomC.leave()
    await waitFor(() => !('peer-c' in roomA.getPeers()), 2_000)
    assert.deepEqual(deactivated, ['peer-b'])

    // Abort first leave hook; second was manually unsubscribed -> leaveCount stays 0
    roomA.abortFirstLeaveHook()
    await roomA.leave()
    assert.equal(leaveCount, 0)
  } finally {
    await Promise.all([
      roomA.leave().catch(() => {}),
      roomB.leave().catch(() => {}),
      roomC.leave().catch(() => {})
    ])
  }
})

void test('Discriminated RoomError union: relay quorum failure vs partial relay failure, ws-relay socket failure, mid-session peer-error, and kernel.emitError', async () => {
  // 1. Partial relay failure (2 of 3 fail, 1 succeeds) must NOT emit 'relay-failed'
  const joinPartialFail = createStrategy({
    init: () => [
      Promise.reject(new Error('relay-0 down')),
      Promise.resolve({id: 1}),
      Promise.reject(new Error('relay-2 down'))
    ],
    subscribe: async () => () => {},
    announce: () => {}
  })
  const partialErrors: RoomError[] = []
  const partialRoom = joinPartialFail(
    {
      appId: 'partial-relay-app',
      rtcPolyfill: MockRTCPeerConnection as unknown as typeof RTCPeerConnection
    },
    'partial-room'
  )
  partialRoom.onError(err => partialErrors.push(err))
  await new Promise(res => setTimeout(res, 80))
  assert.deepEqual(
    partialErrors,
    [],
    'partial relay pool failures must not spam onError when at least one relay is healthy'
  )
  await partialRoom.leave()

  // 2. Total relay init/subscribe failure (all relays fail) emits 'relay-failed' once
  const joinTotalFail = createStrategy({
    init: () => [
      Promise.reject(new Error('relay-a unreachable')),
      Promise.reject(new Error('relay-b unreachable'))
    ],
    subscribe: async () => () => {},
    announce: () => {}
  })
  const totalErrors: RoomError[] = []
  const totalFailRoom = joinTotalFail(
    {
      appId: 'total-relay-app',
      rtcPolyfill: MockRTCPeerConnection as unknown as typeof RTCPeerConnection
    },
    'total-room'
  )
  totalFailRoom.onError(err => totalErrors.push(err))
  await waitFor(() => totalErrors.length > 0, 2_000)
  assert.equal(totalErrors.length, 1)
  assert.equal(totalErrors[0]!.code, 'relay-failed')
  assert.equal(totalErrors[0]!.appId, 'total-relay-app')
  assert.equal(totalErrors[0]!.roomId, 'total-room')
  assert.match(totalErrors[0]!.message, /unreachable/)
  await totalFailRoom.leave()

  // 3. Socket-backed strategy (makeSocket) emits 'relay-failed' only when ALL sockets fail initial connect
  const origWebSocket = globalThis.WebSocket
  const socketClients: SocketClient[] = []
  const createdSockets: Array<{
    url: string
    readyState: number
    onopen: (() => void) | null
    onclose: (() => void) | null
    onmessage: ((ev: {data: string}) => void) | null
    send: () => void
    close: () => void
  }> = []
  class ControlledWs {
    url: string
    readyState = 0
    onopen: (() => void) | null = null
    onclose: (() => void) | null = null
    onmessage: ((ev: {data: string}) => void) | null = null
    constructor(url: string) {
      this.url = url
      createdSockets.push(this)
    }
    send() {}
    close() {
      this.readyState = 3
    }
  }
  const joinSocketStrategy = createTopicStrategy({
    init: config =>
      (config.relayConfig?.urls ?? []).map(url => {
        const client = makeSocket(url, () => {})
        socketClients.push(client)
        return client.ready
      }),
    subscribeTopic: () => () => {},
    publishTopic: () => {}
  })
  globalThis.WebSocket = ControlledWs as unknown as typeof WebSocket
  try {
    const wsErrors: RoomError[] = []
    const wsRoom = joinSocketStrategy(
      {
        appId: 'ws-fail-app',
        relayConfig: {
          urls: [
            `ws://dead-1-${Date.now()}.test`,
            `ws://dead-2-${Date.now()}.test`
          ]
        },
        rtcPolyfill:
          MockRTCPeerConnection as unknown as typeof RTCPeerConnection
      },
      'ws-fail-room'
    )
    wsRoom.onError(err => wsErrors.push(err))
    assert.equal(createdSockets.length, 2)
    // First socket fails -> quorum still has a pending candidate, so 0 errors yet
    createdSockets[0]!.onclose?.()
    await turn()
    assert.equal(wsErrors.length, 0)
    // Second socket also fails -> all relays failed initial connect -> emits 'relay-failed'
    createdSockets[1]!.onclose?.()
    await waitFor(() => wsErrors.length === 1, 2_000)
    assert.equal(wsErrors[0]!.code, 'relay-failed')
    assert.match(wsErrors[0]!.message, /failed to connect to relay/)
    await wsRoom.leave()
  } finally {
    for (const client of socketClients) {
      client.close()
    }
    globalThis.WebSocket = origWebSocket
  }

  // 4. Mid-session peer transport fault & wire protocol fault emit 'peer-error', and kernel.emitError narrows cleanly
  const customErrPlugin = definePlugin('err-emitter', {
    setup: kernel => ({
      triggerCustomHandshakeErr: (peerId: string) =>
        kernel.emitError({
          code: 'handshake-failed',
          peerId,
          message: 'custom plugin check failed'
        })
    })
  })
  const origConsoleError = console.error
  console.error = () => {}
  let regA: ((peer: PeerHandle, id: string) => void) | null = null
  let regB: ((peer: PeerHandle, id: string) => void) | null = null
  const roomA = createRoom(
    f => {
      regA = f
    },
    () => {},
    () => {},
    {
      selfId: 'peer-a',
      appId: 'peer-err-app',
      roomId: 'peer-err-room',
      use: [customErrPlugin]
    }
  )
  const roomB = createRoom(
    f => {
      regB = f
    },
    () => {},
    () => {},
    {selfId: 'peer-b', appId: 'peer-err-app', roomId: 'peer-err-room'}
  )

  try {
    await roomA.ready
    const observed: string[] = []
    roomA.onError(err => {
      // Verify TypeScript discriminated union narrowing across all RoomError codes
      switch (err.code) {
        case 'room-full':
          observed.push(`${err.code}:${err.peerId}`)
          break
        case 'banned':
          observed.push(`${err.code}:${err.reason ?? 'no-reason'}`)
          break
        case 'relay-failed':
        case 'identity-failed':
          observed.push(err.code)
          break
        case 'plugin-failed':
          observed.push(`${err.code}:${err.plugin ?? 'unknown'}`)
          break
        case 'decrypt-failed':
          observed.push(`${err.code}:${err.stage}:${err.peerId}`)
          break
        case 'peer-connect-failed':
          observed.push(`${err.code}:${err.peerId}:${err.turnConfigured}`)
          break
        case 'handshake-failed':
        case 'peer-error':
          observed.push(`${err.code}:${err.peerId}:${err.message}`)
          break
      }
    })

    const link = createLinkedHandlePair()
    regA!(link.peerA, 'peer-b')
    regB!(link.peerB, 'peer-a')
    await waitFor(() => 'peer-b' in roomA.getPeers(), 2_000)

    roomA.triggerCustomHandshakeErr('peer-x')
    // Inject malformed wire frame (< 2 bytes) from peer-b -> triggers onPeerError ('peer-error') and kicks peer-b
    link.peerB.sendData(new Uint8Array([99]))
    await waitFor(() => !('peer-b' in roomA.getPeers()), 2_000)

    // Reconnect a peer and trigger peer.handlers.error directly
    let capturedHandlers: Parameters<PeerHandle['setHandlers']>[0] = {}
    const faultyPeer: PeerHandle = {
      connection: {} as RTCPeerConnection,
      channel: null,
      isDead: false,
      getOffer: async () => undefined,
      signal: async () => undefined,
      sendData: () => {},
      destroy() {
        this.isDead = true
      },
      setHandlers(h) {
        capturedHandlers = {...capturedHandlers, ...h}
      },
      addStream: () => {},
      removeStream: () => {},
      addTrack: () => {},
      removeTrack: () => {},
      replaceTrack: () => undefined
    }
    regA!(faultyPeer, 'peer-faulty')
    capturedHandlers.error?.(new Error('sctp transport aborted'))

    assert.deepEqual(observed, [
      'handshake-failed:peer-x:custom plugin check failed',
      'peer-error:peer-b:Trystero: invalid action frame',
      'peer-error:peer-faulty:sctp transport aborted'
    ])
  } finally {
    console.error = origConsoleError
    await Promise.all([
      roomA.leave().catch(() => {}),
      roomB.leave().catch(() => {})
    ])
  }
})
