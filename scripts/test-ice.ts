import {randomBytes} from 'node:crypto'
import {createSocket} from 'node:dgram'
import {defaultIceServers} from '@trystero/core'

const stunMagicCookie = 0x2112_a442
const probeTimeoutMs = 3_500

const parseStunUrl = (url: string): {host: string; port: number} | null => {
  const normalized = url.replace(/^stun:/, '')
  const separator = normalized.lastIndexOf(':')

  if (separator < 1) {
    return null
  }

  const host = normalized.slice(0, separator)
  const portText = normalized.slice(separator + 1)
  const port = Number(portText)

  if (!host || !Number.isInteger(port) || port <= 0 || port > 65_535) {
    return null
  }

  return {host, port}
}

const createStunBindingRequest = (): {
  packet: Buffer
  transactionId: Buffer
} => {
  const transactionId = randomBytes(12)
  const packet = Buffer.alloc(20)

  packet.writeUInt16BE(0x0001, 0)
  packet.writeUInt16BE(0, 2)
  packet.writeUInt32BE(stunMagicCookie, 4)
  transactionId.copy(packet, 8)

  return {packet, transactionId}
}

const probeStun = (host: string, port: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const socket = createSocket('udp4')
    const {packet, transactionId} = createStunBindingRequest()
    let didFinish = false

    const finish = (error?: Error): void => {
      if (didFinish) {
        return
      }

      didFinish = true
      socket.removeAllListeners()
      socket.close()

      if (error) {
        reject(error)
        return
      }

      resolve()
    }

    const timeout = setTimeout(
      () => finish(new Error('timeout')),
      probeTimeoutMs
    )

    socket.once('error', error => {
      clearTimeout(timeout)
      finish(error)
    })

    socket.once('message', message => {
      clearTimeout(timeout)

      if (
        message.length < 20 ||
        message.readUInt16BE(0) !== 0x0101 ||
        message.readUInt32BE(4) !== stunMagicCookie ||
        !message.subarray(8, 20).equals(transactionId)
      ) {
        finish(new Error('invalid stun response'))
        return
      }

      finish()
    })

    socket.send(packet, port, host, error => {
      if (error) {
        clearTimeout(timeout)
        finish(error)
      }
    })
  })

const testIceServer = async (url: string): Promise<string> => {
  const parsed = parseStunUrl(url)

  if (!parsed) {
    return `❌ ${url}`
  }

  return probeStun(parsed.host, parsed.port)
    .then(() => `✅ ${url}`)
    .catch(() => `❌ ${url}`)
}

const tests = defaultIceServers.flatMap(server => {
  const urls = Array.isArray(server.urls) ? server.urls : [server.urls]
  return urls.map(testIceServer)
})

;(await Promise.all(tests)).forEach(result => console.log(result))
