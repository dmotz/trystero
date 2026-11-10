import type {BaseRoomConfig, SocketClient, Timeout} from './internal-types'
import {
  createBoundedCache,
  mkErr,
  socketInitialFailureSymbol
} from './primitives'
import type {RelayConfig, RelayConnectivity} from './types'
import {fromEntries, noOp, shuffle, strToNum, unreachable} from './utils'

const {min} = Math
const defaultRetryMs = 3333
const maxRetryMs = 60_000
const socketClosedErr = /*@__PURE__*/ mkErr('relay socket closed')
const socketRetryPeriods = /*@__PURE__*/ createBoundedCache<string, number>(256)

type SocketController = [disconnect: () => void, reconnect: () => void]

type SocketReadyGate = {
  readonly promise: Promise<SocketClient>
  readonly resolve: (value: SocketClient) => void
  readonly reject: (reason: Error) => void
}

type SocketLifecycleState =
  | {readonly phase: 'parked-offline'; readonly didOpen: boolean}
  | {
      readonly phase: 'connecting'
      readonly socket: WebSocket
      readonly didOpen: boolean
    }
  | {readonly phase: 'open'; readonly socket: WebSocket}
  | {
      readonly phase: 'backoff-wait'
      readonly didOpen: boolean
      readonly timer: Timeout
      readonly attemptFailure: Error | null
    }
  | {readonly phase: 'closed'}

const hasLiveSocket = (
  s: SocketLifecycleState
): s is Extract<SocketLifecycleState, {phase: 'connecting' | 'open'}> =>
  s.phase === 'connecting' || s.phase === 'open'

const isSocketDormant = (
  s: SocketLifecycleState
): s is Extract<
  SocketLifecycleState,
  {phase: 'backoff-wait' | 'parked-offline'}
> => s.phase === 'backoff-wait' || s.phase === 'parked-offline'

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

const detachWebSocket = (socket: WebSocket): void => {
  socket.onopen = socket.onclose = socket.onmessage = null
  socket.close()
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
  const failureWaiters = new Set<(err: Error | null) => void>()
  let lifecycle: SocketLifecycleState = {
    phase: 'parked-offline',
    didOpen: false
  }

  const settleAttempt = (err: Error | null): void => {
    failureWaiters.forEach(w => w(err))
    failureWaiters.clear()
  }

  const createReadyGate = (): SocketReadyGate => {
    const {promise, resolve, reject} = Promise.withResolvers<SocketClient>()
    void promise.catch(noOp)
    void Object.defineProperty(promise, socketInitialFailureSymbol, {
      value: (): Promise<Error | null> => {
        if (
          lifecycle.phase === 'open' ||
          lifecycle.phase === 'closed' ||
          isRelayOffline
        ) {
          return Promise.resolve(null)
        }
        if (lifecycle.phase === 'backoff-wait' && lifecycle.attemptFailure) {
          return Promise.resolve(lifecycle.attemptFailure)
        }
        return new Promise<Error | null>(res => {
          failureWaiters.add(res)
        })
      },
      enumerable: false,
      configurable: true
    })
    return {promise, resolve, reject}
  }

  let readyGate = createReadyGate()
  client.ready = readyGate.promise

  const rotateReadyGateAfterDisconnect = (): void => {
    readyGate = createReadyGate()
    client.ready = readyGate.promise
  }

  if (relayConnectivity === 'auto') {
    attachOnlineWatcher()
  }

  const getDidOpen = (
    state: Exclude<SocketLifecycleState, {phase: 'closed'}>
  ): boolean => (state.phase === 'open' ? true : state.didOpen)

  const init = (): void => {
    switch (lifecycle.phase) {
      case 'closed':
      case 'connecting':
      case 'open':
        return
      case 'backoff-wait':
        clearTimeout(lifecycle.timer)
        if (isRelayOffline) {
          lifecycle = {phase: 'parked-offline', didOpen: lifecycle.didOpen}
          return
        }
        break
      case 'parked-offline':
        if (isRelayOffline) {
          return
        }
        break
      default:
        unreachable(lifecycle)
    }

    const didOpen = lifecycle.didOpen
    const socket = new WebSocket(url)
    client.socket = socket
    client.url = socket.url ?? url
    lifecycle = {phase: 'connecting', socket, didOpen}

    socket.onclose = () => {
      if (!hasLiveSocket(lifecycle) || lifecycle.socket !== socket) {
        return
      }
      const wasOpen = lifecycle.phase === 'open'
      const nextDidOpen = getDidOpen(lifecycle)
      client.send = noOp
      if (wasOpen) {
        rotateReadyGateAfterDisconnect()
      }
      if (isRelayOffline) {
        lifecycle = {phase: 'parked-offline', didOpen: nextDidOpen}
        if (!wasOpen) {
          settleAttempt(null)
        }
        return
      }
      const attemptFailure = wasOpen
        ? null
        : mkErr(`failed to connect to relay ${client.url}`)
      if (attemptFailure) {
        settleAttempt(attemptFailure)
      }
      const period = socketRetryPeriods.get(url) ?? defaultRetryMs
      socketRetryPeriods.set(url, period)
      const timer = setTimeout(init, Math.random() * period)
      socketRetryPeriods.set(url, min(period * 2, maxRetryMs))
      lifecycle = {
        phase: 'backoff-wait',
        didOpen: nextDidOpen,
        timer,
        attemptFailure
      }
    }

    socket.onmessage = e => {
      try {
        onMessage(String(e.data))
      } catch {
        // Ignore malformed frames from untrusted signaling relays
      }
    }

    socket.onopen = () => {
      if (lifecycle.phase !== 'connecting' || lifecycle.socket !== socket) {
        return
      }
      const isReconnect = lifecycle.didOpen
      lifecycle = {phase: 'open', socket}
      settleAttempt(null)
      readyGate.resolve(client)
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
      switch (lifecycle.phase) {
        case 'closed':
        case 'parked-offline':
          return
        case 'backoff-wait': {
          clearTimeout(lifecycle.timer)
          lifecycle = {phase: 'parked-offline', didOpen: lifecycle.didOpen}
          settleAttempt(null)
          return
        }
        case 'connecting':
        case 'open': {
          const wasOpen = lifecycle.phase === 'open'
          const didOpen = getDidOpen(lifecycle)
          const activeSocket = lifecycle.socket
          client.send = noOp
          lifecycle = {phase: 'parked-offline', didOpen}
          if (wasOpen) {
            rotateReadyGateAfterDisconnect()
          }
          settleAttempt(null)
          detachWebSocket(activeSocket)
          return
        }
        default:
          unreachable(lifecycle)
      }
    },
    () => {
      if (lifecycle.phase === 'closed') {
        return
      }
      socketRetryPeriods.set(url, defaultRetryMs)
      if (isSocketDormant(lifecycle)) {
        init()
      }
    }
  ]

  socketControllers.add(controller)
  socketWakeFns.set(client, () => {
    if (!isRelayOffline && isSocketDormant(lifecycle)) {
      controller[1]()
    }
  })

  client.close = () => {
    if (lifecycle.phase === 'closed') {
      return
    }
    const prev = lifecycle
    client.isClosed = true
    client.send = noOp
    lifecycle = {phase: 'closed'}
    settleAttempt(null)
    readyGate.reject(socketClosedErr)
    socketControllers.delete(controller)
    socketWakeFns.delete(client)
    socketRetryPeriods.delete(url)
    switch (prev.phase) {
      case 'parked-offline':
        break
      case 'backoff-wait':
        clearTimeout(prev.timer)
        break
      case 'connecting':
      case 'open':
        detachWebSocket(prev.socket)
        break
      default:
        unreachable(prev)
    }
  }

  if (!isRelayOffline) {
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
  const pooledByKey = new Map<string, TRelay>()
  const relayKeys = new WeakMap<TRelay, string>()
  const leaseCounts = new WeakMap<TRelay, number>()
  const closedRelays = new WeakSet<TRelay>()
  const checkClosed = isRelayClosed ?? defaultIsRelayClosed

  const unpool = (relay: TRelay): void => {
    const key = relayKeys.get(relay)
    if (key !== undefined && pooledByKey.get(key) === relay) {
      pooledByKey.delete(key)
    }
  }

  return {
    register: (key, createRelay) => {
      let relay = pooledByKey.get(key)
      if (relay && checkClosed(relay)) {
        unpool(relay)
        leaseCounts.delete(relay)
        relay = undefined
      }
      if (!relay) {
        relay = createRelay()
        pooledByKey.set(key, relay)
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
        const prev = leaseCounts.get(relay)
        if (!prev || prev <= 0) {
          return
        }
        if (prev > 1) {
          leaseCounts.set(relay, prev - 1)
          return
        }
        leaseCounts.delete(relay)
        unpool(relay)
        if (!closedRelays.has(relay) && !checkClosed(relay)) {
          closedRelays.add(relay)
          closeRelay?.(relay)
        }
      })
      return leasedP
    },
    evict: unpool,
    getSockets: () =>
      fromEntries(
        [...pooledByKey.entries()].flatMap(([key, relay]) => {
          const socket = checkClosed(relay) ? undefined : getSocket(relay)
          return socket ? [[key, socket]] : []
        })
      ) as Record<string, WebSocket>
  }
}
