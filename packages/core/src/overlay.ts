import {inspectActionWireHeader} from './action-wire'
import {ecdsaSign, sha1, sha256} from './crypto'
import {
  canonicalizePubJwk,
  getCachedPubKeyRecord,
  getOrCreateEndpointIdentity,
  isPeerIdKeyCachedValid,
  isUserEndpointProofCachedValid,
  signUserEndpointProof,
  verifyPeerIdKey,
  verifyUserEndpointProof,
  verifyWithP256
} from './identity'
import {
  all,
  createBoundedCache,
  createBoundedSet,
  decodeBytes,
  definePlugin,
  encodeBytes,
  fromBase64,
  fromJson,
  genId,
  keys,
  mkErr,
  noOp,
  resetTimer,
  selfId as defaultSelfId,
  toBase64,
  toHex,
  toJson
} from './utils'
import type {
  JsonValue,
  PeerHandle,
  PeerHandlers,
  RoleCertificate,
  RoomPlugin,
  Signal,
  TopologyConfig,
  TopologyMediaTree,
  TopologyMode,
  TopologyRoute,
  TopologySnapshot,
  TopologyStats,
  UserIdentity
} from './types'

export const overlayFrameVersion = 3

const overlayControlKind = 1
const overlayBroadcastKind = 2
const overlayUnicastKind = 3

const defaultMaxConnections = 6
const defaultMinConnections = 3
const defaultAutoThreshold = 12
const defaultFanout = 3
const defaultRedundancy = 1
const defaultMaxHops = 8
const maxSeenMessages = 4_096
const maxCachedBroadcasts = 256
const churnBoostWindowMs = 4_000
const unreachableGraceMs = 80

export type ResolvedTopologyConfig = {
  mode: TopologyMode
  maxConnections: number
  minConnections: number
  autoThreshold: number
  fanout: number
  redundancy: number
  maxHops: number
}

export type OverlayStreamInfo = {
  key: string
  streamId: string
  trackIds: string[]
  metadata?: JsonValue
}

export type PeerDescriptor = {
  peerId: string
  seq: number
  neighbors: string[]
  streams?: OverlayStreamInfo[]
  signPubKey?: JsonWebKey
  encPubKey?: JsonWebKey
  userId?: string
  userPubKey?: JsonWebKey
  userProof?: string
  cert?: RoleCertificate
  roomAuth?: string
  sig?: string
}

type OverlayControlMessage =
  | {
      t: 'gossip'
      descriptors: PeerDescriptor[]
      down?: string[]
    }
  | {
      t: 'leave'
      peerId: string
      seq: number
      sig?: string
    }
  | {
      t: 'ihave'
      items: Array<{m: string; o: string}>
    }
  | {
      t: 'iwant'
      ids: string[]
    }
  | {
      t: 'prune'
      peerId: string
    }

type BroadcastEnvelopeHeader = {
  o: string
  m: string
  s?: string
}

type UnicastEnvelopeHeader = {
  o: string
  d: string
  m: string
  iv?: string
  s?: string
}

const validModes = new Set<TopologyMode>([
  'mesh',
  'auto',
  'gossip',
  'broadcast'
])

export const normalizeTopologyConfig = (
  topology?: TopologyMode | TopologyConfig
): ResolvedTopologyConfig => {
  if (!topology) {
    return {
      mode: 'auto',
      maxConnections: defaultMaxConnections,
      minConnections: defaultMinConnections,
      autoThreshold: defaultAutoThreshold,
      fanout: defaultFanout,
      redundancy: defaultRedundancy,
      maxHops: defaultMaxHops
    }
  }

  const raw: TopologyConfig =
    typeof topology === 'string' ? {mode: topology} : topology
  const mode = raw.mode ?? 'auto'

  if (!validModes.has(mode)) {
    throw mkErr(`invalid topology mode "${String(mode)}"`)
  }

  const fanout = raw.fanout ?? defaultFanout
  if (!Number.isSafeInteger(fanout) || fanout < 2) {
    throw mkErr('scale.fanout must be an integer >= 2')
  }

  const maxConnections =
    raw.maxConnections ??
    (mode === 'broadcast' ? fanout + 3 : defaultMaxConnections)
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 2) {
    throw mkErr('scale.maxConnections must be an integer >= 2')
  }

  const minConnections =
    raw.minConnections ?? Math.min(defaultMinConnections, maxConnections)
  if (
    !Number.isSafeInteger(minConnections) ||
    minConnections < 1 ||
    minConnections > maxConnections
  ) {
    throw mkErr('scale.minConnections must be between 1 and maxConnections')
  }

  const autoThreshold = raw.autoThreshold ?? defaultAutoThreshold
  if (!Number.isSafeInteger(autoThreshold) || autoThreshold < 2) {
    throw mkErr('scale.autoThreshold must be an integer >= 2')
  }

  const redundancy = raw.redundancy ?? defaultRedundancy
  if (!Number.isSafeInteger(redundancy) || redundancy < 1) {
    throw mkErr('scale.redundancy must be an integer >= 1')
  }

  const maxHops = raw.maxHops ?? defaultMaxHops
  if (!Number.isSafeInteger(maxHops) || maxHops < 1 || maxHops > 64) {
    throw mkErr('scale.maxHops must be between 1 and 64')
  }

  return {
    mode,
    maxConnections,
    minConnections,
    autoThreshold,
    fanout,
    redundancy,
    maxHops
  }
}

export const computeTargetNeighbors = (
  localPeerId: string,
  rosterIds: Iterable<string>,
  activeMode: 'mesh' | 'gossip' | 'broadcast',
  maxConnections: number,
  fanout: number,
  privilegedPeers?: ReadonlySet<string>
): Set<string> => {
  const unique = new Set<string>(rosterIds)
  unique.add(localPeerId)
  const sorted = [...unique].sort((a, b) => {
    if (privilegedPeers && privilegedPeers.size > 0) {
      const aPriv = privilegedPeers.has(a) ? 0 : 1
      const bPriv = privilegedPeers.has(b) ? 0 : 1
      if (aPriv !== bPriv) {
        return aPriv - bPriv
      }
    }
    return a < b ? -1 : a > b ? 1 : 0
  })
  const total = sorted.length
  const selfIdx = sorted.indexOf(localPeerId)
  const targets = new Set<string>()

  if (total <= 1 || selfIdx < 0) {
    return targets
  }

  if (activeMode === 'mesh' || total - 1 <= maxConnections) {
    for (const id of sorted) {
      if (id !== localPeerId) {
        targets.add(id)
      }
    }
    return targets
  }

  if (activeMode === 'broadcast') {
    if (selfIdx > 0) {
      const parentIdx = Math.floor((selfIdx - 1) / fanout)
      const parentId = sorted[parentIdx]
      if (parentId && parentId !== localPeerId) {
        targets.add(parentId)
      }
    }

    for (let k = 1; k <= fanout; k++) {
      const childIdx = selfIdx * fanout + k
      const childId = sorted[childIdx]
      if (childId && childId !== localPeerId) {
        targets.add(childId)
      }
    }

    // Ring predecessor and successor provide symmetric backup paths if a tree parent drops.
    const prevId = sorted[(selfIdx - 1 + total) % total]
    const nextId = sorted[(selfIdx + 1) % total]
    if (prevId && prevId !== localPeerId) {
      targets.add(prevId)
    }
    if (nextId && nextId !== localPeerId) {
      targets.add(nextId)
    }

    return targets
  }

  // 'gossip': Circulant ring + symmetric multi-scale logarithmic/halving chords.
  const addSymmetricOffset = (offset: number): void => {
    const norm = ((offset % total) + total) % total
    if (norm === 0) {
      return
    }
    const forward = sorted[(selfIdx + norm) % total]
    const backward = sorted[(selfIdx - norm + total) % total]
    const toAdd = new Set<string>()
    if (forward && forward !== localPeerId && !targets.has(forward)) {
      toAdd.add(forward)
    }
    if (backward && backward !== localPeerId && !targets.has(backward)) {
      toAdd.add(backward)
    }
    if (toAdd.size > 0 && targets.size + toAdd.size <= maxConnections) {
      for (const id of toAdd) {
        targets.add(id)
      }
    }
  }

  // 1. Ring neighbors guarantee a single connected Hamiltonian cycle.
  addSymmetricOffset(1)

  // 2. Geometric multi-scale chords across [2, floor(total / 3)] yield O(log N) diameter.
  const numChordPairs = Math.max(0, Math.floor(maxConnections / 2) - 1)
  const maxChordSpan = Math.max(2, Math.floor(total / 3))
  const candidateOffsets: number[] = []

  for (let i = 1; i <= numChordPairs; i++) {
    const ratio = i / numChordPairs
    const geomOffset = Math.max(2, Math.round(Math.pow(maxChordSpan, ratio)))
    candidateOffsets.push(geomOffset)
  }

  candidateOffsets.push(
    Math.max(2, Math.floor(Math.sqrt(total))),
    Math.floor(total / 4),
    Math.floor(total / 3),
    Math.floor(total / 2),
    2,
    3,
    5,
    7,
    11
  )

  for (const offset of candidateOffsets) {
    if (targets.size >= maxConnections) {
      break
    }
    if (offset >= 2) {
      addSymmetricOffset(offset)
    }
  }

  return targets
}

const buildUndirectedGraph = (
  adjacency: Map<string, Set<string>>,
  localPeerId?: string,
  directSet?: Iterable<string>
): Map<string, Set<string>> => {
  const graph = new Map<string, Set<string>>()
  const ensureNode = (u: string): Set<string> => {
    let set = graph.get(u)
    if (!set) {
      set = new Set()
      graph.set(u, set)
    }
    return set
  }

  if (localPeerId && directSet) {
    for (const d of directSet) {
      ensureNode(localPeerId).add(d)
      ensureNode(d).add(localPeerId)
    }
  }

  for (const [u, neighbors] of adjacency.entries()) {
    for (const v of neighbors) {
      ensureNode(u).add(v)
      ensureNode(v).add(u)
    }
  }

  return graph
}

export const computeShortestPathRoutes = (
  localPeerId: string,
  adjacency: Map<string, Set<string>>,
  directPeerIds: Iterable<string>
): Record<string, TopologyRoute> => {
  const routes: Record<string, TopologyRoute> = {}
  const directSet = new Set(directPeerIds)
  const graph = buildUndirectedGraph(adjacency, localPeerId, directSet)

  const visited = new Map<string, {nextHop: string; hops: number}>()
  const backupNextHops = new Map<string, string>()
  const queue: Array<{node: string; nextHop: string; hops: number}> = []

  const sortedDirect = [...directSet].sort()
  for (const d of sortedDirect) {
    visited.set(d, {nextHop: d, hops: 1})
    queue.push({node: d, nextHop: d, hops: 1})
  }

  let head = 0
  while (head < queue.length) {
    const {node, nextHop, hops} = queue[head++]!
    const neighbors = [...(graph.get(node) ?? [])].sort()

    for (const neighbor of neighbors) {
      if (neighbor === localPeerId) {
        continue
      }

      const existing = visited.get(neighbor)
      if (!existing) {
        visited.set(neighbor, {nextHop, hops: hops + 1})
        queue.push({node: neighbor, nextHop, hops: hops + 1})
      } else if (
        existing.nextHop !== nextHop &&
        !backupNextHops.has(neighbor)
      ) {
        backupNextHops.set(neighbor, nextHop)
      }
    }
  }

  for (const [peerId, info] of visited.entries()) {
    const backup = backupNextHops.get(peerId)
    routes[peerId] = {
      nextHop: info.nextHop,
      hops: info.hops,
      ...(backup ? {backupNextHop: backup} : {})
    }
  }

  return routes
}

export const computeMediaTreeChildren = (
  broadcasterId: string,
  localPeerId: string,
  adjacency: Map<string, Set<string>>,
  fanout: number
): {parentId: string | null; childrenIds: string[]} => {
  const graph = buildUndirectedGraph(adjacency)

  const parentMap = new Map<string, string | null>([[broadcasterId, null]])
  const childrenMap = new Map<string, string[]>()
  const queue: string[] = [broadcasterId]

  const runBfsQueue = (): void => {
    let head = 0
    while (head < queue.length) {
      const u = queue[head++]!
      const currentChildren = childrenMap.get(u) ?? []
      const availableSlots = Math.max(0, fanout - currentChildren.length)
      if (availableSlots <= 0) {
        continue
      }

      const unvisited = [...(graph.get(u) ?? [])]
        .filter(v => !parentMap.has(v))
        .sort()

      if (unvisited.length === 0) {
        continue
      }

      const slice = unvisited.slice(0, availableSlots)
      for (const v of slice) {
        parentMap.set(v, u)
        currentChildren.push(v)
        queue.push(v)
      }

      childrenMap.set(u, currentChildren)
    }
  }

  runBfsQueue()

  // Fallback pass only if a 1-connected bridge left any reachable node unvisited
  let attachedBridge = true
  while (attachedBridge) {
    attachedBridge = false
    for (const u of parentMap.keys()) {
      const unvisited = [...(graph.get(u) ?? [])]
        .filter(v => !parentMap.has(v))
        .sort()
      if (unvisited.length > 0) {
        const v = unvisited[0]!
        const currentChildren = childrenMap.get(u) ?? []
        parentMap.set(v, u)
        currentChildren.push(v)
        childrenMap.set(u, currentChildren)
        queue.length = 0
        queue.push(v)
        runBfsQueue()
        attachedBridge = true
        break
      }
    }
  }

  return {
    parentId: parentMap.get(localPeerId) ?? null,
    childrenIds: childrenMap.get(localPeerId) ?? []
  }
}

const packOverlayBinary = (
  kind: number,
  ttl: number,
  header: Record<string, unknown>,
  payload: Uint8Array
): Uint8Array => {
  const headerBytes = encodeBytes(toJson(header))
  const frame = new Uint8Array(5 + headerBytes.byteLength + payload.byteLength)
  frame[0] = overlayFrameVersion
  frame[1] = kind
  frame[2] = ttl & 0xff
  frame[3] = (headerBytes.byteLength >>> 8) & 0xff
  frame[4] = headerBytes.byteLength & 0xff
  frame.set(headerBytes, 5)
  frame.set(payload, 5 + headerBytes.byteLength)
  return frame
}

const unpackOverlayBinary = (
  bytes: Uint8Array
): {
  kind: number
  ttl: number
  header: Record<string, unknown>
  payload: Uint8Array
} | null => {
  if (bytes.byteLength < 5 || bytes[0] !== overlayFrameVersion) {
    return null
  }
  const kind = bytes[1]!
  const ttl = bytes[2]!
  const headerLen = (bytes[3]! << 8) | bytes[4]!
  if (headerLen <= 0 || 5 + headerLen > bytes.byteLength) {
    return null
  }
  try {
    const header = fromJson<Record<string, unknown>>(
      decodeBytes(bytes.subarray(5, 5 + headerLen))
    )
    if (!header || typeof header !== 'object' || Array.isArray(header)) {
      return null
    }
    return {
      kind,
      ttl,
      header,
      payload: bytes.subarray(5 + headerLen)
    }
  } catch {
    return null
  }
}

const packOverlayControl = (msg: OverlayControlMessage): Uint8Array => {
  const body = encodeBytes(toJson(msg))
  const frame = new Uint8Array(2 + body.byteLength)
  frame[0] = overlayFrameVersion
  frame[1] = overlayControlKind
  frame.set(body, 2)
  return frame
}

const descriptorCanonicalPayload = (d: PeerDescriptor): string =>
  toJson([
    d.peerId,
    d.seq,
    d.neighbors,
    d.streams ?? [],
    d.signPubKey ?? null,
    d.encPubKey ?? null,
    d.roomAuth ?? null,
    d.cert?.sig ?? null,
    ...(d.userId ? [d.userId, d.userPubKey ?? null, d.userProof ?? null] : [])
  ])

const computeRoomAuthToken = async (
  password: string,
  appId: string,
  roomId: string,
  peerId: string,
  seq: number
): Promise<string> =>
  toHex(
    await sha256(
      `trystero-ov-auth:${password}:${appId}:${roomId}:${peerId}:${seq}`
    )
  )

type CryptoIdentity = {
  signPrivateKey: CryptoKey
  signPublicKey: CryptoKey
  signPubJwk: JsonWebKey
  encPrivateKey: CryptoKey
  encPublicKey: CryptoKey
  encPubJwk: JsonWebKey
}

const identityCache = new Map<string, Promise<CryptoIdentity>>()
const verifiedSigBytes = createBoundedCache<string, Uint8Array>()

const bytesMatch = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.byteLength !== b.byteLength) {
    return false
  }
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) {
      return false
    }
  }
  return true
}

const rememberVerifiedSig = (cacheKey: string, bytes: Uint8Array): void => {
  verifiedSigBytes.set(cacheKey, bytes.slice())
}

const getOrCreateCryptoIdentity = (peerId: string): Promise<CryptoIdentity> => {
  let cached = identityCache.get(peerId)
  if (!cached) {
    cached = (async () => {
      const [endpointId, encPair] = await all([
        getOrCreateEndpointIdentity(peerId),
        crypto.subtle.generateKey({name: 'ECDH', namedCurve: 'P-256'}, true, [
          'deriveKey',
          'deriveBits'
        ])
      ])
      const encPubJwk = await crypto.subtle.exportKey('jwk', encPair.publicKey)
      return {
        signPrivateKey: endpointId.signPrivateKey,
        signPublicKey: endpointId.signPublicKey,
        signPubJwk: endpointId.signPubJwk,
        encPrivateKey: encPair.privateKey,
        encPublicKey: encPair.publicKey,
        encPubJwk
      }
    })()
    identityCache.set(peerId, cached)
  }
  return cached
}

export type OverlayManagerDeps = {
  selfId?: string
  appId?: string
  roomId?: string
  password?: string
  topology?: TopologyMode | TopologyConfig
  getLocalUserIdentity?: () => Promise<UserIdentity> | UserIdentity
  onVirtualPeerJoin: (peerId: string, virtualPeer: PeerHandle) => void
  onVirtualPeerLeave: (peerId: string, reason?: Error) => void
  onDeliverData: (originPeerId: string, data: ArrayBuffer) => void
  canPeerSendAction?: (
    peerId: string,
    requiredRoles: readonly string[],
    inlineCert?: RoleCertificate
  ) => Promise<boolean> | boolean
  onPeerDescriptorCert?: (
    peerId: string,
    signPubKey: JsonWebKey,
    cert?: RoleCertificate,
    userId?: string,
    userPubKey?: JsonWebKey
  ) => void
  onRelayMediaStream?: (
    broadcasterId: string,
    stream: MediaStream,
    metadata: JsonValue | undefined,
    targetPeerIds: string[],
    streamKey: string,
    tracks?: MediaStreamTrack[]
  ) => void
  onRelayMediaTrack?: (
    broadcasterId: string,
    track: MediaStreamTrack,
    stream: MediaStream,
    metadata: JsonValue | undefined,
    targetPeerIds: string[],
    trackKey: string
  ) => void
}

export type OverlayManager = {
  config: ResolvedTopologyConfig
  isOverlayActive: () => boolean
  getActiveMode: () => 'mesh' | 'gossip' | 'broadcast'
  isOverlayFrame: (data: ArrayBuffer) => boolean
  handleOverlayFrame: (fromPeerId: string, data: ArrayBuffer) => void
  addDirectPeer: (peerId: string, peer: PeerHandle) => void
  removeDirectPeer: (peerId: string, peer?: PeerHandle) => boolean
  isDirectPeer: (peerId: string) => boolean
  isVirtualPeer: (peerId: string) => boolean
  getRoute: (peerId: string) => TopologyRoute | undefined
  hasReachableRoute: (peerId: string) => boolean
  createVirtualPeer: (peerId: string) => PeerHandle
  broadcastInline: (
    frame: Uint8Array,
    onProgress?: (peerId: string) => void
  ) => Promise<boolean>
  sendUnicast: (targetPeerId: string, frame: Uint8Array) => void
  getMediaTargets: (broadcasterId?: string) => string[]
  registerBroadcastStream: (
    broadcasterId: string,
    streamKey: string,
    stream: MediaStream,
    metadata?: JsonValue
  ) => void
  unregisterBroadcastStream: (
    broadcasterId: string,
    stream: MediaStream
  ) => string[]
  unregisterBroadcastStreamById: (
    broadcasterId: string,
    streamId: string
  ) => {stream: MediaStream; targets: string[]} | null
  registerBroadcastTrack: (
    broadcasterId: string,
    trackKey: string,
    track: MediaStreamTrack,
    stream: MediaStream,
    metadata?: JsonValue
  ) => void
  unregisterBroadcastTrack: (
    broadcasterId: string,
    trackId: string,
    trackKeys?: string[]
  ) => Array<{track: MediaStreamTrack; key: string; targets: string[]}>
  replaceBroadcastTrack: (
    broadcasterId: string,
    oldTrack: MediaStreamTrack,
    newTrack: MediaStreamTrack,
    metadata?: JsonValue
  ) => void
  requireDirectPeer: (peerId: string) => void
  notePeerDiscovered: (peerId: string) => void
  shouldConnectPeer: (
    peerId: string,
    direction: 'outbound' | 'inbound'
  ) => boolean
  getTargetNeighbors: () => Set<string>
  setOnTargetsChanged: (cb: (targetPeerIds: string[]) => void) => void
  announceLeave: () => void
  destroy: () => void
  getSnapshot: () => TopologySnapshot
  getLocalCryptoIdentity: () => Promise<CryptoIdentity>
  getPeerSignPublicKey: (peerId: string) => JsonWebKey | undefined
  setPeerSignPublicKey: (peerId: string, pubKey: JsonWebKey) => void
  setLocalRoleCertificate: (cert: RoleCertificate | null) => void
  setPrivilegedPeer: (peerId: string, isPrivileged: boolean) => void
  markPeerBanned: (peerId: string, keyThumbprint?: string) => void
  isPeerBanned: (peerId: string) => boolean
  registerActionAuthority: (actionType: string, roles: string[]) => void
  recordSignatureFailure: () => void
  setRoomId: (effectiveRoomId: string) => void
}

export const createOverlayManager = ({
  selfId = defaultSelfId,
  appId = '',
  roomId: initialRoomId = '',
  password = '',
  topology,
  getLocalUserIdentity,
  onVirtualPeerJoin,
  onVirtualPeerLeave,
  onDeliverData,
  canPeerSendAction,
  onPeerDescriptorCert,
  onRelayMediaStream,
  onRelayMediaTrack
}: OverlayManagerDeps): OverlayManager => {
  void getOrCreateEndpointIdentity(selfId)
  let roomId = initialRoomId
  const config = normalizeTopologyConfig(topology)
  let targetsChangedCallback: ((targetPeerIds: string[]) => void) | null = null
  const directPeers = new Map<string, PeerHandle>()
  const requiredDirectPeers = new Set<string>()
  const virtualPeers = new Map<string, PeerHandle>()
  const knownRoster = new Set<string>([selfId])
  const privilegedPeers = new Set<string>()
  const bannedPeers = new Set<string>()
  const bannedKeyThumbprints = new Set<string>()
  const peerSignPubKeys = new Map<string, JsonWebKey>()
  const actionAuthorities = new Map<string, string[]>()
  let localRoleCert: RoleCertificate | null = null
  const descriptors = new Map<string, PeerDescriptor>()
  const adjacency = new Map<string, Set<string>>()
  const pinnedSignKeys = new Map<string, string>()
  const derivedPairwiseKeys = new Map<string, Promise<CryptoKey>>()
  const prunedDirectPeers = new Set<string>()
  const departedPeers = new Set<string>()
  const downPeersSeq = new Map<string, number>()
  const unreachableTimers = new Map<string, ReturnType<typeof setTimeout>>()

  // Seen-message deduplication cache and recent broadcast cache for Plumtree lazy repair
  const seenMessages = createBoundedSet<string>(maxSeenMessages)
  const cachedBroadcastFrames = createBoundedCache<string, Uint8Array>(
    maxCachedBroadcasts
  )
  const missingBroadcastTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >()

  // Active broadcast streams/tracks (both local and relayed) for automatic tree distribution & healing
  const activeStreams = new Map<
    string,
    {
      broadcasterId: string
      streamKey: string
      stream: MediaStream
      tracks?: MediaStreamTrack[]
      metadata?: JsonValue
      forwardedTo: Set<string>
      currentParentId: string | null
    }
  >()
  const activeTracks = new Map<
    string,
    {
      broadcasterId: string
      trackKey: string
      track: MediaStreamTrack
      stream: MediaStream
      metadata?: JsonValue
      forwardedTo: Set<string>
    }
  >()

  let localSeq = 0
  let lastChurnAtMs = 0
  let isDestroyed = false
  let currentActiveMode: 'mesh' | 'gossip' | 'broadcast' =
    config.mode === 'auto' ? 'mesh' : config.mode
  let routes: Record<string, TopologyRoute> = {}
  let identityReady: CryptoIdentity | null = null

  const stats: TopologyStats = {
    messagesSent: 0,
    messagesReceived: 0,
    messagesForwarded: 0,
    duplicatesDropped: 0,
    signatureFailures: 0,
    lazyRepairsSent: 0,
    lazyRepairsResolved: 0,
    treeReparents: 0
  }

  if (config.mode === 'gossip' || config.mode === 'broadcast') {
    void getOrCreateCryptoIdentity(selfId).then(id => {
      if (!isDestroyed) {
        identityReady = id
        if (directPeers.size > 0) {
          void publishLocalDescriptor()
        }
      }
    })
  }

  const updateActiveMode = (): void => {
    if (config.mode === 'mesh') {
      currentActiveMode = 'mesh'
      return
    }
    if (config.mode === 'gossip' || config.mode === 'broadcast') {
      currentActiveMode = config.mode
      return
    }
    // 'auto' mode with hysteresis
    const totalKnown = Math.max(
      knownRoster.size,
      descriptors.size + 1,
      directPeers.size + 1
    )
    if (currentActiveMode === 'mesh' && totalKnown > config.autoThreshold) {
      currentActiveMode = 'gossip'
    } else if (
      currentActiveMode !== 'mesh' &&
      totalKnown <= Math.max(2, Math.floor(config.autoThreshold * 0.75))
    ) {
      currentActiveMode = 'mesh'
    }
  }

  const isOverlayActive = (): boolean => {
    updateActiveMode()
    if (config.mode === 'mesh') {
      return false
    }
    if (config.mode !== 'auto') {
      return true
    }
    return (
      currentActiveMode !== 'mesh' ||
      directPeers.size >= 2 ||
      knownRoster.size > 2 ||
      descriptors.size > 0
    )
  }

  const rememberSeenMessage = (msgId: string): boolean =>
    seenMessages.add(msgId)

  const cacheBroadcastFrame = (msgId: string, frame: Uint8Array): void => {
    cachedBroadcastFrames.set(msgId, frame)
  }

  const sendToDirectNeighbor = (peerId: string, frame: Uint8Array): boolean => {
    const peer = directPeers.get(peerId)
    if (!peer || peer.isDead || peer.channel?.readyState === 'closed') {
      return false
    }
    try {
      peer.sendData(frame)
      return true
    } catch {
      return false
    }
  }

  const createVirtualPeer = (peerId: string): PeerHandle => {
    const existing = virtualPeers.get(peerId)
    if (existing && !existing.isDead) {
      return existing
    }

    const handlers: PeerHandlers = {}
    let dead = false
    const fallbackConnection = {
      connectionState: 'connected',
      iceConnectionState: 'connected',
      signalingState: 'stable',
      getSenders: () => []
    } as unknown as RTCPeerConnection
    const fallbackChannel = {
      readyState: 'open',
      bufferedAmount: 0,
      bufferedAmountLowThreshold: 0xffff,
      addEventListener: noOp,
      removeEventListener: noOp
    } as unknown as RTCDataChannel

    const handle: PeerHandle = {
      get connection(): RTCPeerConnection {
        const nextHop = routes[peerId]?.nextHop
        const direct = nextHop ? directPeers.get(nextHop) : undefined
        return direct?.connection ?? fallbackConnection
      },
      get channel(): RTCDataChannel | null {
        const nextHop = routes[peerId]?.nextHop
        const direct = nextHop ? directPeers.get(nextHop) : undefined
        return direct?.channel ?? fallbackChannel
      },
      get isDead(): boolean {
        return dead
      },
      getOffer: async () => undefined,
      signal: async (_sdp: Signal) => undefined,
      sendData: (data: Uint8Array) => {
        if (!dead) {
          sendUnicast(peerId, data)
        }
      },
      destroy: () => {
        if (dead) {
          return
        }
        dead = true
        virtualPeers.delete(peerId)
      },
      setHandlers: (newHandlers: PeerHandlers) => {
        Object.assign(handlers, newHandlers)
      },
      addStream: () => {},
      removeStream: () => {},
      addTrack: () => ({}) as never,
      removeTrack: () => {},
      replaceTrack: () => Promise.resolve()
    }

    virtualPeers.set(peerId, handle)
    return handle
  }

  const mediaTreeCache = new Map<
    string,
    {parentId: string | null; childrenIds: string[]}
  >()

  const getCachedTreeChildren = (
    broadcasterId: string,
    fanout: number
  ): {parentId: string | null; childrenIds: string[]} => {
    const cacheKey = `${broadcasterId}:${fanout}`
    let cached = mediaTreeCache.get(cacheKey)
    if (!cached) {
      cached = computeMediaTreeChildren(
        broadcasterId,
        selfId,
        adjacency,
        fanout
      )
      mediaTreeCache.set(cacheKey, cached)
    }
    return cached
  }

  const syncMediaTrees = (): void => {
    if (isDestroyed || !isOverlayActive()) {
      return
    }

    for (const entry of activeStreams.values()) {
      const {parentId, childrenIds} = getCachedTreeChildren(
        entry.broadcasterId,
        config.fanout
      )

      if (
        entry.broadcasterId !== selfId &&
        entry.currentParentId !== null &&
        parentId !== null &&
        entry.currentParentId !== parentId
      ) {
        stats.treeReparents++
      }
      entry.currentParentId = parentId

      const newTargets = childrenIds.filter(
        childId => directPeers.has(childId) && !entry.forwardedTo.has(childId)
      )

      if (newTargets.length > 0) {
        newTargets.forEach(id => entry.forwardedTo.add(id))
        onRelayMediaStream?.(
          entry.broadcasterId,
          entry.stream,
          entry.metadata,
          newTargets,
          entry.streamKey,
          entry.tracks
        )
      }
    }

    for (const entry of activeTracks.values()) {
      const {childrenIds} = getCachedTreeChildren(
        entry.broadcasterId,
        config.fanout
      )
      const newTargets = childrenIds.filter(
        childId => directPeers.has(childId) && !entry.forwardedTo.has(childId)
      )

      if (newTargets.length > 0) {
        newTargets.forEach(id => entry.forwardedTo.add(id))
        onRelayMediaTrack?.(
          entry.broadcasterId,
          entry.track,
          entry.stream,
          entry.metadata,
          newTargets,
          entry.trackKey
        )
      }
    }
  }

  const purgePeerFromGraph = (peerId: string): void => {
    descriptors.delete(peerId)
    adjacency.delete(peerId)
    knownRoster.delete(peerId)
    for (const set of adjacency.values()) {
      set.delete(peerId)
    }
  }

  const recomputeTopologyAndRoutes = (): void => {
    if (isDestroyed) {
      return
    }

    for (const downId of departedPeers) {
      if (!directPeers.has(downId)) {
        purgePeerFromGraph(downId)
      }
    }

    updateActiveMode()
    adjacency.set(selfId, new Set(directPeers.keys()))
    mediaTreeCache.clear()

    routes = computeShortestPathRoutes(selfId, adjacency, directPeers.keys())

    if (!isOverlayActive()) {
      return
    }

    // Activate virtual peers for any newly reachable multi-hop room members
    for (const peerId of keys(routes)) {
      if (peerId === selfId || departedPeers.has(peerId)) {
        continue
      }

      const timer = unreachableTimers.get(peerId)
      if (timer) {
        resetTimer(timer)
        unreachableTimers.delete(peerId)
      }

      if (
        !directPeers.has(peerId) &&
        !virtualPeers.has(peerId) &&
        descriptors.has(peerId)
      ) {
        const vPeer = createVirtualPeer(peerId)
        onVirtualPeerJoin(peerId, vPeer)
      }
    }

    // Check if any virtual peer is no longer reachable in the graph
    for (const [peerId] of virtualPeers.entries()) {
      if (directPeers.has(peerId)) {
        continue
      }
      if (!routes[peerId] || departedPeers.has(peerId)) {
        if (departedPeers.has(peerId)) {
          const timer = unreachableTimers.get(peerId)
          if (timer) {
            resetTimer(timer)
            unreachableTimers.delete(peerId)
          }
          virtualPeers.get(peerId)?.destroy()
          virtualPeers.delete(peerId)
          purgePeerFromGraph(peerId)
          onVirtualPeerLeave(peerId, mkErr('peer left room'))
        } else if (!unreachableTimers.has(peerId)) {
          unreachableTimers.set(
            peerId,
            setTimeout(() => {
              unreachableTimers.delete(peerId)
              if (!isDestroyed && !directPeers.has(peerId) && !routes[peerId]) {
                virtualPeers.get(peerId)?.destroy()
                virtualPeers.delete(peerId)
                purgePeerFromGraph(peerId)
                onVirtualPeerLeave(peerId, mkErr('peer disconnected'))
              }
            }, unreachableGraceMs)
          )
        }
      }
    }

    syncMediaTrees()

    if (targetsChangedCallback && currentActiveMode !== 'mesh') {
      const targets = computeTargetNeighbors(
        selfId,
        knownRoster,
        currentActiveMode,
        config.maxConnections,
        config.fanout,
        privilegedPeers
      )
      requiredDirectPeers.forEach(id => targets.add(id))
      const missing = [...targets].filter(id => !directPeers.has(id))
      if (missing.length > 0) {
        targetsChangedCallback(missing)
      }
    }
  }

  const buildLocalDescriptor = async (): Promise<PeerDescriptor> => {
    const seq = ++localSeq
    const neighbors = [...directPeers.keys()].sort()
    const streams: OverlayStreamInfo[] = []

    for (const entry of activeStreams.values()) {
      if (entry.broadcasterId === selfId) {
        streams.push({
          key: entry.streamKey,
          streamId: entry.stream.id,
          trackIds: entry.stream.getTracks?.().map(t => t.id) ?? [],
          ...(entry.metadata === undefined ? {} : {metadata: entry.metadata})
        })
      }
    }

    const descriptor: PeerDescriptor = {
      peerId: selfId,
      seq,
      neighbors,
      ...(streams.length > 0 ? {streams} : {}),
      ...(localRoleCert ? {cert: localRoleCert} : {})
    }

    if (password) {
      descriptor.roomAuth = await computeRoomAuthToken(
        password,
        appId,
        roomId,
        selfId,
        seq
      )
    }

    const id = identityReady ?? (await getOrCreateCryptoIdentity(selfId))
    identityReady = id
    descriptor.signPubKey = id.signPubJwk
    descriptor.encPubKey = id.encPubJwk
    if (getLocalUserIdentity) {
      const userIdentity = await getLocalUserIdentity()
      descriptor.userId = userIdentity.userId
      descriptor.userPubKey = userIdentity.signPubJwk
      descriptor.userProof = await signUserEndpointProof(userIdentity, {
        appId,
        roomId,
        peerId: selfId,
        peerPubJwk: id.signPubJwk,
        seq
      })
    }
    const canonicalBytes = encodeBytes(descriptorCanonicalPayload(descriptor))
    const sig = toBase64(
      await ecdsaSign(id.signPrivateKey, canonicalBytes as BufferSource)
    )
    descriptor.sig = sig
    rememberVerifiedSig(`desc:${toJson(id.signPubJwk)}:${sig}`, canonicalBytes)

    return descriptor
  }

  const tryVerifyDescriptorCached = (d: PeerDescriptor): boolean => {
    if (
      password ||
      !d ||
      typeof d.peerId !== 'string' ||
      !d.peerId ||
      typeof d.seq !== 'number' ||
      !Array.isArray(d.neighbors) ||
      bannedPeers.has(d.peerId) ||
      !d.signPubKey ||
      typeof d.sig !== 'string' ||
      !d.sig ||
      !isPeerIdKeyCachedValid(d.peerId, d.signPubKey)
    ) {
      return false
    }

    if (
      Boolean(getLocalUserIdentity) ||
      d.userId !== undefined ||
      d.userPubKey !== undefined ||
      d.userProof !== undefined
    ) {
      if (
        !d.userId ||
        !d.userPubKey ||
        !d.userProof ||
        !isUserEndpointProofCachedValid({
          appId,
          roomId,
          peerId: d.peerId,
          peerPubJwk: d.signPubKey,
          userId: d.userId,
          userPubJwk: d.userPubKey,
          proof: d.userProof,
          seq: d.seq
        })
      ) {
        return false
      }
    }

    const keyThumbprint = toJson(d.signPubKey)
    const canonicalThumbprint =
      typeof d.signPubKey.x === 'string' && typeof d.signPubKey.y === 'string'
        ? canonicalizePubJwk(d.signPubKey)
        : keyThumbprint
    if (
      bannedKeyThumbprints.has(keyThumbprint) ||
      bannedKeyThumbprints.has(canonicalThumbprint)
    ) {
      return false
    }
    const pinned = pinnedSignKeys.get(d.peerId)
    if (pinned && pinned !== keyThumbprint) {
      return false
    }

    const canonicalBytes = encodeBytes(descriptorCanonicalPayload(d))
    const sigCacheKey = `desc:${keyThumbprint}:${d.sig}`
    const cachedVerifiedBytes = verifiedSigBytes.get(sigCacheKey)
    if (
      !cachedVerifiedBytes ||
      !bytesMatch(cachedVerifiedBytes, canonicalBytes)
    ) {
      return false
    }

    pinnedSignKeys.set(d.peerId, keyThumbprint)
    peerSignPubKeys.set(d.peerId, d.signPubKey)
    onPeerDescriptorCert?.(
      d.peerId,
      d.signPubKey,
      d.cert,
      d.userId,
      d.userPubKey
    )
    return true
  }

  const verifyDescriptor = async (d: PeerDescriptor): Promise<boolean> => {
    if (
      !d ||
      typeof d.peerId !== 'string' ||
      !d.peerId ||
      typeof d.seq !== 'number' ||
      !Array.isArray(d.neighbors)
    ) {
      return false
    }

    if (bannedPeers.has(d.peerId)) {
      stats.signatureFailures++
      return false
    }

    if (password) {
      if (!d.roomAuth) {
        stats.signatureFailures++
        return false
      }
      const expectedAuth = await computeRoomAuthToken(
        password,
        appId,
        roomId,
        d.peerId,
        d.seq
      )
      if (d.roomAuth !== expectedAuth) {
        stats.signatureFailures++
        return false
      }
    }

    if (!d.signPubKey || typeof d.sig !== 'string' || !d.sig) {
      stats.signatureFailures++
      return false
    }

    if (!(await verifyPeerIdKey(d.peerId, d.signPubKey))) {
      stats.signatureFailures++
      return false
    }

    if (
      Boolean(getLocalUserIdentity) ||
      d.userId !== undefined ||
      d.userPubKey !== undefined ||
      d.userProof !== undefined
    ) {
      if (
        !d.userId ||
        !d.userPubKey ||
        !d.userProof ||
        !(await verifyUserEndpointProof({
          appId,
          roomId,
          peerId: d.peerId,
          peerPubJwk: d.signPubKey,
          userId: d.userId,
          userPubJwk: d.userPubKey,
          proof: d.userProof,
          seq: d.seq
        }))
      ) {
        stats.signatureFailures++
        return false
      }
    }

    const keyThumbprint = toJson(d.signPubKey)
    const canonicalThumbprint =
      typeof d.signPubKey.x === 'string' && typeof d.signPubKey.y === 'string'
        ? canonicalizePubJwk(d.signPubKey)
        : keyThumbprint
    if (
      bannedKeyThumbprints.has(keyThumbprint) ||
      bannedKeyThumbprints.has(canonicalThumbprint)
    ) {
      bannedPeers.add(d.peerId)
      stats.signatureFailures++
      return false
    }
    const pinned = pinnedSignKeys.get(d.peerId)
    if (pinned && pinned !== keyThumbprint) {
      stats.signatureFailures++
      return false
    }

    const canonicalBytes = encodeBytes(descriptorCanonicalPayload(d))
    const sigCacheKey = `desc:${keyThumbprint}:${d.sig}`
    const cachedVerifiedBytes = verifiedSigBytes.get(sigCacheKey)
    if (
      cachedVerifiedBytes &&
      bytesMatch(cachedVerifiedBytes, canonicalBytes)
    ) {
      pinnedSignKeys.set(d.peerId, keyThumbprint)
      peerSignPubKeys.set(d.peerId, d.signPubKey)
      onPeerDescriptorCert?.(
        d.peerId,
        d.signPubKey,
        d.cert,
        d.userId,
        d.userPubKey
      )
      return true
    }

    try {
      const isValid = await verifyWithP256(
        fromBase64(d.sig),
        canonicalBytes,
        d.signPubKey
      )
      if (!isValid) {
        stats.signatureFailures++
        return false
      }
      rememberVerifiedSig(sigCacheKey, canonicalBytes)
      pinnedSignKeys.set(d.peerId, keyThumbprint)
      peerSignPubKeys.set(d.peerId, d.signPubKey)
      onPeerDescriptorCert?.(
        d.peerId,
        d.signPubKey,
        d.cert,
        d.userId,
        d.userPubKey
      )
      return true
    } catch {
      stats.signatureFailures++
      return false
    }
  }

  const sendGossipToNeighbors = (
    list: PeerDescriptor[],
    excludePeerId?: string,
    downPeers?: string[]
  ): void => {
    if (list.length === 0 && (!downPeers || downPeers.length === 0)) {
      return
    }
    const packet = packOverlayControl({
      t: 'gossip',
      descriptors: list,
      ...(downPeers && downPeers.length > 0 ? {down: downPeers} : {})
    })
    for (const neighborId of directPeers.keys()) {
      if (neighborId !== excludePeerId) {
        sendToDirectNeighbor(neighborId, packet)
      }
    }
  }

  let pendingPublishPromise: Promise<void> | null = null
  let publishDirty = false
  const pendingDownSet = new Set<string>()

  const publishLocalDescriptor = (downPeers?: string[]): Promise<void> => {
    if (isDestroyed || !isOverlayActive()) {
      return Promise.resolve()
    }
    if (downPeers) {
      for (const id of downPeers) {
        pendingDownSet.add(id)
      }
    }
    publishDirty = true
    if (!pendingPublishPromise) {
      pendingPublishPromise = new Promise<void>(resolve => {
        queueMicrotask(async () => {
          while (publishDirty && !isDestroyed && isOverlayActive()) {
            publishDirty = false
            const downBatch =
              pendingDownSet.size > 0 ? [...pendingDownSet] : undefined
            pendingDownSet.clear()

            const signedDescriptor = await buildLocalDescriptor()
            if (isDestroyed) {
              break
            }
            descriptors.set(selfId, signedDescriptor)
            adjacency.set(selfId, new Set(signedDescriptor.neighbors))
            recomputeTopologyAndRoutes()
            sendGossipToNeighbors([signedDescriptor], undefined, downBatch)
          }
          pendingPublishPromise = null
          resolve()
        })
      })
    }
    return pendingPublishPromise
  }

  const getPairwiseKey = (remotePeerId: string): Promise<CryptoKey> | null => {
    const remoteDesc = descriptors.get(remotePeerId)
    if (!remoteDesc?.encPubKey) {
      return null
    }
    let cached = derivedPairwiseKeys.get(remotePeerId)
    if (!cached) {
      const remoteJwk = remoteDesc.encPubKey
      cached = (async () => {
        const id = identityReady ?? (await getOrCreateCryptoIdentity(selfId))
        identityReady = id
        const remotePub = await crypto.subtle.importKey(
          'jwk',
          remoteJwk,
          {name: 'ECDH', namedCurve: 'P-256'},
          false,
          []
        )
        return crypto.subtle.deriveKey(
          {name: 'ECDH', public: remotePub},
          id.encPrivateKey,
          {name: 'AES-GCM', length: 256},
          false,
          ['encrypt', 'decrypt']
        )
      })()
      derivedPairwiseKeys.set(remotePeerId, cached)
    }
    return cached
  }

  const signUnicastOrBroadcast = async (
    canonicalHeader: string,
    payload: Uint8Array
  ): Promise<string> => {
    const id = identityReady ?? (await getOrCreateCryptoIdentity(selfId))
    identityReady = id
    const headerBytes = encodeBytes(canonicalHeader)
    const combined = new Uint8Array(headerBytes.byteLength + payload.byteLength)
    combined.set(headerBytes, 0)
    combined.set(payload, headerBytes.byteLength)
    const sig = toBase64(
      await ecdsaSign(id.signPrivateKey, combined as BufferSource)
    )
    rememberVerifiedSig(`pkt:${toJson(id.signPubJwk)}:${sig}`, combined)
    return sig
  }

  const verifyUnicastOrBroadcast = async (
    originPeerId: string,
    canonicalHeader: string,
    payload: Uint8Array,
    sig: string | undefined
  ): Promise<boolean> => {
    if (!sig) {
      stats.signatureFailures++
      return false
    }
    const signPubJwk =
      peerSignPubKeys.get(originPeerId) ??
      descriptors.get(originPeerId)?.signPubKey
    const pinnedThumbprint =
      pinnedSignKeys.get(originPeerId) ??
      (signPubJwk ? toJson(signPubJwk) : undefined)
    if (!signPubJwk) {
      stats.signatureFailures++
      return false
    }

    const headerBytes = encodeBytes(canonicalHeader)
    const combined = new Uint8Array(headerBytes.byteLength + payload.byteLength)
    combined.set(headerBytes, 0)
    combined.set(payload, headerBytes.byteLength)

    if (pinnedThumbprint) {
      const sigCacheKey = `pkt:${pinnedThumbprint}:${sig}`
      const cachedVerifiedBytes = verifiedSigBytes.get(sigCacheKey)
      if (cachedVerifiedBytes && bytesMatch(cachedVerifiedBytes, combined)) {
        return true
      }
    }

    try {
      const ok = await verifyWithP256(fromBase64(sig), combined, signPubJwk)
      if (!ok) {
        stats.signatureFailures++
        return false
      }
      if (pinnedThumbprint) {
        rememberVerifiedSig(`pkt:${pinnedThumbprint}:${sig}`, combined)
      }
      return true
    } catch {
      stats.signatureFailures++
      return false
    }
  }

  const getEagerAndLazyBroadcastTargets = (
    originPeerId: string,
    excludePeerId?: string
  ): {eager: string[]; lazy: string[]} => {
    const allNeighbors = [...directPeers.keys()].filter(
      id => id !== excludePeerId && id !== originPeerId
    )
    if (allNeighbors.length === 0) {
      return {eager: [], lazy: []}
    }

    const inChurnWindow = Date.now() - lastChurnAtMs < churnBoostWindowMs
    if (inChurnWindow || config.redundancy >= allNeighbors.length) {
      return {eager: allNeighbors, lazy: []}
    }

    // Use the BFS tree rooted at originPeerId for primary eager push
    const {childrenIds} = getCachedTreeChildren(
      originPeerId,
      Math.max(config.fanout, config.maxConnections)
    )
    const eagerSet = new Set<string>(
      childrenIds.filter(id => allNeighbors.includes(id))
    )

    // Ensure at least redundancy paths (or all neighbors if tree hasn't converged yet)
    if (eagerSet.size === 0) {
      allNeighbors.forEach(id => eagerSet.add(id))
    } else if (config.redundancy > 1) {
      for (const id of allNeighbors) {
        if (eagerSet.size >= childrenIds.length + config.redundancy - 1) {
          break
        }
        eagerSet.add(id)
      }
    }

    const eager = [...eagerSet]
    const lazy = allNeighbors.filter(id => !eagerSet.has(id))
    return {eager, lazy}
  }

  const forwardBroadcastPacket = (
    originPeerId: string,
    msgId: string,
    ttl: number,
    header: BroadcastEnvelopeHeader,
    payload: Uint8Array,
    fromPeerId?: string
  ): void => {
    if (ttl <= 0) {
      return
    }
    const packet = packOverlayBinary(overlayBroadcastKind, ttl, header, payload)
    cacheBroadcastFrame(msgId, packet)

    const {eager, lazy} = getEagerAndLazyBroadcastTargets(
      originPeerId,
      fromPeerId
    )
    for (const targetId of eager) {
      sendToDirectNeighbor(targetId, packet)
    }

    if (lazy.length > 0) {
      const ihave = packOverlayControl({
        t: 'ihave',
        items: [{m: msgId, o: originPeerId}]
      })
      for (const lazyId of lazy) {
        sendToDirectNeighbor(lazyId, ihave)
      }
    }
  }

  const broadcastInline = async (
    frame: Uint8Array,
    onProgress?: (peerId: string) => void
  ): Promise<boolean> => {
    if (
      !isOverlayActive() ||
      (currentActiveMode === 'mesh' && virtualPeers.size === 0)
    ) {
      return false
    }

    // If every known peer in the room is already a direct neighbor and redundancy == 1,
    // we can still use direct or overlay broadcast; using overlay broadcast ensures multi-hop reach.
    const msgId = `${selfId}:${genId(12)}`
    rememberSeenMessage(msgId)
    stats.messagesSent++

    const canonical = `${selfId}:${msgId}`
    const sig = await signUnicastOrBroadcast(canonical, frame)
    const header: BroadcastEnvelopeHeader = {
      o: selfId,
      m: msgId,
      ...(sig ? {s: sig} : {})
    }

    forwardBroadcastPacket(selfId, msgId, config.maxHops, header, frame)

    if (onProgress) {
      const allRoomPeers = new Set([...directPeers.keys(), ...keys(routes)])
      allRoomPeers.forEach(peerId => onProgress(peerId))
    }

    return true
  }

  const routeUnicastPacket = (
    destPeerId: string,
    packet: Uint8Array,
    excludePeerId?: string
  ): void => {
    if (directPeers.has(destPeerId) && destPeerId !== excludePeerId) {
      if (sendToDirectNeighbor(destPeerId, packet)) {
        return
      }
    }

    const route = routes[destPeerId]
    if (route && route.nextHop !== excludePeerId) {
      if (sendToDirectNeighbor(route.nextHop, packet)) {
        if (
          config.redundancy > 1 &&
          route.backupNextHop &&
          route.backupNextHop !== excludePeerId
        ) {
          sendToDirectNeighbor(route.backupNextHop, packet)
        }
        return
      }
    }

    if (route?.backupNextHop && route.backupNextHop !== excludePeerId) {
      if (sendToDirectNeighbor(route.backupNextHop, packet)) {
        return
      }
    }

    // Fallback: forward to all direct neighbors except arrival hop
    for (const neighborId of directPeers.keys()) {
      if (neighborId !== excludePeerId) {
        sendToDirectNeighbor(neighborId, packet)
      }
    }
  }

  const outboundUnicastQueues = new Map<string, Promise<void>>()
  const inboundOriginQueues = new Map<string, Promise<void>>()

  const sendUnicast = (targetPeerId: string, frame: Uint8Array): void => {
    if (isDestroyed) {
      return
    }

    if (directPeers.has(targetPeerId)) {
      if (sendToDirectNeighbor(targetPeerId, frame)) {
        stats.messagesSent++
        return
      }
    }

    const msgId = `${selfId}:${genId(12)}`
    rememberSeenMessage(msgId)
    stats.messagesSent++

    const frameCopy = frame.slice()
    const prevQueue =
      outboundUnicastQueues.get(targetPeerId) ?? Promise.resolve()
    const nextQueue = prevQueue
      .then(async () => {
        if (isDestroyed) {
          return
        }
        let payloadToSend: Uint8Array
        let ivB64: string

        const pairwiseKeyP = getPairwiseKey(targetPeerId)
        if (!pairwiseKeyP) {
          return
        }
        try {
          const aesKey = await pairwiseKeyP
          const iv = crypto.getRandomValues(new Uint8Array(12))
          const encrypted = await crypto.subtle.encrypt(
            {name: 'AES-GCM', iv},
            aesKey,
            frameCopy as BufferSource
          )
          payloadToSend = new Uint8Array(encrypted)
          ivB64 = toBase64(iv)
        } catch {
          return
        }

        const canonical = `${selfId}:${targetPeerId}:${msgId}:${ivB64}`
        const sig = await signUnicastOrBroadcast(canonical, payloadToSend)
        if (isDestroyed) {
          return
        }
        const header: UnicastEnvelopeHeader = {
          o: selfId,
          d: targetPeerId,
          m: msgId,
          iv: ivB64,
          s: sig
        }
        const packet = packOverlayBinary(
          overlayUnicastKind,
          config.maxHops,
          header,
          payloadToSend
        )
        routeUnicastPacket(targetPeerId, packet)
      })
      .catch(noOp)
    outboundUnicastQueues.set(targetPeerId, nextQueue)
  }

  const pendingGossipDescriptors = new Map<string, PeerDescriptor>()
  const pendingGossipDown = new Set<string>()
  const pendingGossipSources = new Set<string>()
  let gossipFlushScheduled = false

  const scheduleGossipFlush = (
    newlyUpdated: PeerDescriptor[],
    newDown: string[],
    fromPeerId: string
  ): void => {
    for (const d of newlyUpdated) {
      const prev = pendingGossipDescriptors.get(d.peerId)
      if (!prev || prev.seq < d.seq) {
        pendingGossipDescriptors.set(d.peerId, d)
      }
    }
    for (const downId of newDown) {
      pendingGossipDown.add(downId)
      pendingGossipDescriptors.delete(downId)
    }
    pendingGossipSources.add(fromPeerId)

    if (!gossipFlushScheduled) {
      gossipFlushScheduled = true
      queueMicrotask(() => {
        gossipFlushScheduled = false
        if (isDestroyed) {
          return
        }
        const batch = [...pendingGossipDescriptors.values()]
        const downBatch = [...pendingGossipDown]
        const excludeId =
          pendingGossipSources.size === 1
            ? [...pendingGossipSources][0]
            : undefined
        pendingGossipDescriptors.clear()
        pendingGossipDown.clear()
        pendingGossipSources.clear()
        recomputeTopologyAndRoutes()
        sendGossipToNeighbors(batch, excludeId, downBatch)
      })
    }
  }

  const handleControlFrame = async (
    fromPeerId: string,
    msg: OverlayControlMessage
  ): Promise<void> => {
    if (isDestroyed || !msg || typeof msg !== 'object') {
      return
    }

    if (msg.t === 'prune') {
      if (typeof msg.peerId === 'string') {
        prunedDirectPeers.add(msg.peerId)
      }
      return
    }

    if (msg.t === 'leave') {
      const leavingId = msg.peerId
      if (!leavingId || leavingId === selfId) {
        return
      }
      if (typeof msg.sig !== 'string' || !msg.sig) {
        stats.signatureFailures++
        return
      }
      const valid = await verifyUnicastOrBroadcast(
        leavingId,
        `leave:${leavingId}:${msg.seq}`,
        new Uint8Array(),
        msg.sig
      )
      if (!valid) {
        return
      }

      if (!departedPeers.has(leavingId)) {
        const lastSeq = Math.max(
          msg.seq ?? 0,
          descriptors.get(leavingId)?.seq ?? 0
        )
        downPeersSeq.set(leavingId, lastSeq)
        departedPeers.add(leavingId)
        purgePeerFromGraph(leavingId)
        recomputeTopologyAndRoutes()
        const fwd = packOverlayControl(msg)
        for (const neighborId of directPeers.keys()) {
          if (neighborId !== fromPeerId && neighborId !== leavingId) {
            sendToDirectNeighbor(neighborId, fwd)
          }
        }
      }
      return
    }

    if (msg.t === 'ihave' && Array.isArray(msg.items)) {
      const missing: string[] = []
      for (const item of msg.items) {
        if (
          item &&
          typeof item.m === 'string' &&
          !seenMessages.has(item.m) &&
          !missingBroadcastTimers.has(item.m)
        ) {
          missing.push(item.m)
        }
      }

      if (missing.length > 0) {
        // Schedule a quick lazy repair request if eager push hasn't delivered it
        for (const m of missing) {
          const timer = setTimeout(() => {
            missingBroadcastTimers.delete(m)
            if (!isDestroyed && !seenMessages.has(m)) {
              stats.lazyRepairsSent++
              sendToDirectNeighbor(
                fromPeerId,
                packOverlayControl({t: 'iwant', ids: [m]})
              )
            }
          }, 15)
          missingBroadcastTimers.set(m, timer)
        }
      }
      return
    }

    if (msg.t === 'iwant' && Array.isArray(msg.ids)) {
      for (const id of msg.ids) {
        const cached = cachedBroadcastFrames.get(id)
        if (cached) {
          stats.lazyRepairsResolved++
          sendToDirectNeighbor(fromPeerId, cached)
        }
      }
      return
    }

    if (msg.t === 'gossip' && Array.isArray(msg.descriptors)) {
      const newlyUpdated: PeerDescriptor[] = []
      const newDown: string[] = []

      for (const d of msg.descriptors) {
        if (!d || d.peerId === selfId) {
          continue
        }
        if (departedPeers.has(d.peerId)) {
          const downSeq = downPeersSeq.get(d.peerId) ?? 0
          if (d.seq <= downSeq) {
            continue
          }
        }
        const existing = descriptors.get(d.peerId)
        if (existing && existing.seq >= d.seq) {
          continue
        }

        const isValid =
          tryVerifyDescriptorCached(d) || (await verifyDescriptor(d))
        if (!isValid || isDestroyed) {
          continue
        }

        const latest = descriptors.get(d.peerId)
        if (latest && latest.seq >= d.seq) {
          continue
        }

        departedPeers.delete(d.peerId)
        downPeersSeq.delete(d.peerId)
        knownRoster.add(d.peerId)
        descriptors.set(d.peerId, d)
        adjacency.set(
          d.peerId,
          new Set(d.neighbors.filter(n => !departedPeers.has(n)))
        )
        for (const n of d.neighbors) {
          if (!departedPeers.has(n)) {
            knownRoster.add(n)
          }
        }
        newlyUpdated.push(d)
      }

      if (Array.isArray(msg.down)) {
        for (const downId of msg.down) {
          if (
            typeof downId === 'string' &&
            downId !== selfId &&
            !directPeers.has(downId) &&
            !departedPeers.has(downId)
          ) {
            if (pinnedSignKeys.has(downId)) {
              const targetDesc = descriptors.get(downId)
              const hasAuthorizedReporter =
                !targetDesc ||
                newlyUpdated.length > 0 ||
                targetDesc.neighbors.some(n => {
                  const nDesc = descriptors.get(n)
                  return Boolean(nDesc && !nDesc.neighbors.includes(downId))
                })
              if (!hasAuthorizedReporter) {
                stats.signatureFailures++
                continue
              }
            }

            lastChurnAtMs = Date.now()
            const lastSeq = descriptors.get(downId)?.seq ?? 0
            downPeersSeq.set(downId, lastSeq)
            departedPeers.add(downId)
            purgePeerFromGraph(downId)
            newDown.push(downId)
          }
        }
      }

      if (newlyUpdated.length > 0 || newDown.length > 0) {
        scheduleGossipFlush(newlyUpdated, newDown, fromPeerId)
      }
    }
  }

  const ensureOriginVirtualPeer = (
    origin: string,
    fromPeerId: string
  ): void => {
    if (!directPeers.has(origin) && !virtualPeers.has(origin)) {
      knownRoster.add(origin)
      if (!routes[origin]) {
        routes[origin] = {nextHop: fromPeerId, hops: 2}
      }
      const vPeer = createVirtualPeer(origin)
      onVirtualPeerJoin(origin, vPeer)
    }
  }

  const handleOverlayBinary = async (
    fromPeerId: string,
    bytes: Uint8Array
  ): Promise<void> => {
    const parsed = unpackOverlayBinary(bytes)
    if (!parsed) {
      return
    }

    const {kind, ttl: rawTtl, header, payload} = parsed
    const ttl = Math.min(rawTtl, config.maxHops)

    if (kind === overlayBroadcastKind) {
      const origin = typeof header['o'] === 'string' ? header['o'] : ''
      const msgId = typeof header['m'] === 'string' ? header['m'] : ''
      const sig = typeof header['s'] === 'string' ? header['s'] : undefined

      if (!origin || !msgId || origin === selfId) {
        return
      }

      if (bannedPeers.has(origin) || bannedPeers.has(fromPeerId)) {
        stats.signatureFailures++
        return
      }

      if (seenMessages.has(msgId)) {
        stats.duplicatesDropped++
        return
      }

      const valid = await verifyUnicastOrBroadcast(
        origin,
        `${origin}:${msgId}`,
        payload,
        sig
      )
      if (!valid || isDestroyed) {
        return
      }

      // Hop-1 / intermediate relay filtering for privileged action namespaces
      const wireHeader = inspectActionWireHeader(payload)
      if (wireHeader) {
        const requiredRoles = actionAuthorities.get(wireHeader.type)
        if (requiredRoles && requiredRoles.length > 0 && canPeerSendAction) {
          const metaObj =
            wireHeader.metadata && typeof wireHeader.metadata === 'object'
              ? (wireHeader.metadata as Record<string, unknown>)
              : undefined
          const authEnv = metaObj?.['__trysteroAuth'] as
            | {cert?: RoleCertificate}
            | undefined
          const inlineCert = authEnv?.cert
          const allowed = await canPeerSendAction(
            origin,
            requiredRoles,
            inlineCert
          )
          if (!allowed || isDestroyed) {
            stats.signatureFailures++
            return
          }
        }
      }

      if (!rememberSeenMessage(msgId)) {
        stats.duplicatesDropped++
        return
      }

      const pendingRepairTimer = missingBroadcastTimers.get(msgId)
      if (pendingRepairTimer) {
        resetTimer(pendingRepairTimer)
        missingBroadcastTimers.delete(msgId)
      }

      // Ensure origin is registered as a virtual peer if not already known
      ensureOriginVirtualPeer(origin, fromPeerId)

      stats.messagesReceived++
      const copy = payload.slice().buffer
      onDeliverData(origin, copy)

      if (ttl > 1) {
        stats.messagesForwarded++
        forwardBroadcastPacket(
          origin,
          msgId,
          ttl - 1,
          {o: origin, m: msgId, ...(sig ? {s: sig} : {})},
          payload,
          fromPeerId
        )
      }
      return
    }

    if (kind === overlayUnicastKind) {
      const origin = typeof header['o'] === 'string' ? header['o'] : ''
      const dest = typeof header['d'] === 'string' ? header['d'] : ''
      const msgId = typeof header['m'] === 'string' ? header['m'] : ''
      const ivB64 = typeof header['iv'] === 'string' ? header['iv'] : undefined
      const sig = typeof header['s'] === 'string' ? header['s'] : undefined

      if (!origin || !dest || !msgId || origin === selfId) {
        return
      }

      if (
        bannedPeers.has(origin) ||
        bannedPeers.has(fromPeerId) ||
        bannedPeers.has(dest)
      ) {
        stats.signatureFailures++
        return
      }

      if (seenMessages.has(msgId)) {
        stats.duplicatesDropped++
        return
      }

      const canonical = `${origin}:${dest}:${msgId}:${ivB64 ?? ''}`

      if (dest !== selfId) {
        if (ttl <= 1) {
          return
        }
        if (pinnedSignKeys.has(origin) || descriptors.get(origin)?.signPubKey) {
          const validRelaySig = await verifyUnicastOrBroadcast(
            origin,
            canonical,
            payload,
            sig
          )
          if (!validRelaySig || isDestroyed) {
            return
          }
        }
        if (!rememberSeenMessage(msgId)) {
          stats.duplicatesDropped++
          return
        }
        stats.messagesForwarded++
        const forwarded = packOverlayBinary(
          overlayUnicastKind,
          ttl - 1,
          header,
          payload
        )
        routeUnicastPacket(dest, forwarded, fromPeerId)
        return
      }

      // Destination is selfId!
      const valid = await verifyUnicastOrBroadcast(
        origin,
        canonical,
        payload,
        sig
      )
      if (!valid || isDestroyed) {
        return
      }

      if (!ivB64) {
        stats.signatureFailures++
        return
      }
      const pairwiseKeyP = getPairwiseKey(origin)
      if (!pairwiseKeyP) {
        stats.signatureFailures++
        return
      }
      let plainPayload: Uint8Array
      try {
        const aesKey = await pairwiseKeyP
        const decrypted = await crypto.subtle.decrypt(
          {name: 'AES-GCM', iv: fromBase64(ivB64) as BufferSource},
          aesKey,
          payload as BufferSource
        )
        plainPayload = new Uint8Array(decrypted)
      } catch {
        stats.signatureFailures++
        return
      }

      if (!rememberSeenMessage(msgId)) {
        stats.duplicatesDropped++
        return
      }

      ensureOriginVirtualPeer(origin, fromPeerId)

      stats.messagesReceived++
      onDeliverData(origin, plainPayload.slice().buffer)
    }
  }

  return {
    config,

    isOverlayActive,

    getActiveMode: () => {
      updateActiveMode()
      return currentActiveMode
    },

    isOverlayFrame: (data: ArrayBuffer): boolean => {
      if (data.byteLength < 2) {
        return false
      }
      return new Uint8Array(data, 0, 1)[0] === overlayFrameVersion
    },

    handleOverlayFrame: (fromPeerId: string, data: ArrayBuffer): void => {
      if (bannedPeers.has(fromPeerId)) {
        stats.signatureFailures++
        return
      }
      const bytes = new Uint8Array(data)
      if (bytes.byteLength < 2 || bytes[0] !== overlayFrameVersion) {
        return
      }
      const kind = bytes[1]!
      if (kind === overlayControlKind) {
        try {
          const parsed = fromJson<OverlayControlMessage>(
            decodeBytes(bytes.subarray(2))
          )
          void handleControlFrame(fromPeerId, parsed)
        } catch {
          /* Ignore malformed control frame */
        }
        return
      }
      if (kind === overlayBroadcastKind || kind === overlayUnicastKind) {
        const copy = bytes.slice()
        const parsed = unpackOverlayBinary(copy)
        const originKey =
          parsed && typeof parsed.header['o'] === 'string' && parsed.header['o']
            ? parsed.header['o']
            : fromPeerId
        const prev = inboundOriginQueues.get(originKey) ?? Promise.resolve()
        inboundOriginQueues.set(
          originKey,
          prev.then(() => handleOverlayBinary(fromPeerId, copy)).catch(noOp)
        )
      }
    },

    addDirectPeer: (peerId: string, peer: PeerHandle): void => {
      if (isDestroyed || peerId === selfId || bannedPeers.has(peerId)) {
        return
      }

      departedPeers.delete(peerId)
      downPeersSeq.delete(peerId)
      prunedDirectPeers.delete(peerId)
      knownRoster.add(peerId)

      const timer = unreachableTimers.get(peerId)
      if (timer) {
        resetTimer(timer)
        unreachableTimers.delete(peerId)
      }

      // If peerId was previously a virtual peer, retire the virtual wrapper seamlessly
      const existingVirtual = virtualPeers.get(peerId)
      if (existingVirtual) {
        existingVirtual.destroy()
        virtualPeers.delete(peerId)
      }

      directPeers.set(peerId, peer)
      recomputeTopologyAndRoutes()

      if (isOverlayActive()) {
        // Send our full known descriptor table to the new neighbor and broadcast our updated link state
        void publishLocalDescriptor().then(() => {
          const allKnown = [...descriptors.values()].filter(
            d => d.peerId !== selfId && d.peerId !== peerId
          )
          const downList = [...departedPeers]
          if (allKnown.length > 0 || downList.length > 0) {
            sendToDirectNeighbor(
              peerId,
              packOverlayControl({
                t: 'gossip',
                descriptors: allKnown,
                ...(downList.length > 0 ? {down: downList} : {})
              })
            )
          }
        })
      }
    },

    removeDirectPeer: (peerId: string, peer?: PeerHandle): boolean => {
      const current = directPeers.get(peerId)
      if (!current || (peer && current !== peer)) {
        if (
          !current &&
          !virtualPeers.has(peerId) &&
          knownRoster.delete(peerId)
        ) {
          recomputeTopologyAndRoutes()
        }
        return false
      }

      directPeers.delete(peerId)
      lastChurnAtMs = Date.now()

      // Clear forwardedTo state for this peer on active media streams
      for (const s of activeStreams.values()) {
        s.forwardedTo.delete(peerId)
      }
      for (const t of activeTracks.values()) {
        t.forwardedTo.delete(peerId)
      }

      if (!isOverlayActive()) {
        knownRoster.delete(peerId)
        descriptors.delete(peerId)
        adjacency.delete(peerId)
        recomputeTopologyAndRoutes()
        return false
      }

      const wasGracefulPrune = prunedDirectPeers.delete(peerId)

      if (!wasGracefulPrune) {
        // Peer disconnected unexpectedly or left; mark departed and remove its stale link-state
        const lastSeq = descriptors.get(peerId)?.seq ?? Infinity
        downPeersSeq.set(peerId, lastSeq)
        departedPeers.add(peerId)
        purgePeerFromGraph(peerId)
      } else {
        // Only the direct edge between selfId and peerId was pruned
        adjacency.get(peerId)?.delete(selfId)
      }

      recomputeTopologyAndRoutes()
      void publishLocalDescriptor(wasGracefulPrune ? undefined : [peerId])

      // If peerId is still reachable via another multi-hop route, promote it to a virtual peer!
      if (wasGracefulPrune && !departedPeers.has(peerId) && routes[peerId]) {
        const vPeer = createVirtualPeer(peerId)
        onVirtualPeerJoin(peerId, vPeer)
        return true
      }

      return false
    },

    isDirectPeer: (peerId: string): boolean => directPeers.has(peerId),

    isVirtualPeer: (peerId: string): boolean => virtualPeers.has(peerId),

    getRoute: (peerId: string): TopologyRoute | undefined => routes[peerId],

    hasReachableRoute: (peerId: string): boolean =>
      directPeers.has(peerId) || Boolean(routes[peerId]),

    createVirtualPeer,

    broadcastInline,

    sendUnicast,

    getMediaTargets: (broadcasterId = selfId): string[] => {
      if (
        !isOverlayActive() ||
        (currentActiveMode === 'mesh' && virtualPeers.size === 0)
      ) {
        return [...directPeers.keys()]
      }
      for (const map of [activeStreams, activeTracks]) {
        for (const entry of map.values()) {
          if (
            entry.broadcasterId === broadcasterId &&
            entry.forwardedTo.size > 0
          ) {
            const activeForwarded = [...entry.forwardedTo].filter(id =>
              directPeers.has(id)
            )
            if (activeForwarded.length > 0) {
              return activeForwarded
            }
          }
        }
      }
      const {childrenIds} = getCachedTreeChildren(broadcasterId, config.fanout)
      const directChildren = childrenIds.filter(id => directPeers.has(id))
      if (directChildren.length > 0) {
        return directChildren
      }
      return broadcasterId === selfId
        ? [...directPeers.keys()].slice(0, config.fanout)
        : []
    },

    registerBroadcastStream: (
      broadcasterId: string,
      streamKey: string,
      stream: MediaStream,
      metadata?: JsonValue
    ): void => {
      const mapKey = `${broadcasterId}:${streamKey}`
      const {parentId, childrenIds} = getCachedTreeChildren(
        broadcasterId,
        config.fanout
      )
      const existing = activeStreams.get(mapKey)
      const forwardedTo = existing?.forwardedTo ?? new Set<string>()

      if (broadcasterId === selfId) {
        // Broadcaster initially sends to its getMediaTargets
        childrenIds
          .filter(id => directPeers.has(id))
          .forEach(id => forwardedTo.add(id))
      }

      activeStreams.set(mapKey, {
        broadcasterId,
        streamKey,
        stream,
        ...(existing?.tracks ? {tracks: existing.tracks} : {}),
        ...(metadata === undefined ? {} : {metadata}),
        forwardedTo,
        currentParentId: parentId
      })

      if (broadcasterId !== selfId) {
        syncMediaTrees()
      } else if (isOverlayActive()) {
        void publishLocalDescriptor()
      }
    },

    unregisterBroadcastStream: (
      broadcasterId: string,
      stream: MediaStream
    ): string[] => {
      const targets: string[] = []
      for (const [key, entry] of activeStreams.entries()) {
        if (entry.broadcasterId === broadcasterId && entry.stream === stream) {
          targets.push(...entry.forwardedTo)
          activeStreams.delete(key)
        }
      }
      for (const [key, entry] of activeTracks) {
        if (entry.broadcasterId === broadcasterId && entry.stream === stream) {
          targets.push(...entry.forwardedTo)
          activeTracks.delete(key)
        }
      }
      return targets
    },

    unregisterBroadcastStreamById: (
      broadcasterId: string,
      streamId: string
    ): {stream: MediaStream; targets: string[]} | null => {
      let removed: {stream: MediaStream; targets: string[]} | null = null
      for (const [key, entry] of activeStreams.entries()) {
        if (
          entry.broadcasterId === broadcasterId &&
          entry.stream.id === streamId
        ) {
          const targets = [...entry.forwardedTo]
          activeStreams.delete(key)
          removed ??= {stream: entry.stream, targets: []}
          removed.targets.push(...targets)
        }
      }
      for (const [key, entry] of activeTracks) {
        if (
          entry.broadcasterId === broadcasterId &&
          entry.stream.id === streamId
        ) {
          removed ??= {stream: entry.stream, targets: []}
          removed.targets.push(...entry.forwardedTo)
          activeTracks.delete(key)
        }
      }
      return removed
    },

    registerBroadcastTrack: (
      broadcasterId: string,
      trackKey: string,
      track: MediaStreamTrack,
      stream: MediaStream,
      metadata?: JsonValue
    ): void => {
      const mapKey = `${broadcasterId}:${trackKey}`
      const {childrenIds} = getCachedTreeChildren(broadcasterId, config.fanout)
      const existing = activeTracks.get(mapKey)
      const forwardedTo = existing?.forwardedTo ?? new Set<string>()

      if (broadcasterId === selfId) {
        childrenIds
          .filter(id => directPeers.has(id))
          .forEach(id => forwardedTo.add(id))
      }

      activeTracks.set(mapKey, {
        broadcasterId,
        trackKey,
        track,
        stream,
        ...(metadata === undefined ? {} : {metadata}),
        forwardedTo
      })

      if (broadcasterId !== selfId) {
        syncMediaTrees()
      }
    },

    unregisterBroadcastTrack: (broadcasterId, trackId, trackKeys = []) => {
      const removed = []
      for (const [key, entry] of activeTracks) {
        if (
          entry.broadcasterId === broadcasterId &&
          (entry.track.id === trackId || trackKeys.includes(entry.trackKey))
        ) {
          activeTracks.delete(key)
          removed.push({
            track: entry.track,
            key: entry.trackKey,
            targets: [...entry.forwardedTo]
          })
        }
      }
      for (const [key, entry] of activeStreams) {
        if (entry.broadcasterId !== broadcasterId) {
          continue
        }
        const tracks = entry.tracks ?? entry.stream.getTracks()
        const track = tracks.find(item => item.id === trackId)
        if (track) {
          entry.tracks = tracks.filter(item => item !== track)
          removed.push({
            track,
            key: entry.streamKey,
            targets: [...entry.forwardedTo]
          })
          if (entry.tracks.length === 0) {
            activeStreams.delete(key)
          }
        }
      }
      return removed
    },

    replaceBroadcastTrack: (broadcasterId, oldTrack, newTrack, metadata) => {
      for (const entry of activeTracks.values()) {
        if (entry.broadcasterId === broadcasterId && entry.track === oldTrack) {
          entry.track = newTrack
          if (metadata !== undefined) {
            entry.metadata = metadata
          }
        }
      }
      for (const entry of activeStreams.values()) {
        const tracks = entry.tracks ?? entry.stream.getTracks()
        if (
          entry.broadcasterId === broadcasterId &&
          tracks.includes(oldTrack)
        ) {
          entry.tracks = tracks.map(track =>
            track === oldTrack ? newTrack : track
          )
        }
      }
    },

    requireDirectPeer: peerId => {
      if (isDestroyed || peerId === selfId || bannedPeers.has(peerId)) {
        return
      }
      requiredDirectPeers.add(peerId)
      if (!directPeers.has(peerId)) {
        targetsChangedCallback?.([peerId])
      }
    },

    notePeerDiscovered: (peerId: string): void => {
      if (!peerId || peerId === selfId || bannedPeers.has(peerId)) {
        return
      }
      departedPeers.delete(peerId)
      downPeersSeq.delete(peerId)
      if (!knownRoster.has(peerId)) {
        knownRoster.add(peerId)
        updateActiveMode()
      }
    },

    shouldConnectPeer: (
      peerId: string,
      direction: 'outbound' | 'inbound'
    ): boolean => {
      if (!peerId || peerId === selfId || bannedPeers.has(peerId)) {
        return false
      }
      if (directPeers.has(peerId) || requiredDirectPeers.has(peerId)) {
        return true
      }

      knownRoster.add(peerId)
      updateActiveMode()

      if (currentActiveMode === 'mesh') {
        return true
      }

      const targets = computeTargetNeighbors(
        selfId,
        knownRoster,
        currentActiveMode,
        config.maxConnections,
        config.fanout,
        privilegedPeers
      )

      if (targets.has(peerId)) {
        return true
      }

      if (directPeers.size < config.minConnections) {
        return true
      }

      if (direction === 'inbound') {
        // Accept inbound offers up to a soft ceiling (2x maxConnections) so slightly
        // out-of-sync rosters during join bursts never reject valid neighbor edges.
        return directPeers.size < config.maxConnections * 2
      }

      return false
    },

    getTargetNeighbors: (): Set<string> => {
      updateActiveMode()
      return new Set([
        ...requiredDirectPeers,
        ...computeTargetNeighbors(
          selfId,
          knownRoster,
          currentActiveMode,
          config.maxConnections,
          config.fanout,
          privilegedPeers
        )
      ])
    },

    setOnTargetsChanged: (cb: (targetPeerIds: string[]) => void): void => {
      targetsChangedCallback = cb
    },

    getLocalCryptoIdentity: async (): Promise<CryptoIdentity> => {
      const id = identityReady ?? (await getOrCreateCryptoIdentity(selfId))
      identityReady = id
      return id
    },

    getPeerSignPublicKey: (peerId: string): JsonWebKey | undefined =>
      peerSignPubKeys.get(peerId) ?? descriptors.get(peerId)?.signPubKey,

    setPeerSignPublicKey: (peerId: string, pubKey: JsonWebKey): void => {
      if (!peerId || !pubKey) {
        return
      }
      const cached = getCachedPubKeyRecord(pubKey)
      if (cached && cached.peerId === peerId) {
        peerSignPubKeys.set(peerId, pubKey)
        return
      }
      void verifyPeerIdKey(peerId, pubKey).then(ok => {
        if (ok) {
          peerSignPubKeys.set(peerId, pubKey)
        }
      })
    },

    setLocalRoleCertificate: (cert: RoleCertificate | null): void => {
      localRoleCert = cert
      if (cert && cert.roles.includes('admin')) {
        privilegedPeers.add(selfId)
      } else {
        privilegedPeers.delete(selfId)
      }
      if (isOverlayActive()) {
        void publishLocalDescriptor()
      }
    },

    setPrivilegedPeer: (peerId: string, isPrivileged: boolean): void => {
      const changed = isPrivileged
        ? !privilegedPeers.has(peerId)
        : privilegedPeers.has(peerId)
      if (isPrivileged) {
        privilegedPeers.add(peerId)
      } else {
        privilegedPeers.delete(peerId)
      }
      if (changed && !isDestroyed) {
        recomputeTopologyAndRoutes()
      }
    },

    markPeerBanned: (peerId: string, keyThumbprint?: string): void => {
      bannedPeers.add(peerId)
      requiredDirectPeers.delete(peerId)
      privilegedPeers.delete(peerId)
      if (keyThumbprint) {
        bannedKeyThumbprints.add(keyThumbprint)
      }
      const pinned = pinnedSignKeys.get(peerId)
      if (pinned) {
        bannedKeyThumbprints.add(pinned)
      }
      const knownPubKey =
        peerSignPubKeys.get(peerId) ?? descriptors.get(peerId)?.signPubKey
      if (
        knownPubKey &&
        typeof knownPubKey.x === 'string' &&
        typeof knownPubKey.y === 'string'
      ) {
        bannedKeyThumbprints.add(canonicalizePubJwk(knownPubKey))
      }
      const lastSeq = descriptors.get(peerId)?.seq ?? Infinity
      downPeersSeq.set(peerId, lastSeq)
      departedPeers.add(peerId)
      purgePeerFromGraph(peerId)
      const timer = unreachableTimers.get(peerId)
      if (timer) {
        resetTimer(timer)
        unreachableTimers.delete(peerId)
      }
      if (virtualPeers.has(peerId)) {
        virtualPeers.get(peerId)?.destroy()
        virtualPeers.delete(peerId)
        onVirtualPeerLeave(peerId, mkErr('peer banned'))
      }
      recomputeTopologyAndRoutes()
      if (isOverlayActive()) {
        void publishLocalDescriptor([peerId])
      }
    },

    isPeerBanned: (peerId: string): boolean => {
      if (bannedPeers.has(peerId)) {
        return true
      }
      const thumbprint = pinnedSignKeys.get(peerId)
      if (thumbprint && bannedKeyThumbprints.has(thumbprint)) {
        return true
      }
      const knownPubKey =
        peerSignPubKeys.get(peerId) ?? descriptors.get(peerId)?.signPubKey
      if (
        knownPubKey &&
        typeof knownPubKey.x === 'string' &&
        typeof knownPubKey.y === 'string' &&
        bannedKeyThumbprints.has(canonicalizePubJwk(knownPubKey))
      ) {
        return true
      }
      return false
    },

    registerActionAuthority: (actionType: string, roles: string[]): void => {
      if (roles.length > 0) {
        actionAuthorities.set(actionType, [...roles])
      } else {
        actionAuthorities.delete(actionType)
      }
    },

    recordSignatureFailure: (): void => {
      stats.signatureFailures++
    },

    setRoomId: (effectiveRoomId: string): void => {
      if (effectiveRoomId && effectiveRoomId !== roomId) {
        roomId = effectiveRoomId
        if (isOverlayActive()) {
          void publishLocalDescriptor()
        }
      }
    },

    announceLeave: (): void => {
      if (isDestroyed || !isOverlayActive() || directPeers.size === 0) {
        return
      }
      const seq = ++localSeq
      void signUnicastOrBroadcast(
        `leave:${selfId}:${seq}`,
        new Uint8Array()
      ).then(sig => {
        if (isDestroyed) {
          return
        }
        const packet = packOverlayControl({
          t: 'leave',
          peerId: selfId,
          seq,
          sig
        })
        for (const neighborId of directPeers.keys()) {
          sendToDirectNeighbor(neighborId, packet)
        }
      })
    },

    destroy: (): void => {
      isDestroyed = true
      requiredDirectPeers.clear()
      for (const timer of unreachableTimers.values()) {
        resetTimer(timer)
      }
      unreachableTimers.clear()
      for (const timer of missingBroadcastTimers.values()) {
        resetTimer(timer)
      }
      missingBroadcastTimers.clear()
      for (const vPeer of virtualPeers.values()) {
        vPeer.destroy()
      }
      virtualPeers.clear()
      directPeers.clear()
      activeStreams.clear()
      activeTracks.clear()
    },

    getSnapshot: (): TopologySnapshot => {
      updateActiveMode()
      const directPeerIds = [...directPeers.keys()].sort()
      const roomPeerSet = new Set<string>([
        ...directPeerIds,
        ...virtualPeers.keys()
      ])
      const mediaTrees: Record<string, TopologyMediaTree> = {}
      const broadcasters = new Set<string>([selfId])
      for (const s of activeStreams.values()) {
        broadcasters.add(s.broadcasterId)
      }
      for (const bId of broadcasters) {
        const {parentId, childrenIds} = getCachedTreeChildren(
          bId,
          config.fanout
        )
        mediaTrees[bId] = {
          broadcasterId: bId,
          parentId,
          childrenIds
        }
      }

      return {
        mode: config.mode,
        activeMode: currentActiveMode,
        selfId,
        directPeerIds,
        roomPeerIds: [...roomPeerSet].sort(),
        routes: {...routes},
        mediaTrees,
        stats: {...stats}
      }
    }
  }
}

export const scale = (
  topology?: TopologyMode | TopologyConfig
): RoomPlugin<'scale', {getTopology: () => TopologySnapshot}> => {
  // Validate eagerly at call time
  normalizeTopologyConfig(topology)

  return definePlugin('scale', {
    setup: kernel => {
      const overlay = createOverlayManager({
        selfId: kernel.selfId,
        appId: kernel.appId,
        roomId: kernel.getRoomId(),
        password: kernel.password,
        ...(topology === undefined ? {} : {topology}),
        getLocalUserIdentity: () => kernel.getLocalUserIdentity(),
        onVirtualPeerJoin: (peerId, vPeer) =>
          kernel.activateVirtualPeer(peerId, vPeer),
        onVirtualPeerLeave: (peerId, reason) =>
          kernel.deactivateVirtualPeer(peerId, reason),
        onDeliverData: (originPeerId, data) =>
          kernel.deliverRawData(originPeerId, data),
        canPeerSendAction: (peerId, requiredRoles, inlineCert) => {
          const rp = kernel.getRolesProvider()
          return rp
            ? rp.canPeerSendAction(peerId, requiredRoles, inlineCert)
            : true
        },
        onPeerDescriptorCert: (peerId, signPubKey, cert, userId) => {
          if (userId) {
            kernel.setPeerUserId(peerId, userId)
          }
          kernel.setPeerPublicKey(peerId, signPubKey)
          const rp = kernel.getRolesProvider()
          if (rp) {
            rp.onPeerDescriptorCert(peerId, signPubKey, cert, userId)
          }
        },
        onRelayMediaStream: (
          broadcasterId,
          stream,
          metadata,
          targetPeerIds,
          streamKey,
          tracks
        ) =>
          kernel.relayMediaStream(
            broadcasterId,
            stream,
            metadata,
            targetPeerIds,
            streamKey,
            tracks
          ),
        onRelayMediaTrack: (
          broadcasterId,
          track,
          stream,
          metadata,
          targetPeerIds,
          trackKey
        ) =>
          kernel.relayMediaTrack(
            broadcasterId,
            track,
            stream,
            metadata,
            targetPeerIds,
            trackKey
          )
      })

      kernel.registerScaleProvider(overlay)
      kernel.onRoomIdChanged(rid => overlay.setRoomId(rid))

      return {
        getTopology: () => overlay.getSnapshot()
      }
    }
  })
}

export {
  overlayBroadcastKind,
  overlayControlKind,
  overlayUnicastKind,
  packOverlayBinary,
  packOverlayControl,
  sha1,
  unpackOverlayBinary
}
