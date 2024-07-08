import WebSocket from 'ws'
import {schnorr} from '@noble/curves/secp256k1'
import chalk from 'chalk'
import {encodeBytes, toHex, toJson} from '../src/utils.js'
import {defaultRelayUrls as mqtt} from '../src/mqtt.js'
import {defaultRelayUrls as nostr} from '../src/nostr.js'
import {defaultRelayUrls as torrent} from '../src/torrent.js'

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
  const ws = new WebSocket(url)
  const start = Date.now()

  const output = (url, err) =>
    `${!err ? '✅' : '❌'} ${(Date.now() - start).toString().padStart(4)}ms ` +
    `${url.replace(/^wss:\/\//, '')}${err ? ` - (${chalk.red(err)})` : ''}`

  return new Promise((res, rej) => {
    const timeout = setTimeout(() => rej('timeout'), 5000)

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
          } catch (e) {
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

Promise.all(Object.entries({nostr, mqtt, torrent}).map(testRelays)).then(res =>
  res.forEach(([strategy, list]) => {
    console.log(strategy.toUpperCase() + ':')
    console.log(list.join('\n'), '\n')
  })
)
