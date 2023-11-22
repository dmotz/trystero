import {test, expect} from '@playwright/test'

const strategies = ['firebase', 'torrent']
const testUrl = 'https://localhost:8080/test'
const testRoomConfig = {appId: 'trystero-94db3.firebaseio.com'}
const testRoomNs = 'testRoom'
const roomArgs = [testRoomConfig, testRoomNs]

strategies.forEach(strategy => {
  test(`Trystero: ${strategy}`, async ({page, context}) => {
    const scriptUrl = `../dist/trystero-${strategy}.min.js`
    const page2 = await context.newPage()

    await page.goto(testUrl)
    await page2.goto(testUrl)

    const loadLib = async path => (window.trystero = await import(path))

    await page.evaluate(loadLib, scriptUrl)
    await page2.evaluate(loadLib, scriptUrl)

    // selfId

    const getSelfId = () => window.trystero.selfId

    const selfId1 = await page.evaluate(getSelfId)
    const selfId2 = await page2.evaluate(getSelfId)

    expect(selfId1).toHaveLength(20)
    expect(selfId1).not.toEqual(selfId2)

    // onPeerJoin()

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

    // getPeers()

    const getPeerId = () => Object.keys(window.room.getPeers())[0]

    expect(await page.evaluate(getPeerId)).toEqual(peer2Id)
    expect(await page2.evaluate(getPeerId)).toEqual(peer1Id)

    // ping()

    const ping = id => window.room.ping(id)

    expect(await page.evaluate(ping, peer2Id)).toBeLessThan(100)
    expect(await page2.evaluate(ping, peer1Id)).toBeLessThan(100)

    // makeAction()

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

    // onPeerLeave()

    const peer1onLeaveId = page.evaluate(
      () => new Promise(window.room.onPeerLeave)
    )

    await page2.evaluate(() => window.room.leave())

    expect(await peer1onLeaveId).toEqual(peer2Id)
  })
})
