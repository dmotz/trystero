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
  topicPath,
  watchOnline
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
  let cleanupWatchOnline

  return (config, roomId, onJoinError) => {
    const {appId, passive} = config
    const isPassive = !!passive

    if (occupiedRooms[appId]?.[roomId]) {
      return occupiedRooms[appId][roomId]
    }

    const pendingOffers = {}
    const connectedPeers = {}
    let isActive = !isPassive // Passive peers start inactive
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

    const checkDeactivate = () => {
      // Passive peers deactivate when all peers disconnect
      if (isPassive && Object.keys(connectedPeers).length === 0 && isActive) {
        isActive = false
        initPromises.forEach(async p => ((await p).isActive = false))
      }
    }

    const connectPeer = (peer, peerId, relayId) => {
      if (connectedPeers[peerId]) {
        if (connectedPeers[peerId] !== peer) {
          peer.destroy()
        }
        return
      }

      connectedPeers[peerId] = peer
      onPeerConnect(peer, peerId)

      pendingOffers[peerId]?.forEach((peer, i) => {
        if (i !== relayId) {
          peer.destroy()
        }
      })
      delete pendingOffers[peerId]
    }

    const disconnectPeer = (peer, peerId) => {
      if (connectedPeers[peerId] === peer) {
        delete connectedPeers[peerId]
        checkDeactivate()
      }
    }

    const prunePendingOffer = (peerId, relayId) => {
      if (connectedPeers[peerId]) {
        return
      }

      const offer = pendingOffers[peerId]?.[relayId]

      if (offer) {
        delete pendingOffers[peerId][relayId]
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

    const queueAnnounce = async (relay, i) => {
      const [rootTopic, selfTopic] = await all([rootTopicP, selfTopicP])

      if (!isPassive || isActive) {
        const ms = await announce(relay, rootTopic, selfTopic)

        if (typeof ms === 'number') {
          announceIntervals[i] = ms
        }
      }

      announceTimeouts[i] = setTimeout(
        () => queueAnnounce(relay, i),
        announceIntervals[i]
      )
    }

    const handleMessage = relayId => async (topic, msg, signalPeer) => {
      try {
      const [rootTopic, selfTopic] = await all([rootTopicP, selfTopicP])

      if (topic !== rootTopic && topic !== selfTopic) {
        return
      }

      const {peerId, offer, answer, peer} =
        typeof msg === 'string' ? fromJson(msg) : msg

      if (peerId === selfId || connectedPeers[peerId]) {
        return
      }

      // Passive peer logic: activate when any peer announces or sends an offer
      if (isPassive && !isActive && !answer) {
        isActive = true
        initPromises.forEach(async (relayP, i) => {
          const relay = await relayP
          relay.isActive = true
          clearTimeout(announceTimeouts[i])
          queueAnnounce(relay, i)
        })
      }

      // Skip if we're passive and not yet active
      if (isPassive && !isActive) {
        return
      }

      if (peerId && !offer && !answer) {
        if (pendingOffers[peerId]?.[relayId]) {
          return
        }

        const [[{peer, offer}], topic] = await all([
          getOffers(1),
          sha1(topicPath(rootTopicPlaintext, peerId))
        ])

        pendingOffers[peerId] ||= []
        pendingOffers[peerId][relayId] = peer

        setTimeout(
          () => prunePendingOffer(peerId, relayId),
          announceIntervals[relayId] * 0.9
        )

        peer.setHandlers({
          connect: () => connectPeer(peer, peerId, relayId),
          close: () => disconnectPeer(peer, peerId)
        })

        signalPeer(topic, toJson({peerId: selfId, offer}))
      } else if (offer) {
        const myOffer = pendingOffers[peerId]?.[relayId]

        if (myOffer && selfId > peerId) {
          return
        }

        const peer = initPeer(false, config)
        peer.setHandlers({
          connect: () => connectPeer(peer, peerId, relayId),
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
            connect: () => connectPeer(peer, peerId, relayId),
            close: () => disconnectPeer(peer, peerId)
          })

          peer.signal(plainAnswer)
        } else {
          const peer = pendingOffers[peerId]?.[relayId]

          if (peer && !peer.isDead) {
            peer.signal(plainAnswer)
          }
        }
      }
      } catch (e) {
        console.error('Error in handleMessage', e);
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
      cleanupWatchOnline = config.manualRelayReconnection ? noOp : watchOnline()
    }

    const announceIntervals = initPromises.map(() => announceIntervalMs)
    const announceTimeouts = []

    const unsubFns = initPromises.map(async (relayP, i) =>
      subscribe(
        await relayP,
        await rootTopicP,
        await selfTopicP,
        handleMessage(i),
        getOffers
      )
    )

    initPromises.forEach(async (relayP, i) => {
      await unsubFns[i]
      queueAnnounce(await relayP, i)
    })

    let onPeerConnect = noOp

    occupiedRooms[appId] ||= {}

    const roomInstance = room(
      f => (onPeerConnect = f),
      id => {
        if (connectedPeers[id]) {
          delete connectedPeers[id]
          checkDeactivate()
        }
      },
      () => {
        delete occupiedRooms[appId][roomId]
        announceTimeouts.forEach(clearTimeout)
        unsubFns.forEach(async f => (await f)())
        clearInterval(offerCleanupTimer)
        cleanupWatchOnline()
        didInit = false
      }
    )

    // Expose passive status for application layer
    roomInstance.isPassive = () => isPassive

    return (occupiedRooms[appId][roomId] = roomInstance)
  }
}
