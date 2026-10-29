import {hashTopic} from './crypto'
import {resolveSelfId} from './identity'
import {
  all,
  candidateType,
  entries,
  fromJson,
  genId,
  log,
  mkErr,
  resetTimer,
  toJson,
  topicPath
} from './utils'
import type {
  BaseRoomConfig,
  OfferRecord,
  PeerHandle,
  PeerState,
  Signal,
  SignalContext
} from './types'

const isPeerUnderlyingStale = (peer: PeerHandle): boolean => {
  const {connection, channel} = peer

  return (
    peer.isDead ||
    connection.connectionState === 'closed' ||
    connection.connectionState === 'failed' ||
    connection.iceConnectionState === 'closed' ||
    connection.iceConnectionState === 'failed' ||
    channel?.readyState === 'closing' ||
    channel?.readyState === 'closed'
  )
}

export const getConnectedPeerHealth = (
  peer: PeerHandle
): 'live' | 'transient' | 'stale' => {
  if (isPeerUnderlyingStale(peer)) {
    return 'stale'
  }

  const {channel} = peer

  if (!channel || channel.readyState !== 'open') {
    return 'transient'
  }

  return 'live'
}

const offerPostAnswerTtlMs = 23_333
const offerTtl = 57_333
const offerIdSize = 12
const disconnectedPeerGraceMs = 7_533
const answeringTtlMs = 23_333
const offerRelayPlaceholder = 'offer-placeholder'
const signalKeys = ['offer', 'answer', 'candidate'] as const
export const maxSignalMessageChars = 128 * 1024
export const maxSignalPeerIdChars = 64
export const maxSignalOfferIdChars = 64
export const maxSignalSdpChars = 64 * 1024
export const maxSignalCandidateChars = 4_096
export const maxTrackedSignalPeers = 256
export const maxPendingPeerConnections = 64
const signalIdPattern = /^[\w.~:!-]{1,64}$/

export const buildSignalAad = (
  type: Signal['type'],
  peerId: string,
  offerId: string
): string => `${type}|${peerId}|${offerId}`

export const isValidSignalPeerId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= maxSignalPeerIdChars &&
  signalIdPattern.test(value)

export const isValidSignalOfferId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= maxSignalOfferIdChars &&
  signalIdPattern.test(value)

const toPayload = (msg: unknown): Record<string, unknown> | null => {
  if (typeof msg === 'string') {
    if (msg.length > maxSignalMessageChars) {
      return null
    }
    try {
      const parsed = fromJson<unknown>(msg)

      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null
    } catch {
      return null
    }
  }

  return msg && typeof msg === 'object' && !Array.isArray(msg)
    ? (msg as Record<string, unknown>)
    : null
}

const getString = (
  payload: Record<string, unknown>,
  key: string
): string | undefined =>
  typeof payload[key] === 'string' && payload[key] ? payload[key] : undefined

const isPeerHandle = (value: unknown): value is PeerHandle =>
  Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as PeerHandle).signal === 'function' &&
    typeof (value as PeerHandle).destroy === 'function' &&
    typeof (value as PeerHandle).setHandlers === 'function'
  )

const hasInvalidSignalField = (
  payload: Record<string, unknown>,
  isStringMessage = false
): boolean => {
  const hasSignalContent = signalKeys.some(key => key in payload)
  return (
    ('peerId' in payload && !isValidSignalPeerId(payload['peerId'])) ||
    (hasSignalContent && !isValidSignalOfferId(payload['offerId'])) ||
    ('offerId' in payload &&
      payload['offerId'] !== undefined &&
      !isValidSignalOfferId(payload['offerId'])) ||
    ('passive' in payload &&
      payload['passive'] !== undefined &&
      typeof payload['passive'] !== 'boolean') ||
    signalKeys.some(key => {
      if (!(key in payload)) {
        return false
      }
      const val = payload[key]
      if (typeof val !== 'string' || val === '') {
        return true
      }
      const maxLen =
        key === 'candidate' ? maxSignalCandidateChars : maxSignalSdpChars
      return val.length > maxLen
    }) ||
    ('peer' in payload &&
      (isStringMessage ||
        (payload['peer'] !== undefined && !isPeerHandle(payload['peer']))))
  )
}

const getSelfId = (ctx: SignalContext): Promise<string> =>
  ctx.selfIdP ??
  (ctx.selfId
    ? Promise.resolve(ctx.selfId)
    : resolveSelfId(undefined, ctx.appId))

export const countPendingPeerConnections = (
  peerStates: Record<string, PeerState>,
  excludePeerId?: string
): number => {
  let count = 0
  for (const [id, s] of entries(peerStates)) {
    if (id === excludePeerId || s.connectedPeer) {
      continue
    }
    if ((s.offerPeer && !s.offerPeer.isDead) || s.offerInitPromise) {
      count++
    }
    if (s.answeringPeer && !s.answeringPeer.isDead) {
      count++
    }
  }
  return count
}

export const prunePeerStates = (peerStates: Record<string, PeerState>): void =>
  entries(peerStates).forEach(([peerId, state]) => {
    if (
      !state.connectedPeer &&
      !state.answeringPeer &&
      !state.offerInitPromise &&
      !state.offerPeer &&
      !state.offerRelays.some(Boolean)
    ) {
      delete peerStates[peerId]
    }
  })

const publishCipheredSignalingMessage = (
  ctx: SignalContext,
  signal: Signal,
  senderPeerId: string,
  offerId: string,
  peerTopic: string,
  signalPeer: (peerTopic: string, signalJson: string) => void,
  buildPayload: (encryptedSdp: string) => Record<string, unknown>,
  stillValid: () => boolean
): void => {
  void ctx
    .toCipher(signal, senderPeerId, offerId)
    .then(encryptedSignal => {
      if (ctx.isLeaving() || !stillValid()) {
        return
      }

      signalPeer(peerTopic, toJson(buildPayload(encryptedSignal.sdp)))
    })
    .catch(() => {})
}

const makeState = (): PeerState => ({
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
  answerSent: false,
  answerReplay: null,
  connectionErrorReported: false
})

const hasTurnServer = (config: BaseRoomConfig): boolean => {
  const iceServers = [
    ...(config.turnConfig ?? []),
    ...(config.rtcConfig?.iceServers ?? [])
  ]

  return iceServers.some(({urls}) => {
    const urlList = Array.isArray(urls) ? urls : [urls]

    return urlList.some(url => /^turns?:/i.test(url))
  })
}

const getSdpExchangeConnectionError = (
  peerId: string,
  config: BaseRoomConfig
): string =>
  `could not connect to peer ${peerId} after exchanging SDP; ${
    hasTurnServer(config)
      ? 'verify TURN server URLs and credentials'
      : 'configure TURN via turnConfig or rtcConfig.iceServers'
  }`

const badPasswordMsg = (kind: string): string =>
  `incorrect password decrypting ${kind}`

const reportSdpExchangeConnectionFailure = (
  ctx: SignalContext,
  state: PeerState,
  peerId: string
): void => {
  if (ctx.isLeaving() || state.connectedPeer || state.connectionErrorReported) {
    return
  }

  state.connectionErrorReported = true
  ctx.onJoinError?.({
    error: getSdpExchangeConnectionError(peerId, ctx.config),
    appId: ctx.appId,
    peerId,
    roomId: ctx.roomId
  })
}

export const getState = (
  peerStates: Record<string, PeerState>,
  peerId: string
): PeerState => {
  const existing = peerStates[peerId]
  if (existing) {
    return existing
  }
  const keys = Object.keys(peerStates)
  if (keys.length >= maxTrackedSignalPeers) {
    const idleKey = keys.find(k => {
      const s = peerStates[k]
      return s && !s.connectedPeer && !s.answeringPeer && !s.offerPeer
    })
    const evictKey =
      idleKey ??
      keys.find(k => {
        const s = peerStates[k]
        return s && !s.connectedPeer
      })
    if (evictKey) {
      const evicted = peerStates[evictKey]
      if (evicted) {
        if (evicted.answeringPeer && !evicted.answeringPeer.isDead) {
          evicted.answeringPeer.destroy()
        }
        resetOfferState(evicted)
        resetAnsweringState(evicted)
      }
      delete peerStates[evictKey]
    }
  }
  return (peerStates[peerId] = makeState())
}

const counterAnnounceTimestamps = new WeakMap<
  PeerState,
  Array<number | undefined>
>()
const dialBackoffByState = new WeakMap<
  PeerState,
  {attempts: number; nextAllowedAt: number}
>()

export const resetAnsweringState = (state: PeerState): void => {
  counterAnnounceTimestamps.delete(state)
  state.answeringExpiryTimer = resetTimer(state.answeringExpiryTimer)
  state.answeringPeer = null
  state.answerSent = false
  state.answerReplay = null
}

const clearAnswering = (state: PeerState, peer: PeerHandle): void => {
  if (state.answeringPeer === peer) {
    resetAnsweringState(state)
    if (state.connectedPeer !== peer && !peer.isDead) {
      peer.destroy()
    }
  }
}

export const markPeerConnected = (
  state: PeerState,
  physical: PeerHandle
): void => {
  if (
    state.answeringPeer &&
    state.answeringPeer !== physical &&
    !state.answeringPeer.isDead
  ) {
    state.answeringPeer.destroy()
  }

  dialBackoffByState.delete(state)
  resetAnsweringState(state)
  state.connectedPeer = physical
  state.connectedPeerUnhealthySinceMs = null
}

export const detachConnectedPeer = (
  state: PeerState | undefined,
  physical: PeerHandle
): void => {
  if (state?.connectedPeer === physical) {
    state.connectedPeer = null
    state.connectedPeerUnhealthySinceMs = null
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
}

const clearOfferRelay = (state: PeerState, relayId: number): void => {
  state.offerRelayTimers[relayId] = resetTimer(state.offerRelayTimers[relayId])

  if (state.offerRelays[relayId]) {
    state.offerRelays[relayId] = undefined
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

export const resetOfferState = (state: PeerState): void => {
  counterAnnounceTimestamps.delete(state)
  state.offerExpiryTimer = resetTimer(state.offerExpiryTimer)
  state.offerInitPromise = null
  state.offerRelays.forEach((_, relayId) => clearOfferRelay(state, relayId))
  state.offerRelays = []
  state.offerSignalRelays = []
  state.offerRelayTimers = []
  state.offerSignalBacklog = []

  if (state.offerPeer && state.offerPeer !== state.connectedPeer) {
    if (!state.offerPeer.isDead) {
      state.offerPeer.destroy()
    }
  }

  state.offerPeer = null
  state.offerId = null
  state.offerSdp = null
  state.offerAnswered = false
  state.connectionErrorReported = false
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
    if (current.answerSent) {
      reportSdpExchangeConnectionFailure(ctx, current, peerId)
    }
    clearAnswering(current, peer)
    prunePeerStates(ctx.peerStates)
  }, answeringTtlMs)
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

    if (current.offerAnswered) {
      reportSdpExchangeConnectionFailure(ctx, current, peerId)
    }
    resetOfferState(current)
    prunePeerStates(ctx.peerStates)
  }, ttlMs)
}

const bindOfferPeerHandlers = (
  ctx: SignalContext,
  state: PeerState,
  peerId: string,
  peer: PeerHandle,
  onSignal?: (signal: Signal) => void
): void => {
  const onOfferPeerClosedOrError = (): void => {
    if (state.offerPeer === peer && !state.connectedPeer) {
      if (state.offerAnswered) {
        reportSdpExchangeConnectionFailure(ctx, state, peerId)
      }
      resetOfferState(state)
    }

    ctx.disconnectPeer(peer, peerId)
    prunePeerStates(ctx.peerStates)
  }

  peer.setHandlers({
    connect: () => ctx.connectPeer(peer, peerId),
    ...(onSignal ? {signal: onSignal} : {}),
    close: onOfferPeerClosedOrError,
    error: onOfferPeerClosedOrError
  })
}

const ensureOffer = (
  ctx: SignalContext,
  state: PeerState,
  peerId: string
): NonNullable<PeerState['offerInitPromise']> => {
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

  if (
    countPendingPeerConnections(ctx.peerStates, peerId) >=
    maxPendingPeerConnections
  ) {
    return Promise.resolve(null)
  }

  const allocateOffer = async (): NonNullable<
    PeerState['offerInitPromise']
  > => {
    const localSelfId = ctx.selfId ?? (await getSelfId(ctx))
    let firstOffer: OfferRecord | undefined

    try {
      firstOffer = (
        await ctx.offerManager.checkout(
          1,
          false,
          (peer, offerId) => ctx.encryptOffer(peer, localSelfId, offerId),
          offerIdSize
        )
      )[0]
    } catch (error) {
      if (ctx.isLeaving() || state.offerInitPromise !== pending) {
        return null
      }

      throw error
    }

    if (!firstOffer) {
      throw mkErr('failed to allocate offer peer')
    }

    const {peer, offer} = firstOffer
    const offerId = firstOffer.offerId || genId(offerIdSize)

    if (ctx.isLeaving() || state.offerInitPromise !== pending) {
      peer.destroy()
      return null
    }

    state.offerPeer = peer
    state.offerId = offerId
    state.offerSdp = offer
    state.offerAnswered = false
    state.connectionErrorReported = false
    state.offerSignalBacklog = []

    bindOfferPeerHandlers(ctx, state, peerId, peer, signal => {
      if (state.offerPeer !== peer) {
        return
      }

      state.offerSignalBacklog.push(signal)
      state.offerSignalRelays.forEach(sendSignal => sendSignal?.(signal))
    })

    scheduleOfferExpiry(ctx, state, peerId)

    return {peer, offer, offerId: state.offerId}
  }

  const pending = allocateOffer().finally(() => {
    if (state.offerInitPromise === pending) {
      state.offerInitPromise = null
    }
  })

  return (state.offerInitPromise = pending)
}

const handleAnnouncement = async (
  ctx: SignalContext,
  relayId: number,
  peerId: string,
  signalPeer: (peerTopic: string, signal: string) => void,
  retryAttempt = 0
): Promise<void> => {
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

  const [peerTopic, offerInfo, localSelfId] = await all([
    hashTopic(topicPath(ctx.rootTopicPlaintext, peerId)),
    ensureOffer(ctx, state, peerId),
    getSelfId(ctx)
  ])

  if (!offerInfo) {
    clearOfferRelayIfPlaceholder(state, relayId)
    return
  }

  if (ctx.isLeaving()) {
    resetOfferState(state)
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

  state.offerRelayTimers[relayId] = setTimeout(
    () => {
      // Discovery can be quiet for a minute. Retry this exchange directly,
      // but never keep a missing peer (or a departed room) busy indefinitely.
      if (
        retryAttempt >= 2 ||
        ctx.isLeaving() ||
        state.connectedPeer ||
        state.answeringPeer ||
        state.offerAnswered ||
        state.offerPeer !== offerInfo.peer ||
        state.offerId !== offerInfo.offerId
      ) {
        prunePendingOffer(ctx, peerId, relayId)
        return
      }

      state.offerRelays[relayId] = offerRelayPlaceholder
      void handleAnnouncement(
        ctx,
        relayId,
        peerId,
        signalPeer,
        retryAttempt + 1
      )
    },
    retryAttempt === 0 && ctx.announceIntervals[relayId] === undefined
      ? 2_000
      : (ctx.announceIntervals[relayId] ?? ctx.announceIntervalMs) * 0.9
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
      localSelfId,
      offerInfo.offerId,
      peerTopic,
      signalPeer,
      sdp => ({
        peerId: localSelfId,
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
      peerId: localSelfId,
      offerId: offerInfo.offerId,
      offer: offerInfo.offer
    })
  )

  didSendOffer = true
  state.offerSignalBacklog.forEach(signal =>
    state.offerSignalRelays[relayId]?.(signal)
  )
}

const replayExistingAnswerIfMatch = async (
  ctx: SignalContext,
  state: PeerState,
  relayId: number,
  peerId: string,
  offer: string,
  offerId: string,
  signalPeer: (peerTopic: string, signal: string) => void
): Promise<void> => {
  const replay = state.answerReplay
  const lastSentAt = replay?.lastSentAt[relayId]

  if (
    state.answeringPeer &&
    !state.answeringPeer.isDead &&
    replay &&
    replay.offer === offer &&
    replay.offerId === offerId &&
    (lastSentAt === undefined || Date.now() - lastSentAt >= 1_000)
  ) {
    replay.lastSentAt[relayId] = Date.now()

    const peerTopic = await hashTopic(topicPath(ctx.rootTopicPlaintext, peerId))

    if (
      !ctx.isLeaving() &&
      state.answerReplay === replay &&
      !state.connectedPeer
    ) {
      const send = (message: string): void => signalPeer(peerTopic, message)
      replay.relays[relayId] = send
      replay.messages.forEach(send)
    }
  }
}

const handleOffer = async (
  ctx: SignalContext,
  relayId: number,
  peerId: string,
  offer: string,
  offerId: string | undefined,
  signalPeer: (peerTopic: string, signal: string) => void
): Promise<void> => {
  if (!offerId) {
    return
  }
  const localSelfId = ctx.selfId ?? (await getSelfId(ctx))
  if (ctx.shouldConnectPeer && !ctx.shouldConnectPeer(peerId, 'inbound')) {
    return
  }

  const existingState = ctx.peerStates[peerId]
  if (
    existingState &&
    (existingState.answeringPeer || existingState.offerAnswered)
  ) {
    await replayExistingAnswerIfMatch(
      ctx,
      existingState,
      relayId,
      peerId,
      offer,
      offerId,
      signalPeer
    )
    return
  }

  const preHasTrackedOutgoingOffer = Boolean(
    existingState &&
    (existingState.offerPeer || existingState.offerRelays.some(Boolean))
  )
  if (preHasTrackedOutgoingOffer && localSelfId < peerId) {
    return
  }

  if (
    countPendingPeerConnections(ctx.peerStates, peerId) >=
    maxPendingPeerConnections
  ) {
    return
  }

  let plainOffer: Signal

  try {
    plainOffer = await ctx.toPlain({type: 'offer', sdp: offer}, peerId, offerId)
  } catch {
    ctx.onJoinError?.({
      error: badPasswordMsg('offer'),
      appId: ctx.appId,
      peerId,
      roomId: ctx.roomId
    })
    return
  }

  if (ctx.isLeaving()) {
    return
  }

  const state = getState(ctx.peerStates, peerId)
  if (state.connectedPeer) {
    return
  }

  if (state.answeringPeer || state.offerAnswered) {
    await replayExistingAnswerIfMatch(
      ctx,
      state,
      relayId,
      peerId,
      offer,
      offerId,
      signalPeer
    )
    return
  }

  const hasTrackedOutgoingOffer = Boolean(
    state.offerPeer || state.offerRelays.some(Boolean)
  )

  if (hasTrackedOutgoingOffer && localSelfId < peerId) {
    return
  }

  if (hasTrackedOutgoingOffer) {
    resetOfferState(state)
  }

  if (
    countPendingPeerConnections(ctx.peerStates, peerId) >=
    maxPendingPeerConnections
  ) {
    prunePeerStates(ctx.peerStates)
    return
  }

  const answerPeer = ctx.initPeer(false, ctx.config)
  const replay: NonNullable<PeerState['answerReplay']> = {
    offer,
    offerId,
    messages: [],
    lastSentAt: [],
    relays: []
  }
  replay.lastSentAt[relayId] = Date.now()
  state.answeringPeer = answerPeer
  state.answerSent = false
  state.answerReplay = replay
  state.connectionErrorReported = false
  scheduleAnsweringExpiry(ctx, state, peerId, answerPeer)

  const onAnswerPeerClosedOrError = (): void => {
    if (
      state.answeringPeer === answerPeer &&
      !state.connectedPeer &&
      state.answerSent
    ) {
      reportSdpExchangeConnectionFailure(ctx, state, peerId)
    }
    clearAnswering(state, answerPeer)
    ctx.disconnectPeer(answerPeer, peerId)
    prunePeerStates(ctx.peerStates)
  }

  answerPeer.setHandlers({
    connect: () => ctx.connectPeer(answerPeer, peerId),
    close: onAnswerPeerClosedOrError,
    error: onAnswerPeerClosedOrError
  })

  if (answerPeer.isDead) {
    clearAnswering(state, answerPeer)
    prunePeerStates(ctx.peerStates)
    return
  }

  DEV: log('got offer from', peerId)

  const peerTopic = await hashTopic(topicPath(ctx.rootTopicPlaintext, peerId))

  if (ctx.isLeaving() || state.answerReplay !== replay) {
    return
  }

  replay.relays[relayId] = message => signalPeer(peerTopic, message)

  const pendingCandidates: Signal[] = []
  let didSendAnswer = false

  const publishAnswerSignal = (signal: Signal): void => {
    void ctx
      .toCipher(signal, localSelfId, offerId)
      .then(encryptedSignal => {
        if (
          ctx.isLeaving() ||
          state.answeringPeer !== answerPeer ||
          answerPeer.isDead
        ) {
          return
        }

        const payloadToSend: Record<string, unknown> = {
          peerId: localSelfId,
          offerId
        }

        if (signal.type === 'answer') {
          state.answerSent = true
          payloadToSend['answer'] = encryptedSignal.sdp
        } else {
          payloadToSend['candidate'] = encryptedSignal.sdp
        }

        const message = toJson(payloadToSend)
        const now = Date.now()
        replay.messages.push(message)
        replay.relays.forEach((send, id) => {
          if (send) {
            replay.lastSentAt[id] = now
            send(message)
          }
        })

        if (signal.type === 'answer' && !didSendAnswer) {
          didSendAnswer = true
          pendingCandidates.splice(0).forEach(publishAnswerSignal)
        }
      })
      .catch(() => {})
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

      if (signal.type === candidateType && !didSendAnswer) {
        pendingCandidates.push(signal)
        return
      }

      publishAnswerSignal(signal)
    }
  })

  DEV: log('sending answer to', peerId)
  await answerPeer.signal(plainOffer)
}

const handleCandidate = async (
  ctx: SignalContext,
  peerId: string,
  candidate: string,
  offerId: string | undefined,
  peer: PeerHandle | undefined
): Promise<void> => {
  if (!offerId) {
    return
  }
  const state = ctx.peerStates[peerId]
  if (!peer && !state?.offerPeer && !state?.answeringPeer) {
    return
  }

  let plainCandidate: Signal

  try {
    plainCandidate = await ctx.toPlain(
      {type: candidateType, sdp: candidate},
      peerId,
      offerId
    )
  } catch {
    return
  }

  const currentState = ctx.peerStates[peerId]
  const offerPeerMatch =
    currentState?.offerPeer && currentState.offerId === offerId
      ? currentState.offerPeer
      : null
  const answeringPeer =
    currentState?.answerReplay?.offerId === offerId
      ? currentState.answeringPeer
      : null
  const targetPeer =
    peer && !peer.isDead ? peer : (offerPeerMatch ?? answeringPeer)

  if (targetPeer && !targetPeer.isDead) {
    void targetPeer.signal(plainCandidate)
  }
}

const handleAnswer = async (
  ctx: SignalContext,
  peerId: string,
  answer: string,
  offerId: string | undefined,
  peer: PeerHandle | undefined
): Promise<void> => {
  if (!offerId) {
    return
  }
  const localSelfId = ctx.selfId ?? (await getSelfId(ctx))
  let plainAnswer: Signal

  try {
    plainAnswer = await ctx.toPlain(
      {type: 'answer', sdp: answer},
      peerId,
      offerId
    )
  } catch {
    if (peer) {
      ctx.offerManager.reclaimLeased(peer)
      if (!peer.isDead) {
        peer.destroy()
      }
    }

    ctx.onJoinError?.({
      error: badPasswordMsg('answer'),
      appId: ctx.appId,
      peerId,
      roomId: ctx.roomId
    })
    return
  }

  DEV: log('got answer from', peerId)

  if (peer) {
    const state = getState(ctx.peerStates, peerId)
    ctx.offerManager.claimLeased(peer)

    if (
      state.connectedPeer ||
      state.offerAnswered ||
      (state.answeringPeer &&
        !state.answeringPeer.isDead &&
        localSelfId > peerId)
    ) {
      peer.destroy()
      return
    }

    if (state.answeringPeer) {
      const answeringPeer = state.answeringPeer
      clearAnswering(state, answeringPeer)
    }

    resetOfferState(state)
    state.offerPeer = peer
    state.offerId = offerId
    state.offerAnswered = true
    scheduleOfferExpiry(ctx, state, peerId, offerPostAnswerTtlMs)
    bindOfferPeerHandlers(ctx, state, peerId, peer)

    void peer.signal(plainAnswer)
  } else {
    const state = ctx.peerStates[peerId]

    if (
      !state ||
      !state.offerPeer ||
      state.offerAnswered ||
      !state.offerId ||
      offerId !== state.offerId ||
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
            : !state.offerId || offerId !== state.offerId
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
    prunePeerStates(ctx.peerStates)
  }
}

export const createSignalHandler = (ctx: SignalContext) => {
  const relaySignalPeers: Array<
    ((peerTopic: string, signal: string) => void) | undefined
  > = []

  ctx.dialPeer = (peerId: string): void => {
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
                signalPeer(peerSelfTopic, toJson({peerId: localSelfId}))
              }
            }
          )
        }
      })
    })
  }

  return (relayId: number) =>
    async (
      topic: string,
      msg: unknown,
      signalPeer: (peerTopic: string, signal: string) => void
    ): Promise<void> => {
      if (ctx.isLeaving()) {
        return
      }

      relaySignalPeers[relayId] = signalPeer

      const payload = toPayload(msg)

      if (!payload || hasInvalidSignalField(payload, typeof msg === 'string')) {
        return
      }

      const peerId = getString(payload, 'peerId') ?? ''
      const offer = getString(payload, 'offer')
      const answer = getString(payload, 'answer')
      const candidate = getString(payload, 'candidate')
      const offerId = getString(payload, 'offerId')
      const peer = isPeerHandle(payload['peer']) ? payload['peer'] : undefined
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
            signalPeer(peerSelfTopic, toJson({peerId: localSelfId}))
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
}
