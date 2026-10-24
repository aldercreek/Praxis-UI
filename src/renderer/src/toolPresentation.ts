import { isChildAgent, textOf, toolStatus, type DisplayMessage } from './state'

export type ToolKind = 'read' | 'search' | 'edit' | 'command' | 'image' | 'tool'

const actions: Record<string, { verb: string; object: string; kind: ToolKind; group: string }> = {
  read_file: { verb: '读取', object: '文件', kind: 'read', group: '读取文件' },
  list_files: { verb: '列出', object: '工作目录', kind: 'read', group: '浏览目录' },
  find_files: { verb: '搜索文件', object: '', kind: 'search', group: '搜索文件' },
  search_text: { verb: '搜索', object: '内容', kind: 'search', group: '搜索内容' },
  edit_file: { verb: '编辑', object: '文件', kind: 'edit', group: '编辑文件' },
  write_file: { verb: '写入', object: '文件', kind: 'edit', group: '写入文件' },
  run_command: { verb: '运行', object: '命令', kind: 'command', group: '运行命令' },
  view_image: { verb: '查看图片', object: '', kind: 'image', group: '查看图片' },
  read_image: { verb: '查看图片', object: '', kind: 'image', group: '查看图片' }
}

const statusLabels = {
  Complete: '已完成', Running: '运行中', Queued: '等待执行',
  'Awaiting approval': '等待确认', Failed: '失败', Denied: '已拒绝', Stopped: '已停止', Unknown: '状态未知'
}

export function presentTool(message: DisplayMessage) {
  const argument = message.arguments || {}
  const name = message.tool_name || (message.command ? 'run_command' : 'Tool')
  const state = toolStatus(message)
  const status = state === 'denied' ? 'Denied'
    : state === 'cancelled' ? 'Stopped'
    : state === 'failed' ? 'Failed'
    : state === 'approval' ? 'Awaiting approval'
    : state === 'running' ? 'Running'
    : state === 'pending' ? 'Queued'
    : state === 'complete' || state === 'completed' ? 'Complete' : 'Unknown'
  const action = Object.hasOwn(actions, name) ? actions[name] : undefined
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

  return { name, summary, kind: action?.kind || 'tool' as ToolKind, target, fullTarget, command, status,
    statusLabel: statusLabels[status], running: status === 'Running' }
}

export interface ToolGroup {
  id: string
  role: 'tool-group'
  summary: string
  kind: ToolKind
  messages: DisplayMessage[]
}

const completedTool = (message: DisplayMessage) => message.role === 'tool'
  && Object.hasOwn(actions, message.tool_name || '') && message.tool_finished !== false
  && presentTool(message).status === 'Complete'
const agent = (message: DisplayMessage) => isChildAgent(message.agent_id) ? message.agent_id : 'main'

// Summarize only completed, known actions. Keep every underlying call in order,
// and never cross prose, turn or agent boundaries, or hide work needing attention.
export function groupTranscript(messages: DisplayMessage[]): (DisplayMessage | ToolGroup)[] {
  const items: (DisplayMessage | ToolGroup)[] = []
  let index = 0
  while (index < messages.length) {
    const first = messages[index]
    let end = index + 1
    if (completedTool(first)) {
      while (end < messages.length && completedTool(messages[end])
        && messages[end].turn_id === first.turn_id && messages[end].child_turn_id === first.child_turn_id
        && agent(messages[end]) === agent(first)) end += 1
    }
    if (end - index >= 3) {
      const grouped = messages.slice(index, end)
      const phrases = [...new Set(grouped.map(message => actions[message.tool_name!].group))]
      const summary = `已${phrases.length === 1 ? phrases[0] : `${phrases.slice(0, -1).join('、')}并${phrases.at(-1)}`} · ${grouped.length} 项操作`
      const kinds = new Set(grouped.map(message => actions[message.tool_name!].kind))
      items.push({ id: `group:${first.id}`, role: 'tool-group', summary,
        kind: kinds.size === 1 ? actions[first.tool_name!].kind : kinds.has('edit') ? 'edit' : 'tool', messages: grouped })
    } else items.push(...messages.slice(index, end))
    index = end
  }
  return items
}
