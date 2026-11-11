import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {
  createTopicStrategy,
  roles,
  scale,
  type Room
} from '../../packages/core/src/index.ts'
import {MockRTCPeerConnection} from './peer-harness.ts'
import test from './test.ts'

interface PlayerMove {
  readonly path: readonly (readonly [number, number])[]
  playerId: string
  note?: string | undefined
}

type MatchPhase = 'lobby' | 'playing' | 'ended'

type GameEvent =
  | {readonly kind: 'spawn'; readonly x: number; readonly y: number}
  | {readonly kind: 'gameover'; readonly winner: string}

const makeLocalRoom = (): Room => {
  const join = createTopicStrategy({
    init: () => ({}),
    subscribeTopic: () => () => {},
    publishTopic: () => {}
  })
  return join(
    {
      appId: 'types-ergonomics-app',
      rtcPolyfill: MockRTCPeerConnection as unknown as typeof RTCPeerConnection
    },
    'types-room'
  )
}

void test('TypeScript ergonomics: Widen<T> preserves literal & discriminated unions while widening single literals; interfaces and readonly arrays work without casts', async () => {
  const room = makeLocalRoom()
  try {
    // 1. Single primitive literals widen ergonomically
    const count = room.makeState('count', 0)
    await count.set(42)
    assert.equal(count.get(), 42)

    // 2. Explicit literal unions are preserved (NOT widened to string)
    const phase = room.makeState<MatchPhase>('phase', 'lobby')
    await phase.set('playing')
    const currentPhase: MatchPhase = phase.get()
    assert.equal(currentPhase, 'playing')

    if (false as boolean) {
      // @ts-expect-error literal union state must reject arbitrary strings
      void phase.set('paused')
    }

    // 3. Discriminated unions are preserved with full narrowing
    const gameEvt = room.makeState<GameEvent>('evt', {
      kind: 'spawn',
      x: 1,
      y: 2
    })
    await gameEvt.set({kind: 'gameover', winner: 'alice'})
    const latestEvt = gameEvt.get()
    assert.equal(latestEvt.kind, 'gameover')
    if (latestEvt.kind === 'gameover') {
      const winner: string = latestEvt.winner
      assert.equal(winner, 'alice')
    }

    if (false as boolean) {
      // @ts-expect-error discriminated union must reject invalid variant
      void gameEvt.set({kind: 'teleport', x: 9})
    }

    // 4. TypeScript interface (no index signature), readonly tuples/arrays, and optional properties
    const moveAction = room.makeAction<PlayerMove>('move')
    const moveReq = room.makeAction<PlayerMove, PlayerMove>('moveReq', {
      kind: 'request'
    })
    const lastMove = room.makeState<PlayerMove>('lastMove', {
      path: [[0, 0]],
      playerId: 'p0'
    })
    const cursor = room.makeUserState<PlayerMove>('cursor', {
      path: [],
      playerId: 'p0'
    })

    const sampleMove: PlayerMove = {
      path: [
        [1, 2],
        [3, 4]
      ],
      playerId: 'alice',
      note: undefined
    }
    await lastMove.set(sampleMove)
    await cursor.set({path: [[5, 6]], playerId: 'alice', note: 'hello'})
    assert.deepEqual(lastMove.get(), {
      path: [
        [1, 2],
        [3, 4]
      ],
      playerId: 'alice'
    })
    void moveAction
    void moveReq

    // 5. Non-JSON types remain rejected at compile time
    if (false as boolean) {
      // @ts-expect-error functions are not valid action payloads
      room.makeAction<() => void>('badFn')
      // @ts-expect-error Map is not valid JSON state
      room.makeState('badMap', new Map<string, number>())
      // @ts-expect-error Set is not valid JSON user state
      room.makeUserState('badSet', new Set<string>())
      // @ts-expect-error Date is not valid JSON state
      room.makeState('badDate', new Date())
    }

    // 6. Plugin typing composes roles() + scale() cleanly
    if (false as boolean) {
      const joinWithPlugins = createTopicStrategy({
        init: () => ({}),
        subscribeTopic: () => () => {},
        publishTopic: () => {}
      })
      const fullRoom = joinWithPlugins(
        {
          appId: 'plugin-type-app',
          use: [roles({selfAsAdmin: true}), scale({maxDirectPeers: 6})]
        },
        'r1'
      )
      fullRoom.onRoleChange(
        ({userId, roles: nextRoles, previousRoles, local}) => {
          void (userId satisfies string)
          void (nextRoles satisfies readonly string[])
          void (previousRoles satisfies readonly string[])
          void (local satisfies boolean)
        }
      )
      void fullRoom.getTopology()
    }
  } finally {
    await room.leave()
  }
})

const collectExportedNames = (
  rootDir: string,
  dtsPath: string,
  out = new Set<string>()
): Set<string> => {
  const dts = readFileSync(dtsPath, 'utf8')
  if (
    /^export\s+(?:type\s+)?\*\s+from\s+['"]@trystero-p2p\/core\/types['"]/m.test(
      dts
    )
  ) {
    collectExportedNames(
      rootDir,
      resolve(rootDir, 'packages/core/dist/types.d.mts'),
      out
    )
  }
  const starPkgMatch = dts.match(
    /^export\s+\*\s+from\s+['"]@trystero-p2p\/([\w-]+)['"]/m
  )
  if (starPkgMatch?.[1]) {
    collectExportedNames(
      rootDir,
      resolve(rootDir, `packages/${starPkgMatch[1]}/dist/index.d.mts`),
      out
    )
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

void test('Packaging parity: every strategy .d.mts and runtime .mjs re-exports all shared public symbols and ws-relay/server leaks zero ws types', async () => {
  const rootDir = resolve(import.meta.dirname, '../..')
  const coreTypesDts = resolve(rootDir, 'packages/core/dist/types.d.mts')
  const coreSharedTypeExports = collectExportedNames(rootDir, coreTypesDts)
  assert.ok(
    coreSharedTypeExports.size >= 40,
    `expected >= 40 shared public types in core/dist/types.d.mts, got ${coreSharedTypeExports.size}`
  )
  assert.ok(coreSharedTypeExports.has('RoleChangeContext'))
  assert.ok(coreSharedTypeExports.has('Room'))
  assert.ok(coreSharedTypeExports.has('SharedState'))
  assert.ok(coreSharedTypeExports.has('UserState'))

  const strategyPackages = [
    'firebase',
    'mqtt',
    'nostr',
    'supabase',
    'torrent',
    'ws-relay',
    'trystero'
  ]

  const requiredRuntimeHelpers = [
    'joinRoom',
    'roles',
    'scale',
    'createUserIdentity',
    'exportUserIdentity',
    'importUserIdentity',
    'clearUserIdentity'
  ]

  for (const pkg of strategyPackages) {
    const dtsRel = `packages/${pkg}/dist/index.d.mts`
    const mjsRel = `packages/${pkg}/dist/index.mjs`
    const exported = collectExportedNames(rootDir, resolve(rootDir, dtsRel))
    for (const sharedSym of coreSharedTypeExports) {
      assert.ok(
        exported.has(sharedSym),
        `${dtsRel} is missing re-exported public symbol "${sharedSym}" from @trystero-p2p/core/types`
      )
    }
    const runtimeMod = (await import(
      pathToFileURL(resolve(rootDir, mjsRel)).href
    )) as Record<string, unknown>
    for (const helper of requiredRuntimeHelpers) {
      assert.ok(
        exported.has(helper),
        `${dtsRel} is missing runtime helper "${helper}"`
      )
      assert.equal(
        typeof runtimeMod[helper],
        'function',
        `${mjsRel} is missing runtime function export "${helper}"`
      )
    }
  }

  // Verify @trystero-p2p/ws-relay/server has zero 'ws' type dependency in server.d.mts
  // and declares 'ws' as an optional peerDependency rather than hard dependency.
  const wsServerDts = readFileSync(
    resolve(rootDir, 'packages/ws-relay/dist/server.d.mts'),
    'utf8'
  )
  assert.equal(
    /from\s+['"]ws['"]|import\(['"]ws['"]\)/.test(wsServerDts),
    false,
    'packages/ws-relay/dist/server.d.mts must not reference external "ws" types'
  )

  const wsPkgJson = JSON.parse(
    readFileSync(resolve(rootDir, 'packages/ws-relay/package.json'), 'utf8')
  ) as {
    dependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    peerDependenciesMeta?: Record<string, {optional?: boolean}>
  }
  assert.equal(
    Boolean(wsPkgJson.dependencies && 'ws' in wsPkgJson.dependencies),
    false,
    '@trystero-p2p/ws-relay must not list "ws" in hard dependencies'
  )
  assert.equal(
    typeof wsPkgJson.peerDependencies?.['ws'],
    'string',
    '@trystero-p2p/ws-relay must declare "ws" in peerDependencies'
  )
  assert.equal(
    wsPkgJson.peerDependenciesMeta?.['ws']?.optional,
    true,
    '@trystero-p2p/ws-relay must mark "ws" peerDependency as optional'
  )
})
