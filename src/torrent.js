import {sha1} from './crypto'
import strategy from './strategy'
import {
  entries,
  genId,
  fromEntries,
  fromJson,
  getRelays,
  libName,
  makeSocket,
  selfId,
  socketGetter,
  toJson
} from './utils'

const clients = {}
const topicToInfoHash = {}
const infoHashToTopic = {}
const announceIntervals = {}
const announceFns = {}
const trackerAnnounceSecs = {}
const handledOffers = {}
const msgHandlers = {}
const trackerAction = 'announce'
const hashLimit = 20
const offerPoolSize = 10
const defaultAnnounceSecs = 33
const maxAnnounceSecs = 120
const defaultRedundancy = 3
const defaultRelayUrls = [
  'wss://tracker.webtorrent.dev',
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.files.fm:7073/announce',
  'wss://tracker.btorrent.xyz'
]

const getInfoHash = async topic => {
  if (topicToInfoHash[topic]) {
    return topicToInfoHash[topic]
  }

  const hash = (await sha1(topic)).slice(0, hashLimit)

  topicToInfoHash[topic] = hash
  infoHashToTopic[hash] = topic

  return hash
}

const send = async (client, topic, payload) =>
  client.send(
    toJson({
      action: trackerAction,
      info_hash: await getInfoHash(topic),
      peer_id: selfId,
      ...payload
    })
  )

const warn = (url, msg, didFail) =>
  console.warn(
    `${libName}: torrent tracker ${didFail ? 'failure' : 'warning'} from ${url} - ${msg}`
  )

export const joinRoom = strategy({
  init: config =>
    getRelays(config, defaultRelayUrls, defaultRedundancy).map(rawUrl => {
      const client = makeSocket(rawUrl, rawData => {
        const data = fromJson(rawData)
        const errMsg = data['failure reason']
        const warnMsg = data['warning message']
        const {interval} = data
        const topic = infoHashToTopic[data.info_hash]

        if (errMsg) {
          warn(url, errMsg, true)
          return
        }

        if (warnMsg) {
          warn(url, warnMsg)
        }

        if (
          interval &&
          interval > trackerAnnounceSecs[url] &&
          announceFns[url][topic]
        ) {
          const int = Math.min(interval, maxAnnounceSecs)

          clearInterval(announceIntervals[url][topic])
          trackerAnnounceSecs[url] = int
          announceIntervals[url][topic] = setInterval(
            announceFns[url][topic],
            int * 1000
          )
        }

        if (handledOffers[data.offer_id]) {
          return
        }

        if (data.offer || data.answer) {
          handledOffers[data.offer_id] = true

          if (msgHandlers[url][topic]) {
            msgHandlers[url][topic](data)
          }
        }
      })

      const {url} = client

      clients[url] = client
      msgHandlers[url] = {}

      return client.ready
    }),

  subscribe: (client, rootTopic, _, onMessage, getOffers) => {
    const {url} = client

    const announce = async () => {
      const offers = fromEntries(
        await Promise.all(
          getOffers(offerPoolSize).map(async ([peer, offer]) => [
            genId(hashLimit),
            {peer, offer: await offer}
          ])
        )
      )

      msgHandlers[client.url][rootTopic] = data => {
        if (data.offer) {
          onMessage(
            rootTopic,
            {offer: data.offer, peerId: data.peer_id},
            (_, signal) =>
              send(client, rootTopic, {
                // certain trackers will reject if answer contains extra fields
                answer: {type: 'answer', sdp: fromJson(signal).answer},
                offer_id: data.offer_id,
                to_peer_id: data.peer_id
              })
          )
        } else if (data.answer) {
          const offer = offers[data.offer_id]

          if (offer) {
            onMessage(rootTopic, {
              answer: data.answer.sdp,
              peerId: data.peer_id,
              peer: offer.peer
            })
          }
        }
      }

      send(client, rootTopic, {
        numwant: offerPoolSize,
        offers: entries(offers).map(([id, {offer}]) => ({offer_id: id, offer}))
      })
    }

    announceFns[url] ||= {}
    announceFns[url][rootTopic] = announce
    announceIntervals[url] ||= {}
    announceIntervals[url][rootTopic] = setInterval(
      announce,
      (trackerAnnounceSecs[url] || defaultAnnounceSecs) * 1000
    )
    announce()

    return () => {
      clearInterval(announceIntervals[url][rootTopic])
      delete msgHandlers[url][rootTopic]
      delete announceFns[url][rootTopic]
    }
  }
})

export const getRelaySockets = socketGetter(clients)

export {selfId} from './utils.js'
