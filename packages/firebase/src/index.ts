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
  clearUserIdentity,
  createTopicStrategy,
  createUserIdentity,
  exportUserIdentity,
  fromJson,
  importUserIdentity,
  libName,
  roles,
  scale,
  type BaseRelayConfig,
  type BaseRoomConfig,
  type JoinRoom,
  type StrategyMessage
} from '@trystero-p2p/core'

const presencePath = '_'
const validPeerIdRe = /^[0-9A-Za-z]{20}$/
const defaultRootPath = `__${libName.toLowerCase()}__`
const dbs = new Map<string, ReturnType<typeof getDatabase>>()
const appDbs = /*@__PURE__*/ new WeakMap<
  FirebaseApp,
  ReturnType<typeof getDatabase>
>()
const warnFlags = /*@__PURE__*/ new WeakMap<DatabaseReference, boolean>()
const presenceRefs = new Map<string, DatabaseReference>()
const presenceMessages = new Map<string, Record<string, unknown>>()
const presenceCleanups = new Map<string, () => void>()
const subscriptionTokens = new Map<string, symbol>()

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

const initDb = (config: FirebaseRoomConfig): ReturnType<typeof getDatabase> => {
  const app = config.relayConfig?.firebaseApp
  if (app) {
    let db = appDbs.get(app)
    if (!db) {
      db = getDatabase(app)
      appDbs.set(app, db)
    }
    return db
  }
  let db = dbs.get(config.appId)
  if (!db) {
    db = getDatabase(initializeApp({databaseURL: config.appId}))
    dbs.set(config.appId, db)
  }
  return db
}

export const joinRoom: JoinRoom<FirebaseRoomConfig> =
  /*@__PURE__*/ createTopicStrategy<DatabaseReference, FirebaseRoomConfig>({
    reannounceOnDisconnect: false,

    init: config => {
      const rootRef = ref(
        initDb(config),
        config.relayConfig?.firebasePath ?? defaultRootPath
      )
      warnFlags.set(rootRef, config.relayConfig?.warnOnRelayFailure !== false)
      return rootRef
    },

    subscribeTopic: (rootRef, topic, onMessage, context) => {
      const {rootTopic, selfTopic, kind} = context
      const roomRef = child(rootRef, rootTopic)
      const key = roomKey(rootTopic, selfTopic)
      let subscriptionToken = subscriptionTokens.get(key)
      if (!subscriptionToken) {
        subscriptionToken = Symbol(key)
        subscriptionTokens.set(key, subscriptionToken)
      }
      const unsubFns: Array<() => void> = []
      const onListenerError = (err: Error): void => {
        if (warnFlags.get(rootRef) !== false) {
          console.warn(`${libName}: firebase listener error - ${err.message}`)
        }
      }

      if (kind === 'self') {
        const selfRef = child(roomRef, selfTopic)
        const peerSignals = new Map<string, Set<string>>()

        const selfCleanup = onChildAdded(
          selfRef,
          data => {
            const peerId = data.key

            if (
              !peerId ||
              peerId === presencePath ||
              !validPeerIdRe.test(peerId)
            ) {
              return
            }

            unsubFns.push(
              onChildAdded(
                data.ref,
                nestedData => {
                  let seen = peerSignals.get(peerId)
                  if (!seen) {
                    seen = new Set()
                    peerSignals.set(peerId, seen)
                  }

                  if (nestedData.key && seen.has(nestedData.key)) {
                    return
                  }

                  if (nestedData.key) {
                    seen.add(nestedData.key)
                  }

                  void onMessage(topic, nestedData.val() as StrategyMessage)
                  void remove(nestedData.ref).catch(() => {})
                },
                onListenerError
              )
            )
          },
          onListenerError
        )

        return () => {
          selfCleanup()
          unsubFns.forEach(unsub => unsub())

          if (subscriptionTokens.get(key) === subscriptionToken) {
            void remove(selfRef).catch(() => {})
          }
        }
      }

      const pendingRoomOwners: StrategyMessage[] = []
      let didSyncRoom = false

      const processRoomEntry = (
        value: Record<string, unknown> | null
      ): void => {
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

      const cleanup = (): void => {
        unsubFns.forEach(unsub => unsub())

        if (subscriptionTokens.get(key) !== subscriptionToken) {
          return
        }

        const presenceRef = presenceRefs.get(key)
        if (presenceRef) {
          presenceCleanups.get(key)?.()
          void remove(presenceRef).catch(() => {})
          presenceRefs.delete(key)
          presenceMessages.delete(key)
          presenceCleanups.delete(key)
        }

        subscriptionTokens.delete(key)
      }

      return new Promise<() => void>((resolve, reject) => {
        let settled = false
        const rejectInitial = (err: Error): void => {
          onListenerError(err)
          if (!settled) {
            settled = true
            cleanup()
            reject(err)
          }
        }

        unsubFns.push(
          onValue(
            roomRef,
            () => {
              didSyncRoom = true
              pendingRoomOwners.forEach(owner => {
                void onMessage(topic, owner)
              })
              pendingRoomOwners.length = 0
              if (!settled) {
                settled = true
                resolve(cleanup)
              }
            },
            rejectInitial,
            {onlyOnce: true}
          ),

          onChildAdded(
            roomRef,
            data => {
              processRoomEntry(data.val() as Record<string, unknown> | null)
            },
            rejectInitial
          )
        )
      })
    },

    publishTopic: (
      rootRef,
      topic,
      msg,
      {kind, rootTopic, selfTopic, peerId}
    ) => {
      const roomRef = child(rootRef, rootTopic)
      const key = roomKey(rootTopic, selfTopic)
      const onWriteError = (err: unknown): void => {
        if (warnFlags.get(rootRef) !== false) {
          console.warn(
            `${libName}: firebase write error - ${err instanceof Error ? err.message : String(err)}`
          )
        }
      }

      if (kind === 'announce') {
        const payload = {
          [presencePath]:
            typeof msg === 'string'
              ? fromJson<Record<string, unknown>>(msg)
              : msg
        }
        presenceMessages.set(key, payload)

        let presenceRef = presenceRefs.get(key)
        if (!presenceRef) {
          presenceRef = push(roomRef)
          presenceRefs.set(key, presenceRef)
        }

        if (!presenceCleanups.has(key)) {
          let didConnect = false
          const activeRef = presenceRef

          void onDisconnect(activeRef)
            .remove()
            .catch(() => {})
          void set(activeRef, payload).catch(onWriteError)
          presenceCleanups.set(
            key,
            onValue(child(rootRef.root, '.info/connected'), snapshot => {
              if (snapshot.val() !== true) {
                return
              }

              const isReconnect = didConnect
              didConnect = true

              if (!isReconnect) {
                return
              }

              void onDisconnect(activeRef)
                .remove()
                .then(() => {
                  const latest = presenceMessages.get(key)
                  if (presenceRefs.get(key) === activeRef && latest) {
                    void set(activeRef, latest).catch(onWriteError)
                  }
                })
                .catch(() => {})
            })
          )
        }

        return
      }

      const signalRef = push(child(roomRef, getPath(topic, peerId)))

      void onDisconnect(signalRef)
        .remove()
        .catch(() => {})
      void set(signalRef, msg).catch(onWriteError)
      return undefined
    }
  })

export {
  clearUserIdentity,
  createUserIdentity,
  exportUserIdentity,
  importUserIdentity,
  roles,
  scale
}

export type * from '@trystero-p2p/core/types'
