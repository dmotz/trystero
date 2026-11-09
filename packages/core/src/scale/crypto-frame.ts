import {ecdsaSign, signRoomAuth} from '../crypto'
import {maxActionFrameBytes, maxOverlayHeaderBytes} from '../data-limits'
import {
  jwkToCompactPub,
  signUserEndpointProof,
  verifyWithP256
} from '../identity'
import type {PeerHandle} from '../internal-types'
import {fromBase64Url, toBase64Url} from '../primitives'
import {canonTag} from '../signed-record'
import type {RoleCertificate, UserIdentity} from '../types'
import {
  base64UrlRe,
  decodeBytes,
  encodeBytes,
  encodeBytesInto,
  fromJson,
  isObj,
  mkErr,
  toJson,
  utf8ByteLength
} from '../utils'

export const overlayFrameVersion = 4
export const overlayControlKind = 1
export const overlayBroadcastKind = 2
export const overlayUnicastKind = 3
export const maxDescriptorNeighbors = 64

export type PeerDescriptor = {
  peerId: string
  seq: number
  pktSeq?: number
  neighbors: string[]
  signPubKey?: string
  encPubKey?: string
  userId?: string
  userPubKey?: string
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
  t: number
  s?: string
}

export type CryptoIdentity = {
  peerId: string
  signPrivateKey: CryptoKey
  signPubKey: string
  encPrivateKey: CryptoKey
  encPubKey: string
}

export const isPeerUsable = (
  peer: PeerHandle | undefined
): peer is PeerHandle =>
  Boolean(peer && !peer.isDead && peer.channel?.readyState !== 'closed')

export const getPeerBufferedBytes = (peer: PeerHandle | undefined): number =>
  typeof peer?.channel?.bufferedAmount === 'number'
    ? peer.channel.bufferedAmount
    : 0

export const packOverlayBinary = (
  kind: number,
  ttl: number,
  header: Record<string, unknown>,
  payload: Uint8Array
): Uint8Array => {
  const headerJson = toJson(header)
  const headerByteLen = utf8ByteLength(headerJson)
  const frame = new Uint8Array(5 + headerByteLen + payload.byteLength)
  frame[0] = overlayFrameVersion
  frame[1] = kind
  frame[2] = ttl & 0xff
  frame[3] = (headerByteLen >>> 8) & 0xff
  frame[4] = headerByteLen & 0xff
  encodeBytesInto(headerJson, frame.subarray(5, 5 + headerByteLen))
  frame.set(payload, 5 + headerByteLen)
  return frame
}

export type UnpackedOverlayFrame = readonly [
  kind: number,
  ttl: number,
  header: Record<string, unknown>,
  payload: Uint8Array
]

export const unpackOverlayFrame = (
  bytes: Uint8Array
): UnpackedOverlayFrame | null => {
  if (bytes.byteLength < 5 || bytes[0] !== overlayFrameVersion) {
    return null
  }
  const headerLen = (bytes[3]! << 8) | bytes[4]!
  if (
    headerLen <= 0 ||
    headerLen > maxOverlayHeaderBytes ||
    5 + headerLen > bytes.byteLength
  ) {
    return null
  }
  try {
    const header = fromJson<unknown>(
      decodeBytes(bytes.subarray(5, 5 + headerLen))
    )
    return isObj(header)
      ? [bytes[1]!, bytes[2]!, header, bytes.subarray(5 + headerLen)]
      : null
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
const descByteLengthCache = /*@__PURE__*/ new WeakMap<PeerDescriptor, number>()

export const packGossipControlFrames = (
  descriptors: PeerDescriptor[],
  maxFrameBytes: number = maxActionFrameBytes
): Uint8Array[] => {
  if (!descriptors.length) {
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
      frames.push(packOverlayControl({t: 'gossip', descriptors: currentDescs}))
      currentDescs = [desc]
      currentBytes = gossipEnvelopeOverheadBytes + descBytes
    } else {
      currentDescs.push(desc)
      currentBytes += addedBytes
    }
  }

  if (currentDescs.length > 0) {
    frames.push(packOverlayControl({t: 'gossip', descriptors: currentDescs}))
  }

  return frames
}

export const isValidOverlayMsgId = (msgId: string): boolean => {
  if (!msgId.length || msgId.length > 128) {
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

export const canonicalBroadcastHeader = (
  origin: string,
  msgId: string,
  seq: number,
  ts: number,
  appId: string,
  roomId: string
): string => canonTag('broadcast-v4', [appId, roomId, origin, seq, ts, msgId])

export const canonicalUnicastHeader = (
  origin: string,
  dest: string,
  msgId: string,
  ivB64: string,
  seq: number,
  ts: number,
  appId: string,
  roomId: string
): string =>
  canonTag('unicast-v4', [appId, roomId, origin, dest, seq, ts, msgId, ivB64])

export const canonicalLeaveHeader = (
  leavingId: string,
  seq: number,
  appId: string,
  roomId: string
): string => canonTag('leave-v4', [appId, roomId, leavingId, seq])

export const buildOverlaySignedBytes = (
  canonicalHeader: string,
  payload: Uint8Array
): Uint8Array => {
  const headerByteLen = utf8ByteLength(canonicalHeader)
  const combined = new Uint8Array(4 + headerByteLen + payload.byteLength)
  new DataView(combined.buffer).setUint32(0, headerByteLen)
  encodeBytesInto(canonicalHeader, combined.subarray(4, 4 + headerByteLen))
  combined.set(payload, 4 + headerByteLen)
  return combined
}

export const descriptorCanonicalPayload = (
  d: PeerDescriptor,
  appId: string,
  roomId: string
): string =>
  canonTag('desc-v4', [
    appId,
    roomId,
    d.peerId,
    d.seq,
    d.pktSeq ?? 0,
    d.neighbors,
    d.signPubKey ?? null,
    d.encPubKey ?? null,
    d.roomAuth ?? null,
    d.cert?.sig ?? null,
    ...(d.userId ? [d.userId, d.userPubKey ?? null, d.userProof ?? null] : [])
  ])

export const verifyBase64Sig = (
  sig: string,
  signedBytes: Uint8Array,
  pubKey: JsonWebKey | string
): boolean | Promise<boolean> => {
  if (!sig || !base64UrlRe.test(sig)) {
    return false
  }
  try {
    return verifyWithP256(fromBase64Url(sig), signedBytes, pubKey)
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
  return toBase64Url(await ecdsaSign(signPrivateKey, combined as BufferSource))
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
    descriptor.userPubKey = jwkToCompactPub(userIdentity.signPubJwk)
    descriptor.userProof = await signUserEndpointProof(userIdentity, {
      appId,
      roomId,
      peerId: descriptor.peerId,
      peerPubJwk: id.signPubKey,
      seq: descriptor.seq
    })
  }
  const canonicalBytes = encodeBytes(
    descriptorCanonicalPayload(descriptor, appId, roomId)
  )
  descriptor.sig = toBase64Url(
    await ecdsaSign(id.signPrivateKey, canonicalBytes as BufferSource)
  )
  return descriptor
}

const aesGcmParams = (
  iv: Uint8Array,
  canonicalHeader: string
): AesGcmParams => ({
  name: 'AES-GCM',
  iv: iv as BufferSource,
  additionalData: encodeBytes(canonicalHeader) as BufferSource
})

export const encryptUnicastPayload = async (
  aesKey: CryptoKey,
  iv: Uint8Array,
  canonicalHeader: string,
  plainPayload: Uint8Array
): Promise<Uint8Array> =>
  new Uint8Array(
    await crypto.subtle.encrypt(
      aesGcmParams(iv, canonicalHeader),
      aesKey,
      plainPayload as BufferSource
    )
  )

export const decryptUnicastPayload = async (
  aesKey: CryptoKey,
  ivB64: string,
  canonicalHeader: string,
  ciphertext: Uint8Array
): Promise<Uint8Array> => {
  if (ivB64.length !== 16 || !base64UrlRe.test(ivB64)) {
    throw mkErr('invalid unicast iv')
  }
  const iv = fromBase64Url(ivB64)
  if (iv.byteLength !== 12) {
    throw mkErr('invalid unicast iv')
  }
  return new Uint8Array(
    await crypto.subtle.decrypt(
      aesGcmParams(iv, canonicalHeader),
      aesKey,
      ciphertext as BufferSource
    )
  )
}
