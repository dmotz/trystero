import assert from 'node:assert/strict'
import {spawn, spawnSync} from 'node:child_process'
import {randomBytes, randomUUID} from 'node:crypto'
import {createSocket} from 'node:dgram'
import {existsSync, readFileSync} from 'node:fs'
import {createServer} from 'node:http'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {chromium} from 'playwright'
import {WebSocketServer} from 'ws'
import {createWsRelayServer} from '@trystero-p2p/ws-relay/server'

const root = fileURLToPath(new URL('..', import.meta.url))
const host = '127.0.0.1'
const quota = Number(process.env.TRYSTERO_TURN_QUOTA ?? 4)
const maxJoinMs = 12_000

if (!Number.isInteger(quota) || quota < 1) {
  throw new Error('TRYSTERO_TURN_QUOTA must be a positive integer')
}

const run = (command, args) =>
  spawnSync(command, args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      HOMEBREW_NO_AUTO_UPDATE: '1',
      HOMEBREW_NO_INSTALL_CLEANUP: '1'
    }
  })

const coturnPath = () => {
  const fromPath = spawnSync('which', ['turnserver'], {encoding: 'utf8'})

  if (fromPath.status === 0) {
    return fromPath.stdout.trim()
  }

  if (process.platform !== 'darwin') {
    throw new Error('install coturn and ensure turnserver is on PATH')
  }

  const prefix = spawnSync('brew', ['--prefix'], {encoding: 'utf8'})

  if (prefix.status !== 0) {
    throw new Error('Homebrew is required to install coturn on macOS')
  }

  const bin = join(prefix.stdout.trim(), 'opt/coturn/bin/turnserver')

  if (!existsSync(bin)) {
    console.log('Installing coturn with Homebrew...')
    const installed = run('brew', ['install', 'coturn'])

    if (installed.status !== 0) {
      throw new Error('brew install coturn failed')
    }
  }

  if (!existsSync(bin)) {
    throw new Error(`coturn installed but turnserver was not found at ${bin}`)
  }

  return bin
}

const freeUdpPort = () =>
  new Promise((resolve, reject) => {
    const socket = createSocket('udp4')
    socket.once('error', reject)
    socket.bind(0, host, () => {
      const {port} = socket.address()
      socket.close(() => resolve(port))
    })
  })

const probeTurn = port =>
  new Promise((resolve, reject) => {
    const socket = createSocket('udp4')
    const packet = Buffer.alloc(20)
    const transactionId = randomBytes(12)
    packet.writeUInt16BE(0x0001, 0)
    packet.writeUInt32BE(0x2112a442, 4)
    transactionId.copy(packet, 8)

    let settled = false
    const finish = error => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      socket.close()
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }

    const timeout = setTimeout(
      () => finish(new Error('TURN probe timed out')),
      400
    )
    socket.once('error', finish)
    socket.once('message', response => {
      finish(
        response.length >= 20 &&
          response.readUInt16BE(0) === 0x0101 &&
          response.readUInt32BE(4) === 0x2112a442 &&
          response.subarray(8, 20).equals(transactionId)
          ? null
          : new Error('invalid STUN response from coturn')
      )
    })
    socket.send(packet, port, host)
  })

const waitForTurn = async (port, child) => {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `coturn exited with ${child.exitCode ?? child.signalCode}`
      )
    }

    try {
      await probeTurn(port)
      return
    } catch {
      // coturn may still be starting.
    }
  }

  throw new Error('coturn did not respond on loopback within 8 seconds')
}

const listen = server =>
  new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => {
      server.off('error', reject)
      resolve(server.address().port)
    })
  })

const close = server => new Promise(resolve => server.close(() => resolve()))

const createTorrentTracker = () => {
  const wss = new WebSocketServer({host, port: 0})
  const peers = new Map()

  wss.on('connection', socket => {
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString())

      if (message.answer && message.to_peer_id) {
        for (const [other, peer] of peers) {
          if (peer.id === message.to_peer_id) {
            other.send(
              JSON.stringify({
                info_hash: message.info_hash,
                offer_id: message.offer_id,
                peer_id: message.peer_id,
                answer: message.answer
              })
            )
          }
        }
        return
      }

      if (Array.isArray(message.offers)) {
        peers.set(socket, {id: message.peer_id, topic: message.info_hash})

        for (const offer of message.offers) {
          const target = [...peers].find(
            ([other, peer]) =>
              other !== socket && peer.topic === message.info_hash
          )?.[0]
          target?.send(
            JSON.stringify({
              info_hash: message.info_hash,
              offer_id: offer.offer_id,
              peer_id: message.peer_id,
              offer: offer.offer
            })
          )
        }
      }
    })
    socket.on('close', () => peers.delete(socket))
  })

  return {
    wss,
    ready: new Promise((resolve, reject) => {
      wss.once('listening', resolve)
      wss.once('error', reject)
    }),
    address: () => wss.address(),
    close: () => close(wss)
  }
}

const stop = child =>
  new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }

    child.once('exit', resolve)
    child.kill('SIGTERM')
  })

const main = async strategy => {
  const bundle = readFileSync(join(root, `dist/trystero-${strategy}.min.js`))
  const turnPort = await freeUdpPort()
  const username = `trystero-${randomUUID()}`
  const password = randomBytes(18).toString('hex')
  const turn = spawn(
    coturnPath(),
    [
      '-n',
      '--listening-ip',
      host,
      '--relay-ip',
      host,
      '--listening-port',
      String(turnPort),
      '--allow-loopback-peers',
      '--no-tls',
      '--no-dtls',
      '--no-tcp',
      '-a',
      '-r',
      'trystero.local',
      '-u',
      `${username}:${password}`,
      '--user-quota',
      String(quota)
    ],
    {stdio: 'ignore'}
  )
  const onSignal = () => turn.kill('SIGTERM')
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  let relay
  let site
  let browser

  try {
    await waitForTurn(turnPort, turn)
    relay =
      strategy === 'torrent'
        ? createTorrentTracker()
        : createWsRelayServer({host, port: 0})
    await relay.ready
    site = createServer((request, response) => {
      if (request.url === '/trystero.mjs') {
        response.writeHead(200, {'content-type': 'text/javascript'})
        response.end(bundle)
      } else {
        response.writeHead(200, {'content-type': 'text/html'})
        response.end('<!doctype html><title>Trystero local TURN test</title>')
      }
    })
    const sitePort = await listen(site)
    browser = await chromium.launch({
      headless: true,
      ...(process.env.TRYSTERO_TURN_CHROME
        ? {executablePath: process.env.TRYSTERO_TURN_CHROME}
        : {})
    })
    const pages = await Promise.all(
      [0, 1].map(async () => {
        const context = await browser.newContext()
        const page = await context.newPage()
        await page.goto(`http://${host}:${sitePort}`)
        return page
      })
    )
    const appId = `trystero-turn-test-${randomUUID()}`
    const joinStartedAt = performance.now()
    const params = {
      appId,
      relayUrl: `ws://${host}:${relay.address().port}`,
      turnUrl: `turn:${host}:${turnPort}`,
      username,
      password
    }
    const joinRoom = async page =>
      page.evaluate(async config => {
        const {joinRoom} = await import('/trystero.mjs')
        const state = (window.__turnTest = {created: [], joined: false})
        class CountingPeerConnection extends RTCPeerConnection {
          constructor(rtcConfig) {
            super(rtcConfig)
            state.created.push(this)
          }
        }
        const room = joinRoom(
          {
            appId: config.appId,
            relayConfig: {urls: [config.relayUrl]},
            rtcConfig: {
              iceServers: [
                {
                  urls: config.turnUrl,
                  username: config.username,
                  credential: config.password
                }
              ],
              iceTransportPolicy: 'relay'
            },
            rtcPolyfill: CountingPeerConnection
          },
          'room'
        )
        state.room = room
        room.onPeerJoin = () => (state.joined = true)
      }, params)

    await joinRoom(pages[0])
    await new Promise(resolve => setTimeout(resolve, 300))
    await joinRoom(pages[1])

    try {
      await Promise.all(
        pages.map(page =>
          page.waitForFunction(() => window.__turnTest?.joined, null, {
            timeout: maxJoinMs
          })
        )
      )
    } catch (error) {
      const counts = await Promise.all(
        pages.map(page =>
          page.evaluate(async () => ({
            created: window.__turnTest.created.length,
            relayCandidates: (
              await Promise.all(
                window.__turnTest.created.map(pc => pc.getStats())
              )
            )
              .flatMap(stats => [...stats.values()])
              .filter(
                stat =>
                  stat.type === 'local-candidate' &&
                  stat.candidateType === 'relay'
              ).length
          }))
        )
      )
      throw new Error(
        `${strategy} relay-only room did not connect: ${JSON.stringify(counts)}`,
        {
          cause: error
        }
      )
    }

    for (const page of pages) {
      const result = await page.evaluate(async () => {
        const peers = Object.values(window.__turnTest.room.getPeers())
        const stats = await peers[0].getStats()
        return {
          created: window.__turnTest.created.length,
          relayCandidate: [...stats.values()].some(
            stat =>
              stat.type === 'local-candidate' && stat.candidateType === 'relay'
          )
        }
      })
      assert.equal(
        result.relayCandidate,
        true,
        'connected peer lacks a relay candidate'
      )
      console.log(
        `${strategy} peer joined via TURN; ${result.created} RTCPeerConnections created`
      )
    }
    console.log(
      `${strategy} relay-only join took ${Math.round(performance.now() - joinStartedAt)} ms`
    )
  } finally {
    await browser?.close()
    if (site) {
      await close(site)
    }
    if (relay) {
      relay.wss.clients.forEach(socket => socket.terminate())
      await relay.close()
    }
    await stop(turn)
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}

for (const strategy of ['ws-relay', 'torrent']) {
  await main(strategy)
}
