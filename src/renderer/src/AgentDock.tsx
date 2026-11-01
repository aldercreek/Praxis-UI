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
  const scroller = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [fade, setFade] = useState({ start: false, end: false })
  const position = useComposerPopover(open, ref, 'start', 480)
  const id = useId()
  const labels = dockTitles(agents)
  const layoutKey = agents.map(task => `${task.key}:${labels.get(task.key)}`).join('|')
  const close = (focus = false) => { setOpen(false); if (focus) trigger.current?.focus({ preventScroll: true }) }
  // Every agent stays in one row that scrolls sideways. The edge with more
  // agents fades, and a vertical wheel scrolls the row.
  useLayoutEffect(() => {
    const node = scroller.current
    if (!node) return
    const update = () => {
      const start = node.scrollLeft > 1
      const end = node.scrollLeft + node.clientWidth < node.scrollWidth - 1
      setFade(previous => previous.start === start && previous.end === end ? previous : { start, end })
    }
    const wheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX) || node.scrollWidth <= node.clientWidth) return
      event.preventDefault()
      node.scrollLeft += event.deltaY
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    node.addEventListener('scroll', update, { passive: true })
    node.addEventListener('wheel', wheel, { passive: false })
    return () => { observer.disconnect(); node.removeEventListener('scroll', update); node.removeEventListener('wheel', wheel) }
  }, [layoutKey])
  // Keep the selected agent in view without scrolling the page.
  useLayoutEffect(() => {
    const node = scroller.current
    const item = node?.querySelector<HTMLElement>('.agent-dock-item[aria-pressed="true"]')
    if (!node || !item) return
    const box = node.getBoundingClientRect()
    const target = item.getBoundingClientRect()
    if (target.left < box.left + 24) node.scrollLeft -= box.left + 24 - target.left
    else if (target.right > box.right - 24) node.scrollLeft += target.right - (box.right - 24)
  }, [selected, layoutKey])
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
    <div className="agent-dock-strip" data-fade-start={fade.start} data-fade-end={fade.end}>
      <div className="agent-dock-items" ref={scroller}>{agents.map(task => <Tooltip key={task.key} anchorClassName="agent-tooltip-anchor" className="agent-tooltip"
        content={<><span className="agent-tooltip-title">{task.title}</span><span className="agent-tooltip-status"><AgentMark task={task} />{agentStatusLabel(task)}</span></>}>
        <button type="button" className="agent-dock-item" data-agent-id={task.id}
        aria-label={`${task.title} · ${agentStatusLabel(task)}`} aria-pressed={selected === task.key} onClick={() => onSelect(task.key)}>
        <AgentMark task={task} /><span>{labels.get(task.key)}</span>
      </button></Tooltip>)}</div>
    </div>
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
