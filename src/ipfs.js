import * as ipfs from 'ipfs-core/dist/index.min.js'
import Peer from 'simple-peer-light'
import room from './room'
import {decodeBytes, events, initGuard, libName, noOp, selfId} from './utils'

const occupiedRooms = {}
const swarmPollMs = 999
const announceMs = 3333
const init = config =>
  nodeP ||
  (nodeP = ipfs.default.create({
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
  const connectPeer = (peer, peerId) => {
    onPeerConnect(peer, peerId)
    connectedPeers[peerId] = peer
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
        const peerId = decodeBytes(msg.data)

        if (peerId === selfId || connectedPeers[peerId] || seenPeers[peerId]) {
          return
        }

        seenPeers[peerId] = true

        const peer = (offers[peerId] = new Peer({
          initiator: true,
          trickle: false
        }))

        peer.once(events.signal, offer => {
          node.pubsub.publish(
            `${rootTopic}:${peerId}`,
            JSON.stringify({peerId: selfId, offer})
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
      }),

      node.pubsub.subscribe(selfTopic, msg => {
        let payload

        try {
          payload = JSON.parse(decodeBytes(msg.data))
        } catch (e) {
          console.error(`${libName}: received malformed JSON`)
          return
        }

        const {peerId, offer, answer} = payload

        if (offers[peerId] && answer) {
          offers[peerId].signal(answer)
          return
        }

        const peer = new Peer({initiator: false, trickle: false})

        peer.once(events.signal, answer =>
          node.pubsub.publish(
            `${rootTopic}:${peerId}`,
            JSON.stringify({peerId: selfId, answer})
          )
        )
        peer.on(events.connect, () => connectPeer(peer, peerId))
        peer.signal(offer)
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

export {selfId} from './utils'
