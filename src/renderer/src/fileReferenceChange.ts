import type { TurnChanges } from './changeSummary'
import { contentLink } from './fileLinks'

function fileUrlPath(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.hostname && url.hostname !== 'localhost' || url.search || /%2f|%5c/i.test(url.pathname)) return
    return decodeURIComponent(url.pathname)
  } catch { return }
}

/** Compare local paths only; actual filesystem access remains in the main process. */
function pathKey(path: string, workspace: string): string | undefined {
  let value = /^file:/i.test(path) ? fileUrlPath(path) : path
  if (value === undefined || /[\u0000-\u001f]/.test(value)) return
  value = value.replaceAll('\\', '/').replace(/^\/(?=[a-z]:\/)/i, '')
  if (value.startsWith('//')) return
  if (!/^[a-z]:\//i.test(value) && !value.startsWith('/')) {
    if (!workspace) return
    value = `${workspace.replaceAll('\\', '/').replace(/\/$/, '')}/${value}`
  }
  value = value.replace(/^\/(?=[a-z]:\/)/i, '')
  const drive = /^[a-z]:\//i.exec(value)?.[0]
  const prefix = drive || (value.startsWith('/') ? '/' : '')
  const parts: string[] = []
  for (const part of value.slice(prefix.length).split('/')) {
    if (!part || part === '.') continue
    if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop()
    else if (part !== '..' || !prefix) parts.push(part)
  }
  const key = prefix + parts.join('/')
  return drive ? key.toLowerCase() : key
}

function referenceKeys(path: string, workspace: string): string[] {
  if (contentLink(path)?.kind !== 'file') return []
  const fileUrl = /^file:/i.test(path)
  const value = fileUrl ? fileUrlPath(path) : path
  if (value === undefined) return []
  // Preserve literal filenames before trying URL encoding and line fragments,
  // matching the order used by the real file preview resolver.
  const candidates = [value]
  try { candidates.push(decodeURIComponent(value)) } catch { /* Literal percent signs are valid. */ }
  candidates.push(...candidates.map(candidate => candidate.replace(/(?::\d+(?::\d+)?|#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?)$/i, '')))
  if (!fileUrl && value.includes('#')) {
    const documentPath = value.slice(0, value.indexOf('#'))
    candidates.push(documentPath)
    try { candidates.push(decodeURIComponent(documentPath)) } catch { /* Keep the literal candidate. */ }
  }
  return [...new Set(candidates.map(candidate => pathKey(candidate, workspace)).filter((key): key is string => key !== undefined))]
}

export function fileReferenceChange(path: string, workspace: string, changes: TurnChanges | undefined, available: boolean) {
  if (!available || !changes) return
  for (const key of referenceKeys(path, workspace)) {
    const matches = changes.files.filter(file => file.previewPath && pathKey(file.previewPath, workspace) === key)
    if (matches.length > 1) return
    if (matches.length === 1) return { turnId: changes.turnId, file: matches[0] }
  }
}
