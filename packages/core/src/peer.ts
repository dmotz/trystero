import {all, alloc} from './utils'
import type {BaseRoomConfig, PeerHandle, PeerHandlers, Signal} from './types'

const iceTimeout = 15_000
const disconnectedCloseDelayMs = 5_000
const iceStateEvent = 'icegatheringstatechange'
const offerType = 'offer'
const answerType = 'answer'

type SdpDescription = {
  type: RTCSdpType
  sdp: string
}

const rewriteMdnsCandidatesToLoopback = (sdp: string): string =>
  sdp.replace(/ (\S+\.local) (\d+) typ host/g, ' 127.0.0.1 $2 typ host')

export default (
  initiator: boolean,
  {
    rtcConfig,
    rtcPolyfill,
    turnConfig,
    _test_only_mdnsHostFallbackToLoopback
  }: BaseRoomConfig
): PeerHandle => {
  const pc = new (rtcPolyfill ?? RTCPeerConnection)({
    iceServers: defaultIceServers.concat(turnConfig ?? []),
    ...rtcConfig
  })

  const handlers: PeerHandlers = {}
  const pendingSignals: Signal[] = []
  const pendingData: ArrayBuffer[] = []
  const pendingTracks: Array<{track: MediaStreamTrack; stream: MediaStream}> =
    []
  let makingOffer = false
  let isSettingRemoteAnswerPending = false
  let dataChannel: RTCDataChannel | null = null
  let disconnectedCloseTimer: ReturnType<typeof setTimeout> | null = null
  let didEmitClose = false

  const clearDisconnectedCloseTimer = (): void => {
    if (disconnectedCloseTimer) {
      clearTimeout(disconnectedCloseTimer)
      disconnectedCloseTimer = null
    }
  }

  const emitClose = (): void => {
    if (didEmitClose) {
      return
    }

    didEmitClose = true
    clearDisconnectedCloseTimer()
    handlers.close?.()
  }

  const emitSignal = (signal: Signal): void => {
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

  const setupDataChannel = (channel: RTCDataChannel): void => {
    channel.binaryType = 'arraybuffer'
    channel.bufferedAmountLowThreshold = 0xffff
    channel.onmessage = e => {
      const data = e.data as ArrayBuffer

      if (handlers.data) {
        handlers.data(data)
      } else {
        pendingData.push(data)
      }
    }
    channel.onopen = () => handlers.connect?.()
    channel.onclose = emitClose
    channel.onerror = err => handlers.error?.(err)
  }

  const waitForIceGathering = async (
    peerConnection: RTCPeerConnection
  ): Promise<SdpDescription> => {
    let timeout: ReturnType<typeof setTimeout> | null = null

    try {
      await Promise.race([
        new Promise<void>(res => {
          const checkState = (): void => {
            if (peerConnection.iceGatheringState === 'complete') {
              peerConnection.removeEventListener(iceStateEvent, checkState)
              res()
            }
          }

          peerConnection.addEventListener(iceStateEvent, checkState)
          checkState()
        }),
        new Promise<void>(res => {
          timeout = setTimeout(res, iceTimeout)
        })
      ])
    } finally {
      if (timeout) {
        clearTimeout(timeout)
      }
    }

    const localSdp = peerConnection.localDescription?.sdp ?? ''

    return {
      type: (peerConnection.localDescription?.type ?? offerType) as RTCSdpType,
      sdp: _test_only_mdnsHostFallbackToLoopback
        ? rewriteMdnsCandidatesToLoopback(localSdp)
        : localSdp
    }
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

  const createOffer = async (restartIce = false): Promise<Signal | void> => {
    if (pc.connectionState === 'closed') {
      return
    }

    try {
      makingOffer = true

      if (restartIce) {
        if (
          pc.signalingState !== 'stable' &&
          pc.signalingState !== 'closed' &&
          pc.localDescription?.type === offerType
        ) {
          await pc.setLocalDescription({type: 'rollback'})
        }

        if (typeof pc.restartIce === 'function') {
          pc.restartIce()
        }
      }

      await pc.setLocalDescription(
        restartIce ? await pc.createOffer({iceRestart: true}) : undefined
      )
      const offer = await waitForIceGathering(pc)
      emitSignal(offer)
      return offer
    } catch (err) {
      handlers.error?.(err)
    } finally {
      makingOffer = false
    }
  }

  pc.onnegotiationneeded = async () => createOffer(false)

  pc.onconnectionstatechange = () => {
    if (
      pc.connectionState === 'connected' ||
      pc.connectionState === 'connecting'
    ) {
      clearDisconnectedCloseTimer()
      return
    }

    if (pc.connectionState === 'disconnected') {
      if (!disconnectedCloseTimer) {
        disconnectedCloseTimer = setTimeout(() => {
          disconnectedCloseTimer = null

          if (pc.connectionState === 'disconnected') {
            emitClose()
          }
        }, disconnectedCloseDelayMs)
      }

      return
    }

    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      emitClose()
    }
  }

  pc.ontrack = e => {
    const stream = e.streams[0]

    if (stream) {
      if (!handlers.track && !handlers.stream) {
        pendingTracks.push({track: e.track, stream})
        return
      }

      handlers.track?.(e.track, stream)
      handlers.stream?.(stream)
    }
  }
  ;(
    pc as RTCPeerConnection & {
      onremovestream: ((e: {stream: MediaStream}) => void) | null
    }
  ).onremovestream = e => handlers.stream?.(e.stream)

  const offerPromise = initiator
    ? new Promise<Signal | void>(res =>
        appendSignalHandler(signal => {
          if (signal.type === offerType) {
            res(signal)
          }
        })
      )
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
    created: Date.now(),

    connection: pc,

    get channel(): RTCDataChannel | null {
      return dataChannel
    },

    get isDead(): boolean {
      return pc.connectionState === 'closed'
    },

    getOffer: async (restartIce = false): Promise<Signal | void> => {
      if (!initiator) {
        return
      }

      if (restartIce) {
        return createOffer(true)
      }

      if (pc.localDescription?.type === offerType) {
        return waitForIceGathering(pc)
      }

      return offerPromise
    },

    async signal(sdp: Signal): Promise<Signal | void> {
      if (
        dataChannel?.readyState === 'open' &&
        !sdp.sdp?.includes('a=rtpmap')
      ) {
        return
      }

      try {
        const normalizedSdp =
          _test_only_mdnsHostFallbackToLoopback && sdp.sdp
            ? rewriteMdnsCandidatesToLoopback(sdp.sdp)
            : sdp.sdp

        const rtcSdp: RTCSessionDescriptionInit = {
          ...sdp,
          sdp: normalizedSdp
        }

        if (sdp.type === offerType) {
          if (
            makingOffer ||
            (pc.signalingState !== 'stable' && !isSettingRemoteAnswerPending)
          ) {
            if (initiator) {
              return
            }

            await all([
              pc.setLocalDescription({type: 'rollback'}),
              pc.setRemoteDescription(rtcSdp)
            ])
          } else {
            await pc.setRemoteDescription(rtcSdp)
          }

          await pc.setLocalDescription()
          const answer = await waitForIceGathering(pc)
          emitSignal(answer)

          return answer
        }

        if (sdp.type === answerType) {
          isSettingRemoteAnswerPending = true

          try {
            await pc.setRemoteDescription(rtcSdp)
          } finally {
            isSettingRemoteAnswerPending = false
          }
        }
      } catch (err) {
        handlers.error?.(err)
      }
    },

    sendData: data => dataChannel?.send(data as unknown as never),

    destroy: () => {
      clearDisconnectedCloseTimer()
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
        const queued = pendingData.splice(0)
        queued.forEach(data => handlers.data?.(data))
      }

      if (signal) {
        appendSignalHandler(signal)
      }

      if ((handlers.track || handlers.stream) && pendingTracks.length > 0) {
        const queued = pendingTracks.splice(0)
        queued.forEach(({track, stream}) => {
          handlers.track?.(track, stream)
          handlers.stream?.(stream)
        })
      }
    },

    offerPromise,

    addStream: stream =>
      stream.getTracks().forEach(track => pc.addTrack(track, stream)),

    removeStream: stream =>
      pc
        .getSenders()
        .filter(
          sender => sender.track && stream.getTracks().includes(sender.track)
        )
        .forEach(sender => pc.removeTrack(sender)),

    addTrack: (track, stream) => pc.addTrack(track, stream),

    removeTrack: track => {
      const sender = pc.getSenders().find(s => s.track === track)

      if (sender) {
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
