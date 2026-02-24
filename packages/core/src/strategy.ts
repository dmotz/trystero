import {decrypt, encrypt, genKey, hashWith, sha1} from './crypto'
import initPeer from './peer'
import room from './room'
import {
  all,
  alloc,
  decodeBytes,
  encodeBytes,
  fromJson,
  genId,
  libName,
  mkErr,
  noOp,
  selfId,
  toHex,
  toJson,
  topicPath,
  watchOnline
} from './utils'
import type {
  BaseRoomConfig,
  HandshakeReceiver,
  HandshakeSender,
  JoinRoom,
  JoinRoomCallbacks,
  JoinRoomConfig,
  OfferRecord,
  PeerHandle,
  PeerHandshake,
  PeerHandlers,
  Signal,
  StrategyAdapter
} from './types'

const poolSize = 20
const announceIntervalMs = 5_333
const announceWarmupIntervalsMs = [233, 533, 1_033] as const
const offerTtl = 57_333
const offerRefreshAgeMs = offerTtl
const offerLeaseTtlMs = 180_000
const offerPostAnswerTtlMs = 9_000
const offerIdSize = 12
const disconnectedPeerGraceMs = 7_500
const answeringTtlMs = 8_000
const sharedPeerIdleMsDefault = 120_000
const candidateType = 'candidate'
const legacyCandidateKey = '__legacy__'
const roomFrameVersion = 1

type SharedRemoteTrackRef = {
  track: MediaStreamTrack
  stream: MediaStream
}

type SharedPeerBinding = {
  roomId: string
  handlers: PeerHandlers
  pendingData: ArrayBuffer[]
  pendingTracks: Array<{track: MediaStreamTrack; stream: MediaStream}>
  detach: () => void
  proxy: PeerHandle
}

type SharedPeerState = {
  appId: string
  peerId: string
  peer: PeerHandle
  bindings: Record<string, SharedPeerBinding>
  pendingDataByRoom: Map<string, ArrayBuffer[]>
  idleTimer: ReturnType<typeof setTimeout> | null
  controlRoomId: string | null
  streamOwners: Map<MediaStream, Set<string>>
  trackOwners: Map<MediaStreamTrack, {stream: MediaStream; rooms: Set<string>}>
  remoteStreamsByKey: Map<string, MediaStream>
  remoteTracksByKey: Map<string, SharedRemoteTrackRef>
  idleMs: number
  isClosing: boolean
}

type SharedMediaProxyPeer = PeerHandle & {
  __trysteroGetRemoteStreamByKey?: (key: string) => MediaStream | undefined
  __trysteroSetRemoteStreamByKey?: (key: string, stream: MediaStream) => void
  __trysteroGetRemoteTrackByKey?: (
    key: string
  ) => SharedRemoteTrackRef | undefined
  __trysteroSetRemoteTrackByKey?: (
    key: string,
    track: MediaStreamTrack,
    stream: MediaStream
  ) => void
}

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
  offerSignalRelays: Array<((signal: Signal) => void) | undefined>
  offerSignalBacklog: Signal[]
  offerRelayTimers: Array<ReturnType<typeof setTimeout> | undefined>
  offerExpiryTimer: ReturnType<typeof setTimeout> | null
  connectedPeer: PeerHandle | null
  connectedPeerUnhealthySinceMs: number | null
  answeringExpiryTimer: ReturnType<typeof setTimeout> | null
  answeringPeer: PeerHandle | null
  pendingCandidates: Record<string, Signal[]>
}

export default <TRelay, TConfig extends BaseRoomConfig = JoinRoomConfig>({
  init,
  subscribe,
  announce
}: StrategyAdapter<TRelay, TConfig>): JoinRoom<TConfig> => {
  const sharedPeersByApp: Record<string, Record<string, SharedPeerState>> = {}
  const occupiedRooms: Record<
    string,
    Record<string, ReturnType<typeof room>>
  > = {}

  const hasActiveRooms = (): boolean =>
    Object.values(occupiedRooms).some(rooms => Object.keys(rooms).length > 0)

  const wrapRoomFrame = (roomId: string, data: Uint8Array): Uint8Array => {
    const roomBytes = encodeBytes(roomId)
    const frame = new Uint8Array(3 + roomBytes.byteLength + data.byteLength)

    frame[0] = roomFrameVersion
    frame[1] = (roomBytes.byteLength >>> 8) & 0xff
    frame[2] = roomBytes.byteLength & 0xff
    frame.set(roomBytes, 3)
    frame.set(data, 3 + roomBytes.byteLength)

    return frame
  }

  const unwrapRoomFrame = (
    data: ArrayBuffer
  ): {roomId: string; payload: ArrayBuffer} | null => {
    const buffer = new Uint8Array(data)

    if (buffer.byteLength < 3 || buffer[0] !== roomFrameVersion) {
      return null
    }

    const roomSize = ((buffer[1] ?? 0) << 8) | (buffer[2] ?? 0)
    const headerSize = 3 + roomSize

    if (roomSize <= 0 || buffer.byteLength < headerSize) {
      return null
    }

    const roomId = decodeBytes(buffer.subarray(3, headerSize))
    const payload = buffer.subarray(headerSize)

    return {
      roomId,
      payload: payload.slice().buffer
    }
  }

  const leasedOfferPeers = new Map<PeerHandle, ReturnType<typeof setTimeout>>()
  const recyclingOfferPeers = new Set<PeerHandle>()
  const pooledOfferPeers = new Set<PeerHandle>()

  let didInit = false
  let initPromises: Promise<TRelay>[] = []
  let offerPool: PeerHandle[] = []
  let offerCleanupTimer: ReturnType<typeof setInterval> | null = null
  let cleanupWatchOnline: () => void = noOp

  return (config: TConfig, roomId: string, callbacks?: JoinRoomCallbacks) => {
    if (!config) {
      throw mkErr('requires a config map as the first argument')
    }

    if (callbacks && typeof callbacks !== 'object') {
      throw mkErr('third argument must be a callbacks object')
    }

    const debugLog = (...args: unknown[]): void => console.log(...args)
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

    const peerStates: Record<string, PeerState> = {}
    const offerPlaceholder = 'offer-placeholder'
    const rootTopicPlaintext = topicPath(libName, appId, roomId)
    const rootTopicP = sha1(rootTopicPlaintext)
    const selfTopicP = sha1(topicPath(rootTopicPlaintext, selfId))
    const key = genKey(config.password ?? '', appId, roomId)

    let didLeaveRoom = false

    const withKey =
      (f: (keyP: Promise<CryptoKey>, text: string) => Promise<string>) =>
      async (signal: Signal): Promise<Signal> => ({
        type: signal.type,
        sdp: await f(key, signal.sdp)
      })

    const toPlain = withKey(decrypt)
    const toCipher = withKey(encrypt)
    const sharedPeerMap = (sharedPeersByApp[appId] ??= {})
    const sharedPeerIdleMs =
      config._test_only_sharedPeerIdleMs ?? sharedPeerIdleMsDefault

    const isPeerStale = (peer: PeerHandle): boolean => {
      const {connection, channel} = peer

      return (
        peer.isDead ||
        connection.connectionState === 'closed' ||
        connection.connectionState === 'failed' ||
        connection.iceConnectionState === 'closed' ||
        connection.iceConnectionState === 'failed' ||
        channel?.readyState === 'closing' ||
        channel?.readyState === 'closed'
      )
    }

    const getSharedPeerHealth = (peer: PeerHandle): 'live' | 'stale' =>
      isPeerStale(peer) ? 'stale' : 'live'

    const clearSharedIdleTimer = (shared: SharedPeerState): void => {
      if (shared.idleTimer) {
        clearTimeout(shared.idleTimer)
        shared.idleTimer = null
      }
    }

    const pruneSharedRoomOwnership = (
      shared: SharedPeerState,
      roomIdToRemove: string
    ): void => {
      shared.streamOwners.forEach((rooms, stream) => {
        rooms.delete(roomIdToRemove)

        if (rooms.size === 0) {
          shared.streamOwners.delete(stream)
          shared.peer.removeStream(stream)
        }
      })

      shared.trackOwners.forEach((entry, track) => {
        entry.rooms.delete(roomIdToRemove)

        if (entry.rooms.size === 0) {
          shared.trackOwners.delete(track)
          shared.peer.removeTrack(track)
        }
      })
    }

    const clearSharedPeerState = (
      peerId: string,
      {destroyPeer}: {destroyPeer: boolean}
    ): void => {
      const shared = sharedPeerMap[peerId]

      if (!shared) {
        return
      }

      if (shared.isClosing) {
        return
      }

      clearSharedIdleTimer(shared)
      shared.isClosing = true

      if (destroyPeer && !shared.peer.isDead) {
        shared.peer.destroy()
      }

      const bindings = Object.values(shared.bindings)
      shared.bindings = {}
      shared.controlRoomId = null
      delete sharedPeerMap[peerId]

      bindings.forEach(binding => {
        binding.handlers.close?.()
        binding.pendingData.length = 0
        binding.pendingTracks.length = 0
      })

      shared.remoteStreamsByKey.clear()
      shared.remoteTracksByKey.clear()
      shared.pendingDataByRoom.clear()

      if (Object.keys(sharedPeerMap).length === 0) {
        delete sharedPeersByApp[appId]
      }
    }

    const scheduleSharedIdleTimer = (shared: SharedPeerState): void => {
      if (shared.isClosing || Object.keys(shared.bindings).length > 0) {
        return
      }

      clearSharedIdleTimer(shared)

      shared.idleTimer = setTimeout(() => {
        const current = sharedPeerMap[shared.peerId]

        if (!current || Object.keys(current.bindings).length > 0) {
          return
        }

        clearSharedPeerState(shared.peerId, {
          destroyPeer: true
        })
      }, shared.idleMs)
    }

    const getSharedSignalBinding = (
      shared: SharedPeerState
    ): SharedPeerBinding | null => {
      if (shared.controlRoomId) {
        const selected = shared.bindings[shared.controlRoomId]

        if (selected?.handlers.signal) {
          return selected
        }
      }

      const fallback = Object.values(shared.bindings).find(binding =>
        Boolean(binding.handlers.signal)
      )

      if (!fallback) {
        return null
      }

      shared.controlRoomId = fallback.roomId
      return fallback
    }

    const flushBindingQueues = (binding: SharedPeerBinding): void => {
      const {handlers} = binding

      if (handlers.data && binding.pendingData.length > 0) {
        const queued = binding.pendingData.splice(0)
        queued.forEach(payload => handlers.data?.(payload))
      }

      if ((handlers.track || handlers.stream) && binding.pendingTracks.length) {
        const queued = binding.pendingTracks.splice(0)
        queued.forEach(({track, stream}) => {
          handlers.track?.(track, stream)
          handlers.stream?.(stream)
        })
      }
    }

    const dispatchSharedData = (
      shared: SharedPeerState,
      data: ArrayBuffer
    ): void => {
      const decoded = unwrapRoomFrame(data)

      if (!decoded) {
        return
      }

      const binding = shared.bindings[decoded.roomId]

      if (!binding) {
        const pending = shared.pendingDataByRoom.get(decoded.roomId) ?? []
        pending.push(decoded.payload)
        shared.pendingDataByRoom.set(decoded.roomId, pending)
        return
      }

      if (binding.handlers.data) {
        binding.handlers.data(decoded.payload)
      } else {
        binding.pendingData.push(decoded.payload)
      }
    }

    const dispatchSharedSignal = (
      shared: SharedPeerState,
      signal: Signal
    ): void => {
      const binding = getSharedSignalBinding(shared)
      binding?.handlers.signal?.(signal)
    }

    const dispatchSharedTrack = (
      shared: SharedPeerState,
      track: MediaStreamTrack,
      stream: MediaStream
    ): void => {
      Object.values(shared.bindings).forEach(binding => {
        if (binding.handlers.track || binding.handlers.stream) {
          binding.handlers.track?.(track, stream)
          binding.handlers.stream?.(stream)
          return
        }

        binding.pendingTracks.push({track, stream})
      })
    }

    const registerSharedPeer = (
      peerId: string,
      peer: PeerHandle
    ): SharedPeerState => {
      const existing = sharedPeerMap[peerId]

      if (existing) {
        clearSharedIdleTimer(existing)

        if (existing.peer === peer) {
          return existing
        }

        clearSharedPeerState(peerId, {
          destroyPeer: true
        })
      }

      const shared: SharedPeerState = {
        appId,
        peerId,
        peer,
        bindings: {},
        pendingDataByRoom: new Map(),
        idleTimer: null,
        controlRoomId: null,
        streamOwners: new Map(),
        trackOwners: new Map(),
        remoteStreamsByKey: new Map(),
        remoteTracksByKey: new Map(),
        idleMs: sharedPeerIdleMs,
        isClosing: false
      }

      peer.setHandlers({
        data: data => dispatchSharedData(shared, data),
        signal: signal => dispatchSharedSignal(shared, signal),
        close: () =>
          clearSharedPeerState(peerId, {
            destroyPeer: false
          }),
        error: err => {
          console.error(`${libName} peer error:`, err)
          clearSharedPeerState(peerId, {destroyPeer: false})
        },
        track: (track, stream) => dispatchSharedTrack(shared, track, stream)
      })

      sharedPeerMap[peerId] = shared
      return shared
    }

    const bindRoomToSharedPeer = (
      peerId: string,
      shared: SharedPeerState,
      {
        onDetach
      }: {
        onDetach: () => void
      }
    ): {proxy: PeerHandle; isNew: boolean} => {
      const existingBinding = shared.bindings[roomId]

      if (existingBinding) {
        clearSharedIdleTimer(shared)
        return {proxy: existingBinding.proxy, isNew: false}
      }

      const binding: SharedPeerBinding = {
        roomId,
        handlers: {},
        pendingData: [],
        pendingTracks: [],
        detach: noOp,
        proxy: {} as PeerHandle
      }

      const detachBinding = (): void => {
        if (!shared.bindings[roomId]) {
          return
        }

        pruneSharedRoomOwnership(shared, roomId)
        delete shared.bindings[roomId]

        if (shared.controlRoomId === roomId) {
          shared.controlRoomId = Object.keys(shared.bindings)[0] ?? null
        }

        onDetach()
        scheduleSharedIdleTimer(shared)
      }

      const proxy: SharedMediaProxyPeer = {
        created: shared.peer.created,
        get connection() {
          return shared.peer.connection
        },
        get channel() {
          return shared.peer.channel
        },
        get isDead() {
          return shared.peer.isDead
        },
        getOffer: (restartIce?: boolean) => shared.peer.getOffer(restartIce),
        signal: (sdp: Signal) => shared.peer.signal(sdp),
        sendData: data => shared.peer.sendData(wrapRoomFrame(roomId, data)),
        destroy: () => detachBinding(),
        setHandlers: newHandlers => {
          const {signal, ...rest} = newHandlers

          Object.assign(binding.handlers, rest)

          if (signal) {
            binding.handlers.signal = signal
          }

          flushBindingQueues(binding)
        },
        offerPromise: shared.peer.offerPromise,
        addStream: stream => {
          const owners = shared.streamOwners.get(stream) ?? new Set<string>()
          const shouldAttach = owners.size === 0

          owners.add(roomId)
          shared.streamOwners.set(stream, owners)

          if (shouldAttach) {
            shared.peer.addStream(stream)
          }
        },
        removeStream: stream => {
          const owners = shared.streamOwners.get(stream)

          if (!owners) {
            return
          }

          owners.delete(roomId)

          if (owners.size === 0) {
            shared.streamOwners.delete(stream)
            shared.peer.removeStream(stream)
          }
        },
        addTrack: (track, stream) => {
          const entry = shared.trackOwners.get(track) ?? {
            stream,
            rooms: new Set<string>()
          }
          const shouldAttach = entry.rooms.size === 0

          entry.stream = stream
          entry.rooms.add(roomId)
          shared.trackOwners.set(track, entry)

          if (shouldAttach) {
            return shared.peer.addTrack(track, stream)
          }

          return (
            shared.peer.connection.getSenders().find(s => s.track === track) ??
            shared.peer.addTrack(track, stream)
          )
        },
        removeTrack: track => {
          const entry = shared.trackOwners.get(track)

          if (!entry) {
            return
          }

          entry.rooms.delete(roomId)

          if (entry.rooms.size === 0) {
            shared.trackOwners.delete(track)
            shared.peer.removeTrack(track)
          }
        },
        replaceTrack: (oldTrack, newTrack) => {
          const oldEntry = shared.trackOwners.get(oldTrack)

          if (oldEntry) {
            shared.trackOwners.delete(oldTrack)

            const nextEntry = shared.trackOwners.get(newTrack) ?? {
              stream: oldEntry.stream,
              rooms: new Set<string>()
            }

            oldEntry.rooms.forEach(room => nextEntry.rooms.add(room))
            shared.trackOwners.set(newTrack, nextEntry)
          }

          return shared.peer.replaceTrack(oldTrack, newTrack)
        },
        __trysteroGetRemoteStreamByKey: key =>
          shared.remoteStreamsByKey.get(key),
        __trysteroSetRemoteStreamByKey: (key, stream) =>
          void shared.remoteStreamsByKey.set(key, stream),
        __trysteroGetRemoteTrackByKey: key => shared.remoteTracksByKey.get(key),
        __trysteroSetRemoteTrackByKey: (key, track, stream) =>
          void shared.remoteTracksByKey.set(key, {track, stream})
      }

      binding.proxy = proxy
      binding.detach = detachBinding
      shared.bindings[roomId] = binding
      shared.controlRoomId ??= roomId
      clearSharedIdleTimer(shared)

      const pendingData = shared.pendingDataByRoom.get(roomId)

      if (pendingData?.length) {
        binding.pendingData.push(...pendingData)
        shared.pendingDataByRoom.delete(roomId)
      }

      return {proxy, isNew: true}
    }

    const makeOffer = (): PeerHandle => initPeer(true, config)

    const pushOfferToPool = (peer: PeerHandle): void => {
      if (
        peer.isDead ||
        pooledOfferPeers.has(peer) ||
        leasedOfferPeers.has(peer)
      ) {
        return
      }

      offerPool.push(peer)
      pooledOfferPeers.add(peer)
    }

    const shiftOffersFromPool = (n: number): PeerHandle[] => {
      const peers: PeerHandle[] = []

      while (peers.length < n && offerPool.length > 0) {
        const peer = offerPool.shift()

        if (!peer) {
          break
        }

        pooledOfferPeers.delete(peer)
        peers.push(peer)
      }

      return peers
    }

    const claimLeasedOfferPeer = (peer: PeerHandle): void => {
      const timer = leasedOfferPeers.get(peer)

      if (timer) {
        clearTimeout(timer)
        leasedOfferPeers.delete(peer)
      }
    }

    const recycleOfferPeer = (peer: PeerHandle): void => {
      if (peer.isDead || recyclingOfferPeers.has(peer)) {
        return
      }

      if (peer.connection.remoteDescription) {
        peer.destroy()
        return
      }

      if (!didInit) {
        peer.destroy()
        return
      }

      recyclingOfferPeers.add(peer)

      peer.setHandlers({
        connect: noOp,
        close: noOp,
        error: noOp
      })

      void peer
        .getOffer(true)
        .then(offer => {
          if (!offer || offer.type !== 'offer' || peer.isDead || !didInit) {
            peer.destroy()
            return
          }

          pushOfferToPool(peer)
        })
        .catch(() => peer.destroy())
        .finally(() => recyclingOfferPeers.delete(peer))
    }

    const reclaimLeasedOfferPeer = (peer: PeerHandle): void => {
      const timer = leasedOfferPeers.get(peer)

      if (!timer) {
        return
      }

      clearTimeout(timer)
      leasedOfferPeers.delete(peer)
      recycleOfferPeer(peer)
    }

    const leaseOfferPeer = (peer: PeerHandle): void => {
      claimLeasedOfferPeer(peer)

      leasedOfferPeers.set(
        peer,
        setTimeout(() => {
          leasedOfferPeers.delete(peer)
          recycleOfferPeer(peer)
        }, offerLeaseTtlMs)
      )
    }

    const getEncryptedOffer = async (peer: PeerHandle): Promise<string> => {
      const plainOffer = await peer.getOffer(
        Date.now() - peer.created > offerRefreshAgeMs
      )

      if (!plainOffer || plainOffer.type !== 'offer') {
        throw mkErr('failed to get offer for peer')
      }

      return (await toCipher(plainOffer)).sdp
    }

    const checkoutOffers = (
      n: number,
      leaseOffers: boolean
    ): Promise<OfferRecord[]> => {
      const peers = shiftOffersFromPool(n)
      const missingOffers = Math.max(0, n - peers.length)

      if (missingOffers > 0) {
        peers.push(...alloc(missingOffers, makeOffer))
      }

      const toOfferRecord = async (
        candidate: PeerHandle,
        didRetry = false
      ): Promise<OfferRecord> => {
        try {
          const offer = await getEncryptedOffer(candidate)

          if (leaseOffers) {
            leaseOfferPeer(candidate)

            return {
              peer: candidate,
              offer,
              claim: () => claimLeasedOfferPeer(candidate),
              reclaim: () => reclaimLeasedOfferPeer(candidate)
            }
          }

          return {peer: candidate, offer}
        } catch (err) {
          claimLeasedOfferPeer(candidate)
          pooledOfferPeers.delete(candidate)
          candidate.destroy()

          if (!didRetry) {
            return toOfferRecord(makeOffer(), true)
          }

          throw err
        }
      }

      return all(peers.map(peer => toOfferRecord(peer)))
    }

    const getOffers = (n: number): Promise<OfferRecord[]> =>
      checkoutOffers(n, true)

    const makeState = (): PeerState => ({
      status: 'idle',
      offerPeer: null,
      offerId: null,
      offerSdp: null,
      offerInitPromise: null,
      offerAnswered: false,
      offerRelays: [],
      offerSignalRelays: [],
      offerSignalBacklog: [],
      offerRelayTimers: [],
      offerExpiryTimer: null,
      connectedPeer: null,
      connectedPeerUnhealthySinceMs: null,
      answeringExpiryTimer: null,
      answeringPeer: null,
      pendingCandidates: {}
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

    const flushBufferedCandidates = async (
      state: PeerState,
      peer: PeerHandle,
      offerId?: string
    ): Promise<void> => {
      const keys = offerId
        ? [offerId, legacyCandidateKey]
        : [legacyCandidateKey]

      for (const key of keys) {
        const buffered = state.pendingCandidates[key]

        if (!buffered?.length) {
          continue
        }

        delete state.pendingCandidates[key]

        for (const candidate of buffered) {
          await peer.signal(candidate)
        }
      }
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

    const hasRemoteDescription = (peer: PeerHandle): boolean => {
      if (peer.isDead || peer.connection.connectionState === 'closed') {
        return true
      }

      try {
        return Boolean(peer.connection.remoteDescription)
      } catch {
        return true
      }
    }

    const resetOfferState = (state: PeerState): void => {
      const previousOfferAnswered = state.offerAnswered

      if (state.offerExpiryTimer) {
        clearTimeout(state.offerExpiryTimer)
        state.offerExpiryTimer = null
      }

      state.offerInitPromise = null
      state.offerRelays.forEach((_, relayId) => clearOfferRelay(state, relayId))
      state.offerRelays = []
      state.offerSignalRelays = []
      state.offerRelayTimers = []
      state.offerSignalBacklog = []

      if (state.offerPeer && state.offerPeer !== state.connectedPeer) {
        if (previousOfferAnswered || hasRemoteDescription(state.offerPeer)) {
          if (!state.offerPeer.isDead) {
            state.offerPeer.destroy()
          }
        } else {
          recycleOfferPeer(state.offerPeer)
        }
      }

      state.offerPeer = null
      state.offerId = null
      state.offerSdp = null
      state.offerAnswered = false
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
        const firstOffer = (await checkoutOffers(1, false))[0]

        if (!firstOffer) {
          throw mkErr('failed to allocate offer peer')
        }

        const {peer, offer} = firstOffer

        state.offerPeer = peer
        state.offerId = genId(offerIdSize)
        state.offerSdp = offer
        state.offerAnswered = false
        state.offerSignalBacklog = []
        updateStatus(state)

        peer.setHandlers({
          connect: () => connectPeer(peer, peerId, relayId),
          signal: signal => {
            if (state.offerPeer !== peer) {
              return
            }

            state.offerSignalBacklog.push(signal)
            state.offerSignalRelays.forEach(sendSignal => sendSignal?.(signal))
          },
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

    const attachSharedPeerToRoom = (
      peerId: string,
      shared: SharedPeerState
    ): void => {
      const state = getState(peerId)

      if (state.answeringExpiryTimer) {
        clearTimeout(state.answeringExpiryTimer)
        state.answeringExpiryTimer = null
      }

      state.answeringPeer = null

      const {proxy, isNew} = bindRoomToSharedPeer(peerId, shared, {
        onDetach: () => {
          const current = peerStates[peerId]

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

      resetOfferState(state)
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
        DEV: debugLog('already connected to', peerId, '- checking shared state')
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

      if (shared && getSharedPeerHealth(shared.peer) === 'stale') {
        clearSharedPeerState(peerId, {
          destroyPeer: true
        })
        shared = undefined
      }

      if (shared && shared.peer !== peer) {
        if (!peer.isDead) {
          peer.destroy()
        }

        DEV: debugLog('reusing existing shared peer for', peerId)
        attachSharedPeerToRoom(peerId, shared)
        return
      }

      if (!shared) {
        shared = registerSharedPeer(peerId, peer)
      }

      DEV: debugLog('peer connected:', peerId, relayId)

      attachSharedPeerToRoom(peerId, shared)
    }

    const getConnectedPeerHealth = (
      peer: PeerHandle
    ): 'live' | 'transient' | 'stale' => {
      const {channel} = peer
      const isStale = isPeerStale(peer)

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
        error: `incorrect room password when decrypting ${sdpType}`,
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
        const candidate = payload['candidate'] as string | undefined
        const offerId = payload['offerId'] as string | undefined
        const peer = payload['peer'] as PeerHandle | undefined
        const hasOutgoingOfferHint = payload['hasOutgoingOffer'] === true

        if (peerId === selfId) {
          return
        }

        const state = peerStates[peerId]
        const connectedPeer = state?.connectedPeer

        if (connectedPeer && state) {
          const health = getConnectedPeerHealth(connectedPeer)

          if (health === 'live') {
            state.connectedPeerUnhealthySinceMs = null
            // DEV: debugLog('ignoring message from connected peer:', peerId)
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

        let shared = sharedPeerMap[peerId]

        if (shared && getSharedPeerHealth(shared.peer) === 'stale') {
          clearSharedPeerState(peerId, {
            destroyPeer: true
          })
          shared = undefined
        }

        const isAnnouncement = Boolean(
          peerId && !offer && !answer && !candidate
        )

        if (isAnnouncement && !shared) {
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

          state.offerRelays[relayId] = offerPlaceholder
          updateStatus(state)
        }

        const [rootTopic, selfTopic] = await all([rootTopicP, selfTopicP])

        if (didLeaveRoom) {
          return
        }

        if (topic !== rootTopic && topic !== selfTopic) {
          if (
            isAnnouncement &&
            peerStates[peerId]?.offerRelays[relayId] === offerPlaceholder
          ) {
            clearOfferRelay(peerStates[peerId], relayId)
          }

          return
        }

        if (shared && isAnnouncement) {
          attachSharedPeerToRoom(peerId, shared)
          return
        }

        if (
          shared &&
          shared.bindings[roomId] &&
          (offer || answer || candidate)
        ) {
          DEV: debugLog(
            'ignoring room signal because shared binding already exists:',
            peerId
          )
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
            if (state?.offerRelays[relayId] === offerPlaceholder) {
              clearOfferRelay(state, relayId)
            }

            return
          }

          if (state.offerRelays[relayId] !== offerPlaceholder) {
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
            state.offerRelays[relayId] !== offerPlaceholder
          ) {
            if (state.offerRelays[relayId] === offerPlaceholder) {
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

          let didSendOffer = false

          state.offerSignalRelays[relayId] = signal => {
            if (!didSendOffer) {
              return
            }

            if (
              didLeaveRoom ||
              state.connectedPeer ||
              state.offerPeer !== offerInfo.peer ||
              state.offerId !== offerInfo.offerId ||
              signal.type !== candidateType
            ) {
              return
            }

            void toCipher(signal).then(encryptedSignal => {
              if (
                didLeaveRoom ||
                state.connectedPeer ||
                state.offerPeer !== offerInfo.peer ||
                state.offerId !== offerInfo.offerId
              ) {
                return
              }

              signalPeer(
                peerTopic,
                toJson({
                  peerId: selfId,
                  offerId: offerInfo.offerId,
                  candidate: encryptedSignal.sdp
                })
              )
            })
          }

          DEV: debugLog('sending offer to', peerId)

          signalPeer(
            peerTopic,
            toJson({
              peerId: selfId,
              offerId: offerInfo.offerId,
              offer: offerInfo.offer
            })
          )

          didSendOffer = true
          state.offerSignalBacklog.forEach(signal =>
            state.offerSignalRelays[relayId]?.(signal)
          )
        } else if (offer) {
          const state = getState(peerId)

          if (state.answeringPeer || state.offerAnswered) {
            return
          }

          const hasTrackedOutgoingOffer = Boolean(
            state.offerPeer || state.offerRelays.some(Boolean)
          )
          const hasOutgoingOffer =
            hasTrackedOutgoingOffer || hasOutgoingOfferHint

          // Deterministic glare tie-break:
          // lower ID keeps outgoing offer; higher ID backs off and answers.
          if (hasOutgoingOffer && selfId < peerId) {
            return
          }

          if (hasTrackedOutgoingOffer) {
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

          const peerTopic = await sha1(topicPath(rootTopicPlaintext, peerId))

          if (didLeaveRoom) {
            return
          }

          answerPeer.setHandlers({
            signal: signal => {
              if (
                didLeaveRoom ||
                state.answeringPeer !== answerPeer ||
                answerPeer.isDead
              ) {
                return
              }

              if (signal.type !== 'answer' && signal.type !== candidateType) {
                return
              }

              void toCipher(signal).then(encryptedSignal => {
                if (
                  didLeaveRoom ||
                  state.answeringPeer !== answerPeer ||
                  answerPeer.isDead
                ) {
                  return
                }

                const payloadToSend: Record<string, unknown> = {
                  peerId: selfId
                }

                if (signal.type === 'answer') {
                  payloadToSend['answer'] = encryptedSignal.sdp
                } else {
                  payloadToSend['candidate'] = encryptedSignal.sdp
                }

                if (offerId) {
                  payloadToSend['offerId'] = offerId
                }

                signalPeer(peerTopic, toJson(payloadToSend))
              })
            }
          })

          DEV: debugLog('sending answer to', peerId)
          await answerPeer.signal(plainOffer)
          await flushBufferedCandidates(state, answerPeer, offerId)
        } else if (candidate) {
          let plainCandidate: Signal

          try {
            plainCandidate = await toPlain({
              type: candidateType,
              sdp: candidate
            })
          } catch {
            return
          }

          const state = getState(peerId)
          const offerPeerMatch =
            offerId && state?.offerPeer && state.offerId === offerId
              ? state.offerPeer
              : null
          const answeringPeer = state?.answeringPeer ?? null
          const fallbackOfferPeer =
            !offerId && state?.offerPeer ? state.offerPeer : null
          const targetPeer =
            peer && !peer.isDead
              ? peer
              : (offerPeerMatch ?? answeringPeer ?? fallbackOfferPeer)

          if (!targetPeer || targetPeer.isDead) {
            const pendingKey = offerId ?? legacyCandidateKey
            ;(state.pendingCandidates[pendingKey] ??= []).push(plainCandidate)
            return
          }

          void targetPeer.signal(plainCandidate)
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
            claimLeasedOfferPeer(peer)
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

    if (!didInit) {
      const initRes = init(config)
      offerPool = []
      pooledOfferPeers.clear()
      alloc(poolSize, makeOffer).forEach(pushOfferToPool)
      initPromises = (Array.isArray(initRes) ? initRes : [initRes]).map(value =>
        Promise.resolve(value)
      )
      didInit = true
      offerCleanupTimer = setInterval(() => {
        offerPool = offerPool.filter(peer => {
          if (peer.isDead) {
            pooledOfferPeers.delete(peer)
            return false
          }

          return true
        })
      }, offerTtl)
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
    const sharedPassword = config.password ?? ''
    const hashSharedPasswordChallenge = (challenge: string): Promise<string> =>
      hashWith(
        'SHA-256',
        `${challenge}:${sharedPassword}:${appId}:${roomId}`
      ).then(toHex)

    const runSharedPasswordHandshake = async (
      send: HandshakeSender,
      receive: HandshakeReceiver,
      isInitiator: boolean
    ): Promise<void> => {
      if (!sharedPassword) {
        return
      }

      if (isInitiator) {
        const challenge = genId(36)
        await send({__trystero_pw: 'challenge', c: challenge})
        const {data} = await receive()

        if (
          !data ||
          typeof data !== 'object' ||
          (data as {__trystero_pw?: unknown}).__trystero_pw !== 'response' ||
          typeof (data as {h?: unknown}).h !== 'string'
        ) {
          throw new Error(
            `incorrect password (${sharedPassword}) for overlapping room`
          )
        }

        const expected = await hashSharedPasswordChallenge(challenge)

        if ((data as {h: string}).h !== expected) {
          throw new Error(
            `incorrect password (${sharedPassword}) for overlapping room`
          )
        }

        return
      }

      const {data} = await receive()

      if (
        !data ||
        typeof data !== 'object' ||
        (data as {__trystero_pw?: unknown}).__trystero_pw !== 'challenge' ||
        typeof (data as {c?: unknown}).c !== 'string'
      ) {
        throw new Error(
          `incorrect password (${sharedPassword}) for overlapping room`
        )
      }

      await send({
        __trystero_pw: 'response',
        h: await hashSharedPasswordChallenge((data as {c: string}).c)
      })
    }

    const composedPeerHandshake: PeerHandshake | undefined =
      sharedPassword || onPeerHandshake
        ? async (peerId, send, receive, isInitiator): Promise<void> => {
            await runSharedPasswordHandshake(send, receive, isInitiator)
            await onPeerHandshake?.(peerId, send, receive, isInitiator)
          }
        : undefined

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

        const state = peerStates[id]

        if (state?.connectedPeer) {
          state.connectedPeer = null
          updateStatus(state)
        }
      },
      () => {
        didLeaveRoom = true
        onPeerConnect = noOp

        Object.entries(peerStates).forEach(([peerId, state]) => {
          if (state.answeringExpiryTimer) {
            clearTimeout(state.answeringExpiryTimer)
            state.answeringExpiryTimer = null
          }

          if (state.connectedPeer && !state.connectedPeer.isDead) {
            const shared = sharedPeerMap[peerId]

            if (!shared || shared.peer !== state.connectedPeer) {
              state.connectedPeer.destroy()
            }
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

        didInit = false

        if (offerCleanupTimer) {
          clearInterval(offerCleanupTimer)
          offerCleanupTimer = null
        }

        offerPool.forEach(peer => peer.destroy())
        offerPool = []
        pooledOfferPeers.clear()

        leasedOfferPeers.forEach((timeout, peer) => {
          clearTimeout(timeout)
          peer.destroy()
        })
        leasedOfferPeers.clear()

        recyclingOfferPeers.forEach(peer => peer.destroy())
        recyclingOfferPeers.clear()

        cleanupWatchOnline()
      },
      roomOptions
    ))
  }
}
