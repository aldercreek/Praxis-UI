import { isBusy, isChildAgent, toolStatus, type Conversation } from './state'

export function presentExecution(conversation: Conversation) {
  const status = conversation.summary?.status
  if (status === 'stopping') return { label: '正在停止…', tone: 'working' }
  if (conversation.approvals.length) return { label: '等待你确认', tone: 'attention' }
  if (status === 'failed') return { label: '本轮执行失败', tone: 'failed' }
  if (status === 'cancelled') return { label: '已停止', tone: 'idle' }
  if (!isBusy(status)) return { label: '本轮已结束', tone: 'idle' }
  if (conversation.activity === 'Compacting context') return { label: '正在整理上下文…', tone: 'working' }
  if (conversation.activity === 'Finishing task') return { label: '正在收尾…', tone: 'working' }
  if (conversation.activity === 'Responding') return { label: '正在生成回复…', tone: 'working' }

  // Prefer the current task step to rapidly changing individual tool names.
  const step = conversation.plan.find(item => item.status === 'in_progress')
  if (step) return { label: step.description, tone: 'working' }
  const activeTools = conversation.messages.filter(message => message.role === 'tool'
    && message.turn_id === conversation.activeTurnId
    && ['pending', 'running'].includes(toolStatus(message) || ''))
  const rootTools = activeTools.filter(message => !isChildAgent(message.agent_id))
  if (!rootTools.length && activeTools.length) return { label: '正在执行子任务…', tone: 'working' }
  if (rootTools.length) {
    const names = rootTools.map(message => message.tool_name)
    if (names.every(name => ['read_file', 'list_files', 'find_files', 'search_text'].includes(name || ''))) return { label: '正在查看项目文件…', tone: 'working' }
    if (names.every(name => ['run_command', 'wait_command'].includes(name || ''))) return { label: '正在运行命令…', tone: 'working' }
    if (names.every(name => ['edit_file', 'write_file'].includes(name || ''))) return { label: '正在修改文件…', tone: 'working' }
    if (names.every(name => ['search_tools', 'activate_tools'].includes(name || ''))) return { label: '正在准备工具…', tone: 'working' }
    return { label: '正在执行操作…', tone: 'working' }
  }
  return { label: '正在处理…', tone: 'working' }
}
