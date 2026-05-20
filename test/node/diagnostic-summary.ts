import {
  getDiagnosticLogs,
  printDiagnosticSummary,
  recordDiagnosticLog,
  type DiagnosticLogLevel
} from '../diagnostic-log.ts'

const originalConsole = {
  debug: console.debug.bind(console),
  error: console.error.bind(console),
  info: console.info.bind(console),
  log: console.log.bind(console),
  warn: console.warn.bind(console)
}
let isPrintingSummary = false

const wrapConsole =
  (level: DiagnosticLogLevel) =>
  (...values: unknown[]): void => {
    originalConsole[level](...values)

    if (isPrintingSummary) {
      return
    }

    recordDiagnosticLog(level, `[node:${level}]`, values)
  }

console.debug = wrapConsole('debug')
console.error = wrapConsole('error')
console.info = wrapConsole('info')
console.log = wrapConsole('log')
console.warn = wrapConsole('warn')

process.on('exit', () => {
  const logs = getDiagnosticLogs()

  if (!logs.length) {
    return
  }

  isPrintingSummary = true
  printDiagnosticSummary(logs)
  isPrintingSummary = false
})
