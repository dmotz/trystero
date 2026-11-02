import type {SocketClient} from './internal-types'
import {mkErr, socketInitialFailureSymbol} from './primitives'
import type {BaseRoomConfig, RelayConfig, RelayConnectivity} from './types'
import {entries, fromEntries, keys, noOp, shuffle, strToNum} from './utils'

const {min} = Math
const defaultRetryMs = 3333
const maxRetryMs = 60_000
const socketRetryPeriods: Record<string, number> = {}

type SocketController = {
  disconnect: () => void
  reconnect: () => void
}

const socketControllers = /*@__PURE__*/ new Set<SocketController>()
const keysByRelay = /*@__PURE__*/ new WeakMap<object, string>()
let relayConnectivity: RelayConnectivity = 'auto'
let isRelayOffline = false
let stopWatchingOnline: (() => void) | null = null

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

const holdRelaySockets = (): void => {
  isRelayOffline = true
  socketControllers.forEach(controller => controller.disconnect())
}

const reconnectRelaySockets = (): void => {
  isRelayOffline = false
  keys(socketRetryPeriods).forEach(url => {
    socketRetryPeriods[url] = defaultRetryMs
  })
  socketControllers.forEach(controller => controller.reconnect())
}

const attachOnlineWatcher = (): void => {
  if (stopWatchingOnline || typeof addEventListener !== 'function') {
    return
  }

  const controller = new AbortController()

  addEventListener('online', reconnectRelaySockets, {
    signal: controller.signal
  })
  addEventListener('offline', holdRelaySockets, {
    signal: controller.signal
  })

  stopWatchingOnline = () => controller.abort()
}

const detachOnlineWatcher = (): void => {
  stopWatchingOnline?.()
  stopWatchingOnline = null
}

export const setRelayConnectivity = (
  mode?: RelayConnectivity
): RelayConnectivity => {
  if (mode === undefined) {
    return relayConnectivity
  }

  if (mode !== 'online' && mode !== 'offline' && mode !== 'auto') {
    throw mkErr(`invalid relay connectivity mode "${String(mode)}"`)
  }

  if (mode === 'offline') {
    detachOnlineWatcher()
    relayConnectivity = 'offline'
    holdRelaySockets()
    return relayConnectivity
  }

  if (mode === 'online') {
    detachOnlineWatcher()
    relayConnectivity = 'online'
    reconnectRelaySockets()
    return relayConnectivity
  }

  if (relayConnectivity === 'auto') {
    attachOnlineWatcher()
    return relayConnectivity
  }

  const wasOffline = isRelayOffline
  relayConnectivity = 'auto'
  attachOnlineWatcher()

  if (wasOffline) {
    reconnectRelaySockets()
  }

  return relayConnectivity
}

export const makeSocket = (
  url: string,
  onMessage: (data: string) => void,
  onReconnect?: () => void
): SocketClient => {
  const client = {} as SocketClient
  let didOpen = false
  let isReconnectPending = false
  let initialFailure: Error | null = null
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let resolveReady: (_: SocketClient) => void = noOp
  const initialFailureWaiters = new Set<(err: Error | null) => void>()

  const settleInitialAttempt = (err: Error | null): void => {
    initialFailureWaiters.forEach(waiter => waiter(err))
    initialFailureWaiters.clear()
  }

  client.url = url
  client.isClosed = false
  client.send = noOp
  client.ready = new Promise(res => (resolveReady = res))

  void Object.defineProperty(client.ready, socketInitialFailureSymbol, {
    value: (): Promise<Error | null> => {
      if (didOpen || client.isClosed || isRelayOffline) {
        return Promise.resolve(null)
      }
      if (initialFailure) {
        return Promise.resolve(initialFailure)
      }
      return new Promise<Error | null>(res => {
        initialFailureWaiters.add(res)
      })
    },
    enumerable: false,
    configurable: true
  })

  if (relayConnectivity === 'auto') {
    attachOnlineWatcher()
  }

  const clearRetryTimer = (): void => {
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer)
      retryTimer = undefined
    }
  }

  const detachSocket = (socket: WebSocket | undefined): void => {
    if (!socket) {
      return
    }

    socket.onopen = null
    socket.onclose = null
    socket.onmessage = null
  }

  const init = (): void => {
    if (client.isClosed || isRelayOffline) {
      return
    }

    clearRetryTimer()
    isReconnectPending = false

    const socket = new WebSocket(url)
    client.socket = socket
    client.url = socket.url ?? url

    socket.onclose = () => {
      if (client.isClosed || isReconnectPending || client.socket !== socket) {
        return
      }

      isReconnectPending = true

      if (isRelayOffline) {
        if (!didOpen) {
          settleInitialAttempt(null)
        }
        return
      }

      if (!didOpen) {
        initialFailure = mkErr(`failed to connect to relay ${client.url}`)
        settleInitialAttempt(initialFailure)
      }

      const period = (socketRetryPeriods[url] ??= defaultRetryMs)

      retryTimer = setTimeout(init, Math.random() * period)
      socketRetryPeriods[url] = min(period * 2, maxRetryMs)
    }

    socket.onmessage = e => onMessage(String(e.data))

    socket.onopen = () => {
      if (client.isClosed || client.socket !== socket) {
        return
      }

      const isReconnect = didOpen

      didOpen = true
      initialFailure = null
      settleInitialAttempt(null)
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

  const controller: SocketController = {
    disconnect: () => {
      if (client.isClosed) {
        return
      }

      clearRetryTimer()

      if (!isReconnectPending) {
        isReconnectPending = true
        const socket = client.socket
        detachSocket(socket)
        socket?.close()
      }
    },
    reconnect: () => {
      if (client.isClosed) {
        return
      }

      socketRetryPeriods[url] = defaultRetryMs
      clearRetryTimer()

      if (isReconnectPending) {
        init()
      }
    }
  }

  socketControllers.add(controller)

  client.close = () => {
    client.isClosed = true
    settleInitialAttempt(null)
    socketControllers.delete(controller)
    clearRetryTimer()
    const socket = client.socket
    detachSocket(socket)
    socket?.close()
  }

  if (isRelayOffline) {
    isReconnectPending = true
  } else {
    init()
  }

  return client
}

export type RelayScopedStore<T, TRelay extends object> = {
  forKey: (key: string) => Record<string, T>
  forRelay: (relay: TRelay) => Record<string, T>
}

const getRegisteredRelayKey = (relay: object): string => {
  const key = keysByRelay.get(relay)

  if (!key) {
    throw mkErr('unregistered relay client')
  }

  return key
}

export const createRelayScopedStore = <T, TRelay extends object = SocketClient>(
  resolveKey: (relay: TRelay) => string = getRegisteredRelayKey
): RelayScopedStore<T, TRelay> => {
  const store: Record<string, Record<string, T>> = {}
  const forKey = (key: string): Record<string, T> => (store[key] ??= {})

  return {
    forKey,
    forRelay: relay => forKey(resolveKey(relay))
  }
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
  const localKeys = new WeakMap<TRelay, string>()

  const keyOf = (relay: TRelay): string => {
    const key = localKeys.get(relay)

    if (!key) {
      throw mkErr('unregistered relay client')
    }

    return key
  }

  const store = (key: string, relay: TRelay): TRelay => {
    relays[key] = relay
    localKeys.set(relay, key)
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
    scoped: <T>() => createRelayScopedStore<T, TRelay>(keyOf),
    getSockets: () =>
      fromEntries(
        entries(relays).flatMap(([key, relay]) => {
          const socket = getSocket(relay)

          return socket ? [[key, socket]] : []
        })
      ) as Record<string, WebSocket>
  }
}
