import {hash32} from '../primitives'
import {
  createSlidingReplayWindow,
  type SlidingReplayWindow
} from '../signed-record'
import {createBoundedCache, createBoundedSet, noOp} from '../utils'

const maxTrackedOrigins = 2_048
const maxQueuedTasksPerPeer = 8_192

const lastLocalSeqByRoomPeer = /*@__PURE__*/ createBoundedCache<
  string,
  [descSeq: number, pktSeq: number]
>(4_096)

export type OverlaySequencerDeps = {
  getAppId: () => string
  getRoomId: () => string
  getSelfId: () => string
  isPinnedOrigin: (peerId: string) => boolean
}

export type OverlaySequencer = {
  syncSeqFloor: (id?: string) => void
  resetFloor: () => void
  nextDescSeq: () => number
  nextPktSeq: () => number
  peekPktSeq: () => number
  originReplay: SlidingReplayWindow
  seenMsgIds: ReturnType<typeof createBoundedSet<string>>
  enqueuePeerTask: (peerId: string, fn: () => void | Promise<void>) => void
  clear: () => void
}

export const createOverlaySequencer = (
  deps: OverlaySequencerDeps
): OverlaySequencer => {
  let descSeq = 0
  let pktSeq = 0
  let didInitFloor = false

  const saveSeqs = (
    id: string = deps.getSelfId(),
    initFloor?: boolean
  ): void => {
    if (!id) {
      return
    }
    const key = `${deps.getAppId()}\0${deps.getRoomId()}\0${id}`
    const prev = lastLocalSeqByRoomPeer.get(key)
    if (initFloor && !didInitFloor) {
      didInitFloor = true
      if (prev) {
        descSeq = Math.max(descSeq, prev[0] + 1_024)
        pktSeq = Math.max(pktSeq, prev[1] + 1_024)
      }
    }
    lastLocalSeqByRoomPeer.set(key, [
      Math.max(descSeq, prev?.[0] ?? 0),
      Math.max(pktSeq, prev?.[1] ?? 0)
    ])
  }

  const originReplay = createSlidingReplayWindow(
    maxTrackedOrigins,
    deps.isPinnedOrigin
  )
  const seenMsgIds = createBoundedSet<string>(4_096)
  const peerQueues = new Map<string, Promise<void>>()
  const peerQueueDepths = new Map<string, number>()

  return {
    syncSeqFloor: id => saveSeqs(id, true),
    resetFloor: () => {
      didInitFloor = false
      saveSeqs(deps.getSelfId(), true)
    },
    nextDescSeq: () => {
      descSeq++
      saveSeqs()
      return descSeq
    },
    nextPktSeq: () => {
      pktSeq++
      saveSeqs()
      return pktSeq
    },
    peekPktSeq: () => pktSeq,
    originReplay,
    seenMsgIds,
    enqueuePeerTask: (peerId, fn) => {
      const qKey =
        peerQueues.has(peerId) || peerQueues.size < maxTrackedOrigins
          ? peerId
          : `overflow:${hash32(peerId) & 63}`
      const depth = peerQueueDepths.get(qKey) ?? 0
      if (depth >= maxQueuedTasksPerPeer) {
        return
      }
      peerQueueDepths.set(qKey, depth + 1)
      const next = (peerQueues.get(qKey) ?? Promise.resolve())
        .then(fn)
        .catch(noOp)
        .finally(() => {
          const nextDepth = (peerQueueDepths.get(qKey) ?? 1) - 1
          if (nextDepth <= 0) {
            peerQueueDepths.delete(qKey)
          } else {
            peerQueueDepths.set(qKey, nextDepth)
          }
          if (peerQueues.get(qKey) === next) {
            peerQueues.delete(qKey)
          }
        })
      peerQueues.set(qKey, next)
    },
    clear: () => {
      peerQueues.clear()
      peerQueueDepths.clear()
      originReplay.clear()
      seenMsgIds.clear()
    }
  }
}
