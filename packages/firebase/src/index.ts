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
  type ActionError,
  type ActionErrorKind,
  type ActionMessageHandler,
  type ActionProgressContext,
  type ActionProgressHandler,
  type ActionReceiveContext,
  type ActionReceiveHandler,
  type ActionRequestHandler,
  type AddMediaOptions,
  type BanOptions,
  type BaseRelayConfig,
  type BaseRoomConfig,
  type DataPayload,
  type JoinRoom,
  type JsonValue,
  type ListenerOptions,
  type MessageAction,
  type MessageActionConfig,
  type MessageContext,
  type PeerInfo,
  type PeerJoinContext,
  type PeerLeaveContext,
  type PeerMediaContext,
  type PeerResult,
  type PeerTarget,
  type RemoveMediaOptions,
  type ReplaceTrackOptions,
  type ReplayListenerOptions,
  type RequestAction,
  type RequestActionConfig,
  type RequestContext,
  type RequestManyOptions,
  type RequestOptions,
  type RoleCertificate,
  type RolesConfig,
  type RolesPluginApi,
  type Room,
  type RoomError,
  type RoomErrorBase,
  type RoomErrorCode,
  type RoomErrorHandler,
  type RoomPlugin,
  type RoomWithPlugins,
  type ScaleConfig,
  type ScalePluginApi,
  type SelfInfo,
  type SendOptions,
  type SharedState,
  type StateChangeContext,
  type StateConfig,
  type StrategyMessage,
  type TopologyRoute,
  type TopologySnapshot,
  type TopologyStats,
  type TurnServerConfig,
  type Unsubscribe,
  type UserIdentity,
  type UserIdentityConfig,
  type UserIdentityLoader,
  type UserIdentityLoaderContext,
  type UserInfo,
  type UserJoinContext,
  type UserLeaveContext,
  type UserState,
  type UserStateChangeContext,
  type UserStateConfig
} from '@trystero-p2p/core'

const presencePath = '_'
const defaultRootPath = `__${libName.toLowerCase()}__`
const dbs: Record<string, ReturnType<typeof getDatabase>> = {}
const appDbs = /*@__PURE__*/ new WeakMap<
  FirebaseApp,
  ReturnType<typeof getDatabase>
>()
const warnFlags = /*@__PURE__*/ new WeakMap<DatabaseReference, boolean>()
const presenceRefs: Record<string, DatabaseReference> = {}
const presenceMessages: Record<string, Record<string, unknown>> = {}
const presenceCleanups: Record<string, () => void> = {}
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
  return (dbs[config.appId] ??= getDatabase(
    initializeApp({databaseURL: config.appId})
  ))
}

export const joinRoom: JoinRoom<FirebaseRoomConfig> =
  /*@__PURE__*/ createTopicStrategy({
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
      const subscriptionToken = (subscriptionTokens[key] ??= Symbol(key))
      const unsubFns: Array<() => void> = []
      const onListenerError = (err: Error): void => {
        if (warnFlags.get(rootRef) !== false) {
          console.warn(`${libName}: firebase listener error - ${err.message}`)
        }
      }

      if (kind === 'self') {
        const selfRef = child(roomRef, selfTopic)
        const peerSignals: Record<string, Record<string, boolean>> = {}

        const selfCleanup = onChildAdded(
          selfRef,
          data => {
            const peerId = data.key

            if (!peerId || peerId === presencePath) {
              return
            }

            unsubFns.push(
              onChildAdded(
                data.ref,
                nestedData => {
                  peerSignals[peerId] ??= {}

                  if (nestedData.key && nestedData.key in peerSignals[peerId]) {
                    return
                  }

                  if (nestedData.key) {
                    peerSignals[peerId][nestedData.key] = true
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

          if (subscriptionTokens[key] === subscriptionToken) {
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

        if (subscriptionTokens[key] !== subscriptionToken) {
          return
        }

        if (presenceRefs[key]) {
          presenceCleanups[key]?.()
          void remove(presenceRefs[key]).catch(() => {})
          delete presenceRefs[key]
          delete presenceMessages[key]
          delete presenceCleanups[key]
        }

        delete subscriptionTokens[key]
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
        presenceMessages[key] = {
          [presencePath]:
            typeof msg === 'string'
              ? fromJson<Record<string, unknown>>(msg)
              : msg
        }

        const presenceRef =
          presenceRefs[key] ?? (presenceRefs[key] = push(roomRef))

        if (!presenceCleanups[key]) {
          let didConnect = false

          void onDisconnect(presenceRef)
            .remove()
            .catch(() => {})
          void set(presenceRef, presenceMessages[key]).catch(onWriteError)
          presenceCleanups[key] = onValue(
            child(rootRef.root, '.info/connected'),
            snapshot => {
              if (snapshot.val() !== true) {
                return
              }

              const isReconnect = didConnect
              didConnect = true

              if (!isReconnect) {
                return
              }

              void onDisconnect(presenceRef)
                .remove()
                .then(() => {
                  if (presenceRefs[key] === presenceRef) {
                    void set(presenceRef, presenceMessages[key]).catch(
                      onWriteError
                    )
                  }
                })
                .catch(() => {})
            }
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

export type {
  ActionError,
  ActionErrorKind,
  ActionMessageHandler,
  ActionProgressContext,
  ActionProgressHandler,
  ActionReceiveContext,
  ActionReceiveHandler,
  ActionRequestHandler,
  AddMediaOptions,
  BanOptions,
  DataPayload,
  JsonValue,
  ListenerOptions,
  MessageAction,
  MessageActionConfig,
  MessageContext,
  PeerInfo,
  PeerJoinContext,
  PeerLeaveContext,
  PeerMediaContext,
  PeerResult,
  PeerTarget,
  RemoveMediaOptions,
  ReplaceTrackOptions,
  ReplayListenerOptions,
  RequestAction,
  RequestActionConfig,
  RequestContext,
  RequestManyOptions,
  RequestOptions,
  RoleCertificate,
  RolesConfig,
  RolesPluginApi,
  Room,
  RoomError,
  RoomErrorBase,
  RoomErrorCode,
  RoomErrorHandler,
  RoomPlugin,
  RoomWithPlugins,
  ScaleConfig,
  ScalePluginApi,
  SelfInfo,
  SendOptions,
  SharedState,
  StateChangeContext,
  StateConfig,
  TopologyRoute,
  TopologySnapshot,
  TopologyStats,
  TurnServerConfig,
  Unsubscribe,
  UserIdentity,
  UserIdentityConfig,
  UserIdentityLoader,
  UserIdentityLoaderContext,
  UserInfo,
  UserJoinContext,
  UserLeaveContext,
  UserState,
  UserStateChangeContext,
  UserStateConfig
}
