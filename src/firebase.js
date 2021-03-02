import firebase from 'firebase/app'
import 'firebase/database'
import Peer from 'simple-peer-light'
import room from './room'
import {events, initGuard, keys, libName, noOp, selfId} from './utils'

const presencePath = '_'
const defaultRootPath = `__${libName.toLowerCase()}__`
const occupiedRooms = {}
const dbs = {}
const getPath = (...xs) => xs.join('/')
const fbEvents = {childAdded: 'child_added', value: 'value'}

const init = config =>
  dbs[config.appId]
    ? dbs[config.appId]
    : (dbs[config.appId] = firebase
        .initializeApp({
          databaseURL: `https://${config.appId}.firebaseio.com`
        })
        .database())

export const joinRoom = initGuard(occupiedRooms, (config, ns) => {
  const db = init(config)
  const peerMap = {}
  const peerSigs = {}
  const rootPath = config.rootPath || defaultRootPath
  const roomRef = db.ref(getPath(rootPath, ns))
  const selfRef = roomRef.child(selfId)

  const makePeer = (id, initiator) => {
    if (peerMap[id]) {
      return peerMap[id]
    }
    const peer = new Peer({initiator})

    peer.on(events.connect, () => onPeerConnect(peer, id))
    peer.on(events.signal, sdp => {
      const ref = db.ref(getPath(rootPath, ns, id, selfId)).push()
      ref.onDisconnect().remove()
      ref.set(JSON.stringify(sdp))
    })

    peerMap[id] = peer
    return peer
  }

  let didSyncRoom = false
  let onPeerConnect = noOp

  occupiedRooms[ns] = true

  selfRef.set({[presencePath]: true})
  selfRef.onDisconnect().remove()
  selfRef.on(fbEvents.childAdded, data => {
    const peerId = data.key
    if (peerId !== presencePath) {
      data.ref.on(fbEvents.childAdded, data => {
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
        data.ref.remove()
      })
    }
  })

  roomRef.once(fbEvents.value, () => (didSyncRoom = true))
  roomRef.on(fbEvents.childAdded, ({key}) => {
    if (!didSyncRoom || key === selfId) {
      return
    }
    makePeer(key, true)
  })

  return room(
    f => (onPeerConnect = f),
    () => {
      selfRef.off()
      selfRef.remove()
      roomRef.off()
      delete occupiedRooms[ns]
    }
  )
})

export const getOccupants = initGuard(
  occupiedRooms,
  (config, ns) =>
    new Promise(res =>
      init(config)
        .ref(getPath(config.rootPath || defaultRootPath, ns))
        .once(fbEvents.value, data => res(keys(data.val() || {})))
    )
)

export {selfId} from './utils'
