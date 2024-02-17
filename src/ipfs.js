import {
  createDecoder,
  createEncoder,
  createLightNode,
  waitForRemotePeer,
  Protocols
} from '@waku/sdk'
import room from './room.js'
import {
  decodeBytes,
  encodeBytes,
  events,
  initGuard,
  initPeer,
  libName,
  noOp,
  selfId
} from './utils.js'
import {decrypt, encrypt, genKey} from './crypto.js'

const occupiedRooms = {}
const announceMs = 3333

const init = config =>
  nodeP ||
  (nodeP = createLightNode({
    defaultBootstrap: true,
    ...(config.libp2pConfig
      ? {libp2p: config.libp2pConfig}
      : {libp2p: {hideWebSocketInfo: true}})
  }).then(async node => {
    await node.start()
    await waitForRemotePeer(node, [Protocols.LightPush, Protocols.Filter])
    return node
  }))

let nodeP

export const joinRoom = initGuard(occupiedRooms, (config, ns) => {
  const rootTopic = `${libName.toLowerCase()}/${config.appId}/${ns}`
  const selfTopic = `${rootTopic}/${selfId}`
  const offers = {}
  const seenPeers = {}
  const connectedPeers = {}
  const key = config.password && genKey(config.password, ns)
  const rootEncoder = createEncoder({contentTopic: rootTopic, ephemeral: true})
  const rootDecoder = createDecoder(rootTopic)
  const selfDecoder = createDecoder(selfTopic)

  const connectPeer = (peer, peerId) => {
    onPeerConnect(peer, peerId)
    connectedPeers[peerId] = peer
  }

  const disconnectPeer = peerId => {
    delete offers[peerId]
    delete seenPeers[peerId]
    delete connectedPeers[peerId]
  }

  const getPeerEncoder = peerId =>
    createEncoder({
      contentTopic: `${rootTopic}/${peerId}`,
      ephemeral: true
    })

  let onPeerConnect = noOp
  let rootSub
  let selfSub
  let announceInterval

  init(config).then(async node => {
    !([rootSub, selfSub] = await Promise.all([
      node.filter.createSubscription(),
      node.filter.createSubscription()
    ]))

    await Promise.all([
      rootSub.subscribe([rootDecoder], msg => {
        if (!msg.payload) {
          return
        }

        const peerId = decodeBytes(msg.payload)

        if (peerId === selfId || connectedPeers[peerId] || seenPeers[peerId]) {
          return
        }

        seenPeers[peerId] = true

        const peer = (offers[peerId] = initPeer(true, false, config.rtcConfig))

        peer.once(events.signal, async offer => {
          node.lightPush.send(getPeerEncoder(peerId), {
            payload: encodeBytes(
              JSON.stringify({
                peerId: selfId,
                offer: key
                  ? {...offer, sdp: await encrypt(key, offer.sdp)}
                  : offer
              })
            )
          })

          setTimeout(() => {
            if (connectedPeers[peerId]) {
              return
            }

            delete seenPeers[peerId]
            peer.destroy()
          }, announceMs * 2)
        })

        peer.once(events.connect, () => connectPeer(peer, peerId))
        peer.once(events.close, () => disconnectPeer(peerId))
      }),

      selfSub.subscribe([selfDecoder], async msg => {
        let payload

        try {
          payload = JSON.parse(decodeBytes(msg.payload))
        } catch (e) {
          console.error(`${libName}: received malformed JSON`)
          return
        }

        const {peerId, offer, answer} = payload

        if (offers[peerId] && answer) {
          offers[peerId].signal(
            key ? {...answer, sdp: await decrypt(key, answer.sdp)} : answer
          )
          return
        }

        const peer = initPeer(false, false, config.rtcConfig)

        peer.once(events.signal, async answer =>
          node.lightPush.send(getPeerEncoder(peerId), {
            payload: encodeBytes(
              JSON.stringify({
                peerId: selfId,
                answer: key
                  ? {...answer, sdp: await encrypt(key, answer.sdp)}
                  : answer
              })
            )
          })
        )

        peer.once(events.connect, () => connectPeer(peer, peerId))
        peer.once(events.close, () => disconnectPeer(peerId))
        peer.signal(
          key ? {...offer, sdp: await decrypt(key, offer.sdp)} : offer
        )
      })
    ])

    const announce = () =>
      node.lightPush.send(rootEncoder, {
        payload: encodeBytes(selfId)
      })

    announceInterval = setInterval(announce, announceMs)
    announce()
  })

  return room(
    f => (onPeerConnect = f),
    () => {
      clearInterval(announceInterval)
      rootSub.unsubscribe()
      selfSub.unsubscribe()
      delete occupiedRooms[ns]
    }
  )
})

export {selfId} from './utils.js'
