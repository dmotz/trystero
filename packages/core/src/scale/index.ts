import type {InternalRoomContext, KernelScaleProvider} from '../internal-types'
import {makeInternalPlugin} from '../plugin'
import type {
  PeerHandle,
  RoomPlugin,
  ScaleConfig,
  ScalePluginApi
} from '../types'
import {mkErr, noOp, peerDisconnectedErr, toError, unrefTimer} from '../utils'
import {createOverlayManager} from './manager'
import {normalizeTopologyConfig} from './topology'

export * from './topology'
export * from './crypto-frame'
export * from './manager'

export const scale = (
  config?: ScaleConfig
): RoomPlugin<'scale', ScalePluginApi> => {
  normalizeTopologyConfig(config)

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

    const manager = createOverlayManager({
      selfId: kernel.selfId,
      appId: kernel.appId,
      roomId: kernel.getRoomId(),
      password: kernel.password,
      ...(config ? {config} : {}),
      ...(kernel.maxUsers !== undefined ? {maxUsers: kernel.maxUsers} : {}),
      getLocalEndpointIdentity: kernel.getLocalEndpointIdentity,
      getLocalUserIdentity: kernel.getLocalUserIdentity,
      onVirtualPeerJoin: kernel.activateVirtualPeer,
      onVirtualPeerLeave: kernel.deactivateVirtualPeer,
      onDeliverData: kernel.deliverRawData,
      authorizePeerAction: (peerId, requiredRoles, inlineCert) =>
        kernel
          .getRolesProvider()
          ?.authorizePeerAction(peerId, requiredRoles, inlineCert) ?? true,
      onPeerDescriptorCert: (peerId, signPubKey, cert, userId) => {
        if (userId) {
          kernel.setPeerUserId(peerId, userId)
        }
        kernel.setPeerPublicKey(peerId, signPubKey)
        if (userId) {
          kernel.getRolesProvider()?.onPeerDescriptorCert(peerId, userId, cert)
        }
      },
      onError: cause =>
        kernel.emitError({
          code: 'plugin-failed',
          plugin: 'scale',
          message: toError(cause, 'scale plugin failed').message,
          cause
        })
    })

    const prepareMediaPeer = (id: string): Promise<PeerHandle> => {
      const existingDirect = kernel.getPeerHandle(id, false)
      if (existingDirect && manager.isDirectPeer(id)) {
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
        if (pendingMediaPeers.has(id) && !manager.isDirectPeer(id)) {
          manager.requireDirectPeer(id)
        }
      }, 150)
      unrefTimer(fallbackDialTimer)
      const settled = promise.finally(() => {
        clearTimeout(timer)
        clearTimeout(fallbackDialTimer)
        pendingMediaPeers.delete(id)
      })
      pendingMediaPeers.set(id, [settled, resolve, reject])
      manager.requireDirectPeer(id, {dial: false})
      void mediaControlAction
        .send({op: 'connect'}, {target: id})
        .catch(err => reject(toError(err, 'failed connecting media peer')))
      return settled
    }

    mediaControlAction.onMessage((msg, {peerId: id}) => {
      if (msg?.op === 'connect') {
        if (manager.acceptMediaConnectRequest(id)) {
          void mediaControlAction.send({op: 'ack'}, {target: id}).catch(noOp)
        }
      } else if (msg?.op === 'ack' && pendingMediaPeers.has(id)) {
        manager.requireDirectPeer(id)
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

    const provider: KernelScaleProvider = {
      isDirectPeer: manager.isDirectPeer,
      isVirtualPeer: manager.isVirtualPeer,
      getRoute: manager.getRoute,
      getSnapshot: manager.getSnapshot,
      handleFrame: manager.handleFrame,
      addDirectPeer: manager.addDirectPeer,
      removeDirectPeer: (peerId, peer, reason) => {
        if (reason) {
          pendingMediaPeers.get(peerId)?.[2](reason)
        }
        manager.removeDirectPeer(peerId, peer, reason)
      },
      prepareMediaPeer,
      setPeerMediaPinned: manager.setPeerMediaPinned,
      broadcastInline: (frame, onProgress, signal) =>
        manager.canBroadcastDirectMesh()
          ? false
          : manager.broadcastInline(frame, onProgress, signal),
      requireDirectPeer: id => manager.requireDirectPeer(id),
      notePeerDiscovered: manager.notePeerDiscovered,
      shouldConnectPeer: manager.shouldConnectPeer,
      getTargetNeighbors: manager.getTargetNeighbors,
      setOnTargetsChanged: manager.setOnTargetsChanged,
      announceLeave: manager.announceLeave,
      destroy: manager.destroy,
      setPeerSignPublicKey: manager.setPeerSignPublicKey,
      setLocalRoleCertificate: manager.setLocalRoleCertificate,
      markPeerBanned: manager.markPeerBanned,
      unmarkPeerBanned: manager.unmarkPeerBanned,
      isPeerBanned: manager.isPeerBanned,
      registerActionAuthority: manager.registerActionAuthority
    }

    kernel.registerScaleProvider(provider)
    kernel.onRoomIdChanged(manager.setRoomId)

    return {
      getTopology: manager.getSnapshot
    }
  }

  return makeInternalPlugin('scale', setupInternal)
}
