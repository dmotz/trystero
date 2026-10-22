import {parseSelfCertifyingRoomId, resolveRoomAuthority} from './authority'
import {decrypt, deriveRoomNamespace, encrypt, genKey, sha1} from './crypto'
import {
  getOrCreateEndpointIdentitySync,
  registerTestForcedPeerId,
  resolveUserIdentity,
  validateIdentityConfig
} from './identity'
import {OfferManager} from './offer-manager'
import {createIdentityHandshake, createPasswordHandshake} from './handshake'
import initPeer from './peer'
import room, {getRoomSignalingBridge, type RoomSignalingBridge} from './room'
import {SharedPeerManager} from './shared-peer'
import {
  createSignalHandler,
  clearConnectedPeer,
  detachConnectedPeer,
  getState,
  markPeerConnected,
  resetAnsweringState,
  resetOfferState
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
  toErrorMessage,
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
  Signal,
  SignalContext,
  StrategyContext,
  StrategyAdapter
} from './types'

const announceIntervalMs = 5_333
const announceWarmupIntervalsMs = [233, 533, 1_333] as const
const passiveActivationGraceMs = 7_533
const sharedPeerIdleMsDefault = 123_333

export default <TRelay, TConfig extends BaseRoomConfig = JoinRoomConfig>({
  init,
  subscribe,
  announce,
  deactivate
}: StrategyAdapter<TRelay, TConfig>): JoinRoom<TConfig> => {
  const occupiedRooms: Record<
    string,
    Record<string, ReturnType<typeof room>>
  > = {}
  const leavingRoomCleanups: Record<
    string,
    Record<string, (rejoining?: boolean) => void>
  > = {}
  const sharedPeers = new SharedPeerManager()
  const hasActiveRooms = (): boolean =>
    values(occupiedRooms).some(rooms => keys(rooms).length > 0)

  let didInit = false
  let initPromises: Promise<TRelay>[] = []
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

    if (!appId) {
      throw mkErr('config map is missing appId field')
    }

    if (!roomId) {
      throw mkErr('roomId argument required')
    }

    if (
      config.maxReceiveBytes !== undefined &&
      (!Number.isSafeInteger(config.maxReceiveBytes) ||
        config.maxReceiveBytes <= 0)
    ) {
      throw mkErr('maxReceiveBytes must be a positive safe integer')
    }

    if (
      config.limit !== undefined &&
      (!Number.isSafeInteger(config.limit) || config.limit < 1)
    ) {
      throw mkErr('limit must be a positive safe integer')
    }

    validateIdentityConfig(config)

    const localSelfId =
      typeof config._test_only_forcedPeerId === 'string' &&
      config._test_only_forcedPeerId
        ? config._test_only_forcedPeerId
        : selfId
    if (
      typeof config._test_only_forcedPeerId === 'string' &&
      config._test_only_forcedPeerId
    ) {
      registerTestForcedPeerId(config._test_only_forcedPeerId)
    }
    const scopeAppId =
      typeof config._test_only_forcedPeerId === 'string' &&
      config._test_only_forcedPeerId
        ? `${appId}:${config._test_only_forcedPeerId}`
        : appId

    if (occupiedRooms[scopeAppId]?.[roomId]) {
      return occupiedRooms[scopeAppId][roomId]
    }

    leavingRoomCleanups[scopeAppId]?.[roomId]?.(true)

    const isAdminBacked =
      Boolean(config.admin) ||
      Boolean(parseSelfCertifyingRoomId(roomId).fingerprint)
    const resolvedAuthorityP = isAdminBacked
      ? resolveRoomAuthority(roomId, config.admin, appId)
      : undefined

    let effectiveRoomId = roomId
    let membershipRef: {rekey: (newRoomId: string) => void} | null = null
    const rootTopicPlaintext = topicPath(libName, appId, roomId)
    const effectiveRoomIdP = resolvedAuthorityP?.then(auth => {
      effectiveRoomId = auth.effectiveRoomId
      ctx.roomId = auth.effectiveRoomId
      ctx.rootTopicPlaintext = topicPath(libName, appId, auth.effectiveRoomId)
      strategyContext.roomId = auth.effectiveRoomId
      if (auth.effectiveRoomId !== roomId && !didLeaveRoom) {
        ;(occupiedRooms[scopeAppId] ??= {})[auth.effectiveRoomId] = joinedRoom
        membershipRef?.rekey(auth.effectiveRoomId)
      }
      return auth.effectiveRoomId
    })

    const rootTopicP = effectiveRoomIdP
      ? effectiveRoomIdP.then(rid => sha1(topicPath(libName, appId, rid)))
      : sha1(rootTopicPlaintext)
    const selfTopicP = effectiveRoomIdP
      ? effectiveRoomIdP.then(rid =>
          sha1(topicPath(topicPath(libName, appId, rid), localSelfId))
        )
      : sha1(topicPath(rootTopicPlaintext, localSelfId))
    const key = effectiveRoomIdP
      ? effectiveRoomIdP.then(rid => genKey(config.password ?? '', appId, rid))
      : genKey(config.password ?? '', appId, roomId)
    const roomNamespacePromise = effectiveRoomIdP
      ? effectiveRoomIdP.then(rid => deriveRoomNamespace(appId, rid))
      : deriveRoomNamespace(appId, roomId)
    const sharedPeerIdleMs =
      config._test_only_sharedPeerIdleMs ?? sharedPeerIdleMsDefault

    let didLeaveRoom = false
    let isLeavingRoom = false
    const bridgeRef: {current?: RoomSignalingBridge | undefined} = {}

    const syncOverlayNeighbors = (): void => {
      const overlay = bridgeRef.current?.overlay
      if (
        didLeaveRoom ||
        isPassive ||
        !overlay ||
        overlay.getSnapshot().activeMode === 'mesh'
      ) {
        return
      }
      for (const targetId of overlay.getTargetNeighbors()) {
        ctx.dialPeer?.(targetId)
      }
    }

    const withKey =
      (f: (keyP: Promise<CryptoKey>, text: string) => Promise<string>) =>
      async (signal: Signal): Promise<Signal> => ({
        type: signal.type,
        sdp: await f(key, signal.sdp)
      })

    const toPlain = withKey(decrypt)
    const toCipher = withKey(encrypt)
    const makeOffer = (): PeerHandle => initPeer(true, config)
    let reannounceOnDisconnect = false
    const offerManager = new OfferManager(makeOffer)

    const encryptOffer = async (peer: PeerHandle): Promise<string> => {
      const plainOffer = await peer.getOffer()

      if (!plainOffer || plainOffer.type !== 'offer') {
        throw mkErr('failed to get offer for peer')
      }

      return (await toCipher(plainOffer)).sdp
    }

    const connectPeer = (peer: PeerHandle, peerId: string): void => {
      membership.connect(peerId, peer, sharedPeerIdleMs)
    }

    let disconnectReannounceQueued = false
    const reannounceAfterDisconnect = (): void => {
      syncOverlayNeighbors()
      if (isPassive || !reannounceOnDisconnect || disconnectReannounceQueued) {
        return
      }
      // Several peers can close together. Start only one warmup per room.
      disconnectReannounceQueued = true
      queueMicrotask(() => {
        disconnectReannounceQueued = false
        if (!didLeaveRoom) {
          ctx.requeueAnnounce?.()
        }
      })
    }

    const disconnectPeer = (peer: PeerHandle, peerId: string): void => {
      if (didLeaveRoom) {
        return
      }

      const state = ctx.peerStates[peerId]

      if (state?.connectedPeer === peer) {
        DEV: log('peer disconnected:', peerId)
        clearConnectedPeer(state, peerId, 'close-event')
        checkDeactivate()

        reannounceAfterDisconnect()
      }
    }

    const isPassive = Boolean(config.passive)
    let passiveActivationTimeout:
      | ReturnType<typeof setTimeout>
      | null
      | undefined
    let deactivateRelayAnnouncements = noOp

    const checkDeactivate = (): void => {
      if (!isPassive || !ctx.isActive) {
        return
      }

      let hasActiveWork = false

      entries(ctx.peerStates).forEach(([peerId, state]) => {
        const isActive =
          state.connectedPeer ||
          state.answeringPeer ||
          state.offerInitPromise ||
          state.offerPeer ||
          state.offerRelays.some(Boolean)

        if (isActive) {
          hasActiveWork = true
        } else {
          delete ctx.peerStates[peerId]
        }
      })

      if (!hasActiveWork) {
        ctx.isActive = false
        passiveActivationTimeout = resetTimer(passiveActivationTimeout)
        announceTimeouts.forEach(resetTimer)
        announceTimeouts.length = 0
        deactivateRelayAnnouncements()

        membership.setActive(false)
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
      isLeaving: () => didLeaveRoom || isLeavingRoom,
      isPassive,
      isActive: !isPassive,
      onJoinError,
      offerManager,
      encryptOffer,
      initPeer,
      connectPeer,
      disconnectPeer,
      reusePeer: peerId => membership.reuse(peerId),
      checkDeactivate,
      announceIntervals: [],
      announceIntervalMs,
      selfId: localSelfId,
      onPeerDiscovered: (peerId, _relayId, _signalPeer, payload) => {
        const sigWait =
          payload && bridgeRef.current
            ? bridgeRef.current.onSignalingPayload(peerId, payload)
            : undefined
        if (sigWait) {
          return sigWait.then(() => {
            bridgeRef.current?.overlay.notePeerDiscovered(peerId)
            syncOverlayNeighbors()
          })
        }
        bridgeRef.current?.overlay.notePeerDiscovered(peerId)
        syncOverlayNeighbors()
        return undefined
      },
      shouldConnectPeer: (peerId, direction) =>
        bridgeRef.current
          ? bridgeRef.current.overlay.shouldConnectPeer(peerId, direction)
          : true
    }
    const strategyContext: StrategyContext<TConfig> = {
      config,
      appId,
      roomId,
      isPassive,
      peerId: localSelfId
    }

    const handleMessage = createSignalHandler(ctx)

    if (!didInit) {
      const initRes = init(config)
      initPromises = (Array.isArray(initRes) ? initRes : [initRes]).map(value =>
        Promise.resolve(value)
      )
      didInit = true
      cleanupWatchOnline = config.relayConfig?.manualReconnection
        ? noOp
        : watchOnline()
    }

    // Only explicit numeric relay pacing overrides the signaling retry default.
    const announceScheduleIntervals = initPromises.map(() => announceIntervalMs)
    const announceAttemptCounts = initPromises.map(() => 0)
    const announceErrorStreaks = initPromises.map(() => 0)
    const announceTimeouts: Array<ReturnType<typeof setTimeout> | undefined> =
      []

    const unsubFns = initPromises.map(async (relayP, i) =>
      subscribe(
        await relayP,
        await rootTopicP,
        await selfTopicP,
        handleMessage(i),
        n => offerManager.getOffers(n, encryptOffer),
        strategyContext
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

        if (isPassive && !ctx.isActive) {
          return
        }

        const authExtra =
          isAdminBacked && bridgeRef.current
            ? await bridgeRef.current.getAnnounceExtra()
            : undefined
        const extra =
          isPassive || authExtra
            ? {...authExtra, ...(isPassive ? {passive: true} : {})}
            : undefined
        let announceResult: Awaited<
          ReturnType<StrategyAdapter<TRelay, TConfig>['announce']>
        > = undefined

        try {
          announceResult = await announce(
            relay,
            rootTopic,
            selfTopic,
            extra,
            strategyContext
          )
          announceErrorStreaks[i] = 0
        } catch (error) {
          if (didLeaveRoom) {
            return
          }

          const errorStreak = announceErrorStreaks[i] ?? 0

          if (
            errorStreak === 0 &&
            config.relayConfig?.warnOnRelayFailure !== false
          ) {
            console.warn(
              `${libName}: announce failed - ${toErrorMessage(error, '')}`
            )
          }

          announceErrorStreaks[i] = errorStreak + 1
        }

        if (didLeaveRoom || (isPassive && !ctx.isActive)) {
          return
        }

        if (
          announceResult &&
          typeof announceResult !== 'number' &&
          'stopAnnouncing' in announceResult
        ) {
          return
        }

        if (typeof announceResult === 'number') {
          ctx.announceIntervals[i] = announceResult
          announceScheduleIntervals[i] = announceResult
        } else if (announceResult) {
          announceScheduleIntervals[i] = announceResult.nextAnnounceMs
          reannounceOnDisconnect ||=
            announceResult.reannounceOnDisconnect === true
        }

        const announceAttempt = announceAttemptCounts[i] ?? 0
        announceAttemptCounts[i] = announceAttempt + 1
        const currentInterval =
          announceScheduleIntervals[i] ?? announceIntervalMs
        // Topic discovery gets one later recovery pulse. Numeric intervals
        // (e.g. tracker-requested pacing) must retain their own cadence.
        const warmupDelay =
          announceWarmupIntervalsMs[announceAttempt] ??
          (announceAttempt === 3 && typeof announceResult === 'object'
            ? announceIntervalMs
            : undefined)
        const nextAnnounceDelayMs =
          typeof warmupDelay === 'number'
            ? Math.min(currentInterval, warmupDelay)
            : currentInterval

        announceTimeouts[i] = setTimeout(() => {
          void queueAnnounce(relay, i)
        }, nextAnnounceDelayMs)
      }

      deactivateRelayAnnouncements = () => {
        if (!deactivate) {
          return
        }

        initPromises.forEach(async relayP => {
          const relay = await relayP

          if (!didLeaveRoom) {
            void deactivate(relay, rootTopic, selfTopic, strategyContext)
          }
        })
      }

      ctx.requeueAnnounce = () => {
        announceTimeouts.forEach(resetTimer)
        announceTimeouts.length = 0
        passiveActivationTimeout = resetTimer(passiveActivationTimeout)

        membership.setActive(true)

        passiveActivationTimeout = setTimeout(
          checkDeactivate,
          passiveActivationGraceMs
        )

        initPromises.forEach(async (relayP, i) => {
          const relay = await relayP

          if (relay && !didLeaveRoom) {
            announceAttemptCounts[i] = 0
            void queueAnnounce(relay, i)
          }
        })
      }

      unsubFns.forEach(async (didSub, i) => {
        await didSub

        if (didLeaveRoom) {
          return
        }

        const relay = await initPromises[i]

        if (relay && !didLeaveRoom && (!isPassive || ctx.isActive)) {
          void queueAnnounce(relay, i)
        }
      })
    })

    let onPeerConnect = noOp as (peer: PeerHandle, peerId: string) => void
    const userIdentityP = (
      effectiveRoomIdP
        ? effectiveRoomIdP.then(rid =>
            resolveUserIdentity(appId, rid, config, localSelfId)
          )
        : resolveUserIdentity(appId, roomId, config, localSelfId)
    ).catch(err => {
      onJoinError?.({
        error: toErrorMessage(err, 'identity resolution failed'),
        appId,
        peerId: localSelfId,
        roomId: effectiveRoomId
      })
      throw err
    })
    void userIdentityP.catch(noOp)

    const sharedPassword = config.password ?? ''
    const {compose: composePassword} = createPasswordHandshake(
      sharedPassword,
      appId,
      effectiveRoomIdP ?? roomId
    )
    const {compose: composeIdentity} = createIdentityHandshake({
      selfId: localSelfId,
      appId,
      roomId: effectiveRoomIdP ?? roomId,
      getUserIdentity: () => userIdentityP,
      getPeerHandle: peerId => bridgeRef.current?.getPeerHandle(peerId),
      onVerified: (peerId, verified) => {
        bridgeRef.current?.onPeerIdentityVerified(peerId, verified)
        bridgeRef.current?.checkCapacityAfterPassword(peerId)
      }
    })
    const composedPeerHandshake = composePassword(composeIdentity())

    const releaseOccupiedRoom = (): void => {
      if (occupiedRooms[scopeAppId]?.[roomId] === joinedRoom) {
        delete occupiedRooms[scopeAppId][roomId]
      }
      if (
        effectiveRoomId !== roomId &&
        occupiedRooms[scopeAppId]?.[effectiveRoomId] === joinedRoom
      ) {
        delete occupiedRooms[scopeAppId][effectiveRoomId]
      }
      if (
        occupiedRooms[scopeAppId] &&
        keys(occupiedRooms[scopeAppId]).length === 0
      ) {
        delete occupiedRooms[scopeAppId]
      }
    }

    const clearLeavingCleanup = (): void => {
      if (leavingRoomCleanups[scopeAppId]?.[roomId] === cleanupRoom) {
        delete leavingRoomCleanups[scopeAppId][roomId]
      }
      if (
        effectiveRoomId !== roomId &&
        leavingRoomCleanups[scopeAppId]?.[effectiveRoomId] === cleanupRoom
      ) {
        delete leavingRoomCleanups[scopeAppId][effectiveRoomId]
      }
      if (
        leavingRoomCleanups[scopeAppId] &&
        keys(leavingRoomCleanups[scopeAppId]).length === 0
      ) {
        delete leavingRoomCleanups[scopeAppId]
      }
    }

    const cleanupRoom = (rejoining = false): void => {
      if (didLeaveRoom) {
        return
      }

      didLeaveRoom = true
      onPeerConnect = noOp

      releaseOccupiedRoom()
      clearLeavingCleanup()
      membership.leave()

      entries(ctx.peerStates).forEach(([peerId, state]) => {
        if (state.connectedPeer && !state.connectedPeer.isDead) {
          if (!sharedPeers.owns(scopeAppId, peerId, state.connectedPeer)) {
            state.connectedPeer.destroy()
          }
        }

        if (state.answeringPeer && !state.answeringPeer.isDead) {
          state.answeringPeer.destroy()
        }

        resetOfferState(state)
        resetAnsweringState(state)
        state.connectedPeer = null
        state.connectedPeerUnhealthySinceMs = null
      })

      announceTimeouts.forEach(resetTimer)
      passiveActivationTimeout = resetTimer(passiveActivationTimeout)
      unsubFns.forEach(async f => {
        const cleanup = await f
        cleanup()
      })

      offerManager.destroy()

      if (rejoining || hasActiveRooms()) {
        return
      }

      didInit = false
      cleanupWatchOnline()
    }

    const roomOptions = {
      selfId: localSelfId,
      appId,
      roomId,
      ...(config.password === undefined ? {} : {password: config.password}),
      ...(config.limit === undefined ? {} : {limit: config.limit}),
      ...(config.topology === undefined ? {} : {topology: config.topology}),
      ...(config.admin === undefined ? {} : {admin: config.admin}),
      ...(resolvedAuthorityP ? {resolvedAuthorityP} : {}),
      userIdentityP,
      verifyPeerIdentity: true,
      ...(config.maxReceiveBytes === undefined
        ? {}
        : {maxReceiveBytes: config.maxReceiveBytes}),
      ...(composedPeerHandshake
        ? {onPeerHandshake: composedPeerHandshake}
        : {}),
      isPassive,
      onBeforeLeave: () => {
        isLeavingRoom = true
        announceTimeouts.forEach(resetTimer)
        announceTimeouts.length = 0
        releaseOccupiedRoom()
        ;(leavingRoomCleanups[scopeAppId] ??= {})[roomId] = cleanupRoom
      },
      onHandshakeError: (peerId: string, error: string) =>
        onJoinError?.({
          error: error.replace(/^handshake failed: /, ''),
          appId,
          peerId,
          roomId: effectiveRoomId
        })
    }

    occupiedRooms[scopeAppId] ??= {}

    const joinedRoom = room(
      f => (onPeerConnect = f),
      id => {
        if (didLeaveRoom) {
          return
        }

        const state = ctx.peerStates[id]

        if (state?.connectedPeer) {
          detachConnectedPeer(state, state.connectedPeer)
        }

        checkDeactivate()
        // Shared-peer close handlers reach the room callback, not disconnectPeer.
        reannounceAfterDisconnect()
      },
      () => cleanupRoom(false),
      roomOptions
    )

    const signalingBridge = getRoomSignalingBridge(joinedRoom)
    bridgeRef.current = signalingBridge
    signalingBridge?.overlay.setOnTargetsChanged(missingTargets => {
      if (!didLeaveRoom) {
        missingTargets.forEach(targetId => {
          if (!ctx.reusePeer(targetId)) {
            ctx.dialPeer?.(targetId)
          }
        })
      }
    })

    const membership = sharedPeers.registerRoom(
      scopeAppId,
      effectiveRoomId,
      roomNamespacePromise,
      {
        active: !isPassive || ctx.isActive,
        shouldAttach: peerId =>
          signalingBridge
            ? signalingBridge.overlay.shouldConnectPeer(peerId, 'inbound')
            : true,
        onPeer: (proxy, peerId, physical) => {
          const state = getState(ctx.peerStates, peerId)
          markPeerConnected(state, physical)
          if (isPassive && !ctx.isActive) {
            ctx.isActive = true
            membership.setActive(true)
            if (ctx.requeueAnnounce) {
              ctx.requeueAnnounce()
            } else {
              passiveActivationTimeout = resetTimer(passiveActivationTimeout)
              passiveActivationTimeout = setTimeout(
                checkDeactivate,
                passiveActivationGraceMs
              )
            }
          }
          onPeerConnect(proxy, peerId)
          resetOfferState(state)
        },
        onDetach: (peerId, physical) => {
          detachConnectedPeer(ctx.peerStates[peerId], physical)
          checkDeactivate()
        }
      }
    )
    membershipRef = membership

    return (occupiedRooms[scopeAppId][roomId] = joinedRoom)
  }
}
