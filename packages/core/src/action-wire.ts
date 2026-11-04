import {
  maxActionFrameBytes as maxFrameBytes,
  pendingDataTimeoutMs,
  transferTimeoutMs
} from './data-limits'
import type {TargetPeers} from './internal-types'
import type {PeerDataTransport} from './peer-transport'
import type {
  ActionError,
  ActionErrorKind,
  ActionReceiveContext,
  DataPayload,
  JsonValue
} from './types'
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
  mkViolationErr,
  noActivePeerMsg,
  noOp,
  operationAbortedMsg,
  peerDisconnectedMsg,
  posSafeIntErr,
  resetTimer,
  toJson,
  toPayloadSource,
  unrefTimer,
  warn
} from './utils'

export const actionWireVersion = 3
const inlineKind = 0
const offerKind = 1
const chunkKind = 2
const acceptedKind = 3
const rejectedKind = 4
const cancelledKind = 5

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
const maxPreListenerMessages = 32
const emptyBytes = new Uint8Array()
const sizeLimitMsg = 'payload exceeds receiver size limit'
const invalidPayloadMsg = invalidActionMsg('payload')

const textFormat = 0
const jsonFormat = 1
const binaryFormat = 2

const phasePending = 0
const phaseDeciding = 1
const phaseReady = 2
const phaseReleased = 3

type WireReceiveContext = Omit<
  ActionReceiveContext,
  'kind' | 'userId' | 'roles'
>

type WireReceiveHandler = (
  context: WireReceiveContext
) => boolean | Promise<boolean>

type ReceiveScope = readonly [
  key: string,
  signal: AbortSignal,
  receive: WireReceiveHandler | null,
  reject: (reason: string) => void
]

type ReceiveScopeResolver = (
  peerId: string,
  metadata?: JsonValue
) => ReceiveScope | null

type WireRejectHandler = (
  peerId: string,
  metadata: JsonValue | undefined,
  reason: string
) => void

export type WireActionOptions = {
  sendToPending?: boolean
  receiveWhilePending?: boolean
  maxPayloadBytes?: number
  receiveScope?: ReceiveScopeResolver
}

export type WireAction<T = DataPayload> = {
  send: (
    data: T,
    targets?: TargetPeers,
    metadata?: JsonValue,
    progress?: (percent: number, peerId: string, metadata?: JsonValue) => void,
    signal?: AbortSignal
  ) => Promise<void>
  onMessage: (
    receiver: ((data: T, peerId: string, metadata?: JsonValue) => void) | null
  ) => void
  onProgress: (
    handler: (percent: number, peerId: string, metadata?: JsonValue) => void
  ) => void
  onReceive: (handler: WireReceiveHandler | null) => void
  onReject: (handler: WireRejectHandler) => void
}

type ReceiveRegistration = {
  maxPayloadBytes?: number
  receiveScope?: ReceiveScopeResolver
  receiver:
    | ((data: DataPayload, peerId: string, metadata?: JsonValue) => void)
    | null
  onProgress: (percent: number, peerId: string, metadata?: JsonValue) => void
  receiveGate: WireReceiveHandler | null
  onReject: WireRejectHandler | null
}

type RegisteredWireAction = {
  sendToPending: boolean
  receiveWhilePending: boolean
  maxPayloadBytes: number | undefined
  receiveScope: ReceiveScopeResolver | undefined
  action: WireAction
}

type IncomingMessageMeta = {
  peerId: string
  type: string
  format: number
  size: number
  metadata: JsonValue | undefined
}

type AdmissionBase = {
  message: IncomingMessageMeta
  scope?: ReceiveScope
  unbindAbort?: () => void
  phase: 0 | 1 | 2 | 3
  controller: AbortController | null
  lastSeenAt: number
  timer: ReturnType<typeof setTimeout> | null
}

type IncomingInline = AdmissionBase & {
  kind: 'inline'
  queueKey: string
  data: Uint8Array
}

type IncomingBulk = AdmissionBase & {
  kind: 'bulk'
  transferId: number
  accepted: boolean
  data: Uint8Array | null
  seenChunks: Uint8Array | null
  offset: number
}

type IncomingTransfer = IncomingInline | IncomingBulk

type PeerIncomingState = {
  bulkTransfers: Map<number, IncomingBulk>
  inlineQueues: Map<string, IncomingInline[]>
  activeBulk: IncomingBulk | null
  pendingCount: number
}

type PreListenerEntry = {
  message: IncomingMessageMeta
  data: Uint8Array
  receivedAt: number
  admitted: boolean
}

type OutgoingTransfer = {
  accept: () => boolean
  fail: (error: Error, fromReceiver?: boolean) => void
  touch: () => void
}

export const makeActionError = (
  kind: ActionErrorKind,
  message: string
): ActionError => {
  const error = Object.assign(mkErr(message), {kind})
  if (kind === 'aborted') {
    error.name = 'AbortError'
  }
  return error
}

export const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw makeActionError('aborted', operationAbortedMsg)
  }
}

const viewOf = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

const buildControlPacket = (
  kind: number,
  id: number,
  size = controlHeaderSize
): Uint8Array => {
  const bytes = new Uint8Array(size)
  bytes[0] = actionWireVersion
  bytes[1] = kind
  viewOf(bytes).setUint32(2, id)
  return bytes
}

const startIdleTimer = (
  getLast: () => number,
  onTimeout: () => void,
  setTimer: (timer: ReturnType<typeof setTimeout>) => void
): void => {
  const tick = (): void => {
    const remaining = transferTimeoutMs - (Date.now() - getLast())
    if (remaining > 0) {
      const next = setTimeout(tick, remaining)
      unrefTimer(next)
      setTimer(next)
    } else {
      onTimeout()
    }
  }
  const initial = setTimeout(tick, transferTimeoutMs)
  unrefTimer(initial)
  setTimer(initial)
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
  registration: ReceiveRegistration,
  value: number,
  peerId: string,
  metadata?: JsonValue
): void => {
  try {
    registration.onProgress(value, peerId, metadata)
  } catch (error) {
    logErr('progress handler', error)
  }
}

const deliverPayload = (
  registration: ReceiveRegistration,
  data: DataPayload,
  peerId: string,
  metadata?: JsonValue
): void => {
  emitRxProgress(registration, 1, peerId, metadata)
  try {
    registration.receiver?.(data, peerId, metadata)
  } catch (error) {
    logActionHandlerErr(error)
  }
}

export type ActionWireManagerDeps = {
  onPeerError: (peerId: string, error: Error) => void
  resolveTransport: (
    id: string,
    includePending: boolean
  ) => PeerDataTransport | undefined
  getPeerIds: (includePending: boolean) => string[]
  canReceiveFromPeer: (id: string, receiveWhilePending: boolean) => boolean
  broadcastInline?: (
    frame: Uint8Array,
    onProgress?: (peerId: string) => void,
    signal?: AbortSignal
  ) => Promise<boolean> | boolean
  checkAborted?: (signal?: AbortSignal) => void
  onUnknownType?: (type: string) => void
  maxReceiveBytes?: number
}

export const createActionWireManager = ({
  resolveTransport,
  getPeerIds,
  canReceiveFromPeer,
  onPeerError,
  broadcastInline,
  checkAborted = throwIfAborted,
  onUnknownType,
  maxReceiveBytes = defaultMaxReceiveBytes
}: ActionWireManagerDeps): {
  makeWireAction: <T = DataPayload>(
    type: string,
    options?: WireActionOptions
  ) => WireAction<T>
  handleData: (id: string, data: ArrayBuffer) => void
  clearPeer: (id: string) => void
} => {
  if (!Number.isSafeInteger(maxReceiveBytes) || maxReceiveBytes <= 0) {
    throw posSafeIntErr('maxReceiveBytes')
  }

  const actions = new Map<string, RegisteredWireAction>()
  const rxActions = new Map<string, ReceiveRegistration>()
  const outgoing = new Map<string, Map<number, OutgoingTransfer>>()
  const peers = new Map<string, PeerIncomingState>()
  const preListenerQueues = new Map<string, Map<string, PreListenerEntry[]>>()
  const waitingBulk = new Set<IncomingBulk>()
  const decisions = new Map<string, number>()
  const failedTransports = new WeakSet<PeerDataTransport>()

  let preListenerSweepTimer: ReturnType<typeof setTimeout> | null = null
  let nextTransferId = 0
  let pendingCount = 0
  let decisionCount = 0
  let reservedBytes = 0
  let draining = false
  let drainAgain = false

  const disconnectedTransferErr = (): ActionError =>
    makeActionError('disconnected', peerDisconnectedMsg)
  const invalidFrameMsg = invalidActionMsg('frame')
  const isCurrent = (state: IncomingTransfer): boolean =>
    state.phase !== phaseReleased
  const payloadLimit = (registration?: ReceiveRegistration): number =>
    Math.min(maxReceiveBytes, registration?.maxPayloadBytes ?? maxReceiveBytes)

  const failPeer = (
    peerId: string,
    reason: string,
    protocolViolation = true
  ): void => {
    const target = resolveTransport(peerId, true)
    if (target && !failedTransports.has(target)) {
      failedTransports.add(target)
      warn(`${reason}; disconnecting peer ${peerId}`)
      onPeerError(
        peerId,
        protocolViolation ? mkViolationErr(reason) : mkErr(reason)
      )
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
    const bytes = buildControlPacket(kind, id, controlHeaderSize + text.length)
    bytes.set(text, controlHeaderSize)
    try {
      if (target.bufferedAmount > maxControlBufferedBytes) {
        throw mkErr('control send buffer is full')
      }
      target.sendFrame(bytes, id)
    } catch {
      failPeer(peerId, 'unable to send action control', false)
    }
  }

  const sendControl = (
    peerId: string,
    id: number,
    kind: number,
    reason = ''
  ): void => {
    sendControlFrame(peerId, resolveTransport(peerId, true), id, kind, reason)
  }

  const notifyRejected = (
    message: IncomingMessageMeta,
    reason: string,
    scope?: ReceiveScope,
    bulkId?: number
  ): void => {
    scope?.[3](reason)
    rxActions
      .get(message.type)
      ?.onReject?.(message.peerId, message.metadata, reason)
    if (bulkId !== undefined) {
      sendControl(message.peerId, bulkId, rejectedKind, reason)
    }
  }

  const rotateWaitingForPeer = (peerId: string): void => {
    for (const queued of Array.from(waitingBulk)) {
      if (queued.message.peerId === peerId) {
        waitingBulk.delete(queued)
        waitingBulk.add(queued)
      }
    }
  }

  const release = (state: IncomingTransfer): void => {
    if (!isCurrent(state)) {
      return
    }
    state.phase = phaseReleased
    state.unbindAbort?.()
    state.timer = resetTimer(state.timer)
    const {peerId} = state.message
    const peer = peers.get(peerId)
    if (peer) {
      if (state.kind === 'inline') {
        const queue = peer.inlineQueues.get(state.queueKey)
        if (queue) {
          const idx = queue.indexOf(state)
          if (idx >= 0) {
            queue.splice(idx, 1)
          }
          if (!queue.length) {
            peer.inlineQueues.delete(state.queueKey)
          }
        }
        state.data = emptyBytes
      } else {
        peer.bulkTransfers.delete(state.transferId)
        waitingBulk.delete(state)
        state.data = null
        state.seenChunks = null
        if (state.accepted) {
          reservedBytes -= state.message.size
          if (peer.activeBulk === state) {
            peer.activeBulk = null
            rotateWaitingForPeer(peerId)
          }
          drainAgain = true
        }
      }
      peer.pendingCount--
      pendingCount--
      if (!peer.pendingCount) {
        peers.delete(peerId)
      }
    }
    state.controller?.abort()
  }

  const rejectRx = (state: IncomingTransfer, reason: string): void => {
    if (!isCurrent(state)) {
      return
    }
    release(state)
    notifyRejected(
      state.message,
      reason,
      state.scope,
      state.kind === 'bulk' ? state.transferId : undefined
    )
  }

  const admit = (
    state: IncomingTransfer,
    registration: ReceiveRegistration
  ): boolean => {
    if (state.phase !== phasePending) {
      return state.phase === phaseReady
    }
    if (state.message.size > payloadLimit(registration)) {
      rejectRx(state, sizeLimitMsg)
      return false
    }
    const receive = state.scope ? state.scope[2] : registration.receiveGate
    if (!receive) {
      if (!registration.receiver) {
        return false
      }
      state.phase = phaseReady
      return true
    }
    const {peerId} = state.message
    if (
      decisionCount >= maxDecisions ||
      (decisions.get(peerId) ?? 0) >= maxDecisionsPerPeer
    ) {
      rejectRx(state, 'too many pending receive decisions')
      return false
    }
    state.phase = phaseDeciding
    const controller = new AbortController()
    state.controller = controller
    decisionCount++
    decisions.set(peerId, (decisions.get(peerId) ?? 0) + 1)
    const result = decideReceive(
      () =>
        receive({
          byteLength: state.message.size,
          peerId,
          signal: controller.signal,
          ...(state.message.metadata === undefined
            ? {}
            : {metadata: state.message.metadata})
        }),
      allow => {
        decisionCount--
        const count = (decisions.get(peerId) ?? 1) - 1
        if (count > 0) {
          decisions.set(peerId, count)
        } else {
          decisions.delete(peerId)
        }
        if (!isCurrent(state)) {
          return false
        }
        if (allow) {
          state.phase = phaseReady
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
    state: IncomingTransfer,
    registration: ReceiveRegistration,
    bytes: Uint8Array,
    copyBinary: boolean
  ): void => {
    let payload: DataPayload
    try {
      payload = decodePayload(bytes, state.message.format, copyBinary)
    } catch {
      release(state)
      failPeer(state.message.peerId, invalidPayloadMsg)
      return
    }
    release(state)
    deliverPayload(
      registration,
      payload,
      state.message.peerId,
      state.message.metadata
    )
  }

  const tryInline = (state: IncomingInline): void => {
    const registration = rxActions.get(state.message.type)
    if (!isCurrent(state) || !registration || !admit(state, registration)) {
      return
    }
    if (registration.receiver) {
      complete(state, registration, state.data, true)
    } else if (!state.scope) {
      const {data, lastSeenAt, message} = state
      release(state)
      bufferPreListenerInline(message, data, true, true, lastSeenAt)
    }
  }

  const tryBulk = (state: IncomingBulk): void => {
    const registration = rxActions.get(state.message.type)
    if (
      !isCurrent(state) ||
      !registration ||
      !admit(state, registration) ||
      !registration.receiver
    ) {
      return
    }
    if (state.accepted) {
      if (state.offset === state.message.size && state.data) {
        complete(state, registration, state.data, false)
      }
      return
    }
    const peer = peers.get(state.message.peerId)
    if (
      peer &&
      !peer.activeBulk &&
      reservedBytes + state.message.size <= maxReceiveBytes
    ) {
      peer.activeBulk = state
      state.accepted = true
      reservedBytes += state.message.size
      state.lastSeenAt = Date.now()
      waitingBulk.delete(state)
      sendControl(state.message.peerId, state.transferId, acceptedKind)
    }
  }

  const drainInline = (peerId: string, queueKey: string): void => {
    const queue = peers.get(peerId)?.inlineQueues.get(queueKey)
    while (queue?.[0]) {
      const state = queue[0]
      tryInline(state)
      if (isCurrent(state)) {
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
        for (const state of waitingBulk) {
          tryBulk(state)
        }
        for (const [id, peer] of peers) {
          for (const state of peer.bulkTransfers.values()) {
            if (state.offset === state.message.size) {
              tryBulk(state)
            }
          }
          for (const key of peer.inlineQueues.keys()) {
            drainInline(id, key)
          }
        }
      } while (drainAgain)
    } finally {
      draining = false
    }
  }

  const sweepPreListenerQueues = (): void => {
    preListenerSweepTimer = resetTimer(preListenerSweepTimer)
    const now = Date.now()
    let hasRemaining = false
    for (const [peerId, byType] of preListenerQueues) {
      for (const [type, ring] of byType) {
        while (
          ring.length > 0 &&
          now - ring[0]!.receivedAt > pendingDataTimeoutMs
        ) {
          ring.shift()
        }
        if (ring.length === 0) {
          byType.delete(type)
        } else {
          hasRemaining = true
        }
      }
      if (byType.size === 0) {
        preListenerQueues.delete(peerId)
      }
    }
    if (hasRemaining) {
      preListenerSweepTimer = setTimeout(
        sweepPreListenerQueues,
        pendingDataTimeoutMs
      )
      unrefTimer(preListenerSweepTimer)
    }
  }

  const bufferPreListenerInline = (
    message: IncomingMessageMeta,
    dataSlice: Uint8Array,
    admitted = false,
    alreadyOwned = false,
    receivedAt = Date.now()
  ): void => {
    const now = Date.now()
    let byType = preListenerQueues.get(message.peerId)
    if (!byType) {
      byType = new Map()
      preListenerQueues.set(message.peerId, byType)
    }
    let ring = byType.get(message.type)
    if (!ring) {
      ring = []
      byType.set(message.type, ring)
    }
    while (
      ring.length > 0 &&
      now - ring[0]!.receivedAt > pendingDataTimeoutMs
    ) {
      ring.shift()
    }
    if (ring.length >= maxPreListenerMessages) {
      ring.shift()
    }
    ring.push({
      message,
      data: alreadyOwned ? dataSlice : dataSlice.slice(),
      receivedAt,
      admitted
    })
    if (!preListenerSweepTimer) {
      preListenerSweepTimer = setTimeout(
        sweepPreListenerQueues,
        pendingDataTimeoutMs
      )
      unrefTimer(preListenerSweepTimer)
    }
  }

  const createAdmissionBase = (
    message: IncomingMessageMeta,
    scope?: ReceiveScope
  ): AdmissionBase => ({
    message,
    ...(scope ? {scope} : {}),
    phase: phasePending,
    controller: null,
    lastSeenAt: Date.now(),
    timer: null
  })

  const ensureIdleTimer = (state: IncomingTransfer): void => {
    if (!isCurrent(state) || state.timer) {
      return
    }
    startIdleTimer(
      () => state.lastSeenAt,
      () => {
        rejectRx(state, 'action transfer timed out')
        drain()
      },
      timer => {
        state.timer = timer
      }
    )
  }

  const enqueueTransfer = (
    state: IncomingTransfer,
    deferTimer = false
  ): boolean => {
    const {peerId} = state.message
    let peer = peers.get(peerId)
    if (
      pendingCount >= maxPendingTransfers ||
      (peer?.pendingCount ?? 0) >= maxPendingPerPeer
    ) {
      notifyRejected(
        state.message,
        'too many pending transfers',
        state.scope,
        state.kind === 'bulk' ? state.transferId : undefined
      )
      return false
    }
    if (!peer) {
      peer = {
        bulkTransfers: new Map(),
        inlineQueues: new Map(),
        activeBulk: null,
        pendingCount: 0
      }
      peers.set(peerId, peer)
    }
    peer.pendingCount++
    pendingCount++
    if (state.kind === 'inline') {
      const queue = peer.inlineQueues.get(state.queueKey) ?? []
      queue.push(state)
      peer.inlineQueues.set(state.queueKey, queue)
    } else {
      peer.bulkTransfers.set(state.transferId, state)
      waitingBulk.add(state)
    }
    if (!deferTimer) {
      ensureIdleTimer(state)
    }
    if (state.scope) {
      const sig = state.scope[1]
      const cancel = (): void => {
        rejectRx(state, 'receive cancelled')
        drain()
      }
      sig.addEventListener('abort', cancel, {once: true})
      state.unbindAbort = () => sig.removeEventListener('abort', cancel)
      if (sig.aborted) {
        cancel()
        return false
      }
    }
    return true
  }

  const flushPreListenerType = (
    type: string,
    registration: ReceiveRegistration
  ): void => {
    const isFlushable = (): boolean =>
      Boolean(registration.receiver || registration.receiveGate)
    if (!isFlushable()) {
      return
    }
    const now = Date.now()
    for (const [peerId, byType] of Array.from(preListenerQueues)) {
      if (!isFlushable()) {
        break
      }
      const ring = byType.get(type)
      if (!ring) {
        continue
      }
      byType.delete(type)
      if (byType.size === 0) {
        preListenerQueues.delete(peerId)
      }
      for (let i = 0; i < ring.length; i++) {
        if (!isFlushable()) {
          const rest = ring.slice(i)
          if (rest.length > 0) {
            let curByType = preListenerQueues.get(peerId)
            if (!curByType) {
              curByType = new Map()
              preListenerQueues.set(peerId, curByType)
            }
            const existing = curByType.get(type)
            curByType.set(type, existing ? [...existing, ...rest] : rest)
          }
          break
        }
        const entry = ring[i]!
        if (now - entry.receivedAt > pendingDataTimeoutMs) {
          continue
        }
        if (entry.message.size > payloadLimit(registration)) {
          notifyRejected(entry.message, sizeLimitMsg)
          continue
        }
        if (entry.admitted && !registration.receiver) {
          bufferPreListenerInline(
            entry.message,
            entry.data,
            true,
            true,
            entry.receivedAt
          )
          continue
        }
        if (
          registration.receiver &&
          (entry.admitted ||
            (!registration.receiveGate &&
              !peers.get(peerId)?.inlineQueues.has(type)))
        ) {
          let payload: DataPayload
          try {
            payload = decodePayload(entry.data, entry.message.format, false)
          } catch {
            failPeer(peerId, invalidPayloadMsg)
            break
          }
          deliverPayload(registration, payload, peerId, entry.message.metadata)
        } else {
          const state: IncomingInline = {
            ...createAdmissionBase(entry.message),
            kind: 'inline',
            queueKey: type,
            data: entry.data
          }
          if (enqueueTransfer(state, true)) {
            drainInline(peerId, type)
            ensureIdleTimer(state)
          }
        }
      }
    }
  }

  const resolveAdmission = (
    message: IncomingMessageMeta,
    bulkId?: number
  ):
    | [registration: ReceiveRegistration, scope: ReceiveScope | undefined]
    | null => {
    const registration = rxActions.get(message.type)
    if (!registration) {
      if (bulkId !== undefined) {
        sendControl(message.peerId, bulkId, rejectedKind, 'unregistered action')
      }
      return null
    }
    const scope = registration.receiveScope?.(message.peerId, message.metadata)
    if (scope === null || scope?.[1].aborted) {
      if (bulkId !== undefined) {
        sendControl(message.peerId, bulkId, rejectedKind, 'unexpected response')
      }
      return null
    }
    if (message.size > payloadLimit(registration)) {
      notifyRejected(message, sizeLimitMsg, scope, bulkId)
      return null
    }
    return [registration, scope]
  }

  const clearPeer = (peerId: string): void => {
    for (const transfer of outgoing.get(peerId)?.values() ?? []) {
      transfer.fail(disconnectedTransferErr())
    }
    outgoing.delete(peerId)
    preListenerQueues.delete(peerId)
    const peer = peers.get(peerId)
    if (peer) {
      for (const state of peer.bulkTransfers.values()) {
        release(state)
      }
      for (const queue of peer.inlineQueues.values()) {
        queue.slice().forEach(release)
      }
    }
    drain()
  }

  const sendFrameToTransport = async (
    transport: PeerDataTransport,
    bytes: Uint8Array,
    check: () => void,
    signal: AbortSignal | undefined,
    transferId?: number,
    isOffer?: boolean
  ): Promise<void> => {
    check()
    const drainRes = transport.waitForDrain(signal)
    if (drainRes !== true) {
      if (!(await drainRes)) {
        checkAborted(signal)
        throw makeActionError('disconnected', 'data channel stopped draining')
      }
      check()
    }
    try {
      transport.sendFrame(bytes, transferId, isOffer)
    } catch {
      throw disconnectedTransferErr()
    }
  }

  const sendBulkToPeer = async (
    peerId: string,
    transport: PeerDataTransport,
    offerFrame: Uint8Array,
    transferId: number,
    source: Uint8Array | Blob,
    size: number,
    metadata: JsonValue | undefined,
    progressCb:
      | ((percent: number, peerId: string, metadata?: JsonValue) => void)
      | undefined,
    signal: AbortSignal | undefined
  ): Promise<void> => {
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
      outgoing.get(peerId) ?? new Map<number, OutgoingTransfer>()
    if (transfers.has(transferId)) {
      throw mkErr('action transfer id in use')
    }
    outgoing.set(peerId, transfers)

    let timer: ReturnType<typeof setTimeout> | null = null
    const transferState: OutgoingTransfer = {
      accept: () => {
        if (!timer || failure) {
          return false
        }
        timer = resetTimer(timer)
        acceptOffer()
        return true
      },
      fail: (error, fromReceiver = false) => {
        if (fromReceiver) {
          settledByReceiver = true
        }
        failure = error
        rejectOffer(error)
      },
      touch: () => {
        if (timer) {
          lastSeen = Date.now()
        }
      }
    }
    transfers.set(transferId, transferState)
    startIdleTimer(
      () => lastSeen,
      () =>
        transferState.fail(
          makeActionError('timeout', 'action offer timed out')
        ),
      nextTimer => {
        timer = nextTimer
      }
    )

    const onAbort = (): void => {
      try {
        checkAborted(signal)
      } catch (error) {
        transferState.fail(error as Error)
      }
    }
    signal?.addEventListener('abort', onAbort, {once: true})

    try {
      await sendFrameToTransport(
        transport,
        offerFrame,
        check,
        signal,
        transferId,
        true
      )
      didSendOffer = true
      await permission
      for (let offset = 0; offset < size; offset += chunkSize) {
        check()
        const length = Math.min(chunkSize, size - offset)
        const bytes = buildControlPacket(
          chunkKind,
          transferId,
          chunkHeaderSize + length
        )
        viewOf(bytes).setFloat64(controlHeaderSize, offset)
        bytes.set(
          source instanceof Uint8Array
            ? source.subarray(offset, offset + length)
            : new Uint8Array(
                await source.slice(offset, offset + length).arrayBuffer()
              ),
          chunkHeaderSize
        )
        await sendFrameToTransport(transport, bytes, check, signal, transferId)
        transfers.forEach(t => t.touch())
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
        sendControlFrame(peerId, transport, transferId, cancelledKind)
      }
      throw error
    } finally {
      timer = resetTimer(timer)
      signal?.removeEventListener('abort', onAbort)
      transfers.delete(transferId)
      if (!transfers.size && outgoing.get(peerId) === transfers) {
        outgoing.delete(peerId)
      }
    }
  }

  const handleControlOrChunk = (
    peerId: string,
    bytes: Uint8Array,
    kind: number,
    view: DataView
  ): void => {
    if (
      bytes.length < controlHeaderSize ||
      ((kind === acceptedKind || kind === cancelledKind) &&
        bytes.length !== controlHeaderSize) ||
      (kind === rejectedKind && bytes.length > controlHeaderSize + 200)
    ) {
      failPeer(peerId, invalidActionMsg('control'))
      return
    }
    const id = view.getUint32(2)
    if (kind === acceptedKind) {
      const transfers = outgoing.get(peerId)
      if (transfers?.get(id)?.accept()) {
        transfers.forEach(t => t.touch())
      }
      return
    }
    if (kind === rejectedKind) {
      outgoing
        .get(peerId)
        ?.get(id)
        ?.fail(
          makeActionError(
            'rejected',
            decodeBytes(bytes.subarray(controlHeaderSize))
          ),
          true
        )
      return
    }
    if (kind === cancelledKind) {
      const state = peers.get(peerId)?.bulkTransfers.get(id)
      if (state) {
        release(state)
        state.scope?.[3]('response cancelled by sender')
      }
      drain()
      return
    }

    const offset =
      bytes.length >= chunkHeaderSize ? view.getFloat64(controlHeaderSize) : NaN
    const chunkData = bytes.subarray(chunkHeaderSize)
    const peer = peers.get(peerId)
    const state = peer?.bulkTransfers.get(id)
    if (!state) {
      return
    }
    const totalSize = state.message.size
    if (
      !state.accepted ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset >= totalSize ||
      offset % chunkSize !== 0 ||
      !chunkData.length ||
      chunkData.length !== Math.min(chunkSize, totalSize - offset)
    ) {
      failPeer(peerId, invalidActionMsg('chunk'))
      return
    }
    const chunkIdx = offset / chunkSize
    const byteIdx = chunkIdx >>> 3
    const bitMask = 1 << (chunkIdx & 7)
    try {
      state.data ??= new Uint8Array(totalSize)
      state.seenChunks ??= new Uint8Array(
        Math.ceil(Math.ceil(totalSize / chunkSize) / 8)
      )
    } catch {
      rejectRx(state, 'unable to allocate receive buffer')
      drain()
      return
    }
    if ((state.seenChunks[byteIdx]! & bitMask) !== 0) {
      failPeer(peerId, invalidActionMsg('chunk'))
      return
    }
    state.seenChunks[byteIdx]! |= bitMask
    state.data.set(chunkData, offset)
    state.offset += chunkData.length
    const now = Date.now()
    state.lastSeenAt = now
    for (const queued of waitingBulk) {
      if (
        queued.phase === phaseReady &&
        rxActions.get(queued.message.type)?.receiver
      ) {
        queued.lastSeenAt = now
      }
    }
    if (state.offset === totalSize) {
      tryBulk(state)
      if (isCurrent(state) && peer?.activeBulk === state) {
        peer.activeBulk = null
        rotateWaitingForPeer(peerId)
      }
      drain()
    } else {
      const registration = rxActions.get(state.message.type)
      if (registration) {
        emitRxProgress(
          registration,
          state.offset / totalSize,
          peerId,
          state.message.metadata
        )
      }
    }
  }

  const makeWireAction = <T = DataPayload>(
    type: string,
    options: WireActionOptions = {}
  ): WireAction<T> => {
    const sendToPending = Boolean(options.sendToPending)
    const receiveWhilePending = Boolean(options.receiveWhilePending)
    const {maxPayloadBytes, receiveScope} = options
    const cached = actions.get(type)
    if (cached) {
      if (
        cached.sendToPending !== sendToPending ||
        cached.receiveWhilePending !== receiveWhilePending ||
        cached.maxPayloadBytes !== maxPayloadBytes ||
        cached.receiveScope !== receiveScope
      ) {
        throw actionRedefinedErr(type)
      }
      return cached.action as unknown as WireAction<T>
    }

    const typeBytes = encodeBytes(type)
    if (!type || type.includes('\0') || typeBytes.length > 32) {
      throw mkErr('action type must be 1–32 non-null UTF-8 bytes')
    }

    const registration: ReceiveRegistration = {
      ...(maxPayloadBytes === undefined ? {} : {maxPayloadBytes}),
      ...(receiveScope ? {receiveScope} : {}),
      receiver: null,
      receiveGate: null,
      onReject: null,
      onProgress: noOp
    }
    rxActions.set(type, registration)

    const actionObj: WireAction = {
      onMessage: handler => {
        registration.receiver = handler as ReceiveRegistration['receiver']
        flushPreListenerType(type, registration)
        drain()
      },
      onReceive: handler => {
        registration.receiveGate = handler
        if (handler) {
          flushPreListenerType(type, registration)
        }
        drain()
      },
      onReject: handler => {
        registration.onReject = handler
      },
      onProgress: handler => {
        registration.onProgress = handler
      },
      send: async (data, targets, metadata, progressCb, signal) => {
        checkAborted(signal)
        if (data === undefined) {
          throw mkErr('action data cannot be undefined')
        }
        const [format, source] = toPayloadSource(data)
        const size =
          source instanceof Uint8Array ? source.byteLength : source.size
        const metaBytes =
          metadata === undefined ? emptyBytes : encodeBytes(toJson(metadata))
        if (metaBytes.length > maxFrameBytes - offerHeaderSize) {
          throw mkErr('action metadata is too large')
        }

        const isSmall =
          inlineHeaderSize + metaBytes.length + size <= maxFrameBytes
        const transferId = isSmall ? 0 : nextTransferId++ >>> 0
        const headerSize = isSmall ? inlineHeaderSize : offerHeaderSize
        const startFrame = new Uint8Array(
          headerSize + metaBytes.length + (isSmall ? size : 0)
        )
        startFrame[0] = actionWireVersion
        startFrame[1] = (isSmall ? inlineKind : offerKind) | (format << 4)
        startFrame.set(typeBytes, 2)
        const view = viewOf(startFrame)
        view.setUint16(34, metaBytes.length)
        if (!isSmall) {
          view.setUint32(36, transferId)
          view.setFloat64(40, size)
        }
        startFrame.set(metaBytes, headerSize)
        if (isSmall) {
          startFrame.set(
            source instanceof Uint8Array
              ? source
              : new Uint8Array(await source.arrayBuffer()),
            headerSize + metaBytes.length
          )
        }

        const isExplicitTarget = targets !== undefined && targets !== null
        if (!isExplicitTarget && isSmall && !sendToPending && broadcastInline) {
          const bcastResult = broadcastInline(
            startFrame,
            peerId => progressCb?.(1, peerId, metadata),
            signal
          )
          if (
            typeof bcastResult === 'boolean' ? bcastResult : await bcastResult
          ) {
            return
          }
        }

        const rawIds = isExplicitTarget
          ? [targets].flat()
          : getPeerIds(sendToPending)
        const uniqueIds = [...new Set(rawIds)]
        if (isExplicitTarget && uniqueIds.length === 0) {
          throw makeActionError(
            'disconnected',
            'target peer list must not be empty'
          )
        }

        const resolvedTargets: Array<
          [peerId: string, transport: PeerDataTransport]
        > = []
        for (const peerId of uniqueIds) {
          const transport = resolveTransport(peerId, sendToPending)
          if (!transport || !transport.isOpen) {
            if (isExplicitTarget) {
              throw makeActionError('disconnected', noActivePeerMsg(peerId))
            }
            continue
          }
          resolvedTargets.push([peerId, transport])
        }

        const pendingPromises: Promise<void>[] = []
        const pushPending = (p: Promise<void>): void => {
          void p.catch(noOp)
          pendingPromises.push(p)
        }
        for (const [peerId, transport] of resolvedTargets) {
          if (isSmall) {
            checkAborted(signal)
            const drainRes = transport.waitForDrain(signal)
            if (drainRes === true) {
              try {
                transport.sendFrame(startFrame)
              } catch {
                throw disconnectedTransferErr()
              }
              progressCb?.(1, peerId, metadata)
            } else {
              pushPending(
                (async () => {
                  await sendFrameToTransport(
                    transport,
                    startFrame,
                    () => {
                      checkAborted(signal)
                      if (!transport.isOpen) {
                        throw disconnectedTransferErr()
                      }
                    },
                    signal
                  )
                  progressCb?.(1, peerId, metadata)
                })()
              )
            }
          } else {
            pushPending(
              sendBulkToPeer(
                peerId,
                transport,
                startFrame,
                transferId,
                source,
                size,
                metadata,
                progressCb,
                signal
              )
            )
          }
        }

        if (pendingPromises.length > 0) {
          await all(pendingPromises)
        }
      }
    }

    actions.set(type, {
      sendToPending,
      receiveWhilePending,
      maxPayloadBytes,
      receiveScope,
      action: actionObj
    })
    return actionObj as unknown as WireAction<T>
  }

  const handleData = (peerId: string, data: ArrayBuffer): void => {
    if (data.byteLength < 2 || data.byteLength > maxFrameBytes) {
      failPeer(peerId, invalidFrameMsg)
      return
    }
    const bytes = new Uint8Array(data)
    if (bytes[0] !== actionWireVersion) {
      failPeer(peerId, 'incompatible action protocol version')
      return
    }
    const kind = bytes[1]! & 15
    const format = bytes[1]! >>> 4
    const view = viewOf(bytes)
    if (
      kind > cancelledKind ||
      format > binaryFormat ||
      (kind > offerKind && format !== textFormat)
    ) {
      failPeer(peerId, invalidFrameMsg)
      return
    }
    if (kind >= chunkKind) {
      handleControlOrChunk(peerId, bytes, kind, view)
      return
    }

    const headerSize = kind === inlineKind ? inlineHeaderSize : offerHeaderSize
    if (bytes.length < headerSize) {
      failPeer(peerId, invalidActionMsg('header'))
      return
    }
    const type = decodeActionType(bytes)
    let registered = actions.get(type)
    if (!registered && onUnknownType) {
      onUnknownType(type)
      registered = actions.get(type)
    }
    if (!canReceiveFromPeer(peerId, Boolean(registered?.receiveWhilePending))) {
      return
    }
    const metaLength = view.getUint16(34)
    const payloadIndex = headerSize + metaLength
    const size =
      kind === inlineKind ? bytes.length - payloadIndex : view.getFloat64(40)
    const transferId = kind === offerKind ? view.getUint32(36) : 0
    if (
      !type ||
      payloadIndex > bytes.length ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      (kind === offerKind && (size === 0 || payloadIndex !== bytes.length))
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

    const message: IncomingMessageMeta = {
      peerId,
      type,
      format,
      size,
      metadata
    }

    if (kind === inlineKind) {
      const dataSlice = bytes.subarray(payloadIndex)
      const resolved = resolveAdmission(message)
      if (!resolved) {
        return
      }
      const [registration, scope] = resolved
      const queueKey = scope ? `${type}\0${scope[0]}` : type
      const hasGate = Boolean(scope ? scope[2] : registration.receiveGate)

      if (
        registration.receiver &&
        !hasGate &&
        !peers.get(peerId)?.inlineQueues.has(queueKey)
      ) {
        let payload: DataPayload
        try {
          payload = decodePayload(dataSlice, format, true)
        } catch {
          failPeer(peerId, invalidPayloadMsg)
          return
        }
        deliverPayload(registration, payload, peerId, metadata)
        return
      }

      if (
        !registration.receiver &&
        !hasGate &&
        !peers.get(peerId)?.inlineQueues.has(queueKey)
      ) {
        bufferPreListenerInline(message, dataSlice)
        return
      }

      const state: IncomingInline = {
        ...createAdmissionBase(message, scope),
        kind: 'inline',
        queueKey,
        data: dataSlice.slice()
      }
      if (enqueueTransfer(state, true)) {
        drainInline(peerId, queueKey)
        ensureIdleTimer(state)
      }
      return
    }

    if (peers.get(peerId)?.bulkTransfers.has(transferId)) {
      failPeer(peerId, 'duplicate action offer')
      return
    }
    const resolved = resolveAdmission(message, transferId)
    if (!resolved) {
      return
    }
    const state: IncomingBulk = {
      ...createAdmissionBase(message, resolved[1]),
      kind: 'bulk',
      transferId,
      accepted: false,
      offset: 0,
      data: null,
      seenChunks: null
    }
    if (enqueueTransfer(state)) {
      drain()
    }
  }

  return {makeWireAction, handleData, clearPeer}
}

export const inspectActionWireHeader = (
  frame: Uint8Array
): {type: string; metadata?: JsonValue} | null => {
  if (frame.byteLength < inlineHeaderSize || frame[0] !== actionWireVersion) {
    return null
  }
  const kind = frame[1]! & 15
  if (kind !== inlineKind && kind !== offerKind) {
    return null
  }
  const headerLen = kind === inlineKind ? inlineHeaderSize : offerHeaderSize
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
