import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFile, writeFile} from 'node:fs/promises'
import WebSocket, {WebSocketServer} from 'ws'
import {createEvent, subscribe} from '@trystero-p2p/nostr'

// NIP-66: https://github.com/nostr-protocol/nips/blob/master/66.md
// Health is an estimate from fresh monitor agreement and two live round trips,
// not a historical uptime percentage. Latency depends on where this is run.
const discoveryUrl = 'wss://relay.nostr.watch'
const timeoutMs = 8_000
const maxAgeSeconds = 48 * 60 * 60
const targetCount = 30

type Report = {
  pubkey: string
  created_at: number
  tags: string[][]
  content: string
}

type Policy = {
  limitation?: {
    auth_required?: boolean
    payment_required?: boolean
    restricted_writes?: boolean
    min_pow_difficulty?: number
  }
  fees?: Record<string, {amount: number}[]>
}

const unrestricted = (policy: Policy): boolean => {
  const limits = policy.limitation
  return (
    !limits?.auth_required &&
    !limits?.payment_required &&
    !limits?.restricted_writes &&
    !(Number(limits?.min_pow_difficulty ?? 0) > 0) &&
    !Object.values(policy.fees ?? {}).some(fees =>
      fees.some(fee => fee.amount > 0)
    )
  )
}

const eligible = (report: Report): boolean => {
  const requirements = report.tags
    .filter(tag => tag[0] === 'R')
    .map(tag => tag[1])
  try {
    return (
      ['auth', 'payment', 'pow'].every(
        key => requirements.includes('!' + key) && !requirements.includes(key)
      ) &&
      !requirements.includes('writes') &&
      unrestricted(JSON.parse(report.content || '{}'))
    )
  } catch {
    return false
  }
}

const normalize = (value: string): string | undefined => {
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'wss:' ||
      url.username ||
      url.password ||
      url.hash ||
      url.hostname.endsWith('.onion') ||
      url.hostname.endsWith('.i2p')
    ) {
      return undefined
    }
    return url.href.replace(/\/$/, '')
  } catch {
    return undefined
  }
}

const quoteUrl = (url: string): string =>
  JSON.stringify(url).replace(/'/g, "\\'").replace(/^"|"$/g, "'")

const rawDataToString = (raw: WebSocket.RawData): string =>
  (Array.isArray(raw)
    ? Buffer.concat(raw)
    : raw instanceof ArrayBuffer
      ? Buffer.from(raw)
      : raw
  ).toString()

const discover = (): Promise<Report[]> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(discoveryUrl)
    const reports: Report[] = []
    const timer = setTimeout(
      () => finish(new Error('NIP-66 discovery timed out')),
      30_000
    )
    const finish = (error?: Error) => {
      clearTimeout(timer)
      socket.terminate()
      if (error) {
        reject(error)
      } else {
        resolve(reports)
      }
    }
    socket.on('error', finish)
    socket.on('close', () => finish(new Error('Discovery connection closed')))
    socket.on('open', () =>
      socket.send(
        JSON.stringify([
          'REQ',
          'discovery',
          {kinds: [30166], since: Math.floor(Date.now() / 1000) - maxAgeSeconds}
        ])
      )
    )
    socket.on('message', raw => {
      try {
        const message = JSON.parse(rawDataToString(raw))
        if (message[0] === 'EVENT' && message[1] === 'discovery') {
          const report = message[2]
          if (
            report.kind === 30166 &&
            typeof report.pubkey === 'string' &&
            Number.isFinite(report.created_at) &&
            Array.isArray(report.tags) &&
            report.tags.every(
              (tag: unknown) =>
                Array.isArray(tag) &&
                tag.every(value => typeof value === 'string')
            ) &&
            typeof report.content === 'string'
          ) {
            reports.push(report)
          }
        } else if (message[0] === 'EOSE' && message[1] === 'discovery') {
          finish()
        } else if (message[0] === 'CLOSED') {
          finish(new Error(String(message[2])))
        }
      } catch {
        finish(new Error('Invalid discovery response'))
      }
    })
  })

const probe = async (url: string): Promise<number> => {
  const topic = randomUUID()
  const subId = randomUUID()
  const payload = await createEvent(topic, randomUUID())
  const event = JSON.parse(payload)[1]
  // Match test:relays too: reject relays that require an existing listener.
  const preflight = await createEvent(randomUUID(), randomUUID())
  const preflightId = JSON.parse(preflight)[1].id
  const start = performance.now()
  const reader = new WebSocket(url)
  const writer = new WebSocket(url)
  try {
    return await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('round trip timed out')),
        timeoutMs
      )
      let subscribed = false
      let writable = false
      let acknowledged = false
      let received = false
      const complete = () => {
        if (acknowledged && received) {
          clearTimeout(timer)
          resolve(performance.now() - start)
        }
      }
      const fail = (error: Error) => {
        clearTimeout(timer)
        reject(error)
      }
      const publish = () => {
        if (subscribed && writable && writer.readyState === WebSocket.OPEN) {
          writer.send(payload)
        }
      }
      reader.on('open', () => reader.send(subscribe(subId, topic)))
      writer.on('open', () => writer.send(preflight))
      for (const socket of [reader, writer]) {
        socket.on('error', fail)
        socket.on('close', () => fail(new Error('connection closed')))
        socket.on('message', raw => {
          try {
            const message = JSON.parse(rawDataToString(raw))
            if (message[0] === 'CLOSED') {
              fail(new Error(String(message[2])))
            } else if (
              socket === reader &&
              message[0] === 'EOSE' &&
              message[1] === subId
            ) {
              subscribed = true
              publish()
            } else if (
              socket === writer &&
              message[0] === 'OK' &&
              (message[1] === event.id || message[1] === preflightId)
            ) {
              if (message[2] !== true) {
                fail(new Error(String(message[3])))
              } else if (message[1] === preflightId) {
                writable = true
                publish()
              } else {
                acknowledged = true
                complete()
              }
            } else if (
              socket === reader &&
              message[0] === 'EVENT' &&
              message[1] === subId &&
              message[2]?.id === event.id
            ) {
              received = true
              complete()
            }
            // An optional AUTH challenge is harmless: never authenticate, pay,
            // or mine PoW; success requires public read/write without them.
          } catch {
            fail(new Error('Invalid relay response'))
          }
        })
      }
    })
  } finally {
    reader.terminate()
    writer.terminate()
  }
}

const main = async () => {
  const latest = new Map<string, Map<string, Report>>()
  const now = Date.now() / 1000
  for (const report of await discover()) {
    const url = normalize(report.tags.find(tag => tag[0] === 'd')?.[1] ?? '')
    if (
      !url ||
      report.created_at < now - maxAgeSeconds ||
      report.created_at > now + 300
    ) {
      continue
    }
    const monitors = latest.get(url) ?? new Map<string, Report>()
    if (
      !monitors.has(report.pubkey) ||
      monitors.get(report.pubkey)!.created_at < report.created_at
    ) {
      monitors.set(report.pubkey, report)
    }
    latest.set(url, monitors)
  }
  const candidates = [...latest]
    .flatMap(([url, monitors]) => {
      const reports = [...monitors.values()]
      if (!reports.every(eligible)) {
        return []
      }
      const ageHours =
        (now - Math.max(...reports.map(report => report.created_at))) / 3600
      const rtts = reports.flatMap(report =>
        report.tags
          .filter(tag => ['rtt-open', 'rtt-read', 'rtt-write'].includes(tag[0]))
          .map(tag => Number(tag[1]))
          .filter(value => Number.isFinite(value) && value > 0)
      )
      if (!rtts.length) {
        return []
      }
      const monitorMs =
        rtts.reduce((sum, value) => sum + value, 0) / rtts.length
      // Lower is better: freshness and independent monitor agreement estimate health.
      const healthPenalty = ageHours * 25 + 200 / reports.length
      return [
        {url, monitorMs, healthPenalty, estimate: monitorMs + healthPenalty}
      ]
    })
    .sort((a, b) => a.estimate - b.estimate || a.url.localeCompare(b.url))

  console.log(
    `${candidates.length} unrestricted NIP-66 candidates; checking all`
  )
  const selected: ((typeof candidates)[number] & {
    liveMs: number
    score: number
  })[] = []
  let next = 0
  await Promise.all(
    Array.from({length: 10}, async () => {
      while (next < candidates.length) {
        const candidate = candidates[next++]
        try {
          const response = await fetch(
            candidate.url.replace(/^wss:/, 'https:'),
            {
              headers: {Accept: 'application/nostr+json'},
              signal: AbortSignal.timeout(timeoutMs)
            }
          )
          if (
            !response.ok ||
            !response.headers.get('content-type')?.includes('json')
          ) {
            throw new Error('NIP-11 unavailable')
          }
          const policy = (await response.json()) as Policy
          if (
            !policy ||
            typeof policy !== 'object' ||
            Array.isArray(policy) ||
            !unrestricted(policy)
          ) {
            throw new Error('restricted NIP-11 policy')
          }
          const first = await probe(candidate.url)
          const second = await probe(candidate.url)
          const liveMs = (first + second) / 2
          const score =
            candidate.healthPenalty + candidate.monitorMs * 0.25 + liveMs * 0.75
          selected.push({...candidate, liveMs, score})
          console.log(`PASS ${Math.round(liveMs)}ms ${candidate.url}`)
        } catch (error) {
          console.log(
            `SKIP ${candidate.url}: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
    })
  )
  selected.sort((a, b) => a.score - b.score || a.url.localeCompare(b.url))
  console.table(
    selected.slice(0, targetCount).map(({url, liveMs, score}) => ({
      url,
      liveMs: Math.round(liveMs),
      score: Math.round(score)
    }))
  )
  if (selected.length < targetCount) {
    throw new Error(
      `Only ${selected.length} relays passed; default list left unchanged`
    )
  }
  const urls = selected
    .slice(0, targetCount)
    .map(candidate => candidate.url.slice(6))
    .sort()
  const path = new URL('../packages/nostr/src/index.ts', import.meta.url)
  const source = await readFile(path, 'utf8')
  const pattern =
    /export const defaultRelayUrls = \[[\s\S]*?\]\.map\(url => 'wss:\/\/' \+ url\)/g
  assert.equal(
    [...source.matchAll(pattern)].length,
    1,
    'Expected exactly one default relay list'
  )
  await writeFile(
    path,
    source.replace(
      pattern,
      `export const defaultRelayUrls = [\n${urls.map(url => `  ${quoteUrl(url)}`).join(',\n')}\n].map(url => 'wss://' + url)`
    )
  )
  console.log(`Updated ${targetCount} alphabetized defaults`)
}

if (process.argv.includes('--self-test')) {
  const report: Report = {
    pubkey: 'monitor',
    created_at: 0,
    content: '{}',
    tags: ['!auth', '!payment', '!pow'].map(value => ['R', value])
  }
  assert.ok(eligible(report))
  assert.ok(!eligible({...report, tags: report.tags.slice(1)}))
  for (const requirement of ['auth', 'payment', 'pow', 'writes']) {
    assert.ok(
      !eligible({...report, tags: [...report.tags, ['R', requirement]]})
    )
  }
  for (const limitation of [
    {auth_required: true},
    {payment_required: true},
    {restricted_writes: true},
    {min_pow_difficulty: 1}
  ]) {
    assert.ok(!unrestricted({limitation}))
  }
  assert.ok(!unrestricted({fees: {publication: [{amount: 1}]}}))
  assert.equal(normalize('wss://EXAMPLE.com/'), 'wss://example.com')
  assert.equal(normalize('wss://user:pass@example.com'), undefined)
  assert.equal(normalize('ws://example.com'), undefined)
  // Exercise actual cross-connection delivery and rejection without public relays.
  const server = new WebSocketServer({host: '127.0.0.1', port: 0})
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address()
  assert.ok(typeof address === 'object' && address)
  const subscriptions = new Map<WebSocket, string>()
  let deny = false
  server.on('connection', socket =>
    socket.on('message', raw => {
      const message = JSON.parse(rawDataToString(raw))
      if (message[0] === 'REQ') {
        subscriptions.set(socket, message[1])
        socket.send(JSON.stringify(['EOSE', message[1]]))
      } else if (message[0] === 'EVENT') {
        socket.send(
          JSON.stringify([
            'OK',
            message[1].id,
            !deny,
            deny ? 'auth-required' : ''
          ])
        )
        if (!deny) {
          for (const [reader, id] of subscriptions) {
            if (reader.readyState === WebSocket.OPEN) {
              reader.send(JSON.stringify(['EVENT', id, message[1]]))
            }
          }
        }
      }
    })
  )
  try {
    const url = `ws://127.0.0.1:${address.port}`
    assert.ok((await probe(url)) >= 0)
    deny = true
    await assert.rejects(probe(url), /auth-required/)
  } finally {
    for (const socket of server.clients) {
      socket.terminate()
    }
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  console.log('Relay policy, URL, delivery and rejection checks passed')
} else {
  await main()
}
