import {hashTopic} from './crypto'
import {resolveSelfId} from './identity'
import type {
  OfferRecord,
  PeerState,
  SignalContext,
  SignalPeer
} from './internal-types'
import type {OfferCheckoutFn} from './offer-manager'
import type {BaseRoomConfig, PeerHandle, RoomError, Signal} from './types'
import {
  all,
  candidateType,
  entries,
  fromJson,
  genId,
  hasIceUrl,
  isObj,
  keys,
  log,
  mkErr,
  noOp,
  resetTimer,
  toJson,
  topicPath
} from './utils'

const signalKeys = ['offer', 'answer', 'candidate'] as const
export const maxSignalMessageChars: number = 128 * 1024
export const maxSignalPeerIdChars = 64
export const maxSignalOfferIdChars = 64
export const maxSignalSdpChars: number = 64 * 1024
export const maxSignalCandidateChars = 4_096
export const maxTrackedSignalPeers = 256
export const maxPendingPeerConnections = 64
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
  isValidSignalId(value, maxSignalPeerIdChars)

export const isValidSignalOfferId = (value: unknown): value is string =>
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
  const isStr = typeof msg === 'string'
  const hasSignalContent = signalKeys.some(k => k in payload)
  if (
    ('peerId' in payload && !isValidSignalPeerId(payload['peerId'])) ||
    ((hasSignalContent || payload['offerId'] !== undefined) &&
      !isValidSignalOfferId(payload['offerId'])) ||
    ('passive' in payload &&
      payload['passive'] !== undefined &&
      typeof payload['passive'] !== 'boolean') ||
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
      (isStr ||
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
  entries(peerStates).forEach(([peerId, s]) => {
    if (
      !s.connectedPeer &&
      !s.answeringPeer &&
      !s.offerInitPromise &&
      !s.offerPeer &&
      !s.offerRelays.some(Boolean)
    ) {
      delete peerStates[peerId]
    }
  })

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
  state.x = resetTimer(state.x)
  state.answeringPeer = null
  state.d = false
  state.a = null
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
  state.u = null
}

export const detachConnectedPeer = (
  state: PeerState | undefined,
  physical: PeerHandle
): void => {
  if (state?.connectedPeer === physical) {
    state.connectedPeer = null
    state.u = null
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
  destroyAlive(state.connectedPeer)
  state.connectedPeer = null
  state.u = null
}

const clearOfferRelay = (state: PeerState, relayId: number): void => {
  state.t[relayId] = resetTimer(state.t[relayId])
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
  state.e = resetTimer(state.e)
  state.offerInitPromise = null
  state.offerRelays.forEach((_, relayId) => clearOfferRelay(state, relayId))
  state.offerRelays = []
  state.r = []
  state.t = []
  state.b = []
  if (state.offerPeer !== state.connectedPeer) {
    destroyAlive(state.offerPeer)
  }
  state.offerPeer = null
  state.offerId = null
  state.s = null
  state.o = false
  state.f = false
}

export const getState = (
  peerStates: Record<string, PeerState>,
  peerId: string
): PeerState => {
  const existing = peerStates[peerId]
  if (existing) {
    return existing
  }
  const stateKeys = keys(peerStates)
  if (stateKeys.length >= maxTrackedSignalPeers) {
    const evictKey =
      stateKeys.find(k => {
        const s = peerStates[k]
        return s && !s.connectedPeer && !s.answeringPeer && !s.offerPeer
      }) ??
      stateKeys.find(k => {
        const s = peerStates[k]
        return s && !s.connectedPeer
      })
    if (evictKey) {
      const evicted = peerStates[evictKey]
      if (evicted) {
        destroyAlive(evicted.answeringPeer)
        resetOfferState(evicted)
        resetAnsweringState(evicted)
      }
      delete peerStates[evictKey]
    }
  }
  return (peerStates[peerId] = {
    offerPeer: null,
    offerId: null,
    offerInitPromise: null,
    offerRelays: [],
    connectedPeer: null,
    answeringPeer: null,
    s: null,
    o: false,
    r: [],
    b: [],
    t: [],
    e: null,
    u: null,
    x: null,
    d: false,
    a: null,
    f: false
  })
}

export const initSignalHandler = (
  appId: string,
  getRoomId: () => string,
  config: BaseRoomConfig,
  peerStates: Record<string, PeerState>,
  getRootTopicPlaintext: () => string,
  rootTopicP: Promise<string>,
  selfTopicP: Promise<string>,
  toPlain: (signal: Signal, peerId: string, offerId: string) => Promise<Signal>,
  toCipher: (
    signal: Signal,
    peerId: string,
    offerId: string
  ) => Promise<Signal>,
  isLeaving: () => boolean,
  onError: ((error: RoomError) => void) | undefined,
  checkoutOffers: OfferCheckoutFn,
  claimLeasedOffer: (peer: PeerHandle) => void,
  reclaimLeasedOffer: (peer: PeerHandle) => void,
  encryptOffer: (
    peer: PeerHandle,
    peerId: string,
    offerId: string
  ) => Promise<string>,
  initPeerFn: (initiator: boolean, config: BaseRoomConfig) => PeerHandle,
  connectPeer: (peer: PeerHandle, peerId: string) => void,
  disconnectPeer: (peer: PeerHandle, peerId: string) => void,
  announceIntervals: number[],
  announceIntervalMs: number,
  getSelfIdNow: () => string | undefined,
  selfIdP: Promise<string> | undefined,
  onPeerDiscovered?: (
    peerId: string,
    relayId: number,
    signalPeer: SignalPeer
  ) => void,
  shouldConnectPeer?: (
    peerId: string,
    direction: 'outbound' | 'inbound'
  ) => boolean
): readonly [
  handleMessage: (
    relayId: number
  ) => (topic: string, msg: unknown, signalPeer: SignalPeer) => Promise<void>,
  dialPeer: (peerId: string) => void
] => {
  const relaySignalPeers: Array<SignalPeer | undefined> = []

  const getSelfId = (): Promise<string> => {
    const cur = getSelfIdNow()
    return (
      selfIdP ?? (cur ? Promise.resolve(cur) : resolveSelfId(undefined, appId))
    )
  }

  const peerTopicOf = (peerId: string): Promise<string> =>
    hashTopic(topicPath(getRootTopicPlaintext(), peerId))

  const atPendingCap = (peerId: string): boolean =>
    countPendingPeerConnections(peerStates, peerId) >= maxPendingPeerConnections

  const reportSdpFailure = (state: PeerState, peerId: string): void => {
    if (isLeaving() || state.connectedPeer || state.f) {
      return
    }
    state.f = true
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
  ): void =>
    onError?.({
      code: 'decrypt-failed',
      peerId,
      stage,
      message: `incorrect password decrypting ${stage}`,
      appId,
      roomId: getRoomId(),
      cause
    })

  const scheduleAnsweringExpiry = (
    state: PeerState,
    peerId: string,
    peer: PeerHandle
  ): void => {
    resetTimer(state.x)
    state.x = setTimeout(() => {
      const current = peerStates[peerId]
      if (!current || current.connectedPeer || current.answeringPeer !== peer) {
        return
      }
      DEV: log('answering timed out for', peerId, '- retrying on next offer')
      if (current.d) {
        reportSdpFailure(current, peerId)
      }
      clearAnswering(current, peer)
      prunePeerStates(peerStates)
    }, answeringTtlMs)
  }

  const scheduleOfferExpiry = (
    state: PeerState,
    peerId: string,
    ttlMs = offerTtl
  ): void => {
    resetTimer(state.e)
    const offerId = state.offerId
    state.e = setTimeout(() => {
      const current = peerStates[peerId]
      if (!current || current.connectedPeer || current.offerId !== offerId) {
        return
      }
      DEV: log('offer expired for', peerId, '- resetting')
      if (current.o) {
        reportSdpFailure(current, peerId)
      }
      resetOfferState(current)
      prunePeerStates(peerStates)
    }, ttlMs)
  }

  const bindOfferPeerHandlers = (
    state: PeerState,
    peerId: string,
    peer: PeerHandle,
    onSignal?: (signal: Signal) => void
  ): void => {
    const onClosedOrError = (): void => {
      if (state.offerPeer === peer && !state.connectedPeer) {
        if (state.o) {
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
    if (state.offerPeer && state.offerId && state.s) {
      return Promise.resolve([state.offerPeer, state.s, state.offerId])
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
      state.s = offer
      state.o = false
      state.f = false
      state.b = []

      bindOfferPeerHandlers(state, peerId, peer, signal => {
        if (state.offerPeer === peer) {
          state.b.push(signal)
          state.r.forEach(sendSignal => sendSignal?.(signal))
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
    const state = peerStates[peerId]
    if (!state || state.connectedPeer || state.answeringPeer || state.o) {
      clearOfferRelayIfPlaceholder(state, relayId)
      return
    }
    if (state.offerRelays[relayId] !== offerRelayPlaceholder) {
      return
    }

    const [peerTopic, offerInfo, localSelfId] = await all([
      peerTopicOf(peerId),
      ensureOffer(state, peerId),
      getSelfId()
    ])

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
      state.o ||
      state.offerRelays[relayId] !== offerRelayPlaceholder
    ) {
      clearOfferRelayIfPlaceholder(state, relayId)
      return
    }

    const [offerPeer, offerSdp, offerId] = offerInfo
    state.t[relayId] = resetTimer(state.t[relayId])
    state.offerRelays[relayId] = true

    state.t[relayId] = setTimeout(
      () => {
        if (
          retryAttempt >= 2 ||
          isLeaving() ||
          state.connectedPeer ||
          state.answeringPeer ||
          state.o ||
          state.offerPeer !== offerPeer ||
          state.offerId !== offerId
        ) {
          const cur = peerStates[peerId]
          if (cur && !cur.connectedPeer && cur.offerRelays[relayId]) {
            clearOfferRelay(cur, relayId)
            prunePeerStates(peerStates)
          }
          return
        }
        state.offerRelays[relayId] = offerRelayPlaceholder
        void handleAnnouncement(relayId, peerId, signalPeer, retryAttempt + 1)
      },
      retryAttempt === 0 && announceIntervals[relayId] === undefined
        ? 2_000
        : (announceIntervals[relayId] ?? announceIntervalMs) * 0.9
    )

    let didSendOffer = false
    state.r[relayId] = signal => {
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

    DEV: log('sending offer to', peerId)
    void signalPeer(
      peerTopic,
      toJson({peerId: localSelfId, offerId, offer: offerSdp})
    )
    didSendOffer = true
    state.b.forEach(signal => state.r[relayId]?.(signal))
  }

  const replayExistingAnswerIfMatch = async (
    state: PeerState,
    relayId: number,
    peerId: string,
    offer: string,
    offerId: string,
    signalPeer: SignalPeer
  ): Promise<void> => {
    const replay = state.a
    const lastSentAt = replay?.[3][relayId]
    if (
      state.answeringPeer &&
      !state.answeringPeer.isDead &&
      replay &&
      replay[0] === offer &&
      replay[1] === offerId &&
      (lastSentAt === undefined || Date.now() - lastSentAt >= 1_000)
    ) {
      replay[3][relayId] = Date.now()
      const peerTopic = await peerTopicOf(peerId)
      if (!isLeaving() && state.a === replay && !state.connectedPeer) {
        const send = (message: string): void => {
          void signalPeer(peerTopic, message)
        }
        replay[4][relayId] = send
        replay[2].forEach(send)
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

    const existingState = peerStates[peerId]
    if (existingState && (existingState.answeringPeer || existingState.o)) {
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
    if (state.answeringPeer || state.o) {
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
    const replay: NonNullable<PeerState['a']> = [offer, offerId, [], [], []]
    replay[3][relayId] = Date.now()
    state.answeringPeer = answerPeer
    state.d = false
    state.a = replay
    state.f = false
    scheduleAnsweringExpiry(state, peerId, answerPeer)

    const onClosedOrError = (): void => {
      if (
        state.answeringPeer === answerPeer &&
        !state.connectedPeer &&
        state.d
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

    DEV: log('got offer from', peerId)
    const peerTopic = await peerTopicOf(peerId)
    if (isLeaving() || state.a !== replay) {
      return
    }

    replay[4][relayId] = message => {
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
            state.d = true
          }
          const message = toJson({
            peerId: localSelfId,
            offerId,
            ...(isAnswer ? {answer: enc.sdp} : {candidate: enc.sdp})
          })
          const now = Date.now()
          replay[2].push(message)
          replay[4].forEach((send, id) => {
            if (send) {
              replay[3][id] = now
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

    DEV: log('sending answer to', peerId)
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
    const state = peerStates[peerId]
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

    const currentState = peerStates[peerId]
    const targetPeer =
      peer && !peer.isDead
        ? peer
        : currentState?.offerPeer && currentState.offerId === offerId
          ? currentState.offerPeer
          : currentState?.a?.[1] === offerId
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

    DEV: log('got answer from', peerId)

    if (peer) {
      const state = getState(peerStates, peerId)
      claimLeasedOffer(peer)

      if (
        state.connectedPeer ||
        state.o ||
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
      state.o = true
      scheduleOfferExpiry(state, peerId, offerPostAnswerTtlMs)
      bindOfferPeerHandlers(state, peerId, peer)
      void peer.signal(plainAnswer)
      return
    }

    const state = peerStates[peerId]
    if (
      !state ||
      !state.offerPeer ||
      state.o ||
      !state.offerId ||
      offerId !== state.offerId ||
      state.offerPeer.isDead
    ) {
      return
    }

    DEV: log('signaling offer-peer with answer for', peerId)
    state.o = true
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
        !state.o
      ) {
        void signalPeer(peerSelfTopic, toJson({peerId: localSelfId}))
      }
    })

  return [
    (relayId: number) =>
      async (
        topic: string,
        msg: unknown,
        signalPeer: SignalPeer
      ): Promise<void> => {
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

        const state = peerStates[peerId]
        const connectedPeer = state?.connectedPeer
        if (connectedPeer && state) {
          const health = getConnectedPeerHealth(connectedPeer)
          if (health === 'live') {
            state.u = null
            return
          }
          if (health === 'stale') {
            clearConnectedPeer(state, peerId, 'message-from-stale-peer')
          } else {
            const nowMs = Date.now()
            if (nowMs - (state.u ??= nowMs) < disconnectedPeerGraceMs) {
              DEV: log(
                'connected peer transiently unhealthy, suppressing signal:',
                peerId
              )
              return
            }
            clearConnectedPeer(
              state,
              peerId,
              'message-from-prolonged-disconnect'
            )
          }
        }

        if (!offer && !answer && !candidate) {
          if (
            (shouldConnectPeer && !shouldConnectPeer(peerId, 'outbound')) ||
            (!peerStates[peerId] && atPendingCap(peerId))
          ) {
            return
          }

          const announceState = getState(peerStates, peerId)
          if (
            announceState.answeringPeer ||
            announceState.connectedPeer ||
            announceState.o
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
            await sendDirectPing(peerId, localSelfId, announceState, signalPeer)
            return
          }

          if (!announceState.offerRelays[relayId]) {
            announceState.offerRelays[relayId] = offerRelayPlaceholder
            return handleAnnouncement(relayId, peerId, signalPeer)
          }
          return
        }

        if (offer) {
          return handleOffer(relayId, peerId, offer, offerId, signalPeer)
        }
        if (candidate) {
          return handleCandidate(peerId, candidate, offerId, peer)
        }
        if (answer) {
          return handleAnswer(peerId, answer, offerId, peer)
        }
      },

    (peerId: string): void => {
      if (!isValidSignalPeerId(peerId)) {
        return
      }
      void getSelfId().then(localSelfId => {
        if (
          isLeaving() ||
          !peerId ||
          peerId === localSelfId ||
          (!peerStates[peerId] && atPendingCap(peerId))
        ) {
          return
        }
        const state = getState(peerStates, peerId)
        if (
          state.connectedPeer ||
          state.answeringPeer ||
          state.o ||
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
              void handleAnnouncement(relayId, peerId, signalPeer)
            }
          } else {
            void sendDirectPing(peerId, localSelfId, state, signalPeer)
          }
        })
      })
    }
  ]
}

export const createSignalHandler = (
  ctx: SignalContext
): {
  handleMessage: ReturnType<typeof initSignalHandler>[0]
  dialPeer: ReturnType<typeof initSignalHandler>[1]
} => {
  const [handleMessage, dialPeer] = initSignalHandler(
    ctx.appId,
    () => ctx.roomId,
    ctx.config,
    ctx.peerStates,
    () => ctx.rootTopicPlaintext,
    ctx.rootTopicP,
    ctx.selfTopicP,
    (s, p, o) => ctx.toPlain(s, p, o),
    (s, p, o) => ctx.toCipher(s, p, o),
    () => ctx.isLeaving(),
    err => ctx.onError?.(err),
    (n, lease, enc, size) => ctx.offerManager.checkout(n, lease, enc, size),
    p => ctx.offerManager.claimLeased(p),
    p => ctx.offerManager.reclaimLeased(p),
    (p, id, oid) => ctx.encryptOffer(p, id, oid),
    (init, cfg) => ctx.initPeer(init, cfg),
    (p, id) => ctx.connectPeer(p, id),
    (p, id) => ctx.disconnectPeer(p, id),
    ctx.announceIntervals,
    ctx.announceIntervalMs,
    () => ctx.selfId,
    ctx.selfIdP,
    (id, r, sp) => ctx.onPeerDiscovered?.(id, r, sp),
    (id, dir) => ctx.shouldConnectPeer?.(id, dir) ?? true
  )
  return {handleMessage, dialPeer}
}
