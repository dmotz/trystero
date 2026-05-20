import {
  all,
  entries,
  genId,
  libName,
  mkErr,
  resetTimer,
  toError,
  toErrorMessage
} from './utils'
import {
  createActionWireManager,
  type ActionOptions,
  type InternalAction,
  type InternalActionSender
} from './action-wire'
import type {
  ActionProgressHandler,
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
  SendOptions
} from './types'

const requestHandlerBufferMs = 500

export type {ActionOptions, InternalAction, InternalActionSender}

type PublicActionKind = 'message' | 'request'

type PublicActionState = {
  kind: PublicActionKind
  action: MessageAction | RequestAction
  pendingMessages: PendingActionPayload[]
  pendingRequests: PendingIncomingRequest[]
  onReceiveProgress: ActionProgressHandler | null
}

type PendingActionPayload = {
  payload: DataPayload
  peerId: string
  metadata?: JsonValue
}

type PendingIncomingRequest = PendingActionPayload & {
  requestId: string
  timer: ReturnType<typeof setTimeout>
  controller: AbortController
}

type PendingRequestWaiter = {
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

export type ActionErrorKind =
  | 'timeout'
  | 'disconnected'
  | 'aborted'
  | 'rejected'

type ActionError = Error & {
  kind?: ActionErrorKind
}

type ActionManagerDeps = {
  getPeer: (id: string, includePending: boolean) => PeerHandle | undefined
  getPeerIds: (includePending: boolean) => string[]
  canReceiveFromPeer: (id: string, receiveWhilePending: boolean) => boolean
}

const makeActionError = (
  kind: ActionErrorKind,
  message: string
): ActionError => {
  const error = mkErr(message) as ActionError
  error.kind = kind
  error.name = kind === 'aborted' ? 'AbortError' : error.name
  return error
}

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw makeActionError('aborted', 'operation aborted')
  }
}

const getRequestMetadata = (metadata?: JsonValue): RequestMetadata | null => {
  if (
    metadata &&
    typeof metadata === 'object' &&
    !Array.isArray(metadata) &&
    typeof (metadata as {r?: unknown}).r === 'string'
  ) {
    return {
      r: (metadata as {r: string}).r,
      ...(Object.hasOwn(metadata as object, 'm')
        ? {m: (metadata as {m?: JsonValue}).m}
        : {})
    }
  }

  return null
}

const getResponseMetadata = (metadata?: JsonValue): ResponseMetadata | null => {
  if (
    metadata &&
    typeof metadata === 'object' &&
    !Array.isArray(metadata) &&
    typeof (metadata as {r?: unknown}).r === 'string'
  ) {
    return {
      r: (metadata as {r: string}).r,
      ...(typeof (metadata as {e?: unknown}).e === 'string'
        ? {e: (metadata as {e: string}).e}
        : {})
    }
  }

  return null
}

const withMetadata = <T extends {peerId: string}>(
  context: T,
  metadata?: JsonValue
): T & {metadata?: JsonValue} =>
  metadata === undefined ? context : {...context, metadata}

export const createActionManager = ({
  getPeer,
  getPeerIds,
  canReceiveFromPeer
}: ActionManagerDeps): {
  makeAction: Room['makeAction']
  makeInternalAction: <T extends DataPayload = DataPayload>(
    type: string,
    options?: Partial<ActionOptions>
  ) => InternalAction<T>
  handleData: (id: string, data: ArrayBuffer) => void
  clearPeer: (id: string, error: Error) => void
} => {
  const publicActions: Record<string, PublicActionState> = {}
  const pendingRequestWaiters: Record<string, PendingRequestWaiter> = {}
  const wire = createActionWireManager({
    getPeer,
    getPeerIds,
    canReceiveFromPeer,
    throwIfAborted
  })
  const makeInternalAction = wire.makeInternalAction
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
    rejectPendingRequestsForPeer(
      id,
      makeActionError(
        'disconnected',
        toErrorMessage(error, 'peer disconnected')
      )
    )
  }

  const responseAction = makeInternalAction<DataPayload>('@_response')

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
    const rawAction = makeInternalAction<T>(type)
    const existingState = publicActions[type]

    if (existingState) {
      if (existingState.kind !== kind) {
        throw mkErr(`action type "${type}" cannot be redefined`)
      }

      return existingState.action as MessageAction<T> | RequestAction<T, R>
    }

    const state: PublicActionState = {
      kind,
      action: null as unknown as MessageAction | RequestAction,
      pendingMessages: [],
      pendingRequests: [],
      onReceiveProgress: config?.onReceiveProgress ?? null
    }

    const toProgressHandler = (
      handler?: ActionProgressHandler,
      metadata?: JsonValue
    ) =>
      handler
        ? (progress: number, peerId: string) =>
            handler(progress, withMetadata({peerId}, metadata))
        : undefined

    const setReceiveProgress = (
      handler: ActionProgressHandler | null
    ): void => {
      state.onReceiveProgress = handler
    }

    const dispatchReceiveProgress = (
      progress: number,
      peerId: string,
      metadata?: JsonValue
    ): void => {
      const requestMetadata =
        state.kind === 'request' ? getRequestMetadata(metadata) : null

      state.onReceiveProgress?.(
        progress,
        withMetadata({peerId}, requestMetadata ? requestMetadata.m : metadata)
      )
    }

    rawAction.onProgress(dispatchReceiveProgress)

    if (kind === 'message') {
      let onMessage =
        (config as MessageActionConfig<T> | undefined)?.onMessage ?? null

      const flushMessages = (): void => {
        if (!onMessage) {
          return
        }

        const handler = onMessage

        state.pendingMessages
          .splice(0)
          .forEach(({payload, peerId, metadata}) => {
            void Promise.resolve()
              .then(() =>
                handler(payload as T, withMetadata({peerId}, metadata))
              )
              .catch(err =>
                console.error(`${libName} action handler error:`, err)
              )
          })
      }

      const action = {
        send: async (data: T, options: SendOptions = {}) => {
          await rawAction.send(
            data,
            options.target,
            options.metadata,
            toProgressHandler(options.onProgress, options.metadata),
            options.signal
          )
        },

        get onMessage() {
          return onMessage
        },

        set onMessage(handler) {
          onMessage = handler
          flushMessages()
        },

        get onReceiveProgress() {
          return state.onReceiveProgress
        },

        set onReceiveProgress(handler) {
          setReceiveProgress(handler)
        }
      } satisfies MessageAction<T>

      rawAction.onMessage((payload, peerId, metadata) => {
        if (!onMessage) {
          state.pendingMessages.push(
            metadata === undefined
              ? {payload, peerId}
              : {payload, peerId, metadata}
          )
          return
        }

        const handler = onMessage

        void Promise.resolve()
          .then(() => handler(payload as T, withMetadata({peerId}, metadata)))
          .catch(err => console.error(`${libName} action handler error:`, err))
      })

      state.action = action as MessageAction
      publicActions[type] = state
      flushMessages()

      return action
    }

    let onRequest =
      (config as RequestActionConfig<T, R> | undefined)?.onRequest ?? null

    const removePendingIncomingRequest = (
      request: PendingIncomingRequest
    ): void => {
      resetTimer(request.timer)

      const i = state.pendingRequests.indexOf(request)

      if (i > -1) {
        state.pendingRequests.splice(i, 1)
      }
    }

    const sendRequestError = (
      peerId: string,
      requestId: string,
      error: unknown
    ): void => {
      void responseAction.send(null, peerId, {
        r: requestId,
        e: toErrorMessage(error, 'request failed')
      })
    }

    const respondToIncomingRequest = (
      request: PendingIncomingRequest,
      handler: NonNullable<typeof onRequest>
    ): void => {
      removePendingIncomingRequest(request)

      void Promise.resolve()
        .then(() =>
          handler(request.payload as T, {
            peerId: request.peerId,
            ...(request.metadata === undefined
              ? {}
              : {metadata: request.metadata}),
            signal: request.controller.signal
          })
        )
        .then(async response => {
          if (response === undefined) {
            throw mkErr('request handler returned undefined')
          }

          await responseAction.send(response, request.peerId, {
            r: request.requestId
          })
        })
        .catch(err => sendRequestError(request.peerId, request.requestId, err))
        .finally(() => request.controller.abort())
    }

    const flushRequests = (): void => {
      if (!onRequest) {
        return
      }

      state.pendingRequests
        .slice()
        .forEach(request => respondToIncomingRequest(request, onRequest!))
    }

    const queueIncomingRequest = (
      payload: DataPayload,
      peerId: string,
      metadata: JsonValue | undefined,
      requestId: string
    ): void => {
      if (onRequest) {
        const request: PendingIncomingRequest = {
          payload,
          peerId,
          ...(metadata === undefined ? {} : {metadata}),
          requestId,
          controller: new AbortController(),
          timer: null as unknown as ReturnType<typeof setTimeout>
        }

        respondToIncomingRequest(request, onRequest)
        return
      }

      const request: PendingIncomingRequest = {
        payload,
        peerId,
        ...(metadata === undefined ? {} : {metadata}),
        requestId,
        controller: new AbortController(),
        timer: setTimeout(() => {
          removePendingIncomingRequest(request)
          request.controller.abort()
          sendRequestError(peerId, requestId, 'request handler unavailable')
        }, requestHandlerBufferMs)
      }

      state.pendingRequests.push(request)
    }

    const requestOne = async (data: T, options: RequestOptions): Promise<R> => {
      const {target, metadata, onProgress, signal, timeoutMs} = options

      throwIfAborted(signal)

      if (!getPeer(target, false)) {
        throw makeActionError(
          'disconnected',
          `no active peer with id ${target}`
        )
      }

      const requestId = genId(20)
      const responsePromise = new Promise<DataPayload>((resolve, reject) => {
        const waiter: PendingRequestWaiter = {
          peerId: target,
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
      })
      const handledResponsePromise = responsePromise.catch(err => {
        throw err
      })

      try {
        await rawAction.send(
          data,
          target,
          metadata === undefined ? {r: requestId} : {r: requestId, m: metadata},
          toProgressHandler(onProgress, metadata),
          signal
        )

        const waiter = pendingRequestWaiters[requestId]

        if (waiter && timeoutMs !== undefined) {
          waiter.timer = setTimeout(() => {
            clearPendingRequestWaiter(requestId)
            waiter.reject(makeActionError('timeout', 'request timed out'))
          }, timeoutMs)
        }

        return (await handledResponsePromise) as R
      } catch (err) {
        clearPendingRequestWaiter(requestId)
        throw err
      }
    }

    const action = {
      request: requestOne,

      requestMany: async (data: T, options: RequestManyOptions<R>) => {
        throwIfAborted(options.signal)

        const results = await all(
          options.targets.map(async target => {
            try {
              const value = await requestOne(data, {
                target,
                ...(options.metadata === undefined
                  ? {}
                  : {metadata: options.metadata}),
                ...(options.timeoutMs === undefined
                  ? {}
                  : {timeoutMs: options.timeoutMs}),
                ...(options.onProgress === undefined
                  ? {}
                  : {onProgress: options.onProgress}),
                ...(options.signal === undefined
                  ? {}
                  : {signal: options.signal})
              })
              const result = {
                peerId: target,
                status: 'fulfilled',
                value
              } satisfies PeerResult<R>
              options.onResult?.(result)
              return result
            } catch (err) {
              const error = toError(err, 'request failed') as ActionError

              if (error.kind === 'aborted' || !error.kind) {
                throw error
              }

              const result =
                error.kind === 'timeout'
                  ? ({peerId: target, status: 'timeout'} as PeerResult<R>)
                  : error.kind === 'disconnected'
                    ? ({
                        peerId: target,
                        status: 'disconnected'
                      } as PeerResult<R>)
                    : ({
                        peerId: target,
                        status: 'rejected',
                        error
                      } as PeerResult<R>)

              options.onResult?.(result)
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
        flushRequests()
      },

      get onReceiveProgress() {
        return state.onReceiveProgress
      },

      set onReceiveProgress(handler) {
        setReceiveProgress(handler)
      }
    } satisfies RequestAction<T, R>

    rawAction.onMessage((payload, peerId, metadata) => {
      const requestMetadata = getRequestMetadata(metadata)

      if (!requestMetadata) {
        return
      }

      queueIncomingRequest(
        payload,
        peerId,
        requestMetadata.m,
        requestMetadata.r
      )
    })

    state.action = action as unknown as RequestAction
    publicActions[type] = state
    flushRequests()

    return action
  }

  return {
    makeAction: makeActionImpl as Room['makeAction'],
    makeInternalAction,
    handleData,
    clearPeer
  }
}
