import {expect} from '@playwright/test'
import {internalActionPrefix} from '../../packages/core/src/utils.ts'
import type {StrategyConfig, StrategyName} from '../strategy-configs'
import {sleep, withStrategyBrowserPair} from './harness'
import {
  joinEagerRoom,
  joinRoomAndWaitForPeer,
  leaveRoom,
  ping,
  rejoinRoomAndWaitForPeer
} from './room-helpers'

type JoinErrorResult = {
  code: string
  message: string
  appId: string
  roomId: string
  peerId: string
}

export const registerPeerLifecycleTests = (
  strategy: StrategyName,
  overrides: StrategyConfig = {}
): void =>
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
        makeArgs: (nextRoomId): [string, StrategyConfig, number] => [
          nextRoomId,
          roomConfig,
          33
        ]
      })
      const [peer2Data, peer1Data] = values
      const [peer2Id, peer1Id] = [peer2Data[1], peer1Data[1]]

      const dropOutgoingPings = (prefix: string) => {
        const desc = Object.getOwnPropertyDescriptor(
          RTCDataChannel.prototype,
          'send'
        )!
        window['__origDcSendDesc'] = desc
        const pingHeader = new TextEncoder().encode(`${prefix}ping`)
        RTCDataChannel.prototype.send = function (
          data: string | Blob | ArrayBuffer | ArrayBufferView
        ) {
          const bytes =
            data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : ArrayBuffer.isView(data)
                ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
                : null
          if (
            bytes &&
            bytes.byteLength > 2 + pingHeader.byteLength &&
            pingHeader.every((b, i) => bytes[2 + i] === b) &&
            bytes[2 + pingHeader.byteLength] === 0
          ) {
            return
          }
          return (
            desc.value as (
              this: RTCDataChannel,
              d: string | Blob | ArrayBuffer | ArrayBufferView
            ) => void
          ).call(this, data)
        }
      }

      const restoreOutgoingPings = () => {
        if (window['__origDcSendDesc']) {
          Object.defineProperty(
            RTCDataChannel.prototype,
            'send',
            window['__origDcSendDesc'] as PropertyDescriptor
          )
          delete window['__origDcSendDesc']
        }
      }

      const pendingPing = ([roomId, id]: [string, string]): Promise<{
        status: string
        ms?: number
        message?: string
      }> =>
        window[roomId].ping(id).then(
          (ms: number) => ({status: 'resolved', ms}),
          (err: Error | null | undefined) => ({
            status: 'rejected',
            message: String(err?.message ?? err)
          })
        )

      await page.evaluate(dropOutgoingPings, internalActionPrefix)

      const disconnectedPing = page.evaluate(pendingPing, [
        roomNs,
        peer2Id
      ] satisfies [string, string])

      const peer1onLeaveId = page.evaluate(
        (roomId: string) =>
          new Promise<string>(res =>
            window[roomId].onPeerLeave(
              ({peerId}: {peerId: string}) => res(peerId),
              {once: true}
            )
          ),
        roomNs
      )

      const overlapRoomNs = roomNs + '-overlap'

      const [overlapPeer1, overlapPeer2] = await Promise.all([
        page.evaluate(joinRoomAndWaitForPeer, [
          overlapRoomNs,
          roomConfig
        ] satisfies [string, StrategyConfig]),
        page2.evaluate(joinRoomAndWaitForPeer, [
          overlapRoomNs,
          roomConfig
        ] satisfies [string, StrategyConfig])
      ])

      expect(overlapPeer1).toEqual(selfId2)
      expect(overlapPeer2).toEqual(selfId1)

      await page2.evaluate(roomId => window[roomId].leave(), roomNs)

      const disconnectedPingResult = await disconnectedPing
      await page.evaluate(restoreOutgoingPings)

      expect(disconnectedPingResult.status).toEqual('rejected')
      expect(disconnectedPingResult.message).toMatch(
        /peer left room|peer disconnected|room left|peer replaced/
      )
      expect(await peer1onLeaveId).toEqual(peer2Id)

      expect(
        await page.evaluate(ping, [overlapRoomNs, overlapPeer1] satisfies [
          string,
          string
        ])
      ).toBeLessThan(1000)
      expect(
        await page2.evaluate(ping, [overlapRoomNs, overlapPeer2] satisfies [
          string,
          string
        ])
      ).toBeLessThan(1000)

      expect(
        await page2.evaluate(rejoinRoomAndWaitForPeer, [
          roomNs,
          roomConfig
        ] satisfies [string, StrategyConfig])
      ).toBe(selfId1)

      const nextRoomNs = roomNs + '2'

      const joinError = await Promise.race([
        page.evaluate(
          ([roomId, config]: [string, StrategyConfig]) =>
            new Promise<JoinErrorResult>(res => {
              const room = window.trystero.joinRoom(config, roomId)
              room.onError(res, {once: true})
            }),
          [nextRoomNs, roomConfig] satisfies [string, StrategyConfig]
        ),

        sleep(3333).then(() =>
          page2.evaluate(
            ([roomId, config]: [string, StrategyConfig]) =>
              new Promise<JoinErrorResult>(res => {
                const room = (window[roomId] = window.trystero.joinRoom(
                  config,
                  roomId
                ))
                room.onError(res, {once: true})
              }),
            [nextRoomNs, {...roomConfig, password: 'waste'}] satisfies [
              string,
              StrategyConfig
            ]
          )
        )
      ])

      expect(joinError.code).toEqual('decrypt-failed')
      expect(joinError.message).toMatch(/incorrect password/)
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
