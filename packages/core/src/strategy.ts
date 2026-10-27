import {isSelfAsAdminPlugin} from './authority'
import {decrypt, encrypt, genKey, sha1} from './crypto'
import {
  getDefaultEndpointIdentity,
  registerTestForcedPeerId,
  resolveUserIdentity,
  validateIdentityConfig
} from './identity'
import {OfferManager} from './offer-manager'
import {createIdentityHandshake} from './handshake'
import initPeer from './peer'
import room, {getRoomSignalingBridge, type RoomSignalingBridge} from './room'
import {
  createSignalHandler,
  clearConnectedPeer,
  detachConnectedPeer,
  getConnectedPeerHealth,
  getState,
  markPeerConnected,
  resetAnsweringState,
  resetOfferState
} from './signal-handler'
import {
  all,
  entries,
  getConfiguredPlugins,
  keys,
  libName,
  log,
  mkErr,
  noOp,
  posSafeIntErr,
  requiredErr,
  resetTimer,
  selfCertifyingRoomRegex,
  selfCertRoomRolesErr,
  toErrorMessage,
  topicPath,
  values,
  warn,
  warnEphemeralAdmin,
  watchOnline
} from './utils'
import type {
  BaseRoomConfig,
  JoinRoom,
  JoinRoomCallbacks,
  JoinRoomConfig,
  PeerHandle,
  RoomPlugin,
  RoomWithPlugins,
  Signal,
  SignalContext,
  StrategyContext,
  StrategyAdapter,
  TestOnlyRoomConfig
} from './types'

const announceIntervalMs = 5_333
const announceWarmupIntervalsMs = [233, 533, 1_333] as const
const passiveActivationGraceMs = 7_533

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
  const hasActiveRooms = (): boolean =>
    values(occupiedRooms).some(rooms => keys(rooms).length > 0)

  let didInit = false
  let initPromises: Promise<TRelay>[] = []
  let cleanupWatchOnline: () => void = noOp

  return <
    const TPlugins extends readonly RoomPlugin<string, any>[] | undefined =
      undefined
  >(
    config: TConfig & {use?: TPlugins},
    roomId: string,
    callbacks?: JoinRoomCallbacks
  ): RoomWithPlugins<TPlugins> => {
    if (!config) {
      throw mkErr('config map required')
    }

    if (callbacks && typeof callbacks !== 'object') {
      throw mkErr('callbacks must be an object')
    }

    const {appId} = config
    const onJoinError = callbacks?.onJoinError

    if (!appId) {
      throw requiredErr('appId')
    }

    if (!roomId) {
      throw requiredErr('roomId')
    }

    if (
      config.maxReceiveBytes !== undefined &&
      (!Number.isSafeInteger(config.maxReceiveBytes) ||
        config.maxReceiveBytes <= 0)
    ) {
      throw posSafeIntErr('maxReceiveBytes')
    }

    if (
      config.limit !== undefined &&
      (!Number.isSafeInteger(config.limit) || config.limit < 1)
    ) {
      throw posSafeIntErr('limit')
    }

    validateIdentityConfig(config)

    const plugins = getConfiguredPlugins(config.use)
    const hasRolesPlugin = plugins.some(p => p.name === 'roles')
    if (!hasRolesPlugin && selfCertifyingRoomRegex.test(roomId)) {
      throw selfCertRoomRolesErr
    }
    if (
      plugins.some(isSelfAsAdminPlugin) &&
      (config.identity === undefined ||
        config.identity === 'session' ||
        config.identity === 'none')
    ) {
      warnEphemeralAdmin()
    }

    let forcedPeerId: string | undefined
    DEV: {
      const testConfig = config as TestOnlyRoomConfig
      if (
        typeof testConfig._test_only_forcedPeerId === 'string' &&
        testConfig._test_only_forcedPeerId
      ) {
        forcedPeerId = testConfig._test_only_forcedPeerId
      }
    }
    const localEndpointP = forcedPeerId
      ? registerTestForcedPeerId(forcedPeerId)
      : getDefaultEndpointIdentity()
    const selfIdP = localEndpointP.then(ep => forcedPeerId ?? ep.peerId)
    const scopeAppId = forcedPeerId ? `${appId}:${forcedPeerId}` : appId

    if (occupiedRooms[scopeAppId]?.[roomId]) {
      return occupiedRooms[scopeAppId][roomId] as RoomWithPlugins<TPlugins>
    }

    leavingRoomCleanups[scopeAppId]?.[roomId]?.(true)

    let effectiveRoomId = roomId
    const userIdentityP = resolveUserIdentity(
      appId,
      roomId,
      config,
      forcedPeerId
    ).catch(async err => {
      onJoinError?.({
        error: toErrorMessage(err, 'identity resolution failed'),
        appId,
        peerId: forcedPeerId ?? (await selfIdP),
        roomId: effectiveRoomId
      })
      throw err
    })
    void userIdentityP.catch(noOp)

    const preResolvedPlugins = new Map<RoomPlugin, unknown>()
    let resolvedRoomIdP:
      | Promise<{effectiveRoomId: string; state?: unknown}>
      | undefined
    for (const plugin of plugins) {
      if (plugin.resolveRoomId) {
        const resP = plugin.resolveRoomId({appId, roomId, userIdentityP})
        if (resP) {
          resolvedRoomIdP = resP.then(res => {
            preResolvedPlugins.set(plugin, res.state)
            return res
          })
        }
      }
    }

    const rootTopicPlaintext = topicPath(libName, appId, roomId)
    const effectiveRoomIdP = resolvedRoomIdP?.then(res => {
      effectiveRoomId = res.effectiveRoomId
      ctx.roomId = res.effectiveRoomId
      ctx.rootTopicPlaintext = topicPath(libName, appId, res.effectiveRoomId)
      strategyContext.roomId = res.effectiveRoomId
      if (res.effectiveRoomId !== roomId && !didLeaveRoom) {
        ;(occupiedRooms[scopeAppId] ??= {})[res.effectiveRoomId] = joinedRoom
      }
      return res.effectiveRoomId
    })

    const rootTopicP = effectiveRoomIdP
      ? effectiveRoomIdP.then(rid => sha1(topicPath(libName, appId, rid)))
      : sha1(rootTopicPlaintext)
    const selfTopicP = all([
      effectiveRoomIdP ?? Promise.resolve(roomId),
      selfIdP
    ]).then(([rid, resolvedPeerId]) => {
      ctx.selfId = resolvedPeerId
      strategyContext.peerId = resolvedPeerId
      return sha1(topicPath(topicPath(libName, appId, rid), resolvedPeerId))
    })
    const key = effectiveRoomIdP
      ? effectiveRoomIdP.then(rid => genKey(config.password ?? '', appId, rid))
      : genKey(config.password ?? '', appId, roomId)

    let didLeaveRoom = false
    let isLeavingRoom = false
    const bridgeRef: {current?: RoomSignalingBridge | undefined} = {}

    const syncOverlayNeighbors = (): void => {
      const scaleProvider = bridgeRef.current?.getScaleProvider()
      if (
        didLeaveRoom ||
        isPassive ||
        !scaleProvider ||
        scaleProvider.getSnapshot().activeMode === 'mesh'
      ) {
        return
      }
      for (const targetId of scaleProvider.getTargetNeighbors()) {
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
      if (didLeaveRoom || isLeavingRoom) {
        peer.destroy()
        return
      }

      const state = getState(ctx.peerStates, peerId)

      if (state.connectedPeer && state.connectedPeer !== peer) {
        if (getConnectedPeerHealth(state.connectedPeer) !== 'stale') {
          peer.destroy()
          return
        }

        clearConnectedPeer(state, peerId, 'replaced')
      }

      markPeerConnected(state, peer)

      if (isPassive && !ctx.isActive) {
        ctx.isActive = true

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

      onPeerConnect(peer, peerId)
      resetOfferState(state)

      if (peer.isDead && state.connectedPeer === peer) {
        detachConnectedPeer(state, peer)
        checkDeactivate()
      }
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
      checkDeactivate,
      announceIntervals: [],
      announceIntervalMs,
      ...(forcedPeerId ? {selfId: forcedPeerId} : {}),
      selfIdP,
      onPeerDiscovered: peerId => {
        bridgeRef.current?.getScaleProvider()?.notePeerDiscovered(peerId)
        syncOverlayNeighbors()
      },
      shouldConnectPeer: (peerId, direction) =>
        (bridgeRef.current?.canConnectPeer(peerId) ?? true) &&
        (bridgeRef.current
          ?.getScaleProvider()
          ?.shouldConnectPeer(peerId, direction) ??
          true)
    }
    const strategyContext: StrategyContext<TConfig> = {
      config,
      appId,
      roomId,
      isPassive,
      ...(forcedPeerId ? {peerId: forcedPeerId} : {})
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

        const extra = isPassive ? {passive: true} : undefined
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
            warn(`announce failed - ${toErrorMessage(error, '')}`)
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

    const {compose: composeIdentity} = createIdentityHandshake({
      ...(forcedPeerId ? {selfId: forcedPeerId} : {}),
      appId,
      roomId: effectiveRoomIdP ?? roomId,
      getUserIdentity: () => userIdentityP,
      getPeerHandle: peerId => bridgeRef.current?.getPeerHandle(peerId),
      onVerified: (peerId, verified) => {
        bridgeRef.current?.onPeerIdentityVerified(peerId, verified)
      }
    })
    const composedPeerHandshake = composeIdentity()

    const releaseOccupiedRoom = (): void => {
      const appRooms = occupiedRooms[scopeAppId]
      if (!appRooms) {
        return
      }
      if (appRooms[roomId] === joinedRoom) {
        delete appRooms[roomId]
      }
      if (
        effectiveRoomId !== roomId &&
        appRooms[effectiveRoomId] === joinedRoom
      ) {
        delete appRooms[effectiveRoomId]
      }
      if (keys(appRooms).length === 0) {
        delete occupiedRooms[scopeAppId]
      }
    }

    const clearLeavingCleanup = (): void => {
      const appCleanups = leavingRoomCleanups[scopeAppId]
      if (!appCleanups) {
        return
      }
      if (appCleanups[roomId] === cleanupRoom) {
        delete appCleanups[roomId]
      }
      if (
        effectiveRoomId !== roomId &&
        appCleanups[effectiveRoomId] === cleanupRoom
      ) {
        delete appCleanups[effectiveRoomId]
      }
      if (keys(appCleanups).length === 0) {
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

      entries(ctx.peerStates).forEach(([, state]) => {
        if (state.connectedPeer && !state.connectedPeer.isDead) {
          state.connectedPeer.destroy()
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
      ...(forcedPeerId ? {selfId: forcedPeerId} : {}),
      appId,
      roomId,
      ...(config.password === undefined ? {} : {password: config.password}),
      ...(config.limit === undefined ? {} : {limit: config.limit}),
      ...(plugins.length > 0 ? {use: plugins, preResolvedPlugins} : {}),
      userIdentityP,
      verifyPeerIdentity: true,
      ...(config.maxReceiveBytes === undefined
        ? {}
        : {maxReceiveBytes: config.maxReceiveBytes}),
      ...(composedPeerHandshake
        ? {onPeerHandshake: composedPeerHandshake}
        : {}),
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

    let joinedRoom: RoomWithPlugins<TPlugins>
    try {
      joinedRoom = room(
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
    } catch (err) {
      didLeaveRoom = true
      announceTimeouts.forEach(resetTimer)
      passiveActivationTimeout = resetTimer(passiveActivationTimeout)
      unsubFns.forEach(async f => {
        const cleanup = await f
        cleanup()
      })
      offerManager.destroy()
      if (!hasActiveRooms()) {
        didInit = false
        cleanupWatchOnline()
      }
      throw err
    }

    const signalingBridge = getRoomSignalingBridge(joinedRoom)
    bridgeRef.current = signalingBridge
    signalingBridge?.setOnScaleTargetsChanged(missingTargets => {
      if (!didLeaveRoom) {
        missingTargets.forEach(targetId => {
          ctx.dialPeer?.(targetId)
        })
      }
    })

    return (occupiedRooms[scopeAppId][roomId] =
      joinedRoom) as RoomWithPlugins<TPlugins>
  }
}
