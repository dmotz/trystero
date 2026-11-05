# Signaling & Relays

[← Back to README](../README.md) · [API Reference](./api.md)

To open a direct WebRTC connection between two browsers, peers first need a tiny
side-channel to introduce themselves and swap encrypted connection offers
([SDPs](https://en.wikipedia.org/wiki/Session_Description_Protocol)).

Normally, that's where P2P tutorials tell you to pause and build a WebSocket
server. **Trystero handles signaling out of the box** so you can ship with zero
backend — while giving you six interchangeable strategies if you ever want to
use your own infrastructure.

> **Privacy reminder:** Signaling relays only ever see hashed room topics and
> encrypted SDP/ICE handshakes. Once two peers connect, **your app's state,
> actions, files, and media flow directly peer-to-peer** and never touch the
> relay.

---

## Choosing a strategy

The main `trystero` package uses the decentralized **Nostr** relay network by
default — connect to multiple public relays in parallel, zero accounts or API
keys required.

Switching strategies is a one-line import change; every room API (`makeState`,
`makeUserState`, `makeAction`, `addStream`, `roles()`, `scale()`) stays
identical:

| Package                                     | Setup needed                       | Best when you want...                                                                               |
| ------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| **`trystero`** _(or `@trystero-p2p/nostr`)_ | **None**                           | Zero-config peer discovery across a large pool of public Nostr relays (default redundancy: `5`)     |
| **`@trystero-p2p/mqtt`**                    | **None** _(or custom broker URL)_  | Zero-config public MQTT-over-WebSocket brokers (default redundancy: `4`) or an existing MQTT broker |
| **`@trystero-p2p/torrent`**                 | **None** _(or custom tracker URL)_ | Zero-config public WebTorrent trackers (default redundancy: `3`) with minimal bundle size           |
| **`@trystero-p2p/supabase`**                | Supabase project URL + anon key    | Signaling over your own managed Supabase Realtime project                                           |
| **`@trystero-p2p/firebase`**                | Firebase Realtime DB URL           | Signaling over your own Firebase Realtime Database                                                  |
| **`@trystero-p2p/ws-relay`**                | Tiny Node WebSocket server         | Full control over a lightweight, self-hosted pub/sub relay with the smallest possible client bundle |

```js
import {joinRoom} from 'trystero'
// or swap in any strategy package:
// import {joinRoom} from '@trystero-p2p/ws-relay'
// import {joinRoom} from '@trystero-p2p/torrent'
// import {joinRoom} from '@trystero-p2p/mqtt'
// import {joinRoom} from '@trystero-p2p/supabase'
// import {joinRoom} from '@trystero-p2p/firebase'
```

---

## Bundle sizes

Approximate Brotli-compressed bundle sizes with a modern tree-shaking bundler
(includes WebRTC signaling, encrypted actions, chunked binary transfers, media
streams, self-certifying `peerId`/`userId` handshakes, and signed `makeState` /
`makeUserState`):

| Package                            | `joinRoom` | `+ roles()` | `+ scale()` | `+ roles() + scale()` |
| ---------------------------------- | ---------: | ----------: | ----------: | --------------------: |
| `@trystero-p2p/ws-relay`           |   ~36.2 KB |    ~40.9 KB |    ~46.9 KB |              ~51.6 KB |
| `@trystero-p2p/torrent`            |   ~37.0 KB |    ~41.8 KB |    ~47.5 KB |              ~52.3 KB |
| `trystero` / `@trystero-p2p/nostr` |   ~40.8 KB |    ~45.6 KB |    ~51.4 KB |              ~56.1 KB |
| `@trystero-p2p/firebase`           |   ~76.4 KB |    ~81.2 KB |    ~87.1 KB |              ~91.7 KB |
| `@trystero-p2p/supabase`           |   ~80.3 KB |    ~85.0 KB |    ~91.0 KB |              ~95.5 KB |
| `@trystero-p2p/mqtt`               |  ~116.9 KB |   ~121.8 KB |   ~127.4 KB |             ~132.1 KB |

With a bundler (Vite, Rollup, esbuild, webpack, Next.js), you only pay for
[`roles()`](./roles.md) (~4.7 KB) or [`scale()`](./scaling.md) (~10.6 KB) when
you import them. Importing directly from a single-URL ESM CDN like `esm.run`
loads the full package entry.

---

## Customizing relay URLs & redundancy

For Nostr (`trystero`), MQTT, and BitTorrent, Trystero connects to a handful of
public relays in parallel (`redundancy`) so if one public relay is having a bad
day, the others still introduce your peers without skipping a beat.

Customize this behavior via `relayConfig`:

```js
const room = joinRoom(
  {
    appId: 'my-app',
    relayConfig: {
      // Optional: point to your own relay/broker/tracker URLs (overrides defaults)
      urls: ['wss://relay-1.example.com', 'wss://relay-2.example.com'],

      // Or keep the built-in relay pool and adjust how many are used at once
      // (ignored when custom `urls` are provided):
      redundancy: 6,

      // Optional: silence console warnings when an individual relay fails
      warnOnRelayFailure: false
    }
  },
  'lobby-1'
)
```

You can also inspect the built-in URL list (`defaultRelayUrls`), check open
WebSocket connections (`getRelaySockets()`), or manually pause/resume relay
sockets (`setRelayConnectivity()`):

```js
import {defaultRelayUrls, getRelaySockets, setRelayConnectivity} from 'trystero'

console.log(defaultRelayUrls) // built-in relay URLs (nostr, mqtt, torrent)
console.log(getRelaySockets()) // { "wss://...": WebSocket } (nostr, mqtt, torrent, ws-relay)

// Manual connectivity control (nostr, torrent, ws-relay):
setRelayConnectivity('offline') // close relay sockets & hold reconnection
setRelayConnectivity('online') // reconnect immediately (manual mode)
setRelayConnectivity('auto') // default: follow browser online/offline events
```

---

## Self-hosted WebSocket relay (`@trystero-p2p/ws-relay`)

Want a tiny, dependency-light signaling server that you run yourself on a cheap
VPS, Fly.io container, or local LAN? Use `@trystero-p2p/ws-relay`.

### 1. Run the relay server (Node >= 22)

Install `@trystero-p2p/ws-relay` plus the `ws` peer dependency on your server:

```sh
npm i @trystero-p2p/ws-relay ws
```

```js
import {createWsRelayServer} from '@trystero-p2p/ws-relay/server'

const relay = createWsRelayServer({
  port: 8080,
  // Optional built-in safety & rate-limit guards:
  maxTopicLength: 256,
  maxSubscriptionsPerSocket: 128,
  maxSubscriptions: 10_000,
  maxMessagesPerSecond: 200,
  maxBurstMessages: 400
})

await relay.ready
console.log('Signaling relay listening on', relay.address())
```

_(You can also attach
`createWsRelayServer({server: httpServer, path: '/relay'})` or
`{noServer: true}` onto an existing HTTP/Express/Fastify server.)_

### 2. Connect from browsers

Browser clients only need `@trystero-p2p/ws-relay` (not `ws`). Pass your relay
URL(s) in `relayConfig.urls` (`ws://` for local dev, `wss://` behind TLS in
production):

```js
import {joinRoom} from '@trystero-p2p/ws-relay'

const room = joinRoom(
  {
    appId: 'lan-party',
    relayConfig: {
      urls: ['wss://relay.your-domain.example']
    }
  },
  'match-1'
)
```

---

## Supabase setup (`@trystero-p2p/supabase`)

1. Create or open a [Supabase](https://supabase.com) project and go to **Project
   Settings → API**.
2. Pass your **Project URL** as `appId` and your **`anon` `public`** key as
   `relayConfig.supabaseKey`:

```js
import {joinRoom} from '@trystero-p2p/supabase'

const room = joinRoom(
  {
    appId: 'https://your-project-id.supabase.co',
    relayConfig: {
      supabaseKey: 'your-anon-public-key'
    }
  },
  'room-1'
)
```

---

## Firebase setup (`@trystero-p2p/firebase`)

1. Create a [Firebase](https://firebase.google.com/) project with a **Realtime
   Database**.
2. Pass your database's `databaseURL` as `appId` (or pass an already-initialized
   Firebase app via `relayConfig.firebaseApp`):

```js
import {joinRoom} from '@trystero-p2p/firebase'

const room = joinRoom(
  {
    appId: 'https://your-project-default-rtdb.firebaseio.com',
    relayConfig: {
      firebasePath: '__trystero__' // optional custom root path
    }
  },
  'room-1'
)
```

<details>
  <summary>Recommended Firebase Realtime Database security rules</summary>

Lock down your database so room presence is only readable or writable when a
client knows the hashed `$room_id`:

```json
{
  "rules": {
    ".read": false,
    ".write": false,
    "__trystero__": {
      ".read": false,
      ".write": false,
      "$room_id": {
        ".read": true,
        ".write": true
      }
    }
  }
}
```

</details>

---

## Writing your own signaling strategy (`createTopicStrategy`)

Already have a pub/sub channel in your stack — Cloudflare Durable Objects,
PartyKit, Ably, Pusher, Redis pub/sub over SSE, or a custom WebSocket server?
Build a full-featured Trystero `joinRoom` function in ~30 lines with
`createTopicStrategy` from `@trystero-p2p/core`:

```js
import {createTopicStrategy, toJson} from '@trystero-p2p/core'

export const joinRoom = createTopicStrategy({
  // Return a client promise (or array of client promises for redundancy)
  init: config =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(config.relayConfig.urls[0])
      ws.addEventListener('open', () => resolve(ws), {once: true})
      ws.addEventListener('error', reject, {once: true})
    }),

  // Subscribe to `topic`, forward incoming messages, and return a cleanup fn
  subscribeTopic: (client, topic, onMessage) => {
    const listener = event => {
      const msg = JSON.parse(String(event.data))
      if (msg.topic === topic) {
        onMessage(msg.topic, msg.payload)
      }
    }

    client.addEventListener('message', listener)
    client.send(toJson({type: 'subscribe', topic}))

    return () => {
      client.send(toJson({type: 'unsubscribe', topic}))
      client.removeEventListener('message', listener)
    }
  },

  // Publish `payload` to `topic`
  publishTopic: (client, topic, payload) => {
    client.send(toJson({type: 'publish', topic, payload}))
  }
})
```

- Trystero automatically manages hashed room/self topics, `passive` mode, SDP
  encryption, startup announce bursts, and steady 60-second heartbeats.
- If your backend persists presence state rather than treating announcements as
  transient pub/sub events (like Firebase RTDB), pass
  `reannounceOnDisconnect: false`.
- Building a non-pub/sub protocol that exchanges pre-generated SDP offers in
  bulk (like BitTorrent trackers)? Use the lower-level `createStrategy` export
  from `@trystero-p2p/core` (see
  [API Reference](./api.md#createstrategyadapter)).

<details>
  <summary>Deep dive: hashed signaling topics, announce pacing & socket reference counting</summary>

- **Hashed signaling topics**: Room and peer-inbox topic names are derived via
  `SHA-256` (`trystero:<appId>:<roomId>`) before touching any relay, so plain
  `appId` and `roomId` strings aren't broadcast in cleartext topic names.
- **Fast startup burst, quiet steady state**: When a room opens, Trystero emits
  a short warmup burst (`233 ms`, `533 ms`, `1,333 ms`) so simultaneous joiners
  find each other almost immediately, then settles into a quiet 60-second
  heartbeat (`10s`+ tracker-controlled on BitTorrent) and re-bursts if a peer
  drops.
- **Reference-counted sockets**: Relay WebSockets (`nostr`, `torrent`,
  `ws-relay`) and MQTT clients are pooled and reference-counted across active
  rooms in the same process. When the last active room calls `room.leave()`,
  shared relay sockets close cleanly so background tabs and Node scripts exit
  without dangling handles.
- **Resilient Nostr relay pool**: `@trystero-p2p/nostr` batches topic filters on
  shared connections, backs off rate-limited relays exponentially, and evicts
  incompatible relays automatically while only emitting `'relay-failed'` on
  `room.onError` if _every_ configured relay fails initial bootstrap.

</details>
