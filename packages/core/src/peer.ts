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

export default (
  initiator: boolean,
  {rtcConfig, rtcPolyfill, turnConfig}: BaseRoomConfig
): PeerHandle => {
  const pc = new (rtcPolyfill ?? RTCPeerConnection)({
    iceServers: defaultIceServers.concat(turnConfig ?? []),
    ...rtcConfig
  })

  const handlers: PeerHandlers = {}
  const pendingSignals: Signal[] = []
  const pendingData: ArrayBuffer[] = []
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
      new Promise<void>(res => setTimeout(res, iceTimeout))
    ])

    return {
      type: (peerConnection.localDescription?.type ?? offerType) as RTCSdpType,
      sdp: (peerConnection.localDescription?.sdp ?? '').replace(
        /a=ice-options:trickle\s\n/g,
        ''
      )
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

  pc.onnegotiationneeded = async () => {
    try {
      makingOffer = true
      await pc.setLocalDescription()
      const offer = await waitForIceGathering(pc)
      emitSignal(offer)
    } catch (err) {
      handlers.error?.(err)
    } finally {
      makingOffer = false
    }
  }

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

    async signal(sdp: Signal): Promise<Signal | void> {
      if (
        dataChannel?.readyState === 'open' &&
        !sdp.sdp?.includes('a=rtpmap')
      ) {
        return
      }

      try {
        const rtcSdp: RTCSessionDescriptionInit = sdp

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
