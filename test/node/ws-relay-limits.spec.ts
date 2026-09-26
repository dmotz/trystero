import assert from 'node:assert/strict'
import {once} from 'node:events'
import test from 'node:test'
import WebSocket from 'ws'
import {createWsRelayServer} from '@trystero-p2p/ws-relay/server'

const waitFor = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 100; i++) {
    if (check()) {
      return
    }

    await new Promise(resolve => setTimeout(resolve, 10))
  }

  assert.fail('relay did not reach expected subscription count')
}

void test('WebSocket relay default limits stop a single-socket topic flood', async () => {
  const relay = createWsRelayServer({port: 0, host: '127.0.0.1'})
  await relay.ready
  const address = relay.address()
  assert.ok(address && typeof address === 'object')
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`)

  try {
    await once(socket, 'open')
    const closed = once(socket, 'close', {signal: AbortSignal.timeout(2_000)})

    for (let i = 0; i <= 128; i++) {
      socket.send(JSON.stringify({type: 'subscribe', topic: `topic-${i}`}))
    }

    assert.equal((await closed)[0], 1008)
    await waitFor(() => relay.getSubscriberCount() === 0)
  } finally {
    socket.terminate()
    await relay.close()
  }
})

void test('WebSocket relay bounds subscriptions and releases them on close', async () => {
  const relay = createWsRelayServer({
    port: 0,
    host: '127.0.0.1',
    maxPayload: 256,
    maxTopicLength: 8,
    maxSubscriptionsPerSocket: 2,
    maxSubscriptions: 3
  })
  await relay.ready
  const address = relay.address()
  assert.ok(address && typeof address === 'object')
  const url = `ws://127.0.0.1:${address.port}`
  const clients: WebSocket[] = []
  const connect = async (): Promise<WebSocket> => {
    const socket = new WebSocket(url)
    clients.push(socket)
    await once(socket, 'open')
    return socket
  }
  const subscribe = (socket: WebSocket, topic: string): void =>
    socket.send(JSON.stringify({type: 'subscribe', topic}))

  try {
    const first = await connect()
    subscribe(first, 'a')
    subscribe(first, 'b')
    subscribe(first, 'a')
    await waitFor(() => relay.getSubscriberCount() === 2)
    assert.equal(first.readyState, WebSocket.OPEN)

    first.send(JSON.stringify({type: 'unsubscribe', topic: 'a'}))
    subscribe(first, 'c')
    await waitFor(() => relay.getSubscriberCount('c') === 1)
    assert.equal(relay.getSubscriberCount(), 2)

    const second = await connect()
    subscribe(second, 'd')
    await waitFor(() => relay.getSubscriberCount() === 3)

    const third = await connect()
    const thirdClosed = once(third, 'close', {
      signal: AbortSignal.timeout(1_000)
    })
    subscribe(third, 'e')
    assert.equal((await thirdClosed)[0], 1008)
    assert.equal(relay.getSubscriberCount(), 3)

    const firstClosed = once(first, 'close', {
      signal: AbortSignal.timeout(1_000)
    })
    subscribe(first, 'f')
    assert.equal((await firstClosed)[0], 1008)
    await waitFor(() => relay.getSubscriberCount() === 1)

    const fourth = await connect()
    subscribe(fourth, 'e')
    await waitFor(() => relay.getSubscriberCount() === 2)

    const fifth = await connect()
    const fifthClosed = once(fifth, 'close', {
      signal: AbortSignal.timeout(1_000)
    })
    subscribe(fifth, 'too-long!')
    assert.equal((await fifthClosed)[0], 1008)
    assert.equal(relay.getSubscriberCount(), 2)

    const sixth = await connect()
    const sixthClosed = once(sixth, 'close', {
      signal: AbortSignal.timeout(1_000)
    })
    sixth.send('x'.repeat(257))
    assert.equal((await sixthClosed)[0], 1009)
    assert.equal(relay.getSubscriberCount(), 2)
  } finally {
    clients.forEach(socket => socket.terminate())
    await relay.close()
  }
})
