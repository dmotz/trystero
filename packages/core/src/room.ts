import {
  all,
  alloc,
  decodeBytes,
  encodeBytes,
  entries,
  fromEntries,
  fromJson,
  genId,
  isBrowser,
  keys,
  libName,
  mkErr,
  noOp,
  resetTimer,
  selfId,
  toError,
  toErrorMessage,
  toJson
} from './utils'
import type {
  ActionProgressHandler,
  AddMediaOptions,
  DataPayload,
  HandshakePayload,
  HandshakeReceiver,
  HandshakeSender,
  JsonValue,
  MessageAction,
  MessageActionConfig,
  PeerHandle,
  PeerHandshake,
  PeerResult,
  RequestAction,
  RequestActionConfig,
  RequestManyOptions,
  RequestOptions,
  Room,
  SharedMediaPeer,
  TargetPeers,
  SendOptions
} from './types'

const TypedArray = Object.getPrototypeOf(Uint8Array)
const typeByteLimit = 32
const nonceByteLimit = 2
const typeIndex = 0
const nonceIndex = typeIndex + typeByteLimit
const tagIndex = nonceIndex + nonceByteLimit
const progressIndex = tagIndex + 1
const payloadIndex = progressIndex + 1
const chunkSize = 16 * 2 ** 10 - payloadIndex
const oneByteMax = 0xff
const twoByteMax = 0xffff
const buffLowEvent = 'bufferedamountlow'
const channelCloseEvent = 'close'
const channelErrorEvent = 'error'
const unloadEvent = 'beforeunload'
const defaultHandshakeTimeoutMs = 10_000
const backpressureWaitTimeoutMs = 10_000
const requestHandlerBufferMs = 500
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

type ActionOptions = {
  sendToPending: boolean
  receiveWhilePending: boolean
}

type InternalActionSender<T extends DataPayload = DataPayload> = (
  data: T,
  targetPeers?: TargetPeers,
  metadata?: JsonValue,
  progress?: (percent: number, peerId: string, metadata?: JsonValue) => void,
  signal?: AbortSignal
) => Promise<void[]>

type InternalActionReceiver<T extends DataPayload = DataPayload> = (
  receiver: (data: T, peerId: string, metadata?: JsonValue) => void
) => void

type InternalActionProgress = (
  progressHandler: (
    percent: number,
    peerId: string,
    metadata?: JsonValue
  ) => void
) => void

type PublicActionKind = 'message' | 'request'

type PublicActionState = {
  kind: PublicActionKind
  action: MessageAction | RequestAction
  pendingMessages: PendingActionPayload[]
  pendingRequests: PendingIncomingRequest[]
  onReceiveProgress: ActionProgressHandler | null
}

type ActionState = {
  onComplete: (
    payload: DataPayload,
    peerId: string,
    metadata?: JsonValue
  ) => void
  onProgress: (percent: number, peerId: string, metadata?: JsonValue) => void
  setOnComplete: (
    f: (payload: DataPayload, peerId: string, metadata?: JsonValue) => void
  ) => void
  setOnProgress: (
    f: (percent: number, peerId: string, metadata?: JsonValue) => void
  ) => void
  send: InternalActionSender
  options: ActionOptions
  publicState?: PublicActionState
}

type PendingTransmission = {
  chunks: Uint8Array[]
  meta?: JsonValue
}

type PendingActionPayload = {
  payload: DataPayload
  peerId: string
  metadata?: JsonValue
}

type PendingIncomingRequest = PendingActionPayload & {
  requestId: string
  timer: ReturnType<typeof setTimeout>
  controller: AbortController
}

type PendingRequestWaiter = {
  peerId: string
  resolve: (payload: DataPayload) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | null
  signal?: AbortSignal
  abortHandler?: () => void
}

type RequestMetadata = {
  r: string
  m?: JsonValue
}

type ResponseMetadata = {
  r: string
  e?: string
}

type ActionErrorKind = 'timeout' | 'disconnected' | 'aborted' | 'rejected'

type ActionError = Error & {
  kind?: ActionErrorKind
}

type PendingPeerState = {
  peer: PeerHandle
  isActive: boolean
  didLocalHandshakePass: boolean
  didReceiveRemoteReady: boolean
  handshakeTimer: ReturnType<typeof setTimeout> | null
  pendingHandshakePayloads: HandshakePayload[]
  handshakeWaiters: Array<{
    resolve: (payload: HandshakePayload) => void
    reject: (error: Error) => void
  }>
}

type RoomOptions = {
  onPeerHandshake?: PeerHandshake
  onHandshakeError?: (peerId: string, error: string) => void
  handshakeTimeoutMs?: number
}

type InternalMediaMeta = {
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

type PendingPongWaiter = {
  resolve: () => void
  reject: (error: Error) => void
}

const toByteArray = (value: ArrayBuffer | ArrayBufferView): Uint8Array =>
  value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)

const toHandshakeErrorMessage = (error: Error): string => {
  const message = toErrorMessage(error, 'unknown error')

  return message.startsWith('handshake ')
    ? message
    : `handshake failed: ${message}`
}

const makeActionError = (
  kind: ActionErrorKind,
  message: string
): ActionError => {
  const error = mkErr(message) as ActionError
  error.kind = kind
  error.name = kind === 'aborted' ? 'AbortError' : error.name
  return error
}

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw makeActionError('aborted', 'operation aborted')
  }
}

const getRequestMetadata = (metadata?: JsonValue): RequestMetadata | null => {
  if (
    metadata &&
    typeof metadata === 'object' &&
    !Array.isArray(metadata) &&
    typeof (metadata as {r?: unknown}).r === 'string'
  ) {
    return {
      r: (metadata as {r: string}).r,
      ...(Object.hasOwn(metadata as object, 'm')
        ? {m: (metadata as {m?: JsonValue}).m}
        : {})
    }
  }

  return null
}

const getResponseMetadata = (metadata?: JsonValue): ResponseMetadata | null => {
  if (
    metadata &&
    typeof metadata === 'object' &&
    !Array.isArray(metadata) &&
    typeof (metadata as {r?: unknown}).r === 'string'
  ) {
    return {
      r: (metadata as {r: string}).r,
      ...(typeof (metadata as {e?: unknown}).e === 'string'
        ? {e: (metadata as {e: string}).e}
        : {})
    }
  }

  return null
}

const withMetadata = <T extends {peerId: string}>(
  context: T,
  metadata?: JsonValue
): T & {metadata?: JsonValue} =>
  metadata === undefined ? context : {...context, metadata}

const waitForBufferedAmountLow = (
  channel: RTCDataChannel,
  timeoutMs = backpressureWaitTimeoutMs
): Promise<boolean> => {
  if (
    channel.readyState !== 'open' ||
    channel.bufferedAmount <= channel.bufferedAmountLowThreshold
  ) {
    return Promise.resolve(channel.readyState === 'open')
  }

  return new Promise<boolean>(res => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null

    const finish = (didDrain: boolean): void => {
      if (settled) {
        return
      }

      settled = true
      channel.removeEventListener(buffLowEvent, onBufferLow)
      channel.removeEventListener(channelCloseEvent, onCloseOrError)
      channel.removeEventListener(channelErrorEvent, onCloseOrError)

      resetTimer(timeout)
      res(didDrain)
    }

    const onBufferLow = (): void => finish(true)
    const onCloseOrError = (): void => finish(false)

    channel.addEventListener(buffLowEvent, onBufferLow)
    channel.addEventListener(channelCloseEvent, onCloseOrError)
    channel.addEventListener(channelErrorEvent, onCloseOrError)

    timeout = setTimeout(() => finish(false), timeoutMs)

    if (channel.readyState !== 'open') {
      finish(false)
      return
    }

    if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) {
      finish(true)
    }
  })
}

export default (
  onPeer: (f: (peer: PeerHandle, id: string) => void) => void,
  onPeerLeave: (id: string) => void,
  onSelfLeave: () => void,
  {
    onPeerHandshake,
    onHandshakeError,
    handshakeTimeoutMs = defaultHandshakeTimeoutMs
  }: RoomOptions = {}
): Room => {
  const peerMap: Record<string, PeerHandle> = {}
  const activePeerMap: Record<string, PeerHandle> = {}
  const peerStates: Record<string, PendingPeerState> = {}
  const actions: Record<string, ActionState> = {}
  const actionsCache: Record<
    string,
    [InternalActionSender, InternalActionReceiver, InternalActionProgress]
  > = {}
  const pendingTransmissions: Record<
    string,
    Record<string, Record<number, PendingTransmission>>
  > = {}
  const pendingActionPayloads: Record<string, PendingActionPayload[]> = {}
  const pendingRequestWaiters: Record<string, PendingRequestWaiter> = {}
  const pendingPongs: Record<string, PendingPongWaiter[] | undefined> = {}
  const pendingStreamMetas: Record<string, PendingMediaMeta[]> = {}
  const pendingTrackMetas: Record<string, PendingMediaMeta[]> = {}
  const localStreamKeys = new WeakMap<MediaStream, string>()
  const localTrackKeys = new WeakMap<MediaStreamTrack, string>()
  const listeners = {
    onPeerJoin: null as ((peerId: string) => void) | null,
    onPeerLeave: null as ((peerId: string) => void) | null,
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
  let unregisterBeforeUnloadCleanup: () => void = noOp

  const iterate = (
    targets: TargetPeers,
    f: (id: string, peer: PeerHandle) => Promise<void> | void,
    {includePending = false}: {includePending?: boolean} = {}
  ): Promise<void>[] =>
    (targets
      ? Array.isArray(targets)
        ? targets
        : [targets]
      : keys(includePending ? peerMap : activePeerMap)
    ).flatMap(id => {
      const peer = includePending ? peerMap[id] : activePeerMap[id]

      if (!peer) {
        console.warn(`${libName}: no peer with id ${id} found`)
        return []
      }

      return [Promise.resolve(f(id, peer))]
    })

  const applyMediaOp = (
    targets: TargetPeers,
    key: string,
    metadata: JsonValue | undefined,
    sendMeta: InternalActionSender<InternalMediaMeta>,
    op: (peer: PeerHandle) => void,
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

  const getStreamKey = makeKeyGetter(localStreamKeys)
  const getTrackKey = makeKeyGetter(localTrackKeys)

  const getSharedMediaPeer = (id: string): SharedMediaPeer | null =>
    (peerMap[id] as SharedMediaPeer | undefined) ?? null

  const emitStream = (
    id: string,
    key: string,
    stream: MediaStream,
    metadata?: JsonValue
  ): void => {
    if (!activePeerMap[id]) {
      return
    }

    getSharedMediaPeer(id)?.__trysteroSetRemoteStreamByKey?.(key, stream)

    if (typeof stream.id === 'string') {
      getSharedMediaPeer(id)?.__trysteroSetRemoteStreamById?.(stream.id, stream)
    }

    listeners.onPeerStream?.(stream, id, metadata)
  }

  const emitTrack = (
    id: string,
    key: string,
    track: MediaStreamTrack,
    stream: MediaStream,
    metadata?: JsonValue
  ): void => {
    if (!activePeerMap[id]) {
      return
    }

    getSharedMediaPeer(id)?.__trysteroSetRemoteTrackByKey?.(key, track, stream)

    if (typeof stream.id === 'string') {
      getSharedMediaPeer(id)?.__trysteroSetRemoteStreamById?.(stream.id, stream)
    }

    if (typeof track.id === 'string') {
      getSharedMediaPeer(id)?.__trysteroSetRemoteTrackById?.(
        track.id,
        track,
        stream
      )
    }

    listeners.onPeerTrack?.(track, stream, id, metadata)
  }

  const clearPendingRequestWaiter = (requestId: string): void => {
    const waiter = pendingRequestWaiters[requestId]

    if (!waiter) {
      return
    }

    resetTimer(waiter.timer)

    if (waiter.signal && waiter.abortHandler) {
      waiter.signal.removeEventListener('abort', waiter.abortHandler)
    }

    delete pendingRequestWaiters[requestId]
  }

  const rejectPendingRequestsForPeer = (id: string, error: Error): void => {
    entries(pendingRequestWaiters).forEach(([requestId, waiter]) => {
      if (waiter.peerId !== id) {
        return
      }

      clearPendingRequestWaiter(requestId)
      waiter.reject(error)
    })
  }

  const clearPeerState = (
    id: string,
    reason: Error = mkErr('peer disconnected')
  ): void => {
    const state = peerStates[id]
    const err = toError(reason, 'peer disconnected')

    if (state) {
      resetTimer(state.handshakeTimer)
      state.pendingHandshakePayloads.length = 0
      state.handshakeWaiters.splice(0).forEach(waiter => waiter.reject(err))
      delete peerStates[id]
    }

    delete peerMap[id]
    delete activePeerMap[id]
    delete pendingTransmissions[id]
    pendingPongs[id]?.splice(0).forEach(waiter => waiter.reject(err))
    delete pendingPongs[id]
    rejectPendingRequestsForPeer(
      id,
      makeActionError('disconnected', toErrorMessage(err, 'peer disconnected'))
    )
    delete pendingStreamMetas[id]
    delete pendingTrackMetas[id]
  }

  const exitPeer = (id: string, peer?: PeerHandle, reason?: Error): void => {
    const current = peerMap[id]

    if (!current) {
      return
    }

    if (peer && current !== peer) {
      return
    }

    const wasActive = Boolean(activePeerMap[id])

    clearPeerState(id, reason)
    current.destroy()

    if (wasActive) {
      listeners.onPeerLeave?.(id)
    }

    onPeerLeave(id)
  }

  const makeActionInternal = <T extends DataPayload = DataPayload>(
    type: string,
    options: Partial<ActionOptions> = {}
  ): [
    InternalActionSender<T>,
    InternalActionReceiver<T>,
    InternalActionProgress
  ] => {
    const cached = actionsCache[type]

    if (actions[type] && cached) {
      const cachedOptions = actions[type].options

      if (
        cachedOptions.sendToPending !== Boolean(options.sendToPending) ||
        cachedOptions.receiveWhilePending !==
          Boolean(options.receiveWhilePending)
      ) {
        throw mkErr(`action type "${type}" cannot be redefined`)
      }

      return cached as unknown as [
        InternalActionSender<T>,
        InternalActionReceiver<T>,
        InternalActionProgress
      ]
    }

    if (!type) {
      throw mkErr('action type argument is required')
    }

    const typeBytes = encodeBytes(type)

    if (typeBytes.byteLength > typeByteLimit) {
      throw mkErr(
        `action type string "${type}" (${typeBytes.byteLength}b) exceeds ` +
          `byte limit (${typeByteLimit}). Hint: choose a shorter name.`
      )
    }

    const normalizedOptions = {
      sendToPending: Boolean(options.sendToPending),
      receiveWhilePending: Boolean(options.receiveWhilePending)
    }
    const typeBytesPadded = new Uint8Array(typeByteLimit)
    typeBytesPadded.set(typeBytes)

    let nonce = 0

    actions[type] = {
      onComplete: noOp as (
        payload: DataPayload,
        peerId: string,
        metadata?: JsonValue
      ) => void,
      onProgress: noOp as (
        percent: number,
        peerId: string,
        metadata?: JsonValue
      ) => void,

      setOnComplete: f => {
        actions[type]!.onComplete = f

        const pending = pendingActionPayloads[type]

        if (pending?.length) {
          delete pendingActionPayloads[type]
          pending.forEach(({payload, peerId, metadata}) =>
            f(payload, peerId, metadata)
          )
        }
      },

      setOnProgress: f => {
        actions[type]!.onProgress = f
      },

      send: async (data, targets, meta, onProgress, signal) => {
        throwIfAborted(signal)

        const dataType = typeof data

        if (dataType === 'undefined') {
          throw mkErr('action data cannot be undefined')
        }

        const isJson = dataType !== 'string'
        const isBlob = data instanceof Blob
        const isBinary =
          isBlob || data instanceof ArrayBuffer || data instanceof TypedArray
        const hasMeta = meta !== undefined

        const buffer = isBinary
          ? toByteArray(
              isBlob
                ? await data.arrayBuffer()
                : (data as ArrayBuffer | ArrayBufferView)
            )
          : encodeBytes(isJson ? toJson(data) : (data as string))

        const metaEncoded = hasMeta ? encodeBytes(toJson(meta)) : null

        const chunkTotal =
          Math.ceil(buffer.byteLength / chunkSize) + (hasMeta ? 1 : 0) || 1

        const chunks = alloc(chunkTotal, (_, i) => {
          const isLast = i === chunkTotal - 1
          const isMeta = Boolean(hasMeta && i === 0)
          const chunk = new Uint8Array(
            payloadIndex +
              (isMeta
                ? (metaEncoded?.byteLength ?? 0)
                : isLast
                  ? buffer.byteLength -
                    chunkSize * (chunkTotal - (hasMeta ? 2 : 1))
                  : chunkSize)
          )

          chunk.set(typeBytesPadded)
          chunk.set([nonce >> 8, nonce & oneByteMax], nonceIndex)
          chunk.set(
            [
              Number(isLast) |
                (Number(isMeta) << 1) |
                (Number(isBinary) << 2) |
                (Number(isJson) << 3)
            ],
            tagIndex
          )
          chunk.set(
            [Math.round(((i + 1) / chunkTotal) * oneByteMax)],
            progressIndex
          )
          chunk.set(
            hasMeta
              ? isMeta
                ? (metaEncoded ?? new Uint8Array())
                : buffer.subarray((i - 1) * chunkSize, i * chunkSize)
              : buffer.subarray(i * chunkSize, (i + 1) * chunkSize),
            payloadIndex
          )

          return chunk
        })

        nonce = (nonce + 1) & twoByteMax

        await all(
          iterate(
            targets,
            async (id, peer) => {
              const {channel} = peer
              let chunkN = 0

              while (chunkN < chunkTotal) {
                throwIfAborted(signal)

                const chunk = chunks[chunkN]

                if (!chunk) {
                  break
                }

                if (
                  channel &&
                  channel.bufferedAmount > channel.bufferedAmountLowThreshold
                ) {
                  const didDrain = await waitForBufferedAmountLow(channel)

                  throwIfAborted(signal)

                  if (!didDrain) {
                    break
                  }
                }

                const currentPeer = normalizedOptions.sendToPending
                  ? peerMap[id]
                  : activePeerMap[id]

                if (!currentPeer || currentPeer !== peer) {
                  break
                }

                peer.sendData(chunk)
                chunkN++
                const progressByte = chunk[progressIndex] ?? oneByteMax
                onProgress?.(progressByte / oneByteMax, id, meta)
              }
            },
            {includePending: normalizedOptions.sendToPending}
          )
        )

        return []
      },

      options: normalizedOptions
    }

    return (actionsCache[type] = [
      actions[type].send as InternalActionSender,
      actions[type].setOnComplete as InternalActionReceiver,
      actions[type].setOnProgress as InternalActionProgress
    ]) as unknown as [
      InternalActionSender<T>,
      InternalActionReceiver<T>,
      InternalActionProgress
    ]
  }

  const handleData = (id: string, data: ArrayBuffer): void => {
    const state = peerStates[id]

    if (!state) {
      return
    }

    const buffer = new Uint8Array(data)
    const type = decodeBytes(buffer.subarray(typeIndex, nonceIndex)).replaceAll(
      '\x00',
      ''
    )
    const action = actions[type]

    if (!state.isActive && !action?.options.receiveWhilePending) {
      return
    }

    const nonce =
      ((buffer[nonceIndex] ?? 0) << 8) | (buffer[nonceIndex + 1] ?? 0)
    const tag = buffer[tagIndex] ?? 0
    const progress = buffer[progressIndex] ?? 0
    const payload = buffer.subarray(payloadIndex)
    const isLast = Boolean(tag & 1)
    const isMeta = Boolean(tag & (1 << 1))
    const isBinary = Boolean(tag & (1 << 2))
    const isJson = Boolean(tag & (1 << 3))

    pendingTransmissions[id] ??= {}
    pendingTransmissions[id][type] ??= {}

    const target = (pendingTransmissions[id][type][nonce] ??= {chunks: []})

    if (isMeta) {
      target.meta = fromJson<JsonValue>(decodeBytes(payload))
    } else {
      target.chunks.push(payload)
    }

    action?.onProgress(progress / oneByteMax, id, target.meta)

    if (!isLast) {
      return
    }

    const full = new Uint8Array(
      target.chunks.reduce((a: number, c: Uint8Array) => a + c.byteLength, 0)
    )

    target.chunks.reduce((a: number, c: Uint8Array) => {
      full.set(c, a)
      return a + c.byteLength
    }, 0)

    delete pendingTransmissions[id][type][nonce]

    if (isBinary) {
      if (action) {
        action.onComplete(full, id, target.meta)
      } else {
        ;(pendingActionPayloads[type] ??= []).push({
          payload: full,
          peerId: id,
          ...(target.meta === undefined ? {} : {metadata: target.meta})
        })
      }
    } else {
      const text = decodeBytes(full)
      const decoded = isJson ? fromJson<JsonValue>(text) : text

      if (action) {
        action.onComplete(decoded, id, target.meta)
      } else {
        ;(pendingActionPayloads[type] ??= []).push({
          payload: decoded,
          peerId: id,
          ...(target.meta === undefined ? {} : {metadata: target.meta})
        })
      }
    }
  }

  const leave = async (): Promise<void> => {
    await sendLeave('')
    await new Promise<void>(res => setTimeout(res, 99))

    entries(peerMap).forEach(([id, peer]) => {
      peer.destroy()
      clearPeerState(id, mkErr('room left'))
    })

    unregisterBeforeUnloadCleanup()
    onSelfLeave()
  }

  const [sendPing, getPing] = makeActionInternal<string>(internalNs('ping'))
  const [sendPong, getPong] = makeActionInternal<string>(internalNs('pong'))
  const [sendSignal, getSignal] = makeActionInternal(internalNs('signal'))
  const [sendStreamMeta, getStreamMeta] = makeActionInternal<InternalMediaMeta>(
    internalNs('stream')
  )
  const [sendTrackMeta, getTrackMeta] = makeActionInternal<InternalMediaMeta>(
    internalNs('track')
  )
  const [sendLeave, getLeave] = makeActionInternal<string>(
    internalNs('leave'),
    {
      sendToPending: true,
      receiveWhilePending: true
    }
  )
  const [sendHandshakeData, getHandshakeData] = makeActionInternal<DataPayload>(
    internalNs('hsdata'),
    {sendToPending: true, receiveWhilePending: true}
  )
  const [sendHandshakeReady, getHandshakeReady] = makeActionInternal<string>(
    internalNs('hsready'),
    {sendToPending: true, receiveWhilePending: true}
  )
  const [sendResponse, getResponse] = makeActionInternal<DataPayload>(
    internalNs('response')
  )

  const maybeActivatePeer = (id: string, peer?: PeerHandle): void => {
    const state = peerStates[id]

    if (!state || (peer && state.peer !== peer) || state.isActive) {
      return
    }

    if (!state.didLocalHandshakePass || !state.didReceiveRemoteReady) {
      return
    }

    state.isActive = true
    activePeerMap[id] = state.peer
    state.handshakeTimer = resetTimer(state.handshakeTimer)
    listeners.onPeerJoin?.(id)
  }

  const failPeerHandshake = (
    id: string,
    peer: PeerHandle,
    reason: Error
  ): void => {
    const state = peerStates[id]

    if (!state || state.peer !== peer) {
      return
    }

    const error = toHandshakeErrorMessage(reason)

    onHandshakeError?.(id, error)
    exitPeer(id, peer, mkErr(error))
  }

  const markLocalHandshakePassed = (id: string, peer: PeerHandle): void => {
    const state = peerStates[id]

    if (!state || state.peer !== peer || state.isActive) {
      return
    }

    state.didLocalHandshakePass = true

    void sendHandshakeReady('', id).catch(err =>
      failPeerHandshake(
        id,
        peer,
        mkErr(
          `failed sending handshake readiness: ${toErrorMessage(
            err,
            'unknown send failure'
          )}`
        )
      )
    )
    maybeActivatePeer(id, peer)
  }

  const startPeerHandshake = (id: string, peer: PeerHandle): void => {
    const state = peerStates[id]

    if (!state || state.peer !== peer) {
      return
    }

    state.handshakeTimer = setTimeout(
      () =>
        failPeerHandshake(
          id,
          peer,
          mkErr(`handshake timed out after ${handshakeTimeoutMs}ms`)
        ),
      handshakeTimeoutMs
    )

    const sendHandshake: HandshakeSender = async (data, metadata) => {
      await sendHandshakeData(data, id, metadata)
    }

    const receiveHandshake: HandshakeReceiver = () =>
      new Promise<HandshakePayload>((resolve, reject) => {
        const current = peerStates[id]

        if (!current || current.peer !== peer) {
          reject(mkErr('peer disconnected during handshake'))
          return
        }

        const payload = current.pendingHandshakePayloads.shift()

        if (payload) {
          resolve(payload)
          return
        }

        current.handshakeWaiters.push({
          resolve,
          reject: error => reject(error)
        })
      })

    const isInitiator = selfId < id

    void Promise.resolve(
      onPeerHandshake?.(id, sendHandshake, receiveHandshake, isInitiator)
    )
      .then(() => markLocalHandshakePassed(id, peer))
      .catch(err =>
        failPeerHandshake(id, peer, toError(err, 'handshake failed'))
      )
  }

  const toPendingMediaMeta = (value: DataPayload): PendingMediaMeta | null => {
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

  getPing((_, id) => sendPong('', id))

  getPong((_, id) => {
    const queue = pendingPongs[id]
    const waiter = queue?.shift()

    waiter?.resolve()

    if (queue && !queue.length) {
      delete pendingPongs[id]
    }
  })

  getSignal((sdp, id) => {
    if (!activePeerMap[id]) {
      return
    }

    void peerMap[id]?.signal(sdp as never)
  })

  getStreamMeta((meta, id) => {
    if (!activePeerMap[id]) {
      return
    }

    const parsed = toPendingMediaMeta(meta)

    if (!parsed) {
      return
    }

    const sharedPeer = getSharedMediaPeer(id)
    const cached =
      sharedPeer?.__trysteroGetRemoteStreamByKey?.(parsed.key) ??
      (parsed.streamId
        ? sharedPeer?.__trysteroGetRemoteStreamById?.(parsed.streamId)
        : undefined)

    if (cached) {
      emitStream(id, parsed.key, cached, parsed.metadata)
      return
    }

    ;(pendingStreamMetas[id] ??= []).push(parsed)
  })

  getTrackMeta((meta, id) => {
    if (!activePeerMap[id]) {
      return
    }

    const parsed = toPendingMediaMeta(meta)

    if (!parsed) {
      return
    }

    const sharedPeer = getSharedMediaPeer(id)
    const cached =
      sharedPeer?.__trysteroGetRemoteTrackByKey?.(parsed.key) ??
      (parsed.trackId
        ? sharedPeer?.__trysteroGetRemoteTrackById?.(parsed.trackId)
        : undefined)

    if (cached) {
      emitTrack(id, parsed.key, cached.track, cached.stream, parsed.metadata)
      return
    }

    ;(pendingTrackMetas[id] ??= []).push(parsed)
  })

  getLeave((_, id) => exitPeer(id, undefined, mkErr('peer left room')))

  getHandshakeData((data, id, metadata) => {
    const state = peerStates[id]

    if (!state || state.isActive) {
      return
    }

    const payload =
      metadata === undefined ? {data} : ({data, metadata} as HandshakePayload)
    const pending = state.handshakeWaiters.shift()

    if (pending) {
      pending.resolve(payload)
      return
    }

    state.pendingHandshakePayloads.push(payload)
  })

  getHandshakeReady((_, id) => {
    const state = peerStates[id]

    if (!state || state.isActive) {
      return
    }

    state.didReceiveRemoteReady = true
    maybeActivatePeer(id)
  })

  getResponse((payload, id, metadata) => {
    const parsed = getResponseMetadata(metadata)

    if (!parsed) {
      return
    }

    const waiter = pendingRequestWaiters[parsed.r]

    if (!waiter || waiter.peerId !== id) {
      return
    }

    clearPendingRequestWaiter(parsed.r)

    if (parsed.e !== undefined) {
      waiter.reject(makeActionError('rejected', parsed.e))
      return
    }

    waiter.resolve(payload)
  })

  const makeActionImpl = <
    T extends DataPayload = DataPayload,
    R extends DataPayload = DataPayload
  >(
    type: string,
    config?: MessageActionConfig<T> | RequestActionConfig<T, R>
  ): MessageAction<T> | RequestAction<T, R> => {
    if (config && 'onRequest' in config && config.kind !== 'request') {
      throw mkErr('request actions must use kind: "request"')
    }

    const kind = config?.kind ?? 'message'
    const [sendRaw, receiveRaw, progressRaw] = makeActionInternal<T>(type)
    const existingState = actions[type]?.publicState

    if (existingState) {
      if (existingState.kind !== kind) {
        throw mkErr(`action type "${type}" cannot be redefined`)
      }

      return existingState.action as MessageAction<T> | RequestAction<T, R>
    }

    const state: PublicActionState = {
      kind,
      action: null as unknown as MessageAction | RequestAction,
      pendingMessages: [],
      pendingRequests: [],
      onReceiveProgress: config?.onReceiveProgress ?? null
    }

    const toProgressHandler = (
      handler?: ActionProgressHandler,
      metadata?: JsonValue
    ) =>
      handler
        ? (progress: number, peerId: string) =>
            handler(progress, withMetadata({peerId}, metadata))
        : undefined

    const setReceiveProgress = (
      handler: ActionProgressHandler | null
    ): void => {
      state.onReceiveProgress = handler
    }

    const dispatchReceiveProgress = (
      progress: number,
      peerId: string,
      metadata?: JsonValue
    ): void => {
      const requestMetadata =
        state.kind === 'request' ? getRequestMetadata(metadata) : null

      state.onReceiveProgress?.(
        progress,
        withMetadata({peerId}, requestMetadata ? requestMetadata.m : metadata)
      )
    }

    progressRaw(dispatchReceiveProgress)

    if (kind === 'message') {
      let onMessage =
        (config as MessageActionConfig<T> | undefined)?.onMessage ?? null

      const flushMessages = (): void => {
        if (!onMessage) {
          return
        }

        const handler = onMessage

        state.pendingMessages
          .splice(0)
          .forEach(({payload, peerId, metadata}) => {
            void Promise.resolve()
              .then(() =>
                handler(payload as T, withMetadata({peerId}, metadata))
              )
              .catch(err =>
                console.error(`${libName} action handler error:`, err)
              )
          })
      }

      const action = {
        send: async (data: T, options: SendOptions = {}) => {
          await sendRaw(
            data,
            options.target,
            options.metadata,
            toProgressHandler(options.onProgress, options.metadata),
            options.signal
          )
        },

        get onMessage() {
          return onMessage
        },

        set onMessage(handler) {
          onMessage = handler
          flushMessages()
        },

        get onReceiveProgress() {
          return state.onReceiveProgress
        },

        set onReceiveProgress(handler) {
          setReceiveProgress(handler)
        }
      } satisfies MessageAction<T>

      receiveRaw((payload, peerId, metadata) => {
        if (!onMessage) {
          state.pendingMessages.push(
            metadata === undefined
              ? {payload, peerId}
              : {payload, peerId, metadata}
          )
          return
        }

        const handler = onMessage

        void Promise.resolve()
          .then(() => handler(payload as T, withMetadata({peerId}, metadata)))
          .catch(err => console.error(`${libName} action handler error:`, err))
      })

      state.action = action as MessageAction
      actions[type]!.publicState = state
      flushMessages()

      return action
    }

    let onRequest =
      (config as RequestActionConfig<T, R> | undefined)?.onRequest ?? null

    const removePendingIncomingRequest = (
      request: PendingIncomingRequest
    ): void => {
      resetTimer(request.timer)

      const i = state.pendingRequests.indexOf(request)

      if (i > -1) {
        state.pendingRequests.splice(i, 1)
      }
    }

    const sendRequestError = (
      peerId: string,
      requestId: string,
      error: unknown
    ): void => {
      void sendResponse(null, peerId, {
        r: requestId,
        e: toErrorMessage(error, 'request failed')
      })
    }

    const respondToIncomingRequest = (
      request: PendingIncomingRequest,
      handler: NonNullable<typeof onRequest>
    ): void => {
      removePendingIncomingRequest(request)

      void Promise.resolve()
        .then(() =>
          handler(request.payload as T, {
            peerId: request.peerId,
            ...(request.metadata === undefined
              ? {}
              : {metadata: request.metadata}),
            signal: request.controller.signal
          })
        )
        .then(async response => {
          if (response === undefined) {
            throw mkErr('request handler returned undefined')
          }

          await sendResponse(response, request.peerId, {r: request.requestId})
        })
        .catch(err => sendRequestError(request.peerId, request.requestId, err))
        .finally(() => request.controller.abort())
    }

    const flushRequests = (): void => {
      if (!onRequest) {
        return
      }

      state.pendingRequests
        .slice()
        .forEach(request => respondToIncomingRequest(request, onRequest!))
    }

    const queueIncomingRequest = (
      payload: DataPayload,
      peerId: string,
      metadata: JsonValue | undefined,
      requestId: string
    ): void => {
      if (onRequest) {
        const request: PendingIncomingRequest = {
          payload,
          peerId,
          ...(metadata === undefined ? {} : {metadata}),
          requestId,
          controller: new AbortController(),
          timer: null as unknown as ReturnType<typeof setTimeout>
        }

        respondToIncomingRequest(request, onRequest)
        return
      }

      const request: PendingIncomingRequest = {
        payload,
        peerId,
        ...(metadata === undefined ? {} : {metadata}),
        requestId,
        controller: new AbortController(),
        timer: setTimeout(() => {
          removePendingIncomingRequest(request)
          request.controller.abort()
          sendRequestError(peerId, requestId, 'request handler unavailable')
        }, requestHandlerBufferMs)
      }

      state.pendingRequests.push(request)
    }

    const requestOne = async (data: T, options: RequestOptions): Promise<R> => {
      const {target, metadata, onProgress, signal, timeoutMs} = options

      throwIfAborted(signal)

      if (!activePeerMap[target]) {
        throw makeActionError(
          'disconnected',
          `no active peer with id ${target}`
        )
      }

      const requestId = genId(20)
      const responsePromise = new Promise<DataPayload>((resolve, reject) => {
        const waiter: PendingRequestWaiter = {
          peerId: target,
          resolve,
          reject,
          timer: null,
          ...(signal === undefined ? {} : {signal})
        }

        const rejectAsAborted = (): void => {
          clearPendingRequestWaiter(requestId)
          reject(makeActionError('aborted', 'operation aborted'))
        }

        if (signal) {
          waiter.abortHandler = rejectAsAborted
          signal.addEventListener('abort', rejectAsAborted, {once: true})
        }

        pendingRequestWaiters[requestId] = waiter
      })
      const handledResponsePromise = responsePromise.catch(err => {
        throw err
      })

      try {
        await sendRaw(
          data,
          target,
          metadata === undefined ? {r: requestId} : {r: requestId, m: metadata},
          toProgressHandler(onProgress, metadata),
          signal
        )

        const waiter = pendingRequestWaiters[requestId]

        if (waiter && timeoutMs !== undefined) {
          waiter.timer = setTimeout(() => {
            clearPendingRequestWaiter(requestId)
            waiter.reject(makeActionError('timeout', 'request timed out'))
          }, timeoutMs)
        }

        return (await handledResponsePromise) as R
      } catch (err) {
        clearPendingRequestWaiter(requestId)
        throw err
      }
    }

    const action = {
      request: requestOne,

      requestMany: async (data: T, options: RequestManyOptions<R>) => {
        throwIfAborted(options.signal)

        const results = await all(
          options.targets.map(async target => {
            try {
              const value = await requestOne(data, {
                target,
                ...(options.metadata === undefined
                  ? {}
                  : {metadata: options.metadata}),
                ...(options.timeoutMs === undefined
                  ? {}
                  : {timeoutMs: options.timeoutMs}),
                ...(options.onProgress === undefined
                  ? {}
                  : {onProgress: options.onProgress}),
                ...(options.signal === undefined
                  ? {}
                  : {signal: options.signal})
              })
              const result = {
                peerId: target,
                status: 'fulfilled',
                value
              } satisfies PeerResult<R>
              options.onResult?.(result)
              return result
            } catch (err) {
              const error = toError(err, 'request failed') as ActionError

              if (error.kind === 'aborted' || !error.kind) {
                throw error
              }

              const result =
                error.kind === 'timeout'
                  ? ({peerId: target, status: 'timeout'} as PeerResult<R>)
                  : error.kind === 'disconnected'
                    ? ({
                        peerId: target,
                        status: 'disconnected'
                      } as PeerResult<R>)
                    : ({
                        peerId: target,
                        status: 'rejected',
                        error
                      } as PeerResult<R>)

              options.onResult?.(result)
              return result
            }
          })
        )

        return results
      },

      get onRequest() {
        return onRequest
      },

      set onRequest(handler) {
        onRequest = handler
        flushRequests()
      },

      get onReceiveProgress() {
        return state.onReceiveProgress
      },

      set onReceiveProgress(handler) {
        setReceiveProgress(handler)
      }
    } satisfies RequestAction<T, R>

    receiveRaw((payload, peerId, metadata) => {
      const requestMetadata = getRequestMetadata(metadata)

      if (!requestMetadata) {
        return
      }

      queueIncomingRequest(
        payload,
        peerId,
        requestMetadata.m,
        requestMetadata.r
      )
    })

    state.action = action as unknown as RequestAction
    actions[type]!.publicState = state
    flushRequests()

    return action
  }
  const makeAction = makeActionImpl as Room['makeAction']

  onPeer((peer, id) => {
    const existingPeer = peerMap[id]

    if (existingPeer) {
      if (existingPeer === peer) {
        return
      }

      existingPeer.destroy()
      clearPeerState(id, mkErr('peer replaced'))
    }

    peerMap[id] = peer
    peerStates[id] = {
      peer,
      isActive: false,
      didLocalHandshakePass: false,
      didReceiveRemoteReady: false,
      handshakeTimer: null,
      pendingHandshakePayloads: [],
      handshakeWaiters: []
    }

    peer.setHandlers({
      data: d => handleData(id, d),
      stream: stream => {
        if (!activePeerMap[id]) {
          return
        }

        const next = pendingStreamMetas[id]?.shift()

        if (!next) {
          return
        }

        emitStream(id, next.key, stream, next.metadata)
      },
      track: (track, stream) => {
        if (!activePeerMap[id]) {
          return
        }

        const next = pendingTrackMetas[id]?.shift()

        if (!next) {
          return
        }

        emitTrack(id, next.key, track, stream, next.metadata)
      },
      signal: sdp => {
        if (!activePeerMap[id]) {
          return
        }

        void sendSignal(sdp as unknown as DataPayload, id)
      },
      close: () => exitPeer(id, peer, mkErr('peer disconnected')),
      error: (err: Error) => {
        console.error(`${libName} peer error:`, err)
        exitPeer(id, peer, err)
      }
    })

    startPeerHandshake(id, peer)
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
        void sendPing('', id).catch(err =>
          waiter.reject(toError(err, 'peer disconnected'))
        )
      })

      return Date.now() - start
    },

    getPeers: () =>
      fromEntries(
        entries(activePeerMap).map(([id, peer]) => [id, peer.connection])
      ) as Record<string, RTCPeerConnection>,

    addStream: (stream, options: AddMediaOptions = {}) =>
      applyMediaOp(
        options.target,
        getStreamKey(stream),
        options.metadata,
        sendStreamMeta,
        peer => peer.addStream(stream),
        {s: stream.id}
      ),

    removeStream: (stream, options = {}) => {
      void iterate(options.target, (_, peer) => peer.removeStream(stream))
    },

    addTrack: (track, stream, options: AddMediaOptions = {}) =>
      applyMediaOp(
        options.target,
        getTrackKey(track),
        options.metadata,
        sendTrackMeta,
        peer => peer.addTrack(track, stream),
        {s: stream.id, t: track.id}
      ),

    removeTrack: (track, options = {}) => {
      void iterate(options.target, (_, peer) => peer.removeTrack(track))
    },

    replaceTrack: (oldTrack, newTrack, options: AddMediaOptions = {}) =>
      applyMediaOp(
        options.target,
        getTrackKey(newTrack),
        options.metadata,
        sendTrackMeta,
        peer => peer.replaceTrack(oldTrack, newTrack),
        {t: oldTrack.id}
      ),

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
  }
}
