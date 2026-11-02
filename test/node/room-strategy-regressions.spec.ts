import assert from 'node:assert/strict'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {build} from 'tsdown'
import {
  createTopicStrategy,
  createUserIdentity,
  definePlugin,
  roles,
  scale,
  type JoinRoomConfig,
  type PeerHandle,
  type PluginContext,
  type RoomError
} from '../../packages/core/src/index.ts'
import createRoom from '../../packages/core/src/room.ts'
import createStrategy from '../../packages/core/src/strategy.ts'
import {
  allocTestPeerIds,
  BufferedPeer,
  linkPeers,
  MockRTCPeerConnection,
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

void test('Bug 1.11: concurrent limit: 2 admission across all 3 peerId orderings emits zero phantom joins/leaves', async () => {
  const orderings: Array<[string, string, string]> = [
    ['peer-a', 'peer-b', 'peer-c'],
    ['peer-m', 'peer-b', 'peer-z'],
    ['peer-z', 'peer-b', 'peer-c']
  ]

  for (const [hostId, p1Id, p2Id] of orderings) {
    const callbacks = new Map<string, (peer: PeerHandle, id: string) => void>()
    const joins = new Map<string, string[]>()
    const leaves = new Map<string, string[]>()
    const errors = new Map<string, RoomError[]>()

    const makeNode = (selfId: string) => {
      joins.set(selfId, [])
      leaves.set(selfId, [])
      errors.set(selfId, [])
      const r = createRoom(
        f => callbacks.set(selfId, f),
        () => {},
        () => {},
        {
          selfId,
          appId: 'bug-1-11-app',
          roomId: `room-${hostId}-${p1Id}-${p2Id}`,
          limit: 2
        }
      )
      r.onPeerJoin(({peerId}) => joins.get(selfId)!.push(peerId))
      r.onPeerLeave(({peerId}) => leaves.get(selfId)!.push(peerId))
      r.onError(err => errors.get(selfId)!.push(err))
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

  // Full 3-way simultaneous triangle (A <-> B, A <-> C, B <-> C) with limit: 2
  {
    const ids = ['tri-a', 'tri-b', 'tri-c'] as const
    const callbacks = new Map<string, (peer: PeerHandle, id: string) => void>()
    const joins = new Map<string, string[]>()
    const leaves = new Map<string, string[]>()
    const errors = new Map<string, RoomError[]>()
    const rooms = ids.map(selfId => {
      joins.set(selfId, [])
      leaves.set(selfId, [])
      errors.set(selfId, [])
      const r = createRoom(
        f => callbacks.set(selfId, f),
        () => {},
        () => {},
        {
          selfId,
          appId: 'bug-1-11-triangle',
          roomId: 'tri-room',
          limit: 2
        }
      )
      r.onPeerJoin(({peerId}) => joins.get(selfId)!.push(peerId))
      r.onPeerLeave(({peerId}) => leaves.get(selfId)!.push(peerId))
      r.onError(err => errors.get(selfId)!.push(err))
      return r
    })

    try {
      const pairs: Array<[string, string]> = [
        ['tri-a', 'tri-b'],
        ['tri-a', 'tri-c'],
        ['tri-b', 'tri-c']
      ]
      for (const [leftId, rightId] of pairs) {
        const {peerA, peerB} = linkPeers(new BufferedPeer(), new BufferedPeer())
        callbacks.get(leftId)!(peerA as unknown as PeerHandle, rightId)
        callbacks.get(rightId)!(peerB as unknown as PeerHandle, leftId)
      }

      await waitFor(() => {
        const counts = rooms
          .map(r => Object.keys(r.getPeers()).length)
          .sort((a, b) => a - b)
        const totalRoomFull = ids.reduce(
          (n, id) =>
            n +
            (errors.get(id)?.filter(e => e.code === 'room-full').length ?? 0),
          0
        )
        return (
          counts[0] === 0 &&
          counts[1] === 1 &&
          counts[2] === 1 &&
          totalRoomFull === 1
        )
      })
      await wait(40)

      for (const id of ids) {
        assert.deepEqual(
          leaves.get(id),
          [],
          `triangle node ${id} must emit zero phantom onPeerLeave`
        )
      }
      const loserIdx = rooms.findIndex(
        r => Object.keys(r.getPeers()).length === 0
      )
      assert.notEqual(loserIdx, -1)
      const loserId = ids[loserIdx]!
      assert.deepEqual(joins.get(loserId), [])
      assert.equal(
        errors.get(loserId)?.some(e => e.code === 'room-full'),
        true
      )
    } finally {
      await Promise.all(rooms.map(r => r.leave()))
    }
  }
})

void test('Bug 1.12: sequential resolveRoomId chaining, PublicScaleProvider, virtual peers in getActivePeerIds, and narrowed PluginContext', async () => {
  const adminIdentity = await createUserIdentity()
  let capturedKernel = null as PluginContext | null
  const seenRoomIdsInResolvers: string[] = []

  const suffixPlugin = definePlugin('env-suffix', {
    resolveRoomId: async ({roomId}) => {
      seenRoomIdsInResolvers.push(roomId)
      return {effectiveRoomId: `${roomId}:staging`}
    },
    setup(kernel) {
      capturedKernel = kernel
      return {
        inspectKernel: () => ({
          activePeers: kernel.getActivePeerIds(),
          scaleSnapshot: kernel.getScaleProvider()?.getSnapshot(),
          hasInternalMutator:
            'setEffectiveRoomId' in (kernel as Record<string, unknown>) ||
            'registerRolesProvider' in (kernel as Record<string, unknown>) ||
            'registerScaleProvider' in (kernel as Record<string, unknown>) ||
            'activateVirtualPeer' in (kernel as Record<string, unknown>)
        })
      }
    }
  })

  const prefixSeenRoomIds: string[] = []
  const prefixPlugin = definePlugin('env-prefix', {
    resolveRoomId: async ({roomId}) => {
      prefixSeenRoomIds.push(roomId)
      return {effectiveRoomId: `staging:${roomId}`}
    },
    setup: () => ({})
  })

  const roomPrefixed = createRoom(
    () => {},
    () => {},
    () => {},
    {
      selfId: 'node-prefixed1234567',
      appId: 'bug-1-12-app',
      roomId: 'base-room',
      identity: adminIdentity,
      verifyPeerIdentity: true,
      runIdentityHandshake: true,
      use: [prefixPlugin, roles({selfAsAdmin: true})]
    }
  )

  try {
    const prefixedSelf = await roomPrefixed.getSelf()
    assert.deepEqual(prefixSeenRoomIds, ['base-room'])
    assert.equal(
      prefixedSelf.roomId,
      `staging:base-room~${adminIdentity.userId}`
    )
    assert.equal(prefixedSelf.baseRoomId, 'staging:base-room')
    assert.equal(prefixedSelf.isAdmin, true)
  } finally {
    await roomPrefixed.leave()
  }

  const callbacks = new Map<string, (peer: PeerHandle, id: string) => void>()
  const roomAdmin = createRoom(
    f => callbacks.set('node-admin1234567890', f),
    () => {},
    () => {},
    {
      selfId: 'node-admin1234567890',
      appId: 'bug-1-12-app',
      roomId: 'base-room',
      identity: adminIdentity,
      verifyPeerIdentity: true,
      runIdentityHandshake: true,
      use: [
        roles({selfAsAdmin: true}),
        suffixPlugin,
        scale({mode: 'gossip', maxConnections: 4})
      ]
    }
  )

  try {
    const selfInfo = await roomAdmin.getSelf()
    assert.equal(seenRoomIdsInResolvers.length, 1)
    assert.match(seenRoomIdsInResolvers[0]!, /^base-room~[A-Za-z0-9_-]{20,}$/)
    assert.equal(selfInfo.roomId, `${seenRoomIdsInResolvers[0]}:staging`)
    assert.equal(selfInfo.isAdmin, true)
    assert.ok(capturedKernel)

    const inspection = roomAdmin.inspectKernel()
    assert.equal(
      inspection.hasInternalMutator,
      false,
      '3rd-party PluginContext must not expose internal kernel mutators'
    )
    assert.equal(inspection.scaleSnapshot?.mode, 'gossip')
    assert.equal(
      typeof capturedKernel.getScaleProvider()?.isVirtualPeer,
      'function'
    )
    assert.equal(
      typeof capturedKernel.getScaleProvider()?.isDirectPeer,
      'function'
    )
  } finally {
    await roomAdmin.leave()
  }

  // Verify 2-hop virtual peer appears in kernel.getActivePeerIds()
  let observerKernel = null as PluginContext | null
  const observerPlugin = definePlugin('observer', {
    setup(kernel) {
      observerKernel = kernel
    }
  })

  const [idA, idB, idC] = allocTestPeerIds(3) as [string, string, string]
  const makeLineNode = (selfId: string, useObserver = false) =>
    createRoom(
      f => callbacks.set(selfId, f),
      () => {},
      () => {},
      {
        selfId,
        appId: 'bug-1-12-line',
        roomId: 'line-room',
        use: useObserver
          ? [scale({mode: 'gossip', maxConnections: 4}), observerPlugin]
          : [scale({mode: 'gossip', maxConnections: 4})]
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
  } finally {
    await Promise.all([nodeA.leave(), nodeB.leave(), nodeC.leave()])
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
        '@trystero-p2p/core/public': resolve('packages/core/src/public.ts'),
        '@trystero-p2p/core': resolve('packages/core/src/index.ts'),
        '@trystero-p2p/torrent': resolve('packages/torrent/src/index.ts'),
        crypto: resolve('scripts/empty.ts'),
        'node:crypto': resolve('scripts/empty.ts')
      },
      inputOptions: {
        transform: {
          dropLabels: ['DEV']
        }
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
