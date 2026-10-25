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

export function collectTurnChanges(messages: DisplayMessage[], workspace: string): TurnChanges[] {
  const turns = new Map<string, Map<string, ChangedFile>>()
  const seen = new Set<string>()
  for (const message of messages) {
    const change = message.file_change
    if (message.role !== 'tool' || !message.turn_id || !change?.path || !change.diff || message.tool_finished === false || seen.has(message.id)) continue
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
