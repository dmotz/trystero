import assert from 'node:assert/strict'
import {once} from 'node:events'
import {WebSocketServer} from 'ws'
import test from './test.ts'
// @ts-expect-error Internal source import crosses a referenced package boundary.
import {joinRoom} from '../../packages/supabase/src/index.ts'
import {waitFor} from './peer-harness.ts'

void test('Supabase shares identical clients and isolates project URLs and keys', async t => {
  const realTimeout = globalThis.setTimeout
  // Supabase keeps idle sockets for a grace period after the last channel leaves.
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    const timer = realTimeout(callback, delay === 50_000 ? 0 : delay, ...args)
    return timer
  })
  const servers = [0, 1].map(
    () => new WebSocketServer({host: '127.0.0.1', port: 0})
  )
  t.after(async () => {
    await Promise.all(
      servers.map(server => {
        server.clients.forEach(socket => socket.terminate())
        return new Promise<void>((resolve, reject) =>
          server.close(error => (error ? reject(error) : resolve()))
        )
      })
    )
  })
  const connections: string[][] = [[], []]
  let subscriptions = 0
  servers.forEach((server, index) =>
    server.on('connection', (socket, request) => {
      connections[index].push(
        new URL(request.url!, 'http://local').searchParams.get('apikey')!
      )
      socket.on('message', bytes => {
        const [joinRef, ref, topic, event] = JSON.parse(
          new TextDecoder().decode(bytes as Uint8Array)
        )
        if (event === 'phx_join') {
          subscriptions++
        }
        if (
          event === 'phx_join' ||
          event === 'phx_leave' ||
          event === 'heartbeat'
        ) {
          socket.send(
            JSON.stringify([
              joinRef,
              ref,
              topic,
              'phx_reply',
              {status: 'ok', response: {}}
            ])
          )
        }
      })
    })
  )
  await Promise.all(servers.map(server => once(server, 'listening')))
  const configs = servers.map(server => {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    return {
      appId: `http://127.0.0.1:${address.port}`,
      passive: true,
      relayConfig: {supabaseKey: 'key-one'}
    }
  })
  const rooms = []
  try {
    rooms.push(
      joinRoom(configs[0], 'first'),
      joinRoom(configs[0], 'same-client')
    )
    rooms.push(joinRoom(configs[1], 'other-project'))
    rooms.push(
      joinRoom(
        {...configs[0], relayConfig: {supabaseKey: 'key-two'}},
        'other-key'
      )
    )
    await waitFor(
      () =>
        connections[0].length >= 2 &&
        connections[1].length >= 1 &&
        subscriptions === 4
    )
    assert.deepEqual(connections[0].sort(), ['key-one', 'key-two'])
    assert.deepEqual(connections[1], ['key-one'])
  } finally {
    await Promise.all(rooms.map(room => room.leave()))
    await waitFor(() => servers.every(server => server.clients.size === 0))
  }
})
