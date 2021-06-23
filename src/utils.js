import Peer from 'simple-peer-light'

const charSet = '0123456789AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRrSsTtUuVvWwXxYyZz'

export const initPeer = (initiator, trickle, config) =>
  new Peer({initiator, trickle, config})

export const genId = n =>
  new Array(n)
    .fill()
    .map(() => charSet[Math.floor(Math.random() * charSet.length)])
    .join('')

export const initGuard = (occupiedRooms, f) => (config, ns) => {
  if (occupiedRooms[ns]) {
    throw mkErr(`already joined room ${ns}`)
  }

  if (!config) {
    throw mkErr('requires a config map as the first argument')
  }

  if (!config.appId) {
    throw mkErr('config map is missing appId field')
  }

  if (!ns) {
    throw mkErr('namespace argument required')
  }

  return f(config, ns)
}

export const libName = 'Trystero'

export const selfId = genId(20)

export const {keys, values, entries, fromEntries} = Object

export const noOp = () => {}

export const mkErr = msg => new Error(`${libName}: ${msg}`)

export const encodeBytes = txt => new TextEncoder().encode(txt)

export const decodeBytes = txt => new TextDecoder().decode(txt)

export const events = fromEntries(
  ['close', 'connect', 'data', 'error', 'signal', 'stream'].map(k => [k, k])
)

export const combineChunks = chunks => {
  const full = new Uint8Array(chunks.reduce((a, c) => a + c.byteLength, 0))

  chunks.reduce((a, c) => {
    full.set(c, a)
    return a + c.byteLength
  }, 0)

  return full
}

export const asList = xs => (Array.isArray(xs) ? xs : [xs])
