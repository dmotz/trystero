# Upgrading to Trystero 0.27.0

[← Back to README](./README.md) · [Full API Reference](./docs/api.md)

Trystero **0.27.0** is a major upgrade that brings **unforgeable user
identities**, **multi-tab presence**, **synced player & room state**,
**serverless room admins & moderation**, and **multi-hop room scaling** to every
signaling strategy out of the box.

---

## 60-Second Upgrade Checklist

Most apps can upgrade in a few minutes by updating these patterns:

1. **Switch property assignments to `on*()` methods**: `room.onPeerJoin = fn`
   becomes `room.onUserJoin(({userId}) => ...)` (or
   `room.onPeerJoin(({peerId, userId}) => ...)`), returning an `unsubscribe()`
   function.
2. **Destructure context objects in callbacks**: Presence and media callbacks
   now pass `{userId, peerId, ...}` instead of a positional `peerId` string.
3. **Replace `import {selfId}` with `await room.getSelf()`**: Identity keys are
   generated lazily via WebCrypto without import-time side effects.
4. **Move `onJoinError` (3rd `joinRoom` arg) to `room.onError(err => ...)`**:
   `joinRoom(config, roomId)` now takes 2 arguments and emits structured
   `err.code` values.
5. **Update `room.getPeers()` callers (or switch to `room.getUsers()`)**:
   `getPeers()` now returns `{userId, connection, direct, hops, roles}` per
   `peerId` rather than raw `RTCPeerConnection` objects.
6. **Attach action listeners via methods**: Call `action.onMessage(fn)`,
   `action.onRequest(fn)`, `action.onReceive(fn)`, and
   `action.onReceiveProgress(fn)` instead of property assignment or `makeAction`
   config callbacks.

---

## Step-by-Step Before & After

### 1. Joining rooms, presence & errors

Most apps care about _people_ in the room rather than how many browser tabs they
have open. Migrate `onPeerJoin` / `onPeerLeave` to **`onUserJoin` /
`onUserLeave`** (which deduplicate multiple tabs automatically), and move error
handling to **`room.onError()`**.

**Before (`<= 0.26.x`):**

```js
import {joinRoom, selfId} from 'trystero'

const room = joinRoom({appId: 'example.com/my-app'}, 'lobby', {
  onJoinError: err => console.error(err)
})

console.log('My ID:', selfId)

room.onPeerJoin = peerId => console.log(`${peerId} joined`)
room.onPeerLeave = peerId => console.log(`${peerId} left`)
```

**After (`0.27.0`):**

```js
import {joinRoom} from 'trystero'

const room = joinRoom({appId: 'example.com/my-app'}, 'lobby')
const {userId, peerId} = await room.getSelf()

room.onError(err => console.error(err.code, err.message))

const offJoin = room.onUserJoin(({userId}) => console.log(`${userId} joined`))
room.onUserLeave(({userId}) => console.log(`${userId} left`))
```

- **Duplicate `joinRoom()` calls**: Calling `joinRoom(config, roomId)` while the
  same `(appId, roomId)` is already active now throws an error instead of
  returning the existing room. Call `await room.leave()` before rejoining.
- **No implicit replay on subscribe**: `onUserJoin`, `onPeerJoin`,
  `onPeerStream`, `onRoleChange`, and `state.onChange` only fire on _new_ events
  by default. Pass `{replay: true}` as the 2nd argument if a late listener needs
  existing active items emitted immediately.
- **Custom `config.peerId` removed**: Because `peerId` and `userId` are now
  cryptographically self-certifying, arbitrary `peerId` strings are no longer
  accepted. Use [`config.identity`](./docs/identity.md) (`'local'`, `'none'`, or
  `importUserIdentity()`) to control persistence or bring your own keys.

---

### 2. Actions (`makeAction`)

`makeAction(namespace, config?)` now accepts declarative config only
(`{kind, roles}`); attach listeners with `.on*(fn)` methods (`onMessage`,
`onRequest`, `onReceive`, `onReceiveProgress`).

**Before (`<= 0.26.x`):**

```js
// Legacy tuple API (<= 0.24) or property/config callbacks (0.25–0.26)
const move = room.makeAction('move', {
  onMessage: (data, {peerId, metadata}) => handleMove(peerId, data)
})

move.send({x: 10, y: 20}, {target: targetPeerId})
```

**After (`0.27.0`):**

```js
const move = room.makeAction('move')

const unsub = move.onMessage((data, {userId, peerId, metadata, roles}) => {
  handleMove(userId, data)
})

// `target` accepts a userId (fans out to all their tabs), a peerId, or an array
await move.send({x: 10, y: 20}, {target: targetUserId})
```

Other action refinements in `0.27.0`:

- **Single-handler `onRequest` & `onReceive`**: Because RPC requests and file
  gates return a single decision/value, calling `onRequest` or `onReceive` a
  second time without calling `unsubscribe()` first throws an error.
- **Targeted `send()` validation**: `action.send(data, {target})` now rejects if
  a specified target is not connected (broadcast `send(data)` with no `target`
  still resolves when the room is empty).
- **Structured `ActionError`**: Rejected `send()` and `request()` calls throw an
  `ActionError` with `err.kind`
  (`'timeout' | 'disconnected' | 'aborted' | 'rejected'`), and throwing an
  `Error` inside `onRequest` forwards its `message` to the caller.
- **Zero-copy large buffers**: Binary buffers `> 16 KiB` stream directly from
  your `ArrayBuffer` / `TypedArray` without cloning — don't mutate the buffer
  until `await action.send(buf)` settles.

---

### 3. Audio & video (`addStream`, `replaceTrack`, `onPeerStream`)

Media is now centered cleanly on `MediaStream` (see
[Audio, Video & Screen Sharing](./docs/media.md)):

- `onPeerStream` passes `(stream, {userId, peerId, metadata})` instead of
  `(stream, peerId, metadata)`.
- `addStream()` and `replaceTrack()` return `Promise<void>` directly instead of
  `Promise<void>[]`.
- `addTrack`, `removeTrack`, `onPeerTrack`, and the `metadata` option on
  `replaceTrack` have been removed — mutate tracks on your `MediaStream`
  (`stream.addTrack(t)` / `stream.removeTrack(t)`) and re-call idempotent
  `await room.addStream(stream, {metadata})` to sync tracks or updated metadata.

**Before (`0.26.x`):**

```js
room.onPeerStream = (stream, peerId, metadata) => {
  attachVideo(stream, peerId, metadata)
}

await Promise.all(room.addStream(stream))
```

**After (`0.27.0`):**

```js
room.onPeerStream((stream, {userId, metadata}) => {
  attachVideo(stream, userId, metadata)
})

await room.addStream(stream)
```

---

### 4. Inspecting connected participants (`getUsers` & `getPeers`)

**Before (`0.26.x`):**

```js
const peers = room.getPeers() // { [peerId]: RTCPeerConnection }
const count = Object.keys(peers).length
const pc = peers[peerId]
```

**After (`0.27.0`):**

```js
// Recommended for participant lists & UI rosters:
const users = room.getUsers() // { [userId]: { peerIds, roles } }

// Connection-level info (works across both direct and multi-hop peers):
const peers = room.getPeers() // { [peerId]: { userId, connection, direct, hops, roles } }
const pc = peers[peerId]?.connection // RTCPeerConnection | null
```

---

### 5. Replacing `onPeerHandshake`

`onPeerHandshake` (and `handshakeTimeoutMs`) were removed because physical 1-hop
WebRTC connection hooks cannot run across multi-hop
[`scale()`](./docs/scaling.md) topologies and previously relied on unverified
signaling IDs. Every use case it served now has a first-class, cryptographically
verified replacement:

| What you used `onPeerHandshake` for                | Built-in `0.27.0` replacement                                                                             |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Verifying who a peer actually is                   | Automatic DTLS-bound `userId` & `peerId` verification ([Identity guide](./docs/identity.md))              |
| Capping a 2-player or 4-player lobby               | `joinRoom({appId, maxUsers: 2}, roomId)` + `room.onError` (`'room-full'`) — refresh-safe per `userId`!    |
| Exchanging player names, profiles, or app versions | [`room.makeUserState('profile', ...)`](./docs/state.md) (flushed automatically before `onUserJoin` fires) |
| Host permissions, allowlists, or kicking/banning   | [`use: [roles(...)]`](./docs/roles.md) with `grantRole()`, role-gated actions/state, and `room.ban()`     |
| Rejecting oversized or unwanted payloads           | [`action.onReceive(({byteLength, metadata, userId}) => ...)`](./docs/actions.md)                          |

---

### 6. Packaging, strategies & relay helpers

- **Removed legacy imports & IPFS**: Deprecated `trystero/<strategy>` subpaths,
  prebuilt `dist/trystero-*.min.js` bundles, and `@trystero-p2p/ipfs` have been
  removed. Import `trystero` (Nostr default) or `@trystero-p2p/<strategy>` with
  any bundler or ESM CDN (`https://esm.run/trystero`). TypeScript projects now
  require **TypeScript >= 5.0**.
- **Unified `setRelayConnectivity(mode)`**: `relayConfig.manualReconnection`,
  `pauseRelayReconnection()`, and `resumeRelayReconnection()` are replaced by
  `setRelayConnectivity('offline' | 'online' | 'auto')` (see
  [Signaling & Relays](./docs/signaling.md#customizing-relay-urls--redundancy)).
- **`@trystero-p2p/ws-relay` server**: `ws` is now an optional peer dependency
  needed only on Node when importing `@trystero-p2p/ws-relay/server`
  (`npm i @trystero-p2p/ws-relay ws`). Passing `<= 0` for `maxMessagesPerSecond`
  or `maxBurstMessages` throws a `RangeError` (use `Infinity` to disable).
