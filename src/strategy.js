import {decrypt, encrypt, genKey, sha1} from './crypto.js'
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

const poolSize = 20

export default ({init, subscribe}) => {
  const occupiedRooms = {}

  let didInit = false
  let initPromises
  let offerPool

  return (config, ns) => {
    const pendingOffers = {}
    const connectedPeers = {}
    const rootTopicPlaintext = topicPath(libName, config.appId, ns)
    const rootTopicP = sha1(rootTopicPlaintext)
    const selfTopicP = sha1(topicPath(rootTopicPlaintext, selfId))
    const key = config.password && genKey(config.password, ns)

    const withCrypto = f => async signal =>
      key ? {...signal, sdp: await f(key, signal.sdp)} : signal

    const toPlain = withCrypto(decrypt)
    const toCipher = withCrypto(encrypt)

    const makeOffer = () => {
      const peer = initPeer(true, false, config.rtcConfig)

      return [
        peer,
        new Promise(res =>
          peer.once(events.signal, sdp => toCipher(sdp).then(res))
        )
      ]
    }

    const connectPeer = (peer, peerId, clientId) => {
      if (connectedPeers[peerId]) {
        if (connectedPeers[peerId] !== peer) {
          peer.destroy()
        }
        return
      }

      connectedPeers[peerId] = peer
      onPeerConnect(peer, peerId)
      pendingOffers[peerId]?.forEach((p, i) => {
        if (i !== clientId) {
          p.destroy()
        }
      })
      delete pendingOffers[peerId]
    }

    const disconnectPeer = (peer, peerId) => {
      if (connectedPeers[peerId] === peer) {
        delete connectedPeers[peerId]
      }
    }

    const getOffers = n => {
      const offers = offerPool.splice(0, n)
      offerPool.push(...alloc(n, makeOffer))
      return offers
    }

    const handlePeerEvents = (peer, peerId, clientId) => {
      peer.once(events.connect, () => connectPeer(peer, peerId, clientId))
      peer.once(events.close, () => disconnectPeer(peer, peerId))
    }

    const handleMessage = clientId => async (topic, msg, signalPeer) => {
      const [rootTopic, selfTopic] = await Promise.all([rootTopicP, selfTopicP])

      if (topic !== rootTopic && topic !== selfTopic) {
        return
      }

      const {peerId, offer, answer, peer} =
        typeof msg === 'string' ? fromJson(msg) : msg

      if (peerId === selfId || connectedPeers[peerId]) {
        return
      }

      if (peerId && !offer && !answer) {
        const [[peer, offerP]] = getOffers(1)
        const [topic, offer] = await Promise.all([
          sha1(topicPath(rootTopicPlaintext, peerId)),
          offerP
        ])

        pendingOffers[peerId] ||= []
        pendingOffers[peerId][clientId] = peer

        handlePeerEvents(peer, peerId, clientId)
        signalPeer(topic, toJson({peerId: selfId, offer}))
      } else if (offer) {
        const peer = initPeer(false, false, config.rtcConfig)
        const answerP = new Promise(res => peer.once(events.signal, res))
        const plainOffer = await toPlain(offer)

        if (peer.destroyed) {
          return
        }

        handlePeerEvents(peer, peerId, clientId)
        peer.signal(plainOffer)

        const [topic, answer] = await Promise.all([
          sha1(topicPath(rootTopicPlaintext, peerId)),
          answerP
        ])

        signalPeer(
          topic,
          toJson({peerId: selfId, answer: await toCipher(answer)})
        )
      } else if (answer) {
        const sdp = await toPlain(answer)

        if (peer) {
          handlePeerEvents(peer, peerId, clientId)
          peer.signal(sdp)
        } else {
          const peer = pendingOffers[peerId]?.[clientId]
          if (peer && !peer.destroyed) {
            peer.signal(sdp)
          }
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
      offerPool = alloc(poolSize, makeOffer)
      initPromises = Array.isArray(initRes) ? initRes : [initRes]
      didInit = true
    }

    const unsubFns = initPromises.map(async (clientP, i) =>
      subscribe(
        await clientP,
        await rootTopicP,
        await selfTopicP,
        handleMessage(i),
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
