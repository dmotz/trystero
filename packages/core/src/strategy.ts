import {decrypt, encrypt, genKey, hashTopic} from './crypto'
import {createIdentityClientId, validateIdentityConfig} from './identity'
import type {
  BaseRoomConfig,
  JoinRoom,
  PeerHandle,
  PeerState,
  Signal,
  StrategyAdapter,
  StrategyContext,
  Timeout
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
  unreachable,
  unrefTimer,
  warn
} from './utils'

const announceIntervalMs = 5_333
const announceWarmupIntervalsMs = [233, 533, 1_333] as const

type RoomRegistrySlot =
  | {readonly phase: 'occupied'; readonly room: Room}
  | {readonly phase: 'leaving'; readonly finalizeCleanup: () => void}

type StrategyRoomState =
  | {readonly phase: 'active'}
  | {readonly phase: 'leaving-flush'}
  | {readonly phase: 'left'; readonly relaysStopped: boolean}

type RelayHealthReportState = 'unconfirmed' | 'healthy' | 'error-reported'

type RelaySubscriptionState =
  | {readonly phase: 'booting'}
  | {readonly phase: 'boot-failed'}
  | {readonly phase: 'subscribing'}
  | {readonly phase: 'subscribed'; readonly unsub: () => void}
  | {readonly phase: 'closed'}

type InitialAnnounceOutcome = 'pending' | 'succeeded' | 'failed'

type RelayAnnounceState =
  | {readonly phase: 'waiting'}
  | {readonly phase: 'active'; timer: Timeout | null}
  | {readonly phase: 'closed'}

type RelaySlot<TRelay> = {
  readonly rawItem: unknown
  readonly relayP: Promise<TRelay>
  leaseReleased: boolean
  subscription: RelaySubscriptionState
  announce: RelayAnnounceState
  gen: number
  intervalMs: number
  attempts: number
  errors: number
  initial: InitialAnnounceOutcome
}

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
  const roomRegistry = new Map<string, Map<string, RoomRegistrySlot>>()

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

    const existingSlot = roomRegistry.get(appId)?.get(roomId)
    if (existingSlot?.phase === 'occupied') {
      throw mkErr(`already joined room "${roomId}" for appId "${appId}"`)
    }
    if (existingSlot?.phase === 'leaving') {
      existingSlot.finalizeCleanup()
    }

    let roomState: StrategyRoomState = {phase: 'active'}
    let relayHealthState: RelayHealthReportState = 'unconfirmed'
    let effectiveRoomId = roomId
    let resolvedSelfId: string | undefined
    let onPeerConnect = noOp as (peer: PeerHandle, peerId: string) => void
    let reannounceAfterDisconnect = noOp
    let stopRelays = noOp

    const isRoomInactive = (): boolean => roomState.phase !== 'active'

    const peerStates = new Map<string, PeerState>()
    const announceIntervals: number[] = []
    const topicFor = (rid: string): string => topicPath(libName, appId, rid)

    const deleteRegistrySlotMatching = (
      predicate: (slot: RoomRegistrySlot) => boolean
    ): void => {
      const appMap = roomRegistry.get(appId)
      if (!appMap) {
        return
      }
      const initialSlot = appMap.get(roomId)
      if (initialSlot && predicate(initialSlot)) {
        appMap.delete(roomId)
      }
      if (effectiveRoomId !== roomId) {
        const effectiveSlot = appMap.get(effectiveRoomId)
        if (effectiveSlot && predicate(effectiveSlot)) {
          appMap.delete(effectiveRoomId)
        }
      }
      if (appMap.size === 0) {
        roomRegistry.delete(appId)
      }
    }

    const cleanupRoom = (): void => {
      if (roomState.phase === 'left') {
        return
      }

      roomState = {phase: 'left', relaysStopped: false}
      onPeerConnect = noOp

      deleteRegistrySlotMatching(
        slot =>
          (slot.phase === 'occupied' && slot.room === joinedRoom) ||
          (slot.phase === 'leaving' && slot.finalizeCleanup === cleanupRoom)
      )

      for (const state of peerStates.values()) {
        if (state.connectedPeer && !state.connectedPeer.isDead) {
          state.connectedPeer.destroy()
        }

        if (state.answeringPeer && !state.answeringPeer.isDead) {
          state.answeringPeer.destroy()
        }

        resetOfferState(state)
        resetAnsweringState(state)
        state.connection = {phase: 'disconnected'}
      }
      peerStates.clear()

      stopRelays()
    }

    const cancelAllAnnounceTimers = (slots: RelaySlot<TRelay>[]): void => {
      for (const slot of slots) {
        if (slot.announce.phase === 'active') {
          slot.announce.timer = resetTimer(slot.announce.timer)
        }
      }
    }

    let relaySlots: RelaySlot<TRelay>[] = []

    const [joinedRoom, bridge] = createRoomWithBridge(
      f => {
        onPeerConnect = f
      },
      (id, shouldReannounce = true) => {
        if (roomState.phase === 'left') {
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
          if (roomState.phase === 'active') {
            roomState = {phase: 'leaving-flush'}
          }
          cancelAllAnnounceTimers(relaySlots)
          const appSlots = getOrCreateAppMap(roomRegistry, appId)
          const leavingSlot: RoomRegistrySlot = {
            phase: 'leaving',
            finalizeCleanup: cleanupRoom
          }
          const curInitial = appSlots.get(roomId)
          if (
            !curInitial ||
            curInitial.phase !== 'occupied' ||
            curInitial.room === joinedRoom
          ) {
            appSlots.set(roomId, leavingSlot)
          }
          if (effectiveRoomId !== roomId) {
            const curEffective = appSlots.get(effectiveRoomId)
            if (
              !curEffective ||
              curEffective.phase !== 'occupied' ||
              curEffective.room === joinedRoom
            ) {
              appSlots.set(effectiveRoomId, leavingSlot)
            }
          }
        }
      }
    )

    try {
      const selfIdP = bridge.localEndpointP.then(ep => ep.peerId)
      void selfIdP.catch(noOp)

      const emitError = (error: RoomError): void => {
        if (roomState.phase !== 'left') {
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
        if (rid !== roomId && roomState.phase === 'active') {
          const appSlots = getOrCreateAppMap(roomRegistry, appId)
          const existingEffective = appSlots.get(rid)
          if (existingEffective?.phase === 'leaving') {
            existingEffective.finalizeCleanup()
          }
          if (!appSlots.has(rid)) {
            appSlots.set(rid, {phase: 'occupied', room: joinedRoom})
          }
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
      let disconnectReannounceEnabled = false
      let disconnectReannounceQueued = false
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
        if (isRoomInactive()) {
          peer.destroy()
          return
        }

        const state = getState(peerStates, peerId)

        if (state.connectedPeer && state.connectedPeer !== peer) {
          if (getConnectedPeerHealth(state.connectedPeer) !== 'stale') {
            peer.destroy()
            return
          }

          clearConnectedPeer(state)
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

      reannounceAfterDisconnect = () => {
        syncOverlayNeighbors()
        if (
          isPassive ||
          !disconnectReannounceEnabled ||
          disconnectReannounceQueued
        ) {
          return
        }
        // Several peers can close together. Start only one warmup per room.
        disconnectReannounceQueued = true
        queueMicrotask(() => {
          disconnectReannounceQueued = false
          if (roomState.phase === 'active') {
            requeueAnnounce()
          }
        })
      }

      const disconnectPeer = (peer: PeerHandle, peerId: string): void => {
        if (roomState.phase === 'left') {
          return
        }

        const state = peerStates.get(peerId)

        if (state?.connectedPeer === peer) {
          clearConnectedPeer(state)
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
        isLeaving: isRoomInactive,
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
        if (isRoomInactive() || isPassive || !scaleProvider) {
          return
        }
        for (const targetId of scaleProvider.getTargetNeighbors()) {
          dialPeer(targetId)
        }
      }

      const initRes = init(effectiveConfig)
      const rawInitItems = Array.isArray(initRes) ? initRes : [initRes]
      relaySlots = rawInitItems.map(rawItem => {
        const relayP = Promise.resolve(rawItem)
        void relayP.catch(noOp)
        return {
          rawItem,
          relayP,
          leaseReleased: false,
          subscription: {phase: 'booting'},
          announce: {phase: 'waiting'},
          gen: 0,
          intervalMs: announceIntervalMs,
          attempts: 0,
          errors: 0,
          initial: 'pending' as InitialAnnounceOutcome
        }
      })

      const releaseSlotLease = (slot: RelaySlot<TRelay>): void => {
        if (!slot.leaseReleased) {
          slot.leaseReleased = true
          releaseRelayLease(slot.rawItem)
        }
      }

      stopRelays = () => {
        if (roomState.phase === 'left' && roomState.relaysStopped) {
          return
        }
        roomState = {phase: 'left', relaysStopped: true}
        cancelAllAnnounceTimers(relaySlots)
        for (const slot of relaySlots) {
          const prevSub = slot.subscription
          slot.subscription = {phase: 'closed'}
          slot.gen += 1
          slot.announce = {phase: 'closed'}
          if (prevSub.phase === 'subscribed') {
            prevSub.unsub()
          }
          if (prevSub.phase !== 'subscribing') {
            releaseSlotLease(slot)
          }
        }
        destroyOffers()
      }

      const totalRelays = relaySlots.length

      const reportAllRelaysFailed = (cause: unknown): void => {
        if (
          relayHealthState === 'error-reported' ||
          bridge.hasSetupFailed() ||
          isRoomInactive()
        ) {
          return
        }
        relayHealthState = 'error-reported'
        queueMicrotask(() => {
          if (!isRoomInactive() && !bridge.hasSetupFailed()) {
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

      const maybeReportAllBootFailed = (err: unknown): void => {
        if (
          relayHealthState === 'unconfirmed' &&
          totalRelays > 0 &&
          relaySlots.every(s => s.subscription.phase === 'boot-failed')
        ) {
          reportAllRelaysFailed(err)
        }
      }

      const markRelayBootFailed = (
        slot: RelaySlot<TRelay>,
        err: unknown
      ): void => {
        switch (slot.subscription.phase) {
          case 'booting':
          case 'subscribing':
            slot.subscription = {phase: 'boot-failed'}
            maybeReportAllBootFailed(err)
            return
          case 'subscribed':
          case 'closed':
          case 'boot-failed':
            return
          default:
            unreachable(slot.subscription)
        }
      }

      relaySlots.forEach(slot => {
        const getInitialFailure = (
          slot.relayP as Promise<TRelay> & {
            [socketInitialFailureSymbol]?: () => Promise<Error | null>
          }
        )[socketInitialFailureSymbol]
        if (typeof getInitialFailure === 'function') {
          void getInitialFailure().then(err => {
            if (err) {
              markRelayBootFailed(slot, err)
            }
          })
        }
      })

      const unsubFns = relaySlots.map(async (slot, i) => {
        let rootTopic: string
        let selfTopic: string
        try {
          ;[rootTopic, selfTopic] = await all([rootTopicP, selfTopicP])
        } catch {
          slot.subscription = {phase: 'closed'}
          releaseSlotLease(slot)
          return noOp
        }
        if (isRoomInactive()) {
          slot.subscription = {phase: 'closed'}
          releaseSlotLease(slot)
          return noOp
        }
        let relay: TRelay
        try {
          relay = await slot.relayP
        } catch (err) {
          markRelayBootFailed(slot, err)
          releaseSlotLease(slot)
          return noOp
        }
        if (isRoomInactive()) {
          slot.subscription = {phase: 'closed'}
          releaseSlotLease(slot)
          return noOp
        }
        slot.subscription = {phase: 'subscribing'}
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
          // Re-read slot.subscription across the await (stopRelays may have closed it).
          const isClosedAfterAwait = (s: {
            readonly subscription: RelaySubscriptionState
          }): boolean => s.subscription.phase === 'closed'
          if (isRoomInactive() || isClosedAfterAwait(slot)) {
            unsub()
            slot.subscription = {phase: 'closed'}
            releaseSlotLease(slot)
            return noOp
          }
          slot.subscription = {phase: 'subscribed', unsub}
          if (relayHealthState === 'unconfirmed') {
            relayHealthState = 'healthy'
          }
          return unsub
        } catch (err) {
          slot.subscription = {phase: 'boot-failed'}
          releaseSlotLease(slot)
          maybeReportAllBootFailed(err)
          return noOp
        }
      })

      if (!isPassive) {
        void all([rootTopicP, selfTopicP]).then(([rootTopic, selfTopic]) => {
          if (isRoomInactive()) {
            return
          }

          const isSlotActive = (
            slot: {readonly announce: RelayAnnounceState; readonly gen: number},
            gen: number
          ): boolean =>
            !isRoomInactive() &&
            slot.announce.phase === 'active' &&
            slot.gen === gen

          const queueAnnounce = async (
            relay: TRelay,
            slot: RelaySlot<TRelay>,
            i: number,
            gen: number
          ): Promise<void> => {
            if (!isSlotActive(slot, gen)) {
              return
            }

            let announceResult: Awaited<
              ReturnType<StrategyAdapter<TRelay, TConfig>['announce']>
            > = undefined
            const isInitial = slot.initial === 'pending'

            try {
              announceResult = await announce(
                relay,
                rootTopic,
                selfTopic,
                strategyContext
              )
              slot.errors = 0
              if (isInitial) {
                slot.initial = 'succeeded'
              }
            } catch (error) {
              if (isRoomInactive() || slot.announce.phase === 'closed') {
                return
              }

              if (
                slot.errors === 0 &&
                effectiveConfig.relayConfig?.warnOnRelayFailure !== false
              ) {
                warn(`announce failed - ${toErrorMessage(error, '')}`)
              }

              slot.errors += 1
              if (isInitial) {
                slot.initial = 'failed'
                const anyInitialSucceeded = relaySlots.some(
                  s => s.initial === 'succeeded'
                )
                const allSettledOrBootFailed =
                  totalRelays > 0 &&
                  relaySlots.every(
                    s =>
                      s.subscription.phase === 'boot-failed' ||
                      (s.announce.phase !== 'waiting' &&
                        s.initial !== 'pending')
                  )
                if (!anyInitialSucceeded && allSettledOrBootFailed) {
                  reportAllRelaysFailed(error)
                }
              }
            }

            if (!isSlotActive(slot, gen)) {
              return
            }

            // Only explicit numeric relay pacing overrides the signaling retry default.
            if (typeof announceResult === 'number') {
              announceIntervals[i] = announceResult
              slot.intervalMs = announceResult
            } else if (
              typeof announceResult === 'object' &&
              announceResult !== null
            ) {
              if ('stopAnnouncing' in announceResult) {
                slot.announce = {phase: 'closed'}
                return
              }
              slot.intervalMs = announceResult.nextAnnounceMs
              disconnectReannounceEnabled ||=
                announceResult.reannounceOnDisconnect === true
            }

            const attempt = slot.attempts++
            const warmupDelay =
              announceWarmupIntervalsMs[attempt] ??
              (attempt === 3 && typeof announceResult === 'object'
                ? announceIntervalMs
                : undefined)
            const delayMs =
              typeof warmupDelay === 'number'
                ? Math.min(slot.intervalMs, warmupDelay)
                : slot.intervalMs

            const timer = setTimeout(() => {
              if (
                slot.announce.phase === 'active' &&
                slot.announce.timer === timer
              ) {
                slot.announce.timer = null
              }
              void queueAnnounce(relay, slot, i, gen)
            }, delayMs)
            unrefTimer(timer)
            if (slot.announce.phase === 'active') {
              slot.announce.timer = timer
            } else {
              clearTimeout(timer)
            }
          }

          requeueAnnounce = () => {
            cancelAllAnnounceTimers(relaySlots)

            relaySlots.forEach((slot, i) => {
              if (
                slot.subscription.phase !== 'subscribed' ||
                slot.announce.phase === 'closed'
              ) {
                return
              }
              const nextGen = ++slot.gen
              slot.attempts = 0
              slot.announce = {phase: 'active', timer: null}

              void slot.relayP.then(relay => {
                if (relay && isSlotActive(slot, nextGen)) {
                  void queueAnnounce(relay, slot, i, nextGen)
                }
              }, noOp)
            })
          }

          unsubFns.forEach((didSub, i) => {
            const slot = relaySlots[i]
            if (!slot) {
              return
            }
            void didSub.then(cleanup => {
              if (
                isRoomInactive() ||
                cleanup === noOp ||
                slot.announce.phase !== 'waiting'
              ) {
                return
              }
              const {gen} = slot
              slot.announce = {phase: 'active', timer: null}
              void slot.relayP.then(relay => {
                if (relay && isSlotActive(slot, gen)) {
                  void queueAnnounce(relay, slot, i, gen)
                }
              }, noOp)
            }, noOp)
          })
        }, noOp)
      }

      bridge.setOnScaleTargetsChanged(targetIds => {
        if (!isRoomInactive() && !isPassive) {
          for (const targetId of targetIds) {
            dialPeer(targetId)
          }
        }
      })

      getOrCreateAppMap(roomRegistry, appId).set(roomId, {
        phase: 'occupied',
        room: joinedRoom
      })
      return joinedRoom as RoomWithPlugins<TPlugins>
    } catch (err) {
      roomState = {phase: 'left', relaysStopped: false}
      stopRelays()
      void joinedRoom.leave().catch(noOp)
      throw err
    }
  }) as JoinRoom<TConfig>
}
