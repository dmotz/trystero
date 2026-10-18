import type {OfferManager} from './offer-manager'

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
  onPeerHandshake?: PeerHandshake
  handshakeTimeoutMs?: number
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

export type TopologyMode = 'mesh' | 'auto' | 'small-world' | 'tree'

export type TopologyConfig = {
  mode?: TopologyMode
  maxPeers?: number
  minPeers?: number
  autoThreshold?: number
  fanout?: number
  redundancy?: number
  maxHops?: number
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
  lazyRepairsSent: number
  lazyRepairsResolved: number
  treeReparents: number
}

export type TopologySnapshot = {
  mode: TopologyMode
  activeMode: 'mesh' | 'small-world' | 'tree'
  selfId: string
  directPeerIds: string[]
  roomPeerIds: string[]
  routes: Record<string, TopologyRoute>
  mediaTrees: Record<string, TopologyMediaTree>
  stats: TopologyStats
}

export type AdminIdentity = {
  publicKey: string
  fingerprint: string
  adminKey: string
  signPrivateKey: CryptoKey
  signPublicKey: CryptoKey
  signPubJwk: JsonWebKey
}

export type AuthorityConfig = {
  rootPubKeys?: string[]
  credentials?: string | AdminIdentity
  create?: boolean
  signalingProofs?: boolean
}

export type RoleCertificate = {
  v: 1
  certId: string
  issuerPubKey: string
  subPeerId: string
  subPubKey: JsonWebKey
  appId: string
  roomId: string
  roles: string[]
  canDelegate?: boolean
  isRoot?: boolean
  iat: number
  exp?: number
  parentCert?: RoleCertificate
  sig: string
}

export type RoleRevocationRecord = {
  v: 1
  appId: string
  roomId: string
  issuerPeerId: string
  targetPeerId: string
  role?: string
  seq: number
  ts: number
  issuerCert: RoleCertificate
  sig: string
}

export type PeerBanRecord = {
  v: 1
  appId: string
  roomId: string
  issuerPeerId: string
  targetPeerId: string
  targetKeyThumbprint?: string
  reason?: string
  seq: number
  ts: number
  issuerCert: RoleCertificate
  sig: string
}

export type AuthoritativeStateRecord<T extends JsonValue = JsonValue> = {
  v: 1
  appId: string
  roomId: string
  namespace: string
  epoch: number
  seq: number
  prevHash: string
  ts: number
  updatedBy: string
  signerPubKey: JsonWebKey
  cert: RoleCertificate
  value: T
  sig: string
  hash: string
}

export type RoomAuthorityInfo = {
  roomId: string
  baseRoomId: string
  fingerprint: string | null
  isAdmin: boolean
  roles: string[]
  publicKey: string | null
  adminKey: string | null
}

export type StateChangeContext = {
  updatedBy: string
  roles: string[]
  seq: number
  epoch: number
  timestamp: number
  hash: string
}

export type StateConfig<T extends JsonValue = JsonValue> = {
  authority?: string | string[]
  validate?: (next: T, prev: T, context: StateChangeContext) => boolean
}

export type AuthoritativeState<T extends JsonValue = JsonValue> = {
  get: () => T
  set: (next: T | ((prev: T) => T)) => Promise<void>
  getMeta: () => StateChangeContext | null
  onChange: ((value: T, prev: T, context: StateChangeContext) => void) | null
}

export type BaseRoomConfig = {
  appId: string
  peerId?: string
  topology?: TopologyMode | TopologyConfig
  admin?: boolean | string | AuthorityConfig
  maxReceiveBytes?: number
  password?: string
  passive?: boolean
  relayConfig?: BaseRelayConfig
  trickleIce?: boolean
  rtcConfig?: RTCConfiguration
  rtcPolyfill?: typeof RTCPeerConnection
  turnConfig?: TurnServerConfig[]
  _test_only_mdnsHostFallbackToLoopback?: boolean
  _test_only_sharedPeerIdleMs?: number
}

export type JoinRoomConfig = BaseRoomConfig & {
  relayConfig?: RelayConfig
}

export type ProgressHandler = (
  percent: number,
  peerId: string,
  metadata?: JsonValue
) => void

export type ActionProgressContext = {
  peerId: string
  metadata?: JsonValue
}

export type ActionProgressHandler = (
  progress: number,
  context: ActionProgressContext
) => void

export type ActionReceiveContext = {
  peerId: string
  byteLength: number
  kind: 'message' | 'request' | 'response'
  signal: AbortSignal
  metadata?: JsonValue
}

export type ActionReceiveHandler = (
  context: ActionReceiveContext
) => boolean | Promise<boolean>

export type MessageContext = {
  peerId: string
  metadata?: JsonValue
  roles?: string[]
}

export type RequestContext = {
  peerId: string
  metadata?: JsonValue
  signal: AbortSignal
  roles?: string[]
}

export type PeerResult<R extends DataPayload = DataPayload> =
  | {peerId: string; status: 'fulfilled'; value: R}
  | {peerId: string; status: 'timeout'}
  | {peerId: string; status: 'rejected'; error: Error}
  | {peerId: string; status: 'disconnected'}

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
  authority?: string | string[]
  onMessage?: (data: T, context: MessageContext) => void | Promise<void>
  onReceiveProgress?: ActionProgressHandler
  onReceive?: ActionReceiveHandler
}

export type RequestActionConfig<
  T extends DataPayload = DataPayload,
  R extends DataPayload = DataPayload
> = {
  kind: 'request'
  authority?: string | string[]
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

export type Room = {
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
  makeState: <T extends JsonValue = JsonValue>(
    namespace: string,
    initialValue: T,
    config?: StateConfig<T>
  ) => AuthoritativeState<T>
  getAuthority: () => Promise<RoomAuthorityInfo>
  grantRole: (
    peerId: string,
    role: string | string[],
    options?: {canDelegate?: boolean; expiresInMs?: number}
  ) => Promise<RoleCertificate>
  revokeRole: (peerId: string, role?: string) => Promise<void>
  getPeerRoles: (peerId?: string) => string[]
  banPeer: (peerId: string, options?: {reason?: string}) => Promise<void>
  isBanned: (peerId: string) => boolean
  ping: (id: string) => Promise<number>
  leave: () => Promise<void>
  isPassive: () => boolean
  getPeers: () => Record<string, RTCPeerConnection>
  getTopology: () => TopologySnapshot
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
  onPeerJoin: ((peerId: string) => void) | null
  onPeerLeave: ((peerId: string) => void) | null
  onPeerStream:
    | ((stream: MediaStream, peerId: string, metadata?: JsonValue) => void)
    | null
  onPeerTrack:
    | ((
        track: MediaStreamTrack,
        stream: MediaStream,
        peerId: string,
        metadata?: JsonValue
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
}

export type TopicPublishContext = {
  kind: 'announce' | 'signal'
  appId: string
  roomId: string
  rootTopic: string
  selfTopic: string
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

export type JoinRoom<TConfig extends BaseRoomConfig = JoinRoomConfig> = (
  config: TConfig,
  roomId: string,
  callbacks?: JoinRoomCallbacks
) => Room

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

export type SharedMediaPeer = PeerHandle & {
  __trysteroMedia?: MediaIdentityCache
}

export type SharedPeerBinding = {
  roomId: string
  roomToken: string | null
  roomTokenPromise: Promise<string>
  handlers: PeerHandlers
  pendingData: ArrayBuffer[]
  pendingSendData: Uint8Array[]
  pendingTracks: Array<{track: MediaStreamTrack; stream: MediaStream}>
  detach: () => void
  proxy: PeerHandle
}

export type SharedPeerState = {
  appId: string
  peerId: string
  peer: PeerHandle
  bindings: Record<string, SharedPeerBinding>
  bindingsByToken: Record<string, SharedPeerBinding>
  pendingDataByToken: Map<string, ArrayBuffer[]>
  remoteRoomTokens: Set<string>
  idleTimer: ReturnType<typeof setTimeout> | null
  controlRoomId: string | null
  streamOwners: Map<MediaStream, Set<string>>
  trackOwners: Map<MediaStreamTrack, {stream: MediaStream; rooms: Set<string>}>
  media: MediaIdentityCache
  idleMs: number
  isClosing: boolean
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
  reusePeer: (peerId: string) => boolean
  checkDeactivate: () => void
  announceIntervals: number[]
  announceIntervalMs: number
  requeueAnnounce?: () => void
  selfId?: string
  onPeerDiscovered?: (
    peerId: string,
    relayId: number,
    signalPeer: SignalPeer,
    payload?: Record<string, unknown>
  ) => Promise<void> | void
  shouldConnectPeer?: (
    peerId: string,
    direction: 'outbound' | 'inbound'
  ) => boolean
  dialPeer?: (peerId: string) => void
}
