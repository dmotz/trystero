import assert from 'node:assert/strict'
import test from './test.ts'
import {
  type Room,
  clearUserIdentity,
  roles
} from '../../packages/core/src/index.ts'
import {createMemorySignalBus} from './memory-rtc.ts'

void test('Default local identity with IndexedDB: stores non-extractable CryptoKey without touching Web Storage, suppresses ephemeral admin warning, and reuses persistent userId across rooms', async t => {
  for (const name of ['sessionStorage', 'localStorage', 'indexedDB']) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
    t.after(() => {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor)
      } else {
        Reflect.deleteProperty(globalThis, name)
      }
    })
  }

  const sessionMap = new Map<string, string>()
  const localMap = new Map<string, string>()
  const idbStore = new Map<string, any>()

  const makeMockStorage = (map: Map<string, string>) => ({
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v)
    },
    removeItem: (k: string) => {
      map.delete(k)
    }
  })

  const mockIndexedDB = {
    open: () => {
      const req: any = {
        result: {
          objectStoreNames: {
            contains: () => true
          },
          createObjectStore: () => ({}),
          transaction: () => {
            const tx: any = {
              objectStore: () => ({
                get: (key: string) => {
                  const getReq: any = {
                    result: idbStore.get(key),
                    onsuccess: null,
                    onerror: null
                  }
                  queueMicrotask(() => getReq.onsuccess?.())
                  return getReq
                },
                add: (val: any, key: string) => {
                  const addReq: any = {
                    onsuccess: null,
                    onerror: null
                  }
                  queueMicrotask(() => {
                    if (idbStore.has(key)) {
                      addReq.onerror?.()
                      queueMicrotask(() => tx.onerror?.())
                    } else {
                      idbStore.set(key, val)
                      addReq.onsuccess?.()
                      queueMicrotask(() => tx.oncomplete?.())
                    }
                  })
                  return addReq
                },
                put: (val: any, key: string) => {
                  const putReq: any = {
                    onsuccess: null,
                    onerror: null
                  }
                  queueMicrotask(() => {
                    idbStore.set(key, val)
                    putReq.onsuccess?.()
                    queueMicrotask(() => tx.oncomplete?.())
                  })
                  return putReq
                },
                delete: (key: string) => {
                  const delReq: any = {
                    onsuccess: null,
                    onerror: null
                  }
                  queueMicrotask(() => {
                    idbStore.delete(key)
                    delReq.onsuccess?.()
                    queueMicrotask(() => tx.oncomplete?.())
                  })
                  return delReq
                }
              }),
              oncomplete: null,
              onabort: null,
              onerror: null
            }
            return tx
          },
          close: () => {}
        },
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null
      }
      queueMicrotask(() => req.onsuccess?.())
      return req
    }
  }

  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    writable: true,
    value: makeMockStorage(sessionMap)
  })
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: makeMockStorage(localMap)
  })
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    writable: true,
    value: mockIndexedDB
  })

  const {makeJoinRoom, rtcPolyfill} = createMemorySignalBus()
  const joinRoom = makeJoinRoom()

  // 1. Default identity stores a non-extractable CryptoKey in IndexedDB keyed by appId, never writes to Web Storage, and does not warn on selfAsAdmin
  const warnings: string[] = []
  const origWarn = console.warn
  console.warn = (...args: any[]) => {
    warnings.push(args.map(String).join(' '))
  }
  let selfTab1A: Awaited<ReturnType<Room['getSelf']>>
  try {
    const roomTab1A = joinRoom(
      {
        appId: 'idb-default-app',
        use: [roles({selfAsAdmin: true})],
        rtcPolyfill
      },
      'room-a'
    )
    selfTab1A = await roomTab1A.getSelf()
    await roomTab1A.leave()
  } finally {
    console.warn = origWarn
  }

  assert.equal(
    warnings.some(w => w.includes('ephemeral identity')),
    false,
    'roles({selfAsAdmin: true}) with default browser IndexedDB identity must not warn'
  )
  assert.equal(sessionMap.size, 0, 'sessionStorage must not be touched')
  assert.equal(localMap.size, 0, 'localStorage must not be touched')

  const idbRecord = idbStore.get('idb-default-app')
  assert.ok(idbRecord, 'IndexedDB must store the local CryptoKey record')
  assert.equal(idbRecord.userId, selfTab1A.userId)
  assert.equal(
    idbRecord.privateKey.extractable,
    false,
    'CryptoKey in IndexedDB must be non-extractable (extractable: false)'
  )

  // Opening a new tab or refreshing reuses the non-extractable IndexedDB key and regains admin authority
  const roomTab2 = joinRoom(
    {
      appId: 'idb-default-app',
      use: [roles()],
      rtcPolyfill
    },
    selfTab1A.roomId
  )
  const selfTab2 = await roomTab2.getSelf()
  assert.equal(
    selfTab2.userId,
    selfTab1A.userId,
    'another tab or reload must reuse the persistent local userId by default'
  )
  assert.equal(
    selfTab2.isAdmin,
    true,
    'rejoining self-certifying room with default browser identity must retain admin authority'
  )
  await roomTab2.leave()

  // 2. Default persistent local identity derives consistent self-certifying room IDs across rooms
  const hostRoom1 = joinRoom(
    {
      appId: 'my-admin-app',
      use: [roles({selfAsAdmin: true})],
      rtcPolyfill
    },
    'friday-quiz'
  )
  const hostSelf = await hostRoom1.getSelf()
  assert.equal('fingerprint' in hostSelf, false)
  assert.equal(hostSelf.roomId, `friday-quiz~${hostSelf.userId}`)
  assert.equal(hostSelf.isAdmin, true)
  await hostRoom1.leave()

  const hostRoom2 = joinRoom(
    {
      appId: 'my-admin-app',
      use: [roles({selfAsAdmin: true})],
      rtcPolyfill
    },
    'saturday-quiz'
  )
  const hostSelf2 = await hostRoom2.getSelf()
  assert.equal(
    hostSelf.userId,
    hostSelf2.userId,
    'same appId must reuse persistent local identity across rooms'
  )
  assert.equal(hostSelf2.roomId, `saturday-quiz~${hostSelf.userId}`)
  await hostRoom2.leave()

  const hostJoined = joinRoom(
    {
      appId: 'my-admin-app',
      use: [roles()],
      rtcPolyfill
    },
    hostSelf.roomId
  )
  const rejoinedSelf = await hostJoined.getSelf()
  assert.equal(rejoinedSelf.userId, hostSelf.userId)
  assert.equal(
    rejoinedSelf.isAdmin,
    true,
    'rejoining a self-certifying room with default identity must retain admin authority'
  )
  await hostJoined.leave()

  // 3. clearUserIdentity(appId) validates appId, deletes only that appId from IndexedDB, rotates both userId and peerId, and serializes concurrent calls
  for (const badAppId of ['', '   ', undefined, null, 42]) {
    await assert.rejects(
      () => (clearUserIdentity as any)(badAppId),
      /appId is required/
    )
  }

  await clearUserIdentity('my-admin-app')
  assert.equal(
    idbStore.has('my-admin-app'),
    false,
    'clearUserIdentity must delete the target appId from IndexedDB'
  )
  assert.equal(
    idbStore.has('idb-default-app'),
    true,
    'clearUserIdentity must leave other appIds untouched in IndexedDB'
  )

  const postClearJoined = joinRoom(
    {
      appId: 'my-admin-app',
      use: [roles()],
      rtcPolyfill
    },
    hostSelf.roomId
  )
  const postClearSelf = await postClearJoined.getSelf()
  assert.notEqual(
    postClearSelf.userId,
    hostSelf.userId,
    'rejoining after clearUserIdentity must generate a fresh userId'
  )
  assert.notEqual(
    postClearSelf.peerId,
    hostSelf.peerId,
    'rejoining in the same SPA runtime after clearUserIdentity must also rotate peerId'
  )
  assert.equal(
    postClearSelf.isAdmin,
    false,
    'cleared identity must no longer hold admin authority in previous self-certifying room'
  )
  await postClearJoined.leave()

  // Un-awaited clearUserIdentity followed immediately by joinRoom serializes cleanly
  const unawaitedClear = clearUserIdentity('my-admin-app')
  const immediateNextRoom = joinRoom(
    {
      appId: 'my-admin-app',
      rtcPolyfill
    },
    'room-after-unawaited-clear'
  )
  const immediateNextSelf = await immediateNextRoom.getSelf()
  await unawaitedClear
  assert.notEqual(
    immediateNextSelf.userId,
    postClearSelf.userId,
    'joinRoom called synchronously after un-awaited clearUserIdentity must wait for deletion and create a new userId'
  )
  assert.notEqual(immediateNextSelf.peerId, postClearSelf.peerId)
  assert.equal(idbStore.get('my-admin-app')?.userId, immediateNextSelf.userId)
  await immediateNextRoom.leave()
})
