import {createLightNode} from '@waku/sdk'
import strategy from './strategy.js'
import {decodeBytes, encodeBytes, libName, selfId, toJson} from './utils.js'

const contentTopic = topic => `/${libName.toLowerCase()}-${topic}/0/msg/json`

const sendMessage = (node, topic, payload) =>
  node.lightPush.send(
    node.createEncoder({contentTopic: contentTopic(topic), ephemeral: true}),
    {payload: encodeBytes(payload)},
    {autoRetry: true}
  )

let node

export const joinRoom = strategy({
  init: () =>
    (node ||= createLightNode({
      defaultBootstrap: true,
      discovery: {dns: true, peerExchange: true, peerCache: true},
      libp2p: {hideWebSocketInfo: true}
    }).then(async node => {
      await node.start()
      await node.waitForPeers()
      return node
    })),

  subscribe: (node, rootTopic, selfTopic, onMessage) => {
    const handleMsg = topic => msg => {
      if (msg.payload) {
        onMessage(topic, decodeBytes(msg.payload), (peerTopic, signal) =>
          sendMessage(node, peerTopic, signal)
        )
      }
    }

    const unsubFns = [rootTopic, selfTopic].map(topic => {
      const decoder = node.createDecoder({contentTopic: contentTopic(topic)})
      node.filter.subscribe(decoder, handleMsg(topic))
      return () => node.filter.unsubscribe(decoder)
    })

    return () => unsubFns.forEach(f => f())
  },

  announce: (node, rootTopic) =>
    sendMessage(node, rootTopic, toJson({peerId: selfId}))
})

export {selfId} from './utils.js'
