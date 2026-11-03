import assert from 'node:assert/strict'
import test from './test.ts'
import {
  createTopicStrategy,
  createUserIdentity,
  makeSocket,
  roles,
  type SocketClient
} from '../../packages/core/src/index.ts'
import type {EndpointIdentity} from '../../packages/core/src/identity.ts'
import type {InternalRoomContext} from '../../packages/core/src/internal-types.ts'
import {makeInternalPlugin} from '../../packages/core/src/plugin.ts'
import createRoom from '../../packages/core/src/room.ts'
import createStrategy from '../../packages/core/src/strategy.ts'
import type {
  PeerHandle,
  PeerMediaContext,
  Room,
  RoomError,
  RolesPluginApi,
  StateChangeContext
} from '../../packages/core/src/types.ts'
import {
  MockRTCPeerConnection,
  allocTestPeerIds,
  connectVerifiedPeers,
  createLinkedHandlePair,
  getTestEndpointByPeerId,
  makeStream,
  makeTrack,
  testEndpoint,
  turn,
  wait,
  waitFor
} from './peer-harness.ts'

void test('Live-only default vs {replay: true} on onUserJoin, onPeerJoin, onPeerStream, and state.onChange', async () => {
  const regMap = new Map<string, (peer: PeerHandle, id: string) => void>()
  const [adminUser, aliceUser] = await Promise.all([
    createUserIdentity(),
    createUserIdentity()
  ])
  const epAdmin = testEndpoint('lc-replay-admin')
  const epAlice1 = testEndpoint('lc-replay-alice-1')
  const epAlice2 = testEndpoint('lc-replay-alice-2')
  const appId = 'replay-semantics-app'
  const roomId = `replay-room~${adminUser.userId}`

  const makePeerRoom = (
    ep: EndpointIdentity,
    identity: typeof adminUser
  ): Room & RolesPluginApi =>
    createRoom(
      f => regMap.set(ep.peerId, f),
      () => {},
      () => {},
      {
        endpointIdentity: ep,
        appId,
        roomId,
        identity,
        use: [roles()]
      }
    ) as Room & RolesPluginApi

  const roomAdmin = makePeerRoom(epAdmin, adminUser)
  const roomAlice1 = makePeerRoom(epAlice1, aliceUser)
  const roomAlice2 = makePeerRoom(epAlice2, aliceUser)

  try {
    await Promise.all([
      roomAdmin.getSelf(),
      roomAlice1.getSelf(),
      roomAlice2.getSelf()
    ])
    connectVerifiedPeers(
      regMap,
      roomAdmin,
      epAdmin.peerId,
      adminUser,
      roomAlice1,
      epAlice1.peerId,
      aliceUser
    )
    connectVerifiedPeers(
      regMap,
      roomAdmin,
      epAdmin.peerId,
      adminUser,
      roomAlice2,
      epAlice2.peerId,
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
    assert.deepEqual(
      replayedPeers.sort(),
      [epAlice1.peerId, epAlice2.peerId].sort()
    )
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
      target: epAdmin.peerId,
      metadata: {label: 'initial-cam'}
    })

    // Update stream metadata before subscribing with {replay: true}
    await roomAlice1.addStream(stream1, {
      target: epAdmin.peerId,
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
    assert.equal(replayedStreams[0]!.ctx.peerId, epAlice1.peerId)
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
    assert.equal(postUpdateReplays[0]!.ctx.peerId, epAdmin.peerId)
    assert.equal(postUpdateReplays[0]!.ctx.userId, adminUser.userId)
    assert.deepEqual(postUpdateReplays[0]!.ctx.roles, ['admin'])
    assert.equal(typeof postUpdateReplays[0]!.ctx.timestamp, 'number')
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
    assert.equal(hydratedReplays[0]!.ctx.peerId, epAdmin.peerId)
  } finally {
    await Promise.all([
      roomAdmin.leave(),
      roomAlice1.leave(),
      roomAlice2.leave()
    ])
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

  const lifecyclePlugin = makeInternalPlugin(
    'scale',
    (kernel: InternalRoomContext) => {
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
  )

  const epA = testEndpoint('lc-kernel-a')
  const epB = testEndpoint('lc-kernel-b')
  const epC = testEndpoint('lc-kernel-c')

  const roomA = createRoom(
    f => regMap.set('a', f),
    () => {},
    () => {},
    {
      endpointIdentity: epA,
      clientId: 'lc-kernel-a',
      appId: 'kernel-hooks-app',
      roomId: 'room-v1',
      use: [lifecyclePlugin]
    }
  )
  const roomB = createRoom(
    f => regMap.set('b', f),
    () => {},
    () => {},
    {
      endpointIdentity: epB,
      clientId: 'lc-kernel-b',
      appId: 'kernel-hooks-app',
      roomId: 'room-v1'
    }
  )
  const roomC = createRoom(
    f => regMap.set('c', f),
    () => {},
    () => {},
    {
      endpointIdentity: epC,
      clientId: 'lc-kernel-c',
      appId: 'kernel-hooks-app',
      roomId: 'room-v1'
    }
  )

  try {
    await roomA.ready

    roomA.triggerRoomIdChange('room-v2')
    roomA.triggerRoomIdChange('room-v3')
    assert.deepEqual(roomIds, ['room-v2'], '{once: true} on onRoomIdChanged')

    const ab = createLinkedHandlePair()
    regMap.get('a')!(ab.peerA, epB.peerId)
    regMap.get('b')!(ab.peerB, epA.peerId)
    await waitFor(() => epB.peerId in roomA.getPeers(), 2_000)
    assert.deepEqual(activatedLive, [epB.peerId])

    // Replay active direct peer and unsubscribe first activated hook
    lateSubscribeReplay!()
    assert.deepEqual(activatedReplayed, [epB.peerId])

    const ac = createLinkedHandlePair()
    regMap.get('a')!(ac.peerA, epC.peerId)
    regMap.get('c')!(ac.peerB, epA.peerId)
    await waitFor(() => epC.peerId in roomA.getPeers(), 2_000)
    assert.deepEqual(
      activatedLive,
      [epB.peerId],
      'unsubscribed onPeerActivated hook must not fire for peer-c'
    )

    // Deactivate both B and C -> {once: true} on onPeerDeactivated captures only the first
    await roomB.leave()
    await waitFor(() => !(epB.peerId in roomA.getPeers()), 2_000)
    await roomC.leave()
    await waitFor(() => !(epC.peerId in roomA.getPeers()), 2_000)
    assert.deepEqual(deactivated, [epB.peerId])

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
      client.close?.()
    }
    globalThis.WebSocket = origWebSocket
  }

  // 4. Mid-session peer transport fault & wire protocol fault emit 'peer-error', and kernel.emitError narrows cleanly
  const customErrPlugin = makeInternalPlugin('scale', kernel => ({
    triggerCustomHandshakeErr: (peerId: string) =>
      kernel.emitError({
        code: 'handshake-failed',
        peerId,
        message: 'custom plugin check failed'
      })
  }))
  const epA = testEndpoint('lc-err-a')
  const epB = testEndpoint('lc-err-b')
  const epFaulty = testEndpoint('lc-err-faulty')
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
      endpointIdentity: epA,
      clientId: 'lc-err-a',
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
    {
      endpointIdentity: epB,
      clientId: 'lc-err-b',
      appId: 'peer-err-app',
      roomId: 'peer-err-room'
    }
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
    regA!(link.peerA, epB.peerId)
    regB!(link.peerB, epA.peerId)
    await waitFor(() => epB.peerId in roomA.getPeers(), 2_000)

    roomA.triggerCustomHandshakeErr('peer-x')
    // Inject malformed wire frame (< 2 bytes) from peer-b -> triggers onPeerError ('peer-error') and kicks peer-b
    link.peerB.sendData(new Uint8Array([99]))
    await waitFor(() => !(epB.peerId in roomA.getPeers()), 2_000)

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
    regA!(faultyPeer, epFaulty.peerId)
    capturedHandlers.error?.(new Error('sctp transport aborted'))

    assert.deepEqual(observed, [
      'handshake-failed:peer-x:custom plugin check failed',
      `peer-error:${epB.peerId}:Trystero: invalid action frame`,
      `peer-error:${epFaulty.peerId}:sctp transport aborted`
    ])
  } finally {
    console.error = origConsoleError
    await Promise.all([
      roomA.leave().catch(() => {}),
      roomB.leave().catch(() => {})
    ])
  }
})

void test('Q17: local room.leave() suppresses local onPeerLeave and onUserLeave while notifying remote peers', async () => {
  const regMap = new Map<string, (peer: PeerHandle, id: string) => void>()
  const [hostUser, bobUser, carolUser] = await Promise.all([
    createUserIdentity(),
    createUserIdentity(),
    createUserIdentity()
  ])
  const epHost = testEndpoint('q17-host')
  const epBob1 = testEndpoint('q17-bob-1')
  const epBob2 = testEndpoint('q17-bob-2')
  const epCarol = testEndpoint('q17-carol')
  const appId = 'q17-leave-semantics-app'
  const roomId = 'q17-leave-room'

  const makeNode = (ep: EndpointIdentity, identity: typeof hostUser) =>
    createRoom(
      f => regMap.set(ep.peerId, f),
      () => {},
      () => {},
      {endpointIdentity: ep, appId, roomId, identity}
    )

  const roomHost = makeNode(epHost, hostUser)
  const roomBob1 = makeNode(epBob1, bobUser)
  const roomBob2 = makeNode(epBob2, bobUser)
  const roomCarol = makeNode(epCarol, carolUser)

  try {
    await Promise.all([
      roomHost.ready,
      roomBob1.ready,
      roomBob2.ready,
      roomCarol.ready
    ])

    const linkBob1 = createLinkedHandlePair()
    regMap.get(epHost.peerId)!(linkBob1.peerA, epBob1.peerId)
    regMap.get(epBob1.peerId)!(linkBob1.peerB, epHost.peerId)

    const linkBob2 = createLinkedHandlePair()
    regMap.get(epHost.peerId)!(linkBob2.peerA, epBob2.peerId)
    regMap.get(epBob2.peerId)!(linkBob2.peerB, epHost.peerId)

    const linkCarol = createLinkedHandlePair()
    regMap.get(epHost.peerId)!(linkCarol.peerA, epCarol.peerId)
    regMap.get(epCarol.peerId)!(linkCarol.peerB, epHost.peerId)

    await waitFor(
      () =>
        Object.keys(roomHost.getPeers()).length === 3 &&
        epHost.peerId in roomBob1.getPeers() &&
        epHost.peerId in roomBob2.getPeers() &&
        epHost.peerId in roomCarol.getPeers(),
      2_000
    )

    const hostPeerLeaves: string[] = []
    const hostUserLeaves: string[] = []
    const bob1PeerLeaves: string[] = []
    const bob1UserLeaves: string[] = []
    const bob2PeerLeaves: string[] = []
    const bob2UserLeaves: string[] = []
    const carolPeerLeaves: string[] = []
    const carolUserLeaves: string[] = []

    roomHost.onPeerLeave(({peerId}) => hostPeerLeaves.push(peerId))
    roomHost.onUserLeave(({userId}) => hostUserLeaves.push(userId))
    roomBob1.onPeerLeave(({peerId}) => bob1PeerLeaves.push(peerId))
    roomBob1.onUserLeave(({userId}) => bob1UserLeaves.push(userId))
    roomBob2.onPeerLeave(({peerId}) => bob2PeerLeaves.push(peerId))
    roomBob2.onUserLeave(({userId}) => bob2UserLeaves.push(userId))
    roomCarol.onPeerLeave(({peerId}) => carolPeerLeaves.push(peerId))
    roomCarol.onUserLeave(({userId}) => carolUserLeaves.push(userId))

    // 1. Bob's first tab leaves: Bob1 suppresses its own local leave events;
    //    Host fires onPeerLeave(epBob1) (and not onUserLeave since Bob2 is still active).
    await roomBob1.leave()
    await waitFor(() => hostPeerLeaves.includes(epBob1.peerId), 2_000)
    assert.deepEqual(
      bob1PeerLeaves,
      [],
      'leaving room must suppress local onPeerLeave'
    )
    assert.deepEqual(
      bob1UserLeaves,
      [],
      'leaving room must suppress local onUserLeave'
    )
    assert.deepEqual(hostPeerLeaves, [epBob1.peerId])
    assert.deepEqual(hostUserLeaves, [])

    // 2. Host leaves while connected to Bob2 and Carol (and simulate an abrupt mid-leave
    //    transport close on Carol's handle during the leave flush window).
    const hostLeaveP = roomHost.leave()
    linkCarol.peerA.destroy()
    await hostLeaveP

    await waitFor(
      () =>
        bob2PeerLeaves.includes(epHost.peerId) &&
        bob2UserLeaves.includes(hostUser.userId) &&
        carolPeerLeaves.includes(epHost.peerId) &&
        carolUserLeaves.includes(hostUser.userId),
      2_000
    )

    assert.deepEqual(
      hostPeerLeaves,
      [epBob1.peerId],
      'local room.leave() must suppress local onPeerLeave for remaining peers even on mid-leave close'
    )
    assert.deepEqual(
      hostUserLeaves,
      [],
      'local room.leave() must suppress local onUserLeave for remaining users'
    )
    assert.deepEqual(bob2PeerLeaves, [epHost.peerId])
    assert.deepEqual(bob2UserLeaves, [hostUser.userId])
    assert.deepEqual(carolPeerLeaves, [epHost.peerId])
    assert.deepEqual(carolUserLeaves, [hostUser.userId])
  } finally {
    await Promise.all([
      roomHost.leave().catch(() => {}),
      roomBob1.leave().catch(() => {}),
      roomBob2.leave().catch(() => {}),
      roomCarol.leave().catch(() => {})
    ])
  }
})

void test('H13: terminal startup failures (identity-failed and plugin-failed) emit onError, reject room.ready, and auto-clean up relays', async () => {
  let activeSubscriptions = 0
  let totalUnsubscribes = 0
  let postFailureAnnounces = 0
  let failedPhase = false

  const joinTrackedStrategy = createStrategy({
    init: () => ({}),
    subscribe: async () => {
      activeSubscriptions += 1
      return () => {
        activeSubscriptions -= 1
        totalUnsubscribes += 1
      }
    },
    announce: () => {
      if (failedPhase) {
        postFailureAnnounces += 1
      }
      return 40
    }
  })

  // 1. Delayed identity-failed after relay has already subscribed
  const identityErrors: RoomError[] = []
  const identityFailRoom = joinTrackedStrategy(
    {
      appId: 'h13-startup-fail-app',
      identity: async () => {
        await wait(30)
        throw new Error('vault identity unavailable')
      },
      rtcPolyfill: MockRTCPeerConnection as unknown as typeof RTCPeerConnection
    },
    'h13-identity-room'
  )
  identityFailRoom.onError(err => identityErrors.push(err))

  await assert.rejects(identityFailRoom.ready, /vault identity unavailable/)
  await waitFor(
    () => identityErrors.length === 1 && activeSubscriptions === 0,
    2_000
  )
  failedPhase = true
  await wait(80)
  failedPhase = false

  assert.equal(identityErrors[0]!.code, 'identity-failed')
  assert.match(identityErrors[0]!.message, /vault identity unavailable/)
  assert.equal(
    totalUnsubscribes,
    1,
    'relay subscription must be cleaned up automatically without calling room.leave()'
  )
  assert.equal(
    postFailureAnnounces,
    0,
    'announce timers must not fire after automatic startup failure cleanup'
  )

  // Verify occupiedRooms slot was released by automatic cleanup
  const replacementIdentityRoom = joinTrackedStrategy(
    {
      appId: 'h13-startup-fail-app',
      rtcPolyfill: MockRTCPeerConnection as unknown as typeof RTCPeerConnection
    },
    'h13-identity-room'
  )
  assert.notEqual(
    replacementIdentityRoom,
    identityFailRoom,
    'failed room must release its occupiedRooms slot automatically'
  )
  await replacementIdentityRoom.leave()

  // 2. plugin-failed during resolveRoomId
  const resolveErrors: RoomError[] = []
  const badResolvePlugin = makeInternalPlugin('scale', () => ({}), {
    resolveRoomId: async () => {
      await wait(15)
      throw new Error('room resolver rejected')
    }
  })
  const pluginResolveFailRoom = joinTrackedStrategy(
    {
      appId: 'h13-startup-fail-app',
      use: [badResolvePlugin],
      rtcPolyfill: MockRTCPeerConnection as unknown as typeof RTCPeerConnection
    },
    'h13-plugin-resolve-room'
  )
  pluginResolveFailRoom.onError(err => resolveErrors.push(err))

  await assert.rejects(pluginResolveFailRoom.ready, /room resolver rejected/)
  await waitFor(() => resolveErrors.length === 1, 2_000)
  assert.equal(resolveErrors[0]!.code, 'plugin-failed')
  if (resolveErrors[0]!.code === 'plugin-failed') {
    assert.equal(resolveErrors[0]!.plugin, 'scale')
  }
  assert.equal(activeSubscriptions, 0)

  // 3. plugin-failed when plugin setup() throws after async resolveRoomId
  const setupErrors: RoomError[] = []
  const badSetupPlugin = makeInternalPlugin(
    'scale',
    () => {
      throw new Error('plugin setup exploded')
    },
    {
      resolveRoomId: async ({roomId}) => {
        await wait(20)
        return {effectiveRoomId: `${roomId}:resolved`}
      }
    }
  )
  const pluginSetupFailRoom = joinTrackedStrategy(
    {
      appId: 'h13-startup-fail-app',
      use: [badSetupPlugin],
      rtcPolyfill: MockRTCPeerConnection as unknown as typeof RTCPeerConnection
    },
    'h13-plugin-setup-room'
  )
  pluginSetupFailRoom.onError(err => setupErrors.push(err))

  await assert.rejects(pluginSetupFailRoom.ready, /plugin setup exploded/)
  await waitFor(
    () => setupErrors.length === 1 && activeSubscriptions === 0,
    2_000
  )
  assert.equal(setupErrors[0]!.code, 'plugin-failed')
  if (setupErrors[0]!.code === 'plugin-failed') {
    assert.equal(setupErrors[0]!.plugin, 'scale')
  }
  assert.equal(
    activeSubscriptions,
    0,
    'setup failure must leave zero active relay subscriptions'
  )

  const replacementSetupRoom = joinTrackedStrategy(
    {
      appId: 'h13-startup-fail-app',
      rtcPolyfill: MockRTCPeerConnection as unknown as typeof RTCPeerConnection
    },
    'h13-plugin-setup-room'
  )
  assert.notEqual(
    replacementSetupRoom,
    pluginSetupFailRoom,
    'plugin setup failure must release occupiedRooms slot automatically'
  )
  await replacementSetupRoom.leave()
})

void test('H9: disconnected peers prune their PeerEntry across active and mid-handshake churn', async () => {
  const [hostId, ...churnIds] = allocTestPeerIds(11) as [string, ...string[]]
  const regMap = new Map<string, (peer: PeerHandle, id: string) => void>()

  const inspectorPlugin = makeInternalPlugin('scale', kernel => ({
    inspectEntries: (ids: readonly string[]) => ({
      allPeerIds: kernel.getAllPeerIds(),
      activePeerIds: kernel.getActivePeerIds(),
      retainedKnownUsers: ids.filter(
        id => kernel.getKnownPeerUserId(id) !== undefined
      ),
      retainedPubKeys: ids.filter(
        id => kernel.getPeerPublicKey(id) !== undefined
      ),
      retainedHandles: ids.filter(
        id => kernel.getPeerHandle(id, true) !== undefined
      )
    })
  }))

  const hostRoom = createRoom(
    f => regMap.set(hostId, f),
    () => {},
    () => {},
    {
      endpointIdentity: getTestEndpointByPeerId(hostId),
      clientId: hostId,
      appId: 'h9-churn-app',
      roomId: 'h9-churn-room',
      use: [inspectorPlugin]
    }
  )

  try {
    await hostRoom.ready

    // 1. Full connect + verify + disconnect churn across 6 peers (graceful leave & abrupt close)
    const activeChurnIds = churnIds.slice(0, 6)
    for (let i = 0; i < activeChurnIds.length; i++) {
      const remoteId = activeChurnIds[i]!
      const remoteRoom = createRoom(
        f => regMap.set(remoteId, f),
        () => {},
        () => {},
        {
          endpointIdentity: getTestEndpointByPeerId(remoteId),
          clientId: remoteId,
          appId: 'h9-churn-app',
          roomId: 'h9-churn-room'
        }
      )
      await remoteRoom.ready
      const link = createLinkedHandlePair()
      regMap.get(hostId)!(link.peerA, remoteId)
      regMap.get(remoteId)!(link.peerB, hostId)
      await waitFor(() => remoteId in hostRoom.getPeers(), 2_000)

      // Confirm PeerEntry holds userId and pubKey while connected, and getUsers() reflects the remote user
      assert.equal(Object.keys(hostRoom.getUsers()).length, 1)
      const liveSnap = hostRoom.inspectEntries([remoteId])
      assert.deepEqual(liveSnap.retainedKnownUsers, [remoteId])
      assert.deepEqual(liveSnap.retainedPubKeys, [remoteId])

      if (i % 2 === 0) {
        await remoteRoom.leave()
      } else {
        link.peerB.destroy()
        await remoteRoom.leave()
      }
      await waitFor(() => !(remoteId in hostRoom.getPeers()), 2_000)
    }

    // 2. Mid-handshake abort churn across 4 peers before activation
    const pendingChurnIds = churnIds.slice(6)
    for (const pendingId of pendingChurnIds) {
      const link = createLinkedHandlePair()
      regMap.get(hostId)!(link.peerA, pendingId)
      link.peerA.destroy()
    }
    await turn()

    assert.deepEqual(hostRoom.getPeers(), {})
    assert.deepEqual(hostRoom.getUsers(), {})
    const afterChurn = hostRoom.inspectEntries(churnIds)
    assert.deepEqual(afterChurn.allPeerIds, [])
    assert.deepEqual(afterChurn.activePeerIds, [])
    assert.deepEqual(
      afterChurn.retainedKnownUsers,
      [],
      'disconnected PeerEntry userId records must be pruned'
    )
    assert.deepEqual(
      afterChurn.retainedPubKeys,
      [],
      'disconnected PeerEntry pubKey records must be pruned'
    )
    assert.deepEqual(afterChurn.retainedHandles, [])
  } finally {
    await hostRoom.leave()
  }
})
