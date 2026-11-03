import assert from 'node:assert/strict'
import test from './test.ts'
import room from '../../packages/core/src/room.ts'
import type {
  DataPayload,
  MessageActionConfig,
  PeerHandle,
  PeerResult
} from '../../packages/core/src/types.ts'
import {
  createJoinedRooms,
  encodeInternalAction,
  LinkedPeer,
  linkPeers,
  testEndpoint,
  tick
} from './peer-harness.ts'

void test('Trystero: remote leave packets fire peer-leave callbacks once', async () => {
  const epLocal = testEndpoint('peer-leave-local')
  const epRemote = testEndpoint('peer-leave-remote')
  let registerLocal = null as ((peer: PeerHandle, id: string) => void) | null
  let registerRemote = null as ((peer: PeerHandle, id: string) => void) | null
  const strategyPeerLeaves: string[] = []
  const roomPeerLeaves: string[] = []
  const roomRef = room(
    f => {
      registerLocal = f
    },
    id => strategyPeerLeaves.push(id),
    () => {},
    {endpointIdentity: epLocal, appId: 'leave-app', roomId: 'leave-room'}
  )
  const remoteRoom = room(
    f => {
      registerRemote = f
    },
    () => {},
    () => {},
    {endpointIdentity: epRemote, appId: 'leave-app', roomId: 'leave-room'}
  )
  const joinPromise = new Promise(resolve =>
    roomRef.onPeerJoin(({peerId}) => resolve(peerId), {once: true})
  )

  roomRef.onPeerLeave(({peerId}) => roomPeerLeaves.push(peerId))

  const {peerA: localPeer, peerB: remotePeer} = linkPeers(
    new LinkedPeer(),
    new LinkedPeer()
  )
  let destroyCount = 0
  const origDestroy = localPeer.destroy.bind(localPeer)
  localPeer.destroy = () => {
    destroyCount++
    origDestroy()
  }

  assert.ok(
    registerLocal && registerRemote,
    'expected rooms to register peer callbacks'
  )
  registerLocal(localPeer as unknown as PeerHandle, epRemote.peerId)
  registerRemote(remotePeer as unknown as PeerHandle, epLocal.peerId)

  assert.equal(await joinPromise, epRemote.peerId)

  localPeer.handlers.data?.(encodeInternalAction('leave'))
  await tick()

  assert.equal(destroyCount, 1)
  assert.deepEqual(roomPeerLeaves, [epRemote.peerId])
  assert.deepEqual(strategyPeerLeaves, [epRemote.peerId])

  await Promise.all([roomRef.leave(), remoteRoom.leave()])
})

void test('Trystero: metadata is delivered for non-binary payloads and falsy values', async () => {
  const {roomA, roomB, peerIdA} = await createJoinedRooms()

  try {
    const textActionA = roomA.makeAction('text-meta')
    const textActionB = roomB.makeAction('text-meta')
    const textReceived = new Promise(resolve => {
      textActionB.onMessage(
        (payload, {peerId, metadata}) => resolve({payload, peerId, metadata}),
        {once: true}
      )
    })

    await textActionA.send('hello', {metadata: false})

    assert.deepEqual(await textReceived, {
      payload: 'hello',
      peerId: peerIdA,
      metadata: false
    })

    const jsonActionA = roomA.makeAction('json-meta')
    const jsonActionB = roomB.makeAction('json-meta')
    const jsonReceived = new Promise(resolve => {
      jsonActionB.onMessage(
        (payload, {peerId, metadata}) => resolve({payload, peerId, metadata}),
        {once: true}
      )
    })

    await jsonActionA.send({kind: 'object'}, {metadata: 0})

    assert.deepEqual(await jsonReceived, {
      payload: {kind: 'object'},
      peerId: peerIdA,
      metadata: 0
    })

    const queuedActionA = roomA.makeAction('queued-meta')
    const queuedActionB = roomB.makeAction('queued-meta')

    const queuedSend = queuedActionA.send('later', {metadata: null})
    await tick()

    const queuedReceived = new Promise(resolve => {
      queuedActionB.onMessage(
        (payload, {peerId, metadata}) => resolve({payload, peerId, metadata}),
        {once: true}
      )
    })

    await queuedSend

    assert.deepEqual(await queuedReceived, {
      payload: 'later',
      peerId: peerIdA,
      metadata: null
    })
  } finally {
    await Promise.all([roomA.leave(), roomB.leave()])
  }
})

void test('Trystero: action creation uses action objects', async () => {
  let registerPeer = null as ((peer: PeerHandle, id: string) => void) | null
  const roomRef = room(
    f => {
      registerPeer = f
    },
    () => {},
    () => {}
  )

  try {
    assert.ok(registerPeer, 'expected room to register its peer callback')

    const messageAction = roomRef.makeAction('default-message')

    assert.equal(roomRef.makeAction('default-message'), messageAction)
    assert.equal(typeof messageAction.onMessage, 'function')
    assert.equal(typeof messageAction.onReceiveProgress, 'function')

    const requestAction = roomRef.makeAction('question', {kind: 'request'})

    assert.equal(
      roomRef.makeAction('question', {kind: 'request'}),
      requestAction
    )
    assert.throws(
      () =>
        roomRef.makeAction('bad-request', {
          onRequest: () => true
        } as unknown as MessageActionConfig),
      /makeAction config does not accept event handlers/
    )
    assert.throws(() => roomRef.makeAction('question'), /cannot be redefined/)
  } finally {
    await roomRef.leave()
  }
})

void test('Trystero: room event methods fan out and unsubscribe cleanly', async () => {
  const epLocal = testEndpoint('fanout-local')
  const epRemote = testEndpoint('fanout-remote')
  let registerLocal = null as ((peer: PeerHandle, id: string) => void) | null
  let registerRemote = null as ((peer: PeerHandle, id: string) => void) | null
  const joined: string[] = []
  const roomRef = room(
    f => {
      registerLocal = f
    },
    () => {},
    () => {},
    {endpointIdentity: epLocal, appId: 'fanout-app', roomId: 'fanout-room'}
  )
  const remoteRoom = room(
    f => {
      registerRemote = f
    },
    () => {},
    () => {},
    {endpointIdentity: epRemote, appId: 'fanout-app', roomId: 'fanout-room'}
  )

  try {
    const unsubFirst = roomRef.onPeerJoin(({peerId}) =>
      joined.push(`first:${peerId}`)
    )
    const unsubSecond = roomRef.onPeerJoin(({peerId}) =>
      joined.push(`second:${peerId}`)
    )
    unsubFirst()

    assert.ok(
      registerLocal && registerRemote,
      'expected rooms to register peer callbacks'
    )
    const joinDone = new Promise(resolve =>
      roomRef.onPeerJoin(resolve, {once: true})
    )
    const {peerA, peerB} = linkPeers(new LinkedPeer(), new LinkedPeer())

    registerLocal(peerA as unknown as PeerHandle, epRemote.peerId)
    registerRemote(peerB as unknown as PeerHandle, epLocal.peerId)
    await joinDone

    assert.deepEqual(joined, [`second:${epRemote.peerId}`])

    unsubSecond()
    assert.throws(() => {
      ;(roomRef as unknown as Record<string, unknown>)['onPeerJoin'] = null
    }, TypeError)
  } finally {
    await Promise.all([roomRef.leave(), remoteRoom.leave()])
  }
})

void test('Trystero: request actions resolve, reject, wait for handlers, and fan out', async () => {
  const {roomA, roomB, peerIdB} = await createJoinedRooms()

  try {
    const isEvenA = roomA.makeAction('is-even', {kind: 'request'})
    roomB
      .makeAction('is-even', {
        kind: 'request'
      })
      .onRequest(value => (value as number) % 2 === 0)

    assert.equal(await isEvenA.request(4, {target: peerIdB}), true)

    const rejectsA = roomA.makeAction('rejects', {kind: 'request'})
    roomB
      .makeAction('rejects', {
        kind: 'request'
      })
      .onRequest(() => {
        throw new Error('no thanks')
      })

    await assert.rejects(
      () => rejectsA.request('please', {target: peerIdB}),
      /no thanks/
    )

    const lateA = roomA.makeAction('late-request', {kind: 'request'})
    const lateB = roomB.makeAction('late-request', {kind: 'request'})
    const lateResult = lateA.request('hello', {
      target: peerIdB,
      timeoutMs: 1_000
    })

    await tick()
    lateB.onRequest(() => 'hello back')

    assert.equal(await lateResult, 'hello back')

    const missingA = roomA.makeAction('missing-handler', {kind: 'request'})
    roomB.makeAction('missing-handler', {kind: 'request'})

    await assert.rejects(
      () =>
        missingA.request('hello', {
          target: peerIdB,
          timeoutMs: 1_000
        }),
      /timed out/
    )

    const fanoutResults: PeerResult<DataPayload>[] = []
    const many = await isEvenA.requestMany(6, {
      targets: ['missing-peer', peerIdB],
      timeoutMs: 1_000,
      onResult: result => fanoutResults.push(result)
    })

    assert.deepEqual(
      many.map(result => result.peerId),
      ['missing-peer', peerIdB]
    )
    assert.deepEqual(
      many.map(result => result.status),
      ['disconnected', 'fulfilled']
    )
    assert.equal((many[1] as {value: boolean}).value, true)
    assert.deepEqual(
      fanoutResults
        .map(result => result.status)
        .sort((a, b) => a.localeCompare(b)),
      ['disconnected', 'fulfilled']
    )
  } finally {
    await Promise.all([roomA.leave(), roomB.leave()])
  }
})

void test('Trystero: request actions reject on abort and ignore late responses', async () => {
  const {roomA, roomB, peerIdB} = await createJoinedRooms()

  try {
    const slowA = roomA.makeAction('slow-request', {kind: 'request'})
    roomB
      .makeAction('slow-request', {
        kind: 'request'
      })
      .onRequest(async value => {
        await new Promise(res => setTimeout(res, 50))
        return value
      })
    const controller = new AbortController()
    const pending = slowA.request('later', {
      target: peerIdB,
      signal: controller.signal
    })

    controller.abort()

    await assert.rejects(
      () => pending,
      error => (error as Error).name === 'AbortError'
    )
    await new Promise(res => setTimeout(res, 80))
  } finally {
    await Promise.all([roomA.leave(), roomB.leave()])
  }
})

void test('Trystero: incoming request context signal aborts when requesting peer disconnects', async () => {
  const {roomA, roomB, peerA, peerB, peerIdB} = await createJoinedRooms()

  try {
    let requestSignal: AbortSignal | undefined
    let abortedPromise: Promise<void> | undefined
    const slowA = roomA.makeAction('disconnect-abort', {kind: 'request'})

    roomB
      .makeAction('disconnect-abort', {
        kind: 'request'
      })
      .onRequest((_value, context) => {
        requestSignal = context.signal
        abortedPromise = new Promise(resolve => {
          context.signal.addEventListener('abort', () => resolve(), {
            once: true
          })
        })
        return new Promise<string>(resolve => {
          context.signal.addEventListener('abort', () => resolve('cancelled'), {
            once: true
          })
        })
      })

    const pending = slowA.request('work', {target: peerIdB})
    await tick()
    assert.ok(requestSignal)
    assert.equal(requestSignal.aborted, false)

    peerA.destroy()
    peerB.destroy()

    await abortedPromise
    assert.equal(requestSignal.aborted, true)
    await assert.rejects(() => pending, {kind: 'disconnected'})
  } finally {
    await Promise.all([roomA.leave(), roomB.leave()])
  }
})

void test('Trystero: sendData throws during send or request reject with disconnected ActionError', async () => {
  const {roomA, roomB, peerA, peerIdB} = await createJoinedRooms()

  try {
    const actionA = roomA.makeAction('broken-send')
    const reqA = roomA.makeAction('broken-req', {kind: 'request'})
    roomB.makeAction('broken-req', {kind: 'request'}).onRequest(() => 'ok')

    peerA.sendData = () => {
      throw new Error('RTCDataChannel is not open')
    }

    await assert.rejects(() => actionA.send('payload', {target: peerIdB}), {
      kind: 'disconnected'
    })
    await assert.rejects(() => reqA.request('payload', {target: peerIdB}), {
      kind: 'disconnected'
    })
  } finally {
    await Promise.all([roomA.leave(), roomB.leave()])
  }
})
