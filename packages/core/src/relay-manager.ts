import type {SocketClient} from './internal-types'
import {
  createBoundedCache,
  mkErr,
  socketInitialFailureSymbol
} from './primitives'
import type {BaseRoomConfig, RelayConfig, RelayConnectivity} from './types'
import {
  entries,
  fromEntries,
  noOp,
  shuffle,
  strToNum,
  unrefTimer
} from './utils'

const {min} = Math
const defaultRetryMs = 3333
const maxRetryMs = 60_000
const socketRetryPeriods = /*@__PURE__*/ createBoundedCache<string, number>(256)

type SocketController = [disconnect: () => void, reconnect: () => void]

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
  socketControllers.forEach(c => c[0]())
}

const reconnectRelaySockets = (): void => {
  isRelayOffline = false
  socketRetryPeriods.clear()
  socketControllers.forEach(c => c[1]())
}

const attachOnlineWatcher = (): void => {
  if (stopWatchingOnline || typeof addEventListener !== 'function') {
    return
  }
  const controller = new AbortController()
  const {signal} = controller
  addEventListener('online', reconnectRelaySockets, {signal})
  addEventListener('offline', holdRelaySockets, {signal})
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
  if (mode === 'auto') {
    const wasOffline = relayConnectivity !== 'auto' && isRelayOffline
    relayConnectivity = 'auto'
    attachOnlineWatcher()
    if (wasOffline) {
      reconnectRelaySockets()
    }
    return relayConnectivity
  }
  detachOnlineWatcher()
  relayConnectivity = mode
  if (mode === 'offline') {
    holdRelaySockets()
  } else {
    reconnectRelaySockets()
  }
  return relayConnectivity
}

export const makeSocket = (
  url: string,
  onMessage: (data: string) => void,
  onReconnect?: () => void
): SocketClient => {
  const client = {
    url,
    isClosed: false,
    send: noOp
  } as unknown as SocketClient
  let didOpen = false
  let isReconnectPending = false
  let initialFailure: Error | null = null
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let resolveReady: (_: SocketClient) => void = noOp
  const initialFailureWaiters = new Set<(err: Error | null) => void>()

  const settleInitialAttempt = (err: Error | null): void => {
    initialFailureWaiters.forEach(w => w(err))
    initialFailureWaiters.clear()
  }

  client.ready = new Promise(res => (resolveReady = res))

  void Object.defineProperty(client.ready, socketInitialFailureSymbol, {
    value: (): Promise<Error | null> =>
      didOpen || client.isClosed || isRelayOffline
        ? Promise.resolve(null)
        : initialFailure
          ? Promise.resolve(initialFailure)
          : new Promise<Error | null>(res => {
              initialFailureWaiters.add(res)
            }),
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

  const closeSocket = (): void => {
    const socket = client.socket
    if (socket) {
      socket.onopen = socket.onclose = socket.onmessage = null
      socket.close()
    }
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
      const period = socketRetryPeriods.get(url) ?? defaultRetryMs
      socketRetryPeriods.set(url, period)
      retryTimer = setTimeout(init, Math.random() * period)
      unrefTimer(retryTimer)
      socketRetryPeriods.set(url, min(period * 2, maxRetryMs))
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
      socketRetryPeriods.set(url, defaultRetryMs)
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

  const controller: SocketController = [
    () => {
      if (!client.isClosed) {
        clearRetryTimer()
        if (!isReconnectPending) {
          isReconnectPending = true
          closeSocket()
        }
      }
    },
    () => {
      if (!client.isClosed) {
        socketRetryPeriods.set(url, defaultRetryMs)
        clearRetryTimer()
        if (isReconnectPending) {
          init()
        }
      }
    }
  ]

  socketControllers.add(controller)

  client.close = () => {
    client.isClosed = true
    settleInitialAttempt(null)
    socketControllers.delete(controller)
    clearRetryTimer()
    closeSocket()
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
  getSockets: () => Record<string, WebSocket>
} => {
  const relays: Record<string, TRelay> = {}

  return {
    register: (key, createRelay) => {
      let relay = relays[key]
      if (!relay) {
        relay = createRelay()
        relays[key] = relay
        keysByRelay.set(relay, key)
      }
      return relay
    },
    getSockets: () =>
      fromEntries(
        entries(relays).flatMap(([key, relay]) => {
          const socket = getSocket(relay)
          return socket ? [[key, socket]] : []
        })
      ) as Record<string, WebSocket>
  }
}
