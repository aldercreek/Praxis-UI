import { isChildAgent, textOf, type DisplayMessage } from './state'

const actions: Record<string, [string, string]> = {
  read_file: ['Read', 'Reading'],
  list_files: ['Listed', 'Listing'],
  find_files: ['Searched files', 'Finding files'],
  search_text: ['Searched', 'Searching'],
  edit_file: ['Edited', 'Editing'],
  write_file: ['Wrote', 'Writing'],
  run_command: ['Ran', 'Running']
}

const pendingActions: Record<string, string> = {
  read_file: 'Read', list_files: 'List', find_files: 'Find files', search_text: 'Search',
  edit_file: 'Edit', write_file: 'Write', run_command: 'Run'
}

export function presentTool(message: DisplayMessage) {
  const argument = message.arguments || {}
  const name = message.tool_name || (message.command ? 'run_command' : 'Tool')
  const status = message.status === 'denied' ? 'Denied'
    : message.status === 'cancelled' ? 'Stopped'
    : message.error || message.status === 'failed' ? 'Failed'
    : message.status === 'approval' ? 'Awaiting approval'
    : message.status === 'running' ? 'Running'
    : message.status === 'pending' ? 'Queued'
    : message.status === 'complete' || message.status === 'completed' ? 'Complete' : 'Unknown'
  const running = status === 'Running'
  const action = actions[name]
  const label = action ? running ? action[1] : status === 'Complete' ? action[0] : pendingActions[name] : name
  const command = message.command || textOf(argument.command) || (Array.isArray(argument.argv) ? argument.argv.map(textOf).join(' ') : '')
  const path = textOf(argument.relative_path ?? argument.path ?? argument.file_path ?? message.file_change?.path)
  let target = ''
  let context = ''
  let fullTarget = ''

  if (name === 'run_command') {
    fullTarget = command
    target = command.split(/\r?\n/, 1)[0]
  } else if (name === 'search_text' || name === 'find_files') {
    target = textOf(argument.pattern ?? argument.query ?? argument.file_pattern)
    context = path && path !== '.' ? path : ''
    fullTarget = [target, context].filter(Boolean).join(' · ')
  } else if (path) {
    const normalized = path.replace(/\\/g, '/').replace(/\/$/, '')
    const slash = normalized.lastIndexOf('/')
    target = path === '.' ? 'workspace' : normalized.slice(slash + 1) || path
    context = slash > 0 ? normalized.slice(0, slash) : ''
    if (name === 'read_file' && typeof argument.start_line === 'number') {
      target += `:${argument.start_line}${typeof argument.end_line === 'number' ? `–${argument.end_line}` : ''}`
    }
    fullTarget = path
  } else if (name === 'list_files') {
    target = 'workspace'
  } else {
    fullTarget = textOf(argument.query ?? argument.url ?? argument.command ?? argument.description ?? '')
    target = fullTarget.split(/\r?\n/, 1)[0]
  }

  return { name, label, target, context, fullTarget, command, status, running }
}

export interface ToolGroup {
  id: string
  role: 'tool-group'
  messages: DisplayMessage[]
}

const explorationTools = new Set(['read_file', 'list_files', 'find_files', 'search_text'])
const completedExploration = (message: DisplayMessage) => message.role === 'tool'
  && explorationTools.has(message.tool_name || '') && !message.error
  && (message.status === 'complete' || message.status === 'completed')
const agent = (message: DisplayMessage) => isChildAgent(message.agent_id) ? message.agent_id : 'main'

// Only collapse consecutive, successful reads from the same turn and agent.
// Commands, edits, approvals and unfinished/failed work always stay visible.
export function groupTranscript(messages: DisplayMessage[]): (DisplayMessage | ToolGroup)[] {
  const items: (DisplayMessage | ToolGroup)[] = []
  let index = 0
  while (index < messages.length) {
    const first = messages[index]
    let end = index + 1
    if (completedExploration(first)) {
      while (end < messages.length && completedExploration(messages[end])
        && messages[end].turn_id === first.turn_id && messages[end].child_turn_id === first.child_turn_id
        && agent(messages[end]) === agent(first)) end += 1
    }
    if (end - index >= 3) items.push({ id: `group:${first.id}`, role: 'tool-group', messages: messages.slice(index, end) })
    else items.push(...messages.slice(index, end))
    index = end
  }
  return items
}
