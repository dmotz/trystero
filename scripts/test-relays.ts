import chalk from 'chalk'
import mqtt from 'mqtt'
import WebSocket from 'ws'
import {genId} from '@trystero/core'
import {defaultRelayUrls as mqttRelays} from '@trystero/mqtt'
import {
  createEvent,
  defaultRelayUrls as nostrRelays,
  subscribe
} from '@trystero/nostr'
import {defaultRelayUrls as torrentRelays} from '@trystero/torrent'

const timeLimitMs = 5_000

type RelayStrategy = 'mqtt' | 'nostr' | 'torrent'

const asString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback

const rawDataToString = (rawData: WebSocket.RawData): string => {
  if (typeof rawData === 'string') {
    return rawData
  }

  if (rawData instanceof ArrayBuffer) {
    return Buffer.from(rawData).toString()
  }

  if (Array.isArray(rawData)) {
    const chunks = rawData.map(chunk =>
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    )
    return Buffer.concat(chunks).toString()
  }

  return rawData.toString()
}

const toErrMsg = (error: unknown): string => {
  if (typeof error === 'string') {
    return error
  }

  if (error instanceof Error) {
    return error.message
  }

  return 'unknown error'
}

const formatRelayOutput = (
  url: string,
  startMs: number,
  error?: unknown
): string => {
  const prefix = error ? '❌' : '✅'
  const elapsed = String(Date.now() - startMs).padStart(4)
  const relay = url.replace(/^wss:\/\//, '')

  return error
    ? `${prefix} ${elapsed}ms ${relay} - (${chalk.red(toErrMsg(error))})`
    : `${prefix} ${elapsed}ms ${relay}`
}

const testMqttRelay = async (url: string): Promise<string> => {
  const startMs = Date.now()
  const client = mqtt.connect(url)
  let timeout: ReturnType<typeof setTimeout> | null = null

  try {
    await new Promise<void>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('timeout')), timeLimitMs)
      client.on('connect', () => resolve())
      client.on('error', error => reject(error))
    })

    return formatRelayOutput(url, startMs)
  } catch (error) {
    return formatRelayOutput(url, startMs, error)
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }

    client.end()
  }
}

const testSocketRelay = async (
  url: string,
  strategy: Exclude<RelayStrategy, 'mqtt'>
): Promise<string> => {
  const startMs = Date.now()
  const socket = new WebSocket(url)
  let timeout: ReturnType<typeof setTimeout> | null = null

  try {
    await new Promise<void>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('timeout')), timeLimitMs)

      socket.on('open', async () => {
        if (strategy !== 'nostr') {
          resolve()
          return
        }

        const topic = genId(64)
        const content = Math.random().toString(36)
        const subId = genId(64)

        socket.on('message', (rawMsg: WebSocket.RawData) => {
          try {
            const msg = JSON.parse(rawDataToString(rawMsg)) as unknown[]
            const event = asString(msg[0])

            if (event === 'CLOSED') {
              reject(new Error(asString(msg[2], 'closed')))
              return
            }

            if (event === 'OK') {
              const isOk = Boolean(msg[2])

              if (!isOk) {
                reject(new Error(asString(msg[3], 'unknown error')))
                return
              }

              socket.send(subscribe(subId, topic))
              return
            }

            if (event === 'EOSE') {
              resolve()
            }
          } catch {
            reject(new Error('failed to parse nostr response'))
          }
        })

        socket.send(await createEvent(topic, content))
      })

      socket.on('error', (error: Error) =>
        reject(new Error(`connection error: ${toErrMsg(error)}`))
      )
    })

    return formatRelayOutput(url, startMs)
  } catch (error) {
    return formatRelayOutput(url, startMs, error)
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }

    socket.close()
  }
}

const testRelay = (url: string, strategy: RelayStrategy): Promise<string> =>
  strategy === 'mqtt' ? testMqttRelay(url) : testSocketRelay(url, strategy)

const testRelays = async (
  strategy: RelayStrategy,
  relays: string[]
): Promise<[RelayStrategy, string[]]> => [
  strategy,
  await Promise.all(relays.map(url => testRelay(url, strategy)))
]

const relayGroups: Record<RelayStrategy, string[]> = {
  nostr: nostrRelays,
  mqtt: mqttRelays,
  torrent: torrentRelays
}

const results = await Promise.all(
  Object.entries(relayGroups).map(([strategy, relays]) =>
    testRelays(strategy as RelayStrategy, relays)
  )
)

results.forEach(([strategy, lines]) => {
  console.log(`${strategy.toUpperCase()}:`)
  console.log(lines.join('\n'))
  console.log('')
})

process.exit(0)
