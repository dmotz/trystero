import {inspectActionWireHeader} from './action-wire'
import {
  derivePairwiseAesKey,
  ecdsaSign,
  hash32,
  signRoomAuth,
  verifyRoomAuth
} from './crypto'
import {maxActionFrameBytes, maxOverlayHeaderBytes} from './data-limits'
import {
  getCachedPubKeyRecord,
  getDefaultEndpointIdentity,
  isPeerIdKeyCachedValid,
  isUserEndpointProofCachedValid,
  pubJwkToUncompressedBytes,
  signUserEndpointProof,
  verifyPeerIdKey,
  verifyUserEndpointProof,
  verifyWithP256
} from './identity'
import {isValidSignalPeerId} from './signal-handler'
import {
  all,
  authMetaKey,
  createBoundedCache,
  createBoundedSet,
  decodeBytes,
  definePlugin,
  encodeBytes,
  fromBase64,
  fromJson,
  genId,
  keys,
  libId,
  mkErr,
  noOp,
  peerBannedErr,
  peerDisconnectedErr,
  peerLeftRoomErr,
  resetTimer,
  toBase64,
  toError,
  toJson
} from './utils'
import type {
  PeerHandle,
  PeerHandlers,
  RoleCertificate,
  RoomPlugin,
  ScaleConfig,
  ScalePluginApi,
  Signal,
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

export const defaultMaxConnections = 6
const defaultMinConnections = 3
export const defaultAutoThreshold = 12
export const maxAllowedHops = 64
export const defaultMaxHops = 16
const defaultDescriptorTtlMs = 180_000
export const defaultUnreachableGraceMs = 1_200
const nextHopCongestionBytes = 256 * 1024
const unicastLeaseWindowPackets = 256
const maxDiscoveredCandidates = 512
const maxTrackedOrigins = 2_048
const maxVerifiedDescriptors = 2_048
const maxPeersPerUser = 16
const descriptorUpdateRatePerSec = 8
const descriptorUpdateBurstCap = 16
const replayWindowBits = 256n
const replayWindowMask = (1n << replayWindowBits) - 1n

export const deriveMaxHops = (
  rosterSize: number,
  maxConnections: number = defaultMaxConnections
): number => {
  const n = Math.max(2, rosterSize)
  const dims = Math.max(2, Math.floor(maxConnections / 2))
  const theoreticalDiameter = Math.ceil(dims * Math.pow(n, 1 / dims))
  return Math.min(maxAllowedHops, Math.max(12, theoreticalDiameter * 2))
}

export type ResolvedTopologyConfig = {
  mode: TopologyMode
  maxConnections: number
  autoThreshold: number
}

export type PeerDescriptor = {
  peerId: string
  seq: number
  neighbors: string[]
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
    }
  | {
      t: 'leave'
      peerId: string
      seq: number
      sig?: string
    }

type BroadcastEnvelopeHeader = {
  o: string
  q: number
  m: string
  s?: string
}

type UnicastLeaseTuple = [lo: number, hi: number, sig: string]

type UnicastEnvelopeHeader = {
  o: string
  d: string
  q: number
  m: string
  iv?: string
  s?: string
  l?: UnicastLeaseTuple
}

type OriginReplayState = {
  maxSeq: number
  windowBits: bigint
  lastSeenAt: number
}

const validModes = new Set<TopologyMode>(['auto', 'gossip'])

export const normalizeTopologyConfig = (
  topology?: TopologyMode | ScaleConfig
): ResolvedTopologyConfig => {
  if (!topology) {
    return {
      mode: 'auto',
      maxConnections: defaultMaxConnections,
      autoThreshold: defaultAutoThreshold
    }
  }

  const raw: ScaleConfig =
    typeof topology === 'string' ? {mode: topology} : topology
  const mode = raw.mode ?? 'auto'

  if (!validModes.has(mode)) {
    throw mkErr(`invalid topology mode "${String(mode)}"`)
  }

  const maxConnections = raw.maxConnections ?? defaultMaxConnections
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 4) {
    throw mkErr('scale.maxConnections must be an integer >= 4')
  }

  const autoThreshold = raw.autoThreshold ?? defaultAutoThreshold
  if (!Number.isSafeInteger(autoThreshold) || autoThreshold < 2) {
    throw mkErr('scale.autoThreshold must be an integer >= 2')
  }

  return {
    mode,
    maxConnections,
    autoThreshold
  }
}

const ringKeyCache = createBoundedCache<string, string>(8_192)

const hashRingKey = (ringSalt: string, peerId: string): string => {
  const input = toJson([ringSalt, peerId])
  const cached = ringKeyCache.get(input)
  if (cached !== undefined) {
    return cached
  }
  const h1 = hash32(`0:${input}`)
  const h2 = hash32(`1:${input}`)
  const res = `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}:${peerId}`
  ringKeyCache.set(input, res)
  return res
}

export const computeTargetNeighbors = (
  localPeerId: string,
  rosterIds: Iterable<string>,
  activeMode: 'mesh' | 'gossip',
  maxConnections: number,
  roomSalt: string = ''
): Set<string> => {
  const unique = new Set<string>(rosterIds)
  unique.add(localPeerId)
  const total = unique.size
  const targets = new Set<string>()

  if (total <= 1 || !unique.has(localPeerId)) {
    return targets
  }

  if (activeMode === 'mesh' || total - 1 <= maxConnections) {
    for (const id of [...unique].sort()) {
      if (id !== localPeerId) {
        targets.add(id)
      }
    }
    return targets
  }

  // Union of d = floor(maxConnections / 2) independent permuted Hamiltonian cycles:
  // strictly symmetric, degree <= 2*d <= maxConnections at every node, O(log N) expander diameter.
  const numRings = Math.max(2, Math.floor(maxConnections / 2))
  const uniqueList = [...unique]

  for (let r = 0; r < numRings; r++) {
    const ringSalt = toJson([roomSalt, 'ring', r])
    const ringSorted = uniqueList
      .map(id => ({id, key: hashRingKey(ringSalt, id)}))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map(entry => entry.id)
    const idx = ringSorted.indexOf(localPeerId)
    if (idx < 0) {
      continue
    }
    const forward = ringSorted[(idx + 1) % total]
    const backward = ringSorted[(idx - 1 + total) % total]
    if (forward && forward !== localPeerId) {
      targets.add(forward)
    }
    if (backward && backward !== localPeerId) {
      targets.add(backward)
    }
  }

  return targets
}

const buildUndirectedGraph = (
  adjacency: Map<string, Set<string>>,
  localPeerId?: string,
  directSet?: Iterable<string>
): Map<string, string[]> => {
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
      if (adjacency.get(v)?.has(u)) {
        ensureNode(u).add(v)
        ensureNode(v).add(u)
      }
    }
  }

  const sortedGraph = new Map<string, string[]>()
  for (const [u, set] of graph.entries()) {
    sortedGraph.set(u, [...set].sort())
  }
  return sortedGraph
}

export const computeShortestPathRoutes = (
  localPeerId: string,
  adjacency: Map<string, Set<string>>,
  directPeerIds: Iterable<string>,
  maxHops: number = maxAllowedHops
): Record<string, TopologyRoute> => {
  const routes: Record<string, TopologyRoute> = {}
  if (maxHops < 1) {
    return routes
  }
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
    if (hops >= maxHops) {
      continue
    }
    const neighbors = graph.get(node)
    if (!neighbors) {
      continue
    }

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
  if (
    headerLen <= 0 ||
    headerLen > maxOverlayHeaderBytes ||
    5 + headerLen > bytes.byteLength
  ) {
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

const gossipEnvelopeOverheadBytes = 32
const descByteLengthCache = new WeakMap<PeerDescriptor, number>()

export const packGossipControlFrames = (
  descriptors: PeerDescriptor[],
  maxFrameBytes: number = maxActionFrameBytes
): Uint8Array[] => {
  if (descriptors.length === 0) {
    return []
  }

  const frames: Uint8Array[] = []
  let currentDescs: PeerDescriptor[] = []
  let currentBytes = gossipEnvelopeOverheadBytes

  for (const desc of descriptors) {
    let descBytes = descByteLengthCache.get(desc)
    if (descBytes === undefined) {
      descBytes = encodeBytes(toJson(desc)).byteLength
      descByteLengthCache.set(desc, descBytes)
    }
    const addedBytes = (currentDescs.length > 0 ? 1 : 0) + descBytes
    if (currentDescs.length > 0 && currentBytes + addedBytes > maxFrameBytes) {
      frames.push(
        packOverlayControl({
          t: 'gossip',
          descriptors: currentDescs
        })
      )
      currentDescs = [desc]
      currentBytes = gossipEnvelopeOverheadBytes + descBytes
    } else {
      currentDescs.push(desc)
      currentBytes += addedBytes
    }
  }

  if (currentDescs.length > 0) {
    frames.push(
      packOverlayControl({
        t: 'gossip',
        descriptors: currentDescs
      })
    )
  }

  return frames
}

const maxOverlayMsgIdLength = 128

const isValidOverlayMsgId = (msgId: string): boolean => {
  if (msgId.length === 0 || msgId.length > maxOverlayMsgIdLength) {
    return false
  }
  for (let i = 0; i < msgId.length; i++) {
    const code = msgId.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) {
      return false
    }
  }
  return true
}

export const canonicalBroadcastHeader = (
  origin: string,
  msgId: string,
  seq: number = 1,
  appId: string = '',
  roomId: string = ''
): string =>
  toJson([`${libId}-broadcast-v2`, appId, roomId, origin, seq, msgId])

export const canonicalUnicastHeader = (
  origin: string,
  dest: string,
  msgId: string,
  ivB64: string,
  seq: number = 1,
  appId: string = '',
  roomId: string = ''
): string =>
  toJson([
    `${libId}-unicast-v2`,
    appId,
    roomId,
    origin,
    dest,
    seq,
    msgId,
    ivB64
  ])

export const canonicalLeaveHeader = (
  leavingId: string,
  seq: number,
  appId: string = '',
  roomId: string = ''
): string => toJson([`${libId}-leave-v2`, appId, roomId, leavingId, seq])

export const canonicalUnicastLeaseHeader = (
  origin: string,
  dest: string,
  lo: number,
  hi: number,
  appId: string = '',
  roomId: string = ''
): string =>
  toJson([`${libId}-unicast-lease-v1`, appId, roomId, origin, dest, lo, hi])

export const buildOverlaySignedBytes = (
  canonicalHeader: string,
  payload: Uint8Array
): Uint8Array => {
  const headerBytes = encodeBytes(canonicalHeader)
  const combined = new Uint8Array(
    4 + headerBytes.byteLength + payload.byteLength
  )
  new DataView(combined.buffer).setUint32(0, headerBytes.byteLength)
  combined.set(headerBytes, 4)
  combined.set(payload, 4 + headerBytes.byteLength)
  return combined
}

export const descriptorCanonicalPayload = (
  d: PeerDescriptor,
  appId: string = '',
  roomId: string = ''
): string =>
  toJson([
    `${libId}-desc-v2`,
    appId,
    roomId,
    d.peerId,
    d.seq,
    d.neighbors,
    d.signPubKey ?? null,
    d.encPubKey ?? null,
    d.roomAuth ?? null,
    d.cert?.sig ?? null,
    ...(d.userId ? [d.userId, d.userPubKey ?? null, d.userProof ?? null] : [])
  ])

type CryptoIdentity = {
  peerId: string
  signPrivateKey: CryptoKey
  signPublicKey: CryptoKey
  signPubJwk: JsonWebKey
  encPrivateKey: CryptoKey
  encPublicKey: CryptoKey
  encPubJwk: JsonWebKey
}

const verifiedSigBytes = createBoundedCache<string, Uint8Array>(4_096)
const inFlightSigVerifies = new Map<string, Promise<boolean>>()
const lastLocalSeqByRoomPeer = createBoundedCache<
  string,
  {descSeq: number; pktSeq: number}
>(4_096)

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
  if (bytes.byteLength <= 2_048) {
    verifiedSigBytes.set(cacheKey, bytes.slice())
  }
}

export type OverlayManagerDeps = {
  selfId?: string
  appId?: string
  roomId?: string
  password?: string
  topology?: TopologyMode | ScaleConfig
  descriptorTtlMs?: number
  unreachableGraceMs?: number
  maxUsers?: number
  getLocalUserIdentity?: () => Promise<UserIdentity> | UserIdentity
  onVirtualPeerJoin: (peerId: string, virtualPeer: PeerHandle) => unknown
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
}

export type OverlayManager = {
  config: ResolvedTopologyConfig
  isOverlayActive: () => boolean
  getActiveMode: () => 'mesh' | 'gossip'
  isOverlayFrame: (data: ArrayBuffer) => boolean
  handleOverlayFrame: (fromPeerId: string, data: ArrayBuffer) => void
  handleFrame: (fromPeerId: string, data: ArrayBuffer) => boolean
  addDirectPeer: (peerId: string, peer: PeerHandle) => void
  removeDirectPeer: (peerId: string, peer?: PeerHandle, reason?: Error) => void
  prepareMediaPeer?: (peerId: string, peer: PeerHandle) => Promise<PeerHandle>
  isDirectPeer: (peerId: string) => boolean
  isVirtualPeer: (peerId: string) => boolean
  getRoute: (peerId: string) => TopologyRoute | undefined
  broadcastInline: (
    frame: Uint8Array,
    onProgress?: (peerId: string) => void
  ) => Promise<boolean>
  sendUnicast: (targetPeerId: string, frame: Uint8Array) => void
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
  markPeerBanned: (peerId: string) => void
  isPeerBanned: (peerId: string) => boolean
  registerActionAuthority: (actionType: string, roles: string[]) => void
  recordSignatureFailure: () => void
  setRoomId: (effectiveRoomId: string) => void
}

export const createOverlayManager = ({
  selfId: initialSelfId,
  appId = '',
  roomId: initialRoomId = '',
  password = '',
  topology,
  descriptorTtlMs = defaultDescriptorTtlMs,
  unreachableGraceMs = defaultUnreachableGraceMs,
  maxUsers,
  getLocalUserIdentity,
  onVirtualPeerJoin,
  onVirtualPeerLeave,
  onDeliverData,
  canPeerSendAction,
  onPeerDescriptorCert
}: OverlayManagerDeps): OverlayManager => {
  let selfId = initialSelfId ?? ''
  let roomId = initialRoomId
  const config = normalizeTopologyConfig(topology)
  let targetsChangedCallback: ((targetPeerIds: string[]) => void) | null = null
  const directPeers = new Map<string, PeerHandle>()
  const pendingFramesByPeer = new Map<string, ArrayBuffer[]>()
  const requiredDirectPeers = new Set<string>()
  const virtualPeers = new Map<string, PeerHandle>()
  const capacityRejectedPeers = new Set<string>()
  // Verified roster only: selfId + connected directPeers + verified descriptors.
  const knownRoster = new Set<string>(selfId ? [selfId] : [])
  // Bounded unverified signaling candidates (never admitted to knownRoster until verified).
  const discoveredCandidates = new Set<string>()
  const addDiscoveredCandidate = (peerId: string): void => {
    if (discoveredCandidates.has(peerId)) {
      discoveredCandidates.delete(peerId)
    } else if (discoveredCandidates.size >= maxDiscoveredCandidates) {
      const oldest = discoveredCandidates.values().next().value
      if (oldest !== undefined) {
        discoveredCandidates.delete(oldest)
      }
    }
    discoveredCandidates.add(peerId)
  }
  const bannedPeers = new Set<string>()
  const peerSignPubKeys = new Map<string, JsonWebKey>()
  const actionAuthorities = new Map<string, string[]>()
  let localRoleCert: RoleCertificate | null = null
  const descriptors = new Map<string, PeerDescriptor>()
  const descriptorReceivedAt = new Map<string, number>()
  const descUpdateBuckets = new Map<
    string,
    {tokens: number; lastRefillAt: number}
  >()
  const senderInvalidDescCounts = new Map<string, number>()
  const adjacency = new Map<string, Set<string>>()
  const pinnedSignKeys = new Map<string, string>()
  const derivedPairwiseKeys = new Map<string, Promise<CryptoKey>>()
  const outboundUnicastLeases = new Map<
    string,
    {lo: number; hi: number; sig: string}
  >()
  const relayLeaseReplay = new Map<string, OriginReplayState>()
  const leftPeersSeq = new Map<string, number>()
  const hadRoutePeers = new Set<string>()
  const everConfirmedNeighbors = new Map<string, Set<string>>()
  const unreachableTimers = new Map<string, ReturnType<typeof setTimeout>>()

  // Per-origin monotonic sequence & 256-bit sliding replay window (cannot be flushed by traffic volume)
  const originReplay = new Map<string, OriginReplayState>()
  const seenMsgIds = createBoundedSet<string>(4_096)

  let localDescriptorSeq = 0
  let localPacketSeq = 0
  let didInitSessionSeqFloor = false

  const syncSessionSeqFloor = (id: string): void => {
    if (!id) {
      return
    }
    const key = `${appId}\0${roomId}\0${id}`
    const prev = lastLocalSeqByRoomPeer.get(key)
    if (!didInitSessionSeqFloor) {
      didInitSessionSeqFloor = true
      if (prev) {
        localDescriptorSeq = Math.max(localDescriptorSeq, prev.descSeq + 1_024)
        localPacketSeq = Math.max(localPacketSeq, prev.pktSeq + 1_024)
      }
    }
    lastLocalSeqByRoomPeer.set(key, {
      descSeq: Math.max(localDescriptorSeq, prev?.descSeq ?? 0),
      pktSeq: Math.max(localPacketSeq, prev?.pktSeq ?? 0)
    })
  }

  const recordLocalSeqProgress = (): void => {
    if (!selfId) {
      return
    }
    const key = `${appId}\0${roomId}\0${selfId}`
    const prev = lastLocalSeqByRoomPeer.get(key)
    lastLocalSeqByRoomPeer.set(key, {
      descSeq: Math.max(localDescriptorSeq, prev?.descSeq ?? 0),
      pktSeq: Math.max(localPacketSeq, prev?.pktSeq ?? 0)
    })
  }

  if (selfId) {
    syncSessionSeqFloor(selfId)
  }

  void getDefaultEndpointIdentity(initialSelfId, appId).then(ep => {
    if (!initialSelfId && ep.peerId !== selfId) {
      knownRoster.delete(selfId)
      selfId = ep.peerId
      knownRoster.add(selfId)
    }
    syncSessionSeqFloor(selfId)
  })
  let isDestroyed = false
  let currentActiveMode: 'mesh' | 'gossip' =
    config.mode === 'auto' ? 'mesh' : config.mode
  let hadVerifiedAboveThreshold = false
  let routes: Record<string, TopologyRoute> = {}
  let identityReady: CryptoIdentity | null = null
  let localCryptoIdentityP: Promise<CryptoIdentity> | null = null

  const getLocalCryptoIdentityImpl = (): Promise<CryptoIdentity> => {
    if (!localCryptoIdentityP) {
      localCryptoIdentityP = (async () => {
        const [endpointId, encPair] = await all([
          getDefaultEndpointIdentity(selfId || initialSelfId, appId),
          crypto.subtle.generateKey(
            {name: 'ECDH', namedCurve: 'P-256'},
            false,
            ['deriveKey', 'deriveBits']
          )
        ])
        const encPubJwk = await crypto.subtle.exportKey(
          'jwk',
          encPair.publicKey
        )
        const res: CryptoIdentity = {
          peerId: endpointId.peerId,
          signPrivateKey: endpointId.signPrivateKey,
          signPublicKey: endpointId.signPublicKey,
          signPubJwk: endpointId.signPubJwk,
          encPrivateKey: encPair.privateKey,
          encPublicKey: encPair.publicKey,
          encPubJwk
        }
        identityReady = res
        return res
      })()
    }
    return localCryptoIdentityP
  }

  const stats: TopologyStats = {
    messagesSent: 0,
    messagesReceived: 0,
    messagesForwarded: 0,
    duplicatesDropped: 0,
    signatureFailures: 0
  }

  let passwordTopologySalt = ''
  let passwordSaltToken = 0

  const getRoomSalt = (): string =>
    passwordTopologySalt
      ? toJson([appId, roomId, passwordTopologySalt])
      : appId || roomId
        ? toJson([appId, roomId])
        : ''

  const currentMaxHops = (): number =>
    deriveMaxHops(
      Math.max(knownRoster.size, descriptors.size + 1, directPeers.size + 1),
      config.maxConnections
    )

  let localUserId: string | undefined
  if (getLocalUserIdentity) {
    void Promise.resolve(getLocalUserIdentity())
      .then(u => {
        if (u?.userId) {
          localUserId = u.userId
        }
      })
      .catch(noOp)
  }

  const isSeqReplayInMap = (
    map: Map<string, OriginReplayState>,
    key: string,
    seq: number
  ): boolean => {
    const state = map.get(key)
    if (!state) {
      return false
    }
    if (seq > state.maxSeq) {
      return false
    }
    if (seq === state.maxSeq) {
      return true
    }
    const offset = BigInt(state.maxSeq - seq)
    if (offset >= replayWindowBits) {
      return true
    }
    return (state.windowBits & (1n << offset)) !== 0n
  }

  const recordSeqInMap = (
    map: Map<string, OriginReplayState>,
    key: string,
    seq: number,
    isPinnedKey?: (k: string) => boolean
  ): boolean => {
    const now = Date.now()
    const state = map.get(key)
    if (!state) {
      if (map.size >= maxTrackedOrigins) {
        let oldestKey: string | null = null
        let oldestTime = Infinity
        for (const [k, v] of map.entries()) {
          if (!isPinnedKey?.(k) && v.lastSeenAt < oldestTime) {
            oldestTime = v.lastSeenAt
            oldestKey = k
          }
        }
        if (oldestKey) {
          map.delete(oldestKey)
        }
      }
      map.set(key, {
        maxSeq: seq,
        windowBits: 1n,
        lastSeenAt: now
      })
      return true
    }

    if (seq > state.maxSeq) {
      const shift = BigInt(seq - state.maxSeq)
      state.windowBits =
        shift >= replayWindowBits
          ? 1n
          : ((state.windowBits << shift) | 1n) & replayWindowMask
      state.maxSeq = seq
      state.lastSeenAt = now
      return true
    }

    if (seq === state.maxSeq) {
      return false
    }

    const offset = BigInt(state.maxSeq - seq)
    if (offset >= replayWindowBits) {
      return false
    }
    const bit = 1n << offset
    if ((state.windowBits & bit) !== 0n) {
      return false
    }
    state.windowBits |= bit
    state.lastSeenAt = now
    return true
  }

  const isOriginSeqReplay = (origin: string, seq: number): boolean =>
    isSeqReplayInMap(originReplay, origin, seq)

  const recordOriginSeq = (origin: string, seq: number): boolean =>
    recordSeqInMap(
      originReplay,
      origin,
      seq,
      k => directPeers.has(k) || descriptors.has(k)
    )

  void getLocalCryptoIdentityImpl().then(id => {
    if (!isDestroyed) {
      identityReady = id
      if (config.mode === 'gossip' && directPeers.size > 0) {
        void publishLocalDescriptor()
      }
    }
  })
  const updateActiveMode = (): void => {
    if (config.mode === 'gossip') {
      currentActiveMode = 'gossip'
      return
    }
    const verifiedCount = Math.max(
      knownRoster.size,
      descriptors.size + 1,
      directPeers.size + 1
    )
    if (verifiedCount > config.autoThreshold) {
      hadVerifiedAboveThreshold = true
    }
    const effectiveCount =
      verifiedCount > 1 ? verifiedCount : 1 + discoveredCandidates.size
    if (currentActiveMode === 'mesh' && effectiveCount > config.autoThreshold) {
      currentActiveMode = 'gossip'
    } else if (currentActiveMode !== 'mesh' && verifiedCount > 1) {
      const returnToMeshThreshold = hadVerifiedAboveThreshold
        ? Math.max(2, Math.floor(config.autoThreshold * 0.75))
        : config.autoThreshold
      if (
        verifiedCount <= returnToMeshThreshold &&
        (hadVerifiedAboveThreshold ||
          descriptors.size > 0 ||
          directPeers.size < config.maxConnections)
      ) {
        currentActiveMode = 'mesh'
      }
    }
  }

  const isOverlayActive = (): boolean => {
    updateActiveMode()
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

  const isPeerUsable = (peer: PeerHandle | undefined): peer is PeerHandle =>
    Boolean(peer && !peer.isDead && peer.channel?.readyState !== 'closed')

  const getPeerBufferedBytes = (peer: PeerHandle | undefined): number =>
    typeof peer?.channel?.bufferedAmount === 'number'
      ? peer.channel.bufferedAmount
      : 0

  const resolveHealthyNextHopId = (
    destPeerId: string,
    excludePeerId?: string
  ): string | undefined => {
    if (destPeerId !== excludePeerId) {
      const direct = directPeers.get(destPeerId)
      if (isPeerUsable(direct)) {
        return destPeerId
      }
    }
    const route = routes[destPeerId]
    if (!route) {
      return undefined
    }
    const primaryId =
      route.nextHop !== excludePeerId ? route.nextHop : undefined
    const primaryPeer = primaryId ? directPeers.get(primaryId) : undefined
    const primaryUsable = isPeerUsable(primaryPeer)

    const backupId =
      route.backupNextHop && route.backupNextHop !== excludePeerId
        ? route.backupNextHop
        : undefined
    const backupPeer = backupId ? directPeers.get(backupId) : undefined
    const backupUsable = isPeerUsable(backupPeer)

    if (primaryUsable) {
      const primaryBuf = getPeerBufferedBytes(primaryPeer)
      if (
        primaryBuf > nextHopCongestionBytes &&
        backupUsable &&
        getPeerBufferedBytes(backupPeer) < primaryBuf
      ) {
        return backupId
      }
      return primaryId
    }
    return backupUsable ? backupId : undefined
  }

  const sendToDirectNeighbor = (peerId: string, frame: Uint8Array): boolean => {
    const peer = directPeers.get(peerId)
    if (!isPeerUsable(peer)) {
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
    const openFallbackChannel = {
      readyState: 'open',
      bufferedAmount: 0,
      bufferedAmountLowThreshold: 0xffff,
      addEventListener: noOp,
      removeEventListener: noOp
    } as unknown as RTCDataChannel
    const closedFallbackChannel = {
      readyState: 'closed',
      bufferedAmount: 0,
      bufferedAmountLowThreshold: 0xffff,
      addEventListener: noOp,
      removeEventListener: noOp
    } as unknown as RTCDataChannel

    const handle: PeerHandle = {
      get connection(): RTCPeerConnection {
        const nextHop = resolveHealthyNextHopId(peerId)
        const direct = nextHop ? directPeers.get(nextHop) : undefined
        return direct?.connection ?? fallbackConnection
      },
      get channel(): RTCDataChannel | null {
        if (dead) {
          return closedFallbackChannel
        }
        const nextHop = resolveHealthyNextHopId(peerId)
        if (!nextHop) {
          return closedFallbackChannel
        }
        const direct = directPeers.get(nextHop)
        return direct?.channel ?? openFallbackChannel
      },
      get isDead(): boolean {
        return dead
      },
      getOffer: async () => undefined,
      signal: async (_sdp: Signal) => undefined,
      sendData: (data: Uint8Array) => {
        if (dead) {
          throw peerDisconnectedErr
        }
        const direct = directPeers.get(peerId)
        if (isPeerUsable(direct)) {
          direct.sendData(data)
          return
        }
        if (!resolveHealthyNextHopId(peerId)) {
          throw peerDisconnectedErr
        }
        sendUnicast(peerId, data)
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

  const purgePeerFromGraph = (peerId: string): void => {
    descriptors.delete(peerId)
    descriptorReceivedAt.delete(peerId)
    descUpdateBuckets.delete(peerId)
    senderInvalidDescCounts.delete(peerId)
    outboundUnicastLeases.delete(peerId)
    adjacency.delete(peerId)
    knownRoster.delete(peerId)
    discoveredCandidates.delete(peerId)
    hadRoutePeers.delete(peerId)
    everConfirmedNeighbors.delete(peerId)
    for (const set of adjacency.values()) {
      set.delete(peerId)
    }
    for (const set of everConfirmedNeighbors.values()) {
      set.delete(peerId)
    }
  }

  const recordLeftPeer = (peerId: string, seq: number): void => {
    if (leftPeersSeq.has(peerId)) {
      leftPeersSeq.delete(peerId)
    } else if (leftPeersSeq.size >= 1_024) {
      const oldest = leftPeersSeq.keys().next().value
      if (oldest !== undefined) {
        leftPeersSeq.delete(oldest)
      }
    }
    leftPeersSeq.set(peerId, seq)
  }

  const deactivateVirtualPeerNow = (peerId: string, reason: Error): void => {
    const timer = unreachableTimers.get(peerId)
    if (timer) {
      resetTimer(timer)
      unreachableTimers.delete(peerId)
    }
    hadRoutePeers.delete(peerId)
    const hadVirtual = virtualPeers.has(peerId)
    if (hadVirtual) {
      capacityRejectedPeers.clear()
      virtualPeers.get(peerId)?.destroy()
      virtualPeers.delete(peerId)
      onVirtualPeerLeave(peerId, reason)
    }
  }

  const evictVirtualPeerNow = (peerId: string, reason: Error): void => {
    const timer = unreachableTimers.get(peerId)
    if (timer) {
      resetTimer(timer)
      unreachableTimers.delete(peerId)
    }
    const hadVirtual = virtualPeers.has(peerId)
    if (hadVirtual) {
      capacityRejectedPeers.clear()
      virtualPeers.get(peerId)?.destroy()
      virtualPeers.delete(peerId)
    }
    purgePeerFromGraph(peerId)
    if (hadVirtual) {
      onVirtualPeerLeave(peerId, reason)
    }
  }

  const capRosterPeersPerUser = (baseRoster: Set<string>): Set<string> => {
    if (
      currentActiveMode === 'mesh' ||
      baseRoster.size <= config.maxConnections + 1
    ) {
      return baseRoster
    }
    const maxSlotsPerUser = Math.max(1, Math.floor(config.maxConnections / 3))
    const byUser = new Map<string, string[]>()
    for (const id of baseRoster) {
      if (id === selfId) {
        continue
      }
      const uid = descriptors.get(id)?.userId
      if (!uid) {
        continue
      }
      let list = byUser.get(uid)
      if (!list) {
        list = []
        byUser.set(uid, list)
      }
      list.push(id)
    }
    if (byUser.size === 0) {
      return baseRoster
    }
    const filtered = new Set<string>(baseRoster)
    for (const [, userPeers] of byUser.entries()) {
      if (userPeers.length <= maxSlotsPerUser) {
        continue
      }
      const otherPeerCount = baseRoster.size - 1 - userPeers.length
      if (otherPeerCount < config.maxConnections) {
        continue
      }
      const sorted = [...userPeers].sort()
      for (let i = maxSlotsPerUser; i < sorted.length; i++) {
        filtered.delete(sorted[i]!)
      }
    }
    return filtered
  }

  let hasCompletedInitialBootstrap = false

  const hasConvergedComponentDescriptors = (): boolean => {
    if (directPeers.size === 0) {
      return false
    }
    for (const dId of directPeers.keys()) {
      if (!descriptors.has(dId)) {
        return false
      }
    }
    for (const desc of descriptors.values()) {
      for (const nId of desc.neighbors) {
        if (
          nId !== selfId &&
          !leftPeersSeq.has(nId) &&
          !bannedPeers.has(nId) &&
          !descriptors.has(nId)
        ) {
          return false
        }
      }
    }
    return true
  }

  const isAssignedGatekeeperFor = (candidateId: string): boolean => {
    const gateSalt = toJson([getRoomSalt(), 'gate', candidateId])
    const cappedRoster = capRosterPeersPerUser(knownRoster)
    const lowerVerified: Array<{id: string; key: string}> = []
    for (const u of cappedRoster) {
      if (u < candidateId && !bannedPeers.has(u) && !leftPeersSeq.has(u)) {
        lowerVerified.push({id: u, key: hashRingKey(gateSalt, u)})
      }
    }
    if (lowerVerified.length === 0) {
      return false
    }
    lowerVerified.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    const gatekeeperCount = Math.min(2, lowerVerified.length)
    for (let i = 0; i < gatekeeperCount; i++) {
      if (lowerVerified[i]?.id === selfId) {
        return true
      }
    }
    return false
  }

  const computeEffectiveTargets = (): Set<string> => {
    updateActiveMode()
    if (!hasCompletedInitialBootstrap && hasConvergedComponentDescriptors()) {
      hasCompletedInitialBootstrap = true
    }
    const useVerifiedOnly =
      (currentActiveMode === 'mesh' && knownRoster.size > 1) ||
      hasCompletedInitialBootstrap
    const rawRoster = useVerifiedOnly
      ? knownRoster
      : new Set<string>([...knownRoster, ...discoveredCandidates.values()])
    const rosterForRing = capRosterPeersPerUser(rawRoster)
    const targets = computeTargetNeighbors(
      selfId,
      rosterForRing,
      currentActiveMode,
      config.maxConnections,
      getRoomSalt()
    )
    for (const reqId of requiredDirectPeers) {
      targets.add(reqId)
    }
    return targets
  }

  let targetsNotifyScheduled = false
  const scheduleTargetsNotification = (): void => {
    if (targetsNotifyScheduled || isDestroyed || !targetsChangedCallback) {
      return
    }
    targetsNotifyScheduled = true
    queueMicrotask(() => {
      targetsNotifyScheduled = false
      if (isDestroyed || !targetsChangedCallback) {
        return
      }
      updateActiveMode()
      if (currentActiveMode === 'mesh') {
        return
      }
      if (directPeers.size >= config.maxConnections) {
        const missingReq = [...requiredDirectPeers].filter(
          id => !directPeers.has(id)
        )
        if (missingReq.length > 0) {
          targetsChangedCallback(missingReq)
        }
        return
      }
      const targets = computeEffectiveTargets()
      const missing = [...targets].filter(id => !directPeers.has(id))
      if (missing.length > 0) {
        targetsChangedCallback(missing)
      }
    })
  }

  const recomputeTopologyAndRoutes = (): void => {
    if (isDestroyed) {
      return
    }

    updateActiveMode()
    adjacency.set(selfId, new Set(directPeers.keys()))

    for (const [u, uNeighbors] of adjacency.entries()) {
      for (const v of uNeighbors) {
        if (adjacency.get(v)?.has(u)) {
          let uSet = everConfirmedNeighbors.get(u)
          if (!uSet) {
            uSet = new Set<string>()
            everConfirmedNeighbors.set(u, uSet)
          }
          uSet.add(v)
        }
      }
    }

    routes = computeShortestPathRoutes(
      selfId,
      adjacency,
      directPeers.keys(),
      currentMaxHops()
    )

    if (!isOverlayActive()) {
      return
    }

    for (const peerId of keys(routes)) {
      if (peerId === selfId) {
        continue
      }
      hadRoutePeers.add(peerId)

      const timer = unreachableTimers.get(peerId)
      if (timer) {
        resetTimer(timer)
        unreachableTimers.delete(peerId)
      }

      if (
        !directPeers.has(peerId) &&
        descriptors.has(peerId) &&
        !capacityRejectedPeers.has(peerId)
      ) {
        const vPeer = createVirtualPeer(peerId)
        if (onVirtualPeerJoin(peerId, vPeer) === false) {
          vPeer.destroy()
          virtualPeers.delete(peerId)
          capacityRejectedPeers.add(peerId)
        }
      }
    }

    // Check if any known non-direct peer has lost all mutually-confirmed routes
    const nonDirectCandidates = new Set<string>([
      ...virtualPeers.keys(),
      ...hadRoutePeers
    ])
    for (const peerId of nonDirectCandidates) {
      if (peerId === selfId || directPeers.has(peerId) || routes[peerId]) {
        continue
      }
      const desc = descriptors.get(peerId)
      const confirmedSet = everConfirmedNeighbors.get(peerId)
      let anyConfirmedNeighborDropped = false
      const allKnownNeighborsDropped = Boolean(
        desc &&
        desc.neighbors.length > 0 &&
        confirmedSet &&
        confirmedSet.size > 0 &&
        desc.neighbors.every(n => {
          if (!confirmedSet.has(n)) {
            return false
          }
          if (n === selfId) {
            if (!directPeers.has(peerId)) {
              anyConfirmedNeighborDropped = true
              return true
            }
            return false
          }
          const nDesc = descriptors.get(n)
          if (nDesc && !nDesc.neighbors.includes(peerId)) {
            anyConfirmedNeighborDropped = true
            return true
          }
          return !directPeers.has(n) && !routes[n]
        }) &&
        anyConfirmedNeighborDropped
      )

      if (allKnownNeighborsDropped) {
        if (desc) {
          recordLeftPeer(peerId, desc.seq)
        }
        evictVirtualPeerNow(peerId, peerDisconnectedErr)
      } else if (!unreachableTimers.has(peerId)) {
        unreachableTimers.set(
          peerId,
          setTimeout(() => {
            unreachableTimers.delete(peerId)
            if (!isDestroyed && !directPeers.has(peerId) && !routes[peerId]) {
              deactivateVirtualPeerNow(peerId, peerDisconnectedErr)
            }
          }, unreachableGraceMs)
        )
      }
    }

    if (targetsChangedCallback && currentActiveMode !== 'mesh') {
      scheduleTargetsNotification()
    }
  }

  // Periodic descriptor heartbeat & TTL expiry sweep
  const heartbeatIntervalMs = Math.max(
    200,
    Math.min(15_000, Math.floor(descriptorTtlMs / 3))
  )
  const heartbeatTimer = setInterval(() => {
    if (isDestroyed) {
      return
    }
    const now = Date.now()
    let expiredAny = false
    for (const [peerId, receivedAt] of descriptorReceivedAt.entries()) {
      if (
        peerId !== selfId &&
        !directPeers.has(peerId) &&
        now - receivedAt > descriptorTtlMs
      ) {
        const desc = descriptors.get(peerId)
        if (desc) {
          recordLeftPeer(peerId, desc.seq)
        }
        evictVirtualPeerNow(peerId, peerDisconnectedErr)
        expiredAny = true
      }
    }
    if (expiredAny) {
      recomputeTopologyAndRoutes()
    }
    if (isOverlayActive() && directPeers.size > 0) {
      void publishLocalDescriptor()
    }
  }, heartbeatIntervalMs)
  ;(heartbeatTimer as {unref?: () => void}).unref?.()

  const verifySigWithCache = async (
    sigCacheKey: string | undefined,
    sig: string,
    signedBytes: Uint8Array,
    pubJwk: JsonWebKey
  ): Promise<boolean> => {
    if (sigCacheKey) {
      const cachedVerifiedBytes = verifiedSigBytes.get(sigCacheKey)
      if (cachedVerifiedBytes && bytesMatch(cachedVerifiedBytes, signedBytes)) {
        return true
      }
      const inFlight = inFlightSigVerifies.get(sigCacheKey)
      if (inFlight) {
        return inFlight
      }
    }
    const verifyPromise = (async () => {
      try {
        const ok = await verifyWithP256(fromBase64(sig), signedBytes, pubJwk)
        if (ok && sigCacheKey) {
          rememberVerifiedSig(sigCacheKey, signedBytes)
        }
        return ok
      } catch {
        return false
      } finally {
        if (sigCacheKey) {
          inFlightSigVerifies.delete(sigCacheKey)
        }
      }
    })()
    if (sigCacheKey) {
      inFlightSigVerifies.set(sigCacheKey, verifyPromise)
    }
    return verifyPromise
  }

  const maxDescriptorNeighbors = Math.max(16, config.maxConnections * 3)
  const maxGossipEntriesPerFrame = 64

  const buildLocalDescriptor = async (): Promise<PeerDescriptor> => {
    const id = identityReady ?? (await getLocalCryptoIdentityImpl())
    identityReady = id
    const userIdentity = getLocalUserIdentity
      ? await getLocalUserIdentity()
      : null

    if (!initialSelfId && id.peerId !== selfId) {
      knownRoster.delete(selfId)
      selfId = id.peerId
      knownRoster.add(selfId)
    }
    syncSessionSeqFloor(selfId)

    publishDirty = false
    const seq = ++localDescriptorSeq
    recordLocalSeqProgress()
    const allDirect = [...directPeers.keys()]
    const targets =
      allDirect.length <= maxDescriptorNeighbors
        ? null
        : computeEffectiveTargets()
    const neighbors = (
      !targets
        ? allDirect
        : allDirect
            .sort(
              (a, b) =>
                Number(targets.has(b)) - Number(targets.has(a)) ||
                a.localeCompare(b)
            )
            .slice(0, maxDescriptorNeighbors)
    ).sort()

    const descriptor: PeerDescriptor = {
      peerId: selfId,
      seq,
      neighbors,
      signPubKey: id.signPubJwk,
      encPubKey: id.encPubJwk,
      ...(localRoleCert ? {cert: localRoleCert} : {})
    }

    if (password) {
      descriptor.roomAuth = await signRoomAuth(
        password,
        appId,
        roomId,
        selfId,
        seq
      )
    }

    if (userIdentity) {
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
    const canonicalBytes = encodeBytes(
      descriptorCanonicalPayload(descriptor, appId, roomId)
    )
    const sig = toBase64(
      await ecdsaSign(id.signPrivateKey, canonicalBytes as BufferSource)
    )
    descriptor.sig = sig
    rememberVerifiedSig(`desc:${toJson(id.signPubJwk)}:${sig}`, canonicalBytes)

    return descriptor
  }

  const isValidDescriptorNeighbors = (
    peerId: string,
    neighbors: unknown
  ): neighbors is string[] => {
    if (
      !Array.isArray(neighbors) ||
      neighbors.length > maxDescriptorNeighbors
    ) {
      return false
    }
    for (const n of neighbors) {
      if (!isValidSignalPeerId(n) || n === peerId) {
        return false
      }
    }
    return true
  }

  const hasValidDescriptorShape = (
    d: PeerDescriptor
  ): d is PeerDescriptor & {signPubKey: JsonWebKey; sig: string} =>
    Boolean(
      d &&
      isValidSignalPeerId(d.peerId) &&
      typeof d.seq === 'number' &&
      Number.isSafeInteger(d.seq) &&
      d.seq > 0 &&
      isValidDescriptorNeighbors(d.peerId, d.neighbors) &&
      (d.encPubKey === undefined ||
        Boolean(pubJwkToUncompressedBytes(d.encPubKey))) &&
      !bannedPeers.has(d.peerId)
    )

  const needsUserProof = (d: PeerDescriptor): boolean =>
    Boolean(getLocalUserIdentity) ||
    d.userId !== undefined ||
    d.userPubKey !== undefined ||
    d.userProof !== undefined

  const commitVerifiedDescriptor = (
    d: PeerDescriptor & {signPubKey: JsonWebKey; sig: string},
    keyThumbprint: string
  ): true => {
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

  const tryVerifyDescriptorCached = (d: PeerDescriptor): boolean => {
    if (
      password ||
      !hasValidDescriptorShape(d) ||
      !d.signPubKey ||
      typeof d.sig !== 'string' ||
      !d.sig ||
      !isPeerIdKeyCachedValid(d.peerId, d.signPubKey)
    ) {
      return false
    }

    if (
      needsUserProof(d) &&
      (!d.userId ||
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
        }))
    ) {
      return false
    }

    const keyThumbprint = toJson(d.signPubKey)
    const pinned = pinnedSignKeys.get(d.peerId)
    if (pinned && pinned !== keyThumbprint) {
      return false
    }

    const canonicalBytes = encodeBytes(
      descriptorCanonicalPayload(d, appId, roomId)
    )
    const cachedVerifiedBytes = verifiedSigBytes.get(
      `desc:${keyThumbprint}:${d.sig}`
    )
    if (
      !cachedVerifiedBytes ||
      !bytesMatch(cachedVerifiedBytes, canonicalBytes)
    ) {
      return false
    }

    return commitVerifiedDescriptor(d, keyThumbprint)
  }

  const verifyDescriptor = async (d: PeerDescriptor): Promise<boolean> => {
    if (!hasValidDescriptorShape(d)) {
      stats.signatureFailures++
      return false
    }

    if (password) {
      if (
        typeof d.roomAuth !== 'string' ||
        !d.roomAuth ||
        !(await verifyRoomAuth(
          password,
          appId,
          roomId,
          d.peerId,
          d.seq,
          d.roomAuth
        ))
      ) {
        stats.signatureFailures++
        return false
      }
    }

    if (
      !d.signPubKey ||
      typeof d.sig !== 'string' ||
      !d.sig ||
      !(await verifyPeerIdKey(d.peerId, d.signPubKey))
    ) {
      stats.signatureFailures++
      return false
    }

    if (
      needsUserProof(d) &&
      (!d.userId ||
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
        })))
    ) {
      stats.signatureFailures++
      return false
    }

    const keyThumbprint = toJson(d.signPubKey)
    const pinned = pinnedSignKeys.get(d.peerId)
    if (pinned && pinned !== keyThumbprint) {
      stats.signatureFailures++
      return false
    }

    const canonicalBytes = encodeBytes(
      descriptorCanonicalPayload(d, appId, roomId)
    )
    const sigCacheKey = `desc:${keyThumbprint}:${d.sig}`
    const ok = await verifySigWithCache(
      sigCacheKey,
      d.sig,
      canonicalBytes,
      d.signPubKey
    )
    if (!ok) {
      stats.signatureFailures++
      return false
    }
    return commitVerifiedDescriptor(d, keyThumbprint)
  }

  const sendGossipToNeighbors = (
    list: PeerDescriptor[],
    excludePeerId?: string
  ): void => {
    const packets = packGossipControlFrames(list)
    if (packets.length === 0) {
      return
    }
    for (const neighborId of directPeers.keys()) {
      if (neighborId !== excludePeerId) {
        for (const packet of packets) {
          sendToDirectNeighbor(neighborId, packet)
        }
      }
    }
  }

  let pendingPublishPromise: Promise<void> | null = null
  let publishDirty = false

  const publishLocalDescriptor = (): Promise<void> => {
    if (isDestroyed || !isOverlayActive()) {
      return Promise.resolve()
    }
    publishDirty = true
    if (!pendingPublishPromise) {
      pendingPublishPromise = new Promise<void>(resolve => {
        queueMicrotask(async () => {
          while (publishDirty && !isDestroyed && isOverlayActive()) {
            const signedDescriptor = await buildLocalDescriptor()
            if (isDestroyed) {
              break
            }
            descriptors.set(selfId, signedDescriptor)
            descriptorReceivedAt.set(selfId, Date.now())
            adjacency.set(selfId, new Set(signedDescriptor.neighbors))
            recomputeTopologyAndRoutes()
            if (!publishDirty) {
              sendGossipToNeighbors([signedDescriptor])
            }
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
    const remoteUncompressed = remoteDesc?.encPubKey
      ? pubJwkToUncompressedBytes(remoteDesc.encPubKey)
      : null
    if (!remoteUncompressed) {
      return null
    }
    let cached = derivedPairwiseKeys.get(remotePeerId)
    if (!cached) {
      cached = (async () => {
        const id = identityReady ?? (await getLocalCryptoIdentityImpl())
        identityReady = id
        return derivePairwiseAesKey(
          id.encPrivateKey,
          remoteUncompressed,
          appId,
          roomId,
          selfId,
          remotePeerId
        )
      })()
      cached.catch(() => {
        derivedPairwiseKeys.delete(remotePeerId)
      })
      derivedPairwiseKeys.set(remotePeerId, cached)
    }
    return cached
  }

  const signUnicastOrBroadcast = async (
    canonicalHeader: string,
    payload: Uint8Array
  ): Promise<string> => {
    const id = identityReady ?? (await getLocalCryptoIdentityImpl())
    identityReady = id
    if (!initialSelfId && id.peerId !== selfId) {
      knownRoster.delete(selfId)
      selfId = id.peerId
      knownRoster.add(selfId)
    }
    syncSessionSeqFloor(selfId)
    const combined = buildOverlaySignedBytes(canonicalHeader, payload)
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

    const combined = buildOverlaySignedBytes(canonicalHeader, payload)
    const sigCacheKey = pinnedThumbprint
      ? `pkt:${pinnedThumbprint}:${sig}`
      : undefined
    const ok = await verifySigWithCache(sigCacheKey, sig, combined, signPubJwk)
    if (!ok) {
      stats.signatureFailures++
      return false
    }
    return true
  }

  const forwardBroadcastPacket = (
    originPeerId: string,
    ttl: number,
    header: BroadcastEnvelopeHeader,
    payload: Uint8Array,
    fromPeerId?: string
  ): number => {
    if (ttl <= 0) {
      return 0
    }
    const packet = packOverlayBinary(overlayBroadcastKind, ttl, header, payload)
    let sentCount = 0
    for (const neighborId of directPeers.keys()) {
      if (neighborId !== fromPeerId && neighborId !== originPeerId) {
        if (sendToDirectNeighbor(neighborId, packet)) {
          sentCount++
        }
      }
    }
    return sentCount
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

    let hasUsableNeighbor = false
    for (const peer of directPeers.values()) {
      if (isPeerUsable(peer)) {
        hasUsableNeighbor = true
        break
      }
    }
    if (!hasUsableNeighbor && (directPeers.size > 0 || virtualPeers.size > 0)) {
      return false
    }

    const seq = ++localPacketSeq
    recordLocalSeqProgress()
    const msgId = `${selfId}:${seq}:${genId(8)}`
    recordOriginSeq(selfId, seq)
    seenMsgIds.add(msgId)
    stats.messagesSent++

    const canonical = canonicalBroadcastHeader(
      selfId,
      msgId,
      seq,
      appId,
      roomId
    )
    const sig = await signUnicastOrBroadcast(canonical, frame)
    const header: BroadcastEnvelopeHeader = {
      o: selfId,
      q: seq,
      m: msgId,
      ...(sig ? {s: sig} : {})
    }

    const sentCount = forwardBroadcastPacket(
      selfId,
      currentMaxHops(),
      header,
      frame
    )
    if (sentCount === 0 && (directPeers.size > 0 || virtualPeers.size > 0)) {
      return false
    }

    if (onProgress) {
      const allRoomPeers = new Set([...directPeers.keys(), ...keys(routes)])
      for (const peerId of allRoomPeers) {
        if (resolveHealthyNextHopId(peerId)) {
          onProgress(peerId)
        }
      }
    }

    return true
  }

  const routeUnicastPacket = (
    destPeerId: string,
    packet: Uint8Array,
    excludePeerId?: string
  ): boolean => {
    const preferredHop = resolveHealthyNextHopId(destPeerId, excludePeerId)
    if (preferredHop && sendToDirectNeighbor(preferredHop, packet)) {
      return true
    }

    const route = routes[destPeerId]
    if (
      route &&
      route.nextHop !== excludePeerId &&
      route.nextHop !== preferredHop &&
      sendToDirectNeighbor(route.nextHop, packet)
    ) {
      return true
    }

    if (
      route?.backupNextHop &&
      route.backupNextHop !== excludePeerId &&
      route.backupNextHop !== preferredHop &&
      sendToDirectNeighbor(route.backupNextHop, packet)
    ) {
      return true
    }

    return false
  }

  const outboundUnicastQueues = new Map<string, Promise<void>>()
  const lastUnicastSeqByTarget = new Map<string, number>()
  const inboundOriginQueues = new Map<string, Promise<void>>()

  const requireDirectPeer = (peerId: string): void => {
    if (
      isDestroyed ||
      !isValidSignalPeerId(peerId) ||
      peerId === selfId ||
      bannedPeers.has(peerId)
    ) {
      return
    }
    const maxRequired = Math.max(8, config.maxConnections * 2)
    if (
      !requiredDirectPeers.has(peerId) &&
      requiredDirectPeers.size >= maxRequired
    ) {
      const oldest = requiredDirectPeers.values().next().value
      if (oldest !== undefined) {
        requiredDirectPeers.delete(oldest)
      }
    }
    requiredDirectPeers.add(peerId)
    if (!directPeers.has(peerId)) {
      targetsChangedCallback?.([peerId])
    }
  }

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

    const isChunkedAction =
      frame.byteLength >= 2 &&
      frame[0] === 2 &&
      ((frame[1]! & 0xf) === 1 || (frame[1]! & 0xf) === 2)

    // Promote to a direct WebRTC connection when initiating a multi-chunk (>16 KiB) transfer
    if (isChunkedAction) {
      requireDirectPeer(targetPeerId)
    }

    const seq = ++localPacketSeq
    recordLocalSeqProgress()
    const prevTargetSeq = lastUnicastSeqByTarget.get(targetPeerId)
    lastUnicastSeqByTarget.set(targetPeerId, seq)
    const useStreamLease =
      isChunkedAction ||
      (prevTargetSeq !== undefined &&
        seq - prevTargetSeq <= unicastLeaseWindowPackets)

    const msgId = `${selfId}:${seq}:${genId(8)}`
    recordOriginSeq(selfId, seq)
    seenMsgIds.add(msgId)
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
        let canonical: string

        const pairwiseKeyP = getPairwiseKey(targetPeerId)
        if (!pairwiseKeyP) {
          return
        }
        try {
          const aesKey = await pairwiseKeyP
          const iv = crypto.getRandomValues(new Uint8Array(12))
          ivB64 = toBase64(iv)
          canonical = canonicalUnicastHeader(
            selfId,
            targetPeerId,
            msgId,
            ivB64,
            seq,
            appId,
            roomId
          )
          const encrypted = await crypto.subtle.encrypt(
            {
              name: 'AES-GCM',
              iv,
              additionalData: encodeBytes(canonical) as BufferSource
            },
            aesKey,
            frameCopy as BufferSource
          )
          payloadToSend = new Uint8Array(encrypted)
        } catch {
          return
        }

        let header: UnicastEnvelopeHeader
        let activeLease = outboundUnicastLeases.get(targetPeerId)
        if (
          useStreamLease ||
          (activeLease && seq >= activeLease.lo && seq <= activeLease.hi)
        ) {
          if (!activeLease || seq < activeLease.lo || seq > activeLease.hi) {
            const lo = seq
            const hi = seq + unicastLeaseWindowPackets - 1
            const leaseSig = await signUnicastOrBroadcast(
              canonicalUnicastLeaseHeader(
                selfId,
                targetPeerId,
                lo,
                hi,
                appId,
                roomId
              ),
              new Uint8Array()
            )
            activeLease = {lo, hi, sig: leaseSig}
            outboundUnicastLeases.set(targetPeerId, activeLease)
          }
          if (isDestroyed) {
            return
          }
          header = {
            o: selfId,
            d: targetPeerId,
            q: seq,
            m: msgId,
            iv: ivB64,
            l: [activeLease.lo, activeLease.hi, activeLease.sig]
          }
        } else {
          const sig = await signUnicastOrBroadcast(canonical, payloadToSend)
          if (isDestroyed) {
            return
          }
          header = {
            o: selfId,
            d: targetPeerId,
            q: seq,
            m: msgId,
            iv: ivB64,
            s: sig
          }
        }
        const packet = packOverlayBinary(
          overlayUnicastKind,
          currentMaxHops(),
          header,
          payloadToSend
        )
        routeUnicastPacket(targetPeerId, packet)
      })
      .catch(noOp)
      .finally(() => {
        if (outboundUnicastQueues.get(targetPeerId) === nextQueue) {
          outboundUnicastQueues.delete(targetPeerId)
        }
      })
    outboundUnicastQueues.set(targetPeerId, nextQueue)
  }

  const pendingGossipDescriptors = new Map<string, PeerDescriptor>()
  const pendingGossipSources = new Set<string>()
  let gossipFlushScheduled = false

  const flushPendingGossip = (): void => {
    gossipFlushScheduled = false
    if (isDestroyed) {
      return
    }
    const batch = [...pendingGossipDescriptors.values()]
    const excludeId =
      pendingGossipSources.size === 1 ? [...pendingGossipSources][0] : undefined
    pendingGossipDescriptors.clear()
    pendingGossipSources.clear()
    recomputeTopologyAndRoutes()
    sendGossipToNeighbors(batch, excludeId)
  }

  const scheduleGossipFlush = (
    newlyUpdated: PeerDescriptor[],
    fromPeerId: string
  ): void => {
    for (const d of newlyUpdated) {
      const prev = pendingGossipDescriptors.get(d.peerId)
      if (!prev || prev.seq < d.seq) {
        pendingGossipDescriptors.set(d.peerId, d)
      }
    }
    pendingGossipSources.add(fromPeerId)

    if (!gossipFlushScheduled) {
      gossipFlushScheduled = true
      if (descriptors.size > 32 || discoveredCandidates.size > 32) {
        setTimeout(flushPendingGossip, 2)
      } else {
        queueMicrotask(flushPendingGossip)
      }
    }
  }

  const handleControlFrame = async (
    fromPeerId: string,
    msg: OverlayControlMessage
  ): Promise<void> => {
    if (isDestroyed || !msg || typeof msg !== 'object') {
      return
    }

    if (msg.t === 'leave') {
      const leavingId = msg.peerId
      if (!isValidSignalPeerId(leavingId) || leavingId === selfId) {
        return
      }
      if (
        typeof msg.seq !== 'number' ||
        !Number.isSafeInteger(msg.seq) ||
        msg.seq <= 0 ||
        typeof msg.sig !== 'string' ||
        !msg.sig
      ) {
        stats.signatureFailures++
        return
      }
      const existingDesc = descriptors.get(leavingId)
      const prevLeftSeq = leftPeersSeq.get(leavingId)
      if (
        (existingDesc && msg.seq < existingDesc.seq) ||
        (prevLeftSeq !== undefined && msg.seq <= prevLeftSeq)
      ) {
        return
      }
      const valid = await verifyUnicastOrBroadcast(
        leavingId,
        canonicalLeaveHeader(leavingId, msg.seq, appId, roomId),
        new Uint8Array(),
        msg.sig
      )
      if (!valid || isDestroyed) {
        return
      }

      const lastSeq = Math.max(msg.seq, descriptors.get(leavingId)?.seq ?? 0)
      recordLeftPeer(leavingId, lastSeq)
      evictVirtualPeerNow(leavingId, peerLeftRoomErr)
      recomputeTopologyAndRoutes()
      const fwd = packOverlayControl(msg)
      for (const neighborId of directPeers.keys()) {
        if (neighborId !== fromPeerId && neighborId !== leavingId) {
          sendToDirectNeighbor(neighborId, fwd)
        }
      }
      return
    }

    if (msg.t === 'gossip' && Array.isArray(msg.descriptors)) {
      const newlyUpdated: PeerDescriptor[] = []

      for (const d of msg.descriptors.slice(0, maxGossipEntriesPerFrame)) {
        if (!d || d.peerId === selfId) {
          continue
        }
        const leftSeq = leftPeersSeq.get(d.peerId)
        if (leftSeq !== undefined && d.seq <= leftSeq) {
          continue
        }
        const existing = descriptors.get(d.peerId)
        if (existing && existing.seq >= d.seq) {
          continue
        }

        if (
          !hasValidDescriptorShape(d) ||
          !d.signPubKey ||
          typeof d.sig !== 'string' ||
          !d.sig
        ) {
          stats.signatureFailures++
          senderInvalidDescCounts.set(
            fromPeerId,
            (senderInvalidDescCounts.get(fromPeerId) ?? 0) + 1
          )
          continue
        }

        if (existing) {
          const now = Date.now()
          let bucket = descUpdateBuckets.get(d.peerId)
          if (!bucket) {
            bucket = {tokens: descriptorUpdateBurstCap, lastRefillAt: now}
            descUpdateBuckets.set(d.peerId, bucket)
          } else {
            const elapsedSec = Math.max(0, (now - bucket.lastRefillAt) / 1_000)
            if (elapsedSec > 0) {
              bucket.tokens = Math.min(
                descriptorUpdateBurstCap,
                bucket.tokens + elapsedSec * descriptorUpdateRatePerSec
              )
              bucket.lastRefillAt = now
            }
          }
          if (bucket.tokens < 1) {
            stats.signatureFailures++
            continue
          }
          bucket.tokens -= 1
        } else {
          if ((senderInvalidDescCounts.get(fromPeerId) ?? 0) >= 16) {
            stats.signatureFailures++
            continue
          }

          if (!directPeers.has(d.peerId)) {
            const now = Date.now()

            if (d.userId) {
              let userPeerCount = 0
              let oldestUserTime = Infinity
              for (const existingDesc of descriptors.values()) {
                if (
                  existingDesc.peerId !== d.peerId &&
                  existingDesc.userId === d.userId
                ) {
                  userPeerCount++
                  if (
                    existingDesc.peerId !== selfId &&
                    !directPeers.has(existingDesc.peerId)
                  ) {
                    const t = descriptorReceivedAt.get(existingDesc.peerId) ?? 0
                    if (t < oldestUserTime) {
                      oldestUserTime = t
                    }
                  }
                }
              }
              if (
                userPeerCount >= maxPeersPerUser &&
                now - oldestUserTime <= descriptorTtlMs
              ) {
                continue
              }
            }

            if (maxUsers !== undefined) {
              const activeIdentityKeys = new Set<string>([
                localUserId ??
                  descriptors.get(selfId)?.userId ??
                  (selfId || '__self__')
              ])
              for (const directId of directPeers.keys()) {
                activeIdentityKeys.add(
                  descriptors.get(directId)?.userId ?? directId
                )
              }
              for (const [descPeerId, existingDesc] of descriptors.entries()) {
                if (descPeerId === selfId) {
                  continue
                }
                const receivedAt = descriptorReceivedAt.get(descPeerId) ?? 0
                if (
                  directPeers.has(descPeerId) ||
                  now - receivedAt <= descriptorTtlMs
                ) {
                  activeIdentityKeys.add(existingDesc.userId ?? descPeerId)
                }
              }
              const candidateKey = d.userId ?? d.peerId
              if (
                !activeIdentityKeys.has(candidateKey) &&
                activeIdentityKeys.size >= maxUsers
              ) {
                continue
              }
            }

            if (descriptors.size >= maxVerifiedDescriptors) {
              let oldestTime = Infinity
              for (const existingId of descriptors.keys()) {
                if (existingId !== selfId && !directPeers.has(existingId)) {
                  const t = descriptorReceivedAt.get(existingId) ?? 0
                  if (t < oldestTime) {
                    oldestTime = t
                  }
                }
              }
              if (now - oldestTime <= descriptorTtlMs) {
                continue
              }
            }
          }
        }

        const isValid =
          tryVerifyDescriptorCached(d) || (await verifyDescriptor(d))
        if (!isValid || isDestroyed) {
          if (!isValid && !isDestroyed) {
            senderInvalidDescCounts.set(
              fromPeerId,
              (senderInvalidDescCounts.get(fromPeerId) ?? 0) + 1
            )
          }
          continue
        }

        const latest = descriptors.get(d.peerId)
        if (latest && latest.seq >= d.seq) {
          continue
        }

        if (!latest) {
          const now = Date.now()
          if (d.userId) {
            let userPeerCount = 0
            let oldestUserPeerId: string | null = null
            let oldestUserTime = Infinity
            for (const existingDesc of descriptors.values()) {
              if (
                existingDesc.peerId !== d.peerId &&
                existingDesc.userId === d.userId
              ) {
                userPeerCount++
                if (
                  existingDesc.peerId !== selfId &&
                  !directPeers.has(existingDesc.peerId)
                ) {
                  const t = descriptorReceivedAt.get(existingDesc.peerId) ?? 0
                  if (t < oldestUserTime) {
                    oldestUserTime = t
                    oldestUserPeerId = existingDesc.peerId
                  }
                }
              }
            }
            if (userPeerCount >= maxPeersPerUser) {
              if (
                !oldestUserPeerId ||
                now - oldestUserTime <= descriptorTtlMs
              ) {
                continue
              }
              evictVirtualPeerNow(oldestUserPeerId, peerDisconnectedErr)
            }
          }

          if (descriptors.size >= maxVerifiedDescriptors) {
            let oldestPeerId: string | null = null
            let oldestTime = Infinity
            for (const existingId of descriptors.keys()) {
              if (existingId !== selfId && !directPeers.has(existingId)) {
                const t = descriptorReceivedAt.get(existingId) ?? 0
                if (t < oldestTime) {
                  oldestTime = t
                  oldestPeerId = existingId
                }
              }
            }
            if (!oldestPeerId || now - oldestTime <= descriptorTtlMs) {
              continue
            }
            evictVirtualPeerNow(oldestPeerId, peerDisconnectedErr)
          }
        }

        if (
          latest?.encPubKey &&
          d.encPubKey &&
          toJson(latest.encPubKey) !== toJson(d.encPubKey)
        ) {
          derivedPairwiseKeys.delete(d.peerId)
        }
        const wasMarkedLeft = leftPeersSeq.delete(d.peerId)
        knownRoster.add(d.peerId)
        descriptors.set(d.peerId, d)
        descriptorReceivedAt.set(d.peerId, Date.now())
        adjacency.set(
          d.peerId,
          new Set(
            d.neighbors.filter(
              n =>
                !leftPeersSeq.has(n) &&
                !bannedPeers.has(n) &&
                (n !== selfId || directPeers.has(d.peerId))
            )
          )
        )
        if (wasMarkedLeft && !bannedPeers.has(d.peerId)) {
          for (const [otherId, otherDesc] of descriptors.entries()) {
            if (
              otherId !== selfId &&
              otherId !== d.peerId &&
              !leftPeersSeq.has(otherId) &&
              otherDesc.neighbors.includes(d.peerId)
            ) {
              let set = adjacency.get(otherId)
              if (!set) {
                set = new Set<string>()
                adjacency.set(otherId, set)
              }
              set.add(d.peerId)
            }
          }
        }
        newlyUpdated.push(d)
      }

      if (newlyUpdated.length > 0) {
        scheduleGossipFlush(newlyUpdated, fromPeerId)
      }
    }
  }

  const ensureOriginVirtualPeer = (
    origin: string,
    fromPeerId: string
  ): boolean => {
    if (directPeers.has(origin) || virtualPeers.has(origin)) {
      return true
    }
    if (capacityRejectedPeers.has(origin)) {
      return false
    }
    knownRoster.add(origin)
    if (!routes[origin]) {
      routes[origin] = {nextHop: fromPeerId, hops: 2}
    }
    const vPeer = createVirtualPeer(origin)
    if (onVirtualPeerJoin(origin, vPeer) === false) {
      vPeer.destroy()
      virtualPeers.delete(origin)
      capacityRejectedPeers.add(origin)
      return false
    }
    return true
  }

  const handleOverlayBinary = async (
    fromPeerId: string,
    bytes: Uint8Array
  ): Promise<void> => {
    if (isDestroyed) {
      return
    }
    const parsed = unpackOverlayBinary(bytes)
    if (!parsed) {
      return
    }

    const {kind, ttl: rawTtl, header, payload} = parsed
    const ttl = Math.min(rawTtl, maxAllowedHops)

    if (kind === overlayBroadcastKind) {
      const origin = typeof header['o'] === 'string' ? header['o'] : ''
      const seq = typeof header['q'] === 'number' ? header['q'] : Number.NaN
      const msgId = typeof header['m'] === 'string' ? header['m'] : ''
      const sig = typeof header['s'] === 'string' ? header['s'] : undefined

      if (
        !isValidSignalPeerId(origin) ||
        !msgId ||
        origin === selfId ||
        leftPeersSeq.has(origin)
      ) {
        return
      }

      if (
        !isValidOverlayMsgId(msgId) ||
        !Number.isSafeInteger(seq) ||
        seq < 1
      ) {
        stats.signatureFailures++
        return
      }

      if (bannedPeers.has(origin) || bannedPeers.has(fromPeerId)) {
        stats.signatureFailures++
        return
      }

      if (isOriginSeqReplay(origin, seq) || seenMsgIds.has(msgId)) {
        stats.duplicatesDropped++
        return
      }

      const valid = await verifyUnicastOrBroadcast(
        origin,
        canonicalBroadcastHeader(origin, msgId, seq, appId, roomId),
        payload,
        sig
      )
      if (!valid || isDestroyed || leftPeersSeq.has(origin)) {
        return
      }

      const wireHeader = inspectActionWireHeader(payload)
      if (wireHeader) {
        const requiredRoles = actionAuthorities.get(wireHeader.type)
        if (requiredRoles && requiredRoles.length > 0 && canPeerSendAction) {
          const metaObj =
            wireHeader.metadata && typeof wireHeader.metadata === 'object'
              ? (wireHeader.metadata as Record<string, unknown>)
              : undefined
          const authEnv = metaObj?.[authMetaKey] as
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

      if (!recordOriginSeq(origin, seq) || !seenMsgIds.add(msgId)) {
        stats.duplicatesDropped++
        return
      }

      if (descriptors.has(origin)) {
        descriptorReceivedAt.set(origin, Date.now())
      }
      if (!ensureOriginVirtualPeer(origin, fromPeerId)) {
        return
      }

      stats.messagesReceived++
      onDeliverData(origin, payload.slice().buffer)

      if (ttl > 1) {
        const forwardedCount = forwardBroadcastPacket(
          origin,
          ttl - 1,
          {o: origin, q: seq, m: msgId, ...(sig ? {s: sig} : {})},
          payload,
          fromPeerId
        )
        if (forwardedCount > 0) {
          stats.messagesForwarded++
        }
      }
      return
    }

    if (kind === overlayUnicastKind) {
      const origin = typeof header['o'] === 'string' ? header['o'] : ''
      const dest = typeof header['d'] === 'string' ? header['d'] : ''
      const seq = typeof header['q'] === 'number' ? header['q'] : Number.NaN
      const msgId = typeof header['m'] === 'string' ? header['m'] : ''
      const ivB64 = typeof header['iv'] === 'string' ? header['iv'] : undefined
      const sig = typeof header['s'] === 'string' ? header['s'] : undefined
      const rawLease = header['l']

      if (
        !isValidSignalPeerId(origin) ||
        !isValidSignalPeerId(dest) ||
        !msgId ||
        origin === selfId ||
        leftPeersSeq.has(origin) ||
        leftPeersSeq.has(dest)
      ) {
        return
      }

      if (
        !isValidOverlayMsgId(msgId) ||
        !ivB64 ||
        !Number.isSafeInteger(seq) ||
        seq < 1
      ) {
        stats.signatureFailures++
        return
      }

      let lease: UnicastLeaseTuple | undefined
      if (rawLease !== undefined) {
        if (
          !Array.isArray(rawLease) ||
          rawLease.length !== 3 ||
          typeof rawLease[0] !== 'number' ||
          typeof rawLease[1] !== 'number' ||
          typeof rawLease[2] !== 'string' ||
          !rawLease[2] ||
          !Number.isSafeInteger(rawLease[0]) ||
          !Number.isSafeInteger(rawLease[1]) ||
          rawLease[0] < 1 ||
          rawLease[1] < rawLease[0] ||
          rawLease[1] - rawLease[0] >= unicastLeaseWindowPackets ||
          seq < rawLease[0] ||
          seq > rawLease[1]
        ) {
          stats.signatureFailures++
          return
        }
        lease = [rawLease[0], rawLease[1], rawLease[2]]
      }

      if (
        bannedPeers.has(origin) ||
        bannedPeers.has(fromPeerId) ||
        bannedPeers.has(dest)
      ) {
        stats.signatureFailures++
        return
      }

      const relayLeaseKey = `${origin}\0${dest}`
      if (dest !== selfId && lease) {
        if (
          isSeqReplayInMap(relayLeaseReplay, relayLeaseKey, seq) ||
          seenMsgIds.has(msgId)
        ) {
          stats.duplicatesDropped++
          return
        }
      } else if (isOriginSeqReplay(origin, seq) || seenMsgIds.has(msgId)) {
        stats.duplicatesDropped++
        return
      }

      const canonical = canonicalUnicastHeader(
        origin,
        dest,
        msgId,
        ivB64,
        seq,
        appId,
        roomId
      )

      if (dest !== selfId) {
        if (ttl <= 1) {
          return
        }
        const validRelaySig = lease
          ? await verifyUnicastOrBroadcast(
              origin,
              canonicalUnicastLeaseHeader(
                origin,
                dest,
                lease[0],
                lease[1],
                appId,
                roomId
              ),
              new Uint8Array(),
              lease[2]
            )
          : await verifyUnicastOrBroadcast(origin, canonical, payload, sig)
        if (
          !validRelaySig ||
          isDestroyed ||
          leftPeersSeq.has(origin) ||
          leftPeersSeq.has(dest)
        ) {
          return
        }
        const recorded = lease
          ? recordSeqInMap(relayLeaseReplay, relayLeaseKey, seq)
          : recordOriginSeq(origin, seq)
        if (!recorded || !seenMsgIds.add(msgId)) {
          stats.duplicatesDropped++
          return
        }
        if (descriptors.has(origin)) {
          descriptorReceivedAt.set(origin, Date.now())
        }
        const forwarded = packOverlayBinary(
          overlayUnicastKind,
          ttl - 1,
          header,
          payload
        )
        if (routeUnicastPacket(dest, forwarded, fromPeerId)) {
          stats.messagesForwarded++
        }
        return
      }

      const valid = lease
        ? await verifyUnicastOrBroadcast(
            origin,
            canonicalUnicastLeaseHeader(
              origin,
              dest,
              lease[0],
              lease[1],
              appId,
              roomId
            ),
            new Uint8Array(),
            lease[2]
          )
        : await verifyUnicastOrBroadcast(origin, canonical, payload, sig)
      if (!valid || isDestroyed || leftPeersSeq.has(origin)) {
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
          {
            name: 'AES-GCM',
            iv: fromBase64(ivB64) as BufferSource,
            additionalData: encodeBytes(canonical) as BufferSource
          },
          aesKey,
          payload as BufferSource
        )
        plainPayload = new Uint8Array(decrypted)
      } catch {
        stats.signatureFailures++
        return
      }

      if (!recordOriginSeq(origin, seq) || !seenMsgIds.add(msgId)) {
        stats.duplicatesDropped++
        return
      }

      if (descriptors.has(origin)) {
        descriptorReceivedAt.set(origin, Date.now())
      }
      if (!ensureOriginVirtualPeer(origin, fromPeerId)) {
        return
      }

      stats.messagesReceived++
      onDeliverData(origin, plainPayload.slice().buffer)
    }
  }

  const isOverlayFrame = (data: ArrayBuffer): boolean => {
    if (data.byteLength < 2) {
      return false
    }
    return new Uint8Array(data, 0, 1)[0] === overlayFrameVersion
  }

  const handleOverlayFrame = (fromPeerId: string, data: ArrayBuffer): void => {
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
      let parsed: OverlayControlMessage
      try {
        parsed = fromJson<OverlayControlMessage>(decodeBytes(bytes.subarray(2)))
      } catch {
        return
      }
      const prev = inboundOriginQueues.get(fromPeerId) ?? Promise.resolve()
      const next = prev
        .then(() => handleControlFrame(fromPeerId, parsed))
        .catch(noOp)
        .finally(() => {
          if (inboundOriginQueues.get(fromPeerId) === next) {
            inboundOriginQueues.delete(fromPeerId)
          }
        })
      inboundOriginQueues.set(fromPeerId, next)
      return
    }
    if (kind === overlayBroadcastKind || kind === overlayUnicastKind) {
      const copy = bytes.slice()
      const prev = inboundOriginQueues.get(fromPeerId) ?? Promise.resolve()
      const next = prev
        .then(() => handleOverlayBinary(fromPeerId, copy))
        .catch(noOp)
        .finally(() => {
          if (inboundOriginQueues.get(fromPeerId) === next) {
            inboundOriginQueues.delete(fromPeerId)
          }
        })
      inboundOriginQueues.set(fromPeerId, next)
    }
  }

  const refreshPasswordSalt = (): void => {
    const token = ++passwordSaltToken
    if (!password) {
      passwordTopologySalt = ''
      return
    }
    const targetRoomId = roomId
    void signRoomAuth(password, appId, targetRoomId, '@topology', 0)
      .then(salt => {
        if (
          !isDestroyed &&
          token === passwordSaltToken &&
          roomId === targetRoomId &&
          passwordTopologySalt !== salt
        ) {
          passwordTopologySalt = salt
          recomputeTopologyAndRoutes()
          scheduleTargetsNotification()
        }
      })
      .catch(noOp)
  }

  refreshPasswordSalt()

  return {
    config,

    isOverlayActive,

    getActiveMode: () => {
      updateActiveMode()
      return currentActiveMode
    },

    isOverlayFrame,

    handleOverlayFrame,

    handleFrame: (fromPeerId: string, data: ArrayBuffer): boolean => {
      if (!isOverlayFrame(data)) {
        return false
      }
      if (!directPeers.has(fromPeerId)) {
        let q = pendingFramesByPeer.get(fromPeerId)
        if (!q) {
          q = []
          pendingFramesByPeer.set(fromPeerId, q)
        }
        if (q.length < 32) {
          q.push(data.slice(0))
        }
        return true
      }
      handleOverlayFrame(fromPeerId, data)
      return true
    },

    addDirectPeer: (peerId: string, peer: PeerHandle): void => {
      if (
        isDestroyed ||
        !isValidSignalPeerId(peerId) ||
        peerId === selfId ||
        bannedPeers.has(peerId)
      ) {
        return
      }

      leftPeersSeq.delete(peerId)
      capacityRejectedPeers.delete(peerId)
      knownRoster.add(peerId)

      const timer = unreachableTimers.get(peerId)
      if (timer) {
        resetTimer(timer)
        unreachableTimers.delete(peerId)
      }

      const existingVirtual = virtualPeers.get(peerId)
      if (existingVirtual) {
        existingVirtual.destroy()
        virtualPeers.delete(peerId)
      }

      directPeers.set(peerId, peer)
      recomputeTopologyAndRoutes()

      const queued = pendingFramesByPeer.get(peerId)
      if (queued) {
        pendingFramesByPeer.delete(peerId)
        for (const frame of queued) {
          handleOverlayFrame(peerId, frame)
        }
      }

      if (isOverlayActive()) {
        const initialKnownIds = new Set<string>()
        for (const d of descriptors.values()) {
          if (d.peerId !== selfId && d.peerId !== peerId) {
            initialKnownIds.add(d.peerId)
          }
        }
        void publishLocalDescriptor().then(() => {
          if (initialKnownIds.size === 0) {
            return
          }
          const initialKnown: PeerDescriptor[] = []
          for (const knownId of initialKnownIds) {
            const d = descriptors.get(knownId)
            if (d) {
              initialKnown.push(d)
            }
          }
          for (const packet of packGossipControlFrames(initialKnown)) {
            sendToDirectNeighbor(peerId, packet)
          }
        })
      }
    },

    removeDirectPeer: (
      peerId: string,
      peer?: PeerHandle,
      reason?: Error
    ): void => {
      const current = directPeers.get(peerId)
      if (!current || (peer && current !== peer)) {
        if (!current) {
          pendingFramesByPeer.delete(peerId)
          const existingVPeer = virtualPeers.get(peerId)
          if (existingVPeer && routes[peerId]) {
            onVirtualPeerJoin(peerId, existingVPeer)
            return
          }
          if (!existingVPeer) {
            const lastSeq = descriptors.get(peerId)?.seq ?? 0
            if (lastSeq > 0 || reason?.message === peerLeftRoomErr.message) {
              recordLeftPeer(peerId, lastSeq)
            }
            purgePeerFromGraph(peerId)
            recomputeTopologyAndRoutes()
          }
        }
        return
      }

      pendingFramesByPeer.delete(peerId)
      directPeers.delete(peerId)
      capacityRejectedPeers.clear()

      if (!isOverlayActive()) {
        purgePeerFromGraph(peerId)
        recomputeTopologyAndRoutes()
        return
      }

      const lastSeq = descriptors.get(peerId)?.seq ?? 0
      recordLeftPeer(peerId, lastSeq)
      purgePeerFromGraph(peerId)

      recomputeTopologyAndRoutes()
      void publishLocalDescriptor()
    },

    isDirectPeer: (peerId: string): boolean => directPeers.has(peerId),

    isVirtualPeer: (peerId: string): boolean => virtualPeers.has(peerId),

    getRoute: (peerId: string): TopologyRoute | undefined => routes[peerId],

    broadcastInline,

    sendUnicast,

    requireDirectPeer,

    notePeerDiscovered: (peerId: string): void => {
      if (
        !isValidSignalPeerId(peerId) ||
        peerId === selfId ||
        bannedPeers.has(peerId)
      ) {
        return
      }
      addDiscoveredCandidate(peerId)
      if (descriptors.size <= 1) {
        scheduleTargetsNotification()
      }
    },

    shouldConnectPeer: (
      peerId: string,
      direction: 'outbound' | 'inbound'
    ): boolean => {
      if (
        !isValidSignalPeerId(peerId) ||
        peerId === selfId ||
        bannedPeers.has(peerId)
      ) {
        return false
      }
      if (directPeers.has(peerId) || requiredDirectPeers.has(peerId)) {
        return true
      }

      addDiscoveredCandidate(peerId)
      updateActiveMode()

      if (currentActiveMode === 'mesh') {
        return true
      }

      const targets = computeEffectiveTargets()

      if (direction === 'outbound') {
        if (targets.has(peerId) && directPeers.size < config.maxConnections) {
          return true
        }
        const minDirectPeers = Math.min(
          defaultMinConnections,
          config.maxConnections
        )
        if (directPeers.size < minDirectPeers) {
          return true
        }
        if (
          hasCompletedInitialBootstrap &&
          !knownRoster.has(peerId) &&
          !leftPeersSeq.has(peerId) &&
          !capacityRejectedPeers.has(peerId) &&
          selfId < peerId &&
          directPeers.size < config.maxConnections + 2 &&
          isAssignedGatekeeperFor(peerId)
        ) {
          return true
        }
        return false
      }

      if (targets.has(peerId) && directPeers.size < config.maxConnections) {
        return true
      }

      const minDirectPeers = Math.min(
        defaultMinConnections,
        config.maxConnections
      )
      if (directPeers.size < minDirectPeers) {
        return true
      }

      return directPeers.size < config.maxConnections * 2
    },

    getTargetNeighbors: (): Set<string> => computeEffectiveTargets(),

    setOnTargetsChanged: (cb: (targetPeerIds: string[]) => void): void => {
      targetsChangedCallback = cb
    },

    getLocalCryptoIdentity: async (): Promise<CryptoIdentity> => {
      const id = identityReady ?? (await getLocalCryptoIdentityImpl())
      identityReady = id
      return id
    },

    getPeerSignPublicKey: (peerId: string): JsonWebKey | undefined =>
      peerSignPubKeys.get(peerId) ?? descriptors.get(peerId)?.signPubKey,

    setPeerSignPublicKey: (peerId: string, pubKey: JsonWebKey): void => {
      if (!isValidSignalPeerId(peerId) || !pubKey) {
        return
      }
      const cached = getCachedPubKeyRecord(pubKey)
      if (cached && cached.peerId === peerId) {
        peerSignPubKeys.set(peerId, pubKey)
        pinnedSignKeys.set(peerId, toJson(pubKey))
        return
      }
      void verifyPeerIdKey(peerId, pubKey).then(ok => {
        if (ok) {
          peerSignPubKeys.set(peerId, pubKey)
          pinnedSignKeys.set(peerId, toJson(pubKey))
        }
      })
    },

    setLocalRoleCertificate: (cert: RoleCertificate | null): void => {
      localRoleCert = cert
      if (isOverlayActive()) {
        void publishLocalDescriptor()
      }
    },

    markPeerBanned: (peerId: string): void => {
      bannedPeers.add(peerId)
      requiredDirectPeers.delete(peerId)
      const lastSeq = descriptors.get(peerId)?.seq ?? Number.MAX_SAFE_INTEGER
      recordLeftPeer(peerId, lastSeq)
      evictVirtualPeerNow(peerId, peerBannedErr)
      recomputeTopologyAndRoutes()
      if (isOverlayActive()) {
        void publishLocalDescriptor()
      }
    },

    isPeerBanned: (peerId: string): boolean => bannedPeers.has(peerId),

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
        refreshPasswordSalt()
        didInitSessionSeqFloor = false
        syncSessionSeqFloor(selfId)
        derivedPairwiseKeys.clear()
        outboundUnicastLeases.clear()
        lastUnicastSeqByTarget.clear()
        relayLeaseReplay.clear()
        capacityRejectedPeers.clear()
        const existingPeerIds = [...descriptors.keys()]
        for (const existingPeerId of existingPeerIds) {
          if (existingPeerId !== selfId) {
            evictVirtualPeerNow(existingPeerId, peerDisconnectedErr)
          }
        }
        recomputeTopologyAndRoutes()
        if (isOverlayActive()) {
          void publishLocalDescriptor()
        }
      }
    },

    announceLeave: (): void => {
      if (isDestroyed || !isOverlayActive() || directPeers.size === 0) {
        return
      }
      const seq = ++localDescriptorSeq
      recordLocalSeqProgress()
      void signUnicastOrBroadcast(
        canonicalLeaveHeader(selfId, seq, appId, roomId),
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
      resetTimer(heartbeatTimer)
      pendingFramesByPeer.clear()
      inboundOriginQueues.clear()
      outboundUnicastQueues.clear()
      outboundUnicastLeases.clear()
      lastUnicastSeqByTarget.clear()
      relayLeaseReplay.clear()
      capacityRejectedPeers.clear()
      requiredDirectPeers.clear()
      for (const timer of unreachableTimers.values()) {
        resetTimer(timer)
      }
      unreachableTimers.clear()
      for (const vPeer of virtualPeers.values()) {
        vPeer.destroy()
      }
      virtualPeers.clear()
      directPeers.clear()
    },

    getSnapshot: (): TopologySnapshot => {
      updateActiveMode()
      const directPeerIds = [...directPeers.keys()].sort()
      const roomPeerSet = new Set<string>([
        ...directPeerIds,
        ...virtualPeers.keys()
      ])

      return {
        mode: config.mode,
        activeMode: currentActiveMode,
        selfId,
        directPeerIds,
        roomPeerIds: [...roomPeerSet].sort(),
        routes: {...routes},
        stats: {...stats}
      }
    }
  }
}

export const scale = (
  topology?: TopologyMode | ScaleConfig
): RoomPlugin<'scale', ScalePluginApi> => {
  normalizeTopologyConfig(topology)

  return definePlugin('scale', {
    setup: kernel => {
      const pendingMediaPeers = new Map<
        string,
        {
          promise: Promise<PeerHandle>
          resolve: (peer: PeerHandle) => void
          reject: (reason: Error) => void
        }
      >()
      const mediaControlAction = kernel.makeInternalAction<{op: 'connect'}>(
        'mctrl'
      )

      const overlay = createOverlayManager({
        selfId: kernel.selfId,
        appId: kernel.appId,
        roomId: kernel.getRoomId(),
        password: kernel.password,
        ...(topology === undefined ? {} : {topology}),
        ...(kernel.limit === undefined ? {} : {maxUsers: kernel.limit}),
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
        }
      })

      mediaControlAction.onMessage((msg, id) => {
        if (msg?.op === 'connect') {
          overlay.requireDirectPeer(id)
        }
      })

      kernel.onPeerActivated((id, peer) => {
        pendingMediaPeers.get(id)?.resolve(peer)
      })
      kernel.onPeerDeactivated(id => {
        pendingMediaPeers.get(id)?.reject(peerDisconnectedErr)
      })

      const origRemoveDirectPeer = overlay.removeDirectPeer
      overlay.removeDirectPeer = (peerId, peer, reason) => {
        if (reason) {
          pendingMediaPeers.get(peerId)?.reject(reason)
        }
        origRemoveDirectPeer(peerId, peer, reason)
      }

      overlay.prepareMediaPeer = (id: string, peer: PeerHandle) => {
        if (overlay.isDirectPeer(id)) {
          return Promise.resolve(peer)
        }
        const pending = pendingMediaPeers.get(id)
        if (pending) {
          return pending.promise
        }
        let resolve!: (peer: PeerHandle) => void
        let reject!: (reason: Error) => void
        const promise = new Promise<PeerHandle>((res, rej) => {
          resolve = res
          reject = rej
        })
        const timer = setTimeout(
          () => reject(mkErr('timed out connecting media peer')),
          10_000
        )
        const settled = promise.finally(() => {
          clearTimeout(timer)
          pendingMediaPeers.delete(id)
        })
        pendingMediaPeers.set(id, {promise: settled, resolve, reject})
        void mediaControlAction
          .send({op: 'connect'}, id)
          .then(() => {
            overlay.requireDirectPeer(id)
          })
          .catch(err => reject(toError(err, 'failed connecting media peer')))
        return settled
      }

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
  unpackOverlayBinary
}
