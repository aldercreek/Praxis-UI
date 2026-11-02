import { afterEach, describe, expect, it, vi } from 'vitest'
import { trackScrollActivity } from './scrollActivity'

function fakeElement() {
  const attributes = new Set<string>()
  return {
    attributes,
    hasAttribute: (name: string) => attributes.has(name),
    setAttribute: (name: string) => { attributes.add(name) },
    removeAttribute: (name: string) => { attributes.delete(name) }
  }
}

function fakeDocument() {
  let listener: ((event: Event) => void) | undefined
  return {
    addEventListener: (_type: string, handler: (event: Event) => void) => { listener = handler },
    removeEventListener: () => { listener = undefined },
    scroll: (target: unknown) => listener?.({ target } as unknown as Event),
    get listening() { return Boolean(listener) }
  }
}

afterEach(() => vi.useRealTimers())

describe('scroll activity', () => {
  it('marks a scrolling element and clears it after scrolling stops', () => {
    vi.useFakeTimers()
    const document = fakeDocument()
    const element = fakeElement()
    const stop = trackScrollActivity(document as unknown as Document, 900)
    document.scroll(element)
    expect(element.attributes.has('data-scrolling')).toBe(true)
    vi.advanceTimersByTime(600)
    document.scroll(element)
    vi.advanceTimersByTime(600)
    expect(element.attributes.has('data-scrolling')).toBe(true)
    vi.advanceTimersByTime(400)
    expect(element.attributes.has('data-scrolling')).toBe(false)
    document.scroll(element)
    stop()
    expect(element.attributes.has('data-scrolling')).toBe(false)
    expect(document.listening).toBe(false)
  })

  it('ignores scroll events whose target is not an element', () => {
    const document = fakeDocument()
    trackScrollActivity(document as unknown as Document)
    expect(() => document.scroll({})).not.toThrow()
  })
})
