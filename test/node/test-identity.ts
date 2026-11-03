import {
  createEndpointIdentity,
  type EndpointIdentity
} from '../../packages/core/src/identity.ts'
import type {
  BaseRoomConfig,
  JoinRoom,
  JoinRoomConfig
} from '../../packages/core/src/types.ts'

const clusterPoolSize = 300
const namedPoolSize = 96

const allEndpoints = await Promise.all(
  Array.from({length: clusterPoolSize + namedPoolSize}, () =>
    createEndpointIdentity()
  )
)

const sortedClusterPool = allEndpoints
  .slice(0, clusterPoolSize)
  .sort((a, b) => (a.peerId < b.peerId ? -1 : a.peerId > b.peerId ? 1 : 0))

const namedPool = allEndpoints.slice(clusterPoolSize)
const endpointByPeerId = new Map<string, EndpointIdentity>(
  allEndpoints.map(ep => [ep.peerId, ep])
)
const endpointByLabel = new Map<string, EndpointIdentity>()
let nextNamedIndex = 0

export const allocTestPeerIds = (count: number): string[] => {
  if (count > sortedClusterPool.length) {
    throw new Error(
      `allocTestPeerIds(${count}) exceeds pre-warmed pool (${sortedClusterPool.length})`
    )
  }
  return sortedClusterPool.slice(0, count).map(ep => ep.peerId)
}

export const testEndpoint = (label: string): EndpointIdentity => {
  const byId = endpointByPeerId.get(label)
  if (byId) {
    return byId
  }
  const existing = endpointByLabel.get(label)
  if (existing) {
    return existing
  }
  const ep = namedPool[nextNamedIndex % namedPool.length]!
  nextNamedIndex++
  endpointByLabel.set(label, ep)
  return ep
}

export const getTestEndpointByPeerId = (peerId: string): EndpointIdentity =>
  endpointByPeerId.get(peerId) ?? testEndpoint(peerId)

export const testPeerId = (label: string): string => testEndpoint(label).peerId

export const withTestPeerId = <T>(_peerId: string, fn: () => T): T => fn()

export const joinAsTestPeer = <TConfig extends BaseRoomConfig = JoinRoomConfig>(
  _peerId: string,
  joinRoom: JoinRoom<TConfig>
): JoinRoom<TConfig> => joinRoom

export const createSortedJoinRooms = async <
  TConfig extends BaseRoomConfig = JoinRoomConfig
>(
  count: number,
  makeJoin: () => JoinRoom<TConfig>,
  appId: string
): Promise<Array<{joinRoom: JoinRoom<TConfig>; peerId: string}>> => {
  const entries = await Promise.all(
    Array.from({length: count}, async (_, i) => {
      const joinRoom = makeJoin()
      const warm = joinRoom(
        {appId} as TConfig & {use?: undefined},
        `__warm_${i}__`
      )
      const {peerId} = await warm.getSelf()
      await warm.leave()
      return {joinRoom, peerId}
    })
  )
  return entries.sort((a, b) =>
    a.peerId < b.peerId ? -1 : a.peerId > b.peerId ? 1 : 0
  )
}
