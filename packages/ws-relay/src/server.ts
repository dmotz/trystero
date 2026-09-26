import WebSocket, {WebSocketServer} from 'ws'

type JsonPrimitive = null | string | number | boolean
type JsonValue = JsonPrimitive | JsonValue[] | {[key: string]: JsonValue}

export type WsRelayClientMessage =
  | {type: 'subscribe'; topic: string}
  | {type: 'unsubscribe'; topic: string}
  | {type: 'publish'; topic: string; payload: JsonValue}

export type WsRelayServerMessage = {
  topic: string
  payload: JsonValue
}

export type WsRelayServerOptions = WebSocket.ServerOptions & {
  port?: number
  onError?: (err: Error) => void
  maxTopicLength?: number
  maxSubscriptionsPerSocket?: number
  maxSubscriptions?: number
}

export type WsRelayServer = {
  wss: WebSocketServer
  ready: Promise<void>
  address: () => WebSocket.AddressInfo | string | null
  close: () => Promise<void>
  publish: (topic: string, payload: JsonValue) => void
  getSubscriberCount: (topic?: string) => number
}

const defaultPort = 8080

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isPayload = (value: unknown): value is JsonValue =>
  value === null ||
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'boolean' ||
  Array.isArray(value) ||
  isRecord(value)

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

const parseClientMessage = (
  data: WebSocket.RawData
): WsRelayClientMessage | null => {
  const msg = JSON.parse(rawDataToString(data)) as Partial<WsRelayClientMessage>

  if (!isRecord(msg) || typeof msg.topic !== 'string') {
    return null
  }

  if (msg.type === 'subscribe' || msg.type === 'unsubscribe') {
    return {type: msg.type, topic: msg.topic}
  }

  if (msg.type === 'publish' && isPayload(msg.payload)) {
    return {type: 'publish', topic: msg.topic, payload: msg.payload}
  }

  return null
}

export const createWsRelayServer = (
  options: WsRelayServerOptions = {}
): WsRelayServer => {
  const {
    onError,
    maxTopicLength = 256,
    maxSubscriptionsPerSocket = 128,
    maxSubscriptions = 10_000,
    ...wsOptions
  } = options
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
      port: wsOptions.server ? undefined : (wsOptions.port ?? defaultPort),
      maxPayload: 1024 * 1024,
      ...wsOptions
    },
    resolveReadyOnce
  )
  const topics = new Map<string, Set<WebSocket>>()
  const socketTopics = new WeakMap<WebSocket, Set<string>>()
  let subscriptionCount = 0

  if (wsOptions.server || wsOptions.noServer) {
    queueMicrotask(resolveReadyOnce)
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
  }

  wss.on('connection', socket => {
    socket.on('message', data => {
      try {
        if (socket.readyState !== WebSocket.OPEN) {
          return
        }

        const msg = parseClientMessage(data)

        if (!msg) {
          return
        }

        if (msg.topic.length > maxTopicLength) {
          socket.close(1008, 'topic too long')
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
    wss,
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
