import {hashTopic} from './crypto'
import type {
  AnswerReplayState,
  BaseRoomConfig,
  OfferRecord,
  PeerHandle,
  PeerState,
  Signal,
  SignalContext,
  SignalPeer
} from './internal-types'
import {
  all,
  candidateType,
  createBoundedCache,
  fromJson,
  genId,
  hasIceUrl,
  isObj,
  logErr,
  mkErr,
  noOp,
  resetTimer,
  toJson,
  topicPath,
  unrefTimer
} from './utils'

const signalKeys = ['offer', 'answer', 'candidate'] as const
const maxSignalMessageChars: number = 128 * 1024
const maxSignalOfferIdChars = 64
const maxSignalSdpChars: number = 64 * 1024
const maxSignalCandidateChars = 4_096
const maxTrackedSignalPeers = 256
export const maxPendingPeerConnections = 64
const decryptErrDedupeTtlMs = 60_000
const signalPeerIdPattern = /^[0-9A-Za-z]{20}$/
const signalIdPattern = /^[\w.~:!-]{1,64}$/

export const buildSignalAad = (
  type: Signal['type'],
  peerId: string,
  offerId: string
): string => `${type}|${peerId}|${offerId}`

const isValidSignalId = (value: unknown, maxLen: number): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= maxLen &&
  signalIdPattern.test(value)

export const isValidSignalPeerId = (value: unknown): value is string =>
  typeof value === 'string' && signalPeerIdPattern.test(value)

const isValidSignalOfferId = (value: unknown): value is string =>
  isValidSignalId(value, maxSignalOfferIdChars)

const toPayload = (msg: unknown): Record<string, unknown> | null => {
  if (typeof msg === 'string') {
    if (msg.length > maxSignalMessageChars) {
      return null
    }
    try {
      const parsed = fromJson<unknown>(msg)
      return isObj(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  return isObj(msg) ? msg : null
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

const parseSignalEnvelope = (
  msg: unknown
):
  | readonly [
      peerId: string,
      offer: string | undefined,
      answer: string | undefined,
      candidate: string | undefined,
      offerId: string | undefined,
      peer: PeerHandle | undefined
    ]
  | null => {
  const payload = toPayload(msg)
  if (!payload) {
    return null
  }
  const isRawString = typeof msg === 'string'
  const hasSignalContent = signalKeys.some(k => k in payload)
  if (
    ('peerId' in payload && !isValidSignalPeerId(payload['peerId'])) ||
    ((hasSignalContent || payload['offerId'] !== undefined) &&
      !isValidSignalOfferId(payload['offerId'])) ||
    signalKeys.some(k => {
      if (!(k in payload)) {
        return false
      }
      const val = payload[k]
      return (
        typeof val !== 'string' ||
        val === '' ||
        val.length >
          (k === 'candidate' ? maxSignalCandidateChars : maxSignalSdpChars)
      )
    }) ||
    ('peer' in payload &&
      (isRawString ||
        (payload['peer'] !== undefined && !isPeerHandle(payload['peer']))))
  ) {
    return null
  }
  return [
    getString(payload, 'peerId') ?? '',
    getString(payload, 'offer'),
    getString(payload, 'answer'),
    getString(payload, 'candidate'),
    getString(payload, 'offerId'),
    isPeerHandle(payload['peer']) ? payload['peer'] : undefined
  ]
}

const hasTurnServer = (config: BaseRoomConfig): boolean =>
  hasIceUrl(
    [...(config.turnConfig ?? []), ...(config.rtcConfig?.iceServers ?? [])],
    /^turns?:/i
  )

const isDeadConnState = (s?: string): boolean =>
  s === 'closed' || s === 'failed'

export const getConnectedPeerHealth = (
  peer: PeerHandle
): 'live' | 'transient' | 'stale' => {
  const {connection: pc, channel: ch} = peer
  return peer.isDead ||
    isDeadConnState(pc.connectionState) ||
    isDeadConnState(pc.iceConnectionState) ||
    ch?.readyState === 'closing' ||
    ch?.readyState === 'closed'
    ? 'stale'
    : !ch || ch.readyState !== 'open'
      ? 'transient'
      : 'live'
}

const offerPostAnswerTtlMs = 23_333
const offerTtl = 57_333
const offerIdSize = 12
const disconnectedPeerGraceMs = 7_533
const answeringTtlMs = 23_333
const offerRelayPlaceholder = 'offer-placeholder'

const countPendingPeerConnections = (
  peerStates: Map<string, PeerState>,
  excludePeerId?: string
): number => {
  let count = 0
  for (const [id, s] of peerStates) {
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

export const prunePeerStates = (peerStates: Map<string, PeerState>): void => {
  for (const [peerId, s] of peerStates) {
    if (
      !s.connectedPeer &&
      !s.answeringPeer &&
      !s.offerInitPromise &&
      !s.offerPeer &&
      !s.offerRelays.some(Boolean)
    ) {
      peerStates.delete(peerId)
    }
  }
}

const counterAnnounceTimestamps = /*@__PURE__*/ new WeakMap<
  PeerState,
  Array<number | undefined>
>()
const dialBackoffByState = /*@__PURE__*/ new WeakMap<
  PeerState,
  [attempts: number, nextAllowedAt: number]
>()

const destroyAlive = (peer: PeerHandle | null | undefined): void => {
  if (peer && !peer.isDead) {
    peer.destroy()
  }
}

export const resetAnsweringState = (state: PeerState): void => {
  counterAnnounceTimestamps.delete(state)
  state.answeringExpiryTimer = resetTimer(state.answeringExpiryTimer)
  state.answeringPeer = null
  state.didSendAnswer = false
  state.answerReplay = null
}

const clearAnswering = (state: PeerState, peer: PeerHandle): void => {
  if (state.answeringPeer === peer) {
    resetAnsweringState(state)
    if (state.connectedPeer !== peer) {
      destroyAlive(peer)
    }
  }
}

export const markPeerConnected = (
  state: PeerState,
  physical: PeerHandle
): void => {
  if (state.answeringPeer !== physical) {
    destroyAlive(state.answeringPeer)
  }
  dialBackoffByState.delete(state)
  resetAnsweringState(state)
  state.connectedPeer = physical
  state.unhealthySince = null
}

export const detachConnectedPeer = (
  state: PeerState | undefined,
  physical: PeerHandle
): void => {
  if (state?.connectedPeer === physical) {
    state.connectedPeer = null
    state.unhealthySince = null
  }
}

export const clearConnectedPeer = (state: PeerState): void => {
  if (!state.connectedPeer) {
    return
  }
  destroyAlive(state.connectedPeer)
  state.connectedPeer = null
  state.unhealthySince = null
}

const clearOfferRelay = (state: PeerState, relayId: number): void => {
  state.offerRetryTimers[relayId] = resetTimer(state.offerRetryTimers[relayId])
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
  state.offerCandidateSenders = []
  state.offerRetryTimers = []
  state.bufferedOfferCandidates = []
  if (state.offerPeer !== state.connectedPeer) {
    destroyAlive(state.offerPeer)
  }
  state.offerPeer = null
  state.offerId = null
  state.offerSdp = null
  state.offerAnswered = false
  state.didReportConnectFailure = false
}

export const getState = (
  peerStates: Map<string, PeerState>,
  peerId: string
): PeerState => {
  const existing = peerStates.get(peerId)
  if (existing) {
    return existing
  }
  if (peerStates.size >= maxTrackedSignalPeers) {
    let evictKey: string | undefined
    let fallbackKey: string | undefined
    for (const [k, s] of peerStates) {
      if (!s.connectedPeer && !s.answeringPeer && !s.offerPeer) {
        evictKey = k
        break
      }
      if (fallbackKey === undefined && !s.connectedPeer) {
        fallbackKey = k
      }
    }
    const targetKey = evictKey ?? fallbackKey
    if (targetKey !== undefined) {
      const evicted = peerStates.get(targetKey)
      if (evicted) {
        destroyAlive(evicted.answeringPeer)
        resetOfferState(evicted)
        resetAnsweringState(evicted)
      }
      peerStates.delete(targetKey)
    }
  }
  const created: PeerState = {
    offerPeer: null,
    offerId: null,
    offerInitPromise: null,
    offerRelays: [],
    connectedPeer: null,
    answeringPeer: null,
    offerSdp: null,
    offerAnswered: false,
    offerCandidateSenders: [],
    bufferedOfferCandidates: [],
    offerRetryTimers: [],
    offerExpiryTimer: null,
    unhealthySince: null,
    answeringExpiryTimer: null,
    didSendAnswer: false,
    answerReplay: null,
    didReportConnectFailure: false
  }
  peerStates.set(peerId, created)
  return created
}

export const createSignalHandler = (
  ctx: SignalContext
): {
  handleMessage: (
    relayId: number
  ) => (topic: string, msg: unknown, signalPeer: SignalPeer) => Promise<void>
  dialPeer: (peerId: string) => void
} => {
  const {
    appId,
    getRoomId,
    config,
    peerStates,
    getRootTopicPlaintext,
    rootTopicP,
    selfTopicP,
    toPlain,
    toCipher,
    isLeaving,
    onError,
    checkoutOffers,
    claimLeasedOffer,
    reclaimLeasedOffer,
    encryptOffer,
    initPeer: initPeerFn,
    connectPeer,
    disconnectPeer,
    announceIntervals,
    announceIntervalMs,
    getSelfIdNow,
    selfIdP,
    onPeerDiscovered,
    shouldConnectPeer
  } = ctx

  const relaySignalPeers: Array<SignalPeer | undefined> = []
  const recentDecryptErrors = createBoundedCache<string, number>(512)

  const getSelfId = (): Promise<string> => selfIdP

  const peerTopicOf = (peerId: string): Promise<string> =>
    hashTopic(topicPath(getRootTopicPlaintext(), peerId))

  const atPendingCap = (peerId: string): boolean =>
    countPendingPeerConnections(peerStates, peerId) >= maxPendingPeerConnections

  const reportSdpFailure = (state: PeerState, peerId: string): void => {
    if (isLeaving() || state.connectedPeer || state.didReportConnectFailure) {
      return
    }
    state.didReportConnectFailure = true
    const turnConfigured = hasTurnServer(config)
    onError?.({
      code: 'peer-connect-failed',
      peerId,
      turnConfigured,
      message: `could not connect to peer ${peerId} after exchanging SDP; ${
        turnConfigured
          ? 'verify TURN server URLs and credentials'
          : 'configure TURN via turnConfig or rtcConfig.iceServers'
      }`,
      appId,
      roomId: getRoomId()
    })
  }

  const reportDecryptErr = (
    peerId: string,
    stage: 'offer' | 'answer',
    cause: unknown
  ): void => {
    const key = `${peerId}:${stage}`
    const now = Date.now()
    const prev = recentDecryptErrors.get(key)
    if (prev !== undefined && now - prev < decryptErrDedupeTtlMs) {
      return
    }
    recentDecryptErrors.set(key, now)
    onError?.({
      code: 'decrypt-failed',
      peerId,
      stage,
      message: `failed to decrypt ${stage} (incorrect password or corrupted signal)`,
      appId,
      roomId: getRoomId(),
      cause
    })
  }

  const scheduleAnsweringExpiry = (
    state: PeerState,
    peerId: string,
    peer: PeerHandle
  ): void => {
    resetTimer(state.answeringExpiryTimer)
    state.answeringExpiryTimer = setTimeout(() => {
      const current = peerStates.get(peerId)
      if (!current || current.connectedPeer || current.answeringPeer !== peer) {
        return
      }
      if (current.didSendAnswer) {
        reportSdpFailure(current, peerId)
      }
      clearAnswering(current, peer)
      prunePeerStates(peerStates)
    }, answeringTtlMs)
    unrefTimer(state.answeringExpiryTimer)
  }

  const scheduleOfferExpiry = (
    state: PeerState,
    peerId: string,
    ttlMs = offerTtl
  ): void => {
    resetTimer(state.offerExpiryTimer)
    const offerId = state.offerId
    state.offerExpiryTimer = setTimeout(() => {
      const current = peerStates.get(peerId)
      if (!current || current.connectedPeer || current.offerId !== offerId) {
        return
      }
      if (current.offerAnswered) {
        reportSdpFailure(current, peerId)
      }
      resetOfferState(current)
      prunePeerStates(peerStates)
    }, ttlMs)
    unrefTimer(state.offerExpiryTimer)
  }

  const bindOfferPeerHandlers = (
    state: PeerState,
    peerId: string,
    peer: PeerHandle,
    onSignal?: (signal: Signal) => void
  ): void => {
    const onClosedOrError = (): void => {
      if (state.offerPeer === peer && !state.connectedPeer) {
        if (state.offerAnswered) {
          reportSdpFailure(state, peerId)
        }
        resetOfferState(state)
      }
      disconnectPeer(peer, peerId)
      prunePeerStates(peerStates)
    }

    peer.setHandlers({
      connect: () => connectPeer(peer, peerId),
      ...(onSignal ? {signal: onSignal} : {}),
      close: onClosedOrError,
      error: onClosedOrError
    })
  }

  const ensureOffer = (
    state: PeerState,
    peerId: string
  ): NonNullable<PeerState['offerInitPromise']> => {
    if (state.offerPeer && state.offerId && state.offerSdp) {
      return Promise.resolve([state.offerPeer, state.offerSdp, state.offerId])
    }
    if (state.offerInitPromise) {
      return state.offerInitPromise
    }
    if (atPendingCap(peerId)) {
      return Promise.resolve(null)
    }

    const allocateOffer = async (): NonNullable<
      PeerState['offerInitPromise']
    > => {
      const localSelfId = getSelfIdNow() ?? (await getSelfId())
      let firstOffer: OfferRecord | undefined
      try {
        firstOffer = (
          await checkoutOffers(
            1,
            false,
            (peer, oid) => encryptOffer(peer, localSelfId, oid),
            offerIdSize
          )
        )[0]
      } catch (error) {
        if (isLeaving() || state.offerInitPromise !== pending) {
          return null
        }
        throw error
      }

      if (!firstOffer) {
        throw mkErr('failed to allocate offer peer')
      }

      const {peer, offer} = firstOffer
      const offerId = firstOffer.offerId || genId(offerIdSize)
      if (isLeaving() || state.offerInitPromise !== pending) {
        peer.destroy()
        return null
      }

      state.offerPeer = peer
      state.offerId = offerId
      state.offerSdp = offer
      state.offerAnswered = false
      state.didReportConnectFailure = false
      state.bufferedOfferCandidates = []

      bindOfferPeerHandlers(state, peerId, peer, signal => {
        if (state.offerPeer === peer) {
          state.bufferedOfferCandidates.push(signal)
          state.offerCandidateSenders.forEach(sendSignal =>
            sendSignal?.(signal)
          )
        }
      })
      scheduleOfferExpiry(state, peerId)
      return [peer, offer, offerId]
    }

    const pending = allocateOffer().finally(() => {
      if (state.offerInitPromise === pending) {
        state.offerInitPromise = null
      }
    })
    return (state.offerInitPromise = pending)
  }

  const handleAnnouncement = async (
    relayId: number,
    peerId: string,
    signalPeer: SignalPeer,
    retryAttempt = 0
  ): Promise<void> => {
    const state = peerStates.get(peerId)
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

    let peerTopic: string
    let offerInfo: Awaited<ReturnType<typeof ensureOffer>>
    let localSelfId: string
    try {
      ;[peerTopic, offerInfo, localSelfId] = await all([
        peerTopicOf(peerId),
        ensureOffer(state, peerId),
        getSelfId()
      ])
    } catch (err) {
      clearOfferRelayIfPlaceholder(state, relayId)
      prunePeerStates(peerStates)
      throw err
    }

    if (!offerInfo) {
      clearOfferRelayIfPlaceholder(state, relayId)
      return
    }
    if (isLeaving()) {
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

    const [offerPeer, offerSdp, offerId] = offerInfo
    state.offerRetryTimers[relayId] = resetTimer(
      state.offerRetryTimers[relayId]
    )
    state.offerRelays[relayId] = true

    const retryTimer = setTimeout(
      () => {
        if (
          retryAttempt >= 2 ||
          isLeaving() ||
          state.connectedPeer ||
          state.answeringPeer ||
          state.offerAnswered ||
          state.offerPeer !== offerPeer ||
          state.offerId !== offerId
        ) {
          const cur = peerStates.get(peerId)
          if (cur && !cur.connectedPeer && cur.offerRelays[relayId]) {
            clearOfferRelay(cur, relayId)
            prunePeerStates(peerStates)
          }
          return
        }
        state.offerRelays[relayId] = offerRelayPlaceholder
        void handleAnnouncement(
          relayId,
          peerId,
          signalPeer,
          retryAttempt + 1
        ).catch(err => {
          if (!isLeaving()) {
            logErr('signal', err)
          }
        })
      },
      retryAttempt === 0 && announceIntervals[relayId] === undefined
        ? 2_000
        : (announceIntervals[relayId] ?? announceIntervalMs) * 0.9
    )
    unrefTimer(retryTimer)
    state.offerRetryTimers[relayId] = retryTimer

    let didSendOffer = false
    state.offerCandidateSenders[relayId] = signal => {
      if (
        !didSendOffer ||
        isLeaving() ||
        state.connectedPeer ||
        state.offerPeer !== offerPeer ||
        state.offerId !== offerId ||
        signal.type !== candidateType
      ) {
        return
      }
      void toCipher(signal, localSelfId, offerId)
        .then(enc => {
          if (
            !isLeaving() &&
            !state.connectedPeer &&
            state.offerPeer === offerPeer &&
            state.offerId === offerId
          ) {
            void signalPeer(
              peerTopic,
              toJson({peerId: localSelfId, offerId, candidate: enc.sdp})
            )
          }
        })
        .catch(noOp)
    }

    void signalPeer(
      peerTopic,
      toJson({peerId: localSelfId, offerId, offer: offerSdp})
    )
    didSendOffer = true
    state.bufferedOfferCandidates.forEach(signal =>
      state.offerCandidateSenders[relayId]?.(signal)
    )
  }

  const replayExistingAnswerIfMatch = async (
    state: PeerState,
    relayId: number,
    peerId: string,
    offer: string,
    offerId: string,
    signalPeer: SignalPeer
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
      const peerTopic = await peerTopicOf(peerId)
      if (
        !isLeaving() &&
        state.answerReplay === replay &&
        !state.connectedPeer
      ) {
        const send = (message: string): void => {
          void signalPeer(peerTopic, message)
        }
        replay.relays[relayId] = send
        replay.messages.forEach(send)
      }
    }
  }

  const handleOffer = async (
    relayId: number,
    peerId: string,
    offer: string,
    offerId: string | undefined,
    signalPeer: SignalPeer
  ): Promise<void> => {
    if (!offerId) {
      return
    }
    const localSelfId = getSelfIdNow() ?? (await getSelfId())
    if (shouldConnectPeer && !shouldConnectPeer(peerId, 'inbound')) {
      return
    }

    const existingState = peerStates.get(peerId)
    if (
      existingState &&
      (existingState.answeringPeer || existingState.offerAnswered)
    ) {
      return replayExistingAnswerIfMatch(
        existingState,
        relayId,
        peerId,
        offer,
        offerId,
        signalPeer
      )
    }

    if (
      existingState &&
      (existingState.offerPeer || existingState.offerRelays.some(Boolean)) &&
      localSelfId < peerId
    ) {
      return
    }

    if (atPendingCap(peerId)) {
      return
    }

    let plainOffer: Signal
    try {
      plainOffer = await toPlain({type: 'offer', sdp: offer}, peerId, offerId)
    } catch (err) {
      reportDecryptErr(peerId, 'offer', err)
      return
    }

    if (isLeaving()) {
      return
    }

    const state = getState(peerStates, peerId)
    if (state.connectedPeer) {
      return
    }
    if (state.answeringPeer || state.offerAnswered) {
      return replayExistingAnswerIfMatch(
        state,
        relayId,
        peerId,
        offer,
        offerId,
        signalPeer
      )
    }

    if (state.offerPeer || state.offerRelays.some(Boolean)) {
      if (localSelfId < peerId) {
        return
      }
      resetOfferState(state)
    }

    if (atPendingCap(peerId)) {
      prunePeerStates(peerStates)
      return
    }

    const answerPeer = initPeerFn(false, config)
    const replay: AnswerReplayState = {
      offer,
      offerId,
      messages: [],
      lastSentAt: [],
      relays: []
    }
    replay.lastSentAt[relayId] = Date.now()
    state.answeringPeer = answerPeer
    state.didSendAnswer = false
    state.answerReplay = replay
    state.didReportConnectFailure = false
    scheduleAnsweringExpiry(state, peerId, answerPeer)

    const onClosedOrError = (): void => {
      if (
        state.answeringPeer === answerPeer &&
        !state.connectedPeer &&
        state.didSendAnswer
      ) {
        reportSdpFailure(state, peerId)
      }
      clearAnswering(state, answerPeer)
      disconnectPeer(answerPeer, peerId)
      prunePeerStates(peerStates)
    }

    answerPeer.setHandlers({
      connect: () => connectPeer(answerPeer, peerId),
      close: onClosedOrError,
      error: onClosedOrError
    })

    if (answerPeer.isDead) {
      clearAnswering(state, answerPeer)
      prunePeerStates(peerStates)
      return
    }

    const peerTopic = await peerTopicOf(peerId)
    if (isLeaving() || state.answerReplay !== replay) {
      return
    }

    replay.relays[relayId] = message => {
      void signalPeer(peerTopic, message)
    }

    const pendingCandidates: Signal[] = []
    let didSendAnswer = false

    const publishAnswerSignal = (signal: Signal): void => {
      void toCipher(signal, localSelfId, offerId)
        .then(enc => {
          if (
            isLeaving() ||
            state.answeringPeer !== answerPeer ||
            answerPeer.isDead
          ) {
            return
          }
          const isAnswer = signal.type === 'answer'
          if (isAnswer) {
            state.didSendAnswer = true
          }
          const message = toJson({
            peerId: localSelfId,
            offerId,
            ...(isAnswer ? {answer: enc.sdp} : {candidate: enc.sdp})
          })
          const now = Date.now()
          replay.messages.push(message)
          replay.relays.forEach((send, id) => {
            if (send) {
              replay.lastSentAt[id] = now
              send(message)
            }
          })
          if (isAnswer && !didSendAnswer) {
            didSendAnswer = true
            pendingCandidates.splice(0).forEach(publishAnswerSignal)
          }
        })
        .catch(noOp)
    }

    answerPeer.setHandlers({
      signal: signal => {
        if (
          isLeaving() ||
          state.answeringPeer !== answerPeer ||
          answerPeer.isDead ||
          (signal.type !== 'answer' && signal.type !== candidateType)
        ) {
          return
        }
        if (signal.type === candidateType && !didSendAnswer) {
          pendingCandidates.push(signal)
        } else {
          publishAnswerSignal(signal)
        }
      }
    })

    await answerPeer.signal(plainOffer)
  }

  const handleCandidate = async (
    peerId: string,
    candidate: string,
    offerId: string | undefined,
    peer: PeerHandle | undefined
  ): Promise<void> => {
    if (!offerId) {
      return
    }
    const state = peerStates.get(peerId)
    if (!peer && !state?.offerPeer && !state?.answeringPeer) {
      return
    }

    let plainCandidate: Signal
    try {
      plainCandidate = await toPlain(
        {type: candidateType, sdp: candidate},
        peerId,
        offerId
      )
    } catch {
      return
    }

    const currentState = peerStates.get(peerId)
    const targetPeer =
      peer && !peer.isDead
        ? peer
        : currentState?.offerPeer && currentState.offerId === offerId
          ? currentState.offerPeer
          : currentState?.answerReplay?.offerId === offerId
            ? currentState.answeringPeer
            : null

    if (targetPeer && !targetPeer.isDead) {
      void targetPeer.signal(plainCandidate)
    }
  }

  const handleAnswer = async (
    peerId: string,
    answer: string,
    offerId: string | undefined,
    peer: PeerHandle | undefined
  ): Promise<void> => {
    if (!offerId) {
      return
    }
    if (shouldConnectPeer && !shouldConnectPeer(peerId, 'outbound')) {
      if (peer) {
        reclaimLeasedOffer(peer)
        destroyAlive(peer)
      }
      return
    }
    const localSelfId = getSelfIdNow() ?? (await getSelfId())
    let plainAnswer: Signal
    try {
      plainAnswer = await toPlain(
        {type: 'answer', sdp: answer},
        peerId,
        offerId
      )
    } catch (err) {
      if (peer) {
        reclaimLeasedOffer(peer)
        destroyAlive(peer)
      }
      reportDecryptErr(peerId, 'answer', err)
      return
    }

    if (peer) {
      const state = getState(peerStates, peerId)
      claimLeasedOffer(peer)

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
        clearAnswering(state, state.answeringPeer)
      }

      resetOfferState(state)
      state.offerPeer = peer
      state.offerId = offerId
      state.offerAnswered = true
      scheduleOfferExpiry(state, peerId, offerPostAnswerTtlMs)
      bindOfferPeerHandlers(state, peerId, peer)
      void peer.signal(plainAnswer)
      return
    }

    const state = peerStates.get(peerId)
    if (
      !state ||
      !state.offerPeer ||
      state.offerAnswered ||
      !state.offerId ||
      offerId !== state.offerId ||
      state.offerPeer.isDead
    ) {
      return
    }

    state.offerAnswered = true
    scheduleOfferExpiry(state, peerId, offerPostAnswerTtlMs)
    void state.offerPeer.signal(plainAnswer)
  }

  const sendDirectPing = (
    peerId: string,
    localSelfId: string,
    state: PeerState,
    signalPeer: SignalPeer
  ): Promise<void> =>
    peerTopicOf(peerId).then(peerSelfTopic => {
      if (
        !isLeaving() &&
        !state.connectedPeer &&
        !state.answeringPeer &&
        !state.offerAnswered
      ) {
        void signalPeer(peerSelfTopic, toJson({peerId: localSelfId}))
      }
    })

  return {
    handleMessage:
      (relayId: number) =>
      async (
        topic: string,
        msg: unknown,
        signalPeer: SignalPeer
      ): Promise<void> => {
        try {
          if (isLeaving()) {
            return
          }
          relaySignalPeers[relayId] = signalPeer
          const parsed = parseSignalEnvelope(msg)
          if (!parsed) {
            return
          }
          const [peerId, offer, answer, candidate, offerId, peer] = parsed
          const knownSelfId = getSelfIdNow()
          if (!peerId || (knownSelfId && peerId === knownSelfId)) {
            return
          }

          const [rootTopic, selfTopic, localSelfId] = await all([
            rootTopicP,
            selfTopicP,
            getSelfId()
          ])
          if (
            peerId === localSelfId ||
            isLeaving() ||
            (topic !== rootTopic && topic !== selfTopic)
          ) {
            return
          }

          onPeerDiscovered?.(peerId, relayId, signalPeer)

          const state = peerStates.get(peerId)
          const connectedPeer = state?.connectedPeer
          if (connectedPeer && state) {
            const health = getConnectedPeerHealth(connectedPeer)
            if (health === 'live') {
              state.unhealthySince = null
              return
            }
            if (health === 'stale') {
              clearConnectedPeer(state)
            } else {
              const nowMs = Date.now()
              if (
                nowMs - (state.unhealthySince ??= nowMs) <
                disconnectedPeerGraceMs
              ) {
                return
              }
              clearConnectedPeer(state)
            }
          }

          if (!offer && !answer && !candidate) {
            if (
              (shouldConnectPeer && !shouldConnectPeer(peerId, 'outbound')) ||
              (!peerStates.has(peerId) && atPendingCap(peerId))
            ) {
              return
            }

            const announceState = getState(peerStates, peerId)
            if (
              announceState.answeringPeer ||
              announceState.connectedPeer ||
              announceState.offerAnswered
            ) {
              return
            }

            if (localSelfId >= peerId && !announceState.offerPeer) {
              let lastSentByRelay = counterAnnounceTimestamps.get(announceState)
              if (!lastSentByRelay) {
                lastSentByRelay = []
                counterAnnounceTimestamps.set(announceState, lastSentByRelay)
              }
              const lastSentAt = lastSentByRelay[relayId]
              if (lastSentAt !== undefined && Date.now() - lastSentAt < 1_000) {
                return
              }
              lastSentByRelay[relayId] = Date.now()
              await sendDirectPing(
                peerId,
                localSelfId,
                announceState,
                signalPeer
              )
              return
            }

            if (!announceState.offerRelays[relayId]) {
              announceState.offerRelays[relayId] = offerRelayPlaceholder
              await handleAnnouncement(relayId, peerId, signalPeer)
            }
            return
          }

          if (offer) {
            await handleOffer(relayId, peerId, offer, offerId, signalPeer)
            return
          }
          if (candidate) {
            await handleCandidate(peerId, candidate, offerId, peer)
            return
          }
          if (answer) {
            await handleAnswer(peerId, answer, offerId, peer)
          }
        } catch (err) {
          if (!isLeaving()) {
            logErr('signal', err)
          }
        }
      },

    dialPeer: (peerId: string): void => {
      if (!isValidSignalPeerId(peerId)) {
        return
      }
      void getSelfId()
        .then(localSelfId => {
          if (
            isLeaving() ||
            !peerId ||
            peerId === localSelfId ||
            (shouldConnectPeer && !shouldConnectPeer(peerId, 'outbound')) ||
            (!peerStates.has(peerId) && atPendingCap(peerId))
          ) {
            return
          }
          const state = getState(peerStates, peerId)
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
          if (backoff && now < backoff[1]) {
            return
          }
          const attempts = (backoff?.[0] ?? 0) + 1
          dialBackoffByState.set(state, [
            attempts,
            now + Math.min(60_000, 2_000 * 2 ** (attempts - 1))
          ])
          relaySignalPeers.forEach((signalPeer, relayId) => {
            if (!signalPeer) {
              return
            }
            if (localSelfId < peerId) {
              if (!state.offerRelays[relayId]) {
                state.offerRelays[relayId] = offerRelayPlaceholder
                void handleAnnouncement(relayId, peerId, signalPeer).catch(
                  err => {
                    if (!isLeaving()) {
                      logErr('signal', err)
                    }
                  }
                )
              }
            } else {
              void sendDirectPing(peerId, localSelfId, state, signalPeer).catch(
                noOp
              )
            }
          })
        })
        .catch(err => {
          if (!isLeaving()) {
            logErr('signal', err)
          }
        })
    }
  }
}
