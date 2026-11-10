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

type QueueBucket = {
  tail: Promise<void>
  depth: number
}

type PeerQueueBinding = {
  key: string
  count: number
}

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
  let flooredSelfId = ''
  let queueEpoch = 0

  const ensureFloor = (id: string): void => {
    if (!id || flooredSelfId === id) {
      return
    }
    flooredSelfId = id
    const key = `${deps.getAppId()}\0${deps.getRoomId()}\0${id}`
    const prev = lastLocalSeqByRoomPeer.get(key)
    if (prev) {
      descSeq = Math.max(descSeq, prev[0] + 1_024)
      pktSeq = Math.max(pktSeq, prev[1] + 1_024)
    }
  }

  const persistSeqs = (id: string = deps.getSelfId()): void => {
    if (!id) {
      return
    }
    ensureFloor(id)
    const key = `${deps.getAppId()}\0${deps.getRoomId()}\0${id}`
    const prev = lastLocalSeqByRoomPeer.get(key)
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
  const queueBuckets = new Map<string, QueueBucket>()
  const peerQueueBindings = new Map<string, PeerQueueBinding>()

  return {
    syncSeqFloor: id => persistSeqs(id ?? deps.getSelfId()),
    resetFloor: () => {
      flooredSelfId = ''
      persistSeqs(deps.getSelfId())
    },
    nextDescSeq: () => {
      const id = deps.getSelfId()
      ensureFloor(id)
      descSeq++
      persistSeqs(id)
      return descSeq
    },
    nextPktSeq: () => {
      const id = deps.getSelfId()
      ensureFloor(id)
      pktSeq++
      persistSeqs(id)
      return pktSeq
    },
    peekPktSeq: () => pktSeq,
    originReplay,
    seenMsgIds,
    enqueuePeerTask: (peerId, fn) => {
      const existingBinding = peerQueueBindings.get(peerId)
      const qKey = existingBinding
        ? existingBinding.key
        : queueBuckets.has(peerId) || queueBuckets.size < maxTrackedOrigins
          ? peerId
          : `overflow:${hash32(peerId) & 63}`
      let bucket = queueBuckets.get(qKey)
      if (bucket && bucket.depth >= maxQueuedTasksPerPeer) {
        return
      }
      if (!bucket) {
        bucket = {tail: Promise.resolve(), depth: 0}
        queueBuckets.set(qKey, bucket)
      }
      const activeBucket = bucket
      const activeBinding = existingBinding ?? {key: qKey, count: 0}
      if (!existingBinding) {
        peerQueueBindings.set(peerId, activeBinding)
      }
      activeBucket.depth++
      activeBinding.count++
      const epoch = queueEpoch
      const next = activeBucket.tail
        .then(fn)
        .catch(noOp)
        .finally(() => {
          if (epoch !== queueEpoch) {
            return
          }
          activeBinding.count--
          if (
            activeBinding.count <= 0 &&
            peerQueueBindings.get(peerId) === activeBinding
          ) {
            peerQueueBindings.delete(peerId)
          }
          activeBucket.depth--
          if (
            activeBucket.depth <= 0 &&
            queueBuckets.get(qKey) === activeBucket &&
            activeBucket.tail === next
          ) {
            queueBuckets.delete(qKey)
          }
        })
      activeBucket.tail = next
    },
    clear: () => {
      queueEpoch++
      queueBuckets.clear()
      peerQueueBindings.clear()
      originReplay.clear()
      seenMsgIds.clear()
    }
  }
}
