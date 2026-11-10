import {
  maxActionFrameBytes as maxFrameBytes,
  maxBulkFrameBytes,
  pendingDataTimeoutMs,
  transferTimeoutMs
} from './data-limits'
import type {TargetPeers, Timeout} from './internal-types'
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
  encodeBytesInto,
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
  unreachable,
  unrefTimer,
  utf8ByteLength,
  warn
} from './utils'

export const actionWireVersion = 3
const inlineKind = 0
const offerKind = 1
const chunkKind = 2
const acceptedKind = 3
const rejectedKind = 4
const cancelledKind = 5
const wideBulkFlag = 64

const inlineHeaderSize = 36 // version, kind/format, action name, metadata length
const offerHeaderSize = 48 // inline header, uint32 id, float64 byte length
const controlHeaderSize = 6 // version, kind, uint32 id
const chunkHeaderSize = 14 // control header, float64 byte offset
const minChunkSize = maxFrameBytes - chunkHeaderSize
const maxChunkSize = maxBulkFrameBytes - chunkHeaderSize
const defaultMaxReceiveBytes = 256 * 1024 ** 2
const maxControlBufferedBytes = 1024 ** 2

const maxPendingTransfers = 1024
const maxPendingPerPeer = 64
const maxDecisions = 128
const maxDecisionsPerPeer = 8
const maxPreListenerMessages = 32
const sizeLimitMsg = 'payload exceeds receiver size limit'
const invalidPayloadMsg = invalidActionMsg('payload')

const textFormat = 0
const jsonFormat = 1
const binaryFormat = 2

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

type IncomingInlineState =
  | {readonly phase: 'pending'; readonly data: Uint8Array}
  | {readonly phase: 'deciding'; readonly data: Uint8Array}
  | {readonly phase: 'ready'; readonly data: Uint8Array}
  | {readonly phase: 'closed'}

type IncomingBulkState =
  | {readonly phase: 'pending'}
  | {readonly phase: 'deciding'}
  | {readonly phase: 'queued'}
  | {readonly phase: 'accepted'}
  | {
      readonly phase: 'receiving'
      readonly data: Uint8Array
      readonly seenChunks: Uint8Array
      offset: number
    }
  | {
      readonly phase: 'buffered'
      readonly data: Uint8Array
    }
  | {readonly phase: 'closed'}

const bulkPhaseClass = {
  pending: {waiting: true, reserved: false, active: false, admitted: false},
  deciding: {waiting: true, reserved: false, active: false, admitted: false},
  queued: {waiting: true, reserved: false, active: false, admitted: true},
  accepted: {waiting: false, reserved: true, active: true, admitted: true},
  receiving: {waiting: false, reserved: true, active: true, admitted: true},
  buffered: {waiting: false, reserved: true, active: false, admitted: true},
  closed: {waiting: false, reserved: false, active: false, admitted: false}
} satisfies Record<
  IncomingBulkState['phase'],
  {waiting: boolean; reserved: boolean; active: boolean; admitted: boolean}
>

type TransferEnvelopeBase = {
  readonly message: IncomingMessageMeta
  readonly scope: ReceiveScope | undefined
  unbindScopeAbort: (() => void) | null
  controller: AbortController | null
  lastSeenAt: number
  timer: Timeout | null
}

type IncomingInline = TransferEnvelopeBase & {
  readonly kind: 'inline'
  readonly queueKey: string
  state: IncomingInlineState
}

type IncomingBulk = TransferEnvelopeBase & {
  readonly kind: 'bulk'
  readonly transferId: number
  readonly chunkSize: number
  state: IncomingBulkState
}

type IncomingTransfer = IncomingInline | IncomingBulk

type PeerIncomingState = {
  bulkTransfers: Map<number, IncomingBulk>
  inlineQueues: Map<string, IncomingInline[]>
  activeBulk: IncomingBulk | null
  pendingCount: number
}

type PreListenerEntry = {
  readonly admitted: boolean
  readonly message: IncomingMessageMeta
  readonly data: Uint8Array
  readonly receivedAt: number
}

type OutgoingBulkState =
  | {
      readonly phase: 'offering'
      sent: boolean
      timer: Timeout
      lastSeen: number
    }
  | {readonly phase: 'streaming'}
  | {
      readonly phase: 'failed'
      readonly error: Error
      readonly fromReceiver: boolean
      readonly didSendOffer: boolean
    }
  | {readonly phase: 'done'}

const isBulkSettled = (
  s: OutgoingBulkState
): s is Extract<OutgoingBulkState, {phase: 'failed' | 'done'}> =>
  s.phase === 'failed' || s.phase === 'done'

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
  onReschedule: (timer: Timeout) => void
): Timeout => {
  const tick = (): void => {
    const remaining = transferTimeoutMs - (Date.now() - getLast())
    if (remaining > 0) {
      const next = setTimeout(tick, remaining)
      unrefTimer(next)
      onReschedule(next)
    } else {
      onTimeout()
    }
  }
  const initial = setTimeout(tick, transferTimeoutMs)
  unrefTimer(initial)
  return initial
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
  const outgoingInlineQueues = new Map<string, Promise<void>>()
  const peers = new Map<string, PeerIncomingState>()
  const preListenerQueues = new Map<string, Map<string, PreListenerEntry[]>>()
  const waitingBulk = new Set<IncomingBulk>()
  const decisions = new Map<string, number>()
  const failedTransports = new WeakSet<PeerDataTransport>()

  let preListenerSweepTimer: Timeout | null = null
  let nextTransferId = 0
  let pendingCount = 0
  let decisionCount = 0
  let reservedBytes = 0
  let draining = false
  let drainDirty = false

  const disconnectedTransferErr = (): ActionError =>
    makeActionError('disconnected', peerDisconnectedMsg)
  const invalidFrameMsg = invalidActionMsg('frame')
  const isCurrent = (transfer: IncomingTransfer): boolean =>
    transfer.state.phase !== 'closed'
  const payloadLimit = (registration?: ReceiveRegistration): number =>
    Math.min(maxReceiveBytes, registration?.maxPayloadBytes ?? maxReceiveBytes)

  const markDrainDirty = (): void => {
    if (draining) {
      drainDirty = true
    }
  }

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

  const releaseDecisionSlot = (peerId: string): void => {
    decisionCount--
    const count = (decisions.get(peerId) ?? 1) - 1
    if (count > 0) {
      decisions.set(peerId, count)
    } else {
      decisions.delete(peerId)
    }
  }

  const transitionBulk = (
    transfer: IncomingBulk,
    next: IncomingBulkState
  ): void => {
    const from = bulkPhaseClass[transfer.state.phase]
    const to = bulkPhaseClass[next.phase]
    const {peerId, size} = transfer.message
    const peer = peers.get(peerId)
    if (from.reserved !== to.reserved) {
      reservedBytes += to.reserved ? size : -size
      if (!to.reserved) {
        markDrainDirty()
      }
    }
    if (from.waiting !== to.waiting) {
      if (to.waiting) {
        waitingBulk.add(transfer)
      } else {
        waitingBulk.delete(transfer)
      }
    }
    if (from.active !== to.active && peer) {
      if (to.active) {
        peer.activeBulk = transfer
      } else if (peer.activeBulk === transfer) {
        peer.activeBulk = null
        rotateWaitingForPeer(peerId)
      }
    }
    transfer.state = next
    if (next.phase === 'buffered') {
      markDrainDirty()
    }
  }

  const releaseTransfer = (transfer: IncomingTransfer): boolean => {
    if (transfer.state.phase === 'closed') {
      return false
    }
    const {peerId} = transfer.message
    const peer = peers.get(peerId)

    transfer.unbindScopeAbort?.()
    transfer.unbindScopeAbort = null
    transfer.timer = resetTimer(transfer.timer)
    const admissionController = transfer.controller
    transfer.controller = null

    if (transfer.kind === 'inline') {
      transfer.state = {phase: 'closed'}
      const queue = peer?.inlineQueues.get(transfer.queueKey)
      if (queue) {
        const idx = queue.indexOf(transfer)
        if (idx >= 0) {
          queue.splice(idx, 1)
        }
        if (!queue.length) {
          peer!.inlineQueues.delete(transfer.queueKey)
        }
      }
    } else {
      peer?.bulkTransfers.delete(transfer.transferId)
      transitionBulk(transfer, {phase: 'closed'})
    }
    if (peer) {
      peer.pendingCount--
      pendingCount--
      if (!peer.pendingCount) {
        peers.delete(peerId)
      }
    }
    admissionController?.abort()
    return true
  }

  const rejectRx = (transfer: IncomingTransfer, reason: string): void => {
    if (!releaseTransfer(transfer)) {
      return
    }
    notifyRejected(
      transfer.message,
      reason,
      transfer.scope,
      transfer.kind === 'bulk' ? transfer.transferId : undefined
    )
  }

  const enterDeciding = (
    transfer: IncomingTransfer
  ): AbortController | null => {
    if (transfer.state.phase !== 'pending') {
      return null
    }
    const {peerId} = transfer.message
    if (
      decisionCount >= maxDecisions ||
      (decisions.get(peerId) ?? 0) >= maxDecisionsPerPeer
    ) {
      rejectRx(transfer, 'too many pending receive decisions')
      return null
    }
    const controller = new AbortController()
    transfer.controller = controller
    decisionCount++
    decisions.set(peerId, (decisions.get(peerId) ?? 0) + 1)
    if (transfer.kind === 'inline') {
      transfer.state = {
        phase: 'deciding',
        data: transfer.state.data
      }
    } else {
      transitionBulk(transfer, {phase: 'deciding'})
    }
    return controller
  }

  const enterReady = (transfer: IncomingTransfer): boolean => {
    if (transfer.kind === 'inline') {
      switch (transfer.state.phase) {
        case 'pending':
        case 'deciding':
          transfer.state = {phase: 'ready', data: transfer.state.data}
          return true
        case 'ready':
          return true
        case 'closed':
          return false
        default:
          return unreachable(transfer.state)
      }
    }

    switch (transfer.state.phase) {
      case 'pending':
      case 'deciding':
        transitionBulk(transfer, {phase: 'queued'})
        return true
      case 'queued':
      case 'accepted':
      case 'receiving':
      case 'buffered':
        return true
      case 'closed':
        return false
      default:
        return unreachable(transfer.state)
    }
  }

  const acceptBulk = (transfer: IncomingBulk): void => {
    if (transfer.state.phase !== 'queued') {
      return
    }
    const peer = peers.get(transfer.message.peerId)
    if (
      !peer ||
      peer.activeBulk !== null ||
      reservedBytes + transfer.message.size > maxReceiveBytes
    ) {
      return
    }
    transfer.lastSeenAt = Date.now()
    transitionBulk(transfer, {phase: 'accepted'})
    sendControl(transfer.message.peerId, transfer.transferId, acceptedKind)
  }

  const beginReceivingChunks = (
    transfer: IncomingBulk
  ): Extract<IncomingBulkState, {phase: 'receiving'}> | null => {
    switch (transfer.state.phase) {
      case 'receiving':
        return transfer.state
      case 'accepted': {
        const totalSize = transfer.message.size
        try {
          const nextState: Extract<IncomingBulkState, {phase: 'receiving'}> = {
            phase: 'receiving',
            data: new Uint8Array(totalSize),
            seenChunks: new Uint8Array(
              Math.ceil(Math.ceil(totalSize / transfer.chunkSize) / 8)
            ),
            offset: 0
          }
          transitionBulk(transfer, nextState)
          return nextState
        } catch {
          rejectRx(transfer, 'unable to allocate receive buffer')
          drain()
          return null
        }
      }
      case 'pending':
      case 'deciding':
      case 'queued':
      case 'buffered':
      case 'closed':
        return null
      default:
        return unreachable(transfer.state)
    }
  }

  const parkCompletedBulk = (transfer: IncomingBulk): void => {
    if (transfer.state.phase !== 'receiving') {
      return
    }
    const {data} = transfer.state
    transitionBulk(transfer, {phase: 'buffered', data})
  }

  const isAdmittedTransfer = (transfer: IncomingTransfer): boolean =>
    transfer.kind === 'inline'
      ? transfer.state.phase === 'ready'
      : bulkPhaseClass[transfer.state.phase].admitted

  const admit = (
    transfer: IncomingTransfer,
    registration: ReceiveRegistration
  ): boolean => {
    if (transfer.state.phase !== 'pending') {
      return isAdmittedTransfer(transfer)
    }
    if (transfer.message.size > payloadLimit(registration)) {
      rejectRx(transfer, sizeLimitMsg)
      return false
    }
    const receive = transfer.scope
      ? transfer.scope[2]
      : registration.receiveGate
    if (!receive) {
      if (!registration.receiver) {
        return false
      }
      return enterReady(transfer)
    }
    const controller = enterDeciding(transfer)
    if (!controller) {
      return false
    }
    const {peerId} = transfer.message
    let settled = false
    const result = decideReceive(
      () =>
        receive({
          byteLength: transfer.message.size,
          peerId,
          signal: controller.signal,
          ...(transfer.message.metadata === undefined
            ? {}
            : {metadata: transfer.message.metadata})
        }),
      allow => {
        if (!settled) {
          settled = true
          releaseDecisionSlot(peerId)
        }
        if (transfer.state.phase !== 'deciding') {
          return false
        }
        if (allow) {
          return enterReady(transfer)
        }
        rejectRx(transfer, 'payload rejected by receiver')
        return false
      }
    )
    if (typeof result === 'boolean') {
      return result
    }
    void result.then(() => drain())
    return false
  }

  const complete = (
    transfer: IncomingTransfer,
    registration: ReceiveRegistration,
    bytes: Uint8Array,
    copyBinary: boolean
  ): void => {
    let payload: DataPayload
    try {
      payload = decodePayload(bytes, transfer.message.format, copyBinary)
    } catch {
      releaseTransfer(transfer)
      failPeer(transfer.message.peerId, invalidPayloadMsg)
      return
    }
    releaseTransfer(transfer)
    deliverPayload(
      registration,
      payload,
      transfer.message.peerId,
      transfer.message.metadata
    )
  }

  const tryInline = (transfer: IncomingInline): void => {
    const registration = rxActions.get(transfer.message.type)
    if (!registration) {
      return
    }
    if (transfer.state.phase === 'pending' && !admit(transfer, registration)) {
      return
    }
    if (transfer.state.phase !== 'ready') {
      return
    }
    if (registration.receiver) {
      complete(transfer, registration, transfer.state.data, true)
    } else if (!transfer.scope) {
      const {data} = transfer.state
      const {lastSeenAt, message} = transfer
      releaseTransfer(transfer)
      bufferPreListenerInline(message, data, true, true, lastSeenAt)
    }
  }

  const tryBulk = (transfer: IncomingBulk): void => {
    const registration = rxActions.get(transfer.message.type)
    if (!registration) {
      return
    }
    switch (transfer.state.phase) {
      case 'pending':
        if (admit(transfer, registration) && registration.receiver) {
          acceptBulk(transfer)
        }
        return
      case 'queued':
        if (registration.receiver) {
          acceptBulk(transfer)
        }
        return
      case 'buffered':
        if (registration.receiver) {
          complete(transfer, registration, transfer.state.data, false)
        }
        return
      case 'deciding':
      case 'accepted':
      case 'receiving':
      case 'closed':
        return
      default:
        unreachable(transfer.state)
    }
  }

  const drainInline = (peerId: string, queueKey: string): void => {
    const queue = peers.get(peerId)?.inlineQueues.get(queueKey)
    while (queue?.[0]) {
      const head = queue[0]
      tryInline(head)
      if (isCurrent(head)) {
        break
      }
    }
  }

  const drain = (): void => {
    if (draining) {
      drainDirty = true
      return
    }
    draining = true
    try {
      do {
        drainDirty = false
        for (const transfer of waitingBulk) {
          tryBulk(transfer)
        }
        for (const [id, peer] of peers) {
          for (const transfer of peer.bulkTransfers.values()) {
            if (transfer.state.phase === 'buffered') {
              tryBulk(transfer)
            }
          }
          for (const key of peer.inlineQueues.keys()) {
            drainInline(id, key)
          }
        }
      } while (drainDirty)
    } finally {
      draining = false
      drainDirty = false
    }
  }

  const ensurePreListenerSweepTimer = (): void => {
    if (!preListenerSweepTimer) {
      preListenerSweepTimer = setTimeout(
        sweepPreListenerQueues,
        pendingDataTimeoutMs
      )
      unrefTimer(preListenerSweepTimer)
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
      ensurePreListenerSweepTimer()
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
      admitted,
      message,
      data: alreadyOwned ? dataSlice : dataSlice.slice(),
      receivedAt
    })
    ensurePreListenerSweepTimer()
  }

  const createTransferBase = (
    message: IncomingMessageMeta,
    scope?: ReceiveScope
  ): TransferEnvelopeBase => ({
    message,
    scope,
    unbindScopeAbort: null,
    controller: null,
    lastSeenAt: Date.now(),
    timer: null
  })

  const ensureIdleTimer = (transfer: IncomingTransfer): void => {
    if (!isCurrent(transfer) || transfer.timer) {
      return
    }
    transfer.timer = startIdleTimer(
      () => transfer.lastSeenAt,
      () => {
        rejectRx(transfer, 'action transfer timed out')
        drain()
      },
      nextTimer => {
        if (isCurrent(transfer)) {
          transfer.timer = nextTimer
        } else {
          clearTimeout(nextTimer)
        }
      }
    )
  }

  const enqueueTransfer = (
    transfer: IncomingTransfer,
    deferTimer = false
  ): boolean => {
    const {peerId} = transfer.message
    let peer = peers.get(peerId)
    if (
      pendingCount >= maxPendingTransfers ||
      (peer?.pendingCount ?? 0) >= maxPendingPerPeer
    ) {
      notifyRejected(
        transfer.message,
        'too many pending transfers',
        transfer.scope,
        transfer.kind === 'bulk' ? transfer.transferId : undefined
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
    if (transfer.kind === 'inline') {
      const queue = peer.inlineQueues.get(transfer.queueKey) ?? []
      queue.push(transfer)
      peer.inlineQueues.set(transfer.queueKey, queue)
    } else {
      peer.bulkTransfers.set(transfer.transferId, transfer)
      transitionBulk(transfer, {phase: 'pending'})
    }
    if (!deferTimer) {
      ensureIdleTimer(transfer)
    }
    if (transfer.scope) {
      const sig = transfer.scope[1]
      const cancel = (): void => {
        rejectRx(transfer, 'receive cancelled')
        drain()
      }
      if (sig.aborted) {
        cancel()
        return false
      }
      const ac = new AbortController()
      sig.addEventListener('abort', cancel, {once: true, signal: ac.signal})
      transfer.unbindScopeAbort = () => ac.abort()
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
    for (const peerId of Array.from(preListenerQueues.keys())) {
      if (!isFlushable()) {
        break
      }
      while (isFlushable()) {
        const byType = preListenerQueues.get(peerId)
        const ring = byType?.get(type)
        if (!ring || ring.length === 0) {
          if (byType) {
            byType.delete(type)
            if (byType.size === 0) {
              preListenerQueues.delete(peerId)
            }
          }
          break
        }
        if (now - ring[0]!.receivedAt > pendingDataTimeoutMs) {
          ring.shift()
          continue
        }
        if (ring[0]!.admitted && !registration.receiver) {
          break
        }
        const entry = ring.shift()!
        if (ring.length === 0) {
          byType!.delete(type)
          if (byType!.size === 0) {
            preListenerQueues.delete(peerId)
          }
        }
        if (entry.message.size > payloadLimit(registration)) {
          notifyRejected(entry.message, sizeLimitMsg)
          continue
        }
        if (
          entry.admitted ||
          (registration.receiver &&
            !registration.receiveGate &&
            !peers.get(peerId)?.inlineQueues.has(type))
        ) {
          let payload: DataPayload
          try {
            payload = decodePayload(entry.data, entry.message.format, false)
          } catch {
            if (byType) {
              byType.delete(type)
              if (byType.size === 0) {
                preListenerQueues.delete(peerId)
              }
            }
            failPeer(peerId, invalidPayloadMsg)
            break
          }
          deliverPayload(registration, payload, peerId, entry.message.metadata)
        } else {
          const transfer: IncomingInline = {
            ...createTransferBase(entry.message),
            kind: 'inline',
            queueKey: type,
            state: {phase: 'pending', data: entry.data}
          }
          if (enqueueTransfer(transfer, true)) {
            drainInline(peerId, type)
            ensureIdleTimer(transfer)
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
    outgoingInlineQueues.delete(peerId)
    preListenerQueues.delete(peerId)
    const peer = peers.get(peerId)
    if (peer) {
      for (const transfer of Array.from(peer.bulkTransfers.values())) {
        releaseTransfer(transfer)
      }
      for (const queue of Array.from(peer.inlineQueues.values())) {
        queue.slice().forEach(transfer => {
          releaseTransfer(transfer)
        })
      }
    }
    drain()
  }

  const raceAbort = <T>(p: Promise<T>, signal: AbortSignal): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        try {
          checkAborted(signal)
        } catch (err) {
          reject(err as Error)
        }
      }
      if (signal.aborted) {
        onAbort()
        return
      }
      const ac = new AbortController()
      signal.addEventListener('abort', onAbort, {once: true, signal: ac.signal})
      void p.then(resolve, reject).finally(() => {
        ac.abort()
      })
    })

  const sendFrameToTransport = async (
    transport: PeerDataTransport,
    bytes: Uint8Array,
    check: () => void,
    signal: AbortSignal | undefined,
    transferId?: number,
    isOffer?: boolean,
    initialDrain?: Promise<boolean> | boolean,
    onBeforeSend?: () => void,
    onSendFailed?: (err: Error) => void
  ): Promise<void> => {
    check()
    const drainRes = initialDrain ?? transport.waitForDrain(signal)
    if (drainRes !== true) {
      if (!(await drainRes)) {
        checkAborted(signal)
        throw makeActionError('disconnected', 'data channel stopped draining')
      }
      check()
    }
    onBeforeSend?.()
    try {
      transport.sendFrame(bytes, transferId, isOffer)
    } catch {
      const err = disconnectedTransferErr()
      onSendFailed?.(err)
      throw err
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
    const {
      promise: permission,
      resolve: acceptOffer,
      reject: rejectOffer
    } = Promise.withResolvers<void>()
    void permission.catch(noOp)

    const transfers =
      outgoing.get(peerId) ?? new Map<number, OutgoingTransfer>()
    if (transfers.has(transferId)) {
      throw mkErr('action transfer id in use')
    }
    outgoing.set(peerId, transfers)

    const failTransfer = (
      error: Error,
      fromReceiver = false,
      didSendOfferOverride?: boolean
    ): void => {
      if (isBulkSettled(bulkState)) {
        return
      }
      let didSendOffer = true
      if (bulkState.phase === 'offering') {
        didSendOffer = bulkState.sent
        clearTimeout(bulkState.timer)
        bulkState = {
          phase: 'failed',
          error,
          fromReceiver,
          didSendOffer: didSendOfferOverride ?? didSendOffer
        }
        rejectOffer(error)
        return
      }
      bulkState = {
        phase: 'failed',
        error,
        fromReceiver,
        didSendOffer: didSendOfferOverride ?? didSendOffer
      }
    }

    let bulkState: OutgoingBulkState = {
      phase: 'offering',
      sent: false,
      timer: startIdleTimer(
        () => (bulkState.phase === 'offering' ? bulkState.lastSeen : 0),
        () =>
          failTransfer(makeActionError('timeout', 'action offer timed out')),
        nextTimer => {
          if (bulkState.phase === 'offering') {
            bulkState.timer = nextTimer
          } else {
            clearTimeout(nextTimer)
          }
        }
      ),
      lastSeen: Date.now()
    }
    const currentBulkState = (): OutgoingBulkState => bulkState

    const check = (): void => {
      if (bulkState.phase === 'failed') {
        throw bulkState.error
      }
      try {
        checkAborted(signal)
        if (!transport.isOpen) {
          throw disconnectedTransferErr()
        }
      } catch (err) {
        failTransfer(err as Error)
        throw err
      }
    }

    const transferState: OutgoingTransfer = {
      accept: () => {
        if (bulkState.phase === 'offering' && bulkState.sent) {
          clearTimeout(bulkState.timer)
          bulkState = {phase: 'streaming'}
          acceptOffer()
          return true
        }
        return false
      },
      fail: (error, fromReceiver = false) => {
        failTransfer(error, fromReceiver)
      },
      touch: () => {
        if (bulkState.phase === 'offering') {
          bulkState.lastSeen = Date.now()
        }
      }
    }
    transfers.set(transferId, transferState)

    const abortCleanup = signal ? new AbortController() : null
    if (abortCleanup && signal) {
      signal.addEventListener(
        'abort',
        () => {
          try {
            checkAborted(signal)
          } catch (error) {
            failTransfer(error as Error)
          }
        },
        {once: true, signal: abortCleanup.signal}
      )
    }

    try {
      const useWideChunks =
        (transport.maxBulkFrameBytes ?? maxFrameBytes) >= maxBulkFrameBytes
      const txChunkSize = useWideChunks ? maxChunkSize : minChunkSize
      let peerOfferFrame = offerFrame
      if (useWideChunks) {
        peerOfferFrame = offerFrame.slice()
        peerOfferFrame[1] = peerOfferFrame[1]! | wideBulkFlag
      }
      await sendFrameToTransport(
        transport,
        peerOfferFrame,
        check,
        signal,
        transferId,
        true,
        undefined,
        () => {
          if (bulkState.phase === 'offering') {
            bulkState.sent = true
          }
        },
        err => {
          failTransfer(err, false, false)
        }
      )
      await permission
      for (let offset = 0; offset < size; offset += txChunkSize) {
        check()
        const length = Math.min(txChunkSize, size - offset)
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
      if (currentBulkState().phase === 'streaming') {
        bulkState = {phase: 'done'}
      }
    } catch (error) {
      failTransfer(error as Error)
      const failedState = currentBulkState()
      if (
        failedState.phase === 'failed' &&
        failedState.didSendOffer &&
        !failedState.fromReceiver &&
        transport.isOpen &&
        transport.bufferedAmount <= maxControlBufferedBytes
      ) {
        sendControlFrame(peerId, transport, transferId, cancelledKind)
      }
      throw failedState.phase === 'failed' ? failedState.error : error
    } finally {
      const finalState = currentBulkState()
      if (finalState.phase === 'offering') {
        clearTimeout(finalState.timer)
      }
      abortCleanup?.abort()
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
      const transfer = peers.get(peerId)?.bulkTransfers.get(id)
      if (transfer) {
        releaseTransfer(transfer)
        transfer.scope?.[3]('response cancelled by sender')
      }
      drain()
      return
    }

    const offset =
      bytes.length >= chunkHeaderSize ? view.getFloat64(controlHeaderSize) : NaN
    const chunkData = bytes.subarray(chunkHeaderSize)
    const peer = peers.get(peerId)
    const transfer = peer?.bulkTransfers.get(id)
    if (!transfer) {
      return
    }
    const totalSize = transfer.message.size
    const rxChunkSize = transfer.chunkSize
    const canReceiveChunks = bulkPhaseClass[transfer.state.phase].active
    if (
      !canReceiveChunks ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset >= totalSize ||
      offset % rxChunkSize !== 0 ||
      !chunkData.length ||
      chunkData.length !== Math.min(rxChunkSize, totalSize - offset)
    ) {
      failPeer(peerId, invalidActionMsg('chunk'))
      return
    }

    const rxState = beginReceivingChunks(transfer)
    if (!rxState) {
      return
    }

    const chunkIdx = offset / rxChunkSize
    const byteIdx = chunkIdx >>> 3
    const bitMask = 1 << (chunkIdx & 7)
    if ((rxState.seenChunks[byteIdx]! & bitMask) !== 0) {
      failPeer(peerId, invalidActionMsg('chunk'))
      return
    }
    rxState.seenChunks[byteIdx]! |= bitMask
    rxState.data.set(chunkData, offset)
    rxState.offset += chunkData.length

    const now = Date.now()
    transfer.lastSeenAt = now
    for (const queued of waitingBulk) {
      if (
        queued.state.phase === 'queued' &&
        rxActions.get(queued.message.type)?.receiver
      ) {
        queued.lastSeenAt = now
      }
    }

    if (rxState.offset === totalSize) {
      const registration = rxActions.get(transfer.message.type)
      if (registration?.receiver) {
        complete(transfer, registration, rxState.data, false)
      } else {
        parkCompletedBulk(transfer)
      }
      drain()
    } else {
      const registration = rxActions.get(transfer.message.type)
      if (registration) {
        emitRxProgress(
          registration,
          rxState.offset / totalSize,
          peerId,
          transfer.message.metadata
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
        const metaJson = metadata === undefined ? '' : toJson(metadata)
        const metaByteLen =
          metadata === undefined ? 0 : utf8ByteLength(metaJson)
        if (metaByteLen > maxFrameBytes - offerHeaderSize) {
          throw mkErr('action metadata is too large')
        }

        const isSmall = inlineHeaderSize + metaByteLen + size <= maxFrameBytes
        const transferId = isSmall ? 0 : nextTransferId++ >>> 0
        const headerSize = isSmall ? inlineHeaderSize : offerHeaderSize
        const startFrame = new Uint8Array(
          headerSize + metaByteLen + (isSmall ? size : 0)
        )
        startFrame[0] = actionWireVersion
        startFrame[1] = (isSmall ? inlineKind : offerKind) | (format << 4)
        startFrame.set(typeBytes, 2)
        const view = viewOf(startFrame)
        view.setUint16(34, metaByteLen)
        if (!isSmall) {
          view.setUint32(36, transferId)
          view.setFloat64(40, size)
        }
        if (metaByteLen > 0) {
          encodeBytesInto(
            metaJson,
            startFrame.subarray(headerSize, headerSize + metaByteLen)
          )
        }
        if (isSmall) {
          startFrame.set(
            source instanceof Uint8Array
              ? source
              : new Uint8Array(await source.arrayBuffer()),
            headerSize + metaByteLen
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
            const prevQueue = outgoingInlineQueues.get(peerId)
            const drainRes = prevQueue
              ? undefined
              : transport.waitForDrain(signal)
            if (drainRes === true) {
              try {
                transport.sendFrame(startFrame)
              } catch {
                throw disconnectedTransferErr()
              }
              progressCb?.(1, peerId, metadata)
              continue
            }
            const task = (async (): Promise<void> => {
              await prevQueue
              await sendFrameToTransport(
                transport,
                startFrame,
                () => {
                  checkAborted(signal)
                  if (!transport.isOpen) {
                    throw disconnectedTransferErr()
                  }
                },
                signal,
                undefined,
                undefined,
                drainRes
              )
              progressCb?.(1, peerId, metadata)
            })()
            const tail: Promise<void> = task.catch(noOp).finally(() => {
              if (outgoingInlineQueues.get(peerId) === tail) {
                outgoingInlineQueues.delete(peerId)
              }
            })
            outgoingInlineQueues.set(peerId, tail)
            pushPending(prevQueue && signal ? raceAbort(task, signal) : task)
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
    if (data.byteLength < 2 || data.byteLength > maxBulkFrameBytes) {
      failPeer(peerId, invalidFrameMsg)
      return
    }
    const bytes = new Uint8Array(data)
    if (bytes[0] !== actionWireVersion) {
      failPeer(peerId, 'incompatible action protocol version')
      return
    }
    const kind = bytes[1]! & 15
    const format = (bytes[1]! >>> 4) & 3
    const flags = bytes[1]! >>> 6
    const view = viewOf(bytes)
    if (
      kind > cancelledKind ||
      format > binaryFormat ||
      flags > (kind === offerKind ? 1 : 0) ||
      (kind > offerKind && format !== textFormat) ||
      (kind !== chunkKind && bytes.length > maxFrameBytes)
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

      const transfer: IncomingInline = {
        ...createTransferBase(message, scope),
        kind: 'inline',
        queueKey,
        state: {phase: 'pending', data: dataSlice.slice()}
      }
      if (enqueueTransfer(transfer, true)) {
        drainInline(peerId, queueKey)
        ensureIdleTimer(transfer)
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
    const transfer: IncomingBulk = {
      ...createTransferBase(message, resolved[1]),
      kind: 'bulk',
      transferId,
      chunkSize: flags === 1 ? maxChunkSize : minChunkSize,
      state: {phase: 'closed'}
    }
    if (enqueueTransfer(transfer)) {
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
