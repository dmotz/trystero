import {libName, mkErr, unreachable} from './primitives'
import type {ListenerOptions, ReplayListenerOptions, Unsubscribe} from './types'

const noOp = (): void => {}

const logHandlerErr = (kind: string, err: unknown): void =>
  console.error(`${libName} ${kind} error:`, err)

type SubEntry<Args extends unknown[]> = readonly [
  call: (...args: Args) => void,
  unsub: () => void
]

type SingleSubEntry<F extends (...args: never[]) => unknown> = readonly [
  call: F,
  unsub: () => void
]

type SubscriptionState<Entry> =
  | {
      readonly phase: 'replaying'
      readonly epoch: number
      readonly abortCleanup: AbortController | null
    }
  | {
      readonly phase: 'live'
      readonly entry: Entry
      readonly abortCleanup: AbortController | null
    }
  | {readonly phase: 'closed'}

type EventEmitter<Args extends unknown[]> = readonly [
  subscribe: (
    handler: (...args: Args) => unknown,
    options?: ReplayListenerOptions,
    getReplayItems?: () => Iterable<Args>
  ) => Unsubscribe,
  emit: (...args: Args) => void,
  clear: () => void,
  hasListeners: () => boolean
]

export const createEventEmitter = <Args extends unknown[]>(
  kind: string,
  onActiveChange?: (active: boolean) => void
): EventEmitter<Args> => {
  const subs = new Set<SubEntry<Args>>()
  let clearEpoch = 0

  const invoke = (handler: (...args: Args) => unknown, args: Args): void => {
    try {
      const res = handler(...args)
      if (res && typeof (res as PromiseLike<unknown>).then === 'function') {
        void Promise.resolve(res).catch(err => logHandlerErr(kind, err))
      }
    } catch (err) {
      logHandlerErr(kind, err)
    }
  }

  return [
    (handler, options, getReplayItems) => {
      if (typeof handler !== 'function') {
        throw mkErr(
          `${kind.endsWith('handler') ? kind : `${kind} handler`} must be a function`
        )
      }
      const signal = options?.signal
      if (signal?.aborted) {
        return noOp
      }
      const once = Boolean(options?.once)
      const abortCleanup = signal ? new AbortController() : null
      let state: SubscriptionState<SubEntry<Args>>

      const unsub: Unsubscribe = () => {
        switch (state.phase) {
          case 'closed':
            return
          case 'replaying': {
            const cleanup = state.abortCleanup
            state = {phase: 'closed'}
            cleanup?.abort()
            return
          }
          case 'live': {
            const {entry: liveEntry, abortCleanup: cleanup} = state
            state = {phase: 'closed'}
            cleanup?.abort()
            if (subs.delete(liveEntry) && subs.size === 0) {
              onActiveChange?.(false)
            }
            return
          }
          default:
            unreachable(state)
        }
      }

      const entry: SubEntry<Args> = [
        (...args: Args): void => {
          if (state.phase !== 'live') {
            return
          }
          if (once) {
            unsub()
          }
          invoke(handler, args)
        },
        unsub
      ]

      const activateAfterReplay = (): void => {
        switch (state.phase) {
          case 'replaying': {
            if (state.epoch !== clearEpoch) {
              unsub()
              return
            }
            const wasEmpty = subs.size === 0
            state = {
              phase: 'live',
              entry,
              abortCleanup: state.abortCleanup
            }
            subs.add(entry)
            if (wasEmpty) {
              onActiveChange?.(true)
            }
            return
          }
          case 'live':
          case 'closed':
            return
          default:
            unreachable(state)
        }
      }

      state = {
        phase: 'replaying',
        epoch: clearEpoch,
        abortCleanup
      }

      if (abortCleanup && signal) {
        signal.addEventListener('abort', unsub, {
          once: true,
          signal: abortCleanup.signal
        })
      }

      if (options?.replay && getReplayItems) {
        const currentPhase = (): SubscriptionState<SubEntry<Args>> => state
        for (const item of getReplayItems()) {
          const cur = currentPhase()
          if (cur.phase !== 'replaying' || cur.epoch !== clearEpoch) {
            unsub()
            break
          }
          if (once) {
            unsub()
          }
          invoke(handler, item)
        }
      }

      activateAfterReplay()
      return unsub
    },
    (...args: Args): void => {
      for (const sub of Array.from(subs)) {
        sub[0](...args)
      }
    },
    (): void => {
      clearEpoch++
      for (const sub of Array.from(subs)) {
        sub[1]()
      }
    },
    (): boolean => subs.size > 0
  ]
}

type SingleHandlerTuple<F extends (...args: never[]) => unknown> = readonly [
  set: (handler: F, options?: ListenerOptions) => Unsubscribe,
  get: () => F | null,
  clear: () => void
]

export const initSingleHandler = <F extends (...args: never[]) => unknown>(
  name: string,
  onChange?: (handler: F | null) => void
): SingleHandlerTuple<F> => {
  let current: SingleSubEntry<F> | null = null

  return [
    (handler, options) => {
      if (typeof handler !== 'function') {
        throw mkErr(`${name} handler must be a function`)
      }
      const signal = options?.signal
      if (signal?.aborted) {
        return noOp
      }
      if (current) {
        throw mkErr(`${name} handler already registered; unsubscribe first`)
      }
      const once = Boolean(options?.once)
      const abortCleanup = signal ? new AbortController() : null
      let active = true

      const unsub: Unsubscribe = () => {
        if (!active) {
          return
        }
        active = false
        abortCleanup?.abort()
        if (current?.[1] === unsub) {
          current = null
          onChange?.(null)
        }
      }

      const call = ((...args: Parameters<F>): ReturnType<F> => {
        if (!active) {
          return undefined as ReturnType<F>
        }
        if (once) {
          unsub()
        }
        return handler(...args) as ReturnType<F>
      }) as F

      current = [call, unsub]

      if (abortCleanup && signal) {
        signal.addEventListener('abort', unsub, {
          once: true,
          signal: abortCleanup.signal
        })
      }
      onChange?.(call)
      return unsub
    },
    (): F | null => current?.[0] ?? null,
    (): void => current?.[1]()
  ]
}
