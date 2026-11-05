# Running in Node, Bun & Deno

[← Back to README](../README.md) · [API Reference](./api.md)

Wait — why run a "no server required" library on a server?

Because sometimes a lightweight headless peer unlocks neat tricks without
turning your app into a traditional client/server monolith:

- **Silent state backup (`passive: true`)**: Keep a room's shared whiteboard,
  synth pattern, or lobby state alive even if every browser tab closes for the
  night — no Postgres or Redis setup required.
- **Headless game hosts & referees**: Run an authoritative quizmaster, poker
  dealer, or matchmaking bot using [`roles()`](./roles.md).
- **Hardware & Raspberry Pi tinkering**: Bridge sensors, MIDI controllers, LED
  installations, or local scripts straight into browser rooms.

---

## Quick setup

Trystero runs on **Node >= 22**, **Bun**, and **Deno** using the exact same API
as in the browser. Because those runtimes include built-in `WebSocket` and
WebCrypto (`crypto.subtle`) support, you only need to supply a WebRTC
`RTCPeerConnection` polyfill such as
[`werift`](https://github.com/shinyoshiaki/werift-webrtc):

```sh
npm i trystero werift
```

```js
import {joinRoom} from 'trystero'
import {RTCPeerConnection} from 'werift'

const room = joinRoom(
  {
    appId: 'hardware-synth',
    rtcPolyfill: RTCPeerConnection
  },
  'patch-bay-1'
)

const note = room.makeAction('midi-note')
note.onMessage((data, {userId}) => {
  console.log(`Received note ${data.pitch} from ${userId}`)
})
```

---

## Always-on shared-state backup (`passive: true`)

In a pure browser room, [`room.makeState()`](./state.md) stays alive as long as
at least one tab remains in the room. What if everyone closes their laptop at 2
AM and comes back the next morning?

Run a tiny `passive: true` peer and declare the `room.makeState(...)` namespaces
you want it to remember:

```js
import {joinRoom} from 'trystero'
import {RTCPeerConnection} from 'werift'

const room = joinRoom(
  {
    appId: 'fridge-poetry',
    rtcPolyfill: RTCPeerConnection,
    passive: true
  },
  'kitchen'
)

// Register the namespaces this backup peer should verify, cache, and relay
room.makeState('magnets', {words: []})
```

How `passive: true` behaves:

- **Silent on relays**: Passive peers listen for active browser peers without
  broadcasting presence announcements of their own — so two passive backup
  servers will never waste resources discovering or connecting to each other.
- **Zero trust required**: Because `makeState` records are cryptographically
  signed by their authors (and verified against [`roles()`](./roles.md) when
  enabled), the passive peer caches and serves state to newcomers without
  needing admin privileges unless you want it to author restricted updates too.
- **Clean presence**: Presence-scoped
  [`makeUserState`](./state.md#per-user-state-roommakeuserstate) entries for
  browser users are still evicted automatically when those users disconnect.

---

## Saving a persistent `userId` on the server

Outside browsers, Trystero defaults to `identity: 'none'` (generating a fresh
ephemeral `userId` each time your script restarts).

If your server peer acts as a **room admin** (`roles({selfAsAdmin: true})` or
`roles({admins: [...]})`) or needs a stable bot `userId` across restarts,
generate a key once with `createUserIdentity()`, store its exported
`trystero_uk_...` string in an environment variable or secret file, and pass it
via `importUserIdentity()`:

```js
// 1. Run once to generate a secret key for your .env / secret store:
import {createUserIdentity, exportUserIdentity} from 'trystero'

const id = await createUserIdentity()
console.log('BOT_USER_ID=', id.userId)
console.log('BOT_SECRET_KEY=', exportUserIdentity(id))
```

```js
// 2. Load that identity whenever your server peer starts up:
import {joinRoom, importUserIdentity, roles} from 'trystero'
import {RTCPeerConnection} from 'werift'

const botIdentity = await importUserIdentity(process.env.BOT_SECRET_KEY)

const room = joinRoom(
  {
    appId: 'trivia-bot',
    identity: botIdentity,
    rtcPolyfill: RTCPeerConnection,
    use: [roles({selfAsAdmin: true})]
  },
  'nightly-quiz'
)

const {roomId} = await room.getSelf()
console.log(`Players can join room: ${roomId}`)
```

> **Tip:** Keep `BOT_SECRET_KEY` (`trystero_uk_...`) private like any signing
> key — anyone holding it can sign as `botIdentity.userId`. The public
> 22-character `botIdentity.userId` is safe to hardcode in your frontend's
> `roles({admins: [BOT_USER_ID]})` config!

<details>
  <summary>Deep dive: passive signaling behavior & clean process exit</summary>

- **Topic strategies vs. BitTorrent trackers**: On pub/sub strategies (`nostr`,
  `mqtt`, `ws-relay`, `supabase`, `firebase`), a `passive: true` room subscribes
  to the room topic and its own inbox topic without publishing room-level
  presence announcements, answering active peers when they announce. On
  `@trystero-p2p/torrent`, passive rooms register with trackers as seeders
  (`left: 0`) without generating outbound SDP offers, preventing
  passive-to-passive connections while keeping tracker load minimal.
- **Clean shutdown**: Calling `await room.leave()` flushes leave notices, tears
  down WebRTC connections, and closes reference-counted relay WebSockets / MQTT
  clients once the last room exits so Node, Bun, and Deno processes can exit
  cleanly without `process.exit()`.

</details>
