// @ts-nocheck
import assert from 'node:assert/strict'
import test from 'node:test'
import {SharedPeerManager} from '../../packages/core/src/shared-peer.ts'

const tick = () => new Promise(res => setTimeout(res, 0))

class LinkedPeer {
  created = Date.now()
  isDead = false
  handlers = {}
  offerPromise = Promise.resolve()
  partner = null
  lastSentData = null
  connection = {
    connectionState: 'connected',
    iceConnectionState: 'connected',
    getSenders: () => []
  }
  channel = {readyState: 'open'}

  async getOffer() {}

  async signal() {}

  sendData(data) {
    this.lastSentData = data.slice().buffer
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
  addTrack() {
    return {}
  }
  removeTrack() {}
  replaceTrack() {}
}

void test('Trystero: shared peer room presence uses opaque tokens and routes buffered data by token', async () => {
  const managerA = new SharedPeerManager()
  const managerB = new SharedPeerManager()
  const peerA = new LinkedPeer()
  const peerB = new LinkedPeer()
  const decoder = new TextDecoder()
  const roomId = 'super-secret-room'
  const roomToken = 'opaque-room-token'
  const presenceEvents = []
  const receivedPayloads = []

  peerA.partner = peerB
  peerB.partner = peerA

  const sharedA = managerA.register('app-id', 'peer-b', peerA, 60_000)
  const sharedB = managerB.register('app-id', 'peer-a', peerB, 60_000)

  managerB.setRoomPresenceHandler(
    'app-id',
    (peerId, token, isPresent) =>
      void presenceEvents.push({peerId, token, isPresent})
  )

  const {proxy: proxyA} = managerA.bind(
    roomId,
    Promise.resolve(roomToken),
    sharedA,
    {onDetach: () => {}}
  )

  await tick()

  managerA.sendRoomPresence(sharedA, roomToken, true)
  await tick()

  assert.deepEqual(presenceEvents, [
    {peerId: 'peer-a', token: roomToken, isPresent: true}
  ])
  assert.equal(sharedB.remoteRoomTokens.has(roomToken), true)

  proxyA.sendData(Uint8Array.of(1, 2, 3))
  await tick()

  const rawFrameText = decoder.decode(new Uint8Array(peerA.lastSentData))
  assert.equal(
    rawFrameText.includes(roomId),
    false,
    'shared-peer frames should not expose plaintext room ids'
  )

  const {proxy: proxyB} = managerB.bind(
    roomId,
    Promise.resolve(roomToken),
    sharedB,
    {onDetach: () => {}}
  )

  proxyB.setHandlers({
    data: data => receivedPayloads.push(Array.from(new Uint8Array(data)))
  })

  await tick()

  assert.deepEqual(receivedPayloads, [[1, 2, 3]])

  managerA.sendRoomPresence(sharedA, roomToken, false)
  await tick()

  assert.equal(sharedB.remoteRoomTokens.has(roomToken), false)
})
