import {expect} from '@playwright/test'
import type {StrategyConfig} from '../strategy-configs'
import {withStrategyBrowserPair} from './harness'
import {joinRoomAndWaitForPeer, leaveRoom} from './room-helpers'

type WireTestState = {
  cursors: number[]
  files: Array<[number, number | undefined, number | undefined]>
  duringFile: number
  progress: number
  signal: AbortSignal | null
  approve: ((approved: boolean) => void) | null
  unsubReceive: (() => void) | null
}

withStrategyBrowserPair(
  'ws-relay',
  {rtcConfig: {iceServers: []}},
  'passive rooms connect on demand and reject oversized inline requests',
  async ({page, page2, roomConfig, selfId2}) => {
    const roomId = `passive-${Math.random()}`
    try {
      await page2.evaluate(
        ([roomId, config]: [string, StrategyConfig]) => {
          window[roomId] = window.trystero.joinRoom(
            {...config, passive: true, maxReceiveBytes: 1024},
            roomId
          )
          window[roomId]
            .makeAction('upload', {
              kind: 'request'
            })
            .onRequest(() => 'ok')
        },
        [roomId, roomConfig] satisfies [string, StrategyConfig]
      )
      await page.evaluate(joinRoomAndWaitForPeer, [
        roomId,
        roomConfig
      ] satisfies [string, StrategyConfig])
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
          async ([roomId, target]: [string, string]) => {
            const upload = window[roomId].makeAction('upload', {
              kind: 'request'
            })
            const rejected = await upload
              .request(new Uint8Array(2048), {
                target,
                timeoutMs: 2000
              })
              .catch((error: {kind?: string}) => error.kind)
            const accepted = await upload.request(new Uint8Array(1024), {
              target,
              timeoutMs: 2000
            })
            return [rejected, accepted]
          },
          [roomId, selfId2] satisfies [string, string]
        )
      ).toEqual(['rejected', 'ok'])
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
  'action wire keeps cursor traffic flowing during bulk admission and transfer',
  async ({page, page2, roomConfig, selfId2}) => {
    const roomId = `wire-${Math.random()}`
    try {
      await Promise.all([
        page.evaluate(joinRoomAndWaitForPeer, [roomId, roomConfig] satisfies [
          string,
          StrategyConfig
        ]),
        page2.evaluate(joinRoomAndWaitForPeer, [roomId, roomConfig] satisfies [
          string,
          StrategyConfig
        ])
      ])
      await page2.evaluate((roomId: string) => {
        const state: WireTestState = (window['__wireTest'] = {
          cursors: [],
          files: [],
          duringFile: 0,
          progress: 0,
          signal: null,
          approve: null,
          unsubReceive: null
        })
        window[roomId].makeAction('cursor').onMessage((data: number) => {
          state.cursors.push(data)
          if (state.progress > 0 && state.progress < 1) {
            state.duringFile++
          }
        })
        const fileAction = window[roomId].makeAction('file')
        state.unsubReceive = fileAction.onReceive(
          ({signal}: {signal: AbortSignal}) => {
            state.signal = signal
            return new Promise<boolean>(resolve => {
              state.approve = resolve
            })
          }
        )
        fileAction.onReceiveProgress((progress: number) => {
          state.progress = progress
        })
        fileAction.onMessage((data: Uint8Array) => {
          state.files.push([data.byteLength, data[0], data[data.length - 1]])
        })
      }, roomId)
      await page.evaluate(
        ([roomId, target]: [string, string]) => {
          const cursor = window[roomId].makeAction('cursor')
          const sends: Array<Promise<void>> = []
          let sequence = 50
          window['__wireSend'] = window[roomId]
            .makeAction('file')
            .send(new Blob([new Uint8Array(4 * 1024 ** 2).fill(42)]), {
              target,
              onProgress: (progress: number) => {
                if (progress < 1 && sequence < 100) {
                  sends.push(cursor.send(sequence++, {target}))
                }
              }
            })
            .then(() => Promise.all(sends))
        },
        [roomId, selfId2] satisfies [string, string]
      )
      await expect
        .poll(() => page2.evaluate(() => Boolean(window['__wireTest'].approve)))
        .toBe(true)
      await page.evaluate(
        async ([roomId, target]: [string, string]) => {
          const cursor = window[roomId].makeAction('cursor')
          for (let i = 0; i < 50; i++) {
            await cursor.send(i, {target})
            await new Promise(resolve => setTimeout(resolve, 16))
          }
        },
        [roomId, selfId2] satisfies [string, string]
      )
      await expect
        .poll(() => page2.evaluate(() => window['__wireTest'].cursors.length))
        .toBe(50)
      expect(await page2.evaluate(() => window['__wireTest'].files)).toEqual([])
      await page2.evaluate(() => window['__wireTest'].approve(true))
      await page.evaluate(() => window['__wireSend'])
      await expect
        .poll(() => page2.evaluate(() => window['__wireTest'].files))
        .toEqual([[4 * 1024 ** 2, 42, 42]])
      await expect
        .poll(() => page2.evaluate(() => window['__wireTest'].cursors.length))
        .toBe(100)
      expect(await page2.evaluate(() => window['__wireTest'].cursors)).toEqual(
        Array.from({length: 100}, (_, i) => i)
      )
      expect(
        await page2.evaluate(() => window['__wireTest'].duringFile)
      ).toBeGreaterThan(0)

      await page2.evaluate((roomId: string) => {
        window['__wireTest'].unsubReceive?.()
        window['__wireTest'].unsubReceive = window[roomId]
          .makeAction('file')
          .onReceive(() => false)
      }, roomId)
      expect(
        await page.evaluate(
          async ([roomId, target]: [string, string]) => {
            try {
              await window[roomId]
                .makeAction('file')
                .send(new Uint8Array(100_000), {target})
              return 'accepted'
            } catch (error) {
              return (error as {kind?: string}).kind
            }
          },
          [roomId, selfId2] satisfies [string, string]
        )
      ).toBe('rejected')
      expect(
        await page2.evaluate(() => window['__wireTest'].files.length)
      ).toBe(1)

      await page2.evaluate((roomId: string) => {
        window['__wireTest'].signal = null
        window['__wireTest'].unsubReceive?.()
        window['__wireTest'].unsubReceive = window[roomId]
          .makeAction('file')
          .onReceive(({signal}: {signal: AbortSignal}) => {
            window['__wireTest'].signal = signal
            return new Promise<boolean>(resolve =>
              signal.addEventListener('abort', () => resolve(false), {
                once: true
              })
            )
          })
      }, roomId)
      await page.evaluate(
        ([roomId, target]: [string, string]) => {
          window['__wireAbort'] = new AbortController()
          window['__wireSend'] = window[roomId]
            .makeAction('file')
            .send(new Uint8Array(100_000), {
              target,
              signal: window['__wireAbort'].signal
            })
            .then(
              () => 'accepted',
              (error: {kind?: string}) => error.kind
            )
        },
        [roomId, selfId2] satisfies [string, string]
      )
      await expect
        .poll(() => page2.evaluate(() => Boolean(window['__wireTest'].signal)))
        .toBe(true)
      await page.evaluate(() => window['__wireAbort'].abort())
      expect(await page.evaluate(() => window['__wireSend'])).toBe('aborted')
      await expect
        .poll(() => page2.evaluate(() => window['__wireTest'].signal.aborted))
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
        page.evaluate(joinRoomAndWaitForPeer, [roomId, roomConfig] satisfies [
          string,
          StrategyConfig
        ]),
        page2.evaluate(joinRoomAndWaitForPeer, [roomId, roomConfig] satisfies [
          string,
          StrategyConfig
        ])
      ])
      await page.evaluate((roomId: string) => {
        window['__responseApprovals'] = []
        const fileAction = window[roomId].makeAction('file')
        fileAction.onMessage(() => {})
        fileAction.onReceive(
          () =>
            new Promise<boolean>(resolve =>
              window['__responseApprovals'].push(resolve)
            )
        )
      }, roomId)
      await page2.evaluate(
        ([roomId, target]: [string, string]) => {
          window[roomId]
            .makeAction('echo', {
              kind: 'request'
            })
            .onRequest((value: unknown) => value)
          const file = window[roomId].makeAction('file')
          window['__blockedFiles'] = Promise.all(
            Array.from({length: 8}, () =>
              file
                .send(new Uint8Array(20_000), {target})
                .catch((error: {kind?: string}) => error.kind)
            )
          )
        },
        [roomId, selfId1] satisfies [string, string]
      )
      await expect
        .poll(() => page.evaluate(() => window['__responseApprovals'].length))
        .toBe(8)
      expect(
        await page.evaluate(
          async ([roomId, target]: [string, string]) => {
            const echo = window[roomId].makeAction('echo', {kind: 'request'})
            const first = await echo.request('hello', {target, timeoutMs: 2000})
            const unsubReceive = echo.onReceive(() => true)
            const limited = await echo
              .request('limited', {target, timeoutMs: 2000})
              .catch((error: {kind?: string}) => error.kind)
            unsubReceive()
            const last = await echo.request('again', {target, timeoutMs: 2000})
            window['__responseApprovals'].forEach(
              (approve: (approved: boolean) => void) => approve(false)
            )
            return [first, limited, last]
          },
          [roomId, selfId2] satisfies [string, string]
        )
      ).toEqual(['hello', 'rejected', 'again'])
      expect(await page2.evaluate(() => window['__blockedFiles'])).toEqual(
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
