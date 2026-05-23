import {createLightNode, type LightNode} from '@waku/sdk'
import {
  createTopicStrategy,
  decodeBytes,
  encodeBytes,
  libName,
  selfId,
  toJson,
  type BaseRoomConfig,
  type JoinRoom
} from '@trystero-p2p/core'

const contentTopic = (topic: string): string =>
  `/${libName.toLowerCase()}-${topic}/0/msg/json`

const sendMessage = (node: LightNode, topic: string, payload: string): void =>
  void node.lightPush.send(
    node.createEncoder({contentTopic: contentTopic(topic), ephemeral: true}),
    {payload: encodeBytes(payload)},
    {autoRetry: true}
  )

const waitForPeersBounded = (
  activeNode: LightNode,
  timeoutMs = 7_533
): Promise<void> =>
  Promise.race([
    activeNode.waitForPeers(),
    new Promise<void>(res => setTimeout(res, timeoutMs))
  ])

let node: Promise<LightNode>

export type IpfsRoomConfig = BaseRoomConfig

const joinRoomStrategy: JoinRoom<IpfsRoomConfig> = createTopicStrategy({
  init: () =>
    (node ??= createLightNode({
      defaultBootstrap: true,
      discovery: {dns: true, peerExchange: true, peerCache: true},
      libp2p: {hideWebSocketInfo: true}
    }).then(async createdNode => {
      await createdNode.start()
      await waitForPeersBounded(createdNode)
      return createdNode
    })),

  subscribeTopic: async (activeNode, topic, onMessage) => {
    const decoder = activeNode.createDecoder({
      contentTopic: contentTopic(topic)
    })
    const handler = (msg: {payload?: Uint8Array}) => {
      if (msg.payload) {
        void onMessage(topic, decodeBytes(msg.payload))
      }
    }

    await activeNode.filter.subscribe(decoder, handler)

    return () => {
      void activeNode.filter.unsubscribe(decoder)
    }
  },

  publishTopic: (activeNode, topic, msg) =>
    sendMessage(activeNode, topic, typeof msg === 'string' ? msg : toJson(msg))
})

export const joinRoom: JoinRoom<IpfsRoomConfig> = (config, roomId, callbacks) =>
  joinRoomStrategy(
    {...config, trickleIce: config.trickleIce ?? false},
    roomId,
    callbacks
  )

export {selfId}

export type * from '@trystero-p2p/core'
