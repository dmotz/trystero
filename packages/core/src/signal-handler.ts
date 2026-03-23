import {sha1} from './crypto'
import {offerTtl, type OfferPool} from './offer-pool'
import {getConnectedPeerHealth} from './shared-peer'
import {
  all,
  candidateType,
  fromJson,
  genId,
  log,
  mkErr,
  resetTimer,
  selfId,
  toJson,
  topicPath
} from './utils'
import type {
  PeerHandle,
  PeerState,
  SharedPeerState,
  Signal,
  SignalContext
} from './types'

const offerPostAnswerTtlMs = 23_333
const offerIdSize = 12
const disconnectedPeerGraceMs = 7_533
const answeringTtlMs = 23_333
const legacyCandidateKey = '__legacy__'
const offerRelayPlaceholder = 'offer-placeholder'

const publishCipheredSignalingMessage = (
  ctx: SignalContext,
  signal: Signal,
  peerTopic: string,
  signalPeer: (peerTopic: string, signalJson: string) => void,
  buildPayload: (encryptedSdp: string) => Record<string, unknown>,
  stillValid: () => boolean
): void => {
  void ctx.toCipher(signal).then(encryptedSignal => {
    if (ctx.isLeaving() || !stillValid()) {
      return
    }

    signalPeer(peerTopic, toJson(buildPayload(encryptedSignal.sdp)))
  })
}

const makeState = (): PeerState => ({
  status: 'idle',
  offerPeer: null,
  offerId: null,
  offerSdp: null,
  offerInitPromise: null,
  offerAnswered: false,
  offerRelays: [],
  offerSignalRelays: [],
  offerSignalBacklog: [],
  offerRelayTimers: [],
  offerExpiryTimer: null,
  connectedPeer: null,
  connectedPeerUnhealthySinceMs: null,
  answeringExpiryTimer: null,
  answeringPeer: null,
  pendingCandidates: {}
})

export const getState = (
  peerStates: Record<string, PeerState>,
  peerId: string
): PeerState => (peerStates[peerId] ??= makeState())

export const updateStatus = (state: PeerState): void => {
  if (state.connectedPeer) {
    state.status = 'connected'
  } else if (state.answeringPeer) {
    state.status = 'answering'
  } else if (state.offerPeer || state.offerRelays.some(Boolean)) {
    state.status = 'offering'
  } else {
    state.status = 'idle'
  }
}

const clearAnswering = (state: PeerState, peer: PeerHandle): void => {
  if (state.answeringPeer === peer) {
    state.answeringExpiryTimer = resetTimer(state.answeringExpiryTimer)
    state.answeringPeer = null
    updateStatus(state)
  }
}

export const clearConnectedPeer = (
  state: PeerState,
  peerId: string,
  _reason: string
): void => {
  if (!state.connectedPeer) {
    return
  }

  DEV: log('clearing stale connected peer:', peerId, _reason)

  if (!state.connectedPeer.isDead) {
    state.connectedPeer.destroy()
  }

  state.connectedPeer = null
  state.connectedPeerUnhealthySinceMs = null
  updateStatus(state)
}

const clearOfferRelay = (state: PeerState, relayId: number): void => {
  state.offerRelayTimers[relayId] = resetTimer(state.offerRelayTimers[relayId])

  if (state.offerRelays[relayId]) {
    state.offerRelays[relayId] = undefined
    updateStatus(state)
  }
}

const clearOfferRelayIfPlaceholder = (
  state: PeerState | undefined,
  relayId: number
): void => {
  if (state?.offerRelays[relayId] === offerRelayPlaceholder) {
    clearOfferRelay(state, relayId)
  }
}

const hasRemoteDescription = (peer: PeerHandle): boolean => {
  if (peer.isDead || peer.connection.connectionState === 'closed') {
    return true
  }

  try {
    return Boolean(peer.connection.remoteDescription)
  } catch {
    return true
  }
}

export const resetOfferState = (
  state: PeerState,
  offerPool: OfferPool
): void => {
  const previousOfferAnswered = state.offerAnswered

  state.offerExpiryTimer = resetTimer(state.offerExpiryTimer)
  state.offerInitPromise = null
  state.offerRelays.forEach((_, relayId) => clearOfferRelay(state, relayId))
  state.offerRelays = []
  state.offerSignalRelays = []
  state.offerRelayTimers = []
  state.offerSignalBacklog = []

  if (state.offerPeer && state.offerPeer !== state.connectedPeer) {
    if (previousOfferAnswered || hasRemoteDescription(state.offerPeer)) {
      if (!state.offerPeer.isDead) {
        state.offerPeer.destroy()
      }
    } else {
      offerPool.recycle(state.offerPeer)
    }
  }

  state.offerPeer = null
  state.offerId = null
  state.offerSdp = null
  state.offerAnswered = false
  updateStatus(state)
}

const scheduleAnsweringExpiry = (
  ctx: SignalContext,
  state: PeerState,
  peerId: string,
  peer: PeerHandle
): void => {
  resetTimer(state.answeringExpiryTimer)

  state.answeringExpiryTimer = setTimeout(() => {
    const current = ctx.peerStates[peerId]

    if (!current || current.connectedPeer || current.answeringPeer !== peer) {
      return
    }

    DEV: log('answering timed out for', peerId, '- retrying on next offer')
    peer.destroy()
    clearAnswering(current, peer)
  }, answeringTtlMs)
}

const flushBufferedCandidates = async (
  state: PeerState,
  peer: PeerHandle,
  offerId?: string
): Promise<void> => {
  const bufferKeys = offerId
    ? [offerId, legacyCandidateKey]
    : [legacyCandidateKey]

  for (const key of bufferKeys) {
    const buffered = state.pendingCandidates[key]

    if (!buffered?.length) {
      continue
    }

    delete state.pendingCandidates[key]

    for (const candidate of buffered) {
      await peer.signal(candidate)
    }
  }
}

const scheduleOfferExpiry = (
  ctx: SignalContext,
  state: PeerState,
  peerId: string,
  ttlMs = offerTtl
): void => {
  resetTimer(state.offerExpiryTimer)

  const offerId = state.offerId

  state.offerExpiryTimer = setTimeout(() => {
    const current = ctx.peerStates[peerId]

    if (!current || current.connectedPeer || current.offerId !== offerId) {
      return
    }

    DEV: log('offer expired for', peerId, '- resetting')
    resetOfferState(current, ctx.offerPool)
  }, ttlMs)
}

const ensureOffer = (
  ctx: SignalContext,
  state: PeerState,
  peerId: string,
  relayId: number
): Promise<{peer: PeerHandle; offer: string; offerId: string}> => {
  if (state.offerPeer && state.offerId && state.offerSdp) {
    return Promise.resolve({
      peer: state.offerPeer,
      offer: state.offerSdp,
      offerId: state.offerId
    })
  }

  if (state.offerInitPromise) {
    return state.offerInitPromise
  }

  state.offerInitPromise = (async () => {
    const firstOffer = (
      await ctx.offerPool.checkout(1, false, ctx.encryptOffer)
    )[0]

    if (!firstOffer) {
      throw mkErr('failed to allocate offer peer')
    }

    const {peer, offer} = firstOffer

    state.offerPeer = peer
    state.offerId = genId(offerIdSize)
    state.offerSdp = offer
    state.offerAnswered = false
    state.offerSignalBacklog = []
    updateStatus(state)

    const onOfferPeerClosedOrError = (): void => {
      if (state.offerPeer === peer && !state.connectedPeer) {
        resetOfferState(state, ctx.offerPool)
      }

      ctx.disconnectPeer(peer, peerId)
    }

    peer.setHandlers({
      connect: () => ctx.connectPeer(peer, peerId, relayId),
      signal: signal => {
        if (state.offerPeer !== peer) {
          return
        }

        state.offerSignalBacklog.push(signal)
        state.offerSignalRelays.forEach(sendSignal => sendSignal?.(signal))
      },
      close: onOfferPeerClosedOrError,
      error: onOfferPeerClosedOrError
    })

    scheduleOfferExpiry(ctx, state, peerId)

    return {peer, offer, offerId: state.offerId}
  })().finally(() => (state.offerInitPromise = null))

  return state.offerInitPromise
}

const handleAnnouncement = async (
  ctx: SignalContext,
  relayId: number,
  peerId: string,
  shared: SharedPeerState | undefined,
  signalPeer: (peerTopic: string, signal: string) => void
): Promise<void> => {
  if (shared) {
    ctx.attachSharedPeerToRoom(peerId, shared)
    return
  }

  const state = ctx.peerStates[peerId]

  if (
    !state ||
    state.connectedPeer ||
    state.answeringPeer ||
    state.offerAnswered
  ) {
    clearOfferRelayIfPlaceholder(state, relayId)
    return
  }

  if (state.offerRelays[relayId] !== offerRelayPlaceholder) {
    return
  }

  const [peerTopic, offerInfo] = await all([
    sha1(topicPath(ctx.rootTopicPlaintext, peerId)),
    ensureOffer(ctx, state, peerId, relayId)
  ])

  if (ctx.isLeaving()) {
    return
  }

  if (
    state.connectedPeer ||
    state.answeringPeer ||
    state.offerAnswered ||
    state.offerRelays[relayId] !== offerRelayPlaceholder
  ) {
    clearOfferRelayIfPlaceholder(state, relayId)
    return
  }

  state.offerRelayTimers[relayId] = resetTimer(state.offerRelayTimers[relayId])

  state.offerRelays[relayId] = true
  updateStatus(state)

  state.offerRelayTimers[relayId] = setTimeout(
    () => prunePendingOffer(ctx, peerId, relayId),
    (ctx.announceIntervals[relayId] ?? ctx.announceIntervalMs) * 0.9
  )

  let didSendOffer = false

  state.offerSignalRelays[relayId] = signal => {
    if (!didSendOffer) {
      return
    }

    if (
      ctx.isLeaving() ||
      state.connectedPeer ||
      state.offerPeer !== offerInfo.peer ||
      state.offerId !== offerInfo.offerId ||
      signal.type !== candidateType
    ) {
      return
    }

    publishCipheredSignalingMessage(
      ctx,
      signal,
      peerTopic,
      signalPeer,
      sdp => ({
        peerId: selfId,
        offerId: offerInfo.offerId,
        candidate: sdp
      }),
      () =>
        !state.connectedPeer &&
        state.offerPeer === offerInfo.peer &&
        state.offerId === offerInfo.offerId
    )
  }

  DEV: log('sending offer to', peerId)

  signalPeer(
    peerTopic,
    toJson({
      peerId: selfId,
      offerId: offerInfo.offerId,
      offer: offerInfo.offer
    })
  )

  didSendOffer = true
  state.offerSignalBacklog.forEach(signal =>
    state.offerSignalRelays[relayId]?.(signal)
  )
}

const handleOffer = async (
  ctx: SignalContext,
  relayId: number,
  peerId: string,
  offer: string,
  offerId: string | undefined,
  hasOutgoingOfferHint: boolean,
  signalPeer: (peerTopic: string, signal: string) => void
): Promise<void> => {
  const state = getState(ctx.peerStates, peerId)

  if (state.answeringPeer || state.offerAnswered) {
    return
  }

  const hasTrackedOutgoingOffer = Boolean(
    state.offerPeer || state.offerRelays.some(Boolean)
  )
  const hasOutgoingOffer = hasTrackedOutgoingOffer || hasOutgoingOfferHint

  if (hasOutgoingOffer && selfId < peerId) {
    return
  }

  if (hasTrackedOutgoingOffer) {
    resetOfferState(state, ctx.offerPool)
  }

  const answerPeer = ctx.initPeer(false, ctx.config)
  state.answeringPeer = answerPeer
  scheduleAnsweringExpiry(ctx, state, peerId, answerPeer)
  updateStatus(state)

  const onAnswerPeerClosedOrError = (): void => {
    clearAnswering(state, answerPeer)
    ctx.disconnectPeer(answerPeer, peerId)
  }

  answerPeer.setHandlers({
    connect: () => ctx.connectPeer(answerPeer, peerId, relayId),
    close: onAnswerPeerClosedOrError,
    error: onAnswerPeerClosedOrError
  })

  let plainOffer: Signal

  try {
    plainOffer = await ctx.toPlain({type: 'offer', sdp: offer})
  } catch {
    clearAnswering(state, answerPeer)
    ctx.onJoinError?.({
      error: 'incorrect room password when decrypting offer',
      appId: ctx.appId,
      peerId,
      roomId: ctx.roomId
    })
    return
  }

  if (answerPeer.isDead) {
    clearAnswering(state, answerPeer)
    return
  }

  DEV: log('got offer from', peerId)

  const peerTopic = await sha1(topicPath(ctx.rootTopicPlaintext, peerId))

  if (ctx.isLeaving()) {
    return
  }

  answerPeer.setHandlers({
    signal: signal => {
      if (
        ctx.isLeaving() ||
        state.answeringPeer !== answerPeer ||
        answerPeer.isDead
      ) {
        return
      }

      if (signal.type !== 'answer' && signal.type !== candidateType) {
        return
      }

      publishCipheredSignalingMessage(
        ctx,
        signal,
        peerTopic,
        signalPeer,
        sdp => {
          const payloadToSend: Record<string, unknown> = {
            peerId: selfId
          }

          if (signal.type === 'answer') {
            payloadToSend['answer'] = sdp
          } else {
            payloadToSend['candidate'] = sdp
          }

          if (offerId) {
            payloadToSend['offerId'] = offerId
          }

          return payloadToSend
        },
        () => state.answeringPeer === answerPeer && !answerPeer.isDead
      )
    }
  })

  DEV: log('sending answer to', peerId)
  await answerPeer.signal(plainOffer)
  await flushBufferedCandidates(state, answerPeer, offerId)
}

const handleCandidate = async (
  ctx: SignalContext,
  peerId: string,
  candidate: string,
  offerId: string | undefined,
  peer: PeerHandle | undefined
): Promise<void> => {
  let plainCandidate: Signal

  try {
    plainCandidate = await ctx.toPlain({type: candidateType, sdp: candidate})
  } catch {
    return
  }

  const state = getState(ctx.peerStates, peerId)
  const offerPeerMatch =
    offerId && state?.offerPeer && state.offerId === offerId
      ? state.offerPeer
      : null
  const answeringPeer = state?.answeringPeer ?? null
  const fallbackOfferPeer =
    !offerId && state?.offerPeer ? state.offerPeer : null
  const targetPeer =
    peer && !peer.isDead
      ? peer
      : (offerPeerMatch ?? answeringPeer ?? fallbackOfferPeer)

  if (!targetPeer || targetPeer.isDead) {
    const pendingKey = offerId ?? legacyCandidateKey
    ;(state.pendingCandidates[pendingKey] ??= []).push(plainCandidate)
    return
  }

  void targetPeer.signal(plainCandidate)
}

const handleAnswer = async (
  ctx: SignalContext,
  relayId: number,
  peerId: string,
  answer: string,
  offerId: string | undefined,
  peer: PeerHandle | undefined
): Promise<void> => {
  let plainAnswer: Signal

  try {
    plainAnswer = await ctx.toPlain({type: 'answer', sdp: answer})
  } catch {
    ctx.onJoinError?.({
      error: 'incorrect room password when decrypting answer',
      appId: ctx.appId,
      peerId,
      roomId: ctx.roomId
    })
    return
  }

  DEV: log('got answer from', peerId)

  if (peer) {
    ctx.offerPool.claimLeased(peer)
    peer.setHandlers({
      connect: () => ctx.connectPeer(peer, peerId, relayId),
      close: () => ctx.disconnectPeer(peer, peerId)
    })

    void peer.signal(plainAnswer)
  } else {
    const state = ctx.peerStates[peerId]

    if (
      !state ||
      !state.offerPeer ||
      state.offerAnswered ||
      (offerId && state.offerId && offerId !== state.offerId) ||
      state.offerPeer.isDead
    ) {
      DEV: log(
        'answer dropped for',
        peerId,
        '- reason:',
        !state
          ? 'no-state'
          : state.offerAnswered
            ? 'already-answered'
            : offerId && state.offerId && offerId !== state.offerId
              ? 'offer-id-mismatch'
              : state.offerPeer
                ? 'dead-offer'
                : 'no-offer'
      )

      return
    }

    DEV: log('signaling offer-peer with answer for', peerId)
    state.offerAnswered = true
    scheduleOfferExpiry(ctx, state, peerId, offerPostAnswerTtlMs)
    void state.offerPeer.signal(plainAnswer)
  }
}

const prunePendingOffer = (
  ctx: SignalContext,
  peerId: string,
  relayId: number
): void => {
  const state = ctx.peerStates[peerId]

  if (!state || state.connectedPeer) {
    return
  }

  if (state.offerRelays[relayId]) {
    clearOfferRelay(state, relayId)
  }
}

export const createSignalHandler =
  (ctx: SignalContext) =>
  (relayId: number) =>
  async (
    topic: string,
    msg: unknown,
    signalPeer: (peerTopic: string, signal: string) => void
  ): Promise<void> => {
    if (ctx.isLeaving()) {
      return
    }

    const payload =
      typeof msg === 'string'
        ? fromJson<Record<string, unknown>>(msg)
        : (msg as Record<string, unknown>)

    const peerId =
      typeof payload['peerId'] === 'string' ? payload['peerId'] : ''
    const offer = payload['offer'] as string | undefined
    const answer = payload['answer'] as string | undefined
    const candidate = payload['candidate'] as string | undefined
    const offerId = payload['offerId'] as string | undefined
    const peer = payload['peer'] as PeerHandle | undefined
    const hasOutgoingOfferHint = payload['hasOutgoingOffer'] === true

    if (peerId === selfId) {
      return
    }

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

    let shared = ctx.sharedPeers.get(ctx.appId, peerId)

    if (shared && ctx.sharedPeers.getHealth(shared.peer) === 'stale') {
      ctx.sharedPeers.clear(ctx.appId, peerId, {destroyPeer: true})
      shared = undefined
    }

    const isAnnouncement = Boolean(peerId && !offer && !answer && !candidate)

    if (isAnnouncement && !shared) {
      const announcePeerState = getState(ctx.peerStates, peerId)
      const shouldLeadOffer = selfId < peerId

      if (
        announcePeerState.answeringPeer ||
        announcePeerState.connectedPeer ||
        announcePeerState.offerAnswered
      ) {
        return
      }

      if (!shouldLeadOffer && !announcePeerState.offerPeer) {
        return
      }

      if (announcePeerState.offerRelays[relayId]) {
        return
      }

      announcePeerState.offerRelays[relayId] = offerRelayPlaceholder
      updateStatus(announcePeerState)
    }

    const [rootTopic, selfTopic] = await all([ctx.rootTopicP, ctx.selfTopicP])

    if (ctx.isLeaving()) {
      return
    }

    if (topic !== rootTopic && topic !== selfTopic) {
      if (isAnnouncement) {
        clearOfferRelayIfPlaceholder(ctx.peerStates[peerId], relayId)
      }

      return
    }

    if (shared && (offer || answer || candidate)) {
      if (shared.bindings[ctx.roomId]) {
        DEV: log(
          'ignoring room signal because shared binding already exists:',
          peerId
        )
        return
      }

      ctx.attachSharedPeerToRoom(peerId, shared)
      return
    }

    if (isAnnouncement) {
      return handleAnnouncement(ctx, relayId, peerId, shared, signalPeer)
    }

    if (offer) {
      return handleOffer(
        ctx,
        relayId,
        peerId,
        offer,
        offerId,
        hasOutgoingOfferHint,
        signalPeer
      )
    }

    if (candidate) {
      return handleCandidate(ctx, peerId, candidate, offerId, peer)
    }

    if (answer) {
      return handleAnswer(ctx, relayId, peerId, answer, offerId, peer)
    }
  }
