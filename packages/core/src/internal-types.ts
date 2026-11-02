import type {ActionOptions, InternalAction} from './action-wire'
import type {OfferManager} from './offer-manager'
import type {PeerDataTransport} from './peer-registry'
import type {
  BaseRoomConfig,
  DataPayload,
  JoinRoomConfig,
  JsonValue,
  MaybePromise,
  PeerHandle,
  PluginContext,
  PublicRolesProvider,
  PublicScaleProvider,
  RoleCertificate,
  RoomError,
  SelfInfo,
  Signal
} from './types'

export type {ActionOptions, InternalAction, PeerDataTransport}

export type RoleRevocationRecord = {
  v: 1
  appId: string
  roomId: string
  issuerUserId: string
  targetUserId: string
  targetCertId?: string
  role?: string
  seq: number
  ts: number
  issuerCert: RoleCertificate
  signerPubKey: JsonWebKey
  sig: string
}

export type PeerBanRecord = {
  v: 1
  appId: string
  roomId: string
  issuerUserId: string
  targetUserId: string
  reason?: string
  seq: number
  ts: number
  issuerCert: RoleCertificate
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

export type AuthoritativeStateValueRecord<T = JsonValue> =
  AuthoritativeStateRecordBase & {
    k: 's' | 'u'
    val: T
    del?: false
  }

export type AuthoritativeStateTombstoneRecord = AuthoritativeStateRecordBase & {
  k: 'u'
  val?: never
  del: true
}

export type AuthoritativeStateRecord<T = JsonValue> =
  | AuthoritativeStateValueRecord<T>
  | AuthoritativeStateTombstoneRecord

export type KernelRolesProvider = PublicRolesProvider & {
  registerPeerPublicKey: (peerId: string, pubKey: JsonWebKey) => void
  getStateWriteCert?: (
    requiredRoles: readonly string[] | null,
    namespace: string
  ) => Promise<{cert: RoleCertificate | null; roles: string[]}>
  verifyStateRecordRoles?: (
    rec: AuthoritativeStateRecord,
    requiredRoles: readonly string[] | null,
    fromPeerId?: string
  ) => Promise<{valid: boolean; roles: string[]}>
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
  getAuthorityInfo: () => Promise<
    Omit<SelfInfo, 'peerId' | 'persisted' | 'identityPersistence'>
  >
}

export type KernelScaleProvider = PublicScaleProvider & {
  handleFrame: (fromPeerId: string, data: ArrayBuffer) => boolean
  addDirectPeer: (peerId: string, peer: PeerHandle) => void
  removeDirectPeer: (peerId: string, peer?: PeerHandle, reason?: Error) => void
  prepareMediaPeer?: (peerId: string) => Promise<PeerHandle>
  broadcastInline: (
    frame: Uint8Array,
    onProgress?: (peerId: string) => void
  ) => Promise<boolean>
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
  isPeerBanned: (peerId: string) => boolean
  registerActionAuthority: (actionType: string, roles: string[]) => void
  recordSignatureFailure: () => void
}

export type InternalRoomContext = Omit<
  PluginContext,
  'getRolesProvider' | 'getScaleProvider'
> & {
  readonly effectiveRoomIdP?: Promise<string> | undefined
  setEffectiveRoomId: (roomId: string) => void
  setPeerUserId: (peerId: string, userId: string) => void
  setPeerPublicKey: (peerId: string, pubKey: JsonWebKey) => void
  getDirectActivePeerIds: () => string[]
  deliverRawData: (originPeerId: string, data: ArrayBuffer) => void
  registerRolesProvider: (provider: KernelRolesProvider) => void
  registerScaleProvider: (provider: KernelScaleProvider) => void
  getRolesProvider: () => KernelRolesProvider | null
  getScaleProvider: () => KernelScaleProvider | null
  activateVirtualPeer: (peerId: string, transport: PeerDataTransport) => boolean
  deactivateVirtualPeer: (peerId: string, reason?: Error) => void
  purgeBannedUserState: (userId: string) => void
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
    context?: StrategyContext<TConfig>
  ) => MaybePromise<() => void>
  announce: (
    relay: TRelay,
    rootTopic: string,
    selfTopic: string,
    context?: StrategyContext<TConfig>
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

export type PeerState = {
  offerPeer: PeerHandle | null
  offerId: string | null
  offerInitPromise: Promise<
    [peer: PeerHandle, offer: string, offerId: string] | null
  > | null
  offerRelays: unknown[]
  connectedPeer: PeerHandle | null
  answeringPeer: PeerHandle | null
  s: string | null
  o: boolean
  r: Array<((signal: Signal) => void) | null>
  b: Signal[]
  t: Array<ReturnType<typeof setTimeout> | null>
  e: ReturnType<typeof setTimeout> | null
  u: number | null
  x: ReturnType<typeof setTimeout> | null
  d: boolean
  a:
    | [
        offer: string,
        offerId: string | undefined,
        messages: string[],
        lastSentAt: Array<number | undefined>,
        relays: Array<((message: string) => void) | undefined>
      ]
    | null
  f: boolean
}

export type SignalContext = {
  appId: string
  roomId: string
  config: BaseRoomConfig
  peerStates: Record<string, PeerState>
  rootTopicPlaintext: string
  rootTopicP: Promise<string>
  selfTopicP: Promise<string>
  toPlain: (signal: Signal, peerId: string, offerId: string) => Promise<Signal>
  toCipher: (signal: Signal, peerId: string, offerId: string) => Promise<Signal>
  isLeaving: () => boolean
  onError: ((error: RoomError) => void) | undefined
  offerManager: OfferManager
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
}
