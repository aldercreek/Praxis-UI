import { isBusy, isChildAgent, type Conversation, type DisplayMessage, type TurnExecution } from './state'
import { groupTranscript, type ToolGroup } from './toolPresentation'

export type TranscriptItem = DisplayMessage | ToolGroup
export interface TranscriptTurn {
  id: string
  items: TranscriptItem[]
  execution?: TurnExecution
  outcome: TurnExecution['status']
  finalMessageId?: string
  running: boolean
  hasProcess: boolean
}

export function isProcessItem(item: TranscriptItem, finalMessageId?: string): boolean {
  if (item.role === 'tool-group') return true
  if (item.role === 'user' || item.id === finalMessageId) return false
  // Errors and cancellation notices remain visible after a process is folded.
  if (item.role === 'system' && (item.error || item.status === 'failed' || item.status === 'cancelled')) return false
  return item.role !== 'system' || isChildAgent(item.agent_id)
}

function isMainBody(item: TranscriptItem): item is DisplayMessage {
  return item.role === 'assistant' && !isChildAgent(item.agent_id) && Boolean(item.content.trim())
}

// These are reading anchors, not final-answer markers. In particular, a failed
// turn can retain useful partial prose without presenting it as a final answer.
export function visibleBodyIds(turn: TranscriptTurn): ReadonlySet<string> {
  const bodies = turn.items.filter(isMainBody)
  if (turn.running) return new Set(bodies.map(item => item.id))
  const longest = Math.max(0, ...bodies.map(item => item.content.trim().length))
  const last = bodies.at(-1)
  return new Set(bodies.filter(item => item === last || item.content.trim().length === longest).map(item => item.id))
}

export function completedLabel(execution?: TurnExecution): string {
  const label = execution?.status === 'failed' ? 'Failed'
    : execution?.status === 'cancelled' ? 'Cancelled'
    : execution?.status === 'running' ? 'Running' : 'Completed'
  const start = execution?.startedAt
  const end = execution?.finishedAt
  if (start === undefined || end === undefined || !Number.isFinite(start) || !Number.isFinite(end) || end < start) return label
  const elapsed = end - start
  const seconds = Math.floor(elapsed / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const duration = hours > 0 ? `${hours}h${minutes % 60 ? `${minutes % 60}m` : ''}`
    : minutes > 0 ? `${minutes}m${seconds % 60 ? `${seconds % 60}s` : ''}`
    : elapsed > 0 && seconds === 0 ? '<1s' : `${seconds}s`
  return `${label} ${duration}`
}

function turnOutcome(conversation: Conversation, id: string, messages: DisplayMessage[], running: boolean): TurnExecution['status'] {
  const execution = conversation.turnsById[id]
  if (execution) return execution.status
  if (running) return 'running'
  const latest = conversation.summary?.latest_turn
  if (latest?.id === id) return latest.status
  const notice = [...messages].reverse().find(message => message.role === 'system' && !isChildAgent(message.agent_id)
    && (message.error || message.status === 'failed' || message.status === 'cancelled'))
  if (notice) return notice.status === 'cancelled' ? 'cancelled' : 'failed'
  const status = conversation.summary?.status
  if (id === conversation.activeTurnId && (status === 'failed' || status === 'cancelled')) return status
  return 'completed'
}

export function presentTranscript(conversation: Conversation): TranscriptTurn[] {
  const sections = new Map<string, DisplayMessage[]>()
  const startingTurn = conversation.messages.some(message => message.role === 'user' && !message.turn_id && message.status === 'sending')
  for (const message of conversation.messages) {
    if (message.role === 'assistant' && !message.content.trim()) continue
    const id = message.turn_id || 'message:' + message.id
    const messages = sections.get(id)
    if (messages) messages.push(message)
    else sections.set(id, [message])
  }
  const planTurns = new Set(Object.keys(conversation.plansByTurn).filter(id => conversation.plansByTurn[id].length))
  const activeTurnId = conversation.summary?.active_turn?.id || conversation.activeTurnId
  return [...sections].map(([id, messages]) => {
    const execution = conversation.turnsById[id]
    // A final answer confirms its text and duration before service cleanup ends.
    // Keep the process visible until settlement, using the server's active turn
    // so the next turn cannot reopen the previous process before TurnStarted.
    const running = !startingTurn && id === activeTurnId && isBusy(conversation.summary?.status)
    const outcome = turnOutcome(conversation, id, messages, running)
    let finalMessageId = execution?.finalMessageId
    if (!finalMessageId && !execution && !running) {
      // Older snapshots have no phase or turn timing. Keep the last main answer
      // after the main tools visible, but never invent a final answer for a
      // failed/interrupted turn. Live responses require AssistantTextCompleted.
      const interrupted = outcome === 'failed' || outcome === 'cancelled'
      const lastAnswer = messages.reduce((last, message, index) => message.role === 'assistant' && !isChildAgent(message.agent_id) ? index : last, -1)
      const lastTool = messages.reduce((last, message, index) => message.role === 'tool' && !isChildAgent(message.agent_id) ? index : last, -1)
      if (!interrupted && lastAnswer > lastTool) finalMessageId = messages[lastAnswer]?.id
    }
    const items = groupTranscript(messages, planTurns)
    const process = items.filter(item => isProcessItem(item, finalMessageId))
    const hasProcess = process.some(item => item.role === 'tool-group' || isChildAgent(item.agent_id))
      || process.length > 1 || Boolean(finalMessageId && process.length)
    return { id, items, execution, outcome, finalMessageId, running, hasProcess }
  })
}

export function processLabel(execution?: TurnExecution): string {
  if (execution?.startedAt === undefined || execution.finishedAt === undefined) return 'Process'
  const seconds = Math.max(1, Math.round((execution.finishedAt - execution.startedAt) / 1000))
  if (seconds < 60) return `Elapsed ${seconds}s`
  if (seconds < 3600) return `Elapsed ${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `Elapsed ${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`
}
