import {
  createDecoder,
  createEncoder,
  createLightNode,
  Protocols
} from '@waku/sdk'
import {wakuPeerExchangeDiscovery} from '@waku/discovery'
import strategy from './strategy.js'
import {
  all,
  decodeBytes,
  encodeBytes,
  libName,
  selfId,
  toJson
} from './utils.js'

const pubsubTopic = '/waku/2/default-waku/proto'

const contentTopic = topic => `/${libName}/0/${topic}/json`

const sendMessage = (node, topic, payload) =>
  node.lightPush.send(
    createEncoder({
      pubsubTopic,
      contentTopic: contentTopic(topic),
      ephemeral: true
    }),
    {payload: encodeBytes(payload)}
  )

export const joinRoom = strategy({
  init: config =>
    createLightNode({
      defaultBootstrap: false,
      pubsubTopics: [pubsubTopic],
      bootstrapPeers: [
        '/dns4/waku.myrandomdemos.online/tcp/8000/wss/p2p/16Uiu2HAmKfC2QUvMVyBsVjuEzdo1hVhRddZxo69YkBuXYvuZ83sc',
        '/dns4/node-01.do-ams3.wakuv2.prod.status.im/tcp/8000/wss/p2p/16Uiu2HAmL5okWopX7NqZWBUKVqW8iUxCEmd5GMHLVPwCgzYzQv3e',
        '/dns4/node-01.gc-us-central1-a.wakuv2.prod.statusim.net/tcp/8000/wss/p2p/16Uiu2HAmVkKntsECaYfefR1V2yCR79CegLATuTPE6B9TxgxBiiiA',
        '/dns4/node-01.ac-cn-hongkong-c.wakuv2.prod.status.im/tcp/8000/wss/p2p/16Uiu2HAm4v86W3bmT1BiH6oSPzcsSr24iDQpSN5Qa992BCjjwgrD',
        '/dns4/node-01.do-ams3.wakuv2.test.status.im/tcp/8000/wss/p2p/16Uiu2HAmPLe7Mzm8TsYUubgCAW1aJoeFScxrLj8ppHFivPo97bUZ'
      ],
      libp2p: {
        peerDiscovery: [wakuPeerExchangeDiscovery([pubsubTopic])],
        hideWebSocketInfo: true,
        ...config.libp2pConfig
      }
    }).then(async node => {
      await node.start()
      await node.waitForPeers([Protocols.LightPush, Protocols.Filter])
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
      [rootTopic, selfTopic].map(topic =>
        node.filter.subscribe(
          createDecoder(contentTopic(topic), pubsubTopic),
          handleMsg(topic)
        )
      )
    )

    return () => unsubFns.forEach(f => f())
  },

  announce: (node, rootTopic) =>
    sendMessage(node, rootTopic, toJson({peerId: selfId}))
})

export {selfId} from './utils.js'
