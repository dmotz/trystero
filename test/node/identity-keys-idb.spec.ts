import assert from 'node:assert/strict'
import test from './test.ts'
import * as corePublicExports from '../../packages/core/src/index.ts'
import {
  clearUserIdentity,
  createUserIdentity,
  exportUserIdentity,
  importUserIdentity,
  roles
} from '../../packages/core/src/index.ts'
import {
  compactPubToJwk,
  createEndpointIdentity,
  derivePeerId,
  deriveUserId,
  getDefaultEndpointIdentity,
  jwkToCompactPub,
  signUserEndpointProof,
  verifyPeerIdKey,
  verifyUserIdKey
} from '../../packages/core/src/identity.ts'
import {
  createOverlayManager,
  descriptorCanonicalPayload,
  packGossipControlFrames
} from '../../packages/core/src/scale/index.ts'
import {ecdsaSign} from '../../packages/core/src/crypto.ts'
import {encodeBytes, toBase64Url} from '../../packages/core/src/primitives.ts'
import {createMemorySignalBus} from './memory-rtc.ts'
import {testPeerId, waitFor} from './peer-harness.ts'

void test('Identity primitives: peerId is 20-char Base62, userId is 22-char Base62, fingerprint is eliminated, and selfId is not exported', async () => {
  const {peerId: selfId} = await getDefaultEndpointIdentity()
  assert.equal(typeof selfId, 'string')
  assert.equal(selfId.length, 20)
  assert.match(selfId, /^[0-9A-Za-z]{20}$/)

  const user = await createUserIdentity()
  assert.equal(typeof user.userId, 'string')
  assert.equal(user.userId.length, 22)
  assert.match(user.userId, /^[0-9A-Za-z]{22}$/)
  assert.notEqual(user.userId.length, selfId.length)
  assert.equal('fingerprint' in user, false)
  assert.equal('publicKey' in user, false)
  assert.equal('persisted' in user, false)

  assert.equal(await deriveUserId(user.signPubJwk), user.userId)
  assert.equal(await verifyUserIdKey(user.userId, user.signPubJwk), true)

  const otherUser = await createUserIdentity()
  assert.equal(await verifyUserIdKey(user.userId, otherUser.signPubJwk), false)

  const derivedPeerId = await derivePeerId(user.signPubJwk)
  assert.equal(derivedPeerId.length, 20)
  assert.match(derivedPeerId, /^[0-9A-Za-z]{20}$/)
  assert.equal(await verifyPeerIdKey(derivedPeerId, user.signPubJwk), true)
  assert.equal(
    await verifyPeerIdKey(derivedPeerId, otherUser.signPubJwk),
    false
  )

  const exported = exportUserIdentity(user)
  assert.equal('userKey' in user, false)
  assert.ok(exported.startsWith('trystero_uk_'))
  const importedFromStr = await importUserIdentity(exported)
  assert.equal('userKey' in importedFromStr, false)
  assert.equal('fingerprint' in importedFromStr, false)
  assert.equal('publicKey' in importedFromStr, false)
  assert.equal('persisted' in importedFromStr, false)
  assert.equal(importedFromStr.userId, user.userId)
  assert.deepEqual(importedFromStr.signPubJwk, user.signPubJwk)

  for (const droppedHelper of [
    'selfId',
    'createAdminRoom',
    'computePublicKeyFingerprint',
    'computeUserIdFingerprint',
    'formatSelfCertifyingRoomId',
    'parseSelfCertifyingRoomId',
    'derivePeerId',
    'deriveUserId',
    'verifyPeerIdKey',
    'verifyUserIdKey',
    'extractPlugins',
    'isPlugin',
    'definePlugin'
  ]) {
    assert.equal(
      droppedHelper in corePublicExports,
      false,
      `${droppedHelper} must not be publicly exported`
    )
  }

  await assert.rejects(
    () => importUserIdentity('low-entropy-passphrase'),
    /invalid user identity key material|exported userKey/i
  )
})

void test('Identity config validation & persistence modes: default local, none, and custom', async t => {
  for (const name of ['sessionStorage', 'localStorage', 'indexedDB']) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
    t.after(() => {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor)
      } else {
        Reflect.deleteProperty(globalThis, name)
      }
    })
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: undefined
    })
  }
  const {makeJoinRoom, rtcPolyfill} = createMemorySignalBus()
  const joinRoom = makeJoinRoom()

  // Rejects removed 'session', arbitrary strings, or un-imported key strings synchronously
  for (const invalidMode of ['session', 'sesion']) {
    assert.throws(
      () =>
        joinRoom(
          {
            appId: 'validation-app',
            identity: invalidMode as any,
            rtcPolyfill
          },
          'room-1'
        ),
      /invalid custom user identity/i
    )
  }

  const tempUser = await createUserIdentity()
  assert.throws(
    () =>
      joinRoom(
        {
          appId: 'validation-app',
          identity: exportUserIdentity(tempUser) as any,
          rtcPolyfill
        },
        'room-1'
      ),
    /importUserIdentity/
  )
  assert.throws(
    () =>
      joinRoom(
        {
          appId: 'validation-app',
          identity: {...tempUser, userId: '0'.repeat(22)},
          rtcPolyfill
        },
        'room-1'
      ),
    /userId does not match signPubJwk/
  )
  assert.throws(
    () =>
      joinRoom(
        {
          appId: 'validation-app',
          identity: {...tempUser, userId: 'A'.repeat(43)},
          rtcPolyfill
        },
        'room-1'
      ),
    /invalid custom user identity/
  )
  assert.throws(
    () => roles({admins: ['0'.repeat(20)]}),
    /invalid admin userId.*expected a 22-character Base62 userId/
  )

  const sessionStore = new Map<string, string>()
  const localStore = new Map<string, string>()
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
                      addReq.onerror?.({preventDefault: () => {}})
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

  const prevSession = (globalThis as any).sessionStorage
  const prevLocal = (globalThis as any).localStorage
  const prevIdb = (globalThis as any).indexedDB
  ;(globalThis as any).sessionStorage = makeMockStorage(sessionStore)
  ;(globalThis as any).localStorage = makeMockStorage(localStore)

  // Outside IndexedDB: default is silent 'none', while explicit 'local' warns and falls back to 'none' (no plaintext Web Storage fallback)
  const warnings: string[] = []
  const origWarn = console.warn
  console.warn = (...args: any[]) => {
    warnings.push(args.map(String).join(' '))
  }
  try {
    const noIdbDefaultRoom = makeJoinRoom('peer-noidb-d')(
      {
        appId: 'no-idb-default-app',
        rtcPolyfill
      },
      'room-default'
    )
    const noIdbLocalRoom = makeJoinRoom('peer-noidb-l')(
      {
        appId: 'no-idb-app',
        identity: 'local',
        rtcPolyfill
      },
      'room-local'
    )
    const [selfNoIdbD, selfNoIdbL] = await Promise.all([
      noIdbDefaultRoom.getSelf(),
      noIdbLocalRoom.getSelf()
    ])
    assert.equal('persisted' in selfNoIdbD, false)
    assert.equal(selfNoIdbD.identityPersistence, 'none')
    assert.equal('persisted' in selfNoIdbL, false)
    assert.equal(selfNoIdbL.identityPersistence, 'none')
    assert.notEqual(selfNoIdbD.userId, selfNoIdbL.userId)
    assert.equal(sessionStore.size, 0)
    assert.equal(localStore.size, 0)
    assert.equal(
      warnings.filter(w => /IndexedDB.*none/i.test(w)).length,
      1,
      'explicit identity: "local" must warn and fall back to "none" when IndexedDB is unavailable, while default stays silent'
    )
    await Promise.all([noIdbDefaultRoom.leave(), noIdbLocalRoom.leave()])
  } finally {
    console.warn = origWarn
  }

  ;(globalThis as any).indexedDB = mockIndexedDB

  try {
    // Default (omitted identity) uses 'local', reuses userId within same appId across tabs/rooms, and isolates across appIds
    const [dRoom1, dRoom2] = [
      makeJoinRoom('peer-d1')(
        {
          appId: 'app-local-1',
          rtcPolyfill
        },
        'r1'
      ),
      makeJoinRoom('peer-d2')(
        {
          appId: 'app-local-1',
          rtcPolyfill
        },
        'r2'
      )
    ]
    const dRoomOtherApp = makeJoinRoom('peer-d3')(
      {
        appId: 'app-local-2',
        rtcPolyfill
      },
      'r1'
    )

    const [selfD1, selfD2, selfDOther] = await Promise.all([
      dRoom1.getSelf(),
      dRoom2.getSelf(),
      dRoomOtherApp.getSelf()
    ])

    assert.equal(selfD1.userId, selfD2.userId)
    assert.equal('persisted' in selfD1, false)
    assert.equal(selfD1.identityPersistence, 'local')
    assert.notEqual(selfD1.peerId, selfD2.peerId)
    assert.notEqual(selfD1.userId, selfDOther.userId)
    assert.equal(sessionStore.size, 0)
    assert.equal(localStore.size, 0)

    await Promise.all([dRoom1.leave(), dRoom2.leave(), dRoomOtherApp.leave()])

    // Explicit identity: 'none' bypasses IndexedDB even when available
    const noneRoom = makeJoinRoom('peer-none-1')(
      {
        appId: 'app-none-explicit',
        identity: 'none',
        rtcPolyfill
      },
      'r-none'
    )
    const selfNone = await noneRoom.getSelf()
    assert.equal('persisted' in selfNone, false)
    assert.equal(selfNone.identityPersistence, 'none')
    assert.equal(idbStore.has('app-none-explicit'), false)
    await noneRoom.leave()

    // Custom loader receives {appId, roomId} and returns UserIdentity; startup self-test rejects broken signers (H3 / Q2=A)
    const customUser = await createUserIdentity()
    let loaderContext: any = null
    const cRoom = makeJoinRoom('peer-c1')(
      {
        appId: 'app-custom',
        identity: async ctx => {
          loaderContext = ctx
          return importUserIdentity(exportUserIdentity(customUser))
        },
        rtcPolyfill
      },
      'room-custom'
    )
    const selfC = await cRoom.getSelf()
    assert.equal(selfC.userId, customUser.userId)
    assert.equal('persisted' in selfC, false)
    assert.equal(selfC.identityPersistence, 'custom')
    assert.deepEqual(loaderContext, {
      appId: 'app-custom',
      roomId: 'room-custom'
    })
    await cRoom.leave()

    // H3: Custom UserIdentity whose sign() fails signature verification against signPubJwk rejects room.ready and emits identity-failed
    const brokenSignerRoom = makeJoinRoom('peer-bad-sig')(
      {
        appId: 'app-custom-bad-sig',
        identity: {
          ...customUser,
          sign: async () => new Uint8Array(64)
        },
        rtcPolyfill
      },
      'room-bad-sig'
    )
    const badSigErrors: string[] = []
    brokenSignerRoom.onError(err => {
      badSigErrors.push(err.code)
    })
    await assert.rejects(
      () => brokenSignerRoom.ready,
      /signature|verification|signer|invalid/i
    )
    assert.deepEqual(badSigErrors, ['identity-failed'])
  } finally {
    ;(globalThis as any).sessionStorage = prevSession
    ;(globalThis as any).localStorage = prevLocal
    ;(globalThis as any).indexedDB = prevIdb
  }
})

void test('clearUserIdentity without IndexedDB resets runtime userId and peerId caches only for that appId', async () => {
  const {makeJoinRoom, rtcPolyfill} = createMemorySignalBus()
  const joinRoom = makeJoinRoom()

  const roomA1 = joinRoom(
    {
      appId: 'clear-no-idb-a',
      rtcPolyfill
    },
    'r1'
  )
  const roomB1 = joinRoom(
    {
      appId: 'clear-no-idb-b',
      rtcPolyfill
    },
    'r1'
  )
  const [selfA1, selfB1] = await Promise.all([
    roomA1.getSelf(),
    roomB1.getSelf()
  ])
  await Promise.all([roomA1.leave(), roomB1.leave()])

  await clearUserIdentity('clear-no-idb-a')

  const roomA2 = joinRoom(
    {
      appId: 'clear-no-idb-a',
      rtcPolyfill
    },
    'r1'
  )
  const roomB2 = joinRoom(
    {
      appId: 'clear-no-idb-b',
      rtcPolyfill
    },
    'r1'
  )
  const [selfA2, selfB2] = await Promise.all([
    roomA2.getSelf(),
    roomB2.getSelf()
  ])
  await Promise.all([roomA2.leave(), roomB2.leave()])

  assert.notEqual(selfA2.userId, selfA1.userId)
  assert.notEqual(selfA2.peerId, selfA1.peerId)
  assert.equal(selfB2.userId, selfB1.userId)
  assert.equal(selfB2.peerId, selfB1.peerId)
})

void test('Canonical JWK & compact pubkey normalization: compactPubToJwk accepts compact x.y, and overlay key-pinning tolerates JWK property order / ext / key_ops permutations', async () => {
  const remoteEp = await createEndpointIdentity()
  const remoteUser = await createUserIdentity()
  const compact = jwkToCompactPub(remoteUser.signPubJwk)
  assert.equal(compact.length, 87)
  assert.deepEqual(compactPubToJwk(compact), {
    crv: 'P-256',
    kty: 'EC',
    x: remoteUser.signPubJwk.x,
    y: remoteUser.signPubJwk.y
  })

  const appId = `jwk-canon-${Date.now()}`
  const roomId = 'canon-room'
  const observerId = testPeerId('jwk-observer')
  const accepted: Array<{peerId: string; userId?: string}> = []
  const overlay = createOverlayManager({
    selfId: observerId,
    appId,
    roomId,
    config: {maxDirectPeers: 4},
    onVirtualPeerJoin: () => {},
    onVirtualPeerLeave: () => {},
    onDeliverData: () => {},
    onPeerDescriptorCert: (peerId, _signPubKey, _cert, userId) => {
      accepted.push({peerId, ...(userId === undefined ? {} : {userId})})
    }
  })

  try {
    // Pin remoteEp's key using standard clean JWK order (crv, kty, x, y)
    overlay.setPeerSignPublicKey(remoteEp.peerId, remoteEp.signPubJwk)

    const encPair = await crypto.subtle.generateKey(
      {name: 'ECDH', namedCurve: 'P-256'},
      true,
      ['deriveKey', 'deriveBits']
    )
    const rawEncJwk = await crypto.subtle.exportKey('jwk', encPair.publicKey)

    // Permute property order AND attach extra WebCrypto metadata fields (ext, key_ops)
    const permutedSignJwk: JsonWebKey = {
      y: remoteEp.signPubJwk.y!,
      x: remoteEp.signPubJwk.x!,
      key_ops: ['verify'],
      ext: true,
      kty: 'EC',
      crv: 'P-256'
    }
    const permutedEncJwk: JsonWebKey = {
      y: rawEncJwk.y!,
      x: rawEncJwk.x!,
      ext: true,
      kty: 'EC',
      crv: 'P-256'
    }
    const permutedUserJwk: JsonWebKey = {
      y: remoteUser.signPubJwk.y!,
      x: remoteUser.signPubJwk.x!,
      ext: true,
      key_ops: ['verify'],
      kty: 'EC',
      crv: 'P-256'
    }
    const proof = await signUserEndpointProof(remoteUser, {
      appId,
      roomId,
      peerId: remoteEp.peerId,
      peerPubJwk: permutedSignJwk,
      seq: 1
    })
    const descriptor: any = {
      peerId: remoteEp.peerId,
      seq: 1,
      ts: Date.now(),
      neighbors: [observerId],
      signPubKey: jwkToCompactPub(permutedSignJwk),
      encPubKey: jwkToCompactPub(permutedEncJwk),
      userId: remoteUser.userId,
      userPubKey: jwkToCompactPub(permutedUserJwk),
      userProof: proof
    }
    const canon = encodeBytes(
      descriptorCanonicalPayload(descriptor, appId, roomId)
    )
    descriptor.sig = toBase64Url(
      await ecdsaSign(remoteEp.signPrivateKey, canon as BufferSource)
    )

    const relayId = testPeerId('jwk-relay')
    const fakeNeighbor: any = {
      isDead: false,
      connection: {connectionState: 'connected'},
      channel: {readyState: 'open', bufferedAmount: 0},
      sendData: () => {},
      destroy: () => {},
      setHandlers: () => {}
    }
    overlay.addDirectPeer(relayId, fakeNeighbor)
    const [frame] = packGossipControlFrames([descriptor])
    overlay.handleOverlayFrame(relayId, frame!.slice().buffer)

    await waitFor(
      () =>
        accepted.some(
          x => x.peerId === remoteEp.peerId && x.userId === remoteUser.userId
        ),
      2_000
    )
    assert.equal(overlay.getSnapshot().stats.signatureFailures, 0)
  } finally {
    overlay.destroy()
  }
})
