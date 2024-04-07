import {alloc} from './utils.js'

export default (isOfferer, rtcConfig, eventHandlers) => {
  const con = new RTCPeerConnection({
    iceServers: defaultIceServers,
    ...rtcConfig
  })

  const setDataEvents = chan => {
    chan.onmessage = e => {
      if (client.isDead) {
        return
      }
      handlers.onData(e.data)
    }

    chan.onopen = () => {
      isConnected = true
      handlers.onConnect()
      dataQueue.forEach(sendData)
    }

    client.channel = chan
  }

  const addSignal = async signal => {
    if (!signal) {
      return
    }

    if (signal.candidate) {
      try {
        con.addIceCandidate(new RTCIceCandidate(signal))
      } catch (e) {
        console.error(e)
      }
    } else if (signal.type === 'offer') {
      try {
        await con.setRemoteDescription(new RTCSessionDescription(signal))
        const answer = await con.createAnswer()

        await con.setLocalDescription(answer)

        return con.localDescription
      } catch (e) {
        console.error(e)
      }
    } else if (signal.type === 'answer') {
      try {
        con.setRemoteDescription(new RTCSessionDescription(signal))
      } catch (e) {
        console.error(e)
      }
    }
  }

  const sendData = async data => {
    if (client.channel.readyState !== 'open') {
      await new Promise(res => (client.channel.onopen = res))
    }

    try {
      client.channel.send(data)
    } catch (e) {
      console.error(e)
    }
  }

  const addStream = stream =>
    stream.getTracks().forEach(track => addTrack(track, stream))

  const removeStream = stream => stream.getTracks().forEach(removeTrack)

  const addTrack = (track, stream) => con.addTrack(track, stream)

  const removeTrack = track =>
    con.removeTrack(con.getSenders().find(sender => sender.track === track))

  const kill = () => {
    con.close()
    dataQueue = []
    client.isDead = true
  }

  const setHandlers = newHandlers => (handlers = {...handlers, ...newHandlers})

  let isConnected = false
  let handlers = eventHandlers
  let dataQueue = []
  let iceTimeout
  let offerResolver
  let iceResolver

  const client = {
    _id: Math.random().toString(36),
    isDead: false,
    connection: con,
    offerPromise: new Promise(res => (offerResolver = res)),
    setHandlers,
    addSignal,
    addStream,
    removeStream,
    addTrack,
    removeTrack,
    sendData,
    kill
  }

  const iceCompleteP = new Promise(res => (iceResolver = res))

  con.onicecandidate = e => {
    clearTimeout(iceTimeout)

    if (!e.candidate) {
      iceResolver()
    } else {
      iceTimeout = setTimeout(iceResolver, iceTimeoutMs)
    }
  }

  con.oniceconnectionstatechange = () => {
    if (['closed', 'disconnected', 'failed'].includes(con.iceConnectionState)) {
      handlers.onClose()
    }
  }

  con.onnegotiationneeded = async () => {
    const offer = await con.createOffer()

    try {
      await con.setLocalDescription(offer)
    } catch (e) {
      console.error(e)
    }

    await iceCompleteP

    if (isConnected) {
      handlers.onSignal(con.localDescription)
    } else {
      offerResolver(con.localDescription)
    }
  }

  con.ontrack = e => e.streams.forEach(stream => handlers.onStream(stream))

  if (isOfferer) {
    setDataEvents(con.createDataChannel('d'))
  } else {
    con.ondatachannel = e => {
      setDataEvents(e.channel)
    }
  }

  return client
}

const iceTimeoutMs = 4333

export const defaultIceServers = [
  ...alloc(5, (_, i) => ({urls: `stun:stun${i || ''}.l.google.com:19302`}))
]
