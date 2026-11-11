import {readFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import type {ConsoleMessage, Page} from '@playwright/test'
import chalk from 'chalk'
import {SourceMapConsumer, type RawSourceMap} from 'source-map'
import {recordDiagnosticLog} from './diagnostic-log'
import type {StrategyName} from './strategy-configs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const projectRoot = join(__dirname, '..')
const sourceMapCache = new Map<string, SourceMapConsumer>()

const colorize = [
  chalk.magenta,
  chalk.yellow,
  chalk.blue,
  chalk.red,
  chalk.green,
  chalk.cyan
]

export const emojis: Record<StrategyName, string> = {
  nostr: '🐦',
  mqtt: '📡',
  torrent: '🌊',
  supabase: '⚡️',
  firebase: '🔥',
  'ws-relay': '🔌'
}

export type BrowserName = 'chromium' | 'webkit' | 'firefox'

export const shortBrowsers: Record<string, string> = {
  chromium: chalk.green('CH'),
  webkit: chalk.blue('WK'),
  firefox: chalk.yellow('FF')
}

const logPrefix = (
  strategy: StrategyName,
  browser: string,
  pageN: number
): string => {
  const colorFn = colorize[(pageN - 1) % colorize.length] ?? chalk.white
  return `${emojis[strategy]} ${colorFn(strategy)} ${shortBrowsers[browser] ?? browser}${pageN}:`
}

const recordPageLog = (
  strategy: StrategyName,
  browser: string,
  pageN: number,
  values: unknown[],
  suffix: string
): void => {
  recordDiagnosticLog('log', logPrefix(strategy, browser, pageN), [
    ...values,
    suffix
  ])
}

const onConsole =
  (strategy: StrategyName, browser: string, pageN: number) =>
  async (msg: ConsoleMessage): Promise<void> => {
    const values: unknown[] = []
    const loc = msg.location()

    for (const arg of msg.args()) {
      try {
        values.push(await arg.jsonValue())
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)

        if (
          message.includes('Target page, context or browser has been closed')
        ) {
          return
        }

        values.push('[Unable to serialize]')
      }
    }

    const text = msg.text()
    const logValues = values.length ? values : [text]

    const originalLoc = await resolveSourceMapLocation(
      loc.url,
      loc.lineNumber,
      loc.columnNumber
    )

    const sourceLocation = `@${originalLoc.lineNumber}:${originalLoc.columnNumber}`
    const sourceFile = originalLoc.url.includes('src/')
      ? originalLoc.url.split('src/').pop()
      : originalLoc.url.split('/').pop()

    const suffix = `(${sourceFile}${sourceLocation})`

    console.log(logPrefix(strategy, browser, pageN), ...logValues, suffix)
    recordPageLog(strategy, browser, pageN, logValues, suffix)
  }

const resolveSourceMapLocation = async (
  url: string,
  lineNumber: number,
  columnNumber: number
): Promise<{url: string; lineNumber: number; columnNumber: number}> => {
  if (!url.includes('/test/dist/trystero-') || !url.endsWith('.js')) {
    return {url, lineNumber, columnNumber}
  }

  try {
    const match = url.match(/trystero-([^.]+)\.js/)

    if (!match) {
      return {url, lineNumber, columnNumber}
    }

    const strategy = match[1]
    const sourceMapPath = join(
      projectRoot,
      'test',
      'dist',
      `trystero-${strategy}.js.map`
    )

    let consumer = sourceMapCache.get(sourceMapPath)

    if (!consumer) {
      const sourceMapContent = readFileSync(sourceMapPath, 'utf-8')
      const sourceMap = JSON.parse(sourceMapContent) as RawSourceMap
      consumer = await new SourceMapConsumer(sourceMap)
      sourceMapCache.set(sourceMapPath, consumer)
    }

    const original = consumer.originalPositionFor({
      line: lineNumber + 1,
      column: columnNumber
    })

    if (original.source) {
      const normalizedSource = original.source.startsWith('../')
        ? original.source.slice(3)
        : original.source

      return {
        url: normalizedSource,
        lineNumber: original.line ? original.line - 1 : lineNumber,
        columnNumber: original.column !== null ? original.column : columnNumber
      }
    }
  } catch {}

  return {url, lineNumber, columnNumber}
}

type CdpPreviewProperty = {
  name: string
  value?: unknown
  type?: string
  valuePreview?: {
    description?: string
    value?: unknown
  }
}

type CdpPreview = {
  subtype?: string
  description?: string
  properties?: CdpPreviewProperty[]
}

type CdpRemoteObject = {
  type?: string
  description?: string
  value?: unknown
  unserializableValue?: string
  preview?: CdpPreview
  objectId?: string
}

type CdpConsoleEvent = {
  type: string
  args?: CdpRemoteObject[]
  stackTrace?: {
    callFrames?: Array<{
      url: string
      lineNumber: number
      columnNumber: number
    }>
  }
}

const previewValue = (prop: CdpPreviewProperty): unknown => {
  if ('value' in prop) {
    return prop.value
  }

  if (prop.valuePreview?.description) {
    return prop.valuePreview.description
  }

  if (prop.valuePreview?.value) {
    return prop.valuePreview.value
  }

  if (prop.type) {
    return prop.type
  }

  return undefined
}

const buildPreviewObject = (preview?: CdpPreview): unknown => {
  if (!preview?.properties?.length) {
    return null
  }

  if (preview.subtype === 'array') {
    const arr: unknown[] & Record<string, unknown> = Object.assign(
      [] as unknown[],
      {} as Record<string, unknown>
    )

    for (const prop of preview.properties) {
      if (prop.name === 'length') {
        continue
      }

      const index = Number(prop.name)

      if (Number.isFinite(index)) {
        arr[index] = previewValue(prop)
      } else {
        arr[prop.name] = previewValue(prop)
      }
    }

    return arr
  }

  const obj: Record<string, unknown> = {}

  for (const prop of preview.properties) {
    obj[prop.name] = previewValue(prop)
  }

  return obj
}

const formatCdpArg = (arg: CdpRemoteObject): unknown => {
  if ('value' in arg && arg.value !== null) {
    return arg.value
  }

  if (arg.unserializableValue) {
    return arg.unserializableValue
  }

  if (arg.preview) {
    const previewObject = buildPreviewObject(arg.preview)

    if (previewObject !== null) {
      return previewObject
    }

    if (arg.preview.description) {
      return arg.preview.description
    }
  }

  if (arg.objectId) {
    return '[Object]'
  }

  return arg.description ?? JSON.stringify(arg)
}

const createCdpConsoleHandler =
  (strategy: StrategyName, browser: string, pageN: number) =>
  async (event: CdpConsoleEvent): Promise<void> => {
    if (!['log', 'info', 'warn', 'error', 'debug'].includes(event.type)) {
      return
    }

    const values =
      event.args?.map(arg => {
        try {
          return formatCdpArg(arg)
        } catch {
          return '[Unable to serialize]'
        }
      }) || []

    const text = values.map(v => String(v)).join(' ')
    const logValues = values.length ? values : [text]

    const callFrame = event.stackTrace?.callFrames?.[0]

    if (!callFrame) {
      console.log(logPrefix(strategy, browser, pageN), ...logValues, '@?:?')
      recordPageLog(strategy, browser, pageN, logValues, '@?:?')
      return
    }

    const originalLoc = await resolveSourceMapLocation(
      callFrame.url,
      callFrame.lineNumber,
      callFrame.columnNumber
    )

    const sourceLocation = `@${originalLoc.lineNumber}:${originalLoc.columnNumber}`
    const sourceFile = originalLoc.url.includes('src/')
      ? originalLoc.url.split('src/').pop()
      : originalLoc.url.split('/').pop()

    const suffix = `(${sourceFile}${sourceLocation})`

    console.log(logPrefix(strategy, browser, pageN), ...logValues, suffix)
    recordPageLog(strategy, browser, pageN, logValues, suffix)
  }

const onError =
  (strategy: StrategyName, browser: string, pageN: number) =>
  (err: Error): void => {
    console.log('❌', logPrefix(strategy, browser, pageN), err)
    recordDiagnosticLog('error', `❌ ${logPrefix(strategy, browser, pageN)}`, [
      err
    ])
  }

export const attachPageLogging = async ({
  strategy,
  browserName,
  pages
}: {
  strategy: StrategyName
  browserName: string
  pages: Page[]
}): Promise<void> => {
  let useCdp = false

  if (browserName === 'chromium') {
    try {
      const sessions = await Promise.all(
        pages.map(page => page.context().newCDPSession(page))
      )

      await Promise.all(sessions.map(session => session.send('Runtime.enable')))

      sessions.forEach((session, index) => {
        session.on(
          'Runtime.consoleAPICalled',
          createCdpConsoleHandler(strategy, browserName, index + 1)
        )
      })

      useCdp = true
    } catch {
      useCdp = false
    }
  }

  if (!useCdp) {
    pages.forEach((page, index) => {
      page.on('console', onConsole(strategy, browserName, index + 1))
    })
  }

  pages.forEach((page, index) => {
    page.on('pageerror', onError(strategy, browserName, index + 1))
  })
}
