import type {
  PeerHandle,
  RolesPluginApi,
  Room,
  ScaleConfig,
  ScalePluginApi,
  UserIdentity
} from '../../packages/core/src/index.ts'
import {roles} from '../../packages/core/src/authority.ts'
import {maxRoomFrameBytes} from '../../packages/core/src/data-limits.ts'
import {
  createRoomWithBridge,
  type RoomOptions,
  type RoomSignalingBridge
} from '../../packages/core/src/room.ts'
import type {
  AnyRoomPlugin,
  RoomWithPlugins
} from '../../packages/core/src/types.ts'
import {formatSelfCertifyingRoomId} from '../../packages/core/src/utils.ts'

const roomBridges = new WeakMap<Room, RoomSignalingBridge>()

export const createTrackedRoom = <
  const TPlugins extends readonly AnyRoomPlugin[] | undefined = undefined
>(
  onPeer: (f: (peer: PeerHandle, id: string) => void) => void,
  onPeerLeave: (id: string, shouldReannounce?: boolean) => void,
  onSelfLeave: () => void,
  roomOptions: RoomOptions & {use?: TPlugins} = {}
): RoomWithPlugins<TPlugins> => {
  const [room, bridge] = createRoomWithBridge(
    onPeer,
    onPeerLeave,
    onSelfLeave,
    roomOptions
  )
  roomBridges.set(room, bridge)
  return room
}

export const getRoomSignalingBridge = (
  room: Room
): RoomSignalingBridge | undefined => roomBridges.get(room)
import {
  scale,
  type OverlayManager
} from '../../packages/core/src/scale/index.ts'
import {
  allocTestPeerIds,
  getTestEndpointByPeerId,
  LinkedMediaPeer,
  LinkedPeer,
  linkPeers,
  wait,
  waitFor
} from './peer-harness.ts'

export type TestMediaTrackLike = {id: string}
export type TestMediaStreamLike = {
  id: string
  getTracks: () => TestMediaTrackLike[]
}

export type VirtualNetworkOptions = {
  peerCount: number
  topology?: ScaleConfig
  password?: string
  media?: boolean
  jitterMs?: number
}

let nextClusterRoomSeq = 0
let nextRegClusterSeq = 0

/**
 * Asynchronous, jittered in-memory WebRTC + topic-discovery harness
 * where peers discover each other via `notePeerDiscovered` and autonomously
 * dial targets via `setOnScaleTargetsChanged` / `shouldConnectPeer`.
 */
export const createOverlayCluster = async ({
  peerCount,
  topology = {},
  password = '',
  media = false,
  jitterMs = 2
}: VirtualNetworkOptions) => {
  const peerIds = allocTestPeerIds(peerCount)
  const clusterRoomId = `scale-test-room-${++nextClusterRoomSeq}`
  const resolvedTopology: ScaleConfig = {...topology}

  const registerCallbacks = new Map<
    string,
    (peer: PeerHandle, id: string) => void
  >()
  const rooms = new Map<string, Room & RolesPluginApi & ScalePluginApi>()
  const directLinks = new Map<
    string,
    {peerA: InstrumentedPeer; peerB: InstrumentedPeer}
  >()
  const joinedByPeer = new Map<string, Set<string>>()
  const leftByPeer = new Map<string, Set<string>>()
  let totalWireFrames = 0
  let totalAddStreamCalls = 0
  const addedTracks: string[] = []

  class InstrumentedPeer extends LinkedMediaPeer {
    removeStreamCalls = 0
    lastReplacedTrack: {
      oldTrack: TestMediaTrackLike
      newTrack: TestMediaTrackLike
    } | null = null
    ownerId = ''
    private outboundQueue: Array<() => void> = []
    private drainTimer: ReturnType<typeof setTimeout> | null = null

    private enqueueOp(op: () => void) {
      if (this.isDead) {
        return
      }
      this.outboundQueue.push(op)
      this.scheduleDrain()
    }

    private scheduleDrain() {
      if (this.drainTimer || this.isDead || this.outboundQueue.length === 0) {
        return
      }
      const delay =
        jitterMs > 0 ? Math.floor(Math.random() * (jitterMs + 1)) : 0
      this.drainTimer = setTimeout(() => {
        this.drainTimer = null
        if (this.isDead) {
          this.outboundQueue.length = 0
          return
        }
        const batch = this.outboundQueue.splice(0, 32)
        for (const op of batch) {
          if (this.isDead) {
            break
          }
          op()
        }
        if (this.outboundQueue.length > 0 && !this.isDead) {
          this.scheduleDrain()
        }
      }, delay)
    }

    override sendData(data: Uint8Array) {
      if (this.isDead) {
        return
      }
      if (data.byteLength > maxRoomFrameBytes) {
        const partner = this.partner
        this.destroy()
        partner?.destroy()
        return
      }
      totalWireFrames++
      const copy = data.slice()
      this.enqueueOp(() => super.sendData(copy))
    }

    override destroy() {
      if (this.drainTimer) {
        clearTimeout(this.drainTimer)
        this.drainTimer = null
      }
      this.outboundQueue.length = 0
      super.destroy()
    }

    override addStream(stream: TestMediaStreamLike) {
      totalAddStreamCalls++
      const tracks = stream.getTracks().map(track => track.id)
      addedTracks.push(...tracks)
      this.enqueueOp(() => {
        if (media) {
          super.addStream(stream)
        }
      })
    }

    override addTrack(track: TestMediaTrackLike, stream: TestMediaStreamLike) {
      addedTracks.push(track.id)
      this.enqueueOp(() => {
        if (media) {
          super.addTrack(track, stream)
        }
      })
      return {}
    }

    override removeStream(stream: TestMediaStreamLike) {
      this.removeStreamCalls++
      this.enqueueOp(() => {
        if (media) {
          super.removeStream(stream)
        }
      })
    }

    override replaceTrack(
      oldTrack: TestMediaTrackLike,
      newTrack: TestMediaTrackLike
    ) {
      this.lastReplacedTrack = {oldTrack, newTrack}
      return media ? super.replaceTrack(oldTrack, newTrack) : Promise.resolve()
    }
  }

  const linkKey = (a: string, b: string) =>
    a < b ? `${a}<->${b}` : `${b}<->${a}`

  const connectPair = (idA: string, idB: string) => {
    if (idA === idB) {
      return
    }
    const key = linkKey(idA, idB)
    if (directLinks.has(key)) {
      return
    }
    const regA = registerCallbacks.get(idA)
    const regB = registerCallbacks.get(idB)
    if (!regA || !regB) {
      return
    }
    const {peerA, peerB} = linkPeers(
      new InstrumentedPeer(),
      new InstrumentedPeer()
    )
    const firstId = idA < idB ? idA : idB
    peerA.ownerId = firstId === idA ? idA : idB
    peerB.ownerId = firstId === idA ? idB : idA
    directLinks.set(key, {peerA, peerB})
    if (idA < idB) {
      regA(peerA as unknown as PeerHandle, idB)
      regB(peerB as unknown as PeerHandle, idA)
    } else {
      regB(peerA as unknown as PeerHandle, idA)
      regA(peerB as unknown as PeerHandle, idB)
    }
  }

  const activeSet = new Set(peerIds)

  for (const id of peerIds) {
    const joined = new Set<string>()
    const left = new Set<string>()
    joinedByPeer.set(id, joined)
    leftByPeer.set(id, left)

    const room = createTrackedRoom(
      f => registerCallbacks.set(id, f),
      peerId => {
        for (const [k, pair] of directLinks.entries()) {
          if (k === linkKey(id, peerId)) {
            directLinks.delete(k)
            pair.peerA.destroy()
            pair.peerB.destroy()
          }
        }
      },
      () => {},
      {
        endpointIdentity: getTestEndpointByPeerId(id),
        clientId: id,
        appId: 'scale-test-app',
        roomId: clusterRoomId,
        password,
        use: [scale(resolvedTopology)]
      }
    )

    room.onPeerJoin(({peerId}) => {
      left.delete(peerId)
      joined.add(peerId)
    })
    room.onPeerLeave(({peerId}) => {
      joined.delete(peerId)
      left.add(peerId)
    })

    const shouldConnect = (
      b: ReturnType<typeof getRoomSignalingBridge>,
      peerId: string,
      dir: 'inbound' | 'outbound'
    ) =>
      Boolean(
        (b?.canConnectPeer(peerId) ?? true) &&
        (b?.getScaleProvider()?.shouldConnectPeer(peerId, dir) ?? true)
      )

    const bridge = getRoomSignalingBridge(room)
    bridge?.setOnScaleTargetsChanged(targets => {
      for (const targetId of targets) {
        if (
          !activeSet.has(targetId) ||
          !activeSet.has(id) ||
          directLinks.has(linkKey(id, targetId))
        ) {
          continue
        }
        if (!shouldConnect(bridge, targetId, 'outbound')) {
          continue
        }
        const targetRoom = rooms.get(targetId)
        const targetBridge = targetRoom
          ? getRoomSignalingBridge(targetRoom)
          : undefined
        if (targetBridge && !shouldConnect(targetBridge, id, 'inbound')) {
          continue
        }
        connectPair(id, targetId)
      }
    })

    rooms.set(id, room as unknown as Room & RolesPluginApi & ScalePluginApi)
  }

  const discoverAndDialFromOverlay = () => {
    for (const id of activeSet) {
      const room = rooms.get(id)!
      const bridge = getRoomSignalingBridge(room)!
      for (const otherId of activeSet) {
        if (otherId !== id) {
          bridge.getScaleProvider()?.notePeerDiscovered(otherId)
        }
      }
    }
    for (const id of activeSet) {
      const room = rooms.get(id)!
      const bridge = getRoomSignalingBridge(room)!
      const targets = bridge.getScaleProvider()?.getTargetNeighbors()
      if (targets) {
        for (const targetId of targets) {
          if (activeSet.has(targetId)) {
            connectPair(id, targetId)
          }
        }
      }
    }
  }

  const waitForTopologyConvergence = async () => {
    await waitFor(() => {
      for (const id of activeSet) {
        const snap = rooms.get(id)!.getTopology()
        if (
          snap.roomPeerIds.length !== activeSet.size - 1 ||
          Object.keys(snap.routes).length !== activeSet.size - 1
        ) {
          return false
        }
        for (const peerId of snap.roomPeerIds) {
          if (!activeSet.has(peerId)) {
            return false
          }
        }
      }
      return true
    }, 25_000)
    await wait(120)
  }

  const dropPeer = (id: string) => {
    if (!activeSet.has(id)) {
      return
    }
    activeSet.delete(id)
    registerCallbacks.delete(id)

    const survivingEndpoints: LinkedPeer[] = []
    for (const [key, pair] of directLinks.entries()) {
      if (key.startsWith(`${id}<->`) || key.endsWith(`<->${id}`)) {
        directLinks.delete(key)
        const isFirst = key.startsWith(`${id}<->`)
        const deadEndpoint = isFirst ? pair.peerA : pair.peerB
        const survivingEndpoint = isFirst ? pair.peerB : pair.peerA
        deadEndpoint.isDead = true
        deadEndpoint.handlers = {}
        survivingEndpoints.push(survivingEndpoint)
      }
    }
    for (const endpoint of survivingEndpoints) {
      endpoint.destroy()
    }
  }

  const healCluster = async () => {
    discoverAndDialFromOverlay()
    await waitForTopologyConvergence()
  }

  const cleanup = async () => {
    activeSet.clear()
    registerCallbacks.clear()
    for (const pair of directLinks.values()) {
      pair.peerA.isDead = true
      pair.peerA.handlers = {}
      pair.peerB.isDead = true
      pair.peerB.handlers = {}
    }
    directLinks.clear()
    await Promise.all([...rooms.values()].map(room => room.leave()))
  }

  try {
    discoverAndDialFromOverlay()
    await waitForTopologyConvergence()
  } catch (err) {
    await cleanup()
    throw err
  }

  return {
    peerIds,
    activeSet,
    rooms,
    directLinks,
    addedTracks,
    joinedByPeer,
    leftByPeer,
    connectPair,
    dropPeer,
    healCluster,
    cleanup,
    getStats: () => ({
      totalWireFrames,
      totalAddStreamCalls,
      directEdgeCount: directLinks.size
    }),
    resetStats: () => {
      totalWireFrames = 0
      totalAddStreamCalls = 0
    }
  }
}

export type ClusterPeerOptions = {
  peerCount: number
  maxDirectPeers?: number
  media?: boolean
  delayMs?: number
  adminId?: string
  adminIdentity?: UserIdentity
  identities?: Map<string, UserIdentity>
}

export const createTestScaleCluster = async ({
  peerCount,
  maxDirectPeers = 4,
  media = false,
  delayMs = 1,
  adminId,
  adminIdentity: explicitAdminIdentity,
  identities
}: ClusterPeerOptions) => {
  const peerIds = allocTestPeerIds(peerCount)
  const adminIdentity =
    explicitAdminIdentity ?? (adminId ? identities?.get(adminId) : undefined)
  const roomId = adminIdentity
    ? formatSelfCertifyingRoomId(
        `scale-reg-${++nextRegClusterSeq}`,
        adminIdentity.userId
      )
    : `scale-reg-${++nextRegClusterSeq}`

  const registerCallbacks = new Map<
    string,
    (peer: PeerHandle, id: string) => void
  >()
  const rooms = new Map<
    string,
    Room & ScalePluginApi & Partial<RolesPluginApi>
  >()
  const directLinks = new Map<
    string,
    {peerA: DelayedClusterPeer; peerB: DelayedClusterPeer}
  >()
  const joinedByPeer = new Map<string, Set<string>>()
  const leftByPeer = new Map<string, Set<string>>()

  class DelayedClusterPeer extends LinkedMediaPeer {
    private timers = new Set<ReturnType<typeof setTimeout>>()

    override sendData(data: Uint8Array) {
      if (this.isDead) {
        return
      }
      const copy = data.slice()
      if (delayMs <= 0) {
        super.sendData(copy)
        return
      }
      const t = setTimeout(() => {
        this.timers.delete(t)
        if (!this.isDead) {
          super.sendData(copy)
        }
      }, delayMs)
      this.timers.add(t)
    }

    override addStream(stream: TestMediaStreamLike) {
      if (media) {
        super.addStream(stream)
      }
    }

    override addTrack(track: TestMediaTrackLike, stream: TestMediaStreamLike) {
      if (media) {
        return super.addTrack(track, stream)
      }
      return {}
    }

    override removeStream(stream: TestMediaStreamLike) {
      if (media) {
        super.removeStream(stream)
      }
    }

    override replaceTrack(
      oldTrack: TestMediaTrackLike,
      newTrack: TestMediaTrackLike
    ) {
      return media ? super.replaceTrack(oldTrack, newTrack) : Promise.resolve()
    }

    override destroy() {
      for (const t of this.timers) {
        clearTimeout(t)
      }
      this.timers.clear()
      super.destroy()
    }
  }

  const linkKey = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`)

  const connectPair = (idA: string, idB: string) => {
    if (idA === idB) {
      return
    }
    const key = linkKey(idA, idB)
    if (directLinks.has(key)) {
      return
    }
    const regA = registerCallbacks.get(idA)
    const regB = registerCallbacks.get(idB)
    if (!regA || !regB) {
      return
    }
    const {peerA, peerB} = linkPeers(
      new DelayedClusterPeer(),
      new DelayedClusterPeer()
    )
    directLinks.set(key, {peerA, peerB})
    if (idA < idB) {
      regA(peerA as unknown as PeerHandle, idB)
      regB(peerB as unknown as PeerHandle, idA)
    } else {
      regB(peerA as unknown as PeerHandle, idA)
      regA(peerB as unknown as PeerHandle, idB)
    }
  }

  for (const id of peerIds) {
    const joined = new Set<string>()
    const left = new Set<string>()
    joinedByPeer.set(id, joined)
    leftByPeer.set(id, left)
    const userIdentity =
      identities?.get(id) ??
      (id === peerIds[0] && adminIdentity ? adminIdentity : undefined)

    const plugins = adminIdentity
      ? [roles(), scale({maxDirectPeers})]
      : [scale({maxDirectPeers})]

    const room = createTrackedRoom(
      f => registerCallbacks.set(id, f),
      peerId => {
        const k = linkKey(id, peerId)
        const pair = directLinks.get(k)
        if (pair) {
          directLinks.delete(k)
          pair.peerA.destroy()
          pair.peerB.destroy()
        }
      },
      () => {},
      {
        endpointIdentity: getTestEndpointByPeerId(id),
        appId: 'scale-reg-app',
        roomId,
        ...(userIdentity ? {identity: userIdentity} : {clientId: id}),
        use: plugins
      }
    )

    room.onPeerJoin(({peerId}) => {
      left.delete(peerId)
      joined.add(peerId)
    })
    room.onPeerLeave(({peerId}) => {
      joined.delete(peerId)
      left.add(peerId)
    })

    const bridge = getRoomSignalingBridge(room)
    bridge?.setOnScaleTargetsChanged(targets => {
      for (const targetId of targets) {
        if (directLinks.has(linkKey(id, targetId))) {
          continue
        }
        const canOut =
          (bridge.canConnectPeer(targetId) ?? true) &&
          (bridge.getScaleProvider()?.shouldConnectPeer(targetId, 'outbound') ??
            true)
        if (!canOut) {
          continue
        }
        const targetRoom = rooms.get(targetId)
        const targetBridge = targetRoom
          ? getRoomSignalingBridge(targetRoom)
          : undefined
        const canIn = targetBridge
          ? (targetBridge.canConnectPeer(id) ?? true) &&
            (targetBridge
              .getScaleProvider()
              ?.shouldConnectPeer(id, 'inbound') ??
              true)
          : true
        if (canIn) {
          connectPair(id, targetId)
        }
      }
    })

    rooms.set(
      id,
      room as unknown as Room & ScalePluginApi & Partial<RolesPluginApi>
    )
  }

  for (const id of peerIds) {
    const sp = getRoomSignalingBridge(rooms.get(id)!)?.getScaleProvider()
    for (const otherId of peerIds) {
      if (otherId !== id) {
        sp?.notePeerDiscovered(otherId)
      }
    }
  }
  for (const id of peerIds) {
    const sp = getRoomSignalingBridge(rooms.get(id)!)?.getScaleProvider()
    for (const targetId of sp?.getTargetNeighbors() ?? []) {
      connectPair(id, targetId)
    }
  }

  await waitFor(() => {
    for (const id of peerIds) {
      const snap = rooms.get(id)!.getTopology()
      if (
        snap.roomPeerIds.length !== peerIds.length - 1 ||
        Object.keys(snap.routes).length !== peerIds.length - 1
      ) {
        return false
      }
    }
    return true
  }, 5_000)

  const cleanup = async () => {
    await Promise.all([...rooms.values()].map(r => r.leave()))
    for (const pair of directLinks.values()) {
      pair.peerA.destroy()
      pair.peerB.destroy()
    }
    directLinks.clear()
  }

  return {
    roomId,
    peerIds,
    rooms,
    registerCallbacks,
    directLinks,
    joinedByPeer,
    leftByPeer,
    connectPair,
    cleanup
  }
}

export const linkHandles = () =>
  linkPeers(new LinkedPeer(), new LinkedPeer()) as unknown as {
    peerA: PeerHandle
    peerB: PeerHandle
  }

export const makeOverlayPipe = (
  fromId: string,
  to: OverlayManager,
  state: {alive: boolean; bufferedAmount?: number} = {alive: true},
  onSend?: (data: Uint8Array) => void
): PeerHandle => ({
  get isDead() {
    return !state.alive
  },
  connection: {} as unknown as RTCPeerConnection,
  channel: {
    get readyState() {
      return state.alive ? 'open' : 'closed'
    },
    get bufferedAmount() {
      return state.bufferedAmount ?? 0
    }
  } as unknown as RTCDataChannel,
  getOffer: async () => undefined,
  signal: async () => undefined,
  sendData: (data: Uint8Array) => {
    if (!state.alive) {
      throw new Error('link down')
    }
    onSend?.(data)
    to.handleOverlayFrame(fromId, data.slice().buffer)
  },
  destroy: () => {
    state.alive = false
  },
  setHandlers: () => {},
  addStream: () => {},
  removeStream: () => {},
  addTrack: () => ({}) as never,
  removeTrack: () => {},
  replaceTrack: async () => {}
})
