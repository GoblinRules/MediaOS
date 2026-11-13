// A tiny external store (no library): module-level state that React reads with useSyncExternalStore.
import { useSyncExternalStore } from 'react'

export interface Store<T> {
  get(): T
  set(next: T | ((prev: T) => T)): void
  subscribe(fn: () => void): () => void
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial
  const subs = new Set<() => void>()
  return {
    get: () => value,
    set(next) {
      const v = typeof next === 'function' ? (next as (prev: T) => T)(value) : next
      if (Object.is(v, value)) return
      value = v
      for (const fn of [...subs]) fn()
    },
    subscribe(fn) {
      subs.add(fn)
      return () => {
        subs.delete(fn)
      }
    },
  }
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get)
}
