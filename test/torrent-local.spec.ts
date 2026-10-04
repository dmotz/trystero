import {readFileSync} from 'node:fs'
import {createServer} from 'node:https'
import {once} from 'node:events'
import {WebSocketServer, type WebSocket} from 'ws'
import {test} from '@playwright/test'
import runTests from './tests'

const overrides = {
  relayConfig: {urls: [] as string[]},
  rtcConfig: {iceServers: []}
}
let server: ReturnType<typeof createServer>
let tracker: WebSocketServer

test.beforeAll(async () => {
  server = createServer({
    cert: readFileSync(new URL('./certs/cert.pem', import.meta.url)),
    key: readFileSync(new URL('./certs/key.pem', import.meta.url))
  })
  tracker = new WebSocketServer({server})
  const peers = new Map<WebSocket, Map<string, string>>()
  tracker.on('connection', socket => {
    const topics = new Map<string, string>()
    peers.set(socket, topics)
    socket.on('close', () => peers.delete(socket))
    socket.on('message', raw => {
      const message = JSON.parse(new TextDecoder().decode(raw as Uint8Array))
      const topic = message.info_hash
      if (message.answer) {
        for (const [other, rooms] of peers) {
          if (rooms.get(topic) === message.to_peer_id) {
            other.send(JSON.stringify(message))
          }
        }
      } else if (Array.isArray(message.offers)) {
        topics.set(topic, message.peer_id)
        const target = [...peers].find(
          ([other, rooms]) => other !== socket && rooms.has(topic)
        )?.[0]
        for (const offer of message.offers) {
          target?.send(
            JSON.stringify({
              info_hash: topic,
              peer_id: message.peer_id,
              ...offer
            })
          )
        }
      }
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('tracker failed to listen')
  }
  overrides.relayConfig.urls.splice(
    0,
    overrides.relayConfig.urls.length,
    `wss://127.0.0.1:${address.port}`
  )
})

test.afterAll(async () => {
  tracker?.clients.forEach(socket => socket.terminate())
  if (tracker) {
    await new Promise<void>(resolve => tracker.close(() => resolve()))
  }
  if (server) {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

runTests('torrent', overrides)
