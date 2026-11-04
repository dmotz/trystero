import type {
  BaseRelayConfig,
  BaseRoomConfig,
  InferPluginApi,
  MaybePromise,
  ResolvedIdentityPersistence,
  UserIdentityPersistence
} from './internal-types'

type JsonPrimitive = null | string | number | boolean

export type JsonValue = JsonPrimitive | JsonValue[] | {[key: string]: JsonValue}

type NonJsonObject =
  | ((...args: never[]) => unknown)
  | Date
  | RegExp
  | Error
  | Promise<unknown>
  | ReadonlyMap<unknown, unknown>
  | ReadonlySet<unknown>
  | WeakMap<object, unknown>
  | WeakSet<object>
  | ArrayBuffer
  | ArrayBufferView
  | Blob

export type JsonSerializable<T> = T extends JsonPrimitive
  ? T
  : T extends NonJsonObject | bigint | symbol | undefined
    ? never
    : T extends readonly (infer U)[]
      ? readonly JsonSerializable<U>[]
      : T extends object
        ? {
            [K in keyof T]: K extends symbol
              ? never
              : Exclude<T[K], undefined> extends infer V
                ? [V] extends [never]
                  ? undefined
                  : JsonSerializable<V> | Extract<T[K], undefined>
                : never
          }
        : never

export type DataPayload = JsonValue | Blob | ArrayBuffer | ArrayBufferView

export type DataPayloadValue<T> = T extends Blob | ArrayBuffer | ArrayBufferView
  ? T
  : JsonSerializable<T>

export type PeerTarget = string | string[] | null

export type ActionErrorKind =
  | 'timeout'
  | 'disconnected'
  | 'aborted'
  | 'rejected'

export type ActionError = Error & {
  readonly kind: ActionErrorKind
}

export type RoomErrorBase = {
  message: string
  appId: string
  roomId: string
  cause?: unknown
}

export type RoomError =
  | (RoomErrorBase & {code: 'room-full'; peerId: string})
  | (RoomErrorBase & {code: 'banned'; peerId?: string; reason?: string})
  | (RoomErrorBase & {code: 'relay-failed'})
  | (RoomErrorBase & {code: 'identity-failed'})
  | (RoomErrorBase & {code: 'plugin-failed'; plugin?: string})
  | (RoomErrorBase & {
      code: 'decrypt-failed'
      peerId: string
      stage: 'offer' | 'answer'
    })
  | (RoomErrorBase & {
      code: 'peer-connect-failed'
      peerId: string
      turnConfigured: boolean
    })
  | (RoomErrorBase & {code: 'handshake-failed'; peerId: string})
  | (RoomErrorBase & {code: 'peer-error'; peerId: string})

export type RoomErrorCode = RoomError['code']

export type RoomErrorHandler = (error: RoomError) => unknown

export type Unsubscribe = () => void

export type ListenerOptions = {
  once?: boolean
  signal?: AbortSignal
}

export type ReplayListenerOptions = ListenerOptions & {
  replay?: boolean
}

export type TurnServerConfig = {
  urls: string | string[]
  username?: string
  credential?: string
  credentialType?: string
}

export type RelayConnectivity = 'online' | 'offline' | 'auto'

export type RelayConfig = BaseRelayConfig & {
  urls?: string[]
  redundancy?: number
}

export type ScaleConfig = {
  maxDirectPeers?: number
}

export type TopologyRoute = {
  nextHop: string
  hops: number
}

export type TopologyStats = {
  messagesSent: number
  messagesReceived: number
  messagesForwarded: number
  duplicatesDropped: number
  signatureFailures: number
}

export type TopologySnapshot = {
  peerId: string
  directPeerIds: string[]
  roomPeerIds: string[]
  routes: Record<string, TopologyRoute>
  stats: TopologyStats
}

export type UserIdentity = {
  userId: string
  signPubJwk: JsonWebKey
  sign: (payload: Uint8Array) => MaybePromise<Uint8Array>
  persistence?: ResolvedIdentityPersistence
}

export type UserIdentityLoaderContext = {
  appId: string
  roomId: string
}

export type UserIdentityLoader = (
  context: UserIdentityLoaderContext
) => MaybePromise<UserIdentity>

export type UserIdentityConfig =
  | UserIdentityPersistence
  | UserIdentity
  | UserIdentityLoader

export type RolesConfig = {
  selfAsAdmin?: boolean
  admins?: readonly string[]
}

export type RoleCertificate = {
  v: 1
  certId: string
  issuerPubKey: string
  subUserId: string
  appId: string
  roomId: string
  roles: string[]
  seq: number
  iat: number
  sig: string
}

export type StateChangeContext<T = JsonValue> = {
  prev: T
  peerId: string
  userId: string
  roles: string[]
  timestamp: number
}

export type StateConfig<T = JsonValue> = {
  roles?: string | readonly string[]
  maxBytes?: number
  validate?: (next: T, context: StateChangeContext<T>) => boolean
}

export type SharedState<T = JsonValue> = {
  get: () => T
  set: (next: T | ((prev: T) => T)) => Promise<void>
  getMeta: () => StateChangeContext<T> | null
  readonly onChange: (
    handler: (value: T, context: StateChangeContext<T>) => unknown,
    options?: ReplayListenerOptions
  ) => Unsubscribe
}

export type UserStateChangeContext<T = JsonValue> = StateChangeContext<T> & {
  self: boolean
  online: boolean
  removed: boolean
}

export type UserStateConfig<T = JsonValue> = {
  roles?: string | readonly string[]
  maxBytes?: number
  validate?: (next: T, context: UserStateChangeContext<T>) => boolean
}

export type UserState<T = JsonValue> = {
  get: (id?: string) => T
  getAll: () => Readonly<Record<string, T>>
  has: (id?: string) => boolean
  set: (next: T | ((prev: T) => T)) => Promise<void>
  clear: () => Promise<void>
  getMeta: (id?: string) => UserStateChangeContext<T> | null
  readonly onChange: (
    handler: (
      value: T | undefined,
      context: UserStateChangeContext<T>
    ) => unknown,
    options?: ReplayListenerOptions
  ) => Unsubscribe
}

declare const pluginApiBrand: unique symbol

export type RoomPlugin<
  TName extends string = string,
  TApi extends object = Record<never, never>
> = {
  readonly name: TName
  readonly [pluginApiBrand]?: TApi
}

export type AnyRoomPlugin = RoomPlugin<string, object>

export type JoinRoomConfig = BaseRoomConfig & {
  relayConfig?: RelayConfig
}

export type ActionProgressContext = {
  peerId: string
  userId: string
  metadata?: JsonValue
}

export type ActionProgressHandler = (
  progress: number,
  context: ActionProgressContext
) => unknown

export type ActionReceiveContext = {
  peerId: string
  userId: string
  byteLength: number
  kind: 'message' | 'request' | 'response'
  signal: AbortSignal
  metadata?: JsonValue
  roles: string[]
}

export type ActionReceiveHandler = (
  context: ActionReceiveContext
) => boolean | Promise<boolean>

export type MessageContext = {
  peerId: string
  userId: string
  metadata?: JsonValue
  roles: string[]
}

export type RequestContext = {
  peerId: string
  userId: string
  metadata?: JsonValue
  signal: AbortSignal
  roles: string[]
}

export type PeerResult<R = DataPayload> =
  | {peerId: string; userId: string; status: 'fulfilled'; value: R}
  | {peerId: string; userId: string; status: 'timeout'}
  | {peerId: string; userId: string; status: 'rejected'; error: Error}
  | {peerId: string; userId: string; status: 'disconnected'}

export type SendOptions = {
  target?: PeerTarget
  metadata?: JsonValue
  onProgress?: ActionProgressHandler
  signal?: AbortSignal
}

export type RequestOptions = {
  target: string
  metadata?: JsonValue
  timeoutMs?: number
  onProgress?: ActionProgressHandler
  signal?: AbortSignal
}

export type RequestManyOptions<R = DataPayload> = {
  targets: string[]
  metadata?: JsonValue
  timeoutMs?: number
  onProgress?: ActionProgressHandler
  onResult?: (result: PeerResult<R>) => void
  signal?: AbortSignal
}

export type ActionMessageHandler<T = DataPayload> = (
  data: T,
  context: MessageContext
) => unknown

export type ActionRequestHandler<T = DataPayload, R = DataPayload> = (
  data: T,
  context: RequestContext
) => R | Promise<R>

export type MessageAction<T = DataPayload> = {
  send: (data: T, options?: SendOptions) => Promise<void>
  readonly onMessage: (
    handler: ActionMessageHandler<T>,
    options?: ListenerOptions
  ) => Unsubscribe
  readonly onReceiveProgress: (
    handler: ActionProgressHandler,
    options?: ListenerOptions
  ) => Unsubscribe
  readonly onReceive: (
    handler: ActionReceiveHandler,
    options?: ListenerOptions
  ) => Unsubscribe
}

export type RequestAction<T = DataPayload, R = DataPayload> = {
  request: (data: T, options: RequestOptions) => Promise<R>
  requestMany: (
    data: T,
    options: RequestManyOptions<R>
  ) => Promise<PeerResult<R>[]>
  readonly onRequest: (
    handler: ActionRequestHandler<T, R>,
    options?: ListenerOptions
  ) => Unsubscribe
  readonly onReceiveProgress: (
    handler: ActionProgressHandler,
    options?: ListenerOptions
  ) => Unsubscribe
  readonly onReceive: (
    handler: ActionReceiveHandler,
    options?: ListenerOptions
  ) => Unsubscribe
}

export type MessageActionConfig = {
  kind?: 'message'
  roles?: string | readonly string[]
}

export type RequestActionConfig = {
  kind: 'request'
  roles?: string | readonly string[]
}

export type AddMediaOptions = {
  target?: PeerTarget
  metadata?: JsonValue
}

export type RemoveMediaOptions = {
  target?: PeerTarget
}

export type ReplaceTrackOptions = {
  target?: PeerTarget
}

export type PeerJoinContext = {
  peerId: string
  userId: string
  roles: string[]
}

export type PeerLeaveContext = {
  peerId: string
  userId: string
}

export type UserJoinContext = {
  userId: string
  peerId: string
  roles: string[]
}

export type UserLeaveContext = {
  userId: string
  peerId: string
}

export type PeerMediaContext = {
  peerId: string
  userId: string
  metadata?: JsonValue
}

export type PeerInfo = {
  userId: string
  connection: RTCPeerConnection | null
  direct: boolean
  hops: number
  roles: string[]
}

export type UserInfo = {
  peerIds: string[]
  roles: string[]
}

export type SelfInfo = {
  peerId: string
  userId: string
  identityPersistence: ResolvedIdentityPersistence
  roomId: string
  baseRoomId: string
  isAdmin: boolean
  roles: string[]
}

type IsUnion<T, U = T> = T extends unknown
  ? [U] extends [T]
    ? false
    : true
  : never

export type Widen<T> = [T] extends [never]
  ? never
  : [JsonValue] extends [T]
    ? T
    : [IsUnion<T>] extends [true]
      ? T
      : [T] extends [string]
        ? string
        : [T] extends [number]
          ? number
          : [T] extends [boolean]
            ? boolean
            : T extends readonly (infer U)[]
              ? number extends T['length']
                ? T extends (infer M)[]
                  ? Widen<M>[]
                  : readonly Widen<U>[]
                : T['length'] extends 0
                  ? T extends (infer M)[]
                    ? Widen<M>[]
                    : readonly Widen<U>[]
                  : {[K in keyof T]: Widen<T[K]>}
              : T extends object
                ? {[K in keyof T]: Widen<T[K]>}
                : T

export type BanOptions = {
  reason?: string
}

export type RoleChangeContext = {
  userId: string
  roles: string[]
  previousRoles: string[]
  local: boolean
}

export type RoleChangeHandler = (context: RoleChangeContext) => unknown

export type RolesPluginApi = {
  grantRole: (
    targetId: string,
    role: string | readonly string[]
  ) => Promise<RoleCertificate>
  revokeRole: (targetId: string, role?: string) => Promise<void>
  getRoles: (targetId?: string) => string[]
  ban: (targetId: string, options?: BanOptions) => Promise<void>
  unban: (targetId: string) => Promise<void>
  isBanned: (targetId: string) => boolean
  readonly onRoleChange: (
    handler: RoleChangeHandler,
    options?: ReplayListenerOptions
  ) => Unsubscribe
}

export type ScalePluginApi = {
  getTopology: () => TopologySnapshot
}

export type Room = {
  ready: Promise<void>
  makeAction: {
    <T = DataPayload>(
      namespace: [T] extends [DataPayloadValue<T>] ? string : never,
      config?: MessageActionConfig
    ): MessageAction<T>
    <T = DataPayload, R = DataPayload>(
      namespace: [T, R] extends [DataPayloadValue<T>, DataPayloadValue<R>]
        ? string
        : never,
      config: RequestActionConfig
    ): RequestAction<T, R>
  }
  makeState: {
    <T = JsonValue>(
      namespace: [T] extends [JsonSerializable<T>] ? string : never,
      initialValue?: null,
      config?: StateConfig<Widen<T> | null>
    ): SharedState<Widen<T> | null>
    <T>(
      namespace: string,
      initialValue: T & JsonSerializable<T>,
      config?: StateConfig<Widen<T>>
    ): SharedState<Widen<T>>
  }
  makeUserState: {
    <T = JsonValue>(
      namespace: [T] extends [JsonSerializable<T>] ? string : never,
      initialValue?: null,
      config?: UserStateConfig<Widen<T> | null>
    ): UserState<Widen<T> | null>
    <T>(
      namespace: string,
      initialValue: T & JsonSerializable<T>,
      config?: UserStateConfig<Widen<T>>
    ): UserState<Widen<T>>
  }
  ping: (id: string) => Promise<number>
  leave: () => Promise<void>
  getSelf: () => Promise<SelfInfo>
  getPeers: () => Record<string, PeerInfo>
  getUsers: () => Readonly<Record<string, UserInfo>>
  addStream: (stream: MediaStream, options?: AddMediaOptions) => Promise<void>
  removeStream: (stream: MediaStream, options?: RemoveMediaOptions) => void
  replaceTrack: (
    oldTrack: MediaStreamTrack,
    newTrack: MediaStreamTrack,
    options?: ReplaceTrackOptions
  ) => Promise<void>
  readonly onPeerJoin: (
    handler: (context: PeerJoinContext) => unknown,
    options?: ReplayListenerOptions
  ) => Unsubscribe
  readonly onPeerLeave: (
    handler: (context: PeerLeaveContext) => unknown,
    options?: ListenerOptions
  ) => Unsubscribe
  readonly onUserJoin: (
    handler: (context: UserJoinContext) => unknown,
    options?: ReplayListenerOptions
  ) => Unsubscribe
  readonly onUserLeave: (
    handler: (context: UserLeaveContext) => unknown,
    options?: ListenerOptions
  ) => Unsubscribe
  readonly onPeerStream: (
    handler: (stream: MediaStream, context: PeerMediaContext) => unknown,
    options?: ReplayListenerOptions
  ) => Unsubscribe
  readonly onError: (
    handler: RoomErrorHandler,
    options?: ListenerOptions
  ) => Unsubscribe
}

type UnionToIntersection<U> = (
  U extends unknown ? (k: U) => void : never
) extends (k: infer I) => void
  ? I
  : never

export type RoomWithPlugins<
  TPlugins extends readonly AnyRoomPlugin[] | undefined = undefined
> = Room &
  (TPlugins extends readonly (infer P)[]
    ? [P] extends [never]
      ? unknown
      : UnionToIntersection<InferPluginApi<P>>
    : unknown)
