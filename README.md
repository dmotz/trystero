# 📯 Trystero

**Serverless WebRTC matchmaking for painless P2P**

Trystero manages a clandestine courier network that lets your application's
users talk directly with one another, encrypted and without a server middleman.

---

- [Setup](#setup)
- [Install](#install)
- [Initialize](#initialize)
- [Join a room](#join-a-room)
- [Listen for events](#listen-for-events)
- [Broadcast events](#broadcast-events)
- [Advanced](#advanced)
- [API](#api)

---

## Setup

To establish a direct peer-to-peer connection with WebRTC, a signalling channel
is needed to exchange peer information
([SDP](https://en.wikipedia.org/wiki/Session_Description_Protocol)).
Trystero uses Firebase to do so as it's trivial to set up, requires no server
maintenance, and can be used (for this purpose) for free or very cheaply.
Trystero may adopt more signalling strategies in the future, but for now
Firebase is the sole medium.

> 🔒
>
> Beyond peer discovery, your app's data never touches Firebase and is sent
> directly peer-to-peer and end-to-end encrypted between users.
>
> 👆

If you don't have an existing Firebase project:

1. Create a [Firebase](https://firebase.google.com/) project
1. Create a new Realtime Database
1. Copy the Firebase config's `databaseURL` by registering a new web app in
   settings
1. [*Optional*] Configure the database with [security rules](#security-rules)

## Install

```
npm i trystero
```

## Initialize

Begin by initializing Trystero:

```javascript
import * as trystero from 'trystero'

trystero.init({dbUrl: 'https://your-firebase-instance-here.firebaseio.com'})
```

This should be called just once globally for your app.

## Join a room

Join the user to a room with a namespace:

```javascript
const room = trystero.joinRoom('yoyodyne')
```

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

// tell other peers our name
sendName('Oedipa')

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

### Capped rooms

You can create rooms that are capped at a fixed number of members by passing a
second argument to `joinRoom`. Since the process of checking the number of
participants is async, in this case `joinRoom` will return a promise that throws
if the room is full.

```javascript
let exclusiveRoom

try {
  exclusiveRoom = await trystero.join('vips_only', 49)
} catch (e) {
  console.log('room is full')
}
```

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
await sendFile(hugeFile)
console.log('done sending')
```

### Security rules

You can limit activity in your Firebase instance by setting these security
rules:

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

These ensure room peer presence is only readable if the room namespace is known
ahead of time.

## API

### `selfId`

A unique ID string other peers will know the local user as globally across
rooms.

### `init(config)`

Required to be called once in an application's lifespan to bootstrap peer
connection process.

- `config` - Configuration object containing the following keys:

  - `dbUrl` - A URL string pointing at your Firebase database (`databaseURL` in
    the Firebase config object).

  - `rootPath` - **(optional)** Where Trystero writes its matchmaking data in
    your database (`'__trystero__'` by default). Changing this is useful if you
    want to run multiple apps using the same database and don't want to worry
    about namespace collisions.

### `getOccupants(namespace)`

Returns a promise that resolves to a list of user IDs present in the given
namespace. This is useful for checking how many users are in a room without
joining it.

- `namespace` - A namespace string that you'd pass to `joinRoom()`.

Example:

```javascript
console.log((await trystero.getOccupants('the_scope')).length)
// => 3
```

### `joinRoom(namespace, [limit])`

Adds local user to room whereby other peers in the same namespace will open
communication channels and send events.

- `namespace` - A string to namespace peers and events.

- `limit` - **(optional)** A positive integer defining a limit to the number of
  users allowed in the room. If defined, a promise is returned that resolves
  with the methods below. If the room is full, the local user does not join and
  the promise rejects.

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

- ### `makeAction(type)`

  Listen for and send custom data actions.

  - `type` - A string to register this action consistently among all peers.

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

---

Trystero by [Dan Motzenbecker](https://oxism.com)
