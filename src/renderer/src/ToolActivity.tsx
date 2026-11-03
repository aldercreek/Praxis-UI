import { useContext, useLayoutEffect, useRef, useState } from 'react'
import { ChevronRight, CircleAlert } from './icons'
import { Disclosure, DisclosureState, useDisclosure } from './Disclosure'
import { ToolIcon, ToolMessage } from './ToolMessage'
import { presentTool, presentToolGroup, type ToolGroup } from './toolPresentation'

// Continuous calls fold into one process row, collapsed by default even while
// running. A live row names the call in progress; a finished row names the
// completed category. A single call is shown as its own row.
export function ToolActivity({ group, isCurrent = false, onExpand }: { group: ToolGroup; isCurrent?: boolean; onExpand?: () => void }) {
  const [open, setOpen] = useDisclosure(group.id)
  const saved = useContext(DisclosureState)
  const [revealed, setRevealed] = useState<string>()
  const root = useRef<HTMLDivElement>(null)
  const held = useRef<string | undefined>(undefined)
  const presentation = presentToolGroup(group, isCurrent)
  const direct = Boolean(presentation?.single)
  const [settled, setSettled] = useState(direct)
  const joining = settled && !direct
  const keepOpen = joining && group.messages.some(message => saved?.get(message.id))
  const expanded = direct || open || keepOpen
  const expand = () => { setOpen(true); onExpand?.() }
  useLayoutEffect(() => {
    const summary = root.current?.querySelector<HTMLElement>('.tool-group > summary')
    if (direct && summary === document.activeElement) root.current?.querySelector<HTMLElement>('.tool-message > summary')?.focus({ preventScroll: true })
    // Details opened while a call stood alone stay readable when later calls join it.
    if (joining && (keepOpen || root.current?.querySelector('.tool-message[open]'))) setOpen(true)
    else if (joining) {
      const details = root.current?.querySelector('.tool-group')
      const items = details?.querySelector(':scope > .tool-group-items')
      details?.getAnimations?.({ subtree: true }).forEach(animation => {
        const target = (animation.effect as KeyframeEffect | null)?.target
        if (animation instanceof CSSTransition && (target === details || target === items)) animation.finish()
      })
    }
    if (settled !== direct) setSettled(direct)
  }, [direct])
  useLayoutEffect(() => {
    if (presentation?.active) held.current = presentation.active.message.id
  })
  useLayoutEffect(() => {
    if (!expanded || !revealed) return
    const message = [...(root.current?.querySelectorAll<HTMLElement>('[data-message-id]') || [])].find(node => node.dataset.messageId === revealed)
    const summary = message?.querySelector<HTMLElement>(':scope > summary')
    if (message && !message.hasAttribute('open')) summary?.click()
    summary?.focus({ preventScroll: true })
    summary?.scrollIntoView({ block: 'nearest' })
    setRevealed(undefined)
  }, [expanded, revealed])
  if (!presentation) return null
  const streaming = presentation.live && !direct
  const heldMessage = streaming && !presentation.active ? group.messages.find(message => message.id === held.current) ?? group.messages.at(-1) : undefined
  const shown = presentation.active?.tool ?? (heldMessage ? presentTool(heldMessage) : undefined)
  const label = streaming && shown ? presentation.active ? shown.caption : shown.summary : presentation.summary
  return <div className="tool-activity" ref={root}>
    <Disclosure storageKey={group.id} className={`tool-group${direct ? ' tool-direct' : ''}${streaming ? ' tool-streaming' : ''}`} data-group-id={group.id} forceOpen={direct} open={expanded}
      onOpenChange={value => { if (value) expand(); else setOpen(false) }}>
      <summary hidden={direct} aria-label={label}>
        <ToolIcon kind={streaming && shown ? shown.icon : presentation.icon} loading={streaming} />
        <span className={`tool-group-label${streaming ? ' text-sweep' : ''}`}>{label}</span>
        <ChevronRight className="disclosure-icon" size={12} aria-hidden="true" />
      </summary>
      <div className="tool-group-items">
        {group.messages.map(message => <ToolMessage key={message.id} message={message} onExpand={expand} />)}
      </div>
    </Disclosure>
    {!expanded && presentation.attention.length > 0 && <div className="tool-attention">{presentation.attention.map(({ message, tool }) =>
      <button key={message.id} type="button" onClick={() => { setRevealed(message.id); expand() }}>
        <CircleAlert size={14} /><span>{tool.summary}</span><ChevronRight className="disclosure-icon" size={12} />
      </button>)}</div>}
  </div>
}
