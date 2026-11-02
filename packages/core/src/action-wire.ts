import {
  maxActionFrameBytes as maxFrameBytes,
  transferTimeoutMs
} from './data-limits'
import {
  createDirectPeerTransport,
  type PeerDataTransport
} from './peer-registry'
import {
  actionRedefinedErr,
  all,
  decodeBytes,
  encodeBytes,
  fromJson,
  invalidActionMsg,
  logActionHandlerErr,
  logErr,
  mkErr,
  noOp,
  operationAbortedMsg,
  peerDisconnectedMsg,
  posSafeIntErr,
  resetTimer,
  toJson,
  toPayloadSource,
  warn,
  warnNoPeer
} from './utils'
import type {
  ActionReceiveContext,
  DataPayload,
  JsonValue,
  PeerHandle,
  TargetPeers
} from './types'

const version = 2
const inline = 0
const offer = 1
const chunk = 2
const accepted = 3
const rejected = 4
const cancelled = 5
const inlineHeaderSize = 36 // version, kind/format, action name, metadata length
const offerHeaderSize = 48 // inline header, uint32 id, float64 byte length
const controlHeaderSize = 6 // version, kind, uint32 id
const chunkHeaderSize = 14 // control header, float64 byte offset
const chunkSize = maxFrameBytes - chunkHeaderSize
const defaultMaxReceiveBytes = 256 * 1024 ** 2
const maxControlBufferedBytes = 1024 ** 2

const maxPendingTransfers = 1024
const maxPendingPerPeer = 64
const maxDecisions = 128
const maxDecisionsPerPeer = 8
const emptyBytes = new Uint8Array()
const sizeLimitMsg = 'payload exceeds receiver size limit'
const invalidPayloadMsg = invalidActionMsg('payload')

export const textFormat = 0
export const jsonFormat = 1
export const binaryFormat = 2

const phasePending = 0
const phaseDeciding = 1
const phaseReady = 2
const phaseReleased = 3

type WireReceiveContext = Omit<ActionReceiveContext, 'kind' | 'userId'>
export type WireReceiveHandler = (
  context: WireReceiveContext
) => boolean | Promise<boolean>

export type ReceiveScope = readonly [
  key: string,
  signal: AbortSignal,
  receive: WireReceiveHandler | null,
  reject: (reason: string) => void
]

export type ReceiveScopeResolver = (
  peerId: string,
  metadata?: JsonValue
) => ReceiveScope | null

export type ReceiveOptions = {
  receiveScope?: ReceiveScopeResolver
  maxPayloadBytes?: number
}

export type WireRejectHandler = (
  peerId: string,
  metadata: JsonValue | undefined,
  reason: string
) => void

type ReceiveAction = {
  l?: number
  s?: ReceiveScopeResolver
  r: ((data: DataPayload, peerId: string, metadata?: JsonValue) => void) | null
  p: (percent: number, peerId: string, metadata?: JsonValue) => void
  g: WireReceiveHandler | null
  x: WireRejectHandler | null
}

type Message = readonly [
  peerId: string,
  type: string,
  format: number,
  size: number,
  metadata: JsonValue | undefined
]

type Admission = {
  m: Message
  s?: ReceiveScope
  u?: () => void
  p: 0 | 1 | 2 | 3
  c: AbortController | null
  l: number
  t: ReturnType<typeof setTimeout> | null
}

type Inline = Admission & {k: 0; y: string; d: Uint8Array}
type Bulk = Admission & {
  k: 1
  i: number
  w: 0 | 1
  d: Uint8Array | null
  o: number
}
type Incoming = Inline | Bulk
type PeerIncoming = {
  b: Map<number, Bulk>
  n: Map<string, Inline[]>
  a: Bulk | null
  c: number
}

export type ActionErrorKind =
  | 'timeout'
  | 'disconnected'
  | 'aborted'
  | 'rejected'

export type ActionError = Error & {
  kind?: ActionErrorKind
}

export const makeActionError = (
  kind: ActionErrorKind,
  message: string
): ActionError => {
  const error = mkErr(message) as ActionError
  error.kind = kind
  error.name = kind === 'aborted' ? 'AbortError' : error.name
  return error
}

export const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw makeActionError('aborted', operationAbortedMsg)
  }
}

export type ActionOptions = ReceiveOptions & {
  sendToPending: boolean
  receiveWhilePending: boolean
}
export type InternalActionSender<T extends DataPayload = DataPayload> = (
  data: T,
  targetPeers?: TargetPeers,
  metadata?: JsonValue,
  progress?: (percent: number, peerId: string, metadata?: JsonValue) => void,
  signal?: AbortSignal
) => Promise<void>
export type InternalActionReceiver<T extends DataPayload = DataPayload> = (
  receiver: ((data: T, peerId: string, metadata?: JsonValue) => void) | null
) => void
export type InternalAction<T extends DataPayload = DataPayload> = {
  send: InternalActionSender<T>
  onMessage: InternalActionReceiver<T>
  onProgress: (
    handler: (percent: number, peerId: string, metadata?: JsonValue) => void
  ) => void
  onReceive: (handler: WireReceiveHandler | null) => void
  onReject: (handler: WireRejectHandler) => void
}

type WireActionTuple = [
  sendToPending: boolean,
  receiveWhilePending: boolean,
  maxPayloadBytes: number | undefined,
  receiveScope: ReceiveScopeResolver | undefined,
  action: InternalAction
]

type OutgoingTuple = [
  accept: () => boolean,
  fail: (error: Error, fromReceiver?: boolean) => void,
  touch: () => void
]

const viewOf = (b: Uint8Array): DataView =>
  new DataView(b.buffer, b.byteOffset, b.byteLength)

const packet = (
  kind: number,
  id: number,
  size = controlHeaderSize
): Uint8Array => {
  const bytes = new Uint8Array(size)
  bytes[0] = version
  bytes[1] = kind
  viewOf(bytes).setUint32(2, id)
  return bytes
}

const startIdleTimer = (
  getLast: () => number,
  onTimeout: () => void,
  setTimer: (t: ReturnType<typeof setTimeout>) => void
): void => {
  const tick = (): void => {
    const rem = transferTimeoutMs - (Date.now() - getLast())
    if (rem > 0) {
      setTimer(setTimeout(tick, rem))
    } else {
      onTimeout()
    }
  }
  setTimer(setTimeout(tick, transferTimeoutMs))
}

const decodeActionType = (frame: Uint8Array): string =>
  decodeBytes(frame.subarray(2, 34)).replaceAll('\0', '')

const decideReceive = (
  decide: () => boolean | Promise<boolean>,
  settle: (allow: boolean) => boolean
): boolean | Promise<boolean> => {
  let result: boolean | Promise<boolean>
  try {
    result = decide()
  } catch {
    return settle(false)
  }
  return typeof result === 'boolean'
    ? settle(result)
    : Promise.resolve(result).then(
        value => settle(value === true),
        () => settle(false)
      )
}

const decodePayload = (
  bytes: Uint8Array,
  format: number,
  copy: boolean
): DataPayload =>
  format === binaryFormat
    ? copy
      ? bytes.slice()
      : bytes
    : format === jsonFormat
      ? fromJson<JsonValue>(decodeBytes(bytes))
      : decodeBytes(bytes)

const emitRxProgress = (
  action: ReceiveAction,
  value: number,
  peerId: string,
  metadata?: JsonValue
): void => {
  try {
    action.p(value, peerId, metadata)
  } catch (error) {
    logErr('progress handler', error)
  }
}

const deliverPayload = (
  action: ReceiveAction,
  data: DataPayload,
  peerId: string,
  metadata?: JsonValue
): void => {
  emitRxProgress(action, 1, peerId, metadata)
  try {
    action.r?.(data, peerId, metadata)
  } catch (error) {
    logActionHandlerErr(error)
  }
}

export const toPeerTransportGetter = (
  getTransport?: (
    id: string,
    includePending: boolean
  ) => PeerDataTransport | undefined,
  getPeer?: (id: string, includePending: boolean) => PeerHandle | undefined
): ((id: string, includePending: boolean) => PeerDataTransport | undefined) => {
  if (getTransport) {
    return getTransport
  }
  const cache = new WeakMap<PeerHandle, PeerDataTransport>()
  return (peerId, includePending) => {
    const peer = getPeer?.(peerId, includePending)
    if (!peer) {
      return undefined
    }
    let cached = cache.get(peer)
    if (!cached) {
      cached = createDirectPeerTransport(peer, () => {
        const cur = getPeer?.(peerId, true) ?? getPeer?.(peerId, false)
        return Boolean(cur && !cur.isDead)
      })
      cache.set(peer, cached)
    }
    return cached
  }
}

export const initActionWireManager = (
  getPeerIds: (includePending: boolean) => string[],
  canReceiveFromPeer: (id: string, receiveWhilePending: boolean) => boolean,
  onPeerError: (peerId: string, error: Error) => void,
  resolveTransport: (
    id: string,
    includePending: boolean
  ) => PeerDataTransport | undefined,
  broadcastInline?: (
    frame: Uint8Array,
    onProgress?: (peerId: string) => void,
    signal?: AbortSignal
  ) => Promise<boolean> | boolean,
  checkAborted: (signal?: AbortSignal) => void = throwIfAborted,
  maxReceiveBytes: number = defaultMaxReceiveBytes
): readonly [
  makeInternalAction: <T extends DataPayload = DataPayload>(
    type: string,
    options?: Partial<ActionOptions>
  ) => InternalAction<T>,
  handleData: (id: string, data: ArrayBuffer) => void,
  clearPeer: (id: string) => void
] => {
  if (!Number.isSafeInteger(maxReceiveBytes) || maxReceiveBytes <= 0) {
    throw posSafeIntErr('maxReceiveBytes')
  }
  const actions = new Map<string, WireActionTuple>()
  const rxActions = new Map<string, ReceiveAction>()
  const outgoing = new Map<string, Map<number, OutgoingTuple>>()
  const peers = new Map<string, PeerIncoming>()
  const waiting = new Set<Bulk>()
  const decisions = new Map<string, number>()
  const failedTransports = new WeakSet<PeerDataTransport>()
  let nextId = 0
  let pendingCount = 0
  let decisionCount = 0
  let reservedBytes = 0
  let draining = false
  let drainAgain = false

  const disconnectedTransferErr = (): ActionError =>
    makeActionError('disconnected', peerDisconnectedMsg)
  const invalidFrameMsg = invalidActionMsg('frame')
  const current = (state: Incoming): boolean => state.p !== phaseReleased
  const payloadLimit = (action?: ReceiveAction): number =>
    Math.min(maxReceiveBytes, action?.l ?? maxReceiveBytes)

  const failPeer = (peerId: string, reason: string): void => {
    const target = resolveTransport(peerId, true)
    if (target && !failedTransports.has(target)) {
      failedTransports.add(target)
      warn(`${reason}; disconnecting peer ${peerId}`)
      onPeerError(peerId, mkErr(reason))
    }
  }

  const sendControlFrame = (
    peerId: string,
    target: PeerDataTransport | undefined,
    id: number,
    kind: number,
    reason = ''
  ): void => {
    if (!target || !target.isOpen) {
      return
    }
    const text = encodeBytes(reason).subarray(0, 200)
    const bytes = packet(kind, id, controlHeaderSize + text.length)
    bytes.set(text, controlHeaderSize)
    try {
      if (target.bufferedAmount > maxControlBufferedBytes) {
        throw mkErr('control send buffer is full')
      }
      target.sendFrame(bytes, id)
    } catch {
      failPeer(peerId, 'unable to send action control')
    }
  }

  const control = (
    peerId: string,
    id: number,
    kind: number,
    reason = ''
  ): void => {
    sendControlFrame(peerId, resolveTransport(peerId, true), id, kind, reason)
  }

  const notifyRejected = (
    message: Message,
    reason: string,
    scope?: ReceiveScope,
    bulkId?: number
  ): void => {
    scope?.[3](reason)
    rxActions.get(message[1])?.x?.(message[0], message[4], reason)
    if (bulkId !== undefined) {
      control(message[0], bulkId, rejected, reason)
    }
  }

  const rotateWaitingForPeer = (peerId: string): void => {
    for (const queued of Array.from(waiting)) {
      if (queued.m[0] === peerId) {
        waiting.delete(queued)
        waiting.add(queued)
      }
    }
  }

  const release = (state: Incoming): void => {
    if (!current(state)) {
      return
    }
    state.p = phaseReleased
    state.u?.()
    state.t = resetTimer(state.t)
    const peerId = state.m[0]
    const peer = peers.get(peerId)!
    if (state.k === 0) {
      const queue = peer.n.get(state.y)!
      queue.splice(queue.indexOf(state), 1)
      if (!queue.length) {
        peer.n.delete(state.y)
      }
      state.d = emptyBytes
    } else {
      peer.b.delete(state.i)
      waiting.delete(state)
      state.d = null
      if (state.w === 1) {
        reservedBytes -= state.m[3]
        if (peer.a === state) {
          peer.a = null
          rotateWaitingForPeer(peerId)
        }
        drainAgain = true
      }
    }
    peer.c--
    pendingCount--
    if (!peer.c) {
      peers.delete(peerId)
    }
    state.c?.abort()
  }

  const rejectRx = (state: Incoming, reason: string): void => {
    if (!current(state)) {
      return
    }
    release(state)
    notifyRejected(
      state.m,
      reason,
      state.s,
      state.k === 1 ? state.i : undefined
    )
  }

  const admit = (state: Incoming, action: ReceiveAction): boolean => {
    if (state.p !== phasePending) {
      return state.p === phaseReady
    }
    if (state.m[3] > payloadLimit(action)) {
      rejectRx(state, sizeLimitMsg)
      return false
    }
    const receive = state.s ? state.s[2] : action.g
    if (!receive) {
      if (!action.r) {
        return false
      }
      state.p = phaseReady
      return true
    }
    const peerId = state.m[0]
    if (
      decisionCount >= maxDecisions ||
      (decisions.get(peerId) ?? 0) >= maxDecisionsPerPeer
    ) {
      rejectRx(state, 'too many pending receive decisions')
      return false
    }
    state.p = phaseDeciding
    const controller = new AbortController()
    state.c = controller
    decisionCount++
    decisions.set(peerId, (decisions.get(peerId) ?? 0) + 1)
    const result = decideReceive(
      () =>
        receive({
          byteLength: state.m[3],
          peerId,
          signal: controller.signal,
          ...(state.m[4] === undefined ? {} : {metadata: state.m[4]})
        }),
      allow => {
        decisionCount--
        const count = decisions.get(peerId)! - 1
        if (count) {
          decisions.set(peerId, count)
        } else {
          decisions.delete(peerId)
        }
        if (!current(state)) {
          return false
        }
        if (allow) {
          state.p = phaseReady
        } else {
          rejectRx(state, 'payload rejected by receiver')
        }
        return allow
      }
    )
    if (typeof result === 'boolean') {
      return result
    }
    void result.then(() => drain())
    return false
  }

  const complete = (
    state: Incoming,
    action: ReceiveAction,
    bytes: Uint8Array
  ): void => {
    let payload: DataPayload
    try {
      payload = decodePayload(bytes, state.m[2], state.k === 0)
    } catch {
      release(state)
      failPeer(state.m[0], invalidPayloadMsg)
      return
    }
    release(state)
    deliverPayload(action, payload, state.m[0], state.m[4])
  }

  const tryInline = (state: Inline): void => {
    const action = rxActions.get(state.m[1])
    if (current(state) && action && admit(state, action) && action.r) {
      complete(state, action, state.d)
    }
  }

  const tryBulk = (state: Bulk): void => {
    const action = rxActions.get(state.m[1])
    if (!current(state) || !action || !admit(state, action) || !action.r) {
      return
    }
    if (state.w === 1) {
      if (state.o === state.m[3]) {
        complete(state, action, state.d!)
      }
      return
    }
    const peer = peers.get(state.m[0])!
    if (!peer.a && reservedBytes + state.m[3] <= maxReceiveBytes) {
      peer.a = state
      state.w = 1
      reservedBytes += state.m[3]
      state.l = Date.now()
      waiting.delete(state)
      control(state.m[0], state.i, accepted)
    }
  }

  const drainInline = (peerId: string, key: string): void => {
    const queue = peers.get(peerId)?.n.get(key)
    while (queue?.[0]) {
      const state = queue[0]
      tryInline(state)
      if (current(state)) {
        break
      }
    }
  }

  const drain = (): void => {
    if (draining) {
      drainAgain = true
      return
    }
    draining = true
    try {
      do {
        drainAgain = false
        for (const state of waiting) {
          tryBulk(state)
        }
        for (const [id, peer] of peers) {
          for (const state of peer.b.values()) {
            if (state.o === state.m[3]) {
              tryBulk(state)
            }
          }
          for (const key of peer.n.keys()) {
            drainInline(id, key)
          }
        }
      } while (drainAgain)
    } finally {
      draining = false
    }
  }

  const enqueue = (state: Incoming): boolean => {
    const peerId = state.m[0]
    let peer = peers.get(peerId)
    if (
      pendingCount >= maxPendingTransfers ||
      (peer?.c ?? 0) >= maxPendingPerPeer
    ) {
      notifyRejected(
        state.m,
        'too many pending transfers',
        state.s,
        state.k === 1 ? state.i : undefined
      )
      return false
    }
    if (!peer) {
      peer = {b: new Map(), n: new Map(), a: null, c: 0}
      peers.set(peerId, peer)
    }
    peer.c++
    pendingCount++
    if (state.k === 0) {
      const queue = peer.n.get(state.y) ?? []
      queue.push(state)
      peer.n.set(state.y, queue)
    } else {
      peer.b.set(state.i, state)
      waiting.add(state)
    }
    startIdleTimer(
      () => state.l,
      () => {
        rejectRx(state, 'action transfer timed out')
        drain()
      },
      t => {
        state.t = t
      }
    )
    if (state.s) {
      const sig = state.s[1]
      const cancel = (): void => {
        rejectRx(state, 'receive cancelled')
        drain()
      }
      sig.addEventListener('abort', cancel, {once: true})
      state.u = () => sig.removeEventListener('abort', cancel)
      if (sig.aborted) {
        cancel()
        return false
      }
    }
    return true
  }

  const resolveAdmission = (
    message: Message,
    bulkId?: number
  ):
    | [action: ReceiveAction | undefined, scope: ReceiveScope | undefined]
    | null => {
    const action = rxActions.get(message[1])
    const scope = action?.s?.(message[0], message[4])
    if (scope === null || scope?.[1].aborted) {
      if (bulkId !== undefined) {
        control(message[0], bulkId, rejected, 'unexpected response')
      }
      return null
    }
    if (message[3] > payloadLimit(action)) {
      notifyRejected(message, sizeLimitMsg, scope, bulkId)
      return null
    }
    return [action, scope]
  }

  const admission = (m: Message, s?: ReceiveScope): Admission => ({
    m,
    ...(s ? {s} : {}),
    p: phasePending,
    c: null,
    l: Date.now(),
    t: null
  })

  const clearPeer = (peerId: string): void => {
    for (const state of outgoing.get(peerId)?.values() ?? []) {
      state[1](disconnectedTransferErr())
    }
    outgoing.delete(peerId)
    const peer = peers.get(peerId)
    if (peer) {
      for (const state of peer.b.values()) {
        release(state)
      }
      for (const queue of peer.n.values()) {
        queue.slice().forEach(release)
      }
    }
    drain()
  }

  return [
    <T extends DataPayload = DataPayload>(
      type: string,
      options: Partial<ActionOptions> = {}
    ): InternalAction<T> => {
      const sendToPending = Boolean(options.sendToPending)
      const receiveWhilePending = Boolean(options.receiveWhilePending)
      const {maxPayloadBytes, receiveScope} = options
      const cached = actions.get(type)
      if (cached) {
        if (
          cached[0] !== sendToPending ||
          cached[1] !== receiveWhilePending ||
          cached[2] !== maxPayloadBytes ||
          cached[3] !== receiveScope
        ) {
          throw actionRedefinedErr(type)
        }
        return cached[4] as unknown as InternalAction<T>
      }
      const typeBytes = encodeBytes(type)
      if (!type || type.includes('\0') || typeBytes.length > 32) {
        throw mkErr('action type must be 1–32 non-null UTF-8 bytes')
      }
      const rxAction: ReceiveAction = {
        ...(maxPayloadBytes === undefined ? {} : {l: maxPayloadBytes}),
        ...(receiveScope ? {s: receiveScope} : {}),
        r: null,
        g: null,
        x: null,
        p: noOp
      }
      rxActions.set(type, rxAction)
      const actionObj: InternalAction = {
        onMessage: (handler => {
          rxAction.r = handler as ReceiveAction['r']
          drain()
        }) as InternalAction['onMessage'],
        onReceive: handler => {
          rxAction.g = handler
          drain()
        },
        onReject: handler => {
          rxAction.x = handler
        },
        onProgress: handler => {
          rxAction.p = handler
        },
        send: async (data, targets, metadata, progressCb, signal) => {
          checkAborted(signal)
          if (data === undefined) {
            throw mkErr('action data cannot be undefined')
          }
          const [format, rawSource] = toPayloadSource(data)
          let source = rawSource
          const size =
            source instanceof Uint8Array ? source.byteLength : source.size
          const meta =
            metadata === undefined ? emptyBytes : encodeBytes(toJson(metadata))
          if (meta.length > maxFrameBytes - offerHeaderSize) {
            throw mkErr('action metadata is too large')
          }
          const small = inlineHeaderSize + meta.length + size <= maxFrameBytes
          if (
            !small &&
            format === binaryFormat &&
            source instanceof Uint8Array
          ) {
            source = source.slice()
          }
          const id = small ? 0 : nextId++ >>> 0
          const headerSize = small ? inlineHeaderSize : offerHeaderSize
          const start = new Uint8Array(
            headerSize + meta.length + (small ? size : 0)
          )
          start[0] = version
          start[1] = (small ? inline : offer) | (format << 4)
          start.set(typeBytes, 2)
          const view = viewOf(start)
          view.setUint16(34, meta.length)
          if (!small) {
            view.setUint32(36, id)
            view.setFloat64(40, size)
          }
          start.set(meta, headerSize)
          if (small) {
            start.set(
              source instanceof Uint8Array
                ? source
                : new Uint8Array(await source.arrayBuffer()),
              headerSize + meta.length
            )
          }
          if (
            !targets &&
            small &&
            !sendToPending &&
            broadcastInline &&
            (await broadcastInline(
              start,
              peerId => progressCb?.(1, peerId, metadata),
              signal
            ))
          ) {
            return
          }
          const ids = targets ? [targets].flat() : getPeerIds(sendToPending)
          await all(
            [...new Set(ids)].map(async peerId => {
              const transport = resolveTransport(peerId, sendToPending)
              if (!transport) {
                warnNoPeer(peerId)
                return
              }
              let failure: Error | null = null
              const check = (): void => {
                if (failure) {
                  throw failure
                }
                checkAborted(signal)
                if (!transport.isOpen) {
                  throw disconnectedTransferErr()
                }
              }
              const sendFrame = async (
                bytes: Uint8Array,
                isOffer?: boolean
              ): Promise<void> => {
                check()
                const drainRes = transport.waitForDrain(signal)
                if (drainRes !== true) {
                  if (!(await drainRes)) {
                    checkAborted(signal)
                    throw makeActionError(
                      'disconnected',
                      'data channel stopped draining'
                    )
                  }
                  check()
                }
                try {
                  transport.sendFrame(bytes, small ? undefined : id, isOffer)
                } catch {
                  throw disconnectedTransferErr()
                }
              }
              if (small) {
                await sendFrame(start)
                progressCb?.(1, peerId, metadata)
                return
              }
              let didSendOffer = false
              let settledByReceiver = false
              let lastSeen = Date.now()
              let acceptOffer!: () => void
              let rejectOffer!: (error: Error) => void
              const permission = new Promise<void>((resolve, rejectPromise) => {
                acceptOffer = resolve
                rejectOffer = rejectPromise
              })
              void permission.catch(noOp)
              const transfers =
                outgoing.get(peerId) ?? new Map<number, OutgoingTuple>()
              if (transfers.has(id)) {
                throw mkErr('action transfer id in use')
              }
              outgoing.set(peerId, transfers)
              let timer: ReturnType<typeof setTimeout> | null = null
              const state: OutgoingTuple = [
                () => {
                  if (!timer || failure) {
                    return false
                  }
                  timer = resetTimer(timer)
                  acceptOffer()
                  return true
                },
                (error, fromReceiver = false) => {
                  if (fromReceiver) {
                    settledByReceiver = true
                  }
                  failure = error
                  rejectOffer(error)
                },
                () => {
                  if (timer) {
                    lastSeen = Date.now()
                  }
                }
              ]
              transfers.set(id, state)
              startIdleTimer(
                () => lastSeen,
                () =>
                  state[1](
                    makeActionError('timeout', 'action offer timed out')
                  ),
                t => {
                  timer = t
                }
              )
              const abort = (): void => {
                try {
                  checkAborted(signal)
                } catch (error) {
                  state[1](error as Error)
                }
              }
              signal?.addEventListener('abort', abort, {once: true})
              try {
                await sendFrame(start, true)
                didSendOffer = true
                await permission
                for (let offset = 0; offset < size; offset += chunkSize) {
                  check()
                  const length = Math.min(chunkSize, size - offset)
                  const bytes = packet(chunk, id, chunkHeaderSize + length)
                  viewOf(bytes).setFloat64(controlHeaderSize, offset)
                  bytes.set(
                    source instanceof Uint8Array
                      ? source.subarray(offset, offset + length)
                      : new Uint8Array(
                          await source
                            .slice(offset, offset + length)
                            .arrayBuffer()
                        ),
                    chunkHeaderSize
                  )
                  await sendFrame(bytes)
                  transfers.forEach(p => p[2]())
                  progressCb?.((offset + length) / size, peerId, metadata)
                }
                check()
              } catch (error) {
                if (
                  didSendOffer &&
                  !settledByReceiver &&
                  transport.isOpen &&
                  transport.bufferedAmount <= maxControlBufferedBytes
                ) {
                  sendControlFrame(peerId, transport, id, cancelled)
                }
                throw error
              } finally {
                timer = resetTimer(timer)
                signal?.removeEventListener('abort', abort)
                transfers.delete(id)
                if (!transfers.size && outgoing.get(peerId) === transfers) {
                  outgoing.delete(peerId)
                }
              }
            })
          )
        }
      }
      actions.set(type, [
        sendToPending,
        receiveWhilePending,
        maxPayloadBytes,
        receiveScope,
        actionObj
      ])
      return actionObj as unknown as InternalAction<T>
    },

    (peerId: string, data: ArrayBuffer): void => {
      if (data.byteLength < 2 || data.byteLength > maxFrameBytes) {
        failPeer(peerId, invalidFrameMsg)
        return
      }
      const bytes = new Uint8Array(data)
      if (bytes[0] !== version) {
        failPeer(peerId, 'incompatible action protocol version')
        return
      }
      const kind = bytes[1]! & 15
      const format = bytes[1]! >>> 4
      const view = viewOf(bytes)
      if (
        kind > cancelled ||
        format > binaryFormat ||
        (kind > offer && format !== textFormat)
      ) {
        failPeer(peerId, invalidFrameMsg)
        return
      }
      if (kind >= chunk) {
        if (
          bytes.length < controlHeaderSize ||
          ((kind === accepted || kind === cancelled) &&
            bytes.length !== controlHeaderSize) ||
          (kind === rejected && bytes.length > controlHeaderSize + 200)
        ) {
          failPeer(peerId, invalidActionMsg('control'))
          return
        }
        const id = view.getUint32(2)
        if (kind === accepted) {
          const transfers = outgoing.get(peerId)
          if (transfers?.get(id)?.[0]()) {
            transfers.forEach(p => p[2]())
          }
          return
        }
        if (kind === rejected) {
          outgoing
            .get(peerId)
            ?.get(id)?.[1](
              makeActionError(
                'rejected',
                decodeBytes(bytes.subarray(controlHeaderSize))
              ),
              true
            )
          return
        }
        if (kind === cancelled) {
          const state = peers.get(peerId)?.b.get(id)
          if (state) {
            release(state)
            state.s?.[3]('response cancelled by sender')
          }
          drain()
        } else {
          const offset =
            bytes.length >= chunkHeaderSize
              ? view.getFloat64(controlHeaderSize)
              : NaN
          const chunkData = bytes.subarray(chunkHeaderSize)
          const peer = peers.get(peerId)
          const state = peer?.b.get(id)
          if (!state) {
            return
          }
          const totalSize = state.m[3]
          if (
            state.w !== 1 ||
            offset !== state.o ||
            !chunkData.length ||
            chunkData.length !== Math.min(chunkSize, totalSize - state.o)
          ) {
            failPeer(peerId, invalidActionMsg('chunk'))
            return
          }
          try {
            state.d ??= new Uint8Array(totalSize)
          } catch {
            rejectRx(state, 'unable to allocate receive buffer')
            drain()
            return
          }
          state.d.set(chunkData, state.o)
          state.o += chunkData.length
          const now = Date.now()
          state.l = now
          for (const queued of waiting) {
            if (queued.p === phaseReady && rxActions.get(queued.m[1])?.r) {
              queued.l = now
            }
          }
          if (state.o === totalSize) {
            tryBulk(state)
            if (current(state) && peer?.a === state) {
              peer.a = null
              rotateWaitingForPeer(peerId)
            }
            drain()
          } else {
            emitRxProgress(
              rxActions.get(state.m[1])!,
              state.o / totalSize,
              peerId,
              state.m[4]
            )
          }
        }
        return
      }
      const headerSize = kind === inline ? inlineHeaderSize : offerHeaderSize
      if (bytes.length < headerSize) {
        failPeer(peerId, invalidActionMsg('header'))
        return
      }
      const type = decodeActionType(bytes)
      const action = actions.get(type)
      if (!canReceiveFromPeer(peerId, Boolean(action?.[1]))) {
        return
      }
      const metaLength = view.getUint16(34)
      const payloadIndex = headerSize + metaLength
      const size =
        kind === inline ? bytes.length - payloadIndex : view.getFloat64(40)
      const id = kind === offer ? view.getUint32(36) : 0
      if (
        !type ||
        payloadIndex > bytes.length ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        (kind === offer && (size === 0 || payloadIndex !== bytes.length))
      ) {
        failPeer(peerId, invalidActionMsg('proposal'))
        return
      }
      let metadata: JsonValue | undefined
      try {
        if (metaLength) {
          metadata = fromJson<JsonValue>(
            decodeBytes(bytes.subarray(headerSize, payloadIndex))
          )
        }
      } catch {
        failPeer(peerId, invalidActionMsg('metadata'))
        return
      }
      const message = [peerId, type, format, size, metadata] as const
      if (kind === inline) {
        const dataSlice = bytes.subarray(payloadIndex)
        const resolved = resolveAdmission(message)
        if (!resolved) {
          return
        }
        const [rxAct, scope] = resolved
        const key = scope ? `${type}\0${scope[0]}` : type
        if (
          rxAct?.r &&
          !(scope ? scope[2] : rxAct.g) &&
          !peers.get(peerId)?.n.has(key)
        ) {
          let payload: DataPayload
          try {
            payload = decodePayload(dataSlice, format, true)
          } catch {
            failPeer(peerId, invalidPayloadMsg)
            return
          }
          deliverPayload(rxAct, payload, peerId, metadata)
          return
        }
        const state: Inline = {
          ...admission(message, scope),
          k: 0,
          y: key,
          d: dataSlice
        }
        if (enqueue(state)) {
          drainInline(peerId, key)
        }
      } else {
        if (peers.get(peerId)?.b.has(id)) {
          failPeer(peerId, 'duplicate action offer')
          return
        }
        const resolved = resolveAdmission(message, id)
        if (!resolved) {
          return
        }
        const state: Bulk = {
          ...admission(message, resolved[1]),
          k: 1,
          i: id,
          w: 0,
          o: 0,
          d: null
        }
        if (enqueue(state)) {
          drain()
        }
      }
    },

    clearPeer
  ]
}

export const createActionWireManager = ({
  getTransport,
  getPeer,
  getPeerIds,
  canReceiveFromPeer,
  onPeerError,
  broadcastInline,
  throwIfAborted: checkAborted = throwIfAborted,
  maxReceiveBytes = defaultMaxReceiveBytes
}: {
  onPeerError: (peerId: string, error: Error) => void
  getTransport?: (
    id: string,
    includePending: boolean
  ) => PeerDataTransport | undefined
  getPeer?: (id: string, includePending: boolean) => PeerHandle | undefined
  getPeerIds: (includePending: boolean) => string[]
  canReceiveFromPeer: (id: string, receiveWhilePending: boolean) => boolean
  broadcastInline?: (
    frame: Uint8Array,
    onProgress?: (peerId: string) => void,
    signal?: AbortSignal
  ) => Promise<boolean> | boolean
  throwIfAborted?: (signal?: AbortSignal) => void
  maxReceiveBytes?: number
}): {
  makeInternalAction: <T extends DataPayload = DataPayload>(
    type: string,
    options?: Partial<ActionOptions>
  ) => InternalAction<T>
  handleData: (id: string, data: ArrayBuffer) => void
  clearPeer: (id: string) => void
} => {
  const [makeInternalAction, handleData, clearPeer] = initActionWireManager(
    getPeerIds,
    canReceiveFromPeer,
    onPeerError,
    toPeerTransportGetter(getTransport, getPeer),
    broadcastInline,
    checkAborted,
    maxReceiveBytes
  )
  return {makeInternalAction, handleData, clearPeer}
}

export const inspectActionWireHeader = (
  frame: Uint8Array
): {type: string; metadata?: JsonValue} | null => {
  if (frame.byteLength < inlineHeaderSize || frame[0] !== version) {
    return null
  }
  const kind = frame[1]! & 15
  if (kind !== inline && kind !== offer) {
    return null
  }
  const headerLen = kind === inline ? inlineHeaderSize : offerHeaderSize
  if (frame.byteLength < headerLen) {
    return null
  }
  const type = decodeActionType(frame)
  if (!type) {
    return null
  }
  const metaLen = viewOf(frame).getUint16(34)
  if (metaLen > 0 && headerLen + metaLen <= frame.byteLength) {
    try {
      const metadata = fromJson<JsonValue>(
        decodeBytes(frame.subarray(headerLen, headerLen + metaLen))
      )
      return {type, metadata}
    } catch {
      return {type}
    }
  }
  return {type}
}
