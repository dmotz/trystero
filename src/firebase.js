import {initializeApp} from 'firebase/app'
import {
  child,
  getDatabase,
  off,
  onChildAdded,
  onDisconnect,
  onValue,
  push,
  ref,
  remove,
  set
} from 'firebase/database'
import room from './room'
import {events, initGuard, initPeer, keys, libName, noOp, selfId} from './utils'
import {genKey, encrypt, decrypt} from './crypto'

const presencePath = '_'
const defaultRootPath = `__${libName.toLowerCase()}__`
const occupiedRooms = {}
const dbs = {}
const getPath = (...xs) => xs.join('/')
const normalizeDbUrl = url =>
  url.startsWith('https://') ? url : `https://${url}.firebaseio.com`

const init = config => {
  if (config.firebaseApp) {
    const url = config.firebaseApp.options.databaseURL
    return dbs[url] || (dbs[url] = getDatabase(config.firebaseApp))
  }

  const url = normalizeDbUrl(config.appId)
  return dbs[url] || (dbs[url] = getDatabase(initializeApp({databaseURL: url})))
}

export const joinRoom = initGuard(occupiedRooms, (config, ns) => {
  const db = init(config)
  const peerMap = {}
  const peerSigs = {}
  const connectedPeers = {}
  const rootPath = config.rootPath || defaultRootPath
  const roomRef = ref(db, getPath(rootPath, ns))
  const selfRef = child(roomRef, selfId)
  const key = config.password && genKey(config.password, ns)

  const makePeer = (id, initiator) => {
    if (peerMap[id] && !peerMap[id].destroyed) {
      return peerMap[id]
    }

    const peer = initPeer(initiator, true, config.rtcConfig)

    peer.on(events.connect, () => {
      onPeerConnect(peer, id)
      connectedPeers[id] = true
    })

    peer.on(events.signal, async sdp => {
      if (connectedPeers[id]) {
        return
      }

      const payload = JSON.stringify(sdp)
      const signalRef = push(ref(db, getPath(rootPath, ns, id, selfId)))

      onDisconnect(signalRef).remove()
      set(signalRef, key ? await encrypt(key, payload) : payload)
    })

    peerMap[id] = peer
    return peer
  }

  let didSyncRoom = false
  let onPeerConnect = noOp

  occupiedRooms[ns] = true

  set(selfRef, {[presencePath]: true})
  onDisconnect(selfRef).remove()
  onChildAdded(selfRef, data => {
    const peerId = data.key

    if (peerId === presencePath || connectedPeers[peerId]) {
      return
    }

    onChildAdded(data.ref, async data => {
      if (!(peerId in peerSigs)) {
        peerSigs[peerId] = {}
      }

      if (data.key in peerSigs[peerId]) {
        return
      }

      peerSigs[peerId][data.key] = true

      let val

      try {
        val = JSON.parse(key ? await decrypt(key, data.val()) : data.val())
      } catch (e) {
        console.error(`${libName}: received malformed SDP JSON`)
        return
      }

      const peer = makePeer(peerId, false)

      peer.signal(val)
      remove(data.ref)
    })
  })

  onValue(roomRef, () => (didSyncRoom = true), {onlyOnce: true})
  onChildAdded(roomRef, ({key}) => {
    if (!didSyncRoom || key === selfId) {
      return
    }
    makePeer(key, true)
  })

  return room(
    f => (onPeerConnect = f),
    () => {
      off(selfRef)
      remove(selfRef)
      off(roomRef)
      delete occupiedRooms[ns]
    }
  )
})

export const getOccupants = initGuard(
  occupiedRooms,
  (config, ns) =>
    new Promise(res =>
      onValue(
        ref(init(config), getPath(config.rootPath || defaultRootPath, ns)),
        data => res(keys(data.val() || {})),
        {onlyOnce: true}
      )
    )
)

export {selfId} from './utils'
