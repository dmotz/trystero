import assert from 'node:assert/strict'
import test from './test.ts'
import {createOverlayCluster} from './overlay-harness.ts'
import {wait, waitFor} from './peer-harness.ts'

void test('Media streaming over scale overlay: direct neighbor delivery, multi-hop direct promotion, track replacement, and stream removal', async () => {
  const peerCount = 24
  const maxDirectPeers = 6
  const cluster = await createOverlayCluster({
    peerCount,
    topology: {maxDirectPeers},
    media: true
  })

  try {
    const broadcasterId = cluster.peerIds[0]!
    const broadcasterRoom = cluster.rooms.get(broadcasterId)!
    const directNeighbors = new Set(broadcasterRoom.getTopology().directPeerIds)
    assert.ok(directNeighbors.size >= 4)

    const streamDeliveries = new Map<
      string,
      {streamId: string; from: string; meta: any}
    >()

    for (const id of cluster.peerIds) {
      const room = cluster.rooms.get(id)!
      room.onPeerStream((stream, {peerId, metadata}) => {
        streamDeliveries.set(id, {
          streamId: stream.id,
          from: peerId,
          meta: metadata
        })
      })
    }

    cluster.resetStats()
    const videoTrack1 = {id: 'video-track-1080p'} as unknown as MediaStreamTrack
    const liveStream = {
      id: 'main-broadcast-stream',
      getTracks: () => [videoTrack1]
    } as unknown as MediaStream

    await broadcasterRoom.addStream(liveStream, {
      target: [...directNeighbors],
      metadata: {title: 'Keynote Live', fps: 60}
    })

    await waitFor(() => streamDeliveries.size === directNeighbors.size, 3_000)

    for (const neighborId of directNeighbors) {
      const delivery = streamDeliveries.get(neighborId)
      assert.ok(
        delivery,
        `direct neighbor ${neighborId} did not receive stream`
      )
      assert.equal(delivery.from, broadcasterId)
      assert.equal(delivery.streamId, 'main-broadcast-stream')
      assert.deepEqual(delivery.meta, {title: 'Keynote Live', fps: 60})
    }

    // Targeted media to a multi-hop peer promotes it to a direct WebRTC connection
    const multiHopTarget = cluster.peerIds.find(
      id => id !== broadcasterId && !directNeighbors.has(id)
    )!
    assert.ok(multiHopTarget)
    assert.equal(broadcasterRoom.getPeers()[multiHopTarget]?.direct, false)

    await broadcasterRoom.addStream(liveStream, {
      target: multiHopTarget,
      metadata: {title: 'Promoted Direct Stream', fps: 60}
    })

    await waitFor(() => streamDeliveries.has(multiHopTarget), 3_000)
    assert.equal(broadcasterRoom.getPeers()[multiHopTarget]?.direct, true)
    assert.deepEqual(streamDeliveries.get(multiHopTarget)?.meta, {
      title: 'Promoted Direct Stream',
      fps: 60
    })

    const allMediaPeers = [...directNeighbors, multiHopTarget]

    // Test replaceTrack and metadata update across connected media peers
    const videoTrack2 = {
      id: 'video-track-4k-screenshare'
    } as unknown as MediaStreamTrack
    await broadcasterRoom.replaceTrack(videoTrack1, videoTrack2, {
      target: allMediaPeers
    })
    await broadcasterRoom.addStream(liveStream, {
      target: allMediaPeers,
      metadata: {mode: 'screenshare'}
    })

    await waitFor(() =>
      allMediaPeers.every(
        id => streamDeliveries.get(id)?.meta?.mode === 'screenshare'
      )
    )

    let totalReplaceTrackCalls = 0
    for (const pair of cluster.directLinks.values()) {
      totalReplaceTrackCalls +=
        (pair.peerA as any).replaceTrackCalls +
        (pair.peerB as any).replaceTrackCalls
    }
    assert.equal(totalReplaceTrackCalls, allMediaPeers.length)

    // Test removeStream across connected media peers
    broadcasterRoom.removeStream(liveStream, {target: allMediaPeers})
    await waitFor(() => {
      let count = 0
      for (const pair of cluster.directLinks.values()) {
        count +=
          (pair.peerA as any).removeStreamCalls +
          (pair.peerB as any).removeStreamCalls
      }
      return count === allMediaPeers.length
    }, 3_000)
  } finally {
    await cluster.cleanup()
  }
})

void test('Targeted media stays private for direct and multi-hop recipients', async () => {
  const cluster = await createOverlayCluster({
    peerCount: 8,
    topology: {maxDirectPeers: 4},
    media: true
  })
  try {
    const source = cluster.rooms.get(cluster.peerIds[0]!)!
    const peerEntries = Object.entries(source.getPeers())
    const direct = peerEntries.find(([, info]) => info.direct)![0]
    const remote = peerEntries.find(([, info]) => !info.direct)![0]
    assert.equal(source.getPeers()[direct]!.direct, true)
    assert.equal(source.getPeers()[remote]!.direct, false)
    const streams: string[] = []
    for (const [id, room] of cluster.rooms) {
      room.onPeerStream(() => streams.push(id))
    }
    for (const target of [direct, remote]) {
      streams.length = 0
      const camera = {id: `camera-${target}`} as unknown as MediaStreamTrack
      const stream = {
        id: `private-${target}`,
        getTracks: () => [camera]
      } as unknown as MediaStream
      await source.addStream(stream, {target})
      await wait(100)
      assert.deepEqual(
        streams,
        [target],
        'only the requested peer receives a stream'
      )
      assert.equal(source.getPeers()[target]!.direct, true)
    }
  } finally {
    await cluster.cleanup()
  }
})

void test('Removing a broadcast stream prevents replay after topology healing', async () => {
  const cluster = await createOverlayCluster({
    peerCount: 8,
    topology: {maxDirectPeers: 4},
    media: true
  })
  try {
    const source = cluster.rooms.get(cluster.peerIds[0]!)!
    const track = {id: 'removed-camera'} as unknown as MediaStreamTrack
    const stream = {
      id: 'removed-stream',
      getTracks: () => [track]
    } as unknown as MediaStream
    await source.addStream(stream)
    await wait(100)
    assert.ok(cluster.addedTracks.length >= 4)
    source.removeStream(stream)
    await wait(100)
    cluster.addedTracks.length = 0
    const dropId = source.getTopology().directPeerIds[0]!
    cluster.dropPeer(dropId)
    await cluster.healCluster()
    await wait(100)
    assert.deepEqual(
      cluster.addedTracks,
      [],
      'removed streams must never be sent again'
    )
  } finally {
    await cluster.cleanup()
  }
})

void test('Removing and replacing tracks updates streams before promoting additional peers', async () => {
  for (const replace of [false, true]) {
    const cluster = await createOverlayCluster({
      peerCount: 8,
      topology: {maxDirectPeers: 4},
      media: true
    })
    try {
      const source = cluster.rooms.get(cluster.peerIds[0]!)!
      const directPeerId = source.getTopology().directPeerIds[0]!
      const remotePeerId = Object.entries(source.getPeers()).find(
        ([, info]) => !info.direct
      )![0]
      const camera = {id: 'camera'} as unknown as MediaStreamTrack
      const audio = {id: 'audio'} as unknown as MediaStreamTrack
      let currentTracks = [camera, audio]
      const stream = {
        id: 'two-track-stream',
        getTracks: () => [...currentTracks]
      } as unknown as MediaStream
      await source.addStream(stream, {target: directPeerId})
      await wait(50)
      if (replace) {
        const replacementCamera = {
          id: 'replacement-camera'
        } as unknown as MediaStreamTrack
        await source.replaceTrack(camera, replacementCamera, {
          target: directPeerId
        })
        await wait(50)
      }
      currentTracks = [audio]
      await source.addStream(stream, {target: directPeerId})
      await wait(50)
      cluster.addedTracks.length = 0
      await source.addStream(stream, {target: remotePeerId})
      await wait(50)
      assert.ok(
        cluster.addedTracks.length > 0,
        'remaining audio must be sent to promoted peer'
      )
      assert.ok(
        cluster.addedTracks.every(id => id === 'audio'),
        `removed camera must not be sent (replace=${replace}): ${cluster.addedTracks.join(',')}`
      )
      source.removeStream(stream)
      await wait(50)
      cluster.addedTracks.length = 0
      const dropId2 = source.getTopology().directPeerIds[0]!
      cluster.dropPeer(dropId2)
      await cluster.healCluster()
      await wait(50)
      assert.deepEqual(
        cluster.addedTracks,
        [],
        'removed stream must not be replayed'
      )
    } finally {
      await cluster.cleanup()
    }
  }
})
