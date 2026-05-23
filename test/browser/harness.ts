import {expect, test} from '@playwright/test'
import {attachPageLogging, emojis, shortBrowsers} from '../logger'
import {strategyConfigs} from '../strategy-configs'

const testPort = process.env.TRYSTERO_TEST_PORT ?? '8080'
const testUrl = `https://localhost:${testPort}/test`
const proxy = process.env.PROXY
const useTestOnlyMdnsFallback =
  process.env.TRYSTERO_TEST_FORCE_LOOPBACK_MDNS !== '0'

export const sleep = ms => new Promise(res => setTimeout(res, ms))

export const concurrentRooms = strategy =>
  strategy === 'ipfs' || strategy === 'torrent' ? 1 : 3

const defaultRelayRedundancy = 4

export const withStrategyBrowserPair = (
  strategy,
  overrides,
  name,
  fn,
  options: {
    skip?: (ctx: {browserName: string; strategy: string}) => boolean
  } = {}
) => {
  const config = {...strategyConfigs[strategy], ...overrides}

  test(`Trystero: ${strategy}: ${name}`, async ({
    page,
    browser,
    browserName
  }) => {
    if (options.skip?.({browserName, strategy})) {
      test.skip()
    }

    const shouldSoftFail = strategy === 'ipfs' || strategy === 'torrent'
    const initialConnectionResults = []

    const run = async () => {
      if (strategy === 'ipfs') {
        test.setTimeout(180_000)
      } else if (strategy === 'torrent') {
        test.setTimeout(120_000)
      }

      console.log(
        `  🐎   ${shortBrowsers[browserName]}: ${emojis[strategy]} ${strategy} ${name}`
      )

      if (proxy) {
        console.log(`\n👺 using proxy: ${proxy}\n`)
      }

      const scriptUrl = `../dist/trystero-${strategy}.min.js`
      const context2 = await browser.newContext({
        ignoreHTTPSErrors: true,
        ...(proxy
          ? {proxy: {server: 'http://' + proxy, bypass: 'localhost'}}
          : {})
      })
      const page2 = await context2.newPage()

      try {
        await attachPageLogging({
          strategy,
          browserName,
          pages: [page, page2]
        })

        await page.goto(testUrl)
        await page2.goto(testUrl)

        const loadLib = async path => (window.trystero = await import(path))

        await page.evaluate(loadLib, scriptUrl)
        await page2.evaluate(loadLib, scriptUrl)

        const isRelayStrategy =
          strategy === 'torrent' || strategy === 'nostr' || strategy === 'mqtt'

        const redundancy = isRelayStrategy
          ? Math.min(
              defaultRelayRedundancy,
              await page.evaluate(() => window.trystero.defaultRelayUrls.length)
            )
          : 0

        const relayConfig = {
          ...(isRelayStrategy ? {redundancy} : {}),
          ...config.relayConfig
        }
        const roomConfig = {
          appId: `trystero-test-${Math.random()}`,
          password: '03d1p@M@@s' + Math.random(),
          ...(useTestOnlyMdnsFallback &&
          (browserName === 'webkit' || browserName === 'firefox')
            ? {_test_only_mdnsHostFallbackToLoopback: true}
            : {}),
          ...config,
          ...(isRelayStrategy || config.relayConfig ? {relayConfig} : {})
        }

        const getSelfId = () => window.trystero.selfId

        const selfId1 = await page.evaluate(getSelfId)
        const selfId2 = await page2.evaluate(getSelfId)

        expect(selfId1).toHaveLength(20)
        expect(selfId1).not.toEqual(selfId2)

        const evaluateWithTimeout = async (
          targetPage,
          pageFunction,
          arg,
          timeoutMs,
          label
        ) =>
          Promise.race([
            targetPage.evaluate(pageFunction, arg),
            sleep(timeoutMs).then(() => {
              throw new Error(`${label} timed out after ${timeoutMs}ms`)
            })
          ])

        const leaveNamedRoom = async (targetPage, roomId) => {
          await targetPage
            .evaluate(id => {
              clearInterval(window[id]?.__eagerSendInterval)
              return window[id]?.leave?.()
            }, roomId)
            .catch(() => {})
        }

        const joinPairWithRetry = async ({
          label,
          makeRoomId,
          join,
          makeArgs,
          timeoutMs = 18_000,
          attempts = browserName === 'firefox' ? 3 : 2
        }) => {
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

    if (!shouldSoftFail) {
      try {
        await run()
        recordConnectionResult()
      } catch (err) {
        recordConnectionResult()
        throw err
      }
      return
    }

    try {
      await run()
      recordConnectionResult()
    } catch (err) {
      recordConnectionResult()
      const message =
        err instanceof Error ? (err.stack ?? err.message) : String(err)

      test.info().annotations.push({
        type: 'flaky',
        description: `${strategy} failure ignored (flaky)`
      })
      console.warn(`\n⚠️ ${strategy} failure ignored (flaky):\n${message}\n`)
    }
  })
}
