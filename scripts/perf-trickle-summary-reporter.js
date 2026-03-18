/**
 * Playwright reporter: reads per-strategy JSON from test-results/perf-trickle/
 * and prints one summary table after all perf workers finish.
 */
import fs from 'fs'
import path from 'path'

const RESULTS_DIR = path.join(process.cwd(), 'test-results', 'perf-trickle')

const EMOJI = {
  firebase: '🔥',
  mqtt: '📡',
  nostr: '🐦',
  torrent: '🌊'
}

function pad(s, w) {
  const t = String(s)
  return t.length >= w ? t.slice(0, w) : t + ' '.repeat(w - t.length)
}

function removePerfTrickleDir() {
  try {
    fs.rmSync(RESULTS_DIR, {recursive: true, force: true})
  } catch {
    /* ignore */
  }
}

export default class PerfTrickleSummaryReporter {
  onBegin() {
    removePerfTrickleDir()
  }

  onEnd() {
    try {
      if (!fs.existsSync(RESULTS_DIR)) {
        console.log(
          '\n  ⚠️  No perf-trickle result files (all tests failed or none ran).\n'
        )
        return
      }

      const files = fs
        .readdirSync(RESULTS_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => path.join(RESULTS_DIR, f))

      if (!files.length) {
        console.log('\n  ⚠️  No perf-trickle JSON files written.\n')
        return
      }

      const rows = files
        .map(f => {
          try {
            return JSON.parse(fs.readFileSync(f, 'utf8'))
          } catch {
            return null
          }
        })
        .filter(Boolean)
        .sort((a, b) => a.strategy.localeCompare(b.strategy))

      const {warmupRuns, measuredRuns} = rows[0] || {}
      const ms = 12
      const sep = '─'.repeat(96)

      console.log(`\n${sep}`)
      console.log(
        `  Trystero trickle perf summary  (warmup=${warmupRuns ?? '?'}, n=${measuredRuns ?? '?'})`
      )
      console.log(sep)
      console.log(
        `  ${pad('Strategy', 12)} ${pad('Browser', 8)} ${pad('Baseline Δt med', ms)} ${pad('Trickle Δt med', ms)} ${pad('Baseline mean', ms)} ${pad('Trickle mean', ms)} ${pad('Δ med %', 9)}`
      )
      console.log(`  ${'─'.repeat(94)}`)

      for (const r of rows) {
        const e = EMOJI[r.strategy] || '  '
        const sign =
          r.medianImprovement > 0 ? '+' : r.medianImprovement < 0 ? '' : ' '
        console.log(
          `  ${e} ${pad(r.strategy, 9)} ${pad(r.browserShort ?? r.browserName ?? '', 8)} ` +
            `${pad(`${r.baselineMedian.toFixed(0)} ms`, ms)} ${pad(`${r.trickleMedian.toFixed(0)} ms`, ms)} ` +
            `${pad(`${r.baselineMean.toFixed(0)} ms`, ms)} ${pad(`${r.trickleMean.toFixed(0)} ms`, ms)} ` +
            `${pad(`${sign}${r.medianImprovement.toFixed(1)}%`, 9)}`
        )
      }

      console.log(sep)
      console.log(
        '  Δ med % = (baseline − trickle) / baseline · 100  (positive ⇒ trickle faster)\n'
      )
    } finally {
      removePerfTrickleDir()
    }
  }
}
