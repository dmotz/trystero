import type {BaseRoomConfig, SocketClient} from './internal-types'
import {
  createBoundedCache,
  mkErr,
  socketInitialFailureSymbol
} from './primitives'
import type {RelayConfig, RelayConnectivity} from './types'
import {fromEntries, noOp, shuffle, strToNum} from './utils'

const {min} = Math
const defaultRetryMs = 3333
const maxRetryMs = 60_000
const socketRetryPeriods = /*@__PURE__*/ createBoundedCache<string, number>(256)

type SocketController = [disconnect: () => void, reconnect: () => void]

const socketControllers = /*@__PURE__*/ new Set<SocketController>()
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
      socketRetryPeriods.set(url, min(period * 2, maxRetryMs))
    }

    socket.onmessage = e => {
      try {
        onMessage(String(e.data))
      } catch {
        // Ignore malformed frames from untrusted signaling relays
      }
    }

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
  forRelay: (relay: TRelay) => Record<string, T>
}

export const createRelayScopedStore = <
  T,
  TRelay extends object = SocketClient
>(): RelayScopedStore<T, TRelay> => {
  const store = new WeakMap<TRelay, Record<string, T>>()
  return {
    forRelay: relay => {
      let map = store.get(relay)
      if (!map) {
        map = Object.create(null) as Record<string, T>
        store.set(relay, map)
      }
      return map
    }
  }
}

const relayLeaseReleases = /*@__PURE__*/ new WeakMap<object, () => void>()

export const releaseRelayLease = (leaseTarget: unknown): void => {
  if (leaseTarget && typeof leaseTarget === 'object') {
    const release = relayLeaseReleases.get(leaseTarget)
    if (release) {
      relayLeaseReleases.delete(leaseTarget)
      release()
    }
  }
}

export const createRelayManager = <TRelay extends object>(
  getSocket: (relay: TRelay) => WebSocket | undefined,
  closeRelay?: (relay: TRelay) => void
): {
  register: (key: string, createRelay: () => TRelay) => TRelay
  lease: (relay: TRelay, readyP: Promise<TRelay>) => Promise<TRelay>
  evict: (relay: TRelay) => void
  getSockets: () => Record<string, WebSocket>
} => {
  const relays = new Map<string, TRelay>()
  const relayKeys = new WeakMap<TRelay, string>()
  const leaseCounts = new WeakMap<TRelay, number>()

  const evict = (relay: TRelay): void => {
    const key = relayKeys.get(relay)
    if (key !== undefined && relays.get(key) === relay) {
      relays.delete(key)
    }
    leaseCounts.delete(relay)
  }

  return {
    register: (key, createRelay) => {
      let relay = relays.get(key)
      if (!relay) {
        relay = createRelay()
        relays.set(key, relay)
        relayKeys.set(relay, key)
      }
      return relay
    },
    lease: (relay, readyP) => {
      leaseCounts.set(relay, (leaseCounts.get(relay) ?? 0) + 1)
      const leasedP = Promise.resolve(readyP).then(r => r)
      void leasedP.catch(noOp)
      const getInitialFailure = (
        readyP as Promise<TRelay> & {
          [socketInitialFailureSymbol]?: () => Promise<Error | null>
        }
      )[socketInitialFailureSymbol]
      if (typeof getInitialFailure === 'function') {
        void Object.defineProperty(leasedP, socketInitialFailureSymbol, {
          value: getInitialFailure,
          enumerable: false,
          configurable: true
        })
      }
      let released = false
      relayLeaseReleases.set(leasedP, () => {
        if (released) {
          return
        }
        released = true
        if (!leaseCounts.has(relay)) {
          return
        }
        const next = (leaseCounts.get(relay) ?? 1) - 1
        if (next > 0) {
          leaseCounts.set(relay, next)
          return
        }
        evict(relay)
        closeRelay?.(relay)
      })
      return leasedP
    },
    evict,
    getSockets: () =>
      fromEntries(
        [...relays.entries()].flatMap(([key, relay]) => {
          const socket = getSocket(relay)
          return socket ? [[key, socket]] : []
        })
      ) as Record<string, WebSocket>
  }
}
