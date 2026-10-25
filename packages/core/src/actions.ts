import {
  all,
  entries,
  genId,
  libName,
  mkErr,
  noOp,
  resetTimer,
  toError,
  toErrorMessage
} from './utils'
import {
  createActionWireManager,
  makeActionError,
  throwIfAborted,
  type ActionError,
  type ActionErrorKind,
  type ActionOptions,
  type InternalAction,
  type InternalActionSender
} from './action-wire'
import type {
  ActionProgressHandler,
  ActionReceiveHandler,
  DataPayload,
  JsonValue,
  MessageAction,
  MessageActionConfig,
  PeerHandle,
  PeerResult,
  RequestAction,
  RequestActionConfig,
  RequestManyOptions,
  RequestOptions,
  Room,
  SendOptions,
  TargetPeers
} from './types'

export type {
  ActionErrorKind,
  ActionOptions,
  InternalAction,
  InternalActionSender
}

type PublicActionKind = 'message' | 'request'

type PublicActionState = {
  kind: PublicActionKind
  requiredRoles: string[]
  action: MessageAction | RequestAction
  onReceive: ActionReceiveHandler | null
  onReceiveProgress: ActionProgressHandler | null
}

type PendingRequestWaiter = {
  controller: AbortController
  getReceive: () => ActionReceiveHandler | null
  getReceiveProgress: () => ActionProgressHandler | null
  peerId: string
  resolve: (payload: DataPayload) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | null
  signal?: AbortSignal
  abortHandler?: () => void
}

type RequestMetadata = {
  r: string
  m?: JsonValue
}

type ResponseMetadata = {
  r: string
  e?: string
}

type ActionManagerDeps = {
  onPeerError: (peerId: string, error: Error) => void
  maxReceiveBytes?: number
  getPeer: (id: string, includePending: boolean) => PeerHandle | undefined
  getPeerIds: (includePending: boolean) => string[]
  canReceiveFromPeer: (id: string, receiveWhilePending: boolean) => boolean
  broadcastInline?: (
    frame: Uint8Array,
    onProgress?: (peerId: string) => void,
    signal?: AbortSignal
  ) => Promise<boolean> | boolean
  registerActionAuthority?: (namespace: string, roles: string[]) => void
  signActionPayload?: (
    namespace: string,
    requiredRoles: readonly string[],
    data: DataPayload,
    userMetadata?: JsonValue
  ) => Promise<JsonValue>
  verifyActionOffer?: (
    namespace: string,
    peerId: string,
    requiredRoles: readonly string[],
    wireMetadata?: JsonValue
  ) => Promise<{valid: boolean; userMetadata?: JsonValue; roles: string[]}>
  verifyActionPayload?: (
    namespace: string,
    peerId: string,
    requiredRoles: readonly string[],
    data: DataPayload,
    wireMetadata?: JsonValue
  ) => Promise<{valid: boolean; userMetadata?: JsonValue; roles: string[]}>
  getPeerRoles?: (peerId: string) => string[]
  getPeerUserId?: (peerId: string) => string
  resolveSendTarget?: (target?: TargetPeers) => TargetPeers
  resolveRequestTarget?: (target: string) => string | undefined
  onUnauthorizedAction?: (namespace: string, peerId: string) => void
}

const getEnvelopeRecord = (
  metadata?: JsonValue
): {r: string; m?: JsonValue; e?: unknown} | null =>
  metadata &&
  typeof metadata === 'object' &&
  !Array.isArray(metadata) &&
  typeof (metadata as {r?: unknown}).r === 'string'
    ? (metadata as {r: string; m?: JsonValue; e?: unknown})
    : null

const getRequestMetadata = (metadata?: JsonValue): RequestMetadata | null => {
  const record = getEnvelopeRecord(metadata)
  return record
    ? {
        r: record.r,
        ...(Object.hasOwn(record, 'm') ? {m: record.m} : {})
      }
    : null
}

const getResponseMetadata = (metadata?: JsonValue): ResponseMetadata | null => {
  const record = getEnvelopeRecord(metadata)
  return record
    ? {
        r: record.r,
        ...(typeof record.e === 'string' ? {e: record.e} : {})
      }
    : null
}

const withMetadata = <T extends {peerId: string}>(
  context: T,
  metadata?: JsonValue
): T & {metadata?: JsonValue} =>
  metadata === undefined ? context : {...context, metadata}

const unwrapAuthUserMetadata = (
  wireMeta: JsonValue | undefined,
  _hasAuthority?: boolean
): JsonValue | undefined => {
  if (
    wireMeta &&
    typeof wireMeta === 'object' &&
    !Array.isArray(wireMeta) &&
    '__trysteroAuth' in wireMeta
  ) {
    return Object.hasOwn(wireMeta, 'm')
      ? (wireMeta as {m?: JsonValue}).m
      : undefined
  }
  return wireMeta
}

export const createActionManager = ({
  getPeer,
  getPeerIds,
  canReceiveFromPeer,
  onPeerError,
  broadcastInline,
  registerActionAuthority,
  signActionPayload,
  verifyActionOffer,
  verifyActionPayload,
  getPeerRoles,
  getPeerUserId,
  resolveSendTarget,
  resolveRequestTarget,
  onUnauthorizedAction,
  maxReceiveBytes
}: ActionManagerDeps): {
  makeAction: Room['makeAction']
  makeInternalAction: <T extends DataPayload = DataPayload>(
    type: string,
    options?: Partial<ActionOptions>
  ) => InternalAction<T>
  handleData: (id: string, data: ArrayBuffer) => void
  clearPeer: (id: string, error: Error) => void
} => {
  const userIdOf = (peerId: string): string =>
    getPeerUserId ? getPeerUserId(peerId) : peerId
  const publicActions: Record<string, PublicActionState> = Object.create(null)
  const pendingRequestWaiters: Record<string, PendingRequestWaiter> = {}
  const activeRequestControllers = new Map<string, Set<AbortController>>()
  const wire = createActionWireManager({
    getPeer,
    getPeerIds,
    canReceiveFromPeer,
    onPeerError,
    ...(broadcastInline ? {broadcastInline} : {}),
    ...(maxReceiveBytes === undefined ? {} : {maxReceiveBytes})
  })
  const makeWireAction = wire.makeInternalAction
  const makeInternalAction = <T extends DataPayload = DataPayload>(
    type: string,
    options?: Partial<ActionOptions>
  ): InternalAction<T> =>
    makeWireAction(type.startsWith('@_') ? type : `@_${type}`, options)
  const handleData = wire.handleData

  const clearPendingRequestWaiter = (requestId: string): void => {
    const waiter = pendingRequestWaiters[requestId]

    if (!waiter) {
      return
    }

    resetTimer(waiter.timer)

    if (waiter.signal && waiter.abortHandler) {
      waiter.signal.removeEventListener('abort', waiter.abortHandler)
    }

    delete pendingRequestWaiters[requestId]
    waiter.controller.abort()
  }

  const rejectPendingRequestsForPeer = (id: string, error: Error): void => {
    entries(pendingRequestWaiters).forEach(([requestId, waiter]) => {
      if (waiter.peerId !== id) {
        return
      }

      clearPendingRequestWaiter(requestId)
      waiter.reject(error)
    })
  }

  const clearPeer = (id: string, error: Error): void => {
    wire.clearPeer(id)
    const controllers = activeRequestControllers.get(id)
    if (controllers) {
      activeRequestControllers.delete(id)
      controllers.forEach(controller => controller.abort())
    }
    rejectPendingRequestsForPeer(
      id,
      makeActionError(
        'disconnected',
        toErrorMessage(error, 'peer disconnected')
      )
    )
  }

  const responseAction = makeInternalAction<DataPayload>('response', {
    receiveScope: (peerId, metadata) => {
      const parsed = getResponseMetadata(metadata)
      const waiter = parsed && pendingRequestWaiters[parsed.r]
      if (!parsed || !waiter || waiter.peerId !== peerId) {
        return null
      }
      const receive = parsed.e === undefined ? waiter.getReceive() : null
      return {
        key: parsed.r,
        signal: waiter.controller.signal,
        receive: receive
          ? context =>
              receive({
                byteLength: context.byteLength,
                peerId: context.peerId,
                userId: userIdOf(context.peerId),
                kind: 'response',
                signal: context.signal
              })
          : null,
        reject: reason => {
          if (pendingRequestWaiters[parsed.r] === waiter) {
            clearPendingRequestWaiter(parsed.r)
            waiter.reject(makeActionError('rejected', reason))
          }
        }
      }
    }
  })

  responseAction.onProgress((progress, id, metadata) => {
    const parsed = getResponseMetadata(metadata)
    const waiter = parsed && pendingRequestWaiters[parsed.r]

    if (waiter && waiter.peerId === id && parsed?.e === undefined) {
      waiter.getReceiveProgress()?.(progress, {
        peerId: id,
        userId: userIdOf(id)
      })
    }
  })

  responseAction.onMessage((payload, id, metadata) => {
    const parsed = getResponseMetadata(metadata)

    if (!parsed) {
      return
    }

    const waiter = pendingRequestWaiters[parsed.r]

    if (!waiter || waiter.peerId !== id) {
      return
    }

    clearPendingRequestWaiter(parsed.r)

    if (parsed.e !== undefined) {
      waiter.reject(makeActionError('rejected', parsed.e))
      return
    }

    waiter.resolve(payload)
  })

  const makeActionImpl = <
    T extends DataPayload = DataPayload,
    R extends DataPayload = DataPayload
  >(
    type: string,
    config?: MessageActionConfig<T> | RequestActionConfig<T, R>
  ): MessageAction<T> | RequestAction<T, R> => {
    if (config && 'onRequest' in config && config.kind !== 'request') {
      throw mkErr('request actions must use kind: "request"')
    }

    const kind = config?.kind ?? 'message'
    const requiredRoles = config?.roles
      ? (Array.isArray(config.roles) ? config.roles : [config.roles]).filter(
          Boolean
        )
      : []
    const hasAuthority = requiredRoles.length > 0
    if (hasAuthority) {
      registerActionAuthority?.(type, requiredRoles)
    }
    const rawAction = makeWireAction<T>(type)
    const existingState = publicActions[type]

    if (existingState) {
      if (existingState.kind !== kind) {
        throw mkErr(`action type "${type}" cannot be redefined`)
      }
      if (hasAuthority && existingState.requiredRoles.length === 0) {
        existingState.requiredRoles = requiredRoles
        registerActionAuthority?.(type, requiredRoles)
      }

      return existingState.action as MessageAction<T> | RequestAction<T, R>
    }

    const state: PublicActionState = {
      kind,
      requiredRoles,
      action: null as unknown as MessageAction | RequestAction,
      onReceive: config?.onReceive ?? null,
      onReceiveProgress: config?.onReceiveProgress ?? null
    }

    const toProgressHandler = (
      handler?: ActionProgressHandler,
      metadata?: JsonValue
    ) =>
      handler
        ? (progress: number, peerId: string) =>
            handler(
              progress,
              withMetadata({peerId, userId: userIdOf(peerId)}, metadata)
            )
        : undefined

    const dispatchReceiveProgress = (
      progress: number,
      peerId: string,
      metadata?: JsonValue
    ): void => {
      const requestMetadata =
        state.kind === 'request' ? getRequestMetadata(metadata) : null
      const rawUserMeta = requestMetadata ? requestMetadata.m : metadata
      const cleanMeta = unwrapAuthUserMetadata(
        rawUserMeta,
        state.requiredRoles.length > 0
      )

      state.onReceiveProgress?.(
        progress,
        withMetadata({peerId, userId: userIdOf(peerId)}, cleanMeta)
      )
    }

    const setReceive = (handler: ActionReceiveHandler | null): void => {
      state.onReceive = handler
      const hasRoleGuard =
        state.requiredRoles.length > 0 && Boolean(verifyActionOffer)
      if (!handler && !hasRoleGuard) {
        rawAction.onReceive(null)
        return
      }
      if (!hasRoleGuard && handler) {
        rawAction.onReceive(context => {
          const requestMetadata =
            kind === 'request' ? getRequestMetadata(context.metadata) : null
          const rawUserMeta = requestMetadata
            ? requestMetadata.m
            : context.metadata
          const cleanMeta = unwrapAuthUserMetadata(rawUserMeta, false)
          const roles = getPeerRoles?.(context.peerId)
          return handler(
            withMetadata(
              {
                byteLength: context.byteLength,
                peerId: context.peerId,
                userId: userIdOf(context.peerId),
                signal: context.signal,
                kind,
                ...(roles && roles.length > 0 ? {roles} : {})
              },
              cleanMeta
            )
          )
        })
        return
      }
      rawAction.onReceive(async context => {
        const requestMetadata =
          kind === 'request' ? getRequestMetadata(context.metadata) : null
        const rawUserMeta = requestMetadata
          ? requestMetadata.m
          : context.metadata
        const offerRes = await verifyActionOffer!(
          type,
          context.peerId,
          state.requiredRoles,
          rawUserMeta
        )
        if (!offerRes.valid) {
          onUnauthorizedAction?.(type, context.peerId)
          return false
        }
        if (!handler) {
          return true
        }
        return handler(
          withMetadata(
            {
              byteLength: context.byteLength,
              peerId: context.peerId,
              userId: userIdOf(context.peerId),
              signal: context.signal,
              kind,
              ...(offerRes.roles.length > 0 ? {roles: offerRes.roles} : {})
            },
            offerRes.userMetadata
          )
        )
      })
    }
    setReceive(state.onReceive)

    rawAction.onProgress(dispatchReceiveProgress)

    if (kind === 'message') {
      let onMessage =
        (config as MessageActionConfig<T> | undefined)?.onMessage ?? null

      const receiveMessage = (
        payload: DataPayload,
        peerId: string,
        metadata?: JsonValue
      ): void => {
        void Promise.resolve()
          .then(async () => {
            let effectiveMetadata = metadata
            let roles = getPeerRoles?.(peerId)
            if (state.requiredRoles.length > 0 && verifyActionPayload) {
              const verified = await verifyActionPayload(
                type,
                peerId,
                state.requiredRoles,
                payload,
                metadata
              )
              if (!verified.valid) {
                onUnauthorizedAction?.(type, peerId)
                return
              }
              effectiveMetadata = verified.userMetadata
              roles = verified.roles
            }

            const handler = onMessage
            if (!handler) {
              return
            }
            const ctx = withMetadata(
              {peerId, userId: userIdOf(peerId)},
              effectiveMetadata
            )
            if (roles && roles.length > 0) {
              ;(ctx as {roles?: string[]}).roles = roles
            }
            await handler(payload as T, ctx)
          })
          .catch(err => console.error(`${libName} action handler error:`, err))
      }

      const action = {
        send: async (data: T, options: SendOptions = {}) => {
          const wireMetadata =
            state.requiredRoles.length > 0 && signActionPayload
              ? await signActionPayload(
                  type,
                  state.requiredRoles,
                  data,
                  options.metadata
                )
              : options.metadata
          const resolvedTarget = resolveSendTarget
            ? resolveSendTarget(options.target)
            : options.target
          await rawAction.send(
            data,
            resolvedTarget,
            wireMetadata,
            toProgressHandler(options.onProgress, options.metadata),
            options.signal
          )
        },

        get onMessage() {
          return onMessage
        },

        set onMessage(handler) {
          onMessage = handler
          rawAction.onMessage(handler ? receiveMessage : null)
        },

        get onReceive() {
          return state.onReceive
        },
        set onReceive(handler) {
          setReceive(handler)
        },

        get onReceiveProgress() {
          return state.onReceiveProgress
        },

        set onReceiveProgress(handler) {
          state.onReceiveProgress = handler
        }
      } satisfies MessageAction<T>

      state.action = action as MessageAction
      publicActions[type] = state
      rawAction.onMessage(onMessage ? receiveMessage : null)

      return action
    }

    rawAction.onReject((peerId, metadata, reason) => {
      const parsed = getRequestMetadata(metadata)
      if (parsed) {
        void responseAction
          .send(null, peerId, {r: parsed.r, e: reason})
          .catch(noOp)
      }
    })

    let onRequest =
      (config as RequestActionConfig<T, R> | undefined)?.onRequest ?? null

    const receiveRequest = (
      payload: DataPayload,
      peerId: string,
      metadata?: JsonValue
    ): void => {
      const parsed = getRequestMetadata(metadata)
      if (!parsed) {
        return
      }
      const handler = onRequest!
      const controller = new AbortController()
      let peerControllers = activeRequestControllers.get(peerId)
      if (!peerControllers) {
        peerControllers = new Set()
        activeRequestControllers.set(peerId, peerControllers)
      }
      peerControllers.add(controller)
      void Promise.resolve()
        .then(async () => {
          let userMeta = parsed.m
          let roles = getPeerRoles?.(peerId)
          if (state.requiredRoles.length > 0 && verifyActionPayload) {
            const verified = await verifyActionPayload(
              type,
              peerId,
              state.requiredRoles,
              payload,
              parsed.m
            )
            if (!verified.valid) {
              onUnauthorizedAction?.(type, peerId)
              throw mkErr('insufficient authority for request')
            }
            userMeta = verified.userMetadata
            roles = verified.roles
          }
          const ctx = {
            ...withMetadata({peerId, userId: userIdOf(peerId)}, userMeta),
            signal: controller.signal,
            ...(roles && roles.length > 0 ? {roles} : {})
          }
          const response = await handler(payload as T, ctx)
          if (response === undefined) {
            throw mkErr('request handler returned undefined')
          }
          return response
        })
        .then(
          response => responseAction.send(response, peerId, {r: parsed.r}),
          error =>
            responseAction.send(null, peerId, {
              r: parsed.r,
              e: toErrorMessage(error, 'request failed').slice(0, 512)
            })
        )
        .catch(noOp)
        .finally(() => {
          const controllers = activeRequestControllers.get(peerId)
          controllers?.delete(controller)
          if (controllers && !controllers.size) {
            activeRequestControllers.delete(peerId)
          }
          controller.abort()
        })
    }

    const requestOne = async (data: T, options: RequestOptions): Promise<R> => {
      const {target, metadata, onProgress, signal, timeoutMs} = options

      throwIfAborted(signal)

      const resolvedTarget = resolveRequestTarget
        ? (resolveRequestTarget(target) ?? target)
        : target

      if (!getPeer(resolvedTarget, false)) {
        throw makeActionError(
          'disconnected',
          `no active peer with id ${target}`
        )
      }

      const innerMeta =
        state.requiredRoles.length > 0 && signActionPayload
          ? await signActionPayload(type, state.requiredRoles, data, metadata)
          : metadata

      const requestId = genId(20)
      const controller = new AbortController()
      const responsePromise = new Promise<DataPayload>((resolve, reject) => {
        const waiter: PendingRequestWaiter = {
          controller,
          getReceive: () => state.onReceive,
          getReceiveProgress: () => state.onReceiveProgress,
          peerId: resolvedTarget,
          resolve,
          reject,
          timer: null,
          ...(signal === undefined ? {} : {signal})
        }

        const rejectAsAborted = (): void => {
          clearPendingRequestWaiter(requestId)
          reject(makeActionError('aborted', 'operation aborted'))
        }

        if (signal) {
          waiter.abortHandler = rejectAsAborted
          signal.addEventListener('abort', rejectAsAborted, {once: true})
        }

        pendingRequestWaiters[requestId] = waiter
        if (timeoutMs !== undefined) {
          waiter.timer = setTimeout(() => {
            clearPendingRequestWaiter(requestId)
            waiter.reject(makeActionError('timeout', 'request timed out'))
          }, timeoutMs)
        }
      })
      try {
        const sending = rawAction.send(
          data,
          resolvedTarget,
          innerMeta === undefined
            ? {r: requestId}
            : {r: requestId, m: innerMeta},
          toProgressHandler(onProgress, metadata),
          controller.signal
        )
        return (await Promise.race([
          responsePromise,
          sending.then(() => responsePromise)
        ])) as R
      } finally {
        clearPendingRequestWaiter(requestId)
      }
    }

    const action = {
      request: requestOne,

      requestMany: async (data: T, options: RequestManyOptions<R>) => {
        const {targets, onResult, ...requestOptions} = options
        throwIfAborted(requestOptions.signal)

        const results = await all(
          targets.map(async target => {
            const resolvedTarget =
              (resolveRequestTarget ? resolveRequestTarget(target) : target) ??
              target
            const targetUserId = userIdOf(resolvedTarget) || target
            try {
              const value = await requestOne(data, {
                ...requestOptions,
                target
              })
              const result = {
                peerId: resolvedTarget,
                userId: targetUserId,
                status: 'fulfilled',
                value
              } satisfies PeerResult<R>
              onResult?.(result)
              return result
            } catch (err) {
              const error = toError(err, 'request failed') as ActionError

              if (error.kind === 'aborted' || !error.kind) {
                throw error
              }

              const result =
                error.kind === 'timeout'
                  ? ({
                      peerId: resolvedTarget,
                      userId: targetUserId,
                      status: 'timeout'
                    } as PeerResult<R>)
                  : error.kind === 'disconnected'
                    ? ({
                        peerId: resolvedTarget,
                        userId: targetUserId,
                        status: 'disconnected'
                      } as PeerResult<R>)
                    : ({
                        peerId: resolvedTarget,
                        userId: targetUserId,
                        status: 'rejected',
                        error
                      } as PeerResult<R>)

              onResult?.(result)
              return result
            }
          })
        )

        return results
      },

      get onRequest() {
        return onRequest
      },

      set onRequest(handler) {
        onRequest = handler
        rawAction.onMessage(handler ? receiveRequest : null)
      },

      get onReceive() {
        return state.onReceive
      },
      set onReceive(handler) {
        setReceive(handler)
      },

      get onReceiveProgress() {
        return state.onReceiveProgress
      },

      set onReceiveProgress(handler) {
        state.onReceiveProgress = handler
      }
    } satisfies RequestAction<T, R>

    state.action = action as unknown as RequestAction
    publicActions[type] = state
    rawAction.onMessage(onRequest ? receiveRequest : null)

    return action
  }

  return {
    makeAction: makeActionImpl as Room['makeAction'],
    makeInternalAction,
    handleData,
    clearPeer
  }
}
