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
