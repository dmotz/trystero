import assert from 'node:assert/strict'
import vm from 'node:vm'
import test from './test.ts'
import {
  createTopicStrategy,
  definePlugin,
  roles
} from '../../packages/core/src/index.ts'
import {createActionManager} from '../../packages/core/src/actions.ts'
import createRoom from '../../packages/core/src/room.ts'
import createStrategy from '../../packages/core/src/strategy.ts'
import {createSingleHandler} from '../../packages/core/src/utils.ts'
import {joinRoom as joinSupabaseRoom} from '../../packages/supabase/src/index.ts'
import {joinRoom as joinTorrentRoom} from '../../packages/torrent/src/index.ts'
import type {RoomError} from '../../packages/core/src/types.ts'
import {MockRTCPeerConnection, linkedActions, waitFor} from './peer-harness.ts'

void test('Single-handler enforcement on action.onRequest and action.onReceive', async () => {
  const pair = linkedActions()

  try {
    const reqSender = pair.left.makeAction<number, number>('double-rpc', {
      kind: 'request'
    })
    const reqReceiver = pair.right.makeAction<number, number>('double-rpc', {
      kind: 'request'
    })

    // Pre-aborted signal does not occupy the slot
    reqReceiver.onRequest(x => x * 10, {signal: AbortSignal.abort()})
    reqReceiver.onReceive(() => false, {signal: AbortSignal.abort()})

    // 1. Registering a second active handler throws an explicit Error
    const unsubReq1 = reqReceiver.onRequest(x => x * 2)
    assert.throws(
      () => reqReceiver.onRequest(x => x * 3),
      /onRequest handler already registered; unsubscribe first/
    )

    const unsubRecv1 = reqReceiver.onReceive(() => true)
    assert.throws(
      () => reqReceiver.onReceive(() => false),
      /onReceive handler already registered; unsubscribe first/
    )

    assert.equal(await reqSender.request(21, {target: 'right'}), 42)

    // 2. After unsub(), re-registration succeeds
    unsubReq1()
    unsubRecv1()

    // 3. {once: true} handles 1 call and immediately frees the slot for re-registration
    reqReceiver.onRequest(x => x + 1, {once: true})
    reqReceiver.onReceive(() => true, {once: true})
    assert.equal(await reqSender.request(9, {target: 'right'}), 10)

    const controller = new AbortController()
    reqReceiver.onRequest(x => x + 100, {signal: controller.signal})
    reqReceiver.onReceive(() => true, {signal: controller.signal})
    assert.equal(await reqSender.request(5, {target: 'right'}), 105)

    // 4. Aborting signal frees the slot for re-registration
    controller.abort()
    const unsubFinal = reqReceiver.onRequest(x => x * 10)
    assert.equal(await reqSender.request(7, {target: 'right'}), 70)
    unsubFinal()
  } finally {
    pair.close()
  }

  // 5. room.leave() clears active single-handler slots
  const room = createRoom(
    () => {},
    () => {},
    () => {},
    {selfId: 'leave-slot-peer', appId: 'slot-app', roomId: 'slot-room'}
  )
  const rpc = room.makeAction('rpc', {kind: 'request'})
  rpc.onRequest(() => 'v1')
  rpc.onReceive(() => true)
  await room.leave()
  const unsubAfterLeave = rpc.onRequest(() => 'v2')
  unsubAfterLeave()
})

void test('Fast-fail guardrails: 3-arg joinRoom, handler-in-config makeAction, non-function handlers, non-writable .on* methods, cached room.onError, and reserved onError plugin name', async () => {
  let storedRootTopic = ''
  let storedSubscriber = null as
    | Parameters<Parameters<typeof createStrategy>[0]['subscribe']>[3]
    | null

  const joinCustom = createStrategy({
    init: () => ({}),
    subscribe: async (_relay, rootTopic, _selfTopic, onMessage) => {
      storedRootTopic = rootTopic
      storedSubscriber = onMessage
      return () => {}
    },
    announce: () => {}
  })

  const joinTopic = createTopicStrategy({
    init: () => Promise.resolve({}),
    subscribeTopic: async () => () => {},
    publishTopic: async () => {}
  })

  // 1. Passing 3rd argument to joinRoom throws across core strategies, supabase, and torrent
  for (const fn of [
    joinCustom,
    joinTopic,
    joinSupabaseRoom,
    joinTorrentRoom
  ] as unknown as Array<(...args: unknown[]) => unknown>) {
    assert.throws(
      () =>
        fn(
          {
            appId: 'https://example.supabase.co',
            relayConfig: {supabaseKey: 'anon-key'},
            rtcPolyfill: MockRTCPeerConnection
          },
          'guardrail-room',
          {onError: () => {}}
        ),
      /joinRoom takes 2 arguments; register error listeners via room\.onError/
    )
  }

  // 2. Cached room instance returned by a 2nd joinRoom() call still supports room.onError
  const cfg = {
    appId: 'cached-join-err-app',
    password: 'correct-password',
    rtcPolyfill: MockRTCPeerConnection as unknown as typeof RTCPeerConnection
  }
  const room1 = joinCustom(cfg, 'cached-room')
  const room2 = joinCustom(cfg, 'cached-room')
  assert.equal(room1, room2)

  try {
    await room1.getSelf()
    await waitFor(() => storedSubscriber !== null)
    const errors1: RoomError[] = []
    const errors2: RoomError[] = []
    room1.onError(err => errors1.push(err))
    room2.onError(err => errors2.push(err))

    assert.ok(storedSubscriber)
    await storedSubscriber(
      storedRootTopic,
      {
        peerId: 'remote-peer',
        offerId: 'bad-offer-1',
        offer: 'corrupted-ciphertext'
      },
      () => {}
    )

    assert.equal(errors1.length, 1)
    assert.equal(errors2.length, 1)
    assert.equal(errors1[0]!.code, 'decrypt-failed')
    if (errors1[0]!.code === 'decrypt-failed') {
      assert.equal(errors1[0]!.stage, 'offer')
      assert.equal(errors1[0]!.peerId, 'remote-peer')
    }
    assert.match(errors1[0]!.message, /incorrect password/)

    // 3. makeAction rejects event handlers passed in config
    for (const badConfig of [
      {onMessage: () => {}},
      {kind: 'request', onRequest: () => 'x'},
      {onReceive: () => true},
      {onReceiveProgress: () => {}}
    ]) {
      assert.throws(
        () => room1.makeAction('bad-cfg', badConfig as never),
        /makeAction config does not accept event handlers/
      )
    }

    // 4. Non-function handlers throw immediately
    assert.throws(
      () => room1.onUserJoin(null as never),
      /onUserJoin handler must be a function/
    )
    assert.throws(
      () => room1.onError(null as never),
      /onError handler must be a function/
    )
    const validMsgAction = room1.makeAction('valid-msg')
    assert.throws(
      () => validMsgAction.onMessage(null as never),
      /action handler must be a function/
    )
    const validReqAction = room1.makeAction('valid-req', {kind: 'request'})
    assert.throws(
      () => validReqAction.onRequest(null as never),
      /onRequest handler must be a function/
    )

    // 5. Assigning to .on* methods throws descriptive migration error in both strict and sloppy mode, while configurable: true allows spies
    const sloppyAssign = (obj: unknown, prop: string): void => {
      vm.runInNewContext('obj[prop] = function () {}', {obj, prop})
    }

    for (const [obj, prop] of [
      [room1, 'onUserJoin'],
      [room1, 'onUserLeave'],
      [room1, 'onPeerJoin'],
      [room1, 'onPeerLeave'],
      [room1, 'onPeerStream'],
      [room1, 'onError'],
      [validMsgAction, 'onMessage'],
      [validMsgAction, 'onReceive'],
      [validMsgAction, 'onReceiveProgress'],
      [validReqAction, 'onRequest'],
      [validReqAction, 'onReceive'],
      [validReqAction, 'onReceiveProgress']
    ] as const) {
      const expectedPattern = new RegExp(
        `${prop} is a method; call ${prop}\\(handler\\), which returns an unsubscribe function`
      )
      assert.throws(
        () => {
          ;(obj as Record<string, unknown>)[prop] = () => {}
        },
        err => err instanceof TypeError && expectedPattern.test(err.message)
      )
      assert.throws(
        () => {
          sloppyAssign(obj, prop)
        },
        err => err instanceof TypeError && expectedPattern.test(err.message)
      )
    }

    // configurable: true lets test frameworks (vi.spyOn / Object.defineProperty) wrap and restore locked methods
    const origDesc = Object.getOwnPropertyDescriptor(room1, 'onPeerJoin')!
    assert.equal(origDesc.configurable, true)
    let spyCalls = 0
    const origOnPeerJoin = room1.onPeerJoin
    Object.defineProperty(room1, 'onPeerJoin', {
      value: (
        ...args: Parameters<typeof origOnPeerJoin>
      ): ReturnType<typeof origOnPeerJoin> => {
        spyCalls++
        return origOnPeerJoin(...args)
      },
      configurable: true,
      writable: true
    })
    const spyUnsub = room1.onPeerJoin(() => {})
    assert.equal(spyCalls, 1)
    spyUnsub()
    Object.defineProperty(room1, 'onPeerJoin', origDesc)
  } finally {
    await room1.leave()
  }

  // 6. Plugin safety: 'onError' is reserved, while custom plugins and makeState.onChange lock properly
  assert.throws(
    () => definePlugin('onError', {setup: () => ({})}),
    /plugin name "onError" is a reserved room property/
  )

  const shadowErrPlugin = definePlugin('shadow-on-err', {
    setup: () => ({
      onError: () => () => {}
    })
  })
  const badPluginErrors: RoomError[] = []
  const badPluginRoom = joinTopic(
    {
      appId: 'plugin-guard-app',
      use: [shadowErrPlugin],
      rtcPolyfill: MockRTCPeerConnection as unknown as typeof RTCPeerConnection
    },
    'plugin-guard-room'
  )
  badPluginRoom.onError(err => badPluginErrors.push(err))
  await assert.rejects(
    () => badPluginRoom.ready,
    /cannot override reserved room property "onError"/
  )
  assert.equal(badPluginErrors.length, 1)
  assert.equal(badPluginErrors[0]!.code, 'plugin-failed')
  if (badPluginErrors[0]!.code === 'plugin-failed') {
    assert.equal(badPluginErrors[0]!.plugin, 'shadow-on-err')
  }
  await badPluginRoom.leave().catch(() => {})

  // Custom plugin + roles() work alongside locked .on* methods, and state.onChange is also locked
  const customPlugin = definePlugin('hello-ext', {
    setup: () => ({
      greet: () => 'hi'
    })
  })
  const extRoom = joinTopic(
    {
      appId: 'ext-room-app',
      use: [roles({selfAsAdmin: true}), customPlugin],
      rtcPolyfill: MockRTCPeerConnection as unknown as typeof RTCPeerConnection
    },
    'ext-room'
  )
  try {
    await extRoom.ready
    assert.equal(extRoom.greet(), 'hi')
    const st = extRoom.makeState('s', 1)
    assert.throws(() => {
      ;(st as unknown as Record<string, unknown>)['onChange'] = () => {}
    }, /onChange is a method; call onChange\(handler\)/)
  } finally {
    await extRoom.leave()
  }
})

void test('Unsubscribing or aborting onReceive during pending role offer verification admits transfer instead of rejecting', async () => {
  // 1. Stale createSingleHandler wrapper call after unsubscribe returns undefined rather than throwing
  const slot = createSingleHandler<() => boolean>('onReceive')
  const unsubSlot = slot.set(() => false)
  const capturedWrapper = slot.get()!
  unsubSlot()
  assert.equal(slot.get(), null)
  assert.equal(capturedWrapper(), undefined)

  // 2. Role-guarded bulk offer in flight while onReceive is unsubscribed / aborted
  let offerEnteredResolve: (() => void) | null = null
  let resolveOfferCheck:
    | ((res: {
        valid: boolean
        roles: string[]
        userMetadata?: {tag: string}
      }) => void)
    | null = null

  const waitOfferEntered = () =>
    new Promise<void>(resolve => {
      offerEnteredResolve = resolve
    })

  const toRight = {
    sendData: (bytes: Uint8Array) =>
      right.handleData('left', bytes.slice().buffer),
    destroy: () => {}
  }
  const toLeft = {
    sendData: (bytes: Uint8Array) =>
      left.handleData('right', bytes.slice().buffer),
    destroy: () => {}
  }

  const left = createActionManager({
    onPeerError: (id, err) => left.clearPeer(id, err),
    getPeer: () => toRight as never,
    getPeerIds: () => ['right'],
    canReceiveFromPeer: () => true,
    signActionPayload: async (_ns, _roles, _data, userMeta) => ({
      m: userMeta ?? null
    })
  })

  const right = createActionManager({
    onPeerError: (id, err) => right.clearPeer(id, err),
    getPeer: () => toLeft as never,
    getPeerIds: () => ['left'],
    canReceiveFromPeer: () => true,
    verifyActionOffer: async () => {
      offerEnteredResolve?.()
      return new Promise(resolve => {
        resolveOfferCheck = resolve
      })
    },
    verifyActionPayload: async (_ns, _peerId, _roles, _data, wireMeta) => {
      const m =
        wireMeta && typeof wireMeta === 'object' && 'm' in wireMeta
          ? (wireMeta as {m?: {tag: string}}).m
          : undefined
      return {
        valid: true,
        roles: ['admin'],
        ...(m === undefined ? {} : {userMetadata: m})
      }
    }
  })

  try {
    const sender = left.makeAction<Uint8Array>('guarded-upload', {
      roles: 'admin'
    })
    const receiver = right.makeAction<Uint8Array>('guarded-upload', {
      roles: 'admin'
    })

    const receivedSizes: number[] = []
    receiver.onMessage(async data => {
      await Promise.resolve()
      receivedSizes.push(data.byteLength)
    })

    // Gate initially rejects everything, but we unsubscribe it while verifyActionOffer is pending
    const abortCtrl = new AbortController()
    let gateInvocations = 0
    receiver.onReceive(
      () => {
        gateInvocations++
        return false
      },
      {signal: abortCtrl.signal}
    )

    const entered = waitOfferEntered()
    const payload = new Uint8Array(32 * 1024).fill(7)
    const sendPromise = sender.send(payload, {metadata: {tag: 'ok'}})

    await entered
    // Abort the onReceive gate while verifyActionOffer is mid-flight -> restores automatic acceptance
    abortCtrl.abort()
    resolveOfferCheck!({
      valid: true,
      roles: ['admin'],
      userMetadata: {tag: 'ok'}
    })

    await sendPromise
    await waitFor(() => receivedSizes.length === 1, 1_000)
    assert.equal(gateInvocations, 0)
    assert.deepEqual(receivedSizes, [payload.byteLength])
  } finally {
    left.clearPeer('right', new Error('closed'))
    right.clearPeer('left', new Error('closed'))
  }
})
