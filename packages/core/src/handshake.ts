import {hashWith} from './crypto'
import {
  genId,
  mkErr,
  resetTimer,
  selfId,
  toError,
  toErrorMessage,
  toHex
} from './utils'
import type {
  DataPayload,
  HandshakePayload,
  HandshakeReceiver,
  HandshakeSender,
  JsonValue,
  PeerHandle,
  PeerHandshake
} from './types'

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

type PendingPeerState = {
  peer: PeerHandle
  isActive: boolean
  didLocalHandshakePass: boolean
  didReceiveRemoteReady: boolean
  handshakeTimer: ReturnType<typeof setTimeout> | null
  pendingHandshakePayloads: HandshakePayload[]
  handshakeWaiters: Array<{
    resolve: (payload: HandshakePayload) => void
    reject: (error: Error) => void
  }>
}

type HandshakeManagerDeps = {
  onPeerHandshake?: PeerHandshake
  onHandshakeError?: (peerId: string, error: string) => void
  handshakeTimeoutMs: number
  sendHandshakeData: (
    data: DataPayload,
    peerId: string,
    metadata?: JsonValue
  ) => Promise<void[]>
  sendHandshakeReady: (data: string, peerId: string) => Promise<void[]>
  onActivate: (peerId: string, peer: PeerHandle) => void
  onFailure: (peerId: string, peer: PeerHandle, reason: Error) => void
}

const toHandshakeErrorMessage = (error: Error): string => {
  const message = toErrorMessage(error, 'unknown error')

  return message.startsWith('handshake ')
    ? message
    : `handshake failed: ${message}`
}

export const createHandshakeManager = ({
  onPeerHandshake,
  onHandshakeError,
  handshakeTimeoutMs,
  sendHandshakeData,
  sendHandshakeReady,
  onActivate,
  onFailure
}: HandshakeManagerDeps): {
  addPeer: (id: string, peer: PeerHandle) => void
  clearPeer: (id: string, error: Error) => void
  canReceiveFromPeer: (id: string, receiveWhilePending: boolean) => boolean
  start: (id: string, peer: PeerHandle) => void
  receiveHandshakeData: (
    data: DataPayload,
    id: string,
    metadata?: JsonValue
  ) => void
  receiveHandshakeReady: (id: string) => void
} => {
  const peerStates: Record<string, PendingPeerState> = {}

  const maybeActivatePeer = (id: string, peer?: PeerHandle): void => {
    const state = peerStates[id]

    if (!state || (peer && state.peer !== peer) || state.isActive) {
      return
    }

    if (!state.didLocalHandshakePass || !state.didReceiveRemoteReady) {
      return
    }

    state.isActive = true
    state.handshakeTimer = resetTimer(state.handshakeTimer)
    onActivate(id, state.peer)
  }

  const failPeerHandshake = (
    id: string,
    peer: PeerHandle,
    reason: Error
  ): void => {
    const state = peerStates[id]

    if (!state || state.peer !== peer) {
      return
    }

    const error = toHandshakeErrorMessage(reason)

    onHandshakeError?.(id, error)
    onFailure(id, peer, mkErr(error))
  }

  const markLocalHandshakePassed = (id: string, peer: PeerHandle): void => {
    const state = peerStates[id]

    if (!state || state.peer !== peer || state.isActive) {
      return
    }

    state.didLocalHandshakePass = true

    void sendHandshakeReady('', id).catch(err =>
      failPeerHandshake(
        id,
        peer,
        mkErr(
          `failed sending handshake readiness: ${toErrorMessage(
            err,
            'unknown send failure'
          )}`
        )
      )
    )
    maybeActivatePeer(id, peer)
  }

  return {
    addPeer: (id, peer) => {
      peerStates[id] = {
        peer,
        isActive: false,
        didLocalHandshakePass: false,
        didReceiveRemoteReady: false,
        handshakeTimer: null,
        pendingHandshakePayloads: [],
        handshakeWaiters: []
      }
    },

    clearPeer: (id, error) => {
      const state = peerStates[id]

      if (!state) {
        return
      }

      state.handshakeTimer = resetTimer(state.handshakeTimer)
      state.pendingHandshakePayloads.length = 0
      state.handshakeWaiters.splice(0).forEach(waiter => waiter.reject(error))
      delete peerStates[id]
    },

    canReceiveFromPeer: (id, receiveWhilePending) => {
      const state = peerStates[id]

      return Boolean(state && (state.isActive || receiveWhilePending))
    },

    start: (id, peer) => {
      const state = peerStates[id]

      if (!state || state.peer !== peer) {
        return
      }

      state.handshakeTimer = setTimeout(
        () =>
          failPeerHandshake(
            id,
            peer,
            mkErr(`handshake timed out after ${handshakeTimeoutMs}ms`)
          ),
        handshakeTimeoutMs
      )

      const sendHandshake: HandshakeSender = async (data, metadata) => {
        await sendHandshakeData(data, id, metadata)
      }

      const receiveHandshake: HandshakeReceiver = () =>
        new Promise<HandshakePayload>((resolve, reject) => {
          const current = peerStates[id]

          if (!current || current.peer !== peer) {
            reject(mkErr('peer disconnected during handshake'))
            return
          }

          const payload = current.pendingHandshakePayloads.shift()

          if (payload) {
            resolve(payload)
            return
          }

          current.handshakeWaiters.push({
            resolve,
            reject: error => reject(error)
          })
        })

      const isInitiator = selfId < id

      void Promise.resolve(
        onPeerHandshake?.(id, sendHandshake, receiveHandshake, isInitiator)
      )
        .then(() => markLocalHandshakePassed(id, peer))
        .catch(err =>
          failPeerHandshake(id, peer, toError(err, 'handshake failed'))
        )
    },

    receiveHandshakeData: (data, id, metadata) => {
      const state = peerStates[id]

      if (!state || state.isActive) {
        return
      }

      const payload =
        metadata === undefined ? {data} : ({data, metadata} as HandshakePayload)
      const pending = state.handshakeWaiters.shift()

      if (pending) {
        pending.resolve(payload)
        return
      }

      state.pendingHandshakePayloads.push(payload)
    },

    receiveHandshakeReady: id => {
      const state = peerStates[id]

      if (!state || state.isActive) {
        return
      }

      state.didReceiveRemoteReady = true
      maybeActivatePeer(id)
    }
  }
}
