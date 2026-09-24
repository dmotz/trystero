// Run against installed npm releases or a built workspace entry point:
// node --import jiti/register scripts/compare-relay-joins.ts label=/absolute/path/index.mjs ...
// See docs/investigations/196-join-regression.md for scenarios and methodology.
import {spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {setTimeout as wait} from 'node:timers/promises'
import WebSocket, {WebSocketServer} from 'ws'

const cases = (
  process.env['CASES'] ?? 'healthy,lost-offer,delayed-subscription'
).split(',')
const repetitions = Number(process.env['REPETITIONS'] ?? 3)
const windowMs = Number(process.env['WINDOW_MS'] ?? 12_000)
const relayCount = Number(process.env['RELAYS'] ?? 1)
const faultyRelays = Number(process.env['FAULTY_RELAYS'] ?? relayCount)
const publicRelays = process.env['PUBLIC_RELAYS']
const browser = process.env['BROWSER']
if (browser && (browser !== 'chromium' || publicRelays)) {
  throw new Error('browser trials support local Chromium tests only')
}
const joinDelayMs = Number(process.env['JOIN_DELAY_MS'] ?? 0)
const passiveFirst = process.env['PASSIVE_FIRST'] === '1'
const strategy = process.env['STRATEGY'] ?? 'nostr'
const subackMs = Number(process.env['SUBACK_MS'] ?? 0)
const signalDelayMs = Number(process.env['SIGNAL_DELAY_MS'] ?? 0)
if (!['nostr', 'mqtt', 'ws-relay'].includes(strategy)) {
  throw new Error('STRATEGY must be nostr, mqtt, or ws-relay')
}
if (
  publicRelays &&
  (strategy !== 'nostr' || cases.some(value => value !== 'healthy'))
) {
  throw new Error('public relays support healthy Nostr trials only')
}
if (
  strategy !== 'nostr' &&
  cases.some(value => ['rate-limited', 'temporary-rejection'].includes(value))
) {
  throw new Error('rejection scenarios require Nostr')
}
if (
  cases.some(
    value =>
      ![
        'healthy',
        'lost-offer',
        'lost-answer',
        'delayed-subscription',
        'temporary-rejection',
        'reconnect',
        'peer-disconnect',
        'rate-limited'
      ].includes(value)
  )
) {
  throw new Error('unknown scenario')
}
const require = createRequire(import.meta.url)
const mqttPacket =
  strategy === 'mqtt'
    ? createRequire(require.resolve('mqtt'))('mqtt-packet')
    : null
const versions = process.argv.slice(2).map(arg => {
  const separator = arg.indexOf('=')
  if (separator < 1) {
    throw new Error('expected label=/absolute/module/path')
  }
  return {
    label: arg.slice(0, separator),
    module: pathToFileURL(arg.slice(separator + 1)).href
  }
})
if (!versions.length) {
  throw new Error('supply at least one installed release')
}

async function run(label: string, module: string, scenario: string) {
  const roomId = 'room'
  const appId = `comparison-${Date.now()}-${Math.random()}`
  const rootTopic = Array.from(
    createHash('sha1').update(`Trystero@${appId}@${roomId}`).digest()
  )
    .map(byte => byte.toString(36))
    .join('')
  let started = 0
  const publicTraffic: Record<
    string,
    {
      announcements: number
      signals: number
      opens: number
      closes: number
      feedback: unknown[]
    }
  > = {}
  const timers: ReturnType<typeof setTimeout>[] = []
  const relays = await Promise.all(
    Array.from(
      {length: publicRelays ? 0 : relayCount},
      async (_, relayIndex) => {
        const relayScenario = relayIndex < faultyRelays ? scenario : 'healthy'
        const server = new WebSocketServer({host: '127.0.0.1', port: 0})
        await new Promise<void>(resolve => server.once('listening', resolve))
        const counts = {
          announcements: 0,
          directDiscovery: 0,
          offers: 0,
          answers: 0,
          candidates: 0,
          dropped: 0,
          duplicates: 0
        }
        const timeline: Array<{ms: number; type: string}> = []
        const subscriptions = new Map<
          WebSocket,
          Map<string, {kinds: number[]; '#x': string[]}>
        >()
        let didDrop = false
        const seenEvents = new Set<string>()
        server.on('connection', socket => {
          const subs = new Map<string, {kinds: number[]; '#x': string[]}>()
          subscriptions.set(socket, subs)
          socket.on('close', () => subscriptions.delete(socket))
          const handleFrame = (frame: any[]) => {
            const [type, arg, filter] = frame
            if (type === 'REQ') {
              const subscribe = () => {
                if (socket.readyState !== WebSocket.OPEN) {
                  return
                }
                subs.set(arg, filter)
                if (strategy === 'nostr') {
                  socket.send(JSON.stringify(['EOSE', arg]))
                }
              }
              if (relayScenario === 'delayed-subscription') {
                timers.push(setTimeout(subscribe, 3_000))
              } else {
                subscribe()
              }
              return
            }
            if (type === 'CLOSE') {
              subs.delete(arg)
              return
            }
            if (type !== 'EVENT') {
              return
            }
            const payload = JSON.parse(arg.content)
            const topic = arg.tags.find((tag: string[]) => tag[0] === 'x')?.[1]
            const kind = payload.offer
              ? 'offers'
              : payload.answer
                ? 'answers'
                : payload.candidate
                  ? 'candidates'
                  : topic === rootTopic
                    ? 'announcements'
                    : 'directDiscovery'
            counts[kind]++
            timeline.push({
              ms: Math.round(performance.now() - started),
              type: kind
            })
            if (relayScenario === 'rate-limited' && kind === 'announcements') {
              counts.dropped++
              socket.send(
                JSON.stringify(['OK', arg.id, false, 'rate-limited: slow down'])
              )
              return
            }
            if (relayScenario === 'temporary-rejection' && !didDrop) {
              didDrop = true
              counts.dropped++
              socket.send(
                JSON.stringify([
                  'OK',
                  arg.id,
                  false,
                  'error: temporary backend failure'
                ])
              )
              return
            }
            if (strategy === 'nostr') {
              if (seenEvents.has(arg.id)) {
                counts.duplicates++
                socket.send(
                  JSON.stringify([
                    'OK',
                    arg.id,
                    true,
                    'duplicate: already received'
                  ])
                )
                return
              }
              seenEvents.add(arg.id)
              socket.send(JSON.stringify(['OK', arg.id, true, '']))
            }
            if (
              !didDrop &&
              ((relayScenario === 'lost-offer' && payload.offer) ||
                (relayScenario === 'lost-answer' && payload.answer))
            ) {
              didDrop = true
              counts.dropped++
              return
            }
            if (
              relayScenario === 'reconnect' &&
              performance.now() - started < 3_000
            ) {
              if (!didDrop) {
                didDrop = true
                timers.push(
                  setTimeout(
                    () => server.clients.forEach(client => client.close()),
                    2_300
                  )
                )
              }
              return
            }
            const deliver = () =>
              subscriptions.forEach((clientSubs, client) => {
                clientSubs.forEach((sub, id) => {
                  if (
                    client.readyState === WebSocket.OPEN &&
                    sub['#x'].includes(topic) &&
                    sub.kinds.includes(arg.kind)
                  ) {
                    client.send(
                      strategy === 'mqtt'
                        ? mqttPacket.generate({
                            cmd: 'publish',
                            topic,
                            payload: arg.content,
                            qos: 0,
                            retain: false,
                            dup: false
                          })
                        : strategy === 'ws-relay'
                          ? JSON.stringify({topic, payload: arg.content})
                          : JSON.stringify(['EVENT', id, arg])
                    )
                  }
                })
              })
            if (
              signalDelayMs &&
              (kind === 'offers' || kind === 'answers' || kind === 'candidates')
            ) {
              timers.push(setTimeout(deliver, signalDelayMs))
            } else {
              deliver()
            }
          }
          const toEvent = (topic: string, payload: string) => [
            'EVENT',
            {content: payload, tags: [['x', topic]], kind: 20000}
          ]
          const toSubscription = (topic: string) => [
            'REQ',
            topic,
            {'#x': [topic], kinds: [20000]}
          ]
          if (strategy === 'mqtt') {
            const parser = mqttPacket.parser()
            const send = (packet: any) =>
              socket.readyState === WebSocket.OPEN &&
              socket.send(mqttPacket.generate(packet))
            parser.on('packet', (packet: any) => {
              if (packet.cmd === 'connect') {
                send({cmd: 'connack', returnCode: 0, sessionPresent: false})
              }
              if (packet.cmd === 'pingreq') {
                send({cmd: 'pingresp'})
              }
              if (packet.cmd === 'disconnect') {
                socket.close()
              }
              if (packet.cmd === 'subscribe') {
                packet.subscriptions.forEach(({topic}: {topic: string}) =>
                  handleFrame(toSubscription(topic))
                )
                timers.push(
                  setTimeout(
                    () =>
                      send({
                        cmd: 'suback',
                        messageId: packet.messageId,
                        granted: packet.subscriptions.map(() => 0)
                      }),
                    subackMs
                  )
                )
              }
              if (packet.cmd === 'unsubscribe') {
                packet.unsubscriptions.forEach((topic: string) =>
                  subs.delete(topic)
                )
                send({cmd: 'unsuback', messageId: packet.messageId})
              }
              if (packet.cmd === 'publish') {
                handleFrame(toEvent(packet.topic, packet.payload.toString()))
              }
            })
            socket.on('message', raw => parser.parse(raw))
          } else {
            socket.on('message', raw => {
              const frame = JSON.parse(
                (Array.isArray(raw)
                  ? Buffer.concat(raw)
                  : raw instanceof ArrayBuffer
                    ? Buffer.from(raw)
                    : raw
                ).toString('utf8')
              )
              handleFrame(
                strategy === 'nostr'
                  ? frame
                  : frame.type === 'publish'
                    ? toEvent(
                        frame.topic,
                        typeof frame.payload === 'string'
                          ? frame.payload
                          : JSON.stringify(frame.payload)
                      )
                    : frame.type === 'subscribe'
                      ? toSubscription(frame.topic)
                      : ['CLOSE', frame.topic]
              )
            })
          }
        })
        const address = server.address()
        if (!address || typeof address === 'string') {
          throw new Error('missing relay port')
        }
        return {server, counts, timeline, url: `ws://127.0.0.1:${address.port}`}
      }
    )
  )
  const peers = Array.from({length: 2}, () => {
    const child = spawn(
      process.execPath,
      [
        ...(browser ? [] : ['--import', 'jiti/register']),
        fileURLToPath(
          new URL(
            browser ? './relay-compare-browser.ts' : './relay-compare-peer.ts',
            import.meta.url
          )
        )
      ],
      {
        env: {...process.env, TRYSTERO_COMPARE_MODULE: module},
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
      }
    )
    let connectionMs: number | null = null
    let reconnectionMs: number | null = null
    let errors = ''
    child.stderr?.on('data', chunk => {
      errors += String(chunk)
    })
    child.stdout?.resume()
    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`peer import timed out: ${errors}`)),
        30_000
      )
      child.on('message', message => {
        const result = message as {
          type: string
          ms: number
          url?: string
          frame?: any[]
        }
        if (result.type === 'ready') {
          clearTimeout(timeout)
          resolve()
        } else if (result.type === 'connected') {
          connectionMs ??= Math.round(result.ms)
        } else if (result.type === 'reconnected') {
          reconnectionMs ??= Math.round(result.ms)
        } else if (result.url) {
          const traffic = (publicTraffic[result.url] ??= {
            announcements: 0,
            signals: 0,
            opens: 0,
            closes: 0,
            feedback: []
          })
          if (result.type === 'socket-open') {
            traffic.opens++
          }
          if (result.type === 'socket-close') {
            traffic.closes++
          }
          if (result.type === 'relay-feedback') {
            traffic.feedback.push(result.frame)
          }
          if (result.type === 'wire' && result.frame?.[0] === 'EVENT') {
            const topic = result.frame[1].tags.find(
              (tag: string[]) => tag[0] === 'x'
            )?.[1]
            traffic[topic === rootTopic ? 'announcements' : 'signals']++
          }
        }
      })
      child.once('exit', code => {
        clearTimeout(timeout)
        reject(new Error(`peer exited ${code}: ${errors}`))
      })
    })
    return {
      child,
      ready,
      get connectionMs() {
        return connectionMs
      },
      get reconnectionMs() {
        return reconnectionMs
      }
    }
  })
  try {
    await Promise.all(peers.map(peer => peer.ready))
    started = performance.now()
    const relayConfig = {
      warnOnRelayFailure: false,
      ...(publicRelays === 'default'
        ? {}
        : {
            urls: publicRelays
              ? publicRelays.split(',')
              : relays.map(relay => relay.url)
          })
    }
    peers[0].child.send({
      roomId,
      config: {
        appId,
        passive: passiveFirst,
        rtcConfig: {iceServers: []},
        relayConfig
      }
    })
    if (joinDelayMs) {
      await wait(joinDelayMs)
    }
    peers[1].child.send({
      roomId,
      config: {appId, rtcConfig: {iceServers: []}, relayConfig}
    })
    if (scenario === 'peer-disconnect') {
      await wait(8000)
      if (peers.some(peer => peer.connectionMs === null)) {
        throw new Error('peers did not connect before disconnect injection')
      }
      peers.forEach(({child}) => child.send({type: 'disconnect'}))
    }
    await wait(windowMs)
    for (const {child} of peers) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error('peer process exited during trial')
      }
    }
    const connectionsMs = peers.map(peer => peer.connectionMs)
    const joinMs = connectionsMs.some(ms => ms === null)
      ? null
      : Math.max(connectionsMs[0]! - joinDelayMs, connectionsMs[1]!)
    console.log(
      JSON.stringify({
        label,
        strategy,
        browser,
        scenario,
        windowMs,
        joinDelayMs,
        passiveFirst,
        subackMs,
        signalDelayMs,
        faultyRelays,
        connectionsMs,
        joinMs,
        ...(scenario === 'peer-disconnect'
          ? {
              disconnectAtMs: 8000,
              rejoinMs: peers.some(peer => peer.reconnectionMs === null)
                ? null
                : Math.max(...peers.map(peer => peer.reconnectionMs!))
            }
          : {}),
        relays: publicRelays
          ? publicTraffic
          : relays.map(({counts, timeline}) => ({...counts, timeline}))
      })
    )
    if (
      process.env['MAX_JOIN_MS'] &&
      (joinMs === null || joinMs > Number(process.env['MAX_JOIN_MS']))
    ) {
      process.exitCode = 1
    }
  } finally {
    timers.forEach(clearTimeout)
    await Promise.all(
      peers.map(
        ({child}) =>
          new Promise<void>(resolve => {
            if (child.exitCode !== null) {
              resolve()
              return
            }
            const kill = setTimeout(() => child.kill('SIGKILL'), 2_000)
            child.once('exit', () => {
              clearTimeout(kill)
              resolve()
            })
            child.kill('SIGTERM')
          })
      )
    )
    await Promise.all(
      relays.map(
        ({server}) =>
          new Promise<void>(resolve => {
            server.clients.forEach(socket => socket.terminate())
            server.close(() => resolve())
          })
      )
    )
  }
}

for (const scenario of cases) {
  for (let repeat = 0; repeat < repetitions; repeat++) {
    // Alternate version order to avoid a consistent warm-cache advantage.
    for (const version of repeat % 2 ? [...versions].reverse() : versions) {
      await run(version.label, version.module, scenario)
    }
  }
}
