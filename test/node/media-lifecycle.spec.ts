import assert from 'node:assert/strict'
import test from './test.ts'
import {
  createMediaIdentityCache,
  createMediaManager
  // @ts-expect-error Internal source import crosses a referenced package boundary.
} from '../../packages/core/src/media.ts'
// @ts-expect-error Internal source import crosses a referenced package boundary.
import {SharedPeerManager} from '../../packages/core/src/shared-peer.ts'
import {MockPeer, turn} from './peer-harness.ts'

void test('media metadata keeps one current alias per native object and preserves native ID lookup', () => {
  const cache = createMediaIdentityCache()
  const track = {id: 'track', readyState: 'live'} as MediaStreamTrack
  const stream = {id: 'stream', getTracks: () => [track]} as MediaStream
  const errors: Error[] = []
  const manager = createMediaManager({
    iterate: () => [],
    isActive: () => true,
    getSharedMediaPeer: () => ({__trysteroMedia: cache}) as never,
    onPeerError: (_id, error) => errors.push(error)
  })
  cache.rememberRemoteStream('initial-stream', stream, stream.id)
  cache.rememberRemoteTrack('initial-track', track, stream, track.id, stream.id)
  for (let i = 0; i < 1000; i++) {
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
  void test(`track replacement ${fail ? 'failure preserves' : 'success transfers'} ownership and settles the public operation`, async t => {
    const physical = new MockPeer()
    let resolve!: () => void
    let reject!: (error: Error) => void
    const replacement = new Promise<void>((yes, no) => {
      resolve = yes
      reject = no
    })
    physical.replaceTrack = () => replacement
    const removed: MediaStreamTrack[] = []
    physical.removeTrack = (track?: MediaStreamTrack) => {
      removed.push(track)
    }
    const shared = new SharedPeerManager()
    let proxy
    const membership = shared.registerRoom(
      'media',
      'room',
      Promise.resolve('token'),
      {
        active: true,
        onPeer: peer => {
          proxy = peer
        },
        onDetach: () => {}
      }
    )
    membership.connect('peer', physical as never, 0)
    t.after(() => {
      membership.leave()
      shared.clear('media', 'peer', {destroyPeer: true})
    })
    const oldTrack = {id: 'old'} as MediaStreamTrack
    const newTrack = {id: 'new'} as MediaStreamTrack
    const stream = {id: 'stream', getTracks: () => [oldTrack]} as MediaStream
    proxy.addTrack(oldTrack, stream)
    const media = createMediaManager({
      iterate: (_targets, f) => [Promise.resolve(f('peer', proxy))],
      isActive: () => true,
      getSharedMediaPeer: () => proxy,
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
    proxy.removeTrack(fail ? oldTrack : newTrack)
    assert.deepEqual(removed, [fail ? oldTrack : newTrack])
  })
}

void test('pending track replacement preserves only the remaining room ownership after detach', async t => {
  const physical = new MockPeer()
  let resolve!: () => void
  physical.replaceTrack = () =>
    new Promise<void>(yes => {
      resolve = yes
    })
  const removed: MediaStreamTrack[] = []
  physical.removeTrack = (track?: MediaStreamTrack) => {
    removed.push(track)
  }
  const shared = new SharedPeerManager()
  const proxies = []
  const rooms = ['first', 'remaining'].map(roomId =>
    shared.registerRoom('media-detach', roomId, Promise.resolve(roomId), {
      active: true,
      onPeer: peer => {
        proxies.push(peer)
      },
      onDetach: () => {}
    })
  )
  t.after(() => {
    rooms.forEach(room => room.leave())
    shared.clear('media-detach', 'peer', {destroyPeer: true})
  })
  rooms[0].connect('peer', physical as never, 0)
  assert.equal(rooms[1].reuse('peer'), true)
  const oldTrack = {id: 'old'} as MediaStreamTrack
  const newTrack = {id: 'new'} as MediaStreamTrack
  const stream = {id: 'stream', getTracks: () => [oldTrack]} as MediaStream
  proxies.forEach(peer => peer.addTrack(oldTrack, stream))
  const replacing = proxies[0].replaceTrack(oldTrack, newTrack)
  rooms[0].leave()
  resolve()
  await replacing
  assert.equal(physical.isDead, false)
  assert.deepEqual(removed, [])
  proxies[1].removeTrack(newTrack)
  assert.deepEqual(removed, [newTrack])
})
