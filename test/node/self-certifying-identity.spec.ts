// @ts-nocheck
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import test from './test.ts'
import * as corePublicExports from '../../packages/core/src/index.ts'
import {
  createAdminRoom,
  createTopicStrategy,
  createUserIdentity,
  definePlugin,
  exportUserIdentity,
  importUserIdentity,
  roles
} from '../../packages/core/src/index.ts'
import {
  derivePeerId,
  deriveUserId,
  getDefaultEndpointIdentity,
  signUserEndpointProof,
  verifyPeerIdKey,
  verifyUserEndpointProof,
  verifyUserIdKey
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

  const makeJoinRoom = () =>
    createTopicStrategy({
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

  return {makeJoinRoom}
}

void test('Identity primitives: peerId is 20-char Base62, selfId is not exported, and userId is 43-char Base64url JWK thumbprint', async () => {
  const {peerId: selfId} = await getDefaultEndpointIdentity()
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
  assert.equal('userKey' in user, false)
  assert.ok(exported.startsWith('trystero_uk_'))
  const importedFromStr = await importUserIdentity(exported)
  assert.equal('userKey' in importedFromStr, false)
  assert.equal(importedFromStr.userId, user.userId)
  assert.deepEqual(importedFromStr.publicKey, user.publicKey)

  for (const droppedHelper of [
    'selfId',
    'computePublicKeyFingerprint',
    'formatSelfCertifyingRoomId',
    'parseSelfCertifyingRoomId',
    'derivePeerId',
    'deriveUserId',
    'verifyPeerIdKey',
    'verifyUserIdKey',
    'extractPlugins',
    'isPlugin'
  ]) {
    assert.equal(
      droppedHelper in corePublicExports,
      false,
      `${droppedHelper} must not be publicly exported`
    )
  }

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

  // Rejects arbitrary strings or un-imported key strings synchronously
  assert.throws(
    () =>
      joinRoom(
        {
          appId: 'validation-app',
          identity: 'sesion' as any,
          rtcPolyfill: InMemoryRTCPeerConnection as any
        },
        'room-1'
      ),
    /invalid custom user identity/i
  )

  const tempUser = await createUserIdentity()
  assert.throws(
    () =>
      joinRoom(
        {
          appId: 'validation-app',
          identity: exportUserIdentity(tempUser) as any,
          rtcPolyfill: InMemoryRTCPeerConnection as any
        },
        'room-1'
      ),
    /importUserIdentity/
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
          return importUserIdentity(exportUserIdentity(customUser))
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
          use: [roles({selfAsAdmin: true})],
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
          use: [roles()],
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
          use: [roles()],
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
          use: [roles()],
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
          use: [roles()],
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
          use: [roles()],
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

void test('Production build (no DEV labels): custom plugin setup(kernel) sees resolved 20-char kernel.selfId on the first room, and built .d.mts omits _test_only_* and __config', () => {
  const distIndexMjs = resolve(
    import.meta.dirname,
    '../../packages/core/dist/index.mjs'
  )
  const distIndexDmts = resolve(
    import.meta.dirname,
    '../../packages/core/dist/index.d.mts'
  )

  const script = `
    import assert from 'node:assert/strict'
    import {createTopicStrategy, definePlugin} from ${JSON.stringify(distIndexMjs)}

    let setupSelfId = null
    const customPlugin = definePlugin('custom-selfid-check', {
      setup(kernel) {
        setupSelfId = kernel.selfId
        return {
          getCapturedSelfId: () => setupSelfId
        }
      }
    })

    const joinRoom = createTopicStrategy({
      init: () => ({}),
      subscribeTopic: () => () => {},
      publishTopic: () => {}
    })

    const room = joinRoom(
      {
        appId: 'prod-first-room-app',
        use: [customPlugin]
      },
      'room-1'
    )

    const self = await room.getSelf()
    assert.equal(typeof setupSelfId, 'string')
    assert.match(setupSelfId, /^[0-9A-Za-z]{20}$/, 'kernel.selfId in setup() must be a resolved 20-char peerId in production build')
    assert.equal(setupSelfId, self.peerId)
    assert.equal(room.getCapturedSelfId(), self.peerId)
    await room.leave()
  `

  execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    stdio: 'pipe'
  })

  const dtsContent = readFileSync(distIndexDmts, 'utf8')
  assert.equal(
    dtsContent.includes('_test_only_forcedPeerId'),
    false,
    'built .d.mts must not expose _test_only_forcedPeerId'
  )
  assert.equal(
    dtsContent.includes('_test_only_mdnsHostFallbackToLoopback'),
    false,
    'built .d.mts must not expose _test_only_mdnsHostFallbackToLoopback'
  )
  assert.equal(
    dtsContent.includes('__config?:'),
    false,
    'built .d.mts must hide phantom config behind a unique symbol'
  )
})

void test('Plugin API safety: rejects reserved room property names, duplicate plugin names, and duplicate plugin API property names', async () => {
  await getDefaultEndpointIdentity()
  const {makeJoinRoom} = createMemorySignalBus()
  const joinRoom = makeJoinRoom()

  assert.throws(
    () => definePlugin('leave', {setup: () => ({})}),
    /plugin name "leave" is a reserved room property/
  )
  assert.throws(
    () => definePlugin('onPeerJoin', {setup: () => ({})}),
    /plugin name "onPeerJoin" is a reserved room property/
  )

  const shadowLeavePlugin = definePlugin('shadow-leave', {
    setup: () => ({
      leave: () => Promise.resolve()
    })
  })
  assert.throws(
    () =>
      joinRoom(
        {
          appId: 'shadow-test',
          use: [shadowLeavePlugin],
          rtcPolyfill: InMemoryRTCPeerConnection as any
        },
        'room-shadow-1'
      ),
    /cannot override reserved room property "leave"/
  )

  const shadowGetPeersPlugin = definePlugin('shadow-peers', {
    setup: () => ({
      getPeers: () => ({})
    })
  })
  assert.throws(
    () =>
      joinRoom(
        {
          appId: 'shadow-test',
          use: [shadowGetPeersPlugin],
          rtcPolyfill: InMemoryRTCPeerConnection as any
        },
        'room-shadow-2'
      ),
    /cannot override reserved room property "getPeers"/
  )

  const pluginA = definePlugin('plugin-a', {
    setup: () => ({sharedFn: () => 1})
  })
  const pluginB = definePlugin('plugin-b', {
    setup: () => ({sharedFn: () => 2})
  })

  assert.throws(
    () =>
      joinRoom(
        {
          appId: 'dup-plugin-test',
          use: [pluginA, pluginA],
          rtcPolyfill: InMemoryRTCPeerConnection as any
        },
        'room-dup-1'
      ),
    /duplicate plugin "plugin-a"/
  )

  assert.throws(
    () =>
      joinRoom(
        {
          appId: 'dup-api-test',
          use: [pluginA, pluginB],
          rtcPolyfill: InMemoryRTCPeerConnection as any
        },
        'room-dup-2'
      ),
    /defines duplicate room property "sharedFn"/
  )
})

void test('Session identity with IndexedDB: stores non-extractable CryptoKey keyed by per-tab sessionStorage token, and createAdminRoom(appId, baseRoomId) reuses local identity', async t => {
  for (const name of ['sessionStorage', 'localStorage', 'indexedDB']) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
    t.after(() => {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor)
      } else {
        delete globalThis[name]
      }
    })
  }

  const sessionMap = new Map<string, string>()
  const localMap = new Map<string, string>()
  const idbStore = new Map<string, any>()

  const makeMockStorage = (map: Map<string, string>) => ({
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v)
    },
    removeItem: (k: string) => {
      map.delete(k)
    }
  })

  const mockIndexedDB = {
    open: () => {
      const req: any = {
        result: {
          objectStoreNames: {
            contains: () => true
          },
          createObjectStore: () => ({}),
          transaction: () => {
            const tx: any = {
              objectStore: () => ({
                get: (key: string) => {
                  const getReq: any = {
                    result: idbStore.get(key),
                    onsuccess: null,
                    onerror: null
                  }
                  queueMicrotask(() => getReq.onsuccess?.())
                  return getReq
                },
                add: (val: any, key: string) => {
                  const addReq: any = {
                    onsuccess: null,
                    onerror: null
                  }
                  queueMicrotask(() => {
                    if (idbStore.has(key)) {
                      addReq.onerror?.()
                    } else {
                      idbStore.set(key, val)
                      addReq.onsuccess?.()
                    }
                  })
                  return addReq
                }
              }),
              onabort: null,
              onerror: null
            }
            return tx
          },
          close: () => {}
        },
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null
      }
      queueMicrotask(() => req.onsuccess?.())
      return req
    }
  }

  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    writable: true,
    value: makeMockStorage(sessionMap)
  })
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: makeMockStorage(localMap)
  })
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    writable: true,
    value: mockIndexedDB
  })

  const {makeJoinRoom} = createMemorySignalBus()
  const joinRoom = makeJoinRoom()

  // 1. 'session' identity stores only an opaque token in sessionStorage and a non-extractable CryptoKey in IndexedDB
  const roomTab1A = joinRoom(
    {
      appId: 'idb-session-app',
      identity: 'session',
      rtcPolyfill: InMemoryRTCPeerConnection as any
    },
    'room-a'
  )
  const selfTab1A = await roomTab1A.getSelf()
  await roomTab1A.leave()

  const storedSessionToken = sessionMap.get(
    'trystero:user_identity:v1:session:idb-session-app'
  )
  assert.ok(storedSessionToken, 'sessionStorage must contain a per-tab token')
  assert.match(
    storedSessionToken,
    /^[0-9A-Za-z]{24}$/,
    'sessionStorage token must be an opaque 24-char Base62 tab token, not a serialized private key'
  )
  assert.equal(
    storedSessionToken.includes('trystero_uk_'),
    false,
    'sessionStorage must never contain an exported private key when IndexedDB is available'
  )

  const idbRecord = idbStore.get(
    `session:idb-session-app:${storedSessionToken}`
  )
  assert.ok(idbRecord, 'IndexedDB must store the session CryptoKey record')
  assert.equal(idbRecord.userId, selfTab1A.userId)
  assert.equal(
    idbRecord.privateKey.extractable,
    false,
    'Session CryptoKey in IndexedDB must be non-extractable (extractable: false)'
  )

  // Refreshing the same tab (same sessionMap token) reuses the non-extractable IndexedDB key
  const roomTab1Refresh = joinRoom(
    {
      appId: 'idb-session-app',
      identity: 'session',
      rtcPolyfill: InMemoryRTCPeerConnection as any
    },
    'room-b'
  )
  const selfTab1Refresh = await roomTab1Refresh.getSelf()
  assert.equal(
    selfTab1Refresh.userId,
    selfTab1A.userId,
    'same tab refresh must reuse the non-extractable session identity'
  )
  await roomTab1Refresh.leave()

  // Opening a new tab (fresh sessionStorage) generates a distinct session identity
  sessionMap.clear()
  const roomTab2 = joinRoom(
    {
      appId: 'idb-session-app',
      identity: 'session',
      rtcPolyfill: InMemoryRTCPeerConnection as any
    },
    'room-a'
  )
  const selfTab2 = await roomTab2.getSelf()
  assert.notEqual(
    selfTab2.userId,
    selfTab1A.userId,
    'new tab with empty sessionStorage must get a distinct session userId'
  )
  await roomTab2.leave()

  // 2. createAdminRoom(appId, baseRoomId) requires appId first and defaults to persistent 'local' identity for appId
  await assert.rejects(
    () => (createAdminRoom as any)('', 'room-x'),
    /appId is required/
  )
  await assert.rejects(
    () => (createAdminRoom as any)('my-admin-app', ''),
    /baseRoomId is required/
  )

  const adminRoom1 = await createAdminRoom('my-admin-app', 'friday-quiz')
  const adminRoom2 = await createAdminRoom('my-admin-app', 'saturday-quiz')
  assert.equal(
    adminRoom1.userId,
    adminRoom2.userId,
    'createAdminRoom with same appId must reuse persistent local identity'
  )
  assert.equal(adminRoom1.fingerprint, adminRoom2.fingerprint)

  const hostJoined = joinRoom(
    {
      appId: 'my-admin-app',
      identity: 'local',
      use: [roles()],
      rtcPolyfill: InMemoryRTCPeerConnection as any
    },
    adminRoom1.roomId
  )
  const hostSelf = await hostJoined.getSelf()
  assert.equal(hostSelf.userId, adminRoom1.userId)
  assert.equal(
    hostSelf.isAdmin,
    true,
    'joining a room created with createAdminRoom(appId, baseRoomId) using identity: "local" must have admin authority'
  )
  await hostJoined.leave()
})

void test('makeState widens primitive literals, isPassive is removed, and core exports/types are pruned', async () => {
  const {makeJoinRoom} = createMemorySignalBus()
  const joinRoom = makeJoinRoom()

  const room = joinRoom(
    {
      appId: 'state-widening-app',
      identity: 'none',
      use: [roles({selfAsAdmin: true})],
      rtcPolyfill: InMemoryRTCPeerConnection as any
    },
    'state-widening-room'
  )

  assert.equal(
    'isPassive' in room,
    false,
    'isPassive() method must be removed from Room'
  )

  const counter = room.makeState('counter', 0)
  await counter.set(1)
  await counter.set(n => n + 1)
  assert.equal(counter.get(), 2)

  const label = room.makeState('label', 'initial')
  await label.set('updated')
  assert.equal(label.get(), 'updated')

  const flag = room.makeState('flag', false)
  await flag.set(true)
  assert.equal(flag.get(), true)

  const mode = room.makeState<'a' | 'b'>('mode', 'a')
  await mode.set('b')
  // @ts-expect-error explicit union type parameter must still reject 'c'
  void mode.set('c').catch(() => {})
  assert.equal(mode.get(), 'b')

  await room.leave()

  const coreExports = await import('../../packages/core/src/index.ts')
  for (const pruned of [
    'hashWith',
    'all',
    'entries',
    'getConfiguredPlugins',
    'keys',
    'libName',
    'socketGetter',
    'strToNum',
    'toHex',
    'values'
  ]) {
    assert.equal(
      pruned in coreExports,
      false,
      `"${pruned}" must not be exported from @trystero-p2p/core`
    )
  }

  for (const kept of [
    'createStrategy',
    'createTopicStrategy',
    'createRelayManager',
    'makeSocket',
    'getRelays',
    'sha1',
    'toJson',
    'fromJson',
    'encodeBytes',
    'decodeBytes',
    'genId',
    'createAdminRoom',
    'roles',
    'scale',
    'definePlugin',
    'createUserIdentity',
    'exportUserIdentity',
    'importUserIdentity',
    'pauseRelayReconnection',
    'resumeRelayReconnection'
  ]) {
    assert.equal(
      typeof (coreExports as Record<string, unknown>)[kept],
      'function',
      `"${kept}" must remain exported from @trystero-p2p/core`
    )
  }

  const indexDts = readFileSync(
    resolve(process.cwd(), 'packages/core/dist/index.d.mts'),
    'utf8'
  )
  const typesDts = readFileSync(
    resolve(process.cwd(), 'packages/core/dist/types.d.mts'),
    'utf8'
  )
  for (const removedType of [
    'AuthorityConfig',
    'TopologyConfig',
    'RolesInput',
    'RoomAuthorityInfo'
  ]) {
    assert.equal(
      indexDts.includes(removedType),
      false,
      `${removedType} must not appear in packages/core/dist/index.d.mts`
    )
    assert.equal(
      typesDts.includes(removedType),
      false,
      `${removedType} must not appear in packages/core/dist/types.d.mts`
    )
  }
  assert.equal(indexDts.includes('RolesConfig'), true)
  assert.equal(indexDts.includes('ScaleConfig'), true)
})
