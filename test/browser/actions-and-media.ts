import {expect} from '@playwright/test'
import {concurrentRooms, withStrategyBrowserPair} from './harness'
import {getPeerId, joinEagerRoom, ping} from './room-helpers'

export const registerActionsAndMediaTests = (strategy, overrides) =>
  withStrategyBrowserPair(
    strategy,
    overrides,
    'actions, requests, binary payloads, and media',
    async ctx => {
      const {
        browserName,
        initialConnectionResults,
        isRelayStrategy,
        joinPairWithRetry,
        page,
        page2,
        redundancy,
        roomConfig,
        selfId1,
        selfId2
      } = ctx

      if (browserName !== 'webkit') {
        await warmMediaDevices({page, page2})
      }

      const roomRuns = Array(concurrentRooms(strategy))
        .fill(undefined)
        .map(async (_, roomNum) => {
          const eagerPayload = 33
          const start = Date.now()
          const {roomId: roomNs, values} = await joinPairWithRetry({
            label: `room ${roomNum} eager join`,
            makeRoomId: () =>
              `testRoom-${roomNum}-${Math.random().toString().replace('.', '')}`,
            join: joinEagerRoom,
            makeArgs: nextRoomId => [nextRoomId, roomConfig, eagerPayload]
          }).catch(err => {
            initialConnectionResults[roomNum] = 'failed'

            throw err
          })
          const [peer2Data, peer1Data] = values
          const joinTime = Date.now() - start
          initialConnectionResults[roomNum] = joinTime
          const [peer2Id, peer1Id] = [peer2Data[1], peer1Data[1]]

          expect(peer1Data).toEqual([eagerPayload, selfId1])
          expect(peer2Data).toEqual([eagerPayload, selfId2])

          const isRoomIdentical = await page.evaluate(
            ([roomId, config]) =>
              window.trystero.joinRoom(config, roomId) === window[roomId],
            [roomNs, roomConfig]
          )

          expect(isRoomIdentical).toBe(true)

          if (browserName !== 'webkit') {
            await verifyMediaMetadata({page, page2, roomNs, peer1Id, peer2Id})
          }

          expect(await page.evaluate(getPeerId, roomNs)).toEqual(peer2Id)
          expect(await page2.evaluate(getPeerId, roomNs)).toEqual(peer1Id)

          expect(await page.evaluate(ping, [roomNs, peer2Id])).toBeLessThan(
            1000
          )
          expect(await page2.evaluate(ping, [roomNs, peer1Id])).toBeLessThan(
            1000
          )
          const [concurrentPingA, concurrentPingB] = await Promise.all([
            page.evaluate(ping, [roomNs, peer2Id]),
            page.evaluate(ping, [roomNs, peer2Id])
          ])

          expect(concurrentPingA).toBeLessThan(1000)
          expect(concurrentPingB).toBeLessThan(1000)

          await verifyMessageActions({page, page2, roomNs})
          await verifyRequestActions({page, page2, roomNs, peer1Id, peer2Id})

          if (roomNum === 0) {
            await verifyActionIsolation({
              page,
              page2,
              roomConfig,
              roomNs
            })
          }

          await verifyBinaryPayloads({page, page2, roomNs, peer1Id, peer2Id})

          if (isRelayStrategy) {
            expect(
              await page.evaluate(
                () => Object.keys(window.trystero.getRelaySockets()).length
              )
            ).toEqual(redundancy)

            expect(
              await page.evaluate(() =>
                Object.entries(window.trystero.getRelaySockets()).every(
                  ([k, v]) => typeof k === 'string' && v instanceof WebSocket
                )
              )
            ).toBe(true)
          }

          console.log(`  ✅    ${strategy} ${roomNum}: ${joinTime}ms`)
        })

      const roomRunResults = await Promise.allSettled(roomRuns)
      const failedRoom = roomRunResults.find(
        result => result.status === 'rejected'
      )

      if (failedRoom?.status === 'rejected') {
        throw failedRoom.reason
      }
    }
  )

const warmMediaDevices = async ({page, page2}) => {
  const warm = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: true
    })

    stream.getTracks().forEach(track => track.stop())
  }

  await Promise.all([page.evaluate(warm), page2.evaluate(warm)])
}

const verifyMediaMetadata = async ({page, page2, roomNs, peer1Id, peer2Id}) => {
  const onPeerStream = ([roomId, streamMeta]) =>
    new Promise((res, rej) => {
      const timeout = setTimeout(
        () => rej(new Error('timed out waiting for metadata stream')),
        10_000
      )

      window[roomId].onPeerStream = (stream, peerId, meta) => {
        clearTimeout(timeout)
        res({peerId, meta, streamType: stream.constructor.name})
      }

      setTimeout(async () => {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: true
        })
        window[roomId].addStream(stream, {metadata: streamMeta})
      }, 999)
    })

  const streamMeta = {id: Math.random()}
  const streamArgs = [roomNs, streamMeta]
  const [peer2StreamInfo, peer1StreamInfo] = await Promise.all([
    page.evaluate(onPeerStream, streamArgs),
    page2.evaluate(onPeerStream, streamArgs)
  ])
  const streamType = 'MediaStream'

  expect(peer1StreamInfo).toEqual({
    peerId: peer1Id,
    meta: streamMeta,
    streamType
  })
  expect(peer2StreamInfo).toEqual({
    peerId: peer2Id,
    meta: streamMeta,
    streamType
  })

  const onPeerTrack = ([roomId, streamMeta]) =>
    new Promise((res, rej) => {
      const timeout = setTimeout(
        () => rej(new Error('timed out waiting for metadata track')),
        10_000
      )

      window[roomId].onPeerTrack = (track, stream, peerId, meta) => {
        clearTimeout(timeout)
        res({
          peerId,
          meta,
          streamType: stream.constructor.name,
          trackType: track.constructor.name
        })
      }

      setTimeout(async () => {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: true
        })
        window[roomId].addTrack(stream.getTracks()[0], stream, {
          metadata: streamMeta
        })
      }, 999)
    })

  const [peer2TrackInfo, peer1TrackInfo] = await Promise.all([
    page.evaluate(onPeerTrack, streamArgs),
    page2.evaluate(onPeerTrack, streamArgs)
  ])

  const trackType = 'MediaStreamTrack'

  expect(peer1TrackInfo).toEqual({
    peerId: peer1Id,
    meta: streamMeta,
    streamType,
    trackType
  })
  expect(peer2TrackInfo).toEqual({
    peerId: peer2Id,
    meta: streamMeta,
    streamType,
    trackType
  })
}

const verifyMessageActions = async ({page, page2, roomNs}) => {
  const makeAction = ([roomId, message]) => {
    const messageAction = window[roomId].makeAction('message')

    return new Promise(res => {
      messageAction.onMessage = res
      setTimeout(() => messageAction.send(message), 333)
    })
  }

  const message1 = Math.random()
  const message2 = Math.random()

  const [receivedMessage1, receivedMessage2] = await Promise.all([
    page.evaluate(makeAction, [roomNs, message1]),
    page2.evaluate(makeAction, [roomNs, message2])
  ])

  expect(receivedMessage1).toEqual(message2)
  expect(receivedMessage2).toEqual(message1)

  const empty = ''

  const [receivedMessage3, receivedMessage4] = await Promise.all([
    page.evaluate(makeAction, [roomNs, empty]),
    page2.evaluate(makeAction, [roomNs, empty])
  ])

  expect(receivedMessage3).toEqual(empty)
  expect(receivedMessage4).toEqual(empty)

  expect(
    await page.evaluate(
      ([roomId, actionName]) =>
        window[roomId].makeAction(actionName) ===
        window[roomId].makeAction(actionName + ''),
      [roomNs, 'mucho']
    )
  ).toBe(true)
}

const verifyRequestActions = async ({
  page,
  page2,
  roomNs,
  peer1Id,
  peer2Id
}) => {
  const setupRequestActions = roomId => {
    window[roomId].makeAction('is-even', {
      kind: 'request',
      onRequest: n => n % 2 === 0
    })

    window[roomId].makeAction('request-rejects', {
      kind: 'request',
      onRequest: () => {
        throw new Error('request denied')
      }
    })

    window[roomId].makeAction('late-request', {kind: 'request'})

    window[roomId].makeAction('slow-request', {
      kind: 'request',
      onRequest: async value => {
        await new Promise(res => setTimeout(res, 100))
        return value
      }
    })
  }

  await Promise.all([
    page.evaluate(setupRequestActions, roomNs),
    page2.evaluate(setupRequestActions, roomNs)
  ])

  const requestIsEven = ([roomId, peerId, value]) =>
    window[roomId]
      .makeAction('is-even', {kind: 'request'})
      .request(value, {target: peerId, timeoutMs: 1000})

  expect(await page.evaluate(requestIsEven, [roomNs, peer2Id, 42])).toEqual(
    true
  )
  expect(await page2.evaluate(requestIsEven, [roomNs, peer1Id, 41])).toEqual(
    false
  )

  const requestRejects = ([roomId, peerId]) =>
    window[roomId]
      .makeAction('request-rejects', {kind: 'request'})
      .request('please', {target: peerId, timeoutMs: 1000})
      .then(
        () => 'resolved',
        err => String(err?.message ?? err)
      )

  expect(await page.evaluate(requestRejects, [roomNs, peer2Id])).toMatch(
    /request denied/
  )

  const requestLate = ([roomId, peerId]) =>
    window[roomId]
      .makeAction('late-request', {kind: 'request'})
      .request('hello', {target: peerId, timeoutMs: 1000})

  const lateRequest = page.evaluate(requestLate, [roomNs, peer2Id])

  await new Promise(res => setTimeout(res, 50))
  await page2.evaluate(roomId => {
    window[roomId].makeAction('late-request', {
      kind: 'request'
    }).onRequest = () => 'hello back'
  }, roomNs)

  expect(await lateRequest).toEqual('hello back')

  const requestMany = ([roomId, peerId]) => {
    const seen = []

    return window[roomId]
      .makeAction('is-even', {kind: 'request'})
      .requestMany(8, {
        targets: ['missing-peer', peerId],
        timeoutMs: 1000,
        onResult: result => seen.push(result.status)
      })
      .then(results => ({
        seen: seen.sort((a, b) => a.localeCompare(b)),
        results: results.map(({peerId, status, value}) => ({
          peerId,
          status,
          value
        }))
      }))
  }

  const many = await page.evaluate(requestMany, [roomNs, peer2Id])

  expect(many.results).toEqual([
    {peerId: 'missing-peer', status: 'disconnected'},
    {peerId: peer2Id, status: 'fulfilled', value: true}
  ])
  expect(many.seen).toEqual(['disconnected', 'fulfilled'])

  const abortRequest = ([roomId, peerId]) => {
    const controller = new AbortController()
    const result = window[roomId]
      .makeAction('slow-request', {kind: 'request'})
      .request('later', {
        target: peerId,
        signal: controller.signal
      })
      .then(
        () => 'resolved',
        err => err?.name
      )

    controller.abort()

    return result
  }

  expect(await page.evaluate(abortRequest, [roomNs, peer2Id])).toEqual(
    'AbortError'
  )
}

const verifyActionIsolation = async ({page, page2, roomConfig, roomNs}) => {
  const isolatedRoomA = roomNs + '-isolation-a'
  const isolatedRoomB = roomNs + '-isolation-b'

  const evaluateActionIsolation = ([roomA, roomB, config, label]) => {
    const roomARef = window.trystero.joinRoom(config, roomA)
    const roomBRef = window.trystero.joinRoom(config, roomB)
    window[roomA] = roomARef
    window[roomB] = roomBRef

    const sharedA = roomARef.makeAction('shared')
    const sharedB = roomBRef.makeAction('shared')

    return Promise.all([
      new Promise(res => (roomARef.onPeerJoin = res)),
      new Promise(res => (roomBRef.onPeerJoin = res))
    ]).then(([peerA, peerB]) =>
      Promise.all([
        new Promise(res => (sharedA.onMessage = res)),
        new Promise(res => (sharedB.onMessage = res)),
        sharedA.send({room: roomA, from: label}, {target: peerA}),
        sharedB.send({room: roomB, from: label}, {target: peerB})
      ]).then(([receivedA, receivedB]) => ({receivedA, receivedB}))
    )
  }

  const [isolationResult1, isolationResult2] = await Promise.all([
    page.evaluate(evaluateActionIsolation, [
      isolatedRoomA,
      isolatedRoomB,
      roomConfig,
      'page-1'
    ]),
    page2.evaluate(evaluateActionIsolation, [
      isolatedRoomA,
      isolatedRoomB,
      roomConfig,
      'page-2'
    ])
  ])

  expect(isolationResult1).toEqual({
    receivedA: {room: isolatedRoomA, from: 'page-2'},
    receivedB: {room: isolatedRoomB, from: 'page-2'}
  })
  expect(isolationResult2).toEqual({
    receivedA: {room: isolatedRoomA, from: 'page-1'},
    receivedB: {room: isolatedRoomB, from: 'page-1'}
  })

  const leaveRoom = roomId => window[roomId]?.leave()

  await Promise.all([
    page.evaluate(leaveRoom, isolatedRoomA),
    page2.evaluate(leaveRoom, isolatedRoomA),
    page.evaluate(leaveRoom, isolatedRoomB),
    page2.evaluate(leaveRoom, isolatedRoomB)
  ])
}

const verifyBinaryPayloads = async ({
  page,
  page2,
  roomNs,
  peer1Id,
  peer2Id
}) => {
  const makeBinaryAction = ([roomId, message, metadata]) => {
    const binaryAction = window[roomId].makeAction('binary')

    let senderPercent = 0
    let receiverPercent = 0
    let senderCallCount = 0
    let receiverCallCount = 0

    binaryAction.onReceiveProgress = p => {
      receiverPercent = p
      receiverCallCount++
    }

    return Promise.all([
      new Promise(res => {
        binaryAction.onMessage = (payload, {metadata: receivedMeta}) =>
          res([
            new TextDecoder().decode(payload).slice(-message.length),
            receivedMeta
          ])
      }),

      new Promise(res => setTimeout(res, 1233)).then(() =>
        binaryAction.send(new TextEncoder().encode(message.repeat(50000)), {
          metadata,
          onProgress: p => {
            senderPercent = p
            senderCallCount++
          }
        })
      )
    ]).then(([received]) => {
      const [payload, meta] = received as [string, unknown]

      return [
        payload,
        meta,
        senderPercent,
        senderCallCount,
        receiverPercent,
        receiverCallCount
      ]
    })
  }

  const mockMeta = {foo: 'bar', baz: 'qux'}

  const payloads = await Promise.all([
    page.evaluate(makeBinaryAction, [roomNs, peer1Id, mockMeta]),
    page2.evaluate(makeBinaryAction, [roomNs, peer2Id, mockMeta])
  ])

  expect(payloads[0][0]).toEqual(peer2Id)
  expect(payloads[1][0]).toEqual(peer1Id)

  payloads.forEach(payload => {
    const [
      ,
      meta,
      senderPercent,
      senderCallCount,
      receiverPercent,
      receiverCallCount
    ] = payload
    expect(meta).toEqual(mockMeta)
    expect(senderPercent).toEqual(1)
    expect(senderCallCount).toEqual(63)
    expect(receiverPercent).toEqual(senderPercent)
    expect(receiverCallCount).toEqual(senderCallCount)
  })
}
