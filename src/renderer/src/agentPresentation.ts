import type { PraxisEvent } from '../../shared/protocol'
import type { Conversation, DisplayMessage } from './state'
import { assistantDisplayText } from './messagePresentation'

export type AgentStatus = 'queued' | 'running' | 'returned' | 'closing' | 'closed' | 'failed' | 'stopped' | 'unknown'
export interface AgentExecution {
  id: string
  turnId: string
  title?: string
  status: AgentStatus
  childTurnId?: string
}
export interface AgentTask extends AgentExecution {
  key: string
  messages: DisplayMessage[]
  attention: boolean
}
export const agentKey = (turnId: string, id: string) => JSON.stringify([turnId, id])
const child = (id?: string) => Boolean(id && id !== 'main' && id !== 'root')
const active = (status: AgentStatus) => ['queued', 'running', 'closing'].includes(status)
const statusOf = (status?: string): AgentStatus => ({ idle: 'returned', cancelled: 'stopped', completed: 'returned', complete: 'returned' }[status || ''] as AgentStatus)
  || (['queued', 'running', 'closing', 'closed', 'failed'].includes(status || '') ? status as AgentStatus : 'unknown')

// Replay just lifecycle facts from the journal. Transcript messages already have
// their own projection; replaying them would duplicate responses on reconnect.
export function applyAgentEvent(current: Record<string, AgentExecution>, event: PraxisEvent): Record<string, AgentExecution> {
  const { event: kind, data, turn_id: turnId = '', agent_id: id = 'main' } = event
  if (!child(id)) {
    if (!['TurnCancelled', 'TurnSettled'].includes(kind)) return current
    const entries = Object.entries(current).map(([key, agent]) => [key, agent.turnId === turnId && active(agent.status)
      ? { ...agent, status: kind === 'TurnCancelled' || data.status === 'cancelled' ? 'stopped' : data.status === 'failed' ? 'failed' : 'closed' } : agent])
    return Object.fromEntries(entries)
  }
  const key = agentKey(turnId, id)
  const previous = current[key]
  let next: AgentExecution = previous || { id, turnId, status: 'unknown' }
  const run = typeof data.child_turn_id === 'string' ? data.child_turn_id : undefined
  switch (kind) {
    case 'ChildAgentStatus': {
      let status = statusOf(String(data.status || ''))
      // Worker cleanup emits idle/closed after errors. Preserve the actual
      // outcome until a new queued/running event starts another run.
      if (previous && ['failed', 'stopped'].includes(previous.status) && !['queued', 'running'].includes(status)) status = previous.status
      next = { ...next, status, title: typeof data.task_summary === 'string' && data.task_summary ? data.task_summary : next.title }
      break
    }
    case 'TurnStarted': next = { ...next, status: 'running', childTurnId: run }; break
    case 'TurnFailed':
    case 'TurnCancelled':
    case 'TurnCompleted':
      if (run && previous?.childTurnId && run !== previous.childTurnId) return current
      next = { ...next, status: kind === 'TurnFailed' ? 'failed' : kind === 'TurnCancelled' ? 'stopped' : 'returned' }
      break
    case 'ChildAgentMessage':
      if (!previous || previous.status === 'unknown') next = { ...next, status: 'returned' }
      break
    default: return current
  }
  return { ...current, [key]: next }
}

export function collectAgents(conversation: Conversation): AgentTask[] {
  const tasks = new Map<string, AgentTask>()
  for (const message of conversation.messages) {
    if (!child(message.agent_id)) continue
    const key = agentKey(message.turn_id || '', message.agent_id!)
    let task = tasks.get(key)
    if (!task) {
      task = { key, id: message.agent_id!, turnId: message.turn_id || '', status: 'unknown', messages: [], attention: false }
      tasks.set(key, task)
    }
    if (message.id.startsWith('agent:')) {
      task.title = message.content
      task.status = statusOf(message.status)
    } else {
      task.messages.push(message)
      if (message.role === 'system' && (message.error || message.status === 'failed')) task.status = 'failed'
      else if (message.role === 'assistant' && task.status === 'unknown') task.status = message.status === 'streaming' ? 'running' : 'returned'
    }
  }
  for (const [key, execution] of Object.entries(conversation.agentExecutions || {})) {
    const task = tasks.get(key)
    tasks.set(key, { ...task, ...execution, title: execution.title || task?.title, key, messages: task?.messages || [], attention: false })
  }
  const currentTurn = conversation.summary?.active_turn?.id || conversation.activeTurnId
  for (const task of tasks.values()) {
    task.title ||= task.messages.find(message => message.role === 'user')?.content.split('\n')[0] || 'Agent task'
    task.attention = conversation.approvals.some(approval => approval.agent_id === task.id && approval.turn_id === task.turnId)
    // Older services may have no journal. Don't leave historical workers
    // spinning forever, and don't claim that missing outcomes were successful.
    if (active(task.status) && (task.turnId !== currentTurn || !['running', 'stopping'].includes(conversation.summary?.status || ''))) task.status = 'unknown'
    // A worker report repeats its final model response, sometimes with a
    // transport wrapper. Keep one copy per run, but retain repeated follow-ups.
    let lastResponse = ''
    task.messages = task.messages.filter(message => {
      if (message.role === 'user') lastResponse = ''
      if (message.role !== 'assistant') return true
      const text = assistantDisplayText(message.content, false, message.source === 'agent').trim()
      if (message.source === 'agent' && text && text === lastResponse) return false
      lastResponse = text
      return Boolean(text) || message.status === 'streaming'
    })
  }
  return [...tasks.values()].sort((a, b) => Number(b.turnId === currentTurn) - Number(a.turnId === currentTurn))
}

export function agentStatusLabel(task: AgentTask): string {
  if (task.attention) return 'Needs approval'
  return { queued: 'Queued', running: 'Running', returned: 'Returned', closing: 'Stopping', closed: 'Closed', failed: 'Failed', stopped: 'Stopped', unknown: 'Not running' }[task.status]
}

const coordinationTools = new Set(['spawn_agent', 'send_messages', 'wait_agents', 'close_agent'])
export function mainAgentMessages(conversation: Conversation): DisplayMessage[] {
  const agents = collectAgents(conversation)
  return conversation.messages.filter(message => {
    if (child(message.agent_id)) return false
    if (message.role !== 'tool' || !coordinationTools.has(message.tool_name || '') || message.error
      || !['complete', 'completed', 'running', 'pending'].includes(message.status || '')) return true
    const candidates = agents.filter(agent => agent.turnId === (message.turn_id || ''))
    if (!candidates.length) return true
    // A batch can partially fail while the tool call itself succeeds. Hide it
    // only when every target and successful delivery is represented here.
    let result = message.structured_output
    if (!result || !Object.keys(result).length) {
      try { result = JSON.parse(message.content) } catch { result = undefined }
    }
    if (message.tool_name === 'send_messages' && ['complete', 'completed'].includes(message.status || '')) {
      if (!Array.isArray(result?.results) || !result.results.length
        || result.results.some(item => !item || typeof item !== 'object' || item.accepted !== true)) return true
    }
    const args = message.arguments
    const ids: unknown[] = message.tool_name === 'spawn_agent' ? [result?.agent_id]
      : message.tool_name === 'send_messages' ? Array.isArray(args?.messages) ? args.messages.map(item => item?.agent_id) : []
      : message.tool_name === 'wait_agents' ? Array.isArray(args?.agent_ids) ? args.agent_ids : []
      : [args?.agent_id]
    return !ids.length || ids.some(id => typeof id !== 'string' || !candidates.some(agent => agent.id === id))
  })
}
