import assert from 'node:assert/strict'
import test from './test.ts'
import type {
  RolesPluginApi,
  Room,
  ScalePluginApi
} from '../../packages/core/src/index.ts'
import type {PeerHandle} from '../../packages/core/src/types.ts'
import {
  createOverlayManager,
  overlayBroadcastKind,
  overlayUnicastKind,
  packOverlayBinary,
  scale,
  unpackOverlayBinary
} from '../../packages/core/src/scale/index.ts'
import createRoom from '../../packages/core/src/room.ts'
import {decodeBytes, encodeBytes} from '../../packages/core/src/utils.ts'
import {createOverlayCluster} from './overlay-harness.ts'
import {
  allocTestPeerIds,
  LinkedPeer,
  linkPeers,
  testPeerId,
  wait,
  waitFor
} from './peer-harness.ts'

void test('Data-only scale: 150-peer text chat broadcast & high-frequency cursor updates over gossip overlay', async () => {
  const peerCount = 150
  const maxConnections = 8
  const cluster = await createOverlayCluster({
    peerCount,
    topology: {mode: 'gossip', maxConnections}
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

      const chat = room.makeAction<{text: string}>('chat')
      chat.onMessage((payload, {peerId, metadata}) => {
        receivedChat.get(id)!.push({
          text: payload.text,
          from: peerId,
          meta: metadata
        })
      })
      chatSenders.set(id, chat)

      const cursor = room.makeAction<{x: number; y: number; seq: number}>(
        'cursor'
      )
      cursor.onMessage((payload, {peerId}) => {
        receivedCursors.get(id)!.set(peerId, payload)
      })
      cursorSenders.set(id, cursor)
    }

    // 3. Test room-wide chat broadcast from 5 spread-out speakers
    cluster.resetStats()
    const speakers = [0, 37, 75, 112, 149].map(i => cluster.peerIds[i]!)
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

void test('Byzantine fault tolerance: Blackhole relay dropping 100% of data packets mitigated by multi-path redundancy', async () => {
  const bobDelivered: Array<{from: string; text: string}> = []
  let blackholeDroppedCount = 0
  const [blackholeId, honestId, aliceId, bobId] = allocTestPeerIds(4)

  const alice = createOverlayManager({
    selfId: aliceId!,
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
    selfId: honestId!,
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
    selfId: blackholeId!,
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
    selfId: bobId!,
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
  alice.addDirectPeer(blackholeId!, makePipe(aliceId!, blackholeRelay))
  blackholeRelay.addDirectPeer(aliceId!, makePipe(blackholeId!, alice))
  blackholeRelay.addDirectPeer(
    bobId!,
    makePipe(blackholeId!, bob, true /* drop 100% of data frames! */)
  )
  bob.addDirectPeer(blackholeId!, makePipe(bobId!, blackholeRelay))

  alice.addDirectPeer(honestId!, makePipe(aliceId!, honestRelay))
  honestRelay.addDirectPeer(aliceId!, makePipe(honestId!, alice))
  honestRelay.addDirectPeer(bobId!, makePipe(honestId!, bob))
  bob.addDirectPeer(honestId!, makePipe(bobId!, honestRelay))

  await waitFor(
    () =>
      alice.getSnapshot().roomPeerIds.includes(bobId!) &&
      bob.getSnapshot().roomPeerIds.includes(aliceId!) &&
      Boolean(alice.getSnapshot().routes[bobId!]?.backupNextHop),
    2_000
  )
  await wait(60)

  // Verify Alice's route to Bob has both primary nextHop and a disjoint backupNextHop
  const bobRoute = alice.getSnapshot().routes[bobId!]!
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
  alice.removeDirectPeer(blackholeId!)
  for (let i = 0; i < 5; i++) {
    alice.sendUnicast(bobId!, encodeBytes(`byz-unicast-${i}`))
  }

  await waitFor(() => bobDelivered.length === 10, 2_000)

  for (let i = 0; i < 5; i++) {
    assert.ok(
      bobDelivered.some(
        m => m.from === aliceId! && m.text === `byz-broadcast-${i}`
      ),
      `expected broadcast ${i} to survive Byzantine blackhole relay`
    )
    assert.ok(
      bobDelivered.some(
        m => m.from === aliceId! && m.text === `byz-unicast-${i}`
      ),
      `expected E2EE unicast ${i} to survive Byzantine blackhole relay`
    )
  }

  alice.destroy()
  honestRelay.destroy()
  blackholeRelay.destroy()
  bob.destroy()
})

void test('C2 regression: relay boundary-shifting bytes between msgId and payload fails signature verification and never evicts origin', async () => {
  // Set up a line topology: alice <-> relay <-> bob <-> carol
  const aliceId = testPeerId('c2-alice')
  const relayId = testPeerId('c2-relay')
  const bobId = testPeerId('c2-bob')
  const carolId = testPeerId('c2-carol')
  const peerIds = [aliceId, relayId, bobId, carolId]
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
    const chatAction = room.makeAction<string>('chat')
    chatAction.onMessage((data, {peerId}) => {
      if (id === bobId) {
        receivedByBob.push({data, peerId})
      }
      if (id === carolId) {
        receivedByCarol.push({data, peerId})
      }
    })
    senders.set(id, chatAction.send)
    rooms.set(id, room as any)
  }

  try {
    // Link alice <-> relay
    const linkAR = linkPeers(new LinkedPeer(), new LinkedPeer())
    registerCallbacks.get(aliceId)!(linkAR.peerA, relayId)
    registerCallbacks.get(relayId)!(linkAR.peerB, aliceId)

    // Link relay <-> bob, intercepting frames from relay to bob
    const linkRB = linkPeers(new LinkedPeer(), new LinkedPeer())
    const origRelayToBobSend = linkRB.peerA.sendData.bind(linkRB.peerA)
    linkRB.peerA.sendData = (data: Uint8Array) => {
      const parsed = unpackOverlayBinary(data)
      if (
        parsed?.kind === overlayBroadcastKind &&
        parsed.header['o'] === aliceId
      ) {
        capturedBroadcastsAtRelay.push(data.slice())
      }
      origRelayToBobSend(data)
    }
    registerCallbacks.get(relayId)!(linkRB.peerA, bobId)
    registerCallbacks.get(bobId)!(linkRB.peerB, relayId)

    // Link bob <-> carol
    const linkBC = linkPeers(new LinkedPeer(), new LinkedPeer())
    registerCallbacks.get(bobId)!(linkBC.peerA, carolId)
    registerCallbacks.get(carolId)!(linkBC.peerB, bobId)

    await waitFor(
      () =>
        rooms.get(bobId)!.getTopology().roomPeerIds.includes(aliceId) &&
        rooms.get(carolId)!.getTopology().roomPeerIds.includes(aliceId),
      3_000
    )

    // Alice broadcasts a normal message
    await senders.get(aliceId)!('legitimate-first-message')
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
      {o: aliceId, q: 50, m: shiftedMsgId1, s: origSig},
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
      {o: aliceId, q: 51, m: shiftedMsgId2, s: origSig},
      shiftedPayload2
    )

    const bobStatsBefore = rooms.get(bobId)!.getTopology()
      .stats.signatureFailures
    const bobForwardedBefore = rooms.get(bobId)!.getTopology()
      .stats.messagesForwarded

    origRelayToBobSend(exploitPacket1)
    origRelayToBobSend(exploitPacket2)
    await wait(80)

    const bobStatsAfter = rooms.get(bobId)!.getTopology()
      .stats.signatureFailures
    const bobForwardedAfter = rooms.get(bobId)!.getTopology()
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
      rooms.get(bobId)!.getTopology().roomPeerIds.includes(aliceId),
      'victim origin (alice) must NOT be evicted/kicked from bob'
    )
    assert.ok(
      rooms.get(carolId)!.getTopology().roomPeerIds.includes(aliceId),
      'victim origin (alice) must NOT be evicted/kicked from carol'
    )
    assert.ok(
      rooms.get(aliceId)!.getTopology().roomPeerIds.includes(bobId),
      'alice must remain connected to bob (no forged leave triggered)'
    )

    // Verify Alice can still broadcast normally to Bob and Carol afterwards
    await senders.get(aliceId)!('legitimate-second-message')
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

  const aliceId = testPeerId('bugb-alice')
  const bobId = testPeerId('bugb-bob')
  const carolId = testPeerId('bugb-carol')
  const bob = makeManager(bobId, (_from, s) => bobGot.push(s))
  const carol = makeManager(
    carolId,
    () => {},
    id => carolVirtualJoins.push(id),
    id => carolLeaves.push(id)
  )
  let alice = makeManager(aliceId)

  try {
    const bc = {ok: true}
    bob.addDirectPeer(carolId, makePipe(bobId, carol, bc))
    carol.addDirectPeer(bobId, makePipe(carolId, bob, bc))

    // Session 1: alice <-> bob <-> carol; alice sends 300 broadcasts and bumps descriptor seq
    const a1 = {ok: true}
    alice.addDirectPeer(bobId, makePipe(aliceId, bob, a1))
    bob.addDirectPeer(aliceId, makePipe(bobId, alice, a1))

    await waitFor(() => carolVirtualJoins.includes(aliceId), 3_000)
    for (let i = 1; i <= 300; i++) {
      await alice.broadcastInline(encodeBytes(`s1-${i}`))
    }
    await waitFor(() => bobGot.length === 300, 3_000)

    // Alice leaves cleanly with signed leave
    alice.announceLeave()
    await wait(60)
    alice.destroy()
    a1.ok = false
    bob.removeDirectPeer(aliceId)
    await waitFor(() => carolLeaves.includes(aliceId), 3_000)

    // Session 2: new manager with the SAME selfId rejoins
    carolVirtualJoins.length = 0
    bobGot.length = 0
    alice = makeManager(aliceId)
    const a2 = {ok: true}
    alice.addDirectPeer(bobId, makePipe(aliceId, bob, a2))
    bob.addDirectPeer(aliceId, makePipe(bobId, alice, a2))

    await waitFor(() => carolVirtualJoins.includes(aliceId), 3_000)
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
