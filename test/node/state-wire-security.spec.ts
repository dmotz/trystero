import assert from 'node:assert/strict'
import test from './test.ts'
import {
  compareStateRecords,
  createRoomAuthority,
  roles,
  signStateRecord,
  verifyStateRecord
} from '../../packages/core/src/authority.ts'
import {createUserIdentity} from '../../packages/core/src/identity.ts'
import {createStateManager} from '../../packages/core/src/state.ts'
import type {AuthoritativeStateRecord} from '../../packages/core/src/internal-types.ts'
import {wait} from './peer-harness.ts'

void test('S10: AuthoritativeStateRecord binds userId in signature and validates userId/updatedBy shapes', async () => {
  const adminUser = await createUserIdentity()
  const otherUser = await createUserIdentity()
  const s10RoomId = `s10-room~${adminUser.userId}`
  const auth = createRoomAuthority({
    selfId: 'admin-ep',
    appId: 's10-app',
    initialRoomId: s10RoomId,
    admin: {selfAsAdmin: true},
    getLocalUserIdentity: async () => adminUser
  })
  await auth.getAuthorityInfo()
  const cert = await auth.issueRoleCertificate(adminUser.userId, ['admin'])

  const rec = await signStateRecord(adminUser.sign, adminUser.signPubJwk, {
    appId: 's10-app',
    roomId: s10RoomId,
    ns: 'score',
    peerId: 'admin-ep',
    userId: adminUser.userId,
    val: {pts: 10},
    cert
  })

  const rootUserIds = new Set([adminUser.userId])
  assert.equal(
    await verifyStateRecord(rec, 's10-app', s10RoomId, ['admin'], rootUserIds),
    true
  )

  // Rewriting userId or injecting malformed peerId fails verification
  assert.equal(
    await verifyStateRecord(
      {...rec, userId: otherUser.userId},
      's10-app',
      s10RoomId,
      ['admin'],
      rootUserIds
    ),
    false
  )
  assert.equal(
    await verifyStateRecord(
      {...rec, peerId: 'bad peer id with spaces!'},
      's10-app',
      s10RoomId,
      ['admin'],
      rootUserIds
    ),
    false
  )
})

void test('D7: 60s fixed clock skew tolerance rejects far-future records and makeState causal HLC supersedes stale pre-rejoin state', async () => {
  assert.throws(
    () => roles({maxClockSkewMs: 300_000} as never),
    /Unknown roles config option "maxClockSkewMs"/
  )

  const adminUser = await createUserIdentity()
  const guestUser = await createUserIdentity()
  const d7RoomId = `d7-room~${adminUser.userId}`

  const makePairedState = (
    selfId: string,
    user: typeof adminUser,
    authority: ReturnType<typeof createRoomAuthority>,
    onBroadcast?: (rec: AuthoritativeStateRecord) => void
  ) =>
    createStateManager({
      appId: 'd7-app',
      getRoomId: () => authority.getEffectiveRoomId(),
      getSelfId: () => selfId,
      getLocalUserId: () => user.userId,
      ensureReady: async () => ({
        selfId,
        user,
        roomId: authority.getEffectiveRoomId()
      }),
      hasRolesPlugin: () => true,
      getRolesProvider: () => ({...authority, onPeerDescriptorCert: () => {}}),
      isPeerActive: () => true,
      isDirectPeer: () => true,
      getDirectPeerIds: () => [],
      isUserOnline: () => true,
      getKnownPeerUserId: () => undefined,
      isPeerBanned: id => authority.isPeerBanned(id),
      getPeerRoles: id => authority.getPeerRoles(id),
      ...(onBroadcast ? {onBroadcastRecord: onBroadcast} : {})
    })

  const strictGuest = createRoomAuthority({
    selfId: 'strict-guest',
    appId: 'd7-app',
    initialRoomId: d7RoomId,
    admin: {},
    getLocalUserIdentity: async () => guestUser
  })
  const adminSession1 = createRoomAuthority({
    selfId: 'admin-s1',
    appId: 'd7-app',
    initialRoomId: d7RoomId,
    admin: {selfAsAdmin: true},
    getLocalUserIdentity: async () => adminUser
  })
  await Promise.all([
    strictGuest.getAuthorityInfo(),
    adminSession1.getAuthorityInfo()
  ])

  const guestState = makePairedState('strict-guest', guestUser, strictGuest)
  guestState.makeState('clock', '')
  guestState.makeState('phase', 'init')

  const adminCert = await adminSession1.issueRoleCertificate(adminUser.userId, [
    'admin'
  ])
  const nearFutureRec = await signStateRecord(
    adminUser.sign,
    adminUser.signPubJwk,
    {
      appId: 'd7-app',
      roomId: d7RoomId,
      ns: 'clock',
      hlc: Date.now() + 30_000,
      peerId: 'admin-s1',
      userId: adminUser.userId,
      val: 'within-60s-ok',
      cert: adminCert
    }
  )
  const farFutureRec = await signStateRecord(
    adminUser.sign,
    adminUser.signPubJwk,
    {
      appId: 'd7-app',
      roomId: d7RoomId,
      ns: 'clock',
      hlc: Date.now() + 180_000,
      peerId: 'admin-s1',
      userId: adminUser.userId,
      val: 'beyond-60s-rejected',
      cert: adminCert
    }
  )
  assert.equal(await guestState.verifyAndApplyStateRecord(farFutureRec), false)
  assert.equal(await guestState.verifyAndApplyStateRecord(nearFutureRec), true)

  // Session 1 performs 5 updates, then admin reloads/rejoins as Session 2 (higher HLC!)
  const staleHighSeq: AuthoritativeStateRecord[] = []
  const s1Mgr = makePairedState('admin-s1', adminUser, adminSession1, rec =>
    staleHighSeq.push(rec)
  )
  const stateS1 = s1Mgr.makeState('phase', 'init')
  for (let i = 1; i <= 5; i++) {
    await stateS1.set(`s1-step-${i}`)
  }
  const s1Final = staleHighSeq.at(-1)!
  assert.equal(staleHighSeq.length, 5)
  assert.equal(await guestState.verifyAndApplyStateRecord(s1Final), true)

  await wait(10)
  const adminSession2 = createRoomAuthority({
    selfId: 'admin-s2',
    appId: 'd7-app',
    initialRoomId: d7RoomId,
    admin: {selfAsAdmin: true},
    getLocalUserIdentity: async () => adminUser
  })
  await adminSession2.getAuthorityInfo()
  const s2Published: AuthoritativeStateRecord[] = []
  const s2Mgr = makePairedState('admin-s2', adminUser, adminSession2, rec =>
    s2Published.push(rec)
  )
  const stateS2 = s2Mgr.makeState('phase', 'init')
  await stateS2.set('fresh-after-rejoin')
  const s2First = s2Published[0]!
  assert.equal(s2Published.length, 1)
  assert.ok(compareStateRecords(s2First, s1Final) > 0)
  assert.equal(await guestState.verifyAndApplyStateRecord(s2First), true)
  // Replaying held old Session 1 record cannot override fresh rejoined HLC
  assert.equal(await guestState.verifyAndApplyStateRecord(s1Final), false)
})
