import {schnorr} from '@noble/secp256k1'
import strategy from './strategy.js'
import {hashWith} from './crypto.js'
import {
  fromJson,
  genId,
  getRelays,
  libName,
  makeSocket,
  selfId,
  socketGetter,
  strToNum,
  toHex,
  toJson
} from './utils.js'

const clients = {}
const defaultRedundancy = 5
const tag = 'x'
const eventMsgType = 'EVENT'
const {secretKey, publicKey} = schnorr.keygen()
const pubkey = toHex(publicKey)
const subIdToTopic = {}
const msgHandlers = {}
const kindCache = {}

const now = () => Math.floor(Date.now() / 1000)

const topicToKind = topic =>
  (kindCache[topic] ??= strToNum(topic, 10_000) + 20_000)

export const createEvent = async (topic, content) => {
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

export const subscribe = (subId, topic) => {
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

const unsubscribe = subId => {
  delete subIdToTopic[subId]
  return toJson(['CLOSE', subId])
}

export const joinRoom = strategy({
  init: config =>
    getRelays(config, defaultRelayUrls, defaultRedundancy, true).map(url => {
      const client = makeSocket(url, data => {
        const [msgType, subId, payload, relayMsg] = fromJson(data)

        if (msgType !== eventMsgType) {
          const prefix = `${libName}: relay failure from ${client.url} - `

          if (msgType === 'NOTICE') {
            console.warn(prefix + subId)
          } else if (msgType === 'OK' && !payload) {
            console.warn(prefix + relayMsg)
          }
          return
        }

        msgHandlers[subId]?.(subIdToTopic[subId], payload.content)
      })

      clients[url] = client

      return client.ready
    }),

  subscribe: (client, rootTopic, selfTopic, onMessage) => {
    const rootSubId = genId(64)
    const selfSubId = genId(64)

    msgHandlers[rootSubId] = msgHandlers[selfSubId] = (topic, data) =>
      onMessage(topic, data, async (peerTopic, signal) =>
        client.send(await createEvent(peerTopic, signal))
      )

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

export {
  selfId,
  pauseRelayReconnection,
  resumeRelayReconnection
} from './utils.js'

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
  'relay.damus.io',
  'relay.fountain.fm',
  'relay.mostro.network',
  'relay.nostraddress.com',
  'relay.nostrdice.com',
  'relay.nostromo.social',
  'relay.oldenburg.cool',
  'relay.verified-nostr.com',
  'yabu.me/v2'
].map(url => 'wss://' + url)
