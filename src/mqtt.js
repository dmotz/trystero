import mqtt from 'mqtt'
import room from './room.js'
import {
  events,
  getRelays,
  initGuard,
  initPeer,
  libName,
  noOp,
  selfId
} from './utils.js'
import {decrypt, encrypt, genKey} from './crypto.js'

const occupiedRooms = {}
const defaultRedundancy = 2
const sockets = {}

const defaultRelayUrls = [
  'wss://test.mosquitto.org:8081',
  'wss://mqtt.eclipseprojects.io/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://public.mqtthq.com:8084/mqtt'
]

export const joinRoom = initGuard(occupiedRooms, (config, ns) => {
  const key = config.password && genKey(config.password, ns)
  const rootTopic = `${libName.toLowerCase()}/${config.appId}/${ns}`
  const selfTopic = `${rootTopic}/${selfId}`
  const offers = {}
  const seenPeers = {}
  const connectedPeers = {}
  const relayUrls = getRelays(config, defaultRelayUrls, defaultRedundancy)

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
  let clients = []

  relayUrls.forEach(url => {
    const client = mqtt.connect(url)

    sockets[url] = client.stream.socket
    clients.push(client)

    client.on('connect', () => {
      client.subscribe(rootTopic)
      client.subscribe(selfTopic)
      client.publish(rootTopic, selfId)
    })

    client.on('message', async (topic, message) => {
      const msg = message.toString()

      if (topic === rootTopic) {
        const peerId = msg

        if (
          peerId !== selfId &&
          !connectedPeers[peerId] &&
          !seenPeers[peerId]
        ) {
          seenPeers[peerId] = true

          const peer = (offers[peerId] = initPeer(
            true,
            false,
            config.rtcConfig
          ))

          peer.once(events.signal, async offer =>
            client.publish(
              `${rootTopic}/${peerId}`,
              JSON.stringify({
                peerId: selfId,
                offer: key
                  ? {...offer, sdp: await encrypt(key, offer.sdp)}
                  : offer
              })
            )
          )

          peer.once(events.connect, () => connectPeer(peer, peerId))
          peer.once(events.close, () => disconnectPeer(peerId))
        }
      } else if (topic === selfTopic) {
        const {peerId, offer, answer} = JSON.parse(msg)

        if (offers[peerId] && answer) {
          offers[peerId].signal(
            key ? {...answer, sdp: await decrypt(key, answer.sdp)} : answer
          )
          return
        }

        if (!offer) {
          return
        }

        const peer = initPeer(false, false, config.rtcConfig)

        peer.once(events.signal, async answer =>
          client.publish(
            `${rootTopic}/${peerId}`,
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
      }
    })
  })

  return room(
    f => (onPeerConnect = f),
    () => {
      delete occupiedRooms[ns]
      clients.forEach(client => client.end())
    }
  )
})

export const getRelaySockets = () => ({...sockets})

export {selfId} from './utils.js'
