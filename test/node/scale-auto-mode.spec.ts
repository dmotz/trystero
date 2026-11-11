import assert from 'node:assert/strict'
import test from './test.ts'
import {actionWireVersion} from '../../packages/core/src/action-wire.ts'
import {roles} from '../../packages/core/src/authority.ts'
import {createUserIdentity} from '../../packages/core/src/identity.ts'
import createRoom from '../../packages/core/src/room.ts'
import {
  createOverlayManager,
  normalizeTopologyConfig,
  scale,
  unpackOverlayFrame
} from '../../packages/core/src/scale/index.ts'
import {defaultRequiredPeerIdleTtlMs} from '../../packages/core/src/scale/routing.ts'
import createTopicStrategy from '../../packages/core/src/topic-strategy.ts'
import type {PeerHandle} from '../../packages/core/src/internal-types.ts'
import type {UserIdentity} from '../../packages/core/src/types.ts'
import {
  createOverlayCluster,
  createTestScaleCluster
} from './overlay-harness.ts'
import {
  allocTestPeerIds,
  getTestEndpointByPeerId,
  joinAsTestPeer,
  LinkedPeer,
  MockRTCPeerConnection,
  testPeerId,
  wait,
  waitFor
} from './peer-harness.ts'

void test('Unified scale() config validation: accepts maxDirectPeers 4..32 (default 6) and rejects invalid or legacy configs', () => {
  assert.deepEqual(normalizeTopologyConfig(), {maxDirectPeers: 6})
  assert.deepEqual(normalizeTopologyConfig({}), {maxDirectPeers: 6})
  assert.deepEqual(normalizeTopologyConfig({maxDirectPeers: 4}), {
    maxDirectPeers: 4
  })
  assert.deepEqual(normalizeTopologyConfig({maxDirectPeers: 32}), {
    maxDirectPeers: 32
  })

  assert.equal(scale().name, 'scale')
  assert.equal(scale({maxDirectPeers: 8}).name, 'scale')

  for (const invalidShape of [
    'auto',
    'gossip',
    'mesh',
    'broadcast',
    null,
    [],
    42
  ]) {
    assert.throws(
      () => normalizeTopologyConfig(invalidShape as never),
      /scale config must be an object/
    )
    assert.throws(
      () => scale(invalidShape as never),
      /scale config must be an object/
    )
  }

  for (const invalidDegree of [
    3,
    33,
    0,
    -1,
    4.5,
    Number.NaN,
    Number.POSITIVE_INFINITY
  ]) {
    assert.throws(
      () => normalizeTopologyConfig({maxDirectPeers: invalidDegree}),
      /scale\.maxDirectPeers must be an integer between 4 and 32/
    )
    assert.throws(
      () => scale({maxDirectPeers: invalidDegree}),
      /scale\.maxDirectPeers must be an integer between 4 and 32/
    )
  }
})

void test('Unified scale(): full-mesh fast path below maxDirectPeers bypasses overlay ECDSA broadcast signing, multi-hop above maxDirectPeers, and TopologySnapshot immutability', async () => {
  const maxDirectPeers = 6

  // 1. Room size <= maxDirectPeers + 1 (6 peers, 5 remotes <= maxDirectPeers 6):
  //    Gossip forms a full direct mesh (0 virtual peers) and broadcasts bypass overlay ECDSA signing.
  const smallCluster = await createOverlayCluster({
    peerCount: 6,
    topology: {maxDirectPeers}
  })

  try {
    for (const id of smallCluster.peerIds) {
      const room = smallCluster.rooms.get(id)!
      const snap = room.getTopology()
      assert.equal(snap.peerId, id)
      assert.equal('selfId' in snap, false)
      assert.equal('mode' in snap, false)
      assert.equal('activeMode' in snap, false)
      assert.equal(snap.directPeerIds.length, 5)
      assert.equal(snap.roomPeerIds.length, 5)

      const peers = room.getPeers()
      assert.equal(Object.keys(peers).length, 5)
      for (const info of Object.values(peers)) {
        assert.equal(info.direct, true)
        assert.equal(info.hops, 1)
      }
    }

    const originId = smallCluster.peerIds[0]!
    const originRoom = smallCluster.rooms.get(originId)!
    const receivedOnSmall = new Map<string, string[]>()
    const chatSenders = new Map<string, (msg: string) => Promise<void>>()

    for (const id of smallCluster.peerIds) {
      receivedOnSmall.set(id, [])
      const action = smallCluster.rooms.get(id)!.makeAction<string>('mesh-fast')
      action.onMessage(msg => {
        receivedOnSmall.get(id)!.push(msg)
      })
      chatSenders.set(id, msg => action.send(msg))
    }

    // Ensure initial signed descriptor gossip has converged on originRoom so canBroadcastDirectMesh() is active
    const settleAction = originRoom.makeAction<string>('mesh-settle')
    for (const id of smallCluster.peerIds.slice(1)) {
      smallCluster.rooms
        .get(id)!
        .makeAction<string>('mesh-settle')
        .onMessage(() => {})
    }
    const settleDeadline = Date.now() + 3_000
    while (Date.now() < settleDeadline) {
      const before = originRoom.getTopology().stats.messagesSent
      await settleAction.send('probe')
      if (originRoom.getTopology().stats.messagesSent === before) {
        break
      }
      await wait(20)
    }
    await wait(20)

    const outboundFramesFromOrigin: Uint8Array[] = []
    for (const [key, pair] of smallCluster.directLinks.entries()) {
      const endpoint =
        pair.peerA.ownerId === originId
          ? pair.peerA
          : pair.peerB.ownerId === originId
            ? pair.peerB
            : null
      if (endpoint && key.includes(originId)) {
        const origSend = endpoint.sendData.bind(endpoint)
        endpoint.sendData = (data: Uint8Array) => {
          if (unpackOverlayFrame(data) === null) {
            outboundFramesFromOrigin.push(data.slice())
          }
          origSend(data)
        }
      }
    }

    const overlaySentBefore = originRoom.getTopology().stats.messagesSent
    await chatSenders.get(originId)!('direct-fast-path')

    await waitFor(
      () =>
        smallCluster.peerIds
          .slice(1)
          .every(id => receivedOnSmall.get(id)!.includes('direct-fast-path')),
      2_000
    )

    assert.equal(
      originRoom.getTopology().stats.messagesSent,
      overlaySentBefore,
      'full-mesh broadcast must bypass overlay broadcastInline signing path'
    )
    assert.equal(outboundFramesFromOrigin.length, 5)
    for (const frame of outboundFramesFromOrigin) {
      assert.equal(
        frame[0],
        actionWireVersion,
        'full-mesh fast path sends raw action-wire frames directly without overlay wrapping'
      )
      assert.equal(unpackOverlayFrame(frame), null)
    }
  } finally {
    await smallCluster.cleanup()
  }

  // 2. Room size > maxDirectPeers + 1 (20 distinct-user peers with maxDirectPeers: 6):
  //    Bounded-degree multi-hop gossip overlay with seamless broadcast & unicast routing + snapshot immutability.
  const peerCount = 20
  const expectedLargeIds = allocTestPeerIds(peerCount)
  const createdUsers = await Promise.all(
    Array.from({length: peerCount}, () => createUserIdentity())
  )
  const largeIdentities = new Map<string, UserIdentity>()
  for (let i = 0; i < peerCount; i++) {
    largeIdentities.set(expectedLargeIds[i]!, createdUsers[i]!)
  }
  const largeCluster = await createTestScaleCluster({
    peerCount,
    maxDirectPeers,
    identities: largeIdentities
  })

  try {
    let sawMultiHop = false
    for (const id of largeCluster.peerIds) {
      const snap = largeCluster.rooms.get(id)!.getTopology()
      assert.equal(snap.peerId, id)
      assert.equal('selfId' in snap, false)
      assert.equal('activeMode' in snap, false)
      assert.equal(snap.roomPeerIds.length, peerCount - 1)
      assert.equal(Object.keys(snap.routes).length, peerCount - 1)
      assert.ok(
        snap.directPeerIds.length <= maxDirectPeers * 2 &&
          snap.directPeerIds.length < peerCount - 1,
        `expected bounded direct degree, got ${snap.directPeerIds.length}`
      )
      if (Object.values(snap.routes).some(r => r.hops > 1)) {
        sawMultiHop = true
      }
    }
    assert.equal(sawMultiHop, true, '20-peer room forms multi-hop routes')

    // Verify TopologySnapshot deep-copy immutability
    const probeId = largeCluster.peerIds[0]!
    const probeRoom = largeCluster.rooms.get(probeId)!
    const snap1 = probeRoom.getTopology()
    const samplePeer = Object.keys(snap1.routes)[0]!
    const originalRoute = {...snap1.routes[samplePeer]!}
    const originalDirectLen = snap1.directPeerIds.length
    const originalRoomLen = snap1.roomPeerIds.length
    const originalSent = snap1.stats.messagesSent

    snap1.directPeerIds.push('corrupted-direct')
    snap1.roomPeerIds.length = 0
    snap1.stats.messagesSent = 999_999
    snap1.routes[samplePeer]!.hops = 999
    snap1.routes[samplePeer]!.nextHop = 'corrupted-hop'
    snap1.routes['injected-peer'] = {nextHop: 'corrupted-hop', hops: 77}

    const snap2 = probeRoom.getTopology()
    assert.equal(snap2.directPeerIds.length, originalDirectLen)
    assert.equal(snap2.directPeerIds.includes('corrupted-direct'), false)
    assert.equal(snap2.roomPeerIds.length, originalRoomLen)
    assert.equal(snap2.stats.messagesSent, originalSent)
    assert.deepEqual(snap2.routes[samplePeer], originalRoute)
    assert.equal(snap2.routes['injected-peer'], undefined)

    // Verify seamless multi-hop broadcast & unicast delivery
    const multiHopTargetId = largeCluster.peerIds.find(
      id =>
        id !== probeId &&
        (probeRoom.getTopology().routes[id]?.hops ?? 0) >= 2 &&
        !probeRoom.getTopology().directPeerIds.includes(id)
    )!
    assert.ok(multiHopTargetId, 'expected multi-hop virtual peer')

    const receivedBroadcast = new Set<string>()
    const receivedUnicast: string[] = []
    for (const id of largeCluster.peerIds) {
      const bcast = largeCluster.rooms.get(id)!.makeAction<string>('gossip-msg')
      bcast.onMessage(msg => {
        if (msg === 'hello-20') {
          receivedBroadcast.add(id)
        }
      })
      const ucast = largeCluster.rooms.get(id)!.makeAction<string>('direct-dm')
      ucast.onMessage(msg => {
        if (id === multiHopTargetId) {
          receivedUnicast.push(msg)
        }
      })
    }

    await probeRoom.makeAction<string>('gossip-msg').send('hello-20')
    await waitFor(() => receivedBroadcast.size === peerCount - 1, 5_000)
    assert.ok(probeRoom.getTopology().stats.messagesSent >= 1)

    await probeRoom
      .makeAction<string>('direct-dm')
      .send('secret-hop', {target: multiHopTargetId})
    await waitFor(() => receivedUnicast.includes('secret-hop'), 5_000)
  } finally {
    await largeCluster.cleanup()
  }
})

void test('localRequiredPeers expires after 60s idle TTL unless pinned by active media (setPeerMediaPinned)', () => {
  assert.equal(defaultRequiredPeerIdleTtlMs, 60_000)

  const [selfId, n1, n2, n3, n4, ...candidates] = allocTestPeerIds(16)
  const realDateNow = Date.now
  let fakeNow = 1_700_000_000_000
  Date.now = () => fakeNow

  const mgr = createOverlayManager({
    selfId: selfId!,
    appId: 'ttl-test-app',
    roomId: 'ttl-test-room',
    config: {maxDirectPeers: 4},
    getLocalEndpointIdentity: () => getTestEndpointByPeerId(selfId!),
    onVirtualPeerJoin: () => true,
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })

  try {
    for (const neighborId of [n1!, n2!, n3!, n4!]) {
      mgr.addDirectPeer(neighborId, new LinkedPeer() as unknown as PeerHandle)
    }
    for (const cid of candidates) {
      mgr.notePeerDiscovered(cid)
    }

    // Pick two candidates that are NOT algorithmic small-world target neighbors
    const baseTargets = mgr.getTargetNeighbors()
    const nonTargetCandidates = candidates.filter(cid => !baseTargets.has(cid))
    assert.ok(nonTargetCandidates.length >= 2)
    const idlePeerId = nonTargetCandidates[0]!
    const pinnedPeerId = nonTargetCandidates[1]!

    // At capacity (4 direct peers == maxDirectPeers): non-target candidates are not dialed outbound unless required
    assert.equal(mgr.getSnapshot().directPeerIds.length, 4)
    assert.equal(mgr.getTargetNeighbors().has(idlePeerId), false)
    assert.equal(mgr.shouldConnectPeer(idlePeerId, 'outbound'), false)
    assert.equal(mgr.getTargetNeighbors().has(pinnedPeerId), false)
    assert.equal(mgr.shouldConnectPeer(pinnedPeerId, 'outbound'), false)

    // Promote idlePeerId via requireDirectPeer and pin pinnedPeerId via setPeerMediaPinned
    mgr.requireDirectPeer(idlePeerId, {dial: false})
    mgr.setPeerMediaPinned(pinnedPeerId, true)

    assert.equal(mgr.getTargetNeighbors().has(idlePeerId), true)
    assert.equal(mgr.shouldConnectPeer(idlePeerId, 'outbound'), true)
    assert.equal(mgr.getTargetNeighbors().has(pinnedPeerId), true)
    assert.equal(mgr.shouldConnectPeer(pinnedPeerId, 'outbound'), true)

    // Just before 60s TTL (59,999 ms): idlePeerId is still required
    fakeNow += 59_999
    assert.equal(mgr.getTargetNeighbors().has(idlePeerId), true)
    assert.equal(mgr.shouldConnectPeer(idlePeerId, 'outbound'), true)

    // Past 60s idle TTL (60,001 ms): idlePeerId expires, preventing permanent degree bloat!
    fakeNow += 2
    assert.equal(mgr.getTargetNeighbors().has(idlePeerId), false)
    assert.equal(mgr.shouldConnectPeer(idlePeerId, 'outbound'), false)

    // Media-pinned peer stays required indefinitely while stream/track is active (e.g. 3 minutes later)
    fakeNow += 120_000
    assert.equal(mgr.getTargetNeighbors().has(pinnedPeerId), true)
    assert.equal(mgr.shouldConnectPeer(pinnedPeerId, 'outbound'), true)

    // Unpinning media grants a fresh 60s idle TTL window, then expires
    mgr.setPeerMediaPinned(pinnedPeerId, false)
    fakeNow += 59_999
    assert.equal(mgr.getTargetNeighbors().has(pinnedPeerId), true)
    fakeNow += 2
    assert.equal(mgr.getTargetNeighbors().has(pinnedPeerId), false)
    assert.equal(mgr.shouldConnectPeer(pinnedPeerId, 'outbound'), false)
  } finally {
    Date.now = realDateNow
    mgr.destroy()
  }
})

void test('End-to-end createTopicStrategy integration with unified scale() and use[] plugin validation', async () => {
  const topicSubs = new Map<string, Set<(topic: string, msg: string) => void>>()

  const makeJoinRoom = (peerId: string) =>
    joinAsTestPeer(
      peerId,
      createTopicStrategy({
        init: () => ({}),
        subscribeTopic: (_relay, topic, onMessage) => {
          let set = topicSubs.get(topic)
          if (!set) {
            set = new Set()
            topicSubs.set(topic, set)
          }
          const handler = (t: string, m: string) => {
            void onMessage(t, m)
          }
          set.add(handler)
          return () => {
            set?.delete(handler)
          }
        },
        publishTopic: (_relay, topic, msg) => {
          const handlers = topicSubs.get(topic)
          if (handlers) {
            const text = typeof msg === 'string' ? msg : JSON.stringify(msg)
            for (const h of handlers) {
              queueMicrotask(() => h(topic, text))
            }
          }
        }
      })
    )

  const roomA = makeJoinRoom('peer-alpha')(
    {
      appId: 'topic-e2e-overlay',
      use: [scale()],
      rtcPolyfill: MockRTCPeerConnection as unknown as typeof RTCPeerConnection
    },
    'lobby'
  )
  const roomB = makeJoinRoom('peer-beta')(
    {
      appId: 'topic-e2e-overlay',
      use: [scale({maxDirectPeers: 6})],
      rtcPolyfill: MockRTCPeerConnection as unknown as typeof RTCPeerConnection
    },
    'lobby'
  )

  try {
    await Promise.all([roomA.ready, roomB.ready])
    assert.equal(roomA.getTopology().peerId, (await roomA.getSelf()).peerId)
    assert.equal(roomB.getTopology().peerId, (await roomB.getSelf()).peerId)
  } finally {
    await Promise.all([roomA.leave(), roomB.leave()])
  }

  // Verify built-in use[] plugin validation rejects unknown or duplicate plugins
  const ep = getTestEndpointByPeerId(testPeerId('plugin-check'))
  assert.throws(
    () =>
      createRoom(
        () => {},
        () => {},
        () => {},
        {
          endpointIdentity: ep,
          appId: 'plugin-app',
          roomId: 'plugin-room',
          use: [{name: 'custom'} as never]
        }
      ),
    /invalid plugin in use\[\]; expected roles\(\) or scale\(\)/
  )
  assert.throws(
    () =>
      createRoom(
        () => {},
        () => {},
        () => {},
        {
          endpointIdentity: ep,
          appId: 'plugin-app',
          roomId: 'plugin-room',
          use: [scale(), scale()]
        }
      ),
    /duplicate plugin "scale" in use\[\]/
  )
  assert.throws(
    () =>
      createRoom(
        () => {},
        () => {},
        () => {},
        {
          endpointIdentity: ep,
          appId: 'plugin-app',
          roomId: 'plugin-room',
          use: [roles(), roles()]
        }
      ),
    /duplicate plugin "roles" in use\[\]/
  )
})
