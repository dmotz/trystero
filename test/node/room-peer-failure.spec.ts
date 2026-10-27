import assert from 'node:assert/strict'
import test from './test.ts'
import {
  LinkedPeer,
  MockPeer,
  actionStartFrame,
  encodeInternalAction,
  linkPeers,
  turn,
  waitFor
} from './peer-harness.ts'
// @ts-expect-error Internal source import crosses a referenced package boundary.
import createRoom from '../../packages/core/src/room.ts'

const metadataAction = (type: string, key: string) => {
  const payload = new TextEncoder().encode(JSON.stringify({k: key}))
  const bytes = new Uint8Array(36 + payload.length)
  bytes.set(new Uint8Array(encodeInternalAction(type)))
  bytes[1] = 16 // Inline JSON.
  bytes.set(payload, 36)
  return bytes.buffer
}
for (const fault of ['wire', 'stream']) {
  void test(`a ${fault} fault removes and destroys the room peer`, async t => {
    t.mock.method(console, 'warn', () => {})
    const peer = new MockPeer()
    let connect
    const room = createRoom(
      callback => {
        connect = callback
      },
      () => {},
      () => {}
    )
    connect(peer, 'peer')
    t.after(async () => {
      await room.leave()
    })
    peer.handlers.data(encodeInternalAction('@_hsready'))
    await waitFor(() => 'peer' in room.getPeers())
    let leaves = 0
    room.onPeerLeave = () => {
      leaves++
    }
    const request = room
      .makeAction('waiting', {kind: 'request'})
      .request('', {target: 'peer'})
      .catch(error => error.kind)
    const ping = room.ping('peer').catch(error => error.message)
    const malformed = new Uint8Array(36).buffer
    for (let i = 0; i < (fault === 'wire' ? 1 : 65); i++) {
      peer.handlers.data(
        fault === 'wire' ? malformed : metadataAction(`@_${fault}`, String(i))
      )
    }
    assert.deepEqual(room.getPeers(), {})
    assert.equal(await request, 'disconnected')
    assert.match(await ping, /protocol|metadata/)
    assert.equal(leaves, 1)
    assert.equal(peer.isDead, true)
    await room.leave()
    assert.equal(leaves, 1)
  })
}

const fileOffer = (id: number, type = 'file', size = 20_000) =>
  actionStartFrame(id, size, {type})

for (const saturation of ['policies', 'transfers']) {
  void test(`media control messages bypass saturated ${saturation} and retain their size limit`, async t => {
    let connect
    const room = createRoom(
      callback => {
        connect = callback
      },
      () => {},
      () => {}
    )
    const peer = new MockPeer()
    t.after(() => room.leave())
    connect(peer, 'peer')
    peer.handlers.data(encodeInternalAction('@_hsready'))
    await waitFor(() => 'peer' in room.getPeers())
    const approvals: ((allow: boolean) => void)[] = []
    t.after(() => approvals.forEach(resolve => resolve(false)))
    if (saturation === 'policies') {
      room.makeAction('file', {
        onMessage: () => {},
        onReceive: () => new Promise(resolve => approvals.push(resolve))
      })
    }
    for (let id = 0; id < (saturation === 'policies' ? 8 : 64); id++) {
      peer.handlers.data(fileOffer(id))
    }
    let streams = 0
    room.onPeerStream = () => streams++
    const track = {id: 'track'}
    const stream = {id: 'stream', getTracks: () => [track]}
    peer.handlers.data(metadataAction('@_stream', 's'))
    peer.handlers.stream(stream)
    assert.equal(streams, 1)
    const controls: number[] = []
    peer.sendData = (bytes?: Uint8Array) => {
      if (bytes) {
        controls.push(bytes[1] & 15)
      }
    }
    peer.handlers.data(fileOffer(100, '@_stream', 65_537))
    assert.deepEqual(controls, [4])
    assert.ok('peer' in room.getPeers())
  })
}

void test('application policy saturation does not block new peer handshakes', async t => {
  let connect
  const proofs: string[] = []
  const room = createRoom(
    callback => {
      connect = callback
    },
    () => {},
    () => {},
    {
      onPeerHandshake: async (id, _send, receive) => {
        await receive()
        proofs.push(id)
      }
    }
  )
  t.after(() => room.leave())
  const approvals: ((allow: boolean) => void)[] = []
  t.after(() => approvals.forEach(resolve => resolve(false)))
  room.makeAction('file', {
    onMessage: () => {},
    onReceive: () => new Promise(resolve => approvals.push(resolve))
  })
  const join = id => {
    const peer = new MockPeer()
    connect(peer, id)
    peer.handlers.data(encodeInternalAction('@_hsdata'))
    peer.handlers.data(encodeInternalAction('@_hsready'))
    return peer
  }
  const peers = Array.from({length: 16}, (_, index) => join(`peer-${index}`))
  await waitFor(() => Object.keys(room.getPeers()).length === 16)
  for (const peer of peers) {
    for (let id = 0; id < 8; id++) {
      peer.handlers.data(fileOffer(id))
    }
  }
  assert.equal(approvals.length, 128)
  join('new-peer')
  await turn()
  assert.ok(proofs.includes('new-peer'))
  assert.ok('new-peer' in room.getPeers())
})

void test('room peer errors and handshake failures notify the remote peer to exit the room', async t => {
  t.mock.method(console, 'warn', () => {})
  const createPair = (rejectHandshake = false) => {
    const {peerA, peerB} = linkPeers(new LinkedPeer(), new LinkedPeer())
    let connectA
    let connectB
    const roomA = createRoom(
      callback => {
        connectA = callback
      },
      () => {},
      () => {},
      rejectHandshake
        ? {
            onPeerHandshake: async () => {
              throw new Error('rejected handshake')
            },
            onHandshakeError: () => {}
          }
        : undefined
    )
    const roomB = createRoom(
      callback => {
        connectB = callback
      },
      () => {},
      () => {}
    )
    connectA(peerA, 'peer-b')
    connectB(peerB, 'peer-a')
    return {roomA, roomB, peerA, peerB}
  }
  const bad = createPair()
  t.after(async () => {
    await Promise.all([bad.roomA.leave(), bad.roomB.leave()])
  })
  await waitFor(
    () => 'peer-b' in bad.roomA.getPeers() && 'peer-a' in bad.roomB.getPeers()
  )
  let remoteLeaves = 0
  bad.roomB.onPeerLeave = () => {
    remoteLeaves++
  }
  // Trigger a room-level wire fault on bad.roomA; bad.roomB should also exit.
  bad.peerA.handlers.data(new Uint8Array(36).buffer)
  await waitFor(() => !('peer-a' in bad.roomB.getPeers()))
  assert.equal(remoteLeaves, 1)

  // A handshake failure on roomA must also cause roomB to exit that room.
  const rejected = createPair(true)
  t.after(async () => {
    await Promise.all([rejected.roomA.leave(), rejected.roomB.leave()])
  })
  await waitFor(
    () =>
      !('peer-b' in rejected.roomA.getPeers()) &&
      !('peer-a' in rejected.roomB.getPeers())
  )
})
