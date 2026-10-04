import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFile, writeFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import WebSocket, {WebSocketServer} from 'ws'
import {chromium, type Browser} from 'playwright'
import {createEvent, subscribe} from '@trystero-p2p/nostr'

// NIP-66: https://github.com/nostr-protocol/nips/blob/master/66.md
// Health estimates use fresh monitor agreement and two live round trips,
// then require a real Trystero connection and bidirectional action exchange.
// This is not historical uptime. Latency depends on where this is run.
const discoveryUrl = 'wss://relay.nostr.watch'
const timeoutMs = 8_000
const trysteroTimeoutMs = 15_000
const maxAgeSeconds = 48 * 60 * 60
const targetCount = 30
const startedAt = performance.now()
const log = (message: string): void =>
  console.log(
    `[${((performance.now() - startedAt) / 1000).toFixed(1)}s] ${message}`
  )

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

const discover = (url = discoveryUrl, deadlineMs = 30_000): Promise<Report[]> =>
  new Promise((resolve, reject) => {
    log(`NIP-66: connecting to ${url} (timeout ${deadlineMs / 1000}s)`)
    const socket = new WebSocket(url)
    const reports: Report[] = []
    let phase = 'connecting'
    let frames = 0
    let finished = false
    const status = () => `${phase}; ${reports.length} reports; ${frames} frames`
    const progress = setInterval(() => log(`NIP-66: ${status()}`), 5_000)
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            `NIP-66 discovery timed out at ${url} after ${deadlineMs / 1000}s (${status()})`
          )
        ),
      deadlineMs
    )
    const finish = (error?: Error) => {
      if (finished) {
        return
      }
      finished = true
      clearTimeout(timer)
      clearInterval(progress)
      socket.terminate()
      if (error) {
        log(`NIP-66: failed — ${error.message}`)
        reject(error)
      } else {
        log(`NIP-66: discovery complete; ${reports.length} reports received`)
        resolve(reports)
      }
    }
    socket.on('error', finish)
    socket.on('close', () => finish(new Error('Discovery connection closed')))
    socket.on('open', () => {
      phase = 'waiting for reports/EOSE'
      log(
        `NIP-66: connected; requesting kind 30166 reports from the last ${maxAgeSeconds / 3600} hours`
      )
      socket.send(
        JSON.stringify([
          'REQ',
          'discovery',
          {kinds: [30166], since: Math.floor(Date.now() / 1000) - maxAgeSeconds}
        ])
      )
    })
    socket.on('message', raw => {
      frames++
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
            phase = 'receiving reports; waiting for EOSE'
            if (reports.length === 1) {
              log('NIP-66: first report received')
            }
          }
        } else if (message[0] === 'EOSE' && message[1] === 'discovery') {
          finish()
        } else if (message[0] === 'CLOSED') {
          finish(new Error(String(message[2])))
        } else if (message[0] === 'NOTICE') {
          log(`NIP-66: relay notice: ${String(message[1])}`)
        } else if (message[0] === 'AUTH') {
          log(
            'NIP-66: relay requested authentication; waiting for public discovery results'
          )
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

const probeTrystero = async (
  browser: Browser,
  siteUrl: string,
  url: string,
  deadlineMs = trysteroTimeoutMs
): Promise<number> => {
  const contexts = []
  const config = {
    appId: `trystero-relay-probe-${randomUUID()}`,
    password: randomUUID(),
    // The clients are local; measure signaling without depending on STUN.
    rtcConfig: {iceServers: []},
    relayConfig: {urls: [url], redundancy: 1, warnOnRelayFailure: false}
  }
  try {
    const pages = []
    for (let i = 0; i < 2; i++) {
      const context = await browser.newContext()
      contexts.push(context)
      const page = await context.newPage()
      const client = i + 1
      page.on('console', message => {
        if (message.text().startsWith('relay-probe:')) {
          log(
            `Trystero ${url} client ${client}: ${message.text().slice('relay-probe:'.length).trim()}`
          )
        }
      })
      await page.goto(siteUrl)
      pages.push(page)
    }
    const start = performance.now()
    log(
      `Trystero ${url}: clients ready; starting discovery, connection and action checks (timeout ${deadlineMs / 1000}s)`
    )
    const results = await Promise.all(
      pages.map(page =>
        page.evaluate(
          async ({config, deadlineMs}) => {
            const {joinRoom, selfId} = (
              window as unknown as {
                trystero: typeof import('@trystero-p2p/nostr')
              }
            ).trystero
            let timer: ReturnType<typeof setTimeout>
            let phase = 'waiting for peer discovery/connection'
            try {
              return await new Promise<{
                selfId: string
                peerId: string
                response: string
              }>((resolve, reject) => {
                timer = setTimeout(
                  () =>
                    reject(
                      new Error(
                        `Trystero connection/action timed out (${phase})`
                      )
                    ),
                  deadlineMs
                )
                const room = joinRoom(config, 'probe', {
                  onJoinError: ({error}) => reject(new Error(error))
                })
                const action = room.makeAction<string, string>('relay-probe', {
                  kind: 'request',
                  onRequest: data => data
                })
                room.onPeerJoin = peerId => {
                  phase = 'waiting for action response'
                  console.log(
                    'relay-probe: peer connected; sending action request'
                  )
                  void action
                    .request(selfId, {target: peerId, timeoutMs: deadlineMs})
                    .then(response => {
                      console.log('relay-probe: action response received')
                      resolve({selfId, peerId, response})
                    }, reject)
                }
              })
            } finally {
              clearTimeout(timer!)
            }
          },
          {config, deadlineMs}
        )
      )
    )
    assert.notEqual(results[0].selfId, results[1].selfId)
    for (const [i, result] of results.entries()) {
      assert.equal(result.peerId, results[1 - i].selfId)
      assert.equal(result.response, result.selfId)
    }
    return performance.now() - start
  } finally {
    // Dispose both isolated clients, including their sockets and timers, on failure.
    await Promise.all(contexts.map(context => context.close()))
  }
}

const main = async (browser: Browser, siteUrl: string) => {
  log(
    `Discovering and ranking relay candidates; target ${targetCount} defaults`
  )
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

  log(
    `${latest.size} reported relay URLs; ${candidates.length} unrestricted candidates; testing policies and two round trips with 10 workers`
  )
  const preliminary: ((typeof candidates)[number] & {
    liveMs: number
    score: number
  })[] = []
  let next = 0
  await Promise.all(
    Array.from({length: 10}, async () => {
      while (next < candidates.length) {
        const candidate = candidates[next++]
        try {
          log(
            `Preliminary ${next}/${candidates.length}: checking NIP-11 policy at ${candidate.url}`
          )
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
          log(
            `Preliminary ${candidate.url}: policy passed; starting round trip 1/2`
          )
          const first = await probe(candidate.url)
          log(
            `Preliminary ${candidate.url}: round trip 1/2 passed (${Math.round(first)}ms); starting 2/2`
          )
          const second = await probe(candidate.url)
          const liveMs = (first + second) / 2
          const score =
            candidate.healthPenalty + candidate.monitorMs * 0.25 + liveMs * 0.75
          preliminary.push({...candidate, liveMs, score})
          log(`PREFLIGHT ${Math.round(liveMs)}ms ${candidate.url}`)
        } catch (error) {
          log(
            `SKIP ${candidate.url}: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
    })
  )
  log(
    `${preliminary.length}/${candidates.length} passed preliminary checks; testing Trystero with 3 workers`
  )
  const selected: ((typeof preliminary)[number] & {trysteroMs: number})[] = []
  next = 0
  await Promise.all(
    Array.from({length: 3}, async () => {
      while (next < preliminary.length) {
        const candidate = preliminary[next++]
        try {
          log(
            `Trystero ${next}/${preliminary.length}: preparing isolated clients for ${candidate.url}`
          )
          const trysteroMs = await probeTrystero(
            browser,
            siteUrl,
            candidate.url
          )
          selected.push({...candidate, trysteroMs})
          log(`PASS Trystero ${Math.round(trysteroMs)}ms ${candidate.url}`)
        } catch (error) {
          log(
            `SKIP ${candidate.url}: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
    })
  )
  selected.sort((a, b) => a.score - b.score || a.url.localeCompare(b.url))
  log(
    `${selected.length}/${preliminary.length} passed Trystero; selecting the best ${targetCount}`
  )
  console.table(
    selected.slice(0, targetCount).map(({url, liveMs, trysteroMs, score}) => ({
      url,
      liveMs: Math.round(liveMs),
      trysteroMs: Math.round(trysteroMs),
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
  log(`Writing ${targetCount} relay defaults to ${path.pathname}`)
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
  log(`Updated ${targetCount} alphabetized defaults`)
}

log('Starting Nostr relay updater; loading built Trystero browser bundle')
const bundle = await readFile(
  new URL('../dist/trystero-nostr.min.js', import.meta.url)
)
const site = createServer((request, response) => {
  response.setHeader(
    'Content-Type',
    request.url === '/trystero.js' ? 'text/javascript' : 'text/html'
  )
  response.end(
    request.url === '/trystero.js'
      ? bundle
      : '<!doctype html><title>Trystero relay probe</title><script type="module">import * as trystero from "/trystero.js"; window.trystero = trystero;</script>'
  )
})
let browser: Browser | undefined
try {
  log('Starting local browser test server')
  await new Promise<void>((resolve, reject) => {
    site.once('error', reject)
    site.listen(0, '127.0.0.1', resolve)
  })
  const address = site.address()
  assert.ok(address && typeof address !== 'string')
  const siteUrl = `http://127.0.0.1:${address.port}`
  log(`Local test server ready at ${siteUrl}; launching Chromium`)
  browser = await chromium.launch({
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns']
  })
  log('Chromium ready')
  if (process.argv.includes('--self-test')) {
    log('Running local policy, discovery and relay behavior self-tests')
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
    const subscriptions = new Map<
      WebSocket,
      Map<string, {kinds: number[]; '#x': string[]}>
    >()
    let deny = false
    let rejectBatched = false
    let dropSignals = false
    let stallDiscovery = false
    let batchedRequests = 0
    let signals = 0
    server.on('connection', socket =>
      socket.on('message', raw => {
        const message = JSON.parse(rawDataToString(raw))
        if (message[0] === 'REQ') {
          if (message[1] === 'discovery') {
            socket.send(
              JSON.stringify(['EVENT', 'discovery', {...report, kind: 30166}])
            )
            if (!stallDiscovery) {
              socket.send(JSON.stringify(['EOSE', 'discovery']))
            }
            return
          }
          const filter = message[2]
          if (filter['#x'].length > 1) {
            batchedRequests++
            if (rejectBatched) {
              socket.send(
                JSON.stringify([
                  'CLOSED',
                  message[1],
                  'unsupported batched subscription'
                ])
              )
              return
            }
          }
          const topics = subscriptions.get(socket) ?? new Map()
          topics.set(message[1], filter)
          subscriptions.set(socket, topics)
          socket.send(JSON.stringify(['EOSE', message[1]]))
        } else if (message[0] === 'CLOSE') {
          subscriptions.get(socket)?.delete(message[1])
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
            const event = message[1]
            let payload
            try {
              payload = JSON.parse(event.content)
            } catch {}
            if (payload?.offer || payload?.answer || payload?.candidate) {
              signals++
              if (dropSignals) {
                return
              }
            }
            const topic = event.tags.find(
              (tag: string[]) => tag[0] === 'x'
            )?.[1]
            for (const [reader, topics] of subscriptions) {
              for (const [id, filter] of topics) {
                if (
                  reader.readyState === WebSocket.OPEN &&
                  filter['#x'].includes(topic) &&
                  filter.kinds.includes(event.kind)
                ) {
                  reader.send(JSON.stringify(['EVENT', id, event]))
                }
              }
            }
          }
        }
      })
    )
    try {
      const url = `ws://127.0.0.1:${address.port}`
      assert.deepEqual(await discover(url), [{...report, kind: 30166}])
      stallDiscovery = true
      await assert.rejects(
        discover(url, 100),
        /discovery timed out.*receiving reports; waiting for EOSE; 1 reports; 1 frames/
      )
      assert.ok((await probe(url)) >= 0)
      assert.ok((await probeTrystero(browser, siteUrl, url)) >= 0)
      assert.ok(
        batchedRequests > 0,
        'real Trystero must exercise batched subscriptions'
      )
      assert.ok(signals > 0, 'real Trystero must exchange SDP')
      deny = true
      await assert.rejects(probe(url), /auth-required/)
      deny = false
      rejectBatched = true
      assert.ok((await probe(url)) >= 0)
      await assert.rejects(
        probeTrystero(browser, siteUrl, url, 1_500),
        /Trystero connection\/action timed out/
      )
      rejectBatched = false
      dropSignals = true
      assert.ok((await probe(url)) >= 0)
      await assert.rejects(
        probeTrystero(browser, siteUrl, url, 1_500),
        /Trystero connection\/action timed out/
      )
    } finally {
      for (const socket of server.clients) {
        socket.terminate()
      }
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
    console.log(
      'Relay policy, URL, preliminary delivery, real Trystero and rejection checks passed'
    )
  } else {
    await main(browser, siteUrl)
  }
} finally {
  log('Closing browser and local test server')
  await browser?.close()
  await new Promise<void>(resolve => site.close(() => resolve()))
}
