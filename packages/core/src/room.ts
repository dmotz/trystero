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
  toJson
} from './utils.js'
import type {
  ActionProgress,
  ActionReceiver,
  ActionSender,
  DataPayload,
  JsonValue,
  PeerHandle,
  Room,
  TargetPeers
} from './types.js'

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
const internalNs = (ns: string): string => '@_' + ns

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

const toByteArray = (value: ArrayBuffer | ArrayBufferView): Uint8Array =>
  value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)

export default (
  onPeer: (f: (peer: PeerHandle, id: string) => void) => void,
  onPeerLeave: (id: string) => void,
  onSelfLeave: () => void
): Room => {
  const peerMap: Record<string, PeerHandle> = {}
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
    f: (id: string, peer: PeerHandle) => Promise<void> | void
  ): Promise<void>[] =>
    (targets
      ? Array.isArray(targets)
        ? targets
        : [targets]
      : keys(peerMap)
    ).flatMap(id => {
      const peer = peerMap[id]

      if (!peer) {
        console.warn(`${libName}: no peer with id ${id} found`)
        return []
      }

      return [Promise.resolve(f(id, peer))]
    })

  const clearPeerState = (id: string): void => {
    delete peerMap[id]
    delete pendingTransmissions[id]
    delete pendingPongs[id]
    delete pendingStreamMetas[id]
    delete pendingTrackMetas[id]
  }

  const exitPeer = (id: string, peer?: PeerHandle): void => {
    const current = peerMap[id]

    if (!current) {
      return
    }

    if (peer && current !== peer) {
      return
    }

    current.destroy()
    clearPeerState(id)
    listeners.onPeerLeave(id)
    onPeerLeave(id)
  }

  const makeAction = <T extends DataPayload = DataPayload>(
    type: string
  ): [ActionSender<T>, ActionReceiver<T>, ActionProgress] => {
    const cached = actionsCache[type]

    if (actions[type] && cached) {
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
          iterate(targets, async (id, peer) => {
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

              if (!peerMap[id]) {
                break
              }

              peer.sendData(chunk)
              chunkN++
              const progressByte = chunk[progressIndex] ?? oneByteMax
              onProgress?.(progressByte / oneByteMax, id, meta)
            }
          })
        )

        return []
      }
    }

    return (actionsCache[type] = [
      actions[type].send as ActionSender,
      actions[type].setOnComplete as ActionReceiver,
      actions[type].setOnProgress as ActionProgress
    ]) as unknown as [ActionSender<T>, ActionReceiver<T>, ActionProgress]
  }

  const handleData = (id: string, data: ArrayBuffer): void => {
    const buffer = new Uint8Array(data)
    const type = decodeBytes(buffer.subarray(typeIndex, nonceIndex)).replaceAll(
      '\x00',
      ''
    )
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

    actions[type]?.onProgress(progress / oneByteMax, id, target.meta)

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
      if (actions[type]) {
        actions[type].onComplete(full, id, target.meta)
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

      if (actions[type]) {
        actions[type].onComplete(decoded, id)
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
      delete peerMap[id]
    })

    onSelfLeave()
  }

  const [sendPing, getPing] = makeAction<string>(internalNs('ping'))
  const [sendPong, getPong] = makeAction<string>(internalNs('pong'))
  const [sendSignal, getSignal] = makeAction(internalNs('signal'))
  const [sendStreamMeta, getStreamMeta] = makeAction<JsonValue>(
    internalNs('stream')
  )
  const [sendTrackMeta, getTrackMeta] = makeAction<JsonValue>(
    internalNs('track')
  )
  const [sendLeave, getLeave] = makeAction<string>(internalNs('leave'))

  onPeer((peer, id) => {
    const existingPeer = peerMap[id]

    if (existingPeer) {
      if (existingPeer === peer) {
        return
      }

      existingPeer.destroy()
      clearPeerState(id)
    }

    peerMap[id] = peer

    peer.setHandlers({
      data: d => handleData(id, d),
      stream: stream => {
        listeners.onPeerStream(stream, id, pendingStreamMetas[id])
        delete pendingStreamMetas[id]
      },
      track: (track, stream) => {
        listeners.onPeerTrack(track, stream, id, pendingTrackMetas[id])
        delete pendingTrackMetas[id]
      },
      signal: sdp => sendSignal(sdp as unknown as DataPayload, id),
      close: () => exitPeer(id, peer),
      error: err => {
        console.error(`${libName} peer error:`, err)
        exitPeer(id, peer)
      }
    })

    listeners.onPeerJoin(id)
  })

  getPing((_, id) => sendPong('', id))

  getPong((_, id) => {
    pendingPongs[id]?.()
    delete pendingPongs[id]
  })

  getSignal((sdp, id) => peerMap[id]?.signal(sdp as never))

  getStreamMeta((meta, id) => (pendingStreamMetas[id] = meta))

  getTrackMeta((meta, id) => (pendingTrackMetas[id] = meta))

  getLeave((_, id) => exitPeer(id))

  if (isBrowser) {
    addEventListener('beforeunload', () => {
      void leave()
    })
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
        entries(peerMap).map(([id, peer]) => [id, peer.connection])
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
      keys(peerMap).forEach(peerId => f(peerId))
    },

    onPeerLeave: f => (listeners.onPeerLeave = f),

    onPeerStream: f => (listeners.onPeerStream = f),

    onPeerTrack: f => (listeners.onPeerTrack = f)
  }
}
