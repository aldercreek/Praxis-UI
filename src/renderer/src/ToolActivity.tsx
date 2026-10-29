import { useLayoutEffect, useRef, useState } from 'react'
import { ChevronRight, CircleAlert } from './icons'
import { Disclosure, useDisclosure } from './Disclosure'
import { ToolIcon, ToolMessage } from './ToolMessage'
import { presentToolGroup, type ToolGroup } from './toolPresentation'

export function ToolActivity({ group, isCurrent = false, onExpand }: { group: ToolGroup; isCurrent?: boolean; onExpand?: () => void }) {
  const [open, setOpen] = useDisclosure(group.id)
  const [revealed, setRevealed] = useState<string>()
  const root = useRef<HTMLDivElement>(null)
  const presentation = presentToolGroup(group, isCurrent)
  const direct = Boolean(presentation && (presentation.single || presentation.live))
  const expanded = direct || open
  const expand = () => { setOpen(true); onExpand?.() }
  useLayoutEffect(() => {
    const summary = root.current?.querySelector<HTMLElement>('.tool-group > summary')
    if (direct && summary === document.activeElement) root.current?.querySelector<HTMLElement>('.tool-message > summary')?.focus({ preventScroll: true })
  }, [direct])
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
  return <div className="tool-activity" ref={root}>
    <Disclosure storageKey={group.id} className={`tool-group${direct ? ' tool-direct' : ''}`} data-group-id={group.id} forceOpen={direct} open={open}
      onOpenChange={value => { if (value) expand(); else setOpen(false) }}>
      <summary hidden={direct}>
        <ToolIcon kind={presentation.icon} /><span className="tool-group-label">{presentation.summary}</span>
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