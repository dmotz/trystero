import {
  createRelayManager,
  createRelayScopedStore,
  createTopicStrategy,
  makeSocket,
  setRelayConnectivity,
  toJson,
  type BaseRoomConfig,
  type JoinRoom,
  type RelayConfig,
  type RelayConnectivity,
  type SocketClient,
  type StrategyMessage
} from '@trystero-p2p/core'
import {parseServerMessage, type WsRelayClientMessage} from './protocol'

const relayManager = /*@__PURE__*/ createRelayManager<SocketClient>(
  client => client.socket
)
const msgHandlers =
  /*@__PURE__*/ createRelayScopedStore<
    Set<(topic: string, data: StrategyMessage) => void>
  >()
const announcementMessages =
  /*@__PURE__*/ createRelayScopedStore<StrategyMessage>()

export type WsRelayConfig = Omit<RelayConfig, 'urls' | 'redundancy'> & {
  urls: string[]
}

export type WsRelayRoomConfig = BaseRoomConfig & {
  relayConfig: WsRelayConfig
}

const publish = (
  topic: string,
  payload: StrategyMessage
): WsRelayClientMessage<StrategyMessage> =>
  ({
    type: 'publish',
    topic,
    payload
  }) as const

const subscribe = (topic: string): WsRelayClientMessage<StrategyMessage> => ({
  type: 'subscribe',
  topic
})

const unsubscribe = (topic: string): WsRelayClientMessage<StrategyMessage> => ({
  type: 'unsubscribe',
  topic
})

export const joinRoom: JoinRoom<WsRelayRoomConfig> =
  /*@__PURE__*/ createTopicStrategy({
    init: config =>
      config.relayConfig.urls.map(url => {
        const client = relayManager.register(url, () =>
          makeSocket(
            url,
            data => {
              const msg = parseServerMessage(data)

              if (!msg) {
                return
              }

              msgHandlers
                .forRelay(client)
                [msg.topic]?.forEach(handler => handler(msg.topic, msg.payload))
            },
            () => {
              Object.keys(msgHandlers.forKey(url)).forEach(topic =>
                client.send(toJson(subscribe(topic)))
              )
              Object.entries(announcementMessages.forKey(url)).forEach(
                ([topic, msg]) => client.send(toJson(publish(topic, msg)))
              )
            }
          )
        )

        return client.ready
      }),

    subscribeTopic: (client, topic, onMessage) => {
      const handlers = msgHandlers.forRelay(client)
      const topicHandler = (topic: string, data: StrategyMessage): void =>
        void onMessage(topic, data)

      const wasEmpty = !handlers[topic]
      const topicHandlers = (handlers[topic] ??= new Set())

      topicHandlers.add(topicHandler)

      if (wasEmpty) {
        client.send(toJson(subscribe(topic)))
      }

      return () => {
        const topicHandlers = handlers[topic]

        if (!topicHandlers) {
          return
        }

        topicHandlers.delete(topicHandler)

        if (topicHandlers.size === 0) {
          delete handlers[topic]
          delete announcementMessages.forRelay(client)[topic]
          client.send(toJson(unsubscribe(topic)))
        }
      }
    },

    publishTopic: (client, topic, msg, {kind}) => {
      client.send(toJson(publish(topic, msg)))

      if (kind === 'announce') {
        announcementMessages.forRelay(client)[topic] = msg
      }
    }
  })

export const getRelaySockets = (): Record<string, WebSocket> =>
  relayManager.getSockets()

export {setRelayConnectivity, type RelayConfig, type RelayConnectivity}
export * from '@trystero-p2p/core/public'
