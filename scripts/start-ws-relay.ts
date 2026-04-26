import {createServer, type Server} from 'node:https'
import {readFileSync} from 'node:fs'
import {join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createWsRelayServer} from '@trystero-p2p/ws-relay/server'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const projectRoot = resolve(__dirname, '..')
const certPath = join(projectRoot, 'test/certs/cert.pem')
const keyPath = join(projectRoot, 'test/certs/key.pem')
const tlsOptions = {
  cert: readFileSync(certPath),
  key: readFileSync(keyPath)
}
const relayPorts =
  process.env['TRYSTERO_WS_RELAY_PORTS']
    ?.split(',')
    .map(Number)
    .filter(Number.isInteger) ?? []

const listen = (server: Server, port: number): Promise<void> =>
  new Promise((res, rej) => {
    server.once('error', rej)
    server.listen(port, () => {
      server.off('error', rej)
      res()
    })
  })

const close = (server: Server): Promise<void> =>
  new Promise(res => server.close(() => res()))

const relayServers = relayPorts.map(port => {
  const server = createServer(tlsOptions)
  const relay = createWsRelayServer({server})

  return {port, server, relay}
})

await Promise.all(relayServers.map(({server, port}) => listen(server, port)))

console.log(
  `Trystero ws-relay servers ready on ${relayPorts.map(port => `wss://localhost:${port}`).join(', ')}`
)

const shutdown = async (): Promise<void> => {
  await Promise.all(
    relayServers.map(({server, relay}) =>
      relay.close().finally(() => close(server))
    )
  )

  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
