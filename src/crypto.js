import {decodeBytes, encodeBytes} from './utils.js'

const algo = 'AES-GCM'
const strToSha1 = {}

const pack = buff => btoa(String.fromCharCode.apply(null, new Uint8Array(buff)))

const unpack = packed => {
  const str = atob(packed)

  return new Uint8Array(str.length).map((_, i) => str.charCodeAt(i)).buffer
}

export const sha1 = async str => {
  if (strToSha1[str]) {
    return strToSha1[str]
  }

  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-1', encodeBytes(str)))
  )
    .map(b => b.toString(36))
    .join('')

  // eslint-disable-next-line require-atomic-updates
  strToSha1[str] = hash

  return hash
}

export const genKey = async (secret, appId, roomId) =>
  crypto.subtle.importKey(
    'raw',
    await crypto.subtle.digest(
      {name: 'SHA-256'},
      encodeBytes(`${secret}:${appId}:${roomId}`)
    ),
    {name: algo},
    false,
    ['encrypt', 'decrypt']
  )

const joinChar = '$'
const ivJoinChar = ','

export const encrypt = async (keyP, plaintext) => {
  const iv = crypto.getRandomValues(new Uint8Array(16))

  return (
    iv.join(ivJoinChar) +
    joinChar +
    pack(
      await crypto.subtle.encrypt(
        {name: algo, iv},
        await keyP,
        encodeBytes(plaintext)
      )
    )
  )
}

export const decrypt = async (keyP, raw) => {
  const [iv, c] = raw.split(joinChar)

  return decodeBytes(
    await crypto.subtle.decrypt(
      {name: algo, iv: new Uint8Array(iv.split(ivJoinChar))},
      await keyP,
      unpack(c)
    )
  )
}
