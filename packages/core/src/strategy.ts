import {decrypt, encrypt, genKey, sha1} from './crypto.js'
import initPeer from './peer.js'
import room from './room.js'
import {
  all,
  alloc,
  fromJson,
  genId,
  libName,
  mkErr,
  noOp,
  selfId,
  toJson,
  topicPath,
  watchOnline
} from './utils.js'
import type {
  BaseRoomConfig,
  JoinRoom,
  JoinRoomConfig,
  OfferRecord,
  PeerHandle,
  Signal,
  StrategyAdapter
} from './types.js'

const poolSize = 20
const announceIntervalMs = 5_333
const announceWarmupIntervalsMs = [233, 533, 1_033] as const
const offerTtl = 57_333
const offerPostAnswerTtlMs = 9_000
const offerIdSize = 12
const disconnectedPeerGraceMs = 7_500
const answeringTtlMs = 8_000

type PeerState = {
  status: 'idle' | 'offering' | 'answering' | 'connected'
  offerPeer: PeerHandle | null
  offerId: string | null
  offerSdp: string | null
  offerInitPromise: Promise<{
    peer: PeerHandle
    offer: string
    offerId: string
  }> | null
  offerAnswered: boolean
  offerRelays: unknown[]
  offerRelayTimers: Array<ReturnType<typeof setTimeout> | undefined>
  offerExpiryTimer: ReturnType<typeof setTimeout> | null
  connectedPeer: PeerHandle | null
  connectedPeerUnhealthySinceMs: number | null
  answeringExpiryTimer: ReturnType<typeof setTimeout> | null
  answeringPeer: PeerHandle | null
}

export default <TRelay, TConfig extends BaseRoomConfig = JoinRoomConfig>({
  init,
  subscribe,
  announce
}: StrategyAdapter<TRelay, TConfig>): JoinRoom<TConfig> => {
  const occupiedRooms: Record<
    string,
    Record<string, ReturnType<typeof room>>
  > = {}

  let didInit = false
  let initPromises: Promise<TRelay>[] = []
  let offerPool: PeerHandle[] = []
  let offerCleanupTimer: ReturnType<typeof setInterval> | null = null
  let cleanupWatchOnline: () => void = noOp
  const hasActiveRooms = (): boolean =>
    Object.values(occupiedRooms).some(rooms => Object.keys(rooms).length > 0)

  return (config: TConfig, roomId: string, onJoinError) => {
    const debugLog = (...args: unknown[]): void => console.log(...args)
    const {appId} = config

    if (occupiedRooms[appId]?.[roomId]) {
      return occupiedRooms[appId][roomId]
    }

    const peerStates: Record<string, PeerState> = {}
    let didLeaveRoom = false
    const OFFER_PLACEHOLDER = Symbol('offer-placeholder')
    const rootTopicPlaintext = topicPath(libName, appId, roomId)
    const rootTopicP = sha1(rootTopicPlaintext)
    const selfTopicP = sha1(topicPath(rootTopicPlaintext, selfId))
    const key = genKey(config.password ?? '', appId, roomId)

    const withKey =
      (f: (keyP: Promise<CryptoKey>, text: string) => Promise<string>) =>
      async (signal: Signal): Promise<Signal> => ({
        type: signal.type,
        sdp: await f(key, signal.sdp)
      })

    const toPlain = withKey(decrypt)
    const toCipher = withKey(encrypt)

    const makeOffer = (): PeerHandle => initPeer(true, config)

    const makeState = (): PeerState => ({
      status: 'idle',
      offerPeer: null,
      offerId: null,
      offerSdp: null,
      offerInitPromise: null,
      offerAnswered: false,
      offerRelays: [],
      offerRelayTimers: [],
      offerExpiryTimer: null,
      connectedPeer: null,
      connectedPeerUnhealthySinceMs: null,
      answeringExpiryTimer: null,
      answeringPeer: null
    })

    const getState = (peerId: string): PeerState =>
      (peerStates[peerId] ??= makeState())

    const updateStatus = (state: PeerState): void => {
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
        if (state.answeringExpiryTimer) {
          clearTimeout(state.answeringExpiryTimer)
          state.answeringExpiryTimer = null
        }

        state.answeringPeer = null
        updateStatus(state)
      }
    }

    const scheduleAnsweringExpiry = (
      state: PeerState,
      peerId: string,
      peer: PeerHandle
    ): void => {
      if (state.answeringExpiryTimer) {
        clearTimeout(state.answeringExpiryTimer)
      }

      state.answeringExpiryTimer = setTimeout(() => {
        const current = peerStates[peerId]

        if (
          !current ||
          current.connectedPeer ||
          current.answeringPeer !== peer
        ) {
          return
        }

        DEV: debugLog(
          'answering timed out for',
          peerId,
          '- retrying on next offer'
        )
        peer.destroy()
        clearAnswering(current, peer)
      }, answeringTtlMs)
    }

    const clearOfferRelay = (state: PeerState, relayId: number): void => {
      if (state.offerRelayTimers[relayId]) {
        clearTimeout(state.offerRelayTimers[relayId])
        state.offerRelayTimers[relayId] = undefined
      }

      if (state.offerRelays[relayId]) {
        state.offerRelays[relayId] = undefined
        updateStatus(state)
      }
    }

    const resetOfferState = (state: PeerState): void => {
      if (state.offerExpiryTimer) {
        clearTimeout(state.offerExpiryTimer)
        state.offerExpiryTimer = null
      }

      state.offerInitPromise = null
      state.offerAnswered = false
      state.offerRelays.forEach((_, relayId) => clearOfferRelay(state, relayId))
      state.offerRelays = []
      state.offerRelayTimers = []

      if (state.offerPeer && state.offerPeer !== state.connectedPeer) {
        state.offerPeer.destroy()
      }

      state.offerPeer = null
      state.offerId = null
      state.offerSdp = null
      updateStatus(state)
    }

    const scheduleOfferExpiry = (
      state: PeerState,
      peerId: string,
      ttlMs = offerTtl
    ): void => {
      if (state.offerExpiryTimer) {
        clearTimeout(state.offerExpiryTimer)
      }

      const offerId = state.offerId

      state.offerExpiryTimer = setTimeout(() => {
        const current = peerStates[peerId]

        if (!current || current.connectedPeer || current.offerId !== offerId) {
          return
        }

        DEV: debugLog('offer expired for', peerId, '- resetting')
        resetOfferState(current)
      }, ttlMs)
    }

    const getOffers = (n: number): Promise<OfferRecord[]> => {
      offerPool.push(...alloc(n, makeOffer))

      return all(
        offerPool
          .splice(0, n)
          .map(peer =>
            peer.offerPromise
              .then(offer => toCipher(offer as Signal))
              .then(offer => ({peer, offer: offer.sdp}))
          )
      )
    }

    const ensureOffer = (
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
        const firstOffer = (await getOffers(1))[0]

        if (!firstOffer) {
          throw mkErr('failed to allocate offer peer')
        }

        const {peer, offer} = firstOffer

        state.offerPeer = peer
        state.offerId = genId(offerIdSize)
        state.offerSdp = offer
        state.offerAnswered = false
        updateStatus(state)

        peer.setHandlers({
          connect: () => connectPeer(peer, peerId, relayId),
          close: () => {
            if (state.offerPeer === peer && !state.connectedPeer) {
              resetOfferState(state)
            }

            disconnectPeer(peer, peerId)
          },
          error: () => {
            if (state.offerPeer === peer && !state.connectedPeer) {
              resetOfferState(state)
            }

            disconnectPeer(peer, peerId)
          }
        })

        scheduleOfferExpiry(state, peerId)

        return {peer, offer, offerId: state.offerId}
      })().finally(() => {
        state.offerInitPromise = null
      })

      return state.offerInitPromise
    }

    const connectPeer = (
      peer: PeerHandle,
      peerId: string,
      relayId: number
    ): void => {
      if (didLeaveRoom) {
        peer.destroy()
        return
      }

      const state = getState(peerId)

      if (state.connectedPeer) {
        DEV: debugLog('already connected to', peerId, '- destroying duplicate')

        if (state.connectedPeer !== peer) {
          peer.destroy()
        }

        return
      }

      DEV: debugLog('peer connected:', peerId, relayId)
      state.connectedPeer = peer
      state.connectedPeerUnhealthySinceMs = null
      if (state.answeringExpiryTimer) {
        clearTimeout(state.answeringExpiryTimer)
        state.answeringExpiryTimer = null
      }
      state.answeringPeer = null
      onPeerConnect(peer, peerId)
      resetOfferState(state)
    }

    const getConnectedPeerHealth = (
      peer: PeerHandle
    ): 'live' | 'transient' | 'stale' => {
      const {connection, channel} = peer
      const isStale =
        peer.isDead ||
        connection.connectionState === 'closed' ||
        connection.connectionState === 'failed' ||
        connection.iceConnectionState === 'closed' ||
        connection.iceConnectionState === 'failed' ||
        channel?.readyState === 'closing' ||
        channel?.readyState === 'closed'

      if (isStale) {
        return 'stale'
      }

      const isTransientlyUnhealthy = !channel || channel.readyState !== 'open'

      if (isTransientlyUnhealthy) {
        return 'transient'
      }

      return 'live'
    }

    const clearConnectedPeer = (
      state: PeerState,
      peerId: string,
      reason: string
    ): void => {
      if (!state.connectedPeer) {
        return
      }

      DEV: debugLog('clearing stale connected peer:', peerId, reason)

      if (!state.connectedPeer.isDead) {
        state.connectedPeer.destroy()
      }

      state.connectedPeer = null
      state.connectedPeerUnhealthySinceMs = null
      updateStatus(state)
    }

    const disconnectPeer = (peer: PeerHandle, peerId: string): void => {
      if (didLeaveRoom) {
        return
      }

      const state = peerStates[peerId]

      if (state?.connectedPeer === peer) {
        DEV: debugLog('peer disconnected:', peerId)
        clearConnectedPeer(state, peerId, 'close-event')
      }
    }

    const prunePendingOffer = (peerId: string, relayId: number): void => {
      const state = peerStates[peerId]

      if (!state || state.connectedPeer) {
        return
      }

      if (state.offerRelays[relayId]) {
        clearOfferRelay(state, relayId)
      }
    }

    const handleJoinError = (peerId: string, sdpType: string): void => {
      onJoinError?.({
        error: `incorrect password (${config.password}) when decrypting ${sdpType}`,
        appId,
        peerId,
        roomId
      })
    }

    const handleMessage =
      (relayId: number) =>
      async (
        topic: string,
        msg: unknown,
        signalPeer: (peerTopic: string, signal: string) => void
      ): Promise<void> => {
        if (didLeaveRoom) {
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
        const offerId = payload['offerId'] as string | undefined
        const peer = payload['peer'] as PeerHandle | undefined

        if (peerId === selfId) {
          return
        }

        const state = peerStates[peerId]
        const connectedPeer = state?.connectedPeer

        if (connectedPeer && state) {
          const health = getConnectedPeerHealth(connectedPeer)

          if (health === 'live') {
            state.connectedPeerUnhealthySinceMs = null
            DEV: debugLog('ignoring message from connected peer:', peerId)
            return
          }

          if (health === 'stale') {
            clearConnectedPeer(state, peerId, 'message-from-stale-peer')
          } else {
            const nowMs = Date.now()
            const unhealthySinceMs =
              state.connectedPeerUnhealthySinceMs ?? nowMs
            state.connectedPeerUnhealthySinceMs = unhealthySinceMs

            if (nowMs - unhealthySinceMs < disconnectedPeerGraceMs) {
              DEV: debugLog(
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

        const isAnnouncement = Boolean(peerId && !offer && !answer)

        if (isAnnouncement) {
          const state = getState(peerId)
          const shouldLeadOffer = selfId < peerId

          if (
            state.answeringPeer ||
            state.connectedPeer ||
            state.offerAnswered
          ) {
            return
          }

          // Deterministic leader election avoids dual-offer glare.
          // Lower peer IDs lead with offers; higher IDs wait to answer.
          if (!shouldLeadOffer && !state.offerPeer) {
            return
          }

          if (state.offerRelays[relayId]) {
            return
          }

          state.offerRelays[relayId] = OFFER_PLACEHOLDER
          updateStatus(state)
        }

        const [rootTopic, selfTopic] = await all([rootTopicP, selfTopicP])

        if (didLeaveRoom) {
          return
        }

        if (topic !== rootTopic && topic !== selfTopic) {
          if (
            isAnnouncement &&
            peerStates[peerId]?.offerRelays[relayId] === OFFER_PLACEHOLDER
          ) {
            clearOfferRelay(peerStates[peerId], relayId)
          }

          return
        }

        if (isAnnouncement) {
          const state = peerStates[peerId]

          if (
            !state ||
            state.connectedPeer ||
            state.answeringPeer ||
            state.offerAnswered
          ) {
            if (state?.offerRelays[relayId] === OFFER_PLACEHOLDER) {
              clearOfferRelay(state, relayId)
            }

            return
          }

          if (state.offerRelays[relayId] !== OFFER_PLACEHOLDER) {
            return
          }

          const [peerTopic, offerInfo] = await all([
            sha1(topicPath(rootTopicPlaintext, peerId)),
            ensureOffer(state, peerId, relayId)
          ])

          if (didLeaveRoom) {
            return
          }

          if (
            state.connectedPeer ||
            state.answeringPeer ||
            state.offerAnswered ||
            state.offerRelays[relayId] !== OFFER_PLACEHOLDER
          ) {
            if (state.offerRelays[relayId] === OFFER_PLACEHOLDER) {
              clearOfferRelay(state, relayId)
            }

            return
          }

          if (state.offerRelayTimers[relayId]) {
            clearTimeout(state.offerRelayTimers[relayId])
            state.offerRelayTimers[relayId] = undefined
          }

          state.offerRelays[relayId] = true
          updateStatus(state)

          state.offerRelayTimers[relayId] = setTimeout(
            () => prunePendingOffer(peerId, relayId),
            (announceIntervals[relayId] ?? announceIntervalMs) * 0.9
          )

          DEV: debugLog('sending offer to', peerId)

          signalPeer(
            peerTopic,
            toJson({
              peerId: selfId,
              offerId: offerInfo.offerId,
              offer: offerInfo.offer
            })
          )
        } else if (offer) {
          const state = getState(peerId)

          if (state.answeringPeer || state.offerAnswered) {
            return
          }

          const hasOutgoingOffer = Boolean(
            state.offerPeer || state.offerRelays.some(Boolean)
          )

          // Deterministic glare tie-break:
          // lower ID keeps outgoing offer; higher ID backs off and answers.
          if (hasOutgoingOffer && selfId < peerId) {
            return
          }

          if (hasOutgoingOffer) {
            resetOfferState(state)
          }

          const answerPeer = initPeer(false, config)
          state.answeringPeer = answerPeer
          scheduleAnsweringExpiry(state, peerId, answerPeer)
          updateStatus(state)

          answerPeer.setHandlers({
            connect: () => connectPeer(answerPeer, peerId, relayId),
            close: () => {
              clearAnswering(state, answerPeer)
              disconnectPeer(answerPeer, peerId)
            },
            error: () => {
              clearAnswering(state, answerPeer)
              disconnectPeer(answerPeer, peerId)
            }
          })

          let plainOffer: Signal

          try {
            plainOffer = await toPlain({type: 'offer', sdp: offer})
          } catch {
            clearAnswering(state, answerPeer)
            handleJoinError(peerId, 'offer')
            return
          }

          if (answerPeer.isDead) {
            clearAnswering(state, answerPeer)
            return
          }

          DEV: debugLog('got offer from', peerId)

          const [peerTopic, answerSignal] = await all([
            sha1(topicPath(rootTopicPlaintext, peerId)),
            answerPeer.signal(plainOffer)
          ])

          if (didLeaveRoom) {
            return
          }

          DEV: debugLog('sending answer to', peerId)

          if (!answerSignal) {
            return
          }

          const payloadToSend: Record<string, unknown> = {
            peerId: selfId,
            answer: (await toCipher(answerSignal)).sdp
          }

          if (offerId) {
            payloadToSend['offerId'] = offerId
          }

          signalPeer(peerTopic, toJson(payloadToSend))
        } else if (answer) {
          let plainAnswer: Signal

          try {
            plainAnswer = await toPlain({type: 'answer', sdp: answer})
          } catch {
            handleJoinError(peerId, 'answer')
            return
          }

          DEV: debugLog('got answer from', peerId)

          if (peer) {
            peer.setHandlers({
              connect: () => connectPeer(peer, peerId, relayId),
              close: () => disconnectPeer(peer, peerId)
            })

            void peer.signal(plainAnswer)
          } else {
            const state = peerStates[peerId]

            if (
              !state ||
              !state.offerPeer ||
              state.offerAnswered ||
              (offerId && state.offerId && offerId !== state.offerId) ||
              state.offerPeer.isDead
            ) {
              DEV: debugLog(
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

            DEV: debugLog('signaling offer-peer with answer for', peerId)
            state.offerAnswered = true
            scheduleOfferExpiry(state, peerId, offerPostAnswerTtlMs)
            void state.offerPeer.signal(plainAnswer)
          }
        }
      }

    if (!config) {
      throw mkErr('requires a config map as the first argument')
    }

    if (!appId) {
      throw mkErr('config map is missing appId field')
    }

    if (!roomId) {
      throw mkErr('roomId argument required')
    }

    if (!didInit) {
      const initRes = init(config)
      offerPool = alloc(poolSize, makeOffer)
      initPromises = (Array.isArray(initRes) ? initRes : [initRes]).map(value =>
        Promise.resolve(value)
      )
      didInit = true
      offerCleanupTimer = setInterval(
        () =>
          (offerPool = offerPool.filter(peer => {
            const shouldLive = Date.now() - peer.created < offerTtl

            if (!shouldLive) {
              peer.destroy()
            }

            return shouldLive
          })),
        offerTtl * 1.03
      )
      cleanupWatchOnline = config.manualRelayReconnection ? noOp : watchOnline()
    }

    const announceIntervals = initPromises.map(() => announceIntervalMs)
    const announceAttemptCounts = initPromises.map(() => 0)
    const announceTimeouts: Array<ReturnType<typeof setTimeout> | undefined> =
      []

    const unsubFns = initPromises.map(async (relayP, i) =>
      subscribe(
        await relayP,
        await rootTopicP,
        await selfTopicP,
        handleMessage(i),
        getOffers
      )
    )

    void all([rootTopicP, selfTopicP]).then(([rootTopic, selfTopic]) => {
      if (didLeaveRoom) {
        return
      }

      const queueAnnounce = async (relay: TRelay, i: number): Promise<void> => {
        if (didLeaveRoom) {
          return
        }

        const ms = await announce(relay, rootTopic, selfTopic)

        if (didLeaveRoom) {
          return
        }

        if (typeof ms === 'number') {
          announceIntervals[i] = ms
        }

        const announceAttempt = announceAttemptCounts[i] ?? 0
        announceAttemptCounts[i] = announceAttempt + 1
        const announceInterval = announceIntervals[i] ?? announceIntervalMs
        const warmupDelay = announceWarmupIntervalsMs[announceAttempt]
        const nextAnnounceDelayMs =
          typeof warmupDelay === 'number'
            ? Math.min(announceInterval, warmupDelay)
            : announceInterval

        announceTimeouts[i] = setTimeout(() => {
          void queueAnnounce(relay, i)
        }, nextAnnounceDelayMs)
      }

      unsubFns.forEach(async (didSub, i) => {
        await didSub

        if (didLeaveRoom) {
          return
        }

        const relay = await initPromises[i]

        if (relay && !didLeaveRoom) {
          void queueAnnounce(relay, i)
        }
      })
    })

    let onPeerConnect = noOp as (peer: PeerHandle, peerId: string) => void

    occupiedRooms[appId] ??= {}

    return (occupiedRooms[appId][roomId] = room(
      f => (onPeerConnect = f),
      id => {
        if (didLeaveRoom) {
          return
        }

        const state = peerStates[id]

        if (state?.connectedPeer) {
          state.connectedPeer = null
          updateStatus(state)
        }
      },
      () => {
        didLeaveRoom = true
        onPeerConnect = noOp

        Object.values(peerStates).forEach(state => {
          if (state.answeringExpiryTimer) {
            clearTimeout(state.answeringExpiryTimer)
            state.answeringExpiryTimer = null
          }

          if (state.connectedPeer && !state.connectedPeer.isDead) {
            state.connectedPeer.destroy()
          }

          if (state.answeringPeer && !state.answeringPeer.isDead) {
            state.answeringPeer.destroy()
          }

          resetOfferState(state)
          state.connectedPeer = null
          state.answeringPeer = null
          updateStatus(state)
        })

        if (occupiedRooms[appId]) {
          delete occupiedRooms[appId][roomId]

          if (Object.keys(occupiedRooms[appId]).length === 0) {
            delete occupiedRooms[appId]
          }
        }

        announceTimeouts.forEach(timeout => timeout && clearTimeout(timeout))
        unsubFns.forEach(async f => {
          const cleanup = await f
          cleanup()
        })

        if (hasActiveRooms()) {
          return
        }

        if (offerCleanupTimer) {
          clearInterval(offerCleanupTimer)
          offerCleanupTimer = null
        }

        cleanupWatchOnline()
        didInit = false
      }
    ))
  }
}
