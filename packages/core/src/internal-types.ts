import type {EndpointIdentity} from './identity'
import type {PeerDataTransport} from './peer-transport'
import type {
  ActionProgressHandler,
  BaseRoomConfig,
  DataPayload,
  JoinRoomConfig,
  JsonValue,
  ListenerOptions,
  MaybePromise,
  PeerHandle,
  PeerTarget,
  ReplayListenerOptions,
  RoleCertificate,
  Room,
  RoomError,
  SelfInfo,
  SendOptions,
  Signal,
  TopologyRoute,
  TopologySnapshot,
  Unsubscribe,
  UserIdentity
} from './types'

export type {PeerDataTransport}

export type TargetPeers = PeerTarget | undefined

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never

export type KernelRoomErrorInput = DistributiveOmit<
  RoomError,
  'appId' | 'roomId'
>

export type ActionOptions = {
  sendToPending?: boolean
  receiveWhilePending?: boolean
  maxPayloadBytes?: number
}

export type InternalMessageContext = {
  peerId: string
  userId: string
  metadata?: JsonValue
}

export type InternalReceiveContext = {
  peerId: string
  userId: string
  byteLength: number
  metadata?: JsonValue
  signal: AbortSignal
}

export type InternalAction<T extends DataPayload = DataPayload> = {
  send: (data: T, options?: SendOptions) => Promise<void>
  readonly onMessage: (
    handler: (data: T, context: InternalMessageContext) => unknown,
    options?: ListenerOptions
  ) => Unsubscribe
  readonly onReceiveProgress: (
    handler: ActionProgressHandler,
    options?: ListenerOptions
  ) => Unsubscribe
  readonly onReceive: (
    handler: (context: InternalReceiveContext) => boolean | Promise<boolean>,
    options?: ListenerOptions
  ) => Unsubscribe
}

export type RoleRevocationRecord = {
  v: 1
  appId: string
  roomId: string
  issuerUserId: string
  targetUserId: string
  role?: string
  seq: number
  ts: number
  signerPubKey: JsonWebKey
  sig: string
}

export type PeerModerationRecord = {
  v: 1
  op: 'ban' | 'unban'
  appId: string
  roomId: string
  issuerUserId: string
  targetUserId: string
  reason?: string
  seq: number
  ts: number
  signerPubKey: JsonWebKey
  sig: string
}

type AuthoritativeStateRecordBase = {
  v: 1
  appId: string
  roomId: string
  ns: string
  hlc: number
  peerId: string
  userId: string
  pub: string
  cert?: RoleCertificate
  sig: string
}

type AuthoritativeStateValueRecord<T = JsonValue> =
  AuthoritativeStateRecordBase & {
    k: 's' | 'u'
    val: T
    del?: false
  }

type AuthoritativeStateTombstoneRecord = AuthoritativeStateRecordBase & {
  k: 'u'
  val?: never
  del: true
}

export type AuthoritativeStateRecord<T = JsonValue> =
  | AuthoritativeStateValueRecord<T>
  | AuthoritativeStateTombstoneRecord

export type KernelRolesProvider = {
  getEffectiveRoomId: () => string
  getPeerRoles: (peerOrUserId?: string) => string[]
  isPeerBanned: (peerOrUserId: string) => boolean
  getBanReason: (peerOrUserId: string) => string | undefined
  getLocalActionCert: (
    requiredRoles: readonly string[],
    namespace?: string
  ) => Promise<RoleCertificate | null>
  authorizePeerAction: (
    peerId: string,
    requiredRoles: readonly string[],
    inlineCert?: RoleCertificate
  ) => boolean | Promise<boolean>
  getStateWriteCert: (
    requiredRoles: readonly string[] | null,
    namespace: string
  ) => Promise<{cert: RoleCertificate | null; roles: string[]}>
  verifyStateRecordRoles: (
    rec: AuthoritativeStateRecord,
    requiredRoles: readonly string[] | null,
    fromPeerId?: string
  ) => Promise<{valid: boolean; roles: string[]}>
  onPeerDescriptorCert: (
    peerId: string,
    userId: string,
    cert?: RoleCertificate
  ) => void
  getAuthorityInfo: () => Promise<
    Omit<SelfInfo, 'peerId' | 'identityPersistence'>
  >
}

export type KernelScaleProvider = {
  isDirectPeer: (peerId: string) => boolean
  isVirtualPeer: (peerId: string) => boolean
  getRoute: (peerId: string) => TopologyRoute | undefined
  getSnapshot: () => TopologySnapshot
  handleFrame: (fromPeerId: string, data: ArrayBuffer) => boolean
  addDirectPeer: (peerId: string, peer: PeerHandle) => void
  removeDirectPeer: (peerId: string, peer?: PeerHandle, reason?: Error) => void
  prepareMediaPeer: (peerId: string) => Promise<PeerHandle>
  setPeerMediaPinned: (peerId: string, pinned: boolean) => void
  broadcastInline: (
    frame: Uint8Array,
    onProgress?: (peerId: string) => void,
    signal?: AbortSignal
  ) => boolean | Promise<boolean>
  requireDirectPeer: (peerId: string) => void
  notePeerDiscovered: (peerId: string) => boolean
  shouldConnectPeer: (
    peerId: string,
    direction: 'outbound' | 'inbound'
  ) => boolean
  getTargetNeighbors: () => Set<string>
  setOnTargetsChanged: (cb: (targetPeerIds: string[]) => void) => void
  announceLeave: () => void
  destroy: () => void
  setPeerSignPublicKey: (peerId: string, pubKey: JsonWebKey) => void
  setLocalRoleCertificate: (cert: RoleCertificate | null) => void
  markPeerBanned: (peerId: string) => void
  unmarkPeerBanned: (peerId: string) => void
  isPeerBanned: (peerId: string) => boolean
  registerActionAuthority: (actionType: string, roles: string[]) => void
}

export type InternalRoomContext = {
  readonly selfId: string
  readonly appId: string
  readonly initialRoomId: string
  readonly password: string
  readonly maxUsers?: number | undefined
  readonly effectiveRoomIdP?: Promise<string> | undefined
  getRoomId: () => string
  setEffectiveRoomId: (roomId: string) => void
  getLocalEndpointIdentity: () => Promise<EndpointIdentity>
  getLocalUserIdentity: () => Promise<UserIdentity>
  getPeerUserId: (peerId: string) => string
  getKnownPeerUserId: (peerId: string) => string | undefined
  getUserPeerIds: (userId: string) => string[]
  getPeerPublicKey: (peerId: string) => JsonWebKey | undefined
  setPeerUserId: (peerId: string, userId: string) => void
  setPeerPublicKey: (peerId: string, pubKey: JsonWebKey) => void
  getActivePeerIds: () => string[]
  getDirectActivePeerIds: () => string[]
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
  deliverRawData: (originPeerId: string, data: ArrayBuffer) => void
  registerRolesProvider: (provider: KernelRolesProvider) => void
  registerScaleProvider: (provider: KernelScaleProvider) => void
  getRolesProvider: () => KernelRolesProvider | null
  getScaleProvider: () => KernelScaleProvider | null
  activateVirtualPeer: (peerId: string, transport: PeerDataTransport) => boolean
  deactivateVirtualPeer: (peerId: string, reason?: Error) => void
  purgeBannedUserState: (userId: string) => void
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

export type SignalPeer = (peerTopic: string, signal: string) => unknown

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
  peerId: string
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
  offerId: string
  claim?: () => void
  reclaim?: () => void
}

export type AnnounceResult =
  | number
  | {stopAnnouncing: true}
  | {nextAnnounceMs: number; reannounceOnDisconnect?: boolean}

export type StrategyAdapter<
  TRelay,
  TConfig extends BaseRoomConfig = JoinRoomConfig
> = {
  defaultConfig?: Partial<TConfig>
  init: (config: TConfig) => MaybePromise<TRelay> | Array<MaybePromise<TRelay>>
  subscribe: (
    relay: TRelay,
    rootTopic: string,
    selfTopic: string,
    onMessage: StrategyOnMessage,
    getOffers: (n: number) => Promise<OfferRecord[]>,
    context: StrategyContext<TConfig>
  ) => MaybePromise<() => void>
  announce: (
    relay: TRelay,
    rootTopic: string,
    selfTopic: string,
    context: StrategyContext<TConfig>
  ) => MaybePromise<AnnounceResult | void>
}

export type TopicStrategyAdapter<
  TRelay,
  TConfig extends BaseRoomConfig = JoinRoomConfig
> = {
  defaultConfig?: Partial<TConfig>
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
}

export type SocketClient = {
  socket: WebSocket
  url: string
  ready: Promise<SocketClient>
  isClosed?: boolean
  close?: () => void
  send: (data: string) => void
}

export type MediaIdentityCache = {
  getStreamKey: (stream: MediaStream) => string
  rememberRemoteStream: (
    key: string,
    stream: MediaStream,
    streamId?: string
  ) => void
  getRemoteStream: (key: string, streamId?: string) => MediaStream | undefined
  hasRemoteMedia: () => boolean
  clearRemote: () => void
}

export type AnswerReplayState = {
  offer: string
  offerId: string
  messages: string[]
  lastSentAt: Array<number | undefined>
  relays: Array<((message: string) => void) | undefined>
}

export type PeerState = {
  offerPeer: PeerHandle | null
  offerId: string | null
  offerInitPromise: Promise<
    [peer: PeerHandle, offer: string, offerId: string] | null
  > | null
  offerRelays: unknown[]
  connectedPeer: PeerHandle | null
  answeringPeer: PeerHandle | null
  offerSdp: string | null
  offerAnswered: boolean
  offerCandidateSenders: Array<((signal: Signal) => void) | null>
  bufferedOfferCandidates: Signal[]
  offerRetryTimers: Array<ReturnType<typeof setTimeout> | null>
  offerExpiryTimer: ReturnType<typeof setTimeout> | null
  unhealthySince: number | null
  answeringExpiryTimer: ReturnType<typeof setTimeout> | null
  didSendAnswer: boolean
  answerReplay: AnswerReplayState | null
  didReportConnectFailure: boolean
}

export type OfferCheckoutFn = (
  n: number,
  lease: boolean,
  encryptOffer: (peer: PeerHandle, offerId: string) => Promise<string>,
  offerIdSize?: number
) => Promise<OfferRecord[]>

export type SignalContext = {
  appId: string
  getRoomId: () => string
  config: BaseRoomConfig
  peerStates: Record<string, PeerState>
  getRootTopicPlaintext: () => string
  rootTopicP: Promise<string>
  selfTopicP: Promise<string>
  toPlain: (signal: Signal, peerId: string, offerId: string) => Promise<Signal>
  toCipher: (signal: Signal, peerId: string, offerId: string) => Promise<Signal>
  isLeaving: () => boolean
  onError: ((error: RoomError) => void) | undefined
  checkoutOffers: OfferCheckoutFn
  claimLeasedOffer: (peer: PeerHandle) => void
  reclaimLeasedOffer: (peer: PeerHandle) => void
  encryptOffer: (
    peer: PeerHandle,
    peerId: string,
    offerId: string
  ) => Promise<string>
  initPeer: (initiator: boolean, config: BaseRoomConfig) => PeerHandle
  connectPeer: (peer: PeerHandle, peerId: string) => void
  disconnectPeer: (peer: PeerHandle, peerId: string) => void
  announceIntervals: number[]
  announceIntervalMs: number
  getSelfIdNow: () => string | undefined
  selfIdP: Promise<string>
  onPeerDiscovered?: (
    peerId: string,
    relayId: number,
    signalPeer: SignalPeer
  ) => void
  shouldConnectPeer?: (
    peerId: string,
    direction: 'outbound' | 'inbound'
  ) => boolean
}
