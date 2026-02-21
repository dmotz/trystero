import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {dirname, join} from 'node:path'
import {createInterface} from 'node:readline'
import test from 'node:test'
import {fileURLToPath} from 'node:url'

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

const startPeer = ({
  role,
  appId,
  roomId
}: {
  role: string
  appId: string
  roomId: string
}) => {
  const child = spawn('pnpm', ['exec', 'jiti', peerScript], {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      TRYSTERO_NODE_ROLE: role,
      TRYSTERO_NODE_APP_ID: appId,
      TRYSTERO_NODE_ROOM_ID: roomId
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

test(
  'Trystero: nostr strategy works with two Node peers on public relays',
  {timeout: 120_000},
  async t => {
    const polyfillLoaded = await import('werift')
      .then(() => true)
      .catch(() => false)

    if (!polyfillLoaded) {
      t.skip('werift polyfill is unavailable in this environment')
      return
    }

    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const appId = `trystero-node-${suffix}`
    const roomId = `room-${suffix}`
    const peers = [
      startPeer({role: 'initiator', appId, roomId}),
      startPeer({role: 'responder', appId, roomId})
    ]

    try {
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
              failure.status === 'rejected'
                ? String(failure.reason?.message ?? failure.reason)
                : ''
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
    }
  }
)
