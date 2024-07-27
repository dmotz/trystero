import {schnorr} from '@noble/curves/secp256k1'
import strategy from './strategy.js'
import {
  encodeBytes,
  fromJson,
  genId,
  getRelays,
  isBrowser,
  libName,
  makeSocket,
  selfId,
  socketGetter,
  toHex,
  toJson
} from './utils.js'

const clients = {}
const defaultRedundancy = 5
const kind = 29333
const tag = 'x'
const eventMsgType = 'EVENT'
const privateKey = isBrowser && schnorr.utils.randomPrivateKey()
const publicKey = isBrowser && toHex(schnorr.getPublicKey(privateKey))
const subIdToTopic = {}
const msgHandlers = {}

const now = () => Math.floor(Date.now() / 1000)

const createEvent = async (topic, content) => {
  const payload = {
    kind,
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

const subscribe = (subId, topic) => {
  subIdToTopic[subId] = topic
  return toJson([
    'REQ',
    subId,
    {
      kinds: [kind],
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
    getRelays(config, defaultRelayUrls, defaultRedundancy).map(url => {
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
  'relay.nostr.net',
  'relay.snort.social',
  'relay.piazza.today',
  'relay.exit.pub',
  'nostr.lu.ke',
  'nostr.mom',
  'relay.urbanzap.space',
  'nostr.data.haus',
  'nostr.sathoarder.com',
  'relay.nostromo.social',
  'relay.nostr.bg',
  'nostr.stakey.net',
  'nostr.vulpem.com',
  'a.nos.lol',
  'eu.purplerelay.com',
  'nostr2.sanhauf.com',
  'e.nos.lol'
].map(url => 'wss://' + url)
