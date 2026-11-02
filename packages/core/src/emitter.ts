import {libName, mkErr} from './primitives'
import type {ListenerOptions, ReplayListenerOptions, Unsubscribe} from './types'

const noOp = (): void => {}

const logHandlerErr = (kind: string, err: unknown): void =>
  console.error(`${libName} ${kind} error:`, err)

export const lockMethods = <T extends object>(
  target: T,
  methodNames: readonly (keyof T & string)[]
): T => {
  for (const name of methodNames) {
    const fn = target[name]
    Object.defineProperty(target, name, {
      get: () => fn,
      set: () => {
        throw new TypeError(
          `${libName}: ${name} is a method; call ${name}(handler), which returns an unsubscribe function`
        )
      },
      enumerable: true,
      configurable: true
    })
  }
  return target
}

export type EventEmitter<Args extends unknown[]> = {
  subscribe: (
    handler: (...args: Args) => unknown,
    options?: ReplayListenerOptions,
    getReplayItems?: () => Iterable<Args>
  ) => Unsubscribe
  emit: (...args: Args) => void
  hasListeners: () => boolean
  clear: () => void
}

export const createEventEmitter = <Args extends unknown[]>(
  kind: string,
  onActiveChange?: (active: boolean) => void
): EventEmitter<Args> => {
  const subs = new Set<{
    call: (...args: Args) => void
    unsub: () => void
  }>()

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

  const subscribe = (
    handler: (...args: Args) => unknown,
    options?: ReplayListenerOptions,
    getReplayItems?: () => Iterable<Args>
  ): Unsubscribe => {
    if (typeof handler !== 'function') {
      const label = kind.endsWith('handler') ? kind : `${kind} handler`
      throw mkErr(`${label} must be a function`)
    }
    const signal = options?.signal
    if (signal?.aborted) {
      return noOp
    }
    const once = Boolean(options?.once)
    let active = true
    let added = false
    const entry = {
      call: (...args: Args): void => {
        if (!active) {
          return
        }
        if (once) {
          unsub()
        }
        invoke(handler, args)
      },
      unsub: noOp
    }
    const unsub: Unsubscribe = () => {
      if (!active) {
        return
      }
      active = false
      signal?.removeEventListener('abort', unsub)
      if (added && subs.delete(entry) && subs.size === 0) {
        onActiveChange?.(false)
      }
    }
    entry.unsub = unsub
    signal?.addEventListener('abort', unsub, {once: true})

    if (options?.replay && getReplayItems) {
      for (const item of getReplayItems()) {
        if (!active) {
          break
        }
        if (once) {
          unsub()
        }
        invoke(handler, item)
      }
    }

    if (active) {
      const wasEmpty = subs.size === 0
      added = true
      subs.add(entry)
      if (wasEmpty) {
        onActiveChange?.(true)
      }
    }

    return unsub
  }

  return {
    subscribe,
    emit: (...args: Args): void => {
      for (const sub of Array.from(subs)) {
        sub.call(...args)
      }
    },
    hasListeners: (): boolean => subs.size > 0,
    clear: (): void => {
      for (const sub of Array.from(subs)) {
        sub.unsub()
      }
    }
  }
}

export type SingleHandler<F extends (...args: any[]) => any> = {
  set: (handler: F, options?: ListenerOptions) => Unsubscribe
  get: () => F | null
  clear: () => void
}

export const createSingleHandler = <F extends (...args: any[]) => any>(
  name: string,
  onChange?: (handler: F | null) => void
): SingleHandler<F> => {
  let current: {call: F; unsub: () => void} | null = null

  const set = (handler: F, options?: ListenerOptions): Unsubscribe => {
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
    let active = true
    const unsub: Unsubscribe = () => {
      if (!active) {
        return
      }
      active = false
      signal?.removeEventListener('abort', unsub)
      if (current === entry) {
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
      return handler(...args)
    }) as F
    const entry = {call, unsub}
    current = entry
    signal?.addEventListener('abort', unsub, {once: true})
    onChange?.(call)
    return unsub
  }

  return {
    set,
    get: (): F | null => current?.call ?? null,
    clear: (): void => current?.unsub()
  }
}
