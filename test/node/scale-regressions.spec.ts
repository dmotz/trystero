import assert from 'node:assert/strict'
import test from './test.ts'
import {
  createUserIdentity,
  roles,
  type PeerHandle,
  type RolesPluginApi,
  type Room,
  type ScalePluginApi,
  type UserIdentity
} from '../../packages/core/src/index.ts'
import type {PeerHandshake} from '../../packages/core/src/types.ts'
import {formatSelfCertifyingRoomId} from '../../packages/core/src/authority.ts'
import createRoom, {
  getRoomSignalingBridge
} from '../../packages/core/src/room.ts'
import {
  canonicalBroadcastHeader,
  createOverlayManager,
  overlayBroadcastKind,
  packGossipControlFrames,
  packOverlayBinary,
  scale,
  signOverlayPayload,
  signPeerDescriptor,
  type OverlayManager
} from '../../packages/core/src/scale/index.ts'
import {encodeBytes, peerBannedErr} from '../../packages/core/src/utils.ts'
import {
  allocTestPeerIds,
  LinkedMediaPeer,
  LinkedPeer,
  linkPeers,
  testEndpoint,
  waitFor
} from './peer-harness.ts'

let nextRegClusterSeq = 0

type ClusterPeerOptions = {
  peerCount: number
  maxConnections?: number
  media?: boolean
  delayMs?: number
  adminId?: string
  identities?: Map<string, UserIdentity>
  onPeerHandshakeByRoom?: (ownerId: string) => PeerHandshake | undefined
}

const createTestScaleCluster = async ({
  peerCount,
  maxConnections = 4,
  media = false,
  delayMs = 1,
  adminId,
  identities,
  onPeerHandshakeByRoom
}: ClusterPeerOptions) => {
  const peerIds = allocTestPeerIds(peerCount)
  const adminIdentity = adminId ? identities?.get(adminId) : undefined
  const roomId = adminIdentity
    ? formatSelfCertifyingRoomId(
        `scale-reg-${++nextRegClusterSeq}`,
        adminIdentity.userId
      )
    : `scale-reg-${++nextRegClusterSeq}`

  const registerCallbacks = new Map<
    string,
    (peer: PeerHandle, id: string) => void
  >()
  const rooms = new Map<
    string,
    Room & ScalePluginApi & Partial<RolesPluginApi>
  >()
  const directLinks = new Map<string, {peerA: LinkedPeer; peerB: LinkedPeer}>()
  const joinedByPeer = new Map<string, Set<string>>()
  const leftByPeer = new Map<string, Set<string>>()

  class DelayedClusterPeer extends (media ? LinkedMediaPeer : LinkedPeer) {
    private timers = new Set<ReturnType<typeof setTimeout>>()

    override sendData(data: Uint8Array) {
      if (this.isDead) {
        return
      }
      const copy = data.slice()
      if (delayMs <= 0) {
        super.sendData(copy)
        return
      }
      const t = setTimeout(() => {
        this.timers.delete(t)
        if (!this.isDead) {
          super.sendData(copy)
        }
      }, delayMs)
      this.timers.add(t)
    }

    override destroy() {
      for (const t of this.timers) {
        clearTimeout(t)
      }
      this.timers.clear()
      super.destroy()
    }
  }

  const linkKey = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`)

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
      new DelayedClusterPeer(),
      new DelayedClusterPeer()
    )
    directLinks.set(key, {peerA, peerB})
    if (idA < idB) {
      regA(peerA as unknown as PeerHandle, idB)
      regB(peerB as unknown as PeerHandle, idA)
    } else {
      regB(peerA as unknown as PeerHandle, idA)
      regA(peerB as unknown as PeerHandle, idB)
    }
  }

  for (const id of peerIds) {
    const joined = new Set<string>()
    const left = new Set<string>()
    joinedByPeer.set(id, joined)
    leftByPeer.set(id, left)
    const userIdentity = identities?.get(id)
    const onPeerHandshake = onPeerHandshakeByRoom?.(id)

    const plugins = adminIdentity
      ? [roles(), scale({mode: 'gossip', maxConnections})]
      : [scale({mode: 'gossip', maxConnections})]

    const room = createRoom(
      f => registerCallbacks.set(id, f),
      peerId => {
        const k = linkKey(id, peerId)
        const pair = directLinks.get(k)
        if (pair) {
          directLinks.delete(k)
          pair.peerA.destroy()
          pair.peerB.destroy()
        }
      },
      () => {},
      {
        selfId: id,
        appId: 'scale-reg-app',
        roomId,
        ...(userIdentity ? {identity: userIdentity} : {}),
        ...(onPeerHandshake ? {onPeerHandshake} : {}),
        use: plugins
      }
    )

    room.onPeerJoin(({peerId}) => {
      left.delete(peerId)
      joined.add(peerId)
    })
    room.onPeerLeave(({peerId}) => {
      joined.delete(peerId)
      left.add(peerId)
    })

    const bridge = getRoomSignalingBridge(room)
    bridge?.setOnScaleTargetsChanged(targets => {
      for (const targetId of targets) {
        if (directLinks.has(linkKey(id, targetId))) {
          continue
        }
        const canOut =
          (bridge.canConnectPeer(targetId) ?? true) &&
          (bridge.getScaleProvider()?.shouldConnectPeer(targetId, 'outbound') ??
            true)
        if (!canOut) {
          continue
        }
        const targetRoom = rooms.get(targetId)
        const targetBridge = targetRoom
          ? getRoomSignalingBridge(targetRoom)
          : undefined
        const canIn = targetBridge
          ? (targetBridge.canConnectPeer(id) ?? true) &&
            (targetBridge
              .getScaleProvider()
              ?.shouldConnectPeer(id, 'inbound') ??
              true)
          : true
        if (canIn) {
          connectPair(id, targetId)
        }
      }
    })

    rooms.set(
      id,
      room as unknown as Room & ScalePluginApi & Partial<RolesPluginApi>
    )
  }

  for (const id of peerIds) {
    const sp = getRoomSignalingBridge(rooms.get(id)!)?.getScaleProvider()
    for (const otherId of peerIds) {
      if (otherId !== id) {
        sp?.notePeerDiscovered(otherId)
      }
    }
  }
  for (const id of peerIds) {
    const sp = getRoomSignalingBridge(rooms.get(id)!)?.getScaleProvider()
    for (const targetId of sp?.getTargetNeighbors() ?? []) {
      connectPair(id, targetId)
    }
  }

  await waitFor(() => {
    for (const id of peerIds) {
      const snap = rooms.get(id)!.getTopology()
      if (
        snap.roomPeerIds.length !== peerIds.length - 1 ||
        Object.keys(snap.routes).length !== peerIds.length - 1
      ) {
        return false
      }
    }
    return true
  }, 5_000)

  const cleanup = async () => {
    await Promise.all([...rooms.values()].map(r => r.leave()))
    for (const pair of directLinks.values()) {
      pair.peerA.destroy()
      pair.peerB.destroy()
    }
    directLinks.clear()
  }

  return {
    peerIds,
    rooms,
    directLinks,
    joinedByPeer,
    leftByPeer,
    connectPair,
    cleanup
  }
}

void test('Bug 1.1: broadcast addStream in 15-peer gossip room promotes all virtual peers and bounds remote connect spam', async () => {
  const cluster = await createTestScaleCluster({
    peerCount: 15,
    maxConnections: 4,
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

    // Verify remote connect spam is bounded/rate-limited and never evicts localRequiredPeers
    const [selfId, localPinnedId, ...spammerIds] = allocTestPeerIds(22)
    const dialedTargets: string[] = []
    const mgr = createOverlayManager({
      selfId: selfId!,
      appId: 'spam-test',
      roomId: 'spam-room',
      topology: {mode: 'gossip', maxConnections: 4},
      onVirtualPeerJoin: () => true,
      onVirtualPeerLeave: () => {},
      onDeliverData: () => {}
    })
    try {
      mgr.setOnTargetsChanged(ids => dialedTargets.push(...ids))
      mgr.requireDirectPeer(localPinnedId!, {dial: false})
      assert.equal(mgr.shouldConnectPeer(localPinnedId!, 'outbound'), true)

      // Rapid burst from same peer hits token-bucket rate limit (burst=2)
      const spammer0 = spammerIds[0]!
      mgr.notePeerDiscovered(spammer0)
      // Populate knownRoster via addDirectPeer + remove or test rate limit on known peer
      const dummyPeer = new LinkedPeer() as unknown as PeerHandle
      for (const sid of spammerIds) {
        mgr.addDirectPeer(sid, dummyPeer)
      }
      // Remove direct handles without leaving? Instead test with active virtual roster via second manager:
      mgr.destroy()
    } finally {
      mgr.destroy()
    }

    const victimBridge = getRoomSignalingBridge(
      cluster.rooms.get(cluster.peerIds[1]!)!
    )!
    const victimScale =
      victimBridge.getScaleProvider() as unknown as OverlayManager
    const pinnedPeer = cluster.peerIds[14]!
    victimScale.requireDirectPeer(pinnedPeer, {dial: false})

    const remotePeer = cluster.peerIds.find(
      id =>
        id !== cluster.peerIds[1] &&
        !cluster.rooms
          .get(cluster.peerIds[1]!)!
          .getTopology()
          .directPeerIds.includes(id)
    )!
    // Burst of 10 connect requests from the same remote peer: first 2 succeed, rest rate-limited
    let accepted = 0
    for (let i = 0; i < 10; i++) {
      if (victimScale.acceptMediaConnectRequest(remotePeer)) {
        accepted++
      }
    }
    assert.equal(accepted, 2)
    // Local pinned peer remains unconditionally required regardless of remote requests
    assert.equal(victimScale.shouldConnectPeer(pinnedPeer, 'outbound'), true)
  } finally {
    await cluster.cleanup()
  }
})

void test('Bug 1.2: room.ban and onPeerHandshake peerBannedErr immediately purge active virtual overlay peers', async () => {
  const peerCount = 10
  const identities = new Map<string, UserIdentity>()
  // Create identities so roles() can issue signed bans
  const createdIdentities = await Promise.all(
    Array.from({length: peerCount}, () => createUserIdentity())
  )

  let rejectInHandshakeTarget: string | null = null
  const cluster = await createTestScaleCluster({
    peerCount,
    maxConnections: 4,
    adminId: undefined,
    onPeerHandshakeByRoom: ownerId => async remotePeerId => {
      if (ownerId && remotePeerId === rejectInHandshakeTarget) {
        throw peerBannedErr
      }
    }
  })

  try {
    // Part A: onPeerHandshake throwing peerBannedErr when a virtual peer dials directly
    const observerId = cluster.peerIds[0]!
    const observerRoom = cluster.rooms.get(observerId)!
    const virtualTargetId = cluster.peerIds.find(
      id =>
        id !== observerId &&
        !observerRoom.getTopology().directPeerIds.includes(id)
    )!
    assert.ok(
      observerRoom.getPeers()[virtualTargetId],
      'target starts as active virtual peer'
    )

    rejectInHandshakeTarget = virtualTargetId
    cluster.leftByPeer.get(observerId)!.clear()
    cluster.connectPair(observerId, virtualTargetId)

    await waitFor(
      () =>
        !observerRoom.getPeers()[virtualTargetId] &&
        cluster.leftByPeer.get(observerId)!.has(virtualTargetId),
      2_000
    )
    assert.equal(observerRoom.getPeers()[virtualTargetId], undefined)
    assert.ok(!observerRoom.getTopology().roomPeerIds.includes(virtualTargetId))
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
          selfId: id,
          appId: 'ban-scale-app',
          roomId,
          identity: uid,
          use: [roles(), scale({mode: 'gossip', maxConnections: 4})]
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

    // Non-admin peers also evict the banned virtual peer upon receiving the signed ban record
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
    maxConnections: 4,
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
      selfId: idB!,
      appId: 'early-bcast-app',
      roomId: 'early-bcast-room',
      use: [scale({mode: 'gossip', maxConnections: 4})]
    }
  ) as unknown as Room & ScalePluginApi

  const roomC = createRoom(
    f => {
      regC = f
    },
    () => {},
    () => {},
    {
      selfId: idC!,
      appId: 'early-bcast-app',
      roomId: 'early-bcast-room',
      use: [scale({mode: 'gossip', maxConnections: 4})]
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

    const scaleC = getRoomSignalingBridge(
      roomC
    )!.getScaleProvider() as unknown as OverlayManager

    // Verify stats.messagesSent does NOT increment when sending unicast to unknown peer
    const sentBeforeDrop = roomC.getTopology().stats.messagesSent
    scaleC.sendUnicast(idA!, new Uint8Array([2, 0]))
    assert.equal(roomC.getTopology().stats.messagesSent, sentBeforeDrop)

    // Pre-pin A's signing key on C (e.g. from role cert or prior session) WITHOUT A's PeerDescriptor/encPubKey
    scaleC.setPeerSignPublicKey(idA!, epA.signPubJwk)

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

    // Build a valid v2 inline action wire frame for 'hello' with text string "hi-from-A"
    const actionPayloadText = encodeBytes('hi-from-A')
    const wireFrame = new Uint8Array(36 + actionPayloadText.byteLength)
    wireFrame[0] = 2
    wireFrame[1] = 0 // inline textFormat, unchunked
    wireFrame.set(encodeBytes('hello'), 2)
    wireFrame.set(actionPayloadText, 36)

    // Inject A's signed broadcast into C via relay B BEFORE A's PeerDescriptor arrives
    const msgId = `${idA}:1:early001`
    const bcastCanon = canonicalBroadcastHeader(
      idA!,
      msgId,
      1,
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
      {o: idA!, q: 1, m: msgId, s: bcastSig},
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
      if (bytes[0] === 3 && bytes[1] === 3) {
        forwardedToA.push(bytes.slice())
      }
      origSendB(bytes)
    }

    // Now deliver A's signed PeerDescriptor (with encPubKey, userProof, and neighbor B)
    const userA = await createUserIdentity()
    const pubEncJwk = {
      kty: 'EC',
      crv: 'P-256',
      x: encJwkA.x!,
      y: encJwkA.y!
    }
    const descA = await signPeerDescriptor(
      {
        peerId: idA,
        seq: 1,
        neighbors: [idB!],
        signPubKey: epA.signPubJwk,
        encPubKey: pubEncJwk
      },
      {
        peerId: idA,
        signPrivateKey: epA.signPrivateKey,
        signPublicKey: epA.signPublicKey,
        signPubJwk: epA.signPubJwk,
        encPrivateKey: encKeyPairA.privateKey,
        encPublicKey: encKeyPairA.publicKey,
        encPubJwk: pubEncJwk
      },
      'early-bcast-app',
      'early-bcast-room',
      '',
      userA
    )
    // Also advertise A as a neighbor of B so shortest-path routing sees mutual edge B <-> A
    const scaleB = getRoomSignalingBridge(
      roomB
    )!.getScaleProvider() as unknown as OverlayManager
    scaleB.handleOverlayFrame(
      idC!,
      packGossipControlFrames([descA])[0]!.slice().buffer
    )
    const dummyPeerAOnB = new LinkedPeer() as unknown as PeerHandle
    scaleB.addDirectPeer(idA!, dummyPeerAOnB)

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
