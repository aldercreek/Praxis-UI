import { isChildAgent, type DisplayMessage } from './state'
import { isAbsoluteFileReference } from './fileLinks'

export interface FileEdit { id: string; diff: string; added: number; removed: number }
export interface ChangedFile { id: string; path: string; previewPath?: string; source?: string; edits: FileEdit[] }
export interface TurnChanges { turnId: string; files: ChangedFile[] }

export function fileChangePreviewPath(message: DisplayMessage): string | undefined {
  const path = message.file_change?.path
  // Child workspaces are not included in the current desktop event protocol.
  // A relative child path must never be opened against the parent's directory.
  return path && (!isChildAgent(message.agent_id) || isAbsoluteFileReference(path)) ? path : undefined
}

function pathKey(path: string, workspace: string): string {
  let normalized = path.replaceAll('\\', '/').replace(/^\.\//, '')
  const root = workspace.replaceAll('\\', '/').replace(/\/$/, '')
  const windows = /^[a-z]:/i.test(root)
  const comparable = windows ? normalized.toLowerCase() : normalized
  const prefix = `${windows ? root.toLowerCase() : root}/`
  if (root && comparable.startsWith(prefix)) normalized = normalized.slice(prefix.length)
  const parts: string[] = []
  for (const part of normalized.split('/')) {
    if (part === '.') continue
    if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop()
    else parts.push(part)
  }
  normalized = parts.join('/')
  return windows ? normalized.toLowerCase() : normalized
}

function hasFileChange(message: DisplayMessage): boolean {
  return message.role === 'tool' && Boolean(message.turn_id && message.file_change?.path && message.file_change.diff) && message.tool_finished !== false
}

export function createChangeCollector() {
  let root: string | undefined
  let previous: TurnChanges[] = []
  const cache = new Map<string, { messages: DisplayMessage[]; changes: TurnChanges }>()
  return (messages: DisplayMessage[], workspace: string): TurnChanges[] => {
    if (root !== workspace) { cache.clear(); root = workspace }
    const turns = new Map<string, DisplayMessage[]>()
    for (const message of messages) {
      if (!hasFileChange(message)) continue
      const turn = turns.get(message.turn_id!)
      if (turn) turn.push(message)
      else turns.set(message.turn_id!, [message])
    }
    for (const id of cache.keys()) if (!turns.has(id)) cache.delete(id)
    const changes = [...turns].map(([id, messages]) => {
      const cached = cache.get(id)
      if (cached && cached.messages.length === messages.length && cached.messages.every((message, index) => message === messages[index])) return cached.changes
      const changes = collectTurnChanges(messages, workspace)[0]
      cache.set(id, { messages, changes })
      return changes
    })
    if (changes.length === previous.length && changes.every((change, index) => change === previous[index])) return previous
    previous = changes
    return changes
  }
}

export function collectTurnChanges(messages: DisplayMessage[], workspace: string): TurnChanges[] {
  const turns = new Map<string, Map<string, ChangedFile>>()
  const seen = new Set<string>()
  for (const message of messages) {
    const change = message.file_change!
    if (!hasFileChange(message) || !message.turn_id || seen.has(message.id)) continue
    seen.add(message.id)
    let files = turns.get(message.turn_id)
    if (!files) { files = new Map(); turns.set(message.turn_id, files) }
    const previewPath = fileChangePreviewPath(message)
    const source = previewPath ? undefined : message.agent_id
    const key = previewPath ? pathKey(change.path, workspace) : `child:${source}:${message.child_turn_id || ''}:${pathKey(change.path, '')}`
    let file = files.get(key)
    if (!file) { file = { id: key, path: change.path, previewPath, source, edits: [] }; files.set(key, file) }
    // Each diff describes one edit. Summing these as a net diff would count
    // lines changed more than once, so retain the ordered edit history.
    file.edits.push({ id: message.id, diff: change.diff, added: change.added, removed: change.removed })
  }
  return [...turns].map(([turnId, files]) => ({ turnId, files: [...files.values()] }))
}
