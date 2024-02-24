import {
  createDecoder,
  createEncoder,
  createLightNode,
  waitForRemotePeer,
  Protocols
} from '@waku/sdk'
import strategy from './strategy'
import {decodeBytes, encodeBytes, selfId, toJson} from './utils'

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
    const [rootSub, selfSub] = await Promise.all([
      node.filter.createSubscription(),
      node.filter.createSubscription()
    ])
    const rootEncoder = createEncoder({
      contentTopic: rootTopic,
      ephemeral: true
    })
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
    node.lightPush.send(rootEncoder, {
      payload: encodeBytes(toJson({peerId: selfId}))
    })

    return () => {
      rootSub.unsubscribe()
      selfSub.unsubscribe()
    }
  }
})

export {selfId} from './utils.js'
