# ✨🤝✨ Trystero

**Build instant multiplayer web apps, no server required**

👉 **[Try it live on trystero.dev](https://trystero.dev)** 👈

Trystero makes browsers discover each other and communicate directly. No
accounts. No deploying infrastructure. Just import and connect.

Peers can connect via 🌊 BitTorrent, 🐦 Nostr, 📡 MQTT, ⚡️ Supabase, 🔥Firebase,
🪐 IPFS, or a 🔌 self-hosted WebSocket relay – all using the same API.

Besides making peer matching automatic, Trystero offers some nice abstractions
on top of WebRTC:

- 👂📣 Rooms / broadcasting
- 🔢📩 Automatic serialization / deserialization of data
- 🎥🏷 Attach metadata to binary data and media streams
- ✂️⏳ Automatic chunking and throttling of large data
- ⏱🤞 Progress events and promises for data transfers
- 🔐📝 Session data encryption
- 🪪🔑 Self-certifying peer & user identities with multi-tab presence
- 🚪🎟️ Room size limits for 1v1 matches and capped lobbies
- 🕸️🚀 Automatic scaling for large rooms with dozens or hundreds of peers
- 👑🛡️ Room admins, custom roles, peer banning, and shared state
- 🏭⚡ Can run peers server-side on Node, Bun, and Deno
- ⚛️🪝 React hooks

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
- [Advanced](#advanced)
  - [Binary metadata](#binary-metadata)
  - [Receiving files](#receiving-files)
  - [Action promises](#action-promises)
  - [Progress updates](#progress-updates)
  - [Encryption](#encryption)
  - [Room size limits](#room-size-limits)
  - [Room admins, roles, and authoritative state](#room-admins-roles-and-authoritative-state)
  - [Scaling large rooms](#scaling-large-rooms)
  - [Custom room plugins](#custom-room-plugins)
  - [React hooks](#react-hooks)
  - [Troubleshooting connection issues](#troubleshooting-connection-issues)
  - [Running server-side (Node, Bun, Deno)](#running-server-side-node-bun-deno)
  - [Self-hosted WebSocket relay](#self-hosted-websocket-relay)
  - [Write your own strategy](#write-your-own-strategy)
  - [Supabase setup](#supabase-setup)
  - [Firebase setup](#firebase-setup)
- [API](#api)
  - [`joinRoom(config, roomId, [callbacks])`](#joinroomconfig-roomid-callbacks)
  - [`roles([config])`](#rolesconfig)
  - [`scale([config])`](#scaleconfig)
  - [`definePlugin(name, spec)`](#definepluginname-spec)
  - [`createUserIdentity()`](#createuseridentity)
  - [`importUserIdentity(input)`](#importuseridentityinput)
  - [`exportUserIdentity(identity)`](#exportuseridentityidentity)
  - [`createAdminRoom(baseRoomId, [options])`](#createadminroombaseroomid-options)
  - [`getRelaySockets()`](#getrelaysockets)
  - [`pauseRelayReconnection()`](#pauserelayreconnection)
  - [`resumeRelayReconnection()`](#resumerelayreconnection)
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
BitTorrent, Nostr, MQTT, Supabase, Firebase, IPFS, and self-hosted WebSocket
relay).

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

> **Note:** Prebuilt `.min.js` bundles (`dist/trystero-*.min.js`) are
> deprecated. Use a package manager with a modern tree-shaking bundler (Vite,
> Rollup, esbuild, webpack, etc.) or an ESM CDN like `esm.run` so optional
> plugins such as `roles()` and `scale()` are only included in your bundle when
> imported.

The default Trystero package runs on the Nostr network, but you can swap in any
other stategy by changing which package you import:

```js
import {joinRoom} from '@trystero-p2p/mqtt'
// or
import {joinRoom} from '@trystero-p2p/torrent'
// or
import {joinRoom} from '@trystero-p2p/supabase'
// or
import {joinRoom} from '@trystero-p2p/firebase'
// or
import {joinRoom} from '@trystero-p2p/ipfs'
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
room.onUserJoin = ({userId}) => console.log(`${userId} joined`)
```

Listen for users leaving the room:

```js
room.onUserLeave = ({userId}) => console.log(`${userId} left`)
```

Listen for users sending their audio/video streams:

```js
room.onPeerStream = (stream, {userId}) =>
  (userElements[userId].video.srcObject = stream)
```

To unsubscribe from events, leave the room:

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
drink.onMessage = (data, {userId}) =>
  console.log(
    `got a ${data.drink} with${data.withIce ? '' : 'out'} ice from ${userId}`
  )
```

Actions can also use request/response semantics:

```js
const isEven = room.makeAction('is-even', {
  kind: 'request',
  onRequest: n => n % 2 === 0
})

const result = await isEven.request(42, {
  target: friendId,
  timeoutMs: 1000
})
```

To ask multiple users at once, use `requestMany()`. It resolves with a labeled
result for every target, while `onResult` lets you react as each user answers:

```js
const availability = room.makeAction('availability', {
  kind: 'request',
  onRequest: ({date}) => calendar.isFree(date)
})

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

// binary data is received as raw ArrayBuffers so your handling code should
// interpret it in a way that makes sense
pic.onMessage = (data, {userId}) =>
  (imgs[userId].src = URL.createObjectURL(new Blob([data])))
```

Let's say we want users to be able to name themselves:

```js
const idsToNames = {}
const name = room.makeAction('name')

// tell new users your name when they connect
room.onUserJoin = ({userId}) => name.send('Oedipa', {target: userId})

// listen for users naming themselves
name.onMessage = (value, {userId}) => (idsToNames[userId] = value)

// tell all users at once when your name changes
nameInput.addEventListener('change', e => name.send(e.target.value))

room.onUserLeave = ({userId}) =>
  console.log(`${idsToNames[userId] || 'a weird stranger'} left`)
```

> Actions are smart and handle serialization and chunking for you behind the
> scenes. This means you can send very large files and whatever data you send
> will be received on the other side as the same type (a number as a number, a
> string as a string, an object as an object, binary as binary, etc.). See
> [receiving files](#receiving-files) for optional size limits and acceptance
> callbacks.

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
room.onUserJoin = ({userId}) => room.addStream(selfStream, {target: userId})

// handle streams from other users
room.onPeerStream = (stream, {userId}) => {
  // create an audio instance and set the incoming stream
  const audio = new Audio()
  audio.srcObject = stream
  audio.autoplay = true

  // add the audio to userAudios object if you want to address it for something
  // later (volume, etc.)
  userAudios[userId] = audio
}
```

Doing the same with video is similar, just be sure to add incoming streams to
video elements in the DOM:

```js
const userVideos = {}
const videoContainer = document.getElementById('videos')

room.onPeerStream = (stream, {userId}) => {
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
}
```

## User identity

Every user in Trystero gets a unique, unforgeable `userId` out of the box—no
accounts, login screens, or backend servers required. Because every `userId` is
cryptographically verified during connection setup, no one can spoof or hijack
another user's ID.

### Semi-ephemeral by default, persistent with a one-line change

By default in the browser, `userId` is **semi-ephemeral**
(`identity: 'session'`): if a user refreshes the page, they come right back with
the same `userId`, and closing the tab starts fresh next time.

If you want users to keep the same `userId` across all open tabs and future
visits on that device, set `identity: 'local'`:

```js
const room = joinRoom(
  {
    appId: 'co-op-RPG',
    identity: 'local'
  },
  'tavern-1'
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

| `identity` value                        | `userId` lifetime                                                                                                                 |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `'session'` _(browser default)_         | Reused across page reloads in the same tab (`sessionStorage`), reset when the tab closes.                                         |
| `'local'`                               | Reused across all open tabs and future visits on the same device (`IndexedDB` / `localStorage`) until browser storage is cleared. |
| `'none'` _(non-browser default)_        | Ephemeral for the current runtime; a reload or process restart generates a new `userId`.                                          |
| Custom (`UserIdentity` or async loader) | Controlled by your app (imported via `importUserIdentity()` from your backend or disk in Node/Bun/Deno).                          |

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
  keypair (`peerId`, a 20-character Base62 digest `sha256(pubJwk) mod 62²⁰`)
  alongside the user's ECDSA P-256 identity keypair (`userId`, a 43-character
  Base64url [RFC 7638](https://www.rfc-editor.org/rfc/rfc7638.html) JWK
  thumbprint). Because `peerId` and `userId` have distinct formats and lengths,
  any `target` option unambiguously recognizes which one you passed.
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
  `CryptoKey` (with `localStorage` fallback).

</details>

## Advanced

### Binary metadata

Let's say your app supports sending various types of files and you want to
annotate the raw bytes being sent with metadata about how they should be
interpreted. Instead of manually adding metadata bytes to the buffer you can
simply pass a metadata argument in the sender action for your binary payload:

```js
const file = room.makeAction('file')

file.onMessage = (data, {userId, metadata}) =>
  console.log(
    `got a file (${metadata.name}) from ${userId} with type ${metadata.type}`,
    data
  )

file.send(buffer, {
  metadata: {name: 'The Courierʼs Tragedy', type: 'application/pdf'}
})
```

### Receiving files

Incoming data is accepted automatically. Use `onReceive` to accept or decline
payloads based on their size, sender, or metadata:

```js
const file = room.makeAction('file', {
  onReceive: ({byteLength}) => byteLength <= 100 * 1024 ** 2,
  onMessage: (data, {metadata}) => saveFile(data, metadata.name)
})
```

Return `true` or `false`, or a promise of either. Large payloads wait for
approval before sending their contents; declined small messages are discarded
after arrival. You can also assign `file.onReceive` later or set it to `null` to
restore automatic acceptance.

`byteLength` is the payload size in bytes (UTF-8 for strings/JSON), excluding
metadata. The context's `signal` aborts when the transfer ends; use it to
dismiss pending approval UI.

Each room defaults to a 256 MiB receive budget. Set `maxReceiveBytes` in the
room config to allow larger files or reduce memory use. Concurrent transfers
queue automatically when the budget is occupied. Received files must fit in
memory.

### Action promises

Sender promises resolve when local sending finishes; they do not confirm
delivery or application handling. If a receiver declines a large transfer, the
promise rejects with `error.kind === 'rejected'`. Use request actions when you
need a response.

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

file.onReceiveProgress = (percent, {userId, metadata}) =>
  console.log(
    `${percent * 100}% done receiving ${metadata.filename} from ${userId}`
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
match for all users in the room for them to be able to connect. An example use
case might be a private chat room where users learn the password via external
means.

### Room size limits

Sometimes your app has a strict maximum number of seats per room. For example,
you might be building:

- **A 2-player board game** (like chess or Battleship) where a third person
  opening the invite link shouldn't be able to barge into an active match.
- **A 4-player co-op lobby** that locks once all four party slots are taken.
- **A private 1-on-1 video call** where only two people can be in the room at a
  time.

To cap how many unique users (`userId`s, including the local user) can be in a
room at once, pass `limit` in your `joinRoom()` config and listen for
`'room full'` in `onJoinError`:

```js
const room = joinRoom(
  {
    appId: 'chess-club',
    limit: 2 // max 2 players in the room (you + 1 opponent)
  },
  'match-42',
  {
    onJoinError: ({error}) => {
      if (error === 'room full') {
        showBanner('Sorry, this match is already full!')
      }
    }
  }
)
```

When a room is already at capacity:

- Any extra user who tries to join receives `error: 'room full'` in
  `onJoinError` and that peer connection is closed before activation.
- Because `limit` counts unique `userId`s rather than raw tabs, an admitted
  player who refreshes the page shares their existing seat. Use `'local'`
  identity or an explicitly shared identity to share that seat across tabs.
- Existing players in the room are never interrupted—`onPeerJoin` and
  `onPeerLeave` won't fire for someone who was turned away at the door.
- If one of the current players leaves (`room.leave()` or closes their last
  tab), a seat immediately opens back up for the next person who joins.

<details>
  <summary>How it works behind the scenes</summary>

- **Pre-activation admission control**: Capacity checks run during the internal
  admission handshake (after `userId` verification) before a peer is ever added
  to `getPeers()` or triggers `onPeerJoin`. If the room is already full for a
  new `userId`, existing members immediately send a `'room full'` rejection and
  close that pending peer connection.
- **Password privacy**: In password-protected rooms (`config.password`),
  Trystero verifies the password proof _before_ checking room capacity. Users
  with the wrong password receive a password error rather than `'room full'`, so
  outsiders cannot probe whether a private room is full.
- **Simultaneous burst joins**: What if 5 players click "Join" at the exact same
  millisecond on an empty `limit: 2` room? Peers include their join metadata
  (join timestamp `t` and established member status) in their handshake
  readiness packet and coalesce concurrent arrivals over a short 25ms window.
  Every peer deterministically selects the same winning `userId`s (established
  member > earliest join timestamp > peer ID tie-breaker) and turns away the
  excess joiners with `'room full'`.
- **Multi-hop rooms**: When `scale()` is enabled, capacity checks also account
  for verified multi-hop overlay peers across `'gossip'` and `'broadcast'`
  topologies.

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
    identity: 'local',
    use: [roles({selfAsAdmin: true})]
  },
  'friday-quiz'
)
const {roomId} = await hostRoom.getSelf()

// Share `roomId` (e.g. "friday-quiz.~9fX2kLm8pQr7vBn3") in an invite link for friends!
```

When you pass `roles({selfAsAdmin: true})`, Trystero attaches a `.~` separator
and a 16-character Base62 suffix to your room name (like
`'friday-quiz.~9fX2kLm8pQr7vBn3'`) derived from the host's `userId`. Think of
that suffix as a built-in digital ID badge for the host.

When friends join using that self-certifying `roomId`, they simply include
`use: [roles()]` in `joinRoom()`—their browsers automatically check the suffix
and recognize the host's `userId` as the true admin (joining a fingerprinted
`<roomId>.~<fingerprint>` without `roles()` throws an error so misconfigured
clients fail fast):

```js
// Guests join using the shared roomId with use: [roles()]
const guestRoom = joinRoom({appId: 'trivia-night', use: [roles()]}, roomId)
```

> **Important:** Because a fingerprinted room's root admin authority is tied
> permanently to the host's `userId` key, always pair `selfAsAdmin: true` with
> `identity: 'local'` or a saved `UserIdentity` (from `createUserIdentity()` /
> `importUserIdentity()`). With the default browser `identity: 'session'`,
> refreshing the tab keeps your admin key, but closing the tab discards it—which
> would leave the fingerprinted room without a root admin if you ever needed to
> rejoin later. Trystero logs a warning if `selfAsAdmin: true` is used with an
> ephemeral identity. You can also generate the `roomId` ahead of time before
> calling `joinRoom()` using `await createAdminRoom('friday-quiz')`.

#### 2. Specifying admin `userId`s (fixed room names or co-admins)

What if you want a permanent, memorable room name like `'main-stage'` without a
`.~<fingerprint>` suffix at the end—or want to designate additional co-admins?

Pass `admins: [...]` with the trusted admin `userId`s to `roles()`. When an
admin joins with their matching `identity`, they are automatically recognized as
`'admin'`, and regular participants automatically trust updates and role grants
signed by those `userId`s:

```js
import {joinRoom, roles} from 'trystero'

const HOST_USER_ID = 'tY8mK3pQvN2xR7wL9jB4cF6hZ1sD5gA0eU8iO2uP4yM'

// Everyone (both the host and viewers) can use the exact same config!
// If the local user's userId matches HOST_USER_ID, they are the admin;
// otherwise they join as a regular participant who trusts HOST_USER_ID.
const room = joinRoom(
  {
    appId: 'town-hall',
    identity: 'local',
    use: [roles({admins: [HOST_USER_ID]})]
  },
  'main-stage'
)
```

You can also combine `{selfAsAdmin: true, admins: [CO_HOST_USER_ID]}` to create
a fingerprinted room while trusting additional co-admins from the start.

#### Restricting actions to admins or custom roles

For example, in a game where anyone can send chat messages, you might want an
`'announce'` action that only the `'admin'` or a `'moderator'` is allowed to
send. Just pass `roles` when creating the action:

```js
const announce = room.makeAction('announce', {
  roles: ['admin', 'moderator'],
  onMessage: (data, {userId, roles}) => {
    console.log(`Verified ${roles.join(', ')} (${userId}) announced:`, data)
  }
})

// Only succeeds if the local user is an 'admin' or 'moderator'
await announce.send({text: 'Round 2 starts now!'})
```

If a regular user tries to call `announce.send(...)` from the browser console,
Trystero blocks it locally—and even if they modified their client code to send a
fake packet, every other peer in the room will automatically reject it.

#### Keeping a shared "source of truth" (`room.makeState`)

Many apps need official room state that everyone can read, but only the host or
authorized roles can update—like the current question in a quiz game, the active
video URL in a watch party, or the current slide in a presentation.

With `room.makeState()` (enabled when `roles()` is passed to `joinRoom()`),
whenever an authorized user updates the state, every user in the room receives
the verified update. Better yet, **if a new user joins the room late—or even
after the host has closed their laptop and left—existing users in the room
automatically sync the latest official state to the newcomer** without being
able to tamper with it:

```js
const roundState = room.makeState(
  'round-state',
  {round: 1, phase: 'lobby'},
  {
    roles: ['admin', 'host'],
    // Optional rule: prevent the round number from ever going backward
    validate: (next, prev) => next.round >= prev.round
  }
)

// Anyone can read the current official state at any time
console.log(roundState.get())

// Listen for official state updates
roundState.onChange = (value, prev, {userId, roles}) => {
  console.log(`Updated by ${userId} (${roles}):`, value)
}

// Only an 'admin' or 'host' can update the state
await roundState.set(prev => ({round: prev.round + 1, phase: 'active'}))
```

#### Promoting moderators and banning spammers

During a live session, an admin can promote other users in the room to custom
roles (like `'moderator'` or `'dj'`), revoke those roles later, or permanently
ban a disruptive user from the room:

```js
// Promote a user to 'moderator' for 1 hour (and let them promote others too)
await room.grantRole(userId, 'moderator', {
  canDelegate: true,
  expiresInMs: 60 * 60 * 1000
})

// Check which verified roles a user currently has
console.log(room.getRoles(userId)) // => ['moderator']

// Remove the 'moderator' role from a user
await room.revokeRole(userId, 'moderator')

// As an admin, kick and ban a disruptive user from the room
await room.ban(maliciousUserId, {reason: 'spam'})
```

Delegators may revoke only roles they still hold. Revoked or banned admins
cannot issue new moderation commands. Only the root authority can issue root
admin certificates.

<details>
  <summary>How it works behind the scenes</summary>

- **Zero-trust public-key signatures**: Room authority is unified directly with
  each user's WebCrypto ECDSA P-256 `UserIdentity` (`userId`). Private keys
  never leave the user's device. Every privileged action, state update, role
  grant, or ban is signed with the sender's private key and verified by every
  peer before being accepted.
- **Self-certifying room IDs**: Both a user's 43-character Base64url `userId`
  and a self-certifying room's 16-character Base62 suffix
  (`<baseRoomId>.~<16-char-base62>`) are derived from the exact same SHA-256
  thumbprint of the user's P-256 public key. When you create a room with
  `roles({selfAsAdmin: true})`, Trystero encodes the first 96 bits of your
  `userId` digest into the room ID suffix after `.~`. When peers connect—or when
  the host rejoins with the same persistent identity—everyone can mathematically
  verify from the `userId` alone who owns the room.
- **Delegated certificate chains**: Calling `room.grantRole()` issues a signed
  `RoleCertificate` binding the recipient's `peerId`, `userId`, and public key
  to the granted role(s), optional expiration timestamp, and `canDelegate` flag.
  Because the certificate binds `subUserId`, a promoted user retains their roles
  across page reloads and multiple open tabs by presenting a signed `userProof`
  linking their new endpoint `peerId` to their `userId`. Peers verify the full
  signature chain back to a root admin key and check against signed
  `RoleRevocationRecord`s. Likewise, `room.ban()` bans both the target `peerId`
  and `userId` across all current and future tabs.
- **Tamper-proof state syncing (`makeState`)**: Each state update is signed with
  a monotonically increasing sequence number (`seq`) and chained to the SHA-256
  hash of the previous state record (`prevHash`, verified for successive updates
  from the same writer). This prevents replay attacks and lets any regular peer
  cache and serve the latest state snapshot to late joiners—the newcomer simply
  verifies the writer's signature on the snapshot. Concurrent updates across
  co-admins converge deterministically using last-writer-wins ordering
  `(epoch, seq, timestamp, hash)`.
- **Edge filtering & private signaling**: In multi-hop topologies, immediate
  neighbors (Hop-1 relays) verify role certificates, signatures, and
  `PeerBanRecord`s before forwarding packets, stopping unauthorized traffic or
  banned peers at the edge. Role certificates and ban records are exchanged only
  over encrypted WebRTC data channels after connecting so user IDs and ban
  metadata are never exposed to signaling relays.

</details>

### Scaling large rooms

Normally in WebRTC, every browser in a room opens a direct connection to every
other browser (`'mesh'`). That works great for small groups (and keeps your
bundle size minimal when you don't need multi-hop routing), but once a room
grows past a dozen people—like a busy game lobby, a collaborative canvas with 50
cursors, or a live watch party—maintaining that many connections at once can
slow down or overwhelm a user's browser.

**Opt into automatic scaling with `scale()`:**

```js
import {joinRoom, scale} from 'trystero'

const room = joinRoom({appId: 'massive-canvas', use: [scale()]}, 'lobby-1')
```

When you include `use: [scale()]` (which defaults to `'auto'` mode):

- When a room is small (`12` peers or fewer), everyone connects directly to
  everyone else for the lowest possible latency.
- If more people join, Trystero automatically switches the room to a scalable
  `'gossip'` relay network where each browser only maintains a handful of direct
  connections (`maxConnections: 6` by default) and passes messages and media
  streams along to the rest of the room.

All of your code (`makeAction`, `makeState`, `addStream`, `addTrack`, `ping`,
`onUserJoin`, `onUserLeave`, and `getUsers()`) works the exact same way no
matter how many people are in the room or whether two users are connected
directly or through other peers.

Broadcast media travels through the relay tree. Targeted media establishes a
direct WebRTC connection to each selected endpoint, so other participants do not
receive or relay its audio/video. These connections can exceed the overlay's
`maxConnections` target and remain available until the peer or room disconnects.
Await the promises returned by `addStream`, `addTrack`, and `replaceTrack` to
handle connection failures.

You can customize how `scale()` connects peers by passing a mode string or
config object:

- `'auto'` _(default when `scale()` is called with no arguments)_ – Best for
  most large-room apps. Uses direct connections for small groups and
  automatically switches to `'gossip'` when a room exceeds `autoThreshold`
  (default: `12` peers).
- `'gossip'` – Always uses the bounded-degree gossip relay network, even in
  small rooms. Useful when building a massive multiplayer world or public town
  square where you want every user's connection count capped from the start.
- `'broadcast'` – Organizes peers into a branching broadcast tree. Ideal when
  one or a few hosts are streaming video, audio, or live updates to a large
  audience (like a webinar, live DJ set, or stage presentation).
- `'mesh'` – Everyone always connects directly to everyone else (the default
  when `scale()` is omitted).

```js
// Example: a live stage app where a presenter streams video to a large audience
const room = joinRoom(
  {
    appId: 'live-stage',
    use: [scale('broadcast')]
  },
  'main-hall'
)
```

You can also fine-tune connection limits by passing an object to `scale()`:

```js
const room = joinRoom(
  {
    appId: 'massive-canvas',
    use: [
      scale({
        mode: 'auto',
        autoThreshold: 12, // switch to 'gossip' above 12 peers
        maxConnections: 6, // target direct WebRTC connections per peer
        fanout: 3 // downstream children per node in broadcast trees
      })
    ]
  },
  'lobby-1'
)
```

At any time, you can call `room.getTopology()` to see which mode is active,
which peers are connected directly vs. through relays, and how data and media
streams are being routed.

<details>
  <summary>How it works behind the scenes</summary>

- **Gossip overlay (`'gossip'`)**: Peers arrange themselves by ID on a
  bounded-degree circulant ring with deterministic multi-scale logarithmic
  chords, keeping the network diameter to $O(\log N)$ hops even as rooms grow to
  hundreds of peers. Routing tables require mutual neighbor confirmation in
  signed link-state descriptors before using an edge. Broadcasts use a
  Plumtree-style epidemic push tree combined with lazy `ihave`/`iwant` gossip
  repair so messages reach every peer reliably without flooding redundant
  copies. Point-to-point messages (`target`) route along shortest paths with
  disjoint backup next-hops for instant failover.
- **Broadcast trees (`'broadcast'` and media streaming)**: In `'broadcast'`
  mode—and whenever any peer calls `addStream()` without `target` in `'gossip'`
  mode—Trystero builds a deterministic $k$-ary application-layer multicast (ALM)
  tree rooted at the broadcaster. Each internal peer decodes the incoming stream
  and forwards the `MediaStreamTrack`s to its downstream children (`fanout: 3`
  by default), so a broadcaster can stream audio or video to dozens of viewers
  while only uploading to 3 peers. Targeted media (`addStream` with `target`)
  establishes a direct 1-hop WebRTC connection to each selected peer instead of
  traversing relays.
- **End-to-end data security across hops**: For data channels, every peer
  automatically generates an ephemeral WebCrypto signing keypair (ECDSA P-256)
  and encryption keypair (ECDH P-256). Link-state descriptors and data
  broadcasts are digitally signed and verified against self-certifying `peerId`
  keys so intermediate relays cannot forge or alter messages, and targeted data
  messages (`target`) are end-to-end encrypted with AES-GCM so intermediate
  relays cannot read them.

</details>

### Custom room plugins

Both `roles()` and `scale()` are built on Trystero's opt-in room plugin standard
(`definePlugin`), which you can also use to author tree-shakeable 1st- or
3rd-party extensions (such as CRDT bindings like Yjs/Automerge, custom
telemetry, or state sync adapters) with full TypeScript return-type inference:

```js
import {joinRoom, definePlugin} from 'trystero'

const myPlugin = (options = {}) =>
  definePlugin('myPlugin', {
    setup(kernel) {
      const sync = kernel.makeInternalAction('@_my_sync')
      kernel.onLeave(() => {
        // clean up resources when room.leave() is called
      })
      // Any methods returned here are merged onto the Room instance (and inferred in TypeScript)
      return {
        syncNow: data => sync.send(data)
      }
    }
  })

const room = joinRoom(
  {
    appId: 'collab-doc',
    use: [myPlugin()]
  },
  'doc-1'
)
```

### React hooks

Trystero functions are idempotent so they already work out of the box as React
hooks.

Here's a simple example component where each user syncs their favorite color to
everyone else:

```jsx
import {joinRoom} from 'trystero'
import {useState} from 'react'

const trysteroConfig = {appId: 'thurn-und-taxis'}

export default function App({roomId}) {
  const room = joinRoom(trysteroConfig, roomId)
  const colorAction = room.makeAction('color')
  const [myColor, setMyColor] = useState('#c0ffee')
  const [userColors, setUserColors] = useState({})

  // whenever new users join the room, send my color to them:
  room.onUserJoin = ({userId}) => colorAction.send(myColor, {target: userId})

  // listen for users sending their colors and update the state accordingly:
  colorAction.onMessage = (color, {userId}) =>
    setUserColors(userColors => ({...userColors, [userId]: color}))

  const updateColor = e => {
    const {value} = e.target

    // when updating my own color, broadcast it to all users:
    colorAction.send(value)
    setMyColor(value)
  }

  return (
    <>
      <h1>Trystero + React</h1>

      <h2>My color:</h2>
      <input type="color" value={myColor} onChange={updateColor} />

      <h2>User colors:</h2>
      <ul>
        {Object.entries(userColors).map(([userId, color]) => (
          <li key={userId} style={{backgroundColor: color}}>
            {userId}: {color}
          </li>
        ))}
      </ul>
    </>
  )
}
```

Astute readers may notice the above example is simple and doesn't consider if we
want to change the component's room ID or unmount it. For those scenarios you
can use this simple `useRoom()` hook that unsubscribes from room events
accordingly:

```js
import {joinRoom} from 'trystero'
import {useEffect, useRef} from 'react'

export const useRoom = (roomConfig, roomId) => {
  const roomRef = useRef(joinRoom(roomConfig, roomId))
  const lastRoomIdRef = useRef(roomId)

  useEffect(() => {
    if (roomId !== lastRoomIdRef.current) {
      roomRef.current.leave()
      roomRef.current = joinRoom(roomConfig, roomId)
      lastRoomIdRef.current = roomId
    }

    return () => roomRef.current.leave()
  }, [roomConfig, roomId])

  return roomRef.current
}
```

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
  {appId: 'your-app-id', rtcPolyfill: RTCPeerConnection},
  'your-room-name'
)
```

### Self-hosted WebSocket relay

If you want a tiny relay that you control, use the WebSocket relay package.
Start the relay on Node, Bun, or Deno:

```js
import {createWsRelayServer} from '@trystero-p2p/ws-relay/server'

createWsRelayServer({port: 8080})
```

Then in the browser:

```js
import {joinRoom} from '@trystero-p2p/ws-relay'

const room = joinRoom(
  {
    appId: 'app-id',
    relayConfig: {
      urls: ['wss://localhost:8080']
    }
  },
  'room-id'
)
```

The `relayConfig.urls` config option is required for this strategy because there
are no public default servers. You can pass multiple.

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

### `joinRoom(config, roomId, [callbacks])`

Adds local user to room whereby other peers in the same namespace will open
communication channels and send events. Calling `joinRoom()` multiple times with
the same namespace will return the same room instance.

- `config` - Configuration object containing the following keys:
  - `appId` - **(required)** A unique string identifying your app. When using
    Supabase, this should be set to your project URL (see
    [Supabase setup instructions](#supabase-setup)). If using Firebase, this
    should be the `databaseURL` from your Firebase config (also see
    `relayConfig.firebaseApp` below for an alternative way of configuring the
    Firebase strategy).

  - `password` - **(optional)** A string to encrypt session descriptions via
    AES-GCM as they are passed through the peering medium. If not set, session
    descriptions will be encrypted with a key derived from the app ID and room
    name. A custom password must match between any peers in the room for them to
    connect. See [encryption](#encryption) for more details.

  - `limit` - **(optional)** Positive integer capping the maximum total number
    of unique users (`userId`s) allowed in the room at once (including the local
    user). When the room is full, additional joiners with a new `userId` are
    rejected on that peer link before activation and receive
    `error: 'room full'` via `onJoinError`. See
    [room size limits](#room-size-limits) for more details.

  - `maxReceiveBytes` - **(optional)** Maximum payload size and budget for
    concurrent large incoming transfers per room, in bytes. Defaults to
    `256 * 1024 ** 2` (256 MiB). Must be a positive integer. Raise it for larger
    files or lower it to reduce memory use.

  - `passive` - **(optional)** Boolean for backup or relay peers that should
    listen for active peers without announcing themselves while a room is
    dormant. Passive peers activate only after hearing a non-passive peer and
    include a passive flag in their signaling so passive peers do not connect to
    each other. For BitTorrent, dormant passive rooms announce as seeders
    (`left: 0`) without offers, which avoids passive-to-passive discovery while
    keeping tracker load low.

  - `identity` - **(optional)** Controls how the local user's `userId` is loaded
    and saved (see [User identity](#user-identity)):
    - `'session'` _(default in browsers)_ - Persists the user identity in
      `sessionStorage` scoped to `appId` so page reloads in the same tab keep
      the same `userId`.
    - `'local'` - Persists the user identity across tabs and future visits on
      the same device using IndexedDB (with a non-extractable WebCrypto
      `CryptoKey`) and `localStorage` fallback.
    - `'none'` _(default outside browsers)_ - Generates a fresh runtime `userId`
      that is discarded when the page reloads or process exits.
    - `UserIdentity | ((context: {appId: string, roomId: string}) => UserIdentity | Promise<UserIdentity>)` -
      Supplies a `UserIdentity` (from `createUserIdentity()` or
      `importUserIdentity()`) or a custom sync/async loader function.

  - `use` - **(optional)** Array of `RoomPlugin`s created with `roles()`,
    `scale()`, or `definePlugin()`. TypeScript automatically infers the extra
    methods added to the returned `Room` instance from the plugins passed in
    `use` (e.g. `makeState`, `grantRole`, `revokeRole`, `getRoles`, `ban`, and
    `isBanned` from `roles()`, or `getTopology` from `scale()`). See the
    [Plugin Authoring Guide](docs/plugins.md) for creating custom plugins.

  - `relayConfig` - **(optional unless required by your chosen strategy)**
    Object containing strategy-specific relay settings:
    - `urls` - **(optional for 🌊 BitTorrent, 🐦 Nostr, 📡 MQTT; required for 🔌
      WebSocket relay)** Custom list of URLs for the strategy to use to
      bootstrap P2P connections. These would be BitTorrent trackers, Nostr
      relays, MQTT brokers, and WebSocket relays, respectively. They must
      support secure WebSocket connections.

    - `redundancy` - **(optional, 🌊 BitTorrent, 🐦 Nostr, 📡 MQTT only)**
      Integer specifying how many default relay endpoints to connect to
      simultaneously. Passing a `urls` option will cause this option to be
      ignored as the entire list will be used.

    - `manualReconnection` - **(optional, 🐦 Nostr and 🌊 BitTorrent only)**
      Boolean (default: `false`) that when set to `true` disables automatically
      pausing and resuming reconnection attempts when the browser goes offline
      and comes back online. This is useful if you want to manage this behavior
      yourself.

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
    strategy-dependent: `true` for most strategies, `false` for BitTorrent and
    IPFS unless explicitly set.

  - `turnConfig` - **(optional)** Specifies a custom list of TURN servers to use
    (see
    [Troubleshooting connection issues](#troubleshooting-connection-issues)).
    Each item in the list should correspond to an
    [ICE server config object](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/RTCPeerConnection#iceservers).
    When passing a TURN config like this, Trystero's default STUN servers will
    also be used. To override this and use both custom STUN and TURN servers,
    instead pass the config via the above `rtcConfig.iceServers` option as a
    list of both STUN/TURN servers — this won't inherit Trystero's defaults.

  - `rtcPolyfill` - **(optional)** Use this to pass a custom
    [`RTCPeerConnection`](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/RTCPeerConnection)-compatible
    constructor. This is useful for running outside of a browser, such as in
    Node (still experimental).

- `roomId` - A string to namespace peers and events within a room.

- `callbacks` - **(optional)** Callback config object containing:
  - `onJoinError(details)` - Called when room join fails due to an incorrect
    password, when the room is at capacity (`details.error === 'room full'`),
    when peer identity verification fails, or when peers exchange SDP but WebRTC
    still cannot establish a direct connection. This last case usually means
    TURN servers are needed or misconfigured (see
    [Troubleshooting connection issues](#troubleshooting-connection-issues)).
    `details` is an object containing `appId`, `roomId`, `peerId`, and `error`
    describing the failure.

Returns an object with the following methods:

- ### `leave()`

  Remove local user from room and unsubscribe from room events.

- ### `getSelf()`

  Returns a promise resolving to `SelfInfo` for the local participant in this
  room:
  - `peerId` - The 20-character Base62 endpoint ID.
  - `userId` - The local user's 43-character Base64url user identity thumbprint.
  - `roomId` - The full room ID (including the `.~<16-char-base62-fingerprint>`
    suffix when created with `roles({selfAsAdmin: true})`).
  - `baseRoomId` - The base room name without the fingerprint suffix.
  - `fingerprint` - The 16-character Base62 admin fingerprint from the room ID,
    or `null`.
  - `isAdmin` - Boolean indicating whether the local user is a verified
    `'admin'`.
  - `roles` - Array of verified roles currently held by the local user.

- ### `getUsers()`

  Returns a map of `UserInfo` objects (`{peerIds, roles}`) for the remote users
  present in the room (excluding the local user), keyed by `userId`:
  - `peerIds` - Array of active `peerId`s currently connected for that user
    (e.g. when a user has multiple tabs open in the same room).
  - `roles` - Array of verified roles currently held by that user.

- ### `getPeers()`

  Returns a map of `PeerInfo` objects
  (`{userId, connection, direct, hops, roles}`) for the individual peer
  connections present in the room (not including the local endpoint), keyed by
  `peerId`:
  - `userId` - The 43-character Base64url user ID that owns this endpoint.
  - `connection` - The underlying
    [`RTCPeerConnection`](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection)
    if the peer is a direct WebRTC neighbor, or `null` if the peer is routed
    across multiple hops in an overlay topology.
  - `direct` - Boolean (`true` for direct WebRTC peers, `false` for multi-hop
    overlay peers).
  - `hops` - Hop distance (`1` for direct peers, `>= 2` for multi-hop overlay
    peers).
  - `roles` - Array of verified roles currently held by that peer.

- ### `isPassive()`

  Returns whether the room was joined with `passive: true`.

- ### `getTopology()`

  _(Added to `Room` when `scale(...)` is included in `use: [...]`)_ Returns a
  `TopologySnapshot` describing how peers in the room are currently connected
  and routing data: `mode`, `activeMode` (`'mesh' | 'gossip' | 'broadcast'`),
  `selfId`, `directPeerIds`, `roomPeerIds`, `routes`, `mediaTrees`, and `stats`
  (`messagesSent`, `messagesReceived`, `messagesForwarded`, `duplicatesDropped`,
  `signatureFailures`, `lazyRepairsSent`, `lazyRepairsResolved`,
  `treeReparents`).

- ### `makeState(namespace, initialValue, [config])`

  _(Added to `Room` when `roles(...)` is included in `use: [...]`)_ Creates or
  retrieves a shared, admin-controlled state container (`AuthoritativeState<T>`)
  that any peer can read and only authorized roles can update.
  - `namespace` - Unique name for this state within the room.
  - `initialValue` - Initial state value before any update is received.
  - `config.roles` - **(optional)** Role or array of roles allowed to update
    this state (defaults to `'admin'`).
  - `config.validate(next, prev, context)` - **(optional)** Synchronous function
    returning `true` or `false` to validate state changes before they are sent
    or accepted.

  Returns an object with:
  - `get()` - Returns the current state value.
  - `set(nextOrUpdater)` - Broadcasts a new state value (or updater function
    `(prev) => next`). Rejects if the local user lacks permission or validation
    fails.
  - `getMeta()` - Returns metadata about the latest update (`updatedBy`,
    `userId`, `roles`, `seq`, `epoch`, `timestamp`, `hash`) or `null` if still
    at `initialValue`.
  - `onChange` - Nullable callback `(value, prev, context) => void` called
    whenever a verified state update arrives.

- ### `grantRole(targetId, role, [options])`

  _(Added to `Room` when `roles(...)` is included in `use: [...]`)_ Grants
  `role` (a role name string or array of strings) to `targetId` (which can be
  either a `peerId` or a `userId`). Requires the local user to be an `'admin'`
  or to hold that role with `canDelegate: true`.
  - `options.canDelegate` - **(optional)** Boolean allowing the recipient to
    grant those role(s) to other peers as well.
  - `options.expiresInMs` - **(optional)** How long the role remains valid in
    milliseconds.

- ### `revokeRole(targetId, [role])`

  _(Added to `Room` when `roles(...)` is included in `use: [...]`)_ Revokes
  `role` (or all roles if omitted) from `targetId` (`peerId` or `userId`).
  Delegated moderators cannot revoke a root `'admin'`.

- ### `getRoles([targetId])`

  _(Added to `Room` when `roles(...)` is included in `use: [...]`)_ Returns the
  array of verified roles currently held by `targetId` (`peerId` or `userId`, or
  by the local user if `targetId` is omitted).

- ### `ban(targetId, [options])`

  _(Added to `Room` when `roles(...)` is included in `use: [...]`)_ Permanently
  bans `targetId` (`peerId` or `userId`) from the room (requires `'admin'`
  role). Immediately disconnects all endpoints belonging to that peer or user,
  removes any roles they held, and blocks future connection offers or messages
  from them.
  - `options.reason` - **(optional)** Optional reason string for the ban.

- ### `isBanned(targetId)`

  _(Added to `Room` when `roles(...)` is included in `use: [...]`)_ Returns
  `true` if `targetId` (`peerId` or `userId`) has been banned from the room.

- ### `addStream(stream, [options])`

  Broadcasts media stream to other peers.
  - `stream` - A `MediaStream` with audio and/or video to send to peers in the
    room.

  - `options.target` - **(optional)** If specified, the stream is sent only to
    the target `peerId` or `userId` (string) or list of `peerId`s / `userId`s
    (array). Passing a `userId` fans out to all active tabs owned by that user.
    Passing `null` or omitting this option sends to all peers in the room.

  - `options.metadata` - **(optional)** Additional metadata (any serializable
    type) to be sent with the stream. This is useful when sending multiple
    streams so recipients know which is which (e.g. a webcam versus a screen
    capture).

- ### `removeStream(stream, [options])`

  Stops sending previously sent media stream to other peers.
  - `stream` - A previously sent `MediaStream` to stop sending.

  - `options.target` - **(optional)** If specified, the stream is removed only
    from the target `peerId` or `userId` (string) or list of IDs (array).

- ### `addTrack(track, stream, [options])`

  Adds a new media track to a stream.
  - `track` - A `MediaStreamTrack` to add to an existing stream.

  - `stream` - The target `MediaStream` to attach the new track to.

  - `options.target` - **(optional)** If specified, the track is sent only to
    the target `peerId` or `userId` (string) or list of IDs (array).

  - `options.metadata` - **(optional)** Additional metadata (any serializable
    type) to be sent with the track. See `metadata` notes for `addStream()`
    above for more details.

- ### `removeTrack(track, [options])`

  Removes a media track.
  - `track` - The `MediaStreamTrack` to remove.

  - `options.target` - **(optional)** If specified, the track is removed only
    from the target `peerId` or `userId` (string) or list of IDs (array).

- ### `replaceTrack(oldTrack, newTrack, [options])`

  Replaces a media track with a new one.
  - `oldTrack` - The `MediaStreamTrack` to remove.

  - `newTrack` - A `MediaStreamTrack` to attach.

  - `options.target` - **(optional)** If specified, the track is replaced only
    for the target `peerId` or `userId` (string) or list of IDs (array).

  - `options.metadata` - **(optional)** Additional metadata (any serializable
    type) to be sent with the replacement track.

- ### `onUserJoin`

  A callback property that will be called when a remote user joins the room
  (fires on their **first** connected instance, and does not fire again if that
  same `userId` opens a second tab while already in the room). Assigning a new
  function replaces the previous handler and replays currently active remote
  users; assigning `null` clears it.
  - `callback({userId, peerId, roles})` - Called with the user's `userId`, the
    `peerId` of their joining instance, and their verified `roles`.

  Example:

  ```js
  room.onUserJoin = ({userId}) => console.log(`${userId} joined`)
  ```

- ### `onUserLeave`

  A callback property that will be called when a remote user leaves the room
  (fires when their **last** remaining instance leaves, and does not fire if the
  user still has another tab open in the room). Assigning a new function
  replaces the previous handler; assigning `null` clears it.
  - `callback({userId, peerId})` - Called with the departing user's `userId` and
    the `peerId` of their last instance.

  Example:

  ```js
  room.onUserLeave = ({userId}) => console.log(`${userId} left`)
  ```

- ### `onPeerJoin`

  A lower-level callback property that will be called whenever an individual
  peer connection (tab/device) joins the room. Assigning a new function replaces
  the previous handler; assigning `null` clears it. Existing active peer
  connections are immediately replayed to a newly assigned handler.
  - `callback({peerId, userId, roles})` - Function to run whenever a peer
    endpoint joins, called with the endpoint's `peerId`, `userId`, and verified
    `roles`.

  Example:

  ```js
  room.onPeerJoin = ({peerId}) => console.log(`tab ${peerId} connected`)
  ```

- ### `onPeerLeave`

  A lower-level callback property that will be called whenever an individual
  peer connection (tab/device) leaves the room. Assigning a new function
  replaces the previous handler; assigning `null` clears it.
  - `callback({peerId, userId})` - Function to run whenever a peer endpoint
    leaves, called with the endpoint's `peerId` and `userId`.

  Example:

  ```js
  room.onPeerLeave = ({peerId}) => console.log(`tab ${peerId} disconnected`)
  ```

- ### `onPeerStream`

  A callback property that will be called when a user sends a media stream.
  Assigning a new function replaces the previous handler; assigning `null`
  clears it.
  - `callback(stream, {userId, peerId, metadata})` - Function to run whenever a
    user sends a media stream, called with the `MediaStream` first and a context
    object containing `userId`, `peerId`, and optional `metadata` (see
    `addStream()` above for details).

  Example:

  ```js
  room.onPeerStream = (stream, {userId, metadata}) =>
    console.log(`got stream from ${userId}`, stream, metadata)
  ```

- ### `onPeerTrack`

  A callback property that will be called when a user sends a media track.
  Assigning a new function replaces the previous handler; assigning `null`
  clears it.
  - `callback(track, stream, {userId, peerId, metadata})` - Function to run
    whenever a user sends a media track, called with the `MediaStreamTrack`,
    attached `MediaStream`, and a context object containing `userId`, `peerId`,
    and optional `metadata` (see `addTrack()` above for details).

  Example:

  ```js
  room.onPeerTrack = (track, stream, {userId, metadata}) =>
    console.log(`got track from ${userId}`, track, metadata)
  ```

- ### `makeAction(actionId, [config])`

  Listen for and send custom data actions.
  - `actionId` - A string to register this action consistently among all users.

  If `config.kind` is omitted, the action is a one-way message action. Passing
  `kind: 'request'` creates a request/response action.

  Message actions expose:
  - `send(data, [options])` - Sends data to users and resolves when local
    sending is complete. `options.target` accepts a `userId` (which fans out to
    all active tabs of that user), a `peerId`, or an array of either. To cancel
    an in-progress send, pass an `AbortController`'s `signal` in the options
    (e.g. `send(data, {signal: controller.signal})`) and call
    `controller.abort()`.
  - `onMessage` - Nullable callback property
    `(data, {userId, peerId, metadata, roles}) => void` for received messages.
  - `onReceiveProgress` - Nullable callback property
    `(percent, {userId, peerId, metadata}) => void` for inbound progress.

  Request actions expose:
  - `request(data, options)` - Sends to one user or tab (`options.target` can be
    a `userId` or `peerId`; when given a `userId`, it deterministically routes
    to one active tab of that user, preferring a direct 1-hop connection and
    breaking ties by lowest `peerId`) and resolves with its response.
  - `requestMany(data, options)` - Sends to many users or tabs
    (`options.targets` accepts `userId`s and/or `peerId`s) and resolves with
    labeled settled results (`{userId, peerId, status, value | error}`).
  - `onRequest` - Nullable callback property
    `(data, {userId, peerId, metadata, signal, roles}) => response` that returns
    the response.
  - `onReceiveProgress` - Nullable callback property
    `(percent, {userId, peerId, metadata}) => void` for inbound progress.

  Both kinds expose `onReceive`, a nullable callback accepting
  `{byteLength, userId, peerId, metadata, kind, signal, roles}` and returning a
  boolean or a promise of a boolean. It can also be provided in `config`. `kind`
  is `'message'`, `'request'`, or `'response'`; request actions apply it to both
  requests and responses. Responses have no metadata. See
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

  cursor.onMessage = ([x, y], {userId}) => {
    const userCursor = cursorMap[userId]
    userCursor.style.left = x + 'px'
    userCursor.style.top = y + 'px'
  }
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
  room.onUserJoin = ({userId}) =>
    setInterval(
      async () => console.log(`took ${await room.ping(userId)}ms`),
      2000
    )
  ```

### `roles([config])`

Creates the opt-in room authority plugin (`RoomPlugin<'roles', RolesRoomApi>`)
for `joinRoom()`. Pass in `use: [roles(config)]`:

- `roles()` - Enables role and state verification for a participant joining a
  room (required when joining a self-certifying `<roomId>.~<fingerprint>`).
- `roles({selfAsAdmin: true})` - Makes the local user (`userId`) a root room
  admin and appends `.~<16-char-base62-fingerprint>` to `roomId`. Pair with
  `identity: 'local'` or a persistent `UserIdentity`.
- `roles({admins: [userId1, userId2]})` - Trusts the specified `userId`s (or
  16-character Base62 fingerprints) as root room admins on either a fixed room
  name or alongside `selfAsAdmin: true`.

### `scale([config])`

Creates the opt-in multi-hop scaling plugin
(`RoomPlugin<'scale', ScaleRoomApi>`) for `joinRoom()`. Pass in
`use: [scale(config)]`, where `config` is `'auto'` (default), `'gossip'`,
`'broadcast'`, `'mesh'`, or a `ScaleConfig` object:

- `mode` - `'auto' | 'mesh' | 'gossip' | 'broadcast'` (default: `'auto'`).
- `maxConnections` - Maximum target direct WebRTC connections per browser in
  scalable modes (default: `6`, or `fanout + 3` in `'broadcast'` mode).
- `autoThreshold` - Peer count at which `'auto'` switches from `'mesh'` to
  `'gossip'` (default: `12`).
- `fanout` - Number of downstream peers each node forwards to in `'broadcast'`
  mode and media broadcast trees (default: `3`).

### `definePlugin(name, spec)`

Creates a custom or 3rd-party `RoomPlugin<TName, TApi>` that can be passed to
`joinRoom()` via `use: [myPlugin()]`. Any methods returned from `spec.setup()`
are merged onto the returned `Room` instance and inferred by TypeScript. See the
[Plugin Authoring Guide](docs/plugins.md).

### `createUserIdentity()`

Returns a promise resolving to a fresh self-certifying ECDSA P-256
`UserIdentity` (`{userId, publicKey, signPubJwk, sign}`). Use
`exportUserIdentity(identity)` to serialize its private key material if you want
to persist it in custom storage.

### `importUserIdentity(input)`

Returns a promise resolving to a `UserIdentity` imported from an exported
`trystero_uk_...` string or a P-256 private `JsonWebKey`. Rejects if the input
is not valid P-256 key material.

### `exportUserIdentity(identity)`

Exports a `UserIdentity` (created via `createUserIdentity()` or
`importUserIdentity()`) as a compact `trystero_uk_...` string suitable for
persisting in custom storage. Throws if the identity is backed by non-exportable
browser storage (`'session'` or `'local'`).

### `createAdminRoom(baseRoomId, [options])`

Resolves a `UserIdentity` (from `options.identity`, defaulting to `'local'` when
persistent browser storage is available) and formats a self-certifying room ID
(`<baseRoomId>.~<fingerprint>`), returning a promise that resolves to
`{roomId, baseRoomId, fingerprint, userId, identity}`.

### `getRelaySockets()`

**(🌊 BitTorrent, 🐦 Nostr, 📡 MQTT, 🔌 WebSocket relay only)** Returns an
object of relay URL keys mapped to their WebSocket connections. This can be
useful for determining the state of the user's connection to the relays and
handling any connection failures.

Example:

```js
import {getRelaySockets} from '@trystero-p2p/torrent'

console.log(getRelaySockets())
// => Object {
//  "wss://tracker.webtorrent.dev": WebSocket,
//  "wss://tracker.openwebtorrent.com": WebSocket
//  }
```

### `pauseRelayReconnection()`

**(🐦 Nostr, 🌊 BitTorrent only)** Normally Trystero will try to automatically
reconnect to relay sockets unless `relayConfig.manualReconnection: true` is set
in the room config. Calling this function stops relay reconnection attempts
until `resumeRelayReconnection()` is called.

### `resumeRelayReconnection()`

**(🐦 Nostr, 🌊 BitTorrent only)** Allows relay reconnection attempts to resume.
(See `pauseRelayReconnection()` above).

## Which strategy should I choose?

By default Trystero uses the Nostr network which is highly decentralized with
hundreds of active relays running. This is a good choice if you're interested in
decentralization and high redundancy. The other decentralized strategies are
recommended in the order of MQTT, BitTorrent, and IPFS, based on robustness.
These networks have far less relay redundancy than Nostr, but you might prefer
them for other reasons. You can of course host your own relay server for any of
these strategies.

For a middleground between using public relays and self-hosting, the built-in
Supabase and Firebase strategies are a good option.

---

Trystero by [Dan Motzenbecker](https://oxism.com)
