import {hash32} from '../primitives'
import type {ScaleConfig, TopologyRoute} from '../types'
import {cmpStr, createBoundedCache, mkErr, toJson} from '../utils'

const defaultMaxDirectPeers = 6
const minMaxDirectPeers = 4
const maxMaxDirectPeers = 32
export const maxAllowedHops = 64
export const defaultDescriptorTtlMs = 180_000
export const defaultUnreachableGraceMs = 1_200

export type ResolvedTopologyConfig = {
  maxDirectPeers: number
}

export const deriveMaxHops = (
  rosterSize: number,
  maxDirectPeers: number = defaultMaxDirectPeers
): number => {
  const n = Math.max(2, rosterSize)
  const dims = Math.max(2, Math.floor(maxDirectPeers / 2))
  const theoreticalDiameter = Math.ceil(dims * Math.pow(n, 1 / dims))
  return Math.min(maxAllowedHops, Math.max(12, theoreticalDiameter * 2))
}

export const normalizeTopologyConfig = (
  config?: ScaleConfig
): ResolvedTopologyConfig => {
  if (config === undefined) {
    return {maxDirectPeers: defaultMaxDirectPeers}
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw mkErr('scale config must be an object')
  }
  const maxDirectPeers = config.maxDirectPeers ?? defaultMaxDirectPeers
  if (
    !Number.isSafeInteger(maxDirectPeers) ||
    maxDirectPeers < minMaxDirectPeers ||
    maxDirectPeers > maxMaxDirectPeers
  ) {
    throw mkErr(
      `scale.maxDirectPeers must be an integer between ${minMaxDirectPeers} and ${maxMaxDirectPeers}`
    )
  }
  return {maxDirectPeers}
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
  maxDirectPeers: number = defaultMaxDirectPeers,
  roomSalt: string = ''
): Set<string> => {
  const unique = new Set<string>(rosterIds)
  unique.add(localPeerId)
  const total = unique.size
  const targets = new Set<string>()

  if (total <= 1 || !unique.has(localPeerId)) {
    return targets
  }

  if (total - 1 <= maxDirectPeers) {
    for (const id of [...unique].sort()) {
      if (id !== localPeerId) {
        targets.add(id)
      }
    }
    return targets
  }

  // Union of d = floor(maxDirectPeers / 2) independent permuted Hamiltonian cycles:
  // strictly symmetric, degree <= 2*d <= maxDirectPeers at every node, O(log N) expander diameter.
  const numRings = Math.max(2, Math.floor(maxDirectPeers / 2))
  const uniqueList = [...unique]

  for (let r = 0; r < numRings; r++) {
    const ringSalt = toJson([roomSalt, 'ring', r])
    const ringSorted = uniqueList
      .map(id => [id, hashRingKey(ringSalt, id)] as const)
      .sort((a, b) => cmpStr(a[1], b[1]))
      .map(e => e[0])
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

export const isExcludedPeer = (
  peerId: string,
  exclude?: string | ReadonlySet<string>
): boolean =>
  exclude === undefined
    ? false
    : typeof exclude === 'string'
      ? peerId === exclude
      : exclude.has(peerId)

export const computeShortestPathRoutes = (
  localPeerId: string,
  adjacency: Map<string, Set<string>>,
  directPeerIds: Iterable<string>,
  maxHops: number = maxAllowedHops,
  excludePeerIds?: string | ReadonlySet<string>,
  directOnlyExclude = false
): Record<string, TopologyRoute> => {
  const routes: Record<string, TopologyRoute> = {}
  if (maxHops < 1) {
    return routes
  }
  const baseDirectSet = new Set(directPeerIds)
  if (typeof excludePeerIds === 'string') {
    baseDirectSet.delete(excludePeerIds)
  }
  const directSet =
    excludePeerIds !== undefined && typeof excludePeerIds !== 'string'
      ? baseDirectSet.difference(excludePeerIds)
      : baseDirectSet
  const graph = buildUndirectedGraph(adjacency, localPeerId, directSet)

  const visited = new Map<string, [nextHop: string, hops: number]>()
  const queue: Array<[node: string, nextHop: string, hops: number]> = []

  for (const d of [...directSet].sort()) {
    visited.set(d, [d, 1])
    queue.push([d, d, 1])
  }

  let head = 0
  while (head < queue.length) {
    const [node, nextHop, hops] = queue[head++]!
    if (hops >= maxHops) {
      continue
    }
    const neighbors = graph.get(node)
    if (!neighbors) {
      continue
    }

    for (const neighbor of neighbors) {
      if (
        neighbor === localPeerId ||
        (!directOnlyExclude && isExcludedPeer(neighbor, excludePeerIds)) ||
        visited.has(neighbor)
      ) {
        continue
      }
      visited.set(neighbor, [nextHop, hops + 1])
      queue.push([neighbor, nextHop, hops + 1])
    }
  }

  for (const [peerId, info] of visited.entries()) {
    routes[peerId] = {
      nextHop: info[0],
      hops: info[1]
    }
  }

  return routes
}
