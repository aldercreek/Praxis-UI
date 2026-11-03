import { contextColor, formatTokens, type ContextUsage } from './contextUsage'
import { Tooltip } from './Tooltip'
import './contextMeter.css'

export function ContextMeter({ context, activity }: { context?: ContextUsage; activity: string }) {
  if (!context) return null
  const compacting = activity === 'Compacting context'
  const label = compacting ? 'Compacting context…' : `Context ${Math.round(context.percent)}% used`
  const circumference = 2 * Math.PI * 6
  const content = compacting ? label : <><strong>{label}</strong><span>{formatTokens(context.estimated)} / {formatTokens(context.limit)} tokens (estimated)</span>{context.inputTokens !== undefined && <span>Last request: {formatTokens(context.inputTokens)} input tokens</span>}<span>Praxis compacts context automatically when it gets full.</span></>
  return <Tooltip content={content} className="context-tooltip" anchorClassName="context-meter-anchor">
    <span className={`context-meter ${compacting ? 'is-compacting' : ''}`} tabIndex={0} role="img" aria-label={label}>
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="6" fill="none" stroke="var(--border)" strokeWidth="2" />
        <circle cx="8" cy="8" r="6" fill="none" stroke={contextColor(context.pressure)} strokeWidth="2" strokeLinecap="round" transform="rotate(-90 8 8)"
          strokeDasharray={circumference} strokeDashoffset={circumference * (1 - (compacting ? .25 : Math.min(100, context.percent) / 100))} />
      </svg>
    </span>
  </Tooltip>
}
