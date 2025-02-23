import {alloc} from './utils.js'

const iceTimeout = 5000
const iceStateEvent = 'icegatheringstatechange'
const filterTrickle = sdp => sdp.replace(/a=ice-options:trickle\s\n/g, '')

export default (initiator, {rtcConfig, rtcPolyfill, turnConfig}) => {
  const pc = new (rtcPolyfill || RTCPeerConnection)({
    iceServers: defaultIceServers.concat(turnConfig || []),
    ...rtcConfig
  })

  const handlers = {}

  const setupDataChannel = channel => {
    channel.binaryType = 'arraybuffer'
    channel.bufferedAmountLowThreshold = 0xffff
    channel.onmessage = e => handlers.data?.(e.data)
    channel.onopen = () => handlers.connect?.()
    channel.onclose = () => handlers.close?.()
    channel.onerror = err => handlers.error?.(err)
  }

  const waitForIceGathering = async pc => {
    if (!pc.localDescription) {
      throw new Error('No local description available')
    }

    await Promise.race([
      new Promise(resolve => {
        const checkState = () => {
          if (pc.iceGatheringState === 'complete') {
            pc.removeEventListener(iceStateEvent, checkState)
            resolve()
          }
        }
        pc.addEventListener(iceStateEvent, checkState)
        checkState()
      }),
      new Promise(resolve => setTimeout(resolve, iceTimeout))
    ])

    return {
      type: pc.localDescription.type,
      sdp: filterTrickle(pc.localDescription.sdp)
    }
  }

  let makingOffer = false
  let dataChannel = null
  let ignoreOffer = false

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
      handlers.signal?.({type: offer.type, sdp: filterTrickle(offer.sdp)})
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

  pc.onremovestream = event => {
    handlers.stream?.(event.stream, {removed: true})
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
      if (dataChannel?.readyState === 'open') {
        if (sdp.type === 'offer' || pc.signalingState !== 'stable') {
          await pc.setRemoteDescription(sdp)
          if (sdp.type === 'offer') {
            await pc.setLocalDescription()
            const answer = await waitForIceGathering(pc)
            handlers.signal?.({type: answer.type, sdp: answer.sdp})
            return {type: answer.type, sdp: answer.sdp}
          }
        }
        return
      }

      try {
        if (sdp.type === 'offer') {
          if (makingOffer || pc.signalingState !== 'stable') {
            ignoreOffer = !initiator
            if (ignoreOffer) {
              return
            }
          }
          await pc.setRemoteDescription(sdp)
          await pc.setLocalDescription()

          const answer = await waitForIceGathering(pc)
          const answerSdp = filterTrickle(answer.sdp)

          handlers.signal?.({type: answer.type, sdp: answerSdp})
          return {type: answer.type, sdp: answerSdp}
        } else if (
          sdp.type === 'answer' &&
          (pc.signalingState === 'have-local-offer' ||
            pc.signalingState === 'have-remote-offer')
        ) {
          await pc.setRemoteDescription(sdp)
        }
      } catch (err) {
        handlers.error?.(err)
      }
    },

    sendData: data => dataChannel.send(data),

    destroy: () => {
      if (dataChannel) {
        dataChannel.close()
      }
      pc.close()
    },

    setHandlers: newHandlers => Object.assign(handlers, newHandlers),

    offerPromise: initiator
      ? new Promise(res => {
          const handler = sdp => {
            if (sdp.type === 'offer') {
              res(sdp)
            }
          }
          handlers.signal = handler
        })
      : Promise.resolve(),

    addStream: stream => {
      stream.getTracks().forEach(track => pc.addTrack(track, stream))
    },

    removeStream: stream => {
      pc.getSenders()
        .filter(sender => stream.getTracks().includes(sender.track))
        .forEach(sender => pc.removeTrack(sender))
    },

    addTrack: (track, stream) => pc.addTrack(track, stream),

    removeTrack: track => {
      const sender = pc.getSenders().find(s => s.track === track)
      if (sender) {
        pc.removeTrack(sender)
      }
    },

    replaceTrack: async (oldTrack, newTrack) => {
      const sender = pc.getSenders().find(s => s.track === oldTrack)
      if (sender) {
        await sender.replaceTrack(newTrack)
      }
    }
  }
}

export const defaultIceServers = [
  ...alloc(3, (_, i) => `stun:stun${i || ''}.l.google.com:19302`),
  'stun:global.stun.twilio.com:3478'
].map(url => ({urls: url}))
