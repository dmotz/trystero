import {decrypt, encrypt, genKey, sha1} from './crypto.js'
import initPeer from './peer.js'
import room from './room.js'
import {
  alloc,
  fromJson,
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
      key ? {type: signal.type, sdp: await f(key, signal.sdp)} : signal

    const toPlain = withCrypto(decrypt)
    const toCipher = withCrypto(encrypt)

    const makeOffer = () => {
      const peer = initPeer(true, config.rtcConfig)
      return [peer, peer.offerPromise.then(toCipher)]
    }

    const connectPeer = (peer, peerId, clientId) => {
      if (connectedPeers[peerId]) {
        if (connectedPeers[peerId] !== peer) {
          peer.kill()
        }
        return
      }

      connectedPeers[peerId] = peer
      onPeerConnect(peer, peerId)
      pendingOffers[peerId]?.forEach((p, i) => {
        if (i !== clientId) {
          p.kill()
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

        peer.setHandlers({
          onConnect: () => connectPeer(peer, peerId, clientId),
          onClose: () => disconnectPeer(peer, peerId)
        })

        signalPeer(topic, toJson({peerId: selfId, offer}))
      } else if (offer) {
        const peer = initPeer(false, config.rtcConfig, {
          onConnect: () => connectPeer(peer, peerId, clientId),
          onClose: () => disconnectPeer(peer, peerId)
        })

        const plainOffer = await toPlain(offer)

        if (peer.isDead) {
          return
        }

        const [topic, answer] = await Promise.all([
          sha1(topicPath(rootTopicPlaintext, peerId)),
          peer.addSignal(plainOffer)
        ])

        signalPeer(
          topic,
          toJson({peerId: selfId, answer: await toCipher(answer)})
        )
      } else if (answer) {
        const sdp = await toPlain(answer)

        if (peer) {
          peer.setHandlers({
            onConnect: () => connectPeer(peer, peerId, clientId),
            onClose: () => disconnectPeer(peer, peerId)
          })

          peer.addSignal(sdp)
        } else {
          const peer = pendingOffers[peerId]?.[clientId]

          if (peer && !peer.isDead) {
            peer.addSignal(sdp)
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
