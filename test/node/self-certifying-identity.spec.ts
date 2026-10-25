// @ts-nocheck
import assert from 'node:assert/strict'
import test from './test.ts'
import {
  createTopicStrategy,
  createUserIdentity,
  derivePeerId,
  deriveUserId,
  exportUserIdentity,
  importUserIdentity,
  roles,
  selfId,
  verifyPeerIdKey,
  verifyUserIdKey
} from '../../packages/core/src/index.ts'
import {
  signUserEndpointProof,
  verifyUserEndpointProof
} from '../../packages/core/src/identity.ts'
import {waitFor} from './peer-harness.ts'

class LinkedDataChannel {
  label: string
  ordered = true
  readyState: 'connecting' | 'open' | 'closing' | 'closed' = 'connecting'
  binaryType = 'arraybuffer'
  bufferedAmount = 0
  bufferedAmountLowThreshold = 0
  onmessage: ((ev: {data: any}) => void) | null = null
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((ev: any) => void) | null = null
  partner: LinkedDataChannel | null = null
  listeners: Record<string, Set<(...args: any[]) => void>> = {}

  constructor(label = 'trystero') {
    this.label = label
  }

  addEventListener(event: string, fn: (...args: any[]) => void) {
    ;(this.listeners[event] ??= new Set()).add(fn)
  }

  removeEventListener(event: string, fn: (...args: any[]) => void) {
    this.listeners[event]?.delete(fn)
  }

  send(data: Uint8Array | ArrayBuffer | string) {
    if (this.readyState !== 'open' || !this.partner) {
      return
    }
    const partner = this.partner
    const payload =
      typeof data === 'string'
        ? data
        : data instanceof ArrayBuffer
          ? data.slice(0)
          : data.buffer.slice(
              data.byteOffset,
              data.byteOffset + data.byteLength
            )

    queueMicrotask(() => {
      if (partner.readyState === 'open') {
        partner.onmessage?.({data: payload})
        partner.listeners['message']?.forEach(fn => fn({data: payload}))
      }
    })
  }

  close() {
    if (this.readyState === 'closed') {
      return
    }
    this.readyState = 'closed'
    this.onclose?.()
    this.listeners['close']?.forEach(fn => fn())
    const partner = this.partner
    this.partner = null
    if (partner && partner.readyState !== 'closed') {
      queueMicrotask(() => partner.close())
    }
  }
}

const offerMap = new Map<string, InMemoryRTCPeerConnection>()
const answerMap = new Map<
  string,
  {offerPc: InMemoryRTCPeerConnection; answerPc: InMemoryRTCPeerConnection}
>()
let sdpCounter = 0

class InMemoryRTCPeerConnection {
  iceGatheringState = 'complete'
  connectionState = 'new'
  iceConnectionState = 'new'
  signalingState = 'stable'
  localDescription: {type: string; sdp: string} | null = null
  remoteDescription: {type: string; sdp: string} | null = null
  onnegotiationneeded: (() => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  ontrack: ((ev: any) => void) | null = null
  ondatachannel: ((ev: {channel: LinkedDataChannel}) => void) | null = null
  listeners: Record<string, Set<(...args: any[]) => void>> = {}
  dataChannel: LinkedDataChannel | null = null
  matchedOfferPc: InMemoryRTCPeerConnection | null = null
  partnerPc: InMemoryRTCPeerConnection | null = null
  dtlsFingerprint = `sha-256 AA:BB:CC:DD:${(++sdpCounter).toString(16).padStart(2, '0')}`
  overrideRemoteDtlsFingerprint: string | null = null

  createDataChannel(label: string) {
    const ch = new LinkedDataChannel(label)
    this.dataChannel = ch
    return ch
  }

  addEventListener(event: string, fn: (...args: any[]) => void) {
    ;(this.listeners[event] ??= new Set()).add(fn)
  }

  removeEventListener(event: string, fn: (...args: any[]) => void) {
    this.listeners[event]?.delete(fn)
  }

  restartIce() {}

  async createOffer() {
    const sdp = `v=0\r\na=fingerprint:${this.dtlsFingerprint}\r\na=mid:${++sdpCounter}\r\n`
    offerMap.set(sdp, this)
    return {type: 'offer', sdp}
  }

  async createAnswer() {
    const sdp = `v=0\r\na=fingerprint:${this.dtlsFingerprint}\r\na=mid:${++sdpCounter}\r\n`
    if (this.matchedOfferPc) {
      answerMap.set(sdp, {offerPc: this.matchedOfferPc, answerPc: this})
    }
    return {type: 'answer', sdp}
  }

  async setLocalDescription(description?: {type: string; sdp: string}) {
    if (description?.type === 'rollback') {
      this.signalingState = 'stable'
      return
    }
    const next =
      description ??
      (this.remoteDescription?.type === 'offer'
        ? await this.createAnswer()
        : await this.createOffer())
    this.localDescription = next
    this.signalingState = next.type === 'offer' ? 'have-local-offer' : 'stable'
    this.listeners['icegatheringstatechange']?.forEach(fn => fn())
  }

  async setRemoteDescription(description: {type: string; sdp: string}) {
    this.remoteDescription = this.overrideRemoteDtlsFingerprint
      ? {
          type: description.type,
          sdp: `v=0\r\na=fingerprint:${this.overrideRemoteDtlsFingerprint}\r\n`
        }
      : description
    if (description.type === 'offer') {
      this.matchedOfferPc = offerMap.get(description.sdp) ?? null
      this.signalingState = 'have-remote-offer'
      return
    }
    if (description.type === 'answer') {
      this.signalingState = 'stable'
      const match = answerMap.get(description.sdp)
      if (!match || match.offerPc !== this) {
        return
      }
      const {answerPc} = match
      if (
        this.connectionState === 'closed' ||
        answerPc.connectionState === 'closed'
      ) {
        return
      }
      this.partnerPc = answerPc
      answerPc.partnerPc = this
      const offerCh = this.dataChannel ?? new LinkedDataChannel('trystero')
      const answerCh = new LinkedDataChannel(offerCh.label)
      offerCh.partner = answerCh
      answerCh.partner = offerCh
      answerPc.dataChannel = answerCh

      queueMicrotask(() => {
        if (
          this.connectionState === 'closed' ||
          answerPc.connectionState === 'closed'
        ) {
          return
        }
        this.connectionState = 'connected'
        this.iceConnectionState = 'connected'
        answerPc.connectionState = 'connected'
        answerPc.iceConnectionState = 'connected'
        this.onconnectionstatechange?.()
        answerPc.onconnectionstatechange?.()

        answerPc.ondatachannel?.({channel: answerCh})
        offerCh.readyState = 'open'
        answerCh.readyState = 'open'
        offerCh.onopen?.()
        answerCh.onopen?.()
      })
    }
  }

  close() {
    if (this.connectionState === 'closed') {
      return
    }
    this.connectionState = 'closed'
    this.iceConnectionState = 'closed'
    this.dataChannel?.close()
    this.onconnectionstatechange?.()
    const partner = this.partnerPc
    this.partnerPc = null
    if (partner && partner.connectionState !== 'closed') {
      queueMicrotask(() => partner.close())
    }
  }

  getSenders() {
    return []
  }

  addTrack() {
    return {}
  }

  removeTrack() {}
}

const createMemorySignalBus = () => {
  const topicHandlers = new Map<
    string,
    Set<(topic: string, data: string) => void>
  >()

  const makeJoinRoom = () => {
    const rawJoinRoom = createTopicStrategy({
      steadyAnnounceIntervalMs: 120,
      init: () => ({}),
      subscribeTopic: (_relay, topic, onTopicMessage) => {
        let set = topicHandlers.get(topic)
        if (!set) {
          set = new Set()
          topicHandlers.set(topic, set)
        }
        set.add(onTopicMessage)
        return () => {
          set?.delete(onTopicMessage)
        }
      },
      publishTopic: (_relay, topic, message) => {
        const handlers = topicHandlers.get(topic)
        if (!handlers) {
          return
        }
        for (const handler of handlers) {
          setTimeout(() => {
            if (topicHandlers.get(topic)?.has(handler)) {
              handler(topic, message)
            }
          }, 1)
        }
      }
    })
    return (config: any, roomId: string, callbacks?: any) =>
      rawJoinRoom(
        config && typeof config === 'object'
          ? {_test_only_sharedPeerIdleMs: 5, ...config}
          : config,
        roomId,
        callbacks
      )
  }

  return {makeJoinRoom}
}

void test('Identity primitives: selfId is 20-char Base62 and userId is 43-char Base64url JWK thumbprint', async () => {
  assert.equal(typeof selfId, 'string')
  assert.equal(selfId.length, 20)
  assert.match(selfId, /^[0-9A-Za-z]{20}$/)

  const user = await createUserIdentity()
  assert.equal(typeof user.userId, 'string')
  assert.equal(user.userId.length, 43)
  assert.match(user.userId, /^[0-9A-Za-z_-]{43}$/)
  assert.notEqual(user.userId.length, selfId.length)

  assert.equal(await deriveUserId(user.publicKey), user.userId)
  assert.equal(await verifyUserIdKey(user.userId, user.publicKey), true)

  const otherUser = await createUserIdentity()
  assert.equal(await verifyUserIdKey(user.userId, otherUser.publicKey), false)

  const derivedPeerId = await derivePeerId(user.publicKey)
  assert.equal(derivedPeerId.length, 20)
  assert.match(derivedPeerId, /^[0-9A-Za-z]{20}$/)
  assert.equal(await verifyPeerIdKey(derivedPeerId, user.publicKey), true)
  assert.equal(await verifyPeerIdKey(derivedPeerId, otherUser.publicKey), false)

  const exported = exportUserIdentity(user)
  assert.ok(exported.startsWith('trystero_uk_'))
  const importedFromStr = await importUserIdentity(exported)
  assert.equal(importedFromStr.userId, user.userId)
  assert.deepEqual(importedFromStr.publicKey, user.publicKey)

  await assert.rejects(
    () => importUserIdentity('low-entropy-passphrase'),
    /invalid user identity key material|exported userKey/i
  )
})

void test('Identity config validation & persistence modes: none, session, local, and custom', async t => {
  for (const name of ['sessionStorage', 'localStorage', 'indexedDB']) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
    t.after(() => {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor)
      } else {
        delete globalThis[name]
      }
    })
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: undefined
    })
  }
  const {makeJoinRoom} = createMemorySignalBus()
  const joinRoom = makeJoinRoom()

  // Rejects arbitrary low-entropy strings synchronously
  assert.throws(
    () =>
      joinRoom(
        {
          appId: 'validation-app',
          identity: 'alice' as any,
          rtcPolyfill: InMemoryRTCPeerConnection as any
        },
        'room-1'
      ),
    /invalid user identity key material|exported userKey/i
  )

  // Throws synchronously when 'session' or 'local' is explicitly requested without storage
  assert.throws(
    () =>
      joinRoom(
        {
          appId: 'no-storage-app',
          identity: 'session',
          rtcPolyfill: InMemoryRTCPeerConnection as any
        },
        'room-session'
      ),
    /sessionStorage is not available/
  )

  assert.throws(
    () =>
      joinRoom(
        {
          appId: 'no-storage-app',
          identity: 'local',
          rtcPolyfill: InMemoryRTCPeerConnection as any
        },
        'room-local'
      ),
    /persistent local storage/
  )

  // Simulate sessionStorage and localStorage
  const sessionStore = new Map<string, string>()
  const localStore = new Map<string, string>()
  const makeMockStorage = (map: Map<string, string>) => ({
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v)
    },
    removeItem: (k: string) => {
      map.delete(k)
    }
  })

  const prevSession = (globalThis as any).sessionStorage
  const prevLocal = (globalThis as any).localStorage
  ;(globalThis as any).sessionStorage = makeMockStorage(sessionStore)
  ;(globalThis as any).localStorage = makeMockStorage(localStore)

  try {
    // 'session' reuses userId within same appId and isolates across appIds
    const sRoom1 = makeJoinRoom()(
      {
        appId: 'app-session-1',
        _test_only_forcedPeerId: 'peer-s1',
        identity: 'session',
        rtcPolyfill: InMemoryRTCPeerConnection as any
      },
      'r1'
    )
    const sRoom2 = makeJoinRoom()(
      {
        appId: 'app-session-1',
        _test_only_forcedPeerId: 'peer-s2',
        identity: 'session',
        rtcPolyfill: InMemoryRTCPeerConnection as any
      },
      'r2'
    )
    const sRoomOtherApp = makeJoinRoom()(
      {
        appId: 'app-session-2',
        _test_only_forcedPeerId: 'peer-s3',
        identity: 'session',
        rtcPolyfill: InMemoryRTCPeerConnection as any
      },
      'r1'
    )

    const selfS1 = await sRoom1.getSelf()
    const selfS2 = await sRoom2.getSelf()
    const selfSOther = await sRoomOtherApp.getSelf()

    assert.equal(selfS1.userId, selfS2.userId)
    assert.notEqual(selfS1.peerId, selfS2.peerId)
    assert.notEqual(selfS1.userId, selfSOther.userId)

    await Promise.all([sRoom1.leave(), sRoom2.leave(), sRoomOtherApp.leave()])

    // 'local' coordinates concurrent first-time tabs to converge on the same userId
    const [lRoom1, lRoom2] = [
      makeJoinRoom()(
        {
          appId: 'app-local-1',
          _test_only_forcedPeerId: 'peer-l1',
          identity: 'local',
          rtcPolyfill: InMemoryRTCPeerConnection as any
        },
        'r-local-1'
      ),
      makeJoinRoom()(
        {
          appId: 'app-local-1',
          _test_only_forcedPeerId: 'peer-l2',
          identity: 'local',
          rtcPolyfill: InMemoryRTCPeerConnection as any
        },
        'r-local-2'
      )
    ]

    const [selfL1, selfL2] = await Promise.all([
      lRoom1.getSelf(),
      lRoom2.getSelf()
    ])
    assert.equal(selfL1.userId, selfL2.userId)
    await Promise.all([lRoom1.leave(), lRoom2.leave()])

    // Custom loader receives {appId, roomId} and returns UserIdentity or exported key
    const customUser = await createUserIdentity()
    let loaderContext: any = null
    const cRoom = makeJoinRoom()(
      {
        appId: 'app-custom',
        _test_only_forcedPeerId: 'peer-c1',
        identity: async ctx => {
          loaderContext = ctx
          return exportUserIdentity(customUser)
        },
        rtcPolyfill: InMemoryRTCPeerConnection as any
      },
      'room-custom'
    )
    const selfC = await cRoom.getSelf()
    assert.equal(selfC.userId, customUser.userId)
    assert.deepEqual(loaderContext, {
      appId: 'app-custom',
      roomId: 'room-custom'
    })
    await cRoom.leave()
  } finally {
    ;(globalThis as any).sessionStorage = prevSession
    ;(globalThis as any).localStorage = prevLocal
  }
})

void test(
  'User presence (onUserJoin, onUserLeave, getUsers) and overloaded target fan-out & deterministic request across multi-tab userIds',
  {timeout: 10_000},
  async () => {
    const {makeJoinRoom} = createMemorySignalBus()
    const appId = `multi-tab-presence-${Date.now()}`
    const roomId = 'presence-room'

    const aliceIdentity = await createUserIdentity()
    const bobIdentity = await createUserIdentity()

    const bobPeerJoins: any[] = []
    const bobPeerLeaves: any[] = []
    const bobUserJoins: any[] = []
    const bobUserLeaves: any[] = []

    const roomBob = makeJoinRoom()(
      {
        appId,
        _test_only_forcedPeerId: 'peer-bob',
        identity: bobIdentity,
        rtcPolyfill: InMemoryRTCPeerConnection as any
      },
      roomId
    )
    roomBob.onPeerJoin = ctx => bobPeerJoins.push(ctx)
    roomBob.onPeerLeave = ctx => bobPeerLeaves.push(ctx)
    roomBob.onUserJoin = ctx => bobUserJoins.push(ctx)
    roomBob.onUserLeave = ctx => bobUserLeaves.push(ctx)

    let roomAlice1: any = null
    let roomAlice2: any = null
    try {
      // 1. Alice's 1st tab joins
      roomAlice1 = makeJoinRoom()(
        {
          appId,
          _test_only_forcedPeerId: 'peer-alice-1',
          identity: aliceIdentity,
          rtcPolyfill: InMemoryRTCPeerConnection as any
        },
        roomId
      )

      await waitFor(
        () =>
          bobPeerJoins.some(e => e.peerId === 'peer-alice-1') &&
          Object.keys(roomAlice1.getPeers()).includes('peer-bob'),
        3_000
      )

      assert.equal(bobPeerJoins.length, 1)
      assert.equal(bobPeerJoins[0].peerId, 'peer-alice-1')
      assert.equal(bobPeerJoins[0].userId, aliceIdentity.userId)
      assert.equal(bobUserJoins.length, 1)
      assert.equal(bobUserJoins[0].userId, aliceIdentity.userId)
      assert.equal(bobUserJoins[0].peerId, 'peer-alice-1')

      // 2. Alice's 2nd tab joins with the same aliceIdentity
      roomAlice2 = makeJoinRoom()(
        {
          appId,
          _test_only_forcedPeerId: 'peer-alice-2',
          identity: aliceIdentity,
          rtcPolyfill: InMemoryRTCPeerConnection as any
        },
        roomId
      )

      await waitFor(
        () =>
          bobPeerJoins.some(e => e.peerId === 'peer-alice-2') &&
          Object.keys(roomAlice2.getPeers()).includes('peer-bob'),
        3_000
      )

      assert.equal(
        bobPeerJoins.length,
        2,
        'onPeerJoin should fire for Alice second tab'
      )
      assert.equal(
        bobUserJoins.length,
        1,
        'onUserJoin must NOT fire again when Alice opens a second tab'
      )

      const usersAtBob = roomBob.getUsers()
      assert.ok(usersAtBob[aliceIdentity.userId])
      assert.equal(usersAtBob[bobIdentity.userId], undefined)
      assert.deepEqual(usersAtBob[aliceIdentity.userId].peerIds.sort(), [
        'peer-alice-1',
        'peer-alice-2'
      ])
      assert.equal(
        roomBob.getPeers()['peer-alice-1'].userId,
        aliceIdentity.userId
      )
      assert.equal(
        roomBob.getPeers()['peer-alice-2'].userId,
        aliceIdentity.userId
      )

      // Wait for Alice's two tabs to also connect to each other
      await waitFor(() => 'peer-alice-2' in roomAlice1.getPeers(), 3_000)
      // getUsers() on Alice's tab excludes the self user (aliceIdentity.userId)
      const usersAtAlice1 = roomAlice1.getUsers()
      assert.equal(
        usersAtAlice1[aliceIdentity.userId],
        undefined,
        'getUsers() must exclude the local user even when a second tab of the local user is connected'
      )
      assert.deepEqual(usersAtAlice1[bobIdentity.userId].peerIds, ['peer-bob'])

      // ping(userId) deterministically pings one endpoint matching request() logic
      const rtt = await roomBob.ping(aliceIdentity.userId)
      assert.equal(typeof rtt, 'number')
      assert.ok(rtt >= 0)

      // 3. Overloaded target on send(data, {target: userId}) fans out to both tabs (and deduplicates)
      const chatBob = roomBob.makeAction<string>('chat')
      const alice1Msgs: any[] = []
      const alice2Msgs: any[] = []
      roomAlice1.makeAction<string>('chat', {
        onMessage: (data, ctx) => alice1Msgs.push({data, ...ctx})
      })
      roomAlice2.makeAction<string>('chat', {
        onMessage: (data, ctx) => alice2Msgs.push({data, ...ctx})
      })

      await chatBob.send('hello-alice-all-tabs', {
        target: [aliceIdentity.userId, 'peer-alice-1']
      })

      await waitFor(() => alice1Msgs.length === 1 && alice2Msgs.length === 1)
      assert.equal(alice1Msgs[0].data, 'hello-alice-all-tabs')
      assert.equal(alice1Msgs[0].peerId, 'peer-bob')
      assert.equal(alice1Msgs[0].userId, bobIdentity.userId)
      assert.equal(alice2Msgs[0].data, 'hello-alice-all-tabs')
      assert.equal(alice2Msgs[0].peerId, 'peer-bob')
      assert.equal(alice2Msgs[0].userId, bobIdentity.userId)

      // 4. Overloaded target on request(data, {target: userId}) routes deterministically to 1 tab (lowest peerId)
      let alice1ReqCount = 0
      let alice2ReqCount = 0
      const rpcBob = roomBob.makeAction<string, string>('rpc', {
        kind: 'request'
      })
      roomAlice1.makeAction<string, string>('rpc', {
        kind: 'request',
        onRequest: (q, ctx) => {
          alice1ReqCount++
          return `from-alice-1:${q}:${ctx.userId}`
        }
      })
      roomAlice2.makeAction<string, string>('rpc', {
        kind: 'request',
        onRequest: (q, ctx) => {
          alice2ReqCount++
          return `from-alice-2:${q}:${ctx.userId}`
        }
      })

      const rpcResponse = await rpcBob.request('ping-user', {
        target: aliceIdentity.userId
      })
      assert.equal(
        rpcResponse,
        `from-alice-1:ping-user:${bobIdentity.userId}`,
        'request(userId) should route deterministically to lowest peerId (peer-alice-1)'
      )
      assert.equal(alice1ReqCount, 1)
      assert.equal(alice2ReqCount, 0)

      const manyResults = await rpcBob.requestMany('fanout-user', {
        targets: [aliceIdentity.userId]
      })
      assert.equal(manyResults.length, 1)
      assert.equal(manyResults[0].peerId, 'peer-alice-1')
      assert.equal(manyResults[0].userId, aliceIdentity.userId)
      assert.equal(manyResults[0].status, 'fulfilled')

      // 5. Alice's 1st tab leaves -> onPeerLeave fires, onUserLeave does NOT fire
      await roomAlice1.leave()
      await waitFor(
        () => bobPeerLeaves.some(e => e.peerId === 'peer-alice-1'),
        3_000
      )
      assert.equal(bobPeerLeaves.length, 1)
      assert.equal(bobPeerLeaves[0].peerId, 'peer-alice-1')
      assert.equal(bobPeerLeaves[0].userId, aliceIdentity.userId)
      assert.equal(
        bobUserLeaves.length,
        0,
        'onUserLeave must NOT fire while Alice still has tab 2 open'
      )
      assert.deepEqual(roomBob.getUsers()[aliceIdentity.userId].peerIds, [
        'peer-alice-2'
      ])

      // Now request(aliceIdentity.userId) routes to Alice's remaining tab (peer-alice-2)
      const rpcResponse2 = await rpcBob.request('ping-user-2', {
        target: aliceIdentity.userId
      })
      assert.equal(
        rpcResponse2,
        `from-alice-2:ping-user-2:${bobIdentity.userId}`
      )
      assert.equal(alice2ReqCount, 1)

      // 6. Alice's 2nd (last) tab leaves -> both onPeerLeave and onUserLeave fire!
      await roomAlice2.leave()
      await waitFor(
        () => bobPeerLeaves.some(e => e.peerId === 'peer-alice-2'),
        3_000
      )
      assert.equal(bobPeerLeaves.length, 2)
      assert.equal(bobUserLeaves.length, 1)
      assert.equal(bobUserLeaves[0].userId, aliceIdentity.userId)
      assert.equal(bobUserLeaves[0].peerId, 'peer-alice-2')
      assert.equal(roomBob.getUsers()[aliceIdentity.userId], undefined)
    } finally {
      await Promise.all([
        roomBob.leave().catch(() => {}),
        roomAlice1?.leave().catch(() => {}),
        roomAlice2?.leave().catch(() => {})
      ])
    }
  }
)

void test(
  'Security: DTLS fingerprint mismatch and forged overlay descriptors are rejected',
  {timeout: 10_000},
  async () => {
    const {makeJoinRoom} = createMemorySignalBus()
    const appId = `dtls-mitm-test-${Date.now()}`
    const roomId = 'secure-room'

    // 1. Simulate a MITM / relay forwarding attack where the connection's DTLS
    // remote fingerprint does not match the peer's signed DTLS fingerprint.
    class MitmRTCPeerConnection extends InMemoryRTCPeerConnection {
      constructor() {
        super()
        this.overrideRemoteDtlsFingerprint =
          'sha-256 FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF'
      }
    }

    const honestErrors: any[] = []
    const mitmErrors: any[] = []
    const honestJoins: any[] = []

    const honestRoom = makeJoinRoom()(
      {
        appId,
        _test_only_forcedPeerId: 'peer-honest',
        rtcPolyfill: InMemoryRTCPeerConnection as any
      },
      roomId,
      {onJoinError: err => honestErrors.push(err)}
    )
    honestRoom.onPeerJoin = ctx => honestJoins.push(ctx)

    const mitmRoom = makeJoinRoom()(
      {
        appId,
        _test_only_forcedPeerId: 'peer-mitm',
        rtcPolyfill: MitmRTCPeerConnection as any
      },
      roomId,
      {onJoinError: err => mitmErrors.push(err)}
    )

    try {
      await waitFor(
        () => honestErrors.length > 0 || mitmErrors.length > 0,
        3_000
      )
      const allErrors = [...honestErrors, ...mitmErrors]
      assert.ok(
        allErrors.some(e =>
          /DTLS fingerprint mismatch|peer identity verification failed/.test(
            e.error
          )
        ),
        'DTLS fingerprint mismatch must fail identity handshake'
      )
      assert.equal(honestJoins.length, 0, 'MITM peer must never be admitted')
    } finally {
      await Promise.all([
        honestRoom.leave().catch(() => {}),
        mitmRoom.leave().catch(() => {})
      ])
    }

    // 2. Verify multi-hop overlay descriptor self-certification and userProof
    const validUser = await createUserIdentity()
    const victimUser = await createUserIdentity()
    const validPeerUser = await createUserIdentity()
    const validPeerId = await derivePeerId(validPeerUser.signPubJwk)
    const validProof = await signUserEndpointProof(validUser, {
      appId,
      roomId,
      peerId: validPeerId,
      peerPubJwk: validPeerUser.signPubJwk,
      seq: 1
    })

    assert.equal(
      await verifyUserEndpointProof({
        appId,
        roomId,
        peerId: validPeerId,
        peerPubJwk: validPeerUser.signPubJwk,
        userId: validUser.userId,
        userPubJwk: validUser.signPubJwk,
        proof: validProof,
        seq: 1
      }),
      true
    )

    // Forged peerId with someone else's public key
    assert.equal(
      await verifyUserEndpointProof({
        appId,
        roomId,
        peerId: validPeerId,
        peerPubJwk: victimUser.signPubJwk,
        userId: validUser.userId,
        userPubJwk: validUser.signPubJwk,
        proof: validProof,
        seq: 1
      }),
      false
    )

    // Forged userId claim without valid userProof signature
    assert.equal(
      await verifyUserEndpointProof({
        appId,
        roomId,
        peerId: validPeerId,
        peerPubJwk: validPeerUser.signPubJwk,
        userId: victimUser.userId,
        userPubJwk: victimUser.signPubJwk,
        proof: validProof,
        seq: 1
      }),
      false
    )
  }
)

void test(
  'userId-level capacity limit: admits 2nd tab of an existing user at limit, while rejecting a new user',
  {timeout: 10_000},
  async () => {
    const {makeJoinRoom} = createMemorySignalBus()
    const appId = `limit-userid-${Date.now()}`
    const roomId = 'duel-tabs'

    const hostUser = await createUserIdentity()
    const aliceUser = await createUserIdentity()
    const intruderUser = await createUserIdentity()

    const hostRoom = makeJoinRoom()(
      {
        appId,
        _test_only_forcedPeerId: 'peer-host',
        identity: hostUser,
        limit: 2,
        rtcPolyfill: InMemoryRTCPeerConnection as any
      },
      roomId
    )

    const aliceTab1 = makeJoinRoom()(
      {
        appId,
        _test_only_forcedPeerId: 'peer-alice-1',
        identity: aliceUser,
        limit: 2,
        rtcPolyfill: InMemoryRTCPeerConnection as any
      },
      roomId
    )

    await waitFor(
      () =>
        'peer-alice-1' in hostRoom.getPeers() &&
        'peer-host' in aliceTab1.getPeers(),
      3_000
    )

    // Alice opens a 2nd tab with the same aliceUser in a limit: 2 room -> admitted!
    const aliceTab2Errors: any[] = []
    const aliceTab2 = makeJoinRoom()(
      {
        appId,
        _test_only_forcedPeerId: 'peer-alice-2',
        identity: aliceUser,
        limit: 2,
        rtcPolyfill: InMemoryRTCPeerConnection as any
      },
      roomId,
      {onJoinError: err => aliceTab2Errors.push(err)}
    )

    await waitFor(
      () =>
        'peer-alice-2' in hostRoom.getPeers() &&
        'peer-host' in aliceTab2.getPeers(),
      3_000
    )
    assert.deepEqual(aliceTab2Errors, [])
    assert.equal(Object.keys(hostRoom.getUsers()).length, 1)
    assert.equal(hostRoom.getUsers()[aliceUser.userId].peerIds.length, 2)

    // A 3rd distinct user (intruderUser) tries to join -> rejected with 'room full'!
    const intruderErrors: any[] = []
    const intruderRoom = makeJoinRoom()(
      {
        appId,
        _test_only_forcedPeerId: 'peer-intruder',
        identity: intruderUser,
        limit: 2,
        rtcPolyfill: InMemoryRTCPeerConnection as any
      },
      roomId,
      {onJoinError: err => intruderErrors.push(err)}
    )

    try {
      await waitFor(() => intruderErrors.length > 0, 3_000)
      assert.equal(intruderErrors[0].error, 'room full')
    } finally {
      await Promise.all([
        hostRoom.leave().catch(() => {}),
        aliceTab1.leave().catch(() => {}),
        aliceTab2.leave().catch(() => {}),
        intruderRoom.leave().catch(() => {})
      ])
    }
  }
)

void test(
  'Security & Multi-Tab Authority: userId roles work across tabs/reloads, userId bans block new tabs during handshake, and newcomers cannot poison room limit',
  {timeout: 15_000},
  async () => {
    const {makeJoinRoom} = createMemorySignalBus()
    const appId = `sec-multitab-auth-${Date.now()}`

    const adminUser = await createUserIdentity()
    const aliceUser = await createUserIdentity()
    const attackerUser = await createUserIdentity()

    let adminRoom: any
    let aliceTab1: any
    let aliceTab2: any
    let attackerTab1: any
    let attackerTab2: any
    let limiterRoom: any

    try {
      adminRoom = makeJoinRoom()(
        {
          appId,
          _test_only_forcedPeerId: 'peer-admin',
          identity: adminUser,
          ...roles(true),
          rtcPolyfill: InMemoryRTCPeerConnection as any
        },
        'activist-hq'
      )
      const authInfo = await adminRoom.getSelf()

      aliceTab1 = makeJoinRoom()(
        {
          appId,
          _test_only_forcedPeerId: 'peer-alice-1',
          identity: aliceUser,
          ...roles(),
          rtcPolyfill: InMemoryRTCPeerConnection as any
        },
        authInfo.roomId
      )

      await waitFor(
        () =>
          'peer-alice-1' in adminRoom.getPeers() &&
          'peer-admin' in aliceTab1.getPeers(),
        3_000
      )

      // Admin grants 'moderator' to Alice's userId while Alice is on Tab 1
      await adminRoom.grantRole(aliceUser.userId, 'moderator')
      await waitFor(() => aliceTab1.getRoles().includes('moderator'), 3_000)

      // Alice opens Tab 2 (or reloads with persistent userId -> new peerId 'peer-alice-2')
      aliceTab2 = makeJoinRoom()(
        {
          appId,
          _test_only_forcedPeerId: 'peer-alice-2',
          identity: aliceUser,
          ...roles(),
          rtcPolyfill: InMemoryRTCPeerConnection as any
        },
        authInfo.roomId
      )

      await waitFor(
        () =>
          'peer-alice-2' in adminRoom.getPeers() &&
          aliceTab2.getRoles().includes('moderator'),
        3_000
      )

      // Alice Tab 2 can send on a moderator-gated action AND update a moderator-gated state!
      const modAlertsAtAdmin: any[] = []
      adminRoom.makeAction<string>('mod-alert', {
        roles: 'moderator',
        onMessage: (msg, ctx) => modAlertsAtAdmin.push({msg, ...ctx})
      })
      const modAlertTab2 = aliceTab2.makeAction<string>('mod-alert', {
        roles: 'moderator'
      })

      const adminTopicState = adminRoom.makeState<string>('topic', 'initial', {
        roles: 'moderator'
      })
      const tab2TopicState = aliceTab2.makeState<string>('topic', 'initial', {
        roles: 'moderator'
      })

      await modAlertTab2.send('verified-from-tab-2')
      await waitFor(() => modAlertsAtAdmin.length === 1, 3_000)
      assert.equal(modAlertsAtAdmin[0].msg, 'verified-from-tab-2')
      assert.equal(modAlertsAtAdmin[0].peerId, 'peer-alice-2')
      assert.equal(modAlertsAtAdmin[0].userId, aliceUser.userId)
      assert.deepEqual(modAlertsAtAdmin[0].roles, ['moderator'])

      await tab2TopicState.set('updated-by-tab-2')
      await waitFor(() => adminTopicState.get() === 'updated-by-tab-2', 3_000)
      assert.equal(adminTopicState.getMeta()?.updatedBy, 'peer-alice-2')
      assert.equal(adminTopicState.getMeta()?.userId, aliceUser.userId)

      // Attacker joins, gets banned by userId, and then tries to evade the ban by opening a new tab with a fresh peerId
      attackerTab1 = makeJoinRoom()(
        {
          appId,
          _test_only_forcedPeerId: 'peer-attacker-1',
          identity: attackerUser,
          ...roles(),
          rtcPolyfill: InMemoryRTCPeerConnection as any
        },
        authInfo.roomId
      )
      await waitFor(() => 'peer-attacker-1' in adminRoom.getPeers(), 3_000)
      await adminRoom.ban(attackerUser.userId, {reason: 'disruptor'})
      await waitFor(() => !('peer-attacker-1' in adminRoom.getPeers()), 3_000)
      await attackerTab1.leave()

      const attackerTab2Errors: any[] = []
      attackerTab2 = makeJoinRoom()(
        {
          appId,
          _test_only_forcedPeerId: 'peer-attacker-2',
          identity: attackerUser,
          ...roles(),
          rtcPolyfill: InMemoryRTCPeerConnection as any
        },
        authInfo.roomId,
        {onJoinError: err => attackerTab2Errors.push(err)}
      )

      await waitFor(() => attackerTab2Errors.length > 0, 3_000)
      assert.ok(
        attackerTab2Errors.some(e => /peer banned/.test(e.error)),
        'banned userId opening a new tab must be rejected during handshake'
      )
      assert.equal('peer-attacker-2' in adminRoom.getPeers(), false)

      // Newcomer advertising limit: 1 cannot eject established members of an unlimited room
      const limiterUser = await createUserIdentity()
      const limiterErrors: any[] = []
      limiterRoom = makeJoinRoom()(
        {
          appId,
          _test_only_forcedPeerId: 'peer-limiter',
          identity: limiterUser,
          ...roles(),
          limit: 1,
          rtcPolyfill: InMemoryRTCPeerConnection as any
        },
        authInfo.roomId,
        {onJoinError: err => limiterErrors.push(err)}
      )

      await waitFor(() => limiterErrors.length > 0, 3_000)
      assert.equal(limiterErrors[0].error, 'room full')
      // Established members (admin + alice) must remain connected!
      assert.equal('peer-alice-1' in adminRoom.getPeers(), true)
      assert.equal('peer-alice-2' in adminRoom.getPeers(), true)
    } finally {
      await Promise.all([
        adminRoom?.leave().catch(() => {}),
        aliceTab1?.leave().catch(() => {}),
        aliceTab2?.leave().catch(() => {}),
        attackerTab1?.leave().catch(() => {}),
        attackerTab2?.leave().catch(() => {}),
        limiterRoom?.leave().catch(() => {})
      ])
    }
  }
)
