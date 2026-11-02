import assert from 'node:assert/strict'
import test from './test.ts'
import {
  type MessageContext,
  type PeerJoinContext,
  type PeerLeaveContext,
  type RolesPluginApi,
  type Room,
  type RoomError,
  type UserJoinContext,
  type UserLeaveContext,
  createUserIdentity,
  roles
} from '../../packages/core/src/index.ts'
import {
  derivePeerId,
  signUserEndpointProof,
  verifyUserEndpointProof
} from '../../packages/core/src/identity.ts'
import {createMemorySignalBus} from './memory-rtc.ts'
import {createSortedJoinRooms, wait, waitFor} from './peer-harness.ts'

type RecordedError = RoomError & {
  peerId?: string | undefined
  reason?: string | undefined
}

void test(
  'User presence (onUserJoin, onUserLeave, getUsers) and overloaded target fan-out & deterministic request across multi-tab userIds',
  {timeout: 10_000},
  async () => {
    const {makeJoinRoom, rtcPolyfill} = createMemorySignalBus()
    const appId = `multi-tab-presence-${Date.now()}`
    const roomId = 'presence-room'

    const aliceIdentity = await createUserIdentity()
    const bobIdentity = await createUserIdentity()

    const bobPeerJoins: PeerJoinContext[] = []
    const bobPeerLeaves: PeerLeaveContext[] = []
    const bobUserJoins: UserJoinContext[] = []
    const bobUserLeaves: UserLeaveContext[] = []

    const [alice1Slot, alice2Slot, bobSlot] = await createSortedJoinRooms(
      3,
      () => makeJoinRoom(),
      appId
    )
    const alice1PeerId = alice1Slot!.peerId
    const alice2PeerId = alice2Slot!.peerId
    const bobPeerId = bobSlot!.peerId

    const roomBob = bobSlot!.joinRoom(
      {
        appId,
        identity: bobIdentity,
        rtcPolyfill
      },
      roomId
    )
    roomBob.onPeerJoin(ctx => bobPeerJoins.push(ctx))
    roomBob.onPeerLeave(ctx => bobPeerLeaves.push(ctx))
    roomBob.onUserJoin(ctx => bobUserJoins.push(ctx))
    roomBob.onUserLeave(ctx => bobUserLeaves.push(ctx))

    let roomAlice1: Room | null = null
    let roomAlice2: Room | null = null
    try {
      // 1. Alice's 1st tab joins
      roomAlice1 = alice1Slot!.joinRoom(
        {
          appId,
          identity: aliceIdentity,
          rtcPolyfill
        },
        roomId
      )

      await waitFor(
        () =>
          bobPeerJoins.some(e => e.peerId === alice1PeerId) &&
          Object.keys(roomAlice1!.getPeers()).includes(bobPeerId),
        3_000
      )

      assert.equal(bobPeerJoins.length, 1)
      assert.equal(bobPeerJoins[0]!.peerId, alice1PeerId)
      assert.equal(bobPeerJoins[0]!.userId, aliceIdentity.userId)
      assert.equal(bobUserJoins.length, 1)
      assert.equal(bobUserJoins[0]!.userId, aliceIdentity.userId)
      assert.equal(bobUserJoins[0]!.peerId, alice1PeerId)

      // 2. Alice's 2nd tab joins with the same aliceIdentity
      roomAlice2 = alice2Slot!.joinRoom(
        {
          appId,
          identity: aliceIdentity,
          rtcPolyfill
        },
        roomId
      )

      await waitFor(
        () =>
          bobPeerJoins.some(e => e.peerId === alice2PeerId) &&
          Object.keys(roomAlice2!.getPeers()).includes(bobPeerId),
        3_000
      )

      assert.equal(
        bobPeerJoins.length,
        2,
        'onPeerJoin should fire for Alice second tab'
      )
      assert.equal(
        bobUserJoins.length,
        1,
        'onUserJoin must NOT fire again when Alice opens a second tab'
      )

      const usersAtBob = roomBob.getUsers()
      assert.ok(usersAtBob[aliceIdentity.userId])
      assert.equal(usersAtBob[bobIdentity.userId], undefined)
      assert.deepEqual(usersAtBob[aliceIdentity.userId]!.peerIds.sort(), [
        alice1PeerId,
        alice2PeerId
      ])
      assert.equal(
        roomBob.getPeers()[alice1PeerId]!.userId,
        aliceIdentity.userId
      )
      assert.equal(
        roomBob.getPeers()[alice2PeerId]!.userId,
        aliceIdentity.userId
      )

      // Wait for Alice's two tabs to also connect to each other
      await waitFor(() => alice2PeerId in roomAlice1!.getPeers(), 3_000)
      // getUsers() on Alice's tab excludes the self user (aliceIdentity.userId)
      const usersAtAlice1 = roomAlice1.getUsers()
      assert.equal(
        usersAtAlice1[aliceIdentity.userId],
        undefined,
        'getUsers() must exclude the local user even when a second tab of the local user is connected'
      )
      assert.deepEqual(usersAtAlice1[bobIdentity.userId]!.peerIds, [bobPeerId])

      // ping(userId) deterministically pings one endpoint matching request() logic
      const rtt = await roomBob.ping(aliceIdentity.userId)
      assert.equal(typeof rtt, 'number')
      assert.ok(rtt >= 0)

      // 3. Overloaded target on send(data, {target: userId}) fans out to both tabs (and deduplicates)
      const chatBob = roomBob.makeAction<string>('chat')
      const alice1Msgs: Array<MessageContext & {data: string}> = []
      const alice2Msgs: Array<MessageContext & {data: string}> = []
      roomAlice1.makeAction<string>('chat').onMessage((data, ctx) => {
        alice1Msgs.push({data, ...ctx})
      })
      roomAlice2.makeAction<string>('chat').onMessage((data, ctx) => {
        alice2Msgs.push({data, ...ctx})
      })

      await chatBob.send('hello-alice-all-tabs', {
        target: [aliceIdentity.userId, alice1PeerId]
      })

      await waitFor(() => alice1Msgs.length === 1 && alice2Msgs.length === 1)
      assert.equal(alice1Msgs[0]!.data, 'hello-alice-all-tabs')
      assert.equal(alice1Msgs[0]!.peerId, bobPeerId)
      assert.equal(alice1Msgs[0]!.userId, bobIdentity.userId)
      assert.equal(alice2Msgs[0]!.data, 'hello-alice-all-tabs')
      assert.equal(alice2Msgs[0]!.peerId, bobPeerId)
      assert.equal(alice2Msgs[0]!.userId, bobIdentity.userId)

      // 4. Overloaded target on request(data, {target: userId}) routes deterministically to 1 tab (lowest peerId)
      let alice1ReqCount = 0
      let alice2ReqCount = 0
      const rpcBob = roomBob.makeAction<string, string>('rpc', {
        kind: 'request'
      })
      roomAlice1
        .makeAction<string, string>('rpc', {
          kind: 'request'
        })
        .onRequest((q, ctx) => {
          alice1ReqCount++
          return `from-alice-1:${q}:${ctx.userId}`
        })
      roomAlice2
        .makeAction<string, string>('rpc', {
          kind: 'request'
        })
        .onRequest((q, ctx) => {
          alice2ReqCount++
          return `from-alice-2:${q}:${ctx.userId}`
        })

      const rpcResponse = await rpcBob.request('ping-user', {
        target: aliceIdentity.userId
      })
      assert.equal(
        rpcResponse,
        `from-alice-1:ping-user:${bobIdentity.userId}`,
        'request(userId) should route deterministically to lowest peerId (alice1PeerId)'
      )
      assert.equal(alice1ReqCount, 1)
      assert.equal(alice2ReqCount, 0)

      const manyResults = await rpcBob.requestMany('fanout-user', {
        targets: [aliceIdentity.userId]
      })
      assert.equal(manyResults.length, 1)
      assert.equal(manyResults[0]!.peerId, alice1PeerId)
      assert.equal(manyResults[0]!.userId, aliceIdentity.userId)
      assert.equal(manyResults[0]!.status, 'fulfilled')

      // 5. Alice's 1st tab leaves -> onPeerLeave fires, onUserLeave does NOT fire
      await roomAlice1.leave()
      await waitFor(
        () => bobPeerLeaves.some(e => e.peerId === alice1PeerId),
        3_000
      )
      assert.equal(bobPeerLeaves.length, 1)
      assert.equal(bobPeerLeaves[0]!.peerId, alice1PeerId)
      assert.equal(bobPeerLeaves[0]!.userId, aliceIdentity.userId)
      assert.equal(
        bobUserLeaves.length,
        0,
        'onUserLeave must NOT fire while Alice still has tab 2 open'
      )
      assert.deepEqual(roomBob.getUsers()[aliceIdentity.userId]!.peerIds, [
        alice2PeerId
      ])

      // Now request(aliceIdentity.userId) routes to Alice's remaining tab (alice2PeerId)
      const rpcResponse2 = await rpcBob.request('ping-user-2', {
        target: aliceIdentity.userId
      })
      assert.equal(
        rpcResponse2,
        `from-alice-2:ping-user-2:${bobIdentity.userId}`
      )
      assert.equal(alice2ReqCount, 1)

      // 6. Alice's 2nd (last) tab leaves -> both onPeerLeave and onUserLeave fire!
      await roomAlice2.leave()
      await waitFor(
        () => bobPeerLeaves.some(e => e.peerId === alice2PeerId),
        3_000
      )
      assert.equal(bobPeerLeaves.length, 2)
      assert.equal(bobUserLeaves.length, 1)
      assert.equal(bobUserLeaves[0]!.userId, aliceIdentity.userId)
      assert.equal(bobUserLeaves[0]!.peerId, alice2PeerId)
      assert.equal(roomBob.getUsers()[aliceIdentity.userId], undefined)
    } finally {
      await Promise.all([
        roomBob.leave().catch(() => {}),
        roomAlice1?.leave().catch(() => {}),
        roomAlice2?.leave().catch(() => {})
      ])
    }
  }
)

void test(
  'Security: DTLS fingerprint mismatch and forged overlay descriptors are rejected',
  {timeout: 10_000},
  async () => {
    const {makeJoinRoom, InMemoryRTCPeerConnection, rtcPolyfill} =
      createMemorySignalBus()
    const appId = `dtls-mitm-test-${Date.now()}`
    const roomId = 'secure-room'

    // 1. Simulate a MITM / relay forwarding attack where the connection's DTLS
    // remote fingerprint does not match the peer's signed DTLS fingerprint.
    class MitmRTCPeerConnection extends InMemoryRTCPeerConnection {
      constructor() {
        super()
        this.overrideRemoteDtlsFingerprint =
          'sha-256 FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF'
      }
    }

    const honestErrors: RecordedError[] = []
    const mitmErrors: RecordedError[] = []
    const honestJoins: PeerJoinContext[] = []

    const honestRoom = makeJoinRoom('peer-honest')(
      {
        appId,
        rtcPolyfill
      },
      roomId
    )
    honestRoom.onError(err => honestErrors.push(err))
    honestRoom.onPeerJoin(ctx => honestJoins.push(ctx))

    const mitmRoom = makeJoinRoom('peer-mitm')(
      {
        appId,
        rtcPolyfill:
          MitmRTCPeerConnection as unknown as typeof RTCPeerConnection
      },
      roomId
    )
    mitmRoom.onError(err => mitmErrors.push(err))

    try {
      await waitFor(
        () => honestErrors.length > 0 || mitmErrors.length > 0,
        3_000
      )
      const allErrors = [...honestErrors, ...mitmErrors]
      assert.ok(
        allErrors.some(
          e =>
            e.code === 'handshake-failed' &&
            /DTLS fingerprint mismatch|peer identity verification failed/.test(
              e.message
            )
        ),
        'DTLS fingerprint mismatch must fail identity handshake'
      )
      assert.equal(honestJoins.length, 0, 'MITM peer must never be admitted')
    } finally {
      await Promise.all([
        honestRoom.leave().catch(() => {}),
        mitmRoom.leave().catch(() => {})
      ])
    }

    // 2. Verify multi-hop overlay descriptor self-certification and userProof
    const validUser = await createUserIdentity()
    const victimUser = await createUserIdentity()
    const validPeerUser = await createUserIdentity()
    const validPeerId = await derivePeerId(validPeerUser.signPubJwk)
    const validProof = await signUserEndpointProof(validUser, {
      appId,
      roomId,
      peerId: validPeerId,
      peerPubJwk: validPeerUser.signPubJwk,
      seq: 1
    })

    assert.equal(
      await verifyUserEndpointProof({
        appId,
        roomId,
        peerId: validPeerId,
        peerPubJwk: validPeerUser.signPubJwk,
        userId: validUser.userId,
        userPubJwk: validUser.signPubJwk,
        proof: validProof,
        seq: 1
      }),
      true
    )

    // Forged peerId with someone else's public key
    assert.equal(
      await verifyUserEndpointProof({
        appId,
        roomId,
        peerId: validPeerId,
        peerPubJwk: victimUser.signPubJwk,
        userId: validUser.userId,
        userPubJwk: validUser.signPubJwk,
        proof: validProof,
        seq: 1
      }),
      false
    )

    // Forged userId claim without valid userProof signature
    assert.equal(
      await verifyUserEndpointProof({
        appId,
        roomId,
        peerId: validPeerId,
        peerPubJwk: validPeerUser.signPubJwk,
        userId: victimUser.userId,
        userPubJwk: victimUser.signPubJwk,
        proof: validProof,
        seq: 1
      }),
      false
    )
  }
)

void test(
  'userId-level capacity limit: admits 2nd tab of an existing user at limit, while rejecting a new user',
  {timeout: 10_000},
  async () => {
    const {makeJoinRoom, rtcPolyfill} = createMemorySignalBus()
    const appId = `limit-userid-${Date.now()}`
    const roomId = 'duel-tabs'

    const hostUser = await createUserIdentity()
    const aliceUser = await createUserIdentity()
    const intruderUser = await createUserIdentity()

    const hostRoom = makeJoinRoom('peer-host')(
      {
        appId,
        identity: hostUser,
        limit: 2,
        rtcPolyfill
      },
      roomId
    )

    const aliceTab1 = makeJoinRoom('peer-alice-1')(
      {
        appId,
        identity: aliceUser,
        limit: 2,
        rtcPolyfill
      },
      roomId
    )

    const [{peerId: hostPeerId}, {peerId: alice1PeerId}] = await Promise.all([
      hostRoom.getSelf(),
      aliceTab1.getSelf()
    ])
    await waitFor(
      () =>
        alice1PeerId in hostRoom.getPeers() &&
        hostPeerId in aliceTab1.getPeers(),
      3_000
    )

    // Alice opens a 2nd tab with the same aliceUser in a limit: 2 room -> admitted!
    const aliceTab2Errors: RecordedError[] = []
    const aliceTab2 = makeJoinRoom('peer-alice-2')(
      {
        appId,
        identity: aliceUser,
        limit: 2,
        rtcPolyfill
      },
      roomId
    )
    aliceTab2.onError(err => aliceTab2Errors.push(err))

    const {peerId: alice2PeerId} = await aliceTab2.getSelf()
    await waitFor(
      () =>
        alice2PeerId in hostRoom.getPeers() &&
        hostPeerId in aliceTab2.getPeers(),
      3_000
    )
    assert.deepEqual(aliceTab2Errors, [])
    assert.equal(Object.keys(hostRoom.getUsers()).length, 1)
    assert.equal(hostRoom.getUsers()[aliceUser.userId]!.peerIds.length, 2)

    // A 3rd distinct user (intruderUser) tries to join -> rejected with 'room full'!
    const intruderErrors: RecordedError[] = []
    const intruderRoom = makeJoinRoom('peer-intruder')(
      {
        appId,
        identity: intruderUser,
        limit: 2,
        rtcPolyfill
      },
      roomId
    )
    intruderRoom.onError(err => intruderErrors.push(err))

    try {
      await waitFor(() => intruderErrors.length > 0, 3_000)
      assert.equal(intruderErrors[0]!.code, 'room-full')
      assert.equal(intruderErrors[0]!.message, 'room full')
    } finally {
      await Promise.all([
        hostRoom.leave().catch(() => {}),
        aliceTab1.leave().catch(() => {}),
        aliceTab2.leave().catch(() => {}),
        intruderRoom.leave().catch(() => {})
      ])
    }
  }
)

void test(
  'Security & Multi-Tab Authority: userId roles work across tabs/reloads, userId bans block new tabs during handshake, and newcomers cannot poison room limit',
  {timeout: 15_000},
  async () => {
    const {makeJoinRoom, rtcPolyfill} = createMemorySignalBus()
    const appId = `sec-multitab-auth-${Date.now()}`

    const adminUser = await createUserIdentity()
    const aliceUser = await createUserIdentity()
    const attackerUser = await createUserIdentity()

    let adminRoom: (Room & RolesPluginApi) | undefined
    let aliceTab1: (Room & RolesPluginApi) | undefined
    let aliceTab2: (Room & RolesPluginApi) | undefined
    let attackerTab1: (Room & RolesPluginApi) | undefined
    let attackerTab2: (Room & RolesPluginApi) | undefined
    let limiterRoom: (Room & RolesPluginApi) | undefined

    try {
      const [
        limiterSlot,
        adminSlot,
        alice1Slot,
        alice2Slot,
        attacker1Slot,
        attacker2Slot
      ] = await createSortedJoinRooms(6, () => makeJoinRoom(), appId)
      const limiterPeerId = limiterSlot!.peerId
      const adminPeerId = adminSlot!.peerId
      const alice1PeerId = alice1Slot!.peerId
      const alice2PeerId = alice2Slot!.peerId
      const attacker1PeerId = attacker1Slot!.peerId
      const attacker2PeerId = attacker2Slot!.peerId

      adminRoom = adminSlot!.joinRoom(
        {
          appId,
          identity: adminUser,
          use: [roles({selfAsAdmin: true})],
          rtcPolyfill
        },
        'activist-hq'
      )
      const authInfo = await adminRoom.getSelf()

      aliceTab1 = alice1Slot!.joinRoom(
        {
          appId,
          identity: aliceUser,
          use: [roles()],
          rtcPolyfill
        },
        authInfo.roomId
      )

      await waitFor(
        () =>
          alice1PeerId in adminRoom!.getPeers() &&
          adminPeerId in aliceTab1!.getPeers(),
        3_000
      )

      // Admin grants 'moderator' to Alice's userId while Alice is on Tab 1
      await adminRoom.grantRole(aliceUser.userId, 'moderator')
      await waitFor(() => aliceTab1!.getRoles().includes('moderator'), 3_000)

      // Alice opens Tab 2 (or reloads with persistent userId -> new peerId alice2PeerId)
      aliceTab2 = alice2Slot!.joinRoom(
        {
          appId,
          identity: aliceUser,
          use: [roles()],
          rtcPolyfill
        },
        authInfo.roomId
      )

      await waitFor(
        () =>
          alice2PeerId in adminRoom!.getPeers() &&
          aliceTab2!.getRoles().includes('moderator'),
        3_000
      )

      // Alice Tab 2 can send on a moderator-gated action AND update a moderator-gated state!
      const modAlertsAtAdmin: Array<MessageContext & {msg: string}> = []
      adminRoom
        .makeAction<string>('mod-alert', {
          roles: 'moderator'
        })
        .onMessage((msg, ctx) => {
          modAlertsAtAdmin.push({msg, ...ctx})
        })
      const modAlertTab2 = aliceTab2.makeAction<string>('mod-alert', {
        roles: 'moderator'
      })

      const adminTopicState = adminRoom.makeState<string>('topic', 'initial', {
        roles: 'moderator'
      })
      const tab2TopicState = aliceTab2.makeState<string>('topic', 'initial', {
        roles: 'moderator'
      })

      await modAlertTab2.send('verified-from-tab-2')
      await waitFor(() => modAlertsAtAdmin.length === 1, 3_000)
      assert.equal(modAlertsAtAdmin[0]!.msg, 'verified-from-tab-2')
      assert.equal(modAlertsAtAdmin[0]!.peerId, alice2PeerId)
      assert.equal(modAlertsAtAdmin[0]!.userId, aliceUser.userId)
      assert.deepEqual(modAlertsAtAdmin[0]!.roles, ['moderator'])

      await tab2TopicState.set('updated-by-tab-2')
      await waitFor(() => adminTopicState.get() === 'updated-by-tab-2', 3_000)
      assert.equal(adminTopicState.getMeta()?.peerId, alice2PeerId)
      assert.equal(adminTopicState.getMeta()?.userId, aliceUser.userId)

      const adminErrors: RecordedError[] = []
      const attackerTab1Errors: RecordedError[] = []
      adminRoom.onError(err => adminErrors.push(err))

      // Attacker joins, gets banned by userId, and then tries to evade the ban by opening a new tab with a fresh peerId
      attackerTab1 = attacker1Slot!.joinRoom(
        {
          appId,
          identity: attackerUser,
          use: [roles()],
          rtcPolyfill
        },
        authInfo.roomId
      )
      attackerTab1.onError(err => attackerTab1Errors.push(err))
      await waitFor(() => attacker1PeerId in adminRoom!.getPeers(), 3_000)
      await adminRoom.ban(attackerUser.userId, {reason: 'disruptor'})
      await waitFor(
        () =>
          !(attacker1PeerId in adminRoom!.getPeers()) &&
          attackerTab1Errors.length > 0,
        3_000
      )
      assert.equal(attackerTab1Errors[0]!.code, 'banned')
      assert.equal(attackerTab1Errors[0]!.reason, 'disruptor')
      await attackerTab1.leave()

      const attackerTab2Errors: RecordedError[] = []
      attackerTab2 = attacker2Slot!.joinRoom(
        {
          appId,
          identity: attackerUser,
          use: [roles()],
          rtcPolyfill
        },
        authInfo.roomId
      )
      attackerTab2.onError(err => attackerTab2Errors.push(err))

      await waitFor(() => attackerTab2Errors.length > 0, 3_000)
      assert.ok(
        attackerTab2Errors.some(
          e => e.code === 'banned' && e.reason === 'disruptor'
        ),
        'banned userId opening a new tab must be rejected during handshake with reason'
      )
      assert.deepEqual(
        adminErrors,
        [],
        'admin enforcing a ban must not receive banned error'
      )
      assert.equal(attacker2PeerId in adminRoom.getPeers(), false)

      // Newcomer advertising limit: 1 refuses other users locally without self-evicting or ejecting established members
      const limiterUser = await createUserIdentity()
      const limiterErrors: RecordedError[] = []
      limiterRoom = limiterSlot!.joinRoom(
        {
          appId,
          identity: limiterUser,
          use: [roles()],
          limit: 1,
          rtcPolyfill
        },
        authInfo.roomId
      )
      limiterRoom.onError(err => limiterErrors.push(err))

      await wait(200)
      assert.deepEqual(limiterErrors, [])
      assert.deepEqual(Object.keys(limiterRoom.getPeers()), [])
      assert.equal(limiterPeerId in adminRoom.getPeers(), false)
      // Established members (admin + alice) must remain connected!
      assert.equal(alice1PeerId in adminRoom.getPeers(), true)
      assert.equal(alice2PeerId in adminRoom.getPeers(), true)
    } finally {
      await Promise.all([
        adminRoom?.leave().catch(() => {}),
        aliceTab1?.leave().catch(() => {}),
        aliceTab2?.leave().catch(() => {}),
        attackerTab1?.leave().catch(() => {}),
        attackerTab2?.leave().catch(() => {}),
        limiterRoom?.leave().catch(() => {})
      ])
    }
  }
)
