import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { BackendClient } from './backend-client'
import { createDiagnosticWriter } from './diagnostics'
import { LocalFileService } from './local-files'
import { SettingsStore } from './settings'
import type { DesktopInfo, DesktopSettings, FileActionResult } from '../shared/protocol'

const backend = new BackendClient()
const writeDiagnostic = createDiagnosticWriter(process.stderr)
const testMode = !app.isPackaged && process.env.PRAXIS_UI_TEST_MODE === '1'
let window: BrowserWindow | undefined
let settings: SettingsStore
let localFiles: LocalFileService
let quitting = false
let connecting: Promise<void> | undefined
let configurationChanges: Promise<void> = Promise.resolve()

if (process.env.PRAXIS_UI_DATA_DIR) app.setPath('userData', resolve(process.env.PRAXIS_UI_DATA_DIR))
const hasLock = app.requestSingleInstanceLock()
if (!hasLock) app.quit()
app.on('second-instance', () => { if (!testMode) { window?.show(); window?.focus() } })

const methods = new Set([
  'initialize', 'mcp.status', 'session.list', 'session.create', 'session.open', 'session.delete',
  'input.submit', 'input.resume', 'input.delete', 'input.edit', 'input.reorder', 'input.send', 'turn.cancel', 'approval.decide'
])

function info(): DesktopInfo {
  return { settings: settings.get(), connection: backend.status, version: app.getVersion(), platform: process.platform }
}

function assertDirectory(path: string, label: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`${label} does not exist. Choose it again in Settings.`)
}

function validateEngine(config: DesktopSettings): void {
  assertDirectory(config.praxisPath, 'Praxis directory')
  if (!existsSync(join(config.praxisPath, 'src', 'praxis_agent', 'service', '__main__.py'))) {
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

async function startBackend(applySettings = false): Promise<void> {
  if (connecting) return connecting
  connecting = (async () => {
    try {
      const config = settings.get()
      const approvalArgs = config.bypassApprovals ? ['--bypass'] : []
      const testServer = testMode && process.env.PRAXIS_UI_TEST_SERVER
      if (testServer) {
        await backend.start({ command: process.execPath, args: [testServer, ...approvalArgs], cwd: app.getAppPath(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
        if (applySettings) await backend.request('settings.update', { bypass_approvals: config.bypassApprovals })
        return
      }
      validateEngine(config)
      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
        PYTHONPATH: [join(config.praxisPath, 'src'), process.env.PYTHONPATH].filter(Boolean).join(delimiter),
        ADA_API_KEY: settings.getApiKey(),
        ADA_MODEL: config.model,
        PRAXIS_BYPASS_APPROVALS: config.bypassApprovals ? '1' : '0'
      }
      delete environment.ELECTRON_RUN_AS_NODE
      if (config.baseUrl) environment.ADA_BASE_URL = config.baseUrl
      const args = ['-u', '-m', 'praxis_agent.service']
      if (process.env.PRAXIS_DATA_DIR) environment.PRAXIS_DATA_DIR = process.env.PRAXIS_DATA_DIR
      await backend.start({ command: settings.python(), args, cwd: config.praxisPath, env: environment })
      if (applySettings) {
        await backend.request('settings.update', { model: config.model, base_url: config.baseUrl,
          ...(settings.getApiKey() ? { api_key: settings.getApiKey() } : {}), bypass_approvals: config.bypassApprovals })
      }
      // Joining an existing service adopts its settings, including while another
      // terminal is running a turn. Only an explicit settings edit changes them.
      const shared = await backend.request<{ model: string; base_url?: string; bypass_approvals: boolean }>('initialize')
      settings.update({ model: shared.model, ...(shared.base_url ? { baseUrl: shared.base_url } : {}), bypassApprovals: shared.bypass_approvals })
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
  ipcMain.on('praxis:ack', (event, sessionId: unknown, sequence: unknown) => {
    trusted(event)
    if (typeof sessionId === 'string' && typeof sequence === 'number') backend.acknowledge(sessionId, sequence)
  })
  ipcMain.handle('praxis:info', async event => {
    trusted(event)
    // Joining a shared service adopts its settings after the connection opens.
    // Do not let the renderer retain the desktop defaults from that interval.
    if (connecting) await connecting.catch(() => { /* Return the error state and editable settings. */ })
    return info()
  })
  ipcMain.handle('praxis:request', async (event, method: unknown, params: unknown = {}) => {
    trusted(event)
    if (typeof method !== 'string' || !methods.has(method)) throw new Error('Unsupported Praxis operation')
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('Invalid request parameters')
    if (connecting) await connecting
    const result = await backend.request(method, params as Record<string, unknown>)
    localFiles.rememberBackendResponse(method, result)
    return result
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
      if (needsRestart || backend.status.state === 'error') await startBackend(needsRestart)
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
  ipcMain.handle('praxis:preview-file', (event, reference: unknown) => { trusted(event); return localFiles.preview(reference) })
  ipcMain.handle('praxis:open-file', (event, reference: unknown) => { trusted(event); return localFiles.open(reference) })
  ipcMain.handle('praxis:reveal-file', (event, reference: unknown) => { trusted(event); return localFiles.reveal(reference) })
  ipcMain.handle('praxis:restart', event => {
    trusted(event)
    return changeConfiguration(async () => {
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
      webSecurity: true,
      ...(testMode ? { backgroundThrottling: false } : {})
    }
  })
  window.once('ready-to-show', () => { if (!testMode) window?.show() })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  window.on('closed', () => { window = undefined })
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
}

if (hasLock) void app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('dev.praxis.desktop')
  settings = new SettingsStore(join(app.getPath('userData'), 'settings.json'), app.getAppPath())
  const fileActions: FileActionResult[] = []
  if (testMode) Object.assign(globalThis, { __praxisFileActions: fileActions })
  localFiles = new LocalFileService({
    getWorkspace: () => settings.get().workspace,
    openPath: path => shell.openPath(path),
    revealPath: path => shell.showItemInFolder(path),
    simulateActions: testMode,
    onAction: testMode ? action => { fileActions.push(action) } : undefined
  })
  backend.on('event', event => {
    localFiles.rememberBackendEvent(event)
    if (!window?.webContents.isDestroyed()) window?.webContents.send('praxis:event', event)
  })
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
