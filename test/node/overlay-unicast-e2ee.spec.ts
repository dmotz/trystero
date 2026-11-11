import assert from 'node:assert/strict'
import test from './test.ts'
import {ecdsaSign} from '../../packages/core/src/crypto.ts'
import {
  buildOverlaySignedBytes,
  canonicalBroadcastHeader,
  canonicalLeaveHeader,
  createOverlayManager,
  descriptorCanonicalPayload,
  overlayBroadcastKind,
  overlayUnicastKind,
  packOverlayBinary,
  packOverlayControl,
  unpackOverlayFrame
} from '../../packages/core/src/scale/index.ts'
import {
  decodeBytes,
  encodeBytes,
  toBase64Url
} from '../../packages/core/src/utils.ts'
import {createOverlayCluster} from './overlay-harness.ts'
import {
  getTestEndpointByPeerId,
  testPeerId,
  wait,
  waitFor
} from './peer-harness.ts'

void test('Multi-hop unicast: targeted send, ping, RPC request/requestMany, and chunked binary transfer (>16 KiB)', async () => {
  const peerCount = 40
  const cluster = await createOverlayCluster({
    peerCount,
    topology: {
      maxDirectPeers: 4
    }
  })

  try {
    const sourceId = cluster.peerIds[0]!
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
      const dm = cluster.rooms.get(id)!.makeAction<{body: string}>('dm')
      dm.onMessage((data, {peerId}) => {
        dmReceived.get(id)!.push({body: data.body, from: peerId})
      })
      dmActions.set(id, dm)
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
      const rpc = cluster.rooms
        .get(id)!
        .makeAction<{q: number}, {ans: number; responder: string}>('compute', {
          kind: 'request'
        })
      rpc.onRequest((payload, {peerId}) => ({
        ans: payload.q * 2,
        responder: `${id}-for-${peerId}`
      }))
      rpcActions.set(id, rpc)
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
      const fileAction = cluster.rooms
        .get(id)!
        .makeAction<Uint8Array>('file-xfer')
      fileAction.onMessage((data, {peerId, metadata}) => {
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
      })
      fileActions.set(id, fileAction)
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

void test('Security: ECDSA P-256 packet signing, TOFU key pinning, tamper rejection, and ECDH end-to-end unicast encryption', async () => {
  // Create a 3-hop chain: Alice <-> Relay <-> Bob
  const wireTapOnRelay: Uint8Array[] = []
  const aliceDelivered: string[] = []
  const bobDelivered: Array<{from: string; text: string}> = []
  const aliceId = testPeerId('sec-alice')
  const relayId = testPeerId('sec-relay')
  const bobId = testPeerId('sec-bob')
  const malloryId = testPeerId('sec-mallory')

  const alice = createOverlayManager({
    selfId: aliceId,
    appId: 'sec-app',
    roomId: 'sec-room',
    password: 'correct-horse-battery-staple',
    config: {maxDirectPeers: 4},
    getLocalEndpointIdentity: () => getTestEndpointByPeerId(aliceId),
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: (_origin, data) => {
      aliceDelivered.push(decodeBytes(new Uint8Array(data)))
    }
  })

  const relay = createOverlayManager({
    selfId: relayId,
    appId: 'sec-app',
    roomId: 'sec-room',
    password: 'correct-horse-battery-staple',
    config: {maxDirectPeers: 4},
    getLocalEndpointIdentity: () => getTestEndpointByPeerId(relayId),
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })

  const bob = createOverlayManager({
    selfId: bobId,
    appId: 'sec-app',
    roomId: 'sec-room',
    password: 'correct-horse-battery-staple',
    config: {maxDirectPeers: 4},
    getLocalEndpointIdentity: () => getTestEndpointByPeerId(bobId),
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
    relayId,
    makePipe(aliceId, relay, b => wireTapOnRelay.push(b))
  )
  relay.addDirectPeer(aliceId, makePipe(relayId, alice))
  relay.addDirectPeer(
    bobId,
    makePipe(relayId, bob, b => wireTapOnRelay.push(b))
  )
  bob.addDirectPeer(relayId, makePipe(bobId, relay))

  // Wait for signed descriptors (with ECDSA + ECDH public keys) to propagate between Alice and Bob
  await waitFor(
    () =>
      alice.getSnapshot().roomPeerIds.includes(bobId) &&
      bob.getSnapshot().roomPeerIds.includes(aliceId),
    2_000
  )
  await wait(60)

  // 1. End-to-End Encrypted Unicast from Alice -> Bob through Relay
  wireTapOnRelay.length = 0
  const secretPlaintext = 'TOP-SECRET-LAUNCH-CODES-987654321'
  alice.sendUnicast(bobId, encodeBytes(secretPlaintext))

  await waitFor(() => bobDelivered.length === 1, 2_000)
  assert.deepEqual(bobDelivered[0], {
    from: aliceId,
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
      o: aliceId,
      q: 2,
      t: Date.now(),
      m: `${aliceId}:forged-msg-1`,
      s: 'AAAA_invalid_ecdsa_signature_AAAA'
    },
    tamperedPayload
  )
  bob.handleOverlayFrame(relayId, forgedPacket.slice().buffer)
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
    {o: aliceId, q: 3, t: Date.now(), m: `${aliceId}:unsigned-spoof-2`},
    encodeBytes('UNSIGNED-SPOOF')
  )
  const failuresBefore = bob.getSnapshot().stats.signatureFailures
  bob.handleOverlayFrame(relayId, unsignedSpoofPacket.slice().buffer)
  await wait(40)
  assert.equal(bob.getSnapshot().stats.signatureFailures, failuresBefore + 1)
  assert.equal(bobDelivered.length, 1)

  // 4. Descriptor with wrong room password or spoofed key must be rejected
  const failuresBeforeDesc = bob.getSnapshot().stats.signatureFailures
  bob.handleOverlayFrame(
    relayId,
    packOverlayControl({
      t: 'gossip',
      descriptors: [
        {
          peerId: malloryId,
          seq: 1,
          neighbors: [relayId],
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
  assert.ok(!bob.getSnapshot().roomPeerIds.includes(malloryId))

  alice.destroy()
  relay.destroy()
  bob.destroy()
})

void test('Solution (b): per-origin monotonic sequence counter with non-flushable 256-bit sliding replay window and room-bound signed headers', async () => {
  const appId = 'bound-app-1'
  const roomId = 'bound-room-A'
  const bobDelivered: string[] = []
  const capturedFromAlice: Uint8Array[] = []
  const capturedFromCarol: Uint8Array[] = []
  const alicePid = testPeerId('solb-alice')
  const carolPid = testPeerId('solb-carol')
  const bobPid = testPeerId('solb-bob')

  const alice = createOverlayManager({
    selfId: alicePid,
    appId,
    roomId,
    config: {maxDirectPeers: 4},
    getLocalEndpointIdentity: () => getTestEndpointByPeerId(alicePid),
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })
  const carol = createOverlayManager({
    selfId: carolPid,
    appId,
    roomId,
    config: {maxDirectPeers: 4},
    getLocalEndpointIdentity: () => getTestEndpointByPeerId(carolPid),
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })
  const bob = createOverlayManager({
    selfId: bobPid,
    appId,
    roomId,
    config: {maxDirectPeers: 4},
    getLocalEndpointIdentity: () => getTestEndpointByPeerId(bobPid),
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
      bobPid,
      makePipe(alicePid, bob, b => capturedFromAlice.push(b))
    )
    bob.addDirectPeer(alicePid, makePipe(bobPid, alice))
    carol.addDirectPeer(
      bobPid,
      makePipe(carolPid, bob, b => capturedFromCarol.push(b))
    )
    bob.addDirectPeer(carolPid, makePipe(bobPid, carol))

    await waitFor(
      () =>
        bob.getSnapshot().directPeerIds.includes(alicePid) &&
        bob.getSnapshot().directPeerIds.includes(carolPid),
      2_000
    )
    await wait(30)

    // 1. Capture Alice's first broadcast (seq = 1)
    capturedFromAlice.length = 0
    await alice.broadcastInline(encodeBytes('alice-msg-seq-1'))
    await waitFor(() => bobDelivered.includes('alice-msg-seq-1'), 1_000)
    const aliceBroadcast1 = capturedFromAlice.find(
      f => unpackOverlayFrame(f)?.[0] === overlayBroadcastKind
    )!
    assert.ok(aliceBroadcast1)
    assert.equal(unpackOverlayFrame(aliceBroadcast1)?.[2]['q'], 1)

    // 2. Flood > 4,500 valid signed broadcasts from Carol to completely flush Bob's 4,096-entry seenMsgIds cache!
    const carolId = await carol.getLocalCryptoIdentity()
    for (let seq = 1; seq <= 4_500; seq++) {
      const msgId = `${carolPid}:flush-${seq}`
      const ts = Date.now()
      const payload = encodeBytes(`c-${seq}`)
      const canonical = canonicalBroadcastHeader(
        carolPid,
        msgId,
        seq,
        ts,
        appId,
        roomId
      )
      const sig = toBase64Url(
        await ecdsaSign(
          carolId.signPrivateKey,
          buildOverlaySignedBytes(canonical, payload) as BufferSource
        )
      )
      const pkt = packOverlayBinary(
        overlayBroadcastKind,
        4,
        {o: carolPid, q: seq, t: ts, m: msgId, s: sig},
        payload
      )
      bob.handleOverlayFrame(carolPid, pkt.slice().buffer)
    }
    await waitFor(() => bobDelivered.length >= 4_501, 5_000)

    // 3. Replay Alice's broadcast #1 (with the same msgId OR a mutated msgId):
    // Even though > 4,500 messages have rotated seenMsgIds, Bob's per-origin replay state for Alice
    // still remembers seq=1 and drops the replay!
    const deliveredBeforeReplay = bobDelivered.length
    const dupsBeforeReplay = bob.getSnapshot().stats.duplicatesDropped
    bob.handleOverlayFrame(alicePid, aliceBroadcast1.slice().buffer)
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
      const msgId = `${alicePid}:${seq}:ooo`
      const ts = Date.now()
      const payload = encodeBytes(text)
      const canonical = canonicalBroadcastHeader(
        alicePid,
        msgId,
        seq,
        ts,
        appId,
        roomId
      )
      const sig = toBase64Url(
        await ecdsaSign(
          aliceId.signPrivateKey,
          buildOverlaySignedBytes(canonical, payload) as BufferSource
        )
      )
      return packOverlayBinary(
        overlayBroadcastKind,
        4,
        {o: alicePid, q: seq, t: ts, m: msgId, s: sig},
        payload
      )
    }

    const pktSeq10 = await makeSignedAliceBroadcast(10, 'alice-seq-10')
    const pktSeq7 = await makeSignedAliceBroadcast(7, 'alice-seq-7-ooo')
    bob.handleOverlayFrame(alicePid, pktSeq10.slice().buffer)
    await waitFor(() => bobDelivered.includes('alice-seq-10'), 1_000)
    // Arrive out-of-order (seq 7 < maxSeq 10, within 256-bit window)
    bob.handleOverlayFrame(alicePid, pktSeq7.slice().buffer)
    await waitFor(() => bobDelivered.includes('alice-seq-7-ooo'), 1_000)
    // Second replay of seq 7 must be dropped
    const dupsBeforeSeq7Replay = bob.getSnapshot().stats.duplicatesDropped
    bob.handleOverlayFrame(alicePid, pktSeq7.slice().buffer)
    await wait(30)
    assert.equal(
      bob.getSnapshot().stats.duplicatesDropped,
      dupsBeforeSeq7Replay + 1
    )

    // 5. Cross-room and cross-app replay rejection for descriptor, broadcast, unicast, and leave frames
    const otherRoomDelivered: string[] = []
    const otherRoomBob = createOverlayManager({
      selfId: bobPid,
      appId,
      roomId: 'bound-room-B', // Different roomId!
      config: {maxDirectPeers: 4},
      getLocalEndpointIdentity: () => getTestEndpointByPeerId(bobPid),
      onVirtualPeerJoin: () => {},
      onVirtualPeerLeave: () => {},
      onDeliverData: (_from, data) =>
        otherRoomDelivered.push(decodeBytes(new Uint8Array(data)))
    })
    otherRoomBob.setPeerSignPublicKey(alicePid, aliceId.signPubKey)

    // 5a. Replay Alice's valid descriptor from room-A into room-B
    const aliceDescRoomA = {
      peerId: alicePid,
      seq: 20,
      neighbors: [bobPid],
      signPubKey: aliceId.signPubKey,
      encPubKey: aliceId.encPubKey,
      sig: ''
    }
    aliceDescRoomA.sig = toBase64Url(
      await ecdsaSign(
        aliceId.signPrivateKey,
        encodeBytes(
          descriptorCanonicalPayload(aliceDescRoomA, appId, roomId)
        ) as BufferSource
      )
    )

    let failCount = otherRoomBob.getSnapshot().stats.signatureFailures
    otherRoomBob.handleOverlayFrame(
      alicePid,
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
    otherRoomBob.handleOverlayFrame(alicePid, aliceBroadcast1.slice().buffer)
    await wait(30)
    assert.equal(
      otherRoomBob.getSnapshot().stats.signatureFailures,
      failCount + 1,
      'broadcast signed for room-A must be rejected in room-B'
    )
    assert.equal(otherRoomDelivered.length, 0)

    // 5c. Replay Alice's valid unicast from room-A into room-B
    capturedFromAlice.length = 0
    alice.sendUnicast(carolPid, encodeBytes('room-A-secret-unicast'))
    await waitFor(
      () =>
        capturedFromAlice.some(
          f => unpackOverlayFrame(f)?.[0] === overlayUnicastKind
        ),
      1_000
    )
    const aliceUnicastRoomA = capturedFromAlice.find(
      f => unpackOverlayFrame(f)?.[0] === overlayUnicastKind
    )!
    failCount = otherRoomBob.getSnapshot().stats.signatureFailures
    otherRoomBob.handleOverlayFrame(alicePid, aliceUnicastRoomA.slice().buffer)
    await wait(30)
    assert.equal(
      otherRoomBob.getSnapshot().stats.signatureFailures,
      failCount + 1,
      'unicast signed for room-A must be rejected in room-B'
    )

    // 5d. Replay Alice's valid leave from room-A into room-B
    const leaveSigRoomA = toBase64Url(
      await ecdsaSign(
        aliceId.signPrivateKey,
        buildOverlaySignedBytes(
          canonicalLeaveHeader(alicePid, 99, appId, roomId),
          new Uint8Array()
        ) as BufferSource
      )
    )
    failCount = otherRoomBob.getSnapshot().stats.signatureFailures
    otherRoomBob.handleOverlayFrame(
      alicePid,
      packOverlayControl({
        t: 'leave',
        peerId: alicePid,
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
