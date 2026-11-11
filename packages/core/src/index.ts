export {roles} from './authority'
export {hashTopic} from './crypto'
export {
  clearUserIdentity,
  createUserIdentity,
  exportUserIdentity,
  importUserIdentity
} from './identity'
export {
  encodeBytes,
  fromJson,
  libName,
  mkErr,
  socketInitialFailureSymbol,
  toJson
} from './primitives'
export {
  createRelayManager,
  createRelayScopedStore,
  getRelays,
  makeSocket,
  setRelayConnectivity,
  type RelayScopedStore
} from './relay-manager'
export {scale} from './scale'
export {default as createStrategy} from './strategy'
export {default as createTopicStrategy} from './topic-strategy'
export {genId, unrefTimer} from './utils'

export type {
  AnnounceResult,
  BaseRelayConfig,
  BaseRoomConfig,
  CandidateSignal,
  InferPluginApi,
  JoinRoom,
  MaybePromise,
  OfferRecord,
  PeerHandle,
  PeerHandlers,
  ResolvedIdentityPersistence,
  SessionSignal,
  Signal,
  SignalPeer,
  SocketClient,
  StrategyAdapter,
  StrategyContext,
  StrategyMessage,
  StrategyOnMessage,
  Timeout,
  TopicPublishContext,
  TopicStrategyAdapter,
  TopicSubscriptionContext,
  UserIdentityPersistence
} from './internal-types'

export type * from './types'
