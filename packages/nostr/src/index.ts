import {schnorr} from '@noble/secp256k1'
import {
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
  socketGetter,
  strToNum,
  toHex,
  toJson,
  type BaseRoomConfig,
  type JoinRoom,
  type RelayConfig,
  type SocketClient
} from '@trystero/core'

const clients: Record<string, SocketClient> = {}
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

export const joinRoom: JoinRoom<NostrRoomConfig> = createStrategy({
  init: config =>
    getRelays(config, defaultRelayUrls, defaultRedundancy, true).map(url => {
      const client = makeSocket(url, data => {
        const [msgType, subId, payload, relayMsg] =
          fromJson<[string, string, {content: string} | boolean, string]>(data)

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
          msgHandlers[subId]?.(
            subIdToTopic[subId] ?? '',
            String((payload as {content: string}).content)
          )
        }
      })

      clients[url] = client

      return client.ready
    }),

  subscribe: (client, rootTopic, selfTopic, onMessage) => {
    const rootSubId = genId(64)
    const selfSubId = genId(64)

    msgHandlers[rootSubId] = msgHandlers[selfSubId] = (topic, data) => {
      void onMessage(topic, data, async (peerTopic, signal) => {
        client.send(await createEvent(peerTopic, signal))
      })
    }

    client.send(subscribe(rootSubId, rootTopic))
    client.send(subscribe(selfSubId, selfTopic))

    return () => {
      client.send(unsubscribe(rootSubId))
      client.send(unsubscribe(selfSubId))
      delete msgHandlers[rootSubId]
      delete msgHandlers[selfSubId]
    }
  },

  announce: async (client, rootTopic) =>
    client.send(await createEvent(rootTopic, toJson({peerId: selfId})))
})

export const getRelaySockets = socketGetter(clients)

export {pauseRelayReconnection, resumeRelayReconnection, selfId}

export const defaultRelayUrls = [
  'black.nostrcity.club',
  'ftp.halifax.rwth-aachen.de/nostr',
  'nos.lol',
  'nostr.cool110.xyz',
  'nostr.data.haus',
  'nostr.sathoarder.com',
  'nostr.vulpem.com',
  'relay.agorist.space',
  'relay.binaryrobot.com',
  'relay.fountain.fm',
  'relay.mostro.network',
  'relay.nostrdice.com',
  'relay.oldenburg.cool',
  'relay.verified-nostr.com',
  'yabu.me/v2'
].map(url => 'wss://' + url)

export type * from '@trystero/core'
