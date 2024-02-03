import {test, expect} from '@playwright/test'

const strategies = ['firebase', 'torrent', 'ipfs', 'mqtt']
const testUrl = 'https://localhost:8080/test'

const onConsole = n => async e => {
  const args = await Promise.all(e.args().map(a => a.jsonValue()))
  console.log(`page ${n}:`, ...args)
}

strategies.forEach(strategy => {
  test(`Trystero: ${strategy}`, async ({page, context, browserName}) => {
    const trackerRedundancy = 3
    const testRoomConfig = {
      appId:
        strategy === 'firebase'
          ? 'trystero-94db3.firebaseio.com'
          : `trystero-test-${Math.random()}`,
      ...(strategy === 'torrent' ? {trackerRedundancy} : {})
    }
    const testRoomNs = 'testRoom'
    const roomArgs = [testRoomConfig, testRoomNs]
    const scriptUrl = `../dist/trystero-${strategy}.min.js`
    const page2 = await context.newPage()

    page.on('console', onConsole(1))
    page2.on('console', onConsole(2))

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

    const joinRoom = ([config, room]) => {
      window.room = window.trystero.joinRoom(config, room)
      return new Promise(window.room.onPeerJoin)
    }

    const [peer2Id, peer1Id] = await Promise.all([
      page.evaluate(joinRoom, roomArgs),
      page2.evaluate(joinRoom, roomArgs)
    ])

    expect(peer1Id).toEqual(selfId1)
    expect(peer2Id).toEqual(selfId2)

    if (browserName !== 'webkit') {
      // # onPeerStream()

      const onPeerStream = () =>
        new Promise(res => {
          window.room.onPeerStream((_, peer) => res(peer))
          setTimeout(
            async () =>
              window.room.addStream(
                await navigator.mediaDevices.getUserMedia({
                  audio: true,
                  video: true
                })
              ),
            1000
          )
        })

      const [peer2StreamId, peer1StreamId] = await Promise.all([
        page.evaluate(onPeerStream),
        page2.evaluate(onPeerStream)
      ])

      expect(peer1StreamId).toEqual(peer1Id)
      expect(peer2StreamId).toEqual(peer2Id)
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

    if (strategy === 'torrent') {
      // # getTrackers()

      expect(
        await page.evaluate(
          () => Object.keys(window.trystero.getTrackers()).length
        )
      ).toEqual(trackerRedundancy)
    }

    // # onPeerLeave()

    const peer1onLeaveId = page.evaluate(
      () => new Promise(window.room.onPeerLeave)
    )

    await page2.evaluate(() => window.room.leave())

    expect(await peer1onLeaveId).toEqual(peer2Id)
  })
})
