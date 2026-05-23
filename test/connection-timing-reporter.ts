import type {Reporter, TestCase, TestResult} from '@playwright/test/reporter'
import chalk from 'chalk'
import {emojis} from './logger'
import {strategyConfigs} from './strategy-configs'
import {readTestCompletions} from './test-completion-log'

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

type CompletionStatus = 'passed' | 'failed' | 'skipped'

type Completion = {
  label: string
  status: CompletionStatus
  duration?: number
}

const noDataOutcome: MissingOutcome = {status: 'no-data'}
const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[\\d;]*m`, 'g')

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

const stripAnsi = (value: string): string => value.replaceAll(ansiPattern, '')

const toCompletionStatus = (status: TestResult['status']): CompletionStatus =>
  status === 'passed' ? 'passed' : status === 'skipped' ? 'skipped' : 'failed'

const formatCompletion = ({label, status, duration}: Completion): string => {
  const icon = status === 'passed' ? '✓' : status === 'skipped' ? '-' : '✗'
  const suffix =
    typeof duration === 'number' && Number.isFinite(duration)
      ? ` (${Math.round(duration)}ms)`
      : ''

  return `    ${icon} ${label}${suffix}`
}

const parseNodeCompletion = (line: string): Completion | null => {
  const clean = stripAnsi(line).trim()
  const match =
    /^(✔|✖|﹣)\s+(Trystero:.+?)(?:\s+\(([\d.]+)ms\))?(?:\s+# SKIP)?$/.exec(
      clean
    )

  if (!match) {
    return null
  }

  const [, marker, title, duration] = match
  const status =
    marker === '✔' ? 'passed' : marker === '﹣' ? 'skipped' : 'failed'

  return {
    label: `node: ${title}`,
    status,
    ...(duration ? {duration: Number(duration)} : {})
  }
}

const printCompletionGroup = (
  label: string,
  completions: Completion[]
): void => {
  if (!completions.length) {
    return
  }

  console.log(`  ${label}:`)
  completions.forEach(completion => {
    console.log(formatCompletion(completion))
  })
}

export default class InitialConnectionReporter implements Reporter {
  private readonly resultsByBrowser = new Map<string, Map<string, Outcome>>()
  private readonly browserCompletions = new Map<string, Completion>()
  private readonly nodeCompletions = new Map<string, Completion>()

  onStdOut(chunk: string | Buffer): void {
    this.recordNodeCompletions(chunk)
  }

  onStdErr(chunk: string | Buffer): void {
    this.recordNodeCompletions(chunk)
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const browser = test.parent.project()?.name ?? 'unknown'
    const [, strategy = test.title] =
      /^Trystero:\s*([^:]+)/.exec(test.title) ?? []
    const browserResults =
      this.resultsByBrowser.get(browser) ?? new Map<string, Outcome>()
    const outcome = toOutcome(result)

    if (outcome.status !== 'no-data' || !browserResults.has(strategy)) {
      browserResults.set(strategy, outcome)
    }

    this.resultsByBrowser.set(browser, browserResults)
    this.browserCompletions.set(`${browser}:${test.title}`, {
      label: `${browser}: ${test.title}`,
      status: toCompletionStatus(result.status),
      duration: result.duration
    })
  }

  onEnd(): void {
    this.printCompletionSummary()

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

  private recordNodeCompletions(chunk: string | Buffer): void {
    String(chunk)
      .split(/\r?\n/)
      .map(parseNodeCompletion)
      .filter((completion): completion is Completion => completion !== null)
      .forEach(completion => {
        this.nodeCompletions.set(completion.label, completion)
      })
  }

  private printCompletionSummary(): void {
    const browserCompletions = [...this.browserCompletions.values()].sort(
      (a, b) => a.label.localeCompare(b.label)
    )
    const durableNodeCompletions = readTestCompletions()
      .filter(({kind}) => kind === 'node')
      .map(({label, status, duration}) => ({
        label: `node: ${label}`,
        status,
        ...(duration === undefined ? {} : {duration})
      }))

    durableNodeCompletions.forEach(completion => {
      this.nodeCompletions.set(completion.label, completion)
    })

    const nodeCompletions = [...this.nodeCompletions.values()].sort((a, b) =>
      a.label.localeCompare(b.label)
    )
    const allCompletions = [...browserCompletions, ...nodeCompletions]
    const passed = allCompletions.filter(
      ({status}) => status === 'passed'
    ).length
    const failed = allCompletions.filter(
      ({status}) => status === 'failed'
    ).length
    const skipped = allCompletions.filter(
      ({status}) => status === 'skipped'
    ).length

    console.log('\nTest completion summary:')

    if (!allCompletions.length) {
      console.log('  (no completed tests captured)')
      return
    }

    console.log(
      `  ${passed} passed, ${failed} failed, ${skipped} skipped (${allCompletions.length} total)`
    )
    printCompletionGroup('browser', browserCompletions)
    printCompletionGroup('node', nodeCompletions)
  }
}
