// @ts-nocheck
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {dirname, join} from 'node:path'
import chalk from 'chalk'
import {SourceMapConsumer} from 'source-map'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const projectRoot = join(__dirname, '..')
const sourceMapCache = new Map()

const colorize = ['magenta', 'yellow', 'blue', 'red', 'green', 'cyan'].map(
  k => chalk[k]
)

export const emojis = {
  nostr: '🐦',
  mqtt: '📡',
  torrent: '🌊',
  supabase: '⚡️',
  firebase: '🔥',
  ipfs: '🪐'
}

export const shortBrowsers = {
  chromium: chalk.green('CH'),
  webkit: chalk.blue('WK'),
  firefox: chalk.yellow('FF')
}

const logPrefix = (strategy, browser, pageN) =>
  `${emojis[strategy]} ${colorize[pageN - 1](strategy)} ${shortBrowsers[browser]}${pageN}:`

const onConsole = (strategy, browser, pageN) => async msg => {
  const values = []
  const loc = msg.location()

  for (const arg of msg.args()) {
    try {
      values.push(await arg.jsonValue())
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)

      if (message.includes('Target page, context or browser has been closed')) {
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

  console.log(
    logPrefix(strategy, browser, pageN),
    ...logValues,
    `(${sourceFile}${sourceLocation})`
  )
}

const resolveSourceMapLocation = async (url, lineNumber, columnNumber) => {
  if (!url.includes('/dist/trystero-') || !url.includes('.min.js')) {
    return {url, lineNumber, columnNumber}
  }

  try {
    const match = url.match(/trystero-([^.]+)\.min\.js/)

    if (!match) {
      return {url, lineNumber, columnNumber}
    }

    const strategy = match[1]
    const sourceMapPath = join(
      projectRoot,
      'dist',
      `trystero-${strategy}.min.js.map`
    )

    let consumer = sourceMapCache.get(sourceMapPath)

    if (!consumer) {
      const sourceMapContent = readFileSync(sourceMapPath, 'utf-8')
      const sourceMap = JSON.parse(sourceMapContent)
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

const previewValue = prop => {
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

const buildPreviewObject = preview => {
  if (!preview?.properties?.length) {
    return null
  }

  if (preview.subtype === 'array') {
    const arr = []

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

  const obj = {}

  for (const prop of preview.properties) {
    obj[prop.name] = previewValue(prop)
  }

  return obj
}

const formatCdpArg = arg => {
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

  return String(arg)
}

const createCdpConsoleHandler = (strategy, browser, pageN) => async event => {
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

  console.log(
    logPrefix(strategy, browser, pageN),
    ...logValues,
    `(${sourceFile}${sourceLocation})`
  )
}

const onError = (strategy, browser, pageN) => err =>
  console.log('❌', logPrefix(strategy, browser, pageN), err)

export const attachPageLogging = async ({strategy, browserName, pages}) => {
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
