import WebSocket from 'ws'
import {defaultRelayUrls as mqtt} from '../src/mqtt.js'
import {defaultRelayUrls as nostr} from '../src/nostr.js'
import {defaultRelayUrls as torrent} from '../src/torrent.js'

const testRelay = url => {
  const ws = new WebSocket(url)
  const start = Date.now()

  return new Promise((res, rej) => {
    const timeout = setTimeout(rej, 5000)

    ws.on('open', () => {
      clearTimeout(timeout)
      res()
    })
    ws.on('error', () => {
      clearTimeout(timeout)
      rej()
    })
  })
    .then(() => `✅ ${url}\t- ${Date.now() - start}ms`)
    .catch(() => `❌ ${url}\t- ${Date.now() - start}ms`)
    .finally(() => ws.close())
}

const testRelays = ([strategy, relays]) =>
  Promise.all(relays.map(testRelay)).then(results => [strategy, results])

Promise.all(Object.entries({mqtt, nostr, torrent}).map(testRelays)).then(res =>
  res.forEach(([strategy, list]) => {
    console.log(strategy.toUpperCase() + ':')
    console.log(list.join('\n'), '\n')
  })
)
