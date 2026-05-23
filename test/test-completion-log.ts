import {appendFileSync, readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

export type TestCompletionStatus = 'passed' | 'failed' | 'skipped'

export type TestCompletionLogEntry = {
  kind: 'browser' | 'node'
  label: string
  status: TestCompletionStatus
  duration?: number
}

const defaultCompletionLogPath = join(
  tmpdir(),
  `trystero-test-completions-${process.cwd().replaceAll(/\W/g, '_')}.jsonl`
)
const completionLogPath =
  process.env['TRYSTERO_TEST_COMPLETION_LOG_PATH'] ?? defaultCompletionLogPath
const completionLogPaths = [
  completionLogPath,
  ...(completionLogPath === defaultCompletionLogPath
    ? []
    : [defaultCompletionLogPath])
]

export const recordTestCompletion = (entry: TestCompletionLogEntry): void => {
  if (!completionLogPath) {
    return
  }

  appendFileSync(completionLogPath, JSON.stringify(entry) + '\n')
}

export const readTestCompletions = (): TestCompletionLogEntry[] =>
  completionLogPaths.flatMap(path => {
    try {
      return readFileSync(path, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .flatMap(line => {
          try {
            return [JSON.parse(line) as TestCompletionLogEntry]
          } catch {
            return []
          }
        })
    } catch {
      return []
    }
  })
