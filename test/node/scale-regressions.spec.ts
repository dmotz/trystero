import assert from 'node:assert/strict'
import test from './test.ts'
import {
  createTopicStrategy,
  createUserIdentity,
  roles,
  type PeerHandle,
  type RolesPluginApi,
  type Room,
  type ScalePluginApi,
  type StrategyMessage,
  type UserIdentity
} from '../../packages/core/src/index.ts'
import {actionWireVersion} from '../../packages/core/src/action-wire.ts'
import {jwkToCompactPub} from '../../packages/core/src/identity.ts'
import {
  canonicalBroadcastHeader,
  createOverlayManager,
  overlayBroadcastKind,
  overlayFrameVersion,
  overlayUnicastKind,
  packGossipControlFrames,
  packOverlayBinary,
  scale,
  signOverlayPayload,
  signPeerDescriptor
} from '../../packages/core/src/scale/index.ts'
import {
  encodeBytes,
  formatSelfCertifyingRoomId
} from '../../packages/core/src/utils.ts'
import {
  createTestScaleCluster,
  createTrackedRoom as createRoom,
  getRoomSignalingBridge,
  makeOverlayPipe
} from './overlay-harness.ts'
import {
  allocTestPeerIds,
  createSortedJoinRooms,
  getTestEndpointByPeerId,
  LinkedPeer,
  linkPeers,
  testEndpoint,
  wait,
  waitFor
} from './peer-harness.ts'
import {createMemoryRtcRealm, createMemorySignalBus} from './memory-rtc.ts'

let nextRegClusterSeq = 0

void test('Bug 1.1: broadcast addStream in 15-peer gossip room promotes all virtual peers and bounds remote connect spam', async () => {
  const cluster = await createTestScaleCluster({
    peerCount: 15,
    maxDirectPeers: 4,
    media: true
  })

  try {
    const broadcasterId = cluster.peerIds[0]!
    const broadcaster = cluster.rooms.get(broadcasterId)!
    assert.ok(
      broadcaster.getTopology().directPeerIds.length < 14,
      'broadcaster starts with sparse gossip neighbors'
    )

    const receivedStreams = new Map<string, string[]>()
    for (const id of cluster.peerIds) {
      if (id === broadcasterId) {
        continue
      }
      cluster.rooms.get(id)!.onPeerStream((stream, {peerId}) => {
        if (peerId === broadcasterId) {
          const list = receivedStreams.get(id) ?? []
          list.push(stream.id)
          receivedStreams.set(id, list)
        }
      })
    }

    const mockStream = {
      id: 'broadcast-cam-1',
      getTracks: () => [{id: 'video-track-1'}]
    }
    await broadcaster.addStream(mockStream as unknown as MediaStream)

    await waitFor(() => receivedStreams.size === 14, 5_000)
    assert.equal(broadcaster.getTopology().directPeerIds.length, 14)

    // Verify remote connect spam is bounded/rate-limited (burst=2) and never evicts localRequiredPeers
    const [selfId, relayId, localPinnedId, remoteSpammerId] =
      allocTestPeerIds(4)
    const mgr = createOverlayManager({
      selfId: selfId!,
      appId: 'spam-test',
      roomId: 'spam-room',
      config: {maxDirectPeers: 4},
      getLocalEndpointIdentity: () => getTestEndpointByPeerId(selfId!),
      onVirtualPeerJoin: () => true,
      onVirtualPeerLeave: () => {},
      onDeliverData: () => {}
    })
    const spammerMgr = createOverlayManager({
      selfId: remoteSpammerId!,
      appId: 'spam-test',
      roomId: 'spam-room',
      config: {maxDirectPeers: 4},
      getLocalEndpointIdentity: () => getTestEndpointByPeerId(remoteSpammerId!),
      onVirtualPeerJoin: () => true,
      onVirtualPeerLeave: () => {},
      onDeliverData: () => {}
    })
    try {
      mgr.requireDirectPeer(localPinnedId!, {dial: false})
      assert.equal(mgr.shouldConnectPeer(localPinnedId!, 'outbound'), true)

      const relayPeer = new LinkedPeer() as unknown as PeerHandle
      mgr.addDirectPeer(relayId!, relayPeer)

      // Deliver a valid signed PeerDescriptor for remoteSpammerId so it is in knownRoster
      const spammerIdObj = await spammerMgr.getLocalCryptoIdentity()
      const spammerDesc = await signPeerDescriptor(
        {
          peerId: remoteSpammerId!,
          seq: 1,
          neighbors: [relayId!],
          signPubKey: spammerIdObj.signPubKey,
          encPubKey: spammerIdObj.encPubKey
        },
        spammerIdObj,
        'spam-test',
        'spam-room',
        '',
        null
      )
      mgr.handleOverlayFrame(
        relayId!,
        packGossipControlFrames([spammerDesc])[0]!.slice().buffer
      )
      await waitFor(
        () => Boolean(mgr.getPeerSignPublicKey(remoteSpammerId!)),
        1_000
      )

      // Burst of 10 connect requests from the same remote peer: first 2 succeed, rest rate-limited
      let accepted = 0
      for (let i = 0; i < 10; i++) {
        if (mgr.acceptMediaConnectRequest(remoteSpammerId!)) {
          accepted++
        }
      }
      assert.equal(accepted, 2)
      // Local pinned peer remains unconditionally required regardless of remote requests
      assert.equal(mgr.shouldConnectPeer(localPinnedId!, 'outbound'), true)
    } finally {
      mgr.destroy()
      spammerMgr.destroy()
    }

    const victimBridge = getRoomSignalingBridge(
      cluster.rooms.get(cluster.peerIds[1]!)!
    )!
    const victimScale = victimBridge.getScaleProvider()!
    const pinnedPeer = cluster.peerIds[14]!
    victimScale.requireDirectPeer(pinnedPeer)
    assert.equal(victimScale.shouldConnectPeer(pinnedPeer, 'outbound'), true)
  } finally {
    await cluster.cleanup()
  }
})

void test('Bug 1.2: room.ban and direct handshake ban rejection immediately purge active virtual overlay peers', async () => {
  const peerCount = 10
  const identities = new Map<string, UserIdentity>()
  const createdIdentities = await Promise.all(
    Array.from({length: peerCount}, () => createUserIdentity())
  )
  const clusterIdsPreview = await createUserIdentity()

  const cluster = await createTestScaleCluster({
    peerCount,
    maxDirectPeers: 4,
    adminIdentity: createdIdentities[0]!
  })

  try {
    // Part A: direct handshake rejecting a banned user claiming an active virtual peerId purges that virtual peer
    const observerId = cluster.peerIds[0]!
    const observerRoom = cluster.rooms.get(observerId)! as Room &
      RolesPluginApi &
      ScalePluginApi
    await observerRoom.ban(clusterIdsPreview.userId)

    const virtualTargetId = cluster.peerIds.find(
      id =>
        id !== observerId &&
        !observerRoom.getTopology().directPeerIds.includes(id)
    )!
    assert.ok(
      observerRoom.getPeers()[virtualTargetId],
      'target starts as active virtual peer'
    )

    let regBanned!: (peer: PeerHandle, id: string) => void
    const bannedRoom = createRoom(
      f => {
        regBanned = f
      },
      () => {},
      () => {},
      {
        endpointIdentity: getTestEndpointByPeerId(virtualTargetId),
        appId: 'scale-reg-app',
        roomId: cluster.roomId,
        identity: clusterIdsPreview,
        use: [roles(), scale({maxDirectPeers: 4})]
      }
    )
    const {peerA, peerB} = linkPeers(new LinkedPeer(), new LinkedPeer())

    try {
      cluster.leftByPeer.get(observerId)!.clear()
      cluster.registerCallbacks.get(observerId)!(
        peerA as unknown as PeerHandle,
        virtualTargetId
      )
      regBanned(peerB as unknown as PeerHandle, observerId)

      await waitFor(
        () =>
          !observerRoom.getPeers()[virtualTargetId] &&
          cluster.leftByPeer.get(observerId)!.has(virtualTargetId),
        2_000
      )
      assert.equal(observerRoom.getPeers()[virtualTargetId], undefined)
      assert.ok(
        !observerRoom.getTopology().roomPeerIds.includes(virtualTargetId)
      )
    } finally {
      await bannedRoom.leave()
      peerA.destroy()
      peerB.destroy()
    }
  } finally {
    await cluster.cleanup()
  }

  // Part B: room.ban(virtualTarget) in a roles-enabled gossip cluster
  const adminClusterIds = allocTestPeerIds(10)
  for (let i = 0; i < adminClusterIds.length; i++) {
    identities.set(adminClusterIds[i]!, createdIdentities[i]!)
  }
  const adminRoleCluster = await (async () => {
    const adminId = adminClusterIds[0]!
    const adminUser = createdIdentities[0]!
    const roomId = formatSelfCertifyingRoomId(
      `ban-scale-${++nextRegClusterSeq}`,
      adminUser.userId
    )
    const regs = new Map<string, (peer: PeerHandle, id: string) => void>()
    const rooms = new Map<string, Room & RolesPluginApi & ScalePluginApi>()
    const links = new Map<string, {peerA: LinkedPeer; peerB: LinkedPeer}>()
    const leftMap = new Map<string, Set<string>>()
    const linkKey = (a: string, b: string) =>
      a < b ? `${a}:${b}` : `${b}:${a}`

    const connectPair = (idA: string, idB: string) => {
      const k = linkKey(idA, idB)
      if (idA === idB || links.has(k)) {
        return
      }
      const {peerA, peerB} = linkPeers(new LinkedPeer(), new LinkedPeer())
      links.set(k, {peerA, peerB})
      if (idA < idB) {
        regs.get(idA)!(peerA as unknown as PeerHandle, idB)
        regs.get(idB)!(peerB as unknown as PeerHandle, idA)
      } else {
        regs.get(idB)!(peerA as unknown as PeerHandle, idA)
        regs.get(idA)!(peerB as unknown as PeerHandle, idB)
      }
    }

    for (let i = 0; i < adminClusterIds.length; i++) {
      const id = adminClusterIds[i]!
      const uid = createdIdentities[i]!
      const left = new Set<string>()
      leftMap.set(id, left)
      const r = createRoom(
        f => regs.set(id, f),
        pid => {
          const p = links.get(linkKey(id, pid))
          if (p) {
            links.delete(linkKey(id, pid))
            p.peerA.destroy()
            p.peerB.destroy()
          }
        },
        () => {},
        {
          endpointIdentity: getTestEndpointByPeerId(id),
          appId: 'ban-scale-app',
          roomId,
          identity: uid,
          use: [roles(), scale({maxDirectPeers: 4})]
        }
      )
      r.onPeerLeave(({peerId}) => left.add(peerId))
      rooms.set(id, r as unknown as Room & RolesPluginApi & ScalePluginApi)
    }

    // Ring + chord topology so non-adjacent peers are virtual
    for (let i = 0; i < adminClusterIds.length; i++) {
      connectPair(
        adminClusterIds[i]!,
        adminClusterIds[(i + 1) % adminClusterIds.length]!
      )
      connectPair(
        adminClusterIds[i]!,
        adminClusterIds[(i + 2) % adminClusterIds.length]!
      )
    }

    await waitFor(
      () => rooms.get(adminId)!.getTopology().roomPeerIds.length === 9,
      4_000
    )
    return {adminId, rooms, links, leftMap}
  })()

  try {
    const adminRoom = adminRoleCluster.rooms.get(adminRoleCluster.adminId)!
    const virtualBanId = adminClusterIds[5]!
    assert.ok(
      !adminRoom.getTopology().directPeerIds.includes(virtualBanId),
      'target is purely virtual relative to admin'
    )
    assert.ok(adminRoom.getPeers()[virtualBanId])

    adminRoleCluster.leftMap.get(adminRoleCluster.adminId)!.clear()
    await adminRoom.ban(virtualBanId, {reason: 'spamming'})

    assert.equal(adminRoom.getPeers()[virtualBanId], undefined)
    assert.ok(
      adminRoleCluster.leftMap.get(adminRoleCluster.adminId)!.has(virtualBanId)
    )
    assert.ok(!adminRoom.getTopology().roomPeerIds.includes(virtualBanId))

    // Non-admin peers also evict the banned virtual peer upon receiving the signed moderation record
    await waitFor(
      () =>
        !adminRoleCluster.rooms.get(adminClusterIds[2]!)!.getPeers()[
          virtualBanId
        ],
      3_000
    )
  } finally {
    await Promise.all([...adminRoleCluster.rooms.values()].map(r => r.leave()))
    for (const p of adminRoleCluster.links.values()) {
      p.peerA.destroy()
      p.peerB.destroy()
    }
  }
})

void test('Bug 1.4: multi-chunk (> 64 KiB) unicast transfer survives mid-flight promotion from virtual to direct peer', async () => {
  const cluster = await createTestScaleCluster({
    peerCount: 10,
    maxDirectPeers: 4,
    delayMs: 2
  })

  try {
    const senderId = cluster.peerIds[0]!
    const senderRoom = cluster.rooms.get(senderId)!
    const receiverId = cluster.peerIds.find(
      id =>
        id !== senderId && !senderRoom.getTopology().directPeerIds.includes(id)
    )!
    assert.ok(receiverId, 'found multi-hop virtual peer')

    const receiverRoom = cluster.rooms.get(receiverId)!
    const roomErrors: string[] = []
    senderRoom.onError(e => roomErrors.push(`sender:${e.code}:${e.message}`))
    receiverRoom.onError(e =>
      roomErrors.push(`receiver:${e.code}:${e.message}`)
    )

    const senderAction = senderRoom.makeAction<Uint8Array>('blobxfer')
    const receiverAction = receiverRoom.makeAction<Uint8Array>('blobxfer')

    let receivedBytes: Uint8Array | null = null
    receiverAction.onMessage(data => {
      receivedBytes =
        data instanceof Uint8Array
          ? data
          : new Uint8Array(data as unknown as ArrayBuffer)
    })

    // 192 KiB payload (~12 chunks at 16 KiB/chunk), triggers automatic direct promotion on chunk 0 ('offer')
    const expected = new Uint8Array(192 * 1024)
    for (let i = 0; i < expected.length; i++) {
      expected[i] = (i * 31 + 7) & 0xff
    }

    const sendP = senderAction.send(expected, {target: receiverId})
    // Also force immediate direct link mid-transfer
    cluster.connectPair(senderId, receiverId)
    await sendP

    await waitFor(() => receivedBytes !== null, 5_000)
    assert.equal(
      roomErrors.length,
      0,
      `unexpected errors: ${roomErrors.join(', ')}`
    )
    assert.equal(receivedBytes!.byteLength, expected.byteLength)
    assert.deepEqual(receivedBytes, expected)
    assert.ok(
      senderRoom.getTopology().directPeerIds.includes(receiverId),
      'direct WebRTC link remained healthy after mid-transfer promotion'
    )
  } finally {
    await cluster.cleanup()
  }
})

void test('Bug 1.7: early broadcast before PeerDescriptor is buffered until encPubKey arrives so immediate unicast reply succeeds', async () => {
  const epA = testEndpoint('early-bcast-origin-A')
  const idA = epA.peerId
  const [idB, idC] = allocTestPeerIds(2)
  const encKeyPairA = await crypto.subtle.generateKey(
    {name: 'ECDH', namedCurve: 'P-256'},
    true,
    ['deriveKey', 'deriveBits']
  )
  const encJwkA = await crypto.subtle.exportKey('jwk', encKeyPairA.publicKey)

  let regB!: (peer: PeerHandle, id: string) => void
  let regC!: (peer: PeerHandle, id: string) => void

  const roomB = createRoom(
    f => {
      regB = f
    },
    () => {},
    () => {},
    {
      endpointIdentity: getTestEndpointByPeerId(idB!),
      appId: 'early-bcast-app',
      roomId: 'early-bcast-room',
      use: [scale({maxDirectPeers: 4})]
    }
  ) as unknown as Room & ScalePluginApi

  const roomC = createRoom(
    f => {
      regC = f
    },
    () => {},
    () => {},
    {
      endpointIdentity: getTestEndpointByPeerId(idC!),
      appId: 'early-bcast-app',
      roomId: 'early-bcast-room',
      use: [scale({maxDirectPeers: 4})]
    }
  ) as unknown as Room & ScalePluginApi

  const {peerA: linkBC_B, peerB: linkBC_C} = linkPeers(
    new LinkedPeer(),
    new LinkedPeer()
  )

  try {
    regB(linkBC_B as unknown as PeerHandle, idC!)
    regC(linkBC_C as unknown as PeerHandle, idB!)
    await waitFor(() => roomC.getTopology().directPeerIds.includes(idB!), 2_000)

    const scaleC = getRoomSignalingBridge(roomC)!.getScaleProvider()!

    // Verify stats.messagesSent does NOT increment when sending unicast to unknown peer
    const probeMgr = createOverlayManager({
      selfId: idC!,
      appId: 'early-bcast-app',
      roomId: 'early-bcast-room',
      config: {maxDirectPeers: 4},
      getLocalEndpointIdentity: () => getTestEndpointByPeerId(idC!),
      onVirtualPeerJoin: () => true,
      onVirtualPeerLeave: () => {},
      onDeliverData: () => {}
    })
    try {
      const sentBeforeDrop = probeMgr.getSnapshot().stats.messagesSent
      probeMgr.sendUnicast(idA, new Uint8Array([actionWireVersion, 0]))
      assert.equal(probeMgr.getSnapshot().stats.messagesSent, sentBeforeDrop)
    } finally {
      probeMgr.destroy()
    }

    // Pre-pin A's signing key on C (e.g. from role cert or prior session) WITHOUT A's PeerDescriptor/encPubKey
    scaleC.setPeerSignPublicKey(idA, jwkToCompactPub(epA.signPubJwk))

    let joinFiredOnC = false
    let receivedHelloOnC = false
    roomC.onPeerJoin(({peerId}) => {
      if (peerId === idA) {
        joinFiredOnC = true
      }
    })

    const helloC = roomC.makeAction<string>('hello')
    const replyC = roomC.makeAction<string>('reply')
    let replySendError: unknown = null

    helloC.onMessage((msg, {peerId}) => {
      if (peerId === idA && msg === 'hi-from-A') {
        receivedHelloOnC = true
        void replyC.send('ack-from-C', {target: peerId}).catch(err => {
          replySendError = err
        })
      }
    })

    // Build a valid v3 inline action wire frame for 'hello' with text string "hi-from-A"
    const actionPayloadText = encodeBytes('hi-from-A')
    const wireFrame = new Uint8Array(36 + actionPayloadText.byteLength)
    wireFrame[0] = actionWireVersion
    wireFrame[1] = 0 // inline textFormat, unchunked
    wireFrame.set(encodeBytes('hello'), 2)
    wireFrame.set(actionPayloadText, 36)

    // Inject A's signed broadcast into C via relay B BEFORE A's PeerDescriptor arrives
    const msgId = `${idA}:1:early001`
    const ts = Date.now()
    const bcastCanon = canonicalBroadcastHeader(
      idA,
      msgId,
      1,
      ts,
      'early-bcast-app',
      'early-bcast-room'
    )
    const bcastSig = await signOverlayPayload(
      epA.signPrivateKey,
      bcastCanon,
      wireFrame
    )
    const bcastPacket = packOverlayBinary(
      overlayBroadcastKind,
      4,
      {o: idA, q: 1, m: msgId, t: ts, s: bcastSig},
      wireFrame
    )
    linkBC_B.sendData(bcastPacket)

    // Wait a tick: C must buffer the broadcast rather than firing onPeerJoin without encPubKey
    await new Promise(r => setTimeout(r, 30))
    assert.equal(
      joinFiredOnC,
      false,
      'onPeerJoin deferred until encPubKey arrives'
    )
    assert.equal(
      receivedHelloOnC,
      false,
      'broadcast buffered until encPubKey arrives'
    )

    // Capture encrypted unicast packets forwarded back through B destined for A
    const forwardedToA: Uint8Array[] = []
    const origSendB = linkBC_C.sendData.bind(linkBC_C)
    linkBC_C.sendData = (bytes: Uint8Array) => {
      if (bytes[0] === overlayFrameVersion && bytes[1] === overlayUnicastKind) {
        forwardedToA.push(bytes.slice())
      }
      origSendB(bytes)
    }

    // Now deliver A's signed PeerDescriptor (with encPubKey, userProof, and neighbor B)
    const userA = await createUserIdentity()
    const pubEncCompact = jwkToCompactPub(encJwkA)
    const signCompactA = jwkToCompactPub(epA.signPubJwk)
    const descA = await signPeerDescriptor(
      {
        peerId: idA,
        seq: 1,
        neighbors: [idB!],
        signPubKey: signCompactA,
        encPubKey: pubEncCompact
      },
      {
        peerId: idA,
        signPrivateKey: epA.signPrivateKey,
        signPubKey: signCompactA,
        encPrivateKey: encKeyPairA.privateKey,
        encPubKey: pubEncCompact
      },
      'early-bcast-app',
      'early-bcast-room',
      '',
      userA
    )
    // Also advertise A as a neighbor of B so shortest-path routing sees mutual edge B <-> A
    const scaleB = getRoomSignalingBridge(roomB)!.getScaleProvider()!
    scaleB.handleFrame(
      idC!,
      packGossipControlFrames([descA])[0]!.slice().buffer
    )
    const dummyPeerAOnB = new LinkedPeer() as unknown as PeerHandle
    scaleB.addDirectPeer(idA, dummyPeerAOnB)

    for (const frame of packGossipControlFrames([descA])) {
      linkBC_B.sendData(frame)
    }

    await waitFor(
      () => joinFiredOnC && receivedHelloOnC && forwardedToA.length >= 1,
      3_000
    )
    assert.equal(replySendError, null)
    assert.ok(roomC.getTopology().stats.messagesSent >= 1)
  } finally {
    await Promise.all([roomB.leave(), roomC.leave()])
    linkBC_B.destroy()
    linkBC_C.destroy()
  }
})

void test('Sequential 8-peer joins (ascending and descending peerId) with scale({maxDirectPeers: 4}) never lock out the 8th peer and preserve multi-hop indirect routes', async () => {
  for (const order of ['ascending', 'descending'] as const) {
    // Use the production 60 s steady announce interval so a lowest-ID newcomer in descending
    // order relies on existing peers' immediate counter-pings ('bridge-hi') rather than rapid re-announces.
    const bus = createMemorySignalBus({
      delivery: 'timeout',
      steadyAnnounceIntervalMs: 60_000
    })
    const appId = `seq-8-app-${order}`
    const peers = await createSortedJoinRooms(
      8,
      () => bus.makeJoinRoom(),
      appId
    )
    const orderedPeers = order === 'ascending' ? peers : [...peers].reverse()
    const rooms: Array<Room & ScalePluginApi> = []

    try {
      for (const p of orderedPeers) {
        const room = p.joinRoom(
          {
            appId,
            rtcPolyfill: bus.rtcPolyfill,
            use: [scale({maxDirectPeers: 4})]
          },
          `seq-8-room-${order}`
        ) as Room & ScalePluginApi
        rooms.push(room)
        if (rooms.length > 1) {
          await waitFor(() => Object.keys(room.getPeers()).length >= 1, 2_500)
          await wait(80)
        }
      }

      await waitFor(
        () => rooms.every(r => Object.keys(r.getPeers()).length === 7),
        4_000
      )
      await wait(80)

      let indirectPairCount = 0
      for (const r of rooms) {
        for (const info of Object.values(r.getPeers())) {
          if (!info.direct && (info.hops ?? 0) >= 2) {
            indirectPairCount++
          }
        }
      }
      assert.ok(
        indirectPairCount > 0,
        `${order} 8-peer join with maxDirectPeers=4 must retain multi-hop indirect pairs, got 0`
      )
    } finally {
      await Promise.all(rooms.map(r => r.leave()))
      bus.clearRtcRealm()
    }
  }
})

void test('Two independently converged scale({maxDirectPeers: 4}) components ({0..6} and {7..11}) bridge and converge state once signaling connects them', async () => {
  const realm = createMemoryRtcRealm()
  let partitionActive = true
  const handlersByTopic = new Map<
    string,
    Set<{
      slot: {group: 0 | 1}
      fn: (topic: string, data: StrategyMessage) => void
    }>
  >()
  const slots: Array<{group: 0 | 1}> = []

  const makePartitionedJoin = () => {
    const slot: {group: 0 | 1} = {group: 0}
    slots.push(slot)
    const join = createTopicStrategy({
      steadyAnnounceIntervalMs: 80,
      init: () => ({}),
      subscribeTopic: (_relay, topic, onMessage) => {
        let set = handlersByTopic.get(topic)
        if (!set) {
          set = new Set()
          handlersByTopic.set(topic, set)
        }
        const entry = {slot, fn: onMessage}
        set.add(entry)
        return () => {
          set?.delete(entry)
        }
      },
      publishTopic: (_relay, topic, message) => {
        const set = handlersByTopic.get(topic)
        if (!set) {
          return
        }
        for (const entry of set) {
          if (partitionActive && entry.slot.group !== slot.group) {
            continue
          }
          setTimeout(() => {
            if (handlersByTopic.get(topic)?.has(entry)) {
              entry.fn(topic, message)
            }
          }, 1)
        }
      }
    })
    return {join, slot}
  }

  const slotByJoin = new Map<unknown, {group: 0 | 1}>()
  const sortedPeers = await createSortedJoinRooms(
    12,
    () => {
      const {join, slot} = makePartitionedJoin()
      slotByJoin.set(join, slot)
      return join
    },
    'split-brain-app'
  )
  sortedPeers.forEach((entry, idx) => {
    slotByJoin.get(entry.joinRoom)!.group = idx < 7 ? 0 : 1
  })

  const rooms: Array<Room & ScalePluginApi> = []
  try {
    // Join peers 0..6 in partition group 0 so all 7 converge (previously hitting directCount == maxDirectPeers + 2)
    for (let i = 0; i < 7; i++) {
      const room = sortedPeers[i]!.joinRoom(
        {
          appId: 'split-brain-app',
          rtcPolyfill: realm.rtcPolyfill,
          use: [scale({maxDirectPeers: 4})]
        },
        'split-brain-room'
      ) as Room & ScalePluginApi
      rooms.push(room)
      if (i > 0) {
        await waitFor(() => Object.keys(room.getPeers()).length >= 1, 2_500)
        await wait(80)
      }
    }
    await waitFor(
      () =>
        rooms.slice(0, 7).every(r => Object.keys(r.getPeers()).length === 6),
      4_000
    )

    // Join peers 7..11 in partition group 1 so they form an independent converged 5-clique
    for (let i = 7; i < 12; i++) {
      const room = sortedPeers[i]!.joinRoom(
        {
          appId: 'split-brain-app',
          rtcPolyfill: realm.rtcPolyfill,
          use: [scale({maxDirectPeers: 4})]
        },
        'split-brain-room'
      ) as Room & ScalePluginApi
      rooms.push(room)
    }
    await waitFor(
      () =>
        rooms.slice(7, 12).every(r => Object.keys(r.getPeers()).length === 4),
      4_000
    )

    const states = rooms.map(r =>
      r.makeState<{fromLow?: number; fromHigh?: number}>('merged-map', {})
    )
    await states[0]!.set({fromLow: 1})
    await states[11]!.set({fromHigh: 2, fromLow: 1})

    // Heal signaling partition: both converged components must bridge and converge
    partitionActive = false

    await waitFor(
      () =>
        rooms.every(r => Object.keys(r.getPeers()).length === 11) &&
        states.every(s => s.get().fromLow === 1 && s.get().fromHigh === 2),
      3_000
    )
  } finally {
    await Promise.all(rooms.map(r => r.leave()))
    realm.clear()
  }
})

void test('Partitioned peer with a cached descriptor (within 180 s TTL) but no active route is still bridged outbound', async () => {
  const sortedIds = allocTestPeerIds(7).sort()
  const cliqueIds = sortedIds.slice(0, 5)
  const relayOnlyNeighborId = sortedIds[5]!
  const partitionedPeerId = sortedIds[6]!
  const managers = cliqueIds.map(id =>
    createOverlayManager({
      selfId: id,
      appId: 'cached-partition-app',
      roomId: 'cached-partition-room',
      config: {maxDirectPeers: 4},
      getLocalEndpointIdentity: () => getTestEndpointByPeerId(id),
      onVirtualPeerJoin: () => true,
      onVirtualPeerLeave: () => {},
      onDeliverData: () => {}
    })
  )

  try {
    for (let i = 0; i < managers.length; i++) {
      for (let j = i + 1; j < managers.length; j++) {
        const idA = cliqueIds[i]!
        const idB = cliqueIds[j]!
        managers[i]!.addDirectPeer(idB, makeOverlayPipe(idA, managers[j]!))
        managers[j]!.addDirectPeer(idA, makeOverlayPipe(idB, managers[i]!))
      }
    }
    await waitFor(
      () =>
        managers.every(
          m =>
            m.getSnapshot().directPeerIds.length === 4 &&
            cliqueIds.every(
              other =>
                other === m.getSnapshot().peerId ||
                m.getPeerSignPublicKey(other) !== undefined
            )
        ),
      2_000
    )

    // Inject a valid cached descriptor for partitionedPeerId whose sole neighbor (relayOnlyNeighborId)
    // is disconnected, so partitionedPeerId is in knownRoster without an active route.
    const ep = getTestEndpointByPeerId(partitionedPeerId)
    const signCompact = jwkToCompactPub(ep.signPubJwk)
    const encKeyPair = await crypto.subtle.generateKey(
      {name: 'ECDH', namedCurve: 'P-256'},
      true,
      ['deriveBits']
    )
    const encCompact = jwkToCompactPub(
      await crypto.subtle.exportKey('jwk', encKeyPair.publicKey)
    )
    const cachedDesc = await signPeerDescriptor(
      {
        peerId: partitionedPeerId,
        seq: 1,
        neighbors: [relayOnlyNeighborId],
        signPubKey: signCompact,
        encPubKey: encCompact
      },
      {
        peerId: partitionedPeerId,
        signPrivateKey: ep.signPrivateKey,
        signPubKey: signCompact,
        encPrivateKey: encKeyPair.privateKey,
        encPubKey: encCompact
      },
      'cached-partition-app',
      'cached-partition-room',
      '',
      null
    )
    const gossipFrame = packGossipControlFrames([cachedDesc])[0]!.slice().buffer
    managers[0]!.handleOverlayFrame(cliqueIds[1]!, gossipFrame)

    await waitFor(
      () =>
        managers.every(
          m => m.getPeerSignPublicKey(partitionedPeerId) !== undefined
        ),
      2_000
    )

    for (const m of managers) {
      assert.equal(m.getRoute(partitionedPeerId), undefined)
    }
    const willingBridges = managers.filter(m =>
      m.shouldConnectPeer(partitionedPeerId, 'outbound')
    )
    assert.equal(
      willingBridges.length,
      2,
      'exactly 2 designated bridges must still dial an unreachable peer even when its descriptor is cached'
    )
  } finally {
    managers.forEach(m => m.destroy())
  }
})
