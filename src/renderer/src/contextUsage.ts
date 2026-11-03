import type { PraxisEvent } from '../../shared/protocol'

export interface ContextUsage { percent: number; estimated: number; limit: number; pressure: string; inputTokens?: number }

export const formatTokens = (tokens: number): string => `${(tokens / 1000).toFixed(1).replace(/\.0$/, '')}k`
export const contextColor = (pressure: string): string => pressure === 'soft' ? 'var(--warning)' : ['hard', 'emergency'].includes(pressure) ? 'var(--error)' : 'var(--muted)'
const validNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

export function updateContext(current: ContextUsage | undefined, event: PraxisEvent): ContextUsage | undefined {
  if (event.agent_id && event.agent_id !== 'main' && event.agent_id !== 'root') return current
  const data = event.data
  if (event.event === 'ModelRequestStarted') {
    const status = data.context_status as Record<string, unknown> | null | undefined
    if (status && validNumber(status.estimated_input_tokens) && validNumber(status.effective_input_limit_tokens)
      && status.effective_input_limit_tokens > 0 && validNumber(status.usage_percent)) {
      return { ...current, percent: status.usage_percent, estimated: status.estimated_input_tokens, limit: status.effective_input_limit_tokens, pressure: typeof status.pressure === 'string' ? status.pressure : 'normal' }
    }
  } else if (event.event === 'ModelRequestCompleted' && current) {
    const usage = data.usage as Record<string, unknown> | null | undefined
    if (validNumber(usage?.input_tokens)) return { ...current, inputTokens: usage.input_tokens }
  } else if (event.event === 'ContextCompaction' && data.stage === 'completed' && current && validNumber(data.after_tokens)) {
    const percent = data.after_tokens / current.limit * 100
    return { ...current, estimated: data.after_tokens, percent }
  }
  return current
}
