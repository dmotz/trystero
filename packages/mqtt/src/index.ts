import mqtt from 'mqtt'
import {
  clearUserIdentity,
  createRelayManager,
  createRelayScopedStore,
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

const defaultRedundancy = 4
const endedClients = /*@__PURE__*/ new WeakSet<mqtt.MqttClient>()
const relayManager = /*@__PURE__*/ createRelayManager<mqtt.MqttClient>(
  client =>
    (client.stream as {socket?: WebSocket} | undefined)?.socket as
      | WebSocket
      | undefined,
  client => {
    endedClients.add(client)
    client.end(true)
  },
  client =>
    endedClients.has(client) ||
    Boolean(client.disconnecting || client.disconnected)
)
type TopicState = {
  handlers: Set<(topic: string, data: string) => void | Promise<void>>
  refs: number
  announcement?: string
  ready?: Promise<unknown>
}

const topicStates = /*@__PURE__*/ createRelayScopedStore<
  TopicState,
  mqtt.MqttClient
>()
const warnFlags = /*@__PURE__*/ new WeakMap<mqtt.MqttClient, boolean>()
const pendingBatches = /*@__PURE__*/ new WeakMap<
  mqtt.MqttClient,
  {topics: Set<string>; promise: Promise<unknown>}
>()

const logClientError = (client: mqtt.MqttClient, err: unknown): void => {
  if (warnFlags.get(client) !== false) {
    console.error(err)
  }
}

const ensureSubscribed = (
  client: mqtt.MqttClient,
  states: Record<string, TopicState>,
  topic: string
): Promise<unknown> => {
  const state = states[topic]

  if (!state) {
    return Promise.resolve()
  }

  if (state.ready) {
    return state.ready
  }

  let batch = pendingBatches.get(client)

  if (!batch) {
    const topics = new Set<string>()
    const promise = new Promise<void>(resolve => {
      queueMicrotask(() => {
        pendingBatches.delete(client)
        const activeTopics = [...topics].filter(t => (states[t]?.refs ?? 0) > 0)

        resolve(
          !client.disconnecting &&
            !endedClients.has(client) &&
            activeTopics.length > 0
            ? client.subscribeAsync(activeTopics).then(
                () => {},
                err => logClientError(client, err)
              )
            : undefined
        )
      })
    })
    batch = {topics, promise}
    pendingBatches.set(client, batch)
  }

  batch.topics.add(topic)
  return (state.ready = batch.promise)
}

export type MqttRoomConfig = JoinRoomConfig

export const joinRoom: JoinRoom<MqttRoomConfig> =
  /*@__PURE__*/ createTopicStrategy<mqtt.MqttClient, MqttRoomConfig>({
    init: config =>
      getRelays(config, defaultRelayUrls, defaultRedundancy).map(url => {
        const client = relayManager.register(url, () =>
          mqtt.connect(url, {queueQoSZero: false, resubscribe: false})
        )
        warnFlags.set(client, config.relayConfig?.warnOnRelayFailure !== false)
        const states = topicStates.forRelay(client)

        if (client.listenerCount('message') === 0) {
          client
            .on('message', (topic, buffer) => {
              const payload = buffer.toString()
              states[topic]?.handlers.forEach(
                handler => void handler(topic, payload)
              )
            })
            .on('connect', () => {
              const topics = Object.keys(states).filter(
                topic => (states[topic]?.refs ?? 0) > 0
              )

              if (topics.length === 0) {
                return
              }

              void client
                .subscribeAsync(topics)
                .then(() => {
                  Object.entries(states).forEach(([topic, state]) => {
                    if (state.refs > 0 && state.announcement) {
                      client.publish(topic, state.announcement)
                    }
                  })
                })
                .catch(err => logClientError(client, err))
            })
            .on('error', err => logClientError(client, err))
        }

        if (client.connected) {
          return relayManager.lease(client, Promise.resolve(client))
        }

        let settleInitialFailure = (_err: Error | null): void => {}
        const initialFailureP = new Promise<Error | null>(resolve => {
          settleInitialFailure = err => {
            client.off('error', onInitialError)
            client.off('close', onInitialClose)
            resolve(err)
          }
        })
        const onInitialError = (err: Error): void => {
          settleInitialFailure(err)
        }
        const onInitialClose = (): void => {
          settleInitialFailure(mkErr(`MQTT connection failed: ${url}`))
        }
        client.once('error', onInitialError)
        client.once('close', onInitialClose)

        const readyP = new Promise<mqtt.MqttClient>(res =>
          client.once('connect', () => {
            settleInitialFailure(null)
            res(client)
          })
        ) as Promise<mqtt.MqttClient> & {
          [socketInitialFailureSymbol]?: () => Promise<Error | null>
        }
        readyP[socketInitialFailureSymbol] = () => initialFailureP
        return relayManager.lease(client, readyP)
      }),

    subscribeTopic: (client, topic, onMessage, context) => {
      const states = topicStates.forRelay(client)
      const state = (states[topic] ??= {handlers: new Set(), refs: 0})
      const topicHandler = (topic: string, data: string) =>
        onMessage(topic, data)

      state.handlers.add(topicHandler)
      state.refs += 1

      const cleanup = () => {
        state.handlers.delete(topicHandler)
        state.refs = Math.max(0, state.refs - 1)

        if (state.refs === 0) {
          if (
            state.ready &&
            !client.disconnecting &&
            !endedClients.has(client)
          ) {
            client.unsubscribe(topic)
          }
          delete states[topic]
        }
      }

      // Rooms subscribe to self before root; waiting on root batches
      // all concurrent room SUBSCRIBEs into a single packet before announcing.
      return context.kind === 'root'
        ? Promise.all([
            ensureSubscribed(client, states, context.selfTopic),
            ensureSubscribed(client, states, topic)
          ]).then(() => cleanup)
        : cleanup
    },

    publishTopic: (client, topic, msg, {kind}) => {
      const payload = typeof msg === 'string' ? msg : toJson(msg)

      if (kind === 'announce') {
        const state = topicStates.forRelay(client)[topic]
        if (state && state.refs > 0) {
          state.announcement = payload
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
