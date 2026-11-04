import assert from 'node:assert/strict'
import test from './test.ts'
import {
  createEndpointIdentity,
  createUserIdentity,
  jwkToCompactPub,
  userEndpointProofPayload
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
} from '../../packages/core/src/scale/index.ts'
import type {PeerHandle} from '../../packages/core/src/internal-types.ts'
import {encodeBytes, toBase64Url} from '../../packages/core/src/utils.ts'
import {
  createTrackedRoom as createRoom,
  getRoomSignalingBridge,
  linkHandles,
  makeOverlayPipe
} from './overlay-harness.ts'
import {
  allocTestPeerIds,
  getTestEndpointByPeerId,
  testPeerId,
  wait,
  waitFor
} from './peer-harness.ts'

type PeerDescriptor = Parameters<typeof packGossipControlFrames>[0][number]

void test('S1: multi-ring expander guarantees 100% reachability within deriveMaxHops and hop-caps computeShortestPathRoutes', () => {
  const cases = [
    {peerCount: 250, maxDirectPeers: 6},
    {peerCount: 300, maxDirectPeers: 6},
    {peerCount: 500, maxDirectPeers: 6},
    {peerCount: 100, maxDirectPeers: 4}
  ]

  for (const {peerCount, maxDirectPeers} of cases) {
    const peerIds = Array.from(
      {length: peerCount},
      (_, i) => `peer-${String(i).padStart(4, '0')}`
    )
    const adjacency = new Map<string, Set<string>>()
    for (const id of peerIds) {
      const targets = computeTargetNeighbors(
        id,
        peerIds,
        maxDirectPeers,
        's1-app\0s1-room'
      )
      assert.ok(
        targets.size <= maxDirectPeers,
        `degree ${targets.size} exceeded maxDirectPeers ${maxDirectPeers}`
      )
      adjacency.set(id, targets)
    }

    const maxHops = deriveMaxHops(peerCount, maxDirectPeers)
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
        `expected 100% reachability for N=${peerCount}, maxDirectPeers=${maxDirectPeers}, maxHops=${maxHops}`
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

void test('S6: Sybil descriptor flood is capped by room maxUsers before ECDSA verify and cannot bypass activateVirtualPeer', async () => {
  let hostReg: ((peer: PeerHandle, id: string) => void) | null = null
  let attackerReg: ((peer: PeerHandle, id: string) => void) | null = null
  const hostId = testPeerId('host-s6')
  const attackerId = testPeerId('attacker-s6')
  const [hostUsr, attackerUsr] = await Promise.all([
    createUserIdentity(),
    createUserIdentity()
  ])
  const hostEp = getTestEndpointByPeerId(hostId)
  const attackerEp = getTestEndpointByPeerId(attackerId)

  const hostRoom = createRoom(
    f => {
      hostReg = f
    },
    () => {},
    () => {},
    {
      endpointIdentity: hostEp,
      identity: hostUsr,
      appId: 's6-app',
      roomId: 's6-room',
      maxUsers: 3,
      use: [scale({maxDirectPeers: 4})]
    }
  )
  const attackerRoom = createRoom(
    f => {
      attackerReg = f
    },
    () => {},
    () => {},
    {
      endpointIdentity: attackerEp,
      identity: attackerUsr,
      appId: 's6-app',
      roomId: 's6-room',
      maxUsers: 3,
      use: [scale({maxDirectPeers: 4})]
    }
  )

  try {
    const {peerA, peerB} = linkHandles()
    hostReg!(peerA, attackerId)
    attackerReg!(peerB, hostId)
    await waitFor(() => attackerId in hostRoom.getPeers(), 2_000)
    await wait(60)

    // Mint 12 distinct valid self-certifying Sybil identities & descriptors claiming mutual edges with attacker
    const sybilDescs: PeerDescriptor[] = []
    const sybilIds: string[] = []
    for (let i = 0; i < 12; i++) {
      const ep = await createEndpointIdentity()
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
        neighbors: [attackerId],
        signPubKey: jwkToCompactPub(ep.signPubJwk),
        userId: usr.userId,
        userPubKey: jwkToCompactPub(usr.signPubJwk),
        userProof
      }
      desc.sig = toBase64Url(
        await ep.sign(
          encodeBytes(descriptorCanonicalPayload(desc, 's6-app', 's6-room'))
        )
      )
      sybilDescs.push(desc)
    }

    // Also build a valid attacker descriptor listing all 12 Sybils + host as neighbors (13 <= maxDescriptorNeighbors)
    const attackerNeighbors = [hostId, ...sybilIds].sort()
    const attackerUserProof = toBase64Url(
      await attackerUsr.sign(
        userEndpointProofPayload({
          appId: 's6-app',
          roomId: 's6-room',
          peerId: attackerId,
          peerPubJwk: attackerEp.signPubJwk,
          seq: 50
        })
      )
    )
    const attackerDesc: PeerDescriptor = {
      peerId: attackerId,
      seq: 50,
      neighbors: attackerNeighbors,
      signPubKey: jwkToCompactPub(attackerEp.signPubJwk),
      userId: attackerUsr.userId,
      userPubKey: jwkToCompactPub(attackerUsr.signPubJwk),
      userProof: attackerUserProof
    }
    attackerDesc.sig = toBase64Url(
      await attackerEp.sign(
        encodeBytes(
          descriptorCanonicalPayload(attackerDesc, 's6-app', 's6-room')
        )
      )
    )

    // Inject gossip control frames directly over the attacker -> host channel while counting WebCrypto verifies
    const frames = packGossipControlFrames([attackerDesc, ...sybilDescs])
    const hostScale = getRoomSignalingBridge(hostRoom)!.getScaleProvider()!

    const origVerify = crypto.subtle.verify.bind(crypto.subtle)
    let verifyCalls = 0
    crypto.subtle.verify = (async (...args: Parameters<typeof origVerify>) => {
      verifyCalls++
      return origVerify(...args)
    }) as typeof crypto.subtle.verify

    try {
      for (const f of frames) {
        hostScale.handleFrame(attackerId, f.slice().buffer)
      }
      await wait(100)
    } finally {
      crypto.subtle.verify = origVerify
    }

    // Host has maxUsers: 3 (host + attacker + exactly 1 virtual Sybil = 2 remote peers!)
    const admittedRemotePeers = Object.keys(hostRoom.getPeers())
    assert.equal(
      admittedRemotePeers.length,
      2,
      `expected 2 remote peers (attacker + 1 virtual Sybil) under maxUsers=3, got ${admittedRemotePeers.length}`
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

void test('S8: signaling discovery spam cannot displace verified gossip targets or trigger unicast flood', async () => {
  let relayForwardedCount = 0
  const nodeAId = testPeerId('node-a')
  const nodeBId = testPeerId('node-b')
  const nodeA = createOverlayManager({
    selfId: nodeAId,
    appId: 's8-app',
    roomId: 's8-room',
    config: {maxDirectPeers: 4},
    getLocalEndpointIdentity: () => getTestEndpointByPeerId(nodeAId),
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })
  const nodeB = createOverlayManager({
    selfId: nodeBId,
    appId: 's8-app',
    roomId: 's8-room',
    config: {maxDirectPeers: 4},
    getLocalEndpointIdentity: () => getTestEndpointByPeerId(nodeBId),
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })

  try {
    nodeA.addDirectPeer(nodeBId, {
      ...makeOverlayPipe(nodeAId, nodeB),
      sendData: d => {
        if (d[0] === overlayFrameVersion && d[1] === 3) {
          relayForwardedCount++
        }
        nodeB.handleOverlayFrame(nodeAId, d.slice().buffer)
      }
    })
    nodeB.addDirectPeer(nodeAId, makeOverlayPipe(nodeBId, nodeA))

    await waitFor(
      () => nodeA.getPeerSignPublicKey(nodeBId) !== undefined,
      2_000
    )

    // Flood 300 unauthenticated signaling candidates
    for (let i = 0; i < 300; i++) {
      nodeA.notePeerDiscovered(`unverified-spam-${i}`)
      nodeA.shouldConnectPeer(`unverified-spam-${i}`, 'outbound')
    }

    const targets = nodeA.getTargetNeighbors()
    assert.equal(
      targets.has(nodeBId),
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

void test('D5: peerId grinding by a single userId cannot eclipse all target slots of an honest peer', async () => {
  const honestIds = allocTestPeerIds(16)
  const victim = createOverlayManager({
    selfId: honestIds[0]!,
    appId: 'd5-app',
    roomId: 'd5-room',
    config: {maxDirectPeers: 6},
    getLocalEndpointIdentity: () => getTestEndpointByPeerId(honestIds[0]!),
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })

  try {
    const dummyRelay = createOverlayManager({
      selfId: honestIds[1]!,
      appId: 'd5-app',
      roomId: 'd5-room',
      config: {maxDirectPeers: 6},
      getLocalEndpointIdentity: () => getTestEndpointByPeerId(honestIds[1]!),
      onVirtualPeerJoin: () => {},
      onVirtualPeerLeave: () => {},
      onDeliverData: () => {}
    })
    victim.addDirectPeer(
      honestIds[1]!,
      makeOverlayPipe(honestIds[0]!, dummyRelay)
    )
    dummyRelay.addDirectPeer(
      honestIds[0]!,
      makeOverlayPipe(honestIds[1]!, victim)
    )
    await waitFor(
      () => victim.getPeerSignPublicKey(honestIds[1]!) !== undefined,
      2_000
    )

    const descriptors: PeerDescriptor[] = []
    for (let i = 1; i < honestIds.length; i++) {
      const id = honestIds[i]!
      const ep = getTestEndpointByPeerId(id)
      const u = await createUserIdentity()
      const descSeq = 10
      const userProof = toBase64Url(
        await u.sign(
          userEndpointProofPayload({
            appId: 'd5-app',
            roomId: 'd5-room',
            peerId: id,
            peerPubJwk: ep.signPubJwk,
            seq: descSeq
          })
        )
      )
      const desc: PeerDescriptor = {
        peerId: id,
        seq: descSeq,
        neighbors: [honestIds[0]!],
        signPubKey: jwkToCompactPub(ep.signPubJwk),
        userId: u.userId,
        userPubKey: jwkToCompactPub(u.signPubJwk),
        userProof
      }
      desc.sig = toBase64Url(
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
      const ep = await createEndpointIdentity()
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
        signPubKey: jwkToCompactPub(ep.signPubJwk),
        userId: sybilOwner.userId,
        userPubKey: jwkToCompactPub(sybilOwner.signPubJwk),
        userProof
      }
      desc.sig = toBase64Url(
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
      `single userId must occupy at most floor(maxDirectPeers/3)=2 target slots, got ${sybilTargetCount}`
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
