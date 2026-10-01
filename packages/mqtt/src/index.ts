import mqtt from 'mqtt'
import {
  createRelayManager,
  createTopicStrategy,
  getRelays,
  selfId,
  toJson,
  type JoinRoom,
  type JoinRoomConfig
} from '@trystero-p2p/core'

const defaultRedundancy = 4
const relayManager = createRelayManager<mqtt.MqttClient>(
  client =>
    (client.stream as {socket?: WebSocket} | undefined)?.socket as
      | WebSocket
      | undefined
)
type TopicState = {
  handler?: (topic: string, data: string) => void
  token?: symbol
  refs: number
  announcement?: string
  ready?: Promise<unknown>
}

const topicStates = relayManager.scoped<TopicState>()
const pendingBatches = new WeakMap<
  mqtt.MqttClient,
  {topics: Set<string>; promise: Promise<unknown>}
>()

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
          activeTopics.length > 0
            ? client.subscribeAsync(activeTopics).then(
                () => {},
                err => console.error(err)
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

export const joinRoom: JoinRoom<MqttRoomConfig> = createTopicStrategy({
  init: config =>
    getRelays(config, defaultRelayUrls, defaultRedundancy).map(url => {
      const client = relayManager.register(url, () =>
        mqtt.connect(url, {queueQoSZero: false, resubscribe: false})
      )
      const states = topicStates.forRelay(client)

      if (client.listenerCount('message') === 0) {
        client
          .on('message', (topic, buffer) =>
            states[topic]?.handler?.(topic, buffer.toString())
          )
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
                  if (state.announcement) {
                    client.publish(topic, state.announcement)
                  }
                })
              })
              .catch(console.error)
          })
          .on('error', console.error)
      }

      return client.connected
        ? Promise.resolve(client)
        : new Promise<mqtt.MqttClient>(res =>
            client.once('connect', () => res(client))
          )
    }),

  subscribeTopic: (client, topic, onMessage, context) => {
    const states = topicStates.forRelay(client)
    const state = (states[topic] ??= {refs: 0})
    const token = Symbol(topic)
    const topicHandler = (topic: string, data: string) => onMessage(topic, data)

    state.handler = topicHandler
    state.token = token
    state.refs += 1

    const cleanup = () => {
      state.refs = Math.max(0, state.refs - 1)

      if (state.handler === topicHandler) {
        delete state.handler
      }

      if (state.token === token) {
        delete state.token
      }

      if (state.refs === 0) {
        if (state.ready) {
          client.unsubscribe(topic)
        }
        delete states[topic]
      }
    }

    // Active rooms subscribe to self before root; waiting on root batches
    // all concurrent room SUBSCRIBEs into a single packet before announcing.
    return context.kind === 'root'
      ? Promise.all([
          ensureSubscribed(client, states, context.selfTopic),
          ensureSubscribed(client, states, topic)
        ]).then(() => cleanup)
      : states[context.rootTopic]
        ? ensureSubscribed(client, states, topic).then(() => cleanup)
        : cleanup
  },

  publishTopic: (client, topic, msg, {kind}) => {
    const payload = typeof msg === 'string' ? msg : toJson(msg)

    if (kind === 'announce') {
      ;(topicStates.forRelay(client)[topic] ??= {refs: 0}).announcement =
        payload
    }

    if (client.connected) {
      client.publish(topic, payload)
    }
  },

  unpublishTopic: (client, topic) => {
    delete topicStates.forRelay(client)[topic]?.announcement
  }
})

export const getRelaySockets = relayManager.getSockets

export {selfId}

export const defaultRelayUrls = [
  'test.mosquitto.org:8081/mqtt',
  'broker.emqx.io:8084/mqtt',
  'public:public@public.cloud.shiftr.io',
  'broker.hivemq.com:8884/mqtt'
].map(url => 'wss://' + url)

export type * from '@trystero-p2p/core'
