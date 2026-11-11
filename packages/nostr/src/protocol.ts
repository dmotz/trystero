import {schnorr} from '@noble/secp256k1'
import {encodeBytes, toJson} from '@trystero-p2p/core'

export type NostrSigner = {
  secretKey: Uint8Array
  pubkey: string
}

export const tag = 'x'
export const eventMsgType = 'EVENT'

const subscribeClockSkewSeconds = 60

const nativeToHex = (
  Uint8Array.prototype as Uint8Array & {
    toHex?: () => string
  }
).toHex

const toHex: (bytes: Uint8Array) => string =
  typeof nativeToHex === 'function'
    ? bytes => nativeToHex.call(bytes)
    : bytes =>
        Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')

const now = (): number => Math.floor(Date.now() / 1000)

export const subscribeSince = (): number =>
  Math.max(0, now() - subscribeClockSkewSeconds)

export const createSigner = (): NostrSigner => {
  const {secretKey, publicKey} = schnorr.keygen()
  return {secretKey, pubkey: toHex(publicKey)}
}

export const topicToKind = (topic: string): number => {
  let h = 0x811c9dc5
  for (let i = 0; i < topic.length; i++) {
    h = Math.imul(h ^ topic.charCodeAt(i), 0x01000193)
  }
  return ((h >>> 0) % 10_000) + 20_000
}

export const createEvent = async (
  topic: string,
  content: string,
  signer: NostrSigner
): Promise<string> => {
  const payload = {
    kind: topicToKind(topic),
    tags: [[tag, topic]],
    created_at: now(),
    content,
    pubkey: signer.pubkey
  }

  const id = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      encodeBytes(
        toJson([
          0,
          payload.pubkey,
          payload.created_at,
          payload.kind,
          payload.tags,
          payload.content
        ])
      ) as BufferSource
    )
  )

  return toJson([
    eventMsgType,
    {
      ...payload,
      id: toHex(id),
      sig: toHex(await schnorr.signAsync(id, signer.secretKey))
    }
  ])
}
