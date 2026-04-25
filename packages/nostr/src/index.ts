import {schnorr} from '@noble/secp256k1'
import {
  createRelayManager,
  createStrategy,
  fromJson,
  genId,
  getRelays,
  hashWith,
  libName,
  makeSocket,
  pauseRelayReconnection,
  resumeRelayReconnection,
  selfId,
  strToNum,
  toHex,
  toJson,
  type BaseRoomConfig,
  type JoinRoom,
  type RelayConfig,
  type SocketClient
} from '@trystero-p2p/core'

const relayManager = createRelayManager<SocketClient>(client => client.socket)
const defaultRedundancy = 5
const tag = 'x'
const eventMsgType = 'EVENT'
const {secretKey, publicKey} = schnorr.keygen()
const pubkey = toHex(publicKey)
const subIdToTopic: Record<string, string> = {}
const msgHandlers: Record<
  string,
  ((topic: string, data: string) => void) | undefined
> = {}
const kindCache: Record<string, number> = {}

export type NostrRoomConfig = BaseRoomConfig & RelayConfig

const now = (): number => Math.floor(Date.now() / 1000)

const topicToKind = (topic: string): number =>
  (kindCache[topic] ??= strToNum(topic, 10_000) + 20_000)

export const createEvent = async (
  topic: string,
  content: string
): Promise<string> => {
  const payload = {
    kind: topicToKind(topic),
    tags: [[tag, topic]],
    created_at: now(),
    content,
    pubkey
  }

  const id = await hashWith(
    'SHA-256',
    toJson([
      0,
      payload.pubkey,
      payload.created_at,
      payload.kind,
      payload.tags,
      payload.content
    ])
  )

  return toJson([
    eventMsgType,
    {
      ...payload,
      id: toHex(id),
      sig: toHex(await schnorr.signAsync(id, secretKey))
    }
  ])
}

export const subscribe = (subId: string, topic: string): string => {
  subIdToTopic[subId] = topic

  return toJson([
    'REQ',
    subId,
    {
      kinds: [topicToKind(topic)],
      since: now(),
      ['#' + tag]: [topic]
    }
  ])
}

const unsubscribe = (subId: string): string => {
  delete subIdToTopic[subId]
  return toJson(['CLOSE', subId])
}

// Batched subscription management — groups all topic subscriptions per relay
// into a single REQ to stay within relay subscription limits (typically 10-20).
type TopicHandler = (topic: string, data: string) => void

type BatchState = {
  subId: string
  topics: Map<string, TopicHandler>
  since: number
  updateTimer: ReturnType<typeof setTimeout> | null
}

const batchers: Record<string, BatchState> = {}

const batchAdd = (
  client: SocketClient,
  topic: string,
  handler: TopicHandler
): void => {
  const batcher = (batchers[client.url] ??= {
    subId: genId(64),
    topics: new Map(),
    since: now(),
    updateTimer: null
  })

  batcher.topics.set(topic, handler)
  scheduleBatchFlush(client, batcher)
}

const batchRemove = (client: SocketClient, topic: string): void => {
  const batcher = batchers[client.url]
  if (!batcher) return

  batcher.topics.delete(topic)

  if (batcher.topics.size === 0) {
    if (batcher.updateTimer !== null) {
      clearTimeout(batcher.updateTimer)
      batcher.updateTimer = null
    }
    client.send(toJson(['CLOSE', batcher.subId]))
    delete batchers[client.url]
  } else {
    scheduleBatchFlush(client, batcher)
  }
}

const scheduleBatchFlush = (
  client: SocketClient,
  batcher: BatchState
): void => {
  if (batcher.updateTimer !== null) return
  batcher.updateTimer = setTimeout(() => {
    batcher.updateTimer = null
    flushBatch(client)
  }, 0)
}

const flushBatch = (client: SocketClient): void => {
  const batcher = batchers[client.url]
  if (!batcher || batcher.topics.size === 0) return

  const topics = [...batcher.topics.keys()]

  client.send(
    toJson([
      'REQ',
      batcher.subId,
      {
        kinds: topics.map(topicToKind),
        since: batcher.since,
        ['#' + tag]: topics
      }
    ])
  )
}

export const joinRoom: JoinRoom<NostrRoomConfig> = createStrategy({
  init: config =>
    getRelays(config, defaultRelayUrls, defaultRedundancy, true).map(url => {
      const client = relayManager.register(
        url,
        makeSocket(url, data => {
          const [msgType, subId, payload, relayMsg] =
            fromJson<
              [
                string,
                string,
                {content: string; tags?: string[][]} | boolean,
                string
              ]
            >(data)

          if (msgType !== eventMsgType) {
            const prefix = `${libName}: relay failure from ${client.url} - `

            if (msgType === 'NOTICE') {
              console.warn(prefix + subId)
            } else if (msgType === 'OK' && !payload) {
              console.warn(prefix + relayMsg)
            }

            return
          }

          if (payload && typeof payload === 'object' && 'content' in payload) {
            const content = String(payload.content)

            // Individual subscription handler (for exported subscribe() users)
            const handler = msgHandlers[subId]
            if (handler) {
              handler(subIdToTopic[subId] ?? '', content)
              return
            }

            // Batched subscription — route by topic extracted from event tags
            const batcher = batchers[url]
            if (batcher?.subId === subId && payload.tags) {
              const topicTag = payload.tags.find(t => t[0] === tag)
              if (topicTag?.[1]) {
                batcher.topics.get(topicTag[1])?.(topicTag[1], content)
              }
            }
          }
        })
      )

      return client.ready
    }),

  subscribe: (client, rootTopic, selfTopic, onMessage) => {
    const handler: TopicHandler = (topic, data) => {
      void onMessage(topic, data, async (peerTopic, signal) => {
        client.send(await createEvent(peerTopic, signal))
      })
    }

    batchAdd(client, rootTopic, handler)
    batchAdd(client, selfTopic, handler)

    return () => {
      batchRemove(client, rootTopic)
      batchRemove(client, selfTopic)
    }
  },

  announce: async (client, rootTopic, _selfTopic, extra) =>
    client.send(await createEvent(rootTopic, toJson({peerId: selfId, ...extra})))
})

export const getRelaySockets = relayManager.getSockets

export {pauseRelayReconnection, resumeRelayReconnection, selfId}

export const defaultRelayUrls = [
  'basspistol.org',
  'bucket.coracle.social',
  'chorus.almostmachines.dev',
  'chorus.pjv.me',
  'communities.nos.social',
  'ftp.halifax.rwth-aachen.de/nostr',
  'hol.is',
  'hornetstorage.net/relay',
  'inbox.mycelium.social',
  'koru.bitcointxoko.org',
  'librerelay.aaroniumii.com',
  'nos.lol',
  'nostr-01.uid.ovh',
  'nostr-01.yakihonne.com',
  'nostr-03.dorafactory.org',
  'nostr-relay.corb.net',
  'nostr.data.haus',
  'nostr.islandarea.net',
  'nostr.sathoarder.com',
  'nostr.self-determined.de',
  'nostr.tegila.com.br',
  'nostr.vulpem.com',
  'payments.u4er.net/nostr',
  'purplerelay.com',
  'relay-can.zombi.cloudrodion.com',
  'relay-rpi.edufeed.org',
  'relay.agorist.space',
  'relay.angor.io',
  'relay.artio.inf.unibe.ch',
  'relay.binaryrobot.com',
  'relay.damus.io',
  'relay.froth.zone',
  'relay.libernet.app',
  'relay.lnau.net',
  'relay.mostr.pub',
  'relay.mostro.network',
  'relay.nostr.place',
  'relay.nostrdice.com',
  'relay.notoshi.win',
  'relay.orangepill.ovh',
  'relay.sigit.io',
  'relay02.lnfi.network',
  'relay2.angor.io',
  'schnorr.me',
  'slick.mjex.me',
  'social.amanah.eblessing.co',
  'staging.yabu.me',
  'strfry.openhoofd.nl',
  'strfry.shock.network',
  'talon.quest',
  'testing.gathr.gives',
  'testnet-relay.samt.st',
  'top.testrelay.top',
  'x.kojira.io',
  'yabu.me/v2'
].map(url => 'wss://' + url)

export type * from '@trystero-p2p/core'
