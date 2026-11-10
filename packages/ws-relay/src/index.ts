import {
  clearUserIdentity,
  createRelayManager,
  createRelayScopedStore,
  createTopicStrategy,
  createUserIdentity,
  exportUserIdentity,
  importUserIdentity,
  makeSocket,
  roles,
  scale,
  setRelayConnectivity,
  toJson,
  type BaseRoomConfig,
  type JoinRoom,
  type RelayConfig,
  type SocketClient,
  type StrategyMessage
} from '@trystero-p2p/core'
import {parseServerMessage, type WsRelayClientMessage} from './protocol'

type TopicHandler = (topic: string, data: StrategyMessage) => void

type TopicSubscriptionEntry = {
  handlers: Set<TopicHandler>
  announcement?: StrategyMessage
}

const relayManager = /*@__PURE__*/ createRelayManager<SocketClient>(
  client => client.socket,
  client => client.close?.()
)
const topicSubscriptions =
  /*@__PURE__*/ createRelayScopedStore<TopicSubscriptionEntry>()

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
  /*@__PURE__*/ createTopicStrategy<SocketClient, WsRelayRoomConfig>({
    init: config =>
      config.relayConfig.urls.map(url => {
        const client = relayManager.register(url, () => {
          const created = makeSocket(
            url,
            data => {
              const msg = parseServerMessage(data)

              if (!msg) {
                return
              }

              topicSubscriptions
                .forRelay(created)
                [msg.topic]?.handlers.forEach(handler =>
                  handler(msg.topic, msg.payload)
                )
            },
            () => {
              const activeEntries = Object.entries(
                topicSubscriptions.forRelay(created)
              )
              activeEntries.forEach(([topic]) =>
                created.send(toJson(subscribe(topic)))
              )
              activeEntries.forEach(([topic, entry]) => {
                if (entry.announcement !== undefined) {
                  created.send(toJson(publish(topic, entry.announcement)))
                }
              })
            }
          )
          return created
        })

        return relayManager.lease(client, client.ready)
      }),

    subscribeTopic: (client, topic, onMessage) => {
      const subscriptions = topicSubscriptions.forRelay(client)
      const topicHandler: TopicHandler = (receivedTopic, data) =>
        void onMessage(receivedTopic, data)

      let entry = subscriptions[topic]
      const wasEmpty = !entry
      if (!entry) {
        entry = {handlers: new Set()}
        subscriptions[topic] = entry
      }

      entry.handlers.add(topicHandler)

      if (wasEmpty) {
        client.send(toJson(subscribe(topic)))
      }

      return () => {
        const current = subscriptions[topic]

        if (!current) {
          return
        }

        current.handlers.delete(topicHandler)

        if (current.handlers.size === 0) {
          delete subscriptions[topic]
          client.send(toJson(unsubscribe(topic)))
        }
      }
    },

    publishTopic: (client, topic, msg, {kind}) => {
      if (kind === 'announce') {
        const entry = topicSubscriptions.forRelay(client)[topic]
        if (!entry || entry.handlers.size === 0) {
          return
        }
        entry.announcement = msg
      }

      client.send(toJson(publish(topic, msg)))
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
  scale,
  setRelayConnectivity
}
export type * from '@trystero-p2p/core/types'
