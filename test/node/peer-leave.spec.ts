// @ts-nocheck
import assert from 'node:assert/strict'
import test from 'node:test'
import room from '../../packages/core/src/room.ts'

const internalTypeByteLimit = 32
const internalNonceIndex = internalTypeByteLimit
const internalTagIndex = internalNonceIndex + 2
const internalProgressIndex = internalTagIndex + 1
const internalPayloadIndex = internalProgressIndex + 1
const encoder = new TextEncoder()

const encodeInternalAction = type => {
  const typeBytes = encoder.encode(type)
  assert.ok(typeBytes.byteLength <= internalTypeByteLimit)

  const packet = new Uint8Array(internalPayloadIndex)
  packet.set(typeBytes)
  packet[internalTagIndex] = 1
  packet[internalProgressIndex] = 0xff

  return packet.buffer
}

const tick = () => new Promise(res => setTimeout(res, 0))

class MockPeer {
  created = Date.now()
  connection = {}
  channel = null
  isDead = false
  handlers = {}
  destroyCount = 0
  offerPromise = Promise.resolve()

  async getOffer() {}

  async signal() {}

  sendData() {}

  destroy() {
    if (this.isDead) {
      return
    }

    this.isDead = true
    this.destroyCount += 1
    this.handlers.close?.()
  }

  setHandlers(newHandlers) {
    Object.assign(this.handlers, newHandlers)
  }

  addStream() {}
  removeStream() {}
  addTrack() {}
  removeTrack() {}
  replaceTrack() {}
}

class LinkedPeer {
  created = Date.now()
  connection = {}
  channel = {
    readyState: 'open',
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0
  }
  isDead = false
  handlers = {}
  offerPromise = Promise.resolve()
  partner = null

  async getOffer() {}

  async signal() {}

  sendData(data) {
    this.partner?.handlers.data?.(data.slice().buffer)
  }

  destroy() {
    if (this.isDead) {
      return
    }

    this.isDead = true
    this.handlers.close?.()
  }

  setHandlers(newHandlers) {
    Object.assign(this.handlers, newHandlers)
  }

  addStream() {}
  removeStream() {}
  addTrack() {}
  removeTrack() {}
  replaceTrack() {}
}

const createJoinedRooms = async () => {
  let registerPeerA = null
  let registerPeerB = null
  const roomA = room(
    f => {
      registerPeerA = f
    },
    () => {},
    () => {}
  )
  const roomB = room(
    f => {
      registerPeerB = f
    },
    () => {},
    () => {}
  )
  const joinA = new Promise(resolve => (roomA.onPeerJoin = resolve))
  const joinB = new Promise(resolve => (roomB.onPeerJoin = resolve))
  const peerA = new LinkedPeer()
  const peerB = new LinkedPeer()

  peerA.partner = peerB
  peerB.partner = peerA

  assert.ok(registerPeerA, 'expected first room to register its peer callback')
  assert.ok(registerPeerB, 'expected second room to register its peer callback')
  registerPeerA(peerA, 'peer-b')
  registerPeerB(peerB, 'peer-a')

  await Promise.all([joinA, joinB])

  return {roomA, roomB}
}

void test('Trystero: remote leave packets fire peer-leave callbacks once', async () => {
  let registerPeer = null
  const strategyPeerLeaves = []
  const roomPeerLeaves = []
  const roomRef = room(
    f => {
      registerPeer = f
    },
    id => strategyPeerLeaves.push(id),
    () => {}
  )
  const joinPromise = new Promise(resolve => (roomRef.onPeerJoin = resolve))

  roomRef.onPeerLeave = id => roomPeerLeaves.push(id)

  const peer = new MockPeer()

  assert.ok(registerPeer, 'expected room to register its peer callback')
  registerPeer(peer, 'remote-peer')

  await tick()
  peer.handlers.data?.(encodeInternalAction('@_hsready'))

  assert.equal(await joinPromise, 'remote-peer')

  peer.handlers.data?.(encodeInternalAction('@_leave'))
  await tick()

  assert.equal(peer.destroyCount, 1)
  assert.deepEqual(roomPeerLeaves, ['remote-peer'])
  assert.deepEqual(strategyPeerLeaves, ['remote-peer'])

  await roomRef.leave()
})

void test('Trystero: metadata is delivered for non-binary payloads and falsy values', async () => {
  const {roomA, roomB} = await createJoinedRooms()

  try {
    const textActionA = roomA.makeAction('text-meta')
    const textActionB = roomB.makeAction('text-meta')
    const textReceived = new Promise(resolve => {
      textActionB.onMessage = (payload, {peerId, metadata}) =>
        resolve({payload, peerId, metadata})
    })

    await textActionA.send('hello', {metadata: false})

    assert.deepEqual(await textReceived, {
      payload: 'hello',
      peerId: 'peer-a',
      metadata: false
    })

    const jsonActionA = roomA.makeAction('json-meta')
    const jsonActionB = roomB.makeAction('json-meta')
    const jsonReceived = new Promise(resolve => {
      jsonActionB.onMessage = (payload, {peerId, metadata}) =>
        resolve({payload, peerId, metadata})
    })

    await jsonActionA.send({kind: 'object'}, {metadata: 0})

    assert.deepEqual(await jsonReceived, {
      payload: {kind: 'object'},
      peerId: 'peer-a',
      metadata: 0
    })

    const queuedActionA = roomA.makeAction('queued-meta')
    const queuedActionB = roomB.makeAction('queued-meta')

    await queuedActionA.send('later', {metadata: null})
    await tick()

    const queuedReceived = new Promise(resolve => {
      queuedActionB.onMessage = (payload, {peerId, metadata}) =>
        resolve({payload, peerId, metadata})
    })

    assert.deepEqual(await queuedReceived, {
      payload: 'later',
      peerId: 'peer-a',
      metadata: null
    })
  } finally {
    await Promise.all([roomA.leave(), roomB.leave()])
  }
})

void test('Trystero: action creation uses vNext action objects', async () => {
  let registerPeer = null
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
    assert.equal(messageAction.onMessage, null)
    assert.equal(messageAction.onReceiveProgress, null)

    const requestAction = roomRef.makeAction('question', {kind: 'request'})

    assert.equal(
      roomRef.makeAction('question', {kind: 'request'}),
      requestAction
    )
    assert.throws(
      () => roomRef.makeAction('bad-request', {onRequest: () => true}),
      /kind: "request"/
    )
    assert.throws(() => roomRef.makeAction('question'), /cannot be redefined/)
  } finally {
    await roomRef.leave()
  }
})

void test('Trystero: room callback properties replace and clear handlers', async () => {
  let registerPeer = null
  const joined = []
  const roomRef = room(
    f => {
      registerPeer = f
    },
    () => {},
    () => {}
  )

  try {
    roomRef.onPeerJoin = id => joined.push(`first:${id}`)
    roomRef.onPeerJoin = id => joined.push(`second:${id}`)

    assert.ok(registerPeer, 'expected room to register its peer callback')
    const peer = new MockPeer()

    registerPeer(peer, 'remote-peer')
    await tick()
    peer.handlers.data?.(encodeInternalAction('@_hsready'))
    await tick()

    assert.deepEqual(joined, ['second:remote-peer'])

    roomRef.onPeerJoin = null

    assert.equal(roomRef.onPeerJoin, null)
  } finally {
    await roomRef.leave()
  }
})

void test('Trystero: request actions resolve, reject, buffer briefly, and fan out', async () => {
  const {roomA, roomB} = await createJoinedRooms()

  try {
    const isEvenA = roomA.makeAction('is-even', {kind: 'request'})
    roomB.makeAction('is-even', {
      kind: 'request',
      onRequest: value => value % 2 === 0
    })

    assert.equal(await isEvenA.request(4, {target: 'peer-b'}), true)

    const rejectsA = roomA.makeAction('rejects', {kind: 'request'})
    roomB.makeAction('rejects', {
      kind: 'request',
      onRequest: () => {
        throw new Error('no thanks')
      }
    })

    await assert.rejects(
      () => rejectsA.request('please', {target: 'peer-b'}),
      /no thanks/
    )

    const lateA = roomA.makeAction('late-request', {kind: 'request'})
    const lateB = roomB.makeAction('late-request', {kind: 'request'})
    const lateResult = lateA.request('hello', {
      target: 'peer-b',
      timeoutMs: 1_000
    })

    await tick()
    lateB.onRequest = () => 'hello back'

    assert.equal(await lateResult, 'hello back')

    const missingA = roomA.makeAction('missing-handler', {kind: 'request'})
    roomB.makeAction('missing-handler', {kind: 'request'})

    await assert.rejects(
      () =>
        missingA.request('hello', {
          target: 'peer-b',
          timeoutMs: 1_000
        }),
      /unavailable/
    )

    const fanoutResults = []
    const many = await isEvenA.requestMany(6, {
      targets: ['missing-peer', 'peer-b'],
      timeoutMs: 1_000,
      onResult: result => fanoutResults.push(result)
    })

    assert.deepEqual(
      many.map(result => result.peerId),
      ['missing-peer', 'peer-b']
    )
    assert.deepEqual(
      many.map(result => result.status),
      ['disconnected', 'fulfilled']
    )
    assert.equal(many[1].value, true)
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
  const {roomA, roomB} = await createJoinedRooms()

  try {
    const slowA = roomA.makeAction('slow-request', {kind: 'request'})
    roomB.makeAction('slow-request', {
      kind: 'request',
      onRequest: async value => {
        await new Promise(res => setTimeout(res, 50))
        return value
      }
    })
    const controller = new AbortController()
    const pending = slowA.request('later', {
      target: 'peer-b',
      signal: controller.signal
    })

    controller.abort()

    await assert.rejects(
      () => pending,
      error => error.name === 'AbortError'
    )
    await new Promise(res => setTimeout(res, 80))
  } finally {
    await Promise.all([roomA.leave(), roomB.leave()])
  }
})
