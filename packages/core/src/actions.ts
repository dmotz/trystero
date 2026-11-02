import {
  actionRedefinedErr,
  all,
  authMetaKey,
  createEventEmitter,
  entries,
  initSingleHandler,
  insufficientAuthPrefix,
  internalActionPrefix,
  isObj,
  lockMethods,
  logActionHandlerErr,
  logErr,
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
  initActionWireManager,
  makeActionError,
  throwIfAborted,
  toPeerTransportGetter,
  type ActionError,
  type ActionErrorKind,
  type ActionOptions,
  type InternalAction,
  type InternalActionSender
} from './action-wire'
import type {PeerDataTransport} from './peer-registry'
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

type PublicActionState = [
  kind: PublicActionKind,
  requiredRoles: string[],
  action: unknown,
  syncReceive: () => void,
  clear: () => void
]

type PendingRequestWaiter = [
  controller: AbortController,
  getReceive: () => ActionReceiveHandler | null,
  emitReceiveProgress: (
    progress: number,
    context: ActionProgressContext
  ) => void,
  peerId: string,
  resolve: (payload: DataPayload) => void,
  reject: (error: Error) => void,
  timer: ReturnType<typeof setTimeout> | null,
  signal: AbortSignal | undefined,
  abortHandler: (() => void) | undefined
]

const getEnvelopeRecord = (
  metadata?: JsonValue
): {r: string; m?: JsonValue; e?: unknown} | null =>
  isObj(metadata) && typeof metadata['r'] === 'string'
    ? (metadata as {r: string; m?: JsonValue; e?: unknown})
    : null

const getRequestMetadata = (
  metadata?: JsonValue
): [r: string, m: JsonValue | undefined] | null => {
  const record = getEnvelopeRecord(metadata)
  return record
    ? [record.r, Object.hasOwn(record, 'm') ? record.m : undefined]
    : null
}

const getResponseMetadata = (
  metadata?: JsonValue
): [r: string, e: string | undefined] | null => {
  const record = getEnvelopeRecord(metadata)
  return record
    ? [record.r, typeof record.e === 'string' ? record.e : undefined]
    : null
}

const withMetadata = <T extends {peerId: string}>(
  context: T,
  metadata?: JsonValue
): T & {metadata?: JsonValue} =>
  metadata === undefined ? context : {...context, metadata}

const requestFailedMsg = 'request failed'

const unwrapAuthUserMetadata = (
  wireMeta: JsonValue | undefined
): JsonValue | undefined =>
  isObj(wireMeta) && authMetaKey in wireMeta
    ? Object.hasOwn(wireMeta, 'm')
      ? (wireMeta['m'] as JsonValue | undefined)
      : undefined
    : wireMeta

export type VerifyActionResult = {
  valid: boolean
  userMetadata?: JsonValue
  roles: string[]
}

export const initActionManager = (
  getPeerIds: (includePending: boolean) => string[],
  canReceiveFromPeer: (id: string, receiveWhilePending: boolean) => boolean,
  onPeerError: (peerId: string, error: Error) => void,
  getTransport: (
    id: string,
    includePending: boolean
  ) => PeerDataTransport | undefined,
  broadcastInline?: (
    frame: Uint8Array,
    onProgress?: (peerId: string) => void,
    signal?: AbortSignal
  ) => Promise<boolean> | boolean,
  registerActionAuthority?: (namespace: string, roles: string[]) => void,
  signActionPayload?: (
    namespace: string,
    requiredRoles: readonly string[],
    data: DataPayload,
    userMetadata?: JsonValue
  ) => Promise<JsonValue>,
  verifyActionOffer?: (
    namespace: string,
    peerId: string,
    requiredRoles: readonly string[],
    wireMetadata?: JsonValue
  ) => Promise<VerifyActionResult>,
  verifyActionPayload?: (
    namespace: string,
    peerId: string,
    requiredRoles: readonly string[],
    data: DataPayload,
    wireMetadata?: JsonValue
  ) => Promise<VerifyActionResult>,
  getPeerRoles?: (peerId: string) => string[],
  getPeerUserId?: (peerId: string) => string,
  resolveSendTarget?: (target?: TargetPeers) => TargetPeers,
  resolveRequestTarget?: (target: string) => string | undefined,
  onUnauthorizedAction?: (namespace: string, peerId: string) => void,
  maxReceiveBytes?: number
): readonly [
  makeAction: Room['makeAction'],
  makeInternalAction: <T extends DataPayload = DataPayload>(
    type: string,
    options?: Partial<ActionOptions>
  ) => InternalAction<T>,
  handleData: (id: string, data: ArrayBuffer) => void,
  clearPeer: (id: string, error: Error) => void,
  clearListeners: () => void
] => {
  const userIdOf = (peerId: string): string =>
    getPeerUserId ? getPeerUserId(peerId) : peerId
  const hasActivePeer = (peerId: string): boolean =>
    Boolean(getTransport(peerId, false))
  const publicActions: Record<string, PublicActionState> = Object.create(null)
  const pendingRequestWaiters: Record<string, PendingRequestWaiter> = {}
  const activeRequestControllers = new Map<string, Set<AbortController>>()
  const [makeWireAction, handleData, clearWirePeer] = initActionWireManager(
    getPeerIds,
    canReceiveFromPeer,
    onPeerError,
    getTransport,
    broadcastInline,
    throwIfAborted,
    maxReceiveBytes
  )
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

  const clearPendingRequestWaiter = (requestId: string): void => {
    const waiter = pendingRequestWaiters[requestId]
    if (!waiter) {
      return
    }
    resetTimer(waiter[6])
    if (waiter[7] && waiter[8]) {
      waiter[7].removeEventListener('abort', waiter[8])
    }
    delete pendingRequestWaiters[requestId]
    waiter[0].abort()
  }

  const clearPeer = (id: string, error: Error): void => {
    clearWirePeer(id)
    const controllers = activeRequestControllers.get(id)
    if (controllers) {
      activeRequestControllers.delete(id)
      controllers.forEach(controller => controller.abort())
    }
    const disconnectedErr = makeActionError(
      'disconnected',
      toErrorMessage(error, peerDisconnectedMsg)
    )
    entries(pendingRequestWaiters).forEach(([requestId, waiter]) => {
      if (waiter[3] === id) {
        clearPendingRequestWaiter(requestId)
        waiter[5](disconnectedErr)
      }
    })
  }

  const matchResponseWaiter = (
    peerId: string,
    metadata?: JsonValue
  ):
    | readonly [
        parsed: [r: string, e: string | undefined],
        waiter: PendingRequestWaiter
      ]
    | null => {
    const parsed = getResponseMetadata(metadata)
    const waiter = parsed && pendingRequestWaiters[parsed[0]]
    return parsed && waiter && waiter[3] === peerId ? [parsed, waiter] : null
  }

  const responseAction = makeInternalAction<DataPayload>('response', {
    receiveScope: (peerId, metadata) => {
      const matched = matchResponseWaiter(peerId, metadata)
      if (!matched) {
        return null
      }
      const [parsed, waiter] = matched
      const receive = parsed[1] === undefined ? waiter[1]() : null
      return [
        parsed[0],
        waiter[0].signal,
        receive
          ? context =>
              receive({
                byteLength: context.byteLength,
                peerId: context.peerId,
                userId: userIdOf(context.peerId),
                kind: 'response',
                signal: context.signal
              })
          : null,
        reason => {
          if (pendingRequestWaiters[parsed[0]] === waiter) {
            clearPendingRequestWaiter(parsed[0])
            waiter[5](makeActionError('rejected', reason))
          }
        }
      ]
    }
  })

  responseAction.onProgress((progress, id, metadata) => {
    const matched = matchResponseWaiter(id, metadata)
    if (matched && matched[0][1] === undefined) {
      matched[1][2](progress, {peerId: id, userId: userIdOf(id)})
    }
  })

  responseAction.onMessage((payload, id, metadata) => {
    const matched = matchResponseWaiter(id, metadata)
    if (!matched) {
      return
    }
    const [parsed, waiter] = matched
    clearPendingRequestWaiter(parsed[0])
    if (parsed[1] !== undefined) {
      waiter[5](makeActionError('rejected', parsed[1]))
    } else {
      waiter[4](payload)
    }
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
      ? [config.roles].flat().filter(Boolean)
      : []
    const hasAuthority = requiredRoles.length > 0
    if (hasAuthority) {
      registerActionAuthority?.(type, requiredRoles)
    }
    const rawAction = makeWireAction<T>(type)
    const existingState = publicActions[type]

    if (existingState) {
      if (existingState[0] !== kind) {
        throw actionRedefinedErr(type)
      }
      if (hasAuthority && existingState[1].length === 0) {
        existingState[1] = requiredRoles
        registerActionAuthority?.(type, requiredRoles)
        existingState[3]()
      }
      return existingState[2] as MessageAction<T> | RequestAction<T, R>
    }

    const [subProgress, emitProgress, clearProgress, hasProgressListeners] =
      createEventEmitter<[number, ActionProgressContext]>('progress handler')

    const state: PublicActionState = [kind, requiredRoles, null, noOp, noOp]

    const toProgressHandler = (
      handler?: ActionProgressHandler,
      metadata?: JsonValue
    ) =>
      handler
        ? (progress: number, peerId: string) => {
            const res = handler(
              progress,
              withMetadata({peerId, userId: userIdOf(peerId)}, metadata)
            )
            if (
              res &&
              typeof (res as PromiseLike<unknown>).then === 'function'
            ) {
              void Promise.resolve(res).catch(err =>
                logErr('progress handler', err)
              )
            }
          }
        : undefined

    const extractRawUserMeta = (metadata?: JsonValue): JsonValue | undefined =>
      state[0] === 'request' ? getRequestMetadata(metadata)?.[1] : metadata

    const resolveReqPeer = (target: string): string =>
      (resolveRequestTarget ? resolveRequestTarget(target) : target) ?? target

    const peerCtx = (
      peerId: string,
      roles?: string[],
      meta?: JsonValue
    ): MessageContext =>
      withMetadata(
        {
          peerId,
          userId: userIdOf(peerId),
          ...(roles && roles.length > 0 ? {roles} : {})
        },
        meta
      )

    const buildGateCtx = (
      context: {byteLength: number; peerId: string; signal: AbortSignal},
      roles: string[] | undefined,
      meta: JsonValue | undefined
    ) => ({
      ...peerCtx(context.peerId, roles, meta),
      byteLength: context.byteLength,
      signal: context.signal,
      kind
    })

    const setReceive = (): void => {
      const hasRoleGuard = state[1].length > 0 && Boolean(verifyActionOffer)
      if (!getReceiveGate() && !hasRoleGuard) {
        rawAction.onReceive(null)
        return
      }
      rawAction.onReceive(
        hasRoleGuard
          ? async context => {
              const offerRes = await verifyActionOffer!(
                type,
                context.peerId,
                state[1],
                extractRawUserMeta(context.metadata)
              )
              if (!offerRes.valid) {
                onUnauthorizedAction?.(type, context.peerId)
                return false
              }
              return (
                getReceiveGate()?.(
                  buildGateCtx(context, offerRes.roles, offerRes.userMetadata)
                ) ?? true
              )
            }
          : context =>
              getReceiveGate()?.(
                buildGateCtx(
                  context,
                  getPeerRoles?.(context.peerId),
                  unwrapAuthUserMetadata(extractRawUserMeta(context.metadata))
                )
              ) ?? true
      )
    }

    const [setReceiveGate, getReceiveGate, clearReceiveGate] =
      initSingleHandler<ActionReceiveHandler>('onReceive', () => setReceive())
    state[3] = setReceive
    setReceive()

    rawAction.onProgress((progress, peerId, metadata) => {
      if (hasProgressListeners()) {
        emitProgress(
          progress,
          peerCtx(
            peerId,
            undefined,
            unwrapAuthUserMetadata(extractRawUserMeta(metadata))
          )
        )
      }
    })

    if (kind === 'message') {
      const emitMsg = (
        payload: DataPayload,
        peerId: string,
        roles: string[] | undefined,
        meta?: JsonValue
      ): void => emitMessage(payload as T, peerCtx(peerId, roles, meta))

      const receiveMessage = (
        payload: DataPayload,
        peerId: string,
        metadata?: JsonValue
      ): void => {
        if (state[1].length === 0 || !verifyActionPayload) {
          emitMsg(payload, peerId, getPeerRoles?.(peerId), metadata)
          return
        }

        void verifyActionPayload(type, peerId, state[1], payload, metadata)
          .then(verified => {
            if (!verified.valid) {
              onUnauthorizedAction?.(type, peerId)
              return
            }
            if (hasMessageListeners()) {
              emitMsg(payload, peerId, verified.roles, verified.userMetadata)
            }
          })
          .catch(logActionHandlerErr)
      }

      const [subMessage, emitMessage, clearMessage, hasMessageListeners] =
        createEventEmitter<[T, MessageContext]>('action handler', active =>
          rawAction.onMessage(active ? receiveMessage : null)
        )

      const action = lockMethods(
        {
          send: async (data: T, options: SendOptions = {}) => {
            const wireMetadata =
              state[1].length > 0 && signActionPayload
                ? await signActionPayload(
                    type,
                    state[1],
                    data,
                    options.metadata
                  )
                : options.metadata
            await rawAction.send(
              data,
              resolveSendTarget
                ? resolveSendTarget(options.target)
                : options.target,
              wireMetadata,
              toProgressHandler(options.onProgress, options.metadata),
              options.signal
            )
          },
          onMessage: (handler: ActionMessageHandler<T>, options) =>
            subMessage(handler, options),
          onReceive: (handler, options) => setReceiveGate(handler, options),
          onReceiveProgress: (handler, options) => subProgress(handler, options)
        } satisfies MessageAction<T>,
        ['onMessage', 'onReceive', 'onReceiveProgress']
      )

      state[2] = action
      state[4] = () => {
        clearMessage()
        clearReceiveGate()
        clearProgress()
      }
      publicActions[type] = state
      return action
    }

    rawAction.onReject((peerId, metadata, reason) => {
      const parsed = getRequestMetadata(metadata)
      if (parsed) {
        void responseAction
          .send(null, peerId, {r: parsed[0], e: reason})
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
        let userMeta = parsed[1]
        let roles = getPeerRoles?.(peerId)
        if (state[1].length > 0 && verifyActionPayload) {
          const verified = await verifyActionPayload(
            type,
            peerId,
            state[1],
            payload,
            parsed[1]
          )
          if (!verified.valid) {
            onUnauthorizedAction?.(type, peerId)
            throw mkErr(`${insufficientAuthPrefix} for request`)
          }
          userMeta = verified.userMetadata
          roles = verified.roles
        }

        const handler = getRequestGate()
        if (!handler) {
          throw mkErr('no active request handler')
        }
        const response = await handler(payload as T, {
          ...peerCtx(peerId, roles, userMeta),
          signal: controller.signal
        })
        if (response === undefined) {
          throw mkErr('request handler returned undefined')
        }
        return response
      }

      void runHandler()
        .then(
          response => responseAction.send(response, peerId, {r: parsed[0]}),
          error =>
            responseAction.send(null, peerId, {
              r: parsed[0],
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

    const [setRequestGate, getRequestGate, clearRequestGate] =
      initSingleHandler<ActionRequestHandler<T, R>>('onRequest', handler =>
        rawAction.onMessage(handler ? receiveRequest : null)
      )

    const requestOne = async (data: T, options: RequestOptions): Promise<R> => {
      const {target, metadata, onProgress, signal, timeoutMs} = options
      const resolvedTarget = resolveReqPeer(target)
      const checkReqPeer = (): void => {
        throwIfAborted(signal)
        if (!hasActivePeer(resolvedTarget)) {
          throw makeActionError('disconnected', noActivePeerMsg(target))
        }
      }
      checkReqPeer()

      const innerMeta =
        state[1].length > 0 && signActionPayload
          ? await signActionPayload(type, state[1], data, metadata)
          : metadata
      if (state[1].length > 0 && signActionPayload) {
        checkReqPeer()
      }

      const requestId = crypto.randomUUID()
      const controller = new AbortController()
      const responsePromise = new Promise<DataPayload>((resolve, reject) => {
        const waiter: PendingRequestWaiter = [
          controller,
          getReceiveGate,
          emitProgress,
          resolvedTarget,
          resolve,
          reject,
          null,
          signal,
          undefined
        ]

        if (signal) {
          const rejectAsAborted = (): void => {
            clearPendingRequestWaiter(requestId)
            reject(makeActionError('aborted', operationAbortedMsg))
          }
          waiter[8] = rejectAsAborted
          signal.addEventListener('abort', rejectAsAborted, {once: true})
        }

        pendingRequestWaiters[requestId] = waiter
        if (timeoutMs !== undefined) {
          waiter[6] = setTimeout(() => {
            clearPendingRequestWaiter(requestId)
            waiter[5](makeActionError('timeout', 'request timed out'))
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

    const lockedAction = lockMethods(
      {
        request: requestOne,
        requestMany: async (data: T, options: RequestManyOptions<R>) => {
          const {targets, onResult, ...requestOptions} = options
          throwIfAborted(requestOptions.signal)

          return all(
            targets.map(async target => {
              const resolvedTarget = resolveReqPeer(target)
              const base = {
                peerId: resolvedTarget,
                userId: userIdOf(resolvedTarget) || target
              }
              let result: PeerResult<R>
              try {
                result = {
                  ...base,
                  status: 'fulfilled',
                  value: await requestOne(data, {...requestOptions, target})
                }
              } catch (err) {
                const error = toError(err, requestFailedMsg) as ActionError
                if (error.kind === 'aborted' || !error.kind) {
                  throw error
                }
                result =
                  error.kind === 'timeout' || error.kind === 'disconnected'
                    ? {...base, status: error.kind}
                    : {...base, status: 'rejected', error}
              }
              onResult?.(result)
              return result
            })
          )
        },
        onRequest: (handler: ActionRequestHandler<T, R>, options) =>
          setRequestGate(handler, options),
        onReceive: (handler, options) => setReceiveGate(handler, options),
        onReceiveProgress: (handler, options) => subProgress(handler, options)
      } satisfies RequestAction<T, R>,
      ['onRequest', 'onReceive', 'onReceiveProgress']
    )

    state[2] = lockedAction
    state[4] = () => {
      clearRequestGate()
      clearReceiveGate()
      clearProgress()
    }
    publicActions[type] = state
    return lockedAction
  }

  return [
    makeActionImpl as Room['makeAction'],
    makeInternalAction,
    handleData,
    clearPeer,
    () => {
      values(publicActions).forEach(s => s[4]())
    }
  ]
}

export const createActionManager = (deps: {
  onPeerError: (peerId: string, error: Error) => void
  maxReceiveBytes?: number
  getTransport?: (
    id: string,
    includePending: boolean
  ) => PeerDataTransport | undefined
  getPeer?: (id: string, includePending: boolean) => PeerHandle | undefined
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
  ) => Promise<VerifyActionResult>
  verifyActionPayload?: (
    namespace: string,
    peerId: string,
    requiredRoles: readonly string[],
    data: DataPayload,
    wireMetadata?: JsonValue
  ) => Promise<VerifyActionResult>
  getPeerRoles?: (peerId: string) => string[]
  getPeerUserId?: (peerId: string) => string
  resolveSendTarget?: (target?: TargetPeers) => TargetPeers
  resolveRequestTarget?: (target: string) => string | undefined
  onUnauthorizedAction?: (namespace: string, peerId: string) => void
}) => {
  const [
    makeAction,
    makeInternalAction,
    handleData,
    clearPeer,
    clearListeners
  ] = initActionManager(
    deps.getPeerIds,
    deps.canReceiveFromPeer,
    deps.onPeerError,
    toPeerTransportGetter(deps.getTransport, deps.getPeer),
    deps.broadcastInline,
    deps.registerActionAuthority,
    deps.signActionPayload,
    deps.verifyActionOffer,
    deps.verifyActionPayload,
    deps.getPeerRoles,
    deps.getPeerUserId,
    deps.resolveSendTarget,
    deps.resolveRequestTarget,
    deps.onUnauthorizedAction,
    deps.maxReceiveBytes
  )
  return {makeAction, makeInternalAction, handleData, clearPeer, clearListeners}
}
