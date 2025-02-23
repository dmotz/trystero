import {decrypt, encrypt, genKey, sha1} from './crypto.js'
import initPeer from './peer.js'
import room from './room.js'
import {
  all,
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
const announceIntervalMs = 5_333
const offerTtl = 57_333

export default ({init, subscribe, announce}) => {
  const occupiedRooms = {}

  let didInit = false
  let initPromises
  let offerPool
  let offerCleanupTimer

  return (config, roomId, onJoinError) => {
    const {appId} = config

    if (occupiedRooms[appId]?.[roomId]) {
      return occupiedRooms[appId][roomId]
    }

    const pendingOffers = {}
    const connectedPeers = {}
    const rootTopicPlaintext = topicPath(libName, appId, roomId)
    const rootTopicP = sha1(rootTopicPlaintext)
    const selfTopicP = sha1(topicPath(rootTopicPlaintext, selfId))
    const key = genKey(config.password || '', appId, roomId)

    const withKey = f => async signal => ({
      type: signal.type,
      sdp: await f(key, signal.sdp)
    })

    const toPlain = withKey(decrypt)
    const toCipher = withKey(encrypt)

    const makeOffer = () => initPeer(true, config)

    const connectPeer = (peer, peerId, clientId) => {
      if (connectedPeers[peerId]) {
        if (connectedPeers[peerId] !== peer) {
          peer.destroy()
        }
        return
      }

      connectedPeers[peerId] = peer
      onPeerConnect(peer, peerId)

      pendingOffers[peerId]?.forEach((peer, i) => {
        if (i !== clientId) {
          peer.destroy()
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
        offer.destroy()
      }
    }

    const getOffers = n => {
      offerPool.push(...alloc(n, makeOffer))

      return all(
        offerPool
          .splice(0, n)
          .map(peer =>
            peer.offerPromise.then(toCipher).then(offer => ({peer, offer}))
          )
      )
    }

    const handleJoinError = (peerId, sdpType) =>
      onJoinError?.({
        error: `incorrect password (${config.password}) when decrypting ${sdpType}`,
        appId,
        peerId,
        roomId
      })

    const handleMessage = clientId => async (topic, msg, signalPeer) => {
      const [rootTopic, selfTopic] = await all([rootTopicP, selfTopicP])

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

        const [[{peer, offer}], topic] = await all([
          getOffers(1),
          sha1(topicPath(rootTopicPlaintext, peerId))
        ])

        pendingOffers[peerId] ||= []
        pendingOffers[peerId][clientId] = peer

        setTimeout(
          () => prunePendingOffer(peerId, clientId),
          announceIntervals[clientId] * 0.9
        )

        peer.setHandlers({
          connect: () => connectPeer(peer, peerId, clientId),
          close: () => disconnectPeer(peer, peerId)
        })

        signalPeer(topic, toJson({peerId: selfId, offer}))
      } else if (offer) {
        const myOffer = pendingOffers[peerId]?.[clientId]

        if (myOffer && selfId > peerId) {
          return
        }

        const peer = initPeer(false, config)
        peer.setHandlers({
          connect: () => connectPeer(peer, peerId, clientId),
          close: () => disconnectPeer(peer, peerId)
        })

        let plainOffer

        try {
          plainOffer = await toPlain(offer)
        } catch {
          handleJoinError(peerId, 'offer')
          return
        }

        if (peer.isDead) {
          return
        }

        const [topic, answer] = await all([
          sha1(topicPath(rootTopicPlaintext, peerId)),
          peer.signal(plainOffer)
        ])

        signalPeer(
          topic,
          toJson({peerId: selfId, answer: await toCipher(answer)})
        )
      } else if (answer) {
        let plainAnswer

        try {
          plainAnswer = await toPlain(answer)
        } catch (e) {
          handleJoinError(peerId, 'answer')
          return
        }

        if (peer) {
          peer.setHandlers({
            connect: () => connectPeer(peer, peerId, clientId),
            close: () => disconnectPeer(peer, peerId)
          })

          peer.signal(plainAnswer)
        } else {
          const peer = pendingOffers[peerId]?.[clientId]

          if (peer && !peer.isDead) {
            peer.signal(plainAnswer)
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

    if (!roomId) {
      throw mkErr('roomId argument required')
    }

    if (!didInit) {
      const initRes = init(config)
      offerPool = alloc(poolSize, makeOffer)
      initPromises = Array.isArray(initRes) ? initRes : [initRes]
      didInit = true
      offerCleanupTimer = setInterval(
        () =>
          (offerPool = offerPool.filter(peer => {
            const shouldLive = Date.now() - peer.created < offerTtl

            if (!shouldLive) {
              peer.destroy()
            }

            return shouldLive
          })),
        offerTtl * 1.03
      )
    }

    const announceIntervals = initPromises.map(() => announceIntervalMs)
    const announceTimeouts = []

    const unsubFns = initPromises.map(async (clientP, i) =>
      subscribe(
        await clientP,
        await rootTopicP,
        await selfTopicP,
        handleMessage(i),
        getOffers
      )
    )

    all([rootTopicP, selfTopicP]).then(([rootTopic, selfTopic]) => {
      const queueAnnounce = async (client, i) => {
        const ms = await announce(client, rootTopic, selfTopic)

        if (typeof ms === 'number') {
          announceIntervals[i] = ms
        }

        announceTimeouts[i] = setTimeout(
          () => queueAnnounce(client, i),
          announceIntervals[i]
        )
      }

      unsubFns.forEach(async (didSub, i) => {
        await didSub
        queueAnnounce(await initPromises[i], i)
      })
    })

    let onPeerConnect = noOp

    occupiedRooms[appId] ||= {}

    return (occupiedRooms[appId][roomId] = room(
      f => (onPeerConnect = f),
      id => delete connectedPeers[id],
      () => {
        delete occupiedRooms[appId][roomId]
        announceTimeouts.forEach(clearTimeout)
        unsubFns.forEach(async f => (await f)())
        clearInterval(offerCleanupTimer)
      }
    ))
  }
}
