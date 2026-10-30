import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import test from './test.ts'
import * as corePublicExports from '../../packages/core/src/index.ts'
import {
  type RolesPluginApi,
  type Room,
  clearUserIdentity,
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
import {joinAsTestPeer, wait, waitFor} from './peer-harness.ts'

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
    Set<(topic: string, data: any) => void>
  >()

  const makeJoinRoom = (peerId?: string) => {
    const join = createTopicStrategy({
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
    return peerId ? joinAsTestPeer(peerId, join) : join
  }

  return {makeJoinRoom}
}

void test('Identity primitives: peerId is 20-char Base62, userId is 22-char Base62, fingerprint is eliminated, and selfId is not exported', async () => {
  const {peerId: selfId} = await getDefaultEndpointIdentity()
  assert.equal(typeof selfId, 'string')
  assert.equal(selfId.length, 20)
  assert.match(selfId, /^[0-9A-Za-z]{20}$/)

  const user = await createUserIdentity()
  assert.equal(typeof user.userId, 'string')
  assert.equal(user.userId.length, 22)
  assert.match(user.userId, /^[0-9A-Za-z]{22}$/)
  assert.notEqual(user.userId.length, selfId.length)
  assert.equal('fingerprint' in user, false)

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
  assert.equal('fingerprint' in importedFromStr, false)
  assert.equal(importedFromStr.userId, user.userId)
  assert.deepEqual(importedFromStr.publicKey, user.publicKey)

  for (const droppedHelper of [
    'selfId',
    'createAdminRoom',
    'computePublicKeyFingerprint',
    'computeUserIdFingerprint',
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

void test('Identity config validation & persistence modes: default local, none, and custom', async t => {
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

  // Rejects removed 'session', arbitrary strings, or un-imported key strings synchronously
  for (const invalidMode of ['session', 'sesion']) {
    assert.throws(
      () =>
        joinRoom(
          {
            appId: 'validation-app',
            identity: invalidMode as any,
            rtcPolyfill: InMemoryRTCPeerConnection as any
          },
          'room-1'
        ),
      /invalid custom user identity/i
    )
  }

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
  assert.throws(
    () =>
      joinRoom(
        {
          appId: 'validation-app',
          identity: {...tempUser, userId: '0'.repeat(22)},
          rtcPolyfill: InMemoryRTCPeerConnection as any
        },
        'room-1'
      ),
    /userId does not match signPubJwk/
  )
  assert.throws(
    () =>
      joinRoom(
        {
          appId: 'validation-app',
          identity: {...tempUser, userId: 'A'.repeat(43)},
          rtcPolyfill: InMemoryRTCPeerConnection as any
        },
        'room-1'
      ),
    /invalid custom user identity/
  )
  assert.throws(
    () => roles({admins: ['0'.repeat(20)]}),
    /invalid admin userId.*expected a 22-character Base62 userId/
  )

  const sessionStore = new Map<string, string>()
  const localStore = new Map<string, string>()
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
          transaction: () => ({
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
                    addReq.onerror?.({preventDefault: () => {}})
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
          }),
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

  const prevSession = (globalThis as any).sessionStorage
  const prevLocal = (globalThis as any).localStorage
  const prevIdb = (globalThis as any).indexedDB
  ;(globalThis as any).sessionStorage = makeMockStorage(sessionStore)
  ;(globalThis as any).localStorage = makeMockStorage(localStore)

  // Outside IndexedDB: default is silent 'none', while explicit 'local' warns and falls back to 'none' (no plaintext Web Storage fallback)
  const warnings: string[] = []
  const origWarn = console.warn
  console.warn = (...args: any[]) => {
    warnings.push(args.map(String).join(' '))
  }
  try {
    const noIdbDefaultRoom = makeJoinRoom('peer-noidb-d')(
      {
        appId: 'no-idb-default-app',
        rtcPolyfill: InMemoryRTCPeerConnection as any
      },
      'room-default'
    )
    const noIdbLocalRoom = makeJoinRoom('peer-noidb-l')(
      {
        appId: 'no-idb-app',
        identity: 'local',
        rtcPolyfill: InMemoryRTCPeerConnection as any
      },
      'room-local'
    )
    const [selfNoIdbD, selfNoIdbL] = await Promise.all([
      noIdbDefaultRoom.getSelf(),
      noIdbLocalRoom.getSelf()
    ])
    assert.equal(selfNoIdbD.persisted, false)
    assert.equal(selfNoIdbD.identityPersistence, 'none')
    assert.equal(selfNoIdbL.persisted, false)
    assert.equal(selfNoIdbL.identityPersistence, 'none')
    assert.notEqual(selfNoIdbD.userId, selfNoIdbL.userId)
    assert.equal(sessionStore.size, 0)
    assert.equal(localStore.size, 0)
    assert.equal(
      warnings.filter(w => /IndexedDB.*none/i.test(w)).length,
      1,
      'explicit identity: "local" must warn and fall back to "none" when IndexedDB is unavailable, while default stays silent'
    )
    await Promise.all([noIdbDefaultRoom.leave(), noIdbLocalRoom.leave()])
  } finally {
    console.warn = origWarn
  }

  ;(globalThis as any).indexedDB = mockIndexedDB

  try {
    // Default (omitted identity) uses 'local', reuses userId within same appId across tabs/rooms, and isolates across appIds
    const [dRoom1, dRoom2] = [
      makeJoinRoom('peer-d1')(
        {
          appId: 'app-local-1',
          rtcPolyfill: InMemoryRTCPeerConnection as any
        },
        'r1'
      ),
      makeJoinRoom('peer-d2')(
        {
          appId: 'app-local-1',
          rtcPolyfill: InMemoryRTCPeerConnection as any
        },
        'r2'
      )
    ]
    const dRoomOtherApp = makeJoinRoom('peer-d3')(
      {
        appId: 'app-local-2',
        rtcPolyfill: InMemoryRTCPeerConnection as any
      },
      'r1'
    )

    const [selfD1, selfD2, selfDOther] = await Promise.all([
      dRoom1.getSelf(),
      dRoom2.getSelf(),
      dRoomOtherApp.getSelf()
    ])

    assert.equal(selfD1.userId, selfD2.userId)
    assert.equal(selfD1.persisted, true)
    assert.equal(selfD1.identityPersistence, 'local')
    assert.notEqual(selfD1.peerId, selfD2.peerId)
    assert.notEqual(selfD1.userId, selfDOther.userId)
    assert.equal(sessionStore.size, 0)
    assert.equal(localStore.size, 0)

    await Promise.all([dRoom1.leave(), dRoom2.leave(), dRoomOtherApp.leave()])

    // Explicit identity: 'none' bypasses IndexedDB even when available
    const noneRoom = makeJoinRoom('peer-none-1')(
      {
        appId: 'app-none-explicit',
        identity: 'none',
        rtcPolyfill: InMemoryRTCPeerConnection as any
      },
      'r-none'
    )
    const selfNone = await noneRoom.getSelf()
    assert.equal(selfNone.persisted, false)
    assert.equal(selfNone.identityPersistence, 'none')
    assert.equal(idbStore.has('app-none-explicit'), false)
    await noneRoom.leave()

    // Custom loader receives {appId, roomId} and returns UserIdentity or exported key
    const customUser = await createUserIdentity()
    let loaderContext: any = null
    const cRoom = makeJoinRoom('peer-c1')(
      {
        appId: 'app-custom',
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
    ;(globalThis as any).indexedDB = prevIdb
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

    const roomBob = makeJoinRoom('peer-bob')(
      {
        appId,
        identity: bobIdentity,
        rtcPolyfill: InMemoryRTCPeerConnection as any
      },
      roomId
    )
    roomBob.onPeerJoin = ctx => bobPeerJoins.push(ctx)
    roomBob.onPeerLeave = ctx => bobPeerLeaves.push(ctx)
    roomBob.onUserJoin = ctx => bobUserJoins.push(ctx)
    roomBob.onUserLeave = ctx => bobUserLeaves.push(ctx)

    let roomAlice1: Room = null
    let roomAlice2: Room = null
    try {
      // 1. Alice's 1st tab joins
      roomAlice1 = makeJoinRoom('peer-alice-1')(
        {
          appId,
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
      roomAlice2 = makeJoinRoom('peer-alice-2')(
        {
          appId,
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
        onMessage: (data, ctx) => {
          alice1Msgs.push({data, ...ctx})
        }
      })
      roomAlice2.makeAction<string>('chat', {
        onMessage: (data, ctx) => {
          alice2Msgs.push({data, ...ctx})
        }
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

    const honestRoom = makeJoinRoom('peer-honest')(
      {
        appId,
        rtcPolyfill: InMemoryRTCPeerConnection as any
      },
      roomId,
      {onJoinError: err => honestErrors.push(err)}
    )
    honestRoom.onPeerJoin = ctx => honestJoins.push(ctx)

    const mitmRoom = makeJoinRoom('peer-mitm')(
      {
        appId,
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

    const hostRoom = makeJoinRoom('peer-host')(
      {
        appId,
        identity: hostUser,
        limit: 2,
        rtcPolyfill: InMemoryRTCPeerConnection as any
      },
      roomId
    )

    const aliceTab1 = makeJoinRoom('peer-alice-1')(
      {
        appId,
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
    const aliceTab2 = makeJoinRoom('peer-alice-2')(
      {
        appId,
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
    const intruderRoom = makeJoinRoom('peer-intruder')(
      {
        appId,
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

    let adminRoom: Room & RolesPluginApi
    let aliceTab1: Room & RolesPluginApi
    let aliceTab2: Room & RolesPluginApi
    let attackerTab1: Room & RolesPluginApi
    let attackerTab2: Room & RolesPluginApi
    let limiterRoom: Room & RolesPluginApi

    try {
      adminRoom = makeJoinRoom('peer-admin')(
        {
          appId,
          identity: adminUser,
          use: [roles({selfAsAdmin: true})],
          rtcPolyfill: InMemoryRTCPeerConnection as any
        },
        'activist-hq'
      )
      const authInfo = await adminRoom.getSelf()

      aliceTab1 = makeJoinRoom('peer-alice-1')(
        {
          appId,
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
      aliceTab2 = makeJoinRoom('peer-alice-2')(
        {
          appId,
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
        onMessage: (msg, ctx) => {
          modAlertsAtAdmin.push({msg, ...ctx})
        }
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
      attackerTab1 = makeJoinRoom('peer-attacker-1')(
        {
          appId,
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
      attackerTab2 = makeJoinRoom('peer-attacker-2')(
        {
          appId,
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

      // Newcomer advertising limit: 1 refuses other users locally without self-evicting or ejecting established members
      const limiterUser = await createUserIdentity()
      const limiterErrors: any[] = []
      limiterRoom = makeJoinRoom('peer-000-limiter')(
        {
          appId,
          identity: limiterUser,
          use: [roles()],
          limit: 1,
          rtcPolyfill: InMemoryRTCPeerConnection as any
        },
        authInfo.roomId,
        {onJoinError: err => limiterErrors.push(err)}
      )

      await wait(200)
      assert.deepEqual(limiterErrors, [])
      assert.deepEqual(Object.keys(limiterRoom.getPeers()), [])
      assert.equal('peer-000-limiter' in adminRoom.getPeers(), false)
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

    assert.equal(room.getCapturedSelfId, undefined)
    await room.ready
    assert.equal(typeof room.getCapturedSelfId, 'function')

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
  const typesDtsContent = readFileSync(
    resolve(import.meta.dirname, '../../packages/core/dist/types.d.mts'),
    'utf8'
  )
  const distBundles = ['strategy.mjs', 'identity.mjs', 'room.mjs']
    .map(name =>
      readFileSync(
        resolve(import.meta.dirname, `../../packages/core/dist/${name}`),
        'utf8'
      )
    )
    .join('\n')

  for (const forbidden of [
    'forcedPeerId',
    'scopeAppId',
    'registerTestForcedPeerId',
    'endpointIdentityByPeerId',
    'registeredTestForcedPeerIds',
    'resolvedTestEndpointCanonicalJwk',
    'getDefaultTestUserIdentity',
    'setDevIdentityProvider',
    'devIdentityProvider',
    'TestOnlyRoomConfig'
  ]) {
    assert.equal(
      distBundles.includes(forbidden),
      false,
      `production dist bundle must not contain "${forbidden}"`
    )
    assert.equal(
      dtsContent.includes(forbidden),
      false,
      `built index.d.mts must not contain "${forbidden}"`
    )
    assert.equal(
      typesDtsContent.includes(forbidden),
      false,
      `built types.d.mts must not contain "${forbidden}"`
    )
  }
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
  const {makeJoinRoom} = createMemorySignalBus()
  const joinRoom = makeJoinRoom()

  assert.throws(
    () => definePlugin('ready', {setup: () => ({})}),
    /plugin name "ready" is a reserved room property/
  )
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
  await assert.rejects(
    () =>
      joinRoom(
        {
          appId: 'shadow-test',
          use: [shadowLeavePlugin],
          rtcPolyfill: InMemoryRTCPeerConnection as any
        },
        'room-shadow-1'
      ).ready,
    /cannot override reserved room property "leave"/
  )

  const shadowGetPeersPlugin = definePlugin('shadow-peers', {
    setup: () => ({
      getPeers: () => ({})
    })
  })
  await assert.rejects(
    () =>
      joinRoom(
        {
          appId: 'shadow-test',
          use: [shadowGetPeersPlugin],
          rtcPolyfill: InMemoryRTCPeerConnection as any
        },
        'room-shadow-2'
      ).ready,
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

  await assert.rejects(
    () =>
      joinRoom(
        {
          appId: 'dup-api-test',
          use: [pluginA, pluginB],
          rtcPolyfill: InMemoryRTCPeerConnection as any
        },
        'room-dup-2'
      ).ready,
    /defines duplicate room property "sharedFn"/
  )
})

void test('Default local identity with IndexedDB: stores non-extractable CryptoKey without touching Web Storage, suppresses ephemeral admin warning, and reuses persistent userId across rooms', async t => {
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
                },
                put: (val: any, key: string) => {
                  const putReq: any = {
                    onsuccess: null,
                    onerror: null
                  }
                  queueMicrotask(() => {
                    idbStore.set(key, val)
                    putReq.onsuccess?.()
                  })
                  return putReq
                },
                delete: (key: string) => {
                  const delReq: any = {
                    onsuccess: null,
                    onerror: null
                  }
                  queueMicrotask(() => {
                    idbStore.delete(key)
                    delReq.onsuccess?.()
                  })
                  return delReq
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

  // 1. Default identity stores a non-extractable CryptoKey in IndexedDB keyed by appId, never writes to Web Storage, and does not warn on selfAsAdmin
  const warnings: string[] = []
  const origWarn = console.warn
  console.warn = (...args: any[]) => {
    warnings.push(args.map(String).join(' '))
  }
  let selfTab1A: Awaited<ReturnType<Room['getSelf']>>
  try {
    const roomTab1A = joinRoom(
      {
        appId: 'idb-default-app',
        use: [roles({selfAsAdmin: true})],
        rtcPolyfill: InMemoryRTCPeerConnection as any
      },
      'room-a'
    )
    selfTab1A = await roomTab1A.getSelf()
    await roomTab1A.leave()
  } finally {
    console.warn = origWarn
  }

  assert.equal(
    warnings.some(w => w.includes('ephemeral identity')),
    false,
    'roles({selfAsAdmin: true}) with default browser IndexedDB identity must not warn'
  )
  assert.equal(sessionMap.size, 0, 'sessionStorage must not be touched')
  assert.equal(localMap.size, 0, 'localStorage must not be touched')

  const idbRecord = idbStore.get('idb-default-app')
  assert.ok(idbRecord, 'IndexedDB must store the local CryptoKey record')
  assert.equal(idbRecord.userId, selfTab1A.userId)
  assert.equal(
    idbRecord.privateKey.extractable,
    false,
    'CryptoKey in IndexedDB must be non-extractable (extractable: false)'
  )

  // Opening a new tab or refreshing reuses the non-extractable IndexedDB key and regains admin authority
  const roomTab2 = joinRoom(
    {
      appId: 'idb-default-app',
      use: [roles()],
      rtcPolyfill: InMemoryRTCPeerConnection as any
    },
    selfTab1A.roomId
  )
  const selfTab2 = await roomTab2.getSelf()
  assert.equal(
    selfTab2.userId,
    selfTab1A.userId,
    'another tab or reload must reuse the persistent local userId by default'
  )
  assert.equal(
    selfTab2.isAdmin,
    true,
    'rejoining self-certifying room with default browser identity must retain admin authority'
  )
  await roomTab2.leave()

  // 2. Default persistent local identity derives consistent self-certifying room IDs across rooms
  const hostRoom1 = joinRoom(
    {
      appId: 'my-admin-app',
      use: [roles({selfAsAdmin: true})],
      rtcPolyfill: InMemoryRTCPeerConnection as any
    },
    'friday-quiz'
  )
  const hostSelf = await hostRoom1.getSelf()
  assert.equal('fingerprint' in hostSelf, false)
  assert.equal(hostSelf.roomId, `friday-quiz~${hostSelf.userId}`)
  assert.equal(hostSelf.isAdmin, true)
  await hostRoom1.leave()

  const hostRoom2 = joinRoom(
    {
      appId: 'my-admin-app',
      use: [roles({selfAsAdmin: true})],
      rtcPolyfill: InMemoryRTCPeerConnection as any
    },
    'saturday-quiz'
  )
  const hostSelf2 = await hostRoom2.getSelf()
  assert.equal(
    hostSelf.userId,
    hostSelf2.userId,
    'same appId must reuse persistent local identity across rooms'
  )
  assert.equal(hostSelf2.roomId, `saturday-quiz~${hostSelf.userId}`)
  await hostRoom2.leave()

  const hostJoined = joinRoom(
    {
      appId: 'my-admin-app',
      use: [roles()],
      rtcPolyfill: InMemoryRTCPeerConnection as any
    },
    hostSelf.roomId
  )
  const rejoinedSelf = await hostJoined.getSelf()
  assert.equal(rejoinedSelf.userId, hostSelf.userId)
  assert.equal(
    rejoinedSelf.isAdmin,
    true,
    'rejoining a self-certifying room with default identity must retain admin authority'
  )
  await hostJoined.leave()

  // 3. clearUserIdentity(appId) validates appId, deletes only that appId from IndexedDB, rotates both userId and peerId, and serializes concurrent calls
  for (const badAppId of ['', '   ', undefined, null, 42]) {
    await assert.rejects(
      () => (clearUserIdentity as any)(badAppId),
      /appId is required/
    )
  }

  await clearUserIdentity('my-admin-app')
  assert.equal(
    idbStore.has('my-admin-app'),
    false,
    'clearUserIdentity must delete the target appId from IndexedDB'
  )
  assert.equal(
    idbStore.has('idb-default-app'),
    true,
    'clearUserIdentity must leave other appIds untouched in IndexedDB'
  )

  const postClearJoined = joinRoom(
    {
      appId: 'my-admin-app',
      use: [roles()],
      rtcPolyfill: InMemoryRTCPeerConnection as any
    },
    hostSelf.roomId
  )
  const postClearSelf = await postClearJoined.getSelf()
  assert.notEqual(
    postClearSelf.userId,
    hostSelf.userId,
    'rejoining after clearUserIdentity must generate a fresh userId'
  )
  assert.notEqual(
    postClearSelf.peerId,
    hostSelf.peerId,
    'rejoining in the same SPA runtime after clearUserIdentity must also rotate peerId'
  )
  assert.equal(
    postClearSelf.isAdmin,
    false,
    'cleared identity must no longer hold admin authority in previous self-certifying room'
  )
  await postClearJoined.leave()

  // Un-awaited clearUserIdentity followed immediately by joinRoom serializes cleanly
  const unawaitedClear = clearUserIdentity('my-admin-app')
  const immediateNextRoom = joinRoom(
    {
      appId: 'my-admin-app',
      rtcPolyfill: InMemoryRTCPeerConnection as any
    },
    'room-after-unawaited-clear'
  )
  const immediateNextSelf = await immediateNextRoom.getSelf()
  await unawaitedClear
  assert.notEqual(
    immediateNextSelf.userId,
    postClearSelf.userId,
    'joinRoom called synchronously after un-awaited clearUserIdentity must wait for deletion and create a new userId'
  )
  assert.notEqual(immediateNextSelf.peerId, postClearSelf.peerId)
  assert.equal(idbStore.get('my-admin-app')?.userId, immediateNextSelf.userId)
  await immediateNextRoom.leave()
})

void test('clearUserIdentity without IndexedDB resets runtime userId and peerId caches only for that appId', async () => {
  const {makeJoinRoom} = createMemorySignalBus()
  const joinRoom = makeJoinRoom()

  const roomA1 = joinRoom(
    {
      appId: 'clear-no-idb-a',
      rtcPolyfill: InMemoryRTCPeerConnection as any
    },
    'r1'
  )
  const roomB1 = joinRoom(
    {
      appId: 'clear-no-idb-b',
      rtcPolyfill: InMemoryRTCPeerConnection as any
    },
    'r1'
  )
  const [selfA1, selfB1] = await Promise.all([
    roomA1.getSelf(),
    roomB1.getSelf()
  ])
  await Promise.all([roomA1.leave(), roomB1.leave()])

  await clearUserIdentity('clear-no-idb-a')

  const roomA2 = joinRoom(
    {
      appId: 'clear-no-idb-a',
      rtcPolyfill: InMemoryRTCPeerConnection as any
    },
    'r1'
  )
  const roomB2 = joinRoom(
    {
      appId: 'clear-no-idb-b',
      rtcPolyfill: InMemoryRTCPeerConnection as any
    },
    'r1'
  )
  const [selfA2, selfB2] = await Promise.all([
    roomA2.getSelf(),
    roomB2.getSelf()
  ])
  await Promise.all([roomA2.leave(), roomB2.leave()])

  assert.notEqual(selfA2.userId, selfA1.userId)
  assert.notEqual(selfA2.peerId, selfA1.peerId)
  assert.equal(selfB2.userId, selfB1.userId)
  assert.equal(selfB2.peerId, selfB1.peerId)
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
  assert.equal(
    'makeState' in room,
    false,
    'plugin methods attach when room.ready resolves'
  )

  await room.ready
  assert.equal(typeof room.makeState, 'function')

  const counter = room.makeState('counter', 0)
  await counter.set(1)
  await counter.set(n => n + 1)
  // @ts-expect-error widened number state must reject string
  void counter.set('not-a-number').catch(() => {})
  assert.equal(counter.get(), 2)

  const label = room.makeState('label', 'initial')
  await label.set('updated')
  assert.equal(label.get(), 'updated')

  const flag = room.makeState('flag', false)
  await flag.set(true)
  assert.equal(flag.get(), true)

  const nested = room.makeState('nested', {
    count: 0,
    tags: ['a'],
    active: false
  })
  await nested.set({count: 2, tags: ['a', 'b'], active: true})
  assert.deepEqual(nested.get(), {count: 2, tags: ['a', 'b'], active: true})

  await room.leave()

  const coreExports = corePublicExports
  for (const pruned of [
    'hashWith',
    'sha1',
    'all',
    'entries',
    'getConfiguredPlugins',
    'keys',
    'pauseRelayReconnection',
    'resumeRelayReconnection',
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
  assert.equal(coreExports.libName, 'Trystero')

  for (const kept of [
    'createStrategy',
    'createTopicStrategy',
    'createRelayManager',
    'makeSocket',
    'getRelays',
    'hashTopic',
    'toJson',
    'fromJson',
    'encodeBytes',
    'decodeBytes',
    'genId',
    'roles',
    'scale',
    'definePlugin',
    'clearUserIdentity',
    'createUserIdentity',
    'exportUserIdentity',
    'importUserIdentity',
    'setRelayConnectivity'
  ]) {
    assert.equal(
      typeof (coreExports as Record<string, unknown>)[kept],
      'function',
      `"${kept}" must remain exported from @trystero-p2p/core`
    )
  }

  const distCore = await import('../../packages/core/dist/index.mjs')
  assert.equal(typeof distCore.clearUserIdentity, 'function')
  assert.equal('createAdminRoom' in distCore, false)
  for (const pkg of [
    'trystero',
    'nostr',
    'mqtt',
    'torrent',
    'firebase',
    'supabase',
    'ws-relay'
  ]) {
    const mod = await import(`../../packages/${pkg}/dist/index.mjs`)
    assert.equal(
      mod.clearUserIdentity,
      distCore.clearUserIdentity,
      `packages/${pkg} must re-export clearUserIdentity`
    )
    assert.equal(
      'createAdminRoom' in mod,
      false,
      `packages/${pkg} must not export createAdminRoom`
    )
    assert.equal(
      'createEvent' in mod,
      false,
      `packages/${pkg} must not leak Nostr createEvent`
    )
    assert.equal(
      'subscribe' in mod,
      false,
      `packages/${pkg} must not leak dead subscribe helper`
    )
  }

  // Importing trystero / @trystero-p2p/nostr must not invoke CSPRNG / keygen at import time
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
        import assert from 'node:assert/strict'
        import {resolve} from 'node:path'

        let rngCalls = 0
        const origGetRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto)
        globalThis.crypto.getRandomValues = array => {
          rngCalls += 1
          return origGetRandomValues(array)
        }

        await import(resolve('packages/nostr/dist/index.mjs'))
        await import(resolve('packages/trystero/dist/index.mjs'))
        assert.equal(rngCalls, 0, 'importing nostr/trystero must not run CSPRNG keygen')
      `
    ],
    {stdio: 'pipe'}
  )

  for (const strategyPkg of [
    'nostr',
    'mqtt',
    'torrent',
    'firebase',
    'supabase',
    'ws-relay'
  ]) {
    const strategyDts = readFileSync(
      resolve(process.cwd(), `packages/${strategyPkg}/dist/index.d.mts`),
      'utf8'
    )
    assert.equal(
      strategyDts.includes('export type *'),
      false,
      `packages/${strategyPkg}/dist/index.d.mts must not wildcard re-export core types`
    )
    const exportedNames = new Set<string>()
    for (const m of strategyDts.matchAll(
      /^export (?:type|interface|declare const) (\w+)\b/gm
    )) {
      if (m[1]) {
        exportedNames.add(m[1])
      }
    }
    for (const m of strategyDts.matchAll(/^export \{([^}]+)\}/gm)) {
      for (const part of (m[1] ?? '').split(',')) {
        const cleaned = part
          .trim()
          .replace(/^type\s+/, '')
          .split(/\s+as\s+/)
          .at(-1)
          ?.trim()
        if (cleaned) {
          exportedNames.add(cleaned)
        }
      }
    }

    for (const leaked of [
      'ActionOptions',
      'AuthoritativeStateRecord',
      'BaseRelayConfig',
      'BaseRoomConfig',
      'InferPluginApi',
      'InternalAction',
      'JoinErrorHandler',
      'JoinRoom',
      'JsonPrimitive',
      'KernelRolesProvider',
      'KernelScaleProvider',
      'MaybePromise',
      'OfferRecord',
      'PeerBanRecord',
      'PeerHandle',
      'PeerHandlers',
      'ResolvedIdentityPersistence',
      'RoleRevocationRecord',
      'RoomKernel',
      'Signal',
      'SignalPeer',
      'SocketClient',
      'StrategyAdapter',
      'StrategyContext',
      'StrategyMessage',
      'StrategyOnMessage',
      'TargetPeers',
      'TopicPublishContext',
      'TopicStrategyAdapter',
      'TopicSubscriptionContext',
      'UserIdentityPersistence',
      'WsRelayClientMessage',
      'WsRelayServerMessage',
      'createEvent',
      'subscribe'
    ]) {
      assert.equal(
        exportedNames.has(leaked),
        false,
        `${leaked} must not be exported from packages/${strategyPkg}/dist/index.d.mts`
      )
    }
    for (const kept of [
      'Room',
      'RoomWithPlugins',
      'RoomPlugin',
      'MessageAction',
      'RequestAction',
      'SendOptions',
      'AuthoritativeState',
      'UserIdentity',
      'SelfInfo',
      'PeerInfo',
      'UserInfo'
    ]) {
      assert.equal(
        exportedNames.has(kept),
        true,
        `${kept} must remain exported from packages/${strategyPkg}/dist/index.d.mts`
      )
    }
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
    'RoomAuthorityInfo',
    'AdminRoomInfo',
    'createAdminRoom',
    'manualReconnection'
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
  assert.equal(indexDts.includes('RelayConnectivity'), true)
  assert.equal(indexDts.includes('setRelayConnectivity'), true)
})
