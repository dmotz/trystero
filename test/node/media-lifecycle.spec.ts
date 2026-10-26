import assert from 'node:assert/strict'
import test from './test.ts'
import {
  createMediaIdentityCache,
  createMediaManager
  // @ts-expect-error Internal source import crosses a referenced package boundary.
} from '../../packages/core/src/media.ts'
// @ts-expect-error Internal source import crosses a referenced package boundary.
import createRoom from '../../packages/core/src/room.ts'
import {
  LinkedMediaPeer,
  MockPeer,
  linkPeers,
  turn,
  withTimeout
} from './peer-harness.ts'

void test('media metadata keeps one current alias per native object and preserves native ID lookup', () => {
  const cache = createMediaIdentityCache()
  const track = {id: 'track', readyState: 'live'} as MediaStreamTrack
  const stream = {id: 'stream', getTracks: () => [track]} as MediaStream
  const errors: Error[] = []
  const manager = createMediaManager({
    iterate: () => [],
    isActive: () => true,
    onPeerError: (_id, error) => errors.push(error)
  })
  cache.rememberRemoteStream('initial-stream', stream, stream.id)
  cache.rememberRemoteTrack('initial-track', track, stream, track.id, stream.id)
  manager.receiveStreamMeta({k: 'initial-stream', s: stream.id}, 'peer')
  manager.receiveRemoteStream('peer', stream)
  manager.receiveTrackMeta({k: 'initial-track', t: track.id}, 'peer')
  manager.receiveRemoteTrack('peer', track, stream)
  for (let i = 0; i < 1000; i++) {
    cache.rememberRemoteStream(`stream-${i}`, stream, stream.id)
    cache.rememberRemoteTrack(`track-${i}`, track, stream, track.id, stream.id)
    manager.receiveStreamMeta({k: `stream-${i}`, s: stream.id}, 'peer')
    manager.receiveTrackMeta({k: `track-${i}`, t: track.id}, 'peer')
  }
  for (let i = 0; i < 999; i++) {
    assert.equal(cache.getRemoteStream(`stream-${i}`), undefined)
    assert.equal(cache.getRemoteTrack(`track-${i}`), undefined)
  }
  assert.equal(cache.getRemoteStream('stream-999'), stream)
  assert.equal(cache.getRemoteTrack('track-999')?.track, track)
  assert.equal(cache.getRemoteStream('initial-stream', stream.id), stream)
  assert.equal(cache.getRemoteTrack('initial-track', track.id)?.track, track)
  assert.deepEqual(errors, [])
  cache.clearRemote()
  assert.equal(cache.getRemoteTrack('track-999', track.id), undefined)
})

for (const fail of [false, true]) {
  void test(`track replacement ${fail ? 'failure' : 'success'} settles the public operation`, async () => {
    const physical = new MockPeer()
    let resolve!: () => void
    let reject!: (error: Error) => void
    const replacement = new Promise<void>((yes, no) => {
      resolve = yes
      reject = no
    })
    physical.replaceTrack = () => replacement
    const oldTrack = {id: 'old'} as MediaStreamTrack
    const newTrack = {id: 'new'} as MediaStreamTrack
    const media = createMediaManager({
      iterate: (_targets, f) => [Promise.resolve(f('peer', physical as never))],
      isActive: () => true,
      onPeerError: () => {}
    })
    let settled = false
    const operation = Promise.all(
      media.replaceTrack(oldTrack, newTrack, {}, async () => {})
    )
    const result = operation.then(
      () => {
        settled = true
        return 'ok'
      },
      error => {
        settled = true
        return error.message
      }
    )
    await turn()
    assert.equal(settled, false)
    if (fail) {
      reject(new Error('native replacement failed'))
    } else {
      resolve()
    }
    assert.equal(await result, fail ? 'native replacement failed' : 'ok')
  })
}

void test(
  'Trystero: replaceTrack on a stream track resolves on direct rooms',
  {timeout: 10_000},
  async () => {
    const initialTrack = {id: 'initial-video-track'}
    const replacementTrack = {id: 'replacement-video-track'}
    const localStream = {id: 'video-stream', getTracks: () => [initialTrack]}
    let directRoomA = null
    let directRoomB = null

    try {
      let registerDirectA = null
      let registerDirectB = null
      directRoomA = createRoom(
        f => {
          registerDirectA = f
        },
        () => {},
        () => {}
      )
      directRoomB = createRoom(
        f => {
          registerDirectB = f
        },
        () => {},
        () => {}
      )
      const joinDirectA = new Promise(
        resolve => (directRoomA.onPeerJoin = resolve)
      )
      const joinDirectB = new Promise(
        resolve => (directRoomB.onPeerJoin = resolve)
      )
      const {peerA: directPeerA, peerB: directPeerB} = linkPeers(
        new LinkedMediaPeer(),
        new LinkedMediaPeer()
      )
      registerDirectA(directPeerA, 'peer-b')
      registerDirectB(directPeerB, 'peer-a')
      await Promise.all([joinDirectA, joinDirectB])

      const directStreamReceived = new Promise(resolve => {
        directRoomB.onPeerStream = (stream, {peerId}) =>
          resolve({streamId: stream.id, peerId})
      })
      await Promise.all(
        directRoomA.addStream(localStream as any, {target: 'peer-b'})
      )
      assert.deepEqual(await withTimeout(directStreamReceived), {
        streamId: 'video-stream',
        peerId: 'peer-a'
      })

      const replacedOnDirect = new Promise(resolve => {
        directRoomB.onPeerTrack = (track, stream, {peerId, metadata}) =>
          resolve({trackId: track.id, streamId: stream.id, peerId, metadata})
      })
      await Promise.all(
        directRoomA.replaceTrack(initialTrack as any, replacementTrack as any, {
          target: 'peer-b',
          metadata: {direct: true}
        })
      )
      assert.deepEqual(await withTimeout(replacedOnDirect), {
        trackId: 'initial-video-track',
        streamId: 'video-stream',
        peerId: 'peer-a',
        metadata: {direct: true}
      })
    } finally {
      await directRoomA?.leave().catch(() => {})
      await directRoomB?.leave().catch(() => {})
    }
  }
)

void test(
  'Trystero: multi-track stream emits onPeerStream once and preserves subsequent stream metadata',
  {timeout: 10_000},
  async () => {
    let roomA = null
    let roomB = null

    try {
      let registerPeerA = null
      let registerPeerB = null
      roomA = createRoom(
        f => {
          registerPeerA = f
        },
        () => {},
        () => {}
      )
      roomB = createRoom(
        f => {
          registerPeerB = f
        },
        () => {},
        () => {}
      )
      const joinA = new Promise(resolve => (roomA.onPeerJoin = resolve))
      const joinB = new Promise(resolve => (roomB.onPeerJoin = resolve))
      const {peerA, peerB} = linkPeers(
        new LinkedMediaPeer(),
        new LinkedMediaPeer()
      )
      registerPeerA(peerA, 'peer-b')
      registerPeerB(peerB, 'peer-a')
      await Promise.all([joinA, joinB])

      const receivedStreams: Array<{
        streamId: string
        peerId: string
        metadata: unknown
      }> = []
      roomB.onPeerStream = (stream, {peerId, metadata}) => {
        receivedStreams.push({streamId: stream.id, peerId, metadata})
      }

      const avStream = {
        id: 'av-stream',
        getTracks: () => [{id: 'audio-track'}, {id: 'video-track'}]
      }
      const screenStream = {
        id: 'screen-stream',
        getTracks: () => [{id: 'screen-track'}]
      }

      await Promise.all([
        ...roomA.addStream(avStream as any, {
          target: 'peer-b',
          metadata: {kind: 'camera'}
        }),
        ...roomA.addStream(screenStream as any, {
          target: 'peer-b',
          metadata: {kind: 'screen'}
        })
      ])

      assert.deepEqual(receivedStreams, [
        {streamId: 'av-stream', peerId: 'peer-a', metadata: {kind: 'camera'}},
        {
          streamId: 'screen-stream',
          peerId: 'peer-a',
          metadata: {kind: 'screen'}
        }
      ])
    } finally {
      await roomA?.leave().catch(() => {})
      await roomB?.leave().catch(() => {})
    }
  }
)
