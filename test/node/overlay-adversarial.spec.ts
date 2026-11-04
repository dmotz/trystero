import assert from 'node:assert/strict'
import test from './test.ts'
import type {Room, ScalePluginApi} from '../../packages/core/src/index.ts'
import {ecdsaSign, signRoomAuth} from '../../packages/core/src/crypto.ts'
import {
  createUserIdentity,
  jwkToCompactPub,
  signUserEndpointProof
} from '../../packages/core/src/identity.ts'
import {
  computeTargetNeighbors,
  createOverlayManager,
  descriptorCanonicalPayload,
  maxAllowedHops,
  overlayBroadcastKind,
  overlayControlKind,
  overlayFrameVersion,
  overlayUnicastKind,
  packOverlayBinary,
  packOverlayControl,
  scale,
  unpackOverlayFrame
} from '../../packages/core/src/scale/index.ts'
import {createSignalHandler} from '../../packages/core/src/signal-handler.ts'
import {
  decodeBytes,
  encodeBytes,
  toBase64Url
} from '../../packages/core/src/utils.ts'
import {
  createOverlayCluster,
  createTrackedRoom as createRoom,
  getRoomSignalingBridge
} from './overlay-harness.ts'
import {
  getTestEndpointByPeerId,
  LinkedPeer,
  linkPeers,
  testPeerId,
  wait,
  waitFor
} from './peer-harness.ts'

void test('Adversarial peer attacks: TOFU key-hijack attempt, forged leave/down eviction DoS, replay floods, TTL amplification, and deduplication cache-poisoning resistance', async () => {
  const relayedToBobFrames: Uint8Array[] = []
  const aliceToRelayFrames: Uint8Array[] = []
  const bobDelivered: Array<{from: string; text: string}> = []
  const aliceId = testPeerId('adv-alice')
  const relayId = testPeerId('adv-relay')
  const bobId = testPeerId('adv-bob')
  const carolId = testPeerId('adv-carol')
  const relayClampId = testPeerId('adv-relay-clamp')
  const downstreamId = testPeerId('adv-downstream')
  const upstreamId = testPeerId('adv-upstream')

  const alice = createOverlayManager({
    selfId: aliceId,
    appId: 'adv-app',
    roomId: 'adv-room',
    password: 'shared-room-secret',
    config: {
      maxDirectPeers: 4
    },
    getLocalEndpointIdentity: () => getTestEndpointByPeerId(aliceId),
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })

  const relay = createOverlayManager({
    selfId: relayId,
    appId: 'adv-app',
    roomId: 'adv-room',
    password: 'shared-room-secret',
    config: {
      maxDirectPeers: 4
    },
    getLocalEndpointIdentity: () => getTestEndpointByPeerId(relayId),
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })

  const bob = createOverlayManager({
    selfId: bobId,
    appId: 'adv-app',
    roomId: 'adv-room',
    password: 'shared-room-secret',
    config: {
      maxDirectPeers: 4
    },
    getLocalEndpointIdentity: () => getTestEndpointByPeerId(bobId),
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: (origin, data) => {
      bobDelivered.push({
        from: origin,
        text: decodeBytes(new Uint8Array(data))
      })
    }
  })

  const makePipe = (
    fromId: string,
    toManager: ReturnType<typeof createOverlayManager>,
    tap?: (bytes: Uint8Array) => void
  ) => ({
    isDead: false,
    connection: {} as any,
    channel: {readyState: 'open'} as any,
    getOffer: async () => undefined,
    signal: async () => undefined,
    sendData: (data: Uint8Array) => {
      tap?.(data.slice())
      queueMicrotask(() =>
        toManager.handleOverlayFrame(fromId, data.slice().buffer)
      )
    },
    destroy: () => {},
    setHandlers: () => {},
    addStream: () => {},
    removeStream: () => {},
    addTrack: () => ({}) as any,
    removeTrack: () => {},
    replaceTrack: async () => {}
  })

  alice.addDirectPeer(
    relayId,
    makePipe(aliceId, relay, b => aliceToRelayFrames.push(b))
  )
  relay.addDirectPeer(aliceId, makePipe(relayId, alice))
  relay.addDirectPeer(
    bobId,
    makePipe(relayId, bob, b => relayedToBobFrames.push(b))
  )
  bob.addDirectPeer(relayId, makePipe(bobId, relay))

  await waitFor(
    () =>
      alice.getSnapshot().roomPeerIds.includes(bobId) &&
      bob.getSnapshot().roomPeerIds.includes(aliceId),
    2_000
  )
  await wait(60)

  // Attack A: TOFU Key-Replacement / Identity Hijacking Attack
  // Mallory is an authenticated room insider (knows password) who generates a real ECDSA/ECDH keypair
  // and signs a higher-seq descriptor (seq: 999) claiming to be Alice to hijack Alice's identity.
  const [mallorySignPair, malloryEncPair] = await Promise.all([
    crypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, true, [
      'sign',
      'verify'
    ]),
    crypto.subtle.generateKey({name: 'ECDH', namedCurve: 'P-256'}, true, [
      'deriveKey',
      'deriveBits'
    ])
  ])
  const [mallorySignJwk, malloryEncJwk] = await Promise.all([
    crypto.subtle.exportKey('jwk', mallorySignPair.publicKey),
    crypto.subtle.exportKey('jwk', malloryEncPair.publicKey)
  ])
  const validRoomAuthForHijack = await signRoomAuth(
    'shared-room-secret',
    'adv-app',
    'adv-room',
    aliceId,
    999
  )
  const mallorySignPubKey = jwkToCompactPub(mallorySignJwk)
  const malloryEncPubKey = jwkToCompactPub(malloryEncJwk)
  const hijackCanonical = descriptorCanonicalPayload(
    {
      peerId: aliceId,
      seq: 999,
      neighbors: [relayId],
      signPubKey: mallorySignPubKey,
      encPubKey: malloryEncPubKey,
      roomAuth: validRoomAuthForHijack
    },
    'adv-app',
    'adv-room'
  )
  const hijackSigB64 = toBase64Url(
    await ecdsaSign(
      mallorySignPair.privateKey,
      encodeBytes(hijackCanonical) as BufferSource
    )
  )

  const sigFailuresBeforeHijack = bob.getSnapshot().stats.signatureFailures
  bob.handleOverlayFrame(
    relayId,
    packOverlayControl({
      t: 'gossip',
      descriptors: [
        {
          peerId: aliceId,
          seq: 999,
          neighbors: [relayId],
          signPubKey: mallorySignPubKey,
          encPubKey: malloryEncPubKey,
          roomAuth: validRoomAuthForHijack,
          sig: hijackSigB64
        }
      ]
    }).slice().buffer
  )
  await wait(40)
  assert.equal(
    bob.getSnapshot().stats.signatureFailures,
    sigFailuresBeforeHijack + 1,
    'TOFU key pinning must reject validly signed descriptor with replaced public key for pinned peerId'
  )

  // Attack B: Forged `leave` Control Frame DoS (Unsigned & Forged-Signature Remote Kick)
  const sigFailuresBeforeLeave = bob.getSnapshot().stats.signatureFailures
  bob.handleOverlayFrame(
    relayId,
    packOverlayControl({
      t: 'leave',
      peerId: aliceId,
      seq: 500
    }).slice().buffer
  )
  bob.handleOverlayFrame(
    relayId,
    packOverlayControl({
      t: 'leave',
      peerId: aliceId,
      seq: 501,
      sig: hijackSigB64
    }).slice().buffer
  )
  await wait(40)
  assert.equal(
    bob.getSnapshot().stats.signatureFailures,
    sigFailuresBeforeLeave + 2,
    'unsigned and forged-signature leave messages must both be rejected'
  )
  assert.ok(
    bob.getSnapshot().roomPeerIds.includes(aliceId),
    'Alice must remain in Bob roomPeerIds after forged leave DoS attempts'
  )

  // Attack C: Legacy/forged gossip `down` field in control frame is ignored and cannot evict Alice
  bob.handleOverlayFrame(
    relayId,
    new Uint8Array([
      overlayFrameVersion,
      overlayControlKind,
      ...encodeBytes(
        JSON.stringify({t: 'gossip', descriptors: [], down: [aliceId]})
      )
    ]).slice().buffer
  )
  await wait(40)
  assert.ok(
    bob.getSnapshot().roomPeerIds.includes(aliceId),
    'Alice must remain in Bob roomPeerIds after legacy/forged gossip down claim'
  )

  // Attack D: Pre-Verification Deduplication Cache-Poisoning Attack
  // Capture a real signed broadcast packet from Alice, then inject a forged packet with the
  // EXACT same msgId into Carol first, followed by Alice's genuine packet.
  aliceToRelayFrames.length = 0
  await alice.broadcastInline(
    encodeBytes('GENUINE-BROADCAST-AFTER-POISON-ATTEMPT')
  )
  await waitFor(() => bobDelivered.length === 1, 2_000)

  const genuineAliceBroadcast = aliceToRelayFrames.find(frame => {
    const parsed = unpackOverlayFrame(frame)
    return parsed?.[0] === overlayBroadcastKind
  })
  assert.ok(
    genuineAliceBroadcast,
    'expected captured broadcast frame from Alice'
  )
  const [, , genuineHeader] = unpackOverlayFrame(genuineAliceBroadcast!)!

  // Now test cache-poisoning resistance on a fresh peer (Carol) that pins Alice's key
  // and receives a forged frame with msgId = genuineHeader.m BEFORE the genuine frame!
  const carolDelivered: string[] = []
  const carol = createOverlayManager({
    selfId: carolId,
    appId: 'adv-app',
    roomId: 'adv-room',
    password: 'shared-room-secret',
    config: {
      maxDirectPeers: 4
    },
    getLocalEndpointIdentity: () => getTestEndpointByPeerId(carolId),
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: (_origin, data) => {
      carolDelivered.push(decodeBytes(new Uint8Array(data)))
    }
  })
  relay.addDirectPeer(carolId, makePipe(relayId, carol))
  carol.addDirectPeer(relayId, makePipe(carolId, relay))
  await waitFor(() => carol.getSnapshot().roomPeerIds.includes(aliceId), 2_000)

  const poisonedSameMsgIdPacket = packOverlayBinary(
    overlayBroadcastKind,
    4,
    {
      o: aliceId,
      q: genuineHeader['q'],
      t: genuineHeader['t'],
      m: genuineHeader['m'],
      s: hijackSigB64
    },
    encodeBytes('CORRUPTED-FAST-PATH-PACKET')
  )
  // 1. Inject forged packet with msgId & seq first
  carol.handleOverlayFrame(relayId, poisonedSameMsgIdPacket.slice().buffer)
  await wait(30)
  assert.equal(carolDelivered.length, 0)
  assert.equal(carol.getSnapshot().stats.signatureFailures, 1)

  // 2. Now inject the genuine signed packet with the exact same msgId & seq
  carol.handleOverlayFrame(relayId, genuineAliceBroadcast!.slice().buffer)
  await waitFor(() => carolDelivered.length === 1, 1_000)
  assert.equal(
    carolDelivered[0],
    'GENUINE-BROADCAST-AFTER-POISON-ATTEMPT',
    'forged packet must not poison replay window or seenMessages cache against genuine packet'
  )

  // Attack E: Replay Flood (25x) & TTL = 255 Amplification Clamping
  const dupsBeforeReplay = carol.getSnapshot().stats.duplicatesDropped
  for (let i = 0; i < 25; i++) {
    carol.handleOverlayFrame(relayId, genuineAliceBroadcast!.slice().buffer)
  }
  await wait(30)
  assert.equal(
    carol.getSnapshot().stats.duplicatesDropped,
    dupsBeforeReplay + 25,
    'all 25 replayed frames must be dropped as duplicates'
  )
  assert.equal(
    carolDelivered.length,
    1,
    'replayed signed broadcast must never be delivered more than once'
  )

  // Verify TTL = 255 amplification clamping when Relay forwards a broadcast packet
  relayedToBobFrames.length = 0
  await alice.broadcastInline(encodeBytes('TTL-CLAMP-TEST'))
  await waitFor(() => relayedToBobFrames.length > 0, 1_000)
  const anotherAliceBroadcast = aliceToRelayFrames
    .map(f => unpackOverlayFrame(f))
    .find(
      p =>
        p?.[0] === overlayBroadcastKind &&
        decodeBytes(p[3]) === 'TTL-CLAMP-TEST'
    )!

  // Craft a packet with Alice's valid header+signature+payload, but malicious ttl = 255,
  // and inject into a new relay (`relayClamp`) to verify forwarded TTL is clamped to maxAllowedHops - 1
  const clampedForwardedFrames: Uint8Array[] = []
  const relayClamp = createOverlayManager({
    selfId: relayClampId,
    appId: 'adv-app',
    roomId: 'adv-room',
    password: 'shared-room-secret',
    config: {
      maxDirectPeers: 4
    },
    getLocalEndpointIdentity: () => getTestEndpointByPeerId(relayClampId),
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })
  relay.addDirectPeer(relayClampId, makePipe(relayId, relayClamp))
  relayClamp.addDirectPeer(relayId, makePipe(relayClampId, relay))
  await waitFor(
    () => relayClamp.getSnapshot().roomPeerIds.includes(aliceId),
    2_000
  )

  relayClamp.addDirectPeer(downstreamId, {
    isDead: false,
    connection: {} as any,
    channel: {readyState: 'open'} as any,
    getOffer: async () => undefined,
    signal: async () => undefined,
    sendData: (data: Uint8Array) => {
      const p = unpackOverlayFrame(data)
      if (p?.[0] === overlayBroadcastKind) {
        clampedForwardedFrames.push(data.slice())
      }
    },
    destroy: () => {},
    setHandlers: () => {},
    addStream: () => {},
    removeStream: () => {},
    addTrack: () => ({}) as any,
    removeTrack: () => {},
    replaceTrack: async () => {}
  })

  const amplifiedTtlPacket = packOverlayBinary(
    overlayBroadcastKind,
    255,
    anotherAliceBroadcast[2],
    anotherAliceBroadcast[3]
  )
  relayClamp.handleOverlayFrame(upstreamId, amplifiedTtlPacket.slice().buffer)
  await waitFor(() => clampedForwardedFrames.length === 1, 1_000)
  const [, forwardedTtl] = unpackOverlayFrame(clampedForwardedFrames[0]!)!
  assert.equal(
    forwardedTtl,
    maxAllowedHops - 1,
    `incoming TTL=255 must be clamped to maxAllowedHops(${maxAllowedHops}) - 1 = ${maxAllowedHops - 1} on forwarding`
  )

  // Attack F: In-Transit Unicast AES-GCM Ciphertext Bit-Flipping
  relayedToBobFrames.length = 0
  alice.sendUnicast(bobId, encodeBytes('CONFIDENTIAL-UNICAST-MESSAGE'))
  await waitFor(
    () => bobDelivered.some(m => m.text === 'CONFIDENTIAL-UNICAST-MESSAGE'),
    2_000
  )
  const capturedUnicast = relayedToBobFrames
    .map(f => unpackOverlayFrame(f))
    .find(p => p?.[0] === overlayUnicastKind)!
  assert.ok(capturedUnicast, 'expected captured E2EE unicast packet')

  const flippedCiphertext = capturedUnicast[3].slice()
  flippedCiphertext[0] = (flippedCiphertext[0] ?? 0) ^ 0xff
  const tamperedUnicastPacket = packOverlayBinary(
    overlayUnicastKind,
    4,
    {
      ...capturedUnicast[2],
      q: 99,
      m: `${aliceId}:bitflipped-unicast-99`
    },
    flippedCiphertext
  )
  const bobSigFailuresBeforeFlip = bob.getSnapshot().stats.signatureFailures
  const bobCountBeforeFlip = bobDelivered.length
  bob.handleOverlayFrame(relayId, tamperedUnicastPacket.slice().buffer)
  await wait(40)
  assert.equal(
    bob.getSnapshot().stats.signatureFailures,
    bobSigFailuresBeforeFlip + 1,
    'bit-flipped unicast ciphertext must fail authentication and increment signatureFailures'
  )
  assert.equal(bobDelivered.length, bobCountBeforeFlip)

  alice.destroy()
  relay.destroy()
  bob.destroy()
  carol.destroy()
  relayClamp.destroy()
})

void test('Solution (c): signaling door input bounds, early candidate drop before decrypt, public-topic roster poisoning resistance, and room-salted ring placement', async () => {
  // 1. Signaling door validation & bounds in createSignalHandler
  let toPlainCalls = 0
  let discoveredCount = 0
  const honestSelfId = testPeerId('honest-self')

  const relayHandler = createSignalHandler({
    appId: 'sig-app',
    getRoomId: () => 'sig-room',
    config: {appId: 'sig-app'},
    peerStates: new Map(),
    getRootTopicPlaintext: () => 'root-topic',
    rootTopicP: Promise.resolve('root-topic'),
    selfTopicP: Promise.resolve('self-topic'),
    getSelfIdNow: () => honestSelfId,
    selfIdP: Promise.resolve(honestSelfId),
    isLeaving: () => false,
    announceIntervals: [],
    announceIntervalMs: 1_000,
    toPlain: async s => {
      toPlainCalls++
      return s
    },
    toCipher: async s => s,
    checkoutOffers: async () => [],
    claimLeasedOffer: () => {},
    reclaimLeasedOffer: () => {},
    encryptOffer: async () => 'v=0',
    initPeer: () => ({
      isDead: false,
      connection: {} as any,
      channel: null,
      getOffer: async () => ({type: 'offer', sdp: 'v=0'}),
      signal: async () => ({type: 'answer', sdp: 'v=0'}),
      sendData: () => {},
      destroy: () => {},
      setHandlers: () => {},
      addStream: () => {},
      removeStream: () => {},
      addTrack: () => ({}) as any,
      removeTrack: () => {},
      replaceTrack: async () => {}
    }),
    connectPeer: () => {},
    disconnectPeer: () => {},
    onError: undefined,
    onPeerDiscovered: () => {
      discoveredCount++
    }
  }).handleMessage(0)

  const handleSignal = (raw: string, topic = 'root-topic') =>
    relayHandler(topic, raw, () => {})

  // 1a. Oversized raw signaling payload (> 128 KiB) is dropped at ingress
  await handleSignal('x'.repeat(140_000))
  // 1b. Invalid peerId (control chars / > 64 chars) is dropped at ingress
  await handleSignal(JSON.stringify({peerId: 'bad\u0000peer'}))
  await handleSignal(JSON.stringify({peerId: 'p'.repeat(80)}))
  // 1c. Invalid offerId (> 64 chars or invalid chars) is dropped at ingress
  await handleSignal(
    JSON.stringify({
      peerId: testPeerId('valid-peer-1'),
      offerId: 'o'.repeat(80),
      offer: 'v=0'
    })
  )
  // 1d. Oversized SDP (> 64 KiB) or oversized candidate (> 4 KiB) is dropped at ingress
  await handleSignal(
    JSON.stringify({
      peerId: testPeerId('valid-peer-2'),
      offerId: 'offer-1',
      offer: 'v='.repeat(40_000)
    })
  )
  await handleSignal(
    JSON.stringify({
      peerId: testPeerId('valid-peer-3'),
      offerId: 'offer-2',
      candidate: 'c'.repeat(5_000)
    })
  )
  assert.equal(
    discoveredCount,
    0,
    'malformed or oversized signaling payloads must be rejected before onPeerDiscovered'
  )
  assert.equal(
    toPlainCalls,
    0,
    'malformed or oversized signaling payloads must not trigger decryption'
  )

  // 1e. Unsolicited ICE candidate from an unknown peer is dropped BEFORE calling toPlain decryption
  await handleSignal(
    JSON.stringify({
      peerId: testPeerId('unsolicited-cand-peer'),
      offerId: 'offer-unsolicited',
      candidate: 'candidate:1 1 UDP 2122252543 192.0.2.1 5000 typ host'
    }),
    'self-topic'
  )
  assert.equal(
    toPlainCalls,
    0,
    'unsolicited candidate for peer with no active handshake must be dropped before toPlain decryption'
  )

  // 2. Public-topic roster poisoning resistance:
  // An active 4-peer room receives 200 fake peer announcements via notePeerDiscovered on the public signaling topic.
  const cluster = await createOverlayCluster({
    peerCount: 4,
    topology: {maxDirectPeers: 6}
  })
  try {
    const victimId = cluster.peerIds[0]!
    const victimRoom = cluster.rooms.get(victimId)!
    const victimBridge = getRoomSignalingBridge(victimRoom)!
    assert.equal(victimRoom.getTopology().peerId, victimId)
    assert.equal(victimRoom.getTopology().roomPeerIds.length, 3)

    for (let i = 0; i < 200; i++) {
      victimBridge
        .getScaleProvider()
        ?.notePeerDiscovered(testPeerId(`fake-topic-sybil-${i}`))
    }
    await wait(30)

    const snapAfterSpam = victimRoom.getTopology()
    assert.deepEqual(
      snapAfterSpam.roomPeerIds,
      cluster.peerIds.slice(1),
      'unverified public-topic announcements must never enter roomPeerIds'
    )
    assert.deepEqual(
      [...(victimBridge.getScaleProvider()?.getTargetNeighbors() ?? [])].sort(
        (a, b) => a.localeCompare(b)
      ),
      cluster.peerIds.slice(1).sort((a, b) => a.localeCompare(b)),
      'unverified public-topic announcements must not displace converged target neighbors'
    )
  } finally {
    await cluster.cleanup()
  }

  // 3. Room-salted ring placement prevents pre-computed cross-room eclipse positioning
  const samplePeers = Array.from(
    {length: 30},
    (_, i) => `peer-${String(i).padStart(2, '0')}`
  )
  const targetsRoom1 = [
    ...computeTargetNeighbors('peer-00', samplePeers, 4, 'app-1\0room-alpha')
  ]
  const targetsRoom2 = [
    ...computeTargetNeighbors('peer-00', samplePeers, 4, 'app-1\0room-beta')
  ]
  assert.notDeepEqual(
    targetsRoom1,
    targetsRoom2,
    'room-salted ring placement must produce different neighbor sets across different rooms'
  )
})

void test("C1 regression: gossip descriptors cannot overwrite or spoof a direct peer's handshake-verified userId", async () => {
  const appId = 'c1-spoof-app'
  const roomId = 'c1-spoof-room'
  const aliceId = testPeerId('c1-adv-alice')
  const malloryId = testPeerId('c1-adv-mallory')
  const relayId = testPeerId('c1-adv-relay')

  const [aliceUser, malloryUser, impersonatedUser, relayUser] =
    await Promise.all([
      createUserIdentity(),
      createUserIdentity(),
      createUserIdentity(),
      createUserIdentity()
    ])
  const aliceEp = getTestEndpointByPeerId(aliceId)
  const malloryEp = getTestEndpointByPeerId(malloryId)
  const relayEp = getTestEndpointByPeerId(relayId)

  const registerCallbacks = new Map<string, (peer: any, id: string) => void>()
  const rooms = new Map<string, Room & ScalePluginApi>()

  const entries = [
    [aliceId, aliceEp, aliceUser],
    [malloryId, malloryEp, malloryUser],
    [relayId, relayEp, relayUser]
  ] as const

  for (const [id, ep, usr] of entries) {
    const room = createRoom(
      peerRegister => {
        registerCallbacks.set(id, peerRegister)
      },
      () => {},
      () => {},
      {
        endpointIdentity: ep,
        identity: usr,
        appId,
        roomId,
        use: [scale({maxDirectPeers: 4})]
      }
    )
    rooms.set(id, room as Room & ScalePluginApi)
  }

  try {
    // Connect Alice <-> Mallory directly, and Alice <-> Relay <-> Mallory
    const linkAM = linkPeers(new LinkedPeer(), new LinkedPeer())
    registerCallbacks.get(aliceId)!(linkAM.peerA, malloryId)
    registerCallbacks.get(malloryId)!(linkAM.peerB, aliceId)

    const linkAR = linkPeers(new LinkedPeer(), new LinkedPeer())
    registerCallbacks.get(aliceId)!(linkAR.peerA, relayId)
    registerCallbacks.get(relayId)!(linkAR.peerB, aliceId)

    const linkRM = linkPeers(new LinkedPeer(), new LinkedPeer())
    registerCallbacks.get(relayId)!(linkRM.peerA, malloryId)
    registerCallbacks.get(malloryId)!(linkRM.peerB, relayId)

    const aliceRoom = rooms.get(aliceId)!

    await waitFor(
      () =>
        aliceRoom.getPeers()[malloryId]?.direct === true &&
        aliceRoom.getPeers()[malloryId]?.userId === malloryUser.userId &&
        aliceRoom.getPeers()[relayId]?.direct === true,
      3_000
    )

    assert.equal(aliceRoom.getPeers()[malloryId]?.userId, malloryUser.userId)
    assert.deepEqual(aliceRoom.getUsers()[malloryUser.userId]?.peerIds, [
      malloryId
    ])

    const aliceScale = getRoomSignalingBridge(aliceRoom)!.getScaleProvider()!

    // Attack 1: Mallory's endpoint signs a high-seq gossip descriptor claiming a DIFFERENT userId
    // (even with a valid userProof from impersonatedUser!).
    const mallorySignPub = jwkToCompactPub(malloryEp.signPubJwk)
    const spoofedWithProof: Record<string, unknown> = {
      peerId: malloryId,
      seq: 500,
      neighbors: [aliceId, relayId].sort(),
      signPubKey: mallorySignPub,
      userId: impersonatedUser.userId,
      userPubKey: jwkToCompactPub(impersonatedUser.signPubJwk),
      userProof: await signUserEndpointProof(impersonatedUser, {
        appId,
        roomId,
        peerId: malloryId,
        peerPubJwk: malloryEp.signPubJwk,
        seq: 500
      })
    }
    spoofedWithProof['sig'] = toBase64Url(
      await malloryEp.sign(
        encodeBytes(
          descriptorCanonicalPayload(spoofedWithProof as any, appId, roomId)
        )
      )
    )

    // Attack 2: Mallory's endpoint signs a higher-seq gossip descriptor claiming Alice's userId without userProof,
    // and another omitting userId/userProof completely.
    const spoofedNoProof: Record<string, unknown> = {
      peerId: malloryId,
      seq: 501,
      neighbors: [aliceId, relayId].sort(),
      signPubKey: mallorySignPub,
      userId: aliceUser.userId
    }
    spoofedNoProof['sig'] = toBase64Url(
      await malloryEp.sign(
        encodeBytes(
          descriptorCanonicalPayload(spoofedNoProof as any, appId, roomId)
        )
      )
    )

    const omittedIdentityDesc: Record<string, unknown> = {
      peerId: malloryId,
      seq: 502,
      neighbors: [aliceId, relayId].sort(),
      signPubKey: mallorySignPub
    }
    omittedIdentityDesc['sig'] = toBase64Url(
      await malloryEp.sign(
        encodeBytes(
          descriptorCanonicalPayload(omittedIdentityDesc as any, appId, roomId)
        )
      )
    )

    for (const desc of [
      spoofedWithProof,
      spoofedNoProof,
      omittedIdentityDesc
    ]) {
      const frame = packOverlayControl({
        t: 'gossip',
        descriptors: [desc as any]
      })
      aliceScale.handleFrame(relayId, frame.slice().buffer)
      aliceScale.handleFrame(malloryId, frame.slice().buffer)
    }
    await wait(80)

    // Direct WebRTC handshake-verified userId MUST remain pinned to malloryUser.userId!
    assert.equal(
      aliceRoom.getPeers()[malloryId]?.userId,
      malloryUser.userId,
      'gossip descriptor must never overwrite handshake-verified direct peer userId'
    )
    assert.equal(
      aliceRoom.getUsers()[impersonatedUser.userId],
      undefined,
      'spoofed userId from gossip descriptor must not appear in getUsers()'
    )
    assert.equal(
      aliceRoom.getUsers()[aliceUser.userId],
      undefined,
      'omitted-proof descriptor claiming local userId must not spoof getUsers()'
    )
    assert.deepEqual(aliceRoom.getUsers()[malloryUser.userId]?.peerIds, [
      malloryId
    ])
  } finally {
    await Promise.all([...rooms.values()].map(r => r.leave()))
  }
})
