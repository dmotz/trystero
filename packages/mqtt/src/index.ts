import mqtt from 'mqtt'
import {
  clearUserIdentity,
  createRelayManager,
  createTopicStrategy,
  createUserIdentity,
  exportUserIdentity,
  getRelays,
  importUserIdentity,
  mkErr,
  roles,
  scale,
  socketInitialFailureSymbol,
  toJson,
  type JoinRoom,
  type JoinRoomConfig
} from '@trystero-p2p/core'

const unreachable = (x: never): never => {
  throw mkErr(`unreachable: ${String(x)}`)
}

type TopicHandler = (topic: string, data: string) => void | Promise<void>

type TopicSubscriptionState =
  | {readonly phase: 'local-only'}
  | {readonly phase: 'batch-queued'; readonly promise: Promise<void>}
  | {readonly phase: 'subscribing'; readonly promise: Promise<void>}
  | {readonly phase: 'subscribed'}
  | {readonly phase: 'failed'}

type TopicEntry = {
  handlers: Set<TopicHandler>
  refs: number
  announcement: string | null
  subscription: TopicSubscriptionState
}

type PendingSubscribeBatch = {
  readonly topics: Set<string>
  readonly promise: Promise<void>
}

type MqttClientSession = {
  ended: boolean
  warnOnFailure: boolean
  listenersAttached: boolean
  pendingBatch: PendingSubscribeBatch | null
  onEndCleanups: Set<() => void>
  topics: Record<string, TopicEntry>
}

const defaultRedundancy = 4
const clientSessions = /*@__PURE__*/ new WeakMap<
  mqtt.MqttClient,
  MqttClientSession
>()

const getClientSession = (client: mqtt.MqttClient): MqttClientSession => {
  let session = clientSessions.get(client)
  if (!session) {
    session = {
      ended: false,
      warnOnFailure: true,
      listenersAttached: false,
      pendingBatch: null,
      onEndCleanups: new Set(),
      topics: Object.create(null) as Record<string, TopicEntry>
    }
    clientSessions.set(client, session)
  }
  return session
}

const relayManager = /*@__PURE__*/ createRelayManager<mqtt.MqttClient>(
  client =>
    (client.stream as {socket?: WebSocket} | undefined)?.socket as
      | WebSocket
      | undefined,
  client => {
    const session = getClientSession(client)
    session.ended = true
    session.onEndCleanups.forEach(fn => fn())
    session.onEndCleanups.clear()
    client.end(true)
  },
  client =>
    Boolean(
      clientSessions.get(client)?.ended ||
      client.disconnecting ||
      client.disconnected
    )
)

const logClientError = (session: MqttClientSession, err: unknown): void => {
  if (session.warnOnFailure) {
    console.error(err)
  }
}

const runSubscribeBatch = (
  client: mqtt.MqttClient,
  session: MqttClientSession,
  topicsToSubscribe: string[],
  replayAnnouncementsOnSuccess: boolean
): Promise<void> => {
  if (topicsToSubscribe.length === 0) {
    return Promise.resolve()
  }

  if (!client.connected || client.disconnecting || session.ended) {
    topicsToSubscribe.forEach(topic => {
      const entry = session.topics[topic]
      if (!entry) {
        return
      }
      if (entry.refs === 0) {
        delete session.topics[topic]
        return
      }
      entry.subscription = {phase: 'failed'}
    })
    return Promise.resolve()
  }

  const {promise: subPromise, resolve: resolveSub} =
    Promise.withResolvers<void>()

  topicsToSubscribe.forEach(topic => {
    const entry = session.topics[topic]
    if (entry) {
      entry.subscription = {phase: 'subscribing', promise: subPromise}
    }
  })

  void client.subscribeAsync(topicsToSubscribe).then(
    () => {
      topicsToSubscribe.forEach(topic => {
        const entry = session.topics[topic]
        if (!entry) {
          return
        }
        if (entry.refs === 0) {
          delete session.topics[topic]
          if (!client.disconnecting && !session.ended) {
            client.unsubscribe(topic)
          }
          return
        }
        if (
          entry.subscription.phase === 'subscribing' &&
          entry.subscription.promise === subPromise
        ) {
          entry.subscription = {phase: 'subscribed'}
        }
        if (
          replayAnnouncementsOnSuccess &&
          entry.announcement !== null &&
          client.connected
        ) {
          client.publish(topic, entry.announcement)
        }
      })
      resolveSub()
    },
    err => {
      logClientError(session, err)
      topicsToSubscribe.forEach(topic => {
        const entry = session.topics[topic]
        if (!entry) {
          return
        }
        if (entry.refs === 0) {
          delete session.topics[topic]
          return
        }
        if (
          entry.subscription.phase === 'subscribing' &&
          entry.subscription.promise === subPromise
        ) {
          entry.subscription = {phase: 'failed'}
        }
      })
      resolveSub()
    }
  )

  return subPromise
}

const ensureSubscribed = (
  client: mqtt.MqttClient,
  session: MqttClientSession,
  topic: string
): Promise<void> => {
  const entry = session.topics[topic]
  if (!entry || entry.refs <= 0) {
    return Promise.resolve()
  }

  switch (entry.subscription.phase) {
    case 'subscribed':
      return Promise.resolve()
    case 'batch-queued':
    case 'subscribing':
      return entry.subscription.promise
    case 'local-only':
    case 'failed':
      break
    default:
      return unreachable(entry.subscription)
  }

  let batch = session.pendingBatch
  if (!batch) {
    const topics = new Set<string>()
    const {promise, resolve} = Promise.withResolvers<void>()
    batch = {topics, promise}
    session.pendingBatch = batch

    queueMicrotask(() => {
      if (session.pendingBatch?.promise === promise) {
        session.pendingBatch = null
      }
      const activeTopics: string[] = []
      const concurrentPromises: Array<Promise<void>> = []

      topics.forEach(queuedTopic => {
        const current = session.topics[queuedTopic]
        if (!current || current.refs <= 0) {
          if (current && current.subscription.phase !== 'subscribing') {
            delete session.topics[queuedTopic]
          }
          return
        }

        switch (current.subscription.phase) {
          case 'batch-queued':
            if (current.subscription.promise === promise) {
              activeTopics.push(queuedTopic)
            } else {
              concurrentPromises.push(current.subscription.promise)
            }
            return
          case 'subscribing':
            concurrentPromises.push(current.subscription.promise)
            return
          case 'local-only':
          case 'failed':
            activeTopics.push(queuedTopic)
            return
          case 'subscribed':
            return
          default:
            unreachable(current.subscription)
        }
      })

      const subP = runSubscribeBatch(client, session, activeTopics, false)
      if (concurrentPromises.length === 0) {
        resolve(subP)
        return
      }
      resolve(Promise.all([subP, ...concurrentPromises]).then(() => {}))
    })
  }

  batch.topics.add(topic)
  entry.subscription = {phase: 'batch-queued', promise: batch.promise}
  return batch.promise
}

export type MqttRoomConfig = JoinRoomConfig

export const joinRoom: JoinRoom<MqttRoomConfig> =
  /*@__PURE__*/ createTopicStrategy<mqtt.MqttClient, MqttRoomConfig>({
    init: config =>
      getRelays(config, defaultRelayUrls, defaultRedundancy).map(url => {
        const client = relayManager.register(url, () =>
          mqtt.connect(url, {queueQoSZero: false, resubscribe: false})
        )
        const session = getClientSession(client)
        session.warnOnFailure = config.relayConfig?.warnOnRelayFailure !== false

        if (!session.listenersAttached) {
          session.listenersAttached = true
          client
            .on('message', (topic, buffer) => {
              const payload = buffer.toString()
              session.topics[topic]?.handlers.forEach(
                handler => void handler(topic, payload)
              )
            })
            .on('connect', () => {
              const topics = Object.keys(session.topics).filter(
                topic => (session.topics[topic]?.refs ?? 0) > 0
              )
              void runSubscribeBatch(client, session, topics, true)
            })
            .on('error', err => logClientError(session, err))
        }

        if (client.connected) {
          return relayManager.lease(client, Promise.resolve(client))
        }

        let initialSettled = false
        const {promise: initialFailureP, resolve: resolveInitialFailure} =
          Promise.withResolvers<Error | null>()
        const settleInitial = (err: Error | null): void => {
          if (initialSettled) {
            return
          }
          initialSettled = true
          client.off('error', onInitialError)
          client.off('close', onInitialClose)
          resolveInitialFailure(err)
        }
        const onInitialError = (err: Error): void => settleInitial(err)
        const onInitialClose = (): void =>
          settleInitial(mkErr(`MQTT connection failed: ${url}`))

        client.once('error', onInitialError)
        client.once('close', onInitialClose)

        // Keep readyP pending across transient initial failures so mqtt.js
        // background reconnects self-heal the slot (matching makeSocket).
        const readyP = new Promise<mqtt.MqttClient>(resolve => {
          const onConnect = (): void => {
            session.onEndCleanups.delete(detachConnect)
            settleInitial(null)
            resolve(client)
          }
          const detachConnect = (): void => {
            client.off('connect', onConnect)
            settleInitial(mkErr(`MQTT connection closed: ${url}`))
          }
          session.onEndCleanups.add(detachConnect)
          client.once('connect', onConnect)
        }) as Promise<mqtt.MqttClient> & {
          [socketInitialFailureSymbol]?: () => Promise<Error | null>
        }
        readyP[socketInitialFailureSymbol] = () => initialFailureP
        return relayManager.lease(client, readyP)
      }),

    subscribeTopic: (client, topic, onMessage, context) => {
      const session = getClientSession(client)
      const entry = (session.topics[topic] ??= {
        handlers: new Set(),
        refs: 0,
        announcement: null,
        subscription: {phase: 'local-only'}
      })
      const topicHandler: TopicHandler = (receivedTopic, data) =>
        onMessage(receivedTopic, data)

      entry.handlers.add(topicHandler)
      entry.refs += 1

      const cleanup = (): void => {
        if (!entry.handlers.delete(topicHandler)) {
          return
        }
        entry.refs = Math.max(0, entry.refs - 1)

        if (entry.refs > 0) {
          return
        }

        entry.announcement = null

        switch (entry.subscription.phase) {
          case 'local-only':
          case 'batch-queued':
          case 'failed':
            if (session.topics[topic] === entry) {
              delete session.topics[topic]
            }
            return
          case 'subscribed':
            if (session.topics[topic] === entry) {
              delete session.topics[topic]
            }
            if (!client.disconnecting && !session.ended) {
              client.unsubscribe(topic)
            }
            return
          case 'subscribing':
            // Leave entry in session.topics with refs === 0 so runSubscribeBatch
            // settles the in-flight SUBSCRIBE first and then unsubscribes cleanly
            // if refs is still 0.
            return
          default:
            unreachable(entry.subscription)
        }
      }

      // Rooms subscribe to self before root; waiting on root batches
      // all concurrent room SUBSCRIBEs into a single packet before announcing.
      return context.kind === 'root'
        ? Promise.all([
            ensureSubscribed(client, session, context.selfTopic),
            ensureSubscribed(client, session, topic)
          ]).then(() => cleanup)
        : cleanup
    },

    publishTopic: (client, topic, msg, {kind}) => {
      const payload = typeof msg === 'string' ? msg : toJson(msg)

      if (kind === 'announce') {
        const entry = getClientSession(client).topics[topic]
        if (entry && entry.refs > 0) {
          entry.announcement = payload
        }
      }

      if (client.connected) {
        client.publish(topic, payload)
      }
    }
  })

export const getRelaySockets = (): Record<string, WebSocket> =>
  relayManager.getSockets()

export {
  clearUserIdentity,
  createUserIdentity,
  exportUserIdentity,
  importUserIdentity,
  roles,
  scale
}
export type * from '@trystero-p2p/core/types'

export const defaultRelayUrls: string[] = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://public:public@public.cloud.shiftr.io',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt'
]
