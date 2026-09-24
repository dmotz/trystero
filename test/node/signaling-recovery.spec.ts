// @ts-nocheck
import assert from 'node:assert/strict'
import test from 'node:test'
import {createSignalHandler} from '../../packages/core/src/signal-handler.ts'
import {selfId} from '../../packages/core/src/utils.ts'

const settle = async () => {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve()
  }
}

const fixture = t => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date']})
  const messages = []
  let leaving = false
  const peer = () => ({
    isDead: false,
    connection: {},
    handlers: {},
    setHandlers(handlers) {
      Object.assign(this.handlers, handlers)
    },
    destroy() {
      this.isDead = true
    },
    async signal(signal) {
      if (signal.type === 'offer') {
        this.handlers.signal?.({type: 'answer', sdp: 'answer'})
        this.handlers.signal?.({type: 'candidate', sdp: 'candidate'})
      }
    }
  })
  const ctx = {
    appId: 'recovery-test',
    roomId: 'room',
    config: {},
    peerStates: {},
    rootTopicPlaintext: 'root',
    rootTopicP: Promise.resolve('root'),
    selfTopicP: Promise.resolve('self'),
    toPlain: async signal => signal,
    toCipher: async signal => signal,
    isLeaving: () => leaving,
    isPassive: false,
    isActive: true,
    sharedPeers: {get: () => undefined},
    offerPool: {
      checkout: async () => [{peer: peer(), offer: 'offer'}],
      recycle() {}
    },
    initPeer: peer,
    checkDeactivate() {},
    connectPeer() {},
    disconnectPeer() {},
    announceIntervals: [],
    announceIntervalMs: 5333
  }
  const receive = createSignalHandler(ctx)(0)
  const send = (_, message) => messages.push(JSON.parse(message))
  return {
    ctx,
    messages,
    leave: () => {
      leaving = true
    },
    receive: payload => receive('root', payload, send)
  }
}

void test('unanswered offers retry without discovery traffic and stop after two retries', async t => {
  const f = fixture(t)
  await f.receive({peerId: selfId + 'z'})
  assert.equal(f.messages.filter(msg => msg.offer).length, 1)
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(4800)
    await settle()
  }
  const offers = f.messages.filter(msg => msg.offer)
  assert.equal(offers.length, 3)
  assert.equal(new Set(offers.map(msg => msg.offerId)).size, 1)
  t.mock.timers.tick(20000)
  await settle()
  assert.equal(f.messages.filter(msg => msg.offer).length, 3)
})

void test('offer retries stop after an answer or room leave', async t => {
  const f = fixture(t)
  const peerId = selfId + 'z'
  await f.receive({peerId})
  await f.receive({peerId, offerId: f.messages[0].offerId, answer: 'answer'})
  t.mock.timers.tick(5000)
  await settle()
  assert.equal(f.messages.length, 1)
  await f.receive({peerId: peerId + 'z'})
  f.leave()
  t.mock.timers.tick(5000)
  await settle()
  assert.equal(f.messages.length, 2)
})

void test('first topic retry is prompt but later retries retain their spacing', async t => {
  const f = fixture(t)
  await f.receive({peerId: selfId + 'z'})
  t.mock.timers.tick(1999)
  await settle()
  assert.equal(f.messages.filter(msg => msg.offer).length, 1)
  t.mock.timers.tick(1)
  await settle()
  assert.equal(f.messages.filter(msg => msg.offer).length, 2)
  t.mock.timers.tick(2000)
  await settle()
  assert.equal(f.messages.filter(msg => msg.offer).length, 2)
  t.mock.timers.tick(2800)
  await settle()
  assert.equal(f.messages.filter(msg => msg.offer).length, 3)
})

void test('numeric relay pacing is not shortened by the prompt topic retry', async t => {
  const f = fixture(t)
  f.ctx.announceIntervals[0] = 10000
  await f.receive({peerId: selfId + 'z'})
  t.mock.timers.tick(2000)
  await settle()
  assert.equal(f.messages.filter(msg => msg.offer).length, 1)
  t.mock.timers.tick(7000)
  await settle()
  assert.equal(f.messages.filter(msg => msg.offer).length, 2)
})

void test('a pending retry does not prematurely deactivate a passive room', async t => {
  const f = fixture(t)
  f.ctx.isPassive = true
  f.ctx.checkDeactivate = () => {
    if (
      !Object.values(f.ctx.peerStates).some(state =>
        state.offerRelays.some(Boolean)
      )
    ) {
      f.ctx.isActive = false
    }
  }
  await f.receive({peerId: selfId + 'z'})
  t.mock.timers.tick(4800)
  await settle()
  assert.equal(f.ctx.isActive, true)
  assert.equal(f.messages.filter(msg => msg.offer).length, 2)
})

void test('a matching repeated offer replays its answer and candidates, not a new peer', async t => {
  const f = fixture(t)
  const offer = {peerId: selfId + 'z', offer: 'offer', offerId: 'exchange'}
  await f.receive(offer)
  await settle()
  const initial = [...f.messages]
  assert.equal(initial.filter(msg => msg.answer).length, 1)
  const answeringPeer = f.ctx.peerStates[offer.peerId].answeringPeer
  await f.receive(offer)
  assert.deepEqual(
    f.messages,
    initial,
    'rapid duplicates must not amplify traffic'
  )
  t.mock.timers.tick(5000)
  await f.receive({...offer, offerId: 'wrong-exchange'})
  assert.deepEqual(f.messages, initial)
  await f.receive({...offer, offer: 'different-sdp'})
  assert.deepEqual(f.messages, initial)
  await f.receive(offer)
  assert.deepEqual(f.messages, [...initial, ...initial])
  assert.equal(f.ctx.peerStates[offer.peerId].answeringPeer, answeringPeer)
})
