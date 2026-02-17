import {Socket} from 'node:net'
import {shuffle} from '@trystero/core'

const proxyListEndpoint =
  'https://api.proxyscrape.com/v4/free-proxy-list/get?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all&skip=0&limit=2000'
const maxCandidates = 333
const probeTimeoutMs = 2_500

const probeProxy = (host: string, port: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const socket = new Socket()
    const onDone = (error?: Error): void => {
      socket.removeAllListeners()
      socket.destroy()

      if (error) {
        reject(error)
        return
      }

      resolve()
    }

    socket.setTimeout(probeTimeoutMs)
    socket.once('timeout', () => onDone(new Error('timeout')))
    socket.once('error', error => onDone(error))
    socket.connect(Number(port), host, () => onDone())
  })

const proxyText = await fetch(proxyListEndpoint).then(res => res.text())
const proxyCandidates = shuffle(
  proxyText.split('\r\n').filter(Boolean).slice(0, maxCandidates),
  Math.random() * 1e10
)

const liveProxy = await Promise.any(
  proxyCandidates.map(addr => {
    const [host, port] = addr.split(':')

    if (!host || !port) {
      return Promise.reject(new Error(`invalid proxy address: ${addr}`))
    }

    return probeProxy(host, port).then(() => addr)
  })
)

console.log(liveProxy)
