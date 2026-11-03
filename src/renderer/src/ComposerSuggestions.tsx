import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { DesktopAPI } from '../../shared/protocol'
import { FileText } from './icons'
import { composerCommands, matchCommands, type ComposerCommand } from './composerCommands'
import { applyFileMention, detectTrigger, type ComposerTrigger } from './composerTrigger'
import './composerSuggestions.css'

type Suggestion = { label: string; description: string; command?: ComposerCommand; path?: string }

export function useComposerSuggestions({ text, sessionKey, workspace, hasSession, disabled, api, textarea, onChange, onCommand }: {
  text: string; sessionKey: string; workspace: string; hasSession: boolean; disabled: boolean; api?: DesktopAPI
  textarea: RefObject<HTMLTextAreaElement | null>; onChange: (text: string) => void; onCommand: (command: ComposerCommand) => void
}) {
  const id = `composer-suggestions-${useId().replaceAll(':', '')}`
  const [selection, setSelection] = useState<{ sessionKey: string; text: string; caret: number; trigger: ComposerTrigger }>()
  const dismissed = useRef('')
  const [index, setIndex] = useState(0)
  const [result, setResult] = useState<{ key: string; files: string[]; error?: string }>()
  const trigger = !disabled && selection?.sessionKey === sessionKey && selection.text === text ? selection.trigger : undefined
  const requestKey = JSON.stringify([sessionKey, workspace, trigger?.query])
  const items: Suggestion[] = trigger?.kind === 'command' ? matchCommands(trigger.query, hasSession).map(command => ({ label: `/${command.name}`, description: command.description, command }))
    : trigger?.kind === 'file' && result?.key === requestKey ? result.files.map(path => {
      const split = path.lastIndexOf('/')
      return { label: path.slice(split + 1), description: split < 0 ? '' : path.slice(0, split), path }
    }) : []
  const selectedIndex = Math.min(index, Math.max(0, items.length - 1))
  const close = () => {
    dismissed.current = JSON.stringify([sessionKey, text, textarea.current?.selectionStart])
    setSelection(undefined)
  }
  const update = (value: string, caret: number) => {
    if (dismissed.current === JSON.stringify([sessionKey, value, caret])) return
    const next = detectTrigger(value, caret)
    setSelection(next ? { sessionKey, text: value, caret, trigger: next } : undefined)
  }
  useEffect(() => { setIndex(0) }, [trigger?.kind, trigger?.query, sessionKey])
  useEffect(() => { setSelection(undefined); dismissed.current = '' }, [sessionKey, workspace])
  useEffect(() => {
    if (trigger?.kind !== 'file') return
    let active = true
    const timer = setTimeout(() => {
      if (!api || !workspace) { setResult({ key: requestKey, files: [], error: 'Choose a workspace to mention files.' }); return }
      void api.listFiles({ workspace, query: trigger.query }).then(value => {
        if (active) setResult({ key: requestKey, files: value.files })
      }).catch(() => { if (active) setResult({ key: requestKey, files: [], error: 'Unable to list workspace files.' }) })
    }, 120)
    return () => { active = false; clearTimeout(timer) }
  }, [api, workspace, trigger?.kind, trigger?.query, requestKey])
  const choose = (item: Suggestion | undefined) => {
    if (!item || !selection || !trigger) return
    close()
    if (item.command) onCommand(item.command)
    else if (item.path) {
      const next = applyFileMention(text, trigger, selection.caret, item.path)
      onChange(next.text)
      dismissed.current = JSON.stringify([sessionKey, next.text, next.caret])
      requestAnimationFrame(() => { textarea.current?.focus(); textarea.current?.setSelectionRange(next.caret, next.caret) })
    }
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!trigger || event.nativeEvent.isComposing || event.keyCode === 229) return false
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return true }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (items.length) setIndex((selectedIndex + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length)
      return true
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      if (items.length) choose(items[selectedIndex])
      else if (event.key === 'Enter' && trigger.kind === 'command') {
        const command = composerCommands.find(item => item.name === text.slice(1).toLowerCase())
        if (command) choose({ label: `/${command.name}`, description: command.description, command })
      }
      else if (event.key === 'Tab') close()
      return true
    }
    return false
  }
  return { id, open: Boolean(trigger), trigger, items, selectedIndex, setIndex, choose, close, update, onKeyDown,
    activeId: trigger && items.length ? `${id}-${selectedIndex}` : undefined,
    status: trigger?.kind === 'file' ? result?.key !== requestKey ? 'Loading files…' : result.error || 'No matches' : 'No matches' }
}

function highlight(value: string, query: string, full = value, offset = 0, start = 0) {
  const positions = new Set<number>()
  const lower = full.toLowerCase()
  for (const character of query.toLowerCase()) {
    const index = lower.indexOf(character, start)
    if (index < 0) { positions.clear(); break }
    for (let offset = 0; offset < character.length; offset += 1) positions.add(index + offset)
    start = index + character.length
  }
  let position = offset
  return [...value].map(character => {
    const index = position
    position += character.length
    return positions.has(index) ? <mark key={index}>{character}</mark> : character
  })
}

export function ComposerSuggestions({ suggestions, anchor }: { suggestions: ReturnType<typeof useComposerSuggestions>; anchor: RefObject<HTMLFormElement | null> }) {
  const panel = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: 0, bottom: 0, width: 0, maxHeight: 268 })
  const closeRef = useRef(suggestions.close)
  closeRef.current = suggestions.close
  useLayoutEffect(() => {
    if (!suggestions.open || !anchor.current) return
    const measure = () => {
      const rect = anchor.current!.getBoundingClientRect()
      setPosition({ left: rect.left, bottom: window.innerHeight - rect.top + 8, width: rect.width, maxHeight: Math.min(268, Math.max(32, rect.top - 16)) })
    }
    measure()
    const observer = new ResizeObserver(measure)
    for (let node: HTMLElement | null = anchor.current; node; node = node.parentElement) observer.observe(node)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    const outside = (event: PointerEvent) => {
      if (!anchor.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) closeRef.current()
    }
    document.addEventListener('pointerdown', outside)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); document.removeEventListener('pointerdown', outside) }
  }, [suggestions.open, anchor])
  useLayoutEffect(() => {
    if (suggestions.activeId) document.getElementById(suggestions.activeId)?.scrollIntoView({ block: 'nearest' })
  }, [suggestions.activeId])
  if (!suggestions.open) return null
  return createPortal(<div ref={panel} id={suggestions.id} className="composer-suggestions" role="listbox" aria-label={suggestions.trigger?.kind === 'file' ? 'Workspace files' : 'Commands'} aria-activedescendant={suggestions.activeId} style={position}>
    {suggestions.items.map((item, index) => {
      const query = (suggestions.trigger?.query || '').replaceAll('\\', '/')
      const full = item.path || item.label
      const offset = item.path ? full.length - item.label.length : 0
      const start = item.path && item.label.toLowerCase().includes(query.toLowerCase()) ? offset : 0
      return <div id={`${suggestions.id}-${index}`} role="option" aria-selected={index === suggestions.selectedIndex} key={item.path || item.label}
      className="composer-suggestion" onPointerMove={() => suggestions.setIndex(index)} onPointerDown={event => event.preventDefault()} onClick={() => suggestions.choose(item)}>
      {item.path && <FileText size={14} />}<span className="suggestion-name">{highlight(item.label, query, full, offset, start)}</span><span className="suggestion-description">{highlight(item.description, item.path ? query : '', full, 0, start)}</span>
    </div>})}
    {!suggestions.items.length && <div className="suggestion-empty" role="status">{suggestions.status}</div>}
  </div>, document.body)
}
