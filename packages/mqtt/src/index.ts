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
const msgHandlers = relayManager.scoped<(topic: string, data: string) => void>()
const subscriptionTokens = relayManager.scoped<symbol>()
const subscriptionRefs = relayManager.scoped<number>()
const announcementMessages = relayManager.scoped<string>()
const subscriptionReady = relayManager.scoped<Promise<unknown>>()
export type MqttRoomConfig = JoinRoomConfig

export const joinRoom: JoinRoom<MqttRoomConfig> = createTopicStrategy({
  init: config =>
    getRelays(config, defaultRelayUrls, defaultRedundancy).map(url => {
      const client = relayManager.register(url, () =>
        mqtt.connect(url, {queueQoSZero: false, resubscribe: false})
      )
      const handlers = msgHandlers.forRelay(client)

      if (client.listenerCount('message') === 0) {
        client
          .on('message', (topic, buffer) =>
            handlers[topic]?.(topic, buffer.toString())
          )
          .on('connect', () => {
            const topics = Object.keys(subscriptionRefs.forRelay(client))

            if (topics.length === 0) {
              return
            }

            void client
              .subscribeAsync(topics)
              .then(() => {
                Object.entries(announcementMessages.forRelay(client)).forEach(
                  ([topic, msg]) => client.publish(topic, msg)
                )
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
    const handlers = msgHandlers.forRelay(client)
    const tokens = subscriptionTokens.forRelay(client)
    const refs = subscriptionRefs.forRelay(client)
    const token = Symbol(topic)
    const topicHandler = (topic: string, data: string) => onMessage(topic, data)

    handlers[topic] = topicHandler
    tokens[topic] = token
    refs[topic] = (refs[topic] ?? 0) + 1

    if (refs[topic] === 1) {
      subscriptionReady.forRelay(client)[topic] = client.subscribeAsync(topic)
      void subscriptionReady.forRelay(client)[topic]?.catch(console.error)
    }

    if (context.kind === 'root') {
      // Queue both SUBSCRIBEs before the initial publish, without two network
      // round trips. Replay once they're confirmed if discovery raced setup.
      void Promise.all([
        subscriptionReady.forRelay(client)[context.selfTopic],
        subscriptionReady.forRelay(client)[topic]
      ])
        .then(() => {
          const payload = announcementMessages.forRelay(client)[topic]
          if (tokens[topic] === token && client.connected && payload) {
            client.publish(topic, payload)
          }
        })
        .catch(console.error)
    }

    return () => {
      refs[topic] = Math.max(0, (refs[topic] ?? 1) - 1)

      if (refs[topic] === 0) {
        client.unsubscribe(topic)
        delete refs[topic]
        delete announcementMessages.forRelay(client)[topic]
        delete subscriptionReady.forRelay(client)[topic]
      }

      if (handlers[topic] === topicHandler) {
        delete handlers[topic]
      }

      if (tokens[topic] === token) {
        delete tokens[topic]
      }
    }
  },

  publishTopic: (client, topic, msg, {kind}) => {
    const payload = typeof msg === 'string' ? msg : toJson(msg)

    if (kind === 'announce') {
      announcementMessages.forRelay(client)[topic] = payload
    }

    if (client.connected) {
      client.publish(topic, payload)
    }
  }
})

export const getRelaySockets = relayManager.getSockets

export {selfId}

export const defaultRelayUrls = [
  'test.mosquitto.org:8081/mqtt',
  'broker.emqx.io:8084/mqtt',
  'public:public@public.cloud.shiftr.io',
  'broker-cn.emqx.io:8084/mqtt',
  'broker.hivemq.com:8884/mqtt'
].map(url => 'wss://' + url)

export type * from '@trystero-p2p/core'
