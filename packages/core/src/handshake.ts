import {hashWith} from './crypto'
import {
  extractDtlsFingerprints,
  fromBase64Url,
  getOrCreateEndpointIdentitySync,
  toBase64Url,
  verifyPeerIdKey,
  verifyUserIdKey,
  verifyWithP256Sync
} from './identity'
import {
  encodeBytes,
  genId,
  keys,
  mkErr,
  resetTimer,
  selfId,
  toError,
  toErrorMessage,
  toHex,
  toJson
} from './utils'
import type {
  DataPayload,
  HandshakePayload,
  HandshakeReceiver,
  HandshakeSender,
  JsonValue,
  PeerHandle,
  PeerHandshake,
  UserIdentity
} from './types'

const overlapRoomPasswordErr = mkErr('incorrect password for overlapping room')
const peerIdentityErr = mkErr('peer identity verification failed')
export const roomFullHostRejectErr = mkErr('__trystero_room_full_host_reject__')

export type HandshakeReadyPayload =
  | string
  | {
      ok: boolean
      err?: string
      limit?: number
      t?: number
      est?: boolean
    }

export type VerifiedPeerIdentity = {
  userId: string
  peerPubKey: JsonWebKey
  userPubKey: JsonWebKey
}

type IdentityHandshakeStepMessage = {
  __trystero_id?: unknown
  n?: unknown
  dtls?: unknown
  uid?: unknown
  pk?: unknown
  uk?: unknown
  ps?: unknown
  us?: unknown
}

const parseAndVerifyPeerIdentityClaims = (
  raw: unknown,
  expectedStep: 1 | 2,
  remotePeerId: string,
  expectedRemoteDtls: string[]
): {
  nonce: string
  dtls: string[]
  userId: string
  peerPubJwk: JsonWebKey
  userPubJwk: JsonWebKey
  ps?: string
  us?: string
} => {
  if (!raw || typeof raw !== 'object') {
    throw peerIdentityErr
  }
  const msg = raw as IdentityHandshakeStepMessage
  if (
    msg.__trystero_id !== expectedStep ||
    typeof msg.n !== 'string' ||
    msg.n.length < 16 ||
    !Array.isArray(msg.dtls) ||
    typeof msg.uid !== 'string' ||
    !msg.pk ||
    typeof msg.pk !== 'object' ||
    !msg.uk ||
    typeof msg.uk !== 'object' ||
    (expectedStep === 2 &&
      (typeof msg.ps !== 'string' || typeof msg.us !== 'string'))
  ) {
    throw peerIdentityErr
  }

  const dtls = msg.dtls.filter((x): x is string => typeof x === 'string')
  if (
    expectedRemoteDtls.length > 0 &&
    expectedRemoteDtls.join(',') !== dtls.join(',')
  ) {
    throw mkErr('DTLS fingerprint mismatch during identity handshake')
  }

  const peerPubJwk = msg.pk as JsonWebKey
  const userPubJwk = msg.uk as JsonWebKey
  if (
    !verifyPeerIdKey(remotePeerId, peerPubJwk) ||
    !verifyUserIdKey(msg.uid, userPubJwk)
  ) {
    throw peerIdentityErr
  }

  return {
    nonce: msg.n,
    dtls,
    userId: msg.uid,
    peerPubJwk,
    userPubJwk,
    ...(typeof msg.ps === 'string' ? {ps: msg.ps} : {}),
    ...(typeof msg.us === 'string' ? {us: msg.us} : {})
  }
}

const verifyTranscriptDualSignatures = (
  transcriptBytes: Uint8Array,
  peerSigB64: string,
  userSigB64: string,
  peerPubJwk: JsonWebKey,
  userPubJwk: JsonWebKey
): void => {
  if (
    !verifyWithP256Sync(
      fromBase64Url(peerSigB64),
      transcriptBytes,
      peerPubJwk
    ) ||
    !verifyWithP256Sync(fromBase64Url(userSigB64), transcriptBytes, userPubJwk)
  ) {
    throw peerIdentityErr
  }
}

export const createIdentityHandshake = (params: {
  selfId: string
  appId: string
  roomId: string | Promise<string>
  getUserIdentity: () => Promise<UserIdentity>
  getPeerHandle?: (peerId: string) => PeerHandle | undefined
  onVerified?: (peerId: string, verified: VerifiedPeerIdentity) => void
}): {
  run: (
    peerId: string,
    send: HandshakeSender,
    receive: HandshakeReceiver,
    isInitiator: boolean
  ) => Promise<VerifiedPeerIdentity>
  compose: (nextHandshake?: PeerHandshake) => PeerHandshake
} => {
  const localEndpoint = getOrCreateEndpointIdentitySync(params.selfId)

  const signTranscript = async (
    transcriptBytes: Uint8Array,
    localUser: UserIdentity
  ): Promise<{ps: string; us: string}> => ({
    ps: toBase64Url(localEndpoint.sign(transcriptBytes)),
    us: toBase64Url(await localUser.sign(transcriptBytes))
  })

  const run = async (
    remotePeerId: string,
    send: HandshakeSender,
    receive: HandshakeReceiver,
    isInitiator: boolean
  ): Promise<VerifiedPeerIdentity> => {
    const [resolvedRoomId, localUser] = await Promise.all([
      params.roomId,
      params.getUserIdentity()
    ])
    const peer = params.getPeerHandle?.(remotePeerId)
    const localDtls = extractDtlsFingerprints(
      peer?.connection?.localDescription?.sdp
    )
    const remoteDtls = extractDtlsFingerprints(
      peer?.connection?.remoteDescription?.sdp
    )

    if (isInitiator) {
      const initNonce = genId(32)
      await send({
        __trystero_id: 1,
        n: initNonce,
        dtls: localDtls,
        uid: localUser.userId,
        pk: localEndpoint.signPubJwk as unknown as JsonValue,
        uk: localUser.signPubJwk as unknown as JsonValue
      })

      const {data: step2} = await receive()
      const resp = parseAndVerifyPeerIdentityClaims(
        step2,
        2,
        remotePeerId,
        remoteDtls
      )

      const transcriptBytes = encodeBytes(
        toJson([
          'trystero-id-hs:v1',
          params.appId,
          resolvedRoomId,
          params.selfId,
          remotePeerId,
          initNonce,
          resp.nonce,
          localDtls,
          resp.dtls,
          localUser.userId,
          resp.userId
        ])
      )

      verifyTranscriptDualSignatures(
        transcriptBytes,
        resp.ps!,
        resp.us!,
        resp.peerPubJwk,
        resp.userPubJwk
      )

      const sigs = await signTranscript(transcriptBytes, localUser)

      const verified: VerifiedPeerIdentity = {
        userId: resp.userId,
        peerPubKey: resp.peerPubJwk,
        userPubKey: resp.userPubJwk
      }
      try {
        params.onVerified?.(remotePeerId, verified)
      } catch (err) {
        if (
          err === roomFullHostRejectErr ||
          (err instanceof Error && /peer banned/.test(err.message))
        ) {
          await send({
            __trystero_id: 3,
            ...sigs
          })
        }
        throw err
      }

      await send({
        __trystero_id: 3,
        ...sigs
      })

      return verified
    }

    const {data: step1} = await receive()
    const init = parseAndVerifyPeerIdentityClaims(
      step1,
      1,
      remotePeerId,
      remoteDtls
    )

    const respNonce = genId(32)
    const transcriptBytes = encodeBytes(
      toJson([
        'trystero-id-hs:v1',
        params.appId,
        resolvedRoomId,
        remotePeerId,
        params.selfId,
        init.nonce,
        respNonce,
        init.dtls,
        localDtls,
        init.userId,
        localUser.userId
      ])
    )

    const sigs = await signTranscript(transcriptBytes, localUser)

    await send({
      __trystero_id: 2,
      n: respNonce,
      dtls: localDtls,
      uid: localUser.userId,
      pk: localEndpoint.signPubJwk as unknown as JsonValue,
      uk: localUser.signPubJwk as unknown as JsonValue,
      ...sigs
    })

    const {data: step3} = await receive()
    if (!step3 || typeof step3 !== 'object') {
      throw peerIdentityErr
    }
    const msg3 = step3 as {
      __trystero_id?: unknown
      ps?: unknown
      us?: unknown
    }
    if (
      msg3.__trystero_id !== 3 ||
      typeof msg3.ps !== 'string' ||
      typeof msg3.us !== 'string'
    ) {
      throw peerIdentityErr
    }
    verifyTranscriptDualSignatures(
      transcriptBytes,
      msg3.ps,
      msg3.us,
      init.peerPubJwk,
      init.userPubJwk
    )

    const verified: VerifiedPeerIdentity = {
      userId: init.userId,
      peerPubKey: init.peerPubJwk,
      userPubKey: init.userPubJwk
    }
    params.onVerified?.(remotePeerId, verified)
    return verified
  }

  const compose = (nextHandshake?: PeerHandshake): PeerHandshake =>
    async (peerId, send, receive, isInitiator): Promise<void> => {
      await nextHandshake?.(peerId, send, receive, isInitiator)
      await run(peerId, send, receive, isInitiator)
    }

  return {run, compose}
}

export const createPasswordHandshake = (
  password: string,
  appId: string,
  roomId: string | Promise<string>
): {
  run: (
    send: HandshakeSender,
    receive: HandshakeReceiver,
    isInitiator: boolean
  ) => Promise<void>
  compose: (userHandshake?: PeerHandshake) => PeerHandshake | undefined
} => {
  const hashChallenge = async (challenge: string): Promise<string> =>
    toHex(
      await hashWith(
        'SHA-256',
        `${challenge}:${password}:${appId}:${await roomId}`
      )
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
  remoteReadyData?: HandshakeReadyPayload
  handshakeTimer: ReturnType<typeof setTimeout> | null
  pendingHandshakePayloads: HandshakePayload[]
  handshakeWaiters: Array<{
    resolve: (payload: HandshakePayload) => void
    reject: (error: Error) => void
  }>
}

type HandshakeManagerDeps = {
  selfId?: string
  onPeerHandshake?: PeerHandshake
  onHandshakeError?: (peerId: string, error: string) => void
  handshakeTimeoutMs: number
  sendHandshakeData: (
    data: DataPayload,
    peerId: string,
    metadata?: JsonValue
  ) => Promise<void>
  sendHandshakeReady: (
    data: HandshakeReadyPayload,
    peerId: string
  ) => Promise<void>
  canAcceptBeforeHandshake?: (peerId: string) => boolean
  onRejectFull?: (peerId: string, peer: PeerHandle) => void
  onLocalHandshakePassed?: (
    peerId: string,
    peer: PeerHandle
  ) => HandshakeReadyPayload | null
  onRemoteHandshakeReady?: (
    peerId: string,
    peer: PeerHandle,
    data: HandshakeReadyPayload
  ) => boolean
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
  selfId: localSelfId = selfId,
  onPeerHandshake,
  onHandshakeError,
  handshakeTimeoutMs,
  sendHandshakeData,
  sendHandshakeReady,
  canAcceptBeforeHandshake,
  onRejectFull,
  onLocalHandshakePassed,
  onRemoteHandshakeReady,
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
  receiveHandshakeReady: (id: string, data?: HandshakeReadyPayload) => void
  getReadyPendingIds: () => string[]
  getPendingIds: () => string[]
  getPeer: (id: string) => PeerHandle | undefined
  activate: (id: string) => void
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
    let remoteHandled = false
    if (state.didReceiveRemoteReady) {
      remoteHandled = Boolean(
        onRemoteHandshakeReady?.(id, peer, state.remoteReadyData ?? '')
      )
      if (!peerStates[id] || state.isActive) {
        return
      }
    }
    const payload = onLocalHandshakePassed
      ? onLocalHandshakePassed(id, peer)
      : ''

    if (payload === null) {
      return
    }

    void sendHandshakeReady(payload, id).catch(err =>
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
    const isCapacityDeferred =
      Boolean(payload) &&
      typeof payload === 'object' &&
      payload.limit !== undefined
    if (!isCapacityDeferred && !remoteHandled) {
      maybeActivatePeer(id, peer)
    }
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

      if (canAcceptBeforeHandshake && !canAcceptBeforeHandshake(id)) {
        onRejectFull?.(id, peer)
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
        const current = peerStates[id]
        if (!current || current.peer !== peer) {
          throw mkErr('peer disconnected during handshake')
        }
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

      const isInitiator = localSelfId < id

      void Promise.resolve(
        onPeerHandshake?.(id, sendHandshake, receiveHandshake, isInitiator)
      )
        .then(() => markLocalHandshakePassed(id, peer))
        .catch(err => {
          if (err === roomFullHostRejectErr) {
            onRejectFull?.(id, peer)
            return
          }
          failPeerHandshake(id, peer, toError(err, 'handshake failed'))
        })
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

      if (state.pendingHandshakePayloads.length >= 16) {
        failPeerHandshake(
          id,
          state.peer,
          mkErr('too many pending handshake messages')
        )
        return
      }
      state.pendingHandshakePayloads.push(payload)
    },

    receiveHandshakeReady: (id, data = '') => {
      const state = peerStates[id]

      if (!state || state.isActive) {
        return
      }

      state.didReceiveRemoteReady = true
      state.remoteReadyData = data

      if (!state.didLocalHandshakePass) {
        return
      }

      if (onRemoteHandshakeReady?.(id, state.peer, data)) {
        return
      }

      maybeActivatePeer(id)
    },

    getReadyPendingIds: () =>
      keys(peerStates).filter(id => {
        const s = peerStates[id]
        return Boolean(
          s && !s.isActive && s.didLocalHandshakePass && s.didReceiveRemoteReady
        )
      }),
    getPendingIds: () =>
      keys(peerStates).filter(id => !peerStates[id]?.isActive),
    getPeer: id => peerStates[id]?.peer,
    activate: id => maybeActivatePeer(id)
  }
}
