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
  isObj,
  mkErr,
  peerDisconnectedErr,
  toJson,
  unreachable,
  warn
} from './utils'

export type InternalMediaMeta = {
  k: string
  m?: JsonValue
  s?: string
  t?: number
}

type ParsedMediaMeta = {
  readonly key: string
  readonly streamId: string | undefined
  readonly expectedTrackCount: number | undefined
  readonly hasMetadata: boolean
  readonly metadata: JsonValue | undefined
}

type RemoteStreamState =
  | {
      readonly phase: 'waiting'
      readonly cleanup: () => void
    }
  | {
      readonly phase: 'active'
      readonly key: string
      readonly hasMetadata: boolean
      readonly metadata: JsonValue | undefined
      readonly emittedSig: string
      readonly hadTracks: boolean
      readonly cleanup: () => void
    }
  | {
      readonly phase: 'inactive'
      readonly key: string
    }

const isStreamTracked = (
  entry: RemoteStreamState | undefined
): entry is Extract<RemoteStreamState, {phase: 'waiting' | 'active'}> =>
  entry?.phase === 'waiting' || entry?.phase === 'active'

type PeerRemoteMediaState = {
  readonly identityCache: MediaIdentityCache
  readonly metaQueue: ParsedMediaMeta[]
  readonly streams: Map<MediaStream, RemoteStreamState>
}

type LocalPeerStreamState =
  | {
      readonly phase: 'syncing-initial'
      readonly syncGen: number
    }
  | {
      readonly phase: 'synced'
      readonly syncGen: number
      readonly appliedTracks: Set<MediaStreamTrack>
    }

type PeerLocalMediaState = {
  readonly streams: Map<MediaStream, LocalPeerStreamState>
}

const toParsedMediaMeta = (value: unknown): ParsedMediaMeta | null => {
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
  currentTracks: readonly MediaStreamTrack[]
): boolean =>
  expectedCount !== undefined &&
  expectedCount > 0 &&
  currentTracks.length < expectedCount

const bindTargetEvent = (
  target: {
    addEventListener?: (event: string, listener: EventListener) => void
    removeEventListener?: (event: string, listener: EventListener) => void
  },
  event: string,
  listener: () => void,
  cleanups: Array<() => void>
): void => {
  if (
    typeof target.addEventListener === 'function' &&
    typeof target.removeEventListener === 'function'
  ) {
    target.addEventListener(event, listener)
    cleanups.push(() => {
      target.removeEventListener?.(event, listener)
    })
  }
}

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

const findWaitingStream = (
  peerState: PeerRemoteMediaState,
  streamId: string | undefined
): MediaStream | undefined => {
  for (const [stream, record] of peerState.streams) {
    if (record.phase === 'waiting' && (!streamId || stream.id === streamId)) {
      return stream
    }
  }
  return undefined
}

const countWaitingStreams = (peerState: PeerRemoteMediaState): number => {
  let count = 0
  for (const record of peerState.streams.values()) {
    if (record.phase === 'waiting') {
      count++
    }
  }
  return count
}

export const createMediaManager = ({
  iterate,
  isActive,
  preparePeer,
  getPeerUserId,
  onPeerError,
  onPeerMediaPinChange
}: MediaManagerDeps): MediaManager => {
  const peerRemoteMedia = new Map<string, PeerRemoteMediaState>()
  const peerLocalMedia = new Map<string, PeerLocalMediaState>()
  const [subStream, emitStreamEvt, clearStreamEvt] = createEventEmitter<
    [MediaStream, PeerMediaContext]
  >('peer stream handler')
  const getLocalStreamKey = makeStreamKeyGetter()
  const localStreamMetas = new WeakMap<MediaStream, JsonValue | undefined>()
  const localStreamRawTracks = new WeakMap<MediaStream, Set<MediaStreamTrack>>()
  const globalReplacedTracks = new WeakMap<MediaStreamTrack, MediaStreamTrack>()

  let nextLocalSyncGen = 0

  const ensurePeerRemoteMedia = (id: string): PeerRemoteMediaState => {
    let state = peerRemoteMedia.get(id)
    if (!state) {
      state = {
        identityCache: createMediaIdentityCache(),
        metaQueue: [],
        streams: new Map()
      }
      peerRemoteMedia.set(id, state)
    }
    return state
  }

  const ensurePeerLocalMedia = (id: string): PeerLocalMediaState => {
    let state = peerLocalMedia.get(id)
    if (!state) {
      state = {streams: new Map()}
      peerLocalMedia.set(id, state)
    }
    return state
  }

  const hasActiveRemoteMediaForPeer = (id: string): boolean => {
    const remote = peerRemoteMedia.get(id)
    if (!remote) {
      return false
    }
    for (const record of remote.streams.values()) {
      if (record.phase === 'active') {
        return true
      }
    }
    return false
  }

  const hasSyncedLocalMediaForPeer = (id: string): boolean =>
    Boolean(peerLocalMedia.get(id)?.streams.size)

  const updatePeerPin = (id: string): void => {
    onPeerMediaPinChange?.(
      id,
      hasActiveRemoteMediaForPeer(id) || hasSyncedLocalMediaForPeer(id)
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

  const resolveTrack = (track: MediaStreamTrack): MediaStreamTrack => {
    let current = track
    const seen = new Set<MediaStreamTrack>()
    while (!seen.has(current)) {
      const next = globalReplacedTracks.get(current)
      if (!next) {
        break
      }
      seen.add(current)
      current = next
    }
    return current
  }

  const resolveStreamTracks = (stream: MediaStream): MediaStreamTrack[] => {
    const rawTracks = tracksOf(stream)
    const prevRaw = localStreamRawTracks.get(stream)
    if (prevRaw) {
      for (const track of rawTracks) {
        if (!prevRaw.has(track)) {
          globalReplacedTracks.delete(track)
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

  const deactivateRemoteStream = (
    id: string,
    peerState: PeerRemoteMediaState,
    stream: MediaStream,
    entry: Extract<RemoteStreamState, {phase: 'active'}>
  ): void => {
    if (peerState.streams.get(stream) !== entry) {
      return
    }
    entry.cleanup()
    peerState.streams.set(stream, {phase: 'inactive', key: entry.key})
    updatePeerPin(id)
  }

  const deactivateAllPeerRemoteStreams = (
    peerState: PeerRemoteMediaState
  ): void => {
    for (const [stream, record] of Array.from(peerState.streams.entries())) {
      switch (record.phase) {
        case 'waiting':
          record.cleanup()
          peerState.streams.delete(stream)
          break
        case 'active':
          record.cleanup()
          peerState.streams.set(stream, {phase: 'inactive', key: record.key})
          break
        case 'inactive':
          break
        default:
          unreachable(record)
      }
    }
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

  const matchQueuedMetaForStream = (
    peerState: PeerRemoteMediaState,
    stream: MediaStream
  ): ParsedMediaMeta | null => {
    if (!peerState.metaQueue.length) {
      return null
    }
    const streamId = streamIdOf(stream)
    const index = streamId
      ? peerState.metaQueue.findIndex(
          meta => !meta.streamId || meta.streamId === streamId
        )
      : 0
    if (index < 0) {
      return null
    }
    const candidate = peerState.metaQueue[index]!
    if (waitingForTracks(candidate.expectedTrackCount, tracksOf(stream))) {
      return null
    }
    peerState.metaQueue.splice(index, 1)
    return candidate
  }

  const tryPromoteStreamFromQueuedMeta = (
    id: string,
    stream: MediaStream
  ): boolean => {
    if (!isActive(id)) {
      return false
    }
    const peerState = peerRemoteMedia.get(id)
    if (!peerState) {
      return false
    }
    const matched = matchQueuedMetaForStream(peerState, stream)
    if (!matched) {
      return false
    }
    activateRemoteStream(
      id,
      peerState,
      matched.key,
      stream,
      matched.hasMetadata,
      matched.metadata
    )
    return true
  }

  const ensureWaitingStream = (
    id: string,
    peerState: PeerRemoteMediaState,
    stream: MediaStream
  ): void => {
    const existing = peerState.streams.get(stream)
    if (isStreamTracked(existing)) {
      return
    }
    if (countWaitingStreams(peerState) >= maxQueuedDataFrames) {
      return
    }
    const cleanups: Array<() => void> = []
    bindTargetEvent(
      stream,
      'addtrack',
      () => {
        tryPromoteStreamFromQueuedMeta(id, stream)
      },
      cleanups
    )
    peerState.streams.set(stream, {
      phase: 'waiting',
      cleanup: () => {
        while (cleanups.length > 0) {
          cleanups.pop()!()
        }
      }
    })
  }

  const activateRemoteStream = (
    id: string,
    peerState: PeerRemoteMediaState,
    key: string,
    stream: MediaStream,
    hasMetadata: boolean,
    metadata?: JsonValue
  ): void => {
    if (!isActive(id)) {
      return
    }

    peerState.identityCache.rememberRemoteStream(
      key,
      stream,
      streamIdOf(stream)
    )

    const prev = peerState.streams.get(stream)
    if (isStreamTracked(prev)) {
      prev.cleanup()
    }

    const curTracks = tracksOf(stream)
    let hadTracks = Boolean(
      (prev?.phase === 'active' && prev.hadTracks) || curTracks.length > 0
    )

    if (!isRemoteStreamActive(stream, hadTracks)) {
      peerState.streams.set(stream, {phase: 'inactive', key})
      if (prev?.phase === 'active') {
        updatePeerPin(id)
      }
      return
    }

    const metaSig =
      hasMetadata && metadata !== undefined ? `m:${toJson(metadata)}` : ''
    const prevEmittedSig =
      prev?.phase === 'active' ? prev.emittedSig : undefined

    const cleanups: Array<() => void> = []
    const observedTracks = new Set<MediaStreamTrack>()
    const cleanup = (): void => {
      while (cleanups.length > 0) {
        cleanups.pop()!()
      }
    }

    let currentEntry: Extract<RemoteStreamState, {phase: 'active'}> = {
      phase: 'active',
      key,
      hasMetadata,
      metadata,
      emittedSig: metaSig,
      hadTracks,
      cleanup
    }

    const pruneIfInactive = (): void => {
      if (!isRemoteStreamActive(stream, hadTracks)) {
        deactivateRemoteStream(id, peerState, stream, currentEntry)
      }
    }

    const observeTrack = (track: MediaStreamTrack | undefined): void => {
      if (!track || observedTracks.has(track)) {
        return
      }
      observedTracks.add(track)
      if (!hadTracks) {
        hadTracks = true
        if (peerState.streams.get(stream) === currentEntry) {
          currentEntry = {...currentEntry, hadTracks: true}
          peerState.streams.set(stream, currentEntry)
        }
      }
      bindTargetEvent(track, 'ended', pruneIfInactive, cleanups)
    }

    const onDynamicTrackAdded = (): void => {
      if (peerState.streams.get(stream) !== currentEntry) {
        return
      }
      for (const track of tracksOf(stream)) {
        observeTrack(track)
      }
      if (!tryPromoteStreamFromQueuedMeta(id, stream)) {
        pruneIfInactive()
      }
    }

    bindTargetEvent(stream, 'removetrack', pruneIfInactive, cleanups)
    bindTargetEvent(stream, 'inactive', pruneIfInactive, cleanups)
    bindTargetEvent(stream, 'addtrack', onDynamicTrackAdded, cleanups)
    for (const track of curTracks) {
      observeTrack(track)
    }

    currentEntry = {...currentEntry, hadTracks}
    peerState.streams.set(stream, currentEntry)
    updatePeerPin(id)

    if (prevEmittedSig !== metaSig) {
      emitStreamEvt(stream, toMediaCtx(id, hasMetadata, metadata))
    }
  }

  return {
    addStream: async (stream, options, sendMeta) => {
      const key = getLocalStreamKey(stream)
      const metadata = Object.hasOwn(options, 'metadata')
        ? (localStreamMetas.set(stream, options.metadata), options.metadata)
        : localStreamMetas.get(stream)
      const initialEffectiveTracks = resolveStreamTracks(stream)

      await all(
        iterate(options.target, async (id, directPeer) => {
          const opGen = ++nextLocalSyncGen
          const peerLocal = ensurePeerLocalMedia(id)
          const prevEntry = peerLocal.streams.get(stream)

          peerLocal.streams.set(
            stream,
            prevEntry?.phase === 'synced'
              ? {
                  phase: 'synced',
                  syncGen: opGen,
                  appliedTracks: prevEntry.appliedTracks
                }
              : {phase: 'syncing-initial', syncGen: opGen}
          )
          updatePeerPin(id)

          const rollbackInitialIfCurrent = (): void => {
            const curLocal = peerLocalMedia.get(id)
            const cur = curLocal?.streams.get(stream)
            if (cur?.syncGen === opGen && cur.phase === 'syncing-initial') {
              curLocal!.streams.delete(stream)
              if (!curLocal!.streams.size) {
                peerLocalMedia.delete(id)
              }
              updatePeerPin(id)
            }
          }

          let mediaPeer: PeerHandle
          try {
            mediaPeer = await getMediaPeer(id, directPeer)
          } catch (err) {
            rollbackInitialIfCurrent()
            throw err
          }

          if (peerLocalMedia.get(id)?.streams.get(stream)?.syncGen !== opGen) {
            return
          }

          try {
            await sendMeta(
              {
                k: key,
                s: stream.id,
                ...(initialEffectiveTracks.length > 0
                  ? {t: initialEffectiveTracks.length}
                  : {}),
                ...(metadata === undefined ? {} : {m: metadata})
              },
              {target: id}
            )
          } catch (err) {
            rollbackInitialIfCurrent()
            throw err
          }

          const current = peerLocalMedia.get(id)?.streams.get(stream)
          if (!current || current.syncGen !== opGen) {
            return
          }

          const latestRawTracks = tracksOf(stream)
          const latestEffectiveTracks = latestRawTracks.map(resolveTrack)

          switch (current.phase) {
            case 'syncing-initial': {
              peerLocalMedia.get(id)?.streams.set(stream, {
                phase: 'synced',
                syncGen: opGen,
                appliedTracks: new Set(latestEffectiveTracks)
              })
              if (
                latestEffectiveTracks.length !== latestRawTracks.length ||
                latestEffectiveTracks.some(
                  (track, index) => track !== latestRawTracks[index]
                )
              ) {
                latestEffectiveTracks.forEach(track =>
                  mediaPeer.addTrack(track, stream)
                )
              } else {
                mediaPeer.addStream(stream)
              }
              return
            }
            case 'synced': {
              const nextSet = new Set(latestEffectiveTracks)
              for (const prevTrack of current.appliedTracks.difference(
                nextSet
              )) {
                mediaPeer.removeTrack(prevTrack, stream)
                current.appliedTracks.delete(prevTrack)
              }
              for (const nextTrack of nextSet.difference(
                current.appliedTracks
              )) {
                mediaPeer.addTrack(nextTrack, stream)
                current.appliedTracks.add(nextTrack)
              }
              return
            }
            default:
              unreachable(current)
          }
        })
      )
    },

    removeStream: (stream, target) => {
      if (!target) {
        localStreamMetas.delete(stream)
        localStreamRawTracks.delete(stream)
      }
      void iterate(target, (id, directPeer) => {
        const peerLocal = peerLocalMedia.get(id)
        const prevEntry = peerLocal?.streams.get(stream)
        if (peerLocal) {
          peerLocal.streams.delete(stream)
          if (!peerLocal.streams.size) {
            peerLocalMedia.delete(id)
          }
        }
        updatePeerPin(id)
        if (!directPeer || prevEntry?.phase === 'syncing-initial') {
          return
        }
        directPeer.removeStream(stream)
        if (prevEntry?.phase === 'synced') {
          for (const track of prevEntry.appliedTracks.difference(
            new Set(tracksOf(stream))
          )) {
            directPeer.removeTrack(track, stream)
          }
        }
      })
    },

    replaceTrack: async (oldTrack, newTrack, target) => {
      globalReplacedTracks.set(oldTrack, newTrack)
      globalReplacedTracks.delete(newTrack)
      await all(
        iterate(target, async (id, directPeer) => {
          const peerLocal = peerLocalMedia.get(id)
          let hasMatchingStream = false
          if (peerLocal) {
            for (const [stream, streamEntry] of peerLocal.streams.entries()) {
              if (
                streamEntry.phase === 'synced' &&
                streamEntry.appliedTracks.has(oldTrack)
              ) {
                streamEntry.appliedTracks.delete(oldTrack)
                streamEntry.appliedTracks.add(newTrack)
                hasMatchingStream = true
              } else if (
                streamEntry.phase === 'syncing-initial' &&
                tracksOf(stream).some(
                  raw => raw === oldTrack || resolveTrack(raw) === newTrack
                )
              ) {
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
      const parsed = toParsedMediaMeta(meta)
      if (!parsed) {
        return
      }

      const peerState = ensurePeerRemoteMedia(id)
      const waitingStream = findWaitingStream(peerState, parsed.streamId)
      const candidateStream =
        waitingStream ??
        peerState.identityCache.getRemoteStream(parsed.key, parsed.streamId)
      const candidateTracks = tracksOf(candidateStream)

      if (
        candidateStream &&
        (waitingStream !== undefined || candidateTracks.length > 0) &&
        !waitingForTracks(parsed.expectedTrackCount, candidateTracks)
      ) {
        const staleMetaIdx = peerState.metaQueue.findIndex(
          item => item.key === parsed.key
        )
        if (staleMetaIdx >= 0) {
          peerState.metaQueue.splice(staleMetaIdx, 1)
        }
        activateRemoteStream(
          id,
          peerState,
          parsed.key,
          candidateStream,
          parsed.hasMetadata,
          parsed.metadata
        )
        return
      }

      if (
        candidateStream &&
        waitingForTracks(parsed.expectedTrackCount, candidateTracks)
      ) {
        ensureWaitingStream(id, peerState, candidateStream)
      }

      const existingIdx = peerState.metaQueue.findIndex(
        item => item.key === parsed.key
      )
      if (existingIdx >= 0) {
        peerState.metaQueue[existingIdx] = parsed
        return
      }
      if (peerState.metaQueue.length >= maxQueuedDataFrames) {
        warn('too many pending stream metadata messages')
        onPeerError(id, mkErr('too many pending media metadata messages'))
        return
      }
      peerState.metaQueue.push(parsed)
    },

    receiveRemoteStream: (id, stream) => {
      if (!isActive(id)) {
        return
      }
      const peerState = ensurePeerRemoteMedia(id)
      const matched = matchQueuedMetaForStream(peerState, stream)
      if (matched) {
        activateRemoteStream(
          id,
          peerState,
          matched.key,
          stream,
          matched.hasMetadata,
          matched.metadata
        )
        return
      }
      ensureWaitingStream(id, peerState, stream)
    },

    clearPeer: id => {
      const remote = peerRemoteMedia.get(id)
      if (remote) {
        deactivateAllPeerRemoteStreams(remote)
        peerRemoteMedia.delete(id)
      }
      peerLocalMedia.delete(id)
      onPeerMediaPinChange?.(id, false)
    },

    clearListeners: () => {
      clearStreamEvt()
      for (const [id, peerState] of peerRemoteMedia) {
        deactivateAllPeerRemoteStreams(peerState)
        updatePeerPin(id)
      }
    },

    onPeerStream: (handler, options) =>
      subStream(handler, options, () => {
        const items: [MediaStream, PeerMediaContext][] = []
        for (const [id, peerState] of peerRemoteMedia) {
          if (!isActive(id)) {
            deactivateAllPeerRemoteStreams(peerState)
            updatePeerPin(id)
            continue
          }
          for (const [stream, record] of Array.from(
            peerState.streams.entries()
          )) {
            if (record.phase !== 'active') {
              continue
            }
            if (!isRemoteStreamActive(stream, record.hadTracks)) {
              deactivateRemoteStream(id, peerState, stream, record)
              continue
            }
            items.push([
              stream,
              toMediaCtx(id, record.hasMetadata, record.metadata)
            ])
          }
        }
        return items
      })
  }
}
