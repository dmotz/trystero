import {cmpStr, resetTimer, unrefTimer} from './utils'

const defaultFanout = 2
const defaultPullTimeoutMs = 1_500
const defaultPeriodicIntervalMs = 15_000
const defaultMaxPages = 32

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
  fillFanout: () => void
  pullPeer: (peerId: string, force?: boolean) => void
  onSyncPage: (fromPeerId: string, nextCursor?: string) => boolean
  onPeerJoined: (peerId: string, isDirect: boolean, forcePull?: boolean) => void
  onPeerDisconnected: (peerId: string) => void
  scheduleRepull: () => void
  isPullInFlight: (peerId: string) => boolean
  destroy: () => void
}

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
  const completedPeers = new Set<string>()
  const inFlightPulls = new Map<
    string,
    {timer: ReturnType<typeof setTimeout>; pages: number}
  >()
  let repullQueued = false
  let destroyed = false
  let periodicCursor = 0

  const clearPullTimer = (peerId: string): void => {
    const pull = inFlightPulls.get(peerId)
    if (pull) {
      resetTimer(pull.timer)
      inFlightPulls.delete(peerId)
    }
  }

  const selectRankedPeers = (): string[] =>
    getDirectPeers()
      .filter(isPeerSendable)
      .map(id => [id, hashWithSeed(id, seed)] as const)
      .sort((a, b) => a[1] - b[1] || cmpStr(a[0], b[0]))
      .map(([id]) => id)

  const startPull = (peerId: string, cursor?: string, pages = 0): void => {
    if (
      destroyed ||
      !canSync() ||
      pages >= maxPages ||
      !isPeerSendable(peerId)
    ) {
      clearPullTimer(peerId)
      return
    }
    clearPullTimer(peerId)
    const timer = setTimeout(() => {
      inFlightPulls.delete(peerId)
      if (!destroyed && completedPeers.size < fanout) {
        fillFanout()
      }
    }, pullTimeoutMs)
    unrefTimer(timer)
    inFlightPulls.set(peerId, {timer, pages: pages + 1})

    void Promise.resolve()
      .then(() => sendPull(peerId, cursor))
      .catch(() => clearPullTimer(peerId))
  }

  const fillFanout = (): void => {
    if (destroyed || !canSync()) {
      return
    }
    for (const candidate of selectRankedPeers()) {
      if (completedPeers.size + inFlightPulls.size >= fanout) {
        break
      }
      if (!completedPeers.has(candidate) && !inFlightPulls.has(candidate)) {
        startPull(candidate)
      }
    }
  }

  const pullPeer = (peerId: string, force = false): void => {
    if (
      destroyed ||
      !canSync() ||
      (!force && (completedPeers.has(peerId) || inFlightPulls.has(peerId))) ||
      (force && inFlightPulls.has(peerId))
    ) {
      return
    }
    startPull(peerId)
  }

  const onSyncPage = (fromPeerId: string, nextCursor?: string): boolean => {
    const pull = inFlightPulls.get(fromPeerId)
    if (!pull) {
      return false
    }
    if (nextCursor && pull.pages < maxPages) {
      startPull(fromPeerId, nextCursor, pull.pages)
      return true
    }
    clearPullTimer(fromPeerId)
    completedPeers.add(fromPeerId)
    return true
  }

  const onPeerJoined = (
    peerId: string,
    isDirect: boolean,
    forcePull = false
  ): void => {
    if (destroyed || !isDirect) {
      return
    }
    completedPeers.delete(peerId)
    if (forcePull) {
      pullPeer(peerId, true)
    }
    fillFanout()
  }

  const onPeerDisconnected = (peerId: string): void => {
    clearPullTimer(peerId)
    completedPeers.delete(peerId)
    if (!destroyed && completedPeers.size < fanout) {
      fillFanout()
    }
  }

  const scheduleRepull = (): void => {
    if (repullQueued || destroyed || getDirectPeers().length === 0) {
      return
    }
    repullQueued = true
    queueMicrotask(() => {
      repullQueued = false
      if (!destroyed && canSync()) {
        completedPeers.clear()
        fillFanout()
      }
    })
  }

  const periodicTimer =
    periodicIntervalMs > 0
      ? setInterval(() => {
          if (destroyed || !canSync() || inFlightPulls.size > 0) {
            return
          }
          const ranked = selectRankedPeers()
          if (ranked.length === 0) {
            return
          }
          const pick = ranked[periodicCursor++ % ranked.length]!
          startPull(pick)
        }, periodicIntervalMs)
      : undefined
  unrefTimer(periodicTimer)

  const destroy = (): void => {
    destroyed = true
    if (periodicTimer !== undefined) {
      clearInterval(periodicTimer)
    }
    inFlightPulls.forEach(pull => resetTimer(pull.timer))
    inFlightPulls.clear()
    completedPeers.clear()
  }

  return {
    fillFanout,
    pullPeer,
    onSyncPage,
    onPeerJoined,
    onPeerDisconnected,
    scheduleRepull,
    isPullInFlight: peerId => inFlightPulls.has(peerId),
    destroy
  }
}
