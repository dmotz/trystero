import type {
  InternalRoomContext,
  KernelScaleProvider,
  PeerHandle,
  ScalePluginSlot,
  Timeout
} from '../internal-types'
import {pluginSlotSymbol} from '../primitives'
import type {RoomPlugin, ScaleConfig, ScalePluginApi} from '../types'
import {
  mkErr,
  noOp,
  peerBannedErr,
  peerDisconnectedErr,
  resetTimer,
  toError,
  unreachable,
  unrefTimer
} from '../utils'
import {createOverlayManager} from './manager'
import {normalizeTopologyConfig} from './topology'

export * from './topology'
export * from './crypto-frame'
export * from './manager'

type MediaPromotionBase = {
  readonly token: symbol
  readonly promise: Promise<PeerHandle>
  readonly resolve: (peer: PeerHandle) => void
  readonly reject: (reason: Error) => void
  readonly timeoutTimer: Timeout
}

type MediaPromotionEntry =
  | (MediaPromotionBase & {
      readonly phase: 'awaiting-ack'
      readonly fallbackDialTimer: Timeout
    })
  | (MediaPromotionBase & {
      readonly phase: 'dialing'
    })

export const scale = (
  config?: ScaleConfig
): RoomPlugin<'scale', ScalePluginApi> => {
  normalizeTopologyConfig(config)

  const setup = (
    kernel: InternalRoomContext
  ): {provider: KernelScaleProvider; api: ScalePluginApi} => {
    const pendingMediaPeers = new Map<string, MediaPromotionEntry>()
    const mediaControlAction = kernel.makeInternalAction<{
      op: 'connect' | 'ack'
    }>('mctrl')

    const takePromotion = (
      id: string,
      token?: symbol
    ): MediaPromotionEntry | undefined => {
      const entry = pendingMediaPeers.get(id)
      if (!entry || (token !== undefined && entry.token !== token)) {
        return undefined
      }
      pendingMediaPeers.delete(id)
      resetTimer(entry.timeoutTimer)
      switch (entry.phase) {
        case 'awaiting-ack':
          resetTimer(entry.fallbackDialTimer)
          break
        case 'dialing':
          break
        default:
          unreachable(entry)
      }
      return entry
    }

    const resolvePromotion = (
      id: string,
      peer: PeerHandle,
      token?: symbol
    ): void => {
      takePromotion(id, token)?.resolve(peer)
    }

    const rejectPromotion = (
      id: string,
      reason: Error,
      token?: symbol
    ): void => {
      takePromotion(id, token)?.reject(reason)
    }

    const rejectAllPromotions = (reason: Error): void => {
      for (const [id, entry] of Array.from(pendingMediaPeers.entries())) {
        rejectPromotion(id, reason, entry.token)
      }
    }

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
      onPeerDescriptorCert: (peerId, _signPubKey, cert, userId) => {
        if (!userId) {
          return
        }
        const knownUid = kernel.getKnownPeerUserId(peerId)
        if (knownUid && knownUid !== userId) {
          return
        }
        kernel.setPeerUserId(peerId, userId)
        kernel.getRolesProvider()?.onPeerDescriptorCert(peerId, userId, cert)
      },
      onError: cause =>
        kernel.emitError({
          code: 'plugin-failed',
          plugin: 'scale',
          message: toError(cause, 'scale plugin failed').message,
          cause
        })
    })

    const transitionPromotionToDialing = (
      id: string,
      expectedToken?: symbol
    ): void => {
      const entry = pendingMediaPeers.get(id)
      if (
        !entry ||
        (expectedToken !== undefined && entry.token !== expectedToken)
      ) {
        return
      }
      switch (entry.phase) {
        case 'awaiting-ack':
          resetTimer(entry.fallbackDialTimer)
          pendingMediaPeers.set(id, {
            phase: 'dialing',
            token: entry.token,
            promise: entry.promise,
            resolve: entry.resolve,
            reject: entry.reject,
            timeoutTimer: entry.timeoutTimer
          })
          break
        case 'dialing':
          break
        default:
          unreachable(entry)
      }
      if (!manager.isDirectPeer(id)) {
        manager.requireDirectPeer(id)
      }
    }

    const prepareMediaPeer = (id: string): Promise<PeerHandle> => {
      const existingDirect = kernel.getPeerHandle(id, false)
      if (existingDirect && manager.isDirectPeer(id)) {
        resolvePromotion(id, existingDirect)
        return Promise.resolve(existingDirect)
      }
      const pending = pendingMediaPeers.get(id)
      if (pending) {
        return pending.promise
      }
      const token = Symbol()
      const {promise, resolve, reject} = Promise.withResolvers<PeerHandle>()
      const timeoutTimer = setTimeout(() => {
        rejectPromotion(id, mkErr('timed out connecting media peer'), token)
      }, 10_000)
      unrefTimer(timeoutTimer)
      const fallbackDialTimer = setTimeout(() => {
        transitionPromotionToDialing(id, token)
      }, 150)
      unrefTimer(fallbackDialTimer)
      pendingMediaPeers.set(id, {
        phase: 'awaiting-ack',
        token,
        promise,
        resolve,
        reject,
        timeoutTimer,
        fallbackDialTimer
      })
      manager.requireDirectPeer(id, {dial: false})
      void mediaControlAction.send({op: 'connect'}, {target: id}).catch(err => {
        const direct = kernel.getPeerHandle(id, false)
        if (direct && manager.isDirectPeer(id)) {
          resolvePromotion(id, direct, token)
          return
        }
        rejectPromotion(id, toError(err, 'failed connecting media peer'), token)
      })
      return promise
    }

    mediaControlAction.onMessage((msg, {peerId: id}) => {
      if (msg?.op === 'connect') {
        if (manager.acceptMediaConnectRequest(id)) {
          void mediaControlAction.send({op: 'ack'}, {target: id}).catch(noOp)
        }
      } else if (msg?.op === 'ack') {
        transitionPromotionToDialing(id)
      }
    })

    kernel.onPeerActivated((id, peer) => {
      resolvePromotion(id, peer)
    })
    kernel.onPeerDeactivated(id => {
      rejectPromotion(id, peerDisconnectedErr)
    })
    kernel.onLeave(() => {
      rejectAllPromotions(peerDisconnectedErr)
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
          rejectPromotion(peerId, reason)
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
      destroy: () => {
        rejectAllPromotions(peerDisconnectedErr)
        manager.destroy()
      },
      getPeerUserId: manager.getPeerUserId,
      setPeerSignPublicKey: manager.setPeerSignPublicKey,
      setLocalRoleCertificate: manager.setLocalRoleCertificate,
      markPeerBanned: peerId => {
        rejectPromotion(peerId, peerBannedErr)
        manager.markPeerBanned(peerId)
      },
      unmarkPeerBanned: manager.unmarkPeerBanned,
      isPeerBanned: manager.isPeerBanned,
      registerActionAuthority: manager.registerActionAuthority
    }

    kernel.onRoomIdChanged(manager.setRoomId)

    return {
      provider,
      api: {
        getTopology: manager.getSnapshot
      }
    }
  }

  const plugin = {name: 'scale'} as RoomPlugin<'scale', ScalePluginApi>
  const slot: ScalePluginSlot = {
    kind: 'scale',
    setup
  }
  Object.defineProperty(plugin, pluginSlotSymbol, {
    value: slot,
    enumerable: false
  })
  return plugin
}
