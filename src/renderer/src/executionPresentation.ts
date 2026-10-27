import { isBusy, isChildAgent, toolStatus, type Conversation } from './state'

export function presentExecution(conversation: Conversation) {
  const status = conversation.summary?.status
  if (status === 'stopping') return { label: 'Stopping…', tone: 'working' }
  if (conversation.approvals.length) return { label: 'Awaiting approval', tone: 'attention' }
  if (status === 'failed') return { label: 'Task failed', tone: 'failed' }
  if (status === 'cancelled') return { label: 'Stopped', tone: 'idle' }
  if (!isBusy(status)) return { label: 'Task completed', tone: 'idle' }
  if (conversation.activity === 'Compacting context') return { label: 'Compacting context…', tone: 'working' }
  if (conversation.activity === 'Finishing task') return { label: 'Finishing task…', tone: 'working' }
  if (conversation.activity === 'Responding') return { label: 'Responding…', tone: 'working' }

  // Prefer the current task step to rapidly changing individual tool names.
  const step = conversation.plan.find(item => item.status === 'in_progress')
  if (step) return { label: step.description, tone: 'working' }
  const activeTools = conversation.messages.filter(message => message.role === 'tool'
    && message.turn_id === conversation.activeTurnId
    && ['pending', 'running'].includes(toolStatus(message) || ''))
  const rootTools = activeTools.filter(message => !isChildAgent(message.agent_id))
  if (!rootTools.length && activeTools.length) return { label: 'Running subtasks…', tone: 'working' }
  if (rootTools.length) {
    const names = rootTools.map(message => message.tool_name)
    if (names.every(name => ['read_file', 'list_files', 'find_files', 'search_text'].includes(name || ''))) return { label: 'Reading project files…', tone: 'working' }
    if (names.every(name => ['run_command', 'wait_command'].includes(name || ''))) return { label: 'Running commands…', tone: 'working' }
    if (names.every(name => ['edit_file', 'write_file'].includes(name || ''))) return { label: 'Editing files…', tone: 'working' }
    if (names.every(name => ['search_tools', 'activate_tools'].includes(name || ''))) return { label: 'Preparing tools…', tone: 'working' }
    return { label: 'Working…', tone: 'working' }
  }
  return { label: 'Working…', tone: 'working' }
}
