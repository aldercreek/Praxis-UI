import { useEffect, useId, useRef, useState, type ComponentPropsWithRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronRight, ListChecks, X } from './icons'
import { Disclosure } from './Disclosure'
import { presentExecution } from './executionPresentation'
import { type Conversation, type PlanStep } from './state'
import { useComposerPopover } from './useComposerPopover'

// Unknown statuses read as not started instead of borrowing another state.
const planState = (status: string) => status === 'completed' ? 'completed' : status === 'in_progress' ? 'in_progress' : 'pending'
const stateLabels = { completed: 'Completed', in_progress: 'In progress', pending: 'Pending' }

// Markers fill as a step advances, from a ring to a ring with a center to a
// disk, so the state never depends on color alone.
export function PlanSteps({ plan, ...props }: { plan: PlanStep[] } & ComponentPropsWithRef<'ol'>) {
  return <ol className="plan-steps" {...props}>{plan.map((step, index) => {
    const state = planState(step.status)
    return <li key={index} className={state} aria-current={state === 'in_progress' ? 'step' : undefined} aria-label={`${stateLabels[state]}: ${step.description}`}>
      <span className="plan-marker" aria-hidden="true">{state === 'completed' && <Check size={14} />}</span>
      <span>{step.description}</span>
    </li>
  })}</ol>
}

export function TurnPlan({ turnId, plan }: { turnId: string; plan: PlanStep[] }) {
  const completed = plan.filter(step => step.status === 'completed').length
  return <Disclosure className="turn-plan" storageKey={`plan:${turnId}`}>
    <summary><ListChecks size={14} /><span>Plan</span><span className="plan-count">{completed}/{plan.length}</span><ChevronRight size={12} className="disclosure-icon" /></summary>
    <PlanSteps plan={plan} />
  </Disclosure>
}

export function ExecutionStatus({ conversation, pending = false }: { conversation: Conversation; pending?: boolean }) {
  const status = pending ? { label: 'Working', tone: 'working' } : presentExecution(conversation)
  return status && <div className={`execution-status execution-${status.tone}`} role="status" aria-live="polite" aria-atomic="true">
    <span className={status.tone === 'working' ? 'text-sweep' : undefined}>{status.label}</span>
  </div>
}

export function ExecutionBar({ plan, leading }: { plan: PlanStep[]; leading?: ReactNode }) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const popover = useRef<HTMLElement>(null)
  const steps = useRef<HTMLOListElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const position = useComposerPopover(open, trigger, 'end', 360)
  const completed = plan.filter(step => step.status === 'completed').length

  // A new turn clears the plan. Its first update should not reopen the panel.
  useEffect(() => { if (!plan.length) setOpen(false) }, [plan.length])

  useEffect(() => {
    if (!open) return
    // Bring the current step into view once, after the popover has its final
    // height, keeping earlier steps above it. Later plan updates leave the
    // reader's scroll position alone.
    const frame = requestAnimationFrame(() => {
      const list = steps.current
      const next = list?.querySelector<HTMLElement>('[aria-current="step"]') ?? list?.querySelector<HTMLElement>('li.pending')
      if (list && next && next.offsetTop + next.offsetHeight > list.clientHeight) list.scrollTop = next.offsetTop - list.clientHeight / 3
    })
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !trigger.current?.contains(event.target) && !popover.current?.contains(event.target)) setOpen(false)
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
      cancelAnimationFrame(frame)
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!leading && !plan.length) return null
  return <div className="execution-bar">
    {leading}
    {plan.length > 0 && <>
      <button ref={trigger} type="button" className="plan-trigger" aria-label={`View task plan, ${completed} of ${plan.length} completed`} aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(value => !value)}>
        <ListChecks size={14} /><span>Plan</span><span className="plan-count">{completed}/{plan.length}</span><ChevronRight size={12} className="disclosure-icon" />
      </button>
      {open && createPortal(<section ref={popover} id={panelId} className="plan-popover" role="region" aria-label="Task plan" style={position}>
        <div className="plan-heading"><span className="plan-title">Task plan</span><span className="plan-count">{completed}/{plan.length}</span>
          <button type="button" className="plan-close" aria-label="Close task plan" onClick={() => { setOpen(false); trigger.current?.focus() }}><X size={14} /></button>
        </div>
        {/* The heading divider appears only once earlier steps scroll beneath it. */}
        <PlanSteps plan={plan} ref={steps} onScroll={event => event.currentTarget.toggleAttribute('data-scrolled', event.currentTarget.scrollTop > 0)} />
      </section>, document.body)}
    </>}
  </div>
}
