# Changelog

## [0.26.0](https://github.com/dmotz/trystero/releases/tag/0.26.0) - 2026-10-04

### Improvements

- Added `onReceive` callbacks to accept or decline incoming messages, requests,
  and responses based on payload size, sender, or metadata. Callbacks can return
  a boolean or a promise; large payloads wait for approval before sending their
  contents.
- Added `maxReceiveBytes` to room config, with a default receive budget of 256
  MiB. Concurrent large transfers queue automatically when the budget is
  occupied.
- Reduced idle resource use by creating connection offers on demand instead of
  keeping prewarmed peer connections.
- 🐦 Nostr - updated default relays and improved subscription retries and
  discovery recovery after relay reconnects.
- 📡 MQTT - batched subscriptions and updated the default relay list.
- 🔌 WebSocket relay - added configurable topic and subscription limits to
  prevent resource exhaustion.

### Fixes

- Peers now recover more reliably from missed signaling messages, with automatic
  offer retries and replayed answers.
- Fixed stale peers after quick room rejoins, failed sends, and long idle
  periods.
- Fixed stream removal, track replacement, and media delivery when rejoining
  rooms that share peer connections.
- Fixed renegotiation conflicts and stale offers that could interrupt
  established connections.
- 🌊 Torrent - fixed slow connection setup and stale offers, while preserving
  support for delayed STUN/TURN candidates.
- ⚡️ Supabase - rooms now use the correct project URL and key when connecting to
  multiple projects.
- Hardened incoming data and ICE candidate handling with bounded queues, payload
  validation, and cleanup of stalled transfers. Thanks to @seyung56-hue for
  reporting.

### ⚠️ Breaking changes

- Incoming payloads now have a default limit of 256 MiB. Set `maxReceiveBytes`
  to a larger value if your app receives larger files.
- The action wire format has changed internally. Upgrade all peers communicating
  with each other to the latest package version.

## [0.25.4](https://github.com/dmotz/trystero/releases/tag/0.25.4) - 2026-08-30

This release has many optimizations without breaking API changes and
significantly reduces resources on both relays and your app clients. It's
recommended to upgrade to this release as soon as possible.

### Improvements

- Reduced signaling traffic across all strategies. Rooms retain their fast
  startup announcement burst, then switch to a slower steady cadence.
- 🌊 **Torrent** now honors tracker-requested announcement intervals and keeps
  passive rooms registered at a low rate.
- 🐦 **Nostr** now handles relay failures more intelligently: rate-limited
  relays are backed off, incompatible relays are dropped, and the default relay
  list has been pruned. This will result in less console spam when relays are
  not working.
- Relay-backed strategies now restore subscriptions, presence, and announcements
  more reliably after reconnecting.
- Custom topic strategies can configure `steadyAnnounceIntervalMs` and
  `reannounceOnDisconnect`.

## [0.25.3](https://github.com/dmotz/trystero/releases/tag/0.25.3) - 2026-07-13

### Improvements

- 🌊 **Torrent** - new default tracker `open.ftorrent.com`, thanks to @zootella
- New `relayConfig` field: `warnOnRelayFailure`. Set this to `false` to silence
  warnings caused by relay failures. Suggested by @steve02081504

## [0.25.2](https://github.com/dmotz/trystero/releases/tag/0.25.2) - 2026-06-11

### Fixes

- Fixed issue where leaving rooms would cause recreated and orphaned sockets
  (thanks to @peitschie for reporting)

## [0.25.1](https://github.com/dmotz/trystero/releases/tag/0.25.1) - 2026-05-26

### Fixes

- Nostr - subscriptions are now restored automatically after relay socket
  reconnects (thanks to @peitschie for contributing)
- Relay sockets now reconnect more reliably, with capped/jittered backoff to
  avoid long retry delays
- Announce failures are now caught and logged without stopping future announce
  attempts

## [0.25.0](https://github.com/dmotz/trystero/releases/tag/0.25.0) - 2026-05-25

### Improvements

- Actions have a new object-based API with request/response support.
  `makeAction()` now returns an action object with `send()`,
  `onMessage/onRequest`, `request()`, `requestMany()`, and progress hooks
  depending on the action kind. Thanks to @Abdullah-Azbah for writing the
  initial request/response proposal.
- Added `passive` room mode for backup peers. Passive rooms stay dormant until
  they hear an active peer, avoid connecting to other passive peers, and
  deactivate again when active work is done. This should make
  standby/server-side peers much cheaper to keep around. You can use these peers
  for syncing persisted data. Thanks to @tionis for adding this.
- `onJoinError` will now report cases where peers exchange SDP but cannot
  establish a WebRTC connection, which usually means TURN servers are needed or
  misconfigured.
- Media APIs now use options objects, matching the new action API shape. This
  makes targeted sends and metadata clearer across streams, tracks, and
  replacements.
- Added `createTopicStrategy()` that makes writing custom pub/sub signaling
  strategies even simpler. `createStrategy()` is still available as the
  lower-level API for protocols that need more control.
- Nostr subscriptions are now batched, and Torrent passive rooms announce less
  aggressively while dormant.

### ⚠️ Breaking changes

`room.makeAction()` no longer returns `[send, receive, progress]`. It now
returns an action object:

```js
const drink = room.makeAction('drink')

drink.send({drink: 'negroni'}, {target: peerId})

drink.onMessage = (data, {peerId}) => {
  console.log('got drink from', peerId, data)
}
```

Request/response actions can be created with kind: 'request':

```js
const isEven = room.makeAction('isEven', {
  kind: 'request',
  onRequest: n => n % 2 === 0
})

const result = await isEven.request(42, {
  target: peerId,
  timeoutMs: 1000
})
```

Room event handlers are now nullable callback properties instead of registration
functions:

```js
room.onPeerJoin = peerId => console.log(`${peerId} joined`)
room.onPeerLeave = peerId => console.log(`${peerId} left`)
room.onPeerStream = (stream, peerId, metadata) => {}
room.onPeerTrack = (track, stream, peerId, metadata) => {}
```

Media targeting and metadata now use options objects:

```js
room.addStream(stream, {
  target: peerId,
  metadata: {kind: 'screen'}
})
```

The same shape applies to `removeStream()`, `addTrack()`, `removeTrack()`, and
`replaceTrack()`.

This will require existing codebases to migrate syntax when upgrading to 0.25.0.

## [0.24.0](https://github.com/dmotz/trystero/releases/tag/0.24.0) - 2026-04-27

### Improvements

- 🔌 Added a self-hosted WebSocket relay package (`@trystero-p2p/ws-relay`). See
  the [docs](https://github.com/dmotz/trystero#self-hosted-websocket-relay) for
  how to run the server and connect from browsers. If anyone is interested in
  running a public relay for Trystero users, get in touch.
- Peers will usually connect faster now due to a more proactive announce cycle
  (thanks @rogersanick)

### Fixes

- Stream events will now fire correctly on cross-room peers that have shared
  connections

### ⚠️ Breaking changes

- As part of the `ws-relay` addition, relay-specific options have been
  consolidated under the `relayConfig` field of the config object passed to
  `joinRoom()`. For example:
  ```javascript
  joinRoom(
    {
      appId: 'my-app',
      password: 'foobar',
      relayConfig: {redundancy: 5}
    },
    'room-id'
  )
  ```

Some fields have been renamed, so check the
[docs](https://github.com/dmotz/trystero#joinroomconfig-roomid-callbacks). This
cleans up the shape of the config object and keeps types simpler as different
strategies use different types of configs.

## [0.23.1](https://github.com/dmotz/trystero/releases/tag/0.23.1) - 2026-04-21

### Improvements

- **🌊 Torrent** - Fixed issues with connecting to trackers running on
  [aquatic](https://github.com/greatest-ape/aquatic)
- **🐦 Nostr** - Removed dead default relays

## [0.23.0](https://github.com/dmotz/trystero/releases/tag/0.23.0) - 2026-03-23

This version marks Trystero's biggest update since initial release. The
internals have been completely rewritten with minimal changes to the public API.
You'll find faster, more robust peering thanks to connection sharing and offer
recycling behind the scenes. The test suite has been expanded and hardened and
now tests server-side use too. Trystero also has a new public face at
[trystero.dev](https://trystero.dev/).

**User-facing changes**

- Trystero is now split into scoped packages:
  `@trystero-p2p/{nostr,mqtt,torrent,supabase,firebase,ipfs}` plus
  `@trystero-p2p/core`. The root `trystero` package still defaults to Nostr.
- `trystero/<strategy>` imports are now deprecated compatibility entry points;
  migrate to `@trystero-p2p/<strategy>` for non-default strategies.
- `joinRoom(config, roomId, onJoinError)` is now
  `joinRoom(config, roomId, callbacks)`. `onJoinError` moved to
  `callbacks.onJoinError`, and Nostr/Torrent’s old relay-reconnection flag moved
  into `config.manualRelayReconnection`.
- `joinRoom()` gained a new admission-handshake layer via
  `onPeerHandshake(peerId, send, receive, isInitiator)` and
  `handshakeTimeoutMs`, so apps can accept or reject peers before they become
  visible to `getPeers()`, `onPeerJoin()`, actions, or media callbacks. You can
  use this to implement your own custom identity layer with crypto keys.
- `trickleIce` is now a public config option and speeds up initial connections.
  Most strategies default to trickle ICE, while Torrent and IPFS keep it off
  unless explicitly enabled.
- `@trystero-p2p/core` now exposes `createStrategy` and shared types/utilities,
  making custom signaling strategies a supported extension point. You can use
  this to run a signaling relay for Trystero on any software you want. The
  readme shows a basic example using a simple WebSocket server.
- Media and event ergonomics improved: `replaceTrack()` can now send metadata,
  `onPeerJoin()` immediately replays already-active peers to late listeners, and
  the action name limit increased from 12 bytes to 32 bytes.
- Firebase’s `getOccupants()` helper was removed. This was only used by a single
  strategy and removing it helps keep the API surface small. You can still
  replicate its functionality with the Firebase API directly.
- Server-side use is now a more explicit part of the public surface:
  `rtcPolyfill` is documented/tested, and a recommended polyfill library
  endorsement for `werift`.

**Performance and reliability notes**

- Peer connection reuse is the biggest runtime change: when the same remote peer
  appears in multiple rooms, Trystero now reuses a shared underlying
  `RTCPeerConnection` instead of renegotiating per room. Offer pooling/reuse was
  overhauled, especially for tracker-style signaling, so old offers can be
  reclaimed and recycled instead of constantly allocating fresh peer
  connections.
- Large and binary sends are more resilient under backpressure, with fixes for
  stalled sends and related data-channel hangs.
- Relay robustness new public relay lists and better handling of repeated
  pings/timeouts, which should reduce churn and improve matchmaking stability.

Please share feedback, ideas, and of course, what you build with Trystero, via
GitHub discussions/issues. Go forth and build a decentralized web. 🤝

## [0.22.0](https://github.com/dmotz/trystero/releases/tag/0.22.0) - 2025-10-11

### Breaking changes

- **🪐 IPFS** - removed `libp2pConfig` config option

### Improvements

- **🐦 Nostr and 🌊 BitTorrent** - new `manualRelayReconnection` boolean flag in
  config object, which will disable Trystero's automatic relay socket
  reconnection behavior. This is paired with two top level package exports
  `pauseRelayReconnection()` and `resumeRelayReconnection()`, which allows you
  to control when Trystero auto-reconnects sockets. Additionally, Trystero will
  no longer attempt to reconnect sockets when the browser appears to be offline.
  Thanks to @vrtmrz for implementing.
- **🪐 IPFS** - updated strategy, now reliably working and passing test suite

## [0.21.8](https://github.com/dmotz/trystero/releases/tag/0.21.8) - 2025-09-03

- The default bundle size is now **20% smaller**, down to 8K minified 🤏
- 🐦 **Nostr** - updated default relays

## [0.21.7](https://github.com/dmotz/trystero/releases/tag/0.21.7) - 2025-08-19

- Improved reconnection rates when leaving and rejoining rooms, thanks to
  @jeremyckahn
- Improved type definitions

## [0.21.4](https://github.com/dmotz/trystero/releases/tag/0.21.4) - 2025-05-25

### Improvements

- Improved WebRTC connection logic in core peer module — this should improve
  connection success rates
- Default bundle size (Nostr) is now 40% smaller

## [0.21.3](https://github.com/dmotz/trystero/releases/tag/0.21.3) - 2025-04-19

### Bug fixes

- This release fixes a regression in 0.21.2 that causes connection issues in
  browsers

## [0.21.2](https://github.com/dmotz/trystero/releases/tag/0.21.2) - 2025-04-17

### Improvements

- 📣 Trystero now works server-side in Node, Deno, and Bun. See
  [this section](https://github.com/dmotz/trystero?tab=readme-ov-file#running-server-side-node-deno-bun)
  of the readme for details. Big thanks to @vrtmrz for figuring out the final
  piece of the server-side puzzle!
- **🐦 Nostr** - pruned dead default relays

## [0.21.1](https://github.com/dmotz/trystero/releases/tag/0.21.1) - 2025-04-04

### Improvements

- Fix for importing Nostr strategy in Node (note: Node support is still under
  development)

## [0.21.0](https://github.com/dmotz/trystero/releases/tag/0.21.0) - 2025-03-27

### Improvements

- New, modernized RTCPeerConnection abstraction
- Significantly smaller build sizes
- New `joinRoom()` config object options:
  - `rtcPolyfill` - Use this to pass a custom RTCPeerConnection-compatible
    constructor. This is useful for running outside of a browser, such as in
    Node (still experimental, not working yet).
  - `turnConfig` - Specifies a custom list of TURN servers to use (see
    [Connection issues](https://github.com/dmotz/trystero#connection-issues)
    section). Each item in the list should correspond to an
    [ICE server config object](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/RTCPeerConnection#iceservers).
    When passing a TURN config like this, Trystero's default STUN servers will
    also be used. To override this and use both custom STUN and TURN servers,
    instead pass the config via the above rtcConfig.iceServers option as a list
    of both STUN/TURN servers — this won't inherit Trystero's defaults.

## [0.21.0-beta.1 (prerelease)](https://github.com/dmotz/trystero/releases/tag/0.21.0-beta.1) - 2025-02-23

This beta release introduces a new, homegrown way of handling
`RTCPeerConnection` instances behind the scenes. Trystero previously used
simple-peer which is mostly unmaintained and showing its age. The new peer
management code uses modern techniques, makes the build significantly lighter,
and allows more flexibility for the project, like getting Trystero working in
Node (see the new `rtcPolyfill` option for details).

If you use Trystero in your projects, please test this new beta version and
report any issues you find. If you encounter a problem, be sure to confirm the
issue does not occur on the latest stable version (0.20.1) under the same
network conditions (e.g. peer A on network 1 <-> peer B on network 2).

Try this release via `npm i trystero@beta`.

## [0.20.1](https://github.com/dmotz/trystero/releases/tag/0.20.1) - 2025-02-15

### Improvements

- 🐦 **Nostr strategy** - Default relays are now chosen based on app ID to
  distribute Trystero connections more evenly
- Updated default relay lists across strategies
- Updated to latest dependency versions

## [0.20.0](https://github.com/dmotz/trystero/releases/tag/0.20.0) - 2024-07-27

### Breaking changes

- **🔐 Auto encrypted sessions** - SDPs are now always encrypted by default with
  a key derived from the app ID and room name. The key can be reverse engineered
  using these parameters, but it's better than flooding relays with plaintext
  session descriptions. For extra security, use a custom `password` argument.

### Improvements

- `makeAction()` now has referential equality when called multiple times with
  the same name argument. This makes it better suited for reactive frameworks.
  Thanks to @rogersanick for suggesting it.
- Room leave events should fire reliably in Firefox when a peer closes the
  window or refreshes. (#77)

## [0.19.0](https://github.com/dmotz/trystero/releases/tag/0.19.0) - 2024-07-09

### Improvements

- **Shared peering logic** - This release streamlines and consolidates all the
  different code for interfacing with strategy relays into a single place. This
  means that peering strategies are now much simpler and it's significantly
  easier to write new ones (or in future releases, mix and match strategies with
  the same group of peers). Previously, duplicated logic existed between various
  strategy modules, but going forward any fixes for deadlocks, race conditions,
  etc. will benefit all strategies.
- **More reliable/faster room entrance/exit events** - Joining, leaving, and
  re-joining rooms should be noticeably faster and more reliable due to the
  strategy logic overhaul.
- **Better support for SSR frameworks** - While it isn't working on Node quite
  yet (but getting closer), you can now import Trystero in Node without causing
  problems, which avoids the need for workarounds for shared code in SSR
  frameworks.
- **🪐 IPFS** - The IPFS strategy had been broken but is now working again.

### New features

- **⚡️ Supabase strategy** - A new connection strategy is now available using
  [Supabase](https://supabase.com), an open-source BaaS built on Postgres.
- **Incorrect password handling** - `joinRoom()` now accepts a third argument, a
  function that will be called if a user tries to join a room with a password
  that doesn't match other users
  ([docs](https://github.com/dmotz/trystero?tab=readme-ov-file#joinroomconfig-roomid-onerror)).

## [0.18.0](https://github.com/dmotz/trystero/releases/tag/0.18.0) - 2024-02-17

### New features

- **🐦 Nostr strategy** - A new connection strategy is now available using
  [Nostr](https://en.wikipedia.org/wiki/Nostr), a decentralized network protocol
  with many [public relays](https://nostr.watch/).
- **Unified relay API** - The BitTorrent, Nostr, and MQTT strategies now take
  `relayUrls` and `relayRedundancy`
  [options](https://github.com/dmotz/trystero?tab=readme-ov-file#joinroomconfig-namespace),
  so there is shared terminology across strategies and a smaller configuration
  API. These strategies also expose a `getRelaySockets()` function that returns
  a map of URLs to WebSockets.
- **Bug fix:** Action sender functions can now send empty strings
- Torrent tracker failures are now logged with their URLs

### Breaking changes

- **🌊 BitTorrent strategy**
  - `trackerUrls` has been renamed `relayUrls`
  - `trackerRedundancy` has been renamed `relayRedundancy`
  - `getTrackers()` has been renamed `getRelaySockets()`
- **📡 MQTT strategy**
  - `brokerUrls` has been renamed `relayUrls`
  - `brokerRedundancy` has been renamed `relayRedundancy`

## [0.17.0](https://github.com/dmotz/trystero/releases/tag/0.17.0) - 2024-02-03

### New features

- **📡 MQTT strategy** - A new connection strategy is now available using MQTT,
  an open protocol for IoT device communication. Thanks to @freehuntx for
  suggesting the approach.

## [0.16.0](https://github.com/dmotz/trystero/releases/tag/0.16.0) - 2023-11-26

- **(🪐 IPFS)** `swarmAddresses` in IPFS config has been replaced by
  `libp2pConfig`

## [0.15.2](https://github.com/dmotz/trystero/releases/tag/0.15.2) - 2023-11-26

- **(🪐 IPFS)** Overhauled IPFS strategy
- **(🔥 Firebase)** Updated to `firebase@^10.6.0`

## [0.15.1](https://github.com/dmotz/trystero/releases/tag/0.15.1) - 2023-11-22

- **(🔥 Firebase only)** fixed `getOccupants()`

## [0.15.0](https://github.com/dmotz/trystero/releases/tag/0.15.0) - 2023-11-19

- `joinRoom()` and `makeAction()` are now idempotent when called with the same
  namespaces which allows you to use them as React hooks. See the
  [readme](https://github.com/dmotz/trystero#react-hooks) for details. Thanks to
  @rogersanick for proposing a solution.

## [0.14.0](https://github.com/dmotz/trystero/releases/tag/0.14.0) - 2023-11-15

- The Firebase strategy now requires passing the full `databaseURL` as the
  `appId` to `joinRoom()` (either with or without the `https://` prefix), e.g.
  `'trystero-demo.firebaseio.com`, not just `'trystero-demo'`. This allows
  support for other regions which use different url structures. Thanks to
  @matthewjumpsoffbuildings for diagnosing and proposing a fix.

## [0.13.0](https://github.com/dmotz/trystero/releases/tag/0.13.0) - 2023-07-20

### New features

- `getTrackers()` **(🌊 BitTorrent only)** Returns an object of BitTorrent
  tracker URL keys mapped to their WebSocket connections. This can be useful for
  determining the state of the user's connection to the trackers and handling
  any connection failures. (Thanks to @jeremyckahn for implementing)

## [0.12.0](https://github.com/dmotz/trystero/releases/tag/0.12.0) - 2023-03-22

### Breaking changes

- `getPeers()` now returns a map of peer IDs to underlying `RTCPeerConnection`
  objects, previously returned an array of IDs (credit to @jeremyckahn for
  implementing)
