import { test, expect, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SessionSnapshot, SessionSummary } from '../../src/shared/protocol'

let application: ElectronApplication | undefined
let service: ChildProcess | undefined
let page: Page
let profile: string
let servicePid: number | undefined
let endpoint: string
let token: string
const errors: string[] = []

async function screenshot(path: string, region?: Locator) {
  const packaged = Boolean(process.env.PRAXIS_UI_E2E_EXECUTABLE)
  // Windows may suspend painting after a production window has been hidden.
  // Show it without taking focus only for the actual capture.
  if (packaged) await application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive())
  try { await (region || page).screenshot({ scale: 'css', path, animations: 'disabled' }) }
  finally { if (packaged) await application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide()) }
}

async function request<T>(path: string, data?: unknown, method = data === undefined ? 'GET' : 'POST'): Promise<T> {
  const response = await fetch(endpoint + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(5000)
  })
  expect(response.ok).toBe(true)
  return response.json() as Promise<T>
}

test.beforeEach(async () => {
  profile = await mkdtemp(join(tmpdir(), 'praxis-real-desktop-'))
  const repository = resolve(process.env.PRAXIS_PATH || '../Praxis')
  const python = process.env.PRAXIS_PYTHON || join(repository, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  const dataDir = join(profile, 'service')
  const workspace = join(profile, 'desktop-workspace')
  await mkdir(workspace)
  await mkdir(dataDir)
  await writeFile(join(dataDir, 'mcp.json'), JSON.stringify({ servers: {
    '离线工具': { command: python, args: [resolve('tests/fixtures/mcp-server.py')] },
    '文档服务': { enabled: false }
  } }))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ praxisPath: repository, pythonPath: python, workspace }))
  const env = { ...process.env, PRAXIS_DATA_DIR: dataDir, PYTHONPATH: join(repository, 'src'), ADA_API_KEY: 'offline', ADA_MODEL: 'offline', PRAXIS_BYPASS_APPROVALS: '0' }
  service = spawn(python, [resolve('tests/fixtures/python-service.py'), '--data-dir', dataDir], {
    env: { ...env, PRAXIS_TEST_SEED_HISTORY: '1' }, windowsHide: true, stdio: 'ignore'
  })
  await expect.poll(async () => {
    try {
      const registration = JSON.parse(await readFile(join(dataDir, 'service.json'), 'utf8'))
      servicePid = registration.pid
      endpoint = `http://127.0.0.1:${registration.port}`
      token = (await readFile(join(dataDir, 'service.token'), 'utf8')).trim()
      return true
    } catch { return false }
  }, { timeout: 15_000 }).toBe(true)
  const desktopEnv: NodeJS.ProcessEnv = { ...env, PRAXIS_UI_DATA_DIR: profile, PRAXIS_UI_TEST_MODE: '1' }
  delete desktopEnv.ELECTRON_RUN_AS_NODE
  delete desktopEnv.PRAXIS_UI_TEST_SERVER
  // Packaged builds intentionally disable mock-server hooks. Exercise their
  // normal service connection against the same isolated real Python service.
  const executablePath = process.env.PRAXIS_UI_E2E_EXECUTABLE
  application = await electron.launch({ executablePath, args: executablePath ? [] : [resolve('.')], env: Object.fromEntries(Object.entries(desktopEnv).filter((entry): entry is [string, string] => entry[1] !== undefined)) })
  page = await application.firstWindow()
  if (executablePath) await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.webContents.setBackgroundThrottling(false)
    window.hide()
  })
  errors.length = 0
  page.on('pageerror', error => errors.push(error.message))
  await expect(page.locator('.session-item')).toHaveCount(2)
})

test.afterEach(async () => {
  // Stop only the service belonging to this test's isolated data directory.
  if (servicePid) { try { process.kill(servicePid) } catch { /* Already exited. */ } }
  if (service && service.exitCode === null && service.signalCode === null) {
    const exited = once(service, 'exit')
    service.kill()
    await exited
  }
  await application?.close()
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  application = undefined
  servicePid = undefined
  expect(errors).toEqual([])
})

test('restores saved chats and discovers other clients across workspaces without losing live state', async ({}, testInfo) => {
  // MCP starts before any session Agent exists, using the actual stdio transport.
  await expect.poll(() => request('/api/mcp/servers')).toEqual({ servers: [
    { name: '离线工具', state: 'connected' }, { name: '文档服务', state: 'disabled' }
  ] })
  await page.locator('textarea').fill('/mcp')
  await page.locator('textarea').press('Enter')
  const mcp = page.getByRole('dialog', { name: 'MCP servers' })
  await expect(mcp.locator('li')).toHaveText(['离线工具Connected', '文档服务Disabled'])
  await mcp.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.locator('.session-item')).toHaveCount(2)
  const alpha = page.locator('.session-item').filter({ hasText: 'Saved question alpha' })
  const beta = page.locator('.session-item').filter({ hasText: 'Saved question beta' })
  await alpha.click()
  await expect(page.getByRole('article', { name: 'Assistant response' })).toContainText('Saved answer alpha')
  await expect(page.locator('.user-content')).toHaveText('Saved question alpha')
  await expect(page.locator('.tool-message')).toHaveCount(1)
  await beta.click()
  await expect(page.getByRole('article', { name: 'Assistant response' })).toContainText('Saved answer beta')
  await expect(page.getByText('Saved answer alpha.', { exact: false })).toHaveCount(0)
  await page.reload()
  await alpha.click()
  await expect(page.getByRole('article', { name: 'Assistant response' })).toContainText('Saved answer alpha')
  await page.getByRole('link', { name: 'notes.md · Notes', exact: true }).click()
  await expect(page.locator('.artifact-panel')).toContainText('Notes from alpha')
  await page.getByRole('button', { name: 'Close preview' }).click()

  // These commands bypass the desktop entirely, exactly as a terminal client does.
  const workspace = join(profile, 'terminal-workspace')
  await mkdir(workspace)
  const { session } = await request<{ session: SessionSummary }>('/api/sessions', { command_id: randomUUID(), workspace })
  await request(`/api/sessions/${session.id}/inputs`, { command_id: randomUUID(), text: 'hold this turn from terminal' })
  const terminal = page.locator('.session-item').filter({ hasText: 'hold this turn from terminal' })
  await expect(terminal).toBeVisible({ timeout: 8000 })
  await expect(page.getByRole('article', { name: 'Assistant response' })).toContainText('Saved answer alpha')
  await terminal.click()
  await expect(page.locator('.user-content')).toHaveText('hold this turn from terminal')
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
  await alpha.click()
  const running = await request<SessionSnapshot>(`/api/sessions/${session.id}/snapshot`)
  await request(`/api/sessions/${session.id}/turns/${running.session.active_turn!.id}/cancel`, {})
  await expect(terminal.getByLabel('Running')).toHaveCount(0)
  await terminal.click()
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  await request(`/api/sessions/${session.id}/inputs`, { command_id: randomUUID(), text: 'continue externally' })
  await expect(page.getByRole('article', { name: 'Assistant response' })).toContainText('offline response')
  await expect(page.locator('.user-content')).toHaveText(['hold this turn from terminal', 'continue externally'])
  await screenshot(testInfo.outputPath('shared-service-restored.png'))
})

test('deletes running work and synchronizes remote deletion with the real service', async ({}, testInfo) => {
  const { sessions } = await request<{ sessions: SessionSummary[] }>('/api/sessions')
  const alpha = sessions.find(session => session.title === 'Saved question alpha')!
  const beta = sessions.find(session => session.title === 'Saved question beta')!
  // Even a chat that was never opened is removed through the shared list refresh.
  await request(`/api/sessions/${beta.id}`, undefined, 'DELETE')
  await expect(page.locator('.session-item')).toHaveCount(1)
  await page.locator('.session-item').click()
  await expect(page.locator('.user-content')).toHaveText('Saved question alpha')
  await page.locator('textarea').fill('hold this turn for deletion')
  await page.locator('textarea').press('Enter')
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
  await page.locator('textarea').fill('/delete')
  await page.locator('textarea').press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Delete chat?' })
  await expect(dialog).toContainText('This chat is running.')
  await screenshot(testInfo.outputPath('delete-running-chat.png'))
  const originalSize = await application!.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    const size = window.getContentSize()
    window.setMinimumSize(480, 400)
    window.setContentSize(600, 460)
    return size
  })
  await expect(dialog.getByRole('button', { name: 'Delete chat', exact: true })).toBeInViewport()
  await screenshot(testInfo.outputPath('delete-running-compact.png'))
  await application!.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size[0], size[1]), originalSize)
  await dialog.getByRole('button', { name: 'Delete chat', exact: true }).click()
  await expect(page.locator('.session-item')).toHaveCount(0)
  await expect.poll(() => request('/api/sessions')).toEqual({ sessions: [] })
  await expect.poll(async () => (await fetch(`${endpoint}/api/sessions/${alpha.id}/snapshot`, {
    headers: { Authorization: `Bearer ${token}` }
  })).status).toBe(404)
  expect(await readFile(join(alpha.workspace, 'notes.md'), 'utf8')).toContain('Notes from alpha')
  expect(await request('/api/mcp/servers')).toEqual({ servers: [
    { name: '离线工具', state: 'connected' }, { name: '文档服务', state: 'disabled' }
  ] })

  await page.locator('textarea').fill('Continue after deletion')
  await page.locator('textarea').press('Enter')
  await expect(page.getByRole('article', { name: 'Assistant response' })).toContainText('offline response')
  const remaining = await request<{ sessions: SessionSummary[] }>('/api/sessions')
  // An open conversation receives the terminal deletion control through SSE.
  await request(`/api/sessions/${remaining.sessions[0].id}`, undefined, 'DELETE')
  await expect(page.locator('.session-item')).toHaveCount(0)
  await expect(page.locator('.user-content')).toHaveCount(0)
  await expect.poll(() => page.evaluate(async () => (await window.praxis.getInfo()).connection.state)).toBe('connected')
})

test('bottom approvals show complete commands and apply only supported decisions with the real service', async ({}, testInfo) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  // The existing service already requires approval. Wait for the dialog to
  // populate its settings instead of toggling its initial placeholder value.
  await expect(page.getByRole('checkbox', { name: 'Bypass approvals', exact: true })).not.toBeChecked()
  await page.getByRole('button', { name: 'Close settings', exact: true }).click()
  await expect(page.getByRole('dialog')).not.toBeVisible()
  for (const approved of [true, false]) {
    await page.getByRole('button', { name: 'New chat', exact: true }).first().click()
    await page.locator('textarea').fill('approval example long')
    await page.locator('textarea').press('Enter')
    const card = page.getByRole('region', { name: 'Tool approval' })
    const details = card.getByRole('button', { name: 'View command', exact: true })
    const detailPopup = page.getByRole('dialog', { name: 'Command details', exact: true })
    await expect(card).toBeVisible()
    await expect(page.locator('.tool-message')).toHaveCount(0)
    await expect(page.locator('.inline-permission, .task-tool-permission')).toHaveCount(0)
    await expect(card.locator('.praxis-approval-detail-preview')).toHaveText('echo praxis-approval-' + 'visible-command-'.repeat(12))
    await expect(card.locator('.praxis-approval-option')).toHaveText(['1Reject', '2Allow'])
    const { sessions } = await request<{ sessions: SessionSummary[] }>('/api/sessions')
    const session = sessions.find(item => item.active_turn)!
    await details.press('Enter')
    await expect(detailPopup).toBeVisible()
    await expect(detailPopup.locator(':scope > pre')).toHaveText('echo praxis-approval-' + 'visible-command-'.repeat(12))
    await detailPopup.press('Escape')
    await expect(detailPopup).not.toBeVisible()
    await expect(details).toBeFocused()
    if (approved) {
      await card.getByRole('heading').click()
      await screenshot(testInfo.outputPath('approval-desktop.png'))
      await screenshot(testInfo.outputPath('approval-card.png'), card)
      await details.click()
      await screenshot(testInfo.outputPath('approval-command-detail.png'))
      await page.locator('.user-content').last().click()
      await expect(detailPopup).not.toBeVisible()
      await card.getByRole('button', { name: 'Allow', exact: true }).hover()
      await screenshot(testInfo.outputPath('approval-hover.png'), card)
      await writeFile(testInfo.outputPath('approval-metrics.json'), JSON.stringify(await card.evaluate(element => {
        const measure = (selector: string) => {
          const node = element.querySelector(selector)!
          const style = getComputedStyle(node)
          return { height: node.getBoundingClientRect().height, fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight, color: style.color, background: style.backgroundColor, radius: style.borderRadius }
        }
        return { title: measure('h2'), command: measure('.praxis-approval-detail-preview'), reject: measure('.praxis-approval-option'), allow: measure('.praxis-approval-option:last-child'), number: measure('.praxis-approval-number') }
      }), null, 2))
      const size = await application!.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]
        const size = window.getContentSize()
        window.setMinimumSize(480, 400)
        window.setContentSize(600, 640)
        return size
      })
      await expect(details).toBeInViewport()
      await expect(card.getByRole('button', { name: 'Allow', exact: true })).toBeInViewport()
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
      await screenshot(testInfo.outputPath('approval-compact.png'))
      await details.press('Enter')
      await expect(detailPopup).toBeInViewport()
      const bounds = await detailPopup.boundingBox()
      expect(bounds!.x).toBeGreaterThanOrEqual(16)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(584)
      await screenshot(testInfo.outputPath('approval-compact-detail.png'))
      await detailPopup.press('Escape')
      await application!.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size[0], size[1]), size)
    }
    await card.getByRole('button', { name: approved ? 'Allow' : 'Reject', exact: true }).press('Enter')
    await expect(card).toHaveCount(0)
    await expect(page.getByRole('article', { name: 'Assistant response' })).toContainText(approved ? 'Command approved and completed.' : 'Command rejected without execution.')
    const snapshot = await request<SessionSnapshot>(`/api/sessions/${session.id}/snapshot`)
    expect(snapshot.approvals).toEqual([])
    expect(snapshot.view_events?.some(event => event.event === 'ToolStarted')).toBe(approved)
    const result = snapshot.messages.find(message => message.role === 'tool')!
    expect(result.status).toBe(approved ? 'completed' : 'denied')
    expect(result.content).toContain(approved ? 'praxis-approval' : 'declined by the user')
  }
})
