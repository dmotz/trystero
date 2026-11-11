import {maxActionFrameBytes, maxBulkFrameBytes} from './data-limits'
import type {PeerHandle, Timeout} from './internal-types'
import {noOp, resetTimer, unreachable, unrefTimer} from './utils'

export type PeerDataTransport = {
  readonly isOpen: boolean
  readonly bufferedAmount: number
  readonly maxBulkFrameBytes?: number
  sendFrame: (bytes: Uint8Array, transferId?: number, isOffer?: boolean) => void
  waitForDrain: (signal?: AbortSignal) => boolean | Promise<boolean>
  close?: () => void
}

const backpressureWaitTimeoutMs = 10_000

type FlushTeardownState =
  | {
      readonly phase: 'grace-hold'
      readonly graceTimer: Timeout
      readonly capTimer: Timeout
    }
  | {
      readonly phase: 'draining'
      readonly capTimer: Timeout
    }
  | {readonly phase: 'done'}

export const waitForBufferedAmountLow = (
  channel: RTCDataChannel,
  signal?: AbortSignal,
  timeoutMs: number = backpressureWaitTimeoutMs
): boolean | Promise<boolean> => {
  if (signal?.aborted) {
    return false
  }
  if (
    channel.readyState !== 'open' ||
    channel.bufferedAmount <= (channel.bufferedAmountLowThreshold ?? 0)
  ) {
    return channel.readyState === 'open'
  }

  return new Promise<boolean>(res => {
    let settled = false
    let timeout: Timeout | null = null
    const abortCleanup = new AbortController()
    const onBufferLow = (): void => finish(true)
    const onCloseOrError = (): void => finish(false)
    const toggleChannel = (
      op: 'addEventListener' | 'removeEventListener'
    ): void => {
      channel[op]('bufferedamountlow', onBufferLow)
      channel[op]('close', onCloseOrError)
      channel[op]('error', onCloseOrError)
    }

    const finish = (didDrain: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      toggleChannel('removeEventListener')
      abortCleanup.abort()
      timeout = resetTimer(timeout)
      res(didDrain)
    }

    timeout = setTimeout(() => finish(false), timeoutMs)
    unrefTimer(timeout)

    toggleChannel('addEventListener')
    signal?.addEventListener('abort', onCloseOrError, {
      once: true,
      signal: abortCleanup.signal
    })

    if (channel.readyState !== 'open' || signal?.aborted) {
      finish(false)
      return
    }

    if (channel.bufferedAmount <= (channel.bufferedAmountLowThreshold ?? 0)) {
      finish(true)
    }
  })
}

export const destroyAfterFlush = (
  peer: PeerHandle,
  graceMs = 40,
  capMs = 150,
  onDone?: () => void
): (() => void) => {
  if (peer.isDead) {
    onDone?.()
    return noOp
  }
  peer.setHandlers({
    connect: noOp,
    data: noOp,
    stream: noOp,
    close: noOp,
    error: noOp
  })
  const channel = peer.channel
  if (!channel || channel.readyState !== 'open') {
    peer.destroy()
    onDone?.()
    return noOp
  }

  const hasEventTarget = typeof channel.addEventListener === 'function'
  let state: FlushTeardownState

  const finish = (): void => {
    switch (state.phase) {
      case 'done':
        return
      case 'grace-hold':
        resetTimer(state.graceTimer)
        resetTimer(state.capTimer)
        break
      case 'draining':
        resetTimer(state.capTimer)
        break
      default:
        unreachable(state)
    }
    state = {phase: 'done'}
    if (hasEventTarget) {
      channel.removeEventListener('bufferedamountlow', maybeFinish)
      channel.removeEventListener('close', finish)
      channel.removeEventListener('error', finish)
    }
    peer.destroy()
    onDone?.()
  }

  const isBufferDrained = (): boolean =>
    channel.readyState !== 'open' ||
    typeof channel.bufferedAmount !== 'number' ||
    channel.bufferedAmount <= 0

  const maybeFinish = (): void => {
    if (state.phase === 'draining' && isBufferDrained()) {
      finish()
    }
  }

  const capTimer = setTimeout(finish, Math.max(graceMs, capMs))
  unrefTimer(capTimer)

  if (graceMs > 0) {
    const graceTimer = setTimeout(() => {
      if (state.phase === 'grace-hold') {
        state = {phase: 'draining', capTimer: state.capTimer}
        maybeFinish()
      }
    }, graceMs)
    unrefTimer(graceTimer)
    state = {phase: 'grace-hold', graceTimer, capTimer}
  } else {
    state = {phase: 'draining', capTimer}
  }

  if (hasEventTarget) {
    try {
      channel.bufferedAmountLowThreshold = 0
    } catch {
      // Ignore read-only polyfill implementations
    }
    channel.addEventListener('bufferedamountlow', maybeFinish)
    channel.addEventListener('close', finish)
    channel.addEventListener('error', finish)
  }

  if (graceMs <= 0) {
    maybeFinish()
  }

  return finish
}

export const createDirectPeerTransport = (
  peer: PeerHandle,
  isCurrent?: () => boolean
): PeerDataTransport => ({
  get isOpen(): boolean {
    const channelState = peer.channel?.readyState
    return (
      (!isCurrent || isCurrent()) &&
      !peer.isDead &&
      channelState !== 'closing' &&
      channelState !== 'closed'
    )
  },
  get bufferedAmount(): number {
    return typeof peer.channel?.bufferedAmount === 'number'
      ? peer.channel.bufferedAmount
      : 0
  },
  get maxBulkFrameBytes(): number {
    const sctpMax = (
      peer.connection as {sctp?: {maxMessageSize?: number}} | undefined
    )?.sctp?.maxMessageSize
    return typeof sctpMax === 'number' &&
      Number.isFinite(sctpMax) &&
      sctpMax >= maxBulkFrameBytes
      ? maxBulkFrameBytes
      : maxActionFrameBytes
  },
  sendFrame: bytes => {
    peer.sendData(bytes)
  },
  waitForDrain: signal => {
    if (signal?.aborted || (isCurrent && !isCurrent()) || peer.isDead) {
      return false
    }
    if (!peer.channel) {
      return true
    }
    return waitForBufferedAmountLow(peer.channel, signal)
  },
  close: () => peer.destroy()
})
