import {
  actionRedefinedErr,
  all,
  authMetaKey,
  createEventEmitter,
  createSingleHandler,
  entries,
  insufficientAuthPrefix,
  internalActionPrefix,
  lockMethods,
  logActionHandlerErr,
  mkErr,
  noActivePeerMsg,
  noOp,
  operationAbortedMsg,
  peerDisconnectedMsg,
  resetTimer,
  toError,
  toErrorMessage,
  values
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
  ActionMessageHandler,
  ActionProgressContext,
  ActionProgressHandler,
  ActionReceiveHandler,
  ActionRequestHandler,
  DataPayload,
  JsonValue,
  MessageAction,
  MessageActionConfig,
  MessageContext,
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
  action: unknown
  syncReceive: () => void
  clear: () => void
}

type PendingRequestWaiter = {
  controller: AbortController
  getReceive: () => ActionReceiveHandler | null
  emitReceiveProgress: (
    progress: number,
    context: ActionProgressContext
  ) => void
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

const requestFailedMsg = 'request failed'

const unwrapAuthUserMetadata = (
  wireMeta: JsonValue | undefined,
  _hasAuthority?: boolean
): JsonValue | undefined => {
  if (
    wireMeta &&
    typeof wireMeta === 'object' &&
    !Array.isArray(wireMeta) &&
    authMetaKey in wireMeta
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
  clearListeners: () => void
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
    makeWireAction(
      type.startsWith(internalActionPrefix)
        ? type
        : `${internalActionPrefix}${type}`,
      options
    )
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
        toErrorMessage(error, peerDisconnectedMsg)
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
      waiter.emitReceiveProgress(progress, {
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
    config?: MessageActionConfig | RequestActionConfig
  ): MessageAction<T> | RequestAction<T, R> => {
    if (
      config &&
      ('onMessage' in config ||
        'onRequest' in config ||
        'onReceive' in config ||
        'onReceiveProgress' in config)
    ) {
      throw mkErr(
        'makeAction config does not accept event handlers; subscribe via action.on*(fn)'
      )
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
        throw actionRedefinedErr(type)
      }
      if (hasAuthority && existingState.requiredRoles.length === 0) {
        existingState.requiredRoles = requiredRoles
        registerActionAuthority?.(type, requiredRoles)
        existingState.syncReceive()
      }

      return existingState.action as MessageAction<T> | RequestAction<T, R>
    }

    const progressEmitter =
      createEventEmitter<[number, ActionProgressContext]>('progress handler')

    const state: PublicActionState = {
      kind,
      requiredRoles,
      action: null,
      syncReceive: noOp,
      clear: noOp
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
      if (!progressEmitter.hasListeners()) {
        return
      }
      const requestMetadata =
        state.kind === 'request' ? getRequestMetadata(metadata) : null
      const rawUserMeta = requestMetadata ? requestMetadata.m : metadata
      const cleanMeta = unwrapAuthUserMetadata(
        rawUserMeta,
        state.requiredRoles.length > 0
      )

      progressEmitter.emit(
        progress,
        withMetadata({peerId, userId: userIdOf(peerId)}, cleanMeta)
      )
    }

    const setReceive = (handler: ActionReceiveHandler | null): void => {
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

    const receiveSlot = createSingleHandler<ActionReceiveHandler>(
      'onReceive',
      handler => setReceive(handler)
    )
    state.syncReceive = () => setReceive(receiveSlot.get())
    state.syncReceive()

    rawAction.onProgress(dispatchReceiveProgress)

    if (kind === 'message') {
      const receiveMessage = (
        payload: DataPayload,
        peerId: string,
        metadata?: JsonValue
      ): void => {
        if (state.requiredRoles.length === 0 || !verifyActionPayload) {
          const roles = getPeerRoles?.(peerId)
          const ctx: MessageContext = withMetadata(
            {peerId, userId: userIdOf(peerId)},
            metadata
          )
          if (roles && roles.length > 0) {
            ctx.roles = roles
          }
          messageEmitter.emit(payload as T, ctx)
          return
        }

        void verifyActionPayload(
          type,
          peerId,
          state.requiredRoles,
          payload,
          metadata
        )
          .then(verified => {
            if (!verified.valid) {
              onUnauthorizedAction?.(type, peerId)
              return
            }
            if (!messageEmitter.hasListeners()) {
              return
            }
            const ctx: MessageContext = withMetadata(
              {peerId, userId: userIdOf(peerId)},
              verified.userMetadata
            )
            if (verified.roles.length > 0) {
              ctx.roles = verified.roles
            }
            messageEmitter.emit(payload as T, ctx)
          })
          .catch(logActionHandlerErr)
      }

      const messageEmitter = createEventEmitter<[T, MessageContext]>(
        'action handler',
        active => rawAction.onMessage(active ? receiveMessage : null)
      )

      const action = lockMethods(
        {
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

          onMessage: (handler: ActionMessageHandler<T>, options) =>
            messageEmitter.subscribe(handler, options),

          onReceive: (handler, options) => receiveSlot.set(handler, options),

          onReceiveProgress: (handler, options) =>
            progressEmitter.subscribe(handler, options)
        } satisfies MessageAction<T>,
        ['onMessage', 'onReceive', 'onReceiveProgress']
      )

      state.action = action
      state.clear = () => {
        messageEmitter.clear()
        receiveSlot.clear()
        progressEmitter.clear()
      }
      publicActions[type] = state

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

    const receiveRequest = (
      payload: DataPayload,
      peerId: string,
      metadata?: JsonValue
    ): void => {
      const parsed = getRequestMetadata(metadata)
      if (!parsed) {
        return
      }
      const controller = new AbortController()
      let peerControllers = activeRequestControllers.get(peerId)
      if (!peerControllers) {
        peerControllers = new Set()
        activeRequestControllers.set(peerId, peerControllers)
      }
      peerControllers.add(controller)

      const runHandler = async (): Promise<R> => {
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
            throw mkErr(`${insufficientAuthPrefix} for request`)
          }
          const handler = requestSlot.get()
          if (!handler) {
            throw mkErr('no active request handler')
          }
          const ctx = {
            ...withMetadata(
              {peerId, userId: userIdOf(peerId)},
              verified.userMetadata
            ),
            signal: controller.signal,
            ...(verified.roles.length > 0 ? {roles: verified.roles} : {})
          }
          const response = await handler(payload as T, ctx)
          if (response === undefined) {
            throw mkErr('request handler returned undefined')
          }
          return response
        }

        const handler = requestSlot.get()
        if (!handler) {
          throw mkErr('no active request handler')
        }
        const roles = getPeerRoles?.(peerId)
        const ctx = {
          ...withMetadata({peerId, userId: userIdOf(peerId)}, parsed.m),
          signal: controller.signal,
          ...(roles && roles.length > 0 ? {roles} : {})
        }
        const response = await handler(payload as T, ctx)
        if (response === undefined) {
          throw mkErr('request handler returned undefined')
        }
        return response
      }

      void runHandler()
        .then(
          response => responseAction.send(response, peerId, {r: parsed.r}),
          error =>
            responseAction.send(null, peerId, {
              r: parsed.r,
              e: toErrorMessage(error, requestFailedMsg).slice(0, 512)
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

    const requestSlot = createSingleHandler<ActionRequestHandler<T, R>>(
      'onRequest',
      handler => rawAction.onMessage(handler ? receiveRequest : null)
    )

    const requestOne = async (data: T, options: RequestOptions): Promise<R> => {
      const {target, metadata, onProgress, signal, timeoutMs} = options

      throwIfAborted(signal)

      const resolvedTarget = resolveRequestTarget
        ? (resolveRequestTarget(target) ?? target)
        : target

      if (!getPeer(resolvedTarget, false)) {
        throw makeActionError('disconnected', noActivePeerMsg(target))
      }

      const innerMeta =
        state.requiredRoles.length > 0 && signActionPayload
          ? await signActionPayload(type, state.requiredRoles, data, metadata)
          : metadata

      const requestId = crypto.randomUUID()
      const controller = new AbortController()
      const responsePromise = new Promise<DataPayload>((resolve, reject) => {
        const waiter: PendingRequestWaiter = {
          controller,
          getReceive: () => receiveSlot.get(),
          emitReceiveProgress: (progress, ctx) =>
            progressEmitter.emit(progress, ctx),
          peerId: resolvedTarget,
          resolve,
          reject,
          timer: null,
          ...(signal === undefined ? {} : {signal})
        }

        const rejectAsAborted = (): void => {
          clearPendingRequestWaiter(requestId)
          reject(makeActionError('aborted', operationAbortedMsg))
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
              const error = toError(err, requestFailedMsg) as ActionError

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

      onRequest: (handler: ActionRequestHandler<T, R>, options) =>
        requestSlot.set(handler, options),

      onReceive: (handler, options) => receiveSlot.set(handler, options),

      onReceiveProgress: (handler, options) =>
        progressEmitter.subscribe(handler, options)
    } satisfies RequestAction<T, R>

    const lockedAction = lockMethods(action, [
      'onRequest',
      'onReceive',
      'onReceiveProgress'
    ])

    state.action = lockedAction
    state.clear = () => {
      requestSlot.clear()
      receiveSlot.clear()
      progressEmitter.clear()
    }
    publicActions[type] = state

    return lockedAction
  }

  return {
    makeAction: makeActionImpl as Room['makeAction'],
    makeInternalAction,
    handleData,
    clearPeer,
    clearListeners: () => {
      values(publicActions).forEach(state => state.clear())
    }
  }
}
