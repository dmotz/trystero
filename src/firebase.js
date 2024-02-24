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
import {sha1} from './crypto.js'
import strategy from './strategy'
import {keys, libName, selfId, topicPath} from './utils.js'

const presencePath = '_'
const defaultRootPath = `__${libName.toLowerCase()}__`
const dbs = {}

const getPath = (...xs) => xs.join('/')

const initDb = config => {
  if (config.firebaseApp) {
    const url = config.firebaseApp.options.databaseURL
    return dbs[url] || (dbs[url] = getDatabase(config.firebaseApp))
  }

  return (
    dbs[config.appId] ||
    (dbs[config.appId] = getDatabase(
      initializeApp({databaseURL: config.appId})
    ))
  )
}

export const joinRoom = strategy({
  init: config => ref(initDb(config), config.rootPath || defaultRootPath),

  subscribe: (rootRef, roomTopic, selfTopic, onMessage) => {
    const roomRef = child(rootRef, roomTopic)
    const selfRef = child(roomRef, selfTopic)
    const peerSigs = {}
    const unsubFns = []

    const handleMessage = (peerTopic, signal) => {
      const signalRef = push(child(roomRef, getPath(peerTopic, selfId)))

      onDisconnect(signalRef).remove()
      set(signalRef, signal)
    }

    let didSyncRoom = false

    set(selfRef, {[presencePath]: {peerId: selfId}})
    onDisconnect(selfRef).remove()
    unsubFns.push(
      onValue(roomRef, () => (didSyncRoom = true), {onlyOnce: true}),

      onChildAdded(roomRef, data => {
        if (!didSyncRoom) {
          return
        }

        onMessage(roomTopic, data.val()[presencePath], handleMessage)
      }),

      onChildAdded(selfRef, data => {
        const peerId = data.key

        if (peerId === presencePath) {
          return
        }

        unsubFns.push(
          onChildAdded(data.ref, data => {
            if (!(peerId in peerSigs)) {
              peerSigs[peerId] = {}
            }

            if (data.key in peerSigs[peerId]) {
              return
            }

            peerSigs[peerId][data.key] = true

            onMessage(selfTopic, data.val(), handleMessage)
            remove(data.ref)
          })
        )
      })
    )

    return () => {
      off(roomRef)
      off(selfRef)
      remove(selfRef)
      unsubFns.forEach(f => f())
    }
  }
})

export const getOccupants = (config, ns) =>
  sha1(topicPath(libName, config.appId, ns)).then(
    roomTopic =>
      new Promise(res =>
        onValue(
          ref(
            initDb(config),
            `${config.rootPath || defaultRootPath}/${roomTopic}`
          ),
          data => res(keys(data.val() || {})),
          {onlyOnce: true}
        )
      )
  )

export {selfId} from './utils.js'
