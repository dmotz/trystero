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
  mkErr,
  roles,
  scale,
  toJson,
  type BaseRelayConfig,
  type BaseRoomConfig,
  type JoinRoom,
  type StrategyMessage
} from '@trystero-p2p/core'

const unreachable = (x: never): never => {
  throw mkErr(`unreachable: ${String(x)}`)
}

type ActivePresenceFields = {
  readonly ref: DatabaseReference
  readonly latestPayload: Record<string, unknown>
  readonly unsubConnected: () => void
}

type PresenceState =
  | {readonly phase: 'unannounced'}
  | ({readonly phase: 'connecting'} & ActivePresenceFields)
  | ({readonly phase: 'connected'} & ActivePresenceFields)

type FirebaseRoomSession = {
  selfToken: symbol | null
  rootToken: symbol | null
  presence: PresenceState
}

type RoomSyncState =
  | {readonly phase: 'syncing'; readonly pendingOwners: StrategyMessage[]}
  | {readonly phase: 'live'}
  | {readonly phase: 'closed'}

const presencePath = '_'
const validPeerIdRe = /^[0-9A-Za-z]{20}$/
const defaultRootPath = `__${libName.toLowerCase()}__`
const dbs = /*@__PURE__*/ new Map<string, ReturnType<typeof getDatabase>>()
const appDbs = /*@__PURE__*/ new WeakMap<
  FirebaseApp,
  ReturnType<typeof getDatabase>
>()
const warnFlags = /*@__PURE__*/ new WeakMap<DatabaseReference, boolean>()
const roomSessions = /*@__PURE__*/ new Map<string, FirebaseRoomSession>()

export type FirebaseRelayConfig = BaseRelayConfig & {
  firebaseApp?: FirebaseApp
  firebasePath?: string
}

export type FirebaseRoomConfig = BaseRoomConfig & {
  relayConfig?: FirebaseRelayConfig
}

const getPath = (...xs: string[]): string => xs.join('/')
const getSessionKey = (
  rootRef: DatabaseReference,
  rootTopic: string,
  selfTopic: string
): string => `${String(rootRef)}|${rootTopic}|${selfTopic}`

const getOrCreateSession = (key: string): FirebaseRoomSession => {
  let session = roomSessions.get(key)
  if (!session) {
    session = {
      selfToken: null,
      rootToken: null,
      presence: {phase: 'unannounced'}
    }
    roomSessions.set(key, session)
  }
  return session
}

const clearPresence = (session: FirebaseRoomSession): void => {
  const {presence} = session
  switch (presence.phase) {
    case 'unannounced':
      return
    case 'connecting':
    case 'connected':
      session.presence = {phase: 'unannounced'}
      presence.unsubConnected()
      void onDisconnect(presence.ref)
        .cancel()
        .catch(() => {})
      void remove(presence.ref).catch(() => {})
      return
    default:
      unreachable(presence)
  }
}

const pruneSessionIfIdle = (
  key: string,
  session: FirebaseRoomSession
): void => {
  if (
    session.selfToken === null &&
    session.rootToken === null &&
    session.presence.phase === 'unannounced'
  ) {
    roomSessions.delete(key)
  }
}

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
      const key = getSessionKey(rootRef, rootTopic, selfTopic)
      const session = getOrCreateSession(key)
      const subscriptionToken = Symbol(key)
      const unsubFns: Array<() => void> = []
      const onListenerError = (err: Error): void => {
        if (warnFlags.get(rootRef) !== false) {
          console.warn(`${libName}: firebase listener error - ${err.message}`)
        }
      }

      if (kind === 'self') {
        session.selfToken = subscriptionToken
        let isSelfActive = true
        const selfRef = child(roomRef, selfTopic)
        const peerSignals = new Map<string, Set<string>>()

        const selfCleanup = onChildAdded(
          selfRef,
          data => {
            if (!isSelfActive) {
              return
            }

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
                  if (!isSelfActive) {
                    return
                  }

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
          if (!isSelfActive) {
            return
          }
          isSelfActive = false
          selfCleanup()
          unsubFns.forEach(unsub => unsub())
          unsubFns.length = 0

          const current = roomSessions.get(key)
          if (current?.selfToken === subscriptionToken) {
            current.selfToken = null
            void remove(selfRef).catch(() => {})
            pruneSessionIfIdle(key, current)
          }
        }
      }

      if (session.rootToken !== null) {
        clearPresence(session)
      }
      session.rootToken = subscriptionToken

      const syncBox: {state: RoomSyncState} = {
        state: {phase: 'syncing', pendingOwners: []}
      }

      const detachRoot = (): void => {
        if (syncBox.state.phase === 'closed') {
          return
        }
        syncBox.state = {phase: 'closed'}
        unsubFns.forEach(unsub => unsub())
        unsubFns.length = 0

        const current = roomSessions.get(key)
        if (current?.rootToken === subscriptionToken) {
          current.rootToken = null
          clearPresence(current)
          pruneSessionIfIdle(key, current)
        }
      }

      const processRoomEntry = (
        value: Record<string, unknown> | null
      ): void => {
        const owner = value?.[presencePath]
        if (!owner) {
          return
        }

        switch (syncBox.state.phase) {
          case 'syncing':
            syncBox.state.pendingOwners.push(owner as StrategyMessage)
            return
          case 'live':
            void onMessage(topic, owner as StrategyMessage)
            return
          case 'closed':
            return
          default:
            unreachable(syncBox.state)
        }
      }

      const isSyncClosed = (): boolean => syncBox.state.phase === 'closed'

      return new Promise<() => void>((resolve, reject) => {
        const handleCancel = (err: Error): void => {
          onListenerError(err)
          const wasSyncing = syncBox.state.phase === 'syncing'
          detachRoot()
          if (wasSyncing) {
            reject(err)
          }
        }

        const unsubValue = onValue(
          roomRef,
          () => {
            if (syncBox.state.phase !== 'syncing') {
              return
            }
            const {pendingOwners} = syncBox.state
            syncBox.state = {phase: 'live'}
            pendingOwners.forEach(owner => {
              void onMessage(topic, owner)
            })
            resolve(detachRoot)
          },
          handleCancel,
          {onlyOnce: true}
        )
        if (isSyncClosed()) {
          unsubValue()
          return
        }
        unsubFns.push(unsubValue)

        const unsubChildAdded = onChildAdded(
          roomRef,
          data => {
            processRoomEntry(data.val() as Record<string, unknown> | null)
          },
          handleCancel
        )
        if (isSyncClosed()) {
          unsubChildAdded()
          return
        }
        unsubFns.push(unsubChildAdded)
      })
    },

    publishTopic: (
      rootRef,
      topic,
      msg,
      {kind, rootTopic, selfTopic, peerId}
    ) => {
      const roomRef = child(rootRef, rootTopic)
      const key = getSessionKey(rootRef, rootTopic, selfTopic)
      const onWriteError = (err: unknown): void => {
        if (warnFlags.get(rootRef) !== false) {
          console.warn(
            `${libName}: firebase write error - ${err instanceof Error ? err.message : String(err)}`
          )
        }
      }

      if (kind === 'announce') {
        const session = roomSessions.get(key)
        if (!session || session.rootToken === null) {
          return
        }

        const activeRootToken = session.rootToken
        const payload: Record<string, unknown> = {
          [presencePath]:
            typeof msg === 'string'
              ? fromJson<Record<string, unknown>>(msg)
              : msg
        }

        switch (session.presence.phase) {
          case 'connecting':
          case 'connected':
            if (toJson(session.presence.latestPayload) !== toJson(payload)) {
              session.presence = {
                ...session.presence,
                latestPayload: payload
              }
              void set(session.presence.ref, payload).catch(onWriteError)
            }
            return
          case 'unannounced':
            break
          default:
            unreachable(session.presence)
        }

        const activeRef = push(roomRef)
        let unsubConnected = (): void => {}

        void onDisconnect(activeRef)
          .remove()
          .catch(() => {})
        void set(activeRef, payload).catch(onWriteError)

        session.presence = {
          phase: 'connecting',
          ref: activeRef,
          latestPayload: payload,
          unsubConnected: () => unsubConnected()
        }

        unsubConnected = onValue(
          child(rootRef.root, '.info/connected'),
          snapshot => {
            if (snapshot.val() !== true) {
              return
            }

            const current = roomSessions.get(key)
            if (
              !current ||
              current.rootToken !== activeRootToken ||
              current.presence.phase === 'unannounced' ||
              current.presence.ref !== activeRef
            ) {
              return
            }

            if (current.presence.phase === 'connecting') {
              current.presence = {
                ...current.presence,
                phase: 'connected'
              }
              return
            }

            void onDisconnect(activeRef)
              .remove()
              .then(() => {
                const latestSession = roomSessions.get(key)
                if (
                  latestSession &&
                  latestSession.rootToken === activeRootToken &&
                  latestSession.presence.phase === 'connected' &&
                  latestSession.presence.ref === activeRef
                ) {
                  void set(
                    activeRef,
                    latestSession.presence.latestPayload
                  ).catch(onWriteError)
                }
              })
              .catch(() => {})
          }
        )

        if (roomSessions.get(key)?.presence.phase === 'unannounced') {
          unsubConnected()
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
