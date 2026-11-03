import assert from 'node:assert/strict'
import test from './test.ts'
import {
  actionStartFrame as start,
  linkedActions as linked,
  testEndpoint,
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
import createRoom from '../../packages/core/src/room.ts'
import type {PeerHandle} from '../../packages/core/src/types.ts'

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
  const controls: {peerId: string; kind: number}[] = []
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
          sendFrame: (bytes: Uint8Array) =>
            controls.push({peerId, kind: (bytes[1] ?? 0) & 15}),
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

void test('files larger than the previous 64 MiB cap transfer with default settings', async t => {
  const pair = linked()
  t.after(pair.close)
  const payload = new Uint8Array(65 * 1024 ** 2)
  payload[0] = 42
  payload[payload.length - 1] = 91
  let received: Uint8Array
  pair.right.makeAction('file').onMessage(data => {
    received = data as Uint8Array
  })
  await pair.left.makeAction('file').send(payload)
  assert.deepEqual(received!, payload)
  assert.equal(pair.frames[0]!.kind, 1)
  assert.equal(pair.frames[1]!.kind, 3)
})

void test('async receive policy rejects before any bulk data is sent', async t => {
  const pair = linked()
  t.after(pair.close)
  let decide: (accept: boolean) => void
  const fileAction = pair.right.makeAction('file')
  fileAction.onMessage(() => assert.fail('rejected payload delivered'))
  fileAction.onReceive(({byteLength, metadata}) => {
    assert.equal(byteLength, 100_000)
    assert.deepEqual(metadata, {name: 'sample.bin'})
    return new Promise(resolve => {
      decide = resolve
    })
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
  pair.right.makeAction('file').onMessage(() => {
    files++
  })
  pair.right.makeAction('chat').onMessage(() => {
    messages++
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

void test('unregistered bulk offers reject immediately while registered listener-less actions retain offers and apply receive policy', async t => {
  const pair = linked()
  t.after(pair.close)

  // Unregistered action on receiver rejects bulk offer immediately without allocating a slot
  await assert.rejects(
    pair.left.makeAction('unregistered-file').send(new Uint8Array(100_000)),
    (err: ActionError) =>
      err.kind === 'rejected' && /unregistered action/.test(err.message)
  )
  assert.equal(
    pair.frames.some(frame => frame.kind === 2),
    false
  )

  pair.frames.length = 0
  const file = pair.right.makeAction('file')
  const sending = pair.left.makeAction('file').send(new Uint8Array(100_000))
  await turn()
  assert.deepEqual(
    pair.frames.map(frame => frame.kind),
    [1]
  )
  file.onReceive(() => false)
  await assert.rejects(sending, {kind: 'rejected'})
  assert.equal(typeof file.onMessage, 'function')
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
  file.onMessage(data => {
    received = data
  })
  await sending
  assert.deepEqual(received, payload)
})

void test('request policies unwrap metadata, responses are gated, and missing handlers respect request timeouts', async t => {
  const pair = linked()
  t.after(pair.close)
  const remote = pair.right.makeAction('ask', {
    kind: 'request'
  })
  remote.onReceive(({metadata}) => {
    assert.deepEqual(metadata, {name: 'question'})
    return true
  })
  const unsubRequest = remote.onRequest(() => new Uint8Array(100_000))
  const request = pair.left.makeAction('ask', {
    kind: 'request'
  })
  request.onReceive(({byteLength}) => byteLength < 200_000)
  const result = await request.request('hello', {
    target: 'right',
    metadata: {name: 'question'},
    timeoutMs: 1_000
  })
  assert.equal((result as Uint8Array).length, 100_000)
  unsubRequest()
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
  wire.makeWireAction('staged')
  wire.makeWireAction('file').onMessage(() => {})
  wire.handleData('a', start(0, 1, {type: 'staged'}))
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
  pair.right.makeAction('file').onMessage(() => {
    delivered++
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
  pair.right
    .makeAction('ask', {
      kind: 'request'
    })
    .onRequest(() => new Uint8Array(100_000))
  const action = pair.left.makeAction('ask', {
    kind: 'request'
  })
  action.onReceive(async () => false)
  await assert.rejects(action.request('hello', {target: 'right'}), {
    kind: 'rejected'
  })
  assert.equal(pair.disconnected(), false)
})

void test('cursor sends need no receipt and ready inline receives allocate no timers even with a full bulk queue', async t => {
  const pair = linked()
  t.after(pair.close)
  let calls = 0
  pair.right.makeAction('cursor').onMessage(() => {
    calls++
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
  wire.makeWireAction('staged')
  for (let peer = 0; peer < 16; peer++) {
    for (let id = 0; id < 64; id++) {
      wire.handleData(`attacker-${peer}`, start(id, 1, {type: 'staged'}))
    }
  }
  wire.makeWireAction('cursor').onMessage(() => {
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

void test('large typed arrays stream zero-copy without full-buffer .slice() when unmutated until send settles', async t => {
  const pair = linked()
  t.after(pair.close)
  let received: Uint8Array
  pair.right.makeAction('file').onMessage(data => {
    received = data as Uint8Array
  })
  const backing = new ArrayBuffer(24_004)
  const bytes = new Uint8Array(backing, 4, 24_000).fill(42)
  let inputSliceCalls = 0
  Object.defineProperty(bytes, 'slice', {
    value: (...args: Parameters<Uint8Array['slice']>) => {
      inputSliceCalls++
      return Uint8Array.prototype.slice.apply(bytes, args)
    }
  })
  await pair.left.makeAction('file').send(bytes)
  assert.equal(inputSliceCalls, 0)
  bytes.fill(0)
  assert.equal(received!.byteLength, 24_000)
  assert.equal(received![0], 42)
  assert.equal(received!.at(-1), 42)
})

void test('broadcast send resolves cleanly in an empty room while explicit-target send rejects with disconnected ActionError', async () => {
  const emptyActions = createActionManager({
    onPeerError: () => {},
    getTransport: () => undefined,
    getPeerIds: () => [],
    canReceiveFromPeer: () => false
  })
  const chat = emptyActions.makeAction<string | Uint8Array>('chat')

  // Broadcast (omitted target) resolves cleanly in an empty room for both inline and bulk payloads
  await chat.send('broadcast-inline')
  await chat.send(new Uint8Array(24_000).fill(5))

  // Explicit target resolving to missing peer or empty target list rejects with ActionError (kind: 'disconnected')
  for (const explicitTarget of ['missing-peer', [] as string[]]) {
    await assert.rejects(
      chat.send('targeted-inline', {target: explicitTarget}),
      (err: unknown) =>
        err instanceof Error && (err as ActionError).kind === 'disconnected'
    )
    await assert.rejects(
      chat.send(new Uint8Array(24_000), {target: explicitTarget}),
      (err: unknown) =>
        err instanceof Error && (err as ActionError).kind === 'disconnected'
    )
  }

  // Room-level verification: broadcast resolves cleanly in an empty room, while targeting an absent peer/userId rejects with kind: 'disconnected'
  const room = createRoom(
    () => {},
    () => {},
    () => {},
    {
      endpointIdentity: testEndpoint('q10-empty-room-peer'),
      appId: 'q10-app',
      roomId: 'q10-room'
    }
  )
  try {
    await room.getSelf()
    const roomChat = room.makeAction<string>('room-chat')
    await roomChat.send('hello-empty-room')
    await assert.rejects(
      roomChat.send('hello-nobody', {target: 'nonexistent-peer-id'}),
      (err: unknown) =>
        err instanceof Error && (err as ActionError).kind === 'disconnected'
    )
    await assert.rejects(
      roomChat.send('hello-empty-array', {target: []}),
      (err: unknown) =>
        err instanceof Error && (err as ActionError).kind === 'disconnected'
    )
  } finally {
    await room.leave()
  }
})

void test('inline request refusal rejects without requiring a delivery receipt', async t => {
  const pair = linked()
  t.after(pair.close)
  const ask = pair.right.makeAction('ask', {
    kind: 'request'
  })
  ask.onReceive(({kind}) => {
    assert.equal(kind, 'request')
    return false
  })
  ask.onRequest(() => assert.fail('rejected request delivered'))
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
  const file = pair.right.makeAction('file')
  file.onReceiveProgress(() => {
    throw new Error('application callback')
  })
  file.onMessage(() => {
    messages++
  })
  const send = pair.left.makeAction('file').send
  await send('small')
  await send(new Uint8Array(24_000))
  assert.equal(messages, 2)
})

void test('control responses have a bounded send buffer', t => {
  const warning = t.mock.method(console, 'warn', () => {})
  let closed = false
  const peer = {
    isDead: false,
    channel: {readyState: 'open', bufferedAmount: 2 * 1024 ** 2},
    sendData: () => assert.fail('overfull control buffer'),
    destroy: () => {
      closed = true
    }
  }
  const transport = createDirectPeerTransport(peer as unknown as PeerHandle)
  const wire = createActionWireManager({
    onPeerError: id => {
      peer.destroy()
      wire.clearPeer(id)
    },
    resolveTransport: () => transport,
    getPeerIds: () => [],
    canReceiveFromPeer: () => true,
    checkAborted: () => {}
  })
  wire.makeWireAction('file').onMessage(() => {})
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
  wire.makeWireAction('file').onMessage(() => {})
  wire.handleData('attacker', start(0, 24_000))
  wire.handleData('attacker', start(1, 24_000))
  wire.handleData('honest', start(0, 24_000))
  wire.handleData('attacker', dataFrame(0, 0, chunkSize))
  wire.handleData('attacker', dataFrame(0, chunkSize, 24_000 - chunkSize))
  assert.deepEqual(controls.at(-1), {peerId: 'honest', kind: 3})
})

void test('abort interrupts a backpressure wait and removes its listeners', async () => {
  const events = new Map<string, Set<() => void>>()
  const channel = {
    readyState: 'open',
    bufferedAmount: 100_000,
    bufferedAmountLowThreshold: 65_535,
    addEventListener: (event: string, fn: () => void) => {
      const listeners = events.get(event) ?? new Set<() => void>()
      listeners.add(fn)
      events.set(event, listeners)
    },
    removeEventListener: (event: string, fn: () => void) =>
      events.get(event)?.delete(fn)
  }
  const peer = {
    isDead: false,
    channel,
    sendData: () => assert.fail('aborted send reached the channel'),
    destroy: () => {}
  }
  const transport = createDirectPeerTransport(peer as unknown as PeerHandle)
  const actions = createActionManager({
    onPeerError: (id, error) => {
      peer.destroy()
      actions.clearPeer(id, error)
    },
    getTransport: () => transport,
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
  const file = wire.makeWireAction('file')
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

void test('receiver-rejected bulk offers do not send a redundant cancel frame back', async t => {
  const pair = linked()
  t.after(pair.close)
  const file = pair.right.makeAction('file')
  file.onMessage(() => {})
  file.onReceive(() => false)
  await assert.rejects(
    pair.left.makeAction('file').send(new Uint8Array(24_000)),
    {kind: 'rejected'}
  )
  assert.deepEqual(
    pair.frames.map(frame => ({from: frame.from, kind: frame.kind})),
    [
      {from: 'left', kind: 1},
      {from: 'right', kind: 4}
    ]
  )
})

void test('queued bulk transfers do not expire while an active transfer makes progress', async t => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date']})
  const pair = linked(64_000)
  t.after(pair.close)
  let step: () => void
  const waitStep = () =>
    new Promise<void>(resolve => {
      step = resolve
    })
  class PacedBlob extends Blob {
    override slice(start?: number, end?: number, type?: string): Blob {
      const part = super.slice(start, end, type)
      if (start) {
        const read = part.arrayBuffer.bind(part)
        part.arrayBuffer = async () => {
          await waitStep()
          return read()
        }
      }
      return part
    }
  }
  const received: number[] = []
  pair.right.makeAction('file').onMessage(data => {
    received.push((data as Uint8Array).byteLength)
  })
  const file = pair.left.makeAction('file')
  const first = file.send(new PacedBlob([new Uint8Array(chunkSize * 3)]))
  const second = file.send(new Uint8Array(24_000))
  await turn()
  t.mock.timers.tick(70_000)
  step!()
  await turn()
  t.mock.timers.tick(70_000)
  step!()
  await Promise.all([first, second])
  assert.deepEqual(received, [chunkSize * 3, 24_000])
  assert.equal(pair.disconnected(), false)
})

void test('completed bulk transfer waiting for a removed handler does not block other bulk actions on the same peer', t => {
  const {wire, controls} = receiver(64_000)
  t.after(() => wire.clearPeer('peer'))
  const first = wire.makeWireAction('first')
  const second = wire.makeWireAction('second')
  let firstCount = 0
  let secondCount = 0
  first.onMessage(() => {
    firstCount++
  })
  second.onMessage(() => {
    secondCount++
  })
  wire.handleData('peer', start(0, 24_000, {type: 'first'}))
  wire.handleData('peer', start(1, 24_000, {type: 'second'}))
  first.onMessage(null)
  wire.handleData('peer', dataFrame(0, 0, chunkSize))
  wire.handleData('peer', dataFrame(0, chunkSize, 24_000 - chunkSize))
  assert.equal(firstCount, 0)
  assert.deepEqual(controls.at(-1), {peerId: 'peer', kind: 3})
  wire.handleData('peer', dataFrame(1, 0, chunkSize))
  wire.handleData('peer', dataFrame(1, chunkSize, 24_000 - chunkSize))
  assert.equal(secondCount, 1)
  first.onMessage(() => {
    firstCount++
  })
  assert.equal(firstCount, 1)
})
