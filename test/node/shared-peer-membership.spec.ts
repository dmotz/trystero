import assert from 'node:assert/strict'
import test from './test.ts'
// @ts-expect-error Internal source import crosses a referenced package boundary.
import {SharedPeerManager} from '../../packages/core/src/shared-peer.ts'
import {
  MockPeer,
  LinkedPeer,
  linkPeers,
  encodeInternalAction,
  tick
} from './peer-harness.ts'

const encoder = new TextEncoder()
const presence = (token: string, present = true) => {
  const bytes = encoder.encode(token)
  return Uint8Array.of(2, Number(present), 0, bytes.length, ...bytes).buffer
}
const roomData = (token: string, payload: number[]) => {
  const bytes = encoder.encode(token)
  return Uint8Array.of(1, 0, bytes.length, ...bytes, ...payload).buffer
}
const deferred = () => {
  let resolve: (token: string) => void
  const promise = new Promise<string>(res => {
    resolve = res
  })
  return {promise, resolve: (token: string) => resolve(token)}
}
const setup = t => {
  const manager = new SharedPeerManager()
  const peer = new MockPeer()
  const sent: ArrayBuffer[] = []
  peer.sendData = (data?: Uint8Array) => {
    if (data) {
      sent.push(data.slice().buffer)
    }
  }
  t.after(() => manager.clear('app', 'remote', {destroyPeer: true}))
  const lobby = manager.registerRoom('app', 'lobby', Promise.resolve('lobby'), {
    active: false,
    onPeer: () => {},
    onDetach: () => {}
  })
  lobby.connect('remote', peer as any, 60_000)
  return {manager, peer, sent}
}

void test('Trystero: membership matches early presence after token resolution and delivers buffered data', async t => {
  const {manager, peer, sent} = setup(t)
  const token = deferred()
  const received: number[][] = []
  let joins = 0
  let closes = 0
  const membership = manager.registerRoom('app', 'files', token.promise, {
    active: true,
    onPeer: (proxy, id, physical) => {
      joins++
      assert.equal(id, 'remote')
      assert.equal(physical, peer)
      proxy.setHandlers({
        data: data => {
          received.push([...new Uint8Array(data)])
        },
        close: () => {
          closes++
        }
      })
    },
    onDetach: () => {}
  })
  peer.handlers.data(presence('opaque'))
  peer.handlers.data(roomData('opaque', [1, 2, 3]))
  assert.equal(joins, 0)
  token.resolve('opaque')
  await tick()
  assert.equal(joins, 1)
  assert.deepEqual(received, [[1, 2, 3]])
  assert.deepEqual(sent, [presence('opaque')])
  assert.equal(membership.reuse('remote'), true)
  peer.handlers.data(presence('opaque'))
  assert.equal(joins, 1)
  peer.handlers.data(presence('opaque', false))
  assert.equal(closes, 1)
  assert.equal(peer.isDead, false)
  peer.handlers.data(presence('opaque'))
  assert.equal(joins, 2)
  membership.leave()
})

void test('Trystero: obsolete membership cannot attach or advertise after leave and rejoin', async t => {
  const {manager, peer, sent} = setup(t)
  const oldToken = deferred()
  const newToken = deferred()
  let oldJoins = 0
  let newJoins = 0
  const old = manager.registerRoom('app', 'files', oldToken.promise, {
    active: true,
    onPeer: () => {
      oldJoins++
    },
    onDetach: () => {}
  })
  old.leave()
  const replacement = manager.registerRoom('app', 'files', newToken.promise, {
    active: true,
    onPeer: () => {
      newJoins++
    },
    onDetach: () => {}
  })
  replacement.setActive(false)
  peer.handlers.data(presence('opaque'))
  oldToken.resolve('opaque')
  newToken.resolve('opaque')
  await tick()
  assert.equal(oldJoins, 0)
  assert.equal(newJoins, 1)
  assert.deepEqual(sent, [])
  old.setActive(true)
  old.leave()
  assert.equal(old.reuse('remote'), false)
  const discarded = new MockPeer()
  old.connect('remote', discarded as any, 60_000)
  assert.equal(discarded.isDead, true)
  replacement.setActive(true)
  assert.deepEqual(sent, [presence('opaque')])
  replacement.leave()
  assert.deepEqual(sent, [presence('opaque'), presence('opaque', false)])
})

void test('Trystero: membership replaces stale peers and ignores their late close events', async t => {
  const {manager, peer} = setup(t)
  const physicals = []
  const membership = manager.registerRoom(
    'app',
    'files',
    Promise.resolve('files'),
    {
      active: true,
      onPeer: (_proxy, _id, physical) => {
        physicals.push(physical)
      },
      onDetach: () => {}
    }
  )
  assert.equal(membership.reuse('remote'), true)
  const duplicate = new MockPeer()
  membership.connect('remote', duplicate as any, 60_000)
  assert.equal(duplicate.destroyCount, 1)
  assert.deepEqual(physicals, [peer])
  const lateClose = peer.handlers.close
  peer.connection.connectionState = 'failed'
  const replacement = new MockPeer()
  membership.connect('remote', replacement as any, 60_000)
  assert.equal(peer.destroyCount, 1)
  assert.equal(manager.owns('app', 'remote', replacement as any), true)
  assert.deepEqual(physicals, [peer, replacement])
  lateClose()
  assert.equal(manager.owns('app', 'remote', replacement as any), true)
  assert.equal(membership.reuse('remote'), true)
  assert.deepEqual(physicals, [peer, replacement])
  membership.leave()
  await tick()
})

void test('Trystero: membership sees presence flushed while installing physical peer handlers', async t => {
  const manager = new SharedPeerManager()
  let joins = 0
  const membership = manager.registerRoom(
    'app',
    'files',
    Promise.resolve('files'),
    {
      active: false,
      onPeer: () => {
        joins++
      },
      onDetach: () => {}
    }
  )
  const lobby = manager.registerRoom('app', 'lobby', Promise.resolve('lobby'), {
    active: false,
    onPeer: () => {},
    onDetach: () => {}
  })
  const peer = new MockPeer()
  peer.setHandlers = handlers => {
    Object.assign(peer.handlers, handlers)
    peer.handlers.data(presence('files'))
  }
  t.after(() => manager.clear('app', 'remote', {destroyPeer: true}))
  await tick()
  lobby.connect('remote', peer as any, 60_000)
  assert.equal(joins, 1)
  assert.equal(membership.reuse('remote'), true)
  assert.equal(joins, 1)
})

void test('late departed-room traffic preserves other rooms and allows rejoin', async t => {
  t.mock.timers.enable({apis: ['setTimeout']})
  const {manager, peer} = setup(t)
  let stayingClosed = 0
  const received: number[][] = []
  const join = () =>
    manager.registerRoom('app', 'files', Promise.resolve('files'), {
      active: true,
      onPeer: proxy =>
        proxy.setHandlers({
          data: bytes => received.push([...new Uint8Array(bytes)])
        }),
      onDetach: () => {}
    })
  const staying = manager.registerRoom(
    'app',
    'staying',
    Promise.resolve('staying'),
    {
      active: true,
      onPeer: proxy => proxy.setHandlers({close: () => stayingClosed++}),
      onDetach: () => {}
    }
  )
  staying.reuse('remote')
  const leaving = join()
  leaving.reuse('remote')
  await Promise.resolve()
  await Promise.resolve()
  leaving.leave()
  for (let i = 0; i < 65; i++) {
    peer.handlers.data(roomData('files', [2, 0, ...new Array(34).fill(0)]))
  }
  t.mock.timers.tick(10_000)
  assert.equal(peer.isDead, false)
  assert.equal(stayingClosed, 0)
  const rejoined = join()
  rejoined.reuse('remote')
  await Promise.resolve()
  await Promise.resolve()
  peer.handlers.data(roomData('files', [42]))
  assert.deepEqual(received, [[42]])
  rejoined.leave()
  staying.leave()
})

void test('resolving a local token discards unrelated queued traffic without closing other rooms', async t => {
  t.mock.timers.enable({apis: ['setTimeout']})
  const {manager, peer} = setup(t)
  const token = deferred()
  const received: number[][] = []
  const room = manager.registerRoom('app', 'files', token.promise, {
    active: true,
    onPeer: proxy =>
      proxy.setHandlers({
        data: bytes => received.push([...new Uint8Array(bytes)])
      }),
    onDetach: () => {}
  })
  peer.handlers.data(presence('files'))
  peer.handlers.data(roomData('departed', [1]))
  peer.handlers.data(roomData('files', [42]))
  token.resolve('files')
  await Promise.resolve()
  await Promise.resolve()
  t.mock.timers.tick(10_000)
  assert.equal(peer.isDead, false)
  assert.deepEqual(received, [[42]])
  room.leave()
})

void test('late room traffic cannot close a shared peer while another token is unresolved', async t => {
  t.mock.timers.enable({apis: ['setTimeout']})
  const {manager, peer} = setup(t)
  await Promise.resolve()
  const joining = manager.registerRoom(
    'app',
    'joining',
    new Promise(() => {}),
    {
      active: true,
      onPeer: () => {},
      onDetach: () => {}
    }
  )
  for (let i = 0; i < 65; i++) {
    peer.handlers.data(roomData('departed', [1]))
  }
  t.mock.timers.tick(10_000)
  assert.equal(peer.isDead, false)
  joining.leave()
  assert.equal(peer.isDead, false)
})

void test('leaving before token resolution releases unclaimed room data', async t => {
  t.mock.timers.enable({apis: ['setTimeout']})
  const {manager, peer} = setup(t)
  await Promise.resolve()
  const joining = manager.registerRoom(
    'app',
    'joining',
    new Promise(() => {}),
    {
      active: true,
      onPeer: () => {},
      onDetach: () => {}
    }
  )
  peer.handlers.data(roomData('joining', [1]))
  joining.leave()
  assert.equal(manager.get('app', 'remote')!.pendingDataByToken.size, 0)
  t.mock.timers.tick(10_000)
  assert.equal(peer.isDead, false)
})

void test('registered rooms retain data flushed before their physical peer is bound', async t => {
  const manager = new SharedPeerManager()
  const received: number[][] = []
  const membership = manager.registerRoom(
    'app',
    'files',
    Promise.resolve('files'),
    {
      active: true,
      onPeer: proxy =>
        proxy.setHandlers({
          data: data => received.push([...new Uint8Array(data)])
        }),
      onDetach: () => {}
    }
  )
  await Promise.resolve()
  const peer = new MockPeer()
  peer.setHandlers = handlers => {
    Object.assign(peer.handlers, handlers)
    peer.handlers.data(roomData('files', [42]))
  }
  t.after(() => manager.clear('app', 'peer', {destroyPeer: true}))
  membership.connect('peer', peer as never, 60_000)
  await tick()
  assert.deepEqual(received, [[42]])
})

void test('active rooms retain passive-room handshakes until signaling creates the binding', async t => {
  const a = new SharedPeerManager()
  const b = new SharedPeerManager()
  const {peerA, peerB} = linkPeers(new LinkedPeer(), new LinkedPeer())
  t.after(() => {
    a.clear('app', 'b', {destroyPeer: true})
    b.clear('app', 'a', {destroyPeer: true})
  })
  const lobby = (manager, id, peer) =>
    manager
      .registerRoom('app', 'lobby', Promise.resolve('lobby'), {
        active: false,
        onPeer: () => {},
        onDetach: () => {}
      })
      .connect(id, peer, 60_000)
  lobby(a, 'b', peerA)
  lobby(b, 'a', peerB)
  await tick()
  b.registerRoom('app', 'files', Promise.resolve('files'), {
    active: false,
    onDetach: () => {},
    onPeer: proxy =>
      proxy.sendData(new Uint8Array(encodeInternalAction('@_hsready')))
  })
  await tick()
  let received = 0
  const active = a.registerRoom('app', 'files', Promise.resolve('files'), {
    active: true,
    onDetach: () => {},
    onPeer: proxy => proxy.setHandlers({data: () => received++})
  })
  await tick()
  assert.ok(b.get('app', 'a')!.bindings.files)
  // Resolving an unrelated binding must not discard the waiting handshake.
  a.registerRoom('app', 'other', Promise.resolve('other'), {
    active: false,
    onPeer: () => {},
    onDetach: () => {}
  }).reuse('b')
  await tick()
  assert.equal(active.reuse('b'), true)
  await tick()
  assert.equal(received, 1)
})
