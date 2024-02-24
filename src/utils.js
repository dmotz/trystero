import Peer from 'simple-peer-light'

const charSet = '0123456789AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRrSsTtUuVvWwXxYyZz'
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const initPeer = (initiator, trickle, config) => {
  const peer = new Peer({initiator, trickle, config})
  const onData = data => peer.__earlyDataBuffer.push(data)

  peer.on(events.data, onData)
  peer.__earlyDataBuffer = []
  peer.__drainEarlyData = f => {
    peer.off(events.data, onData)
    peer.__earlyDataBuffer.forEach(f)
    delete peer.__earlyDataBuffer
    delete peer.__drainEarlyData
  }

  return peer
}

export const alloc = (n, f) => Array(n).fill().map(f)

export const genId = n =>
  alloc(n, () => charSet[Math.floor(Math.random() * charSet.length)]).join('')

export const libName = 'Trystero'

export const selfId = genId(20)

export const isBrowser = typeof window !== 'undefined'

export const {keys, values, entries, fromEntries} = Object

export const noOp = () => {}

export const mkErr = msg => new Error(`${libName}: ${msg}`)

export const encodeBytes = txt => encoder.encode(txt)

export const decodeBytes = buffer => decoder.decode(buffer)

export const toHex = buffer =>
  buffer.reduce((a, c) => a + c.toString(16).padStart(2, '0'), '')

export const events = fromEntries(
  ['close', 'connect', 'data', 'error', 'signal', 'stream', 'track'].map(k => [
    k,
    k
  ])
)

export const topicPath = (...parts) => parts.join('@')

export const getRelays = (config, defaults, defaultN) =>
  (config.relayUrls || defaults).slice(
    0,
    config.relayUrls
      ? config.relayUrls.length
      : config.relayRedundancy || defaultN
  )

export const toJson = JSON.stringify

export const fromJson = JSON.parse

const defaultRetryMs = 3333
const socketRetryPeriods = {}

export const makeSocket = (url, onMessage) => {
  const client = {}

  const init = () => {
    const socket = new WebSocket(url)

    socket.onclose = () => {
      socketRetryPeriods[url] ??= defaultRetryMs
      setTimeout(init, socketRetryPeriods[url])
      socketRetryPeriods[url] *= 2
    }

    socket.onmessage = onMessage
    client.socket = socket
    client.url = socket.url
    client.ready = new Promise(
      res =>
        (socket.onopen = () => {
          res(client)
          socketRetryPeriods[url] = defaultRetryMs
        })
    )
    client.send = data => {
      if (socket.readyState === 1) {
        socket.send(data)
      }
    }
  }

  init()

  return client
}

export const socketGetter = clientMap => () =>
  fromEntries(entries(clientMap).map(([url, client]) => [url, client.socket]))
