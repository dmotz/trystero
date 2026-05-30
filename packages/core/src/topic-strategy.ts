import createStrategy from './strategy'
import {fromJson, mkErr, selfId, toJson} from './utils'
import type {
  BaseRoomConfig,
  JoinRoom,
  JoinRoomConfig,
  StrategyContext,
  StrategyMessage,
  TopicPublishContext,
  TopicStrategyAdapter,
  TopicSubscriptionContext
} from './types'

const signalKeys = ['offer', 'answer', 'candidate'] as const

const toPayload = (msg: StrategyMessage): Record<string, unknown> | null => {
  if (typeof msg === 'string') {
    try {
      const parsed = fromJson<unknown>(msg)

      return parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : null
    } catch {
      return null
    }
  }

  return msg
}

const getString = (
  payload: Record<string, unknown>,
  key: string
): string | undefined =>
  typeof payload[key] === 'string' && payload[key] ? payload[key] : undefined

const hasInvalidSignalField = (payload: Record<string, unknown>): boolean =>
  signalKeys.some(
    key =>
      key in payload &&
      (typeof payload[key] !== 'string' || payload[key] === '')
  )

const shouldActivatePassiveRoom = (msg: StrategyMessage): boolean => {
  const payload = toPayload(msg)

  if (!payload || hasInvalidSignalField(payload)) {
    return false
  }

  const peerId = getString(payload, 'peerId')

  return Boolean(
    peerId &&
    peerId !== selfId &&
    payload['passive'] !== true &&
    !getString(payload, 'answer') &&
    !getString(payload, 'candidate')
  )
}

const requireContext = <TConfig extends BaseRoomConfig>(
  context?: StrategyContext<TConfig>
): StrategyContext<TConfig> => {
  if (!context) {
    throw mkErr('topic strategy missing room context')
  }

  return context
}

const subscriptionContext = <TConfig extends BaseRoomConfig>(
  context: StrategyContext<TConfig>,
  kind: TopicSubscriptionContext['kind'],
  rootTopic: string,
  selfTopic: string
): TopicSubscriptionContext => ({
  kind,
  appId: context.appId,
  roomId: context.roomId,
  rootTopic,
  selfTopic
})

const publishContext = <TConfig extends BaseRoomConfig>(
  context: StrategyContext<TConfig>,
  kind: TopicPublishContext['kind'],
  rootTopic: string,
  selfTopic: string
): TopicPublishContext => ({
  kind,
  appId: context.appId,
  roomId: context.roomId,
  rootTopic,
  selfTopic
})

export default <TRelay, TConfig extends BaseRoomConfig = JoinRoomConfig>({
  init,
  subscribeTopic,
  publishTopic,
  unpublishTopic,
  destroy
}: TopicStrategyAdapter<TRelay, TConfig>): JoinRoom<TConfig> =>
  createStrategy<TRelay, TConfig>({
    init,
    ...(destroy ? {destroy} : {}),

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
        publishTopic(
          relay,
          peerTopic,
          signal,
          publishContext(context, 'signal', rootTopic, selfTopic)
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
              subscriptionContext(context, 'self', rootTopic, selfTopic)
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
        subscriptionContext(context, 'root', rootTopic, selfTopic)
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

    announce: (relay, rootTopic, selfTopic, extraPayload, rawContext) => {
      const context = requireContext(rawContext)

      return publishTopic(
        relay,
        rootTopic,
        toJson({peerId: selfId, ...extraPayload}),
        publishContext(context, 'announce', rootTopic, selfTopic)
      )
    },

    ...(unpublishTopic
      ? {
          deactivate: (relay, rootTopic, selfTopic, rawContext) => {
            const context = requireContext(rawContext)

            return unpublishTopic(
              relay,
              rootTopic,
              publishContext(context, 'announce', rootTopic, selfTopic)
            )
          }
        }
      : {})
  })
