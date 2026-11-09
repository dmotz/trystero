import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFile, writeFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import WebSocket, {WebSocketServer} from 'ws'
import {chromium, type Browser} from 'playwright'
import {
  createEvent,
  createSigner,
  subscribeSince,
  tag,
  topicToKind
} from '../packages/nostr/src/protocol.ts'

const subscribe = (subId: string, topic: string): string =>
  JSON.stringify([
    'REQ',
    subId,
    {
      kinds: [topicToKind(topic)],
      since: subscribeSince(),
      ['#' + tag]: [topic]
    }
  ])

// NIP-66 + NIP-65 deterministic relay selection:
// 1. Discover active clearnet relays via paginated NIP-66 (kind 30166) reports,
//    requiring multi-monitor consensus that auth/payment/PoW are not required
//    and zero monitors reporting write/policy restrictions.
// 2. Measure real user adoption and proven multi-month/year longevity from
//    NIP-65 (kind 10002) relay list events across UTC-day-anchored checkpoints.
// 3. Enforce URL/hostname hygiene, deduplicate by apex domain, non-CDN origin
//    IP, and NIP-11 operator pubkey, grant incumbency hysteresis to healthy
//    existing defaults, and verify every selected relay via NIP-11, live
//    cross-socket ephemeral round trips, and Playwright Trystero WebRTC + RPC.
const discoveryUrl = 'wss://relay.nostr.watch'
const nip65IndexerUrls = [
  'wss://purplepag.es',
  'wss://indexer.coracle.social',
  'wss://user.kindpag.es',
  'wss://relay.primal.net',
  'wss://nos.lol'
]
const timeoutMs = 8_000
const trysteroTimeoutMs = 15_000
const daySeconds = 86_400
const maxAgeSeconds = 2 * daySeconds
const discoveryPageLimit = 5_000
const maxDiscoveryPages = 5
const nip65CheckpointDays = [0, 90, 180, 365, 730] as const
const nip65AgeTiersDays = [90, 180, 365, 730] as const
const nip65PerCheckpointLimit = 500
const maxNip65TagsPerEvent = 30
const minVerifiedMonitors = 3
const maxMonitorRttMs = 1_000
const maxLiveRttMs = 2_000
const maxTrysteroMs = 3_000
const minNip65Users = 3
const minNip65AgeDays = 90
const minAgeBucketUsers = 2
const incumbentBonus = 200
const targetCount = 30
const interProbeDelayMs = 300
const startedAt = performance.now()
const log = (message: string): void =>
  console.log(
    `[${((performance.now() - startedAt) / 1000).toFixed(1)}s] ${message}`
  )
const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))

type Report = {
  id?: string
  kind?: number
  pubkey: string
  created_at: number
  tags: string[][]
  content: string
}

type Policy = {
  pubkey?: string
  limitation?: {
    auth_required?: boolean
    payment_required?: boolean
    restricted_writes?: boolean
    min_pow_difficulty?: number
    max_subscriptions?: number
    max_message_length?: number
  }
  fees?: Record<string, {amount: number}[]>
}

type Nip65Stats = {
  usersByRelay: Map<string, Set<string>>
  oldestDaysByRelay: Map<string, number>
}

type Candidate = {
  url: string
  domainGroup: string
  ipv4?: string
  nip65Users: number
  oldestDays: number
  monitors: number
  verifiedMonitors: number
  medianMonitorMs: number
  incumbent: boolean
  score: number
}

type PreliminaryCandidate = Candidate & {
  liveMs: number
  operatorPubkey?: string
}

const unrestricted = (policy: Policy): boolean => {
  const limits = policy.limitation
  return (
    !limits?.auth_required &&
    !limits?.payment_required &&
    !limits?.restricted_writes &&
    !(Number(limits?.min_pow_difficulty ?? 0) > 0) &&
    (limits?.max_subscriptions === undefined ||
      limits.max_subscriptions >= 2) &&
    (limits?.max_message_length === undefined ||
      limits.max_message_length >= 16_384) &&
    !Object.values(policy.fees ?? {}).some(
      fees => Array.isArray(fees) && fees.some(fee => fee.amount > 0)
    )
  )
}

const inspectReport = (
  report: Report
): {restricted: boolean; verifiedUnrestricted: boolean} => {
  const requirements = report.tags
    .filter(entry => entry[0] === 'R' && typeof entry[1] === 'string')
    .map(entry => entry[1]!)
  try {
    const policy = JSON.parse(report.content || '{}') as unknown
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
      return {restricted: true, verifiedUnrestricted: false}
    }
    const restricted =
      !unrestricted(policy as Policy) ||
      ['auth', 'payment', 'pow', 'writes'].some(key =>
        requirements.includes(key)
      )
    const verifiedUnrestricted =
      !restricted &&
      ['auth', 'payment', 'pow'].every(key => requirements.includes('!' + key))
    return {restricted, verifiedUnrestricted}
  } catch {
    return {restricted: true, verifiedUnrestricted: false}
  }
}

const cdnProviderPattern = /cloudflare|fastly|cloudfront|akamai|bunny/i

const ephemeralHostPattern =
  /(^|[.-])(test|testr|testing|dev|devel|staging|stage|sandbox|demo|temp|tmp|local|localhost)([.-]|$)|\.(fly\.dev|duckdns\.org|mydns\.jp|dynu\.net|no-ip\.[a-z]+|ngrok(-free)?\.(app|dev|io)|trycloudflare\.com|onrender\.com|railway\.app|herokuapp\.com|vercel\.app|pages\.dev|workers\.dev|netlify\.app|ddns\.net|hopto\.org|zapto\.org|myftp\.org|sytes\.net|ts\.net|nip\.io|sslip\.io)$/i

const multiPartPublicSuffixes = new Set([
  'ac.jp',
  'co.id',
  'co.il',
  'co.in',
  'co.jp',
  'co.kr',
  'co.nz',
  'co.uk',
  'co.za',
  'com.ar',
  'com.au',
  'com.br',
  'com.co',
  'com.hk',
  'com.mx',
  'com.sg',
  'com.tr',
  'com.tw',
  'de.com',
  'dev.br',
  'eu.org',
  'me.uk',
  'ne.jp',
  'net.au',
  'net.br',
  'net.uk',
  'net.za',
  'or.jp',
  'org.au',
  'org.br',
  'org.nz',
  'org.uk',
  'org.za',
  'uk.com',
  'us.com'
])

const getDomainGroup = (url: string): string => {
  const parts = new URL(url).hostname.toLowerCase().split('.')
  if (parts.length <= 2) {
    return parts.join('.')
  }
  const suffix = parts.slice(-2).join('.')
  return multiPartPublicSuffixes.has(suffix)
    ? parts.slice(-3).join('.')
    : suffix
}

const normalize = (value: string): string | undefined => {
  try {
    const url = new URL(value.trim())
    const host = url.hostname.toLowerCase()
    if (
      url.protocol !== 'wss:' ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      url.port !== '' ||
      !host.includes('.') ||
      /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
      host.startsWith('[') ||
      host.endsWith('.onion') ||
      host.endsWith('.i2p') ||
      host.endsWith('.loki') ||
      ephemeralHostPattern.test(host)
    ) {
      return undefined
    }
    const path = url.pathname.replace(/\/+$/, '')
    return `${url.origin}${path}`
  } catch {
    return undefined
  }
}

const evaluateRelayReports = (
  reports: Report[]
):
  | {
      monitors: number
      verifiedMonitors: number
      medianMonitorMs: number
      ipv4?: string
    }
  | undefined => {
  if (reports.length === 0) {
    return undefined
  }
  let verifiedMonitors = 0
  for (const report of reports) {
    const {restricted, verifiedUnrestricted} = inspectReport(report)
    if (restricted) {
      return undefined
    }
    if (verifiedUnrestricted) {
      verifiedMonitors++
    }
  }
  if (verifiedMonitors < minVerifiedMonitors) {
    return undefined
  }
  const rtts = reports
    .flatMap(report =>
      report.tags
        .filter(
          (entry): entry is [string, string, ...string[]] =>
            typeof entry[0] === 'string' &&
            ['rtt-open', 'rtt-read', 'rtt-write'].includes(entry[0]) &&
            typeof entry[1] === 'string'
        )
        .map(entry => Number(entry[1]))
        .filter(value => Number.isFinite(value) && value > 0)
    )
    .sort((a, b) => a - b)
  if (rtts.length === 0) {
    return undefined
  }
  const medianMonitorMs = rtts[Math.floor(rtts.length / 2)]!
  if (medianMonitorMs > maxMonitorRttMs) {
    return undefined
  }
  const asLabels = reports.flatMap(report =>
    report.tags
      .filter(
        entry =>
          entry[0] === 'l' &&
          typeof entry[1] === 'string' &&
          (entry[2] === 'host.as' || entry[2] === 'host.isp')
      )
      .map(entry => entry[1]!)
  )
  const behindSharedCdn = asLabels.some(label => cdnProviderPattern.test(label))
  const ipv4 = behindSharedCdn
    ? undefined
    : reports.flatMap(report =>
        report.tags
          .filter(
            entry =>
              entry[0] === 'l' &&
              typeof entry[1] === 'string' &&
              entry[2] === 'dns.ipv4'
          )
          .map(entry => entry[1]!)
      )[0]
  return {
    monitors: reports.length,
    verifiedMonitors,
    medianMonitorMs,
    ...(ipv4 ? {ipv4} : {})
  }
}

const computeStructuralScore = ({
  oldestDays,
  nip65Users,
  verifiedMonitors,
  incumbent
}: {
  oldestDays: number
  nip65Users: number
  verifiedMonitors: number
  incumbent: boolean
}): number =>
  (oldestDays > 0 ? Math.round(Math.log2(oldestDays / 45) * 80) : 0) +
  Math.round(Math.log2(1 + nip65Users) * 50) +
  Math.min(verifiedMonitors, 6) * 20 +
  (incumbent ? incumbentBonus : 0)

const nostrIndexPath = new URL(
  '../packages/nostr/src/index.ts',
  import.meta.url
)

const quoteUrl = (url: string): string =>
  JSON.stringify(url).replace(/'/g, "\\'").replace(/^"|"$/g, "'")

const defaultRelayUrlsPattern =
  /^export const defaultRelayUrls(?::\s*string\[\])?\s*=\s*\[\s*(?:(?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")(?:\s*,\s*(?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"))*(?:\s*,)?\s*)?\](?=[ \t]*;?[ \t]*$)/gm

const parseDefaultRelayUrls = (source: string): Set<string> => {
  const matches = [...source.matchAll(defaultRelayUrlsPattern)]
  assert.equal(matches.length, 1, 'Expected exactly one default relay list')
  const urls = new Set<string>()
  const literalPattern = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g
  for (const literalMatch of matches[0]![0].matchAll(literalPattern)) {
    const raw = literalMatch[0]
    const unquoted =
      raw.startsWith("'") && raw.endsWith("'")
        ? JSON.parse(
            `"${raw.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"')}"`
          )
        : JSON.parse(raw)
    if (typeof unquoted === 'string') {
      const normalized = normalize(unquoted)
      if (normalized) {
        urls.add(normalized)
      }
    }
  }
  return urls
}

const updateDefaultRelayUrls = (source: string, urls: string[]): string => {
  assert.equal(
    [...source.matchAll(defaultRelayUrlsPattern)].length,
    1,
    'Expected exactly one default relay list'
  )
  return source.replace(defaultRelayUrlsPattern, () =>
    urls.length === 0
      ? 'export const defaultRelayUrls: string[] = []'
      : `export const defaultRelayUrls: string[] = [\n${urls.map(url => `  ${quoteUrl(url)}`).join(',\n')}\n]`
  )
}

const rawDataToString = (raw: WebSocket.RawData): string =>
  (Array.isArray(raw)
    ? Buffer.concat(raw)
    : raw instanceof ArrayBuffer
      ? Buffer.from(raw)
      : raw
  ).toString()

const discoverPage = (
  url: string,
  filter: Record<string, unknown>,
  deadlineMs: number,
  allowPartial = false
): Promise<{reports: Report[]; complete: boolean}> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const reports: Report[] = []
    let phase = 'connecting'
    let frames = 0
    let finished = false
    const status = () => `${phase}; ${reports.length} reports; ${frames} frames`
    const progress = setInterval(() => log(`NIP-66: ${status()}`), 5_000)
    const finish = (error?: Error, complete = true) => {
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
        resolve({reports, complete})
      }
    }
    const timer = setTimeout(() => {
      if (allowPartial) {
        log(
          `NIP-66: supplemental page deadline reached (${status()}); using collected backfill`
        )
        finish(undefined, false)
        return
      }
      finish(
        new Error(
          `NIP-66 discovery timed out at ${url} after ${deadlineMs / 1000}s (${status()})`
        )
      )
    }, deadlineMs)
    socket.on('error', err =>
      allowPartial ? finish(undefined, false) : finish(err)
    )
    socket.on('close', () =>
      allowPartial
        ? finish(undefined, false)
        : finish(new Error('Discovery connection closed'))
    )
    socket.on('open', () => {
      phase = 'waiting for reports/EOSE'
      socket.send(JSON.stringify(['REQ', 'discovery', filter]))
    })
    socket.on('message', raw => {
      frames++
      try {
        const message = JSON.parse(rawDataToString(raw))
        if (message[0] === 'EVENT' && message[1] === 'discovery') {
          const report = message[2]
          if (
            report &&
            report.kind === 30166 &&
            typeof report.pubkey === 'string' &&
            Number.isFinite(report.created_at) &&
            Array.isArray(report.tags) &&
            report.tags.every(
              (entry: unknown) =>
                Array.isArray(entry) &&
                entry.every(value => typeof value === 'string')
            ) &&
            typeof report.content === 'string'
          ) {
            reports.push(report as Report)
            phase = 'receiving reports; waiting for EOSE'
            if (reports.length === 1) {
              log('NIP-66: first report received')
            }
          }
        } else if (message[0] === 'EOSE' && message[1] === 'discovery') {
          finish(undefined, true)
        } else if (message[0] === 'CLOSED') {
          if (allowPartial) {
            finish(undefined, false)
          } else {
            finish(new Error(String(message[2])))
          }
        } else if (message[0] === 'NOTICE') {
          log(`NIP-66: relay notice: ${String(message[1])}`)
        } else if (message[0] === 'AUTH') {
          log(
            'NIP-66: relay requested authentication; waiting for public discovery results'
          )
        }
      } catch {
        if (allowPartial) {
          finish(undefined, false)
        } else {
          finish(new Error('Invalid discovery response'))
        }
      }
    })
  })

const discover = async (
  url = discoveryUrl,
  deadlineMs = 30_000,
  pageLimit = discoveryPageLimit
): Promise<Report[]> => {
  const since = Math.floor(Date.now() / 1000) - maxAgeSeconds
  let until = Math.floor(Date.now() / 1000) + 300
  const deduplicated = new Map<string, Report>()
  log(
    `NIP-66: connecting to ${url} (window ${maxAgeSeconds / 3600}h, page limit ${pageLimit})`
  )
  for (let page = 1; page <= maxDiscoveryPages; page++) {
    const isSupplemental = page > 1
    const {reports: pageReports, complete} = await discoverPage(
      url,
      {kinds: [30166], since, until, limit: pageLimit},
      isSupplemental ? Math.min(deadlineMs, 8_000) : deadlineMs,
      isSupplemental
    )
    let pageMinCreated = until
    let added = 0
    for (const report of pageReports) {
      const dTag = report.tags.find(entry => entry[0] === 'd')?.[1] ?? ''
      const key =
        typeof report.id === 'string' && report.id.length > 0
          ? report.id
          : `${report.pubkey}:${report.created_at}:${dTag}`
      if (!deduplicated.has(key)) {
        deduplicated.set(key, report)
        added++
      }
      if (report.created_at < pageMinCreated) {
        pageMinCreated = report.created_at
      }
    }
    log(
      `NIP-66: page ${page} complete (${pageReports.length} reports, ${added} new)`
    )
    if (
      !complete ||
      pageReports.length < pageLimit ||
      added === 0 ||
      pageMinCreated <= since ||
      pageMinCreated >= until
    ) {
      break
    }
    until = pageMinCreated
  }
  log(`NIP-66: discovery complete; ${deduplicated.size} unique reports`)
  return [...deduplicated.values()]
}

const queryNip65Indexer = (
  url: string,
  checkpoints: readonly number[],
  perCheckpointLimit: number,
  deadlineMs = 15_000
): Promise<Report[]> =>
  new Promise(resolve => {
    const events: Report[] = []
    const socket = new WebSocket(url)
    let index = 0
    let finished = false
    const finish = () => {
      if (finished) {
        return
      }
      finished = true
      clearTimeout(timer)
      socket.terminate()
      resolve(events)
    }
    const timer = setTimeout(finish, deadlineMs)
    const requestNext = () => {
      if (index >= checkpoints.length || socket.readyState !== WebSocket.OPEN) {
        finish()
        return
      }
      const until = checkpoints[index++]!
      socket.send(
        JSON.stringify([
          'REQ',
          `nip65-${index}`,
          {kinds: [10002], until, limit: perCheckpointLimit}
        ])
      )
    }
    socket.on('error', () => finish())
    socket.on('close', () => finish())
    socket.on('open', requestNext)
    socket.on('message', raw => {
      try {
        const message = JSON.parse(rawDataToString(raw))
        const subId = `nip65-${index}`
        if (message[0] === 'EVENT' && message[1] === subId) {
          const event = message[2]
          if (
            event &&
            event.kind === 10002 &&
            typeof event.pubkey === 'string' &&
            /^[0-9a-f]{64}$/i.test(event.pubkey) &&
            Number.isFinite(event.created_at) &&
            Array.isArray(event.tags)
          ) {
            events.push(event as Report)
          }
        } else if (
          (message[0] === 'EOSE' || message[0] === 'CLOSED') &&
          message[1] === subId
        ) {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(['CLOSE', subId]))
          }
          requestNext()
        }
      } catch {
        // Ignore malformed indexer frames and continue collecting valid events.
      }
    })
  })

const aggregateNip65Events = (
  events: readonly Report[],
  dayAnchorSeconds: number
): Nip65Stats => {
  const usersByRelay = new Map<string, Set<string>>()
  const ageBuckets = new Map<string, Map<number, Set<string>>>()
  for (const event of events) {
    if (event.created_at > dayAnchorSeconds + daySeconds) {
      continue
    }
    const pubkey = event.pubkey.toLowerCase()
    const rTags = event.tags.filter(
      entry => entry[0] === 'r' && typeof entry[1] === 'string'
    )
    if (rTags.length === 0 || rTags.length > maxNip65TagsPerEvent) {
      continue
    }
    const ageDays = Math.floor(
      (dayAnchorSeconds - event.created_at) / daySeconds
    )
    const urls = new Set<string>()
    for (const entry of rTags) {
      // Trystero needs both read and write; skip read-only NIP-65 entries.
      if (entry[2] === 'read') {
        continue
      }
      const normalized = normalize(entry[1]!)
      if (normalized) {
        urls.add(normalized)
      }
    }
    for (const url of urls) {
      let users = usersByRelay.get(url)
      if (!users) {
        users = new Set()
        usersByRelay.set(url, users)
      }
      users.add(pubkey)

      let buckets = ageBuckets.get(url)
      if (!buckets) {
        buckets = new Map()
        ageBuckets.set(url, buckets)
      }
      for (const tier of nip65AgeTiersDays) {
        if (ageDays >= tier) {
          let tierUsers = buckets.get(tier)
          if (!tierUsers) {
            tierUsers = new Set()
            buckets.set(tier, tierUsers)
          }
          tierUsers.add(pubkey)
        }
      }
    }
  }
  const oldestDaysByRelay = new Map<string, number>()
  for (const [url, buckets] of ageBuckets) {
    let oldest = 0
    for (const [tier, tierUsers] of buckets) {
      if (tierUsers.size >= minAgeBucketUsers && tier > oldest) {
        oldest = tier
      }
    }
    oldestDaysByRelay.set(url, oldest)
  }
  return {usersByRelay, oldestDaysByRelay}
}

const discoverNip65Stats = async (
  dayAnchorSeconds: number,
  indexerUrls: readonly string[] = nip65IndexerUrls,
  perCheckpointLimit = nip65PerCheckpointLimit
): Promise<Nip65Stats> => {
  const checkpoints = nip65CheckpointDays.map(
    days => dayAnchorSeconds - days * daySeconds
  )
  log(
    `NIP-65: querying ${indexerUrls.length} indexers across ${checkpoints.length} historical checkpoints`
  )
  const batches = await Promise.all(
    indexerUrls.map(async url => {
      const events = await queryNip65Indexer(
        url,
        checkpoints,
        perCheckpointLimit
      )
      log(`NIP-65: ${url} returned ${events.length} kind 10002 events`)
      return events
    })
  )
  const responsiveIndexers = batches.filter(batch => batch.length > 0).length
  if (responsiveIndexers === 0) {
    throw new Error('All NIP-65 indexers failed to return relay list events')
  }
  const stats = aggregateNip65Events(batches.flat(), dayAnchorSeconds)
  log(
    `NIP-65: aggregated ${stats.usersByRelay.size} write-capable relays from ${responsiveIndexers}/${indexerUrls.length} indexers`
  )
  return stats
}

const buildCandidates = ({
  reports,
  nip65Stats,
  incumbents,
  nowSeconds
}: {
  reports: readonly Report[]
  nip65Stats: Nip65Stats
  incumbents: ReadonlySet<string>
  nowSeconds: number
}): {reportedCount: number; candidates: Candidate[]} => {
  const latest = new Map<string, Map<string, Report>>()
  for (const report of reports) {
    const url = normalize(
      report.tags.find(entry => entry[0] === 'd')?.[1] ?? ''
    )
    if (
      !url ||
      report.created_at < nowSeconds - maxAgeSeconds ||
      report.created_at > nowSeconds + 300
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

  const candidates: Candidate[] = []
  for (const [url, monitors] of latest) {
    const evaluation = evaluateRelayReports([...monitors.values()])
    if (!evaluation) {
      continue
    }
    const nip65Users = nip65Stats.usersByRelay.get(url)?.size ?? 0
    const oldestDays = nip65Stats.oldestDaysByRelay.get(url) ?? 0
    if (nip65Users < minNip65Users || oldestDays < minNip65AgeDays) {
      continue
    }
    const incumbent = incumbents.has(url)
    const score = computeStructuralScore({
      oldestDays,
      nip65Users,
      verifiedMonitors: evaluation.verifiedMonitors,
      incumbent
    })
    candidates.push({
      url,
      domainGroup: getDomainGroup(url),
      ...(evaluation.ipv4 ? {ipv4: evaluation.ipv4} : {}),
      nip65Users,
      oldestDays,
      monitors: evaluation.monitors,
      verifiedMonitors: evaluation.verifiedMonitors,
      medianMonitorMs: evaluation.medianMonitorMs,
      incumbent,
      score
    })
  }
  candidates.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url))
  return {reportedCount: latest.size, candidates}
}

type DiverseItem = {
  domainGroup: string
  ipv4?: string
  operatorPubkey?: string
}

const createDiversityFilter = () => {
  const usedDomains = new Set<string>()
  const usedIps = new Set<string>()
  const usedOperators = new Set<string>()
  const conflicts = (item: DiverseItem): boolean =>
    usedDomains.has(item.domainGroup) ||
    (item.ipv4 !== undefined && usedIps.has(item.ipv4)) ||
    (item.operatorPubkey !== undefined &&
      usedOperators.has(item.operatorPubkey))
  const accept = (item: DiverseItem): boolean => {
    if (conflicts(item)) {
      return false
    }
    usedDomains.add(item.domainGroup)
    if (item.ipv4 !== undefined) {
      usedIps.add(item.ipv4)
    }
    if (item.operatorPubkey !== undefined) {
      usedOperators.add(item.operatorPubkey)
    }
    return true
  }
  return {conflicts, accept}
}

const selectDiverseRelays = <T extends DiverseItem>(
  orderedCandidates: readonly T[],
  limit = targetCount
): T[] => {
  const diversity = createDiversityFilter()
  const chosen: T[] = []
  for (const candidate of orderedCandidates) {
    if (diversity.accept(candidate)) {
      chosen.push(candidate)
      if (chosen.length >= limit) {
        break
      }
    }
  }
  return chosen
}

const evaluateOrderedTrystero = async <T extends DiverseItem & {url: string}>(
  orderedCandidates: readonly T[],
  limit: number,
  concurrency: number,
  verify: (candidate: T, index: number) => Promise<number>
): Promise<(T & {trysteroMs: number})[]> => {
  type SlotState =
    | {status: 'pending'}
    | {status: 'fail'}
    | {status: 'pass'; ms: number}
  const states: SlotState[] = orderedCandidates.map(() => ({status: 'pending'}))
  let next = 0

  const getSettledState = () => {
    const diversity = createDiversityFilter()
    const selected: (T & {trysteroMs: number})[] = []
    for (let i = 0; i < orderedCandidates.length; i++) {
      const state = states[i]!
      if (state.status === 'pending') {
        break
      }
      if (state.status === 'fail') {
        continue
      }
      const candidate = orderedCandidates[i]!
      if (diversity.accept(candidate)) {
        selected.push({...candidate, trysteroMs: state.ms})
        if (selected.length >= limit) {
          break
        }
      }
    }
    return {selected, conflicts: diversity.conflicts}
  }

  await Promise.all(
    Array.from(
      {length: Math.min(concurrency, orderedCandidates.length)},
      async () => {
        while (next < orderedCandidates.length) {
          const settled = getSettledState()
          if (settled.selected.length >= limit) {
            break
          }
          const index = next++
          const candidate = orderedCandidates[index]
          if (!candidate) {
            break
          }
          if (settled.conflicts(candidate)) {
            states[index] = {status: 'fail'}
            continue
          }
          try {
            const ms = await verify(candidate, index)
            states[index] = {status: 'pass', ms}
          } catch {
            states[index] = {status: 'fail'}
          }
        }
      }
    )
  )

  return getSettledState().selected
}

const probe = async (url: string): Promise<number> => {
  const topic = randomUUID()
  const subId = randomUUID()
  const payload = await createEvent(topic, randomUUID(), createSigner())
  const event = JSON.parse(payload)[1]
  // Match test:relays too: reject relays that require an existing listener.
  const preflight = await createEvent(
    randomUUID(),
    randomUUID(),
    createSigner()
  )
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

const probeTwoRoundTrips = async (url: string): Promise<number> => {
  const first = await probe(url)
  await sleep(interProbeDelayMs)
  const second = await probe(url)
  return (first + second) / 2
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
            const {joinRoom} = (
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
                const room = joinRoom(config, 'probe')
                room.onError(({message}) => reject(new Error(message)))
                const action = room.makeAction<string, string>('relay-probe', {
                  kind: 'request'
                })
                action.onRequest(data => data)
                room.onPeerJoin(({peerId}) => {
                  phase = 'waiting for action response'
                  console.log(
                    'relay-probe: peer connected; sending action request'
                  )
                  void room.getSelf().then(({peerId: selfId}) =>
                    action
                      .request(selfId, {target: peerId, timeoutMs: deadlineMs})
                      .then(response => {
                        console.log('relay-probe: action response received')
                        resolve({selfId, peerId, response})
                      }, reject)
                  )
                })
              })
            } finally {
              clearTimeout(timer!)
            }
          },
          {config, deadlineMs}
        )
      )
    )
    assert.notEqual(results[0]!.selfId, results[1]!.selfId)
    for (const [i, result] of results.entries()) {
      assert.equal(result.peerId, results[1 - i]!.selfId)
      assert.equal(result.response, result.selfId)
    }
    return performance.now() - start
  } finally {
    // Dispose both isolated clients, including their sockets and timers, on failure.
    await Promise.all(contexts.map(context => context.close()))
  }
}

const main = async (browser: Browser, siteUrl: string) => {
  const initialSource = await readFile(nostrIndexPath, 'utf8')
  const incumbents = parseDefaultRelayUrls(initialSource)
  updateDefaultRelayUrls(initialSource, [])
  log(
    `Discovering and ranking relay candidates (${incumbents.size} eligible incumbents); target ${targetCount} defaults`
  )
  const nowSeconds = Math.floor(Date.now() / 1000)
  const dayAnchorSeconds = Math.floor(nowSeconds / daySeconds) * daySeconds
  const [reports, nip65Stats] = await Promise.all([
    discover(),
    discoverNip65Stats(dayAnchorSeconds)
  ])
  const {reportedCount, candidates} = buildCandidates({
    reports,
    nip65Stats,
    incumbents,
    nowSeconds
  })

  log(
    `${reportedCount} reported relay URLs; ${candidates.length} established unrestricted candidates (>=${minNip65Users} NIP-65 users, >=${minNip65AgeDays}d history, >=${minVerifiedMonitors} verified monitors); checking NIP-11 and two round trips with 10 workers`
  )
  const preliminary: PreliminaryCandidate[] = []
  let next = 0
  await Promise.all(
    Array.from({length: 10}, async () => {
      while (next < candidates.length) {
        const index = next++
        const candidate = candidates[index]
        if (!candidate) {
          break
        }
        try {
          log(
            `Preliminary ${index + 1}/${candidates.length}: checking NIP-11 policy at ${candidate.url}`
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
          const operatorPubkey =
            typeof policy.pubkey === 'string' &&
            /^[0-9a-f]{64}$/i.test(policy.pubkey)
              ? policy.pubkey.toLowerCase()
              : undefined
          const liveMs = await probeTwoRoundTrips(candidate.url)
          if (liveMs > maxLiveRttMs) {
            throw new Error(`round trip too slow (${Math.round(liveMs)}ms)`)
          }
          preliminary.push({
            ...candidate,
            liveMs,
            ...(operatorPubkey ? {operatorPubkey} : {})
          })
          log(
            `PREFLIGHT ${Math.round(liveMs)}ms score=${candidate.score} users=${candidate.nip65Users} age>=${candidate.oldestDays}d ${candidate.url}`
          )
        } catch (error) {
          log(
            `SKIP ${candidate.url}: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
    })
  )
  preliminary.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url))
  log(
    `${preliminary.length}/${candidates.length} passed preliminary checks; verifying top diverse candidates in deterministic rank order with 3 Trystero workers`
  )
  const selected = await evaluateOrderedTrystero(
    preliminary,
    targetCount,
    3,
    async (candidate, index) => {
      log(
        `Trystero ${index + 1}/${preliminary.length}: preparing isolated clients for ${candidate.url}`
      )
      try {
        const trysteroMs = await probeTrystero(
          browser,
          siteUrl,
          candidate.url,
          maxTrysteroMs
        )
        log(`PASS Trystero ${Math.round(trysteroMs)}ms ${candidate.url}`)
        return trysteroMs
      } catch (error) {
        log(
          `SKIP ${candidate.url}: ${error instanceof Error ? error.message : String(error)}`
        )
        throw error
      }
    }
  )
  log(
    `Selected ${selected.length}/${targetCount} diverse established relays passing Trystero`
  )
  console.table(
    selected.map(
      ({
        url,
        score,
        oldestDays,
        nip65Users,
        verifiedMonitors,
        incumbent,
        liveMs,
        trysteroMs
      }) => ({
        url,
        score,
        oldestDays,
        nip65Users,
        monitors: verifiedMonitors,
        incumbent,
        liveMs: Math.round(liveMs),
        trysteroMs: Math.round(trysteroMs)
      })
    )
  )
  if (selected.length < targetCount) {
    throw new Error(
      `Only ${selected.length} diverse relays passed; default list left unchanged`
    )
  }
  const urls = selected.map(candidate => candidate.url).sort()
  log(`Writing ${targetCount} relay defaults to ${nostrIndexPath.pathname}`)
  const source = await readFile(nostrIndexPath, 'utf8')
  await writeFile(nostrIndexPath, updateDefaultRelayUrls(source, urls))
  log(`Updated ${targetCount} alphabetized defaults`)
}

log('Starting Nostr relay updater; loading built Trystero browser bundle')
const bundle = await readFile(
  new URL('../test/dist/trystero-nostr.js', import.meta.url)
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
    const nowSeconds = Math.floor(Date.now() / 1000)
    const dayAnchorSeconds = Math.floor(nowSeconds / daySeconds) * daySeconds
    const baseTags = [
      ['rtt-open', '120'],
      ...['!auth', '!payment', '!pow'].map(value => ['R', value])
    ]
    const report: Report = {
      id: 'r1',
      pubkey: 'monitor-1',
      created_at: nowSeconds - 60,
      content: '{}',
      tags: baseTags
    }
    assert.deepEqual(inspectReport(report), {
      restricted: false,
      verifiedUnrestricted: true
    })
    assert.deepEqual(
      inspectReport({
        ...report,
        tags: [
          ['R', '!auth'],
          ['R', '!payment']
        ]
      }),
      {restricted: false, verifiedUnrestricted: false}
    )
    for (const requirement of ['auth', 'payment', 'pow', 'writes']) {
      assert.equal(
        inspectReport({...report, tags: [...baseTags, ['R', requirement]]})
          .restricted,
        true
      )
    }
    for (const limitation of [
      {auth_required: true},
      {payment_required: true},
      {restricted_writes: true},
      {min_pow_difficulty: 1},
      {max_subscriptions: 1},
      {max_message_length: 4096}
    ]) {
      assert.ok(!unrestricted({limitation}))
    }
    assert.ok(!unrestricted({fees: {publication: [{amount: 1}]}}))

    // Multi-monitor consensus tolerates partial R-tag monitors while vetoing restrictions.
    const makeMonitorReports = (
      url: string,
      extra: Report[] = []
    ): Report[] => [
      ...[1, 2, 3, 4].map<Report>(i => ({
        id: `${url}-${i}`,
        pubkey: `mon-${i}`,
        created_at: nowSeconds - 60,
        content: '{}',
        tags: [['d', url], ...baseTags]
      })),
      ...extra
    ]

    const consensusWithPartialMonitors = evaluateRelayReports(
      makeMonitorReports('wss://relay.example.com', [
        {
          pubkey: 'mon-no-r',
          created_at: nowSeconds - 30,
          content: '{}',
          tags: [
            ['d', 'wss://relay.example.com'],
            ['rtt-open', '90']
          ]
        },
        {
          pubkey: 'mon-no-pow',
          created_at: nowSeconds - 30,
          content: '{}',
          tags: [
            ['d', 'wss://relay.example.com'],
            ['rtt-open', '100'],
            ['R', '!auth'],
            ['R', '!payment']
          ]
        }
      ])
    )
    assert.ok(consensusWithPartialMonitors)
    assert.equal(consensusWithPartialMonitors.monitors, 6)
    assert.equal(consensusWithPartialMonitors.verifiedMonitors, 4)
    assert.equal(
      evaluateRelayReports(
        makeMonitorReports('wss://relay.example.com').slice(0, 2)
      ),
      undefined
    )
    assert.equal(
      evaluateRelayReports(
        makeMonitorReports('wss://relay.example.com', [
          {
            pubkey: 'mon-auth',
            created_at: nowSeconds - 10,
            content: '{}',
            tags: [
              ['d', 'wss://relay.example.com'],
              ['R', 'auth']
            ]
          }
        ])
      ),
      undefined
    )

    // URL hygiene and domain grouping.
    assert.equal(normalize('wss://EXAMPLE.com/'), 'wss://example.com')
    assert.equal(normalize('wss://user:pass@example.com'), undefined)
    assert.equal(normalize('ws://example.com'), undefined)
    assert.equal(normalize('wss://example.com:8443'), undefined)
    assert.equal(normalize('wss://1.2.3.4'), undefined)
    assert.equal(normalize('wss://0x-nostr-relay.fly.dev'), undefined)
    assert.equal(normalize('wss://bendernostur.duckdns.org'), undefined)
    assert.equal(normalize('wss://testr.nymble.world'), undefined)
    assert.equal(normalize('wss://relay-dev.gulugulu.moe'), undefined)
    assert.equal(
      getDomainGroup('wss://nostr-pub.wellorder.net'),
      'wellorder.net'
    )
    assert.equal(getDomainGroup('wss://relay.nostr.dev.br'), 'nostr.dev.br')

    // NIP-65 user count, read-only filtering, scraper cap, and longevity tiers.
    const pk = (n: number) => n.toString(16).padStart(64, '0')
    const nip65Stats = aggregateNip65Events(
      [
        ...[1, 2, 3].map(i => ({
          kind: 10002,
          pubkey: pk(i),
          created_at: dayAnchorSeconds - 400 * daySeconds,
          content: '',
          tags: [
            ['r', 'wss://established.example.com'],
            ['r', 'wss://readonly.example.com', 'read'],
            ['r', 'wss://0x-nostr-relay.fly.dev']
          ]
        })),
        {
          kind: 10002,
          pubkey: pk(99),
          created_at: dayAnchorSeconds - 500 * daySeconds,
          content: '',
          tags: Array.from({length: 35}, (_, i) => [
            'r',
            `wss://bulk-${i}.example.com`
          ])
        }
      ],
      dayAnchorSeconds
    )
    assert.equal(
      nip65Stats.usersByRelay.get('wss://established.example.com')?.size,
      3
    )
    assert.equal(
      nip65Stats.oldestDaysByRelay.get('wss://established.example.com'),
      365
    )
    assert.equal(
      nip65Stats.usersByRelay.get('wss://readonly.example.com'),
      undefined
    )
    assert.equal(
      nip65Stats.usersByRelay.get('wss://bulk-0.example.com'),
      undefined
    )

    // Diversity deduplication and deterministic ordered parallel Trystero selection.
    const diverse = selectDiverseRelays(
      [
        {
          id: 'a1',
          domainGroup: 'wellorder.net',
          ipv4: '5.78.98.165',
          operatorPubkey: pk(10)
        },
        {id: 'a2', domainGroup: 'wellorder.net'},
        {id: 'b1', domainGroup: 'alias.org', ipv4: '5.78.98.165'},
        {id: 'c1', domainGroup: 'sameop.net', operatorPubkey: pk(10)},
        {id: 'd1', domainGroup: 'independent.net', ipv4: '9.9.9.9'}
      ],
      5
    )
    assert.deepEqual(
      diverse.map(item => item.id),
      ['a1', 'd1']
    )

    const outOfOrderSelected = await evaluateOrderedTrystero(
      [
        {url: 'wss://slow-winner.example.com', domainGroup: 'winner.com'},
        {url: 'wss://fast-alias.winner.com', domainGroup: 'winner.com'},
        {url: 'wss://fast-second.example.org', domainGroup: 'second.org'},
        {url: 'wss://fast-third.example.net', domainGroup: 'third.net'}
      ],
      2,
      3,
      async candidate => {
        if (candidate.url.includes('slow-winner')) {
          await sleep(60)
          return 60
        }
        await sleep(5)
        return 5
      }
    )
    assert.deepEqual(
      outOfOrderSelected.map(item => item.url),
      ['wss://slow-winner.example.com', 'wss://fast-second.example.org']
    )

    // Incumbency hysteresis boosts healthy incumbents without rescuing ineligible relays.
    const {candidates: rankedCandidates} = buildCandidates({
      reports: [
        ...makeMonitorReports('wss://challenger.example.com'),
        ...makeMonitorReports('wss://incumbent.example.org'),
        ...makeMonitorReports('wss://newbie.example.net')
      ],
      nip65Stats: aggregateNip65Events(
        [1, 2, 3].flatMap(i => [
          {
            kind: 10002,
            pubkey: pk(i),
            created_at: dayAnchorSeconds - 200 * daySeconds,
            content: '',
            tags: [
              ['r', 'wss://challenger.example.com'],
              ['r', 'wss://incumbent.example.org']
            ]
          },
          {
            kind: 10002,
            pubkey: pk(i + 10),
            created_at: dayAnchorSeconds - 10 * daySeconds,
            content: '',
            tags: [
              ['r', 'wss://challenger.example.com'],
              ['r', 'wss://newbie.example.net']
            ]
          }
        ]),
        dayAnchorSeconds
      ),
      incumbents: new Set([
        'wss://incumbent.example.org',
        'wss://newbie.example.net'
      ]),
      nowSeconds
    })
    assert.deepEqual(
      rankedCandidates.map(candidate => candidate.url),
      ['wss://incumbent.example.org', 'wss://challenger.example.com']
    )

    const nostrSource = await readFile(nostrIndexPath, 'utf8')
    const rewritten = updateDefaultRelayUrls(nostrSource, [
      'wss://[::1]:8080/$a',
      'wss://relay.example.com'
    ])
    assert.match(
      rewritten,
      /^export const defaultRelayUrls: string\[\] = \[\n  'wss:\/\/\[::1\]:8080\/\$a',\n  'wss:\/\/relay\.example\.com'\n\]$/m
    )
    assert.deepEqual(
      [...parseDefaultRelayUrls(rewritten)],
      ['wss://relay.example.com']
    )
    assert.equal(
      updateDefaultRelayUrls(rewritten, ['wss://only.example.com']),
      nostrSource.replace(
        defaultRelayUrlsPattern,
        () =>
          "export const defaultRelayUrls: string[] = [\n  'wss://only.example.com'\n]"
      )
    )
    assert.throws(
      () => updateDefaultRelayUrls('export const other = []\n', []),
      /Expected exactly one default relay list/
    )
    assert.throws(
      () =>
        updateDefaultRelayUrls(
          "export const defaultRelayUrls = ['x'].map(url => 'wss://' + url)\n",
          []
        ),
      /Expected exactly one default relay list/
    )

    // Exercise actual cross-connection delivery, pagination, NIP-65, and rejection without public relays.
    const server = new WebSocketServer({host: '127.0.0.1', port: 0})
    await new Promise<void>(resolve => server.once('listening', resolve))
    const serverAddress = server.address()
    assert.ok(typeof serverAddress === 'object' && serverAddress)
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
    const mockDiscoveryReports: Report[] = [
      {...report, id: 'p1', created_at: nowSeconds - 10, kind: 30166},
      {...report, id: 'p2', created_at: nowSeconds - 20, kind: 30166},
      {...report, id: 'p3', created_at: nowSeconds - 30, kind: 30166}
    ]
    server.on('connection', socket =>
      socket.on('message', raw => {
        const message = JSON.parse(rawDataToString(raw))
        if (message[0] === 'REQ') {
          if (message[1] === 'discovery') {
            const filter = message[2] as {
              since?: number
              until?: number
              limit?: number
            }
            const matching = mockDiscoveryReports
              .filter(
                item =>
                  (filter.since === undefined ||
                    item.created_at >= filter.since) &&
                  (filter.until === undefined ||
                    item.created_at <= filter.until)
              )
              .slice(0, filter.limit ?? mockDiscoveryReports.length)
            for (const item of matching) {
              socket.send(JSON.stringify(['EVENT', 'discovery', item]))
            }
            if (!stallDiscovery) {
              socket.send(JSON.stringify(['EOSE', 'discovery']))
            }
            return
          }
          if (String(message[1]).startsWith('nip65-')) {
            socket.send(
              JSON.stringify([
                'EVENT',
                message[1],
                {
                  kind: 10002,
                  pubkey: pk(1),
                  created_at: dayAnchorSeconds - 400 * daySeconds,
                  content: '',
                  tags: [['r', 'wss://relay.example.com']]
                }
              ])
            )
            socket.send(JSON.stringify(['EOSE', message[1]]))
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
              (entry: string[]) => entry[0] === 'x'
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
      const url = `ws://127.0.0.1:${serverAddress.port}`
      assert.deepEqual(await discover(url, 5_000, 2), mockDiscoveryReports)
      const localNip65 = await discoverNip65Stats(dayAnchorSeconds, [url], 10)
      assert.equal(
        localNip65.usersByRelay.get('wss://relay.example.com')?.size,
        1
      )
      stallDiscovery = true
      await assert.rejects(
        discover(url, 100, 2),
        /discovery timed out.*receiving reports; waiting for EOSE; 2 reports; 2 frames/
      )
      assert.ok((await probeTwoRoundTrips(url)) >= 0)
      assert.ok((await probeTrystero(browser, siteUrl, url)) >= 0)
      assert.ok(
        batchedRequests > 0,
        'real Trystero must exercise batched subscriptions'
      )
      assert.ok(signals > 0, 'real Trystero must exchange SDP')
      deny = true
      await assert.rejects(probeTwoRoundTrips(url), /auth-required/)
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
      'Relay policy, URL, NIP-66 pagination, NIP-65 longevity, diversity, preliminary delivery, real Trystero and rejection checks passed'
    )
  } else {
    await main(browser, siteUrl)
  }
} finally {
  log('Closing browser and local test server')
  await browser?.close()
  await new Promise<void>(resolve => site.close(() => resolve()))
}
