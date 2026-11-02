import {sha256} from './crypto'
import {getVerifiedPubKeyRecord} from './identity'
import {
  canonTag,
  isValidJwk,
  signWith,
  toCleanJwk,
  verifyRoleCertificate,
  verifySig,
  type StateSigner
} from './signed-record'
import type {DataPayload, JsonValue, RoleCertificate} from './types'
import {
  encodeBytes,
  isObj,
  isPosSafeInt,
  isStr,
  isValidSig,
  toBase64Url,
  toJson,
  validateRoleCertificateShape
} from './utils'

const digestChunkBytes = 256 * 1024

export type ActionAuthEnvelope = {
  v: 1
  appId: string
  roomId: string
  namespace: string
  peerId: string
  userId: string
  seq: number
  digest: string
  cert: RoleCertificate
  signerPubKey: JsonWebKey
  sig: string
  meta?: JsonValue
}

const hasStrs = (o: Record<string, unknown>, ks: readonly string[]): boolean =>
  ks.every(k => isStr(o[k]))

const packDigest = async (
  tag: number,
  body: Uint8Array,
  metaB?: Uint8Array
): Promise<string> => {
  const out = new Uint8Array(
    body.byteLength + (metaB ? 5 + metaB.byteLength : 1)
  )
  out[0] = metaB ? tag | 0x80 : tag
  out.set(body, 1)
  if (metaB) {
    new DataView(out.buffer, 1 + body.byteLength, 4).setUint32(
      0,
      metaB.byteLength,
      false
    )
    out.set(metaB, 5 + body.byteLength)
  }
  return toBase64Url(await sha256(out))
}

export const computePayloadDigest = async (
  data: DataPayload,
  meta?: JsonValue
): Promise<string> => {
  const metaB = meta === undefined ? undefined : encodeBytes(toJson(meta))
  const isBlob = typeof Blob !== 'undefined' && data instanceof Blob
  let rawB: Uint8Array = new Uint8Array(0)
  let tag = 0x02
  if (!isBlob) {
    if (data instanceof Uint8Array) {
      rawB = data
    } else if (data instanceof ArrayBuffer) {
      rawB = new Uint8Array(data)
    } else if (ArrayBuffer.isView(data)) {
      rawB = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    } else if (typeof data === 'string') {
      rawB = encodeBytes(data)
      tag = 0x01
    } else {
      rawB = encodeBytes(toJson(data))
      tag = 0x03
    }
  }
  const totalLen = isBlob ? data.size : rawB.byteLength
  if (tag !== 0x02 || totalLen <= digestChunkBytes) {
    if (isBlob) {
      rawB = new Uint8Array(await data.arrayBuffer())
    }
    return packDigest(tag, rawB, metaB)
  }
  const nChunks = Math.ceil(totalLen / digestChunkBytes)
  const body = new Uint8Array(8 + nChunks * 32)
  new DataView(body.buffer).setBigUint64(0, BigInt(totalLen), false)
  for (let i = 0, off = 0; off < totalLen; i++, off += digestChunkBytes) {
    const end = Math.min(off + digestChunkBytes, totalLen)
    const part = isBlob
      ? new Uint8Array(await data.slice(off, end).arrayBuffer())
      : rawB.subarray(off, end)
    body.set(await sha256(part as BufferSource), 8 + i * 32)
  }
  return packDigest(0x04, body, metaB)
}

export const actionAuthPayload = (
  e: Omit<ActionAuthEnvelope, 'sig' | 'meta'>
): string =>
  canonTag('action-auth', [
    e.v,
    e.appId,
    e.roomId,
    e.namespace,
    e.peerId,
    e.userId,
    e.seq,
    e.digest,
    e.cert.sig
  ])

export const validateActionAuthShape = (e: unknown): e is ActionAuthEnvelope =>
  isObj(e) &&
  e['v'] === 1 &&
  hasStrs(e, ['appId', 'roomId', 'namespace', 'peerId', 'userId', 'digest']) &&
  isPosSafeInt(e['seq']) &&
  validateRoleCertificateShape(e['cert']) &&
  isValidJwk(e['signerPubKey']) &&
  isValidSig(e['sig'])

export type ActionSignParams = {
  appId: string
  roomId: string
  namespace: string
  peerId: string
  userId?: string
  seq: number
  data: DataPayload
  meta?: JsonValue
}

export const signActionAuth = async (
  signer: StateSigner,
  pubJwk: JsonWebKey,
  cert: RoleCertificate,
  p: ActionSignParams
): Promise<ActionAuthEnvelope> => {
  const u: Omit<ActionAuthEnvelope, 'sig'> = {
    v: 1,
    appId: p.appId,
    roomId: p.roomId,
    namespace: p.namespace,
    peerId: p.peerId,
    userId: p.userId ?? cert.subUserId,
    seq: p.seq,
    digest: await computePayloadDigest(p.data, p.meta),
    cert,
    signerPubKey: toCleanJwk(pubJwk),
    ...(p.meta === undefined ? {} : {meta: p.meta})
  }
  return {...u, sig: await signWith(signer, actionAuthPayload(u))}
}

export type ActionVerifyParams = {
  appId: string
  roomId: string
  namespace: string
  peerId: string
  expectedUserId?: string
  data: DataPayload
  requiredRoles: readonly string[]
  rootUserIds: Set<string>
  skipDigestCheck?: boolean
  skipSigCheck?: boolean
  maxClockSkewMs?: number
  certVerifier?: (
    cert: RoleCertificate
  ) => Promise<{valid: boolean; roles: string[]}>
}

export const verifyActionAuth = async (
  env: ActionAuthEnvelope,
  p: ActionVerifyParams
): Promise<{valid: boolean; roles: string[]}> => {
  if (
    !validateActionAuthShape(env) ||
    env.appId !== p.appId ||
    env.roomId !== p.roomId ||
    env.namespace !== p.namespace ||
    env.peerId !== p.peerId ||
    env.cert.subUserId !== env.userId ||
    (p.expectedUserId !== undefined && env.userId !== p.expectedUserId)
  ) {
    return {valid: false, roles: []}
  }
  if (!p.skipSigCheck) {
    const signer = await getVerifiedPubKeyRecord(env.signerPubKey)
    if (!signer || signer.userId !== env.userId) {
      return {valid: false, roles: []}
    }
  }
  const certRes = p.certVerifier
    ? await p.certVerifier(env.cert)
    : await verifyRoleCertificate(
        env.cert,
        p.appId,
        p.roomId,
        p.rootUserIds,
        p.maxClockSkewMs
      )
  if (!certRes.valid || !p.requiredRoles.some(r => certRes.roles.includes(r))) {
    return {valid: false, roles: []}
  }
  if (
    !p.skipDigestCheck &&
    (await computePayloadDigest(p.data, env.meta)) !== env.digest
  ) {
    return {valid: false, roles: []}
  }
  if (
    !p.skipSigCheck &&
    !(await verifySig(env.signerPubKey, actionAuthPayload(env), env.sig))
  ) {
    return {valid: false, roles: []}
  }
  return {valid: true, roles: certRes.roles}
}
