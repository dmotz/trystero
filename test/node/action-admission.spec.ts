import assert from 'node:assert/strict'
import test from './test.ts'
import {linkedActions, turn, waitFor} from './peer-harness.ts'

void test('expired inline request approval rejects once and cannot deliver after late approval', async t => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date']})
  const pair = linkedActions()
  t.after(pair.close)
  let approve: (allow: boolean) => void
  let handled = 0
  const receiver = pair.right.makeAction('approval', {
    kind: 'request',
    onReceive: () =>
      new Promise(resolve => {
        approve = resolve
      }),
    onRequest: () => {
      handled++
      return 'ok'
    }
  })
  const sender = pair.left.makeAction('approval', {kind: 'request'})
  const result = assert.rejects(sender.request('hello', {target: 'right'}), {
    kind: 'rejected'
  })
  await turn()
  assert.equal(typeof approve!, 'function')
  t.mock.timers.tick(120_000)
  await result
  approve!(true)
  await turn()
  assert.equal(handled, 0)
  assert.equal(pair.frames.filter(frame => frame.from === 'right').length, 1)
  receiver.onReceive = null
  assert.equal(await sender.request('again', {target: 'right'}), 'ok')
  assert.equal(handled, 1)
})

for (const asynchronous of [false, true]) {
  for (const allow of [false, true]) {
    void test(`admission is atomic during handler registration (${asynchronous ? 'async' : 'sync'}, ${allow})`, async t => {
      const pair = linkedActions()
      t.after(pair.close)
      let calls = 0
      let delivered = 0
      const signals: AbortSignal[] = []
      const action = pair.right.makeAction('message')
      action.onReceive = ({signal}) => {
        calls++
        signals.push(signal)
        action.onMessage = () => {
          delivered++
        }
        return asynchronous ? Promise.resolve(allow) : allow
      }
      await pair.left.makeAction('message').send('hello')
      await turn()
      assert.equal(calls, 1)
      assert.equal(delivered, allow ? 1 : 0)
      assert.ok(signals.every(signal => signal.aborted))
    })
  }
}

void test('response approval cannot block another request to the same peer', async t => {
  const pair = linkedActions()
  t.after(pair.close)
  let approve: (allow: boolean) => void
  pair.right.makeAction('slow', {kind: 'request', onRequest: () => 'slow'})
  pair.right.makeAction('fast', {kind: 'request', onRequest: () => 'fast'})
  const slow = pair.left.makeAction('slow', {
    kind: 'request',
    onReceive: () =>
      new Promise(resolve => {
        approve = resolve
      })
  })
  const fast = pair.left.makeAction('fast', {kind: 'request'})
  const pending = slow.request('', {target: 'right', timeoutMs: 1000})
  void pending.catch(() => {})
  await waitFor(() => Boolean(approve))
  assert.equal(
    await fast.request('', {target: 'right', timeoutMs: 100}),
    'fast'
  )
  approve(true)
  assert.equal(await pending, 'slow')
})

void test('concurrent requests on the same action have independent response admission', async t => {
  const pair = linkedActions()
  t.after(pair.close)
  let approve: (allow: boolean) => void
  let decisions = 0
  pair.right.makeAction('echo', {kind: 'request', onRequest: data => data})
  const action = pair.left.makeAction('echo', {
    kind: 'request',
    onReceive: () =>
      ++decisions === 1
        ? new Promise(resolve => {
            approve = resolve
          })
        : true
  })
  const first = action.request('first', {target: 'right', timeoutMs: 1000})
  void first.catch(() => {})
  await waitFor(() => Boolean(approve))
  assert.equal(
    await action.request('second', {target: 'right', timeoutMs: 100}),
    'second'
  )
  approve(true)
  assert.equal(await first, 'first')
})

for (const cancel of ['timeout', 'abort'] as const) {
  void test(`request ${cancel} cancels pending response admission and ignores late approval`, async t => {
    const pair = linkedActions()
    t.after(pair.close)
    let approve: (allow: boolean) => void
    let admissionSignal: AbortSignal
    const controller = new AbortController()
    pair.right.makeAction('file', {
      kind: 'request',
      onRequest: () => new Uint8Array(256_000)
    })
    const file = pair.left.makeAction('file', {
      kind: 'request',
      onReceive: ({signal}) => {
        admissionSignal = signal
        return new Promise(resolve => {
          approve = resolve
        })
      }
    })
    const pending = file
      .request('', {
        target: 'right',
        signal: controller.signal,
        ...(cancel === 'timeout' ? {timeoutMs: 30} : {})
      })
      .catch(error => error.kind)
    await waitFor(() => Boolean(approve))
    if (cancel === 'abort') {
      controller.abort()
    }
    assert.equal(await pending, cancel === 'abort' ? 'aborted' : 'timeout')
    assert.equal(admissionSignal.aborted, true)
    approve(true)
    await turn()
    assert.equal(pair.frames.filter(frame => frame.kind === 2).length, 0)
    assert.ok(
      pair.frames.some(frame => frame.from === 'left' && frame.kind === 4)
    )
  })
}

for (const hasPolicy of [false, true]) {
  void test(`cancelling a streaming response releases its slot (policy: ${hasPolicy})`, async t => {
    const pair = linkedActions()
    t.after(pair.close)
    let unblock: () => void
    const blocked = new Promise<void>(resolve => {
      unblock = resolve
    })
    t.after(() => unblock())
    let readingSecondChunk = false
    class SlowBlob extends Blob {
      override slice(start?: number, end?: number, type?: string): Blob {
        const part = super.slice(start, end, type)
        if (start) {
          const read = part.arrayBuffer.bind(part)
          part.arrayBuffer = async () => {
            readingSecondChunk = true
            await blocked
            return read()
          }
        }
        return part
      }
    }
    let admissionSignal: AbortSignal
    const controller = new AbortController()
    pair.right.makeAction('file', {
      kind: 'request',
      onRequest: value =>
        value === 'slow'
          ? new SlowBlob([new Uint8Array(100_000)])
          : new Uint8Array(32_000)
    })
    const file = pair.left.makeAction('file', {
      kind: 'request',
      onReceive: hasPolicy
        ? ({byteLength, signal}) => {
            if (byteLength === 100_000) {
              admissionSignal = signal
            }
            return true
          }
        : undefined
    })
    const pending = file
      .request('slow', {target: 'right', signal: controller.signal})
      .catch(error => error.kind)
    await waitFor(() => readingSecondChunk)
    assert.equal(pair.frames.filter(frame => frame.kind === 2).length, 1)
    controller.abort()
    assert.equal(await pending, 'aborted')
    if (hasPolicy) {
      assert.equal(admissionSignal.aborted, true)
    }
    const result = await file.request('next', {target: 'right', timeoutMs: 100})
    assert.ok(result instanceof Uint8Array)
    assert.equal(result.byteLength, 32_000)
    const chunks = pair.frames.filter(frame => frame.kind === 2).length
    unblock()
    await turn()
    assert.equal(pair.frames.filter(frame => frame.kind === 2).length, chunks)
  })
}

for (const saturation of ['policies', 'transfers'] as const) {
  void test(`default responses bypass saturated ${saturation} from the same peer`, async t => {
    const pair = linkedActions()
    t.after(pair.close)
    const approvals: ((allow: boolean) => void)[] = []
    if (saturation === 'policies') {
      pair.left.makeAction('inbox', {
        onMessage: () => {},
        onReceive: () => new Promise(resolve => approvals.push(resolve))
      })
    }
    const sends = Array.from({length: saturation === 'policies' ? 8 : 64}, () =>
      pair.right
        .makeAction('inbox')
        .send(new Uint8Array(20_000))
        .catch(() => {})
    )
    t.after(async () => {
      pair.close()
      approvals.forEach(approve => approve(false))
      await Promise.all(sends)
    })
    pair.right.makeAction('echo', {kind: 'request', onRequest: value => value})
    const echo = pair.left.makeAction('echo', {kind: 'request'})
    assert.equal(
      await echo.request('hello', {target: 'right', timeoutMs: 100}),
      'hello'
    )
    echo.onReceive = () =>
      assert.fail('policy called after its quota was exhausted')
    await assert.rejects(
      echo.request('limited', {target: 'right', timeoutMs: 100}),
      {kind: 'rejected'}
    )
    echo.onReceive = null
    assert.equal(
      await echo.request('again', {target: 'right', timeoutMs: 100}),
      'again'
    )
  })
}

for (const size of [2048, 20_000]) {
  void test(
    `oversized ${size < 16_000 ? 'inline' : 'bulk'} responses reject without a request deadline`,
    {timeout: 1000},
    async t => {
      const pair = linkedActions(1024)
      t.after(pair.close)
      pair.left.makeAction('file', {
        kind: 'request',
        onRequest: size => new Uint8Array(Number(size))
      })
      const file = pair.right.makeAction('file', {kind: 'request'})
      await assert.rejects(file.request(size, {target: 'left'}), {
        kind: 'rejected'
      })
      const received = await file.request(1024, {target: 'left'})
      assert.ok(received instanceof Uint8Array)
      assert.equal(received.length, 1024)
      assert.equal(pair.disconnected(), false)
    }
  )
}

void test('default inline request responses create no admission timers', async t => {
  const pair = linkedActions()
  t.after(pair.close)
  pair.right.makeAction('echo', {kind: 'request', onRequest: value => value})
  const echo = pair.left.makeAction('echo', {kind: 'request'})
  const timer = t.mock.method(globalThis, 'setTimeout')
  for (let i = 0; i < 100; i++) {
    assert.equal(await echo.request(i, {target: 'right'}), i)
  }
  assert.equal(timer.mock.callCount(), 0)
  assert.equal(pair.frames.length, 200)
  assert.ok(pair.frames.every(frame => frame.kind === 0))
})

for (const size of [2048, 20_000]) {
  void test(
    `oversized ${size < 16_000 ? 'inline' : 'bulk'} requests reject without a deadline`,
    {timeout: 1000},
    async t => {
      const pair = linkedActions(1024)
      t.after(pair.close)
      let handled = 0
      pair.right.makeAction('upload', {
        kind: 'request',
        onRequest: () => {
          handled++
          return 'ok'
        }
      })
      const upload = pair.left.makeAction('upload', {kind: 'request'})
      await assert.rejects(
        upload.request(new Uint8Array(size), {target: 'right'}),
        {kind: 'rejected'}
      )
      assert.equal(handled, 0)
      assert.equal(
        await upload.request(new Uint8Array(1024), {target: 'right'}),
        'ok'
      )
      assert.equal(handled, 1)
    }
  )
}

for (const saturation of ['policies', 'transfers']) {
  void test(
    `inline requests refused by ${saturation} quotas reject without a deadline`,
    {timeout: 1000},
    async t => {
      const pair = linkedActions()
      t.after(pair.close)
      const approvals: ((allow: boolean) => void)[] = []
      if (saturation === 'policies') {
        pair.right.makeAction('files', {
          onMessage: () => {},
          onReceive: () => new Promise(resolve => approvals.push(resolve))
        })
      }
      const sending = Array.from(
        {length: saturation === 'policies' ? 8 : 64},
        () =>
          pair.left
            .makeAction('files')
            .send(new Uint8Array(20_000))
            .catch(() => {})
      )
      t.after(async () => {
        pair.close()
        approvals.forEach(resolve => resolve(false))
        await Promise.all(sending)
      })
      pair.right.makeAction('limited', {
        kind: 'request',
        onRequest: () => assert.fail('refused request delivered'),
        onReceive: () => assert.fail('full quota allowed a policy call')
      })
      const limited = pair.left.makeAction('limited', {kind: 'request'})
      await assert.rejects(limited.request('hello', {target: 'right'}), {
        kind: 'rejected'
      })
    }
  )
}

void test('remote request errors bypass the requester response policy', async t => {
  const pair = linkedActions()
  t.after(pair.close)
  pair.right.makeAction('fail', {
    kind: 'request',
    onRequest: () => {
      throw new Error('handler failure')
    }
  })
  const action = pair.left.makeAction('fail', {
    kind: 'request',
    onReceive: () =>
      assert.fail('response policy should not run on remote error')
  })
  await assert.rejects(action.request('hello', {target: 'right'}), {
    kind: 'rejected',
    message: /handler failure/
  })
})

void test('rejected bulk responses do not emit a second error response frame', async t => {
  const pair = linkedActions()
  t.after(pair.close)
  pair.right.makeAction('bulk', {
    kind: 'request',
    onRequest: () => new Uint8Array(100_000)
  })
  const action = pair.left.makeAction('bulk', {
    kind: 'request',
    onReceive: () => false
  })
  await assert.rejects(action.request('hello', {target: 'right'}), {
    kind: 'rejected'
  })
  await turn()
  assert.deepEqual(
    pair.frames
      .filter(frame => frame.from === 'right')
      .map(frame => frame.kind),
    [1]
  )
})

void test('request actions report receive progress for bulk responses', async t => {
  const pair = linkedActions()
  t.after(pair.close)
  const payload = new Uint8Array(100_000).fill(7)
  pair.right.makeAction('download', {
    kind: 'request',
    onRequest: () => payload
  })
  const progresses: number[] = []
  const contexts: Array<{peerId: string; metadata?: unknown}> = []
  const download = pair.left.makeAction('download', {
    kind: 'request',
    onReceiveProgress: (progress, context) => {
      progresses.push(progress)
      contexts.push({peerId: context.peerId, metadata: context.metadata})
    }
  })
  const result = await download.request('start', {
    target: 'right',
    metadata: {file: 'data.bin'}
  })
  assert.deepEqual(result, payload)
  assert.ok(progresses.length > 1)
  assert.equal(progresses.at(-1), 1)
  assert.ok(contexts.every(context => context.peerId === 'right'))
})

void test('attaching onReceive before onMessage runs admission for already queued messages and bulk offers', async t => {
  const pair = linkedActions()
  t.after(pair.close)

  const sender = pair.left.makeAction('deferred')
  await sender.send('blocked-inline')
  await sender.send('allowed-inline-message')
  const bulkSend = sender.send(new Uint8Array(24_000))

  await turn()

  const receiver = pair.right.makeAction('deferred')
  const seenByteLengths: number[] = []
  const delivered: unknown[] = []

  receiver.onReceive = ({byteLength}) => {
    seenByteLengths.push(byteLength)
    return byteLength !== new TextEncoder().encode('blocked-inline').byteLength
  }
  receiver.onMessage = payload => {
    delivered.push(payload)
  }

  await bulkSend
  await turn()

  assert.equal(seenByteLengths.length, 3)
  assert.equal(delivered.length, 2)
  assert.equal(delivered[0], 'allowed-inline-message')
  assert.ok(delivered[1] instanceof Uint8Array)
  assert.equal((delivered[1] as Uint8Array).byteLength, 24_000)
})
