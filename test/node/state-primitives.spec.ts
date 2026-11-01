import assert from 'node:assert/strict'
import test from './test.ts'
import {
  type JsonValue,
  type Room,
  type RoomError,
  type SharedState,
  type StrategyMessage,
  type UserIdentity,
  type UserState,
  createTopicStrategy,
  createUserIdentity,
  roles,
  scale
} from '../../packages/core/src/index.ts'
import {
  compareStateRecords,
  createStateManager,
  maxUnregisteredSlots,
  maxUserStateNamespacesPerUser,
  signStateRecord
} from '../../packages/core/src/state.ts'
import {decodeBytes} from '../../packages/core/src/utils.ts'
import {joinAsTestPeer, wait, waitFor} from './peer-harness.ts'

class LinkedDataChannel {
  label: string
  ordered = true
  readyState: 'connecting' | 'open' | 'closing' | 'closed' = 'connecting'
  binaryType = 'arraybuffer'
  bufferedAmount = 0
  bufferedAmountLowThreshold = 0
  onmessage: ((ev: {data: ArrayBuffer | string}) => void) | null = null
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  partner: LinkedDataChannel | null = null
  listeners: Record<string, Set<(...args: unknown[]) => void>> = {}
  onSendHook: ((payload: ArrayBuffer | string) => void) | null = null

  constructor(label = 'trystero') {
    this.label = label
  }

  addEventListener(event: string, fn: (...args: unknown[]) => void) {
    ;(this.listeners[event] ??= new Set()).add(fn)
  }

  removeEventListener(event: string, fn: (...args: unknown[]) => void) {
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
          : (data.buffer.slice(
              data.byteOffset,
              data.byteOffset + data.byteLength
            ) as ArrayBuffer)

    this.onSendHook?.(payload)

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
let globalChannelSendObserver:
  | ((payload: ArrayBuffer | string) => void)
  | null = null

class InMemoryRTCPeerConnection {
  iceGatheringState = 'complete'
  connectionState = 'new'
  iceConnectionState = 'new'
  signalingState = 'stable'
  localDescription: {type: string; sdp: string} | null = null
  remoteDescription: {type: string; sdp: string} | null = null
  onnegotiationneeded: (() => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  ontrack: ((ev: unknown) => void) | null = null
  ondatachannel: ((ev: {channel: LinkedDataChannel}) => void) | null = null
  listeners: Record<string, Set<(...args: unknown[]) => void>> = {}
  dataChannel: LinkedDataChannel | null = null
  matchedOfferPc: InMemoryRTCPeerConnection | null = null
  partnerPc: InMemoryRTCPeerConnection | null = null
  dtlsFingerprint = `sha-256 AA:BB:CC:EE:${(++sdpCounter).toString(16).padStart(4, '0')}`

  createDataChannel(label: string) {
    const ch = new LinkedDataChannel(label)
    ch.onSendHook = payload => globalChannelSendObserver?.(payload)
    this.dataChannel = ch
    return ch
  }

  addEventListener(event: string, fn: (...args: unknown[]) => void) {
    ;(this.listeners[event] ??= new Set()).add(fn)
  }

  removeEventListener(event: string, fn: (...args: unknown[]) => void) {
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
    this.remoteDescription = description
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
      offerCh.onSendHook = payload => globalChannelSendObserver?.(payload)
      const answerCh = new LinkedDataChannel(offerCh.label)
      answerCh.onSendHook = payload => globalChannelSendObserver?.(payload)
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

const rtcPolyfill =
  InMemoryRTCPeerConnection as unknown as typeof RTCPeerConnection

const createMemorySignalBus = () => {
  const topicHandlers = new Map<
    string,
    Set<(topic: string, data: StrategyMessage) => void>
  >()

  const makeJoinRoom = (peerSeed?: string) => {
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
    return peerSeed ? joinAsTestPeer(peerSeed, join) : join
  }

  return {makeJoinRoom}
}

void test('TypeScript compile-time gating: roles option on makeState and makeUserState requires roles() plugin, and RoomWithPlugins remains assignable to Room', () => {
  const {makeJoinRoom} = createMemorySignalBus()
  const joinRoom = makeJoinRoom()

  const openRoom = joinRoom(
    {appId: 'ts-check-app', rtcPolyfill},
    'open-ts-room'
  )
  const implicitNullState: SharedState<JsonValue> =
    openRoom.makeState('implicit')
  assert.equal(implicitNullState.get(), null)

  const implicitNullUser: UserState<JsonValue> =
    openRoom.makeUserState('implicit-u')
  assert.equal(implicitNullUser.get(), null)

  assert.throws(() => {
    // @ts-expect-error roles option is disallowed at compile time when roles() plugin is not in use
    openRoom.makeState('bad-roles', 0, {roles: ['admin']})
  }, /requires roles\(\)/)

  assert.throws(() => {
    // @ts-expect-error roles option is disallowed at compile time when roles() plugin is not in use
    openRoom.makeUserState('bad-user-roles', 0, {roles: ['admin']})
  }, /requires roles\(\)/)

  const rolesRoom = joinRoom(
    {appId: 'ts-check-app', rtcPolyfill, use: [roles({selfAsAdmin: true})]},
    'roles-ts-room'
  )
  const gatedState = rolesRoom.makeState('ok-roles', 0, {roles: ['admin']})
  const openInRoles = rolesRoom.makeState('open-override', 0, {roles: '*'})
  const gatedUser = rolesRoom.makeUserState('ok-user-roles', '', {
    roles: ['speaker']
  })
  assert.equal(gatedState.get(), 0)
  assert.equal(openInRoles.get(), 0)
  assert.equal(gatedUser.get(), '')

  // Variance check: RoomWithPlugins<[typeof roles(...)]> is assignable to base Room
  const asBaseRoom: Room = rolesRoom
  assert.equal(typeof asBaseRoom.makeState, 'function')
  assert.equal(typeof asBaseRoom.makeUserState, 'function')

  void openRoom.leave()
  void rolesRoom.leave()
})

void test('Open makeState (without roles()): synchronous availability, null default, multi-member convergence, late-joiner relay after author leaves, validate, maxBytes, and onChange options', async () => {
  const {makeJoinRoom} = createMemorySignalBus()
  const joinA = makeJoinRoom('open-state-a')
  const joinB = makeJoinRoom('open-state-b')
  const joinC = makeJoinRoom('open-state-c')

  const roomA = joinA({appId: 'open-state-app', rtcPolyfill}, 'room-1')
  const roomB = joinB({appId: 'open-state-app', rtcPolyfill}, 'room-1')

  // Available synchronously right after joinRoom() without awaiting room.ready
  const implicitA = roomA.makeState('implicit-ns')
  assert.equal(implicitA.get(), null)
  assert.equal(implicitA.getMeta(), null)

  // lockMethods prevents direct property overwrite on onChange
  assert.throws(() => {
    ;(implicitA as unknown as {onChange: unknown}).onChange = () => {}
  })

  assert.throws(
    () => roomA.makeState('too-big-cfg', 0, {maxBytes: 128 * 1024}),
    /maxBytes/
  )

  const counterA = roomA.makeState(
    'counter',
    {count: 0, note: 'init'},
    {
      maxBytes: 256,
      validate: next => next.count >= 0
    }
  )
  const counterB = roomB.makeState(
    'counter',
    {count: 0, note: 'init'},
    {
      maxBytes: 256,
      validate: next => next.count >= 0
    }
  )

  const seenB: Array<{val: {count: number; note: string}; prevCount: number}> =
    []
  counterB.onChange((val, ctx) => {
    seenB.push({val, prevCount: ctx.prev.count})
  })

  await waitFor(() => Object.keys(roomA.getUsers()).length === 1)

  // Any member can write in open mode
  await counterA.set({count: 1, note: 'from-a'})
  await waitFor(() => counterB.get().count === 1)
  assert.deepEqual(counterB.get(), {count: 1, note: 'from-a'})

  const selfA = await roomA.getSelf()
  assert.equal(counterB.getMeta()?.userId, selfA.userId)
  assert.equal(counterB.getMeta()?.peerId, selfA.peerId)
  assert.deepEqual(counterB.getMeta()?.roles, [])

  // Bob updates the same shared state without roles()
  await counterB.set(prev => ({count: prev.count + 4, note: 'from-b'}))
  await waitFor(() => counterA.get().count === 5)
  assert.deepEqual(counterA.get(), {count: 5, note: 'from-b'})
  assert.equal(seenB.length, 2)
  assert.equal(seenB[1]?.prevCount, 1)

  // Local validation failure and maxBytes failure reject
  await assert.rejects(
    () => counterA.set({count: -1, note: 'bad'}),
    /validation failed/
  )
  await assert.rejects(
    () => counterA.set({count: 6, note: 'x'.repeat(400)}),
    /maxBytes/
  )

  // Remote validation divergence defense: roomA writes via a permissive view on another namespace
  const strictB = roomB.makeState<number>('strict-even', 0, {
    validate: next => next % 2 === 0
  })
  const laxA = roomA.makeState<number>('strict-even', 0)
  await laxA.set(3) // invalid on B
  await wait(40)
  assert.equal(strictB.get(), 0)
  await laxA.set(4) // valid on B — views converge cleanly because validate checks next rather than local prev equality
  await waitFor(() => strictB.get() === 4)

  // Replay + once + AbortSignal options on onChange
  const replayed: number[] = []
  const unsubOnce = strictB.onChange(val => replayed.push(val), {
    replay: true,
    once: true
  })
  assert.deepEqual(replayed, [4])
  unsubOnce()

  const ac = new AbortController()
  const abortedSeen: number[] = []
  strictB.onChange(val => abortedSeen.push(val), {signal: ac.signal})
  ac.abort()
  await laxA.set(6)
  await waitFor(() => strictB.get() === 6)
  assert.deepEqual(abortedSeen, [])

  // Author B leaves, then late joiner C connects only to A and still receives B's signed state
  await roomB.leave()
  await waitFor(() => Object.keys(roomA.getUsers()).length === 0)

  const roomC = joinC({appId: 'open-state-app', rtcPolyfill}, 'room-1')
  const counterC = roomC.makeState('counter', {count: 0, note: 'init'})
  await waitFor(() => counterC.get().count === 5)
  assert.deepEqual(counterC.get(), {count: 5, note: 'from-b'})

  await Promise.all([roomA.leave(), roomC.leave()])
})

void test('makeState + roles(): fail-closed admin default, roles: "*" open override, custom roles, revocation, selfAsAdmin sync registration, and ban state purge', async () => {
  const {makeJoinRoom} = createMemorySignalBus()
  const hostId = await createUserIdentity()
  const modId = await createUserIdentity()
  const guestId = await createUserIdentity()

  const joinHost = makeJoinRoom('roles-host')
  const joinMod = makeJoinRoom('roles-mod')
  const joinGuest = makeJoinRoom('roles-guest')

  const hostRoom = joinHost(
    {
      appId: 'roles-state-app',
      rtcPolyfill,
      identity: hostId,
      use: [roles({selfAsAdmin: true})]
    },
    'arena'
  )

  // Registered synchronously BEFORE awaiting hostRoom.ready on selfAsAdmin room!
  const hostScore = hostRoom.makeState('score', 0)
  const hostChatTopic = hostRoom.makeState('open-topic', 'general', {
    roles: '*'
  })
  const hostModNotice = hostRoom.makeState('mod-notice', 'none', {
    roles: ['admin', 'mod']
  })
  const hostNick = hostRoom.makeUserState<string>('nick')
  void hostNick.set('HostAdmin')
  await hostScore.set(10)

  const {roomId: fullRoomId} = await hostRoom.getSelf()

  const modRoom = joinMod(
    {
      appId: 'roles-state-app',
      rtcPolyfill,
      identity: modId,
      use: [roles()]
    },
    fullRoomId
  )
  const guestRoom = joinGuest(
    {
      appId: 'roles-state-app',
      rtcPolyfill,
      identity: guestId,
      use: [roles()]
    },
    fullRoomId
  )

  const guestScore = guestRoom.makeState('score', 0)
  const guestChatTopic = guestRoom.makeState('open-topic', 'general', {
    roles: '*'
  })
  const modNoticeOnMod = modRoom.makeState('mod-notice', 'none', {
    roles: ['admin', 'mod']
  })
  const modNoticeOnGuest = guestRoom.makeState('mod-notice', 'none', {
    roles: ['admin', 'mod']
  })
  const guestNick = guestRoom.makeUserState<string>('nick')
  const hostNickOnHost = hostNick

  await Promise.all([modRoom.ready, guestRoom.ready])
  await waitFor(
    () =>
      Object.keys(hostRoom.getUsers()).length === 2 &&
      guestScore.get() === 10 &&
      guestNick.get(hostId.userId) === 'HostAdmin'
  )

  // 1. Fail-closed default: unprivileged guest cannot write to makeState('score', 0)
  await assert.rejects(() => guestScore.set(999), /insufficient authority/)
  assert.equal(hostScore.get(), 10)

  // 2. Open override (`roles: '*'`) inside a roles() room allows guest to write!
  await guestChatTopic.set('music-chat')
  await waitFor(() => hostChatTopic.get() === 'music-chat')
  assert.equal(hostChatTopic.getMeta()?.userId, guestId.userId)

  // Guest also publishes user state
  await guestNick.set('RowdyGuest')
  await waitFor(() => hostNickOnHost.get(guestId.userId) === 'RowdyGuest')

  // 3. Granting custom 'mod' role enables writing mod-gated state; revoking blocks subsequent writes
  await hostRoom.grantRole(modId.userId, 'mod')
  await waitFor(() => modRoom.getRoles().includes('mod'))

  await modNoticeOnMod.set('be-kind')
  await waitFor(
    () =>
      modNoticeOnGuest.get() === 'be-kind' && hostModNotice.get() === 'be-kind'
  )
  assert.deepEqual(modNoticeOnGuest.getMeta()?.roles, ['mod'])

  await hostRoom.revokeRole(modId.userId, 'mod')
  await waitFor(() => !modRoom.getRoles().includes('mod'))
  await assert.rejects(
    () => modNoticeOnMod.set('after-revoke'),
    /insufficient authority/
  )

  // 4. Banning guest immediately purges guest's open makeState record AND guest's makeUserState!
  const removedNicks: Array<{userId: string; removed: boolean}> = []
  hostNickOnHost.onChange((_val, ctx) => {
    if (ctx.removed) {
      removedNicks.push({userId: ctx.userId, removed: ctx.removed})
    }
  })

  await hostRoom.ban(guestId.userId, {reason: 'griefing'})
  await waitFor(() => hostChatTopic.get() === 'general')
  assert.equal(hostNickOnHost.has(guestId.userId), false)
  assert.equal(hostNickOnHost.get(guestId.userId), null)
  assert.ok(removedNicks.some(e => e.userId === guestId.userId && e.removed))

  await Promise.all([hostRoom.leave(), modRoom.leave(), guestRoom.leave()])
})

void test('makeUserState semantics: null vs explicit default, has(), frozen reference-stable getAll({onlineOnly}), self inclusion, clear() tombstones, write coalescing, and multi-tab convergence', async () => {
  const {makeJoinRoom} = createMemorySignalBus()
  const aliceId = await createUserIdentity()
  const bobId = await createUserIdentity()

  let aliceSignCalls = 0
  const instrumentedAliceId: UserIdentity = {
    ...aliceId,
    sign: async payload => {
      aliceSignCalls++
      return aliceId.sign(payload)
    }
  }

  const joinAliceTab1 = makeJoinRoom('u-alice-1')
  const joinAliceTab2 = makeJoinRoom('u-alice-2')
  const joinBob = makeJoinRoom('u-bob-1')

  const aliceTab1 = joinAliceTab1(
    {appId: 'user-state-app', rtcPolyfill, identity: instrumentedAliceId},
    'lobby'
  )
  const bobRoom = joinBob(
    {appId: 'user-state-app', rtcPolyfill, identity: bobId},
    'lobby'
  )

  const statusA1 = aliceTab1.makeUserState<string | null>('status')
  const statusBob = bobRoom.makeUserState<string | null>('status')
  const counterA1 = aliceTab1.makeUserState('clicks', 0)
  const counterBob = bobRoom.makeUserState('clicks', 0)

  // Before publishing: has() is false, get() returns initialValue, getAll() is empty & frozen & reference-stable
  await aliceTab1.ready
  assert.equal(statusA1.has(), false)
  assert.equal(statusA1.get(), null)
  assert.equal(counterA1.has(), false)
  assert.equal(counterA1.get(), 0)

  const emptySnap1 = statusA1.getAll()
  const emptySnap2 = statusA1.getAll()
  assert.equal(Object.is(emptySnap1, emptySnap2), true)
  assert.equal(Object.isFrozen(emptySnap1), true)
  assert.deepEqual(emptySnap1, {})

  await waitFor(() => Object.keys(aliceTab1.getUsers()).length === 1)

  // Explicit null publish sets has() === true and includes self in getAll()
  await statusA1.set(null)
  assert.equal(statusA1.has(), true)
  assert.equal(statusA1.get(), null)
  const selfSnap = statusA1.getAll()
  assert.notEqual(selfSnap, emptySnap1)
  assert.equal(Object.is(selfSnap, statusA1.getAll()), true)
  assert.deepEqual(selfSnap, {[aliceId.userId]: null})

  await waitFor(() => statusBob.has(aliceId.userId))
  assert.equal(statusBob.get(aliceId.userId), null)

  // Pending Batch Fold write coalescing: 50 rapid synchronous functional updates fold into <= 2 ECDSA signatures!
  const signsBeforeBurst = aliceSignCalls
  const burstPromises = Array.from({length: 50}, () =>
    counterA1.set(n => n + 1)
  )
  await Promise.all(burstPromises)
  const signsUsed = aliceSignCalls - signsBeforeBurst
  assert.ok(
    signsUsed >= 1 && signsUsed <= 2,
    `expected <= 2 signatures for 50 synchronous updates, got ${signsUsed}`
  )
  assert.equal(counterA1.get(), 50)
  await waitFor(() => counterBob.get(aliceId.userId) === 50)

  // Lookup by peerId as well as userId
  const aliceSelf = await aliceTab1.getSelf()
  assert.equal(counterA1.get(aliceSelf.peerId), 50)
  assert.equal(counterBob.get(aliceSelf.peerId), 50)
  assert.equal(counterA1.getMeta()?.self, true)
  assert.equal(counterBob.getMeta(aliceId.userId)?.self, false)

  // Multi-tab: Alice opens Tab 2 WITHOUT calling set() — must NOT clobber Tab 1, and receives Tab 1's state!
  await statusA1.set('coding')
  await waitFor(() => statusBob.get(aliceId.userId) === 'coding')

  const aliceTab2 = joinAliceTab2(
    {appId: 'user-state-app', rtcPolyfill, identity: aliceId},
    'lobby'
  )
  const statusA2 = aliceTab2.makeUserState<string | null>('status')
  await waitFor(() => statusA2.get() === 'coding')
  assert.equal(statusA2.has(), true)
  assert.equal(statusBob.get(aliceId.userId), 'coding')

  // Tab 2 updates Alice's state -> Tab 1 and Bob both converge
  await statusA2.set('in-tab-2')
  await waitFor(
    () =>
      statusA1.get() === 'in-tab-2' &&
      statusBob.get(aliceId.userId) === 'in-tab-2'
  )

  // Closing Tab 1 while Tab 2 remains open must NOT evict Alice's presence-scoped state on Bob or Tab 2!
  let bobSawAliceLeave = false
  bobRoom.onUserLeave(({userId}) => {
    if (userId === aliceId.userId) {
      bobSawAliceLeave = true
    }
  })
  await aliceTab1.leave()
  await wait(80)
  assert.equal(bobSawAliceLeave, false)
  assert.equal(statusBob.get(aliceId.userId), 'in-tab-2')
  assert.equal(statusA2.get(), 'in-tab-2')

  // clear() publishes a signed tombstone removing the entry everywhere
  const removalsOnBob: boolean[] = []
  statusBob.onChange((val, ctx) => {
    if (ctx.userId === aliceId.userId && ctx.removed) {
      assert.equal(val, undefined)
      assert.equal(ctx.prev, 'in-tab-2')
      removalsOnBob.push(true)
    }
  })
  await statusA2.clear()
  assert.equal(statusA2.has(), false)
  assert.equal(statusA2.get(), null)
  assert.deepEqual(statusA2.getAll(), {})
  await waitFor(() => !statusBob.has(aliceId.userId))
  assert.equal(removalsOnBob.length, 1)
  assert.deepEqual(statusBob.getAll(), {})

  await Promise.all([aliceTab2.leave(), bobRoom.leave()])
})

void test('Presence ordering: pre-join flush populates userState before onUserJoin/onPeerJoin, state remains readable inside onUserLeave then evicts, and room-full peers never leak userState', async () => {
  const {makeJoinRoom} = createMemorySignalBus()
  const hostId = await createUserIdentity()
  const guestId = await createUserIdentity()
  const extraId = await createUserIdentity()

  const join1 = makeJoinRoom('ord-1')
  const join2 = makeJoinRoom('ord-2')
  const join3 = makeJoinRoom('ord-3')

  const room1 = join1(
    {appId: 'order-app', rtcPolyfill, identity: hostId, limit: 2},
    'duel'
  )
  const name1 = room1.makeUserState('name', 'Stranger')
  void name1.set('HostOne')

  let nameAtPeerJoin = ''
  let nameAtUserJoin = ''
  let nameDuringUserLeave = ''
  let onlineSnapHadGuestDuringLeave = true

  room1.onPeerJoin(({userId}) => {
    if (userId === guestId.userId) {
      nameAtPeerJoin = name1.get(userId)
    }
  })
  room1.onUserJoin(({userId}) => {
    if (userId === guestId.userId) {
      nameAtUserJoin = name1.get(userId)
    }
  })
  room1.onUserLeave(({userId}) => {
    if (userId === guestId.userId) {
      nameDuringUserLeave = name1.get(userId)
      onlineSnapHadGuestDuringLeave = userId in name1.getAll({onlineOnly: true})
    }
  })

  // Guest sets name synchronously right after joinRoom() -> flushed via @_ustate0 BEFORE @_hsready!
  const room2 = join2(
    {appId: 'order-app', rtcPolyfill, identity: guestId, limit: 2},
    'duel'
  )
  const name2 = room2.makeUserState('name', 'Stranger')
  void name2.set('GuestTwo')

  let hostNameAtGuestJoin = ''
  room2.onUserJoin(({userId}) => {
    if (userId === hostId.userId) {
      hostNameAtGuestJoin = name2.get(userId)
    }
  })

  await waitFor(
    () =>
      Object.keys(room1.getUsers()).length === 1 &&
      Object.keys(room2.getUsers()).length === 1
  )

  assert.equal(
    nameAtPeerJoin,
    'GuestTwo',
    'userState must be populated synchronously inside onPeerJoin'
  )
  assert.equal(
    nameAtUserJoin,
    'GuestTwo',
    'userState must be populated synchronously inside onUserJoin'
  )
  assert.equal(
    hostNameAtGuestJoin,
    'HostOne',
    'initiator userState must also be populated inside responder onUserJoin'
  )

  // 3rd user attempts to join a full room (limit: 2) with pre-join userState -> rejected, never leaks!
  const errors3: RoomError[] = []
  const room3 = join3(
    {appId: 'order-app', rtcPolyfill, identity: extraId, limit: 2},
    'duel'
  )
  room3.onError(err => errors3.push(err))
  const name3 = room3.makeUserState('name', 'Stranger')
  void name3.set('IntruderThree')

  await waitFor(() => errors3.some(e => e.code === 'room-full'))
  assert.equal(name1.has(extraId.userId), false)
  assert.equal(name2.has(extraId.userId), false)
  await room3.leave()

  // Guest leaves -> readable DURING onUserLeave, excluded from onlineOnly, and evicted immediately after!
  const leaveEvictions: Array<{prev: string; removed: boolean}> = []
  name1.onChange((val, ctx) => {
    if (ctx.userId === guestId.userId && ctx.removed) {
      assert.equal(val, undefined)
      leaveEvictions.push({prev: ctx.prev, removed: ctx.removed})
    }
  })

  await room2.leave()
  await waitFor(() => Object.keys(room1.getUsers()).length === 0)

  assert.equal(nameDuringUserLeave, 'GuestTwo')
  assert.equal(onlineSnapHadGuestDuringLeave, false)
  assert.equal(name1.has(guestId.userId), false)
  assert.equal(name1.get(guestId.userId), 'Stranger')
  assert.deepEqual(leaveEvictions, [{prev: 'GuestTwo', removed: true}])

  await room1.leave()
})

void test('Offline retention (ttlMs & maxUsers) and zero-schema passive: true relay peer', async () => {
  const {makeJoinRoom} = createMemorySignalBus()
  const joinPassive = makeJoinRoom('relay-passive')
  const joinU1 = makeJoinRoom('ret-u1')
  const joinU2 = makeJoinRoom('ret-u2')
  const joinU3 = makeJoinRoom('ret-u3')
  const joinLate = makeJoinRoom('ret-late')

  const u1 = await createUserIdentity()
  const u2 = await createUserIdentity()
  const u3 = await createUserIdentity()

  // Always-on server peer joins with passive: true and NEVER registers makeState or makeUserState!
  const passiveRelay = joinPassive(
    {appId: 'retain-app', rtcPolyfill, passive: true},
    'persistent-room'
  )
  await passiveRelay.ready

  // User 1 joins, publishes shared state + retained user state + ephemeral user state, then leaves
  const room1 = joinU1(
    {appId: 'retain-app', rtcPolyfill, identity: u1},
    'persistent-room'
  )
  const board1 = room1.makeState('board', 'empty')
  const bio1 = room1.makeUserState('bio', '', {
    retain: {ttlMs: 350, maxUsers: 2}
  })
  const cursor1 = room1.makeUserState<{x: number} | null>('cursor')

  await waitFor(() => Object.keys(room1.getUsers()).length === 1)
  await board1.set('pinned-by-u1')
  await bio1.set('u1-bio')
  await cursor1.set({x: 42})
  await wait(40)
  await room1.leave()
  await waitFor(() => Object.keys(passiveRelay.getUsers()).length === 0)

  // Late joiner connects ONLY to the zero-schema passive relay and receives board + retained bio, NOT cursor!
  const lateRoom = joinLate(
    {appId: 'retain-app', rtcPolyfill},
    'persistent-room'
  )
  const boardLate = lateRoom.makeState('board', 'empty')
  const bioLate = lateRoom.makeUserState('bio', '', {
    retain: {ttlMs: 350, maxUsers: 2}
  })
  const cursorLate = lateRoom.makeUserState<{x: number} | null>('cursor')

  await waitFor(
    () =>
      boardLate.get() === 'pinned-by-u1' && bioLate.get(u1.userId) === 'u1-bio'
  )
  assert.equal(bioLate.getMeta(u1.userId)?.online, false)
  assert.deepEqual(bioLate.getAll({onlineOnly: true}), {})
  assert.equal(
    cursorLate.has(u1.userId),
    false,
    'presence-scoped user state must be evicted by passive relay when author disconnects'
  )

  // maxUsers: 2 offline cap — u2 and u3 join, publish bios, and leave -> u1 (oldest offline) is evicted!
  const room2 = joinU2(
    {appId: 'retain-app', rtcPolyfill, identity: u2},
    'persistent-room'
  )
  const bio2 = room2.makeUserState('bio', '', {
    retain: {ttlMs: 350, maxUsers: 2}
  })
  await waitFor(() => Object.keys(room2.getUsers()).length >= 1)
  await bio2.set('u2-bio')
  await waitFor(() => bioLate.get(u2.userId) === 'u2-bio')
  await room2.leave()
  await waitFor(() => !lateRoom.getUsers()[u2.userId])

  await wait(15)

  const room3 = joinU3(
    {appId: 'retain-app', rtcPolyfill, identity: u3},
    'persistent-room'
  )
  const bio3 = room3.makeUserState('bio', '', {
    retain: {ttlMs: 350, maxUsers: 2}
  })
  await waitFor(() => Object.keys(room3.getUsers()).length >= 1)
  await bio3.set('u3-bio')
  await waitFor(() => bioLate.get(u3.userId) === 'u3-bio')
  await room3.leave()
  await waitFor(() => !lateRoom.getUsers()[u3.userId])

  // Offline count is now capped at maxUsers = 2 (u2 and u3 remain; u1 evicted)
  assert.equal(bioLate.has(u1.userId), false)
  assert.equal(bioLate.get(u2.userId), 'u2-bio')
  assert.equal(bioLate.get(u3.userId), 'u3-bio')

  // Wait for ttlMs (350ms) to expire offline retained entries
  await waitFor(() => !bioLate.has(u2.userId) && !bioLate.has(u3.userId), 2_000)
  assert.deepEqual(bioLate.getAll(), {})

  await Promise.all([lateRoom.leave(), passiveRelay.leave()])
})

void test('State engine hardening: same-ms tie-break pull sync, unregistered poisoning defense, LRU bounds, per-user quotas, rate limits, and invalid-record peer kick', async () => {
  const [alice, bob, mallory, rootAdmin] = await Promise.all([
    createUserIdentity(),
    createUserIdentity(),
    createUserIdentity(),
    createUserIdentity()
  ])
  const appId = 'hardening-app'
  const roomId = 'hardening-room'
  const peerA = '11111111111111111111'
  const peerB = '22222222222222222222'
  const peerM = '33333333333333333333'

  // 1. Same-millisecond HLC tie-break convergence when userId order disagrees with sig prefix
  const fixedHlc = Date.now()
  const recA = await signStateRecord(alice.sign, alice.signPubJwk, {
    kind: 's',
    appId,
    roomId,
    ns: 'tie',
    hlc: fixedHlc,
    peerId: peerA,
    userId: alice.userId,
    val: 'alice'
  })
  const recB = await signStateRecord(bob.sign, bob.signPubJwk, {
    kind: 's',
    appId,
    roomId,
    ns: 'tie',
    hlc: fixedHlc,
    peerId: peerB,
    userId: bob.userId,
    val: 'bob'
  })
  const expectedWinner = compareStateRecords(recA, recB) > 0 ? 'alice' : 'bob'

  const handlers = new Map<string, (raw: JsonValue, from: string) => void>()
  const makeHarnessMgr = (
    selfId: string,
    user: UserIdentity,
    onInvalid?: (from?: string) => void
  ) =>
    createStateManager({
      appId,
      getRoomId: () => roomId,
      getSelfId: () => selfId,
      getLocalUserId: () => user.userId,
      ensureReady: async () => ({selfId, user, roomId}),
      hasRolesPlugin: () => false,
      getRolesProvider: () => null,
      isPeerActive: () => true,
      isDirectPeer: () => true,
      getDirectPeerIds: () => [peerA, peerB].filter(p => p !== selfId),
      isUserOnline: () => true,
      getKnownPeerUserId: pid =>
        pid === peerA
          ? alice.userId
          : pid === peerB
            ? bob.userId
            : mallory.userId,
      isPeerBanned: () => false,
      getPeerRoles: () => [],
      makeInternalAction: <T extends JsonValue>(ns: string) => {
        const key = `${selfId}:${ns}`
        return {
          send: async (data: T, targets?: string | string[] | null) => {
            const list = targets
              ? Array.isArray(targets)
                ? targets
                : [targets]
              : [peerA, peerB].filter(p => p !== selfId)
            for (const t of list) {
              queueMicrotask(() => {
                handlers.get(`${t}:${ns}`)?.(data, selfId)
              })
            }
          },
          onMessage: (fn: (data: T, peerId: string) => void) => {
            handlers.set(key, fn as (raw: JsonValue, from: string) => void)
            return () => handlers.delete(key)
          },
          onReceive: () => () => {},
          onReceiveProgress: () => () => {}
        } as never
      },
      ...(onInvalid ? {onInvalidRecord: onInvalid} : {})
    })

  const mgrA = makeHarnessMgr(peerA, alice)
  const mgrB = makeHarnessMgr(peerB, bob)
  const tieA = mgrA.makeState('tie', 'init')
  const tieB = mgrB.makeState('tie', 'init')
  await mgrA.verifyAndApplyStateRecord(recA)
  await mgrB.verifyAndApplyStateRecord(recB)
  mgrA.onPeerJoined(peerB, bob.userId, true)
  await waitFor(
    () => tieA.get() === expectedWinner && tieB.get() === expectedWinner
  )
  mgrA.destroy()
  mgrB.destroy()

  // 2. Unregistered shared namespace poisoning defense (validate + certified roles) & LRU cap
  let invalidCount = 0
  const mgrGuard = makeHarnessMgr(peerB, bob, () => {
    invalidCount++
  })

  const honestValid = await signStateRecord(alice.sign, alice.signPubJwk, {
    kind: 's',
    appId,
    roomId,
    ns: 'late-validated',
    hlc: fixedHlc,
    peerId: peerA,
    userId: alice.userId,
    val: 10
  })
  assert.equal(await mgrGuard.verifyAndApplyStateRecord(honestValid), true)

  // Mallory sends 10 higher-HLC records that violate the future validator (val < 0)
  for (let i = 1; i <= 10; i++) {
    const poisoned = await signStateRecord(mallory.sign, mallory.signPubJwk, {
      kind: 's',
      appId,
      roomId,
      ns: 'late-validated',
      hlc: fixedHlc + i,
      peerId: peerM,
      userId: mallory.userId,
      val: -i
    })
    await mgrGuard.verifyAndApplyStateRecord(poisoned)
  }

  // When Bob finally registers makeState with validate(n => n >= 0), Alice's valid record (10) wins!
  const lateValidated = mgrGuard.makeState('late-validated', 0, {
    validate: n => n >= 0
  })
  assert.equal(lateValidated.get(), 10)

  // Unregistered LRU cache bound: pushing maxUnregisteredSlots + 20 namespaces never evicts registered lateValidated
  for (let i = 0; i < maxUnregisteredSlots + 20; i++) {
    const filler = await signStateRecord(alice.sign, alice.signPubJwk, {
      kind: 's',
      appId,
      roomId,
      ns: `unreg-${i}`,
      hlc: fixedHlc + i,
      peerId: peerA,
      userId: alice.userId,
      val: i
    })
    await mgrGuard.verifyAndApplyStateRecord(filler)
  }
  assert.equal(lateValidated.get(), 10)
  // Oldest unregistered slot ('unreg-0') was LRU-evicted, while newest ('unreg-275') survived
  assert.equal(mgrGuard.makeState('unreg-0', -1).get(), -1)
  assert.equal(
    mgrGuard.makeState(`unreg-${maxUnregisteredSlots + 19}`, -1).get(),
    maxUnregisteredSlots + 19
  )

  // 3. Per-user userState namespace cap (32 namespaces per user) enforced locally
  const mgrQuota = makeHarnessMgr(peerA, alice)
  for (let i = 0; i < maxUserStateNamespacesPerUser; i++) {
    await mgrQuota.makeUserState(`u-ns-${i}`, 0).set(i + 1)
  }
  await assert.rejects(
    () => mgrQuota.makeUserState('u-ns-overflow', 0).set(999),
    /quota/
  )
  mgrQuota.destroy()

  // 4. Forged signatures trigger peer-error and kick after 8 invalid state records, while >25 valid burst only drops excess
  const {makeJoinRoom} = createMemorySignalBus()
  const joinVictim = makeJoinRoom('sec-victim')
  const joinAttacker = makeJoinRoom('sec-attacker')

  const victimErrors: RoomError[] = []
  const victimRoom = joinVictim(
    {appId: 'sec-kick-app', rtcPolyfill, identity: rootAdmin},
    'sec-room'
  )
  victimRoom.onError(err => victimErrors.push(err))

  const attackerRoom = joinAttacker(
    {appId: 'sec-kick-app', rtcPolyfill, identity: mallory},
    'sec-room'
  )
  try {
    const victimLive = victimRoom.makeState('burst', 0)
    const attackerLive = attackerRoom.makeState('burst', 0)

    await waitFor(() => Object.keys(victimRoom.getUsers()).length === 1)

    // Burst 35 valid records back-to-back via distinct awaits — token bucket drops excess without kicking!
    for (let i = 1; i <= 35; i++) {
      await attackerLive.set(i)
    }
    await wait(50)
    assert.equal(victimErrors.length, 0)
    assert.equal(Object.keys(victimRoom.getUsers()).length, 1)
    assert.ok(victimLive.get() >= 1)

    // Refill live rate-limit tokens (~9 tokens at 20/s), then inject 8 forged @_state records -> peer-error & kick!
    await wait(450)
    const attackerSelf = await attackerRoom.getSelf()
    const forgedMsg = JSON.stringify({
      t: 'rec',
      r: {
        v: 1,
        k: 's',
        ns: 'burst',
        hlc: Date.now(),
        peerId: attackerSelf.peerId,
        userId: mallory.userId,
        pub: 'bad',
        val: 999,
        sig: 'bad-sig'
      }
    })
    const typeBytes = new TextEncoder().encode('@_state')
    const bodyBytes = new TextEncoder().encode(forgedMsg)
    const rawFrame = new Uint8Array(36 + bodyBytes.byteLength)
    rawFrame[0] = 2
    rawFrame[1] = 1 << 4 // jsonFormat inline frame
    rawFrame.set(typeBytes, 2)
    rawFrame.set(bodyBytes, 36)

    const victimPc = victimRoom.getPeers()[attackerSelf.peerId]
      ?.connection as unknown as InMemoryRTCPeerConnection | undefined
    const attackerChannel = victimPc?.partnerPc?.dataChannel
    assert.ok(attackerChannel && attackerChannel.readyState === 'open')

    let kickedPeers = 0
    let kickedUsers = 0
    victimRoom.onPeerLeave(({peerId}) => {
      if (peerId === attackerSelf.peerId) {
        kickedPeers += 1
      }
    })
    victimRoom.onUserLeave(({userId}) => {
      if (userId === mallory.userId) {
        kickedUsers += 1
      }
    })

    for (let k = 0; k < 8; k++) {
      attackerChannel.send(rawFrame)
    }

    await waitFor(
      () =>
        victimErrors.some(
          e =>
            e.code === 'peer-error' &&
            /excessive invalid state records/.test(e.message)
        ) &&
        kickedPeers >= 1 &&
        kickedUsers >= 1
    )
  } finally {
    assert.equal(invalidCount, 0)
    mgrGuard.destroy()
    await Promise.all([victimRoom.leave(), attackerRoom.leave()])
  }
})

void test('Sync scalability & multi-hop overlay: bounded pull fanout on 10th mesh peer join and convergence across scale({mode: "gossip"})', async () => {
  // Part A: 9-peer mesh -> 10th peer joins with O(1) pull fanout rather than 9 full pushes
  const {makeJoinRoom} = createMemorySignalBus()
  const rooms: Room[] = []
  const names: Array<UserState<string>> = []

  for (let i = 0; i < 9; i++) {
    const r = makeJoinRoom(`mesh-p${i}`)(
      {appId: 'scale-sync-app', rtcPolyfill},
      'mesh-10'
    )
    const n = r.makeUserState('name', '')
    void n.set(`User-${i}`)
    rooms.push(r)
    names.push(n)
  }

  const shared0 = rooms[0]!.makeState('stage', 'ready')
  await shared0.set('live-match')

  await waitFor(
    () =>
      rooms.every(r => Object.keys(r.getUsers()).length === 8) &&
      names.every(n => Object.keys(n.getAll()).length === 9),
    5_000
  )

  // Measure @_state 'sync' batch replies sent when the 10th peer joins
  let syncReplyFrames = 0
  globalChannelSendObserver = payload => {
    if (!(payload instanceof ArrayBuffer) || payload.byteLength < 36) {
      return
    }
    const header = decodeBytes(new Uint8Array(payload, 2, 32)).replace(
      /\0+$/,
      ''
    )
    if (header !== '@_state') {
      return
    }
    const body = decodeBytes(new Uint8Array(payload, 36))
    if (body.includes('"t":"sync"')) {
      syncReplyFrames++
    }
  }

  try {
    const r10 = makeJoinRoom('mesh-p9')(
      {appId: 'scale-sync-app', rtcPolyfill},
      'mesh-10'
    )
    const stage10 = r10.makeState('stage', 'ready')
    const name10 = r10.makeUserState('name', '')
    void name10.set('User-9')
    rooms.push(r10)
    names.push(name10)

    await waitFor(
      () =>
        stage10.get() === 'live-match' &&
        Object.keys(name10.getAll()).length === 10 &&
        names.every(n => Object.keys(n.getAll()).length === 10),
      5_000
    )

    // Under old O(N) push-from-every-peer, 9 existing peers + newcomer would exchange >= 9-18 full syncs;
    // with k=2 bounded pull fanout, sync replies stay small (typically 2-5).
    assert.ok(
      syncReplyFrames <= 7,
      `expected bounded O(1) sync replies on 10th peer join, got ${syncReplyFrames}`
    )
  } finally {
    globalChannelSendObserver = null
    await Promise.all(rooms.map(r => r.leave()))
  }

  // Part B: Multi-hop gossip mode (`scale({mode: 'gossip', maxConnections: 4})`) converges shared & user state across non-adjacent peers
  const {makeJoinRoom: makeGossipJoin} = createMemorySignalBus()
  const gossipRooms: Array<
    ReturnType<ReturnType<typeof makeGossipJoin>> & {
      getTopology: () => {
        activeMode: string
        directPeerIds: string[]
        roomPeerIds: string[]
      }
    }
  > = []
  const gossipStates: Array<SharedState<string>> = []
  const gossipProfiles: Array<UserState<string>> = []

  try {
    for (let i = 0; i < 12; i++) {
      const gr = makeGossipJoin(`gossip-n${i}`)(
        {
          appId: 'gossip-state-app',
          rtcPolyfill,
          use: [scale({mode: 'gossip', maxConnections: 4})]
        },
        'gossip-room'
      )
      gossipStates.push(gr.makeState('banner', 'init'))
      const prof = gr.makeUserState('handle', '')
      void prof.set(`gossip-user-${i}`)
      gossipProfiles.push(prof)
      gossipRooms.push(gr as never)
      await gr.ready
      await wait(15)
    }

    await waitFor(
      () =>
        gossipRooms.every(r => r.getTopology().roomPeerIds.length === 11) &&
        gossipRooms.some(r =>
          Object.values(r.getPeers()).some(p => !p.direct && p.hops >= 2)
        ),
      8_000
    )

    await gossipStates[0]!.set('hello-across-hops')
    await waitFor(
      () =>
        gossipStates.every(s => s.get() === 'hello-across-hops') &&
        gossipProfiles.every(p => Object.keys(p.getAll()).length === 12),
      8_000
    )
  } finally {
    await Promise.all(gossipRooms.map(r => r.leave()))
  }
})
