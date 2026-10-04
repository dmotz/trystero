import {
  maxRoomFrameBytes,
  maxRoomTokenBytes,
  maxQueuedDataFrames,
  pendingDataTimeoutMs
} from './data-limits'
import {
  decodeBytes,
  encodeBytes,
  keys,
  libName,
  mkErr,
  noOp,
  resetTimer,
  values
} from './utils'
import {createMediaIdentityCache} from './media'
import type {
  PeerHandle,
  SharedMediaPeer,
  SharedPeerBinding,
  SharedPeerState,
  Signal
} from './types'

const roomFrameVersion = 1
const roomPresenceFrameVersion = 2

const wrapRoomFrame = (roomToken: string, data: Uint8Array): Uint8Array => {
  const tokenBytes = encodeBytes(roomToken)
  const frame = new Uint8Array(3 + tokenBytes.byteLength + data.byteLength)

  frame[0] = roomFrameVersion
  frame[1] = (tokenBytes.byteLength >>> 8) & 0xff
  frame[2] = tokenBytes.byteLength & 0xff
  frame.set(tokenBytes, 3)
  frame.set(data, 3 + tokenBytes.byteLength)

  return frame
}

const wrapRoomPresenceFrame = (
  roomToken: string,
  isPresent: boolean
): Uint8Array => {
  const tokenBytes = encodeBytes(roomToken)
  const frame = new Uint8Array(4 + tokenBytes.byteLength)

  frame[0] = roomPresenceFrameVersion
  frame[1] = Number(isPresent)
  frame[2] = (tokenBytes.byteLength >>> 8) & 0xff
  frame[3] = tokenBytes.byteLength & 0xff
  frame.set(tokenBytes, 4)

  return frame
}

type SharedFrame =
  | {type: 'room'; roomToken: string; payload: ArrayBuffer}
  | {type: 'presence'; roomToken: string; isPresent: boolean}

const decodeRoomTokenHeader = (
  buffer: Uint8Array,
  offset: number
): {roomToken: string; headerSize: number} | null => {
  if (buffer.byteLength < offset + 2) {
    return null
  }

  const tokenSize = ((buffer[offset] ?? 0) << 8) | (buffer[offset + 1] ?? 0)
  const headerSize = offset + 2 + tokenSize

  if (
    tokenSize <= 0 ||
    tokenSize > maxRoomTokenBytes ||
    buffer.byteLength < headerSize
  ) {
    return null
  }

  return {
    roomToken: decodeBytes(buffer.subarray(offset + 2, headerSize)),
    headerSize
  }
}

const unwrapFrame = (data: ArrayBuffer): SharedFrame | null => {
  const buffer = new Uint8Array(data)

  if (buffer.byteLength < 3 || buffer.byteLength > maxRoomFrameBytes) {
    return null
  }

  if (buffer[0] === roomFrameVersion) {
    const header = decodeRoomTokenHeader(buffer, 1)

    return header
      ? {
          type: 'room',
          roomToken: header.roomToken,
          payload: buffer.subarray(header.headerSize).slice().buffer
        }
      : null
  }

  if (buffer[0] === roomPresenceFrameVersion) {
    const header = decodeRoomTokenHeader(buffer, 2)

    return header
      ? {
          type: 'presence',
          roomToken: header.roomToken,
          isPresent: buffer[1] === 1
        }
      : null
  }

  return null
}

const isPeerUnderlyingStale = (peer: PeerHandle): boolean => {
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

export const getConnectedPeerHealth = (
  peer: PeerHandle
): 'live' | 'transient' | 'stale' => {
  if (isPeerUnderlyingStale(peer)) {
    return 'stale'
  }

  const {channel} = peer

  if (!channel || channel.readyState !== 'open') {
    return 'transient'
  }

  return 'live'
}

type RoomRegistration = {
  token: string | null
  tokenPromise: Promise<string>
  active: boolean
  onPeer: (proxy: PeerHandle, peerId: string, physical: PeerHandle) => void
  onDetach: (peerId: string, physical: PeerHandle) => void
}
type RoomMembership = {
  connect: (peerId: string, peer: PeerHandle, idleMs: number) => void
  reuse: (peerId: string) => boolean
  setActive: (active: boolean) => void
  leave: () => void
}

export class SharedPeerManager {
  private rooms = new Map<string, Map<string, RoomRegistration>>()
  private unclaimedDataTimers = new WeakMap<
    SharedPeerState,
    ReturnType<typeof setTimeout>
  >()
  private pendingDataTimers = new WeakMap<
    SharedPeerState,
    ReturnType<typeof setTimeout>
  >()
  private byApp: Record<string, Record<string, SharedPeerState>> = {}

  registerRoom(
    appId: string,
    roomId: string,
    tokenPromise: Promise<string>,
    options: {
      active: boolean
      onPeer: RoomRegistration['onPeer']
      onDetach: RoomRegistration['onDetach']
    }
  ): RoomMembership {
    const rooms = this.rooms.get(appId) ?? new Map<string, RoomRegistration>()
    if (rooms.has(roomId)) {
      throw mkErr('room membership already registered')
    }
    const registration: RoomRegistration = {
      token: null,
      tokenPromise,
      ...options
    }
    rooms.set(roomId, registration)
    this.rooms.set(appId, rooms)
    const current = (): boolean =>
      this.rooms.get(appId)?.get(roomId) === registration
    const advertise = (present: boolean): void => {
      if (!registration.token) {
        return
      }
      for (const shared of values(this.byApp[appId] ?? {})) {
        try {
          this.sendRoomPresence(shared, registration.token, present)
        } catch {
          /* Presence is best effort; a closing connection cannot block cleanup. */
        }
      }
    }
    void tokenPromise.then(token => {
      if (!current()) {
        return
      }
      registration.token = token
      for (const shared of values(this.byApp[appId] ?? {})) {
        if (shared.remoteRoomTokens.has(token)) {
          this.attachRoom(appId, roomId, registration, shared)
        }
        this.discardUnboundData(shared)
      }
      if (current() && registration.active) {
        advertise(true)
      }
    })
    return {
      connect: (peerId, peer, idleMs) => {
        if (!current()) {
          peer.destroy()
          return
        }
        const existing = this.reusable(appId, peerId)
        if (existing && existing.peer !== peer) {
          peer.destroy()
        }
        const shared = existing ?? this.register(appId, peerId, peer, idleMs)
        this.attachRoom(appId, roomId, registration, shared)
        if (!existing) {
          for (const room of rooms.values()) {
            if (room.active && room.token) {
              this.sendRoomPresence(shared, room.token, true)
            }
          }
        }
      },
      reuse: peerId => {
        if (!current()) {
          return false
        }
        const shared = this.reusable(appId, peerId)
        if (!shared) {
          return false
        }
        this.attachRoom(appId, roomId, registration, shared)
        return true
      },
      setActive: active => {
        if (!current() || registration.active === active) {
          return
        }
        registration.active = active
        advertise(active)
      },
      leave: () => {
        if (!current()) {
          return
        }
        rooms.delete(roomId)
        if (!rooms.size) {
          this.rooms.delete(appId)
        }
        advertise(false)
        for (const shared of values(this.byApp[appId] ?? {})) {
          const binding = shared.bindings[roomId]
          binding?.handlers.close?.()
          binding?.detach()
          this.discardUnboundData(shared)
        }
      }
    }
  }

  owns(appId: string, peerId: string, peer: PeerHandle): boolean {
    return this.byApp[appId]?.[peerId]?.peer === peer
  }

  private reusable(appId: string, peerId: string): SharedPeerState | undefined {
    const shared = this.byApp[appId]?.[peerId]
    if (shared && isPeerUnderlyingStale(shared.peer)) {
      this.clear(appId, peerId, {destroyPeer: true})
      return undefined
    }
    return shared
  }

  private attachRoom(
    appId: string,
    roomId: string,
    registration: RoomRegistration,
    shared: SharedPeerState
  ): void {
    if (
      this.rooms.get(appId)?.get(roomId) !== registration ||
      shared.isClosing ||
      this.get(appId, shared.peerId) !== shared
    ) {
      return
    }
    const {proxy, isNew} = this.bind(
      roomId,
      registration.tokenPromise,
      shared,
      {
        onDetach: () => registration.onDetach(shared.peerId, shared.peer)
      }
    )
    if (isNew) {
      registration.onPeer(proxy, shared.peerId, shared.peer)
    }
  }

  get(appId: string, peerId: string): SharedPeerState | undefined {
    return this.byApp[appId]?.[peerId]
  }

  sendRoomPresence(
    shared: SharedPeerState,
    roomToken: string,
    isPresent: boolean
  ): void {
    if (shared.isClosing || isPeerUnderlyingStale(shared.peer)) {
      return
    }

    shared.peer.sendData(wrapRoomPresenceFrame(roomToken, isPresent))
  }

  clear(
    appId: string,
    peerId: string,
    {destroyPeer}: {destroyPeer: boolean}
  ): void {
    const map = this.byApp[appId]
    const shared = map?.[peerId]

    if (!shared || shared.isClosing) {
      return
    }

    shared.idleTimer = resetTimer(shared.idleTimer)
    this.clearDataTimers(shared)
    shared.isClosing = true

    if (destroyPeer && !shared.peer.isDead) {
      shared.peer.destroy()
    }

    const bindings = values(shared.bindings)
    shared.bindings = {}
    shared.bindingsByToken = {}
    shared.controlRoomId = null
    delete map![peerId]

    bindings.forEach(binding => {
      binding.handlers.close?.()
      binding.pendingData.length = 0
      binding.pendingSendData.length = 0
      binding.pendingTracks.length = 0
    })

    shared.media.clearRemote()
    shared.pendingDataByToken.clear()
    shared.remoteRoomTokens.clear()

    if (keys(map!).length === 0) {
      delete this.byApp[appId]
    }
  }

  register(
    appId: string,
    peerId: string,
    peer: PeerHandle,
    idleMs: number
  ): SharedPeerState {
    const existing = this.byApp[appId]?.[peerId]

    if (existing) {
      existing.idleTimer = resetTimer(existing.idleTimer)

      if (existing.peer === peer) {
        return existing
      }

      this.clear(appId, peerId, {destroyPeer: true})
    }

    const shared: SharedPeerState = {
      appId,
      peerId,
      peer,
      bindings: {},
      bindingsByToken: {},
      pendingDataByToken: new Map(),
      remoteRoomTokens: new Set(),
      idleTimer: null,
      controlRoomId: null,
      streamOwners: new Map(),
      trackOwners: new Map(),
      media: createMediaIdentityCache(),
      idleMs,
      isClosing: false
    }

    // Installing handlers can synchronously flush buffered physical frames.
    ;(this.byApp[appId] ??= {})[peerId] = shared
    const clearCurrent = (): void => {
      if (this.owns(appId, peerId, peer)) {
        this.clear(appId, peerId, {destroyPeer: true})
      }
    }
    peer.setHandlers({
      data: data => this.dispatchData(shared, data),
      signal: signal => this.dispatchSignal(shared, signal),
      close: clearCurrent,
      error: err => {
        console.error(`${libName} peer error:`, err)
        clearCurrent()
      },
      track: (track, stream) => this.dispatchTrack(shared, track, stream)
    })

    return shared
  }

  bind(
    roomId: string,
    roomTokenPromise: Promise<string>,
    shared: SharedPeerState,
    {onDetach}: {onDetach: () => void}
  ): {proxy: PeerHandle; isNew: boolean} {
    const existingBinding = shared.bindings[roomId]

    if (existingBinding) {
      shared.idleTimer = resetTimer(shared.idleTimer)
      return {proxy: existingBinding.proxy, isNew: false}
    }

    const binding: SharedPeerBinding = {
      roomId,
      roomToken: null,
      roomTokenPromise,
      handlers: {},
      pendingData: [],
      pendingSendData: [],
      pendingTracks: [],
      detach: noOp,
      proxy: {} as PeerHandle
    }

    const detachBinding = (): void => {
      if (shared.bindings[roomId] !== binding) {
        return
      }

      // Media peers need a signaling route to remove tracks before reuse.
      const shouldDestroy =
        keys(shared.bindings).length === 1 &&
        (shared.streamOwners.size > 0 ||
          shared.trackOwners.size > 0 ||
          shared.media.hasRemoteMedia())

      if (!shouldDestroy) {
        this.pruneRoomOwnership(shared, roomId)
      }
      delete shared.bindings[roomId]
      if (
        binding.roomToken &&
        shared.bindingsByToken[binding.roomToken] === binding
      ) {
        delete shared.bindingsByToken[binding.roomToken]
      }

      if (shared.controlRoomId === roomId) {
        shared.controlRoomId = keys(shared.bindings)[0] ?? null
      }

      this.discardUnboundData(shared)
      onDetach()
      if (shouldDestroy) {
        this.clear(shared.appId, shared.peerId, {destroyPeer: true})
      } else {
        this.scheduleIdleTimer(shared)
      }
    }

    const proxy: SharedMediaPeer = {
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
      sendData: data => {
        if (!binding.roomToken) {
          binding.pendingSendData.push(data)
          return
        }

        shared.peer.sendData(wrapRoomFrame(binding.roomToken, data))
      },
      destroy: () => detachBinding(),
      setHandlers: newHandlers => {
        Object.assign(binding.handlers, newHandlers)
        this.flushBindingQueues(shared, binding)
      },
      addStream: stream => {
        const owners = shared.streamOwners.get(stream) ?? new Set<string>()
        const shouldAttach = owners.size === 0

        owners.add(roomId)
        shared.streamOwners.set(stream, owners)

        if (shouldAttach) {
          shared.peer.addStream(stream)
        }
      },
      removeStream: stream => this.releaseStreamOwner(shared, stream, roomId),
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
      removeTrack: track => this.releaseTrackOwner(shared, track, roomId),
      replaceTrack: async (oldTrack, newTrack) => {
        const oldEntry = shared.trackOwners.get(oldTrack)
        await shared.peer.replaceTrack(oldTrack, newTrack)
        if (oldEntry && shared.trackOwners.get(oldTrack) === oldEntry) {
          shared.trackOwners.delete(oldTrack)

          const nextEntry = shared.trackOwners.get(newTrack) ?? {
            stream: oldEntry.stream,
            rooms: new Set<string>()
          }

          oldEntry.rooms.forEach(room => nextEntry.rooms.add(room))
          shared.trackOwners.set(newTrack, nextEntry)
        }
      },
      __trysteroMedia: shared.media
    }

    binding.proxy = proxy
    binding.detach = detachBinding
    shared.bindings[roomId] = binding
    shared.controlRoomId ??= roomId
    shared.idleTimer = resetTimer(shared.idleTimer)

    void roomTokenPromise.then(roomToken => {
      if (shared.isClosing || shared.bindings[roomId] !== binding) {
        return
      }

      binding.roomToken = roomToken
      shared.bindingsByToken[roomToken] = binding

      const pendingData = shared.pendingDataByToken.get(roomToken)

      if (pendingData?.length) {
        binding.pendingData.push(...pendingData)
        shared.pendingDataByToken.delete(roomToken)
      }

      const pendingSendData = binding.pendingSendData.splice(0)
      if (!isPeerUnderlyingStale(shared.peer)) {
        pendingSendData.forEach(payload => {
          try {
            shared.peer.sendData(wrapRoomFrame(roomToken, payload))
          } catch {
            /* Ignore send errors if the underlying channel is closing. */
          }
        })
      }
      this.flushBindingQueues(shared, binding)
      this.discardUnboundData(shared)
    })

    return {proxy, isNew: true}
  }

  private releaseStreamOwner(
    shared: SharedPeerState,
    stream: MediaStream,
    roomIdToRemove: string
  ): void {
    const rooms = shared.streamOwners.get(stream)

    if (!rooms) {
      return
    }

    rooms.delete(roomIdToRemove)

    if (rooms.size === 0) {
      shared.streamOwners.delete(stream)
      shared.peer.removeStream(stream)
    }
  }

  private releaseTrackOwner(
    shared: SharedPeerState,
    track: MediaStreamTrack,
    roomIdToRemove: string
  ): void {
    const entry = shared.trackOwners.get(track)

    if (!entry) {
      return
    }

    entry.rooms.delete(roomIdToRemove)

    if (entry.rooms.size === 0) {
      shared.trackOwners.delete(track)
      shared.peer.removeTrack(track)
    }
  }

  private pruneRoomOwnership(
    shared: SharedPeerState,
    roomIdToRemove: string
  ): void {
    shared.streamOwners.forEach((_, stream) =>
      this.releaseStreamOwner(shared, stream, roomIdToRemove)
    )

    shared.trackOwners.forEach((_, track) =>
      this.releaseTrackOwner(shared, track, roomIdToRemove)
    )
  }

  private scheduleIdleTimer(shared: SharedPeerState): void {
    if (shared.isClosing || keys(shared.bindings).length > 0) {
      return
    }

    shared.idleTimer = resetTimer(shared.idleTimer)

    shared.idleTimer = setTimeout(() => {
      const map = this.byApp[shared.appId]
      const current = map?.[shared.peerId]

      if (!current || keys(current.bindings).length > 0) {
        return
      }

      this.clear(shared.appId, shared.peerId, {destroyPeer: true})
    }, shared.idleMs)
  }

  private getSignalBinding(shared: SharedPeerState): SharedPeerBinding | null {
    if (shared.controlRoomId) {
      const selected = shared.bindings[shared.controlRoomId]

      if (selected?.handlers.signal) {
        return selected
      }
    }

    const fallback = values(shared.bindings).find(binding =>
      Boolean(binding.handlers.signal)
    )

    if (!fallback) {
      return null
    }

    shared.controlRoomId = fallback.roomId
    return fallback
  }

  private flushBindingQueues(
    shared: SharedPeerState,
    binding: SharedPeerBinding
  ): void {
    const {handlers} = binding

    if (handlers.data && binding.pendingData.length > 0) {
      const queued = binding.pendingData.splice(0)
      this.syncDataTimers(shared)
      queued.forEach(payload => handlers.data?.(payload))
    } else {
      this.syncDataTimers(shared)
    }

    if ((handlers.track || handlers.stream) && binding.pendingTracks.length) {
      const queued = binding.pendingTracks.splice(0)
      queued.forEach(({track, stream}) => {
        handlers.track?.(track, stream)
        handlers.stream?.(stream)
      })
    }
  }

  private unclaimedBufferedFrameCount(shared: SharedPeerState): number {
    let count = 0
    for (const queue of shared.pendingDataByToken.values()) {
      count += queue.length
    }
    return count
  }

  private boundBufferedFrameCount(shared: SharedPeerState): number {
    let count = 0
    for (const binding of values(shared.bindings)) {
      count += binding.pendingData.length
    }
    return count
  }

  private bufferedFrameCount(shared: SharedPeerState): number {
    return (
      this.unclaimedBufferedFrameCount(shared) +
      this.boundBufferedFrameCount(shared)
    )
  }

  private clearDataTimers(shared: SharedPeerState): void {
    resetTimer(this.unclaimedDataTimers.get(shared))
    this.unclaimedDataTimers.delete(shared)
    resetTimer(this.pendingDataTimers.get(shared))
    this.pendingDataTimers.delete(shared)
  }

  private syncDataTimers(shared: SharedPeerState): void {
    if (shared.isClosing) {
      this.clearDataTimers(shared)
      return
    }

    if (this.unclaimedBufferedFrameCount(shared) === 0) {
      resetTimer(this.unclaimedDataTimers.get(shared))
      this.unclaimedDataTimers.delete(shared)
    } else if (!this.unclaimedDataTimers.has(shared)) {
      this.unclaimedDataTimers.set(
        shared,
        setTimeout(() => {
          this.unclaimedDataTimers.delete(shared)
          // These may be late frames for rooms we left while another token
          // was resolving. Expire them without closing unrelated bindings.
          shared.pendingDataByToken.clear()
        }, pendingDataTimeoutMs)
      )
    }

    if (this.boundBufferedFrameCount(shared) === 0) {
      resetTimer(this.pendingDataTimers.get(shared))
      this.pendingDataTimers.delete(shared)
    } else if (!this.pendingDataTimers.has(shared)) {
      this.pendingDataTimers.set(
        shared,
        setTimeout(() => {
          this.pendingDataTimers.delete(shared)
          if (this.boundBufferedFrameCount(shared) > 0) {
            this.failData(shared, 'room data handler timed out')
          }
        }, pendingDataTimeoutMs)
      )
    }
  }

  private canBindRoomToken(shared: SharedPeerState, token: string): boolean {
    return (
      values(shared.bindings).some(binding => !binding.roomToken) ||
      [...(this.rooms.get(shared.appId)?.values() ?? [])].some(
        room => !room.token || room.token === token
      )
    )
  }

  private discardUnboundData(shared: SharedPeerState): void {
    for (const token of shared.pendingDataByToken.keys()) {
      if (!this.canBindRoomToken(shared, token)) {
        shared.pendingDataByToken.delete(token)
      }
    }
    this.syncDataTimers(shared)
  }

  private failData(shared: SharedPeerState, reason: string): void {
    console.warn(`${libName}: ${reason}; disconnecting peer ${shared.peerId}`)
    this.clear(shared.appId, shared.peerId, {destroyPeer: true})
  }

  private dispatchData(shared: SharedPeerState, data: ArrayBuffer): void {
    if (shared.isClosing) {
      return
    }
    const decoded = unwrapFrame(data)

    if (!decoded) {
      this.failData(shared, 'invalid or incompatible room frame')
      return
    }

    if (decoded.type === 'presence') {
      if (decoded.isPresent) {
        if (
          !shared.remoteRoomTokens.has(decoded.roomToken) &&
          shared.remoteRoomTokens.size >= maxQueuedDataFrames
        ) {
          this.failData(shared, 'too many advertised rooms')
          return
        }
        shared.remoteRoomTokens.add(decoded.roomToken)
        for (const [roomId, registration] of this.rooms.get(shared.appId) ??
          []) {
          if (registration.token === decoded.roomToken) {
            this.attachRoom(shared.appId, roomId, registration, shared)
          }
        }
      } else {
        shared.remoteRoomTokens.delete(decoded.roomToken)
        shared.pendingDataByToken.delete(decoded.roomToken)
        const binding = shared.bindingsByToken[decoded.roomToken]
        binding?.handlers.close?.()
        binding?.detach()
        this.syncDataTimers(shared)
      }

      return
    }

    const binding = shared.bindingsByToken[decoded.roomToken]

    if (!binding) {
      // A registered room may receive its handshake before signaling binds it.
      // Departed rooms cannot claim data once all remaining tokens are known.
      if (
        !this.canBindRoomToken(shared, decoded.roomToken) ||
        this.bufferedFrameCount(shared) >= maxQueuedDataFrames
      ) {
        return
      }
      const pending = shared.pendingDataByToken.get(decoded.roomToken) ?? []
      pending.push(decoded.payload)
      shared.pendingDataByToken.set(decoded.roomToken, pending)
      this.syncDataTimers(shared)
      return
    }

    if (binding.handlers.data) {
      binding.handlers.data(decoded.payload)
    } else {
      if (this.bufferedFrameCount(shared) >= maxQueuedDataFrames) {
        this.failData(shared, 'too much data waiting for a room handler')
        return
      }
      binding.pendingData.push(decoded.payload)
      this.syncDataTimers(shared)
    }
  }

  private dispatchSignal(shared: SharedPeerState, signal: Signal): void {
    const binding = this.getSignalBinding(shared)

    if (binding) {
      binding.handlers.signal?.(signal)
    } else if (signal.type === 'offer') {
      // An unsent offer would leave the reused connection in have-local-offer.
      this.clear(shared.appId, shared.peerId, {destroyPeer: true})
    }
  }

  private dispatchTrack(
    shared: SharedPeerState,
    track: MediaStreamTrack,
    stream: MediaStream
  ): void {
    values(shared.bindings).forEach(binding => {
      if (binding.handlers.track || binding.handlers.stream) {
        binding.handlers.track?.(track, stream)
        binding.handlers.stream?.(stream)
        return
      }

      binding.pendingTracks.push({track, stream})
    })
  }
}
