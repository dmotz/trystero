import type {InternalRoomContext} from '../internal-types'
import {internalPluginSymbol} from '../primitives'
import {definePlugin, mkErr, noOp, peerDisconnectedErr, toError} from '../utils'
import type {
  PeerHandle,
  RoomPlugin,
  ScaleConfig,
  ScalePluginApi,
  TopologyMode
} from '../types'
import {createOverlayManager} from './manager'
import {normalizeTopologyConfig} from './topology'

export * from './topology'
export * from './connection-policy'
export * from './crypto-frame'
export * from './descriptors'
export * from './virtual-transport'
export * from './router'
export * from './manager'

export const scale = (
  topology?: TopologyMode | ScaleConfig
): RoomPlugin<'scale', ScalePluginApi> => {
  normalizeTopologyConfig(topology)

  const setupInternal = (kernel: InternalRoomContext): ScalePluginApi => {
    const pendingMediaPeers = new Map<
      string,
      {
        promise: Promise<PeerHandle>
        resolve: (peer: PeerHandle) => void
        reject: (reason: Error) => void
      }
    >()
    const mediaControlAction = kernel.makeInternalAction<{
      op: 'connect' | 'ack'
    }>('mctrl')

    const prepareMediaPeer = (id: string): Promise<PeerHandle> => {
      const existingDirect = kernel.getPeerHandle(id, false)
      if (existingDirect && overlay.isDirectPeer(id)) {
        return Promise.resolve(existingDirect)
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
      ;(timer as {unref?: () => void}).unref?.()
      const fallbackDialTimer = setTimeout(() => {
        if (pendingMediaPeers.has(id) && !overlay.isDirectPeer(id)) {
          overlay.requireDirectPeer(id)
        }
      }, 150)
      ;(fallbackDialTimer as {unref?: () => void}).unref?.()
      const settled = promise.finally(() => {
        clearTimeout(timer)
        clearTimeout(fallbackDialTimer)
        pendingMediaPeers.delete(id)
      })
      pendingMediaPeers.set(id, {promise: settled, resolve, reject})
      overlay.requireDirectPeer(id, {dial: false})
      void mediaControlAction
        .send({op: 'connect'}, id)
        .catch(err => reject(toError(err, 'failed connecting media peer')))
      return settled
    }

    const overlay = createOverlayManager({
      selfId: kernel.selfId,
      appId: kernel.appId,
      roomId: kernel.getRoomId(),
      password: kernel.password,
      ...(topology === undefined ? {} : {topology}),
      ...(kernel.limit === undefined ? {} : {maxUsers: kernel.limit}),
      getLocalUserIdentity: () => kernel.getLocalUserIdentity(),
      onVirtualPeerJoin: (peerId, vTransport) =>
        kernel.activateVirtualPeer(peerId, vTransport),
      onVirtualPeerLeave: (peerId, reason) =>
        kernel.deactivateVirtualPeer(peerId, reason),
      onDeliverData: (originPeerId, data) =>
        kernel.deliverRawData(originPeerId, data),
      prepareMediaPeer,
      onRemoveDirectPeer: (peerId, reason) => {
        if (reason) {
          pendingMediaPeers.get(peerId)?.reject(reason)
        }
      },
      canPeerSendAction: (peerId, requiredRoles, inlineCert) => {
        const rp = kernel.getInternalRolesProvider()
        return rp
          ? rp.canPeerSendAction(peerId, requiredRoles, inlineCert)
          : true
      },
      onPeerDescriptorCert: (peerId, signPubKey, cert, userId) => {
        if (userId) {
          kernel.setPeerUserId(peerId, userId)
        }
        kernel.setPeerPublicKey(peerId, signPubKey)
        const rp = kernel.getInternalRolesProvider()
        if (rp) {
          rp.onPeerDescriptorCert(peerId, signPubKey, cert, userId)
        }
      }
    })

    mediaControlAction.onMessage((msg, id) => {
      if (msg?.op === 'connect') {
        if (overlay.acceptMediaConnectRequest(id)) {
          void mediaControlAction.send({op: 'ack'}, id).catch(noOp)
        }
      } else if (msg?.op === 'ack' && pendingMediaPeers.has(id)) {
        overlay.requireDirectPeer(id)
      }
    })

    kernel.onPeerActivated((id, peer) => {
      pendingMediaPeers.get(id)?.resolve(peer)
    })
    kernel.onPeerDeactivated(id => {
      pendingMediaPeers.get(id)?.reject(peerDisconnectedErr)
    })
    kernel.onLeave(() => {
      for (const pending of pendingMediaPeers.values()) {
        pending.reject(peerDisconnectedErr)
      }
      pendingMediaPeers.clear()
    })

    kernel.registerScaleProvider(overlay)
    kernel.onRoomIdChanged(rid => overlay.setRoomId(rid))

    return {
      getTopology: () => overlay.getSnapshot()
    }
  }

  const plugin = /*@__PURE__*/ definePlugin('scale', {
    setup: () => {
      throw mkErr('scale() must be registered via joinRoom({use: [scale()]})')
    }
  })
  Object.defineProperty(plugin, internalPluginSymbol, {
    value: {
      kind: 'scale' as const,
      setup: setupInternal
    },
    enumerable: false
  })
  return plugin
}
