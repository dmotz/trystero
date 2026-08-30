import assert from 'node:assert/strict'
import {spawn, type ChildProcess} from 'node:child_process'
import {createInterface} from 'node:readline'
import {fileURLToPath} from 'node:url'
import WebSocket, {WebSocketServer} from 'ws'

type RelayCounts = {
  announcements: number
  signals: number
}

type PeerResult = {
  role: string
  connectionMs: number
}

type PeerProcess = {
  child: ChildProcess
  connected: Promise<PeerResult>
}

const peerScript = fileURLToPath(
  new URL('./nostr-measure-peer.ts', import.meta.url)
)
const relayCount = 3
const simultaneousWindowMs = 12_000
const incumbentWarmupMs = 8_000
const lateJoinWindowMs = 12_000
const connectionTimeoutMs = 15_000
const runningPeers: PeerProcess[] = []

const wait = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))

const withConnectionTimeout = <T>(promise: Promise<T>): Promise<T> =>
  Promise.race([
    promise,
    wait(connectionTimeoutMs).then(() => {
      throw new Error(
        `peer connection timed out after ${connectionTimeoutMs}ms`
      )
    })
  ])

const rawDataToString = (data: WebSocket.RawData): string => {
  if (typeof data === 'string') {
    return data
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8')
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(data)).toString('utf8')
  }

  return data.toString('utf8')
}

const createRelay = async (
  rateLimitAnnouncements = false
): Promise<{
  url: string
  behavior: 'healthy' | 'rate-limited'
  counts: RelayCounts
  reset: () => void
  close: () => Promise<void>
}> => {
  const counts: RelayCounts = {announcements: 0, signals: 0}
  const subscriptions = new WeakMap<
    WebSocket,
    Map<string, Record<string, unknown>>
  >()
  const wss = new WebSocketServer({port: 0})

  await new Promise<void>((resolve, reject) => {
    wss.once('listening', resolve)
    wss.once('error', reject)
  })

  wss.on('connection', socket => {
    subscriptions.set(socket, new Map())

    socket.on('message', raw => {
      const msg = JSON.parse(rawDataToString(raw)) as unknown[]

      if (msg[0] === 'REQ') {
        const subId = msg[1]
        const filter = msg[2]

        if (typeof subId === 'string' && filter && typeof filter === 'object') {
          subscriptions
            .get(socket)
            ?.set(subId, filter as Record<string, unknown>)
          socket.send(JSON.stringify(['EOSE', subId]))
        }
        return
      }

      if (msg[0] === 'CLOSE' && typeof msg[1] === 'string') {
        subscriptions.get(socket)?.delete(msg[1])
        return
      }

      if (msg[0] !== 'EVENT' || !msg[1] || typeof msg[1] !== 'object') {
        return
      }

      const event = msg[1] as Record<string, unknown>
      const content = JSON.parse(String(event['content'])) as Record<
        string,
        unknown
      >
      const isAnnouncement =
        typeof content['peerId'] === 'string' &&
        !content['offer'] &&
        !content['answer'] &&
        !content['candidate']

      counts[isAnnouncement ? 'announcements' : 'signals'] += 1

      if (isAnnouncement && rateLimitAnnouncements) {
        socket.send(
          JSON.stringify([
            'OK',
            event['id'],
            false,
            'rate-limited: measurement relay requested a cooldown'
          ])
        )
        return
      }

      socket.send(JSON.stringify(['OK', event['id'], true, '']))

      const tags = Array.isArray(event['tags']) ? event['tags'] : []
      const topic = tags.find(tag => Array.isArray(tag) && tag[0] === 'x')?.[1]

      wss.clients.forEach(client => {
        if (client.readyState !== WebSocket.OPEN) {
          return
        }

        subscriptions.get(client)?.forEach((filter, subId) => {
          const topics = filter['#x']
          const kinds = filter['kinds']

          if (
            Array.isArray(topics) &&
            topics.includes(topic) &&
            Array.isArray(kinds) &&
            kinds.includes(event['kind'])
          ) {
            client.send(JSON.stringify(['EVENT', subId, event]))
          }
        })
      })
    })
  })

  const address = wss.address()
  assert.ok(address && typeof address === 'object')

  return {
    url: `ws://127.0.0.1:${address.port}`,
    behavior: rateLimitAnnouncements ? 'rate-limited' : 'healthy',
    counts,
    reset: () => {
      counts.announcements = 0
      counts.signals = 0
    },
    close: () =>
      new Promise((resolve, reject) => {
        wss.clients.forEach(socket => socket.close())
        wss.close(error => (error ? reject(error) : resolve()))
      })
  }
}

const startPeer = (
  role: string,
  roomId: string,
  config: Record<string, unknown>
): PeerProcess => {
  const child = spawn(
    process.execPath,
    ['--import', 'jiti/register', peerScript],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        TRYSTERO_NOSTR_MEASURE_CONFIG: JSON.stringify(config),
        TRYSTERO_NOSTR_MEASURE_ROOM: roomId,
        TRYSTERO_NOSTR_MEASURE_ROLE: role
      }
    }
  )
  let stderr = ''
  let settled = false
  const connected = new Promise<PeerResult>((resolve, reject) => {
    createInterface({input: child.stdout!}).on('line', line => {
      let event: Record<string, unknown>

      try {
        event = JSON.parse(line) as Record<string, unknown>
      } catch {
        return
      }

      if (!settled && event['type'] === 'connected') {
        settled = true
        resolve({
          role: String(event['role']),
          connectionMs: Number(event['connectionMs'])
        })
      }
    })
    child.stderr?.on('data', chunk => (stderr += String(chunk)))
    child.once('exit', code => {
      if (!settled) {
        settled = true
        reject(
          new Error(`${role} exited before connecting (${code}): ${stderr}`)
        )
      }
    })
  })

  const peer = {child, connected}
  runningPeers.push(peer)

  return peer
}

const stopPeers = async (peers: PeerProcess[]): Promise<void> => {
  await Promise.all(
    peers.map(
      ({child}) =>
        new Promise<void>(resolve => {
          if (child.exitCode !== null) {
            resolve()
            return
          }

          const forceTimer = setTimeout(() => child.kill('SIGKILL'), 2_000)
          child.once('exit', () => {
            clearTimeout(forceTimer)
            resolve()
          })
          child.kill('SIGTERM')
        })
    )
  )
}

const snapshot = (relays: Awaited<ReturnType<typeof createRelay>>[]) =>
  relays.map(({url, behavior, counts}) => ({url, behavior, ...counts}))

const relays = await Promise.all(
  Array.from({length: relayCount}, (_, i) => createRelay(i === relayCount - 1))
)
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
const config = {
  appId: `nostr-announcement-measure-${suffix}`,
  password: `measure-${suffix}`,
  rtcConfig: {iceServers: []},
  relayConfig: {urls: relays.map(relay => relay.url)}
}

try {
  const roomId = `simultaneous-${suffix}`
  const simultaneousPeers = [
    startPeer('simultaneous-a', roomId, config),
    startPeer('simultaneous-b', roomId, config)
  ]
  const simultaneousStarted = Date.now()
  const simultaneousConnections = await withConnectionTimeout(
    Promise.all(simultaneousPeers.map(peer => peer.connected))
  )
  await wait(
    Math.max(0, simultaneousWindowMs - (Date.now() - simultaneousStarted))
  )
  const simultaneousCounts = snapshot(relays)
  await stopPeers(simultaneousPeers)

  relays.forEach(relay => relay.reset())

  const lateRoomId = `late-${suffix}`
  const incumbent = startPeer('incumbent', lateRoomId, config)
  await wait(incumbentWarmupMs)
  relays.forEach(relay => relay.reset())

  const lateStarted = Date.now()
  const newcomer = startPeer('newcomer', lateRoomId, config)
  const lateConnections = await withConnectionTimeout(
    Promise.all([incumbent.connected, newcomer.connected])
  )
  await wait(Math.max(0, lateJoinWindowMs - (Date.now() - lateStarted)))
  const lateCounts = snapshot(relays)
  await stopPeers([incumbent, newcomer])

  console.log(
    JSON.stringify(
      {
        windowsMs: {
          simultaneous: simultaneousWindowMs,
          incumbentWarmup: incumbentWarmupMs,
          lateJoin: lateJoinWindowMs
        },
        simultaneous: {
          connections: simultaneousConnections,
          relays: simultaneousCounts
        },
        lateJoin: {connections: lateConnections, relays: lateCounts}
      },
      null,
      2
    )
  )
} finally {
  await stopPeers(runningPeers)
  await Promise.all(relays.map(relay => relay.close()))
}
