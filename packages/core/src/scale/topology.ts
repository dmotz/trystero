import {hash32} from '../crypto'
import {createBoundedCache, mkErr, toJson} from '../utils'
import type {ScaleConfig, TopologyMode, TopologyRoute} from '../types'

export const defaultMaxConnections = 6
export const defaultMinConnections = 3
export const defaultAutoThreshold = 12
export const maxAllowedHops = 64
export const defaultMaxHops = 16
export const defaultDescriptorTtlMs = 180_000
export const defaultUnreachableGraceMs = 1_200

export type ResolvedTopologyConfig = {
  mode: TopologyMode
  maxConnections: number
  autoThreshold: number
}

export const deriveMaxHops = (
  rosterSize: number,
  maxConnections: number = defaultMaxConnections
): number => {
  const n = Math.max(2, rosterSize)
  const dims = Math.max(2, Math.floor(maxConnections / 2))
  const theoreticalDiameter = Math.ceil(dims * Math.pow(n, 1 / dims))
  return Math.min(maxAllowedHops, Math.max(12, theoreticalDiameter * 2))
}

const validModes = /*@__PURE__*/ new Set<TopologyMode>(['auto', 'gossip'])

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

const ringKeyCache = /*@__PURE__*/ createBoundedCache<string, string>(8_192)

export const hashRingKey = (ringSalt: string, peerId: string): string => {
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

export const capRosterPeersPerUser = (
  baseRoster: Set<string>,
  selfId: string,
  activeMode: 'mesh' | 'gossip',
  maxConnections: number,
  getDescriptorUserId: (peerId: string) => string | undefined
): Set<string> => {
  if (activeMode === 'mesh' || baseRoster.size <= maxConnections + 1) {
    return baseRoster
  }
  const maxSlotsPerUser = Math.max(1, Math.floor(maxConnections / 3))
  const byUser = new Map<string, string[]>()
  for (const id of baseRoster) {
    if (id === selfId) {
      continue
    }
    const uid = getDescriptorUserId(id)
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
    if (otherPeerCount < maxConnections) {
      continue
    }
    const sorted = [...userPeers].sort()
    for (let i = maxSlotsPerUser; i < sorted.length; i++) {
      filtered.delete(sorted[i]!)
    }
  }
  return filtered
}

export const isAssignedGatekeeper = (
  selfId: string,
  candidateId: string,
  cappedRoster: Set<string>,
  roomSalt: string,
  isExcluded: (peerId: string) => boolean
): boolean => {
  const gateSalt = toJson([roomSalt, 'gate', candidateId])
  const lowerVerified: Array<{id: string; key: string}> = []
  for (const u of cappedRoster) {
    if (u < candidateId && !isExcluded(u)) {
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
