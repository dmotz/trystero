import {
  createDecoder,
  createEncoder,
  createLightNode,
  waitForRemotePeer,
  Protocols
} from '@waku/sdk'
import strategy from './strategy.js'
import {all, decodeBytes, encodeBytes, selfId, toJson} from './utils.js'

export const joinRoom = strategy({
  init: config =>
    createLightNode({
      defaultBootstrap: true,
      ...(config.libp2pConfig
        ? {libp2p: config.libp2pConfig}
        : {libp2p: {hideWebSocketInfo: true}})
    }).then(async node => {
      await node.start()
      await waitForRemotePeer(node, [Protocols.LightPush, Protocols.Filter])
      return node
    }),

  subscribe: async (node, rootTopic, selfTopic, onMessage) => {
    const [rootSub, selfSub] = await all([
      node.filter.createSubscription(),
      node.filter.createSubscription()
    ])

    const rootDecoder = createDecoder(rootTopic)
    const selfDecoder = createDecoder(selfTopic)

    const handleMsg = topic => msg => {
      if (msg.payload) {
        onMessage(topic, decodeBytes(msg.payload), (peerTopic, signal) =>
          node.lightPush.send(
            createEncoder({
              contentTopic: peerTopic,
              ephemeral: true
            }),
            {payload: encodeBytes(signal)}
          )
        )
      }
    }

    rootSub.subscribe([rootDecoder], handleMsg(rootTopic))
    selfSub.subscribe([selfDecoder], handleMsg(selfTopic))

    return () => {
      rootSub.unsubscribe()
      selfSub.unsubscribe()
    }
  },

  announce: (node, rootTopic) =>
    node.lightPush.send(
      createEncoder({contentTopic: rootTopic, ephemeral: true}),
      {payload: encodeBytes(toJson({peerId: selfId}))}
    )
})

export {selfId} from './utils.js'
