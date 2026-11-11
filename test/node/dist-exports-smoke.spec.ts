import assert from 'node:assert/strict'
import {existsSync, readdirSync, readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import test from './test.ts'
import {createMemoryRtcRealm} from './memory-rtc.ts'
import {waitFor} from './peer-harness.ts'

const importDist = <T>(relPath: string): Promise<T> =>
  import(new URL(relPath, import.meta.url).href) as Promise<T>

const expectedStrategyReExports = [
  'clearUserIdentity',
  'createUserIdentity',
  'exportUserIdentity',
  'importUserIdentity',
  'roles',
  'scale'
]

const expectedCoreExports: Record<string, 'function' | 'string' | 'symbol'> = {
  clearUserIdentity: 'function',
  createRelayManager: 'function',
  createRelayScopedStore: 'function',
  createStrategy: 'function',
  createTopicStrategy: 'function',
  createUserIdentity: 'function',
  encodeBytes: 'function',
  exportUserIdentity: 'function',
  fromJson: 'function',
  genId: 'function',
  getRelays: 'function',
  hashTopic: 'function',
  importUserIdentity: 'function',
  libName: 'string',
  makeSocket: 'function',
  mkErr: 'function',
  roles: 'function',
  scale: 'function',
  setRelayConnectivity: 'function',
  socketInitialFailureSymbol: 'symbol',
  toJson: 'function',
  unrefTimer: 'function'
}

const removedCoreExports = ['decodeBytes', 'definePlugin', 'hash32']

void test('Built dist/*.mjs entrypoints expose exact public contracts and strip DEV-only hooks', async () => {
  const coreDistDir = resolve(import.meta.dirname, '../../packages/core/dist')
  assert.equal(
    existsSync(resolve(coreDistDir, 'public.mjs')),
    false,
    '@trystero-p2p/core/public (dist/public.mjs) must not exist'
  )
  assert.equal(
    existsSync(resolve(coreDistDir, 'types.mjs')),
    false,
    '@trystero-p2p/core/types must be types-only (no dist/types.mjs runtime bundle)'
  )
  assert.equal(
    existsSync(resolve(coreDistDir, 'types.d.mts')),
    true,
    '@trystero-p2p/core/types declaration file dist/types.d.mts must exist'
  )

  const [
    coreDist,
    firebaseDist,
    mqttDist,
    nostrDist,
    supabaseDist,
    torrentDist,
    wsRelayDist,
    wsRelayServerDist,
    trysteroDist
  ] = await Promise.all([
    importDist<typeof import('@trystero-p2p/core')>(
      '../../packages/core/dist/index.mjs'
    ),
    importDist<typeof import('@trystero-p2p/firebase')>(
      '../../packages/firebase/dist/index.mjs'
    ),
    importDist<typeof import('@trystero-p2p/mqtt')>(
      '../../packages/mqtt/dist/index.mjs'
    ),
    importDist<typeof import('@trystero-p2p/nostr')>(
      '../../packages/nostr/dist/index.mjs'
    ),
    importDist<typeof import('@trystero-p2p/supabase')>(
      '../../packages/supabase/dist/index.mjs'
    ),
    importDist<typeof import('@trystero-p2p/torrent')>(
      '../../packages/torrent/dist/index.mjs'
    ),
    importDist<typeof import('@trystero-p2p/ws-relay')>(
      '../../packages/ws-relay/dist/index.mjs'
    ),
    importDist<typeof import('@trystero-p2p/ws-relay/server')>(
      '../../packages/ws-relay/dist/server.mjs'
    ),
    importDist<typeof import('trystero')>(
      '../../packages/trystero/dist/index.mjs'
    )
  ])

  const coreRecord = coreDist as Record<string, unknown>
  assert.deepEqual(
    Object.keys(coreRecord).sort((a, b) => a.localeCompare(b)),
    Object.keys(expectedCoreExports).sort((a, b) => a.localeCompare(b))
  )

  for (const [exportName, expectedType] of Object.entries(
    expectedCoreExports
  )) {
    assert.equal(
      typeof coreRecord[exportName],
      expectedType,
      `expected @trystero-p2p/core dist to export ${exportName} (${expectedType})`
    )
  }

  for (const removed of removedCoreExports) {
    assert.equal(
      removed in coreRecord,
      false,
      `@trystero-p2p/core must not export removed symbol ${removed}`
    )
  }

  for (const [pkgName, mod] of [
    ['@trystero-p2p/firebase', firebaseDist],
    ['@trystero-p2p/mqtt', mqttDist],
    ['@trystero-p2p/nostr', nostrDist],
    ['@trystero-p2p/supabase', supabaseDist],
    ['@trystero-p2p/torrent', torrentDist],
    ['@trystero-p2p/ws-relay', wsRelayDist],
    ['trystero', trysteroDist]
  ] as const) {
    const record = mod as Record<string, unknown>
    assert.equal(typeof record['joinRoom'], 'function', `${pkgName}.joinRoom`)
    for (const sym of expectedStrategyReExports) {
      assert.equal(
        typeof record[sym],
        'function',
        `${pkgName} must re-export ${sym} from @trystero-p2p/core`
      )
    }
    for (const removed of removedCoreExports) {
      assert.equal(
        removed in record,
        false,
        `${pkgName} must not expose removed symbol ${removed}`
      )
    }
    assert.equal(
      'createStrategy' in record,
      false,
      `${pkgName} must not leak internal strategy factory`
    )
    assert.equal(
      'selfId' in record,
      false,
      `${pkgName} must not expose legacy top-level selfId`
    )
  }

  assert.equal(Array.isArray(nostrDist.defaultRelayUrls), true)
  assert.equal(Array.isArray(trysteroDist.defaultRelayUrls), true)
  assert.equal(typeof wsRelayServerDist.createWsRelayServer, 'function')

  // Verify production core dist files contain zero DEV labels or test backdoors
  const mjsFiles = readdirSync(coreDistDir).filter(name =>
    name.endsWith('.mjs')
  )
  assert.ok(mjsFiles.length > 0, 'expected built .mjs files in core/dist')
  for (const file of mjsFiles) {
    const src = readFileSync(resolve(coreDistDir, file), 'utf8')
    assert.equal(
      src.includes('setDevIdentityProvider'),
      false,
      `${file} must not contain setDevIdentityProvider`
    )
    assert.equal(
      src.includes('_test_only_'),
      false,
      `${file} must not contain _test_only_ hooks`
    )
  }
})

void test('Built dist/*.mjs executes end-to-end room join, actions, shared/user state, roles, and scale', async () => {
  const coreDist = await importDist<typeof import('@trystero-p2p/core')>(
    '../../packages/core/dist/index.mjs'
  )
  const realm = createMemoryRtcRealm()
  type DistStrategyMessage = Parameters<
    Parameters<typeof coreDist.createTopicStrategy>[0]['subscribeTopic']
  >[2] extends (topic: string, msg: infer M) => unknown
    ? M
    : never
  const topicListeners = new Map<
    string,
    Set<(topic: string, packet: DistStrategyMessage) => void>
  >()

  const makeDistJoinRoom = () =>
    coreDist.createTopicStrategy({
      steadyAnnounceIntervalMs: 120,
      init: () => ({}),
      subscribeTopic: (_relay, topic, onMessage) => {
        let subs = topicListeners.get(topic)
        if (!subs) {
          subs = new Set()
          topicListeners.set(topic, subs)
        }
        const handler = (t: string, pkt: DistStrategyMessage) => {
          void onMessage(t, pkt)
        }
        subs.add(handler)
        return () => {
          subs.delete(handler)
          if (subs.size === 0) {
            topicListeners.delete(topic)
          }
        }
      },
      publishTopic: (_relay, topic, packet) => {
        const subs = topicListeners.get(topic)
        if (!subs) {
          return
        }
        for (const listener of Array.from(subs)) {
          setTimeout(() => {
            if (topicListeners.get(topic)?.has(listener)) {
              listener(topic, packet)
            }
          }, 1)
        }
      }
    })

  const [hostUser, guestUser] = await Promise.all([
    coreDist.createUserIdentity(),
    coreDist.createUserIdentity()
  ])

  let hostRoom: {leave: () => Promise<void>} | null = null
  let guestRoom: {leave: () => Promise<void>} | null = null

  try {
    const roomA = makeDistJoinRoom()(
      {
        appId: 'dist-smoke-app',
        identity: hostUser,
        rtcPolyfill: realm.rtcPolyfill,
        use: [coreDist.roles({selfAsAdmin: true}), coreDist.scale()]
      },
      'smoke-room'
    )
    hostRoom = roomA
    const selfA = await roomA.getSelf()
    assert.equal(selfA.roomId, `smoke-room~${hostUser.userId}`)
    assert.equal(selfA.isAdmin, true)
    await coreDist.clearUserIdentity('dist-smoke-app')

    const roomB = makeDistJoinRoom()(
      {
        appId: 'dist-smoke-app',
        identity: guestUser,
        rtcPolyfill: realm.rtcPolyfill,
        use: [coreDist.roles(), coreDist.scale()]
      },
      selfA.roomId
    )
    guestRoom = roomB
    const selfB = await roomB.getSelf()

    const hostChat = roomA.makeAction<string>('chat')
    const guestChat = roomB.makeAction<string>('chat')
    const receivedChats: string[] = []
    guestChat.onMessage(data => {
      receivedChats.push(data)
    })

    const hostRpc = roomA.makeAction<number, number>('double', {
      kind: 'request'
    })
    const guestRpc = roomB.makeAction<number, number>('double', {
      kind: 'request'
    })
    guestRpc.onRequest(n => n * 2)

    const hostCounter = roomA.makeState('counter', 0)
    const guestCounter = roomB.makeState('counter', 0)
    const hostNick = roomA.makeUserState('nick', '')
    const guestNick = roomB.makeUserState('nick', '')

    await Promise.all([roomA.ready, roomB.ready])
    await waitFor(
      () =>
        Boolean(roomA.getUsers()[guestUser.userId]) &&
        Boolean(roomB.getUsers()[hostUser.userId])
    )

    await hostChat.send('hello-from-dist')
    await waitFor(() => receivedChats[0] === 'hello-from-dist')

    const guestPeerId = Object.keys(roomA.getPeers())[0]!
    const rpcReply = await hostRpc.request(21, {target: guestPeerId})
    assert.equal(rpcReply, 42)

    await hostCounter.set(99)
    await guestNick.set('GuestInDist')
    await roomA.grantRole(guestUser.userId, 'moderator')

    await waitFor(
      () =>
        guestCounter.get() === 99 &&
        hostNick.get(guestUser.userId) === 'GuestInDist' &&
        roomB.getRoles(guestUser.userId).includes('moderator')
    )

    const topoA = roomA.getTopology()
    assert.equal(topoA.peerId, selfA.peerId)
    assert.deepEqual(topoA.roomPeerIds, [selfB.peerId])
    assert.equal('selfId' in topoA, false)
    assert.equal('activeMode' in topoA, false)
  } finally {
    await Promise.all([hostRoom?.leave(), guestRoom?.leave()])
    realm.clear()
  }
})
