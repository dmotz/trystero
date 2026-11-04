# ✨🤝✨ Trystero

**Build instant multiplayer web apps, no server required**

👉 **[Try it live on trystero.dev](https://trystero.dev)** 👈

Trystero makes browsers discover each other and communicate directly. No
accounts. No deploying infrastructure. Just import and connect.

Peers can connect via 🌊 BitTorrent, 🐦 Nostr, 📡 MQTT, ⚡️ Supabase, 🔥Firebase,
or a 🔌 self-hosted WebSocket relay – all using the same API.

Besides making peer matching automatic, Trystero offers some nice abstractions
on top of WebRTC:

- 👂📣 Rooms / broadcasting
- 🔢📩 Automatic serialization / deserialization of data
- 🎥🏷 Attach metadata to binary data and media streams
- ✂️⏳ Automatic chunking and throttling of large data
- ⏱🤞 Progress events and promises for data transfers
- 🔐📝 Session data encryption
- 🪪🔑 Self-certifying peer & user identities with multi-tab presence
- 🗂️🔄 Built-in per-user state (`makeUserState`) and shared room state
  (`makeState`)
- 🚪🎟️ Room size limits for 1v1 matches and capped lobbies
- 🕸️🚀 Experimental multi-hop scaling (`scale()`) for larger rooms with dozens
  of peers
- 👑🛡️ Optional room admins, custom roles, peer banning, and authoritative state
  (`roles()`)
- 🏭⚡ Can run peers server-side on Node, Bun, and Deno
- ⚛️🤝 Works seamlessly with React and external stores

You can see what people are building with Trystero
[here](https://github.com/jeremyckahn/awesome-trystero).

---

## Contents

- [How it works](#how-it-works)
- [Get started](#get-started)
- [Listen for events](#listen-for-events)
- [Broadcast events](#broadcast-events)
- [Audio and video](#audio-and-video)
- [User identity](#user-identity)
- [User state and shared state](#user-state-and-shared-state)
- [Advanced](#advanced)
  - [Binary metadata](#binary-metadata)
  - [Receiving files](#receiving-files)
  - [Action promises](#action-promises)
  - [Progress updates](#progress-updates)
  - [Encryption](#encryption)
  - [Room size limits](#room-size-limits)
  - [Room admins, roles, and authoritative state](#room-admins-roles-and-authoritative-state)
  - [Scaling large rooms](#scaling-large-rooms)
  - [React](#react)
  - [Troubleshooting connection issues](#troubleshooting-connection-issues)
  - [Running server-side (Node, Bun, Deno)](#running-server-side-node-bun-deno)
  - [Self-hosted WebSocket relay](#self-hosted-websocket-relay)
  - [Write your own strategy](#write-your-own-strategy)
  - [Supabase setup](#supabase-setup)
  - [Firebase setup](#firebase-setup)
- [API](#api)
  - [`joinRoom(config, roomId)`](#joinroomconfig-roomid)
  - [`roles([config])`](#rolesconfig)
  - [`scale([config])`](#scaleconfig)
  - [`createUserIdentity()`](#createuseridentity)
  - [`importUserIdentity(input)`](#importuseridentityinput)
  - [`exportUserIdentity(identity)`](#exportuseridentityidentity)
  - [`clearUserIdentity(appId)`](#clearuseridentityappid)
  - [`getRelaySockets()`](#getrelaysockets)
  - [`setRelayConnectivity(mode)`](#setrelayconnectivitymode)
- [Which strategy should I choose?](#which-strategy-should-i-choose)

---

## How it works

👉 **If you just want to try out Trystero, you can skip this explainer and
[jump into using it](#get-started).**

To establish a direct peer-to-peer connection with WebRTC, a signalling channel
is needed to exchange peer information
([SDP](https://en.wikipedia.org/wiki/Session_Description_Protocol)). Typically
this involves running your own matchmaking server but Trystero abstracts this
away for you and offers multiple strategies for connecting peers (currently
BitTorrent, Nostr, MQTT, Supabase, Firebase, and self-hosted WebSocket relay).

The important point to remember is this:

> 🔒
>
> Beyond peer discovery, your app's data never touches the strategy medium and
> is sent directly peer-to-peer and end-to-end encrypted between users.
>
> 👆

You can [compare strategies here](#which-strategy-should-i-choose).

## Get started

Install Trystero with your preferred package manager, then import it in your
code:

```sh
npm i trystero
```

```js
import {joinRoom} from 'trystero'
```

No package manager? You can also use an ESM CDN:

```html
<script type="module">
  import {joinRoom} from 'https://esm.run/trystero'
</script>
```

The default Trystero package runs on the Nostr network, but you can swap in any
other strategy by changing which package you import:

```js
import {joinRoom} from '@trystero-p2p/mqtt'
// or
import {joinRoom} from '@trystero-p2p/torrent'
// or
import {joinRoom} from '@trystero-p2p/supabase'
// or
import {joinRoom} from '@trystero-p2p/firebase'
// or
import {joinRoom} from '@trystero-p2p/ws-relay'
```

Next, join the user to a room with an ID:

```js
const config = {appId: 'san_narciso_3d'}
const room = joinRoom(config, 'yoyodyne')
```

The first argument is a configuration object that requires an `appId`. This
should be a completely unique identifier for your app¹. The second argument is
the room ID.

> Why rooms? Browsers can only handle a limited amount of WebRTC connections at
> a time so it's recommended to design your app such that users are divided into
> groups (or rooms, or namespaces, or channels... whatever you'd like to call
> them).

¹ When using Firebase, `appId` should be your `databaseURL` and when using
Supabase, it should be your project URL.

## Listen for events

Listen for users joining the room:

```js
const offJoin = room.onUserJoin(({userId}) => console.log(`${userId} joined`))
```

> **Tip:** Because tabs in the same browser profile share your `userId` by
> default, open a Private/Incognito window (or set `identity: 'none'`) when
> simulating multiple users on one machine.

Listen for users leaving the room:

```js
room.onUserLeave(({userId}) => console.log(`${userId} left`))
```

Listen for users sending their audio/video streams:

```js
room.onPeerStream(
  (stream, {userId}) => (userElements[userId].video.srcObject = stream)
)
```

Event listeners (`onUserJoin`, `onUserLeave`, `onPeerJoin`, `onPeerLeave`,
`onPeerStream`, `onRoleChange`, `onError`, `action.onMessage`,
`action.onReceiveProgress`, `state.onChange`, and `userState.onChange`) allow
multiple independent subscriptions — calling `on*(fn)` twice with the same
function registers two independent entries, each returning its own
`unsubscribe()` function (`offJoin()`). Single-result handlers
(`action.onRequest` and `action.onReceive`) allow one active handler at a time
and also return an `unsubscribe()` function.

All `on*` methods accept `{once, signal}` options, plus `{replay: true}` on
`onUserJoin`, `onPeerJoin`, `onPeerStream`, `onRoleChange`, `state.onChange`,
and `userState.onChange` to synchronously emit currently active state to a late
subscriber (when combined with `{once: true}`, the first replayed item satisfies
`once` and unsubscribes immediately). Unlike presence, media, and state replay,
`action.onMessage` buffers up to `32` inbound inline messages per sending peer
for `10` seconds per registered action (including role-gated or
`onReceive`-gated actions, without consuming the room's concurrent transfer
budget) while zero listeners are attached and drains them in order to the first
subscriber.

To disconnect and clean up all room subscriptions at once, leave the room:

```js
room.leave()
```

You can inspect your own `userId` with `room.getSelf()`:

```js
const {userId} = await room.getSelf()
console.log(`my user ID is ${userId}`)
```

## Broadcast events

Send users your video stream:

```js
const stream = await navigator.mediaDevices.getUserMedia({
  audio: true,
  video: true
})
room.addStream(stream)
```

Send and subscribe to custom peer-to-peer actions:

```js
const drink = room.makeAction('drink')

// buy drink for a friend
drink.send({drink: 'negroni', withIce: true}, {target: friendId})

// buy round for the house
drink.send({drink: 'mezcal', withIce: false})

// listen for drinks sent to you
drink.onMessage((data, {userId}) =>
  console.log(
    `got a ${data.drink} with${data.withIce ? '' : 'out'} ice from ${userId}`
  )
)
```

Actions can also use request/response semantics:

```js
const isEven = room.makeAction('is-even', {kind: 'request'})

isEven.onRequest(n => n % 2 === 0)

const result = await isEven.request(42, {
  target: friendId,
  timeoutMs: 1000
})
```

To ask multiple users at once, use `requestMany()`. It resolves with a labeled
result for every target, while `onResult` lets you react as each user answers:

```js
const availability = room.makeAction('availability', {kind: 'request'})

availability.onRequest(({date}) => calendar.isFree(date))

const results = await availability.requestMany(
  {date: '2026-05-04'},
  {
    targets: teammateIds,
    timeoutMs: 1000,
    onResult: result => {
      if (result.status === 'fulfilled') {
        updateAvailabilityBadge(result.userId, result.value)
      }
    }
  }
)

const freeUsers = results
  .filter(result => result.status === 'fulfilled' && result.value)
  .map(result => result.userId)
```

If you're using TypeScript, you can add a type hint to the action:

```typescript
type CursorMove = {x: number; y: number}

const cursor = room.makeAction<CursorMove>('cursor-move')
```

You can also use actions to send binary data, like images:

```js
const pic = room.makeAction('pic')

// blobs are automatically handled, as are any form of TypedArray
canvas.toBlob(blob => pic.send(blob))

// binary data (ArrayBuffer, TypedArray, or Blob) is received as a Uint8Array
// so your handling code can wrap or decode it directly
pic.onMessage(
  (data, {userId}) => (imgs[userId].src = URL.createObjectURL(new Blob([data])))
)
```

> Actions are smart and handle serialization and chunking for you behind the
> scenes. This means you can send very large files and whatever data you send
> will be received on the other side as the same type (a number as a number, a
> string as a string, an object as an object, binary as binary, etc.). See
> [receiving files](#receiving-files) for optional size limits and acceptance
> callbacks.
>
> **Tip:** Need to track each user's display name, ready flag, or cursor, or
> keep a shared room value synced to late joiners? Use
> [`room.makeUserState()` and `room.makeState()`](#user-state-and-shared-state)
> instead of maintaining manual maps over actions.

## Audio and video

Here's a simple example of how you could create an audio chatroom:

```js
// this object can store audio instances for later
const userAudios = {}

// get a local audio stream from the microphone
const selfStream = await navigator.mediaDevices.getUserMedia({
  audio: true,
  video: false
})

// send stream to users currently in the room
room.addStream(selfStream)

// send stream to users who join later
room.onUserJoin(({userId}) => room.addStream(selfStream, {target: userId}))

// handle streams from other users
room.onPeerStream((stream, {userId}) => {
  // create an audio instance and set the incoming stream
  const audio = new Audio()
  audio.srcObject = stream
  audio.autoplay = true

  // add the audio to userAudios object if you want to address it for something
  // later (volume, etc.)
  userAudios[userId] = audio
})
```

Doing the same with video is similar, just be sure to add incoming streams to
video elements in the DOM:

```js
const userVideos = {}
const videoContainer = document.getElementById('videos')

room.onPeerStream((stream, {userId}) => {
  let video = userVideos[userId]

  // if this user hasn't sent a stream before, create a video element
  if (!video) {
    video = document.createElement('video')
    video.autoplay = true

    // add video element to the DOM
    videoContainer.appendChild(video)
  }

  video.srcObject = stream
  userVideos[userId] = video
})
```

## User identity

Every user in Trystero gets a unique, unforgeable `userId` out of the box—no
accounts, login screens, or backend servers required. Because every `userId` is
cryptographically verified during connection setup, no one can spoof or hijack
another user's ID.

### Persistent by default, ephemeral or custom with a one-line change

By default in the browser (`identity: 'local'`), `userId` persists across page
reloads, open tabs, and future visits on that device.

If you want a strictly ephemeral identity that resets on every page reload or
new tab without saving to browser storage, set `identity: 'none'`:

```js
const room = joinRoom(
  {
    appId: 'ephemeral-chat',
    identity: 'none'
  },
  'lobby-1'
)
```

Or pass a custom identity or loader function if you want to save and load user
identity keys from your own backend, file system, or account system:

```js
import {joinRoom, importUserIdentity} from 'trystero'

const room = joinRoom(
  {
    appId: 'co-op-RPG',
    identity: async () => importUserIdentity(await fetchUserKeyFromBackend())
  },
  'tavern-1'
)
```

| `identity` value                        | `userId` lifetime                                                                                                                                                                                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'local'` _(browser default)_           | Reused across all open tabs and future visits on the same device (`IndexedDB`) until `clearUserIdentity(appId)` or site storage clears it                                                                                                   |
| `'none'` _(non-browser default)_        | Ephemeral for the current runtime; a reload, new tab, or process restart generates a new `userId`.                                                                                                                                          |
| Custom (`UserIdentity` or async loader) | Controlled by your app (imported via `importUserIdentity()` from your backend or disk in Node/Bun/Deno; custom `sign(payload)` implementations are self-tested on load and must return a 64-byte IEEE P1363 ECDSA P-256 SHA-256 signature). |

To reset a user's stored identity for an app (for example, on "Sign out" or a
shared device), leave any active rooms and call
`await clearUserIdentity(appId)`:

```js
import {clearUserIdentity} from 'trystero'

await room.leave()
await clearUserIdentity('my-app')
```

### Multiple connections for a single user (`userId` vs `peerId`)

Why does Trystero have both a `userId` and a `peerId`?

Because a single user (`userId`) might open your app in **two browser tabs at
the same time**, or connect from both their laptop and phone using a synced
identity. Each open tab or device is its own WebRTC connection with a unique
**`peerId`**, while sharing the same **`userId`**.

For most apps, you only need **`userId`**:

- `room.onUserJoin` fires once when a user's first tab joins, and
  `room.onUserLeave` only fires when their last remaining tab leaves.
- `room.getUsers()` returns the active users in the room
  (`{ [userId]: { peerIds, roles } }`).
- Passing a `userId` as `target` in `send()` or `addStream()` automatically
  **fans out** to every open tab owned by that user, while `request()` and
  `ping()` automatically route to a single tab.

```js
// Sends to all of Alice's open tabs
dm.send('Hey Alice!', {target: aliceUserId})

// Requests a response from one of Alice's tabs
const profile = await getProfile.request(null, {target: aliceUserId})
```

When you _do_ want to distinguish or target individual tabs—for example, sending
a message only to the tab that requested it, showing a multi-device indicator,
or tracking individual WebRTC connections—every event also provides `peerId`,
`room.onPeerJoin` and `room.onPeerLeave` fire for every individual tab
connection, and any `target` option accepts a `peerId` to address that specific
tab alone:

| Connection event               | `onUserJoin` / `onUserLeave` | `onPeerJoin` / `onPeerLeave` |
| ------------------------------ | ---------------------------- | ---------------------------- |
| Alice's first tab joins        | `onUserJoin` (`{userId}`)    | `onPeerJoin` (`{peerId}`)    |
| Alice's second tab joins       | _None_                       | `onPeerJoin` (`{peerId}`)    |
| One of Alice's two tabs leaves | _None_                       | `onPeerLeave` (`{peerId}`)   |
| Alice's last tab leaves        | `onUserLeave` (`{userId}`)   | `onPeerLeave` (`{peerId}`)   |

<details>
  <summary>How it works behind the scenes</summary>

- **Self-certifying IDs**: Each tab generates a fresh ECDSA P-256 endpoint
  keypair (`peerId`, a 20-character Base62 digest
  `sha256("trystero:pid:v1:" || x || "." || y) mod 62²⁰`, where `x` and `y` are
  the 43-character Base64URL P-256 public key coordinates) alongside the user's
  ECDSA P-256 identity keypair (`userId`, a 22-character Base62 digest
  `sha256("trystero:uid:v1:" || x || "." || y) mod 62²²`). Domain-separated
  prefixes guarantee a single P-256 key never shares prefix bytes between
  `peerId` and `userId`, and distinct lengths (`20` vs `22`) let any `target`
  option unambiguously recognize which one you passed.
- **Connection-bound handshake**: Before any peer or user join event fires, both
  sides exchange fresh cryptographic nonces and sign a transcript binding the
  `appId`, `roomId`, both `peerId`s, both `userId`s, and the WebRTC connection's
  DTLS certificate fingerprints
  ([RFC 8827](https://www.rfc-editor.org/rfc/rfc8827.html)). This prevents
  replay attacks and stops a man-in-the-middle on the signaling channel from
  forwarding someone else's identity proof onto a different connection.
- **Atomic browser storage**: In `identity: 'local'` mode, Trystero coordinates
  first-time key creation across concurrent tabs using `navigator.locks` and
  atomic `IndexedDB` transactions storing a non-extractable WebCrypto
  `CryptoKey`.

</details>

## User state and shared state

Actions (`room.makeAction`) are ideal for **events, RPC requests, and file
transfers**, whereas most multiplayer apps also need **current state** that
automatically syncs to late joiners without manual bookkeeping. Trystero
provides two state primitives right on `room`:

| Primitive                           | Best for                                                      | Who can write                         | Synced to late joiners?                         |
| ----------------------------------- | ------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------- |
| `room.makeAction(ns)`               | Chat messages, sound effects, 1-to-1 RPC, binary/file streams | Any member (or `roles`)               | No (ephemeral events)                           |
| **`room.makeUserState(ns, init?)`** | Display names, avatars, cursors, ready flags, player loadouts | **Only that `userId`** (own slot)     | Yes (while user is present in room)             |
| **`room.makeState(ns, init?)`**     | Cooperative boards, shared timers, jam tempo, casual lobbies  | **Any room member** (without `roles`) | Yes (cached & relayed by remaining peers)       |
| **`room.makeState` + `roles(...)`** | Official match phase, host scoreboard, moderated watch party  | **Only `'admin'` / specified roles**  | Yes (cryptographically verified against admins) |

> **Rule of thumb:** Never store a `{[userId]: ...}` map inside an open
> `makeState` (`players.set(prev => ({...prev, [me]: ...}))`)—simultaneous
> updates from two users overwrite each other under last-writer-wins. Use
> **`room.makeUserState`** whenever each participant owns their own entry.

### Per-user state (`room.makeUserState`)

`room.makeUserState(namespace, initialValue?, config?)` gives every user a
cryptographically signed slot keyed by their `userId` (`initialValue` defaults
to `null`). Only that user can update or clear their own state—even when state
is relayed across hops or synced to newcomers by other peers:

```js
const name = room.makeUserState('name', 'a weird stranger')

// Set your own name right after joining — automatically flushed before
// onUserJoin fires on connected peers!
name.set('Oedipa')

// Already populated when a user joins
room.onUserJoin(({userId}) => {
  console.log(`${name.get(userId)} joined`)
})

// Still readable inside onUserLeave, then cleaned up automatically right after
room.onUserLeave(({userId}) => {
  console.log(`${name.get(userId)} left`)
})

// React to live updates and removals
name.onChange((value, {userId, prev, removed}) => {
  if (removed) {
    console.log(`${prev} (${userId}) cleared or left`)
  } else {
    console.log(`${userId} is now known as ${value}`)
  }
})

// Read a frozen { [userId]: value } map of everyone who has published (including yourself)
console.log(name.getAll())
```

Key behaviors of `makeUserState`:

- **Distinguishing "not published yet" from `null`**: `state.get(id?)` returns
  `initialValue` (`null` by default) before a user publishes, while
  `state.has(id?)` returns `false` until `.set(...)` is called (even if
  `.set(null)` is called explicitly) and returns `false` again after
  `await state.clear()` or eviction.
- **Multi-tab safe**: Opening a second tab with the same `userId` does not
  clobber state published from the first tab, updates sync across all of your
  tabs, and presence-scoped state stays live until your **last** open tab
  leaves.
- **Synchronous optimistic local reads & 40 ms wire coalescing**: Calling
  `.set(...)` or `.clear()` updates local `.get()` / `.getAll()` and fires local
  `onChange` synchronously right away (deferring pre-`ready` optimistic apply
  only on role-gated namespaces until local identity/roles resolve), while rapid
  back-to-back writes (such as dragging a slider or cursor) coalesce ECDSA
  signing and wire broadcasts over a 40 ms pacing window.
- **Presence-scoped lifecycle**: A user's entry lives while they are in the
  room, remains readable _during_ `room.onUserLeave` callbacks, and is evicted
  automatically right after `onUserLeave`.

### Shared room state (`room.makeState`)

`room.makeState(namespace, initialValue?, config?)` synchronizes a single shared
JSON value across the room (`initialValue` defaults to `null`), available
synchronously right after `joinRoom()`:

```js
const playback = room.makeState('playback', {
  trackUrl: 'https://example.com/song.mp3',
  paused: true
})

playback.onChange((next, {prev, userId}) => {
  console.log(`${userId} changed playback from`, prev, 'to', next)
})

// Update with a value or functional updater
await playback.set(prev => ({...prev, paused: false}))
```

If a newcomer joins late—even after the person who last updated `playback` has
left the room—remaining peers automatically sync the latest signed state to the
newcomer.

#### Security & trust caveats for open `makeState` (without `roles()`)

When you do **not** pass `roles()` in `joinRoom()`, `makeState` runs in **open
member mode**:

- **Room membership is the trust boundary**: Any peer admitted to the room can
  overwrite an open `makeState` namespace, though `getMeta().userId` is always
  cryptographically authentic. In private rooms, set a strong room `password` so
  outsiders cannot join.
- **Whole-value last-writer-wins (LWW)**: Concurrent writes do not deep-merge
  object fields—every peer deterministically converges to the highest bounded
  tuple Hybrid Logical Clock record `([wallMs, counter], userId, peerId, sig)`.
  Keep per-user fields in `makeUserState`, and layer a CRDT (such as Yjs or
  Automerge) over `makeAction` if you need concurrent character- or list-level
  merging.
- **Bounded clock-skew window**: Peers reject state records dated more than 10
  seconds into the future (up to `cert.iat + 10s` for role-certified writes,
  capped at 60 seconds), bounding how far a misconfigured clock or griefing
  member in an open room can pin a timestamp.
- **Upgrade to `roles()` for untrusted/public rooms**: Whenever untrusted
  strangers can join and you need host-only state, custom writer roles, or peer
  banning, pass `use: [roles(...)]` (see
  [Room admins, roles, and authoritative state](#room-admins-roles-and-authoritative-state)).
  To prevent accidental privilege leaks, **loading `roles()` automatically makes
  `makeState` default to `roles: ['admin']`** (fail-closed); pass `roles: '*'`
  on any specific `makeState` namespace you intentionally want to keep open to
  all unbanned members inside a `roles()` room.

## Advanced

### Binary metadata

Let's say your app supports sending various types of files and you want to
annotate the raw bytes being sent with metadata about how they should be
interpreted. Instead of manually adding metadata bytes to the buffer you can
simply pass a metadata argument in the sender action for your binary payload:

```js
const file = room.makeAction('file')

file.onMessage((data, {userId, metadata}) =>
  console.log(
    `got a file (${metadata.name}) from ${userId} with type ${metadata.type}`,
    data
  )
)

file.send(buffer, {
  metadata: {name: 'The Courierʼs Tragedy', type: 'application/pdf'}
})
```

### Receiving files

Incoming data is accepted automatically. Use `onReceive` to accept or decline
payloads based on their size, sender, or metadata:

```js
const file = room.makeAction('file')

const unsubReceive = file.onReceive(
  ({byteLength}) => byteLength <= 100 * 1024 ** 2
)
file.onMessage((data, {metadata}) => saveFile(data, metadata.name))
```

Return `true` or `false`, or a promise of either. Large payloads wait for
approval before sending their contents; declined small messages are discarded
after arrival. Only one `onReceive` handler may be active per action at a time;
call the returned unsubscribe function (`unsubReceive()`) to restore automatic
acceptance.

`byteLength` is the payload size in bytes (UTF-8 for strings/JSON), excluding
metadata. The context's `signal` aborts when the transfer ends; use it to
dismiss pending approval UI.

Each room defaults to a 256 MiB receive budget. Set `maxReceiveBytes` in the
room config to allow larger files or reduce memory use. Concurrent transfers
queue automatically when the budget is occupied. Received files must fit in
memory.

### Action promises

Sender promises resolve when local sending finishes; they do not confirm
delivery or application handling. Broadcast `send(data)` resolves immediately
when zero peers are connected, whereas an explicit-target `send(data, {target})`
rejects if any specified target is not currently connected. Failed `send()` and
`request()` calls reject with an `ActionError` (`error.kind`:
`'timeout' | 'disconnected' | 'aborted' | 'rejected'`). If a receiver declines a
large transfer via `onReceive`, or an `onRequest` handler throws an `Error`, the
caller's promise rejects with `error.kind === 'rejected'` (preserving the thrown
`Error`'s `message` for `onRequest`). For binary payloads larger than `16 KiB`,
`send()` chunks directly from the caller's buffer without copying—do not mutate
a binary buffer passed to `send()` until its returned `Promise` settles. Use
request actions when you need a response.

```js
await file.send(amplePayload)
console.log('done sending to all users')
```

### Progress updates

Action sender functions also take an optional callback function that will be
continuously called as the transmission progresses. This can be used for showing
a progress bar to the sender for large transfers. The callback is called with a
percentage value between 0 and 1 and the receiver's context:

```js
file.send(payload, {
  target: [userA, userB, userC],
  metadata: {filename: 'paranoids.flac'},
  onProgress: (percent, {userId}) => (loadingBars[userId].value = percent)
})
```

Similarly you can listen for progress events as a receiver like this:

```js
const file = room.makeAction('file')

file.onReceiveProgress((percent, {userId, metadata}) =>
  console.log(
    `${percent * 100}% done receiving ${metadata.filename} from ${userId}`
  )
)
```

Notice that any metadata is sent with progress events so you can show the
receiving user that there is a transfer in progress with perhaps the name of the
incoming file.

Since a user can send multiple transmissions in parallel, you can also use
metadata to differentiate between them, e.g. by sending a unique ID.

### Encryption

Once users are connected to each other all of their communications are
end-to-end encrypted. During the initial connection / discovery process, peers'
[SDPs](https://en.wikipedia.org/wiki/Session_Description_Protocol) are sent via
the chosen peering strategy medium. By default the SDP is encrypted using a key
derived from your app ID and room ID to prevent plaintext session data from
appearing in logs. This is fine for most use cases, however a relay strategy
operator can reverse engineer the key using the room and app IDs. A more secure
option is to pass a `password` parameter in the app configuration object which
will be used to derive the encryption key:

```js
joinRoom({appId: 'kinneret', password: 'MuchoMaa$'}, 'w_a_s_t_e__v_i_p')
```

This is a shared secret that must be known ahead of time and the password must
match for all users in the room for them to be able to connect. When a
`password` is set, Trystero derives the AES-256-GCM signaling key using
WebCrypto `PBKDF2-SHA256` (`600,000` iterations, domain-separated by `appId` and
`roomId`) and binds each encrypted SDP or ICE payload to its message type,
sender `peerId`, and `offerId` via GCM additional authenticated data (AAD).
Because signaling relays observe encrypted SDP ciphertexts and could mount an
offline dictionary guess against weak passwords, use a strong, high-entropy
password when protecting sensitive rooms. An example use case might be a private
chat room where users learn the password via external means.

### Room size limits

Sometimes you want a best-effort cap on how many users each peer accepts into a
room. For example, you might be building:

- **A 2-player board game** (like chess or Battleship) where a third person
  opening the invite link shouldn't be able to barge into an active match.
- **A 4-player co-op lobby** that stops accepting new players once all four
  party slots are taken.
- **A private 1-on-1 video call** where only two people connect at a time.

To set an advisory per-peer limit on how many unique users (`userId`s, including
the local user) can be in a peer's room view at once, pass `maxUsers` in your
`joinRoom()` config and listen for `'room-full'` via `room.onError()`:

```js
const room = joinRoom(
  {
    appId: 'chess-club',
    maxUsers: 2 // advisory cap of 2 unique users in this peer's view (you + 1 opponent)
  },
  'match-42'
)

room.onError(err => {
  if (err.code === 'room-full') {
    showBanner('Sorry, this match is already full!')
  }
})
```

When a peer's room view is already at capacity:

- Any extra user (`userId`) who tries to connect is refused by that peer before
  activation, receives `{code: 'room-full'}` in `onError`, and has that peer
  link closed.
- Because `maxUsers` counts unique `userId`s rather than raw tabs, an admitted
  player who refreshes the page or opens another tab shares their existing seat.
- Existing players in the room are never interrupted—`onPeerJoin` and
  `onPeerLeave` won't fire for someone who was turned away at the door.
- If one of the current players leaves (`room.leave()` or closes their last
  tab), a seat immediately opens back up for the next person who joins.

<details>
  <summary>How it works behind the scenes</summary>

- **Best-effort advisory per-peer check**: Without a central server or room
  admin, capacity is enforced locally by each peer on its own view. When a
  peer's active unique `userId` count (including itself) reaches `maxUsers`, it
  refuses new `userId`s during the admission handshake before they are added to
  `getPeers()` or trigger `onPeerJoin`.
- **No self-eviction or unverified `'room full'` propagation**: A peer never
  evicts itself and never drops connections to other peers just because a remote
  peer claims `'room full'`. A `'room full'` response only closes that single
  peer link and reports `onError` (`{code: 'room-full'}`) for that peer. For
  authoritative roster enforcement backed by a cryptographic trust root, use
  [`roles()`](#room-admins-roles-and-authoritative-state).
- **Password privacy**: In password-protected rooms (`config.password`), SDP
  offers and answers are encrypted and authenticated with the PBKDF2-derived
  room key _before_ any WebRTC data channel opens or room capacity is checked.
  Users with the wrong password fail signaling decryption (`onError` with
  `code: 'decrypt-failed'`) rather than receiving `'room-full'`, so outsiders
  cannot probe whether a private room is full.
- **Multi-hop rooms**: When `scale()` is enabled, local capacity checks also
  account for verified multi-hop overlay peers.

</details>

### Room admins, roles, and authoritative state

In a peer-to-peer app, everyone is normally equal. Usually that's great, but
many apps need a trusted host or moderator with special permissions—without
having to build and host a backend server.

For example, you might be building:

- **A multiplayer trivia or party game** where only the host can advance to the
  next round or update the official scoreboard.
- **A synchronized watch party or music room** where only the room creator (or
  designated DJs) can change the current track or pause playback.
- **A live chatroom or classroom** where moderators can mute or ban spammers so
  they can't disrupt the room.

By importing the tree-shakeable `roles` plugin and passing it in `use: [...]`,
Trystero lets you create verified room admins, assign custom roles (like
`'moderator'` or `'dj'`), restrict actions to specific roles, and sync an
official "source of truth" state that everyone can read—all purely peer-to-peer.

#### 1. Creating a room on the fly as the admin

The easiest way to make the room creator an admin is to pass
`use: [roles({selfAsAdmin: true})]` when calling `joinRoom()`. For example, when
a player clicks **"Create Game"** in your app:

```js
import {joinRoom, roles} from 'trystero'

// The host creates a room with admin powers tied to their userId
const hostRoom = joinRoom(
  {
    appId: 'trivia-night',
    use: [roles({selfAsAdmin: true})]
  },
  'friday-quiz'
)
const {roomId} = await hostRoom.getSelf()

// Share `roomId` (e.g. "friday-quiz~9fX2kLm8pQr7vBn3wZy4xT") in an invite link for friends!
```

When you pass `roles({selfAsAdmin: true})`, Trystero attaches a `~` separator
and the host's 22-character Base62 `userId` to your room name (like
`'friday-quiz~9fX2kLm8pQr7vBn3wZy4xT'`). Think of that suffix as a built-in
digital ID badge for the host.

When friends join using that self-certifying `roomId`, they simply include
`use: [roles()]` in `joinRoom()`—their browsers automatically check the suffix
and recognize the host's `userId` as the true admin (joining a self-certifying
`<roomId>~<userId>` without `roles()` throws an error so misconfigured clients
fail fast):

```js
// Guests join using the shared roomId with use: [roles()]
const guestRoom = joinRoom({appId: 'trivia-night', use: [roles()]}, roomId)
```

> **Important:** A self-certifying room's root admin authority is tied
> permanently to the host's `userId` key. In browsers, Trystero's default
> `'local'` identity persists this key automatically in `IndexedDB`. When
> running server-side (Node, Bun, Deno) or without browser storage, pass a saved
> `UserIdentity` (from `createUserIdentity()` / `importUserIdentity()`) instead
> of an ephemeral `'none'` identity—otherwise closing the process discards the
> admin key and leaves the self-certifying room without a root admin. Trystero
> logs a warning if `selfAsAdmin: true` is used with an ephemeral identity. With
> a `UserIdentity`, you can also format the self-certifying room ID ahead of
> time as `` `${baseRoomId}~${identity.userId}` ``.

#### 2. Specifying admin `userId`s (fixed room names or co-admins)

What if you want a permanent, memorable room name like `'main-stage'` without a
`~<userId>` suffix at the end—or want to designate additional co-admins?

Pass `admins: [...]` with the trusted admin `userId`s to `roles()`. When an
admin joins with their matching `identity`, they are automatically recognized as
`'admin'`, and regular participants automatically trust updates and role grants
signed by those `userId`s:

```js
import {joinRoom, roles} from 'trystero'

const HOST_USER_ID = 'tY8mK3pQvN2xR7wL9jB4cF'

// Everyone (both the host and viewers) can use the exact same config!
// If the local user's userId matches HOST_USER_ID, they are the admin;
// otherwise they join as a regular participant who trusts HOST_USER_ID.
const room = joinRoom(
  {
    appId: 'town-hall',
    use: [roles({admins: [HOST_USER_ID]})]
  },
  'main-stage'
)
```

You can also combine `{selfAsAdmin: true, admins: [CO_HOST_USER_ID]}` to create
a self-certifying room while trusting additional co-admins from the start.

#### Restricting actions to admins or custom roles

For example, in a game where anyone can send chat messages, you might want an
`'announce'` action that only the `'admin'` or a `'moderator'` is allowed to
send. Just pass `roles` when creating the action:

```js
const announce = room.makeAction('announce', {
  roles: ['admin', 'moderator']
})

announce.onMessage((data, {userId, roles}) => {
  console.log(`Verified ${roles.join(', ')} (${userId}) announced:`, data)
})

// Only succeeds if the local user is an 'admin' or 'moderator'
await announce.send({text: 'Round 2 starts now!'})
```

If a regular user tries to call `announce.send(...)` from the browser console,
Trystero blocks it locally—and even if they modified their client code to send a
fake packet, every other peer in the room will automatically reject it.

#### Authoritative shared state (`room.makeState` + `roles()`)

Many apps need official room state that everyone can read, but only the host or
authorized roles can update—like the current question in a quiz game, the active
video URL in a watch party, or the current slide in a presentation.

When `roles()` is passed to `joinRoom()`, `room.makeState()` defaults to
`roles: ['admin']` (fail-closed) and unlocks `config.roles` on both `makeState`
and `makeUserState`. Both methods can be called synchronously right on `room`
without waiting for `await room.ready`. Whenever an authorized user updates the
state, every user in the room verifies their role certificate and applies the
update—and **if a new user joins late, even after the host has closed their
laptop and left, existing peers automatically sync the latest official state to
the newcomer** without being able to tamper with it:

```js
const roundState = room.makeState(
  'round-state',
  {round: 1, phase: 'lobby'},
  {
    roles: ['admin', 'host'],
    // Optional rule: reject invalid values locally and remotely
    validate: next => next.round >= 1
  }
)

// You can also opt a specific shared state back into open writes inside a roles() room:
const reactionWall = room.makeState('wall', {emoji: '👋'}, {roles: '*'})

// Or restrict a per-user state namespace to specific roles (e.g. seated players only):
const bet = room.makeUserState('bet', 0, {roles: ['admin', 'player']})

// Anyone can read the current official state at any time
console.log(roundState.get())

// Listen for official state updates
roundState.onChange((value, {prev, userId, roles}) => {
  console.log(
    `Updated from round ${prev.round} by ${userId} (${roles}):`,
    value
  )
})

// Only an 'admin' or 'host' can update roundState
await roundState.set(prev => ({round: prev.round + 1, phase: 'active'}))
```

#### Promoting moderators and banning spammers

During a live session, an admin can promote other users in the room to custom
roles (like `'moderator'` or `'dj'`), revoke those roles later, or permanently
ban a disruptive user from the room:

```js
// React whenever any user's verified roles change (locally or remotely)
room.onRoleChange(({userId, roles, previousRoles, local}) => {
  console.log(`${userId} roles: ${previousRoles} -> ${roles} (local=${local})`)
})

// Promote a user to 'moderator'
await room.grantRole(userId, 'moderator')

// Check which verified roles a user currently has
console.log(room.getRoles(userId)) // => ['moderator']

// Remove the 'moderator' role from a user
await room.revokeRole(userId, 'moderator')

// As a root admin, kick and ban a disruptive user from the room
await room.ban(maliciousUserId, {reason: 'spam'})

// Lift a previous ban so the user can rejoin
await room.unban(maliciousUserId)
```

Only root admins (the self-certifying room creator or `userId`s listed in
`roles({admins})`) hold the `'admin'` role and can call `grantRole`,
`revokeRole`, `ban`, or `unban` (`'admin'` cannot be granted to non-root users).
Banned users have their granted roles cleared and their `makeUserState` /
`makeState` records purged across peers, and receive `{code: 'banned', reason}`
via `room.onError()` (both when kicked mid-session and if they try to rejoin
before `room.unban()`). Up to `4,096` concurrent active bans are retained per
room (`'unban'` tombstones are evicted first at capacity, and attempting a
4,097th active ban throws rather than silently dropping an existing ban). Note
that in a serverless peer-to-peer room without a custom signaling gatekeeper,
bans are enforced cooperatively by honest peers across WebRTC handshakes,
multi-hop relays, and action/state verification—banned clients cannot interact
with room members, though public signaling relays themselves remain
permissionless.

<details>
  <summary>How it works behind the scenes</summary>

- **Zero-trust public-key signatures**: Room authority is unified directly with
  each user's WebCrypto ECDSA P-256 `UserIdentity` (`userId`). Private keys
  never leave the user's device. Every privileged action, state update, role
  grant, revocation, ban, or unban is signed with the sender's private key and
  verified by every peer before being accepted.
- **Self-certifying room IDs**: A user's 22-character Base62 `userId` is derived
  directly from the domain-separated SHA-256 digest of their compact Base64URL
  P-256 public key (`sha256("trystero:uid:v1:" || x || "." || y) mod 62²²`, ~131
  bits). When you create a room with `roles({selfAsAdmin: true})`, Trystero
  appends your `userId` directly onto the room ID (`<baseRoomId>~<userId>`).
  When peers connect—or when the host rejoins with the same persistent
  identity—everyone can mathematically verify from the `userId` suffix alone who
  owns the room.
- **Root-signed role certificates & moderation**: Calling `room.grantRole()`
  issues a signed `RoleCertificate` binding the recipient's `subUserId` to the
  granted custom role(s) and a monotonic authority `(iat, seq)` stamp. Because
  the certificate binds `subUserId`, a promoted user retains their roles across
  page reloads and multiple open tabs automatically. Peers verify the root
  admin's signature on the certificate and check against signed
  `RoleRevocationRecord`s and `PeerModerationRecord`s (`op: 'ban' | 'unban'`).
  Likewise, `room.ban()` bans the target `userId` across all current and future
  tabs until a root admin calls `room.unban()`. Concurrent authority and
  moderation records are evaluated in a total causal order (`(ts, seq)` plus
  deterministic tie-breakers) and reconciled via cursor-paged anti-entropy sync
  so all peers converge to the exact same set of active roles and bans
  regardless of message arrival order or clock jumps.
- **Tamper-proof state syncing (`makeState` & `makeUserState`)**: Shared and
  per-user state updates share a unified signed envelope bound to `appId`,
  `roomId`, `ns`, `userId`, `peerId`, a skew-bounded tuple Hybrid Logical Clock
  (`[wallMs, counter]`), and an inline `RoleCertificate` when role-gated.
  Concurrent updates converge deterministically under
  `([wallMs, counter], userId, peerId, sig)`, late joiners reconcile missing
  records via cursor-paged 1-RTT digest pull sync, and `room.ban()` immediately
  purges any state authored by the banned user. State records tolerate up to 10
  seconds of future wall-clock skew across devices (60 seconds for role
  certificates and moderation records).
- **Edge filtering & private signaling**: In multi-hop topologies, immediate
  neighbors (Hop-1 relays) verify role certificates, signatures, and
  `PeerModerationRecord`s before forwarding packets, stopping unauthorized
  traffic or banned peers at the edge. Role certificates and moderation records
  are exchanged only over encrypted WebRTC data channels after connecting so
  user IDs and ban metadata are never exposed to signaling relays.

</details>

### Scaling large rooms

Normally in WebRTC, every browser in a room opens a direct connection to every
other browser. That works great for small groups (and keeps your bundle size
minimal when you don't need multi-hop routing), but once a room grows past a
dozen people—like a busy game lobby, a collaborative canvas with 50 cursors, or
a live watch party—maintaining that many connections at once can slow down or
overwhelm a user's browser.

**Opt into automatic scaling with `scale()` _(experimental)_:**

```js
import {joinRoom, scale} from 'trystero'

const room = joinRoom({appId: 'massive-canvas', use: [scale()]}, 'lobby-1')
```

> [!NOTE] `scale()` is **experimental** and designed for cooperative rooms with
> dozens of peers (tested up to 48 concurrent browser instances and 250+
> simulated peers).

When you include `use: [scale()]`:

- When the room has `maxDirectPeers + 1` or fewer peers (`7` peers or fewer at
  the default `maxDirectPeers: 6`), everyone connects directly in a full mesh
  with zero multi-hop routing overhead.
- As more people join, Trystero automatically forms a bounded-degree multi-hop
  gossip network targeting `maxDirectPeers` direct WebRTC connections per
  browser (`6` by default, configurable `4..32`; actual direct neighbor counts
  are a target and can temporarily exceed it under burst joins due to inbound
  soft ceilings and minimum-degree fallbacks) while routing messages across hops
  to the entire room. (`maxDirectPeers` controls direct WebRTC neighbor links
  per peer, **not** the maximum number of users allowed in the room—use
  `maxUsers` if you want to cap room membership.)

All of your code (`makeAction`, `makeState`, `makeUserState`, `addStream`,
`replaceTrack`, `ping`, `onUserJoin`, `onUserLeave`, and `getUsers()`) works the
exact same way no matter how many people are in the room or whether two users
are connected directly or through other peers.

Media streams (`addStream` and `replaceTrack`) and large binary transfers (> 16
KiB) automatically promote the target peer(s) to a direct 1-hop WebRTC
connection on demand so relays never decode or forward audio/video tracks or
bulk chunks. Because media and bulk transfers use direct connections, they scale
as a 1-to-N mesh for the sender, and promoted connections can exceed the
overlay's `maxDirectPeers` target. Await the promise returned by `addStream` or
`replaceTrack` to handle connection failures.

You can customize the direct-neighbor target by passing `maxDirectPeers` to
`scale()`:

```js
const room = joinRoom(
  {
    appId: 'massive-canvas',
    use: [
      scale({
        maxDirectPeers: 8 // target direct WebRTC neighbors per peer (4..32, default: 6)
      })
    ]
  },
  'lobby-1'
)
```

Once `await room.ready` resolves, you can call `room.getTopology()` at any time
to see which peers are connected directly vs. across multiple hops, how data
routes are organized, and forwarding statistics.

<details>
  <summary>How it works behind the scenes</summary>

- **Unified multi-ring gossip overlay**: Peers arrange themselves on a
  room-salted, per-user-capped multi-ring expander (`floor(maxDirectPeers / 2)`
  independent permuted cycles for `O(log N)` diameter)—naturally forming a full
  mesh when `N <= maxDirectPeers + 1`—and derive hop-capped shortest-path routes
  dynamically from the verified room roster size so unreachable peers beyond the
  hop limit are never falsely exposed as active. Routing tables require mutual
  neighbor confirmation in signed link-state descriptors (refreshed by
  heartbeats and verified data traffic with a 180 s TTL and a 1.2 s route-churn
  grace window) before using an edge. Broadcasts propagate across neighbor links
  with persistent per-origin sliding replay windows and message-ID
  deduplication, while point-to-point messages (`target`) route along shortest
  paths with end-to-end ECDH + AES-256-GCM encryption (12-byte IVs, canonical
  header AAD, per-origin sequence replay windows, and 60-second timestamp
  freshness bounds).
- **Direct WebRTC promotion for media & bulk transfers**: Calling `addStream()`
  or sending a multi-chunk payload (> 16 KiB) to a multi-hop peer automatically
  establishes a direct 1-hop WebRTC connection to that peer so media and bulk
  transfers flow peer-to-peer without burdening intermediate relays (scaling as
  mesh for the sender).
- **Threat model & end-to-end data security**: Every peer generates an ephemeral
  WebCrypto signing keypair (ECDSA P-256) and encryption keypair (ECDH P-256).
  Link-state descriptors, leave notices, broadcasts, and unicast headers are
  cryptographically bound to `appId`, `roomId`, and a per-origin monotonic
  sequence counter (`seq`) and verified against self-certifying `peerId` keys,
  and targeted data messages (`target`) are end-to-end encrypted with AES-GCM
  (with canonical header AAD). Cryptographic integrity, replay protection, and
  unicast confidentiality hold against untrusted signaling relays and multi-hop
  forwarders; however, because peers route through one another in a cooperative
  overlay, a malicious authenticated room member can still drop forwarded
  packets or inflate the roster up to the configured per-user and room caps.

</details>

### React

Both `room.makeUserState()` and `room.makeState()` implement React's
`useSyncExternalStore` contract out of the box (`onChange` returns an
`unsubscribe` function, and `userState.getAll` / `state.get` return
reference-stable snapshots) — no `useEffect`, manual listener sets, or
`onUserJoin` / `onUserLeave` bookkeeping needed:

```jsx
import {joinRoom} from 'trystero'
import {useSyncExternalStore} from 'react'

const room = joinRoom({appId: 'thurn-und-taxis'}, 'lobby')
const userColor = room.makeUserState('color', '#c0ffee')
const banner = room.makeState('banner', 'Welcome to the lobby!')

userColor.set('#c0ffee')

export default function App() {
  const myColor = useSyncExternalStore(userColor.onChange, () =>
    userColor.get()
  )
  const allColors = useSyncExternalStore(userColor.onChange, userColor.getAll)
  const title = useSyncExternalStore(banner.onChange, banner.get)

  return (
    <>
      <h1>{title}</h1>

      <h2>My color:</h2>
      <input
        type="color"
        value={myColor}
        onChange={e => userColor.set(e.target.value)}
      />

      <h2>Everyone in the room:</h2>
      <ul>
        {Object.entries(allColors).map(([userId, color]) => (
          <li key={userId} style={{backgroundColor: color}}>
            {userId}: {color}
          </li>
        ))}
      </ul>
    </>
  )
}
```

> **SSR note:** In server-rendered frameworks like Next.js, guard module-scope
> `joinRoom()` calls behind `typeof window !== 'undefined'` (or initialize the
> room lazily on the client) so WebRTC setup only runs in the browser.

### Troubleshooting connection issues

WebRTC is powerful but some networks simply don't allow direct P2P connections
using it. If you find that certain user pairings aren't working in Trystero,
you're likely encountering an issue at the network provider level. To solve this
you can configure a TURN server which will act as a proxy layer for peers that
aren't able to connect directly to one another.

1. If you can, confirm that the issue is specific to particular network
   conditions (e.g. user with ISP X cannot connect to a user with ISP Y). If
   other user pairings are working (like those between two browsers on the same
   machine), this likely confirms that Trystero is working correctly.
2. Sign up for a TURN service or host your own. There are various hosted TURN
   services you can find online like
   [Cloudflare](https://developers.cloudflare.com/calls/turn/) (which offers a
   free tier with 1,000 GB traffic per month) or
   [Open Relay](https://www.metered.ca/stun-turn). You can also host an open
   source TURN server like [coturn](https://github.com/coturn/coturn),
   [Pion TURN](https://github.com/pion/turn),
   [Violet](https://github.com/paullouisageneau/violet), or
   [eturnal](https://github.com/processone/eturnal). Keep in mind data will only
   go through the TURN server for peers that can't directly connect and will
   still be end-to-end encrypted.
3. Once you have a TURN server, configure Trystero with it like this:
   ```js
   const room = joinRoom(
     {
       // ...your app config
       turnConfig: [
         {
           // single string or list of strings of URLs to access TURN server
           urls: ['turn:your-turn-server.ok:1979'],
           username: 'username',
           credential: 'password'
         }
       ]
     },
     'roomId'
   )
   ```

### Running server-side (Node, Bun, Deno)

Trystero works outside browsers too, like in Node, Bun, or Deno. Why would you
want to run something that helps you avoid servers on a server? One reason is if
you want an always-on peer which can be useful for remembering the last state of
data, broadcasting it to new users. Another reason might be to run peers that
are lighter weight and don't need a full browser running, like an embedded
device or Raspberry Pi.

Running server-side uses the same syntax as in the browser, but you need to
import a polyfill for WebRTC support:

```js
import {joinRoom} from 'trystero'
import {RTCPeerConnection} from 'werift'

const room = joinRoom(
  {
    appId: 'your-app-id',
    rtcPolyfill: RTCPeerConnection,
    passive: true // optional: act as a silent backup/state-relay peer
  },
  'your-room-name'
)
```

> **Always-on shared-state relay:** A `passive: true` server peer that declares
> `room.makeState(...)` for your room's shared namespaces automatically
> verifies, caches, and syncs the latest signed shared state to newcomers—even
> if all browser peers briefly disconnect (while presence-scoped `makeUserState`
> entries are evicted automatically as each user leaves).

### Self-hosted WebSocket relay

If you want a tiny relay that you control, use the WebSocket relay package. To
run the server on Node, install the optional `ws` peer dependency alongside
`@trystero-p2p/ws-relay` (browser clients do not need `ws`):

```sh
npm i @trystero-p2p/ws-relay ws
```

```js
import {createWsRelayServer} from '@trystero-p2p/ws-relay/server'

createWsRelayServer({port: 8080})
```

Then in the browser (use `ws://` for local development or `wss://` behind TLS in
production):

```js
import {joinRoom} from '@trystero-p2p/ws-relay'

const room = joinRoom(
  {
    appId: 'app-id',
    relayConfig: {
      urls: ['ws://localhost:8080']
    }
  },
  'room-id'
)
```

The `relayConfig.urls` config option is required for this strategy because there
are no public default servers. You can pass multiple.

`createWsRelayServer(options)` accepts standard `ws` server options (`port`,
`server`, `noServer`, `path`, `maxPayload`, etc.) plus optional relay safety
limits:

- `maxTopicLength` - Maximum topic string length (default: `256`).
- `maxSubscriptionsPerSocket` - Maximum topics per client socket (default:
  `128`).
- `maxSubscriptions` - Maximum total subscriptions across all connected sockets
  (default: `10000`).
- `maxMessagesPerSecond` - Per-socket publish/subscribe refill rate (default:
  `200`; pass `Infinity` to disable; values `<= 0` throw `RangeError`).
- `maxBurstMessages` - Per-socket token-bucket burst capacity (default:
  `max(256, maxMessagesPerSecond * 2)`; pass `Infinity` to disable; values
  `<= 0` throw `RangeError`).
- `onError` - Optional `(error: Error) => void` listener for server errors.

### Write your own strategy

If you want to provide your own signaling backend, you can build a custom
strategy with `createTopicStrategy`. This is the recommended helper for simple
pub/sub relays because Trystero handles room lifecycle details like passive
mode, announce scheduling, and peer-specific signaling topics.

The example below assumes a WebSocket relay that does simple pub/sub routing:

- Client sends
  `{"type": "subscribe" | "unsubscribe" | "publish", "topic", "payload"}`
- Server broadcasts `{"topic", "payload"}` to subscribers of each topic

This is just to show you how it works; if you want a simple self-hosted
solution, use the `ws-relay` package explained above.

```js
import {createTopicStrategy, toJson} from '@trystero-p2p/core'

export const joinRoom = createTopicStrategy({
  // Define init as a function that returns a promise of your signaling client.
  // Resolve the promise when your client is ready to send messages.
  // You can also return an array of client promises for redundancy.
  // In this case, the client is a single WebSocket.
  init: config =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(config.relayConfig.urls[0])
      ws.addEventListener('open', () => resolve(ws), {once: true})
      ws.addEventListener('error', reject, {once: true})
    }),

  // Subscribe to one topic. Trystero decides which topics are needed and when.
  subscribeTopic: (client, topic, onMessage) => {
    const onWsMessage = event => {
      const message = JSON.parse(String(event.data))

      if (message.topic !== topic) {
        return
      }

      onMessage(message.topic, message.payload)
    }

    client.addEventListener('message', onWsMessage)
    client.send(toJson({type: 'subscribe', topic}))

    return () => {
      client.send(toJson({type: 'unsubscribe', topic}))
      client.removeEventListener('message', onWsMessage)
    }
  },

  // Publish a payload to one topic.
  publishTopic: (client, topic, payload) =>
    client.send(
      toJson({
        type: 'publish',
        topic,
        payload
      })
    )
})

const room = joinRoom(
  {appId: 'my-app-id', relayConfig: {urls: ['wss://my-relay.example']}},
  'my-room-id'
)
```

`createTopicStrategy` uses a short startup announcement burst followed by a
60-second steady interval and repeats the burst after a peer drops. Set
`reannounceOnDisconnect: false` when the signaling backend stores peer presence
rather than delivering announcements as transient events.

For non-pub/sub signaling protocols, such as trackers that exchange offers in
bulk, `createStrategy` is available as a lower-level advanced API.

### Supabase setup

To use the Supabase strategy:

1. Create a [Supabase](https://supabase.com) project or use an existing one
2. On the dashboard, go to Project Settings -> API
3. Copy the Project URL and set that as the `appId` in the Trystero config, copy
   the `anon public` API key and set it as `relayConfig.supabaseKey` in the
   Trystero config

### Firebase setup

If you want to use the Firebase strategy and don't have an existing project:

1. Create a [Firebase](https://firebase.google.com/) project
2. Create a new Realtime Database
3. Copy the `databaseURL` and use it as the `appId` in your Trystero config

<details>
  <summary>
  Optional: configure the database with security rules to limit activity:
  </summary>

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

These rules ensure room peer presence is only readable if the room namespace is
known ahead of time.

</details>

## API

### `joinRoom(config, roomId)`

Adds local user to room whereby other peers in the same namespace will open
communication channels and send events. Calling `joinRoom()` while a room with
the same `(appId, roomId)` is already active throws an error—call `room.leave()`
before rejoining the same room.

- `config` - Configuration object containing the following keys:
  - `appId` - **(required)** A unique string identifying your app. When using
    Supabase, this should be set to your project URL (see
    [Supabase setup instructions](#supabase-setup)). If using Firebase, this
    should be the `databaseURL` from your Firebase config (also see
    `relayConfig.firebaseApp` below for an alternative way of configuring the
    Firebase strategy).

  - `password` - **(optional)** A string used to derive an AES-256-GCM signaling
    key via `PBKDF2-SHA256` (`600,000` iterations, salted with `appId` and
    `roomId`) as session descriptions are passed through the peering medium. If
    not set, session descriptions are encrypted with a key derived from the app
    ID and room name. A custom password must match between any peers in the room
    for them to connect; prefer high-entropy secrets for sensitive rooms. See
    [encryption](#encryption) for more details.

  - `maxUsers` - **(optional)** Positive integer setting a best-effort, advisory
    per-peer cap on the number of unique users (`userId`s) in the peer's room
    view at once (including the local user). When a peer's view is at capacity,
    additional joiners with a new `userId` are rejected on that peer link before
    activation and receive `{code: 'room-full'}` via `room.onError()`. See
    [room size limits](#room-size-limits) for more details.

  - `maxReceiveBytes` - **(optional)** Maximum payload size and budget for
    concurrent large incoming transfers per room, in bytes. Defaults to
    `256 * 1024 ** 2` (256 MiB). Must be a positive integer. Raise it for larger
    files or lower it to reduce memory use.

  - `passive` - **(optional)** Boolean for backup or relay peers that should
    listen for active peers without broadcasting room presence announcements.
    Passive peers respond directly to active peers that announce or send offers,
    so passive peers never discover or connect to each other, and can declare
    `room.makeState(...)` namespaces to cache and sync signed shared state for
    newcomers. For BitTorrent, passive rooms register with trackers as seeders
    (`left: 0`) without generating outgoing offers, which avoids
    passive-to-passive discovery while keeping tracker load low.

  - `identity` - **(optional)** Controls how the local user's `userId` is loaded
    and saved (see [User identity](#user-identity)):
    - `'local'` _(default in browsers)_ - Persists the user identity across tabs
      and future visits on the same device (scoped to `appId`) using IndexedDB
      with a non-extractable WebCrypto `CryptoKey`.
    - `'none'` _(default outside browsers)_ - Generates a fresh runtime `userId`
      that is discarded when the page reloads or process exits.
    - `UserIdentity | ((context: {appId: string, roomId: string}) => UserIdentity | Promise<UserIdentity>)` -
      Supplies a `UserIdentity` (from `createUserIdentity()` or
      `importUserIdentity()`) or a custom sync/async loader function. Custom
      `UserIdentity` objects are self-tested on load and must return a 64-byte
      IEEE P1363 (`r || s`) ECDSA P-256 SHA-256 signature from `sign(payload)`.

  - `use` - **(optional)** Array of built-in `RoomPlugin`s created with
    `roles()` and/or `scale()`. TypeScript automatically infers the extra
    methods added to the returned `Room` instance (`RoomWithPlugins`) from the
    plugins passed in `use` (`grantRole`, `revokeRole`, `getRoles`,
    `onRoleChange`, `ban`, `unban`, and `isBanned` from `roles()`, and
    `getTopology` from `scale()`). Including `roles()` also enables `{roles}`
    authorization options on `makeAction`, `makeState`, and `makeUserState`.
    Plugin methods are attached synchronously on `room`, while
    `await room.ready` (or `await room.getSelf()`) resolves once local identity
    and authority setup complete.

  - `relayConfig` - **(optional unless required by your chosen strategy)**
    Object containing strategy-specific relay settings:
    - `urls` - **(optional for 🌊 BitTorrent, 🐦 Nostr, 📡 MQTT; required for 🔌
      WebSocket relay)** Custom list of URLs for the strategy to use to
      bootstrap P2P connections. These would be BitTorrent trackers, Nostr
      relays, MQTT brokers, and WebSocket relays, respectively. Use secure
      `wss://` URLs in production (`ws://` is also supported for local
      `ws-relay` development). Relay sockets and MQTT clients are
      reference-counted across active rooms and close automatically when the
      last room calls `leave()`.

    - `redundancy` - **(optional, 🌊 BitTorrent, 🐦 Nostr, 📡 MQTT only)**
      Integer specifying how many default relay endpoints to connect to
      simultaneously. Passing a `urls` option will cause this option to be
      ignored as the entire list will be used.

    - `warnOnRelayFailure` - **(optional)** Boolean (default: `true`) that when
      set to `false` suppresses warnings caused by relay failures. This includes
      failed announce attempts and strategy-specific failure messages from
      relays or trackers.

    - `supabaseKey` - **(required, ⚡️ Supabase only)** Your Supabase project's
      `anon public` API key.

    - `firebaseApp` - **(optional, 🔥 Firebase only)** You can pass an already
      initialized Firebase app instance instead of an `appId`. Normally Trystero
      will initialize a Firebase app based on the `appId` but this will fail if
      you've already initialized it for use elsewhere.

    - `firebasePath` - **(optional, 🔥 Firebase only)** String specifying path
      where Trystero writes its matchmaking data in your database
      (`'__trystero__'` by default). Changing this is useful if you want to run
      multiple apps using the same database and don't want to worry about
      namespace collisions.

  - `rtcConfig` - **(optional)** Specifies a custom
    [`RTCConfiguration`](https://developer.mozilla.org/en-US/docs/Web/API/RTCConfiguration)
    for all peer connections.

  - `trickleIce` - **(optional)** Boolean controlling whether ICE candidates are
    sent incrementally (`true`) or bundled with SDP (`false`). Default is
    strategy-dependent: `true` for most strategies, `false` for BitTorrent
    unless explicitly set.

  - `turnConfig` - **(optional)** Specifies a custom list of TURN servers to use
    (see
    [Troubleshooting connection issues](#troubleshooting-connection-issues)).
    Each item in the list should correspond to an
    [ICE server config object](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/RTCPeerConnection#iceservers).
    When passing a TURN config like this, its servers are appended to
    `rtcConfig.iceServers` if provided, or to Trystero's default STUN servers
    otherwise. To opt out of Trystero's default STUN servers, pass a custom
    `rtcConfig.iceServers` list (or `[]` for TURN-only).

  - `rtcPolyfill` - **(optional)** Use this to pass a custom
    [`RTCPeerConnection`](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/RTCPeerConnection)-compatible
    constructor. This is useful for running outside of a browser, such as in
    Node (still experimental).

- `roomId` - A string to namespace peers and events within a room.

Returns an object with the following properties and methods (all `on*` event
subscription methods return an `Unsubscribe` function `() => void` and accept
optional `{once?: boolean, signal?: AbortSignal}` options):

- ### `ready`

  A `Promise<void>` that resolves once the local endpoint identity is
  initialized and any plugins passed in `config.use` are ready and have attached
  their methods to `room`. (`await room.getSelf()` also waits for `room.ready`.)

- ### `leave()`

  Remove local user from room and unsubscribe from room events (closing shared
  relay sockets or MQTT clients once the last active room on that relay leaves).

- ### `getSelf()`

  Returns a promise resolving to `SelfInfo` for the local participant in this
  room:
  - `peerId` - The 20-character Base62 endpoint ID.
  - `userId` - The local user's 22-character Base62 user ID.
  - `identityPersistence` - Effective storage tier
    (`'local' | 'custom' | 'none'`; `'none'` if browser storage downgraded to an
    ephemeral key).
  - `roomId` - The full room ID (including the `~<userId>` suffix when created
    with `roles({selfAsAdmin: true})`).
  - `baseRoomId` - The base room name without the `~<userId>` suffix.
  - `isAdmin` - Boolean indicating whether the local user is a verified
    `'admin'`.
  - `roles` - Array of verified roles currently held by the local user.

- ### `getUsers()`

  Returns a cached, frozen (`Object.freeze`) map of `UserInfo` objects
  (`{peerIds, roles}`) for the remote users present in the room (excluding the
  local user), keyed by `userId`:
  - `peerIds` - Frozen array of active `peerId`s currently connected for that
    user (e.g. when a user has multiple tabs open in the same room).
  - `roles` - Frozen array of verified roles currently held by that user.

- ### `getPeers()`

  Returns a map of `PeerInfo` objects
  (`{userId, connection, direct, hops, roles}`) for the individual peer
  connections present in the room (not including the local endpoint), keyed by
  `peerId`:
  - `userId` - The 22-character Base62 user ID that owns this endpoint.
  - `connection` - The underlying
    [`RTCPeerConnection`](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection)
    if the peer is a direct WebRTC neighbor, or `null` if the peer is routed
    across multiple hops in an overlay topology.
  - `direct` - Boolean (`true` for direct WebRTC peers, `false` for multi-hop
    overlay peers).
  - `hops` - Hop distance (`1` for direct peers, `>= 2` for multi-hop overlay
    peers).
  - `roles` - Array of verified roles currently held by that peer.

- ### `getTopology()`

  _(Added to `Room` when `scale(...)` is included in `use: [...]`; available
  after `await room.ready`)_ Returns a `TopologySnapshot` describing how peers
  in the room are currently connected and routing data: `peerId` (the local
  endpoint ID), `directPeerIds`, `roomPeerIds`, `routes`, and `stats`
  (`messagesSent`, `messagesReceived`, `messagesForwarded`, `duplicatesDropped`,
  `signatureFailures`).

- ### `makeState(namespace, [initialValue], [config])`

  Creates or retrieves a shared JSON state container (`SharedState<T>`)
  synchronously on `room`. Open to any room member when `roles()` is not loaded;
  defaults to `roles: ['admin']` (fail-closed) when `roles()` is included in
  `use: [...]`.
  - `namespace` - Unique non-empty name (<= 256 chars) for this shared state
    within the room.
  - `initialValue` - **(optional)** Initial JSON value before any update is
    received (defaults to `null`).
  - `config.maxBytes` - **(optional)** Maximum UTF-8 serialized JSON byte size
    per value (default: `16384`, maximum: `65536`).
  - `config.validate(next, context)` - **(optional)** Synchronous predicate
    returning `true` or `false` to validate candidate values locally and
    remotely (`context` is `{prev, peerId, userId, roles, timestamp}`). Prefer
    predicates on `next` (and author `roles` / `userId`) rather than strict
    transitions on `prev` when multiple writers can update concurrently.
  - `config.roles` - **(optional; requires `roles(...)` in `use`)** Role, array
    of roles, or `'*'` (open to any unbanned member inside a `roles()` room).
    Defaults to `['admin']` when `roles()` is loaded.

  Returns a `SharedState<T>` object with:
  - `get()` - Returns the current state value.
  - `set(nextOrUpdater)` - Synchronously updates local `get()` and fires local
    `onChange` listeners (deferring pre-`ready` optimistic apply only on
    role-gated namespaces until local roles resolve), then signs and broadcasts
    the new state value (or functional updater `(prev) => next`), coalescing
    rapid concurrent local calls over a 40 ms wire window. Rejects if the local
    user lacks permission, exceeds `maxBytes`, or fails `validate`.
  - `getMeta()` - Returns metadata about the latest update
    (`{prev, peerId, userId, roles, timestamp}`) or `null` if still at
    `initialValue`.
  - `onChange(callback, [options])` - Subscribes `(value, context) => void`
    whenever a verified state update is applied and returns an `Unsubscribe`
    function (`context` matches `getMeta()`). Accepts
    `{replay?: boolean, once?: boolean, signal?: AbortSignal}` (when
    `{replay: true}` is set and `getMeta() !== null`, synchronously invokes
    `callback` with the current value and metadata).

- ### `makeUserState(namespace, [initialValue], [config])`

  Creates or retrieves a per-user JSON state container (`UserState<T>`)
  synchronously on `room`, where each `userId` can only update or clear their
  own cryptographically signed slot.
  - `namespace` - Unique non-empty name (<= 256 chars) for this user state
    within the room (up to `32` published namespaces and `64 KiB` total per
    `userId`).
  - `initialValue` - **(optional)** Fallback JSON value returned by `get(id?)`
    when a user has not published or has cleared/left (defaults to `null`). A
    user's entry is presence-scoped: it remains readable _during_
    `room.onUserLeave` callbacks and is evicted immediately afterward.
  - `config.maxBytes` - **(optional)** Maximum UTF-8 serialized JSON byte size
    per user entry (default: `16384`, maximum: `65536`).
  - `config.validate(next, context)` - **(optional)** Synchronous predicate
    returning `true` or `false` (`context` is
    `{prev, peerId, userId, roles, timestamp, self, online, removed}`).
  - `config.roles` - **(optional; requires `roles(...)` in `use`)** Role, array
    of roles, or `'*'` restricting which users may publish to this user-state
    namespace (open to any unbanned member by default, even when `roles()` is
    loaded).

  Returns a `UserState<T>` object with:
  - `get([targetId])` - Returns the current value for `targetId` (`userId` or
    `peerId`), or the local user when called with zero arguments (`get()`);
    passing an explicit `undefined` or an unpublished ID returns `initialValue`.
  - `getAll()` - Returns a frozen, reference-stable
    `Readonly<Record<string, T>>` keyed by `userId` for all active published
    entries (including the local user once published).
  - `has([targetId])` - Returns `true` if `targetId` (or the local user when
    called with zero arguments `has()`) currently has a published entry
    (distinguishing an explicit `set(null)` from an unpublished `null` default;
    passing explicit `undefined` returns `false`).
  - `set(nextOrUpdater)` - Synchronously updates local `get()` / `getAll()` and
    fires local `onChange` (deferring pre-`ready` optimistic apply only on
    role-gated namespaces), then signs and publishes the local user's value (or
    functional updater `(prev) => next`), coalescing rapid local writes over 40
    ms and flushing initial values before `onUserJoin` fires on 1-hop peers.
  - `clear()` - Synchronously clears the local entry, resets `has()` to `false`,
    and publishes a signed tombstone removing the local user's entry across
    peers.
  - `getMeta([targetId])` - Returns `UserStateChangeContext<T>`
    (`{prev, peerId, userId, roles, timestamp, self, online, removed}`) for
    `targetId` (or the local user when called with zero arguments `getMeta()`),
    or `null` if unpublished or passed explicit `undefined`.
  - `onChange(callback, [options])` - Subscribes `(value, context) => void`
    (`value` is `undefined` when `context.removed === true` due to `clear()`,
    presence departure, or `ban()`) and returns an `Unsubscribe` function.
    Accepts `{replay?: boolean, once?: boolean, signal?: AbortSignal}`.

- ### `grantRole(targetId, role)`

  _(Added to `Room` when `roles(...)` is included in `use: [...]`; available
  after `await room.ready`)_ Grants `role` (a custom role name string or array
  of strings; `'admin'` is reserved for root room admins) to `targetId`
  (`peerId` or `userId`). Requires the local user to be a root `'admin'`.

- ### `revokeRole(targetId, [role])`

  _(Added to `Room` when `roles(...)` is included in `use: [...]`; available
  after `await room.ready`)_ Revokes `role` (or all granted custom roles if
  omitted) from `targetId` (`peerId` or `userId`). Requires the local user to be
  a root `'admin'`.

- ### `getRoles([targetId])`

  _(Added to `Room` when `roles(...)` is included in `use: [...]`; available
  after `await room.ready`)_ Returns a cached, frozen (`Object.freeze`) array of
  verified roles currently held by `targetId` (`peerId` or `userId`), or by the
  local user when called with zero arguments (`room.getRoles()`); passing an
  explicit `undefined` returns `[]`.

- ### `onRoleChange(callback, [options])`

  _(Added to `Room` when `roles(...)` is included in `use: [...]`; available
  after `await room.ready`)_ Subscribes a listener called whenever a user's
  verified role set changes (`grantRole`, `revokeRole`, `ban`, or anti-entropy
  sync) and returns an `Unsubscribe` function. Live-only by default; pass
  `{replay: true}` to synchronously emit currently held non-empty role sets to
  the new listener.
  - `callback({userId, roles, previousRoles, local})` - Called with the affected
    `userId`, their sorted `roles` and `previousRoles` arrays, and `local: true`
    when `userId` is the local user (`false` otherwise).
  - `options` - **(optional)**
    `{replay?: boolean, once?: boolean, signal?: AbortSignal}`.

- ### `ban(targetId, [options])`

  _(Added to `Room` when `roles(...)` is included in `use: [...]`; available
  after `await room.ready`)_ Bans `targetId` (`peerId` or `userId`) from the
  room (requires root `'admin'`). Immediately disconnects all endpoints
  belonging to that peer or user, clears any granted roles they held, purges any
  `makeState` or `makeUserState` records authored by that user, and blocks
  future connection offers or messages from them until `room.unban()` is called.
  - `options.reason` - **(optional)** Optional reason string for the ban (also
    surfaced to the banned user via `room.onError()` as
    `{code: 'banned', reason}`).

- ### `unban(targetId)`

  _(Added to `Room` when `roles(...)` is included in `use: [...]`; available
  after `await room.ready`)_ Lifts an active ban on `targetId` (`peerId` or
  `userId`) so they may rejoin the room (requires root `'admin'`). Roles cleared
  when the user was banned remain cleared unless re-granted with `grantRole()`.

- ### `isBanned(targetId)`

  _(Added to `Room` when `roles(...)` is included in `use: [...]`; available
  after `await room.ready`)_ Returns `true` if `targetId` (`peerId` or `userId`)
  has been banned from the room.

- ### `addStream(stream, [options])`

  Broadcasts or syncs a media stream to other peers and returns a
  `Promise<void>` that resolves once the stream has been offered to all matching
  targets. Calling `addStream` again with the same `MediaStream` is idempotent
  and syncs any added or removed tracks (`stream.addTrack()` /
  `stream.removeTrack()`) and updated `metadata`.
  - `stream` - A `MediaStream` with audio and/or video to send to peers in the
    room.

  - `options.target` - **(optional)** If specified, the stream is sent only to
    the target `peerId` or `userId` (string) or list of `peerId`s / `userId`s
    (array). Passing a `userId` fans out to all active tabs owned by that user.
    Passing `null` or omitting this option sends to all peers in the room.

  - `options.metadata` - **(optional)** Additional metadata (any serializable
    type) to be sent with the stream. This is useful when sending multiple
    streams so recipients know which is which (e.g. a webcam versus a screen
    capture). Re-calling `addStream(stream, {metadata})` with different metadata
    fires `onPeerStream` again on recipients with the updated metadata.

- ### `removeStream(stream, [options])`

  Stops sending previously sent media stream to other peers.
  - `stream` - A previously sent `MediaStream` to stop sending.

  - `options.target` - **(optional)** If specified, the stream is removed only
    from the target `peerId` or `userId` (string) or list of IDs (array).

- ### `replaceTrack(oldTrack, newTrack, [options])`

  Swaps a media track at the `RTCRtpSender` level without renegotiation and
  returns a `Promise<void>`.
  - `oldTrack` - The `MediaStreamTrack` to replace.

  - `newTrack` - A `MediaStreamTrack` to attach in its place.

  - `options.target` - **(optional)** If specified, the track is replaced only
    for the target `peerId` or `userId` (string) or list of IDs (array).

- ### `onUserJoin(callback, [options])`

  Subscribes a listener called when a remote user joins the room (fires on their
  **first** connected instance, and does not fire again if that same `userId`
  opens a second tab while already in the room) and returns an `Unsubscribe`
  function. Live-only by default; pass `{replay: true}` to synchronously emit
  currently active remote users to the new listener.
  - `callback({userId, peerId, roles})` - Called with the user's `userId`, the
    `peerId` of their joining instance, and their verified `roles`.
  - `options` - **(optional)**
    `{replay?: boolean, once?: boolean, signal?: AbortSignal}`.

  Example:

  ```js
  const unsub = room.onUserJoin(({userId}) => console.log(`${userId} joined`))
  ```

- ### `onUserLeave(callback, [options])`

  Subscribes a listener called when a remote user leaves the room (fires when
  their **last** remaining instance leaves, and does not fire if the user still
  has another tab open in the room) and returns an `Unsubscribe` function.
  - `callback({userId, peerId})` - Called with the departing user's `userId` and
    the `peerId` of their last instance.
  - `options` - **(optional)** `{once?: boolean, signal?: AbortSignal}`.

  Example:

  ```js
  room.onUserLeave(({userId}) => console.log(`${userId} left`))
  ```

- ### `onPeerJoin(callback, [options])`

  Subscribes a lower-level listener called whenever an individual peer
  connection (tab/device) joins the room and returns an `Unsubscribe` function.
  Live-only by default; pass `{replay: true}` to synchronously emit currently
  active peer connections to the new listener.
  - `callback({peerId, userId, roles})` - Function to run whenever a peer
    endpoint joins, called with the endpoint's `peerId`, `userId`, and verified
    `roles`.
  - `options` - **(optional)**
    `{replay?: boolean, once?: boolean, signal?: AbortSignal}`.

  Example:

  ```js
  room.onPeerJoin(({peerId}) => console.log(`tab ${peerId} connected`))
  ```

- ### `onPeerLeave(callback, [options])`

  Subscribes a lower-level listener called whenever an individual peer
  connection (tab/device) leaves the room and returns an `Unsubscribe` function.
  - `callback({peerId, userId})` - Function to run whenever a peer endpoint
    leaves, called with the endpoint's `peerId` and `userId`.
  - `options` - **(optional)** `{once?: boolean, signal?: AbortSignal}`.

  Example:

  ```js
  room.onPeerLeave(({peerId}) => console.log(`tab ${peerId} disconnected`))
  ```

- ### `onPeerStream(callback, [options])`

  Subscribes a listener called when a user sends a media stream (and again if
  the sender re-announces the stream with updated `metadata`) and returns an
  `Unsubscribe` function. Live-only by default; pass `{replay: true}` to
  synchronously emit currently active remote media streams and their latest
  metadata.
  - `callback(stream, {userId, peerId, metadata})` - Function to run whenever a
    user sends a media stream, called with the `MediaStream` first and a context
    object containing `userId`, `peerId`, and optional `metadata` (see
    `addStream()` above for details).
  - `options` - **(optional)**
    `{replay?: boolean, once?: boolean, signal?: AbortSignal}`.

  Example:

  ```js
  room.onPeerStream((stream, {userId, metadata}) =>
    console.log(`got stream from ${userId}`, stream, metadata)
  )
  ```

- ### `onError(callback, [options])`

  Subscribes a listener for asynchronous room, signaling, admission, moderation,
  plugin, and peer transport errors and returns an `Unsubscribe` function.
  Caller-initiated operations that return a `Promise` (such as `action.send()`,
  `action.request()`, `room.addStream()`, `state.set()`, or `room.ping()`)
  report failures by rejecting their returned `Promise` rather than duplicating
  into `onError`.
  - `callback(error)` - Called with a discriminated `RoomError` object
    (`{code, message, appId, roomId, cause?, ...}`). Switch on `error.code` to
    inspect structured fields:
    - `'room-full'` (`{peerId}`) - Refused during admission because the remote
      peer's room view has reached `config.maxUsers`.
    - `'banned'` (`{peerId?, reason?}`) - Disconnected mid-session or refused
      during handshake because an admin banned the local user (`reason` contains
      `options.reason` from `room.ban()` when provided).
    - `'decrypt-failed'` (`{peerId, stage: 'offer' | 'answer'}`) - Signaling
      payload failed decryption (usually an incorrect room `password`).
    - `'peer-connect-failed'` (`{peerId, turnConfigured}`) - Peers exchanged SDP
      over signaling, but WebRTC ICE could not establish a direct connection
      (usually means TURN servers are needed or misconfigured; see
      [Troubleshooting connection issues](#troubleshooting-connection-issues)).
    - `'relay-failed'` - All configured signaling relays failed initial
      connection or subscription without a single relay succeeding (individual
      relay blips in a redundant pool are retried quietly without firing
      `onError`).
    - `'identity-failed'` - Loading or initializing the local `identity` failed.
    - `'plugin-failed'` (`{plugin?}`) - A room plugin failed during
      initialization or runtime.
    - `'handshake-failed'` (`{peerId}`) - Peer identity/DTLS verification or
      admission handshake failed.
    - `'peer-error'` (`{peerId}`) - An active peer connection encountered an
      unrecoverable wire protocol or transport error and was disconnected.
  - `options` - **(optional)** `{once?: boolean, signal?: AbortSignal}`.

  Example:

  ```js
  room.onError(err => {
    switch (err.code) {
      case 'room-full':
        showBanner('This room is full.')
        break
      case 'banned':
        showBanner(`Removed from room${err.reason ? `: ${err.reason}` : ''}`)
        break
      case 'decrypt-failed':
        showBanner('Incorrect room password.')
        break
      case 'peer-connect-failed':
      case 'relay-failed':
        console.warn(err.message)
        break
    }
  })
  ```

- ### `makeAction(actionId, [config])`

  Listen for and send custom data actions.
  - `actionId` - A string to register this action consistently among all users.

  `config` accepts declarative action configuration only (`kind` and `roles`);
  register handlers via the action's `on*` methods. If `config.kind` is omitted,
  the action is a one-way message action. Passing `kind: 'request'` creates a
  request/response action.

  Message actions expose:
  - `send(data, [options])` - Sends data to users and resolves when local
    sending is complete. `options.target` accepts a `userId` (which fans out to
    all active tabs of that user), a `peerId`, or a non-empty array of either;
    all targets in a list are validated up front before transmitting, rejecting
    if any targeted user or peer is not connected (or if `target: []` is empty).
    To cancel an in-progress send, pass an `AbortController`'s `signal` in the
    options (e.g. `send(data, {signal: controller.signal})`) and call
    `controller.abort()`. Do not mutate binary buffers (`> 16 KiB`) passed to
    `send()` until its returned `Promise` settles.
  - `onMessage(callback, [options])` - Multi-listener method subscribing
    `(data, {userId, peerId, metadata, roles}) => void | Promise<void>` for
    received messages and returning an `Unsubscribe` function. Up to `32`
    inbound inline messages per sending peer per registered action (including
    role-gated or `onReceive`-gated actions, without consuming the concurrent
    transfer budget) are buffered for up to `10` seconds before the first
    listener attaches and drained in order when subscribed.
  - `onReceiveProgress(callback, [options])` - Multi-listener method subscribing
    `(percent, {userId, peerId, metadata}) => void` for inbound progress and
    returning an `Unsubscribe` function.

  Request actions expose:
  - `request(data, options)` - Sends to one user or tab (`options.target` can be
    a `userId` or `peerId`; when given a `userId`, it deterministically routes
    to one active tab of that user, preferring a direct 1-hop connection and
    breaking ties by lowest `peerId`) and resolves with its response (or rejects
    with an `ActionError` where `error.kind` is
    `'timeout' | 'disconnected' | 'aborted' | 'rejected'`).
  - `requestMany(data, options)` - Sends to many users or tabs
    (`options.targets` accepts `userId`s and/or `peerId`s) and resolves with
    labeled `PeerResult` items (`status: 'fulfilled'` with `value`,
    `status: 'rejected'` with `error: ActionError`, `status: 'timeout'`, or
    `status: 'disconnected'`).
  - `onRequest(callback, [options])` - Single-handler method registering
    `(data, {userId, peerId, metadata, signal, roles}) => response` and
    returning an `Unsubscribe` function. Throwing an `Error` inside `callback`
    rejects the caller's `request()` with `error.kind === 'rejected'` and
    forwards `error.message`. Throws an error if called while an `onRequest`
    handler is already active (unsubscribe first).
  - `onReceiveProgress(callback, [options])` - Multi-listener method subscribing
    `(percent, {userId, peerId, metadata}) => void` for inbound progress and
    returning an `Unsubscribe` function.

  Both kinds expose `onReceive(callback, [options])`, a single-handler method
  accepting `{byteLength, userId, peerId, metadata, kind, signal, roles}`,
  returning a boolean or a promise of a boolean, and returning an `Unsubscribe`
  function (call `unsubscribe()` to restore automatic acceptance; throws if
  another `onReceive` handler is already active). `kind` is `'message'`,
  `'request'`, or `'response'`; request actions apply it to both requests and
  responses. Responses have no metadata. See
  [receiving files](#receiving-files).

  Pass `config.roles` (`'admin'`, a custom role string, or an array of role
  strings; requires `roles(...)` in `joinRoom` config) to restrict who can send
  or make requests on this action. When set, messages from unauthorized senders
  are rejected and the verified sender's roles are passed as `roles` in the
  `onMessage` / `onRequest` context (`{userId, peerId, metadata, roles}`).

  Send options use `target`, `metadata`, `onProgress`, and `signal`. Request
  options use `target`, `metadata`, `timeoutMs`, `onProgress`, and `signal`.
  `requestMany()` uses `targets` plus optional `onResult` for each result as it
  arrives. Request timeouts cover approval, sending, and the response.

  Example:

  ```js
  const cursor = room.makeAction('cursormove')

  window.addEventListener('mousemove', e => cursor.send([e.clientX, e.clientY]))

  cursor.onMessage(([x, y], {userId}) => {
    const userCursor = cursorMap[userId]
    userCursor.style.left = x + 'px'
    userCursor.style.top = y + 'px'
  })
  ```

- ### `ping(targetId)`

  Takes a `userId` or `peerId` and returns a promise that resolves to the
  milliseconds the round-trip took. When given a `userId`, it deterministically
  pings one active endpoint of that user (matching `request()` target
  selection).
  - `targetId` - `userId` or `peerId` string of the target user or tab.

  Example:

  ```js
  // log round-trip time every 2 seconds
  room.onUserJoin(({userId}) =>
    setInterval(
      async () => console.log(`took ${await room.ping(userId)}ms`),
      2000
    )
  )
  ```

### `roles([config])`

Creates the opt-in room authority plugin (`RoomPlugin<'roles', RolesPluginApi>`)
for `joinRoom()`. Pass in `use: [roles(config)]`:

- `roles()` - Enables role and state verification for a participant joining a
  room (required when joining a self-certifying `<roomId>~<userId>`).
- `roles({selfAsAdmin: true})` - Makes the local user (`userId`) a root room
  admin and appends `~<userId>` to `roomId`. Uses persistent `'local'` identity
  by default in browsers; pair with a saved `UserIdentity` when running outside
  browsers.
- `roles({admins: [userId1, userId2]})` - Trusts the specified 22-character
  Base62 `userId`s as root room admins on either a fixed room name or alongside
  `selfAsAdmin: true`.

### `scale([config])`

Creates the experimental opt-in multi-hop scaling plugin
(`RoomPlugin<'scale', ScalePluginApi>`) for `joinRoom()`. Pass in
`use: [scale(config)]`, where `config` is an optional `ScaleConfig` object:

- `maxDirectPeers` - **(optional)** Target number of direct WebRTC neighbor
  connections maintained per peer (`4..32`, default: `6`; naturally forms a full
  mesh when `roomSize <= maxDirectPeers + 1`, and may temporarily exceed the
  target under burst joins or direct media/bulk promotions).

### `createUserIdentity()`

Returns a promise resolving to a fresh self-certifying ECDSA P-256
`UserIdentity` (`{userId, signPubJwk, sign, persistence}`). Use
`exportUserIdentity(identity)` to serialize its private key material if you want
to persist it in custom storage. Custom `UserIdentity` implementations passed to
`config.identity` are self-tested on load and must return a 64-byte IEEE P1363
ECDSA P-256 SHA-256 signature from `sign(payload)`.

### `importUserIdentity(input)`

Returns a promise resolving to a `UserIdentity` imported from an exported
`trystero_uk_...` string or a P-256 private `JsonWebKey`. Rejects if the input
is not valid P-256 key material.

### `exportUserIdentity(identity)`

Exports a `UserIdentity` (created via `createUserIdentity()` or
`importUserIdentity()`) as a compact `trystero_uk_...` string suitable for
persisting in custom storage. Throws if the identity is backed by
non-extractable browser storage (`'local'`).

### `clearUserIdentity(appId)`

Deletes the stored `'local'` `UserIdentity` in `IndexedDB` and clears in-memory
identity and endpoint caches for `appId`, returning a promise that resolves when
cleanup completes (other `appId`s on the same origin are unaffected). Applies to
subsequent `joinRoom()` calls—call `await room.leave()` first if already
connected.

### `getRelaySockets()`

**(🌊 BitTorrent, 🐦 Nostr, 📡 MQTT, 🔌 WebSocket relay only)** Returns an
object of currently active relay URL keys mapped to their WebSocket connections
(relays are closed automatically once all rooms using them call `leave()`). This
can be useful for determining the state of the user's connection to the relays
and handling any connection failures.

Example:

```js
import {getRelaySockets} from '@trystero-p2p/torrent'

console.log(getRelaySockets())
// => Object {
//  "wss://tracker.webtorrent.dev": WebSocket,
//  "wss://tracker.openwebtorrent.com": WebSocket
//  }
```

### `setRelayConnectivity(mode)`

**(🌊 BitTorrent, 🐦 Nostr, 🔌 WebSocket relay only)** Controls process-wide
relay socket connectivity (`'auto' | 'online' | 'offline'`) and returns the
current mode (also returned when called with no arguments).

```js
import {setRelayConnectivity} from 'trystero'

setRelayConnectivity('offline') // close relay sockets, cancel pending retries, hold reconnection
setRelayConnectivity('online') // reconnect now (reset backoff), stay under manual control
setRelayConnectivity('auto') // default: follow the browser's online/offline events
```

Calling `setRelayConnectivity('online')` or `setRelayConnectivity('offline')`
detaches the built-in browser `online`/`offline` watcher (manual mode), while
`'auto'` re-attaches it.

## Which strategy should I choose?

By default Trystero uses the Nostr network which is highly decentralized with
hundreds of active relays running. This is a good choice if you're interested in
decentralization and high redundancy. The other decentralized strategies are
recommended in the order of MQTT and BitTorrent, based on robustness. These
networks have far less relay redundancy than Nostr, but you might prefer them
for other reasons. You can of course host your own relay server for any of these
strategies.

For a middleground between using public relays and self-hosting, the built-in
Supabase and Firebase strategies are a good option.

### Bundle size

Approximate Brotli-compressed bundle sizes when bundled with a tree-shaking
bundler (`joinRoom` includes WebRTC signaling, encrypted actions, chunked binary
transfers, media streams, self-certifying `peerId`/`userId` identities, and
signed `makeState`/`makeUserState`):

| Package                  | `joinRoom` | `+ roles()` | `+ scale()` | `+ roles() + scale()` |
| ------------------------ | ---------: | ----------: | ----------: | --------------------: |
| `@trystero-p2p/ws-relay` |   ~36.1 KB |    ~40.8 KB |    ~46.6 KB |              ~51.3 KB |
| `@trystero-p2p/torrent`  |   ~36.8 KB |    ~41.5 KB |    ~47.2 KB |              ~52.0 KB |
| `trystero` / `.../nostr` |   ~40.8 KB |    ~45.4 KB |    ~51.2 KB |              ~55.9 KB |
| `@trystero-p2p/firebase` |   ~76.4 KB |    ~81.2 KB |    ~86.9 KB |              ~91.4 KB |
| `@trystero-p2p/supabase` |   ~80.3 KB |    ~85.0 KB |    ~90.7 KB |              ~95.4 KB |
| `@trystero-p2p/mqtt`     |  ~116.9 KB |   ~121.5 KB |   ~127.1 KB |             ~131.9 KB |

Apps using a bundler only pay for `roles()` (~4.7 KB) or `scale()` (~10.5 KB)
when imported; importing directly from a single-URL ESM CDN (such as `esm.run`)
loads the full package entry.

---

Trystero by [Dan Motzenbecker](https://oxism.com)
