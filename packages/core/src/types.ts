import type {ActionOptions, InternalAction} from './action-wire'
import type {OfferManager} from './offer-manager'

export type {ActionOptions, InternalAction}

export type JsonPrimitive = null | string | number | boolean

export type JsonValue = JsonPrimitive | JsonValue[] | {[key: string]: JsonValue}

export type DataPayload = JsonValue | Blob | ArrayBuffer | ArrayBufferView

export type PeerTarget = string | string[] | null

export type TargetPeers = PeerTarget | undefined

export type JoinError = {
  error: string
  appId: string
  roomId: string
  peerId: string
}

export type JoinErrorHandler = (details: JoinError) => void

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

export type JoinRoomCallbacks = {
  onJoinError?: JoinErrorHandler
}

export type TurnServerConfig = {
  urls: string | string[]
  username?: string
  credential?: string
  credentialType?: string
}

export type BaseRelayConfig = {
  manualReconnection?: boolean
  warnOnRelayFailure?: boolean
}

export type RelayConfig = BaseRelayConfig & {
  urls?: string[]
  redundancy?: number
}

export type TopologyMode = 'mesh' | 'auto' | 'gossip'

export type ScaleConfig = {
  mode?: TopologyMode
  maxConnections?: number
  autoThreshold?: number
  fanout?: number
}

export type TopologyRoute = {
  nextHop: string
  hops: number
  backupNextHop?: string
}

export type TopologyMediaTree = {
  broadcasterId: string
  parentId: string | null
  childrenIds: string[]
}

export type TopologyStats = {
  messagesSent: number
  messagesReceived: number
  messagesForwarded: number
  duplicatesDropped: number
  signatureFailures: number
  treeReparents: number
}

export type TopologySnapshot = {
  mode: TopologyMode
  activeMode: 'mesh' | 'gossip'
  selfId: string
  directPeerIds: string[]
  roomPeerIds: string[]
  routes: Record<string, TopologyRoute>
  mediaTrees: Record<string, TopologyMediaTree>
  stats: TopologyStats
}

export type UserIdentityPersistence = 'none' | 'session' | 'local'

export type UserIdentity = {
  userId: string
  publicKey: string
  signPubJwk: JsonWebKey
  sign: (payload: Uint8Array) => MaybePromise<Uint8Array>
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
  subPeerId: string
  subUserId?: string
  subPubKey: JsonWebKey
  appId: string
  roomId: string
  roles: string[]
  canDelegate?: boolean
  isRoot?: boolean
  iat: number
  parentCert?: RoleCertificate
  sig: string
}

export type RoleRevocationRecord = {
  v: 1
  appId: string
  roomId: string
  issuerPeerId: string
  targetPeerId: string
  targetUserId?: string
  targetCertId?: string
  role?: string
  seq: number
  ts: number
  issuerCert: RoleCertificate
  signerPubKey?: JsonWebKey
  userPubKey?: JsonWebKey
  userProof?: string
  sig: string
}

export type PeerBanRecord = {
  v: 1
  appId: string
  roomId: string
  issuerPeerId: string
  targetPeerId: string
  targetUserId?: string
  reason?: string
  seq: number
  ts: number
  issuerCert: RoleCertificate
  signerPubKey?: JsonWebKey
  userPubKey?: JsonWebKey
  userProof?: string
  sig: string
}

export type AuthoritativeStateRecord<T = JsonValue> = {
  v: 1
  appId: string
  roomId: string
  namespace: string
  seq: number
  prevHash: string
  ts: number
  updatedBy: string
  userId?: string
  userPubKey?: JsonWebKey
  userProof?: string
  signerPubKey: JsonWebKey
  cert: RoleCertificate
  value: T
  sig: string
  hash: string
}

export type StateChangeContext = {
  updatedBy: string
  userId?: string
  roles: string[]
  seq: number
  timestamp: number
  hash: string
}

export type StateConfig<T = JsonValue> = {
  roles?: string | string[]
  validate?: (next: T, prev: T, context: StateChangeContext) => boolean
}

export type AuthoritativeState<T = JsonValue> = {
  get: () => T
  set: (next: T | ((prev: T) => T)) => Promise<void>
  getMeta: () => StateChangeContext | null
  onChange: ((value: T, prev: T, context: StateChangeContext) => void) | null
}

export type KernelRolesProvider = {
  getEffectiveRoomId: () => string
  getPeerRoles: (peerOrUserId?: string) => string[]
  isPeerBanned: (peerOrUserId: string) => boolean
  registerPeerPublicKey: (peerId: string, pubKey: JsonWebKey) => void
  canPeerSendAction: (
    peerId: string,
    requiredRoles: readonly string[],
    inlineCert?: RoleCertificate
  ) => Promise<boolean> | boolean
  onPeerDescriptorCert: (
    peerId: string,
    signPubKey: JsonWebKey,
    cert?: RoleCertificate,
    userId?: string
  ) => void
  signActionPayload: (
    namespace: string,
    requiredRoles: readonly string[],
    data: DataPayload,
    userMetadata?: JsonValue
  ) => Promise<JsonValue>
  verifyActionOffer: (
    namespace: string,
    peerId: string,
    requiredRoles: readonly string[],
    wireMetadata?: JsonValue
  ) => Promise<{valid: boolean; userMetadata?: JsonValue; roles: string[]}>
  verifyActionPayload: (
    namespace: string,
    peerId: string,
    requiredRoles: readonly string[],
    data: DataPayload,
    wireMetadata?: JsonValue
  ) => Promise<{valid: boolean; userMetadata?: JsonValue; roles: string[]}>
  getAuthorityInfo: () => Promise<Omit<SelfInfo, 'peerId'>>
}

export type KernelScaleProvider = {
  isOverlayActive: () => boolean
  isOverlayFrame: (data: ArrayBuffer) => boolean
  handleOverlayFrame: (fromPeerId: string, data: ArrayBuffer) => void
  addDirectPeer: (peerId: string, peer: PeerHandle) => void
  removeDirectPeer: (peerId: string, peer?: PeerHandle) => boolean
  isDirectPeer: (peerId: string) => boolean
  isVirtualPeer: (peerId: string) => boolean
  getRoute: (peerId: string) => TopologyRoute | undefined
  isExpectedMediaRelayParent: (
    broadcasterId: string,
    fromPeerId: string
  ) => boolean
  broadcastInline: (
    frame: Uint8Array,
    onProgress?: (peerId: string) => void
  ) => Promise<boolean>
  getMediaTargets: (broadcasterId?: string) => string[]
  registerBroadcastStream: (
    broadcasterId: string,
    streamKey: string,
    stream: MediaStream,
    metadata?: JsonValue
  ) => void
  unregisterBroadcastStream: (
    broadcasterId: string,
    stream: MediaStream
  ) => string[]
  unregisterBroadcastStreamById: (
    broadcasterId: string,
    streamId: string
  ) => {stream: MediaStream; targets: string[]} | null
  registerBroadcastTrack: (
    broadcasterId: string,
    trackKey: string,
    track: MediaStreamTrack,
    stream: MediaStream,
    metadata?: JsonValue
  ) => void
  unregisterBroadcastTrack: (
    broadcasterId: string,
    trackId: string,
    trackKeys?: string[]
  ) => Array<{track: MediaStreamTrack; key: string; targets: string[]}>
  replaceBroadcastTrack: (
    broadcasterId: string,
    oldTrack: MediaStreamTrack,
    newTrack: MediaStreamTrack,
    metadata?: JsonValue
  ) => void
  requireDirectPeer: (peerId: string) => void
  notePeerDiscovered: (peerId: string) => void
  shouldConnectPeer: (
    peerId: string,
    direction: 'outbound' | 'inbound'
  ) => boolean
  getTargetNeighbors: () => Set<string>
  setOnTargetsChanged: (cb: (targetPeerIds: string[]) => void) => void
  announceLeave: () => void
  destroy: () => void
  getSnapshot: () => TopologySnapshot
  getPeerSignPublicKey: (peerId: string) => JsonWebKey | undefined
  setPeerSignPublicKey: (peerId: string, pubKey: JsonWebKey) => void
  setLocalRoleCertificate: (cert: RoleCertificate | null) => void
  markPeerBanned: (peerId: string) => void
  isPeerBanned: (peerId: string) => boolean
  registerActionAuthority: (actionType: string, roles: string[]) => void
  recordSignatureFailure: () => void
  setRoomId: (effectiveRoomId: string) => void
}

export type RoomKernel = {
  readonly selfId: string
  readonly appId: string
  readonly initialRoomId: string
  readonly password: string
  getRoomId: () => string
  setEffectiveRoomId: (roomId: string) => void
  getLocalUserIdentity: () => Promise<UserIdentity>
  getPeerUserId: (peerId: string) => string
  getKnownPeerUserId: (peerId: string) => string | undefined
  setPeerUserId: (peerId: string, userId: string) => void
  getUserPeerIds: (userId: string) => string[]
  getPeerPublicKey: (peerId: string) => JsonWebKey | undefined
  setPeerPublicKey: (peerId: string, pubKey: JsonWebKey) => void
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
  makeAction: Room['makeAction']
  makeInternalAction: <T extends DataPayload = DataPayload>(
    namespace: string,
    options?: Partial<ActionOptions>
  ) => InternalAction<T>
  deliverRawData: (originPeerId: string, data: ArrayBuffer) => void
  registerRolesProvider: (provider: KernelRolesProvider) => void
  registerScaleProvider: (provider: KernelScaleProvider) => void
  getRolesProvider: () => KernelRolesProvider | null
  getScaleProvider: () => KernelScaleProvider | null
  onPeerActivated: (
    listener: (peerId: string, peer: PeerHandle) => void
  ) => void
  onPeerDeactivated: (listener: (peerId: string) => void) => void
  onRoomIdChanged: (listener: (roomId: string) => void) => void
  onLeave: (listener: () => void) => void
  activateVirtualPeer: (peerId: string, vPeer: PeerHandle) => void
  deactivateVirtualPeer: (peerId: string, reason?: Error) => void
  relayMediaStream: (
    broadcasterId: string,
    stream: MediaStream,
    metadata: JsonValue | undefined,
    targetPeerIds: string[],
    streamKey: string,
    tracks?: MediaStreamTrack[]
  ) => void
  relayMediaTrack: (
    broadcasterId: string,
    track: MediaStreamTrack,
    stream: MediaStream,
    metadata: JsonValue | undefined,
    targetPeerIds: string[],
    trackKey: string
  ) => void
}

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
    kernel: RoomKernel,
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

export type TestOnlyRoomConfig = BaseRoomConfig & {
  _test_only_forcedPeerId?: string
  _test_only_mdnsHostFallbackToLoopback?: boolean
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
) => void

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

export type MessageAction<T extends DataPayload = DataPayload> = {
  send: (data: T, options?: SendOptions) => Promise<void>
  onMessage: ((data: T, context: MessageContext) => void | Promise<void>) | null
  onReceiveProgress: ActionProgressHandler | null
  onReceive: ActionReceiveHandler | null
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
  onRequest: ((data: T, context: RequestContext) => R | Promise<R>) | null
  onReceiveProgress: ActionProgressHandler | null
  onReceive: ActionReceiveHandler | null
}

export type MessageActionConfig<T extends DataPayload = DataPayload> = {
  kind?: 'message'
  roles?: string | string[]
  onMessage?: (data: T, context: MessageContext) => void | Promise<void>
  onReceiveProgress?: ActionProgressHandler
  onReceive?: ActionReceiveHandler
}

export type RequestActionConfig<
  T extends DataPayload = DataPayload,
  R extends DataPayload = DataPayload
> = {
  kind: 'request'
  roles?: string | string[]
  onRequest?: (data: T, context: RequestContext) => R | Promise<R>
  onReceiveProgress?: ActionProgressHandler
  onReceive?: ActionReceiveHandler
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
  roomId: string
  baseRoomId: string
  fingerprint: string | null
  isAdmin: boolean
  roles: string[]
}

export type RolesPluginApi = {
  makeState: <T = JsonValue>(
    namespace: string,
    initialValue: T extends JsonValue ? T : never,
    config?: StateConfig<T>
  ) => AuthoritativeState<T>
  grantRole: (
    targetId: string,
    role: string | string[],
    options?: {canDelegate?: boolean}
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
      config?: MessageActionConfig<T>
    ): MessageAction<T>
    <T extends DataPayload = DataPayload, R extends DataPayload = DataPayload>(
      namespace: string,
      config: RequestActionConfig<T, R>
    ): RequestAction<T, R>
  }
  ping: (id: string) => Promise<number>
  leave: () => Promise<void>
  getSelf: () => Promise<SelfInfo>
  getPeers: () => Record<string, PeerInfo>
  getUsers: () => Record<string, UserInfo>
  addStream: (stream: MediaStream, options?: AddMediaOptions) => Promise<void>[]
  removeStream: (stream: MediaStream, options?: RemoveMediaOptions) => void
  addTrack: (
    track: MediaStreamTrack,
    stream: MediaStream,
    options?: AddMediaOptions
  ) => Promise<void>[]
  removeTrack: (track: MediaStreamTrack, options?: RemoveMediaOptions) => void
  replaceTrack: (
    oldTrack: MediaStreamTrack,
    newTrack: MediaStreamTrack,
    options?: AddMediaOptions
  ) => Promise<void>[]
  onPeerJoin: ((context: PeerJoinContext) => void) | null
  onPeerLeave: ((context: PeerLeaveContext) => void) | null
  onUserJoin: ((context: UserJoinContext) => void) | null
  onUserLeave: ((context: UserLeaveContext) => void) | null
  onPeerStream:
    | ((stream: MediaStream, context: PeerMediaContext) => void)
    | null
  onPeerTrack:
    | ((
        track: MediaStreamTrack,
        stream: MediaStream,
        context: PeerMediaContext
      ) => void)
    | null
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
  track?: (track: MediaStreamTrack, stream: MediaStream) => void
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
  removeTrack: (track: MediaStreamTrack) => void
  replaceTrack: (
    oldTrack: MediaStreamTrack,
    newTrack: MediaStreamTrack
  ) => Promise<void> | undefined
}

export type SignalPeer = (
  peerTopic: string,
  signal: string
) => void | Promise<void>

export type StrategyMessage = string | Record<string, unknown>

export type StrategyOnMessage = (
  topic: string,
  msg: StrategyMessage,
  signalPeer: SignalPeer
) => void | Promise<void>

export type StrategyContext<TConfig extends BaseRoomConfig = JoinRoomConfig> = {
  config: TConfig
  appId: string
  roomId: string
  isPassive: boolean
  peerId?: string
}

export type TopicSubscriptionContext = {
  kind: 'root' | 'self'
  appId: string
  roomId: string
  rootTopic: string
  selfTopic: string
  peerId: string
}

export type TopicPublishContext = {
  kind: 'announce' | 'signal'
  appId: string
  roomId: string
  rootTopic: string
  selfTopic: string
  peerId: string
}

export type OfferRecord = {
  peer: PeerHandle
  offer: string
  claim?: () => void
  reclaim?: () => void
}

export type MaybePromise<T> = T | Promise<T>

export type AnnounceResult =
  | number
  | {stopAnnouncing: true}
  | {nextAnnounceMs: number; reannounceOnDisconnect?: boolean}

export type StrategyAdapter<
  TRelay,
  TConfig extends BaseRoomConfig = JoinRoomConfig
> = {
  init: (config: TConfig) => MaybePromise<TRelay> | Array<MaybePromise<TRelay>>
  subscribe: (
    relay: TRelay,
    rootTopic: string,
    selfTopic: string,
    onMessage: StrategyOnMessage,
    getOffers: (n: number) => Promise<OfferRecord[]>,
    context?: StrategyContext<TConfig>
  ) => MaybePromise<() => void>
  announce: (
    relay: TRelay,
    rootTopic: string,
    selfTopic: string,
    extraPayload?: Record<string, unknown>,
    context?: StrategyContext<TConfig>
  ) => MaybePromise<AnnounceResult | void>
  deactivate?: (
    relay: TRelay,
    rootTopic: string,
    selfTopic: string,
    context?: StrategyContext<TConfig>
  ) => MaybePromise<void>
}

export type TopicStrategyAdapter<
  TRelay,
  TConfig extends BaseRoomConfig = JoinRoomConfig
> = {
  steadyAnnounceIntervalMs?: number
  reannounceOnDisconnect?: boolean
  init: (config: TConfig) => MaybePromise<TRelay> | Array<MaybePromise<TRelay>>
  subscribeTopic: (
    relay: TRelay,
    topic: string,
    onMessage: (topic: string, msg: StrategyMessage) => void | Promise<void>,
    context: TopicSubscriptionContext
  ) => MaybePromise<() => void>
  publishTopic: (
    relay: TRelay,
    topic: string,
    msg: StrategyMessage,
    context: TopicPublishContext
  ) => MaybePromise<AnnounceResult | void>
  unpublishTopic?: (
    relay: TRelay,
    topic: string,
    context: TopicPublishContext
  ) => MaybePromise<void>
}

type UnionToIntersection<U> = (
  U extends unknown ? (k: U) => void : never
) extends (k: infer I) => void
  ? I
  : never

export type InferPluginApi<TPlugin> =
  TPlugin extends RoomPlugin<string, infer TApi> ? TApi : Record<string, never>

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
  roomId: string,
  callbacks?: JoinRoomCallbacks
) => RoomWithPlugins<TPlugins>) & {
  readonly [joinRoomConfigBrand]?: TConfig
}

export type SocketClient = {
  socket: WebSocket
  url: string
  ready: Promise<SocketClient>
  isClosed?: boolean
  close?: () => void
  send: (data: string) => void
}

export type RemoteTrackRef = {
  track: MediaStreamTrack
  stream: MediaStream
}

export type MediaIdentityCache = {
  getStreamKey: (stream: MediaStream) => string
  getTrackKey: (track: MediaStreamTrack) => string
  rememberRemoteStream: (
    key: string,
    stream: MediaStream,
    streamId?: string
  ) => void
  getRemoteStream: (key: string, streamId?: string) => MediaStream | undefined
  rememberRemoteTrack: (
    key: string,
    track: MediaStreamTrack,
    stream: MediaStream,
    trackId?: string,
    streamId?: string
  ) => void
  getRemoteTrack: (key: string, trackId?: string) => RemoteTrackRef | undefined
  hasRemoteMedia: () => boolean
  clearRemote: () => void
}

export type PeerState = {
  offerPeer: PeerHandle | null
  offerId: string | null
  offerSdp: string | null
  offerInitPromise: Promise<{
    peer: PeerHandle
    offer: string
    offerId: string
  } | null> | null
  offerAnswered: boolean
  offerRelays: unknown[]
  offerSignalRelays: Array<((signal: Signal) => void) | null>
  offerSignalBacklog: Signal[]
  offerRelayTimers: Array<ReturnType<typeof setTimeout> | null>
  offerExpiryTimer: ReturnType<typeof setTimeout> | null
  connectedPeer: PeerHandle | null
  connectedPeerUnhealthySinceMs: number | null
  answeringExpiryTimer: ReturnType<typeof setTimeout> | null
  answeringPeer: PeerHandle | null
  answerSent: boolean
  answerReplay: {
    offer: string
    offerId: string | undefined
    messages: string[]
    lastSentAt: Array<number | undefined>
    relays: Array<((message: string) => void) | undefined>
  } | null
  connectionErrorReported: boolean
}

export type SignalContext = {
  appId: string
  roomId: string
  config: BaseRoomConfig
  peerStates: Record<string, PeerState>
  rootTopicPlaintext: string
  rootTopicP: Promise<string>
  selfTopicP: Promise<string>
  toPlain: (signal: Signal) => Promise<Signal>
  toCipher: (signal: Signal) => Promise<Signal>
  isLeaving: () => boolean
  isPassive: boolean
  isActive: boolean
  onJoinError: JoinErrorHandler | undefined
  offerManager: OfferManager
  encryptOffer: (peer: PeerHandle) => Promise<string>
  initPeer: (initiator: boolean, config: BaseRoomConfig) => PeerHandle
  connectPeer: (peer: PeerHandle, peerId: string) => void
  disconnectPeer: (peer: PeerHandle, peerId: string) => void
  checkDeactivate: () => void
  announceIntervals: number[]
  announceIntervalMs: number
  requeueAnnounce?: () => void
  selfId?: string
  selfIdP?: Promise<string>
  onPeerDiscovered?: (
    peerId: string,
    relayId: number,
    signalPeer: SignalPeer
  ) => void
  shouldConnectPeer?: (
    peerId: string,
    direction: 'outbound' | 'inbound'
  ) => boolean
  dialPeer?: (peerId: string) => void
}
