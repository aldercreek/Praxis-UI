import { isChildAgent, textOf, toolStatus, type DisplayMessage } from './state'

export type ToolKind = 'read' | 'search' | 'edit' | 'command' | 'image' | 'tool'
const actions: Record<string, { verb: string; running: string; completed: string; object: string; kind: ToolKind }> = {
  read_file: { verb: 'Read', running: 'Reading', completed: 'Read', object: 'file', kind: 'read' },
  list_files: { verb: 'List files in', running: 'Listing files in', completed: 'Listed files in', object: 'workspace', kind: 'read' },
  find_files: { verb: 'Search files', running: 'Searching files', completed: 'Searched files', object: '', kind: 'search' },
  search_text: { verb: 'Search', running: 'Searching', completed: 'Searched', object: 'text', kind: 'search' },
  search_tools: { verb: 'Search tools', running: 'Searching tools', completed: 'Searched tools', object: '', kind: 'search' },
  activate_tools: { verb: 'Enable tools', running: 'Enabling tools', completed: 'Enabled tools', object: '', kind: 'tool' },
  edit_file: { verb: 'Edit', running: 'Editing', completed: 'Edited', object: 'file', kind: 'edit' },
  write_file: { verb: 'Write', running: 'Writing', completed: 'Wrote', object: 'file', kind: 'edit' },
  run_command: { verb: 'Run', running: 'Running', completed: 'Ran', object: 'command', kind: 'command' },
  wait_command: { verb: 'Read', running: 'Reading', completed: 'Read', object: 'command output', kind: 'command' },
  view_image: { verb: 'View image', running: 'Viewing image', completed: 'Viewed image', object: '', kind: 'image' },
  read_image: { verb: 'View image', running: 'Viewing image', completed: 'Viewed image', object: '', kind: 'image' },
  update_plan: { verb: 'Update plan', running: 'Updating plan', completed: 'Updated plan', object: '', kind: 'tool' }
}

const statusLabels = {
  Complete: 'Completed', Running: 'Running', Queued: 'Queued',
  'Awaiting approval': 'Awaiting approval', Failed: 'Failed', Denied: 'Rejected', Stopped: 'Stopped', Unknown: 'Unknown status'
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
    target = [pattern, path && path !== '.' ? `(${path.replaceAll('\\', '/')})` : ''].filter(Boolean).join(' ')
    fullTarget = target
  } else if (path) {
    target = path === '.' ? 'workspace' : path.replaceAll('\\', '/')
    if (name === 'read_file' && typeof argument.start_line === 'number') {
      target += `:${argument.start_line}${typeof argument.end_line === 'number' ? `–${argument.end_line}` : ''}`
    }
    fullTarget = target
  } else if (name === 'list_files') {
    target = fullTarget = 'workspace'
  } else {
    fullTarget = textOf(argument.query ?? argument.url ?? argument.description ?? '')
    target = fullTarget.split(/\r?\n/, 1)[0]
  }

  const verb = action?.verb || 'Call'
  const subject = action ? target || action.object : [name, target].filter(Boolean).join(' · ')
  const suffix = subject ? ` ${subject}` : ''
  const operation = `${verb}${suffix}`
  const summary = status === 'Complete' ? `${action?.completed || 'Called'}${suffix}`
    : status === 'Running' ? `${action?.running || 'Calling'}${suffix}`
    : status === 'Failed' ? `Failed to ${verb.toLowerCase()}${suffix}`
    : status === 'Denied' ? `Rejected: ${operation}`
    : status === 'Stopped' ? `Stopped: ${operation}`
    : status === 'Awaiting approval' ? `Awaiting approval: ${operation}`
    : status === 'Queued' ? `Queued: ${operation}` : `${operation} (unknown status)`

  return { name, summary, operation, kind: action?.kind || 'tool' as ToolKind, target, fullTarget, command, status,
    statusLabel: statusLabels[status], running: status === 'Running' }
}

export interface ToolGroup {
  id: string
  role: 'tool-group'
  messages: DisplayMessage[]
}

const agent = (message: DisplayMessage) => isChildAgent(message.agent_id) ? message.agent_id : 'main'

function hidePlanCall(message: DisplayMessage, planTurnIds?: ReadonlySet<string>): boolean {
  if (message.tool_name !== 'update_plan') return false
  const status = presentTool(message).status
  if (status === 'Queued' || status === 'Running') return true
  return status === 'Complete' && message.tool_finished !== false && !isChildAgent(message.agent_id)
    && Boolean(message.turn_id && planTurnIds?.has(message.turn_id))
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
    if (grouped.length) items.push({ id: `group:${first.id}`, role: 'tool-group', messages: grouped })
    index = end
  }
  return items
}
