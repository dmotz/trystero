import Peer from 'simple-peer-light'
import room from './room'
import {
  encodeBytes,
  entries,
  events,
  fromEntries,
  genId,
  initGuard,
  libName,
  mkErr,
  noOp,
  selfId,
  values
} from './utils'

const occupiedRooms = {}
const sockets = {}
const socketListeners = {}
const hashLimit = 20
const offerPoolSize = 10
const defaultRedundancy = 2
const defaultAnnounceSecs = 33
const maxAnnounceSecs = 120
const trackerAction = 'announce'
const defaultTrackerUrls = [
  'wss://tracker.openwebtorrent.com/',
  'wss://tracker.sloppyta.co:443/announce',
  'wss://tracker.lab.vvc.niif.hu:443/announce',
  'wss://tracker.files.fm:7073/announce'
]

export const joinRoom = initGuard(occupiedRooms, (config, ns) => {
  const connectedPeers = {}
  const trackerUrls = (config.trackerUrls || defaultTrackerUrls).slice(
    0,
    config.trackerUrls
      ? config.trackerUrls.length
      : config.trackerRedundancy || defaultRedundancy
  )

  if (!trackerUrls.length) {
    throw mkErr('trackerUrls is empty')
  }

  const infoHashP = crypto.subtle
    .digest('SHA-1', encodeBytes(`${libName}:${config.appId}:${ns}`))
    .then(buffer =>
      Array.from(new Uint8Array(buffer))
        .map(b => b.toString(36))
        .join('')
        .slice(0, hashLimit)
    )

  const makeOffers = () =>
    fromEntries(
      new Array(offerPoolSize).fill().map(() => {
        const peer = new Peer({initiator: true, trickle: false})

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

    if (val.info_hash !== infoHash) {
      return
    }

    if (val.peer_id && val.peer_id === selfId) {
      return
    }

    const failure = val['failure reason']

    if (failure) {
      console.warn(`${libName}: torrent tracker failure (${failure})`)
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
      if (connectedPeers[val.peer_id]) {
        return
      }

      if (handledOffers[val.offer_id]) {
        return
      }

      handledOffers[val.offer_id] = true

      const peer = new Peer({trickle: false})
      peer.once(events.signal, answer => {
        socket.send(
          JSON.stringify({
            answer,
            action: trackerAction,
            info_hash: infoHash,
            peer_id: selfId,
            to_peer_id: val.peer_id,
            offer_id: val.offer_id
          })
        )
      })

      peer.on(events.connect, () => onConnect(peer, val.peer_id))
      peer.on(events.close, () => onDisconnect(val.peer_id))
      peer.signal(val.offer)
      return
    }

    if (val.answer) {
      if (connectedPeers[val.peer_id]) {
        return
      }

      if (handledOffers[val.offer_id]) {
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
        peer.on(events.close, () => onDisconnect(val.peer_id))
        peer.signal(val.answer)
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
          entries(offerPool).map(([id, {offerP}]) =>
            offerP.then(offer => ({offer, offer_id: id}))
          )
        )
      })
    )

  const makeSocket = (url, infoHash) => {
    if (!sockets[url]) {
      socketListeners[url] = {[infoHash]: onSocketMessage}
      sockets[url] = new Promise(res => {
        const socket = new WebSocket(url)
        socket.onopen = res.bind(null, socket)
        socket.onmessage = e =>
          values(socketListeners[url]).forEach(f => f(socket, e))
      })
    } else {
      socketListeners[url][infoHash] = onSocketMessage
    }

    return sockets[url]
  }

  const announceAll = async () => {
    const infoHash = await infoHashP

    if (offerPool) {
      cleanPool()
    }

    offerPool = makeOffers()

    trackerUrls.forEach(async url => {
      const socket = makeSocket(url, infoHash)

      if (socket.readyState === WebSocket.OPEN) {
        announce(socket, infoHash)
      } else if (socket.readyState !== WebSocket.CONNECTING) {
        announce(await makeSocket(url, infoHash), infoHash)
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

  const onDisconnect = id => delete connectedPeers[id]

  let announceSecs = defaultAnnounceSecs
  let announceInterval = setInterval(announceAll, announceSecs * 1000)
  let onPeerConnect = noOp
  let handledOffers = {}
  let offerPool

  occupiedRooms[ns] = true
  announceAll()

  return room(
    f => (onPeerConnect = f),
    async () => {
      const infoHash = await infoHashP

      trackerUrls.forEach(url => delete socketListeners[url][infoHash])
      delete occupiedRooms[ns]
      clearInterval(announceInterval)
      cleanPool()
    }
  )
})

export {selfId} from './utils'
