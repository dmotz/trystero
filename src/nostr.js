import {schnorr} from '@noble/curves/secp256k1'
import room from './room.js'
import {
  events,
  encodeBytes,
  genId,
  getRelays,
  initGuard,
  initPeer,
  libName,
  noOp,
  selfId,
  toHex,
  values
} from './utils.js'
import {decrypt, encrypt, genKey} from './crypto.js'

const occupiedRooms = {}
const defaultRedundancy = 4
const kind = 29333
const tag = 'x'
const privateKey = toHex(crypto.getRandomValues(new Uint8Array(32)))
const publicKey = toHex(schnorr.getPublicKey(privateKey))
const sockets = {}

const now = () => Math.floor(Date.now() / 1000)

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

export const joinRoom = initGuard(occupiedRooms, (config, ns) => {
  const key = config.password && genKey(config.password, ns)
  const rootTopic = `${libName.toLowerCase()}/${config.appId}/${ns}`
  const selfTopic = `${rootTopic}/${selfId}`
  const rootSubId = genId(64)
  const selfSubId = genId(64)
  const offers = {}
  const seenPeers = {}
  const connectedPeers = {}
  const relayUrls = getRelays(config, defaultRelayUrls, defaultRedundancy)

  const connectPeer = (peer, peerId) => {
    onPeerConnect(peer, peerId)
    connectedPeers[peerId] = peer
  }

  const disconnectPeer = peerId => {
    delete offers[peerId]
    delete seenPeers[peerId]
    delete connectedPeers[peerId]
  }

  const subscribeTo = (subId, topic) =>
    JSON.stringify([
      'REQ',
      subId,
      {
        kinds: [kind],
        since: now(),
        ['#' + tag]: [topic]
      }
    ])

  const unsubscribeFrom = subId => JSON.stringify(['CLOSE', subId])

  const signal = async (topic, content) => {
    const payload = {
      kind,
      content: JSON.stringify(content),
      pubkey: publicKey,
      created_at: now(),
      tags: [[tag, topic]]
    }

    const id = toHex(
      new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          encodeBytes(
            JSON.stringify([
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

    return JSON.stringify([
      'EVENT',
      {
        ...payload,
        id,
        sig: toHex(await schnorr.sign(id, privateKey))
      }
    ])
  }

  let onPeerConnect = noOp

  relayUrls.forEach(url => {
    const socket = new WebSocket(url)

    sockets[url] = socket

    socket.addEventListener('open', async () => {
      socket.send(subscribeTo(rootSubId, rootTopic))
      socket.send(subscribeTo(selfSubId, selfTopic))
      socket.send(await signal(rootTopic, selfId))
    })

    socket.addEventListener('message', async e => {
      const [msgType, subId, payload, relayMsg] = JSON.parse(e.data)

      if (msgType !== 'EVENT') {
        if (msgType === 'OK' && !payload) {
          console.warn(
            `${libName}: relay failure from ${socket.url} - ${relayMsg}`
          )
        }

        return
      }

      const content = JSON.parse(payload.content)

      if (subId === rootSubId) {
        const peerId = content

        if (
          peerId !== selfId &&
          !connectedPeers[peerId] &&
          !seenPeers[peerId]
        ) {
          seenPeers[peerId] = true

          const peer = (offers[peerId] = initPeer(
            true,
            false,
            config.rtcConfig
          ))

          peer.once(events.signal, async offer => {
            socket.send(
              await signal(`${rootTopic}/${peerId}`, {
                peerId: selfId,
                offer: key
                  ? {...offer, sdp: await encrypt(key, offer.sdp)}
                  : offer
              })
            )
          })

          peer.once(events.connect, () => connectPeer(peer, peerId))
          peer.once(events.close, () => disconnectPeer(peerId))
        }
      } else if (subId === selfSubId) {
        const {peerId, offer, answer} = content

        if (offers[peerId] && answer) {
          offers[peerId].signal(
            key ? {...answer, sdp: await decrypt(key, answer.sdp)} : answer
          )
          return
        }

        if (!offer) {
          return
        }

        const peer = initPeer(false, false, config.rtcConfig)

        peer.once(events.signal, async answer =>
          socket.send(
            await signal(`${rootTopic}/${peerId}`, {
              peerId: selfId,
              answer: key
                ? {...answer, sdp: await encrypt(key, answer.sdp)}
                : answer
            })
          )
        )

        peer.once(events.connect, () => connectPeer(peer, peerId))
        peer.once(events.close, () => disconnectPeer(peerId))
        peer.signal(offer)
      }
    })
  })

  return room(
    f => (onPeerConnect = f),
    () => {
      delete occupiedRooms[ns]
      values(sockets).forEach(socket => {
        socket.send(unsubscribeFrom(rootSubId))
        socket.send(unsubscribeFrom(selfSubId))
      })
    }
  )
})

export const getRelaySockets = () => ({...sockets})

export {selfId} from './utils.js'
