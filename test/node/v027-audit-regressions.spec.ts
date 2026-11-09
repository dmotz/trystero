import assert from 'node:assert/strict'
import test from './test.ts'
import {createAntiEntropySync} from '../../packages/core/src/anti-entropy.ts'
import {createRoomAuthority, roles} from '../../packages/core/src/authority.ts'
import {
  compactPubToJwk,
  createEndpointIdentity,
  createUserIdentity,
  derivePeerId,
  deriveUserId,
  jwkToCompactPub,
  toCompactPub,
  verifyPeerIdKey,
  verifyUserIdKey
} from '../../packages/core/src/identity.ts'
import type {
  PeerHandle,
  SocketClient
} from '../../packages/core/src/internal-types.ts'
import {
  createRelayManager,
  makeSocket,
  releaseRelayLease
} from '../../packages/core/src/relay-manager.ts'
import createRoom from '../../packages/core/src/room.ts'
import {isValidSignalPeerId} from '../../packages/core/src/signal-handler.ts'
import {
  canonicalizeAndMeasureJson,
  compareHlc,
  createMonotonicClock,
  isValidHlc,
  signRoleCertInternal,
  stateMaxFutureSkewMs
} from '../../packages/core/src/signed-record.ts'
import {
  createStateManager,
  signStateRecord
} from '../../packages/core/src/state.ts'
import {
  canonicalUnicastHeader,
  createOverlayManager,
  encryptUnicastPayload,
  overlayUnicastKind,
  packOverlayBinary,
  packOverlayControl,
  scale,
  signOverlayPayload,
  signPeerDescriptor
} from '../../packages/core/src/scale/index.ts'
import createTopicStrategy from '../../packages/core/src/topic-strategy.ts'
import type {MessageAction} from '../../packages/core/src/types.ts'
import {
  encodeBytes,
  formatSelfCertifyingRoomId,
  fromBase64Url,
  mkViolationErr,
  toBase64Url
} from '../../packages/core/src/utils.ts'
import {createWsRelayServer} from '../../packages/ws-relay/src/server.ts'
import {createTestScaleCluster} from './overlay-harness.ts'
import {
  MockRTCPeerConnection,
  connectVerifiedPeers,
  createLinkedHandlePair,
  getTestEndpointByPeerId,
  testPeerId,
  wait,
  waitFor
} from './peer-harness.ts'

void test('Crypto & wire primitives: domain-separated userId vs peerId, compact 87-char P-256 wire keys, tuple HLC burst, and undefined-omitting JSON canonicalization', async () => {
  // 1. Domain separation: trystero:uid:v1 vs trystero:pid:v1 on identical P-256 public key
  const ep = await createEndpointIdentity()
  const derivedPid = await derivePeerId(ep.signPubJwk)
  const derivedUid = await deriveUserId(ep.signPubJwk)

  assert.equal(derivedPid, ep.peerId)
  assert.equal(derivedPid.length, 20)
  assert.equal(derivedUid.length, 22)
  assert.notEqual(derivedUid, derivedPid)
  assert.notEqual(derivedUid.slice(0, 20), derivedPid)

  assert.equal(await verifyPeerIdKey(derivedPid, ep.signPubJwk), true)
  assert.equal(await verifyPeerIdKey(derivedUid, ep.signPubJwk), false)
  assert.equal(await verifyUserIdKey(derivedUid, ep.signPubJwk), true)
  assert.equal(await verifyUserIdKey(derivedPid, ep.signPubJwk), false)

  // 2. Compact 87-char `${x}.${y}` wire P-256 keys & curve validation
  const compact = jwkToCompactPub(ep.signPubJwk)
  assert.equal(compact.length, 87)
  assert.equal(compact[43], '.')
  assert.equal(toCompactPub(compact), compact)

  const roundtripJwk = compactPubToJwk(compact)
  assert.ok(roundtripJwk)
  assert.deepEqual(Object.keys(roundtripJwk).sort(), ['crv', 'kty', 'x', 'y'])
  assert.equal(roundtripJwk.x, ep.signPubJwk.x)
  assert.equal(roundtripJwk.y, ep.signPubJwk.y)

  // Off-curve point (x=0, y=0) fails WebCrypto import/verify; malformed strings return null
  assert.equal(
    await verifyPeerIdKey(derivedPid, `${'A'.repeat(43)}.${'A'.repeat(43)}`),
    false,
    'all-zero coordinates are not on P-256 curve'
  )
  assert.equal(compactPubToJwk('not-a-valid-compact-key'), null)

  // 3. Tuple HLC [wallMs, counter]: >1,500 burst in a single frozen ms never overflows into future wallMs
  assert.equal(stateMaxFutureSkewMs, 10_000)
  const realNow = Date.now
  const frozenMs = 1_750_000_000_000
  Date.now = () => frozenMs
  try {
    const clock = createMonotonicClock()
    let prev = clock.nextHlc('slot')
    assert.equal(prev[0], frozenMs)
    assert.equal(prev[1], 0)
    for (let i = 1; i <= 1_500; i++) {
      const cur = clock.nextHlc('slot')
      assert.equal(isValidHlc(cur), true)
      assert.equal(cur[0], frozenMs, 'wallMs must stay pinned at frozenMs')
      assert.equal(cur[1], i, 'logical counter must increment without drift')
      assert.equal(compareHlc(cur, prev) > 0, true)
      prev = cur
    }
  } finally {
    Date.now = realNow
  }

  // 4. canonicalizeAndMeasureJson omits undefined object keys while rejecting top-level/array undefined
  const withUndef = canonicalizeAndMeasureJson({
    b: 2,
    a: 1,
    omitted: undefined,
    nested: {keep: true, drop: undefined},
    arr: [1, null, 3]
  })
  const withoutUndef = canonicalizeAndMeasureJson({
    a: 1,
    b: 2,
    nested: {keep: true},
    arr: [1, null, 3]
  })
  assert.ok(Array.isArray(withUndef))
  assert.deepEqual(withUndef, withoutUndef)
  assert.equal(canonicalizeAndMeasureJson(undefined), 0)
  assert.equal(canonicalizeAndMeasureJson([1, undefined, 3]), 0)

  // 5. toBase64Url / fromBase64Url parity between native Uint8Array methods and module-load fallback
  const proto = Uint8Array.prototype as any
  const ctor = Uint8Array as any
  const origToBase64 = Object.getOwnPropertyDescriptor(proto, 'toBase64')
  const origFromBase64 = Object.getOwnPropertyDescriptor(ctor, 'fromBase64')
  let fallbackMod: {
    toBase64Url: (bytes: Uint8Array) => string
    fromBase64Url: (b64url: string) => Uint8Array
  }
  try {
    delete proto.toBase64
    delete ctor.fromBase64
    fallbackMod = (await import(
      new URL(
        '../../packages/core/src/primitives.ts?fallback=1',
        import.meta.url
      ).href
    )) as typeof fallbackMod
  } finally {
    if (origToBase64) {
      Object.defineProperty(proto, 'toBase64', origToBase64)
    }
    if (origFromBase64) {
      Object.defineProperty(ctor, 'fromBase64', origFromBase64)
    }
  }

  const backing = new Uint8Array([0xaa, 0xfb, 0xff, 0xfe, 0xbb])
  const vectors = [
    new Uint8Array(0),
    new Uint8Array([0x00]),
    new Uint8Array([0xff]),
    new Uint8Array([0xfb, 0xff]),
    backing.subarray(1, 4),
    crypto.getRandomValues(new Uint8Array(32)),
    crypto.getRandomValues(new Uint8Array(65))
  ]
  for (const vec of vectors) {
    const nativeEnc = toBase64Url(vec)
    const fallbackEnc = fallbackMod.toBase64Url(vec)
    assert.equal(nativeEnc, fallbackEnc)
    assert.equal(nativeEnc.includes('+'), false)
    assert.equal(nativeEnc.includes('/'), false)
    assert.equal(nativeEnc.includes('='), false)
    assert.deepEqual(fromBase64Url(nativeEnc), new Uint8Array(vec))
    assert.deepEqual(
      fallbackMod.fromBase64Url(fallbackEnc),
      new Uint8Array(vec)
    )
  }
  assert.equal(toBase64Url(backing.subarray(1, 4)), '-__-')
  assert.throws(() => fromBase64Url('A'))
  assert.throws(() => fallbackMod.fromBase64Url('A'))
})

void test('Signaling & relay hardening: peerId prototype-pollution guard, malformed WS resilience, duplicate joinRoom throw, and ws-relay/server rate-limit RangeError', async () => {
  // 1. Strict 20-char Base62 peerId validation
  for (const badId of [
    '__proto__',
    'constructor',
    'prototype',
    'toString',
    'short',
    '0123456789abcdefghij!',
    '0123456789abcdefghijk'
  ]) {
    assert.equal(isValidSignalPeerId(badId), false, `must reject ${badId}`)
  }
  assert.equal(isValidSignalPeerId('0123456789AbCdEfGhIj'), true)

  // 2. Duplicate active joinRoom(appId, roomId) throws; re-joining after leave() succeeds
  const topicHandlers = new Map<
    string,
    Set<(topic: string, msg: string) => void>
  >()
  const joinTopicRoom = createTopicStrategy({
    init: () => ({}),
    subscribeTopic: (_relay, topic, onMessage) => {
      let set = topicHandlers.get(topic)
      if (!set) {
        set = new Set()
        topicHandlers.set(topic, set)
      }
      const fn = (t: string, m: string) => {
        void onMessage(t, m)
      }
      set.add(fn)
      return () => {
        set?.delete(fn)
      }
    },
    publishTopic: (_relay, topic, msg) => {
      const text = typeof msg === 'string' ? msg : JSON.stringify(msg)
      for (const fn of topicHandlers.get(topic) ?? []) {
        fn(topic, text)
      }
    }
  })

  const rtcPolyfill =
    MockRTCPeerConnection as unknown as typeof RTCPeerConnection
  const room1 = joinTopicRoom({appId: 'dup-check-app', rtcPolyfill}, 'room-1')
  try {
    assert.throws(
      () => joinTopicRoom({appId: 'dup-check-app', rtcPolyfill}, 'room-1'),
      /already joined/i
    )
    // Injecting prototype-pollution peerId into root topic must be ignored safely
    for (const [topic, handlers] of topicHandlers.entries()) {
      for (const fn of handlers) {
        fn(topic, JSON.stringify({peerId: '__proto__', polluted: true}))
      }
    }
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined)
  } finally {
    await room1.leave()
  }

  const room2 = joinTopicRoom({appId: 'dup-check-app', rtcPolyfill}, 'room-1')
  await room2.leave()

  // 3. Malformed WebSocket frames in makeSocket are caught safely & createRelayManager ref-counts active leases
  const createdSockets: FakeWebSocket[] = []
  const recordSocket = (ws: FakeWebSocket): void => {
    createdSockets.push(ws)
  }
  class FakeWebSocket {
    static readonly OPEN = 1
    readyState = 1
    url: string
    onopen: (() => void) | null = null
    onclose: (() => void) | null = null
    onmessage: ((ev: {data: unknown}) => void) | null = null
    constructor(url: string) {
      this.url = url
      recordSocket(this)
      queueMicrotask(() => this.onopen?.())
    }
    send(): void {}
    close(): void {
      this.readyState = 3
    }
  }
  const origWs = globalThis.WebSocket
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
  try {
    const relayMgr = createRelayManager<SocketClient>(
      r => r.socket,
      r => r.close?.()
    )
    const relayUrl = 'wss://fake-relay.example'
    const mkClient = () =>
      makeSocket(relayUrl, data => {
        JSON.parse(data)
      })

    const client1 = relayMgr.register(relayUrl, mkClient)
    const client2 = relayMgr.register(relayUrl, mkClient)
    assert.equal(
      client1,
      client2,
      'same relay URL shares one SocketClient while active'
    )
    assert.equal(createdSockets.length, 1)

    const lease1 = relayMgr.lease(client1, client1.ready)
    const lease2 = relayMgr.lease(client2, client2.ready)
    await Promise.all([lease1, lease2])

    const firstWs = createdSockets[0]
    assert.ok(firstWs?.onmessage)
    assert.doesNotThrow(() => {
      firstWs.onmessage?.({data: '<<<not-valid-json>>>'})
    })

    // Releasing first lease keeps socket alive (activeRooms = 1)
    releaseRelayLease(lease1)
    assert.equal(client1.isClosed, false)
    assert.ok(relayMgr.getSockets()[relayUrl])

    // Releasing final lease closes socket & evicts from manager (activeRooms = 0)
    releaseRelayLease(lease2)
    assert.equal(client1.isClosed, true)
    assert.equal(relayMgr.getSockets()[relayUrl], undefined)

    // Subsequent register after activeRooms reached 0 opens a fresh SocketClient
    const client3 = relayMgr.register(relayUrl, mkClient)
    assert.notEqual(client3, client1)
    assert.equal(createdSockets.length, 2)
    const lease3 = relayMgr.lease(client3, client3.ready)
    await lease3
    releaseRelayLease(lease3)
    assert.equal(client3.isClosed, true)
  } finally {
    globalThis.WebSocket = origWs
  }

  // 4. createWsRelayServer validates rate-limit bounds and supports Infinity
  for (const bad of [0, -5, Number.NaN]) {
    assert.throws(
      () => createWsRelayServer({noServer: true, maxMessagesPerSecond: bad}),
      RangeError
    )
    assert.throws(
      () => createWsRelayServer({noServer: true, maxBurstMessages: bad}),
      RangeError
    )
  }
  const unlimitedRelay = createWsRelayServer({
    noServer: true,
    maxMessagesPerSecond: Number.POSITIVE_INFINITY,
    maxBurstMessages: Number.POSITIVE_INFINITY
  })
  await unlimitedRelay.close()
})

void test('Shared anti-entropy pagination, RoleCertificate seq skew cutoff, 4,096 non-evictable ban cap, onRoleChange, and arguments.length === 0 guards', async () => {
  // 1. Cursor-paged anti-entropy helper pages across >256 items cleanly
  const requestedCursors: Array<string | undefined> = []
  const syncRef: {current?: ReturnType<typeof createAntiEntropySync>} = {}
  const syncEngine = createAntiEntropySync({
    fanout: 1,
    getDirectPeers: () => ['peerA'],
    isPeerSendable: () => true,
    sendPull: (peerId, cursor) => {
      requestedCursors.push(cursor)
      if (cursor === undefined) {
        syncRef.current?.onSyncPage(peerId, 'page-1')
      } else if (cursor === 'page-1') {
        syncRef.current?.onSyncPage(peerId, 'page-2')
      } else {
        syncRef.current?.onSyncPage(peerId, undefined)
      }
    }
  })
  syncRef.current = syncEngine
  try {
    syncEngine.onPeerJoined('peerA')
    await wait(10)
    assert.deepEqual(requestedCursors, [undefined, 'page-1', 'page-2'])
  } finally {
    syncEngine.destroy()
  }

  // 1b. Pull timeout enters 10s cooldown (skipping fanout) while periodic fallback still retries sole peer
  const cooldownPulls: string[] = []
  let activeCooldownPeers = ['deadPeer', 'livePeer']
  const cooldownEngine = createAntiEntropySync({
    fanout: 1,
    pullTimeoutMs: 20,
    periodicIntervalMs: 35,
    getDirectPeers: () => activeCooldownPeers,
    isPeerSendable: () => true,
    sendPull: peerId => {
      cooldownPulls.push(peerId)
    }
  })
  try {
    cooldownEngine.onPeerJoined('deadPeer', true)
    await Promise.resolve()
    assert.deepEqual(cooldownPulls, ['deadPeer'])
    // Wait for deadPeer pull to time out and enter 10s cooldown; fillFanout picks livePeer instead
    await waitFor(() => cooldownPulls.includes('livePeer'), 500)
    cooldownEngine.onSyncPage('livePeer', undefined)
    // When livePeer drops, deadPeer is cooling so onPeerDisconnected skips immediate retry,
    // then periodicIntervalMs falls back to the cooling sole peer
    activeCooldownPeers = ['deadPeer']
    const countBeforeDisconnect = cooldownPulls.length
    cooldownEngine.onPeerDisconnected('livePeer')
    await Promise.resolve()
    assert.equal(
      cooldownPulls.length,
      countBeforeDisconnect,
      'cooling peer must be skipped on immediate fanout refill'
    )
    await waitFor(() => cooldownPulls.length > countBeforeDisconnect, 500)
    assert.equal(cooldownPulls.at(-1), 'deadPeer')
  } finally {
    cooldownEngine.destroy()
  }

  // 2. RoleCertificate monotonic seq ordering beats clock-skewed cert.iat, plus 4,096 active ban cap
  const [adminUser, bobUser] = await Promise.all([
    createUserIdentity(),
    createUserIdentity()
  ])
  const certRoomId = formatSelfCertifyingRoomId(
    'mod-cap-room',
    adminUser.userId
  )
  const adminPid = testPeerId('cap-admin')
  const verifierPid = testPeerId('cap-verifier')

  const adminAuth = createRoomAuthority({
    appId: 'cap-app',
    initialRoomId: certRoomId,
    admin: {selfAsAdmin: true},
    selfId: adminPid,
    getLocalUserIdentity: async () => adminUser
  })
  const remoteAuth = createRoomAuthority({
    appId: 'cap-app',
    initialRoomId: certRoomId,
    admin: {},
    selfId: verifierPid,
    getLocalUserIdentity: async () => bobUser
  })

  await Promise.all([
    adminAuth.getAuthorityInfo(),
    remoteAuth.getAuthorityInfo()
  ])

  // Issue cert1 while admin clock is 5s AHEAD, then revoke when admin clock jumps BACK 4s:
  // monotonic authority floor keeps rev2.(ts, seq) > cert1.(iat, seq) and out-of-order delivery stays converged!
  const realNow = Date.now
  const baseNow = realNow()
  try {
    Date.now = () => baseNow + 5_000
    const cert1 = await adminAuth.issueRoleCertificate(bobUser.userId, 'mod')
    assert.equal(cert1.seq, 1)

    Date.now = () => baseNow + 1_000
    const rev2 = await adminAuth.issueRoleRevocation(bobUser.userId, 'mod')
    assert.ok(
      rev2.ts > cert1.iat,
      'monotonic floor advances past cert1.iat despite backward clock jump'
    )
    assert.equal(rev2.seq, 2)

    // Remote applies rev2 first, then receives cert1 out of order: cert1.(iat, seq) < rev2.(ts, seq), so 'mod' stays revoked!
    await remoteAuth.verifyAndApplyRevocation(rev2)
    await remoteAuth.verifyAndApplyCert(cert1)
    assert.deepEqual(remoteAuth.getPeerRoles(bobUser.userId), [])

    // Re-granting even while clock is still behind issues cert3 (ts/seq > rev2), restoring 'mod' cleanly
    const cert3 = await adminAuth.issueRoleCertificate(bobUser.userId, 'mod')
    assert.ok(cert3.iat > rev2.ts)
    assert.equal(cert3.seq, 3)
    await remoteAuth.verifyAndApplyCert(cert3)
    assert.deepEqual(remoteAuth.getPeerRoles(bobUser.userId), ['mod'])
  } finally {
    Date.now = realNow
  }

  // 3. Fill moderation table: 'unban' tombstones are evicted before active bans; 4,097th active ban throws
  const mkSyntheticUid = (n: number): string =>
    `U${String(n).padStart(21, '0')}`

  const unbanUid = mkSyntheticUid(99_999)
  await adminAuth.issuePeerModeration('ban', unbanUid)
  await adminAuth.issuePeerModeration('unban', unbanUid)
  assert.equal(adminAuth.isPeerBanned(unbanUid), false)

  for (let i = 0; i < 4_096; i++) {
    await adminAuth.issuePeerModeration('ban', mkSyntheticUid(i))
  }
  assert.equal(adminAuth.isPeerBanned(mkSyntheticUid(0)), true)
  assert.equal(adminAuth.isPeerBanned(mkSyntheticUid(4_095)), true)

  await assert.rejects(
    () => adminAuth.issuePeerModeration('ban', mkSyntheticUid(4_096)),
    /moderation capacity reached \(4096 active bans\)/
  )

  // 4. End-to-end room.onRoleChange, arguments.length === 0 guards, optimistic state.set, and frozen snapshots
  const [hostId, guestId] = [testPeerId('rc-host'), testPeerId('rc-guest')]
  const [hostIdentity, guestIdentity] = await Promise.all([
    createUserIdentity(),
    createUserIdentity()
  ])
  const liveRoomId = formatSelfCertifyingRoomId('rc-room', hostIdentity.userId)
  const regMap = new Map<string, (peer: PeerHandle, id: string) => void>()
  const hostRoom = createRoom(
    f => regMap.set(hostId, f),
    () => {},
    () => {},
    {
      endpointIdentity: getTestEndpointByPeerId(hostId),
      appId: 'rc-app',
      roomId: liveRoomId,
      identity: hostIdentity,
      use: [roles({selfAsAdmin: true})]
    }
  )
  const guestRoom = createRoom(
    f => regMap.set(guestId, f),
    () => {},
    () => {},
    {
      endpointIdentity: getTestEndpointByPeerId(guestId),
      appId: 'rc-app',
      roomId: liveRoomId,
      identity: guestIdentity,
      use: [roles()]
    }
  )

  try {
    await Promise.all([hostRoom.ready, guestRoom.ready])
    connectVerifiedPeers(
      regMap,
      hostRoom,
      hostId,
      hostIdentity,
      guestRoom,
      guestId,
      guestIdentity
    )
    await waitFor(
      () => Object.keys(hostRoom.getUsers()).includes(guestIdentity.userId),
      3_000
    )

    // Frozen & cached getUsers() / getRoles() snapshots
    const usersSnap1 = hostRoom.getUsers()
    const usersSnap2 = hostRoom.getUsers()
    assert.equal(Object.isFrozen(usersSnap1), true)
    assert.equal(usersSnap1, usersSnap2)
    assert.equal(Object.isFrozen(hostRoom.getRoles()), true)

    // arguments.length === 0 vs explicit undefined
    assert.deepEqual(hostRoom.getRoles(), ['admin'])
    assert.deepEqual(hostRoom.getRoles(undefined), [])

    const hostRoleEvents: Array<{
      userId: string
      roles: readonly string[]
      previousRoles: readonly string[]
      local: boolean
    }> = []
    const guestRoleEvents: Array<{
      userId: string
      roles: readonly string[]
      previousRoles: readonly string[]
      local: boolean
    }> = []

    // replay: true emits existing non-empty role holders immediately
    const replayed: string[] = []
    const unsubReplay = hostRoom.onRoleChange(
      ({userId, roles: r}) => {
        replayed.push(`${userId}:${r.join(',')}`)
      },
      {replay: true}
    )
    unsubReplay()
    assert.deepEqual(replayed, [`${hostIdentity.userId}:admin`])

    hostRoom.onRoleChange(ev => hostRoleEvents.push(ev))
    guestRoom.onRoleChange(ev => guestRoleEvents.push(ev))

    await hostRoom.grantRole(guestIdentity.userId, 'editor')
    await waitFor(() => guestRoleEvents.length >= 1, 2_000)

    assert.equal(hostRoleEvents.length, 1)
    assert.deepEqual(hostRoleEvents[0], {
      userId: guestIdentity.userId,
      roles: ['editor'],
      previousRoles: [],
      local: true
    })
    assert.deepEqual(guestRoleEvents[0], {
      userId: guestIdentity.userId,
      roles: ['editor'],
      previousRoles: [],
      local: false
    })

    // Synchronous optimistic state.set() + caller-mutation isolation + explicit undefined guard on userState
    const openState = guestRoom.makeState(
      'counter',
      {count: 0, tag: 'init'},
      {roles: '*'}
    )
    const profile = guestRoom.makeUserState('profile', {nick: 'anon'})

    const syncObserved: number[] = []
    openState.onChange(val => syncObserved.push(val.count))

    const mutableInput = {count: 42, tag: 'live'}
    const setP = openState.set(mutableInput)
    mutableInput.count = 9999
    // Before awaiting setP, local get() & onChange already reflect the normalized value synchronously!
    assert.deepEqual(openState.get(), {count: 42, tag: 'live'})
    assert.deepEqual(syncObserved, [42])
    await setP

    const profileP = profile.set({nick: 'guest'})
    assert.deepEqual(profile.get(), {nick: 'guest'})
    assert.equal(profile.has(), true)
    assert.ok(profile.getMeta())
    // Explicit undefined must NOT alias to local user
    assert.deepEqual(profile.get(undefined), {nick: 'anon'})
    assert.equal(profile.has(undefined), false)
    assert.equal(profile.getMeta(undefined), null)
    await profileP
  } finally {
    await Promise.all([hostRoom.leave(), guestRoom.leave()])
  }
})

void test('Overlay & action-wire regressions: unicast ts/IV checks, root-admin 2-hop broadcast without inlineCert, kicked virtual peer quarantine, atomic multi-target send, and gated-unlistened ring budget', async () => {
  // 1. Unicast replay/skew window (>60s dropped) & 12-byte GCM IV length check
  const alicePid = testPeerId('uc-alice')
  const bobPid = testPeerId('uc-bob')
  const relayPid = testPeerId('uc-relay')
  const appId = 'uc-sec-app'
  const roomId = 'uc-sec-room'
  const deliveredToBob: Uint8Array[] = []

  const alice = createOverlayManager({
    selfId: alicePid,
    appId,
    roomId,
    getLocalEndpointIdentity: () => getTestEndpointByPeerId(alicePid),
    onVirtualPeerJoin: () => true,
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })
  const relay = createOverlayManager({
    selfId: relayPid,
    appId,
    roomId,
    getLocalEndpointIdentity: () => getTestEndpointByPeerId(relayPid),
    onVirtualPeerJoin: () => true,
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })
  const bob = createOverlayManager({
    selfId: bobPid,
    appId,
    roomId,
    quarantineTtlMs: 500,
    getLocalEndpointIdentity: () => getTestEndpointByPeerId(bobPid),
    onVirtualPeerJoin: () => true,
    onVirtualPeerLeave: () => {},
    onDeliverData: (_from, buf) => deliveredToBob.push(new Uint8Array(buf))
  })

  const makePipe = (
    fromId: string,
    to: ReturnType<typeof createOverlayManager>
  ): PeerHandle =>
    ({
      isDead: false,
      channel: {readyState: 'open'},
      sendData: (d: Uint8Array) =>
        to.handleOverlayFrame(fromId, d.slice().buffer),
      destroy: () => {}
    }) as unknown as PeerHandle

  try {
    alice.addDirectPeer(relayPid, makePipe(alicePid, relay))
    relay.addDirectPeer(alicePid, makePipe(relayPid, alice))
    relay.addDirectPeer(bobPid, makePipe(relayPid, bob))
    bob.addDirectPeer(relayPid, makePipe(bobPid, relay))

    await waitFor(() => bob.getSnapshot().roomPeerIds.includes(alicePid), 2_000)

    const aliceCrypto = await alice.getLocalCryptoIdentity()
    // Short/malformed 8-byte IV (11 Base64URL chars != 16) must fail signature/header validation
    const shortIv = toBase64Url(new Uint8Array(8))
    const badIvHeader = canonicalUnicastHeader(
      alicePid,
      bobPid,
      `${alicePid}:50:badiv`,
      shortIv,
      50,
      Date.now(),
      appId,
      roomId
    )
    const badIvSig = await signOverlayPayload(
      aliceCrypto.signPrivateKey,
      badIvHeader,
      new Uint8Array([1, 2, 3])
    )
    const sigFailsBefore = bob.getSnapshot().stats.signatureFailures
    bob.handleOverlayFrame(
      relayPid,
      packOverlayBinary(
        overlayUnicastKind,
        8,
        {
          o: alicePid,
          d: bobPid,
          q: 50,
          t: Date.now(),
          m: `${alicePid}:50:badiv`,
          iv: shortIv,
          s: badIvSig
        },
        new Uint8Array([1, 2, 3])
      ).slice().buffer
    )
    await wait(20)
    assert.ok(bob.getSnapshot().stats.signatureFailures > sigFailsBefore)
    assert.equal(deliveredToBob.length, 0)

    // Stale unicast timestamp (> 60s old) must be dropped silently before decrypt
    const staleTs = Date.now() - 120_000
    const validIvBytes = crypto.getRandomValues(new Uint8Array(12))
    const validIvB64 = toBase64Url(validIvBytes)
    const staleCanonical = canonicalUnicastHeader(
      alicePid,
      bobPid,
      `${alicePid}:51:stale`,
      validIvB64,
      51,
      staleTs,
      appId,
      roomId
    )
    const dummyKey = await crypto.subtle.generateKey(
      {name: 'AES-GCM', length: 256},
      false,
      ['encrypt', 'decrypt']
    )
    const staleCipher = await encryptUnicastPayload(
      dummyKey,
      validIvBytes,
      staleCanonical,
      encodeBytes('stale')
    )
    const staleSig = await signOverlayPayload(
      aliceCrypto.signPrivateKey,
      staleCanonical,
      staleCipher
    )
    const sigFailsBeforeStale = bob.getSnapshot().stats.signatureFailures
    bob.handleOverlayFrame(
      relayPid,
      packOverlayBinary(
        overlayUnicastKind,
        8,
        {
          o: alicePid,
          d: bobPid,
          q: 51,
          t: staleTs,
          m: `${alicePid}:51:stale`,
          iv: validIvB64,
          s: staleSig
        },
        staleCipher
      ).slice().buffer
    )
    await wait(20)
    assert.equal(bob.getSnapshot().stats.signatureFailures, sigFailsBeforeStale)
    assert.equal(deliveredToBob.length, 0)

    // Non-violation virtual kick (e.g. send-side control backpressure) must NOT quarantine Alice
    bob.removeDirectPeer(
      alicePid,
      undefined,
      new Error('unable to send action control')
    )
    assert.equal(bob.getSnapshot().roomPeerIds.includes(alicePid), false)

    const signedAliceDesc98 = await signPeerDescriptor(
      {
        peerId: alicePid,
        seq: 98,
        neighbors: [relayPid],
        signPubKey: aliceCrypto.signPubKey,
        encPubKey: aliceCrypto.encPubKey
      },
      aliceCrypto,
      appId,
      roomId,
      '',
      null
    )
    bob.handleOverlayFrame(
      relayPid,
      packOverlayControl({
        t: 'gossip',
        descriptors: [signedAliceDesc98]
      }).slice().buffer
    )
    await waitFor(() => bob.getSnapshot().roomPeerIds.includes(alicePid), 1_000)

    // Add Charlie behind Bob (Alice <-> Relay <-> Bob <-> Charlie) to verify transit traffic & forwarder strikes
    const charliePid = testPeerId('uc-charlie')
    const deliveredToCharlie: Uint8Array[] = []
    const charlie = createOverlayManager({
      selfId: charliePid,
      appId,
      roomId,
      getLocalEndpointIdentity: () => getTestEndpointByPeerId(charliePid),
      onVirtualPeerJoin: () => true,
      onVirtualPeerLeave: () => {},
      onDeliverData: (_from, buf) =>
        deliveredToCharlie.push(new Uint8Array(buf))
    })

    try {
      bob.addDirectPeer(charliePid, makePipe(bobPid, charlie))
      charlie.addDirectPeer(bobPid, makePipe(charliePid, bob))
      await waitFor(
        () => charlie.getSnapshot().roomPeerIds.includes(alicePid),
        2_000
      )

      // Protocol-violation virtual kick on Bob quarantines Alice locally without dropping transit unicasts or penalizing Relay
      bob.removeDirectPeer(
        alicePid,
        undefined,
        mkViolationErr('protocol violation')
      )
      assert.equal(bob.getSnapshot().roomPeerIds.includes(alicePid), false)

      const sigFailsBeforeRegossip = bob.getSnapshot().stats.signatureFailures
      const signedAliceDesc99 = await signPeerDescriptor(
        {
          peerId: alicePid,
          seq: 99,
          neighbors: [relayPid],
          signPubKey: aliceCrypto.signPubKey,
          encPubKey: aliceCrypto.encPubKey
        },
        aliceCrypto,
        appId,
        roomId,
        '',
        null
      )
      bob.handleOverlayFrame(
        relayPid,
        packOverlayControl({
          t: 'gossip',
          descriptors: [signedAliceDesc99]
        }).slice().buffer
      )
      await wait(30)
      assert.equal(bob.getSnapshot().roomPeerIds.includes(alicePid), false)
      assert.equal(
        bob.getSnapshot().stats.signatureFailures,
        sigFailsBeforeRegossip,
        're-gossiping a quarantined peer descriptor must not increment signatureFailures or strike honest neighbors'
      )

      // Transit unicast from Alice -> Charlie routed through Bob MUST still be forwarded while Alice is quarantined on Bob
      alice.sendUnicast(charliePid, encodeBytes('hello-charlie'))
      await waitFor(() => deliveredToCharlie.length === 1, 1_000)
      assert.equal(
        new TextDecoder().decode(deliveredToCharlie[0]),
        'hello-charlie'
      )
    } finally {
      charlie.destroy()
    }
  } finally {
    alice.destroy()
    relay.destroy()
    bob.destroy()
  }

  // 2. Root-admin 2-hop role-gated action broadcast over scale() + gated-unlistened 32-entry ring off 64-slot budget + atomic multi-target validation
  const adminIdentity = await createUserIdentity()
  const cluster = await createTestScaleCluster({
    peerCount: 10,
    maxDirectPeers: 4,
    adminIdentity
  })

  try {
    const adminId = cluster.peerIds[0]!
    const adminRoom = cluster.rooms.get(adminId)!
    const twoHopId = cluster.peerIds.find(
      id =>
        id !== adminId && (adminRoom.getTopology().routes[id]?.hops ?? 0) >= 2
    )!
    assert.ok(twoHopId, 'expected a >=2-hop peer from root admin')

    // Register admin-gated action across all peers so intermediate relays enforce role gate,
    // EXCEPT leave twoHopId UNLISTENED first to test gated-unlistened ring buffering > 64 sends!
    const adminAnnounceByPeer = new Map<string, MessageAction<string>>()
    for (const id of cluster.peerIds) {
      const act = cluster.rooms
        .get(id)!
        .makeAction<string>('admin-bcast', {roles: ['admin']})
      if (id !== adminId && id !== twoHopId) {
        act.onMessage(() => {})
      }
      adminAnnounceByPeer.set(id, act)
    }

    // Send 70 gated messages (> 64 concurrent transfer budget) while twoHopId has NO listener attached!
    for (let i = 1; i <= 70; i++) {
      await adminAnnounceByPeer.get(adminId)!.send(`msg-${i}`)
    }

    // Wait until messages arrive across the 2-hop path, then attach listener on twoHopId:
    // Latest 32 messages must drain from the pre-listener ring, and subsequent plain actions must NOT be starved!
    await wait(150)
    const drainedOnTwoHop: string[] = []
    adminAnnounceByPeer.get(twoHopId)!.onMessage(m => drainedOnTwoHop.push(m))
    await waitFor(() => drainedOnTwoHop.includes('msg-70'), 2_000)
    assert.equal(
      drainedOnTwoHop.length,
      32,
      'gated unlistened action must use the 32-entry drop-oldest ring instead of starving the 64-slot budget'
    )

    // Verify atomic multi-target validation & clear empty-target error message
    const receivedDirect = new Map<string, string[]>()
    const dmByPeer = new Map<string, MessageAction<string>>()
    for (const id of cluster.peerIds) {
      receivedDirect.set(id, [])
      const dm = cluster.rooms.get(id)!.makeAction<string>('atomic-dm')
      dm.onMessage(m => receivedDirect.get(id)!.push(m))
      dmByPeer.set(id, dm)
    }

    await assert.rejects(
      () => dmByPeer.get(adminId)!.send('nobody', {target: []}),
      /target peer list must not be empty/
    )
    await assert.rejects(
      () =>
        dmByPeer.get(adminId)!.send('must-not-partially-send', {
          target: [twoHopId, 'nonexistentPeerId999']
        }),
      /peer/i
    )
    await wait(60)
    assert.deepEqual(
      receivedDirect.get(twoHopId),
      [],
      'multi-target send must validate all targets up front before transmitting to earlier targets'
    )

    // And a >16 KiB bulk send to twoHopId still succeeds immediately (64-slot transfer budget completely healthy!)
    const bulkAfterRing = 'x'.repeat(32 * 1024)
    await dmByPeer.get(adminId)!.send(bulkAfterRing, {target: twoHopId})
    await waitFor(
      () => receivedDirect.get(twoHopId)!.includes(bulkAfterRing),
      2_000
    )
  } finally {
    await cluster.cleanup()
  }
})

void test('Round-3 regressions: optimistic state skew overwrite & rollback, pre-identity defer, offer-allocation failure recovery, user onReceive-before-onMessage ring, and authority verify-before-evict', async () => {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason)
  }
  process.on('unhandledRejection', onUnhandled)

  try {
    // 1. State optimistic path:
    // (a) Cert-bearing record at iat = now + 15s is accepted AND overwritten cleanly by a plain member
    // (b) Clock jump causing >60s skew rejects set() and rolls back optimistic get() with 0 unhandled rejections
    const adminUser = await createUserIdentity()
    const memberUser = await createUserIdentity()
    const adminEp = await createEndpointIdentity()
    const memberEp = await createEndpointIdentity()
    const appId = 'r3-state-app'
    const roomId = formatSelfCertifyingRoomId('r3-room', adminUser.userId)
    const fastIat = Date.now() + 15_000
    const adminCert = await signRoleCertInternal(
      adminUser.sign,
      adminUser.signPubJwk,
      adminUser.userId,
      appId,
      roomId,
      ['admin'],
      fastIat,
      1
    )
    const fastRec = await signStateRecord(
      adminUser.sign,
      adminUser.signPubJwk,
      {
        kind: 's',
        appId,
        roomId,
        ns: 'cursor',
        hlc: [fastIat, 0],
        peerId: adminEp.peerId,
        userId: adminUser.userId,
        val: 5,
        cert: adminCert
      }
    )

    const rolesProviderStub = {
      isAuthorityResolved: () => true,
      getPeerRoles: (uid: string) =>
        uid === adminUser.userId ? ['admin'] : [],
      getStateWriteCert: async () => ({cert: null, roles: []}),
      verifyStateRecordRoles: async (rec: {userId: string}) => ({
        valid: true,
        roles: rec.userId === adminUser.userId ? ['admin'] : []
      })
    }
    const mkStateMgr = () =>
      createStateManager({
        appId,
        getRoomId: () => roomId,
        getSelfId: () => memberEp.peerId,
        getLocalUserId: () => memberUser.userId,
        ensureReady: async () => ({
          selfId: memberEp.peerId,
          user: memberUser,
          roomId
        }),
        hasRolesPlugin: () => true,
        getRolesProvider: () => rolesProviderStub as never,
        isPeerActive: () => true,
        isPeerPendingHandshake: () => false,
        isDirectPeer: () => false,
        getDirectPeerIds: () => [],
        isUserOnline: () => true,
        getKnownPeerUserId: () => undefined,
        isPeerBanned: () => false,
        getPeerRoles: () => []
      })

    const mgr = mkStateMgr()
    const receiverMgr = mkStateMgr()
    const freshMgr = mkStateMgr()

    try {
      const cursor = mgr.makeState<number>('cursor', 0, {roles: '*'})
      const receiverCursor = receiverMgr.makeState<number>('cursor', 0, {
        roles: '*'
      })
      freshMgr.makeState<number>('cursor', 0, {roles: '*'})

      const applied = await mgr.verifyAndApplyStateRecord(
        fastRec,
        adminEp.peerId
      )
      assert.ok(applied, 'expected +15s cert-bearing record to be accepted')
      assert.equal(cursor.get(), 5)
      assert.equal(
        await receiverMgr.verifyAndApplyStateRecord(fastRec, adminEp.peerId),
        true
      )

      await cursor.set(7)
      assert.equal(
        cursor.get(),
        7,
        'plain member must be able to overwrite an accepted +15s cert record'
      )

      // Receiver-side check (Round-4 F2): a peer holding fastRec accepts the plain member's
      // [fastIat, 1] same-wall counter bump, whereas a fresh late joiner without fastRec drops it
      const memberOverwriteRec = await signStateRecord(
        memberUser.sign,
        memberUser.signPubJwk,
        {
          kind: 's',
          appId,
          roomId,
          ns: 'cursor',
          hlc: [fastIat, 1],
          peerId: memberEp.peerId,
          userId: memberUser.userId,
          val: 7
        }
      )
      assert.equal(
        await receiverMgr.verifyAndApplyStateRecord(
          memberOverwriteRec,
          memberEp.peerId
        ),
        true,
        'peer holding cert record must accept plain member overwrite at [fastIat, 1]'
      )
      assert.equal(receiverCursor.get(), 7)
      assert.equal(
        await freshMgr.verifyAndApplyStateRecord(
          memberOverwriteRec,
          memberEp.peerId
        ),
        false,
        'fresh late-joiner without cert record must drop uncertified future timestamp'
      )

      // Now simulate local wall clock jumping backward by 90s so minHlcVal (fastIat) exceeds now + 60s
      const realNow = Date.now
      Date.now = () => realNow() - 90_000
      try {
        const pReject = cursor.set(99)
        assert.equal(cursor.get(), 99, 'optimistic value applied synchronously')
        await assert.rejects(() => pReject, /state clock skew exceeded/)
        assert.equal(
          cursor.get(),
          7,
          'optimistic value must roll back to 7 when nextHlc throws'
        )
      } finally {
        Date.now = realNow
      }
      await wait(30)
      assert.deepEqual(unhandled, [])
    } finally {
      mgr.destroy()
      receiverMgr.destroy()
      freshMgr.destroy()
    }

    // 1b. Round-4 F1: plain member cannot ratchet an open shared namespace past now + 10s
    const ratchetRoomId = 'r4-no-ratchet-room'
    const [attackerUser, attackerEp, honestUser, honestEp] = await Promise.all([
      createUserIdentity(),
      createEndpointIdentity(),
      createUserIdentity(),
      createEndpointIdentity()
    ])
    const mkOpenMgr = () =>
      createStateManager({
        appId,
        getRoomId: () => ratchetRoomId,
        getSelfId: () => honestEp.peerId,
        getLocalUserId: () => honestUser.userId,
        ensureReady: async () => ({
          selfId: honestEp.peerId,
          user: honestUser,
          roomId: ratchetRoomId
        }),
        hasRolesPlugin: () => false,
        getRolesProvider: () => null,
        isPeerActive: () => true,
        isPeerPendingHandshake: () => false,
        isDirectPeer: () => false,
        getDirectPeerIds: () => [],
        isUserOnline: () => true,
        getKnownPeerUserId: () => undefined,
        isPeerBanned: () => false,
        getPeerRoles: () => []
      })
    const victimMgr = mkOpenMgr()
    const lateOpenMgr = mkOpenMgr()
    try {
      const board = victimMgr.makeState<number>('board', 0)
      const lateBoard = lateOpenMgr.makeState<number>('board', 0)
      const t0 = Date.now()
      let acceptedCount = 0
      let maxAcceptedWall = 0
      for (let i = 0; i < 70; i++) {
        const wall = t0 + 9_500 + i * 1_000
        const rec = await signStateRecord(
          attackerUser.sign,
          attackerUser.signPubJwk,
          {
            kind: 's',
            appId,
            roomId: ratchetRoomId,
            ns: 'board',
            hlc: [wall, 0],
            peerId: attackerEp.peerId,
            userId: attackerUser.userId,
            val: i + 1
          }
        )
        if (await victimMgr.verifyAndApplyStateRecord(rec, attackerEp.peerId)) {
          acceptedCount++
          maxAcceptedWall = wall
        }
      }
      assert.ok(
        maxAcceptedWall <= Date.now() + 10_000,
        `plain member must never pin namespace beyond now + 10s (got +${maxAcceptedWall - Date.now()}ms across ${acceptedCount} accepted records)`
      )
      await board.set(999)
      assert.equal(board.get(), 999)
      const honestRec = await signStateRecord(
        honestUser.sign,
        honestUser.signPubJwk,
        {
          kind: 's',
          appId,
          roomId: ratchetRoomId,
          ns: 'board',
          hlc: [maxAcceptedWall, 1],
          peerId: honestEp.peerId,
          userId: honestUser.userId,
          val: 999
        }
      )
      assert.equal(
        await lateOpenMgr.verifyAndApplyStateRecord(honestRec, honestEp.peerId),
        true,
        'fresh late-joiner must accept honest follow-up bounded within now + 10s'
      )
      assert.equal(lateBoard.get(), 999)
    } finally {
      victimMgr.destroy()
      lateOpenMgr.destroy()
    }

    // 2. Pre-identity set() defers optimistic apply instead of emitting userId: ''
    let deferredUid = ''
    let resolveDeferredIdentity!: () => void
    const deferredReadyGate = new Promise<void>(r => {
      resolveDeferredIdentity = r
    })
    const preIdUser = await createUserIdentity()
    const preIdEp = await createEndpointIdentity()
    const preIdMgr = createStateManager({
      appId: 'r3-preid-app',
      getRoomId: () => 'r3-preid-room',
      getSelfId: () => preIdEp.peerId,
      getLocalUserId: () => deferredUid,
      ensureReady: async () => {
        await deferredReadyGate
        deferredUid = preIdUser.userId
        return {
          selfId: preIdEp.peerId,
          user: preIdUser,
          roomId: 'r3-preid-room'
        }
      },
      hasRolesPlugin: () => false,
      getRolesProvider: () => null,
      isPeerActive: () => true,
      isPeerPendingHandshake: () => false,
      isDirectPeer: () => false,
      getDirectPeerIds: () => [],
      isUserOnline: () => true,
      getKnownPeerUserId: () => undefined,
      isPeerBanned: () => false,
      getPeerRoles: () => []
    })
    try {
      const seenUids: string[] = []
      const uState = preIdMgr.makeUserState<string>('nick', 'anon')
      uState.onChange((_val, ctx) => seenUids.push(ctx.userId))
      const setP = uState.set('alice')
      assert.deepEqual(
        seenUids,
        [],
        'must defer optimistic onChange before local userId is known'
      )
      assert.equal(uState.has(), false)
      assert.deepEqual(uState.getAll(), {})
      resolveDeferredIdentity()
      await setP
      assert.deepEqual(seenUids, [preIdUser.userId])
      assert.equal(uState.has(), true)
      assert.deepEqual(uState.getAll(), {[preIdUser.userId]: 'alice'})
    } finally {
      preIdMgr.destroy()
    }

    // 3. Signal handler: transient offer-allocation throw clears relay placeholder and recovers on next announce
    const subs = new Map<string, Set<(topic: string, msg: string) => void>>()
    let rtcCalls = 0
    class FlakyOnceRTCPeerConnection extends MockRTCPeerConnection {
      constructor() {
        super()
        rtcCalls++
        if (rtcCalls === 1) {
          throw new Error('transient RTCPeerConnection allocation error')
        }
      }
    }
    const offerSignals: string[] = []

    const makeFlakyStrategy = () =>
      createTopicStrategy({
        init: () => ['relay-0'],
        subscribeTopic: (_relay, topic, onMsg) => {
          let s = subs.get(topic)
          if (!s) {
            s = new Set()
            subs.set(topic, s)
          }
          s.add(onMsg)
          return () => s?.delete(onMsg)
        },
        publishTopic: (_relay, topic, payload, ctx) => {
          const raw =
            typeof payload === 'string' ? payload : JSON.stringify(payload)
          if (ctx.kind === 'signal' && raw.includes('"offer"')) {
            offerSignals.push(raw)
          }
          queueMicrotask(() => {
            subs.get(topic)?.forEach(cb => cb(topic, raw))
          })
          return ctx.kind === 'announce' ? 80 : undefined
        }
      })

    const origConsoleError = console.error
    console.error = (...args: unknown[]) => {
      if (
        args[1] instanceof Error &&
        args[1].message.includes('transient RTCPeerConnection')
      ) {
        return
      }
      origConsoleError(...args)
    }
    const room1 = makeFlakyStrategy()(
      {
        appId: 'r3-flaky-offer',
        rtcPolyfill:
          FlakyOnceRTCPeerConnection as unknown as typeof RTCPeerConnection
      },
      'offer-room'
    )
    const room2 = makeFlakyStrategy()(
      {
        appId: 'r3-flaky-offer',
        rtcPolyfill:
          FlakyOnceRTCPeerConnection as unknown as typeof RTCPeerConnection
      },
      'offer-room'
    )
    try {
      await waitFor(() => offerSignals.length >= 1, 2_000)
      assert.equal(
        unhandled.length,
        0,
        'transient offer failure must not emit unhandledRejection'
      )
      assert.ok(
        rtcCalls >= 2,
        'expected FlakyOnceRTCPeerConnection to fail once, clear relay placeholder, and send offer on next announce'
      )
    } finally {
      console.error = origConsoleError
      await Promise.all([room1.leave(), room2.leave()])
    }

    // 4. User onReceive registered BEFORE onMessage uses 32-entry ring and never starves concurrent bulk transfers
    const holIdA = testPeerId('hol-a')
    const holIdB = testPeerId('hol-b')
    let addPeerA!: (peer: PeerHandle, id: string) => void
    let addPeerB!: (peer: PeerHandle, id: string) => void
    const roomA = createRoom(
      cb => {
        addPeerA = cb
      },
      () => {},
      () => {},
      {
        appId: 'r3-hol-app',
        roomId: 'r3-hol-room',
        endpointIdentity: getTestEndpointByPeerId(holIdA)
      }
    )
    const roomB = createRoom(
      cb => {
        addPeerB = cb
      },
      () => {},
      () => {},
      {
        appId: 'r3-hol-app',
        roomId: 'r3-hol-room',
        endpointIdentity: getTestEndpointByPeerId(holIdB)
      }
    )
    const {peerA: pLeft, peerB: pRight} = createLinkedHandlePair()
    addPeerA(pLeft, holIdB)
    addPeerB(pRight, holIdA)
    try {
      await waitFor(
        () =>
          Boolean(roomA.getPeers()[holIdB]) &&
          Boolean(roomB.getPeers()[holIdA]),
        2_000
      )
      const gatedA = roomA.makeAction<string>('user-gated')
      const gatedB = roomB.makeAction<string>('user-gated')
      // Attach user onReceive BEFORE onMessage (canonical README pattern!)
      gatedB.onReceive(({metadata}) => metadata !== 'drop')

      for (let i = 1; i <= 70; i++) {
        await gatedA.send(`m-${i}`)
      }
      await wait(30)

      // Concurrent 100 KiB bulk transfer on another action must succeed immediately (64-slot budget untouched!)
      const bulkA = roomA.makeAction<Uint8Array>('bulk-check')
      const bulkB = roomB.makeAction<Uint8Array>('bulk-check')
      let gotBulkBytes = 0
      bulkB.onMessage(buf => {
        gotBulkBytes = buf.byteLength
      })
      await bulkA.send(new Uint8Array(100_000).fill(9))
      await waitFor(() => gotBulkBytes === 100_000, 2_000)

      const drainedGated: string[] = []
      gatedB.onMessage(m => drainedGated.push(m))
      await waitFor(() => drainedGated.includes('m-70'), 1_000)
      assert.equal(drainedGated.length, 32)
      assert.equal(drainedGated[0], 'm-39')
    } finally {
      await Promise.all([roomA.leave(), roomB.leave()])
    }

    // 5. Authority verify-before-evict: garbage-signed moderation records at capacity must NOT evict unban tombstones
    const rootAdmin = await createUserIdentity()
    const victimUser = await createUserIdentity()
    const authRoomId = formatSelfCertifyingRoomId(
      'evict-room',
      rootAdmin.userId
    )
    const senderAuth = createRoomAuthority({
      selfId: () => 'root-p',
      appId: 'r3-evict-app',
      initialRoomId: authRoomId,
      admin: {admins: [rootAdmin.userId]},
      getLocalUserIdentity: async () => rootAdmin
    })
    const receiverAuth = createRoomAuthority({
      selfId: () => 'recv-p',
      appId: 'r3-evict-app',
      initialRoomId: authRoomId,
      admin: {admins: [rootAdmin.userId]},
      getLocalUserIdentity: async () => victimUser
    })
    const banRec = await senderAuth.issuePeerModeration(
      'ban',
      victimUser.userId,
      {reason: 'first'}
    )
    const unbanRec = await senderAuth.issuePeerModeration(
      'unban',
      victimUser.userId
    )
    assert.equal(await receiverAuth.verifyAndApplyModeration(banRec), true)
    assert.equal(await receiverAuth.verifyAndApplyModeration(unbanRec), true)
    assert.equal(receiverAuth.isPeerBanned(victimUser.userId), false)

    // Fill moderation store to 4,096 with valid unban tombstones for synthetic base62 userIds
    const chars =
      '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
    const mkUid = (idx: number): string => {
      let s = ''
      let x = idx + 1
      for (let k = 0; k < 22; k++) {
        s += chars[x % 62]!
        x = Math.floor(x / 62) + k * 7 + 3
      }
      return s
    }
    for (let base = 0; base < 4_095; base += 128) {
      const end = Math.min(4_095, base + 128)
      const recs = await Promise.all(
        Array.from({length: end - base}, (_, j) =>
          senderAuth.issuePeerModeration('unban', mkUid(base + j))
        )
      )
      for (const uRec of recs) {
        await receiverAuth.verifyAndApplyModeration(uRec)
      }
    }

    // Now send 10 shape-valid, garbage-signed moderation records for fresh targets:
    // none may evict victimUser's oldest unban tombstone!
    const badSig = 'A'.repeat(86)
    for (let i = 0; i < 10; i++) {
      const forged = {
        ...unbanRec,
        modId: `forged-${i}`,
        targetUserId: mkUid(10_000 + i),
        seq: 999_999 + i,
        sig: badSig
      }
      assert.equal(await receiverAuth.verifyAndApplyModeration(forged), false)
    }

    // Replaying the superseded genuine banRec must STILL be rejected because victimUser's unban tombstone survived!
    assert.equal(await receiverAuth.verifyAndApplyModeration(banRec), false)
    assert.equal(receiverAuth.isPeerBanned(victimUser.userId), false)

    // 6. Scale-room leave() sends direct leave frame synchronously to open neighbors even if another direct channel is closing
    const pidLeaveA = testPeerId('leave-scale-a')
    const pidLeaveB = testPeerId('leave-scale-b')
    const pidLeaveC = testPeerId('leave-scale-c')
    let onPeerA!: (peer: PeerHandle, id: string) => void
    let onPeerB!: (peer: PeerHandle, id: string) => void
    let onPeerC!: (peer: PeerHandle, id: string) => void
    const bLeftIds: string[] = []
    const leaveRoomA = createRoom(
      f => {
        onPeerA = f
      },
      () => {},
      () => {},
      {
        appId: 'r4-leave-app',
        roomId: 'r4-leave-room',
        endpointIdentity: getTestEndpointByPeerId(pidLeaveA),
        use: [scale({maxDirectPeers: 4})]
      }
    )
    const leaveRoomB = createRoom(
      f => {
        onPeerB = f
      },
      () => {},
      () => {},
      {
        appId: 'r4-leave-app',
        roomId: 'r4-leave-room',
        endpointIdentity: getTestEndpointByPeerId(pidLeaveB),
        use: [scale({maxDirectPeers: 4})]
      }
    )
    leaveRoomB.onPeerLeave(({peerId}) => {
      bLeftIds.push(peerId)
    })
    const leaveRoomC = createRoom(
      f => {
        onPeerC = f
      },
      () => {},
      () => {},
      {
        appId: 'r4-leave-app',
        roomId: 'r4-leave-room',
        endpointIdentity: getTestEndpointByPeerId(pidLeaveC),
        use: [scale({maxDirectPeers: 4})]
      }
    )
    try {
      const {peerA: abA, peerB: abB} = createLinkedHandlePair()
      const {peerA: acA, peerB: acC} = createLinkedHandlePair()
      const bJoinedP = new Promise<void>(res =>
        leaveRoomB.onPeerJoin(({peerId}) => {
          if (peerId === pidLeaveA) {
            res()
          }
        })
      )
      const aJoinedC = new Promise<void>(res =>
        leaveRoomA.onPeerJoin(({peerId}) => {
          if (peerId === pidLeaveC) {
            res()
          }
        })
      )
      onPeerA(abA, pidLeaveB)
      onPeerB(abB, pidLeaveA)
      onPeerA(acA, pidLeaveC)
      onPeerC(acC, pidLeaveA)
      await Promise.all([bJoinedP, aJoinedC])

      // Simulate C's channel entering 'closing' before its close event fires, then call leaveRoomA.leave()
      ;(acA.channel as {readyState: string}).readyState = 'closing'
      const syncSentToB: Uint8Array[] = []
      const origSendB = abA.sendData.bind(abA)
      abA.sendData = data => {
        syncSentToB.push(new Uint8Array(data))
        origSendB(data)
      }
      const leaveP = leaveRoomA.leave()
      assert.equal(
        syncSentToB.length,
        1,
        'leave() must write @_leave synchronously to open direct neighbors even when another direct channel is closing'
      )
      assert.ok(
        new TextDecoder().decode(syncSentToB[0]!).includes('@_leave'),
        'synchronous leave frame must carry @_leave'
      )
      await waitFor(() => bLeftIds.includes(pidLeaveA), 1_000)
      await leaveP
    } finally {
      await Promise.all([
        leaveRoomA.leave(),
        leaveRoomB.leave(),
        leaveRoomC.leave()
      ])
    }

    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})
