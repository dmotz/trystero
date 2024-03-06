import room from './room.js'
import {
  encodeBytes,
  entries,
  events,
  fromEntries,
  genId,
  getRelays,
  initGuard,
  initPeer,
  libName,
  mkErr,
  noOp,
  selfId,
  sleep,
  values
} from './utils.js'
import {decrypt, encrypt, genKey} from './crypto.js'

const occupiedRooms = {}
const socketPromises = {}
const sockets = {}
const socketRetryTimeouts = {}
const socketListeners = {}
const hashLimit = 20
const offerPoolSize = 10
const defaultRedundancy = 3
const defaultAnnounceSecs = 33
const maxAnnounceSecs = 120
const trackerRetrySecs = 4
const trackerAction = 'announce'
const defaultRelayUrls = [
  'wss://tracker.webtorrent.dev',
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.files.fm:7073/announce',
  'wss://tracker.btorrent.xyz'
]

export const joinRoom = initGuard(occupiedRooms, (config, ns) => {
  if (config.trackerUrls || config.trackerRedundancy) {
    throw mkErr(
      'trackerUrls/trackerRedundancy have been replaced by relayUrls/relayRedundancy'
    )
  }

  const connectedPeers = {}
  const key = config.password && genKey(config.password, ns)
  const relayUrls = getRelays(config, defaultRelayUrls, defaultRedundancy)

  const infoHashP = crypto.subtle
    .digest('SHA-1', encodeBytes(`${libName}:${config.appId}:${ns}`))
    .then(buffer =>
      Array.from(new Uint8Array(buffer))
        .map(b => b.toString(36))
        .join('')
        .slice(0, hashLimit)
    )

  const makeOffers = howMany =>
    fromEntries(
      Array(howMany)
        .fill()
        .map(() => {
          const peer = initPeer(true, false, config.rtcConfig)

          return [
            genId(hashLimit),
            {peer, offerP: new Promise(res => peer.once(events.signal, res))}
          ]
        })
    )

  const onSocketMessage = async (socket, e) => {
    const infoHash = await infoHashP
    let val

    try {
      val = JSON.parse(e.data)
    } catch (e) {
      console.error(`${libName}: received malformed SDP JSON`)
      return
    }

    if (val.info_hash !== infoHash || (val.peer_id && val.peer_id === selfId)) {
      return
    }

    const errMsg = val['failure reason']

    if (errMsg) {
      console.warn(
        `${libName}: torrent tracker failure from ${socket.url} - ${errMsg}`
      )
      return
    }

    if (
      val.interval &&
      val.interval > announceSecs &&
      val.interval <= maxAnnounceSecs
    ) {
      clearInterval(announceInterval)
      announceSecs = val.interval
      announceInterval = setInterval(announceAll, announceSecs * 1000)
    }

    if (val.offer && val.offer_id) {
      if (connectedPeers[val.peer_id] || handledOffers[val.offer_id]) {
        return
      }

      handledOffers[val.offer_id] = true

      const peer = initPeer(false, false, config.rtcConfig)

      peer.once(events.signal, async answer =>
        socket.send(
          JSON.stringify({
            answer: key
              ? {...answer, sdp: await encrypt(key, answer.sdp)}
              : answer,
            action: trackerAction,
            info_hash: infoHash,
            peer_id: selfId,
            to_peer_id: val.peer_id,
            offer_id: val.offer_id
          })
        )
      )
      peer.on(events.connect, () => onConnect(peer, val.peer_id))
      peer.on(events.close, () => onDisconnect(peer, val.peer_id, val.offer_id))
      peer.signal(
        key ? {...val.offer, sdp: await decrypt(key, val.offer.sdp)} : val.offer
      )

      return
    }

    if (val.answer) {
      if (connectedPeers[val.peer_id] || handledOffers[val.offer_id]) {
        return
      }

      const offer = offerPool[val.offer_id]

      if (offer) {
        const {peer} = offer

        if (peer.destroyed) {
          return
        }

        handledOffers[val.offer_id] = true
        peer.on(events.connect, () =>
          onConnect(peer, val.peer_id, val.offer_id)
        )
        peer.on(events.close, () =>
          onDisconnect(peer, val.peer_id, val.offer_id)
        )
        peer.signal(
          key
            ? {...val.answer, sdp: await decrypt(key, val.answer.sdp)}
            : val.answer
        )
      }
    }
  }

  const announce = async (socket, infoHash) =>
    socket.send(
      JSON.stringify({
        action: trackerAction,
        info_hash: infoHash,
        numwant: offerPoolSize,
        peer_id: selfId,
        offers: await Promise.all(
          entries(offerPool).map(async ([id, {offerP}]) => {
            const offer = await offerP

            return {
              offer_id: id,
              offer: key
                ? {...offer, sdp: await encrypt(key, offer.sdp)}
                : offer
            }
          })
        )
      })
    )

  const makeSocket = (url, infoHash, forced) => {
    if (forced || !socketPromises[url]) {
      socketListeners[url] = {
        ...socketListeners[url],
        [infoHash]: onSocketMessage
      }
      socketPromises[url] = new Promise(res => {
        const socket = new WebSocket(url)
        sockets[url] = socket

        socket.addEventListener('open', () => {
          // Reset the retry timeout for this tracker
          socketRetryTimeouts[url] = trackerRetrySecs * 1000
          res(socket)
        })

        socket.addEventListener('message', e =>
          values(socketListeners[url]).forEach(f => f(socket, e))
        )

        socket.addEventListener('close', async () => {
          socketRetryTimeouts[url] =
            socketRetryTimeouts[url] ?? trackerRetrySecs * 1000

          await sleep(socketRetryTimeouts[url])
          socketRetryTimeouts[url] *= 2

          makeSocket(url, infoHash, true)
        })
      })
    } else {
      socketListeners[url][infoHash] = onSocketMessage
    }

    return socketPromises[url]
  }

  const announceAll = async () => {
    const infoHash = await infoHashP

    if (offerPool) {
      cleanPool()
    }

    offerPool = makeOffers(offerPoolSize)

    relayUrls.forEach(async url => {
      const socket = await makeSocket(url, infoHash)

      if (socket.readyState === WebSocket.OPEN) {
        announce(socket, infoHash)
      } else if (socket.readyState !== WebSocket.CONNECTING) {
        announce(await makeSocket(url, infoHash, true), infoHash)
      }
    })
  }

  const cleanPool = () => {
    entries(offerPool).forEach(([id, {peer}]) => {
      if (!handledOffers[id] && !connectedPeers[id]) {
        peer.destroy()
      }
    })

    handledOffers = {}
  }

  const onConnect = (peer, id, offerId) => {
    onPeerConnect(peer, id)
    connectedPeers[id] = true

    if (offerId) {
      connectedPeers[offerId] = true
    }
  }

  const onDisconnect = (peer, peerId, offerId) => {
    delete connectedPeers[peerId]
    peer.destroy()

    const isInOfferPool = offerId in offerPool

    if (isInOfferPool) {
      delete offerPool[offerId]
      offerPool = {...offerPool, ...makeOffers(1)}
    }
  }

  let announceSecs = defaultAnnounceSecs
  let announceInterval = setInterval(announceAll, announceSecs * 1000)
  let onPeerConnect = noOp
  let handledOffers = {}
  let offerPool

  announceAll()

  return room(
    f => (onPeerConnect = f),
    async () => {
      const infoHash = await infoHashP

      relayUrls.forEach(url => delete socketListeners[url][infoHash])
      delete occupiedRooms[ns]
      clearInterval(announceInterval)
      cleanPool()
    }
  )
})

export const getRelaySockets = () => ({...sockets})

export {selfId} from './utils.js'
