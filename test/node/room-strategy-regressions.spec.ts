import assert from 'node:assert/strict'
import {once} from 'node:events'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {build} from 'tsdown'
import {WebSocketServer, type WebSocket as WsSocket} from 'ws'
import {
  createTopicStrategy,
  createUserIdentity,
  roles,
  scale,
  type JoinRoomConfig,
  type PeerHandle,
  type RoomError
} from '../../packages/core/src/index.ts'
import type {InternalRoomContext} from '../../packages/core/src/internal-types.ts'
import createRoom from '../../packages/core/src/room.ts'
import createStrategy from '../../packages/core/src/strategy.ts'
import {
  joinRoom as joinFirebaseRoom,
  type FirebaseRelayConfig
} from '../../packages/firebase/src/index.ts'
import {
  getRelaySockets as getMqttRelaySockets,
  joinRoom as joinMqttRoom
} from '../../packages/mqtt/src/index.ts'
import {joinRoom as joinSupabaseRoom} from '../../packages/supabase/src/index.ts'
import {joinRoom as joinTorrentRoom} from '../../packages/torrent/src/index.ts'
import {
  allocTestPeerIds,
  BufferedPeer,
  getTestEndpointByPeerId,
  linkPeers,
  makeTestPluginSlot,
  MockRTCPeerConnection,
  testEndpoint,
  wait,
  waitFor
} from './peer-harness.ts'
import test from './test.ts'

void test('Bug 1.10: concurrent joinRoom calls run init(effectiveConfig) per room and merge defaultConfig', async () => {
  const seenRelayUrls: Array<{roomId: string; urls: string[]}> = []
  const subscribedRelays = new Map<string, string[]>()

  const joinRoom = createTopicStrategy<
    {url: string},
    JoinRoomConfig & {trickleIce?: boolean}
  >({
    defaultConfig: {trickleIce: false},
    init: config =>
      (config.relayConfig?.urls ?? ['wss://default.example']).map(url => ({
        url
      })),
    subscribeTopic: (relay, _topic, _onMessage, ctx) => {
      if (ctx.kind === 'root') {
        const list = subscribedRelays.get(ctx.roomId) ?? []
        list.push(relay.url)
        subscribedRelays.set(ctx.roomId, list)
      }
      return () => {}
    },
    publishTopic: (relay, _topic, _msg, ctx) => {
      if (ctx.kind === 'announce') {
        seenRelayUrls.push({roomId: ctx.roomId, urls: [relay.url]})
      }
    }
  })

  const observedTrickle: boolean[] = []
  const joinWithDefaultCheck = createStrategy<
    {trickle: boolean | undefined},
    JoinRoomConfig
  >({
    defaultConfig: {trickleIce: false},
    init: config => {
      observedTrickle.push(Boolean(config.trickleIce))
      return {trickle: config.trickleIce}
    },
    subscribe: () => () => {},
    announce: () => {}
  })

  const roomAlpha = joinRoom(
    {
      appId: 'bug-1-10-app',
      relayConfig: {urls: ['wss://alpha-1.example', 'wss://alpha-2.example']},
      rtcPolyfill: MockRTCPeerConnection as unknown as typeof RTCPeerConnection
    },
    'room-alpha'
  )
  const roomBeta = joinRoom(
    {
      appId: 'bug-1-10-app',
      relayConfig: {urls: ['wss://beta-only.example']},
      rtcPolyfill: MockRTCPeerConnection as unknown as typeof RTCPeerConnection
    },
    'room-beta'
  )

  const checkDefault = joinWithDefaultCheck(
    {
      appId: 'bug-1-10-defaults',
      rtcPolyfill: MockRTCPeerConnection as unknown as typeof RTCPeerConnection
    },
    'r1'
  )
  const checkOverride = joinWithDefaultCheck(
    {
      appId: 'bug-1-10-defaults',
      trickleIce: true,
      rtcPolyfill: MockRTCPeerConnection as unknown as typeof RTCPeerConnection
    },
    'r2'
  )

  try {
    await waitFor(
      () =>
        (subscribedRelays.get('room-alpha')?.length ?? 0) === 2 &&
        (subscribedRelays.get('room-beta')?.length ?? 0) === 1
    )
    assert.deepEqual(subscribedRelays.get('room-alpha')?.sort(), [
      'wss://alpha-1.example',
      'wss://alpha-2.example'
    ])
    assert.deepEqual(subscribedRelays.get('room-beta'), [
      'wss://beta-only.example'
    ])
    assert.deepEqual(observedTrickle, [false, true])
  } finally {
    await Promise.all([
      roomAlpha.leave(),
      roomBeta.leave(),
      checkDefault.leave(),
      checkOverride.leave()
    ])
  }
})

void test('Bug 1.11: concurrent maxUsers: 2 admission across all 3 peerId orderings emits zero phantom joins/leaves', async () => {
  const [idLow, idMid, idHigh] = allocTestPeerIds(3) as [string, string, string]
  const orderings: Array<[string, string, string]> = [
    [idLow, idMid, idHigh],
    [idMid, idLow, idHigh],
    [idHigh, idLow, idMid]
  ]

  for (const [hostId, p1Id, p2Id] of orderings) {
    const callbacks = new Map<string, (peer: PeerHandle, id: string) => void>()
    const joins = new Map<string, string[]>()
    const leaves = new Map<string, string[]>()
    const errors = new Map<string, RoomError[]>()

    const makeNode = (id: string) => {
      joins.set(id, [])
      leaves.set(id, [])
      errors.set(id, [])
      const r = createRoom(
        f => callbacks.set(id, f),
        () => {},
        () => {},
        {
          endpointIdentity: getTestEndpointByPeerId(id),
          clientId: id,
          appId: 'bug-1-11-app',
          roomId: `room-${hostId}-${p1Id}-${p2Id}`,
          maxUsers: 2
        }
      )
      r.onPeerJoin(({peerId}) => joins.get(id)!.push(peerId))
      r.onPeerLeave(({peerId}) => leaves.get(id)!.push(peerId))
      r.onError(err => errors.get(id)!.push(err))
      return r
    }

    const host = makeNode(hostId)
    const p1 = makeNode(p1Id)
    const p2 = makeNode(p2Id)

    try {
      const link1 = linkPeers(new BufferedPeer(), new BufferedPeer())
      const link2 = linkPeers(new BufferedPeer(), new BufferedPeer())

      callbacks.get(hostId)!(link1.peerA as unknown as PeerHandle, p1Id)
      callbacks.get(p1Id)!(link1.peerB as unknown as PeerHandle, hostId)
      callbacks.get(hostId)!(link2.peerA as unknown as PeerHandle, p2Id)
      callbacks.get(p2Id)!(link2.peerB as unknown as PeerHandle, hostId)

      await waitFor(() => {
        const hostPeers = Object.keys(host.getPeers())
        const rejectedErrors =
          (errors.get(p1Id)?.length ?? 0) + (errors.get(p2Id)?.length ?? 0)
        return hostPeers.length === 1 && rejectedErrors >= 1
      })
      await wait(40)

      const hostPeers = Object.keys(host.getPeers())
      assert.equal(
        hostPeers.length,
        1,
        `ordering ${hostId}/${p1Id}/${p2Id}: host must admit exactly 1 peer`
      )
      const winnerId = hostPeers[0]!
      const loserId = winnerId === p1Id ? p2Id : p1Id

      assert.deepEqual(
        joins.get(hostId),
        [winnerId],
        `ordering ${hostId}/${p1Id}/${p2Id}: host must only emit onPeerJoin for winner`
      )
      assert.deepEqual(
        leaves.get(hostId),
        [],
        `ordering ${hostId}/${p1Id}/${p2Id}: host must emit zero phantom onPeerLeave`
      )
      assert.deepEqual(
        errors.get(hostId),
        [],
        `ordering ${hostId}/${p1Id}/${p2Id}: host must not emit room-full`
      )
      assert.deepEqual(
        joins.get(loserId),
        [],
        `ordering ${hostId}/${p1Id}/${p2Id}: rejected peer must emit zero phantom onPeerJoin`
      )
      assert.deepEqual(
        leaves.get(loserId),
        [],
        `ordering ${hostId}/${p1Id}/${p2Id}: rejected peer must emit zero phantom onPeerLeave`
      )
      assert.equal(
        errors.get(loserId)?.some(e => e.code === 'room-full'),
        true,
        `ordering ${hostId}/${p1Id}/${p2Id}: rejected peer must receive room-full onError`
      )
    } finally {
      await Promise.all([host.leave(), p1.leave(), p2.leave()])
    }
  }

  // Full 3-way simultaneous triangle (A <-> B, A <-> C, B <-> C) with maxUsers: 2
  {
    const ids = allocTestPeerIds(6).slice(3, 6) as [string, string, string]
    const [triA, triB, triC] = ids
    const callbacks = new Map<string, (peer: PeerHandle, id: string) => void>()
    const joins = new Map<string, string[]>()
    const leaves = new Map<string, string[]>()
    const errors = new Map<string, RoomError[]>()
    const rooms = ids.map(id => {
      joins.set(id, [])
      leaves.set(id, [])
      errors.set(id, [])
      const r = createRoom(
        f => callbacks.set(id, f),
        () => {},
        () => {},
        {
          endpointIdentity: getTestEndpointByPeerId(id),
          clientId: id,
          appId: 'bug-1-11-triangle',
          roomId: 'tri-room',
          maxUsers: 2
        }
      )
      r.onPeerJoin(({peerId}) => joins.get(id)!.push(peerId))
      r.onPeerLeave(({peerId}) => leaves.get(id)!.push(peerId))
      r.onError(err => errors.get(id)!.push(err))
      return r
    })

    try {
      const pairs: Array<[string, string]> = [
        [triA, triB],
        [triA, triC],
        [triB, triC]
      ]
      for (const [leftId, rightId] of pairs) {
        const {peerA, peerB} = linkPeers(new BufferedPeer(), new BufferedPeer())
        callbacks.get(leftId)!(peerA as unknown as PeerHandle, rightId)
        callbacks.get(rightId)!(peerB as unknown as PeerHandle, leftId)
      }

      const roomById = new Map(ids.map((id, idx) => [id, rooms[idx]!]))
      const isLinkSettled = (u: string, v: string): boolean => {
        const uHasV = v in roomById.get(u)!.getPeers()
        const vHasU = u in roomById.get(v)!.getPeers()
        if (uHasV && vHasU) {
          return true
        }
        const rejected =
          (errors.get(u)?.some(e => e.code === 'room-full' && e.peerId === v) ??
            false) ||
          (errors.get(v)?.some(e => e.code === 'room-full' && e.peerId === u) ??
            false)
        return rejected && !uHasV && !vHasU
      }

      await waitFor(() => pairs.every(([u, v]) => isLinkSettled(u, v)), 3_000)
      await wait(40)

      let totalRoomFull = 0
      for (const id of ids) {
        const activePeers = Object.keys(roomById.get(id)!.getPeers())
        assert.ok(
          activePeers.length <= 1,
          `triangle node ${id} must never exceed maxUsers: 2`
        )
        assert.deepEqual(
          joins.get(id),
          activePeers,
          `triangle node ${id} must emit zero phantom onPeerJoin`
        )
        assert.deepEqual(
          leaves.get(id),
          [],
          `triangle node ${id} must emit zero phantom onPeerLeave`
        )
        for (const err of errors.get(id) ?? []) {
          assert.equal(err.code, 'room-full')
          if (err.code === 'room-full') {
            totalRoomFull += 1
            assert.equal(
              activePeers.includes(err.peerId),
              false,
              `admitted peer must not also reject ${id} with room-full`
            )
          }
        }
      }
      assert.ok(
        totalRoomFull >= 2,
        `at least 2 triangle links must be rejected with room-full, got ${totalRoomFull}`
      )
    } finally {
      await Promise.all(rooms.map(r => r.leave()))
    }
  }
})

void test('Bug 1.12: roles + scale order independence, KernelScaleProvider, and virtual peers in getActivePeerIds', async () => {
  const adminIdentity = await createUserIdentity()
  const epAdmin = testEndpoint('bug-1-12-admin')
  const seenRoomIdsInScale: string[] = []

  const suffixScalePlugin = makeTestPluginSlot('scale', kernel => {
    kernel.onRoomIdChanged(rid => seenRoomIdsInScale.push(rid))
    return {
      inspectKernel: () => ({
        activePeers: kernel.getActivePeerIds(),
        effectiveRoomId: kernel.getRoomId()
      })
    }
  })

  const roomAdmin = createRoom(
    () => {},
    () => {},
    () => {},
    {
      endpointIdentity: epAdmin,
      appId: 'bug-1-12-app',
      roomId: 'base-room',
      identity: adminIdentity,
      // Even when passed with scale first, roles setup runs before scale setup
      use: [suffixScalePlugin, roles({selfAsAdmin: true})]
    }
  )

  try {
    const selfInfo = await roomAdmin.getSelf()
    const expectedEffectiveRoomId = `base-room~${adminIdentity.userId}`
    assert.deepEqual(seenRoomIdsInScale, [expectedEffectiveRoomId])
    assert.equal(selfInfo.roomId, expectedEffectiveRoomId)
    assert.equal(selfInfo.isAdmin, true)
    assert.equal(
      roomAdmin.inspectKernel().effectiveRoomId,
      expectedEffectiveRoomId
    )
  } finally {
    await roomAdmin.leave()
  }

  // Verify 2-hop virtual peer appears in kernel.getActivePeerIds() and getTopology()
  let observerKernel = null as InternalRoomContext | null
  const observerRolesPlugin = makeTestPluginSlot('roles', kernel => {
    observerKernel = kernel
    return {}
  })

  const callbacks = new Map<string, (peer: PeerHandle, id: string) => void>()
  const [idA, idB, idC] = allocTestPeerIds(3) as [string, string, string]
  const makeLineNode = (id: string, useObserver = false) =>
    createRoom(
      f => callbacks.set(id, f),
      () => {},
      () => {},
      {
        endpointIdentity: getTestEndpointByPeerId(id),
        clientId: id,
        appId: 'bug-1-12-line',
        roomId: 'line-room',
        use: useObserver
          ? [scale({maxDirectPeers: 4}), observerRolesPlugin]
          : [scale({maxDirectPeers: 4})]
      }
    )

  const nodeA = makeLineNode(idA, true)
  const nodeB = makeLineNode(idB, false)
  const nodeC = makeLineNode(idC, false)

  try {
    const linkAB = linkPeers(new BufferedPeer(), new BufferedPeer())
    const linkBC = linkPeers(new BufferedPeer(), new BufferedPeer())

    callbacks.get(idA)!(linkAB.peerA as unknown as PeerHandle, idB)
    callbacks.get(idB)!(linkAB.peerB as unknown as PeerHandle, idA)
    callbacks.get(idB)!(linkBC.peerA as unknown as PeerHandle, idC)
    callbacks.get(idC)!(linkBC.peerB as unknown as PeerHandle, idB)

    await waitFor(() => Boolean(nodeA.getPeers()[idC]), 4_000)

    assert.ok(observerKernel)
    const activeIds = observerKernel.getActivePeerIds()
    assert.equal(activeIds.includes(idB), true)
    assert.equal(
      activeIds.includes(idC),
      true,
      'kernel.getActivePeerIds() must include multi-hop virtual peers'
    )
    assert.equal(observerKernel.getScaleProvider()?.isVirtualPeer(idC), true)
    assert.equal(observerKernel.getScaleProvider()?.isDirectPeer(idB), true)

    const topo = nodeA.getTopology()
    assert.equal(topo.peerId, idA)
    assert.deepEqual(topo.directPeerIds, [idB])
    assert.equal(topo.routes[idC]?.hops, 2)
  } finally {
    await Promise.all([nodeA.leave(), nodeB.leave(), nodeC.leave()])
  }
})

void test('H5: Firebase permission_denied listener error rejects root subscription and emits relay-failed', async () => {
  const firebaseRequire = createRequire(
    resolve('packages/firebase/package.json')
  )
  const {initializeApp, deleteApp} = firebaseRequire('firebase/app') as {
    initializeApp: (
      opts: {databaseURL: string},
      name: string
    ) => FirebaseRelayConfig['firebaseApp']
    deleteApp: (
      app: NonNullable<FirebaseRelayConfig['firebaseApp']>
    ) => Promise<void>
  }
  const {getDatabase, goOffline} = firebaseRequire('firebase/database') as {
    getDatabase: (
      app: NonNullable<FirebaseRelayConfig['firebaseApp']>
    ) => unknown
    goOffline: (db: unknown) => void
  }

  const wss = new WebSocketServer({host: '127.0.0.1', port: 0})
  await once(wss, 'listening')
  const addr = wss.address()
  assert.ok(addr && typeof addr !== 'string')

  wss.on('connection', ws => {
    ws.send(
      JSON.stringify({
        t: 'c',
        d: {
          t: 'h',
          d: {
            ts: Date.now(),
            v: '5',
            h: `127.0.0.1:${addr.port}`,
            s: 'sess-h5'
          }
        }
      })
    )
    ws.on('message', (raw, isBinary) => {
      const text = isBinary ? '' : Buffer.from(raw as Buffer).toString('utf8')
      const msg = JSON.parse(text) as {
        t?: string
        d?: {r?: number; a?: string}
      }
      if (
        msg.t === 'd' &&
        typeof msg.d?.r === 'number' &&
        (msg.d.a === 'q' || msg.d.a === 'n')
      ) {
        ws.send(
          JSON.stringify({
            t: 'd',
            d: {
              r: msg.d.r,
              b: {s: 'permission_denied', d: 'Permission denied'}
            }
          })
        )
      }
    })
  })

  const fbApp = initializeApp(
    {databaseURL: `http://127.0.0.1:${addr.port}?ns=trystero-h5`},
    `h5-app-${Date.now()}`
  )!
  const errors: RoomError[] = []
  const room = joinFirebaseRoom(
    {
      appId: 'firebase-h5-app',
      relayConfig: {firebaseApp: fbApp, warnOnRelayFailure: false},
      rtcPolyfill: MockRTCPeerConnection as unknown as typeof RTCPeerConnection
    },
    'restricted-room'
  )
  room.onError(err => errors.push(err))

  try {
    await waitFor(() => errors.length === 1, 3_000)
    assert.equal(errors[0]!.code, 'relay-failed')
    assert.match(errors[0]!.message, /permission_denied/i)
    assert.equal(errors[0]!.appId, 'firebase-h5-app')
    assert.equal(errors[0]!.roomId, 'restricted-room')
  } finally {
    await room.leave().catch(() => {})
    goOffline(getDatabase(fbApp))
    await deleteApp(fbApp).catch(() => {})
    wss.clients.forEach(c => c.terminate())
    await new Promise<void>(r => wss.close(() => r()))
  }
})

void test('H6: MQTT initial connection failure across configured brokers emits relay-failed via socketInitialFailureSymbol', async () => {
  const wss = new WebSocketServer({host: '127.0.0.1', port: 0})
  await once(wss, 'listening')
  const addr = wss.address()
  assert.ok(addr && typeof addr !== 'string')
  wss.on('connection', ws => {
    ws.close()
  })

  const realSetTimeout = globalThis.setTimeout
  const realSetInterval = globalThis.setInterval
  const capturedTimers: Array<ReturnType<typeof setTimeout>> = []
  const capturedIntervals: Array<ReturnType<typeof setInterval>> = []
  globalThis.setTimeout = ((
    fn: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    const t = realSetTimeout(fn, ms, ...args)
    capturedTimers.push(t)
    return t
  }) as typeof setTimeout
  globalThis.setInterval = ((
    fn: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    const i = realSetInterval(fn, ms, ...args)
    capturedIntervals.push(i)
    return i
  }) as typeof setInterval

  const errors: RoomError[] = []
  const room = joinMqttRoom(
    {
      appId: `mqtt-h6-app-${Date.now()}`,
      relayConfig: {
        urls: [
          `ws://127.0.0.1:${addr.port}/mqtt-dead-1`,
          `ws://127.0.0.1:${addr.port}/mqtt-dead-2`
        ],
        warnOnRelayFailure: false
      },
      rtcPolyfill: MockRTCPeerConnection as unknown as typeof RTCPeerConnection
    },
    'mqtt-h6-room'
  )
  room.onError(err => errors.push(err))

  try {
    await waitFor(() => errors.length === 1, 3_000)
    assert.equal(errors[0]!.code, 'relay-failed')
    assert.match(errors[0]!.message, /MQTT connection failed/)
    assert.equal(errors[0]!.roomId, 'mqtt-h6-room')
  } finally {
    await room.leave().catch(() => {})
    Object.values(getMqttRelaySockets()).forEach(sock => sock?.close?.())
    wss.clients.forEach(c => c.terminate())
    await new Promise<void>(r => wss.close(() => r()))
    await new Promise<void>(r => realSetTimeout(r, 20))
    capturedTimers.forEach(t => clearTimeout(t))
    capturedIntervals.forEach(i => clearInterval(i))
    globalThis.setTimeout = realSetTimeout
    globalThis.setInterval = realSetInterval
  }
})

void test('H7: Supabase sweeps unsubscribed idle peer signal channels after 30s while keeping room channels open', async t => {
  const realSetTimeout = globalThis.setTimeout
  const sweepCallbacks: Array<() => void> = []

  t.mock.method(globalThis, 'setTimeout', ((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (delay === 30_000) {
      sweepCallbacks.push(() => callback(...args))
      return realSetTimeout(() => {}, 0)
    }
    return realSetTimeout(callback, delay === 50_000 ? 0 : delay, ...args)
  }) as typeof setTimeout)

  const wss = new WebSocketServer({host: '127.0.0.1', port: 0})
  await once(wss, 'listening')
  const addr = wss.address()
  assert.ok(addr && typeof addr !== 'string')

  const joinedTopics: string[] = []
  const leftTopics: string[] = []
  let activeSocket: WsSocket | null = null
  let rootChannelTopic: string | null = null
  let signalBroadcastCount = 0

  wss.on('connection', socket => {
    activeSocket = socket
    socket.on('message', (bytes, isBinary) => {
      const dec = new TextDecoder()
      if (isBinary) {
        const u8 = ArrayBuffer.isView(bytes)
          ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
          : new Uint8Array(
              bytes instanceof ArrayBuffer ? bytes : Buffer.concat(bytes)
            )
        // Supabase Realtime v2 binary userBroadcastPush (kind = 3)
        if (u8[0] === 3 && u8.byteLength >= 7) {
          const joinRefLen = u8[1]!
          const refLen = u8[2]!
          const topicLen = u8[3]!
          const eventLen = u8[4]!
          const topicOffset = 7 + joinRefLen + refLen
          const topic = dec.decode(
            u8.subarray(topicOffset, topicOffset + topicLen)
          )
          const userEvent = dec.decode(
            u8.subarray(
              topicOffset + topicLen,
              topicOffset + topicLen + eventLen
            )
          )
          if (userEvent === 'join') {
            rootChannelTopic = topic
          } else if (userEvent === 'sdp') {
            signalBroadcastCount += 1
          }
        }
        return
      }
      const [joinRef, ref, topic, event, payload] = JSON.parse(
        dec.decode(bytes as Uint8Array)
      ) as [
        string | null,
        string | null,
        string,
        string,
        {event?: string} | undefined
      ]
      if (event === 'phx_join') {
        joinedTopics.push(topic)
      } else if (event === 'phx_leave') {
        leftTopics.push(topic)
      } else if (event === 'broadcast') {
        if (payload?.event === 'join') {
          rootChannelTopic = topic
        } else if (payload?.event === 'sdp') {
          signalBroadcastCount += 1
        }
      }
      if (
        event === 'phx_join' ||
        event === 'phx_leave' ||
        event === 'heartbeat'
      ) {
        socket.send(
          JSON.stringify([
            joinRef,
            ref,
            topic,
            'phx_reply',
            {status: 'ok', response: {}}
          ])
        )
      }
    })
  })

  const room = joinSupabaseRoom(
    {
      appId: `http://127.0.0.1:${addr.port}`,
      relayConfig: {supabaseKey: 'supabase-h7-key'},
      rtcPolyfill: MockRTCPeerConnection as unknown as typeof RTCPeerConnection
    },
    'supabase-h7-room'
  )

  try {
    const {peerId: selfPeerId} = await room.getSelf()
    await waitFor(
      () => joinedTopics.length === 2 && rootChannelTopic !== null,
      3_000
    )
    const initialRoomTopics = new Set(joinedTopics)

    // Deliver a remote peer join announcement (valid base58 peerId so local room dials and publishes a signal)
    const remotePeerId =
      selfPeerId === 'z'.repeat(20) ? 'y'.repeat(20) : 'z'.repeat(20)
    activeSocket!.send(
      JSON.stringify([
        null,
        null,
        rootChannelTopic,
        'broadcast',
        {
          type: 'broadcast',
          event: 'join',
          payload: {peerId: remotePeerId}
        }
      ])
    )

    await waitFor(
      () =>
        joinedTopics.length === 3 &&
        signalBroadcastCount >= 1 &&
        sweepCallbacks.length >= 1,
      3_000
    )
    const peerSignalTopic = joinedTopics.find(tp => !initialRoomTopics.has(tp))!
    assert.ok(peerSignalTopic, 'expected a 3rd signal channel to be joined')
    assert.equal(
      leftTopics.length,
      0,
      'signal channel stays open during active signaling before sweep'
    )

    // Fire the 30s idle signal channel sweep while room stays open
    sweepCallbacks.splice(0).forEach(cb => cb())
    await waitFor(() => leftTopics.includes(peerSignalTopic), 2_000)

    assert.deepEqual(
      leftTopics,
      [peerSignalTopic],
      'idle sweep must remove only the unsubscribed peer signal channel while keeping root/self subscribed'
    )
  } finally {
    await room.leave().catch(() => {})
    await waitFor(() => wss.clients.size === 0, 2_000).catch(() => {})
    wss.clients.forEach(c => c.terminate())
    await new Promise<void>(r => wss.close(() => r()))
  }
})

void test('H10: Torrent cleans up infoHash maps and reclaims pre-allocated offers when last room subscriber leaves', async () => {
  const origWebSocket = globalThis.WebSocket
  const sockets: TorrentMockWs[] = []

  class TorrentMockWs {
    readyState = 0
    sent: Array<{action: string; info_hash: string}> = []
    onopen: (() => void) | null = null
    onclose: (() => void) | null = null
    onmessage: ((ev: {data: string}) => void) | null = null
    url: string

    constructor(url: string) {
      this.url = url
      sockets.push(this)
      queueMicrotask(() => {
        this.readyState = 1
        this.onopen?.()
      })
    }

    send(data: string) {
      this.sent.push(JSON.parse(data) as {action: string; info_hash: string})
    }

    close() {
      this.readyState = 3
      this.onclose?.()
    }
  }

  let createdPcs = 0
  let closedPcs = 0
  class TrackingPc extends MockRTCPeerConnection {
    constructor() {
      super()
      createdPcs += 1
    }
    override close() {
      if (this.connectionState !== 'closed') {
        closedPcs += 1
      }
      super.close()
    }
  }

  globalThis.WebSocket = TorrentMockWs as unknown as typeof WebSocket
  const trackerUrl = `wss://torrent-h10-${Date.now()}.test`
  const appId = `torrent-h10-app-${Date.now()}`
  const roomId = 'torrent-h10-room'

  let room1: ReturnType<typeof joinTorrentRoom> | undefined
  let room2: ReturnType<typeof joinTorrentRoom> | undefined
  try {
    room1 = joinTorrentRoom(
      {
        appId,
        password: 'h10-password',
        relayConfig: {urls: [trackerUrl]},
        rtcPolyfill: TrackingPc as unknown as typeof RTCPeerConnection
      },
      roomId
    )

    await waitFor(
      () => (sockets[0]?.sent.length ?? 0) >= 1 && createdPcs >= 1,
      2_000
    )
    const sock = sockets[0]!
    const infoHash = sock.sent[0]!.info_hash
    assert.equal(typeof infoHash, 'string')
    assert.equal(infoHash.length, 20)

    // Leaving the last subscriber must reclaim outstanding offers, close idle socket, AND delete infoHashToTopic[infoHash]
    await room1.leave()
    room1 = undefined
    assert.equal(
      closedPcs,
      createdPcs,
      'all pre-allocated torrent offer peers must be closed on leave'
    )
    assert.equal(
      sock.readyState,
      3,
      'torrent tracker socket must close when activeRooms reaches 0'
    )

    // Inject a tracker offer for that info_hash while no room is subscribed.
    // Because infoHashToTopic[infoHash] was deleted on leave, this message must be ignored
    // without recording offer_id 'probe-h10' in Torrent's 4-second handledSignals dedupe cache.
    const remotePeerH10 = 'RemotePeerH100000001'
    sock.onmessage?.({
      data: JSON.stringify({
        info_hash: infoHash,
        peer_id: remotePeerH10,
        offer_id: 'probe-h10',
        offer: {type: 'offer', sdp: 'corrupt-ciphertext'}
      })
    })

    // Re-join the same room immediately (within the 4s dedupe window) and deliver the exact same
    // offer_id on the reopened tracker socket: it must NOT be suppressed by stale handledSignals.
    const room2Errors: RoomError[] = []
    room2 = joinTorrentRoom(
      {
        appId,
        password: 'h10-password',
        relayConfig: {urls: [trackerUrl]},
        rtcPolyfill: TrackingPc as unknown as typeof RTCPeerConnection
      },
      roomId
    )
    room2.onError(err => room2Errors.push(err))

    await waitFor(() => (sockets[1]?.sent.length ?? 0) >= 1, 2_000)
    const sock2 = sockets[1]!
    sock2.onmessage?.({
      data: JSON.stringify({
        info_hash: infoHash,
        peer_id: remotePeerH10,
        offer_id: 'probe-h10',
        offer: {type: 'offer', sdp: 'corrupt-ciphertext'}
      })
    })

    await waitFor(() => room2Errors.length === 1, 2_000)
    assert.equal(room2Errors[0]!.code, 'decrypt-failed')
    if (room2Errors[0]!.code === 'decrypt-failed') {
      assert.equal(room2Errors[0]!.peerId, remotePeerH10)
    }
  } finally {
    await room1?.leave().catch(() => {})
    await room2?.leave().catch(() => {})
    sockets.forEach(s => s.close())
    globalThis.WebSocket = origWebSocket
  }
})

void test('Tree-shaking: bundling defaultRelayUrls from trystero stays under 1.5 KB minified', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'trystero-treeshake-'))
  try {
    const entryFile = join(tempDir, 'entry.ts')
    const trysteroEntry = resolve('packages/trystero/src/index.ts')
    await writeFile(
      entryFile,
      `export {defaultRelayUrls} from ${JSON.stringify(trysteroEntry)}\n`
    )

    await build({
      config: false,
      clean: false,
      entry: {entry: entryFile},
      outDir: tempDir,
      dts: false,
      format: 'es',
      platform: 'browser',
      sourcemap: false,
      minify: true,
      logLevel: 'silent',
      deps: {
        alwaysBundle: [/^@trystero-p2p\//, /^trystero$/],
        onlyBundle: false
      },
      alias: {
        '@trystero-p2p/core': resolve('packages/core/src/index.ts'),
        '@trystero-p2p/nostr': resolve('packages/nostr/src/index.ts'),
        '@trystero-p2p/torrent': resolve('packages/torrent/src/index.ts'),
        crypto: resolve('scripts/empty.ts'),
        'node:crypto': resolve('scripts/empty.ts')
      },
      outputOptions: {
        codeSplitting: false
      }
    })

    const bundled = await readFile(join(tempDir, 'entry.js'), 'utf8')
    assert.ok(
      Buffer.byteLength(bundled, 'utf8') < 1_500,
      `expected minified defaultRelayUrls bundle < 1500B, got ${Buffer.byteLength(bundled, 'utf8')}B:\n${bundled}`
    )
  } finally {
    await rm(tempDir, {recursive: true, force: true})
  }
})
