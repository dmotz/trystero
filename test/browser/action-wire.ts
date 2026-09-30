import {expect} from '@playwright/test'
import {withStrategyBrowserPair} from './harness'
import {joinRoomAndWaitForPeer, leaveRoom} from './room-helpers'

withStrategyBrowserPair(
  'ws-relay',
  {rtcConfig: {iceServers: []}},
  'passive rooms reuse an existing connection and reject oversized inline requests',
  async ({page, page2, roomConfig, selfId2}) => {
    const lobby = `lobby-${Math.random()}`
    const roomId = `passive-${Math.random()}`
    try {
      await Promise.all([
        page.evaluate(joinRoomAndWaitForPeer, [lobby, roomConfig]),
        page2.evaluate(joinRoomAndWaitForPeer, [lobby, roomConfig])
      ])
      await page2.evaluate(
        ([roomId, config]) => {
          window[roomId] = window.trystero.joinRoom(
            {...config, passive: true, maxReceiveBytes: 1024},
            roomId
          )
          window[roomId].makeAction('upload', {
            kind: 'request',
            onRequest: () => 'ok'
          })
        },
        [roomId, roomConfig]
      )
      await page.evaluate(joinRoomAndWaitForPeer, [roomId, roomConfig])
      await expect
        .poll(() =>
          page2.evaluate(
            roomId => Object.keys(window[roomId].getPeers()).length,
            roomId
          )
        )
        .toBe(1)
      expect(
        await page.evaluate(
          ([lobby, roomId, target]) =>
            window[lobby].getPeers()[target] ===
            window[roomId].getPeers()[target],
          [lobby, roomId, selfId2]
        )
      ).toBe(true)
      expect(
        await page.evaluate(
          async ([roomId, target]) => {
            const upload = window[roomId].makeAction('upload', {
              kind: 'request'
            })
            const rejected = await upload
              .request(new Uint8Array(2048), {
                target,
                timeoutMs: 2000
              })
              .catch(error => error.kind)
            const accepted = await upload.request(new Uint8Array(1024), {
              target,
              timeoutMs: 2000
            })
            return [rejected, accepted]
          },
          [roomId, selfId2]
        )
      ).toEqual(['rejected', 'ok'])
    } finally {
      for (const id of [roomId, lobby]) {
        await Promise.all([
          page.evaluate(leaveRoom, id),
          page2.evaluate(leaveRoom, id)
        ])
      }
    }
  }
)

withStrategyBrowserPair(
  'ws-relay',
  {rtcConfig: {iceServers: []}},
  'action wire keeps cursor traffic flowing during bulk admission and transfer',
  async ({page, page2, roomConfig, selfId2}) => {
    const roomId = `wire-${Math.random()}`
    try {
      await Promise.all([
        page.evaluate(joinRoomAndWaitForPeer, [roomId, roomConfig]),
        page2.evaluate(joinRoomAndWaitForPeer, [roomId, roomConfig])
      ])
      await page2.evaluate(roomId => {
        const state = (window.__wireTest = {
          cursors: [],
          files: [],
          duringFile: 0,
          progress: 0,
          signal: null,
          approve: null
        })
        window[roomId].makeAction('cursor', {
          onMessage: data => {
            state.cursors.push(data)
            if (state.progress > 0 && state.progress < 1) {
              state.duringFile++
            }
          }
        })
        window[roomId].makeAction('file', {
          onReceive: ({signal}) => {
            state.signal = signal
            return new Promise(resolve => {
              state.approve = resolve
            })
          },
          onReceiveProgress: progress => {
            state.progress = progress
          },
          onMessage: data => {
            state.files.push([data.byteLength, data[0], data[data.length - 1]])
          }
        })
      }, roomId)
      await page.evaluate(
        ([roomId, target]) => {
          const cursor = window[roomId].makeAction('cursor')
          const sends = []
          let sequence = 50
          window.__wireSend = window[roomId]
            .makeAction('file')
            .send(new Blob([new Uint8Array(2 * 1024 ** 2).fill(42)]), {
              target,
              onProgress: progress => {
                if (progress < 1 && sequence < 100) {
                  sends.push(cursor.send(sequence++, {target}))
                }
              }
            })
            .then(() => Promise.all(sends))
        },
        [roomId, selfId2]
      )
      await expect
        .poll(() => page2.evaluate(() => Boolean(window.__wireTest.approve)))
        .toBe(true)
      await page.evaluate(
        async ([roomId, target]) => {
          const cursor = window[roomId].makeAction('cursor')
          for (let i = 0; i < 50; i++) {
            await cursor.send(i, {target})
            await new Promise(resolve => setTimeout(resolve, 16))
          }
        },
        [roomId, selfId2]
      )
      await expect
        .poll(() => page2.evaluate(() => window.__wireTest.cursors.length))
        .toBe(50)
      expect(await page2.evaluate(() => window.__wireTest.files)).toEqual([])
      await page2.evaluate(() => window.__wireTest.approve(true))
      await page.evaluate(() => window.__wireSend)
      await expect
        .poll(() => page2.evaluate(() => window.__wireTest.files))
        .toEqual([[2 * 1024 ** 2, 42, 42]])
      await expect
        .poll(() => page2.evaluate(() => window.__wireTest.cursors.length))
        .toBe(100)
      expect(await page2.evaluate(() => window.__wireTest.cursors)).toEqual(
        Array.from({length: 100}, (_, i) => i)
      )
      expect(
        await page2.evaluate(() => window.__wireTest.duringFile)
      ).toBeGreaterThan(0)

      await page2.evaluate(roomId => {
        window[roomId].makeAction('file').onReceive = () => false
      }, roomId)
      expect(
        await page.evaluate(
          async ([roomId, target]) => {
            try {
              await window[roomId]
                .makeAction('file')
                .send(new Uint8Array(100_000), {target})
              return 'accepted'
            } catch (error) {
              return error.kind
            }
          },
          [roomId, selfId2]
        )
      ).toBe('rejected')
      expect(await page2.evaluate(() => window.__wireTest.files.length)).toBe(1)

      await page2.evaluate(roomId => {
        window.__wireTest.signal = null
        window[roomId].makeAction('file').onReceive = ({signal}) => {
          window.__wireTest.signal = signal
          return new Promise(resolve =>
            signal.addEventListener('abort', () => resolve(false), {once: true})
          )
        }
      }, roomId)
      await page.evaluate(
        ([roomId, target]) => {
          window.__wireAbort = new AbortController()
          window.__wireSend = window[roomId]
            .makeAction('file')
            .send(new Uint8Array(100_000), {
              target,
              signal: window.__wireAbort.signal
            })
            .then(
              () => 'accepted',
              error => error.kind
            )
        },
        [roomId, selfId2]
      )
      await expect
        .poll(() => page2.evaluate(() => Boolean(window.__wireTest.signal)))
        .toBe(true)
      await page.evaluate(() => window.__wireAbort.abort())
      expect(await page.evaluate(() => window.__wireSend)).toBe('aborted')
      await expect
        .poll(() => page2.evaluate(() => window.__wireTest.signal.aborted))
        .toBe(true)
    } finally {
      await Promise.all([
        page.evaluate(leaveRoom, roomId),
        page2.evaluate(leaveRoom, roomId)
      ])
    }
  }
)

withStrategyBrowserPair(
  'ws-relay',
  {rtcConfig: {iceServers: []}},
  'request responses remain usable while receive policy slots are full',
  async ({page, page2, roomConfig, selfId1, selfId2}) => {
    const roomId = `response-admission-${Math.random()}`
    try {
      await Promise.all([
        page.evaluate(joinRoomAndWaitForPeer, [roomId, roomConfig]),
        page2.evaluate(joinRoomAndWaitForPeer, [roomId, roomConfig])
      ])
      await page.evaluate(roomId => {
        window.__responseApprovals = []
        window[roomId].makeAction('file', {
          onMessage: () => {},
          onReceive: () =>
            new Promise(resolve => window.__responseApprovals.push(resolve))
        })
      }, roomId)
      await page2.evaluate(
        ([roomId, target]) => {
          window[roomId].makeAction('echo', {
            kind: 'request',
            onRequest: value => value
          })
          const file = window[roomId].makeAction('file')
          window.__blockedFiles = Promise.all(
            Array.from({length: 8}, () =>
              file
                .send(new Uint8Array(20_000), {target})
                .catch(error => error.kind)
            )
          )
        },
        [roomId, selfId1]
      )
      await expect
        .poll(() => page.evaluate(() => window.__responseApprovals.length))
        .toBe(8)
      expect(
        await page.evaluate(
          async ([roomId, target]) => {
            const echo = window[roomId].makeAction('echo', {kind: 'request'})
            const first = await echo.request('hello', {target, timeoutMs: 2000})
            echo.onReceive = () => true
            const limited = await echo
              .request('limited', {target, timeoutMs: 2000})
              .catch(error => error.kind)
            echo.onReceive = null
            const last = await echo.request('again', {target, timeoutMs: 2000})
            window.__responseApprovals.forEach(approve => approve(false))
            return [first, limited, last]
          },
          [roomId, selfId2]
        )
      ).toEqual(['hello', 'rejected', 'again'])
      expect(await page2.evaluate(() => window.__blockedFiles)).toEqual(
        new Array(8).fill('rejected')
      )
    } finally {
      await Promise.all([
        page.evaluate(leaveRoom, roomId),
        page2.evaluate(leaveRoom, roomId)
      ])
    }
  }
)
