import {
  createStrategy,
  entries,
  fromEntries,
  fromJson,
  genId,
  getRelays,
  libName,
  makeSocket,
  pauseRelayReconnection,
  resumeRelayReconnection,
  selfId,
  sha1,
  socketGetter,
  toJson,
  type BaseRoomConfig,
  type JoinRoom,
  type OfferRecord,
  type RelayConfig,
  type SocketClient
} from '@trystero/core'

const clients: Record<string, SocketClient> = {}
const topicToInfoHash: Record<string, string> = {}
const infoHashToTopic: Record<string, string> = {}
const announceIntervals: Record<
  string,
  Record<string, ReturnType<typeof setInterval>>
> = {}
const announceFns: Record<
  string,
  Record<string, () => void | Promise<void>>
> = {}
const subscriptionTokens: Record<string, Record<string, symbol>> = {}
const trackerAnnounceMs: Record<string, number> = {}
const handledSignals: Record<string, boolean> = {}
const msgHandlers: Record<
  string,
  Record<string, ((data: TrackerMessage) => void) | undefined>
> = {}
const trackerAction = 'announce'
const hashLimit = 20
const offerPoolSize = 10
const defaultAnnounceMs = 10_000
const maxAnnounceMs = 20_000
const offerRetentionMs = 120_000
const defaultRedundancy = 3

export type TorrentRoomConfig = BaseRoomConfig & RelayConfig

type TrackerMessage = {
  offer?: unknown
  answer?: unknown
  offer_id?: string
  peer_id?: string
  info_hash?: string
  interval?: number
  ['failure reason']?: string
  ['warning message']?: string
}

const getInfoHash = async (topic: string): Promise<string> => {
  if (topicToInfoHash[topic]) {
    return topicToInfoHash[topic]
  }

  const hash = (await sha1(topic)).slice(0, hashLimit)
  topicToInfoHash[topic] = hash
  infoHashToTopic[hash] = topic

  return hash
}

const send = async (
  client: SocketClient,
  topic: string,
  payload: Record<string, unknown>
): Promise<void> => {
  client.send(
    toJson({
      action: trackerAction,
      info_hash: await getInfoHash(topic),
      peer_id: selfId,
      ...payload
    })
  )
}

const warn = (url: string, msg: string, didFail = false): void =>
  console.warn(
    `${libName}: torrent tracker ${didFail ? 'failure' : 'warning'} from ${url} - ${msg}`
  )

export const joinRoom: JoinRoom<TorrentRoomConfig> = createStrategy({
  init: config =>
    getRelays(config, defaultRelayUrls, defaultRedundancy).map(rawUrl => {
      const client = makeSocket(rawUrl, rawData => {
        const data = fromJson<TrackerMessage>(rawData)
        const errMsg = data['failure reason']
        const warnMsg = data['warning message']
        const {interval} = data
        const topic = data.info_hash
          ? infoHashToTopic[data.info_hash]
          : undefined

        if (errMsg) {
          warn(client.url, errMsg, true)
          return
        }

        if (warnMsg) {
          warn(client.url, warnMsg)
        }

        if (
          interval &&
          interval * 1000 >
            (trackerAnnounceMs[client.url] ?? defaultAnnounceMs) &&
          topic &&
          announceFns[client.url]?.[topic]
        ) {
          const nextInterval = Math.min(interval * 1000, maxAnnounceMs)
          const relayIntervals = (announceIntervals[client.url] ??= {})
          const relayFns = (announceFns[client.url] ??= {})

          if (relayIntervals[topic]) {
            clearInterval(relayIntervals[topic])
          }
          trackerAnnounceMs[client.url] = nextInterval
          const relayFn = relayFns[topic]

          if (relayFn) {
            relayIntervals[topic] = setInterval(relayFn, nextInterval)
          }
        }

        if ((data.offer || data.answer) && topic && data.offer_id) {
          if (data.peer_id === selfId) {
            return
          }

          const signalType = data.offer ? 'offer' : 'answer'
          const signalKey = `${topic}:${signalType}:${data.offer_id}:${data.peer_id ?? ''}`

          if (handledSignals[signalKey]) {
            return
          }

          handledSignals[signalKey] = true
          msgHandlers[client.url]?.[topic]?.(data)
        }
      })

      const {url} = client

      clients[url] = client
      msgHandlers[url] = {}

      return client.ready
    }),

  subscribe: (client, rootTopic, _, onMessage, getOffers) => {
    const {url} = client
    const handlers = (msgHandlers[url] ??= {})
    const relayFns = (announceFns[url] ??= {})
    const relayIntervals = (announceIntervals[url] ??= {})
    const activeTokens = (subscriptionTokens[url] ??= {})
    const subscriptionToken = Symbol(rootTopic)
    const outstandingOffers: Record<string, OfferRecord & {createdAt: number}> =
      {}

    activeTokens[rootTopic] = subscriptionToken

    const pruneOutstandingOffers = (): void => {
      const now = Date.now()

      entries(outstandingOffers).forEach(([offerId, offer]) => {
        if (now - offer.createdAt > offerRetentionMs) {
          delete outstandingOffers[offerId]
        }
      })
    }

    const topicHandler = (data: TrackerMessage): void => {
      if (data.offer && data.peer_id && data.offer_id) {
        void onMessage(
          rootTopic,
          {offer: data.offer, peerId: data.peer_id},
          (_, signal) =>
            void send(client, rootTopic, {
              answer: fromJson<Record<string, unknown>>(signal)['answer'],
              offer_id: data.offer_id,
              to_peer_id: data.peer_id
            })
        )
      } else if (data.answer && data.offer_id && data.peer_id) {
        const offer = outstandingOffers[data.offer_id]

        if (offer) {
          delete outstandingOffers[data.offer_id]

          void onMessage(
            rootTopic,
            {
              answer: data.answer,
              peerId: data.peer_id,
              peer: offer.peer
            },
            () => {}
          )
        }
      }
    }

    handlers[rootTopic] = topicHandler

    const announce = async (): Promise<void> => {
      if (activeTokens[rootTopic] !== subscriptionToken) {
        return
      }

      pruneOutstandingOffers()

      const offers = fromEntries(
        (await getOffers(offerPoolSize)).map((peerAndOffer: OfferRecord) => [
          genId(hashLimit),
          peerAndOffer
        ])
      ) as Record<string, OfferRecord>

      entries(offers).forEach(([offerId, offer]) => {
        outstandingOffers[offerId] = {...offer, createdAt: Date.now()}
      })

      void send(client, rootTopic, {
        numwant: offerPoolSize,
        offers: entries(offers).map(([id, {offer}]) => ({offer_id: id, offer}))
      })
    }

    trackerAnnounceMs[url] = defaultAnnounceMs
    relayFns[rootTopic] = announce
    relayIntervals[rootTopic] = setInterval(announce, trackerAnnounceMs[url])
    void announce()

    return () => {
      if (activeTokens[rootTopic] !== subscriptionToken) {
        entries(outstandingOffers).forEach(([offerId]) => {
          delete outstandingOffers[offerId]
        })

        return
      }

      const interval = relayIntervals[rootTopic]
      if (interval) {
        clearInterval(interval)
        delete relayIntervals[rootTopic]
      }

      if (handlers[rootTopic] === topicHandler) {
        delete handlers[rootTopic]
      }

      if (relayFns[rootTopic] === announce) {
        delete relayFns[rootTopic]
      }

      delete activeTokens[rootTopic]

      entries(outstandingOffers).forEach(([offerId]) => {
        delete outstandingOffers[offerId]
      })
    }
  },

  announce: client => trackerAnnounceMs[client.url]
})

export const getRelaySockets = socketGetter(clients)

export {pauseRelayReconnection, resumeRelayReconnection, selfId}

export const defaultRelayUrls = [
  'tracker.webtorrent.dev',
  'tracker.openwebtorrent.com',
  'tracker.btorrent.xyz',
  'tracker.files.fm:7073/announce'
].map(url => 'wss://' + url)

export type * from '@trystero/core'
