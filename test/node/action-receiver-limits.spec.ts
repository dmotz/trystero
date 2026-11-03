import assert from 'node:assert/strict'
import test from './test.ts'
import {
  actionStartFrame as start,
  linkedActions as linked,
  turn
} from './peer-harness.ts'
import {createActionWireManager} from '../../packages/core/src/action-wire.ts'
import {
  type ActionError,
  createActionManager
} from '../../packages/core/src/actions.ts'
import {
  type PeerDataTransport,
  createDirectPeerTransport
} from '../../packages/core/src/peer-transport.ts'
import type {PeerHandle} from '../../packages/core/src/types.ts'
import {internalActionPrefix} from '../../packages/core/src/utils.ts'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const chunkSize = 16 * 1024 - 14

const dataFrame = (id: number, offset: number, length: number) => {
  const bytes = new Uint8Array(14 + length)
  bytes[0] = 3
  bytes[1] = 2
  const view = new DataView(bytes.buffer)
  view.setUint32(2, id)
  view.setFloat64(6, offset)
  bytes.fill(7, 14)
  return bytes.buffer
}

const receiver = (maxReceiveBytes = 256 * 1024 ** 2) => {
  const controls: {peerId: string; kind: number; reason?: string}[] = []
  const destroyed: string[] = []
  const transports = new Map<string, PeerDataTransport>()
  const wire = createActionWireManager({
    onPeerError: id => {
      destroyed.push(id)
      transports.delete(id)
      wire.clearPeer(id)
    },
    resolveTransport: peerId => {
      let transport = transports.get(peerId)
      if (!transport) {
        transport = {
          isOpen: true,
          bufferedAmount: 0,
          sendFrame: (bytes: Uint8Array) => {
            const kind = (bytes[1] ?? 0) & 15
            const reason =
              kind === 4 && bytes.byteLength > 6
                ? decoder.decode(bytes.subarray(6))
                : undefined
            controls.push(
              reason === undefined ? {peerId, kind} : {peerId, kind, reason}
            )
          },
          waitForDrain: () => true,
          close: () => destroyed.push(peerId)
        }
        transports.set(peerId, transport)
      }
      return transport
    },
    getPeerIds: () => [],
    canReceiveFromPeer: () => true,
    checkAborted: () => {},
    maxReceiveBytes
  })
  return {wire, controls, destroyed}
}

void test('registered wire action enforces maxPayloadBytes on pre-listener and live payloads while unregistered actions never buffer', t => {
  const {wire, controls, destroyed} = receiver()
  t.after(() => wire.clearPeer('peer'))

  // Unregistered actions drop inline frames and immediately reject bulk offers without buffering
  wire.handleData('peer', start(0, 20_000, {type: 'unregistered-ctrl'}))
  wire.handleData(
    'peer',
    start(1, 512, {
      type: 'unregistered-ctrl',
      payload: new Uint8Array(512)
    })
  )
  const lateSizes: number[] = []
  wire
    .makeWireAction('unregistered-ctrl', {maxPayloadBytes: 1024})
    .onMessage(data => {
      lateSizes.push((data as Uint8Array).length)
    })
  assert.deepEqual(lateSizes, [])
  assert.deepEqual(controls, [
    {peerId: 'peer', kind: 4, reason: 'unregistered action'}
  ])
  controls.length = 0

  // Registered action without listener yet enforces static maxPayloadBytes immediately and buffers valid inline payloads
  const control = wire.makeWireAction('control', {maxPayloadBytes: 1024})
  wire.handleData('peer', start(0, 20_000, {type: 'control'}))
  wire.handleData(
    'peer',
    start(1, 1025, {
      type: 'control',
      payload: new Uint8Array(1025)
    })
  )
  wire.handleData(
    'peer',
    start(2, 1024, {
      type: 'control',
      payload: new Uint8Array(1024)
    })
  )

  const sizes: number[] = []
  control.onMessage(data => {
    assert.ok(data instanceof Uint8Array)
    sizes.push(data.length)
  })
  assert.deepEqual(sizes, [1024])
  assert.equal(controls.length, 1)
  assert.equal(controls[0]!.kind, 4)

  const timer = t.mock.method(globalThis, 'setTimeout')
  wire.handleData(
    'peer',
    start(3, 1024, {
      type: 'control',
      payload: new Uint8Array(1024)
    })
  )
  assert.deepEqual(sizes, [1024, 1024])
  assert.equal(timer.mock.callCount(), 0)
  assert.deepEqual(destroyed, [])
})

void test('Q9: pre-listener inline ring buffer holds 32 drop-oldest messages with 10s TTL for registered actions only, decoupled from 64 bulk slots', t => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date']})
  const {wire, controls, destroyed} = receiver()
  t.after(() => wire.clearPeer('peer'))

  // 1. Unregistered inline spam (200 frames) and bulk offers (100 frames) allocate zero slots
  for (let i = 0; i < 200; i++) {
    wire.handleData(
      'peer',
      start(i, 4, {
        type: 'never-registered',
        payload: encoder.encode(`u${i}`),
        format: 0
      })
    )
  }
  for (let i = 0; i < 100; i++) {
    wire.handleData('peer', start(i, 20_000, {type: 'never-registered'}))
  }
  assert.equal(controls.length, 100)
  assert.ok(
    controls.every(c => c.kind === 4 && c.reason === 'unregistered action')
  )
  const neverDelivered: unknown[] = []
  wire.makeWireAction('never-registered').onMessage(d => neverDelivered.push(d))
  assert.deepEqual(neverDelivered, [])
  controls.length = 0

  // 2. Saturate all 64 per-peer bulk transfer slots on a registered action ('bulk-hold')
  const bulkHold = wire.makeWireAction('bulk-hold')
  for (let id = 0; id < 64; id++) {
    wire.handleData('peer', start(id, 20_000, {type: 'bulk-hold'}))
  }
  assert.equal(controls.length, 0)
  // 65th bulk offer on the same peer is rejected because per-peer bulk slots (64) are full
  wire.handleData('peer', start(64, 20_000, {type: 'bulk-hold'}))
  assert.equal(controls.length, 1)
  assert.equal(controls[0]!.kind, 4)
  controls.length = 0

  // 3. Even with all 64 per-peer bulk slots saturated, registered 'ring-chat' buffers 32 drop-oldest inline messages!
  const ringChat = wire.makeWireAction<number>('ring-chat')
  for (let i = 0; i < 40; i++) {
    const body = encoder.encode(JSON.stringify(i))
    wire.handleData(
      'peer',
      start(0, body.byteLength, {
        type: 'ring-chat',
        payload: body,
        format: 1
      })
    )
  }
  const ringDelivered: number[] = []
  ringChat.onMessage(val => ringDelivered.push(val))
  assert.equal(ringDelivered.length, 32)
  assert.deepEqual(
    ringDelivered,
    Array.from({length: 32}, (_, idx) => idx + 8)
  )

  // Clear 'peer' and verify the reverse direction: filling 32 pre-listener inline slots does NOT consume any of the 64 bulk slots
  wire.clearPeer('peer')
  controls.length = 0
  const preInline = wire.makeWireAction<string>('pre-inline')
  for (let i = 0; i < 40; i++) {
    const body = encoder.encode(`msg-${i}`)
    wire.handleData(
      'peer',
      start(0, body.byteLength, {
        type: 'pre-inline',
        payload: body,
        format: 0
      })
    )
  }
  for (let id = 0; id < 64; id++) {
    wire.handleData('peer', start(100 + id, 20_000, {type: 'bulk-hold'}))
  }
  assert.equal(
    controls.length,
    0,
    '32 buffered pre-listener inline frames must not consume any of the 64 bulk slots'
  )
  wire.handleData('peer', start(200, 20_000, {type: 'bulk-hold'}))
  assert.equal(controls.length, 1)
  assert.equal(controls[0]!.kind, 4)
  void bulkHold
  void preInline

  // 4. 10s TTL expiry on pre-listener inline ring buffer
  const ttlAction = wire.makeWireAction<string>('ttl-chat')
  const earlyBody = encoder.encode('expired-msg')
  wire.handleData(
    'peer',
    start(0, earlyBody.byteLength, {
      type: 'ttl-chat',
      payload: earlyBody,
      format: 0
    })
  )
  t.mock.timers.tick(6_000)
  const freshBody = encoder.encode('fresh-msg')
  wire.handleData(
    'peer',
    start(0, freshBody.byteLength, {
      type: 'ttl-chat',
      payload: freshBody,
      format: 0
    })
  )
  t.mock.timers.tick(5_000) // early-msg is 11s old (> 10s TTL); fresh-msg is 5s old (<= 10s TTL)

  const ttlDelivered: string[] = []
  ttlAction.onMessage(msg => ttlDelivered.push(msg))
  assert.deepEqual(ttlDelivered, ['fresh-msg'])
  assert.deepEqual(destroyed, [])
})

void test('Q11: concurrent in-flight incoming requests per peer are capped at 64', async () => {
  const transportsLeft = new Map<string, PeerDataTransport>()
  const transportsRight = new Map<string, PeerDataTransport>()

  const makeTransport = (
    cache: Map<string, PeerDataTransport>,
    fromPeerId: string,
    deliver: (from: string, buf: ArrayBuffer) => void
  ): PeerDataTransport => {
    let t = cache.get(fromPeerId)
    if (!t) {
      t = {
        isOpen: true,
        bufferedAmount: 0,
        sendFrame: bytes => deliver(fromPeerId, bytes.slice().buffer),
        waitForDrain: () => true
      }
      cache.set(fromPeerId, t)
    }
    return t
  }

  const attacker = createActionManager({
    onPeerError: (id, err) => attacker.clearPeer(id, err),
    getTransport: id =>
      makeTransport(transportsLeft, id, (_to, buf) =>
        server.handleData('attacker', buf)
      ),
    getPeerIds: () => ['server'],
    canReceiveFromPeer: () => true
  })

  const honest = createActionManager({
    onPeerError: (id, err) => honest.clearPeer(id, err),
    getTransport: id =>
      makeTransport(transportsLeft, `honest->${id}`, (_to, buf) =>
        server.handleData('honest', buf)
      ),
    getPeerIds: () => ['server'],
    canReceiveFromPeer: () => true
  })

  const server = createActionManager({
    onPeerError: (id, err) => server.clearPeer(id, err),
    getTransport: peerId =>
      makeTransport(transportsRight, peerId, (to, buf) => {
        if (to === 'attacker') {
          attacker.handleData('server', buf)
        } else {
          honest.handleData('server', buf)
        }
      }),
    getPeerIds: () => ['attacker', 'honest'],
    canReceiveFromPeer: () => true
  })

  try {
    const resolvers: Array<(val: number) => void> = []
    let handlerCalls = 0
    const serverRpc = server.makeAction<number, number>('rpc', {
      kind: 'request'
    })
    serverRpc.onRequest((n, ctx) => {
      handlerCalls++
      if (ctx.peerId === 'honest') {
        return n * 10
      }
      return new Promise<number>(resolve => {
        resolvers.push(resolve)
      })
    })

    const attackerRpc = attacker.makeAction<number, number>('rpc', {
      kind: 'request'
    })
    const honestRpc = honest.makeAction<number, number>('rpc', {
      kind: 'request'
    })

    // 64 concurrent in-flight requests from 'attacker' are admitted
    const inFlight = Array.from({length: 64}, (_, i) =>
      attackerRpc.request(i, {target: 'server', timeoutMs: 2_000})
    )
    inFlight.forEach(p => void p.catch(() => {}))
    await turn()
    assert.equal(resolvers.length, 64)
    assert.equal(handlerCalls, 64)

    // 65th concurrent request from 'attacker' rejects with kind: 'rejected' ("too many concurrent requests")
    await assert.rejects(
      attackerRpc.request(64, {target: 'server', timeoutMs: 2_000}),
      (err: unknown) =>
        err instanceof Error &&
        (err as ActionError).kind === 'rejected' &&
        /too many concurrent requests/.test(err.message)
    )
    assert.equal(handlerCalls, 64)

    // Another peer ('honest') is unaffected by 'attacker' hitting its 64-request cap
    assert.equal(
      await honestRpc.request(7, {target: 'server', timeoutMs: 2_000}),
      70
    )

    // Completing 1 in-flight request frees a slot for 'attacker'
    resolvers.shift()!(1000)
    assert.equal(await inFlight.shift()!, 1000)
    await turn()

    const nextReq = attackerRpc.request(99, {
      target: 'server',
      timeoutMs: 2_000
    })
    await turn()
    assert.equal(resolvers.length, 64)
    resolvers.forEach((resolve, idx) => resolve(idx + 1))
    assert.equal(await nextReq, 64)
    await Promise.all(inFlight)
  } finally {
    attacker.clearPeer('server', new Error('closed'))
    honest.clearPeer('server', new Error('closed'))
    server.clearPeer('attacker', new Error('closed'))
    server.clearPeer('honest', new Error('closed'))
  }
})

void test('ordinary messages preserve types, metadata, empty values and exact UTF-8 sizes', async t => {
  const pair = linked()
  t.after(pair.close)
  const received: Array<{data: unknown; context: unknown}> = []
  const proposed: Array<{byteLength: number; metadata?: unknown}> = []
  const action = pair.right.makeAction('chat')
  const unsubReceive = action.onReceive(context => {
    proposed.push(context)
    return true
  })
  action.onMessage((data, context) => {
    received.push({data, context})
  })
  const send = pair.left.makeAction('chat').send
  for (const value of [
    '',
    '🙂',
    42,
    {hello: 'world'},
    new Uint8Array(),
    new Uint16Array([1, 2])
  ]) {
    await send(value, {metadata: {name: 'test'}})
  }
  assert.equal(received.length, 6)
  assert.deepEqual(received.map(x => x.data).slice(0, 4), [
    '',
    '🙂',
    42,
    {hello: 'world'}
  ])
  assert.equal(proposed[1]!.byteLength, 4)
  assert.deepEqual(proposed[0]!.metadata, {name: 'test'})
  const fifthBytes = received[5]!.data as Uint8Array
  assert.deepEqual(fifthBytes, new Uint8Array(new Uint16Array([1, 2]).buffer))
  assert.equal(fifthBytes.byteOffset, 0)
  assert.equal(fifthBytes.buffer.byteLength, fifthBytes.byteLength)
  assert.equal(
    pair.frames.some(frame => frame.kind === 1),
    false
  )
  unsubReceive()
  action.onReceive(() => false)
  await send('rejected')
  assert.equal(received.length, 6)
  assert.equal(pair.disconnected(), false)
})

void test('expired transfer tails cannot be delivered as new messages', t => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date']})
  const {wire, controls} = receiver(32_000)
  t.after(() => wire.clearPeer('peer'))
  let deliveries = 0
  wire.makeWireAction('file').onMessage(() => {
    deliveries++
  })
  wire.handleData('peer', start(1, 24_000))
  wire.handleData('peer', dataFrame(1, 0, chunkSize))
  t.mock.timers.tick(120_000)
  assert.equal(controls.at(-1)!.kind, 4)
  wire.handleData('peer', dataFrame(1, chunkSize, 24_000 - chunkSize))
  assert.equal(deliveries, 0)
  wire.handleData('peer', start(2, 24_000))
  wire.handleData('peer', dataFrame(2, 0, chunkSize))
  wire.handleData('peer', dataFrame(2, chunkSize, 24_000 - chunkSize))
  assert.equal(deliveries, 1)
})

void test('unannounced fragments allocate no transfer state and duplicate offsets close the peer', t => {
  const {wire, controls, destroyed} = receiver(32_000)
  t.after(() => wire.clearPeer('peer'))
  wire
    .makeWireAction('file')
    .onMessage(() => assert.fail('invalid payload delivered'))
  for (let id = 0; id < 5_000; id++) {
    wire.handleData('peer', dataFrame(id, 0, 100))
  }
  assert.equal(controls.length, 0)
  wire.handleData('peer', start(5_001, 24_000))
  wire.handleData('peer', dataFrame(5_001, 0, chunkSize))
  wire.handleData('peer', dataFrame(5_001, 0, chunkSize))
  assert.deepEqual(destroyed, ['peer'])
})

void test('oversized proposals are refused and a peer remains usable', async t => {
  const pair = linked(32_000)
  t.after(pair.close)
  let calls = 0
  pair.right.makeAction('file').onMessage(() => {
    calls++
  })
  const action = pair.left.makeAction('file')
  await assert.rejects(
    action.send(new Uint8Array(40_000)),
    /receiver size limit/
  )
  await action.send(new Uint8Array(20_000))
  assert.equal(calls, 1)
  assert.equal(pair.disconnected(), false)
})

void test('pending registered actions are bounded at 64 per peer and disconnect frees their slots', t => {
  const {wire, controls, destroyed} = receiver()
  t.after(() => wire.clearPeer('peer'))
  wire.makeWireAction('staged')
  for (let id = 0; id < 65; id++) {
    wire.handleData('peer', start(id, 1, {type: 'staged'}))
  }
  assert.equal(controls.length, 1)
  assert.equal(controls.at(-1)!.kind, 4)
  assert.equal(destroyed.length, 0)
  wire.clearPeer('peer')
  wire.makeWireAction('file').onMessage(() => {})
  wire.handleData('peer', start(2_000, 1))
  assert.equal(controls.at(-1)!.kind, 3)
})

void test('invalid declared sizes are rejected without allocating or delivering', () => {
  for (const size of [NaN, Infinity, -1, 1.5]) {
    const {wire, destroyed} = receiver()
    wire
      .makeWireAction('file')
      .onMessage(() => assert.fail('invalid size delivered'))
    wire.handleData('peer', start(0, size))
    assert.deepEqual(destroyed, ['peer'])
  }
  const {wire, controls, destroyed} = receiver()
  wire.makeWireAction('file')
  wire.handleData('peer', start(0, Number.MAX_SAFE_INTEGER))
  assert.equal(controls.length, 1)
  assert.equal(controls[0]!.peerId, 'peer')
  assert.equal(controls[0]!.kind, 4)
  assert.deepEqual(destroyed, [])
})

void test('cancelling pending asynchronous policies cannot create unlimited decisions', async t => {
  const {wire, controls} = receiver()
  t.after(() => wire.clearPeer('peer'))
  const decisions: ((accept: boolean) => void)[] = []
  const file = wire.makeWireAction('file')
  file.onReceive(() => new Promise(resolve => decisions.push(resolve)))
  file.onMessage(() => assert.fail('cancelled transfer delivered'))
  for (let id = 0; id < 65; id++) {
    wire.handleData('peer', start(id, 1))
    const cancel = new Uint8Array(6)
    cancel[0] = 3
    cancel[1] = 5
    new DataView(cancel.buffer).setUint32(2, id)
    wire.handleData('peer', cancel.buffer)
  }
  assert.equal(decisions.length, 8)
  assert.equal(controls.at(-1)!.kind, 4)
  decisions.forEach(decide => decide(true))
  await turn()
  assert.equal(
    controls.some(x => x.kind === 3),
    false
  )
})

void test('one peer cannot consume another peer admission slots', t => {
  const {wire, controls} = receiver()
  t.after(() => {
    wire.clearPeer('attacker')
    wire.clearPeer('honest')
  })
  wire.makeWireAction('staged')
  for (let id = 0; id < 65; id++) {
    wire.handleData('attacker', start(id, 1, {type: 'staged'}))
  }
  assert.equal(controls.length, 1)
  assert.equal(controls[0]!.peerId, 'attacker')
  assert.equal(controls[0]!.kind, 4)
  wire.makeWireAction('file').onMessage(() => {})
  wire.handleData('honest', start(0, 24_000))
  assert.deepEqual(controls.at(-1), {peerId: 'honest', kind: 3})
})

void test('async inline policies preserve per-action order and cannot stall another action', async t => {
  const pair = linked()
  t.after(pair.close)
  let approve: (value: boolean) => void
  const received: number[] = []
  let calls = 0
  const ordered = pair.right.makeAction('ordered')
  ordered.onReceive(({kind, signal}) => {
    assert.equal(kind, 'message')
    assert.equal(signal.aborted, false)
    return ++calls === 1
      ? new Promise(resolve => {
          approve = resolve
        })
      : true
  })
  ordered.onMessage(data => {
    received.push(data as number)
  })
  let cursors = 0
  pair.right.makeAction('cursor').onMessage(() => {
    cursors++
  })
  await pair.left.makeAction('ordered').send(1)
  await pair.left.makeAction('ordered').send(2)
  await pair.left.makeAction('cursor').send(1)
  assert.equal(calls, 1)
  assert.equal(cursors, 1)
  assert.deepEqual(received, [])
  approve!(true)
  await turn()
  assert.deepEqual(received, [1, 2])
})

void test('cancelled and disconnected policies are aborted, bounded, and do not lock out other peers', t => {
  const {wire, controls} = receiver()
  t.after(() => wire.clearPeer('honest'))
  const signals: AbortSignal[] = []
  const file = wire.makeWireAction('file')
  file.onReceive(({peerId, signal}) => {
    if (peerId === 'honest') {
      return true
    }
    signals.push(signal)
    return new Promise(() => {})
  })
  file.onMessage(() => {})
  for (let i = 0; i < 9; i++) {
    wire.handleData('attacker', start(i, 1))
  }
  assert.equal(signals.length, 8)
  wire.clearPeer('attacker')
  assert.ok(signals.every(signal => signal.aborted))
  wire.handleData('honest', start(0, 1))
  assert.deepEqual(controls.at(-1), {peerId: 'honest', kind: 3})
  let calls = 0
  wire.makeWireAction('cursor').onMessage(() => {
    calls++
  })
  wire.handleData(
    'attacker',
    start(0, 1, {type: 'cursor', payload: new Uint8Array(1)})
  )
  assert.equal(calls, 1)
})

void test('policy expiry aborts user work and ignores late approval', async t => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date']})
  const {wire, controls} = receiver()
  let approve: (value: boolean) => void
  let signal: AbortSignal
  const file = wire.makeWireAction('file')
  file.onReceive(context => {
    signal = context.signal
    return new Promise(resolve => {
      approve = resolve
    })
  })
  file.onMessage(() => assert.fail('expired payload delivered'))
  wire.handleData('peer', start(0, 24_000))
  t.mock.timers.tick(120_000)
  assert.equal(signal!.aborted, true)
  approve!(true)
  await turn()
  assert.equal(controls.length, 1)
  assert.equal(controls[0]!.peerId, 'peer')
  assert.equal(controls[0]!.kind, 4)
})

void test('incompatible action frames warn and disconnect immediately', t => {
  const {wire, destroyed} = receiver()
  const warning = t.mock.method(console, 'warn', () => {})
  wire.handleData('peer-v0', new Uint8Array(36).buffer)
  const v2Frame = new Uint8Array(36)
  v2Frame[0] = 2
  wire.handleData('peer-v2', v2Frame.buffer)
  assert.deepEqual(destroyed, ['peer-v0', 'peer-v2'])
  assert.match(
    String(warning.mock.calls[0]?.arguments[0]),
    /incompatible action protocol/
  )
  assert.match(
    String(warning.mock.calls[1]?.arguments[0]),
    /incompatible action protocol/
  )
})

void test('global async-policy saturation cannot block the default inline path', async t => {
  const {wire, controls} = receiver()
  const resolvers: Array<(allow: boolean) => void> = []
  const file = wire.makeWireAction('file')
  file.onMessage(() => {})
  file.onReceive(() => new Promise(resolve => resolvers.push(resolve)))
  for (let peer = 0; peer < 16; peer++) {
    for (let id = 0; id < 8; id++) {
      wire.handleData(`peer-${peer}`, start(id, 1))
    }
    wire.clearPeer(`peer-${peer}`)
  }
  assert.equal(resolvers.length, 128)
  wire.handleData('extra', start(0, 1))
  assert.equal(resolvers.length, 128)
  assert.equal(controls.at(-1)!.peerId, 'extra')
  assert.equal(controls.at(-1)!.kind, 4)
  let messages = 0
  wire.makeWireAction('cursor').onMessage(() => {
    messages++
  })
  wire.handleData(
    'honest',
    start(0, 8, {type: 'cursor', payload: new Uint8Array(8)})
  )
  assert.equal(messages, 1)
  resolvers.forEach(resolve => resolve(true))
  await turn()
  wire.handleData('extra', start(1, 1))
  assert.equal(resolvers.length, 129)
  t.after(() => wire.clearPeer('extra'))
})

void test('malformed framing is rejected without parser exceptions', t => {
  t.mock.method(console, 'warn', () => {})
  let random = 42
  const {wire} = receiver()
  t.after(() => wire.clearPeer('peer'))
  for (let i = 0; i < 2000; i++) {
    const bytes = new Uint8Array(i % 80)
    for (let j = 0; j < bytes.length; j++) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0
      bytes[j] = random >>> 24
    }
    if (bytes.length > 1) {
      bytes[0] = 3
      bytes[1] = i % 6
    }
    assert.doesNotThrow(() => wire.handleData('peer', bytes.buffer))
  }
})

for (const saturation of ['policies', 'transfers'] as const) {
  void test(`responses without policies survive global ${saturation} saturation`, async t => {
    const sent: Uint8Array[] = []
    const approvals: ((allow: boolean) => void)[] = []
    const peer = {
      isDead: false,
      channel: null,
      sendData: (bytes: Uint8Array) => sent.push(bytes.slice()),
      destroy: () => {}
    }
    const transport = createDirectPeerTransport(peer as unknown as PeerHandle)
    const manager = createActionManager({
      getTransport: () => transport,
      getPeerIds: () => [],
      canReceiveFromPeer: () => true,
      onPeerError: (_id, error) => assert.fail(error)
    })
    const file = manager.makeAction('file')
    if (saturation === 'policies') {
      file.onMessage(() => {})
      file.onReceive(() => new Promise(resolve => approvals.push(resolve)))
    }
    t.after(() => {
      for (let peer = 0; peer < 16; peer++) {
        manager.clearPeer(`peer-${peer}`, new Error('closed'))
      }
      manager.clearPeer('honest', new Error('closed'))
      approvals.forEach(approve => approve(false))
    })
    for (let peer = 0; peer < 16; peer++) {
      for (let id = 0; id < (saturation === 'policies' ? 8 : 64); id++) {
        manager.handleData(`peer-${peer}`, start(id, 20_000))
      }
    }
    const echo = manager.makeAction('echo', {kind: 'request'})
    const reply = async () => {
      await turn()
      const request = sent.at(-1)!
      const length = new DataView(request.buffer).getUint16(34)
      const metadata = JSON.parse(
        decoder.decode(request.subarray(36, 36 + length))
      )
      manager.handleData(
        'honest',
        start(0, 2, {
          type: `${internalActionPrefix}response`,
          metadata,
          payload: encoder.encode('ok'),
          format: 0
        })
      )
    }
    const pending = echo.request('hello', {target: 'honest', timeoutMs: 100})
    void pending.catch(() => {})
    await reply()
    assert.equal(await pending, 'ok')
    echo.onReceive(() =>
      assert.fail('application policy exceeded global quota')
    )
    const limited = echo.request('limited', {target: 'honest', timeoutMs: 100})
    const rejection = assert.rejects(limited, {kind: 'rejected'})
    await reply()
    await rejection
  })
}

void test('malformed queued inline payload disconnects the peer on delivery', async t => {
  t.mock.method(console, 'warn', () => {})
  const {wire, destroyed} = receiver()
  t.after(() => wire.clearPeer('peer'))
  let approve: (allow: boolean) => void
  const action = wire.makeWireAction('json')
  action.onReceive(
    () =>
      new Promise(resolve => {
        approve = resolve
      })
  )
  action.onMessage(() => assert.fail('malformed payload delivered'))
  wire.handleData(
    'peer',
    start(0, 1, {
      type: 'json',
      payload: encoder.encode('{'),
      format: 1
    })
  )
  approve!(true)
  await turn()
  assert.deepEqual(destroyed, ['peer'])
})

for (const repeated of [false, true]) {
  void test(`${repeated ? 'duplicate' : 'unknown'} acceptance cannot extend another offer deadline`, async t => {
    t.mock.timers.enable({apis: ['setTimeout', 'Date']})
    const peer = {
      isDead: false,
      sendData: () => {},
      destroy: () => {},
      channel: {
        readyState: 'open',
        bufferedAmount: 0,
        bufferedAmountLowThreshold: 65535
      }
    }
    const transport = createDirectPeerTransport(peer as unknown as PeerHandle)
    const wire = createActionWireManager({
      resolveTransport: () => transport,
      getPeerIds: () => ['peer'],
      canReceiveFromPeer: () => true,
      onPeerError: () => {}
    })
    t.after(() => wire.clearPeer('peer'))
    const action = wire.makeWireAction('file')
    const first = action
      .send(new Uint8Array(20000), 'peer')
      .catch(error => error.kind)
    const second = action
      .send(new Uint8Array(20000), 'peer')
      .catch(error => error.kind)
    // Let both offers enqueue, keeping accepted payload work in the microtask queue.
    await Promise.resolve()
    const accept = (id: number) => {
      const bytes = new Uint8Array(6)
      bytes[0] = 3
      bytes[1] = 3
      new DataView(bytes.buffer).setUint32(2, id)
      wire.handleData('peer', bytes.buffer)
    }
    if (repeated) {
      accept(0)
    }
    t.mock.timers.tick(119000)
    accept(repeated ? 0 : 999)
    t.mock.timers.tick(1000)
    let result
    void second.then(value => {
      result = value
    })
    for (let i = 0; i < 10; i++) {
      await Promise.resolve()
    }
    assert.equal(result, 'timeout')
    await first
    await second
  })
}
