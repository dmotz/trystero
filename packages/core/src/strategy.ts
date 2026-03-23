import {decrypt, deriveRoomNamespace, encrypt, genKey, sha1} from './crypto'
import {OfferPool, offerTtl} from './offer-pool'
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
const announceWarmupIntervalsMs = [233, 533, 1_333] as const
const sharedPeerIdleMsDefault = 123_333

type RoomRegistration = {
  roomToken: string | null
  roomTokenPromise: Promise<string>
  attachSharedPeerToRoom: (peerId: string, shared: SharedPeerState) => void
}

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
  const roomRegistrations: Record<string, Record<string, RoomRegistration>> = {}
  const roomIdsByToken: Record<string, Record<string, string>> = {}
  const roomPresenceHandlerCleanups: Record<string, () => void> = {}
  const sharedPeers = new SharedPeerManager()

  const hasActiveRooms = (): boolean =>
    values(occupiedRooms).some(rooms => keys(rooms).length > 0)

  const getRoomRegistrations = (
    appId: string
  ): Record<string, RoomRegistration> => (roomRegistrations[appId] ??= {})

  const getRoomIdsByToken = (appId: string): Record<string, string> =>
    (roomIdsByToken[appId] ??= {})

  const advertiseRoomPresence = (
    shared: SharedPeerState,
    roomToken: string,
    isPresent: boolean
  ): void => {
    if (sharedPeers.getHealth(shared.peer) === 'live') {
      sharedPeers.sendRoomPresence(shared, roomToken, isPresent)
    }
  }

  const advertiseKnownRoomsToShared = (
    appId: string,
    shared: SharedPeerState
  ): void => {
    entries(roomRegistrations[appId] ?? {}).forEach(
      ([roomId, registration]) => {
        const {roomToken, roomTokenPromise} = registration

        if (roomToken) {
          advertiseRoomPresence(shared, roomToken, true)
          return
        }

        void roomTokenPromise.then(token => {
          if (roomRegistrations[appId]?.[roomId] !== registration) {
            return
          }

          if (registration.roomToken !== token) {
            return
          }

          if (
            sharedPeers.get(appId, shared.peerId) !== shared ||
            shared.isClosing
          ) {
            return
          }

          advertiseRoomPresence(shared, token, true)
        })
      }
    )
  }

  const advertiseRoomPresenceToAll = (
    appId: string,
    roomToken: string,
    isPresent: boolean
  ): void =>
    values(sharedPeers.getMap(appId)).forEach(shared =>
      advertiseRoomPresence(shared, roomToken, isPresent)
    )

  const ensureRoomPresenceHandler = (appId: string): void => {
    if (roomPresenceHandlerCleanups[appId]) {
      return
    }

    roomPresenceHandlerCleanups[appId] = sharedPeers.setRoomPresenceHandler(
      appId,
      (peerId, roomToken, isPresent) => {
        if (!isPresent) {
          return
        }

        const shared = sharedPeers.get(appId, peerId)
        const roomId = roomIdsByToken[appId]?.[roomToken]

        if (!shared || !roomId) {
          return
        }

        roomRegistrations[appId]?.[roomId]?.attachSharedPeerToRoom(
          peerId,
          shared
        )
      }
    )
  }

  const cleanupRoomPresenceHandler = (appId: string): void => {
    if (occupiedRooms[appId] && keys(occupiedRooms[appId]).length > 0) {
      return
    }

    roomPresenceHandlerCleanups[appId]?.()
    delete roomPresenceHandlerCleanups[appId]
    delete roomRegistrations[appId]
    delete roomIdsByToken[appId]
  }

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

    ensureRoomPresenceHandler(appId)

    const rootTopicPlaintext = topicPath(libName, appId, roomId)
    const rootTopicP = sha1(rootTopicPlaintext)
    const selfTopicP = sha1(topicPath(rootTopicPlaintext, selfId))
    const key = genKey(config.password ?? '', appId, roomId)
    const roomNamespacePromise = deriveRoomNamespace(appId, roomId)
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
        Date.now() - peer.created > offerTtl
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

      const {proxy, isNew} = sharedPeers.bind(
        roomId,
        roomNamespacePromise,
        shared,
        {
          onDetach: () => {
            const current = ctx.peerStates[peerId]

            if (current?.connectedPeer === shared.peer) {
              current.connectedPeer = null
              current.connectedPeerUnhealthySinceMs = null
              updateStatus(current)
            }
          }
        }
      )

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

      const isNewShared = !shared

      shared ||= sharedPeers.register(appId, peerId, peer, sharedPeerIdleMs)

      DEV: log('peer connected:', peerId, _relayId)

      attachSharedPeerToRoom(peerId, shared)

      if (isNewShared) {
        advertiseKnownRoomsToShared(appId, shared)
      }
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

    const appRoomRegistrations = getRoomRegistrations(appId)
    const joinedRoom = room(
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

        const registration = roomRegistrations[appId]?.[roomId]

        if (registration?.roomToken) {
          advertiseRoomPresenceToAll(appId, registration.roomToken, false)
          delete roomIdsByToken[appId]?.[registration.roomToken]

          if (roomIdsByToken[appId] && !keys(roomIdsByToken[appId]).length) {
            delete roomIdsByToken[appId]
          }
        }

        if (roomRegistrations[appId]) {
          delete roomRegistrations[appId][roomId]

          if (!keys(roomRegistrations[appId]).length) {
            delete roomRegistrations[appId]
          }
        }

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
        cleanupRoomPresenceHandler(appId)
      },
      roomOptions
    )

    const roomRegistration: RoomRegistration = {
      roomToken: null,
      roomTokenPromise: roomNamespacePromise,
      attachSharedPeerToRoom
    }

    appRoomRegistrations[roomId] = roomRegistration

    void roomNamespacePromise.then(roomToken => {
      if (
        didLeaveRoom ||
        roomRegistrations[appId]?.[roomId] !== roomRegistration
      ) {
        return
      }

      roomRegistration.roomToken = roomToken
      getRoomIdsByToken(appId)[roomToken] = roomId

      values(sharedPeerMap).forEach(shared => {
        if (shared.remoteRoomTokens.has(roomToken)) {
          attachSharedPeerToRoom(shared.peerId, shared)
        }
      })

      advertiseRoomPresenceToAll(appId, roomToken, true)
    })

    return (occupiedRooms[appId][roomId] = joinedRoom)
  }
}
