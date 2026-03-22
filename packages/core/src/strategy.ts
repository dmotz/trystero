import {decrypt, encrypt, genKey, sha1} from './crypto'
import {OfferPool, offerRefreshAgeMs} from './offer-pool'
import {createPasswordHandshake} from './handshake'
import initPeer from './peer'
import room from './room'
import {SharedPeerManager} from './shared-peer'
import {
  createSignalHandler,
  clearConnectedPeer,
  getState,
  resetOfferState,
  updateStatus
} from './signal-handler'
import {
  all,
  entries,
  keys,
  libName,
  log,
  mkErr,
  noOp,
  resetTimer,
  selfId,
  topicPath,
  values,
  watchOnline
} from './utils'
import type {
  BaseRoomConfig,
  JoinRoom,
  JoinRoomCallbacks,
  JoinRoomConfig,
  PeerHandle,
  RelayConfig,
  SharedPeerState,
  Signal,
  SignalContext,
  StrategyAdapter
} from './types'

const announceIntervalMs = 5_333
const announceWarmupIntervalsMs = [233, 533, 1_033] as const
const sharedPeerIdleMsDefault = 120_333

export default <
  TRelay,
  TConfig extends BaseRoomConfig & RelayConfig = JoinRoomConfig
>({
  init,
  subscribe,
  announce
}: StrategyAdapter<TRelay, TConfig>): JoinRoom<TConfig> => {
  const occupiedRooms: Record<
    string,
    Record<string, ReturnType<typeof room>>
  > = {}
  const sharedPeers = new SharedPeerManager()

  const hasActiveRooms = (): boolean =>
    values(occupiedRooms).some(rooms => keys(rooms).length > 0)

  let didInit = false
  let initPromises: Promise<TRelay>[] = []
  let offerPool: OfferPool | null = null
  let cleanupWatchOnline: () => void = noOp

  return (config: TConfig, roomId: string, callbacks?: JoinRoomCallbacks) => {
    if (!config) {
      throw mkErr('requires a config map as the first argument')
    }

    if (callbacks && typeof callbacks !== 'object') {
      throw mkErr('third argument must be a callbacks object')
    }

    const {appId} = config
    const onJoinError = callbacks?.onJoinError
    const onPeerHandshake = callbacks?.onPeerHandshake
    const handshakeTimeoutMs = callbacks?.handshakeTimeoutMs

    if (!appId) {
      throw mkErr('config map is missing appId field')
    }

    if (!roomId) {
      throw mkErr('roomId argument required')
    }

    if (
      handshakeTimeoutMs !== undefined &&
      (!Number.isFinite(handshakeTimeoutMs) || handshakeTimeoutMs <= 0)
    ) {
      throw mkErr('handshakeTimeoutMs must be a positive number')
    }

    if (occupiedRooms[appId]?.[roomId]) {
      return occupiedRooms[appId][roomId]
    }

    const rootTopicPlaintext = topicPath(libName, appId, roomId)
    const rootTopicP = sha1(rootTopicPlaintext)
    const selfTopicP = sha1(topicPath(rootTopicPlaintext, selfId))
    const key = genKey(config.password ?? '', appId, roomId)
    const sharedPeerIdleMs =
      config._test_only_sharedPeerIdleMs ?? sharedPeerIdleMsDefault

    let didLeaveRoom = false

    const withKey =
      (f: (keyP: Promise<CryptoKey>, text: string) => Promise<string>) =>
      async (signal: Signal): Promise<Signal> => ({
        type: signal.type,
        sdp: await f(key, signal.sdp)
      })

    const toPlain = withKey(decrypt)
    const toCipher = withKey(encrypt)
    const sharedPeerMap = sharedPeers.getMap(appId)
    const makeOffer = (): PeerHandle => initPeer(true, config)

    offerPool ||= new OfferPool(makeOffer)

    const pool = offerPool

    const encryptOffer = async (peer: PeerHandle): Promise<string> => {
      const plainOffer = await peer.getOffer(
        Date.now() - peer.created > offerRefreshAgeMs
      )

      if (!plainOffer || plainOffer.type !== 'offer') {
        throw mkErr('failed to get offer for peer')
      }

      return (await toCipher(plainOffer)).sdp
    }

    const attachSharedPeerToRoom = (
      peerId: string,
      shared: SharedPeerState
    ): void => {
      const state = getState(ctx.peerStates, peerId)

      state.answeringExpiryTimer = resetTimer(state.answeringExpiryTimer)
      state.answeringPeer = null

      const {proxy, isNew} = sharedPeers.bind(appId, roomId, peerId, shared, {
        onDetach: () => {
          const current = ctx.peerStates[peerId]

          if (current?.connectedPeer === shared.peer) {
            current.connectedPeer = null
            current.connectedPeerUnhealthySinceMs = null
            updateStatus(current)
          }
        }
      })

      state.connectedPeer = shared.peer
      state.connectedPeerUnhealthySinceMs = null
      updateStatus(state)

      if (isNew) {
        onPeerConnect(proxy, peerId)
      }

      resetOfferState(state, pool)
    }

    const connectPeer = (
      peer: PeerHandle,
      peerId: string,
      _relayId: number
    ): void => {
      if (didLeaveRoom) {
        peer.destroy()
        return
      }

      const state = getState(ctx.peerStates, peerId)

      if (state.connectedPeer) {
        DEV: log('already connected to', peerId, '- checking shared state')
        const shared = sharedPeerMap[peerId]

        if (
          shared &&
          state.connectedPeer === shared.peer &&
          shared.bindings[roomId]
        ) {
          return
        }

        if (state.connectedPeer !== peer && !peer.isDead) {
          peer.destroy()
        }
        return
      }

      let shared = sharedPeerMap[peerId]

      if (shared && sharedPeers.getHealth(shared.peer) === 'stale') {
        sharedPeers.clear(appId, peerId, {destroyPeer: true})
        shared = undefined
      }

      if (shared && shared.peer !== peer) {
        if (!peer.isDead) {
          peer.destroy()
        }

        DEV: log('reusing existing shared peer for', peerId)
        attachSharedPeerToRoom(peerId, shared)
        return
      }

      shared ||= sharedPeers.register(appId, peerId, peer, sharedPeerIdleMs)

      DEV: log('peer connected:', peerId, _relayId)

      attachSharedPeerToRoom(peerId, shared)
    }

    const disconnectPeer = (peer: PeerHandle, peerId: string): void => {
      if (didLeaveRoom) {
        return
      }

      const state = ctx.peerStates[peerId]

      if (state?.connectedPeer === peer) {
        DEV: log('peer disconnected:', peerId)
        clearConnectedPeer(state, peerId, 'close-event')
      }
    }

    const ctx: SignalContext = {
      appId,
      roomId,
      config,
      peerStates: {},
      rootTopicPlaintext,
      rootTopicP,
      selfTopicP,
      toPlain,
      toCipher,
      isLeaving: () => didLeaveRoom,
      onJoinError,
      sharedPeers,
      offerPool: pool,
      encryptOffer,
      initPeer,
      connectPeer,
      disconnectPeer,
      attachSharedPeerToRoom,
      announceIntervals: [],
      announceIntervalMs
    }

    const handleMessage = createSignalHandler(ctx)

    if (!didInit) {
      const initRes = init(config)
      pool.warmup()
      initPromises = (Array.isArray(initRes) ? initRes : [initRes]).map(value =>
        Promise.resolve(value)
      )
      didInit = true
      cleanupWatchOnline = config.manualRelayReconnection ? noOp : watchOnline()
    }

    ctx.announceIntervals = initPromises.map(() => announceIntervalMs)
    const announceAttemptCounts = initPromises.map(() => 0)
    const announceTimeouts: Array<ReturnType<typeof setTimeout> | undefined> =
      []

    const unsubFns = initPromises.map(async (relayP, i) =>
      subscribe(
        await relayP,
        await rootTopicP,
        await selfTopicP,
        handleMessage(i),
        n => pool.getOffers(n, encryptOffer)
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
          ctx.announceIntervals[i] = ms
        }

        const announceAttempt = announceAttemptCounts[i] ?? 0
        announceAttemptCounts[i] = announceAttempt + 1
        const currentInterval = ctx.announceIntervals[i] ?? announceIntervalMs
        const warmupDelay = announceWarmupIntervalsMs[announceAttempt]
        const nextAnnounceDelayMs =
          typeof warmupDelay === 'number'
            ? Math.min(currentInterval, warmupDelay)
            : currentInterval

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
    const sharedPassword = config.password ?? ''
    const {compose} = createPasswordHandshake(sharedPassword, appId, roomId)
    const composedPeerHandshake = compose(onPeerHandshake)

    const roomOptions = {
      ...(composedPeerHandshake
        ? {onPeerHandshake: composedPeerHandshake}
        : {}),
      ...(handshakeTimeoutMs === undefined ? {} : {handshakeTimeoutMs}),
      onHandshakeError: (peerId: string, error: string) =>
        onJoinError?.({
          error: error.replace(/^handshake failed: /, ''),
          appId,
          peerId,
          roomId
        })
    }

    occupiedRooms[appId] ??= {}

    return (occupiedRooms[appId][roomId] = room(
      f => (onPeerConnect = f),
      id => {
        if (didLeaveRoom) {
          return
        }

        const state = ctx.peerStates[id]

        if (state?.connectedPeer) {
          state.connectedPeer = null
          updateStatus(state)
        }
      },
      () => {
        didLeaveRoom = true
        onPeerConnect = noOp

        entries(ctx.peerStates).forEach(([peerId, state]) => {
          state.answeringExpiryTimer = resetTimer(state.answeringExpiryTimer)

          if (state.connectedPeer && !state.connectedPeer.isDead) {
            const shared = sharedPeerMap[peerId]

            if (!shared || shared.peer !== state.connectedPeer) {
              state.connectedPeer.destroy()
            }
          }

          if (state.answeringPeer && !state.answeringPeer.isDead) {
            state.answeringPeer.destroy()
          }

          resetOfferState(state, pool)
          state.connectedPeer = null
          state.answeringPeer = null
          updateStatus(state)
        })

        if (occupiedRooms[appId]) {
          delete occupiedRooms[appId][roomId]

          if (keys(occupiedRooms[appId]).length === 0) {
            delete occupiedRooms[appId]
          }
        }

        announceTimeouts.forEach(resetTimer)
        unsubFns.forEach(async f => {
          const cleanup = await f
          cleanup()
        })

        if (hasActiveRooms()) {
          return
        }

        didInit = false
        pool.destroy()
        offerPool = null
        cleanupWatchOnline()
      },
      roomOptions
    ))
  }
}
