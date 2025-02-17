import {test, expect} from '@playwright/test'
import chalk from 'chalk'

const testUrl = 'https://localhost:8080/test'
const proxy = process.env.PROXY

const logPrefix = (strategy, browser, pageN) =>
  `${emojis[strategy]} ${colorize[pageN - 1](strategy)} ${shortBrowsers[browser]}${pageN}:`

const onConsole = (strategy, browser, pageN) => msg =>
  console.log(logPrefix(strategy, browser, pageN), msg)

const onError = (strategy, browser, pageN) => err =>
  console.log('❌', logPrefix(strategy, browser, pageN), err)

const colorize = ['magenta', 'yellow', 'blue', 'red', 'green', 'cyan'].map(
  k => chalk[k]
)

const sleep = ms => new Promise(res => setTimeout(res, ms))

const concurrentRooms = 3
const relayRedundancy = 4

export default (strategy, config) =>
  test(`Trystero: ${strategy}`, async ({page, browser, browserName}) => {
    console.log(
      `  🐎   ${shortBrowsers[browserName]}: ${emojis[strategy]} ${strategy}`
    )

    if (proxy) {
      console.log(`\n👺 using proxy: ${proxy}\n`)
    }

    const isRelayStrategy =
      strategy === 'torrent' || strategy === 'nostr' || strategy === 'mqtt'

    const roomConfig = {
      appId: `trystero-test-${Math.random()}`,
      password: '03d1p@M@@s' + Math.random(),
      ...(isRelayStrategy ? {relayRedundancy} : {}),
      ...config
    }

    const scriptUrl = `../dist/trystero-${strategy}.min.js`
    const context = await browser.newContext(
      proxy ? {proxy: {server: 'http://' + proxy, bypass: 'localhost'}} : {}
    )
    const page2 = await context.newPage()

    page.on('console', onConsole(strategy, browserName, 1))
    page2.on('console', onConsole(strategy, browserName, 2))
    page.on('pageerror', onError(strategy, browserName, 1))
    page2.on('pageerror', onError(strategy, browserName, 2))

    await page.goto(testUrl)
    await page2.goto(testUrl)

    const loadLib = async path => (window.trystero = await import(path))

    await page.evaluate(loadLib, scriptUrl)
    await page2.evaluate(loadLib, scriptUrl)

    // # selfId

    const getSelfId = () => window.trystero.selfId

    const selfId1 = await page.evaluate(getSelfId)
    const selfId2 = await page2.evaluate(getSelfId)

    expect(selfId1).toHaveLength(20)
    expect(selfId1).not.toEqual(selfId2)

    await Promise.all(
      Array(concurrentRooms)
        .fill()
        .map(async (_, roomNum) => {
          const roomNs = `testRoom-${roomNum}-${Math.random().toString().replace('.', '')}`

          // # onPeerJoin()

          const eagerPayload = 33

          const joinRoom = ([roomId, config, payload]) => {
            window[roomId] = window.trystero.joinRoom(config, roomId)

            const [sendEager, getEager] = window[roomId].makeAction('eager')

            let didSend = false

            return new Promise(res => {
              getEager((...args) => res(args))
              window[roomId].onPeerJoin(peerId => {
                if (!didSend) {
                  sendEager(payload, peerId)
                  didSend = true
                }
              })
            })
          }

          const args = [roomNs, roomConfig, eagerPayload]
          const start = Date.now()
          const [peer2Data, peer1Data] = await Promise.all([
            page.evaluate(joinRoom, args),
            page2.evaluate(joinRoom, args)
          ])
          const joinTime = Date.now() - start
          const [peer2Id, peer1Id] = [peer2Data[1], peer1Data[1]]

          expect(peer1Data).toEqual([eagerPayload, selfId1])
          expect(peer2Data).toEqual([eagerPayload, selfId2])

          // # Idempotent joinRoom()

          const isRoomIdentical = await page.evaluate(
            ([roomId, config]) =>
              window.trystero.joinRoom(config, roomId) === window[roomId],
            [roomNs, roomConfig]
          )

          expect(isRoomIdentical).toBe(true)

          if (browserName !== 'webkit') {
            // # onPeerStream()

            const onPeerStream = ([roomId, streamMeta]) =>
              new Promise(res => {
                window[roomId].onPeerStream((stream, peerId, meta) =>
                  res({peerId, meta, streamType: stream.constructor.name})
                )

                setTimeout(async () => {
                  const stream = await navigator.mediaDevices.getUserMedia({
                    audio: true,
                    video: true
                  })
                  window[roomId].addStream(stream, null, streamMeta)
                }, 999)
              })

            const streamMeta = {id: Math.random()}
            const args = [roomNs, streamMeta]
            const [peer2StreamInfo, peer1StreamInfo] = await Promise.all([
              page.evaluate(onPeerStream, args),
              page2.evaluate(onPeerStream, args)
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

            // # onPeerTrack()

            const onPeerTrack = ([roomId, streamMeta]) =>
              new Promise(res => {
                window[roomId].onPeerTrack((track, stream, peerId, meta) =>
                  res({
                    peerId,
                    meta,
                    streamType: stream.constructor.name,
                    trackType: track.constructor.name
                  })
                )

                setTimeout(async () => {
                  const stream = await navigator.mediaDevices.getUserMedia({
                    audio: true,
                    video: true
                  })
                  window[roomId].addTrack(
                    stream.getTracks()[0],
                    stream,
                    null,
                    streamMeta
                  )
                }, 999)
              })

            const [peer2TrackInfo, peer1TrackInfo] = await Promise.all([
              page.evaluate(onPeerTrack, args),
              page2.evaluate(onPeerTrack, args)
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

          // # getPeers()

          const getPeerId = roomId => Object.keys(window[roomId].getPeers())[0]

          expect(await page.evaluate(getPeerId, roomNs)).toEqual(peer2Id)
          expect(await page2.evaluate(getPeerId, roomNs)).toEqual(peer1Id)

          // # ping()

          const ping = ([roomId, id]) => window[roomId].ping(id)

          expect(await page.evaluate(ping, [roomNs, peer2Id])).toBeLessThan(100)
          expect(await page2.evaluate(ping, [roomNs, peer1Id])).toBeLessThan(
            100
          )

          // # makeAction()

          const makeAction = ([roomId, message]) => {
            const [sendMessage, getMessage] =
              window[roomId].makeAction('message')

            return new Promise(res => {
              getMessage(res)
              setTimeout(() => sendMessage(message), 333)
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

          const makeBinaryAction = ([roomId, message, metadata]) => {
            const [sendBinary, getBinary, onProgress] =
              window[roomId].makeAction('binary')

            let senderPercent = 0
            let receiverPercent = 0
            let senderCallCount = 0
            let receiverCallCount = 0

            onProgress(p => {
              receiverPercent = p
              receiverCallCount++
            })

            return Promise.all([
              new Promise(res =>
                getBinary((payload, _, receivedMeta) =>
                  res([
                    new TextDecoder().decode(payload).slice(-message.length),
                    receivedMeta
                  ])
                )
              ),

              new Promise(res => setTimeout(res, 1233)).then(() =>
                sendBinary(
                  new TextEncoder().encode(message.repeat(50000)),
                  null,
                  metadata,
                  p => {
                    senderPercent = p
                    senderCallCount++
                  }
                )
              )
            ]).then(([[payload, meta]]) => [
              payload,
              meta,
              senderPercent,
              senderCallCount,
              receiverPercent,
              receiverCallCount
            ])
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

          if (strategy === 'firebase') {
            // # getOccupants()

            expect(
              (
                await page.evaluate(
                  ([roomId, config]) =>
                    window.trystero.getOccupants(config, roomId),
                  [roomNs, roomConfig]
                )
              ).length
            ).toEqual(2)
          }

          if (isRelayStrategy) {
            // # getRelaySockets()

            expect(
              await page.evaluate(
                () => Object.keys(window.trystero.getRelaySockets()).length
              )
            ).toEqual(relayRedundancy)

            expect(
              await page.evaluate(() =>
                Object.entries(window.trystero.getRelaySockets()).every(
                  ([k, v]) => typeof k === 'string' && v instanceof WebSocket
                )
              )
            ).toBe(true)
          }

          // # onPeerLeave()

          const peer1onLeaveId = page.evaluate(
            roomId => new Promise(window[roomId].onPeerLeave),
            roomNs
          )

          await page2.evaluate(roomId => window[roomId].leave(), roomNs)

          expect(await peer1onLeaveId).toEqual(peer2Id)

          // # Rejoin

          expect(
            await page2.evaluate(
              ([roomId, config]) => {
                window[roomId] = window.trystero.joinRoom(config, roomId)
                return new Promise(res => window[roomId].onPeerJoin(res))
              },
              [roomNs, roomConfig]
            )
          ).toBe(selfId1)

          // @TODO: torrent strategy often times out on this test, to investigate
          if (strategy !== 'torrent') {
            // # Incorrect password

            const nextRoomNs = roomNs + '2'

            const joinError = await Promise.race([
              page.evaluate(
                ([roomId, config]) =>
                  new Promise(res =>
                    window.trystero.joinRoom(config, roomId, res)
                  ),
                [nextRoomNs, roomConfig]
              ),

              sleep(3333).then(() =>
                page2.evaluate(
                  ([roomId, config]) =>
                    new Promise(
                      res =>
                        (window[roomId] = window.trystero.joinRoom(
                          config,
                          roomId,
                          res
                        ))
                    ),
                  [nextRoomNs, {...roomConfig, password: 'waste'}]
                )
              )
            ])

            expect(joinError.error).toMatch(/^incorrect password/)
            expect(joinError.appId).toEqual(roomConfig.appId)
            expect(joinError.roomId).toEqual(nextRoomNs)
            expect(joinError.peerId).toMatch(
              new RegExp(`^${selfId1}|${selfId2}`)
            )
          }

          console.log(
            '  ⏱️   ',
            `${shortBrowsers[browserName]}:`,
            emojis[strategy],
            strategy.padEnd(12, ' '),
            `${joinTime}ms`
          )
        })
    )
  })

const emojis = {
  nostr: '🐦',
  mqtt: '📡',
  torrent: '🌊',
  supabase: '⚡️',
  firebase: '🔥',
  ipfs: '🪐'
}

const shortBrowsers = {
  chromium: chalk.green('CH'),
  webkit: chalk.blue('WK'),
  firefox: chalk.yellow('FF')
}
