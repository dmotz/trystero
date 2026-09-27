import {expect} from '@playwright/test'
import {sleep, withStrategyBrowserPair} from './harness'
import {joinRoomAndWaitForPeer, leaveRoom, ping} from './room-helpers'

withStrategyBrowserPair(
  'ws-relay',
  {rtcConfig: {iceServers: []}},
  'idle peer leads with a fresh offer after the former offer TTL',
  async ({page, page2, roomConfig, selfId1, selfId2}) => {
    const [idlePage, freshPage] =
      selfId1 < selfId2 ? [page, page2] : [page2, page]
    const [idleId, freshId] =
      selfId1 < selfId2 ? [selfId1, selfId2] : [selfId2, selfId1]
    const roomId = `idle-offer-${Math.random()}`

    try {
      await idlePage.evaluate(
        ([roomId, config]) => {
          window[roomId] = window.trystero.joinRoom(config, roomId)
        },
        [roomId, roomConfig]
      )
      // Let any prewarmed native ICE gather, then advance only Date past its TTL.
      await sleep(250)
      await idlePage.clock.setFixedTime(Date.now() + 62_000)

      expect(
        await freshPage.evaluate(joinRoomAndWaitForPeer, [roomId, roomConfig])
      ).toBe(idleId)
      await expect
        .poll(() =>
          idlePage.evaluate(
            roomId => Object.keys(window[roomId].getPeers()),
            roomId
          )
        )
        .toEqual([freshId])
      expect(await idlePage.evaluate(ping, [roomId, freshId])).toBeLessThan(
        1000
      )
    } finally {
      await idlePage.clock.resume()
      await Promise.all([
        idlePage.evaluate(leaveRoom, roomId),
        freshPage.evaluate(leaveRoom, roomId)
      ])
    }
  }
)
