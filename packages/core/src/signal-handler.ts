import {hashTopic} from './crypto'
import type {
  AnswerReplayState,
  BaseRoomConfig,
  OfferRecord,
  PeerHandle,
  PeerState,
  RelayOfferSlotState,
  Signal,
  SignalContext,
  SignalPeer,
  Timeout
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
  unreachable,
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

const isSlotAnnounceable = (slot: RelayOfferSlotState | undefined): boolean =>
  !slot || slot.phase === 'exhausted'

const hasCandidateSender = (
  slot: RelayOfferSlotState | undefined
): slot is Extract<RelayOfferSlotState, {phase: 'retrying' | 'exhausted'}> =>
  slot?.phase === 'retrying' || slot?.phase === 'exhausted'

const clearRelaySlots = (
  slots: Array<RelayOfferSlotState | undefined>
): void => {
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]
    if (slot?.phase === 'retrying') {
      resetTimer(slot.retryTimer)
    }
    slots[i] = undefined
  }
  slots.length = 0
}

const freezeRelayRetriesKeepSenders = (
  slots: Array<RelayOfferSlotState | undefined>
): void => {
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]
    if (!slot) {
      continue
    }
    switch (slot.phase) {
      case 'reserved':
        slots[i] = undefined
        break
      case 'retrying':
        resetTimer(slot.retryTimer)
        slots[i] = {phase: 'exhausted', sendCandidate: slot.sendCandidate}
        break
      case 'exhausted':
        break
      default:
        unreachable(slot)
    }
  }
}

const clearOfferRelaySlot = (state: PeerState, relayId: number): void => {
  const current = state.relaySlots[relayId]
  if (!current) {
    return
  }
  if (current.phase === 'retrying') {
    resetTimer(current.retryTimer)
  }
  state.relaySlots[relayId] = undefined
}

const clearOfferRelayIfReserved = (
  state: PeerState | undefined,
  relayId: number
): void => {
  if (state?.relaySlots[relayId]?.phase === 'reserved') {
    state.relaySlots[relayId] = undefined
  }
}

const hasLiveOutboundOffer = (
  state: PeerState,
  peer?: PeerHandle,
  offerId?: string
): state is PeerState & {
  outbound: Extract<PeerState['outbound'], {phase: 'advertising' | 'answered'}>
} =>
  (state.outbound.phase === 'advertising' ||
    state.outbound.phase === 'answered') &&
  (!peer || state.outbound.peer === peer) &&
  (offerId === undefined || state.outbound.offerId === offerId)

const hasOutboundActivity = (state: PeerState): boolean => {
  switch (state.outbound.phase) {
    case 'idle':
      return state.relaySlots.some(Boolean)
    case 'allocating':
    case 'advertising':
    case 'answered':
      return true
    default:
      return unreachable(state.outbound)
  }
}

const countPendingPeerConnections = (
  peerStates: Map<string, PeerState>,
  excludePeerId?: string
): number => {
  let count = 0
  for (const [id, s] of peerStates) {
    if (id === excludePeerId || s.connection.phase === 'connected') {
      continue
    }
    if (
      s.outbound.phase === 'allocating' ||
      (hasLiveOutboundOffer(s) && !s.outbound.peer.isDead)
    ) {
      count++
    }
    if (s.inbound.phase === 'answering' && !s.inbound.peer.isDead) {
      count++
    }
  }
  return count
}

const isPeerStateIdle = (s: PeerState): boolean =>
  s.connection.phase === 'disconnected' &&
  s.inbound.phase === 'idle' &&
  !hasOutboundActivity(s)

export const prunePeerStates = (peerStates: Map<string, PeerState>): void => {
  for (const [peerId, s] of peerStates) {
    if (isPeerStateIdle(s)) {
      peerStates.delete(peerId)
    }
  }
}

const counterAnnounceTimestamps = /*@__PURE__*/ new WeakMap<
  PeerState,
  Array<number | undefined>
>()

const destroyAlive = (peer: PeerHandle | null | undefined): void => {
  if (peer && !peer.isDead) {
    peer.destroy()
  }
}

export const resetAnsweringState = (state: PeerState): void => {
  counterAnnounceTimestamps.delete(state)
  if (state.inbound.phase === 'answering') {
    resetTimer(state.inbound.expiryTimer)
  }
  state.inbound = {phase: 'idle'}
}

const clearAnswering = (state: PeerState, peer: PeerHandle): void => {
  if (state.inbound.phase === 'answering' && state.inbound.peer === peer) {
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
  if (state.inbound.phase === 'answering' && state.inbound.peer !== physical) {
    destroyAlive(state.inbound.peer)
  }
  resetAnsweringState(state)
  state.connection = {
    phase: 'connected',
    peer: physical,
    unhealthySince: null
  }
}

export const detachConnectedPeer = (
  state: PeerState | undefined,
  physical: PeerHandle
): void => {
  if (
    state?.connection.phase === 'connected' &&
    state.connection.peer === physical
  ) {
    state.connection = {phase: 'disconnected'}
  }
}

export const clearConnectedPeer = (state: PeerState): void => {
  if (state.connection.phase !== 'connected') {
    return
  }
  const {peer} = state.connection
  state.connection = {phase: 'disconnected'}
  destroyAlive(peer)
}

export const resetOfferState = (state: PeerState): void => {
  counterAnnounceTimestamps.delete(state)
  clearRelaySlots(state.relaySlots)
  switch (state.outbound.phase) {
    case 'idle':
    case 'allocating':
      break
    case 'advertising':
    case 'answered':
      resetTimer(state.outbound.expiryTimer)
      if (state.outbound.peer !== state.connectedPeer) {
        destroyAlive(state.outbound.peer)
      }
      break
    default:
      unreachable(state.outbound)
  }
  state.outbound = {phase: 'idle'}
  state.didReportFailure = false
}

export const createPeerState = (): PeerState => ({
  outbound: {phase: 'idle'},
  inbound: {phase: 'idle'},
  connection: {phase: 'disconnected'},
  relaySlots: [],
  didReportFailure: false,
  get offerPeer(): PeerHandle | null {
    return hasLiveOutboundOffer(this) ? this.outbound.peer : null
  },
  get answeringPeer(): PeerHandle | null {
    return this.inbound.phase === 'answering' ? this.inbound.peer : null
  },
  get connectedPeer(): PeerHandle | null {
    return this.connection.phase === 'connected' ? this.connection.peer : null
  }
})

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
      if (isPeerStateIdle(s)) {
        evictKey = k
        break
      }
      if (fallbackKey === undefined && s.connection.phase === 'disconnected') {
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
  const created = createPeerState()
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
  const dialBackoffs = createBoundedCache<
    string,
    [attempts: number, nextAllowedAt: number]
  >(512)
  const inFlightOfferDecrypts = new Map<string, Promise<Signal | null>>()

  const getSelfId = (): Promise<string> => selfIdP

  const peerTopicOf = (peerId: string): Promise<string> =>
    hashTopic(topicPath(getRootTopicPlaintext(), peerId))

  const atPendingCap = (peerId: string): boolean =>
    countPendingPeerConnections(peerStates, peerId) >= maxPendingPeerConnections

  const reportSdpFailure = (state: PeerState, peerId: string): void => {
    if (
      isLeaving() ||
      state.connection.phase === 'connected' ||
      state.didReportFailure
    ) {
      return
    }
    state.didReportFailure = true
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

  const createAnsweringExpiryTimer = (
    peerId: string,
    peer: PeerHandle
  ): Timeout => {
    const timer = setTimeout(() => {
      const current = peerStates.get(peerId)
      if (
        !current ||
        current.connection.phase === 'connected' ||
        current.inbound.phase !== 'answering' ||
        current.inbound.peer !== peer
      ) {
        return
      }
      if (current.inbound.didSendAnswer) {
        reportSdpFailure(current, peerId)
      }
      clearAnswering(current, peer)
      prunePeerStates(peerStates)
    }, answeringTtlMs)
    unrefTimer(timer)
    return timer
  }

  const createOfferExpiryTimer = (
    peerId: string,
    offerId: string,
    ttlMs = offerTtl
  ): Timeout => {
    const timer = setTimeout(() => {
      const current = peerStates.get(peerId)
      if (
        !current ||
        current.connection.phase === 'connected' ||
        !hasLiveOutboundOffer(current, undefined, offerId)
      ) {
        return
      }
      if (current.outbound.phase === 'answered') {
        reportSdpFailure(current, peerId)
      }
      resetOfferState(current)
      prunePeerStates(peerStates)
    }, ttlMs)
    unrefTimer(timer)
    return timer
  }

  const bindOfferPeerHandlers = (
    state: PeerState,
    peerId: string,
    peer: PeerHandle,
    onSignal?: (signal: Signal) => void
  ): void => {
    const onClosedOrError = (): void => {
      if (state.offerPeer === peer && state.connection.phase !== 'connected') {
        if (state.outbound.phase === 'answered') {
          reportSdpFailure(state, peerId)
        }
        resetOfferState(state)
      }
      disconnectPeer(peer, peerId)
      prunePeerStates(peerStates)
    }

    peer.setHandlers({
      connect: () => {
        dialBackoffs.delete(peerId)
        connectPeer(peer, peerId)
      },
      ...(onSignal ? {signal: onSignal} : {}),
      close: onClosedOrError,
      error: onClosedOrError
    })
  }

  const ensureOffer = (
    state: PeerState,
    peerId: string
  ): Promise<[peer: PeerHandle, offer: string, offerId: string] | null> => {
    switch (state.outbound.phase) {
      case 'advertising':
        return Promise.resolve([
          state.outbound.peer,
          state.outbound.offerSdp,
          state.outbound.offerId
        ])
      case 'allocating':
        return state.outbound.promise
      case 'answered':
        return Promise.resolve(null)
      case 'idle':
        break
      default:
        return unreachable(state.outbound)
    }

    if (atPendingCap(peerId)) {
      return Promise.resolve(null)
    }

    const isAllocCanceled = (): boolean =>
      isLeaving() ||
      state.outbound.phase !== 'allocating' ||
      state.outbound.promise !== pending

    const allocateOffer = async (): Promise<
      [peer: PeerHandle, offer: string, offerId: string] | null
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
        if (isAllocCanceled()) {
          return null
        }
        throw error
      }

      if (!firstOffer) {
        if (isAllocCanceled()) {
          return null
        }
        throw mkErr('failed to allocate offer peer')
      }

      const {peer, offer} = firstOffer
      const offerId = firstOffer.offerId || genId(offerIdSize)
      if (isAllocCanceled()) {
        peer.destroy()
        return null
      }

      const bufferedCandidates: Signal[] = []
      const expiryTimer = createOfferExpiryTimer(peerId, offerId)
      state.didReportFailure = false
      state.outbound = {
        phase: 'advertising',
        peer,
        offerId,
        offerSdp: offer,
        expiryTimer,
        bufferedCandidates
      }

      bindOfferPeerHandlers(state, peerId, peer, signal => {
        if (
          state.connection.phase !== 'connected' &&
          hasLiveOutboundOffer(state, peer, offerId)
        ) {
          state.outbound.bufferedCandidates.push(signal)
          for (const slot of state.relaySlots) {
            if (hasCandidateSender(slot)) {
              slot.sendCandidate(signal)
            }
          }
        }
      })
      return [peer, offer, offerId]
    }

    const pending = allocateOffer().finally(() => {
      if (
        state.outbound.phase === 'allocating' &&
        state.outbound.promise === pending
      ) {
        state.outbound = {phase: 'idle'}
      }
    })
    state.outbound = {phase: 'allocating', promise: pending}
    return pending
  }

  const transitionOutboundToAnswered = (
    state: PeerState,
    peerId: string,
    peer: PeerHandle,
    offerId: string
  ): void => {
    let bufferedCandidates: Signal[] = []
    if (hasLiveOutboundOffer(state)) {
      resetTimer(state.outbound.expiryTimer)
      if (state.outbound.peer === peer && state.outbound.offerId === offerId) {
        bufferedCandidates = state.outbound.bufferedCandidates
        freezeRelayRetriesKeepSenders(state.relaySlots)
      } else {
        clearRelaySlots(state.relaySlots)
        if (state.connectedPeer !== state.outbound.peer) {
          destroyAlive(state.outbound.peer)
        }
      }
    } else {
      clearRelaySlots(state.relaySlots)
    }
    state.outbound = {
      phase: 'answered',
      peer,
      offerId,
      expiryTimer: createOfferExpiryTimer(
        peerId,
        offerId,
        offerPostAnswerTtlMs
      ),
      bufferedCandidates
    }
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
      state.connection.phase === 'connected' ||
      state.inbound.phase !== 'idle' ||
      state.outbound.phase === 'answered'
    ) {
      clearOfferRelayIfReserved(state, relayId)
      return
    }
    if (state.relaySlots[relayId]?.phase !== 'reserved') {
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
      clearOfferRelayIfReserved(state, relayId)
      prunePeerStates(peerStates)
      throw err
    }

    if (!offerInfo) {
      clearOfferRelayIfReserved(state, relayId)
      return
    }
    if (isLeaving()) {
      resetOfferState(state)
      return
    }
    const isStateConnected = (s: PeerState): boolean =>
      s.connection.phase === 'connected'
    if (
      isStateConnected(state) ||
      state.inbound.phase !== 'idle' ||
      state.outbound.phase !== 'advertising' ||
      state.relaySlots[relayId]?.phase !== 'reserved'
    ) {
      clearOfferRelayIfReserved(state, relayId)
      return
    }

    const [offerPeer, offerSdp, offerId] = offerInfo
    const sendCandidate = (signal: Signal): void => {
      if (
        isLeaving() ||
        state.connection.phase === 'connected' ||
        !hasLiveOutboundOffer(state, offerPeer, offerId) ||
        signal.type !== candidateType
      ) {
        return
      }
      void toCipher(signal, localSelfId, offerId)
        .then(enc => {
          if (
            !isLeaving() &&
            state.connection.phase !== 'connected' &&
            hasLiveOutboundOffer(state, offerPeer, offerId)
          ) {
            void signalPeer(
              peerTopic,
              toJson({peerId: localSelfId, offerId, candidate: enc.sdp})
            )
          }
        })
        .catch(noOp)
    }

    const retryTimer = setTimeout(
      () => {
        if (
          retryAttempt >= 2 ||
          isLeaving() ||
          state.connection.phase === 'connected' ||
          state.inbound.phase !== 'idle' ||
          state.outbound.phase !== 'advertising' ||
          state.outbound.peer !== offerPeer ||
          state.outbound.offerId !== offerId
        ) {
          const cur = peerStates.get(peerId)
          if (cur && cur.connection.phase !== 'connected') {
            if (
              retryAttempt >= 2 &&
              hasLiveOutboundOffer(cur, offerPeer, offerId)
            ) {
              cur.relaySlots[relayId] = {
                phase: 'exhausted',
                sendCandidate
              }
            } else {
              clearOfferRelaySlot(cur, relayId)
            }
            prunePeerStates(peerStates)
          }
          return
        }
        state.relaySlots[relayId] = {phase: 'reserved'}
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

    void signalPeer(
      peerTopic,
      toJson({peerId: localSelfId, offerId, offer: offerSdp})
    )

    state.relaySlots[relayId] = {
      phase: 'retrying',
      retryTimer,
      sendCandidate
    }
    state.outbound.bufferedCandidates.forEach(sendCandidate)
  }

  const replayExistingAnswerIfMatch = async (
    state: PeerState,
    relayId: number,
    peerId: string,
    offer: string,
    offerId: string,
    signalPeer: SignalPeer
  ): Promise<void> => {
    if (
      state.inbound.phase !== 'answering' ||
      state.inbound.peer.isDead ||
      state.inbound.replay.offer !== offer ||
      state.inbound.replay.offerId !== offerId
    ) {
      return
    }
    const {replay} = state.inbound
    const lastSentAt = replay.lastSentAt[relayId]
    if (lastSentAt !== undefined && Date.now() - lastSentAt < 1_000) {
      return
    }
    replay.lastSentAt[relayId] = Date.now()
    const peerTopic = await peerTopicOf(peerId)
    if (
      !isLeaving() &&
      state.connection.phase !== 'connected' &&
      state.inbound.phase === 'answering' &&
      state.inbound.replay === replay
    ) {
      const send = (message: string): void => {
        void signalPeer(peerTopic, message)
      }
      replay.relays[relayId] = send
      replay.messages.forEach(send)
    }
  }

  const decryptOfferDeduped = (
    peerId: string,
    offer: string,
    offerId: string
  ): Promise<Signal | null> => {
    const key = `${peerId}|${offerId}|${offer}`
    const existing = inFlightOfferDecrypts.get(key)
    if (existing) {
      return existing
    }
    const task = toPlain({type: 'offer', sdp: offer}, peerId, offerId)
      .catch(err => {
        reportDecryptErr(peerId, 'offer', err)
        return null
      })
      .finally(() => {
        inFlightOfferDecrypts.delete(key)
      })
    inFlightOfferDecrypts.set(key, task)
    return task
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
      (existingState.inbound.phase === 'answering' ||
        existingState.outbound.phase === 'answered')
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
      hasOutboundActivity(existingState) &&
      localSelfId < peerId
    ) {
      return
    }

    if (atPendingCap(peerId)) {
      return
    }

    const plainOffer = await decryptOfferDeduped(peerId, offer, offerId)
    if (!plainOffer || isLeaving()) {
      return
    }

    const state = getState(peerStates, peerId)
    if (state.connection.phase === 'connected') {
      return
    }
    if (
      state.inbound.phase === 'answering' ||
      state.outbound.phase === 'answered'
    ) {
      return replayExistingAnswerIfMatch(
        state,
        relayId,
        peerId,
        offer,
        offerId,
        signalPeer
      )
    }

    if (hasOutboundActivity(state)) {
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
    const expiryTimer = createAnsweringExpiryTimer(peerId, answerPeer)
    let preAnswerCandidates: Signal[] | null = []
    state.didReportFailure = false
    state.inbound = {
      phase: 'answering',
      peer: answerPeer,
      offerId,
      expiryTimer,
      didSendAnswer: false,
      replay
    }

    const isActiveAnswering = (
      s: PeerState
    ): s is PeerState & {
      inbound: Extract<PeerState['inbound'], {phase: 'answering'}>
    } =>
      !isLeaving() &&
      s.inbound.phase === 'answering' &&
      s.inbound.peer === answerPeer &&
      !answerPeer.isDead

    const onClosedOrError = (): void => {
      if (
        state.inbound.phase === 'answering' &&
        state.inbound.peer === answerPeer &&
        state.connection.phase !== 'connected' &&
        state.inbound.didSendAnswer
      ) {
        reportSdpFailure(state, peerId)
      }
      clearAnswering(state, answerPeer)
      disconnectPeer(answerPeer, peerId)
      prunePeerStates(peerStates)
    }

    answerPeer.setHandlers({
      connect: () => {
        dialBackoffs.delete(peerId)
        connectPeer(answerPeer, peerId)
      },
      close: onClosedOrError,
      error: onClosedOrError
    })

    if (answerPeer.isDead) {
      clearAnswering(state, answerPeer)
      prunePeerStates(peerStates)
      return
    }

    const peerTopic = await peerTopicOf(peerId)
    if (!isActiveAnswering(state) || state.inbound.replay !== replay) {
      return
    }

    replay.relays[relayId] = message => {
      void signalPeer(peerTopic, message)
    }

    let publishQueue: Promise<void> = Promise.resolve()

    const enqueueEncryptedPublish = (signal: Signal): void => {
      publishQueue = publishQueue
        .then(async () => {
          const enc = await toCipher(signal, localSelfId, offerId)
          if (!isActiveAnswering(state)) {
            return
          }
          const isAnswer = signal.type === 'answer'
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
          if (isAnswer && preAnswerCandidates) {
            state.inbound.didSendAnswer = true
            const queued = preAnswerCandidates
            preAnswerCandidates = null
            queued.forEach(enqueueEncryptedPublish)
          }
        })
        .catch(noOp)
    }

    answerPeer.setHandlers({
      signal: signal => {
        if (
          !isActiveAnswering(state) ||
          (signal.type !== 'answer' && signal.type !== candidateType)
        ) {
          return
        }
        if (signal.type === candidateType && preAnswerCandidates) {
          preAnswerCandidates.push(signal)
        } else {
          enqueueEncryptedPublish(signal)
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
        : currentState && hasLiveOutboundOffer(currentState, undefined, offerId)
          ? currentState.outbound.peer
          : currentState?.inbound.phase === 'answering' &&
              currentState.inbound.offerId === offerId
            ? currentState.inbound.peer
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
    if (
      shouldConnectPeer &&
      !shouldConnectPeer(peerId, peer ? 'outbound' : 'inbound')
    ) {
      if (peer) {
        reclaimLeasedOffer(peer)
        destroyAlive(peer)
      } else {
        const currentState = peerStates.get(peerId)
        if (
          currentState &&
          hasLiveOutboundOffer(currentState, undefined, offerId)
        ) {
          resetOfferState(currentState)
        }
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
      if (!claimLeasedOffer(peer) || peer.isDead) {
        destroyAlive(peer)
        return
      }
      const state = getState(peerStates, peerId)

      if (
        state.connection.phase === 'connected' ||
        state.outbound.phase === 'answered' ||
        (state.inbound.phase === 'answering' &&
          !state.inbound.peer.isDead &&
          localSelfId > peerId)
      ) {
        peer.destroy()
        return
      }
      if (state.inbound.phase === 'answering') {
        clearAnswering(state, state.inbound.peer)
      }

      resetOfferState(state)
      transitionOutboundToAnswered(state, peerId, peer, offerId)
      bindOfferPeerHandlers(state, peerId, peer)
      void peer.signal(plainAnswer)
      return
    }

    const state = peerStates.get(peerId)
    if (
      !state ||
      state.outbound.phase !== 'advertising' ||
      state.outbound.offerId !== offerId ||
      state.outbound.peer.isDead
    ) {
      return
    }

    const offerPeer = state.outbound.peer
    transitionOutboundToAnswered(state, peerId, offerPeer, offerId)
    void offerPeer.signal(plainAnswer)
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
        state.connection.phase !== 'connected' &&
        state.inbound.phase === 'idle' &&
        state.outbound.phase !== 'answered'
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
          if (state?.connection.phase === 'connected') {
            const health = getConnectedPeerHealth(state.connection.peer)
            if (health === 'live') {
              state.connection.unhealthySince = null
              return
            }
            if (health === 'stale') {
              clearConnectedPeer(state)
            } else {
              const nowMs = Date.now()
              const since = (state.connection.unhealthySince ??= nowMs)
              if (nowMs - since < disconnectedPeerGraceMs) {
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
              announceState.inbound.phase !== 'idle' ||
              announceState.connection.phase === 'connected' ||
              announceState.outbound.phase === 'answered'
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

            if (isSlotAnnounceable(announceState.relaySlots[relayId])) {
              announceState.relaySlots[relayId] = {phase: 'reserved'}
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
            state.connection.phase === 'connected' ||
            state.inbound.phase !== 'idle' ||
            state.outbound.phase !== 'idle' ||
            !relaySignalPeers.some(Boolean)
          ) {
            return
          }
          const now = Date.now()
          const backoff = dialBackoffs.get(peerId)
          if (backoff && now < backoff[1]) {
            return
          }
          const attempts = (backoff?.[0] ?? 0) + 1
          dialBackoffs.set(peerId, [
            attempts,
            now + Math.min(60_000, 2_000 * 2 ** (attempts - 1))
          ])
          relaySignalPeers.forEach((signalPeer, relayId) => {
            if (!signalPeer) {
              return
            }
            if (localSelfId < peerId) {
              if (
                state.outbound.phase !== 'answered' &&
                isSlotAnnounceable(state.relaySlots[relayId])
              ) {
                state.relaySlots[relayId] = {phase: 'reserved'}
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
