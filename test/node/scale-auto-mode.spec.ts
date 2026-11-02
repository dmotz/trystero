import assert from 'node:assert/strict'
import test from './test.ts'
import {
  normalizeTopologyConfig,
  scale
} from '../../packages/core/src/scale/index.ts'
import createRoom from '../../packages/core/src/room.ts'
import createTopicStrategy from '../../packages/core/src/topic-strategy.ts'
import {definePlugin} from '../../packages/core/src/utils.ts'
import {createOverlayCluster} from './overlay-harness.ts'
import {joinAsTestPeer, MockRTCPeerConnection} from './peer-harness.ts'

void test('Elegant API & automatic configuration: joinRoom with scale "auto" transitions from mesh to gossip at threshold', async () => {
  const peerCount = 24
  const autoThreshold = 8
  const maxConnections = 6

  // Verify normalizeTopologyConfig supports both string shorthand and full config object
  assert.equal(normalizeTopologyConfig().mode, 'auto')
  assert.equal(normalizeTopologyConfig('gossip').mode, 'gossip')
  assert.equal(normalizeTopologyConfig('auto').mode, 'auto')
  assert.throws(
    () => normalizeTopologyConfig('mesh' as any),
    /invalid topology mode/
  )
  assert.throws(
    () => normalizeTopologyConfig('broadcast' as any),
    /invalid topology mode/
  )

  // Start with 6 peers (<= autoThreshold of 8): should remain in 'mesh' mode
  const smallCluster = await createOverlayCluster({
    peerCount: 6,
    topology: {mode: 'auto', autoThreshold, maxConnections}
  })

  try {
    for (const id of smallCluster.peerIds) {
      const snap = smallCluster.rooms.get(id)!.getTopology()
      assert.equal(snap.mode, 'auto')
      assert.equal(
        snap.activeMode,
        'mesh',
        'room below autoThreshold should stay in full mesh mode'
      )
      assert.equal(snap.directPeerIds.length, 5)
    }
  } finally {
    await smallCluster.cleanup()
  }

  // Now scale to 24 peers (> autoThreshold of 8): should automatically switch to 'gossip'
  const largeCluster = await createOverlayCluster({
    peerCount,
    topology: {mode: 'auto', autoThreshold, maxConnections}
  })

  try {
    for (const id of largeCluster.peerIds) {
      const snap = largeCluster.rooms.get(id)!.getTopology()
      assert.equal(snap.mode, 'auto')
      assert.equal(
        snap.activeMode,
        'gossip',
        'room above autoThreshold should automatically switch to gossip'
      )
      assert.ok(snap.directPeerIds.length <= maxConnections)
      assert.equal(snap.roomPeerIds.length, peerCount - 1)
    }
  } finally {
    await largeCluster.cleanup()
  }
})

void test('End-to-end createTopicStrategy integration with scale()', async () => {
  const topicSubs = new Map<string, Set<(topic: string, msg: string) => void>>()

  const makeJoinRoom = (peerId: string) =>
    joinAsTestPeer(
      peerId,
      createTopicStrategy({
        init: () => ({}),
        subscribeTopic: (_relay, topic, onMessage) => {
          let set = topicSubs.get(topic)
          if (!set) {
            set = new Set()
            topicSubs.set(topic, set)
          }
          const handler = (t: string, m: string) => {
            void onMessage(t, m)
          }
          set.add(handler)
          return () => {
            set?.delete(handler)
          }
        },
        publishTopic: (_relay, topic, msg) => {
          const handlers = topicSubs.get(topic)
          if (handlers) {
            const text = typeof msg === 'string' ? msg : JSON.stringify(msg)
            for (const h of handlers) {
              queueMicrotask(() => h(topic, text))
            }
          }
        }
      })
    )

  const roomA = makeJoinRoom('peer-alpha')(
    {
      appId: 'topic-e2e-overlay',
      use: [scale('gossip')],
      rtcPolyfill: MockRTCPeerConnection as any
    },
    'lobby'
  )
  const roomB = makeJoinRoom('peer-beta')(
    {
      appId: 'topic-e2e-overlay',
      use: [scale({mode: 'gossip', maxConnections: 6})],
      rtcPolyfill: MockRTCPeerConnection as any
    },
    'lobby'
  )

  try {
    await Promise.all([roomA.ready, roomB.ready])
    assert.equal(roomA.getTopology().selfId, (await roomA.getSelf()).peerId)
    assert.equal(roomA.getTopology().mode, 'gossip')
    assert.equal(roomB.getTopology().selfId, (await roomB.getSelf()).peerId)
    assert.equal(roomB.getTopology().activeMode, 'gossip')
  } finally {
    await Promise.all([roomA.leave(), roomB.leave()])
  }
})

void test('Third-party plugin injection via definePlugin (spread and plugins array)', async () => {
  const events: string[] = []
  const telemetryPlugin = (prefix: string) =>
    definePlugin('telemetry', {
      setup: kernel => {
        const internal = kernel.makeInternalAction<string>('telem')
        internal.onMessage(() => {})
        events.push(`${prefix}:setup:${kernel.selfId}:${kernel.getRoomId()}`)
        kernel.onLeave(() => {
          events.push(`${prefix}:destroy:${kernel.selfId}`)
        })
        return {
          getEvents: () => [...events]
        }
      }
    })

  const room = createRoom(
    () => {},
    () => {},
    () => {},
    {
      selfId: 'custom-peer',
      appId: 'plugin-app',
      roomId: 'plugin-room',
      use: [telemetryPlugin('mod1')]
    }
  )

  assert.deepEqual((room as any).getEvents(), [
    'mod1:setup:custom-peer:plugin-room'
  ])
  await room.leave()
  assert.deepEqual(events, [
    'mod1:setup:custom-peer:plugin-room',
    'mod1:destroy:custom-peer'
  ])

  const room2 = createRoom(
    () => {},
    () => {},
    () => {},
    {
      selfId: 'custom-peer-2',
      appId: 'plugin-app',
      roomId: 'plugin-room-2',
      use: [telemetryPlugin('mod2')]
    }
  )
  assert.deepEqual((room2 as any).getEvents(), [
    'mod1:setup:custom-peer:plugin-room',
    'mod1:destroy:custom-peer',
    'mod2:setup:custom-peer-2:plugin-room-2'
  ])
  await room2.leave()
})
