import {maxQueuedDataFrames} from './data-limits'
import type {
  MediaIdentityCache,
  PeerHandle,
  TargetPeers
} from './internal-types'
import type {
  AddMediaOptions,
  JsonValue,
  PeerMediaContext,
  ReplayListenerOptions,
  SendOptions,
  Unsubscribe
} from './types'
import {
  all,
  createEventEmitter,
  entries,
  isObj,
  keys,
  mkErr,
  peerDisconnectedErr,
  toJson,
  warn
} from './utils'

export type InternalMediaMeta = {
  k: string
  m?: JsonValue
  s?: string
  t?: number
}

type PendingMediaMeta = {
  key: string
  streamId: string | undefined
  expectedTrackCount: number | undefined
  hasMetadata: boolean
  metadata: JsonValue | undefined
}

type ActiveStreamEntry = {
  hasMetadata: boolean
  metadata: JsonValue | undefined
  hadTracks: boolean
  cleanup: () => void
}

const toPendingMediaMeta = (value: unknown): PendingMediaMeta | null => {
  if (!isObj(value) || typeof value['k'] !== 'string') {
    return null
  }
  const rawTrackCount = value['t']
  const hasMetadata = Object.hasOwn(value, 'm')
  return {
    key: value['k'],
    streamId: typeof value['s'] === 'string' ? value['s'] : undefined,
    expectedTrackCount:
      typeof rawTrackCount === 'number' &&
      Number.isInteger(rawTrackCount) &&
      rawTrackCount >= 0
        ? rawTrackCount
        : undefined,
    hasMetadata,
    metadata: hasMetadata ? (value['m'] as JsonValue | undefined) : undefined
  }
}

const tracksOf = (stream?: MediaStream): MediaStreamTrack[] =>
  stream?.getTracks?.() ?? []

const streamIdOf = (stream: {id?: unknown}): string | undefined =>
  typeof stream.id === 'string' ? stream.id : undefined

const waitingForTracks = (
  expectedCount: number | undefined,
  currentTracks: MediaStreamTrack[]
): boolean =>
  Boolean(
    expectedCount &&
    currentTracks.length > 0 &&
    currentTracks.length < expectedCount
  )

const makeStreamKeyGetter = (): ((stream: MediaStream) => string) => {
  const localStreamKeys = new WeakMap<MediaStream, string>()
  return stream => {
    let key = localStreamKeys.get(stream)
    if (!key) {
      key = crypto.randomUUID()
      localStreamKeys.set(stream, key)
    }
    return key
  }
}

export const createMediaIdentityCache = (): MediaIdentityCache => {
  const remoteStreamsByKey = new Map<string, MediaStream>()
  const remoteStreamsById = new Map<string, MediaStream>()
  const remoteStreamKeys = new WeakMap<MediaStream, string>()

  return {
    getStreamKey: makeStreamKeyGetter(),
    rememberRemoteStream: (key, stream, streamId) => {
      const previous = remoteStreamKeys.get(stream)
      if (
        previous !== undefined &&
        remoteStreamsByKey.get(previous) === stream
      ) {
        remoteStreamsByKey.delete(previous)
      }
      remoteStreamKeys.set(stream, key)
      remoteStreamsByKey.set(key, stream)
      if (streamId) {
        remoteStreamsById.set(streamId, stream)
      }
    },
    getRemoteStream: (key, streamId) =>
      remoteStreamsByKey.get(key) ??
      (streamId ? remoteStreamsById.get(streamId) : undefined),
    hasRemoteMedia: () => remoteStreamsByKey.size > 0,
    clearRemote: () => {
      remoteStreamsByKey.clear()
      remoteStreamsById.clear()
    }
  }
}

export type MediaManagerDeps = {
  onPeerError: (peerId: string, error: Error) => void
  iterate: (
    targets: TargetPeers,
    f: (id: string, directPeer?: PeerHandle) => Promise<void> | void
  ) => Promise<void>[]
  isActive: (id: string) => boolean
  preparePeer?: (id: string) => Promise<PeerHandle>
  getPeerUserId?: (peerId: string) => string
  onPeerMediaPinChange?: (peerId: string, pinned: boolean) => void
}

export type MediaManager = {
  addStream: (
    stream: MediaStream,
    options: AddMediaOptions,
    sendMeta: (data: InternalMediaMeta, options?: SendOptions) => Promise<void>
  ) => Promise<void>
  removeStream: (stream: MediaStream, target: TargetPeers) => void
  replaceTrack: (
    oldTrack: MediaStreamTrack,
    newTrack: MediaStreamTrack,
    target?: TargetPeers
  ) => Promise<void>
  receiveStreamMeta: (meta: unknown, peerId: string) => void
  receiveRemoteStream: (peerId: string, stream: MediaStream) => void
  clearPeer: (peerId: string) => void
  clearListeners: () => void
  onPeerStream: (
    handler: (stream: MediaStream, context: PeerMediaContext) => unknown,
    options?: ReplayListenerOptions
  ) => Unsubscribe
}

export const createMediaManager = ({
  iterate,
  isActive,
  preparePeer,
  getPeerUserId,
  onPeerError,
  onPeerMediaPinChange
}: MediaManagerDeps): MediaManager => {
  const pendingStreamMetas: Record<string, PendingMediaMeta[]> = {}
  const pendingRemoteStreams: Record<string, MediaStream[]> = {}
  const peerMediaCaches: Record<string, MediaIdentityCache> = {}
  const peerSyncedStreams: Record<
    string,
    WeakMap<MediaStream, Set<MediaStreamTrack>>
  > = {}
  const peerEmittedStreams: Record<string, WeakMap<MediaStream, string>> = {}
  const peerActiveStreams: Record<
    string,
    Map<MediaStream, ActiveStreamEntry>
  > = {}
  const [subStream, emitStreamEvt, clearStreamEvt] = createEventEmitter<
    [MediaStream, PeerMediaContext]
  >('peer stream handler')
  const getLocalStreamKey = makeStreamKeyGetter()
  const localStreamMetas = new WeakMap<MediaStream, JsonValue | undefined>()
  const localStreamRawTracks = new WeakMap<MediaStream, Set<MediaStreamTrack>>()
  const replacedTracks = new WeakMap<MediaStreamTrack, MediaStreamTrack>()
  const knownLocalStreams = new Set<MediaStream>()

  const getPeerMedia = (id: string): MediaIdentityCache =>
    (peerMediaCaches[id] ??= createMediaIdentityCache())

  const hasSyncedLocalMediaForPeer = (id: string): boolean => {
    const peerStreams = peerSyncedStreams[id]
    if (!peerStreams) {
      return false
    }
    for (const stream of knownLocalStreams) {
      if (peerStreams.has(stream)) {
        return true
      }
    }
    return false
  }

  const updatePeerPin = (id: string): void => {
    onPeerMediaPinChange?.(
      id,
      Boolean(peerActiveStreams[id]?.size) || hasSyncedLocalMediaForPeer(id)
    )
  }

  const getMediaPeer = async (
    id: string,
    directPeer?: PeerHandle
  ): Promise<PeerHandle> => {
    const mediaPeer =
      directPeer ?? (preparePeer ? await preparePeer(id) : undefined)
    if (!mediaPeer) {
      throw peerDisconnectedErr
    }
    return mediaPeer
  }

  const removeActiveStream = (
    id: string,
    stream: MediaStream,
    info: ActiveStreamEntry
  ): void => {
    info.cleanup()
    const currentMap = peerActiveStreams[id]
    currentMap?.delete(stream)
    if (currentMap && !currentMap.size) {
      delete peerActiveStreams[id]
    }
    updatePeerPin(id)
  }

  const unbufferRemoteStream = (id: string, index: number): void => {
    const list = pendingRemoteStreams[id]
    if (list && index >= 0) {
      list.splice(index, 1)
      if (!list.length) {
        delete pendingRemoteStreams[id]
      }
    }
  }

  const resolveTrack = (track: MediaStreamTrack): MediaStreamTrack => {
    let current = track
    const seen = new Set<MediaStreamTrack>()
    while (replacedTracks.has(current) && !seen.has(current)) {
      seen.add(current)
      current = replacedTracks.get(current)!
    }
    return current
  }

  const resolveStreamTracks = (stream: MediaStream): MediaStreamTrack[] => {
    const rawTracks = tracksOf(stream)
    const prevRaw = localStreamRawTracks.get(stream)
    if (prevRaw) {
      for (const track of rawTracks) {
        if (!prevRaw.has(track)) {
          replacedTracks.delete(track)
        }
      }
    }
    localStreamRawTracks.set(stream, new Set(rawTracks))
    return rawTracks.map(resolveTrack)
  }

  const isRemoteStreamActive = (
    stream: MediaStream,
    hadTracks: boolean
  ): boolean => {
    if ('active' in stream && stream.active === false) {
      return false
    }
    const tracks = stream.getTracks?.()
    if (!tracks) {
      return true
    }
    if (hadTracks && tracks.length === 0) {
      return false
    }
    return tracks.length === 0 || !tracks.every(t => t?.readyState === 'ended')
  }

  const clearPeerActiveStreams = (id: string): void => {
    const streamMap = peerActiveStreams[id]
    if (!streamMap) {
      return
    }
    for (const entry of streamMap.values()) {
      entry.cleanup()
    }
    delete peerActiveStreams[id]
  }

  const toMediaCtx = (
    id: string,
    hasMetadata: boolean,
    metadata: JsonValue | undefined
  ): PeerMediaContext => {
    const userId = getPeerUserId ? getPeerUserId(id) : id
    return hasMetadata && metadata !== undefined
      ? {peerId: id, userId, metadata}
      : {peerId: id, userId}
  }

  const emitStream = (
    id: string,
    key: string,
    stream: MediaStream,
    hasMetadata: boolean,
    metadata?: JsonValue
  ): void => {
    if (!isActive(id)) {
      return
    }

    getPeerMedia(id).rememberRemoteStream(key, stream, streamIdOf(stream))

    const ctx = toMediaCtx(id, hasMetadata, metadata)
    const streamMap = (peerActiveStreams[id] ??= new Map())
    const prevEntry = streamMap.get(stream)
    prevEntry?.cleanup()

    const cleanups: Array<() => void> = []
    const curTracks = tracksOf(stream)
    const entry: ActiveStreamEntry = {
      hasMetadata,
      metadata,
      hadTracks: Boolean(prevEntry?.hadTracks || curTracks.length > 0),
      cleanup: () => {
        while (cleanups.length > 0) {
          cleanups.pop()!()
        }
      }
    }

    const pruneIfInactive = (): void => {
      if (!isRemoteStreamActive(stream, entry.hadTracks)) {
        removeActiveStream(id, stream, entry)
      }
    }

    const listen = (
      target: {
        addEventListener?: (e: string, cb: () => void) => void
        removeEventListener: (e: string, cb: () => void) => void
      },
      evt: string
    ): void => {
      if (typeof target.addEventListener === 'function') {
        target.addEventListener(evt, pruneIfInactive)
        cleanups.push(() => target.removeEventListener(evt, pruneIfInactive))
      }
    }
    listen(stream, 'removetrack')
    listen(stream, 'inactive')
    for (const track of curTracks) {
      if (track) {
        listen(track, 'ended')
      }
    }

    streamMap.set(stream, entry)
    updatePeerPin(id)
    pruneIfInactive()

    const emittedMap = (peerEmittedStreams[id] ??= new WeakMap())
    const metaSig =
      hasMetadata && metadata !== undefined ? `m:${toJson(metadata)}` : ''
    if (emittedMap.get(stream) !== metaSig) {
      emittedMap.set(stream, metaSig)
      emitStreamEvt(stream, ctx)
    }
  }

  return {
    addStream: async (stream, options, sendMeta) => {
      knownLocalStreams.add(stream)
      const key = getLocalStreamKey(stream)
      const metadata = Object.hasOwn(options, 'metadata')
        ? (localStreamMetas.set(stream, options.metadata), options.metadata)
        : localStreamMetas.get(stream)
      const effectiveTracks = resolveStreamTracks(stream)
      const rawTracks = tracksOf(stream)

      await all(
        iterate(options.target, async (id, directPeer) => {
          const mediaPeer = await getMediaPeer(id, directPeer)
          const peerStreams = (peerSyncedStreams[id] ??= new WeakMap())
          let synced = peerStreams.get(stream)

          const isInitial = !synced
          const toAdd: MediaStreamTrack[] = []

          if (!synced) {
            synced = new Set(effectiveTracks)
            peerStreams.set(stream, synced)
          } else {
            const nextSet = new Set(effectiveTracks)
            for (const prevTrack of synced.difference(nextSet)) {
              mediaPeer.removeTrack(prevTrack, stream)
              synced.delete(prevTrack)
            }
            for (const nextTrack of nextSet.difference(synced)) {
              toAdd.push(nextTrack)
              synced.add(nextTrack)
            }
          }

          updatePeerPin(id)

          await sendMeta(
            {
              k: key,
              s: stream.id,
              ...(effectiveTracks.length > 0
                ? {t: effectiveTracks.length}
                : {}),
              ...(metadata === undefined ? {} : {m: metadata})
            },
            {target: id}
          )

          if (isInitial) {
            if (
              effectiveTracks.length !== rawTracks.length ||
              effectiveTracks.some((t, i) => t !== rawTracks[i])
            ) {
              effectiveTracks.forEach(track =>
                mediaPeer.addTrack(track, stream)
              )
            } else {
              mediaPeer.addStream(stream)
            }
          } else {
            toAdd.forEach(nextTrack => mediaPeer.addTrack(nextTrack, stream))
          }
        })
      )
    },

    removeStream: (stream, target) => {
      if (!target) {
        knownLocalStreams.delete(stream)
        localStreamMetas.delete(stream)
        localStreamRawTracks.delete(stream)
      }
      void iterate(target, (id, directPeer) => {
        const prevTracks = peerSyncedStreams[id]?.get(stream)
        peerSyncedStreams[id]?.delete(stream)
        updatePeerPin(id)
        if (!directPeer) {
          return
        }
        directPeer.removeStream(stream)
        if (prevTracks) {
          for (const track of prevTracks.difference(
            new Set(tracksOf(stream))
          )) {
            directPeer.removeTrack(track, stream)
          }
        }
      })
    },

    replaceTrack: async (oldTrack, newTrack, target) => {
      replacedTracks.set(oldTrack, newTrack)
      replacedTracks.delete(newTrack)
      await all(
        iterate(target, async (id, directPeer) => {
          const peerStreams = peerSyncedStreams[id]
          let hasMatchingStream = false
          if (peerStreams) {
            for (const stream of knownLocalStreams) {
              const synced = peerStreams.get(stream)
              if (synced?.has(oldTrack)) {
                synced.delete(oldTrack)
                synced.add(newTrack)
                hasMatchingStream = true
              }
            }
          }
          if (!hasMatchingStream && !directPeer) {
            return
          }
          const mediaPeer = await getMediaPeer(id, directPeer)
          await mediaPeer.replaceTrack(oldTrack, newTrack)
        })
      )
    },

    receiveStreamMeta: (meta, id) => {
      if (!isActive(id)) {
        return
      }
      const parsed = toPendingMediaMeta(meta)
      if (!parsed) {
        return
      }

      const bufferedStreams = pendingRemoteStreams[id]
      const bufferedIdx = bufferedStreams?.length
        ? parsed.streamId
          ? bufferedStreams.findIndex(s => s.id === parsed.streamId)
          : 0
        : -1
      const candidateStream =
        bufferedIdx >= 0
          ? bufferedStreams![bufferedIdx]
          : getPeerMedia(id).getRemoteStream(parsed.key, parsed.streamId)
      const candidateTracks = tracksOf(candidateStream)

      if (
        candidateStream &&
        (bufferedIdx >= 0 || candidateTracks.length > 0) &&
        !waitingForTracks(parsed.expectedTrackCount, candidateTracks)
      ) {
        unbufferRemoteStream(id, bufferedIdx)
        emitStream(
          id,
          parsed.key,
          candidateStream,
          parsed.hasMetadata,
          parsed.metadata
        )
        return
      }

      const queue = (pendingStreamMetas[id] ??= [])
      const existingIdx = queue.findIndex(item => item.key === parsed.key)
      if (existingIdx >= 0) {
        queue[existingIdx] = parsed
        return
      }
      if (queue.length >= maxQueuedDataFrames) {
        warn('too many pending stream metadata messages')
        onPeerError(id, mkErr('too many pending media metadata messages'))
        return
      }
      queue.push(parsed)
    },

    receiveRemoteStream: (id, stream) => {
      if (!isActive(id)) {
        return
      }
      const bufferStream = (): void => {
        const list = (pendingRemoteStreams[id] ??= [])
        if (!list.includes(stream) && list.length < maxQueuedDataFrames) {
          list.push(stream)
        }
      }

      const queue = pendingStreamMetas[id]
      if (!queue?.length) {
        bufferStream()
        return
      }

      const streamId = streamIdOf(stream)
      const index = streamId
        ? queue.findIndex(m => !m.streamId || m.streamId === streamId)
        : 0
      if (
        index < 0 ||
        waitingForTracks(queue[index]!.expectedTrackCount, tracksOf(stream))
      ) {
        bufferStream()
        return
      }

      const [next] = queue.splice(index, 1)
      if (next) {
        const list = pendingRemoteStreams[id]
        if (list) {
          unbufferRemoteStream(id, list.indexOf(stream))
        }
        emitStream(id, next.key, stream, next.hasMetadata, next.metadata)
      }
    },

    clearPeer: id => {
      ;[
        pendingStreamMetas,
        pendingRemoteStreams,
        peerMediaCaches,
        peerSyncedStreams,
        peerEmittedStreams
      ].forEach(map => {
        delete map[id]
      })
      clearPeerActiveStreams(id)
      onPeerMediaPinChange?.(id, false)
    },

    clearListeners: () => {
      clearStreamEvt()
      keys(peerActiveStreams).forEach(id => {
        clearPeerActiveStreams(id)
        updatePeerPin(id)
      })
    },

    onPeerStream: (handler, options) =>
      subStream(handler, options, () => {
        const items: [MediaStream, PeerMediaContext][] = []
        for (const [id, streamMap] of entries(peerActiveStreams)) {
          if (!isActive(id)) {
            clearPeerActiveStreams(id)
            updatePeerPin(id)
            continue
          }
          for (const [stream, info] of streamMap.entries()) {
            if (!isRemoteStreamActive(stream, info.hadTracks)) {
              removeActiveStream(id, stream, info)
              continue
            }
            items.push([
              stream,
              toMediaCtx(id, info.hasMetadata, info.metadata)
            ])
          }
        }
        return items
      })
  }
}
