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

const presencePath = '_'
const defaultRootPath = `__${libName.toLowerCase()}__`
const occupiedRooms = {}
const dbs = {}
const getPath = (...xs) => xs.join('/')

const init = config =>
  dbs[config.appId] ||
  (dbs[config.appId] = getDatabase(
    initializeApp({
      databaseURL: `https://${config.appId}.firebaseio.com`
    })
  ))

export const joinRoom = initGuard(occupiedRooms, (config, ns) => {
  const db = init(config)
  const peerMap = {}
  const peerSigs = {}
  const rootPath = config.rootPath || defaultRootPath
  const roomRef = ref(db, getPath(rootPath, ns))
  const selfRef = child(roomRef, selfId)

  const makePeer = (id, initiator) => {
    if (peerMap[id]) {
      return peerMap[id]
    }
    const peer = initPeer(initiator, true, config.rtcConfig)

    peer.on(events.connect, () => onPeerConnect(peer, id))
    peer.on(events.signal, sdp => {
      const signalRef = push(ref(db, getPath(rootPath, ns, id, selfId)))
      onDisconnect(signalRef).remove()
      set(signalRef, JSON.stringify(sdp))
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
    if (peerId !== presencePath) {
      onChildAdded(data.ref, data => {
        if (!(peerId in peerSigs)) {
          peerSigs[peerId] = {}
        }

        if (data.key in peerSigs[peerId]) {
          return
        }

        peerSigs[peerId][data.key] = true

        let val

        try {
          val = JSON.parse(data.val())
        } catch (e) {
          console.error(`${libName}: received malformed SDP JSON`)
          return
        }

        const peer = makePeer(peerId, false)

        peer.signal(val)
        remove(data.ref)
      })
    }
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
