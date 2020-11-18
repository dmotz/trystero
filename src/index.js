import firebase from '@firebase/app'
import '@firebase/database'
import Peer from 'simple-peer'
import {v4 as genId} from 'uuid'

const libName = 'Trystero'
const defaultRootPath = `__${libName.toLowerCase()}__`
const presencePath = '_'
const occupiedRooms = {}
const noOp = () => {}
const mkErr = msg => new Error(`${libName}: ${msg}`)
const getPath = (...xs) => xs.join('/')

let didInit = false
let db
let rootPath

export const selfId = genId()

export function init(fbConfig, options = {}) {
  if (!fbConfig) {
    throw mkErr('init() requires a Firebase config as the first argument')
  }

  if (didInit) {
    return
  }

  if (!firebase.apps.length) {
    firebase.initializeApp(fbConfig)
  }

  didInit = true
  db = firebase.database()
  rootPath = options.rootPath || defaultRootPath
}

export function joinRoom(ns, limit) {
  if (!didInit) {
    throw mkErr('must call init() before joining room')
  }

  if (!ns) {
    throw mkErr('namespace argument required')
  }

  if (occupiedRooms[ns]) {
    throw mkErr(`already joined room ${ns}`)
  }

  if (limit <= 0) {
    throw mkErr('invalid limit value')
  }

  const peerMap = {}
  const peerSigs = {}
  const actionMap = {}
  const roomRef = db.ref(getPath(rootPath, ns))
  const selfRef = roomRef.child(selfId)

  let didSyncRoom = false
  let onPeerJoin = noOp
  let onPeerLeave = noOp
  let onPeerStream = noOp
  let selfStream
  let limitRes
  let limitRej

  occupiedRooms[ns] = true

  selfRef.set({[presencePath]: true})
  selfRef.on('child_added', data => {
    const peerId = data.key
    if (peerId !== presencePath) {
      data.ref.on('child_added', data => {
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
        }

        getPeer(peerId, false).connection.signal(val)
        data.ref.remove()
      })
    }
  })
  selfRef.onDisconnect().remove()

  roomRef.once('value', data => {
    didSyncRoom = true

    if (!limit) {
      return
    }

    if (Object.keys(data.val()).length > limit) {
      fns.leave()
      limitRej(mkErr(`room ${ns} is full (limit: ${limit})`))
    } else {
      limitRes(fns)
    }
  })
  roomRef.on('child_added', ({key}) => {
    if (!didSyncRoom || key === selfId) {
      return
    }
    getPeer(key, true)
  })
  roomRef.on('child_removed', data => exitPeer(data.key))

  function getPeer(key, initiator) {
    if (peerMap[key]) {
      return peerMap[key]
    }

    let setReadiness
    const peer = new Peer({initiator})
    const obj = {
      connection: peer,
      whenReady: new Promise(res => (setReadiness = res)),
      givenStream: false
    }

    peerMap[key] = obj

    peer
      .on('signal', sdp => {
        const ref = db.ref(getPath(rootPath, ns, key, selfId)).push()
        ref.set(JSON.stringify(sdp))
        ref.onDisconnect().remove()
      })
      .on('connect', () => {
        setReadiness()
        onPeerJoin(key)
        if (selfStream) {
          sendStream(obj, selfStream)
        }
      })
      .on('close', () => exitPeer(key))
      .on('stream', stream => onPeerStream(key, stream))
      .on('data', data => {
        let type
        let payload

        try {
          ;({type, payload} = JSON.parse(data.toString()))
        } catch (e) {
          throw mkErr('failed parsing message')
        }

        if (!type) {
          throw mkErr('received message missing type')
        }

        if (!actionMap[type]) {
          throw mkErr(`received message with unregistered type: ${type}`)
        }

        actionMap[type](key, payload)
      })
      .on('error', e => {
        if (e.code === 'ERR_DATA_CHANNEL') {
          return
        }
        console.error(e)
      })

    return obj
  }

  function exitPeer(id) {
    if (!peerMap[id]) {
      return
    }
    delete peerMap[id]
    onPeerLeave(id)
  }

  function makeAction(type) {
    if (actionMap[type]) {
      throw mkErr(`action '${type}' already registered`)
    }

    actionMap[type] = noOp

    return [
      data => {
        const payload = JSON.stringify({type, payload: data})
        Object.values(peerMap).forEach(peer =>
          peer.whenReady.then(() => peer.connection.send(payload))
        )
      },
      f => (actionMap[type] = f)
    ]
  }

  async function sendStream(peer, stream) {
    await peer.whenReady
    peer.connection.addStream(stream)
    peer.givenStream = true
  }

  const fns = {
    makeAction,

    leave: () => {
      Object.entries(peerMap).forEach(([id, peer]) => {
        peer.connection.destroy()
        delete peerMap[id]
      })
      selfRef.off()
      selfRef.remove()
      roomRef.off()
      delete occupiedRooms[ns]
    },

    getPeers: () => Object.keys(peerMap),

    addStream: (stream, peerId, currentPeersOnly) => {
      if (peerId) {
        const peer = peerMap[peerId]
        if (!peer) {
          throw mkErr(`no peer with id ${peerId} found`)
        }
        sendStream(peer, stream)
      } else {
        if (!currentPeersOnly) {
          selfStream = stream
        }
        Object.values(peerMap).forEach(peer => sendStream(peer, stream))
      }
    },

    onPeerJoin: f => (onPeerJoin = f),

    onPeerLeave: f => (onPeerLeave = f),

    onPeerStream: f => (onPeerStream = f)
  }

  return limit
    ? new Promise((res, rej) => {
        limitRes = res
        limitRej = rej
      })
    : fns
}
