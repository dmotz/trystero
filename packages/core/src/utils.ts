import type {BaseRoomConfig, RelayConfig, SocketClient} from './types'

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

export const {entries, fromEntries, keys, values} = Object

export const noOp = (): void => {}

export const candidateType = 'candidate'

export const resetTimer = (timer: number | null | undefined): null => {
  if (timer !== null) {
    clearTimeout(timer)
  }

  return null
}

export const mkErr = (msg: string): Error => new Error(`${libName}: ${msg}`)

export const toErrorMessage = (reason: unknown, fallback: string): string => {
  if (reason instanceof Error && reason.message) {
    return reason.message
  }

  if (typeof reason === 'string' && reason) {
    return reason
  }

  return toJson(reason ?? fallback)
}

export const toError = (reason: unknown, fallback: string): Error =>
  reason instanceof Error ? reason : mkErr(toErrorMessage(reason, fallback))

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const encodeBytes = (txt: string): Uint8Array => encoder.encode(txt)

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
): string[] =>
  config.relayUrls ||
  (deriveFromAppId
    ? shuffle(defaults, strToNum(config.appId))
    : defaults
  ).slice(0, config.relayRedundancy ?? defaultN)

export const toJson = JSON.stringify

export const fromJson = <T>(s: string): T => {
  try {
    return JSON.parse(s)
  } catch {
    throw mkErr(`failed to parse JSON: ${s}`)
  }
}

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

type RelayScopedStore<T, TRelay extends object> = {
  forKey: (key: string) => Record<string, T>
  forRelay: (relay: TRelay) => Record<string, T>
}

export const createRelayManager = <TRelay extends object>(
  getSocket: (relay: TRelay) => WebSocket | undefined
): {
  register: (key: string, relay: TRelay) => TRelay
  keyOf: (relay: TRelay) => string
  scoped: <T>() => RelayScopedStore<T, TRelay>
  getSockets: () => Record<string, WebSocket>
} => {
  const relays: Record<string, TRelay> = {}
  const keysByRelay = new WeakMap<TRelay, string>()

  const keyOf = (relay: TRelay): string => {
    const key = keysByRelay.get(relay)

    if (!key) {
      throw mkErr('relay bookkeeping missing registration for relay client')
    }

    return key
  }

  const scoped = <T>(): RelayScopedStore<T, TRelay> => {
    const store: Record<string, Record<string, T>> = {}
    const forKey = (key: string): Record<string, T> => (store[key] ??= {})

    return {
      forKey,
      forRelay: relay => forKey(keyOf(relay))
    }
  }

  return {
    register: (key, relay) => {
      relays[key] = relay
      keysByRelay.set(relay, key)

      return relay
    },
    keyOf,
    scoped,
    getSockets: () =>
      fromEntries(
        entries(relays).flatMap(([key, relay]) => {
          const socket = getSocket(relay)

          return socket ? [[key, socket]] : []
        })
      ) as Record<string, WebSocket>
  }
}

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

export const log = (...args: unknown[]): void => console.log(...args)
