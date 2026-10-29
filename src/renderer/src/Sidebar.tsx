import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Folder, PanelLeft, Pin, Plus, Search, Settings2, Share2, Trash2, X } from './icons'
import praxisMark from '../../../resources/brand/praxis-mark.svg'
import type { SessionSummary } from '../../shared/protocol'
import { baseName, errorMessage, usePraxis } from './usePraxis'
import { PINNED_SESSIONS_KEY, groupSidebarSessions, readPinnedSessions, retainPinnedSessions, savePinnedSessions } from './sidebarState'
import { ShareChatDialog } from './ShareChatDialog'
import './sidebar.css'

interface SidebarProps {
  praxis: ReturnType<typeof usePraxis>
  openSettings: () => void
  collapsed: boolean
  toggleSidebar: () => void
  onDelete: (session: SessionSummary) => void
}

interface MenuTarget {
  session: SessionSummary
  anchor: HTMLButtonElement
  x: number
  y: number
  keyboard: boolean
}

const SessionTitle = memo(function SessionTitle({ title, suspended }: { title: string; suspended: boolean }) {
  const container = useRef<HTMLSpanElement>(null)
  const measurement = useRef<HTMLSpanElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const hovered = useRef(false)
  const distance = useRef(0)
  const reducedMotion = useRef(false)
  const suspendedRef = useRef(suspended)
  suspendedRef.current = suspended
  const [width, setWidth] = useState(0)
  const [scrolling, setScrolling] = useState(false)
  const [reduce, setReduce] = useState(false)

  const stop = useCallback(() => {
    clearTimeout(timer.current)
    setScrolling(false)
  }, [])

  const start = useCallback(() => {
    clearTimeout(timer.current)
    if (!distance.current || reducedMotion.current || suspendedRef.current) return
    timer.current = setTimeout(() => {
      if (hovered.current && distance.current && !reducedMotion.current && !suspendedRef.current) setScrolling(true)
    }, 300)
  }, [])

  useEffect(() => { if (suspended) stop() }, [suspended, stop])

  useLayoutEffect(() => {
    const element = container.current!
    const text = measurement.current!
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    let alive = true
    const measure = () => {
      if (!alive) return
      const overflows = text.scrollWidth > element.clientWidth + (distance.current ? -2 : 2)
      const next = overflows ? text.scrollWidth + 20 : 0
      if (next === distance.current) return
      distance.current = next
      setWidth(next)
      stop()
      if (hovered.current) start()
    }
    const motionChanged = () => {
      reducedMotion.current = media.matches
      setReduce(media.matches)
      stop()
      if (hovered.current && !media.matches) start()
    }
    const blur = () => { hovered.current = false; stop() }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    observer.observe(text)
    media.addEventListener('change', motionChanged)
    window.addEventListener('blur', blur)
    motionChanged()
    measure()
    void document.fonts.ready.then(measure)
    return () => {
      alive = false
      clearTimeout(timer.current)
      observer.disconnect()
      media.removeEventListener('change', motionChanged)
      window.removeEventListener('blur', blur)
    }
  }, [title, start, stop])

  return <span ref={container} aria-hidden="true" className={`ps-session-title${width ? ' overflows' : ''}${scrolling ? ' scrolling' : ''}`}
    title={reduce && width ? title : undefined}
    onPointerEnter={() => { hovered.current = true; start() }}
    onPointerLeave={() => { hovered.current = false; stop() }}
    onContextMenu={() => { hovered.current = false; stop() }}>
    <span ref={measurement} className="ps-title-measure">{title}</span>
    <span className="ps-title-static">{title}</span>
    {scrolling && <span className="ps-title-track" style={{ '--ps-marquee-distance': `${width}px`, animationDuration: `${width / 48}s` } as CSSProperties}>
      <span>{title}</span><span>{title}</span>
    </span>}
  </span>
})

function SessionContextMenu({ target, id, pinned, close, togglePin, share, remove }: {
  target: MenuTarget
  id: string
  pinned: boolean
  close: (restoreFocus?: boolean) => void
  togglePin: () => void
  share: () => void
  remove: () => void
}) {
  const menu = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = menu.current!
    const bounds = element.getBoundingClientRect()
    element.style.left = `${Math.max(8, Math.min(target.x, window.innerWidth - bounds.width - 8))}px`
    element.style.top = `${Math.max(8, Math.min(target.y, window.innerHeight - bounds.height - 8))}px`
    ;(target.keyboard ? element.querySelector<HTMLButtonElement>('button') : element)?.focus({ preventScroll: true })
  }, [target.anchor, target.keyboard, target.x, target.y])

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) close()
    }
    const scroll = (event: Event) => {
      // Streaming output can scroll the conversation independently. Only
      // dismiss when the viewport or an ancestor moves the menu's anchor.
      const source = event.target
      if (source === document || (source instanceof Element && source.contains(target.anchor))) close()
    }
    const dismiss = () => close()
    document.addEventListener('pointerdown', outside)
    document.addEventListener('scroll', scroll, true)
    window.addEventListener('resize', dismiss)
    window.addEventListener('blur', dismiss)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('scroll', scroll, true)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('blur', dismiss)
    }
  }, [close, target.anchor])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close(true)
      return
    }
    if (event.key === 'Tab') { close(true); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const items = [...menu.current!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : event.key === 'ArrowDown' ? (current + 1) % items.length : current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length
    items[next]?.focus()
  }

  return createPortal(<div ref={menu} id={id} role="menu" tabIndex={-1} className="ps-context-menu"
    aria-label={`Actions for ${target.session.title || 'New chat'}`} onKeyDown={onKeyDown}
    style={{ left: target.x, top: target.y }} onContextMenu={event => event.preventDefault()}>
    <button type="button" role="menuitem" tabIndex={-1} onClick={togglePin}><Pin size={18} aria-hidden="true" /><span>{pinned ? 'Unpin chat' : 'Pin chat'}</span></button>
    <button type="button" role="menuitem" tabIndex={-1} onClick={share}><Share2 size={18} aria-hidden="true" /><span>Share chat</span></button>
    <div className="ps-menu-divider" role="separator" />
    <button type="button" role="menuitem" tabIndex={-1} className="ps-menu-danger" onClick={remove}><Trash2 size={18} aria-hidden="true" /><span>Delete chat</span></button>
  </div>, document.body)
}

export function Sidebar({ praxis, openSettings, collapsed, toggleSidebar, onDelete }: SidebarProps) {
  const sidebar = useRef<HTMLElement>(null)
  const [query, setQuery] = useState('')
  const [target, setTarget] = useState<MenuTarget | null>(null)
  const [shareTarget, setShareTarget] = useState<SessionSummary | null>(null)
  const shareTrigger = useRef<HTMLButtonElement | null>(null)
  const [pinnedIds, setPinnedIds] = useState(readPinnedSessions)
  const [feedback, setFeedback] = useState('')
  const feedbackTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const menuId = useId()
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const pinned = new Set(pinnedIds)
  const groups = groupSidebarSessions(praxis.sessions, pinned, query)
  const sessions = groups.flatMap(group => group.sessions)
  const loading = praxis.listState === 'loading' && praxis.sessions.length === 0
  const failed = praxis.listState === 'error' && praxis.sessions.length === 0

  const closeMenu = useCallback((restoreFocus = false) => {
    if (restoreFocus && target?.anchor.isConnected) target.anchor.focus({ preventScroll: true })
    setTarget(null)
  }, [target])

  useEffect(() => () => clearTimeout(feedbackTimer.current), [])
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === PINNED_SESSIONS_KEY || event.key === null) setPinnedIds(readPinnedSessions())
    }
    window.addEventListener('storage', changed)
    return () => window.removeEventListener('storage', changed)
  }, [])
  useEffect(() => {
    if (praxis.listState !== 'ready') return
    const migrated = pinnedIds.map(id => praxis.sessions.find(session => praxis.conversations[session.id]?.clientId === id)?.id || id)
    const retained = retainPinnedSessions(migrated, new Set(praxis.sessions.map(session => session.id)))
    if (retained.length !== pinnedIds.length || retained.some((id, index) => id !== pinnedIds[index])) {
      setPinnedIds(retained); savePinnedSessions(retained)
    }
  }, [praxis.listState, praxis.sessions, pinnedIds])
  useEffect(() => {
    if (target) {
      const session = sessions.find(session => session.id === target.session.id || praxis.conversations[session.id]?.clientId === target.session.id)
      if (collapsed || !session) closeMenu()
      else if (session.id !== target.session.id) setTarget({ ...target, session })
    }
    if (shareTarget && praxis.removedSessionIds.has(shareTarget.id)) setShareTarget(null)
  }, [collapsed, sessions, target, closeMenu, shareTarget, praxis.removedSessionIds])

  const retry = () => {
    if (!praxis.api) return
    const request = praxis.connection.state === 'connected' ? praxis.refresh() : praxis.api.restart()
    void request.catch(error => praxis.setError(errorMessage(error)))
  }
  const togglePin = () => {
    if (!target) return
    const sessionId = target.session.id
    const next = pinned.has(sessionId) ? pinnedIds.filter(id => id !== sessionId) : [...pinnedIds, sessionId]
    setPinnedIds(next)
    if (!savePinnedSessions(next)) {
      setFeedback('Pins are only saved in this window.')
      clearTimeout(feedbackTimer.current)
      feedbackTimer.current = setTimeout(() => setFeedback(''), 4000)
    }
    closeMenu()
    requestAnimationFrame(() => [...(sidebar.current?.querySelectorAll<HTMLButtonElement>('.ps-session') ?? [])].find(button => button.dataset.sessionId === sessionId)?.focus({ preventScroll: true }))
  }

  return <aside ref={sidebar} className={`sidebar praxis-sidebar${collapsed ? ' collapsed' : ''}`} aria-label="Session navigation">
    <div className="ps-brand-row"><span className="ps-brand"><span className="ps-brand-mark"><img src={praxisMark} alt="" aria-hidden="true" /></span>Praxis</span>
      <button type="button" className="ps-icon-button" aria-label="Collapse sidebar" title="Collapse sidebar" onClick={toggleSidebar}><PanelLeft size={18} /></button>
    </div>
    <div className="ps-sidebar-content">
      <button type="button" className={`ps-new-chat${!praxis.activeId ? ' active' : ''}`} aria-label="New chat" onClick={praxis.newChat}><Plus size={18} aria-hidden="true" /><span>New chat</span></button>
      <label className="ps-session-search"><Search size={18} aria-hidden="true" /><input type="search" aria-label="Search chats" placeholder="Search chats" value={query} onChange={event => setQuery(event.target.value)} />
        {query && <button type="button" className="ps-icon-button" aria-label="Clear search" onClick={() => setQuery('')}><X size={12} /></button>}
      </label>
      <div className="session-list ps-session-list" aria-busy={loading}>
        {(loading || failed) && <div className="sidebar-section-label ps-section-label">Recent chats</div>}
        {loading ? <div className="ps-session-skeleton" role="status" aria-label="Loading chats"><i /><i /><i /><i /></div>
          : failed ? <div className="sidebar-empty ps-sidebar-empty"><span role="status">Unable to load chats.</span><button type="button" className="ps-sidebar-retry" onClick={retry} disabled={!praxis.api}>Retry</button></div>
          : sessions.length === 0 ? <div className="sidebar-empty ps-sidebar-empty">{normalizedQuery ? 'No matching chats' : 'No chats yet'}</div>
          : groups.map(group => <section key={group.label} aria-label={group.label}>
            <div className="sidebar-section-label ps-section-label">{group.label}</div>{group.sessions.map(session => {
            const title = session.title || 'New chat'
            const selected = session.id === praxis.activeId
            const menuOpen = target?.session.id === session.id
            return <button type="button" key={praxis.conversations[session.id]?.clientId || session.id} data-session-id={session.id} className={`session-item ps-session${selected ? ' selected' : ''}${menuOpen ? ' context-target' : ''}`}
              aria-current={selected ? 'page' : undefined} aria-label={title} aria-haspopup="menu" aria-controls={menuId} aria-expanded={menuOpen}
              onClick={() => void praxis.openSession(session.id)}
              onContextMenu={event => { event.preventDefault(); setTarget({ session, anchor: event.currentTarget, x: event.clientX, y: event.clientY, keyboard: false }) }}
              onKeyDown={event => {
                if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
                event.preventDefault()
                const bounds = event.currentTarget.getBoundingClientRect()
                setTarget({ session, anchor: event.currentTarget, x: bounds.left + 12, y: bounds.bottom, keyboard: true })
              }}>
              <SessionTitle title={title} suspended={Boolean(target || shareTarget || collapsed)} />
              {pinned.has(session.id) && <Pin size={14} className="ps-session-pin" aria-hidden="true" />}
            </button>
          })}</section>)}
      </div>
    </div>
    <div className="ps-sidebar-footer">
      {feedback && <div className="ps-sidebar-feedback" role="status">{feedback}</div>}
      <div className="ps-footer-actions">
        <button type="button" className="ps-workspace-picker" onClick={() => void praxis.chooseWorkspace()}
          title={`Workspace for new chats: ${praxis.workspace || 'Choose workspace'}`} disabled={!praxis.api}>
          <Folder size={18} aria-hidden="true" /><span>{praxis.workspace ? baseName(praxis.workspace) : 'Choose workspace'}</span>
        </button>
        <button type="button" className="icon-button" aria-label="Settings" title="Settings (Ctrl+,)" onClick={openSettings}><Settings2 size={18} /></button>
      </div>
    </div>
    {target && <SessionContextMenu target={target} id={menuId} pinned={pinned.has(target.session.id)} close={closeMenu} togglePin={togglePin}
      share={() => { shareTrigger.current = target.anchor; setShareTarget(target.session); closeMenu() }}
      remove={() => { const session = praxis.sessions.find(session => session.id === target.session.id); closeMenu(true); if (session) onDelete(session) }} />}
    {shareTarget && <ShareChatDialog key={shareTarget.id} session={shareTarget} praxis={praxis} close={() => {
      setShareTarget(null)
      requestAnimationFrame(() => { if (shareTrigger.current?.isConnected) shareTrigger.current.focus({ preventScroll: true }) })
    }} />}
  </aside>
}
