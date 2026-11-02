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
import type {InternalRoomContext} from '../../packages/core/src/internal-types.ts'
import {internalPluginSymbol} from '../../packages/core/src/primitives.ts'
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
  connectVerifiedPeers,
  createLinkedHandlePair,
  makeStream,
  makeTrack,
  turn,
  waitFor
} from './peer-harness.ts'

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
    assert.equal(hydratedReplays[0]!.ctx.peerId, 'peer-admin')
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

  const setupLifecycleProbe = (kernel: InternalRoomContext) => {
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
  const lifecyclePlugin = Object.assign(
    definePlugin('lifecycle-probe', {
      setup: () => ({
        triggerRoomIdChange: (_next: string) => {},
        abortFirstLeaveHook: () => {},
        unsubDeact: () => {}
      })
    }),
    {
      [internalPluginSymbol]: {
        kind: 'internal' as const,
        setup: setupLifecycleProbe
      }
    }
  )

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
      client.close?.()
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
