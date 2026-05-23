import {genId} from './utils'
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

  return {
    getStreamKey: makeKeyGetter(localStreamKeys),
    getTrackKey: makeKeyGetter(localTrackKeys),
    rememberRemoteStream: (key, stream, streamId) => {
      remoteStreamsByKey.set(key, stream)

      if (streamId) {
        remoteStreamsById.set(streamId, stream)
      }
    },
    getRemoteStream: (key, streamId) =>
      remoteStreamsByKey.get(key) ??
      (streamId ? remoteStreamsById.get(streamId) : undefined),
    rememberRemoteTrack: (key, track, stream, trackId, streamId) => {
      const ref = {track, stream}

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
  getSharedMediaPeer
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
  const localMedia = createMediaIdentityCache()
  const listeners = {
    onPeerStream: null as
      | ((stream: MediaStream, peerId: string, metadata?: JsonValue) => void)
      | null,
    onPeerTrack: null as
      | ((
          track: MediaStreamTrack,
          stream: MediaStream,
          peerId: string,
          metadata?: JsonValue
        ) => void)
      | null
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

    getSharedMediaPeer(id)?.__trysteroMedia?.rememberRemoteStream(
      key,
      stream,
      typeof stream.id === 'string' ? stream.id : undefined
    )

    listeners.onPeerStream?.(stream, id, metadata)
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

    getSharedMediaPeer(id)?.__trysteroMedia?.rememberRemoteTrack(
      key,
      track,
      stream,
      typeof track.id === 'string' ? track.id : undefined,
      typeof stream.id === 'string' ? stream.id : undefined
    )

    listeners.onPeerTrack?.(track, stream, id, metadata)
  }

  const applyMediaOp = (
    targets: TargetPeers,
    key: string,
    metadata: JsonValue | undefined,
    sendMeta: InternalActionSender<InternalMediaMeta>,
    op: (peer: SharedMediaPeer) => void,
    mediaIds: Partial<InternalMediaMeta> = {}
  ): Promise<void>[] => {
    const payload = {
      k: key,
      ...mediaIds,
      ...(metadata === undefined ? {} : {m: metadata})
    }

    return iterate(targets, async (id, peer) => {
      await sendMeta(payload, id)
      op(peer)
    })
  }

  const manager = {
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

      const sharedPeer = getSharedMediaPeer(id)
      const cached = sharedPeer?.__trysteroMedia?.getRemoteStream(
        parsed.key,
        parsed.streamId
      )

      if (cached) {
        emitStream(id, parsed.key, cached, parsed.metadata)
        return
      }

      ;(pendingStreamMetas[id] ??= []).push(parsed)
    },

    receiveTrackMeta: (meta, id) => {
      if (!isActive(id)) {
        return
      }

      const parsed = toPendingMediaMeta(meta)

      if (!parsed) {
        return
      }

      const sharedPeer = getSharedMediaPeer(id)
      const cached = sharedPeer?.__trysteroMedia?.getRemoteTrack(
        parsed.key,
        parsed.trackId
      )

      if (cached) {
        emitTrack(id, parsed.key, cached.track, cached.stream, parsed.metadata)
        return
      }

      ;(pendingTrackMetas[id] ??= []).push(parsed)
    },

    receiveRemoteStream: (id, stream) => {
      if (!isActive(id)) {
        return
      }

      const next = pendingStreamMetas[id]?.shift()

      if (!next) {
        return
      }

      emitStream(id, next.key, stream, next.metadata)
    },

    receiveRemoteTrack: (id, track, stream) => {
      if (!isActive(id)) {
        return
      }

      const next = pendingTrackMetas[id]?.shift()

      if (!next) {
        return
      }

      emitTrack(id, next.key, track, stream, next.metadata)
    },

    clearPeer: id => {
      delete pendingStreamMetas[id]
      delete pendingTrackMetas[id]
    },

    get onPeerStream() {
      return listeners.onPeerStream
    },

    set onPeerStream(handler) {
      listeners.onPeerStream = handler
    },

    get onPeerTrack() {
      return listeners.onPeerTrack
    },

    set onPeerTrack(handler) {
      listeners.onPeerTrack = handler
    }
  } satisfies ReturnType<typeof createMediaManager>

  return manager
}
