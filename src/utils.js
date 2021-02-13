const charSet = '0123456789AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRrSsTtUuVvWwXxYyZz'

export const genId = n =>
  new Array(n)
    .fill()
    .map(() => charSet[Math.floor(Math.random() * charSet.length)])
    .join('')

export const initGuard = f => (config, ...args) => {
  if (!config) {
    throw mkErr('init() requires a config map as the first argument')
  }

  if (!config.appId) {
    throw mkErr('config map is missing appId field')
  }

  return f(config, ...args)
}

export const libName = 'Trystero'

export const selfId = genId(20)

export const {keys, values, entries} = Object

export const noOp = () => {}

export const mkErr = msg => new Error(`${libName}: ${msg}`)

export const encodeBytes = txt => new TextEncoder().encode(txt)

export const decodeBytes = txt => new TextDecoder().decode(txt)
