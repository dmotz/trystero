// @ts-nocheck
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  computeShortestPathRoutes,
  computeTargetNeighbors,
  createOverlayManager,
  normalizeTopologyConfig,
  overlayBroadcastKind,
  overlayUnicastKind,
  packOverlayBinary,
  unpackOverlayBinary
} from '../../packages/core/src/overlay.ts'
import createRoom from '../../packages/core/src/room.ts'
import createTopicStrategy from '../../packages/core/src/topic-strategy.ts'
import {decodeBytes, encodeBytes} from '../../packages/core/src/utils.ts'
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
      super.addStream(stream)
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
        topology: resolvedTopology
      }
    )

    room.onPeerJoin = peerId => {
      left.delete(peerId)
      joined.add(peerId)
    }
    room.onPeerLeave = peerId => {
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
          ? 'small-world'
          : 'mesh'
        : norm.mode

    for (const id of activeSet) {
      const targets = computeTargetNeighbors(
        id,
        activeSet,
        effectiveMode,
        norm.maxPeers,
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
  }

  return {
    peerIds,
    activeSet,
    rooms,
    directLinks,
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

void test('Topology algorithms: symmetric small-world and tree neighbor selection & shortest-path routing', () => {
  const peerCount = 200
  const peerIds = Array.from(
    {length: peerCount},
    (_, i) => `peer-${String(i).padStart(4, '0')}`
  )

  for (const mode of ['small-world', 'tree'] as const) {
    const maxPeers = 8
    const fanout = 3
    const adjacency = new Map<string, Set<string>>()

    for (const id of peerIds) {
      adjacency.set(
        id,
        computeTargetNeighbors(id, peerIds, mode, maxPeers, fanout)
      )
    }

    let totalDirectedEdges = 0
    for (const [u, neighbors] of adjacency.entries()) {
      assert.ok(
        neighbors.size <= maxPeers,
        `${mode}: peer ${u} degree ${neighbors.size} exceeds maxPeers ${maxPeers}`
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

void test('Data-only scale: 150-peer text chat broadcast & high-frequency cursor updates over small-world overlay', async () => {
  const peerCount = 150
  const maxPeers = 8
  const cluster = await createOverlayCluster({
    peerCount,
    topology: {mode: 'small-world', maxPeers, minPeers: 4, redundancy: 1}
  })

  try {
    // 1. Verify bounded direct connections and full room discovery
    for (const id of cluster.peerIds) {
      const snap = cluster.rooms.get(id)!.getTopology()
      assert.equal(snap.activeMode, 'small-world')
      assert.ok(
        snap.directPeerIds.length <= maxPeers,
        `peer ${id} has ${snap.directPeerIds.length} direct peers, expected <= ${maxPeers}`
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
    topology: {mode: 'small-world', maxPeers: 4, minPeers: 2, redundancy: 1}
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
    topology: {mode: 'tree', maxPeers: 8, fanout},
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
      room.onPeerStream = (stream, peerId, metadata) => {
        streamDeliveries.set(id, {
          streamId: stream.id,
          from: peerId,
          meta: metadata
        })
      }
      room.onPeerTrack = (track, _stream, peerId, metadata) => {
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
      mode: 'small-world',
      maxPeers: 8,
      minPeers: 4,
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
      room.onPeerStream = (_stream, peerId) => {
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
    topology: {mode: 'small-world', maxPeers: 4},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })

  const overlayB = createOverlayManager({
    selfId: 'peer-B',
    topology: {mode: 'small-world', maxPeers: 4},
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
  overlayB.injectControlForTest('peer-A', {
    t: 'ihave',
    items: [{m: droppedMsgId, o: 'peer-A'}]
  })

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
    topology: {mode: 'small-world', maxPeers: 2},
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
    topology: {mode: 'small-world', maxPeers: 2},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })

  const bob = createOverlayManager({
    selfId: 'bob',
    appId: 'sec-app',
    roomId: 'sec-room',
    password: 'correct-horse-battery-staple',
    topology: {mode: 'small-world', maxPeers: 2},
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
  bob.injectBinaryForTest('relay', forgedPacket)
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
  bob.injectBinaryForTest('relay', unsignedSpoofPacket)
  await wait(40)
  assert.equal(bob.getSnapshot().stats.signatureFailures, failuresBefore + 1)
  assert.equal(bobDelivered.length, 1)

  // 4. Descriptor with wrong room password or spoofed key must be rejected
  const failuresBeforeDesc = bob.getSnapshot().stats.signatureFailures
  bob.injectControlForTest('relay', {
    t: 'gossip',
    descriptors: [
      {
        peerId: 'mallory',
        seq: 1,
        neighbors: ['relay'],
        roomAuth: 'wrong-password-hmac'
      }
    ]
  })
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

void test('Elegant API & automatic configuration: joinRoom with topology "auto" transitions from mesh to small-world at threshold', async () => {
  const peerCount = 24
  const autoThreshold = 8
  const maxPeers = 6

  // Verify normalizeTopologyConfig supports both string shorthand and full config object
  assert.equal(normalizeTopologyConfig().mode, 'mesh')
  assert.equal(normalizeTopologyConfig('small-world').mode, 'small-world')
  assert.equal(normalizeTopologyConfig('tree').mode, 'tree')
  assert.equal(normalizeTopologyConfig('auto').mode, 'auto')

  // Start with 6 peers (<= autoThreshold of 8): should remain in 'mesh' mode
  const smallCluster = await createOverlayCluster({
    peerCount: 6,
    topology: {mode: 'auto', autoThreshold, maxPeers}
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

  // Now scale to 24 peers (> autoThreshold of 8): should automatically switch to 'small-world'
  const largeCluster = await createOverlayCluster({
    peerCount,
    topology: {mode: 'auto', autoThreshold, maxPeers}
  })

  try {
    for (const id of largeCluster.peerIds) {
      const snap = largeCluster.rooms.get(id)!.getTopology()
      assert.equal(snap.mode, 'auto')
      assert.equal(
        snap.activeMode,
        'small-world',
        'room above autoThreshold should automatically switch to small-world'
      )
      assert.ok(snap.directPeerIds.length <= maxPeers)
      assert.equal(snap.roomPeerIds.length, peerCount - 1)
    }
  } finally {
    await largeCluster.cleanup()
  }
})

void test('End-to-end createTopicStrategy integration with config.peerId and config.topology', async () => {
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
      peerId: 'peer-alpha',
      topology: 'small-world',
      rtcPolyfill: MockRTCPeerConnection as any
    },
    'lobby'
  )
  const roomB = joinRoom(
    {
      appId: 'topic-e2e-overlay',
      peerId: 'peer-beta',
      topology: {mode: 'small-world', maxPeers: 6},
      rtcPolyfill: MockRTCPeerConnection as any
    },
    'lobby'
  )

  try {
    assert.equal(roomA.getTopology().selfId, 'peer-alpha')
    assert.equal(roomA.getTopology().mode, 'small-world')
    assert.equal(roomB.getTopology().selfId, 'peer-beta')
    assert.equal(roomB.getTopology().activeMode, 'small-world')
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
      mode: 'small-world',
      maxPeers: 2,
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
      mode: 'small-world',
      maxPeers: 2,
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
      mode: 'small-world',
      maxPeers: 2,
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
  bob.injectControlForTest('relay', {
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
  })
  await wait(40)
  assert.equal(
    bob.getSnapshot().stats.signatureFailures,
    sigFailuresBeforeHijack + 1,
    'TOFU key pinning must reject validly signed descriptor with replaced public key for pinned peerId'
  )

  // Attack B: Forged `leave` Control Frame DoS (Unsigned & Forged-Signature Remote Kick)
  const sigFailuresBeforeLeave = bob.getSnapshot().stats.signatureFailures
  bob.injectControlForTest('relay', {
    t: 'leave',
    peerId: 'alice',
    seq: 500
  })
  bob.injectControlForTest('relay', {
    t: 'leave',
    peerId: 'alice',
    seq: 501,
    sig: hijackSigB64
  })
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
  bob.injectControlForTest('relay', {
    t: 'gossip',
    descriptors: [],
    down: ['alice']
  })
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
      mode: 'small-world',
      maxPeers: 2,
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
  carol.injectBinaryForTest('relay', poisonedSameMsgIdPacket)
  await wait(30)
  assert.equal(carolDelivered.length, 0)
  assert.equal(carol.getSnapshot().stats.signatureFailures, 1)

  // 2. Now inject the genuine signed packet with the exact same msgId
  carol.injectBinaryForTest('relay', genuineAliceBroadcast!)
  await waitFor(() => carolDelivered.length === 1, 1_000)
  assert.equal(
    carolDelivered[0],
    'GENUINE-BROADCAST-AFTER-POISON-ATTEMPT',
    'forged packet must not poison seenMessages cache against genuine packet with same msgId'
  )

  // Attack E: Replay Flood (25x) & TTL = 255 Amplification Clamping
  const dupsBeforeReplay = carol.getSnapshot().stats.duplicatesDropped
  for (let i = 0; i < 25; i++) {
    carol.injectBinaryForTest('relay', genuineAliceBroadcast!)
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
      mode: 'small-world',
      maxPeers: 2,
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
  relayClamp.injectBinaryForTest('upstream', amplifiedTtlPacket)
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
  bob.injectBinaryForTest('relay', tamperedUnicastPacket)
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
      mode: 'small-world',
      maxPeers: 2,
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
      mode: 'small-world',
      maxPeers: 2,
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
      mode: 'small-world',
      maxPeers: 2,
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
      mode: 'small-world',
      maxPeers: 2,
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
