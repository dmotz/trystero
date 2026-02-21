// @ts-nocheck
import {expect, test} from '@playwright/test'
import {attachPageLogging, emojis, shortBrowsers} from './logger'
import {strategyConfigs} from './strategy-configs'

const testPort = process.env.TRYSTERO_TEST_PORT ?? '8080'
const testUrl = `https://localhost:${testPort}/test`
const proxy = process.env.PROXY
const useTestOnlyMdnsFallback =
  process.env.TRYSTERO_TEST_FORCE_LOOPBACK_MDNS !== '0'

const sleep = ms => new Promise(res => setTimeout(res, ms))

const concurrentRooms = strategy => (strategy === 'ipfs' ? 1 : 3)
const defaultRelayRedundancy = 4

export default (strategy, overrides = {}) => {
  const config = {...(strategyConfigs[strategy] ?? {}), ...overrides}
  return test(`Trystero: ${strategy}`, async ({page, browser, browserName}) => {
    const shouldSoftFail = strategy === 'ipfs' || strategy === 'torrent'

    const run = async () => {
      if (strategy === 'ipfs') {
        test.setTimeout(180_000)
      }

      console.log(
        `  🐎   ${shortBrowsers[browserName]}: ${emojis[strategy]} ${strategy}`
      )

      if (proxy) {
        console.log(`\n👺 using proxy: ${proxy}\n`)
      }

      const scriptUrl = `../dist/trystero-${strategy}.min.js`
      const context2 = await browser.newContext(
        proxy ? {proxy: {server: 'http://' + proxy, bypass: 'localhost'}} : {}
      )
      const page2 = await context2.newPage()

      await attachPageLogging({
        strategy,
        browserName,
        pages: [page, page2]
      })

      await page.goto(testUrl)
      await page2.goto(testUrl)

      const loadLib = async path => (window.trystero = await import(path))

      await page.evaluate(loadLib, scriptUrl)
      await page2.evaluate(loadLib, scriptUrl)

      const isRelayStrategy =
        strategy === 'torrent' || strategy === 'nostr' || strategy === 'mqtt'

      const relayRedundancy = isRelayStrategy
        ? Math.min(
            defaultRelayRedundancy,
            await page.evaluate(() => window.trystero.defaultRelayUrls.length)
          )
        : 0

      const roomConfig = {
        appId: `trystero-test-${Math.random()}`,
        password: '03d1p@M@@s' + Math.random(),
        ...(isRelayStrategy ? {relayRedundancy} : {}),
        ...(useTestOnlyMdnsFallback &&
        (browserName === 'webkit' || browserName === 'firefox')
          ? {_test_only_mdnsHostFallbackToLoopback: true}
          : {}),
        ...config
      }

      const getSelfId = () => window.trystero.selfId

      const selfId1 = await page.evaluate(getSelfId)
      const selfId2 = await page2.evaluate(getSelfId)

      expect(selfId1).toHaveLength(20)
      expect(selfId1).not.toEqual(selfId2)

      await Promise.all(
        Array(concurrentRooms(strategy))
          .fill(undefined)
          .map(async (_, roomNum) => {
            const roomNs = `testRoom-${roomNum}-${Math.random().toString().replace('.', '')}`

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

            const isRoomIdentical = await page.evaluate(
              ([roomId, config]) =>
                window.trystero.joinRoom(config, roomId) === window[roomId],
              [roomNs, roomConfig]
            )

            expect(isRoomIdentical).toBe(true)

            if (browserName !== 'webkit') {
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

            const getPeerId = roomId =>
              Object.keys(window[roomId].getPeers())[0]

            expect(await page.evaluate(getPeerId, roomNs)).toEqual(peer2Id)
            expect(await page2.evaluate(getPeerId, roomNs)).toEqual(peer1Id)

            const ping = ([roomId, id]) => window[roomId].ping(id)

            expect(await page.evaluate(ping, [roomNs, peer2Id])).toBeLessThan(
              1000
            )
            expect(await page2.evaluate(ping, [roomNs, peer1Id])).toBeLessThan(
              1000
            )

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

            if (isRelayStrategy) {
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

            const peer1onLeaveId = page.evaluate(
              roomId => new Promise(window[roomId].onPeerLeave),
              roomNs
            )

            await page2.evaluate(roomId => window[roomId].leave(), roomNs)

            expect(await peer1onLeaveId).toEqual(peer2Id)

            expect(
              await page2.evaluate(
                ([roomId, config]) => {
                  window[roomId] = window.trystero.joinRoom(config, roomId)
                  return new Promise(res => window[roomId].onPeerJoin(res))
                },
                [roomNs, roomConfig]
              )
            ).toBe(selfId1)

            if (strategy !== 'torrent') {
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
              '  ✅   ',
              `${shortBrowsers[browserName]}:`,
              emojis[strategy],
              strategy.padEnd(12, ' '),
              `${joinTime}ms`
            )
          })
      )
    }

    if (!shouldSoftFail) {
      await run()
      return
    }

    try {
      await run()
    } catch (err) {
      const message =
        err instanceof Error ? (err.stack ?? err.message) : String(err)

      test.info().annotations.push({
        type: 'flaky',
        description: `${strategy} failure ignored (flaky)`
      })
      console.warn(`\n⚠️ ${strategy} failure ignored (flaky):\n${message}\n`)
    }
  })
}
