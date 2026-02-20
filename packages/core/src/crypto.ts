import {decodeBytes, encodeBytes} from './utils'

const algo = 'AES-GCM'
const strToSha1: Record<string, string> = {}

const pack = (buff: ArrayBuffer): string =>
  btoa(String.fromCharCode.apply(null, Array.from(new Uint8Array(buff))))

const unpack = (packed: string): ArrayBuffer => {
  const str = atob(packed)
  return new Uint8Array(str.length).map((_, i) => str.charCodeAt(i)).buffer
}

export const hashWith = async (
  algorithm: string,
  str: string
): Promise<Uint8Array> =>
  new Uint8Array(
    await crypto.subtle.digest(algorithm, encodeBytes(str) as BufferSource)
  )

export const sha1 = async (str: string): Promise<string> =>
  (strToSha1[str] ??= Array.from(await hashWith('SHA-1', str))
    .map(b => b.toString(36))
    .join(''))

export const genKey = async (
  secret: string,
  appId: string,
  roomId: string
): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    'raw',
    await crypto.subtle.digest(
      {name: 'SHA-256'},
      encodeBytes(`${secret}:${appId}:${roomId}`) as BufferSource
    ),
    {name: algo},
    false,
    ['encrypt', 'decrypt']
  )

const joinChar = '$'
const ivJoinChar = ','

export const encrypt = async (
  keyP: Promise<CryptoKey>,
  plaintext: string
): Promise<string> => {
  const iv = crypto.getRandomValues(new Uint8Array(16))

  return (
    iv.join(ivJoinChar) +
    joinChar +
    pack(
      await crypto.subtle.encrypt(
        {name: algo, iv},
        await keyP,
        encodeBytes(plaintext) as BufferSource
      )
    )
  )
}

export const decrypt = async (
  keyP: Promise<CryptoKey>,
  raw: string
): Promise<string> => {
  const [iv, c] = raw.split(joinChar)

  return decodeBytes(
    await crypto.subtle.decrypt(
      {name: algo, iv: new Uint8Array(iv?.split(ivJoinChar).map(Number) ?? [])},
      await keyP,
      unpack(c ?? '')
    )
  )
}
