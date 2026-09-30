import {decodeBytes, fromJson, libName, noOp} from './utils'
import type {ActionReceiveContext, DataPayload, JsonValue} from './types'

const maxPendingTransfers = 1024
const maxPendingPerPeer = 64
const maxDecisions = 128
const maxDecisionsPerPeer = 8
const transferTimeoutMs = 120_000
const emptyBytes = new Uint8Array()

export type WireReceiveContext = Omit<ActionReceiveContext, 'kind'>
export type WireReceiveHandler = (
  context: WireReceiveContext
) => boolean | Promise<boolean>
// Request ownership is independent of optional application admission policy.
export type ReceiveScope = {
  key: string
  signal: AbortSignal
  receive: WireReceiveHandler | null
  reject: (reason: string) => void
}
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
type ReceiveAction = ReceiveOptions & {
  receiver:
    | ((data: DataPayload, peerId: string, metadata?: JsonValue) => void)
    | null
  progress: (percent: number, peerId: string, metadata?: JsonValue) => void
  receive: WireReceiveHandler | null
  reject: WireRejectHandler | null
}
type Message = {
  peerId: string
  type: string
  format: number
  size: number
  metadata?: JsonValue
}
type Admission = Message & {
  scope?: ReceiveScope
  removeAbortListener?: () => void
  phase: 'pending' | 'deciding' | 'ready' | 'released'
  controller: AbortController | null
  lastSeen: number
  timer: ReturnType<typeof setTimeout> | null
}
type Inline = Admission & {kind: 'inline'; key: string; data: Uint8Array}
type Bulk = Admission & {
  kind: 'bulk'
  id: number
  transfer: 'waiting' | 'receiving'
  data: Uint8Array | null
  offset: number
}
type Incoming = Inline | Bulk
type PeerIncoming = {
  bulk: Map<number, Bulk>
  inline: Map<string, Inline[]>
  active: Bulk | null
  count: number
}

// Normalize application policy results in one place, preserving synchronous decisions.
export const decideReceive = (
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
  format === 2
    ? copy
      ? bytes.slice()
      : bytes
    : format === 1
      ? fromJson<JsonValue>(decodeBytes(bytes))
      : decodeBytes(bytes)

const progress = (
  action: ReceiveAction,
  value: number,
  peerId: string,
  metadata?: JsonValue
): void => {
  try {
    action.progress(value, peerId, metadata)
  } catch (error) {
    console.error(`${libName} progress handler error:`, error)
  }
}
const deliverPayload = (
  action: ReceiveAction,
  data: DataPayload,
  peerId: string,
  metadata?: JsonValue
): void => {
  progress(action, 1, peerId, metadata)
  try {
    action.receiver?.(data, peerId, metadata)
  } catch (error) {
    console.error(`${libName} action handler error:`, error)
  }
}

export const createActionReceiver = ({
  fail,
  accept,
  refuse,
  maxReceiveBytes,
  chunkSize
}: {
  fail: (peerId: string, reason: string) => void
  accept: (peerId: string, id: number) => void
  refuse: (peerId: string, id: number, reason: string) => void
  maxReceiveBytes: number
  chunkSize: number
}) => {
  const actions = new Map<string, ReceiveAction>()
  const peers = new Map<string, PeerIncoming>()
  const waiting = new Set<Bulk>()
  const decisions = new Map<string, number>()
  let pendingCount = 0
  let decisionCount = 0
  let reservedBytes = 0
  let draining = false
  let drainAgain = false
  const current = (state: Incoming): boolean => state.phase !== 'released'
  const payloadLimit = (action?: ReceiveAction): number =>
    Math.min(maxReceiveBytes, action?.maxPayloadBytes ?? maxReceiveBytes)
  const notifyRejected = (
    message: Message,
    reason: string,
    scope?: ReceiveScope
  ): void => {
    scope?.reject(reason)
    actions
      .get(message.type)
      ?.reject?.(message.peerId, message.metadata, reason)
  }

  const release = (state: Incoming): void => {
    if (!current(state)) {
      return
    }
    state.phase = 'released'
    state.removeAbortListener?.()
    if (state.timer) {
      clearTimeout(state.timer)
    }
    const peer = peers.get(state.peerId)!
    if (state.kind === 'inline') {
      const queue = peer.inline.get(state.key)!
      queue.splice(queue.indexOf(state), 1)
      if (!queue.length) {
        peer.inline.delete(state.key)
      }
      state.data = emptyBytes
    } else {
      peer.bulk.delete(state.id)
      waiting.delete(state)
      state.data = null
      if (state.transfer === 'receiving') {
        reservedBytes -= state.size
        peer.active = null
        // Rotate this peer's offers behind other peers when it releases capacity.
        const queuedTransfers = [...waiting]
        for (const queued of queuedTransfers) {
          if (queued.peerId === state.peerId) {
            waiting.delete(queued)
            waiting.add(queued)
          }
        }
        drainAgain = true
      }
    }
    peer.count--
    pendingCount--
    if (!peer.count) {
      peers.delete(state.peerId)
    }
    state.controller?.abort()
  }
  const reject = (state: Incoming, reason: string): void => {
    if (!current(state)) {
      return
    }
    release(state)
    notifyRejected(state, reason, state.scope)
    if (state.kind === 'bulk') {
      refuse(state.peerId, state.id, reason)
    }
  }
  const admit = (state: Incoming, action: ReceiveAction): boolean => {
    if (state.phase !== 'pending') {
      return state.phase === 'ready'
    }
    // Recheck when a previously unknown action is registered with a size cap.
    if (state.size > payloadLimit(action)) {
      reject(state, 'payload exceeds receiver size limit')
      return false
    }
    const receive = state.scope ? state.scope.receive : action.receive
    if (!receive) {
      state.phase = 'ready'
      return true
    }
    // Count before calling application code: it may synchronously re-enter us.
    // Unsettled decisions keep their slots even after cancellation/disconnect.
    if (
      decisionCount >= maxDecisions ||
      (decisions.get(state.peerId) ?? 0) >= maxDecisionsPerPeer
    ) {
      reject(state, 'too many pending receive decisions')
      return false
    }
    state.phase = 'deciding'
    const controller = new AbortController()
    state.controller = controller
    decisionCount++
    decisions.set(state.peerId, (decisions.get(state.peerId) ?? 0) + 1)
    const result = decideReceive(
      () =>
        receive({
          byteLength: state.size,
          peerId: state.peerId,
          signal: controller.signal,
          ...(state.metadata === undefined ? {} : {metadata: state.metadata})
        }),
      allow => {
        decisionCount--
        const count = decisions.get(state.peerId)! - 1
        if (count) {
          decisions.set(state.peerId, count)
        } else {
          decisions.delete(state.peerId)
        }
        if (!current(state)) {
          return false
        }
        if (allow) {
          state.phase = 'ready'
        } else {
          reject(state, 'payload rejected by receiver')
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
      payload = decodePayload(bytes, state.format, state.kind === 'inline')
    } catch {
      reject(state, 'invalid action payload')
      return
    }
    release(state)
    deliverPayload(action, payload, state.peerId, state.metadata)
  }
  const tryInline = (state: Inline): void => {
    const action = actions.get(state.type)
    if (current(state) && action && admit(state, action) && action.receiver) {
      complete(state, action, state.data)
    }
  }
  const tryBulk = (state: Bulk): void => {
    const action = actions.get(state.type)
    if (
      !current(state) ||
      !action ||
      !admit(state, action) ||
      !action.receiver
    ) {
      return
    }
    if (state.transfer === 'receiving') {
      if (state.offset === state.size) {
        complete(state, action, state.data!)
      }
      return
    }
    const peer = peers.get(state.peerId)!
    if (!peer.active && reservedBytes + state.size <= maxReceiveBytes) {
      peer.active = state
      state.transfer = 'receiving'
      reservedBytes += state.size
      state.lastSeen = Date.now()
      waiting.delete(state)
      accept(state.peerId, state.id)
    }
  }
  const drainInline = (peerId: string, key: string): void => {
    let state = peers.get(peerId)?.inline.get(key)?.[0]
    while (state) {
      tryInline(state)
      if (current(state)) {
        break
      }
      state = peers.get(peerId)?.inline.get(key)?.[0]
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
        // ponytail: at most 1024 entries; ready inline traffic never scans these queues.
        for (const state of waiting) {
          tryBulk(state)
        }
        for (const [id, peer] of peers) {
          if (peer.active) {
            tryBulk(peer.active)
          }
          for (const key of peer.inline.keys()) {
            drainInline(id, key)
          }
        }
      } while (drainAgain)
    } finally {
      draining = false
    }
  }
  const enqueue = (state: Incoming): boolean => {
    let peer = peers.get(state.peerId)
    if (
      pendingCount >= maxPendingTransfers ||
      (peer?.count ?? 0) >= maxPendingPerPeer
    ) {
      notifyRejected(state, 'too many pending transfers', state.scope)
      if (state.kind === 'bulk') {
        refuse(state.peerId, state.id, 'too many pending transfers')
      }
      return false
    }
    if (!peer) {
      peer = {bulk: new Map(), inline: new Map(), active: null, count: 0}
      peers.set(state.peerId, peer)
    }
    peer.count++
    pendingCount++
    if (state.kind === 'inline') {
      const queue = peer.inline.get(state.key) ?? []
      queue.push(state)
      peer.inline.set(state.key, queue)
    } else {
      peer.bulk.set(state.id, state)
      waiting.add(state)
    }
    const expire = (): void => {
      const remaining = transferTimeoutMs - (Date.now() - state.lastSeen)
      if (remaining > 0) {
        state.timer = setTimeout(expire, remaining)
      } else {
        reject(state, 'action transfer timed out')
        drain()
      }
    }
    state.timer = setTimeout(expire, transferTimeoutMs)
    if (state.scope) {
      const {signal} = state.scope
      const cancel = (): void => {
        reject(state, 'receive cancelled')
        drain()
      }
      signal.addEventListener('abort', cancel, {once: true})
      state.removeAbortListener = () =>
        signal.removeEventListener('abort', cancel)
      if (signal.aborted) {
        cancel()
        return false
      }
    }
    return true
  }
  const admission = (message: Message, scope?: ReceiveScope): Admission => ({
    ...message,
    ...(scope ? {scope} : {}),
    phase: 'pending',
    controller: null,
    lastSeen: Date.now(),
    timer: null
  })
  return {
    register: (type: string, options: ReceiveOptions = {}) => {
      const action: ReceiveAction = {
        ...options,
        receiver: null,
        receive: null,
        reject: null,
        progress: noOp
      }
      actions.set(type, action)
      return {
        onMessage: (handler: ReceiveAction['receiver']): void => {
          action.receiver = handler
          drain()
        },
        onReceive: (handler: WireReceiveHandler | null): void => {
          action.receive = handler
        },
        onReject: (handler: WireRejectHandler): void => {
          action.reject = handler
        },
        onProgress: (handler: ReceiveAction['progress']): void => {
          action.progress = handler
        }
      }
    },
    receiveInline: (
      peerId: string,
      type: string,
      format: number,
      metadata: JsonValue | undefined,
      data: Uint8Array
    ): void => {
      const action = actions.get(type)
      const scope = action?.receiveScope?.(peerId, metadata)
      if (scope === null || scope?.signal.aborted) {
        return
      }
      if (data.length > payloadLimit(action)) {
        notifyRejected(
          {
            peerId,
            type,
            format,
            size: data.length,
            ...(metadata === undefined ? {} : {metadata})
          },
          'payload exceeds receiver size limit',
          scope
        )
        return
      }
      const key = scope ? `${type}\0${scope.key}` : type
      if (
        action?.receiver &&
        !(scope ? scope.receive : action.receive) &&
        !peers.get(peerId)?.inline.has(key)
      ) {
        // Direct delivery needs no admission entry, timer, context, or queue scan.
        let payload: DataPayload
        try {
          payload = decodePayload(data, format, true)
        } catch {
          fail(peerId, 'invalid action payload')
          return
        }
        deliverPayload(action, payload, peerId, metadata)
        return
      }
      const state: Inline = {
        ...admission(
          {
            peerId,
            type,
            format,
            size: data.length,
            ...(metadata === undefined ? {} : {metadata})
          },
          scope
        ),
        kind: 'inline',
        key,
        data
      }
      if (enqueue(state)) {
        drainInline(peerId, key)
      }
    },
    receiveOffer: (message: Message, id: number): void => {
      if (peers.get(message.peerId)?.bulk.has(id)) {
        fail(message.peerId, 'duplicate action offer')
        return
      }
      const action = actions.get(message.type)
      const scope = action?.receiveScope?.(message.peerId, message.metadata)
      if (scope === null || scope?.signal.aborted) {
        refuse(message.peerId, id, 'unexpected response')
        return
      }
      if (message.size > payloadLimit(action)) {
        notifyRejected(message, 'payload exceeds receiver size limit', scope)
        refuse(message.peerId, id, 'payload exceeds receiver size limit')
        return
      }
      const state: Bulk = {
        ...admission(message, scope),
        kind: 'bulk',
        id,
        transfer: 'waiting',
        offset: 0,
        data: null
      }
      if (enqueue(state)) {
        drain()
      }
    },
    receiveChunk: (
      peerId: string,
      id: number,
      offset: number,
      data: Uint8Array
    ): void => {
      const state = peers.get(peerId)?.bulk.get(id)
      if (!state) {
        return
      } // Cancelled/expired suffixes cannot resurrect transfers.
      if (
        state.transfer !== 'receiving' ||
        offset !== state.offset ||
        !data.length ||
        data.length !== Math.min(chunkSize, state.size - state.offset)
      ) {
        fail(peerId, 'invalid action chunk offset or length')
        return
      }
      try {
        state.data ??= new Uint8Array(state.size)
      } catch {
        reject(state, 'unable to allocate receive buffer')
        drain()
        return
      }
      state.data.set(data, state.offset)
      state.offset += data.length
      state.lastSeen = Date.now()
      if (state.offset === state.size) {
        tryBulk(state)
        drain()
      } else {
        progress(
          actions.get(state.type)!,
          state.offset / state.size,
          peerId,
          state.metadata
        )
      }
      return
    },
    cancel: (peerId: string, id: number): void => {
      const state = peers.get(peerId)?.bulk.get(id)
      if (state) {
        release(state)
        state.scope?.reject('response cancelled by sender')
      }
      drain()
    },
    clearPeer: (peerId: string): void => {
      const peer = peers.get(peerId)
      if (peer) {
        for (const state of peer.bulk.values()) {
          release(state)
        }
        for (const queue of peer.inline.values()) {
          const queuedMessages = [...queue]
          for (const state of queuedMessages) {
            release(state)
          }
        }
      }
      drain()
    }
  }
}
