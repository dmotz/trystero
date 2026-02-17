import mqtt from 'mqtt'
import {
  createStrategy,
  getRelays,
  selfId,
  toJson,
  type BaseRoomConfig,
  type JoinRoom,
  type RelayConfig
} from '@trystero/core'

const sockets: Record<string, WebSocket> = {}
const defaultRedundancy = 4
const msgHandlers: Record<
  string,
  Record<string, ((topic: string, data: string) => void) | undefined>
> = {}
const subscriptionTokens: Record<string, Record<string, symbol>> = {}
const subscriptionRefs: Record<string, Record<string, number>> = {}
export type MqttRoomConfig = BaseRoomConfig & RelayConfig

const getClientId = (client: mqtt.MqttClient): string => {
  const options = client.options as mqtt.IClientOptions & {
    host?: string
    path?: string
  }
  return `${options.host ?? ''}${options.path ?? ''}`
}

export const joinRoom: JoinRoom<MqttRoomConfig> = createStrategy({
  init: config =>
    getRelays(config, defaultRelayUrls, defaultRedundancy).map(url => {
      const client = mqtt.connect(url)
      const clientId = getClientId(client)
      const handlers = (msgHandlers[clientId] ??= {})

      sockets[clientId] = client.stream.socket as WebSocket

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
    const clientId = getClientId(client)
    const handlers = (msgHandlers[clientId] ??= {})
    const tokens = (subscriptionTokens[clientId] ??= {})
    const refs = (subscriptionRefs[clientId] ??= {})
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

  announce: (client, rootTopic) => {
    client.publish(rootTopic, toJson({peerId: selfId}))
  }
})

export const getRelaySockets = (): Record<string, WebSocket> => ({...sockets})

export {selfId}

export const defaultRelayUrls = [
  'test.mosquitto.org:8081/mqtt',
  'broker.emqx.io:8084/mqtt',
  'public:public@public.cloud.shiftr.io',
  'broker-cn.emqx.io:8084/mqtt',
  'broker.hivemq.com:8884/mqtt'
].map(url => 'wss://' + url)

export type * from '@trystero/core'
