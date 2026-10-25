import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Check, ChevronRight, Circle, CircleAlert, ListChecks, LoaderCircle, Square, X } from 'lucide-react'
import { Disclosure } from './Disclosure'
import { presentExecution } from './executionPresentation'
import { isBusy, type Conversation, type PlanStep } from './state'

export function PlanSteps({ plan }: { plan: PlanStep[] }) {
  return <ol className="plan-steps">{plan.map((step, index) => <li key={index} className={step.status}
    aria-label={`${step.status === 'completed' ? '已完成' : step.status === 'in_progress' ? '当前步骤' : '待完成'}：${step.description}`}>
    {step.status === 'completed' ? <Check size={13} /> : step.status === 'in_progress' ? <span className="plan-current-dot" aria-hidden="true" /> : <Circle size={12} />}
    <span>{step.description}</span>
  </li>)}</ol>
}

export function TurnPlan({ turnId, plan }: { turnId: string; plan: PlanStep[] }) {
  const completed = plan.filter(step => step.status === 'completed').length
  return <Disclosure className="turn-plan" storageKey={`plan:${turnId}`}>
    <summary><ListChecks size={14} /><span>计划</span><span className="plan-count">{completed}/{plan.length}</span><ChevronRight size={12} className="disclosure-icon" /></summary>
    <PlanSteps plan={plan} />
  </Disclosure>
}

export function ExecutionBar({ conversation }: { conversation: Conversation }) {
  const [open, setOpen] = useState(false)
  const [panelHeight, setPanelHeight] = useState(360)
  const panelId = useId()
  const ref = useRef<HTMLDivElement>(null)
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
    const resize = () => setPanelHeight(Math.min(360, Math.max(0, ref.current!.getBoundingClientRect().top - 16)))
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(ref.current.closest('.composer-region') || ref.current)
    window.addEventListener('resize', resize)
    return () => { observer.disconnect(); window.removeEventListener('resize', resize) }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !ref.current?.contains(event.target)) setOpen(false)
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
      {status.tone === 'attention' || status.tone === 'failed' ? <CircleAlert size={13} /> : busy ? <LoaderCircle size={13} className="spin" /> : conversation.summary?.status === 'cancelled' ? <Square size={10} /> : <Check size={13} />}
      <span title={visibleStatus.label}>{visibleStatus.label}</span>
    </div>
    {plan.length > 0 && <>
      <button ref={trigger} type="button" className="plan-trigger" aria-label="查看任务计划" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(value => !value)}>
        <ListChecks size={14} /><span>计划</span><span className="plan-count">{completed}/{plan.length}</span><ChevronRight size={12} className="disclosure-icon" />
      </button>
      {open && <section id={panelId} className="plan-popover" role="region" aria-label="任务计划" style={{ maxHeight: panelHeight }}>
        <div className="plan-heading"><span>任务计划</span><span className="plan-count">{completed}/{plan.length}</span>
          <button type="button" className="plan-close" aria-label="收起任务计划" onClick={() => { setOpen(false); trigger.current?.focus() }}><X size={14} /></button>
        </div>
        <PlanSteps plan={plan} />
      </section>}
    </>}
  </div>
}
