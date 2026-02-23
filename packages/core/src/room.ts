import {
  all,
  alloc,
  decodeBytes,
  encodeBytes,
  entries,
  fromEntries,
  fromJson,
  isBrowser,
  keys,
  libName,
  mkErr,
  noOp,
  selfId,
  toJson
} from './utils'
import type {
  ActionProgress,
  ActionReceiver,
  ActionSender,
  DataPayload,
  HandshakePayload,
  HandshakeReceiver,
  HandshakeSender,
  JsonValue,
  PeerHandle,
  PeerHandshake,
  Room,
  TargetPeers
} from './types'

const TypedArray = Object.getPrototypeOf(Uint8Array)
const typeByteLimit = 12
const typeIndex = 0
const nonceIndex = typeIndex + typeByteLimit
const tagIndex = nonceIndex + 1
const progressIndex = tagIndex + 1
const payloadIndex = progressIndex + 1
const chunkSize = 16 * 2 ** 10 - payloadIndex
const oneByteMax = 0xff
const buffLowEvent = 'bufferedamountlow'
const defaultHandshakeTimeoutMs = 10_000
const internalNs = (ns: string): string => '@_' + ns

type ActionOptions = {
  sendToPending: boolean
  receiveWhilePending: boolean
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
  send: ActionSender
  options: ActionOptions
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

type PendingPeerState = {
  peer: PeerHandle
  isActive: boolean
  didLocalHandshakePass: boolean
  didReceiveRemoteReady: boolean
  handshakeTimer: ReturnType<typeof setTimeout> | null
  pendingHandshakePayloads: HandshakePayload[]
  handshakeWaiters: Array<{
    resolve: (payload: HandshakePayload) => void
    reject: (reason?: unknown) => void
  }>
}

type RoomOptions = {
  onPeerHandshake?: PeerHandshake
  onHandshakeError?: (peerId: string, error: string) => void
  handshakeTimeoutMs?: number
}

const toByteArray = (value: ArrayBuffer | ArrayBufferView): Uint8Array =>
  value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)

const toReasonMessage = (reason: unknown, fallback: string): string => {
  if (reason instanceof Error && reason.message) {
    return reason.message
  }

  if (typeof reason === 'string' && reason) {
    return reason
  }

  if (reason === undefined || reason === null) {
    return fallback
  }

  return String(reason)
}

const toError = (reason: unknown, fallback: string): Error =>
  reason instanceof Error ? reason : mkErr(toReasonMessage(reason, fallback))

const toHandshakeErrorMessage = (reason: unknown): string => {
  const message = toReasonMessage(reason, 'unknown error')

  return message.startsWith('handshake ')
    ? message
    : `handshake failed: ${message}`
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
    [ActionSender, ActionReceiver, ActionProgress]
  > = {}
  const pendingTransmissions: Record<
    string,
    Record<string, Record<number, PendingTransmission>>
  > = {}
  const pendingActionPayloads: Record<string, PendingActionPayload[]> = {}
  const pendingPongs: Record<string, (() => void) | undefined> = {}
  const pendingStreamMetas: Record<string, JsonValue | undefined> = {}
  const pendingTrackMetas: Record<string, JsonValue | undefined> = {}
  const listeners = {
    onPeerJoin: noOp as (peerId: string) => void,
    onPeerLeave: noOp as (peerId: string) => void,
    onPeerStream: noOp as (
      stream: MediaStream,
      peerId: string,
      metadata?: JsonValue
    ) => void,
    onPeerTrack: noOp as (
      track: MediaStreamTrack,
      stream: MediaStream,
      peerId: string,
      metadata?: JsonValue
    ) => void
  }

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

  const clearPeerState = (
    id: string,
    reason: unknown = mkErr('peer disconnected')
  ): void => {
    const state = peerStates[id]

    if (state) {
      if (state.handshakeTimer) {
        clearTimeout(state.handshakeTimer)
      }

      state.pendingHandshakePayloads.length = 0
      const err = toError(reason, 'peer disconnected')

      state.handshakeWaiters.splice(0).forEach(waiter => waiter.reject(err))
      delete peerStates[id]
    }

    delete peerMap[id]
    delete activePeerMap[id]
    delete pendingTransmissions[id]
    delete pendingPongs[id]
    delete pendingStreamMetas[id]
    delete pendingTrackMetas[id]
  }

  const exitPeer = (id: string, peer?: PeerHandle, reason?: unknown): void => {
    const current = peerMap[id]

    if (!current) {
      return
    }

    if (peer && current !== peer) {
      return
    }

    const wasActive = Boolean(activePeerMap[id])

    current.destroy()
    clearPeerState(id, reason)

    if (wasActive) {
      listeners.onPeerLeave(id)
    }

    onPeerLeave(id)
  }

  const makeActionInternal = <T extends DataPayload = DataPayload>(
    type: string,
    options: Partial<ActionOptions> = {}
  ): [ActionSender<T>, ActionReceiver<T>, ActionProgress] => {
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
        ActionSender<T>,
        ActionReceiver<T>,
        ActionProgress
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

      send: async (data, targets, meta, onProgress) => {
        if (meta && typeof meta !== 'object') {
          throw mkErr('action meta argument must be an object')
        }

        const dataType = typeof data

        if (dataType === 'undefined') {
          throw mkErr('action data cannot be undefined')
        }

        const isJson = dataType !== 'string'
        const isBlob = data instanceof Blob
        const isBinary =
          isBlob || data instanceof ArrayBuffer || data instanceof TypedArray

        if (meta && !isBinary) {
          throw mkErr('action meta argument can only be used with binary data')
        }

        const buffer = isBinary
          ? toByteArray(
              isBlob
                ? await data.arrayBuffer()
                : (data as ArrayBuffer | ArrayBufferView)
            )
          : encodeBytes(isJson ? toJson(data) : (data as string))

        const metaEncoded = meta ? encodeBytes(toJson(meta)) : null

        const chunkTotal =
          Math.ceil(buffer.byteLength / chunkSize) + (meta ? 1 : 0) || 1

        const chunks = alloc(chunkTotal, (_, i) => {
          const isLast = i === chunkTotal - 1
          const isMeta = Boolean(meta && i === 0)
          const chunk = new Uint8Array(
            payloadIndex +
              (isMeta
                ? (metaEncoded?.byteLength ?? 0)
                : isLast
                  ? buffer.byteLength -
                    chunkSize * (chunkTotal - (meta ? 2 : 1))
                  : chunkSize)
          )

          chunk.set(typeBytesPadded)
          chunk.set([nonce], nonceIndex)
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
            meta
              ? isMeta
                ? (metaEncoded ?? new Uint8Array())
                : buffer.subarray((i - 1) * chunkSize, i * chunkSize)
              : buffer.subarray(i * chunkSize, (i + 1) * chunkSize),
            payloadIndex
          )

          return chunk
        })

        nonce = (nonce + 1) & oneByteMax

        await all(
          iterate(
            targets,
            async (id, peer) => {
              const {channel} = peer
              let chunkN = 0

              while (chunkN < chunkTotal) {
                const chunk = chunks[chunkN]

                if (!chunk) {
                  break
                }

                if (
                  channel &&
                  channel.bufferedAmount > channel.bufferedAmountLowThreshold
                ) {
                  await new Promise<void>(res => {
                    const next = (): void => {
                      channel.removeEventListener(buffLowEvent, next)
                      res()
                    }

                    channel.addEventListener(buffLowEvent, next)
                  })
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
      actions[type].send as ActionSender,
      actions[type].setOnComplete as ActionReceiver,
      actions[type].setOnProgress as ActionProgress
    ]) as unknown as [ActionSender<T>, ActionReceiver<T>, ActionProgress]
  }

  const makeAction = <T extends DataPayload = DataPayload>(
    type: string
  ): [ActionSender<T>, ActionReceiver<T>, ActionProgress] =>
    makeActionInternal<T>(type)

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

    const nonce = buffer[nonceIndex] ?? 0
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
        action.onComplete(decoded, id)
      } else {
        ;(pendingActionPayloads[type] ??= []).push({
          payload: decoded,
          peerId: id
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

    onSelfLeave()
  }

  const [sendPing, getPing] = makeActionInternal<string>(internalNs('ping'))
  const [sendPong, getPong] = makeActionInternal<string>(internalNs('pong'))
  const [sendSignal, getSignal] = makeActionInternal(internalNs('signal'))
  const [sendStreamMeta, getStreamMeta] = makeActionInternal<JsonValue>(
    internalNs('stream')
  )
  const [sendTrackMeta, getTrackMeta] = makeActionInternal<JsonValue>(
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

    if (state.handshakeTimer) {
      clearTimeout(state.handshakeTimer)
      state.handshakeTimer = null
    }

    listeners.onPeerJoin(id)
  }

  const failPeerHandshake = (
    id: string,
    peer: PeerHandle,
    reason: unknown
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
        `failed sending handshake readiness: ${toReasonMessage(
          err,
          'unknown send failure'
        )}`
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
          `handshake timed out after ${handshakeTimeoutMs}ms`
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

        current.handshakeWaiters.push({resolve, reject})
      })

    const isInitiator = selfId < id

    void Promise.resolve(
      onPeerHandshake?.(id, sendHandshake, receiveHandshake, isInitiator)
    )
      .then(() => markLocalHandshakePassed(id, peer))
      .catch(err => failPeerHandshake(id, peer, err))
  }

  getPing((_, id) => sendPong('', id))

  getPong((_, id) => {
    pendingPongs[id]?.()
    delete pendingPongs[id]
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

    pendingStreamMetas[id] = meta
  })

  getTrackMeta((meta, id) => {
    if (!activePeerMap[id]) {
      return
    }

    pendingTrackMetas[id] = meta
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

        listeners.onPeerStream(stream, id, pendingStreamMetas[id])
        delete pendingStreamMetas[id]
      },
      track: (track, stream) => {
        if (!activePeerMap[id]) {
          return
        }

        listeners.onPeerTrack(track, stream, id, pendingTrackMetas[id])
        delete pendingTrackMetas[id]
      },
      signal: sdp => {
        if (!activePeerMap[id]) {
          return
        }

        void sendSignal(sdp as unknown as DataPayload, id)
      },
      close: () => exitPeer(id, peer, mkErr('peer disconnected')),
      error: err => {
        console.error(`${libName} peer error:`, err)
        exitPeer(id, peer, err)
      }
    })

    startPeerHandshake(id, peer)
  })

  if (isBrowser) {
    addEventListener('beforeunload', leave)
  }

  return {
    makeAction,

    leave,

    ping: async id => {
      if (!id) {
        throw mkErr('ping() must be called with target peer ID')
      }

      const start = Date.now()

      void sendPing('', id)
      await new Promise<void>(res => {
        pendingPongs[id] = res
      })
      return Date.now() - start
    },

    getPeers: () =>
      fromEntries(
        entries(activePeerMap).map(([id, peer]) => [id, peer.connection])
      ) as Record<string, RTCPeerConnection>,

    addStream: (stream, targets, meta) =>
      iterate(targets, async (id, peer) => {
        if (meta) {
          await sendStreamMeta(meta, id)
        }

        peer.addStream(stream)
      }),

    removeStream: (stream, targets) => {
      void iterate(targets, (_, peer) => peer.removeStream(stream))
    },

    addTrack: (track, stream, targets, meta) =>
      iterate(targets, async (id, peer) => {
        if (meta) {
          await sendTrackMeta(meta, id)
        }

        peer.addTrack(track, stream)
      }),

    removeTrack: (track, targets) => {
      void iterate(targets, (_, peer) => peer.removeTrack(track))
    },

    replaceTrack: (oldTrack, newTrack, targets, meta) =>
      iterate(targets, async (id, peer) => {
        if (meta) {
          await sendTrackMeta(meta, id)
        }

        await peer.replaceTrack(oldTrack, newTrack)
      }),

    onPeerJoin: f => {
      listeners.onPeerJoin = f
      keys(activePeerMap).forEach(peerId => f(peerId))
    },

    onPeerLeave: f => (listeners.onPeerLeave = f),

    onPeerStream: f => (listeners.onPeerStream = f),

    onPeerTrack: f => (listeners.onPeerTrack = f)
  }
}
