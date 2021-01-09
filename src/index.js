import firebase from '@firebase/app'
import '@firebase/database'
import Peer from 'simple-peer-light'
import {v4 as genId} from 'uuid'

const libName = 'Trystero'
const defaultRootPath = `__${libName.toLowerCase()}__`
const presencePath = '_'
const nullStr = String.fromCharCode(0)
const occupiedRooms = {}
const {keys, values, entries} = Object
const noOp = () => {}
const mkErr = msg => new Error(`${libName}: ${msg}`)
const getPath = (...xs) => xs.join('/')

let didInit = false
let db
let rootPath

export const selfId = genId()

export function init(config) {
  if (didInit) {
    return
  }

  if (!firebase.apps.length) {
    if (!config) {
      throw mkErr('init() requires a config map as the first argument')
    }

    if (!config.dbUrl) {
      throw mkErr('config map is missing dbUrl field')
    }

    firebase.initializeApp({databaseURL: config.dbUrl})
  }

  didInit = true
  db = firebase.database()
  rootPath = (config && config.rootPath) || defaultRootPath
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
  const binaryActionMap = [null]
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

    if (keys(data.val()).length > limit) {
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

    peer.on('signal', sdp => {
      const ref = db.ref(getPath(rootPath, ns, key, selfId)).push()
      ref.set(JSON.stringify(sdp))
      ref.onDisconnect().remove()
    })
    peer.on('connect', () => {
      setReadiness()
      onPeerJoin(key)
      if (selfStream) {
        sendStream(obj, selfStream)
      }
    })
    peer.on('close', () => exitPeer(key))
    peer.on('stream', stream => onPeerStream(key, stream))
    peer.on('data', data => {
      let type
      let payload

      if (data[0] === nullStr) {
        try {
          ;({type, payload} = JSON.parse(data.toString().slice(1)))
        } catch (e) {
          throw mkErr('failed parsing message')
        }
      } else {
        type = binaryActionMap[data[0]]
        payload = data.buffer.slice(1)
      }

      if (!type) {
        throw mkErr('received message missing type')
      }

      if (!actionMap[type]) {
        throw mkErr(`received message with unregistered type: ${type}`)
      }

      actionMap[type](key, payload)
    })
    peer.on('error', e => {
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

  function makeAction(type, isBinary) {
    if (!type) {
      throw mkErr('action type argument is required')
    }

    if (actionMap[type]) {
      throw mkErr(`action '${type}' already registered`)
    }

    actionMap[type] = noOp

    let actionIndex

    if (isBinary) {
      actionIndex = binaryActionMap.length
      if (actionIndex > 255) {
        throw mkErr('maximum binary actions for this room exceeded')
      }
      binaryActionMap[actionIndex] = type
    }

    return [
      async data => {
        let payload

        if (isBinary) {
          const buffer = data instanceof Blob ? await data.arrayBuffer() : data
          const tagged = new Uint8Array(buffer.byteLength + 1)

          tagged.set([actionIndex], 0)
          tagged.set(new Uint8Array(buffer), 1)
          payload = tagged.buffer
        } else {
          payload = nullStr + JSON.stringify({type, payload: data})
        }

        values(peerMap).forEach(peer =>
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
      entries(peerMap).forEach(([id, peer]) => {
        peer.connection.destroy()
        delete peerMap[id]
      })
      selfRef.off()
      selfRef.remove()
      roomRef.off()
      delete occupiedRooms[ns]
    },

    getPeers: () => keys(peerMap),

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
        values(peerMap).forEach(peer => sendStream(peer, stream))
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

export function getOccupants(ns) {
  if (!didInit) {
    throw mkErr('must call init() before calling getOccupants()')
  }

  return new Promise(res =>
    db
      .ref(getPath(rootPath, ns))
      .once('value', data => res(keys(data.val() || {})))
  )
}
