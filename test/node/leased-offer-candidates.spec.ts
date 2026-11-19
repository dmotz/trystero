import assert from 'node:assert/strict'
import test from './test.ts'
import {decrypt, encrypt, genKey} from '../../packages/core/src/crypto.ts'
import type {StrategyAdapter} from '../../packages/core/src/internal-types.ts'
import {buildSignalAad} from '../../packages/core/src/signal-handler.ts'
import createStrategy from '../../packages/core/src/strategy.ts'
import {
  higherPeerId,
  MockRTCPeerConnection,
  turn,
  waitFor
} from './peer-harness.ts'

const candidate = (port: number) => ({
  candidate: `candidate:1 1 udp 1 127.0.0.1 ${port} typ host`,
  sdpMLineIndex: 0
})

class CandidatePeer extends MockRTCPeerConnection {
  onicecandidate:
    | ((event: {candidate: ReturnType<typeof candidate>}) => void)
    | null = null
  answers = 0
  candidates: ReturnType<typeof candidate>[] = []

  emit(port: number) {
    this.onicecandidate?.({candidate: candidate(port)})
  }

  override async setLocalDescription() {
    this.emit(10001)
    await super.setLocalDescription()
  }

  override async setRemoteDescription(description: {
    type: string
    sdp: string
  }) {
    this.answers++
    await super.setRemoteDescription(description)
  }

  async addIceCandidate(value: ReturnType<typeof candidate>) {
    this.candidates.push(value)
  }
}

const openRoom = async (appId: string, trickleIce = true) => {
  const ready =
    Promise.withResolvers<Parameters<StrategyAdapter<null>['subscribe']>>()
  const joinRoom = createStrategy({
    init: () => null,
    subscribe: (...args) => {
      ready.resolve(args)
      return () => {}
    },
    announce: () => {}
  })
  const room = joinRoom(
    {
      appId,
      passive: true,
      rtcPolyfill: CandidatePeer as unknown as typeof RTCPeerConnection,
      trickleIce
    },
    'room'
  )
  const [, root, , onMessage, getOffers, {peerId}] = await ready.promise
  return {
    room,
    root,
    onMessage,
    getOffers,
    peerId,
    key: genKey('', appId, 'room')
  }
}

const connection = (record: {peer: {connection: RTCPeerConnection}}) => {
  const pc = record.peer.connection
  assert.ok(pc instanceof CandidatePeer)
  return pc
}

void test('leased offers deliver encrypted candidates in order after subscription', async t => {
  const {room, getOffers, peerId, key} = await openRoom('leased-ordered')
  t.after(() => room.leave())
  const [first, second] = await getOffers(2)
  assert.ok(first?.onCandidate && second?.onCandidate)
  assert.notEqual(first.offerId, second.offerId)

  const firstPc = connection(first)
  firstPc.emit(10002)
  const delivered: string[] = []
  const firstSend = Promise.withResolvers<void>()
  const stop = first.onCandidate(async ciphertext => {
    delivered.push(ciphertext)
    if (delivered.length === 1) {
      await firstSend.promise
    }
  })
  t.after(stop)
  const secondSend = Promise.withResolvers<string>()
  second.onCandidate(secondSend.resolve)
  firstPc.emit(10003)

  const secondCiphertext = await secondSend.promise
  await waitFor(() => delivered.length === 1)
  assert.equal(
    await decrypt(
      key,
      secondCiphertext,
      buildSignalAad('candidate', peerId, second.offerId)
    ),
    JSON.stringify(candidate(10001))
  )
  await assert.rejects(
    decrypt(
      key,
      secondCiphertext,
      buildSignalAad('candidate', peerId, first.offerId)
    )
  )
  firstSend.resolve()
  await waitFor(() => delivered.length === 3)
  assert.deepEqual(
    await Promise.all(
      delivered.map(ciphertext =>
        decrypt(
          key,
          ciphertext,
          buildSignalAad('candidate', peerId, first.offerId)
        )
      )
    ),
    [10001, 10002, 10003].map(port => JSON.stringify(candidate(port)))
  )
})

void test(
  'leased candidate delivery is bounded and stops when it is no longer needed',
  {timeout: 5_000},
  async t => {
    const {room, getOffers} = await openRoom('leased-cancel')
    t.after(() => room.leave())
    t.mock.timers.enable({apis: ['setTimeout']})
    for (const reason of [
      'limit',
      'cancel',
      'reclaim',
      'expire',
      'destroy',
      'leave'
    ]) {
      const [record] = await getOffers(1)
      assert.ok(record?.onCandidate)
      const pc = connection(record)
      const firstSend = Promise.withResolvers<void>()
      const sent = Promise.withResolvers<void>()
      const limitReached = Promise.withResolvers<void>()
      let count = 0
      const cancel = record.onCandidate(async () => {
        count++
        sent.resolve()
        if (count === 129) {
          limitReached.resolve()
        }
        await firstSend.promise
      })
      await sent.promise
      for (let i = 0; i < 300; i++) {
        pc.emit(11000 + i)
      }
      if (reason === 'limit') {
        firstSend.resolve()
        await limitReached.promise
        await turn()
        assert.equal(count, 129)
        cancel()
      } else if (reason === 'cancel') {
        cancel()
      } else if (reason === 'reclaim') {
        record.reclaim?.()
      } else if (reason === 'expire') {
        t.mock.timers.tick(180_000)
      } else if (reason === 'destroy') {
        record.peer.destroy()
      } else {
        await room.leave()
      }
      if (reason !== 'cancel' && reason !== 'limit') {
        assert.equal(record.peer.isDead, true)
      }
      pc.emit(12000)
      const countAtStop = count
      firstSend.resolve()
      await turn()
      await turn()
      assert.equal(count, countAtStop)
      record.reclaim?.()
    }
  }
)

void test('leased signaling ignores mismatched IDs and duplicate or late answers', async t => {
  const {room, root, onMessage, getOffers, peerId, key} =
    await openRoom('leased-answers')
  t.after(() => room.leave())
  const [offer, expired] = await getOffers(2)
  assert.ok(offer && expired)
  const remoteId = higherPeerId(peerId)
  const answerFor = (offerId: string) =>
    encrypt(key, 'remote-answer', buildSignalAad('answer', remoteId, offerId))
  const receive = (message: Record<string, unknown>) =>
    onMessage(root, {peerId: remoteId, peer: offer.peer, ...message}, () => {})
  const answer = await answerFor(offer.offerId)
  await receive({
    offerId: expired.offerId,
    answer: await answerFor(expired.offerId)
  })
  assert.equal(connection(offer).answers, 0)
  assert.equal(offer.peer.isDead, false)

  const trickle = await encrypt(
    key,
    JSON.stringify(candidate(11000)),
    buildSignalAad('candidate', remoteId, offer.offerId)
  )
  await receive({offerId: offer.offerId, candidate: trickle})
  offer.claim?.()
  await Promise.all([
    receive({offerId: offer.offerId, answer}),
    receive({offerId: offer.offerId, answer})
  ])
  await receive({offerId: offer.offerId, answer: 'invalid'})
  assert.equal(connection(offer).answers, 1)
  assert.equal(offer.peer.isDead, false)
  await waitFor(() => connection(offer).candidates.length === 1)
  const outgoing = Promise.withResolvers<string>()
  assert.ok(offer.onCandidate)
  offer.onCandidate(outgoing.resolve)
  assert.equal(
    await decrypt(
      key,
      await outgoing.promise,
      buildSignalAad('candidate', peerId, offer.offerId)
    ),
    JSON.stringify(candidate(10001))
  )

  expired.reclaim?.()
  await receive({
    peer: expired.peer,
    offerId: expired.offerId,
    answer: await answerFor(expired.offerId)
  })
  assert.equal(connection(expired).answers, 0)
})

void test('leased offers omit candidate delivery with trickle ICE disabled', async t => {
  const {room, getOffers} = await openRoom('leased-non-trickle', false)
  t.after(() => room.leave())
  const [offer] = await getOffers(1)
  assert.ok(offer)
  assert.equal(offer.onCandidate, undefined)
})
