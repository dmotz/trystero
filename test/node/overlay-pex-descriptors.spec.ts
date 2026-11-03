import assert from 'node:assert/strict'
import test from './test.ts'
import type {
  RolesPluginApi,
  Room,
  ScalePluginApi
} from '../../packages/core/src/index.ts'
import {roles} from '../../packages/core/src/authority.ts'
import {createUserIdentity} from '../../packages/core/src/identity.ts'
import {ecdsaSign} from '../../packages/core/src/crypto.ts'
import {signRoleCertInternal} from '../../packages/core/src/signed-record.ts'
import {
  maxActionFrameBytes,
  maxRoomFrameBytes
} from '../../packages/core/src/data-limits.ts'
import {
  computeTargetNeighbors,
  createOverlayManager,
  descriptorCanonicalPayload,
  overlayControlKind,
  overlayFrameVersion,
  packGossipControlFrames,
  packOverlayControl,
  scale
} from '../../packages/core/src/scale/index.ts'
import createRoom from '../../packages/core/src/room.ts'
import {decodeBytes, encodeBytes} from '../../packages/core/src/utils.ts'
import {
  allocTestPeerIds,
  getTestEndpointByPeerId,
  LinkedPeer,
  linkPeers,
  testPeerId,
  wait,
  waitFor
} from './peer-harness.ts'

void test('C1 regression: gossip descriptor dumps and flushes chunk below maxActionFrameBytes / maxRoomFrameBytes at scale with role certs', async () => {
  // 1. Direct unit test of packGossipControlFrames with 30 cert-bearing descriptors
  const adminUser = await createUserIdentity()
  const descriptors = []
  for (let i = 0; i < 30; i++) {
    const peerUser = await createUserIdentity()
    const peerId = `cert-peer-${String(i).padStart(3, '0')}`
    const cert = await signRoleCertInternal(
      adminUser.sign,
      adminUser.signPubJwk,
      peerUser.userId,
      'c1-app',
      'c1-room',
      [
        'moderator',
        'speaker',
        'presenter',
        'curator',
        'editor',
        'archivist',
        'host-assistant',
        'stage-manager',
        'broadcaster',
        'reviewer'
      ],
      Date.now()
    )
    descriptors.push({
      peerId,
      seq: i + 1,
      neighbors: [
        `cert-peer-${String((i + 1) % 30).padStart(3, '0')}`,
        `cert-peer-${String((i + 2) % 30).padStart(3, '0')}`,
        `cert-peer-${String((i + 3) % 30).padStart(3, '0')}`
      ],
      signPubKey: peerUser.signPubJwk,
      encPubKey: peerUser.signPubJwk,
      userId: peerUser.userId,
      userPubKey: peerUser.signPubJwk,
      userProof: 'A'.repeat(88),
      cert,
      sig: 'B'.repeat(88)
    })
  }

  const unchunked = packOverlayControl({
    t: 'gossip',
    descriptors
  })
  assert.ok(
    unchunked.byteLength > maxRoomFrameBytes,
    `expected unchunked 30-descriptor dump (${unchunked.byteLength} B) to exceed maxRoomFrameBytes (${maxRoomFrameBytes} B)`
  )

  const frames = packGossipControlFrames(descriptors)
  assert.ok(frames.length >= 2, 'expected gossip dump to split into chunks')
  const recoveredPeerIds: string[] = []
  for (const frame of frames) {
    assert.ok(
      frame.byteLength <= maxActionFrameBytes,
      `gossip chunk (${frame.byteLength} B) must not exceed maxActionFrameBytes (${maxActionFrameBytes} B)`
    )
    assert.equal(frame[0], overlayFrameVersion)
    assert.equal(frame[1], overlayControlKind)
    const parsed = JSON.parse(decodeBytes(frame.subarray(2)))
    assert.equal(parsed.t, 'gossip')
    for (const d of parsed.descriptors) {
      recoveredPeerIds.push(d.peerId)
    }
  }
  assert.deepEqual(
    recoveredPeerIds,
    descriptors.map(d => d.peerId)
  )

  // 2. Live 25-peer cluster with role certificates enforcing strict WebRTC frame limits
  let maxObservedControlFrameBytes = 0
  let oversizedDrops = 0
  const peerCount = 25
  const c1AdminIdentity = await createUserIdentity()
  const roomId = `c1-cluster-room~${c1AdminIdentity.userId}`
  const appId = 'c1-cluster-app'
  const peerIds = allocTestPeerIds(peerCount)
  const registerCallbacks = new Map<string, (peer: any, id: string) => void>()
  const rooms = new Map<string, Room & RolesPluginApi & ScalePluginApi>()
  const directLinks = new Map<string, {peerA: LinkedPeer; peerB: LinkedPeer}>()

  class StrictWebRTCPeer extends LinkedPeer {
    override sendData(data: Uint8Array) {
      if (this.isDead) {
        return
      }
      if (
        data.byteLength >= 2 &&
        data[0] === overlayFrameVersion &&
        data[1] === overlayControlKind
      ) {
        if (data.byteLength > maxObservedControlFrameBytes) {
          maxObservedControlFrameBytes = data.byteLength
        }
      }
      if (data.byteLength > maxActionFrameBytes) {
        oversizedDrops++
        const partner = this.partner
        this.destroy()
        partner?.destroy()
        return
      }
      super.sendData(data)
    }
  }

  const connectPair = (idA: string, idB: string) => {
    if (idA === idB) {
      return
    }
    const key = idA < idB ? `${idA}<->${idB}` : `${idB}<->${idA}`
    if (directLinks.has(key)) {
      return
    }
    const regA = registerCallbacks.get(idA)
    const regB = registerCallbacks.get(idB)
    if (!regA || !regB) {
      return
    }
    const {peerA, peerB} = linkPeers(
      new StrictWebRTCPeer(),
      new StrictWebRTCPeer()
    )
    directLinks.set(key, {peerA, peerB})
    if (idA < idB) {
      regA(peerA, idB)
      regB(peerB, idA)
    } else {
      regB(peerA, idA)
      regA(peerB, idB)
    }
  }

  for (let i = 0; i < peerCount; i++) {
    const id = peerIds[i]!
    const peerIdentity = i === 0 ? c1AdminIdentity : await createUserIdentity()
    const room = createRoom(
      peerRegister => {
        registerCallbacks.set(id, peerRegister)
      },
      () => {},
      () => {},
      {
        endpointIdentity: getTestEndpointByPeerId(id),
        appId,
        roomId,
        use: [
          scale({
            maxDirectPeers: 6
          }),
          roles()
        ],
        identity: peerIdentity
      }
    )
    rooms.set(id, room as any)
  }

  try {
    const activeSet = new Set(peerIds)
    for (const id of activeSet) {
      const targets = computeTargetNeighbors(id, activeSet, 6)
      for (const targetId of targets) {
        connectPair(id, targetId)
      }
    }

    await waitFor(() => {
      for (const room of rooms.values()) {
        if (room.getTopology().roomPeerIds.length < peerCount - 1) {
          return false
        }
      }
      return true
    }, 5_000)

    // Grant moderator role certificates to 18 peers so their descriptors grow to ~1.5-2.1 KB
    const adminRoom = rooms.get(peerIds[0]!)!
    for (let i = 1; i <= 18; i++) {
      await adminRoom.grantRole(peerIds[i]!, 'moderator')
    }
    await waitFor(
      () =>
        rooms.get(peerIds[24]!)!.getRoles(peerIds[18]!).includes('moderator'),
      3_000
    )

    // Now dial fresh direct links so welcome dumps carry 24 descriptors (18 with certs)
    connectPair(peerIds[0]!, peerIds[12]!)
    connectPair(peerIds[3]!, peerIds[19]!)
    await wait(150)

    assert.equal(
      oversizedDrops,
      0,
      'no peer link should ever be dropped due to an oversized gossip frame'
    )
    assert.ok(
      maxObservedControlFrameBytes > 0 &&
        maxObservedControlFrameBytes <= maxActionFrameBytes,
      `expected max control frame (${maxObservedControlFrameBytes} B) <= maxActionFrameBytes (${maxActionFrameBytes} B)`
    )
    for (const [id, room] of rooms.entries()) {
      assert.equal(
        room.getTopology().roomPeerIds.length,
        peerCount - 1,
        `peer ${id} must remain connected to all ${peerCount - 1} peers`
      )
    }
  } finally {
    await Promise.all([...rooms.values()].map(r => r.leave()))
  }
})

void test('Mutual edge confirmation, multi-neighbor disconnect eviction, descriptor TTL heartbeat expiry, ephemeral identity warning, non-circular plugins, and deleted stubs', async () => {
  // 1. Non-circular plugin objects & deleted stubs on bare room
  const serializedConfig = JSON.stringify({
    appId: 'json-test',
    use: [roles(), scale()]
  })
  assert.ok(serializedConfig.includes('"name":"roles"'))
  assert.ok(serializedConfig.includes('"name":"scale"'))

  const bareRoom = createRoom(
    () => {},
    () => {},
    () => {},
    {
      endpointIdentity: getTestEndpointByPeerId(testPeerId('bare-peer')),
      appId: 'bare-app',
      roomId: 'bare-room'
    }
  )
  assert.equal(typeof bareRoom.makeState, 'function')
  assert.equal(typeof bareRoom.makeUserState, 'function')
  assert.equal((bareRoom as any).grantRole, undefined)
  assert.equal((bareRoom as any).revokeRole, undefined)
  assert.equal((bareRoom as any).getRoles, undefined)
  assert.equal((bareRoom as any).ban, undefined)
  assert.equal((bareRoom as any).isBanned, undefined)
  assert.equal((bareRoom as any).getTopology, undefined)
  await bareRoom.leave()

  // 2. Ephemeral identity with selfAsAdmin logs a warning, and removed signalingProofs option is rejected
  const warnings: string[] = []
  const origWarn = console.warn
  console.warn = (...args: any[]) => {
    warnings.push(args.map(String).join(' '))
  }
  try {
    const defaultProofsRoom = createRoom(
      () => {},
      () => {},
      () => {},
      {
        endpointIdentity: getTestEndpointByPeerId(
          testPeerId('host-default-proofs')
        ),
        appId: 'proof-app',
        roomId: 'proof-room',
        identity: 'none',
        use: [roles({selfAsAdmin: true})]
      }
    )
    await defaultProofsRoom.getSelf()
    assert.ok(
      warnings.some(w => w.includes('ephemeral identity')),
      'roles({selfAsAdmin: true}) with ephemeral identity must warn about orphanable room'
    )
    await defaultProofsRoom.leave()

    assert.throws(
      () => roles({selfAsAdmin: true, signalingProofs: true} as any),
      /Unknown roles config option "signalingProofs"/,
      'removed signalingProofs option must be rejected'
    )
  } finally {
    console.warn = origWarn
  }

  // 3. Mutual edge confirmation & multi-neighbor disconnect eviction confirmation
  // Topology: alice is connected to BOTH relay1 and relay2; bob is connected to relay1, relay2, and mallory.
  const makeOverlay = (id: string, descriptorTtlMs?: number) =>
    createOverlayManager({
      selfId: id,
      appId: 'mutual-app',
      roomId: 'mutual-room',
      config: {maxDirectPeers: 4},
      getLocalEndpointIdentity: () => getTestEndpointByPeerId(id),
      ...(descriptorTtlMs ? {descriptorTtlMs} : {}),
      onVirtualPeerJoin: () => {},
      onVirtualPeerLeave: () => {},
      onDeliverData: () => {}
    })

  const alicePid = testPeerId('mut-alice')
  const relay1Pid = testPeerId('mut-relay1')
  const relay2Pid = testPeerId('mut-relay2')
  const bobPid = testPeerId('mut-bob')
  const malloryPid = testPeerId('mut-mallory')
  const ttlObserverPid = testPeerId('mut-ttl-observer')
  const silentPid = testPeerId('mut-silent-peer')

  const alice = makeOverlay(alicePid)
  const relay1 = makeOverlay(relay1Pid)
  const relay2 = makeOverlay(relay2Pid)
  const bob = makeOverlay(bobPid)
  const mallory = makeOverlay(malloryPid)

  const wirePair = (
    idA: string,
    ovA: ReturnType<typeof createOverlayManager>,
    idB: string,
    ovB: ReturnType<typeof createOverlayManager>
  ) => {
    const handleA = {
      isDead: false,
      connection: {} as any,
      channel: {readyState: 'open'} as any,
      getOffer: async () => undefined,
      signal: async () => undefined,
      sendData: (data: Uint8Array) => {
        if (!handleA.isDead) {
          queueMicrotask(() => ovB.handleOverlayFrame(idA, data.slice().buffer))
        }
      },
      destroy: () => {
        handleA.isDead = true
      },
      setHandlers: () => {},
      addStream: () => {},
      removeStream: () => {},
      addTrack: () => ({}) as any,
      removeTrack: () => {},
      replaceTrack: async () => {}
    }
    const handleB = {
      ...handleA,
      sendData: (data: Uint8Array) => {
        if (!handleB.isDead) {
          queueMicrotask(() => ovA.handleOverlayFrame(idB, data.slice().buffer))
        }
      },
      destroy: () => {
        handleB.isDead = true
      }
    }
    ovA.addDirectPeer(idB, handleA)
    ovB.addDirectPeer(idA, handleB)
    return {handleA, handleB}
  }

  try {
    wirePair(alicePid, alice, relay1Pid, relay1)
    wirePair(alicePid, alice, relay2Pid, relay2)
    wirePair(relay1Pid, relay1, bobPid, bob)
    wirePair(relay2Pid, relay2, bobPid, bob)
    wirePair(malloryPid, mallory, bobPid, bob)

    await waitFor(() => bob.getSnapshot().roomPeerIds.includes(alicePid), 2_000)

    // 3a. Mallory unilaterally claims Alice as a direct neighbor in a signed descriptor (without Alice claiming Mallory).
    // Bob must NOT route to Alice via Mallory!
    const malloryId = await mallory.getLocalCryptoIdentity()
    const forgedMalloryDesc: any = {
      peerId: malloryPid,
      seq: 50,
      neighbors: [alicePid, bobPid].sort(),
      signPubKey: malloryId.signPubJwk,
      encPubKey: malloryId.encPubJwk
    }
    const forgedCanonical = encodeBytes(
      descriptorCanonicalPayload(forgedMalloryDesc, 'mutual-app', 'mutual-room')
    )
    forgedMalloryDesc.sig = Buffer.from(
      await ecdsaSign(malloryId.signPrivateKey, forgedCanonical as BufferSource)
    ).toString('base64')
    bob.handleOverlayFrame(
      malloryPid,
      new Uint8Array([
        overlayFrameVersion,
        1,
        ...encodeBytes(
          JSON.stringify({t: 'gossip', descriptors: [forgedMalloryDesc]})
        )
      ]).slice().buffer
    )
    await wait(30)

    const routeToAlice = bob.getRoute(alicePid)
    assert.ok(routeToAlice)
    assert.notEqual(
      routeToAlice.nextHop,
      malloryPid,
      'unilateral neighbor claim by mallory must not attract routes to alice'
    )

    // 3b. Single neighbor (relay2) drops alice and publishes updated descriptor without alice.
    // Because alice still has a mutually confirmed path via relay1, bob must NOT evict alice!
    relay2.removeDirectPeer(alicePid)
    await wait(50)
    assert.equal(
      bob.getSnapshot().roomPeerIds.includes(alicePid),
      true,
      'single neighbor dropping alice must not evict alice while relay1 still confirms her'
    )

    // 3c. Once relay1 ALSO drops alice, both of alice's known neighbors have confirmed she disconnected, so bob evicts alice.
    relay1.removeDirectPeer(alicePid)
    await waitFor(
      () => !bob.getSnapshot().roomPeerIds.includes(alicePid),
      2_000
    )
    assert.equal(
      bob.getSnapshot().roomPeerIds.includes(alicePid),
      false,
      'alice must be evicted once all neighbors confirm she dropped'
    )

    // 4. Descriptor heartbeat TTL expiry evicts a silent multi-hop peer without down rumors
    const ttlEvicted: string[] = []
    const shortTtlObserver = createOverlayManager({
      selfId: ttlObserverPid,
      appId: 'mutual-app',
      roomId: 'mutual-room',
      config: {maxDirectPeers: 4},
      getLocalEndpointIdentity: () => getTestEndpointByPeerId(ttlObserverPid),
      descriptorTtlMs: 250,
      onVirtualPeerJoin: () => {},
      onVirtualPeerLeave: pid => ttlEvicted.push(pid),
      onDeliverData: () => {}
    })
    wirePair(relay1Pid, relay1, ttlObserverPid, shortTtlObserver)
    const silentPeer = makeOverlay(silentPid)
    const silentLink = wirePair(silentPid, silentPeer, relay1Pid, relay1)
    await waitFor(
      () => shortTtlObserver.getSnapshot().roomPeerIds.includes(silentPid),
      2_000
    )
    // Mute silent-peer without disconnecting relay1 so no descriptor update is sent, and let TTL expire
    silentLink.handleA.isDead = true
    silentLink.handleB.isDead = true
    await waitFor(
      () => !shortTtlObserver.getSnapshot().roomPeerIds.includes(silentPid),
      2_000
    )
    assert.ok(
      ttlEvicted.includes(silentPid),
      'descriptor TTL expiry must evict silent virtual peer'
    )
    silentPeer.destroy()
    shortTtlObserver.destroy()
  } finally {
    alice.destroy()
    relay1.destroy()
    relay2.destroy()
    bob.destroy()
    mallory.destroy()
  }
})
