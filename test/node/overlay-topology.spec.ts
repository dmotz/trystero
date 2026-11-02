import assert from 'node:assert/strict'
import test from './test.ts'
import type {TopologyRoute} from '../../packages/core/src/index.ts'
import type {PeerHandle} from '../../packages/core/src/types.ts'
import {ecdsaSign} from '../../packages/core/src/crypto.ts'
import {
  computeShortestPathRoutes,
  computeTargetNeighbors,
  createOverlayManager,
  deriveMaxHops,
  descriptorCanonicalPayload,
  maxAllowedHops,
  normalizeTopologyConfig,
  packOverlayControl,
  scale
} from '../../packages/core/src/scale/index.ts'
import {decodeBytes, encodeBytes} from '../../packages/core/src/utils.ts'
import {createOverlayCluster} from './overlay-harness.ts'
import {testPeerId, wait, waitFor} from './peer-harness.ts'

void test('Topology algorithms: symmetric gossip neighbor selection & shortest-path routing', () => {
  const peerCount = 200
  const peerIds = Array.from(
    {length: peerCount},
    (_, i) => `peer-${String(i).padStart(4, '0')}`
  )

  for (const mode of ['gossip'] as const) {
    const maxConnections = 8
    const adjacency = new Map<string, Set<string>>()

    for (const id of peerIds) {
      adjacency.set(
        id,
        computeTargetNeighbors(id, peerIds, mode, maxConnections)
      )
    }

    let totalDirectedEdges = 0
    for (const [u, neighbors] of adjacency.entries()) {
      assert.ok(
        neighbors.size <= maxConnections,
        `${mode}: peer ${u} degree ${neighbors.size} exceeds maxConnections ${maxConnections}`
      )
      assert.ok(
        neighbors.size >= 2,
        `${mode}: peer ${u} degree ${neighbors.size} should be at least 2`
      )
      totalDirectedEdges += neighbors.size

      for (const v of neighbors) {
        assert.ok(
          adjacency.get(v)?.has(u),
          `${mode}: neighbor selection must be symmetric between ${u} and ${v}`
        )
      }
    }

    const fullMeshDirectedEdges = peerCount * (peerCount - 1)
    const reductionRatio = 1 - totalDirectedEdges / fullMeshDirectedEdges
    assert.ok(
      reductionRatio >= 0.95,
      `${mode}: expected >=95% edge reduction for N=200, got ${(reductionRatio * 100).toFixed(1)}%`
    )

    // Verify full connectivity and logarithmic diameter from peer-0000
    const routes: Record<string, TopologyRoute> = computeShortestPathRoutes(
      peerIds[0]!,
      adjacency,
      adjacency.get(peerIds[0]!)!
    )
    assert.equal(
      Object.keys(routes).length,
      peerCount - 1,
      `${mode}: all ${peerCount - 1} peers must be reachable`
    )

    const maxHops = Math.max(...Object.values(routes).map(r => r.hops))
    assert.ok(
      maxHops <= 7,
      `${mode}: expected logarithmic diameter <= 7 hops for N=200, got ${maxHops}`
    )

    // Verify backupNextHop is disjoint from primary nextHop
    for (const [dest, route] of Object.entries(routes)) {
      if (route.backupNextHop) {
        assert.notEqual(
          route.backupNextHop,
          route.nextHop,
          `${mode}: backupNextHop for ${dest} must differ from primary nextHop`
        )
      }
    }
  }
})

void test('Peer dropping & mesh-breaking scenarios: 25% mass churn and autonomous overlay self-healing', async () => {
  const peerCount = 80
  const cluster = await createOverlayCluster({
    peerCount,
    topology: {
      mode: 'gossip',
      maxConnections: 8
    }
  })

  try {
    const receivedAlerts = new Map<string, Set<string>>()
    const alertActions = new Map<string, any>()

    for (const id of cluster.peerIds) {
      receivedAlerts.set(id, new Set())
      const room = cluster.rooms.get(id)!
      const alertAction = room.makeAction<{alertId: string}>('alert')
      alertAction.onMessage(({alertId}) => {
        receivedAlerts.get(id)!.add(alertId)
      })
      alertActions.set(id, alertAction)
    }

    // 1. Drop 25% of nodes across the overlay (20 nodes dropped simultaneously)
    const droppedIds = new Set<string>()
    for (let i = 3; i < peerCount; i += 4) {
      droppedIds.add(cluster.peerIds[i]!)
    }

    for (const dropId of droppedIds) {
      cluster.dropPeer(dropId)
    }

    // Trigger self-healing across surviving peers
    await cluster.healCluster()

    const survivors = cluster.peerIds.filter(id => !droppedIds.has(id))
    assert.equal(survivors.length, 60)

    // 2. Broadcast messages from multiple surviving peers after 25% mesh-breaking churn
    const postChurnSenders = [survivors[0]!, survivors[25]!, survivors[59]!]
    for (const senderId of postChurnSenders) {
      await alertActions.get(senderId).send({alertId: `post-churn-${senderId}`})
    }

    await waitFor(() =>
      survivors.every(id => {
        const seen = receivedAlerts.get(id)!
        return postChurnSenders.every(
          s => s === id || seen.has(`post-churn-${s}`)
        )
      })
    )

    // 3. Verify surviving peers evicted dropped nodes from getPeers()
    for (const id of survivors) {
      const activePeers = Object.keys(cluster.rooms.get(id)!.getPeers())
      for (const droppedId of droppedIds) {
        assert.ok(
          !activePeers.includes(droppedId),
          `survivor ${id} still lists dropped peer ${droppedId} as active`
        )
      }
    }
  } finally {
    await cluster.cleanup()
  }
})

void test('Solution (a): reject maxConnections < 4, derive dynamic TTL from roster size, and verify 100% reachability & delivery at N=250 and N=500 with defaults', async () => {
  // 1. Reject maxConnections < 4 in both normalizeTopologyConfig and scale()
  for (const invalid of [0, 1, 2, 3, -4, 3.5, Number.NaN]) {
    assert.throws(
      () => normalizeTopologyConfig({mode: 'gossip', maxConnections: invalid}),
      /scale\.maxConnections must be an integer >= 4/
    )
    assert.throws(
      () => scale({mode: 'gossip', maxConnections: invalid}),
      /scale\.maxConnections must be an integer >= 4/
    )
  }
  assert.equal(normalizeTopologyConfig({maxConnections: 4}).maxConnections, 4)
  assert.equal(normalizeTopologyConfig().maxConnections, 6)

  // 2. Verify deriveMaxHops scales with roster size and degree
  const ttlSmall = deriveMaxHops(16, 6)
  const ttl250 = deriveMaxHops(250, 6)
  const ttl500 = deriveMaxHops(500, 6)
  assert.ok(ttlSmall >= 12)
  assert.ok(ttl250 >= 25, `expected ttl250 >= 25, got ${ttl250}`)
  assert.ok(ttl500 >= 30 && ttl500 <= maxAllowedHops)

  // 3. Verify 0% unreachable pairs across all N*(N-1) pairs at N=250 and N=500 with default maxConnections=6
  for (const n of [250, 500]) {
    const ids = Array.from(
      {length: n},
      (_, i) => `peer-${String(i).padStart(4, '0')}`
    )
    const adj = new Map<string, Set<string>>()
    for (const id of ids) {
      adj.set(
        id,
        computeTargetNeighbors(
          id,
          ids,
          'gossip',
          6,
          'default-app\0default-room'
        )
      )
    }
    const maxHopsLimit = deriveMaxHops(n, 6)
    let unreachablePairs = 0
    let observedDiameter = 0

    for (const src of ids) {
      const routes = computeShortestPathRoutes(src, adj, adj.get(src)!)
      const reachableCount = Object.keys(routes).length
      if (reachableCount < n - 1) {
        unreachablePairs += n - 1 - reachableCount
      }
      for (const r of Object.values(routes)) {
        if (r.hops > observedDiameter) {
          observedDiameter = r.hops
        }
        if (r.hops > maxHopsLimit) {
          unreachablePairs++
        }
      }
    }

    assert.equal(
      unreachablePairs,
      0,
      `N=${n} with default maxConnections=6 must have 0 unreachable pairs within TTL=${maxHopsLimit} (observed diameter=${observedDiameter})`
    )
    assert.ok(
      observedDiameter <= maxHopsLimit,
      `N=${n} diameter (${observedDiameter}) must be <= derived TTL (${maxHopsLimit})`
    )
  }

  // 4. Live N=250 cluster at default scale('gossip') config over async jittered harness
  const cluster250 = await createOverlayCluster({
    peerCount: 250,
    topology: 'gossip',
    jitterMs: 1
  })
  try {
    const receivedBroadcastByPeer = new Map<string, string[]>()
    const receivedDmByPeer = new Map<string, string[]>()
    const broadcastActions = new Map<string, any>()
    const dmActions = new Map<string, any>()

    for (const id of cluster250.peerIds) {
      receivedBroadcastByPeer.set(id, [])
      receivedDmByPeer.set(id, [])
      const room = cluster250.rooms.get(id)!
      const bcast = room.makeAction<string>('bcast250')
      bcast.onMessage(msg => {
        receivedBroadcastByPeer.get(id)!.push(msg)
      })
      broadcastActions.set(id, bcast)

      const dm = room.makeAction<string>('dm250')
      dm.onMessage(msg => {
        receivedDmByPeer.get(id)!.push(msg)
      })
      dmActions.set(id, dm)
    }

    const originId = cluster250.peerIds[0]!
    await broadcastActions.get(originId).send('hello-all-250-at-defaults')
    await waitFor(
      () =>
        cluster250.peerIds.every(
          id =>
            id === originId ||
            receivedBroadcastByPeer
              .get(id)!
              .includes('hello-all-250-at-defaults')
        ),
      8_000
    )

    // Pick the farthest peer from peer-0000 and verify multi-hop unicast delivery
    const originRoutes = cluster250.rooms.get(originId)!.getTopology().routes
    const [farthestPeerId, farthestRoute] = Object.entries(originRoutes).reduce(
      (best, cur) => (cur[1].hops > best[1].hops ? cur : best)
    )
    assert.ok(
      farthestRoute.hops >= 3,
      `expected farthest peer in N=250 cluster to be >= 3 hops away, got ${farthestRoute.hops}`
    )
    await dmActions
      .get(originId)
      .send('unicast-to-farthest-peer', {target: farthestPeerId})
    await waitFor(
      () =>
        receivedDmByPeer
          .get(farthestPeerId)!
          .includes('unicast-to-farthest-peer'),
      5_000
    )
  } finally {
    await cluster250.cleanup()
  }
})

void test('Liveness refresh on verified packets and descriptor seq-bump flood throttling', async () => {
  const appId = 'liveness-throttle-app'
  const roomId = 'liveness-throttle-room'
  const bobLeaves: string[] = []
  const bobDelivered: string[] = []
  const alicePid = testPeerId('live-alice')
  const relayPid = testPeerId('live-relay')
  const bobPid = testPeerId('live-bob')

  const alice = createOverlayManager({
    selfId: alicePid,
    appId,
    roomId,
    topology: {mode: 'gossip', maxConnections: 4},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })
  const relay = createOverlayManager({
    selfId: relayPid,
    appId,
    roomId,
    topology: {mode: 'gossip', maxConnections: 4},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })
  // Configure Bob with a short 350ms descriptorTtlMs, but block Alice's subsequent descriptor heartbeats at relay
  let blockAliceDescriptorsToBob = false
  let bobAcceptedAliceDescriptors = 0
  const bob = createOverlayManager({
    selfId: bobPid,
    appId,
    roomId,
    descriptorTtlMs: 350,
    topology: {mode: 'gossip', maxConnections: 4},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: id => bobLeaves.push(id),
    onDeliverData: (_from, data) =>
      bobDelivered.push(decodeBytes(new Uint8Array(data))),
    onPeerDescriptorCert: pid => {
      if (pid === alicePid) {
        bobAcceptedAliceDescriptors++
      }
    }
  })

  const makePipe = (
    fromId: string,
    to: ReturnType<typeof createOverlayManager>,
    filter?: (d: Uint8Array) => boolean
  ): PeerHandle => ({
    isDead: false,
    connection: {} as unknown as RTCPeerConnection,
    channel: {readyState: 'open'} as unknown as RTCDataChannel,
    getOffer: async () => undefined,
    signal: async () => undefined,
    sendData: (d: Uint8Array) => {
      if (filter && !filter(d)) {
        return
      }
      to.handleOverlayFrame(fromId, d.slice().buffer)
    },
    destroy: () => {},
    setHandlers: () => {},
    addStream: () => {},
    removeStream: () => {},
    addTrack: () => ({}) as never,
    removeTrack: () => {},
    replaceTrack: async () => {}
  })

  try {
    alice.addDirectPeer(relayPid, makePipe(alicePid, relay))
    relay.addDirectPeer(alicePid, makePipe(relayPid, alice))
    relay.addDirectPeer(
      bobPid,
      makePipe(relayPid, bob, d => {
        if (blockAliceDescriptorsToBob && d[1] === 1) {
          try {
            const msg = JSON.parse(decodeBytes(d.subarray(2)))
            if (
              msg.t === 'gossip' &&
              Array.isArray(msg.descriptors) &&
              msg.descriptors.some((desc: any) => desc.peerId === alicePid)
            ) {
              return false
            }
          } catch {}
        }
        return true
      })
    )
    bob.addDirectPeer(relayPid, makePipe(bobPid, relay))

    await waitFor(() => bob.getSnapshot().roomPeerIds.includes(alicePid), 2_000)

    // Block further descriptor heartbeats from Alice to Bob, but keep sending verified broadcasts from Alice every 100ms for 600ms (> 350ms TTL)
    blockAliceDescriptorsToBob = true
    for (let i = 1; i <= 5; i++) {
      await wait(110)
      await alice.broadcastInline(encodeBytes(`keepalive-${i}`))
    }
    await waitFor(() => bobDelivered.includes('keepalive-5'), 1_000)
    assert.ok(
      bob.getSnapshot().roomPeerIds.includes(alicePid) &&
        !bobLeaves.includes(alicePid),
      'verified data packets from origin must refresh descriptorReceivedAt liveness so active peers are not evicted by TTL'
    )

    // Now test content-agnostic descriptor flood throttling:
    // Flood 40 validly-signed descriptor updates for Alice alternating neighbor lists at >100/s;
    // at most the burst cap (8) are verified and accepted, while excess updates (>= 30) are throttled before verification and counted in signatureFailures.
    blockAliceDescriptorsToBob = false
    bobAcceptedAliceDescriptors = 0
    const aliceId = await alice.getLocalCryptoIdentity()
    for (let s = 500; s < 540; s++) {
      const d: any = {
        peerId: alicePid,
        seq: s,
        neighbors: s % 2 === 0 ? [relayPid] : [relayPid, 'alt-neighbor'].sort(),
        signPubKey: aliceId.signPubJwk,
        encPubKey: aliceId.encPubJwk
      }
      const canonical = encodeBytes(
        descriptorCanonicalPayload(d, appId, roomId)
      )
      d.sig = Buffer.from(
        await ecdsaSign(aliceId.signPrivateKey, canonical as BufferSource)
      ).toString('base64')
      bob.handleOverlayFrame(
        relayPid,
        packOverlayControl({t: 'gossip', descriptors: [d]}).slice().buffer
      )
    }
    await wait(80)
    assert.ok(
      bobAcceptedAliceDescriptors <= 17,
      `expected content-agnostic descriptor flood to verify and accept at most the burst cap, got ${bobAcceptedAliceDescriptors}`
    )
    assert.ok(
      bob.getSnapshot().stats.signatureFailures >= 23,
      `expected excess descriptor updates to be throttled before verification and counted as signatureFailures, got ${bob.getSnapshot().stats.signatureFailures}`
    )
  } finally {
    alice.destroy()
    relay.destroy()
    bob.destroy()
  }
})
