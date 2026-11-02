import type {HandshakeReadyPayload} from './handshake'
import {resetTimer} from './utils'
import type {PeerHandle, TargetPeers} from './types'

export type ActionFrameKind = 'inline' | 'offer' | 'chunk' | 'control'

export type PeerDataTransport = {
  readonly isOpen: boolean
  readonly bufferedAmount: number
  sendFrame: (
    bytes: Uint8Array,
    meta?: {transferId?: number; kind?: ActionFrameKind}
  ) => void
  waitForDrain: (signal?: AbortSignal) => boolean | Promise<boolean>
  close?: () => void
}

const buffLowEvent = 'bufferedamountlow'
const channelCloseEvent = 'close'
const channelErrorEvent = 'error'
const backpressureWaitTimeoutMs = 10_000

export const waitForBufferedAmountLow = (
  channel: RTCDataChannel,
  signal?: AbortSignal,
  timeoutMs: number = backpressureWaitTimeoutMs
): boolean | Promise<boolean> => {
  if (signal?.aborted) {
    return false
  }
  if (
    channel.readyState !== 'open' ||
    channel.bufferedAmount <= channel.bufferedAmountLowThreshold
  ) {
    return channel.readyState === 'open'
  }

  return new Promise<boolean>(res => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null

    const finish = (didDrain: boolean): void => {
      if (settled) {
        return
      }

      settled = true
      channel.removeEventListener(buffLowEvent, onBufferLow)
      channel.removeEventListener(channelCloseEvent, onCloseOrError)
      channel.removeEventListener(channelErrorEvent, onCloseOrError)
      signal?.removeEventListener('abort', onCloseOrError)

      resetTimer(timeout)
      res(didDrain)
    }

    const onBufferLow = (): void => finish(true)
    const onCloseOrError = (): void => finish(false)

    channel.addEventListener(buffLowEvent, onBufferLow)
    channel.addEventListener(channelCloseEvent, onCloseOrError)
    channel.addEventListener(channelErrorEvent, onCloseOrError)
    signal?.addEventListener('abort', onCloseOrError, {once: true})

    timeout = setTimeout(() => finish(false), timeoutMs)
    ;(timeout as {unref?: () => void}).unref?.()

    if (channel.readyState !== 'open' || signal?.aborted) {
      finish(false)
      return
    }

    if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) {
      finish(true)
    }
  })
}

export const createDirectPeerTransport = (
  peer: PeerHandle,
  isCurrent?: () => boolean
): PeerDataTransport => ({
  get isOpen(): boolean {
    return (
      (!isCurrent || isCurrent()) &&
      !peer.isDead &&
      peer.channel?.readyState !== 'closed'
    )
  },
  get bufferedAmount(): number {
    return typeof peer.channel?.bufferedAmount === 'number'
      ? peer.channel.bufferedAmount
      : 0
  },
  sendFrame: bytes => {
    peer.sendData(bytes)
  },
  waitForDrain: signal => {
    if (signal?.aborted || (isCurrent && !isCurrent()) || peer.isDead) {
      return false
    }
    if (!peer.channel) {
      return true
    }
    return waitForBufferedAmountLow(peer.channel, signal)
  },
  close: () => peer.destroy()
})

type DirectSession = {
  peer: PeerHandle
  transport: PeerDataTransport
  active: boolean
  rejectTimer: ReturnType<typeof setTimeout> | null
}

type PeerEntry = {
  direct: DirectSession | null
  virtual: PeerDataTransport | null
  registeredInUserSet: string | null
  userId?: string
  pubKey?: JsonWebKey
  userPubCompact?: string
  verified: boolean
  deferredReady?: HandshakeReadyPayload
}

export type PeerActivationResult = {
  becameRoomActive: boolean
  isFirstForUser: boolean
  userId: string
}

export type PeerDeactivationResult = {
  wasRoomActive: boolean
  isLastForUser: boolean
  userId: string
  directPeer?: PeerHandle
  virtualTransport?: PeerDataTransport
}

export type PeerRegistry = {
  getPeerUserId: (peerId: string) => string
  getKnownPeerUserId: (peerId: string) => string | undefined
  setPeerUserId: (peerId: string, userId: string) => void
  hasKnownUserId: (peerId: string) => boolean
  getPeerPubKey: (peerId: string) => JsonWebKey | undefined
  setPeerPubKey: (peerId: string, pubKey: JsonWebKey) => void
  getPubKeyEntries: () => [string, JsonWebKey][]
  getVerifiedUserPub: (peerId: string) => string | undefined
  isVerified: (peerId: string) => boolean
  setVerifiedIdentity: (
    peerId: string,
    userId: string,
    peerPubKey: JsonWebKey,
    userPubCompact: string
  ) => void
  clearDirectHandshakeState: (peerId: string) => void
  setDeferredReady: (peerId: string, payload: HandshakeReadyPayload) => void
  takeDeferredReady: (peerId: string) => HandshakeReadyPayload | undefined
  setRejectTimer: (peerId: string, timer: ReturnType<typeof setTimeout>) => void
  clearRejectTimer: (peerId: string) => void
  isDirectActive: (peerId: string) => boolean
  isVirtualActive: (peerId: string) => boolean
  hasVirtual: (peerId: string) => boolean
  isRoomActive: (peerId: string) => boolean
  hasAnyPeer: (peerId: string) => boolean
  getDirectPeer: (
    peerId: string,
    includePending?: boolean
  ) => PeerHandle | undefined
  getTransport: (
    peerId: string,
    includePending?: boolean
  ) => PeerDataTransport | undefined
  getPeerIds: (includePending?: boolean) => string[]
  getDirectPeerIds: (activeOnly?: boolean) => string[]
  getDirectPeerEntries: (activeOnly?: boolean) => [string, PeerHandle][]
  getUserPeerIds: (userId: string) => string[]
  isUserOnline: (uid: string) => boolean
  getActiveUserEntries: () => IterableIterator<[string, Set<string>]>
  getActiveUniqueUsers: () => Set<string>
  resolveSendTarget: (
    targets: TargetPeers,
    includePending?: boolean
  ) => TargetPeers
  resolveRequestTarget: (
    target: string,
    includePending?: boolean
  ) => string | undefined
  addPendingDirect: (peerId: string, peer: PeerHandle) => void
  activateDirect: (
    peerId: string,
    peer: PeerHandle
  ) => PeerActivationResult | null
  activateVirtual: (
    peerId: string,
    transport: PeerDataTransport
  ) => PeerActivationResult
  deactivateVirtual: (peerId: string) => PeerDeactivationResult
  removePendingDirectOnly: (peerId: string, peer: PeerHandle) => boolean
  removePeer: (peerId: string) => PeerDeactivationResult
  clearAll: () => PeerHandle[]
}

export const createPeerRegistry = ({
  getSelfId,
  getLocalUserId
}: {
  getSelfId: () => string
  getLocalUserId: () => string
}): PeerRegistry => {
  const entries = new Map<string, PeerEntry>()
  const activeUserPeers = new Map<string, Set<string>>()

  const ensureEntry = (peerId: string): PeerEntry => {
    let entry = entries.get(peerId)
    if (!entry) {
      entry = {
        direct: null,
        virtual: null,
        registeredInUserSet: null,
        verified: false
      }
      entries.set(peerId, entry)
    }
    return entry
  }

  const pruneIfEmpty = (peerId: string, entry: PeerEntry): void => {
    if (
      !entry.direct &&
      !entry.virtual &&
      !entry.userId &&
      !entry.pubKey &&
      !entry.verified &&
      entry.deferredReady === undefined
    ) {
      entries.delete(peerId)
    }
  }

  const getPeerUserId = (peerId: string): string =>
    peerId === getSelfId()
      ? getLocalUserId()
      : (entries.get(peerId)?.userId ?? peerId)

  const getKnownPeerUserId = (peerId: string): string | undefined =>
    peerId === getSelfId() ? getLocalUserId() : entries.get(peerId)?.userId

  const addPeerToUserSet = (
    peerId: string,
    entry: PeerEntry
  ): {userId: string; isFirstForUser: boolean} => {
    const userId = entry.userId ?? peerId
    entry.userId = userId
    if (entry.registeredInUserSet && entry.registeredInUserSet !== userId) {
      const prevSet = activeUserPeers.get(entry.registeredInUserSet)
      if (prevSet) {
        prevSet.delete(peerId)
        if (prevSet.size === 0) {
          activeUserPeers.delete(entry.registeredInUserSet)
        }
      }
    }
    let set = activeUserPeers.get(userId)
    const isFirstForUser = !set || set.size === 0
    if (!set) {
      set = new Set<string>()
      activeUserPeers.set(userId, set)
    }
    set.add(peerId)
    entry.registeredInUserSet = userId
    return {userId, isFirstForUser}
  }

  const removePeerFromUserSet = (
    peerId: string,
    entry: PeerEntry
  ): {userId: string; isLastForUser: boolean} => {
    const userId = entry.registeredInUserSet ?? entry.userId ?? peerId
    let isLastForUser = false
    if (entry.registeredInUserSet) {
      const set = activeUserPeers.get(entry.registeredInUserSet)
      if (set) {
        set.delete(peerId)
        if (set.size === 0) {
          activeUserPeers.delete(entry.registeredInUserSet)
          isLastForUser = true
        }
      }
      entry.registeredInUserSet = null
    }
    return {userId, isLastForUser}
  }

  const isRoomActiveEntry = (entry: PeerEntry | undefined): boolean =>
    Boolean(entry && (entry.direct?.active || entry.virtual))

  const hasAnySessionEntry = (entry: PeerEntry | undefined): boolean =>
    Boolean(entry && (entry.direct || entry.virtual))

  const clearDirectRejectTimer = (session: DirectSession | null): void => {
    if (session?.rejectTimer) {
      clearTimeout(session.rejectTimer)
      session.rejectTimer = null
    }
  }

  return {
    getPeerUserId,
    getKnownPeerUserId,

    setPeerUserId: (peerId: string, userId: string): void => {
      if (!userId) {
        return
      }
      const entry = ensureEntry(peerId)
      entry.userId = userId
      if (isRoomActiveEntry(entry) && entry.registeredInUserSet !== userId) {
        addPeerToUserSet(peerId, entry)
      }
    },

    hasKnownUserId: (peerId: string): boolean =>
      entries.get(peerId)?.userId !== undefined,

    getPeerPubKey: (peerId: string): JsonWebKey | undefined =>
      entries.get(peerId)?.pubKey,

    setPeerPubKey: (peerId: string, pubKey: JsonWebKey): void => {
      ensureEntry(peerId).pubKey = pubKey
    },

    getPubKeyEntries: (): [string, JsonWebKey][] => {
      const list: [string, JsonWebKey][] = []
      for (const [id, entry] of entries.entries()) {
        if (entry.pubKey) {
          list.push([id, entry.pubKey])
        }
      }
      return list
    },

    getVerifiedUserPub: (peerId: string): string | undefined => {
      const e = entries.get(peerId)
      return e?.verified ? e.userPubCompact : undefined
    },

    isVerified: (peerId: string): boolean =>
      Boolean(entries.get(peerId)?.verified),

    setVerifiedIdentity: (
      peerId: string,
      userId: string,
      peerPubKey: JsonWebKey,
      userPubCompact: string
    ): void => {
      const entry = ensureEntry(peerId)
      entry.userId = userId
      entry.pubKey = peerPubKey
      entry.userPubCompact = userPubCompact
      entry.verified = true
      if (isRoomActiveEntry(entry) && entry.registeredInUserSet !== userId) {
        addPeerToUserSet(peerId, entry)
      }
    },

    clearDirectHandshakeState: (peerId: string): void => {
      const entry = entries.get(peerId)
      if (!entry) {
        return
      }
      entry.verified = false
      delete entry.userPubCompact
      delete entry.deferredReady
      pruneIfEmpty(peerId, entry)
    },

    setDeferredReady: (
      peerId: string,
      payload: HandshakeReadyPayload
    ): void => {
      ensureEntry(peerId).deferredReady = payload
    },

    takeDeferredReady: (peerId: string): HandshakeReadyPayload | undefined => {
      const entry = entries.get(peerId)
      if (!entry || entry.deferredReady === undefined) {
        return undefined
      }
      const payload = entry.deferredReady
      delete entry.deferredReady
      return payload
    },

    setRejectTimer: (
      peerId: string,
      timer: ReturnType<typeof setTimeout>
    ): void => {
      const direct = entries.get(peerId)?.direct
      if (direct) {
        clearDirectRejectTimer(direct)
        direct.rejectTimer = timer
      }
    },

    clearRejectTimer: (peerId: string): void => {
      clearDirectRejectTimer(entries.get(peerId)?.direct ?? null)
    },

    isDirectActive: (peerId: string): boolean =>
      Boolean(entries.get(peerId)?.direct?.active),

    isVirtualActive: (peerId: string): boolean => {
      const e = entries.get(peerId)
      return Boolean(e?.virtual && !e.direct?.active)
    },

    hasVirtual: (peerId: string): boolean =>
      Boolean(entries.get(peerId)?.virtual),

    isRoomActive: (peerId: string): boolean =>
      isRoomActiveEntry(entries.get(peerId)),

    hasAnyPeer: (peerId: string): boolean =>
      hasAnySessionEntry(entries.get(peerId)),

    getDirectPeer: (
      peerId: string,
      includePending = false
    ): PeerHandle | undefined => {
      const direct = entries.get(peerId)?.direct
      if (!direct) {
        return undefined
      }
      return includePending || direct.active ? direct.peer : undefined
    },

    getTransport: (
      peerId: string,
      includePending = false
    ): PeerDataTransport | undefined => {
      const entry = entries.get(peerId)
      if (!entry) {
        return undefined
      }
      if (includePending) {
        return entry.direct?.transport ?? entry.virtual ?? undefined
      }
      return (
        (entry.direct?.active ? entry.direct.transport : undefined) ??
        entry.virtual ??
        undefined
      )
    },

    getPeerIds: (includePending = false): string[] => {
      const ids: string[] = []
      for (const [id, entry] of entries.entries()) {
        if (
          includePending ? hasAnySessionEntry(entry) : isRoomActiveEntry(entry)
        ) {
          ids.push(id)
        }
      }
      return ids
    },

    getDirectPeerIds: (activeOnly = true): string[] => {
      const ids: string[] = []
      for (const [id, entry] of entries.entries()) {
        if (entry.direct && (!activeOnly || entry.direct.active)) {
          ids.push(id)
        }
      }
      return ids
    },

    getDirectPeerEntries: (activeOnly = true): [string, PeerHandle][] => {
      const list: [string, PeerHandle][] = []
      for (const [id, entry] of entries.entries()) {
        if (entry.direct && (!activeOnly || entry.direct.active)) {
          list.push([id, entry.direct.peer])
        }
      }
      return list
    },

    getUserPeerIds: (userId: string): string[] => {
      const set = activeUserPeers.get(userId)
      if (set && set.size > 0) {
        return [...set]
      }
      const matching: string[] = []
      for (const [pid, entry] of entries.entries()) {
        if (hasAnySessionEntry(entry) && getPeerUserId(pid) === userId) {
          matching.push(pid)
        }
      }
      return matching
    },

    isUserOnline: (uid: string): boolean => {
      const localUid = getLocalUserId()
      return Boolean(
        (localUid && uid === localUid) ||
        (activeUserPeers.get(uid)?.size ?? 0) > 0
      )
    },

    getActiveUserEntries: (): IterableIterator<[string, Set<string>]> =>
      activeUserPeers.entries(),

    getActiveUniqueUsers: (): Set<string> => {
      const users = new Set<string>([getLocalUserId()])
      for (const [pid, entry] of entries.entries()) {
        if (isRoomActiveEntry(entry)) {
          users.add(getPeerUserId(pid))
        }
      }
      return users
    },

    resolveSendTarget: (
      targets: TargetPeers,
      includePending = false
    ): TargetPeers => {
      if (!targets) {
        return undefined
      }
      const hasPeer = (id: string): boolean => {
        const e = entries.get(id)
        return includePending ? hasAnySessionEntry(e) : isRoomActiveEntry(e)
      }
      const list = Array.isArray(targets) ? targets : [targets]
      const resolved: string[] = []
      const seen = new Set<string>()
      const addPeer = (pid: string): void => {
        if (!seen.has(pid)) {
          seen.add(pid)
          resolved.push(pid)
        }
      }

      for (const id of list) {
        if (hasPeer(id)) {
          addPeer(id)
          continue
        }
        const userPeers = activeUserPeers.get(id)
        if (userPeers && userPeers.size > 0) {
          for (const pid of userPeers) {
            if (hasPeer(pid)) {
              addPeer(pid)
            }
          }
          continue
        }
        let matchedByUser = false
        for (const [pid, entry] of entries.entries()) {
          if (
            (includePending
              ? hasAnySessionEntry(entry)
              : isRoomActiveEntry(entry)) &&
            getPeerUserId(pid) === id
          ) {
            addPeer(pid)
            matchedByUser = true
          }
        }
        if (!matchedByUser) {
          addPeer(id)
        }
      }
      return resolved
    },

    resolveRequestTarget: (
      target: string,
      includePending = false
    ): string | undefined => {
      const hasPeer = (id: string): boolean => {
        const e = entries.get(id)
        return includePending ? hasAnySessionEntry(e) : isRoomActiveEntry(e)
      }
      if (hasPeer(target)) {
        return target
      }
      const candidates: string[] = []
      for (const [pid, entry] of entries.entries()) {
        if (
          (includePending
            ? hasAnySessionEntry(entry)
            : isRoomActiveEntry(entry)) &&
          getPeerUserId(pid) === target
        ) {
          candidates.push(pid)
        }
      }
      if (candidates.length === 0) {
        return undefined
      }
      candidates.sort((a, b) => {
        const aDirect = Boolean(entries.get(a)?.direct?.active)
        const bDirect = Boolean(entries.get(b)?.direct?.active)
        if (aDirect !== bDirect) {
          return aDirect ? -1 : 1
        }
        return a < b ? -1 : a > b ? 1 : 0
      })
      return candidates[0]
    },

    addPendingDirect: (peerId: string, peer: PeerHandle): void => {
      const entry = ensureEntry(peerId)
      clearDirectRejectTimer(entry.direct)
      const session: DirectSession = {
        peer,
        transport: createDirectPeerTransport(
          peer,
          () => entries.get(peerId)?.direct === session
        ),
        active: false,
        rejectTimer: null
      }
      entry.direct = session
    },

    activateDirect: (
      peerId: string,
      peer: PeerHandle
    ): PeerActivationResult | null => {
      const entry = entries.get(peerId)
      if (!entry || entry.direct?.peer !== peer) {
        return null
      }
      const wasActive = isRoomActiveEntry(entry)
      entry.direct.active = true
      entry.virtual = null
      if (!wasActive) {
        const {userId, isFirstForUser} = addPeerToUserSet(peerId, entry)
        return {becameRoomActive: true, isFirstForUser, userId}
      }
      const userId = getPeerUserId(peerId)
      return {becameRoomActive: false, isFirstForUser: false, userId}
    },

    activateVirtual: (
      peerId: string,
      transport: PeerDataTransport
    ): PeerActivationResult => {
      const entry = ensureEntry(peerId)
      if (entry.direct?.active) {
        return {
          becameRoomActive: false,
          isFirstForUser: false,
          userId: getPeerUserId(peerId)
        }
      }
      const wasActive = isRoomActiveEntry(entry)
      entry.virtual = transport
      if (!wasActive) {
        const {userId, isFirstForUser} = addPeerToUserSet(peerId, entry)
        return {becameRoomActive: true, isFirstForUser, userId}
      }
      return {
        becameRoomActive: false,
        isFirstForUser: false,
        userId: getPeerUserId(peerId)
      }
    },

    deactivateVirtual: (peerId: string): PeerDeactivationResult => {
      const entry = entries.get(peerId)
      if (!entry || !entry.virtual) {
        return {
          wasRoomActive: false,
          isLastForUser: false,
          userId: getPeerUserId(peerId)
        }
      }
      const virtualTransport = entry.virtual
      entry.virtual = null
      virtualTransport.close?.()
      if (entry.direct?.active) {
        return {
          wasRoomActive: false,
          isLastForUser: false,
          userId: getPeerUserId(peerId),
          virtualTransport
        }
      }
      const {userId, isLastForUser} = removePeerFromUserSet(peerId, entry)
      pruneIfEmpty(peerId, entry)
      return {
        wasRoomActive: true,
        isLastForUser,
        userId,
        virtualTransport
      }
    },

    removePendingDirectOnly: (peerId: string, peer: PeerHandle): boolean => {
      const entry = entries.get(peerId)
      if (!entry || entry.direct?.peer !== peer || entry.direct.active) {
        return false
      }
      clearDirectRejectTimer(entry.direct)
      entry.direct = null
      entry.verified = false
      delete entry.userPubCompact
      delete entry.deferredReady
      pruneIfEmpty(peerId, entry)
      return true
    },

    removePeer: (peerId: string): PeerDeactivationResult => {
      const entry = entries.get(peerId)
      if (!entry) {
        return {
          wasRoomActive: false,
          isLastForUser: false,
          userId: getPeerUserId(peerId)
        }
      }
      const wasActive = isRoomActiveEntry(entry)
      const directPeer = entry.direct?.peer
      const virtualTransport = entry.virtual ?? undefined
      clearDirectRejectTimer(entry.direct)
      entry.direct = null
      entry.virtual = null
      virtualTransport?.close?.()
      entry.verified = false
      delete entry.userPubCompact
      delete entry.deferredReady
      const {userId, isLastForUser} = wasActive
        ? removePeerFromUserSet(peerId, entry)
        : {userId: getPeerUserId(peerId), isLastForUser: false}
      pruneIfEmpty(peerId, entry)
      return {
        wasRoomActive: wasActive,
        isLastForUser,
        userId,
        ...(directPeer ? {directPeer} : {}),
        ...(virtualTransport ? {virtualTransport} : {})
      }
    },

    clearAll: (): PeerHandle[] => {
      const directHandles: PeerHandle[] = []
      for (const entry of entries.values()) {
        clearDirectRejectTimer(entry.direct)
        if (entry.direct) {
          directHandles.push(entry.direct.peer)
        }
        entry.virtual?.close?.()
      }
      entries.clear()
      activeUserPeers.clear()
      return directHandles
    }
  }
}
