import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import test from 'node:test'
import {promisify} from 'node:util'
import {
  compareStateRecords,
  computePayloadDigest,
  createRoomAuthority,
  roles,
  signActionAuth,
  signRoleRevocation,
  signStateRecord,
  verifyActionAuth,
  verifyRoleRevocation,
  verifyStateRecord
} from '../../packages/core/src/authority.ts'
import {
  decrypt,
  derivePairwiseAesKey,
  ecdhKeyAlgo,
  ecdsaKeyAlgo,
  ecdsaSign,
  ecdsaSignAlgo,
  encrypt,
  genKey,
  hashTopic,
  isLowSP256Signature,
  isValidP256PrivateScalar,
  p256N,
  sha256,
  signRoomAuth,
  verifyRoomAuth
} from '../../packages/core/src/crypto.ts'
import {createIdentityHandshake} from '../../packages/core/src/handshake.ts'
import {
  createUserIdentity,
  type EndpointIdentity,
  fromBase64Url,
  getDefaultEndpointIdentity,
  pubJwkToUncompressedBytes,
  resolveUserIdentity,
  toBase64Url,
  userEndpointProofPayload,
  verifyUserIdKey,
  verifyWithP256
} from '../../packages/core/src/identity.ts'
import {
  computeShortestPathRoutes,
  computeTargetNeighbors,
  createOverlayManager,
  deriveMaxHops,
  descriptorCanonicalPayload,
  overlayFrameVersion,
  packGossipControlFrames,
  scale
} from '../../packages/core/src/overlay.ts'
import createRoom, {
  getRoomSignalingBridge
} from '../../packages/core/src/room.ts'
import {
  buildSignalAad,
  createSignalHandler,
  maxPendingPeerConnections
} from '../../packages/core/src/signal-handler.ts'
import createTopicStrategy from '../../packages/core/src/topic-strategy.ts'
import type {
  AuthoritativeStateRecord,
  JsonValue,
  PeerHandle,
  RoleCertificate,
  Room,
  Signal
} from '../../packages/core/src/types.ts'
import {
  decodeBytes,
  definePlugin,
  encodeBytes,
  fromJson,
  genId,
  shuffle,
  strToNum,
  toBase64,
  toJson
} from '../../packages/core/src/utils.ts'
import {createEvent} from '../../packages/nostr/src/index.ts'
import {
  LinkedPeer,
  linkPeers,
  MockRTCPeerConnection,
  wait,
  waitFor
} from './peer-harness.ts'

type PeerDescriptor = Parameters<typeof packGossipControlFrames>[0][number]

const linkHandles = () =>
  linkPeers(new LinkedPeer(), new LinkedPeer()) as unknown as {
    peerA: PeerHandle
    peerB: PeerHandle
  }

const execFileAsync = promisify(execFile)

const makeOverlayPipe = (
  fromId: string,
  to: ReturnType<typeof createOverlayManager>,
  state: {alive: boolean; bufferedAmount?: number} = {alive: true},
  onSend?: (data: Uint8Array) => void
): PeerHandle => ({
  get isDead() {
    return !state.alive
  },
  connection: {} as unknown as RTCPeerConnection,
  channel: {
    get readyState() {
      return state.alive ? 'open' : 'closed'
    },
    get bufferedAmount() {
      return state.bufferedAmount ?? 0
    }
  } as unknown as RTCDataChannel,
  getOffer: async () => undefined,
  signal: async () => undefined,
  sendData: (data: Uint8Array) => {
    if (!state.alive) {
      throw new Error('link down')
    }
    onSend?.(data)
    to.handleOverlayFrame(fromId, data.slice().buffer)
  },
  destroy: () => {
    state.alive = false
  },
  setHandlers: () => {},
  addStream: () => {},
  removeStream: () => {},
  addTrack: () => ({}) as never,
  removeTrack: () => {},
  replaceTrack: async () => {}
})

void test('S1: multi-ring expander guarantees 100% reachability within deriveMaxHops and hop-caps computeShortestPathRoutes', () => {
  const cases = [
    {peerCount: 250, maxConnections: 6},
    {peerCount: 300, maxConnections: 6},
    {peerCount: 500, maxConnections: 6},
    {peerCount: 100, maxConnections: 4}
  ]

  for (const {peerCount, maxConnections} of cases) {
    const peerIds = Array.from(
      {length: peerCount},
      (_, i) => `peer-${String(i).padStart(4, '0')}`
    )
    const adjacency = new Map<string, Set<string>>()
    for (const id of peerIds) {
      const targets = computeTargetNeighbors(
        id,
        peerIds,
        'gossip',
        maxConnections,
        's1-app\0s1-room'
      )
      assert.ok(
        targets.size <= maxConnections,
        `degree ${targets.size} exceeded maxConnections ${maxConnections}`
      )
      adjacency.set(id, targets)
    }

    const maxHops = deriveMaxHops(peerCount, maxConnections)
    // Verify 100% reachability from sample sources across the graph within maxHops
    const sampleIndices = [
      0,
      Math.floor(peerCount / 3),
      Math.floor((2 * peerCount) / 3),
      peerCount - 1
    ]
    for (const idx of sampleIndices) {
      const src = peerIds[idx]!
      const routes = computeShortestPathRoutes(
        src,
        adjacency,
        adjacency.get(src)!,
        maxHops
      )
      assert.equal(
        Object.keys(routes).length,
        peerCount - 1,
        `expected 100% reachability for N=${peerCount}, maxConnections=${maxConnections}, maxHops=${maxHops}`
      )
      for (const r of Object.values(routes)) {
        assert.ok(r.hops <= maxHops)
      }
    }
  }

  // Verify computeShortestPathRoutes enforces maxHops on a linear chain so unreachable virtual peers are never created
  const chainPeers = Array.from({length: 12}, (_, i) => `chain-${i}`)
  const chainAdj = new Map<string, Set<string>>()
  for (let i = 0; i < chainPeers.length; i++) {
    const set = new Set<string>()
    if (i > 0) {
      set.add(chainPeers[i - 1]!)
    }
    if (i + 1 < chainPeers.length) {
      set.add(chainPeers[i + 1]!)
    }
    chainAdj.set(chainPeers[i]!, set)
  }
  const cappedRoutes = computeShortestPathRoutes(
    'chain-0',
    chainAdj,
    ['chain-1'],
    4
  )
  assert.deepEqual(Object.keys(cappedRoutes).sort(), [
    'chain-1',
    'chain-2',
    'chain-3',
    'chain-4'
  ])
  assert.equal(cappedRoutes['chain-5'], undefined)
})

void test('S2: delegated or co-admin cannot demote root admin via cert replacement, revocation, or ban', async () => {
  const rootUser = await createUserIdentity()
  const modUser = await createUserIdentity()
  const s2RoomId = `s2-room~${rootUser.fingerprint}`

  const rootAuth = createRoomAuthority({
    selfId: 'root-ep',
    appId: 's2-app',
    initialRoomId: s2RoomId,
    admin: {selfAsAdmin: true},
    getLocalUserIdentity: async () => rootUser
  })
  const modAuth = createRoomAuthority({
    selfId: 'mod-ep',
    appId: 's2-app',
    initialRoomId: s2RoomId,
    admin: {},
    getLocalUserIdentity: async () => modUser
  })
  const guestUser = await createUserIdentity()
  const guestAuth = createRoomAuthority({
    selfId: 'guest-ep',
    appId: 's2-app',
    initialRoomId: s2RoomId,
    admin: {},
    getLocalUserIdentity: async () => guestUser
  })
  await Promise.all([
    rootAuth.getAuthorityInfo(),
    modAuth.getAuthorityInfo(),
    guestAuth.getAuthorityInfo()
  ])

  // Root grants moderator + admin roles to modUser
  const modCert = await rootAuth.issueRoleCertificate(modUser.userId, [
    'admin',
    'moderator'
  ])
  assert.equal(await modAuth.verifyAndApplyCert(modCert), true)
  assert.equal(await guestAuth.verifyAndApplyCert(modCert), true)

  // Delegated admin cannot issue certificates at all, nor demote root
  await assert.rejects(
    () => modAuth.issueRoleCertificate(rootUser.userId, ['dj']),
    /insufficient authority/i
  )
  await assert.rejects(
    () => modAuth.issueRoleRevocation(rootUser.userId, 'admin'),
    /cannot revoke a root admin/i
  )
  await assert.rejects(
    () => modAuth.issuePeerBan(rootUser.userId),
    /cannot ban a root admin/i
  )

  // Even a forged RoleCertificate signed by modUser targeting rootUser with newer iat is rejected
  const forgedPayload = toJson([
    'trystero:auth:v1',
    'role-cert',
    1,
    'forged-cert-id-123456',
    's2-app',
    s2RoomId,
    rootUser.userId,
    modUser.userId,
    ['dj'],
    Date.now() + 5_000
  ])
  const forgedSig = toBase64Url(await modUser.sign(encodeBytes(forgedPayload)))
  const forgedCert = {
    v: 1 as const,
    certId: 'forged-cert-id-123456',
    appId: 's2-app',
    roomId: s2RoomId,
    subUserId: rootUser.userId,
    issUserId: modUser.userId,
    issPubKey: modUser.signPubJwk,
    roles: ['dj'],
    iat: Date.now() + 5_000,
    sig: forgedSig
  } as unknown as RoleCertificate
  assert.equal(await guestAuth.verifyAndApplyCert(forgedCert), false)
  assert.equal(await rootAuth.verifyAndApplyCert(forgedCert), false)
  assert.equal(rootAuth.getPeerRoles('root-ep').includes('admin'), true)
})

void test('S3: identity or plugin resolution failure reports onJoinError with zero unhandled rejections in Node', async () => {
  const script = `
    import {createTopicStrategy, definePlugin, roles} from './packages/core/dist/index.mjs'

    let unhandled = 0
    process.on('unhandledRejection', () => { unhandled++ })

    class DummyPc {
      iceGatheringState = 'complete'
      createDataChannel() { return {close() {}} }
      async createOffer() { return {type: 'offer', sdp: 'v=0'} }
      async setLocalDescription() {}
      close() {}
    }

    const joinRoom = createTopicStrategy({
      init: () => Promise.resolve({}),
      subscribeTopic: async () => () => {},
      publishTopic: async () => {}
    })

    const joinErrors = []
    const room1 = joinRoom(
      {
        appId: 's3-app',
        rtcPolyfill: DummyPc,
        identity: async () => { throw new Error('boom-identity') },
        use: [roles({selfAsAdmin: true})]
      },
      's3-room-1',
      {onJoinError: d => joinErrors.push(d.error)}
    )

    const badPlugin = definePlugin('bad', {
      resolveRoomId: async () => { throw new Error('boom-plugin') },
      setup: () => ({})
    })
    const room2 = joinRoom(
      {
        appId: 's3-app',
        rtcPolyfill: DummyPc,
        use: [badPlugin]
      },
      's3-room-2',
      {onJoinError: d => joinErrors.push(d.error)}
    )

    await new Promise(r => setTimeout(r, 120))
    await Promise.all([
      room1.leave().catch(() => {}),
      room2.leave().catch(() => {})
    ])
    await new Promise(r => setTimeout(r, 50))

    if (unhandled !== 0 || joinErrors.length !== 2) {
      console.error({unhandled, joinErrors})
      process.exit(2)
    }
  `
  const {stderr} = await execFileAsync(process.execPath, [
    '--input-type=module',
    '-e',
    script
  ])
  assert.equal(stderr, '')
})

void test('S4: solo occupant is never evicted by later joiners with lexicographically smaller peerIds', async () => {
  const mkHostAndJoiners = async (limit: number, joinerIds: string[]) => {
    const regs = new Map<
      string,
      (peer: PeerHandle, id: string) => void | Promise<void>
    >()
    const errors = new Map<string, string[]>()
    const mk = (id: string) => {
      errors.set(id, [])
      return createRoom(
        f => regs.set(id, f),
        () => {},
        () => {},
        {
          selfId: id,
          appId: 's4-app',
          roomId: `s4-room-${limit}`,
          limit,
          onHandshakeError: (_pid, err) => errors.get(id)!.push(err)
        }
      )
    }

    const host = mk('zzz-solo-host')
    await wait(20)

    const joiners = joinerIds.map(id => ({id, room: mk(id)}))
    for (const j of joiners) {
      const {peerA, peerB} = linkHandles()
      void regs.get('zzz-solo-host')!(peerA, j.id)
      void regs.get(j.id)!(peerB, 'zzz-solo-host')
    }
    await wait(80)

    const hostPeers = Object.keys(host.getPeers())
    assert.equal(
      hostPeers.length,
      limit - 1,
      `host with limit=${limit} must retain exactly ${limit - 1} peers`
    )
    assert.deepEqual(
      errors.get('zzz-solo-host'),
      [],
      'established solo host must never report self room-full error'
    )

    await Promise.all([host.leave(), ...joiners.map(j => j.room.leave())])
  }

  await mkHostAndJoiners(1, ['000-attacker-a', '000-attacker-b'])
  await mkHostAndJoiners(2, ['000-joiner-a', '000-joiner-b', '000-joiner-c'])
})

void test('S5: overlay rejects broadcast/unicast replays after seenMsgIds eviction and across direct reconnects, and isolates ECDH keys', async () => {
  const deliveredBroadcasts: string[] = []
  const deliveredUnicasts: string[] = []

  let capturedBroadcast: Uint8Array | null = null
  let capturedUnicast: Uint8Array | null = null

  const alice = createOverlayManager({
    selfId: 'alice-s5',
    appId: 's5-app',
    roomId: 's5-room',
    topology: {mode: 'gossip', maxConnections: 4},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })
  const relay = createOverlayManager({
    selfId: 'relay-s5',
    appId: 's5-app',
    roomId: 's5-room',
    topology: {mode: 'gossip', maxConnections: 4},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: (_from, data) => {
      deliveredBroadcasts.push(decodeBytes(new Uint8Array(data)))
    }
  })
  const carol = createOverlayManager({
    selfId: 'carol-s5',
    appId: 's5-app',
    roomId: 's5-room',
    topology: {mode: 'gossip', maxConnections: 4},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: (_from, data) => {
      const txt = decodeBytes(new Uint8Array(data))
      if (txt.startsWith('uni:')) {
        deliveredUnicasts.push(txt)
      }
    }
  })

  try {
    // Verify per-instance non-extractable ECDH keys (distinct across OverlayManager instances)
    const aliceCrypto1 = await alice.getLocalCryptoIdentity()
    const alice2 = createOverlayManager({
      selfId: 'alice-s5',
      appId: 's5-app',
      roomId: 's5-room-2',
      topology: {mode: 'gossip', maxConnections: 4},
      onVirtualPeerJoin: () => {},
      onVirtualPeerLeave: () => {},
      onDeliverData: () => {}
    })
    const aliceCrypto2 = await alice2.getLocalCryptoIdentity()
    assert.equal(aliceCrypto1.encPrivateKey.extractable, false)
    assert.notDeepEqual(aliceCrypto1.encPubJwk, aliceCrypto2.encPubJwk)
    alice2.destroy()

    const ar = {alive: true}
    const rc = {alive: true}
    const aliceToRelaySniffer: PeerHandle = {
      ...makeOverlayPipe('alice-s5', relay, ar),
      sendData: (d: Uint8Array) => {
        if (d[0] === overlayFrameVersion && d[1] === 2 && !capturedBroadcast) {
          capturedBroadcast = d.slice()
        }
        relay.handleOverlayFrame('alice-s5', d.slice().buffer)
      }
    }
    const relayToCarolSniffer: PeerHandle = {
      ...makeOverlayPipe('relay-s5', carol, rc),
      sendData: (d: Uint8Array) => {
        if (d[0] === overlayFrameVersion && d[1] === 3 && !capturedUnicast) {
          capturedUnicast = d.slice()
        }
        carol.handleOverlayFrame('relay-s5', d.slice().buffer)
      }
    }

    alice.addDirectPeer('relay-s5', aliceToRelaySniffer)
    relay.addDirectPeer('alice-s5', makeOverlayPipe('relay-s5', alice, ar))
    relay.addDirectPeer('carol-s5', relayToCarolSniffer)
    carol.addDirectPeer('relay-s5', makeOverlayPipe('carol-s5', relay, rc))

    await waitFor(() => Boolean(alice.getSnapshot().routes['carol-s5']), 2_000)

    await alice.broadcastInline(encodeBytes('bcast-target'))
    alice.sendUnicast('carol-s5', encodeBytes('uni:secret-1'))
    await waitFor(
      () =>
        deliveredBroadcasts.includes('bcast-target') &&
        deliveredUnicasts.includes('uni:secret-1'),
      2_000
    )
    assert.ok(capturedBroadcast)
    assert.ok(capturedUnicast)

    // Flush seenMsgIds (4,096 FIFO) with 4,150 newer broadcasts from Alice
    for (let i = 0; i < 4_150; i++) {
      await alice.broadcastInline(encodeBytes(`flush-${i}`))
    }

    // Disconnect and reconnect Alice <-> Relay (previously cleared originReplay!)
    relay.removeDirectPeer('alice-s5')
    relay.addDirectPeer('alice-s5', makeOverlayPipe('relay-s5', alice, ar))

    const countBeforeBcast = deliveredBroadcasts.filter(
      x => x === 'bcast-target'
    ).length
    relay.handleOverlayFrame('alice-s5', capturedBroadcast!.slice().buffer)
    carol.handleOverlayFrame('relay-s5', capturedUnicast!.slice().buffer)
    await wait(40)

    assert.equal(
      deliveredBroadcasts.filter(x => x === 'bcast-target').length,
      countBeforeBcast,
      'replayed broadcast after FIFO flush + reconnect must be rejected'
    )
    assert.equal(
      deliveredUnicasts.filter(x => x === 'uni:secret-1').length,
      1,
      'replayed E2E unicast must be rejected'
    )
  } finally {
    alice.destroy()
    relay.destroy()
    carol.destroy()
  }
})

void test('S6: Sybil descriptor flood is capped by room limit before ECDSA verify and cannot bypass activateVirtualPeer', async () => {
  let hostReg: ((peer: PeerHandle, id: string) => void) | null = null
  let attackerReg: ((peer: PeerHandle, id: string) => void) | null = null

  const hostRoom = createRoom(
    f => {
      hostReg = f
    },
    () => {},
    () => {},
    {
      selfId: 'host-s6',
      appId: 's6-app',
      roomId: 's6-room',
      limit: 3,
      use: [scale({mode: 'gossip', maxConnections: 4})]
    }
  )
  const attackerRoom = createRoom(
    f => {
      attackerReg = f
    },
    () => {},
    () => {},
    {
      selfId: 'attacker-s6',
      appId: 's6-app',
      roomId: 's6-room',
      limit: 3,
      use: [scale({mode: 'gossip', maxConnections: 4})]
    }
  )

  try {
    const {peerA, peerB} = linkHandles()
    hostReg!(peerA, 'attacker-s6')
    attackerReg!(peerB, 'host-s6')
    await waitFor(() => 'attacker-s6' in hostRoom.getPeers(), 2_000)

    // Mint 12 distinct valid self-certifying Sybil identities & descriptors claiming mutual edges with attacker-s6
    const sybilDescs: PeerDescriptor[] = []
    const sybilIds: string[] = []
    for (let i = 0; i < 12; i++) {
      const ep = await getDefaultEndpointIdentity(undefined, `s6-sybil-${i}`)
      const usr = await createUserIdentity()
      sybilIds.push(ep.peerId)
      const userProof = toBase64Url(
        await usr.sign(
          userEndpointProofPayload({
            appId: 's6-app',
            roomId: 's6-room',
            peerId: ep.peerId,
            peerPubJwk: ep.signPubJwk,
            seq: 1
          })
        )
      )
      const desc: PeerDescriptor = {
        peerId: ep.peerId,
        seq: 1,
        neighbors: ['attacker-s6'],
        signPubKey: ep.signPubJwk,
        userId: usr.userId,
        userPubKey: usr.signPubJwk,
        userProof
      }
      desc.sig = toBase64(
        await ep.sign(
          encodeBytes(descriptorCanonicalPayload(desc, 's6-app', 's6-room'))
        )
      )
      sybilDescs.push(desc)
    }

    // Also build a valid attacker-s6 descriptor listing all 12 Sybils + host-s6 as neighbors (13 <= maxDescriptorNeighbors)
    const attackerEp = await getDefaultEndpointIdentity('attacker-s6', 's6-app')
    const attackerUsr = await resolveUserIdentity(
      's6-app',
      's6-room',
      undefined,
      'attacker-s6'
    )
    const attackerNeighbors = ['host-s6', ...sybilIds].sort()
    const attackerUserProof = toBase64Url(
      await attackerUsr.sign(
        userEndpointProofPayload({
          appId: 's6-app',
          roomId: 's6-room',
          peerId: 'attacker-s6',
          peerPubJwk: attackerEp.signPubJwk,
          seq: 50
        })
      )
    )
    const attackerDesc: PeerDescriptor = {
      peerId: 'attacker-s6',
      seq: 50,
      neighbors: attackerNeighbors,
      signPubKey: attackerEp.signPubJwk,
      userId: attackerUsr.userId,
      userPubKey: attackerUsr.signPubJwk,
      userProof: attackerUserProof
    }
    attackerDesc.sig = toBase64(
      await attackerEp.sign(
        encodeBytes(
          descriptorCanonicalPayload(attackerDesc, 's6-app', 's6-room')
        )
      )
    )

    // Inject gossip control frames directly over the attacker -> host channel while counting WebCrypto verifies
    const frames = packGossipControlFrames([attackerDesc, ...sybilDescs])
    const hostScale = getRoomSignalingBridge(
      hostRoom
    )!.getScaleProvider()! as unknown as {
      handleOverlayFrame: (fromPeerId: string, data: ArrayBuffer) => void
    }

    const origVerify = crypto.subtle.verify.bind(crypto.subtle)
    let verifyCalls = 0
    crypto.subtle.verify = (async (...args: Parameters<typeof origVerify>) => {
      verifyCalls++
      return origVerify(...args)
    }) as typeof crypto.subtle.verify

    try {
      for (const f of frames) {
        hostScale.handleOverlayFrame('attacker-s6', f.slice().buffer)
      }
      await wait(100)
    } finally {
      crypto.subtle.verify = origVerify
    }

    // Host has limit: 3 (host + attacker + exactly 1 virtual Sybil = 2 remote peers!)
    const admittedRemotePeers = Object.keys(hostRoom.getPeers())
    assert.equal(
      admittedRemotePeers.length,
      2,
      `expected 2 remote peers (attacker + 1 virtual Sybil) under limit=3, got ${admittedRemotePeers.length}`
    )
    // Out of 12 Sybils (24 potential verifies), pre-verify maxUsers cap skips 11 Sybils before ECDSA verify!
    assert.ok(
      verifyCalls <= 6,
      `expected pre-verify cap to limit WebCrypto verify calls to <= 6, got ${verifyCalls}`
    )
  } finally {
    await Promise.all([hostRoom.leave(), attackerRoom.leave()])
  }
})

void test('S7: cross-room broadcast/leave envelopes are rejected and setRoomId evicts pre-resolution descriptors', async () => {
  let capturedRoomXBroadcast: Uint8Array | null = null
  let capturedRoomXLeave: Uint8Array | null = null
  const roomYDelivered: string[] = []
  const roomYLeaves: string[] = []

  const aliceX = createOverlayManager({
    selfId: 'alice-s7',
    appId: 's7-app',
    roomId: 'room-X',
    topology: {mode: 'gossip', maxConnections: 4},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })
  const relayX = createOverlayManager({
    selfId: 'relay-s7',
    appId: 's7-app',
    roomId: 'room-X',
    topology: {mode: 'gossip', maxConnections: 4},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })
  const aliceY = createOverlayManager({
    selfId: 'alice-s7',
    appId: 's7-app',
    roomId: 'room-Y',
    topology: {mode: 'gossip', maxConnections: 4},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })
  const relayY = createOverlayManager({
    selfId: 'relay-s7',
    appId: 's7-app',
    roomId: 'room-Y',
    topology: {mode: 'gossip', maxConnections: 4},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })
  const victimY = createOverlayManager({
    selfId: 'victim-s7',
    appId: 's7-app',
    roomId: 'room-Y',
    topology: {mode: 'gossip', maxConnections: 4},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: id => roomYLeaves.push(id),
    onDeliverData: (_from, d) =>
      roomYDelivered.push(decodeBytes(new Uint8Array(d)))
  })

  try {
    aliceX.addDirectPeer('relay-s7', {
      ...makeOverlayPipe('alice-s7', relayX),
      sendData: (d: Uint8Array) => {
        if (d[0] === overlayFrameVersion && d[1] === 2) {
          capturedRoomXBroadcast = d.slice()
        } else if (d[0] === overlayFrameVersion && d[1] === 1) {
          const hdr = fromJson<{t: string}>(decodeBytes(d.subarray(2)))
          if (hdr.t === 'leave') {
            capturedRoomXLeave = d.slice()
          }
        }
        relayX.handleOverlayFrame('alice-s7', d.slice().buffer)
      }
    })
    relayX.addDirectPeer('alice-s7', makeOverlayPipe('relay-s7', aliceX))

    aliceY.addDirectPeer('relay-s7', makeOverlayPipe('alice-s7', relayY))
    relayY.addDirectPeer('alice-s7', makeOverlayPipe('relay-s7', aliceY))
    relayY.addDirectPeer('victim-s7', makeOverlayPipe('relay-s7', victimY))
    victimY.addDirectPeer('relay-s7', makeOverlayPipe('victim-s7', relayY))

    await waitFor(
      () => Boolean(victimY.getSnapshot().routes['alice-s7']),
      2_000
    )

    await aliceX.broadcastInline(encodeBytes('from-room-X'))
    aliceX.announceLeave()
    await waitFor(
      () => Boolean(capturedRoomXBroadcast && capturedRoomXLeave),
      2_000
    )

    // Relay replays Alice's room-X broadcast and room-X leave into room-Y
    victimY.handleOverlayFrame(
      'relay-s7',
      capturedRoomXBroadcast!.slice().buffer
    )
    victimY.handleOverlayFrame('relay-s7', capturedRoomXLeave!.slice().buffer)
    await wait(50)

    assert.equal(roomYDelivered.includes('from-room-X'), false)
    assert.equal(roomYLeaves.includes('alice-s7'), false)
    assert.ok(victimY.getSnapshot().routes['alice-s7'])

    // Updating roomId via setRoomId evicts descriptors signed for the old roomId
    victimY.setRoomId('room-Y~resolvedFp123456789012')
    assert.equal(victimY.getSnapshot().routes['alice-s7'], undefined)
  } finally {
    aliceX.destroy()
    relayX.destroy()
    aliceY.destroy()
    relayY.destroy()
    victimY.destroy()
  }
})

void test('S8: signaling discovery spam cannot flip established auto mesh, displace verified gossip targets, or trigger unicast flood', async () => {
  let relayForwardedCount = 0
  const nodeA = createOverlayManager({
    selfId: 'node-a',
    appId: 's8-app',
    roomId: 's8-room',
    topology: {mode: 'gossip', maxConnections: 4},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })
  const nodeB = createOverlayManager({
    selfId: 'node-b',
    appId: 's8-app',
    roomId: 's8-room',
    topology: {mode: 'gossip', maxConnections: 4},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })

  try {
    nodeA.addDirectPeer('node-b', {
      ...makeOverlayPipe('node-a', nodeB),
      sendData: d => {
        if (d[0] === overlayFrameVersion && d[1] === 3) {
          relayForwardedCount++
        }
        nodeB.handleOverlayFrame('node-a', d.slice().buffer)
      }
    })
    nodeB.addDirectPeer('node-a', makeOverlayPipe('node-b', nodeA))

    await waitFor(
      () => nodeA.getPeerSignPublicKey('node-b') !== undefined,
      2_000
    )

    // Flood 300 unauthenticated signaling candidates
    for (let i = 0; i < 300; i++) {
      nodeA.notePeerDiscovered(`unverified-spam-${i}`)
      nodeA.shouldConnectPeer(`unverified-spam-${i}`, 'outbound')
    }

    const targets = nodeA.getTargetNeighbors()
    assert.equal(
      targets.has('node-b'),
      true,
      'verified neighbor must remain in getTargetNeighbors'
    )
    for (const t of targets) {
      assert.equal(
        t.startsWith('unverified-spam-'),
        false,
        'unverified signaling spam must not enter converged gossip targets'
      )
    }

    // Unroutable unicast must drop cleanly instead of flooding direct neighbors
    nodeA.sendUnicast('nonexistent-dest', encodeBytes('probe'))
    await wait(30)
    assert.equal(relayForwardedCount, 0)
  } finally {
    nodeA.destroy()
    nodeB.destroy()
  }
})

void test('S9: unauthenticated hsready {ok: false, err: "room full"} before identity verification is ignored', async () => {
  const joinErrors: string[] = []
  let victimReg:
    | ((peer: PeerHandle, id: string) => void | Promise<void>)
    | null = null
  let legitReg:
    | ((peer: PeerHandle, id: string) => void | Promise<void>)
    | null = null

  const victimUser = await createUserIdentity()
  const legitUser = await createUserIdentity()
  const victimEp = await getDefaultEndpointIdentity(undefined, 's9-victim')
  const legitEp = await getDefaultEndpointIdentity(undefined, 's9-legit')
  const spoofEp = await getDefaultEndpointIdentity(undefined, 's9-spoof')

  const makeVerifiedRoom = (
    ep: EndpointIdentity,
    user: Awaited<ReturnType<typeof createUserIdentity>>,
    setReg: (
      fn: (peer: PeerHandle, id: string) => void | Promise<void>
    ) => void,
    recordErr?: (err: string) => void
  ) => {
    let roomRef: Room | null = null
    const idHs = createIdentityHandshake({
      endpointIdentityP: Promise.resolve(ep),
      appId: 's9-app',
      roomId: 's9-room',
      getUserIdentity: async () => user,
      getPeerHandle: pid =>
        getRoomSignalingBridge(roomRef!)?.getPeerHandle(pid),
      onVerified: (pid, verified) => {
        getRoomSignalingBridge(roomRef!)?.onPeerIdentityVerified(pid, verified)
      }
    })
    roomRef = createRoom(
      setReg,
      () => {},
      () => {},
      {
        selfId: ep.peerId,
        endpointIdentityP: Promise.resolve(ep),
        appId: 's9-app',
        roomId: 's9-room',
        limit: 2,
        verifyPeerIdentity: true,
        identity: user,
        onPeerHandshake: idHs.compose(),
        onHandshakeError: (_pid, err) => recordErr?.(err)
      }
    )
    return roomRef
  }

  const victimRoom = makeVerifiedRoom(
    victimEp,
    victimUser,
    f => {
      victimReg = f
    },
    err => joinErrors.push(err)
  )
  const legitRoom = makeVerifiedRoom(legitEp, legitUser, f => {
    legitReg = f
  })

  try {
    // Attacker connects raw WebRTC data channel and immediately sends unauthenticated hsready {ok:false, err:'room full'}
    const {peerA: victimSideSpoof, peerB: attackerRawPeer} = linkHandles()
    void victimReg!(victimSideSpoof, spoofEp.peerId)
    await wait(10)

    // Use a real dummy room without verifyPeerIdentity to emit a wire-encoded hsready {ok:false, err:'room full'} frame over attackerRawPeer
    let dummyReg: ((p: PeerHandle, id: string) => void) | null = null
    const dummyAttacker = createRoom(
      f => {
        dummyReg = f
      },
      () => {},
      () => {},
      {
        selfId: spoofEp.peerId,
        appId: 's9-app',
        roomId: 's9-room',
        limit: 1
      }
    )
    dummyReg!(attackerRawPeer, victimEp.peerId)
    await wait(40)
    await dummyAttacker.leave()

    assert.equal(
      joinErrors.includes('room full'),
      false,
      'unauthenticated room-full hsready must not trigger onJoinError'
    )

    // Legitimate peer connects and completes verified identity handshake cleanly
    const {peerA, peerB} = linkHandles()
    void victimReg!(peerA, legitEp.peerId)
    void legitReg!(peerB, victimEp.peerId)

    await waitFor(() => legitEp.peerId in victimRoom.getPeers(), 2_000)
    assert.equal(joinErrors.includes('room full'), false)
  } finally {
    await Promise.all([victimRoom.leave(), legitRoom.leave()])
  }
})

void test('S10: AuthoritativeStateRecord binds userId in signature and validates userId/updatedBy shapes', async () => {
  const adminUser = await createUserIdentity()
  const otherUser = await createUserIdentity()
  const s10RoomId = `s10-room~${adminUser.fingerprint}`
  const auth = createRoomAuthority({
    selfId: 'admin-ep',
    appId: 's10-app',
    initialRoomId: s10RoomId,
    admin: {selfAsAdmin: true},
    getLocalUserIdentity: async () => adminUser
  })
  await auth.getAuthorityInfo()
  const cert = await auth.issueRoleCertificate(adminUser.userId, ['admin'])

  const rec = await signStateRecord(
    adminUser.sign,
    adminUser.signPubJwk,
    cert,
    {
      appId: 's10-app',
      roomId: s10RoomId,
      namespace: 'score',
      seq: 1,
      epoch: 1,
      prevHash: '0'.repeat(32),
      updatedBy: 'admin-ep',
      userId: adminUser.userId,
      value: {pts: 10}
    }
  )

  const rootFps = new Set([adminUser.fingerprint])
  assert.equal(
    await verifyStateRecord(rec, 's10-app', s10RoomId, ['admin'], rootFps),
    true
  )

  // Rewriting userId or injecting malformed updatedBy fails verification
  assert.equal(
    await verifyStateRecord(
      {...rec, userId: otherUser.userId},
      's10-app',
      s10RoomId,
      ['admin'],
      rootFps
    ),
    false
  )
  assert.equal(
    await verifyStateRecord(
      {...rec, updatedBy: 'bad peer id with spaces!'},
      's10-app',
      s10RoomId,
      ['admin'],
      rootFps
    ),
    false
  )
})

void test('S11: multi-tab admin and multi-tab delegated moderator operate across tabs with zero signature failures', async () => {
  const rootUser = await createUserIdentity()
  const modUser = await createUserIdentity()
  const targetUser = await createUserIdentity()
  const s11RoomId = `s11-room~${rootUser.fingerprint}`

  let sigFailures = 0
  const mkAuth = (
    selfId: string,
    user: Awaited<ReturnType<typeof createUserIdentity>>,
    selfAsAdmin = false
  ) =>
    createRoomAuthority({
      selfId,
      appId: 's11-app',
      initialRoomId: s11RoomId,
      admin: selfAsAdmin ? {selfAsAdmin: true} : {},
      getLocalUserIdentity: async () => user,
      onSignatureFailure: () => {
        sigFailures++
      }
    })

  const rootTab1 = mkAuth('root-tab-1', rootUser, true)
  const rootTab2 = mkAuth('root-tab-2', rootUser, true)
  const modTab1 = mkAuth('mod-tab-1', modUser)
  const modTab2 = mkAuth('mod-tab-2', modUser)
  const observer = mkAuth('observer-1', targetUser)
  await Promise.all([
    rootTab1.getAuthorityInfo(),
    rootTab2.getAuthorityInfo(),
    modTab1.getAuthorityInfo(),
    modTab2.getAuthorityInfo(),
    observer.getAuthorityInfo()
  ])

  // Root Tab 2 grants 'admin' to modUser; Mod Tab 1 receives cert, Mod Tab 2 receives cert and issues ban
  const modCert = await rootTab2.issueRoleCertificate(modUser.userId, ['admin'])
  assert.equal(await modTab1.verifyAndApplyCert(modCert), true)
  assert.equal(await modTab2.verifyAndApplyCert(modCert), true)
  assert.equal(await observer.verifyAndApplyCert(modCert), true)

  const banRec = await modTab2.issuePeerBan(targetUser.userId, {reason: 'test'})
  assert.equal(await observer.verifyAndApplyBan(banRec), true)
  assert.equal(observer.isPeerBanned(targetUser.userId), true)
  assert.equal(sigFailures, 0)
})

void test('S12: concurrent mutual bans/revocations between two delegated admins converge regardless of arrival order', async () => {
  const rootUser = await createUserIdentity()
  const adminA = await createUserIdentity()
  const adminB = await createUserIdentity()
  const observer1User = await createUserIdentity()
  const observer2User = await createUserIdentity()
  const s12RoomId = `s12-room~${rootUser.fingerprint}`

  const mk = (
    selfId: string,
    user: Awaited<ReturnType<typeof createUserIdentity>>,
    selfAsAdmin = false
  ) =>
    createRoomAuthority({
      selfId,
      appId: 's12-app',
      initialRoomId: s12RoomId,
      admin: selfAsAdmin ? {selfAsAdmin: true} : {},
      getLocalUserIdentity: async () => user
    })

  const root = mk('root-ep', rootUser, true)
  const authA = mk('admin-a', adminA)
  const authB = mk('admin-b', adminB)
  const obs1 = mk('obs-1', observer1User)
  const obs2 = mk('obs-2', observer2User)
  await Promise.all([
    root.getAuthorityInfo(),
    authA.getAuthorityInfo(),
    authB.getAuthorityInfo(),
    obs1.getAuthorityInfo(),
    obs2.getAuthorityInfo()
  ])

  const certA = await root.issueRoleCertificate(adminA.userId, ['admin'])
  const certB = await root.issueRoleCertificate(adminB.userId, ['admin'])
  for (const node of [authA, authB, obs1, obs2]) {
    await node.verifyAndApplyCert(certA)
    await node.verifyAndApplyCert(certB)
  }

  // Admin A bans Admin B first (earlier timestamp), Admin B concurrently bans Admin A (later timestamp)
  const banB = await authA.issuePeerBan(adminB.userId, {reason: 'first'})
  await wait(5)
  const banA = await authB.issuePeerBan(adminA.userId, {reason: 'second'})

  // Observer 1 sees (banB, then banA); Observer 2 sees (banA, then banB)!
  await obs1.verifyAndApplyBan(banB)
  await obs1.verifyAndApplyBan(banA)

  await obs2.verifyAndApplyBan(banA)
  await obs2.verifyAndApplyBan(banB)

  assert.equal(
    obs1.isPeerBanned(adminA.userId),
    obs2.isPeerBanned(adminA.userId)
  )
  assert.equal(
    obs1.isPeerBanned(adminB.userId),
    obs2.isPeerBanned(adminB.userId)
  )
  assert.equal(obs1.isPeerBanned(adminB.userId), true)
  assert.equal(obs1.isPeerBanned(adminA.userId), false)
})

void test('S13: garbage sync flood kicks abusive peer after <= 8 failures and chunked role-gated actions verify signature once', async () => {
  const adminUser = await createUserIdentity()
  const attackerUser = await createUserIdentity()

  let hostReg: ((p: PeerHandle, id: string) => void) | null = null
  let atkReg: ((p: PeerHandle, id: string) => void) | null = null

  const hostRoom = createRoom(
    f => {
      hostReg = f
    },
    () => {},
    () => {},
    {
      selfId: 'host-s13',
      appId: 's13-app',
      roomId: 's13-fixed-room',
      identity: adminUser,
      use: [roles({admins: [adminUser.userId]})]
    }
  )
  const rawAuthProbe = definePlugin('rawAuthProbe', {
    setup: kernel => ({
      sendAuth: kernel.makeInternalAction<JsonValue>('auth').send
    })
  })
  const atkRoom = createRoom(
    f => {
      atkReg = f
    },
    () => {},
    () => {},
    {
      selfId: 'atk-s13',
      appId: 's13-app',
      roomId: 's13-fixed-room',
      identity: attackerUser,
      use: [rawAuthProbe]
    }
  )

  try {
    const {peerA, peerB} = linkHandles()
    hostReg!(peerA, 'atk-s13')
    atkReg!(peerB, 'host-s13')
    await waitFor(() => 'atk-s13' in hostRoom.getPeers(), 2_000)

    // Send a sync message containing 50 garbage certs from atkRoom over internal 'auth' action
    const garbageCerts = Array.from({length: 50}, (_, i) => ({
      v: 1,
      certId: `bad-${i}`,
      appId: 'wrong-app',
      roomId: 's13-fixed-room',
      subUserId: attackerUser.userId,
      issUserId: adminUser.userId,
      issPubKey: adminUser.signPubJwk,
      roles: ['admin'],
      iat: Date.now(),
      sig: 'A'.repeat(86)
    }))
    await atkRoom
      .sendAuth({t: 'sync', certs: garbageCerts} as unknown as JsonValue)
      .catch(() => {})

    await waitFor(() => !('atk-s13' in hostRoom.getPeers()), 2_000)
    assert.equal('atk-s13' in hostRoom.getPeers(), false)

    // Also verify verifiedActionSigCache deduplicates ECDSA signature verification between offer and payload
    const receiverUser = await createUserIdentity()
    const senderEp = await getDefaultEndpointIdentity(undefined, 's13-sender')
    const recvEp = await getDefaultEndpointIdentity(undefined, 's13-recv')
    let r1Reg: ((p: PeerHandle, id: string) => void | Promise<void>) | null =
      null
    let r2Reg: ((p: PeerHandle, id: string) => void | Promise<void>) | null =
      null
    const s13RoomId = `s13-room~${adminUser.fingerprint}`
    let senderRoomRef: Room | null = null
    let receiverRoomRef: Room | null = null
    const senderHs = createIdentityHandshake({
      endpointIdentityP: Promise.resolve(senderEp),
      appId: 's13-app',
      roomId: s13RoomId,
      getUserIdentity: async () => adminUser,
      getPeerHandle: pid =>
        getRoomSignalingBridge(senderRoomRef!)?.getPeerHandle(pid),
      onVerified: (pid, v) =>
        getRoomSignalingBridge(senderRoomRef!)?.onPeerIdentityVerified(pid, v)
    })
    const recvHs = createIdentityHandshake({
      endpointIdentityP: Promise.resolve(recvEp),
      appId: 's13-app',
      roomId: s13RoomId,
      getUserIdentity: async () => receiverUser,
      getPeerHandle: pid =>
        getRoomSignalingBridge(receiverRoomRef!)?.getPeerHandle(pid),
      onVerified: (pid, v) =>
        getRoomSignalingBridge(receiverRoomRef!)?.onPeerIdentityVerified(pid, v)
    })
    const senderRoom = createRoom(
      f => {
        r1Reg = f
      },
      () => {},
      () => {},
      {
        selfId: senderEp.peerId,
        endpointIdentityP: Promise.resolve(senderEp),
        appId: 's13-app',
        roomId: s13RoomId,
        verifyPeerIdentity: true,
        identity: adminUser,
        onPeerHandshake: senderHs.compose(),
        use: [roles({selfAsAdmin: true})]
      }
    )
    senderRoomRef = senderRoom
    const receiverRoom = createRoom(
      f => {
        r2Reg = f
      },
      () => {},
      () => {},
      {
        selfId: recvEp.peerId,
        endpointIdentityP: Promise.resolve(recvEp),
        appId: 's13-app',
        roomId: s13RoomId,
        verifyPeerIdentity: true,
        identity: receiverUser,
        onPeerHandshake: recvHs.compose(),
        use: [roles()]
      }
    )
    receiverRoomRef = receiverRoom
    const senderBig = senderRoom.makeAction<Uint8Array>('big-act', {
      roles: ['admin']
    })
    let gotBytes = 0
    const recvBig = receiverRoom.makeAction<Uint8Array>('big-act', {
      roles: ['admin']
    })
    recvBig.onMessage = data => {
      gotBytes = data.byteLength
    }

    const {peerA: p1, peerB: p2} = linkHandles()
    void r1Reg!(p1, recvEp.peerId)
    void r2Reg!(p2, senderEp.peerId)
    await waitFor(() => recvEp.peerId in senderRoom.getPeers(), 2_000)
    await waitFor(
      () => receiverRoom.getRoles(senderEp.peerId).includes('admin'),
      2_000
    )

    const origVerify = crypto.subtle.verify.bind(crypto.subtle)
    let verifyCount = 0
    crypto.subtle.verify = (async (...args: Parameters<typeof origVerify>) => {
      verifyCount++
      return origVerify(...args)
    }) as typeof crypto.subtle.verify

    try {
      const payload = new Uint8Array(40 * 1024).fill(7) // multi-chunk (> 16 KiB)
      await senderBig.send(payload)
      await waitFor(() => gotBytes === payload.byteLength, 2_000)
      // Cert cached + action sig verified once at offer, cached on final payload => <= 2 verify calls total
      assert.ok(
        verifyCount <= 2,
        `expected <= 2 WebCrypto verify calls for chunked role action, got ${verifyCount}`
      )
    } finally {
      crypto.subtle.verify = origVerify
      await Promise.all([senderRoom.leave(), receiverRoom.leave()])
    }
  } finally {
    await Promise.all([hostRoom.leave(), atkRoom.leave()])
  }
})

void test('S14: signal-handler drops invalid peerIds before allocating peerStates and hashTopic cache is bounded', async () => {
  const peerStates: Record<string, unknown> = {}
  const receive = createSignalHandler({
    appId: 's14-app',
    roomId: 's14-room',
    config: {appId: 's14-app'},
    peerStates: peerStates as never,
    rootTopicPlaintext: 'root',
    rootTopicP: Promise.resolve('root'),
    selfTopicP: Promise.resolve('self'),
    toPlain: async s => s,
    toCipher: async s => s,
    encryptOffer: async () => 'enc',
    isLeaving: () => false,
    offerManager: {
      checkout: async () => [],
      claimLeased: () => {},
      reclaimLeased: () => {}
    } as never,
    initPeer: (() => ({})) as never,
    connectPeer: () => {},
    disconnectPeer: () => {},
    announceIntervals: [],
    announceIntervalMs: 5_000,
    selfId: 'K'.repeat(20),
    onJoinError: undefined
  })(0)

  const invalidIds = [
    '',
    'has spaces',
    'control\x00char',
    'slash/id',
    'x'.repeat(100)
  ]
  for (const badId of invalidIds) {
    await receive('root', {peerId: badId}, () => {})
  }
  assert.equal(Object.keys(peerStates).length, 0)

  // Verify hashTopic bounded cache produces accurate 256-bit SHA-256 base64url digests past 4,096 distinct inputs
  const first = await hashTopic('s14-bound-0')
  assert.match(first, /^[A-Za-z0-9_-]{43}$/)
  for (let i = 1; i <= 4_200; i++) {
    await hashTopic(`s14-bound-${i}`)
  }
  assert.equal(await hashTopic('s14-bound-0'), first)
})

void test('S15: undecryptable offers allocate 0 RTCPeerConnections and announce floods cap pending PCs at maxPendingPeerConnections', async t => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date']})
  let allocatedPcs = 0
  let livePcs = 0
  let leaving = false

  const makeMockPeer = (): PeerHandle => {
    allocatedPcs++
    livePcs++
    let dead = false
    return {
      get isDead() {
        return dead
      },
      connection: {} as RTCPeerConnection,
      channel: null,
      getOffer: async () => ({type: 'offer', sdp: 'v=0'}),
      signal: async () => undefined,
      sendData: () => {},
      destroy: () => {
        if (!dead) {
          dead = true
          livePcs--
        }
      },
      setHandlers: () => {},
      addStream: () => {},
      removeStream: () => {},
      addTrack: () => ({}) as never,
      removeTrack: () => {},
      replaceTrack: async () => {}
    }
  }

  const peerStates: Record<string, unknown> = {}
  const receive = createSignalHandler({
    appId: 's15-app',
    roomId: 's15-room',
    config: {appId: 's15-app'},
    peerStates: peerStates as never,
    rootTopicPlaintext: 'root',
    rootTopicP: Promise.resolve('root'),
    selfTopicP: Promise.resolve('self'),
    toPlain: async () => {
      throw new Error('decrypt failed')
    },
    toCipher: async s => s,
    encryptOffer: async () => 'enc-offer',
    isLeaving: () => leaving,
    offerManager: {
      checkout: async () => [
        {peer: makeMockPeer(), offer: 'enc-offer', offerId: 'offer-id-1234'}
      ],
      claimLeased: () => {},
      reclaimLeased: () => {}
    } as never,
    initPeer: makeMockPeer as never,
    connectPeer: () => {},
    disconnectPeer: () => {},
    announceIntervals: [],
    announceIntervalMs: 60_000,
    selfId: '0'.repeat(20),
    onJoinError: undefined
  })(0)

  // 1. 50 undecryptable offers must allocate ZERO answer RTCPeerConnections
  for (let i = 0; i < 50; i++) {
    await receive(
      'self',
      {
        peerId: `OfferAtk${String(i).padStart(12, '0')}`,
        offerId: `offer-id-${String(i).padStart(6, '0')}`,
        offer: 'garbage-ciphertext'
      },
      () => {}
    )
  }
  assert.equal(allocatedPcs, 0)

  // 2. 150 unauthenticated announces from higher-ID peers cap live pending PCs at <= maxPendingPeerConnections (64)
  for (let i = 0; i < 150; i++) {
    await receive(
      'root',
      {peerId: `ZAnnounce${String(i).padStart(11, '0')}`},
      () => {}
    )
  }
  assert.ok(
    livePcs <= maxPendingPeerConnections,
    `expected live pending PCs <= ${maxPendingPeerConnections}, got ${livePcs}`
  )
  leaving = true
  t.mock.timers.tick(120_000)
})

void test('S16: corrupt IndexedDB identity record is validated and repaired via put', async () => {
  const prevWindow = (globalThis as Record<string, unknown>).window
  const prevIdb = (globalThis as Record<string, unknown>).indexedDB
  const storeMap = new Map<string, unknown>()
  let putCalls = 0

  // Seed storeMap with a corrupt record whose userId does NOT match its signPubJwk
  const keyPair = await crypto.subtle.generateKey(ecdsaKeyAlgo, false, [
    'sign',
    'verify'
  ])
  const signPubJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
  const otherUser = await createUserIdentity()
  storeMap.set('s16-corrupt-app', {
    userId: otherUser.userId,
    signPubJwk,
    privateKey: keyPair.privateKey,
    createdAt: Date.now()
  })

  const mockIdb = {
    open: () => {
      const req: Record<string, unknown> = {result: null}
      queueMicrotask(() => {
        req.result = {
          objectStoreNames: {contains: () => true},
          close: () => {},
          transaction: () => ({
            objectStore: () => ({
              get: (k: string) => {
                const r: Record<string, unknown> = {result: storeMap.get(k)}
                queueMicrotask(() => (r.onsuccess as () => void)?.())
                return r
              },
              put: (val: unknown, k: string) => {
                putCalls++
                storeMap.set(k, val)
                const r: Record<string, unknown> = {result: k}
                queueMicrotask(() => (r.onsuccess as () => void)?.())
                return r
              },
              add: (val: unknown, k: string) => {
                storeMap.set(k, val)
                const r: Record<string, unknown> = {result: k}
                queueMicrotask(() => (r.onsuccess as () => void)?.())
                return r
              }
            })
          })
        }
        ;(req.onsuccess as () => void)?.()
      })
      return req
    }
  }

  ;(globalThis as Record<string, unknown>).window = globalThis
  ;(globalThis as Record<string, unknown>).indexedDB = mockIdb

  try {
    const resolved = await resolveUserIdentity('s16-corrupt-app', 'room-1', {
      identity: 'local'
    })
    assert.equal(putCalls, 1)
    assert.notEqual(resolved.userId, otherUser.userId)
    assert.equal(
      await verifyUserIdKey(resolved.userId, resolved.signPubJwk),
      true
    )
    assert.equal(resolved.persisted, true)
    assert.equal(resolved.persistence, 'local')
  } finally {
    if (prevWindow === undefined) {
      delete (globalThis as Record<string, unknown>).window
    } else {
      ;(globalThis as Record<string, unknown>).window = prevWindow
    }
    if (prevIdb === undefined) {
      delete (globalThis as Record<string, unknown>).indexedDB
    } else {
      ;(globalThis as Record<string, unknown>).indexedDB = prevIdb
    }
  }
})

void test('S17: high-S P-256 signatures are rejected and revocation dedupe is immune to signature malleability', async () => {
  const kp = await crypto.subtle.generateKey(ecdsaKeyAlgo, true, [
    'sign',
    'verify'
  ])
  const pubJwk = await crypto.subtle.exportKey('jwk', kp.publicKey)
  const msg = encodeBytes('malleability-check')

  const lowSig = await ecdsaSign(kp.privateKey, msg as BufferSource)
  assert.equal(isLowSP256Signature(lowSig), true)
  assert.equal(await verifyWithP256(lowSig, msg, pubJwk), true)

  // Construct malleable high-S twin (r, n - s), which raw WebCrypto accepts but verifyWithP256 must reject
  let s = 0n
  for (let i = 32; i < 64; i++) {
    s = (s << 8n) | BigInt(lowSig[i]!)
  }
  let highS = p256N - s
  const highSig = lowSig.slice()
  for (let i = 63; i >= 32; i--) {
    highSig[i] = Number(highS & 0xffn)
    highS >>= 8n
  }
  assert.equal(isLowSP256Signature(highSig), false)
  assert.equal(
    await crypto.subtle.verify(
      ecdsaSignAlgo,
      kp.publicKey,
      highSig as BufferSource,
      msg as BufferSource
    ),
    true
  )
  assert.equal(await verifyWithP256(highSig, msg, pubJwk), false)

  // Verify RoleRevocationRecord also rejects high-S and deduplicates by content
  const rootUser = await createUserIdentity()
  const targetUser = await createUserIdentity()
  const s17RoomId = `s17-room~${rootUser.fingerprint}`
  const auth = createRoomAuthority({
    selfId: 'root-s17',
    appId: 's17-app',
    initialRoomId: s17RoomId,
    admin: {selfAsAdmin: true},
    getLocalUserIdentity: async () => rootUser
  })
  await auth.getAuthorityInfo()
  const rootCert = await auth.issueRoleCertificate(rootUser.userId, ['admin'])
  const rev = await signRoleRevocation(
    rootUser.sign,
    rootUser.signPubJwk,
    rootCert,
    {
      appId: 's17-app',
      roomId: s17RoomId,
      issuerUserId: rootUser.userId,
      targetUserId: targetUser.userId,
      role: 'dj',
      seq: 1
    }
  )
  const rawRevBytes = fromBase64Url(rev.sig)
  let revS = 0n
  for (let i = 32; i < 64; i++) {
    revS = (revS << 8n) | BigInt(rawRevBytes[i]!)
  }
  let revHighS = p256N - revS
  const highRevBytes = rawRevBytes.slice()
  for (let i = 63; i >= 32; i--) {
    highRevBytes[i] = Number(revHighS & 0xffn)
    revHighS >>= 8n
  }
  const malleableRev = {...rev, sig: toBase64Url(highRevBytes)}

  assert.equal(
    await verifyRoleRevocation(
      malleableRev,
      's17-app',
      s17RoomId,
      new Set([rootUser.fingerprint])
    ),
    false
  )
  assert.equal(await auth.verifyAndApplyRevocation(rev), true)
  assert.equal(await auth.verifyAndApplyRevocation(rev), false)
  assert.equal(await auth.verifyAndApplyRevocation(malleableRev), false)
})

void test('D1: genKey uses 600k-iteration PBKDF2-SHA256 for passwords with appId/roomId domain separation', async () => {
  const k1 = genKey('CorrectHorseBatteryStaple!', 'd1-app', 'room-a')
  const kSame = genKey('CorrectHorseBatteryStaple!', 'd1-app', 'room-a')
  const kDiffRoom = genKey('CorrectHorseBatteryStaple!', 'd1-app', 'room-b')
  const kLegacySha256 = crypto.subtle.importKey(
    'raw',
    (await sha256('CorrectHorseBatteryStaple!:d1-app:room-a')) as BufferSource,
    {name: 'AES-GCM'},
    false,
    ['encrypt', 'decrypt']
  )

  const ct = await encrypt(k1, 'secret-sdp', 'offer|peer1|oid1')
  assert.equal(await decrypt(kSame, ct, 'offer|peer1|oid1'), 'secret-sdp')
  await assert.rejects(() => decrypt(kDiffRoom, ct, 'offer|peer1|oid1'))
  // Confirm key is NOT the legacy single unsalted SHA-256 digest
  await assert.rejects(() => decrypt(kLegacySha256, ct, 'offer|peer1|oid1'))
})

void test('D2: signaling ciphertexts bind type|peerId|offerId via AAD and reject missing offerId', async () => {
  const keyP = genKey('room-pw', 'd2-app', 'd2-room')
  const offerAad = buildSignalAad('offer', 'PeerAlice12345678901', 'offer-0001')
  const ct = await encrypt(keyP, 'v=0\r\no=alice', offerAad)

  // Replaying an offer ciphertext as an answer, for another peerId, or with another offerId fails GCM authentication
  await assert.rejects(() =>
    decrypt(
      keyP,
      ct,
      buildSignalAad('answer', 'PeerAlice12345678901', 'offer-0001')
    )
  )
  await assert.rejects(() =>
    decrypt(
      keyP,
      ct,
      buildSignalAad('offer', 'PeerVictim1234567890', 'offer-0001')
    )
  )
  await assert.rejects(() =>
    decrypt(
      keyP,
      ct,
      buildSignalAad('offer', 'PeerAlice12345678901', 'offer-0002')
    )
  )

  // Signal handler drops offers/answers/candidates missing offerId before calling toPlain
  let toPlainCalls = 0
  const receive = createSignalHandler({
    appId: 'd2-app',
    roomId: 'd2-room',
    config: {appId: 'd2-app'},
    peerStates: {} as never,
    rootTopicPlaintext: 'root',
    rootTopicP: Promise.resolve('root'),
    selfTopicP: Promise.resolve('self'),
    toPlain: async (s: Signal) => {
      toPlainCalls++
      return s
    },
    toCipher: async s => s,
    encryptOffer: async () => 'enc',
    isLeaving: () => false,
    offerManager: {
      checkout: async () => [],
      claimLeased: () => {},
      reclaimLeased: () => {}
    } as never,
    initPeer: (() => ({})) as never,
    connectPeer: () => {},
    disconnectPeer: () => {},
    announceIntervals: [],
    announceIntervalMs: 5_000,
    selfId: 'K'.repeat(20),
    onJoinError: undefined
  })(0)

  await receive('self', {peerId: 'L'.repeat(20), offer: ct}, () => {})
  await receive('self', {peerId: 'L'.repeat(20), answer: ct}, () => {})
  await receive('self', {peerId: 'L'.repeat(20), candidate: ct}, () => {})
  assert.equal(toPlainCalls, 0)
})

void test('D3: createIdentityHandshake fails closed when peer.connection lacks SDP DTLS fingerprints', async () => {
  const user = await createUserIdentity()
  const epA = await getDefaultEndpointIdentity(undefined, 'd3-app-a')
  const epB = await getDefaultEndpointIdentity(undefined, 'd3-app-b')

  const fingerprintlessPeer = {
    connection: {
      localDescription: {type: 'offer', sdp: 'v=0\r\ns=-\r\n'},
      remoteDescription: {type: 'answer', sdp: 'v=0\r\ns=-\r\n'}
    }
  } as unknown as PeerHandle

  const hs = createIdentityHandshake({
    endpointIdentityP: Promise.resolve(epA),
    appId: 'd3-app',
    roomId: 'd3-room',
    getUserIdentity: async () => user,
    getPeerHandle: () => fingerprintlessPeer
  })

  await assert.rejects(
    () =>
      hs.run(
        epB.peerId,
        async () => {},
        async () => ({data: {}}),
        true
      ),
    /DTLS fingerprint missing/
  )
})

void test('D5: peerId grinding by a single userId cannot eclipse all target slots of an honest peer', async () => {
  const honestIds = Array.from(
    {length: 16},
    (_, i) => `honest-${String(i).padStart(2, '0')}`
  )
  const victim = createOverlayManager({
    selfId: honestIds[0]!,
    appId: 'd5-app',
    roomId: 'd5-room',
    topology: {mode: 'gossip', maxConnections: 6},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })

  try {
    const dummyRelay = createOverlayManager({
      selfId: honestIds[1]!,
      appId: 'd5-app',
      roomId: 'd5-room',
      topology: {mode: 'gossip', maxConnections: 6},
      onVirtualPeerJoin: () => {},
      onVirtualPeerLeave: () => {},
      onDeliverData: () => {}
    })
    victim.addDirectPeer(
      honestIds[1]!,
      makeOverlayPipe(honestIds[0]!, dummyRelay)
    )

    const descriptors: PeerDescriptor[] = []
    for (let i = 1; i < honestIds.length; i++) {
      const id = honestIds[i]!
      const ep = await getDefaultEndpointIdentity(id, 'd5-app')
      const u = await createUserIdentity()
      const userProof = toBase64Url(
        await u.sign(
          userEndpointProofPayload({
            appId: 'd5-app',
            roomId: 'd5-room',
            peerId: id,
            peerPubJwk: ep.signPubJwk,
            seq: 1
          })
        )
      )
      const desc: PeerDescriptor = {
        peerId: id,
        seq: 1,
        neighbors: [honestIds[0]!],
        signPubKey: ep.signPubJwk,
        userId: u.userId,
        userPubKey: u.signPubJwk,
        userProof
      }
      desc.sig = toBase64(
        await ep.sign(
          encodeBytes(descriptorCanonicalPayload(desc, 'd5-app', 'd5-room'))
        )
      )
      descriptors.push(desc)
    }

    // One attacker userId mints 14 Sybil endpoints (maxPeersPerUser is 16)
    const sybilOwner = await createUserIdentity()
    const sybilIds: string[] = []
    for (let i = 0; i < 14; i++) {
      const ep = await getDefaultEndpointIdentity(undefined, `d5-sybil-${i}`)
      sybilIds.push(ep.peerId)
      const userProof = toBase64Url(
        await sybilOwner.sign(
          userEndpointProofPayload({
            appId: 'd5-app',
            roomId: 'd5-room',
            peerId: ep.peerId,
            peerPubJwk: ep.signPubJwk,
            seq: 1
          })
        )
      )
      const desc: PeerDescriptor = {
        peerId: ep.peerId,
        seq: 1,
        neighbors: [honestIds[1]!],
        signPubKey: ep.signPubJwk,
        userId: sybilOwner.userId,
        userPubKey: sybilOwner.signPubJwk,
        userProof
      }
      desc.sig = toBase64(
        await ep.sign(
          encodeBytes(descriptorCanonicalPayload(desc, 'd5-app', 'd5-room'))
        )
      )
      descriptors.push(desc)
    }

    for (const pkt of packGossipControlFrames(descriptors)) {
      victim.handleOverlayFrame(honestIds[1]!, pkt.slice().buffer)
    }
    await wait(80)

    const verifiedCount = [...honestIds.slice(1), ...sybilIds].filter(id =>
      Boolean(victim.getPeerSignPublicKey(id))
    ).length
    assert.ok(
      verifiedCount >= 25,
      `honest + Sybil descriptors must be verified and stored, got ${verifiedCount}`
    )

    const targets = victim.getTargetNeighbors()
    const sybilTargetCount = [...targets].filter(id =>
      sybilIds.includes(id)
    ).length
    assert.ok(
      sybilTargetCount <= 2,
      `single userId must occupy at most floor(maxConnections/3)=2 target slots, got ${sybilTargetCount}`
    )
    assert.ok(
      [...targets].some(id => honestIds.includes(id)),
      'victim must retain honest peers in target neighbors'
    )
    dummyRelay.destroy()
  } finally {
    victim.destroy()
  }
})

void test('D7: maxClockSkewMs configures clock tolerance and makeState causal epoch supersedes stale pre-rejoin state', async () => {
  const adminUser = await createUserIdentity()
  const guestUser = await createUserIdentity()
  const d7RoomId = `d7-room~${adminUser.fingerprint}`

  const strictGuest = createRoomAuthority({
    selfId: 'strict-guest',
    appId: 'd7-app',
    initialRoomId: d7RoomId,
    admin: {},
    getLocalUserIdentity: async () => guestUser
  })
  const tolerantGuest = createRoomAuthority({
    selfId: 'tolerant-guest',
    appId: 'd7-app',
    initialRoomId: d7RoomId,
    admin: {maxClockSkewMs: 300_000},
    getLocalUserIdentity: async () => guestUser
  })
  const adminSession1 = createRoomAuthority({
    selfId: 'admin-s1',
    appId: 'd7-app',
    initialRoomId: d7RoomId,
    admin: {selfAsAdmin: true},
    getLocalUserIdentity: async () => adminUser
  })
  await Promise.all([
    strictGuest.getAuthorityInfo(),
    tolerantGuest.getAuthorityInfo(),
    adminSession1.getAuthorityInfo()
  ])

  const adminCert = await adminSession1.issueRoleCertificate(adminUser.userId, [
    'admin'
  ])
  const futureRec = await signStateRecord(
    adminUser.sign,
    adminUser.signPubJwk,
    adminCert,
    {
      appId: 'd7-app',
      roomId: d7RoomId,
      namespace: 'clock',
      seq: 1,
      epoch: 10,
      prevHash: '0'.repeat(32),
      ts: Date.now() + 180_000,
      updatedBy: 'admin-s1',
      userId: adminUser.userId,
      value: 'skewed-ok'
    }
  )
  assert.equal(await strictGuest.verifyAndApplyStateRecord(futureRec), false)
  assert.equal(await tolerantGuest.verifyAndApplyStateRecord(futureRec), true)

  // Session 1 reaches seq = 5, then admin reloads/rejoins as Session 2 (seq restarts at 1, higher causal epoch!)
  const staleHighSeq: AuthoritativeStateRecord[] = []
  const stateS1 = adminSession1.makeState('phase', 'init', undefined, rec =>
    staleHighSeq.push(rec)
  )
  for (let i = 1; i <= 5; i++) {
    await stateS1.set(`s1-step-${i}`)
  }
  const s1Final = staleHighSeq.at(-1)!
  assert.equal(s1Final.seq, 5)
  assert.equal(await tolerantGuest.verifyAndApplyStateRecord(s1Final), true)

  await wait(5)
  const adminSession2 = createRoomAuthority({
    selfId: 'admin-s2',
    appId: 'd7-app',
    initialRoomId: d7RoomId,
    admin: {selfAsAdmin: true},
    getLocalUserIdentity: async () => adminUser
  })
  await adminSession2.getAuthorityInfo()
  const s2Published: AuthoritativeStateRecord[] = []
  const stateS2 = adminSession2.makeState('phase', 'init', undefined, rec =>
    s2Published.push(rec)
  )
  await stateS2.set('fresh-after-rejoin')
  const s2First = s2Published[0]!
  assert.equal(s2First.seq, 1)
  assert.ok(compareStateRecords(s2First, s1Final) > 0)
  assert.equal(await tolerantGuest.verifyAndApplyStateRecord(s2First), true)
  // Replaying held old seq=5 record cannot override fresh rejoined epoch
  assert.equal(await tolerantGuest.verifyAndApplyStateRecord(s1Final), false)
})

void test('D8: transient 250ms route churn does not flap virtual peer membership under default 1200ms unreachableGraceMs', async () => {
  const virtualLeaves: string[] = []
  const virtualJoins: string[] = []

  // Topology: alice <-> relay1 <-> relay2 <-> bob (so relay1 <-> relay2 drop is non-direct to alice)
  const alice = createOverlayManager({
    selfId: 'alice-d8',
    appId: 'd8-app',
    roomId: 'd8-room',
    topology: {mode: 'gossip', maxConnections: 4},
    onVirtualPeerJoin: id => virtualJoins.push(id),
    onVirtualPeerLeave: id => virtualLeaves.push(id),
    onDeliverData: () => {}
  })
  const relay1 = createOverlayManager({
    selfId: 'relay1-d8',
    appId: 'd8-app',
    roomId: 'd8-room',
    topology: {mode: 'gossip', maxConnections: 4},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })
  const relay2 = createOverlayManager({
    selfId: 'relay2-d8',
    appId: 'd8-app',
    roomId: 'd8-room',
    topology: {mode: 'gossip', maxConnections: 4},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })
  const bob = createOverlayManager({
    selfId: 'bob-d8',
    appId: 'd8-app',
    roomId: 'd8-room',
    topology: {mode: 'gossip', maxConnections: 4},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })

  try {
    alice.addDirectPeer('relay1-d8', makeOverlayPipe('alice-d8', relay1))
    relay1.addDirectPeer('alice-d8', makeOverlayPipe('relay1-d8', alice))
    const r12 = {alive: true}
    relay1.addDirectPeer('relay2-d8', makeOverlayPipe('relay1-d8', relay2, r12))
    relay2.addDirectPeer('relay1-d8', makeOverlayPipe('relay2-d8', relay1, r12))
    relay2.addDirectPeer('bob-d8', makeOverlayPipe('relay2-d8', bob))
    bob.addDirectPeer('relay2-d8', makeOverlayPipe('bob-d8', relay2))

    await waitFor(() => virtualJoins.includes('bob-d8'), 2_000)

    // Drop relay1 <-> relay2 for 250ms (> old 80ms grace, < new 1,200ms grace), then heal
    r12.alive = false
    relay1.removeDirectPeer('relay2-d8')
    relay2.removeDirectPeer('relay1-d8')
    await wait(250)

    assert.equal(
      virtualLeaves.includes('bob-d8'),
      false,
      'bob-d8 must not flap during 250ms multi-hop route reconvergence'
    )

    const r12Healed = {alive: true}
    relay1.addDirectPeer(
      'relay2-d8',
      makeOverlayPipe('relay1-d8', relay2, r12Healed)
    )
    relay2.addDirectPeer(
      'relay1-d8',
      makeOverlayPipe('relay2-d8', relay1, r12Healed)
    )
    await waitFor(() => Boolean(alice.getSnapshot().routes['bob-d8']), 2_000)
    assert.equal(virtualLeaves.includes('bob-d8'), false)
  } finally {
    alice.destroy()
    relay1.destroy()
    relay2.destroy()
    bob.destroy()
  }
})

void test('D9: virtual PeerHandle exposes backpressure, fails over to backupNextHop, and amortizes unicast stream signatures via lease', async () => {
  let virtualDestHandle: PeerHandle | null = null
  const received: string[] = []
  let viaRelay1 = 0
  let viaRelay2 = 0

  const src = createOverlayManager({
    selfId: 'src-d9',
    appId: 'd9-app',
    roomId: 'd9-room',
    topology: {mode: 'gossip', maxConnections: 4},
    onVirtualPeerJoin: (id, vp) => {
      if (id === 'dst-d9') {
        virtualDestHandle = vp
      }
    },
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })
  const relay1 = createOverlayManager({
    selfId: 'relay1-d9',
    appId: 'd9-app',
    roomId: 'd9-room',
    topology: {mode: 'gossip', maxConnections: 4},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })
  const relay2 = createOverlayManager({
    selfId: 'relay2-d9',
    appId: 'd9-app',
    roomId: 'd9-room',
    topology: {mode: 'gossip', maxConnections: 4},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })
  const dst = createOverlayManager({
    selfId: 'dst-d9',
    appId: 'd9-app',
    roomId: 'd9-room',
    topology: {mode: 'gossip', maxConnections: 4},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: (_from, d) => received.push(decodeBytes(new Uint8Array(d)))
  })

  try {
    const r1State = {alive: true, bufferedAmount: 0}
    const r2State = {alive: true, bufferedAmount: 1_024}

    src.addDirectPeer(
      'relay1-d9',
      makeOverlayPipe('src-d9', relay1, r1State, d => {
        if (d[0] === overlayFrameVersion && d[1] === 3) {
          viaRelay1++
        }
      })
    )
    relay1.addDirectPeer('src-d9', makeOverlayPipe('relay1-d9', src))
    relay1.addDirectPeer('dst-d9', makeOverlayPipe('relay1-d9', dst))
    dst.addDirectPeer('relay1-d9', makeOverlayPipe('dst-d9', relay1))

    src.addDirectPeer(
      'relay2-d9',
      makeOverlayPipe('src-d9', relay2, r2State, d => {
        if (d[0] === overlayFrameVersion && d[1] === 3) {
          viaRelay2++
        }
      })
    )
    relay2.addDirectPeer('src-d9', makeOverlayPipe('relay2-d9', src))
    relay2.addDirectPeer('dst-d9', makeOverlayPipe('relay2-d9', dst))
    dst.addDirectPeer('relay2-d9', makeOverlayPipe('dst-d9', relay2))

    await waitFor(
      () =>
        Boolean(
          virtualDestHandle && src.getSnapshot().routes['dst-d9']?.backupNextHop
        ),
      2_000
    )

    // 1. Congest primary relay1 (> 256 KiB): virtual peer reports healthy backup's bufferedAmount and routes via relay2!
    r1State.bufferedAmount = 512 * 1024
    assert.equal(virtualDestHandle!.channel?.bufferedAmount, 1_024)

    // 2. Measure ECDSA sign count across a 100-packet unicast burst (must amortize via signed UnicastLeaseTuple!)
    const origSign = crypto.subtle.sign.bind(crypto.subtle)
    let ecdsaSigns = 0
    crypto.subtle.sign = (async (...args: Parameters<typeof origSign>) => {
      const alg = args[0]
      if (
        typeof alg === 'object' &&
        alg &&
        'name' in alg &&
        alg.name === 'ECDSA'
      ) {
        ecdsaSigns++
      }
      return origSign(...args)
    }) as typeof crypto.subtle.sign

    try {
      for (let i = 0; i < 100; i++) {
        virtualDestHandle!.sendData(encodeBytes(`pkt-${i}`))
      }
      await waitFor(() => received.length === 100, 3_000)
    } finally {
      crypto.subtle.sign = origSign
    }

    assert.equal(viaRelay1, 0)
    assert.equal(viaRelay2, 100)
    assert.ok(
      ecdsaSigns <= 3,
      `expected <= 3 ECDSA signs for 100-packet leased unicast stream, got ${ecdsaSigns}`
    )

    // 3. When both direct relays die, virtualDestHandle.sendData fails synchronously instead of blackholing
    r1State.alive = false
    r2State.alive = false
    assert.equal(virtualDestHandle!.channel?.readyState, 'closed')
    assert.throws(() => virtualDestHandle!.sendData(encodeBytes('dead')))
  } finally {
    src.destroy()
    relay1.destroy()
    relay2.destroy()
    dst.destroy()
  }
})

void test('D12: endpoint identities are partitioned per appId and use non-extractable private keys', async () => {
  const epAppA1 = await getDefaultEndpointIdentity(undefined, 'd12-app-alpha')
  const epAppA2 = await getDefaultEndpointIdentity(undefined, 'd12-app-alpha')
  const epAppB = await getDefaultEndpointIdentity(undefined, 'd12-app-beta')

  assert.equal(epAppA1.peerId, epAppA2.peerId)
  assert.notEqual(
    epAppA1.peerId,
    epAppB.peerId,
    'distinct appIds must not share linkable endpoint peerId'
  )
  assert.equal(epAppA1.signPrivateKey.extractable, false)
  assert.equal(epAppB.signPrivateKey.extractable, false)
})

void test('D13: SelfInfo and resolved UserIdentity surface persisted and identityPersistence on storage downgrade', async () => {
  // Outside browser (no IndexedDB), resolveUserIdentity({identity: 'local'}) downgrades to ephemeral and reports persisted: false
  const degradedIdentity = await resolveUserIdentity('d13-app', 'd13-room', {
    identity: 'local'
  })
  assert.equal(degradedIdentity.persisted, false)
  assert.equal(degradedIdentity.persistence, 'none')
  assert.match(degradedIdentity.fingerprint, /^[0-9A-Za-z]{22}$/)

  const joinRoom = createTopicStrategy({
    init: () => Promise.resolve({}),
    subscribeTopic: async () => () => {},
    publishTopic: async () => {}
  })
  const roomEphemeral = joinRoom(
    {
      appId: 'd13-app',
      identity: 'none',
      rtcPolyfill: MockRTCPeerConnection as unknown as typeof RTCPeerConnection
    },
    'd13-room'
  )
  try {
    const selfEphemeral = await roomEphemeral.getSelf()
    assert.equal(selfEphemeral.persisted, false)
    assert.equal(selfEphemeral.identityPersistence, 'none')
  } finally {
    await roomEphemeral.leave()
  }

  const customUser = await createUserIdentity()
  const roomCustom = joinRoom(
    {
      appId: 'd13-app',
      identity: customUser,
      rtcPolyfill: MockRTCPeerConnection as unknown as typeof RTCPeerConnection
    },
    'd13-room-custom'
  )
  try {
    const selfCustom = await roomCustom.getSelf()
    assert.equal(selfCustom.persisted, true)
    assert.equal(selfCustom.identityPersistence, 'custom')
    assert.equal(customUser.userId, selfCustom.userId)
  } finally {
    await roomCustom.leave()
  }
})

void test('Crypto audit fixes: PBKDF2-HMAC roomAuth, HKDF pairwise ECDH, computePayloadDigest tag separation & small-Blob parity, 12-byte GCM, 22-char fingerprint, unbiased genId, and Nostr kind dispersion', async () => {
  // 1. signRoomAuth / verifyRoomAuth uses PBKDF2-HMAC-SHA256 with canonical JSON framing (no ':' collisions or single-SHA256 oracle)
  const validToken = await signRoomAuth(
    'pa:ss',
    'app',
    'room',
    'PeerA123456789012345',
    7
  )
  assert.match(validToken, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(
    await verifyRoomAuth(
      'pa:ss',
      'app',
      'room',
      'PeerA123456789012345',
      7,
      validToken
    ),
    true
  )
  // Delimiter-shifted tuple ('pa', 'ss:app', 'room') must NOT verify
  assert.equal(
    await verifyRoomAuth(
      'pa',
      'ss:app',
      'room',
      'PeerA123456789012345',
      7,
      validToken
    ),
    false
  )
  // Legacy single-SHA256 token must NOT verify
  const legacySingleSha = Array.from(
    await sha256('trystero-ov-auth:pa:ss:app:room:PeerA123456789012345:7'),
    b => b.toString(16).padStart(2, '0')
  ).join('')
  assert.equal(
    await verifyRoomAuth(
      'pa:ss',
      'app',
      'room',
      'PeerA123456789012345',
      7,
      legacySingleSha
    ),
    false
  )

  // 2. derivePairwiseAesKey uses Web Crypto HKDF-SHA256, rejects private JWKs in pubJwkToUncompressedBytes, and prevents ':' delimiter collisions
  const [aliceEcdh, bobEcdh] = await Promise.all([
    crypto.subtle.generateKey(ecdhKeyAlgo, true, ['deriveBits']),
    crypto.subtle.generateKey(ecdhKeyAlgo, true, ['deriveBits'])
  ])
  const [alicePubJwk, bobPubJwk, alicePrivJwk] = await Promise.all([
    crypto.subtle.exportKey('jwk', aliceEcdh.publicKey),
    crypto.subtle.exportKey('jwk', bobEcdh.publicKey),
    crypto.subtle.exportKey('jwk', aliceEcdh.privateKey)
  ])
  assert.equal(
    pubJwkToUncompressedBytes(alicePrivJwk),
    null,
    'pubJwkToUncompressedBytes must reject JWKs containing private scalar d'
  )
  const aliceRawPub = pubJwkToUncompressedBytes({
    kty: 'EC',
    crv: 'P-256',
    x: alicePubJwk.x,
    y: alicePubJwk.y
  })!
  const bobRawPub = pubJwkToUncompressedBytes({
    kty: 'EC',
    crv: 'P-256',
    x: bobPubJwk.x,
    y: bobPubJwk.y
  })!
  const [kAliceBob, kBobAlice, kShifted] = await Promise.all([
    derivePairwiseAesKey(
      aliceEcdh.privateKey,
      bobRawPub,
      'app:1',
      'room',
      'alice',
      'bob'
    ),
    derivePairwiseAesKey(
      bobEcdh.privateKey,
      aliceRawPub,
      'app:1',
      'room',
      'bob',
      'alice'
    ),
    derivePairwiseAesKey(
      bobEcdh.privateKey,
      aliceRawPub,
      'app',
      '1:room',
      'bob',
      'alice'
    )
  ])
  assert.equal(kAliceBob.extractable, false)
  const e2eCt = await encrypt(Promise.resolve(kAliceBob), 'hkdf-secret', 'aad1')
  assert.equal(
    await decrypt(Promise.resolve(kBobAlice), e2eCt, 'aad1'),
    'hkdf-secret'
  )
  await assert.rejects(() => decrypt(Promise.resolve(kShifted), e2eCt, 'aad1'))

  // 3. computePayloadDigest: small Blob (<= 256 KiB) matches Uint8Array AND chunked (> 256 KiB, tag 0x04) cannot collide with unchunked (tag 0x02)
  const smallBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
  const smallBlob = new Blob([smallBytes])
  assert.equal(
    await computePayloadDigest(smallBlob),
    await computePayloadDigest(smallBytes),
    'small Blob (<= 256 KiB) digest must match decoded Uint8Array digest on receiver'
  )
  assert.equal(
    await computePayloadDigest(smallBlob, {m: 1}),
    await computePayloadDigest(smallBytes, {m: 1})
  )
  const admin = await createUserIdentity()
  assert.match(admin.fingerprint, /^[0-9A-Za-z]{22}$/)
  const blobAuth = createRoomAuthority({
    selfId: 'blob-admin-peer',
    appId: 'blob-app',
    initialRoomId: `blob-room~${admin.fingerprint}`,
    admin: {selfAsAdmin: true},
    getLocalUserIdentity: async () => admin
  })
  await blobAuth.getAuthorityInfo()
  const blobCert = await blobAuth.issueRoleCertificate(admin.userId, ['admin'])
  const blobEnv = await signActionAuth(admin.sign, admin.signPubJwk, blobCert, {
    appId: 'blob-app',
    roomId: `blob-room~${admin.fingerprint}`,
    namespace: 'media',
    peerId: 'blob-admin-peer',
    seq: 1,
    data: smallBlob,
    meta: {mime: 'application/octet-stream'}
  })
  const blobVerified = await verifyActionAuth(blobEnv, {
    appId: 'blob-app',
    roomId: `blob-room~${admin.fingerprint}`,
    namespace: 'media',
    peerId: 'blob-admin-peer',
    expectedUserId: admin.userId,
    data: smallBytes,
    requiredRoles: ['admin'],
    rootFingerprints: new Set([admin.fingerprint])
  })
  assert.equal(blobVerified.valid, true)

  const chunkedBytes = new Uint8Array(300_000)
  chunkedBytes.fill(0xab)
  const chunkedDigest = await computePayloadDigest(chunkedBytes)
  const forgedMerkleBody = new Uint8Array(8 + 2 * 32)
  new DataView(forgedMerkleBody.buffer).setBigUint64(0, 300_000n, false)
  forgedMerkleBody.set(await sha256(chunkedBytes.subarray(0, 262_144)), 8)
  forgedMerkleBody.set(await sha256(chunkedBytes.subarray(262_144)), 40)
  assert.notEqual(
    await computePayloadDigest(forgedMerkleBody),
    chunkedDigest,
    'small Uint8Array containing Merkle chunk hashes must have a distinct domain tag from chunked payload'
  )

  // 4. 12-byte AES-GCM base64url wire format & delimiter-safe keyless genKey
  const kKeylessA = genKey('', 'a:b', 'c')
  const kKeylessB = genKey('', 'a', 'b:c')
  const gcmWire = await encrypt(kKeylessA, 'hello')
  assert.match(gcmWire, /^[A-Za-z0-9_-]+$/)
  assert.equal(fromBase64Url(gcmWire).byteLength, 12 + 5 + 16)
  await assert.rejects(() => decrypt(kKeylessB, gcmWire))
  await assert.rejects(() => decrypt(kKeylessA, '1,2,3,4$AAAA'))

  // 5. Constant-time P-256 private scalar range check (0 < d < p256N)
  assert.equal(isValidP256PrivateScalar(new Uint8Array(32)), false)
  const oneScalar = new Uint8Array(32)
  oneScalar[31] = 1
  assert.equal(isValidP256PrivateScalar(oneScalar), true)
  const nBytes = new Uint8Array(32)
  let tmpN = p256N
  for (let i = 31; i >= 0; i--) {
    nBytes[i] = Number(tmpN & 0xffn)
    tmpN >>= 8n
  }
  assert.equal(isValidP256PrivateScalar(nBytes), false)
  const nMinusOne = nBytes.slice()
  nMinusOne[31]! -= 1
  assert.equal(isValidP256PrivateScalar(nMinusOne), true)
  const allOnes = new Uint8Array(32).fill(0xff)
  assert.equal(isValidP256PrivateScalar(allOnes), false)

  // 6. Unbiased genId, anagram-distinct strToNum + deterministic shuffle, and full-range Nostr topicToKind
  assert.notEqual(strToNum('app-ab'), strToNum('app-ba'))
  assert.deepEqual(
    shuffle(['r1', 'r2', 'r3', 'r4', 'r5'], strToNum('app-ab')),
    shuffle(['r1', 'r2', 'r3', 'r4', 'r5'], strToNum('app-ab'))
  )

  const sampleId = genId(6_200)
  assert.equal(sampleId.length, 6_200)
  assert.match(sampleId, /^[0-9A-Za-z]{6200}$/)
  // Previously '0'..'7' (or first 8 chars) had 25% bias (expected ~1000 vs ~800); check uniform bounds
  let firstEightCount = 0
  const firstEight = new Set(['0', '1', '2', '3', '4', '5', '6', '7'])
  for (const ch of sampleId) {
    if (firstEight.has(ch)) {
      firstEightCount++
    }
  }
  // Exact expectation = 6200 * (8/62) = 800 (previously biased expectation was ~969)
  assert.ok(
    firstEightCount > 680 && firstEightCount < 920,
    `expected unbiased first-8 frequency near 800, got ${firstEightCount}`
  )

  const kinds = new Set<number>()
  let above24000 = 0
  for (let i = 0; i < 60; i++) {
    const t = await hashTopic(`nostr-kind-dispersion-${i}`)
    const ev = JSON.parse(await createEvent(t, 'ping'))[1] as {kind: number}
    assert.ok(ev.kind >= 20_000 && ev.kind < 30_000)
    kinds.add(ev.kind)
    if (ev.kind >= 24_000) {
      above24000++
    }
  }
  assert.ok(
    above24000 > 15,
    `expected topics to span kinds >= 24000, got ${above24000}/60`
  )
  assert.ok(kinds.size > 50)
})
