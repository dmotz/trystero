import {initializeApp, type FirebaseApp} from 'firebase/app'
import {
  child,
  getDatabase,
  onChildAdded,
  onDisconnect,
  onValue,
  push,
  ref,
  remove,
  set,
  type DatabaseReference
} from 'firebase/database'
import {
  createStrategy,
  libName,
  selfId,
  type BaseRoomConfig,
  type JoinRoom
} from '@trystero/core'

const presencePath = '_'
const defaultRootPath = `__${libName.toLowerCase()}__`
const dbs: Record<string, ReturnType<typeof getDatabase>> = {}
const presenceRefs: Record<string, DatabaseReference> = {}
const subscriptionTokens: Record<string, symbol> = {}

export type FirebaseRoomConfig = BaseRoomConfig & {
  firebaseApp?: FirebaseApp
  rootPath?: string
}

const getPath = (...xs: string[]): string => xs.join('/')

const initDb = (config: FirebaseRoomConfig): ReturnType<typeof getDatabase> =>
  config.firebaseApp
    ? (dbs[config.firebaseApp.options.databaseURL ?? config.appId] ??=
        getDatabase(config.firebaseApp))
    : (dbs[config.appId] ??= getDatabase(
        initializeApp({databaseURL: config.appId})
      ))

export const joinRoom: JoinRoom<FirebaseRoomConfig> = createStrategy({
  init: config =>
    ref(initDb(config), String(config.rootPath ?? defaultRootPath)),

  subscribe: (rootRef, rootTopic, selfTopic, onMessage) => {
    const roomRef = child(rootRef, rootTopic)
    const selfRef = child(roomRef, selfTopic)
    const peerSignals: Record<string, Record<string, boolean>> = {}
    const unsubFns: Array<() => void> = []
    const roomKey = `${rootTopic}|${selfTopic}`
    const subscriptionToken = Symbol(roomKey)
    const pendingRoomOwners: Array<Record<string, unknown>> = []

    subscriptionTokens[roomKey] = subscriptionToken

    const processRoomEntry = (
      value: Record<string, {peerId: string}> | null
    ): void => {
      const owner = value?.[presencePath]

      if (!owner) {
        return
      }

      if (!didSyncRoom) {
        pendingRoomOwners.push(owner as Record<string, unknown>)
        return
      }

      void onMessage(rootTopic, owner as Record<string, unknown>, handleMessage)
    }

    const handleMessage = (peerTopic: string, signal: string): void => {
      const signalRef = push(child(roomRef, getPath(peerTopic, selfId)))

      void onDisconnect(signalRef).remove()
      void set(signalRef, signal)
    }

    let didSyncRoom = false

    unsubFns.push(
      onValue(
        roomRef,
        () => {
          didSyncRoom = true
          pendingRoomOwners.forEach(owner => {
            void onMessage(rootTopic, owner, handleMessage)
          })
          pendingRoomOwners.length = 0
        },
        {onlyOnce: true}
      ),

      onChildAdded(roomRef, data => {
        processRoomEntry(data.val() as Record<string, {peerId: string}> | null)
      }),

      onChildAdded(selfRef, data => {
        const peerId = data.key

        if (!peerId || peerId === presencePath) {
          return
        }

        unsubFns.push(
          onChildAdded(data.ref, nestedData => {
            peerSignals[peerId] ??= {}

            if (nestedData.key && nestedData.key in peerSignals[peerId]) {
              return
            }

            if (nestedData.key) {
              peerSignals[peerId][nestedData.key] = true
            }

            void onMessage(
              selfTopic,
              nestedData.val() as Record<string, unknown>,
              handleMessage
            )
            void remove(nestedData.ref)
          })
        )
      })
    )

    return () => {
      unsubFns.forEach(unsub => unsub())

      if (subscriptionTokens[roomKey] !== subscriptionToken) {
        return
      }

      void remove(selfRef)

      if (presenceRefs[roomKey]) {
        void remove(presenceRefs[roomKey])
        delete presenceRefs[roomKey]
      }

      delete subscriptionTokens[roomKey]
    }
  },

  announce: (rootRef, rootTopic, selfTopic) => {
    const roomRef = child(rootRef, rootTopic)
    const roomKey = `${rootTopic}|${selfTopic}`
    const presenceRef =
      presenceRefs[roomKey] ?? (presenceRefs[roomKey] = push(roomRef))

    void set(presenceRef, {[presencePath]: {peerId: selfId}})
    void onDisconnect(presenceRef).remove()
  }
})

export {selfId}

export type * from '@trystero/core'
