import { Text } from 'ink'
import { render } from 'ink-testing-library'
import { createElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStore, type Store, useStore } from './store.js'

interface PaneState {
  status: string
  follow: boolean
}

const INITIAL: PaneState = { status: 'running', follow: true }

describe('notifying store subscribers', () => {
  it('notifies no listener and keeps the state when the updater returns the previous state', () => {
    const store = createStore<PaneState>(INITIAL)
    const listener = vi.fn()
    store.subscribe(listener)

    store.setState((prev) => prev)

    expect(listener).not.toHaveBeenCalled()
    expect(store.getState()).toBe(INITIAL)
  })

  it('notifies each listener once and stores the new object when the updater returns a new object', () => {
    const store = createStore<PaneState>(INITIAL)
    const first = vi.fn()
    const second = vi.fn()
    store.subscribe(first)
    store.subscribe(second)

    store.setState((prev) => ({ ...prev, status: 'paused' }))

    expect([first.mock.calls.length, second.mock.calls.length]).toEqual([1, 1])
    expect(store.getState()).toEqual({ status: 'paused', follow: true })
  })

  it('stops notifying a listener after it unsubscribed', () => {
    const store = createStore<PaneState>(INITIAL)
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    unsubscribe()
    store.setState((prev) => ({ ...prev, follow: false }))

    expect(listener).not.toHaveBeenCalled()
  })
})

/** Renders the selected status and counts its own renders. */
function StatusProbe(props: { store: Store<PaneState>; counter: { renders: number } }): ReactNode {
  props.counter.renders++
  const status = useStore(props.store, (s) => s.status)
  return createElement(Text, null, status)
}

describe('selecting from a store in a component', () => {
  let unmount: (() => void) | undefined

  afterEach(() => {
    unmount?.()
    unmount = undefined
  })

  /** Lets React commit what a store notification scheduled. */
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

  function mountStatusProbe(store: Store<PaneState>): {
    renders: () => number
    frame: () => string
  } {
    const counter = { renders: 0 }
    const view = render(createElement(StatusProbe, { store, counter }))
    unmount = view.unmount
    return { renders: () => counter.renders, frame: () => view.lastFrame() ?? '' }
  }

  it('does not re-render the component when a field outside its selector changes', async () => {
    const store = createStore<PaneState>(INITIAL)
    const probe = mountStatusProbe(store)
    await settle()
    const before = probe.renders()

    store.setState((prev) => ({ ...prev, follow: false }))
    await settle()

    expect(probe.renders()).toBe(before)
  })

  it('re-renders the component with the new value when the selected field changes', async () => {
    const store = createStore<PaneState>(INITIAL)
    const probe = mountStatusProbe(store)
    await settle()
    const before = probe.renders()

    store.setState((prev) => ({ ...prev, status: 'paused' }))
    await settle()

    expect({ renders: probe.renders() - before, frame: probe.frame() }).toEqual({
      renders: 1,
      frame: 'paused',
    })
  })
})
