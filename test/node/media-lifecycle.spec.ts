import assert from 'node:assert/strict'
import test from './test.ts'
import {
  createMediaIdentityCache,
  createMediaManager
} from '../../packages/core/src/media.ts'
import initPeer from '../../packages/core/src/peer.ts'
import createRoom from '../../packages/core/src/room.ts'
import {LinkedMediaPeer, MockPeer, linkPeers, turn} from './peer-harness.ts'

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
  manager.receiveStreamMeta({k: 'initial-stream', s: stream.id}, 'peer')
  manager.receiveRemoteStream('peer', stream)
  for (let i = 0; i < 1000; i++) {
    cache.rememberRemoteStream(`stream-${i}`, stream, stream.id)
    manager.receiveStreamMeta({k: `stream-${i}`, s: stream.id}, 'peer')
  }
  for (let i = 0; i < 999; i++) {
    assert.equal(cache.getRemoteStream(`stream-${i}`), undefined)
  }
  assert.equal(cache.getRemoteStream('stream-999'), stream)
  assert.equal(cache.getRemoteStream('initial-stream', stream.id), stream)
  assert.deepEqual(errors, [])
  cache.clearRemote()
  assert.equal(cache.getRemoteStream('stream-999', stream.id), undefined)
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
    const operation = media.replaceTrack(oldTrack, newTrack)
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
  'Trystero: replaceTrack on a stream track resolves on direct rooms and addStream syncs tracks and metadata',
  {timeout: 10_000},
  async () => {
    const initialTrack = {id: 'initial-video-track'}
    const replacementTrack = {id: 'replacement-video-track'}
    const extraAudioTrack = {id: 'extra-audio-track'}
    let currentTracks = [initialTrack]
    const localStream = {
      id: 'video-stream',
      getTracks: () => [...currentTracks]
    }
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

      const streamEvents: Array<{
        streamId: string
        trackIds: string[]
        peerId: string
        metadata: unknown
      }> = []
      directRoomB.onPeerStream = (stream, {peerId, metadata}) => {
        streamEvents.push({
          streamId: stream.id,
          trackIds: stream.getTracks().map(t => t.id),
          peerId,
          metadata
        })
      }

      await directRoomA.addStream(localStream as any, {
        target: 'peer-b',
        metadata: {mode: 'camera'}
      })
      assert.equal(directPeerA.addStreamCalls, 1)
      assert.deepEqual(streamEvents, [
        {
          streamId: 'video-stream',
          trackIds: ['initial-video-track'],
          peerId: 'peer-a',
          metadata: {mode: 'camera'}
        }
      ])

      // Re-calling addStream with identical tracks and metadata is a no-op on senders and does not re-fire onPeerStream
      await directRoomA.addStream(localStream as any, {
        target: 'peer-b',
        metadata: {mode: 'camera'}
      })
      assert.equal(directPeerA.addStreamCalls, 1)
      assert.equal(directPeerA.addTrackCalls, 0)
      assert.equal(directPeerA.removeTrackCalls, 0)
      assert.equal(streamEvents.length, 1)

      // replaceTrack swaps at the sender level without renegotiation
      await directRoomA.replaceTrack(
        initialTrack as any,
        replacementTrack as any,
        {target: 'peer-b'}
      )
      assert.equal(directPeerA.replaceTrackCalls, 1)

      // Re-announcing stream with updated metadata after replaceTrack keeps the replaced track (no removeTrack/addTrack churn) and fires onPeerStream again
      await directRoomA.addStream(localStream as any, {
        target: 'peer-b',
        metadata: {mode: 'screenshare'}
      })
      assert.equal(directPeerA.addTrackCalls, 0)
      assert.equal(directPeerA.removeTrackCalls, 0)
      assert.equal(streamEvents.length, 2)
      assert.deepEqual(streamEvents[1], {
        streamId: 'video-stream',
        trackIds: ['initial-video-track'],
        peerId: 'peer-a',
        metadata: {mode: 'screenshare'}
      })

      // Adding a track to the local stream and calling addStream syncs only the added track
      currentTracks = [initialTrack, extraAudioTrack]
      await directRoomA.addStream(localStream as any, {
        target: 'peer-b',
        metadata: {mode: 'screenshare'}
      })
      assert.equal(directPeerA.addTrackCalls, 1)
      assert.equal(directPeerA.removeTrackCalls, 0)
      assert.deepEqual(
        directPeerB.remoteStreams
          .get('video-stream')
          ?.stream.getTracks()
          .map(t => t.id),
        ['initial-video-track', 'extra-audio-track']
      )

      // Removing a track from the local stream and calling addStream removes that track's sender
      currentTracks = [initialTrack]
      await directRoomA.addStream(localStream as any, {
        target: 'peer-b',
        metadata: {mode: 'screenshare'}
      })
      assert.equal(directPeerA.removeTrackCalls, 1)
      assert.deepEqual(
        directPeerB.remoteStreams
          .get('video-stream')
          ?.stream.getTracks()
          .map(t => t.id),
        ['initial-video-track']
      )
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
        roomA.addStream(avStream as any, {
          target: 'peer-b',
          metadata: {kind: 'camera'}
        }),
        roomA.addStream(screenStream as any, {
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

void test('recycled transceiver sender after removeTrack is not stopped when original stream is removed', () => {
  type FakeSender = {kind: string; track: any}
  const senders: FakeSender[] = []

  class RecyclingPeerConnection {
    connectionState = 'connected'
    iceConnectionState = 'connected'
    signalingState = 'stable'
    localDescription = null
    remoteDescription = null
    addEventListener() {}
    removeEventListener() {}
    close() {}
    getSenders() {
      return senders
    }
    addTrack(track: any) {
      let sender = senders.find(s => s.kind === track.kind && s.track === null)
      if (sender) {
        sender.track = track
      } else {
        sender = {kind: track.kind, track}
        senders.push(sender)
      }
      return sender
    }
    removeTrack(sender: FakeSender) {
      sender.track = null
    }
  }

  const peer = initPeer(false, {
    appId: 'test',
    rtcPolyfill: RecyclingPeerConnection as any
  })

  const audioTrack = {id: 'mic', kind: 'audio'} as unknown as MediaStreamTrack
  const camTrack = {id: 'cam', kind: 'video'} as unknown as MediaStreamTrack
  const screenTrack = {
    id: 'screen',
    kind: 'video'
  } as unknown as MediaStreamTrack

  let streamATracks = [audioTrack, camTrack]
  const streamA = {
    id: 'stream-a',
    getTracks: () => [...streamATracks]
  } as unknown as MediaStream
  const streamB = {
    id: 'stream-b',
    getTracks: () => [screenTrack]
  } as unknown as MediaStream

  peer.addStream(streamA)
  assert.equal(senders.length, 2)

  // Drop camTrack from streamA: vacates the video transceiver sender
  streamATracks = [audioTrack]
  peer.removeTrack(camTrack, streamA)
  assert.equal(senders[1]?.track, null)

  // Adding streamB recycles the vacant video transceiver sender
  peer.addStream(streamB)
  assert.equal(senders.length, 2)
  assert.equal(senders[1]?.track, screenTrack)

  // Removing streamA must only stop audioTrack and leave streamB's recycled video sender untouched
  peer.removeStream(streamA)
  assert.equal(senders[0]?.track, null)
  assert.equal(senders[1]?.track, screenTrack)
})

void test('receiveRemoteStream and receiveStreamMeta emit when receiver transceiver track IDs differ from sender track IDs', () => {
  const remoteContexts: Array<{
    tracks?: MediaStreamTrack[]
    metadata: unknown
  }> = []
  const emitted: Array<{streamId: string; metadata: unknown}> = []
  const media = createMediaManager({
    iterate: () => [],
    isActive: () => true,
    onPeerError: () => {},
    onRemoteStream: (_stream, ctx) => {
      remoteContexts.push({tracks: ctx.tracks, metadata: ctx.metadata})
    }
  })
  media.onPeerStream = (stream, {metadata}) => {
    emitted.push({streamId: stream.id, metadata})
  }

  let receiverTracks = [
    {id: 'receiver-local-audio-uuid'} as unknown as MediaStreamTrack
  ]
  const remoteStream = {
    id: 'shared-stream-id',
    getTracks: () => [...receiverTracks]
  } as unknown as MediaStream

  media.receiveStreamMeta(
    {
      k: 'stream-key-1',
      s: 'shared-stream-id',
      t: ['sender-audio-id', 'sender-video-id'],
      m: {phase: 'first'}
    },
    'peer-a'
  )

  // First ontrack fires with only 1 of 2 tracks present on the remote stream
  media.receiveRemoteStream('peer-a', remoteStream)
  assert.equal(emitted.length, 0)

  // Second ontrack fires once both tracks are attached (with receiver-local UUIDs)
  receiverTracks = [
    {id: 'receiver-local-audio-uuid'} as unknown as MediaStreamTrack,
    {id: 'receiver-local-video-uuid'} as unknown as MediaStreamTrack
  ]
  media.receiveRemoteStream('peer-a', remoteStream)
  assert.deepEqual(emitted, [
    {streamId: 'shared-stream-id', metadata: {phase: 'first'}}
  ])
  assert.equal(remoteContexts[0]?.tracks, undefined)

  // Subsequent metadata update on the cached stream emits immediately without waiting for new tracks
  media.receiveStreamMeta(
    {
      k: 'stream-key-1',
      s: 'shared-stream-id',
      t: ['sender-audio-id', 'sender-video-id'],
      m: {phase: 'second'}
    },
    'peer-a'
  )
  assert.deepEqual(emitted, [
    {streamId: 'shared-stream-id', metadata: {phase: 'first'}},
    {streamId: 'shared-stream-id', metadata: {phase: 'second'}}
  ])
})
