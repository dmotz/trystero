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
const socketWakeFns = /*@__PURE__*/ new WeakMap<object, () => void>()
const defaultIsRelayClosed = (relay: object): boolean =>
  Boolean((relay as {isClosed?: boolean}).isClosed)
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
  if (
    typeof document !== 'undefined' &&
    typeof document.addEventListener === 'function'
  ) {
    document.addEventListener(
      'visibilitychange',
      () => {
        if (!isRelayOffline && document.visibilityState === 'visible') {
          reconnectRelaySockets()
        }
      },
      {signal}
    )
  }
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
  let isSocketOpen = false
  let isReconnectPending = false
  let attemptFailure: Error | null = null
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let resolveReady: (value: SocketClient) => void = noOp
  const failureWaiters = new Set<(err: Error | null) => void>()

  const settleAttempt = (err: Error | null): void => {
    failureWaiters.forEach(w => w(err))
    failureWaiters.clear()
  }

  const resetReadyPromise = (): void => {
    const {promise, resolve} = Promise.withResolvers<SocketClient>()
    resolveReady = resolve
    void Object.defineProperty(promise, socketInitialFailureSymbol, {
      value: (): Promise<Error | null> =>
        isSocketOpen || client.isClosed || isRelayOffline
          ? Promise.resolve(null)
          : attemptFailure
            ? Promise.resolve(attemptFailure)
            : new Promise<Error | null>(res => {
                failureWaiters.add(res)
              }),
      enumerable: false,
      configurable: true
    })
    client.ready = promise
  }

  resetReadyPromise()

  if (relayConnectivity === 'auto') {
    attachOnlineWatcher()
  }

  const clearRetryTimer = (): void => {
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer)
      retryTimer = undefined
    }
  }

  const markDisconnected = (): void => {
    if (isSocketOpen) {
      isSocketOpen = false
      if (!client.isClosed) {
        resetReadyPromise()
      }
    }
  }

  const closeSocket = (): void => {
    const socket = client.socket
    markDisconnected()
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
    attemptFailure = null

    const socket = new WebSocket(url)
    client.socket = socket
    client.url = socket.url ?? url

    socket.onclose = () => {
      if (client.isClosed || isReconnectPending || client.socket !== socket) {
        return
      }
      const wasOpen = isSocketOpen
      markDisconnected()
      isReconnectPending = true
      if (isRelayOffline) {
        if (!wasOpen) {
          settleAttempt(null)
        }
        return
      }
      if (!wasOpen) {
        attemptFailure = mkErr(`failed to connect to relay ${client.url}`)
        settleAttempt(attemptFailure)
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
      isSocketOpen = true
      attemptFailure = null
      settleAttempt(null)
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
        attemptFailure = null
        settleAttempt(null)
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
  socketWakeFns.set(client, () => {
    if (!client.isClosed && !isRelayOffline && isReconnectPending) {
      controller[1]()
    }
  })

  client.close = () => {
    client.isClosed = true
    attemptFailure = null
    settleAttempt(null)
    socketControllers.delete(controller)
    socketWakeFns.delete(client)
    socketRetryPeriods.delete(url)
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
  closeRelay?: (relay: TRelay) => void,
  isRelayClosed?: (relay: TRelay) => boolean
): {
  register: (key: string, createRelay: () => TRelay) => TRelay
  lease: (relay: TRelay, readyP: Promise<TRelay>) => Promise<TRelay>
  evict: (relay: TRelay) => void
  getSockets: () => Record<string, WebSocket>
} => {
  const relays = new Map<string, TRelay>()
  const relayKeys = new WeakMap<TRelay, string>()
  const leaseCounts = new WeakMap<TRelay, number>()
  const checkClosed = isRelayClosed ?? defaultIsRelayClosed

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
      if (relay && checkClosed(relay)) {
        evict(relay)
        relay = undefined
      }
      if (!relay) {
        relay = createRelay()
        relays.set(key, relay)
        relayKeys.set(relay, key)
      } else {
        socketWakeFns.get(relay)?.()
      }
      return relay
    },
    lease: (relay, readyP) => {
      socketWakeFns.get(relay)?.()
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
          const socket = checkClosed(relay) ? undefined : getSocket(relay)
          return socket ? [[key, socket]] : []
        })
      ) as Record<string, WebSocket>
  }
}
