# Authoring Trystero Plugins

Trystero's plugin API lets you extend `joinRoom()` with custom peer-to-peer
capabilities—such as CRDT document synchronization (Yjs, Automerge), spatial
audio, custom state engines, or telemetry—that work across **every signaling
strategy** (`nostr`, `torrent`, `mqtt`, `firebase`, `supabase`, `ws-relay`) and
across both direct WebRTC meshes and multi-hop `scale()` topologies.

Built-in plugins (`scale()` and `roles()`) use the exact same `definePlugin` and
`RoomKernel` primitives documented in this guide.

---

## Table of Contents

1. [How Plugins Work](#how-plugins-work)
2. [Quick Start](#quick-start)
3. [Plugin Lifecycle (`definePlugin`)](#plugin-lifecycle-defineplugin)
4. [Wire Communication (`makeInternalAction` vs `makeAction`)](#wire-communication-makeinternalaction-vs-makeaction)
5. [`RoomKernel` API Reference](#roomkernel-api-reference)
6. [Interoperating with `roles()` and `scale()`](#interoperating-with-roles-and-scale)
7. [Complete Example: Yjs CRDT Plugin](#complete-example-yjs-crdt-plugin)
8. [Best Practices & Packaging](#best-practices--packaging)

---

## How Plugins Work

A Trystero plugin is created with `definePlugin(name, spec)` from
`@trystero-p2p/core` (also re-exported by every strategy package).

`definePlugin` returns a clean, JSON-serializable `RoomPlugin<TName, TApi>`
descriptor (`{name}`) with non-enumerable setup metadata. Pass plugins to
`joinRoom()` via the `use` config array:

```ts
import {joinRoom, scale, roles} from 'trystero'
import {myPlugin} from 'trystero-my-plugin'

const room = joinRoom(
  {
    appId: 'my-app',
    use: [scale('gossip'), roles({selfAsAdmin: true}), myPlugin({option: 123})]
  },
  'room-1'
)

await room.ready
```

TypeScript automatically infers the return type of `joinRoom()`
(`RoomWithPlugins`) from the plugins passed in `use`, merging each plugin's
`TApi` (such as `room.getTopology()` from `scale()`, `room.makeState()` /
`room.grantRole()` / `room.ban()` from `roles()`, or custom methods from
third-party plugins) onto the returned `Room` type. Plugin `setup()` runs and
attaches these methods onto `room` when `await room.ready` (or
`await room.getSelf()`) resolves. If a plugin is not imported by the
application, bundlers completely tree-shake it from the final bundle.

---

## Quick Start

Install `@trystero-p2p/core` as a dependency or peer dependency and call
`definePlugin`:

```ts
import {definePlugin, type RoomPlugin} from '@trystero-p2p/core'

export interface HeartbeatOptions {
  intervalMs?: number
}

export interface HeartbeatRoomApi {
  getLastSeen: (peerId: string) => number | undefined
}

export const heartbeat = (
  options: HeartbeatOptions = {}
): RoomPlugin<'heartbeat', HeartbeatRoomApi> =>
  definePlugin('heartbeat', {
    setup(kernel) {
      const intervalMs = options.intervalMs ?? 5_000
      const lastSeen = new Map<string, number>()

      // Create an internal control channel (sent as '@_hb' on the wire)
      const hbAction = kernel.makeInternalAction<number>('hb')

      hbAction.onMessage((timestamp, peerId) => {
        lastSeen.set(peerId, timestamp)
      })

      const timer = setInterval(() => {
        void hbAction.send(Date.now())
      }, intervalMs)

      kernel.onPeerDeactivated(peerId => {
        lastSeen.delete(peerId)
      })

      kernel.onLeave(() => {
        clearInterval(timer)
        lastSeen.clear()
      })

      // Any methods returned here are merged onto the `room` instance
      return {
        getLastSeen: (peerId: string) => lastSeen.get(peerId)
      }
    }
  })
```

---

## Plugin Lifecycle (`definePlugin`)

```ts
definePlugin<TName, TApi>(name, {
  resolveRoomId?(context): Promise<{effectiveRoomId: string; state?: unknown}> | undefined,
  setup(kernel, preResolvedState?): TApi | void
})
```

### 1. `resolveRoomId` _(optional, pre-signaling)_

Runs asynchronously **before** the signaling strategy derives topic hashes or
announces to relays. Most plugins do not need this hook; use it only if your
plugin needs to:

- Transform or validate the room ID before topic subscription (for example,
  `roles({selfAsAdmin: true})` appends a 22-character self-certifying
  fingerprint `<roomId>~<fingerprint>`).
- Pre-compute asynchronous state from `userIdentityP` before peer handshakes
  begin.

```ts
resolveRoomId: async ({appId, roomId, userIdentityP}) => {
  const identity = await userIdentityP
  return {
    effectiveRoomId: roomId,
    state: {userId: identity.userId} // passed as 2nd argument to setup()
  }
}
```

### 2. `setup(kernel, preResolvedState)` _(room initialization)_

Runs as soon as the local endpoint's `peerId` (`kernel.selfId`) resolves when
the room is created, right before `room.ready` resolves. Inside `setup`, your
plugin can:

1. Register internal wire actions (`kernel.makeInternalAction(...)`) or public
   actions (`kernel.makeAction(...)`).
2. Subscribe to peer and room lifecycle hooks (`onPeerActivated`,
   `onPeerDeactivated`, `onRoomIdChanged`, `onLeave`).
3. Return an object of methods (`TApi`) to merge onto the `Room` instance when
   `room.ready` resolves (cannot shadow reserved core `Room` properties or
   duplicate another plugin's exported method name). If `resolveRoomId` or
   `setup` throws/rejects, Trystero surfaces
   `{code: 'plugin-failed', plugin: name, message, cause}` via `room.onError`.

---

## Wire Communication (`makeInternalAction` vs `makeAction`)

Plugins have two ways to open data channels across the room:

### `kernel.makeInternalAction<T>(namespace, options?)` _(Recommended for plugins)_

Creates a reserved internal wire channel:

- **Automatic `'@_'` prefixing**: Passing `'ysync'` registers `'@_ysync'` on the
  wire. User calls to `room.makeAction(...)` cannot collide with `'@_'`-prefixed
  namespaces.
- **Namespace length**: Up to **30 UTF-8 bytes** (32 UTF-8 bytes on the wire
  including `'@_'`) and no null characters (`\0`).
- **Payload types (`T`)**: Supports `JsonValue` (objects, arrays, numbers,
  booleans), `string`, `ArrayBuffer`, `ArrayBufferView` (`Uint8Array`, etc.),
  and `Blob`.
- **Multi-hop transparent**: Automatically routes across multi-hop overlays when
  `scale()` is active.

```ts
const syncAction = kernel.makeInternalAction<Uint8Array>('yjs:sync', {
  maxPayloadBytes: 1024 * 1024 // optional per-message byte cap (default: room maxReceiveBytes / 256 MiB)
})

// Broadcast to all active peers, or pass a peerId / peerId[] as the 2nd argument
await syncAction.send(
  new Uint8Array([1, 2, 3]),
  targetPeerId, // optional: string | string[] | null (undefined/null = broadcast)
  {seq: 1}, // optional: JsonValue metadata
  (percent, peerId, metadata) => {}, // optional: outbound progress callback
  abortSignal // optional: AbortSignal
)

// Receive messages
syncAction.onMessage((data, peerId, metadata) => {
  // `data` is decoded to match the sent format (Uint8Array, string, or JSON)
})

// Optional: inspect or reject chunked transfers before they complete
syncAction.onReceive(context => {
  return context.byteLength <= 5 * 1024 * 1024
})
```

#### Advanced `ActionOptions` for `makeInternalAction`:

| Option                | Type      | Description                                                                                   |
| :-------------------- | :-------- | :-------------------------------------------------------------------------------------------- |
| `maxPayloadBytes`     | `number`  | Maximum allowed payload size in bytes for this channel.                                       |
| `sendToPending`       | `boolean` | Allow sending to peers whose admission handshake is still in progress (default: `false`).     |
| `receiveWhilePending` | `boolean` | Allow receiving from peers whose admission handshake is still in progress (default: `false`). |

### `kernel.makeAction<T, R>(namespace, config?)`

The standard public `room.makeAction` API. Use this if you want built-in RPC
(`kind: 'request'` with `request()` / `requestMany()` / `onRequest`), automatic
`userId` resolution in handler contexts, or automatic cryptographic signature
verification via `roles: ['admin', ...]`.

---

## `RoomKernel` API Reference

### Room & Identity Properties

| Member                              | Type                                          | Description                                                                                                         |
| :---------------------------------- | :-------------------------------------------- | :------------------------------------------------------------------------------------------------------------------ |
| `kernel.selfId`                     | `string`                                      | Local endpoint's self-certifying 20-character Base62 `peerId`.                                                      |
| `kernel.appId`                      | `string`                                      | The `appId` passed to `joinRoom`.                                                                                   |
| `kernel.initialRoomId`              | `string`                                      | The initial `roomId` passed to `joinRoom`.                                                                          |
| `kernel.password`                   | `string`                                      | Room password string (`''` if none).                                                                                |
| `kernel.getRoomId()`                | `() => string`                                | Returns the current effective room ID (including any fingerprint suffix).                                           |
| `kernel.setEffectiveRoomId(id)`     | `(id: string) => void`                        | Updates the effective room ID and notifies `onRoomIdChanged` listeners.                                             |
| `kernel.getLocalUserIdentity()`     | `() => Promise<UserIdentity>`                 | Resolves the local user's cryptographic `UserIdentity` (`{userId, fingerprint, publicKey, signPubJwk, sign, ...}`). |
| `kernel.getPeerUserId(peerId)`      | `(peerId: string) => string`                  | Returns the verified `userId` for `peerId` (falls back to `peerId` if not yet known).                               |
| `kernel.getKnownPeerUserId(peerId)` | `(peerId: string) => string \| undefined`     | Returns the verified `userId` for `peerId`, or `undefined` if unknown.                                              |
| `kernel.getUserPeerIds(userId)`     | `(userId: string) => string[]`                | Returns all active `peerId`s (open tabs/connections) belonging to `userId`.                                         |
| `kernel.getPeerPublicKey(peerId)`   | `(peerId: string) => JsonWebKey \| undefined` | Returns the verified ECDSA P-256 public JWK for `peerId`.                                                           |

### Peer Inspection & Targeting

| Member                                                 | Type                                                                    | Description                                                                                                                                |
| :----------------------------------------------------- | :---------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------- |
| `kernel.getActivePeerIds()`                            | `() => string[]`                                                        | Returns all currently active `peerId`s in the room (both direct and multi-hop virtual peers).                                              |
| `kernel.getAllPeerIds()`                               | `() => string[]`                                                        | Returns all `peerId`s including connections still completing handshake.                                                                    |
| `kernel.isPeerActive(peerId)`                          | `(peerId: string) => boolean`                                           | Returns `true` if `peerId` has completed handshake and is active in the room.                                                              |
| `kernel.getPeerHandle(peerId, includePending?)`        | `(peerId: string, includePending?: boolean) => PeerHandle \| undefined` | Returns the underlying `PeerHandle` for `peerId`.                                                                                          |
| `kernel.resolveSendTarget(targets, includePending?)`   | `(targets: TargetPeers, includePending?: boolean) => TargetPeers`       | Resolves a `userId`, `peerId`, or array of IDs into concrete target `peerId`(s), fanning out a `userId` to all of that user's active tabs. |
| `kernel.resolveRequestTarget(target, includePending?)` | `(target: string, includePending?: boolean) => string \| undefined`     | Resolves a `userId` or `peerId` to a single deterministic `peerId` for 1-to-1 requests.                                                    |
| `kernel.kickPeer(peerId, reason?)`                     | `(peerId: string, reason?: Error) => void`                              | Immediately disconnects `peerId` and cleans up its state.                                                                                  |
| `kernel.emitError(error)`                              | `(error: KernelRoomErrorInput) => void`                                 | Emits a structured `RoomError` (automatically populated with `appId` and effective `roomId`) to `room.onError` subscribers.                |

### Lifecycle Hooks

| Hook                       | Signature                                                                                            | Description                                                                                                                                |
| :------------------------- | :--------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------- |
| `kernel.onPeerActivated`   | `(cb: (peerId: string, peer: PeerHandle) => void, options?: StatefulListenerOptions) => Unsubscribe` | Fires when a direct WebRTC peer finishes handshakes and becomes active in the room. Pass `{replay: true}` to replay existing direct peers. |
| `kernel.onPeerDeactivated` | `(cb: (peerId: string) => void, options?: ListenerOptions) => Unsubscribe`                           | Fires when an active peer leaves or disconnects.                                                                                           |
| `kernel.onRoomIdChanged`   | `(cb: (roomId: string) => void, options?: ListenerOptions) => Unsubscribe`                           | Fires if the effective room ID is updated after initialization.                                                                            |
| `kernel.onLeave`           | `(cb: () => void, options?: ListenerOptions) => Unsubscribe`                                         | Fires when `room.leave()` is called. Always clean up timers and external listeners here.                                                   |

---

## Interoperating with `roles()` and `scale()`

Your plugin can optionally integrate with `roles()` and `scale()` when the user
has enabled them, while degrading gracefully when they are omitted:

### Checking Roles & Bans (`kernel.getRolesProvider()`)

If `roles()` is passed to `joinRoom`, `kernel.getRolesProvider()` returns the
active `KernelRolesProvider` (otherwise `null`):

```ts
const rolesProvider = kernel.getRolesProvider()

if (rolesProvider) {
  // Get verified roles for a peerId or userId (e.g. ['admin', 'editor'])
  const peerRoles = rolesProvider.getPeerRoles(peerId)

  // Check if a peerId or userId is banned
  if (rolesProvider.isPeerBanned(peerId)) {
    return
  }
}
```

### Inspecting Topology (`kernel.getScaleProvider()`)

If `scale()` is passed to `joinRoom`, `kernel.getScaleProvider()` returns the
active `KernelScaleProvider` (otherwise `null`):

```ts
const scaleProvider = kernel.getScaleProvider()

if (scaleProvider) {
  // Check whether a peer is a 1-hop direct WebRTC neighbor or a multi-hop virtual peer
  const isDirect = scaleProvider.isDirectPeer(peerId)
  const isVirtual = scaleProvider.isVirtualPeer(peerId)

  // Inspect full topology snapshot (activeMode, directPeerIds, roomPeerIds, routes)
  const snapshot = scaleProvider.getSnapshot()
}
```

---

## Complete Example: Yjs CRDT Plugin

Below is a complete pattern for a `trystero-yjs` plugin that synchronizes a
`Y.Doc` across peers, supports optional role-gated writes when `roles()` is
enabled, and exposes `room.getYDoc()`:

```ts
import {definePlugin, type RoomPlugin} from '@trystero-p2p/core'
import * as Y from 'yjs'

export interface YjsPluginConfig {
  doc: Y.Doc
  /**
   * Optional list of roles allowed to publish document updates.
   * Requires `roles(...)` in `joinRoom` config when set.
   */
  writeRoles?: string[]
}

export interface YjsRoomApi {
  getYDoc: () => Y.Doc
}

export const yjs = ({
  doc,
  writeRoles
}: YjsPluginConfig): RoomPlugin<'yjs', YjsRoomApi> =>
  definePlugin('yjs', {
    setup(kernel) {
      // 1. Fail fast if role gating is requested without roles()
      if (writeRoles?.length && !kernel.getRolesProvider()) {
        throw new Error('yjs({writeRoles}) requires roles() in joinRoom config')
      }

      const isAuthorizedWriter = (peerId: string): boolean => {
        if (!writeRoles?.length) {
          return true
        }
        const peerRoles = kernel.getRolesProvider()?.getPeerRoles(peerId) ?? []
        return writeRoles.some(role => peerRoles.includes(role))
      }

      // 2. Open internal wire channels ('@_yjs:sv', '@_yjs:upd')
      const stateVectorAction = kernel.makeInternalAction<Uint8Array>('yjs:sv')
      const updateAction = kernel.makeInternalAction<Uint8Array>('yjs:upd')

      // 3. Broadcast local Y.Doc updates to the room
      const onLocalUpdate = (update: Uint8Array, origin: unknown) => {
        if (origin === 'trystero-yjs') {
          return
        }
        if (!isAuthorizedWriter(kernel.selfId)) {
          return
        }
        void updateAction.send(update)
      }
      doc.on('update', onLocalUpdate)

      // 4. Apply incoming incremental updates from authorized peers
      updateAction.onMessage((update, peerId) => {
        if (!isAuthorizedWriter(peerId)) {
          return
        }
        Y.applyUpdate(doc, update, 'trystero-yjs')
      })

      // 5. Exchange state vectors when a new peer joins
      kernel.onPeerActivated(peerId => {
        const sv = Y.encodeStateVector(doc)
        void stateVectorAction.send(sv, peerId)
      })

      stateVectorAction.onMessage((remoteStateVector, peerId) => {
        if (isAuthorizedWriter(kernel.selfId)) {
          const diff = Y.encodeStateAsUpdate(doc, remoteStateVector)
          if (diff.byteLength > 0) {
            void updateAction.send(diff, peerId)
          }
        }
      })

      // 6. Clean up when room.leave() is called
      kernel.onLeave(() => {
        doc.off('update', onLocalUpdate)
      })

      // 7. Extend the returned `room` instance
      return {
        getYDoc: () => doc
      }
    }
  })
```

---

## Best Practices & Packaging

1. **Import from `@trystero-p2p/core`**: Have your plugin import `definePlugin`
   and types from `@trystero-p2p/core` (and list `@trystero-p2p/core` in
   `peerDependencies` or `dependencies`). This ensures your plugin is
   strategy-agnostic and works whether the user imports `joinRoom` from
   `trystero`, `@trystero-p2p/nostr`, `@trystero-p2p/torrent`, or any other
   strategy package.
2. **Mark `"sideEffects": false` in `package.json`**: Adding
   `"sideEffects": false` to your plugin's `package.json` allows bundlers to
   tree-shake unused exports.
3. **Namespace your internal actions**: Prefix your `makeInternalAction` names
   with a short plugin identifier (e.g. `'yjs:sv'`, `'yjs:upd'`) and keep the
   name under 30 UTF-8 bytes so multiple third-party plugins can coexist in the
   same room without collisions.
4. **Support user-level targeting (`userId` and `peerId`)**: If your plugin
   exposes methods on `room` that accept a target ID from the user, pass the ID
   through `kernel.resolveSendTarget(target)` (for broadcasts to all tabs of a
   user) or `kernel.resolveRequestTarget(target)` (for 1-to-1 requests) so
   callers can pass either a `userId` or a `peerId`.
5. **Always clean up in `kernel.onLeave()`**: Remove any external event
   listeners, clear timers, and abort in-flight work when the room leaves so
   apps that join and leave rooms dynamically do not leak memory.
