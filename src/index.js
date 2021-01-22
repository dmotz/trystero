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
const TypedArray = Object.getPrototypeOf(Uint8Array)
const typeByteLimit = 12
const metaTagSize = typeByteLimit + 2
const chunkSize = 16 * (2 ^ 10) - metaTagSize

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
  const actions = {}
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
      const buffer = new Uint8Array(data)
      const action = new TextDecoder().decode(buffer.subarray(0, typeByteLimit))
      const nonce = buffer.subarray(typeByteLimit, typeByteLimit + 1)[0]
      const tag = buffer.subarray(typeByteLimit + 1, typeByteLimit + 2)[0]
      const payload = buffer.subarray(typeByteLimit + 2)
      const isLast = !!(tag & 1)
      const isMeta = !!(tag & (1 << 1))
      const isBinary = !!(tag & (1 << 2))
      const isJson = !!(tag & (1 << 3))

      if (!actions[action]) {
        throw mkErr(`received message with unregistered type (${action})`)
      }

      if (!pendingTransmissions[key]) {
        pendingTransmissions[key] = {}
      }

      if (!pendingTransmissions[key][action]) {
        pendingTransmissions[key][action] = {}
      }

      let target = pendingTransmissions[key][action][nonce]

      if (!target) {
        target = pendingTransmissions[key][action][nonce] = {chunks: []}
      }

      if (isMeta) {
        target.meta = JSON.parse(new TextDecoder().decode(payload))
      } else {
        target.chunks.push(payload)
      }

      if (!isLast) {
        return
      }

      const {chunks} = target
      const full = new Uint8Array(chunks.reduce((a, c) => a + c.byteLength, 0))

      chunks.forEach((b, i) => full.set(b, i && chunks[i - 1].byteLength))

      if (isBinary) {
        actions[action](key, full, target.meta)
      } else {
        const text = new TextDecoder().decode(full)
        actions[action](key, isJson ? JSON.parse(text) : text)
      }

      delete pendingTransmissions[key][action][nonce]
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
    delete pendingTransmissions[id]
    onPeerLeave(id)
  }

  function makeAction(type) {
    if (!type) {
      throw mkErr('action type argument is required')
    }

    if (actions[type]) {
      throw mkErr(`action '${type}' already registered`)
    }

    const typeEncoded = new TextEncoder().encode(type)

    if (typeEncoded.byteLength > typeByteLimit) {
      throw mkErr(
        `action type string "${type}" (${typeEncoded.byteLength}b) exceeds ` +
          `byte limit (${typeByteLimit}). Hint: choose a shorter name.`
      )
    }

    const typeBytes = new Uint8Array(typeByteLimit)
    typeBytes.set(typeEncoded)

    const typePadded = new TextDecoder().decode(typeBytes)

    let nonce = 0

    actions[typePadded] = noOp
    pendingTransmissions[type] = {}

    return [
      async (data, peerId, meta) => {
        const peers = entries(peerMap)

        if (!peers.length) {
          return
        }

        const isJson = typeof data === 'object' || typeof data === 'number'
        const isBlob = data instanceof Blob
        const isBinary =
          isBlob || data instanceof ArrayBuffer || data instanceof TypedArray

        const buffer = isBinary
          ? new Uint8Array(isBlob ? await data.arrayBuffer() : data)
          : new TextEncoder().encode(isJson ? JSON.stringify(data) : data)

        const metaEncoded = meta
          ? new TextEncoder().encode(JSON.stringify(meta))
          : null

        const chunkTotal =
          Math.ceil(buffer.byteLength / chunkSize) + (meta ? 1 : 0)

        const chunks = new Array(chunkTotal).fill().map((_, i) => {
          const isLast = i === chunkTotal - 1
          const isMeta = meta && i === 0
          const chunk = new Uint8Array(
            metaTagSize +
              (isMeta
                ? metaEncoded.byteLength
                : isLast
                ? buffer.byteLength - chunkSize * (chunkTotal - (meta ? 2 : 1))
                : chunkSize)
          )

          chunk.set(typeBytes)
          chunk.set([nonce], typeBytes.byteLength)
          chunk.set(
            [isLast | (isMeta << 1) | (isBinary << 2) | (isJson << 3)],
            typeBytes.byteLength + 1
          )
          chunk.set(
            meta
              ? isMeta
                ? metaEncoded
                : buffer.subarray((i - 1) * chunkSize, i * chunkSize)
              : buffer.subarray(i * chunkSize, (i + 1) * chunkSize),
            metaTagSize
          )

          return chunk
        })

        nonce = (nonce + 1) & 0xff

        const transmit = async ([id, peer]) => {
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

            if (!peerMap[id]) {
              break
            }

            peer.connection.send(chunks[chunkN++])
          }
        }

        if (peerId) {
          const peer = peerMap[peerId]
          if (!peer) {
            throw mkErr(`no peer with id ${peerId} found`)
          }
          return transmit([peerId, peer])
        }

        return Promise.all(peers.map(transmit))
      },
      f => (actions[typePadded] = f)
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
