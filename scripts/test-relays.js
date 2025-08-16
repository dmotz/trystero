import WebSocket from 'ws'
import chalk from 'chalk'
import mqtt from 'mqtt'
import {genId} from '../src/utils.js'
import {defaultRelayUrls as mqttRelays} from '../src/mqtt.js'
import {
  createEvent,
  defaultRelayUrls as nostrRelays,
  subscribe
} from '../src/nostr.js'
import {defaultRelayUrls as torrentRelays} from '../src/torrent.js'

const timeLimit = 5000

const testRelay = (url, strategy) => {
  const start = Date.now()
  const output = (url, err) =>
    `${!err ? '✅' : '❌'} ${(Date.now() - start).toString().padStart(4)}ms ` +
    `${url.replace(/^wss:\/\//, '')}${err ? ` - (${chalk.red(err)})` : ''}`

  let timeout

  if (strategy === 'mqtt') {
    const client = mqtt.connect(url)

    return new Promise((res, rej) => {
      timeout = setTimeout(() => rej('timeout'), timeLimit)
      client.on('connect', res)
      client.on('error', rej)
    })
      .then(() => output(url))
      .catch(e => output(url, e))
      .finally(() => {
        clearTimeout(timeout)
        client.end()
      })
  }

  const ws = new WebSocket(url)

  return new Promise((res, rej) => {
    timeout = setTimeout(() => rej('timeout'), timeLimit)

    ws.on('open', async () => {
      if (strategy === 'nostr') {
        const topic = genId(64)
        const content = Math.random().toString(36)

        ws.on('message', msg => {
          try {
            const [event, , successOrStatus, errMsg] = JSON.parse(
              msg.toString()
            )

            if (event === 'CLOSED') {
              rej(successOrStatus)
              return
            }

            if (event === 'OK') {
              if (successOrStatus) {
                ws.send(subscribe(topic, content))
              } else {
                rej(errMsg)
              }
            } else if (event === 'EOSE') {
              res()
            }
          } catch {
            rej('failed to parse nostr response')
          }
        })

        ws.send(await createEvent(topic, content))
      } else {
        res()
      }
    }).on('error', e => rej('connection error: ' + e.message))
  })
    .then(() => output(url))
    .catch(e => output(url, e))
    .finally(() => {
      clearTimeout(timeout)
      ws.close()
    })
}

const testRelays = ([strategy, relays]) =>
  Promise.all(relays.map(url => testRelay(url, strategy))).then(results => [
    strategy,
    results
  ])

Promise.all(
  Object.entries({
    nostr: nostrRelays,
    mqtt: mqttRelays,
    torrent: torrentRelays
  }).map(testRelays)
).then(res => {
  res.forEach(([strategy, list]) => {
    console.log(strategy.toUpperCase() + ':')
    console.log(list.join('\n'), '\n')
  })
  process.exit(0)
})
