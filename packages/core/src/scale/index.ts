import type {InternalRoomContext} from '../internal-types'
import {
  makeInternalPlugin,
  mkErr,
  noOp,
  peerDisconnectedErr,
  toError,
  unrefTimer
} from '../utils'
import type {
  PeerHandle,
  RoomPlugin,
  ScaleConfig,
  ScalePluginApi,
  TopologyMode
} from '../types'
import {initOverlayManager} from './manager'
import {
  defaultDescriptorTtlMs,
  defaultUnreachableGraceMs,
  normalizeTopologyConfig
} from './topology'

export * from './topology'
export * from './crypto-frame'
export * from './manager'

export const scale = (
  topology?: TopologyMode | ScaleConfig
): RoomPlugin<'scale', ScalePluginApi> => {
  normalizeTopologyConfig(topology)

  const setupInternal = (kernel: InternalRoomContext): ScalePluginApi => {
    const pendingMediaPeers = new Map<
      string,
      [
        promise: Promise<PeerHandle>,
        resolve: (peer: PeerHandle) => void,
        reject: (reason: Error) => void
      ]
    >()
    const mediaControlAction = kernel.makeInternalAction<{
      op: 'connect' | 'ack'
    }>('mctrl')

    const prepareMediaPeer = (id: string): Promise<PeerHandle> => {
      const existingDirect = kernel.getPeerHandle(id, false)
      if (existingDirect && provider.isDirectPeer(id)) {
        return Promise.resolve(existingDirect)
      }
      const pending = pendingMediaPeers.get(id)
      if (pending) {
        return pending[0]
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
      unrefTimer(timer)
      const fallbackDialTimer = setTimeout(() => {
        if (pendingMediaPeers.has(id) && !provider.isDirectPeer(id)) {
          provider.requireDirectPeer(id)
        }
      }, 150)
      unrefTimer(fallbackDialTimer)
      const settled = promise.finally(() => {
        clearTimeout(timer)
        clearTimeout(fallbackDialTimer)
        pendingMediaPeers.delete(id)
      })
      pendingMediaPeers.set(id, [settled, resolve, reject])
      provider.requireDirectPeer(id, {dial: false})
      void mediaControlAction
        .send({op: 'connect'}, id)
        .catch(err => reject(toError(err, 'failed connecting media peer')))
      return settled
    }

    const [provider, setRoomId] = initOverlayManager(
      kernel.selfId,
      kernel.appId,
      kernel.getRoomId(),
      kernel.password,
      topology,
      defaultDescriptorTtlMs,
      defaultUnreachableGraceMs,
      kernel.limit,
      kernel.getLocalUserIdentity,
      kernel.activateVirtualPeer,
      kernel.deactivateVirtualPeer,
      kernel.deliverRawData,
      prepareMediaPeer,
      (peerId, reason) => {
        if (reason) {
          pendingMediaPeers.get(peerId)?.[2](reason)
        }
      },
      (peerId, requiredRoles, inlineCert) =>
        kernel
          .getRolesProvider()
          ?.canPeerSendAction(peerId, requiredRoles, inlineCert) ?? true,
      (peerId, signPubKey, cert, userId) => {
        if (userId) {
          kernel.setPeerUserId(peerId, userId)
        }
        kernel.setPeerPublicKey(peerId, signPubKey)
        kernel
          .getRolesProvider()
          ?.onPeerDescriptorCert(peerId, signPubKey, cert, userId)
      }
    )

    mediaControlAction.onMessage((msg, id) => {
      if (msg?.op === 'connect') {
        if (provider.acceptMediaConnectRequest(id)) {
          void mediaControlAction.send({op: 'ack'}, id).catch(noOp)
        }
      } else if (msg?.op === 'ack' && pendingMediaPeers.has(id)) {
        provider.requireDirectPeer(id)
      }
    })

    kernel.onPeerActivated((id, peer) => {
      pendingMediaPeers.get(id)?.[1](peer)
    })
    kernel.onPeerDeactivated(id => {
      pendingMediaPeers.get(id)?.[2](peerDisconnectedErr)
    })
    kernel.onLeave(() => {
      for (const pending of pendingMediaPeers.values()) {
        pending[2](peerDisconnectedErr)
      }
      pendingMediaPeers.clear()
    })

    kernel.registerScaleProvider(provider)
    kernel.onRoomIdChanged(setRoomId)

    return {
      getTopology: provider.getSnapshot
    }
  }

  return makeInternalPlugin('scale', setupInternal)
}
