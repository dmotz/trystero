import {derivePairwiseAesKey, ecdsaSign, hash32, signRoomAuth} from '../crypto'
import {maxActionFrameBytes, maxOverlayHeaderBytes} from '../data-limits'
import {
  canonicalizePubJwk,
  getDefaultEndpointIdentity,
  pubJwkToUncompressedBytes,
  signUserEndpointProof,
  verifyWithP256
} from '../identity'
import {
  all,
  createBoundedCache,
  decodeBytes,
  encodeBytes,
  fromBase64,
  fromJson,
  libId,
  noOp,
  toBase64,
  toJson
} from '../utils'
import type {RoleCertificate, UserIdentity} from '../types'

export const overlayFrameVersion = 3
export const overlayControlKind = 1
export const overlayBroadcastKind = 2
export const overlayUnicastKind = 3

export type PeerDescriptor = {
  peerId: string
  seq: number
  neighbors: string[]
  signPubKey?: JsonWebKey
  encPubKey?: JsonWebKey
  userId?: string
  userPubKey?: JsonWebKey
  userProof?: string
  cert?: RoleCertificate
  roomAuth?: string
  sig?: string
}

export type OverlayControlMessage =
  | {
      t: 'gossip'
      descriptors: PeerDescriptor[]
    }
  | {
      t: 'leave'
      peerId: string
      seq: number
      sig?: string
    }

export type BroadcastEnvelopeHeader = {
  o: string
  q: number
  m: string
  s?: string
}

export type UnicastLeaseTuple = [lo: number, hi: number, sig: string]

export type UnicastEnvelopeHeader = {
  o: string
  d: string
  q: number
  m: string
  iv?: string
  s?: string
  l?: UnicastLeaseTuple
}

export type CryptoIdentity = {
  peerId: string
  signPrivateKey: CryptoKey
  signPublicKey: CryptoKey
  signPubJwk: JsonWebKey
  encPrivateKey: CryptoKey
  encPublicKey: CryptoKey
  encPubJwk: JsonWebKey
}

export const packOverlayBinary = (
  kind: number,
  ttl: number,
  header: Record<string, unknown>,
  payload: Uint8Array
): Uint8Array => {
  const headerBytes = encodeBytes(toJson(header))
  const frame = new Uint8Array(5 + headerBytes.byteLength + payload.byteLength)
  frame[0] = overlayFrameVersion
  frame[1] = kind
  frame[2] = ttl & 0xff
  frame[3] = (headerBytes.byteLength >>> 8) & 0xff
  frame[4] = headerBytes.byteLength & 0xff
  frame.set(headerBytes, 5)
  frame.set(payload, 5 + headerBytes.byteLength)
  return frame
}

export const unpackOverlayBinary = (
  bytes: Uint8Array
): {
  kind: number
  ttl: number
  header: Record<string, unknown>
  payload: Uint8Array
} | null => {
  if (bytes.byteLength < 5 || bytes[0] !== overlayFrameVersion) {
    return null
  }
  const kind = bytes[1]!
  const ttl = bytes[2]!
  const headerLen = (bytes[3]! << 8) | bytes[4]!
  if (
    headerLen <= 0 ||
    headerLen > maxOverlayHeaderBytes ||
    5 + headerLen > bytes.byteLength
  ) {
    return null
  }
  try {
    const header = fromJson<Record<string, unknown>>(
      decodeBytes(bytes.subarray(5, 5 + headerLen))
    )
    if (!header || typeof header !== 'object' || Array.isArray(header)) {
      return null
    }
    return {
      kind,
      ttl,
      header,
      payload: bytes.subarray(5 + headerLen)
    }
  } catch {
    return null
  }
}

export const packOverlayControl = (msg: OverlayControlMessage): Uint8Array => {
  const body = encodeBytes(toJson(msg))
  const frame = new Uint8Array(2 + body.byteLength)
  frame[0] = overlayFrameVersion
  frame[1] = overlayControlKind
  frame.set(body, 2)
  return frame
}

const gossipEnvelopeOverheadBytes = 32
const descByteLengthCache = new WeakMap<PeerDescriptor, number>()

export const packGossipControlFrames = (
  descriptors: PeerDescriptor[],
  maxFrameBytes: number = maxActionFrameBytes
): Uint8Array[] => {
  if (descriptors.length === 0) {
    return []
  }

  const frames: Uint8Array[] = []
  let currentDescs: PeerDescriptor[] = []
  let currentBytes = gossipEnvelopeOverheadBytes

  for (const desc of descriptors) {
    let descBytes = descByteLengthCache.get(desc)
    if (descBytes === undefined) {
      descBytes = encodeBytes(toJson(desc)).byteLength
      descByteLengthCache.set(desc, descBytes)
    }
    const addedBytes = (currentDescs.length > 0 ? 1 : 0) + descBytes
    if (currentDescs.length > 0 && currentBytes + addedBytes > maxFrameBytes) {
      frames.push(
        packOverlayControl({
          t: 'gossip',
          descriptors: currentDescs
        })
      )
      currentDescs = [desc]
      currentBytes = gossipEnvelopeOverheadBytes + descBytes
    } else {
      currentDescs.push(desc)
      currentBytes += addedBytes
    }
  }

  if (currentDescs.length > 0) {
    frames.push(
      packOverlayControl({
        t: 'gossip',
        descriptors: currentDescs
      })
    )
  }

  return frames
}

const maxOverlayMsgIdLength = 128

export const isValidOverlayMsgId = (msgId: string): boolean => {
  if (msgId.length === 0 || msgId.length > maxOverlayMsgIdLength) {
    return false
  }
  for (let i = 0; i < msgId.length; i++) {
    const code = msgId.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) {
      return false
    }
  }
  return true
}

export const parseUnicastLease = (
  rawLease: unknown,
  seq: number,
  maxWindowPackets: number
): UnicastLeaseTuple | null => {
  if (
    !Array.isArray(rawLease) ||
    rawLease.length !== 3 ||
    typeof rawLease[0] !== 'number' ||
    typeof rawLease[1] !== 'number' ||
    typeof rawLease[2] !== 'string' ||
    !rawLease[2] ||
    !Number.isSafeInteger(rawLease[0]) ||
    !Number.isSafeInteger(rawLease[1]) ||
    rawLease[0] < 1 ||
    rawLease[1] < rawLease[0] ||
    rawLease[1] - rawLease[0] >= maxWindowPackets ||
    seq < rawLease[0] ||
    seq > rawLease[1]
  ) {
    return null
  }
  return [rawLease[0], rawLease[1], rawLease[2]]
}

export const canonicalBroadcastHeader = (
  origin: string,
  msgId: string,
  seq: number = 1,
  appId: string = '',
  roomId: string = ''
): string =>
  toJson([`${libId}-broadcast-v2`, appId, roomId, origin, seq, msgId])

export const canonicalUnicastHeader = (
  origin: string,
  dest: string,
  msgId: string,
  ivB64: string,
  seq: number = 1,
  appId: string = '',
  roomId: string = ''
): string =>
  toJson([
    `${libId}-unicast-v2`,
    appId,
    roomId,
    origin,
    dest,
    seq,
    msgId,
    ivB64
  ])

export const canonicalLeaveHeader = (
  leavingId: string,
  seq: number,
  appId: string = '',
  roomId: string = ''
): string => toJson([`${libId}-leave-v2`, appId, roomId, leavingId, seq])

export const canonicalUnicastLeaseHeader = (
  origin: string,
  dest: string,
  lo: number,
  hi: number,
  appId: string = '',
  roomId: string = ''
): string =>
  toJson([`${libId}-unicast-lease-v1`, appId, roomId, origin, dest, lo, hi])

export const buildOverlaySignedBytes = (
  canonicalHeader: string,
  payload: Uint8Array
): Uint8Array => {
  const headerBytes = encodeBytes(canonicalHeader)
  const combined = new Uint8Array(
    4 + headerBytes.byteLength + payload.byteLength
  )
  new DataView(combined.buffer).setUint32(0, headerBytes.byteLength)
  combined.set(headerBytes, 4)
  combined.set(payload, 4 + headerBytes.byteLength)
  return combined
}

export const descriptorCanonicalPayload = (
  d: PeerDescriptor,
  appId: string = '',
  roomId: string = ''
): string =>
  toJson([
    `${libId}-desc-v2`,
    appId,
    roomId,
    d.peerId,
    d.seq,
    d.neighbors,
    d.signPubKey ? canonicalizePubJwk(d.signPubKey) : null,
    d.encPubKey ? canonicalizePubJwk(d.encPubKey) : null,
    d.roomAuth ?? null,
    d.cert?.sig ?? null,
    ...(d.userId
      ? [
          d.userId,
          d.userPubKey ? canonicalizePubJwk(d.userPubKey) : null,
          d.userProof ?? null
        ]
      : [])
  ])

export const verifyBase64Sig = (
  sig: string,
  signedBytes: Uint8Array,
  pubJwk: JsonWebKey
): boolean | Promise<boolean> => {
  try {
    return verifyWithP256(fromBase64(sig), signedBytes, pubJwk)
  } catch {
    return false
  }
}

export const signOverlayPayload = async (
  signPrivateKey: CryptoKey,
  canonicalHeader: string,
  payload: Uint8Array
): Promise<string> => {
  const combined = buildOverlaySignedBytes(canonicalHeader, payload)
  return toBase64(await ecdsaSign(signPrivateKey, combined as BufferSource))
}

export const signPeerDescriptor = async (
  descriptor: PeerDescriptor,
  id: CryptoIdentity,
  appId: string,
  roomId: string,
  password: string,
  userIdentity: UserIdentity | null
): Promise<PeerDescriptor> => {
  if (password) {
    descriptor.roomAuth = await signRoomAuth(
      password,
      appId,
      roomId,
      descriptor.peerId,
      descriptor.seq
    )
  }
  if (userIdentity) {
    descriptor.userId = userIdentity.userId
    descriptor.userPubKey = userIdentity.signPubJwk
    descriptor.userProof = await signUserEndpointProof(userIdentity, {
      appId,
      roomId,
      peerId: descriptor.peerId,
      peerPubJwk: id.signPubJwk,
      seq: descriptor.seq
    })
  }
  const canonicalBytes = encodeBytes(
    descriptorCanonicalPayload(descriptor, appId, roomId)
  )
  descriptor.sig = toBase64(
    await ecdsaSign(id.signPrivateKey, canonicalBytes as BufferSource)
  )
  return descriptor
}

export type OriginTaskQueue = {
  has: (key: string) => boolean
  enqueue: (key: string, fn: () => Promise<void>) => void
  clear: () => void
}

export const createOriginTaskQueue = (
  maxTrackedOrigins: number = 2_048
): OriginTaskQueue => {
  const queues = new Map<string, Promise<void>>()
  return {
    has: (key: string): boolean => queues.has(key),
    enqueue: (key: string, fn: () => Promise<void>): void => {
      const queueKey =
        queues.has(key) || queues.size < maxTrackedOrigins
          ? key
          : `overflow:${hash32(key) & 63}`
      const prev = queues.get(queueKey) ?? Promise.resolve()
      const next = prev
        .then(fn)
        .catch(noOp)
        .finally(() => {
          if (queues.get(queueKey) === next) {
            queues.delete(queueKey)
          }
        })
      queues.set(queueKey, next)
    },
    clear: (): void => {
      queues.clear()
    }
  }
}

export const createPairwiseKeyCache = (
  appId: string,
  getRoomId: () => string,
  getSelfId: () => string,
  getLocalCryptoIdentity: () => Promise<CryptoIdentity>,
  getRemoteEncPubKey: (peerId: string) => JsonWebKey | undefined
): {
  get: (remotePeerId: string) => Promise<CryptoKey> | null
  invalidate: (remotePeerId: string) => void
  clear: () => void
} => {
  const derivedPairwiseKeys = new Map<string, Promise<CryptoKey>>()
  return {
    get: (remotePeerId: string): Promise<CryptoKey> | null => {
      const remoteKey = getRemoteEncPubKey(remotePeerId)
      const remoteUncompressed = remoteKey
        ? pubJwkToUncompressedBytes(remoteKey)
        : null
      if (!remoteUncompressed) {
        return null
      }
      let cached = derivedPairwiseKeys.get(remotePeerId)
      if (!cached) {
        const roomId = getRoomId()
        cached = getLocalCryptoIdentity().then(id =>
          derivePairwiseAesKey(
            id.encPrivateKey,
            remoteUncompressed,
            appId,
            roomId,
            getSelfId(),
            remotePeerId
          )
        )
        cached.catch(() => {
          derivedPairwiseKeys.delete(remotePeerId)
        })
        derivedPairwiseKeys.set(remotePeerId, cached)
      }
      return cached
    },
    invalidate: (remotePeerId: string): void => {
      derivedPairwiseKeys.delete(remotePeerId)
    },
    clear: (): void => {
      derivedPairwiseKeys.clear()
    }
  }
}

export const encryptUnicastPayload = async (
  aesKey: CryptoKey,
  iv: Uint8Array,
  canonicalHeader: string,
  plainPayload: Uint8Array
): Promise<Uint8Array> => {
  const encrypted = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv as BufferSource,
      additionalData: encodeBytes(canonicalHeader) as BufferSource
    },
    aesKey,
    plainPayload as BufferSource
  )
  return new Uint8Array(encrypted)
}

export const decryptUnicastPayload = async (
  aesKey: CryptoKey,
  ivB64: string,
  canonicalHeader: string,
  ciphertext: Uint8Array
): Promise<Uint8Array> => {
  const decrypted = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: fromBase64(ivB64) as BufferSource,
      additionalData: encodeBytes(canonicalHeader) as BufferSource
    },
    aesKey,
    ciphertext as BufferSource
  )
  return new Uint8Array(decrypted)
}

export const createCryptoIdentityLoader = (
  getEffectiveSelfId: () => string | undefined,
  appId: string,
  onReady?: (identity: CryptoIdentity) => void
): {
  getReady: () => CryptoIdentity | null
  load: () => Promise<CryptoIdentity>
} => {
  let identityReady: CryptoIdentity | null = null
  let localCryptoIdentityP: Promise<CryptoIdentity> | null = null

  const load = (): Promise<CryptoIdentity> => {
    if (!localCryptoIdentityP) {
      localCryptoIdentityP = (async () => {
        const [endpointId, encPair] = await all([
          getDefaultEndpointIdentity(getEffectiveSelfId(), appId),
          crypto.subtle.generateKey(
            {name: 'ECDH', namedCurve: 'P-256'},
            false,
            ['deriveKey', 'deriveBits']
          )
        ])
        const rawEncPubJwk = await crypto.subtle.exportKey(
          'jwk',
          encPair.publicKey
        )
        const encPubJwk: JsonWebKey = {
          crv: 'P-256',
          kty: 'EC',
          x: rawEncPubJwk.x ?? '',
          y: rawEncPubJwk.y ?? ''
        }
        const res: CryptoIdentity = {
          peerId: endpointId.peerId,
          signPrivateKey: endpointId.signPrivateKey,
          signPublicKey: endpointId.signPublicKey,
          signPubJwk: endpointId.signPubJwk,
          encPrivateKey: encPair.privateKey,
          encPublicKey: encPair.publicKey,
          encPubJwk
        }
        identityReady = res
        onReady?.(res)
        return res
      })()
    }
    return localCryptoIdentityP
  }

  return {
    getReady: (): CryptoIdentity | null => identityReady,
    load
  }
}

const lastLocalSeqByRoomPeer = /*@__PURE__*/ createBoundedCache<
  string,
  {descSeq: number; pktSeq: number}
>(4_096)

export const createSessionSeqTracker = (
  appId: string,
  getRoomId: () => string,
  getSelfId: () => string
): {
  syncFloor: (id?: string) => void
  resetFloorFlag: () => void
  nextDescSeq: () => number
  nextPktSeq: () => number
} => {
  let descSeq = 0
  let pktSeq = 0
  let didInitFloor = false

  const syncFloor = (id: string = getSelfId()): void => {
    if (!id) {
      return
    }
    const key = `${appId}\0${getRoomId()}\0${id}`
    const prev = lastLocalSeqByRoomPeer.get(key)
    if (!didInitFloor) {
      didInitFloor = true
      if (prev) {
        descSeq = Math.max(descSeq, prev.descSeq + 1_024)
        pktSeq = Math.max(pktSeq, prev.pktSeq + 1_024)
      }
    }
    lastLocalSeqByRoomPeer.set(key, {
      descSeq: Math.max(descSeq, prev?.descSeq ?? 0),
      pktSeq: Math.max(pktSeq, prev?.pktSeq ?? 0)
    })
  }

  const recordProgress = (): void => {
    const selfId = getSelfId()
    if (!selfId) {
      return
    }
    const key = `${appId}\0${getRoomId()}\0${selfId}`
    const prev = lastLocalSeqByRoomPeer.get(key)
    lastLocalSeqByRoomPeer.set(key, {
      descSeq: Math.max(descSeq, prev?.descSeq ?? 0),
      pktSeq: Math.max(pktSeq, prev?.pktSeq ?? 0)
    })
  }

  return {
    syncFloor,
    resetFloorFlag: (): void => {
      didInitFloor = false
    },
    nextDescSeq: (): number => {
      const next = ++descSeq
      recordProgress()
      return next
    },
    nextPktSeq: (): number => {
      const next = ++pktSeq
      recordProgress()
      return next
    }
  }
}
