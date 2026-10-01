import assert from 'node:assert/strict'
import test from './test.ts'
import {
  LinkedPeer,
  MockPeer,
  actionStartFrame,
  encodeInternalAction,
  linkPeers,
  roomFrame as frame,
  turn,
  waitFor
} from './peer-harness.ts'
// @ts-expect-error Internal source import crosses a referenced package boundary.
import createRoom from '../../packages/core/src/room.ts'
// @ts-expect-error Internal source import crosses a referenced package boundary.
import {SharedPeerManager} from '../../packages/core/src/shared-peer.ts'

const metadataAction = (type: string, key: string) => {
  const payload = new TextEncoder().encode(JSON.stringify({k: key}))
  const bytes = new Uint8Array(36 + payload.length)
  bytes.set(new Uint8Array(encodeInternalAction(type)))
  bytes[1] = 16 // Inline JSON.
  bytes.set(payload, 36)
  return bytes.buffer
}
for (const fault of ['wire', 'stream', 'track']) {
  void test(`a ${fault} fault removes the room peer while preserving other rooms`, async t => {
    t.mock.method(console, 'warn', () => {})
    const manager = new SharedPeerManager()
    const physical = new MockPeer()
    const shared = manager.register('app', 'peer', physical as never, 60_000)
    const rooms = ['bad', 'good'].map(token => {
      const {proxy} = manager.bind(token, Promise.resolve(token), shared, {
        onDetach: () => {}
      })
      let connect
      const room = createRoom(
        callback => {
          connect = callback
        },
        () => {},
        () => {}
      )
      connect(proxy, 'peer')
      return room
    })
    t.after(async () => {
      await Promise.all(rooms.map(room => room.leave()))
      manager.clear('app', 'peer', {destroyPeer: true})
    })
    for (const token of ['bad', 'good']) {
      physical.handlers.data(frame(token, encodeInternalAction('@_hsready')))
    }
    await waitFor(() => rooms.every(room => 'peer' in room.getPeers()))
    const [bad, good] = rooms
    let leaves = 0
    bad.onPeerLeave = () => {
      leaves++
    }
    const request = bad
      .makeAction('waiting', {kind: 'request'})
      .request('', {target: 'peer'})
      .catch(error => error.kind)
    const ping = bad.ping('peer').catch(error => error.message)
    let healthyMessages = 0
    good.makeAction('healthy', {
      onMessage: () => {
        healthyMessages++
      }
    })
    const malformed = new Uint8Array(36).buffer
    for (let i = 0; i < (fault === 'wire' ? 1 : 65); i++) {
      physical.handlers.data(
        frame(
          'bad',
          fault === 'wire' ? malformed : metadataAction(`@_${fault}`, String(i))
        )
      )
    }
    assert.deepEqual(bad.getPeers(), {})
    assert.equal(await request, 'disconnected')
    assert.match(await ping, /protocol|metadata/)
    assert.equal(leaves, 1)
    assert.equal(physical.isDead, false)
    assert.ok('peer' in good.getPeers())
    physical.handlers.data(frame('good', encodeInternalAction('healthy')))
    await waitFor(() => healthyMessages === 1)
    await bad.leave()
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
    let tracks = 0
    room.onPeerStream = () => streams++
    room.onPeerTrack = () => tracks++
    const track = {id: 'track'}
    const stream = {id: 'stream', getTracks: () => [track]}
    peer.handlers.data(metadataAction('@_stream', 's'))
    peer.handlers.stream(stream)
    peer.handlers.data(metadataAction('@_track', 't'))
    peer.handlers.track(track, stream)
    assert.equal(streams, 1)
    assert.equal(tracks, 1)
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

void test('room peer errors and handshake failures notify the remote shared peer to exit that room', async t => {
  t.mock.method(console, 'warn', () => {})
  const managerA = new SharedPeerManager()
  const managerB = new SharedPeerManager()
  const {peerA, peerB} = linkPeers(new LinkedPeer(), new LinkedPeer())
  const sharedA = managerA.register('app', 'peer-b', peerA as never, 60_000)
  const sharedB = managerB.register('app', 'peer-a', peerB as never, 60_000)
  t.after(() => {
    managerA.clear('app', 'peer-b', {destroyPeer: true})
    managerB.clear('app', 'peer-a', {destroyPeer: true})
  })
  const bindPair = (token: string, rejectHandshake = false) => {
    const {proxy: proxyA} = managerA.bind(
      token,
      Promise.resolve(token),
      sharedA,
      {
        onDetach: () => {}
      }
    )
    const {proxy: proxyB} = managerB.bind(
      token,
      Promise.resolve(token),
      sharedB,
      {
        onDetach: () => {}
      }
    )
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
    connectA(proxyA, 'peer-b')
    connectB(proxyB, 'peer-a')
    return {roomA, roomB}
  }
  const bad = bindPair('bad')
  const good = bindPair('good')
  t.after(async () => {
    await Promise.all([
      bad.roomA.leave(),
      bad.roomB.leave(),
      good.roomA.leave(),
      good.roomB.leave()
    ])
  })
  await waitFor(
    () =>
      'peer-b' in bad.roomA.getPeers() &&
      'peer-a' in bad.roomB.getPeers() &&
      'peer-b' in good.roomA.getPeers() &&
      'peer-a' in good.roomB.getPeers()
  )
  let remoteLeaves = 0
  bad.roomB.onPeerLeave = () => {
    remoteLeaves++
  }
  // Trigger a room-level wire fault on bad.roomA; bad.roomB should also exit.
  peerA.handlers.data(frame('bad', new Uint8Array(36).buffer))
  await waitFor(() => !('peer-a' in bad.roomB.getPeers()))
  assert.equal(remoteLeaves, 1)
  assert.ok('peer-a' in good.roomB.getPeers())

  // A handshake failure on roomA must also cause roomB to exit that room.
  const rejected = bindPair('rejected', true)
  t.after(async () => {
    await Promise.all([rejected.roomA.leave(), rejected.roomB.leave()])
  })
  await waitFor(
    () =>
      !('peer-b' in rejected.roomA.getPeers()) &&
      !('peer-a' in rejected.roomB.getPeers())
  )
  assert.ok('peer-a' in good.roomB.getPeers())
})

void test('renegotiation signals route to an active room instead of a room still in handshake', async t => {
  const manager = new SharedPeerManager()
  const physical = new MockPeer()
  const sentTokens: string[] = []
  physical.sendData = (bytes?: Uint8Array) => {
    if (bytes && bytes[0] === 1) {
      const len = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength
      ).getUint16(1)
      sentTokens.push(new TextDecoder().decode(bytes.subarray(3, 3 + len)))
    }
  }
  const shared = manager.register('app', 'peer', physical as never, 60_000)
  t.after(() => manager.clear('app', 'peer', {destroyPeer: true}))
  let releasePendingHandshake: () => void
  const createBoundRoom = (token: string, blockHandshake: boolean) => {
    const {proxy} = manager.bind(token, Promise.resolve(token), shared, {
      onDetach: () => {}
    })
    let connect
    const room = createRoom(
      callback => {
        connect = callback
      },
      () => {},
      () => {},
      blockHandshake
        ? {
            onPeerHandshake: () =>
              new Promise<void>(resolve => {
                releasePendingHandshake = resolve
              })
          }
        : undefined
    )
    connect(proxy, 'peer')
    return room
  }
  const pendingRoom = createBoundRoom('pending', true)
  const activeRoom = createBoundRoom('active', false)
  t.after(async () => {
    releasePendingHandshake?.()
    await Promise.all([pendingRoom.leave(), activeRoom.leave()])
  })
  await turn()
  physical.handlers.data(frame('active', encodeInternalAction('@_hsready')))
  await waitFor(() => 'peer' in activeRoom.getPeers())
  assert.equal(shared.controlRoomId, 'pending')
  sentTokens.length = 0

  physical.handlers.signal({type: 'offer', sdp: 'renegotiation-sdp'})
  await turn()
  assert.equal(physical.isDead, false)
  assert.equal(shared.controlRoomId, 'active')
  assert.deepEqual(sentTokens, ['active'])
})
