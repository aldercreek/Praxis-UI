import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
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
  application = await electron.launch({ args: [resolve('.')], env: Object.fromEntries(Object.entries(desktopEnv).filter((entry): entry is [string, string] => entry[1] !== undefined)) })
  page = await application.firstWindow()
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

test('restores saved chats and discovers other clients across workspaces without losing live state', async () => {
  // MCP starts before any session Agent exists, using the actual stdio transport.
  await expect.poll(() => request('/api/mcp/servers')).toEqual({ servers: [
    { name: '离线工具', state: 'connected' }, { name: '文档服务', state: 'disabled' }
  ] })
  await page.locator('textarea').fill('/mcp')
  await page.locator('textarea').press('Enter')
  const mcp = page.getByRole('dialog', { name: 'MCP 服务' })
  await expect(mcp.locator('li')).toHaveText(['离线工具已连接', '文档服务已禁用'])
  await mcp.getByRole('button', { name: '关闭', exact: true }).click()
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
  await page.getByRole('button', { name: '关闭预览' }).click()

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
  await page.screenshot({ path: 'test-results/shared-service-restored.png', animations: 'disabled' })
})

test('deletes running work and synchronizes remote deletion with the real service', async () => {
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
  await page.screenshot({ path: 'test-results/delete-running-chat.png', animations: 'disabled' })
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
