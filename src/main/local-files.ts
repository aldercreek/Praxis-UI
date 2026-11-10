import { realpathSync, statSync } from 'node:fs'
import { open, realpath, stat, lstat, opendir, type FileHandle } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FileActionResult, FilePreview, PraxisEvent } from '../shared/protocol'

export const FILE_PREVIEW_LIMITS = { text: 1024 * 1024, image: 8 * 1024 * 1024, pdf: 20 * 1024 * 1024 } as const

const imageTypes: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif', '.ico': 'image/x-icon'
}
const openableExtensions = new Set([
  ...Object.keys(imageTypes), '.tif', '.tiff', '.pdf', '.txt', '.md', '.markdown', '.log', '.csv', '.tsv', '.rtf',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp', '.html', '.htm'
])
export const PREVIEW_CSP = "default-src praxis-preview: data: blob: 'unsafe-inline'; script-src praxis-preview: 'unsafe-inline'; connect-src 'none'; form-action 'none'; frame-ancestors 'self' file: http://localhost:* http://127.0.0.1:*"
const previewTypes: Record<string, string> = { ...imageTypes, '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.txt': 'text/plain', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.ico': 'image/x-icon' }
const canOpenFile = (path: string): boolean => openableExtensions.has(extname(path).toLowerCase())
const executeFile = promisify(execFile)
const excludedDirectories = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'out', 'build', 'release', 'test-results'])
const FILE_LIST_LIMIT = 20_000
type IndexedFile = { path: string; mtime: number }
type FileIndex = { files: IndexedFile[]; truncated: boolean }

function matchFile(path: string, query: string): number {
  const lower = path.toLowerCase()
  const name = lower.slice(lower.lastIndexOf('/') + 1)
  if (name.startsWith(query)) return 0
  if (name.includes(query)) return 1
  let position = 0
  for (const character of query) {
    position = lower.indexOf(character, position)
    if (position < 0) return -1
    position += character.length
  }
  return 2
}

async function indexFiles(root: string): Promise<FileIndex> {
  const files: IndexedFile[] = []
  let truncated = false
  let gitFiles: string[] | undefined
  try {
    const result = await executeFile('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 })
    gitFiles = [...new Set(result.stdout.split('\0').filter(Boolean))]
  } catch {}
  if (gitFiles) {
    const directories = new Map<string, Promise<boolean>>()
    const safeDirectory = (path: string): Promise<boolean> => {
      if (!path) return Promise.resolve(true)
      if (!directories.has(path)) directories.set(path, (async () => {
        const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
        if (!await safeDirectory(parent)) return false
        try {
          const full = resolve(root, path)
          const info = await lstat(full)
          return info.isDirectory() && !info.isSymbolicLink() && pathKey(await realpath(full)) === pathKey(full)
        } catch { return false }
      })())
      return directories.get(path)!
    }
    truncated = gitFiles.length > FILE_LIST_LIMIT
    const candidates = gitFiles.slice(0, FILE_LIST_LIMIT)
    for (let offset = 0; offset < candidates.length; offset += 32) {
      const batch = await Promise.all(candidates.slice(offset, offset + 32).map(async path => {
        const parts = path.split('/')
        if (parts.length > 13) { truncated = true; return undefined }
        if (isAbsolute(path) || parts.some(part => part === '..' || !part)) return undefined
        const full = resolve(root, path)
        if (!withinWorkspace(root, full) || !await safeDirectory(parts.slice(0, -1).join('/'))) return undefined
        try {
          assertLocalPath(full)
          const info = await lstat(full)
          return info.isFile() && !info.isSymbolicLink() ? { path, mtime: info.mtimeMs } : undefined
        } catch { return undefined }
      }))
      files.push(...batch.filter((file): file is IndexedFile => Boolean(file)))
    }
  } else {
    let directoryCount = 0
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > 12 || files.length >= FILE_LIST_LIMIT || directoryCount >= FILE_LIST_LIMIT) { truncated = true; return }
      directoryCount += 1
      const full = resolve(root, directory)
      try {
        if (pathKey(await realpath(full)) !== pathKey(full)) return
        const entries = await opendir(full)
        for await (const entry of entries) {
          if (files.length >= FILE_LIST_LIMIT) { truncated = true; break }
          if (entry.isSymbolicLink()) continue
          const path = directory ? `${directory}/${entry.name}` : entry.name
          if (entry.isDirectory() && !excludedDirectories.has(entry.name)) await visit(path, depth + 1)
          else if (entry.isFile()) {
            try {
              const info = await lstat(resolve(root, path))
              if (info.isFile() && !info.isSymbolicLink()) files.push({ path, mtime: info.mtimeMs })
            } catch {}
          }
        }
      } catch (error) {
        if (!directory) throw error
      }
    }
    await visit('', 0)
  }
  return { files, truncated }
}

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
  private sessionRoots = new Map<string, string>()
  private pythonLogs = new Map<string, Set<string>>()
  private fileIndexes = new Map<string, { expires: number; value: Promise<FileIndex> }>()
  private previewRoots = new Map<string, string>()

  constructor(private options: LocalFileOptions) {}

  rememberBackendResponse(method: string, value: unknown): void {
    const response = record(value)
    if (method === 'session.list' && Array.isArray(response?.sessions)) {
      for (const session of response.sessions) this.rememberSession(session)
    } else if (method === 'session.create' || method === 'session.open') {
      this.rememberSession(response?.session)
      const sessionId = record(response?.session)?.id
      if (typeof sessionId === 'string' && Array.isArray(response?.messages)) {
        for (const value of response.messages) {
          const message = record(value)
          if (message?.role === 'tool' && message.tool_name === 'run_code') {
            this.rememberPythonLogs(sessionId, message.structured_output ?? message.content)
          }
        }
      }
      if (Array.isArray(response?.view_events)) {
        for (const event of response.view_events) this.rememberBackendEvent(event)
      }
    }
  }

  rememberBackendEvent(event: PraxisEvent): void {
    if (event.event === 'SessionUpdated') this.rememberSession(event.data.session)
    if (event.event === 'ToolFinished' && event.session_id && event.data.tool_name === 'run_code') {
      const result = record(event.data.result)
      this.rememberPythonLogs(event.session_id, result?.structured_output ?? result?.output)
    }
  }

  private rememberPythonLogs(sessionId: string, value: unknown): void {
    const root = this.sessionRoots.get(sessionId)
    if (!root) return
    try {
      const result = record(typeof value === 'string' ? JSON.parse(value) : value)
      const files = record(result?.output_files)
      for (const stream of ['stdout', 'stderr']) {
        const path = record(files?.[stream])?.path
        if (typeof path !== 'string' || !isAbsolute(path) || extname(path).toLowerCase() !== '.log') continue
        assertLocalPath(path)
        const canonical = realpathSync.native(path)
        assertLocalPath(canonical)
        if (pathKey(resolve(path)) !== pathKey(canonical) || !statSync(canonical).isFile()) continue
        const logs = this.pythonLogs.get(pathKey(root)) ?? new Set<string>()
        logs.add(pathKey(canonical))
        this.pythonLogs.set(pathKey(root), logs)
      }
    } catch { /* Missing or malformed output references do not block the conversation. */ }
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
      this.sessionRoots.set(session.id, canonical)
    } catch { /* Missing historical workspaces do not prevent a session list from loading. */ }
  }

  private async authorizedRoot(workspace: unknown): Promise<string> {
    const requested = workspacePath(workspace)
    const configured = workspacePath(this.options.getWorkspace())
    const remembered = this.sessionWorkspaces.get(pathKey(requested))
    const current = pathKey(requested) === pathKey(configured)
    if (!current && !remembered) throw new Error('This file workspace is not authorized. Open its chat first.')
    const root = await realpath(requested)
    assertLocalPath(root)
    if (!current && pathKey(root) !== pathKey(remembered!)) throw new Error('The workspace location changed. Open its chat again.')
    if (!(await stat(root)).isDirectory()) throw new Error('Invalid workspace path')
    return root
  }

  async listFiles(request: unknown): Promise<{ files: string[]; truncated: boolean }> {
    const input = record(request)
    if (!input || typeof input.query !== 'string' || input.query.length > 1024) throw new Error('Invalid file query')
    const root = await this.authorizedRoot(input.workspace)
    const key = pathKey(root)
    let cached = this.fileIndexes.get(key)
    if (!cached || cached.expires <= Date.now()) {
      cached = { expires: Date.now() + 30_000, value: indexFiles(root) }
      this.fileIndexes.set(key, cached)
      if (this.fileIndexes.size > 32) this.fileIndexes.delete(this.fileIndexes.keys().next().value!)
      void cached.value.catch(() => { if (this.fileIndexes.get(key) === cached) this.fileIndexes.delete(key) })
    }
    const index = await cached.value
    const query = input.query.toLowerCase().replaceAll('\\', '/')
    const matches = query ? index.files.map(file => ({ ...file, rank: matchFile(file.path, query) })).filter(file => file.rank >= 0)
      .sort((a, b) => a.rank - b.rank || a.path.length - b.path.length || a.path.localeCompare(b.path))
      : [...index.files].sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path))
    return { files: matches.slice(0, 50).map(file => file.path), truncated: index.truncated || matches.length > 50 }
  }

  private async resolveFile(reference: unknown): Promise<{ path: string; root: string }> {
    const input = record(reference)
    if (!input) throw new Error('Invalid file reference')
    const root = await this.authorizedRoot(input.workspace)
    // Backend-issued Python logs live outside the project. Grant only the exact
    // files observed in tool results, never their directory or renderer paths.
    const logs = this.pythonLogs.get(pathKey(root))
    if (logs) for (const candidate of fileCandidates(input.path)) {
      if (!isAbsolute(candidate) || !logs.has(pathKey(resolve(candidate)))) continue
      const path = await realpath(candidate)
      if (pathKey(path) !== pathKey(resolve(candidate))) throw new Error('The log location changed. Run the code again.')
      if (!(await stat(path)).isFile()) throw new Error('Select a log file to preview')
      return { path, root: dirname(path) }
    }
    return this.resolveWithinRoot(root, input.path)
  }

  private async resolveWithinRoot(root: string, value: unknown): Promise<{ path: string; root: string }> {
    for (const candidate of fileCandidates(value)) {
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

  async previewToken(workspace: string): Promise<string> {
    return this.tokenForRoot(await this.authorizedRoot(workspace))
  }

  private tokenForRoot(root: string): string {
    for (const [token, known] of this.previewRoots) if (pathKey(known) === pathKey(root)) return token
    const token = randomUUID()
    this.previewRoots.set(token, root)
    return token
  }

  async previewResource(request: Request): Promise<Response> {
    const headers = { 'Content-Security-Policy': PREVIEW_CSP, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }
    let file: FileHandle | undefined
    try {
      const url = new URL(request.url)
      const root = this.previewRoots.get(url.hostname)
      if (url.protocol !== 'praxis-preview:' || !root || url.username || url.password || url.port || !['GET', 'HEAD'].includes(request.method)) throw new Error('Invalid preview request')
      const path = decodeURIComponent(url.pathname.slice(1))
      if (!path || isAbsolute(path) || path.split(/[/\\]/).some(part => part === '..')) throw new Error('Invalid preview path')
      const resolved = await this.resolveWithinRoot(root, path)
      file = await open(resolved.path, 'r')
      const information = await file.stat()
      const current = await realpath(resolved.path)
      if (!information.isFile() || !withinWorkspace(root, current) || pathKey(current) !== pathKey(resolved.path)) throw new Error('Invalid preview file')
      const contentType = previewTypes[extname(resolved.path).toLowerCase()] || 'application/octet-stream'
      const responseHeaders = { ...headers, 'Content-Type': contentType, 'Content-Length': String(information.size) }
      if (request.method === 'HEAD') { await file.close(); file = undefined; return new Response(null, { headers: responseHeaders }) }
      const stream = Readable.toWeb(file.createReadStream({ autoClose: true })) as ReadableStream<Uint8Array>
      file = undefined
      return new Response(stream, { headers: responseHeaders })
    } catch {
      await file?.close().catch(() => {})
      return new Response('Not found', { status: 404, headers: { ...headers, 'Content-Type': 'text/plain' } })
    }
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
      if (text !== undefined && ['.html', '.htm'].includes(extension)) {
        const token = this.tokenForRoot(root)
        const location = relative(root, path).split(sep).map(encodeURIComponent).join('/')
        return { ...preview, kind: 'html', text, truncated, previewUrl: `praxis-preview://${token}/${location}` }
      }
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
