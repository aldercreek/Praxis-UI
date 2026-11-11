import { existsSync, readFileSync, renameSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { DesktopSettings } from '../shared/protocol'

interface SavedSettings {
  praxisPath?: string
  pythonPath?: string
  workspace?: string
  model?: string
  configPath?: string
  bypassApprovals?: boolean
  notifications?: boolean
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
  private defaults: DesktopSettings

  constructor(private file: string, appPath: string) {
    const praxisPath = findPraxisPath(appPath)
    this.defaults = {
      praxisPath,
      pythonPath: '',
      workspace: praxisPath,
      model: '',
      configPath: process.env.PRAXIS_CONFIG || join(process.env.PRAXIS_DATA_DIR || join(homedir(), '.praxis'), 'praxis.yaml'),
      bypassApprovals: true,
      notifications: true
    }
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as SavedSettings
      for (const field of ['praxisPath', 'pythonPath', 'workspace', 'model', 'configPath'] as const) {
        if (typeof data[field] === 'string') this.saved[field] = data[field]
      }
      if (typeof data.bypassApprovals === 'boolean') this.saved.bypassApprovals = data.bypassApprovals
      if (typeof data.notifications === 'boolean') this.saved.notifications = data.notifications
    } catch { /* The first launch uses the existing Praxis environment. */ }
  }

  get(): DesktopSettings {
    return { ...this.defaults, ...this.saved }
  }

  update(patch: Partial<DesktopSettings>): DesktopSettings {
    const next = { ...this.saved }
    if (patch.notifications !== undefined) {
      if (typeof patch.notifications !== 'boolean') throw new Error('Invalid notification preference')
      next.notifications = patch.notifications
    }
    if (patch.bypassApprovals !== undefined) {
      if (typeof patch.bypassApprovals !== 'boolean') throw new Error('Invalid approval mode')
      next.bypassApprovals = patch.bypassApprovals
    }
    for (const field of ['praxisPath', 'pythonPath', 'workspace', 'model', 'configPath'] as const) {
      if (patch[field] !== undefined) {
        if (typeof patch[field] !== 'string' || patch[field]!.length > 4096) throw new Error('Invalid setting value')
        next[field] = patch[field]!.trim()
      }
    }
    if (next.praxisPath !== undefined && !next.praxisPath) throw new Error('Choose a Praxis project directory')
    if (next.workspace !== undefined && !next.workspace) throw new Error('Choose a workspace directory')
    if (next.configPath !== undefined && !next.configPath) throw new Error('Choose a model configuration file')
    mkdirSync(dirname(this.file), { recursive: true })
    const temporary = this.file + '.tmp'
    writeFileSync(temporary, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, this.file)
    this.saved = next
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
