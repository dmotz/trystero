# 📯 Trystero

**Easy WebRTC matchmaking for painless P2P**

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
room.onPeerStream((id, stream) => (peerElements[id].video.srcObject = stream))
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
;[sendDrink, getDrink] = room.makeAction('drink')

// buy drink for a friend
sendDrink({drink: 'negroni', withIce: true}, friendId)

// buy round for the house (second argument omitted)
sendDrink({drink: 'mezcal', withIce: false})

// listen for drinks sent to you
getDrink((id, data) => console.log(`got a ${data.drink} from ${id}`))
```

You can also create actions that send and receive binary data, like images:

```javascript
// pass true as the second argument to makeAction to make it binary capable
;[sendPic, getPic] = room.makeAction('pic', true)

// blobs are automatically handled, as are any form of TypedArray
canvas.toBlob(blob => sendPic(blob))

// binary data is received as raw ArrayBuffers so your handling code should
// interpret it in a way that makes sense
getPic((id, data) => (imgs[id].src = URL.createObjectURL(new Blob([data]))))
```

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

Returns a promise that resolves to a list of user ids present in the given
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
    target peer and not all users.

  - `currentPeersOnly` - **(optional)** If `true` the stream will be sent only
    to peers currently in the room. By default, the stream is automatically sent
    to peers who arrive after the stream is initially broadcast unless a
    `peerId` argument is given or `currentPeersOnly` is `true`.

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
  onPeerStream((id, stream) => console.log(`got stream from ${id}`, stream))
  ```

- ### `makeAction(type, [isBinary])`

  Listen for and send custom data actions.

  - `type` - A string to register this action consistently among all peers.

  - `isBinary` - **(optional)** If `true`, data sent will be interpreted as raw
    bytes and not JSON or a primitive. This should be used if an action is for
    sending files, images, etc.

  Returns a pair containing a function to send the action to peers and a
  function to register a listener. The sender function takes any
  JSON-serializable value as its first argument (primitive or object) and takes
  an optional second argument of a peer ID to send to. By default it will
  broadcast the value to all peers in the room. If `makeAction()` was called
  with a second argument of `true`, the sender function will accept binary
  data types (`Blob`, `TypedArray`) and the receiver function will be called
  with an `ArrayBuffer` of agnostic bytes.

  Example:

  ```javascript
  const numberStations = {}

  ;[sendNumber, getNumber] = room.makeAction('number')

  sendNumber(33)

  getNumber((id, n) => {
    if (!numberStations[id]) {
      numberStations[id] = []
    }
    numberStations[id].push(n)
  })
  ```

---

Trystero by [Dan Motzenbecker](https://oxism.com)
