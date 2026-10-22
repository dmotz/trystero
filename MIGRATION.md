# Trystero 0.27.0 Migration Guide

Trystero **0.27.0** is a major architectural upgrade that brings **unforgeable user identities**, **multi-tab user presence**, **cryptographic room authority & state**, and **scalable multi-hop topologies** to every signaling strategy out of the box.

While this release introduces a few breaking changes to callback signatures, it unlocks capabilities that previously required complex application-level boilerplate—and eliminates subtle security and topology footguns.

---

## Why 0.27.0? What Changed Architecturally

1. **Users (`userId`) vs. Connections (`peerId`)**:
   Every participant now gets an unforgeable cryptographic `userId` alongside their per-connection `peerId`. By default, `userId` persists across page refreshes (`identity: 'session'`), can be persisted across browser restarts with a one-line config change (`identity: 'local'`), or can be loaded from your own backend. If a user opens multiple tabs, they share the same `userId` while each tab has its own `peerId`.
2. **`onUserJoin` / `onUserLeave` as the New Default**:
   Most applications care about *who* is in the room rather than how many browser tabs they have open. `onUserJoin` and `onUserLeave` fire once per unique user and automatically deduplicate multiple tabs.
3. **Out-of-the-Box Room Authority, Limits, and State**:
   Room capacity limits (`config.limit`), cryptographic admin ownership (`config.admin`), role-based access control (`grantRole`, `revokeRole`, `banPeer`), and synchronized key-value state (`room.makeState`) are now built into the core protocol.
4. **Scalable Multi-Hop Topologies**:
   Rooms are no longer restricted to full-mesh WebRTC (`O(N²)` connections). With `topology: 'auto'`, `'small-world'`, or `'tree'`, rooms can scale to hundreds of participants using multi-hop overlay routing with end-to-end cryptographic sender verification.

---

## Why `onPeerHandshake` Was Removed

`onPeerHandshake` was originally introduced as a **stopgap measure** while we explored the right out-of-the-box solution for peer authentication, room capacity limits, and admission control.

As Trystero evolved to support cryptographic identities and multi-hop topologies, keeping `onPeerHandshake` became a liability and a source of security footguns:

1. **False Sense of Security in Multi-Hop Topologies**:
   `onPeerHandshake` operated during the physical WebRTC connection setup. In scalable topologies (`'auto'`, `'small-world'`, `'tree'`), a peer only establishes physical WebRTC connections with a handful of 1-hop neighbors (`degree`), while communicating with everyone else over multi-hop overlay routing. A physical handshake gate would **never run** for 2+ hop peers—giving developers a false sense of security that they had gated the room when unverified peers could still route messages through neighbors.
2. **Unverified Signaling IDs**:
   Previously, `peerId` was just a random string announced over the signaling server. Using `onPeerHandshake` to check an allowlist of `peerId`s was vulnerable to spoofing on public relays unless developers hand-rolled their own public-key cryptography.
3. **Every Legitimate Use Case Now Has a Safer Native API**:
   - **Identity verification**: Handled automatically by self-certifying `userId` and `peerId` cryptographic handshakes and end-to-end signed overlay envelopes.
   - **Room capacity limits**: Handled natively by `joinRoom({limit: N})`, which properly accounts for multi-tab users (`userId`) without locking out a user who refreshes their page.
   - **Allowlists, roles, and moderation**: Handled cryptographically by `config.admin`, `room.grantRole()`, `authority` filters on `makeAction` / `makeState`, and `room.banPeer()`.
   - **Custom profile / app-version exchange**: Handled cleanly across both direct and multi-hop peers using `room.makeAction({kind: 'request'})` and `room.makeState()`.

---

## Breaking Changes & Before / After Migration

### 1. Presence Callbacks (`onUserJoin` / `onUserLeave` & `onPeerJoin` / `onPeerLeave`)

Callback registration now uses property assignment (matching the rest of the modern API) and passes a context object instead of a bare `peerId` string. Unless you specifically need to track individual browser tabs, migrate `onPeerJoin` / `onPeerLeave` to **`onUserJoin` / `onUserLeave`**.

#### Before (0.26.x)
```js
room.onPeerJoin(peerId => {
  console.log(`${peerId} joined`)
})

room.onPeerLeave(peerId => {
  console.log(`${peerId} left`)
})
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

### 2. Media Stream & Track Callbacks (`onPeerStream` / `onPeerTrack`)

`onPeerStream` and `onPeerTrack` now keep the media object(s) first and pass `{userId, peerId, metadata}` as a context object (matching `action.onMessage`).

#### Before (0.26.x)
```js
room.onPeerStream((stream, peerId, metadata) => {
  attachVideo(stream, peerId, metadata)
})

room.onPeerTrack((track, stream, peerId, metadata) => {
  attachTrack(track, stream, peerId, metadata)
})
```

#### After (0.27.0)
```js
room.onPeerStream = (stream, {userId, metadata}) => {
  attachVideo(stream, userId, metadata)
}

room.onPeerTrack = (track, stream, {userId, metadata}) => {
  attachTrack(track, stream, userId, metadata)
}
```

---

### 3. Action Callbacks (`makeAction`)

If you were already using the object-based `room.makeAction('type')` API, your existing `{peerId, metadata}` destructuring continues to work, and **`userId`** and **`roles`** are now automatically included in every callback context (`onMessage`, `onRequest`, `onReceive`, `onProgress`, `onReceiveProgress`).

If you were still using the legacy tuple destructuring (`const [send, get] = room.makeAction(...)`), migrate to the object API:

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

- **New `room.getUsers()`**: Returns a map of connected users (`Record<string, {peerIds: string[], roles: string[]}>`), excluding the local user. Use this for participant lists and UI rosters.
- **Updated `room.getPeers()`**: Instead of returning raw `RTCPeerConnection` objects directly (`Record<string, RTCPeerConnection>`), `getPeers()` now returns rich peer descriptors (`Record<string, PeerInfo>`), which works for both direct WebRTC neighbors and multi-hop overlay peers.
- **New `await room.getSelf()`**: Returns your own verified `{peerId, userId}`.

#### Before (0.26.x)
```js
import {selfId} from 'trystero'

const peers = room.getPeers() // { [peerId]: RTCPeerConnection }
const peerIds = Object.keys(peers)
```

#### After (0.27.0)
```js
// Get your own verified userId and peerId
const {userId: myUserId} = await room.getSelf()

// Get all other connected users in the room
const users = room.getUsers() // { [userId]: { peerIds: [...], roles: [...] } }

// Or inspect connection-level topology details (including RTCPeerConnection if direct)
const peers = room.getPeers() // { [peerId]: { userId, connection, direct, hops, roles } }
```

---

## Common Scenarios & Recipes in 0.27.0

### Scenario 1: Media & Data Fan-Out Across Multi-Tab Users

When a user connects from multiple tabs (or devices sharing an identity), they have one `userId` and multiple `peerId`s. Trystero routes traffic intelligently when you pass a `userId` as `target`:

- **Broadcast / Push (`action.send`, `room.addStream`, `room.addTrack`)**: Passing `target: userId` automatically **fans out** the payload or media stream to *every* active connection (`peerId`) belonging to that user.
- **Point-to-Point (`action.request`, `room.ping`)**: Passing `target: userId` deterministically routes to a single connection for that user so you receive a single response.

```js
const dm = room.makeAction('dm')
const profileRpc = room.makeAction('profile', {kind: 'request'})

// Fans out to all open tabs belonging to targetUserId
await dm.send({text: 'Hello across all your tabs!'}, {target: targetUserId})

// Streams audio/video to all open tabs belonging to targetUserId
room.addStream(localStream, {target: targetUserId})

// Queries a single tab belonging to targetUserId and awaits the reply
const profile = await profileRpc.request({fields: ['name', 'avatar']}, {target: targetUserId})
```

---

### Scenario 2: Room Capacity Limits (Replacing Handshake Slot Counters)

Previously, capping a room (for example, a 2-player game) required tracking peer counts inside `onPeerHandshake` and rejecting latecomers—which suffered from race conditions and locked out players who refreshed their browser tab.

In 0.27.0, pass `limit` to `joinRoom()`. Capacity is tracked by unique **`userId`**, so a player who refreshes their tab (or opens a second tab) reuses their existing user slot instead of locking themselves out:

```js
const room = joinRoom(
  {
    appId: 'chess-app',
    limit: 2, // Maximum 2 unique users
    identity: 'session' // Survives page refreshes (default)
  },
  roomId
)

room.onJoinError = ({error, message}) => {
  if (error === 'room full') {
    showModal('This match already has 2 players!')
  }
}
```

---

### Scenario 3: Allowlists, Roles, and Moderation (Replacing `onPeerHandshake` Auth)

Instead of gating physical connections with `onPeerHandshake`, 0.27.0 provides cryptographic **self-certifying rooms** (`admin: true`), **signed role certificates** (`grantRole`), **action/state authority gating**, and **signed bans** (`banPeer`) that work across both full-mesh and multi-hop topologies.

```js
// --- Host (Room Creator) ---
const room = joinRoom({appId: 'poker-club', admin: true}, 'table-1')

// Share room.id (which embeds the cryptographic admin public key fingerprint)
shareInviteLink(`https://example.com/join#${room.id}`)

// Only 'admin' and 'player' roles can submit game moves
const betAction = room.makeAction('bet', {authority: ['admin', 'player']})

// Shared table state that only the admin can mutate
const tableState = room.makeState('table', {authority: ['admin']})

room.onUserJoin = async ({userId}) => {
  if (await isUserOnAllowlist(userId)) {
    // Issue a cryptographically signed role certificate broadcast to the whole room
    await room.grantRole(userId, 'player')
  } else {
    // Cryptographically ban the user across the entire mesh/overlay
    await room.banPeer(userId, {reason: 'Not on the table allowlist'})
  }
}
```

```js
// --- Joining Participant ---
const room = joinRoom({appId: 'poker-club'}, inviteRoomIdFromUrl)

const betAction = room.makeAction('bet', {authority: ['admin', 'player']})
const tableState = room.makeState('table', {authority: ['admin']})

room.onRoleChange = ({userId, roles}) => {
  console.log(`User ${userId} now has verified roles:`, roles)
}

room.onBan = ({targetId, reason}) => {
  console.log(`Removed from room: ${reason}`)
}
```

---

### Scenario 4: External Identity & Backend Authority Integration

If your app already has an authentication system or backend, you can bridge it directly into Trystero in two ways:

#### A. Portable User Identities Across Devices (`config.identity`)
Store the user's serialized ECDSA P-256 identity keypair in your database or vault so the user has the exact same unforgeable `userId` across their laptop, phone, and browser tabs:

```js
import {
  joinRoom,
  createUserIdentity,
  exportUserIdentity,
  importUserIdentity
} from 'trystero/nostr'

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

#### B. Headless Backend Admin Issuing Role Certificates
Your backend can hold the room's admin private key (`createAdminIdentity` / `exportAdminIdentity`), while clients join the room with only the admin's `publicKey` (`admin: {publicKey}`). Even if the admin never joins the WebRTC room directly, any client can present a backend-signed `RoleCertificate` to prove their role to peers.

---

### Scenario 5: App-Level Profile or Version Handshakes

If you previously used `onPeerHandshake` to exchange application versions or user profile metadata upon connection, use a `request` action in `onUserJoin` or synchronized `makeState`:

```js
// Option A: Automatic per-user state via makeState
const profiles = room.makeState('profiles')

// Publish your own profile keyed by your userId
const {userId: myId} = await room.getSelf()
profiles.set(myId, {name: 'Alice', appVersion: '2.1.0'})

profiles.onUpdate = (userId, profile) => {
  console.log(`User ${userId} profile updated:`, profile)
}

// Option B: Direct request/response when a user joins
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
