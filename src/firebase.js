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
import strategy from './strategy.js'
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

  subscribe: (rootRef, rootTopic, selfTopic, onMessage) => {
    const roomRef = child(rootRef, rootTopic)
    const selfRef = child(roomRef, selfTopic)
    const peerSignals = {}
    const unsubFns = []

    const handleMessage = (peerTopic, signal) => {
      const signalRef = push(child(roomRef, getPath(peerTopic, selfId)))

      onDisconnect(signalRef).remove()
      set(signalRef, signal)
    }

    let didSyncRoom = false

    unsubFns.push(
      onValue(roomRef, () => (didSyncRoom = true), {onlyOnce: true}),

      onChildAdded(roomRef, data => {
        if (!didSyncRoom) {
          return
        }

        const val = data.val()
        const owner = val[presencePath]

        if (owner) {
          onMessage(rootTopic, owner, handleMessage)
        }
      }),

      onChildAdded(selfRef, data => {
        const peerId = data.key

        if (peerId === presencePath) {
          return
        }

        unsubFns.push(
          onChildAdded(data.ref, data => {
            peerSignals[peerId] ||= {}

            if (data.key in peerSignals[peerId]) {
              return
            }

            peerSignals[peerId][data.key] = true

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
  },

  announce: async (rootRef, rootTopic, selfTopic) => {
    const roomRef = child(rootRef, rootTopic)
    const selfRef = child(roomRef, selfTopic)

    await remove(selfRef)
    set(selfRef, {[presencePath]: {peerId: selfId}})
    onDisconnect(selfRef).remove()
  }
})

export const getOccupants = (config, roomId) =>
  sha1(topicPath(libName, config.appId, roomId)).then(
    rootTopic =>
      new Promise(res =>
        onValue(
          ref(
            initDb(config),
            `${config.rootPath || defaultRootPath}/${rootTopic}`
          ),
          data => res(keys(data.val() || {})),
          {onlyOnce: true}
        )
      )
  )

export {selfId} from './utils.js'
