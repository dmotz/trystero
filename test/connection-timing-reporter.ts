import type {Reporter, TestCase, TestResult} from '@playwright/test/reporter'
import chalk from 'chalk'
import {emojis} from './logger'
import {strategyConfigs} from './strategy-configs'

const annotationType = 'initial-connection-ms'
const strategyOrder = Object.keys(strategyConfigs)

type ConnectionResult = number | 'failed'

type MissingOutcome = {
  status: 'no-data'
}

type OkOutcome = {
  status: 'ok'
  results: number[]
  average: number
}

type PartialFailedOutcome = {
  status: 'partial-failed'
  results: ConnectionResult[]
  average: number | null
}

type Outcome = MissingOutcome | OkOutcome | PartialFailedOutcome

type FormattedOutcome = {
  plain: string
  colored: string
}

const noDataOutcome: MissingOutcome = {status: 'no-data'}

const isConnectionResult = (value: unknown): value is ConnectionResult =>
  Number.isFinite(value) || value === 'failed'

const isConnectionTime = (value: ConnectionResult): value is number =>
  typeof value === 'number'

const toOutcome = (result: TestResult): Outcome => {
  const annotation = result.annotations.find(
    ({type}) => type === annotationType
  )

  if (!annotation) {
    return noDataOutcome
  }

  try {
    const parsed: unknown = JSON.parse(annotation.description!)
    const rawResults =
      parsed && typeof parsed === 'object' && 'results' in parsed
        ? parsed.results
        : undefined
    const results = Array.isArray(rawResults)
      ? rawResults.filter(isConnectionResult)
      : []

    if (results.length === 0) {
      return noDataOutcome
    }

    const hasFailed = results.includes('failed')
    const times = results.filter(isConnectionTime)

    if (hasFailed) {
      const average =
        times.length > 0
          ? Math.round(times.reduce((sum, ms) => sum + ms, 0) / times.length)
          : null

      return {status: 'partial-failed', results, average}
    }

    const average = Math.round(
      times.reduce((sum, ms) => sum + ms, 0) / times.length
    )
    return {status: 'ok', results: times, average}
  } catch {
    return noDataOutcome
  }
}

const formatOutcome = (outcome: Outcome): FormattedOutcome => {
  if (outcome.status === 'no-data') {
    return {plain: 'n/a', colored: 'n/a'}
  }

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

  const times = outcome.results.map(ms => `${ms}ms`).join(', ')
  const average = `avg ${outcome.average}ms`

  return {
    plain: `${times}, ${average}`,
    colored: `${times}, ${chalk.green(average)}`
  }
}

export default class InitialConnectionReporter implements Reporter {
  private readonly resultsByBrowser = new Map<string, Map<string, Outcome>>()

  onTestEnd(test: TestCase, result: TestResult): void {
    const browser = test.parent.project()?.name ?? 'unknown'
    const strategy = test.title.replace(/^Trystero:\s*/, '')
    const browserResults =
      this.resultsByBrowser.get(browser) ?? new Map<string, Outcome>()

    browserResults.set(strategy, toOutcome(result))
    this.resultsByBrowser.set(browser, browserResults)
  }

  onEnd(): void {
    if (this.resultsByBrowser.size === 0) {
      return
    }

    console.log('\nFirst connection times:')
    const browsers = [...this.resultsByBrowser.keys()].sort((a, b) =>
      a.localeCompare(b)
    )

    const rowsByBrowser = new Map<
      string,
      {
        labelText: string
        labelPlainLength: number
        value: FormattedOutcome
      }[]
    >()
    let widestLabelLength = 0
    let widestValueLength = 0

    for (const browser of browsers) {
      const strategyResults = this.resultsByBrowser.get(browser)

      if (!strategyResults) {
        continue
      }

      const rows: {
        labelText: string
        labelPlainLength: number
        value: FormattedOutcome
      }[] = []

      for (const strategy of strategyOrder) {
        const outcome = strategyResults.get(strategy) ?? noDataOutcome
        const value = formatOutcome(outcome)
        const emoji = emojis[strategy as keyof typeof emojis] ?? '•'
        const labelText = `${emoji} ${strategy}`

        rows.push({labelText, labelPlainLength: labelText.length, value})
        widestLabelLength = Math.max(widestLabelLength, labelText.length)
        widestValueLength = Math.max(widestValueLength, value.plain.length)
      }

      rowsByBrowser.set(browser, rows)
    }

    for (const browser of browsers) {
      const rows = rowsByBrowser.get(browser)

      if (!rows) {
        continue
      }

      console.log(`  ${browser}:`)

      for (const {labelText, labelPlainLength, value} of rows) {
        const labelPadding = ' '.repeat(
          Math.max(0, widestLabelLength - labelPlainLength)
        )
        const valuePadding = ' '.repeat(
          Math.max(0, widestValueLength - value.plain.length)
        )

        console.log(
          `    ${labelText}${labelPadding}: ${valuePadding}${value.colored}`
        )
      }
    }
  }
}
