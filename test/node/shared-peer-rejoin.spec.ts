import assert from 'node:assert/strict'
import type {JoinRoomCallbacks} from '@trystero-p2p/core'
import test from './test.ts'
// @ts-expect-error Internal source import crosses a referenced package boundary.
import createStrategy from '../../packages/core/src/strategy.ts'
// @ts-expect-error Internal source import crosses a referenced package boundary.
import {encrypt, genKey} from '../../packages/core/src/crypto.ts'
import {
  LinkedPeer,
  linkPeers,
  MockRTCPeerConnection,
  waitFor
} from './peer-harness.ts'

// Match ordered, asynchronous data-channel delivery, including frames sent
// before the other strategy finishes registering its shared peer.
class BufferedPeer extends LinkedPeer {
  inbox: ArrayBuffer[] = []

  async signal() {
    this.handlers.connect?.()
  }

  sendData(data: Uint8Array) {
    const payload = data.slice().buffer
    const partner = this.partner as BufferedPeer

    queueMicrotask(() => {
      partner.inbox.push(payload)
      partner.flush()
    })
  }

  setHandlers(handlers) {
    super.setHandlers(handlers)
    this.flush()
  }

  flush() {
    if (this.handlers.data) {
      this.inbox.splice(0).forEach(data => this.handlers.data(data))
    }
  }
}

const createSide = () => {
  const subscribers = []
  const joinRoom = createStrategy({
    init: () => ({}),
    subscribe: (_relay, rootTopic, _selfTopic, onMessage) => {
      subscribers.push({rootTopic, onMessage})
      return () => {}
    },
    announce: () => {}
  })

  return {joinRoom, subscribers}
}

for (const customHandshake of [false, true]) {
  void test(
    `Trystero: issue 203 rejoins after late room signals with custom handshake ${customHandshake}`,
    {timeout: 10_000},
    async () => {
      const a = createSide()
      const b = createSide()
      const {peerA, peerB} = linkPeers(new BufferedPeer(), new BufferedPeer())
      const config = {
        appId: `rejoin-race-${customHandshake}`,
        rtcPolyfill: MockRTCPeerConnection as any,
        _test_only_sharedPeerIdleMs: 1
      }
      const errors = []
      const callbacks: JoinRoomCallbacks = {
        handshakeTimeoutMs: 1_000,
        onJoinError: error => errors.push(error.error),
        ...(customHandshake
          ? {
              onPeerHandshake: async (_id, send, receive) => {
                await send('proof')
                assert.equal((await receive()).data, 'proof')
              }
            }
          : {})
      }
      const lobbyA = a.joinRoom(config, 'lobby', callbacks)
      const lobbyB = b.joinRoom(config, 'lobby', callbacks)
      let roomA = null
      let roomB = null
      let joinsA = 0
      let handshakesA = 0
      let onLeaveA = () => {}

      try {
        await waitFor(
          () => a.subscribers.length > 0 && b.subscribers.length > 0
        )
        const answer = await encrypt(
          genKey('', config.appId, 'lobby'),
          'answer-sdp'
        )

        for (const [side, peer, peerId] of [
          [a, peerA, 'peer-b'],
          [b, peerB, 'peer-a']
        ] as const) {
          const sub = side.subscribers[0]
          await sub.onMessage(sub.rootTopic, {peerId, answer, peer}, () => {})
        }

        await waitFor(
          () =>
            Object.keys(lobbyA.getPeers()).length === 1 &&
            Object.keys(lobbyB.getPeers()).length === 1
        )

        roomA = a.joinRoom(config, 'room', {
          ...callbacks,
          onPeerHandshake: async (id, send, receive, isInitiator) => {
            handshakesA++
            await callbacks.onPeerHandshake?.(id, send, receive, isInitiator)
          }
        })
        roomA.onPeerJoin = () => joinsA++
        roomA.onPeerLeave = () => onLeaveA()
        roomB = b.joinRoom(config, 'room', callbacks)
        await waitFor(
          () => joinsA === 1 && Object.keys(roomB.getPeers()).length === 1
        )

        for (const kind of ['announcement', 'offer', 'answer', 'candidate']) {
          const previousJoins = joinsA
          const previousHandshakes = handshakesA
          const remoteLeft = new Promise<void>(resolve => {
            onLeaveA = resolve
          })
          const leaving = roomB.leave()
          await remoteLeft

          // Force a speculative binding while B's old room still exists and
          // ignores new handshake packets during its 99 ms leave drain.
          const sub = a.subscribers[1]
          await sub.onMessage(
            sub.rootTopic,
            {
              peerId: 'peer-b',
              ...(kind === 'announcement' ? {} : {[kind]: 'late-signal'})
            },
            () => {}
          )
          await waitFor(() => handshakesA === previousHandshakes + 1)
          await leaving
          assert.equal(joinsA, previousJoins)

          roomB = b.joinRoom(config, 'room', callbacks)
          let joinsB = 0
          roomB.onPeerJoin = () => joinsB++
          await waitFor(() => joinsB === 1 || errors.length > 0)

          assert.deepEqual(errors, [], `late ${kind} must not stall the rejoin`)
          assert.equal(joinsB, 1)
          assert.equal(joinsA, previousJoins + 1)
          assert.equal(handshakesA, previousHandshakes + 2)
          assert.equal(lobbyA.getPeers()['peer-b'], peerA.connection)
          assert.equal(lobbyB.getPeers()['peer-a'], peerB.connection)
          assert.equal(peerA.isDead, false)
          assert.equal(peerB.isDead, false)
        }
      } finally {
        await roomB?.leave()
        await roomA?.leave()
        await lobbyB.leave()
        await lobbyA.leave()
      }
    }
  )
}
