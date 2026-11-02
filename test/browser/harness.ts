import {expect, test, type Page} from '@playwright/test'
import {attachPageLogging, emojis, shortBrowsers} from '../logger'
import {
  strategyConfigs,
  type StrategyConfig,
  type StrategyName
} from '../strategy-configs'
import {installLoopbackMdnsPeerConnection} from './mdns-loopback'

const testPort = process.env['TRYSTERO_TEST_PORT'] ?? '8080'
// Firefox may gather no host ICE candidates when the page uses localhost.
const testUrl = `https://127.0.0.1:${testPort}/test`
const proxy = process.env['PROXY']
const useTestOnlyMdnsFallback =
  process.env['TRYSTERO_TEST_FORCE_LOOPBACK_MDNS'] !== '0'

export const sleep = (ms: number): Promise<void> =>
  new Promise(res => setTimeout(res, ms))

export const concurrentRooms = (strategy: StrategyName): number =>
  strategy === 'torrent' ? 1 : 3

const defaultRelayRedundancy = 4

export type JoinPairWithRetryOptions<TArg, TResult> = {
  label: string
  makeRoomId: (attempt: number) => string
  join: (arg: TArg) => Promise<TResult> | TResult
  makeArgs: (roomId: string) => TArg
  timeoutMs?: number
  attempts?: number
}

export type BrowserPairContext = {
  browserName: string
  config: StrategyConfig
  initialConnectionResults: Array<number | 'failed'>
  isRelayStrategy: boolean
  joinPairWithRetry: <TArg, TResult>(
    opts: JoinPairWithRetryOptions<TArg, TResult>
  ) => Promise<{roomId: string; values: [TResult, TResult]}>
  page: Page
  page2: Page
  redundancy: number
  roomConfig: StrategyConfig & {appId: string; password: string}
  selfId1: string
  selfId2: string
  strategy: StrategyName
}

export const withStrategyBrowserPair = (
  strategy: StrategyName,
  overrides: StrategyConfig = {},
  name: string,
  fn: (ctx: BrowserPairContext) => Promise<void>,
  options: {
    skip?: (ctx: {browserName: string; strategy: StrategyName}) => boolean
  } = {}
): void => {
  const config: StrategyConfig = {...strategyConfigs[strategy], ...overrides}

  test(`Trystero: ${strategy}: ${name}`, async ({
    page,
    browser,
    browserName
  }) => {
    if (options.skip?.({browserName, strategy})) {
      test.skip()
    }

    const initialConnectionResults: Array<number | 'failed'> = []

    const run = async () => {
      if (strategy === 'torrent') {
        test.setTimeout(120_000)
      }

      console.log(
        `  🐎   ${shortBrowsers[browserName] ?? browserName}: ${emojis[strategy]} ${strategy} ${name}`
      )

      if (proxy) {
        console.log(`\n👺 using proxy: ${proxy}\n`)
      }

      const scriptUrl = `./test/dist/trystero-${strategy}.js`
      const context2 = await browser.newContext({
        ignoreHTTPSErrors: true,
        ...(proxy
          ? {proxy: {server: 'http://' + proxy, bypass: 'localhost,127.0.0.1'}}
          : {})
      })
      const page2 = await context2.newPage()

      try {
        if (browserName === 'webkit') {
          await Promise.all([
            page.context().grantPermissions(['camera', 'microphone']),
            context2.grantPermissions(['camera', 'microphone'])
          ])
        }

        await attachPageLogging({
          strategy,
          browserName,
          pages: [page, page2]
        })

        if (
          useTestOnlyMdnsFallback &&
          (browserName === 'webkit' || browserName === 'firefox')
        ) {
          await Promise.all([
            installLoopbackMdnsPeerConnection(page),
            installLoopbackMdnsPeerConnection(page2)
          ])
        }

        await page.goto(testUrl)
        await page2.goto(testUrl)

        const loadLib = async (path: string) =>
          (window.trystero = await import(path))

        await page.evaluate(loadLib, scriptUrl)
        await page2.evaluate(loadLib, scriptUrl)

        const isRelayStrategy =
          strategy === 'torrent' || strategy === 'nostr' || strategy === 'mqtt'

        const redundancy = isRelayStrategy
          ? (config.relayConfig?.redundancy ??
            config.relayConfig?.urls?.length ??
            Math.min(
              defaultRelayRedundancy,
              await page.evaluate(
                () => (window.trystero.defaultRelayUrls as string[]).length
              )
            ))
          : 0

        const relayConfig = {
          ...(isRelayStrategy ? {redundancy} : {}),
          ...config.relayConfig
        }
        const roomConfig = {
          appId: `trystero-test-${Math.random()}`,
          password: '03d1p@M@@s' + Math.random(),
          ...config,
          ...(isRelayStrategy || config.relayConfig ? {relayConfig} : {})
        }

        const getSelfId = async (cfg: StrategyConfig): Promise<string> => {
          const probe = window.trystero.joinRoom(
            {...cfg, passive: true},
            '__self_id_probe__'
          )
          try {
            return (await probe.getSelf()).peerId as string
          } finally {
            await probe.leave().catch(() => {})
          }
        }

        const selfId1 = await page.evaluate(getSelfId, roomConfig)
        const selfId2 = await page2.evaluate(getSelfId, roomConfig)

        expect(selfId1).toHaveLength(20)
        expect(selfId1).not.toEqual(selfId2)

        const evaluateWithTimeout = async <TArg, TResult>(
          targetPage: Page,
          pageFunction: (arg: TArg) => Promise<TResult> | TResult,
          arg: TArg,
          timeoutMs: number,
          label: string
        ): Promise<TResult> =>
          Promise.race([
            targetPage.evaluate(
              pageFunction as never,
              arg as never
            ) as Promise<TResult>,
            sleep(timeoutMs).then(() => {
              throw new Error(`${label} timed out after ${timeoutMs}ms`)
            })
          ])

        const leaveNamedRoom = async (
          targetPage: Page,
          roomId: string
        ): Promise<void> => {
          await targetPage
            .evaluate((id: string) => {
              clearInterval(window[id]?.__eagerSendInterval)
              return window[id]?.leave?.()
            }, roomId)
            .catch(() => {})
        }

        const joinPairWithRetry = async <TArg, TResult>({
          label,
          makeRoomId,
          join,
          makeArgs,
          timeoutMs = 18_000,
          attempts = browserName === 'firefox' ? 3 : 2
        }: JoinPairWithRetryOptions<TArg, TResult>): Promise<{
          roomId: string
          values: [TResult, TResult]
        }> => {
          let lastError = new Error(`${label} failed before any attempt ran`)

          for (let attempt = 1; attempt <= attempts; attempt++) {
            const roomId = makeRoomId(attempt)
            const args = makeArgs(roomId)

            try {
              const values = await Promise.all([
                evaluateWithTimeout(
                  page,
                  join,
                  args,
                  timeoutMs,
                  `${label} page1 attempt ${attempt}`
                ),
                evaluateWithTimeout(
                  page2,
                  join,
                  args,
                  timeoutMs,
                  `${label} page2 attempt ${attempt}`
                )
              ])

              return {roomId, values}
            } catch (err) {
              lastError = err instanceof Error ? err : new Error(String(err))
              await Promise.all([
                leaveNamedRoom(page, roomId),
                leaveNamedRoom(page2, roomId)
              ])

              if (attempt === attempts) {
                throw lastError
              }
            }
          }

          throw lastError
        }

        await fn({
          browserName,
          config,
          initialConnectionResults,
          isRelayStrategy,
          joinPairWithRetry,
          page,
          page2,
          redundancy,
          roomConfig,
          selfId1,
          selfId2,
          strategy
        })
      } finally {
        await context2.close().catch(() => {})
      }
    }

    const recordConnectionResult = () => {
      test.info().annotations.push({
        type: 'initial-connection-ms',
        description: JSON.stringify({
          results: initialConnectionResults
        })
      })
    }

    try {
      await run()
    } finally {
      recordConnectionResult()
    }
  })
}
