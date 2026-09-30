import assert from 'node:assert/strict'
import test from './test.ts'
import {linkedActions as linked} from './peer-harness.ts'
// @ts-expect-error Internal source import crosses a referenced package boundary.
import {createActionWireManager} from '../../packages/core/src/action-wire.ts'
// @ts-expect-error Internal source import crosses a referenced package boundary.
import {createActionManager} from '../../packages/core/src/actions.ts'

const encoder = new TextEncoder()
const chunkSize = 16 * 1024 - 14
const start = (
  id: number,
  size: number,
  {
    type = 'file',
    payload,
    metadata,
    format = 2
  }: {
    type?: string
    payload?: Uint8Array
    metadata?: unknown
    format?: number
  } = {}
) => {
  const meta =
    metadata === undefined
      ? new Uint8Array()
      : encoder.encode(JSON.stringify(metadata))
  const header = payload ? 36 : 48
  const bytes = new Uint8Array(header + meta.length + (payload?.length ?? 0))
  const view = new DataView(bytes.buffer)
  bytes[0] = 2
  bytes[1] = (payload ? 0 : 1) | (format << 4)
  bytes.set(encoder.encode(type), 2)
  view.setUint16(34, meta.length)
  if (!payload) {
    view.setUint32(36, id)
    view.setFloat64(40, size)
  }
  bytes.set(meta, header)
  if (payload) {
    bytes.set(payload, header + meta.length)
  }
  return bytes.buffer
}

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
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
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
          controls.push({peerId, kind: bytes[1] & 15}),
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
  const received = []
  const proposed = []
  const action = pair.right.makeAction('chat', {
    onReceive: context => {
      proposed.push(context)
      return true
    },
    onMessage: (data, context) => {
      received.push({data, context})
    }
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
  assert.equal(proposed[1].byteLength, 4)
  assert.deepEqual(proposed[0].metadata, {name: 'test'})
  assert.deepEqual(
    received[5].data,
    new Uint8Array(new Uint16Array([1, 2]).buffer)
  )
  assert.equal(received[5].data.byteOffset, 0)
  assert.equal(received[5].data.buffer.byteLength, received[5].data.byteLength)
  assert.equal(
    pair.frames.some(frame => frame.kind === 1),
    false
  )
  action.onReceive = () => false
  await send('rejected')
  assert.equal(received.length, 6)
  assert.equal(pair.disconnected(), false)
})

void test('files larger than the previous 64 MiB cap transfer with default settings', async t => {
  const pair = linked()
  t.after(pair.close)
  const payload = new Uint8Array(65 * 1024 ** 2)
  payload[0] = 42
  payload[payload.length - 1] = 91
  let received: Uint8Array
  pair.right.makeAction('file', {
    onMessage: data => {
      received = data as Uint8Array
    }
  })
  await pair.left.makeAction('file').send(payload)
  assert.deepEqual(received!, payload)
  assert.equal(pair.frames[0].kind, 1)
  assert.equal(pair.frames[1].kind, 3)
})

void test('async receive policy rejects before any bulk data is sent', async t => {
  const pair = linked()
  t.after(pair.close)
  let decide: (accept: boolean) => void
  pair.right.makeAction('file', {
    onMessage: () => assert.fail('rejected payload delivered'),
    onReceive: ({byteLength, metadata}) => {
      assert.equal(byteLength, 100_000)
      assert.deepEqual(metadata, {name: 'sample.bin'})
      return new Promise(resolve => {
        decide = resolve
      })
    }
  })
  const sending = pair.left
    .makeAction('file')
    .send(new Blob([new Uint8Array(100_000)]), {metadata: {name: 'sample.bin'}})
  await turn()
  assert.deepEqual(
    pair.frames.map(frame => frame.kind),
    [1]
  )
  decide!(false)
  await assert.rejects(sending, {kind: 'rejected'})
  assert.equal(
    pair.frames.some(frame => frame.kind === 2),
    false
  )
  assert.equal(pair.disconnected(), false)
})

void test('bulk offers queue automatically while small messages still pass', async t => {
  const pair = linked(32_000)
  t.after(pair.close)
  let files = 0
  let messages = 0
  pair.right.makeAction('file', {
    onMessage: () => {
      files++
    }
  })
  pair.right.makeAction('chat', {
    onMessage: () => {
      messages++
    }
  })
  const file = pair.left.makeAction('file')
  await Promise.all([
    file.send(new Uint8Array(24_000)),
    file.send(new Uint8Array(24_000)),
    pair.left.makeAction('chat').send('hello')
  ])
  assert.equal(files, 2)
  assert.equal(messages, 1)
  // One bulk transfer per peer; the second is accepted after the first's final chunk.
  const firstChunk = pair.frames.findIndex(
    frame => frame.id === 0 && frame.kind === 2
  )
  const secondAccepted = pair.frames.findIndex(
    frame => frame.id === 1 && frame.kind === 3
  )
  assert.ok(firstChunk < secondAccepted)
  assert.equal(pair.frames.filter(frame => frame.kind === 3).length, 2)
  assert.equal(pair.disconnected(), false)
})

void test('missing handlers retain only offers and registration applies the receive policy', async t => {
  const pair = linked()
  t.after(pair.close)
  const sending = pair.left.makeAction('file').send(new Uint8Array(100_000))
  await turn()
  assert.deepEqual(
    pair.frames.map(frame => frame.kind),
    [1]
  )
  const file = pair.right.makeAction('file', {onReceive: () => false})
  await assert.rejects(sending, {kind: 'rejected'})
  assert.equal(file.onMessage, null)
  assert.equal(
    pair.frames.some(frame => frame.kind === 2),
    false
  )
})

void test('bulk data waits at the sender until a message handler is attached', async t => {
  const pair = linked()
  t.after(pair.close)
  const file = pair.right.makeAction('file')
  const payload = new Uint8Array(100_000).fill(42)
  const sending = pair.left.makeAction('file').send(payload)
  await turn()
  assert.deepEqual(
    pair.frames.map(frame => frame.kind),
    [1]
  )
  let received
  file.onMessage = data => {
    received = data
  }
  await sending
  assert.deepEqual(received, payload)
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
  assert.equal(controls.at(-1).kind, 4)
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
  pair.right.makeAction('file', {
    onMessage: () => {
      calls++
    }
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
  assert.equal(controls.at(-1).kind, 4)
  assert.equal(destroyed.length, 0)
  wire.clearPeer('peer')
  wire.makeInternalAction('file').onMessage(() => {})
  wire.handleData('peer', start(2_000, 1))
  assert.equal(controls.at(-1).kind, 3)
})

void test('request policies unwrap metadata, responses are gated, and missing handlers respect request timeouts', async t => {
  const pair = linked()
  t.after(pair.close)
  const remote = pair.right.makeAction('ask', {
    kind: 'request',
    onReceive: ({metadata}) => {
      assert.deepEqual(metadata, {name: 'question'})
      return true
    },
    onRequest: () => new Uint8Array(100_000)
  })
  const request = pair.left.makeAction('ask', {
    kind: 'request',
    onReceive: ({byteLength}) => byteLength < 200_000
  })
  const result = await request.request('hello', {
    target: 'right',
    metadata: {name: 'question'},
    timeoutMs: 1_000
  })
  assert.equal((result as Uint8Array).length, 100_000)
  remote.onRequest = null
  await assert.rejects(
    request.request('waiting', {
      target: 'right',
      metadata: {name: 'question'},
      timeoutMs: 20
    }),
    {kind: 'timeout'}
  )
})

void test('freeing capacity schedules offers from peers visited earlier in the queue', t => {
  const {wire, controls} = receiver(32_000)
  t.after(() => {
    wire.clearPeer('a')
    wire.clearPeer('b')
  })
  wire.makeInternalAction('file').onMessage(() => {})
  wire.handleData('a', start(0, 1, {type: 'unregistered'}))
  wire.handleData('b', start(1, 24_000))
  wire.handleData('a', start(2, 24_000))
  assert.equal(controls.filter(x => x.peerId === 'a').length, 0)
  wire.handleData('b', dataFrame(1, 0, chunkSize))
  wire.handleData('b', dataFrame(1, chunkSize, 24_000 - chunkSize))
  assert.deepEqual(controls.at(-1), {peerId: 'a', kind: 3})
})

void test('Blob sending reads slices, and abort releases an accepted receive buffer', async t => {
  const pair = linked(32_000)
  t.after(pair.close)
  const file = pair.left.makeAction('file')
  let delivered = 0
  pair.right.makeAction('file', {
    onMessage: () => {
      delivered++
    }
  })
  const blob = new Blob([new Uint8Array(24_000)])
  blob.arrayBuffer = async () => {
    throw new Error('whole Blob read')
  }
  const abort = new AbortController()
  await assert.rejects(
    file.send(blob, {
      signal: abort.signal,
      onProgress: progress => {
        if (progress < 1) {
          abort.abort()
        }
      }
    }),
    {name: 'AbortError'}
  )
  assert.equal(delivered, 0)
  await file.send(blob)
  assert.equal(delivered, 1)
  assert.equal(pair.disconnected(), false)
})

void test('a rejected response fails its request even without an explicit timeout', async t => {
  const pair = linked()
  t.after(pair.close)
  pair.right.makeAction('ask', {
    kind: 'request',
    onRequest: () => new Uint8Array(100_000)
  })
  const action = pair.left.makeAction('ask', {
    kind: 'request',
    onReceive: async () => false
  })
  await assert.rejects(action.request('hello', {target: 'right'}), {
    kind: 'rejected'
  })
  assert.equal(pair.disconnected(), false)
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
  assert.equal(controls.at(-1).kind, 4)
  decisions.forEach(decide => decide(true))
  await turn()
  assert.equal(
    controls.some(x => x.kind === 3),
    false
  )
})

void test('cursor sends need no receipt and ready inline receives allocate no timers even with a full bulk queue', async t => {
  const pair = linked()
  t.after(pair.close)
  let calls = 0
  pair.right.makeAction('cursor', {
    onMessage: () => {
      calls++
    }
  })
  const send = pair.left.makeAction('cursor').send
  const timer = t.mock.method(globalThis, 'setTimeout')
  for (let i = 0; i < 1000; i++) {
    await send(new Uint8Array(8))
  }
  assert.equal(calls, 1000)
  assert.equal(pair.frames.length, 1000)
  assert.ok(
    pair.frames.every(frame => frame.kind === 0 && frame.from === 'left')
  )
  assert.equal(timer.mock.callCount(), 0)
  timer.mock.restore()

  const {wire, controls} = receiver()
  t.after(() => {
    for (let i = 0; i < 16; i++) {
      wire.clearPeer(`attacker-${i}`)
    }
  })
  for (let peer = 0; peer < 16; peer++) {
    for (let id = 0; id < 64; id++) {
      wire.handleData(`attacker-${peer}`, start(id, 1, {type: 'unregistered'}))
    }
  }
  wire.makeInternalAction('cursor').onMessage(() => {
    calls++
  })
  const readyTimer = t.mock.method(globalThis, 'setTimeout')
  wire.handleData(
    'honest',
    start(0, 8, {type: 'cursor', payload: new Uint8Array(8)})
  )
  assert.equal(calls, 1001)
  assert.equal(controls.length, 0)
  assert.equal(readyTimer.mock.callCount(), 0)
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
  pair.right.makeAction('ordered', {
    onReceive: ({kind, signal}) => {
      assert.equal(kind, 'message')
      assert.equal(signal.aborted, false)
      return ++calls === 1
        ? new Promise(resolve => {
            approve = resolve
          })
        : true
    },
    onMessage: data => {
      received.push(data as number)
    }
  })
  let cursors = 0
  pair.right.makeAction('cursor', {
    onMessage: () => {
      cursors++
    }
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

void test('large typed arrays are snapshotted once before admission', async t => {
  const pair = linked()
  t.after(pair.close)
  let received: Uint8Array
  pair.right.makeAction('file', {
    onMessage: data => {
      received = data as Uint8Array
    }
  })
  const bytes = new Uint8Array(24_000).fill(42)
  const sending = pair.left.makeAction('file').send(bytes)
  bytes.fill(0)
  await sending
  assert.equal(received![0], 42)
  assert.equal(received!.at(-1), 42)
})

void test('inline request refusal rejects without requiring a delivery receipt', async t => {
  const pair = linked()
  t.after(pair.close)
  pair.right.makeAction('ask', {
    kind: 'request',
    onReceive: ({kind}) => {
      assert.equal(kind, 'request')
      return false
    },
    onRequest: () => assert.fail('rejected request delivered')
  })
  const action = pair.left.makeAction('ask', {kind: 'request'})
  await assert.rejects(
    action.request('hello', {target: 'right', timeoutMs: 1000}),
    {kind: 'rejected'}
  )
})

void test('progress callback exceptions do not lose completed messages', async t => {
  const pair = linked()
  t.after(pair.close)
  t.mock.method(console, 'error', () => {})
  let messages = 0
  pair.right.makeAction('file', {
    onReceiveProgress: () => {
      throw new Error('application callback')
    },
    onMessage: () => {
      messages++
    }
  })
  const send = pair.left.makeAction('file').send
  await send('small')
  await send(new Uint8Array(24_000))
  assert.equal(messages, 2)
})

void test('incompatible action frames warn and disconnect immediately', t => {
  const {wire, destroyed} = receiver()
  const warning = t.mock.method(console, 'warn', () => {})
  wire.handleData('peer', new Uint8Array(36).buffer)
  assert.deepEqual(destroyed, ['peer'])
  assert.match(
    warning.mock.calls[0].arguments[0],
    /incompatible action protocol/
  )
})

void test('control responses have a bounded send buffer', t => {
  const warning = t.mock.method(console, 'warn', () => {})
  let closed = false
  const peer = {
    channel: {bufferedAmount: 2 * 1024 ** 2},
    sendData: () => assert.fail('overfull control buffer'),
    destroy: () => {
      closed = true
    }
  }
  const wire = createActionWireManager({
    onPeerError: id => {
      peer.destroy()
      wire.clearPeer(id)
    },
    getPeer: () => peer as never,
    getPeerIds: () => [],
    canReceiveFromPeer: () => true,
    throwIfAborted: () => {}
  })
  wire.makeInternalAction('file').onMessage(() => {})
  wire.handleData('peer', start(0, 24_000))
  assert.equal(closed, true)
  assert.equal(warning.mock.callCount(), 1)
})

void test('bulk capacity rotates between peers instead of draining one peer backlog first', t => {
  const {wire, controls} = receiver(24_000)
  t.after(() => {
    wire.clearPeer('attacker')
    wire.clearPeer('honest')
  })
  wire.makeInternalAction('file').onMessage(() => {})
  wire.handleData('attacker', start(0, 24_000))
  wire.handleData('attacker', start(1, 24_000))
  wire.handleData('honest', start(0, 24_000))
  wire.handleData('attacker', dataFrame(0, 0, chunkSize))
  wire.handleData('attacker', dataFrame(0, chunkSize, 24_000 - chunkSize))
  assert.deepEqual(controls.at(-1), {peerId: 'honest', kind: 3})
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

void test('abort interrupts a backpressure wait and removes its listeners', async () => {
  const events = new Map<string, Set<() => void>>()
  const channel = {
    readyState: 'open',
    bufferedAmount: 100_000,
    bufferedAmountLowThreshold: 65_535,
    addEventListener: (event, fn) => {
      const listeners = events.get(event) ?? new Set()
      listeners.add(fn)
      events.set(event, listeners)
    },
    removeEventListener: (event, fn) => events.get(event)?.delete(fn)
  }
  const peer = {
    channel,
    sendData: () => assert.fail('aborted send reached the channel'),
    destroy: () => {}
  }
  const actions = createActionManager({
    onPeerError: (id, error) => {
      peer.destroy()
      actions.clearPeer(id, error)
    },
    getPeer: () => peer as never,
    getPeerIds: () => ['peer'],
    canReceiveFromPeer: () => true
  })
  const controller = new AbortController()
  const sending = actions
    .makeAction('cursor')
    .send(1, {signal: controller.signal})
  controller.abort()
  await assert.rejects(sending, {kind: 'aborted', name: 'AbortError'})
  assert.ok([...events.values()].every(listeners => listeners.size === 0))
})

void test('completed bulk data can wait for a temporarily removed handler', t => {
  const {wire} = receiver()
  t.after(() => wire.clearPeer('peer'))
  const file = wire.makeInternalAction('file')
  let received = 0
  file.onMessage(() => {
    received++
  })
  wire.handleData('peer', start(0, 24_000))
  file.onMessage(null)
  wire.handleData('peer', dataFrame(0, 0, chunkSize))
  wire.handleData('peer', dataFrame(0, chunkSize, 24_000 - chunkSize))
  assert.equal(received, 0)
  file.onMessage(() => {
    received++
  })
  assert.equal(received, 1)
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
      manager.makeAction('file', {
        onMessage: () => {},
        onReceive: () => new Promise(resolve => approvals.push(resolve))
      })
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
          type: '@_response',
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
    echo.onReceive = () =>
      assert.fail('application policy exceeded global quota')
    const limited = echo.request('limited', {target: 'honest', timeoutMs: 100})
    const rejection = assert.rejects(limited, {kind: 'rejected'})
    await reply()
    await rejection
  })
}
