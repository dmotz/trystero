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
  createTopicStrategy,
  fromJson,
  libName,
  selfId,
  type BaseRelayConfig,
  type BaseRoomConfig,
  type JoinRoom,
  type StrategyMessage
} from '@trystero-p2p/core'

const presencePath = '_'
const defaultRootPath = `__${libName.toLowerCase()}__`
const dbs: Record<string, ReturnType<typeof getDatabase>> = {}
const presenceRefs: Record<string, DatabaseReference> = {}
const subscriptionTokens: Record<string, symbol> = {}

export type FirebaseRelayConfig = BaseRelayConfig & {
  firebaseApp?: FirebaseApp
  firebasePath?: string
}

export type FirebaseRoomConfig = BaseRoomConfig & {
  relayConfig?: FirebaseRelayConfig
}

const getPath = (...xs: string[]): string => xs.join('/')
const roomKey = (rootTopic: string, selfTopic: string): string =>
  `${rootTopic}|${selfTopic}`

const initDb = (config: FirebaseRoomConfig): ReturnType<typeof getDatabase> =>
  config.relayConfig?.firebaseApp
    ? (dbs[
        config.relayConfig.firebaseApp.options.databaseURL ?? config.appId
      ] ??= getDatabase(config.relayConfig.firebaseApp))
    : (dbs[config.appId] ??= getDatabase(
        initializeApp({databaseURL: config.appId})
      ))

export const joinRoom: JoinRoom<FirebaseRoomConfig> = createTopicStrategy({
  init: config =>
    ref(initDb(config), config.relayConfig?.firebasePath ?? defaultRootPath),

  subscribeTopic: (rootRef, topic, onMessage, context) => {
    const {rootTopic, selfTopic, kind} = context
    const roomRef = child(rootRef, rootTopic)
    const key = roomKey(rootTopic, selfTopic)
    const subscriptionToken = (subscriptionTokens[key] ??= Symbol(key))
    const unsubFns: Array<() => void> = []

    if (kind === 'self') {
      const selfRef = child(roomRef, selfTopic)
      const peerSignals: Record<string, Record<string, boolean>> = {}

      const selfCleanup = onChildAdded(selfRef, data => {
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

            void onMessage(topic, nestedData.val() as StrategyMessage)
            void remove(nestedData.ref)
          })
        )
      })

      return () => {
        selfCleanup()
        unsubFns.forEach(unsub => unsub())

        if (subscriptionTokens[key] === subscriptionToken) {
          void remove(selfRef)
        }
      }
    }

    const pendingRoomOwners: StrategyMessage[] = []

    const processRoomEntry = (value: Record<string, unknown> | null): void => {
      const owner = value?.[presencePath]

      if (!owner) {
        return
      }

      if (!didSyncRoom) {
        pendingRoomOwners.push(owner as Record<string, unknown>)
        return
      }

      void onMessage(topic, owner as StrategyMessage)
    }

    let didSyncRoom = false

    unsubFns.push(
      onValue(
        roomRef,
        () => {
          didSyncRoom = true
          pendingRoomOwners.forEach(owner => {
            void onMessage(topic, owner)
          })
          pendingRoomOwners.length = 0
        },
        {onlyOnce: true}
      ),

      onChildAdded(roomRef, data => {
        processRoomEntry(data.val() as Record<string, unknown> | null)
      })
    )

    return () => {
      unsubFns.forEach(unsub => unsub())

      if (subscriptionTokens[key] !== subscriptionToken) {
        return
      }

      if (presenceRefs[key]) {
        void remove(presenceRefs[key])
        delete presenceRefs[key]
      }

      delete subscriptionTokens[key]
    }
  },

  publishTopic: (rootRef, topic, msg, {kind, rootTopic, selfTopic}) => {
    const roomRef = child(rootRef, rootTopic)
    const key = roomKey(rootTopic, selfTopic)

    if (kind === 'announce') {
      const presenceRef =
        presenceRefs[key] ?? (presenceRefs[key] = push(roomRef))

      void set(presenceRef, {
        [presencePath]:
          typeof msg === 'string' ? fromJson<Record<string, unknown>>(msg) : msg
      })
      void onDisconnect(presenceRef).remove()
      return
    }

    const signalRef = push(child(roomRef, getPath(topic, selfId)))

    void onDisconnect(signalRef).remove()
    void set(signalRef, msg)
  },

  unpublishTopic: (rootRef, _topic, {rootTopic, selfTopic}) => {
    const key = roomKey(rootTopic, selfTopic)

    if (presenceRefs[key]) {
      void remove(presenceRefs[key])
      delete presenceRefs[key]
    }
  }
})

export {selfId}

export type * from '@trystero-p2p/core'
