import {
  canonicalizePubJwk,
  createEndpointIdentity,
  createUserIdentity,
  type DevIdentityProvider,
  type EndpointIdentity,
  setDevIdentityProvider
} from '../../packages/core/src/identity.ts'
import type {
  BaseRoomConfig,
  JoinRoom,
  JoinRoomConfig,
  UserIdentity
} from '../../packages/core/src/types.ts'

let currentTestPeerId: string | undefined
const endpointByPeerId = new Map<string, Promise<EndpointIdentity>>()
const canonicalJwkByPeerId = new Map<string, string>()
const userIdentityByPeerId = new Map<string, Promise<UserIdentity>>()

const testIdentityProvider: DevIdentityProvider = {
  getEndpointIdentity: peerId => {
    const targetId = peerId ?? currentTestPeerId
    if (!targetId) {
      return undefined
    }
    let existing = endpointByPeerId.get(targetId)
    if (!existing) {
      existing = createEndpointIdentity().then(base => {
        canonicalJwkByPeerId.set(targetId, canonicalizePubJwk(base.signPubJwk))
        return {...base, peerId: targetId}
      })
      endpointByPeerId.set(targetId, existing)
    }
    return existing
  },
  isPeerIdKeyCachedValid: (peerId, rec) =>
    canonicalJwkByPeerId.get(peerId) === rec.canonicalJwk,
  verifyPeerIdKey: async (peerId, rec) => {
    const cachedJwk = canonicalJwkByPeerId.get(peerId)
    if (cachedJwk !== undefined) {
      return cachedJwk === rec.canonicalJwk
    }
    const pending = endpointByPeerId.get(peerId)
    if (!pending) {
      return false
    }
    const ep = await pending
    return canonicalizePubJwk(ep.signPubJwk) === rec.canonicalJwk
  },
  getUserIdentity: peerId => {
    const targetId = peerId ?? currentTestPeerId
    if (!targetId) {
      return undefined
    }
    let existing = userIdentityByPeerId.get(targetId)
    if (!existing) {
      existing = createUserIdentity()
      userIdentityByPeerId.set(targetId, existing)
    }
    return existing
  }
}

setDevIdentityProvider(testIdentityProvider)

export const withTestPeerId = <T>(peerId: string, fn: () => T): T => {
  const prev = currentTestPeerId
  currentTestPeerId = peerId
  try {
    return fn()
  } finally {
    currentTestPeerId = prev
  }
}

export const joinAsTestPeer = <TConfig extends BaseRoomConfig = JoinRoomConfig>(
  peerId: string,
  joinRoom: JoinRoom<TConfig>
): JoinRoom<TConfig> =>
  ((config, roomId, callbacks) =>
    withTestPeerId(peerId, () =>
      joinRoom(config, roomId, callbacks)
    )) as JoinRoom<TConfig>
