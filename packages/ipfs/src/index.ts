import {createLightNode} from '@waku/sdk'
import {
  createStrategy,
  decodeBytes,
  encodeBytes,
  libName,
  selfId,
  toJson,
  type BaseRoomConfig,
  type JoinRoom
} from '@trystero/core'

const contentTopic = (topic: string): string =>
  `/${libName.toLowerCase()}-${topic}/0/msg/json`

const sendMessage = (
  node: any,
  topic: string,
  payload: string
): Promise<void> =>
  node.lightPush.send(
    node.createEncoder({contentTopic: contentTopic(topic), ephemeral: true}),
    {payload: encodeBytes(payload)},
    {autoRetry: true}
  )

const waitForPeersBounded = async (
  activeNode: any,
  timeoutMs = 7_500
): Promise<void> => {
  await Promise.race([
    activeNode.waitForPeers(),
    new Promise<void>(res => setTimeout(res, timeoutMs))
  ])
}

let node: any

export type IpfsRoomConfig = BaseRoomConfig

export const joinRoom: JoinRoom<IpfsRoomConfig> = createStrategy({
  init: () =>
    (node ??= createLightNode({
      defaultBootstrap: true,
      discovery: {dns: true, peerExchange: true, peerCache: true},
      libp2p: {hideWebSocketInfo: true}
    }).then(async (createdNode: any) => {
      await createdNode.start()
      await waitForPeersBounded(createdNode)
      return createdNode
    })),

  subscribe: async (activeNode, rootTopic, selfTopic, onMessage) => {
    const handleMsg = (topic: string) => (msg: {payload?: Uint8Array}) => {
      if (msg.payload) {
        void onMessage(topic, decodeBytes(msg.payload), (peerTopic, signal) => {
          void sendMessage(activeNode, peerTopic, signal)
        })
      }
    }

    const subscriptions = [rootTopic, selfTopic].map(topic => {
      const decoder = activeNode.createDecoder({
        contentTopic: contentTopic(topic)
      })
      const handler = handleMsg(topic)

      return {
        decoder,
        ready: activeNode.filter.subscribe(decoder, handler)
      }
    })

    await Promise.all(subscriptions.map(subscription => subscription.ready))

    return () => {
      subscriptions.forEach(subscription => {
        activeNode.filter.unsubscribe(subscription.decoder)
      })
    }
  },

  announce: (activeNode, rootTopic) =>
    sendMessage(activeNode, rootTopic, toJson({peerId: selfId}))
})

export {selfId}

export type * from '@trystero/core'
