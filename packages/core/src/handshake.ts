import {
  type EndpointIdentity,
  fromBase64Url,
  getDefaultEndpointIdentity,
  resolveSelfId,
  toBase64Url,
  verifyPeerIdKey,
  verifyUserIdKey,
  verifyWithP256
} from './identity'
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
import {
  all,
  encodeBytes,
  isObj,
  isStr,
  keys,
  libId,
  mkErr,
  resetTimer,
  toError,
  toErrorMessage,
  toJson
} from './utils'

const peerIdentityErr = /*@__PURE__*/ mkErr('peer identity verification failed')
const handshakeDisconnectErr = /*@__PURE__*/ mkErr(
  'peer disconnected during handshake'
)
const hsStepKey = `__${libId}_id`
const hsDomain = `${libId}-id-hs:v1`

export const extractDtlsFingerprints = (sdp?: string | null): string[] => {
  if (!sdp || typeof sdp !== 'string') {
    return []
  }
  const matches = sdp.matchAll(/^a=fingerprint:([^\r\n]+)$/gm)
  const set = new Set<string>()
  for (const m of matches) {
    const val = m[1]?.trim().toLowerCase()
    if (val) {
      set.add(val)
    }
  }
  return [...set].sort()
}

export type HandshakeReadyPayload =
  | string
  | {
      ok: true
      p: Record<string, string>
      r: JsonValue[]
    }
  | {
      ok: false
      err: 'room full' | 'peer banned'
      reason?: string
    }

export type VerifiedPeerIdentity = {
  userId: string
  peerPubKey: JsonWebKey
  userPubKey: JsonWebKey
}

type IdentityHandshakeStepMessage = Record<string, unknown> & {
  n?: unknown
  dtls?: unknown
  uid?: unknown
  pk?: unknown
  uk?: unknown
  ps?: unknown
  us?: unknown
}

const parseAndVerifyPeerIdentityClaims = async (
  raw: unknown,
  expectedStep: 1 | 2,
  remotePeerId: string,
  expectedRemoteDtls: string[],
  localDtls: string[] = []
): Promise<
  [
    nonce: string,
    dtls: string[],
    userId: string,
    peerPubJwk: JsonWebKey,
    userPubJwk: JsonWebKey,
    ps: string | undefined,
    us: string | undefined
  ]
> => {
  if (!raw || typeof raw !== 'object') {
    throw peerIdentityErr
  }
  const msg = raw as IdentityHandshakeStepMessage
  if (
    msg[hsStepKey] !== expectedStep ||
    typeof msg.n !== 'string' ||
    msg.n.length < 16 ||
    !Array.isArray(msg.dtls) ||
    !isStr(msg.uid) ||
    !isObj(msg.pk) ||
    !isObj(msg.uk) ||
    (expectedStep === 2 &&
      (typeof msg.ps !== 'string' || typeof msg.us !== 'string'))
  ) {
    throw peerIdentityErr
  }

  const dtls = msg.dtls.filter((x): x is string => typeof x === 'string')
  if (
    (expectedRemoteDtls.length > 0 &&
      expectedRemoteDtls.join(',') !== dtls.join(',')) ||
    (localDtls.length > 0 && dtls.length === 0)
  ) {
    throw mkErr('DTLS fingerprint mismatch')
  }

  const peerPubJwk = msg.pk as JsonWebKey
  const userPubJwk = msg.uk as JsonWebKey
  const [peerOk, userOk] = await all([
    verifyPeerIdKey(remotePeerId, peerPubJwk),
    verifyUserIdKey(msg.uid, userPubJwk)
  ])
  if (!peerOk || !userOk) {
    throw peerIdentityErr
  }

  return [
    msg.n,
    dtls,
    msg.uid,
    peerPubJwk,
    userPubJwk,
    typeof msg.ps === 'string' ? msg.ps : undefined,
    typeof msg.us === 'string' ? msg.us : undefined
  ]
}

const verifyTranscriptDualSignatures = async (
  transcriptBytes: Uint8Array,
  peerSigB64: string,
  userSigB64: string,
  peerPubJwk: JsonWebKey,
  userPubJwk: JsonWebKey
): Promise<void> => {
  const [peerOk, userOk] = await all([
    verifyWithP256(fromBase64Url(peerSigB64), transcriptBytes, peerPubJwk),
    verifyWithP256(fromBase64Url(userSigB64), transcriptBytes, userPubJwk)
  ])
  if (!peerOk || !userOk) {
    throw peerIdentityErr
  }
}

export const initIdentityHandshake = (
  endpointIdentityP: Promise<EndpointIdentity> | undefined,
  appId: string,
  roomId: string | Promise<string>,
  getUserIdentity: () => Promise<UserIdentity>,
  getPeerHandle?: (peerId: string) => PeerHandle | undefined,
  onVerified?: (peerId: string, verified: VerifiedPeerIdentity) => void
): readonly [
  run: (
    peerId: string,
    send: HandshakeSender,
    receive: HandshakeReceiver,
    isInitiator: boolean
  ) => Promise<VerifiedPeerIdentity>,
  compose: (nextHandshake?: PeerHandshake) => PeerHandshake
] => {
  const localEndpointP =
    endpointIdentityP ?? getDefaultEndpointIdentity(undefined, appId)

  const signTranscript = async (
    transcriptBytes: Uint8Array,
    localUser: UserIdentity
  ): Promise<{ps: string; us: string}> => {
    const localEndpoint = await localEndpointP
    const [psBytes, usBytes] = await all([
      localEndpoint.sign(transcriptBytes),
      localUser.sign(transcriptBytes)
    ])
    return {
      ps: toBase64Url(psBytes),
      us: toBase64Url(new Uint8Array(usBytes))
    }
  }

  const encodeTranscript = (
    resolvedRoomId: string,
    initPeerId: string,
    respPeerId: string,
    initNonce: string,
    respNonce: string,
    initDtls: string[],
    respDtls: string[],
    initUid: string,
    respUid: string
  ): Uint8Array =>
    encodeBytes(
      toJson([
        hsDomain,
        appId,
        resolvedRoomId,
        initPeerId,
        respPeerId,
        initNonce,
        respNonce,
        initDtls,
        respDtls,
        initUid,
        respUid
      ])
    )

  const run = async (
    remotePeerId: string,
    send: HandshakeSender,
    receive: HandshakeReceiver,
    isInitiator: boolean
  ): Promise<VerifiedPeerIdentity> => {
    const [resolvedRoomId, localUser, localEndpoint] = await all([
      roomId,
      getUserIdentity(),
      localEndpointP
    ])
    const effectiveSelfId = localEndpoint.peerId
    const peer = getPeerHandle?.(remotePeerId)
    const localDtls = extractDtlsFingerprints(
      peer?.connection?.localDescription?.sdp
    )
    const remoteDtls = extractDtlsFingerprints(
      peer?.connection?.remoteDescription?.sdp
    )
    if (peer?.connection && (!localDtls.length || !remoteDtls.length)) {
      throw mkErr('DTLS fingerprint missing')
    }
    const sendClaims = (
      step: 1 | 2,
      n: string,
      extra?: Record<string, string>
    ): Promise<void> =>
      send({
        [hsStepKey]: step,
        n,
        dtls: localDtls,
        uid: localUser.userId,
        pk: localEndpoint.signPubJwk as unknown as JsonValue,
        uk: localUser.signPubJwk as unknown as JsonValue,
        ...extra
      })

    const verifyStep = (raw: unknown, step: 1 | 2) =>
      parseAndVerifyPeerIdentityClaims(
        raw,
        step,
        remotePeerId,
        remoteDtls,
        localDtls
      )
    const resolveRemoteDtls = (claimed: string[]): string[] =>
      remoteDtls.length > 0 ? remoteDtls : claimed
    const toVerified = (
      userId: string,
      peerPubKey: JsonWebKey,
      userPubKey: JsonWebKey
    ): VerifiedPeerIdentity => ({userId, peerPubKey, userPubKey})

    if (isInitiator) {
      const initNonce = crypto.randomUUID()
      await sendClaims(1, initNonce)

      const {data: step2} = await receive()
      const [rNonce, rDtls, rUid, rPeerPub, rUserPub, rPs, rUs] =
        await verifyStep(step2, 2)

      const transcriptBytes = encodeTranscript(
        resolvedRoomId,
        effectiveSelfId,
        remotePeerId,
        initNonce,
        rNonce,
        localDtls,
        resolveRemoteDtls(rDtls),
        localUser.userId,
        rUid
      )

      await verifyTranscriptDualSignatures(
        transcriptBytes,
        rPs!,
        rUs!,
        rPeerPub,
        rUserPub
      )

      const sigs = await signTranscript(transcriptBytes, localUser)
      const sendStep3 = (): Promise<void> => send({[hsStepKey]: 3, ...sigs})
      const verified = toVerified(rUid, rPeerPub, rUserPub)
      try {
        onVerified?.(remotePeerId, verified)
      } catch (err) {
        if (err instanceof Error && /peer banned/.test(err.message)) {
          await sendStep3()
        }
        throw err
      }

      await sendStep3()

      return verified
    }

    const {data: step1} = await receive()
    const [iNonce, iDtls, iUid, iPeerPub, iUserPub] = await verifyStep(step1, 1)

    const respNonce = crypto.randomUUID()
    const transcriptBytes = encodeTranscript(
      resolvedRoomId,
      remotePeerId,
      effectiveSelfId,
      iNonce,
      respNonce,
      resolveRemoteDtls(iDtls),
      localDtls,
      iUid,
      localUser.userId
    )

    const sigs = await signTranscript(transcriptBytes, localUser)

    await sendClaims(2, respNonce, sigs)

    const {data: step3} = await receive()
    if (!step3 || typeof step3 !== 'object') {
      throw peerIdentityErr
    }
    const msg3 = step3 as Record<string, unknown> & {
      ps?: unknown
      us?: unknown
    }
    if (
      msg3[hsStepKey] !== 3 ||
      typeof msg3.ps !== 'string' ||
      typeof msg3.us !== 'string'
    ) {
      throw peerIdentityErr
    }
    await verifyTranscriptDualSignatures(
      transcriptBytes,
      msg3.ps,
      msg3.us,
      iPeerPub,
      iUserPub
    )

    const verified = toVerified(iUid, iPeerPub, iUserPub)
    onVerified?.(remotePeerId, verified)
    return verified
  }

  return [
    run,
    (nextHandshake?: PeerHandshake): PeerHandshake =>
      async (peerId, send, receive, isInitiator): Promise<void> => {
        await nextHandshake?.(peerId, send, receive, isInitiator)
        await run(peerId, send, receive, isInitiator)
      }
  ]
}

export const createIdentityHandshake = (params: {
  endpointIdentityP?: Promise<EndpointIdentity>
  appId: string
  roomId: string | Promise<string>
  getUserIdentity: () => Promise<UserIdentity>
  getPeerHandle?: (peerId: string) => PeerHandle | undefined
  onVerified?: (peerId: string, verified: VerifiedPeerIdentity) => void
}) => {
  const [run, compose] = initIdentityHandshake(
    params.endpointIdentityP,
    params.appId,
    params.roomId,
    params.getUserIdentity,
    params.getPeerHandle,
    params.onVerified
  )
  return {run, compose}
}

type PendingPeerState = {
  p: PeerHandle
  a: boolean // isActive
  i: boolean // isInitiator
  c: boolean // didCompleteHandshakeSteps
  l: boolean // didLocalHandshakePass
  r: boolean // didReceiveRemoteReady
  q: boolean // isAcquiringAdmission
  t: ReturnType<typeof setTimeout> | null // handshakeTimer
  m: HandshakePayload[] // pendingHandshakePayloads
  w: Array<
    [resolve: (payload: HandshakePayload) => void, reject: (err: Error) => void]
  >
}

const toHandshakeErrorMessage = (error: Error): string => {
  const message = toErrorMessage(error, 'unknown error')

  return message.startsWith('handshake ')
    ? message
    : `handshake failed: ${message}`
}

/**
 * Internal positional handshake state machine used by `room-admission.ts`.
 * `beforeSendHandshakeReady` is an optional best-effort enrichment hook for
 * `@_hsready`; returning undefined, throwing, or rejecting degrades cleanly to
 * a plain `''` ready rather than failing the peer handshake.
 */
export const createHandshakeManager = (
  localSelfId: string | undefined,
  selfIdP: Promise<string> | undefined,
  onPeerHandshake: PeerHandshake | undefined,
  onHandshakeError:
    | ((peerId: string, error: string, cause?: Error) => void)
    | undefined,
  handshakeTimeoutMs: number,
  deferResponderReady: boolean,
  sendHandshakeData: (
    data: DataPayload,
    peerId: string,
    metadata?: JsonValue
  ) => Promise<void>,
  sendHandshakeReady: (
    data: HandshakeReadyPayload,
    peerId: string
  ) => Promise<void>,
  onLocalHandshakePassed: (peerId: string, peer: PeerHandle) => boolean,
  acquireAdmissionSlot: (
    peerId: string,
    peer: PeerHandle
  ) => boolean | Promise<boolean>,
  beforeSendHandshakeReady: (
    peerId: string,
    peer: PeerHandle
  ) => Promise<HandshakeReadyPayload | void> | undefined,
  onActivate: (peerId: string, peer: PeerHandle) => void,
  onFailure: (peerId: string, peer: PeerHandle, reason: Error) => void
): readonly [
  addPeer: (id: string, peer: PeerHandle) => void,
  clearPeer: (id: string, error: Error) => void,
  canReceiveFromPeer: (id: string, receiveWhilePending: boolean) => boolean,
  start: (id: string, peer: PeerHandle) => void,
  receiveHandshakeData: (
    data: DataPayload,
    id: string,
    metadata?: JsonValue
  ) => void,
  receiveHandshakeReady: (id: string) => void,
  hasNoPending: () => boolean,
  getPeer: (id: string) => PeerHandle | undefined
] => {
  const peerStates: Record<string, PendingPeerState> = {}

  const getPending = (
    id: string,
    peer?: PeerHandle
  ): PendingPeerState | undefined => {
    const state = peerStates[id]
    return state && (!peer || state.p === peer) && !state.a ? state : undefined
  }

  const maybeActivatePeer = (id: string, peer?: PeerHandle): void => {
    const state = getPending(id, peer)
    if (!state || !state.l || !state.r) {
      return
    }
    state.a = true
    state.t = resetTimer(state.t)
    onActivate(id, state.p)
  }

  const failPeerHandshake = (
    id: string,
    peer: PeerHandle,
    reason: Error
  ): void => {
    const state = peerStates[id]
    if (!state || state.p !== peer) {
      return
    }
    const error = toHandshakeErrorMessage(reason)
    onHandshakeError?.(id, error, reason)
    onFailure(id, peer, mkErr(error))
  }

  const sendLocalReady = (id: string, peer: PeerHandle): void => {
    if (!getPending(id, peer)) {
      return
    }

    const finishReady = (payload?: HandshakeReadyPayload | void): void => {
      const cur = getPending(id, peer)
      if (!cur) {
        return
      }
      cur.l = true
      void sendHandshakeReady(payload || '', id).catch(err =>
        failPeerHandshake(
          id,
          peer,
          mkErr(
            `handshake ready send failed: ${toErrorMessage(err, 'send failed')}`
          )
        )
      )
      maybeActivatePeer(id, peer)
    }

    let prep: Promise<HandshakeReadyPayload | void> | undefined
    try {
      prep = beforeSendHandshakeReady(id, peer)
    } catch {
      prep = undefined
    }

    if (prep) {
      void prep.then(finishReady, () => finishReady())
      return
    }

    finishReady()
  }

  const maybeProceedToSendReady = (id: string, peer: PeerHandle): void => {
    const state = getPending(id, peer)
    if (
      !state ||
      state.l ||
      state.q ||
      !state.c ||
      !onLocalHandshakePassed(id, peer) ||
      (deferResponderReady && !state.i && !state.r)
    ) {
      return
    }

    state.q = true
    const slotRes = acquireAdmissionSlot(id, peer)
    if (typeof slotRes === 'boolean') {
      state.q = false
      if (slotRes) {
        sendLocalReady(id, peer)
      }
      return
    }

    void slotRes.then(
      admitted => {
        const cur = getPending(id, peer)
        if (!cur) {
          return
        }
        cur.q = false
        if (admitted) {
          sendLocalReady(id, peer)
        }
      },
      err => failPeerHandshake(id, peer, toError(err, 'handshake failed'))
    )
  }

  return [
    (id, peer) => {
      peerStates[id] = {
        p: peer,
        a: false,
        i: true,
        c: false,
        l: false,
        r: false,
        q: false,
        t: null,
        m: [],
        w: []
      }
    },

    (id, error) => {
      const state = peerStates[id]

      if (!state) {
        return
      }

      state.t = resetTimer(state.t)
      state.m.length = 0
      state.w.splice(0).forEach(([, reject]) => reject(error))
      delete peerStates[id]
    },

    (id, receiveWhilePending) => {
      const state = peerStates[id]

      return Boolean(state && (state.a || receiveWhilePending))
    },

    (id, peer) => {
      const state = getPending(id, peer)
      if (!state) {
        return
      }

      state.t = setTimeout(
        () =>
          failPeerHandshake(
            id,
            peer,
            mkErr(`handshake timed out after ${handshakeTimeoutMs}ms`)
          ),
        handshakeTimeoutMs
      )

      const sendHandshake: HandshakeSender = async (data, metadata) => {
        if (peerStates[id]?.p !== peer) {
          throw handshakeDisconnectErr
        }
        await sendHandshakeData(data, id, metadata)
      }

      const receiveHandshake: HandshakeReceiver = () =>
        new Promise<HandshakePayload>((resolve, reject) => {
          const current = peerStates[id]
          if (!current || current.p !== peer) {
            reject(handshakeDisconnectErr)
            return
          }
          const payload = current.m.shift()
          if (payload) {
            resolve(payload)
          } else {
            current.w.push([resolve, reject])
          }
        })

      const resolvedSelfIdP =
        selfIdP ??
        (localSelfId ? Promise.resolve(localSelfId) : resolveSelfId())
      const runHandshake =
        onPeerHandshake || deferResponderReady
          ? resolvedSelfIdP.then(effectiveSelfId => {
              const isInitiator = effectiveSelfId < id
              const current = peerStates[id]
              if (current?.p === peer) {
                current.i = isInitiator
              }
              return onPeerHandshake?.(
                id,
                sendHandshake,
                receiveHandshake,
                isInitiator
              )
            })
          : Promise.resolve()

      void runHandshake
        .then(() => {
          const current = getPending(id, peer)
          if (current) {
            current.c = true
            maybeProceedToSendReady(id, peer)
          }
        })
        .catch(err =>
          failPeerHandshake(id, peer, toError(err, 'handshake failed'))
        )
    },

    (data, id, metadata) => {
      const state = getPending(id)
      if (!state) {
        return
      }
      const payload =
        metadata === undefined ? {data} : ({data, metadata} as HandshakePayload)
      const pending = state.w.shift()
      if (pending) {
        pending[0](payload)
      } else if (state.m.length >= 16) {
        failPeerHandshake(
          id,
          state.p,
          mkErr('too many pending handshake messages')
        )
      } else {
        state.m.push(payload)
      }
    },

    id => {
      const state = getPending(id)
      if (!state) {
        return
      }
      state.r = true
      if (deferResponderReady && !state.l) {
        maybeProceedToSendReady(id, state.p)
      }
      maybeActivatePeer(id)
    },

    () => !keys(peerStates).some(id => !peerStates[id]?.a),
    id => peerStates[id]?.p
  ]
}
