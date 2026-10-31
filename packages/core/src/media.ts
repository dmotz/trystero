import {maxQueuedDataFrames} from './data-limits'
import {
  all,
  createEventEmitter,
  entries,
  keys,
  mkErr,
  toJson,
  warn
} from './utils'
import type {
  AddMediaOptions,
  JsonValue,
  MediaIdentityCache,
  PeerHandle,
  PeerMediaContext,
  StatefulListenerOptions,
  TargetPeers,
  Unsubscribe
} from './types'
import type {InternalActionSender} from './action-wire'

export type InternalMediaMeta = {
  k: string
  m?: JsonValue
  s?: string
  t?: string[]
}

type PendingMediaMeta = {
  key: string
  metadata?: JsonValue
  streamId?: string
  trackIds?: string[]
}

type MediaManagerDeps = {
  onPeerError: (peerId: string, error: Error) => void
  iterate: (
    targets: TargetPeers,
    f: (id: string, peer: PeerHandle) => Promise<void> | void
  ) => Promise<void>[]
  isActive: (id: string) => boolean
  preparePeer?: (id: string, peer: PeerHandle) => Promise<PeerHandle>
  getPeerUserId?: (peerId: string) => string
}

const toPendingMediaMeta = (value: unknown): PendingMediaMeta | null => {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as {k?: unknown}).k === 'string'
  ) {
    const rawTracks = (value as {t?: unknown}).t
    return {
      key: (value as {k: string}).k,
      ...(typeof (value as {s?: unknown}).s === 'string'
        ? {streamId: (value as {s: string}).s}
        : {}),
      ...(Array.isArray(rawTracks) &&
      rawTracks.every(id => typeof id === 'string')
        ? {trackIds: rawTracks as string[]}
        : {}),
      ...(Object.hasOwn(value as object, 'm')
        ? {metadata: (value as {m?: JsonValue}).m}
        : {})
    }
  }

  return null
}

const makeKeyGetter =
  <K extends object>(map: WeakMap<K, string>) =>
  (item: K): string => {
    let key = map.get(item)

    if (!key) {
      key = crypto.randomUUID()
      map.set(item, key)
    }

    return key
  }

export const createMediaIdentityCache = (): MediaIdentityCache => {
  const localStreamKeys = new WeakMap<MediaStream, string>()
  const remoteStreamsByKey = new Map<string, MediaStream>()
  const remoteStreamsById = new Map<string, MediaStream>()
  const remoteStreamKeys = new WeakMap<MediaStream, string>()

  return {
    getStreamKey: makeKeyGetter(localStreamKeys),
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

export const createMediaManager = ({
  iterate,
  isActive,
  preparePeer,
  getPeerUserId,
  onPeerError
}: MediaManagerDeps): {
  addStream: (
    stream: MediaStream,
    options: AddMediaOptions,
    sendMeta: InternalActionSender<InternalMediaMeta>
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
    handler: (stream: MediaStream, context: PeerMediaContext) => void,
    options?: StatefulListenerOptions
  ) => Unsubscribe
} => {
  const pendingStreamMetas: Record<string, PendingMediaMeta[]> = {}
  const peerMediaCaches: Record<string, MediaIdentityCache> = {}
  const peerSyncedStreams: Record<
    string,
    WeakMap<MediaStream, Map<MediaStreamTrack, string>>
  > = {}
  const peerEmittedStreams: Record<string, WeakMap<MediaStream, string>> = {}
  const peerActiveStreams: Record<
    string,
    Map<MediaStream, {metadata?: JsonValue; hadTracks: boolean}>
  > = {}
  const streamEmitter = createEventEmitter<[MediaStream, PeerMediaContext]>(
    'peer stream handler'
  )
  const localMedia = createMediaIdentityCache()
  const localStreamMetas = new WeakMap<MediaStream, JsonValue | undefined>()
  const localStreamRawTracks = new WeakMap<MediaStream, Set<MediaStreamTrack>>()
  const replacedTracks = new WeakMap<MediaStreamTrack, MediaStreamTrack>()
  const knownLocalStreams = new Set<MediaStream>()

  const getPeerMedia = (id: string): MediaIdentityCache =>
    (peerMediaCaches[id] ??= createMediaIdentityCache())

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
    const rawTracks = stream.getTracks?.() ?? []
    const prevRaw = localStreamRawTracks.get(stream)
    if (prevRaw) {
      for (const t of rawTracks) {
        if (!prevRaw.has(t)) {
          replacedTracks.delete(t)
        }
      }
    }
    localStreamRawTracks.set(stream, new Set(rawTracks))
    return rawTracks.map(resolveTrack)
  }

  const getStreamMetadata = (
    stream: MediaStream,
    options: AddMediaOptions
  ): JsonValue | undefined => {
    if (Object.hasOwn(options, 'metadata')) {
      localStreamMetas.set(stream, options.metadata)
      return options.metadata
    }
    return localStreamMetas.get(stream)
  }

  const queuePendingMeta = (
    metas: Record<string, PendingMediaMeta[]>,
    id: string,
    parsed: PendingMediaMeta
  ): void => {
    const queue = (metas[id] ??= [])

    if (queue.length >= maxQueuedDataFrames) {
      warn('too many pending stream metadata messages')
      onPeerError(id, mkErr('too many pending media metadata messages'))
      return
    }

    queue.push(parsed)
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

  const emitStream = (
    id: string,
    key: string,
    stream: MediaStream,
    metadata?: JsonValue
  ): void => {
    if (!isActive(id)) {
      return
    }

    getPeerMedia(id).rememberRemoteStream(
      key,
      stream,
      typeof stream.id === 'string' ? stream.id : undefined
    )

    const userId = getPeerUserId ? getPeerUserId(id) : id
    const ctx: PeerMediaContext =
      metadata === undefined
        ? {peerId: id, userId}
        : {peerId: id, userId, metadata}

    ;(peerActiveStreams[id] ??= new Map()).set(stream, {
      ...(metadata === undefined ? {} : {metadata}),
      hadTracks: (stream.getTracks?.().length ?? 0) > 0
    })

    const emittedMap = (peerEmittedStreams[id] ??= new WeakMap())
    const metaSig = metadata === undefined ? '' : `m:${toJson(metadata)}`
    const prevSig = emittedMap.get(stream)
    if (prevSig === undefined || prevSig !== metaSig) {
      emittedMap.set(stream, metaSig)
      streamEmitter.emit(stream, ctx)
    }
  }

  const manager: ReturnType<typeof createMediaManager> = {
    addStream: async (stream, options, sendMeta) => {
      knownLocalStreams.add(stream)
      const key = localMedia.getStreamKey(stream)
      const metadata = getStreamMetadata(stream, options)
      const effectiveTracks = resolveStreamTracks(stream)
      const rawTracks = stream.getTracks?.() ?? []

      await all(
        iterate(options.target, async (id, peer) => {
          const mediaPeer = preparePeer ? await preparePeer(id, peer) : peer
          const peerStreams = (peerSyncedStreams[id] ??= new WeakMap())
          let synced = peerStreams.get(stream)

          const isInitial = !synced
          const toAdd: MediaStreamTrack[] = []

          if (!synced) {
            synced = new Map(
              effectiveTracks.map(track => [
                track,
                typeof track?.id === 'string' ? track.id : ''
              ])
            )
            peerStreams.set(stream, synced)
          } else {
            const nextSet = new Set(effectiveTracks)
            for (const [prevTrack] of synced) {
              if (!nextSet.has(prevTrack)) {
                mediaPeer.removeTrack(prevTrack, stream)
                synced.delete(prevTrack)
              }
            }
            for (const nextTrack of effectiveTracks) {
              if (!synced.has(nextTrack)) {
                toAdd.push(nextTrack)
                synced.set(
                  nextTrack,
                  typeof nextTrack?.id === 'string' ? nextTrack.id : ''
                )
              }
            }
          }

          const trackIds = effectiveTracks
            .map(track => synced.get(track))
            .filter((tid): tid is string => Boolean(tid))
          const payload: InternalMediaMeta = {
            k: key,
            s: stream.id,
            ...(trackIds.length > 0 ? {t: trackIds} : {}),
            ...(metadata === undefined ? {} : {m: metadata})
          }
          await sendMeta(payload, id)

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
      void iterate(target, (id, peer) => {
        const prevTracks = peerSyncedStreams[id]?.get(stream)
        peerSyncedStreams[id]?.delete(stream)
        peer.removeStream(stream)
        if (prevTracks) {
          const rawSet = new Set(stream.getTracks?.() ?? [])
          for (const [track] of prevTracks) {
            if (!rawSet.has(track)) {
              peer.removeTrack(track, stream)
            }
          }
        }
      })
    },

    replaceTrack: async (oldTrack, newTrack, target) => {
      replacedTracks.set(oldTrack, newTrack)
      replacedTracks.delete(newTrack)
      await all(
        iterate(target, async (id, peer) => {
          const mediaPeer = preparePeer ? await preparePeer(id, peer) : peer
          const peerStreams = peerSyncedStreams[id]
          if (peerStreams) {
            for (const stream of knownLocalStreams) {
              const synced = peerStreams.get(stream)
              if (synced?.has(oldTrack)) {
                const signaledId =
                  synced.get(oldTrack) ??
                  (typeof oldTrack?.id === 'string' ? oldTrack.id : '')
                synced.delete(oldTrack)
                synced.set(newTrack, signaledId)
              }
            }
          }
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

      const cached = getPeerMedia(id).getRemoteStream(
        parsed.key,
        parsed.streamId
      )
      const cachedTracks = cached?.getTracks?.() ?? []

      if (cachedTracks.length > 0) {
        const waitingForNewTracks = Boolean(
          parsed.trackIds?.length &&
          cachedTracks.length < parsed.trackIds.length
        )
        if (!waitingForNewTracks) {
          emitStream(id, parsed.key, cached!, parsed.metadata)
          return
        }
      }

      queuePendingMeta(pendingStreamMetas, id, parsed)
    },

    receiveRemoteStream: (id, stream) => {
      if (!isActive(id)) {
        return
      }

      const queue = pendingStreamMetas[id]
      if (!queue?.length) {
        return
      }

      const streamId = typeof stream.id === 'string' ? stream.id : undefined
      const index = streamId
        ? queue.findIndex(meta => !meta.streamId || meta.streamId === streamId)
        : 0

      if (index < 0) {
        return
      }

      const candidate = queue[index]!
      const currentTracks = stream.getTracks?.() ?? []
      if (
        candidate.trackIds?.length &&
        currentTracks.length > 0 &&
        currentTracks.length < candidate.trackIds.length
      ) {
        return
      }

      const [next] = queue.splice(index, 1)
      if (next) {
        emitStream(id, next.key, stream, next.metadata)
      }
    },

    clearPeer: id => {
      delete pendingStreamMetas[id]
      delete peerMediaCaches[id]
      delete peerSyncedStreams[id]
      delete peerEmittedStreams[id]
      delete peerActiveStreams[id]
    },

    clearListeners: () => {
      streamEmitter.clear()
      keys(peerActiveStreams).forEach(id => {
        delete peerActiveStreams[id]
      })
    },

    onPeerStream: (handler, options) =>
      streamEmitter.subscribe(handler, options, () => {
        const items: [MediaStream, PeerMediaContext][] = []
        for (const [id, streamMap] of entries(peerActiveStreams)) {
          if (!isActive(id)) {
            delete peerActiveStreams[id]
            continue
          }
          const userId = getPeerUserId ? getPeerUserId(id) : id
          for (const [stream, info] of streamMap.entries()) {
            if (!isRemoteStreamActive(stream, info.hadTracks)) {
              streamMap.delete(stream)
              continue
            }
            items.push([
              stream,
              info.metadata === undefined
                ? {peerId: id, userId}
                : {peerId: id, userId, metadata: info.metadata}
            ])
          }
        }
        return items
      })
  }

  return manager
}
