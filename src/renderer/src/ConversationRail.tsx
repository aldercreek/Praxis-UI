import { Bookmark } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { DisplayMessage } from './state'
import { conversationAnchors, readBookmarks } from './conversationNavigation'

export function ConversationRail({ sessionId, messages, scrollRef, onNavigate }: {
  sessionId: string
  messages: DisplayMessage[]
  scrollRef: RefObject<HTMLDivElement | null>
  onNavigate: () => void
}) {
  const items = useMemo(() => conversationAnchors(messages), [messages])
  const storageKey = 'praxis:conversation-bookmarks:v1:' + sessionId
  const [bookmarks, setBookmarks] = useState(() => readBookmarks(storageKey))
  const [saveError, setSaveError] = useState('')
  const [current, setCurrent] = useState<string>()
  const [previewId, setPreviewId] = useState<string>()
  const [position, setPosition] = useState<{ top: number; right: number }>()
  const nav = useRef<HTMLElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const interacting = useRef(false)
  const previewInput = useRef<'pointer' | 'keyboard'>('pointer')
  const popupId = useId()
  const preview = items.find(item => item.messageId === previewId)
  const previewIndex = items.findIndex(item => item.messageId === previewId)
  const signature = items.map(item => item.messageId).join('\0')

  const keepPreview = () => { clearTimeout(closeTimer.current); interacting.current = true }
  const closePreview = () => {
    clearTimeout(closeTimer.current)
    interacting.current = false
    setPreviewId(undefined)
  }
  const leavePreview = () => {
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => {
      if (document.activeElement?.matches(':focus-visible') && (nav.current?.contains(document.activeElement) || popup.current?.contains(document.activeElement))) return
      interacting.current = false
      setPreviewId(undefined)
    }, 160)
  }
  const showPreview = (id: string) => {
    keepPreview()
    if (previewId !== id) setPosition(undefined)
    setPreviewId(id)
  }
  const revealTick = (id: string) => {
    const button = buttons.current.get(id)
    const container = list.current
    if (!button || !container) return
    const top = button.offsetTop - container.offsetTop
    if (top < container.scrollTop) container.scrollTop = top
    else if (top + button.offsetHeight > container.scrollTop + container.clientHeight) container.scrollTop = top + button.offsetHeight - container.clientHeight
  }
  const jump = (messageId: string) => {
    const container = scrollRef.current
    const target = Array.from(container?.querySelectorAll<HTMLElement>('[data-nav-message-id]') || []).find(element => element.dataset.navMessageId === messageId)
    if (!container || !target) return
    onNavigate()
    closePreview()
    target.focus({ preventScroll: true })
    container.scrollTo({ top: container.scrollTop + target.getBoundingClientRect().top - container.getBoundingClientRect().top - 20,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
  }

  useEffect(() => {
    const container = scrollRef.current
    if (!container) return
    let frame = 0
    const update = () => {
      const anchors = Array.from(container.querySelectorAll<HTMLElement>('[data-nav-message-id]'))
      const top = container.getBoundingClientRect().top + 72
      let anchor: HTMLElement | undefined = anchors[0]
      for (const candidate of anchors) {
        if (candidate.getBoundingClientRect().top > top) break
        anchor = candidate
      }
      if (container.scrollHeight - container.scrollTop - container.clientHeight < 2) anchor = anchors.at(-1)
      setCurrent(anchor?.dataset.navMessageId)
    }
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update) }
    const observer = new ResizeObserver(schedule)
    observer.observe(container)
    if (container.firstElementChild) observer.observe(container.firstElementChild)
    container.addEventListener('scroll', schedule, { passive: true })
    schedule()
    return () => { cancelAnimationFrame(frame); observer.disconnect(); container.removeEventListener('scroll', schedule) }
  }, [scrollRef, signature])

  useEffect(() => { if (current && !interacting.current) revealTick(current) }, [current])
  useEffect(() => () => clearTimeout(closeTimer.current), [])
  useEffect(() => {
    const sync = (event: StorageEvent) => { if (event.key === storageKey) setBookmarks(readBookmarks(storageKey)) }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [storageKey])
  useEffect(() => {
    const outside = (event: PointerEvent | FocusEvent) => {
      if (event.target instanceof Node && !nav.current?.contains(event.target) && !popup.current?.contains(event.target)) closePreview()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !previewId) return
      if (popup.current?.contains(document.activeElement)) buttons.current.get(previewId)?.focus({ preventScroll: true })
      closePreview()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    document.addEventListener('keydown', escape)
    window.addEventListener('resize', closePreview)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', outside)
      document.removeEventListener('keydown', escape)
      window.removeEventListener('resize', closePreview)
    }
  }, [previewId])

  useLayoutEffect(() => {
    if (!preview || !popup.current || !nav.current) return
    const marker = buttons.current.get(preview.messageId)?.getBoundingClientRect()
    if (!marker) return
    const height = popup.current.getBoundingClientRect().height
    const railBounds = nav.current.getBoundingClientRect()
    setPosition({ right: window.innerWidth - railBounds.left + 8,
      top: Math.max(scrollRef.current?.getBoundingClientRect().top || 8, Math.min(window.innerHeight - height - 8, marker.top + marker.height / 2 - height / 2)) })
  }, [preview, saveError])

  if (!items.length) return null
  return <>
    <nav className="conversation-rail" aria-label="Conversation navigation" ref={nav} onPointerEnter={keepPreview} onPointerLeave={leavePreview}>
      <div className="conversation-rail-list" ref={list} onWheel={() => setPreviewId(undefined)} onKeyDown={event => {
        const index = items.findIndex(item => buttons.current.get(item.messageId) === event.target)
        if (index < 0) return
        const destination = { ArrowUp: index - 1, ArrowDown: index + 1, Home: 0, End: items.length - 1 }[event.key]
        if (destination !== undefined) {
          event.preventDefault()
          const id = items[Math.max(0, Math.min(items.length - 1, destination))].messageId
          revealTick(id)
          buttons.current.get(id)?.focus({ preventScroll: true })
        } else if (event.key === 'Tab' && !event.shiftKey && previewId) {
          event.preventDefault()
          popup.current?.querySelector<HTMLButtonElement>('.conversation-bookmark')?.focus()
        }
      }}>
        {items.map((item, index) => <button key={item.messageId} type="button" className="conversation-tick"
          style={{ '--tick-width': (previewIndex < 0 ? 6 : [22, 16, 10][Math.abs(index - previewIndex)] || 6) + 'px' } as CSSProperties}
          ref={element => { if (element) buttons.current.set(item.messageId, element); else buttons.current.delete(item.messageId) }}
          aria-label={`Question ${index + 1}: ${item.question}${bookmarks.has(item.bookmarkKey) ? ' (bookmarked)' : ''}`}
          aria-current={current === item.messageId ? 'location' : undefined} aria-haspopup="dialog"
          aria-expanded={previewId === item.messageId} aria-controls={previewId === item.messageId ? popupId : undefined}
          data-bookmarked={bookmarks.has(item.bookmarkKey)} tabIndex={(current || items[0].messageId) === item.messageId ? 0 : -1}
          onPointerEnter={() => { if (previewInput.current === 'pointer') showPreview(item.messageId) }}
          onPointerMove={() => { previewInput.current = 'pointer'; showPreview(item.messageId) }}
          onFocus={() => { previewInput.current = 'keyboard'; showPreview(item.messageId) }} onClick={() => jump(item.messageId)}>
          <span aria-hidden="true" />
        </button>)}
      </div>
    </nav>
    {preview && createPortal(<div id={popupId} ref={popup} className="conversation-preview" role="dialog" aria-label="Conversation preview"
      style={{ ...position, visibility: position ? undefined : 'hidden' }} onPointerEnter={keepPreview} onPointerLeave={leavePreview}>
      <button type="button" className="conversation-preview-content" onClick={() => jump(preview.messageId)}>
        <strong>{preview.question}</strong><span>{preview.answer || 'No response yet'}</span>
      </button>
      <button type="button" className="conversation-bookmark" aria-label={bookmarks.has(preview.bookmarkKey) ? 'Remove bookmark' : 'Bookmark conversation'}
        title={bookmarks.has(preview.bookmarkKey) ? 'Remove bookmark' : 'Bookmark conversation'} aria-pressed={bookmarks.has(preview.bookmarkKey)} onClick={() => {
          const next = new Set(bookmarks)
          if (next.has(preview.bookmarkKey)) next.delete(preview.bookmarkKey)
          else next.add(preview.bookmarkKey)
          setBookmarks(next)
          try { localStorage.setItem(storageKey, JSON.stringify([...next])); setSaveError('') }
          catch { setSaveError('Bookmarks are only saved in this window.') }
        }}><Bookmark size={16} fill={bookmarks.has(preview.bookmarkKey) ? 'currentColor' : 'none'} /></button>
      {saveError && <p className="conversation-bookmark-error" role="status">{saveError}</p>}
    </div>, document.body)}
  </>
}
