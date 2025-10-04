import {createLightNode} from '@waku/sdk'
import strategy from './strategy.js'
import {
  all,
  decodeBytes,
  encodeBytes,
  libName,
  selfId,
  toJson
} from './utils.js'

const contentTopic = topic => `/${libName}-${topic}/0/msg/json`

const sendMessage = (node, topic, payload) =>
  node.lightPush.send(
    node.createEncoder({contentTopic: contentTopic(topic), ephemeral: true}),
    {payload: encodeBytes(payload)},
    {autoRetry: true}
  )

export const joinRoom = strategy({
  init: () =>
    createLightNode({
      defaultBootstrap: true,
      discovery: {dns: true, peerExchange: true, peerCache: true}
    }).then(async node => {
      await node.start()
      await node.waitForPeers()
      return node
    }),

  subscribe: async (node, rootTopic, selfTopic, onMessage) => {
    const handleMsg = topic => msg => {
      if (msg.payload) {
        onMessage(topic, decodeBytes(msg.payload), (peerTopic, signal) =>
          sendMessage(node, peerTopic, signal)
        )
      }
    }

    const unsubFns = await all(
      [rootTopic, selfTopic].map(topic => {
        const decoder = node.createDecoder({contentTopic: contentTopic(topic)})
        node.filter.subscribe(decoder, handleMsg(topic))
        return () => node.filter.unsubscribe(decoder)
      })
    )

    return () => unsubFns.forEach(f => f())
  },

  announce: (node, rootTopic) =>
    sendMessage(node, rootTopic, toJson({peerId: selfId}))
})

export {selfId} from './utils.js'
