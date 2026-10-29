import { isBusy, type Conversation } from './state'
import { mainAgentMessages } from './agentPresentation'
import { assistantDisplayText } from './messagePresentation'
import { groupTranscript, presentTool } from './toolPresentation'

// A footer is needed only when neither an action, a response, nor a dedicated
// approval control already explains the current execution phase.
export function presentExecution(conversation: Conversation): { label: string; tone: string } | undefined {
  const status = conversation.summary?.status
  const turnId = conversation.summary?.active_turn?.id || conversation.activeTurnId
  const execution = turnId ? conversation.turnsById[turnId] : undefined
  if (execution && execution.status !== 'running') return undefined
  if (conversation.approvals.length) return undefined
  if (status === 'stopping') return { label: 'Stopping', tone: 'working' }
  if (!isBusy(status)) return undefined

  const messages = mainAgentMessages(conversation).filter(message => message.turn_id === turnId)
  const items = groupTranscript(messages)
  const hasActiveTool = items.some(item => {
    const calls = item.role === 'tool-group' ? item.messages : item.role === 'tool' ? [item] : []
    return calls.some(message => ['Running', 'Queued'].includes(presentTool(message).status))
  })
  if (hasActiveTool) return undefined
  const response = [...messages].reverse().find(message => message.role === 'assistant')
  if (conversation.activity === 'Responding' && response
    && assistantDisplayText(response.content, response.status === 'streaming', response.source === 'agent').trim()) return undefined

  if (conversation.activity === 'Compacting context') return { label: 'Compacting context', tone: 'working' }
  return { label: 'Working', tone: 'working' }
}
