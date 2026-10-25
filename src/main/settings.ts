import { existsSync, readFileSync, renameSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { safeStorage } from 'electron'
import type { DesktopSettings } from '../shared/protocol'

interface SavedSettings {
  praxisPath?: string
  pythonPath?: string
  workspace?: string
  model?: string
  baseUrl?: string
  bypassApprovals?: boolean
  encryptedApiKey?: string
}

function findPraxisPath(appPath: string): string {
  if (process.env.PRAXIS_PATH) return resolve(process.env.PRAXIS_PATH)
  // Also find the sibling checkout when running release/win-unpacked/resources/app.asar.
  let directory = appPath
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = resolve(directory, '..', 'Praxis')
    if (existsSync(join(candidate, 'src', 'praxis_agent', 'service', '__main__.py'))) return candidate
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return resolve(appPath, '..', 'Praxis')
}

export class SettingsStore {
  private saved: SavedSettings = {}
  private key = ''
  private defaults: DesktopSettings

  constructor(private file: string, appPath: string) {
    const praxisPath = findPraxisPath(appPath)
    this.defaults = {
      praxisPath,
      pythonPath: '',
      workspace: praxisPath,
      model: process.env.ADA_MODEL || 'auto(free)',
      baseUrl: process.env.ADA_BASE_URL || '',
      bypassApprovals: true,
      apiKeyConfigured: Boolean(process.env.ADA_API_KEY)
    }
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as SavedSettings
      for (const field of ['praxisPath', 'pythonPath', 'workspace', 'model', 'baseUrl', 'encryptedApiKey'] as const) {
        if (typeof data[field] === 'string') this.saved[field] = data[field]
      }
      if (typeof data.bypassApprovals === 'boolean') this.saved.bypassApprovals = data.bypassApprovals
      if (this.saved.encryptedApiKey && safeStorage.isEncryptionAvailable()) {
        this.key = safeStorage.decryptString(Buffer.from(this.saved.encryptedApiKey, 'base64'))
      }
    } catch { /* The first launch uses the existing Praxis environment. */ }
  }

  get(): DesktopSettings {
    return {
      ...this.defaults,
      ...Object.fromEntries(Object.entries(this.saved).filter(([key]) => key !== 'encryptedApiKey')),
      apiKeyConfigured: Boolean(this.key || process.env.ADA_API_KEY)
    }
  }

  getApiKey(): string { return this.key || process.env.ADA_API_KEY || '' }

  update(patch: Partial<DesktopSettings> & { apiKey?: string }): DesktopSettings {
    const next = { ...this.saved }
    let nextKey = this.key
    if (patch.bypassApprovals !== undefined) {
      if (typeof patch.bypassApprovals !== 'boolean') throw new Error('Invalid approval mode')
      next.bypassApprovals = patch.bypassApprovals
    }
    for (const field of ['praxisPath', 'pythonPath', 'workspace', 'model', 'baseUrl'] as const) {
      if (patch[field] !== undefined) {
        if (typeof patch[field] !== 'string' || patch[field]!.length > 4096) throw new Error('Invalid setting value')
        next[field] = patch[field]!.trim()
      }
    }
    if (next.praxisPath !== undefined && !next.praxisPath) throw new Error('Choose a Praxis project directory')
    if (next.workspace !== undefined && !next.workspace) throw new Error('Choose a workspace directory')
    if (next.baseUrl) {
      const url = new URL(next.baseUrl)
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('The API URL must use HTTP or HTTPS')
    }
    if (patch.apiKey !== undefined && patch.apiKey.trim()) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('System key storage is unavailable. Set the API key using the ADA_API_KEY environment variable.')
      nextKey = patch.apiKey.trim()
      next.encryptedApiKey = safeStorage.encryptString(nextKey).toString('base64')
    }
    mkdirSync(dirname(this.file), { recursive: true })
    const temporary = this.file + '.tmp'
    writeFileSync(temporary, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, this.file)
    this.saved = next
    this.key = nextKey
    return this.get()
  }

  python(): string {
    const settings = this.get()
    if (settings.pythonPath) return settings.pythonPath
    const localPython = process.platform === 'win32'
      ? join(settings.praxisPath, '.venv', 'Scripts', 'python.exe')
      : join(settings.praxisPath, '.venv', 'bin', 'python')
    return existsSync(localPython) ? localPython : process.platform === 'win32' ? 'python' : 'python3'
  }
}
