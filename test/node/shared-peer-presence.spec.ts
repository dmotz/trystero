import assert from 'node:assert/strict'
import test from './test.ts'
// @ts-expect-error Internal source import crosses a referenced package boundary.
import {SharedPeerManager} from '../../packages/core/src/shared-peer.ts'
import {LinkedPeer, linkPeers, tick} from './peer-harness.ts'

void test('Trystero: shared peer room presence uses opaque tokens and routes buffered data by token', async t => {
  const managerA = new SharedPeerManager()
  const managerB = new SharedPeerManager()
  const {peerA, peerB} = linkPeers(new LinkedPeer(), new LinkedPeer())
  const decoder = new TextDecoder()
  const roomId = 'super-secret-room'
  const roomToken = 'opaque-room-token'
  const receivedPayloads = []

  const sharedA = managerA.register('app-id', 'peer-b', peerA as any, 60_000)
  const sharedB = managerB.register('app-id', 'peer-a', peerB as any, 60_000)

  t.after(() => {
    managerA.clear('app-id', 'peer-b', {destroyPeer: true})
    managerB.clear('app-id', 'peer-a', {destroyPeer: true})
  })

  const {proxy: proxyA} = managerA.bind(
    roomId,
    Promise.resolve(roomToken),
    sharedA,
    {onDetach: () => {}}
  )

  let resolveToken: (token: string) => void
  const {proxy: proxyB} = managerB.bind(
    roomId,
    new Promise(resolve => {
      resolveToken = resolve
    }),
    sharedB,
    {onDetach: () => {}}
  )

  await tick()

  managerA.sendRoomPresence(sharedA, roomToken, true)
  await tick()

  assert.equal(sharedB.remoteRoomTokens.has(roomToken), true)

  proxyA.sendData(Uint8Array.of(1, 2, 3))
  await tick()

  const rawFrameText = decoder.decode(new Uint8Array(peerA.lastSentData))
  assert.equal(
    rawFrameText.includes(roomId),
    false,
    'shared-peer frames should not expose plaintext room ids'
  )

  resolveToken(roomToken)

  proxyB.setHandlers({
    data: data => receivedPayloads.push(Array.from(new Uint8Array(data)))
  })

  await tick()

  assert.deepEqual(receivedPayloads, [[1, 2, 3]])

  managerA.sendRoomPresence(sharedA, roomToken, false)
  await tick()

  assert.equal(sharedB.remoteRoomTokens.has(roomToken), false)
  assert.equal(sharedB.bindings[roomId], undefined)
})

void test('Trystero: departure clears queued room data and cannot detach a replacement binding', async () => {
  const managerA = new SharedPeerManager()
  const managerB = new SharedPeerManager()
  const {peerA, peerB} = linkPeers(new LinkedPeer(), new LinkedPeer())
  const sharedA = managerA.register('app-id', 'peer-b', peerA as any, 60_000)
  const sharedB = managerB.register('app-id', 'peer-a', peerB as any, 60_000)
  const bind = (manager, shared, roomId, token) =>
    manager.bind(roomId, Promise.resolve(token), shared, {onDetach: () => {}})

  try {
    bind(managerB, sharedB, 'lobby', 'lobby-token')
    const sender = bind(managerA, sharedA, 'room', 'room-token')
    await tick()
    const pending = managerB.bind('joining', new Promise(() => {}), sharedB, {
      onDetach: () => {}
    })
    sender.proxy.sendData(Uint8Array.of(1))
    assert.equal(sharedB.pendingDataByToken.get('room-token').length, 1)

    managerA.sendRoomPresence(sharedA, 'room-token', false)
    assert.equal(sharedB.pendingDataByToken.has('room-token'), false)
    pending.proxy.destroy()

    const previous = bind(managerB, sharedB, 'room', 'room-token')
    let replacement = null
    let closes = 0
    previous.proxy.setHandlers({
      close: () => {
        closes++
        previous.proxy.destroy()
        replacement = bind(managerB, sharedB, 'room', 'room-token')
      }
    })
    await tick()
    managerA.sendRoomPresence(sharedA, 'room-token', false)

    assert.equal(closes, 1)
    assert.equal(sharedB.bindings['room'].proxy, replacement.proxy)
    previous.proxy.destroy()
    assert.equal(sharedB.bindings['room'].proxy, replacement.proxy)

    // Departure must also detach a binding with no installed close handler.
    await tick()
    managerA.sendRoomPresence(sharedA, 'room-token', false)
    managerA.sendRoomPresence(sharedA, 'room-token', false)
    assert.equal(sharedB.bindings['room'], undefined)
    assert.equal(closes, 1)
    assert.ok(sharedB.bindings['lobby'])
    assert.equal(peerB.isDead, false)
  } finally {
    managerA.clear('app-id', 'peer-b', {destroyPeer: true})
    managerB.clear('app-id', 'peer-a', {destroyPeer: true})
  }
})
