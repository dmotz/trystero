import test, {type TestFn, type TestOptions} from 'node:test'
import {recordTestCompletion} from '../test-completion-log.ts'

const toDuration = (started: number): number => Date.now() - started
const runTest = test as (
  name: string,
  optionsOrFn?: TestOptions | TestFn,
  fn?: TestFn
) => Promise<void>

const wrappedTest = ((
  name: string,
  optionsOrFn?: TestOptions | TestFn,
  maybeFn?: TestFn
) => {
  const hasOptions =
    optionsOrFn !== undefined &&
    typeof optionsOrFn !== 'function' &&
    optionsOrFn !== null
  const options = hasOptions ? optionsOrFn : undefined
  const fn = hasOptions ? maybeFn : optionsOrFn
  const isSkipped =
    typeof options === 'object' &&
    options !== null &&
    'skip' in options &&
    Boolean(options.skip)

  if (isSkipped) {
    recordTestCompletion({
      kind: 'node',
      label: name,
      status: 'skipped',
      duration: 0
    })
    return runTest(name, options)
  }

  if (typeof fn !== 'function') {
    return hasOptions ? runTest(name, options) : runTest(name)
  }

  const run: TestFn = async (...args): Promise<void> => {
    const started = Date.now()

    try {
      await fn(...args)

      recordTestCompletion({
        kind: 'node',
        label: name,
        status: 'passed',
        duration: toDuration(started)
      })
    } catch (err) {
      recordTestCompletion({
        kind: 'node',
        label: name,
        status: 'failed',
        duration: toDuration(started)
      })

      throw err
    }
  }

  return hasOptions ? runTest(name, options, run) : runTest(name, run)
}) as typeof test

export default wrappedTest
