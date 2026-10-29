import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Quote } from './icons'
import { createTextQuote, positionQuote, type QuoteAnchor, type QuoteSource, type TextQuote } from './quote'

export type { TextQuote } from './quote'

interface QuoteSelectionProps {
  rootRef: RefObject<HTMLDivElement | null>
  sessionKey: string
  onQuote: (quote: TextQuote) => void
}

interface Candidate {
  quote: TextQuote
  source: Element
  anchor: QuoteAnchor
  sessionKey: string
}

interface RangeIdentity {
  start: Node
  startOffset: number
  end: Node
  endOffset: number
  text: string
}

function rangeIdentity(selection: Selection | null): RangeIdentity | null {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null
  const range = selection.getRangeAt(0)
  return { start: range.startContainer, startOffset: range.startOffset, end: range.endContainer, endOffset: range.endOffset, text: selection.toString() }
}

function sameRange(first: RangeIdentity | null, second: RangeIdentity | null): boolean {
  return Boolean(first && second && first.start === second.start && first.startOffset === second.startOffset && first.end === second.end && first.endOffset === second.endOffset && first.text === second.text)
}

function sourceAt(root: HTMLElement, node: Node): (QuoteSource & { element: Element }) | null {
  const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement
  if (!element || !root.contains(element) || element.closest('button, input, textarea, [contenteditable="true"]')) return null
  const body = element.closest('.markdown')
  const source = body?.closest('[data-quote-message-id]')
  const messageId = source?.getAttribute('data-quote-message-id')
  return source && messageId && root.contains(source) ? { element: source, messageId } : null
}

export function QuoteSelection({ rootRef, sessionKey, onQuote }: QuoteSelectionProps) {
  const [candidate, setCandidate] = useState<Candidate | null>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const dismissRef = useRef<() => void>(() => {})

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    let frame = 0
    let dragging = false
    let dismissedRange: RangeIdentity | null = null

    const dismiss = () => {
      cancelAnimationFrame(frame)
      frame = 0
      dismissedRange = rangeIdentity(document.getSelection())
      setCandidate(null)
      setPosition(null)
    }
    dismissRef.current = dismiss
    dismiss()

    const update = () => {
      frame = 0
      const selection = document.getSelection()
      const identity = rangeIdentity(selection)
      if (!selection || !identity) {
        dismissedRange = null
        setCandidate(null)
        return
      }
      if (sameRange(identity, dismissedRange)) {
        setCandidate(null)
        return
      }
      const range = selection.getRangeAt(0)
      const start = sourceAt(root, range.startContainer)
      const end = sourceAt(root, range.endContainer)
      const quote = createTextQuote(identity.text, start, end)
      if (!quote || !start) { setCandidate(null); return }

      const bounds = root.getBoundingClientRect()
      const visible = { left: Math.max(0, bounds.left), right: Math.min(window.innerWidth, bounds.right), top: Math.max(0, bounds.top), bottom: Math.min(window.innerHeight, bounds.bottom) }
      const rectangles = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0 && rect.right > visible.left && rect.left < visible.right && rect.bottom > visible.top && rect.top < visible.bottom)
      const backwards = selection.focusNode === range.startContainer && selection.focusOffset === range.startOffset
      const rect = backwards ? rectangles[0] : rectangles.at(-1)
      if (!rect) { setCandidate(null); return }
      const anchor = { left: Math.max(rect.left, visible.left), right: Math.min(rect.right, visible.right), top: Math.max(rect.top, visible.top), bottom: Math.min(rect.bottom, visible.bottom) }
      dismissedRange = null
      setPosition(null)
      setCandidate({ quote, source: start.element, anchor, sessionKey })
    }
    const schedule = () => {
      if (dragging || (document.activeElement && popupRef.current?.contains(document.activeElement))) return
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(update)
    }
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && popupRef.current?.contains(event.target)) return
      dismiss()
      dragging = event.button === 0 && event.target instanceof Node && Boolean(sourceAt(root, event.target))
      if (dragging) dismissedRange = null
    }
    const onPointerUp = () => {
      if (!dragging) return
      dragging = false
      schedule()
    }
    const onPointerCancel = () => { dragging = false; dismiss() }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { dismiss(); return }
      const popup = popupRef.current
      // Keep keyboard selection usable without moving focus while the user is still selecting.
      if (event.key === 'Tab' && !event.defaultPrevented && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && popup && !(event.target instanceof Node && popup.contains(event.target))) {
        event.preventDefault()
        popup.querySelector('button')?.focus({ preventScroll: true })
      }
    }
    const onFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !root.contains(event.target) && !popupRef.current?.contains(event.target)) dismiss()
    }
    const onScroll = (event: Event) => {
      const selection = document.getSelection()
      // A tool may keep scrolling its output while the user selects an older
      // answer. Only movement of the selected text invalidates the popup anchor.
      if (event.target === document || event.target === window
        || event.target instanceof Element && (Boolean(selection?.anchorNode && event.target.contains(selection.anchorNode))
          || Boolean(selection?.focusNode && event.target.contains(selection.focusNode)))) dismiss()
    }
    const onVisibility = () => { if (document.hidden) onPointerCancel() }

    document.addEventListener('selectionchange', schedule)
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('pointerup', onPointerUp)
    document.addEventListener('pointercancel', onPointerCancel)
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('focusin', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', dismiss)
    window.addEventListener('blur', onPointerCancel)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('selectionchange', schedule)
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('pointerup', onPointerUp)
      document.removeEventListener('pointercancel', onPointerCancel)
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('focusin', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('blur', onPointerCancel)
      dismissRef.current = () => {}
    }
  }, [rootRef, sessionKey])

  useLayoutEffect(() => {
    if (!candidate || candidate.sessionKey !== sessionKey || !popupRef.current) return
    const popup = popupRef.current.getBoundingClientRect()
    setPosition(positionQuote(candidate.anchor, popup, { width: window.innerWidth, height: window.innerHeight }))
  }, [candidate, sessionKey])

  if (!candidate || candidate.sessionKey !== sessionKey) return null
  return createPortal(<div ref={popupRef} className="quote-selection" style={{ position: 'fixed', left: position?.left, top: position?.top, visibility: position ? undefined : 'hidden' }}>
    <button type="button" className="quote-selection-button" aria-label="Quote selected text" onMouseDown={event => event.preventDefault()} onClick={() => {
      if (!candidate.source.isConnected || !rootRef.current?.contains(candidate.source)) { dismissRef.current(); return }
      const quote = candidate.quote
      dismissRef.current()
      document.getSelection()?.removeAllRanges()
      onQuote(quote)
    }}><Quote size={12} aria-hidden="true" />Quote</button>
  </div>, document.body)
}
