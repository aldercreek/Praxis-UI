import { isChildAgent, textOf, toolStatus, type DisplayMessage } from './state'
import { assistantDisplayText } from './messagePresentation'

export type ToolKind = 'read' | 'search' | 'edit' | 'command' | 'image' | 'tool'
export type ToolIconKind = ToolKind | 'folder' | 'code' | 'connection' | 'plan'

export function toolFileLabel(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  return /^(?:[a-z]:\/|\/|file:)/i.test(normalized) ? normalized.split('/').slice(-2).join('/') : normalized.replace(/^\.\//, '')
}
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

function displayToolName(name: string): string {
  if (!name.startsWith('mcp_')) return name
  // Praxis adds a 12-digit digest when an MCP alias would exceed its name limit.
  // Keep the original identity in the details, not in the activity heading.
  return name.replace(/^mcp_+/, '').replace(/_[a-f0-9]{12}$/i, '').split(/__+/)
    .map(part => part.replaceAll('_', ' ')).join(' · ')
}

export function presentTool(message: DisplayMessage) {
  const argument = message.arguments || {}
  const name = toolName(message)
  const displayName = displayToolName(name)
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
  const commandText = command.trim()
  const script = name === 'run_command' && (/[\r\n]/.test(commandText) || /^@['"]$/.test(commandText))
  const description = name === 'run_command' ? textOf(argument.description).trim().replace(/\s+/g, ' ') : ''
  const path = textOf(argument.relative_path ?? argument.path ?? argument.file_path ?? message.file_change?.path)
  const icon: ToolIconKind = name === 'list_files' ? 'folder' : name === 'update_plan' ? 'plan'
    : name.startsWith('mcp_') ? 'connection' : name === 'run_code' ? 'code'
    : action?.kind === 'read' && /\.(?:[cm]?[jt]sx?|py|java|kt|go|rs|c|cpp|h|hpp|cs|rb|php|swift|sh|ps1|sql|vue|svelte)$/i.test(path) ? 'code'
    : action?.kind || 'tool'
  let target = ''
  let fullTarget = ''

  if (name === 'run_command') {
    fullTarget = command
    target = script ? 'script' : commandText
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
  const subject = action ? target || action.object : [displayName, target].filter(Boolean).join(' · ')
  const suffix = subject ? ` ${subject}` : ''
  const operation = description || `${verb}${suffix}`
  const summary = status === 'Complete' ? description || `${action?.completed || 'Called'}${suffix}`
    : status === 'Running' ? description ? `Running: ${description}` : `${action?.running || 'Calling'}${suffix}`
    : status === 'Failed' ? description ? `Failed: ${description}` : `Failed to ${verb.toLowerCase()}${suffix}`
    : status === 'Denied' ? `Rejected: ${operation}`
    : status === 'Stopped' ? `Stopped: ${operation}`
    : status === 'Awaiting approval' ? `Awaiting approval: ${operation}`
    : status === 'Queued' ? `Queued: ${operation}` : `${operation} (unknown status)`

  const caption = status === 'Running' || status === 'Queued' ? summary
    : name === 'run_command' ? description || (script ? 'Run script' : commandText || 'Run command')
    : textOf(argument.description) || (action?.kind === 'command' ? commandText || 'Run command' : summary)

  return { name, displayName, summary, caption, operation, icon, kind: action?.kind || 'tool' as ToolKind, target, fullTarget, command, status,
    statusLabel: statusLabels[status], running: status === 'Running' }
}

export interface ToolGroup {
  id: string
  role: 'tool-group'
  messages: DisplayMessage[]
}

type ToolEntry = { message: DisplayMessage; tool: ReturnType<typeof presentTool> }
type ActivityCategory = 'files' | 'edits' | 'commands' | 'code' | 'images' | 'discovery' | 'enabled' | 'plan' | 'tools'

function activityCategory({ tool }: ToolEntry): ActivityCategory {
  if (['read_file', 'list_files', 'find_files', 'search_text'].includes(tool.name)) return 'files'
  if (tool.name === 'run_code') return 'code'
  if (tool.name === 'search_tools') return 'discovery'
  if (tool.name === 'activate_tools') return 'enabled'
  if (tool.name === 'update_plan') return 'plan'
  return tool.kind === 'edit' ? 'edits' : tool.kind === 'command' ? 'commands' : tool.kind === 'image' ? 'images' : 'tools'
}

function activitySummary(entries: ToolEntry[]) {
  const categories: ActivityCategory[] = ['files', 'edits', 'commands', 'code', 'images', 'discovery', 'enabled', 'plan', 'tools']
  const complete = entries.every(entry => entry.tool.status === 'Complete')
  const parts = categories.flatMap(category => {
    const items = entries.filter(entry => activityCategory(entry) === category)
    if (!items.length) return []
    const plural = items.length > 1
    const allReads = items.every(entry => entry.tool.name === 'read_file')
    const onlyCommandOutput = items.every(entry => entry.tool.name === 'wait_command')
    const text = complete ? {
      files: allReads ? plural ? 'Read files' : 'Read a file' : 'Explored project files',
      edits: plural ? 'Edited files' : 'Edited a file', commands: onlyCommandOutput ? 'Read command output'
        : items.filter(entry => entry.tool.name === 'run_command').length === 1 ? 'Ran a command' : 'Ran commands',
      code: 'Ran code', images: plural ? 'Viewed images' : 'Viewed an image', discovery: 'Searched tools',
      enabled: 'Enabled tools', plan: 'Updated plan', tools: plural ? 'Called tools' : 'Called a tool'
    }[category] : {
      files: allReads ? 'File reads' : 'File exploration', edits: 'File changes', commands: 'Commands', code: 'Code execution',
      images: 'Images', discovery: 'Tool searches', enabled: 'Tool setup', plan: 'Plan updates', tools: 'Tool calls'
    }[category]
    const icon: ToolIconKind = { files: allReads ? 'read' : 'search', edits: 'edit', commands: 'command', code: 'code',
      images: 'image', discovery: 'search', enabled: 'tool', plan: 'plan', tools: 'tool' }[category] as ToolIconKind
    return [{ text, icon }]
  })
  const labels = parts.map((part, index) => index ? part.text[0].toLowerCase() + part.text.slice(1) : part.text)
  return { summary: labels.length < 2 ? labels[0] : `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`, icon: parts[0].icon }
}

export function presentToolGroup(group: ToolGroup, isCurrent = false) {
  const entries = group.messages.map(message => ({ message, tool: presentTool(message) }))
    .filter(entry => entry.tool.status !== 'Awaiting approval')
  if (!entries.length) return undefined
  const attention = entries.filter(entry => ['Failed', 'Denied', 'Stopped', 'Unknown'].includes(entry.tool.status))
  const live = isCurrent || entries.some(entry => entry.tool.running || entry.tool.status === 'Queued')
  return { ...activitySummary(entries), live,
    single: entries.length === 1, hasAttention: attention.length > 0, attention }
}

export function currentToolGroupId(items: (DisplayMessage | ToolGroup)[], running: boolean): string | undefined {
  if (!running) return undefined
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]
    if (item.role === 'tool-group') {
      if (!presentToolGroup(item)) continue
      return item.id
    }
    if (item.role === 'assistant' && !assistantDisplayText(item.content, item.status === 'streaming', item.source === 'agent').trim()) continue
    if (item.role === 'assistant' || item.role === 'tool') return undefined
  }
}

function standaloneTool(message: DisplayMessage): boolean {
  return message.tool_name === 'view_image' || message.tool_name === 'read_image'
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
    if (first.role !== 'tool' || standaloneTool(first)) {
      items.push(first)
      index += 1
      continue
    }
    let end = index + 1
    while (end < messages.length && messages[end].role === 'tool'
      && !standaloneTool(messages[end])
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
