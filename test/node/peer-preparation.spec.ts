import assert from 'node:assert/strict'
import initPeer from '../../packages/core/src/peer.ts'
import {MockRTCPeerConnection} from './peer-harness.ts'
import test from './test.ts'

void test('an initiator preparation error closes the polyfill and propagates before offering', () => {
  const failure = new Error('cannot configure offer')
  let connection: RTCPeerConnection | undefined

  assert.throws(
    () =>
      initPeer(true, {
        appId: 'peer-preparation-test',
        rtcPolyfill: MockRTCPeerConnection as never,
        preparePeerConnection: (pc, role) => {
          assert.ok(pc instanceof MockRTCPeerConnection)
          assert.equal(role, 'initiator')
          connection = pc
          throw failure
        }
      }),
    error => error === failure
  )
  assert.equal(connection?.connectionState, 'closed')
  assert.equal(connection?.localDescription, null)
})

void test('a responder preparation error reports the failure and closes without answering', async t => {
  const failure = new Error('cannot configure answer')
  const peer = initPeer(false, {
    appId: 'peer-preparation-test',
    rtcPolyfill: MockRTCPeerConnection as never,
    preparePeerConnection: (pc, role) => {
      assert.equal(pc, peer.connection)
      assert.equal(role, 'responder')
      assert.equal(pc.remoteDescription?.type, 'offer')
      assert.equal(pc.localDescription, null)
      throw failure
    }
  })
  t.after(() => peer.destroy())
  const errors: Error[] = []
  const signals: string[] = []
  let closeCount = 0
  peer.setHandlers({
    error: error => errors.push(error),
    signal: signal => signals.push(signal.type),
    close: () => {
      closeCount++
    }
  })

  assert.equal(await peer.signal({type: 'offer', sdp: 'mock-offer'}), undefined)
  assert.deepEqual(errors, [failure])
  assert.equal(errors[0], failure)
  assert.deepEqual(signals, [])
  assert.equal(closeCount, 1)
  assert.equal(peer.connection.connectionState, 'closed')
  assert.equal(peer.connection.localDescription, null)
  assert.equal(peer.isDead, true)
})
