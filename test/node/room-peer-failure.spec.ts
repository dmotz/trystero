import assert from 'node:assert/strict'
import test from './test.ts'
import {
  LinkedPeer,
  actionStartFrame,
  encodeInternalAction,
  internalActionPrefix,
  linkPeers,
  testEndpoint,
  testPeerId,
  waitFor
} from './peer-harness.ts'
import createRoom from '../../packages/core/src/room.ts'
import type {PeerHandle} from '../../packages/core/src/internal-types.ts'

const metadataAction = (type: string, key: string) => {
  const payload = new TextEncoder().encode(JSON.stringify({k: key}))
  const bytes = new Uint8Array(36 + payload.length)
  bytes.set(new Uint8Array(encodeInternalAction(type)))
  bytes[1] = 16 // Inline JSON.
  bytes.set(payload, 36)
  return bytes.buffer
}

const connectRealPair = (label: string) => {
  const epLocal = testEndpoint(`${label}-local`)
  const epRemote = testEndpoint(`${label}-remote`)
  let connectLocal!: (peer: PeerHandle, id: string) => void
  let connectRemote!: (peer: PeerHandle, id: string) => void
  const room = createRoom(
    callback => {
      connectLocal = callback
    },
    () => {},
    () => {},
    {endpointIdentity: epLocal, appId: 'fault-app', roomId: `fault-${label}`}
  )
  const remoteRoom = createRoom(
    callback => {
      connectRemote = callback
    },
    () => {},
    () => {},
    {endpointIdentity: epRemote, appId: 'fault-app', roomId: `fault-${label}`}
  )
  const {peerA: localPeer, peerB: remotePeer} = linkPeers(
    new LinkedPeer(),
    new LinkedPeer()
  )
  connectLocal(localPeer as unknown as PeerHandle, epRemote.peerId)
  connectRemote(remotePeer as unknown as PeerHandle, epLocal.peerId)
  return {room, remoteRoom, localPeer, remotePeer, epLocal, epRemote}
}

for (const fault of ['wire', 'stream']) {
  void test(`a ${fault} fault removes and destroys the room peer`, async t => {
    t.mock.method(console, 'warn', () => {})
    const {room, remoteRoom, localPeer, epRemote} = connectRealPair(
      `fault-${fault}`
    )
    t.after(async () => {
      await Promise.all([room.leave(), remoteRoom.leave()])
    })
    await waitFor(() => epRemote.peerId in room.getPeers())
    let leaves = 0
    room.onPeerLeave(() => {
      leaves++
    })
    const request = room
      .makeAction('waiting', {kind: 'request'})
      .request('', {target: epRemote.peerId})
      .catch(error => error.kind)
    const ping = room.ping(epRemote.peerId).catch(error => error.message)
    const malformed = new Uint8Array(36).buffer
    for (let i = 0; i < (fault === 'wire' ? 1 : 65); i++) {
      localPeer.handlers.data!(
        fault === 'wire' ? malformed : metadataAction(fault, String(i))
      )
    }
    assert.deepEqual(room.getPeers(), {})
    assert.equal(await request, 'disconnected')
    assert.match(await ping, /protocol|metadata/)
    assert.equal(leaves, 1)
    assert.equal(localPeer.isDead, true)
    await room.leave()
    assert.equal(leaves, 1)
  })
}

const fileOffer = (id: number, type = 'file', size = 20_000) =>
  actionStartFrame(id, size, {type})

for (const saturation of ['policies', 'transfers']) {
  void test(`media control messages bypass saturated ${saturation} and retain their size limit`, async t => {
    const {room, remoteRoom, localPeer, epRemote} = connectRealPair(
      `sat-${saturation}`
    )
    t.after(() => Promise.all([room.leave(), remoteRoom.leave()]))
    await waitFor(() => epRemote.peerId in room.getPeers())
    const approvals: ((allow: boolean) => void)[] = []
    t.after(() => approvals.forEach(resolve => resolve(false)))
    const file = room.makeAction('file')
    if (saturation === 'policies') {
      file.onMessage(() => {})
      file.onReceive(() => new Promise(resolve => approvals.push(resolve)))
    }
    for (let id = 0; id < (saturation === 'policies' ? 8 : 64); id++) {
      localPeer.handlers.data!(fileOffer(id))
    }
    let streams = 0
    room.onPeerStream(() => {
      streams++
    })
    const track = {id: 'track'}
    const stream = {id: 'stream', getTracks: () => [track]}
    localPeer.handlers.data!(metadataAction('stream', 's'))
    localPeer.handlers.stream!(stream)
    assert.equal(streams, 1)
    const controls: number[] = []
    localPeer.sendData = (bytes?: Uint8Array | ArrayBuffer) => {
      if (bytes) {
        const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
        controls.push((view[1] ?? 0) & 15)
      }
    }
    localPeer.handlers.data!(
      fileOffer(100, `${internalActionPrefix}stream`, 65_537)
    )
    assert.deepEqual(controls, [4])
    assert.ok(epRemote.peerId in room.getPeers())
  })
}

void test('application policy saturation does not block new peer handshakes', async t => {
  const epHost = testEndpoint('sat-hs-host')
  let connectHost!: (peer: PeerHandle, id: string) => void
  const room = createRoom(
    callback => {
      connectHost = callback
    },
    () => {},
    () => {},
    {endpointIdentity: epHost, appId: 'sat-hs-app', roomId: 'sat-hs-room'}
  )
  const remoteRooms: ReturnType<typeof createRoom>[] = []
  t.after(() => Promise.all([room.leave(), ...remoteRooms.map(r => r.leave())]))
  const approvals: ((allow: boolean) => void)[] = []
  t.after(() => approvals.forEach(resolve => resolve(false)))
  const file = room.makeAction('file')
  file.onMessage(() => {})
  file.onReceive(() => new Promise(resolve => approvals.push(resolve)))
  const join = (label: string) => {
    const ep = testEndpoint(label)
    let connectRemote!: (peer: PeerHandle, id: string) => void
    const remote = createRoom(
      callback => {
        connectRemote = callback
      },
      () => {},
      () => {},
      {endpointIdentity: ep, appId: 'sat-hs-app', roomId: 'sat-hs-room'}
    )
    remoteRooms.push(remote)
    const {peerA, peerB} = linkPeers(new LinkedPeer(), new LinkedPeer())
    connectHost(peerA as unknown as PeerHandle, ep.peerId)
    connectRemote(peerB as unknown as PeerHandle, epHost.peerId)
    return {peer: peerA, ep}
  }
  const peers = Array.from({length: 16}, (_, index) =>
    join(`sat-hs-peer-${index}`)
  )
  await waitFor(() => Object.keys(room.getPeers()).length === 16)
  for (const {peer} of peers) {
    for (let id = 0; id < 8; id++) {
      peer.handlers.data!(fileOffer(id))
    }
  }
  assert.equal(approvals.length, 128)
  const late = join('sat-hs-new-peer')
  await waitFor(() => late.ep.peerId in room.getPeers())
  assert.ok(late.ep.peerId in room.getPeers())
})

void test('room peer errors and handshake failures notify the remote peer to exit the room', async t => {
  t.mock.method(console, 'warn', () => {})
  const createPair = (label: string, rejectHandshake = false) => {
    const epA = testEndpoint(`${label}-a`)
    const epB = testEndpoint(`${label}-b`)
    const {peerA, peerB} = linkPeers(new LinkedPeer(), new LinkedPeer())
    let connectA!: (peer: PeerHandle, id: string) => void
    let connectB!: (peer: PeerHandle, id: string) => void
    const roomA = createRoom(
      callback => {
        connectA = callback
      },
      () => {},
      () => {},
      {
        endpointIdentity: epA,
        appId: 'exit-app',
        roomId: `exit-${label}`
      }
    )
    const roomB = createRoom(
      callback => {
        connectB = callback
      },
      () => {},
      () => {},
      {endpointIdentity: epB, appId: 'exit-app', roomId: `exit-${label}`}
    )
    let remoteIdForA = epB.peerId
    if (rejectHandshake) {
      for (let idx = 0; ; idx++) {
        const candidate = testPeerId(`${label}-impersonated-${idx}`)
        if (
          candidate !== epB.peerId &&
          candidate !== epA.peerId &&
          epA.peerId < candidate === epA.peerId < epB.peerId
        ) {
          remoteIdForA = candidate
          break
        }
      }
    }
    connectA(peerA as unknown as PeerHandle, remoteIdForA)
    connectB(peerB as unknown as PeerHandle, epA.peerId)
    return {roomA, roomB, peerA, peerB, epA, epB}
  }
  const bad = createPair('wire-fault')
  t.after(async () => {
    await Promise.all([bad.roomA.leave(), bad.roomB.leave()])
  })
  await waitFor(
    () =>
      bad.epB.peerId in bad.roomA.getPeers() &&
      bad.epA.peerId in bad.roomB.getPeers()
  )
  let remoteLeaves = 0
  bad.roomB.onPeerLeave(() => {
    remoteLeaves++
  })
  // Trigger a room-level wire fault on bad.roomA; bad.roomB should also exit.
  bad.peerA.handlers.data!(new Uint8Array(36).buffer)
  await waitFor(() => !(bad.epA.peerId in bad.roomB.getPeers()))
  assert.equal(remoteLeaves, 1)

  // A handshake failure on roomA must also cause roomB to exit that room.
  const rejected = createPair('hs-mismatch', true)
  t.after(async () => {
    await Promise.all([rejected.roomA.leave(), rejected.roomB.leave()])
  })
  await waitFor(() => rejected.peerA.isDead && rejected.peerB.isDead)
  assert.equal(rejected.epB.peerId in rejected.roomA.getPeers(), false)
  assert.equal(rejected.epA.peerId in rejected.roomB.getPeers(), false)
})
