import type {OfferPool} from './offer-pool'
import type {SharedPeerManager} from './shared-peer'

export type JsonPrimitive = null | string | number | boolean

export type JsonValue = JsonPrimitive | JsonValue[] | {[key: string]: JsonValue}

export type DataPayload = JsonValue | Blob | ArrayBuffer | ArrayBufferView

export type TargetPeers = string | string[] | null | undefined

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

export type BaseRoomConfig = {
  appId: string
  password?: string
  trickleIce?: boolean
  rtcConfig?: RTCConfiguration
  rtcPolyfill?: typeof RTCPeerConnection
  turnConfig?: TurnServerConfig[]
  _test_only_mdnsHostFallbackToLoopback?: boolean
  _test_only_sharedPeerIdleMs?: number
}

export type RelayConfig = {
  relayUrls?: string[]
  relayRedundancy?: number
  manualRelayReconnection?: boolean
}

export type JoinRoomConfig = BaseRoomConfig & RelayConfig

export type ProgressHandler = (
  percent: number,
  peerId: string,
  metadata?: JsonValue
) => void

export type ActionSender<T extends DataPayload = DataPayload> = (
  data: T,
  targetPeers?: TargetPeers,
  metadata?: JsonValue,
  progress?: ProgressHandler
) => Promise<void[]>

export type ActionReceiver<T extends DataPayload = DataPayload> = (
  receiver: (data: T, peerId: string, metadata?: JsonValue) => void
) => void

export type ActionProgress = (progressHandler: ProgressHandler) => void

export type Room = {
  makeAction: <T extends DataPayload = DataPayload>(
    namespace: string
  ) => [ActionSender<T>, ActionReceiver<T>, ActionProgress]
  ping: (id: string) => Promise<number>
  leave: () => Promise<void>
  getPeers: () => Record<string, RTCPeerConnection>
  addStream: (
    stream: MediaStream,
    targetPeers?: TargetPeers,
    metadata?: JsonValue
  ) => Promise<void>[]
  removeStream: (stream: MediaStream, targetPeers?: TargetPeers) => void
  addTrack: (
    track: MediaStreamTrack,
    stream: MediaStream,
    targetPeers?: TargetPeers,
    metadata?: JsonValue
  ) => Promise<void>[]
  removeTrack: (track: MediaStreamTrack, targetPeers?: TargetPeers) => void
  replaceTrack: (
    oldTrack: MediaStreamTrack,
    newTrack: MediaStreamTrack,
    targetPeers?: TargetPeers,
    metadata?: JsonValue
  ) => Promise<void>[]
  onPeerJoin: (fn: (peerId: string) => void) => void
  onPeerLeave: (fn: (peerId: string) => void) => void
  onPeerStream: (
    fn: (stream: MediaStream, peerId: string, metadata?: JsonValue) => void
  ) => void
  onPeerTrack: (
    fn: (
      track: MediaStreamTrack,
      stream: MediaStream,
      peerId: string,
      metadata?: JsonValue
    ) => void
  ) => void
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
  created: number
  connection: RTCPeerConnection
  channel: RTCDataChannel | null
  isDead: boolean
  getOffer: (restartIce?: boolean) => Promise<Signal | void>
  signal: (sdp: Signal) => Promise<Signal | void>
  sendData: (data: Uint8Array) => void
  destroy: () => void
  setHandlers: (newHandlers: PeerHandlers) => void
  offerPromise: Promise<Signal | void>
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

export type OfferRecord = {
  peer: PeerHandle
  offer: string
  claim?: () => void
  reclaim?: () => void
}

export type MaybePromise<T> = T | Promise<T>

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
    getOffers: (n: number) => Promise<OfferRecord[]>
  ) => MaybePromise<() => void>
  announce: (
    relay: TRelay,
    rootTopic: string,
    selfTopic: string
  ) => MaybePromise<number | void>
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
  send: (data: string) => void
}

export type RemoteTrackRef = {
  track: MediaStreamTrack
  stream: MediaStream
}

export type SharedMediaPeer = PeerHandle & {
  __trysteroGetRemoteStreamByKey?: (key: string) => MediaStream | undefined
  __trysteroSetRemoteStreamByKey?: (key: string, stream: MediaStream) => void
  __trysteroGetRemoteTrackByKey?: (key: string) => RemoteTrackRef | undefined
  __trysteroSetRemoteTrackByKey?: (
    key: string,
    track: MediaStreamTrack,
    stream: MediaStream
  ) => void
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
  remoteStreamsByKey: Map<string, MediaStream>
  remoteTracksByKey: Map<string, RemoteTrackRef>
  idleMs: number
  isClosing: boolean
}

export type PeerState = {
  status: 'idle' | 'offering' | 'answering' | 'connected'
  offerPeer: PeerHandle | null
  offerId: string | null
  offerSdp: string | null
  offerInitPromise: Promise<{
    peer: PeerHandle
    offer: string
    offerId: string
  }> | null
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
  pendingCandidates: Record<string, Signal[]>
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
  onJoinError: JoinErrorHandler | undefined
  sharedPeers: SharedPeerManager
  offerPool: OfferPool
  encryptOffer: (peer: PeerHandle) => Promise<string>
  initPeer: (initiator: boolean, config: BaseRoomConfig) => PeerHandle
  connectPeer: (peer: PeerHandle, peerId: string, relayId: number) => void
  disconnectPeer: (peer: PeerHandle, peerId: string) => void
  attachSharedPeerToRoom: (peerId: string, shared: SharedPeerState) => void
  announceIntervals: number[]
  announceIntervalMs: number
}
