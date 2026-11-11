import assert from 'node:assert/strict'
import test from './test.ts'
import {
  createOverlayManager,
  overlayFrameVersion
} from '../../packages/core/src/scale/index.ts'
import type {
  PeerDataTransport,
  PeerHandle
} from '../../packages/core/src/internal-types.ts'
import {
  decodeBytes,
  encodeBytes,
  fromJson
} from '../../packages/core/src/utils.ts'
import {makeOverlayPipe} from './overlay-harness.ts'
import {
  allocTestPeerIds,
  getTestEndpointByPeerId,
  testPeerId,
  wait,
  waitFor
} from './peer-harness.ts'

void test('S5: overlay rejects broadcast/unicast replays after seenMsgIds eviction and across direct reconnects, and isolates ECDH keys', async () => {
  const deliveredBroadcasts: string[] = []
  const deliveredUnicasts: string[] = []

  let capturedBroadcast = null as Uint8Array | null
  let capturedUnicast = null as Uint8Array | null
  const aliceId = testPeerId('alice-s5')
  const relayId = testPeerId('relay-s5')
  const carolId = testPeerId('carol-s5')

  const alice = createOverlayManager({
    selfId: aliceId,
    appId: 's5-app',
    roomId: 's5-room',
    config: {maxDirectPeers: 4},
    getLocalEndpointIdentity: () => getTestEndpointByPeerId(aliceId),
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })
  const relay = createOverlayManager({
    selfId: relayId,
    appId: 's5-app',
    roomId: 's5-room',
    config: {maxDirectPeers: 4},
    getLocalEndpointIdentity: () => getTestEndpointByPeerId(relayId),
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: (_from, data) => {
      deliveredBroadcasts.push(decodeBytes(new Uint8Array(data)))
    }
  })
  const carol = createOverlayManager({
    selfId: carolId,
    appId: 's5-app',
    roomId: 's5-room',
    config: {maxDirectPeers: 4},
    getLocalEndpointIdentity: () => getTestEndpointByPeerId(carolId),
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: (_from, data) => {
      const txt = decodeBytes(new Uint8Array(data))
      if (txt.startsWith('uni:')) {
        deliveredUnicasts.push(txt)
      }
    }
  })

  try {
    // Verify per-instance non-extractable ECDH keys (distinct across OverlayManager instances)
    const aliceCrypto1 = await alice.getLocalCryptoIdentity()
    const alice2 = createOverlayManager({
      selfId: aliceId,
      appId: 's5-app',
      roomId: 's5-room-2',
      config: {maxDirectPeers: 4},
      getLocalEndpointIdentity: () => getTestEndpointByPeerId(aliceId),
      onVirtualPeerJoin: () => {},
      onVirtualPeerLeave: () => {},
      onDeliverData: () => {}
    })
    const aliceCrypto2 = await alice2.getLocalCryptoIdentity()
    assert.equal(aliceCrypto1.encPrivateKey.extractable, false)
    assert.notEqual(aliceCrypto1.encPubKey, aliceCrypto2.encPubKey)
    alice2.destroy()

    const ar = {alive: true}
    const rc = {alive: true}
    const aliceToRelaySniffer: PeerHandle = {
      ...makeOverlayPipe(aliceId, relay, ar),
      sendData: (d: Uint8Array) => {
        if (d[0] === overlayFrameVersion && d[1] === 2 && !capturedBroadcast) {
          capturedBroadcast = d.slice()
        }
        relay.handleOverlayFrame(aliceId, d.slice().buffer)
      }
    }
    const relayToCarolSniffer: PeerHandle = {
      ...makeOverlayPipe(relayId, carol, rc),
      sendData: (d: Uint8Array) => {
        if (d[0] === overlayFrameVersion && d[1] === 3 && !capturedUnicast) {
          capturedUnicast = d.slice()
        }
        carol.handleOverlayFrame(relayId, d.slice().buffer)
      }
    }

    alice.addDirectPeer(relayId, aliceToRelaySniffer)
    relay.addDirectPeer(aliceId, makeOverlayPipe(relayId, alice, ar))
    relay.addDirectPeer(carolId, relayToCarolSniffer)
    carol.addDirectPeer(relayId, makeOverlayPipe(carolId, relay, rc))

    await waitFor(() => Boolean(alice.getSnapshot().routes[carolId]), 2_000)

    await alice.broadcastInline(encodeBytes('bcast-target'))
    alice.sendUnicast(carolId, encodeBytes('uni:secret-1'))
    await waitFor(
      () =>
        deliveredBroadcasts.includes('bcast-target') &&
        deliveredUnicasts.includes('uni:secret-1'),
      2_000
    )
    assert.ok(capturedBroadcast)
    assert.ok(capturedUnicast)

    // Flush seenMsgIds (4,096 FIFO) with 4,150 newer broadcasts from Alice
    for (let i = 0; i < 4_150; i++) {
      await alice.broadcastInline(encodeBytes(`flush-${i}`))
    }

    // Disconnect and reconnect Alice <-> Relay (previously cleared originReplay!)
    relay.removeDirectPeer(aliceId)
    relay.addDirectPeer(aliceId, makeOverlayPipe(relayId, alice, ar))

    const countBeforeBcast = deliveredBroadcasts.filter(
      x => x === 'bcast-target'
    ).length
    relay.handleOverlayFrame(aliceId, capturedBroadcast!.slice().buffer)
    carol.handleOverlayFrame(relayId, capturedUnicast!.slice().buffer)
    await wait(40)

    assert.equal(
      deliveredBroadcasts.filter(x => x === 'bcast-target').length,
      countBeforeBcast,
      'replayed broadcast after FIFO flush + reconnect must be rejected'
    )
    assert.equal(
      deliveredUnicasts.filter(x => x === 'uni:secret-1').length,
      1,
      'replayed E2E unicast must be rejected'
    )
  } finally {
    alice.destroy()
    relay.destroy()
    carol.destroy()
  }
})

void test('S7: cross-room broadcast/leave envelopes are rejected and setRoomId evicts pre-resolution descriptors', async () => {
  let capturedRoomXBroadcast: Uint8Array | null = null
  let capturedRoomXLeave: Uint8Array | null = null
  const roomYDelivered: string[] = []
  const roomYLeaves: string[] = []
  const aliceId = testPeerId('alice-s7')
  const relayId = testPeerId('relay-s7')
  const victimId = testPeerId('victim-s7')

  const aliceX = createOverlayManager({
    selfId: aliceId,
    appId: 's7-app',
    roomId: 'room-X',
    config: {maxDirectPeers: 4},
    getLocalEndpointIdentity: () => getTestEndpointByPeerId(aliceId),
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })
  const relayX = createOverlayManager({
    selfId: relayId,
    appId: 's7-app',
    roomId: 'room-X',
    config: {maxDirectPeers: 4},
    getLocalEndpointIdentity: () => getTestEndpointByPeerId(relayId),
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })
  const aliceY = createOverlayManager({
    selfId: aliceId,
    appId: 's7-app',
    roomId: 'room-Y',
    config: {maxDirectPeers: 4},
    getLocalEndpointIdentity: () => getTestEndpointByPeerId(aliceId),
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })
  const relayY = createOverlayManager({
    selfId: relayId,
    appId: 's7-app',
    roomId: 'room-Y',
    config: {maxDirectPeers: 4},
    getLocalEndpointIdentity: () => getTestEndpointByPeerId(relayId),
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })
  const victimY = createOverlayManager({
    selfId: victimId,
    appId: 's7-app',
    roomId: 'room-Y',
    config: {maxDirectPeers: 4},
    getLocalEndpointIdentity: () => getTestEndpointByPeerId(victimId),
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: id => roomYLeaves.push(id),
    onDeliverData: (_from, d) =>
      roomYDelivered.push(decodeBytes(new Uint8Array(d)))
  })

  try {
    aliceX.addDirectPeer(relayId, {
      ...makeOverlayPipe(aliceId, relayX),
      sendData: (d: Uint8Array) => {
        if (d[0] === overlayFrameVersion && d[1] === 2) {
          capturedRoomXBroadcast = d.slice()
        } else if (d[0] === overlayFrameVersion && d[1] === 1) {
          const hdr = fromJson<{t: string}>(decodeBytes(d.subarray(2)))
          if (hdr.t === 'leave') {
            capturedRoomXLeave = d.slice()
          }
        }
        relayX.handleOverlayFrame(aliceId, d.slice().buffer)
      }
    })
    relayX.addDirectPeer(aliceId, makeOverlayPipe(relayId, aliceX))

    aliceY.addDirectPeer(relayId, makeOverlayPipe(aliceId, relayY))
    relayY.addDirectPeer(aliceId, makeOverlayPipe(relayId, aliceY))
    relayY.addDirectPeer(victimId, makeOverlayPipe(relayId, victimY))
    victimY.addDirectPeer(relayId, makeOverlayPipe(victimId, relayY))

    await waitFor(() => Boolean(victimY.getSnapshot().routes[aliceId]), 2_000)

    await aliceX.broadcastInline(encodeBytes('from-room-X'))
    await aliceX.announceLeave()
    await waitFor(
      () => Boolean(capturedRoomXBroadcast && capturedRoomXLeave),
      2_000
    )

    // Relay replays Alice's room-X broadcast and room-X leave into room-Y
    victimY.handleOverlayFrame(relayId, capturedRoomXBroadcast!.slice().buffer)
    victimY.handleOverlayFrame(relayId, capturedRoomXLeave!.slice().buffer)
    await wait(50)

    assert.equal(roomYDelivered.includes('from-room-X'), false)
    assert.equal(roomYLeaves.includes(aliceId), false)
    assert.ok(victimY.getSnapshot().routes[aliceId])

    // Updating roomId via setRoomId evicts descriptors signed for the old roomId
    victimY.setRoomId('room-Y~resolvedFp123456789012')
    assert.equal(victimY.getSnapshot().routes[aliceId], undefined)
  } finally {
    aliceX.destroy()
    relayX.destroy()
    aliceY.destroy()
    relayY.destroy()
    victimY.destroy()
  }
})

void test('D8: transient 250ms route churn does not flap virtual peer membership under default 1200ms unreachableGraceMs', async () => {
  const virtualLeaves: string[] = []
  const virtualJoins: string[] = []
  const aliceId = testPeerId('alice-d8')
  const relay1Id = testPeerId('relay1-d8')
  const relay2Id = testPeerId('relay2-d8')
  const bobId = testPeerId('bob-d8')

  // Topology: alice <-> relay1 <-> relay2 <-> bob (so relay1 <-> relay2 drop is non-direct to alice)
  const alice = createOverlayManager({
    selfId: aliceId,
    appId: 'd8-app',
    roomId: 'd8-room',
    config: {maxDirectPeers: 4},
    getLocalEndpointIdentity: () => getTestEndpointByPeerId(aliceId),
    onVirtualPeerJoin: id => virtualJoins.push(id),
    onVirtualPeerLeave: id => virtualLeaves.push(id),
    onDeliverData: () => {}
  })
  const relay1 = createOverlayManager({
    selfId: relay1Id,
    appId: 'd8-app',
    roomId: 'd8-room',
    config: {maxDirectPeers: 4},
    getLocalEndpointIdentity: () => getTestEndpointByPeerId(relay1Id),
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })
  const relay2 = createOverlayManager({
    selfId: relay2Id,
    appId: 'd8-app',
    roomId: 'd8-room',
    config: {maxDirectPeers: 4},
    getLocalEndpointIdentity: () => getTestEndpointByPeerId(relay2Id),
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })
  const bob = createOverlayManager({
    selfId: bobId,
    appId: 'd8-app',
    roomId: 'd8-room',
    config: {maxDirectPeers: 4},
    getLocalEndpointIdentity: () => getTestEndpointByPeerId(bobId),
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })

  try {
    alice.addDirectPeer(relay1Id, makeOverlayPipe(aliceId, relay1))
    relay1.addDirectPeer(aliceId, makeOverlayPipe(relay1Id, alice))
    const r12 = {alive: true}
    relay1.addDirectPeer(relay2Id, makeOverlayPipe(relay1Id, relay2, r12))
    relay2.addDirectPeer(relay1Id, makeOverlayPipe(relay2Id, relay1, r12))
    relay2.addDirectPeer(bobId, makeOverlayPipe(relay2Id, bob))
    bob.addDirectPeer(relay2Id, makeOverlayPipe(bobId, relay2))

    await waitFor(() => virtualJoins.includes(bobId), 2_000)

    // Drop relay1 <-> relay2 for 250ms (> old 80ms grace, < new 1,200ms grace), then heal
    r12.alive = false
    relay1.removeDirectPeer(relay2Id)
    relay2.removeDirectPeer(relay1Id)
    await wait(250)

    assert.equal(
      virtualLeaves.includes(bobId),
      false,
      'bob-d8 must not flap during 250ms multi-hop route reconvergence'
    )

    const r12Healed = {alive: true}
    relay1.addDirectPeer(relay2Id, makeOverlayPipe(relay1Id, relay2, r12Healed))
    relay2.addDirectPeer(relay1Id, makeOverlayPipe(relay2Id, relay1, r12Healed))
    await waitFor(() => Boolean(alice.getSnapshot().routes[bobId]), 2_000)
    assert.equal(virtualLeaves.includes(bobId), false)
  } finally {
    alice.destroy()
    relay1.destroy()
    relay2.destroy()
    bob.destroy()
  }
})

void test('D9: virtual PeerDataTransport exposes next-hop backpressure, fails over across relays on disconnect, and rejects sends when unreachable', async () => {
  let virtualDestTransport: PeerDataTransport | null = null
  const received: string[] = []
  let viaRelay1 = 0
  let viaRelay2 = 0
  const [relay1Id, relay2Id, srcId, dstId] = allocTestPeerIds(4)

  const src = createOverlayManager({
    selfId: srcId!,
    appId: 'd9-app',
    roomId: 'd9-room',
    config: {maxDirectPeers: 4},
    getLocalEndpointIdentity: () => getTestEndpointByPeerId(srcId!),
    onVirtualPeerJoin: (id, vp) => {
      if (id === dstId) {
        virtualDestTransport = vp
      }
    },
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })
  const relay1 = createOverlayManager({
    selfId: relay1Id!,
    appId: 'd9-app',
    roomId: 'd9-room',
    config: {maxDirectPeers: 4},
    getLocalEndpointIdentity: () => getTestEndpointByPeerId(relay1Id!),
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })
  const relay2 = createOverlayManager({
    selfId: relay2Id!,
    appId: 'd9-app',
    roomId: 'd9-room',
    config: {maxDirectPeers: 4},
    getLocalEndpointIdentity: () => getTestEndpointByPeerId(relay2Id!),
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {}
  })
  const dst = createOverlayManager({
    selfId: dstId!,
    appId: 'd9-app',
    roomId: 'd9-room',
    config: {maxDirectPeers: 4},
    getLocalEndpointIdentity: () => getTestEndpointByPeerId(dstId!),
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: (_from, d) => received.push(decodeBytes(new Uint8Array(d)))
  })

  try {
    const r1State = {alive: true, bufferedAmount: 0}
    const r2State = {alive: true, bufferedAmount: 1_024}

    const withChannelEvents = (pipe: ReturnType<typeof makeOverlayPipe>) => {
      Object.assign(pipe.channel!, {
        bufferedAmountLowThreshold: 65_536,
        addEventListener: () => {},
        removeEventListener: () => {}
      })
      return pipe
    }

    src.addDirectPeer(
      relay1Id!,
      withChannelEvents(
        makeOverlayPipe(srcId!, relay1, r1State, d => {
          if (d[0] === overlayFrameVersion && d[1] === 3) {
            viaRelay1++
          }
        })
      )
    )
    relay1.addDirectPeer(srcId!, makeOverlayPipe(relay1Id!, src))
    relay1.addDirectPeer(dstId!, makeOverlayPipe(relay1Id!, dst))
    dst.addDirectPeer(relay1Id!, makeOverlayPipe(dstId!, relay1))

    src.addDirectPeer(
      relay2Id!,
      withChannelEvents(
        makeOverlayPipe(srcId!, relay2, r2State, d => {
          if (d[0] === overlayFrameVersion && d[1] === 3) {
            viaRelay2++
          }
        })
      )
    )
    relay2.addDirectPeer(srcId!, makeOverlayPipe(relay2Id!, src))
    relay2.addDirectPeer(dstId!, makeOverlayPipe(relay2Id!, dst))
    dst.addDirectPeer(relay2Id!, makeOverlayPipe(dstId!, relay2))

    await waitFor(
      () =>
        Boolean(
          virtualDestTransport &&
          src.getSnapshot().routes[dstId!]?.nextHop === relay1Id!
        ),
      2_000
    )

    // 1. Virtual transport reflects active primary nextHop's bufferedAmount and supports waitForDrain
    r1State.bufferedAmount = 512 * 1024
    assert.equal(virtualDestTransport!.bufferedAmount, 512 * 1024)
    r1State.bufferedAmount = 0
    assert.equal(virtualDestTransport!.bufferedAmount, 0)
    assert.equal(virtualDestTransport!.waitForDrain(), true)

    // 2. Deliver 50 individually signed E2EE unicast packets over primary relay1 and verify queue backpressure drain
    for (let i = 0; i < 50; i++) {
      virtualDestTransport!.sendFrame(encodeBytes(`pkt-${i}`))
    }
    const drainResult = virtualDestTransport!.waitForDrain()
    assert.equal(await drainResult, true)
    await waitFor(() => received.length === 50, 3_000)
    assert.equal(viaRelay1, 50)
    assert.equal(viaRelay2, 0)

    // 3. Disconnect primary relay1: route recomputes to relay2, bufferedAmount reflects relay2, and unicasts fail over cleanly
    r1State.alive = false
    src.removeDirectPeer(relay1Id!)
    assert.equal(src.getSnapshot().routes[dstId!]?.nextHop, relay2Id!)
    assert.equal(virtualDestTransport!.bufferedAmount, 1_024)

    for (let i = 50; i < 100; i++) {
      virtualDestTransport!.sendFrame(encodeBytes(`pkt-${i}`))
    }
    await waitFor(() => received.length === 100, 3_000)
    assert.equal(viaRelay2, 50)

    // 4. When all direct relays die, virtualDestTransport.sendFrame fails synchronously instead of blackholing
    r2State.alive = false
    assert.equal(virtualDestTransport!.isOpen, false)
    assert.equal(virtualDestTransport!.waitForDrain(), false)
    assert.throws(() => virtualDestTransport!.sendFrame(encodeBytes('dead')))
  } finally {
    src.destroy()
    relay1.destroy()
    relay2.destroy()
    dst.destroy()
  }
})
