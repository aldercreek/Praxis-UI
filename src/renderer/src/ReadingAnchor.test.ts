import { describe, expect, it, vi } from 'vitest'
import { ReadingAnchor } from './ReadingAnchor'

function readingView() {
  const scroll = vi.fn()
  const container = { get scrollTop() { return 120 }, set scrollTop(value: number) { scroll(value) } } as HTMLDivElement
  const props = { container: { current: container }, following: { current: false }, children: null }
  return { scroll, container, props, view: new ReadingAnchor(props) }
}

describe('reading position compensation', () => {
  it('does not measure child nodes in offscreen turns', () => {
    const paragraph = { getBoundingClientRect: () => ({ top: 80, bottom: 100, height: 20 }), closest: () => null }
    const offscreen = { getBoundingClientRect: () => ({ top: -1000, bottom: -100, height: 900 }), querySelectorAll: vi.fn(() => []) }
    const onscreen = { getBoundingClientRect: () => ({ top: 10, bottom: 500, height: 490 }), querySelectorAll: vi.fn(() => [paragraph]) }
    const container = { getBoundingClientRect: () => ({ top: 0, bottom: 400 }), querySelectorAll: () => [offscreen, onscreen] } as unknown as HTMLDivElement
    const view = new ReadingAnchor({ container: { current: container }, following: { current: false }, children: null })
    expect(view.getSnapshotBeforeUpdate()?.element).toBe(paragraph)
    expect(offscreen.querySelectorAll).not.toHaveBeenCalled()
    expect(onscreen.querySelectorAll).toHaveBeenCalledOnce()
  })

  it('does not cancel smooth navigation by writing an unchanged scroll offset on an ordinary render', () => {
    const { view, props, container, scroll } = readingView()
    const element = { isConnected: true, parentElement: container, getBoundingClientRect: () => ({ top: 60, height: 20 }) } as unknown as Element
    view.componentDidUpdate(props, {}, { element, top: 60, turn: null })
    expect(scroll).not.toHaveBeenCalled()
  })

  it('anchors on the row the user just pressed while it remains visible', () => {
    const viewport = { top: 0, bottom: 400, height: 400 }
    const first = { getBoundingClientRect: () => ({ top: 10, bottom: 30, height: 20 }), closest: () => null }
    const pressed = { isConnected: true, getBoundingClientRect: () => ({ top: 200, bottom: 228, height: 28 }), closest: () => null }
    const container = { getBoundingClientRect: () => viewport, querySelectorAll: () => [first], contains: (node: unknown) => node === pressed } as unknown as HTMLDivElement
    const view = new ReadingAnchor({ container: { current: container }, following: { current: false }, pinned: { current: pressed as unknown as Element }, children: null })
    expect(view.getSnapshotBeforeUpdate()?.element).toBe(pressed)
  })

  it('compensates actual content movement while preserving automatic following', () => {
    const { view, props, container, scroll } = readingView()
    const element = { isConnected: true, parentElement: container, getBoundingClientRect: () => ({ top: 20, height: 20 }) } as unknown as Element
    view.componentDidUpdate(props, {}, { element, top: 60, turn: null })
    expect(scroll).toHaveBeenCalledExactlyOnceWith(80)
    props.following.current = true
    view.componentDidUpdate(props, {}, { element, top: 60, turn: null })
    expect(scroll).toHaveBeenCalledTimes(1)
  })
})
