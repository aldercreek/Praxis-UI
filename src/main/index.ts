import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { BackendClient } from './backend-client'
import { createDiagnosticWriter } from './diagnostics'
import { SettingsStore } from './settings'
import type { DesktopInfo, DesktopSettings } from '../shared/protocol'

const backend = new BackendClient()
const writeDiagnostic = createDiagnosticWriter(process.stderr)
let window: BrowserWindow | undefined
let settings: SettingsStore
let quitting = false
let closeConfirmed = false
let connecting: Promise<void> | undefined
let configurationChanges: Promise<void> = Promise.resolve()

if (process.env.PRAXIS_UI_DATA_DIR) app.setPath('userData', resolve(process.env.PRAXIS_UI_DATA_DIR))
const hasLock = app.requestSingleInstanceLock()
if (!hasLock) app.quit()
app.on('second-instance', () => { window?.show(); window?.focus() })

const methods = new Set([
  'initialize', 'session.list', 'session.create', 'session.open',
  'turn.start', 'turn.input', 'turn.stop', 'approval.respond'
])

function info(): DesktopInfo {
  return { settings: settings.get(), connection: backend.status, version: app.getVersion(), platform: process.platform }
}

function assertDirectory(path: string, label: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`${label} does not exist. Choose it again in Settings.`)
}

function validateEngine(config: DesktopSettings): void {
  assertDirectory(config.praxisPath, 'Praxis directory')
  if (!existsSync(join(config.praxisPath, 'src', 'praxis_agent', 'desktop', '__main__.py'))) {
    throw new Error('This version of Praxis does not include the desktop service. Choose an updated Praxis project.')
  }
  if (config.pythonPath && (!existsSync(config.pythonPath) || !statSync(config.pythonPath).isFile())) {
    throw new Error('The Python executable does not exist. Choose it again in Settings.')
  }
}

function changeConfiguration<T>(action: () => Promise<T>): Promise<T> {
  const operation = configurationChanges.then(async () => {
    // A startup using old settings must finish before accepting a replacement configuration.
    if (connecting) await connecting.catch(() => {})
    return action()
  })
  configurationChanges = operation.then(() => {}, () => {})
  return operation
}

async function startBackend(): Promise<void> {
  if (connecting) return connecting
  connecting = (async () => {
    try {
      const config = settings.get()
      const approvalArgs = config.bypassApprovals ? ['--bypass'] : []
      const testServer = !app.isPackaged && process.env.PRAXIS_UI_TEST_MODE === '1' && process.env.PRAXIS_UI_TEST_SERVER
      if (testServer) {
        await backend.start({ command: process.execPath, args: [testServer, ...approvalArgs], cwd: app.getAppPath(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
        return
      }
      validateEngine(config)
      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
        PYTHONPATH: [join(config.praxisPath, 'src'), process.env.PYTHONPATH].filter(Boolean).join(delimiter),
        ADA_API_KEY: settings.getApiKey(),
        ADA_MODEL: config.model
      }
      delete environment.ELECTRON_RUN_AS_NODE
      if (config.baseUrl) environment.ADA_BASE_URL = config.baseUrl
      const args = ['-u', '-m', 'praxis_agent.desktop', '--stdio', ...approvalArgs]
      if (process.env.PRAXIS_UI_DATABASE) args.push('--database', process.env.PRAXIS_UI_DATABASE)
      await backend.start({ command: settings.python(), args, cwd: config.praxisPath, env: environment })
    } catch (error) {
      backend.status = { state: 'error', message: error instanceof Error ? error.message : String(error) }
      backend.emit('connection', backend.status)
      throw error
    }
  })()
  try { await connecting } finally { connecting = undefined }
}

function trusted(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): void {
  if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Invalid desktop request')
}

function registerIPC(): void {
  ipcMain.handle('praxis:info', event => { trusted(event); return info() })
  ipcMain.handle('praxis:request', async (event, method: unknown, params: unknown = {}) => {
    trusted(event)
    if (typeof method !== 'string' || !methods.has(method)) throw new Error('Unsupported Praxis operation')
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('Invalid request parameters')
    if (connecting) await connecting
    return backend.request(method, params as Record<string, unknown>)
  })
  ipcMain.handle('praxis:settings', (event, patch: Partial<DesktopSettings> & { apiKey?: string }) => {
    trusted(event)
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid settings')
    return changeConfiguration(async () => {
      const before = settings.get()
      const needsRestart = Boolean(patch.apiKey?.trim()) ||
        (['praxisPath', 'pythonPath', 'model', 'baseUrl', 'bypassApprovals'] as const).some(key => patch[key] !== undefined && patch[key] !== before[key])
      if (needsRestart && backend.busy) throw new Error('Stop running sessions before changing model or backend settings.')
      if (needsRestart) validateEngine({ ...before, ...patch })
      if (patch.workspace) assertDirectory(patch.workspace, 'Workspace')
      settings.update(patch)
      if (needsRestart || backend.status.state === 'error') await startBackend()
      return info()
    })
  })
  ipcMain.handle('praxis:choose-directory', async (event, kind: unknown) => {
    trusted(event)
    if (kind !== 'workspace' && kind !== 'praxis') throw new Error('Invalid directory type')
    const result = await dialog.showOpenDialog(window!, {
      title: kind === 'workspace' ? 'Choose workspace' : 'Choose Praxis project directory',
      defaultPath: kind === 'workspace' ? settings.get().workspace : settings.get().praxisPath,
      properties: ['openDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('praxis:choose-python', async event => {
    trusted(event)
    const result = await dialog.showOpenDialog(window!, { title: 'Choose Python executable', properties: ['openFile'] })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('praxis:open-external', async (event, raw: unknown) => {
    trusted(event)
    if (typeof raw !== 'string') throw new Error('Invalid link')
    const url = new URL(raw)
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS links are supported')
    await shell.openExternal(url.href)
  })
  ipcMain.handle('praxis:open-workspace', async event => {
    trusted(event)
    const path = settings.get().workspace
    assertDirectory(path, 'Workspace')
    const error = await shell.openPath(path)
    if (error) throw new Error(error)
  })
  ipcMain.handle('praxis:restart', event => {
    trusted(event)
    return changeConfiguration(async () => {
      if (backend.busy) throw new Error('Stop running sessions before reconnecting.')
      await startBackend()
    })
  })
  ipcMain.on('praxis:window', (event, action: unknown) => {
    trusted(event)
    if (action === 'minimize') window?.minimize()
    if (action === 'maximize') window?.isMaximized() ? window.unmaximize() : window?.maximize()
    if (action === 'close') window?.close()
  })
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1220, height: 820, minWidth: 760, minHeight: 560,
    title: 'Praxis', backgroundColor: '#ffffff', show: false,
    icon: join(app.getAppPath(), 'resources', 'brand', 'icon.png'),
    frame: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      webSecurity: true
    }
  })
  window.once('ready-to-show', () => window?.show())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  window.on('close', event => {
    if (!backend.busy || quitting || closeConfirmed) return
    event.preventDefault()
    void dialog.showMessageBox(window!, {
      type: 'question', title: 'Quit Praxis', message: 'Tasks are still running',
      detail: 'Quitting will stop tasks in all sessions.', buttons: ['Keep working', 'Stop and quit'], defaultId: 0, cancelId: 0
    }).then(result => { if (result.response === 1) { closeConfirmed = true; window?.close() } })
  })
  window.on('closed', () => { window = undefined })
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
}

if (hasLock) void app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('dev.praxis.desktop')
  settings = new SettingsStore(join(app.getPath('userData'), 'settings.json'), app.getAppPath())
  backend.on('event', event => { if (!window?.webContents.isDestroyed()) window?.webContents.send('praxis:event', event) })
  backend.on('connection', status => { if (!window?.webContents.isDestroyed()) window?.webContents.send('praxis:connection', status) })
  backend.on('diagnostic', message => writeDiagnostic(`[Praxis] ${message}`))
  registerIPC()
  createWindow()
  void startBackend().catch(() => { /* Connection state is shown in the interface. */ })
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', event => {
  if (quitting) return
  event.preventDefault()
  quitting = true
  void backend.stop().finally(() => app.quit())
})
