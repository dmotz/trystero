import {
  compactPubToJwk,
  type EndpointIdentity,
  jwkToCompactPub,
  verifyPeerIdKey,
  verifyUserIdKey,
  verifyWithP256
} from './identity'
import type {PeerHandle, Timeout} from './internal-types'
import {fromBase64Url, toBase64Url} from './primitives'
import type {DataPayload, JsonValue, UserIdentity} from './types'
import {
  all,
  domainTag,
  encodeBytes,
  isStr,
  libId,
  mkErr,
  peerBannedErr,
  resetTimer,
  toError,
  toErrorMessage,
  toJson,
  unreachable,
  unrefTimer
} from './utils'

const peerIdentityErr = /*@__PURE__*/ mkErr('peer identity verification failed')
const handshakeDisconnectErr = /*@__PURE__*/ mkErr(
  'peer disconnected during handshake'
)
const defaultHandshakeTimeoutMs = 10_000
const maxBufferedHandshakeMessages = 16
const hsStepKey = `__${libId}_id`
const hsDomain = /*@__PURE__*/ domainTag('id-hs', 2)

type HandshakePayload = {
  data: DataPayload
  metadata?: JsonValue
}

export type HandshakeSender = (
  data: DataPayload,
  metadata?: JsonValue
) => Promise<void>

export type HandshakeReceiver = () => Promise<HandshakePayload>

export type PeerHandshake = (
  peerId: string,
  send: HandshakeSender,
  receive: HandshakeReceiver,
  isInitiator: boolean,
  peer?: PeerHandle
) => Promise<void>

const extractDtlsFingerprints = (sdp?: string | null): string[] => {
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
    typeof msg.pk !== 'string' ||
    typeof msg.uk !== 'string' ||
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

  const peerPubJwk = compactPubToJwk(msg.pk)
  const userPubJwk = compactPubToJwk(msg.uk)
  if (!peerPubJwk || !userPubJwk) {
    throw peerIdentityErr
  }
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

export type IdentityHandshakeDeps = {
  endpointIdentityP: Promise<EndpointIdentity>
  appId: string
  roomId: string | Promise<string>
  getUserIdentity: () => Promise<UserIdentity>
  getPeerHandle?: ((peerId: string) => PeerHandle | undefined) | undefined
  onVerified?:
    | ((
        peerId: string,
        verified: VerifiedPeerIdentity,
        peer?: PeerHandle
      ) => void)
    | undefined
}

export const createIdentityHandshake = (deps: IdentityHandshakeDeps) => {
  const {endpointIdentityP, appId, roomId, getUserIdentity, onVerified} = deps

  const signTranscript = async (
    transcriptBytes: Uint8Array,
    localUser: UserIdentity
  ): Promise<{ps: string; us: string}> => {
    const localEndpoint = await endpointIdentityP
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
    isInitiator: boolean,
    peerHandle?: PeerHandle
  ): Promise<VerifiedPeerIdentity> => {
    const [resolvedRoomId, localUser, localEndpoint] = await all([
      roomId,
      getUserIdentity(),
      endpointIdentityP
    ])
    const effectiveSelfId = localEndpoint.peerId
    const peer = peerHandle ?? deps.getPeerHandle?.(remotePeerId)
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
        pk: jwkToCompactPub(localEndpoint.signPubJwk),
        uk: jwkToCompactPub(localUser.signPubJwk),
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
        onVerified?.(remotePeerId, verified, peer)
      } catch (err) {
        if (err === peerBannedErr) {
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
    onVerified?.(remotePeerId, verified, peer)
    return verified
  }

  return {run}
}

type HandshakeWaiter = readonly [
  resolve: (payload: HandshakePayload) => void,
  reject: (err: Error) => void
]

type HandshakeQueue = {
  readonly messages: HandshakePayload[]
  readonly waiters: HandshakeWaiter[]
}

type HandshakePeerEntry =
  | {
      readonly phase: 'added'
      readonly peer: PeerHandle
      readonly queue: HandshakeQueue
      readonly remoteReady: boolean
    }
  | {
      readonly phase: 'running-steps'
      readonly peer: PeerHandle
      readonly timer: Timeout
      readonly role: 'resolving' | 'initiator' | 'responder'
      readonly queue: HandshakeQueue
      readonly remoteReady: boolean
    }
  | {
      readonly phase: 'awaiting-remote-ready'
      readonly peer: PeerHandle
      readonly timer: Timeout
    }
  | {
      readonly phase: 'preparing-ready'
      readonly peer: PeerHandle
      readonly timer: Timeout
      readonly remoteReady: boolean
    }
  | {
      readonly phase: 'awaiting-peer-ready'
      readonly peer: PeerHandle
      readonly timer: Timeout
    }
  | {
      readonly phase: 'active'
      readonly peer: PeerHandle
    }

export type HandshakeManagerDeps = {
  selfIdP: Promise<string>
  onPeerHandshake: (
    peerId: string,
    send: HandshakeSender,
    receive: HandshakeReceiver,
    isInitiator: boolean,
    peer?: PeerHandle
  ) => Promise<unknown>
  onHandshakeError?: ((peerId: string, reason: Error) => void) | undefined
  deferResponderReady: boolean
  sendHandshakeData: (
    data: DataPayload,
    peerId: string,
    metadata?: JsonValue
  ) => Promise<void>
  sendHandshakeReady: (
    data: HandshakeReadyPayload,
    peerId: string
  ) => Promise<void>
  onLocalHandshakePassed: (peerId: string, peer: PeerHandle) => boolean
  acquireAdmissionSlot: (peerId: string, peer: PeerHandle) => boolean
  beforeSendHandshakeReady: (
    peerId: string,
    peer: PeerHandle
  ) => Promise<HandshakeReadyPayload | void> | undefined
  onActivate: (peerId: string, peer: PeerHandle) => void
  onFailure: (peerId: string, peer: PeerHandle, reason: Error) => void
}

export type HandshakeManager = {
  addPeer: (id: string, peer: PeerHandle) => void
  clearPeer: (id: string, error: Error) => void
  canReceiveFromPeer: (id: string, receiveWhilePending: boolean) => boolean
  start: (id: string, peer: PeerHandle) => void
  receiveData: (data: DataPayload, id: string, metadata?: JsonValue) => void
  receiveReady: (id: string) => void
  getPeer: (id: string) => PeerHandle | undefined
}

const clearQueue = (queue: HandshakeQueue, error: Error): void => {
  queue.messages.length = 0
  for (const [, reject] of queue.waiters.splice(0)) {
    reject(error)
  }
}

const clearEntryTimer = (entry: HandshakePeerEntry): void => {
  if ('timer' in entry) {
    resetTimer(entry.timer)
  }
}

export const createHandshakeManager = (
  deps: HandshakeManagerDeps
): HandshakeManager => {
  const {
    selfIdP,
    onPeerHandshake,
    onHandshakeError,
    deferResponderReady,
    sendHandshakeData,
    sendHandshakeReady,
    onLocalHandshakePassed,
    acquireAdmissionSlot,
    beforeSendHandshakeReady,
    onActivate,
    onFailure
  } = deps
  const peerStates = new Map<string, HandshakePeerEntry>()

  const getCurrentPending = (
    id: string,
    peer?: PeerHandle
  ): Exclude<HandshakePeerEntry, {phase: 'active'}> | undefined => {
    const entry = peerStates.get(id)
    if (!entry || entry.phase === 'active' || (peer && entry.peer !== peer)) {
      return undefined
    }
    return entry
  }

  const activatePeer = (id: string, entry: HandshakePeerEntry): void => {
    clearEntryTimer(entry)
    peerStates.set(id, {phase: 'active', peer: entry.peer})
    onActivate(id, entry.peer)
  }

  const failPeerHandshake = (
    id: string,
    peer: PeerHandle,
    reason: Error
  ): void => {
    const entry = peerStates.get(id)
    if (!entry || entry.peer !== peer) {
      return
    }
    clearEntryTimer(entry)
    onHandshakeError?.(id, reason)
    onFailure(id, peer, reason)
  }

  const beginPreparingReady = (
    id: string,
    peer: PeerHandle,
    timer: Timeout,
    remoteReady: boolean
  ): void => {
    // Admission re-validates ban and room capacity after async step completion.
    if (!acquireAdmissionSlot(id, peer)) {
      return
    }
    const current = getCurrentPending(id, peer)
    if (!current) {
      return
    }
    const nextRemoteReady =
      remoteReady ||
      current.phase === 'awaiting-remote-ready' ||
      ('remoteReady' in current && current.remoteReady)

    peerStates.set(id, {
      phase: 'preparing-ready',
      peer,
      timer,
      remoteReady: nextRemoteReady
    })

    const finishReady = (payload?: HandshakeReadyPayload | void): void => {
      const preparing = peerStates.get(id)
      if (
        !preparing ||
        preparing.phase !== 'preparing-ready' ||
        preparing.peer !== peer
      ) {
        return
      }
      const isRemoteReady = preparing.remoteReady
      if (isRemoteReady) {
        clearEntryTimer(preparing)
        peerStates.set(id, {phase: 'active', peer})
      } else {
        peerStates.set(id, {
          phase: 'awaiting-peer-ready',
          peer,
          timer: preparing.timer
        })
      }
      // Enqueue the ready frame before firing onActivate so synchronous sends
      // inside room.onPeerJoin land on the wire after the ready frame.
      void sendHandshakeReady(payload || '', id).catch(err =>
        failPeerHandshake(
          id,
          peer,
          mkErr(
            `handshake ready send failed: ${toErrorMessage(err, 'send failed')}`
          )
        )
      )
      if (isRemoteReady) {
        onActivate(id, peer)
      }
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

  const clearPeerInternal = (id: string, error: Error): void => {
    const entry = peerStates.get(id)
    if (!entry) {
      return
    }
    clearEntryTimer(entry)
    if ('queue' in entry) {
      clearQueue(entry.queue, error)
    }
    peerStates.delete(id)
  }

  return {
    addPeer: (id, peer) => {
      if (peerStates.has(id)) {
        clearPeerInternal(id, handshakeDisconnectErr)
      }
      peerStates.set(id, {
        phase: 'added',
        peer,
        queue: {messages: [], waiters: []},
        remoteReady: false
      })
    },

    clearPeer: clearPeerInternal,

    canReceiveFromPeer: (id, receiveWhilePending) => {
      const entry = peerStates.get(id)
      return Boolean(entry && (entry.phase === 'active' || receiveWhilePending))
    },

    start: (id, peer) => {
      const existing = peerStates.get(id)
      if (!existing || existing.phase !== 'added' || existing.peer !== peer) {
        return
      }

      const timer = setTimeout(
        () =>
          failPeerHandshake(
            id,
            peer,
            mkErr(`handshake timed out after ${defaultHandshakeTimeoutMs}ms`)
          ),
        defaultHandshakeTimeoutMs
      )
      unrefTimer(timer)

      peerStates.set(id, {
        phase: 'running-steps',
        peer,
        timer,
        role: 'resolving',
        queue: existing.queue,
        remoteReady: existing.remoteReady
      })

      const sendHandshake: HandshakeSender = async (data, metadata) => {
        if (peerStates.get(id)?.peer !== peer) {
          throw handshakeDisconnectErr
        }
        await sendHandshakeData(data, id, metadata)
      }

      const receiveHandshake: HandshakeReceiver = () =>
        new Promise<HandshakePayload>((resolve, reject) => {
          const current = peerStates.get(id)
          if (
            !current ||
            current.peer !== peer ||
            current.phase !== 'running-steps'
          ) {
            reject(handshakeDisconnectErr)
            return
          }
          const buffered = current.queue.messages.shift()
          if (buffered) {
            resolve(buffered)
            return
          }
          current.queue.waiters.push([resolve, reject])
        })

      void selfIdP
        .then(effectiveSelfId => {
          const isInitiator = effectiveSelfId < id
          const current = peerStates.get(id)
          if (current?.phase === 'running-steps' && current.peer === peer) {
            peerStates.set(id, {
              ...current,
              role: isInitiator ? 'initiator' : 'responder'
            })
          }
          return onPeerHandshake(
            id,
            sendHandshake,
            receiveHandshake,
            isInitiator,
            peer
          )
        })
        .then(() => {
          const current = peerStates.get(id)
          if (
            !current ||
            current.phase !== 'running-steps' ||
            current.peer !== peer
          ) {
            return
          }
          clearQueue(current.queue, handshakeDisconnectErr)
          if (!onLocalHandshakePassed(id, peer)) {
            return
          }
          const latest = peerStates.get(id)
          if (
            !latest ||
            latest.phase !== 'running-steps' ||
            latest.peer !== peer
          ) {
            return
          }
          if (
            deferResponderReady &&
            latest.role === 'responder' &&
            !latest.remoteReady
          ) {
            peerStates.set(id, {
              phase: 'awaiting-remote-ready',
              peer,
              timer: latest.timer
            })
            return
          }
          beginPreparingReady(id, peer, latest.timer, latest.remoteReady)
        })
        .catch(err =>
          failPeerHandshake(id, peer, toError(err, 'handshake failed'))
        )
    },

    receiveData: (data, id, metadata) => {
      const entry = peerStates.get(id)
      if (!entry || !('queue' in entry)) {
        return
      }
      const payload =
        metadata === undefined ? {data} : ({data, metadata} as HandshakePayload)

      const waiter = entry.queue.waiters.shift()
      if (waiter) {
        waiter[0](payload)
        return
      }
      if (entry.queue.messages.length >= maxBufferedHandshakeMessages) {
        failPeerHandshake(
          id,
          entry.peer,
          mkErr('too many pending handshake messages')
        )
        return
      }
      entry.queue.messages.push(payload)
    },

    receiveReady: id => {
      const entry = peerStates.get(id)
      if (!entry || entry.phase === 'active') {
        return
      }
      switch (entry.phase) {
        case 'added':
        case 'running-steps':
        case 'preparing-ready':
          peerStates.set(id, {...entry, remoteReady: true})
          return
        case 'awaiting-remote-ready':
          beginPreparingReady(id, entry.peer, entry.timer, true)
          return
        case 'awaiting-peer-ready':
          activatePeer(id, entry)
          return
        default:
          unreachable(entry)
      }
    },

    getPeer: id => peerStates.get(id)?.peer
  }
}
