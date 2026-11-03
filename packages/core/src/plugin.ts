import type {InternalRoomContext} from './internal-types'
import {internalPluginSymbol, mkErr} from './primitives'
import type {AnyRoomPlugin, RoomPlugin, UserIdentity} from './types'

type InternalPluginResolveContext = {
  appId: string
  roomId: string
  userIdentityP: Promise<UserIdentity>
}

export type InternalPluginDescriptor<
  TKind extends 'roles' | 'scale' = 'roles' | 'scale',
  TApi extends Record<string, unknown> = Record<string, unknown>,
  TState = unknown
> = {
  kind: TKind
  selfAsAdmin: boolean
  resolveRoomId?:
    | ((
        context: InternalPluginResolveContext
      ) => Promise<{effectiveRoomId: string; state?: TState}> | undefined)
    | undefined
  setup: (
    context: InternalRoomContext,
    getPre?: () => TState | undefined
  ) => TApi
}

export type ConfiguredInternalPlugin = AnyRoomPlugin & {
  readonly [internalPluginSymbol]: InternalPluginDescriptor
}

const getInternalPluginDescriptor = (
  plugin: unknown
): InternalPluginDescriptor | undefined =>
  plugin && typeof plugin === 'object'
    ? (plugin as Record<symbol, InternalPluginDescriptor | undefined>)[
        internalPluginSymbol
      ]
    : undefined

export const getConfiguredPlugins = (
  use?: readonly AnyRoomPlugin[]
): ConfiguredInternalPlugin[] => {
  if (use === undefined) {
    return []
  }
  if (!Array.isArray(use)) {
    throw mkErr('use must be an array of room plugins')
  }
  const byName = new Map<string, ConfiguredInternalPlugin>()
  for (const item of use) {
    const desc = getInternalPluginDescriptor(item)
    if (
      !item ||
      typeof item !== 'object' ||
      typeof item.name !== 'string' ||
      !item.name ||
      !desc
    ) {
      throw mkErr('invalid plugin in use[]; expected roles() or scale()')
    }
    if (byName.has(item.name)) {
      throw mkErr(`duplicate plugin "${item.name}" in use[]`)
    }
    byName.set(item.name, item as ConfiguredInternalPlugin)
  }
  const ordered: ConfiguredInternalPlugin[] = []
  const rolesPlugin = byName.get('roles')
  if (rolesPlugin) {
    ordered.push(rolesPlugin)
  }
  const scalePlugin = byName.get('scale')
  if (scalePlugin) {
    ordered.push(scalePlugin)
  }
  return ordered
}

export const makeInternalPlugin = <
  TKind extends 'roles' | 'scale',
  TApi extends Record<string, unknown>,
  TState = unknown
>(
  name: TKind,
  setup: (
    context: InternalRoomContext,
    getPre?: () => TState | undefined
  ) => TApi,
  options?: {
    selfAsAdmin?: boolean
    resolveRoomId?: InternalPluginDescriptor<
      TKind,
      TApi,
      TState
    >['resolveRoomId']
  }
): RoomPlugin<TKind, TApi> => {
  const plugin = {name} as RoomPlugin<TKind, TApi>
  const descriptor: InternalPluginDescriptor<TKind, TApi, TState> = {
    kind: name,
    selfAsAdmin: Boolean(options?.selfAsAdmin),
    ...(options?.resolveRoomId ? {resolveRoomId: options.resolveRoomId} : {}),
    setup
  }
  Object.defineProperty(plugin, internalPluginSymbol, {
    value: descriptor,
    enumerable: false
  })
  return plugin
}
