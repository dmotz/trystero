import {
  createRelayManager,
  createStrategy,
  makeSocket,
  pauseRelayReconnection,
  resumeRelayReconnection,
  selfId,
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

export type WsRelayRoomConfig = BaseRoomConfig &
  Omit<RelayConfig, 'relayUrls' | 'relayRedundancy'> & {
    relayUrls: string[]
  }

export type WsRelayClientMessage =
  | {type: 'subscribe'; topic: string}
  | {type: 'unsubscribe'; topic: string}
  | {type: 'publish'; topic: string; payload: StrategyMessage}

export type WsRelayServerMessage = {
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

export const joinRoom: JoinRoom<WsRelayRoomConfig> = createStrategy({
  init: config =>
    config.relayUrls.map(url => {
      const client = relayManager.register(
        url,
        makeSocket(url, data => {
          const msg = parseServerMessage(data)

          if (!msg) {
            return
          }

          msgHandlers
            .forRelay(client)
            [msg.topic]?.forEach(handler => handler(msg.topic, msg.payload))
        })
      )

      return client.ready
    }),

  subscribe: (client, rootTopic, selfTopic, onMessage) => {
    const handlers = msgHandlers.forRelay(client)
    const topicHandler = (topic: string, data: StrategyMessage): void =>
      void onMessage(topic, data, (peerTopic, signal) =>
        client.send(toJson(publish(peerTopic, signal)))
      )

    const addTopic = (topic: string): void => {
      const wasEmpty = !handlers[topic]
      const topicHandlers = (handlers[topic] ??= new Set())

      topicHandlers.add(topicHandler)

      if (wasEmpty) {
        client.send(toJson(subscribe(topic)))
      }
    }

    addTopic(rootTopic)
    addTopic(selfTopic)

    return () => {
      const removeTopic = (topic: string): void => {
        const topicHandlers = handlers[topic]

        if (!topicHandlers) {
          return
        }

        topicHandlers.delete(topicHandler)

        if (topicHandlers.size === 0) {
          delete handlers[topic]
          client.send(toJson(unsubscribe(topic)))
        }
      }

      removeTopic(rootTopic)
      removeTopic(selfTopic)
    }
  },

  announce: (client, rootTopic) =>
    client.send(toJson(publish(rootTopic, toJson({peerId: selfId}))))
})

export const getRelaySockets = relayManager.getSockets

export {pauseRelayReconnection, resumeRelayReconnection, selfId}

export type * from '@trystero-p2p/core'
