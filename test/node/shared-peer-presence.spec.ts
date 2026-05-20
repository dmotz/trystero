// @ts-nocheck
import assert from 'node:assert/strict'
import test from './test.ts'
import {SharedPeerManager} from '../../packages/core/src/shared-peer.ts'
import {LinkedPeer, linkPeers, tick} from './peer-harness.ts'

void test('Trystero: shared peer room presence uses opaque tokens and routes buffered data by token', async () => {
  const managerA = new SharedPeerManager()
  const managerB = new SharedPeerManager()
  const {peerA, peerB} = linkPeers(new LinkedPeer(), new LinkedPeer())
  const decoder = new TextDecoder()
  const roomId = 'super-secret-room'
  const roomToken = 'opaque-room-token'
  const presenceEvents = []
  const receivedPayloads = []

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
