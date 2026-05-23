import {
  all,
  alloc,
  decodeBytes,
  encodeBytes,
  fromJson,
  libName,
  mkErr,
  noOp,
  resetTimer,
  toJson
} from './utils'
import type {DataPayload, JsonValue, PeerHandle, TargetPeers} from './types'

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
const backpressureWaitTimeoutMs = 10_000

export type ActionOptions = {
  sendToPending: boolean
  receiveWhilePending: boolean
}

export type InternalActionSender<T extends DataPayload = DataPayload> = (
  data: T,
  targetPeers?: TargetPeers,
  metadata?: JsonValue,
  progress?: (percent: number, peerId: string, metadata?: JsonValue) => void,
  signal?: AbortSignal
) => Promise<void[]>

export type InternalActionReceiver<T extends DataPayload = DataPayload> = (
  receiver: (data: T, peerId: string, metadata?: JsonValue) => void
) => void

export type InternalActionProgress = (
  progressHandler: (
    percent: number,
    peerId: string,
    metadata?: JsonValue
  ) => void
) => void

export type InternalAction<T extends DataPayload = DataPayload> = {
  send: InternalActionSender<T>
  onMessage: InternalActionReceiver<T>
  onProgress: InternalActionProgress
}

type WireActionState = {
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

type ActionWireManagerDeps = {
  getPeer: (id: string, includePending: boolean) => PeerHandle | undefined
  getPeerIds: (includePending: boolean) => string[]
  canReceiveFromPeer: (id: string, receiveWhilePending: boolean) => boolean
  throwIfAborted: (signal?: AbortSignal) => void
}

const toByteArray = (value: ArrayBuffer | ArrayBufferView): Uint8Array =>
  value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)

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

export const createActionWireManager = ({
  getPeer,
  getPeerIds,
  canReceiveFromPeer,
  throwIfAborted
}: ActionWireManagerDeps): {
  makeInternalAction: <T extends DataPayload = DataPayload>(
    type: string,
    options?: Partial<ActionOptions>
  ) => InternalAction<T>
  handleData: (id: string, data: ArrayBuffer) => void
  clearPeer: (id: string) => void
} => {
  const actions: Record<string, WireActionState> = {}
  const actionsCache: Record<string, InternalAction> = {}
  const pendingTransmissions: Record<
    string,
    Record<string, Record<number, PendingTransmission>>
  > = {}
  const pendingActionPayloads: Record<string, PendingActionPayload[]> = {}

  const iterate = (
    targets: TargetPeers,
    f: (id: string, peer: PeerHandle) => Promise<void> | void,
    {includePending = false}: {includePending?: boolean} = {}
  ): Promise<void>[] =>
    (targets
      ? Array.isArray(targets)
        ? targets
        : [targets]
      : getPeerIds(includePending)
    ).flatMap(id => {
      const peer = getPeer(id, includePending)

      if (!peer) {
        console.warn(`${libName}: no peer with id ${id} found`)
        return []
      }

      return [Promise.resolve(f(id, peer))]
    })

  const makeInternalAction = <T extends DataPayload = DataPayload>(
    type: string,
    options: Partial<ActionOptions> = {}
  ): InternalAction<T> => {
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

      return cached as unknown as InternalAction<T>
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

                const currentPeer = getPeer(id, normalizedOptions.sendToPending)

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

    return (actionsCache[type] = {
      send: actions[type].send as InternalActionSender,
      onMessage: actions[type].setOnComplete as InternalActionReceiver,
      onProgress: actions[type].setOnProgress as InternalActionProgress
    }) as unknown as InternalAction<T>
  }

  const handleData = (id: string, data: ArrayBuffer): void => {
    const buffer = new Uint8Array(data)
    const type = decodeBytes(buffer.subarray(typeIndex, nonceIndex)).replaceAll(
      '\x00',
      ''
    )
    const action = actions[type]

    if (!canReceiveFromPeer(id, Boolean(action?.options.receiveWhilePending))) {
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

    const payloadValue = isBinary
      ? full
      : isJson
        ? fromJson<JsonValue>(decodeBytes(full))
        : decodeBytes(full)

    if (action) {
      action.onComplete(payloadValue, id, target.meta)
      return
    }

    ;(pendingActionPayloads[type] ??= []).push({
      payload: payloadValue,
      peerId: id,
      ...(target.meta === undefined ? {} : {metadata: target.meta})
    })
  }

  return {
    makeInternalAction,
    handleData,
    clearPeer: id => {
      delete pendingTransmissions[id]
    }
  }
}
