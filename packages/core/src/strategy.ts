import {decrypt, encrypt, genKey, hashTopic} from './crypto'
import {
  createIdentityClientId,
  getDefaultEndpointIdentity,
  resolveUserIdentity,
  validateIdentityConfig
} from './identity'
import type {
  SignalContext,
  StrategyAdapter,
  StrategyContext
} from './internal-types'
import {OfferManager} from './offer-manager'
import initPeer from './peer'
import {socketInitialFailureSymbol} from './primitives'
import {createRoomWithBridge, type RoomSignalingBridge} from './room'
import {resolvePluginRoomIds, validateAndPreparePlugins} from './room-bootstrap'
import {
  buildSignalAad,
  clearConnectedPeer,
  createSignalHandler,
  detachConnectedPeer,
  getConnectedPeerHealth,
  getState,
  markPeerConnected,
  prunePeerStates,
  resetAnsweringState,
  resetOfferState
} from './signal-handler'
import type {
  BaseRoomConfig,
  JoinRoom,
  JoinRoomConfig,
  PeerHandle,
  Room,
  RoomError,
  RoomPlugin,
  RoomWithPlugins,
  Signal
} from './types'
import {
  all,
  entries,
  keys,
  libName,
  log,
  mkErr,
  noOp,
  posSafeIntErr,
  requiredErr,
  resetTimer,
  toErrorMessage,
  topicPath,
  warn
} from './utils'

const announceIntervalMs = 5_333
const announceWarmupIntervalsMs = [233, 533, 1_333] as const

const mergeDefaultConfig = <T extends object>(
  defaults: Partial<T>,
  overrides: T
): T => {
  const merged = {...defaults} as Record<string, unknown>
  for (const [k, v] of entries(overrides as Record<string, unknown>)) {
    if (v !== undefined) {
      merged[k] = v
    }
  }
  return merged as T
}

export default <TRelay, TConfig extends BaseRoomConfig = JoinRoomConfig>({
  defaultConfig,
  init,
  subscribe,
  announce
}: StrategyAdapter<TRelay, TConfig>): JoinRoom<TConfig> => {
  const clientId = createIdentityClientId()
  const occupiedRooms: Record<string, Record<string, Room>> = {}
  const leavingRoomCleanups: Record<string, Record<string, () => void>> = {}

  return (<
    const TPlugins extends readonly RoomPlugin<string, any>[] | undefined =
      undefined
  >(
    config: TConfig & {use?: TPlugins},
    roomId: string,
    ...extra: unknown[]
  ): RoomWithPlugins<TPlugins> => {
    if (!config) {
      throw mkErr('config map required')
    }

    if (extra.length > 0 && extra[0] !== undefined) {
      throw mkErr(
        'joinRoom takes 2 arguments; register error listeners via room.onError(fn)'
      )
    }

    const effectiveConfig = defaultConfig
      ? mergeDefaultConfig(defaultConfig, config)
      : config

    const {appId} = effectiveConfig

    if (!appId) {
      throw requiredErr('appId')
    }

    if (!roomId) {
      throw requiredErr('roomId')
    }

    if (
      effectiveConfig.maxReceiveBytes !== undefined &&
      (!Number.isSafeInteger(effectiveConfig.maxReceiveBytes) ||
        effectiveConfig.maxReceiveBytes <= 0)
    ) {
      throw posSafeIntErr('maxReceiveBytes')
    }

    if (
      effectiveConfig.limit !== undefined &&
      (!Number.isSafeInteger(effectiveConfig.limit) ||
        effectiveConfig.limit < 1)
    ) {
      throw posSafeIntErr('limit')
    }

    validateIdentityConfig(effectiveConfig)

    const {plugins, resolveOrderPlugins} = validateAndPreparePlugins(
      effectiveConfig.use,
      roomId,
      effectiveConfig.identity
    )

    if (occupiedRooms[appId]?.[roomId]) {
      return occupiedRooms[appId][roomId] as RoomWithPlugins<TPlugins>
    }

    leavingRoomCleanups[appId]?.[roomId]?.()

    const localEndpointP = getDefaultEndpointIdentity(
      undefined,
      appId,
      clientId
    )
    const selfIdP = localEndpointP.then(ep => ep.peerId)

    let didLeaveRoom = false
    let isLeavingRoom = false
    let didReportSetupError = false
    let didReportRelayError = false
    let effectiveRoomId = roomId
    const bridgeRef: {current?: RoomSignalingBridge | undefined} = {}
    const emitError = (error: RoomError): void => {
      if (!didLeaveRoom) {
        bridgeRef.current?.emitError(error)
      }
    }
    const userIdentityP = resolveUserIdentity(
      appId,
      roomId,
      effectiveConfig,
      clientId
    ).catch(err => {
      didReportSetupError = true
      queueMicrotask(() => {
        if (!didLeaveRoom) {
          emitError({
            code: 'identity-failed',
            message: toErrorMessage(err, 'identity resolution failed'),
            appId,
            roomId: effectiveRoomId,
            cause: err
          })
        }
      })
      throw err
    })
    void userIdentityP.catch(noOp)

    const {preResolvedPlugins, effectiveRoomIdP: rawEffectiveRoomIdP} =
      resolvePluginRoomIds(
        resolveOrderPlugins,
        appId,
        roomId,
        userIdentityP,
        (pluginName, err) => {
          if (!didReportSetupError && !didLeaveRoom) {
            didReportSetupError = true
            queueMicrotask(() => {
              if (!didLeaveRoom) {
                emitError({
                  code: 'plugin-failed',
                  plugin: pluginName,
                  message: toErrorMessage(err, 'room resolution failed'),
                  appId,
                  roomId: effectiveRoomId,
                  cause: err
                })
              }
            })
          }
        }
      )

    const rootTopicPlaintext = topicPath(libName, appId, roomId)
    const effectiveRoomIdP = rawEffectiveRoomIdP?.then(rid => {
      effectiveRoomId = rid
      ctx.roomId = rid
      ctx.rootTopicPlaintext = topicPath(libName, appId, rid)
      strategyContext.roomId = rid
      if (rid !== roomId && !didLeaveRoom) {
        ;(occupiedRooms[appId] ??= {})[rid] = joinedRoom
      }
      return rid
    })
    void effectiveRoomIdP?.catch(noOp)

    const rootTopicP = effectiveRoomIdP
      ? effectiveRoomIdP.then(rid => hashTopic(topicPath(libName, appId, rid)))
      : hashTopic(rootTopicPlaintext)
    void rootTopicP.catch(noOp)
    const selfTopicP = all([
      effectiveRoomIdP ?? Promise.resolve(roomId),
      selfIdP
    ]).then(([rid, resolvedPeerId]) => {
      ctx.selfId = resolvedPeerId
      strategyContext.peerId = resolvedPeerId
      return hashTopic(
        topicPath(topicPath(libName, appId, rid), resolvedPeerId)
      )
    })
    void selfTopicP.catch(noOp)
    const key = effectiveRoomIdP
      ? effectiveRoomIdP.then(rid =>
          genKey(effectiveConfig.password ?? '', appId, rid)
        )
      : genKey(effectiveConfig.password ?? '', appId, roomId)
    void key.catch(noOp)

    const withKey =
      (
        f: (
          keyP: Promise<CryptoKey>,
          text: string,
          aad?: string
        ) => Promise<string>
      ) =>
      async (
        signal: Signal,
        peerId: string,
        offerId: string
      ): Promise<Signal> => ({
        type: signal.type,
        sdp: await f(
          key,
          signal.sdp,
          buildSignalAad(signal.type, peerId, offerId)
        )
      })

    const toPlain = withKey(decrypt)
    const toCipher = withKey(encrypt)
    const makeOffer = (): PeerHandle => initPeer(true, effectiveConfig)
    let reannounceOnDisconnect = false
    const offerManager = new OfferManager(makeOffer)

    const encryptOffer = async (
      peer: PeerHandle,
      peerId: string,
      offerId: string
    ): Promise<string> => {
      const plainOffer = await peer.getOffer()

      if (!plainOffer || plainOffer.type !== 'offer') {
        throw mkErr('failed to get offer for peer')
      }

      return (await toCipher(plainOffer, peerId, offerId)).sdp
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

      onPeerConnect(peer, peerId)
      resetOfferState(state)

      if (peer.isDead && state.connectedPeer === peer) {
        detachConnectedPeer(state, peer)
        prunePeerStates(ctx.peerStates)
      }
    }

    const isPassive = Boolean(effectiveConfig.passive)
    let syncOverlayNeighbors = noOp
    let requeueAnnounce = noOp
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
          requeueAnnounce()
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
        prunePeerStates(ctx.peerStates)

        reannounceAfterDisconnect()
      }
    }

    const ctx: SignalContext = {
      appId,
      roomId,
      config: effectiveConfig,
      peerStates: {},
      rootTopicPlaintext,
      rootTopicP,
      selfTopicP,
      toPlain,
      toCipher,
      isLeaving: () => didLeaveRoom || isLeavingRoom,
      onError: emitError,
      offerManager,
      encryptOffer,
      initPeer,
      connectPeer,
      disconnectPeer,
      announceIntervals: [],
      announceIntervalMs,
      selfIdP,
      onPeerDiscovered: peerId => {
        if (bridgeRef.current?.getScaleProvider()?.notePeerDiscovered(peerId)) {
          syncOverlayNeighbors()
        }
      },
      shouldConnectPeer: (peerId, direction) =>
        (bridgeRef.current?.canConnectPeer(peerId) ?? true) &&
        (bridgeRef.current
          ?.getScaleProvider()
          ?.shouldConnectPeer(peerId, direction) ??
          true)
    }
    const strategyContext: StrategyContext<TConfig> = {
      config: effectiveConfig,
      appId,
      roomId
    }

    const {handleMessage, dialPeer} = createSignalHandler(ctx)
    syncOverlayNeighbors = () => {
      const scaleProvider = bridgeRef.current?.getScaleProvider()
      if (
        didLeaveRoom ||
        isPassive ||
        !scaleProvider ||
        scaleProvider.getActiveMode() === 'mesh'
      ) {
        return
      }
      for (const targetId of scaleProvider.getTargetNeighbors()) {
        dialPeer(targetId)
      }
    }

    const initRes = init(effectiveConfig)
    const initPromises: Promise<TRelay>[] = (
      Array.isArray(initRes) ? initRes : [initRes]
    ).map(value => {
      const p = Promise.resolve(value)
      void p.catch(noOp)
      return p
    })

    // Only explicit numeric relay pacing overrides the signaling retry default.
    const announceScheduleIntervals = initPromises.map(() => announceIntervalMs)
    const announceAttemptCounts = initPromises.map(() => 0)
    const announceErrorStreaks = initPromises.map(() => 0)
    const announceTimeouts: Array<ReturnType<typeof setTimeout> | undefined> =
      []

    const totalRelays = initPromises.length
    const relayBootStates = new Map<number, 'ok' | 'failed'>()
    let anyRelayBootHealthy = false
    let lastRelayBootError: unknown
    const reportAllRelaysFailed = (cause: unknown): void => {
      if (didReportRelayError || didReportSetupError || didLeaveRoom) {
        return
      }
      didReportRelayError = true
      queueMicrotask(() => {
        if (!didLeaveRoom) {
          emitError({
            code: 'relay-failed',
            message: toErrorMessage(cause, 'all signaling relays failed'),
            appId,
            roomId: effectiveRoomId,
            ...(cause !== undefined ? {cause} : {})
          })
        }
      })
    }
    const markRelayHealthy = (i: number): void => {
      anyRelayBootHealthy = true
      relayBootStates.set(i, 'ok')
    }
    const markRelayFailed = (i: number, err: unknown): void => {
      if (anyRelayBootHealthy || relayBootStates.has(i)) {
        return
      }
      relayBootStates.set(i, 'failed')
      lastRelayBootError = err
      if (totalRelays > 0 && relayBootStates.size === totalRelays) {
        reportAllRelaysFailed(lastRelayBootError)
      }
    }

    initPromises.forEach((relayP, i) => {
      const getInitialFailure = (
        relayP as Promise<TRelay> & {
          [socketInitialFailureSymbol]?: () => Promise<Error | null>
        }
      )[socketInitialFailureSymbol]
      if (typeof getInitialFailure === 'function') {
        void getInitialFailure().then(err => {
          if (err) {
            markRelayFailed(i, err)
          }
        })
      }
    })

    const unsubFns = initPromises.map(async (relayP, i) => {
      let rootTopic: string
      let selfTopic: string
      try {
        ;[rootTopic, selfTopic] = await all([rootTopicP, selfTopicP])
      } catch {
        return noOp
      }
      if (didLeaveRoom) {
        return noOp
      }
      try {
        const relay = await relayP
        if (didLeaveRoom) {
          return noOp
        }
        const unsub = await subscribe(
          relay,
          rootTopic,
          selfTopic,
          handleMessage(i),
          n =>
            selfIdP.then(sid =>
              offerManager.getOffers(n, (peer, offerId) =>
                encryptOffer(peer, sid, offerId)
              )
            ),
          strategyContext
        )
        markRelayHealthy(i)
        return unsub
      } catch (err) {
        markRelayFailed(i, err)
        return noOp
      }
    })

    const initialAnnounceOutcomes = new Map<number, 'ok' | 'failed'>()
    let anyInitialAnnounceSucceeded = false
    let lastInitialAnnounceError: unknown

    if (!isPassive) {
      void all([rootTopicP, selfTopicP]).then(([rootTopic, selfTopic]) => {
        if (didLeaveRoom) {
          return
        }

        const queueAnnounce = async (
          relay: TRelay,
          i: number
        ): Promise<void> => {
          if (didLeaveRoom) {
            return
          }

          let announceResult: Awaited<
            ReturnType<StrategyAdapter<TRelay, TConfig>['announce']>
          > = undefined
          const isInitialAnnounce = !initialAnnounceOutcomes.has(i)

          try {
            announceResult = await announce(
              relay,
              rootTopic,
              selfTopic,
              strategyContext
            )
            announceErrorStreaks[i] = 0
            if (isInitialAnnounce) {
              anyInitialAnnounceSucceeded = true
              initialAnnounceOutcomes.set(i, 'ok')
            }
          } catch (error) {
            if (didLeaveRoom) {
              return
            }

            const errorStreak = announceErrorStreaks[i] ?? 0

            if (
              errorStreak === 0 &&
              effectiveConfig.relayConfig?.warnOnRelayFailure !== false
            ) {
              warn(`announce failed - ${toErrorMessage(error, '')}`)
            }

            announceErrorStreaks[i] = errorStreak + 1
            if (isInitialAnnounce) {
              initialAnnounceOutcomes.set(i, 'failed')
              lastInitialAnnounceError = error
              if (
                !anyInitialAnnounceSucceeded &&
                totalRelays > 0 &&
                initialAnnounceOutcomes.size +
                  [...relayBootStates.values()].filter(s => s === 'failed')
                    .length >=
                  totalRelays
              ) {
                reportAllRelaysFailed(lastInitialAnnounceError)
              }
            }
          }

          if (didLeaveRoom) {
            return
          }

          if (typeof announceResult === 'number') {
            ctx.announceIntervals[i] = announceResult
            announceScheduleIntervals[i] = announceResult
          } else if (
            typeof announceResult === 'object' &&
            announceResult !== null
          ) {
            if ('stopAnnouncing' in announceResult) {
              return
            }
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

        requeueAnnounce = () => {
          announceTimeouts.forEach(resetTimer)
          announceTimeouts.length = 0

          initPromises.forEach((relayP, i) => {
            void relayP.then(relay => {
              if (relay && !didLeaveRoom) {
                announceAttemptCounts[i] = 0
                void queueAnnounce(relay, i)
              }
            }, noOp)
          })
        }

        unsubFns.forEach((didSub, i) => {
          void didSub.then(cleanup => {
            if (didLeaveRoom || cleanup === noOp) {
              return
            }
            void initPromises[i]?.then(relay => {
              if (relay && !didLeaveRoom) {
                void queueAnnounce(relay, i)
              }
            }, noOp)
          }, noOp)
        })
      }, noOp)
    }

    let onPeerConnect = noOp as (peer: PeerHandle, peerId: string) => void

    const releaseOccupiedRoom = (): void => {
      const appRooms = occupiedRooms[appId]
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
        delete occupiedRooms[appId]
      }
    }

    const clearLeavingCleanup = (): void => {
      const appCleanups = leavingRoomCleanups[appId]
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
        delete leavingRoomCleanups[appId]
      }
    }

    const cleanupRoom = (): void => {
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
      unsubFns.forEach(f => {
        void f.then(cleanup => cleanup(), noOp)
      })

      offerManager.destroy()
    }

    const roomOptions = {
      endpointIdentityP: localEndpointP,
      appId,
      roomId,
      ...(effectiveRoomIdP === undefined ? {} : {effectiveRoomIdP}),
      ...(effectiveConfig.password === undefined
        ? {}
        : {password: effectiveConfig.password}),
      ...(effectiveConfig.limit === undefined
        ? {}
        : {limit: effectiveConfig.limit}),
      ...(plugins.length > 0 ? {use: plugins, preResolvedPlugins} : {}),
      didResolvePluginRoomIds: true,
      userIdentityP,
      verifyPeerIdentity: true,
      runIdentityHandshake: true,
      ...(effectiveConfig.maxReceiveBytes === undefined
        ? {}
        : {maxReceiveBytes: effectiveConfig.maxReceiveBytes}),
      onBeforeLeave: () => {
        isLeavingRoom = true
        announceTimeouts.forEach(resetTimer)
        announceTimeouts.length = 0
        releaseOccupiedRoom()
        ;(leavingRoomCleanups[appId] ??= {})[roomId] = cleanupRoom
      }
    }

    occupiedRooms[appId] ??= {}

    let joinedRoom: RoomWithPlugins<TPlugins>
    let signalingBridge: RoomSignalingBridge
    try {
      const created = createRoomWithBridge(
        f => (onPeerConnect = f),
        id => {
          if (didLeaveRoom) {
            return
          }

          const state = ctx.peerStates[id]

          if (state?.connectedPeer) {
            detachConnectedPeer(state, state.connectedPeer)
          }

          prunePeerStates(ctx.peerStates)
          // Shared-peer close handlers reach the room callback, not disconnectPeer.
          reannounceAfterDisconnect()
        },
        cleanupRoom,
        roomOptions
      )
      joinedRoom = created.room as RoomWithPlugins<TPlugins>
      signalingBridge = created.bridge
    } catch (err) {
      didLeaveRoom = true
      announceTimeouts.forEach(resetTimer)
      unsubFns.forEach(f => {
        void f.then(cleanup => cleanup(), noOp)
      })
      offerManager.destroy()
      throw err
    }

    bridgeRef.current = signalingBridge
    signalingBridge.setOnScaleTargetsChanged(missingTargets => {
      if (!didLeaveRoom) {
        missingTargets.forEach(targetId => {
          dialPeer(targetId)
        })
      }
    })

    return (occupiedRooms[appId][roomId] =
      joinedRoom) as RoomWithPlugins<TPlugins>
  }) as JoinRoom<TConfig>
}
