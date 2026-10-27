import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronRight, Circle, CircleAlert, ListChecks, LoaderCircle, Square, X } from 'lucide-react'
import { Disclosure } from './Disclosure'
import { presentExecution } from './executionPresentation'
import { isBusy, type Conversation, type PlanStep } from './state'

export function PlanSteps({ plan }: { plan: PlanStep[] }) {
  return <ol className="plan-steps">{plan.map((step, index) => <li key={index} className={step.status}
    aria-label={`${step.status === 'completed' ? 'Completed' : step.status === 'in_progress' ? 'Current step' : 'Pending'}: ${step.description}`}>
    {step.status === 'completed' ? <Check size={13} /> : step.status === 'in_progress' ? <span className="plan-current-dot" aria-hidden="true" /> : <Circle size={12} />}
    <span>{step.description}</span>
  </li>)}</ol>
}

export function TurnPlan({ turnId, plan }: { turnId: string; plan: PlanStep[] }) {
  const completed = plan.filter(step => step.status === 'completed').length
  return <Disclosure className="turn-plan" storageKey={`plan:${turnId}`}>
    <summary><ListChecks size={14} /><span>Plan</span><span className="plan-count">{completed}/{plan.length}</span><ChevronRight size={12} className="disclosure-icon" /></summary>
    <PlanSteps plan={plan} />
  </Disclosure>
}

export function ExecutionBar({ conversation }: { conversation: Conversation }) {
  const [open, setOpen] = useState(false)
  const [panelHeight, setPanelHeight] = useState(360)
  const panelId = useId()
  const ref = useRef<HTMLDivElement>(null)
  const popover = useRef<HTMLElement>(null)
  const [position, setPosition] = useState({ left: 16, bottom: 16, width: 420 })
  const trigger = useRef<HTMLButtonElement>(null)
  const status = presentExecution(conversation)
  const [settledStatus, setSettledStatus] = useState(status)
  const busy = isBusy(conversation.summary?.status)
  const plan = conversation.plan
  const completed = plan.filter(step => step.status === 'completed').length
  const urgent = status.tone !== 'working' || conversation.summary?.status === 'stopping'
    || ['Compacting context', 'Finishing task'].includes(conversation.activity)
  const visibleStatus = urgent || settledStatus.tone !== status.tone ? status : settledStatus

  useEffect(() => {
    if (urgent || settledStatus.tone !== status.tone) {
      setSettledStatus(status)
      return
    }
    // Brief tool/model handoffs should not be announced as separate phases.
    const timer = setTimeout(() => setSettledStatus(status), 250)
    return () => clearTimeout(timer)
  }, [status.label, status.tone, urgent, settledStatus.tone])

  useLayoutEffect(() => {
    if (!open || !ref.current) return
    const resize = () => {
      const rect = ref.current!.getBoundingClientRect()
      setPanelHeight(Math.min(360, Math.max(0, rect.top - 24)))
      setPosition({ left: Math.max(16, rect.right - Math.min(420, rect.width)), bottom: window.innerHeight - rect.top + 8, width: Math.min(420, rect.width) })
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(ref.current.closest('.composer-region') || ref.current)
    window.addEventListener('resize', resize)
    window.addEventListener('scroll', resize, true)
    return () => { observer.disconnect(); window.removeEventListener('resize', resize); window.removeEventListener('scroll', resize, true) }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !ref.current?.contains(event.target) && !popover.current?.contains(event.target)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return <div className="execution-bar" ref={ref}>
    <div className={`execution-status execution-${status.tone}`} role="status" aria-live="polite" aria-atomic="true">
      {status.tone === 'attention' || status.tone === 'failed' ? <CircleAlert size={13} /> : busy ? null : conversation.summary?.status === 'cancelled' ? <Square size={10} /> : <Check size={13} />}
      <span className={busy && status.tone === 'working' ? 'text-sweep' : undefined} title={visibleStatus.label}>{visibleStatus.label}</span>
    </div>
    {plan.length > 0 && <>
      <button ref={trigger} type="button" className="plan-trigger" aria-label="View task plan" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(value => !value)}>
        <ListChecks size={14} /><span>Plan</span><span className="plan-count">{completed}/{plan.length}</span><ChevronRight size={12} className="disclosure-icon" />
      </button>
      {open && createPortal(<section ref={popover} id={panelId} className="plan-popover" role="region" aria-label="Task plan" style={{ position: 'fixed', ...position, maxHeight: panelHeight }}>
        <div className="plan-heading"><span>Task plan</span><span className="plan-count">{completed}/{plan.length}</span>
          <button type="button" className="plan-close" aria-label="Close task plan" onClick={() => { setOpen(false); trigger.current?.focus() }}><X size={14} /></button>
        </div>
        <PlanSteps plan={plan} />
      </section>, document.body)}
    </>}
  </div>
}
