import mqtt from 'mqtt'
import {
  createRelayManager,
  createStrategy,
  getRelays,
  selfId,
  toJson,
  type BaseRoomConfig,
  type JoinRoom,
  type RelayConfig
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
export type MqttRoomConfig = BaseRoomConfig & RelayConfig

export const joinRoom: JoinRoom<MqttRoomConfig> = createStrategy({
  init: config =>
    getRelays(config, defaultRelayUrls, defaultRedundancy).map(url => {
      const client = relayManager.register(url, mqtt.connect(url))
      const handlers = msgHandlers.forRelay(client)

      client
        .on('message', (topic, buffer) =>
          handlers[topic]?.(topic, buffer.toString())
        )
        .on('error', console.error)

      return new Promise<mqtt.MqttClient>(res =>
        client.on('connect', () => res(client))
      )
    }),

  subscribe: (client, rootTopic, selfTopic, onMessage) => {
    const handlers = msgHandlers.forRelay(client)
    const tokens = subscriptionTokens.forRelay(client)
    const refs = subscriptionRefs.forRelay(client)
    const token = Symbol(`${rootTopic}|${selfTopic}`)
    const topicHandler = (topic: string, data: string): void => {
      void onMessage(topic, data, (peerTopic, signal) => {
        client.publish(peerTopic, signal)
      })
    }

    handlers[rootTopic] = topicHandler
    handlers[selfTopic] = topicHandler
    tokens[rootTopic] = token
    tokens[selfTopic] = token

    const incrementTopic = (topic: string): void => {
      refs[topic] = (refs[topic] ?? 0) + 1

      if (refs[topic] === 1) {
        client.subscribe(topic)
      }
    }

    incrementTopic(rootTopic)
    incrementTopic(selfTopic)

    return () => {
      const decrementTopic = (topic: string): void => {
        refs[topic] = Math.max(0, (refs[topic] ?? 1) - 1)

        if (refs[topic] === 0) {
          client.unsubscribe(topic)
          delete refs[topic]
        }
      }

      decrementTopic(rootTopic)
      decrementTopic(selfTopic)

      if (handlers[rootTopic] === topicHandler) {
        delete handlers[rootTopic]
      }

      if (handlers[selfTopic] === topicHandler) {
        delete handlers[selfTopic]
      }

      if (tokens[rootTopic] === token) {
        delete tokens[rootTopic]
      }

      if (tokens[selfTopic] === token) {
        delete tokens[selfTopic]
      }
    }
  },

  announce: (client, rootTopic, _selfTopic, extra) => {
    client.publish(rootTopic, toJson({peerId: selfId, ...extra}))
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
