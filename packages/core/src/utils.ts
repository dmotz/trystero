import {
  createBoundedCache,
  createBoundedSet,
  decodeBytes,
  encodeBytes,
  fromBase64,
  fromBase64Url,
  fromJson,
  libName,
  mkErr,
  toBase64,
  toBase64Url,
  toHex,
  toJson
} from './crypto'
import type {
  BaseRoomConfig,
  RelayConfig,
  RoomPlugin,
  SocketClient
} from './types'

export {
  createBoundedCache,
  createBoundedSet,
  decodeBytes,
  encodeBytes,
  fromBase64,
  fromBase64Url,
  fromJson,
  libName,
  mkErr,
  toBase64,
  toBase64Url,
  toHex,
  toJson
}

const {floor, min, sin} = Math

export const alloc = <T>(n: number, f: (v: undefined, i: number) => T): T[] =>
  Array(n).fill(undefined).map(f)

const charSet = '0123456789AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRrSsTtUuVvWwXxYyZz'

export const genId = (n: number): string => {
  if (n <= 0) {
    return ''
  }
  const bytes = crypto.getRandomValues(new Uint8Array(n))
  let out = ''
  for (let i = 0; i < n; i++) {
    out += charSet[bytes[i]! % charSet.length]!
  }
  return out
}

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

export const getRelays = <
  TConfig extends BaseRoomConfig & {relayConfig?: RelayConfig}
>(
  config: TConfig,
  defaults: string[],
  defaultN: number,
  deriveFromAppId = false
): string[] =>
  config.relayConfig?.urls ||
  (deriveFromAppId
    ? shuffle(defaults, strToNum(config.appId))
    : defaults
  ).slice(0, config.relayConfig?.redundancy ?? defaultN)

export const strToNum = (
  str: string,
  limit = Number.MAX_SAFE_INTEGER
): number => str.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % limit

const defaultRetryMs = 3333
const maxRetryMs = 60_000
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
  onMessage: (data: string) => void,
  onReconnect?: () => void
): SocketClient => {
  const client = {} as SocketClient
  let didOpen = false
  let isReconnectPending = false
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let resolveReady: (_: SocketClient) => void = noOp

  client.isClosed = false
  client.ready = new Promise(res => (resolveReady = res))

  const init = (): void => {
    if (client.isClosed) {
      return
    }

    retryTimer = undefined
    isReconnectPending = false

    const socket = new WebSocket(url)

    socket.onclose = () => {
      if (client.isClosed || isReconnectPending) {
        return
      }

      isReconnectPending = true

      if (reconnectionLockingPromise) {
        void reconnectionLockingPromise.then(init)
        return
      }

      const period = (socketRetryPeriods[url] ??= defaultRetryMs)

      retryTimer = setTimeout(init, Math.random() * period)
      socketRetryPeriods[url] = min(period * 2, maxRetryMs)
    }

    socket.onmessage = e => onMessage(String(e.data))
    client.socket = socket
    client.url = socket.url

    socket.onopen = () => {
      const isReconnect = didOpen

      didOpen = true
      resolveReady(client)
      socketRetryPeriods[url] = defaultRetryMs

      if (isReconnect) {
        onReconnect?.()
      }
    }

    client.send = data => {
      if (socket.readyState === 1) {
        socket.send(data)
      }
    }
  }

  client.close = () => {
    client.isClosed = true

    if (retryTimer !== undefined) {
      clearTimeout(retryTimer)
      retryTimer = undefined
    }

    client.socket.close()
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
  register: (key: string, createRelay: () => TRelay) => TRelay
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

  const store = (key: string, relay: TRelay): TRelay => {
    relays[key] = relay
    keysByRelay.set(relay, key)

    return relay
  }

  return {
    register: (key, createRelay) => {
      const relay = relays[key]

      if (relay) {
        return relay
      }

      return store(key, createRelay())
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

export const selfCertifyingRoomRegex = /^(.*)\.~([0-9A-Za-z]{16})$/

export const reservedRoomPropertyNames = new Set([
  'makeAction',
  'leave',
  'ping',
  'isPassive',
  'getPeers',
  'getUsers',
  'getSelf',
  'addStream',
  'removeStream',
  'addTrack',
  'removeTrack',
  'replaceTrack',
  'onPeerJoin',
  'onPeerLeave',
  'onUserJoin',
  'onUserLeave',
  'onPeerStream',
  'onPeerTrack'
])

export const definePlugin = <
  TName extends string = string,
  TApi extends Record<string, unknown> = Record<string, never>
>(
  name: TName,
  spec: {
    resolveRoomId?:
      | ((context: {
          appId: string
          roomId: string
          userIdentityP: Promise<import('./types').UserIdentity>
        }) => Promise<{effectiveRoomId: string; state?: unknown}> | undefined)
      | undefined
    setup: (
      kernel: import('./types').RoomKernel,
      preResolvedState?: unknown
    ) => TApi | void
  }
): RoomPlugin<TName, TApi> => {
  if (!name || typeof name !== 'string') {
    throw mkErr('plugin name must be a non-empty string')
  }
  if (reservedRoomPropertyNames.has(name)) {
    throw mkErr(`plugin name "${name}" is a reserved room property`)
  }
  if (!spec || typeof spec.setup !== 'function') {
    throw mkErr(`plugin "${name}" must provide a setup(kernel) function`)
  }
  return {
    name,
    ...(spec.resolveRoomId ? {resolveRoomId: spec.resolveRoomId} : {}),
    setup: spec.setup
  }
}

export const getConfiguredPlugins = (
  use?: readonly RoomPlugin<string, any>[]
): RoomPlugin<string, any>[] => {
  if (use === undefined) {
    return []
  }
  if (!Array.isArray(use)) {
    throw mkErr('use must be an array of room plugins')
  }
  const byName = new Map<string, RoomPlugin<string, any>>()
  for (const item of use) {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof item.name !== 'string' ||
      !item.name ||
      typeof item.setup !== 'function'
    ) {
      throw mkErr(
        'invalid plugin in use[]; expected a plugin created with definePlugin()'
      )
    }
    if (reservedRoomPropertyNames.has(item.name)) {
      throw mkErr(`plugin name "${item.name}" is a reserved room property`)
    }
    if (byName.has(item.name)) {
      throw mkErr(`duplicate plugin "${item.name}" in use[]`)
    }
    byName.set(item.name, item)
  }
  const ordered: RoomPlugin<string, any>[] = []
  const rolesPlugin = byName.get('roles')
  if (rolesPlugin) {
    ordered.push(rolesPlugin)
    byName.delete('roles')
  }
  const scalePlugin = byName.get('scale')
  if (scalePlugin) {
    ordered.push(scalePlugin)
    byName.delete('scale')
  }
  for (const p of byName.values()) {
    ordered.push(p)
  }
  return ordered
}
