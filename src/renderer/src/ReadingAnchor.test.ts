import { describe, expect, it, vi } from 'vitest'
import { ReadingAnchor } from './ReadingAnchor'

function readingView() {
  const scroll = vi.fn()
  const container = { get scrollTop() { return 120 }, set scrollTop(value: number) { scroll(value) } } as HTMLDivElement
  const props = { container: { current: container }, following: { current: false }, children: null }
  return { scroll, container, props, view: new ReadingAnchor(props) }
}

describe('reading position compensation', () => {
  it('does not cancel smooth navigation by writing an unchanged scroll offset on an ordinary render', () => {
    const { view, props, container, scroll } = readingView()
    const element = { isConnected: true, parentElement: container, getBoundingClientRect: () => ({ top: 60, height: 20 }) } as unknown as Element
    view.componentDidUpdate(props, {}, { element, top: 60, turn: null })
    expect(scroll).not.toHaveBeenCalled()
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
