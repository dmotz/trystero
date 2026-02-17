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

export type TurnServerConfig = {
  urls: string | string[]
  username?: string
  credential?: string
  credentialType?: string
}

export type BaseRoomConfig = {
  appId: string
  password?: string
  rtcConfig?: RTCConfiguration
  rtcPolyfill?: typeof RTCPeerConnection
  turnConfig?: TurnServerConfig[]
  manualRelayReconnection?: boolean
}

export type RelayConfig = {
  relayUrls?: string[]
  relayRedundancy?: number
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

export type Signal = {
  type: RTCSdpType
  sdp: string
}

export type PeerHandlers = {
  data?: (data: ArrayBuffer) => void
  connect?: () => void
  close?: () => void
  stream?: (stream: MediaStream) => void
  track?: (track: MediaStreamTrack, stream: MediaStream) => void
  signal?: (signal: Signal) => void
  error?: (err: unknown) => void
}

export type PeerHandle = {
  created: number
  connection: RTCPeerConnection
  channel: RTCDataChannel | null
  isDead: boolean
  signal: (sdp: Signal) => Promise<Signal | void>
  sendData: (data: Uint8Array) => void
  destroy: () => void
  setHandlers: (newHandlers: PeerHandlers) => void
  offerPromise: Promise<Signal | void>
  addStream: (stream: MediaStream) => void
  removeStream: (stream: MediaStream) => void
  addTrack: (track: MediaStreamTrack, stream: MediaStream) => RTCRtpSender
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
  onJoinError?: JoinErrorHandler
) => Room

export type SocketClient = {
  socket: WebSocket
  url: string
  ready: Promise<SocketClient>
  send: (data: string) => void
}
