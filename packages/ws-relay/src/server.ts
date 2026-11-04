import type {JsonValue} from '@trystero-p2p/core'
import WebSocket, {WebSocketServer} from 'ws'
import {
  parseClientMessage,
  type WsRelayClientMessage,
  type WsRelayServerMessage
} from './protocol'

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
  let resolveReady = (): void => {}
  let rejectReady = (_err: Error): void => {}
  let didSettleReady = false
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const reportError = (err: unknown): void => {
    const error = toError(err)

    if (!didSettleReady) {
      didSettleReady = true
      rejectReady(error)
    }

    onError?.(error)
  }
  const resolveReadyOnce = (): void => {
    if (!didSettleReady) {
      didSettleReady = true
      resolveReady()
    }
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
    resolveReadyOnce
  )
  const topics = new Map<string, Set<WebSocket>>()
  const socketTopics = new WeakMap<WebSocket, Set<string>>()
  const socketRateBuckets = new WeakMap<WebSocket, RateBucket>()
  let subscriptionCount = 0

  if (wsOptions.server || wsOptions.noServer) {
    queueMicrotask(resolveReadyOnce)
  }

  const consumeRateToken = (socket: WebSocket): boolean => {
    if (maxMessagesPerSecond === Infinity || maxBurstMessages === Infinity) {
      return true
    }
    const now = Date.now()
    let bucket = socketRateBuckets.get(socket)
    if (!bucket) {
      bucket = {tokens: maxBurstMessages, lastRefillMs: now}
      socketRateBuckets.set(socket, bucket)
    } else {
      const elapsedSeconds = Math.max(0, now - bucket.lastRefillMs) / 1000
      if (elapsedSeconds > 0) {
        bucket.tokens = Math.min(
          maxBurstMessages,
          bucket.tokens + elapsedSeconds * maxMessagesPerSecond
        )
        bucket.lastRefillMs = now
      }
    }
    if (bucket.tokens < 1) {
      return false
    }
    bucket.tokens -= 1
    return true
  }

  const unsubscribe = (socket: WebSocket, topic: string): void => {
    if (!socketTopics.get(socket)?.delete(topic)) {
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

  const subscribe = (socket: WebSocket, topic: string): void => {
    let subscriptions = socketTopics.get(socket)

    if (subscriptions?.has(topic)) {
      return
    }

    if (
      (subscriptions?.size ?? 0) >= maxSubscriptionsPerSocket ||
      subscriptionCount >= maxSubscriptions
    ) {
      socket.close(1008, 'subscription limit exceeded')
      return
    }

    let subscribers = topics.get(topic)

    if (!subscribers) {
      subscribers = new Set()
      topics.set(topic, subscribers)
    }

    subscribers.add(socket)

    if (!subscriptions) {
      subscriptions = new Set()
      socketTopics.set(socket, subscriptions)
    }

    subscriptions.add(topic)
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

  const cleanup = (socket: WebSocket): void => {
    socketTopics.get(socket)?.forEach(topic => unsubscribe(socket, topic))
    socketTopics.delete(socket)
    socketRateBuckets.delete(socket)
  }

  wss.on('connection', socket => {
    socket.on('message', data => {
      try {
        if (socket.readyState !== WebSocket.OPEN) {
          return
        }

        if (!consumeRateToken(socket)) {
          socket.close(1008, 'rate limit exceeded')
          return
        }

        const msg = parseClientMessage(rawDataToString(data))

        if (!msg) {
          socket.close(1008, 'invalid message')
          return
        }

        if (
          msg.topic.length > maxTopicLength ||
          !validTopicPattern.test(msg.topic)
        ) {
          socket.close(1008, 'invalid topic')
          return
        }

        if (msg.type === 'subscribe') {
          subscribe(socket, msg.topic)
        } else if (msg.type === 'unsubscribe') {
          unsubscribe(socket, msg.topic)
        } else {
          publish(msg.topic, msg.payload)
        }
      } catch (err) {
        reportError(err)
      }
    })
    socket.on('close', () => cleanup(socket))
    socket.on('error', reportError)
  })
  wss.on('error', reportError)

  return {
    wss: wss as unknown as WsServerLike,
    ready,
    address: () => wss.address(),
    close: () =>
      new Promise((resolve, reject) => {
        wss.clients.forEach(socket => socket.close())
        wss.close(err => (err ? reject(err) : resolve()))
      }),
    publish,
    getSubscriberCount: topic =>
      topic ? (topics.get(topic)?.size ?? 0) : subscriptionCount
  }
}
