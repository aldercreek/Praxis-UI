import { isChildAgent, textOf, toolStatus, type DisplayMessage } from './state'

export type ToolKind = 'read' | 'search' | 'edit' | 'command' | 'image' | 'tool'
type ToolCategory = 'exploration' | 'command' | 'edit' | 'image' | 'plan'
export type ToolAttention = 'failed' | 'approval' | 'denied' | 'cancelled'

const actions: Record<string, { verb: string; object: string; kind: ToolKind; category: ToolCategory }> = {
  read_file: { verb: '读取', object: '文件', kind: 'read', category: 'exploration' },
  list_files: { verb: '列出', object: '工作目录', kind: 'read', category: 'exploration' },
  find_files: { verb: '搜索文件', object: '', kind: 'search', category: 'exploration' },
  search_text: { verb: '搜索', object: '内容', kind: 'search', category: 'exploration' },
  search_tools: { verb: '查找工具', object: '', kind: 'search', category: 'exploration' },
  activate_tools: { verb: '启用工具', object: '', kind: 'tool', category: 'exploration' },
  edit_file: { verb: '编辑', object: '文件', kind: 'edit', category: 'edit' },
  write_file: { verb: '写入', object: '文件', kind: 'edit', category: 'edit' },
  run_command: { verb: '运行', object: '命令', kind: 'command', category: 'command' },
  wait_command: { verb: '获取', object: '命令输出', kind: 'command', category: 'command' },
  view_image: { verb: '查看图片', object: '', kind: 'image', category: 'image' },
  read_image: { verb: '查看图片', object: '', kind: 'image', category: 'image' },
  update_plan: { verb: '更新任务计划', object: '', kind: 'tool', category: 'plan' }
}

const statusLabels = {
  Complete: '已完成', Running: '运行中', Queued: '等待执行',
  'Awaiting approval': '等待确认', Failed: '失败', Denied: '已拒绝', Stopped: '已停止', Unknown: '状态未知'
}

const toolName = (message: DisplayMessage) => message.tool_name || (message.command ? 'run_command' : 'Tool')
const actionFor = (name: string) => Object.hasOwn(actions, name) ? actions[name] : undefined

export function presentTool(message: DisplayMessage) {
  const argument = message.arguments || {}
  const name = toolName(message)
  const state = toolStatus(message)
  const status = state === 'denied' ? 'Denied'
    : state === 'cancelled' ? 'Stopped'
    : state === 'failed' ? 'Failed'
    : state === 'approval' ? 'Awaiting approval'
    : state === 'running' ? 'Running'
    : state === 'pending' ? 'Queued'
    : state === 'complete' || state === 'completed' ? 'Complete' : 'Unknown'
  const action = actionFor(name)
  const command = message.command || textOf(argument.command) || (Array.isArray(argument.argv) ? argument.argv.map(textOf).join(' ') : '')
  const path = textOf(argument.relative_path ?? argument.path ?? argument.file_path ?? message.file_change?.path)
  let target = ''
  let fullTarget = ''

  if (name === 'run_command') {
    fullTarget = command
    target = command.split(/\r?\n/, 1)[0]
  } else if (name === 'search_text' || name === 'find_files') {
    const pattern = textOf(argument.pattern ?? argument.query ?? argument.file_pattern)
    target = [pattern, path && path !== '.' ? `（${path.replaceAll('\\', '/')}）` : ''].filter(Boolean).join(' ')
    fullTarget = target
  } else if (path) {
    target = path === '.' ? '工作目录' : path.replaceAll('\\', '/')
    if (name === 'read_file' && typeof argument.start_line === 'number') {
      target += `:${argument.start_line}${typeof argument.end_line === 'number' ? `–${argument.end_line}` : ''}`
    }
    fullTarget = target
  } else if (name === 'list_files') {
    target = fullTarget = '工作目录'
  } else {
    fullTarget = textOf(argument.query ?? argument.url ?? argument.description ?? '')
    target = fullTarget.split(/\r?\n/, 1)[0]
  }

  const verb = action?.verb || '调用'
  const subject = action ? target || action.object : [name, target].filter(Boolean).join(' · ')
  const operation = `${verb}${subject ? ` ${subject}` : ''}`
  const summary = status === 'Complete' ? `已${operation}`
    : status === 'Running' ? `正在${operation}`
    : status === 'Failed' ? `${verb}失败${subject ? `：${subject}` : ''}`
    : status === 'Denied' ? `已拒绝${operation}`
    : status === 'Stopped' ? `已停止${operation}`
    : status === 'Awaiting approval' ? `等待确认：${operation}`
    : status === 'Queued' ? `等待${operation}` : `${operation}（状态未知）`

  return { name, summary, operation, kind: action?.kind || 'tool' as ToolKind, target, fullTarget, command, status,
    statusLabel: statusLabels[status], running: status === 'Running' }
}

export interface ToolGroup {
  id: string
  role: 'tool-group'
  summary: string
  kind: ToolKind
  messages: DisplayMessage[]
  running: boolean
  attention: ToolAttention | undefined
  attentionLabel?: string
  attentionSummary?: string
}

const agent = (message: DisplayMessage) => isChildAgent(message.agent_id) ? message.agent_id : 'main'
const attentionStates: { attention: ToolAttention; status: string; label: string }[] = [
  { attention: 'failed', status: 'Failed', label: '失败' },
  { attention: 'approval', status: 'Awaiting approval', label: '待确认' },
  { attention: 'denied', status: 'Denied', label: '已拒绝' },
  { attention: 'cancelled', status: 'Stopped', label: '已停止' }
]

function hidePlanCall(message: DisplayMessage, planTurnIds?: ReadonlySet<string>): boolean {
  if (message.tool_name !== 'update_plan') return false
  const status = presentTool(message).status
  if (status === 'Queued' || status === 'Running') return true
  return status === 'Complete' && message.tool_finished !== false && !isChildAgent(message.agent_id)
    && Boolean(message.turn_id && planTurnIds?.has(message.turn_id))
}

function completedSummary(messages: DisplayMessage[]): string {
  const counts = new Map<string, DisplayMessage[]>()
  for (const message of messages) {
    const name = toolName(message)
    const key = ['edit_file', 'write_file'].includes(name) ? 'edit_file'
      : ['search_text', 'find_files'].includes(name) ? 'search_text'
      : ['view_image', 'read_image'].includes(name) ? 'view_image'
      : actionFor(name) ? name : 'external'
    counts.set(key, [...counts.get(key) || [], message])
  }
  return [...counts].flatMap(([name, calls]) => {
    if (name === 'read_file' || name === 'edit_file') {
      const paths = calls.map(call => textOf(call.arguments?.relative_path ?? call.arguments?.path ?? call.arguments?.file_path ?? call.file_change?.path).replaceAll('\\', '/'))
      const target = paths.every(Boolean) ? ' ' + new Set(paths).size + ' 个文件' : '文件'
      return [(name === 'read_file' ? '读取了' : '修改了') + target]
    }
    if (name === 'run_command') return ['运行了 ' + calls.length + ' 条命令']
    if (name === 'wait_command') return counts.has('run_command') ? [] : ['获取了命令输出']
    if (name === 'search_text') return ['进行了 ' + calls.length + ' 次搜索']
    if (name === 'view_image') return ['查看了 ' + calls.length + ' 次图片']
    return [{ list_files: '查看了目录', search_tools: '查找了工具', activate_tools: '启用了工具', update_plan: '更新了计划' }[name]
      || '调用了 ' + calls.length + ' 次工具']
  }).join('、')
}

function presentGroup(first: DisplayMessage, messages: DisplayMessage[]): ToolGroup {
  const tools = messages.map(presentTool)
  const active = tools.find(tool => tool.status === 'Running') || tools.find(tool => tool.status === 'Awaiting approval') || tools.find(tool => tool.status === 'Queued')
  const completed = messages.filter((message, index) => tools[index].status === 'Complete' && message.tool_finished !== false)
  const notices = attentionStates.flatMap(state => {
    const matches = tools.filter(tool => tool.status === state.status)
    return matches.length ? [{ attention: state.attention, summary: `${matches.length} 项${state.label}`, label: `${matches.length} 项${state.label}：${matches[0].operation}` }] : []
  })
  const summary = active?.summary || (messages.length === 1 ? tools[0].summary
    : completed.length ? completedSummary(completed) : tools.find(tool => tool.status !== 'Complete')?.summary || '执行了操作')
  return {
    id: `group:${first.id}`, role: 'tool-group', kind: active?.kind || tools[0].kind,
    summary, messages,
    running: tools.some(tool => tool.status === 'Running' || tool.status === 'Queued'),
    attention: notices[0]?.attention,
    ...(notices.length ? { attentionLabel: notices.map(notice => notice.label).join('；'), attentionSummary: notices.map(notice => notice.summary).join(' · ') } : {})
  }
}

// Establish groups before calls finish. Status changes must never move a call
// to another parent or change its group's identity and disclosure state.
export function groupTranscript(messages: DisplayMessage[], planTurnIds?: ReadonlySet<string>): (DisplayMessage | ToolGroup)[] {
  const items: (DisplayMessage | ToolGroup)[] = []
  let index = 0
  while (index < messages.length) {
    const first = messages[index]
    if (first.role !== 'tool') {
      items.push(first)
      index += 1
      continue
    }
    let end = index + 1
    while (end < messages.length && messages[end].role === 'tool'
      && messages[end].turn_id === first.turn_id && messages[end].child_turn_id === first.child_turn_id
      && agent(messages[end]) === agent(first)) end += 1
    // A stage can mix reads, edits and commands. Hidden plan metadata stays in
    // the interval, so resolving it cannot regroup or remount surrounding calls.
    const grouped = messages.slice(index, end).filter(message => !hidePlanCall(message, planTurnIds))
    if (grouped.length) items.push(presentGroup(first, grouped))
    index = end
  }
  return items
}
