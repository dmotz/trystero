import assert from 'node:assert/strict'
import test from './test.ts'
import type {Room, ScalePluginApi} from '../../packages/core/src/index.ts'
import type {PeerHandle} from '../../packages/core/src/types.ts'
import {ecdsaSign} from '../../packages/core/src/crypto.ts'
import {
  buildOverlaySignedBytes,
  canonicalBroadcastHeader,
  canonicalLeaveHeader,
  createOverlayManager,
  descriptorCanonicalPayload,
  maxDescriptorNeighbors,
  overlayFrameVersion,
  packOverlayControl,
  scale
} from '../../packages/core/src/scale/index.ts'
import createRoom, {
  getRoomSignalingBridge
} from '../../packages/core/src/room.ts'
import {encodeBytes, toBase64} from '../../packages/core/src/utils.ts'
import {
  encodeInternalAction,
  getTestEndpointByPeerId,
  LinkedPeer,
  linkPeers,
  testPeerId,
  wait,
  waitFor
} from './peer-harness.ts'

void test('Overlay & room hardening: fake neighbor roster inflation, unknown-origin unicast relay, departed-peer broadcast resurrection, stale leave replay, maxOverlayHeaderBytes, and third-party prune', async () => {
  const appId = 'overlay-hardening-test'
  const roomId = 'hardening-room'
  const deliveredAtBob: Array<{from: string; bytes: Uint8Array}> = []
  const virtualJoinsAtBob: string[] = []
  const virtualLeavesAtBob: string[] = []
  const sentFromRelayToBob: Uint8Array[] = []
  const alicePid = testPeerId('hard-alice')
  const relayPid = testPeerId('hard-relay')
  const bobPid = testPeerId('hard-bob')
  const malloryPid = testPeerId('hard-mallory')

  const alice = createOverlayManager({
    selfId: alicePid,
    appId,
    roomId,
    config: {maxDirectPeers: 6},
    getLocalEndpointIdentity: () => getTestEndpointByPeerId(alicePid),
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })
  const relay = createOverlayManager({
    selfId: relayPid,
    appId,
    roomId,
    config: {maxDirectPeers: 6},
    getLocalEndpointIdentity: () => getTestEndpointByPeerId(relayPid),
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })
  const bob = createOverlayManager({
    selfId: bobPid,
    appId,
    roomId,
    config: {maxDirectPeers: 6},
    getLocalEndpointIdentity: () => getTestEndpointByPeerId(bobPid),
    onVirtualPeerJoin: pid => virtualJoinsAtBob.push(pid),
    onVirtualPeerLeave: pid => virtualLeavesAtBob.push(pid),
    onDeliverData: (from, data) =>
      deliveredAtBob.push({from, bytes: new Uint8Array(data)})
  })
  const mallory = createOverlayManager({
    selfId: malloryPid,
    appId,
    roomId,
    config: {maxDirectPeers: 6},
    getLocalEndpointIdentity: () => getTestEndpointByPeerId(malloryPid),
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })

  try {
    // Link alice <-> relay <-> bob, and mallory <-> bob
    alice.addDirectPeer(relayPid, {
      connection: {} as RTCPeerConnection,
      channel: null,
      isDead: false,
      getOffer: async () => {},
      sendData: d => relay.handleOverlayFrame(alicePid, d.slice().buffer),
      signal: async () => {},
      addStream: () => {},
      removeStream: () => {},
      addTrack: () => ({}) as RTCRtpSender,
      removeTrack: () => {},
      replaceTrack: async () => {},
      setHandlers: () => {},
      destroy: () => {}
    })
    relay.addDirectPeer(alicePid, {
      connection: {} as RTCPeerConnection,
      channel: null,
      isDead: false,
      getOffer: async () => {},
      sendData: d => alice.handleOverlayFrame(relayPid, d.slice().buffer),
      signal: async () => {},
      addStream: () => {},
      removeStream: () => {},
      addTrack: () => ({}) as RTCRtpSender,
      removeTrack: () => {},
      replaceTrack: async () => {},
      setHandlers: () => {},
      destroy: () => {}
    })
    relay.addDirectPeer(bobPid, {
      connection: {} as RTCPeerConnection,
      channel: null,
      isDead: false,
      getOffer: async () => {},
      sendData: d => {
        sentFromRelayToBob.push(d.slice())
        bob.handleOverlayFrame(relayPid, d.slice().buffer)
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
    bob.addDirectPeer(relayPid, {
      connection: {} as RTCPeerConnection,
      channel: null,
      isDead: false,
      getOffer: async () => {},
      sendData: d => relay.handleOverlayFrame(bobPid, d.slice().buffer),
      signal: async () => {},
      addStream: () => {},
      removeStream: () => {},
      addTrack: () => ({}) as RTCRtpSender,
      removeTrack: () => {},
      replaceTrack: async () => {},
      setHandlers: () => {},
      destroy: () => {}
    })
    mallory.addDirectPeer(bobPid, {
      connection: {} as RTCPeerConnection,
      channel: null,
      isDead: false,
      getOffer: async () => {},
      sendData: d => bob.handleOverlayFrame(malloryPid, d.slice().buffer),
      signal: async () => {},
      addStream: () => {},
      removeStream: () => {},
      addTrack: () => ({}) as RTCRtpSender,
      removeTrack: () => {},
      replaceTrack: async () => {},
      setHandlers: () => {},
      destroy: () => {}
    })
    bob.addDirectPeer(malloryPid, {
      connection: {} as RTCPeerConnection,
      channel: null,
      isDead: false,
      getOffer: async () => {},
      sendData: d => mallory.handleOverlayFrame(bobPid, d.slice().buffer),
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
        bob.getSnapshot().roomPeerIds.includes(alicePid) &&
        bob.getSnapshot().roomPeerIds.includes(malloryPid),
      2_000
    )

    // 1. Mallory sends her own fresh signed descriptor with 15 fake neighbor IDs + legacy down: [alicePid]
    const malloryId = await mallory.getLocalCryptoIdentity()
    const malloryFakeNeighbors = Array.from({length: 15}, (_, i) =>
      testPeerId(`sybil-neighbor-${i}`)
    )
    const malloryDesc = {
      peerId: malloryPid,
      seq: 50,
      neighbors: [bobPid, ...malloryFakeNeighbors],
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
          down: [alicePid, 'unknown-phantom-1', 'unknown-phantom-2']
        })
      )
    ])
    bob.handleOverlayFrame(
      malloryPid,
      gossipWithFreshDescAndDown.slice().buffer
    )
    await wait(40)

    assert.ok(
      bob.getSnapshot().roomPeerIds.includes(alicePid),
      'Alice must NOT be evicted when non-neighbor Mallory bundles her own fresh descriptor with down: ["alice"]'
    )
    // Verify Mallory's 15 fake unverified neighbor IDs did NOT inflate Bob's roomPeerIds or target neighbors
    for (const fakeId of malloryFakeNeighbors) {
      assert.equal(
        bob.getSnapshot().roomPeerIds.includes(fakeId),
        false,
        'unverified neighbor claims in a descriptor must not enter roomPeerIds'
      )
      assert.equal(
        bob.getTargetNeighbors().has(fakeId),
        false,
        'unverified neighbor claims in a descriptor must not enter getTargetNeighbors()'
      )
    }

    // Also verify excessive neighbor list (> maxDescriptorNeighbors = 64) is rejected as signatureFailure
    const oversizedNeighborsDesc = {
      peerId: malloryPid,
      seq: 51,
      neighbors: Array.from({length: maxDescriptorNeighbors + 1}, (_, i) =>
        testPeerId(`excess-neighbor-${i}`)
      ),
      signPubKey: malloryId.signPubJwk,
      encPubKey: malloryId.encPubJwk,
      sig: 'AA=='
    }
    const sigFailBeforeExcess = bob.getSnapshot().stats.signatureFailures
    bob.handleOverlayFrame(
      malloryPid,
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

    // 2. Unicast frame from an unknown origin is never forwarded by the relay without verified origin signature
    const unknownOriginPid = testPeerId('unknown-attacker-origin')
    const unknownOriginEp = getTestEndpointByPeerId(unknownOriginPid)
    const relaySentBefore = sentFromRelayToBob.length
    const relaySigFailBefore = relay.getSnapshot().stats.signatureFailures
    const fakeUnicastHeader = encodeBytes(
      JSON.stringify({
        o: unknownOriginPid,
        d: bobPid,
        q: 1,
        m: `${unknownOriginPid}:msg-1`,
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
    relay.handleOverlayFrame(alicePid, fakeUnicastFrame.slice().buffer)
    await wait(40)

    assert.equal(
      sentFromRelayToBob.length,
      relaySentBefore,
      'relay must not forward unicast frame from unverified/unknown origin'
    )

    // Even if unknownOriginPid subsequently publishes a valid descriptor, the forged buffered unicast fails signature verification and is dropped
    const unknownOriginDesc = {
      peerId: unknownOriginPid,
      seq: 1,
      neighbors: [alicePid],
      signPubKey: unknownOriginEp.signPubJwk,
      sig: ''
    }
    unknownOriginDesc.sig = toBase64(
      await unknownOriginEp.sign(
        encodeBytes(
          descriptorCanonicalPayload(unknownOriginDesc, appId, roomId)
        )
      )
    )
    const relaySentBeforeReplay = sentFromRelayToBob.length
    relay.handleOverlayFrame(
      alicePid,
      packOverlayControl({
        t: 'gossip',
        descriptors: [unknownOriginDesc]
      }).slice().buffer
    )
    await wait(40)
    assert.equal(
      relay.getSnapshot().stats.signatureFailures,
      relaySigFailBefore + 1,
      'relay must record signatureFailure when forged unicast is verified'
    )
    // Only gossip control frame(s) may be sent to Bob, never the forged unicast (kind=3)
    const forwardedUnicasts = sentFromRelayToBob
      .slice(relaySentBeforeReplay)
      .filter(f => f[1] === 3)
    assert.equal(
      forwardedUnicasts.length,
      0,
      'relay must never forward forged unicast to Bob'
    )

    // 3. Oversized overlay binary header (> maxOverlayHeaderBytes = 1024 B) is rejected
    const oversizedHeaderBytes = encodeBytes(
      JSON.stringify({
        o: alicePid,
        q: 1,
        m: `${alicePid}:oversized`,
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
    bob.handleOverlayFrame(relayPid, oversizedFrame.slice().buffer)
    await wait(20)
    assert.equal(deliveredAtBob.length, deliveredBeforeOversized)

    // 4. Third-party prune ({t: 'prune', peerId: relayPid} sent by malloryPid) is ignored
    const thirdPartyPrune = new Uint8Array([
      overlayFrameVersion,
      1,
      ...encodeBytes(JSON.stringify({t: 'prune', peerId: relayPid}))
    ])
    bob.handleOverlayFrame(malloryPid, thirdPartyPrune.slice().buffer)
    await wait(20)

    // 5. Capture a valid broadcast and stale leave from Alice; after Alice leaves, replaying her broadcast must NOT resurrect her as a virtual peer
    const aliceId = await alice.getLocalCryptoIdentity()
    const staleLeaveSeq = 1
    const staleLeaveSig = Buffer.from(
      await ecdsaSign(
        aliceId.signPrivateKey,
        buildOverlaySignedBytes(
          canonicalLeaveHeader(alicePid, staleLeaveSeq, appId, roomId),
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
          peerId: alicePid,
          seq: staleLeaveSeq,
          sig: staleLeaveSig
        })
      )
    ])

    // Alice publishes a higher descriptor seq (seq = 100) so seq = 1 is stale
    const aliceNewDesc = {
      peerId: alicePid,
      seq: 100,
      neighbors: [relayPid],
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
      relayPid,
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
    bob.handleOverlayFrame(malloryPid, staleLeaveFrame.slice().buffer)
    await wait(30)
    assert.ok(
      bob.getSnapshot().roomPeerIds.includes(alicePid),
      'stale leave with seq < current descriptor seq must be ignored'
    )

    // Now Alice leaves with a fresh seq = 101; replaying a valid signed broadcast from Alice with an unseen msgId must NOT resurrect Alice
    const freshLeaveSig = Buffer.from(
      await ecdsaSign(
        aliceId.signPrivateKey,
        buildOverlaySignedBytes(
          canonicalLeaveHeader(alicePid, 101, appId, roomId),
          new Uint8Array()
        ) as BufferSource
      )
    ).toString('base64')
    bob.handleOverlayFrame(
      relayPid,
      new Uint8Array([
        overlayFrameVersion,
        1,
        ...encodeBytes(
          JSON.stringify({
            t: 'leave',
            peerId: alicePid,
            seq: 101,
            sig: freshLeaveSig
          })
        )
      ]).slice().buffer
    )
    await wait(30)
    assert.ok(
      !bob.getSnapshot().roomPeerIds.includes(alicePid),
      'Alice should be removed after valid fresh leave'
    )

    const ghostMsgId = `${alicePid}:ghost-broadcast-after-leave`
    const ghostTs = Date.now()
    const ghostPayload = new Uint8Array([1, 2, 3, 4])
    const ghostSig = Buffer.from(
      await ecdsaSign(
        aliceId.signPrivateKey,
        buildOverlaySignedBytes(
          canonicalBroadcastHeader(
            alicePid,
            ghostMsgId,
            1,
            ghostTs,
            appId,
            roomId
          ),
          ghostPayload
        ) as BufferSource
      )
    ).toString('base64')
    const ghostHeaderBytes = encodeBytes(
      JSON.stringify({
        o: alicePid,
        q: 1,
        t: ghostTs,
        m: ghostMsgId,
        s: ghostSig
      })
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
    bob.handleOverlayFrame(malloryPid, ghostBroadcastFrame.slice().buffer)
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

void test('Bug A regression: virtual peer survives a failed direct dial or handshake without dropping from getPeers()', async () => {
  const aliceId = testPeerId('buga-alice')
  const relayId = testPeerId('buga-relay')
  const bobId = testPeerId('buga-bob')
  const peerIds = [aliceId, relayId, bobId]
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
        endpointIdentity: getTestEndpointByPeerId(id),
        appId: 'bug-a-app',
        roomId: 'bug-a-room',
        use: [scale({maxDirectPeers: 4})]
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
    connectDirect(aliceId, relayId)
    connectDirect(relayId, bobId)

    const aliceRoom = rooms.get(aliceId)!
    const bobRoom = rooms.get(bobId)!

    await waitFor(
      () =>
        Boolean(aliceRoom.getPeers()[bobId]) &&
        aliceRoom.getPeers()[bobId]?.direct === false &&
        Boolean(bobRoom.getPeers()[aliceId]),
      3_000
    )

    const aliceLeftPeers: string[] = []
    aliceRoom.onPeerLeave(({peerId}) => {
      aliceLeftPeers.push(peerId)
    })

    const aliceReceived: string[] = []
    for (const id of peerIds) {
      rooms
        .get(id)!
        .makeAction<string>('chat')
        .onMessage(msg => {
          if (id === aliceId) {
            aliceReceived.push(msg)
          }
        })
    }
    const bobChat = bobRoom.makeAction<string>('chat')

    // Inject a direct WebRTC handle for bob at alice whose handshake/ICE fails and closes before activating
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

    registerCallbacks.get(aliceId)!(failingDirectHandle, bobId)
    assert.ok(closeDirectAttempt, 'direct handle close handler must be set')

    // Simulate ICE / handshake failure on the direct dial attempt
    closeDirectAttempt()
    await wait(30)

    assert.deepEqual<string[]>(
      aliceLeftPeers,
      [],
      'failed direct dial must not emit onPeerLeave for an active virtual peer'
    )
    assert.ok(
      aliceRoom.getPeers()[bobId],
      'bob must remain in aliceRoom.getPeers() as a virtual peer after failed direct dial'
    )
    assert.equal(aliceRoom.getPeers()[bobId]?.direct, false)

    // Verify bob's multi-hop broadcasts and unicasts still deliver to alice
    await bobChat.send('broadcast-after-failed-dial')
    await waitFor(
      () => aliceReceived.includes('broadcast-after-failed-dial'),
      2_000
    )

    await bobChat.send('unicast-after-failed-dial', {target: aliceId})
    await waitFor(
      () => aliceReceived.includes('unicast-after-failed-dial'),
      2_000
    )

    // Verify virtual-peer departure ordering: when data-plane leave arrives before control leave,
    // alice must fire onPeerLeave exactly once and 0 spurious onPeerJoin events
    const aliceJoinedAfterLeave: string[] = []
    aliceRoom.onPeerJoin(({peerId}) => {
      if (aliceLeftPeers.length > 0) {
        aliceJoinedAfterLeave.push(peerId)
      }
    })
    await getRoomSignalingBridge(bobRoom)
      ?.getScaleProvider()
      ?.broadcastInline(new Uint8Array(encodeInternalAction('leave')))
    await waitFor(() => aliceLeftPeers.includes(bobId), 2_000)
    await bobRoom.leave()
    await wait(60)
    assert.deepEqual(
      aliceLeftPeers,
      [bobId],
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
