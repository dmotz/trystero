import {expect, test} from '@playwright/test'
import {strategyConfigs} from '../strategy-configs'
import {installLoopbackMdnsPeerConnection} from './mdns-loopback'

const testUrl = (): string =>
  `https://127.0.0.1:${process.env['TRYSTERO_TEST_PORT'] ?? '8080'}/test`

const wsRelayScriptUrl = './test/dist/trystero-ws-relay.js'
const loadLib = async (path: string) => (window.trystero = await import(path))

test('Trystero: ws-relay: same-origin tabs share persistent local identity via IndexedDB and clearUserIdentity rotates userId and peerId', async ({
  browser,
  browserName
}) => {
  test.setTimeout(60_000)
  const appId = `idb-tabs-app-${Math.random()}`
  const roomId = `idb-tabs-room-${Math.random()}`
  const baseConfig = {
    ...strategyConfigs['ws-relay'],
    appId,
    rtcConfig: {iceServers: []}
  }

  const sharedContext = await browser.newContext({ignoreHTTPSErrors: true})
  const remoteContext = await browser.newContext({ignoreHTTPSErrors: true})

  try {
    const [tab1, tab2, remotePage] = await Promise.all([
      sharedContext.newPage(),
      sharedContext.newPage(),
      remoteContext.newPage()
    ])
    if (browserName === 'firefox' || browserName === 'webkit') {
      await Promise.all(
        [tab1, tab2, remotePage].map(installLoopbackMdnsPeerConnection)
      )
    }

    await Promise.all([
      tab1.goto(testUrl()),
      tab2.goto(testUrl()),
      remotePage.goto(testUrl())
    ])
    await Promise.all([
      tab1.evaluate(loadLib, wsRelayScriptUrl),
      tab2.evaluate(loadLib, wsRelayScriptUrl),
      remotePage.evaluate(loadLib, wsRelayScriptUrl)
    ])

    const joinTab = async ({
      rId,
      cfg
    }: {
      rId: string
      cfg: Record<string, unknown>
    }) => {
      const room = (window[rId] = window.trystero.joinRoom(cfg, rId))
      return room.getSelf()
    }

    // Concurrently join from two same-origin tabs to exercise IndexedDB + navigator.locks
    const [self1, self2, remoteSelf] = await Promise.all([
      tab1.evaluate(joinTab, {
        rId: roomId,
        cfg: {...baseConfig, identity: 'local'}
      }),
      tab2.evaluate(joinTab, {
        rId: roomId,
        cfg: {...baseConfig, identity: 'local'}
      }),
      remotePage.evaluate(joinTab, {
        rId: roomId,
        cfg: {...baseConfig, identity: 'none'}
      })
    ])

    expect(self1.identityPersistence).toBe('local')
    expect(self2.identityPersistence).toBe('local')
    expect(remoteSelf.identityPersistence).toBe('none')
    expect(self1.userId).toBe(self2.userId)
    expect(self1.peerId).not.toBe(self2.peerId)
    expect(self1.userId).not.toBe(remoteSelf.userId)

    // Remote peer sees both tabs grouped under one logical user
    await expect
      .poll(
        () =>
          remotePage.evaluate((rId: string) => {
            const users = window[rId].getUsers() as Record<
              string,
              {peerIds: string[]}
            >
            const entry = Object.entries(users)[0]
            return entry
              ? {userId: entry[0], peerCount: entry[1].peerIds.length}
              : null
          }, roomId),
        {timeout: 20_000}
      )
      .toEqual({userId: self1.userId, peerCount: 2})

    // Leave both tabs, clearUserIdentity(appId), and confirm both userId and peerId rotate
    await Promise.all([
      tab1.evaluate((rId: string) => window[rId].leave(), roomId),
      tab2.evaluate((rId: string) => window[rId].leave(), roomId)
    ])

    const rotatedSelf = await tab1.evaluate(
      async ({
        aId,
        rId,
        cfg
      }: {
        aId: string
        rId: string
        cfg: Record<string, unknown>
      }) => {
        await window.trystero.clearUserIdentity(aId)
        const room = (window[rId] = window.trystero.joinRoom(
          {...cfg, identity: 'local', passive: true},
          rId
        ))
        try {
          return await room.getSelf()
        } finally {
          await room.leave()
        }
      },
      {aId: appId, rId: `${roomId}-rotated`, cfg: baseConfig}
    )

    expect(rotatedSelf.userId).not.toBe(self1.userId)
    expect(rotatedSelf.peerId).not.toBe(self1.peerId)

    await remotePage.evaluate((rId: string) => window[rId].leave(), roomId)
  } finally {
    await Promise.all([sharedContext.close(), remoteContext.close()])
  }
})

test('Trystero: ws-relay: self-certifying roles, makeUserState flush before onUserJoin, ban state purge + unban, and maxUsers admission', async ({
  browser,
  browserName
}) => {
  test.setTimeout(75_000)
  const appId = `v027-authority-${Math.random()}`
  const baseRoomId = `lobby-${Math.random().toString(36).slice(2, 10)}`
  const baseConfig = {
    ...strategyConfigs['ws-relay'],
    appId,
    identity: 'local',
    rtcConfig: {iceServers: []}
  }

  const [adminCtx, memberCtx, extraCtx] = await Promise.all([
    browser.newContext({ignoreHTTPSErrors: true}),
    browser.newContext({ignoreHTTPSErrors: true}),
    browser.newContext({ignoreHTTPSErrors: true})
  ])

  try {
    const [adminPage, memberPage, extraPage] = await Promise.all([
      adminCtx.newPage(),
      memberCtx.newPage(),
      extraCtx.newPage()
    ])
    if (browserName === 'firefox' || browserName === 'webkit') {
      await Promise.all(
        [adminPage, memberPage, extraPage].map(
          installLoopbackMdnsPeerConnection
        )
      )
    }

    await Promise.all([
      adminPage.goto(testUrl()),
      memberPage.goto(testUrl()),
      extraPage.goto(testUrl())
    ])
    await Promise.all([
      adminPage.evaluate(loadLib, wsRelayScriptUrl),
      memberPage.evaluate(loadLib, wsRelayScriptUrl),
      extraPage.evaluate(loadLib, wsRelayScriptUrl)
    ])

    // 1. Admin creates self-certifying room with maxUsers: 2 and initializes shared + user state
    const adminInfo = await adminPage.evaluate(
      async ({
        rId,
        cfg
      }: {
        rId: string
        cfg: Record<string, unknown>
      }): Promise<{
        roomId: string
        userId: string
        peerId: string
        isAdmin: boolean
      }> => {
        const mod = window.trystero
        const room = (window['adminRoom'] = mod.joinRoom(
          {
            ...cfg,
            maxUsers: 2,
            use: [mod.roles({selfAsAdmin: true})]
          },
          rId
        ))
        const profile = (window['adminProfile'] = room.makeUserState(
          'profile',
          {name: 'unset'}
        ))
        const board = (window['adminBoard'] = room.makeState(
          'board',
          {
            topic: 'init'
          },
          {roles: '*'}
        ))
        const modAction = room.makeAction('mod-alert', {roles: ['mod']})
        window['receivedModAlerts'] = []
        modAction.onMessage(
          (payload: unknown, ctx: {userId: string; peerId: string}) => {
            window['receivedModAlerts'].push({payload, userId: ctx.userId})
          }
        )
        window['adminJoinSnapshot'] = {}
        room.onUserJoin(({userId}: {userId: string}) => {
          window['adminJoinSnapshot'][userId] = profile.get(userId)
        })
        await profile.set({name: 'Host'})
        await board.set({topic: 'welcome'})
        const self = await room.getSelf()
        return {
          roomId: self.roomId,
          userId: self.userId,
          peerId: self.peerId,
          isAdmin: self.isAdmin
        }
      },
      {rId: baseRoomId, cfg: baseConfig}
    )

    expect(adminInfo.isAdmin).toBe(true)
    expect(adminInfo.roomId).toBe(`${baseRoomId}~${adminInfo.userId}`)

    // 2. Member joins self-certifying roomId; verify makeUserState is flushed BEFORE onUserJoin fires
    const memberInfo = await memberPage.evaluate(
      async ({
        certRoomId,
        cfg
      }: {
        certRoomId: string
        cfg: Record<string, unknown>
      }): Promise<{userId: string; peerId: string; isAdmin: boolean}> => {
        const mod = window.trystero
        const room = (window['memberRoom'] = mod.joinRoom(
          {
            ...cfg,
            maxUsers: 2,
            use: [mod.roles()]
          },
          certRoomId
        ))
        const profile = (window['memberProfile'] = room.makeUserState(
          'profile',
          {name: 'unset'}
        ))
        window['memberBoard'] = room.makeState(
          'board',
          {topic: 'init'},
          {roles: '*'}
        )
        window['memberModAction'] = room.makeAction('mod-alert', {
          roles: ['mod']
        })
        window['memberErrors'] = []
        room.onError((err: {code: string; reason?: string}) => {
          window['memberErrors'].push({code: err.code, reason: err.reason})
        })
        window['memberJoinSnapshot'] = {}
        room.onUserJoin(({userId}: {userId: string}) => {
          window['memberJoinSnapshot'][userId] = profile.get(userId)
        })
        void profile.set({name: 'Alice'})
        const self = await room.getSelf()
        return {
          userId: self.userId,
          peerId: self.peerId,
          isAdmin: self.isAdmin
        }
      },
      {certRoomId: adminInfo.roomId, cfg: baseConfig}
    )

    expect(memberInfo.isAdmin).toBe(false)

    await expect
      .poll(
        () =>
          memberPage.evaluate(
            (adminUid: string) => window['memberJoinSnapshot'][adminUid],
            adminInfo.userId
          ),
        {timeout: 20_000}
      )
      .toEqual({name: 'Host'})

    await expect
      .poll(
        () =>
          adminPage.evaluate(
            (memberUid: string) => window['adminJoinSnapshot'][memberUid],
            memberInfo.userId
          ),
        {timeout: 20_000}
      )
      .toEqual({name: 'Alice'})

    await expect
      .poll(() => memberPage.evaluate(() => window['memberBoard'].get()), {
        timeout: 10_000
      })
      .toEqual({topic: 'welcome'})

    // 3. Third user attempting to join maxUsers: 2 room receives 'room-full' error
    const roomFullCode = await extraPage.evaluate(
      async ({
        certRoomId,
        cfg
      }: {
        certRoomId: string
        cfg: Record<string, unknown>
      }): Promise<string> => {
        const mod = window.trystero
        return new Promise<string>((resolve, reject) => {
          const room = mod.joinRoom(
            {...cfg, maxUsers: 2, use: [mod.roles()]},
            certRoomId
          )
          const timer = setTimeout(() => {
            void room.leave()
            reject(new Error('timed out waiting for room-full'))
          }, 20_000)
          room.onError((err: {code: string}) => {
            if (err.code === 'room-full') {
              clearTimeout(timer)
              void room.leave()
              resolve(err.code)
            }
          })
        })
      },
      {certRoomId: adminInfo.roomId, cfg: baseConfig}
    )
    expect(roomFullCode).toBe('room-full')

    // 4. Role grant + role-gated action + shared state write
    await adminPage.evaluate(async (memberUid: string) => {
      await window['adminRoom'].grantRole(memberUid, 'mod')
    }, memberInfo.userId)

    await expect
      .poll(() => memberPage.evaluate(() => window['memberRoom'].getRoles()), {
        timeout: 10_000
      })
      .toContain('mod')

    await memberPage.evaluate(async () => {
      await window['memberModAction'].send({alert: 'all-clear'})
      await window['memberBoard'].set({topic: 'alice-takeover'})
    })

    await expect
      .poll(() => adminPage.evaluate(() => window['receivedModAlerts']), {
        timeout: 10_000
      })
      .toEqual([{payload: {alert: 'all-clear'}, userId: memberInfo.userId}])

    await expect
      .poll(() => adminPage.evaluate(() => window['adminBoard'].get()), {
        timeout: 10_000
      })
      .toEqual({topic: 'alice-takeover'})

    // 5. Ban purges banned user's userState + sharedState and disconnects them; unban allows rejoin
    await adminPage.evaluate(async (memberUid: string) => {
      await window['adminRoom'].ban(memberUid, {reason: 'spamming'})
    }, memberInfo.userId)

    await expect
      .poll(
        () =>
          adminPage.evaluate(
            (memberUid: string) => ({
              peers: Object.keys(window['adminRoom'].getPeers()).length,
              isBanned: window['adminRoom'].isBanned(memberUid),
              roles: window['adminRoom'].getRoles(memberUid),
              hasUserProfile: window['adminProfile'].has(memberUid),
              board: window['adminBoard'].get()
            }),
            memberInfo.userId
          ),
        {timeout: 10_000}
      )
      .toEqual({
        peers: 0,
        isBanned: true,
        roles: [],
        hasUserProfile: false,
        board: {topic: 'init'}
      })

    await expect
      .poll(() => memberPage.evaluate(() => window['memberErrors']), {
        timeout: 10_000
      })
      .toContainEqual({code: 'banned', reason: 'spamming'})

    await memberPage.evaluate(() => window['memberRoom'].leave())

    // Unban and rejoin with the exact same persistent userId
    await adminPage.evaluate(async (memberUid: string) => {
      await window['adminRoom'].unban(memberUid)
    }, memberInfo.userId)

    const rejoinedUserId = await memberPage.evaluate(
      async ({
        certRoomId,
        cfg
      }: {
        certRoomId: string
        cfg: Record<string, unknown>
      }): Promise<string> => {
        const room = (window['memberRoom2'] = window.trystero.joinRoom(
          {...cfg, maxUsers: 2, use: [window.trystero.roles()]},
          certRoomId
        ))
        const self = await room.getSelf()
        return self.userId
      },
      {certRoomId: adminInfo.roomId, cfg: baseConfig}
    )
    expect(rejoinedUserId).toBe(memberInfo.userId)

    await expect
      .poll(
        () =>
          adminPage.evaluate(() => Object.keys(window['adminRoom'].getUsers())),
        {timeout: 20_000}
      )
      .toEqual([memberInfo.userId])

    await Promise.all([
      adminPage.evaluate(() => window['adminRoom'].leave()),
      memberPage.evaluate(() => window['memberRoom2'].leave())
    ])
  } finally {
    await Promise.all([adminCtx.close(), memberCtx.close(), extraCtx.close()])
  }
})
