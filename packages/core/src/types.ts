import type {ActionOptions, InternalAction} from './action-wire'

export type JsonPrimitive = null | string | number | boolean

export type JsonValue = JsonPrimitive | JsonValue[] | {[key: string]: JsonValue}

export type DataPayload = JsonValue | Blob | ArrayBuffer | ArrayBufferView

export type PeerTarget = string | string[] | null

export type TargetPeers = PeerTarget | undefined

export type MaybePromise<T> = T | Promise<T>

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

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never

export type KernelRoomErrorInput = DistributiveOmit<
  RoomError,
  'appId' | 'roomId'
>

export type Unsubscribe = () => void

export type ListenerOptions = {
  once?: boolean
  signal?: AbortSignal
}

export type ReplayListenerOptions = ListenerOptions & {
  replay?: boolean
}

export type HandshakePayload = {
  data: DataPayload
  metadata?: JsonValue
}

export type HandshakeSender = (
  data: DataPayload,
  metadata?: JsonValue
) => Promise<void>

export type HandshakeReceiver = () => Promise<HandshakePayload>

export type PeerHandshake = (
  peerId: string,
  send: HandshakeSender,
  receive: HandshakeReceiver,
  isInitiator: boolean
) => Promise<void>

export type TurnServerConfig = {
  urls: string | string[]
  username?: string
  credential?: string
  credentialType?: string
}

export type RelayConnectivity = 'online' | 'offline' | 'auto'

export type BaseRelayConfig = {
  warnOnRelayFailure?: boolean
}

export type RelayConfig = BaseRelayConfig & {
  urls?: string[]
  redundancy?: number
}

export type TopologyMode = 'auto' | 'gossip'

export type ScaleConfig = {
  mode?: TopologyMode
  maxConnections?: number
  autoThreshold?: number
}

export type TopologyRoute = {
  nextHop: string
  hops: number
  backupNextHop?: string
}

export type TopologyStats = {
  messagesSent: number
  messagesReceived: number
  messagesForwarded: number
  duplicatesDropped: number
  signatureFailures: number
}

export type TopologySnapshot = {
  mode: TopologyMode
  activeMode: 'mesh' | 'gossip'
  selfId: string
  directPeerIds: string[]
  roomPeerIds: string[]
  routes: Record<string, TopologyRoute>
  stats: TopologyStats
}

export type UserIdentityPersistence = 'none' | 'local'

export type ResolvedIdentityPersistence = UserIdentityPersistence | 'custom'

export type UserIdentity = {
  userId: string
  publicKey: string
  signPubJwk: JsonWebKey
  sign: (payload: Uint8Array) => MaybePromise<Uint8Array>
  persisted?: boolean
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
  admins?: string[]
}

export type RoleCertificate = {
  v: 1
  certId: string
  issuerPubKey: string
  subUserId: string
  appId: string
  roomId: string
  roles: string[]
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

export type AuthoritativeState<T = JsonValue> = SharedState<T>

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

export type PublicRolesProvider = {
  getEffectiveRoomId: () => string
  getPeerRoles: (peerOrUserId?: string) => string[]
  isPeerBanned: (peerOrUserId: string) => boolean
  getBanReason?: (peerOrUserId: string) => string | undefined
}

export type PublicScaleProvider = {
  getActiveMode: () => 'mesh' | 'gossip'
  isDirectPeer: (peerId: string) => boolean
  isVirtualPeer: (peerId: string) => boolean
  getRoute: (peerId: string) => TopologyRoute | undefined
  getSnapshot: () => TopologySnapshot
}

export type PluginContext = {
  readonly selfId: string
  readonly appId: string
  readonly initialRoomId: string
  readonly password: string
  readonly limit?: number | undefined
  getRoomId: () => string
  getLocalUserIdentity: () => Promise<UserIdentity>
  getPeerUserId: (peerId: string) => string
  getKnownPeerUserId: (peerId: string) => string | undefined
  getUserPeerIds: (userId: string) => string[]
  getPeerPublicKey: (peerId: string) => JsonWebKey | undefined
  getActivePeerIds: () => string[]
  getAllPeerIds: () => string[]
  isPeerActive: (peerId: string) => boolean
  getPeerHandle: (
    peerId: string,
    includePending?: boolean
  ) => PeerHandle | undefined
  resolveSendTarget: (
    targets: TargetPeers,
    includePending?: boolean
  ) => TargetPeers
  resolveRequestTarget: (
    target: string,
    includePending?: boolean
  ) => string | undefined
  kickPeer: (peerId: string, reason?: Error) => void
  emitError: (error: KernelRoomErrorInput) => void
  makeAction: Room['makeAction']
  makeInternalAction: <T extends DataPayload = DataPayload>(
    namespace: string,
    options?: Partial<ActionOptions>
  ) => InternalAction<T>
  getRolesProvider: () => PublicRolesProvider | null
  getScaleProvider: () => PublicScaleProvider | null
  readonly onPeerActivated: (
    listener: (peerId: string, peer: PeerHandle) => unknown,
    options?: ReplayListenerOptions
  ) => Unsubscribe
  readonly onPeerDeactivated: (
    listener: (peerId: string) => unknown,
    options?: ListenerOptions
  ) => Unsubscribe
  readonly onRoomIdChanged: (
    listener: (roomId: string) => unknown,
    options?: ListenerOptions
  ) => Unsubscribe
  readonly onLeave: (
    listener: () => unknown,
    options?: ListenerOptions
  ) => Unsubscribe
}

export type RoomKernel = PluginContext

export type RoomPlugin<
  TName extends string = string,
  TApi extends Record<string, unknown> = Record<string, never>
> = {
  readonly name: TName
  readonly resolveRoomId?:
    | ((context: {
        appId: string
        roomId: string
        userIdentityP: Promise<UserIdentity>
      }) => Promise<{effectiveRoomId: string; state?: unknown}> | undefined)
    | undefined
  readonly setup: (
    kernel: PluginContext,
    preResolvedState?: unknown
  ) => TApi | void
}

export interface BaseRoomConfig {
  appId: string
  identity?: UserIdentityConfig
  limit?: number
  use?: readonly RoomPlugin<string, any>[]
  maxReceiveBytes?: number
  password?: string
  passive?: boolean
  relayConfig?: BaseRelayConfig
  trickleIce?: boolean
  rtcConfig?: RTCConfiguration
  rtcPolyfill?: typeof RTCPeerConnection
  turnConfig?: TurnServerConfig[]
}

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
  roles?: string[]
}

export type ActionReceiveHandler = (
  context: ActionReceiveContext
) => boolean | Promise<boolean>

export type MessageContext = {
  peerId: string
  userId: string
  metadata?: JsonValue
  roles?: string[]
}

export type RequestContext = {
  peerId: string
  userId: string
  metadata?: JsonValue
  signal: AbortSignal
  roles?: string[]
}

export type PeerResult<R extends DataPayload = DataPayload> =
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

export type RequestManyOptions<R extends DataPayload = DataPayload> = {
  targets: string[]
  metadata?: JsonValue
  timeoutMs?: number
  onProgress?: ActionProgressHandler
  onResult?: (result: PeerResult<R>) => void
  signal?: AbortSignal
}

export type ActionMessageHandler<T extends DataPayload = DataPayload> = (
  data: T,
  context: MessageContext
) => unknown

export type ActionRequestHandler<
  T extends DataPayload = DataPayload,
  R extends DataPayload = DataPayload
> = (data: T, context: RequestContext) => R | Promise<R>

export type MessageAction<T extends DataPayload = DataPayload> = {
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

export type RequestAction<
  T extends DataPayload = DataPayload,
  R extends DataPayload = DataPayload
> = {
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
  roles?: string | string[]
}

export type RequestActionConfig = {
  kind: 'request'
  roles?: string | string[]
}

export type AddMediaOptions = {
  target?: PeerTarget
  metadata?: JsonValue
}

export type RemoveMediaOptions = {
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
  persisted: boolean
  identityPersistence: ResolvedIdentityPersistence
  roomId: string
  baseRoomId: string
  isAdmin: boolean
  roles: string[]
}

export type Widen<T> = [JsonValue] extends [T]
  ? T
  : T extends string
    ? string
    : T extends number
      ? number
      : T extends boolean
        ? boolean
        : T extends readonly (infer U)[]
          ? Widen<U>[]
          : T extends object
            ? {[K in keyof T]: Widen<T[K]>}
            : T

export type RolesPluginApi = {
  grantRole: (
    targetId: string,
    role: string | string[]
  ) => Promise<RoleCertificate>
  revokeRole: (targetId: string, role?: string) => Promise<void>
  getRoles: (targetId?: string) => string[]
  ban: (targetId: string, options?: {reason?: string}) => Promise<void>
  isBanned: (targetId: string) => boolean
}

export type ScalePluginApi = {
  getTopology: () => TopologySnapshot
}

export type Room = {
  ready: Promise<void>
  makeAction: {
    <T extends DataPayload = DataPayload>(
      namespace: string,
      config?: MessageActionConfig
    ): MessageAction<T>
    <T extends DataPayload = DataPayload, R extends DataPayload = DataPayload>(
      namespace: string,
      config: RequestActionConfig
    ): RequestAction<T, R>
  }
  makeState: {
    <T extends JsonValue = JsonValue>(
      namespace: string,
      initialValue?: null,
      config?: StateConfig<Widen<T> | null>
    ): SharedState<Widen<T> | null>
    <T extends JsonValue>(
      namespace: string,
      initialValue: T,
      config?: StateConfig<Widen<T>>
    ): SharedState<Widen<T>>
  }
  makeUserState: {
    <T extends JsonValue = JsonValue>(
      namespace: string,
      initialValue?: null,
      config?: UserStateConfig<Widen<T> | null>
    ): UserState<Widen<T> | null>
    <T extends JsonValue>(
      namespace: string,
      initialValue: T,
      config?: UserStateConfig<Widen<T>>
    ): UserState<Widen<T>>
  }
  ping: (id: string) => Promise<number>
  leave: () => Promise<void>
  getSelf: () => Promise<SelfInfo>
  getPeers: () => Record<string, PeerInfo>
  getUsers: () => Record<string, UserInfo>
  addStream: (stream: MediaStream, options?: AddMediaOptions) => Promise<void>
  removeStream: (stream: MediaStream, options?: RemoveMediaOptions) => void
  replaceTrack: (
    oldTrack: MediaStreamTrack,
    newTrack: MediaStreamTrack,
    options?: RemoveMediaOptions
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

export type SessionSignal = {
  type: RTCSdpType
  sdp: string
}

export type CandidateSignal = {
  type: 'candidate'
  sdp: string
}

export type Signal = SessionSignal | CandidateSignal

export type PeerHandlers = {
  data?: (data: ArrayBuffer) => void
  connect?: () => void
  close?: () => void
  stream?: (stream: MediaStream) => void
  signal?: (signal: Signal) => void
  error?: (err: Error) => void
}

export type PeerHandle = {
  connection: RTCPeerConnection
  channel: RTCDataChannel | null
  isDead: boolean
  getOffer: (restartIce?: boolean) => Promise<Signal | void>
  signal: (sdp: Signal) => Promise<Signal | void>
  sendData: (data: Uint8Array) => void
  destroy: () => void
  setHandlers: (newHandlers: PeerHandlers) => void
  addStream: (stream: MediaStream) => void
  removeStream: (stream: MediaStream) => void
  addTrack: (track: MediaStreamTrack, stream: MediaStream) => void
  removeTrack: (track: MediaStreamTrack, stream?: MediaStream) => void
  replaceTrack: (
    oldTrack: MediaStreamTrack,
    newTrack: MediaStreamTrack
  ) => Promise<void> | undefined
}

type UnionToIntersection<U> = (
  U extends unknown ? (k: U) => void : never
) extends (k: infer I) => void
  ? I
  : never

export type InferPluginApi<TPlugin> =
  TPlugin extends RoomPlugin<string, infer TApi>
    ? 0 extends 1 & TApi
      ? unknown
      : TApi
    : Record<string, never>

export type RoomWithPlugins<
  TPlugins extends readonly RoomPlugin<string, any>[] | undefined = undefined
> = Room &
  (TPlugins extends readonly (infer P)[]
    ? [P] extends [never]
      ? unknown
      : UnionToIntersection<InferPluginApi<P>>
    : unknown)

declare const joinRoomConfigBrand: unique symbol

export type JoinRoom<TConfig extends BaseRoomConfig = JoinRoomConfig> = (<
  const TPlugins extends readonly RoomPlugin<string, any>[] | undefined =
    undefined
>(
  config: TConfig & {use?: TPlugins},
  roomId: string
) => RoomWithPlugins<TPlugins>) & {
  readonly [joinRoomConfigBrand]?: TConfig
}
