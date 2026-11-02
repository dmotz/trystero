import assert from 'node:assert/strict'
import test from './test.ts'
import {
  actionStartFrame as start,
  linkedActions as linked,
  turn
} from './peer-harness.ts'
import {createActionWireManager} from '../../packages/core/src/action-wire.ts'
import {createActionManager} from '../../packages/core/src/actions.ts'
import {internalActionPrefix} from '../../packages/core/src/utils.ts'

const encoder = new TextEncoder()
const chunkSize = 16 * 1024 - 14

const dataFrame = (id: number, offset: number, length: number) => {
  const bytes = new Uint8Array(14 + length)
  bytes[0] = 2
  bytes[1] = 2
  const view = new DataView(bytes.buffer)
  view.setUint32(2, id)
  view.setFloat64(6, offset)
  bytes.fill(7, 14)
  return bytes.buffer
}
const receiver = (maxReceiveBytes = 256 * 1024 ** 2) => {
  const controls: {peerId: string; kind: number}[] = []
  const destroyed: string[] = []
  const wire = createActionWireManager({
    onPeerError: id => {
      destroyed.push(id)
      wire.clearPeer(id)
    },
    getPeer: peerId =>
      ({
        sendData: (bytes: Uint8Array) =>
          controls.push({peerId, kind: (bytes[1] ?? 0) & 15}),
        destroy: () => destroyed.push(peerId)
      }) as never,
    getPeerIds: () => [],
    canReceiveFromPeer: () => true,
    throwIfAborted: () => {},
    maxReceiveBytes
  })
  return {wire, controls, destroyed}
}

void test('late internal action registration enforces its static cap on queued payloads', t => {
  const {wire, controls, destroyed} = receiver()
  t.after(() => wire.clearPeer('peer'))
  wire.handleData('peer', start(0, 20_000, {type: 'control'}))
  wire.handleData(
    'peer',
    start(1, 1025, {
      type: 'control',
      payload: new Uint8Array(1025)
    })
  )
  const sizes: number[] = []
  wire
    .makeInternalAction('control', {maxPayloadBytes: 1024})
    .onMessage(data => {
      assert.ok(data instanceof Uint8Array)
      sizes.push(data.length)
    })
  assert.deepEqual(sizes, [])
  assert.deepEqual(controls, [{peerId: 'peer', kind: 4}])
  const timer = t.mock.method(globalThis, 'setTimeout')
  wire.handleData(
    'peer',
    start(2, 1024, {
      type: 'control',
      payload: new Uint8Array(1024)
    })
  )
  assert.deepEqual(sizes, [1024])
  assert.equal(timer.mock.callCount(), 0)
  assert.deepEqual(destroyed, [])
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
  wire.makeInternalAction('file').onMessage(() => {
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
    .makeInternalAction('file')
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

void test('pending unknown actions are bounded, and disconnect frees their slots', t => {
  const {wire, controls, destroyed} = receiver()
  t.after(() => wire.clearPeer('peer'))
  for (let id = 0; id < 65; id++) {
    wire.handleData('peer', start(id, 1, {type: `unknown-${id}`}))
  }
  assert.equal(controls.at(-1)!.kind, 4)
  assert.equal(destroyed.length, 0)
  wire.clearPeer('peer')
  wire.makeInternalAction('file').onMessage(() => {})
  wire.handleData('peer', start(2_000, 1))
  assert.equal(controls.at(-1)!.kind, 3)
})

void test('invalid declared sizes are rejected without allocating or delivering', () => {
  for (const size of [NaN, Infinity, -1, 1.5]) {
    const {wire, destroyed} = receiver()
    wire
      .makeInternalAction('file')
      .onMessage(() => assert.fail('invalid size delivered'))
    wire.handleData('peer', start(0, size))
    assert.deepEqual(destroyed, ['peer'])
  }
  const {wire, controls, destroyed} = receiver()
  wire.handleData('peer', start(0, Number.MAX_SAFE_INTEGER))
  assert.deepEqual(controls, [{peerId: 'peer', kind: 4}])
  assert.deepEqual(destroyed, [])
})

void test('cancelling pending asynchronous policies cannot create unlimited decisions', async t => {
  const {wire, controls} = receiver()
  t.after(() => wire.clearPeer('peer'))
  const decisions: ((accept: boolean) => void)[] = []
  const file = wire.makeInternalAction('file')
  file.onReceive(() => new Promise(resolve => decisions.push(resolve)))
  file.onMessage(() => assert.fail('cancelled transfer delivered'))
  for (let id = 0; id < 65; id++) {
    wire.handleData('peer', start(id, 1))
    const cancel = new Uint8Array(6)
    cancel[0] = 2
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

void test('one peer cannot consume another peer admission slots', async t => {
  const {wire, controls} = receiver()
  t.after(() => {
    wire.clearPeer('attacker')
    wire.clearPeer('honest')
  })
  for (let id = 0; id < 65; id++) {
    wire.handleData('attacker', start(id, 1, {type: 'unregistered'}))
  }
  wire.makeInternalAction('file').onMessage(() => {})
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

void test('cancelled and disconnected policies are aborted, bounded, and do not lock out other peers', async t => {
  const {wire, controls} = receiver()
  t.after(() => wire.clearPeer('honest'))
  const signals: AbortSignal[] = []
  const file = wire.makeInternalAction('file')
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
  wire.makeInternalAction('cursor').onMessage(() => {
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
  const file = wire.makeInternalAction('file')
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
  assert.deepEqual(controls, [{peerId: 'peer', kind: 4}])
})

void test('incompatible action frames warn and disconnect immediately', t => {
  const {wire, destroyed} = receiver()
  const warning = t.mock.method(console, 'warn', () => {})
  wire.handleData('peer', new Uint8Array(36).buffer)
  assert.deepEqual(destroyed, ['peer'])
  assert.match(
    String(warning.mock.calls[0]?.arguments[0]),
    /incompatible action protocol/
  )
})

void test('global async-policy saturation cannot block the default inline path', async t => {
  const {wire, controls} = receiver()
  const resolvers: Array<(allow: boolean) => void> = []
  const file = wire.makeInternalAction('file')
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
  assert.deepEqual(controls.at(-1), {peerId: 'extra', kind: 4})
  let messages = 0
  wire.makeInternalAction('cursor').onMessage(() => {
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
      bytes[0] = 2
      bytes[1] = i % 6
    }
    assert.doesNotThrow(() => wire.handleData('peer', bytes.buffer))
  }
})

for (const saturation of ['policies', 'transfers'] as const) {
  void test(`responses without policies survive global ${saturation} saturation`, async t => {
    const sent: Uint8Array[] = []
    const approvals: ((allow: boolean) => void)[] = []
    const peer = {sendData: (bytes: Uint8Array) => sent.push(bytes.slice())}
    const manager = createActionManager({
      getPeer: () => peer as never,
      getPeerIds: () => [],
      canReceiveFromPeer: () => true,
      onPeerError: (_id, error) => assert.fail(error)
    })
    if (saturation === 'policies') {
      const file = manager.makeAction('file')
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
        new TextDecoder().decode(request.subarray(36, 36 + length))
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
  const action = wire.makeInternalAction('json')
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
      sendData: () => {},
      channel: {
        readyState: 'open',
        bufferedAmount: 0,
        bufferedAmountLowThreshold: 65535
      }
    }
    const wire = createActionWireManager({
      getPeer: () => peer as never,
      getPeerIds: () => ['peer'],
      canReceiveFromPeer: () => true,
      onPeerError: () => {}
    })
    t.after(() => wire.clearPeer('peer'))
    const action = wire.makeInternalAction('file')
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
      bytes[0] = 2
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
