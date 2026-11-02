import {expect, type Page} from '@playwright/test'
import type {StrategyConfig, StrategyName} from '../strategy-configs'
import {concurrentRooms, withStrategyBrowserPair} from './harness'
import {getPeerId, joinEagerRoom, ping} from './room-helpers'

type RoomPairParams = {
  page: Page
  page2: Page
  roomNs: string
  peer1Id: string
  peer2Id: string
}

type BinaryActionResult = [string, unknown, number, number, number, number]

export const registerActionsAndMediaTests = (
  strategy: StrategyName,
  overrides: StrategyConfig = {}
): void =>
  withStrategyBrowserPair(
    strategy,
    overrides,
    'actions, requests, binary payloads, and media',
    async ctx => {
      const {
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

      await warmMediaDevices({page, page2})

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
            makeArgs: (nextRoomId): [string, StrategyConfig, number] => [
              nextRoomId,
              roomConfig,
              eagerPayload
            ]
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
            ([roomId, config]: [string, StrategyConfig]) =>
              window.trystero.joinRoom(config, roomId) === window[roomId],
            [roomNs, roomConfig] satisfies [string, StrategyConfig]
          )

          expect(isRoomIdentical).toBe(true)

          await verifyMediaMetadata({page, page2, roomNs, peer1Id, peer2Id})

          expect(await page.evaluate(getPeerId, roomNs)).toEqual(peer2Id)
          expect(await page2.evaluate(getPeerId, roomNs)).toEqual(peer1Id)

          expect(
            await page.evaluate(ping, [roomNs, peer2Id] satisfies [
              string,
              string
            ])
          ).toBeLessThan(1000)
          expect(
            await page2.evaluate(ping, [roomNs, peer1Id] satisfies [
              string,
              string
            ])
          ).toBeLessThan(1000)
          const [concurrentPingA, concurrentPingB] = await Promise.all([
            page.evaluate(ping, [roomNs, peer2Id] satisfies [string, string]),
            page.evaluate(ping, [roomNs, peer2Id] satisfies [string, string])
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

const warmMediaDevices = async ({
  page,
  page2
}: {
  page: Page
  page2: Page
}): Promise<void> => {
  const warm = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: true
    })

    stream.getTracks().forEach(track => track.stop())
  }

  await Promise.all([page.evaluate(warm), page2.evaluate(warm)])
}

const verifyMediaMetadata = async ({
  page,
  page2,
  roomNs,
  peer1Id,
  peer2Id
}: RoomPairParams): Promise<void> => {
  const onPeerStream = ([roomId, streamMeta]: [string, {id: number}]): Promise<{
    peerId: string
    meta: unknown
    streamType: string
  }> =>
    new Promise((res, rej) => {
      const timeout = setTimeout(
        () => rej(new Error('timed out waiting for metadata stream')),
        10_000
      )

      window[roomId].onPeerStream(
        (
          stream: MediaStream,
          {peerId, metadata: meta}: {peerId: string; metadata?: unknown}
        ) => {
          clearTimeout(timeout)
          res({peerId, meta, streamType: stream.constructor.name})
        },
        {once: true}
      )

      setTimeout(async () => {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: true
        })
        window[roomId].addStream(stream, {metadata: streamMeta})
      }, 999)
    })

  const streamMeta = {id: Math.random()}
  const streamArgs: [string, {id: number}] = [roomNs, streamMeta]
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
}

const verifyMessageActions = async ({
  page,
  page2,
  roomNs
}: {
  page: Page
  page2: Page
  roomNs: string
}): Promise<void> => {
  const makeAction = <T extends number | string>([roomId, message]: [
    string,
    T
  ]): Promise<unknown> => {
    const messageAction = window[roomId].makeAction('message')

    return new Promise(res => {
      messageAction.onMessage((data: unknown) => res(data), {once: true})
      setTimeout(() => messageAction.send(message), 333)
    })
  }

  const message1 = Math.random()
  const message2 = Math.random()

  const [receivedMessage1, receivedMessage2] = await Promise.all([
    page.evaluate(makeAction, [roomNs, message1] satisfies [string, number]),
    page2.evaluate(makeAction, [roomNs, message2] satisfies [string, number])
  ])

  expect(receivedMessage1).toEqual(message2)
  expect(receivedMessage2).toEqual(message1)

  const empty = ''

  const [receivedMessage3, receivedMessage4] = await Promise.all([
    page.evaluate(makeAction, [roomNs, empty] satisfies [string, string]),
    page2.evaluate(makeAction, [roomNs, empty] satisfies [string, string])
  ])

  expect(receivedMessage3).toEqual(empty)
  expect(receivedMessage4).toEqual(empty)

  expect(
    await page.evaluate(
      ([roomId, actionName]: [string, string]) =>
        window[roomId].makeAction(actionName) ===
        window[roomId].makeAction(actionName + ''),
      [roomNs, 'mucho'] satisfies [string, string]
    )
  ).toBe(true)
}

const verifyRequestActions = async ({
  page,
  page2,
  roomNs,
  peer1Id,
  peer2Id
}: RoomPairParams): Promise<void> => {
  const setupRequestActions = (roomId: string) => {
    window[roomId]
      .makeAction('is-even', {
        kind: 'request'
      })
      .onRequest((n: number) => n % 2 === 0)

    window[roomId]
      .makeAction('request-rejects', {
        kind: 'request'
      })
      .onRequest(() => {
        throw new Error('request denied')
      })

    window[roomId].makeAction('late-request', {kind: 'request'})

    window[roomId]
      .makeAction('slow-request', {
        kind: 'request'
      })
      .onRequest(async (value: unknown) => {
        await new Promise(res => setTimeout(res, 100))
        return value
      })
  }

  await Promise.all([
    page.evaluate(setupRequestActions, roomNs),
    page2.evaluate(setupRequestActions, roomNs)
  ])

  const requestIsEven = ([roomId, peerId, value]: [
    string,
    string,
    number
  ]): Promise<boolean> =>
    window[roomId]
      .makeAction('is-even', {kind: 'request'})
      .request(value, {target: peerId, timeoutMs: 1000})

  expect(
    await page.evaluate(requestIsEven, [roomNs, peer2Id, 42] satisfies [
      string,
      string,
      number
    ])
  ).toEqual(true)
  expect(
    await page2.evaluate(requestIsEven, [roomNs, peer1Id, 41] satisfies [
      string,
      string,
      number
    ])
  ).toEqual(false)

  const requestRejects = ([roomId, peerId]: [
    string,
    string
  ]): Promise<string> =>
    window[roomId]
      .makeAction('request-rejects', {kind: 'request'})
      .request('please', {target: peerId, timeoutMs: 1000})
      .then(
        () => 'resolved',
        (err: Error | null | undefined) => String(err?.message ?? err)
      )

  expect(
    await page.evaluate(requestRejects, [roomNs, peer2Id] satisfies [
      string,
      string
    ])
  ).toMatch(/request denied/)

  const requestLate = ([roomId, peerId]: [string, string]): Promise<string> =>
    window[roomId]
      .makeAction('late-request', {kind: 'request'})
      .request('hello', {target: peerId, timeoutMs: 1000})

  const lateRequest = page.evaluate(requestLate, [roomNs, peer2Id] satisfies [
    string,
    string
  ])

  await new Promise(res => setTimeout(res, 50))
  await page2.evaluate((roomId: string) => {
    window[roomId]
      .makeAction('late-request', {
        kind: 'request'
      })
      .onRequest(() => 'hello back')
  }, roomNs)

  expect(await lateRequest).toEqual('hello back')

  const requestMany = ([roomId, peerId]: [string, string]): Promise<{
    seen: string[]
    results: Array<{peerId: string; status: string; value?: unknown}>
  }> => {
    const seen: string[] = []

    return window[roomId]
      .makeAction('is-even', {kind: 'request'})
      .requestMany(8, {
        targets: ['missing-peer', peerId],
        timeoutMs: 1000,
        onResult: (result: {status: string}) => seen.push(result.status)
      })
      .then(
        (
          results: Array<{peerId: string; status: string; value?: unknown}>
        ) => ({
          seen: seen.sort((a, b) => a.localeCompare(b)),
          results: results.map(({peerId, status, value}) => ({
            peerId,
            status,
            value
          }))
        })
      )
  }

  const many = await page.evaluate(requestMany, [roomNs, peer2Id] satisfies [
    string,
    string
  ])

  expect(many.results).toEqual([
    {peerId: 'missing-peer', status: 'disconnected'},
    {peerId: peer2Id, status: 'fulfilled', value: true}
  ])
  expect(many.seen).toEqual(['disconnected', 'fulfilled'])

  const abortRequest = ([roomId, peerId]: [string, string]): Promise<
    string | undefined
  > => {
    const controller = new AbortController()
    const result = window[roomId]
      .makeAction('slow-request', {kind: 'request'})
      .request('later', {
        target: peerId,
        signal: controller.signal
      })
      .then(
        () => 'resolved',
        (err: {name?: string} | null | undefined) => err?.name
      )

    controller.abort()

    return result
  }

  expect(
    await page.evaluate(abortRequest, [roomNs, peer2Id] satisfies [
      string,
      string
    ])
  ).toEqual('AbortError')
}

const verifyActionIsolation = async ({
  page,
  page2,
  roomConfig,
  roomNs
}: {
  page: Page
  page2: Page
  roomConfig: StrategyConfig
  roomNs: string
}): Promise<void> => {
  const isolatedRoomA = roomNs + '-isolation-a'
  const isolatedRoomB = roomNs + '-isolation-b'

  const evaluateActionIsolation = ([roomA, roomB, config, label]: [
    string,
    string,
    StrategyConfig,
    string
  ]) => {
    const roomARef = window.trystero.joinRoom(config, roomA)
    const roomBRef = window.trystero.joinRoom(config, roomB)
    window[roomA] = roomARef
    window[roomB] = roomBRef

    const sharedA = roomARef.makeAction('shared')
    const sharedB = roomBRef.makeAction('shared')

    return Promise.all([
      new Promise<string>(res =>
        roomARef.onPeerJoin(({peerId}: {peerId: string}) => res(peerId), {
          once: true
        })
      ),
      new Promise<string>(res =>
        roomBRef.onPeerJoin(({peerId}: {peerId: string}) => res(peerId), {
          once: true
        })
      )
    ]).then(([peerA, peerB]) =>
      Promise.all([
        new Promise(res =>
          sharedA.onMessage((data: unknown) => res(data), {once: true})
        ),
        new Promise(res =>
          sharedB.onMessage((data: unknown) => res(data), {once: true})
        ),
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
    ] satisfies [string, string, StrategyConfig, string]),
    page2.evaluate(evaluateActionIsolation, [
      isolatedRoomA,
      isolatedRoomB,
      roomConfig,
      'page-2'
    ] satisfies [string, string, StrategyConfig, string])
  ])

  expect(isolationResult1).toEqual({
    receivedA: {room: isolatedRoomA, from: 'page-2'},
    receivedB: {room: isolatedRoomB, from: 'page-2'}
  })
  expect(isolationResult2).toEqual({
    receivedA: {room: isolatedRoomA, from: 'page-1'},
    receivedB: {room: isolatedRoomB, from: 'page-1'}
  })

  const leaveRoom = (roomId: string): Promise<void> | undefined =>
    window[roomId]?.leave()

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
}: RoomPairParams): Promise<void> => {
  const makeBinaryAction = ([roomId, message, metadata]: [
    string,
    string,
    Record<string, string>
  ]): Promise<BinaryActionResult> => {
    const binaryAction = window[roomId].makeAction('binary')

    let senderPercent = 0
    let receiverPercent = 0
    let senderCallCount = 0
    let receiverCallCount = 0

    binaryAction.onReceiveProgress((p: number) => {
      receiverPercent = p
      receiverCallCount++
    })

    return Promise.all([
      new Promise<[string, unknown]>(res => {
        binaryAction.onMessage(
          (
            payload: Uint8Array,
            {metadata: receivedMeta}: {metadata?: unknown}
          ) =>
            res([
              new TextDecoder().decode(payload).slice(-message.length),
              receivedMeta
            ]),
          {once: true}
        )
      }),

      new Promise(res => setTimeout(res, 1233)).then(() =>
        binaryAction.send(new TextEncoder().encode(message.repeat(50000)), {
          metadata,
          onProgress: (p: number) => {
            senderPercent = p
            senderCallCount++
          }
        })
      )
    ]).then(([received]): BinaryActionResult => {
      const [payload, meta] = received

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
    page.evaluate(makeBinaryAction, [roomNs, peer1Id, mockMeta] satisfies [
      string,
      string,
      Record<string, string>
    ]),
    page2.evaluate(makeBinaryAction, [roomNs, peer2Id, mockMeta] satisfies [
      string,
      string,
      Record<string, string>
    ])
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
    expect(senderCallCount).toBeGreaterThan(1)
    expect(receiverPercent).toEqual(senderPercent)
    expect(receiverCallCount).toEqual(senderCallCount)
  })
}
