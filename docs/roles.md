# Admins, Roles & Moderation

[← Back to README](../README.md) · [API Reference](./api.md)

Peer-to-peer rooms start out egalitarian: everyone's browser has the same
standing. That's great for a casual sketchpad with friends, right up until you
build:

- **A trivia or party game** where only the host should advance the round or
  update the scoreboard.
- **A watch party or synth jam** where only the creator (or promoted DJs) can
  switch the active track.
- **A public lobby or classroom** where moderators need to kick and ban griefers
  so they can't disrupt everyone else.

By importing the tree-shakeable `roles()` plugin and passing it in `use: [...]`,
you get **cryptographically verified room admins, custom roles, authoritative
state, and peer banning** — with zero backend servers.

_(Apps that don't import `roles` tree-shake the entire plugin out of their
bundle.)_

---

## Two ways to establish room admins

### 1. Create an instant host-owned room (`selfAsAdmin: true`)

The easiest pattern for a **"Create Room"** button is
`roles({selfAsAdmin: true})`:

```js
import {joinRoom, roles} from 'trystero'

// Host creates the room
const hostRoom = joinRoom(
  {
    appId: 'trivia-night',
    use: [roles({selfAsAdmin: true})]
  },
  'friday-quiz'
)

const {roomId} = await hostRoom.getSelf()
// => "friday-quiz~9fX2kLm8pQr7vBn3wZy4xT"
// Put `roomId` into your shareable invite URL!
```

When `selfAsAdmin: true` is set, Trystero appends `~` and the host's
22-character [`userId`](./identity.md) to the room name. Think of that suffix as
a built-in digital ID badge: when guests join that `roomId` with
`use: [roles()]`, their browsers automatically verify from the room name alone
who owns the room:

```js
// Guests join using the shared `roomId`
const guestRoom = joinRoom(
  {
    appId: 'trivia-night',
    use: [roles()]
  },
  roomId
)
```

- If the host refreshes the page (or closes their laptop and comes back later on
  the same browser), Trystero's persistent `'local'` identity automatically
  restores their admin powers.
- Joining a `<baseRoomId>~<userId>` room _without_ `use: [roles()]` throws an
  error right away so a misconfigured client fails fast instead of ignoring host
  rules.
- **Server-side note:** When using `selfAsAdmin: true` in
  [Node, Bun, or Deno](./server-side.md) (where the default identity is
  ephemeral `'none'`), pass a saved `UserIdentity` so restarting your process
  doesn't throw away the admin key!

### 2. Pin admin `userId`s on a clean room name (`admins: [...]`)

Want a memorable, permanent room name like `'main-stage'` without a `~<userId>`
suffix — or want multiple co-owners from the start? Pass `admins` with their
22-character `userId`s:

```js
import {joinRoom, roles} from 'trystero'

const ADMINS = ['tY8mK3pQvN2xR7wL9jB4cF', '9fX2kLm8pQr7vBn3wZy4xT']

// Host and guests run the exact same code!
// Anyone whose verified `userId` is in ADMINS becomes a root 'admin';
// everyone else joins as a regular participant who trusts ADMINS.
const room = joinRoom(
  {
    appId: 'town-hall',
    use: [roles({admins: ADMINS})]
  },
  'main-stage'
)
```

You can even combine both (`roles({selfAsAdmin: true, admins: [CO_HOST_ID]})`)
to spin up an on-the-fly room while trusting an additional co-admin.

---

## Authoritative state (`makeState` + `roles()`)

As soon as `roles()` is included in `use: [...]`, **`room.makeState()` defaults
to `roles: ['admin']` (fail-closed)**. Everyone in the room can read the state,
and only verified admins (or custom roles you list) can update it:

```js
// Only 'admin' or 'host' can update `round`; everyone can read it
const round = room.makeState(
  'round',
  {number: 1, phase: 'lobby'},
  {
    roles: ['admin', 'host'],
    validate: next => next.number >= 1
  }
)

// Want one specific shared state to stay open to everyone in a roles() room?
// Opt in explicitly with `roles: '*'`:
const reactions = room.makeState('wall', {latestEmoji: '👋'}, {roles: '*'})

// You can also restrict per-user state slots (e.g. only seated players can bet):
const bet = room.makeUserState('bet', 0, {roles: ['admin', 'player']})
```

Best part: **the host doesn't have to stay online for newcomers to read official
state.** Because every state update carries the writer's signature (and role
certificate), existing peers automatically cache and sync the latest official
state to late joiners without being able to tamper with a single byte.

---

## Restricting actions to specific roles

Pass `roles` when creating an action with [`room.makeAction()`](./actions.md) to
restrict who is allowed to send messages or make requests on that channel:

```js
const announce = room.makeAction('announce', {
  roles: ['admin', 'moderator']
})

announce.onMessage((data, {userId, roles}) => {
  showToast(`[${roles.join(', ')}] ${userId}: ${data.text}`)
})

// Succeeds only if the local user holds 'admin' or 'moderator'
await announce.send({text: 'Final round starts in 10 seconds!'})
```

If an unauthorized user tries calling `announce.send(...)` from DevTools, it
rejects locally — and even if they modified their client bundle to put raw bytes
on the wire, every peer in the room verifies signatures and drops unauthorized
packets automatically.

---

## Granting custom roles & banning troublemakers

Root `'admin'` users can promote participants to custom roles (like
`'moderator'`, `'dj'`, or `'player'`), revoke those roles later, or ban
disruptive users from the room:

```js
// Watch role changes across the room in real time
room.onRoleChange(({userId, roles, previousRoles, local}) => {
  console.log(`${userId} roles: ${previousRoles} -> ${roles} (me=${local})`)
})

// Promote a user to one or more custom roles (root 'admin' only)
await room.grantRole(friendUserId, 'dj')
await room.grantRole(helperUserId, ['moderator', 'dj'])

// Inspect current verified roles (omit argument to check your own roles)
console.log(room.getRoles(friendUserId)) // => ['dj']
console.log(room.getRoles()) // => ['admin']

// Revoke one custom role — or omit the role name to revoke all granted roles
await room.revokeRole(friendUserId, 'dj')

// Kick and ban a griefer across the entire room (root 'admin' only)
await room.ban(grieferUserId, {reason: 'spamming soundboard'})
console.log(room.isBanned(grieferUserId)) // => true

// Lift a ban later if you change your mind
await room.unban(grieferUserId)
```

### Good to know about roles & bans

- **Root `'admin'` is permanent**: Only the self-certifying room creator and
  `userId`s listed in `roles({admins})` hold `'admin'` and can call `grantRole`,
  `revokeRole`, `ban`, or `unban`. `'admin'` itself cannot be granted or
  revoked, and root admins cannot ban one another.
- **Roles & bans follow the user (`userId`)**: Promoting Alice gives all of her
  open tabs (and page refreshes) that role automatically. Banning a griefer
  disconnects all of their open tabs immediately, clears any custom roles they
  held, purges any `makeState` and `makeUserState` entries they authored, and
  blocks them if they try to reconnect.
- **What the banned user sees**: Their client receives
  `{code: 'banned', reason}` on
  [`room.onError`](./identity.md#handling-room-errors-roomonerror).
- **Peer-enforced bans**: Because public signaling relays don't know your app's
  rules, bans are enforced cooperatively by honest peers across WebRTC
  handshakes, multi-hop relays, and action/state verification — banned clients
  are completely ignored by everyone in the room.

<details>
  <summary>Deep dive: role certificates, causal ordering & Hop-1 edge filtering</summary>

- **Root-signed `RoleCertificate`s**: Calling `room.grantRole()` issues an ECDSA
  P-256 `RoleCertificate` binding `appId`, `roomId`, the recipient's
  `subUserId`, granted custom `roles`, and a monotonic `(iat, seq)` stamp signed
  by the root admin's `UserIdentity`. Promoted peers attach their certificate
  inline on role-gated actions, state records, and overlay link descriptors so
  any peer can verify authorization offline, even when the admin who issued the
  grant is no longer connected.
- **Revocations, bans & total causal order**: `revokeRole()`, `ban()`, and
  `unban()` broadcast root-signed `RoleRevocationRecord`s and
  `PeerModerationRecord`s (`op: 'ban' | 'unban'`, up to `4,096` active bans per
  room; unban tombstones evict first at capacity, and a 4,097th active ban
  throws rather than silently dropping an active ban). Peers evaluate grants,
  revocations, and bans in a deterministic total order (`(ts/iat, seq)` plus
  canonical key/signature tie-breakers, tolerating up to 60 seconds of future
  clock skew) and reconcile records via cursor-paged anti-entropy sync so every
  peer converges to the exact same permissions regardless of packet arrival
  order.
- **Edge filtering & metadata privacy**: Role certificates and moderation
  records travel strictly inside encrypted WebRTC data channels after handshake
  — never on public signaling relays. In [`scale()`](./scaling.md) multi-hop
  rooms, immediate Hop-1 neighbors verify role certificates and ban records
  before forwarding traffic so unauthorized broadcasts or banned peers are
  dropped right at the edge.

</details>
