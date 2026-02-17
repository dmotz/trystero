import type {BaseRoomConfig, RelayConfig, SocketClient} from './types.js'

const {floor, random, sin} = Math

export const libName = 'Trystero'

export const alloc = <T>(n: number, f: (v: undefined, i: number) => T): T[] =>
  Array(n).fill(undefined).map(f)

const charSet = '0123456789AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRrSsTtUuVvWwXxYyZz'

export const genId = (n: number): string =>
  alloc(n, () => charSet[floor(random() * charSet.length)] ?? '').join('')

export const selfId = genId(20)

export const all = Promise.all.bind(Promise)

export const isBrowser = typeof window !== 'undefined'

export const entries = Object.entries
export const fromEntries = Object.fromEntries
export const keys = Object.keys
export const values = Object.values

export const noOp = (): void => {}

export const mkErr = (msg: string): Error => new Error(`${libName}: ${msg}`)

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const encodeBytes = (txt: string): Uint8Array =>
  new Uint8Array(encoder.encode(txt))

export const decodeBytes = (
  buffer: ArrayBufferLike | ArrayBufferView
): string => decoder.decode(buffer)

export const toHex = (buffer: Uint8Array): string =>
  buffer.reduce((a, c) => a + c.toString(16).padStart(2, '0'), '')

export const topicPath = (...parts: string[]): string => parts.join('@')

export const shuffle = <T>(xs: readonly T[], seed: number): T[] => {
  const a = [...xs]
  const rand = (): number => {
    const x = sin(seed++) * 10_000
    return x - floor(x)
  }

  let i = a.length

  while (i) {
    const j = floor(rand() * i--)
    const tmp = a[i]
    a[i] = a[j] as T
    a[j] = tmp as T
  }

  return a
}

export const getRelays = <TConfig extends BaseRoomConfig & RelayConfig>(
  config: TConfig,
  defaults: string[],
  defaultN: number,
  deriveFromAppId = false
): string[] => {
  const relayUrls =
    config.relayUrls ??
    (deriveFromAppId ? shuffle(defaults, strToNum(config.appId)) : defaults)

  return relayUrls.slice(
    0,
    config.relayUrls
      ? config.relayUrls.length
      : (config.relayRedundancy ?? defaultN)
  )
}

export const toJson = JSON.stringify

export const fromJson = JSON.parse as <T>(json: string) => T

export const strToNum = (
  str: string,
  limit = Number.MAX_SAFE_INTEGER
): number => str.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % limit

const defaultRetryMs = 3333
const socketRetryPeriods: Record<string, number> = {}

let reconnectionLockingPromise: Promise<void> | null = null
let resolver: (() => void) | null = null

export const pauseRelayReconnection = (): void => {
  if (!reconnectionLockingPromise) {
    reconnectionLockingPromise = new Promise<void>(resolve => {
      resolver = resolve
    }).finally(() => {
      resolver = null
      reconnectionLockingPromise = null
    })
  }
}

export const resumeRelayReconnection = (): void => {
  resolver?.()
}

export const makeSocket = (
  url: string,
  onMessage: (data: string) => void
): SocketClient => {
  const client = {} as SocketClient

  const init = (): void => {
    const socket = new WebSocket(url)

    socket.onclose = () => {
      if (reconnectionLockingPromise) {
        void reconnectionLockingPromise.then(init)
        return
      }

      socketRetryPeriods[url] ??= defaultRetryMs
      setTimeout(init, socketRetryPeriods[url])
      socketRetryPeriods[url] *= 2
    }

    socket.onmessage = e => onMessage(String(e.data))
    client.socket = socket
    client.url = socket.url
    client.ready = new Promise<SocketClient>(
      res =>
        (socket.onopen = () => {
          res(client)
          socketRetryPeriods[url] = defaultRetryMs
        })
    )

    client.send = data => {
      if (socket.readyState === 1) {
        socket.send(data)
      }
    }
  }

  init()

  return client
}

export const socketGetter =
  <T extends {socket: WebSocket}>(
    clientMap: Record<string, T>
  ): (() => Record<string, WebSocket>) =>
  () =>
    fromEntries(
      entries(clientMap).map(([url, client]) => [url, client.socket])
    ) as Record<string, WebSocket>

export const watchOnline = (): (() => void) => {
  if (isBrowser) {
    const controller = new AbortController()

    addEventListener('online', resumeRelayReconnection, {
      signal: controller.signal
    })
    addEventListener('offline', pauseRelayReconnection, {
      signal: controller.signal
    })

    return () => controller.abort()
  }

  return noOp
}
