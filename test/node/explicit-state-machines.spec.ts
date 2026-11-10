import assert from 'node:assert/strict'
import {once} from 'node:events'
import {RTCPeerConnection as WeriftRTCPeerConnection} from 'werift'
import WebSocket, {WebSocketServer} from 'ws'
import {
  actionWireVersion,
  createActionWireManager
} from '../../packages/core/src/action-wire.ts'
import {createActionManager} from '../../packages/core/src/actions.ts'
import {createAntiEntropySync} from '../../packages/core/src/anti-entropy.ts'
import {createRoomAuthority, roles} from '../../packages/core/src/authority.ts'
import {createEventEmitter} from '../../packages/core/src/emitter.ts'
import {createHandshakeManager} from '../../packages/core/src/handshake.ts'
import {loadOrCreateIdbIdentity} from '../../packages/core/src/identity-idb.ts'
import {
  clearUserIdentity,
  createEndpointIdentity,
  createUserIdentity,
  jwkToCompactPub,
  resolveUserIdentity,
  verifyUserIdKey,
  verifyWithP256
} from '../../packages/core/src/identity.ts'
import type {
  BaseRoomConfig,
  OfferCheckoutFn,
  PeerHandle,
  SignalContext
} from '../../packages/core/src/internal-types.ts'
import {createMediaManager} from '../../packages/core/src/media.ts'
import {createOfferManager} from '../../packages/core/src/offer-manager.ts'
import initPeer from '../../packages/core/src/peer.ts'
import {
  pluginSlotSymbol,
  toBase64Url
} from '../../packages/core/src/primitives.ts'
import {
  createRelayManager,
  makeSocket,
  releaseRelayLease,
  setRelayConnectivity
} from '../../packages/core/src/relay-manager.ts'
import {
  canonicalBroadcastHeader,
  canonicalUnicastHeader,
  createOverlayManager,
  overlayBroadcastKind,
  overlayUnicastKind,
  packOverlayBinary,
  packOverlayControl,
  scale,
  signOverlayPayload,
  signPeerDescriptor
} from '../../packages/core/src/scale/index.ts'
import {createOverlaySequencer} from '../../packages/core/src/scale/seq.ts'
import {
  buildSignalAad,
  createSignalHandler,
  prunePeerStates
} from '../../packages/core/src/signal-handler.ts'
import {
  createStateManager,
  signStateRecord
} from '../../packages/core/src/state.ts'
import createStrategy from '../../packages/core/src/strategy.ts'
import {joinRoom as joinMqttRoom} from '../../packages/mqtt/src/index.ts'
import {joinRoom as joinNostrRoom} from '../../packages/nostr/src/index.ts'
import {
  getRelaySockets as getTorrentRelaySockets,
  joinRoom as joinTorrentRoom
} from '../../packages/torrent/src/index.ts'
import {
  getRelaySockets as getWsRelaySockets,
  joinRoom as joinWsRelayRoom
} from '../../packages/ws-relay/src/index.ts'
import {createWsRelayServer} from '../../packages/ws-relay/src/server.ts'
import {encrypt, genKey} from '../../packages/core/src/crypto.ts'
import {
  MockDataChannel,
  MockPeer,
  MockRTCPeerConnection,
  createLinkedHandlePair,
  higherPeerId,
  lowerPeerId,
  wait,
  waitFor
} from './peer-harness.ts'
import test from './test.ts'

const encoder = new TextEncoder()

const makeInlineFrame = (type: string, text: string): ArrayBuffer => {
  const payload = encoder.encode(text)
  const frame = new Uint8Array(36 + payload.byteLength)
  frame[0] = actionWireVersion
  frame[1] = 0
  frame.set(encoder.encode(type), 2)
  frame.set(payload, 36)
  return frame.buffer
}

const makeBulkOfferFrame = (
  type: string,
  transferId: number,
  size: number
): ArrayBuffer => {
  const frame = new Uint8Array(48)
  frame[0] = actionWireVersion
  frame[1] = 1 | (2 << 4)
  frame.set(encoder.encode(type), 2)
  const view = new DataView(frame.buffer)
  view.setUint32(36, transferId)
  view.setFloat64(40, size)
  return frame.buffer
}

const makeChunkFrame = (
  transferId: number,
  offset: number,
  length: number
): ArrayBuffer => {
  const frame = new Uint8Array(14 + length)
  frame[0] = actionWireVersion
  frame[1] = 2
  const view = new DataView(frame.buffer)
  view.setUint32(2, transferId)
  view.setFloat64(6, offset)
  frame.fill(9, 14)
  return frame.buffer
}

const makeCancelFrame = (transferId: number): ArrayBuffer => {
  const frame = new Uint8Array(6)
  frame[0] = actionWireVersion
  frame[1] = 5
  new DataView(frame.buffer).setUint32(2, transferId)
  return frame.buffer
}

void test('SubscriptionState: re-entrant clear() during replay detaches AbortSignal and never leaks zombie listeners', () => {
  const activeTransitions: boolean[] = []
  const [sub, emit, clear, hasListeners] = createEventEmitter<[number]>(
    'test',
    active => {
      activeTransitions.push(active)
    }
  )
  const ac = new AbortController()
  let abortListeners = 0
  const origAdd = ac.signal.addEventListener.bind(ac.signal)
  const origRem = ac.signal.removeEventListener.bind(ac.signal)
  ac.signal.addEventListener = ((t: string, l: never, o: never) => {
    if (t === 'abort') {
      abortListeners++
    }
    return origAdd(t, l, o)
  }) as typeof ac.signal.addEventListener
  ac.signal.removeEventListener = ((t: string, l: never, o: never) => {
    if (t === 'abort') {
      abortListeners--
    }
    return origRem(t, l, o)
  }) as typeof ac.signal.removeEventListener

  const seenMid: number[] = []
  sub(
    n => {
      seenMid.push(n)
      clear()
    },
    {replay: true, signal: ac.signal},
    () => [[1], [2], [3]]
  )
  assert.deepEqual(seenMid, [1])
  assert.equal(hasListeners(), false)
  assert.equal(abortListeners, 0)
  emit(99)
  assert.deepEqual(seenMid, [1])
  assert.deepEqual(activeTransitions, [])
})

void test('LeaseEntryState (R1): claimLeased is idempotent while peer is alive and returns false when dead or closed', async () => {
  const pool = createOfferManager(() => new MockPeer() as unknown as PeerHandle)
  const [leased] = await pool.checkout(1, true, async () => 'sdp-1')
  assert.ok(leased)
  assert.equal(pool.claimLeased(leased.peer), true)
  // Second claim (strategy offer.claim() followed by signal-handler claimLeasedOffer) must succeed
  assert.equal(pool.claimLeased(leased.peer), true)

  ;(leased.peer as unknown as MockPeer).isDead = true
  assert.equal(pool.claimLeased(leased.peer), false)

  const [leased2] = await pool.checkout(1, true, async () => 'sdp-2')
  pool.destroy()
  assert.equal(pool.claimLeased(leased2!.peer), false)
})

void test('Torrent OfferPoolState + LeaseEntryState (R1): in-process peers connect and exchange messages over mock tracker', async () => {
  type PeerSocketEntry = {socket: WebSocket; peerId: string}
  const swarm = new Map<string, Map<string, PeerSocketEntry>>()
  const wss = new WebSocketServer({port: 0, host: '127.0.0.1'})
  await once(wss, 'listening')
  const addr = wss.address()
  assert.ok(addr && typeof addr === 'object')

  wss.on('connection', socket => {
    socket.on('message', (raw, isBinary) => {
      void isBinary
      const text = Buffer.isBuffer(raw)
        ? raw.toString('utf8')
        : Array.isArray(raw)
          ? Buffer.concat(raw).toString('utf8')
          : Buffer.from(raw).toString('utf8')
      const msg = JSON.parse(text) as {
        action?: string
        info_hash?: string
        peer_id?: string
        to_peer_id?: string
        offer_id?: string
        offers?: Array<{offer_id: string; offer: {type: 'offer'; sdp: string}}>
        answer?: {type: 'answer'; sdp: string}
      }
      if (msg.action !== 'announce' || !msg.info_hash || !msg.peer_id) {
        return
      }
      let peers = swarm.get(msg.info_hash)
      if (!peers) {
        peers = new Map()
        swarm.set(msg.info_hash, peers)
      }
      peers.set(msg.peer_id, {socket, peerId: msg.peer_id})

      if (msg.answer && msg.to_peer_id && msg.offer_id) {
        const target = peers.get(msg.to_peer_id)
        if (target && target.socket.readyState === WebSocket.OPEN) {
          target.socket.send(
            JSON.stringify({
              action: 'announce',
              info_hash: msg.info_hash,
              peer_id: msg.peer_id,
              to_peer_id: msg.to_peer_id,
              offer_id: msg.offer_id,
              answer: msg.answer
            })
          )
        }
        return
      }

      if (Array.isArray(msg.offers)) {
        for (const [otherId, entry] of peers) {
          if (
            otherId !== msg.peer_id &&
            entry.socket.readyState === WebSocket.OPEN
          ) {
            const item = msg.offers[0]
            if (item) {
              entry.socket.send(
                JSON.stringify({
                  action: 'announce',
                  info_hash: msg.info_hash,
                  peer_id: msg.peer_id,
                  offer_id: item.offer_id,
                  offer: item.offer
                })
              )
            }
          }
        }
      }
    })
  })

  const peerBSpec = '../../packages/torrent/src/index.ts?peerB'
  const {joinRoom: joinTorrentRoomB, getRelaySockets: getTorrentRelaySocketsB} =
    (await import(peerBSpec)) as {
      joinRoom: typeof joinTorrentRoom
      getRelaySockets: typeof getTorrentRelaySockets
    }
  const trackerUrl = `ws://127.0.0.1:${addr.port}`
  const roomId = `r1-torrent-${Date.now()}`
  const cfg = {
    appId: 'r1-torrent-app',
    relayConfig: {urls: [trackerUrl], redundancy: 1},
    rtcPolyfill: WeriftRTCPeerConnection as unknown as typeof RTCPeerConnection
  }

  const roomA = joinTorrentRoom(cfg, roomId)
  const roomB = joinTorrentRoomB(cfg, roomId)
  try {
    const pingA = roomA.makeAction<string>('ping')
    const pingB = roomB.makeAction<string>('ping')
    const receivedOnB: string[] = []
    pingB.onMessage(payload => {
      receivedOnB.push(payload)
    })

    // Also verifies R14 synchronously inside onPeerJoin!
    roomA.onPeerJoin(({peerId}) => {
      void pingA.send('hello-over-torrent', {target: peerId})
    })

    await waitFor(() => receivedOnB.includes('hello-over-torrent'), 8_000)
    assert.deepEqual(receivedOnB, ['hello-over-torrent'])
  } finally {
    await Promise.all([roomA.leave(), roomB.leave()])
    await waitFor(
      () =>
        Object.keys(getTorrentRelaySockets()).length === 0 &&
        Object.keys(getTorrentRelaySocketsB()).length === 0
    )
    await new Promise<void>(resolve => wss.close(() => resolve()))
  }
})

void test('AuthorityBootstrapState & CertHighWaterMark (R2): stale signed certificate replay cannot resurrect revoked roles', async () => {
  const [rootUser, subjectUser] = await Promise.all([
    createUserIdentity(),
    createUserIdentity()
  ])
  const roomId = `r2-room~${rootUser.userId}`

  const issuer = createRoomAuthority({
    selfId: 'P0000000000000000001',
    appId: 'r2-app',
    initialRoomId: roomId,
    admin: {selfAsAdmin: true},
    getLocalUserIdentity: async () => rootUser
  })
  const verifier = createRoomAuthority({
    selfId: 'P0000000000000000002',
    appId: 'r2-app',
    initialRoomId: roomId,
    getLocalUserIdentity: async () => subjectUser
  })

  // C1 grants 'editor' (seq 1)
  const c1Editor = await issuer.issueRoleCertificate(
    subjectUser.userId,
    'editor'
  )
  // Revoke 'editor' on issuer, then grant 'viewer' -> C2 has only ['viewer'] (higher seq)
  await issuer.issueRoleRevocation(subjectUser.userId, 'editor')
  const c2Viewer = await issuer.issueRoleCertificate(
    subjectUser.userId,
    'viewer'
  )
  const revViewer = await issuer.issueRoleRevocation(
    subjectUser.userId,
    'viewer'
  )

  assert.equal(await verifier.verifyAndApplyCert(c2Viewer, 'peer-1'), true)
  assert.deepEqual(verifier.getPeerRoles(subjectUser.userId), ['viewer'])

  assert.equal(await verifier.verifyAndApplyRevocation(revViewer), true)
  assert.deepEqual(verifier.getPeerRoles(subjectUser.userId), [])

  // Replay older validly-signed C1[editor] -> MUST be rejected by per-subject cert high-water mark!
  assert.equal(await verifier.verifyAndApplyCert(c1Editor, 'peer-1'), false)
  assert.deepEqual(verifier.getPeerRoles(subjectUser.userId), [])
})

void test('AuthorityBootstrapState & SelfBanReportState: transient identity error recovers without sig failure and unban resets self-ban latch', async () => {
  const [rootUser, aliceUser, bobUser] = await Promise.all([
    createUserIdentity(),
    createUserIdentity(),
    createUserIdentity()
  ])
  const roomId = `auth-sm-room~${rootUser.userId}`
  let failIdentity = true
  let sigFailures = 0

  const flakyAuth = createRoomAuthority({
    selfId: 'P0000000000000000001',
    appId: 'auth-sm-app',
    initialRoomId: roomId,
    getLocalUserIdentity: async () => {
      if (failIdentity) {
        throw new Error('transient identity load error')
      }
      return aliceUser
    },
    onSignatureFailure: () => {
      sigFailures++
    }
  })

  const rootAuth = createRoomAuthority({
    selfId: 'P0000000000000000002',
    appId: 'auth-sm-app',
    initialRoomId: roomId,
    admin: {selfAsAdmin: true},
    getLocalUserIdentity: async () => rootUser
  })

  const cert = await rootAuth.issueRoleCertificate(bobUser.userId, 'speaker')
  assert.equal(await flakyAuth.verifyAndApplyCert(cert, 'peer-x'), false)
  assert.equal(sigFailures, 0)

  failIdentity = false
  assert.equal(await flakyAuth.verifyAndApplyCert(cert, 'peer-x'), true)
  assert.deepEqual(flakyAuth.getPeerRoles(bobUser.userId), ['speaker'])

  const pluginObj = roles({admins: [rootUser.userId]}) as unknown as {
    [k: symbol]: {setup: (k: unknown) => {provider: unknown; api: unknown}}
  }
  let onAuthMsg: ((raw: unknown, ctx: {peerId: string}) => void) | null = null
  const emittedErrors: unknown[] = []

  pluginObj[pluginSlotSymbol]!.setup({
    selfId: 'P0000000000000000009',
    appId: 'auth-sm-app',
    initialRoomId: roomId,
    password: '',
    getRoomId: () => roomId,
    setEffectiveRoomId: () => {},
    getLocalEndpointIdentity: () => createEndpointIdentity(),
    getLocalUserIdentity: async () => bobUser,
    getPeerUserId: (id: string) => id,
    getKnownPeerUserId: () => undefined,
    getUserPeerIds: () => [],
    setPeerUserId: () => {},
    getActivePeerIds: () => ['peer-keep'],
    getDirectActivePeerIds: () => ['peer-keep'],
    getAllPeerIds: () => ['peer-keep'],
    isPeerActive: () => true,
    getPeerHandle: () => undefined,
    kickPeer: () => {},
    emitError: (e: unknown) => {
      emittedErrors.push(e)
    },
    makeInternalAction: () => ({
      send: async () => {},
      onMessage: (fn: (raw: unknown, ctx: {peerId: string}) => void) => {
        onAuthMsg = fn
        return () => {}
      },
      onReceive: () => () => {},
      onReceiveProgress: () => () => {}
    }),
    deliverRawData: () => {},
    getRolesProvider: () => null,
    getScaleProvider: () => null,
    activateVirtualPeer: () => true,
    deactivateVirtualPeer: () => {},
    purgeBannedUserState: () => {},
    onRolesChanged: () => {},
    onPeerActivated: () => () => {},
    onPeerDeactivated: () => () => {},
    onRoomIdChanged: () => () => {},
    onLeave: () => () => {}
  })

  await wait(15)
  const ban1 = await rootAuth.issuePeerModeration('ban', bobUser.userId)
  const unban1 = await rootAuth.issuePeerModeration('unban', bobUser.userId)
  const ban2 = await rootAuth.issuePeerModeration('ban', bobUser.userId)

  onAuthMsg!({t: 'mod', moderation: ban1}, {peerId: 'peer-keep'})
  await wait(15)
  assert.equal(emittedErrors.length, 1)

  onAuthMsg!({t: 'mod', moderation: unban1}, {peerId: 'peer-keep'})
  await wait(15)
  onAuthMsg!({t: 'mod', moderation: ban2}, {peerId: 'peer-keep'})
  await wait(15)
  assert.equal(emittedErrors.length, 2)
})

void test('OutboundOfferState (R3 & R8): post-answer trickle-ICE candidates still relay and leaving during ensureOffer resets allocating', async () => {
  const selfId = 'A'.repeat(20)
  const remoteId = higherPeerId(selfId)
  const peerStates = new Map()
  const relayedSignals: string[] = []
  let leaving = false
  const offerPeer = new MockPeer()
  let pauseCheckout = false
  let releaseOffer: (() => void) | null = null

  const ctx: SignalContext = {
    appId: 'r3-app',
    getRoomId: () => 'r3-room',
    config: {appId: 'r3-app'} as BaseRoomConfig,
    peerStates,
    getRootTopicPlaintext: () => 'root',
    rootTopicP: Promise.resolve('root'),
    selfTopicP: Promise.resolve('self'),
    toPlain: async s => s,
    toCipher: async s => s,
    isLeaving: () => leaving,
    onError: undefined,
    checkoutOffers: (async () => {
      if (pauseCheckout) {
        await new Promise<void>(res => {
          releaseOffer = res
        })
        return []
      }
      return [
        {
          peer: offerPeer as unknown as PeerHandle,
          offer: 'enc-offer',
          offerId: 'offer-r3-1'
        }
      ]
    }) as OfferCheckoutFn,
    claimLeasedOffer: () => true,
    reclaimLeasedOffer: () => {},
    encryptOffer: async () => 'enc-offer',
    initPeer: () => new MockPeer() as unknown as PeerHandle,
    connectPeer: () => {},
    disconnectPeer: () => {},
    announceIntervals: [],
    announceIntervalMs: 5_000,
    getSelfIdNow: () => selfId,
    selfIdP: Promise.resolve(selfId)
  }

  const handler = createSignalHandler(ctx)
  const receive = handler.handleMessage(0)

  // 1. Announce triggers offer advertisement on relay 0
  await receive('root', {peerId: remoteId}, (_topic, msg) => {
    relayedSignals.push(msg)
  })
  assert.equal(relayedSignals.length, 1)

  // 2. Fast answer transitions outbound advertising -> answered BEFORE ICE finishes
  await receive(
    'self',
    {peerId: remoteId, offerId: 'offer-r3-1', answer: 'answer-sdp'},
    () => {}
  )
  assert.equal(peerStates.get(remoteId)?.outbound.phase, 'answered')

  // 3. Late local trickle-ICE candidate gathered while 'answered' MUST still be forwarded!
  offerPeer.handlers.signal?.({
    type: 'candidate',
    sdp: '{"candidate":"late-host"}'
  })
  await wait(15)
  assert.equal(
    relayedSignals.length,
    2,
    'expected post-answer trickle-ICE candidate to be relayed'
  )

  // 4. R8: ensureOffer resolving empty during leave resets 'allocating' to 'idle'
  pauseCheckout = true
  const remote2 = higherPeerId(remoteId)
  const p = receive('root', {peerId: remote2}, () => {})
  await waitFor(() => releaseOffer !== null)
  assert.equal(peerStates.get(remote2)?.outbound.phase, 'allocating')
  leaving = true
  releaseOffer!()
  await p
  await wait(5)
  assert.equal(peerStates.get(remote2)?.outbound.phase, 'idle')
})

void test('SignalHandler dialBackoff: responder counter-ping cooldown survives prunePeerStates', async () => {
  const selfId = 'Z'.repeat(20)
  const lowerRemote = lowerPeerId(selfId)
  const sentPings: string[] = []
  const peerStates = new Map()
  const sigHandler = createSignalHandler({
    appId: 'sig-sm-app',
    getRoomId: () => 'sig-sm-room',
    config: {appId: 'sig-sm-app'} as BaseRoomConfig,
    peerStates,
    getRootTopicPlaintext: () => 'root',
    rootTopicP: Promise.resolve('root'),
    selfTopicP: Promise.resolve('self'),
    toPlain: async s => s,
    toCipher: async s => s,
    isLeaving: () => false,
    onError: undefined,
    checkoutOffers: (async () => []) as OfferCheckoutFn,
    claimLeasedOffer: () => true,
    reclaimLeasedOffer: () => {},
    encryptOffer: async () => 'enc',
    initPeer: () => new MockPeer() as unknown as PeerHandle,
    connectPeer: () => {},
    disconnectPeer: () => {},
    announceIntervals: [],
    announceIntervalMs: 5_000,
    getSelfIdNow: () => selfId,
    selfIdP: Promise.resolve(selfId)
  })
  await sigHandler.handleMessage(0)('root', {peerId: selfId}, (_t, msg) =>
    sentPings.push(msg)
  )
  sigHandler.dialPeer(lowerRemote)
  await wait(10)
  assert.equal(sentPings.length, 1)
  prunePeerStates(peerStates)
  assert.equal(peerStates.size, 0)
  sigHandler.dialPeer(lowerRemote)
  await wait(10)
  assert.equal(sentPings.length, 1)
})

void test('AntiEntropyState (R5): pullId isolation, staleDigest repull, and strict maxPages bound', async t => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date']})
  const pulls: Array<[string, string | undefined]> = []
  const rejectBox: {fn: ((err: Error) => void) | null} = {fn: null}
  let callIdx = 0
  const connected = new Set(['p1', 'p2'])
  const ae = createAntiEntropySync({
    fanout: 1,
    pullTimeoutMs: 500,
    periodicIntervalMs: 0,
    maxPages: 3,
    getDirectPeers: () => [...connected],
    isPeerSendable: pid => connected.has(pid),
    sendPull: (pid, cursor) => {
      pulls.push([pid, cursor])
      callIdx++
      if (callIdx === 1) {
        return new Promise<void>((_res, rej) => {
          rejectBox.fn = rej
        })
      }
      return undefined
    }
  })

  ae.onPeerJoined('p1', true)
  await Promise.resolve()
  assert.equal(pulls.length, 1)

  connected.delete('p1')
  ae.onPeerDisconnected('p1')
  ae.onSyncPage('p2', undefined)
  connected.add('p1')
  ae.onPeerJoined('p1', true)
  await Promise.resolve()
  assert.equal(ae.isPullInFlight('p1'), true)
  rejectBox.fn?.(new Error('late failure from pull 1'))
  await Promise.resolve()
  assert.equal(ae.isPullInFlight('p1'), true)

  // R5: endless continuation cursors stop strictly once pages reaches maxPages (3)
  ae.onSyncPage('p1', 'c1')
  ae.onSyncPage('p1', 'c2')
  ae.onSyncPage('p1', 'c3')
  ae.onSyncPage('p1', 'c4')
  assert.equal(ae.isPullInFlight('p1'), false)
  ae.destroy()
})

void test('OutboundRequestWaiterState (R6): aborting request across macrotasks during getLocalActionCert produces zero unhandledRejection', async () => {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason)
  }
  process.on('unhandledRejection', onUnhandled)

  try {
    let releaseCert!: () => void
    const mgr = createActionManager({
      onPeerError: () => {},
      getTransport: () => ({
        isOpen: true,
        bufferedAmount: 0,
        sendFrame: () => {},
        waitForDrain: () => true
      }),
      getPeerIds: () => ['peer-b'],
      canReceiveFromPeer: () => true,
      registerActionAuthority: () => {},
      getLocalActionCert: () =>
        new Promise(res => {
          releaseCert = () => res(null)
        })
    })

    const reqAction = mgr.makeAction<string, string>('r6-req', {
      kind: 'request',
      roles: 'admin'
    })
    const ac = new AbortController()
    const reqPromise = reqAction.request('hi', {
      target: 'peer-b',
      signal: ac.signal
    })

    // Abort in a separate macrotask BEFORE attaching catch/await on reqPromise
    await new Promise<void>(r => setTimeout(r, 5))
    ac.abort()
    await new Promise<void>(r => setTimeout(r, 10))
    releaseCert()

    await assert.rejects(reqPromise, {name: 'AbortError'})
    await new Promise<void>(r => setTimeout(r, 10))
    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

void test('Nostr BatchSyncState + flushTimer (R7): CLOSED retry during batch flush never resolves subscribe before REQ is written', async t => {
  const frames: string[][] = []
  let serverSocket: WebSocket | null = null
  const wss = new WebSocketServer({port: 0, host: '127.0.0.1'})
  await once(wss, 'listening')
  const addr = wss.address()
  assert.ok(addr && typeof addr === 'object')

  wss.on('connection', socket => {
    serverSocket = socket
    socket.on('message', raw => {
      const text = Buffer.isBuffer(raw)
        ? raw.toString('utf8')
        : Array.isArray(raw)
          ? Buffer.concat(raw).toString('utf8')
          : Buffer.from(raw).toString('utf8')
      const parsed = JSON.parse(text) as string[]
      frames.push(parsed)
      if (parsed[0] === 'REQ') {
        socket.send(JSON.stringify(['EOSE', parsed[1]]))
      }
    })
  })

  const relayUrl = `ws://127.0.0.1:${addr.port}`
  const room1 = joinNostrRoom(
    {
      appId: 'r7-nostr-app',
      relayConfig: {urls: [relayUrl], redundancy: 1, warnOnRelayFailure: false},
      rtcPolyfill: MockRTCPeerConnection as unknown as typeof RTCPeerConnection
    },
    `r7-room-1-${Date.now()}`
  )

  const originalSetTimeout = globalThis.setTimeout
  const pendingFlushes: Array<() => void> = []
  let room2: ReturnType<typeof joinNostrRoom> | undefined

  try {
    // 1. Wait for room1 to install subId on the relay and publish its initial EVENT
    await waitFor(
      () =>
        frames.some(f => f[0] === 'REQ') && frames.some(f => f[0] === 'EVENT'),
      3_000
    )
    const subId1 = frames.find(f => f[0] === 'REQ')![1]!

    // 2. Hold 0ms flush timer while room2 joins on the shared client
    const timerMock = t.mock.method(globalThis, 'setTimeout', ((
      fn: (...args: unknown[]) => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      if (ms === 0) {
        pendingFlushes.push(() => fn(...args))
        return originalSetTimeout(() => {}, 0)
      }
      return originalSetTimeout(fn, ms, ...args)
    }) as unknown as typeof setTimeout)

    room2 = joinNostrRoom(
      {
        appId: 'r7-nostr-app',
        relayConfig: {
          urls: [relayUrl],
          redundancy: 1,
          warnOnRelayFailure: false
        },
        rtcPolyfill:
          MockRTCPeerConnection as unknown as typeof RTCPeerConnection
      },
      `r7-room-2-${Date.now()}`
    )
    await waitFor(() => pendingFlushes.length > 0, 2_000)

    // 3. Deliver CLOSED for the active subId inside room2's flush-scheduled window!
    serverSocket!.send(JSON.stringify(['CLOSED', subId1, 'error: busy']))
    await wait(30)

    // CLOSED must NOT prematurely resolve waitForBatchFlush or allow room2 to announce
    assert.equal(
      frames.filter(f => f[0] === 'EVENT').length,
      1,
      'room2 must not publish EVENT before its REQ batch flushes'
    )

    // 4. Release the 0ms flush -> REQ #2 must be written BEFORE room2's EVENT
    timerMock.mock.restore()
    pendingFlushes.splice(0).forEach(fn => fn())

    await waitFor(() => frames.filter(f => f[0] === 'EVENT').length >= 2, 2_000)
    assert.equal(
      frames.filter(f => f[0] === 'REQ').length,
      2,
      'CLOSED retry must not cancel the scheduled REQ flush'
    )
    const secondReqIdx = frames.findLastIndex(f => f[0] === 'REQ')
    const secondEventIdx = frames.findLastIndex(f => f[0] === 'EVENT')
    assert.ok(
      secondReqIdx < secondEventIdx,
      'room2 REQ must precede room2 EVENT'
    )
  } finally {
    pendingFlushes.splice(0).forEach(fn => fn())
    await room1.leave()
    await room2?.leave()
    await new Promise<void>(resolve => wss.close(() => resolve()))
  }
})

void test('OverlayRouter VirtualPeerState & hadRoutePeers (R9 & R18): crashed direct-only neighbor is evicted and disconnect causes zero spurious virtual flap', async () => {
  const [epSelf, epNeighbor, epCrashed] = await Promise.all([
    createEndpointIdentity(),
    createEndpointIdentity(),
    createEndpointIdentity()
  ])
  const virtualJoins: string[] = []
  const virtualLeaves: string[] = []

  const mgr = createOverlayManager({
    selfId: epSelf.peerId,
    appId: 'r9-app',
    roomId: 'r9-room',
    getLocalEndpointIdentity: () => epSelf,
    onVirtualPeerJoin: peerId => {
      virtualJoins.push(peerId)
      return true
    },
    onVirtualPeerLeave: peerId => {
      virtualLeaves.push(peerId)
    },
    onDeliverData: () => {}
  })

  const neighborHandle = new MockPeer() as unknown as PeerHandle
  const crashedHandle = new MockPeer() as unknown as PeerHandle
  mgr.addDirectPeer(epNeighbor.peerId, neighborHandle)
  mgr.addDirectPeer(epCrashed.peerId, crashedHandle)

  const signDesc = async (
    ep: Awaited<ReturnType<typeof createEndpointIdentity>>,
    seq: number,
    neighbors: string[]
  ) =>
    signPeerDescriptor(
      {
        peerId: ep.peerId,
        seq,
        neighbors,
        signPubKey: jwkToCompactPub(ep.signPubJwk),
        encPubKey: jwkToCompactPub(ep.signPubJwk)
      },
      {
        peerId: ep.peerId,
        signPrivateKey: ep.signPrivateKey,
        signPubKey: jwkToCompactPub(ep.signPubJwk),
        encPrivateKey: ep.signPrivateKey,
        encPubKey: jwkToCompactPub(ep.signPubJwk)
      },
      'r9-app',
      'r9-room',
      '',
      null
    )

  const dNeighbor1 = await signDesc(epNeighbor, 1, [
    epSelf.peerId,
    epCrashed.peerId
  ])
  const dCrashed1 = await signDesc(epCrashed, 1, [
    epSelf.peerId,
    epNeighbor.peerId
  ])
  mgr.handleFrame(
    epNeighbor.peerId,
    packOverlayControl({
      t: 'gossip',
      descriptors: [dNeighbor1, dCrashed1]
    }).slice().buffer
  )
  await wait(25)

  // R18: unexpected direct disconnect of epCrashed must NOT synchronously emit onVirtualPeerJoin!
  mgr.removeDirectPeer(epCrashed.peerId, crashedHandle)
  assert.deepEqual(virtualJoins, [])
  assert.deepEqual(virtualLeaves, [])

  // R9: if an indirect peer's confirmed neighbor drops it, it is evicted immediately without lingering 180s
  const epRemote = await createEndpointIdentity()
  const dRemote1 = await signDesc(epRemote, 1, [epNeighbor.peerId])
  const dNeighbor2 = await signDesc(epNeighbor, 2, [
    epSelf.peerId,
    epRemote.peerId
  ])
  mgr.handleFrame(
    epNeighbor.peerId,
    packOverlayControl({
      t: 'gossip',
      descriptors: [dRemote1, dNeighbor2]
    }).slice().buffer
  )
  await wait(25)
  assert.deepEqual(virtualJoins, [epRemote.peerId])

  // Neighbor drops epRemote in seq 3 -> epRemote's only confirmed neighbor dropped it -> immediate eviction!
  const dNeighbor3 = await signDesc(epNeighbor, 3, [epSelf.peerId])
  mgr.handleFrame(
    epNeighbor.peerId,
    packOverlayControl({t: 'gossip', descriptors: [dNeighbor3]}).slice().buffer
  )
  await wait(25)
  assert.deepEqual(virtualLeaves, [epRemote.peerId])
  assert.equal(mgr.isVirtualPeer(epRemote.peerId), false)

  // A2 structural grace-timer cancellation: a virtual peer whose route drops (starting grace)
  // and upgrades to direct before grace expires must cancel its grace timer and never fire leave!
  const graceLeaves: string[] = []
  const graceMgr = createOverlayManager({
    selfId: epSelf.peerId,
    appId: 'r9-app',
    roomId: 'r9-room',
    unreachableGraceMs: 40,
    getLocalEndpointIdentity: () => epSelf,
    onVirtualPeerJoin: () => true,
    onVirtualPeerLeave: peerId => {
      graceLeaves.push(peerId)
    },
    onDeliverData: () => {}
  })
  const relayH = new MockPeer() as unknown as PeerHandle
  graceMgr.addDirectPeer(epNeighbor.peerId, relayH)
  graceMgr.handleFrame(
    epNeighbor.peerId,
    packOverlayControl({
      t: 'gossip',
      descriptors: [dRemote1, dNeighbor2]
    }).slice().buffer
  )
  await wait(20)
  assert.equal(graceMgr.isVirtualPeer(epRemote.peerId), true)
  // Relay disconnects -> epRemote loses route and enters 40ms unreachable grace
  graceMgr.removeDirectPeer(epNeighbor.peerId, relayH)
  // Before grace expires, epRemote connects directly -> setPeer clears grace timer structurally
  graceMgr.addDirectPeer(
    epRemote.peerId,
    new MockPeer() as unknown as PeerHandle
  )
  await wait(70)
  assert.deepEqual(graceLeaves, [])
  assert.equal(graceMgr.isDirectPeer(epRemote.peerId), true)
  graceMgr.destroy()
  mgr.destroy()
})

void test('Identity & IDB (R10): transient IndexedDB failure retries on next join instead of sticky ephemeral fallback', async () => {
  const globals = globalThis as Record<string, unknown>
  const prevWindow = globals['window']
  const prevIdb = globals['indexedDB']
  const store = new Map<string, unknown>()
  let failOpen = true

  globals['window'] = globalThis
  globals['indexedDB'] = {
    open: () => {
      const req: {
        result: unknown
        error?: Error
        onsuccess?: () => void
        onerror?: () => void
      } = {result: null}
      queueMicrotask(() => {
        if (failOpen) {
          req.error = new Error('transient IDB lock error')
          req.onerror?.()
          return
        }
        req.result = {
          objectStoreNames: {contains: () => true},
          close: () => {},
          transaction: () => {
            const tx: {oncomplete?: () => void; objectStore: () => unknown} = {
              objectStore: () => ({
                get: (k: string) => {
                  const r: {result: unknown; onsuccess?: () => void} = {
                    result: store.get(k)
                  }
                  queueMicrotask(() => r.onsuccess?.())
                  return r
                },
                add: (v: unknown, k: string) => {
                  store.set(k, v)
                  const r: {onsuccess?: () => void} = {}
                  queueMicrotask(() => {
                    r.onsuccess?.()
                    tx.oncomplete?.()
                  })
                  return r
                },
                put: (v: unknown, k: string) => {
                  store.set(k, v)
                  const r: {onsuccess?: () => void} = {}
                  queueMicrotask(() => {
                    r.onsuccess?.()
                    tx.oncomplete?.()
                  })
                  return r
                }
              })
            }
            return tx
          }
        }
        req.onsuccess?.()
      })
      return req
    }
  }

  try {
    const first = await resolveUserIdentity('r10-app', 'room-1', {
      identity: 'local'
    })
    assert.equal(first.persistence, 'none')

    // Next join when IDB recovers MUST retry IDB and persist as 'local'!
    failOpen = false
    const second = await resolveUserIdentity('r10-app', 'room-2', {
      identity: 'local'
    })
    assert.equal(second.persistence, 'local')

    // Also verify unstaged IDB write rejects cleanly
    globals['indexedDB'] = {
      open: () => {
        const req: {result: unknown; onsuccess?: () => void} = {
          result: {
            objectStoreNames: {contains: () => true},
            close: () => {},
            transaction: (_n: string, mode: string) => {
              const tx: {oncomplete?: () => void; objectStore: () => unknown} =
                {
                  objectStore: () => ({
                    get: () => {
                      const r: {result: unknown; onsuccess?: () => void} = {
                        result: undefined
                      }
                      if (mode === 'readonly') {
                        queueMicrotask(() => r.onsuccess?.())
                      } else {
                        queueMicrotask(() => tx.oncomplete?.())
                      }
                      return r
                    },
                    add: () => ({})
                  })
                }
              return tx
            }
          }
        }
        queueMicrotask(() => req.onsuccess?.())
        return req
      }
    }
    const dummyId = await createUserIdentity()
    const pair = await crypto.subtle.generateKey(
      {name: 'ECDSA', namedCurve: 'P-256'},
      false,
      ['sign', 'verify']
    )
    await assert.rejects(
      () =>
        loadOrCreateIdbIdentity(
          'broken-tx-app',
          async () => ({
            userId: dummyId.userId,
            signPubJwk: dummyId.signPubJwk,
            privateKey: pair.privateKey
          }),
          verifyUserIdKey,
          verifyWithP256
        ),
      /IndexedDB add failed/
    )
  } finally {
    if (prevWindow === undefined) {
      delete globals['window']
    } else {
      globals['window'] = prevWindow
    }
    if (prevIdb === undefined) {
      delete globals['indexedDB']
    } else {
      globals['indexedDB'] = prevIdb
    }
  }
})

void test('Identity clearUserIdentity epoch: concurrent clearUserIdentity invalidates in-flight load', async () => {
  const globals = globalThis as Record<string, unknown>
  const prevIdb = globals['indexedDB']
  const idbMap = new Map<string, {userId: string}>()
  let notifyFirstOpen!: () => void
  const firstOpenEntered = new Promise<void>(r => {
    notifyFirstOpen = r
  })
  const releaseBox: {fn: (() => void) | null} = {fn: null}
  let openCount = 0

  globals['indexedDB'] = {
    open: () => {
      openCount++
      const isFirst = openCount === 1
      const req: {result: unknown; onsuccess?: () => void} = {
        result: {
          objectStoreNames: {contains: () => true},
          close: () => {},
          transaction: () => {
            const tx: {oncomplete?: () => void; objectStore: () => unknown} = {
              objectStore: () => ({
                get: (k: string) => {
                  const r: {result: unknown; onsuccess?: () => void} = {
                    result: idbMap.get(k)
                  }
                  queueMicrotask(() => r.onsuccess?.())
                  return r
                },
                add: (v: {userId: string}, k: string) => {
                  idbMap.set(k, v)
                  queueMicrotask(() => tx.oncomplete?.())
                  return {}
                },
                put: (v: {userId: string}, k: string) => {
                  idbMap.set(k, v)
                  queueMicrotask(() => tx.oncomplete?.())
                  return {}
                },
                delete: (k: string) => {
                  idbMap.delete(k)
                  queueMicrotask(() => tx.oncomplete?.())
                  return {}
                }
              })
            }
            return tx
          }
        }
      }
      if (isFirst) {
        releaseBox.fn = () => req.onsuccess?.()
        notifyFirstOpen()
      } else {
        queueMicrotask(() => req.onsuccess?.())
      }
      return req
    }
  }

  try {
    const loadP = resolveUserIdentity('race-clear-sm-app', 'r1', {
      identity: 'local'
    })
    await firstOpenEntered
    const clearP = clearUserIdentity('race-clear-sm-app')
    releaseBox.fn?.()
    const [resolvedAfterClear] = await Promise.all([loadP, clearP])
    assert.equal(
      idbMap.get('race-clear-sm-app')?.userId,
      resolvedAfterClear.userId
    )
  } finally {
    globals['indexedDB'] = prevIdb
  }
})

void test('StateManager SlotFlushState (R11): pending set() resolves cleanly on destroy/leave, pace-wakeup flushes handshake, and onlineEpoch drops stale user records', async () => {
  const [uA, uB, epA, epB] = await Promise.all([
    createUserIdentity(),
    createUserIdentity(),
    createEndpointIdentity(),
    createEndpointIdentity()
  ])
  const appId = 'state-sm-app'
  const roomId = 'state-sm-room'

  // R11: pending set() at destroy() / room.leave() resolves cleanly without rejecting with roomLeftErr!
  const hungMgr = createStateManager({
    appId,
    getRoomId: () => roomId,
    getSelfId: () => epA.peerId,
    getLocalUserId: () => uA.userId,
    ensureReady: () => new Promise(() => {}),
    hasRolesPlugin: () => false,
    getRolesProvider: () => null,
    isPeerActive: () => true,
    isDirectPeer: () => false,
    getDirectPeerIds: () => [],
    isUserOnline: () => true,
    getKnownPeerUserId: () => undefined,
    isPeerBanned: () => false,
    getPeerRoles: () => []
  })
  const hungUserSlot = hungMgr.makeUserState('u', 0)
  const pendingSet = hungUserSlot.set(42)
  assert.deepEqual(hungUserSlot.getAll(), {[uA.userId]: 42})
  hungMgr.destroy()
  await assert.doesNotReject(() => pendingSet)
  assert.deepEqual(hungUserSlot.getAll(), {})

  // Pace-wakeup on prepareHandshakeReady includes latest value
  let pendingHsPeer = true
  const paceMgr = createStateManager({
    appId,
    getRoomId: () => roomId,
    getSelfId: () => epA.peerId,
    getLocalUserId: () => uA.userId,
    ensureReady: async () => ({selfId: epA.peerId, user: uA, roomId}),
    hasRolesPlugin: () => false,
    getRolesProvider: () => null,
    isPeerActive: () => false,
    isPeerPendingHandshake: () => pendingHsPeer,
    isDirectPeer: () => false,
    getDirectPeerIds: () => [],
    isUserOnline: () => true,
    getKnownPeerUserId: () => uB.userId,
    isPeerBanned: () => false,
    getPeerRoles: () => []
  })
  const nick = paceMgr.makeUserState('nick', '')
  await nick.set('v1')
  const v2Promise = nick.set('v2')
  const hsPayload = await paceMgr.prepareHandshakeReady(epB.peerId)
  await v2Promise
  assert.ok(hsPayload)
  assert.equal((hsPayload.r[0] as {val: string}).val, 'v2')
  pendingHsPeer = false
  paceMgr.destroy()

  // onlineEpoch drops stale pre-leave records on rapid rejoin
  let handlerB:
    | ((raw: unknown, ctx: {peerId: string; userId: string}) => void)
    | null = null
  let bobOnline = true
  const readerMgr = createStateManager({
    appId,
    getRoomId: () => roomId,
    getSelfId: () => epB.peerId,
    getLocalUserId: () => uB.userId,
    ensureReady: async () => ({selfId: epB.peerId, user: uB, roomId}),
    hasRolesPlugin: () => false,
    getRolesProvider: () => null,
    isPeerActive: () => true,
    isDirectPeer: () => true,
    getDirectPeerIds: () => [epA.peerId],
    isUserOnline: uid => (uid === uA.userId ? bobOnline : true),
    getKnownPeerUserId: () => uA.userId,
    isPeerBanned: () => false,
    getPeerRoles: () => [],
    makeInternalAction: (() => ({
      send: async () => {},
      onMessage: (
        fn: (raw: unknown, ctx: {peerId: string; userId: string}) => void
      ) => {
        handlerB = fn
        return () => {}
      },
      onReceive: () => () => {},
      onReceiveProgress: () => () => {}
    })) as never
  })
  const presenceSlot = readerMgr.makeUserState('bio', 'empty')
  readerMgr.setUserPresence(uA.userId, true)
  readerMgr.onPeerJoined(epA.peerId, uA.userId, true)
  const staleRec = await signStateRecord(uA.sign, uA.signPubJwk, {
    kind: 'u',
    appId,
    roomId,
    ns: 'bio',
    hlc: [Date.now() + 5_000, 0],
    peerId: epA.peerId,
    userId: uA.userId,
    val: 'stale-before-leave'
  })
  const {appId: _a, roomId: _r, ...wireStale} = staleRec
  void _a
  void _r
  handlerB!({t: 'rec', r: wireStale}, {peerId: epA.peerId, userId: uA.userId})
  await Promise.resolve()
  bobOnline = false
  readerMgr.setUserPresence(uA.userId, false)
  readerMgr.onUserLeft(uA.userId)
  await wait(20)
  bobOnline = true
  readerMgr.setUserPresence(uA.userId, true)
  readerMgr.onPeerJoined(epA.peerId, uA.userId, true)
  assert.equal(presenceSlot.has(uA.userId), false)

  // A6 idempotent setUserPresence(true): a second peer joining for an already-online user
  // must NOT bump onlineEpoch or drop an in-flight record!
  const liveRec = await signStateRecord(uA.sign, uA.signPubJwk, {
    kind: 'u',
    appId,
    roomId,
    ns: 'bio',
    hlc: [Date.now() + 6_000, 0],
    peerId: epA.peerId,
    userId: uA.userId,
    val: 'multi-device-online'
  })
  const {appId: _a2, roomId: _r2, ...wireLive} = liveRec
  void _a2
  void _r2
  handlerB!({t: 'rec', r: wireLive}, {peerId: epA.peerId, userId: uA.userId})
  readerMgr.setUserPresence(uA.userId, true)
  readerMgr.onPeerJoined('second-device-peer', uA.userId, true)
  await wait(20)
  assert.equal(presenceSlot.get(uA.userId), 'multi-device-online')
  readerMgr.destroy()
})

void test('RelaySubscriptionState (R12): leave() during pending subscribe and subscribe throw release all relay socket leases', async () => {
  // 1. leave() enters leaving-flush (scale() active) so isLeavingOrLeft() flips BEFORE stopRelays();
  //    subscribe() resolving during that window must still release its relay lease!
  let releasedPart1 = 0
  let subscribeEntered = false
  let finishSubscribe1!: () => void
  const pool1 = createRelayManager<{id: number; closed: boolean}>(
    () => undefined,
    item => {
      item.closed = true
      releasedPart1++
    },
    item => item.closed
  )
  const joinFlushLeave = createStrategy({
    init: () => {
      const item = pool1.register('wss://r12-part1.invalid', () => ({
        id: 1,
        closed: false
      }))
      return [pool1.lease(item, Promise.resolve(item))]
    },
    subscribe: async () => {
      subscribeEntered = true
      await new Promise<void>(r => {
        finishSubscribe1 = r
      })
      return () => {}
    },
    announce: async () => ({stopAnnouncing: true})
  })

  const r1 = joinFlushLeave(
    {
      appId: 'r12-flush-app',
      use: [scale()],
      rtcPolyfill: MockRTCPeerConnection as unknown as typeof RTCPeerConnection
    },
    'r12-room-1'
  )
  await waitFor(() => subscribeEntered)
  // Start leave() -> enters leaving-flush (isLeavingOrLeft() === true while relaysStopped === false)
  const leave1P = r1.leave()
  finishSubscribe1()
  await leave1P
  assert.equal(
    releasedPart1,
    1,
    'subscribe settling during leaving-flush must release its relay lease'
  )

  // 2. Multi-relay strategy where relay 1 throws in subscribe() AFTER relay 2 is already 'healthy'
  let releasedCount = 0
  let relay2Subscribed = false
  let rejectRelay1!: (err: Error) => void
  const pool2 = createRelayManager<{id: number; closed: boolean}>(
    () => undefined,
    item => {
      item.closed = true
      releasedCount++
    },
    item => item.closed
  )
  const joinFailingSubscribe = createStrategy({
    init: () =>
      [1, 2].map(id => {
        const item = pool2.register(`wss://r12-${id}.invalid`, () => ({
          id,
          closed: false
        }))
        return pool2.lease(item, Promise.resolve(item))
      }),
    subscribe: async item => {
      if (item.id === 1) {
        await new Promise<void>((_res, rej) => {
          rejectRelay1 = rej
        })
      }
      relay2Subscribed = true
      return () => {}
    },
    announce: async () => ({stopAnnouncing: true})
  })

  const r2 = joinFailingSubscribe(
    {
      appId: 'r12-fail-sub',
      rtcPolyfill: MockRTCPeerConnection as unknown as typeof RTCPeerConnection
    },
    'r12-room-2'
  )
  await waitFor(() => relay2Subscribed && typeof rejectRelay1 === 'function')
  await wait(5)
  rejectRelay1(new Error('subscribe rejected after sibling relay healthy'))
  await wait(10)
  await r2.leave()
  assert.equal(releasedCount, 2, 'both relay leases must be released')
})

void test('ConnectivitySupervisorState (R13): navigator.onLine === false does not park sockets and online -> auto keeps sockets open', async () => {
  const relay = createWsRelayServer({port: 0, host: '127.0.0.1'})
  await relay.ready
  const addr = relay.address()
  assert.ok(addr && typeof addr === 'object')
  const url = `ws://127.0.0.1:${addr.port}`

  const origNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const origAddListener = Object.getOwnPropertyDescriptor(
    globalThis,
    'addEventListener'
  )
  const origRemoveListener = Object.getOwnPropertyDescriptor(
    globalThis,
    'removeEventListener'
  )
  const windowTarget = new EventTarget()
  Object.defineProperty(globalThis, 'navigator', {
    value: {onLine: false},
    configurable: true
  })
  Object.defineProperty(globalThis, 'addEventListener', {
    value: windowTarget.addEventListener.bind(windowTarget),
    configurable: true
  })
  Object.defineProperty(globalThis, 'removeEventListener', {
    value: windowTarget.removeEventListener.bind(windowTarget),
    configurable: true
  })

  try {
    // Force watcher re-attachment from a non-auto mode while navigator.onLine === false
    setRelayConnectivity('offline')
    setRelayConnectivity('auto')
    const room = joinWsRelayRoom(
      {
        appId: 'r13-app',
        relayConfig: {urls: [url]},
        rtcPolyfill:
          MockRTCPeerConnection as unknown as typeof RTCPeerConnection
      },
      'r13-room'
    )
    await waitFor(() => relay.getSubscriberCount() > 0, 1_500)

    const sockBefore = getWsRelaySockets()[url]
    assert.ok(sockBefore)
    setRelayConnectivity('online')
    setRelayConnectivity('auto')
    // Switching 'online' -> 'auto' while navigator.onLine === false must NOT close open sockets!
    assert.equal(getWsRelaySockets()[url], sockBefore)
    assert.equal(sockBefore.readyState, WebSocket.OPEN)

    await room.leave()
  } finally {
    setRelayConnectivity('offline')
    if (origNavigator) {
      Object.defineProperty(globalThis, 'navigator', origNavigator)
    } else {
      delete (globalThis as Record<string, unknown>)['navigator']
    }
    if (origAddListener) {
      Object.defineProperty(globalThis, 'addEventListener', origAddListener)
    } else {
      delete (globalThis as Record<string, unknown>)['addEventListener']
    }
    if (origRemoveListener) {
      Object.defineProperty(
        globalThis,
        'removeEventListener',
        origRemoveListener
      )
    } else {
      delete (globalThis as Record<string, unknown>)['removeEventListener']
    }
    setRelayConnectivity('auto')
    await relay.close()
  }
})

void test('PeerHandshakeState (R14 & R16): sendHandshakeReady precedes onActivate and post-active send failure calls onFailure', async () => {
  const selfIdA = 'A'.repeat(20)
  const selfIdB = 'B'.repeat(20)
  const {peerA, peerB} = createLinkedHandlePair()
  const eventsB: string[] = []
  const errorsB: string[] = []
  let rejectReadySendB!: (err: Error) => void

  const hsA: ReturnType<typeof createHandshakeManager> = createHandshakeManager(
    {
      selfIdP: Promise.resolve(selfIdA),
      onPeerHandshake: async () => {},
      deferResponderReady: true,
      sendHandshakeData: async (data, _peerId, meta) => {
        queueMicrotask(() => hsB.receiveData(data, selfIdA, meta))
      },
      sendHandshakeReady: async () => {
        queueMicrotask(() => hsB.receiveReady(selfIdA))
      },
      onLocalHandshakePassed: () => true,
      acquireAdmissionSlot: () => true,
      beforeSendHandshakeReady: () => undefined,
      onActivate: () => {},
      onFailure: () => {}
    }
  )

  const hsB: ReturnType<typeof createHandshakeManager> = createHandshakeManager(
    {
      selfIdP: Promise.resolve(selfIdB),
      onPeerHandshake: async () => {},
      deferResponderReady: true,
      sendHandshakeData: async (data, _peerId, meta) => {
        queueMicrotask(() => hsA.receiveData(data, selfIdB, meta))
      },
      sendHandshakeReady: () => {
        eventsB.push('sendHandshakeReady')
        queueMicrotask(() => hsA.receiveReady(selfIdB))
        return new Promise<void>((_res, rej) => {
          rejectReadySendB = rej
        })
      },
      onLocalHandshakePassed: () => true,
      acquireAdmissionSlot: () => true,
      beforeSendHandshakeReady: async () => ({ok: true, p: {}, r: []}),
      onActivate: () => {
        eventsB.push('onActivate')
      },
      onFailure: (_id, _peer, err) => {
        errorsB.push(err.message)
      }
    }
  )

  hsA.addPeer(selfIdB, peerA)
  hsB.addPeer(selfIdA, peerB)
  hsA.start(selfIdB, peerA)
  hsB.start(selfIdA, peerB)

  await waitFor(() => eventsB.includes('onActivate'))
  // R14: sendHandshakeReady MUST be invoked synchronously BEFORE onActivate!
  assert.deepEqual(eventsB, ['sendHandshakeReady', 'onActivate'])

  // R16: if sendHandshakeReady rejects after entering 'active', onFailure MUST still fire!
  rejectReadySendB(new Error('ready frame transport failed'))
  await wait(15)
  assert.equal(errorsB.length, 1)
  assert.match(errorsB[0]!, /ready frame transport failed/)
})

void test('PeerLifecycleState & CandidateFlush (R15): mid-flush remote trickle-ICE candidate is applied and pc.close() runs once', async () => {
  const appliedCandidates: string[] = []
  let releaseFirstAdd!: () => void
  let createdChannel: MockDataChannel | null = null
  let closeCalls = 0

  class CandidatePc extends MockRTCPeerConnection {
    override createDataChannel() {
      createdChannel = new MockDataChannel()
      return createdChannel
    }

    async addIceCandidate(cand: RTCIceCandidateInit) {
      const c = cand.candidate ?? ''
      if (appliedCandidates.length === 0) {
        await new Promise<void>(r => {
          releaseFirstAdd = r
        })
      }
      appliedCandidates.push(c)
    }

    override close() {
      closeCalls++
      super.close()
    }
  }

  const peer = initPeer(true, {
    appId: 'r15-app',
    rtcPolyfill: CandidatePc as unknown as typeof RTCPeerConnection
  })
  await peer.getOffer()

  // Queue c1 before remoteDescription is set
  await peer.signal({
    type: 'candidate',
    sdp: JSON.stringify({candidate: 'c1', sdpMLineIndex: 0})
  })

  // Start answer -> triggers flushPendingRemoteCandidates, pausing inside addIceCandidate('c1')
  const answerPromise = peer.signal({
    type: 'answer',
    sdp: 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n'
  })
  await waitFor(() => Boolean(releaseFirstAdd))

  // Arrive mid-flush -> c2 MUST be drained before flush completes (not stranded)!
  const c2Promise = peer.signal({
    type: 'candidate',
    sdp: JSON.stringify({candidate: 'c2', sdpMLineIndex: 0})
  })
  releaseFirstAdd()
  await Promise.all([answerPromise, c2Promise])
  assert.deepEqual(appliedCandidates, ['c1', 'c2'])

  createdChannel!.close()
  assert.equal(peer.isDead, true)
  peer.destroy()
  peer.destroy()
  assert.equal(closeCalls, 1)
})

void test('OverlayDataPlane (R17): capacity-full node still relays valid broadcasts to downstream neighbors', async () => {
  const [epOrigin, epHub, epDownstream] = await Promise.all([
    createEndpointIdentity(),
    createEndpointIdentity(),
    createEndpointIdentity()
  ])
  const forwardedToDownstream: Uint8Array[] = []
  const localDeliveries: ArrayBuffer[] = []

  const hubMgr = createOverlayManager({
    selfId: epHub.peerId,
    appId: 'r17-app',
    roomId: 'r17-room',
    getLocalEndpointIdentity: () => epHub,
    // Simulate local room capacity full (rejects virtual peer admission!)
    onVirtualPeerJoin: () => false,
    onVirtualPeerLeave: () => {},
    onDeliverData: (_origin, buf) => {
      localDeliveries.push(buf)
    }
  })

  const upstreamHandle = new MockPeer() as unknown as PeerHandle
  const downstreamMock = new MockPeer() as unknown as PeerHandle
  downstreamMock.sendData = frame => {
    forwardedToDownstream.push(
      frame instanceof Uint8Array
        ? frame.slice()
        : new Uint8Array(frame as ArrayBufferLike).slice()
    )
  }
  hubMgr.addDirectPeer(epOrigin.peerId, upstreamHandle)
  // Replace epOrigin with an intermediate relay so epOrigin is a virtual 2-hop peer!
  hubMgr.removeDirectPeer(epOrigin.peerId, upstreamHandle)

  const epRelay = await createEndpointIdentity()
  hubMgr.addDirectPeer(epRelay.peerId, upstreamHandle)
  hubMgr.addDirectPeer(epDownstream.peerId, downstreamMock)

  const descOrigin = await signPeerDescriptor(
    {
      peerId: epOrigin.peerId,
      seq: 1,
      neighbors: [epRelay.peerId],
      signPubKey: jwkToCompactPub(epOrigin.signPubJwk),
      encPubKey: jwkToCompactPub(epOrigin.signPubJwk)
    },
    {
      peerId: epOrigin.peerId,
      signPrivateKey: epOrigin.signPrivateKey,
      signPubKey: jwkToCompactPub(epOrigin.signPubJwk),
      encPrivateKey: epOrigin.signPrivateKey,
      encPubKey: jwkToCompactPub(epOrigin.signPubJwk)
    },
    'r17-app',
    'r17-room',
    '',
    null
  )
  hubMgr.handleFrame(
    epRelay.peerId,
    packOverlayControl({t: 'gossip', descriptors: [descOrigin]}).slice().buffer
  )
  await wait(25)
  forwardedToDownstream.length = 0

  const ts = Date.now()
  const msgId = `${epOrigin.peerId}:1:r17bcast`
  const payload = new Uint8Array(makeInlineFrame('chat', 'relay-me'))
  const sig = await signOverlayPayload(
    epOrigin.signPrivateKey,
    canonicalBroadcastHeader(
      epOrigin.peerId,
      msgId,
      1,
      ts,
      'r17-app',
      'r17-room'
    ),
    payload
  )
  const bcastPkt = packOverlayBinary(
    overlayBroadcastKind,
    4,
    {o: epOrigin.peerId, q: 1, m: msgId, t: ts, s: sig},
    payload
  )
  hubMgr.handleFrame(epRelay.peerId, bcastPkt.slice().buffer)
  await wait(25)

  assert.equal(localDeliveries.length, 0)
  assert.equal(
    forwardedToDownstream.length,
    1,
    'capacity-full intermediate node MUST still forward broadcast to downstream neighbor'
  )
  hubMgr.destroy()
})

void test('ActionWire IncomingInlineState & IncomingBulkState: pre-listener FIFO mid-flush, bulk cancel accuracy, and deciding signal lifecycle', async () => {
  for (const withGate of [false, true]) {
    const wire = createActionWireManager({
      onPeerError: () => {},
      resolveTransport: () => undefined,
      getPeerIds: () => [],
      canReceiveFromPeer: () => true
    })
    const chat = wire.makeWireAction<string>('chat')
    if (withGate) {
      chat.onReceive(() => true)
    }

    wire.handleData('peer', makeInlineFrame('chat', 'm1'))
    wire.handleData('peer', makeInlineFrame('chat', 'm2'))
    wire.handleData('peer', makeInlineFrame('chat', 'm3'))

    const seen: string[] = []
    chat.onMessage(msg => {
      seen.push(msg)
      chat.onMessage(null)
      wire.handleData('peer', makeInlineFrame('chat', 'm4'))
    })
    assert.deepEqual(seen, ['m1'])

    chat.onMessage(msg => {
      seen.push(msg)
    })
    assert.deepEqual(seen, ['m1', 'm2', 'm3', 'm4'])
  }

  // OutgoingBulkState aborted before offer sent emits 0 frames
  let resolveDrain!: (ok: boolean) => void
  const sentFrames: Uint8Array[] = []
  const wire = createActionWireManager({
    onPeerError: () => {},
    resolveTransport: () => ({
      isOpen: true,
      bufferedAmount: 0,
      sendFrame: bytes => {
        sentFrames.push(bytes.slice())
      },
      waitForDrain: () =>
        new Promise<boolean>(res => {
          resolveDrain = res
        })
    }),
    getPeerIds: () => ['peer'],
    canReceiveFromPeer: () => true
  })
  const file = wire.makeWireAction<Uint8Array>('file')
  const abort1 = new AbortController()
  const send1 = file.send(
    new Uint8Array(20_000),
    'peer',
    undefined,
    undefined,
    abort1.signal
  )
  await Promise.resolve()
  abort1.abort()
  resolveDrain(false)
  await assert.rejects(send1, {name: 'AbortError'})
  assert.equal(sentFrames.length, 0)

  // Deciding signal is NOT aborted on normal accept, only on cancel/clearPeer!
  const controls: number[] = []
  const bulkRxWire = createActionWireManager({
    onPeerError: () => {},
    resolveTransport: () => ({
      isOpen: true,
      bufferedAmount: 0,
      sendFrame: bytes => {
        controls.push(bytes[1]! & 15)
      },
      waitForDrain: () => true
    }),
    getPeerIds: () => ['peer'],
    canReceiveFromPeer: () => true,
    maxReceiveBytes: 24_000
  })
  let capturedSignal: AbortSignal | undefined
  const first = bulkRxWire.makeWireAction<Uint8Array>('first')
  const second = bulkRxWire.makeWireAction<Uint8Array>('second')
  first.onReceive(({signal}) => {
    capturedSignal = signal
    return true
  })
  let firstDelivered = 0
  first.onMessage(() => {
    firstDelivered++
  })
  second.onMessage(() => {})
  bulkRxWire.handleData('peer', makeBulkOfferFrame('first', 1, 20_000))
  assert.equal(capturedSignal?.aborted, false)
  bulkRxWire.handleData('peer', makeBulkOfferFrame('second', 2, 20_000))
  first.onMessage(null)
  const chunkCap = 16 * 1024 - 14
  bulkRxWire.handleData('peer', makeChunkFrame(1, 0, chunkCap))
  bulkRxWire.handleData('peer', makeChunkFrame(1, chunkCap, 20_000 - chunkCap))
  assert.deepEqual(controls, [3])
  first.onMessage(() => {
    firstDelivered++
  })
  assert.equal(firstDelivered, 1)
  assert.deepEqual(controls, [3, 3])
  // A3 bulkPhaseClass & transitionBulk invariant: cancelling in-progress transfer #2 (receiving -> closed)
  // releases reservedBytes & peer.activeBulk so queued transfer #3 (20_000 bytes under 24_000 cap) immediately accepts!
  bulkRxWire.handleData('peer', makeBulkOfferFrame('second', 3, 20_000))
  assert.deepEqual(controls, [3, 3])
  bulkRxWire.handleData('peer', makeChunkFrame(2, 0, chunkCap))
  bulkRxWire.handleData('peer', makeCancelFrame(2))
  assert.deepEqual(controls, [3, 3, 3])
  bulkRxWire.clearPeer('peer')
})

void test('MediaManager RemoteStreamState & LocalPeerStreamState: 0-track addtrack promotion, dead stream suppression, and syncGen zombie prevention', async () => {
  const emitted: Array<{id: string; meta: unknown; tracks: number}> = []
  const media = createMediaManager({
    iterate: () => [],
    isActive: () => true,
    onPeerError: () => {}
  })
  media.onPeerStream((stream, {metadata}) => {
    emitted.push({
      id: stream.id,
      meta: metadata,
      tracks: stream.getTracks().length
    })
  })

  const makeMockTrack = (id: string, readyState: 'live' | 'ended' = 'live') => {
    const listeners = new Map<string, Set<() => void>>()
    let state = readyState
    return {
      track: {
        id,
        get readyState() {
          return state
        },
        addEventListener: (ev: string, cb: () => void) => {
          ;(listeners.get(ev) ?? listeners.set(ev, new Set()).get(ev)!).add(cb)
        },
        removeEventListener: (ev: string, cb: () => void) => {
          listeners.get(ev)?.delete(cb)
        }
      } as unknown as MediaStreamTrack,
      end: () => {
        state = 'ended'
        listeners.get('ended')?.forEach(cb => cb())
      }
    }
  }

  const makeMockStream = (id: string, initial: MediaStreamTrack[]) => {
    const listeners = new Map<string, Set<() => void>>()
    const tracks = [...initial]
    return {
      stream: {
        id,
        active: true,
        getTracks: () => [...tracks],
        addEventListener: (ev: string, cb: () => void) => {
          ;(listeners.get(ev) ?? listeners.set(ev, new Set()).get(ev)!).add(cb)
        },
        removeEventListener: (ev: string, cb: () => void) => {
          listeners.get(ev)?.delete(cb)
        }
      } as unknown as MediaStream,
      tracks,
      dispatch: (ev: string) => {
        listeners.get(ev)?.forEach(cb => cb())
      }
    }
  }

  const dead = makeMockStream('dead-s', [makeMockTrack('dt', 'ended').track])
  media.receiveStreamMeta({k: 'k-dead', s: 'dead-s', t: 1}, 'peer1')
  media.receiveRemoteStream('peer1', dead.stream)
  assert.equal(emitted.length, 0)

  const dyn = makeMockStream('dyn-s', [])
  media.receiveStreamMeta({k: 'k-dyn', s: 'dyn-s', t: 2, m: 'cam'}, 'peer1')
  media.receiveRemoteStream('peer1', dyn.stream)
  assert.equal(emitted.length, 0)
  dyn.tracks.push(makeMockTrack('t1').track)
  dyn.dispatch('addtrack')
  assert.equal(emitted.length, 0)
  dyn.tracks.push(makeMockTrack('t2').track)
  dyn.dispatch('addtrack')
  assert.deepEqual(emitted, [{id: 'dyn-s', meta: 'cam', tracks: 2}])

  // Local syncGen prevents removeStream racing with async preparePeer from adding stream
  let resolvePromote!: (peer: PeerHandle) => void
  const addedStreams: MediaStream[] = []
  const mockHandle = {
    addStream: (s: MediaStream) => addedStreams.push(s),
    removeStream: () => {},
    addTrack: () => ({}),
    removeTrack: () => {},
    replaceTrack: async () => {}
  } as unknown as PeerHandle

  const localMedia = createMediaManager({
    iterate: (_t, f) => [Promise.resolve(f('peerA', undefined))],
    isActive: () => true,
    preparePeer: () =>
      new Promise<PeerHandle>(res => {
        resolvePromote = res
      }),
    onPeerError: () => {}
  })
  const localStream = {
    id: 'local-s',
    getTracks: () => [{id: 'cam1'} as MediaStreamTrack]
  } as unknown as MediaStream
  const addP = localMedia.addStream(
    localStream,
    {target: 'peerA'},
    async () => {}
  )
  await Promise.resolve()
  localMedia.removeStream(localStream, 'peerA')
  resolvePromote(mockHandle)
  await addP
  assert.equal(addedStreams.length, 0)
})

void test('OverlayManager NeighborSlotState & OriginBuffer: ban removes direct neighbor and early unicast + verified broadcast coexist', async () => {
  const seq = createOverlaySequencer({
    getAppId: () => 'app',
    getRoomId: () => 'room',
    getSelfId: () => 'S'.repeat(20),
    isPinnedOrigin: () => false
  })
  const order: number[] = []
  let releaseFirst!: () => void
  const firstGate = new Promise<void>(r => {
    releaseFirst = r
  })
  seq.enqueuePeerTask('peer-fifo', async () => {
    await firstGate
    order.push(1)
  })
  seq.enqueuePeerTask('peer-fifo', () => {
    order.push(2)
  })
  releaseFirst()
  await wait(15)
  assert.deepEqual(order, [1, 2])
  seq.clear()

  const [epSelf, epRelay, epOrigin] = await Promise.all([
    createEndpointIdentity(),
    createEndpointIdentity(),
    createEndpointIdentity()
  ])
  const delivered: ArrayBuffer[] = []
  const mgr = createOverlayManager({
    selfId: epSelf.peerId,
    appId: 'scale-sm-app',
    roomId: 'scale-sm-room',
    getLocalEndpointIdentity: () => epSelf,
    onVirtualPeerJoin: () => true,
    onVirtualPeerLeave: () => {},
    onDeliverData: (_origin, buf) => {
      delivered.push(buf)
    }
  })

  const assertNeighborInvariants = (expectedDirect: readonly string[]) => {
    const expectedSorted = [...expectedDirect].sort()
    const snap = mgr.getSnapshot()
    assert.deepEqual(snap.directPeerIds, expectedSorted)
    for (const id of [epSelf.peerId, epRelay.peerId, epOrigin.peerId]) {
      assert.equal(mgr.isDirectPeer(id), expectedSorted.includes(id))
    }
  }
  assertNeighborInvariants([])
  mgr.addDirectPeer(epRelay.peerId, new MockPeer() as unknown as PeerHandle)
  assertNeighborInvariants([epRelay.peerId])

  const ivB64 = toBase64Url(crypto.getRandomValues(new Uint8Array(12)))
  const msgId = `${epOrigin.peerId}:1:abcdefgh`
  const ts = Date.now()
  const fakeCipher = new Uint8Array(32)
  const sig = await signOverlayPayload(
    epOrigin.signPrivateKey,
    canonicalUnicastHeader(
      epOrigin.peerId,
      epSelf.peerId,
      msgId,
      ivB64,
      1,
      ts,
      'scale-sm-app',
      'scale-sm-room'
    ),
    fakeCipher
  )
  mgr.handleFrame(
    epRelay.peerId,
    packOverlayBinary(
      overlayUnicastKind,
      4,
      {
        o: epOrigin.peerId,
        d: epSelf.peerId,
        q: 1,
        t: ts,
        m: msgId,
        iv: ivB64,
        s: sig
      },
      fakeCipher
    ).slice().buffer
  )

  const descWithoutEnc = await signPeerDescriptor(
    {
      peerId: epOrigin.peerId,
      seq: 1,
      neighbors: [epRelay.peerId],
      signPubKey: jwkToCompactPub(epOrigin.signPubJwk)
    },
    {
      peerId: epOrigin.peerId,
      signPrivateKey: epOrigin.signPrivateKey,
      signPubKey: jwkToCompactPub(epOrigin.signPubJwk),
      encPrivateKey: epOrigin.signPrivateKey,
      encPubKey: ''
    },
    'scale-sm-app',
    'scale-sm-room',
    '',
    null
  )
  mgr.handleFrame(
    epRelay.peerId,
    packOverlayControl({t: 'gossip', descriptors: [descWithoutEnc]}).slice()
      .buffer
  )
  await wait(30)
  assert.equal(delivered.length, 0)

  assertNeighborInvariants([epRelay.peerId])
  mgr.markPeerBanned(epRelay.peerId)
  assertNeighborInvariants([])
  mgr.unmarkPeerBanned(epRelay.peerId)
  assertNeighborInvariants([])
  mgr.destroy()
  assertNeighborInvariants([])
})

void test('ServerLifecycleState & ClientSessionState (ws-relay/server): 1008 quota release and clientTracking:false close()', async () => {
  const relay = createWsRelayServer({
    port: 0,
    host: '127.0.0.1',
    clientTracking: false,
    maxSubscriptionsPerSocket: 1,
    maxSubscriptions: 1
  })
  await relay.ready
  const address = relay.address()
  assert.ok(address && typeof address === 'object')
  const url = `ws://127.0.0.1:${address.port}`
  const s1 = new WebSocket(url)
  await once(s1, 'open')
  s1.send(JSON.stringify({type: 'subscribe', topic: 't1'}))
  await waitFor(() => relay.getSubscriberCount('t1') === 1)

  const s1Closed = once(s1, 'close', {signal: AbortSignal.timeout(1_000)})
  s1.send(JSON.stringify({type: 'subscribe', topic: 't2'}))
  await s1Closed
  assert.equal(relay.getSubscriberCount(), 0)

  const s2 = new WebSocket(url)
  await once(s2, 'open')
  s2.send(JSON.stringify({type: 'subscribe', topic: 't3'}))
  await waitFor(() => relay.getSubscriberCount('t3') === 1)

  await relay.close()
  assert.equal(relay.getSubscriberCount(), 0)
  s1.terminate()
  s2.terminate()
})

void test('RoomLifecycleState & RelayAnnounceState: stopAnnouncing is terminal, makeSocket.close rejects ready, and post-leave makeState is inert', async () => {
  let announceCalls = 0
  const joinStoppedRelay = createStrategy({
    init: () => [{}],
    subscribe: async () => () => {},
    announce: async () => {
      announceCalls++
      return {stopAnnouncing: true}
    }
  })
  const room = joinStoppedRelay(
    {
      appId: 'stop-ann-sm-app',
      rtcPolyfill: MockRTCPeerConnection as unknown as typeof RTCPeerConnection
    },
    'stop-ann-room'
  )
  await waitFor(() => announceCalls === 1)
  await room.leave()
  const lateState = room.makeState('late', 0)
  await lateState.set(1)
  assert.equal(lateState.get(), 0)

  let closedCount = 0
  const mgr = createRelayManager<{id: number; closed: boolean}>(
    () => undefined,
    r => {
      r.closed = true
      closedCount++
    },
    r => r.closed
  )
  const item = mgr.register('wss://relay.invalid', () => ({
    id: 1,
    closed: false
  }))
  const lease1 = mgr.lease(item, Promise.resolve(item))
  mgr.evict(item)
  assert.equal(closedCount, 0)
  releaseRelayLease(lease1)
  assert.equal(closedCount, 1)

  const wsRelay = createWsRelayServer({port: 0, host: '127.0.0.1'})
  await wsRelay.ready
  const addr = wsRelay.address()
  assert.ok(addr && typeof addr === 'object')
  const sockClient = makeSocket(
    `ws://127.0.0.1:${addr.port}`,
    () => {},
    () => {}
  )
  sockClient.close?.()
  await assert.rejects(() => sockClient.ready, /closed/i)
  await wsRelay.close()

  void buildSignalAad
  void encrypt
  void genKey
})

void test('Mqtt TopicSubscriptionState & InitialConnect (R4): broker failing initial connect self-heals on mqtt.js reconnect', async () => {
  let connections = 0
  let sawSubscribe = false
  let sawPublish = false

  const wss = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    handleProtocols: protocols =>
      protocols.has('mqtt') ? 'mqtt' : ([...protocols][0] ?? false)
  })
  await once(wss, 'listening')
  const addr = wss.address()
  assert.ok(addr && typeof addr === 'object')

  wss.on('connection', socket => {
    connections++
    if (connections === 1) {
      socket.close()
      return
    }
    let rxBuf = Buffer.alloc(0)
    socket.on('message', data => {
      const chunk = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data as ArrayBuffer)
      rxBuf = Buffer.concat([rxBuf, chunk])

      while (rxBuf.length >= 2) {
        let remLen = 0
        let mult = 1
        let idx = 1
        let completeLen = false
        while (idx < rxBuf.length) {
          const byte = rxBuf[idx]!
          remLen += (byte & 0x7f) * mult
          mult *= 128
          idx++
          if ((byte & 0x80) === 0) {
            completeLen = true
            break
          }
        }
        if (!completeLen || rxBuf.length < idx + remLen) {
          break
        }

        const pkt = rxBuf.subarray(0, idx + remLen)
        rxBuf = rxBuf.subarray(idx + remLen)
        const packetType = (pkt[0] ?? 0) & 0xf0

        if (packetType === 0x10) {
          // MQTT 3.1.1 CONNACK
          socket.send(Buffer.from([0x20, 0x02, 0x00, 0x00]))
        } else if (packetType === 0x80) {
          // MQTT 3.1.1 SUBSCRIBE -> count topic filters and reply SUBACK
          sawSubscribe = true
          const pktIdHi = pkt[idx] ?? 0
          const pktIdLo = pkt[idx + 1] ?? 1
          let pos = idx + 2
          const grants: number[] = []
          while (pos + 2 <= pkt.length) {
            const topicLen = ((pkt[pos] ?? 0) << 8) | (pkt[pos + 1] ?? 0)
            pos += 2 + topicLen + 1
            grants.push(0x00)
          }
          socket.send(
            Buffer.from([0x90, 2 + grants.length, pktIdHi, pktIdLo, ...grants])
          )
        } else if (packetType === 0x30) {
          sawPublish = true
        }
      }
    })
  })

  const room = joinMqttRoom(
    {
      appId: 'r4-mqtt-app',
      relayConfig: {
        urls: [`ws://127.0.0.1:${addr.port}`],
        redundancy: 1,
        warnOnRelayFailure: false
      },
      rtcPolyfill: MockRTCPeerConnection as unknown as typeof RTCPeerConnection
    },
    `r4-room-${Date.now()}`
  )
  try {
    await waitFor(() => connections >= 2 && sawSubscribe && sawPublish, 5_000)
    assert.equal(sawSubscribe, true)
    assert.equal(sawPublish, true)
  } finally {
    await room.leave()
    await new Promise<void>(resolve => wss.close(() => resolve()))
  }
})
