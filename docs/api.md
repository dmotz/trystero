# API Reference

[← Back to README](../README.md)

Complete TypeScript and runtime reference for Trystero `0.27.0`.

## Contents

- [Packages & Entry Points](#packages--entry-points)
- [`joinRoom(config, roomId)`](#joinroomconfig-roomid)
- [`Room` Instance](#room-instance)
  - [Lifecycle & Inspection](#lifecycle--inspection)
  - [Presence & Error Subscriptions](#presence--error-subscriptions)
  - [`room.makeState(namespace, initialValue?, config?)`](#roommakestatenamespace-initialvalue-config)
  - [`room.makeUserState(namespace, initialValue?, config?)`](#roommakeuserstatenamespace-initialvalue-config)
  - [`room.makeAction(namespace, config?)`](#roommakeactionnamespace-config)
  - [Media Streams](#media-streams)
- [Room Plugins](#room-plugins)
  - [`roles(config?)` & `RolesPluginApi`](#rolesconfig--rolespluginapi)
  - [`scale(config?)` & `ScalePluginApi`](#scaleconfig--scalepluginapi)
- [User Identity Helpers](#user-identity-helpers)
  - [`createUserIdentity()`](#createuseridentity)
  - [`importUserIdentity(input)`](#importuseridentityinput)
  - [`exportUserIdentity(identity)`](#exportuseridentityidentity)
  - [`clearUserIdentity(appId)`](#clearuseridentityappid)
- [Relay Inspection & Connectivity](#relay-inspection--connectivity)
  - [`getRelaySockets()`](#getrelaysockets)
  - [`setRelayConnectivity(mode?)`](#setrelayconnectivitymode)
  - [`defaultRelayUrls`](#defaultrelayurls)
- [Self-Hosted WebSocket Relay Server (`@trystero-p2p/ws-relay/server`)](#self-hosted-websocket-relay-server-trystero-p2pws-relayserver)
  - [`createWsRelayServer(options?)`](#createwsrelayserveroptions)
- [Custom Strategy Authoring (`@trystero-p2p/core`)](#custom-strategy-authoring-trystero-p2pcore)
  - [`createTopicStrategy(adapter)`](#createtopicstrategyadapter)
  - [`createStrategy(adapter)`](#createstrategyadapter)
- [Errors & Core TypeScript Types](#errors--core-typescript-types)
  - [`RoomError` Codes](#roomerror-codes)
  - [`ActionError` Kinds](#actionerror-kinds)
  - [Payload & Listener Option Types](#payload--listener-option-types)

---

## Packages & Entry Points

Every strategy package exports the same room, plugin, identity, and TypeScript
type surface (see [Signaling & Relays](./signaling.md)):

| Package                                        | Exports                                                                                                                                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trystero` _(alias for `@trystero-p2p/nostr`)_ | `joinRoom`, `roles`, `scale`, `createUserIdentity`, `importUserIdentity`, `exportUserIdentity`, `clearUserIdentity`, `getRelaySockets`, `setRelayConnectivity`, `defaultRelayUrls`, + types |
| `@trystero-p2p/torrent`                        | Same as `trystero`                                                                                                                                                                          |
| `@trystero-p2p/ws-relay`                       | Same as `trystero` minus `defaultRelayUrls`                                                                                                                                                 |
| `@trystero-p2p/ws-relay/server`                | `createWsRelayServer`, + server types _(Node >= 22; requires `ws` peer dependency)_                                                                                                         |
| `@trystero-p2p/mqtt`                           | `joinRoom`, `roles`, `scale`, identity helpers, `getRelaySockets`, `defaultRelayUrls`, + types                                                                                              |
| `@trystero-p2p/supabase`                       | `joinRoom`, `roles`, `scale`, identity helpers, + types                                                                                                                                     |
| `@trystero-p2p/firebase`                       | `joinRoom`, `roles`, `scale`, identity helpers, + types                                                                                                                                     |
| `@trystero-p2p/core`                           | `createTopicStrategy`, `createStrategy`, `roles`, `scale`, identity helpers, `setRelayConnectivity`, relay/encoding utilities, + types                                                      |

---

## `joinRoom(config, roomId)`

Joins the local endpoint to `roomId` under `config.appId` and returns a `Room`
instance (typed with any plugin methods passed in `config.use`).

```ts
function joinRoom<
  const TPlugins extends readonly AnyRoomPlugin[] | undefined = undefined
>(
  config: JoinRoomConfig & {use?: TPlugins},
  roomId: string
): RoomWithPlugins<TPlugins>
```

> Calling `joinRoom(config, roomId)` while a room with the same
> `(appId, roomId)` is already active throws an `Error`. Call
> `await room.leave()` before rejoining the same room.

### `config` (`BaseRoomConfig` + strategy `relayConfig`)

| Option                | Type                                                      | Default                                         | Description                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------- | --------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`appId`**           | `string`                                                  | _Required_                                      | Globally unique identifier for your app. Because default public relays share a global namespace, use a domain you control (e.g. `'chess.example.com'` or `'example.com/chess'`) or `'<username>/<app-name>'` (e.g. `'oedipa/chess'`) to avoid room collisions. For `@trystero-p2p/supabase`, pass your Supabase Project URL; for `@trystero-p2p/firebase`, pass your Realtime Database `databaseURL`. |
| **`password`**        | `string`                                                  | `undefined`                                     | Shared secret used to derive an AES-256-GCM signaling key via `PBKDF2-SHA256` (`600,000` iterations). Must match across all participants in the room. See [Password-protected rooms](./identity.md#password-protected-rooms-configpassword).                                                                                                                                                          |
| **`identity`**        | `'local' \| 'none' \| UserIdentity \| UserIdentityLoader` | `'local'` _(browser)_, `'none'` _(non-browser)_ | Controls how the local user's `userId` keypair is loaded and persisted. See [Identity & Presence](./identity.md).                                                                                                                                                                                                                                                                                     |
| **`maxUsers`**        | `number`                                                  | `undefined`                                     | Positive integer setting an advisory per-peer cap on unique `userId`s (including the local user) in the peer's room view. Extra joiners receive `{code: 'room-full'}` on `room.onError`.                                                                                                                                                                                                              |
| **`use`**             | `readonly AnyRoomPlugin[]`                                | `undefined`                                     | Array of opt-in plugins created with [`roles()`](#rolesconfig--rolespluginapi) and/or [`scale()`](#scaleconfig--scalepluginapi).                                                                                                                                                                                                                                                                      |
| **`maxReceiveBytes`** | `number`                                                  | `268435456` _(256 MiB)_                         | Positive integer byte budget for incoming payloads and concurrent chunked transfers per room.                                                                                                                                                                                                                                                                                                         |
| **`passive`**         | `boolean`                                                 | `false`                                         | Listen for and answer active peers without broadcasting room presence announcements (ideal for [headless state backup peers](./server-side.md#always-on-shared-state-backup-passive-true)).                                                                                                                                                                                                           |
| **`relayConfig`**     | `object`                                                  | Strategy-dependent                              | Strategy-specific signaling relay options (see table below).                                                                                                                                                                                                                                                                                                                                          |
| **`turnConfig`**      | `TurnServerConfig[]`                                      | `undefined`                                     | Additional TURN ICE servers appended to `rtcConfig.iceServers` (or default STUN servers). See [NAT Traversal & Troubleshooting](./troubleshooting.md).                                                                                                                                                                                                                                                |
| **`rtcConfig`**       | `RTCConfiguration`                                        | Google & Cloudflare STUN                        | Custom [`RTCConfiguration`](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/RTCPeerConnection#parameters) passed to `RTCPeerConnection`.                                                                                                                                                                                                                                           |
| **`trickleIce`**      | `boolean`                                                 | `false` on `torrent`, `true` elsewhere          | Send ICE candidates incrementally (`true`) or bundled into the SDP (`false`).                                                                                                                                                                                                                                                                                                                         |
| **`rtcPolyfill`**     | `typeof RTCPeerConnection`                                | Global `RTCPeerConnection`                      | Custom WebRTC constructor (such as `werift`) for [Node, Bun, or Deno](./server-side.md).                                                                                                                                                                                                                                                                                                              |

### Strategy-specific `config.relayConfig` options

| Property             | Strategies                                                       | Type          | Description                                                                                          |
| -------------------- | ---------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------- |
| `urls`               | `nostr`, `mqtt`, `torrent` _(optional)_; `ws-relay` _(required)_ | `string[]`    | Custom relay/broker/tracker WebSocket URLs (`wss://`, or `ws://` for local `ws-relay`).              |
| `redundancy`         | `nostr` (`5`), `mqtt` (`4`), `torrent` (`3`)                     | `number`      | Number of built-in default relays to connect to in parallel (ignored if custom `urls` are supplied). |
| `warnOnRelayFailure` | All strategies                                                   | `boolean`     | Log console warnings when individual relays fail (`true` by default).                                |
| `supabaseKey`        | `supabase` _(required)_                                          | `string`      | Your Supabase project's `anon` `public` API key.                                                     |
| `firebaseApp`        | `firebase` _(optional)_                                          | `FirebaseApp` | Pre-initialized Firebase app instance (use when Firebase is already initialized in your app).        |
| `firebasePath`       | `firebase` _(optional)_                                          | `string`      | Root Realtime Database path for signaling data (`'__trystero__'` by default).                        |

---

## `Room` Instance

### Lifecycle & Inspection

#### `room.ready`

```ts
readonly ready: Promise<void>
```

Resolves once the local endpoint identity, `UserIdentity`, and any plugins in
`config.use` have finished initializing (`await room.getSelf()` also awaits
`room.ready`).

#### `room.leave()`

```ts
leave(): Promise<void>
```

Flushes departure notices, closes peer connections, unsubscribes all room
listeners, and releases shared relay leases (closing pooled relay sockets when
the last active room leaves).

#### `room.getSelf()`

```ts
getSelf(): Promise<SelfInfo>

type SelfInfo = {
  peerId: string // 20-char Base62 endpoint ID for this tab/instance
  userId: string // 22-char Base62 user ID
  identityPersistence: 'local' | 'none' | 'custom'
  roomId: string // Full room ID (includes `~<userId>` when `selfAsAdmin: true`)
  baseRoomId: string // Base room name without `~<userId>`
  isAdmin: boolean // Whether the local user is a verified root 'admin'
  roles: string[] // Verified roles currently held by the local user
}
```

#### `room.getUsers()`

```ts
getUsers(): Readonly<Record<string, UserInfo>>

type UserInfo = {
  peerIds: string[] // Active peerIds connected for this user
  roles: string[] // Verified roles held by this user
}
```

Returns a cached, frozen map of remote users currently in the room (excluding
the local user), keyed by `userId`.

#### `room.getPeers()`

```ts
getPeers(): Record<string, PeerInfo>

type PeerInfo = {
  userId: string
  connection: RTCPeerConnection | null // null for multi-hop peers (`hops >= 2`)
  direct: boolean // true for 1-hop WebRTC peers, false for multi-hop peers
  hops: number // 1 for direct peers, >= 2 for multi-hop overlay peers
  roles: string[]
}
```

Returns a map of connected remote endpoints (tabs/devices), keyed by `peerId`.

#### `room.ping(id)`

```ts
ping(id: string): Promise<number>
```

Measures round-trip latency in milliseconds to `id` (`userId` or `peerId`). When
passed a `userId`, deterministically pings one active endpoint of that user.

---

### Presence & Error Subscriptions

All room `on*` methods allow multiple independent listeners and return an
idempotent `Unsubscribe` (`() => void`) function. See
[Identity & Presence](./identity.md#event-subscriptions--cleanup).

```ts
onUserJoin(
  handler: (context: {userId: string; peerId: string; roles: string[]}) => unknown,
  options?: ReplayListenerOptions
): Unsubscribe

onUserLeave(
  handler: (context: {userId: string; peerId: string}) => unknown,
  options?: ListenerOptions
): Unsubscribe

onPeerJoin(
  handler: (context: {peerId: string; userId: string; roles: string[]}) => unknown,
  options?: ReplayListenerOptions
): Unsubscribe

onPeerLeave(
  handler: (context: {peerId: string; userId: string}) => unknown,
  options?: ListenerOptions
): Unsubscribe

onError(
  handler: (error: RoomError) => unknown,
  options?: ListenerOptions
): Unsubscribe
```

- `onUserJoin` fires on a remote user's **first** connected tab; `onUserLeave`
  fires when their **last** remaining tab disconnects.
- `onPeerJoin` / `onPeerLeave` fire for every individual tab/device connection.
- Pass `{replay: true}` on `onUserJoin` or `onPeerJoin` to synchronously emit
  already-connected users or peers upon subscribing.

---

### `room.makeState(namespace, initialValue?, config?)`

Creates or retrieves a synchronized shared JSON state container (`SharedState`).
See the [Shared & Per-User State guide](./state.md).

```ts
makeState<T = JsonValue>(
  namespace: string,
  initialValue?: null,
  config?: StateConfig<Widen<T> | null>
): SharedState<Widen<T> | null>

makeState<T>(
  namespace: string,
  initialValue: T & JsonSerializable<T>,
  config?: StateConfig<Widen<T>>
): SharedState<Widen<T>>
```

#### `StateConfig<T>`

- `roles?: string | readonly string[]` — _(Requires `roles()` in `use`)_ Allowed
  writer role(s), or `'*'` for any unbanned room member. Defaults to `['admin']`
  when `roles()` is loaded.
- `maxBytes?: number` — Max UTF-8 JSON byte size per value (default `16384`, max
  `65536`).
- `validate?: (next: T, context: StateChangeContext<T>) => boolean` —
  Synchronous validator run locally and on incoming remote records.

#### `SharedState<T>` methods

| Method     | Signature                                                                                                          | Description                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `get`      | `() => T`                                                                                                          | Returns the current state value (reference-stable for React `useSyncExternalStore`).                |
| `set`      | `(next: T \| ((prev: T) => T)) => Promise<void>`                                                                   | Applies optimistically locally, signs, and broadcasts (coalescing rapid calls over 40 ms).          |
| `getMeta`  | `() => StateChangeContext<T> \| null`                                                                              | Metadata of the latest update (`{prev, peerId, userId, roles, timestamp}`), or `null` if untouched. |
| `onChange` | `(handler: (value: T, context: StateChangeContext<T>) => unknown, options?: ReplayListenerOptions) => Unsubscribe` | Subscribes to verified state updates.                                                               |

---

### `room.makeUserState(namespace, initialValue?, config?)`

Creates or retrieves a presence-scoped, per-user JSON state container
(`UserState`) where each `userId` can only write or clear their own slot (up to
`32` namespaces and `64 KiB` total per `userId`). See
[Per-user state](./state.md#per-user-state-roommakeuserstate).

```ts
makeUserState<T = JsonValue>(
  namespace: string,
  initialValue?: null,
  config?: UserStateConfig<Widen<T> | null>
): UserState<Widen<T> | null>

makeUserState<T>(
  namespace: string,
  initialValue: T & JsonSerializable<T>,
  config?: UserStateConfig<Widen<T>>
): UserState<Widen<T>>
```

#### `UserStateConfig<T>`

- `roles?: string | readonly string[]` — _(Requires `roles()` in `use`)_
  Restricts which roles may publish to this namespace (open to all unbanned
  members by default).
- `maxBytes?: number` — Max UTF-8 JSON byte size per user entry (default
  `16384`, max `65536`).
- `validate?: (next: T, context: UserStateChangeContext<T>) => boolean` —
  Synchronous validator run locally and remotely.

#### `UserState<T>` methods

| Method     | Signature                                                                                                                           | Description                                                                                                         |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `get`      | `(id?: string) => T`                                                                                                                | Value for `id` (`userId` or `peerId`), or local user when called as `get()`. Returns `initialValue` if unpublished. |
| `getAll`   | `() => Readonly<Record<string, T>>`                                                                                                 | Frozen, reference-stable `{ [userId]: T }` snapshot of all active published entries (including yourself).           |
| `has`      | `(id?: string) => boolean`                                                                                                          | `true` if `id` (or local user with `has()`) currently has a published value.                                        |
| `set`      | `(next: T \| ((prev: T) => T)) => Promise<void>`                                                                                    | Updates local slot synchronously, signs, and broadcasts (flushed before `onUserJoin` on 1-hop peers).               |
| `clear`    | `() => Promise<void>`                                                                                                               | Clears local entry and broadcasts a signed removal tombstone.                                                       |
| `getMeta`  | `(id?: string) => UserStateChangeContext<T> \| null`                                                                                | `{prev, peerId, userId, roles, timestamp, self, online, removed}` or `null`.                                        |
| `onChange` | `(handler: (value: T \| undefined, context: UserStateChangeContext<T>) => unknown, options?: ReplayListenerOptions) => Unsubscribe` | Subscribes to updates and removals (`value` is `undefined` when `context.removed === true`).                        |

---

### `room.makeAction(namespace, config?)`

Creates or retrieves a typed message or request/response action (`namespace`
must be `1–32` non-null UTF-8 bytes; binary payloads arrive on receivers as
`Uint8Array`). See [Actions, RPC & File Transfers](./actions.md).

```ts
// One-way / broadcast / binary transfer action (default)
makeAction<T = DataPayload>(
  namespace: string,
  config?: {kind?: 'message'; roles?: string | readonly string[]}
): MessageAction<T>

// Request / response RPC action
makeAction<T = DataPayload, R = DataPayload>(
  namespace: string,
  config: {kind: 'request'; roles?: string | readonly string[]}
): RequestAction<T, R>
```

#### `MessageAction<T>` methods

```ts
type MessageAction<T = DataPayload> = {
  send: (data: T, options?: SendOptions) => Promise<void>
  readonly onMessage: (
    handler: (data: T, context: MessageContext) => unknown,
    options?: ListenerOptions
  ) => Unsubscribe
  readonly onReceive: (
    handler: (context: ActionReceiveContext) => boolean | Promise<boolean>,
    options?: ListenerOptions
  ) => Unsubscribe
  readonly onReceiveProgress: (
    handler: (progress: number, context: ActionProgressContext) => unknown,
    options?: ListenerOptions
  ) => Unsubscribe
}
```

#### `RequestAction<T, R>` methods

```ts
type RequestAction<T = DataPayload, R = DataPayload> = {
  request: (data: T, options: RequestOptions) => Promise<R>
  requestMany: (
    data: T,
    options: RequestManyOptions<R>
  ) => Promise<PeerResult<R>[]>
  readonly onRequest: (
    handler: (data: T, context: RequestContext) => R | Promise<R>,
    options?: ListenerOptions
  ) => Unsubscribe
  readonly onReceive: (
    handler: (context: ActionReceiveContext) => boolean | Promise<boolean>,
    options?: ListenerOptions
  ) => Unsubscribe
  readonly onReceiveProgress: (
    handler: (progress: number, context: ActionProgressContext) => unknown,
    options?: ListenerOptions
  ) => Unsubscribe
}
```

- **`SendOptions`**:
  `{target?: string | string[] | null, metadata?: JsonValue, onProgress?: ActionProgressHandler, signal?: AbortSignal}`
  _(Do not mutate binary buffers `> 16 KiB` passed to `send()` until its
  `Promise` settles.)_
- **`RequestOptions`**:
  `{target: string, metadata?: JsonValue, timeoutMs?: number, onProgress?: ActionProgressHandler, signal?: AbortSignal}`
- **`RequestManyOptions<R>`**:
  `{targets: string[], metadata?: JsonValue, timeoutMs?: number, onProgress?: ActionProgressHandler, onResult?: (result: PeerResult<R>) => void, signal?: AbortSignal}`
- **`PeerResult<R>`**:
  - `{peerId: string; userId: string; status: 'fulfilled'; value: R}`
  - `{peerId: string; userId: string; status: 'timeout'}`
  - `{peerId: string; userId: string; status: 'disconnected'}`
  - `{peerId: string; userId: string; status: 'rejected'; error: Error}`
- **`onRequest` and `onReceive`** allow one active handler per action at a time
  (call the returned `unsubscribe()` before registering a replacement). Attach
  `onReceive` before `onMessage` / `onRequest`.

---

### Media Streams

See [Audio, Video & Screen Sharing](./media.md).

```ts
addStream(
  stream: MediaStream,
  options?: {target?: PeerTarget; metadata?: JsonValue}
): Promise<void>

removeStream(
  stream: MediaStream,
  options?: {target?: PeerTarget}
): void

replaceTrack(
  oldTrack: MediaStreamTrack,
  newTrack: MediaStreamTrack,
  options?: {target?: PeerTarget}
): Promise<void>

onPeerStream(
  handler: (
    stream: MediaStream,
    context: {peerId: string; userId: string; metadata?: JsonValue}
  ) => unknown,
  options?: ReplayListenerOptions
): Unsubscribe
```

- `addStream` is idempotent: calling it again syncs added/removed tracks on
  `stream` and re-triggers `onPeerStream` on recipients if `metadata` changed.
- `replaceTrack` swaps tracks at the `RTCRtpSender` level without SDP
  renegotiation.

---

## Room Plugins

### `roles(config?)` & `RolesPluginApi`

Opt-in cryptographic room authority and moderation plugin. Pass in
`joinRoom({appId, use: [roles(config)]}, roomId)`. See
[Admins, Roles & Moderation](./roles.md).

```ts
function roles(config?: RolesConfig): RoomPlugin<'roles', RolesPluginApi>

type RolesConfig = {
  selfAsAdmin?: boolean // Appends `~<userId>` to roomId and makes local user root 'admin'
  admins?: readonly string[] // Trusted 22-character Base62 root admin userIds
}
```

Methods added to `room` (`RolesPluginApi`):

| Method         | Signature                                                                                        | Description                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `grantRole`    | `(targetId: string, role: string \| readonly string[]) => Promise<RoleCertificate>`              | Issues a signed custom role certificate to `targetId` (`userId` or `peerId`). Root `'admin'` only.                                      |
| `revokeRole`   | `(targetId: string, role?: string) => Promise<void>`                                             | Revokes `role` (or all custom roles if omitted) from `targetId`. Root `'admin'` only.                                                   |
| `getRoles`     | `(targetId?: string) => string[]`                                                                | Frozen array of verified roles held by `targetId` (or local user when omitted; wait for `await room.ready` before reading local roles). |
| `onRoleChange` | `(handler: (ctx: RoleChangeContext) => unknown, options?: ReplayListenerOptions) => Unsubscribe` | Fires `{userId, roles, previousRoles, local}` whenever a user's verified roles change.                                                  |
| `ban`          | `(targetId: string, options?: {reason?: string}) => Promise<void>`                               | Disconnects `targetId`, clears their custom roles, purges their state, and blocks reconnects. Root `'admin'` only.                      |
| `unban`        | `(targetId: string) => Promise<void>`                                                            | Lifts an active ban on `targetId`. Root `'admin'` only.                                                                                 |
| `isBanned`     | `(targetId: string) => boolean`                                                                  | Returns `true` if `targetId` is currently banned.                                                                                       |

---

### `scale(config?)` & `ScalePluginApi`

Experimental opt-in multi-hop gossip overlay plugin for rooms with dozens of
peers. Pass in `joinRoom({appId, use: [scale(config)]}, roomId)`. See
[Scaling Large Rooms](./scaling.md).

```ts
function scale(config?: ScaleConfig): RoomPlugin<'scale', ScalePluginApi>

type ScaleConfig = {
  maxDirectPeers?: number // Target direct WebRTC neighbors per peer (4..32, default: 6)
}
```

Method added to `room` (`ScalePluginApi`):

```ts
getTopology(): TopologySnapshot

type TopologySnapshot = {
  peerId: string
  directPeerIds: string[]
  roomPeerIds: string[]
  routes: Record<string, {nextHop: string; hops: number}>
  stats: {
    messagesSent: number
    messagesReceived: number
    messagesForwarded: number
    duplicatesDropped: number
    signatureFailures: number
  }
}
```

---

## User Identity Helpers

See [Identity, Presence & Room Access](./identity.md).

### `createUserIdentity()`

```ts
function createUserIdentity(): Promise<UserIdentity>
```

Generates a fresh extractable ECDSA P-256 `UserIdentity`
(`{userId, signPubJwk, sign, persistence}`).

### `importUserIdentity(input)`

```ts
function importUserIdentity(input: string | JsonWebKey): Promise<UserIdentity>
```

Imports a `UserIdentity` from an exported `trystero_uk_...` string or a P-256
private `JsonWebKey`. Rejects if the key material is invalid.

### `exportUserIdentity(identity)`

```ts
function exportUserIdentity(identity: UserIdentity): string
```

Serializes an extractable `UserIdentity` as a compact `trystero_uk_...` string
for saving in custom storage or environment variables. Throws if called on a
non-extractable browser `'local'` identity.

### `clearUserIdentity(appId)`

```ts
function clearUserIdentity(appId: string): Promise<void>
```

Deletes the stored `'local'` `UserIdentity` in `IndexedDB` and clears in-memory
identity caches for `appId` (call `await room.leave()` first if currently in a
room).

---

## Relay Inspection & Connectivity

See [Signaling & Relays](./signaling.md#customizing-relay-urls--redundancy).

### `getRelaySockets()`

```ts
function getRelaySockets(): Record<string, WebSocket>
```

_(Exported by `trystero` / `nostr`, `mqtt`, `torrent`, and `ws-relay`)_ Returns
currently open relay URLs mapped to their `WebSocket` instances.

### `setRelayConnectivity(mode?)`

```ts
function setRelayConnectivity(
  mode?: 'online' | 'offline' | 'auto'
): 'online' | 'offline' | 'auto'
```

_(Exported by `trystero` / `nostr`, `torrent`, `ws-relay`, and `core`)_ Reads
(when called with no arguments) or sets process-wide relay socket connectivity:
`'offline'` closes sockets and holds reconnection, `'online'` reconnects
immediately under manual control, and `'auto'` (default) follows browser
`online`/`offline` events.

### `defaultRelayUrls`

```ts
const defaultRelayUrls: string[]
```

_(Exported by `trystero` / `nostr`, `mqtt`, and `torrent`)_ Built-in list of
public relay/broker/tracker URLs used when `relayConfig.urls` is not set.

---

## Self-Hosted WebSocket Relay Server (`@trystero-p2p/ws-relay/server`)

### `createWsRelayServer(options?)`

Starts (or attaches) a lightweight pub/sub WebSocket signaling server on Node
(requires the `ws` peer dependency). See
[Self-hosted WebSocket relay](./signaling.md#self-hosted-websocket-relay-trystero-p2pws-relay).

```ts
function createWsRelayServer(options?: WsRelayServerOptions): WsRelayServer
```

- **Key `WsRelayServerOptions`**: Standard `ws` `WebSocketServer` options
  (`port` default `8080`, `host`, `server`, `noServer`, `path`, `maxPayload`
  default `256 KiB`, `verifyClient`, etc.) plus:
  - `maxTopicLength?: number` (default `256`)
  - `maxSubscriptionsPerSocket?: number` (default `128`)
  - `maxSubscriptions?: number` (default `10000`)
  - `maxMessagesPerSecond?: number` (default `200`; pass `Infinity` to disable)
  - `maxBurstMessages?: number` (default `max(256, maxMessagesPerSecond * 2)`;
    pass `Infinity` to disable)
  - `onError?: (err: Error) => void`
- **Returns `WsRelayServer`**:
  - `wss: WsServerLike` — Underlying `WebSocketServer`
  - `ready: Promise<void>` — Resolves when listening (or rejects on startup
    error)
  - `address: () => WsAddressInfo | string | null`
  - `close: () => Promise<void>`
  - `publish: (topic: string, payload: JsonValue) => void`
  - `getSubscriberCount: (topic?: string) => number`

---

## Custom Strategy Authoring (`@trystero-p2p/core`)

See
[Writing your own signaling strategy](./signaling.md#writing-your-own-signaling-strategy-createtopicstrategy).

### `createTopicStrategy(adapter)`

Recommended builder for pub/sub signaling backends. Handles topic hashing,
`passive` mode, SDP encryption, announce bursts, and peer-inbox routing
automatically.

```ts
function createTopicStrategy<
  TRelay,
  TConfig extends BaseRoomConfig = JoinRoomConfig
>(adapter: TopicStrategyAdapter<TRelay, TConfig>): JoinRoom<TConfig>

type TopicStrategyAdapter<
  TRelay,
  TConfig extends BaseRoomConfig = JoinRoomConfig
> = {
  defaultConfig?: Partial<TConfig>
  steadyAnnounceIntervalMs?: number // default: 60000
  reannounceOnDisconnect?: boolean // default: true
  init: (config: TConfig) => MaybePromise<TRelay> | Array<MaybePromise<TRelay>>
  subscribeTopic: (
    relay: TRelay,
    topic: string,
    onMessage: (topic: string, msg: StrategyMessage) => void | Promise<void>,
    context: TopicSubscriptionContext
  ) => MaybePromise<() => void>
  publishTopic: (
    relay: TRelay,
    topic: string,
    msg: StrategyMessage,
    context: TopicPublishContext
  ) => MaybePromise<AnnounceResult | void>
}
```

### `createStrategy(adapter)`

Lower-level strategy builder for non-pub/sub protocols (like BitTorrent
trackers) that exchange pre-generated encrypted SDP offers (`getOffers(n)`).

```ts
function createStrategy<
  TRelay,
  TConfig extends BaseRoomConfig = JoinRoomConfig
>(adapter: StrategyAdapter<TRelay, TConfig>): JoinRoom<TConfig>
```

`@trystero-p2p/core` also exports helper utilities used by official strategy
packages: `hashTopic`, `createRelayManager`, `createRelayScopedStore`,
`getRelays`, `makeSocket`, `toJson`, `fromJson`, `encodeBytes`, `genId`,
`mkErr`, `unrefTimer`, and `libName`.

---

## Errors & Core TypeScript Types

### `RoomError` Codes

Emitted asynchronously to `room.onError(err => ...)`. Every `RoomError` includes
`{code, message, appId, roomId, cause?}` plus variant-specific fields:

| `err.code`              | Extra fields                                 | Meaning                                                                                                                                                      |
| ----------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `'room-full'`           | `peerId: string`                             | Remote peer refused admission because its view reached `config.maxUsers` (check `Object.keys(room.getPeers()).length === 0` to detect local join rejection). |
| `'banned'`              | `peerId?: string; reason?: string`           | Local user was kicked mid-session or refused during handshake due to `room.ban()`.                                                                           |
| `'decrypt-failed'`      | `peerId: string; stage: 'offer' \| 'answer'` | Signaling SDP failed AES-GCM decryption (typically a mismatched room `password`).                                                                            |
| `'peer-connect-failed'` | `peerId: string; turnConfigured: boolean`    | Peers exchanged SDP via signaling, but WebRTC ICE failed to connect (configure `turnConfig`).                                                                |
| `'relay-failed'`        | —                                            | Every configured signaling relay failed initial connection/subscription.                                                                                     |
| `'identity-failed'`     | —                                            | Local endpoint or `config.identity` initialization failed.                                                                                                   |
| `'plugin-failed'`       | `plugin?: string`                            | A plugin in `config.use` (`'roles'` or `'scale'`) encountered a setup or runtime error.                                                                      |
| `'handshake-failed'`    | `peerId: string`                             | Peer public-key / DTLS fingerprint verification or admission timed out or failed.                                                                            |
| `'peer-error'`          | `peerId: string`                             | Active peer encountered an unrecoverable wire-protocol or transport error and disconnected.                                                                  |

### `ActionError` Kinds

Rejected promises from `action.send()` and `action.request()` throw an
`ActionError` (`Error & {readonly kind: ActionErrorKind}`):

- `'timeout'` — `request()` exceeded `timeoutMs` or transfer stalled
- `'disconnected'` — Target was not connected or disconnected mid-operation
- `'aborted'` — Cancelled via `options.signal` (`AbortSignal`)
- `'rejected'` — Declined by receiver's `onReceive` gate, or remote `onRequest`
  handler threw an `Error`

### Payload & Listener Option Types

```ts
type JsonPrimitive = null | string | number | boolean
type JsonValue = JsonPrimitive | JsonValue[] | {[key: string]: JsonValue}
type DataPayload = JsonValue | Blob | ArrayBuffer | ArrayBufferView
type PeerTarget = string | string[] | null
type Unsubscribe = () => void

type ListenerOptions = {
  once?: boolean
  signal?: AbortSignal
}

type ReplayListenerOptions = ListenerOptions & {
  replay?: boolean
}
```
