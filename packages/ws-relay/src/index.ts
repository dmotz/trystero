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
  type ActionError,
  type ActionErrorKind,
  type ActionMessageHandler,
  type ActionProgressContext,
  type ActionProgressHandler,
  type ActionReceiveContext,
  type ActionReceiveHandler,
  type ActionRequestHandler,
  type AddMediaOptions,
  type BanOptions,
  type BaseRoomConfig,
  type DataPayload,
  type JoinRoom,
  type JsonValue,
  type ListenerOptions,
  type MessageAction,
  type MessageActionConfig,
  type MessageContext,
  type PeerInfo,
  type PeerJoinContext,
  type PeerLeaveContext,
  type PeerMediaContext,
  type PeerResult,
  type PeerTarget,
  type RelayConfig,
  type RelayConnectivity,
  type RemoveMediaOptions,
  type ReplaceTrackOptions,
  type ReplayListenerOptions,
  type RequestAction,
  type RequestActionConfig,
  type RequestContext,
  type RequestManyOptions,
  type RequestOptions,
  type RoleCertificate,
  type RolesConfig,
  type RolesPluginApi,
  type Room,
  type RoomError,
  type RoomErrorBase,
  type RoomErrorCode,
  type RoomErrorHandler,
  type RoomPlugin,
  type RoomWithPlugins,
  type ScaleConfig,
  type ScalePluginApi,
  type SelfInfo,
  type SendOptions,
  type SharedState,
  type SocketClient,
  type StateChangeContext,
  type StateConfig,
  type StrategyMessage,
  type TopologyRoute,
  type TopologySnapshot,
  type TopologyStats,
  type TurnServerConfig,
  type Unsubscribe,
  type UserIdentity,
  type UserIdentityConfig,
  type UserIdentityLoader,
  type UserIdentityLoaderContext,
  type UserInfo,
  type UserJoinContext,
  type UserLeaveContext,
  type UserState,
  type UserStateChangeContext,
  type UserStateConfig
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

export {
  clearUserIdentity,
  createUserIdentity,
  exportUserIdentity,
  importUserIdentity,
  roles,
  scale,
  setRelayConnectivity,
  type ActionError,
  type ActionErrorKind,
  type ActionMessageHandler,
  type ActionProgressContext,
  type ActionProgressHandler,
  type ActionReceiveContext,
  type ActionReceiveHandler,
  type ActionRequestHandler,
  type AddMediaOptions,
  type BanOptions,
  type DataPayload,
  type JsonValue,
  type ListenerOptions,
  type MessageAction,
  type MessageActionConfig,
  type MessageContext,
  type PeerInfo,
  type PeerJoinContext,
  type PeerLeaveContext,
  type PeerMediaContext,
  type PeerResult,
  type PeerTarget,
  type RelayConfig,
  type RelayConnectivity,
  type RemoveMediaOptions,
  type ReplaceTrackOptions,
  type ReplayListenerOptions,
  type RequestAction,
  type RequestActionConfig,
  type RequestContext,
  type RequestManyOptions,
  type RequestOptions,
  type RoleCertificate,
  type RolesConfig,
  type RolesPluginApi,
  type Room,
  type RoomError,
  type RoomErrorBase,
  type RoomErrorCode,
  type RoomErrorHandler,
  type RoomPlugin,
  type RoomWithPlugins,
  type ScaleConfig,
  type ScalePluginApi,
  type SelfInfo,
  type SendOptions,
  type SharedState,
  type StateChangeContext,
  type StateConfig,
  type TopologyRoute,
  type TopologySnapshot,
  type TopologyStats,
  type TurnServerConfig,
  type Unsubscribe,
  type UserIdentity,
  type UserIdentityConfig,
  type UserIdentityLoader,
  type UserIdentityLoaderContext,
  type UserInfo,
  type UserJoinContext,
  type UserLeaveContext,
  type UserState,
  type UserStateChangeContext,
  type UserStateConfig
}
