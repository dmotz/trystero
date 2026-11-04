import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {existsSync, readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import test from './test.ts'
import * as corePublicExports from '../../packages/core/src/index.ts'
import {roles, scale} from '../../packages/core/src/index.ts'
import {createMemorySignalBus} from './memory-rtc.ts'

void test('Production build: built-in plugins work on the first room, definePlugin and public.mjs are un-exported, and built .d.mts omits test-only symbols and __config', () => {
  const distIndexMjs = resolve(
    import.meta.dirname,
    '../../packages/core/dist/index.mjs'
  )
  const distIndexDmts = resolve(
    import.meta.dirname,
    '../../packages/core/dist/index.d.mts'
  )

  assert.equal(
    existsSync(
      resolve(import.meta.dirname, '../../packages/core/dist/public.mjs')
    ),
    false,
    '@trystero-p2p/core/public runtime bundle must not exist'
  )
  assert.equal(
    existsSync(
      resolve(import.meta.dirname, '../../packages/core/dist/public.d.mts')
    ),
    false,
    '@trystero-p2p/core/public dts bundle must not exist'
  )

  const script = `
    import assert from 'node:assert/strict'
    import * as core from ${JSON.stringify(distIndexMjs)}

    assert.equal('definePlugin' in core, false, 'definePlugin must not be publicly exported')

    const joinRoom = core.createTopicStrategy({
      init: () => ({}),
      subscribeTopic: () => () => {},
      publishTopic: () => {}
    })

    const room = joinRoom(
      {
        appId: 'prod-first-room-app',
        use: [core.roles({selfAsAdmin: true}), core.scale()]
      },
      'room-1'
    )

    assert.equal(typeof room.grantRole, 'function')
    assert.equal(typeof room.unban, 'function')
    assert.equal(typeof room.getTopology, 'function')
    await room.ready

    const self = await room.getSelf()
    assert.match(self.peerId, /^[0-9A-Za-z]{20}$/, 'self.peerId must be a resolved 20-char peerId in production build')
    assert.equal(room.getTopology().peerId, self.peerId)
    await room.leave()
  `

  execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    stdio: 'pipe'
  })

  const dtsContent = readFileSync(distIndexDmts, 'utf8')
  const typesDtsContent = readFileSync(
    resolve(import.meta.dirname, '../../packages/core/dist/types.d.mts'),
    'utf8'
  )
  const distBundles = ['strategy.mjs', 'identity.mjs', 'room.mjs', 'peer.mjs']
    .map(name =>
      readFileSync(
        resolve(import.meta.dirname, `../../packages/core/dist/${name}`),
        'utf8'
      )
    )
    .join('\n')

  for (const forbidden of [
    'forcedPeerId',
    'scopeAppId',
    'registerTestForcedPeerId',
    'endpointIdentityByPeerId',
    'registeredTestForcedPeerIds',
    'resolvedTestEndpointCanonicalJwk',
    'getDefaultTestUserIdentity',
    'setDevIdentityProvider',
    'devIdentityProvider',
    'TestOnlyRoomConfig',
    '_test_only_mdnsHostFallbackToLoopback'
  ]) {
    assert.equal(
      distBundles.includes(forbidden),
      false,
      `production dist bundle must not contain "${forbidden}"`
    )
    assert.equal(
      dtsContent.includes(forbidden),
      false,
      `built index.d.mts must not contain "${forbidden}"`
    )
    assert.equal(
      typesDtsContent.includes(forbidden),
      false,
      `built types.d.mts must not contain "${forbidden}"`
    )
  }
  assert.equal(
    dtsContent.includes('_test_only_mdnsHostFallbackToLoopback'),
    false,
    'built .d.mts must not expose _test_only_mdnsHostFallbackToLoopback'
  )
  assert.equal(
    dtsContent.includes('__config?:'),
    false,
    'built .d.mts must hide phantom config behind a unique symbol'
  )
})

void test('Plugin API safety: rejects non-built-in plugin objects and duplicate built-in plugins synchronously', () => {
  const {makeJoinRoom, rtcPolyfill} = createMemorySignalBus()
  const joinRoom = makeJoinRoom()

  assert.throws(
    () =>
      joinRoom(
        {
          appId: 'invalid-plugin-test',
          use: [{name: 'custom', setup: () => ({})} as never],
          rtcPolyfill
        },
        'room-invalid-1'
      ),
    /invalid plugin in use\[\]; expected roles\(\) or scale\(\)/
  )

  assert.throws(
    () =>
      joinRoom(
        {
          appId: 'dup-plugin-test',
          use: [roles(), roles()],
          rtcPolyfill
        },
        'room-dup-1'
      ),
    /duplicate plugin "roles"/
  )

  assert.throws(
    () =>
      joinRoom(
        {
          appId: 'dup-scale-test',
          use: [scale(), scale()],
          rtcPolyfill
        },
        'room-dup-2'
      ),
    /duplicate plugin "scale"/
  )
})

void test('makeState widens primitive literals, isPassive is removed, and core exports/types are pruned', async () => {
  const {makeJoinRoom, rtcPolyfill} = createMemorySignalBus()
  const joinRoom = makeJoinRoom()

  const room = joinRoom(
    {
      appId: 'state-widening-app',
      identity: 'none',
      use: [roles({selfAsAdmin: true})],
      rtcPolyfill
    },
    'state-widening-room'
  )

  assert.equal(
    'isPassive' in room,
    false,
    'isPassive() method must be removed from Room'
  )
  assert.equal(
    typeof room.makeState,
    'function',
    'makeState is synchronously available on Room before room.ready'
  )
  assert.equal(
    typeof room.makeUserState,
    'function',
    'makeUserState is synchronously available on Room before room.ready'
  )
  assert.equal(
    typeof room.grantRole,
    'function',
    'built-in roles plugin stubs attach synchronously before room.ready'
  )
  assert.equal(
    typeof room.unban,
    'function',
    'built-in roles unban stub attaches synchronously before room.ready'
  )

  await room.ready
  assert.equal(typeof room.grantRole, 'function')

  const counter = room.makeState('counter', 0)
  await counter.set(1)
  await counter.set(n => n + 1)
  if (false as boolean) {
    // @ts-expect-error widened number state must reject string
    void counter.set('not-a-number').catch(() => {})
  }
  assert.equal(counter.get(), 2)

  const label = room.makeState('label', 'initial')
  await label.set('updated')
  assert.equal(label.get(), 'updated')

  const flag = room.makeState('flag', false)
  await flag.set(true)
  assert.equal(flag.get(), true)

  const nested = room.makeState('nested', {
    count: 0,
    tags: ['a'],
    active: false
  })
  await nested.set({count: 2, tags: ['a', 'b'], active: true})
  assert.deepEqual(nested.get(), {count: 2, tags: ['a', 'b'], active: true})

  await room.leave()

  const coreExports = corePublicExports
  for (const pruned of [
    'hashWith',
    'sha1',
    'all',
    'entries',
    'getConfiguredPlugins',
    'keys',
    'pauseRelayReconnection',
    'resumeRelayReconnection',
    'socketGetter',
    'strToNum',
    'toHex',
    'values',
    'definePlugin',
    'decodeBytes'
  ]) {
    assert.equal(
      pruned in coreExports,
      false,
      `"${pruned}" must not be exported from @trystero-p2p/core`
    )
  }
  assert.equal(coreExports.libName, 'Trystero')

  for (const kept of [
    'createStrategy',
    'createTopicStrategy',
    'createRelayManager',
    'makeSocket',
    'getRelays',
    'hashTopic',
    'toJson',
    'fromJson',
    'encodeBytes',
    'genId',
    'roles',
    'scale',
    'clearUserIdentity',
    'createUserIdentity',
    'exportUserIdentity',
    'importUserIdentity',
    'setRelayConnectivity'
  ]) {
    assert.equal(
      typeof (coreExports as Record<string, unknown>)[kept],
      'function',
      `"${kept}" must remain exported from @trystero-p2p/core`
    )
  }

  const distCoreUrl = new URL(
    '../../packages/core/dist/index.mjs',
    import.meta.url
  ).href
  const distCore = (await import(distCoreUrl)) as Record<string, unknown>
  assert.equal(typeof distCore['clearUserIdentity'], 'function')
  assert.equal('createAdminRoom' in distCore, false)
  for (const pkg of [
    'trystero',
    'nostr',
    'mqtt',
    'torrent',
    'firebase',
    'supabase',
    'ws-relay'
  ]) {
    const pkgUrl = new URL(
      `../../packages/${pkg}/dist/index.mjs`,
      import.meta.url
    ).href
    const mod = (await import(pkgUrl)) as Record<string, unknown>
    assert.equal(
      mod['clearUserIdentity'],
      distCore['clearUserIdentity'],
      `packages/${pkg} must re-export clearUserIdentity`
    )
    assert.equal(
      'createAdminRoom' in mod,
      false,
      `packages/${pkg} must not export createAdminRoom`
    )
    assert.equal(
      'createEvent' in mod,
      false,
      `packages/${pkg} must not leak Nostr createEvent`
    )
    assert.equal(
      'subscribe' in mod,
      false,
      `packages/${pkg} must not leak dead subscribe helper`
    )
  }

  // Importing trystero / @trystero-p2p/nostr must not invoke CSPRNG / keygen at import time
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
        import assert from 'node:assert/strict'
        import {resolve} from 'node:path'

        let rngCalls = 0
        const origGetRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto)
        globalThis.crypto.getRandomValues = array => {
          rngCalls += 1
          return origGetRandomValues(array)
        }

        await import(resolve('packages/nostr/dist/index.mjs'))
        await import(resolve('packages/trystero/dist/index.mjs'))
        assert.equal(rngCalls, 0, 'importing nostr/trystero must not run CSPRNG keygen')
      `
    ],
    {stdio: 'pipe'}
  )

  const coreTypesDts = readFileSync(
    resolve(process.cwd(), 'packages/core/dist/types.d.mts'),
    'utf8'
  )

  const collectDtsExportedNames = (dts: string, out = new Set<string>()) => {
    if (
      /^export\s+(?:type\s+)?\*\s+from\s+['"]@trystero-p2p\/core\/types['"]/m.test(
        dts
      )
    ) {
      collectDtsExportedNames(coreTypesDts, out)
    }
    for (const m of dts.matchAll(
      /^export (?:type|interface|declare const) (\w+)\b/gm
    )) {
      if (m[1]) {
        out.add(m[1])
      }
    }
    for (const m of dts.matchAll(/^export (?:type )?\{([^}]+)\}/gm)) {
      for (const part of (m[1] ?? '').split(',')) {
        const cleaned = part
          .trim()
          .replace(/^type\s+/, '')
          .split(/\s+as\s+/)
          .at(-1)
          ?.trim()
        if (cleaned) {
          out.add(cleaned)
        }
      }
    }
    return out
  }

  for (const strategyPkg of [
    'nostr',
    'mqtt',
    'torrent',
    'firebase',
    'supabase',
    'ws-relay'
  ]) {
    const strategyDts = readFileSync(
      resolve(process.cwd(), `packages/${strategyPkg}/dist/index.d.mts`),
      'utf8'
    )
    assert.equal(
      /^export\s+(?:type\s+)?\*\s+from\s+['"]@trystero-p2p\/core['"]/m.test(
        strategyDts
      ),
      false,
      `packages/${strategyPkg}/dist/index.d.mts must not wildcard re-export @trystero-p2p/core root`
    )
    const exportedNames = collectDtsExportedNames(strategyDts)

    for (const leaked of [
      'ActionOptions',
      'AuthoritativeState',
      'AuthoritativeStateRecord',
      'BaseRelayConfig',
      'BaseRoomConfig',
      'InferPluginApi',
      'InternalAction',
      'JoinError',
      'JoinErrorHandler',
      'JoinRoom',
      'JoinRoomCallbacks',
      'JsonPrimitive',
      'KernelRolesProvider',
      'KernelRoomErrorInput',
      'KernelScaleProvider',
      'MaybePromise',
      'OfferRecord',
      'PeerBanRecord',
      'PeerHandle',
      'PeerHandlers',
      'PluginContext',
      'PublicRolesProvider',
      'PublicScaleProvider',
      'ResolvedIdentityPersistence',
      'RoleRevocationRecord',
      'RoomKernel',
      'Signal',
      'SignalPeer',
      'SocketClient',
      'StrategyAdapter',
      'StrategyContext',
      'StrategyMessage',
      'StrategyOnMessage',
      'TargetPeers',
      'TopicPublishContext',
      'TopicStrategyAdapter',
      'TopicSubscriptionContext',
      'TopologyMode',
      'UserIdentityPersistence',
      'WsRelayClientMessage',
      'WsRelayServerMessage',
      'createEvent',
      'definePlugin',
      'subscribe'
    ]) {
      assert.equal(
        exportedNames.has(leaked),
        false,
        `${leaked} must not be exported from packages/${strategyPkg}/dist/index.d.mts`
      )
    }
    for (const kept of [
      'ActionError',
      'BanOptions',
      'RoleChangeContext',
      'RoleChangeHandler',
      'Room',
      'RoomError',
      'RoomErrorCode',
      'RoomErrorHandler',
      'RoomWithPlugins',
      'RoomPlugin',
      'ListenerOptions',
      'ReplayListenerOptions',
      'Unsubscribe',
      'MessageAction',
      'RequestAction',
      'SendOptions',
      'SharedState',
      'UserState',
      'UserStateConfig',
      'UserStateChangeContext',
      'UserIdentity',
      'SelfInfo',
      'PeerInfo',
      'UserInfo'
    ]) {
      assert.equal(
        exportedNames.has(kept),
        true,
        `${kept} must remain exported from packages/${strategyPkg}/dist/index.d.mts`
      )
    }
  }

  const indexDts = readFileSync(
    resolve(process.cwd(), 'packages/core/dist/index.d.mts'),
    'utf8'
  )
  const typesDts = readFileSync(
    resolve(process.cwd(), 'packages/core/dist/types.d.mts'),
    'utf8'
  )
  for (const removedType of [
    'AuthorityConfig',
    'TopologyConfig',
    'RolesInput',
    'RoomAuthorityInfo',
    'AdminRoomInfo',
    'createAdminRoom',
    'manualReconnection',
    'UserStateRetentionConfig',
    'UserStateGetAllOptions'
  ]) {
    assert.equal(
      indexDts.includes(removedType),
      false,
      `${removedType} must not appear in packages/core/dist/index.d.mts`
    )
    assert.equal(
      typesDts.includes(removedType),
      false,
      `${removedType} must not appear in packages/core/dist/types.d.mts`
    )
  }
  assert.equal(indexDts.includes('RolesConfig'), true)
  assert.equal(indexDts.includes('ScaleConfig'), true)
  assert.equal(indexDts.includes('RelayConnectivity'), true)
  assert.equal(indexDts.includes('setRelayConnectivity'), true)
})
