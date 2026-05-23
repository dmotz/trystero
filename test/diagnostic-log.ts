import {appendFileSync} from 'node:fs'
import {inspect} from 'node:util'

export type DiagnosticLogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug'

export type DiagnosticLogEntry = {
  level: DiagnosticLogLevel
  scope: string
  message: string
}

const entries: DiagnosticLogEntry[] = []
const logPath = process.env['TRYSTERO_DIAGNOSTIC_LOG_PATH']

const formatValue = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : inspect(value, {breakLength: Infinity, colors: true, depth: 4})

export const formatDiagnosticMessage = (values: unknown[]): string =>
  values.map(formatValue).join(' ')

export const recordDiagnosticLog = (
  level: DiagnosticLogLevel,
  scope: string,
  values: unknown[]
): void => {
  const entry = {
    level,
    scope,
    message: formatDiagnosticMessage(values)
  }

  entries.push(entry)

  if (logPath) {
    appendFileSync(logPath, JSON.stringify(entry) + '\n')
  }
}

export const getDiagnosticLogs = (): DiagnosticLogEntry[] => entries.slice()

export const clearDiagnosticLogs = (): void => {
  entries.length = 0
}

export const printDiagnosticSummary = (
  logs: DiagnosticLogEntry[] = getDiagnosticLogs()
): void => {
  if (!logs.length) {
    return
  }

  console.log('\nDiagnostic log summary:')

  logs.forEach(({scope, message}) => {
    console.log(`  ${scope} ${message}`)
  })
}
