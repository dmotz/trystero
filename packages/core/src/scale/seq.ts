import {hash32} from '../primitives'
import {
  createSlidingReplayWindow,
  type SlidingReplayWindow
} from '../signed-record'
import {createBoundedCache, createBoundedSet, noOp} from '../utils'

const maxTrackedOrigins = 2_048

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
  hasOriginQueue: (originId: string) => boolean
  enqueueOriginTask: (originId: string, fn: () => void | Promise<void>) => void
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
  const originQueues = new Map<string, Promise<void>>()

  const resolveQueueKey = (originId: string): string => {
    const key = `o:${originId}`
    return originQueues.has(key) || originQueues.size < maxTrackedOrigins
      ? key
      : `overflow:${hash32(key) & 63}`
  }

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
    hasOriginQueue: originId => originQueues.has(`o:${originId}`),
    enqueueOriginTask: (originId, fn) => {
      const qKey = resolveQueueKey(originId)
      const next = (originQueues.get(qKey) ?? Promise.resolve())
        .then(fn)
        .catch(noOp)
        .finally(() => {
          if (originQueues.get(qKey) === next) {
            originQueues.delete(qKey)
          }
        })
      originQueues.set(qKey, next)
    },
    clear: () => {
      originQueues.clear()
      originReplay.clear()
      seenMsgIds.clear()
    }
  }
}
