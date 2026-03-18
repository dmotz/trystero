import {mkdirSync, writeFileSync} from 'fs'
import {join as pathJoin} from 'path'
import {test} from '@playwright/test'
import {shortBrowsers, emojis} from './logger'

const perfVerbose = process.env.PERF_TRICKLE_VERBOSE === '1'
const perfResultsDir = pathJoin(process.cwd(), 'test-results', 'perf-trickle')

const testUrl = 'https://localhost:8080/test'

const isRelayStrategy = strategy =>
  strategy === 'torrent' || strategy === 'nostr' || strategy === 'mqtt'

const strategyConfig = (strategy, appId) => {
  if (strategy === 'firebase') {
    return {appId: 'trystero-94db3.firebaseio.com'}
  }
  return {appId}
}

const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length

const median = arr => {
  const a = [...arr].sort((x, y) => x - y)
  const mid = Math.floor(a.length / 2)
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2
}

const stddev = arr => {
  if (arr.length < 2) return 0
  const m = mean(arr)
  const variance =
    arr.reduce((acc, x) => acc + (x - m) * (x - m), 0) / (arr.length - 1)
  return Math.sqrt(variance)
}

const sleep = ms => new Promise(res => setTimeout(res, ms))

const measureJoinTime = async ({
  page,
  page2,
  browserName,
  strategy,
  trickle,
  appId
}) => {
  const scriptUrl = `../dist/trystero-${strategy}.min.js`

  await page.goto(testUrl)
  await page2.goto(testUrl)

  const loadLib = async path => (window.trystero = await import(path))

  await page.evaluate(loadLib, scriptUrl)
  await page2.evaluate(loadLib, scriptUrl)

  const relayRedundancy = isRelayStrategy(strategy)
    ? Math.min(
        2,
        await page.evaluate(() => window.trystero.defaultRelayUrls.length)
      )
    : undefined

  const roomConfig = {
    password: 'perf-' + Math.random(),
    trickle,
    ...(relayRedundancy !== undefined ? {relayRedundancy} : {}),
    ...strategyConfig(strategy, appId)
  }

  const getSelfId = () => window.trystero.selfId
  const selfId1 = await page.evaluate(getSelfId)
  const selfId2 = await page2.evaluate(getSelfId)

  const joinRoom = ([roomId, config, payload]) => {
    window[roomId] = window.trystero.joinRoom(config, roomId)

    const [sendEager, getEager] = window[roomId].makeAction('eager')

    let didSend = false

    return new Promise(res => {
      getEager((...args) => res(args))
      window[roomId].onPeerJoin(peerId => {
        if (!didSend) {
          sendEager(payload, peerId)
          didSend = true
        }
      })
    })
  }

  const eagerPayload = 33
  const roomId = `perfRoom-${Math.random().toString().replace('.', '')}`
  const args = [roomId, roomConfig, eagerPayload]

  const start = Date.now()
  let joinTime

  try {
    const [peer2Data, peer1Data] = await Promise.all([
      page.evaluate(joinRoom, args),
      page2.evaluate(joinRoom, args)
    ])
    joinTime = Date.now() - start

    if (
      peer1Data[0] !== eagerPayload ||
      peer2Data[0] !== eagerPayload ||
      peer1Data[1] !== selfId1 ||
      peer2Data[1] !== selfId2
    ) {
      throw new Error('Unexpected eager payload or peer ids during perf test')
    }
  } finally {
    await Promise.allSettled([
      page.evaluate(async id => {
        try {
          await window[id]?.leave?.()
        } finally {
          try {
            delete window[id]
          } catch {}
        }
      }, roomId),
      page2.evaluate(async id => {
        try {
          await window[id]?.leave?.()
        } finally {
          try {
            delete window[id]
          } catch {}
        }
      }, roomId)
    ])
  }

  if (perfVerbose) {
    console.log(
      `  ⏱   ${shortBrowsers[browserName]}: ${emojis[strategy]} ${strategy.padEnd(
        8,
        ' '
      )} trickle=${String(trickle).padEnd(5, ' ')} ${joinTime}ms`
    )
  }

  return joinTime
}

const sleepMsAfterJoin = strategy =>
  strategy === 'firebase' || strategy === 'nostr' ? 250 : 50

/** One spec file per strategy so each runs in its own Playwright worker (fresh Chrome). */
export function defineTricklePerfSpec(strategy) {
  test.describe(`@trickle-perf Trickle performance: ${strategy}`, () => {
    test(`@trickle-perf compare trickle vs non-trickle for ${strategy}`, async ({
      page,
      browser,
      browserName
    }) => {
      if (perfVerbose) {
        console.log(
          `\n🐎  ${shortBrowsers[browserName]}: ${emojis[strategy]} ${strategy} trickle perf`
        )
      }

      const context2 = await browser.newContext()
      try {
        const page2 = await context2.newPage()

        const perfAppId =
          strategy === 'firebase'
            ? 'trystero-94db3.firebaseio.com'
            : `trystero-perf-${strategy}-${Math.random()}`

        const warmupRuns = 1
        const measuredRuns = 5
        const totalRuns = warmupRuns + measuredRuns
        const pauseMs = sleepMsAfterJoin(strategy)

        const baselineTimes = []
        const trickleTimes = []

        for (let i = 0; i < totalRuns; i++) {
          baselineTimes.push(
            await measureJoinTime({
              page,
              page2,
              browserName,
              strategy,
              trickle: false,
              appId: perfAppId
            })
          )
          await sleep(pauseMs)
        }

        for (let i = 0; i < totalRuns; i++) {
          trickleTimes.push(
            await measureJoinTime({
              page,
              page2,
              browserName,
              strategy,
              trickle: true,
              appId: perfAppId
            })
          )
          await sleep(pauseMs)
        }

        const baselineMeasured = baselineTimes.slice(warmupRuns)
        const trickleMeasured = trickleTimes.slice(warmupRuns)

        const baselineMean = mean(baselineMeasured)
        const trickleMean = mean(trickleMeasured)
        const baselineMedian = median(baselineMeasured)
        const trickleMedian = median(trickleMeasured)
        const baselineStddev = stddev(baselineMeasured)
        const trickleStddev = stddev(trickleMeasured)
        const meanImprovement =
          baselineMean > 0
            ? ((baselineMean - trickleMean) / baselineMean) * 100
            : 0
        const medianImprovement =
          baselineMedian > 0
            ? ((baselineMedian - trickleMedian) / baselineMedian) * 100
            : 0

        mkdirSync(perfResultsDir, {recursive: true})
        const browserLabel =
          {chromium: 'CH', webkit: 'WK', firefox: 'FF'}[browserName] ??
          browserName

        writeFileSync(
          pathJoin(perfResultsDir, `${strategy}.json`),
          JSON.stringify(
            {
              strategy,
              browserName,
              browserShort: browserLabel,
              warmupRuns,
              measuredRuns,
              baselineMean,
              trickleMean,
              baselineMedian,
              trickleMedian,
              baselineStddev,
              trickleStddev,
              meanImprovement,
              medianImprovement,
              baselineMeasured,
              trickleMeasured
            },
            null,
            0
          ),
          'utf8'
        )

        if (perfVerbose) {
          console.log(
            `\n📈  ${shortBrowsers[browserName]}: ${emojis[strategy]} ${strategy} ` +
              `(warmup=${warmupRuns}, n=${measuredRuns})\n` +
              `    baseline: mean=${baselineMean.toFixed(1)}ms, median=${baselineMedian.toFixed(1)}ms, sd=${baselineStddev.toFixed(1)}ms\n` +
              `    trickle:  mean=${trickleMean.toFixed(1)}ms, median=${trickleMedian.toFixed(1)}ms, sd=${trickleStddev.toFixed(1)}ms\n` +
              `    improvement: mean=${meanImprovement.toFixed(1)}%, median=${medianImprovement.toFixed(1)}%`
          )
        }
      } finally {
        await context2.close().catch(() => {})
      }
    })
  })
}
