import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, CircleAlert, GitBranch, LoaderCircle, Stop, X } from './icons'
import { agentStatusLabel, type AgentTask } from './agentPresentation'
import { Tooltip } from './Tooltip'
import { useComposerPopover } from './useComposerPopover'
import './agents.css'

// Omit a repeated project prefix only in the narrow strip. Keep full names in
// the list, tooltip and accessible label, and never introduce duplicate labels.
function dockTitles(agents: AgentTask[]) {
  const labels = agents.map(task => {
    const title = task.title || task.id
    const boundaries = [...title.matchAll(/\s+/g)].map(match => match.index! + match[0].length).reverse()
    const end = boundaries.find(end => end >= 8 && title.length - end >= 4
      && agents.some(other => other.key !== task.key && other.title?.startsWith(title.slice(0, end))))
    return end ? title.slice(end) : title
  })
  return new Map(agents.map((task, index) => [task.key, labels.filter(label => label === labels[index]).length === 1 ? labels[index] : task.title || task.id]))
}

export function AgentMark({ task }: { task: AgentTask }) {
  if (task.attention || task.status === 'failed') return <CircleAlert size={14} className="agent-attention" />
  if (task.status === 'running' || task.status === 'closing') return <LoaderCircle size={14} className="spin" />
  if (task.status === 'returned') return <Check size={14} className="agent-returned" />
  if (task.status === 'stopped') return <Stop size={14} />
  return <span className="agent-idle-dot" aria-hidden="true" />
}

export function AgentDock({ agents, selected, onSelect }: { agents: AgentTask[]; selected?: string; onSelect: (key: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLElement>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  const [width, setWidth] = useState(0)
  const position = useComposerPopover(open, ref, 'start', 480)
  const id = useId()
  const count = Math.max(0, Math.min(agents.length, Math.floor((width - 138) / 174)))
  const visible = agents.slice(0, count)
  const chosen = agents.find(agent => agent.key === selected)
  const labels = dockTitles(agents)
  if (chosen && count && !visible.includes(chosen)) visible[count - 1] = chosen
  const close = (focus = false) => { setOpen(false); if (focus) trigger.current?.focus({ preventScroll: true }) }
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const resize = () => setWidth(node.getBoundingClientRect().width)
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(node)
    window.addEventListener('resize', resize)
    return () => { observer.disconnect(); window.removeEventListener('resize', resize) }
  }, [])
  useEffect(() => {
    if (!open) return
    menu.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"], .agent-list-item')?.focus({ preventScroll: true })
    const pointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !ref.current?.contains(event.target) && !menu.current?.contains(event.target)) close()
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true) }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !menu.current?.contains(document.activeElement)) return
      const items = [...menu.current.querySelectorAll<HTMLButtonElement>('.agent-list-item')]
      const index = items.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      event.preventDefault(); items[next]?.focus()
    }
    document.addEventListener('pointerdown', pointer)
    document.addEventListener('keydown', key, true)
    return () => { document.removeEventListener('pointerdown', pointer); document.removeEventListener('keydown', key, true) }
  }, [open])
  const toggle = (button: HTMLButtonElement) => { trigger.current = button; setOpen(value => !value) }
  return <div className="agent-dock" ref={ref} role="group" aria-label="Agents">
    <button type="button" className="agent-dock-heading" aria-label="View all agents" aria-expanded={open} aria-controls={id} onClick={event => toggle(event.currentTarget)}>
      <GitBranch size={16} /><span>Agents</span><ChevronDown size={12} />
    </button>
    <div className="agent-dock-items">{visible.map(task => <Tooltip key={task.key} anchorClassName="agent-tooltip-anchor" className="agent-tooltip"
      content={<><span className="agent-tooltip-title">{task.title}</span><span className="agent-tooltip-status"><AgentMark task={task} />{agentStatusLabel(task)}</span></>}>
      <button type="button" className="agent-dock-item" data-agent-id={task.id}
      aria-label={`${task.title} · ${agentStatusLabel(task)}`} aria-pressed={selected === task.key} onClick={() => onSelect(task.key)}>
      <AgentMark task={task} /><span>{labels.get(task.key)}</span>
    </button></Tooltip>)}</div>
    {agents.length > count && <button type="button" className="agent-overflow" aria-label={`View ${agents.length - count} more agents`} aria-expanded={open} aria-controls={id} onClick={event => toggle(event.currentTarget)}>+{agents.length - count}</button>}
    {open && createPortal(<section ref={menu} id={id} className="agent-menu" aria-label="All agents" style={position} onBlur={event => {
      if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget) && !ref.current?.contains(event.relatedTarget)) close()
    }}>
      <div className="agent-menu-heading"><span>Agents</span><button type="button" className="icon-button" aria-label="Close agent list" onClick={() => close(true)}><X size={14} /></button></div>
      {agents.map(task => <button key={task.key} type="button" className="agent-list-item" aria-pressed={selected === task.key} onClick={() => { close(); onSelect(task.key) }}>
        <span className="agent-list-mark"><AgentMark task={task} /></span><span className="agent-list-copy"><span className="agent-list-title">{task.title}</span><small>{agentStatusLabel(task)}</small></span>
      </button>)}
    </section>, document.body)}
  </div>
}
