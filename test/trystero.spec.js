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
    const getPeerIds = () => Object.keys(window.room.getPeers())

    const [peer1Ids, peer2Ids] = await Promise.all([
      page.evaluate(getPeerIds),
      page2.evaluate(getPeerIds)
    ])

    expect(peer1Ids[0]).toEqual(peer2Id)
    expect(peer2Ids[0]).toEqual(peer1Id)

    // onPeerLeave()
    const peer1onLeaveId = page.evaluate(
      () => new Promise(window.room.onPeerLeave)
    )

    await page2.evaluate(() => window.room.leave())

    expect(await peer1onLeaveId).toEqual(peer2Id)
  })
})
