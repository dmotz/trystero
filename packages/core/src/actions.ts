import {
  createActionWireManager,
  makeActionError,
  throwIfAborted,
  type WireAction
} from './action-wire'
import type {
  ActionOptions,
  InternalAction,
  InternalMessageContext,
  InternalReceiveContext,
  PeerDataTransport,
  TargetPeers
} from './internal-types'
import type {
  ActionError,
  ActionMessageHandler,
  ActionProgressContext,
  ActionProgressHandler,
  ActionReceiveContext,
  ActionReceiveHandler,
  ActionRequestHandler,
  DataPayload,
  JsonValue,
  ListenerOptions,
  MessageAction,
  MessageActionConfig,
  MessageContext,
  PeerResult,
  RequestAction,
  RequestActionConfig,
  RequestManyOptions,
  RequestOptions,
  RoleCertificate,
  Room,
  SendOptions
} from './types'
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
  logErr,
  mkErr,
  noActivePeerMsg,
  noOp,
  operationAbortedMsg,
  peerDisconnectedMsg,
  resetTimer,
  toError,
  toErrorMessage,
  unrefTimer,
  validateRoleCertificateShape,
  values
} from './utils'

export type {ActionError, ActionOptions, InternalAction}

const maxConcurrentRequestsPerPeer = 64
const requestFailedMsg = 'request failed'

type PublicActionKind = 'message' | 'request'

type RegisteredPublicAction = {
  kind: PublicActionKind
  requiredRoles: string[]
  action: unknown
  clear: () => void
  internal: boolean
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
  signal: AbortSignal | undefined
  abortHandler: (() => void) | undefined
}

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

const wrapAuthMetadata = (
  cert: RoleCertificate | null,
  userMetadata?: JsonValue
): JsonValue | undefined =>
  cert
    ? ({
        [authMetaKey]: cert as unknown as JsonValue,
        ...(userMetadata === undefined ? {} : {m: userMetadata})
      } as JsonValue)
    : userMetadata

const extractAuthMetadata = (
  wireMeta: JsonValue | undefined
): [
  inlineCert: RoleCertificate | undefined,
  userMeta: JsonValue | undefined
] => {
  if (isObj(wireMeta) && authMetaKey in wireMeta) {
    const rawCert = wireMeta[authMetaKey]
    const inlineCert = validateRoleCertificateShape(rawCert)
      ? rawCert
      : undefined
    const userMeta = Object.hasOwn(wireMeta, 'm')
      ? (wireMeta['m'] as JsonValue | undefined)
      : undefined
    return [inlineCert, userMeta]
  }
  return [undefined, wireMeta]
}

const normalizeRequiredRoles = (
  roles?: string | readonly string[]
): string[] => {
  if (roles === undefined) {
    return []
  }
  const list = [roles].flat().filter(Boolean)
  if (list.length === 0) {
    throw mkErr('action roles must contain at least one non-empty role name')
  }
  return [...new Set(list)].sort()
}

const sameSortedRoles = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((role, idx) => role === b[idx])

export type ActionManagerDeps = {
  onPeerError: (peerId: string, error: Error) => void
  maxReceiveBytes?: number
  getTransport: (
    id: string,
    includePending: boolean
  ) => PeerDataTransport | undefined
  getPeerIds: (includePending: boolean) => string[]
  canReceiveFromPeer: (id: string, receiveWhilePending: boolean) => boolean
  broadcastInline?: (
    frame: Uint8Array,
    onProgress?: (peerId: string) => void,
    signal?: AbortSignal
  ) => Promise<boolean> | boolean
  registerActionAuthority?: (namespace: string, roles: string[]) => void
  getLocalActionCert?: (
    requiredRoles: readonly string[],
    namespace: string
  ) => Promise<RoleCertificate | null>
  authorizePeerAction?: (
    peerId: string,
    requiredRoles: readonly string[],
    inlineCert?: RoleCertificate
  ) => boolean | Promise<boolean>
  getPeerRoles?: (peerId: string) => string[]
  getPeerUserId?: (peerId: string) => string
  resolveSendTarget?: (
    target?: TargetPeers,
    includePending?: boolean
  ) => TargetPeers
  resolveRequestTarget?: (
    target: string,
    includePending?: boolean
  ) => string | undefined
}

export const createActionManager = (
  deps: ActionManagerDeps
): {
  makeAction: Room['makeAction']
  makeInternalAction: <T extends DataPayload = DataPayload>(
    type: string,
    options?: Partial<ActionOptions>
  ) => InternalAction<T>
  makeInternalRequestAction: <
    T extends DataPayload = DataPayload,
    R extends DataPayload = DataPayload
  >(
    type: string
  ) => RequestAction<T, R>
  handleData: (id: string, data: ArrayBuffer) => void
  clearPeer: (id: string, error: Error) => void
  clearListeners: () => void
} => {
  const resolveTransport = deps.getTransport

  const userIdOf = (peerId: string): string =>
    deps.getPeerUserId ? deps.getPeerUserId(peerId) : peerId
  const rolesOf = (peerId: string): string[] =>
    deps.getPeerRoles ? [...deps.getPeerRoles(peerId)] : []
  const hasActivePeer = (peerId: string): boolean =>
    Boolean(resolveTransport(peerId, false)?.isOpen)

  const publicActions: Record<string, RegisteredPublicAction> =
    Object.create(null)
  const internalActions = new Map<string, InternalAction<DataPayload>>()
  const pendingRequestWaiters: Record<string, PendingRequestWaiter> = {}
  const activeRequestControllers = new Map<string, Set<AbortController>>()

  const {
    makeWireAction,
    handleData,
    clearPeer: clearWirePeer
  } = createActionWireManager({
    resolveTransport,
    getPeerIds: deps.getPeerIds,
    canReceiveFromPeer: deps.canReceiveFromPeer,
    onPeerError: deps.onPeerError,
    ...(deps.broadcastInline ? {broadcastInline: deps.broadcastInline} : {}),
    ...(deps.maxReceiveBytes === undefined
      ? {}
      : {maxReceiveBytes: deps.maxReceiveBytes})
  })

  const toProgressBridge = (
    handler?: ActionProgressHandler,
    metadata?: JsonValue
  ): ((progress: number, peerId: string) => void) | undefined =>
    handler
      ? (progress: number, peerId: string) => {
          const res = handler(
            progress,
            withMetadata({peerId, userId: userIdOf(peerId)}, metadata)
          )
          if (res && typeof (res as PromiseLike<unknown>).then === 'function') {
            void Promise.resolve(res).catch(err =>
              logErr('progress handler', err)
            )
          }
        }
      : undefined

  const makeInternalAction = <T extends DataPayload = DataPayload>(
    type: string,
    options: Partial<ActionOptions> = {}
  ): InternalAction<T> => {
    const wireType = type.startsWith(internalActionPrefix)
      ? type
      : `${internalActionPrefix}${type}`
    const sendToPending = Boolean(options.sendToPending)
    const wireAction = makeWireAction<T>(wireType, options)
    const existing = internalActions.get(wireType)
    if (existing) {
      return existing as unknown as InternalAction<T>
    }

    const [subProgress, emitProgress, , hasProgressListeners] =
      createEventEmitter<[number, ActionProgressContext]>('progress handler')

    const [subMessage, emitMessage] = createEventEmitter<
      [T, InternalMessageContext]
    >('internal action handler', active => {
      wireAction.onMessage(
        active
          ? (payload, peerId, metadata) => {
              emitMessage(
                payload,
                withMetadata({peerId, userId: userIdOf(peerId)}, metadata)
              )
            }
          : null
      )
    })

    const [setReceiveGate, getReceiveGate] = initSingleHandler<
      (context: InternalReceiveContext) => boolean | Promise<boolean>
    >('onReceive', handler => {
      wireAction.onReceive(
        handler
          ? ctx =>
              handler(
                withMetadata(
                  {
                    peerId: ctx.peerId,
                    userId: userIdOf(ctx.peerId),
                    byteLength: ctx.byteLength,
                    signal: ctx.signal
                  },
                  ctx.metadata
                )
              )
          : null
      )
    })

    wireAction.onProgress((progress, peerId, metadata) => {
      if (hasProgressListeners()) {
        emitProgress(
          progress,
          withMetadata({peerId, userId: userIdOf(peerId)}, metadata)
        )
      }
    })

    const action = lockMethods(
      {
        send: (data: T, sendOpts: SendOptions = {}) =>
          wireAction.send(
            data,
            deps.resolveSendTarget
              ? deps.resolveSendTarget(sendOpts.target, sendToPending)
              : sendOpts.target,
            sendOpts.metadata,
            toProgressBridge(sendOpts.onProgress, sendOpts.metadata),
            sendOpts.signal
          ),
        onMessage: (
          handler: (data: T, context: InternalMessageContext) => unknown,
          listenerOpts?: ListenerOptions
        ) => subMessage(handler, listenerOpts),
        onReceiveProgress: (
          handler: ActionProgressHandler,
          listenerOpts?: ListenerOptions
        ) => subProgress(handler, listenerOpts),
        onReceive: (
          handler: (
            context: InternalReceiveContext
          ) => boolean | Promise<boolean>,
          listenerOpts?: ListenerOptions
        ) => setReceiveGate(handler ?? getReceiveGate()!, listenerOpts)
      } satisfies InternalAction<T>,
      ['onMessage', 'onReceive', 'onReceiveProgress']
    )

    internalActions.set(
      wireType,
      action as unknown as InternalAction<DataPayload>
    )
    return action
  }

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
      if (waiter.peerId === id) {
        clearPendingRequestWaiter(requestId)
        waiter.reject(disconnectedErr)
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
    return parsed && waiter && waiter.peerId === peerId
      ? [parsed, waiter]
      : null
  }

  const responseAction: WireAction<DataPayload> = makeWireAction<DataPayload>(
    `${internalActionPrefix}response`,
    {
      receiveScope: (peerId, metadata) => {
        const matched = matchResponseWaiter(peerId, metadata)
        if (!matched) {
          return null
        }
        const [parsed, waiter] = matched
        const receive = parsed[1] === undefined ? waiter.getReceive() : null
        return [
          parsed[0],
          waiter.controller.signal,
          receive
            ? context =>
                receive({
                  byteLength: context.byteLength,
                  peerId: context.peerId,
                  userId: userIdOf(context.peerId),
                  kind: 'response',
                  signal: context.signal,
                  roles: rolesOf(context.peerId)
                })
            : null,
          reason => {
            if (pendingRequestWaiters[parsed[0]] === waiter) {
              clearPendingRequestWaiter(parsed[0])
              waiter.reject(makeActionError('rejected', reason))
            }
          }
        ]
      }
    }
  )

  responseAction.onProgress((progress, id, metadata) => {
    const matched = matchResponseWaiter(id, metadata)
    if (matched && matched[0][1] === undefined) {
      matched[1].emitReceiveProgress(progress, {
        peerId: id,
        userId: userIdOf(id)
      })
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
      waiter.reject(makeActionError('rejected', parsed[1]))
    } else {
      waiter.resolve(payload)
    }
  })

  const makeActionCore = <T = DataPayload, R = DataPayload>(
    type: string,
    config: MessageActionConfig | RequestActionConfig | undefined,
    internal: boolean
  ): MessageAction<T> | RequestAction<T, R> => {
    if (!internal && type.startsWith(internalActionPrefix)) {
      throw mkErr(
        `action namespace "${type}" is reserved for internal protocol use`
      )
    }
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

    const kind: PublicActionKind = config?.kind ?? 'message'
    const requiredRoles = normalizeRequiredRoles(config?.roles)
    const hasRoleGuard = requiredRoles.length > 0

    const existing = publicActions[type]
    if (existing) {
      if (
        existing.kind !== kind ||
        existing.internal !== internal ||
        !sameSortedRoles(existing.requiredRoles, requiredRoles)
      ) {
        throw actionRedefinedErr(type)
      }
      return existing.action as MessageAction<T> | RequestAction<T, R>
    }

    if (hasRoleGuard) {
      deps.registerActionAuthority?.(type, requiredRoles)
    }

    const rawAction = makeWireAction<T>(type)
    const [subProgress, emitProgress, clearProgress, hasProgressListeners] =
      createEventEmitter<[number, ActionProgressContext]>('progress handler')

    const extractWireMeta = (
      metadata?: JsonValue
    ): [
      inlineCert: RoleCertificate | undefined,
      userMeta: JsonValue | undefined
    ] =>
      extractAuthMetadata(
        kind === 'request' ? getRequestMetadata(metadata)?.[1] : metadata
      )

    const resolveReqPeer = (target: string): string =>
      (deps.resolveRequestTarget
        ? deps.resolveRequestTarget(target, false)
        : target) ?? target

    const buildPeerContext = (
      peerId: string,
      userMeta?: JsonValue
    ): MessageContext =>
      withMetadata(
        {
          peerId,
          userId: userIdOf(peerId),
          roles: rolesOf(peerId)
        },
        userMeta
      )

    const buildGateContext = (
      context: {byteLength: number; peerId: string; signal: AbortSignal},
      userMeta: JsonValue | undefined
    ): ActionReceiveContext => ({
      ...buildPeerContext(context.peerId, userMeta),
      byteLength: context.byteLength,
      signal: context.signal,
      kind
    })

    const syncReceiveGate = (): void => {
      const hasUserGate = Boolean(getReceiveGate())
      if (!hasUserGate && !hasRoleGuard) {
        rawAction.onReceive(null)
        return
      }
      rawAction.onReceive(context => {
        const [inlineCert, userMeta] = extractWireMeta(context.metadata)
        if (!hasRoleGuard) {
          const gate = getReceiveGate()
          return gate ? gate(buildGateContext(context, userMeta)) : true
        }
        if (!deps.authorizePeerAction) {
          return false
        }
        const authRes = deps.authorizePeerAction(
          context.peerId,
          requiredRoles,
          inlineCert
        )
        const afterAuth = (allowed: boolean): boolean | Promise<boolean> => {
          if (!allowed) {
            return false
          }
          const gate = getReceiveGate()
          return gate ? gate(buildGateContext(context, userMeta)) : true
        }
        return typeof authRes === 'boolean'
          ? afterAuth(authRes)
          : authRes.then(afterAuth, () => false)
      }, !hasUserGate)
    }

    const [setReceiveGate, getReceiveGate, clearReceiveGate] =
      initSingleHandler<ActionReceiveHandler>('onReceive', () =>
        syncReceiveGate()
      )
    syncReceiveGate()

    rawAction.onProgress((progress, peerId, metadata) => {
      if (hasProgressListeners()) {
        const [, userMeta] = extractWireMeta(metadata)
        emitProgress(
          progress,
          withMetadata({peerId, userId: userIdOf(peerId)}, userMeta)
        )
      }
    })

    const prepareSendMeta = async (
      userMeta?: JsonValue
    ): Promise<JsonValue | undefined> => {
      if (!hasRoleGuard) {
        return userMeta
      }
      if (!deps.getLocalActionCert) {
        throw mkErr(
          `${insufficientAuthPrefix} for action "${type}": requires [${requiredRoles.join(', ')}]`
        )
      }
      const cert = await deps.getLocalActionCert(requiredRoles, type)
      return wrapAuthMetadata(cert, userMeta)
    }

    if (kind === 'message') {
      const receiveMessage = (
        payload: T,
        peerId: string,
        metadata?: JsonValue
      ): void => {
        if (
          hasRoleGuard &&
          (!deps.authorizePeerAction ||
            deps.authorizePeerAction(peerId, requiredRoles) !== true)
        ) {
          return
        }
        const [, userMeta] = extractAuthMetadata(metadata)
        emitMessage(payload, buildPeerContext(peerId, userMeta))
      }

      const [subMessage, emitMessage, clearMessage] = createEventEmitter<
        [T, MessageContext]
      >('action handler', active =>
        rawAction.onMessage(active ? receiveMessage : null)
      )

      const action = lockMethods(
        {
          send: async (data: T, options: SendOptions = {}) => {
            throwIfAborted(options.signal)
            const wireMetadata = hasRoleGuard
              ? await prepareSendMeta(options.metadata)
              : options.metadata
            await rawAction.send(
              data,
              deps.resolveSendTarget
                ? deps.resolveSendTarget(options.target, false)
                : options.target,
              wireMetadata,
              toProgressBridge(options.onProgress, options.metadata),
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

      publicActions[type] = {
        kind,
        requiredRoles,
        action,
        internal,
        clear: () => {
          clearMessage()
          clearReceiveGate()
          clearProgress()
        }
      }
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
      payload: T,
      peerId: string,
      metadata?: JsonValue
    ): void => {
      const parsed = getRequestMetadata(metadata)
      if (!parsed) {
        return
      }
      let peerControllers = activeRequestControllers.get(peerId)
      if ((peerControllers?.size ?? 0) >= maxConcurrentRequestsPerPeer) {
        void responseAction
          .send(null, peerId, {
            r: parsed[0],
            e: 'too many concurrent requests'
          })
          .catch(noOp)
        return
      }

      const controller = new AbortController()
      if (!peerControllers) {
        peerControllers = new Set()
        activeRequestControllers.set(peerId, peerControllers)
      }
      peerControllers.add(controller)

      const runHandler = async (): Promise<R> => {
        if (
          hasRoleGuard &&
          (!deps.authorizePeerAction ||
            deps.authorizePeerAction(peerId, requiredRoles) !== true)
        ) {
          throw mkErr(`${insufficientAuthPrefix} for request`)
        }
        const [, userMeta] = extractAuthMetadata(parsed[1])
        const handler = getRequestGate()
        if (!handler) {
          throw mkErr('no active request handler')
        }
        const response = await handler(payload, {
          ...buildPeerContext(peerId, userMeta),
          signal: controller.signal
        })
        if (response === undefined) {
          throw mkErr('request handler returned undefined')
        }
        return response
      }

      void runHandler()
        .then(
          response =>
            responseAction.send(response as DataPayload, peerId, {
              r: parsed[0]
            }),
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

    const requestToResolvedPeer = async (
      data: T,
      resolvedTarget: string,
      displayTarget: string,
      options: Omit<RequestOptions, 'target'>
    ): Promise<R> => {
      const {metadata, onProgress, signal, timeoutMs} = options
      const checkReqPeer = (): void => {
        throwIfAborted(signal)
        if (!hasActivePeer(resolvedTarget)) {
          throw makeActionError('disconnected', noActivePeerMsg(displayTarget))
        }
      }
      checkReqPeer()

      const innerMeta = hasRoleGuard
        ? await prepareSendMeta(metadata)
        : metadata
      if (hasRoleGuard) {
        checkReqPeer()
      }

      const requestId = crypto.randomUUID()
      const controller = new AbortController()
      const responsePromise = new Promise<DataPayload>((resolve, reject) => {
        const waiter: PendingRequestWaiter = {
          controller,
          getReceive: getReceiveGate,
          emitReceiveProgress: emitProgress,
          peerId: resolvedTarget,
          resolve,
          reject,
          timer: null,
          signal,
          abortHandler: undefined
        }

        if (signal) {
          const rejectAsAborted = (): void => {
            clearPendingRequestWaiter(requestId)
            reject(makeActionError('aborted', operationAbortedMsg))
          }
          if (signal.aborted) {
            rejectAsAborted()
            return
          }
          waiter.abortHandler = rejectAsAborted
          signal.addEventListener('abort', rejectAsAborted, {once: true})
        }

        pendingRequestWaiters[requestId] = waiter
        if (timeoutMs !== undefined) {
          const timer = setTimeout(() => {
            clearPendingRequestWaiter(requestId)
            waiter.reject(makeActionError('timeout', 'request timed out'))
          }, timeoutMs)
          unrefTimer(timer)
          waiter.timer = timer
        }
      })

      try {
        const sending = rawAction.send(
          data,
          resolvedTarget,
          innerMeta === undefined
            ? {r: requestId}
            : {r: requestId, m: innerMeta},
          toProgressBridge(onProgress, metadata),
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

    const requestOne = (data: T, options: RequestOptions): Promise<R> => {
      const {target, ...rest} = options
      return requestToResolvedPeer(data, resolveReqPeer(target), target, rest)
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
                  value: await requestToResolvedPeer(
                    data,
                    resolvedTarget,
                    target,
                    requestOptions
                  )
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

    publicActions[type] = {
      kind,
      requiredRoles,
      action: lockedAction,
      internal,
      clear: () => {
        clearRequestGate()
        clearReceiveGate()
        clearProgress()
      }
    }
    return lockedAction
  }

  return {
    makeAction: ((
      type: string,
      config?: MessageActionConfig | RequestActionConfig
    ) => makeActionCore(type, config, false)) as Room['makeAction'],
    makeInternalAction,
    makeInternalRequestAction: <
      T extends DataPayload = DataPayload,
      R extends DataPayload = DataPayload
    >(
      type: string
    ): RequestAction<T, R> => {
      const wireType = type.startsWith(internalActionPrefix)
        ? type
        : `${internalActionPrefix}${type}`
      return makeActionCore<T, R>(
        wireType,
        {kind: 'request'},
        true
      ) as RequestAction<T, R>
    },
    handleData,
    clearPeer,
    clearListeners: () => {
      values(publicActions).forEach(entry => {
        if (!entry.internal) {
          entry.clear()
        }
      })
    }
  }
}
