import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  RolesPluginApi,
  Room,
  ScalePluginApi,
  TopologyRoute
} from '../../packages/core/src/index.ts'
import type {PeerHandle} from '../../packages/core/src/types.ts'
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
  exportUserIdentity,
  importUserIdentity
} from '../../packages/core/src/identity.ts'
import {ecdsaSign} from '../../packages/core/src/crypto.ts'
import {inspectActionWireHeader} from '../../packages/core/src/action-wire.ts'
import {
  maxActionFrameBytes,
  maxRoomFrameBytes
} from '../../packages/core/src/data-limits.ts'
import {
  buildOverlaySignedBytes,
  canonicalBroadcastHeader,
  canonicalLeaveHeader,
  canonicalUnicastHeader,
  computeShortestPathRoutes,
  computeTargetNeighbors,
  createOverlayManager,
  deriveMaxHops,
  descriptorCanonicalPayload,
  maxAllowedHops,
  normalizeTopologyConfig,
  overlayBroadcastKind,
  overlayControlKind,
  overlayFrameVersion,
  overlayUnicastKind,
  packGossipControlFrames,
  packOverlayBinary,
  packOverlayControl,
  scale,
  unpackOverlayBinary
} from '../../packages/core/src/overlay.ts'
import createRoom, {
  getRoomSignalingBridge
} from '../../packages/core/src/room.ts'
import {createSignalHandler} from '../../packages/core/src/signal-handler.ts'
import createTopicStrategy from '../../packages/core/src/topic-strategy.ts'
import {
  decodeBytes,
  definePlugin,
  encodeBytes
} from '../../packages/core/src/utils.ts'
import {
  encodeInternalAction,
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
  jitterMs?: number
}

/**
 * Asynchronous, jittered in-memory WebRTC + topic-discovery harness
 * where peers discover each other via `notePeerDiscovered` and autonomously
 * dial targets via `setOnScaleTargetsChanged` / `shouldConnectPeer`.
 */
const createOverlayCluster = async ({
  peerCount,
  topology,
  password = '',
  media = false,
  jitterMs = 2
}: VirtualNetworkOptions) => {
  const peerIds = Array.from(
    {length: peerCount},
    (_, i) => `peer-${String(i).padStart(4, '0')}`
  )
  const resolvedTopology =
    typeof topology === 'string' ? {mode: topology} : {...topology}

  const registerCallbacks = new Map<string, (peer: any, id: string) => void>()
  const rooms = new Map<string, Room & RolesPluginApi & ScalePluginApi>()
  const directLinks = new Map<string, {peerA: LinkedPeer; peerB: LinkedPeer}>()
  const joinedByPeer = new Map<string, Set<string>>()
  const leftByPeer = new Map<string, Set<string>>()
  let totalWireFrames = 0
  let totalAddStreamCalls = 0
  const addedTracks: string[] = []

  class InstrumentedPeer extends (media ? LinkedMediaPeer : LinkedPeer) {
    removeStreamCalls = 0
    lastReplacedTrack: any = null
    private outboundQueue: Array<() => void> = []
    private drainTimer: ReturnType<typeof setTimeout> | null = null

    private enqueueOp(op: () => void) {
      if (this.isDead) {
        return
      }
      this.outboundQueue.push(op)
      this.scheduleDrain()
    }

    private scheduleDrain() {
      if (this.drainTimer || this.isDead || this.outboundQueue.length === 0) {
        return
      }
      const delay =
        jitterMs > 0 ? Math.floor(Math.random() * (jitterMs + 1)) : 0
      this.drainTimer = setTimeout(() => {
        this.drainTimer = null
        if (this.isDead) {
          this.outboundQueue.length = 0
          return
        }
        const batch = this.outboundQueue.splice(0, 32)
        for (const op of batch) {
          if (this.isDead) {
            break
          }
          op()
        }
        if (this.outboundQueue.length > 0 && !this.isDead) {
          this.scheduleDrain()
        }
      }, delay)
    }

    override sendData(data: Uint8Array) {
      if (this.isDead) {
        return
      }
      if (data.byteLength > maxRoomFrameBytes) {
        const partner = this.partner
        this.destroy()
        partner?.destroy()
        return
      }
      totalWireFrames++
      const copy = data.slice()
      this.enqueueOp(() => super.sendData(copy))
    }

    override destroy() {
      if (this.drainTimer) {
        clearTimeout(this.drainTimer)
        this.drainTimer = null
      }
      this.outboundQueue.length = 0
      super.destroy()
    }

    override addStream(stream: any) {
      totalAddStreamCalls++
      const tracks = stream.getTracks().map((track: any) => track.id)
      addedTracks.push(...tracks)
      this.enqueueOp(() => super.addStream(stream))
    }

    override addTrack(track: any, stream: any) {
      addedTracks.push(track.id)
      this.enqueueOp(() => {
        super.addTrack(track, stream)
      })
      return {}
    }

    override removeStream(stream: any) {
      this.removeStreamCalls++
      this.enqueueOp(() => super.removeStream(stream))
    }

    override replaceTrack(oldTrack: any, newTrack: any) {
      this.lastReplacedTrack = {oldTrack, newTrack}
      return super.replaceTrack(oldTrack, newTrack)
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

  const activeSet = new Set(peerIds)

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
        use: [scale(resolvedTopology)]
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

    const shouldConnect = (
      b: ReturnType<typeof getRoomSignalingBridge>,
      peerId: string,
      dir: 'inbound' | 'outbound'
    ) =>
      Boolean(
        (b?.canConnectPeer(peerId) ?? true) &&
        (b?.getScaleProvider()?.shouldConnectPeer(peerId, dir) ?? true)
      )

    const bridge = getRoomSignalingBridge(room)
    bridge?.setOnScaleTargetsChanged(targets => {
      for (const targetId of targets) {
        if (
          !activeSet.has(targetId) ||
          !activeSet.has(id) ||
          directLinks.has(linkKey(id, targetId))
        ) {
          continue
        }
        if (!shouldConnect(bridge, targetId, 'outbound')) {
          continue
        }
        const targetRoom = rooms.get(targetId)
        const targetBridge = targetRoom
          ? getRoomSignalingBridge(targetRoom)
          : undefined
        if (targetBridge && !shouldConnect(targetBridge, id, 'inbound')) {
          continue
        }
        connectPair(id, targetId)
      }
    })

    rooms.set(id, room as any)
  }

  const discoverAndDialFromOverlay = () => {
    for (const id of activeSet) {
      const room = rooms.get(id)!
      const bridge = getRoomSignalingBridge(room)!
      for (const otherId of activeSet) {
        if (otherId !== id) {
          bridge.getScaleProvider()?.notePeerDiscovered(otherId)
        }
      }
    }
    for (const id of activeSet) {
      const room = rooms.get(id)!
      const bridge = getRoomSignalingBridge(room)!
      if (room.getTopology().activeMode === 'mesh') {
        for (const otherId of activeSet) {
          if (
            otherId !== id &&
            (bridge.canConnectPeer(otherId) ?? true) &&
            (bridge
              .getScaleProvider()
              ?.shouldConnectPeer(otherId, 'outbound') ??
              true)
          ) {
            connectPair(id, otherId)
          }
        }
      } else {
        const targets = bridge.getScaleProvider()?.getTargetNeighbors()
        if (targets) {
          for (const targetId of targets) {
            if (activeSet.has(targetId)) {
              connectPair(id, targetId)
            }
          }
        }
      }
    }
  }

  const waitForTopologyConvergence = async () => {
    await waitFor(() => {
      for (const id of activeSet) {
        const roomPeers = rooms.get(id)!.getTopology().roomPeerIds
        if (roomPeers.length !== activeSet.size - 1) {
          return false
        }
        for (const peerId of roomPeers) {
          if (!activeSet.has(peerId)) {
            return false
          }
        }
      }
      return true
    }, 10_000)
    await wait(30)
  }

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
    discoverAndDialFromOverlay()
    await waitForTopologyConvergence()
  }

  const cleanup = async () => {
    activeSet.clear()
    registerCallbacks.clear()
    for (const pair of directLinks.values()) {
      pair.peerA.isDead = true
      pair.peerA.handlers = {}
      pair.peerB.isDead = true
      pair.peerB.handlers = {}
    }
    directLinks.clear()
    await Promise.all([...rooms.values()].map(room => room.leave()))
  }

  try {
    discoverAndDialFromOverlay()
    await waitForTopologyConvergence()
  } catch (err) {
    await cleanup()
    throw err
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

void test('Media streaming over scale overlay: direct neighbor delivery, multi-hop direct promotion, track replacement, and stream removal', async () => {
  const peerCount = 24
  const maxConnections = 6
  const cluster = await createOverlayCluster({
    peerCount,
    topology: {mode: 'gossip', maxConnections},
    media: true
  })

  try {
    const broadcasterId = 'peer-0000'
    const broadcasterRoom = cluster.rooms.get(broadcasterId)!
    const directNeighbors = new Set(broadcasterRoom.getTopology().directPeerIds)
    assert.ok(directNeighbors.size >= 4)

    const streamDeliveries = new Map<
      string,
      {streamId: string; from: string; meta: any}
    >()

    for (const id of cluster.peerIds) {
      const room = cluster.rooms.get(id)!
      room.onPeerStream = (stream, {peerId, metadata}) => {
        streamDeliveries.set(id, {
          streamId: stream.id,
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

    await broadcasterRoom.addStream(liveStream, {
      target: [...directNeighbors],
      metadata: {title: 'Keynote Live', fps: 60}
    })

    await waitFor(() => streamDeliveries.size === directNeighbors.size, 3_000)

    for (const neighborId of directNeighbors) {
      const delivery = streamDeliveries.get(neighborId)
      assert.ok(
        delivery,
        `direct neighbor ${neighborId} did not receive stream`
      )
      assert.equal(delivery.from, broadcasterId)
      assert.equal(delivery.streamId, 'main-broadcast-stream')
      assert.deepEqual(delivery.meta, {title: 'Keynote Live', fps: 60})
    }

    // Targeted media to a multi-hop peer promotes it to a direct WebRTC connection
    const multiHopTarget = cluster.peerIds.find(
      id => id !== broadcasterId && !directNeighbors.has(id)
    )!
    assert.ok(multiHopTarget)
    assert.equal(broadcasterRoom.getPeers()[multiHopTarget]?.direct, false)

    await broadcasterRoom.addStream(liveStream, {
      target: multiHopTarget,
      metadata: {title: 'Promoted Direct Stream', fps: 60}
    })

    await waitFor(() => streamDeliveries.has(multiHopTarget), 3_000)
    assert.equal(broadcasterRoom.getPeers()[multiHopTarget]?.direct, true)
    assert.deepEqual(streamDeliveries.get(multiHopTarget)?.meta, {
      title: 'Promoted Direct Stream',
      fps: 60
    })

    const allMediaPeers = [...directNeighbors, multiHopTarget]

    // Test replaceTrack and metadata update across connected media peers
    const videoTrack2 = {
      id: 'video-track-4k-screenshare'
    } as unknown as MediaStreamTrack
    await broadcasterRoom.replaceTrack(videoTrack1, videoTrack2, {
      target: allMediaPeers
    })
    await broadcasterRoom.addStream(liveStream, {
      target: allMediaPeers,
      metadata: {mode: 'screenshare'}
    })

    await waitFor(() =>
      allMediaPeers.every(
        id => streamDeliveries.get(id)?.meta?.mode === 'screenshare'
      )
    )

    let totalReplaceTrackCalls = 0
    for (const pair of cluster.directLinks.values()) {
      totalReplaceTrackCalls +=
        (pair.peerA as any).replaceTrackCalls +
        (pair.peerB as any).replaceTrackCalls
    }
    assert.equal(totalReplaceTrackCalls, allMediaPeers.length)

    // Test removeStream across connected media peers
    broadcasterRoom.removeStream(liveStream, {target: allMediaPeers})
    await waitFor(() => {
      let count = 0
      for (const pair of cluster.directLinks.values()) {
        count +=
          (pair.peerA as any).removeStreamCalls +
          (pair.peerB as any).removeStreamCalls
      }
      return count === allMediaPeers.length
    }, 3_000)
  } finally {
    await cluster.cleanup()
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
      alertActions.set(
        id,
        room.makeAction<{alertId: string}>('alert', {
          onMessage: ({alertId}) => {
            receivedAlerts.get(id)!.add(alertId)
          }
        })
      )
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
    topology: {mode: 'gossip', maxConnections: 4},
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
    topology: {mode: 'gossip', maxConnections: 4},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })

  const bob = createOverlayManager({
    selfId: 'bob',
    appId: 'sec-app',
    roomId: 'sec-room',
    password: 'correct-horse-battery-staple',
    topology: {mode: 'gossip', maxConnections: 4},
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
      q: 2,
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
    {o: 'alice', q: 3, m: 'alice:unsigned-spoof-2'},
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
  assert.equal(normalizeTopologyConfig('gossip').mode, 'gossip')
  assert.equal(normalizeTopologyConfig('auto').mode, 'auto')
  assert.throws(
    () => normalizeTopologyConfig('mesh' as any),
    /invalid topology mode/
  )
  assert.throws(
    () => normalizeTopologyConfig('broadcast' as any),
    /invalid topology mode/
  )

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
      use: [scale('gossip')],
      rtcPolyfill: MockRTCPeerConnection as any
    },
    'lobby'
  )
  const roomB = joinRoom(
    {
      appId: 'topic-e2e-overlay',
      _test_only_forcedPeerId: 'peer-beta',
      use: [scale({mode: 'gossip', maxConnections: 6})],
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
      maxConnections: 4
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
      maxConnections: 4
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
      maxConnections: 4
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
      ) as BufferSource
    )
  )
  const validRoomAuthForHijack = Array.from(authDigest, b =>
    b.toString(16).padStart(2, '0')
  ).join('')
  const hijackCanonical = descriptorCanonicalPayload(
    {
      peerId: 'alice',
      seq: 999,
      neighbors: ['relay'],
      signPubKey: mallorySignJwk,
      encPubKey: malloryEncJwk,
      roomAuth: validRoomAuthForHijack
    },
    'adv-app',
    'adv-room'
  )
  const hijackSigBuf = await crypto.subtle.sign(
    {name: 'ECDSA', hash: 'SHA-256'},
    mallorySignPair.privateKey,
    encodeBytes(hijackCanonical) as BufferSource
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

  // Attack C: Legacy/forged gossip `down` field in control frame is ignored and cannot evict Alice
  bob.handleOverlayFrame(
    'relay',
    new Uint8Array([
      overlayFrameVersion,
      overlayControlKind,
      ...encodeBytes(
        JSON.stringify({t: 'gossip', descriptors: [], down: ['alice']})
      )
    ]).slice().buffer
  )
  await wait(40)
  assert.ok(
    bob.getSnapshot().roomPeerIds.includes('alice'),
    'Alice must remain in Bob roomPeerIds after legacy/forged gossip down claim'
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
      maxConnections: 4
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
      q: parsedGenuine.header['q'],
      m: parsedGenuine.header['m'],
      s: hijackSigB64
    },
    encodeBytes('CORRUPTED-FAST-PATH-PACKET')
  )
  // 1. Inject forged packet with msgId & seq first
  carol.handleOverlayFrame('relay', poisonedSameMsgIdPacket.slice().buffer)
  await wait(30)
  assert.equal(carolDelivered.length, 0)
  assert.equal(carol.getSnapshot().stats.signatureFailures, 1)

  // 2. Now inject the genuine signed packet with the exact same msgId & seq
  carol.handleOverlayFrame('relay', genuineAliceBroadcast!.slice().buffer)
  await waitFor(() => carolDelivered.length === 1, 1_000)
  assert.equal(
    carolDelivered[0],
    'GENUINE-BROADCAST-AFTER-POISON-ATTEMPT',
    'forged packet must not poison replay window or seenMessages cache against genuine packet'
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
  // and inject into a new relay (`relayClamp`) to verify forwarded TTL is clamped to maxAllowedHops - 1
  const clampedForwardedFrames: Uint8Array[] = []
  const relayClamp = createOverlayManager({
    selfId: 'relay-clamp',
    appId: 'adv-app',
    roomId: 'adv-room',
    password: 'shared-room-secret',
    topology: {
      mode: 'gossip',
      maxConnections: 4
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
    maxAllowedHops - 1,
    `incoming TTL=255 must be clamped to maxAllowedHops(${maxAllowedHops}) - 1 = ${maxAllowedHops - 1} on forwarding`
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
      q: 99,
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
      maxConnections: 4
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
      maxConnections: 4
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
      maxConnections: 4
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
      maxConnections: 4
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

  // Send 5 broadcasts from Alice -> Bob while blackholeRelay drops 100% of data packets
  // (flood + dedupe delivers via honestRelay), then mark blackholeRelay link dead
  // on Alice so unicast automatically fails over to backupNextHop (honestRelay)
  for (let i = 0; i < 5; i++) {
    await alice.broadcastInline(encodeBytes(`byz-broadcast-${i}`))
  }

  await waitFor(() => bobDelivered.length === 5, 2_000)
  assert.ok(
    blackholeDroppedCount >= 1,
    `expected blackholeRelay to drop data packets (dropped ${blackholeDroppedCount})`
  )

  // Now simulate primary nextHop (relay-blackhole) link failure so unicast uses disjoint backupNextHop
  alice.removeDirectPeer('relay-blackhole')
  for (let i = 0; i < 5; i++) {
    alice.sendUnicast('bob', encodeBytes(`byz-unicast-${i}`))
  }

  await waitFor(() => bobDelivered.length === 10, 2_000)

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
  const provisioned = await createAdminRoom('auth-boot-app', 'watch-party')
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
        use: [roles({selfAsAdmin: true})],
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
    assert.equal(hostAuth.roomId, `game-lobby~${hostAuth.fingerprint}`)
    assert.equal(hostAuth.isAdmin, true)
    assert.deepEqual(hostAuth.roles, ['admin'])
    assert.equal(hostAuth.userId, hostIdentity.userId)

    // Room IDs with a single dot + 16 alphanumeric chars (e.g. lobby-${Math.random()}) must NOT throw without roles()
    const dottedRoom = joinRoom(
      {
        appId: 'auth-bootstrap-app',
        _test_only_forcedPeerId: 'dotted-room-peer',
        rtcPolyfill: MockRTCPeerConnection as any
      },
      `lobby-0.${hostAuth.fingerprint}`
    )
    createdRooms.push(dottedRoom)

    // Joining a self-certifying roomId (~ separator) WITHOUT roles() throws an error
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
        use: [roles()],
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

    // Impostor whose userId does not match the room fingerprint and is not in admins[] does not get admin status
    const impostorIdentity = await createUserIdentity()
    const impostorRoom = joinRoom(
      {
        appId: 'auth-bootstrap-app',
        _test_only_forcedPeerId: 'impostor-peer',
        identity: impostorIdentity,
        use: [roles()],
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

    // Configured co-admins in admins: [...] ARE honored even in fingerprinted rooms
    const coAdminIdentity = await createUserIdentity()
    const coAdminRoom = joinRoom(
      {
        appId: 'auth-bootstrap-app',
        _test_only_forcedPeerId: 'coadmin-peer',
        identity: coAdminIdentity,
        use: [roles({admins: [coAdminIdentity.userId]})],
        rtcPolyfill: MockRTCPeerConnection as any
      },
      hostAuth.roomId
    )
    createdRooms.push(coAdminRoom)
    const coAdminAuth = await coAdminRoom.getSelf()
    assert.equal(
      coAdminAuth.isAdmin,
      true,
      'configured co-admins in admins: [...] must be honored in fingerprinted rooms'
    )

    // Rejoining with the saved host UserIdentity automatically restores root admin status on the same roomId (with roles())
    const rejoinedHostRoom = joinRoom(
      {
        appId: 'auth-bootstrap-app',
        _test_only_forcedPeerId: 'host-rejoined',
        identity: await importUserIdentity(exportUserIdentity(hostIdentity)),
        use: [roles()],
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
        use: [roles({admins: [hostIdentity.userId]})],
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
        use: [roles({admins: [hostIdentity.userId]})],
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
  const provisioned = await createAdminRoom('priv-action-app', 'raid-room')
  const roomId = provisioned.roomId
  const appId = 'priv-action-app'

  // Set up a 4-peer multi-hop chain in small-world overlay:
  // admin <-> bob <-> carol <-> mallory
  const peers = ['admin', 'bob', 'carol', 'mallory'] as const
  const regMap = new Map<string, (peer: any, id: string) => void>()
  const rooms = new Map<string, Room & RolesPluginApi & ScalePluginApi>()

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
        use: [scale({mode: 'gossip', maxConnections: 4}), roles()],
        identity: peerIdentity
      }
    )
    rooms.set(id, room as any)
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

  const regMap = new Map<string, (peer: any, id: string) => void>()
  const makePeerRoom = (
    id: string,
    identity: typeof adminUser1
  ): Room & RolesPluginApi =>
    createRoom(
      f => regMap.set(id, f),
      () => {},
      () => {},
      {
        selfId: id,
        appId,
        roomId,
        identity,
        use: [roles({admins: coAdmins})]
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
      Object.keys(admin1.getPeers()).length === 2 &&
      Object.keys(viewer1.getPeers()).length === 2,
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
      {seq: 2, ts: 100, updatedBy: 'a', hash: '11'} as any,
      {seq: 1, ts: 200, updatedBy: 'b', hash: '22'} as any
    ) > 0,
    true
  )

  await Promise.all([viewer1.leave(), viewer2.leave()])
})

void test('Hop-1 unauthorized broadcast drop and multi-layer room.ban enforcement', async () => {
  // 1. Hop-1 relay drops unauthorized overlay broadcast before forwarding downstream
  const forwardedToDownstream: Uint8Array[] = []
  const malloryOverlay = createOverlayManager({
    selfId: 'mallory-ov',
    appId: 'hop1-app',
    roomId: 'hop1-room',
    topology: {mode: 'gossip', maxConnections: 4},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })
  const hop1RelayOverlay = createOverlayManager({
    selfId: 'relay-ov',
    appId: 'hop1-app',
    roomId: 'hop1-room',
    topology: {mode: 'gossip', maxConnections: 4},
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
  const provisioned = await createAdminRoom('ban-test-app', 'ban-test-room')
  const roomId = provisioned.roomId
  const appId = 'ban-test-app'

  const regMap = new Map<string, (peer: any, id: string) => void>()
  const rooms = new Map<string, Room & RolesPluginApi & ScalePluginApi>()
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
        use: [roles()],
        identity: peerIdentity
      }
    )
    rooms.set(id, room as any)
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
        Object.keys(rooms.get('admin')!.getPeers()).length === 2 &&
        Object.keys(rooms.get('honest')!.getPeers()).length === 2,
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
      'mallory' in rooms.get('honest')!.getPeers(),
      false,
      'banned peer must be immediately disconnected from honest peers'
    )

    // Even if Mallory tries to reconnect to Honest with a new peer connection, Honest immediately rejects/destroys it
    connectDirect('honest', 'mallory')
    await wait(50)
    assert.equal(
      'mallory' in rooms.get('honest')!.getPeers(),
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
  const roomA1 = await createAdminRoom('app-one', 'lobby', {
    identity: hostUser
  })
  const roomB1 = await createAdminRoom('app-one', 'general', {
    identity: hostUser
  })
  const roomOther = await createAdminRoom('app-one', 'lobby', {
    identity: otherUser
  })
  assert.equal(
    roomA1.fingerprint,
    roomB1.fingerprint,
    'same UserIdentity must deterministically derive the same self-certifying fingerprint'
  )
  assert.equal(roomA1.roomId, `lobby~${roomA1.fingerprint}`)
  assert.equal(roomB1.roomId, `general~${roomB1.fingerprint}`)
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
  const provisioned = await createAdminRoom('audit-app', 'audit-room')
  const roomId = provisioned.roomId
  const appId = 'audit-app'
  const peerIds = ['admin', 'bob', 'carol', 'mallory']
  const regMap = new Map<string, (peer: any, id: string) => void>()
  const rooms = new Map<string, Room & RolesPluginApi & ScalePluginApi>()

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
        use: [scale({mode: 'gossip', maxConnections: 4}), roles()],
        identity: peerIdentity
      }
    )
    rooms.set(id, room as any)
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
    topology: {mode: 'gossip', maxConnections: 4},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () =>
      assert.fail('plaintext unicast must never be delivered')
  })
  const ovB = createOverlayManager({
    selfId: 'ov-b',
    appId: 'unicast-app',
    roomId: 'unicast-room',
    topology: {mode: 'gossip', maxConnections: 4},
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
  const canonical = canonicalUnicastHeader(
    'ov-a',
    'ov-b',
    msgId,
    '',
    1,
    'unicast-app',
    'unicast-room'
  )
  const combined = buildOverlaySignedBytes(canonical, rawPayload)
  const sigBuf = await crypto.subtle.sign(
    {name: 'ECDSA', hash: 'SHA-256'},
    idA.signPrivateKey,
    combined as BufferSource
  )
  const sigB64 = Buffer.from(sigBuf).toString('base64')
  const downgradePacket = packOverlayBinary(
    overlayUnicastKind,
    6,
    {o: 'ov-a', d: 'ov-b', q: 1, m: msgId, s: sigB64},
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
})

void test('Targeted media stays private for direct and multi-hop recipients', async () => {
  const cluster = await createOverlayCluster({
    peerCount: 8,
    topology: {mode: 'gossip', maxConnections: 4},
    media: true
  })
  try {
    const source = cluster.rooms.get('peer-0000')!
    const peerEntries = Object.entries(source.getPeers())
    const direct = peerEntries.find(([, info]) => info.direct)![0]
    const remote = peerEntries.find(([, info]) => !info.direct)![0]
    assert.equal(source.getPeers()[direct].direct, true)
    assert.equal(source.getPeers()[remote].direct, false)
    const streams: string[] = []
    for (const [id, room] of cluster.rooms) {
      room.onPeerStream = () => streams.push(id)
    }
    for (const target of [direct, remote]) {
      streams.length = 0
      const camera = {id: `camera-${target}`} as unknown as MediaStreamTrack
      const stream = {
        id: `private-${target}`,
        getTracks: () => [camera]
      } as unknown as MediaStream
      await source.addStream(stream, {target})
      await wait(100)
      assert.deepEqual(
        streams,
        [target],
        'only the requested peer receives a stream'
      )
      assert.equal(source.getPeers()[target].direct, true)
    }
  } finally {
    await cluster.cleanup()
  }
})

void test('Removing a broadcast stream prevents replay after topology healing', async () => {
  const cluster = await createOverlayCluster({
    peerCount: 8,
    topology: {mode: 'gossip', maxConnections: 4},
    media: true
  })
  try {
    const source = cluster.rooms.get('peer-0000')!
    const track = {id: 'removed-camera'} as unknown as MediaStreamTrack
    const stream = {
      id: 'removed-stream',
      getTracks: () => [track]
    } as unknown as MediaStream
    await source.addStream(stream)
    await wait(100)
    assert.ok(cluster.addedTracks.length >= 4)
    source.removeStream(stream)
    await wait(100)
    cluster.addedTracks.length = 0
    const dropId = source.getTopology().directPeerIds[0]!
    cluster.dropPeer(dropId)
    await cluster.healCluster()
    await wait(100)
    assert.deepEqual(
      cluster.addedTracks,
      [],
      'removed streams must never be sent again'
    )
  } finally {
    await cluster.cleanup()
  }
})

void test('Removing and replacing tracks updates streams before promoting additional peers', async () => {
  for (const replace of [false, true]) {
    const cluster = await createOverlayCluster({
      peerCount: 8,
      topology: {mode: 'gossip', maxConnections: 4},
      media: true
    })
    try {
      const source = cluster.rooms.get('peer-0000')!
      const directPeerId = source.getTopology().directPeerIds[0]!
      const remotePeerId = Object.entries(source.getPeers()).find(
        ([, info]) => !info.direct
      )![0]
      const camera = {id: 'camera'} as unknown as MediaStreamTrack
      const audio = {id: 'audio'} as unknown as MediaStreamTrack
      let currentTracks = [camera, audio]
      const stream = {
        id: 'two-track-stream',
        getTracks: () => [...currentTracks]
      } as unknown as MediaStream
      await source.addStream(stream, {target: directPeerId})
      await wait(50)
      if (replace) {
        const replacementCamera = {
          id: 'replacement-camera'
        } as unknown as MediaStreamTrack
        await source.replaceTrack(camera, replacementCamera, {
          target: directPeerId
        })
        await wait(50)
      }
      currentTracks = [audio]
      await source.addStream(stream, {target: directPeerId})
      await wait(50)
      cluster.addedTracks.length = 0
      await source.addStream(stream, {target: remotePeerId})
      await wait(50)
      assert.ok(
        cluster.addedTracks.length > 0,
        'remaining audio must be sent to promoted peer'
      )
      assert.ok(
        cluster.addedTracks.every(id => id === 'audio'),
        `removed camera must not be sent (replace=${replace}): ${cluster.addedTracks.join(',')}`
      )
      source.removeStream(stream)
      await wait(50)
      cluster.addedTracks.length = 0
      const dropId2 = source.getTopology().directPeerIds[0]!
      cluster.dropPeer(dropId2)
      await cluster.healCluster()
      await wait(50)
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
      use: [telemetryPlugin('mod1')]
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
      use: [telemetryPlugin('mod2')]
    }
  )
  assert.deepEqual((room2 as any).getEvents(), [
    'mod1:setup:custom-peer:plugin-room',
    'mod1:destroy:custom-peer',
    'mod2:setup:custom-peer-2:plugin-room-2'
  ])
  await room2.leave()
})

void test('C1 regression: gossip descriptor dumps and flushes chunk below maxActionFrameBytes / maxRoomFrameBytes at scale with role certs', async () => {
  // 1. Direct unit test of packGossipControlFrames with 30 cert-bearing descriptors
  const adminUser = await createUserIdentity()
  const descriptors = []
  for (let i = 0; i < 30; i++) {
    const peerUser = await createUserIdentity()
    const peerId = `cert-peer-${String(i).padStart(3, '0')}`
    const cert = await signRoleCertificate(
      adminUser.sign,
      adminUser.signPubJwk,
      {
        appId: 'c1-app',
        roomId: 'c1-room',
        subPeerId: peerId,
        subUserId: peerUser.userId,
        subPubKey: peerUser.signPubJwk,
        roles: ['moderator', 'speaker'],
        canDelegate: true
      }
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
  const provisioned = await createAdminRoom('c1-cluster-app', 'c1-cluster-room')
  const roomId = provisioned.roomId
  const appId = 'c1-cluster-app'
  const peerIds = Array.from(
    {length: peerCount},
    (_, i) => `c1-peer-${String(i).padStart(2, '0')}`
  )
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
    const peerIdentity =
      i === 0 ? provisioned.identity : await createUserIdentity()
    const room = createRoom(
      peerRegister => {
        registerCallbacks.set(id, peerRegister)
      },
      () => {},
      () => {},
      {
        selfId: id,
        appId,
        roomId,
        use: [
          scale({
            mode: 'gossip',
            maxConnections: 6
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
      const targets = computeTargetNeighbors(id, activeSet, 'gossip', 6)
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
      await adminRoom.grantRole(peerIds[i]!, 'moderator', {canDelegate: true})
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

void test('C2 regression: relay boundary-shifting bytes between msgId and payload fails signature verification and never evicts origin', async () => {
  // Set up a line topology: alice <-> relay <-> bob <-> carol
  const peerIds = ['alice', 'relay', 'bob', 'carol']
  const registerCallbacks = new Map<string, (peer: any, id: string) => void>()
  const rooms = new Map<string, Room & RolesPluginApi & ScalePluginApi>()
  const receivedByBob: Array<{data: string; peerId: string}> = []
  const receivedByCarol: Array<{data: string; peerId: string}> = []
  const senders = new Map<string, (data: string) => Promise<void>>()
  const capturedBroadcastsAtRelay: Uint8Array[] = []

  for (const id of peerIds) {
    const room = createRoom(
      peerRegister => {
        registerCallbacks.set(id, peerRegister)
      },
      () => {},
      () => {},
      {
        selfId: id,
        appId: 'c2-boundary-app',
        roomId: 'c2-boundary-room',
        use: [
          scale({
            mode: 'gossip',
            maxConnections: 4
          })
        ]
      }
    )
    const chatAction = room.makeAction<string>('chat', {
      onMessage: (data, {peerId}) => {
        if (id === 'bob') {
          receivedByBob.push({data, peerId})
        }
        if (id === 'carol') {
          receivedByCarol.push({data, peerId})
        }
      }
    })
    senders.set(id, chatAction.send)
    rooms.set(id, room as any)
  }

  try {
    // Link alice <-> relay
    const linkAR = linkPeers(new LinkedPeer(), new LinkedPeer())
    registerCallbacks.get('alice')!(linkAR.peerA, 'relay')
    registerCallbacks.get('relay')!(linkAR.peerB, 'alice')

    // Link relay <-> bob, intercepting frames from relay to bob
    const linkRB = linkPeers(new LinkedPeer(), new LinkedPeer())
    const origRelayToBobSend = linkRB.peerA.sendData.bind(linkRB.peerA)
    linkRB.peerA.sendData = (data: Uint8Array) => {
      const parsed = unpackOverlayBinary(data)
      if (
        parsed?.kind === overlayBroadcastKind &&
        parsed.header['o'] === 'alice'
      ) {
        capturedBroadcastsAtRelay.push(data.slice())
      }
      origRelayToBobSend(data)
    }
    registerCallbacks.get('relay')!(linkRB.peerA, 'bob')
    registerCallbacks.get('bob')!(linkRB.peerB, 'relay')

    // Link bob <-> carol
    const linkBC = linkPeers(new LinkedPeer(), new LinkedPeer())
    registerCallbacks.get('bob')!(linkBC.peerA, 'carol')
    registerCallbacks.get('carol')!(linkBC.peerB, 'bob')

    await waitFor(
      () =>
        rooms.get('bob')!.getTopology().roomPeerIds.includes('alice') &&
        rooms.get('carol')!.getTopology().roomPeerIds.includes('alice'),
      3_000
    )

    // Alice broadcasts a normal message
    await senders.get('alice')!('legitimate-first-message')
    await waitFor(
      () =>
        receivedByBob.length === 1 &&
        receivedByCarol.length === 1 &&
        capturedBroadcastsAtRelay.length >= 1,
      2_000
    )

    const captured = unpackOverlayBinary(
      capturedBroadcastsAtRelay[capturedBroadcastsAtRelay.length - 1]!
    )!
    assert.ok(captured, 'expected captured broadcast packet from alice')
    assert.equal(
      captured.payload[0],
      2,
      'expected action-wire v2 version byte (0x02) at start of payload'
    )

    const origMsgId = captured.header['m'] as string
    const origSig = captured.header['s'] as string

    // Attack 1 (exact C2 exploit): move the first byte of payload ("\u0002") into header.m
    const shiftedMsgId1 =
      origMsgId + decodeBytes(captured.payload.subarray(0, 1))
    const shiftedPayload1 = captured.payload.subarray(1)
    const exploitPacket1 = packOverlayBinary(
      overlayBroadcastKind,
      captured.ttl,
      {o: 'alice', q: 50, m: shiftedMsgId1, s: origSig},
      shiftedPayload1
    )

    // Attack 2: move a printable suffix of msgId into the front of payload
    const shiftedMsgId2 = origMsgId.slice(0, -1)
    const movedCharBytes = encodeBytes(origMsgId.slice(-1))
    const shiftedPayload2 = new Uint8Array(
      movedCharBytes.byteLength + captured.payload.byteLength
    )
    shiftedPayload2.set(movedCharBytes, 0)
    shiftedPayload2.set(captured.payload, movedCharBytes.byteLength)
    const exploitPacket2 = packOverlayBinary(
      overlayBroadcastKind,
      captured.ttl,
      {o: 'alice', q: 51, m: shiftedMsgId2, s: origSig},
      shiftedPayload2
    )

    const bobStatsBefore = rooms.get('bob')!.getTopology()
      .stats.signatureFailures
    const bobForwardedBefore = rooms.get('bob')!.getTopology()
      .stats.messagesForwarded

    origRelayToBobSend(exploitPacket1)
    origRelayToBobSend(exploitPacket2)
    await wait(80)

    const bobStatsAfter = rooms.get('bob')!.getTopology()
      .stats.signatureFailures
    const bobForwardedAfter = rooms.get('bob')!.getTopology()
      .stats.messagesForwarded

    assert.equal(
      bobStatsAfter,
      bobStatsBefore + 2,
      'both boundary-shifted packets must be rejected as signature failures'
    )
    assert.equal(
      bobForwardedAfter,
      bobForwardedBefore,
      'boundary-shifted packets must never be re-forwarded by receivers'
    )
    assert.ok(
      rooms.get('bob')!.getTopology().roomPeerIds.includes('alice'),
      'victim origin (alice) must NOT be evicted/kicked from bob'
    )
    assert.ok(
      rooms.get('carol')!.getTopology().roomPeerIds.includes('alice'),
      'victim origin (alice) must NOT be evicted/kicked from carol'
    )
    assert.ok(
      rooms.get('alice')!.getTopology().roomPeerIds.includes('bob'),
      'alice must remain connected to bob (no forged leave triggered)'
    )

    // Verify Alice can still broadcast normally to Bob and Carol afterwards
    await senders.get('alice')!('legitimate-second-message')
    await waitFor(
      () => receivedByBob.length === 2 && receivedByCarol.length === 2,
      2_000
    )
    assert.equal(receivedByBob[1]!.data, 'legitimate-second-message')
    assert.equal(receivedByCarol[1]!.data, 'legitimate-second-message')
  } finally {
    await Promise.all([...rooms.values()].map(r => r.leave()))
  }
})

void test('C3 regression: live room rejects a RoleRevocationRecord re-wrapped as a PeerBanRecord', async () => {
  const provisioned = await createAdminRoom('c3-live-app', 'c3-live-room')
  const roomId = provisioned.roomId
  const appId = 'c3-live-app'
  const [modUser, attackerUser] = await Promise.all([
    createUserIdentity(),
    createUserIdentity()
  ])
  const peerIds = ['admin-peer', 'mod-peer', 'attacker-peer']
  const usersByPeer: Record<string, any> = {
    'admin-peer': provisioned.identity,
    'mod-peer': modUser,
    'attacker-peer': attackerUser
  }
  const registerCallbacks = new Map<string, (peer: any, id: string) => void>()
  const rooms = new Map<string, Room & RolesPluginApi & ScalePluginApi>()
  const directLinks = new Map<string, {peerA: LinkedPeer; peerB: LinkedPeer}>()
  const capturedAuthFrames: Uint8Array[] = []

  const connectPair = (idA: string, idB: string) => {
    const key = idA < idB ? `${idA}<->${idB}` : `${idB}<->${idA}`
    if (directLinks.has(key)) {
      return
    }
    const {peerA, peerB} = linkPeers(new LinkedPeer(), new LinkedPeer())
    if (idA === 'admin-peer' && idB === 'attacker-peer') {
      const origSend = peerA.sendData.bind(peerA)
      peerA.sendData = (data: Uint8Array) => {
        if (decodeBytes(data).includes('{"t":"revoke"')) {
          capturedAuthFrames.push(data.slice())
        }
        origSend(data)
      }
    }
    directLinks.set(key, {peerA, peerB})
    registerCallbacks.get(idA)!(peerA, idB)
    registerCallbacks.get(idB)!(peerB, idA)
  }

  for (const id of peerIds) {
    const room = createRoom(
      peerRegister => {
        registerCallbacks.set(id, peerRegister)
      },
      () => {},
      () => {},
      {
        selfId: id,
        appId,
        roomId,
        use: [scale(), roles()],
        identity: usersByPeer[id]!
      }
    )
    rooms.set(id, room as any)
  }

  try {
    connectPair('admin-peer', 'mod-peer')
    connectPair('admin-peer', 'attacker-peer')
    connectPair('mod-peer', 'attacker-peer')

    await waitFor(
      () =>
        rooms.get('admin-peer')!.getTopology().directPeerIds.length === 2 &&
        rooms.get('mod-peer')!.getTopology().directPeerIds.length === 2 &&
        rooms.get('attacker-peer')!.getTopology().directPeerIds.length === 2,
      2_000
    )

    const adminRoom = rooms.get('admin-peer')!
    const modRoom = rooms.get('mod-peer')!
    const attackerRoom = rooms.get('attacker-peer')!

    await waitFor(
      () =>
        modRoom.getRoles('admin-peer').includes('admin') &&
        attackerRoom.getRoles('admin-peer').includes('admin'),
      2_000
    )

    // Admin grants 'moderator' to mod-peer, then revokes 'moderator'
    await adminRoom.grantRole('mod-peer', 'moderator')
    await waitFor(
      () => attackerRoom.getRoles('mod-peer').includes('moderator'),
      2_000
    )

    capturedAuthFrames.length = 0
    await adminRoom.revokeRole('mod-peer', 'moderator')
    await waitFor(
      () =>
        !attackerRoom.getRoles('mod-peer').includes('moderator') &&
        capturedAuthFrames.length >= 1,
      2_000
    )

    // Extract the signed RoleRevocationRecord from the captured '$auth' frame
    let capturedRevocation: any = null
    for (const frame of capturedAuthFrames) {
      const text = decodeBytes(frame)
      const jsonStart = text.indexOf('{"t":"revoke"')
      if (jsonStart !== -1) {
        capturedRevocation = JSON.parse(text.slice(jsonStart)).revocation
      }
    }
    assert.ok(
      capturedRevocation,
      'expected attacker to capture signed RoleRevocationRecord from wire'
    )

    // Attacker re-wraps the captured RoleRevocationRecord into a PeerBanRecord with the same signature
    const forgedBan = {
      v: capturedRevocation.v,
      appId: capturedRevocation.appId,
      roomId: capturedRevocation.roomId,
      issuerPeerId: capturedRevocation.issuerPeerId,
      targetPeerId: capturedRevocation.targetPeerId,
      ...(capturedRevocation.targetUserId
        ? {targetUserId: capturedRevocation.targetUserId}
        : {}),
      ...(capturedRevocation.role ? {reason: capturedRevocation.role} : {}),
      seq: capturedRevocation.seq,
      ts: capturedRevocation.ts,
      issuerCert: capturedRevocation.issuerCert,
      sig: capturedRevocation.sig
    }

    // Craft a raw '$auth' wire frame carrying {t: 'ban', ban: forgedBan} and inject it into admin-peer and mod-peer
    const revokeFrame = capturedAuthFrames.find(f =>
      decodeBytes(f).includes('{"t":"revoke"')
    )!
    const revokeText = decodeBytes(revokeFrame)
    const jsonOffset = revokeText.indexOf('{"t":"revoke"')
    const frameHeaderPrefix = revokeFrame.subarray(
      0,
      encodeBytes(revokeText.slice(0, jsonOffset)).byteLength
    )
    const forgedBanBodyBytes = encodeBytes(
      JSON.stringify({t: 'ban', ban: forgedBan})
    )
    const forgedBanWireFrame = new Uint8Array(
      frameHeaderPrefix.byteLength + forgedBanBodyBytes.byteLength
    )
    forgedBanWireFrame.set(frameHeaderPrefix, 0)
    forgedBanWireFrame.set(forgedBanBodyBytes, frameHeaderPrefix.byteLength)

    const adminSigFailBefore = adminRoom.getTopology().stats.signatureFailures
    directLinks
      .get('admin-peer<->attacker-peer')!
      .peerB.sendData(forgedBanWireFrame)
    directLinks
      .get('attacker-peer<->mod-peer')!
      .peerA.sendData(forgedBanWireFrame)
    await wait(60)

    assert.equal(
      adminRoom.isBanned('mod-peer'),
      false,
      'adminRoom must not ban mod-peer from a re-wrapped revocation'
    )
    assert.equal(
      adminRoom.isBanned(modUser.userId),
      false,
      'adminRoom must not ban modUser from a re-wrapped revocation'
    )
    assert.equal(
      modRoom.isBanned('mod-peer'),
      false,
      'modRoom must not ban mod-peer from a re-wrapped revocation'
    )
    assert.ok(
      adminRoom.getTopology().stats.signatureFailures > adminSigFailBefore,
      'forged ban from revocation must increment signatureFailures'
    )
    assert.ok(
      adminRoom.getTopology().directPeerIds.includes('mod-peer'),
      'mod-peer must remain connected in adminRoom'
    )
  } finally {
    await Promise.all([...rooms.values()].map(r => r.leave()))
  }
})

void test('Overlay & room hardening: fake neighbor roster inflation, unknown-origin unicast relay, departed-peer broadcast resurrection, stale leave replay, maxOverlayHeaderBytes, and third-party prune', async () => {
  const appId = 'overlay-hardening-test'
  const roomId = 'hardening-room'
  const deliveredAtBob: Array<{from: string; bytes: Uint8Array}> = []
  const virtualJoinsAtBob: string[] = []
  const virtualLeavesAtBob: string[] = []
  const sentFromRelayToBob: Uint8Array[] = []

  const alice = createOverlayManager({
    selfId: 'alice',
    appId,
    roomId,
    topology: {mode: 'gossip', maxConnections: 6},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })
  const relay = createOverlayManager({
    selfId: 'relay',
    appId,
    roomId,
    topology: {mode: 'gossip', maxConnections: 6},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })
  const bob = createOverlayManager({
    selfId: 'bob',
    appId,
    roomId,
    topology: {
      mode: 'auto',
      autoThreshold: 12,
      maxConnections: 6
    },
    onVirtualPeerJoin: pid => virtualJoinsAtBob.push(pid),
    onVirtualPeerLeave: pid => virtualLeavesAtBob.push(pid),
    onDeliverData: (from, data) =>
      deliveredAtBob.push({from, bytes: new Uint8Array(data)})
  })
  const mallory = createOverlayManager({
    selfId: 'mallory',
    appId,
    roomId,
    topology: {mode: 'gossip', maxConnections: 6},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })

  try {
    // Link alice <-> relay <-> bob, and mallory <-> bob
    alice.addDirectPeer('relay', {
      connection: {} as RTCPeerConnection,
      channel: null,
      isDead: false,
      getOffer: async () => {},
      sendData: d => relay.handleOverlayFrame('alice', d.slice().buffer),
      signal: async () => {},
      addStream: () => {},
      removeStream: () => {},
      addTrack: () => ({}) as RTCRtpSender,
      removeTrack: () => {},
      replaceTrack: async () => {},
      setHandlers: () => {},
      destroy: () => {}
    })
    relay.addDirectPeer('alice', {
      connection: {} as RTCPeerConnection,
      channel: null,
      isDead: false,
      getOffer: async () => {},
      sendData: d => alice.handleOverlayFrame('relay', d.slice().buffer),
      signal: async () => {},
      addStream: () => {},
      removeStream: () => {},
      addTrack: () => ({}) as RTCRtpSender,
      removeTrack: () => {},
      replaceTrack: async () => {},
      setHandlers: () => {},
      destroy: () => {}
    })
    relay.addDirectPeer('bob', {
      connection: {} as RTCPeerConnection,
      channel: null,
      isDead: false,
      getOffer: async () => {},
      sendData: d => {
        sentFromRelayToBob.push(d.slice())
        bob.handleOverlayFrame('relay', d.slice().buffer)
      },
      signal: async () => {},
      addStream: () => {},
      removeStream: () => {},
      addTrack: () => ({}) as RTCRtpSender,
      removeTrack: () => {},
      replaceTrack: async () => {},
      setHandlers: () => {},
      destroy: () => {}
    })
    bob.addDirectPeer('relay', {
      connection: {} as RTCPeerConnection,
      channel: null,
      isDead: false,
      getOffer: async () => {},
      sendData: d => relay.handleOverlayFrame('bob', d.slice().buffer),
      signal: async () => {},
      addStream: () => {},
      removeStream: () => {},
      addTrack: () => ({}) as RTCRtpSender,
      removeTrack: () => {},
      replaceTrack: async () => {},
      setHandlers: () => {},
      destroy: () => {}
    })
    mallory.addDirectPeer('bob', {
      connection: {} as RTCPeerConnection,
      channel: null,
      isDead: false,
      getOffer: async () => {},
      sendData: d => bob.handleOverlayFrame('mallory', d.slice().buffer),
      signal: async () => {},
      addStream: () => {},
      removeStream: () => {},
      addTrack: () => ({}) as RTCRtpSender,
      removeTrack: () => {},
      replaceTrack: async () => {},
      setHandlers: () => {},
      destroy: () => {}
    })
    bob.addDirectPeer('mallory', {
      connection: {} as RTCPeerConnection,
      channel: null,
      isDead: false,
      getOffer: async () => {},
      sendData: d => mallory.handleOverlayFrame('bob', d.slice().buffer),
      signal: async () => {},
      addStream: () => {},
      removeStream: () => {},
      addTrack: () => ({}) as RTCRtpSender,
      removeTrack: () => {},
      replaceTrack: async () => {},
      setHandlers: () => {},
      destroy: () => {}
    })

    await waitFor(
      () =>
        bob.getSnapshot().roomPeerIds.includes('alice') &&
        bob.getSnapshot().roomPeerIds.includes('mallory'),
      2_000
    )

    // 1. Mallory sends her own fresh signed descriptor with 15 fake neighbor IDs + legacy down: ['alice']
    const malloryId = await mallory.getLocalCryptoIdentity()
    const malloryFakeNeighbors = Array.from(
      {length: 15},
      (_, i) => `sybil-neighbor-${i}`
    )
    const malloryDesc = {
      peerId: 'mallory',
      seq: 50,
      neighbors: ['bob', ...malloryFakeNeighbors],
      signPubKey: malloryId.signPubJwk,
      encPubKey: malloryId.encPubJwk,
      sig: ''
    }
    const malloryDescCanonical = encodeBytes(
      descriptorCanonicalPayload(malloryDesc, appId, roomId)
    )
    malloryDesc.sig = Buffer.from(
      await ecdsaSign(
        malloryId.signPrivateKey,
        malloryDescCanonical as BufferSource
      )
    ).toString('base64')

    const gossipWithFreshDescAndDown = new Uint8Array([
      overlayFrameVersion,
      1,
      ...encodeBytes(
        JSON.stringify({
          t: 'gossip',
          descriptors: [malloryDesc],
          down: ['alice', 'unknown-phantom-1', 'unknown-phantom-2']
        })
      )
    ])
    bob.handleOverlayFrame('mallory', gossipWithFreshDescAndDown.slice().buffer)
    await wait(40)

    assert.ok(
      bob.getSnapshot().roomPeerIds.includes('alice'),
      'Alice must NOT be evicted when non-neighbor Mallory bundles her own fresh descriptor with down: ["alice"]'
    )
    // Verify Mallory's 15 fake unverified neighbor IDs did NOT inflate Bob's knownRoster or flip auto mode to gossip
    assert.equal(
      bob.getActiveMode(),
      'mesh',
      'unverified neighbor claims in a descriptor must not inflate knownRoster to flip auto mode to gossip'
    )

    // Also verify excessive neighbor list (> maxDescriptorNeighbors = 18) is rejected as signatureFailure
    const oversizedNeighborsDesc = {
      peerId: 'mallory',
      seq: 51,
      neighbors: Array.from({length: 25}, (_, i) => `excess-neighbor-${i}`),
      signPubKey: malloryId.signPubJwk,
      encPubKey: malloryId.encPubJwk,
      sig: 'AA=='
    }
    const sigFailBeforeExcess = bob.getSnapshot().stats.signatureFailures
    bob.handleOverlayFrame(
      'mallory',
      packOverlayControl({
        t: 'gossip',
        descriptors: [oversizedNeighborsDesc]
      }).slice().buffer
    )
    await wait(30)
    assert.equal(
      bob.getSnapshot().stats.signatureFailures,
      sigFailBeforeExcess + 1,
      'descriptor with excessive neighbor array must be rejected'
    )

    // 2. Unicast frame from an unknown origin is rejected at the relay and never forwarded to Bob
    const relaySentBefore = sentFromRelayToBob.length
    const relaySigFailBefore = relay.getSnapshot().stats.signatureFailures
    const fakeUnicastHeader = encodeBytes(
      JSON.stringify({
        o: 'unknown-attacker-origin',
        d: 'bob',
        q: 1,
        m: 'unknown-attacker-origin:msg-1',
        iv: Buffer.from(new Uint8Array(12)).toString('base64'),
        s: Buffer.from(new Uint8Array(64)).toString('base64')
      })
    )
    const fakeUnicastFrame = new Uint8Array(
      5 + fakeUnicastHeader.byteLength + 4
    )
    fakeUnicastFrame[0] = overlayFrameVersion
    fakeUnicastFrame[1] = 3
    fakeUnicastFrame[2] = 6
    fakeUnicastFrame[3] = (fakeUnicastHeader.byteLength >>> 8) & 0xff
    fakeUnicastFrame[4] = fakeUnicastHeader.byteLength & 0xff
    fakeUnicastFrame.set(fakeUnicastHeader, 5)
    relay.handleOverlayFrame('alice', fakeUnicastFrame.slice().buffer)
    await wait(40)

    assert.equal(
      sentFromRelayToBob.length,
      relaySentBefore,
      'relay must drop unicast frame from unknown origin instead of forwarding it'
    )
    assert.equal(
      relay.getSnapshot().stats.signatureFailures,
      relaySigFailBefore + 1,
      'relay must record signatureFailure for unicast from unknown origin'
    )

    // 3. Oversized overlay binary header (> maxOverlayHeaderBytes = 1024 B) is rejected
    const oversizedHeaderBytes = encodeBytes(
      JSON.stringify({
        o: 'alice',
        q: 1,
        m: 'alice:oversized',
        pad: 'x'.repeat(1200)
      })
    )
    const oversizedFrame = new Uint8Array(
      5 + oversizedHeaderBytes.byteLength + 2
    )
    oversizedFrame[0] = overlayFrameVersion
    oversizedFrame[1] = 2
    oversizedFrame[2] = 4
    oversizedFrame[3] = (oversizedHeaderBytes.byteLength >>> 8) & 0xff
    oversizedFrame[4] = oversizedHeaderBytes.byteLength & 0xff
    oversizedFrame.set(oversizedHeaderBytes, 5)
    const deliveredBeforeOversized = deliveredAtBob.length
    bob.handleOverlayFrame('relay', oversizedFrame.slice().buffer)
    await wait(20)
    assert.equal(deliveredAtBob.length, deliveredBeforeOversized)

    // 4. Third-party prune ({t: 'prune', peerId: 'relay'} sent by 'mallory') is ignored
    const thirdPartyPrune = new Uint8Array([
      overlayFrameVersion,
      1,
      ...encodeBytes(JSON.stringify({t: 'prune', peerId: 'relay'}))
    ])
    bob.handleOverlayFrame('mallory', thirdPartyPrune.slice().buffer)
    await wait(20)

    // 5. Capture a valid broadcast and stale leave from Alice; after Alice leaves, replaying her broadcast must NOT resurrect her as a virtual peer
    const aliceId = await alice.getLocalCryptoIdentity()
    const staleLeaveSeq = 1
    const staleLeaveSig = Buffer.from(
      await ecdsaSign(
        aliceId.signPrivateKey,
        buildOverlaySignedBytes(
          canonicalLeaveHeader('alice', staleLeaveSeq, appId, roomId),
          new Uint8Array()
        ) as BufferSource
      )
    ).toString('base64')
    const staleLeaveFrame = new Uint8Array([
      overlayFrameVersion,
      1,
      ...encodeBytes(
        JSON.stringify({
          t: 'leave',
          peerId: 'alice',
          seq: staleLeaveSeq,
          sig: staleLeaveSig
        })
      )
    ])

    // Alice publishes a higher descriptor seq (seq = 100) so seq = 1 is stale
    const aliceNewDesc = {
      peerId: 'alice',
      seq: 100,
      neighbors: ['relay'],
      signPubKey: aliceId.signPubJwk,
      encPubKey: aliceId.encPubJwk,
      sig: ''
    }
    const aliceNewDescCanonical = encodeBytes(
      descriptorCanonicalPayload(aliceNewDesc, appId, roomId)
    )
    aliceNewDesc.sig = Buffer.from(
      await ecdsaSign(
        aliceId.signPrivateKey,
        aliceNewDescCanonical as BufferSource
      )
    ).toString('base64')
    bob.handleOverlayFrame(
      'relay',
      new Uint8Array([
        overlayFrameVersion,
        1,
        ...encodeBytes(
          JSON.stringify({t: 'gossip', descriptors: [aliceNewDesc]})
        )
      ]).slice().buffer
    )
    await wait(30)

    // Replaying stale leave (seq = 1 < currentDesc.seq = 100) must be ignored
    bob.handleOverlayFrame('mallory', staleLeaveFrame.slice().buffer)
    await wait(30)
    assert.ok(
      bob.getSnapshot().roomPeerIds.includes('alice'),
      'stale leave with seq < current descriptor seq must be ignored'
    )

    // Now Alice leaves with a fresh seq = 101; replaying a valid signed broadcast from Alice with an unseen msgId must NOT resurrect Alice
    const freshLeaveSig = Buffer.from(
      await ecdsaSign(
        aliceId.signPrivateKey,
        buildOverlaySignedBytes(
          canonicalLeaveHeader('alice', 101, appId, roomId),
          new Uint8Array()
        ) as BufferSource
      )
    ).toString('base64')
    bob.handleOverlayFrame(
      'relay',
      new Uint8Array([
        overlayFrameVersion,
        1,
        ...encodeBytes(
          JSON.stringify({
            t: 'leave',
            peerId: 'alice',
            seq: 101,
            sig: freshLeaveSig
          })
        )
      ]).slice().buffer
    )
    await wait(30)
    assert.ok(
      !bob.getSnapshot().roomPeerIds.includes('alice'),
      'Alice should be removed after valid fresh leave'
    )

    const ghostMsgId = 'alice:ghost-broadcast-after-leave'
    const ghostPayload = new Uint8Array([1, 2, 3, 4])
    const ghostSig = Buffer.from(
      await ecdsaSign(
        aliceId.signPrivateKey,
        buildOverlaySignedBytes(
          canonicalBroadcastHeader('alice', ghostMsgId, 1, appId, roomId),
          ghostPayload
        ) as BufferSource
      )
    ).toString('base64')
    const ghostHeaderBytes = encodeBytes(
      JSON.stringify({o: 'alice', q: 1, m: ghostMsgId, s: ghostSig})
    )
    const ghostBroadcastFrame = new Uint8Array(
      5 + ghostHeaderBytes.byteLength + ghostPayload.byteLength
    )
    ghostBroadcastFrame[0] = overlayFrameVersion
    ghostBroadcastFrame[1] = 2
    ghostBroadcastFrame[2] = 6
    ghostBroadcastFrame[3] = (ghostHeaderBytes.byteLength >>> 8) & 0xff
    ghostBroadcastFrame[4] = ghostHeaderBytes.byteLength & 0xff
    ghostBroadcastFrame.set(ghostHeaderBytes, 5)
    ghostBroadcastFrame.set(ghostPayload, 5 + ghostHeaderBytes.byteLength)

    const joinsBeforeGhost = virtualJoinsAtBob.length
    const deliveredBeforeGhost = deliveredAtBob.length
    bob.handleOverlayFrame('mallory', ghostBroadcastFrame.slice().buffer)
    await wait(30)
    assert.equal(
      virtualJoinsAtBob.length,
      joinsBeforeGhost,
      'replayed broadcast from a departed peer must not resurrect a virtual peer'
    )
    assert.equal(
      deliveredAtBob.length,
      deliveredBeforeGhost,
      'replayed broadcast from a departed peer must not deliver payload'
    )
  } finally {
    alice.destroy()
    relay.destroy()
    bob.destroy()
    mallory.destroy()
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
      selfId: 'bare-peer',
      appId: 'bare-app',
      roomId: 'bare-room'
    }
  )
  assert.equal((bareRoom as any).makeState, undefined)
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
        selfId: 'host-default-proofs',
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
      topology: {mode: 'gossip', maxConnections: 4},
      ...(descriptorTtlMs ? {descriptorTtlMs} : {}),
      onVirtualPeerJoin: () => {},
      onVirtualPeerLeave: () => {},
      onDeliverData: () => {}
    })

  const alice = makeOverlay('alice')
  const relay1 = makeOverlay('relay1')
  const relay2 = makeOverlay('relay2')
  const bob = makeOverlay('bob')
  const mallory = makeOverlay('mallory')

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
    wirePair('alice', alice, 'relay1', relay1)
    wirePair('alice', alice, 'relay2', relay2)
    wirePair('relay1', relay1, 'bob', bob)
    wirePair('relay2', relay2, 'bob', bob)
    wirePair('mallory', mallory, 'bob', bob)

    await waitFor(() => bob.getSnapshot().roomPeerIds.includes('alice'), 2_000)

    // 3a. Mallory unilaterally claims 'alice' as a direct neighbor in a signed descriptor (without Alice claiming Mallory).
    // Bob must NOT route to Alice via Mallory!
    const malloryId = await mallory.getLocalCryptoIdentity()
    const forgedMalloryDesc: any = {
      peerId: 'mallory',
      seq: 50,
      neighbors: ['alice', 'bob'],
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
      'mallory',
      new Uint8Array([
        overlayFrameVersion,
        1,
        ...encodeBytes(
          JSON.stringify({t: 'gossip', descriptors: [forgedMalloryDesc]})
        )
      ]).slice().buffer
    )
    await wait(30)

    const routeToAlice = bob.getRoute('alice')
    assert.ok(routeToAlice)
    assert.notEqual(
      routeToAlice.nextHop,
      'mallory',
      'unilateral neighbor claim by mallory must not attract routes to alice'
    )

    // 3b. Single neighbor (relay2) drops alice and publishes updated descriptor without alice.
    // Because alice still has a mutually confirmed path via relay1, bob must NOT evict alice!
    relay2.removeDirectPeer('alice')
    await wait(50)
    assert.equal(
      bob.getSnapshot().roomPeerIds.includes('alice'),
      true,
      'single neighbor dropping alice must not evict alice while relay1 still confirms her'
    )

    // 3c. Once relay1 ALSO drops alice, both of alice's known neighbors have confirmed she disconnected, so bob evicts alice.
    relay1.removeDirectPeer('alice')
    await waitFor(() => !bob.getSnapshot().roomPeerIds.includes('alice'), 2_000)
    assert.equal(
      bob.getSnapshot().roomPeerIds.includes('alice'),
      false,
      'alice must be evicted once all neighbors confirm she dropped'
    )

    // 4. Descriptor heartbeat TTL expiry evicts a silent multi-hop peer without down rumors
    const ttlEvicted: string[] = []
    const shortTtlObserver = createOverlayManager({
      selfId: 'ttl-observer',
      appId: 'mutual-app',
      roomId: 'mutual-room',
      topology: {mode: 'gossip', maxConnections: 4},
      descriptorTtlMs: 250,
      onVirtualPeerJoin: () => {},
      onVirtualPeerLeave: pid => ttlEvicted.push(pid),
      onDeliverData: () => {}
    })
    wirePair('relay1', relay1, 'ttl-observer', shortTtlObserver)
    const silentPeer = makeOverlay('silent-peer')
    const silentLink = wirePair('silent-peer', silentPeer, 'relay1', relay1)
    await waitFor(
      () => shortTtlObserver.getSnapshot().roomPeerIds.includes('silent-peer'),
      2_000
    )
    // Mute silent-peer without disconnecting relay1 so no descriptor update is sent, and let TTL expire
    silentLink.handleA.isDead = true
    silentLink.handleB.isDead = true
    await waitFor(
      () => !shortTtlObserver.getSnapshot().roomPeerIds.includes('silent-peer'),
      2_000
    )
    assert.ok(
      ttlEvicted.includes('silent-peer'),
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
      broadcastActions.set(
        id,
        room.makeAction<string>('bcast250', {
          onMessage: msg => {
            receivedBroadcastByPeer.get(id)!.push(msg)
          }
        })
      )
      dmActions.set(
        id,
        room.makeAction<string>('dm250', {
          onMessage: msg => {
            receivedDmByPeer.get(id)!.push(msg)
          }
        })
      )
    }

    const originId = 'peer-0000'
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

void test('Solution (b): per-origin monotonic sequence counter with non-flushable 256-bit sliding replay window and room-bound signed headers', async () => {
  const appId = 'bound-app-1'
  const roomId = 'bound-room-A'
  const bobDelivered: string[] = []
  const capturedFromAlice: Uint8Array[] = []
  const capturedFromCarol: Uint8Array[] = []

  const alice = createOverlayManager({
    selfId: 'alice',
    appId,
    roomId,
    topology: {mode: 'gossip', maxConnections: 4},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })
  const carol = createOverlayManager({
    selfId: 'carol',
    appId,
    roomId,
    topology: {mode: 'gossip', maxConnections: 4},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })
  const bob = createOverlayManager({
    selfId: 'bob',
    appId,
    roomId,
    topology: {mode: 'gossip', maxConnections: 4},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: (_from, data) =>
      bobDelivered.push(decodeBytes(new Uint8Array(data)))
  })

  const makePipe = (
    fromId: string,
    to: ReturnType<typeof createOverlayManager>,
    tap?: (b: Uint8Array) => void
  ) => ({
    isDead: false,
    connection: {} as any,
    channel: {readyState: 'open'} as any,
    getOffer: async () => undefined,
    signal: async () => undefined,
    sendData: (d: Uint8Array) => {
      tap?.(d.slice())
      to.handleOverlayFrame(fromId, d.slice().buffer)
    },
    destroy: () => {},
    setHandlers: () => {},
    addStream: () => {},
    removeStream: () => {},
    addTrack: () => ({}) as any,
    removeTrack: () => {},
    replaceTrack: async () => {}
  })

  try {
    alice.addDirectPeer(
      'bob',
      makePipe('alice', bob, b => capturedFromAlice.push(b))
    )
    bob.addDirectPeer('alice', makePipe('bob', alice))
    carol.addDirectPeer(
      'bob',
      makePipe('carol', bob, b => capturedFromCarol.push(b))
    )
    bob.addDirectPeer('carol', makePipe('bob', carol))

    await waitFor(
      () =>
        bob.getSnapshot().directPeerIds.includes('alice') &&
        bob.getSnapshot().directPeerIds.includes('carol'),
      2_000
    )
    await wait(30)

    // 1. Capture Alice's first broadcast (seq = 1)
    capturedFromAlice.length = 0
    await alice.broadcastInline(encodeBytes('alice-msg-seq-1'))
    await waitFor(() => bobDelivered.includes('alice-msg-seq-1'), 1_000)
    const aliceBroadcast1 = capturedFromAlice.find(
      f => unpackOverlayBinary(f)?.kind === overlayBroadcastKind
    )!
    assert.ok(aliceBroadcast1)
    assert.equal(unpackOverlayBinary(aliceBroadcast1)?.header['q'], 1)

    // 2. Flood > 4,500 valid signed broadcasts from Carol to completely flush Bob's 4,096-entry seenMsgIds cache!
    const carolId = await carol.getLocalCryptoIdentity()
    for (let seq = 1; seq <= 4_500; seq++) {
      const msgId = `carol:flush-${seq}`
      const payload = encodeBytes(`c-${seq}`)
      const canonical = canonicalBroadcastHeader(
        'carol',
        msgId,
        seq,
        appId,
        roomId
      )
      const sig = Buffer.from(
        await ecdsaSign(
          carolId.signPrivateKey,
          buildOverlaySignedBytes(canonical, payload) as BufferSource
        )
      ).toString('base64')
      const pkt = packOverlayBinary(
        overlayBroadcastKind,
        4,
        {o: 'carol', q: seq, m: msgId, s: sig},
        payload
      )
      bob.handleOverlayFrame('carol', pkt.slice().buffer)
    }
    await waitFor(() => bobDelivered.length >= 4_501, 5_000)

    // 3. Replay Alice's broadcast #1 (with the same msgId OR a mutated msgId):
    // Even though > 4,500 messages have rotated seenMsgIds, Bob's per-origin replay state for 'alice'
    // still remembers seq=1 and drops the replay!
    const deliveredBeforeReplay = bobDelivered.length
    const dupsBeforeReplay = bob.getSnapshot().stats.duplicatesDropped
    bob.handleOverlayFrame('alice', aliceBroadcast1.slice().buffer)
    await wait(30)
    assert.equal(
      bobDelivered.length,
      deliveredBeforeReplay,
      'per-origin replay window must block replay even after > 4,500 messages flush global seenMsgIds'
    )
    assert.equal(
      bob.getSnapshot().stats.duplicatesDropped,
      dupsBeforeReplay + 1
    )

    // 4. Out-of-order delivery within the 256-bit sliding window works once and rejects duplicate
    const aliceId = await alice.getLocalCryptoIdentity()
    const makeSignedAliceBroadcast = async (seq: number, text: string) => {
      const msgId = `alice:${seq}:ooo`
      const payload = encodeBytes(text)
      const canonical = canonicalBroadcastHeader(
        'alice',
        msgId,
        seq,
        appId,
        roomId
      )
      const sig = Buffer.from(
        await ecdsaSign(
          aliceId.signPrivateKey,
          buildOverlaySignedBytes(canonical, payload) as BufferSource
        )
      ).toString('base64')
      return packOverlayBinary(
        overlayBroadcastKind,
        4,
        {o: 'alice', q: seq, m: msgId, s: sig},
        payload
      )
    }

    const pktSeq10 = await makeSignedAliceBroadcast(10, 'alice-seq-10')
    const pktSeq7 = await makeSignedAliceBroadcast(7, 'alice-seq-7-ooo')
    bob.handleOverlayFrame('alice', pktSeq10.slice().buffer)
    await waitFor(() => bobDelivered.includes('alice-seq-10'), 1_000)
    // Arrive out-of-order (seq 7 < maxSeq 10, within 256-bit window)
    bob.handleOverlayFrame('alice', pktSeq7.slice().buffer)
    await waitFor(() => bobDelivered.includes('alice-seq-7-ooo'), 1_000)
    // Second replay of seq 7 must be dropped
    const dupsBeforeSeq7Replay = bob.getSnapshot().stats.duplicatesDropped
    bob.handleOverlayFrame('alice', pktSeq7.slice().buffer)
    await wait(30)
    assert.equal(
      bob.getSnapshot().stats.duplicatesDropped,
      dupsBeforeSeq7Replay + 1
    )

    // 5. Cross-room and cross-app replay rejection for descriptor, broadcast, unicast, and leave frames
    const otherRoomDelivered: string[] = []
    const otherRoomBob = createOverlayManager({
      selfId: 'bob',
      appId,
      roomId: 'bound-room-B', // Different roomId!
      topology: {mode: 'gossip', maxConnections: 4},
      onVirtualPeerJoin: () => {},
      onVirtualPeerLeave: () => {},
      onDeliverData: (_from, data) =>
        otherRoomDelivered.push(decodeBytes(new Uint8Array(data)))
    })
    otherRoomBob.setPeerSignPublicKey('alice', aliceId.signPubJwk)

    // 5a. Replay Alice's valid descriptor from room-A into room-B
    const aliceDescRoomA = {
      peerId: 'alice',
      seq: 20,
      neighbors: ['bob'],
      signPubKey: aliceId.signPubJwk,
      encPubKey: aliceId.encPubJwk,
      sig: ''
    }
    aliceDescRoomA.sig = Buffer.from(
      await ecdsaSign(
        aliceId.signPrivateKey,
        encodeBytes(
          descriptorCanonicalPayload(aliceDescRoomA, appId, roomId)
        ) as BufferSource
      )
    ).toString('base64')

    let failCount = otherRoomBob.getSnapshot().stats.signatureFailures
    otherRoomBob.handleOverlayFrame(
      'alice',
      packOverlayControl({t: 'gossip', descriptors: [aliceDescRoomA]}).slice()
        .buffer
    )
    await wait(30)
    assert.equal(
      otherRoomBob.getSnapshot().stats.signatureFailures,
      failCount + 1,
      'descriptor signed for room-A must be rejected in room-B'
    )

    // 5b. Replay Alice's valid broadcast from room-A into room-B
    failCount = otherRoomBob.getSnapshot().stats.signatureFailures
    otherRoomBob.handleOverlayFrame('alice', aliceBroadcast1.slice().buffer)
    await wait(30)
    assert.equal(
      otherRoomBob.getSnapshot().stats.signatureFailures,
      failCount + 1,
      'broadcast signed for room-A must be rejected in room-B'
    )
    assert.equal(otherRoomDelivered.length, 0)

    // 5c. Replay Alice's valid unicast from room-A into room-B
    capturedFromAlice.length = 0
    alice.sendUnicast('carol', encodeBytes('room-A-secret-unicast'))
    await waitFor(
      () =>
        capturedFromAlice.some(
          f => unpackOverlayBinary(f)?.kind === overlayUnicastKind
        ),
      1_000
    )
    const aliceUnicastRoomA = capturedFromAlice.find(
      f => unpackOverlayBinary(f)?.kind === overlayUnicastKind
    )!
    failCount = otherRoomBob.getSnapshot().stats.signatureFailures
    otherRoomBob.handleOverlayFrame('alice', aliceUnicastRoomA.slice().buffer)
    await wait(30)
    assert.equal(
      otherRoomBob.getSnapshot().stats.signatureFailures,
      failCount + 1,
      'unicast signed for room-A must be rejected in room-B'
    )

    // 5d. Replay Alice's valid leave from room-A into room-B
    const leaveSigRoomA = Buffer.from(
      await ecdsaSign(
        aliceId.signPrivateKey,
        buildOverlaySignedBytes(
          canonicalLeaveHeader('alice', 99, appId, roomId),
          new Uint8Array()
        ) as BufferSource
      )
    ).toString('base64')
    failCount = otherRoomBob.getSnapshot().stats.signatureFailures
    otherRoomBob.handleOverlayFrame(
      'alice',
      packOverlayControl({
        t: 'leave',
        peerId: 'alice',
        seq: 99,
        sig: leaveSigRoomA
      }).slice().buffer
    )
    await wait(30)
    assert.equal(
      otherRoomBob.getSnapshot().stats.signatureFailures,
      failCount + 1,
      'leave signed for room-A must be rejected in room-B'
    )

    otherRoomBob.destroy()
  } finally {
    alice.destroy()
    carol.destroy()
    bob.destroy()
  }
})

void test('Solution (c): signaling door input bounds, early candidate drop before decrypt, public-topic roster poisoning resistance, and room-salted ring placement', async () => {
  // 1. Signaling door validation & bounds in createSignalHandler
  let toPlainCalls = 0
  let discoveredCount = 0

  const relayHandler = createSignalHandler({
    appId: 'sig-app',
    roomId: 'sig-room',
    config: {appId: 'sig-app'},
    peerStates: {},
    rootTopicPlaintext: 'root-topic',
    rootTopicP: Promise.resolve('root-topic'),
    selfTopicP: Promise.resolve('self-topic'),
    selfId: 'honest-self',
    selfIdP: Promise.resolve('honest-self'),
    isLeaving: () => false,
    announceIntervals: [],
    announceIntervalMs: 1_000,
    toPlain: async s => {
      toPlainCalls++
      return s
    },
    toCipher: async s => s,
    offerManager: {take: () => ({}) as any} as any,
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
    onJoinError: undefined,
    onPeerDiscovered: () => {
      discoveredCount++
    }
  })(0)

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
      peerId: 'valid-peer-1',
      offerId: 'o'.repeat(80),
      offer: {type: 'offer', sdp: 'v=0'}
    })
  )
  // 1d. Oversized SDP (> 64 KiB) or oversized candidate (> 4 KiB) is dropped at ingress
  await handleSignal(
    JSON.stringify({
      peerId: 'valid-peer-2',
      offerId: 'offer-1',
      offer: {type: 'offer', sdp: 'v='.repeat(40_000)}
    })
  )
  await handleSignal(
    JSON.stringify({
      peerId: 'valid-peer-3',
      candidate: {candidate: 'c'.repeat(5_000)}
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
      peerId: 'unsolicited-cand-peer',
      candidate: {
        candidate: 'candidate:1 1 UDP 2122252543 192.0.2.1 5000 typ host'
      }
    }),
    'self-topic'
  )
  assert.equal(
    toPlainCalls,
    0,
    'unsolicited candidate for peer with no active handshake must be dropped before toPlain decryption'
  )

  // 2. Public-topic roster poisoning resistance:
  // An active 4-peer room in 'auto' mode (below autoThreshold=12, so activeMode === 'mesh')
  // receives 200 fake peer announcements via notePeerDiscovered on the public signaling topic.
  const cluster = await createOverlayCluster({
    peerCount: 4,
    topology: {mode: 'auto', autoThreshold: 12, maxConnections: 6}
  })
  try {
    const victimRoom = cluster.rooms.get('peer-0000')!
    const victimBridge = getRoomSignalingBridge(victimRoom)!
    assert.equal(victimRoom.getTopology().activeMode, 'mesh')
    assert.equal(victimRoom.getTopology().roomPeerIds.length, 3)

    for (let i = 0; i < 200; i++) {
      victimBridge
        .getScaleProvider()
        ?.notePeerDiscovered(`fake-topic-sybil-${i}`)
    }
    await wait(30)

    const snapAfterSpam = victimRoom.getTopology()
    assert.equal(
      snapAfterSpam.activeMode,
      'mesh',
      'public-topic notePeerDiscovered spam must NOT flip an established mesh room into gossip mode'
    )
    assert.deepEqual(
      snapAfterSpam.roomPeerIds,
      ['peer-0001', 'peer-0002', 'peer-0003'],
      'unverified public-topic announcements must never enter roomPeerIds'
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
    ...computeTargetNeighbors(
      'peer-00',
      samplePeers,
      'gossip',
      4,
      'app-1\0room-alpha'
    )
  ]
  const targetsRoom2 = [
    ...computeTargetNeighbors(
      'peer-00',
      samplePeers,
      'gossip',
      4,
      'app-1\0room-beta'
    )
  ]
  assert.notDeepEqual(
    targetsRoom1,
    targetsRoom2,
    'room-salted ring placement must produce different neighbor sets across different rooms'
  )
})

void test('Bug A regression: virtual peer survives a failed direct dial or handshake without dropping from getPeers()', async () => {
  const peerIds = ['alice', 'relay', 'bob']
  const registerCallbacks = new Map<string, (peer: any, id: string) => void>()
  const rooms = new Map<string, Room & ScalePluginApi>()

  for (const id of peerIds) {
    const r = createRoom(
      peerRegister => {
        registerCallbacks.set(id, peerRegister)
      },
      () => {},
      () => {},
      {
        selfId: id,
        appId: 'bug-a-app',
        roomId: 'bug-a-room',
        use: [scale({mode: 'gossip', maxConnections: 4})]
      }
    )
    rooms.set(id, r as Room & ScalePluginApi)
  }

  const connectDirect = (idA: string, idB: string) => {
    const {peerA, peerB} = linkPeers(new LinkedPeer(), new LinkedPeer())
    registerCallbacks.get(idA)!(peerA, idB)
    registerCallbacks.get(idB)!(peerB, idA)
  }

  try {
    // Connect alice <-> relay <-> bob (alice and bob are 2-hop virtual peers)
    connectDirect('alice', 'relay')
    connectDirect('relay', 'bob')

    const aliceRoom = rooms.get('alice')!
    const bobRoom = rooms.get('bob')!

    await waitFor(
      () =>
        Boolean(aliceRoom.getPeers()['bob']) &&
        aliceRoom.getPeers()['bob']?.direct === false &&
        Boolean(bobRoom.getPeers()['alice']),
      3_000
    )

    const aliceLeftPeers: string[] = []
    aliceRoom.onPeerLeave = ({peerId}) => {
      aliceLeftPeers.push(peerId)
    }

    const aliceReceived: string[] = []
    for (const id of peerIds) {
      rooms.get(id)!.makeAction<string>('chat', {
        onMessage: msg => {
          if (id === 'alice') {
            aliceReceived.push(msg)
          }
        }
      })
    }
    const bobChat = bobRoom.makeAction<string>('chat')

    // Inject a direct WebRTC handle for 'bob' at 'alice' whose handshake/ICE fails and closes before activating
    let closeDirectAttempt: (() => void) | undefined
    let dead = false
    const failingDirectHandle: PeerHandle = {
      get isDead() {
        return dead
      },
      connection: {
        connectionState: 'connecting',
        iceConnectionState: 'checking',
        signalingState: 'stable',
        getSenders: () => []
      } as unknown as RTCPeerConnection,
      channel: null,
      getOffer: async () => undefined,
      signal: async () => undefined,
      sendData: () => {},
      destroy: () => {
        dead = true
      },
      setHandlers: h => {
        if (h.close) {
          closeDirectAttempt = h.close
        }
      },
      addStream: () => {},
      removeStream: () => {},
      addTrack: () => ({}) as never,
      removeTrack: () => {},
      replaceTrack: async () => {}
    }

    registerCallbacks.get('alice')!(failingDirectHandle, 'bob')
    assert.ok(closeDirectAttempt, 'direct handle close handler must be set')

    // Simulate ICE / handshake failure on the direct dial attempt
    closeDirectAttempt()
    await wait(30)

    assert.deepEqual(
      aliceLeftPeers,
      [],
      'failed direct dial must not emit onPeerLeave for an active virtual peer'
    )
    assert.ok(
      aliceRoom.getPeers()['bob'],
      'bob must remain in aliceRoom.getPeers() as a virtual peer after failed direct dial'
    )
    assert.equal(aliceRoom.getPeers()['bob']?.direct, false)

    // Verify bob's multi-hop broadcasts and unicasts still deliver to alice
    await bobChat.send('broadcast-after-failed-dial')
    await waitFor(
      () => aliceReceived.includes('broadcast-after-failed-dial'),
      2_000
    )

    await bobChat.send('unicast-after-failed-dial', {target: 'alice'})
    await waitFor(
      () => aliceReceived.includes('unicast-after-failed-dial'),
      2_000
    )

    // Verify virtual-peer departure ordering: when data-plane leave arrives before control leave,
    // alice must fire onPeerLeave exactly once and 0 spurious onPeerJoin events
    const aliceJoinedAfterLeave: string[] = []
    aliceRoom.onPeerJoin = ({peerId}) => {
      if (aliceLeftPeers.length > 0) {
        aliceJoinedAfterLeave.push(peerId)
      }
    }
    await getRoomSignalingBridge(bobRoom)
      ?.getScaleProvider()
      ?.broadcastInline(new Uint8Array(encodeInternalAction('leave')))
    await waitFor(() => aliceLeftPeers.includes('bob'), 2_000)
    await bobRoom.leave()
    await wait(60)
    assert.deepEqual(
      aliceLeftPeers,
      ['bob'],
      'virtual peer departure must emit onPeerLeave exactly once'
    )
    assert.deepEqual(
      aliceJoinedAfterLeave,
      [],
      'virtual peer departure must not emit a spurious onPeerJoin when data-plane leave arrives before control leave'
    )
  } finally {
    await Promise.all(
      [...rooms.values()].map(r => r.leave().catch(() => undefined))
    )
  }
})

void test('Bug B regression: leave() + rejoin with same peerId delivers broadcasts and re-learns descriptors across non-neighbors', async () => {
  const appId = 'rejoin-test-app'
  const roomId = 'rejoin-test-room'
  const bobGot: string[] = []
  const carolVirtualJoins: string[] = []
  const carolLeaves: string[] = []

  const makeManager = (
    selfId: string,
    onDeliver: (from: string, s: string) => void = () => {},
    onJoin: (id: string) => void = () => {},
    onLeave: (id: string) => void = () => {}
  ) =>
    createOverlayManager({
      selfId,
      appId,
      roomId,
      topology: {mode: 'gossip', maxConnections: 4},
      onVirtualPeerJoin: id => onJoin(id),
      onVirtualPeerLeave: id => onLeave(id),
      onDeliverData: (from, data) =>
        onDeliver(from, decodeBytes(new Uint8Array(data)))
    })

  const makePipe = (
    fromId: string,
    to: ReturnType<typeof createOverlayManager>,
    alive = {ok: true}
  ): PeerHandle => ({
    get isDead() {
      return !alive.ok
    },
    connection: {} as unknown as RTCPeerConnection,
    channel: {readyState: 'open'} as unknown as RTCDataChannel,
    getOffer: async () => undefined,
    signal: async () => undefined,
    sendData: (d: Uint8Array) => {
      if (alive.ok) {
        to.handleOverlayFrame(fromId, d.slice().buffer)
      }
    },
    destroy: () => {
      alive.ok = false
    },
    setHandlers: () => {},
    addStream: () => {},
    removeStream: () => {},
    addTrack: () => ({}) as never,
    removeTrack: () => {},
    replaceTrack: async () => {}
  })

  const bob = makeManager('bob', (_from, s) => bobGot.push(s))
  const carol = makeManager(
    'carol',
    () => {},
    id => carolVirtualJoins.push(id),
    id => carolLeaves.push(id)
  )
  let alice = makeManager('alice')

  try {
    const bc = {ok: true}
    bob.addDirectPeer('carol', makePipe('bob', carol, bc))
    carol.addDirectPeer('bob', makePipe('carol', bob, bc))

    // Session 1: alice <-> bob <-> carol; alice sends 300 broadcasts and bumps descriptor seq
    const a1 = {ok: true}
    alice.addDirectPeer('bob', makePipe('alice', bob, a1))
    bob.addDirectPeer('alice', makePipe('bob', alice, a1))

    await waitFor(() => carolVirtualJoins.includes('alice'), 3_000)
    for (let i = 1; i <= 300; i++) {
      await alice.broadcastInline(encodeBytes(`s1-${i}`))
    }
    await waitFor(() => bobGot.length === 300, 3_000)

    // Alice leaves cleanly with signed leave
    alice.announceLeave()
    await wait(60)
    alice.destroy()
    a1.ok = false
    bob.removeDirectPeer('alice')
    await waitFor(() => carolLeaves.includes('alice'), 3_000)

    // Session 2: new manager with the SAME selfId ('alice') rejoins
    carolVirtualJoins.length = 0
    bobGot.length = 0
    alice = makeManager('alice')
    const a2 = {ok: true}
    alice.addDirectPeer('bob', makePipe('alice', bob, a2))
    bob.addDirectPeer('alice', makePipe('bob', alice, a2))

    await waitFor(() => carolVirtualJoins.includes('alice'), 3_000)
    for (let i = 1; i <= 10; i++) {
      await alice.broadcastInline(encodeBytes(`s2-${i}`))
    }
    await waitFor(() => bobGot.length === 10, 3_000)
    assert.equal(bobGot.length, 10)
  } finally {
    alice.destroy()
    bob.destroy()
    carol.destroy()
  }
})

void test('Liveness refresh on verified packets and descriptor seq-bump flood throttling', async () => {
  const appId = 'liveness-throttle-app'
  const roomId = 'liveness-throttle-room'
  const bobLeaves: string[] = []
  const bobDelivered: string[] = []

  const alice = createOverlayManager({
    selfId: 'alice',
    appId,
    roomId,
    topology: {mode: 'gossip', maxConnections: 4},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })
  const relay = createOverlayManager({
    selfId: 'relay',
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
    selfId: 'bob',
    appId,
    roomId,
    descriptorTtlMs: 350,
    topology: {mode: 'gossip', maxConnections: 4},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: id => bobLeaves.push(id),
    onDeliverData: (_from, data) =>
      bobDelivered.push(decodeBytes(new Uint8Array(data))),
    onPeerDescriptorCert: pid => {
      if (pid === 'alice') {
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
    alice.addDirectPeer('relay', makePipe('alice', relay))
    relay.addDirectPeer('alice', makePipe('relay', alice))
    relay.addDirectPeer(
      'bob',
      makePipe('relay', bob, d => {
        if (blockAliceDescriptorsToBob && d[1] === 1) {
          try {
            const msg = JSON.parse(decodeBytes(d.subarray(2)))
            if (
              msg.t === 'gossip' &&
              Array.isArray(msg.descriptors) &&
              msg.descriptors.some((desc: any) => desc.peerId === 'alice')
            ) {
              return false
            }
          } catch {}
        }
        return true
      })
    )
    bob.addDirectPeer('relay', makePipe('bob', relay))

    await waitFor(() => bob.getSnapshot().roomPeerIds.includes('alice'), 2_000)

    // Block further descriptor heartbeats from Alice to Bob, but keep sending verified broadcasts from Alice every 100ms for 600ms (> 350ms TTL)
    blockAliceDescriptorsToBob = true
    for (let i = 1; i <= 5; i++) {
      await wait(110)
      await alice.broadcastInline(encodeBytes(`keepalive-${i}`))
    }
    await waitFor(() => bobDelivered.includes('keepalive-5'), 1_000)
    assert.ok(
      bob.getSnapshot().roomPeerIds.includes('alice') &&
        !bobLeaves.includes('alice'),
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
        peerId: 'alice',
        seq: s,
        neighbors: s % 2 === 0 ? ['relay'] : ['relay', 'alt-neighbor'],
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
        'relay',
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
