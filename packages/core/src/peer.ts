import {
  maxRoomFrameBytes,
  maxQueuedDataFrames,
  pendingDataTimeoutMs
} from './data-limits'
import {
  all,
  alloc,
  candidateType,
  hasIceUrl,
  mkErr,
  peerDisconnectedMsg,
  resetTimer,
  toError,
  unrefTimer,
  warn
} from './utils'
import type {
  BaseRoomConfig,
  PeerHandle,
  PeerHandlers,
  Signal
} from './internal-types'

const iceTimeout = 15_000
const iceCandidateSettleMs = 150
const disconnectedCloseDelayMs = 5_000
const iceCandidateEvent = 'icecandidate'
const iceStateEvent = 'icegatheringstatechange'
const iceConnectionStateEvent = 'iceconnectionstatechange'
const offerType = 'offer'
const answerType = 'answer'
const outOfRangePattern = /out of range/i
const maxPendingRemoteCandidates = 128
const maxRemoteCandidateSdpLength = 8_192

type SdpDescription = {
  type: RTCSdpType
  sdp: string
}

export default (initiator: boolean, config: BaseRoomConfig): PeerHandle => {
  const {trickleIce, rtcConfig, rtcPolyfill, turnConfig} = config
  const iceServers = [
    ...(rtcConfig?.iceServers ?? defaultIceServers),
    ...(turnConfig ?? [])
  ]
  const pc = new (rtcPolyfill ?? RTCPeerConnection)({
    ...rtcConfig,
    iceServers
  })

  const handlers: PeerHandlers = {}
  const pendingIceGathering = new Set<() => void>()
  const pendingSignals: Signal[] = []
  const pendingData: ArrayBuffer[] = []
  let pendingDataTimer: ReturnType<typeof setTimeout> | null = null
  const shouldTrickleIce = trickleIce !== false
  const pendingRemoteCandidates: RTCIceCandidateInit[] = []
  const pendingStreams: MediaStream[] = []
  const streamSenders = new WeakMap<MediaStream, Set<RTCRtpSender>>()
  const trackSender = (stream: MediaStream, sender: RTCRtpSender): void => {
    let senders = streamSenders.get(stream)
    if (!senders) {
      senders = new Set()
      streamSenders.set(stream, senders)
    }
    senders.add(sender)
  }
  let resolveInitialOffer: ((signal: Signal | void) => void) | undefined
  let makingOffer = false
  let isSettingRemoteAnswerPending = false
  let dataChannel: RTCDataChannel | null = null
  let disconnectedCloseTimer: ReturnType<typeof setTimeout> | null = null
  let didEmitClose = false

  const settleInitialOffer = (signal?: Signal): void => {
    if (resolveInitialOffer) {
      resolveInitialOffer(signal)
      resolveInitialOffer = undefined
    }
  }

  const clearDisconnectedCloseTimer = (): null =>
    (disconnectedCloseTimer = resetTimer(disconnectedCloseTimer))

  const emitClose = (): void => {
    if (didEmitClose) {
      return
    }

    didEmitClose = true
    pendingIceGathering.forEach(finish => finish())
    pendingDataTimer = resetTimer(pendingDataTimer)
    pendingData.length = 0
    clearDisconnectedCloseTimer()
    handlers.close?.()
  }

  const emitSignal = (signal: Signal): void => {
    if (signal.type === offerType) {
      settleInitialOffer(signal)
      // getOffer() already hands pre-connection offers to the signaling strategy.
      if (!handlers.signal && !pc.remoteDescription) {
        return
      }
    }

    if (handlers.signal) {
      handlers.signal(signal)
    } else {
      pendingSignals.push(signal)
    }
  }

  const appendSignalHandler = (handler: (signal: Signal) => void): void => {
    const previousSignalHandler = handlers.signal

    handlers.signal = signal => {
      previousSignalHandler?.(signal)
      handler(signal)
    }

    if (pendingSignals.length > 0) {
      const queuedSignals = pendingSignals.splice(0)
      queuedSignals.forEach(signal => handlers.signal?.(signal))
    }
  }

  const localDescriptionSignal = (
    peerConnection: RTCPeerConnection
  ): SdpDescription => ({
    type: (peerConnection.localDescription?.type ?? offerType) as RTCSdpType,
    sdp: peerConnection.localDescription?.sdp ?? ''
  })

  const getRemoteUfrag = (): string | null =>
    pc.remoteDescription?.sdp?.match(/a=ice-ufrag:(\S+)/)?.[1] ?? null

  const canApplyRemoteCandidate = (candidate: RTCIceCandidateInit): boolean => {
    if (!pc.remoteDescription) {
      return false
    }
    const remoteMLineCount = (pc.remoteDescription.sdp?.match(/^m=/gm) ?? [])
      .length
    if (
      typeof candidate.sdpMLineIndex === 'number' &&
      remoteMLineCount > 0 &&
      candidate.sdpMLineIndex >= remoteMLineCount
    ) {
      return false
    }
    const remoteUfrag = getRemoteUfrag()
    return !(
      remoteUfrag &&
      candidate.usernameFragment &&
      candidate.usernameFragment !== remoteUfrag
    )
  }

  const addIceCandidateSafe = async (
    candidate: RTCIceCandidateInit
  ): Promise<boolean> => {
    try {
      await pc.addIceCandidate(candidate)
      return true
    } catch (err) {
      if (
        err instanceof Error &&
        outOfRangePattern.test(err.message) &&
        typeof candidate.sdpMLineIndex === 'number'
      ) {
        return false
      }
      throw err
    }
  }

  const queueRemoteCandidate = (candidate: RTCIceCandidateInit): void => {
    if (pendingRemoteCandidates.length >= maxPendingRemoteCandidates) {
      pendingRemoteCandidates.shift()
    }
    pendingRemoteCandidates.push(candidate)
  }

  const addRemoteCandidate = async (
    candidate: RTCIceCandidateInit
  ): Promise<void> => {
    if (
      !canApplyRemoteCandidate(candidate) ||
      !(await addIceCandidateSafe(candidate))
    ) {
      queueRemoteCandidate(candidate)
    }
  }

  const flushPendingRemoteCandidates = async (): Promise<void> => {
    if (!pc.remoteDescription || !pendingRemoteCandidates.length) {
      return
    }
    const remoteUfrag = getRemoteUfrag()
    const stillPending: RTCIceCandidateInit[] = []
    for (const candidate of pendingRemoteCandidates.splice(0)) {
      if (
        remoteUfrag &&
        candidate.usernameFragment &&
        candidate.usernameFragment !== remoteUfrag
      ) {
        continue
      }
      if (
        !canApplyRemoteCandidate(candidate) ||
        !(await addIceCandidateSafe(candidate))
      ) {
        stillPending.push(candidate)
      }
    }
    stillPending.forEach(queueRemoteCandidate)
  }

  const setupDataChannel = (channel: RTCDataChannel): void => {
    channel.binaryType = 'arraybuffer'
    channel.bufferedAmountLowThreshold = 0xffff
    const failData = (): void => {
      warn('excessive pre-handler data; disconnecting peer')
      channel.close()
      pc.close()
      emitClose()
    }
    channel.onmessage = e => {
      const data = e.data as ArrayBuffer
      if (didEmitClose) {
        return
      }
      if (
        (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) ||
        data.byteLength > maxRoomFrameBytes
      ) {
        failData()
        return
      }

      if (handlers.data) {
        handlers.data(data)
      } else {
        if (pendingData.length >= maxQueuedDataFrames) {
          failData()
          return
        }
        if (!pendingDataTimer) {
          pendingDataTimer = setTimeout(failData, pendingDataTimeoutMs)
          unrefTimer(pendingDataTimer)
        }
        pendingData.push(data)
      }
    }
    channel.onopen = () => handlers.connect?.()
    channel.onclose = emitClose
    channel.onerror = ({error}) => {
      if (
        didEmitClose ||
        (error?.errorDetail === 'sctp-failure' &&
          (error.sctpCauseCode === 12 ||
            /^User-Initiated Abort\b/.test(error.message)))
      ) {
        return
      }

      handlers.error?.(toError(error, 'data channel error'))
    }
  }

  const expectsTurnCandidate = hasIceUrl(iceServers, /^turns?:/i)
  const expectsStunCandidate =
    !expectsTurnCandidate && hasIceUrl(iceServers, /^stuns?:/i)
  const targetCandidatePattern = expectsTurnCandidate
    ? /\btyp relay\b/
    : expectsStunCandidate
      ? /\btyp (?:srflx|relay|prflx)\b/
      : /\btyp (?:host|srflx|relay|prflx)\b/
  const waitForIceGathering = async (
    peerConnection: RTCPeerConnection
  ): Promise<SdpDescription> => {
    await new Promise<void>(resolve => {
      let timeout: ReturnType<typeof setTimeout> | null = null
      let settleTimeout: ReturnType<typeof setTimeout> | null = null
      const finish = (): void => {
        resetTimer(timeout)
        resetTimer(settleTimeout)
        peerConnection.removeEventListener(iceStateEvent, checkState)
        peerConnection.removeEventListener(iceCandidateEvent, onCandidate)
        pendingIceGathering.delete(finish)
        resolve()
      }
      const scheduleSettle = (candidateLine = ''): void => {
        const sdp = `${peerConnection.localDescription?.sdp ?? ''}\n${candidateLine}`
        // Nontrickle peers cannot use candidates gathered after signaling.
        if (targetCandidatePattern.test(sdp)) {
          resetTimer(settleTimeout)
          settleTimeout = setTimeout(finish, iceCandidateSettleMs)
          unrefTimer(settleTimeout)
        }
      }
      const checkState = (): void => {
        if (peerConnection.iceGatheringState === 'complete' || didEmitClose) {
          finish()
        } else {
          scheduleSettle()
        }
      }
      const onCandidate = (event: Event): void => {
        const {candidate} = event as RTCPeerConnectionIceEvent
        if (candidate) {
          scheduleSettle(candidate.candidate)
        } else {
          finish()
        }
      }
      pendingIceGathering.add(finish)
      timeout = setTimeout(finish, iceTimeout)
      unrefTimer(timeout)
      peerConnection.addEventListener(iceStateEvent, checkState)
      peerConnection.addEventListener(iceCandidateEvent, onCandidate)
      checkState()
    })
    return localDescriptionSignal(peerConnection)
  }

  const readLocalDescription = (): SdpDescription | Promise<SdpDescription> =>
    shouldTrickleIce ? localDescriptionSignal(pc) : waitForIceGathering(pc)

  const emitLocalDescriptionSignal = async (): Promise<SdpDescription> => {
    const signal = await readLocalDescription()
    if (!didEmitClose) {
      emitSignal(signal)
    }
    return signal
  }

  if (initiator) {
    dataChannel = pc.createDataChannel('data')
    setupDataChannel(dataChannel)
  } else {
    pc.ondatachannel = ({channel}) => {
      dataChannel = channel
      setupDataChannel(channel)
    }
  }

  const createOffer = async (): Promise<Signal | void> => {
    if (
      pc.connectionState === 'closed' ||
      makingOffer ||
      pc.signalingState !== 'stable'
    ) {
      if (pc.connectionState === 'closed') {
        settleInitialOffer()
      }
      return
    }

    try {
      makingOffer = true
      await pc.setLocalDescription()
      const offer = await emitLocalDescriptionSignal()
      return offer
    } catch (err) {
      settleInitialOffer()
      handlers.error?.(toError(err, 'failed to create local offer'))
    } finally {
      makingOffer = false
    }
  }

  pc.onnegotiationneeded = () => {
    void createOffer()
  }

  pc.onicecandidate = ({candidate}) => {
    if (!shouldTrickleIce || !candidate) {
      return
    }

    const candidatePayload =
      typeof candidate.toJSON === 'function'
        ? candidate.toJSON()
        : {
            candidate: candidate.candidate,
            sdpMid: candidate.sdpMid,
            sdpMLineIndex: candidate.sdpMLineIndex,
            usernameFragment: candidate.usernameFragment
          }

    emitSignal({
      type: candidateType,
      sdp: JSON.stringify(candidatePayload)
    })
  }
  const isDisconnectedState = (): boolean =>
    pc.connectionState === 'disconnected' ||
    pc.iceConnectionState === 'disconnected'

  const handleConnectionStateChange = () => {
    const cs = pc.connectionState
    const is = pc.iceConnectionState
    if (
      cs === 'failed' ||
      cs === 'closed' ||
      is === 'failed' ||
      is === 'closed'
    ) {
      emitClose()
      return
    }

    if (
      cs === 'connected' ||
      cs === 'connecting' ||
      is === 'connected' ||
      is === 'completed' ||
      is === 'checking'
    ) {
      clearDisconnectedCloseTimer()
      return
    }

    if (isDisconnectedState() && !disconnectedCloseTimer) {
      disconnectedCloseTimer = setTimeout(() => {
        disconnectedCloseTimer = null
        if (isDisconnectedState()) {
          emitClose()
        }
      }, disconnectedCloseDelayMs)
      unrefTimer(disconnectedCloseTimer)
    }
  }

  pc.onconnectionstatechange = handleConnectionStateChange
  pc.addEventListener(iceConnectionStateEvent, handleConnectionStateChange)

  pc.ontrack = e => {
    const stream = e.streams[0]

    if (stream) {
      if (!handlers.stream) {
        pendingStreams.push(stream)
        return
      }

      handlers.stream(stream)
    }
  }
  const offerPromise = initiator
    ? new Promise<Signal | void>(res => {
        resolveInitialOffer = res
      })
    : Promise.resolve()

  if (initiator) {
    queueMicrotask(() => {
      if (
        !makingOffer &&
        pc.signalingState === 'stable' &&
        !pc.localDescription &&
        pc.connectionState !== 'closed'
      ) {
        void pc.onnegotiationneeded?.(new Event('negotiationneeded'))
      }
    })
  }

  return {
    connection: pc,

    get channel(): RTCDataChannel | null {
      return dataChannel
    },

    get isDead(): boolean {
      return pc.connectionState === 'closed'
    },

    getOffer: async (): Promise<Signal | void> => {
      if (!initiator) {
        return
      }

      if (resolveInitialOffer) {
        return offerPromise
      }

      if (pc.localDescription?.type === offerType) {
        return readLocalDescription()
      }

      return offerPromise
    },

    async signal(sdp: Signal): Promise<Signal | void> {
      if (sdp.type === candidateType) {
        if (sdp.sdp.length > maxRemoteCandidateSdpLength) {
          return
        }

        try {
          const candidate = JSON.parse(sdp.sdp) as RTCIceCandidateInit | null

          if (candidate && typeof candidate === 'object') {
            await addRemoteCandidate(candidate)
          }
        } catch (err) {
          handlers.error?.(toError(err, 'failed to parse remote candidate'))
        }

        return
      }

      if (
        dataChannel?.readyState === 'open' &&
        !sdp.sdp?.includes('a=rtpmap')
      ) {
        return
      }

      try {
        const rtcSdp: RTCSessionDescriptionInit = {...sdp}

        if (sdp.type === offerType) {
          const isCollision =
            makingOffer ||
            (pc.signalingState !== 'stable' && !isSettingRemoteAnswerPending)

          if (isCollision && initiator) {
            return
          }

          if (isCollision && pc.signalingState !== 'stable') {
            await all([
              pc.setLocalDescription({type: 'rollback'}),
              pc.setRemoteDescription(rtcSdp)
            ])
          } else {
            await pc.setRemoteDescription(rtcSdp)
          }

          await flushPendingRemoteCandidates()
          await pc.setLocalDescription()
          const answer = await emitLocalDescriptionSignal()

          return answer
        }

        if (sdp.type === answerType) {
          isSettingRemoteAnswerPending = true

          try {
            await pc.setRemoteDescription(rtcSdp)
            await flushPendingRemoteCandidates()
          } finally {
            isSettingRemoteAnswerPending = false
          }
        }
      } catch (err) {
        handlers.error?.(toError(err, 'failed to apply remote signal'))
      }
    },

    sendData: data => {
      if (
        pc.connectionState === 'closed' ||
        dataChannel?.readyState === 'closed'
      ) {
        throw mkErr(peerDisconnectedMsg)
      }
      dataChannel?.send(data as unknown as never)
    },

    destroy: () => {
      clearDisconnectedCloseTimer()
      settleInitialOffer()
      dataChannel?.close()
      pc.close()
      makingOffer = false
      isSettingRemoteAnswerPending = false
      emitClose()
    },

    setHandlers: newHandlers => {
      const {signal, ...restHandlers} = newHandlers
      Object.assign(handlers, restHandlers)

      if (handlers.data && pendingData.length > 0) {
        pendingDataTimer = resetTimer(pendingDataTimer)
        pendingData.splice(0).forEach(data => handlers.data?.(data))
      }

      if (signal) {
        appendSignalHandler(signal)
      }

      if (handlers.stream && pendingStreams.length > 0) {
        pendingStreams.splice(0).forEach(stream => handlers.stream?.(stream))
      }
    },

    addStream: stream => {
      stream.getTracks().forEach(track => {
        const sender = pc.addTrack(track, stream)
        if (sender) {
          trackSender(stream, sender)
        }
      })
    },

    removeStream: stream => {
      const senders = streamSenders.get(stream)
      if (senders) {
        streamSenders.delete(stream)
        senders.forEach(sender => pc.removeTrack(sender))
        return
      }
      const tracks = stream.getTracks()
      pc.getSenders().forEach(sender => {
        if (sender.track && tracks.includes(sender.track)) {
          pc.removeTrack(sender)
        }
      })
    },

    addTrack: (track, stream) => {
      const sender = pc.addTrack(track, stream)
      if (sender && stream) {
        trackSender(stream, sender)
      }
    },

    removeTrack: (track, stream) => {
      const sender = pc.getSenders().find(s => s.track === track)

      if (sender) {
        if (stream) {
          streamSenders.get(stream)?.delete(sender)
        }
        pc.removeTrack(sender)
      }
    },

    replaceTrack: (oldTrack, newTrack) => {
      const sender = pc.getSenders().find(s => s.track === oldTrack)

      if (sender) {
        return sender.replaceTrack(newTrack)
      }

      return undefined
    }
  }
}

export const defaultIceServers: RTCIceServer[] = [
  ...alloc(3, (_, i) => `stun:stun${i || ''}.l.google.com:19302`),
  'stun:stun.cloudflare.com:3478'
].map(url => ({urls: url}))
