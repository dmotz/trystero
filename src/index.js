import firebase from '@firebase/app'
import '@firebase/database'
import Peer from 'simple-peer-light'
import {v4 as genId} from 'uuid'

const libName = 'Trystero'
const defaultRootPath = `__${libName.toLowerCase()}__`
const presencePath = '_'
const buffLowEvent = 'bufferedamountlow'
const occupiedRooms = {}
const {keys, values, entries} = Object
const chunkSize = 16 * 1024 - 16
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
  const actions = []
  const pendingTransmissions = {}
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
      const nonce = new Uint32Array(data.slice(0, 4).buffer)[0]
      const actionN = new Uint32Array(data.slice(4, 8).buffer)[0]
      const chunkN = new Uint32Array(data.slice(8, 12).buffer)[0]
      const chunkTotal = new Uint32Array(data.slice(12, 16).buffer)[0]

      if (!actions[actionN]) {
        throw mkErr('received message with unregistered type')
      }

      const chunks = !pendingTransmissions[nonce]
        ? (pendingTransmissions[nonce] = [])
        : pendingTransmissions[nonce]

      chunks[chunkN] = data.subarray(16)

      if (chunkN === chunkTotal - 1) {
        let payload

        if (chunks.length === 1) {
          payload = chunks[0]
        } else {
          payload = new Uint8Array(chunks.reduce((a, c) => a + c.byteLength, 0))
          pendingTransmissions[nonce].forEach((b, i) =>
            payload.set(b, i && chunks[i - 1].byteLength)
          )
        }

        try {
          actions[actionN].fn(
            key,
            actions[actionN].isBinary
              ? payload
              : JSON.parse(new TextDecoder().decode(payload))
          )
        } catch (e) {
          throw mkErr('failed parsing message')
        }

        delete pendingTransmissions[nonce]
      }
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

    if (actions.find(a => a.type === type)) {
      throw mkErr(`action '${type}' already registered`)
    }

    const aMap = {type, isBinary, fn: noOp}
    const actionN = actions.push(aMap) - 1

    return [
      async (data, peerId) => {
        const buffer = isBinary
          ? new Uint8Array(
              data instanceof Blob ? await data.arrayBuffer() : data
            )
          : new TextEncoder().encode(
              typeof data === 'object' ? JSON.stringify(data) : data
            )

        const nonce = Math.floor(Math.random() * (2 ** 32 - 1))
        const chunkTotal = Math.ceil(buffer.byteLength / chunkSize)

        const transmit = async peer => {
          await peer.whenReady
          const chan = peer.connection._channel
          let chunkN = 0

          while (chunkN < chunkTotal) {
            if (chan.bufferedAmount > chan.bufferedAmountLowThreshold) {
              await new Promise(res => {
                const next = () => {
                  chan.removeEventListener(buffLowEvent, next)
                  res()
                }
                chan.addEventListener(buffLowEvent, next)
              })
            }

            const meta = Uint8Array.from(
              [nonce, actionN, chunkN, chunkTotal].flatMap(n => [
                0xff & n,
                0xff & (n >> 8),
                0xff & (n >> 16),
                0xff & (n >> 24)
              ])
            )

            const payload = new Uint8Array(
              meta.byteLength +
                (chunkN === chunkTotal - 1
                  ? buffer.byteLength - chunkSize * (chunkTotal - 1)
                  : chunkSize)
            )

            payload.set(meta)
            payload.set(
              buffer.subarray(chunkN * chunkSize, ++chunkN * chunkSize),
              meta.byteLength
            )
            peer.connection.send(payload)
          }
        }

        if (peerId) {
          const peer = peerMap[peerId]
          if (!peer) {
            throw mkErr(`no peer with id ${peerId} found`)
          }
          transmit(peer)
        } else {
          values(peerMap).forEach(transmit)
        }
      },
      f => (aMap.fn = f)
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

    addStream: (stream, peerId) => {
      if (typeof peerId === 'string') {
        const peer = peerMap[peerId]
        if (!peer) {
          throw mkErr(`no peer with id ${peerId} found`)
        }
        sendStream(peer, stream)
      } else {
        if (!peerId) {
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
