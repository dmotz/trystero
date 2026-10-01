import {shouldActivatePassiveRoom} from './signal-handler'
import createStrategy from './strategy'
import {mkErr, selfId, toJson} from './utils'
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

const requireContext = <TConfig extends BaseRoomConfig>(
  context?: StrategyContext<TConfig>
): StrategyContext<TConfig> => {
  if (!context) {
    throw mkErr('topic strategy missing room context')
  }

  return context
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
} => ({
  kind,
  appId: context.appId,
  roomId: context.roomId,
  rootTopic,
  selfTopic
})

export default <TRelay, TConfig extends BaseRoomConfig = JoinRoomConfig>({
  steadyAnnounceIntervalMs = defaultSteadyAnnounceIntervalMs,
  reannounceOnDisconnect = true,
  init,
  subscribeTopic,
  publishTopic,
  unpublishTopic
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

      let selfCleanup: (() => void) | null = null
      let selfCleanupDone = false
      let selfSubscriptionP: Promise<void> | null = null
      let didCleanup = false

      const cleanupSelf = (cleanup: () => void): void => {
        if (selfCleanupDone) {
          return
        }

        selfCleanupDone = true
        cleanup()
      }

      const ensureSelfSubscription = (): Promise<void> => {
        if (!selfSubscriptionP) {
          selfSubscriptionP = Promise.resolve(
            subscribeTopic(
              relay,
              selfTopic,
              (topic, msg) => {
                if (!didCleanup) {
                  void onMessage(topic, msg, signalPeer)
                }
              },
              makeTopicContext(context, 'self', rootTopic, selfTopic)
            )
          ).then(cleanup => {
            selfCleanup = cleanup

            if (didCleanup) {
              cleanupSelf(cleanup)
            }
          })
        }

        return selfSubscriptionP
      }

      if (!context.isPassive) {
        await ensureSelfSubscription()
      }

      const rootCleanup = await subscribeTopic(
        relay,
        rootTopic,
        async (topic, msg) => {
          if (didCleanup) {
            return
          }

          if (context.isPassive && shouldActivatePassiveRoom(msg)) {
            await ensureSelfSubscription()
          }

          if (!didCleanup) {
            await onMessage(topic, msg, signalPeer)
          }
        },
        makeTopicContext(context, 'root', rootTopic, selfTopic)
      )

      return () => {
        didCleanup = true

        if (selfCleanup) {
          cleanupSelf(selfCleanup)
        } else {
          void selfSubscriptionP
        }

        rootCleanup()
      }
    },

    announce: async (relay, rootTopic, selfTopic, extraPayload, rawContext) => {
      const context = requireContext(rawContext)
      const result = await publishTopic(
        relay,
        rootTopic,
        toJson({peerId: selfId, ...extraPayload}),
        makeTopicContext(context, 'announce', rootTopic, selfTopic)
      )

      return typeof result === 'number' ||
        (result !== undefined && 'stopAnnouncing' in result)
        ? result
        : {
            nextAnnounceMs: result?.nextAnnounceMs ?? steadyAnnounceIntervalMs,
            reannounceOnDisconnect:
              result?.reannounceOnDisconnect ?? reannounceOnDisconnect
          }
    },

    ...(unpublishTopic
      ? {
          deactivate: (relay, rootTopic, selfTopic, rawContext) => {
            const context = requireContext(rawContext)

            return unpublishTopic(
              relay,
              rootTopic,
              makeTopicContext(context, 'announce', rootTopic, selfTopic)
            )
          }
        }
      : {})
  })
