import ipfs from 'ipfs-core/dist/index.min.js'
import room from './room.js'
import {
  decodeBytes,
  events,
  initGuard,
  initPeer,
  libName,
  noOp,
  selfId
} from './utils.js'
import {genKey, encrypt, decrypt} from './crypto.js'

const occupiedRooms = {}
const swarmPollMs = 999
const announceMs = 3333
const init = config =>
  nodeP ||
  (nodeP = ipfs.create({
    repo: libName.toLowerCase() + Math.random(),
    EXPERIMENTAL: {
      pubsub: true
    },
    config: {
      Addresses: {
        Swarm: config.swarmAddresses || [
          '/dns4/wrtc-star1.par.dwebops.pub/tcp/443/wss/p2p-webrtc-star/',
          '/dns4/wrtc-star2.sjc.dwebops.pub/tcp/443/wss/p2p-webrtc-star/',
          '/dns4/webrtc-star.discovery.libp2p.io/tcp/443/wss/p2p-webrtc-star/'
        ]
      }
    }
  }))

let nodeP

export const joinRoom = initGuard(occupiedRooms, (config, ns) => {
  const rootTopic = `${libName.toLowerCase()}:${config.appId}:${ns}`
  const selfTopic = `${rootTopic}:${selfId}`
  const offers = {}
  const seenPeers = {}
  const connectedPeers = {}
  const key = config.password && genKey(config.password, ns)

  const connectPeer = (peer, peerId) => {
    onPeerConnect(peer, peerId)
    connectedPeers[peerId] = peer
  }

  const disconnectPeer = peerId => {
    delete offers[peerId]
    delete seenPeers[peerId]
    delete connectedPeers[peerId]
  }

  let onPeerConnect = noOp
  let announceInterval
  let swarmPollTimeout

  const nodeP = init(config).then(async node => {
    const awaitPeers = async cb => {
      const peers = await node.swarm.peers()

      if (!peers || !peers.length) {
        swarmPollTimeout = setTimeout(awaitPeers, swarmPollMs, cb)
      } else {
        cb()
      }
    }

    await new Promise(awaitPeers)
    await Promise.all([
      node.pubsub.subscribe(rootTopic, msg => {
        const peerId = msg.data

        if (peerId === selfId || connectedPeers[peerId] || seenPeers[peerId]) {
          return
        }

        seenPeers[peerId] = true

        const peer = (offers[peerId] = initPeer(true, false, config.rtcConfig))

        peer.once(events.signal, async offer => {
          node.pubsub.publish(
            `${rootTopic}:${peerId}`,
            JSON.stringify({
              peerId: selfId,
              offer: key
                ? {...offer, sdp: await encrypt(key, offer.sdp)}
                : offer
            })
          )

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

      node.pubsub.subscribe(selfTopic, async msg => {
        let payload

        try {
          payload = JSON.parse(decodeBytes(msg.data))
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
          node.pubsub.publish(
            `${rootTopic}:${peerId}`,
            JSON.stringify({
              peerId: selfId,
              answer: key
                ? {...answer, sdp: await encrypt(key, answer.sdp)}
                : answer
            })
          )
        )
        peer.once(events.connect, () => connectPeer(peer, peerId))
        peer.once(events.close, () => disconnectPeer(peerId))
        peer.signal(
          key ? {...offer, sdp: await decrypt(key, offer.sdp)} : offer
        )
      })
    ])

    const announce = () => node.pubsub.publish(rootTopic, selfId)
    announceInterval = setInterval(announce, announceMs)
    announce()

    return node
  })

  return room(
    f => (onPeerConnect = f),
    async () => {
      const node = await nodeP
      node.pubsub.unsubscribe(rootTopic)
      node.pubsub.unsubscribe(selfTopic)
      clearInterval(announceInterval)
      clearTimeout(swarmPollTimeout)
    }
  )
})

export {selfId} from './utils.js'
