import {schnorr} from '@noble/curves/secp256k1'
import strategy from './strategy'
import {
  encodeBytes,
  genId,
  getRelays,
  isBrowser,
  libName,
  selfId,
  toHex,
  toJson
} from './utils'

const defaultRelayUrls = [
  'wss://relay.nostr.net',
  'wss://relay.blackbyte.nl',
  'wss://relay.piazza.today',
  'wss://relay.exit.pub',
  'wss://relay.nostr.band',
  'wss://relay.damus.io',
  'wss://nostr.mom',
  'wss://relay.snort.social',
  'wss://nostr.lu.ke',
  'wss://relay.plebstr.com',
  'wss://nostr.sathoarder.com',
  'wss://nsrelay.assilvestrar.club',
  'wss://nostrasia.casa',
  'wss://relay.nostr.bg',
  'wss://relay.nostrr.de',
  'wss://relay.nostrss.re'
]

const sockets = {}
const defaultRedundancy = 1
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
      const client = new WebSocket(url)

      sockets[url] = client

      client.onmessage = e => {
        const [msgType, subId, payload, relayMsg] = JSON.parse(e.data)

        if (msgType !== eventMsgType) {
          const prefix = `${libName}: relay failure from ${client.url} - `

          if (msgType === 'NOTICE') {
            console.warn(prefix + subId)
          } else if (msgType === 'OK' && !payload) {
            console.warn(prefix + relayMsg)
          }
          return
        }

        if (msgHandlers[subId]) {
          msgHandlers[subId](subIdToTopic[subId], payload.content)
        }
      }

      return new Promise(res => (client.onopen = () => res(client)))
    }),

  subscribe: async (client, rootTopic, selfTopic, onMessage) => {
    const rootSubId = genId(64)
    const selfSubId = genId(64)

    msgHandlers[rootSubId] = msgHandlers[selfSubId] = (topic, data) =>
      onMessage(topic, data, async (peerTopic, signal) =>
        client.send(await createEvent(peerTopic, signal))
      )

    client.send(subscribe(rootSubId, rootTopic))
    client.send(subscribe(selfSubId, selfTopic))
    client.send(await createEvent(rootTopic, toJson({peerId: selfId})))

    return () => {
      client.send(unsubscribe(rootSubId))
      client.send(unsubscribe(selfSubId))
      delete msgHandlers[rootSubId]
      delete msgHandlers[selfSubId]
    }
  }
})

export const getRelaySockets = () => ({...sockets})

export {selfId} from './utils.js'
