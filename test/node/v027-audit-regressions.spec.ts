import assert from 'node:assert/strict'
import test from './test.ts'
import {createAntiEntropySync} from '../../packages/core/src/anti-entropy.ts'
import {
  createRoomAuthority,
  formatSelfCertifyingRoomId,
  roles
} from '../../packages/core/src/authority.ts'
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
  stateMaxFutureSkewMs
} from '../../packages/core/src/signed-record.ts'
import {
  canonicalUnicastHeader,
  createOverlayManager,
  encryptUnicastPayload,
  overlayUnicastKind,
  packOverlayBinary,
  packOverlayControl,
  signOverlayPayload
} from '../../packages/core/src/scale/index.ts'
import createTopicStrategy from '../../packages/core/src/topic-strategy.ts'
import type {MessageAction} from '../../packages/core/src/types.ts'
import {
  encodeBytes,
  peerBannedErr,
  toBase64Url
} from '../../packages/core/src/utils.ts'
import {createWsRelayServer} from '../../packages/ws-relay/src/server.ts'
import {createTestScaleCluster} from './overlay-harness.ts'
import {
  LinkedPeer,
  MockRTCPeerConnection,
  connectVerifiedPeers,
  getTestEndpointByPeerId,
  linkPeers,
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
    syncEngine.onPeerJoined('peerA', true)
    await wait(10)
    assert.deepEqual(requestedCursors, [undefined, 'page-1', 'page-2'])
  } finally {
    syncEngine.destroy()
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

    // Kicked virtual peer TTL quarantine: kicking virtual peer Alice on Bob blocks immediate gossip re-admission
    bob.removeDirectPeer(alicePid, undefined, new Error('protocol violation'))
    assert.equal(bob.getSnapshot().roomPeerIds.includes(alicePid), false)

    // Re-gossiping Alice's descriptor while quarantined must NOT re-admit Alice
    bob.handleOverlayFrame(
      relayPid,
      packOverlayControl({
        t: 'gossip',
        descriptors: [
          {
            peerId: alicePid,
            seq: 99,
            neighbors: [relayPid],
            signPubKey: aliceCrypto.signPubKey,
            encPubKey: aliceCrypto.encPubKey
          }
        ]
      }).slice().buffer
    )
    await wait(30)
    assert.equal(bob.getSnapshot().roomPeerIds.includes(alicePid), false)
    void peerBannedErr
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

    // And a valid send to twoHopId still succeeds immediately (transfer budget completely healthy!)
    await dmByPeer.get(adminId)!.send('after-70-gated', {target: twoHopId})
    await waitFor(
      () => receivedDirect.get(twoHopId)!.includes('after-70-gated'),
      2_000
    )
  } finally {
    await cluster.cleanup()
  }

  // Verify linkPeers helper unused-import cleanliness
  const linked = linkPeers(new LinkedPeer(), new LinkedPeer())
  linked.peerA.destroy()
  linked.peerB.destroy()
})
