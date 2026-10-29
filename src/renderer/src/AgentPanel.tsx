import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, GitBranch, X } from './icons'
import { agentStatusLabel, type AgentTask } from './agentPresentation'
import { AgentMark } from './AgentDock'
import { Message } from './Transcript'
import { MarkdownContent } from './MarkdownContent'
import { ReadingAnchor } from './ReadingAnchor'
import { currentToolGroupId, groupTranscript } from './toolPresentation'
import { ToolActivity } from './ToolActivity'

export function AgentPanel({ agents, selected, onSelect, onClose, compact, width, minWidth, maxWidth, onResize }: {
  agents: AgentTask[]; selected: string; onSelect: (key: string) => void; onClose: () => void; compact: boolean
  width: number; minWidth: number; maxWidth: number; onResize: (width: number) => void
}) {
  const index = agents.findIndex(agent => agent.key === selected)
  const task = agents[index]
  const lastResponse = [...(task?.messages || [])].reverse().find(message => message.role === 'assistant')?.id
  const scroll = useRef<HTMLDivElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLElement>(null)
  const positions = useRef(new Map<string, { top: number; following: boolean }>())
  const following = useRef(false)
  const downwardIntentUntil = useRef(0)
  const drag = useRef<{ x: number; width: number } | null>(null)
  const [resizing, setResizing] = useState(false)
  const resize = (value: number) => onResize(Math.round(Math.max(minWidth, Math.min(maxWidth, value))))
  useEffect(() => {
    if (compact) { drag.current = null; setResizing(false) }
  }, [compact])
  useEffect(() => {
    if (!resizing) return
    document.body.classList.add('resizing-agent-panel')
    return () => document.body.classList.remove('resizing-agent-panel')
  }, [resizing])
  useLayoutEffect(() => {
    const region = scroll.current
    if (!region) return
    const saved = positions.current.get(selected)
    region.scrollTop = saved?.top || 0
    following.current = saved?.following ?? region.scrollHeight <= region.clientHeight
    return () => { positions.current.set(selected, { top: region.scrollTop, following: following.current }) }
  }, [selected])
  useLayoutEffect(() => {
    if (scroll.current && following.current) scroll.current.scrollTop = scroll.current.scrollHeight
  }, [task?.messages])
  useEffect(() => { if (!panel.current?.contains(document.activeElement)) close.current?.focus({ preventScroll: true }) }, [selected])
  if (!task) return null
  const items = groupTranscript(task.messages)
  const currentGroupId = currentToolGroupId(items, task.status === 'running')
  return <aside ref={panel} className="agent-panel" aria-label="Agent details" style={compact ? undefined : { width }} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
    if (compact && event.key === 'Tab') {
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], summary, [tabindex="0"]')].filter(node => node.getClientRects().length)
      const destination = event.shiftKey && document.activeElement === controls[0] ? controls.at(-1)
        : !event.shiftKey && document.activeElement === controls.at(-1) ? controls[0] : undefined
      if (destination) { event.preventDefault(); destination.focus() }
    }
  }}>
    {!compact && <div className="agent-panel-resizer" role="separator" tabIndex={0} aria-label="Resize agent details" aria-orientation="vertical"
      aria-valuemin={minWidth} aria-valuemax={maxWidth} aria-valuenow={width} aria-valuetext={`${width} pixels`} data-resizing={resizing || undefined}
      onPointerDown={event => {
        if (event.button !== 0) return
        event.preventDefault()
        event.currentTarget.focus({ preventScroll: true })
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { x: event.clientX, width }
        setResizing(true)
      }} onPointerMove={event => { if (drag.current) resize(drag.current.width + drag.current.x - event.clientX) }}
      onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); drag.current = null; setResizing(false) }}
      onLostPointerCapture={() => { drag.current = null; setResizing(false) }}
      onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const step = event.shiftKey ? 64 : 16
        resize(event.key === 'Home' ? minWidth : event.key === 'End' ? maxWidth : width + (event.key === 'ArrowLeft' ? step : -step))
      }} />}
    <div className="agent-panel-heading"><span><GitBranch size={16} />Agent</span><button ref={close} type="button" className="icon-button" aria-label="Close agent details" title="Close agent details · Esc" onClick={onClose}><X size={16} /></button></div>
    <div className="agent-profile"><div className="agent-title-row"><h2>{task.title}</h2><div className="agent-switch">
      <button type="button" className="icon-button" aria-label="Previous agent" disabled={index <= 0} onClick={() => onSelect(agents[index - 1].key)}><ChevronLeft size={14} /></button>
      <button type="button" className="icon-button" aria-label="Next agent" disabled={index === agents.length - 1} onClick={() => onSelect(agents[index + 1].key)}><ChevronRight size={14} /></button>
    </div></div><div className="agent-meta" role="status"><AgentMark task={task} /><span>{agentStatusLabel(task)}</span>
      {task.attention && compact && <button type="button" onClick={onClose}>Review approval</button>}
    </div></div>
    <div className="agent-panel-scroll" ref={scroll} onScroll={event => {
      const node = event.currentTarget
      if (node.scrollHeight - node.scrollTop - node.clientHeight >= 24) following.current = false
      else if (performance.now() < downwardIntentUntil.current) following.current = true
    }} onWheel={event => {
      if (event.deltaY < 0) { following.current = false; downwardIntentUntil.current = 0 }
      else if (event.deltaY > 0) downwardIntentUntil.current = performance.now() + 350
    }} onPointerDown={event => {
      if (event.target === event.currentTarget) downwardIntentUntil.current = performance.now() + 2000
    }} onClickCapture={event => {
      if (event.target instanceof Element && event.target.closest('summary, .tool-attention button')) following.current = false
    }} onKeyDownCapture={event => {
      if (['End', 'PageDown', 'ArrowDown'].includes(event.key)) downwardIntentUntil.current = performance.now() + 350
      if (['Home', 'PageUp', 'ArrowUp'].includes(event.key) || ['Enter', ' '].includes(event.key) && event.target instanceof Element && event.target.closest('summary')) {
        following.current = false; downwardIntentUntil.current = 0
      }
    }}>
      <ReadingAnchor container={scroll} following={following}>
      {items.map(message => message.role === 'tool-group' ? <ToolActivity key={message.id} group={message} isCurrent={message.id === currentGroupId} />
        : message.role === 'user' ? <div className="agent-instruction" key={message.id}><div className="agent-section-label">Task</div><MarkdownContent content={message.content} allowRelativeFiles={false} decorateFiles={false} /></div>
        : <Message key={message.id} message={message} hideAgentLabel showActions={message.id === lastResponse && message.status !== 'streaming'} />)}
      {!task.messages.length && <p className="agent-empty">{task.status === 'queued' ? 'Waiting to start.' : task.status === 'running' ? 'Waiting for the first update.' : 'No activity was recorded for this agent.'}</p>}
      </ReadingAnchor>
    </div>
  </aside>
}
