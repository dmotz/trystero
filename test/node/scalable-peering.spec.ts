// @ts-nocheck
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compareStateRecords,
  computePayloadDigest,
  computePublicKeyFingerprint,
  createAdminRoom,
  formatSelfCertifyingRoomId,
  parseSelfCertifyingRoomId,
  roles,
  signRoleCertificate,
  verifyRoleCertificateChain
} from '../../packages/core/src/authority.ts'
import {
  computeUserIdFingerprint,
  createUserIdentity,
  exportUserIdentity
} from '../../packages/core/src/identity.ts'
import {inspectActionWireHeader} from '../../packages/core/src/action-wire.ts'
import {
  computeShortestPathRoutes,
  computeTargetNeighbors,
  createOverlayManager,
  normalizeTopologyConfig,
  overlayBroadcastKind,
  overlayUnicastKind,
  packOverlayBinary,
  packOverlayControl,
  scale,
  unpackOverlayBinary
} from '../../packages/core/src/overlay.ts'
import createRoom, {
  getRoomSignalingBridge
} from '../../packages/core/src/room.ts'
import {SharedPeerManager} from '../../packages/core/src/shared-peer.ts'
import createTopicStrategy from '../../packages/core/src/topic-strategy.ts'
import {
  decodeBytes,
  definePlugin,
  encodeBytes
} from '../../packages/core/src/utils.ts'
import {
  LinkedMediaPeer,
  LinkedPeer,
  linkPeers,
  MockRTCPeerConnection,
  wait,
  waitFor
} from './peer-harness.ts'

type VirtualNetworkOptions = {
  peerCount: number
  topology: any
  password?: string
  media?: boolean
}

/**
 * High-speed deterministic in-memory WebRTC + topic-signaling harness
 * capable of running 100–250 full `createRoom` instances in a single Node process.
 */
const createOverlayCluster = async ({
  peerCount,
  topology,
  password = '',
  media = false
}: VirtualNetworkOptions) => {
  const peerIds = Array.from(
    {length: peerCount},
    (_, i) => `peer-${String(i).padStart(4, '0')}`
  )
  const resolvedTopology =
    typeof topology === 'string' ? {mode: topology} : {...topology}

  const registerCallbacks = new Map<
    string,
    (peer: LinkedPeer, id: string) => void
  >()
  const rooms = new Map<string, ReturnType<typeof createRoom>>()
  const directLinks = new Map<string, {peerA: LinkedPeer; peerB: LinkedPeer}>()
  const joinedByPeer = new Map<string, Set<string>>()
  const leftByPeer = new Map<string, Set<string>>()
  let totalWireFrames = 0
  let totalAddStreamCalls = 0
  const addedTracks: string[] = []

  class InstrumentedPeer extends (media ? LinkedMediaPeer : LinkedPeer) {
    replaceTrackCalls = 0
    removeStreamCalls = 0
    lastReplacedTrack: any = null

    override sendData(data: Uint8Array) {
      if (this.isDead) {
        return
      }
      totalWireFrames++
      super.sendData(data)
    }

    override addStream(stream: any) {
      totalAddStreamCalls++
      addedTracks.push(...stream.getTracks().map(track => track.id))
      super.addStream(stream)
    }

    override addTrack(track: any, stream: any) {
      addedTracks.push(track.id)
      return super.addTrack(track, stream)
    }

    override removeStream(stream: any) {
      this.removeStreamCalls++
      super.removeStream(stream)
    }

    override replaceTrack(oldTrack: any, newTrack: any) {
      this.replaceTrackCalls++
      this.lastReplacedTrack = {oldTrack, newTrack}
      return Promise.resolve()
    }
  }

  const linkKey = (a: string, b: string) =>
    a < b ? `${a}<->${b}` : `${b}<->${a}`

  const connectPair = (idA: string, idB: string) => {
    if (idA === idB) {
      return
    }
    const key = linkKey(idA, idB)
    if (directLinks.has(key)) {
      return
    }
    const regA = registerCallbacks.get(idA)
    const regB = registerCallbacks.get(idB)
    if (!regA || !regB) {
      return
    }
    const {peerA, peerB} = linkPeers(
      new InstrumentedPeer(),
      new InstrumentedPeer()
    )
    const [firstId] = idA < idB ? [idA, idB] : [idB, idA]
    ;(peerA as any).ownerId = firstId === idA ? idA : idB
    ;(peerB as any).ownerId = firstId === idA ? idB : idA
    directLinks.set(key, {peerA, peerB})
    if (idA < idB) {
      regA(peerA, idB)
      regB(peerB, idA)
    } else {
      regB(peerA, idA)
      regA(peerB, idB)
    }
  }

  for (const id of peerIds) {
    const joined = new Set<string>()
    const left = new Set<string>()
    joinedByPeer.set(id, joined)
    leftByPeer.set(id, left)

    const room = createRoom(
      f => registerCallbacks.set(id, f),
      peerId => {
        for (const [k, pair] of directLinks.entries()) {
          if (k === linkKey(id, peerId)) {
            directLinks.delete(k)
            pair.peerA.destroy()
            pair.peerB.destroy()
          }
        }
      },
      () => {},
      {
        selfId: id,
        appId: 'scale-test-app',
        roomId: 'scale-test-room',
        password,
        ...scale(resolvedTopology)
      }
    )

    room.onPeerJoin = ({peerId}) => {
      left.delete(peerId)
      joined.add(peerId)
    }
    room.onPeerLeave = ({peerId}) => {
      joined.delete(peerId)
      left.add(peerId)
    }

    rooms.set(id, room)
  }

  const norm = normalizeTopologyConfig(resolvedTopology)
  const activeSet = new Set(peerIds)

  const syncTargetGraph = () => {
    const effectiveMode =
      norm.mode === 'auto'
        ? activeSet.size > norm.autoThreshold
          ? 'gossip'
          : 'mesh'
        : norm.mode

    for (const id of activeSet) {
      const targets = computeTargetNeighbors(
        id,
        activeSet,
        effectiveMode,
        norm.maxConnections,
        norm.fanout
      )
      for (const targetId of targets) {
        if (activeSet.has(targetId)) {
          connectPair(id, targetId)
        }
      }
    }
  }

  const waitForTopologyConvergence = async () => {
    await waitFor(() => {
      for (const id of activeSet) {
        if (
          rooms.get(id)!.getTopology().roomPeerIds.length <
          activeSet.size - 1
        ) {
          return false
        }
      }
      return true
    }, 5_000)
    await wait(20)
  }

  syncTargetGraph()
  await waitForTopologyConvergence()

  const dropPeer = (id: string) => {
    if (!activeSet.has(id)) {
      return
    }
    activeSet.delete(id)
    registerCallbacks.delete(id)

    const survivingEndpoints: LinkedPeer[] = []
    for (const [key, pair] of directLinks.entries()) {
      if (key.startsWith(`${id}<->`) || key.endsWith(`<->${id}`)) {
        directLinks.delete(key)
        const isFirst = key.startsWith(`${id}<->`)
        const deadEndpoint = isFirst ? pair.peerA : pair.peerB
        const survivingEndpoint = isFirst ? pair.peerB : pair.peerA
        deadEndpoint.isDead = true
        deadEndpoint.handlers = {}
        survivingEndpoints.push(survivingEndpoint)
      }
    }
    for (const endpoint of survivingEndpoints) {
      endpoint.destroy()
    }
  }

  const healCluster = async () => {
    syncTargetGraph()
    await waitForTopologyConvergence()
  }

  const cleanup = async () => {
    for (const pair of directLinks.values()) {
      pair.peerA.destroy()
      pair.peerB.destroy()
    }
    directLinks.clear()
    await Promise.all([...rooms.values()].map(room => room.leave()))
  }

  return {
    peerIds,
    activeSet,
    rooms,
    directLinks,
    addedTracks,
    joinedByPeer,
    leftByPeer,
    connectPair,
    dropPeer,
    healCluster,
    cleanup,
    getStats: () => ({
      totalWireFrames,
      totalAddStreamCalls,
      directEdgeCount: directLinks.size
    }),
    resetStats: () => {
      totalWireFrames = 0
      totalAddStreamCalls = 0
    }
  }
}

void test('Topology algorithms: symmetric gossip and broadcast neighbor selection & shortest-path routing', () => {
  const peerCount = 200
  const peerIds = Array.from(
    {length: peerCount},
    (_, i) => `peer-${String(i).padStart(4, '0')}`
  )

  for (const mode of ['gossip', 'broadcast'] as const) {
    const maxConnections = 8
    const fanout = 3
    const adjacency = new Map<string, Set<string>>()

    for (const id of peerIds) {
      adjacency.set(
        id,
        computeTargetNeighbors(id, peerIds, mode, maxConnections, fanout)
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
    const routes = computeShortestPathRoutes(
      peerIds[0],
      adjacency,
      adjacency.get(peerIds[0])!
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

void test('Data-only scale: 150-peer text chat broadcast & high-frequency cursor updates over gossip overlay', async () => {
  const peerCount = 150
  const maxConnections = 8
  const cluster = await createOverlayCluster({
    peerCount,
    topology: {mode: 'gossip', maxConnections, minConnections: 4, redundancy: 1}
  })

  try {
    // 1. Verify bounded direct connections and full room discovery
    for (const id of cluster.peerIds) {
      const snap = cluster.rooms.get(id)!.getTopology()
      assert.equal(snap.activeMode, 'gossip')
      assert.ok(
        snap.directPeerIds.length <= maxConnections,
        `peer ${id} has ${snap.directPeerIds.length} direct peers, expected <= ${maxConnections}`
      )
      assert.equal(
        snap.roomPeerIds.length,
        peerCount - 1,
        `peer ${id} should know all ${peerCount - 1} room peers via overlay`
      )
      assert.equal(
        cluster.joinedByPeer.get(id)!.size,
        peerCount - 1,
        `peer ${id} should have fired onPeerJoin for all ${peerCount - 1} peers`
      )
    }

    // 2. Register chat action and cursor action on all 150 peers
    const receivedChat = new Map<
      string,
      Array<{text: string; from: string; meta: any}>
    >()
    const receivedCursors = new Map<
      string,
      Map<string, {x: number; y: number; seq: number}>
    >()
    const chatSenders = new Map<string, any>()
    const cursorSenders = new Map<string, any>()

    for (const id of cluster.peerIds) {
      receivedChat.set(id, [])
      receivedCursors.set(id, new Map())
      const room = cluster.rooms.get(id)!

      const chat = room.makeAction<{text: string}>('chat', {
        onMessage: (payload, {peerId, metadata}) => {
          receivedChat.get(id)!.push({
            text: payload.text,
            from: peerId,
            meta: metadata
          })
        }
      })
      chatSenders.set(id, chat)

      const cursor = room.makeAction<{x: number; y: number; seq: number}>(
        'cursor',
        {
          onMessage: (payload, {peerId}) => {
            receivedCursors.get(id)!.set(peerId, payload)
          }
        }
      )
      cursorSenders.set(id, cursor)
    }

    // 3. Test room-wide chat broadcast from 5 spread-out speakers
    cluster.resetStats()
    const speakers = [
      'peer-0000',
      'peer-0037',
      'peer-0075',
      'peer-0112',
      'peer-0149'
    ]
    for (const speaker of speakers) {
      await chatSenders
        .get(speaker)
        .send({text: `hello from ${speaker}`}, {metadata: {channel: 'general'}})
    }

    await waitFor(() =>
      cluster.peerIds.every(
        id =>
          receivedChat.get(id)!.length ===
          (speakers.includes(id) ? speakers.length - 1 : speakers.length)
      )
    )

    // Verify sender attribution and metadata integrity across multiple hops
    for (const id of cluster.peerIds) {
      const msgs = receivedChat.get(id)!
      for (const speaker of speakers) {
        if (speaker === id) {
          continue
        }
        const match = msgs.find(m => m.from === speaker)
        assert.ok(match, `peer ${id} missed chat message from ${speaker}`)
        assert.equal(match.text, `hello from ${speaker}`)
        assert.deepEqual(match.meta, {channel: 'general'})
      }
    }

    // 4. High-frequency shared cursor updates from 20 concurrent active peers
    const activeMovers = cluster.peerIds.slice(0, 20)
    for (let step = 1; step <= 3; step++) {
      await Promise.all(
        activeMovers.map((moverId, idx) =>
          cursorSenders.get(moverId).send({
            x: idx * 10 + step,
            y: idx * 20 + step,
            seq: step
          })
        )
      )
    }

    await waitFor(() =>
      cluster.peerIds.every(id => {
        const map = receivedCursors.get(id)!
        return activeMovers.every(
          moverId => moverId === id || map.get(moverId)?.seq === 3
        )
      })
    )
  } finally {
    await cluster.cleanup()
  }
})

void test('Multi-hop unicast: targeted send, ping, RPC request/requestMany, and chunked binary transfer (>16 KiB)', async () => {
  const peerCount = 40
  const cluster = await createOverlayCluster({
    peerCount,
    topology: {
      mode: 'gossip',
      maxConnections: 4,
      minConnections: 2,
      redundancy: 1
    }
  })

  try {
    const sourceId = 'peer-0000'
    const sourceRoom = cluster.rooms.get(sourceId)!
    const sourceSnap = sourceRoom.getTopology()

    // Find a peer that is at least 3 hops away (not directly connected)
    const farEntry = Object.entries(sourceSnap.routes).find(
      ([, route]) => route.hops >= 3
    )
    assert.ok(farEntry, 'expected at least one peer >= 3 hops away')
    const [farPeerId, farRoute] = farEntry
    assert.ok(
      !sourceSnap.directPeerIds.includes(farPeerId),
      `${farPeerId} must not be a direct neighbor of ${sourceId}`
    )
    assert.ok(farRoute.hops >= 3)

    // 1. Multi-hop ping
    const rtt = await sourceRoom.ping(farPeerId)
    assert.ok(
      typeof rtt === 'number' && rtt >= 0,
      `expected valid multi-hop ping RTT, got ${rtt}`
    )

    // 2. Multi-hop targeted message action (must only arrive at farPeerId)
    const dmReceived = new Map<string, Array<{body: string; from: string}>>()
    const dmActions = new Map<string, any>()
    for (const id of cluster.peerIds) {
      dmReceived.set(id, [])
      dmActions.set(
        id,
        cluster.rooms.get(id)!.makeAction<{body: string}>('dm', {
          onMessage: (data, {peerId}) => {
            dmReceived.get(id)!.push({body: data.body, from: peerId})
          }
        })
      )
    }

    await dmActions
      .get(sourceId)
      .send({body: 'secret-multi-hop-dm'}, {target: farPeerId})

    await waitFor(() => dmReceived.get(farPeerId)!.length === 1)
    assert.deepEqual(dmReceived.get(farPeerId)![0], {
      body: 'secret-multi-hop-dm',
      from: sourceId
    })
    for (const id of cluster.peerIds) {
      if (id !== farPeerId) {
        assert.equal(
          dmReceived.get(id)!.length,
          0,
          `non-target peer ${id} should not receive DM`
        )
      }
    }

    // 3. Multi-hop RPC request & requestMany
    const rpcActions = new Map<string, any>()
    for (const id of cluster.peerIds) {
      rpcActions.set(
        id,
        cluster.rooms
          .get(id)!
          .makeAction<{q: number}, {ans: number; responder: string}>(
            'compute',
            {
              kind: 'request',
              onRequest: (payload, {peerId}) => ({
                ans: payload.q * 2,
                responder: `${id}-for-${peerId}`
              })
            }
          )
      )
    }

    const singleResp = await rpcActions
      .get(sourceId)
      .request({q: 21}, {target: farPeerId})
    assert.deepEqual(singleResp, {
      ans: 42,
      responder: `${farPeerId}-for-${sourceId}`
    })

    const multiHopTargets = Object.entries(sourceSnap.routes)
      .filter(([, r]) => r.hops >= 2)
      .slice(0, 5)
      .map(([id]) => id)
    const manyRes = await rpcActions
      .get(sourceId)
      .requestMany({q: 10}, {targets: multiHopTargets})
    assert.equal(manyRes.length, multiHopTargets.length)
    for (const res of manyRes) {
      assert.equal(res.status, 'fulfilled')
      assert.equal(res.value.ans, 20)
    }

    // 4. Multi-hop multi-chunk binary payload transfer (64 KiB > 16 KiB frame limit)
    const blobBytes = new Uint8Array(64 * 1024)
    for (let i = 0; i < blobBytes.length; i++) {
      blobBytes[i] = (i * 31 + 7) & 0xff
    }

    let receivedBinary: {bytes: Uint8Array; from: string; meta: any} | null =
      null
    const progressUpdates: number[] = []
    const fileActions = new Map<string, any>()

    for (const id of cluster.peerIds) {
      fileActions.set(
        id,
        cluster.rooms.get(id)!.makeAction<Uint8Array>('file-xfer', {
          onMessage: (data, {peerId, metadata}) => {
            if (id === farPeerId) {
              receivedBinary = {
                bytes: new Uint8Array(
                  data instanceof ArrayBuffer
                    ? data
                    : data.buffer.slice(
                        data.byteOffset,
                        data.byteOffset + data.byteLength
                      )
                ),
                from: peerId,
                meta: metadata
              }
            }
          }
        })
      )
    }

    await fileActions.get(sourceId).send(blobBytes, {
      target: farPeerId,
      metadata: {name: 'archive.bin'},
      onProgress: (pct: number) => progressUpdates.push(pct)
    })

    await waitFor(() => receivedBinary !== null)
    assert.equal(receivedBinary!.from, sourceId)
    assert.deepEqual(receivedBinary!.meta, {name: 'archive.bin'})
    assert.equal(receivedBinary!.bytes.byteLength, blobBytes.byteLength)
    assert.deepEqual(receivedBinary!.bytes, blobBytes)
    assert.ok(
      progressUpdates.length >= 4 && progressUpdates.at(-1) === 1,
      `expected multi-chunk progress updates ending at 1, got ${progressUpdates.length}`
    )
  } finally {
    await cluster.cleanup()
  }
})

void test('Media streaming at scale: 100-peer ALM broadcast tree, track replacement, and stream removal', async () => {
  const peerCount = 100
  const fanout = 4
  const cluster = await createOverlayCluster({
    peerCount,
    topology: {mode: 'broadcast', maxConnections: 8, fanout},
    media: true
  })

  try {
    const broadcasterId = 'peer-0000'
    const broadcasterRoom = cluster.rooms.get(broadcasterId)!

    const streamDeliveries = new Map<
      string,
      {streamId: string; from: string; meta: any}
    >()
    const trackDeliveries = new Map<
      string,
      Array<{trackId: string; from: string; meta: any}>
    >()

    for (const id of cluster.peerIds) {
      trackDeliveries.set(id, [])
      const room = cluster.rooms.get(id)!
      room.onPeerStream = (stream, {peerId, metadata}) => {
        streamDeliveries.set(id, {
          streamId: stream.id,
          from: peerId,
          meta: metadata
        })
      }
      room.onPeerTrack = (track, _stream, {peerId, metadata}) => {
        trackDeliveries.get(id)!.push({
          trackId: track.id,
          from: peerId,
          meta: metadata
        })
      }
    }

    cluster.resetStats()
    const videoTrack1 = {id: 'video-track-1080p'} as unknown as MediaStreamTrack
    const liveStream = {
      id: 'main-broadcast-stream',
      getTracks: () => [videoTrack1]
    } as unknown as MediaStream

    await Promise.all(
      broadcasterRoom.addStream(liveStream, {
        metadata: {title: 'Keynote Live', fps: 60}
      })
    )

    await waitFor(() => streamDeliveries.size === peerCount - 1, 3_000)

    // Every single receiver (99 peers) must attribute the stream to broadcasterId!
    for (const id of cluster.peerIds) {
      if (id === broadcasterId) {
        continue
      }
      const delivery = streamDeliveries.get(id)
      assert.ok(delivery, `peer ${id} did not receive broadcast stream`)
      assert.equal(
        delivery.from,
        broadcasterId,
        `peer ${id} saw stream from ${delivery.from} instead of origin ${broadcasterId}`
      )
      assert.equal(delivery.streamId, 'main-broadcast-stream')
      assert.deepEqual(delivery.meta, {title: 'Keynote Live', fps: 60})
    }

    // Verify broadcaster only forwarded to <= fanout direct children (not 99 peers)
    const broadcasterTree =
      broadcasterRoom.getTopology().mediaTrees[broadcasterId]
    assert.ok(broadcasterTree)
    assert.ok(
      broadcasterTree.childrenIds.length <= fanout,
      `broadcaster children (${broadcasterTree.childrenIds.length}) exceeded fanout (${fanout})`
    )

    // Test multi-hop replaceTrack cascading down the media tree
    const videoTrack2 = {
      id: 'video-track-4k-screenshare'
    } as unknown as MediaStreamTrack
    await Promise.all(
      broadcasterRoom.replaceTrack(videoTrack1, videoTrack2, {
        metadata: {mode: 'screenshare'}
      })
    )

    await waitFor(() =>
      cluster.peerIds.every(
        id =>
          id === broadcasterId ||
          trackDeliveries.get(id)!.some(t => t.meta?.mode === 'screenshare')
      )
    )

    for (const id of cluster.peerIds) {
      if (id === broadcasterId) {
        continue
      }
      const replaced = trackDeliveries
        .get(id)!
        .find(t => t.meta?.mode === 'screenshare')
      assert.ok(replaced, `peer ${id} did not receive replaced track`)
      assert.equal(replaced.from, broadcasterId)
      assert.deepEqual(replaced.meta, {mode: 'screenshare'})
    }

    let totalReplaceTrackCalls = 0
    for (const pair of cluster.directLinks.values()) {
      totalReplaceTrackCalls +=
        (pair.peerA as any).replaceTrackCalls +
        (pair.peerB as any).replaceTrackCalls
    }
    assert.equal(
      totalReplaceTrackCalls,
      peerCount - 1,
      `expected replaceTrack to cascade across all ${peerCount - 1} tree edges`
    )

    // Test multi-hop removeStream cascading down the media tree
    broadcasterRoom.removeStream(liveStream)
    await waitFor(() => {
      let count = 0
      for (const pair of cluster.directLinks.values()) {
        count +=
          (pair.peerA as any).removeStreamCalls +
          (pair.peerB as any).removeStreamCalls
      }
      return count === peerCount - 1
    }, 3_000)

    let totalRemoveStreamCalls = 0
    for (const pair of cluster.directLinks.values()) {
      totalRemoveStreamCalls +=
        (pair.peerA as any).removeStreamCalls +
        (pair.peerB as any).removeStreamCalls
    }
    assert.equal(
      totalRemoveStreamCalls,
      peerCount - 1,
      `expected removeStream to cascade across all ${peerCount - 1} tree edges`
    )
  } finally {
    await cluster.cleanup()
  }
})

void test('Peer dropping & mesh-breaking scenarios: 25% mass churn, targeted relay drop, and media tree self-healing', async () => {
  const peerCount = 80
  const cluster = await createOverlayCluster({
    peerCount,
    topology: {
      mode: 'gossip',
      maxConnections: 8,
      minConnections: 4,
      fanout: 3,
      redundancy: 2
    },
    media: true
  })

  try {
    const receivedAlerts = new Map<string, Set<string>>()
    const alertActions = new Map<string, any>()
    const streamSeenBy = new Set<string>()

    for (const id of cluster.peerIds) {
      receivedAlerts.set(id, new Set())
      const room = cluster.rooms.get(id)!
      alertActions.set(
        id,
        room.makeAction<{alertId: string}>('alert', {
          onMessage: ({alertId}) => {
            receivedAlerts.get(id)!.add(alertId)
          }
        })
      )
      room.onPeerStream = (_stream, {peerId}) => {
        if (peerId === 'peer-0000') {
          streamSeenBy.add(id)
        }
      }
    }

    // Start a broadcast media stream from peer-0000 before churn
    const stream = {
      id: 'resilient-stream',
      getTracks: () => [{id: 'audio-track-1'}]
    } as unknown as MediaStream
    await Promise.all(cluster.rooms.get('peer-0000')!.addStream(stream))
    await waitFor(() => streamSeenBy.size === peerCount - 1)

    // 1. Targeted Relay Drop: find all direct children of peer-0000 in the media tree and drop half of them,
    // plus drop 25% of random nodes across the mesh (20 nodes dropped simultaneously!)
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

    // Verify media tree automatically re-parented children whose parents were dropped
    let totalTreeReparents = 0
    for (const id of survivors) {
      totalTreeReparents += cluster.rooms.get(id)!.getTopology()
        .stats.treeReparents
    }
    assert.ok(
      totalTreeReparents > 0,
      'expected media broadcast tree to record automatic re-parenting after relay drops'
    )

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

    // 3. Verify surviving peers fired onPeerLeave for dropped neighbors
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

void test('Plumtree lazy repair (ihave / iwant) recovers broadcasts when an eager push link drops a frame', async () => {
  const delivered: Array<{from: string; text: string}> = []
  const sentToB: Uint8Array[] = []
  const sentToA: Uint8Array[] = []

  const overlayA = createOverlayManager({
    selfId: 'peer-A',
    topology: {mode: 'gossip', maxConnections: 4},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })

  const overlayB = createOverlayManager({
    selfId: 'peer-B',
    topology: {mode: 'gossip', maxConnections: 4},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: (origin, data) => {
      delivered.push({
        from: origin,
        text: decodeBytes(new Uint8Array(data))
      })
    }
  })

  const peerHandleAtoB = {
    isDead: false,
    connection: {} as any,
    channel: {readyState: 'open'} as any,
    getOffer: async () => undefined,
    signal: async () => undefined,
    sendData: (data: Uint8Array) => {
      sentToB.push(data.slice())
      overlayB.handleOverlayFrame('peer-A', data.slice().buffer)
    },
    destroy: () => {},
    setHandlers: () => {},
    addStream: () => {},
    removeStream: () => {},
    addTrack: () => ({}) as any,
    removeTrack: () => {},
    replaceTrack: async () => {}
  }

  const peerHandleBtoA = {
    ...peerHandleAtoB,
    sendData: (data: Uint8Array) => {
      sentToA.push(data.slice())
      overlayA.handleOverlayFrame('peer-B', data.slice().buffer)
    }
  }

  overlayA.addDirectPeer('peer-B', peerHandleAtoB)
  overlayB.addDirectPeer('peer-A', peerHandleBtoA)
  await wait(40)

  // Peer A broadcasts a signed frame while eager push to B is temporarily dropped
  const payload = encodeBytes('recovered-via-lazy-iwant')
  let droppedMsgId = ''
  const savedSend = peerHandleAtoB.sendData
  peerHandleAtoB.sendData = (data: Uint8Array) => {
    const parsed = unpackOverlayBinary(data)
    if (parsed?.kind === overlayBroadcastKind) {
      droppedMsgId = parsed.header['m'] as string
      return
    }
    savedSend(data)
  }
  await overlayA.broadcastInline(payload)
  await wait(10)
  peerHandleAtoB.sendData = savedSend

  assert.ok(droppedMsgId, 'expected eager broadcast packet to be intercepted')
  assert.equal(
    delivered.length,
    0,
    'B should not have received the dropped eager frame yet'
  )

  // Now A sends an ihave lazy advertisement to B
  overlayB.handleOverlayFrame(
    'peer-A',
    packOverlayControl({
      t: 'ihave',
      items: [{m: droppedMsgId, o: 'peer-A'}]
    }).slice().buffer
  )

  await waitFor(() => delivered.length === 1, 1_000)
  assert.deepEqual(delivered[0], {
    from: 'peer-A',
    text: 'recovered-via-lazy-iwant'
  })
  assert.equal(overlayB.getSnapshot().stats.lazyRepairsSent, 1)
  assert.equal(overlayA.getSnapshot().stats.lazyRepairsResolved, 1)

  overlayA.destroy()
  overlayB.destroy()
})

void test('Security: ECDSA P-256 packet signing, TOFU key pinning, tamper rejection, and ECDH end-to-end unicast encryption', async () => {
  // Create a 3-hop chain: Alice <-> Relay <-> Bob
  const wireTapOnRelay: Uint8Array[] = []
  const aliceDelivered: string[] = []
  const bobDelivered: Array<{from: string; text: string}> = []

  const alice = createOverlayManager({
    selfId: 'alice',
    appId: 'sec-app',
    roomId: 'sec-room',
    password: 'correct-horse-battery-staple',
    topology: {mode: 'gossip', maxConnections: 2},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: (_origin, data) => {
      aliceDelivered.push(decodeBytes(new Uint8Array(data)))
    }
  })

  const relay = createOverlayManager({
    selfId: 'relay',
    appId: 'sec-app',
    roomId: 'sec-room',
    password: 'correct-horse-battery-staple',
    topology: {mode: 'gossip', maxConnections: 2},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })

  const bob = createOverlayManager({
    selfId: 'bob',
    appId: 'sec-app',
    roomId: 'sec-room',
    password: 'correct-horse-battery-staple',
    topology: {mode: 'gossip', maxConnections: 2},
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

  // Connect Alice <-> Relay and Relay <-> Bob (Alice and Bob have no direct link)
  alice.addDirectPeer(
    'relay',
    makePipe('alice', relay, b => wireTapOnRelay.push(b))
  )
  relay.addDirectPeer('alice', makePipe('relay', alice))
  relay.addDirectPeer(
    'bob',
    makePipe('relay', bob, b => wireTapOnRelay.push(b))
  )
  bob.addDirectPeer('relay', makePipe('bob', relay))

  // Wait for signed descriptors (with ECDSA + ECDH public keys) to propagate between Alice and Bob
  await waitFor(
    () =>
      alice.getSnapshot().roomPeerIds.includes('bob') &&
      bob.getSnapshot().roomPeerIds.includes('alice'),
    2_000
  )
  await wait(60)

  // 1. End-to-End Encrypted Unicast from Alice -> Bob through Relay
  wireTapOnRelay.length = 0
  const secretPlaintext = 'TOP-SECRET-LAUNCH-CODES-987654321'
  alice.sendUnicast('bob', encodeBytes(secretPlaintext))

  await waitFor(() => bobDelivered.length === 1, 2_000)
  assert.deepEqual(bobDelivered[0], {
    from: 'alice',
    text: secretPlaintext
  })

  // Verify the intermediate relay NEVER saw the plaintext bytes on the wire!
  assert.ok(
    wireTapOnRelay.length > 0,
    'expected unicast frames to traverse relay'
  )
  for (const frame of wireTapOnRelay) {
    const rawText = decodeBytes(frame)
    assert.ok(
      !rawText.includes(secretPlaintext),
      'intermediate relay must not be able to read E2EE unicast payload'
    )
  }

  // 2. Tampered broadcast payload in transit must be rejected by Bob's ECDSA verification
  const tamperedPayload = encodeBytes('TAMPERED-BY-MALICIOUS-RELAY')
  const forgedPacket = packOverlayBinary(
    overlayBroadcastKind,
    6,
    {
      o: 'alice',
      m: 'alice:forged-msg-1',
      s: 'AAAA_invalid_ecdsa_signature_AAAA'
    },
    tamperedPayload
  )
  bob.handleOverlayFrame('relay', forgedPacket.slice().buffer)
  await wait(40)

  assert.equal(
    bobDelivered.length,
    1,
    'tampered broadcast with invalid ECDSA signature must be dropped'
  )
  assert.ok(
    bob.getSnapshot().stats.signatureFailures >= 1,
    'expected signatureFailures counter to increment on tampered packet'
  )

  // 3. Unsigned packet spoofing a peer with a pinned TOFU key must be rejected
  const unsignedSpoofPacket = packOverlayBinary(
    overlayBroadcastKind,
    6,
    {o: 'alice', m: 'alice:unsigned-spoof-2'},
    encodeBytes('UNSIGNED-SPOOF')
  )
  const failuresBefore = bob.getSnapshot().stats.signatureFailures
  bob.handleOverlayFrame('relay', unsignedSpoofPacket.slice().buffer)
  await wait(40)
  assert.equal(bob.getSnapshot().stats.signatureFailures, failuresBefore + 1)
  assert.equal(bobDelivered.length, 1)

  // 4. Descriptor with wrong room password or spoofed key must be rejected
  const failuresBeforeDesc = bob.getSnapshot().stats.signatureFailures
  bob.handleOverlayFrame(
    'relay',
    packOverlayControl({
      t: 'gossip',
      descriptors: [
        {
          peerId: 'mallory',
          seq: 1,
          neighbors: ['relay'],
          roomAuth: 'wrong-password-hmac'
        }
      ]
    }).slice().buffer
  )
  await wait(40)
  assert.equal(
    bob.getSnapshot().stats.signatureFailures,
    failuresBeforeDesc + 1
  )
  assert.ok(!bob.getSnapshot().roomPeerIds.includes('mallory'))

  alice.destroy()
  relay.destroy()
  bob.destroy()
})

void test('Elegant API & automatic configuration: joinRoom with scale "auto" transitions from mesh to gossip at threshold', async () => {
  const peerCount = 24
  const autoThreshold = 8
  const maxConnections = 6

  // Verify normalizeTopologyConfig supports both string shorthand and full config object
  assert.equal(normalizeTopologyConfig().mode, 'auto')
  assert.equal(normalizeTopologyConfig('mesh').mode, 'mesh')
  assert.equal(normalizeTopologyConfig('gossip').mode, 'gossip')
  assert.equal(normalizeTopologyConfig('broadcast').mode, 'broadcast')
  assert.equal(normalizeTopologyConfig('auto').mode, 'auto')

  // Start with 6 peers (<= autoThreshold of 8): should remain in 'mesh' mode
  const smallCluster = await createOverlayCluster({
    peerCount: 6,
    topology: {mode: 'auto', autoThreshold, maxConnections}
  })

  try {
    for (const id of smallCluster.peerIds) {
      const snap = smallCluster.rooms.get(id)!.getTopology()
      assert.equal(snap.mode, 'auto')
      assert.equal(
        snap.activeMode,
        'mesh',
        'room below autoThreshold should stay in full mesh mode'
      )
      assert.equal(snap.directPeerIds.length, 5)
    }
  } finally {
    await smallCluster.cleanup()
  }

  // Now scale to 24 peers (> autoThreshold of 8): should automatically switch to 'gossip'
  const largeCluster = await createOverlayCluster({
    peerCount,
    topology: {mode: 'auto', autoThreshold, maxConnections}
  })

  try {
    for (const id of largeCluster.peerIds) {
      const snap = largeCluster.rooms.get(id)!.getTopology()
      assert.equal(snap.mode, 'auto')
      assert.equal(
        snap.activeMode,
        'gossip',
        'room above autoThreshold should automatically switch to gossip'
      )
      assert.ok(snap.directPeerIds.length <= maxConnections)
      assert.equal(snap.roomPeerIds.length, peerCount - 1)
    }
  } finally {
    await largeCluster.cleanup()
  }
})

void test('End-to-end createTopicStrategy integration with config._test_only_forcedPeerId and scale()', async () => {
  const topicSubs = new Map<string, Set<(topic: string, msg: string) => void>>()

  const joinRoom = createTopicStrategy({
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

  const roomA = joinRoom(
    {
      appId: 'topic-e2e-overlay',
      _test_only_forcedPeerId: 'peer-alpha',
      ...scale('gossip'),
      rtcPolyfill: MockRTCPeerConnection as any
    },
    'lobby'
  )
  const roomB = joinRoom(
    {
      appId: 'topic-e2e-overlay',
      _test_only_forcedPeerId: 'peer-beta',
      ...scale({mode: 'gossip', maxConnections: 6}),
      rtcPolyfill: MockRTCPeerConnection as any
    },
    'lobby'
  )

  try {
    assert.equal(roomA.getTopology().selfId, 'peer-alpha')
    assert.equal(roomA.getTopology().mode, 'gossip')
    assert.equal(roomB.getTopology().selfId, 'peer-beta')
    assert.equal(roomB.getTopology().activeMode, 'gossip')
  } finally {
    await Promise.all([roomA.leave(), roomB.leave()])
  }
})

void test('Adversarial peer attacks: TOFU key-hijack attempt, forged leave/down eviction DoS, replay floods, TTL amplification, and deduplication cache-poisoning resistance', async () => {
  const relayedToBobFrames: Uint8Array[] = []
  const aliceToRelayFrames: Uint8Array[] = []
  const bobDelivered: Array<{from: string; text: string}> = []

  const alice = createOverlayManager({
    selfId: 'alice',
    appId: 'adv-app',
    roomId: 'adv-room',
    password: 'shared-room-secret',
    topology: {
      mode: 'gossip',
      maxConnections: 2,
      maxHops: 4
    },
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })

  const relay = createOverlayManager({
    selfId: 'relay',
    appId: 'adv-app',
    roomId: 'adv-room',
    password: 'shared-room-secret',
    topology: {
      mode: 'gossip',
      maxConnections: 2,
      maxHops: 4
    },
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })

  const bob = createOverlayManager({
    selfId: 'bob',
    appId: 'adv-app',
    roomId: 'adv-room',
    password: 'shared-room-secret',
    topology: {
      mode: 'gossip',
      maxConnections: 2,
      maxHops: 4
    },
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
    'relay',
    makePipe('alice', relay, b => aliceToRelayFrames.push(b))
  )
  relay.addDirectPeer('alice', makePipe('relay', alice))
  relay.addDirectPeer(
    'bob',
    makePipe('relay', bob, b => relayedToBobFrames.push(b))
  )
  bob.addDirectPeer('relay', makePipe('bob', relay))

  await waitFor(
    () =>
      alice.getSnapshot().roomPeerIds.includes('bob') &&
      bob.getSnapshot().roomPeerIds.includes('alice'),
    2_000
  )
  await wait(60)

  // Attack A: TOFU Key-Replacement / Identity Hijacking Attack
  // Mallory is an authenticated room insider (knows password) who generates a real ECDSA/ECDH keypair
  // and signs a higher-seq descriptor (seq: 999) claiming to be 'alice' to hijack Alice's identity.
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
  const authDigest = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      encodeBytes(
        'trystero-ov-auth:shared-room-secret:adv-app:adv-room:alice:999'
      )
    )
  )
  const validRoomAuthForHijack = Array.from(authDigest, b =>
    b.toString(16).padStart(2, '0')
  ).join('')
  const hijackCanonical = JSON.stringify([
    'alice',
    999,
    ['relay'],
    [],
    mallorySignJwk,
    malloryEncJwk,
    validRoomAuthForHijack
  ])
  const hijackSigBuf = await crypto.subtle.sign(
    {name: 'ECDSA', hash: 'SHA-256'},
    mallorySignPair.privateKey,
    encodeBytes(hijackCanonical)
  )
  const hijackSigB64 = btoa(
    String.fromCharCode(...new Uint8Array(hijackSigBuf))
  )

  const sigFailuresBeforeHijack = bob.getSnapshot().stats.signatureFailures
  bob.handleOverlayFrame(
    'relay',
    packOverlayControl({
      t: 'gossip',
      descriptors: [
        {
          peerId: 'alice',
          seq: 999,
          neighbors: ['relay'],
          signPubKey: mallorySignJwk,
          encPubKey: malloryEncJwk,
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
    'relay',
    packOverlayControl({
      t: 'leave',
      peerId: 'alice',
      seq: 500
    }).slice().buffer
  )
  bob.handleOverlayFrame(
    'relay',
    packOverlayControl({
      t: 'leave',
      peerId: 'alice',
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
    bob.getSnapshot().roomPeerIds.includes('alice'),
    'Alice must remain in Bob roomPeerIds after forged leave DoS attempts'
  )

  // Attack C: Forged Gossip `down` List Eviction Attack
  const sigFailuresBeforeDown = bob.getSnapshot().stats.signatureFailures
  bob.handleOverlayFrame(
    'relay',
    packOverlayControl({
      t: 'gossip',
      descriptors: [],
      down: ['alice']
    }).slice().buffer
  )
  await wait(40)
  assert.equal(
    bob.getSnapshot().stats.signatureFailures,
    sigFailuresBeforeDown + 1,
    'unauthenticated gossip down claim against a TOFU-pinned peer must be rejected'
  )
  assert.ok(
    bob.getSnapshot().roomPeerIds.includes('alice'),
    'Alice must remain in Bob roomPeerIds after forged gossip down claim'
  )

  // Attack D: Pre-Verification Deduplication Cache-Poisoning Attack
  // Capture a real signed broadcast packet from Alice, then inject a forged packet with the
  // EXACT same msgId into Bob first, followed by Alice's genuine packet.
  aliceToRelayFrames.length = 0
  await alice.broadcastInline(
    encodeBytes('GENUINE-BROADCAST-AFTER-POISON-ATTEMPT')
  )
  await waitFor(() => bobDelivered.length === 1, 2_000)

  const genuineAliceBroadcast = aliceToRelayFrames.find(frame => {
    const parsed = unpackOverlayBinary(frame)
    return parsed?.kind === overlayBroadcastKind
  })
  assert.ok(
    genuineAliceBroadcast,
    'expected captured broadcast frame from Alice'
  )
  const parsedGenuine = unpackOverlayBinary(genuineAliceBroadcast!)!

  // Now test cache-poisoning resistance on a fresh peer (Carol) that pins Alice's key
  // and receives a forged frame with msgId = parsedGenuine.header.m BEFORE the genuine frame!
  const carolDelivered: string[] = []
  const carol = createOverlayManager({
    selfId: 'carol',
    appId: 'adv-app',
    roomId: 'adv-room',
    password: 'shared-room-secret',
    topology: {
      mode: 'gossip',
      maxConnections: 2,
      maxHops: 4
    },
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: (_origin, data) => {
      carolDelivered.push(decodeBytes(new Uint8Array(data)))
    }
  })
  relay.addDirectPeer('carol', makePipe('relay', carol))
  carol.addDirectPeer('relay', makePipe('carol', relay))
  await waitFor(() => carol.getSnapshot().roomPeerIds.includes('alice'), 2_000)

  const poisonedSameMsgIdPacket = packOverlayBinary(
    overlayBroadcastKind,
    4,
    {
      o: 'alice',
      m: parsedGenuine.header['m'],
      s: hijackSigB64
    },
    encodeBytes('CORRUPTED-FAST-PATH-PACKET')
  )
  // 1. Inject forged packet with msgId first
  carol.handleOverlayFrame('relay', poisonedSameMsgIdPacket.slice().buffer)
  await wait(30)
  assert.equal(carolDelivered.length, 0)
  assert.equal(carol.getSnapshot().stats.signatureFailures, 1)

  // 2. Now inject the genuine signed packet with the exact same msgId
  carol.handleOverlayFrame('relay', genuineAliceBroadcast!.slice().buffer)
  await waitFor(() => carolDelivered.length === 1, 1_000)
  assert.equal(
    carolDelivered[0],
    'GENUINE-BROADCAST-AFTER-POISON-ATTEMPT',
    'forged packet must not poison seenMessages cache against genuine packet with same msgId'
  )

  // Attack E: Replay Flood (25x) & TTL = 255 Amplification Clamping
  const dupsBeforeReplay = carol.getSnapshot().stats.duplicatesDropped
  for (let i = 0; i < 25; i++) {
    carol.handleOverlayFrame('relay', genuineAliceBroadcast!.slice().buffer)
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
    .map(f => unpackOverlayBinary(f))
    .find(
      p =>
        p?.kind === overlayBroadcastKind &&
        decodeBytes(p.payload) === 'TTL-CLAMP-TEST'
    )!

  // Craft a packet with Alice's valid header+signature+payload, but malicious ttl = 255,
  // and inject into a new relay (`relayClamp`) with maxHops = 4 to verify forwarded TTL is clamped to 3
  const clampedForwardedFrames: Uint8Array[] = []
  const relayClamp = createOverlayManager({
    selfId: 'relay-clamp',
    appId: 'adv-app',
    roomId: 'adv-room',
    password: 'shared-room-secret',
    topology: {
      mode: 'gossip',
      maxConnections: 2,
      maxHops: 4
    },
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })
  relay.addDirectPeer('relay-clamp', makePipe('relay', relayClamp))
  relayClamp.addDirectPeer('relay', makePipe('relay-clamp', relay))
  await waitFor(
    () => relayClamp.getSnapshot().roomPeerIds.includes('alice'),
    2_000
  )

  relayClamp.addDirectPeer('downstream', {
    isDead: false,
    connection: {} as any,
    channel: {readyState: 'open'} as any,
    getOffer: async () => undefined,
    signal: async () => undefined,
    sendData: (data: Uint8Array) => {
      const p = unpackOverlayBinary(data)
      if (p?.kind === overlayBroadcastKind) {
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
    anotherAliceBroadcast.header,
    anotherAliceBroadcast.payload
  )
  relayClamp.handleOverlayFrame('upstream', amplifiedTtlPacket.slice().buffer)
  await waitFor(() => clampedForwardedFrames.length === 1, 1_000)
  const forwardedParsed = unpackOverlayBinary(clampedForwardedFrames[0]!)!
  assert.equal(
    forwardedParsed.ttl,
    3,
    'incoming TTL=255 must be clamped to maxHops(4) - 1 = 3 on forwarding'
  )

  // Attack F: In-Transit Unicast AES-GCM Ciphertext Bit-Flipping
  relayedToBobFrames.length = 0
  alice.sendUnicast('bob', encodeBytes('CONFIDENTIAL-UNICAST-MESSAGE'))
  await waitFor(
    () => bobDelivered.some(m => m.text === 'CONFIDENTIAL-UNICAST-MESSAGE'),
    2_000
  )
  const capturedUnicast = relayedToBobFrames
    .map(f => unpackOverlayBinary(f))
    .find(p => p?.kind === overlayUnicastKind)!
  assert.ok(capturedUnicast, 'expected captured E2EE unicast packet')

  const flippedCiphertext = capturedUnicast.payload.slice()
  flippedCiphertext[0] ^= 0xff
  const tamperedUnicastPacket = packOverlayBinary(
    overlayUnicastKind,
    4,
    {
      ...capturedUnicast.header,
      m: 'alice:bitflipped-unicast-99'
    },
    flippedCiphertext
  )
  const bobSigFailuresBeforeFlip = bob.getSnapshot().stats.signatureFailures
  const bobCountBeforeFlip = bobDelivered.length
  bob.handleOverlayFrame('relay', tamperedUnicastPacket.slice().buffer)
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

void test('Byzantine fault tolerance: Blackhole relay dropping 100% of data packets mitigated by multi-path redundancy', async () => {
  const bobDelivered: Array<{from: string; text: string}> = []
  let blackholeDroppedCount = 0

  const alice = createOverlayManager({
    selfId: 'alice',
    appId: 'byz-app',
    roomId: 'byz-room',
    topology: {
      mode: 'gossip',
      maxConnections: 2,
      redundancy: 2
    },
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })

  const honestRelay = createOverlayManager({
    selfId: 'relay-honest',
    appId: 'byz-app',
    roomId: 'byz-room',
    topology: {
      mode: 'gossip',
      maxConnections: 2,
      redundancy: 2
    },
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })

  const blackholeRelay = createOverlayManager({
    selfId: 'relay-blackhole',
    appId: 'byz-app',
    roomId: 'byz-room',
    topology: {
      mode: 'gossip',
      maxConnections: 2,
      redundancy: 2
    },
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })

  const bob = createOverlayManager({
    selfId: 'bob',
    appId: 'byz-app',
    roomId: 'byz-room',
    topology: {
      mode: 'gossip',
      maxConnections: 2,
      redundancy: 2
    },
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
    dropDataFrames = false
  ) => ({
    isDead: false,
    connection: {} as any,
    channel: {readyState: 'open'} as any,
    getOffer: async () => undefined,
    signal: async () => undefined,
    sendData: (data: Uint8Array) => {
      const parsed = unpackOverlayBinary(data)
      if (
        dropDataFrames &&
        parsed &&
        (parsed.kind === overlayBroadcastKind ||
          parsed.kind === overlayUnicastKind)
      ) {
        blackholeDroppedCount++
        return
      }
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

  // Diamond topology:
  // Alice <-> blackholeRelay <-> Bob (blackholeRelay has lexicographically smaller ID or primary path,
  // and silently drops 100% of outbound broadcast/unicast frames to Bob!)
  // Alice <-> honestRelay <-> Bob (backup disjoint path)
  alice.addDirectPeer('relay-blackhole', makePipe('alice', blackholeRelay))
  blackholeRelay.addDirectPeer('alice', makePipe('relay-blackhole', alice))
  blackholeRelay.addDirectPeer(
    'bob',
    makePipe('relay-blackhole', bob, true /* drop 100% of data frames! */)
  )
  bob.addDirectPeer('relay-blackhole', makePipe('bob', blackholeRelay))

  alice.addDirectPeer('relay-honest', makePipe('alice', honestRelay))
  honestRelay.addDirectPeer('alice', makePipe('relay-honest', alice))
  honestRelay.addDirectPeer('bob', makePipe('relay-honest', bob))
  bob.addDirectPeer('relay-honest', makePipe('bob', honestRelay))

  await waitFor(
    () =>
      alice.getSnapshot().roomPeerIds.includes('bob') &&
      bob.getSnapshot().roomPeerIds.includes('alice') &&
      Boolean(alice.getSnapshot().routes['bob']?.backupNextHop),
    2_000
  )
  await wait(60)

  // Verify Alice's route to Bob has both primary nextHop and a disjoint backupNextHop
  const bobRoute = alice.getSnapshot().routes['bob']!
  assert.ok(bobRoute.nextHop, 'expected primary nextHop to Bob')
  assert.ok(bobRoute.backupNextHop, 'expected disjoint backupNextHop to Bob')
  assert.notEqual(bobRoute.nextHop, bobRoute.backupNextHop)

  // Send 5 broadcasts and 5 E2EE unicasts from Alice -> Bob while blackholeRelay drops 100% of data packets
  for (let i = 0; i < 5; i++) {
    await alice.broadcastInline(encodeBytes(`byz-broadcast-${i}`))
    alice.sendUnicast('bob', encodeBytes(`byz-unicast-${i}`))
  }

  await waitFor(() => bobDelivered.length === 10, 2_000)
  assert.ok(
    blackholeDroppedCount >= 5,
    `expected blackholeRelay to drop data packets (dropped ${blackholeDroppedCount})`
  )

  for (let i = 0; i < 5; i++) {
    assert.ok(
      bobDelivered.some(
        m => m.from === 'alice' && m.text === `byz-broadcast-${i}`
      ),
      `expected broadcast ${i} to survive Byzantine blackhole relay`
    )
    assert.ok(
      bobDelivered.some(
        m => m.from === 'alice' && m.text === `byz-unicast-${i}`
      ),
      `expected E2EE unicast ${i} to survive Byzantine blackhole relay`
    )
  }

  alice.destroy()
  honestRelay.destroy()
  blackholeRelay.destroy()
  bob.destroy()
})

void test('Authority bootstrap: Self-certifying room IDs, on-the-fly joinRoom({ admin: true }), createAdminRoom, and userId-pinned rooms', async () => {
  // 1. Standalone createAdminRoom helper unified with UserIdentity
  const provisioned = await createAdminRoom('watch-party')
  assert.equal(provisioned.baseRoomId, 'watch-party')
  assert.match(provisioned.fingerprint, /^[0-9A-Za-z]{16}$/)
  assert.equal(provisioned.userId, provisioned.identity.userId)
  assert.equal(
    provisioned.roomId,
    formatSelfCertifyingRoomId('watch-party', provisioned.fingerprint)
  )
  const parsed = parseSelfCertifyingRoomId(provisioned.roomId)
  assert.deepEqual(parsed, {
    baseRoomId: 'watch-party',
    fingerprint: provisioned.fingerprint
  })
  assert.equal(
    await computePublicKeyFingerprint(provisioned.identity.publicKey),
    provisioned.fingerprint
  )
  assert.equal(
    computeUserIdFingerprint(provisioned.userId),
    provisioned.fingerprint
  )

  // 2. On-the-fly admin room creation via joinRoom({ appId, admin: true }, 'lobby')
  const topicSubs = new Map<string, Set<(topic: string, msg: string) => void>>()
  const joinRoom = createTopicStrategy({
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

  const createdRooms: Array<ReturnType<typeof joinRoom>> = []
  try {
    const hostIdentity = await createUserIdentity()
    const hostRoom = joinRoom(
      {
        appId: 'auth-bootstrap-app',
        _test_only_forcedPeerId: 'host-peer',
        identity: hostIdentity,
        ...roles(true),
        rtcPolyfill: MockRTCPeerConnection as any
      },
      'game-lobby'
    )
    createdRooms.push(hostRoom)

    const hostAuth = await hostRoom.getSelf()
    assert.equal(hostAuth.baseRoomId, 'game-lobby')
    assert.ok(
      hostAuth.fingerprint && /^[0-9A-Za-z]{16}$/.test(hostAuth.fingerprint)
    )
    assert.equal(
      hostAuth.fingerprint,
      computeUserIdFingerprint(hostIdentity.userId)
    )
    assert.equal(hostAuth.roomId, `game-lobby.${hostAuth.fingerprint}`)
    assert.equal(hostAuth.isAdmin, true)
    assert.deepEqual(hostAuth.roles, ['admin'])
    assert.equal(hostAuth.userId, hostIdentity.userId)

    // Joining a self-certifying roomId WITHOUT roles() throws an error
    assert.throws(
      () =>
        joinRoom(
          {
            appId: 'auth-bootstrap-app',
            _test_only_forcedPeerId: 'missing-roles-peer',
            rtcPolyfill: MockRTCPeerConnection as any
          },
          hostAuth.roomId
        ),
      /self-certifying room ID requires roles\(\) in joinRoom config/
    )

    // Guest joins using the self-certifying roomId with roles()
    const guestRoom = joinRoom(
      {
        appId: 'auth-bootstrap-app',
        _test_only_forcedPeerId: 'guest-peer',
        ...roles(),
        rtcPolyfill: MockRTCPeerConnection as any
      },
      hostAuth.roomId
    )
    createdRooms.push(guestRoom)
    const guestAuth = await guestRoom.getSelf()
    assert.equal(guestAuth.roomId, hostAuth.roomId)
    assert.equal(guestAuth.baseRoomId, 'game-lobby')
    assert.equal(guestAuth.fingerprint, hostAuth.fingerprint)
    assert.equal(guestAuth.isAdmin, false)
    assert.deepEqual(guestAuth.roles, [])

    // Impostor attempts to claim admin status on the existing self-certifying roomId
    const impostorIdentity = await createUserIdentity()
    const impostorRoom = joinRoom(
      {
        appId: 'auth-bootstrap-app',
        _test_only_forcedPeerId: 'impostor-peer',
        identity: impostorIdentity,
        ...roles([impostorIdentity.userId]),
        rtcPolyfill: MockRTCPeerConnection as any
      },
      hostAuth.roomId
    )
    createdRooms.push(impostorRoom)
    const impostorAuth = await impostorRoom.getSelf()
    assert.equal(
      impostorAuth.isAdmin,
      false,
      'a userId whose fingerprint does not match the self-certifying roomId must not grant admin status'
    )

    // Rejoining with the saved host UserIdentity automatically restores root admin status on the same roomId (with roles())
    const rejoinedHostRoom = joinRoom(
      {
        appId: 'auth-bootstrap-app',
        _test_only_forcedPeerId: 'host-rejoined',
        identity: exportUserIdentity(hostIdentity),
        ...roles(),
        rtcPolyfill: MockRTCPeerConnection as any
      },
      hostAuth.roomId
    )
    createdRooms.push(rejoinedHostRoom)
    const rejoinedAuth = await rejoinedHostRoom.getSelf()
    assert.equal(rejoinedAuth.isAdmin, true)
    assert.equal(rejoinedAuth.roomId, hostAuth.roomId)
    assert.equal(rejoinedAuth.userId, hostIdentity.userId)

    // 3. Mode B: Fixed room slug with trusted admin userId(s)
    const fixedHostRoom = joinRoom(
      {
        appId: 'auth-bootstrap-app',
        _test_only_forcedPeerId: 'fixed-host-peer',
        identity: hostIdentity,
        ...roles({admin: hostIdentity.userId}),
        rtcPolyfill: MockRTCPeerConnection as any
      },
      'clean-slug'
    )
    createdRooms.push(fixedHostRoom)
    const fixedHostAuth = await fixedHostRoom.getSelf()
    assert.equal(fixedHostAuth.roomId, 'clean-slug')
    assert.equal(fixedHostAuth.fingerprint, null)
    assert.equal(fixedHostAuth.isAdmin, true)
    assert.deepEqual(fixedHostAuth.roles, ['admin'])

    const fixedGuestRoom = joinRoom(
      {
        appId: 'auth-bootstrap-app',
        _test_only_forcedPeerId: 'fixed-guest-peer',
        ...roles(hostIdentity.userId),
        rtcPolyfill: MockRTCPeerConnection as any
      },
      'clean-slug'
    )
    createdRooms.push(fixedGuestRoom)
    const fixedGuestAuth = await fixedGuestRoom.getSelf()
    assert.equal(fixedGuestAuth.roomId, 'clean-slug')
    assert.equal(fixedGuestAuth.isAdmin, false)
  } finally {
    await Promise.all(createdRooms.map(r => r.leave()))
  }
})

void test('Privileged actions, role delegation, sub-delegation, and revocation across mesh and multi-hop overlays', async () => {
  const provisioned = await createAdminRoom('raid-room')
  const roomId = provisioned.roomId
  const appId = 'priv-action-app'

  // Set up a 4-peer multi-hop chain in small-world overlay:
  // admin <-> bob <-> carol <-> mallory
  const peers = ['admin', 'bob', 'carol', 'mallory'] as const
  const regMap = new Map<string, (peer: LinkedPeer, id: string) => void>()
  const rooms = new Map<string, ReturnType<typeof createRoom>>()

  for (const id of peers) {
    const peerIdentity =
      id === 'admin' ? provisioned.identity : await createUserIdentity()
    const room = createRoom(
      f => regMap.set(id, f),
      () => {},
      () => {},
      {
        selfId: id,
        appId,
        roomId,
        ...scale({mode: 'gossip', maxConnections: 2}),
        ...roles(),
        identity: peerIdentity
      }
    )
    rooms.set(id, room)
  }

  try {
    const connectDirect = (a: string, b: string) => {
      const {peerA, peerB} = linkPeers(new LinkedPeer(), new LinkedPeer())
      regMap.get(a)!(peerA, b)
      regMap.get(b)!(peerB, a)
    }

    connectDirect('admin', 'bob')
    connectDirect('bob', 'carol')
    connectDirect('carol', 'mallory')

    await waitFor(
      () =>
        peers.every(
          id =>
            rooms.get(id)!.getTopology().roomPeerIds.length === peers.length - 1
        ),
      3_000
    )

    const receivedAlerts = new Map<
      string,
      Array<{data: any; from: string; meta: any; roles: string[]}>
    >()
    const actions = new Map<string, any>()

    for (const id of peers) {
      receivedAlerts.set(id, [])
      const alertAction = rooms
        .get(id)!
        .makeAction<{msg: string}>('mod-alert', {
          roles: ['admin', 'moderator'],
          onMessage: (data, {peerId, metadata, roles}) => {
            receivedAlerts.get(id)!.push({
              data,
              from: peerId,
              meta: metadata,
              roles: roles ?? []
            })
          }
        })
      actions.set(id, alertAction)
    }

    // 1. Admin sends a privileged broadcast across the multi-hop overlay with user metadata
    await actions
      .get('admin')
      .send({msg: 'boss-phase-1'}, {metadata: {priority: 'high'}})
    await waitFor(
      () =>
        receivedAlerts.get('bob')!.length === 1 &&
        receivedAlerts.get('carol')!.length === 1 &&
        receivedAlerts.get('mallory')!.length === 1,
      2_000
    )
    assert.deepEqual(receivedAlerts.get('mallory')![0], {
      data: {msg: 'boss-phase-1'},
      from: 'admin',
      meta: {priority: 'high'},
      roles: ['admin']
    })

    // 2. Non-privileged Mallory attempts to send on 'mod-alert' -> rejected locally
    await assert.rejects(
      () => actions.get('mallory').send({msg: 'forged-alert'}),
      /insufficient authority/
    )

    // Wait for initial authority sync to settle
    await waitFor(
      () => rooms.get('mallory')!.getRoles('admin').includes('admin'),
      2_000
    )

    // 3. Root admin grants 'moderator' with canDelegate: true to Bob
    await rooms.get('admin')!.grantRole('bob', 'moderator', {canDelegate: true})
    await waitFor(
      () =>
        rooms.get('bob')!.getRoles('bob').includes('moderator') &&
        rooms.get('carol')!.getRoles('bob').includes('moderator') &&
        rooms.get('mallory')!.getRoles('bob').includes('moderator'),
      2_000
    )

    // Bob can now broadcast on 'mod-alert'
    await actions.get('bob').send({msg: 'mod-warning-1'})
    await waitFor(
      () =>
        receivedAlerts
          .get('admin')!
          .some(a => a.data.msg === 'mod-warning-1') &&
        receivedAlerts
          .get('mallory')!
          .some(a => a.data.msg === 'mod-warning-1'),
      2_000
    )
    const bobAlertOnMallory = receivedAlerts
      .get('mallory')!
      .find(a => a.data.msg === 'mod-warning-1')!
    assert.deepEqual(bobAlertOnMallory.roles, ['moderator'])

    // 4. Bob sub-delegates 'moderator' to Carol (without canDelegate), and cannot escalate to 'admin'
    await assert.rejects(
      () => rooms.get('bob')!.grantRole('carol', 'admin'),
      /insufficient authority/
    )
    await rooms.get('bob')!.grantRole('carol', 'moderator')
    await waitFor(
      () =>
        rooms.get('carol')!.getRoles('carol').includes('moderator') &&
        rooms.get('admin')!.getRoles('carol').includes('moderator'),
      2_000
    )

    // Carol can now broadcast on 'mod-alert'
    await actions.get('carol').send({msg: 'carol-mod-notice'})
    await waitFor(
      () =>
        receivedAlerts
          .get('admin')!
          .some(a => a.data.msg === 'carol-mod-notice'),
      2_000
    )

    // 5. Delegated moderator Bob cannot revoke root admin
    await assert.rejects(
      () => rooms.get('bob')!.revokeRole('admin'),
      /cannot revoke a root admin/
    )

    // 6. Root admin revokes Carol's 'moderator' role
    await rooms.get('admin')!.revokeRole('carol', 'moderator')
    await waitFor(
      () =>
        !rooms.get('carol')!.getRoles('carol').includes('moderator') &&
        !rooms.get('admin')!.getRoles('carol').includes('moderator') &&
        !rooms.get('bob')!.getRoles('carol').includes('moderator'),
      2_000
    )

    // Carol can no longer send on 'mod-alert'
    await assert.rejects(
      () => actions.get('carol').send({msg: 'after-revocation'}),
      /insufficient authority/
    )
  } finally {
    await Promise.all(peers.map(id => rooms.get(id)!.leave()))
  }
})

void test('Authoritative state (room.makeState): monotonic updates, custom validation, co-admin LWW convergence, and late-joiner sync after admin leaves', async () => {
  const [adminUser1, adminUser2, viewerUser1, viewerUser2] = await Promise.all([
    createUserIdentity(),
    createUserIdentity(),
    createUserIdentity(),
    createUserIdentity()
  ])
  const roomId = 'state-room'
  const appId = 'state-test-app'
  const coAdmins = [adminUser1.userId, adminUser2.userId]

  const regMap = new Map<string, (peer: LinkedPeer, id: string) => void>()
  const makePeerRoom = (id: string, identity: typeof adminUser1) =>
    createRoom(
      f => regMap.set(id, f),
      () => {},
      () => {},
      {
        selfId: id,
        appId,
        roomId,
        identity,
        ...roles(coAdmins)
      }
    )

  const directHandles = new Map<string, LinkedPeer>()
  const connectDirect = (a: string, b: string) => {
    const {peerA, peerB} = linkPeers(new LinkedPeer(), new LinkedPeer())
    directHandles.set(`${a}->${b}`, peerA)
    directHandles.set(`${b}->${a}`, peerB)
    regMap.get(a)!(peerA, b)
    regMap.get(b)!(peerB, a)
  }

  const admin1 = makePeerRoom('admin-1', adminUser1)
  const admin2 = makePeerRoom('admin-2', adminUser2)
  const viewer1 = makePeerRoom('viewer-1', viewerUser1)

  type GameState = {round: number; leader: string}
  const validateGame = (next: GameState, prev: GameState) =>
    next.round >= prev.round

  const stateAdmin1 = admin1.makeState<GameState>(
    'game',
    {round: 0, leader: 'none'},
    {validate: validateGame}
  )
  const stateAdmin2 = admin2.makeState<GameState>(
    'game',
    {round: 0, leader: 'none'},
    {validate: validateGame}
  )
  const stateViewer1 = viewer1.makeState<GameState>(
    'game',
    {round: 0, leader: 'none'},
    {validate: validateGame}
  )

  const viewerChanges: Array<{val: GameState; prev: GameState; by: string}> = []
  stateViewer1.onChange = (val, prev, ctx) => {
    viewerChanges.push({val, prev, by: ctx.updatedBy})
  }

  connectDirect('admin-1', 'admin-2')
  connectDirect('admin-1', 'viewer-1')
  connectDirect('admin-2', 'viewer-1')

  await waitFor(
    () =>
      admin1.getTopology().directPeerIds.length === 2 &&
      viewer1.getTopology().directPeerIds.length === 2,
    2_000
  )

  // 1. Non-admin viewer cannot mutate authoritative state
  await assert.rejects(
    () => stateViewer1.set({round: 99, leader: 'viewer-1'}),
    /insufficient authority/
  )

  // 2. Admin 1 updates state twice (value and functional updater)
  await stateAdmin1.set({round: 1, leader: 'admin-1'})
  await stateAdmin1.set(prev => ({round: prev.round + 1, leader: 'admin-1'}))

  await waitFor(
    () => stateViewer1.get().round === 2 && stateAdmin2.get().round === 2,
    2_000
  )
  assert.deepEqual(stateViewer1.get(), {round: 2, leader: 'admin-1'})
  assert.equal(stateViewer1.getMeta()?.updatedBy, 'admin-1')
  assert.equal(stateViewer1.getMeta()?.seq, 2)
  assert.ok(viewerChanges.length >= 1)

  // 3. Custom validate hook blocks regressive round update
  await assert.rejects(
    () => stateAdmin1.set({round: 0, leader: 'admin-1'}),
    /state validation failed/
  )

  // 4. Co-admin concurrent updates converge deterministically across all peers
  await Promise.all([
    stateAdmin1.set({round: 3, leader: 'from-admin-1'}),
    stateAdmin2.set({round: 3, leader: 'from-admin-2'})
  ])
  await wait(80)
  assert.deepEqual(stateAdmin1.get(), stateAdmin2.get())
  assert.deepEqual(stateViewer1.get(), stateAdmin1.get())
  assert.equal(stateAdmin1.getMeta()?.hash, stateViewer1.getMeta()?.hash)

  // 5. Both admins leave the room, then a late-joiner (viewer-2) connects ONLY to viewer-1!
  // viewer-2 must still receive and verify the signed authoritative state snapshot from viewer-1.
  const finalExpectedState = stateViewer1.get()
  const finalExpectedHash = stateViewer1.getMeta()?.hash
  await Promise.all([admin1.leave(), admin2.leave()])

  const viewer2 = makePeerRoom('viewer-2', viewerUser2)
  const stateViewer2 = viewer2.makeState<GameState>(
    'game',
    {round: 0, leader: 'none'},
    {validate: validateGame}
  )
  connectDirect('viewer-1', 'viewer-2')

  await waitFor(() => stateViewer2.get().round === 3, 2_000)
  assert.deepEqual(stateViewer2.get(), finalExpectedState)
  assert.equal(stateViewer2.getMeta()?.hash, finalExpectedHash)

  // Verify compareStateRecords deterministic ordering
  assert.equal(
    compareStateRecords(
      {epoch: 1, seq: 2, ts: 100, updatedBy: 'a', hash: '11'} as any,
      {epoch: 1, seq: 1, ts: 200, updatedBy: 'b', hash: '22'} as any
    ) > 0,
    true
  )

  await Promise.all([viewer1.leave(), viewer2.leave()])
})

void test('Broadcast tree root pinning for verified admins, Hop-1 unauthorized broadcast drop, and multi-layer room.ban enforcement', async () => {
  // 1. Verify computeTargetNeighbors pins privilegedPeers to index 0 (broadcast tree root)
  // even when the admin has a lexicographically high peerId ('zzzz-admin')
  const roster = [
    'aaaa-peer',
    'bbbb-peer',
    'cccc-peer',
    'dddd-peer',
    'zzzz-admin'
  ]
  const priv = new Set(['zzzz-admin'])
  const rootTargets = computeTargetNeighbors(
    'zzzz-admin',
    roster,
    'broadcast',
    6,
    2,
    priv
  )
  // As index 0 in binary tree (fanout 2), 'zzzz-admin' has children at index 1 ('aaaa-peer') and index 2 ('bbbb-peer')
  assert.ok(rootTargets.has('aaaa-peer'))
  assert.ok(rootTargets.has('bbbb-peer'))
  const child1Targets = computeTargetNeighbors(
    'aaaa-peer',
    roster,
    'broadcast',
    6,
    2,
    priv
  )
  assert.ok(
    child1Targets.has('zzzz-admin'),
    'first non-privileged peer (index 1) must select privileged root (index 0) as its tree parent'
  )

  // 2. Hop-1 relay drops unauthorized overlay broadcast before forwarding downstream
  const forwardedToDownstream: Uint8Array[] = []
  const malloryOverlay = createOverlayManager({
    selfId: 'mallory-ov',
    appId: 'hop1-app',
    roomId: 'hop1-room',
    topology: {mode: 'gossip', maxConnections: 2},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })
  const hop1RelayOverlay = createOverlayManager({
    selfId: 'relay-ov',
    appId: 'hop1-app',
    roomId: 'hop1-room',
    topology: {mode: 'gossip', maxConnections: 2},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {},
    canPeerSendAction: peerId => peerId === 'admin-ov'
  })
  hop1RelayOverlay.registerActionAuthority('admin-cmd', ['admin'])

  const makeSimplePipe = (
    fromId: string,
    toManager: ReturnType<typeof createOverlayManager>
  ) => ({
    isDead: false,
    connection: {} as any,
    channel: {readyState: 'open'} as any,
    getOffer: async () => undefined,
    signal: async () => undefined,
    sendData: (data: Uint8Array) => {
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

  malloryOverlay.addDirectPeer(
    'relay-ov',
    makeSimplePipe('mallory-ov', hop1RelayOverlay)
  )
  hop1RelayOverlay.addDirectPeer(
    'mallory-ov',
    makeSimplePipe('relay-ov', malloryOverlay)
  )
  hop1RelayOverlay.addDirectPeer('downstream-ov', {
    ...makeSimplePipe('relay-ov', malloryOverlay),
    sendData: (data: Uint8Array) => {
      const parsed = unpackOverlayBinary(data)
      if (parsed?.kind === overlayBroadcastKind) {
        forwardedToDownstream.push(data.slice())
      }
    }
  })

  await waitFor(
    () => hop1RelayOverlay.getSnapshot().directPeerIds.includes('mallory-ov'),
    1_000
  )
  await wait(40)

  // Mallory broadcasts an action wire frame (v2 header: byte[0]=2, bytes[2..34]=namespace) claiming privileged action 'admin-cmd'
  const fakePrivPayload = new Uint8Array(40)
  fakePrivPayload[0] = 2
  fakePrivPayload.set(encodeBytes('admin-cmd'), 2)
  const relaySigFailBefore =
    hop1RelayOverlay.getSnapshot().stats.signatureFailures
  await malloryOverlay.broadcastInline(fakePrivPayload)
  await wait(50)
  assert.equal(
    hop1RelayOverlay.getSnapshot().stats.signatureFailures,
    relaySigFailBefore + 1,
    'Hop-1 relay must reject unauthorized broadcast on privileged action and increment signatureFailures'
  )
  assert.equal(
    forwardedToDownstream.length,
    0,
    'Hop-1 relay must NOT forward unauthorized privileged broadcast downstream'
  )
  malloryOverlay.destroy()
  hop1RelayOverlay.destroy()

  // 3. Multi-layer room.ban(peerId) enforcement
  const provisioned = await createAdminRoom('ban-test-room')
  const roomId = provisioned.roomId
  const appId = 'ban-test-app'

  const regMap = new Map<string, (peer: LinkedPeer, id: string) => void>()
  const rooms = new Map<string, ReturnType<typeof createRoom>>()
  const peerIds = ['admin', 'honest', 'mallory']

  for (const id of peerIds) {
    const peerIdentity =
      id === 'admin' ? provisioned.identity : await createUserIdentity()
    const room = createRoom(
      f => regMap.set(id, f),
      () => {},
      () => {},
      {
        selfId: id,
        appId,
        roomId,
        ...roles(),
        identity: peerIdentity
      }
    )
    rooms.set(id, room)
  }

  const directHandles = new Map<string, LinkedPeer>()
  const connectDirect = (a: string, b: string) => {
    const {peerA, peerB} = linkPeers(new LinkedPeer(), new LinkedPeer())
    directHandles.set(`${a}->${b}`, peerA)
    directHandles.set(`${b}->${a}`, peerB)
    regMap.get(a)!(peerA, b)
    regMap.get(b)!(peerB, a)
  }

  try {
    connectDirect('admin', 'honest')
    connectDirect('admin', 'mallory')
    connectDirect('honest', 'mallory')

    await waitFor(
      () =>
        rooms.get('admin')!.getTopology().directPeerIds.length === 2 &&
        rooms.get('honest')!.getTopology().directPeerIds.length === 2,
      2_000
    )

    const honestChatReceived: Array<{msg: string; from: string}> = []
    for (const id of peerIds) {
      const chatAction = rooms.get(id)!.makeAction<string>('chat', {
        onMessage: (msg, {peerId}) => {
          if (id === 'honest') {
            honestChatReceived.push({msg, from: peerId})
          }
        }
      })
      ;(rooms.get(id) as any).sendChat = chatAction.send
    }

    // Non-admin cannot ban a peer
    await assert.rejects(
      () => rooms.get('honest')!.ban('mallory'),
      /only an admin can ban a peer/
    )

    // Admin bans Mallory
    await rooms.get('admin')!.ban('mallory', {reason: 'abusive behavior'})
    await waitFor(
      () =>
        rooms.get('admin')!.isBanned('mallory') &&
        rooms.get('honest')!.isBanned('mallory'),
      2_000
    )

    assert.equal(rooms.get('admin')!.isBanned('mallory'), true)
    assert.equal(rooms.get('honest')!.isBanned('mallory'), true)
    assert.equal(
      rooms.get('honest')!.getTopology().directPeerIds.includes('mallory'),
      false,
      'banned peer must be immediately disconnected from honest peers'
    )

    // Even if Mallory tries to reconnect to Honest with a new peer connection, Honest immediately rejects/destroys it
    connectDirect('honest', 'mallory')
    await wait(50)
    assert.equal(
      rooms.get('honest')!.getTopology().directPeerIds.includes('mallory'),
      false,
      'banned peer reconnection attempt must be rejected'
    )
  } finally {
    await Promise.all(peerIds.map(id => rooms.get(id)!.leave()))
  }
})

void test('PeerInfo in room.getPeers(), createAdminRoom identity reuse, cascading delegator revocation, anti-replay, offer-time role rejection, plaintext unicast rejection, and concurrent makeState serialization', async () => {
  // 1. createAdminRoom with an existing UserIdentity deterministically derives the same fingerprint across rooms
  const hostUser = await createUserIdentity()
  const otherUser = await createUserIdentity()
  const roomA1 = await createAdminRoom('lobby', {
    identity: hostUser,
    appId: 'app-one'
  })
  const roomB1 = await createAdminRoom('general', {
    identity: hostUser,
    appId: 'app-one'
  })
  const roomOther = await createAdminRoom('lobby', {
    identity: otherUser,
    appId: 'app-one'
  })
  assert.equal(
    roomA1.fingerprint,
    roomB1.fingerprint,
    'same UserIdentity must deterministically derive the same self-certifying fingerprint'
  )
  assert.equal(roomA1.roomId, `lobby.${roomA1.fingerprint}`)
  assert.equal(roomB1.roomId, `general.${roomB1.fingerprint}`)
  assert.notEqual(
    roomA1.fingerprint,
    roomOther.fingerprint,
    'different UserIdentities must derive distinct fingerprints'
  )

  // 2. Chunked computePayloadDigest (> 256 KiB) matches across Blob and Uint8Array without full-Blob copy
  const largeBytes = new Uint8Array(300_000)
  for (let i = 0; i < largeBytes.length; i++) {
    largeBytes[i] = (i * 31) & 0xff
  }
  const largeBlob = new Blob([largeBytes])
  const digestUint8 = await computePayloadDigest(largeBytes)
  const digestBlob = await computePayloadDigest(largeBlob)
  assert.equal(
    digestBlob,
    digestUint8,
    'chunked Blob digest must match Uint8Array digest for payloads > 256 KiB'
  )
  const digestUint8Meta = await computePayloadDigest(largeBytes, {tag: 'v1'})
  const digestBlobMeta = await computePayloadDigest(largeBlob, {tag: 'v1'})
  assert.equal(
    digestBlobMeta,
    digestUint8Meta,
    'chunked Blob digest with metadata must match Uint8Array digest with metadata'
  )
  assert.notEqual(digestUint8, digestUint8Meta)

  // 3. Future-iat RoleCertificate rejection in verifyRoleCertificateChain
  const rootId = await createUserIdentity()
  const subId = await createUserIdentity()
  const futureCert = await signRoleCertificate(rootId.sign, rootId.signPubJwk, {
    subPeerId: 'sub-peer',
    subPubKey: subId.signPubJwk,
    appId: 'test-app',
    roomId: 'test-room',
    roles: ['moderator'],
    now: Date.now() + 3_600_000 // 1 hour in the future (> 60s skew allowance)
  })
  const futureRes = await verifyRoleCertificateChain(
    futureCert,
    'test-app',
    'test-room',
    new Set([computeUserIdFingerprint(rootId.userId)]),
    new Set([rootId.userId])
  )
  assert.equal(
    futureRes.valid,
    false,
    'certificate with far-future iat must be rejected'
  )

  // 4. Multi-hop topology: room.getPeers() PeerInfo, cascading delegator revocation,
  //    offer-stage bulk rejection on role-protected actions, and serialized concurrent state.set()
  //    Line topology: admin -- bob -- carol -- mallory
  const provisioned = await createAdminRoom('audit-room', {
    appId: 'audit-app'
  })
  const roomId = provisioned.roomId
  const appId = 'audit-app'
  const peerIds = ['admin', 'bob', 'carol', 'mallory']
  const regMap = new Map<string, (peer: LinkedPeer, id: string) => void>()
  const rooms = new Map<string, ReturnType<typeof createRoom>>()

  for (const id of peerIds) {
    const peerIdentity =
      id === 'admin' ? provisioned.identity : await createUserIdentity()
    const room = createRoom(
      f => regMap.set(id, f),
      () => {},
      () => {},
      {
        selfId: id,
        appId,
        roomId,
        ...scale({mode: 'gossip', maxConnections: 2}),
        ...roles(),
        identity: peerIdentity
      }
    )
    rooms.set(id, room)
  }

  const directHandles = new Map<string, LinkedPeer>()
  const connectDirect = (a: string, b: string) => {
    const {peerA, peerB} = linkPeers(new LinkedPeer(), new LinkedPeer())
    directHandles.set(`${a}->${b}`, peerA)
    directHandles.set(`${b}->${a}`, peerB)
    regMap.get(a)!(peerA, b)
    regMap.get(b)!(peerB, a)
  }

  try {
    connectDirect('admin', 'bob')
    connectDirect('bob', 'carol')
    connectDirect('carol', 'mallory')

    await waitFor(
      () =>
        peerIds.every(
          id =>
            rooms.get(id)!.getTopology().roomPeerIds.length ===
            peerIds.length - 1
        ),
      3_000
    )

    // Verify room.getPeers() returns PeerInfo with connection, direct, hops, and roles
    await waitFor(
      () => rooms.get('mallory')!.getRoles('admin').includes('admin'),
      2_000
    )
    const adminPeers = rooms.get('admin')!.getPeers()
    assert.ok(adminPeers['bob'], 'direct neighbor bob must be in getPeers()')
    assert.equal(adminPeers['bob']!.direct, true)
    assert.equal(adminPeers['bob']!.hops, 1)
    assert.notEqual(adminPeers['bob']!.connection, null)

    assert.ok(
      adminPeers['carol'],
      '2-hop virtual peer carol must be in getPeers()'
    )
    assert.equal(adminPeers['carol']!.direct, false)
    assert.equal(adminPeers['carol']!.hops, 2)
    assert.equal(adminPeers['carol']!.connection, null)

    assert.ok(
      adminPeers['mallory'],
      '3-hop virtual peer mallory must be in getPeers()'
    )
    assert.equal(adminPeers['mallory']!.direct, false)
    assert.equal(adminPeers['mallory']!.hops, 3)
    assert.equal(adminPeers['mallory']!.connection, null)

    const malloryPeers = rooms.get('mallory')!.getPeers()
    assert.deepEqual(malloryPeers['admin']?.roles, ['admin'])

    // Register a role-protected action 'mod-file' (requires 'moderator' or 'admin')
    const receivedModPayloads = new Map<string, Uint8Array[]>()
    const modSenders = new Map<string, any>()
    for (const id of peerIds) {
      receivedModPayloads.set(id, [])
      const act = rooms.get(id)!.makeAction<Uint8Array>('mod-file', {
        roles: ['admin', 'moderator'],
        onMessage: data => {
          receivedModPayloads
            .get(id)!
            .push(
              data instanceof Uint8Array
                ? data
                : new Uint8Array(data as ArrayBuffer)
            )
        }
      })
      modSenders.set(id, act.send)
    }

    // Grant 'moderator' with canDelegate: true to Bob, then Bob sub-delegates 'moderator' to Carol
    await rooms.get('admin')!.grantRole('bob', 'moderator', {canDelegate: true})
    await waitFor(
      () => rooms.get('carol')!.getRoles('bob').includes('moderator'),
      2_000
    )
    await rooms.get('bob')!.grantRole('carol', 'moderator')
    await waitFor(
      () =>
        rooms.get('admin')!.getRoles('carol').includes('moderator') &&
        rooms.get('mallory')!.getRoles('carol').includes('moderator'),
      2_000
    )
    assert.deepEqual(rooms.get('admin')!.getPeers()['carol']?.roles, [
      'moderator'
    ])

    // Cascading revocation: Admin revokes BOB's 'moderator' role -> Carol's sub-delegated 'moderator' role must automatically be invalidated!
    await rooms.get('admin')!.revokeRole('bob', 'moderator')
    await waitFor(
      () =>
        !rooms.get('admin')!.getRoles('bob').includes('moderator') &&
        !rooms.get('admin')!.getRoles('carol').includes('moderator') &&
        !rooms.get('carol')!.getRoles('carol').includes('moderator'),
      2_000
    )
    assert.deepEqual(
      rooms.get('admin')!.getPeers()['carol']?.roles,
      [],
      'revoking delegator bob must cascade and strip sub-delegated role from carol'
    )

    // Offer-stage bulk transfer rejection on role-protected action:
    // Mallory registers 'mod-bulk' without local authority config (simulating a modified client),
    // while Carol protects 'mod-bulk' with roles: ['admin', 'moderator'].
    // When Mallory sends a 64 KB multi-chunk payload to Carol, Carol rejects the offer at admission time!
    rooms.get('carol')!.makeAction<Uint8Array>('mod-bulk', {
      roles: ['admin', 'moderator'],
      onMessage: () =>
        assert.fail('unauthorized bulk transfer must be rejected at offer time')
    })
    const malloryBulk = rooms.get('mallory')!.makeAction<Uint8Array>('mod-bulk')
    await assert.rejects(
      () => malloryBulk.send(new Uint8Array(64_000), {target: 'carol'}),
      {kind: 'rejected'}
    )

    // Also verify Carol's local send on 'mod-file' is blocked after cascading revocation:
    await assert.rejects(
      () => modSenders.get('carol')(new Uint8Array([1, 2, 3])),
      /insufficient authority/
    )

    // Anti-replay enforcement on ActionAuthEnvelope:
    // Capture a valid targeted 'mod-file' action wire frame from admin -> bob, then replay the exact wire frame
    const adminToBobPeer = directHandles.get('admin->bob')!
    const capturedModFrames: Uint8Array[] = []
    const origSend = adminToBobPeer.sendData.bind(adminToBobPeer)
    adminToBobPeer.sendData = (data: Uint8Array) => {
      const h = inspectActionWireHeader(data)
      if (h?.type === 'mod-file') {
        capturedModFrames.push(data.slice())
      }
      origSend(data)
    }
    await modSenders.get('admin')(new Uint8Array([42, 43]), {target: 'bob'})
    await waitFor(() => receivedModPayloads.get('bob')!.length === 1, 1_000)
    assert.equal(capturedModFrames.length, 1)

    const bobSigFailBefore = rooms.get('bob')!.getTopology()
      .stats.signatureFailures
    origSend(capturedModFrames[0]!)
    await wait(40)
    assert.equal(
      receivedModPayloads.get('bob')!.length,
      1,
      'replayed ActionAuthEnvelope frame must NOT be delivered a second time'
    )
    assert.equal(
      rooms.get('bob')!.getTopology().stats.signatureFailures,
      bobSigFailBefore + 1,
      'replayed ActionAuthEnvelope frame must increment signatureFailures'
    )

    // Verify concurrent state.set(prev => ...) calls serialize cleanly without dropping updates
    const counterAdmin = rooms
      .get('admin')!
      .makeState<{count: number; log: number[]}>('counter', {
        count: 0,
        log: []
      })
    const counterMallory = rooms
      .get('mallory')!
      .makeState<{count: number; log: number[]}>('counter', {
        count: 0,
        log: []
      })

    await Promise.all([
      counterAdmin.set(prev => ({
        count: prev.count + 1,
        log: [...prev.log, 1]
      })),
      counterAdmin.set(prev => ({
        count: prev.count + 1,
        log: [...prev.log, 2]
      })),
      counterAdmin.set(prev => ({
        count: prev.count + 1,
        log: [...prev.log, 3]
      })),
      counterAdmin.set(prev => ({
        count: prev.count + 1,
        log: [...prev.log, 4]
      })),
      counterAdmin.set(prev => ({
        count: prev.count + 1,
        log: [...prev.log, 5]
      }))
    ])

    assert.equal(counterAdmin.get().count, 5)
    assert.deepEqual(counterAdmin.get().log, [1, 2, 3, 4, 5])
    assert.equal(counterAdmin.getMeta()?.seq, 5)

    await waitFor(() => counterMallory.get().count === 5, 2_000)
    assert.deepEqual(counterMallory.get().log, [1, 2, 3, 4, 5])
  } finally {
    await Promise.all(peerIds.map(id => rooms.get(id)!.leave()))
  }

  // 5. Plaintext unicast downgrade (missing iv) is rejected by overlay
  const ovA = createOverlayManager({
    selfId: 'ov-a',
    appId: 'unicast-app',
    roomId: 'unicast-room',
    topology: {mode: 'gossip', maxConnections: 2},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () =>
      assert.fail('plaintext unicast must never be delivered')
  })
  const ovB = createOverlayManager({
    selfId: 'ov-b',
    appId: 'unicast-app',
    roomId: 'unicast-room',
    topology: {mode: 'gossip', maxConnections: 2},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () =>
      assert.fail('plaintext unicast must never be delivered')
  })
  const idA = await ovA.getLocalCryptoIdentity()
  ovB.setPeerSignPublicKey('ov-a', idA.signPubJwk)

  // Craft a signed unicast packet from ov-a to ov-b WITHOUT an 'iv' header field
  const rawPayload = encodeBytes('plaintext-attempt')
  const msgId = 'ov-a:downgrade-1'
  const canonical = `ov-a:ov-b:${msgId}:`
  const canonicalBytes = encodeBytes(canonical)
  const combined = new Uint8Array(
    canonicalBytes.byteLength + 1 + rawPayload.byteLength
  )
  combined.set(canonicalBytes, 0)
  combined[canonicalBytes.byteLength] = 0
  combined.set(rawPayload, canonicalBytes.byteLength + 1)
  const sigBuf = await crypto.subtle.sign(
    {name: 'ECDSA', hash: 'SHA-256'},
    idA.signPrivateKey,
    combined
  )
  const sigB64 = Buffer.from(sigBuf).toString('base64')
  const downgradePacket = packOverlayBinary(
    overlayUnicastKind,
    6,
    {o: 'ov-a', d: 'ov-b', m: msgId, s: sigB64},
    rawPayload
  )
  const sigFailBefore = ovB.getSnapshot().stats.signatureFailures
  ovB.handleOverlayFrame('ov-a', downgradePacket.slice().buffer)
  await wait(40)
  assert.equal(
    ovB.getSnapshot().stats.signatureFailures,
    sigFailBefore + 1,
    'unicast packet missing iv must be rejected and increment signatureFailures'
  )
  ovA.destroy()
  ovB.destroy()

  // 6. inspectActionWireHeader parses v2 inline/offer frames cleanly
  const sampleMeta = encodeBytes(JSON.stringify({hello: 'world'}))
  const sampleFrame = new Uint8Array(36 + sampleMeta.byteLength + 4)
  sampleFrame[0] = 2
  sampleFrame[1] = 0
  sampleFrame.set(encodeBytes('chat'), 2)
  new DataView(sampleFrame.buffer).setUint16(34, sampleMeta.byteLength)
  sampleFrame.set(sampleMeta, 36)
  const headerInfo = inspectActionWireHeader(sampleFrame)
  assert.deepEqual(headerInfo, {type: 'chat', metadata: {hello: 'world'}})

  // 7. SharedPeerManager respects shouldAttach and rekey(effectiveRoomId)
  const localMgr = new SharedPeerManager()
  const remoteMgr1 = new SharedPeerManager()
  const remoteMgr2 = new SharedPeerManager()
  const attachedInConstrainedRoom: string[] = []
  const constrainedToken = '0123456789abcdef0123456789abcdef01234567'
  const lobbyToken = 'fedcba9876543210fedcba9876543210fedcba98'

  const localLobby = localMgr.registerRoom(
    'shared-app',
    'lobby-room',
    Promise.resolve(lobbyToken),
    {
      active: true,
      onPeer: () => {},
      onDetach: () => {}
    }
  )
  const localConstrained = localMgr.registerRoom(
    'shared-app',
    'raw-room',
    Promise.resolve(constrainedToken),
    {
      active: true,
      shouldAttach: peerId => peerId === 'peer-1',
      onPeer: (_peer, peerId) => {
        attachedInConstrainedRoom.push(peerId)
      },
      onDetach: () => {}
    }
  )
  localConstrained.rekey('raw-room.0123456789abcdef')

  const r1Lobby = remoteMgr1.registerRoom(
    'shared-app',
    'lobby-room',
    Promise.resolve(lobbyToken),
    {active: true, onPeer: () => {}, onDetach: () => {}}
  )
  const r1Constrained = remoteMgr1.registerRoom(
    'shared-app',
    'raw-room.0123456789abcdef',
    Promise.resolve(constrainedToken),
    {active: true, onPeer: () => {}, onDetach: () => {}}
  )

  const r2Lobby = remoteMgr2.registerRoom(
    'shared-app',
    'lobby-room',
    Promise.resolve(lobbyToken),
    {active: true, onPeer: () => {}, onDetach: () => {}}
  )
  const r2Constrained = remoteMgr2.registerRoom(
    'shared-app',
    'raw-room.0123456789abcdef',
    Promise.resolve(constrainedToken),
    {active: true, onPeer: () => {}, onDetach: () => {}}
  )

  const {peerA: p1Local, peerB: p1Remote} = linkPeers(
    new LinkedPeer(),
    new LinkedPeer()
  )
  const {peerA: p2Local, peerB: p2Remote} = linkPeers(
    new LinkedPeer(),
    new LinkedPeer()
  )
  localLobby.connect('peer-1', p1Local, 5_000)
  r1Lobby.connect('local-peer', p1Remote, 5_000)
  localLobby.connect('peer-2', p2Local, 5_000)
  r2Lobby.connect('local-peer', p2Remote, 5_000)
  await wait(40)

  assert.deepEqual(
    attachedInConstrainedRoom,
    ['peer-1'],
    'SharedPeerManager must only auto-attach shared peers approved by shouldAttach'
  )
  localLobby.leave()
  localConstrained.leave()
  r1Lobby.leave()
  r1Constrained.leave()
  r2Lobby.leave()
  r2Constrained.leave()
  p1Local.destroy()
  p1Remote.destroy()
  p2Local.destroy()
  p2Remote.destroy()
})

void test('Targeted media stays private for direct and multi-hop recipients', async () => {
  const cluster = await createOverlayCluster({
    peerCount: 8,
    topology: {mode: 'broadcast', maxConnections: 6, fanout: 2},
    media: true
  })
  try {
    const source = cluster.rooms.get('peer-0000')!
    const direct = 'peer-0001'
    const remote = 'peer-0003'
    assert.equal(source.getPeers()[direct].direct, true)
    assert.equal(source.getPeers()[remote].direct, false)
    const streams: string[] = []
    const tracks: string[] = []
    for (const [id, room] of cluster.rooms) {
      getRoomSignalingBridge(room)!
        .getScaleProvider()!
        .setOnTargetsChanged(targets => {
          for (const targetId of targets) {
            cluster.connectPair(id, targetId)
          }
        })
      room.onPeerStream = () => streams.push(id)
      room.onPeerTrack = () => tracks.push(id)
    }
    for (const target of [direct, remote]) {
      streams.length = 0
      tracks.length = 0
      const camera = {id: `camera-${target}`}
      const stream = {id: `private-${target}`, getTracks: () => [camera]}
      await Promise.all(source.addStream(stream, {target}))
      await wait(100)
      assert.deepEqual(
        streams,
        [target],
        'only the requested peer receives a stream'
      )
      const audio = {id: `audio-${target}`}
      await Promise.all(
        source.addTrack(
          audio,
          {id: `audio-stream-${target}`, getTracks: () => [audio]},
          {target}
        )
      )
      await wait(100)
      assert.deepEqual(
        tracks,
        [target],
        'only the requested peer receives a track'
      )
      assert.equal(source.getPeers()[target].direct, true)
    }
  } finally {
    await cluster.cleanup()
  }
})

void test('Removing a broadcast track prevents replay after topology healing', async () => {
  const cluster = await createOverlayCluster({
    peerCount: 8,
    topology: {mode: 'broadcast', maxConnections: 6, fanout: 2},
    media: true
  })
  try {
    const source = cluster.rooms.get('peer-0000')!
    const track = {id: 'removed-camera'}
    const stream = {id: 'removed-stream', getTracks: () => [track]}
    await Promise.all(source.addTrack(track, stream))
    await wait(100)
    assert.ok(cluster.addedTracks.length >= 7)
    source.removeTrack(track)
    await wait(100)
    cluster.addedTracks.length = 0
    cluster.dropPeer('peer-0001')
    await cluster.healCluster()
    await wait(100)
    assert.deepEqual(
      cluster.addedTracks,
      [],
      'removed tracks must never be sent again'
    )
  } finally {
    await cluster.cleanup()
  }
})

void test('Removing and replacing tracks updates broadcast streams before topology healing', async () => {
  for (const replace of [false, true]) {
    const cluster = await createOverlayCluster({
      peerCount: 8,
      topology: {mode: 'broadcast', maxConnections: 6, fanout: 2},
      media: true
    })
    try {
      const source = cluster.rooms.get('peer-0000')!
      const camera = {id: 'camera'}
      const audio = {id: 'audio'}
      const stream = {id: 'two-track-stream', getTracks: () => [camera, audio]}
      await Promise.all(source.addStream(stream))
      await wait(100)
      let removedTrack = camera
      if (replace) {
        removedTrack = {id: 'replacement-camera'}
        await Promise.all(source.replaceTrack(camera, removedTrack))
        await wait(100)
      }
      source.removeTrack(removedTrack)
      await wait(100)
      cluster.addedTracks.length = 0
      cluster.dropPeer('peer-0001')
      await cluster.healCluster()
      await wait(100)
      assert.ok(
        cluster.addedTracks.length > 0,
        'remaining audio must still be relayed'
      )
      assert.ok(
        cluster.addedTracks.every(id => id === 'audio'),
        `removed camera must not be replayed (replace=${replace}): ${cluster.addedTracks.join(',')}`
      )
      source.removeStream(stream)
      await wait(100)
      cluster.addedTracks.length = 0
      cluster.dropPeer('peer-0002')
      await cluster.healCluster()
      await wait(100)
      assert.deepEqual(
        cluster.addedTracks,
        [],
        'removed stream must not be replayed'
      )
    } finally {
      await cluster.cleanup()
    }
  }
})

void test('Third-party plugin injection via definePlugin (spread and plugins array)', async () => {
  const events: string[] = []
  const telemetryPlugin = (prefix: string) =>
    definePlugin('telemetry', {
      setup: kernel => {
        const internal = kernel.makeInternalAction<string>('telem')
        internal.onMessage(() => {})
        events.push(`${prefix}:setup:${kernel.selfId}:${kernel.getRoomId()}`)
        kernel.onLeave(() => {
          events.push(`${prefix}:destroy:${kernel.selfId}`)
        })
        return {
          getEvents: () => [...events]
        }
      }
    })

  const room = createRoom(
    () => {},
    () => {},
    () => {},
    {
      selfId: 'custom-peer',
      appId: 'plugin-app',
      roomId: 'plugin-room',
      ...telemetryPlugin('mod1')
    }
  )

  assert.deepEqual((room as any).getEvents(), [
    'mod1:setup:custom-peer:plugin-room'
  ])
  await room.leave()
  assert.deepEqual(events, [
    'mod1:setup:custom-peer:plugin-room',
    'mod1:destroy:custom-peer'
  ])

  const room2 = createRoom(
    () => {},
    () => {},
    () => {},
    {
      selfId: 'custom-peer-2',
      appId: 'plugin-app',
      roomId: 'plugin-room-2',
      plugins: [telemetryPlugin('mod2')]
    }
  )
  assert.deepEqual((room2 as any).getEvents(), [
    'mod1:setup:custom-peer:plugin-room',
    'mod1:destroy:custom-peer',
    'mod2:setup:custom-peer-2:plugin-room-2'
  ])
  await room2.leave()
})
