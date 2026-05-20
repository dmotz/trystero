// @ts-nocheck
import {expect} from '@playwright/test'
import {withStrategyBrowserPair} from './harness'

export const registerMediaSwitchTests = (strategy, overrides) =>
  withStrategyBrowserPair(
    strategy,
    overrides,
    'media survives room switching',
    async ({joinPairWithRetry, page, page2, roomConfig, selfId1, selfId2}) => {
      const joinStreamSwitchRoom = ([roomId, config]) => {
        window[roomId] = window.trystero.joinRoom(config, roomId)

        return new Promise(res => (window[roomId].onPeerJoin = res))
      }

      const addStreamAndWait = ([roomId, phase]) =>
        new Promise((res, rej) => {
          const timeout = setTimeout(
            () => rej(new Error(`timed out waiting for ${phase} stream`)),
            10_000
          )

          window[roomId].onPeerStream = (stream, peerId, meta) => {
            clearTimeout(timeout)
            res({
              peerId,
              meta,
              streamType: stream.constructor.name,
              trackCount: stream.getTracks().length
            })
          }

          setTimeout(async () => {
            window.__streamSwitchLocalStream ??=
              await navigator.mediaDevices.getUserMedia({
                audio: true,
                video: true
              })

            const peerId = Object.keys(window[roomId].getPeers())[0]
            window[roomId].addStream(window.__streamSwitchLocalStream, {
              target: peerId,
              metadata: {phase}
            })
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

      const {
        roomId: streamSwitchRoomA,
        values: [switchRoomAPeer1, switchRoomAPeer2]
      } = await joinPairWithRetry({
        label: 'stream switch room A join',
        makeRoomId: () =>
          `stream-switch-a-${Math.random().toString().replace('.', '')}`,
        join: joinStreamSwitchRoom,
        makeArgs: roomId => [roomId, roomConfig]
      })

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

      const {
        roomId: streamSwitchRoomB,
        values: [switchRoomBPeer1, switchRoomBPeer2]
      } = await joinPairWithRetry({
        label: 'stream switch room B join',
        makeRoomId: () =>
          `stream-switch-b-${Math.random().toString().replace('.', '')}`,
        join: joinStreamSwitchRoom,
        makeArgs: roomId => [roomId, roomConfig]
      })

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
    },
    {skip: ({browserName}) => browserName === 'webkit'}
  )
