import {hashWith} from './crypto'
import {genId, mkErr, toHex} from './utils'
import type {HandshakeReceiver, HandshakeSender, PeerHandshake} from './types'

const overlapRoomPasswordErr = mkErr('incorrect password for overlapping room')

export const createPasswordHandshake = (
  password: string,
  appId: string,
  roomId: string
): {
  run: (
    send: HandshakeSender,
    receive: HandshakeReceiver,
    isInitiator: boolean
  ) => Promise<void>
  compose: (userHandshake?: PeerHandshake) => PeerHandshake | undefined
} => {
  const hashChallenge = (challenge: string): Promise<string> =>
    hashWith('SHA-256', `${challenge}:${password}:${appId}:${roomId}`).then(
      toHex
    )

  const run = async (
    send: HandshakeSender,
    receive: HandshakeReceiver,
    isInitiator: boolean
  ): Promise<void> => {
    if (!password) {
      return
    }

    if (isInitiator) {
      const challenge = genId(36)
      await send({__trystero_pw: 'challenge', c: challenge})
      const {data} = await receive()

      if (
        !data ||
        typeof data !== 'object' ||
        (data as {__trystero_pw?: unknown}).__trystero_pw !== 'response' ||
        typeof (data as {h?: unknown}).h !== 'string'
      ) {
        throw overlapRoomPasswordErr
      }

      const expected = await hashChallenge(challenge)

      if ((data as {h: string}).h !== expected) {
        throw overlapRoomPasswordErr
      }

      return
    }

    const {data} = await receive()

    if (
      !data ||
      typeof data !== 'object' ||
      (data as {__trystero_pw?: unknown}).__trystero_pw !== 'challenge' ||
      typeof (data as {c?: unknown}).c !== 'string'
    ) {
      throw overlapRoomPasswordErr
    }

    await send({
      __trystero_pw: 'response',
      h: await hashChallenge((data as {c: string}).c)
    })
  }

  const compose = (userHandshake?: PeerHandshake): PeerHandshake | undefined =>
    password || userHandshake
      ? async (peerId, send, receive, isInitiator): Promise<void> => {
          await run(send, receive, isInitiator)
          await userHandshake?.(peerId, send, receive, isInitiator)
        }
      : undefined

  return {run, compose}
}
