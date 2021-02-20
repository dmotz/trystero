# 📯 Trystero

**Serverless WebRTC matchmaking for painless P2P**

Trystero manages a clandestine courier network that lets your application's
users talk directly with one another, encrypted and without a server middleman.

Peers can connect via [torrents, Firebase, or IPFS](#strategy-comparison) –
all using the same API.

---

- [How it works](#how-it-works)
- [Install](#install)
- [Join a room](#join-a-room)
- [Listen for events](#listen-for-events)
- [Broadcast events](#broadcast-events)
- [Advanced](#advanced)
- [API](#api)
- [Strategy comparison](#strategy-comparison)
- [Firebase setup](#firebase-setup)

---

## How it works

👉 **If you just want to try out Trystero, you can skip this explainer and [jump to the how-to](#install).**

To establish a direct peer-to-peer connection with WebRTC, a signalling channel
is needed to exchange peer information
([SDP](https://en.wikipedia.org/wiki/Session_Description_Protocol)). Typically
this involves running your own matchmaking server but Trystero abstracts this
away for you and offers multiple "serverless" strategies for connecting peers
(currently, torrent trackers, Firebase, and IPFS).

The important point to remember is this:

> 🔒
>
> Beyond peer discovery, your app's data never touches the strategy medium and
> is sent directly peer-to-peer and end-to-end encrypted between users.
>
> 👆

You can [compare strategies here](#strategy-comparison).

## Install

```
npm i trystero
```

## Join a room

First import Trystero:

```javascript
import {joinRoom} from 'trystero'
```

By default this uses the torrent strategy; to use a different one just deep
import like so (your bundler should handle including only relevant code):

```javascript
import {joinRoom} from 'trystero/firebase'
// or
import {joinRoom} from 'trystero/ipfs'
```

Next, join the user to a room with a namespace:

```javascript
const config = {appId: 'san_narciso'}
const room = trystero.joinRoom(config, 'yoyodyne')
```

The first argument is a configuration object that requires an `appId`. This
should be a completely unique identifier for your app (for the torrent and IPFS
strategies) or your Firebase project ID if you're using Firebase. The second
argument is the room name.

> Why rooms? Browsers can only handle a limited amount of WebRTC connections at
> a time so it's recommended to design your app such that users are divided into
> groups (or rooms, or namespaces, or channels... whatever you'd like to call
> them).

## Listen for events

Listen for peers joining the room:

```javascript
room.onPeerJoin(id => console.log(`${id} joined`))
```

Listen for peers leaving the room:

```javascript
room.onPeerLeave(id => console.log(`${id} left`))
```

Listen for peers sending their audio/video streams:

```javascript
room.onPeerStream((stream, id) => (peerElements[id].video.srcObject = stream))
```

To unsubscribe from events, leave the room:

```javascript
room.leave()
```

## Broadcast events

Send peers your video stream:

```javascript
room.addStream(
  await navigator.mediaDevices.getUserMedia({audio: true, video: true})
)
```

Send and subscribe to custom P2P actions:

```javascript
const [sendDrink, getDrink] = room.makeAction('drink')

// buy drink for a friend
sendDrink({drink: 'negroni', withIce: true}, friendId)

// buy round for the house (second argument omitted)
sendDrink({drink: 'mezcal', withIce: false})

// listen for drinks sent to you
getDrink((data, id) =>
  console.log(
    `got a ${data.drink} with${data.withIce ? '' : 'out'} ice from ${id}`
  )
)
```

You can also use actions to send binary data, like images:

```javascript
const [sendPic, getPic] = room.makeAction('pic')

// blobs are automatically handled, as are any form of TypedArray
canvas.toBlob(blob => sendPic(blob))

// binary data is received as raw ArrayBuffers so your handling code should
// interpret it in a way that makes sense
getPic((data, id) => (imgs[id].src = URL.createObjectURL(new Blob([data]))))
```

Let's say we want users to be able to name themselves:

```javascript
const idsToNames = {}
const [sendName, getName] = room.makeAction('name')

// tell other peers currently in the room our name
sendName('Oedipa')

// tell newcomers
room.onPeerJoin(id => sendName('Oedipa', id))

// listen for peers naming themselves
getName((name, id) => (idsToNames[id] = name))

room.onPeerLeave(id =>
  console.log(`${idsToNames[id] || 'a weird stranger'} left`)
)
```

> Actions are smart and handle serialization and chunking for you behind the
> scenes. This means you can send very large files and whatever data you send
> will be received on the other side as the same type (a number as a number,
> a string as a string, an object as an object, binary as binary, etc.).

## Advanced

### Binary metadata

Let's say your app supports sending various types of files and you want to
annotate the raw bytes being sent with metadata about how they should be
interpreted. Instead of manually adding metadata bytes to the buffer you can
simply pass a metadata argument in the sender action for your binary payload:

```javascript
const [sendFile, getFile] = makeAction('file')

getFile((data, id, meta) =>
  console.log(
    `got a file (${meta.name}) from ${id} with type ${meta.type}`,
    data
  )
)

// to send metadata, pass a third argument
// to broadcast to the whole room, set the second peer ID argument to null
sendFile(buffer, null, {name: 'The Courierʼs Tragedy', type: 'application/pdf'})
```

### Action promises

Action sender functions return a promise that resolves when they're done
sending. You can optionally use this to indicate to the user when a large
transfer is done.

```javascript
await sendFile(amplePayload)
console.log('done sending')
```

## API

### `joinRoom(config, namespace)`

Adds local user to room whereby other peers in the same namespace will open
communication channels and send events.

- `config` - Configuration object containing the following keys:

  - `appId` - **(required)** A unique string identifying your app. If using
    Firebase this should be the Firebase instance ID.

  - `rootPath` - **(optional, Firebase only)** Where Trystero writes its
    matchmaking data in your database (`'__trystero__'` by default). Changing
    this is useful if you want to run multiple apps using the same database and
    don't want to worry about namespace collisions.

  - `trackerUrls` - **(optional, Torrent only)** Custom list of torrent tracker
    URLs to use. They must support WebSocket connections.

  - `trackerRedundancy` - **(optional, Torrent only)** Integer specifying how
    many torrent trackers to connect to simultaneously in case some fail.
    Defaults to 2, maximum of 4. Passing a `trackerUrls` option will cause this option to be ignored as the entire list will be used.

- `namespace` - A string to namespace peers and events within a room.

Returns an object with the following methods:

- ### `leave()`

  Remove local user from room and unsubscribe from room events.

- ### `getPeers()`

  Returns a list of peer IDs present in room (not including the local user).

- ### `addStream(stream, [peerId], [currentPeersOnly])`

  Broadcasts media stream to other peers.

  - `stream` - A `MediaStream` with audio/video to send to peers in the room.

  - `peerId` - **(optional)** If specified, the stream is sent only to the
    target peer ID (string) and not all peers.

  - `currentPeersOnly` - **(optional)** If `true` the stream will be sent only
    to peers currently in the room. By default, the stream is automatically sent
    to peers who arrive after the stream is initially broadcast unless a
    `peerId` argument is given or `currentPeersOnly` is `true`. Note that these
    optional arguments are mutually exclusive so pass at most only one.

- ### `removeStream(stream, [peerId])`

  Stops sending previously sent media stream to other peers.

  - `stream` - A previously sent `MediaStream` to stop sending.

  - `peerId` - **(optional)** If specified, the stream is removed only from the
    target peer, not all peers.

- ### `onPeerJoin(callback)`

  Registers a callback function that will be called when a peer joins the room.
  If called more than once, only the latest callback registered is ever called.

  Example:

  ```javascript
  onPeerJoin(id => console.log(`${id} joined`))
  ```

- ### `onPeerLeave(callback)`

  Registers a callback function that will be called when a peer leaves the room.
  If called more than once, only the latest callback registered is ever called.

  Example:

  ```javascript
  onPeerLeave(id => console.log(`${id} left`))
  ```

- ### `onPeerStream(callback)`

  Registers a callback function that will be called when a peer sends a media
  stream. If called more than once, only the latest callback registered is ever
  called.

  Example:

  ```javascript
  onPeerStream((stream, id) => console.log(`got stream from ${id}`, stream))
  ```

- ### `makeAction(namespace)`

  Listen for and send custom data actions.

  - `namespace` - A string to register this action consistently among all peers.

  Returns a pair containing a function to send the action to peers and a
  function to register a listener. The sender function takes any
  JSON-serializable value (primitive or object) or binary data as its first
  argument and takes an optional second argument of a peer ID to send to. By
  default it will broadcast the value to all peers in the room. If the sender
  function is called with binary data (`Blob`, `TypedArray`), it will be
  received on the other end as an `ArrayBuffer` of agnostic bytes. The sender
  function returns a promise that resolves when all target peers are finished
  receiving data.

  Example:

  ```javascript
  const numberStations = {}
  const [sendNumber, getNumber] = room.makeAction('number')

  sendNumber(33)

  getNumber((n, id) => {
    if (!numberStations[id]) {
      numberStations[id] = []
    }
    numberStations[id].push(n)
  })
  ```

### `selfId`

A unique ID string other peers will know the local user as globally across
rooms.

### `getOccupants(config, namespace)`

**(Firebase only)** Returns a promise that resolves to a list of user IDs
present in the given namespace. This is useful for checking how many users are
in a room without joining it.

- `config` - A configuration object
- `namespace` - A namespace string that you'd pass to `joinRoom()`.

Example:

```javascript
console.log((await trystero.getOccupants(config, 'the_scope')).length)
// => 3
```

## Strategy comparison

**Loose, (overly) simple advice for choosing a strategy:** Use the torrent or
IPFS strategy for experiments or when your heart yearns for fuller
decentralization, use Firebase for "production" apps where you need full control
and reliability. Trystero tries to make it trivial to switch between strategies,
just change a single import line:

```javascript
import {joinRoom} from 'trystero/[torrent|firebase|ipfs]'
```

|                 | setup¹  | reliability²            | connection speed³ | bundle size⁴ | occupancy polling⁵ |
| --------------- | ------- | ----------------------- | ----------------- | ------------ | ------------------ |
| 🌊 **Torrent**  | none ✅ | variable                | better            | ~24K ✅      | none               |
| 🔥 **Firebase** | ~5 mins | reliable, 99.95% SLA ✅ | best ✅           | ~275K        | yes ✅             |
| 🪐 **IPFS**     | none ✅ | variable                | good              | ~1.77M 👀    | none               |

**¹** Firebase requires an account and project which take a few minutes to set
up.

**²** The torrent strategy uses public trackers which may go down/misbehave at
their own whim. Trystero has a built-in redundancy approach that connects to
multiple trackers simultaneously to avoid issues. IPFS relies on public gateways
which are also prone to downtime.

**³** Relative speed of peers connecting to each other when joining a room.
Firebase is near-instantaneous while the other strategies are a bit slower.

**⁴** Calculated via Rollup bundling + Terser compression.

**⁵** The Firebase strategy supports calling `getOccupants()` on a room to see
which/how many users are currently present without joining the room.

## Firebase setup

If you want to use the Firebase strategy and don't have an existing project:

1. Create a [Firebase](https://firebase.google.com/) project
1. Create a new Realtime Database
1. Copy the Firebase project ID and use it as the `appId` in your Trystero
   config
1. [*Optional*] Configure the database with [security rules](#security-rules)
   to limit activity:

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

---

Trystero by [Dan Motzenbecker](https://oxism.com)
