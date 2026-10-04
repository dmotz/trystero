import assert from 'node:assert/strict'
import test from './test.ts'
// @ts-expect-error Internal source import crosses a referenced package boundary.
import {SharedPeerManager} from '../../packages/core/src/shared-peer.ts'
// @ts-expect-error Internal source import crosses a referenced package boundary.
import createRoom from '../../packages/core/src/room.ts'
// @ts-expect-error Internal source import crosses a referenced package boundary.
import createPeer from '../../packages/core/src/peer.ts'
import {
  MockPeer,
  MockRTCPeerConnection,
  encodeInternalAction,
  presenceFrame,
  roomFrame,
  turn
} from './peer-harness.ts'

void test('unresolved room-token buffering is bounded across tokens', t => {
  t.mock.method(console, 'warn', () => {})
  const manager = new SharedPeerManager()
  const peer = new MockPeer()
  const shared = manager.register('app', 'peer', peer as never, 60_000)
  t.after(() => manager.clear('app', 'peer', {destroyPeer: true}))
  manager.bind('joining', new Promise(() => {}), shared, {onDetach: () => {}})
  for (let id = 0; id < 64; id++) {
    peer.handlers.data(roomFrame(`unknown-${id}`))
  }
  assert.equal(shared.pendingDataByToken.size, 64)
  peer.handlers.data(roomFrame('one-too-many'))
  assert.equal(peer.isDead, false)
  assert.equal(shared.pendingDataByToken.size, 64)
})

void test('unclaimed room data expires instead of persisting for the connection lifetime', t => {
  t.mock.timers.enable({apis: ['setTimeout']})
  t.mock.method(console, 'warn', () => {})
  const manager = new SharedPeerManager()
  const peer = new MockPeer()
  const shared = manager.register('app', 'peer', peer as never, 60_000)
  t.after(() => manager.clear('app', 'peer', {destroyPeer: true}))
  manager.bind('joining', new Promise(() => {}), shared, {onDetach: () => {}})
  peer.handlers.data(roomFrame('unclaimed'))
  t.mock.timers.tick(10_000)
  assert.equal(peer.isDead, false)
  assert.equal(shared.pendingDataByToken.size, 0)
})

void test('registered rooms without handlers share the same physical-peer queue limit', async t => {
  t.mock.method(console, 'warn', () => {})
  const manager = new SharedPeerManager()
  const peer = new MockPeer()
  const shared = manager.register('app', 'peer', peer as never, 60_000)
  manager.bind('one', Promise.resolve('one'), shared, {onDetach: () => {}})
  manager.bind('two', Promise.resolve('two'), shared, {onDetach: () => {}})
  await turn()
  for (let i = 0; i < 65; i++) {
    peer.handlers.data(roomFrame(i % 2 ? 'one' : 'two'))
  }
  assert.equal(peer.isDead, true)
  assert.deepEqual(Object.keys(shared.bindings), [])
})

void test('room presence tokens cannot grow without bound', t => {
  t.mock.method(console, 'warn', () => {})
  const manager = new SharedPeerManager()
  const peer = new MockPeer()
  const shared = manager.register('app', 'peer', peer as never, 60_000)
  for (let i = 0; i < 65; i++) {
    peer.handlers.data(presenceFrame(`room-${i}`))
  }
  assert.equal(peer.isDead, true)
  assert.equal(shared.remoteRoomTokens.size, 0)
})

void test('local leave completes without receipts from a connected peer', async t => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date']})
  let acceptPeer
  let left = false
  const room = createRoom(
    callback => {
      acceptPeer = callback
    },
    () => {},
    () => {
      left = true
    }
  )
  const peer = new MockPeer()
  acceptPeer(peer, 'peer')
  peer.handlers.data(encodeInternalAction('@_hsready'))
  await turn()
  const leaving = room.leave()
  t.mock.timers.tick(100)
  await leaving
  assert.equal(left, true)
  assert.equal(peer.isDead, true)
})

void test('local leave also cancels a blocked data-channel send', async t => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date']})
  let acceptPeer
  let left = false
  const room = createRoom(
    callback => {
      acceptPeer = callback
    },
    () => {},
    () => {
      left = true
    }
  )
  const peer = new MockPeer()
  const events = new Map<string, Set<() => void>>()
  const destroy = peer.destroy.bind(peer)
  peer.destroy = () => {
    peer.channel.readyState = 'closed'
    events.get('close')?.forEach(listener => listener())
    destroy()
  }
  peer.channel.bufferedAmount = 100_000
  Object.assign(peer.channel, {
    addEventListener: (event, fn) => {
      const listeners = events.get(event) ?? new Set()
      listeners.add(fn)
      events.set(event, listeners)
    },
    removeEventListener: (event, fn) => events.get(event)?.delete(fn)
  })
  acceptPeer(peer, 'peer')
  await turn()
  const leaving = room.leave()
  t.mock.timers.tick(100)
  await leaving
  await turn()
  assert.equal(left, true)
  assert.equal(peer.isDead, true)
  assert.ok([...events.values()].every(listeners => listeners.size === 0))
})

void test('physical data received before handler registration is bounded and expires', t => {
  t.mock.timers.enable({apis: ['setTimeout']})
  t.mock.method(console, 'warn', () => {})
  for (const overCount of [true, false]) {
    const peer = createPeer(true, {
      appId: 'test',
      rtcPolyfill: MockRTCPeerConnection as never
    })
    const channel = peer.channel!
    for (let i = 0; i < (overCount ? 65 : 1); i++) {
      channel.onmessage!({data: roomFrame('room')} as MessageEvent)
    }
    if (!overCount) {
      t.mock.timers.tick(10_000)
    }
    assert.equal(peer.isDead, true)
  }
})

void test('intentional SCTP aborts close the peer without reporting a transport error', () => {
  const errors: Error[] = []
  let closes = 0
  const peer = createPeer(true, {
    appId: 'test',
    rtcPolyfill: MockRTCPeerConnection as never
  })
  peer.setHandlers({
    error: error => errors.push(error),
    close: () => closes++
  })
  const channel = peer.channel!
  for (const causeCode of [12, null]) {
    const error = Object.assign(
      new Error('User-Initiated Abort, reason=Close called'),
      {errorDetail: 'sctp-failure', sctpCauseCode: causeCode}
    )
    channel.onerror!({error} as RTCErrorEvent)
  }
  assert.deepEqual(errors, [])
  channel.onclose!({} as Event)
  channel.onerror!({error: new Error('late channel error')} as RTCErrorEvent)
  assert.equal(closes, 1)
  assert.deepEqual(errors, [])

  const failed = createPeer(true, {
    appId: 'test',
    rtcPolyfill: MockRTCPeerConnection as never
  })
  failed.setHandlers({error: error => errors.push(error)})
  const failure = Object.assign(new Error('association failed'), {
    errorDetail: 'sctp-failure',
    sctpCauseCode: 13
  })
  failed.channel!.onerror!({error: failure} as RTCErrorEvent)
  assert.deepEqual(errors, [failure])
  peer.destroy()
  failed.destroy()
})

void test('bound room data still closes the peer when its handler deadline expires', async t => {
  t.mock.timers.enable({apis: ['setTimeout']})
  t.mock.method(console, 'warn', () => {})
  const manager = new SharedPeerManager()
  const peer = new MockPeer()
  const shared = manager.register('app', 'peer', peer as never, 60_000)
  t.after(() => manager.clear('app', 'peer', {destroyPeer: true}))
  manager.bind('room', Promise.resolve('room'), shared, {onDetach: () => {}})
  await Promise.resolve()
  peer.handlers.data(roomFrame('room'))
  t.mock.timers.tick(10_000)
  assert.equal(peer.isDead, true)
  assert.equal(manager.get('app', 'peer'), undefined)
})

void test('expiring earlier unclaimed token data does not shorten a bound room handler deadline', async t => {
  t.mock.timers.enable({apis: ['setTimeout']})
  t.mock.method(console, 'warn', () => {})
  const manager = new SharedPeerManager()
  const peer = new MockPeer()
  const shared = manager.register('app', 'peer', peer as never, 60_000)
  t.after(() => manager.clear('app', 'peer', {destroyPeer: true}))
  manager.bind('joining', new Promise(() => {}), shared, {onDetach: () => {}})
  peer.handlers.data(roomFrame('unclaimed', [1]))
  t.mock.timers.tick(8_000)

  const {proxy} = manager.bind('room', Promise.resolve('room'), shared, {
    onDetach: () => {}
  })
  await Promise.resolve()
  peer.handlers.data(roomFrame('room', [42]))

  // At t = 11s, the unclaimed token expires without killing the peer,
  // while the bound room still has 7s left to attach its handler.
  t.mock.timers.tick(3_000)
  assert.equal(shared.pendingDataByToken.size, 0)
  assert.equal(peer.isDead, false)

  const received: number[][] = []
  proxy.setHandlers({
    data: data => received.push([...new Uint8Array(data)])
  })
  assert.deepEqual(received, [[42]])
  t.mock.timers.tick(10_000)
  assert.equal(peer.isDead, false)
})
