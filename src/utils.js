const charSet = new Array(62)
  .fill()
  .map((_, i) => String.fromCharCode(i + (i > 9 ? (i > 35 ? 61 : 55) : 48)))
  .join('')

export const genId = n =>
  new Array(n)
    .fill()
    .map(() => charSet[Math.floor(Math.random() * charSet.length)])
    .join('')

export const libName = 'Trystero'

export const selfId = genId(20)

export const {keys, values, entries} = Object

export const noOp = () => {}

export const mkErr = msg => new Error(`${libName}: ${msg}`)

export const encodeBytes = txt => new TextEncoder().encode(txt)

export const decodeBytes = txt => new TextDecoder().decode(txt)
