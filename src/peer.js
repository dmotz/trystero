import {all, alloc} from './utils.js'

const iceTimeout = 5000
const iceStateEvent = 'icegatheringstatechange'
const offerType = 'offer'
const answerType = 'answer'

export default (initiator, {rtcConfig, rtcPolyfill, turnConfig}) => {
  const pc = new (rtcPolyfill || RTCPeerConnection)({
    iceServers: defaultIceServers.concat(turnConfig || []),
    ...rtcConfig
  })

  const handlers = {}
  let makingOffer = false
  let isSettingRemoteAnswerPending = false
  let dataChannel = null

  const setupDataChannel = channel => {
    channel.binaryType = 'arraybuffer'
    channel.bufferedAmountLowThreshold = 0xffff
    channel.onmessage = e => handlers.data?.(e.data)
    channel.onopen = () => handlers.connect?.()
    channel.onclose = () => handlers.close?.()
    channel.onerror = err => handlers.error?.(err)
  }

  const waitForIceGathering = pc =>
    Promise.race([
      new Promise(res => {
        const checkState = () => {
          if (pc.iceGatheringState === 'complete') {
            pc.removeEventListener(iceStateEvent, checkState)
            res()
          }
        }

        pc.addEventListener(iceStateEvent, checkState)
        checkState()
      }),
      new Promise(res => setTimeout(res, iceTimeout))
    ]).then(() => ({
      type: pc.localDescription.type,
      sdp: pc.localDescription.sdp.replace(/a=ice-options:trickle\s\n/g, '')
    }))

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

      handlers.signal?.(offer)
    } catch (err) {
      handlers.error?.(err)
    } finally {
      makingOffer = false
    }
  }

  pc.onconnectionstatechange = () => {
    if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
      handlers.close?.()
    }
  }

  pc.ontrack = e => {
    handlers.track?.(e.track, e.streams[0])
    handlers.stream?.(e.streams[0])
  }

  pc.onremovestream = e => handlers.stream?.(e.stream)

  if (initiator) {
    if (!pc.canTrickleIceCandidates) {
      pc.onnegotiationneeded()
    }
  }

  return {
    created: Date.now(),

    connection: pc,

    get channel() {
      return dataChannel
    },

    get isDead() {
      return pc.connectionState === 'closed'
    },

    async signal(sdp) {
      if (
        dataChannel?.readyState === 'open' &&
        !sdp.sdp?.includes('a=rtpmap')
      ) {
        return
      }

      try {
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
              pc.setRemoteDescription(sdp)
            ])
          } else {
            await pc.setRemoteDescription(sdp)
          }

          await pc.setLocalDescription()
          const answer = await waitForIceGathering(pc)
          handlers.signal?.(answer)

          return answer
        } else if (sdp.type === answerType) {
          isSettingRemoteAnswerPending = true
          try {
            await pc.setRemoteDescription(sdp)
          } finally {
            isSettingRemoteAnswerPending = false
          }
        }
      } catch (err) {
        handlers.error?.(err)
      }
    },

    sendData: data => dataChannel.send(data),

    destroy: () => {
      dataChannel?.close()
      pc.close()
      makingOffer = false
      isSettingRemoteAnswerPending = false
    },

    setHandlers: newHandlers => Object.assign(handlers, newHandlers),

    offerPromise: initiator
      ? new Promise(
          res =>
            (handlers.signal = sdp => {
              if (sdp.type === offerType) {
                res(sdp)
              }
            })
        )
      : Promise.resolve(),

    addStream: stream =>
      stream.getTracks().forEach(track => pc.addTrack(track, stream)),

    removeStream: stream =>
      pc
        .getSenders()
        .filter(sender => stream.getTracks().includes(sender.track))
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
    }
  }
}

export const defaultIceServers = [
  ...alloc(3, (_, i) => `stun:stun${i || ''}.l.google.com:19302`),
  'stun:stun.cloudflare.com:3478'
].map(url => ({urls: url}))
