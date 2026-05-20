// @ts-nocheck
import {expect} from '@playwright/test'
import {sleep, withStrategyBrowserPair} from './harness'
import {
  joinEagerRoom,
  joinRoomAndWaitForPeer,
  leaveRoom,
  ping,
  rejoinRoomAndWaitForPeer
} from './room-helpers'

export const registerPeerLifecycleTests = (strategy, overrides) =>
  withStrategyBrowserPair(
    strategy,
    overrides,
    'peer leave, overlap rooms, and join errors',
    async ({joinPairWithRetry, page, page2, roomConfig, selfId1, selfId2}) => {
      const {roomId: roomNs, values} = await joinPairWithRetry({
        label: 'lifecycle seed room join',
        makeRoomId: () =>
          `lifecycle-seed-${Math.random().toString().replace('.', '')}`,
        join: joinEagerRoom,
        makeArgs: nextRoomId => [nextRoomId, roomConfig, 33]
      })
      const [peer2Data, peer1Data] = values
      const [peer2Id, peer1Id] = [peer2Data[1], peer1Data[1]]

      const disableAutoPong = roomId => {
        const pingAction = window[roomId].makeAction('@_ping')

        pingAction.onMessage = () => {}
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
        roomId => new Promise(res => (window[roomId].onPeerLeave = res)),
        roomNs
      )

      const overlapRoomNs = roomNs + '-overlap'

      const [overlapPeer1, overlapPeer2] = await Promise.all([
        page.evaluate(joinRoomAndWaitForPeer, [overlapRoomNs, roomConfig]),
        page2.evaluate(joinRoomAndWaitForPeer, [overlapRoomNs, roomConfig])
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
        await page2.evaluate(rejoinRoomAndWaitForPeer, [roomNs, roomConfig])
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
                  (window[roomId] = window.trystero.joinRoom(config, roomId, {
                    onJoinError: res
                  }))
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
        page2.evaluate(leaveRoom, overlapRoomNs),
        page.evaluate(leaveRoom, roomNs),
        page2.evaluate(leaveRoom, roomNs)
      ])

      expect(peer1Id).toEqual(selfId1)
    }
  )
