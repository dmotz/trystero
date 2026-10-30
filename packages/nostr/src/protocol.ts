import {schnorr} from '@noble/secp256k1'
import {encodeBytes, toJson} from '@trystero-p2p/core'

export type NostrSigner = {
  secretKey: Uint8Array
  pubkey: string
}

export const tag = 'x'
export const eventMsgType = 'EVENT'

const subscribeClockSkewSeconds = 60
const kindCache: Record<string, number> = {}
const sha256TopicRe = /^[A-Za-z0-9_-]{43}$/

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')

const now = (): number => Math.floor(Date.now() / 1000)

export const subscribeSince = (): number =>
  Math.max(0, now() - subscribeClockSkewSeconds)

export const createSigner = (): NostrSigner => {
  const {secretKey, publicKey} = schnorr.keygen()
  return {secretKey, pubkey: toHex(publicKey)}
}

const deriveTopicKind = (topic: string): number => {
  if (sha256TopicRe.test(topic)) {
    const bin = atob(topic.slice(0, 8).replace(/-/g, '+').replace(/_/g, '/'))
    let val = 0
    for (let i = 0; i < 6; i++) {
      val = val * 256 + bin.charCodeAt(i)
    }
    return (val % 10_000) + 20_000
  }
  const bytes = encodeBytes(topic)
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.byteLength; i++) {
    h = Math.imul(h ^ bytes[i]!, 0x01000193)
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  return (((h ^ (h >>> 16)) >>> 0) % 10_000) + 20_000
}

export const topicToKind = (topic: string): number =>
  (kindCache[topic] ??= deriveTopicKind(topic))

export const createEvent = async (
  topic: string,
  content: string,
  signer: NostrSigner = createSigner()
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
