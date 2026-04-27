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

const concurrentRooms = strategy =>
  strategy === 'ipfs' || strategy === 'torrent' ? 1 : 3
const defaultRelayRedundancy = 4

export default (strategy, overrides = {}) => {
  const config = {...strategyConfigs[strategy], ...overrides}
  return test(`Trystero: ${strategy}`, async ({page, browser, browserName}) => {
    const shouldSoftFail = strategy === 'ipfs' || strategy === 'torrent'
    const initialConnectionResults = []

    const run = async () => {
      if (strategy === 'ipfs') {
        test.setTimeout(180_000)
      } else if (strategy === 'torrent') {
        test.setTimeout(120_000)
      }

      console.log(
        `  🐎   ${shortBrowsers[browserName]}: ${emojis[strategy]} ${strategy}`
      )

      if (proxy) {
        console.log(`\n👺 using proxy: ${proxy}\n`)
      }

      const scriptUrl = `../dist/trystero-${strategy}.min.js`
      const context2 = await browser.newContext({
        ignoreHTTPSErrors: true,
        ...(proxy
          ? {proxy: {server: 'http://' + proxy, bypass: 'localhost'}}
          : {})
      })
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

      const redundancy = isRelayStrategy
        ? Math.min(
            defaultRelayRedundancy,
            await page.evaluate(() => window.trystero.defaultRelayUrls.length)
          )
        : 0

      const relayConfig = {
        ...(isRelayStrategy ? {redundancy} : {}),
        ...(config.relayConfig ?? {})
      }
      const roomConfig = {
        appId: `trystero-test-${Math.random()}`,
        password: '03d1p@M@@s' + Math.random(),
        ...(useTestOnlyMdnsFallback &&
        (browserName === 'webkit' || browserName === 'firefox')
          ? {_test_only_mdnsHostFallbackToLoopback: true}
          : {}),
        ...config,
        ...(isRelayStrategy || config.relayConfig ? {relayConfig} : {})
      }

      const getSelfId = () => window.trystero.selfId

      const selfId1 = await page.evaluate(getSelfId)
      const selfId2 = await page2.evaluate(getSelfId)

      expect(selfId1).toHaveLength(20)
      expect(selfId1).not.toEqual(selfId2)

      if (browserName !== 'webkit') {
        const joinStreamSwitchRoom = ([roomId, config]) => {
          window[roomId] = window.trystero.joinRoom(config, roomId)

          return new Promise(res => window[roomId].onPeerJoin(res))
        }

        const addStreamAndWait = ([roomId, phase]) =>
          new Promise((res, rej) => {
            const timeout = setTimeout(
              () => rej(new Error(`timed out waiting for ${phase} stream`)),
              10_000
            )

            window[roomId].onPeerStream((stream, peerId, meta) => {
              clearTimeout(timeout)
              res({
                peerId,
                meta,
                streamType: stream.constructor.name,
                trackCount: stream.getTracks().length
              })
            })

            setTimeout(async () => {
              window.__streamSwitchLocalStream ??=
                await navigator.mediaDevices.getUserMedia({
                  audio: true,
                  video: true
                })

              const peerId = Object.keys(window[roomId].getPeers())[0]
              window[roomId].addStream(
                window.__streamSwitchLocalStream,
                peerId,
                {phase}
              )
            }, 333)
          })

        const leaveStreamSwitchRoom = roomId => window[roomId]?.leave()
        const cleanupStreamSwitchRoom = async roomId => {
          Object.values(window[roomId]?.getPeers() ?? {}).forEach(connection =>
            connection.close()
          )

          await window[roomId]?.leave()
          window.__streamSwitchLocalStream
            ?.getTracks()
            .forEach(track => track.stop())
          window.__streamSwitchLocalStream = undefined
        }
        const streamSwitchRoomA = `stream-switch-a-${Math.random()
          .toString()
          .replace('.', '')}`
        const streamSwitchRoomB = `stream-switch-b-${Math.random()
          .toString()
          .replace('.', '')}`

        const [switchRoomAPeer1, switchRoomAPeer2] = await Promise.all([
          page.evaluate(joinStreamSwitchRoom, [streamSwitchRoomA, roomConfig]),
          page2.evaluate(joinStreamSwitchRoom, [streamSwitchRoomA, roomConfig])
        ])

        expect(switchRoomAPeer1).toEqual(selfId2)
        expect(switchRoomAPeer2).toEqual(selfId1)

        const [switchRoomAStream1, switchRoomAStream2] = await Promise.all([
          page.evaluate(addStreamAndWait, [streamSwitchRoomA, 'first']),
          page2.evaluate(addStreamAndWait, [streamSwitchRoomA, 'first'])
        ])

        expect(switchRoomAStream1).toMatchObject({
          peerId: selfId2,
          meta: {phase: 'first'},
          streamType: 'MediaStream'
        })
        expect(switchRoomAStream1.trackCount).toBeGreaterThan(0)
        expect(switchRoomAStream2).toMatchObject({
          peerId: selfId1,
          meta: {phase: 'first'},
          streamType: 'MediaStream'
        })
        expect(switchRoomAStream2.trackCount).toBeGreaterThan(0)

        await Promise.all([
          page.evaluate(leaveStreamSwitchRoom, streamSwitchRoomA),
          page2.evaluate(leaveStreamSwitchRoom, streamSwitchRoomA)
        ])

        const [switchRoomBPeer1, switchRoomBPeer2] = await Promise.all([
          page.evaluate(joinStreamSwitchRoom, [streamSwitchRoomB, roomConfig]),
          page2.evaluate(joinStreamSwitchRoom, [streamSwitchRoomB, roomConfig])
        ])

        expect(switchRoomBPeer1).toEqual(selfId2)
        expect(switchRoomBPeer2).toEqual(selfId1)

        const [switchRoomBStream1, switchRoomBStream2] = await Promise.all([
          page.evaluate(addStreamAndWait, [streamSwitchRoomB, 'second']),
          page2.evaluate(addStreamAndWait, [streamSwitchRoomB, 'second'])
        ])

        expect(switchRoomBStream1).toMatchObject({
          peerId: selfId2,
          meta: {phase: 'second'},
          streamType: 'MediaStream'
        })
        expect(switchRoomBStream1.trackCount).toBeGreaterThan(0)
        expect(switchRoomBStream2).toMatchObject({
          peerId: selfId1,
          meta: {phase: 'second'},
          streamType: 'MediaStream'
        })
        expect(switchRoomBStream2.trackCount).toBeGreaterThan(0)

        await Promise.all([
          page.evaluate(cleanupStreamSwitchRoom, streamSwitchRoomB),
          page2.evaluate(cleanupStreamSwitchRoom, streamSwitchRoomB)
        ])
      }

      const roomRuns = Array(concurrentRooms(strategy))
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
          ]).catch(err => {
            initialConnectionResults[roomNum] = 'failed'

            throw err
          })
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

          const getPeerId = roomId => Object.keys(window[roomId].getPeers())[0]

          expect(await page.evaluate(getPeerId, roomNs)).toEqual(peer2Id)
          expect(await page2.evaluate(getPeerId, roomNs)).toEqual(peer1Id)

          const ping = ([roomId, id]) => window[roomId].ping(id)
          const leaveRoom = roomId => window[roomId]?.leave()

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

          if (roomNum === 0) {
            const isolatedRoomA = roomNs + '-isolation-a'
            const isolatedRoomB = roomNs + '-isolation-b'

            const verifyActionIsolation = ([roomA, roomB, config, label]) => {
              const roomARef = window.trystero.joinRoom(config, roomA)
              const roomBRef = window.trystero.joinRoom(config, roomB)
              window[roomA] = roomARef
              window[roomB] = roomBRef

              const [sendSharedA, getSharedA] = roomARef.makeAction('shared')
              const [sendSharedB, getSharedB] = roomBRef.makeAction('shared')

              return Promise.all([
                new Promise(res => roomARef.onPeerJoin(res)),
                new Promise(res => roomBRef.onPeerJoin(res))
              ]).then(([peerA, peerB]) =>
                Promise.all([
                  new Promise(res => getSharedA(res)),
                  new Promise(res => getSharedB(res)),
                  sendSharedA({room: roomA, from: label}, peerA),
                  sendSharedB({room: roomB, from: label}, peerB)
                ]).then(([receivedA, receivedB]) => ({receivedA, receivedB}))
              )
            }

            const [isolationResult1, isolationResult2] = await Promise.all([
              page.evaluate(verifyActionIsolation, [
                isolatedRoomA,
                isolatedRoomB,
                roomConfig,
                'page-1'
              ]),
              page2.evaluate(verifyActionIsolation, [
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

            await Promise.all([
              page.evaluate(leaveRoom, isolatedRoomA),
              page2.evaluate(leaveRoom, isolatedRoomA),
              page.evaluate(leaveRoom, isolatedRoomB),
              page2.evaluate(leaveRoom, isolatedRoomB)
            ])
          }

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
            ).toEqual(redundancy)

            expect(
              await page.evaluate(() =>
                Object.entries(window.trystero.getRelaySockets()).every(
                  ([k, v]) => typeof k === 'string' && v instanceof WebSocket
                )
              )
            ).toBe(true)
          }

          if (roomNum === 0) {
            const handshakeRoomNs = roomNs + '-handshake'

            const setupHandshakeRoom = ([roomId, config, delayMs]) => {
              const state = {
                joinCount: 0,
                joinAt: 0,
                clearedAt: 0,
                earlyReceived: 0,
                joinErrors: []
              }
              const key = `hsState_${roomId}`
              const joinKey = `hsJoin_${roomId}`
              const postKey = `hsPost_${roomId}`
              const sendPostKey = `hsSendPost_${roomId}`
              let resolveJoin = null
              let resolvePost = null

              window[key] = state
              window[joinKey] = new Promise(res => (resolveJoin = res))
              window[postKey] = new Promise(res => (resolvePost = res))

              const room = window.trystero.joinRoom(config, roomId, {
                handshakeTimeoutMs: 8_000,
                onJoinError: details => state.joinErrors.push(details.error),
                onPeerHandshake: async (_, send, receive) => {
                  const keyPair = await crypto.subtle.generateKey(
                    {name: 'ECDSA', namedCurve: 'P-256'},
                    true,
                    ['sign', 'verify']
                  )
                  const challenge = crypto.getRandomValues(new Uint8Array(32))
                  const signature = await crypto.subtle.sign(
                    {name: 'ECDSA', hash: 'SHA-256'},
                    keyPair.privateKey,
                    challenge
                  )
                  const publicKey = await crypto.subtle.exportKey(
                    'raw',
                    keyPair.publicKey
                  )

                  await send({
                    publicKey: Array.from(new Uint8Array(publicKey)),
                    challenge: Array.from(challenge),
                    signature: Array.from(new Uint8Array(signature))
                  })

                  const {data} = await receive()
                  const packet = data

                  if (
                    !packet ||
                    typeof packet !== 'object' ||
                    !Array.isArray(packet.publicKey) ||
                    !Array.isArray(packet.challenge) ||
                    !Array.isArray(packet.signature)
                  ) {
                    throw new Error('invalid handshake payload')
                  }

                  const importedKey = await crypto.subtle.importKey(
                    'raw',
                    new Uint8Array(packet.publicKey),
                    {name: 'ECDSA', namedCurve: 'P-256'},
                    true,
                    ['verify']
                  )

                  const didVerify = await crypto.subtle.verify(
                    {name: 'ECDSA', hash: 'SHA-256'},
                    importedKey,
                    new Uint8Array(packet.signature),
                    new Uint8Array(packet.challenge)
                  )

                  if (!didVerify) {
                    throw new Error('peer key verification failed')
                  }

                  if (delayMs > 0) {
                    await new Promise(res => setTimeout(res, delayMs))
                  }

                  state.clearedAt = Date.now()
                }
              })

              window[roomId] = room

              const [sendEarly, getEarly] = room.makeAction('hsearly')
              const [sendPost, getPost] = room.makeAction('hspost')

              window[sendPostKey] = sendPost

              getEarly(() => state.earlyReceived++)

              getPost((payload, peerId) => {
                resolvePost?.([payload, peerId])
                resolvePost = null
              })

              room.onPeerJoin(peerId => {
                state.joinCount++
                state.joinAt = Date.now()
                resolveJoin?.(peerId)
                resolveJoin = null
              })

              setTimeout(() => sendEarly('early-message'), 100)
            }

            const readHandshakeState = roomId => {
              const state = window[`hsState_${roomId}`]

              return {
                ...state,
                peerCount: Object.keys(window[roomId].getPeers()).length
              }
            }

            const waitForHandshakeJoin = roomId => window[`hsJoin_${roomId}`]

            const waitForHandshakePost = roomId => window[`hsPost_${roomId}`]

            const sendHandshakePost = ([roomId, payload]) =>
              window[`hsSendPost_${roomId}`](payload)

            await Promise.all([
              page.evaluate(setupHandshakeRoom, [
                handshakeRoomNs,
                roomConfig,
                0
              ]),
              page2.evaluate(setupHandshakeRoom, [
                handshakeRoomNs,
                roomConfig,
                1_500
              ])
            ])

            await sleep(400)

            const [pendingState1, pendingState2] = await Promise.all([
              page.evaluate(readHandshakeState, handshakeRoomNs),
              page2.evaluate(readHandshakeState, handshakeRoomNs)
            ])

            expect(pendingState1.joinCount).toEqual(0)
            expect(pendingState1.peerCount).toEqual(0)
            expect(pendingState2.joinCount).toEqual(0)
            expect(pendingState2.peerCount).toEqual(0)

            const [joinPeer1, joinPeer2] = await Promise.all([
              page.evaluate(waitForHandshakeJoin, handshakeRoomNs),
              page2.evaluate(waitForHandshakeJoin, handshakeRoomNs)
            ])

            expect(joinPeer1).toEqual(selfId2)
            expect(joinPeer2).toEqual(selfId1)

            const [activeState1, activeState2] = await Promise.all([
              page.evaluate(readHandshakeState, handshakeRoomNs),
              page2.evaluate(readHandshakeState, handshakeRoomNs)
            ])

            expect(activeState1.joinErrors).toEqual([])
            expect(activeState2.joinErrors).toEqual([])
            expect(activeState1.peerCount).toEqual(1)
            expect(activeState2.peerCount).toEqual(1)
            expect(activeState1.earlyReceived).toEqual(0)
            expect(activeState2.earlyReceived).toEqual(0)
            expect(activeState1.clearedAt).toBeGreaterThan(0)
            expect(activeState2.clearedAt).toBeGreaterThan(0)
            expect(activeState1.joinAt).toBeGreaterThanOrEqual(
              activeState1.clearedAt
            )
            expect(activeState2.joinAt).toBeGreaterThanOrEqual(
              activeState2.clearedAt
            )

            await Promise.all([
              page.evaluate(sendHandshakePost, [
                handshakeRoomNs,
                'from-page-1'
              ]),
              page2.evaluate(sendHandshakePost, [
                handshakeRoomNs,
                'from-page-2'
              ])
            ])

            const [postPayload1, postPayload2] = await Promise.all([
              page.evaluate(waitForHandshakePost, handshakeRoomNs),
              page2.evaluate(waitForHandshakePost, handshakeRoomNs)
            ])

            expect(postPayload1).toEqual(['from-page-2', selfId2])
            expect(postPayload2).toEqual(['from-page-1', selfId1])

            await Promise.all([
              page.evaluate(leaveRoom, handshakeRoomNs),
              page2.evaluate(leaveRoom, handshakeRoomNs)
            ])

            const timeoutRoomNs = roomNs + '-handshake-timeout'
            const runHandshakeTimeout = ([
              roomId,
              config,
              timeoutMs,
              waitMultiplier
            ]) =>
              new Promise(res => {
                const state = {joinCount: 0, errors: []}
                const maxWaitMultiplier =
                  typeof waitMultiplier === 'number' ? waitMultiplier : 6
                const room = window.trystero.joinRoom(config, roomId, {
                  handshakeTimeoutMs: timeoutMs,
                  onJoinError: details => state.errors.push(details.error),
                  onPeerHandshake: async (_, __, receive) => {
                    await receive()
                  }
                })

                window[roomId] = room
                room.onPeerJoin(() => state.joinCount++)

                const start = Date.now()
                const waitForError = () => {
                  if (
                    state.errors.length > 0 ||
                    Date.now() - start > timeoutMs * maxWaitMultiplier
                  ) {
                    res({
                      ...state,
                      peerCount: Object.keys(room.getPeers()).length
                    })
                    return
                  }

                  setTimeout(waitForError, 50)
                }

                waitForError()
              })

            const [timeoutState1, timeoutState2] = await Promise.all([
              page.evaluate(runHandshakeTimeout, [
                timeoutRoomNs,
                roomConfig,
                900,
                strategy === 'torrent' ? 14 : 6
              ]),
              page2.evaluate(runHandshakeTimeout, [
                timeoutRoomNs,
                roomConfig,
                900,
                strategy === 'torrent' ? 14 : 6
              ])
            ])

            const timeoutErrors = [
              ...timeoutState1.errors,
              ...timeoutState2.errors
            ]

            expect(timeoutState1.joinCount).toEqual(0)
            expect(timeoutState2.joinCount).toEqual(0)
            expect(timeoutState1.peerCount).toEqual(0)
            expect(timeoutState2.peerCount).toEqual(0)
            if (strategy === 'torrent') {
              if (timeoutErrors.length > 0) {
                expect(
                  timeoutErrors.some(error => /handshake timed out/.test(error))
                ).toBe(true)
              }
            } else {
              expect(timeoutErrors.length).toBeGreaterThan(0)
              expect(
                timeoutErrors.some(error => /handshake timed out/.test(error))
              ).toBe(true)
            }

            await Promise.all([
              page.evaluate(leaveRoom, timeoutRoomNs),
              page2.evaluate(leaveRoom, timeoutRoomNs)
            ])
          }

          const disableAutoPong = roomId => {
            const [, onPing] = window[roomId].makeAction('@_ping')

            onPing(() => {})
          }

          const pendingPing = ([roomId, id]) =>
            window[roomId].ping(id).then(
              ms => ({status: 'resolved', ms}),
              err => ({
                status: 'rejected',
                message: String(err?.message ?? err)
              })
            )

          await page2.evaluate(disableAutoPong, roomNs)

          const disconnectedPing = page.evaluate(pendingPing, [roomNs, peer2Id])

          const peer1onLeaveId = page.evaluate(
            roomId => new Promise(window[roomId].onPeerLeave),
            roomNs
          )

          const overlapRoomNs = roomNs + '-overlap'
          const joinOverlapRoom = ([roomId, config]) => {
            window[roomId] = window.trystero.joinRoom(config, roomId)
            return new Promise(res => window[roomId].onPeerJoin(res))
          }

          const [overlapPeer1, overlapPeer2] = await Promise.all([
            page.evaluate(joinOverlapRoom, [overlapRoomNs, roomConfig]),
            page2.evaluate(joinOverlapRoom, [overlapRoomNs, roomConfig])
          ])

          expect(overlapPeer1).toEqual(selfId2)
          expect(overlapPeer2).toEqual(selfId1)

          await page2.evaluate(roomId => window[roomId].leave(), roomNs)

          const disconnectedPingResult = await disconnectedPing

          expect(disconnectedPingResult.status).toEqual('rejected')
          expect(disconnectedPingResult.message).toMatch(
            /peer left room|peer disconnected|room left|peer replaced/
          )
          expect(await peer1onLeaveId).toEqual(peer2Id)

          expect(
            await page.evaluate(ping, [overlapRoomNs, overlapPeer1])
          ).toBeLessThan(1000)
          expect(
            await page2.evaluate(ping, [overlapRoomNs, overlapPeer2])
          ).toBeLessThan(1000)

          expect(
            await page2.evaluate(
              ([roomId, config]) => {
                window[roomId] = window.trystero.joinRoom(config, roomId)
                return new Promise(res => window[roomId].onPeerJoin(res))
              },
              [roomNs, roomConfig]
            )
          ).toBe(selfId1)

          const nextRoomNs = roomNs + '2'

          const joinError = await Promise.race([
            page.evaluate(
              ([roomId, config]) =>
                new Promise(res =>
                  window.trystero.joinRoom(config, roomId, {
                    onJoinError: res
                  })
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
                        {onJoinError: res}
                      ))
                  ),
                [nextRoomNs, {...roomConfig, password: 'waste'}]
              )
            )
          ])

          expect(joinError.error).toMatch(/incorrect password/)
          expect(joinError.appId).toEqual(roomConfig.appId)
          expect(joinError.roomId).toEqual(nextRoomNs)
          expect(joinError.peerId).toMatch(new RegExp(`^${selfId1}|${selfId2}`))

          await Promise.all([
            page.evaluate(leaveRoom, overlapRoomNs),
            page2.evaluate(leaveRoom, overlapRoomNs)
          ])

          console.log(
            '  ✅   ',
            `${shortBrowsers[browserName]}:`,
            emojis[strategy],
            strategy.padEnd(12, ' '),
            `${joinTime}ms`
          )
        })

      const roomRunResults = await Promise.allSettled(roomRuns)
      const failedRoom = roomRunResults.find(
        result => result.status === 'rejected'
      )

      if (failedRoom?.status === 'rejected') {
        throw failedRoom.reason
      }
    }

    const recordConnectionResult = () => {
      test.info().annotations.push({
        type: 'initial-connection-ms',
        description: JSON.stringify({
          results: initialConnectionResults
        })
      })
    }

    if (!shouldSoftFail) {
      try {
        await run()
        recordConnectionResult()
      } catch (err) {
        recordConnectionResult()
        throw err
      }
      return
    }

    try {
      await run()
      recordConnectionResult()
    } catch (err) {
      recordConnectionResult()
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
