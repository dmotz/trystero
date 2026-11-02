import {rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

export default function globalSetup(): void {
  const defaultCompletionLogPath = join(
    tmpdir(),
    `trystero-test-completions-${process.cwd().replaceAll(/\W/g, '_')}.jsonl`
  )
  const diagnosticLogPath = process.env['TRYSTERO_DIAGNOSTIC_LOG_PATH']
  const completionLogPath = process.env['TRYSTERO_TEST_COMPLETION_LOG_PATH']

  if (diagnosticLogPath) {
    rmSync(diagnosticLogPath, {force: true})
  }
  if (completionLogPath) {
    rmSync(completionLogPath, {force: true})
  }
  rmSync(defaultCompletionLogPath, {force: true})
}
