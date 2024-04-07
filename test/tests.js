import {test, expect} from '@playwright/test'
import chalk from 'chalk'

const testUrl = 'https://localhost:8080/test'

const onConsole = (strategy, pageN) => e =>
  console.log(`${colorize[pageN - 1](strategy)} #${pageN}:`, e)

const onError = (strategy, pageN) => err =>
  console.log(`❌ error! ${strategy} #${pageN}:`, err)

const colorize = ['magenta', 'yellow', 'blue', 'red', 'green', 'cyan'].map(
  k => chalk[k]
)

export default strategy =>
  test(`Trystero: ${strategy}`, async ({page, context, browserName}) => {
    const isRelayStrategy =
      strategy === 'torrent' || strategy === 'nostr' || strategy === 'mqtt'

    const relayRedundancy = 3
    const testRoomConfig = {
      appId:
        strategy === 'firebase'
          ? 'trystero-94db3.firebaseio.com'
          : `trystero-test-${Math.random()}`,
      ...(isRelayStrategy ? {relayRedundancy} : {})
    }
    const testRoomNs = `testRoom-${Math.random().toString().replace('.', '')}`
    const roomArgs = [testRoomConfig, testRoomNs]
    const scriptUrl = `../dist/trystero-${strategy}.min.js`
    const page2 = await context.newPage()

    page.on('console', onConsole(strategy, 1))
    page2.on('console', onConsole(strategy, 2))
    page.on('pageerror', onError(strategy, 1))
    page2.on('pageerror', onError(strategy, 2))

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

    // # onPeerJoin()

    const eagerPayload = 33

    const joinRoom = ([config, room, payload]) => {
      window.room = window.trystero.joinRoom(config, room)

      const [sendEager, getEager] = window.room.makeAction('eager')

      return new Promise(res => {
        getEager((...args) => res(args))
        window.room.onPeerJoin(peerId => sendEager(payload, peerId))
      })
    }

    const args = roomArgs.concat(eagerPayload)
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
      ([config, room]) =>
        window.trystero.joinRoom(config, room) === window.room,
      roomArgs
    )

    expect(isRoomIdentical).toBe(true)

    if (browserName !== 'webkit') {
      // # onPeerStream()

      const onPeerStream = streamMeta =>
        new Promise(res => {
          window.room.onPeerStream((_, peerId, meta) => res({peerId, meta}))

          setTimeout(async () => {
            const stream = await navigator.mediaDevices.getUserMedia({
              audio: true,
              video: true
            })
            window.room.addStream(stream, null, streamMeta)
            window.mediaStream = stream
          }, 1000)
        })

      const streamMeta = {id: Math.random()}
      const [peer2StreamInfo, peer1StreamInfo] = await Promise.all([
        page.evaluate(onPeerStream, streamMeta),
        page2.evaluate(onPeerStream, streamMeta)
      ])

      expect(peer1StreamInfo).toEqual({peerId: peer1Id, meta: streamMeta})
      expect(peer2StreamInfo).toEqual({peerId: peer2Id, meta: streamMeta})
    }

    // # getPeers()

    const getPeerId = () => Object.keys(window.room.getPeers())[0]

    expect(await page.evaluate(getPeerId)).toEqual(peer2Id)
    expect(await page2.evaluate(getPeerId)).toEqual(peer1Id)

    // # ping()

    const ping = id => window.room.ping(id)

    expect(await page.evaluate(ping, peer2Id)).toBeLessThan(100)
    expect(await page2.evaluate(ping, peer1Id)).toBeLessThan(100)

    // # makeAction()

    const makeAction = message => {
      const [sendMessage, getMessage] = window.room.makeAction('message')

      return new Promise(res => {
        getMessage(res)
        setTimeout(() => sendMessage(message), 1000)
      })
    }

    const message1 = Math.random()
    const message2 = Math.random()

    const [receivedMessage1, receivedMessage2] = await Promise.all([
      page.evaluate(makeAction, message1),
      page2.evaluate(makeAction, message2)
    ])

    expect(receivedMessage1).toEqual(message2)
    expect(receivedMessage2).toEqual(message1)

    const empty = ''

    const [receivedMessage3, receivedMessage4] = await Promise.all([
      page.evaluate(makeAction, empty),
      page2.evaluate(makeAction, empty)
    ])

    expect(receivedMessage3).toEqual(empty)
    expect(receivedMessage4).toEqual(empty)

    const makeBinaryAction = ([message, metadata]) => {
      const [sendBinary, getBinary, onProgress] =
        window.room.makeAction('binary')

      let senderPercent = 0
      let receiverPercent = 0
      let senderCallCount = 0
      let receiverCallCount = 0

      return new Promise(res => {
        getBinary((payload, _, receivedMeta) =>
          res([
            new TextDecoder().decode(payload).slice(-20),
            receivedMeta,
            senderPercent,
            senderCallCount,
            receiverPercent,
            receiverCallCount
          ])
        )

        onProgress(p => {
          receiverPercent = p
          receiverCallCount++
        })

        setTimeout(
          () =>
            sendBinary(
              new TextEncoder().encode(message.repeat(50000)),
              null,
              metadata,
              p => {
                senderPercent = p
                senderCallCount++
              }
            ),
          1000
        )
      })
    }

    const mockMeta = {foo: 'bar', baz: 'qux'}

    const payloads = await Promise.all([
      page.evaluate(makeBinaryAction, [peer1Id, mockMeta]),
      page2.evaluate(makeBinaryAction, [peer2Id, mockMeta])
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
            ([config, ns]) => window.trystero.getOccupants(config, ns),
            roomArgs
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
      () => new Promise(window.room.onPeerLeave)
    )

    await page2.evaluate(() => window.room.leave())

    expect(await peer1onLeaveId).toEqual(peer2Id)

    console.log(`  ⏱️    ${strategy.padEnd(12, ' ')} ${joinTime}ms`)
  })
