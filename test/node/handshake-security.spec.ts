import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import test from './test.ts'
import {
  decrypt,
  ecdsaKeyAlgo,
  encrypt,
  genKey,
  hashTopic
} from '../../packages/core/src/crypto.ts'
import {createIdentityHandshake} from '../../packages/core/src/handshake.ts'
import {
  createUserIdentity,
  type EndpointIdentity,
  getDefaultEndpointIdentity,
  resolveUserIdentity,
  verifyUserIdKey
} from '../../packages/core/src/identity.ts'
import createRoom from '../../packages/core/src/room.ts'
import {
  buildSignalAad,
  createSignalHandler,
  maxPendingPeerConnections
} from '../../packages/core/src/signal-handler.ts'
import createTopicStrategy from '../../packages/core/src/topic-strategy.ts'
import type {
  PeerHandle,
  Signal
} from '../../packages/core/src/internal-types.ts'
import type {Room} from '../../packages/core/src/types.ts'
import {linkHandles} from './overlay-harness.ts'
import {
  MockRTCPeerConnection,
  actionStartFrame,
  allocTestPeerIds,
  getTestEndpointByPeerId,
  internalActionPrefix,
  wait,
  waitFor
} from './peer-harness.ts'

const execFileAsync = promisify(execFile)
const encoder = new TextEncoder()

void test('S3: identity or plugin resolution failure reports onError with zero unhandled rejections in Node', async () => {
  const script = `
    import {createTopicStrategy, roles} from './packages/core/src/index.ts'
    import {pluginSlotSymbol} from './packages/core/src/primitives.ts'

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
      's3-room-1'
    )
    room1.onError(d => joinErrors.push(d))

    const badPlugin = {
      name: 'scale',
      [pluginSlotSymbol]: {
        kind: 'scale',
        setup: () => { throw new Error('boom-plugin') }
      }
    }
    const room2 = joinRoom(
      {
        appId: 's3-app',
        rtcPolyfill: DummyPc,
        use: [badPlugin]
      },
      's3-room-2'
    )
    room2.onError(d => joinErrors.push(d))

    await new Promise(r => setTimeout(r, 120))
    await Promise.all([
      room1.leave().catch(() => {}),
      room2.leave().catch(() => {})
    ])
    await new Promise(r => setTimeout(r, 50))

    const idErr = joinErrors.find(e => e.code === 'identity-failed')
    const plugErr = joinErrors.find(e => e.code === 'plugin-failed')

    if (
      unhandled !== 0 ||
      joinErrors.length !== 2 ||
      !idErr ||
      idErr.roomId !== 's3-room-1' ||
      !plugErr ||
      plugErr.plugin !== 'scale' ||
      plugErr.roomId !== 's3-room-2'
    ) {
      console.error({unhandled, joinErrors})
      process.exit(2)
    }
  `
  const {stderr} = await execFileAsync(process.execPath, [
    '--import',
    './scripts/register-hooks.ts',
    '--input-type=module',
    '-e',
    script
  ])
  assert.equal(stderr, '')
})

void test('S4: solo occupant is never evicted by later joiners with lexicographically smaller peerIds', async () => {
  const mkHostAndJoiners = async (maxUsers: number, joinerCount: number) => {
    const sortedIds = allocTestPeerIds(joinerCount + 1)
    const hostId = sortedIds[joinerCount]!
    const joinerIds = sortedIds.slice(0, joinerCount)

    const regs = new Map<
      string,
      (peer: PeerHandle, id: string) => void | Promise<void>
    >()
    const errors = new Map<string, string[]>()
    const mk = (id: string, peerMaxUsers?: number) => {
      errors.set(id, [])
      const r = createRoom(
        f => regs.set(id, f),
        () => {},
        () => {},
        {
          endpointIdentity: getTestEndpointByPeerId(id),
          appId: 's4-app',
          roomId: `s4-room-${maxUsers}`,
          ...(peerMaxUsers === undefined ? {} : {maxUsers: peerMaxUsers})
        }
      )
      r.onError(err => errors.get(id)!.push(err.message))
      return r
    }

    const host = mk(hostId, maxUsers)
    await host.getSelf()

    const joinerMaxUsers = maxUsers > 1 ? maxUsers : undefined
    const joiners = joinerIds.map(id => ({id, room: mk(id, joinerMaxUsers)}))
    await Promise.all(joiners.map(j => j.room.getSelf()))
    for (const j of joiners) {
      const {peerA, peerB} = linkHandles()
      void regs.get(hostId)!(peerA, j.id)
      void regs.get(j.id)!(peerB, hostId)
    }
    if (maxUsers > 1) {
      await waitFor(
        () => Object.keys(host.getPeers()).length === maxUsers - 1,
        3_000
      )
    }
    await wait(80)

    const hostPeers = Object.keys(host.getPeers())
    assert.equal(
      hostPeers.length,
      maxUsers - 1,
      `host with maxUsers=${maxUsers} must retain exactly ${maxUsers - 1} peers`
    )
    assert.deepEqual(
      errors.get(hostId),
      [],
      'established solo host must never report self room-full error'
    )

    await Promise.all([host.leave(), ...joiners.map(j => j.room.leave())])
  }

  await mkHostAndJoiners(1, 2)
  await mkHostAndJoiners(2, 3)
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
  const victimEp = await getDefaultEndpointIdentity('s9-app', 's9-victim')
  const legitEp = await getDefaultEndpointIdentity('s9-app', 's9-legit')
  const spoofEp = await getDefaultEndpointIdentity('s9-app', 's9-spoof')

  const makeVerifiedRoom = (
    ep: EndpointIdentity,
    user: Awaited<ReturnType<typeof createUserIdentity>>,
    setReg: (
      fn: (peer: PeerHandle, id: string) => void | Promise<void>
    ) => void,
    recordErr?: (err: string) => void
  ): Room => {
    const room = createRoom(
      setReg,
      () => {},
      () => {},
      {
        endpointIdentity: ep,
        appId: 's9-app',
        roomId: 's9-room',
        maxUsers: 2,
        identity: user
      }
    )
    if (recordErr) {
      room.onError(err => recordErr(err.message))
    }
    return room
  }

  const victimRoom = makeVerifiedRoom(
    victimEp,
    victimUser,
    f => {
      victimReg = f
    },
    err => joinErrors.push(err)
  )
  victimRoom.onError(err => joinErrors.push(err.code))
  const legitRoom = makeVerifiedRoom(legitEp, legitUser, f => {
    legitReg = f
  })

  try {
    await Promise.all([victimRoom.getSelf(), legitRoom.getSelf()])

    // Attacker connects raw WebRTC data channel and immediately sends unauthenticated hsready {ok:false, err:'room full'}
    const {peerA: victimSideSpoof, peerB: attackerRawPeer} = linkHandles()
    void victimReg!(victimSideSpoof, spoofEp.peerId)
    await wait(10)

    const forgedHsReadyPayload = encoder.encode(
      JSON.stringify({ok: false, err: 'room full'})
    )
    const forgedHsReadyFrame = actionStartFrame(
      0,
      forgedHsReadyPayload.byteLength,
      {
        type: `${internalActionPrefix}hsready`,
        payload: forgedHsReadyPayload,
        format: 1
      }
    )
    attackerRawPeer.sendData(new Uint8Array(forgedHsReadyFrame))
    await wait(40)
    attackerRawPeer.destroy()

    assert.equal(
      joinErrors.includes('room full') || joinErrors.includes('room-full'),
      false,
      'unauthenticated room-full hsready must not trigger onError'
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

void test('S14: signal-handler drops invalid peerIds before allocating peerStates and hashTopic cache is bounded', async () => {
  const peerStates: Record<string, unknown> = {}
  const selfId = 'K'.repeat(20)
  const receive = createSignalHandler({
    appId: 's14-app',
    getRoomId: () => 's14-room',
    config: {appId: 's14-app'},
    peerStates: peerStates as never,
    getRootTopicPlaintext: () => 'root',
    rootTopicP: Promise.resolve('root'),
    selfTopicP: Promise.resolve('self'),
    toPlain: async s => s,
    toCipher: async s => s,
    encryptOffer: async () => 'enc',
    isLeaving: () => false,
    checkoutOffers: async () => [],
    claimLeasedOffer: () => {},
    reclaimLeasedOffer: () => {},
    initPeer: (() => ({})) as never,
    connectPeer: () => {},
    disconnectPeer: () => {},
    announceIntervals: [],
    announceIntervalMs: 5_000,
    getSelfIdNow: () => selfId,
    selfIdP: Promise.resolve(selfId),
    onError: undefined
  }).handleMessage(0)

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

  const peerStates = new Map<string, unknown>()
  const selfId = '0'.repeat(20)
  const receive = createSignalHandler({
    appId: 's15-app',
    getRoomId: () => 's15-room',
    config: {appId: 's15-app'},
    peerStates: peerStates as never,
    getRootTopicPlaintext: () => 'root',
    rootTopicP: Promise.resolve('root'),
    selfTopicP: Promise.resolve('self'),
    toPlain: async () => {
      throw new Error('decrypt failed')
    },
    toCipher: async s => s,
    encryptOffer: async () => 'enc-offer',
    isLeaving: () => leaving,
    checkoutOffers: async () => [
      {peer: makeMockPeer(), offer: 'enc-offer', offerId: 'offer-id-1234'}
    ],
    claimLeasedOffer: () => {},
    reclaimLeasedOffer: () => {},
    initPeer: makeMockPeer as never,
    connectPeer: () => {},
    disconnectPeer: () => {},
    announceIntervals: [],
    announceIntervalMs: 60_000,
    getSelfIdNow: () => selfId,
    selfIdP: Promise.resolve(selfId),
    onError: undefined
  }).handleMessage(0)

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
  const globals = globalThis as Record<string, unknown>
  const prevWindow = globals['window']
  const prevIdb = globals['indexedDB']
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

  type MockIdbReq = {result: unknown; onsuccess?: () => void}
  const mockIdb = {
    open: () => {
      const req: MockIdbReq = {result: null}
      queueMicrotask(() => {
        req.result = {
          objectStoreNames: {contains: () => true},
          close: () => {},
          transaction: () => {
            const tx: {
              oncomplete?: () => void
              objectStore: () => unknown
            } = {
              objectStore: () => ({
                get: (k: string) => {
                  const r: MockIdbReq = {result: storeMap.get(k)}
                  queueMicrotask(() => r.onsuccess?.())
                  return r
                },
                put: (val: unknown, k: string) => {
                  putCalls++
                  storeMap.set(k, val)
                  const r: MockIdbReq = {result: k}
                  queueMicrotask(() => {
                    r.onsuccess?.()
                    tx.oncomplete?.()
                  })
                  return r
                },
                add: (val: unknown, k: string) => {
                  storeMap.set(k, val)
                  const r: MockIdbReq = {result: k}
                  queueMicrotask(() => {
                    r.onsuccess?.()
                    tx.oncomplete?.()
                  })
                  return r
                }
              })
            }
            return tx
          }
        }
        req.onsuccess?.()
      })
      return req
    }
  }

  globals['window'] = globalThis
  globals['indexedDB'] = mockIdb

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
    assert.equal(resolved.persistence, 'local')
    assert.equal('persisted' in resolved, false)
  } finally {
    if (prevWindow === undefined) {
      delete globals['window']
    } else {
      globals['window'] = prevWindow
    }
    if (prevIdb === undefined) {
      delete globals['indexedDB']
    } else {
      globals['indexedDB'] = prevIdb
    }
  }
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
  const selfId = 'K'.repeat(20)
  const receive = createSignalHandler({
    appId: 'd2-app',
    getRoomId: () => 'd2-room',
    config: {appId: 'd2-app'},
    peerStates: {} as never,
    getRootTopicPlaintext: () => 'root',
    rootTopicP: Promise.resolve('root'),
    selfTopicP: Promise.resolve('self'),
    toPlain: async (s: Signal) => {
      toPlainCalls++
      return s
    },
    toCipher: async s => s,
    encryptOffer: async () => 'enc',
    isLeaving: () => false,
    checkoutOffers: async () => [],
    claimLeasedOffer: () => {},
    reclaimLeasedOffer: () => {},
    initPeer: (() => ({})) as never,
    connectPeer: () => {},
    disconnectPeer: () => {},
    announceIntervals: [],
    announceIntervalMs: 5_000,
    getSelfIdNow: () => selfId,
    selfIdP: Promise.resolve(selfId),
    onError: undefined
  }).handleMessage(0)

  await receive('self', {peerId: 'L'.repeat(20), offer: ct}, () => {})
  await receive('self', {peerId: 'L'.repeat(20), answer: ct}, () => {})
  await receive('self', {peerId: 'L'.repeat(20), candidate: ct}, () => {})
  assert.equal(toPlainCalls, 0)
})

void test('D3: createIdentityHandshake fails closed when peer.connection lacks SDP DTLS fingerprints', async () => {
  const user = await createUserIdentity()
  const epA = await getDefaultEndpointIdentity('d3-app', 'd3-client-a')
  const epB = await getDefaultEndpointIdentity('d3-app', 'd3-client-b')

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

void test('D12: endpoint identities are partitioned per appId and use non-extractable private keys', async () => {
  const epAppA1 = await getDefaultEndpointIdentity('d12-app-alpha', 'client-1')
  const epAppA2 = await getDefaultEndpointIdentity('d12-app-alpha', 'client-1')
  const epAppB = await getDefaultEndpointIdentity('d12-app-beta', 'client-1')

  assert.equal(epAppA1.peerId, epAppA2.peerId)
  assert.notEqual(
    epAppA1.peerId,
    epAppB.peerId,
    'distinct appIds must not share linkable endpoint peerId'
  )
  assert.equal(epAppA1.signPrivateKey.extractable, false)
  assert.equal(epAppB.signPrivateKey.extractable, false)
})

void test('D13: SelfInfo and resolved UserIdentity surface persistence and identityPersistence on storage downgrade', async () => {
  // Outside browser (no IndexedDB), resolveUserIdentity({identity: 'local'}) downgrades to ephemeral and reports persistence: 'none'
  const degradedIdentity = await resolveUserIdentity('d13-app', 'd13-room', {
    identity: 'local'
  })
  assert.equal('persisted' in degradedIdentity, false)
  assert.equal(degradedIdentity.persistence, 'none')
  assert.match(degradedIdentity.userId, /^[0-9A-Za-z]{22}$/)
  assert.equal('fingerprint' in degradedIdentity, false)

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
    assert.equal('persisted' in selfEphemeral, false)
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
    assert.equal('persisted' in selfCustom, false)
    assert.equal(selfCustom.identityPersistence, 'custom')
    assert.equal(customUser.userId, selfCustom.userId)
  } finally {
    await roomCustom.leave()
  }
})
