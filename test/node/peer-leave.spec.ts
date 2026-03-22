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
  channel = {readyState: 'open', bufferedAmount: 0, bufferedAmountLowThreshold: 0}
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
  const joinA = new Promise(resolve => roomA.onPeerJoin(resolve))
  const joinB = new Promise(resolve => roomB.onPeerJoin(resolve))
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
  const joinPromise = new Promise(resolve => roomRef.onPeerJoin(resolve))

  roomRef.onPeerLeave(id => roomPeerLeaves.push(id))

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

void test(
  'Trystero: metadata is delivered for non-binary payloads and falsy values',
  async () => {
    const {roomA, roomB} = await createJoinedRooms()

    try {
      const textReceived = new Promise(resolve =>
        roomB
          .makeAction('text-meta')[1]((payload, peerId, metadata) =>
            resolve({payload, peerId, metadata})
          )
      )

      await roomA.makeAction('text-meta')[0]('hello', undefined, false)

      assert.deepEqual(await textReceived, {
        payload: 'hello',
        peerId: 'peer-a',
        metadata: false
      })

      const jsonReceived = new Promise(resolve =>
        roomB
          .makeAction('json-meta')[1]((payload, peerId, metadata) =>
            resolve({payload, peerId, metadata})
          )
      )

      await roomA.makeAction('json-meta')[0]({kind: 'object'}, undefined, 0)

      assert.deepEqual(await jsonReceived, {
        payload: {kind: 'object'},
        peerId: 'peer-a',
        metadata: 0
      })

      await roomA.makeAction('queued-meta')[0]('later', undefined, null)
      await tick()

      const queuedReceived = new Promise(resolve =>
        roomB
          .makeAction('queued-meta')[1]((payload, peerId, metadata) =>
            resolve({payload, peerId, metadata})
          )
      )

      assert.deepEqual(await queuedReceived, {
        payload: 'later',
        peerId: 'peer-a',
        metadata: null
      })
    } finally {
      await Promise.all([roomA.leave(), roomB.leave()])
    }
  }
)
