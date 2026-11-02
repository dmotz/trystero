import assert from 'node:assert/strict'
import test from './test.ts'
import {
  computePayloadDigest,
  createRoomAuthority,
  signActionAuth,
  verifyActionAuth
} from '../../packages/core/src/authority.ts'
import {
  decrypt,
  derivePairwiseAesKey,
  ecdhKeyAlgo,
  encrypt,
  genKey,
  hashTopic,
  isValidP256PrivateScalar,
  p256N,
  sha256,
  signRoomAuth,
  verifyRoomAuth
} from '../../packages/core/src/crypto.ts'
import {
  createUserIdentity,
  fromBase64Url,
  pubJwkToUncompressedBytes
} from '../../packages/core/src/identity.ts'
import {genId, shuffle, strToNum} from '../../packages/core/src/utils.ts'
import {createEvent, createSigner} from '../../packages/nostr/src/protocol.ts'

void test('D1: genKey uses 600k-iteration PBKDF2-SHA256 for passwords with appId/roomId domain separation', async () => {
  const k1 = genKey('CorrectHorseBatteryStaple!', 'd1-app', 'room-a')
  const kSame = genKey('CorrectHorseBatteryStaple!', 'd1-app', 'room-a')
  const kDiffRoom = genKey('CorrectHorseBatteryStaple!', 'd1-app', 'room-b')
  const kLegacySha256 = crypto.subtle.importKey(
    'raw',
    (await sha256('CorrectHorseBatteryStaple!:d1-app:room-a')) as BufferSource,
    {name: 'AES-GCM'},
    false,
    ['encrypt', 'decrypt']
  )

  const ct = await encrypt(k1, 'secret-sdp', 'offer|peer1|oid1')
  assert.equal(await decrypt(kSame, ct, 'offer|peer1|oid1'), 'secret-sdp')
  await assert.rejects(() => decrypt(kDiffRoom, ct, 'offer|peer1|oid1'))
  // Confirm key is NOT the legacy single unsalted SHA-256 digest
  await assert.rejects(() => decrypt(kLegacySha256, ct, 'offer|peer1|oid1'))
})

void test('Crypto audit fixes: PBKDF2-HMAC roomAuth, HKDF pairwise ECDH, computePayloadDigest tag separation & small-Blob parity, 12-byte GCM, 22-char Base62 userId, unbiased genId, and Nostr kind dispersion', async () => {
  // 1. signRoomAuth / verifyRoomAuth uses PBKDF2-HMAC-SHA256 with canonical JSON framing (no ':' collisions or single-SHA256 oracle)
  const validToken = await signRoomAuth(
    'pa:ss',
    'app',
    'room',
    'PeerA123456789012345',
    7
  )
  assert.match(validToken, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(
    await verifyRoomAuth(
      'pa:ss',
      'app',
      'room',
      'PeerA123456789012345',
      7,
      validToken
    ),
    true
  )
  // Delimiter-shifted tuple ('pa', 'ss:app', 'room') must NOT verify
  assert.equal(
    await verifyRoomAuth(
      'pa',
      'ss:app',
      'room',
      'PeerA123456789012345',
      7,
      validToken
    ),
    false
  )
  // Legacy single-SHA256 token must NOT verify
  const legacySingleSha = Array.from(
    await sha256('trystero-ov-auth:pa:ss:app:room:PeerA123456789012345:7'),
    b => b.toString(16).padStart(2, '0')
  ).join('')
  assert.equal(
    await verifyRoomAuth(
      'pa:ss',
      'app',
      'room',
      'PeerA123456789012345',
      7,
      legacySingleSha
    ),
    false
  )

  // 2. derivePairwiseAesKey uses Web Crypto HKDF-SHA256, rejects private JWKs in pubJwkToUncompressedBytes, and prevents ':' delimiter collisions
  const [aliceEcdh, bobEcdh] = await Promise.all([
    crypto.subtle.generateKey(ecdhKeyAlgo, true, ['deriveBits']),
    crypto.subtle.generateKey(ecdhKeyAlgo, true, ['deriveBits'])
  ])
  const [alicePubJwk, bobPubJwk, alicePrivJwk] = await Promise.all([
    crypto.subtle.exportKey('jwk', aliceEcdh.publicKey),
    crypto.subtle.exportKey('jwk', bobEcdh.publicKey),
    crypto.subtle.exportKey('jwk', aliceEcdh.privateKey)
  ])
  assert.equal(
    pubJwkToUncompressedBytes(alicePrivJwk),
    null,
    'pubJwkToUncompressedBytes must reject JWKs containing private scalar d'
  )
  const aliceRawPub = pubJwkToUncompressedBytes({
    kty: 'EC',
    crv: 'P-256',
    x: alicePubJwk.x!,
    y: alicePubJwk.y!
  })!
  const bobRawPub = pubJwkToUncompressedBytes({
    kty: 'EC',
    crv: 'P-256',
    x: bobPubJwk.x!,
    y: bobPubJwk.y!
  })!
  const [kAliceBob, kBobAlice, kShifted] = await Promise.all([
    derivePairwiseAesKey(
      aliceEcdh.privateKey,
      bobRawPub,
      'app:1',
      'room',
      'alice',
      'bob'
    ),
    derivePairwiseAesKey(
      bobEcdh.privateKey,
      aliceRawPub,
      'app:1',
      'room',
      'bob',
      'alice'
    ),
    derivePairwiseAesKey(
      bobEcdh.privateKey,
      aliceRawPub,
      'app',
      '1:room',
      'bob',
      'alice'
    )
  ])
  assert.equal(kAliceBob.extractable, false)
  const e2eCt = await encrypt(Promise.resolve(kAliceBob), 'hkdf-secret', 'aad1')
  assert.equal(
    await decrypt(Promise.resolve(kBobAlice), e2eCt, 'aad1'),
    'hkdf-secret'
  )
  await assert.rejects(() => decrypt(Promise.resolve(kShifted), e2eCt, 'aad1'))

  // 3. computePayloadDigest: small Blob (<= 256 KiB) matches Uint8Array AND chunked (> 256 KiB, tag 0x04) cannot collide with unchunked (tag 0x02)
  const smallBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
  const smallBlob = new Blob([smallBytes])
  assert.equal(
    await computePayloadDigest(smallBlob),
    await computePayloadDigest(smallBytes),
    'small Blob (<= 256 KiB) digest must match decoded Uint8Array digest on receiver'
  )
  assert.equal(
    await computePayloadDigest(smallBlob, {m: 1}),
    await computePayloadDigest(smallBytes, {m: 1})
  )
  const admin = await createUserIdentity()
  assert.match(admin.userId, /^[0-9A-Za-z]{22}$/)
  const blobAuth = createRoomAuthority({
    selfId: 'blob-admin-peer',
    appId: 'blob-app',
    initialRoomId: `blob-room~${admin.userId}`,
    admin: {selfAsAdmin: true},
    getLocalUserIdentity: async () => admin
  })
  await blobAuth.getAuthorityInfo()
  const blobCert = await blobAuth.issueRoleCertificate(admin.userId, ['admin'])
  const blobEnv = await signActionAuth(admin.sign, admin.signPubJwk, blobCert, {
    appId: 'blob-app',
    roomId: `blob-room~${admin.userId}`,
    namespace: 'media',
    peerId: 'blob-admin-peer',
    seq: 1,
    data: smallBlob,
    meta: {mime: 'application/octet-stream'}
  })
  const blobVerified = await verifyActionAuth(blobEnv, {
    appId: 'blob-app',
    roomId: `blob-room~${admin.userId}`,
    namespace: 'media',
    peerId: 'blob-admin-peer',
    expectedUserId: admin.userId,
    data: smallBytes,
    requiredRoles: ['admin'],
    rootUserIds: new Set([admin.userId])
  })
  assert.equal(blobVerified.valid, true)

  const chunkedBytes = new Uint8Array(300_000)
  chunkedBytes.fill(0xab)
  const chunkedDigest = await computePayloadDigest(chunkedBytes)
  const forgedMerkleBody = new Uint8Array(8 + 2 * 32)
  new DataView(forgedMerkleBody.buffer).setBigUint64(0, 300_000n, false)
  forgedMerkleBody.set(await sha256(chunkedBytes.subarray(0, 262_144)), 8)
  forgedMerkleBody.set(await sha256(chunkedBytes.subarray(262_144)), 40)
  assert.notEqual(
    await computePayloadDigest(forgedMerkleBody),
    chunkedDigest,
    'small Uint8Array containing Merkle chunk hashes must have a distinct domain tag from chunked payload'
  )

  // 4. 12-byte AES-GCM base64url wire format & delimiter-safe keyless genKey
  const kKeylessA = genKey('', 'a:b', 'c')
  const kKeylessB = genKey('', 'a', 'b:c')
  const gcmWire = await encrypt(kKeylessA, 'hello')
  assert.match(gcmWire, /^[A-Za-z0-9_-]+$/)
  assert.equal(fromBase64Url(gcmWire).byteLength, 12 + 5 + 16)
  await assert.rejects(() => decrypt(kKeylessB, gcmWire))
  await assert.rejects(() => decrypt(kKeylessA, '1,2,3,4$AAAA'))

  // 5. Constant-time P-256 private scalar range check (0 < d < p256N)
  assert.equal(isValidP256PrivateScalar(new Uint8Array(32)), false)
  const oneScalar = new Uint8Array(32)
  oneScalar[31] = 1
  assert.equal(isValidP256PrivateScalar(oneScalar), true)
  const nBytes = new Uint8Array(32)
  let tmpN = p256N
  for (let i = 31; i >= 0; i--) {
    nBytes[i] = Number(tmpN & 0xffn)
    tmpN >>= 8n
  }
  assert.equal(isValidP256PrivateScalar(nBytes), false)
  const nMinusOne = nBytes.slice()
  nMinusOne[31]! -= 1
  assert.equal(isValidP256PrivateScalar(nMinusOne), true)
  const allOnes = new Uint8Array(32).fill(0xff)
  assert.equal(isValidP256PrivateScalar(allOnes), false)

  // 6. Unbiased genId, anagram-distinct strToNum + deterministic shuffle, and full-range Nostr topicToKind
  assert.notEqual(strToNum('app-ab'), strToNum('app-ba'))
  assert.deepEqual(
    shuffle(['r1', 'r2', 'r3', 'r4', 'r5'], strToNum('app-ab')),
    shuffle(['r1', 'r2', 'r3', 'r4', 'r5'], strToNum('app-ab'))
  )

  const sampleId = genId(6_200)
  assert.equal(sampleId.length, 6_200)
  assert.match(sampleId, /^[0-9A-Za-z]{6200}$/)
  // Previously '0'..'7' (or first 8 chars) had 25% bias (expected ~1000 vs ~800); check uniform bounds
  let firstEightCount = 0
  const firstEight = new Set(['0', '1', '2', '3', '4', '5', '6', '7'])
  for (const ch of sampleId) {
    if (firstEight.has(ch)) {
      firstEightCount++
    }
  }
  // Exact expectation = 6200 * (8/62) = 800 (previously biased expectation was ~969)
  assert.ok(
    firstEightCount > 680 && firstEightCount < 920,
    `expected unbiased first-8 frequency near 800, got ${firstEightCount}`
  )

  const signer = createSigner()
  const kinds = new Set<number>()
  let above24000 = 0
  for (let i = 0; i < 60; i++) {
    const t = await hashTopic(`nostr-kind-dispersion-${i}`)
    const ev = JSON.parse(await createEvent(t, 'ping', signer))[1] as {
      kind: number
    }
    assert.ok(ev.kind >= 20_000 && ev.kind < 30_000)
    kinds.add(ev.kind)
    if (ev.kind >= 24_000) {
      above24000++
    }
  }
  assert.ok(
    above24000 > 15,
    `expected topics to span kinds >= 24000, got ${above24000}/60`
  )
  assert.ok(kinds.size > 50)
})
