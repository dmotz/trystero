import {type EndpointIdentity, isEphemeralIdentityConfig} from './identity'
import type {
  InternalRoomContext,
  KernelRolesProvider,
  KernelScaleProvider
} from './internal-types'
import {internalPluginSymbol} from './primitives'
import type {
  KernelRoomErrorInput,
  PluginContext,
  Room,
  RoomPlugin,
  UserIdentity,
  UserIdentityConfig
} from './types'
import {
  entries,
  getConfiguredPlugins,
  isSelfAsAdminPlugin,
  keys,
  mkErr,
  noOp,
  peerBannedErr,
  peerBannedMsg,
  reservedRoomPropertyNames,
  selfCertifyingRoomRegex,
  selfCertRoomRolesErr,
  toErrorMessage,
  warnEphemeralAdmin
} from './utils'

const unloadEvent = 'beforeunload'
const beforeUnloadRoomCleanups = /*@__PURE__*/ new Set<() => void>()

const cleanupActiveRoomsOnBeforeUnload = (): void =>
  beforeUnloadRoomCleanups.forEach(cleanup => cleanup())

export const registerBeforeUnloadCleanup = (
  cleanup: () => void
): (() => void) => {
  beforeUnloadRoomCleanups.add(cleanup)

  if (beforeUnloadRoomCleanups.size === 1) {
    addEventListener(unloadEvent, cleanupActiveRoomsOnBeforeUnload)
  }

  return (): void => {
    beforeUnloadRoomCleanups.delete(cleanup)

    if (!beforeUnloadRoomCleanups.size) {
      removeEventListener(unloadEvent, cleanupActiveRoomsOnBeforeUnload)
    }
  }
}

export type InternalPluginMeta = {
  kind: 'roles' | 'scale' | 'internal'
  selfAsAdmin?: boolean
  setup: (
    kernel: InternalRoomContext,
    preResolvedState?: unknown,
    getPreResolvedState?: () => unknown
  ) => Record<string, unknown> | void
}

export const getInternalPluginMeta = (
  plugin: RoomPlugin<string, any>
): InternalPluginMeta | undefined =>
  (
    plugin as RoomPlugin<string, any> & {
      [internalPluginSymbol]?: InternalPluginMeta
    }
  )[internalPluginSymbol]

export const isBanError = (err?: Error | string): boolean => {
  if (!err) {
    return false
  }
  if (err === peerBannedErr || err === peerBannedMsg) {
    return true
  }
  const msg = typeof err === 'string' ? err : err.message
  return (
    msg === peerBannedMsg ||
    msg === peerBannedErr.message ||
    msg.includes(peerBannedMsg)
  )
}

export const openAuthPolicy: KernelRolesProvider = {
  getEffectiveRoomId: () => '',
  getPeerRoles: () => [],
  isPeerBanned: () => false,
  registerPeerPublicKey: noOp,
  canPeerSendAction: () => true,
  onPeerDescriptorCert: noOp,
  signActionPayload: async (_ns, _roles, _data, userMetadata) =>
    userMetadata ?? null,
  verifyActionOffer: async (_ns, _peerId, _roles, wireMetadata) => ({
    valid: true,
    ...(wireMetadata === undefined ? {} : {userMetadata: wireMetadata}),
    roles: []
  }),
  verifyActionPayload: async (_ns, _peerId, _roles, _data, wireMetadata) => ({
    valid: true,
    ...(wireMetadata === undefined ? {} : {userMetadata: wireMetadata}),
    roles: []
  }),
  getAuthorityInfo: async () => ({
    userId: '',
    roomId: '',
    baseRoomId: '',
    isAdmin: false,
    roles: []
  })
}

export const directMeshPolicy: KernelScaleProvider = {
  getActiveMode: () => 'mesh',
  isDirectPeer: () => false,
  isVirtualPeer: () => false,
  getRoute: () => undefined,
  getSnapshot: () => ({
    mode: 'auto',
    activeMode: 'mesh',
    selfId: '',
    directPeerIds: [],
    roomPeerIds: [],
    routes: {},
    stats: {
      messagesSent: 0,
      messagesReceived: 0,
      messagesForwarded: 0,
      duplicatesDropped: 0,
      signatureFailures: 0
    }
  }),
  handleFrame: () => false,
  addDirectPeer: noOp,
  removeDirectPeer: noOp,
  broadcastInline: () => Promise.resolve(false),
  requireDirectPeer: noOp,
  notePeerDiscovered: () => true,
  shouldConnectPeer: () => true,
  getTargetNeighbors: () => new Set(),
  setOnTargetsChanged: noOp,
  announceLeave: noOp,
  destroy: noOp,
  setPeerSignPublicKey: noOp,
  setLocalRoleCertificate: noOp,
  markPeerBanned: noOp,
  isPeerBanned: () => false,
  registerActionAuthority: noOp,
  recordSignatureFailure: noOp
}

export const validateAndPreparePlugins = (
  use: readonly RoomPlugin<string, any>[] | undefined,
  initialRoomId: string,
  identity: UserIdentityConfig | undefined,
  skipEphemeralWarn = false
): {
  plugins: RoomPlugin<string, any>[]
  resolveOrderPlugins: RoomPlugin<string, any>[]
  hasRolesPlugin: boolean
} => {
  const plugins = getConfiguredPlugins(use)
  const resolveOrderPlugins = use ? [...use] : []
  const hasRolesPlugin = plugins.some(
    p => getInternalPluginMeta(p)?.kind === 'roles' || p.name === 'roles'
  )
  if (!hasRolesPlugin && selfCertifyingRoomRegex.test(initialRoomId)) {
    throw selfCertRoomRolesErr
  }
  if (
    !skipEphemeralWarn &&
    plugins.some(
      p =>
        Boolean(getInternalPluginMeta(p)?.selfAsAdmin) || isSelfAsAdminPlugin(p)
    ) &&
    isEphemeralIdentityConfig(identity)
  ) {
    warnEphemeralAdmin()
  }
  return {plugins, resolveOrderPlugins, hasRolesPlugin}
}

export const resolvePluginRoomIds = (
  plugins: readonly RoomPlugin<string, any>[],
  appId: string,
  initialRoomId: string,
  userIdentityP: Promise<UserIdentity>,
  onPluginError?: (pluginName: string, err: unknown) => void
): {
  preResolvedPlugins: Map<RoomPlugin, unknown>
  effectiveRoomIdP: Promise<string> | undefined
} => {
  const preResolvedPlugins = new Map<RoomPlugin, unknown>()
  let chain: Promise<string> | undefined

  for (const plugin of plugins) {
    const resolveFn = plugin.resolveRoomId
    if (!resolveFn) {
      continue
    }
    const pluginName = plugin.name
    const prevP = chain
    const step = async (): Promise<string> => {
      const currentRoomId = prevP ? await prevP : initialRoomId
      const res = await resolveFn({
        appId,
        roomId: currentRoomId,
        userIdentityP
      })
      if (!res) {
        return currentRoomId
      }
      preResolvedPlugins.set(plugin, res.state)
      return res.effectiveRoomId
    }
    chain = step().catch(err => {
      onPluginError?.(pluginName, err)
      throw err
    })
  }

  void chain?.catch(noOp)
  return {preResolvedPlugins, effectiveRoomIdP: chain}
}

export type SetupRoomPluginsInit = {
  plugins: readonly RoomPlugin<string, any>[]
  preResolvedPlugins?: Map<RoomPlugin, unknown> | undefined
  initialRoomId: string
  hasImmediateSelfId: boolean
  localEndpointP: Promise<EndpointIdentity>
  effectiveRoomIdP?: Promise<string> | undefined
  isLeaving: () => boolean
  setEffectiveRoomId: (roomId: string) => void
  onSelfLeave: () => void
  emitRoomError: (error: KernelRoomErrorInput) => void
  publicKernel: PluginContext
  internalKernel: InternalRoomContext
  hasRolesProvider: () => boolean
  getRoomInstance: () => Room | null
}

export const setupRoomPlugins = ({
  plugins,
  preResolvedPlugins,
  initialRoomId,
  hasImmediateSelfId,
  localEndpointP,
  effectiveRoomIdP,
  isLeaving,
  setEffectiveRoomId,
  onSelfLeave,
  emitRoomError,
  publicKernel,
  internalKernel,
  hasRolesProvider,
  getRoomInstance
}: SetupRoomPluginsInit): {
  pluginApis: Record<string, unknown>
  pluginSetupP: Promise<void>
  roomReadyP: Promise<void>
  getPluginSetupError: () => unknown
} => {
  const pluginApis: Record<string, unknown> = {}
  let didRunPluginSetup = false
  let pluginSetupError: unknown = null
  let failedPluginName: string | undefined

  const runPluginSetup = (): void => {
    if (didRunPluginSetup) {
      if (pluginSetupError) {
        throw pluginSetupError
      }
      return
    }
    didRunPluginSetup = true
    let activePluginName: string | undefined
    try {
      const seenPluginApiKeys = new Set<string>()
      for (const plugin of plugins) {
        activePluginName = plugin.name
        const preState = preResolvedPlugins?.get(plugin)
        const internalMeta = getInternalPluginMeta(plugin)
        const api = internalMeta
          ? internalMeta.setup(internalKernel, preState, () =>
              preResolvedPlugins?.get(plugin)
            )
          : plugin.setup(publicKernel, preState)
        if (api && typeof api === 'object') {
          for (const key of keys(api)) {
            const propErr = (msg: string): Error =>
              mkErr(`plugin "${plugin.name}" ${msg} room property "${key}"`)
            if (reservedRoomPropertyNames.has(key)) {
              throw propErr('cannot override reserved')
            }
            if (seenPluginApiKeys.has(key)) {
              throw propErr('defines duplicate')
            }
            seenPluginApiKeys.add(key)
          }
          Object.assign(pluginApis, api)
        }
      }
      activePluginName = undefined
      if (!hasRolesProvider() && selfCertifyingRoomRegex.test(initialRoomId)) {
        throw selfCertRoomRolesErr
      }
      const roomInstance = getRoomInstance()
      if (roomInstance) {
        for (const [k, v] of entries(pluginApis)) {
          if (!reservedRoomPropertyNames.has(k)) {
            ;(roomInstance as Record<string, unknown>)[k] = v
          }
        }
      }
    } catch (err) {
      failedPluginName = activePluginName
      pluginSetupError = err
      throw err
    }
  }

  let pluginSetupP: Promise<void>
  if (hasImmediateSelfId) {
    runPluginSetup()
    pluginSetupP = Promise.resolve()
  } else {
    const preSetupP = effectiveRoomIdP
      ? Promise.all([localEndpointP, effectiveRoomIdP]).then(
          ([, rid]) => {
            if (!isLeaving()) {
              setEffectiveRoomId(rid)
            }
          },
          err => {
            onSelfLeave()
            throw err
          }
        )
      : localEndpointP.then(() => {})
    pluginSetupP = preSetupP.then(() => {
      try {
        runPluginSetup()
      } catch (err) {
        emitRoomError({
          code: 'plugin-failed',
          ...(failedPluginName !== undefined ? {plugin: failedPluginName} : {}),
          message: toErrorMessage(err, 'plugin setup failed'),
          cause: err
        })
        onSelfLeave()
        throw err
      }
    })
    void pluginSetupP.catch(noOp)
  }

  const roomReadyP =
    hasImmediateSelfId && effectiveRoomIdP
      ? Promise.all([pluginSetupP, effectiveRoomIdP]).then(() => {})
      : pluginSetupP
  void roomReadyP.catch(noOp)

  return {
    pluginApis,
    pluginSetupP,
    roomReadyP,
    getPluginSetupError: () => pluginSetupError
  }
}
