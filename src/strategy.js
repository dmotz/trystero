import {sha1} from './crypto.js'
import room from './room.js'
import {
  alloc,
  events,
  fromJson,
  initPeer,
  libName,
  mkErr,
  noOp,
  selfId,
  toJson,
  topicPath
} from './utils.js'

const globalPeers = {}

export default ({init, subscribe}) => {
  const occupiedRooms = {}

  let didInit = false
  let initPromises
  let offerPool

  return (config, ns) => {
    const pendingOffers = {}
    const connectedPeers = {}
    const seenPeers = {}
    const rootTopicPlaintext = topicPath(libName, config.appId, ns)
    const rootTopicP = sha1(rootTopicPlaintext)
    const selfTopicP = sha1(topicPath(rootTopicPlaintext, selfId))

    const makeOffer = () => {
      const peer = initPeer(true, false, config.rtcConfig)
      return [peer, new Promise(res => peer.once(events.signal, res))]
    }

    const connectPeer = (peer, peerId) => {
      onPeerConnect(peer, peerId)
      connectedPeers[peerId] = globalPeers[peerId] = peer
    }

    const disconnectPeer = peerId => {
      delete pendingOffers[peerId]
      delete seenPeers[peerId]
      delete connectedPeers[peerId]
      delete globalPeers[peerId]
    }

    const getOffers = n => {
      const offers = offerPool.splice(0, n)
      offerPool.push(...alloc(n, makeOffer))
      return offers
    }

    const handlePeerEvents = (peer, peerId) => {
      peer.once(events.connect, () => connectPeer(peer, peerId))
      peer.once(events.close, () => disconnectPeer(peerId))
    }

    const handleMessage = async (topic, msg, signalPeer) => {
      const [rootTopic, selfTopic] = await Promise.all([rootTopicP, selfTopicP])

      if (topic !== rootTopic && topic !== selfTopic) {
        return
      }

      const {peerId, offer, answer, peer} =
        typeof msg === 'string' ? fromJson(msg) : msg

      if (peerId && !offer && !answer) {
        if (peerId === selfId || seenPeers[peerId] || connectedPeers[peerId]) {
          return
        }

        const [[peer, offerP]] = getOffers(1)

        seenPeers[peerId] = true
        pendingOffers[peerId] = peer

        handlePeerEvents(peer, peerId)
        signalPeer(
          await sha1(topicPath(rootTopicPlaintext, peerId)),
          toJson({
            peerId: selfId,
            offer: await offerP
          })
        )

        return
      }

      if (offer) {
        const peer = initPeer(false, false, config.rtcConfig)

        handlePeerEvents(peer, peerId)
        peer.once(events.signal, async answer =>
          signalPeer(
            await sha1(topicPath(rootTopicPlaintext, peerId)),
            toJson({
              peerId: selfId,
              answer
            })
          )
        )

        peer.signal(offer)

        return
      }

      if (answer) {
        if (peer) {
          handlePeerEvents(peer, peerId)
          peer.signal(answer)
        } else if (pendingOffers[peerId]) {
          pendingOffers[peerId].signal(answer)
        }
      }
    }

    if (occupiedRooms[ns]) {
      return occupiedRooms[ns]
    }

    if (!config) {
      throw mkErr('requires a config map as the first argument')
    }

    if (!config.appId && !config.firebaseApp) {
      throw mkErr('config map is missing appId field')
    }

    if (!ns) {
      throw mkErr('namespace argument required')
    }

    if (!didInit) {
      const initRes = init(config, handleMessage)
      offerPool = alloc(20, () => makeOffer(config.rtcConfig))
      initPromises = Array.isArray(initRes) ? initRes : [initRes]
      didInit = true
    }

    const unsubFns = initPromises.map(async clientP =>
      subscribe(
        await clientP,
        await rootTopicP,
        await selfTopicP,
        handleMessage,
        getOffers
      )
    )

    let onPeerConnect = noOp

    return (occupiedRooms[ns] = room(
      f => (onPeerConnect = f),
      () => {
        delete occupiedRooms[ns]
        unsubFns.forEach(async f => (await f)())
      }
    ))
  }
}
