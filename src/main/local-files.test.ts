import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FILE_PREVIEW_LIMITS, LocalFileService, PREVIEW_CSP } from './local-files'
import type { FileActionResult, FileReference } from '../shared/protocol'

let directory: string
let workspace: string
let outside: string
let configuredWorkspace: string
let service: LocalFileService
const openPath = vi.fn(async (_path: string) => '')
const revealPath = vi.fn((_path: string) => {})
const reference = (path: string, root = workspace): FileReference => ({ path, workspace: root })
const write = (path: string, content: string | Buffer): string => { writeFileSync(path, content); return realpathSync.native(path) }

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'praxis-files-'))
  workspace = join(directory, 'workspace')
  outside = join(directory, 'workspace-other')
  mkdirSync(workspace)
  mkdirSync(outside)
  configuredWorkspace = workspace
  openPath.mockReset().mockResolvedValue('')
  revealPath.mockReset()
  service = new LocalFileService({ getWorkspace: () => configuredWorkspace, openPath, revealPath })
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe('sandboxed HTML resources', () => {
  it('issues stable workspace tokens and serves HTML and relative assets with restrictive headers', async () => {
    const name = 'preview #1.html'
    write(join(workspace, name), '<h1>Hello</h1>')
    write(join(workspace, 'style.css'), 'h1 { color: red }')
    const preview = await service.preview(reference(name))
    expect(preview).toMatchObject({ kind: 'html', text: '<h1>Hello</h1>', canOpen: true })
    const token = await service.previewToken(workspace)
    expect(token).toBe(await service.previewToken(workspace))
    expect(new URL(preview.previewUrl!).hostname).toBe(token)
    const response = await service.previewResource(new Request(preview.previewUrl!))
    expect(await response.text()).toBe(preview.text)
    expect(response.headers.get('content-type')).toBe('text/html')
    expect(response.headers.get('content-security-policy')).toBe(PREVIEW_CSP)
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('cache-control')).toBe('no-store')
    const css = await service.previewResource(new Request(`praxis-preview://${token}/style.css`))
    expect(css.headers.get('content-type')).toBe('text/css')
    expect(await css.text()).toContain('color: red')
    const head = await service.previewResource(new Request(preview.previewUrl!, { method: 'HEAD' }))
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
  })

  it('rejects unknown tokens, unauthorized roots, traversal, symlink escapes and device paths', async () => {
    write(join(outside, 'secret.html'), 'outside')
    symlinkSync(outside, join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(service.previewToken(outside)).rejects.toThrow('not authorized')
    const token = await service.previewToken(workspace)
    const paths = ['../workspace-other/secret.html', '%2e%2e%2fworkspace-other%2fsecret.html', '%2e%2e%5cworkspace-other%5csecret.html', 'escape/secret.html', '%2f%2fserver/share', 'CON', 'escape', 'missing.html']
    for (const path of paths) {
      const response = await service.previewResource(new Request(`praxis-preview://${token}/${path}`))
      expect(response.status, path).toBe(404)
    }
    expect((await service.previewResource(new Request('praxis-preview://unknown/secret.html'))).status).toBe(404)
    expect((await service.previewResource(new Request(`praxis-preview://${token}/secret.html`, { method: 'POST' }))).status).toBe(404)
  })
})

describe('local file boundaries', () => {
  it('resolves relative, absolute and file URLs with Chinese, spaces and literal # characters', async () => {
    const name = '报告 #1 结果.md'
    const path = write(join(workspace, name), '# 完成\n测试内容')
    const paths = [name, path, pathToFileURL(path).href, encodeURIComponent(name)]
    if (process.platform === 'win32') paths.push(`/${path.replaceAll('\\', '/')}`)
    for (const value of paths) {
      expect(await service.preview(reference(value))).toMatchObject({ path, name, kind: 'markdown', text: '# 完成\n测试内容', canOpen: true })
    }
    expect(openPath).not.toHaveBeenCalled()
    expect(revealPath).not.toHaveBeenCalled()
  })

  it('accepts source line references while preferring an existing filename containing #L', async () => {
    const path = write(join(workspace, 'source.ts'), 'export const answer = 42')
    const literal = write(join(workspace, 'source.ts#L20'), 'literal filename')
    for (const value of ['source.ts:20', `${path}:20:3`, `${pathToFileURL(path).href}#L4-L8`, 'source.ts#L9']) {
      expect(await service.preview(reference(value))).toMatchObject({ path, kind: 'text', canOpen: false })
    }
    expect(await service.preview(reference('source.ts#L20'))).toMatchObject({ path: literal, text: 'literal filename' })
  })

  it('opens Markdown heading references only after trying the complete filename', async () => {
    const path = write(join(workspace, 'guide.md'), '# Installation\nInstructions')
    const literal = write(join(workspace, 'literal name#part.md'), 'literal filename')
    write(join(workspace, 'literal name'), 'different file')
    for (const value of ['guide.md#installation', `${path}#installation`, `${pathToFileURL(path).href}#installation`]) {
      expect(await service.preview(reference(value))).toMatchObject({ path, kind: 'markdown', text: '# Installation\nInstructions' })
    }
    for (const value of ['literal name#part.md', encodeURIComponent('literal name#part.md'), pathToFileURL(literal).href]) {
      expect(await service.preview(reference(value))).toMatchObject({ path: literal, text: 'literal filename' })
    }
    await expect(service.preview(reference(pathToFileURL(join(workspace, 'guide.md#missing')).href))).rejects.toThrow('no longer exists')
  })

  it('checks authorization and canonical boundaries for Markdown fragment fallbacks', async () => {
    const escaped = write(join(outside, 'private.md'), 'outside')
    symlinkSync(outside, join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    for (const path of [`${escaped}#installation`, `${relative(workspace, escaped)}#installation`, 'escape/private.md#installation']) {
      await expect(service.preview(reference(path))).rejects.toThrow('inside its workspace')
    }
    await expect(service.preview(reference('private.md#installation', outside))).rejects.toThrow('not authorized')
    expect(openPath).not.toHaveBeenCalled()
    expect(revealPath).not.toHaveBeenCalled()
  })

  it('rejects parent traversal, absolute escapes and sibling directories with the same prefix', async () => {
    const escaped = write(join(outside, 'private.txt'), 'not in this workspace')
    for (const path of [escaped, relative(workspace, escaped), pathToFileURL(escaped).href]) {
      await expect(service.preview(reference(path))).rejects.toThrow('inside its workspace')
    }
  })

  it('cannot authorize a workspace using the renderer reference or an unrelated backend response', async () => {
    write(join(outside, 'document.txt'), 'another project')
    await expect(service.preview(reference('document.txt', outside))).rejects.toThrow('not authorized')
    service.rememberBackendResponse('turn.start', { session: { id: 'spoofed', workspace: outside } })
    await expect(service.preview(reference('document.txt', outside))).rejects.toThrow('not authorized')
    service.rememberBackendResponse('session.open', { session: { id: 'opened-session', workspace: outside } })
    expect(await service.preview(reference('document.txt', outside))).toMatchObject({ text: 'another project' })
  })

  it('remembers workspaces from session lists and SessionUpdated events, including after settings changes', async () => {
    write(join(workspace, 'old.txt'), 'retained session')
    write(join(outside, 'new.txt'), 'current workspace')
    service.rememberBackendResponse('session.list', { sessions: [{ id: 'old-session', workspace }] })
    configuredWorkspace = outside
    expect(await service.preview(reference('old.txt'))).toMatchObject({ text: 'retained session' })
    expect(await service.preview(reference('new.txt', outside))).toMatchObject({ text: 'current workspace' })
    const third = join(directory, 'third')
    mkdirSync(third)
    write(join(third, 'event.txt'), 'event session')
    service.rememberBackendEvent({ event: 'SessionUpdated', data: { session: { id: 'event-session', workspace: third } } })
    expect(await service.preview(reference('event.txt', third))).toMatchObject({ text: 'event session' })
  })

  it('rejects symlinks or junctions escaping the canonical workspace', async () => {
    write(join(outside, 'secret.txt'), 'outside')
    symlinkSync(outside, join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(service.preview(reference('escape/secret.txt'))).rejects.toThrow('inside its workspace')
    await expect(service.open(reference('escape/secret.txt'))).rejects.toThrow('inside its workspace')
    await expect(service.reveal(reference('escape/secret.txt'))).rejects.toThrow('inside its workspace')
    expect(openPath).not.toHaveBeenCalled()
    expect(revealPath).not.toHaveBeenCalled()
  })

  it.each(['\\\\server\\share\\private.txt', '\\\\?\\C:\\private.txt', '\\\\.\\PhysicalDrive0', 'file://server/share/private.txt', 'CON', 'folder/NUL.txt', 'document.txt:payload', 'C:relative.txt', 'https://example.com/file.pdf'])('rejects network, device, stream or non-file reference %s', async path => {
    await expect(service.preview(reference(path))).rejects.toThrow()
  })

  it('rejects missing files and directories without calling the OS', async () => {
    await expect(service.preview(reference('missing.txt'))).rejects.toThrow('no longer exists')
    await expect(service.preview(reference(workspace))).rejects.toThrow('Select a file')
    expect(openPath).not.toHaveBeenCalled()
  })
})

describe('bounded previews', () => {
  it('truncates text at 1 MiB without inserting a broken UTF-8 character', async () => {
    write(join(workspace, 'large.txt'), 'a'.repeat(FILE_PREVIEW_LIMITS.text - 1) + '中文结尾')
    const preview = await service.preview(reference('large.txt'))
    expect(preview).toMatchObject({ kind: 'text', truncated: true })
    expect(preview.text).toBe('a'.repeat(FILE_PREVIEW_LIMITS.text - 1))
    expect(preview.size).toBeGreaterThan(FILE_PREVIEW_LIMITS.text)
  })

  it('decodes BOM marked text and rejects binary content', async () => {
    write(join(workspace, 'utf16.txt'), Buffer.concat([Buffer.from([255, 254]), Buffer.from('中文\n第二行', 'utf16le')]))
    write(join(workspace, 'binary.dat'), Buffer.from([0, 255, 1, 2, 3]))
    expect(await service.preview(reference('utf16.txt'))).toMatchObject({ kind: 'text', text: '中文\n第二行' })
    expect(await service.preview(reference('binary.dat'))).toMatchObject({ kind: 'unsupported', canOpen: false })
  })

  it('returns bounded raster images and PDFs as data URLs and leaves SVG as text', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64')
    const pdf = Buffer.from('%PDF-1.7\n%%EOF')
    write(join(workspace, 'image.png'), png)
    write(join(workspace, 'document.pdf'), pdf)
    write(join(workspace, 'drawing.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    expect(await service.preview(reference('image.png'))).toMatchObject({ kind: 'image', canOpen: true, dataUrl: `data:image/png;base64,${png.toString('base64')}` })
    expect(await service.preview(reference('document.pdf'))).toMatchObject({ kind: 'pdf', canOpen: true, dataUrl: `data:application/pdf;base64,${pdf.toString('base64')}` })
    expect(await service.preview(reference('drawing.svg'))).toMatchObject({ kind: 'text', canOpen: false })
    await expect(service.open(reference('drawing.svg'))).rejects.toThrow('cannot be opened directly')
  })

  it('keeps oversized media available to open without loading it and does not trust a misleading image extension', async () => {
    const image = write(join(workspace, 'large.png'), '')
    const pdf = write(join(workspace, 'large.pdf'), '')
    truncateSync(image, FILE_PREVIEW_LIMITS.image + 1)
    truncateSync(pdf, FILE_PREVIEW_LIMITS.pdf + 1)
    write(join(workspace, 'fake.png'), 'not a PNG')
    expect(await service.preview(reference(image))).toEqual({ path: image, name: 'large.png', kind: 'unsupported', size: FILE_PREVIEW_LIMITS.image + 1, canOpen: true, notice: expect.stringContaining('8 MB') })
    expect(await service.preview(reference(pdf))).toEqual({ path: pdf, name: 'large.pdf', kind: 'unsupported', size: FILE_PREVIEW_LIMITS.pdf + 1, canOpen: true, notice: expect.stringContaining('20 MB') })
    expect(await service.preview(reference('fake.png'))).toMatchObject({ kind: 'unsupported' })
  })
})

describe('explicit file actions', () => {
  it('opens supported documents, reveals other files and rejects executable scripts', async () => {
    const document = write(join(workspace, 'report.docx'), 'fixture')
    const script = write(join(workspace, 'run.cmd'), '@echo off')
    expect(await service.open(reference(document))).toEqual({ path: document, action: 'open', simulated: false })
    expect(openPath).toHaveBeenCalledExactlyOnceWith(document)
    await expect(service.open(reference(script))).rejects.toThrow('cannot be opened directly')
    expect(await service.reveal(reference(script))).toEqual({ path: script, action: 'reveal', simulated: false })
    expect(revealPath).toHaveBeenCalledExactlyOnceWith(script)
  })

  it('records simulated actions without starting any external application', async () => {
    const actions: FileActionResult[] = []
    const path = write(join(workspace, 'report.txt'), 'test')
    const simulated = new LocalFileService({ getWorkspace: () => workspace, openPath, revealPath, simulateActions: true, onAction: action => { actions.push(action) } })
    expect(await simulated.open(reference(path))).toEqual({ path, action: 'open', simulated: true })
    expect(await simulated.reveal(reference(path))).toEqual({ path, action: 'reveal', simulated: true })
    expect(actions).toEqual([{ path, action: 'open', simulated: true }, { path, action: 'reveal', simulated: true }])
    expect(openPath).not.toHaveBeenCalled()
    expect(revealPath).not.toHaveBeenCalled()
  })

  it('surfaces default application errors instead of recording a completed action', async () => {
    write(join(workspace, 'report.txt'), 'test')
    openPath.mockResolvedValue('No application is associated with this file')
    await expect(service.open(reference('report.txt'))).rejects.toThrow('No application is associated')
  })
})


describe('workspace file suggestions', () => {
  it('rejects unauthorized workspaces, including previously cached results', async () => {
    write(join(workspace, 'local.txt'), '')
    await expect(service.listFiles({ workspace: outside, query: '' })).rejects.toThrow('not authorized')
    expect((await service.listFiles({ workspace, query: '' })).files).toEqual(['local.txt'])
    configuredWorkspace = outside
    await expect(service.listFiles({ workspace, query: '' })).rejects.toThrow('not authorized')
    service.rememberBackendResponse('session.open', { session: { id: 'remembered', workspace } })
    expect((await service.listFiles({ workspace, query: '' })).files).toEqual(['local.txt'])
  })

  it('walks non-git directories while excluding build and environment directories and links', async () => {
    for (const name of ['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'out', 'build', 'release', 'test-results']) {
      mkdirSync(join(workspace, name))
      write(join(workspace, name, 'hidden.txt'), '')
    }
    mkdirSync(join(workspace, 'src'))
    write(join(workspace, 'src', '文件.ts'), '')
    write(join(outside, 'secret.txt'), '')
    symlinkSync(outside, join(workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(await service.listFiles({ workspace, query: '' })).toEqual({ files: ['src/文件.ts'], truncated: false })
  })

  it('ranks basename prefixes, basename substrings and full-path subsequences in that order', async () => {
    for (const path of ['ab.ts', 'long/ab.ts', 'zab.ts', 'a/b.ts', 'unrelated.ts']) {
      const parts = path.split('/')
      if (parts.length > 1) mkdirSync(join(workspace, parts[0]), { recursive: true })
      write(join(workspace, ...parts), '')
    }
    expect((await service.listFiles({ workspace, query: 'AB' })).files).toEqual(['ab.ts', 'long/ab.ts', 'zab.ts', 'a/b.ts'])
  })

  it('returns at most 50 files in modification order for an empty query', async () => {
    for (let index = 0; index < 55; index += 1) {
      const path = write(join(workspace, `file-${index}.txt`), '')
      utimesSync(path, 1_700_000_000 + index, 1_700_000_000 + index)
    }
    const result = await service.listFiles({ workspace, query: '' })
    expect(result.files).toHaveLength(50)
    expect(result.files[0]).toBe('file-54.txt')
    expect(result.files[49]).toBe('file-5.txt')
    expect(result.truncated).toBe(true)
  })

  it('honors git ignore rules and includes tracked files and untracked source', async () => {
    execFileSync('git', ['init', '-q'], { cwd: workspace, windowsHide: true })
    write(join(workspace, '.gitignore'), 'ignored.txt')
    write(join(workspace, 'ignored.txt'), '')
    write(join(workspace, 'tracked.txt'), '')
    write(join(workspace, 'untracked.txt'), '')
    execFileSync('git', ['add', 'tracked.txt'], { cwd: workspace, windowsHide: true })
    expect((await service.listFiles({ workspace, query: '.txt' })).files).toEqual(['tracked.txt', 'untracked.txt'])
  })

  it('refreshes the cached index after 30 seconds', async () => {
    const time = vi.spyOn(Date, 'now').mockReturnValue(1000)
    try {
      write(join(workspace, 'first.txt'), '')
      expect((await service.listFiles({ workspace, query: '' })).files).toEqual(['first.txt'])
      write(join(workspace, 'second.txt'), '')
      time.mockReturnValue(30_999)
      expect((await service.listFiles({ workspace, query: 'second' })).files).toEqual([])
      time.mockReturnValue(31_001)
      expect((await service.listFiles({ workspace, query: 'second' })).files).toEqual(['second.txt'])
    } finally { time.mockRestore() }
  })

  it('stops descending after twelve directory levels', async () => {
    const twelve = join(workspace, ...Array.from({ length: 12 }, (_, index) => `d${index}`))
    mkdirSync(join(twelve, 'deeper'), { recursive: true })
    write(join(twelve, 'visible.txt'), '')
    write(join(twelve, 'deeper', 'hidden.txt'), '')
    const result = await service.listFiles({ workspace, query: '.txt' })
    expect(result.files).toHaveLength(1)
    expect(result.files[0]).toMatch(/visible.txt$/)
    expect(result.truncated).toBe(true)
  })
})
