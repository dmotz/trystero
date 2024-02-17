# 🤝 Trystero

**Build instant multiplayer webapps, no server required**

👉 **[TRY THE DEMO](https://oxism.com/trystero)** 👈

Trystero manages a clandestine courier network that lets your application's
users talk directly with one another, encrypted and without a server middleman.

Peers can connect via
[🌊 BitTorrent, 🐦 Nostr, 📡 MQTT, 🔥 Firebase, or 🪐 IPFS](#strategy-comparison)
– all using the same API.

Besides making peer matching automatic, Trystero offers some nice abstractions
on top of WebRTC:

- 👂📣 Rooms / broadcasting
- 🔢📩 Automatic serialization / deserialization of data
- 🎥🏷 Attach metadata to binary data and media streams
- ✂️⏳ Automatic chunking and throttling of large data
- ⏱🤞 Progress events and promises for data transfers
- 🔐📝 Session data encryption
- ⚛️🪝 React hooks

---

## Contents

- [How it works](#how-it-works)
- [Get started](#get-started)
- [Listen for events](#listen-for-events)
- [Broadcast events](#broadcast-events)
- [Audio and video](#audio-and-video)
- [Advanced](#advanced)
  - [Binary metadata](#binary-metadata)
  - [Action promises](#action-promises)
  - [Progress updates](#progress-updates)
  - [Encryption](#encryption)
  - [React hooks](#react-hooks)
  - [Firebase setup](#firebase-setup)
- [API](#api)
- [Strategy comparison](#strategy-comparison)
  - [How to choose](#how-to-choose)

---

## How it works

👉 **If you just want to try out Trystero, you can skip this explainer and
[jump into using it](#get-started).**

To establish a direct peer-to-peer connection with WebRTC, a signalling channel
is needed to exchange peer information
([SDP](https://en.wikipedia.org/wiki/Session_Description_Protocol)). Typically
this involves running your own matchmaking server but Trystero abstracts this
away for you and offers multiple "serverless" strategies for connecting peers
(currently BitTorrent, Nostr, MQTT, Firebase, and IPFS).

The important point to remember is this:

> 🔒
>
> Beyond peer discovery, your app's data never touches the strategy medium and
> is sent directly peer-to-peer and end-to-end encrypted between users.
>
> 👆

You can [compare strategies here](#strategy-comparison).

## Get started

You can install with npm (`npm i trystero`) and import like so:

```js
import {joinRoom} from 'trystero'
```

Or maybe you prefer a simple script tag? Download a pre-built JS file from the
[latest release](https://github.com/dmotz/trystero/releases/latest) and import
it locally:

```html
<script type="module">
  import {joinRoom} from './trystero-torrent.min.js'
</script>
```

By default, the [BitTorrent strategy](#strategy-comparison) is used. To use a
different one just deep import like so (your bundler should handle including
only relevant code):

```js
import {joinRoom} from 'trystero/nostr' // (trystero-nostr.min.js with a local file)
// or
import {joinRoom} from 'trystero/mqtt' // (trystero-mqtt.min.js)
// or
import {joinRoom} from 'trystero/firebase' // (trystero-firebase.min.js)
// or
import {joinRoom} from 'trystero/ipfs' // (trystero-ipfs.min.js)
```

Next, join the user to a room with a namespace:

```js
const config = {appId: 'san_narciso_3d'}
const room = joinRoom(config, 'yoyodyne')
```

The first argument is a configuration object that requires an `appId`. This
should be a completely unique identifier for your app (or in the case of
Firebase, your `databaseURL`). The second argument is the room name.

> Why rooms? Browsers can only handle a limited amount of WebRTC connections at
> a time so it's recommended to design your app such that users are divided into
> groups (or rooms, or namespaces, or channels... whatever you'd like to call
> them).

## Listen for events

Listen for peers joining the room:

```js
room.onPeerJoin(peerId => console.log(`${peerId} joined`))
```

Listen for peers leaving the room:

```js
room.onPeerLeave(peerId => console.log(`${peerId} left`))
```

Listen for peers sending their audio/video streams:

```js
room.onPeerStream(
  (stream, peerId) => (peerElements[peerId].video.srcObject = stream)
)
```

To unsubscribe from events, leave the room:

```js
room.leave()
```

## Broadcast events

Send peers your video stream:

```js
room.addStream(
  await navigator.mediaDevices.getUserMedia({audio: true, video: true})
)
```

Send and subscribe to custom P2P actions:

```js
const [sendDrink, getDrink] = room.makeAction('drink')

// buy drink for a friend
sendDrink({drink: 'negroni', withIce: true}, friendId)

// buy round for the house (second argument omitted)
sendDrink({drink: 'mezcal', withIce: false})

// listen for drinks sent to you
getDrink((data, peerId) =>
  console.log(
    `got a ${data.drink} with${data.withIce ? '' : 'out'} ice from ${peerId}`
  )
)
```

You can also use actions to send binary data, like images:

```js
const [sendPic, getPic] = room.makeAction('pic')

// blobs are automatically handled, as are any form of TypedArray
canvas.toBlob(blob => sendPic(blob))

// binary data is received as raw ArrayBuffers so your handling code should
// interpret it in a way that makes sense
getPic(
  (data, peerId) => (imgs[peerId].src = URL.createObjectURL(new Blob([data])))
)
```

Let's say we want users to be able to name themselves:

```js
const idsToNames = {}
const [sendName, getName] = room.makeAction('name')

// tell other peers currently in the room our name
sendName('Oedipa')

// tell newcomers
room.onPeerJoin(peerId => sendName('Oedipa', peerId))

// listen for peers naming themselves
getName((name, peerId) => (idsToNames[peerId] = name))

room.onPeerLeave(peerId =>
  console.log(`${idsToNames[peerId] || 'a weird stranger'} left`)
)
```

> Actions are smart and handle serialization and chunking for you behind the
> scenes. This means you can send very large files and whatever data you send
> will be received on the other side as the same type (a number as a number,
> a string as a string, an object as an object, binary as binary, etc.).

## Audio and video

Here's a simple example of how you could create an audio chatroom:

```js
// this object can store audio instances for later
const peerAudios = {}

// get a local audio stream from the microphone
const selfStream = await navigator.mediaDevices.getUserMedia({
  audio: true,
  video: false
})

// send stream to peers currently in the room
room.addStream(selfStream)

// send stream to peers who join later
room.onPeerJoin(peerId => room.addStream(selfStream, peerId))

// handle streams from other peers
room.onPeerStream((stream, peerId) => {
  // create an audio instance and set the incoming stream
  const audio = new Audio()
  audio.srcObject = stream
  audio.autoplay = true

  // add the audio to peerAudio object if you want to address it for something
  // later (volume, etc.)
  peerAudios[peerId] = audio
})
```

Doing the same with video is similar, just be sure to add incoming streams to
video elements in the DOM:

```js
const peerVideos = {}
const videoContainer = document.getElementById('videos')

room.onPeerStream((stream, peerId) => {
  let video = peerVideos[peerId]

  // if this peer hasn't sent a stream before, create a video element
  if (!video) {
    video = document.createElement('video')
    video.autoplay = true

    // add video element to the DOM
    videoContainer.appendChild(video)
  }

  video.srcObject = stream
  peerVideos[peerId] = video
})
```

## Advanced

### Binary metadata

Let's say your app supports sending various types of files and you want to
annotate the raw bytes being sent with metadata about how they should be
interpreted. Instead of manually adding metadata bytes to the buffer you can
simply pass a metadata argument in the sender action for your binary payload:

```js
const [sendFile, getFile] = makeAction('file')

getFile((data, peerId, metadata) =>
  console.log(
    `got a file (${metadata.name}) from ${peerId} with type ${metadata.type}`,
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

```js
await sendFile(amplePayload)
console.log('done sending to all peers')
```

### Progress updates

Action sender functions also take an optional callback function that will be
continuously called as the transmission progresses. This can be used for showing
a progress bar to the sender for large tranfers. The callback is called with a
percentage value between 0 and 1 and the receiving peer's ID:

```js
sendFile(
  payload,
  // notice the peer target argument for any action sender can be a single peer
  // ID, an array of IDs, or null (meaning send to all peers in the room)
  [peerIdA, peerIdB, peerIdC],
  // metadata, which can also be null if you're only interested in the
  // progress handler
  {filename: 'paranoids.flac'},
  // assuming each peer has a loading bar added to the DOM, its value is
  // updated here
  (percent, peerId) => (loadingBars[peerId].value = percent)
)
```

Similarly you can listen for progress events as a receiver like this:

```js
const [sendFile, getFile, onFileProgress] = room.makeAction('file')

onFileProgress((percent, peerId, metadata) =>
  console.log(
    `${percent * 100}% done receiving ${metadata.filename} from ${peerId}`
  )
)
```

Notice that any metadata is sent with progress events so you can show the
receiving user that there is a transfer in progress with perhaps the name of the
incoming file.

Since a peer can send multiple transmissions in parallel, you can also use
metadata to differentiate between them, e.g. by sending a unique ID.

### Encryption

Once peers are connected to each other all of their communications are
end-to-end encrypted. During the initial connection / discovery process, peers'
[SDPs](https://en.wikipedia.org/wiki/Session_Description_Protocol) are sent via
the chosen peering strategy medium. The SDP is encrypted over the wire, but is
visible in plaintext as it passes through the medium (a public torrent tracker
for example). This is fine for most use cases but you can choose to hide SDPs
from the peering medium with Trystero's encryption option. This can protect
against a MITM peering attack if both intended peers have a shared secret. To
opt in, just pass a `password` parameter in the app configuration object:

```js
joinRoom({appId: 'kinneret', password: 'MuchoMaa$'}, 'w_a_s_t_e__v_i_p')
```

Keep in mind the password has to match for all peers in the room for them to be
able to connect. An example use case might be a private chat room where users
learn the password via external means.

### React hooks

Trystero functions are idempotent so they already work out of the box as React
hooks.

Here's a simple example component where each peer syncs their favorite
color to everyone else:

```jsx
import {joinRoom} from 'trystero'
import {useState} from 'react'

const trysteroConfig = {appId: 'thurn-und-taxis'}

export default function App({roomId}) {
  const room = joinRoom(trysteroConfig, roomId)
  const [sendColor, getColor] = room.makeAction('color')
  const [myColor, setMyColor] = useState('#c0ffee')
  const [peerColors, setPeerColors] = useState({})

  // whenever a new peer joins, send my color to them
  room.onPeerJoin(peer => sendColor(myColor, peer))

  getColor((color, peer) =>
    setPeerColors(peerColors => ({...peerColors, [peer]: color}))
  )

  const updateColor = e => {
    const {value} = e.target

    setMyColor(value)
    // when updating my own color, broadcast it to all peers
    sendColor(value)
  }

  return (
    <>
      <h1>Trystero + React</h1>

      <h2>My color:</h2>
      <input type="color" value={myColor} onChange={updateColor} />

      <h2>Peer colors:</h2>
      <ul>
        {Object.entries(peerColors).map(([peerId, color]) => (
          <li key={peerId} style={{backgroundColor: color}}>
            {peerId}: {color}
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

  useEffect(() => {
    roomRef.current = joinRoom(roomConfig, roomId)
    return () => roomRef.current.leave()
  }, [roomConfig, roomId])

  return roomRef.current
}
```

### Firebase setup

If you want to use the Firebase strategy and don't have an existing project:

1. Create a [Firebase](https://firebase.google.com/) project
2. Create a new Realtime Database
3. Copy the `databaseURL` and use it as the `appId` in your Trystero config
4. [*Optional*] Configure the database with security rules to limit activity:

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

## API

### `joinRoom(config, namespace)`

Adds local user to room whereby other peers in the same namespace will open
communication channels and send events. Calling `joinRoom()` multiple times with
the same namespace will return the same room instance.

- `config` - Configuration object containing the following keys:

  - `appId` - **(required)** A unique string identifying your app. If using
    Firebase, this should be the `databaseURL` from your Firebase config (also
    see `firebaseApp` below for an alternative way of configuring the Firebase
    strategy).

  - `password` - **(optional)** A string to encrypt session descriptions as they
    are passed through the peering medium. If set, session descriptions will be
    encrypted using AES-CBC. The password must match between any peers in the
    namespace for them to connect. Your site must be served over HTTPS for the
    crypto module to be used. See [encryption](#encryption) for more
    details.

  - `rtcConfig` - **(optional)** Specifies a custom
    [`RTCConfiguration`](https://developer.mozilla.org/en-US/docs/Web/API/RTCConfiguration)
    for all peer connections.

  - `relayUrls` - **(optional, 🌊 BitTorrent, 🐦 Nostr, 📡 MQTT only)** Custom
    list of URLs for the strategy to use to bootstrap P2P connections. These
    would be BitTorrent trackers, Nostr relays, and MQTT brokers, respectively.
    They must support secure WebSocket connections.

  - `relayRedundancy` - **(optional, 🌊 BitTorrent, 🐦 Nostr, 📡 MQTT only)**
    Integer specifying how many torrent trackers to connect to simultaneously in
    case some fail. Passing a `relayUrls` option will cause this option to be
    ignored as the entire list will be used.

  - `firebaseApp` - **(optional, 🔥 Firebase only)** You can pass an already
    initialized Firebase app instance instead of an `appId`. Normally Trystero
    will initialize a Firebase app based on the `appId` but this will fail if
    youʼve already initialized it for use elsewhere.

  - `rootPath` - **(optional, 🔥 Firebase only)** String specifying path where
    Trystero writes its matchmaking data in your database (`'__trystero__'` by
    default). Changing this is useful if you want to run multiple apps using the
    same database and don't want to worry about namespace collisions.

  - `libp2pConfig` - **(optional, 🪐 IPFS only)**
    [`Libp2pOptions`](https://libp2p.github.io/js-libp2p/types/libp2p.index.Libp2pOptions.html)
    where you can specify a list of static peers for bootstrapping.

- `namespace` - A string to namespace peers and events within a room.

Returns an object with the following methods:

- ### `leave()`

  Remove local user from room and unsubscribe from room events.

- ### `getPeers()`

  Returns a map of
  [`RTCPeerConnection`](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection)s
  for the peers present in room (not including the local user). The keys of
  this object are the respective peers' IDs.

- ### `addStream(stream, [targetPeers], [metadata])`

  Broadcasts media stream to other peers.

  - `stream` - A `MediaStream` with audio and/or video to send to peers in the
    room.

  - `targetPeers` - **(optional)** If specified, the stream is sent only to the
    target peer ID (string) or list of peer IDs (array).

  - `metadata` - **(optional)** Additional metadata (any serializable type) to
    be sent with the stream. This is useful when sending multiple streams so
    recipients know which is which (e.g. a webcam versus a screen capture). If
    you want to broadcast a stream to all peers in the room with a metadata
    argument, pass `null` as the second argument.

- ### `removeStream(stream, [targetPeers])`

  Stops sending previously sent media stream to other peers.

  - `stream` - A previously sent `MediaStream` to stop sending.

  - `targetPeers` - **(optional)** If specified, the stream is removed only from
    the target peer ID (string) or list of peer IDs (array).

- ### `addTrack(track, stream, [targetPeers], [metadata])`

  Adds a new media track to a stream.

  - `track` - A `MediaStreamTrack` to add to an existing stream.

  - `stream` - The target `MediaStream` to attach the new track to.

  - `targetPeers` - **(optional)** If specified, the track is sent only to the
    target peer ID (string) or list of peer IDs (array).

  - `metadata` - **(optional)** Additional metadata (any serializable type) to
    be sent with the track. See `metadata` notes for `addStream()` above for
    more details.

- ### `removeTrack(track, stream, [targetPeers])`

  Removes a media track from a stream.

  - `track` - The `MediaStreamTrack` to remove.

  - `stream` - The `MediaStream` the track is attached to.

  - `targetPeers` - **(optional)** If specified, the track is removed only from
    the target peer ID (string) or list of peer IDs (array).

- ### `replaceTrack(oldTrack, newTrack, stream, [targetPeers])`

  Replaces a media track with a new one.

  - `oldTrack` - The `MediaStreamTrack` to remove.

  - `newTrack` - A `MediaStreamTrack` to attach.

  - `stream` - The `MediaStream` the `oldTrack` is attached to.

  - `targetPeers` - **(optional)** If specified, the track is replaced only for
    the target peer ID (string) or list of peer IDs (array).

- ### `onPeerJoin(callback)`

  Registers a callback function that will be called when a peer joins the room.
  If called more than once, only the latest callback registered is ever called.

  - `callback(peerId)` - Function to run whenever a peer joins, called with the
    peer's ID.

  Example:

  ```js
  onPeerJoin(peerId => console.log(`${peerId} joined`))
  ```

- ### `onPeerLeave(callback)`

  Registers a callback function that will be called when a peer leaves the room.
  If called more than once, only the latest callback registered is ever called.

  - `callback(peerId)` - Function to run whenever a peer leaves, called with the
    peer's ID.

  Example:

  ```js
  onPeerLeave(peerId => console.log(`${peerId} left`))
  ```

- ### `onPeerStream(callback)`

  Registers a callback function that will be called when a peer sends a media
  stream. If called more than once, only the latest callback registered is ever
  called.

  - `callback(stream, peerId, metadata)` - Function to run whenever a peer sends
    a media stream, called with the the peer's stream, ID, and optional metadata
    (see `addStream()` above for details).

  Example:

  ```js
  onPeerStream((stream, peerId) =>
    console.log(`got stream from ${peerId}`, stream)
  )
  ```

- ### `onPeerTrack(callback)`

  Registers a callback function that will be called when a peer sends a media
  track. If called more than once, only the latest callback registered is ever
  called.

  - `callback(track, stream, peerId, metadata)` - Function to run whenever a
    peer sends a media track, called with the the peer's track, attached stream,
    ID, and optional metadata (see `addTrack()` above for details).

  Example:

  ```js
  onPeerTrack((track, stream, peerId) =>
    console.log(`got track from ${peerId}`, track)
  )
  ```

- ### `makeAction(namespace)`

  Listen for and send custom data actions.

  - `namespace` - A string to register this action consistently among all peers.

  Returns an array of three functions:

  1. #### Sender

     - Sends data to peers and returns a promise that resolves when all
       target peers are finished receiving data.

     - `(data, [targetPeers], [metadata], [onProgress])`

       - `data` - Any value to send (primitive, object, binary). Serialization
         and chunking is handled automatically. Binary data (e.g. `Blob`,
         `TypedArray`) is received by other peer as an agnostic `ArrayBuffer`.

       - `targetPeers` - **(optional)** Either a peer ID (string), an array of
         peer IDs, or `null` (indicating to send to all peers in the room).

       - `metadata` - **(optional)** If the data is binary, you can send an
         optional metadata object describing it (see
         [Binary metadata](#binary-metadata)).

       - `onProgress` - **(optional)** A callback function that will be called
         as every chunk for every peer is transmitted. The function will be
         called with a value between 0 and 1 and a peer ID. See
         [Progress updates](#progress-updates) for an example.

  2. #### Receiver

     - Registers a callback function that runs when data for this action is
       received from other peers.

     - `(data, peerId, metadata)`

       - `data` - The value transmitted by the sending peer. Deserialization is
         handled automatically, i.e. a number will be received as a number, an
         object as an object, etc.

       - `peerId` - The ID string of the sending peer.

       - `metadata` - **(optional)** Optional metadata object supplied by the
         sender if `data` is binary, e.g. a filename.

  3. #### Progress handler

     - Registers a callback function that runs when partial data is received
       from peers. You can use this for tracking large binary transfers. See
       [Progress updates](#progress-updates) for an example.

     - `(percent, peerId, metadata)`

       - `percent` - A number between 0 and 1 indicating the percentage complete
         of the transfer.

       - `peerId` - The ID string of the sending peer.

       - `metadata` - **(optional)** Optional metadata object supplied by the
         sender.

  Example:

  ```js
  const [sendCursor, getCursor] = room.makeAction('cursormove')

  window.addEventListener('mousemove', e => sendCursor([e.clientX, e.clientY]))

  getCursor(([x, y], peerId) => {
    const peerCursor = cursorMap[peerId]
    peerCursor.style.left = x + 'px'
    peerCursor.style.top = y + 'px'
  })
  ```

- ### `ping(peerId)`

  Takes a peer ID and returns a promise that resolves to the milliseconds the
  round-trip to that peer took. Use this for measuring latency.

  - `peerId` - Peer ID string of the target peer.

  Example:

  ```js
  // log round-trip time every 2 seconds
  room.onPeerJoin(peerId =>
    setInterval(
      async () => console.log(`took ${await room.ping(peerId)}ms`),
      2000
    )
  )
  ```

### `selfId`

A unique ID string other peers will know the local user as globally across
rooms.

### `getRelaySockets()`

**(🌊 BitTorrent, 🐦 Nostr, 📡 MQTT only)** Returns an object of relay URL keys
mapped to their WebSocket connections. This can be useful for determining the
state of the user's connection to the relays and handling any connection
failures.

Example:

```js
console.log(trystero.getRelaySockets())
// => Object {
//  "wss://tracker.webtorrent.dev": WebSocket,
//  "wss://tracker.openwebtorrent.com": WebSocket
//  }
```

### `getOccupants(config, namespace)`

**(🔥 Firebase only)** Returns a promise that resolves to a list of user IDs
present in the given namespace. This is useful for checking how many users are
in a room without joining it.

- `config` - A configuration object
- `namespace` - A namespace string that you'd pass to `joinRoom()`.

Example:

```js
console.log((await trystero.getOccupants(config, 'the_scope')).length)
// => 3
```

## Strategy comparison

|                   | one-time setup¹ | bundle size² | time to connect³ |
| ----------------- | --------------- | ------------ | ---------------- |
| 🌊 **BitTorrent** | none 🏆         | 27K 🏆       | ⏱️⏱️             |
| 🐦 **Nostr**      | none 🏆         | 56K          | ⏱️⏱️             |
| 📡 **MQTT**       | none 🏆         | 337K         | ⏱️⏱️             |
| 🔥 **Firebase**   | ~5 mins         | 212K         | ⏱️ 🏆            |
| 🪐 **IPFS**       | none 🏆         | 1MB          | ⏱️⏱️⏱️           |

**¹** All strategies except Firebase require zero setup. Firebase is a managed
strategy which requires setting up an account.

**²** Calculated via Rollup bundling + Terser compression.

**³** Relative speed of peers connecting to each other when joining a room.
Firebase is near-instantaneous while the other strategies are a bit slower to
exchange peering info.

### How to choose

Trysteroʼs unique advantage is that it requires zero backend setup and uses
decentralized infrastructure in most cases. This allows for frictionless
experimentation and no single point of failure. One potential drawback is that
itʼs difficult to guarantee that the public infrastructure it uses will always
be highly available, even with the redundancy techniques Trystero uses. While
the other strategies are decentralized, the Firebase strategy is a more managed
approach with greater control and an SLA, which might be more appropriate for
“production” apps.

Luckily, Trystero makes it trivial to switch between strategies — just change a
single import line and quickly experiment:

```js
import {joinRoom} from 'trystero/[torrent|nostr|mqtt|firebase|ipfs]'
```

---

Trystero by [Dan Motzenbecker](https://oxism.com)
