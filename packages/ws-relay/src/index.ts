import {
  createRelayManager,
  createTopicStrategy,
  makeSocket,
  toJson,
  type BaseRoomConfig,
  type JoinRoom,
  type RelayConfig,
  type SocketClient,
  type StrategyMessage
} from '@trystero-p2p/core'

const relayManager = createRelayManager<SocketClient>(client => client.socket)
const msgHandlers =
  relayManager.scoped<Set<(topic: string, data: StrategyMessage) => void>>()
const announcementMessages = relayManager.scoped<StrategyMessage>()

export type WsRelayConfig = Omit<RelayConfig, 'urls' | 'redundancy'> & {
  urls: string[]
}

export type WsRelayRoomConfig = BaseRoomConfig & {
  relayConfig: WsRelayConfig
}

type WsRelayClientMessage =
  | {type: 'subscribe'; topic: string}
  | {type: 'unsubscribe'; topic: string}
  | {type: 'publish'; topic: string; payload: StrategyMessage}

type WsRelayServerMessage = {
  topic: string
  payload: StrategyMessage
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isStrategyMessage = (value: unknown): value is StrategyMessage =>
  typeof value === 'string' || isRecord(value)

const parseServerMessage = (data: string): WsRelayServerMessage | null => {
  try {
    const msg = JSON.parse(data) as Partial<WsRelayServerMessage>

    return typeof msg.topic === 'string' && isStrategyMessage(msg.payload)
      ? {topic: msg.topic, payload: msg.payload}
      : null
  } catch {
    return null
  }
}

const publish = (
  topic: string,
  payload: StrategyMessage
): WsRelayClientMessage =>
  ({
    type: 'publish',
    topic,
    payload
  }) as const

const subscribe = (topic: string): WsRelayClientMessage => ({
  type: 'subscribe',
  topic
})

const unsubscribe = (topic: string): WsRelayClientMessage => ({
  type: 'unsubscribe',
  topic
})

export const joinRoom: JoinRoom<WsRelayRoomConfig> = createTopicStrategy({
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

export const getRelaySockets: () => Record<string, WebSocket> =
  relayManager.getSockets

export {
  clearUserIdentity,
  createUserIdentity,
  definePlugin,
  exportUserIdentity,
  importUserIdentity,
  roles,
  scale,
  setRelayConnectivity,
  type ActionProgressContext,
  type ActionProgressHandler,
  type ActionReceiveContext,
  type ActionReceiveHandler,
  type AddMediaOptions,
  type AuthoritativeState,
  type DataPayload,
  type JoinError,
  type JoinRoomCallbacks,
  type JsonValue,
  type MessageAction,
  type MessageActionConfig,
  type MessageContext,
  type PeerInfo,
  type PeerJoinContext,
  type PeerLeaveContext,
  type PeerMediaContext,
  type PeerResult,
  type PeerTarget,
  type RelayConnectivity,
  type RemoveMediaOptions,
  type RequestAction,
  type RequestActionConfig,
  type RequestContext,
  type RequestManyOptions,
  type RequestOptions,
  type RoleCertificate,
  type RolesConfig,
  type RolesPluginApi,
  type Room,
  type RoomPlugin,
  type RoomWithPlugins,
  type ScaleConfig,
  type ScalePluginApi,
  type SelfInfo,
  type SendOptions,
  type StateChangeContext,
  type StateConfig,
  type TopologyMode,
  type TopologyRoute,
  type TopologySnapshot,
  type TopologyStats,
  type TurnServerConfig,
  type UserIdentity,
  type UserIdentityConfig,
  type UserInfo,
  type UserJoinContext,
  type UserLeaveContext
} from '@trystero-p2p/core'
