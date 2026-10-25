import { isBusy, isChildAgent, type Conversation, type DisplayMessage, type TurnExecution } from './state'
import { groupTranscript, type ToolGroup } from './toolPresentation'

export type TranscriptItem = DisplayMessage | ToolGroup
export interface TranscriptTurn {
  id: string
  items: TranscriptItem[]
  execution?: TurnExecution
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
  return [...sections].map(([id, messages]) => {
    const execution = conversation.turnsById[id]
    const running = !startingTurn && id === conversation.activeTurnId && isBusy(conversation.summary?.status) && (!execution || execution.status === 'running')
    let finalMessageId = execution?.finalMessageId
    if (!finalMessageId && !execution && !running) {
      // Older snapshots have no phase or turn timing. Keep the last main answer
      // after the main tools visible, but never invent a final answer for a
      // failed/interrupted turn. Live responses require AssistantTextCompleted.
      const interrupted = messages.some(message => message.role === 'system' && !isChildAgent(message.agent_id) && (message.error || message.status === 'failed' || message.status === 'cancelled'))
        || id === conversation.activeTurnId && ['failed', 'cancelled'].includes(conversation.summary?.status || '')
      const lastAnswer = messages.reduce((last, message, index) => message.role === 'assistant' && !isChildAgent(message.agent_id) ? index : last, -1)
      const lastTool = messages.reduce((last, message, index) => message.role === 'tool' && !isChildAgent(message.agent_id) ? index : last, -1)
      if (!interrupted && lastAnswer > lastTool) finalMessageId = messages[lastAnswer]?.id
    }
    const items = groupTranscript(messages, planTurns)
    const process = items.filter(item => isProcessItem(item, finalMessageId))
    const hasProcess = process.some(item => item.role === 'tool-group' || isChildAgent(item.agent_id))
      || process.length > 1 || Boolean(finalMessageId && process.length)
    return { id, items, execution, finalMessageId, running, hasProcess }
  })
}

export function processLabel(execution?: TurnExecution): string {
  if (execution?.startedAt === undefined || execution.finishedAt === undefined) return '执行过程'
  const seconds = Math.max(1, Math.round((execution.finishedAt - execution.startedAt) / 1000))
  if (seconds < 60) return '用时 ' + seconds + ' 秒'
  if (seconds < 3600) return '用时 ' + Math.floor(seconds / 60) + ' 分 ' + seconds % 60 + ' 秒'
  return '用时 ' + Math.floor(seconds / 3600) + ' 小时 ' + Math.floor(seconds % 3600 / 60) + ' 分'
}
