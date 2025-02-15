import WebSocket from 'ws'
import {schnorr} from '@noble/curves/secp256k1'
import chalk from 'chalk'
import mqtt from 'mqtt'
import {encodeBytes, toHex, toJson} from '../src/utils.js'
import {defaultRelayUrls as mqttRelays} from '../src/mqtt.js'
import {defaultRelayUrls as nostrRelays} from '../src/nostr.js'

import {defaultRelayUrls as torrentRelays} from '../src/torrent.js'

const timeLimit = 5000
const privateKey = schnorr.utils.randomPrivateKey()

const nostrEvent = await (async () => {
  const payload = {
    kind: 29333,
    content: Math.random().toString(36).slice(2),
    pubkey: toHex(schnorr.getPublicKey(privateKey)),
    created_at: Math.floor(Date.now() / 1000),
    tags: [['x', Math.random().toString(36).slice(2)]]
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
    'EVENT',
    {...payload, id, sig: toHex(await schnorr.sign(id, privateKey))}
  ])
})()

const testRelay = (url, strategy) => {
  const start = Date.now()
  const output = (url, err) =>
    `${!err ? '✅' : '❌'} ${(Date.now() - start).toString().padStart(4)}ms ` +
    `${url.replace(/^wss:\/\//, '')}${err ? ` - (${chalk.red(err)})` : ''}`

  if (strategy === 'mqtt') {
    const client = mqtt.connect(url)

    return new Promise((res, rej) => {
      client.on('connect', res)
      client.on('error', rej)
    })
      .then(() => output(url))
      .catch(e => output(url, e))
      .finally(() => client.end())
  }

  const ws = new WebSocket(url)

  return new Promise((res, rej) => {
    const timeout = setTimeout(() => rej('timeout'), timeLimit)

    ws.on('open', () => {
      if (strategy === 'nostr') {
        ws.on('message', msg => {
          try {
            const [event, , success, errMsg] = JSON.parse(msg.toString())

            if (event === 'OK') {
              if (success) {
                res()
              } else {
                rej(errMsg)
              }
            }
          } catch {
            rej('failed to parse nostr response')
          }
        })

        ws.send(nostrEvent)
      } else {
        res()
      }
    }).on('error', e => {
      clearTimeout(timeout)
      rej('connection error: ' + e.message)
    })
  })
    .then(() => output(url))
    .catch(e => output(url, e))
    .finally(() => ws.close())
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
).then(res =>
  res.forEach(([strategy, list]) => {
    console.log(strategy.toUpperCase() + ':')
    console.log(list.join('\n'), '\n')
  })
)
