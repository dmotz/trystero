import {
  createHandshakeManager,
  createIdentityHandshake,
  type HandshakeReadyPayload,
  type VerifiedPeerIdentity
} from './handshake'
import type {EndpointIdentity} from './identity'
import type {KernelRolesProvider, KernelScaleProvider} from './internal-types'
import type {PeerActivationResult, PeerRegistry} from './peer-registry'
import {isBanError} from './room-bootstrap'
import {jwkToCompactPub} from './state'
import type {
  DataPayload,
  JsonValue,
  KernelRoomErrorInput,
  PeerHandle,
  PeerHandshake,
  UserIdentity
} from './types'
import {
  noOp,
  peerBannedErr,
  peerBannedMsg,
  roomFullErr,
  roomFullMsg
} from './utils'

type RoomAdmissionDeps = {
  appId: string
  initialRoomId: string
  effectiveRoomIdP?: Promise<string> | undefined
  limit?: number | undefined
  verifyPeerIdentity: boolean
  runIdentityHandshake: boolean
  handshakeTimeoutMs: number
  onPeerHandshake?: PeerHandshake | undefined
  getSelfId: () => string
  selfIdP: Promise<string>
  endpointIdentityP: Promise<EndpointIdentity>
  getUserIdentity: () => Promise<UserIdentity>
  isLeaving: () => boolean
  peerRegistry: PeerRegistry
  isPeerBanned: (peerOrUserId: string) => boolean
  getBanReason: (peerOrUserId: string) => string | undefined
  getRolesProvider: () => KernelRolesProvider | null
  getScaleProvider: () => KernelScaleProvider | null
  prepareHandshakeReady: (
    peerId: string
  ) => Promise<HandshakeReadyPayload | void> | undefined
  stageHandshakeUserState: (
    peerId: string,
    data: Extract<HandshakeReadyPayload, {ok: true}>,
    done: () => void
  ) => Promise<void> | void
  clearStatePeer: (peerId: string) => void
  onStatePeerJoined: (peerId: string, userId: string, isDirect: boolean) => void
  sendHandshakeData: (
    data: DataPayload,
    peerId: string,
    metadata?: JsonValue
  ) => Promise<void>
  sendHandshakeReady: (
    data: HandshakeReadyPayload,
    peerId: string
  ) => Promise<void>
  sendSignal: (sdp: DataPayload, peerId: string) => Promise<void>
  emitRoomError: (error: KernelRoomErrorInput) => void
  emitPeerActivated: (peerId: string, peer: PeerHandle) => void
  emitActivatedEvents: (peerId: string, res: PeerActivationResult) => void
  kickPeer: (peerId: string, peer?: PeerHandle, reason?: Error) => void
  exitPeer: (peerId: string, peer?: PeerHandle, reason?: Error) => void
}

export type RoomAdmission = {
  isAlreadyFullForPeer: (peerId: string) => boolean
  releaseAdmissionSlot: (peerId: string) => void
  clearAllAdmission: (reason: Error) => void
  addPendingPeer: (peerId: string, peer: PeerHandle) => void
  startPeer: (peerId: string, peer: PeerHandle) => void
  clearPendingPeer: (peerId: string, reason: Error) => void
  canReceiveFromPeer: (peerId: string, receiveWhilePending: boolean) => boolean
  getPendingPeer: (peerId: string) => PeerHandle | undefined
  getPeerHandle: (peerId: string) => PeerHandle | undefined
  receiveHandshakeData: (
    data: DataPayload,
    peerId: string,
    metadata?: JsonValue
  ) => void
  receiveHandshakeReadyMessage: (
    data: HandshakeReadyPayload,
    peerId: string
  ) => void
  onPeerIdentityVerified: (
    peerId: string,
    verified: VerifiedPeerIdentity
  ) => void
}

export const createRoomAdmission = ({
  appId,
  initialRoomId,
  effectiveRoomIdP,
  limit,
  verifyPeerIdentity,
  runIdentityHandshake,
  handshakeTimeoutMs,
  onPeerHandshake,
  getSelfId,
  selfIdP,
  endpointIdentityP,
  getUserIdentity,
  isLeaving,
  peerRegistry,
  isPeerBanned,
  getBanReason,
  getRolesProvider,
  getScaleProvider,
  prepareHandshakeReady,
  stageHandshakeUserState,
  clearStatePeer,
  onStatePeerJoined,
  sendHandshakeData,
  sendHandshakeReady,
  sendSignal,
  emitRoomError,
  emitPeerActivated,
  emitActivatedEvents,
  kickPeer,
  exitPeer
}: RoomAdmissionDeps): RoomAdmission => {
  const reservedAdmissionUsers = new Map<string, string>()
  const admissionWaiters = new Map<
    string,
    {peer: PeerHandle; resolve: (ok: boolean) => void}
  >()
  let didReportRoomFull = false
  let pendingRoomFullPeerId: string | null = null

  const getAdmittedOrReservedUsers = (excludePeerId?: string): Set<string> => {
    const users = peerRegistry.getActiveUniqueUsers()
    for (const [pid, uid] of reservedAdmissionUsers.entries()) {
      if (pid !== excludePeerId) {
        users.add(uid)
      }
    }
    return users
  }

  const isConfirmedFullForPeer = (id: string): boolean => {
    if (limit === undefined || peerRegistry.isRoomActive(id)) {
      return false
    }
    const activeUsers = peerRegistry.getActiveUniqueUsers()
    return (
      !activeUsers.has(peerRegistry.getPeerUserId(id)) &&
      activeUsers.size >= limit
    )
  }

  const isAlreadyFullForPeer = (id: string): boolean => {
    if (limit === undefined || peerRegistry.isRoomActive(id)) {
      return false
    }
    const allUsers = getAdmittedOrReservedUsers(id)
    return (
      !allUsers.has(peerRegistry.getPeerUserId(id)) && allUsers.size >= limit
    )
  }

  const flushPendingRoomFullIfSettled = (): void => {
    if (!pendingRoomFullPeerId || didReportRoomFull || isLeaving()) {
      return
    }
    if (
      peerRegistry.getPeerIds(false).length > 0 &&
      isConfirmedFullForPeer(pendingRoomFullPeerId)
    ) {
      pendingRoomFullPeerId = null
      return
    }
    if (handshakeManager.getPendingIds().length === 0) {
      const rejectedBy = pendingRoomFullPeerId
      pendingRoomFullPeerId = null
      didReportRoomFull = true
      emitRoomError({
        code: 'room-full',
        peerId: rejectedBy,
        message: roomFullMsg
      })
    }
  }

  const rejectPeer = (
    id: string,
    peer: PeerHandle,
    err: typeof roomFullMsg | typeof peerBannedMsg
  ): void => {
    if (peerRegistry.getDirectPeer(id, true) !== peer) {
      return
    }
    const errObj = err === peerBannedMsg ? peerBannedErr : roomFullErr
    if (err === peerBannedMsg) {
      getScaleProvider()?.markPeerBanned(id)
    }
    const banReason =
      err === peerBannedMsg
        ? (getBanReason(peerRegistry.getPeerUserId(id)) ?? getBanReason(id))
        : undefined
    handshakeManager.clearPeer(id, errObj)
    clearStatePeer(id)
    releaseAdmissionSlot(id)
    void sendHandshakeReady(
      {
        ok: false,
        err,
        ...(banReason !== undefined ? {reason: banReason} : {})
      },
      id
    )
      .catch(noOp)
      .finally(() => {
        const closeNow = (): void => {
          peerRegistry.clearRejectTimer(id)
          if (peerRegistry.getDirectPeer(id, true) !== peer) {
            return
          }
          if (err === peerBannedMsg) {
            kickPeer(id, peer, errObj)
          } else {
            exitPeer(id, peer, errObj)
          }
        }
        if (!verifyPeerIdentity || isLeaving()) {
          closeNow()
          return
        }
        const timer = setTimeout(closeNow, 40)
        ;(timer as {unref?: () => void}).unref?.()
        peerRegistry.setRejectTimer(id, timer)
      })
  }

  const drainAdmissionWaiters = (): void => {
    if (admissionWaiters.size === 0) {
      return
    }
    for (const [id, waiter] of admissionWaiters) {
      if (
        isLeaving() ||
        handshakeManager.getPeer(id) !== waiter.peer ||
        peerRegistry.getDirectPeer(id, true) !== waiter.peer
      ) {
        admissionWaiters.delete(id)
        waiter.resolve(false)
        continue
      }
      if (isPeerBanned(id)) {
        admissionWaiters.delete(id)
        rejectPeer(id, waiter.peer, peerBannedMsg)
        waiter.resolve(false)
        continue
      }
      if (limit === undefined || peerRegistry.isRoomActive(id)) {
        admissionWaiters.delete(id)
        waiter.resolve(true)
        continue
      }
      if (isConfirmedFullForPeer(id)) {
        admissionWaiters.delete(id)
        rejectPeer(id, waiter.peer, roomFullMsg)
        waiter.resolve(false)
        continue
      }
      const uid = peerRegistry.getPeerUserId(id)
      const allUsers = getAdmittedOrReservedUsers(id)
      if (allUsers.has(uid) || allUsers.size < limit) {
        admissionWaiters.delete(id)
        reservedAdmissionUsers.set(id, uid)
        waiter.resolve(true)
        continue
      }
    }
  }

  const releaseAdmissionSlot = (id: string): void => {
    const hadReserved = reservedAdmissionUsers.delete(id)
    const waiter = admissionWaiters.get(id)
    if (waiter) {
      admissionWaiters.delete(id)
      waiter.resolve(false)
    }
    if (hadReserved || admissionWaiters.size > 0) {
      drainAdmissionWaiters()
    }
    flushPendingRoomFullIfSettled()
  }

  const acquireAdmissionSlot = (
    id: string,
    peer: PeerHandle
  ): boolean | Promise<boolean> => {
    if (peerRegistry.getDirectPeer(id, true) !== peer || isLeaving()) {
      return false
    }
    if (isPeerBanned(id)) {
      rejectPeer(id, peer, peerBannedMsg)
      return false
    }
    if (limit === undefined || peerRegistry.isRoomActive(id)) {
      return true
    }
    if (isConfirmedFullForPeer(id)) {
      rejectPeer(id, peer, roomFullMsg)
      return false
    }
    const uid = peerRegistry.getPeerUserId(id)
    const allUsers = getAdmittedOrReservedUsers(id)
    if (allUsers.has(uid) || allUsers.size < limit) {
      reservedAdmissionUsers.set(id, uid)
      return true
    }
    return new Promise<boolean>(resolve => {
      const prev = admissionWaiters.get(id)
      if (prev) {
        admissionWaiters.delete(id)
        prev.resolve(false)
      }
      admissionWaiters.set(id, {peer, resolve})
    })
  }

  const reportHandshakeError = (
    peerId: string,
    error: string,
    cause?: Error
  ): void => {
    const cleanMsg = error.replace(/^handshake failed: /, '')
    if (isBanError(cleanMsg) || isBanError(cause) || isPeerBanned(peerId)) {
      return
    }
    emitRoomError({
      code: 'handshake-failed',
      peerId,
      message: cleanMsg,
      ...(cause !== undefined ? {cause} : {})
    })
  }

  const deliverHandshakeReady = (
    data: HandshakeReadyPayload,
    id: string
  ): void => {
    if (data && typeof data === 'object' && data.ok === true) {
      if (!isPeerBanned(id) && !isConfirmedFullForPeer(id)) {
        void stageHandshakeUserState(id, data, () => {
          if (!isLeaving() && handshakeManager.getPeer(id)) {
            processHandshakeReady('', id)
          }
        })
        return
      }
      processHandshakeReady('', id)
      return
    }
    processHandshakeReady(data, id)
  }

  const onPeerIdentityVerified = (
    peerId: string,
    verified: VerifiedPeerIdentity
  ): void => {
    peerRegistry.setPeerUserId(peerId, verified.userId)
    if (isPeerBanned(peerId) || isPeerBanned(verified.userId)) {
      getScaleProvider()?.markPeerBanned(peerId)
      throw peerBannedErr
    }
    peerRegistry.setVerifiedIdentity(
      peerId,
      verified.userId,
      verified.peerPubKey,
      jwkToCompactPub(verified.userPubKey)
    )
    getScaleProvider()?.setPeerSignPublicKey(peerId, verified.peerPubKey)
    getRolesProvider()?.registerPeerPublicKey(peerId, verified.userPubKey)
    const readyPayload = peerRegistry.takeDeferredReady(peerId)
    if (readyPayload !== undefined) {
      queueMicrotask(() => {
        if (peerRegistry.isVerified(peerId)) {
          deliverHandshakeReady(readyPayload, peerId)
        }
      })
    }
  }

  const getPeerHandle = (peerId: string): PeerHandle | undefined =>
    handshakeManager.getPeer(peerId) ?? peerRegistry.getDirectPeer(peerId, true)

  const effectivePeerHandshake = runIdentityHandshake
    ? createIdentityHandshake({
        endpointIdentityP,
        appId,
        roomId: effectiveRoomIdP ?? initialRoomId,
        getUserIdentity,
        getPeerHandle,
        onVerified: onPeerIdentityVerified
      }).compose(onPeerHandshake)
    : onPeerHandshake

  const handshakeManager = createHandshakeManager({
    selfId: getSelfId(),
    selfIdP,
    ...(effectivePeerHandshake === undefined
      ? {}
      : {onPeerHandshake: effectivePeerHandshake}),
    onHandshakeError: reportHandshakeError,
    handshakeTimeoutMs,
    deferResponderReady: limit !== undefined,
    sendHandshakeData,
    sendHandshakeReady,
    onLocalHandshakePassed: (id, peer) => {
      if (isPeerBanned(id)) {
        rejectPeer(id, peer, peerBannedMsg)
        return false
      }
      if (isConfirmedFullForPeer(id)) {
        rejectPeer(id, peer, roomFullMsg)
        return false
      }
      return true
    },
    acquireAdmissionSlot,
    beforeSendHandshakeReady: (id, peer) =>
      peerRegistry.getDirectPeer(id, true) === peer && !isPeerBanned(id)
        ? prepareHandshakeReady(id)
        : undefined,
    onActivate: (id, peer) => {
      if (isPeerBanned(id)) {
        releaseAdmissionSlot(id)
        kickPeer(id, peer, peerBannedErr)
        return
      }
      if (isConfirmedFullForPeer(id)) {
        rejectPeer(id, peer, roomFullMsg)
        return
      }
      const res = peerRegistry.activateDirect(id, peer)
      reservedAdmissionUsers.delete(id)
      if (!res) {
        drainAdmissionWaiters()
        flushPendingRoomFullIfSettled()
        return
      }
      getScaleProvider()?.addDirectPeer(id, peer)
      emitPeerActivated(id, peer)
      drainAdmissionWaiters()
      flushPendingRoomFullIfSettled()
      peer.setHandlers({
        signal: sdp => {
          if (peerRegistry.getDirectPeer(id, false) === peer) {
            void sendSignal(sdp as unknown as DataPayload, id).catch(noOp)
          }
        }
      })
      if (res.becameRoomActive) {
        emitActivatedEvents(id, res)
      } else {
        onStatePeerJoined(id, res.userId, true)
      }
    },
    onFailure: (id, peer, reason) => {
      releaseAdmissionSlot(id)
      if (isBanError(reason)) {
        rejectPeer(id, peer, peerBannedMsg)
        return
      }
      kickPeer(id, peer, reason)
    }
  })

  const processHandshakeReady = (
    data: HandshakeReadyPayload,
    id: string
  ): void => {
    if (isLeaving()) {
      return
    }
    if (data && typeof data === 'object' && data.ok === false) {
      if (data.err === roomFullMsg) {
        if (!handshakeManager.getPeer(id) || peerRegistry.isDirectActive(id)) {
          return
        }
        handshakeManager.clearPeer(id, roomFullErr)
        if (
          !didReportRoomFull &&
          !(
            peerRegistry.getPeerIds(false).length > 0 &&
            isConfirmedFullForPeer(id)
          )
        ) {
          pendingRoomFullPeerId ??= id
        }
        exitPeer(id, peerRegistry.getDirectPeer(id, true), roomFullErr)
        releaseAdmissionSlot(id)
        return
      }
      if (data.err === peerBannedMsg) {
        if (!handshakeManager.getPeer(id) || peerRegistry.isDirectActive(id)) {
          return
        }
        const reason =
          typeof data.reason === 'string' && data.reason.length <= 512
            ? data.reason
            : undefined
        const msg = reason ? `${peerBannedMsg}: ${reason}` : peerBannedMsg
        handshakeManager.clearPeer(id, peerBannedErr)
        releaseAdmissionSlot(id)
        emitRoomError({
          code: 'banned',
          peerId: id,
          ...(reason !== undefined ? {reason} : {}),
          message: msg
        })
        kickPeer(id, peerRegistry.getDirectPeer(id, true), peerBannedErr)
        return
      }
    }
    handshakeManager.receiveHandshakeReady(id)
  }

  return {
    isAlreadyFullForPeer,
    releaseAdmissionSlot,
    clearAllAdmission: reason => {
      reservedAdmissionUsers.clear()
      for (const waiter of admissionWaiters.values()) {
        waiter.resolve(false)
      }
      admissionWaiters.clear()
      pendingRoomFullPeerId = null
      for (const id of peerRegistry.getPeerIds(true)) {
        handshakeManager.clearPeer(id, reason)
      }
    },
    addPendingPeer: (id, peer) => {
      handshakeManager.addPeer(id, peer)
    },
    startPeer: (id, peer) => {
      handshakeManager.start(id, peer)
    },
    clearPendingPeer: (id, reason) => {
      handshakeManager.clearPeer(id, reason)
      releaseAdmissionSlot(id)
    },
    canReceiveFromPeer: (id, receiveWhilePending) =>
      handshakeManager.canReceiveFromPeer(id, receiveWhilePending),
    getPendingPeer: id => handshakeManager.getPeer(id),
    getPeerHandle,
    receiveHandshakeData: (data, id, metadata) => {
      if (!isLeaving()) {
        handshakeManager.receiveHandshakeData(data, id, metadata)
      }
    },
    receiveHandshakeReadyMessage: (data, id) => {
      if (isLeaving()) {
        return
      }
      if (verifyPeerIdentity && !peerRegistry.isVerified(id)) {
        if (handshakeManager.getPeer(id) && !peerRegistry.isDirectActive(id)) {
          peerRegistry.setDeferredReady(id, data)
        }
        return
      }
      deliverHandshakeReady(data, id)
    },
    onPeerIdentityVerified
  }
}
