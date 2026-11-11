import {mkErr, type JsonValue} from '@trystero-p2p/core'
import WebSocket, {WebSocketServer} from 'ws'
import {
  parseClientMessage,
  type WsRelayClientMessage,
  type WsRelayServerMessage
} from './protocol'

const unreachable = (x: never): never => {
  throw mkErr(`unreachable: ${String(x)}`)
}

export type {WsRelayClientMessage, WsRelayServerMessage}

export type WsAddressInfo = {
  address: string
  family: string
  port: number
}

export interface WsClientLike {
  readonly readyState: number
  send: (data: string) => void
  close: (code?: number, data?: string) => void
  terminate: () => void
}

export interface WsServerLike {
  readonly clients: ReadonlySet<WsClientLike>
  address: () => WsAddressInfo | string | null
  close: (cb?: (err?: Error) => void) => void
  handleUpgrade: (
    request: object,
    socket: object,
    head: Uint8Array,
    cb: (client: WsClientLike, request: object) => void
  ) => void
  on: (event: string, listener: (...args: unknown[]) => void) => this
  once: (event: string, listener: (...args: unknown[]) => void) => this
  off: (event: string, listener: (...args: unknown[]) => void) => this
}

export type WsRelayServerOptions = {
  host?: string
  port?: number
  backlog?: number
  server?: object
  noServer?: boolean
  path?: string
  clientTracking?: boolean
  perMessageDeflate?: boolean | Record<string, unknown>
  maxPayload?: number
  skipUTF8Validation?: boolean
  handleProtocols?: (protocols: Set<string>, request: object) => string | false
  verifyClient?:
    | ((info: {origin: string; secure: boolean; req: object}) => boolean)
    | ((
        info: {origin: string; secure: boolean; req: object},
        cb: (
          res: boolean,
          code?: number,
          message?: string,
          headers?: Record<string, string | string[]>
        ) => void
      ) => void)
  onError?: (err: Error) => void
  maxTopicLength?: number
  maxSubscriptionsPerSocket?: number
  maxSubscriptions?: number
  maxMessagesPerSecond?: number
  maxBurstMessages?: number
}

export type WsRelayServer = {
  wss: WsServerLike
  ready: Promise<void>
  address: () => WsAddressInfo | string | null
  close: () => Promise<void>
  publish: (topic: string, payload: JsonValue) => void
  getSubscriberCount: (topic?: string) => number
}

const defaultPort = 8080
const validTopicPattern = /^[A-Za-z0-9_-]+$/

type RateBucket = {
  tokens: number
  lastRefillMs: number
}

type ServerLifecycleState =
  | {
      readonly phase: 'starting'
      readonly resolve: () => void
      readonly reject: (err: Error) => void
    }
  | {readonly phase: 'ready'}
  | {readonly phase: 'failed'}
  | {readonly phase: 'closed'; readonly promise: Promise<void>}

type OpenClientSession = {
  readonly phase: 'open'
  readonly topics: Set<string>
  rateBucket: RateBucket | null
}

type ClientSessionState = OpenClientSession | {readonly phase: 'closed'}

const toError = (err: unknown): Error =>
  err instanceof Error ? err : new Error(String(err))

const rawDataToString = (data: WebSocket.RawData): string => {
  if (typeof data === 'string') {
    return data
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8')
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(data)).toString('utf8')
  }

  return data.toString('utf8')
}

export const createWsRelayServer = (
  options: WsRelayServerOptions = {}
): WsRelayServer => {
  const {
    onError,
    maxTopicLength = 256,
    maxSubscriptionsPerSocket = 128,
    maxSubscriptions = 10_000,
    maxMessagesPerSecond = 200,
    maxBurstMessages = Math.max(256, maxMessagesPerSecond * 2),
    ...wsOptions
  } = options
  if (!(maxMessagesPerSecond > 0)) {
    throw new RangeError('maxMessagesPerSecond must be greater than 0')
  }
  if (!(maxBurstMessages > 0)) {
    throw new RangeError('maxBurstMessages must be greater than 0')
  }

  const {
    promise: ready,
    resolve: resolveReady,
    reject: rejectReady
  } = Promise.withResolvers<void>()
  void ready.catch(() => {})

  const serverBox: {state: ServerLifecycleState} = {
    state: {
      phase: 'starting',
      resolve: resolveReady,
      reject: rejectReady
    }
  }

  const markServerReady = (): void => {
    if (serverBox.state.phase === 'starting') {
      const {resolve} = serverBox.state
      serverBox.state = {phase: 'ready'}
      resolve()
    }
  }

  const handleServerError = (err: unknown): void => {
    const error = toError(err)
    if (serverBox.state.phase === 'starting') {
      const {reject} = serverBox.state
      serverBox.state = {phase: 'failed'}
      reject(error)
    }
    onError?.(error)
  }

  const handleClientError = (err: unknown): void => {
    onError?.(toError(err))
  }

  const wss = new WebSocketServer(
    {
      port:
        wsOptions.server || wsOptions.noServer
          ? undefined
          : (wsOptions.port ?? defaultPort),
      maxPayload: 256 * 1024,
      ...(wsOptions as WebSocket.ServerOptions)
    },
    markServerReady
  )
  const topics = new Map<string, Set<WebSocket>>()
  const clientSessions = new WeakMap<WebSocket, ClientSessionState>()
  let subscriptionCount = 0

  if (wsOptions.server || wsOptions.noServer) {
    queueMicrotask(markServerReady)
  }

  const getOpenSession = (socket: WebSocket): OpenClientSession | null => {
    const session = clientSessions.get(socket)
    if (!session || session.phase === 'closed') {
      return null
    }
    return session
  }

  const consumeRateToken = (session: OpenClientSession): boolean => {
    if (maxMessagesPerSecond === Infinity || maxBurstMessages === Infinity) {
      return true
    }
    const now = Date.now()
    let {rateBucket} = session
    if (!rateBucket) {
      rateBucket = {tokens: maxBurstMessages, lastRefillMs: now}
      session.rateBucket = rateBucket
    } else {
      const elapsedSeconds = Math.max(0, now - rateBucket.lastRefillMs) / 1000
      if (elapsedSeconds > 0) {
        rateBucket.tokens = Math.min(
          maxBurstMessages,
          rateBucket.tokens + elapsedSeconds * maxMessagesPerSecond
        )
        rateBucket.lastRefillMs = now
      }
    }
    if (rateBucket.tokens < 1) {
      return false
    }
    rateBucket.tokens -= 1
    return true
  }

  const cleanupSocket = (socket: WebSocket): void => {
    const session = clientSessions.get(socket)
    if (!session || session.phase === 'closed') {
      return
    }

    for (const topic of session.topics) {
      subscriptionCount--
      const subscribers = topics.get(topic)
      if (subscribers) {
        subscribers.delete(socket)
        if (subscribers.size === 0) {
          topics.delete(topic)
        }
      }
    }

    session.topics.clear()
    clientSessions.set(socket, {phase: 'closed'})
  }

  const closeWithPolicyViolation = (
    socket: WebSocket,
    reason: string
  ): void => {
    cleanupSocket(socket)
    socket.close(1008, reason)
  }

  const unsubscribe = (
    socket: WebSocket,
    session: OpenClientSession,
    topic: string
  ): void => {
    if (!session.topics.delete(topic)) {
      return
    }

    subscriptionCount--

    const subscribers = topics.get(topic)
    if (!subscribers) {
      return
    }

    subscribers.delete(socket)

    if (subscribers.size === 0) {
      topics.delete(topic)
    }
  }

  const subscribe = (
    socket: WebSocket,
    session: OpenClientSession,
    topic: string
  ): void => {
    if (session.topics.has(topic)) {
      return
    }

    if (
      session.topics.size >= maxSubscriptionsPerSocket ||
      subscriptionCount >= maxSubscriptions
    ) {
      closeWithPolicyViolation(socket, 'subscription limit exceeded')
      return
    }

    let subscribers = topics.get(topic)

    if (!subscribers) {
      subscribers = new Set()
      topics.set(topic, subscribers)
    }

    subscribers.add(socket)
    session.topics.add(topic)
    subscriptionCount++
  }

  const publish = (topic: string, payload: JsonValue): void => {
    const msg = JSON.stringify({topic, payload} satisfies WsRelayServerMessage)

    topics.get(topic)?.forEach(socket => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(msg)
      }
    })
  }

  wss.on('connection', socket => {
    if (serverBox.state.phase === 'closed') {
      clientSessions.set(socket, {phase: 'closed'})
      socket.close()
      return
    }

    clientSessions.set(socket, {
      phase: 'open',
      topics: new Set(),
      rateBucket: null
    })

    socket.on('message', data => {
      try {
        const session = getOpenSession(socket)
        if (!session || socket.readyState !== WebSocket.OPEN) {
          return
        }

        if (!consumeRateToken(session)) {
          closeWithPolicyViolation(socket, 'rate limit exceeded')
          return
        }

        const msg = parseClientMessage(rawDataToString(data))

        if (!msg) {
          closeWithPolicyViolation(socket, 'invalid message')
          return
        }

        if (
          msg.topic.length > maxTopicLength ||
          !validTopicPattern.test(msg.topic)
        ) {
          closeWithPolicyViolation(socket, 'invalid topic')
          return
        }

        if (msg.type === 'subscribe') {
          subscribe(socket, session, msg.topic)
        } else if (msg.type === 'unsubscribe') {
          unsubscribe(socket, session, msg.topic)
        } else {
          publish(msg.topic, msg.payload)
        }
      } catch (err) {
        handleClientError(err)
      }
    })
    socket.on('close', () => cleanupSocket(socket))
    socket.on('error', handleClientError)
  })
  wss.on('error', handleServerError)

  return {
    wss: wss as unknown as WsServerLike,
    ready,
    address: () => wss.address(),
    close: () => {
      switch (serverBox.state.phase) {
        case 'closed':
          return serverBox.state.promise
        case 'starting':
          serverBox.state.reject(new Error('WebSocket relay server closed'))
          break
        case 'ready':
        case 'failed':
          break
        default:
          return unreachable(serverBox.state)
      }
      const promise = new Promise<void>((resolve, reject) => {
        for (const subscribers of topics.values()) {
          for (const socket of subscribers) {
            cleanupSocket(socket)
            socket.close()
          }
        }
        wss.clients?.forEach(socket => {
          cleanupSocket(socket)
          socket.close()
        })
        wss.close(err => (err ? reject(err) : resolve()))
      })
      serverBox.state = {phase: 'closed', promise}
      return promise
    },
    publish,
    getSubscriberCount: topic =>
      topic ? (topics.get(topic)?.size ?? 0) : subscriptionCount
  }
}
