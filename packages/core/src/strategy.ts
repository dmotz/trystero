import {decrypt, encrypt, genKey, hashTopic} from './crypto'
import {
  createIdentityClientId,
  getDefaultEndpointIdentity,
  validateIdentityConfig
} from './identity'
import type {
  PeerState,
  StrategyAdapter,
  StrategyContext
} from './internal-types'
import {createOfferManager} from './offer-manager'
import initPeer from './peer'
import {socketInitialFailureSymbol} from './primitives'
import {
  bootstrapIdentityAndPlugins,
  createRoomWithBridge,
  type RoomSignalingBridge,
  validateAndPreparePlugins
} from './room'
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
  AnyRoomPlugin,
  BaseRoomConfig,
  JoinRoom,
  JoinRoomConfig,
  PeerHandle,
  Room,
  RoomError,
  RoomWithPlugins,
  Signal
} from './types'
import {
  all,
  entries,
  isPosSafeInt,
  keys,
  libName,
  mkErr,
  noOp,
  posSafeIntErr,
  requiredErr,
  resetTimer,
  toErrorMessage,
  topicPath,
  unrefTimer,
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
    const TPlugins extends readonly AnyRoomPlugin[] | undefined = undefined
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
      !isPosSafeInt(effectiveConfig.maxReceiveBytes)
    ) {
      throw posSafeIntErr('maxReceiveBytes')
    }

    if (
      effectiveConfig.maxUsers !== undefined &&
      !isPosSafeInt(effectiveConfig.maxUsers)
    ) {
      throw posSafeIntErr('maxUsers')
    }

    validateIdentityConfig(effectiveConfig)

    const [plugins] = validateAndPreparePlugins(
      effectiveConfig.use,
      roomId,
      effectiveConfig.identity
    )

    if (occupiedRooms[appId]?.[roomId]) {
      return occupiedRooms[appId][roomId] as RoomWithPlugins<TPlugins>
    }

    leavingRoomCleanups[appId]?.[roomId]?.()

    const localEndpointP = getDefaultEndpointIdentity(appId, clientId)
    const selfIdP = localEndpointP.then(ep => ep.peerId)
    void selfIdP.catch(noOp)

    let didLeaveRoom = false
    let isLeavingRoom = false
    let didReportRelayError = false
    let didFailSetup = false
    let effectiveRoomId = roomId
    let activeBridge: RoomSignalingBridge | null = null

    const emitError = (error: RoomError): void => {
      if (!didLeaveRoom) {
        activeBridge?.emitError(error)
      }
    }

    const [userIdentityP, preResolvedPlugins, rawEffectiveRoomIdP] =
      bootstrapIdentityAndPlugins(
        appId,
        roomId,
        effectiveConfig,
        clientId,
        undefined,
        plugins,
        false,
        err => {
          didFailSetup = true
          queueMicrotask(() => {
            activeBridge?.failSetup(err)
          })
        }
      )

    const peerStates: Record<string, PeerState> = {}
    const announceIntervals: number[] = []
    let resolvedSelfId: string | undefined
    const topicFor = (rid: string): string => topicPath(libName, appId, rid)

    const strategyContext: StrategyContext<TConfig> = {
      config: effectiveConfig,
      appId,
      roomId,
      peerId: ''
    }

    const effectiveRoomIdP = rawEffectiveRoomIdP?.then(rid => {
      effectiveRoomId = rid
      strategyContext.roomId = rid
      if (rid !== roomId && !didLeaveRoom && !isLeavingRoom) {
        leavingRoomCleanups[appId]?.[rid]?.()
        ;(occupiedRooms[appId] ??= {})[rid] = joinedRoom
      }
      return rid
    })
    void effectiveRoomIdP?.catch(noOp)

    const whenRoomId = <T>(fn: (rid: string) => Promise<T>): Promise<T> => {
      const p = effectiveRoomIdP ? effectiveRoomIdP.then(fn) : fn(roomId)
      void p.catch(noOp)
      return p
    }
    const rootTopicP = whenRoomId(rid => hashTopic(topicFor(rid)))
    const selfTopicP = all([
      effectiveRoomIdP ?? Promise.resolve(roomId),
      selfIdP
    ]).then(([rid, peerId]) => {
      resolvedSelfId = peerId
      strategyContext.peerId = peerId
      return hashTopic(topicPath(topicFor(rid), peerId))
    })
    void selfTopicP.catch(noOp)
    const key = whenRoomId(rid =>
      genKey(effectiveConfig.password ?? '', appId, rid)
    )

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
    let reannounceOnDisconnect = false
    const {
      checkout: checkoutOffers,
      getOffers,
      claimLeased: claimLeasedOffer,
      reclaimLeased: reclaimLeasedOffer,
      destroy: destroyOffers
    } = createOfferManager(() => initPeer(true, effectiveConfig))

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

      const state = getState(peerStates, peerId)

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
        prunePeerStates(peerStates)
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
        if (!didLeaveRoom && !isLeavingRoom) {
          requeueAnnounce()
        }
      })
    }

    const disconnectPeer = (peer: PeerHandle, peerId: string): void => {
      if (didLeaveRoom) {
        return
      }

      const state = peerStates[peerId]

      if (state?.connectedPeer === peer) {
        clearConnectedPeer(state, peerId, 'close-event')
        prunePeerStates(peerStates)

        reannounceAfterDisconnect()
      }
    }

    const {handleMessage, dialPeer} = createSignalHandler({
      appId,
      getRoomId: () => effectiveRoomId,
      config: effectiveConfig,
      peerStates,
      getRootTopicPlaintext: () => topicFor(effectiveRoomId),
      rootTopicP,
      selfTopicP,
      toPlain,
      toCipher,
      isLeaving: () => didLeaveRoom || isLeavingRoom,
      onError: emitError,
      checkoutOffers,
      claimLeasedOffer,
      reclaimLeasedOffer,
      encryptOffer,
      initPeer,
      connectPeer,
      disconnectPeer,
      announceIntervals,
      announceIntervalMs,
      getSelfIdNow: () => resolvedSelfId,
      selfIdP,
      onPeerDiscovered: peerId => {
        if (
          (activeBridge?.canConnectPeer(peerId) ?? true) &&
          activeBridge?.getScaleProvider()?.notePeerDiscovered(peerId)
        ) {
          syncOverlayNeighbors()
        }
      },
      shouldConnectPeer: (peerId, direction) =>
        (activeBridge?.canConnectPeer(peerId) ?? true) &&
        (activeBridge
          ?.getScaleProvider()
          ?.shouldConnectPeer(peerId, direction) ??
          true)
    })

    syncOverlayNeighbors = () => {
      const scaleProvider = activeBridge?.getScaleProvider()
      if (didLeaveRoom || isLeavingRoom || isPassive || !scaleProvider) {
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
    const announceGenerations = initPromises.map(() => 0)
    const announceTimeouts: Array<ReturnType<typeof setTimeout> | undefined> =
      []
    const healthySubscribedRelays = new Set<number>()

    const totalRelays = initPromises.length
    const failedBootRelays = new Set<number>()
    let anyRelayBootHealthy = false
    const reportAllRelaysFailed = (cause: unknown): void => {
      if (
        didReportRelayError ||
        didFailSetup ||
        didLeaveRoom ||
        isLeavingRoom
      ) {
        return
      }
      didReportRelayError = true
      queueMicrotask(() => {
        if (!didLeaveRoom && !isLeavingRoom && !didFailSetup) {
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
    const markRelayFailed = (i: number, err: unknown): void => {
      if (anyRelayBootHealthy || failedBootRelays.has(i)) {
        return
      }
      failedBootRelays.add(i)
      if (totalRelays > 0 && failedBootRelays.size === totalRelays) {
        reportAllRelaysFailed(err)
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
      if (didLeaveRoom || isLeavingRoom) {
        return noOp
      }
      try {
        const relay = await relayP
        if (didLeaveRoom || isLeavingRoom) {
          return noOp
        }
        const unsub = await subscribe(
          relay,
          rootTopic,
          selfTopic,
          handleMessage(i),
          n =>
            selfIdP.then(sid =>
              getOffers(n, (peer, offerId) => encryptOffer(peer, sid, offerId))
            ),
          strategyContext
        )
        failedBootRelays.delete(i)
        anyRelayBootHealthy = true
        healthySubscribedRelays.add(i)
        return unsub
      } catch (err) {
        markRelayFailed(i, err)
        return noOp
      }
    })

    const settledAnnounces = new Set<number>()
    let anyInitialAnnounceSucceeded = false

    if (!isPassive) {
      void all([rootTopicP, selfTopicP]).then(([rootTopic, selfTopic]) => {
        if (didLeaveRoom || isLeavingRoom) {
          return
        }

        const queueAnnounce = async (
          relay: TRelay,
          i: number,
          gen: number
        ): Promise<void> => {
          if (didLeaveRoom || isLeavingRoom || announceGenerations[i] !== gen) {
            return
          }

          let announceResult: Awaited<
            ReturnType<StrategyAdapter<TRelay, TConfig>['announce']>
          > = undefined
          const isInitialAnnounce = !settledAnnounces.has(i)

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
              settledAnnounces.add(i)
            }
          } catch (error) {
            if (
              didLeaveRoom ||
              isLeavingRoom ||
              announceGenerations[i] !== gen
            ) {
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
              settledAnnounces.add(i)
              if (
                !anyInitialAnnounceSucceeded &&
                totalRelays > 0 &&
                new Set([...settledAnnounces, ...failedBootRelays]).size >=
                  totalRelays
              ) {
                reportAllRelaysFailed(error)
              }
            }
          }

          if (didLeaveRoom || isLeavingRoom || announceGenerations[i] !== gen) {
            return
          }

          if (typeof announceResult === 'number') {
            announceIntervals[i] = announceResult
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
          const warmupDelay =
            announceWarmupIntervalsMs[announceAttempt] ??
            (announceAttempt === 3 && typeof announceResult === 'object'
              ? announceIntervalMs
              : undefined)
          const nextAnnounceDelayMs =
            typeof warmupDelay === 'number'
              ? Math.min(currentInterval, warmupDelay)
              : currentInterval

          const timer = setTimeout(() => {
            void queueAnnounce(relay, i, gen)
          }, nextAnnounceDelayMs)
          unrefTimer(timer)
          announceTimeouts[i] = timer
        }

        requeueAnnounce = () => {
          announceTimeouts.forEach(resetTimer)
          announceTimeouts.length = 0

          for (const i of healthySubscribedRelays) {
            const nextGen = (announceGenerations[i] ?? 0) + 1
            announceGenerations[i] = nextGen
            void initPromises[i]?.then(relay => {
              if (
                relay &&
                !didLeaveRoom &&
                !isLeavingRoom &&
                announceGenerations[i] === nextGen
              ) {
                announceAttemptCounts[i] = 0
                void queueAnnounce(relay, i, nextGen)
              }
            }, noOp)
          }
        }

        unsubFns.forEach((didSub, i) => {
          void didSub.then(cleanup => {
            if (didLeaveRoom || isLeavingRoom || cleanup === noOp) {
              return
            }
            const gen = announceGenerations[i] ?? 0
            void initPromises[i]?.then(relay => {
              if (
                relay &&
                !didLeaveRoom &&
                !isLeavingRoom &&
                announceGenerations[i] === gen
              ) {
                void queueAnnounce(relay, i, gen)
              }
            }, noOp)
          }, noOp)
        })
      }, noOp)
    }

    let onPeerConnect = noOp as (peer: PeerHandle, peerId: string) => void

    const deleteRoomSlot = (
      map: Record<string, Record<string, unknown>>,
      target: unknown
    ): void => {
      const appMap = map[appId]
      if (!appMap) {
        return
      }
      if (appMap[roomId] === target) {
        delete appMap[roomId]
      }
      if (effectiveRoomId !== roomId && appMap[effectiveRoomId] === target) {
        delete appMap[effectiveRoomId]
      }
      if (!keys(appMap).length) {
        delete map[appId]
      }
    }

    const stopRelays = (): void => {
      announceTimeouts.forEach(resetTimer)
      healthySubscribedRelays.clear()
      unsubFns.forEach(f => {
        void f.then(cleanup => cleanup(), noOp)
      })
      destroyOffers()
    }

    const cleanupRoom = (): void => {
      if (didLeaveRoom) {
        return
      }

      didLeaveRoom = true
      onPeerConnect = noOp

      deleteRoomSlot(occupiedRooms, joinedRoom)
      deleteRoomSlot(leavingRoomCleanups, cleanupRoom)

      entries(peerStates).forEach(([, state]) => {
        if (state.connectedPeer && !state.connectedPeer.isDead) {
          state.connectedPeer.destroy()
        }

        if (state.answeringPeer && !state.answeringPeer.isDead) {
          state.answeringPeer.destroy()
        }

        resetOfferState(state)
        resetAnsweringState(state)
        state.connectedPeer = null
        state.unhealthySince = null
      })

      stopRelays()
    }

    occupiedRooms[appId] ??= {}

    let joinedRoom: RoomWithPlugins<TPlugins>
    try {
      const [createdRoom, createdBridge] = createRoomWithBridge(
        f => (onPeerConnect = f),
        (id, shouldReannounce = true) => {
          if (didLeaveRoom) {
            return
          }

          const state = peerStates[id]

          if (state?.connectedPeer) {
            detachConnectedPeer(state, state.connectedPeer)
          }

          prunePeerStates(peerStates)
          if (shouldReannounce) {
            // Shared-peer close handlers reach the room callback, not disconnectPeer.
            reannounceAfterDisconnect()
          }
        },
        cleanupRoom,
        {
          endpointIdentity: localEndpointP,
          clientId,
          appId,
          roomId,
          ...(effectiveRoomIdP === undefined ? {} : {effectiveRoomIdP}),
          ...(effectiveConfig.password === undefined
            ? {}
            : {password: effectiveConfig.password}),
          ...(effectiveConfig.maxUsers === undefined
            ? {}
            : {maxUsers: effectiveConfig.maxUsers}),
          ...(plugins.length > 0
            ? {
                use: plugins,
                ...(preResolvedPlugins ? {preResolvedPlugins} : {})
              }
            : {}),
          didResolvePluginRoomIds: true,
          userIdentityP,
          ...(effectiveConfig.maxReceiveBytes === undefined
            ? {}
            : {maxReceiveBytes: effectiveConfig.maxReceiveBytes}),
          onBeforeLeave: () => {
            isLeavingRoom = true
            announceTimeouts.forEach(resetTimer)
            announceTimeouts.length = 0
            deleteRoomSlot(occupiedRooms, joinedRoom)
            const appCleanups = (leavingRoomCleanups[appId] ??= {})
            appCleanups[roomId] = cleanupRoom
            if (effectiveRoomId !== roomId) {
              appCleanups[effectiveRoomId] = cleanupRoom
            }
          }
        }
      )
      joinedRoom = createdRoom as RoomWithPlugins<TPlugins>
      activeBridge = createdBridge
    } catch (err) {
      didLeaveRoom = true
      stopRelays()
      throw err
    }

    activeBridge.setOnScaleTargetsChanged(missingTargets => {
      if (!didLeaveRoom && !isLeavingRoom) {
        missingTargets.forEach(dialPeer)
      }
    })

    return (occupiedRooms[appId][roomId] =
      joinedRoom) as RoomWithPlugins<TPlugins>
  }) as JoinRoom<TConfig>
}
