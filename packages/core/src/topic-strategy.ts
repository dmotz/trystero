import type {
  BaseRoomConfig,
  JoinRoom,
  StrategyContext,
  StrategyMessage,
  TopicPublishContext,
  TopicStrategyAdapter,
  TopicSubscriptionContext
} from './internal-types'
import createStrategy from './strategy'
import type {JoinRoomConfig} from './types'
import {noOp} from './utils'

const defaultSteadyAnnounceIntervalMs = 60_000

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
  peerId: context.peerId
})

export default <TRelay, TConfig extends BaseRoomConfig = JoinRoomConfig>({
  defaultConfig,
  steadyAnnounceIntervalMs = defaultSteadyAnnounceIntervalMs,
  reannounceOnDisconnect = true,
  init,
  subscribeTopic,
  publishTopic
}: TopicStrategyAdapter<TRelay, TConfig>): JoinRoom<TConfig> =>
  createStrategy<TRelay, TConfig>({
    ...(defaultConfig === undefined ? {} : {defaultConfig}),
    init,

    subscribe: async (
      relay,
      rootTopic,
      selfTopic,
      onMessage,
      _getOffers,
      context
    ) => {
      let closed = false

      const signalPeer = (peerTopic: string, signal: string): void => {
        if (closed) {
          return
        }
        try {
          void Promise.resolve(
            publishTopic(
              relay,
              peerTopic,
              signal,
              makeTopicContext(context, 'signal', rootTopic, selfTopic)
            )
          ).catch(noOp)
        } catch {
          // Ignore synchronous publish failures during fire-and-forget signaling
        }
      }

      const forwardMessage = (topic: string, msg: StrategyMessage) => {
        if (!closed) {
          return onMessage(topic, msg, signalPeer)
        }
      }

      const selfCleanup = await subscribeTopic(
        relay,
        selfTopic,
        forwardMessage,
        makeTopicContext(context, 'self', rootTopic, selfTopic)
      )

      let rootCleanup: () => void
      try {
        rootCleanup = await subscribeTopic(
          relay,
          rootTopic,
          forwardMessage,
          makeTopicContext(context, 'root', rootTopic, selfTopic)
        )
      } catch (err) {
        closed = true
        selfCleanup()
        throw err
      }

      return () => {
        if (closed) {
          return
        }
        closed = true
        selfCleanup()
        rootCleanup()
      }
    },

    announce: async (relay, rootTopic, selfTopic, context) => {
      const result = await publishTopic(
        relay,
        rootTopic,
        {
          peerId: context.peerId
        },
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
