import createStrategy from './strategy'
import {mkErr, toJson} from './utils'
import type {
  BaseRoomConfig,
  JoinRoom,
  JoinRoomConfig,
  StrategyContext,
  TopicPublishContext,
  TopicStrategyAdapter,
  TopicSubscriptionContext
} from './types'

const defaultSteadyAnnounceIntervalMs = 60_000
const topicMissingErr = (what: string): Error =>
  mkErr(`topic strategy missing ${what}`)

const requireContext = <TConfig extends BaseRoomConfig>(
  context?: StrategyContext<TConfig>
): StrategyContext<TConfig> => {
  if (!context) {
    throw topicMissingErr('room context')
  }

  return context
}

const requirePeerId = <TConfig extends BaseRoomConfig>(
  context: StrategyContext<TConfig>
): string => {
  if (!context.peerId) {
    throw topicMissingErr('resolved peerId')
  }

  return context.peerId
}

const makeTopicContext = <
  TConfig extends BaseRoomConfig,
  TKind extends TopicSubscriptionContext['kind'] | TopicPublishContext['kind']
>(
  context: StrategyContext<TConfig>,
  kind: TKind,
  rootTopic: string,
  selfTopic: string
): {
  kind: TKind
  appId: string
  roomId: string
  rootTopic: string
  selfTopic: string
  peerId: string
} => ({
  kind,
  appId: context.appId,
  roomId: context.roomId,
  rootTopic,
  selfTopic,
  peerId: requirePeerId(context)
})

export default <TRelay, TConfig extends BaseRoomConfig = JoinRoomConfig>({
  steadyAnnounceIntervalMs = defaultSteadyAnnounceIntervalMs,
  reannounceOnDisconnect = true,
  init,
  subscribeTopic,
  publishTopic
}: TopicStrategyAdapter<TRelay, TConfig>): JoinRoom<TConfig> =>
  createStrategy<TRelay, TConfig>({
    init,

    subscribe: async (
      relay,
      rootTopic,
      selfTopic,
      onMessage,
      _getOffers,
      rawContext
    ) => {
      const context = requireContext(rawContext)
      const signalPeer = (peerTopic: string, signal: string) =>
        void publishTopic(
          relay,
          peerTopic,
          signal,
          makeTopicContext(context, 'signal', rootTopic, selfTopic)
        )

      let didCleanup = false
      const forwardMessage = (
        topic: string,
        msg: Parameters<typeof onMessage>[1]
      ) => {
        if (!didCleanup) {
          return onMessage(topic, msg, signalPeer)
        }
      }

      const selfCleanup = await subscribeTopic(
        relay,
        selfTopic,
        forwardMessage,
        makeTopicContext(context, 'self', rootTopic, selfTopic)
      )

      const rootCleanup = await subscribeTopic(
        relay,
        rootTopic,
        forwardMessage,
        makeTopicContext(context, 'root', rootTopic, selfTopic)
      )

      return () => {
        didCleanup = true
        selfCleanup()
        rootCleanup()
      }
    },

    announce: async (relay, rootTopic, selfTopic, rawContext) => {
      const context = requireContext(rawContext)
      const result = await publishTopic(
        relay,
        rootTopic,
        toJson({
          peerId: requirePeerId(context)
        }),
        makeTopicContext(context, 'announce', rootTopic, selfTopic)
      )

      if (typeof result === 'number') {
        return result
      }

      if (typeof result === 'object' && result !== null) {
        if ('stopAnnouncing' in result) {
          return result
        }

        return {
          nextAnnounceMs: result.nextAnnounceMs ?? steadyAnnounceIntervalMs,
          reannounceOnDisconnect:
            result.reannounceOnDisconnect ?? reannounceOnDisconnect
        }
      }

      return {
        nextAnnounceMs: steadyAnnounceIntervalMs,
        reannounceOnDisconnect
      }
    }
  })
