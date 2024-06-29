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
const announceIntervalMs = 5333

export default ({init, subscribe, announce}) => {
  const occupiedRooms = {}

  let didInit = false
  let initPromises
  let offerPool

  return (config, ns) => {
    const {appId} = config

    if (occupiedRooms[appId]?.[ns]) {
      return occupiedRooms[appId][ns]
    }

    const pendingOffers = {}
    const connectedPeers = {}
    const rootTopicPlaintext = topicPath(libName, appId, ns)
    const rootTopicP = sha1(rootTopicPlaintext)
    const selfTopicP = sha1(topicPath(rootTopicPlaintext, selfId))
    const key = config.password && genKey(config.password, appId, ns)

    const withKey = f => async signal =>
      key ? {type: signal.type, sdp: await f(key, signal.sdp)} : signal

    const toPlain = withKey(decrypt)
    const toCipher = withKey(encrypt)

    const makeOffer = () => initPeer(true, config.rtcConfig)

    const connectPeer = (peer, peerId, clientId) => {
      if (connectedPeers[peerId]) {
        if (connectedPeers[peerId] !== peer) {
          peer.kill()
        }
        return
      }

      connectedPeers[peerId] = peer
      onPeerConnect(peer, peerId)

      pendingOffers[peerId]?.forEach((peer, i) => {
        if (i !== clientId) {
          peer.kill()
        }
      })
      delete pendingOffers[peerId]
    }

    const disconnectPeer = (peer, peerId) => {
      if (connectedPeers[peerId] === peer) {
        delete connectedPeers[peerId]
      }
    }

    const prunePendingOffer = (peerId, clientId) => {
      if (connectedPeers[peerId]) {
        return
      }

      const offer = pendingOffers[peerId]?.[clientId]

      if (offer) {
        delete pendingOffers[peerId][clientId]
        offer.kill()
      }
    }

    const getOffers = n => {
      offerPool.push(...alloc(n, makeOffer))

      return Promise.all(
        offerPool
          .splice(0, n)
          .map(peer =>
            peer.offerPromise.then(toCipher).then(offer => ({peer, offer}))
          )
      )
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
        if (pendingOffers[peerId]?.[clientId]) {
          return
        }

        const [[{peer, offer}], topic] = await Promise.all([
          getOffers(1),
          sha1(topicPath(rootTopicPlaintext, peerId))
        ])

        pendingOffers[peerId] ||= []
        pendingOffers[peerId][clientId] = peer
        setTimeout(
          () => prunePendingOffer(peerId, clientId),
          announceIntervalMs / 2
        )

        peer.setHandlers({
          connect: () => connectPeer(peer, peerId, clientId),
          disconnect: () => disconnectPeer(peer, peerId)
        })

        signalPeer(topic, toJson({peerId: selfId, offer}))
      } else if (offer) {
        const myOffer = pendingOffers[peerId]?.[clientId]

        if (myOffer && selfId > peerId) {
          return
        }

        const peer = initPeer(false, config.rtcConfig)
        peer.setHandlers({
          connect: () => connectPeer(peer, peerId, clientId),
          disconnect: () => disconnectPeer(peer, peerId)
        })

        let plainOffer

        try {
          plainOffer = await toPlain(offer)
        } catch (_) {
          config.onError?.('incorrect password!')
          return
        }

        if (peer.isDead) {
          return
        }

        const [topic, answer] = await Promise.all([
          sha1(topicPath(rootTopicPlaintext, peerId)),
          peer.signal(plainOffer)
        ])

        signalPeer(
          topic,
          toJson({peerId: selfId, answer: await toCipher(answer)})
        )
      } else if (answer) {
        const sdp = await toPlain(answer)

        if (peer) {
          peer.setHandlers({
            connect: () => connectPeer(peer, peerId, clientId),
            disconnect: () => disconnectPeer(peer, peerId)
          })

          peer.signal(sdp)
        } else {
          const peer = pendingOffers[peerId]?.[clientId]

          if (peer && !peer.isDead) {
            peer.signal(sdp)
          }
        }
      }
    }

    if (!config) {
      throw mkErr('requires a config map as the first argument')
    }

    if (!appId && !config.firebaseApp) {
      throw mkErr('config map is missing appId field')
    }

    if (!ns) {
      throw mkErr('namespace argument required')
    }

    if (!didInit) {
      const initRes = init(config)
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

    const announceIntervalP = (async () => {
      const [clients, rootTopic, selfTopic] = await Promise.all([
        Promise.all(initPromises),
        rootTopicP,
        selfTopicP,
        Promise.all(unsubFns)
      ])

      const announceAll = () =>
        clients.forEach(client => announce(client, rootTopic, selfTopic))

      announceAll()

      return setInterval(announceAll, announceIntervalMs)
    })()

    let onPeerConnect = noOp

    occupiedRooms[appId] ||= {}

    return (occupiedRooms[appId][ns] = room(
      f => (onPeerConnect = f),
      id => delete connectedPeers[id],
      () => {
        delete occupiedRooms[appId][ns]
        announceIntervalP.then(clearInterval)
        unsubFns.forEach(async f => (await f)())
      }
    ))
  }
}
