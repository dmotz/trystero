import {maxQueuedDataFrames} from './data-limits'
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
import type {MediaIdentityCache} from './internal-types'
import type {
  AddMediaOptions,
  JsonValue,
  PeerHandle,
  PeerMediaContext,
  ReplayListenerOptions,
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

type PendingMediaMeta = [
  key: string,
  streamId: string | undefined,
  trackIds: string[] | undefined,
  hasMeta: boolean,
  metadata: JsonValue | undefined
]

type MediaIdentityCacheTuple = readonly [
  getStreamKey: (stream: MediaStream) => string,
  rememberRemoteStream: (
    key: string,
    stream: MediaStream,
    streamId?: string
  ) => void,
  getRemoteStream: (key: string, streamId?: string) => MediaStream | undefined,
  hasRemoteMedia: () => boolean,
  clearRemote: () => void
]

const toPendingMediaMeta = (value: unknown): PendingMediaMeta | null => {
  if (!isObj(value) || typeof value['k'] !== 'string') {
    return null
  }
  const rawTracks = value['t']
  const hasMeta = Object.hasOwn(value, 'm')
  return [
    value['k'],
    typeof value['s'] === 'string' ? value['s'] : undefined,
    Array.isArray(rawTracks) && rawTracks.every(id => typeof id === 'string')
      ? (rawTracks as string[])
      : undefined,
    hasMeta,
    hasMeta ? (value['m'] as JsonValue | undefined) : undefined
  ]
}

const tracksOf = (s?: MediaStream): MediaStreamTrack[] => s?.getTracks?.() ?? []
const trackIdOf = (t?: {id?: unknown}): string =>
  typeof t?.id === 'string' ? t.id : ''
const streamIdOf = (s: {id?: unknown}): string | undefined =>
  typeof s.id === 'string' ? s.id : undefined
const waitingForTracks = (
  exp: string[] | undefined,
  cur: MediaStreamTrack[]
): boolean => Boolean(exp?.length && cur.length > 0 && cur.length < exp.length)

const makeStreamKeyGetter = (): ((stream: MediaStream) => string) => {
  const localStreamKeys = new WeakMap<MediaStream, string>()
  return item => {
    let key = localStreamKeys.get(item)
    if (!key) {
      key = crypto.randomUUID()
      localStreamKeys.set(item, key)
    }
    return key
  }
}

export const initMediaIdentityCache = (): MediaIdentityCacheTuple => {
  const remoteStreamsByKey = new Map<string, MediaStream>()
  const remoteStreamsById = new Map<string, MediaStream>()
  const remoteStreamKeys = new WeakMap<MediaStream, string>()

  return [
    makeStreamKeyGetter(),
    (key, stream, streamId) => {
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
    (key, streamId) =>
      remoteStreamsByKey.get(key) ??
      (streamId ? remoteStreamsById.get(streamId) : undefined),
    () => remoteStreamsByKey.size > 0,
    () => {
      remoteStreamsByKey.clear()
      remoteStreamsById.clear()
    }
  ]
}

export const createMediaIdentityCache = (): MediaIdentityCache => {
  const [
    getStreamKey,
    rememberRemoteStream,
    getRemoteStream,
    hasRemoteMedia,
    clearRemote
  ] = initMediaIdentityCache()
  return {
    getStreamKey,
    rememberRemoteStream,
    getRemoteStream,
    hasRemoteMedia,
    clearRemote
  }
}

export type MediaManagerTuple = readonly [
  addStream: (
    stream: MediaStream,
    options: AddMediaOptions,
    sendMeta: InternalActionSender<InternalMediaMeta>
  ) => Promise<void>,
  removeStream: (stream: MediaStream, target: TargetPeers) => void,
  replaceTrack: (
    oldTrack: MediaStreamTrack,
    newTrack: MediaStreamTrack,
    target?: TargetPeers
  ) => Promise<void>,
  receiveStreamMeta: (meta: unknown, peerId: string) => void,
  receiveRemoteStream: (peerId: string, stream: MediaStream) => void,
  clearPeer: (peerId: string) => void,
  clearListeners: () => void,
  onPeerStream: (
    handler: (stream: MediaStream, context: PeerMediaContext) => unknown,
    options?: ReplayListenerOptions
  ) => Unsubscribe
]

export const initMediaManager = (
  iterate: (
    targets: TargetPeers,
    f: (id: string, directPeer?: PeerHandle) => Promise<void> | void
  ) => Promise<void>[],
  isActive: (id: string) => boolean,
  onPeerError: (peerId: string, error: Error) => void,
  preparePeer?: (id: string) => Promise<PeerHandle>,
  getPeerUserId?: (peerId: string) => string
): MediaManagerTuple => {
  type ActiveStreamEntry = [
    hasMeta: boolean,
    metadata: JsonValue | undefined,
    hadTracks: boolean,
    cleanup: () => void
  ]

  const pendingStreamMetas: Record<string, PendingMediaMeta[]> = {}
  const pendingRemoteStreams: Record<string, MediaStream[]> = {}
  const peerMediaCaches: Record<string, MediaIdentityCacheTuple> = {}
  const peerSyncedStreams: Record<
    string,
    WeakMap<MediaStream, Map<MediaStreamTrack, string>>
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

  const getPeerMedia = (id: string): MediaIdentityCacheTuple =>
    (peerMediaCaches[id] ??= initMediaIdentityCache())

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
    info[3]()
    const currentMap = peerActiveStreams[id]
    currentMap?.delete(stream)
    if (currentMap && !currentMap.size) {
      delete peerActiveStreams[id]
    }
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
      for (const t of rawTracks) {
        if (!prevRaw.has(t)) {
          replacedTracks.delete(t)
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
      entry[3]()
    }
    delete peerActiveStreams[id]
  }

  const toMediaCtx = (
    id: string,
    hasMeta: boolean,
    metadata: JsonValue | undefined
  ): PeerMediaContext => {
    const userId = getPeerUserId ? getPeerUserId(id) : id
    return hasMeta && metadata !== undefined
      ? {peerId: id, userId, metadata}
      : {peerId: id, userId}
  }

  const emitStream = (
    id: string,
    key: string,
    stream: MediaStream,
    hasMeta: boolean,
    metadata?: JsonValue
  ): void => {
    if (!isActive(id)) {
      return
    }

    getPeerMedia(id)[1](key, stream, streamIdOf(stream))

    const ctx = toMediaCtx(id, hasMeta, metadata)
    const streamMap = (peerActiveStreams[id] ??= new Map())
    const prevEntry = streamMap.get(stream)
    prevEntry?.[3]()

    const cleanups: Array<() => void> = []
    const curTracks = tracksOf(stream)
    const entry: ActiveStreamEntry = [
      hasMeta,
      metadata,
      Boolean(prevEntry?.[2] || curTracks.length > 0),
      () => {
        while (cleanups.length > 0) {
          cleanups.pop()!()
        }
      }
    ]

    const pruneIfInactive = (): void => {
      if (!isRemoteStreamActive(stream, entry[2])) {
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
    pruneIfInactive()

    const emittedMap = (peerEmittedStreams[id] ??= new WeakMap())
    const metaSig =
      hasMeta && metadata !== undefined ? `m:${toJson(metadata)}` : ''
    if (emittedMap.get(stream) !== metaSig) {
      emittedMap.set(stream, metaSig)
      emitStreamEvt(stream, ctx)
    }
  }

  return [
    async (stream, options, sendMeta) => {
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
            synced = new Map(
              effectiveTracks.map(track => [track, trackIdOf(track)])
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
                synced.set(nextTrack, trackIdOf(nextTrack))
              }
            }
          }

          const trackIds = effectiveTracks
            .map(track => synced.get(track))
            .filter((tid): tid is string => Boolean(tid))
          await sendMeta(
            {
              k: key,
              s: stream.id,
              ...(trackIds.length > 0 ? {t: trackIds} : {}),
              ...(metadata === undefined ? {} : {m: metadata})
            },
            id
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

    (stream, target) => {
      if (!target) {
        knownLocalStreams.delete(stream)
        localStreamMetas.delete(stream)
        localStreamRawTracks.delete(stream)
      }
      void iterate(target, (id, directPeer) => {
        const prevTracks = peerSyncedStreams[id]?.get(stream)
        peerSyncedStreams[id]?.delete(stream)
        if (!directPeer) {
          return
        }
        directPeer.removeStream(stream)
        if (prevTracks) {
          const rawSet = new Set(tracksOf(stream))
          for (const [track] of prevTracks) {
            if (!rawSet.has(track)) {
              directPeer.removeTrack(track, stream)
            }
          }
        }
      })
    },

    async (oldTrack, newTrack, target) => {
      replacedTracks.set(oldTrack, newTrack)
      replacedTracks.delete(newTrack)
      await all(
        iterate(target, async (id, directPeer) => {
          const mediaPeer = await getMediaPeer(id, directPeer)
          const peerStreams = peerSyncedStreams[id]
          if (peerStreams) {
            for (const stream of knownLocalStreams) {
              const synced = peerStreams.get(stream)
              if (synced?.has(oldTrack)) {
                const signaledId = synced.get(oldTrack) ?? trackIdOf(oldTrack)
                synced.delete(oldTrack)
                synced.set(newTrack, signaledId)
              }
            }
          }
          await mediaPeer.replaceTrack(oldTrack, newTrack)
        })
      )
    },

    (meta, id) => {
      if (!isActive(id)) {
        return
      }
      const parsed = toPendingMediaMeta(meta)
      if (!parsed) {
        return
      }

      const bufferedStreams = pendingRemoteStreams[id]
      const bufferedIdx = bufferedStreams?.length
        ? parsed[1]
          ? bufferedStreams.findIndex(s => s.id === parsed[1])
          : 0
        : -1
      const candidateStream =
        bufferedIdx >= 0
          ? bufferedStreams![bufferedIdx]
          : getPeerMedia(id)[2](parsed[0], parsed[1])
      const candidateTracks = tracksOf(candidateStream)

      if (
        candidateStream &&
        (bufferedIdx >= 0 || candidateTracks.length > 0) &&
        !waitingForTracks(parsed[2], candidateTracks)
      ) {
        unbufferRemoteStream(id, bufferedIdx)
        emitStream(id, parsed[0], candidateStream, parsed[3], parsed[4])
        return
      }

      const queue = (pendingStreamMetas[id] ??= [])
      if (queue.length >= maxQueuedDataFrames) {
        warn('too many pending stream metadata messages')
        onPeerError(id, mkErr('too many pending media metadata messages'))
        return
      }
      queue.push(parsed)
    },

    (id, stream) => {
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
        ? queue.findIndex(m => !m[1] || m[1] === streamId)
        : 0
      if (index < 0 || waitingForTracks(queue[index]![2], tracksOf(stream))) {
        bufferStream()
        return
      }

      const [next] = queue.splice(index, 1)
      if (next) {
        const list = pendingRemoteStreams[id]
        if (list) {
          unbufferRemoteStream(id, list.indexOf(stream))
        }
        emitStream(id, next[0], stream, next[3], next[4])
      }
    },

    id => {
      ;[
        pendingStreamMetas,
        pendingRemoteStreams,
        peerMediaCaches,
        peerSyncedStreams,
        peerEmittedStreams
      ].forEach(m => {
        delete m[id]
      })
      clearPeerActiveStreams(id)
    },

    () => {
      clearStreamEvt()
      keys(peerActiveStreams).forEach(clearPeerActiveStreams)
    },

    (handler, options) =>
      subStream(handler, options, () => {
        const items: [MediaStream, PeerMediaContext][] = []
        for (const [id, streamMap] of entries(peerActiveStreams)) {
          if (!isActive(id)) {
            clearPeerActiveStreams(id)
            continue
          }
          for (const [stream, info] of streamMap.entries()) {
            if (!isRemoteStreamActive(stream, info[2])) {
              removeActiveStream(id, stream, info)
              continue
            }
            items.push([stream, toMediaCtx(id, info[0], info[1])])
          }
        }
        return items
      })
  ]
}

export const createMediaManager = ({
  iterate,
  isActive,
  preparePeer,
  getPeerUserId,
  onPeerError
}: {
  onPeerError: (peerId: string, error: Error) => void
  iterate: (
    targets: TargetPeers,
    f: (id: string, directPeer?: PeerHandle) => Promise<void> | void
  ) => Promise<void>[]
  isActive: (id: string) => boolean
  preparePeer?: (id: string) => Promise<PeerHandle>
  getPeerUserId?: (peerId: string) => string
}) => {
  const [
    addStream,
    removeStream,
    replaceTrack,
    receiveStreamMeta,
    receiveRemoteStream,
    clearPeer,
    clearListeners,
    onPeerStream
  ] = initMediaManager(
    iterate,
    isActive,
    onPeerError,
    preparePeer,
    getPeerUserId
  )
  return {
    addStream,
    removeStream,
    replaceTrack,
    receiveStreamMeta,
    receiveRemoteStream,
    clearPeer,
    clearListeners,
    onPeerStream
  }
}
