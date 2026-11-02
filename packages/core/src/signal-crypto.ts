import type {PeerState, SignalContext, SignalPeer} from './internal-types'
import type {BaseRoomConfig, PeerHandle, Signal} from './types'
import {fromJson, toJson} from './utils'

const signalKeys = ['offer', 'answer', 'candidate'] as const
export const maxSignalMessageChars: number = 128 * 1024
export const maxSignalPeerIdChars = 64
export const maxSignalOfferIdChars = 64
export const maxSignalSdpChars: number = 64 * 1024
export const maxSignalCandidateChars = 4_096
export const maxTrackedSignalPeers = 256
export const maxPendingPeerConnections = 64
const signalIdPattern = /^[\w.~:!-]{1,64}$/

export const buildSignalAad = (
  type: Signal['type'],
  peerId: string,
  offerId: string
): string => `${type}|${peerId}|${offerId}`

export const isValidSignalPeerId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= maxSignalPeerIdChars &&
  signalIdPattern.test(value)

export const isValidSignalOfferId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= maxSignalOfferIdChars &&
  signalIdPattern.test(value)

const toPayload = (msg: unknown): Record<string, unknown> | null => {
  if (typeof msg === 'string') {
    if (msg.length > maxSignalMessageChars) {
      return null
    }
    try {
      const parsed = fromJson<unknown>(msg)

      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null
    } catch {
      return null
    }
  }

  return msg && typeof msg === 'object' && !Array.isArray(msg)
    ? (msg as Record<string, unknown>)
    : null
}

const getString = (
  payload: Record<string, unknown>,
  key: string
): string | undefined =>
  typeof payload[key] === 'string' && payload[key] ? payload[key] : undefined

export const isPeerHandle = (value: unknown): value is PeerHandle =>
  Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as PeerHandle).signal === 'function' &&
    typeof (value as PeerHandle).destroy === 'function' &&
    typeof (value as PeerHandle).setHandlers === 'function'
  )

const hasInvalidSignalField = (
  payload: Record<string, unknown>,
  isStringMessage = false
): boolean => {
  const hasSignalContent = signalKeys.some(key => key in payload)
  return (
    ('peerId' in payload && !isValidSignalPeerId(payload['peerId'])) ||
    (hasSignalContent && !isValidSignalOfferId(payload['offerId'])) ||
    ('offerId' in payload &&
      payload['offerId'] !== undefined &&
      !isValidSignalOfferId(payload['offerId'])) ||
    ('passive' in payload &&
      payload['passive'] !== undefined &&
      typeof payload['passive'] !== 'boolean') ||
    signalKeys.some(key => {
      if (!(key in payload)) {
        return false
      }
      const val = payload[key]
      if (typeof val !== 'string' || val === '') {
        return true
      }
      const maxLen =
        key === 'candidate' ? maxSignalCandidateChars : maxSignalSdpChars
      return val.length > maxLen
    }) ||
    ('peer' in payload &&
      (isStringMessage ||
        (payload['peer'] !== undefined && !isPeerHandle(payload['peer']))))
  )
}

export type ParsedSignalEnvelope = {
  peerId: string
  offer: string | undefined
  answer: string | undefined
  candidate: string | undefined
  offerId: string | undefined
  peer: PeerHandle | undefined
}

export const parseSignalEnvelope = (
  msg: unknown
): ParsedSignalEnvelope | null => {
  const payload = toPayload(msg)

  if (!payload || hasInvalidSignalField(payload, typeof msg === 'string')) {
    return null
  }

  return {
    peerId: getString(payload, 'peerId') ?? '',
    offer: getString(payload, 'offer'),
    answer: getString(payload, 'answer'),
    candidate: getString(payload, 'candidate'),
    offerId: getString(payload, 'offerId'),
    peer: isPeerHandle(payload['peer']) ? payload['peer'] : undefined
  }
}

export const publishCipheredSignalingMessage = (
  ctx: SignalContext,
  signal: Signal,
  senderPeerId: string,
  offerId: string,
  peerTopic: string,
  signalPeer: SignalPeer,
  buildPayload: (encryptedSdp: string) => Record<string, unknown>,
  stillValid: () => boolean
): void => {
  void ctx
    .toCipher(signal, senderPeerId, offerId)
    .then(encryptedSignal => {
      if (ctx.isLeaving() || !stillValid()) {
        return
      }

      void signalPeer(peerTopic, toJson(buildPayload(encryptedSignal.sdp)))
    })
    .catch(() => {})
}

const hasTurnServer = (config: BaseRoomConfig): boolean => {
  const iceServers = [
    ...(config.turnConfig ?? []),
    ...(config.rtcConfig?.iceServers ?? [])
  ]

  return iceServers.some(({urls}) => {
    const urlList = Array.isArray(urls) ? urls : [urls]

    return urlList.some(url => /^turns?:/i.test(url))
  })
}

const getSdpExchangeConnectionError = (
  peerId: string,
  turnConfigured: boolean
): string =>
  `could not connect to peer ${peerId} after exchanging SDP; ${
    turnConfigured
      ? 'verify TURN server URLs and credentials'
      : 'configure TURN via turnConfig or rtcConfig.iceServers'
  }`

export const badPasswordMsg = (kind: string): string =>
  `incorrect password decrypting ${kind}`

export const reportSdpExchangeConnectionFailure = (
  ctx: SignalContext,
  state: PeerState,
  peerId: string
): void => {
  if (ctx.isLeaving() || state.connectedPeer || state.connectionErrorReported) {
    return
  }

  state.connectionErrorReported = true
  const turnConfigured = hasTurnServer(ctx.config)
  ctx.onError?.({
    code: 'peer-connect-failed',
    peerId,
    turnConfigured,
    message: getSdpExchangeConnectionError(peerId, turnConfigured),
    appId: ctx.appId,
    roomId: ctx.roomId
  })
}
