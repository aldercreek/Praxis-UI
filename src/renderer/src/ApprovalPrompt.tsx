import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowRight, ChevronDown, Stop } from './icons'
import type { Approval } from '../../shared/protocol'
import { presentApproval, submitApprovalDecision } from './approvalPresentation'
import './approval.css'

type Respond = (id: string, approved: boolean) => Promise<void>
interface ApprovalContextValue {
  approvals: readonly Approval[]
  pending: Set<string>
  errors: Map<string, string>
  respond: Respond
}
const ApprovalContext = createContext<ApprovalContextValue | null>(null)
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

export function ApprovalProvider({ approvals, onRespond, children }: {
  approvals: readonly Approval[]
  onRespond: Respond
  children: ReactNode
}) {
  const inFlight = useRef(new Set<string>())
  const submitting = useRef(new Set<string>())
  const [pending, setPending] = useState(new Set<string>())
  const [errors, setErrors] = useState(new Map<string, string>())
  const current = useRef({ approvals, onRespond })
  current.current = { approvals, onRespond }

  useEffect(() => {
    const active = new Set(approvals.map(approval => approval.approval_id))
    let changed = false
    for (const id of inFlight.current) if (!active.has(id) && !submitting.current.has(id)) { inFlight.current.delete(id); changed = true }
    if (changed) setPending(new Set(inFlight.current))
    setErrors(previous => [...previous.keys()].every(id => active.has(id)) ? previous : new Map([...previous].filter(([id]) => active.has(id))))
  }, [approvals])

  const respond = useCallback<Respond>(async (id, approved) => {
    // A late handler from another session must not use its replacement session's API callback.
    if (!current.current.approvals.some(approval => approval.approval_id === id) || inFlight.current.has(id)) return
    setErrors(previous => {
      if (!previous.has(id)) return previous
      const next = new Map(previous); next.delete(id); return next
    })
    submitting.current.add(id)
    try {
      await submitApprovalDecision(inFlight.current, id, approved, current.current.onRespond, () => setPending(new Set(inFlight.current)))
    } catch (error) {
      if (current.current.approvals.some(approval => approval.approval_id === id)) setErrors(previous => new Map(previous).set(id, errorText(error)))
      throw error
    } finally {
      submitting.current.delete(id)
      if (!current.current.approvals.some(approval => approval.approval_id === id) && inFlight.current.delete(id)) setPending(new Set(inFlight.current))
    }
  }, [])

  const value = useMemo(() => ({ approvals, pending, errors, respond }), [approvals, pending, errors, respond])
  return <ApprovalContext.Provider value={value}>{children}</ApprovalContext.Provider>
}

export function ApprovalPrompt({ onStop, stopping }: { onStop?: () => void; stopping?: boolean }) {
  const context = useContext(ApprovalContext)
  const approval = context?.approvals[0]
  return context && approval ? <ApprovalRequest key={approval.approval_id} approval={approval} context={context} onStop={onStop} stopping={stopping} /> : null
}

function ApprovalDetails({ view }: { view: ReturnType<typeof presentApproval> }) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const text = useRef<HTMLSpanElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const [expandable, setExpandable] = useState(false)
  const [open, setOpen] = useState(false)
  const label = view.detailLabel === 'Command' ? 'Command details' : 'Tool arguments'
  const position = useCallback(() => {
    if (!trigger.current || !popup.current) return
    const anchor = trigger.current.getBoundingClientRect()
    const box = popup.current.getBoundingClientRect()
    const left = Math.max(16, Math.min(anchor.left, innerWidth - box.width - 16))
    const top = anchor.top >= box.height + 24 ? anchor.top - box.height - 8 : Math.max(16, Math.min(anchor.bottom + 8, innerHeight - box.height - 16))
    Object.assign(popup.current.style, { left: `${left}px`, top: `${top}px` })
  }, [])
  useLayoutEffect(() => {
    const update = () => {
      const needsDetails = Boolean(view.parameters || /[\r\n]/.test(view.detail) || text.current && trigger.current && text.current.scrollWidth > trigger.current.clientWidth)
      setExpandable(needsDetails)
      if (!needsDetails && popup.current?.matches(':popover-open')) popup.current.hidePopover()
    }
    update()
    const observer = new ResizeObserver(update)
    if (trigger.current) observer.observe(trigger.current)
    document.fonts.addEventListener('loadingdone', update)
    return () => { observer.disconnect(); document.fonts.removeEventListener('loadingdone', update) }
  }, [view.detail, view.parameters])
  useLayoutEffect(() => {
    if (!open) return
    position()
    const observer = new ResizeObserver(position)
    if (popup.current) observer.observe(popup.current)
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => { observer.disconnect(); window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true) }
  }, [open, position])
  const toggle = () => {
    const panel = popup.current
    if (!panel) return
    if (panel.matches(':popover-open')) panel.hidePopover()
    else {
      panel.showPopover()
      position()
      panel.focus({ preventScroll: true })
    }
  }
  return <>
    <button ref={trigger} type="button" className="praxis-approval-detail-trigger" disabled={!expandable}
      aria-label={expandable ? `View ${view.detailLabel.toLowerCase()}` : undefined} aria-haspopup={expandable ? 'dialog' : undefined}
      aria-expanded={expandable ? open : undefined} aria-controls={expandable ? id : undefined} onClick={toggle}>
      <span ref={text} className="praxis-approval-detail-preview">{view.preview || view.detail}</span>
      {expandable && <ChevronDown size={14} aria-hidden="true" />}
    </button>
    <div ref={popup} id={id} popover="auto" role="dialog" aria-label={label} tabIndex={-1} className="praxis-approval-detail-popover"
      onToggle={event => setOpen(event.newState === 'open')} onKeyDown={event => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        popup.current?.hidePopover()
        trigger.current?.focus({ preventScroll: true })
      }}>
      <pre>{view.detail}</pre>
      {view.parameters && <details className="praxis-approval-parameters"><summary>All arguments</summary><pre>{view.parameters}</pre></details>}
    </div>
  </>
}

function ApprovalRequest({ approval, context, onStop, stopping }: { approval: Approval; context: ApprovalContextValue; onStop?: () => void; stopping?: boolean }) {
  const view = presentApproval(approval)
  const pending = context.pending.has(approval.approval_id)
  const [selected, setSelected] = useState<boolean | undefined>(false)
  const error = context.errors.get(approval.approval_id)
  const choose = async (approved: boolean) => {
    setSelected(approved)
    try { await context.respond(approval.approval_id, approved) }
    // The provider records the error below; usePraxis also reports request
    // failures globally. Keep the prompt available for another attempt.
    catch { setSelected(undefined) }
  }
  return <section className="praxis-approval" aria-label="Tool approval" aria-busy={pending}>
    <div className="praxis-approval-heading">
      <div className="praxis-approval-title"><h2>{view.tool === 'run_command' ? 'Run Command?' : 'Allow this action?'}</h2><span className="visually-hidden" aria-live="polite">{context.approvals.length} pending</span>{onStop && <button type="button" className="icon-button praxis-approval-stop" aria-label="Stop" title="Stop task" disabled={stopping} onClick={onStop}><Stop size={20} /></button>}</div>
      {(view.tool !== 'run_command' || view.agent) && <div className="praxis-approval-tool">{view.tool !== 'run_command' && <span>{view.tool}</span>}{view.agent && <span title={view.agent}>Subtask · {view.agent}</span>}</div>}
      <ApprovalDetails view={view} />
    </div>
    <div className="praxis-approval-options">
      {([false, true] as const).map((approved, index) => <button type="button" key={String(approved)}
        className={`praxis-approval-option${selected === approved ? ' selected' : ''}`}
        data-decision={approved ? 'allow' : 'reject'}
        aria-label={approved ? 'Allow' : 'Reject'} disabled={pending} onClick={() => void choose(approved)}>
        <span className="praxis-approval-number" aria-hidden="true">{index + 1}</span><span className="praxis-approval-option-label">{approved ? 'Allow' : 'Reject'}</span><ArrowRight size={16} aria-hidden="true" />
      </button>)}
    </div>
    {pending && <span className="visually-hidden" role="status">Submitting decision…</span>}
    {error && <p className="praxis-approval-feedback praxis-approval-error" role="alert">{error}</p>}
  </section>
}
