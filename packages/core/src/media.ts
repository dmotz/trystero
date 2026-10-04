import {maxQueuedDataFrames} from './data-limits'
import {genId, libName, mkErr} from './utils'
import type {
  AddMediaOptions,
  JsonValue,
  MediaIdentityCache,
  RemoteTrackRef,
  SharedMediaPeer,
  TargetPeers
} from './types'
import type {InternalActionSender} from './action-wire'

export type InternalMediaMeta = {
  k: string
  m?: JsonValue
  s?: string
  t?: string
}

type PendingMediaMeta = {
  key: string
  metadata?: JsonValue
  streamId?: string
  trackId?: string
}

type MediaManagerDeps = {
  onPeerError: (peerId: string, error: Error) => void
  iterate: (
    targets: TargetPeers,
    f: (id: string, peer: SharedMediaPeer) => Promise<void> | void
  ) => Promise<void>[]
  isActive: (id: string) => boolean
  getSharedMediaPeer: (id: string) => SharedMediaPeer | null
}

const toPendingMediaMeta = (value: unknown): PendingMediaMeta | null => {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as {k?: unknown}).k === 'string'
  ) {
    return {
      key: (value as {k: string}).k,
      ...(typeof (value as {s?: unknown}).s === 'string'
        ? {streamId: (value as {s: string}).s}
        : {}),
      ...(typeof (value as {t?: unknown}).t === 'string'
        ? {trackId: (value as {t: string}).t}
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
      key = genId(20)
      map.set(item, key)
    }

    return key
  }

export const createMediaIdentityCache = (): MediaIdentityCache => {
  const localStreamKeys = new WeakMap<MediaStream, string>()
  const localTrackKeys = new WeakMap<MediaStreamTrack, string>()
  const remoteStreamsByKey = new Map<string, MediaStream>()
  const remoteStreamsById = new Map<string, MediaStream>()
  const remoteTracksByKey = new Map<string, RemoteTrackRef>()
  const remoteTracksById = new Map<string, RemoteTrackRef>()
  const remoteStreamKeys = new WeakMap<MediaStream, string>()
  const remoteTrackKeys = new WeakMap<MediaStreamTrack, string>()

  return {
    getStreamKey: makeKeyGetter(localStreamKeys),
    getTrackKey: makeKeyGetter(localTrackKeys),
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

      stream.getTracks?.().forEach(track => {
        if (typeof track.id === 'string') {
          remoteTracksById.set(track.id, {track, stream})
        }
      })
    },
    getRemoteStream: (key, streamId) =>
      remoteStreamsByKey.get(key) ??
      (streamId ? remoteStreamsById.get(streamId) : undefined),
    rememberRemoteTrack: (key, track, stream, trackId, streamId) => {
      const ref = {track, stream}
      const previous = remoteTrackKeys.get(track)
      if (
        previous !== undefined &&
        remoteTracksByKey.get(previous)?.track === track
      ) {
        remoteTracksByKey.delete(previous)
      }
      remoteTrackKeys.set(track, key)
      remoteTracksByKey.set(key, ref)

      if (trackId) {
        remoteTracksById.set(trackId, ref)
      }

      if (streamId) {
        remoteStreamsById.set(streamId, stream)
      }
    },
    getRemoteTrack: (key, trackId) =>
      remoteTracksByKey.get(key) ??
      (trackId ? remoteTracksById.get(trackId) : undefined),
    hasRemoteMedia: () =>
      remoteStreamsByKey.size > 0 || remoteTracksByKey.size > 0,
    clearRemote: () => {
      remoteStreamsByKey.clear()
      remoteStreamsById.clear()
      remoteTracksByKey.clear()
      remoteTracksById.clear()
    }
  }
}

export const createMediaManager = ({
  iterate,
  isActive,
  getSharedMediaPeer,
  onPeerError
}: MediaManagerDeps): {
  addStream: (
    stream: MediaStream,
    options: AddMediaOptions,
    sendMeta: InternalActionSender<InternalMediaMeta>
  ) => Promise<void>[]
  removeStream: (stream: MediaStream, target: TargetPeers) => void
  addTrack: (
    track: MediaStreamTrack,
    stream: MediaStream,
    options: AddMediaOptions,
    sendMeta: InternalActionSender<InternalMediaMeta>
  ) => Promise<void>[]
  removeTrack: (track: MediaStreamTrack, target: TargetPeers) => void
  replaceTrack: (
    oldTrack: MediaStreamTrack,
    newTrack: MediaStreamTrack,
    options: AddMediaOptions,
    sendMeta: InternalActionSender<InternalMediaMeta>
  ) => Promise<void>[]
  receiveStreamMeta: (meta: unknown, peerId: string) => void
  receiveTrackMeta: (meta: unknown, peerId: string) => void
  receiveRemoteStream: (peerId: string, stream: MediaStream) => void
  receiveRemoteTrack: (
    peerId: string,
    track: MediaStreamTrack,
    stream: MediaStream
  ) => void
  clearPeer: (peerId: string) => void
  onPeerStream:
    | ((stream: MediaStream, peerId: string, metadata?: JsonValue) => void)
    | null
  onPeerTrack:
    | ((
        track: MediaStreamTrack,
        stream: MediaStream,
        peerId: string,
        metadata?: JsonValue
      ) => void)
    | null
} => {
  const pendingStreamMetas: Record<string, PendingMediaMeta[]> = {}
  const pendingTrackMetas: Record<string, PendingMediaMeta[]> = {}
  const peerMediaCaches: Record<string, MediaIdentityCache> = {}
  const localMedia = createMediaIdentityCache()

  const getPeerMedia = (id: string): MediaIdentityCache =>
    getSharedMediaPeer(id)?.__trysteroMedia ??
    (peerMediaCaches[id] ??= createMediaIdentityCache())

  const queuePendingMeta = (
    metas: Record<string, PendingMediaMeta[]>,
    id: string,
    parsed: PendingMediaMeta,
    kind: 'stream' | 'track'
  ): void => {
    const queue = (metas[id] ??= [])

    if (queue.length >= maxQueuedDataFrames) {
      console.warn(`${libName}: too many pending ${kind} metadata messages`)
      onPeerError(id, mkErr('too many pending media metadata messages'))
      return
    }

    queue.push(parsed)
  }

  const takePendingMeta = (
    queue: PendingMediaMeta[] | undefined,
    idValue: string | undefined,
    getMetaId: (meta: PendingMediaMeta) => string | undefined
  ): PendingMediaMeta | undefined => {
    if (!queue?.length) {
      return undefined
    }

    const index = idValue
      ? queue.findIndex(meta => {
          const metaId = getMetaId(meta)
          return !metaId || metaId === idValue
        })
      : 0

    return index >= 0 ? queue.splice(index, 1)[0] : undefined
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

    manager.onPeerStream?.(stream, id, metadata)
  }

  const emitTrack = (
    id: string,
    key: string,
    track: MediaStreamTrack,
    stream: MediaStream,
    metadata?: JsonValue
  ): void => {
    if (!isActive(id)) {
      return
    }

    getPeerMedia(id).rememberRemoteTrack(
      key,
      track,
      stream,
      typeof track.id === 'string' ? track.id : undefined,
      typeof stream.id === 'string' ? stream.id : undefined
    )

    manager.onPeerTrack?.(track, stream, id, metadata)
  }

  const applyMediaOp = (
    targets: TargetPeers,
    key: string,
    metadata: JsonValue | undefined,
    sendMeta: InternalActionSender<InternalMediaMeta>,
    op: (peer: SharedMediaPeer) => void | Promise<void>,
    mediaIds: Partial<InternalMediaMeta> = {}
  ): Promise<void>[] => {
    const payload = {
      k: key,
      ...mediaIds,
      ...(metadata === undefined ? {} : {m: metadata})
    }

    return iterate(targets, async (id, peer) => {
      await sendMeta(payload, id)
      await op(peer)
    })
  }

  const manager: ReturnType<typeof createMediaManager> = {
    addStream: (stream, options, sendMeta) =>
      applyMediaOp(
        options.target,
        localMedia.getStreamKey(stream),
        options.metadata,
        sendMeta,
        peer => peer.addStream(stream),
        {s: stream.id}
      ),

    removeStream: (stream, target) => {
      void iterate(target, (_, peer) => peer.removeStream(stream))
    },

    addTrack: (track, stream, options, sendMeta) =>
      applyMediaOp(
        options.target,
        localMedia.getTrackKey(track),
        options.metadata,
        sendMeta,
        peer => peer.addTrack(track, stream),
        {s: stream.id, t: track.id}
      ),

    removeTrack: (track, target) => {
      void iterate(target, (_, peer) => peer.removeTrack(track))
    },

    replaceTrack: (oldTrack, newTrack, options, sendMeta) =>
      applyMediaOp(
        options.target,
        localMedia.getTrackKey(newTrack),
        options.metadata,
        sendMeta,
        peer => peer.replaceTrack(oldTrack, newTrack),
        {t: oldTrack.id}
      ),

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

      if (cached?.getTracks().length) {
        emitStream(id, parsed.key, cached, parsed.metadata)
        return
      }

      queuePendingMeta(pendingStreamMetas, id, parsed, 'stream')
    },

    receiveTrackMeta: (meta, id) => {
      if (!isActive(id)) {
        return
      }

      const parsed = toPendingMediaMeta(meta)

      if (!parsed) {
        return
      }

      const cached = getPeerMedia(id).getRemoteTrack(parsed.key, parsed.trackId)

      if (
        cached &&
        cached.track.readyState !== 'ended' &&
        (!cached.stream.getTracks ||
          cached.stream.getTracks().includes(cached.track))
      ) {
        emitTrack(id, parsed.key, cached.track, cached.stream, parsed.metadata)
        return
      }

      queuePendingMeta(pendingTrackMetas, id, parsed, 'track')
    },

    receiveRemoteStream: (id, stream) => {
      if (!isActive(id)) {
        return
      }

      const next = takePendingMeta(
        pendingStreamMetas[id],
        typeof stream.id === 'string' ? stream.id : undefined,
        meta => meta.streamId
      )

      if (!next) {
        return
      }

      emitStream(id, next.key, stream, next.metadata)
    },

    receiveRemoteTrack: (id, track, stream) => {
      if (!isActive(id)) {
        return
      }

      const queue = pendingTrackMetas[id]
      const trackId = typeof track.id === 'string' ? track.id : undefined
      const streamId = typeof stream.id === 'string' ? stream.id : undefined
      const byTrackIdx =
        queue && trackId
          ? queue.findIndex(meta => meta.trackId === trackId)
          : -1
      const next =
        byTrackIdx >= 0
          ? queue?.splice(byTrackIdx, 1)[0]
          : takePendingMeta(queue, streamId, meta => meta.streamId)

      if (!next) {
        return
      }

      emitTrack(id, next.key, track, stream, next.metadata)
    },

    clearPeer: id => {
      delete pendingStreamMetas[id]
      delete pendingTrackMetas[id]
      delete peerMediaCaches[id]
    },

    onPeerStream: null,
    onPeerTrack: null
  }

  return manager
}
