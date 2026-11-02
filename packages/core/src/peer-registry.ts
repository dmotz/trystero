import type {PeerHandle} from './types'
import {resetTimer, unrefTimer} from './utils'

export type PeerDataTransport = {
  readonly isOpen: boolean
  readonly bufferedAmount: number
  sendFrame: (bytes: Uint8Array, transferId?: number, isOffer?: boolean) => void
  waitForDrain: (signal?: AbortSignal) => boolean | Promise<boolean>
  close?: () => void
}

const backpressureWaitTimeoutMs = 10_000

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
    channel.bufferedAmount <= channel.bufferedAmountLowThreshold
  ) {
    return channel.readyState === 'open'
  }

  return new Promise<boolean>(res => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null

    const onBufferLow = (): void => finish(true)
    const onCloseOrError = (): void => finish(false)
    const toggle = (
      op: 'addEventListener' | 'removeEventListener',
      sigOp: 'addEventListener' | 'removeEventListener'
    ): void => {
      channel[op]('bufferedamountlow', onBufferLow)
      channel[op]('close', onCloseOrError)
      channel[op]('error', onCloseOrError)
      signal?.[sigOp]('abort', onCloseOrError)
    }

    const finish = (didDrain: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      toggle('removeEventListener', 'removeEventListener')
      resetTimer(timeout)
      res(didDrain)
    }

    toggle('addEventListener', 'addEventListener')

    timeout = setTimeout(() => finish(false), timeoutMs)
    unrefTimer(timeout)

    if (channel.readyState !== 'open' || signal?.aborted) {
      finish(false)
      return
    }

    if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) {
      finish(true)
    }
  })
}

export const createDirectPeerTransport = (
  peer: PeerHandle,
  isCurrent?: () => boolean
): PeerDataTransport => ({
  get isOpen(): boolean {
    return (
      (!isCurrent || isCurrent()) &&
      !peer.isDead &&
      peer.channel?.readyState !== 'closed'
    )
  },
  get bufferedAmount(): number {
    return typeof peer.channel?.bufferedAmount === 'number'
      ? peer.channel.bufferedAmount
      : 0
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
