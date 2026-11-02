import {hashTopic} from './crypto'
import type {SignalContext, SignalPeer} from './internal-types'
import {
  clearConnectedPeer,
  countPendingPeerConnections,
  counterAnnounceTimestamps,
  detachConnectedPeer,
  dialBackoffByState,
  disconnectedPeerGraceMs,
  getConnectedPeerHealth,
  getSelfId,
  getState,
  handleAnnouncement,
  handleAnswer,
  handleCandidate,
  handleOffer,
  markPeerConnected,
  offerRelayPlaceholder,
  prunePeerStates,
  resetAnsweringState,
  resetOfferState
} from './peer-negotiation'
import {
  buildSignalAad,
  isValidSignalOfferId,
  isValidSignalPeerId,
  maxPendingPeerConnections,
  maxSignalCandidateChars,
  maxSignalMessageChars,
  maxSignalOfferIdChars,
  maxSignalPeerIdChars,
  maxSignalSdpChars,
  maxTrackedSignalPeers,
  parseSignalEnvelope
} from './signal-crypto'
import {all, log, toJson, topicPath} from './utils'

export {
  buildSignalAad,
  clearConnectedPeer,
  countPendingPeerConnections,
  detachConnectedPeer,
  getConnectedPeerHealth,
  getState,
  isValidSignalOfferId,
  isValidSignalPeerId,
  markPeerConnected,
  maxPendingPeerConnections,
  maxSignalCandidateChars,
  maxSignalMessageChars,
  maxSignalOfferIdChars,
  maxSignalPeerIdChars,
  maxSignalSdpChars,
  maxTrackedSignalPeers,
  prunePeerStates,
  resetAnsweringState,
  resetOfferState
}

export const createSignalHandler = (
  ctx: SignalContext
): {
  handleMessage: (
    relayId: number
  ) => (topic: string, msg: unknown, signalPeer: SignalPeer) => Promise<void>
  dialPeer: (peerId: string) => void
} => {
  const relaySignalPeers: Array<SignalPeer | undefined> = []

  const dialPeer = (peerId: string): void => {
    if (!isValidSignalPeerId(peerId)) {
      return
    }
    void getSelfId(ctx).then(localSelfId => {
      if (ctx.isLeaving() || !peerId || peerId === localSelfId) {
        return
      }
      if (
        !ctx.peerStates[peerId] &&
        countPendingPeerConnections(ctx.peerStates, peerId) >=
          maxPendingPeerConnections
      ) {
        return
      }
      const state = getState(ctx.peerStates, peerId)
      if (
        state.connectedPeer ||
        state.answeringPeer ||
        state.offerAnswered ||
        state.offerPeer ||
        !relaySignalPeers.some(Boolean)
      ) {
        return
      }
      const now = Date.now()
      const backoff = dialBackoffByState.get(state)
      if (backoff && now < backoff.nextAllowedAt) {
        return
      }
      const attempts = (backoff?.attempts ?? 0) + 1
      dialBackoffByState.set(state, {
        attempts,
        nextAllowedAt: now + Math.min(60_000, 2_000 * 2 ** (attempts - 1))
      })
      relaySignalPeers.forEach((signalPeer, relayId) => {
        if (!signalPeer) {
          return
        }
        if (localSelfId < peerId) {
          if (!state.offerRelays[relayId]) {
            state.offerRelays[relayId] = offerRelayPlaceholder
            void handleAnnouncement(ctx, relayId, peerId, signalPeer)
          }
        } else {
          void hashTopic(topicPath(ctx.rootTopicPlaintext, peerId)).then(
            peerSelfTopic => {
              if (
                !ctx.isLeaving() &&
                !state.connectedPeer &&
                !state.answeringPeer &&
                !state.offerAnswered
              ) {
                void signalPeer(peerSelfTopic, toJson({peerId: localSelfId}))
              }
            }
          )
        }
      })
    })
  }

  const handleMessage =
    (relayId: number) =>
    async (
      topic: string,
      msg: unknown,
      signalPeer: SignalPeer
    ): Promise<void> => {
      if (ctx.isLeaving()) {
        return
      }

      relaySignalPeers[relayId] = signalPeer

      const parsed = parseSignalEnvelope(msg)

      if (!parsed) {
        return
      }

      const {peerId, offer, answer, candidate, offerId, peer} = parsed
      if (!peerId || (ctx.selfId && peerId === ctx.selfId)) {
        return
      }

      const [rootTopic, selfTopic, localSelfId] = await all([
        ctx.rootTopicP,
        ctx.selfTopicP,
        getSelfId(ctx)
      ])
      if (peerId === localSelfId) {
        return
      }

      if (ctx.isLeaving()) {
        return
      }

      if (topic !== rootTopic && topic !== selfTopic) {
        return
      }

      ctx.onPeerDiscovered?.(peerId, relayId, signalPeer)

      const state = ctx.peerStates[peerId]
      const connectedPeer = state?.connectedPeer

      if (connectedPeer && state) {
        const health = getConnectedPeerHealth(connectedPeer)

        if (health === 'live') {
          state.connectedPeerUnhealthySinceMs = null
          return
        }

        if (health === 'stale') {
          clearConnectedPeer(state, peerId, 'message-from-stale-peer')
        } else {
          const nowMs = Date.now()
          const unhealthySinceMs = state.connectedPeerUnhealthySinceMs ?? nowMs
          state.connectedPeerUnhealthySinceMs = unhealthySinceMs

          if (nowMs - unhealthySinceMs < disconnectedPeerGraceMs) {
            DEV: log(
              'connected peer transiently unhealthy, suppressing signal:',
              peerId
            )
            return
          }

          clearConnectedPeer(state, peerId, 'message-from-prolonged-disconnect')
        }
      }

      const isAnnouncement = Boolean(peerId && !offer && !answer && !candidate)

      if (isAnnouncement) {
        if (
          ctx.shouldConnectPeer &&
          !ctx.shouldConnectPeer(peerId, 'outbound')
        ) {
          return
        }

        if (
          !ctx.peerStates[peerId] &&
          countPendingPeerConnections(ctx.peerStates, peerId) >=
            maxPendingPeerConnections
        ) {
          return
        }

        const announcePeerState = getState(ctx.peerStates, peerId)
        const shouldLeadOffer = localSelfId < peerId

        if (
          announcePeerState.answeringPeer ||
          announcePeerState.connectedPeer ||
          announcePeerState.offerAnswered
        ) {
          return
        }

        if (!shouldLeadOffer && !announcePeerState.offerPeer) {
          let lastSentByRelay = counterAnnounceTimestamps.get(announcePeerState)

          if (!lastSentByRelay) {
            lastSentByRelay = []
            counterAnnounceTimestamps.set(announcePeerState, lastSentByRelay)
          }

          const lastSentAt = lastSentByRelay[relayId]

          if (lastSentAt !== undefined && Date.now() - lastSentAt >= 1_000) {
            // allow counter-announce
          } else if (lastSentAt !== undefined) {
            return
          }

          lastSentByRelay[relayId] = Date.now()

          const peerSelfTopic = await hashTopic(
            topicPath(ctx.rootTopicPlaintext, peerId)
          )
          if (
            !ctx.isLeaving() &&
            !announcePeerState.connectedPeer &&
            !announcePeerState.answeringPeer &&
            !announcePeerState.offerAnswered
          ) {
            void signalPeer(peerSelfTopic, toJson({peerId: localSelfId}))
          }
          return
        }

        if (announcePeerState.offerRelays[relayId]) {
          return
        }

        announcePeerState.offerRelays[relayId] = offerRelayPlaceholder
        return handleAnnouncement(ctx, relayId, peerId, signalPeer)
      }

      if (offer) {
        return handleOffer(ctx, relayId, peerId, offer, offerId, signalPeer)
      }

      if (candidate) {
        return handleCandidate(ctx, peerId, candidate, offerId, peer)
      }

      if (answer) {
        return handleAnswer(ctx, peerId, answer, offerId, peer)
      }
    }

  return {handleMessage, dialPeer}
}
