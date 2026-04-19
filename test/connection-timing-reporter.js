import chalk from 'chalk'
import {emojis} from './logger'
import {strategyConfigs} from './strategy-configs'

const annotationType = 'initial-connection-ms'
const strategyOrder = Object.keys(strategyConfigs)

const toOutcome = result => {
  const annotation = result.annotations.find(
    ({type}) => type === annotationType
  )

  if (!annotation) {
    return {status: 'no-data'}
  }

  try {
    const parsed = JSON.parse(annotation.description)
    const results = Array.isArray(parsed?.results)
      ? parsed.results.filter(v => Number.isFinite(v) || v === 'failed')
      : []
    const hasFailed = results.includes('failed')
    const times = results.filter(ms => Number.isFinite(ms))

    if (results.length === 0) {
      return {status: 'no-data'}
    }

    const average =
      times.length > 0
        ? Math.round(times.reduce((sum, ms) => sum + ms, 0) / times.length)
        : null
    return {status: hasFailed ? 'partial-failed' : 'ok', results, average}
  } catch {
    return {status: 'no-data'}
  }
}

const formatOutcome = outcome => {
  if (outcome.status !== 'ok') {
    if (outcome.status === 'partial-failed') {
      const values = outcome.results.map(value =>
        value === 'failed' ? 'failed' : `${value}ms`
      )
      const suffix =
        outcome.average === null
          ? ''
          : `, ${chalk.green(`avg ${outcome.average}ms`)}`
      const plainSuffix =
        outcome.average === null ? '' : `, avg ${outcome.average}ms`
      return {
        plain: `${values.join(', ')}${plainSuffix}`,
        colored: `${values.join(', ')}${suffix}`
      }
    }

    return {plain: 'n/a', colored: 'n/a'}
  }

  const times = outcome.results.map(ms => `${ms}ms`).join(', ')
  const average = `avg ${outcome.average}ms`
  return {
    plain: `${times}, ${average}`,
    colored: `${times}, ${chalk.green(average)}`
  }
}

export default class InitialConnectionReporter {
  constructor() {
    this.resultsByBrowser = new Map()
  }

  onTestEnd(test, result) {
    const browser = test.parent.project()?.name ?? 'unknown'
    const strategy = test.title.replace(/^Trystero:\s*/, '')

    if (!this.resultsByBrowser.has(browser)) {
      this.resultsByBrowser.set(browser, new Map())
    }

    this.resultsByBrowser.get(browser).set(strategy, toOutcome(result))
  }

  onEnd() {
    if (this.resultsByBrowser.size === 0) {
      return
    }

    console.log('\nFirst connection times:')
    const browsers = [...this.resultsByBrowser.keys()].sort((a, b) =>
      a.localeCompare(b)
    )

    const rowsByBrowser = new Map()
    let widestLabelLength = 0
    let widestValueLength = 0

    for (const browser of browsers) {
      const strategyResults = this.resultsByBrowser.get(browser)
      const rows = []

      for (const strategy of strategyOrder) {
        const outcome = strategyResults.get(strategy) ?? {status: 'no-data'}
        const value = formatOutcome(outcome)
        const emoji = emojis[strategy] ?? '•'
        const labelText = `${emoji} ${strategy}`
        rows.push({labelText, labelPlainLength: labelText.length, value})
        widestLabelLength = Math.max(widestLabelLength, labelText.length)
        widestValueLength = Math.max(widestValueLength, value.plain.length)
      }

      rowsByBrowser.set(browser, rows)
    }

    for (const browser of browsers) {
      console.log(`  ${browser}:`)

      for (const {labelText, labelPlainLength, value} of rowsByBrowser.get(
        browser
      )) {
        const labelPadding = ' '.repeat(
          Math.max(0, widestLabelLength - labelPlainLength)
        )
        const plainLength = value.plain.length
        const valuePadding = ' '.repeat(
          Math.max(0, widestValueLength - plainLength)
        )

        console.log(
          `    ${labelText}${labelPadding}: ${valuePadding}${value.colored}`
        )
      }
    }
  }
}
