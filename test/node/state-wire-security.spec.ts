import assert from 'node:assert/strict'
import test from './test.ts'
import {createRoomAuthority, roles} from '../../packages/core/src/authority.ts'
import {createUserIdentity} from '../../packages/core/src/identity.ts'
import type {AuthoritativeStateRecord} from '../../packages/core/src/internal-types.ts'
import {maxObservedClockDragMs} from '../../packages/core/src/signed-record.ts'
import {
  compareStateRecords,
  createStateManager,
  signStateRecord
} from '../../packages/core/src/state.ts'
import type {DataPayload} from '../../packages/core/src/types.ts'
import {testPeerId, wait} from './peer-harness.ts'

void test('S10: AuthoritativeStateRecord binds userId in signature and validates userId/peerId shapes', async () => {
  const adminUser = await createUserIdentity()
  const otherUser = await createUserIdentity()
  const adminPeerId = testPeerId('s10-admin-ep')
  const readerPeerId = testPeerId('s10-reader-ep')
  const s10RoomId = `s10-room~${adminUser.userId}`

  const adminAuth = createRoomAuthority({
    selfId: adminPeerId,
    appId: 's10-app',
    initialRoomId: s10RoomId,
    admin: {selfAsAdmin: true},
    getLocalUserIdentity: async () => adminUser
  })
  const readerAuth = createRoomAuthority({
    selfId: readerPeerId,
    appId: 's10-app',
    initialRoomId: s10RoomId,
    admin: {},
    getLocalUserIdentity: async () => otherUser
  })
  await Promise.all([
    adminAuth.getAuthorityInfo(),
    readerAuth.getAuthorityInfo()
  ])
  const cert = await adminAuth.issueRoleCertificate(adminUser.userId, ['admin'])

  let invalidRecords = 0
  const stateManager = createStateManager({
    appId: 's10-app',
    getRoomId: () => readerAuth.getEffectiveRoomId(),
    getSelfId: () => readerPeerId,
    getLocalUserId: () => otherUser.userId,
    ensureReady: async () => ({
      selfId: readerPeerId,
      user: otherUser,
      roomId: readerAuth.getEffectiveRoomId()
    }),
    hasRolesPlugin: () => true,
    getRolesProvider: () => ({...readerAuth, onPeerDescriptorCert: () => {}}),
    isPeerActive: () => true,
    isDirectPeer: () => true,
    getDirectPeerIds: () => [],
    isUserOnline: () => true,
    getKnownPeerUserId: pid =>
      pid === adminPeerId ? adminUser.userId : undefined,
    isPeerBanned: id => readerAuth.isPeerBanned(id),
    getPeerRoles: id => readerAuth.getPeerRoles(id),
    onInvalidRecord: () => {
      invalidRecords++
    }
  })

  try {
    const score = stateManager.makeState('score', {pts: 0}, {roles: ['admin']})

    const rec = await signStateRecord(adminUser.sign, adminUser.signPubJwk, {
      appId: 's10-app',
      roomId: s10RoomId,
      ns: 'score',
      peerId: adminPeerId,
      userId: adminUser.userId,
      val: {pts: 10},
      cert
    })

    // Rewriting userId or injecting malformed peerId/userId fails verification and increments invalid counter
    assert.equal(
      await stateManager.verifyAndApplyStateRecord(
        {...rec, userId: otherUser.userId},
        adminPeerId
      ),
      false
    )
    assert.equal(invalidRecords, 1)

    assert.equal(
      await stateManager.verifyAndApplyStateRecord(
        {...rec, peerId: 'bad peer id with spaces!'},
        adminPeerId
      ),
      false
    )
    assert.equal(invalidRecords, 2)

    assert.equal(
      await stateManager.verifyAndApplyStateRecord(
        {...rec, userId: 'malformed-user-id'},
        adminPeerId
      ),
      false
    )
    assert.equal(invalidRecords, 3)
    assert.deepEqual(score.get(), {pts: 0})

    assert.equal(
      await stateManager.verifyAndApplyStateRecord(rec, adminPeerId),
      true
    )
    assert.deepEqual(score.get(), {pts: 10})
    assert.equal(score.getMeta()?.userId, adminUser.userId)
    assert.equal(score.getMeta()?.peerId, adminPeerId)
  } finally {
    stateManager.destroy()
  }
})

void test('D7: 60s fixed clock skew tolerance rejects far-future records, bounds clock drag, and causal HLC supersedes pre-rejoin state', async () => {
  assert.throws(
    () => roles({maxClockSkewMs: 300_000} as never),
    /Unknown roles config option "maxClockSkewMs"/
  )

  const adminUser = await createUserIdentity()
  const guestUser = await createUserIdentity()
  const guestPeerId = testPeerId('d7-strict-guest')
  const adminS1PeerId = testPeerId('d7-admin-s1')
  const adminS2PeerId = testPeerId('d7-admin-s2')
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
      ...(onBroadcast
        ? {
            makeInternalAction: <T extends DataPayload>(ns: string) => ({
              send: async (data: T) => {
                if (
                  ns === 'state' &&
                  data &&
                  typeof data === 'object' &&
                  (data as {t?: string}).t === 'rec'
                ) {
                  const wire = (
                    data as {
                      r: Omit<AuthoritativeStateRecord, 'appId' | 'roomId'>
                    }
                  ).r
                  onBroadcast({
                    ...wire,
                    appId: 'd7-app',
                    roomId: authority.getEffectiveRoomId()
                  } as AuthoritativeStateRecord)
                }
              },
              onMessage: () => () => {},
              onReceive: () => () => {},
              onReceiveProgress: () => () => {}
            })
          }
        : {})
    })

  const strictGuest = createRoomAuthority({
    selfId: guestPeerId,
    appId: 'd7-app',
    initialRoomId: d7RoomId,
    admin: {},
    getLocalUserIdentity: async () => guestUser
  })
  const adminSession1 = createRoomAuthority({
    selfId: adminS1PeerId,
    appId: 'd7-app',
    initialRoomId: d7RoomId,
    admin: {selfAsAdmin: true},
    getLocalUserIdentity: async () => adminUser
  })
  await Promise.all([
    strictGuest.getAuthorityInfo(),
    adminSession1.getAuthorityInfo()
  ])

  const guestPublished: AuthoritativeStateRecord[] = []
  const guestState = makePairedState(
    guestPeerId,
    guestUser,
    strictGuest,
    rec => {
      guestPublished.push(rec)
    }
  )
  guestState.makeState('clock', '')
  guestState.makeState('phase', 'init')
  const guestOpen = guestState.makeState('open-clock', '', {roles: '*'})

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
      peerId: adminS1PeerId,
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
      peerId: adminS1PeerId,
      userId: adminUser.userId,
      val: 'beyond-60s-rejected',
      cert: adminCert
    }
  )

  try {
    assert.equal(
      await guestState.verifyAndApplyStateRecord(farFutureRec),
      false
    )
    assert.equal(
      await guestState.verifyAndApplyStateRecord(nearFutureRec),
      true
    )

    // Clock drag from observing a +30s record is bounded by maxObservedClockDragMs (5_000ms)
    await guestOpen.set('guest-local-write')
    assert.equal(guestPublished.length, 1)
    assert.ok(
      guestPublished[0]!.hlc <= Date.now() + maxObservedClockDragMs + 1_000,
      `expected local clock drag bounded by ${maxObservedClockDragMs}ms, got +${guestPublished[0]!.hlc - Date.now()}ms`
    )

    // Session 1 performs 5 updates, then admin reloads/rejoins as Session 2 (higher HLC!)
    const staleHighSeq: AuthoritativeStateRecord[] = []
    const s1Mgr = makePairedState(
      adminS1PeerId,
      adminUser,
      adminSession1,
      rec => staleHighSeq.push(rec)
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
      selfId: adminS2PeerId,
      appId: 'd7-app',
      initialRoomId: d7RoomId,
      admin: {selfAsAdmin: true},
      getLocalUserIdentity: async () => adminUser
    })
    await adminSession2.getAuthorityInfo()
    const s2Published: AuthoritativeStateRecord[] = []
    const s2Mgr = makePairedState(
      adminS2PeerId,
      adminUser,
      adminSession2,
      rec => s2Published.push(rec)
    )
    const stateS2 = s2Mgr.makeState('phase', 'init')
    await stateS2.set('fresh-after-rejoin')
    const s2First = s2Published[0]!
    assert.equal(s2Published.length, 1)
    assert.ok(compareStateRecords(s2First, s1Final) > 0)
    assert.equal(await guestState.verifyAndApplyStateRecord(s2First), true)
    // Replaying held old Session 1 record cannot override fresh rejoined HLC
    assert.equal(await guestState.verifyAndApplyStateRecord(s1Final), false)

    s1Mgr.destroy()
    s2Mgr.destroy()
  } finally {
    guestState.destroy()
  }
})
