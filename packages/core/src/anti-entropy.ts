import type {Timeout} from './internal-types'
import {cmpStr, resetTimer, unreachable, unrefTimer} from './utils'

const defaultFanout = 2
const defaultPullTimeoutMs = 1_500
const defaultPeriodicIntervalMs = 15_000
const defaultMaxPages = 32
const timeoutCooldownMs = 10_000

export const isValidSyncCursor = (c: unknown): c is string | undefined =>
  c === undefined || (typeof c === 'string' && c.length <= 512)

const hashWithSeed = (value: string, seed: number): number => {
  let h = (0x811c9dc5 ^ seed) >>> 0
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

export type AntiEntropySyncOptions = {
  fanout?: number
  pullTimeoutMs?: number
  periodicIntervalMs?: number
  maxPages?: number
  canSync?: () => boolean
  getDirectPeers: () => readonly string[]
  isPeerSendable: (peerId: string) => boolean
  sendPull: (peerId: string, cursor?: string) => Promise<void> | void
}

export type AntiEntropySync = {
  pullPeer: (peerId: string, force?: boolean) => void
  onSyncPage: (fromPeerId: string, nextCursor?: string) => void
  onPeerJoined: (peerId: string, forcePull?: boolean) => void
  onPeerDisconnected: (peerId: string) => void
  scheduleRepull: () => void
  isPullInFlight: (peerId: string) => boolean
  destroy: () => void
}

type PeerPullState =
  | {
      readonly phase: 'in-flight'
      readonly pullId: symbol
      readonly timer: Timeout
      readonly pages: number
      readonly staleDigest: boolean
    }
  | {readonly phase: 'completed'}
  | {readonly phase: 'cooldown'; readonly until: number}

type SchedulerPhase = 'active' | 'repull-queued' | 'closed'

const occupiesFanoutSlot = (
  state: PeerPullState
): state is Extract<PeerPullState, {phase: 'in-flight' | 'completed'}> =>
  state.phase === 'in-flight' || state.phase === 'completed'

export const createAntiEntropySync = ({
  fanout = defaultFanout,
  pullTimeoutMs = defaultPullTimeoutMs,
  periodicIntervalMs = defaultPeriodicIntervalMs,
  maxPages = defaultMaxPages,
  canSync = () => true,
  getDirectPeers,
  isPeerSendable,
  sendPull
}: AntiEntropySyncOptions): AntiEntropySync => {
  const seed = crypto.getRandomValues(new Uint32Array(1))[0]!
  const peerStates = new Map<string, PeerPullState>()
  let schedulerPhase: SchedulerPhase = 'active'
  let periodicCursor = 0

  const countCompleted = (): number => {
    let count = 0
    for (const state of peerStates.values()) {
      if (state.phase === 'completed') {
        count++
      }
    }
    return count
  }

  const countActiveOrCompleted = (): number => {
    let count = 0
    for (const state of peerStates.values()) {
      if (occupiesFanoutSlot(state)) {
        count++
      }
    }
    return count
  }

  const hasInFlight = (): boolean => {
    for (const state of peerStates.values()) {
      if (state.phase === 'in-flight') {
        return true
      }
    }
    return false
  }

  const clearPeerState = (peerId: string): void => {
    const cur = peerStates.get(peerId)
    if (!cur) {
      return
    }
    switch (cur.phase) {
      case 'in-flight':
        resetTimer(cur.timer)
        peerStates.delete(peerId)
        return
      case 'completed':
      case 'cooldown':
        peerStates.delete(peerId)
        return
      default:
        unreachable(cur)
    }
  }

  const isCoolingDown = (peerId: string, now: number): boolean => {
    const cur = peerStates.get(peerId)
    if (cur?.phase !== 'cooldown') {
      return false
    }
    if (now >= cur.until) {
      peerStates.delete(peerId)
      return false
    }
    return true
  }

  const selectRankedPeers = (skipCooldown = true): string[] => {
    const now = Date.now()
    return getDirectPeers()
      .filter(
        id => isPeerSendable(id) && (!skipCooldown || !isCoolingDown(id, now))
      )
      .map(id => [id, hashWithSeed(id, seed)] as const)
      .sort((a, b) => a[1] - b[1] || cmpStr(a[0], b[0]))
      .map(([id]) => id)
  }

  const transitionFailedPull = (peerId: string, pullId: symbol): void => {
    const cur = peerStates.get(peerId)
    if (
      schedulerPhase === 'closed' ||
      cur?.phase !== 'in-flight' ||
      cur.pullId !== pullId
    ) {
      return
    }
    resetTimer(cur.timer)
    if (isPeerSendable(peerId)) {
      peerStates.set(peerId, {
        phase: 'cooldown',
        until: Date.now() + timeoutCooldownMs
      })
    } else {
      peerStates.delete(peerId)
    }
    if (countCompleted() < fanout) {
      fillFanout()
    }
  }

  const makePullTimer = (peerId: string, pullId: symbol): Timeout => {
    const timer = setTimeout(
      () => transitionFailedPull(peerId, pullId),
      pullTimeoutMs
    )
    unrefTimer(timer)
    return timer
  }

  const startPull = (
    peerId: string,
    cursor?: string,
    pages = 0,
    preserveStaleDigest = false
  ): boolean => {
    if (
      schedulerPhase === 'closed' ||
      !canSync() ||
      pages >= maxPages ||
      !isPeerSendable(peerId)
    ) {
      clearPeerState(peerId)
      return false
    }
    const prev = peerStates.get(peerId)
    if (prev?.phase === 'in-flight') {
      resetTimer(prev.timer)
    }
    const pullId = Symbol()
    const timer = makePullTimer(peerId, pullId)
    peerStates.set(peerId, {
      phase: 'in-flight',
      pullId,
      timer,
      pages: pages + 1,
      staleDigest: preserveStaleDigest
    })

    void Promise.resolve()
      .then(() => sendPull(peerId, cursor))
      .catch(() => transitionFailedPull(peerId, pullId))
    return true
  }

  const fillFanout = (): void => {
    if (schedulerPhase === 'closed' || !canSync()) {
      return
    }
    let activeOrCompleted = countActiveOrCompleted()
    for (const candidate of selectRankedPeers()) {
      if (activeOrCompleted >= fanout) {
        break
      }
      if (!peerStates.has(candidate) && startPull(candidate)) {
        activeOrCompleted++
      }
    }
  }

  const pullPeer = (peerId: string, force = false): void => {
    if (schedulerPhase === 'closed' || !canSync()) {
      return
    }
    const cur = peerStates.get(peerId)
    if (!cur) {
      startPull(peerId)
      return
    }
    switch (cur.phase) {
      case 'in-flight':
        if (force && !cur.staleDigest) {
          peerStates.set(peerId, {...cur, staleDigest: true})
        }
        return
      case 'completed':
        if (force) {
          startPull(peerId)
        }
        return
      case 'cooldown':
        startPull(peerId)
        return
      default:
        unreachable(cur)
    }
  }

  const onSyncPage = (fromPeerId: string, nextCursor?: string): void => {
    const cur = peerStates.get(fromPeerId)
    if (schedulerPhase === 'closed' || cur?.phase !== 'in-flight') {
      return
    }
    if (nextCursor && cur.pages < maxPages) {
      startPull(fromPeerId, nextCursor, cur.pages, cur.staleDigest)
      return
    }
    resetTimer(cur.timer)
    if (cur.staleDigest) {
      peerStates.delete(fromPeerId)
      startPull(fromPeerId)
      return
    }
    peerStates.set(fromPeerId, {phase: 'completed'})
  }

  const onPeerJoined = (peerId: string, forcePull = false): void => {
    if (schedulerPhase === 'closed') {
      return
    }
    const cur = peerStates.get(peerId)
    if (cur?.phase === 'in-flight') {
      if (!cur.staleDigest) {
        peerStates.set(peerId, {...cur, staleDigest: true})
      }
    } else {
      peerStates.delete(peerId)
    }
    if (forcePull) {
      pullPeer(peerId, true)
    }
    fillFanout()
  }

  const onPeerDisconnected = (peerId: string): void => {
    clearPeerState(peerId)
    if (schedulerPhase !== 'closed' && countCompleted() < fanout) {
      fillFanout()
    }
  }

  const scheduleRepull = (): void => {
    if (schedulerPhase !== 'active' || getDirectPeers().length === 0) {
      return
    }
    schedulerPhase = 'repull-queued'
    queueMicrotask(() => {
      if (schedulerPhase !== 'repull-queued') {
        return
      }
      schedulerPhase = 'active'
      if (!canSync()) {
        return
      }
      for (const [pid, state] of peerStates) {
        switch (state.phase) {
          case 'completed':
            peerStates.delete(pid)
            break
          case 'in-flight':
            if (!state.staleDigest) {
              peerStates.set(pid, {...state, staleDigest: true})
            }
            break
          case 'cooldown':
            break
          default:
            unreachable(state)
        }
      }
      fillFanout()
    })
  }

  const periodicTimer =
    periodicIntervalMs > 0
      ? setInterval(() => {
          if (schedulerPhase === 'closed' || !canSync() || hasInFlight()) {
            return
          }
          let ranked = selectRankedPeers()
          if (ranked.length === 0) {
            ranked = selectRankedPeers(false)
          }
          if (ranked.length === 0) {
            return
          }
          const pick = ranked[periodicCursor++ % ranked.length]!
          startPull(pick)
        }, periodicIntervalMs)
      : undefined
  unrefTimer(periodicTimer)

  const destroy = (): void => {
    schedulerPhase = 'closed'
    if (periodicTimer !== undefined) {
      clearInterval(periodicTimer)
    }
    for (const state of peerStates.values()) {
      if (state.phase === 'in-flight') {
        resetTimer(state.timer)
      }
    }
    peerStates.clear()
  }

  return {
    pullPeer,
    onSyncPage,
    onPeerJoined,
    onPeerDisconnected,
    scheduleRepull,
    isPullInFlight: peerId => peerStates.get(peerId)?.phase === 'in-flight',
    destroy
  }
}
