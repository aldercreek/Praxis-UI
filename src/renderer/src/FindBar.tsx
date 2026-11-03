import { useCallback, useContext, useEffect, useImperativeHandle, useRef, useState, type Ref, type RefObject } from 'react'
import { ArrowDown, ArrowUp, X } from './icons'
import { collectText, findMatches, scrollToMatch, toRanges, type TextMatch } from './findInChat'
import { DisclosureRevealContext } from './Disclosure'
import './findBar.css'

export interface FindBarHandle { open(): void; next(backward?: boolean): void; close(): boolean }

function highlight(ranges: Range[], current: number) {
  if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') return
  CSS.highlights.set('praxis-find', new Highlight(...ranges))
  CSS.highlights.set('praxis-find-current', new Highlight(...(ranges[current] ? [ranges[current]] : [])))
}

function clearHighlights() {
  if (typeof CSS !== 'undefined' && CSS.highlights) {
    CSS.highlights.delete('praxis-find')
    CSS.highlights.delete('praxis-find-current')
  }
}

export function FindBar({ ref, scope, sessionKey, contentKey, onNavigate }: { ref: Ref<FindBarHandle>; scope: RefObject<HTMLElement | null>; sessionKey: string; contentKey: string; onNavigate: (range: Range) => void }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [result, setResult] = useState({ count: 0, index: 0, overflow: false })
  const input = useRef<HTMLInputElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const registry = useContext(DisclosureRevealContext)
  const current = useRef<{ matches: TextMatch[]; ranges: Range[]; index: number }>({ matches: [], ranges: [], index: 0 })
  const navigated = useRef(false)
  const queryTimer = useRef(0)
  const generation = useRef(0)
  const frames = useRef(new Set<number>())
  const revealed = useRef(new Set<string>())
  const latestQuery = useRef(query)
  latestQuery.current = query
  const roots = useCallback(() => [...(scope.current?.querySelectorAll<HTMLElement>('.transcript-content, .agent-panel-scroll') || [])], [scope])
  const search = useCallback((value: string, requested?: number) => {
    const collected = collectText(roots())
    const found = findMatches(collected.text, value, 1001)
    const matches = found.slice(0, 1000)
    const ranges = toRanges(matches, collected.segments)
    let index = requested ?? current.current.index
    if (requested === undefined && matches.length) {
      const old = current.current.ranges[current.current.index]
      const segment = old && collected.segments.find(segment => segment.node === old.startContainer)
      const position = segment && old ? segment.start + old.startOffset : current.current.matches[current.current.index]?.start ?? 0
      index = matches.reduce((nearest, match, next) => Math.abs(match.start - position) < Math.abs(matches[nearest].start - position) ? next : nearest, 0)
    }
    index = Math.max(0, Math.min(index, ranges.length - 1))
    current.current = { matches, ranges, index }
    setResult({ count: ranges.length, index, overflow: found.length > 1000 })
    highlight(ranges, index)
    return current.current
  }, [roots])

  const frame = useCallback(() => new Promise<void>(resolve => {
    const id = requestAnimationFrame(() => { frames.current.delete(id); resolve() })
    frames.current.add(id)
  }), [])

  const navigate = useCallback(async (backward = false) => {
    window.clearTimeout(queryTimer.current)
    const state = search(latestQuery.current)
    if (!state.ranges.length) return
    const index = navigated.current ? (state.index + (backward ? -1 : 1) + state.ranges.length) % state.ranges.length : backward ? state.ranges.length - 1 : state.index
    navigated.current = true
    const version = ++generation.current
    const range = state.ranges[index]
    current.current.index = index
    highlight(state.ranges, index)
    setResult(previous => ({ ...previous, index }))
    onNavigate(range)
    const ancestors: HTMLElement[] = []
    let element = range.startContainer.parentElement
    while (element && element !== scope.current) {
      if (element instanceof HTMLDetailsElement && !element.open || element.hidden && element.dataset.processController) ancestors.push(element)
      element = element.parentElement
    }
    for (const element of ancestors.reverse()) {
      const key = element.dataset.disclosureKey || element.dataset.processController
      if (key && registry?.has(key)) { registry.get(key)!(); revealed.current.add(key) }
      else if (element instanceof HTMLDetailsElement) element.open = true
    }
    await frame()
    await frame()
    if (version !== generation.current) return
    const updated = search(latestQuery.current, index)
    const match = updated.ranges[updated.index]
    const target = match?.startContainer.parentElement
    if (match) scrollToMatch(match)
    const turn = target?.closest('.transcript-turn')
    if (turn && getComputedStyle(turn).contentVisibility === 'auto') {
      await frame()
      if (version === generation.current && target?.isConnected && match) scrollToMatch(match)
    }
  }, [frame, onNavigate, registry, scope, search])

  const close = useCallback(() => {
    if (!open) return false
    generation.current += 1
    for (const id of frames.current) cancelAnimationFrame(id)
    frames.current.clear()
    clearHighlights()
    setOpen(false)
    const target = returnFocus.current?.isConnected ? returnFocus.current : scope.current?.querySelector<HTMLElement>('.composer textarea')
    target?.focus({ preventScroll: true })
    return true
  }, [open, scope])

  const show = useCallback(() => {
    if (!open) {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      const selected = window.getSelection()?.toString() || ''
      if (selected && selected.length <= 100 && !/[\r\n]/.test(selected)) setQuery(selected)
      navigated.current = false
      setOpen(true)
    } else { input.current?.focus(); input.current?.select() }
  }, [open])
  useImperativeHandle(ref, () => ({ open: show, close, next: backward => { if (!open) show(); else void navigate(backward) } }), [show, close, open, navigate])

  useEffect(() => {
    if (open) { input.current?.focus(); input.current?.select() }
  }, [open])
  useEffect(() => {
    if (!open) return
    generation.current += 1
    navigated.current = false
    clearHighlights()
    queryTimer.current = window.setTimeout(() => search(query, 0), 150)
    return () => window.clearTimeout(queryTimer.current)
  }, [open, query, sessionKey, search])
  useEffect(() => {
    if (!open) return
    let timer = 0
    const observer = new MutationObserver(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => search(latestQuery.current), 200)
    })
    for (const root of roots()) observer.observe(root, { childList: true, subtree: true, characterData: true })
    timer = window.setTimeout(() => search(latestQuery.current), 200)
    return () => { observer.disconnect(); window.clearTimeout(timer) }
  }, [open, roots, search, sessionKey, contentKey])
  useEffect(() => () => {
    generation.current += 1
    for (const id of frames.current) cancelAnimationFrame(id)
    clearHighlights()
  }, [])

  if (!open) return null
  return <div className="find-bar" role="search" aria-label="Find in chat" onKeyDown={event => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Enter') { event.preventDefault(); void navigate(event.shiftKey) }
  }}>
    <input ref={input} aria-label="Find in chat" placeholder="Find in chat" value={query} spellCheck={false} onChange={event => setQuery(event.target.value)} />
    <span className="find-count" aria-live="polite" aria-atomic="true">{query ? result.count ? `${result.index + 1} of ${result.count}${result.overflow ? '+' : ''}` : 'No results' : ''}</span>
    <button type="button" className="icon-button" aria-label="Previous match" title="Previous match · Shift+Enter" disabled={!result.count} onClick={() => void navigate(true)}><ArrowUp size={14} /></button>
    <button type="button" className="icon-button" aria-label="Next match" title="Next match · Enter" disabled={!result.count} onClick={() => void navigate()}><ArrowDown size={14} /></button>
    <button type="button" className="icon-button" aria-label="Close find" title="Close find · Esc" onClick={close}><X size={14} /></button>
  </div>
}
