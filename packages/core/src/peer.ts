import {
  maxBulkFrameBytes,
  maxQueuedDataFrames,
  maxRoomFrameBytes,
  pendingDataTimeoutMs
} from './data-limits'
import type {
  BaseRoomConfig,
  PeerHandle,
  Signal,
  Timeout
} from './internal-types'
import {
  all,
  alloc,
  candidateType,
  hasIceUrl,
  mkErr,
  peerDisconnectedMsg,
  resetTimer,
  toError,
  unreachable,
  unrefTimer,
  warn
} from './utils'

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

type PeerLifecycleState =
  | {readonly phase: 'open'}
  | {readonly phase: 'disconnected-grace'; readonly timer: Timeout}
  | {readonly phase: 'closed'}

type NegotiationState =
  | {readonly phase: 'idle'}
  | {readonly phase: 'making-offer'; readonly gen: number}
  | {readonly phase: 'applying-remote-answer'}

type InboundDataChannelState =
  | {readonly phase: 'unbound-idle'}
  | {
      readonly phase: 'unbound-buffering'
      readonly queue: ArrayBuffer[]
      readonly deadlineTimer: Timeout
    }
  | {readonly phase: 'bound'; readonly handler: (data: ArrayBuffer) => void}
  | {readonly phase: 'closed'}

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

  let connectHandler: (() => void) | undefined
  let closeHandler: (() => void) | undefined
  let errorHandler: ((err: Error) => void) | undefined

  const pendingIceGathering = new Set<() => void>()
  const shouldTrickleIce = trickleIce !== false
  const pendingRemoteCandidates: RTCIceCandidateInit[] = []
  let activeCandidateFlush: Promise<void> | null = null
  const streamSenders = new WeakMap<MediaStream, Set<RTCRtpSender>>()

  const trackSender = (stream: MediaStream, sender: RTCRtpSender): void => {
    let senders = streamSenders.get(stream)
    if (!senders) {
      senders = new Set()
      streamSenders.set(stream, senders)
    }
    senders.add(sender)
  }

  let lifecycle: PeerLifecycleState = {phase: 'open'}
  let negotiation: NegotiationState = {phase: 'idle'}
  let offerGeneration = 0
  let dataState: InboundDataChannelState = {phase: 'unbound-idle'}
  let signalHandler: ((signal: Signal) => void) | undefined
  const pendingSignals: Signal[] = []
  let streamHandler: ((stream: MediaStream) => void) | undefined
  const pendingStreams: MediaStream[] = []
  let dataChannel: RTCDataChannel | null = null

  let settledOffer: Signal | undefined
  let resolveInitialOffer: ((signal: Signal | void) => void) | null = null
  const initialOfferP = initiator
    ? new Promise<Signal | void>(resolve => {
        resolveInitialOffer = resolve
      })
    : undefined

  const settleInitialOffer = (signal?: Signal): void => {
    if (resolveInitialOffer) {
      const resolve = resolveInitialOffer
      resolveInitialOffer = null
      settledOffer = signal
      resolve(signal)
    }
  }

  const clearDisconnectedGrace = (): void => {
    if (lifecycle.phase === 'disconnected-grace') {
      resetTimer(lifecycle.timer)
      lifecycle = {phase: 'open'}
    }
  }

  const emitClose = (): void => {
    if (lifecycle.phase === 'closed') {
      return
    }
    if (lifecycle.phase === 'disconnected-grace') {
      resetTimer(lifecycle.timer)
    }
    lifecycle = {phase: 'closed'}
    offerGeneration += 1
    negotiation = {phase: 'idle'}
    settleInitialOffer()

    if (dataState.phase === 'unbound-buffering') {
      resetTimer(dataState.deadlineTimer)
      dataState.queue.length = 0
    }
    dataState = {phase: 'closed'}
    signalHandler = undefined
    pendingSignals.length = 0
    streamHandler = undefined
    pendingStreams.length = 0
    pendingRemoteCandidates.length = 0
    pendingIceGathering.forEach(finish => finish())
    closeHandler?.()
  }

  const isClosed = (): boolean => {
    if (lifecycle.phase !== 'closed' && pc.connectionState === 'closed') {
      emitClose()
    }
    return lifecycle.phase === 'closed'
  }

  const emitSignal = (signal: Signal): void => {
    if (isClosed()) {
      return
    }
    if (signal.type === offerType) {
      const wasInitialOfferPending = resolveInitialOffer !== null
      settleInitialOffer(signal)
      // getOffer() already hands pre-connection offers to the signaling strategy.
      if (wasInitialOfferPending && !signalHandler && !pc.remoteDescription) {
        return
      }
    }

    if (signalHandler) {
      signalHandler(signal)
    } else {
      pendingSignals.push(signal)
    }
  }

  const appendSignalHandler = (handler: (signal: Signal) => void): void => {
    if (isClosed()) {
      return
    }
    if (signalHandler) {
      const prev = signalHandler
      signalHandler = sig => {
        prev(sig)
        handler(sig)
      }
      return
    }
    signalHandler = handler
    for (const queued of pendingSignals.splice(0)) {
      if (isClosed() || !signalHandler) {
        break
      }
      signalHandler(queued)
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
    if (isClosed()) {
      return
    }
    if (pendingRemoteCandidates.length >= maxPendingRemoteCandidates) {
      pendingRemoteCandidates.shift()
    }
    pendingRemoteCandidates.push(candidate)
  }

  const flushPendingRemoteCandidates = async (): Promise<void> => {
    if (isClosed() || !pc.remoteDescription) {
      return
    }
    if (activeCandidateFlush) {
      await activeCandidateFlush
      if (isClosed() || !pc.remoteDescription) {
        return
      }
    }
    if (!pendingRemoteCandidates.length) {
      return
    }
    const runFlush = (async () => {
      const stillPending: RTCIceCandidateInit[] = []
      try {
        while (
          !isClosed() &&
          pc.remoteDescription &&
          pendingRemoteCandidates.length > 0
        ) {
          const remoteUfrag = getRemoteUfrag()
          for (const candidate of pendingRemoteCandidates.splice(0)) {
            if (isClosed()) {
              return
            }
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
        }
      } finally {
        if (!isClosed() && stillPending.length > 0) {
          const tail = pendingRemoteCandidates.splice(0)
          for (const item of [...stillPending, ...tail]) {
            queueRemoteCandidate(item)
          }
        }
        activeCandidateFlush = null
      }
    })()
    activeCandidateFlush = runFlush
    await runFlush
  }

  const addRemoteCandidate = async (
    candidate: RTCIceCandidateInit
  ): Promise<void> => {
    if (activeCandidateFlush || !canApplyRemoteCandidate(candidate)) {
      queueRemoteCandidate(candidate)
      return
    }
    if (!(await addIceCandidateSafe(candidate))) {
      queueRemoteCandidate(candidate)
    }
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
      if (dataChannel !== channel || dataState.phase === 'closed') {
        return
      }
      const data = e.data as ArrayBuffer
      const maxFrameBytes =
        dataState.phase === 'bound' ? maxBulkFrameBytes : maxRoomFrameBytes
      if (
        (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) ||
        data.byteLength > maxFrameBytes
      ) {
        failData()
        return
      }

      switch (dataState.phase) {
        case 'bound':
          dataState.handler(data)
          break
        case 'unbound-idle': {
          const deadlineTimer = setTimeout(failData, pendingDataTimeoutMs)
          unrefTimer(deadlineTimer)
          dataState = {
            phase: 'unbound-buffering',
            queue: [data],
            deadlineTimer
          }
          break
        }
        case 'unbound-buffering': {
          if (dataState.queue.length >= maxQueuedDataFrames) {
            failData()
            return
          }
          dataState.queue.push(data)
          break
        }
        default:
          unreachable(dataState)
      }
    }
    channel.onopen = () => {
      if (dataChannel === channel && !isClosed()) {
        connectHandler?.()
      }
    }
    channel.onclose = () => {
      if (dataChannel === channel) {
        emitClose()
      }
    }
    channel.onerror = ({error}) => {
      if (
        dataChannel !== channel ||
        isClosed() ||
        (error?.errorDetail === 'sctp-failure' &&
          (error.sctpCauseCode === 12 ||
            /^User-Initiated Abort\b/.test(error.message)))
      ) {
        return
      }

      errorHandler?.(toError(error, 'data channel error'))
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
      let done = false
      let settleTimeout: Timeout | null = null
      const finish = (): void => {
        if (done) {
          return
        }
        done = true
        resetTimer(timeout)
        resetTimer(settleTimeout)
        peerConnection.removeEventListener(iceStateEvent, checkState)
        peerConnection.removeEventListener(iceCandidateEvent, onCandidate)
        pendingIceGathering.delete(finish)
        resolve()
      }
      const scheduleSettle = (candidateLine = ''): void => {
        if (done) {
          return
        }
        const sdp = `${peerConnection.localDescription?.sdp ?? ''}\n${candidateLine}`
        // Nontrickle peers cannot use candidates gathered after signaling.
        if (targetCandidatePattern.test(sdp)) {
          resetTimer(settleTimeout)
          settleTimeout = setTimeout(finish, iceCandidateSettleMs)
          unrefTimer(settleTimeout)
        }
      }
      const checkState = (): void => {
        if (peerConnection.iceGatheringState === 'complete' || isClosed()) {
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
      const timeout = setTimeout(finish, iceTimeout)
      unrefTimer(timeout)
      pendingIceGathering.add(finish)
      peerConnection.addEventListener(iceStateEvent, checkState)
      peerConnection.addEventListener(iceCandidateEvent, onCandidate)
      checkState()
    })
    return localDescriptionSignal(peerConnection)
  }

  const readLocalDescription = (): SdpDescription | Promise<SdpDescription> =>
    shouldTrickleIce ? localDescriptionSignal(pc) : waitForIceGathering(pc)

  const emitLocalDescriptionSignal = async (
    expectedGen?: number
  ): Promise<SdpDescription | undefined> => {
    const signal = await readLocalDescription()
    if (
      isClosed() ||
      (expectedGen !== undefined && offerGeneration !== expectedGen)
    ) {
      return undefined
    }
    emitSignal(signal)
    return signal
  }

  if (initiator) {
    dataChannel = pc.createDataChannel('data')
    setupDataChannel(dataChannel)
  } else {
    pc.ondatachannel = ({channel}) => {
      if (dataChannel && dataChannel !== channel) {
        dataChannel.onopen =
          dataChannel.onclose =
          dataChannel.onmessage =
          dataChannel.onerror =
            null
        dataChannel.close()
      }
      dataChannel = channel
      setupDataChannel(channel)
    }
  }

  const createOffer = async (): Promise<Signal | void> => {
    if (
      isClosed() ||
      negotiation.phase !== 'idle' ||
      pc.signalingState !== 'stable'
    ) {
      if (isClosed()) {
        settleInitialOffer()
      }
      return
    }

    const gen = ++offerGeneration
    negotiation = {phase: 'making-offer', gen}
    try {
      await pc.setLocalDescription()
      if (isClosed() || offerGeneration !== gen) {
        return
      }
      return await emitLocalDescriptionSignal(gen)
    } catch (err) {
      if (offerGeneration !== gen) {
        return
      }
      settleInitialOffer()
      errorHandler?.(toError(err, 'failed to create local offer'))
    } finally {
      if (negotiation.phase === 'making-offer' && negotiation.gen === gen) {
        negotiation = {phase: 'idle'}
      }
    }
  }

  pc.onnegotiationneeded = () => {
    void createOffer()
  }

  pc.onicecandidate = ({candidate}) => {
    if (!shouldTrickleIce || !candidate || isClosed()) {
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

  const handleConnectionStateChange = (): void => {
    if (lifecycle.phase === 'closed') {
      return
    }
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
      clearDisconnectedGrace()
      return
    }

    if (isDisconnectedState() && lifecycle.phase === 'open') {
      const timer = setTimeout(() => {
        if (lifecycle.phase !== 'disconnected-grace') {
          return
        }
        lifecycle = {phase: 'open'}
        if (isDisconnectedState()) {
          emitClose()
        }
      }, disconnectedCloseDelayMs)
      unrefTimer(timer)
      lifecycle = {phase: 'disconnected-grace', timer}
    }
  }

  pc.onconnectionstatechange = handleConnectionStateChange
  pc.addEventListener(iceConnectionStateEvent, handleConnectionStateChange)

  pc.ontrack = e => {
    const stream = e.streams[0]
    if (stream && !isClosed()) {
      if (streamHandler) {
        streamHandler(stream)
      } else {
        pendingStreams.push(stream)
      }
    }
  }

  if (initiator) {
    queueMicrotask(() => {
      if (
        !isClosed() &&
        negotiation.phase === 'idle' &&
        pc.signalingState === 'stable' &&
        !pc.localDescription
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
      return isClosed()
    },

    getOffer: async (): Promise<Signal | void> => {
      if (!initiator) {
        return undefined
      }
      if (resolveInitialOffer !== null) {
        return initialOfferP
      }
      if (settledOffer && !pc.remoteDescription) {
        return settledOffer
      }
      return pc.localDescription?.type === offerType
        ? readLocalDescription()
        : settledOffer
    },

    async signal(sdp: Signal): Promise<Signal | void> {
      if (isClosed()) {
        return
      }
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
          errorHandler?.(toError(err, 'failed to parse remote candidate'))
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
            negotiation.phase === 'making-offer' ||
            (pc.signalingState !== 'stable' &&
              negotiation.phase !== 'applying-remote-answer')

          if (isCollision && initiator) {
            return
          }

          offerGeneration += 1
          if (negotiation.phase === 'making-offer') {
            negotiation = {phase: 'idle'}
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
          return await emitLocalDescriptionSignal()
        }

        if (sdp.type === answerType) {
          negotiation = {phase: 'applying-remote-answer'}

          try {
            await pc.setRemoteDescription(rtcSdp)
            await flushPendingRemoteCandidates()
          } finally {
            if (negotiation.phase === 'applying-remote-answer') {
              negotiation = {phase: 'idle'}
            }
          }
        }
      } catch (err) {
        if (!isClosed()) {
          errorHandler?.(toError(err, 'failed to apply remote signal'))
        }
      }
    },

    sendData: data => {
      if (
        isClosed() ||
        !dataChannel ||
        dataChannel.readyState === 'closing' ||
        dataChannel.readyState === 'closed'
      ) {
        throw mkErr(peerDisconnectedMsg)
      }
      dataChannel.send(data as unknown as never)
    },

    destroy: () => {
      clearDisconnectedGrace()
      settleInitialOffer()
      dataChannel?.close()
      if (pc.connectionState !== 'closed') {
        pc.close()
      }
      emitClose()
    },

    setHandlers: newHandlers => {
      if ('connect' in newHandlers) {
        connectHandler = newHandlers.connect
      }
      if ('close' in newHandlers) {
        closeHandler = newHandlers.close
      }
      if ('error' in newHandlers) {
        errorHandler = newHandlers.error
      }

      if ('data' in newHandlers && dataState.phase !== 'closed') {
        const nextDataHandler = newHandlers.data
        if (nextDataHandler) {
          let queuedData: ArrayBuffer[] = []
          if (dataState.phase === 'unbound-buffering') {
            resetTimer(dataState.deadlineTimer)
            queuedData = dataState.queue.splice(0)
          }
          dataState = {phase: 'bound', handler: nextDataHandler}
          for (const frame of queuedData) {
            if (dataState.phase !== 'bound') {
              break
            }
            dataState.handler(frame)
          }
        } else {
          if (dataState.phase === 'unbound-buffering') {
            resetTimer(dataState.deadlineTimer)
          }
          dataState = {phase: 'unbound-idle'}
        }
      }

      if (newHandlers.signal) {
        appendSignalHandler(newHandlers.signal)
      }

      if ('stream' in newHandlers && !isClosed()) {
        streamHandler = newHandlers.stream
        if (streamHandler) {
          for (const stream of pendingStreams.splice(0)) {
            if (isClosed() || !streamHandler) {
              break
            }
            streamHandler(stream)
          }
        }
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
