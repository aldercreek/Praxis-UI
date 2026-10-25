import { realpathSync, statSync } from 'node:fs'
import { open, realpath, stat, type FileHandle } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FileActionResult, FilePreview, PraxisEvent } from '../shared/protocol'

export const FILE_PREVIEW_LIMITS = { text: 1024 * 1024, image: 8 * 1024 * 1024, pdf: 20 * 1024 * 1024 } as const

const imageTypes: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif', '.ico': 'image/x-icon'
}
const openableExtensions = new Set([
  ...Object.keys(imageTypes), '.tif', '.tiff', '.pdf', '.txt', '.md', '.markdown', '.log', '.csv', '.tsv', '.rtf',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp'
])
const canOpenFile = (path: string): boolean => openableExtensions.has(extname(path).toLowerCase())

interface LocalFileOptions {
  getWorkspace(): string
  openPath(path: string): Promise<string>
  revealPath(path: string): void
  simulateActions?: boolean
  onAction?(action: FileActionResult): void
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const pathKey = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path

function assertLocalPath(path: string): void {
  if (!path || path.length > 32_768 || /[\u0000-\u001f]/.test(path)) throw new Error('Invalid file path')
  if (/^[\\/]{2}/.test(path) || /^[\\/](?:\?\?|Device|GLOBALROOT)(?:[\\/]|$)/i.test(path)) {
    throw new Error('Network and device paths are not supported')
  }
  if (/^[a-z]:(?![\\/])/i.test(path) || path.replace(/^[a-z]:/i, '').includes(':')) {
    throw new Error('Device paths and alternate data streams are not supported')
  }
  if (path.split(/[\\/]/).some(part => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part.replace(/[ .]+$/, '')))) {
    throw new Error('Device paths are not supported')
  }
}

function workspacePath(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('Invalid workspace path')
  assertLocalPath(value)
  return resolve(value)
}

function fileCandidates(value: unknown): string[] {
  if (typeof value !== 'string' || !value) throw new Error('Invalid file path')
  let path = value
  const fileUrl = /^file:/i.test(path)
  if (fileUrl) {
    const url = new URL(path)
    if (url.hostname && url.hostname !== 'localhost') throw new Error('Network file URLs are not supported')
    if (url.search) throw new Error('File URLs cannot contain query parameters')
    path = fileURLToPath(url)
  } else if (/^[a-z]:(?![\\/])/i.test(path) || /^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path) && !/:\d+(?::\d+)?$/.test(path)) {
    throw new Error('Only local file paths are supported')
  }
  const candidates = [path]
  // Try the literal filename first: a real file can contain spaces, percent signs or #L12.
  if (/%[a-f\d]{2}/i.test(path)) {
    try { candidates.push(decodeURIComponent(path)) } catch { /* A literal percent sign is a valid filename. */ }
  }
  candidates.push(...candidates.map(candidate => candidate.replace(/(?::\d+(?::\d+)?|#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?)$/i, '')))
  // A Markdown heading fragment is a fallback only after the literal file is missing.
  // File URLs already distinguish encoded filename characters from URL fragments.
  if (!fileUrl && path.includes('#')) {
    const documentPath = path.slice(0, path.indexOf('#'))
    candidates.push(documentPath)
    if (/%[a-f\d]{2}/i.test(documentPath)) {
      try { candidates.push(decodeURIComponent(documentPath)) } catch { /* Preserve literal percent signs. */ }
    }
  }
  let rejected: unknown
  const normalized = candidates.map(candidate => process.platform === 'win32' ? candidate.replace(/^\/(?=[a-z]:[\\/])/i, '') : candidate)
  const valid = [...new Set(normalized)].filter(candidate => {
    try { assertLocalPath(candidate); return true } catch (error) { rejected = error; return false }
  })
  if (!valid.length) throw rejected
  return valid
}

function withinWorkspace(root: string, path: string): boolean {
  const difference = relative(root, path)
  return difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference)
}

async function readPrefix(file: FileHandle, length: number): Promise<Buffer> {
  const bytes = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    const { bytesRead } = await file.read(bytes, offset, length - offset, offset)
    if (!bytesRead) break
    offset += bytesRead
  }
  return bytes.subarray(0, offset)
}

function imageMatches(bytes: Buffer, mime: string): boolean {
  if (mime === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  if (mime === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  if (mime === 'image/gif') return /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))
  if (mime === 'image/webp') return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
  if (mime === 'image/bmp') return bytes.toString('ascii', 0, 2) === 'BM'
  if (mime === 'image/x-icon') return bytes.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))
  return bytes.toString('ascii', 4, 8) === 'ftyp' && /avif|avis/.test(bytes.toString('ascii', 8, 32))
}

function decodeText(bytes: Buffer, truncated: boolean): string | undefined {
  const encoding = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le' : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8'
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes, { stream: truncated })
    return /[\u0000-\u0008\u000e-\u001f]/.test(text) ? undefined : text
  } catch { return undefined }
}

export class LocalFileService {
  private sessionWorkspaces = new Map<string, string>()

  constructor(private options: LocalFileOptions) {}

  rememberBackendResponse(method: string, value: unknown): void {
    const response = record(value)
    if (method === 'session.list' && Array.isArray(response?.sessions)) {
      for (const session of response.sessions) this.rememberSession(session)
    } else if (method === 'session.create' || method === 'session.open') this.rememberSession(response?.session)
  }

  rememberBackendEvent(event: PraxisEvent): void {
    if (event.event === 'SessionUpdated') this.rememberSession(event.data.session)
  }

  private rememberSession(value: unknown): void {
    const session = record(value)
    if (typeof session?.id !== 'string' || !session.id) return
    try {
      const declared = workspacePath(session.workspace)
      const canonical = realpathSync.native(declared)
      assertLocalPath(canonical)
      if (!statSync(canonical).isDirectory()) return
      this.sessionWorkspaces.set(pathKey(declared), canonical)
      this.sessionWorkspaces.set(pathKey(canonical), canonical)
    } catch { /* Missing historical workspaces do not prevent a session list from loading. */ }
  }

  private async resolveFile(reference: unknown): Promise<{ path: string; root: string }> {
    const input = record(reference)
    if (!input) throw new Error('Invalid file reference')
    const requested = workspacePath(input.workspace)
    const configured = workspacePath(this.options.getWorkspace())
    const remembered = this.sessionWorkspaces.get(pathKey(requested))
    const current = pathKey(requested) === pathKey(configured)
    if (!current && !remembered) throw new Error('This file workspace is not authorized. Open its chat first.')
    const root = await realpath(requested)
    assertLocalPath(root)
    if (!current && pathKey(root) !== pathKey(remembered!)) throw new Error('The workspace location changed. Open its chat again.')
    for (const candidate of fileCandidates(input.path)) {
      let path: string
      try { path = await realpath(resolve(root, candidate)) } catch (error) {
        if (['ENOENT', 'ENOTDIR', 'EINVAL'].includes((error as NodeJS.ErrnoException).code || '')) continue
        throw error
      }
      assertLocalPath(path)
      if (!withinWorkspace(root, path)) throw new Error('The file must stay inside its workspace')
      if (!(await stat(path)).isFile()) throw new Error('Select a file to preview, open or reveal')
      return { path, root }
    }
    throw new Error('The file no longer exists or the reference is invalid')
  }

  async preview(reference: unknown): Promise<FilePreview> {
    const { path, root } = await this.resolveFile(reference)
    const file = await open(path, 'r')
    try {
      const information = await file.stat()
      const currentPath = await realpath(path)
      if (!information.isFile() || !withinWorkspace(root, currentPath) || pathKey(currentPath) !== pathKey(path)) {
        throw new Error('The file location changed. Try again.')
      }
      const preview: FilePreview = { path, name: basename(path), size: information.size, kind: 'unsupported', canOpen: canOpenFile(path) }
      const extension = extname(path).toLowerCase()
      const mime = imageTypes[extension]
      const mediaKind = mime ? 'image' : extension === '.pdf' ? 'pdf' : undefined
      const limit = mediaKind ? FILE_PREVIEW_LIMITS[mediaKind] : FILE_PREVIEW_LIMITS.text
      if (mediaKind && information.size > limit) return {
        ...preview,
        notice: `${mediaKind === 'pdf' ? 'PDF' : 'Image'} preview is limited to ${limit / 1024 / 1024} MB. Open the file in its default app.`
      }
      const bytes = await readPrefix(file, Math.min(information.size, limit))
      if (mediaKind) {
        const valid = mime ? imageMatches(bytes, mime) : bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))
        return valid ? { ...preview, kind: mediaKind, dataUrl: `data:${mime || 'application/pdf'};base64,${bytes.toString('base64')}` } : preview
      }
      const truncated = information.size > limit
      const text = decodeText(bytes, truncated)
      return text === undefined ? preview : { ...preview, kind: ['.md', '.markdown'].includes(extension) ? 'markdown' : 'text', text, truncated }
    } finally { await file.close() }
  }

  async open(reference: unknown): Promise<FileActionResult> {
    const { path } = await this.resolveFile(reference)
    if (!canOpenFile(path)) throw new Error('This file type cannot be opened directly. Use Show in folder instead.')
    if (!this.options.simulateActions) {
      const error = await this.options.openPath(path)
      if (error) throw new Error(error)
    }
    return this.completedAction('open', path)
  }

  async reveal(reference: unknown): Promise<FileActionResult> {
    const { path } = await this.resolveFile(reference)
    if (!this.options.simulateActions) this.options.revealPath(path)
    return this.completedAction('reveal', path)
  }

  private completedAction(action: FileActionResult['action'], path: string): FileActionResult {
    const result = { path, action, simulated: Boolean(this.options.simulateActions) }
    this.options.onAction?.(result)
    return result
  }
}
