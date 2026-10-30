# Trystero 0.27.0 Migration Guide

Trystero **0.27.0** is a major architectural upgrade that brings **unforgeable
user identities**, **multi-tab user presence**, **cryptographic room authority &
state**, and **scalable multi-hop topologies** to every signaling strategy out
of the box.

While this release introduces a few breaking changes to callback signatures, it
unlocks capabilities that previously required complex application-level
boilerplate—and eliminates subtle security and topology footguns.

---

## Why 0.27.0? What Changed Architecturally

1. **Users (`userId`) vs. Connections (`peerId`)**: Every participant now gets
   an unforgeable cryptographic `userId` alongside their per-connection
   `peerId`. By default in browsers (`identity: 'local'`), `userId` persists
   across page refreshes, open tabs, and browser restarts on that device (each
   tab still has its own `peerId`), can be reset per app via
   `clearUserIdentity(appId)`, made strictly ephemeral with `identity: 'none'`,
   or loaded from your own backend.
2. **`onUserJoin` / `onUserLeave` as the New Default**: Most applications care
   about _who_ is in the room rather than how many browser tabs they have open.
   `onUserJoin` and `onUserLeave` fire once per unique user and automatically
   deduplicate multiple tabs.
3. **Out-of-the-Box Room Authority, Limits, and State**: Advisory per-peer room
   capacity limits (`config.limit`), opt-in cryptographic admin ownership
   (`roles(...)`), role-based access control (`grantRole`, `revokeRole`, `ban`),
   and synchronized authoritative state (`room.makeState`) are now built into
   the core protocol and tree-shaken when `roles()` is not imported.
4. **Scalable Multi-Hop Topologies**: Rooms are no longer restricted to
   full-mesh WebRTC (`O(N²)` connections). By opting in with `scale()` (supports
   `'auto'` or `'gossip'`), rooms can scale to hundreds of participants using
   multi-hop overlay routing with end-to-end cryptographic sender verification,
   while apps that don't import `scale()` pay zero bundle overhead.
5. **Prebuilt `.min.js` Bundles Removed**: Prebuilt `dist/trystero-*.min.js`
   release bundles have been removed in favor of tree-shaking bundlers (or ESM
   CDNs like `esm.run`) so optional plugins like `roles()` and `scale()` are
   only bundled when imported.
6. **IPFS Strategy Removed**: The experimental IPFS strategy
   (`@trystero-p2p/ipfs`) has been removed because it was not a good fit for
   Trystero's purposes (huge bundle size, very slow connection time, few relays,
   and little usage).

---

## Why `onPeerHandshake` Was Removed

`onPeerHandshake` was originally introduced as a **stopgap measure** while we
explored the right out-of-the-box solution for peer authentication, room
capacity limits, and admission control.

As Trystero evolved to support cryptographic identities and multi-hop
topologies, keeping `onPeerHandshake` became a liability and a source of
security footguns:

1. **False Sense of Security in Multi-Hop Topologies**: `onPeerHandshake`
   operated during the physical WebRTC connection setup. In scalable topologies
   (`scale()` with `'auto'` or `'gossip'`), a peer only establishes physical
   WebRTC connections with a handful of 1-hop neighbors (`maxConnections`),
   while communicating with everyone else over multi-hop overlay routing. A
   physical handshake gate would **never run** for 2+ hop peers—giving
   developers a false sense of security that they had gated the room when
   unverified peers could still route messages through neighbors.
2. **Unverified Signaling IDs**: Previously, `peerId` was just a random string
   announced over the signaling server. Using `onPeerHandshake` to check an
   allowlist of `peerId`s was vulnerable to spoofing on public relays unless
   developers hand-rolled their own public-key cryptography.
3. **Built-in Alternatives for Common Use Cases**:
   - **Identity verification**: Handled automatically by self-certifying
     `userId` and `peerId` cryptographic handshakes and end-to-end signed
     overlay envelopes.
   - **Room capacity limits**: Handled natively by `joinRoom({limit: N})` as a
     best-effort per-peer cap that accounts for multi-tab users (`userId`)
     without locking out a user who refreshes their page.
   - **Roles and moderation**: Handled cryptographically by `roles(...)`,
     `room.grantRole()`, `roles` filters on `makeAction` / `makeState`, and
     `room.ban()`. These authorize actions and enforce bans after joining; they
     are not a custom pre-connection admission hook.
   - **Custom profile / app-version exchange**: Handled cleanly across both
     direct and multi-hop peers using
     `room.makeAction('hello', {kind: 'request'})` and `room.makeState()`.

---

## Breaking Changes & Before / After Migration

### 1. Presence Callbacks (`onUserJoin` / `onUserLeave` & `onPeerJoin` / `onPeerLeave`)

Callback registration still uses property assignment, as in 0.26.x. The callback
now receives a context object instead of a bare `peerId` string. Unless you
specifically need to track individual browser tabs, migrate `onPeerJoin` /
`onPeerLeave` to **`onUserJoin` / `onUserLeave`**.

#### Before (0.26.x)

```js
room.onPeerJoin = peerId => {
  console.log(`${peerId} joined`)
}

room.onPeerLeave = peerId => {
  console.log(`${peerId} left`)
}
```

#### After (0.27.0) — Recommended (User-level presence)

```js
room.onUserJoin = ({userId}) => {
  console.log(`${userId} joined`)
}

room.onUserLeave = ({userId}) => {
  console.log(`${userId} left`)
}
```

#### After (0.27.0) — Connection/Tab-level presence (if needed)

```js
room.onPeerJoin = ({peerId, userId, roles}) => {
  console.log(`Connection ${peerId} for user ${userId} joined`)
}

room.onPeerLeave = ({peerId, userId}) => {
  console.log(`Connection ${peerId} for user ${userId} left`)
}
```

---

### 2. Stream-Centric Media API (`addStream`, `replaceTrack`, `onPeerStream`)

`onPeerStream` keeps the `MediaStream` first and passes
`{userId, peerId, metadata}` as a context object (matching `action.onMessage`).
`addStream` and `replaceTrack` now return `Promise<void>` directly instead of
`Promise<void>[]`.

`addTrack`, `removeTrack`, and `onPeerTrack` have been removed in favor of
idempotent `addStream` syncing:

- Adding or removing a track on an active stream uses the platform's own
  `MediaStream` methods followed by `room.addStream(stream)`
  (`stream.addTrack(t); room.addStream(stream)` or
  `stream.removeTrack(t); room.addStream(stream)`).
- `room.replaceTrack(oldTrack, newTrack, {target?})` remains for
  zero-renegotiation sender-level track swaps (such as camera switching). To
  update metadata after a swap, re-announce with
  `room.addStream(stream, {metadata})`, which triggers `onPeerStream` on
  recipients with the new metadata.
- For track-level events on remote streams, use native `stream.onaddtrack` /
  `stream.onremovetrack` or `stream.getTracks()`.

#### Before (0.26.x)

```js
room.onPeerStream = (stream, peerId, metadata) => {
  attachVideo(stream, peerId, metadata)
}

await Promise.all(room.addStream(stream))
```

#### After (0.27.0)

```js
room.onPeerStream = (stream, {userId, metadata}) => {
  attachVideo(stream, userId, metadata)
}

await room.addStream(stream)
```

---

### 3. Action Callbacks (`makeAction`)

If you were already using the object-based `room.makeAction('type')` API, your
existing `{peerId, metadata}` destructuring continues to work, and **`userId`**
and **`roles`** are now automatically included in every callback context
(`onMessage`, `onRequest`, `onReceive`, `onProgress`, `onReceiveProgress`).

If you are migrating from a release before 0.25.0 and were still using the
legacy tuple destructuring (`const [send, get] = room.makeAction(...)`), migrate
to the object API:

#### Before (Legacy Tuple API)

```js
const [sendMove, getMove] = room.makeAction('move')

sendMove({x: 10, y: 20}, targetPeerId)
getMove((data, peerId, metadata) => {
  console.log(`Move from ${peerId}:`, data)
})
```

#### After (0.27.0)

```js
const move = room.makeAction('move')

// Target can be a userId, peerId, or array of either
move.send({x: 10, y: 20}, {target: targetUserId})

move.onMessage = (data, {userId, metadata, roles}) => {
  console.log(`Move from ${userId}:`, data)
}
```

---

### 4. Inspecting Connected Participants (`getUsers`, `getPeers`, `getSelf`)

- **New `room.getUsers()`**: Returns a map of connected users
  (`Record<string, {peerIds: string[], roles: string[]}>`), excluding the local
  user. Use this for participant lists and UI rosters.
- **Updated `room.getPeers()`**: Instead of returning raw `RTCPeerConnection`
  objects directly (`Record<string, RTCPeerConnection>`), `getPeers()` now
  returns rich peer descriptors (`Record<string, PeerInfo>`), which works for
  both direct WebRTC neighbors and multi-hop overlay peers.
- **New `await room.getSelf()` (replaces removed `selfId` export)**: The
  top-level `selfId` export has been removed so endpoint P-256 identity keys are
  generated lazily via WebCrypto without top-level `await`. Use
  `await room.getSelf()` to get your verified
  `{peerId, userId, roomId, baseRoomId, isAdmin, roles}`.

#### Before (0.26.x)

```js
import {selfId} from 'trystero'

const peers = room.getPeers() // { [peerId]: RTCPeerConnection }
const peerIds = Object.keys(peers)
```

#### After (0.27.0)

```js
// Get your own verified userId and peerId (replaces top-level `selfId`)
const {peerId: myPeerId, userId: myUserId} = await room.getSelf()

// Get all other connected users in the room
const users = room.getUsers() // { [userId]: { peerIds: [...], roles: [...] } }

// Or inspect connection-level topology details (including RTCPeerConnection if direct)
const peers = room.getPeers() // { [peerId]: { userId, connection, direct, hops, roles } }
```

---

### 5. Relay Connectivity Control (`setRelayConnectivity`)

`relayConfig.manualReconnection`, `pauseRelayReconnection()`, and
`resumeRelayReconnection()` have been replaced by a single process-wide
`setRelayConnectivity(mode)` export (`'offline' | 'online' | 'auto'`). Calling
it with `'online'` or `'offline'` detaches the browser `online`/`offline`
watcher; `'auto'` re-attaches it:

- `manualReconnection: true` + `pauseRelayReconnection()` →
  `setRelayConnectivity('offline')`
- `resumeRelayReconnection()` → `setRelayConnectivity('online')`
- `manualReconnection: true` alone (ignoring browser `online`/`offline` events)
  → call `setRelayConnectivity('online')` once at startup

---

## Common Scenarios & Recipes in 0.27.0

### Scenario 1: Media & Data Fan-Out Across Multi-Tab Users

When a user connects from multiple tabs (or devices sharing an identity), they
have one `userId` and multiple `peerId`s. Trystero routes traffic intelligently
when you pass a `userId` as `target`:

- **Broadcast / Push (`action.send`, `room.addStream`)**: Passing
  `target: userId` automatically **fans out** the payload or media stream to
  _every_ active connection (`peerId`) belonging to that user.
- **Point-to-Point (`action.request`, `room.ping`)**: Passing `target: userId`
  deterministically routes to a single connection for that user so you receive a
  single response.

```js
const dm = room.makeAction('dm')
const profileRpc = room.makeAction('profile', {kind: 'request'})

// Fans out to all open tabs belonging to targetUserId
await dm.send({text: 'Hello across all your tabs!'}, {target: targetUserId})

// Streams audio/video to all open tabs belonging to targetUserId
room.addStream(localStream, {target: targetUserId})

// Queries a single tab belonging to targetUserId and awaits the reply
const profile = await profileRpc.request(
  {fields: ['name', 'avatar']},
  {target: targetUserId}
)
```

---

### Scenario 2: Room Capacity Limits (Replacing Handshake Slot Counters)

Previously, capping a room (for example, a 2-player game) required tracking peer
counts inside `onPeerHandshake` and rejecting latecomers—which suffered from
race conditions and locked out players who refreshed their browser tab.

In 0.27.0, pass `limit` to `joinRoom()` for a best-effort, advisory per-peer
capacity limit. Each peer refuses new `userId`s once its own view reaches
`limit` (without ever evicting itself or trusting a stranger's `'room full'` to
drop other peers), and a player who refreshes their tab or opens another tab
automatically reuses their existing user slot:

```js
const room = joinRoom(
  {
    appId: 'chess-app',
    limit: 2 // Advisory cap of 2 unique users in this peer's view
  },
  roomId,
  {
    onJoinError: ({error}) => {
      if (error === 'room full') {
        showModal('This match already has 2 players!')
      }
    }
  }
)
```

---

### Scenario 3: Allowlists, Roles, and Moderation (Replacing `onPeerHandshake` Auth)

Instead of gating physical connections with `onPeerHandshake`, 0.27.0 provides
cryptographic **self-certifying rooms** (`use: [roles({selfAsAdmin: true})]`),
**signed role certificates** (`grantRole`), **action/state role gating**, and
**signed bans** (`ban`) that work across both full-mesh and multi-hop
topologies.

```js
import {joinRoom, roles} from 'trystero'

// --- Host (Room Creator) ---
const room = joinRoom(
  {
    appId: 'poker-club',
    use: [roles({selfAsAdmin: true})]
  },
  'table-1'
)

// Wait for the self-certifying room ID containing the admin's userId
const {roomId: inviteRoomId} = await room.getSelf()
shareInviteLink(`https://example.com/join#${inviteRoomId}`)

// Only 'admin' and 'player' roles can submit game moves
const betAction = room.makeAction('bet', {roles: ['admin', 'player']})

// Shared table state that only the admin can mutate
const tableState = room.makeState('table', {pot: 0}, {roles: ['admin']})

room.onUserJoin = async ({userId}) => {
  if (await isUserOnAllowlist(userId)) {
    // Issue a cryptographically signed role certificate broadcast to the whole room
    await room.grantRole(userId, 'player')
  } else {
    // Cryptographically ban the user across the entire mesh/overlay
    await room.ban(userId, {reason: 'Not on the table allowlist'})
  }
}
```

```js
// --- Joining Participant ---
const room = joinRoom(
  {
    appId: 'poker-club',
    use: [roles()]
  },
  inviteRoomIdFromUrl
)

await room.ready

const betAction = room.makeAction('bet', {roles: ['admin', 'player']})
const tableState = room.makeState('table', {pot: 0}, {roles: ['admin']})

tableState.onChange = (value, previousValue, {userId}) => {
  console.log(`Table updated by ${userId}:`, value)
}

// Inspect current roles when updating your UI
const myRoles = room.getRoles()
```

---

### Scenario 4: External Identity & Backend Authority Integration

If your app already has an authentication system or backend, you can bridge it
directly into Trystero in two ways:

#### A. Portable User Identities Across Devices (`config.identity`)

Store the user's serialized ECDSA P-256 identity keypair in your database or
vault so the user has the exact same unforgeable `userId` across their laptop,
phone, and browser tabs:

```js
import {
  joinRoom,
  createUserIdentity,
  exportUserIdentity,
  importUserIdentity
} from '@trystero-p2p/nostr'

const room = joinRoom(
  {
    appId: 'my-app',
    identity: async () => {
      const saved = await fetchIdentityFromBackend()
      if (saved) {
        return importUserIdentity(saved)
      }

      const fresh = await createUserIdentity()
      await saveIdentityToBackend(exportUserIdentity(fresh))
      return fresh
    }
  },
  'room-1'
)
```

#### B. Server-Side Admin

Create a user identity with `await createUserIdentity()` and store its exported
`userKey` (`exportUserIdentity(identity)`) securely on your backend. Restore it
with `const serverIdentity = await importUserIdentity(savedUserKey)` and pass
`identity: serverIdentity` when the backend joins the room with an RTC polyfill.
Guests can trust its `userId` on a fixed room name using
`use: [roles({admins: [serverIdentity.userId]})]`, or use a self-certifying room
ID (`` `${baseRoomId}~${serverIdentity.userId}` ``) along with `use: [roles()]`.

The backend can issue roles with `room.grantRole()` while it is connected. There
is no public standalone role-certificate import API in this beta.

---

### Scenario 5: App-Level Profile or Version Handshakes

If you previously exchanged application versions or user profiles during
`onPeerHandshake`, use a request action after a user joins. This exchanges
application data after admission; it does not reject the connection before
`onUserJoin`. Protect privileged actions with `roles` and use room passwords
where appropriate.

`makeState(namespace, initialValue, config)` holds one shared value per
namespace, with admin-only writes by default. It is not a per-user writable
key-value store. Use `state.set(value)` and `state.onChange` for authoritative
shared state.

```js
const hello = room.makeAction('hello', {kind: 'request'})

hello.onRequest = async (req, {userId}) => {
  return {appVersion: '2.1.0', supportedFeatures: ['voice', 'canvas']}
}

room.onUserJoin = async ({userId}) => {
  const info = await hello.request({appVersion: '2.1.0'}, {target: userId})
  if (info.appVersion !== '2.1.0') {
    console.warn(`User ${userId} is on a different version: ${info.appVersion}`)
  }
}
```
