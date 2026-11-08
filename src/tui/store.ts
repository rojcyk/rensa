import { useCallback, useRef, useSyncExternalStore } from 'react'

// All live UI state outside React lives in small external stores of this
// shape. No Ink or engine import; React only, for the hook.

export interface Store<S> {
  getState(): S
  /** Notifies subscribers only when `up` returns a different reference. */
  setState(up: (s: S) => S): void
  /** Returns the unsubscribe function. */
  subscribe(f: () => void): () => void
}

export function createStore<S>(initial: S): Store<S> {
  let state = initial
  const subs = new Set<() => void>()
  return {
    getState: () => state,
    setState: (up) => {
      const next = up(state)
      if (Object.is(next, state)) return
      state = next
      for (const f of [...subs]) f()
    },
    subscribe: (f) => {
      subs.add(f)
      return () => {
        subs.delete(f)
      }
    },
  }
}

/**
 * The selected slice of a store. Re-renders only when the selector's
 * result changes by `Object.is`, so selectors return values held in state,
 * never fresh objects or arrays. The selector may be an inline arrow: it
 * is read through a ref and never causes a resubscription.
 */
export function useStore<S, T>(store: Store<S>, selector: (s: S) => T): T {
  const selectorRef = useRef(selector)
  selectorRef.current = selector
  const getSnapshot = useCallback(() => selectorRef.current(store.getState()), [store])
  return useSyncExternalStore(store.subscribe, getSnapshot)
}
