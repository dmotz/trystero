import {
  base62Alphabet,
  createBoundedCache,
  createBoundedSet,
  decodeBytes,
  encodeBytes,
  fingerprintLength,
  fromBase64,
  fromBase64Url,
  fromJson,
  hash32,
  libId,
  libName,
  mkErr,
  toBase64,
  toBase64Url,
  toHex,
  toJson
} from './crypto'
import type {
  BaseRoomConfig,
  ListenerOptions,
  RelayConfig,
  RelayConnectivity,
  RoomPlugin,
  SocketClient,
  StatefulListenerOptions,
  Unsubscribe
} from './types'

export {
  createBoundedCache,
  createBoundedSet,
  decodeBytes,
  encodeBytes,
  fromBase64,
  fromBase64Url,
  fromJson,
  libId,
  libName,
  mkErr,
  toBase64,
  toBase64Url,
  toHex,
  toJson
}

export const authMetaKey: string = `__${libId}Auth`
export const internalActionPrefix = '@_'

export const warn = (msg: string): void => console.warn(`${libName}: ${msg}`)

export const warnNoPeer = (id: string): void =>
  warn(`no peer with id ${id} found`)

export const warnEphemeralAdmin = (): void =>
  warn(
    "roles({selfAsAdmin: true}) with an ephemeral identity orphans the room on close; use identity: 'local' or an imported UserIdentity"
  )

export const logErr = (kind: string, err: unknown): void =>
  console.error(`${libName} ${kind} error:`, err)

export const logActionHandlerErr = (err: unknown): void =>
  logErr('action handler', err)

export const peerDisconnectedMsg = 'peer disconnected'
export const peerDisconnectedErr: Error = mkErr(peerDisconnectedMsg)
export const peerBannedMsg = 'peer banned'
export const peerBannedErr: Error = mkErr(peerBannedMsg)
export const peerLeftRoomErr: Error = mkErr('peer left room')
export const roomLeftErr: Error = mkErr('room left')
export const roomFullMsg = 'room full'
export const roomFullErr: Error = mkErr(roomFullMsg)
export const operationAbortedMsg = 'operation aborted'
export const insufficientAuthPrefix = 'insufficient authority'
export const invalidP256KeyErr: Error = mkErr('invalid ECDSA P-256 public key')

export const posSafeIntErr = (name: string): Error =>
  mkErr(`${name} must be a positive safe integer`)

export const requiresRolesErr = (feature: string): Error =>
  mkErr(`${feature} requires roles() in joinRoom config`)

export const selfCertRoomRolesErr: Error = requiresRolesErr(
  'self-certifying room ID'
)

export const actionRedefinedErr = (type: string): Error =>
  mkErr(`action type "${type}" cannot be redefined`)

export const invalidActionMsg = (what: string): string =>
  `invalid action ${what}`

export const noActivePeerMsg = (id: string): string =>
  `no active peer with id ${id}`

export const requiredErr = (field: string): Error =>
  mkErr(`${field} is required`)

const {floor, min} = Math

export const alloc = <T>(n: number, f: (v: undefined, i: number) => T): T[] =>
  Array(n).fill(undefined).map(f)

const base62UnbiasedLimit = 248 // 62 * 4 (largest multiple of 62 <= 256)

export const genId = (n: number): string => {
  if (n <= 0) {
    return ''
  }
  const buf = new Uint8Array(Math.ceil(n * 1.15) + 4)
  let out = ''
  while (out.length < n) {
    crypto.getRandomValues(buf)
    for (let i = 0; i < buf.byteLength && out.length < n; i++) {
      const b = buf[i]!
      if (b < base62UnbiasedLimit) {
        out += base62Alphabet[b % 62]!
      }
    }
  }
  return out
}

export const all: typeof Promise.all = Promise.all.bind(Promise)

export const isBrowser: boolean = typeof window !== 'undefined'

export const entries: typeof Object.entries = Object.entries
export const fromEntries: typeof Object.fromEntries = Object.fromEntries
export const keys: typeof Object.keys = Object.keys
export const values: typeof Object.values = Object.values

export const noOp = (): void => {}

export const candidateType = 'candidate'

export const resetTimer = (
  timer: ReturnType<typeof setTimeout> | null | undefined
): null => {
  if (timer !== null && timer !== undefined) {
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

export const topicPath = (...parts: string[]): string => toJson(parts)

export const shuffle = <T>(xs: readonly T[], seed: number): T[] => {
  const a = [...xs]
  let state = (Math.trunc(seed) || 1) >>> 0
  const rand = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000
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
  limit: number = Number.MAX_SAFE_INTEGER
): number => hash32(str) % limit

const defaultRetryMs = 3333
const maxRetryMs = 60_000
const socketRetryPeriods: Record<string, number> = {}

type SocketController = {
  disconnect: () => void
  reconnect: () => void
}

const socketControllers = new Set<SocketController>()
let relayConnectivity: RelayConnectivity = 'auto'
let isRelayOffline = false
let stopWatchingOnline: (() => void) | null = null

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

const socketInitialFailureResolvers = new WeakMap<
  Promise<unknown>,
  () => Promise<Error | null>
>()

export const getSocketInitialFailure = (
  ready: Promise<unknown>
): Promise<Error | null> | undefined =>
  socketInitialFailureResolvers.get(ready)?.()

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

  socketInitialFailureResolvers.set(client.ready, () => {
    if (didOpen || client.isClosed || isRelayOffline) {
      return Promise.resolve(null)
    }
    if (initialFailure) {
      return Promise.resolve(initialFailure)
    }
    return new Promise<Error | null>(res => {
      initialFailureWaiters.add(res)
    })
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
      throw mkErr('unregistered relay client')
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

export const log = (...args: unknown[]): void => console.log(...args)

export const fingerprintRegex: RegExp = new RegExp(
  `^[0-9A-Za-z]{${fingerprintLength}}$`
)

export const selfCertifyingRoomRegex: RegExp = new RegExp(
  `^(.+)~([0-9A-Za-z]{${fingerprintLength}})$`
)

export const reservedRoomPropertyNames: Set<string> = new Set([
  'ready',
  'makeAction',
  'leave',
  'ping',
  'getPeers',
  'getUsers',
  'getSelf',
  'addStream',
  'removeStream',
  'replaceTrack',
  'onPeerJoin',
  'onPeerLeave',
  'onUserJoin',
  'onUserLeave',
  'onPeerStream',
  'onError'
])

export const lockMethods = <T extends object>(
  target: T,
  methodNames: readonly (keyof T & string)[]
): T => {
  for (const name of methodNames) {
    Object.defineProperty(target, name, {
      value: target[name],
      writable: false,
      enumerable: true,
      configurable: false
    })
  }
  return target
}

export type EventEmitter<Args extends unknown[]> = {
  subscribe: (
    handler: (...args: Args) => unknown,
    options?: StatefulListenerOptions,
    getReplayItems?: () => Iterable<Args>
  ) => Unsubscribe
  emit: (...args: Args) => void
  hasListeners: () => boolean
  clear: () => void
}

export const createEventEmitter = <Args extends unknown[]>(
  kind: string,
  onActiveChange?: (active: boolean) => void
): EventEmitter<Args> => {
  const subs = new Set<{
    call: (...args: Args) => void
    unsub: () => void
  }>()

  const invoke = (handler: (...args: Args) => unknown, args: Args): void => {
    try {
      const res = handler(...args)
      if (res && typeof (res as PromiseLike<unknown>).then === 'function') {
        void Promise.resolve(res).catch(err => logErr(kind, err))
      }
    } catch (err) {
      logErr(kind, err)
    }
  }

  const subscribe = (
    handler: (...args: Args) => unknown,
    options?: StatefulListenerOptions,
    getReplayItems?: () => Iterable<Args>
  ): Unsubscribe => {
    if (typeof handler !== 'function') {
      const label = kind.endsWith('handler') ? kind : `${kind} handler`
      throw mkErr(`${label} must be a function`)
    }
    const signal = options?.signal
    if (signal?.aborted) {
      return noOp
    }
    const once = Boolean(options?.once)
    let active = true
    let added = false
    const entry = {
      call: (...args: Args): void => {
        if (!active) {
          return
        }
        if (once) {
          unsub()
        }
        invoke(handler, args)
      },
      unsub: noOp
    }
    const unsub: Unsubscribe = () => {
      if (!active) {
        return
      }
      active = false
      signal?.removeEventListener('abort', unsub)
      if (added && subs.delete(entry) && subs.size === 0) {
        onActiveChange?.(false)
      }
    }
    entry.unsub = unsub
    signal?.addEventListener('abort', unsub, {once: true})

    if (options?.replay && getReplayItems) {
      for (const item of getReplayItems()) {
        if (!active) {
          break
        }
        if (once) {
          unsub()
        }
        invoke(handler, item)
      }
    }

    if (active) {
      const wasEmpty = subs.size === 0
      added = true
      subs.add(entry)
      if (wasEmpty) {
        onActiveChange?.(true)
      }
    }

    return unsub
  }

  return {
    subscribe,
    emit: (...args: Args): void => {
      for (const sub of Array.from(subs)) {
        sub.call(...args)
      }
    },
    hasListeners: (): boolean => subs.size > 0,
    clear: (): void => {
      for (const sub of Array.from(subs)) {
        sub.unsub()
      }
    }
  }
}

export type SingleHandler<F extends (...args: any[]) => any> = {
  set: (handler: F, options?: ListenerOptions) => Unsubscribe
  get: () => F | null
  clear: () => void
}

export const createSingleHandler = <F extends (...args: any[]) => any>(
  name: string,
  onChange?: (handler: F | null) => void
): SingleHandler<F> => {
  let current: {call: F; unsub: () => void} | null = null

  const set = (handler: F, options?: ListenerOptions): Unsubscribe => {
    if (typeof handler !== 'function') {
      throw mkErr(`${name} handler must be a function`)
    }
    const signal = options?.signal
    if (signal?.aborted) {
      return noOp
    }
    if (current) {
      throw mkErr(`${name} handler already registered; unsubscribe first`)
    }
    const once = Boolean(options?.once)
    let active = true
    const unsub: Unsubscribe = () => {
      if (!active) {
        return
      }
      active = false
      signal?.removeEventListener('abort', unsub)
      if (current === entry) {
        current = null
        onChange?.(null)
      }
    }
    const call = ((...args: Parameters<F>): ReturnType<F> => {
      if (!active) {
        throw mkErr(`${name} handler is no longer active`)
      }
      if (once) {
        unsub()
      }
      return handler(...args)
    }) as F
    const entry = {call, unsub}
    current = entry
    signal?.addEventListener('abort', unsub, {once: true})
    onChange?.(call)
    return unsub
  }

  return {
    set,
    get: (): F | null => current?.call ?? null,
    clear: (): void => current?.unsub()
  }
}

const reservedPluginNameErr = (name: string): Error =>
  mkErr(`plugin name "${name}" is a reserved room property`)

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
    throw reservedPluginNameErr(name)
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
      throw mkErr('invalid plugin in use[]; use definePlugin()')
    }
    if (reservedRoomPropertyNames.has(item.name)) {
      throw reservedPluginNameErr(item.name)
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
