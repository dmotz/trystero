import {schnorr, utils} from '@noble/secp256k1'
import strategy from './strategy.js'
import {
  encodeBytes,
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
const privateKey = utils.randomPrivateKey()
const publicKey = toHex(schnorr.getPublicKey(privateKey))
const subIdToTopic = {}
const msgHandlers = {}
const kindCache = {}

const now = () => Math.floor(Date.now() / 1000)

const topicToKind = topic =>
  (kindCache[topic] ??= strToNum(topic, 10_000) + 20_000)

export const createEvent = async (topic, content) => {
  const payload = {
    kind: topicToKind(topic),
    content,
    pubkey: publicKey,
    created_at: now(),
    tags: [[tag, topic]]
  }

  const id = toHex(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        encodeBytes(
          toJson([
            0,
            payload.pubkey,
            payload.created_at,
            payload.kind,
            payload.tags,
            payload.content
          ])
        )
      )
    )
  )

  return toJson([
    eventMsgType,
    {
      ...payload,
      id,
      sig: toHex(await schnorr.sign(id, privateKey))
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

export {selfId} from './utils.js'

export const defaultRelayUrls = [
  'black.nostrcity.club',
  'eu.purplerelay.com',
  'ftp.halifax.rwth-aachen.de/nostr',
  'nostr.cool110.xyz',
  'nostr.data.haus',
  'nostr.mom',
  'nostr.oxtr.dev',
  'nostr.sathoarder.com',
  'nostr.vulpem.com',
  'nostrelay.memory-art.xyz',
  'playground.nostrcheck.me/relay',
  'relay.agorist.space',
  'relay.binaryrobot.com',
  'relay.fountain.fm',
  'relay.mostro.network',
  'relay.nostraddress.com',
  'relay.nostrdice.com',
  'relay.nostromo.social',
  'relay.oldenburg.cool',
  'relay.snort.social',
  'relay.verified-nostr.com',
  'sendit.nosflare.com',
  'yabu.me/v2'
].map(url => 'wss://' + url)
