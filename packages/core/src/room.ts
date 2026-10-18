import {
  entries,
  fromEntries,
  genId,
  isBrowser,
  keys,
  libName,
  mkErr,
  noOp,
  selfId as defaultSelfId,
  toError
} from './utils'
import {createActionManager} from './actions'
import {createHandshakeManager} from './handshake'
import {createMediaManager, type InternalMediaMeta} from './media'
import {createOverlayManager, type OverlayManager} from './overlay'
import type {
  AddMediaOptions,
  DataPayload,
  PeerHandle,
  PeerHandshake,
  Room,
  SharedMediaPeer,
  TargetPeers,
  TopologyConfig,
  TopologyMode
} from './types'

const unloadEvent = 'beforeunload'
const defaultHandshakeTimeoutMs = 10_000
const internalNs = (ns: string): string => '@_' + ns
const beforeUnloadRoomCleanups = new Set<() => void>()

const cleanupActiveRoomsOnBeforeUnload = (): void =>
  beforeUnloadRoomCleanups.forEach(cleanup => cleanup())

const registerBeforeUnloadCleanup = (cleanup: () => void): (() => void) => {
  beforeUnloadRoomCleanups.add(cleanup)

  if (beforeUnloadRoomCleanups.size === 1) {
    addEventListener(unloadEvent, cleanupActiveRoomsOnBeforeUnload)
  }

  return (): void => {
    beforeUnloadRoomCleanups.delete(cleanup)

    if (!beforeUnloadRoomCleanups.size) {
      removeEventListener(unloadEvent, cleanupActiveRoomsOnBeforeUnload)
    }
  }
}

type RoomOptions = {
  selfId?: string
  appId?: string
  roomId?: string
  password?: string
  topology?: TopologyMode | TopologyConfig
  onOverlayReady?: (overlay: OverlayManager) => void
  maxReceiveBytes?: number
  onPeerHandshake?: PeerHandshake
  onHandshakeError?: (peerId: string, error: string) => void
  handshakeTimeoutMs?: number
  isPassive?: boolean
  onBeforeLeave?: () => void
}

type PendingPongWaiter = {
  resolve: () => void
  reject: (error: Error) => void
}

type MediaControlMessage = {
  op: 'rmStream' | 'rmTrack'
  o: string
  id: string
}

export default (
  onPeer: (f: (peer: PeerHandle, id: string) => void) => void,
  onPeerLeave: (id: string) => void,
  onSelfLeave: () => void,
  {
    selfId: localSelfId = defaultSelfId,
    appId = '',
    roomId = '',
    password = '',
    topology,
    onOverlayReady,
    onPeerHandshake,
    onHandshakeError,
    handshakeTimeoutMs = defaultHandshakeTimeoutMs,
    maxReceiveBytes,
    isPassive = false,
    onBeforeLeave
  }: RoomOptions = {}
): Room => {
  const peerMap: Record<string, PeerHandle> = {}
  const activePeerMap: Record<string, PeerHandle> = {}
  const pendingPongs: Record<string, PendingPongWaiter[] | undefined> = {}
  const promotedFromVirtual = new Set<string>()
  const suppressVirtualJoin = new Set<string>()
  const knownBroadcastTracks = new Map<
    string,
    {track: MediaStreamTrack; stream: MediaStream}
  >()
  const listeners = {
    onPeerJoin: null as ((peerId: string) => void) | null,
    onPeerLeave: null as ((peerId: string) => void) | null
  }
  let unregisterBeforeUnloadCleanup: () => void = noOp
  let leavePromise: Promise<void> | null = null

  const iterate = (
    targets: TargetPeers,
    f: (id: string, peer: PeerHandle) => Promise<void> | void
  ): Promise<void>[] =>
    (targets
      ? Array.isArray(targets)
        ? targets
        : [targets]
      : keys(activePeerMap)
    ).flatMap(id => {
      const peer = activePeerMap[id]

      if (!peer) {
        console.warn(`${libName}: no peer with id ${id} found`)
        return []
      }

      return [Promise.resolve(f(id, peer))]
    })

  const kickPeer = (id: string, peer?: PeerHandle, reason?: Error): void => {
    const current = peerMap[id]

    if (!current || (peer && current !== peer)) {
      return
    }

    void leaveAction.send('', id).catch(noOp)
    exitPeer(id, current, reason)
  }

  const onPeerError = (id: string, error: Error): void =>
    kickPeer(id, undefined, error)

  const recordStreamTracks = (stream: MediaStream): void => {
    stream.getTracks?.().forEach(track => {
      if (track && typeof track.id === 'string') {
        knownBroadcastTracks.set(track.id, {track, stream})
      }
    })
  }

  const overlay = createOverlayManager({
    selfId: localSelfId,
    appId,
    roomId,
    password,
    ...(topology === undefined ? {} : {topology}),
    onVirtualPeerJoin: (peerId, vPeer) => {
      const alreadyActive =
        Boolean(activePeerMap[peerId]) || suppressVirtualJoin.has(peerId)
      peerMap[peerId] = vPeer
      activePeerMap[peerId] = vPeer
      if (!alreadyActive) {
        listeners.onPeerJoin?.(peerId)
      }
    },
    onVirtualPeerLeave: (peerId, reason) => {
      const current = peerMap[peerId]
      if (!current || overlay.isDirectPeer(peerId)) {
        return
      }
      const wasActive = Boolean(activePeerMap[peerId])
      clearPeerState(peerId, reason)
      current.destroy()
      if (wasActive) {
        listeners.onPeerLeave?.(peerId)
      }
    },
    onDeliverData: (originPeerId, data) => {
      handleData(originPeerId, data)
    },
    onRelayMediaStream: (
      broadcasterId,
      stream,
      metadata,
      targetPeerIds,
      streamKey
    ) => {
      void mediaManager.addStream(
        stream,
        {
          target: targetPeerIds,
          ...(metadata === undefined ? {} : {metadata})
        },
        streamMetaAction.send,
        broadcasterId,
        streamKey
      )
    },
    onRelayMediaTrack: (
      broadcasterId,
      track,
      stream,
      metadata,
      targetPeerIds,
      trackKey
    ) => {
      void mediaManager.addTrack(
        track,
        stream,
        {
          target: targetPeerIds,
          ...(metadata === undefined ? {} : {metadata})
        },
        trackMetaAction.send,
        broadcasterId,
        trackKey
      )
    }
  })

  onOverlayReady?.(overlay)

  const mediaManager = createMediaManager({
    onPeerError,
    iterate: (targets, f) =>
      iterate(targets, (id, peer) => f(id, peer as SharedMediaPeer)),
    isActive: id => Boolean(activePeerMap[id]),
    getSharedMediaPeer: id =>
      (peerMap[id] as SharedMediaPeer | undefined) ?? null,
    onRemoteStream: (_fromPeerId, originPeerId, stream, metadata, key) => {
      recordStreamTracks(stream)
      if (overlay.isOverlayActive() && key) {
        overlay.registerBroadcastStream(originPeerId, key, stream, metadata)
      }
    },
    onRemoteTrack: (
      _fromPeerId,
      originPeerId,
      track,
      stream,
      metadata,
      key,
      metaTrackId,
      isReplace
    ) => {
      if (
        overlay.isOverlayActive() &&
        key &&
        (isReplace || (metaTrackId && metaTrackId !== track.id))
      ) {
        const oldEntry = metaTrackId
          ? knownBroadcastTracks.get(metaTrackId)
          : undefined
        if (typeof track.id === 'string') {
          knownBroadcastTracks.set(track.id, {track, stream})
        }
        const targets = overlay.getMediaTargets(originPeerId)
        if (targets.length > 0) {
          void mediaManager.replaceTrack(
            oldEntry?.track ?? track,
            track,
            {
              target: targets,
              ...(metadata === undefined ? {} : {metadata})
            },
            trackMetaAction.send,
            originPeerId,
            key
          )
        }
        return
      }

      if (typeof track.id === 'string') {
        knownBroadcastTracks.set(track.id, {track, stream})
      }
      if (overlay.isOverlayActive() && key) {
        overlay.registerBroadcastTrack(
          originPeerId,
          key,
          track,
          stream,
          metadata
        )
      }
    }
  })

  const actionManager = createActionManager({
    onPeerError,
    ...(maxReceiveBytes === undefined ? {} : {maxReceiveBytes}),
    getPeer: (id, includePending) =>
      (includePending ? peerMap : activePeerMap)[id],
    getPeerIds: includePending =>
      keys(includePending ? peerMap : activePeerMap),
    canReceiveFromPeer: (id, receiveWhilePending) =>
      Boolean(activePeerMap[id]) ||
      handshakeManager.canReceiveFromPeer(id, receiveWhilePending),
    broadcastInline: (frame, onProgress) =>
      overlay.broadcastInline(frame, onProgress)
  })
  const makeActionInternal = actionManager.makeInternalAction
  const handleData = actionManager.handleData
  const makeAction = actionManager.makeAction

  const clearPeerState = (
    id: string,
    reason: Error = mkErr('peer disconnected')
  ): void => {
    const err = toError(reason, 'peer disconnected')

    handshakeManager.clearPeer(id, err)
    delete peerMap[id]
    delete activePeerMap[id]
    actionManager.clearPeer(id, err)
    pendingPongs[id]?.splice(0).forEach(waiter => waiter.reject(err))
    delete pendingPongs[id]
    mediaManager.clearPeer(id)
  }

  const exitPeer = (id: string, peer?: PeerHandle, reason?: Error): void => {
    const current = peerMap[id]

    if (!current) {
      return
    }

    if (peer && current !== peer) {
      return
    }

    const wasActive =
      Boolean(activePeerMap[id]) || promotedFromVirtual.delete(id)
    const wasVirtual = overlay.isVirtualPeer(id)
    const wasDirect = overlay.isDirectPeer(id)

    clearPeerState(id, reason)
    current.destroy()

    if (wasDirect) {
      if (wasActive) {
        suppressVirtualJoin.add(id)
      }
      const keptAsVirtual = overlay.removeDirectPeer(id, current)
      suppressVirtualJoin.delete(id)
      if (keptAsVirtual) {
        onPeerLeave(id)
        return
      }
    }

    if (wasActive) {
      listeners.onPeerLeave?.(id)
    }

    if (!wasVirtual) {
      onPeerLeave(id)
    }
  }

  const leave = (): Promise<void> =>
    (leavePromise ??= (async () => {
      onBeforeLeave?.()
      overlay.announceLeave()
      const controller = new AbortController()
      void leaveAction
        .send('', undefined, undefined, undefined, controller.signal)
        .catch(noOp)
      await new Promise<void>(res => setTimeout(res, 99))
      controller.abort()

      try {
        overlay.destroy()
        entries(peerMap).forEach(([id, peer]) => {
          peer.destroy()
          clearPeerState(id, mkErr('room left'))
        })
      } finally {
        try {
          unregisterBeforeUnloadCleanup()
        } finally {
          onSelfLeave()
        }
      }
    })())

  const pingAction = makeActionInternal<string>(internalNs('ping'))
  const pongAction = makeActionInternal<string>(internalNs('pong'))
  const signalAction = makeActionInternal(internalNs('signal'))
  const streamMetaAction = makeActionInternal<InternalMediaMeta>(
    internalNs('stream'),
    {maxPayloadBytes: 64 * 1024}
  )
  const trackMetaAction = makeActionInternal<InternalMediaMeta>(
    internalNs('track'),
    {maxPayloadBytes: 64 * 1024}
  )
  const mediaControlAction = makeActionInternal<MediaControlMessage>(
    internalNs('mctrl')
  )
  const leaveAction = makeActionInternal<string>(internalNs('leave'), {
    sendToPending: true,
    receiveWhilePending: true
  })
  const handshakeDataAction = makeActionInternal<DataPayload>(
    internalNs('hsdata'),
    {sendToPending: true, receiveWhilePending: true, maxPayloadBytes: 64 * 1024}
  )
  const handshakeReadyAction = makeActionInternal<string>(
    internalNs('hsready'),
    {sendToPending: true, receiveWhilePending: true}
  )

  const handshakeManager = createHandshakeManager({
    selfId: localSelfId,
    ...(onPeerHandshake === undefined ? {} : {onPeerHandshake}),
    ...(onHandshakeError === undefined ? {} : {onHandshakeError}),
    handshakeTimeoutMs,
    sendHandshakeData: handshakeDataAction.send,
    sendHandshakeReady: handshakeReadyAction.send,
    onActivate: (id, peer) => {
      const alreadyJoined = promotedFromVirtual.delete(id)
      activePeerMap[id] = peer
      overlay.addDirectPeer(id, peer)
      peer.setHandlers({
        signal: sdp => {
          if (activePeerMap[id] === peer) {
            void signalAction
              .send(sdp as unknown as DataPayload, id)
              .catch(noOp)
          }
        }
      })
      if (!alreadyJoined) {
        listeners.onPeerJoin?.(id)
      }
    },
    onFailure: (id, peer, reason) => kickPeer(id, peer, reason)
  })

  pingAction.onMessage((_, id) => {
    void pongAction.send('', id).catch(noOp)
  })

  pongAction.onMessage((_, id) => {
    const queue = pendingPongs[id]
    const waiter = queue?.shift()

    waiter?.resolve()

    if (queue && !queue.length) {
      delete pendingPongs[id]
    }
  })

  signalAction.onMessage((sdp, id) => {
    void activePeerMap[id]?.signal(sdp as never)
  })

  streamMetaAction.onMessage((meta, id) =>
    mediaManager.receiveStreamMeta(meta, id)
  )

  trackMetaAction.onMessage((meta, id) =>
    mediaManager.receiveTrackMeta(meta, id)
  )

  mediaControlAction.onMessage(msg => {
    if (!msg || typeof msg !== 'object') {
      return
    }
    if (msg.op === 'rmStream' && typeof msg.o === 'string') {
      const removed = overlay.unregisterBroadcastStreamById(msg.o, msg.id)
      if (removed && removed.targets.length > 0) {
        mediaManager.removeStream(removed.stream, removed.targets)
      }
    }
  })

  leaveAction.onMessage((_, id) =>
    exitPeer(id, undefined, mkErr('peer left room'))
  )

  handshakeDataAction.onMessage((data, id, metadata) =>
    handshakeManager.receiveHandshakeData(data, id, metadata)
  )

  handshakeReadyAction.onMessage((_, id) =>
    handshakeManager.receiveHandshakeReady(id)
  )

  onPeer((peer, id) => {
    const existingPeer = peerMap[id]
    const wasVirtual = Boolean(existingPeer && overlay.isVirtualPeer(id))

    if (existingPeer) {
      if (existingPeer === peer) {
        return
      }

      existingPeer.destroy()
      if (wasVirtual) {
        promotedFromVirtual.add(id)
        delete peerMap[id]
      } else {
        clearPeerState(id, mkErr('peer replaced'))
      }
    }

    peerMap[id] = peer
    handshakeManager.addPeer(id, peer)

    peer.setHandlers({
      data: d => {
        if (peerMap[id] === peer) {
          if (overlay.isOverlayFrame(d)) {
            overlay.handleOverlayFrame(id, d)
          } else {
            handleData(id, d)
          }
        }
      },
      stream: stream => mediaManager.receiveRemoteStream(id, stream),
      track: (track, stream) =>
        mediaManager.receiveRemoteTrack(id, track, stream),
      close: () => exitPeer(id, peer, mkErr('peer disconnected')),
      error: (err: Error) => {
        console.error(`${libName} peer error:`, err)
        exitPeer(id, peer, err)
      }
    })

    handshakeManager.start(id, peer)
  })

  if (isBrowser) {
    unregisterBeforeUnloadCleanup = registerBeforeUnloadCleanup(() =>
      leave().catch(noOp)
    )
  }

  return {
    makeAction,

    leave,

    ping: async id => {
      if (!activePeerMap[id]) {
        throw mkErr(`no active peer with id ${id}`)
      }

      const start = Date.now()

      await new Promise<void>((resolve, reject) => {
        const queue = (pendingPongs[id] ??= [])

        const clearFromQueue = (): void => {
          const currentQueue = pendingPongs[id]

          if (!currentQueue) {
            return
          }

          const i = currentQueue.indexOf(waiter)

          if (i > -1) {
            currentQueue.splice(i, 1)
          }

          if (!currentQueue.length) {
            delete pendingPongs[id]
          }
        }

        const waiter: PendingPongWaiter = {
          resolve: () => {
            clearFromQueue()
            resolve()
          },
          reject: reason => {
            clearFromQueue()
            reject(reason)
          }
        }

        queue.push(waiter)
        void pingAction
          .send('', id)
          .catch(err => waiter.reject(toError(err, 'peer disconnected')))
      })

      return Date.now() - start
    },

    isPassive: () => isPassive,

    getPeers: () =>
      fromEntries(
        entries(activePeerMap).map(([id, peer]) => [id, peer.connection])
      ) as Record<string, RTCPeerConnection>,

    getTopology: () => overlay.getSnapshot(),

    addStream: (stream, options: AddMediaOptions = {}) => {
      recordStreamTracks(stream)
      if (overlay.isOverlayActive() && !options.target) {
        const streamKey = genId(20)
        overlay.registerBroadcastStream(
          localSelfId,
          streamKey,
          stream,
          options.metadata
        )
        const targets = overlay.getMediaTargets(localSelfId)
        if (!targets.length) {
          return []
        }
        return mediaManager.addStream(
          stream,
          {...options, target: targets},
          streamMetaAction.send,
          localSelfId,
          streamKey
        )
      }
      return mediaManager.addStream(stream, options, streamMetaAction.send)
    },

    removeStream: (stream, options = {}) => {
      if (overlay.isOverlayActive() && !options.target) {
        const targets = overlay.unregisterBroadcastStream(localSelfId, stream)
        if (targets.length > 0) {
          mediaManager.removeStream(stream, targets)
        }
        if (typeof stream.id === 'string') {
          void mediaControlAction
            .send({op: 'rmStream', o: localSelfId, id: stream.id})
            .catch(noOp)
        }
        return
      }
      mediaManager.removeStream(stream, options.target)
    },

    addTrack: (track, stream, options: AddMediaOptions = {}) => {
      if (typeof track.id === 'string') {
        knownBroadcastTracks.set(track.id, {track, stream})
      }
      if (overlay.isOverlayActive() && !options.target) {
        const trackKey = genId(20)
        overlay.registerBroadcastTrack(
          localSelfId,
          trackKey,
          track,
          stream,
          options.metadata
        )
        const targets = overlay.getMediaTargets(localSelfId)
        if (!targets.length) {
          return []
        }
        return mediaManager.addTrack(
          track,
          stream,
          {...options, target: targets},
          trackMetaAction.send,
          localSelfId,
          trackKey
        )
      }
      return mediaManager.addTrack(track, stream, options, trackMetaAction.send)
    },

    removeTrack: (track, options = {}) => {
      mediaManager.removeTrack(track, options.target)
    },

    replaceTrack: (oldTrack, newTrack, options: AddMediaOptions = {}) => {
      const existing =
        typeof oldTrack.id === 'string'
          ? knownBroadcastTracks.get(oldTrack.id)
          : undefined
      if (typeof newTrack.id === 'string') {
        knownBroadcastTracks.set(newTrack.id, {
          track: newTrack,
          stream: existing?.stream ?? ({} as MediaStream)
        })
      }
      if (overlay.isOverlayActive() && !options.target) {
        const trackKey = genId(20)
        const targets = overlay.getMediaTargets(localSelfId)
        if (!targets.length) {
          return []
        }
        return mediaManager.replaceTrack(
          oldTrack,
          newTrack,
          {...options, target: targets},
          trackMetaAction.send,
          localSelfId,
          trackKey
        )
      }
      return mediaManager.replaceTrack(
        oldTrack,
        newTrack,
        options,
        trackMetaAction.send
      )
    },

    get onPeerJoin() {
      return listeners.onPeerJoin
    },

    set onPeerJoin(handler) {
      listeners.onPeerJoin = handler

      if (handler) {
        keys(activePeerMap).forEach(peerId => handler(peerId))
      }
    },

    get onPeerLeave() {
      return listeners.onPeerLeave
    },

    set onPeerLeave(handler) {
      listeners.onPeerLeave = handler
    },

    get onPeerStream() {
      return mediaManager.onPeerStream
    },

    set onPeerStream(handler) {
      mediaManager.onPeerStream = handler
    },

    get onPeerTrack() {
      return mediaManager.onPeerTrack
    },

    set onPeerTrack(handler) {
      mediaManager.onPeerTrack = handler
    }
  }
}
