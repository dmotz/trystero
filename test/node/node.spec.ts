import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {dirname, join} from 'node:path'
import {createInterface} from 'node:readline'
import test from 'node:test'
import {fileURLToPath} from 'node:url'
import {
  createWsRelayServer,
  type WsRelayServer
} from '@trystero-p2p/ws-relay/server'
import {strategyConfigs} from '../strategy-configs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..', '..')
const peerScript = join(__dirname, 'node-peer.js')

const parseJson = (value: string) => {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

const waitForSubscriptions = async (relays: WsRelayServer[]): Promise<void> => {
  const started = Date.now()

  while (relays.some(relay => relay.getSubscriberCount() === 0)) {
    if (Date.now() - started > 5_000) {
      assert.fail('timed out waiting for subscriptions on every relay')
    }

    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

const startPeer = ({
  role,
  strategy,
  roomId,
  roomConfig
}: {
  role: string
  strategy: string
  roomId: string
  roomConfig: Record<string, unknown>
}) => {
  const child = spawn('pnpm', ['exec', 'jiti', peerScript], {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      TRYSTERO_NODE_ROLE: role,
      TRYSTERO_NODE_STRATEGY: strategy,
      TRYSTERO_NODE_ROOM_ID: roomId,
      TRYSTERO_NODE_ROOM_CONFIG: JSON.stringify(roomConfig)
    }
  })

  const logs: {type: string; line: string}[] = []
  let successEvent: {role: string; message: string} | null = null
  let stderr = ''

  const done = new Promise((resolve, reject) => {
    createInterface({input: child.stdout}).on('line', line => {
      const event = parseJson(line)

      if (!event || typeof event !== 'object') {
        logs.push({type: 'raw', line})
        return
      }

      if (event.type === 'log') {
        logs.push(event)
        return
      }

      if (event.type === 'failure') {
        reject(
          new Error(
            `${role} failed: ${String(event.message)}\nstderr:\n${stderr}\nlogs:\n${JSON.stringify(logs, null, 2)}`
          )
        )
        return
      }

      if (event.type === 'success') {
        successEvent = event
      }
    })

    child.stderr.on('data', data => (stderr += String(data)))

    child.on('error', reject)
    child.on('exit', code => {
      if (code === 0 && successEvent) {
        resolve(successEvent)
        return
      }

      reject(
        new Error(
          `${role} exited with code ${String(code)}\n${stderr}\nlogs:\n${JSON.stringify(logs, null, 2)}`
        )
      )
    })
  })

  return {child, done}
}

const runNodeTests = (
  strategy: string,
  options: {timeout?: number; skip?: boolean} = {}
) => {
  const {timeout = 120_000, skip = false} = options
  const config = strategyConfigs[strategy] ?? {}
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const appId = (config['appId'] as string) ?? `trystero-node-${suffix}`
  const roomId = `room-${suffix}`
  const roomConfig: Record<string, unknown> = {
    appId,
    password: `03d1p@M@@s${Math.random()}`,
    ...config
  }

  void test(
    `Trystero: ${strategy} connects peers using node`,
    {timeout, skip},
    async () => {
      const relays =
        strategy === 'ws-relay'
          ? [createWsRelayServer({port: 0}), createWsRelayServer({port: 0})]
          : []

      await Promise.all(relays.map(relay => relay.ready))

      const testRoomConfig =
        strategy === 'ws-relay'
          ? {
              ...roomConfig,
              relayConfig: {
                ...(roomConfig['relayConfig'] as Record<string, unknown>),
                urls: relays.map(relay => {
                  const address = relay.address()

                  assert.ok(address && typeof address === 'object')

                  return `ws://localhost:${address.port}`
                })
              }
            }
          : roomConfig

      const peers = [
        startPeer({
          role: 'initiator',
          strategy,
          roomId,
          roomConfig: testRoomConfig
        }),
        startPeer({
          role: 'responder',
          strategy,
          roomId,
          roomConfig: testRoomConfig
        })
      ]

      try {
        if (strategy === 'ws-relay') {
          try {
            await waitForSubscriptions(relays)
          } catch (err) {
            for (const {child} of peers) {
              child.kill('SIGTERM')
            }

            await Promise.allSettled(peers.map(peer => peer.done))

            throw err
          }
        }

        const results = (await Promise.allSettled(
          peers.map(peer => peer.done)
        )) as {
          status: 'fulfilled' | 'rejected'
          value?: {role: string; message: string}
          reason?: {message: string}
        }[]
        const failures = results.filter(r => r.status === 'rejected')

        if (failures.length) {
          throw new Error(
            failures
              .map(failure =>
                JSON.stringify(
                  failure.status === 'rejected'
                    ? (failure.reason?.message ?? failure.reason)
                    : ''
                )
              )
              .join('\n\n')
          )
        }

        const [initiator, responder]: [
          {role: string; message: string} | null,
          {role: string; message: string} | null
        ] = results.map(
          result => result.status === 'fulfilled' && result.value
        ) as [
          {role: string; message: string} | null,
          {role: string; message: string} | null
        ]

        assert.equal(initiator?.role, 'initiator')
        assert.equal(initiator?.message, 'received pong')
        assert.equal(responder?.role, 'responder')
        assert.equal(responder?.message, 'received ping')
      } finally {
        for (const {child} of peers) {
          child.kill('SIGTERM')
        }

        await Promise.all(relays.map(relay => relay.close()))
      }
    }
  )
}

runNodeTests('nostr', {timeout: 20_000})
runNodeTests('mqtt', {timeout: 20_000})
runNodeTests('torrent', {timeout: 20_000})
runNodeTests('firebase', {timeout: 20_000})
runNodeTests('supabase', {timeout: 20_000})
runNodeTests('ws-relay', {timeout: 20_000})
runNodeTests('ipfs', {timeout: 50_000, skip: true})
