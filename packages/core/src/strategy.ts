import {decrypt, encrypt, genKey, hashTopic} from './crypto'
import {createIdentityClientId, validateIdentityConfig} from './identity'
import type {
  BaseRoomConfig,
  JoinRoom,
  PeerHandle,
  PeerState,
  Signal,
  StrategyAdapter,
  StrategyContext
} from './internal-types'
import {createOfferManager} from './offer-manager'
import initPeer from './peer'
import {socketInitialFailureSymbol} from './primitives'
import {releaseRelayLease} from './relay-manager'
import {createRoomWithBridge} from './room'
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
  JoinRoomConfig,
  Room,
  RoomError,
  RoomWithPlugins
} from './types'
import {
  all,
  entries,
  isPosSafeInt,
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

const getOrCreateAppMap = <T>(
  map: Map<string, Map<string, T>>,
  appId: string
): Map<string, T> => {
  let appMap = map.get(appId)
  if (!appMap) {
    appMap = new Map()
    map.set(appId, appMap)
  }
  return appMap
}

export default <TRelay, TConfig extends BaseRoomConfig = JoinRoomConfig>({
  defaultConfig,
  init,
  subscribe,
  announce
}: StrategyAdapter<TRelay, TConfig>): JoinRoom<TConfig> => {
  const clientId = createIdentityClientId()
  const occupiedRooms = new Map<string, Map<string, Room>>()
  const leavingRoomCleanups = new Map<string, Map<string, () => void>>()

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

    if (occupiedRooms.get(appId)?.has(roomId)) {
      throw mkErr(`already joined room "${roomId}" for appId "${appId}"`)
    }

    leavingRoomCleanups.get(appId)?.get(roomId)?.()

    let didLeaveRoom = false
    let isLeavingRoom = false
    let didReportRelayError = false
    let effectiveRoomId = roomId
    let resolvedSelfId: string | undefined
    let onPeerConnect = noOp as (peer: PeerHandle, peerId: string) => void
    let reannounceAfterDisconnect = noOp
    let stopRelays = noOp

    const peerStates = new Map<string, PeerState>()
    const announceIntervals: number[] = []
    const announceTimeouts: Array<ReturnType<typeof setTimeout> | undefined> =
      []
    const healthySubscribedRelays = new Set<number>()
    const topicFor = (rid: string): string => topicPath(libName, appId, rid)

    const deleteRoomSlot = <T>(
      map: Map<string, Map<string, T>>,
      target: T
    ): void => {
      const appMap = map.get(appId)
      if (!appMap) {
        return
      }
      if (appMap.get(roomId) === target) {
        appMap.delete(roomId)
      }
      if (
        effectiveRoomId !== roomId &&
        appMap.get(effectiveRoomId) === target
      ) {
        appMap.delete(effectiveRoomId)
      }
      if (appMap.size === 0) {
        map.delete(appId)
      }
    }

    const cleanupRoom = (): void => {
      if (didLeaveRoom) {
        return
      }

      didLeaveRoom = true
      onPeerConnect = noOp

      deleteRoomSlot(occupiedRooms, joinedRoom)
      deleteRoomSlot(leavingRoomCleanups, cleanupRoom)

      for (const state of peerStates.values()) {
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
      }
      peerStates.clear()

      stopRelays()
    }

    const [joinedRoom, bridge] = createRoomWithBridge(
      f => {
        onPeerConnect = f
      },
      (id, shouldReannounce = true) => {
        if (didLeaveRoom) {
          return
        }

        const state = peerStates.get(id)

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
        clientId,
        appId,
        roomId,
        ...(effectiveConfig.password === undefined
          ? {}
          : {password: effectiveConfig.password}),
        ...(effectiveConfig.maxUsers === undefined
          ? {}
          : {maxUsers: effectiveConfig.maxUsers}),
        ...(effectiveConfig.use === undefined
          ? {}
          : {use: effectiveConfig.use}),
        ...(effectiveConfig.identity === undefined
          ? {}
          : {identity: effectiveConfig.identity}),
        ...(effectiveConfig.maxReceiveBytes === undefined
          ? {}
          : {maxReceiveBytes: effectiveConfig.maxReceiveBytes}),
        onBeforeLeave: () => {
          isLeavingRoom = true
          announceTimeouts.forEach(resetTimer)
          announceTimeouts.length = 0
          deleteRoomSlot(occupiedRooms, joinedRoom)
          const appCleanups = getOrCreateAppMap(leavingRoomCleanups, appId)
          appCleanups.set(roomId, cleanupRoom)
          if (effectiveRoomId !== roomId) {
            appCleanups.set(effectiveRoomId, cleanupRoom)
          }
        }
      }
    )

    try {
      const selfIdP = bridge.localEndpointP.then(ep => ep.peerId)
      void selfIdP.catch(noOp)

      const emitError = (error: RoomError): void => {
        if (!didLeaveRoom) {
          bridge.emitError(error)
        }
      }

      const strategyContext: StrategyContext<TConfig> = {
        config: effectiveConfig,
        appId,
        roomId,
        peerId: ''
      }

      const effectiveRoomIdP = bridge.effectiveRoomIdP?.then(rid => {
        effectiveRoomId = rid
        strategyContext.roomId = rid
        if (rid !== roomId && !didLeaveRoom && !isLeavingRoom) {
          leavingRoomCleanups.get(appId)?.get(rid)?.()
          getOrCreateAppMap(occupiedRooms, appId).set(rid, joinedRoom)
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
      reannounceAfterDisconnect = () => {
        syncOverlayNeighbors()
        if (
          isPassive ||
          !reannounceOnDisconnect ||
          disconnectReannounceQueued
        ) {
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

        const state = peerStates.get(peerId)

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
            bridge.canConnectPeer(peerId) &&
            bridge.getScaleProvider()?.notePeerDiscovered(peerId)
          ) {
            syncOverlayNeighbors()
          }
        },
        shouldConnectPeer: (peerId, direction) =>
          bridge.canConnectPeer(peerId) &&
          (bridge.getScaleProvider()?.shouldConnectPeer(peerId, direction) ??
            true)
      })

      syncOverlayNeighbors = () => {
        const scaleProvider = bridge.getScaleProvider()
        if (didLeaveRoom || isLeavingRoom || isPassive || !scaleProvider) {
          return
        }
        for (const targetId of scaleProvider.getTargetNeighbors()) {
          dialPeer(targetId)
        }
      }

      const initRes = init(effectiveConfig)
      const rawInitItems = Array.isArray(initRes) ? initRes : [initRes]
      const initPromises: Promise<TRelay>[] = rawInitItems.map(value => {
        const p = Promise.resolve(value)
        void p.catch(noOp)
        return p
      })
      const resolvedUnsubs: Array<(() => void) | undefined> = []
      const subscribingInFlight: boolean[] = []
      let didStopRelays = false

      stopRelays = () => {
        if (didStopRelays) {
          return
        }
        didStopRelays = true
        announceTimeouts.forEach(resetTimer)
        healthySubscribedRelays.clear()
        for (let i = 0; i < rawInitItems.length; i++) {
          const unsub = resolvedUnsubs[i]
          resolvedUnsubs[i] = undefined
          unsub?.()
          if (!subscribingInFlight[i]) {
            releaseRelayLease(rawInitItems[i])
          }
        }
        destroyOffers()
      }

      // Only explicit numeric relay pacing overrides the signaling retry default.
      const announceScheduleIntervals = initPromises.map(
        () => announceIntervalMs
      )
      const announceAttemptCounts = initPromises.map(() => 0)
      const announceErrorStreaks = initPromises.map(() => 0)
      const announceGenerations = initPromises.map(() => 0)

      const totalRelays = initPromises.length
      const failedBootRelays = new Set<number>()
      let anyRelayBootHealthy = false
      const reportAllRelaysFailed = (cause: unknown): void => {
        if (
          didReportRelayError ||
          bridge.hasSetupFailed() ||
          didLeaveRoom ||
          isLeavingRoom
        ) {
          return
        }
        didReportRelayError = true
        queueMicrotask(() => {
          if (!didLeaveRoom && !isLeavingRoom && !bridge.hasSetupFailed()) {
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
        if (didStopRelays || didLeaveRoom || isLeavingRoom) {
          return noOp
        }
        let relay: TRelay
        try {
          relay = await relayP
        } catch (err) {
          markRelayFailed(i, err)
          return noOp
        }
        if (didStopRelays || didLeaveRoom || isLeavingRoom) {
          return noOp
        }
        subscribingInFlight[i] = true
        try {
          const unsub = await subscribe(
            relay,
            rootTopic,
            selfTopic,
            handleMessage(i),
            n =>
              selfIdP.then(sid =>
                getOffers(n, (peer, offerId) =>
                  encryptOffer(peer, sid, offerId)
                )
              ),
            strategyContext
          )
          if (didStopRelays || didLeaveRoom || isLeavingRoom) {
            unsub()
            if (didStopRelays) {
              releaseRelayLease(rawInitItems[i])
            }
            return noOp
          }
          resolvedUnsubs[i] = unsub
          failedBootRelays.delete(i)
          anyRelayBootHealthy = true
          healthySubscribedRelays.add(i)
          return unsub
        } catch (err) {
          if (didStopRelays) {
            releaseRelayLease(rawInitItems[i])
          }
          markRelayFailed(i, err)
          return noOp
        } finally {
          subscribingInFlight[i] = false
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
            if (
              didLeaveRoom ||
              isLeavingRoom ||
              announceGenerations[i] !== gen
            ) {
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

            if (
              didLeaveRoom ||
              isLeavingRoom ||
              announceGenerations[i] !== gen
            ) {
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

      bridge.setOnScaleTargetsChanged(targetIds => {
        if (!didLeaveRoom && !isLeavingRoom && !isPassive) {
          for (const targetId of targetIds) {
            dialPeer(targetId)
          }
        }
      })

      getOrCreateAppMap(occupiedRooms, appId).set(roomId, joinedRoom)
      return joinedRoom as RoomWithPlugins<TPlugins>
    } catch (err) {
      didLeaveRoom = true
      stopRelays()
      void joinedRoom.leave().catch(noOp)
      throw err
    }
  }) as JoinRoom<TConfig>
}
