import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { stopFixtureService } from './service-fixture'

let application: ElectronApplication
let page: Page
let profile: string
let workspace: string
let env: Record<string, string>
const errors: string[] = []

async function launch() {
  application = await electron.launch({ args: [resolve('.')], env })
  page = await application.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await expect.poll(() => page.evaluate(async () => (await window.praxis.getInfo()).connection.state)).toBe('connected')
  await expect(page.locator('.session-list')).toHaveAttribute('aria-busy', 'false')
}

test.beforeEach(async ({}, testInfo) => {
  await mkdir(testInfo.outputDir, { recursive: true })
  profile = await mkdtemp(join(testInfo.outputDir, 'profile-'))
  workspace = join(profile, 'workspace')
  await mkdir(workspace)
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ workspace, notifications: false }))
  env = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    PRAXIS_DATA_DIR: join(profile, 'service'), PRAXIS_UI_DATA_DIR: profile, PRAXIS_UI_TEST_MODE: '1',
    PRAXIS_UI_TEST_SERVER: resolve('tests/fixtures/ui-server.cjs'), PRAXIS_UI_TEST_CONTROLLED_INPUT: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  errors.length = 0
  const service = spawn(process.execPath, [resolve('tests/fixtures/ui-server.cjs'), '--data-dir', join(profile, 'service'), '--bypass'], { env, windowsHide: true, stdio: 'ignore' })
  service.unref()
  await expect.poll(async () => { try { await readFile(join(profile, 'service/service.json')); return true } catch { return false } }).toBe(true)
  await launch()
})

test.afterEach(async () => {
  await page?.evaluate(() => window.praxis.updateSettings({ notifications: false })).catch(() => {})
  await stopFixtureService(join(profile, 'service'))
  await application?.close()
  expect(resolve(profile).startsWith(resolve(test.info().outputDir))).toBe(true)
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  expect(errors).toEqual([])
})

async function start(title: string) {
  await page.locator('.composer textarea').fill(title)
  await page.locator('.composer textarea').press('Enter')
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
  return page.evaluate(async title => (await window.praxis.request<{ sessions: { id: string; title: string }[] }>('session.list')).sessions.find(session => session.title === title)!.id, title)
}

async function emit(id: string, ...events: { event: string; data?: Record<string, unknown>; agent_id?: string }[]) {
  await page.evaluate(({ id, events }) => window.praxis.request('input.submit', { session_id: id, test_events: events }), { id, events })
}

const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('praxis.drafts.v1') || '{"drafts":{}}').drafts)

test('chat text and quotes survive a restart and disappear after deleting the chat', async () => {
  const id = await start('Draft storage chat')
  await emit(id, { event: 'AssistantTextCompleted', data: { text: 'A retained source for the next question.' } }, { event: 'TurnSettled', data: { status: 'idle' } })
  await expect(page.locator('.message-assistant p')).toBeVisible()
  await page.locator('.message-assistant p').evaluate(node => {
    const range = document.createRange()
    range.selectNodeContents(node)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
  await page.getByRole('button', { name: 'Quote selected text' }).click()
  await page.locator('.composer textarea').fill('Continue with this draft')
  await expect.poll(async () => (await stored())[id]?.text).toBe('Continue with this draft')
  expect((await stored())[id].quote.text).toBe('A retained source for the next question.')
  expect(Object.keys(await stored())).toEqual([id])
  await application.close()
  await launch()
  await page.locator('.session-item').filter({ hasText: 'Draft storage chat' }).click()
  await expect(page.locator('.composer textarea')).toHaveValue('Continue with this draft')
  await expect(page.locator('.quote-draft')).toContainText('A retained source for the next question.')
  await page.screenshot({ path: test.info().outputPath('restored-draft-and-quote.png') })
  await page.locator('.session-item').filter({ hasText: 'Draft storage chat' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: /^Delete chat$/ }).click()
  await page.getByRole('dialog', { name: 'Delete chat?' }).getByRole('button', { name: 'Delete chat', exact: true }).click()
  await expect.poll(async () => (await stored())[id]).toBeUndefined()
  await expect(page.locator('.quote-draft')).toHaveCount(0)
})

test('new-chat drafts survive immediate exit and remain separate for each workspace', async () => {
  await page.locator('.composer textarea').fill('Unsaved work in the first workspace')
  await application.close()
  await launch()
  await expect(page.locator('.composer textarea')).toHaveValue('Unsaved work in the first workspace')
  const other = join(profile, 'other-workspace')
  await mkdir(other)
  await page.evaluate(workspace => window.praxis.updateSettings({ workspace }), other)
  await page.reload()
  await expect(page.locator('.composer textarea')).toHaveValue('')
  await page.locator('.composer textarea').fill('Another workspace draft')
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await application.close()
  await launch()
  await expect(page.locator('.composer textarea')).toHaveValue('Another workspace draft')
  expect((await stored())[`new:${workspace}`].text).toBe('Unsaved work in the first workspace')
  expect((await stored())[`new:${other}`].text).toBe('Another workspace draft')
  await page.evaluate(workspace => window.praxis.updateSettings({ workspace }), workspace)
  await page.reload()
  await expect(page.locator('.composer textarea')).toHaveValue('Unsaved work in the first workspace')
})

test('notification events open their chat and the preference changes without reconnecting', async () => {
  await page.evaluate(() => window.praxis.updateSettings({ notifications: true }))
  await page.reload()
  await expect(page.locator('.session-list')).toHaveAttribute('aria-busy', 'false')
  await application.evaluate(({ Notification, BrowserWindow }) => {
    const notifications: Electron.Notification[] = []
    const flashes: boolean[] = []
    const window = BrowserWindow.getAllWindows()[0]
    const flash = window.flashFrame.bind(window)
    window.flashFrame = value => { flashes.push(value); flash(value) }
    Notification.isSupported = () => true
    Notification.prototype.show = function () { notifications.push(this) }
    Object.assign(globalThis, { productivityNotifications: notifications, productivityFlashes: flashes })
  })
  const count = () => application.evaluate(() => (globalThis as unknown as { productivityNotifications: unknown[] }).productivityNotifications.length)
  const id = await start('Notification target')
  await emit(id, { event: 'TurnCompleted' }, { event: 'TurnSettled', data: { status: 'idle' } })
  await expect.poll(count).toBe(1)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(() => application.evaluate(() => (globalThis as unknown as { productivityFlashes: boolean[] }).productivityFlashes.includes(true))).toBe(true)
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await application.evaluate(() => (globalThis as unknown as { productivityNotifications: Electron.Notification[] }).productivityNotifications[0].emit('click'))
  await expect(page.locator('.titlebar-title')).toHaveText('Notification target')
  await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true)
  await expect.poll(() => application.evaluate(() => (globalThis as unknown as { productivityFlashes: boolean[] }).productivityFlashes.at(-1))).toBe(false)
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  const second = await start('Focused task')
  await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused())).toBe(true)
  await emit(second, { event: 'TurnFailed', data: { message: 'Failed in the foreground' } }, { event: 'TurnSettled', data: { status: 'failed' } })
  await expect(page.locator('.system-message')).toContainText('Failed in the foreground')
  await page.evaluate(() => window.praxis.getInfo())
  expect(await count()).toBe(1)
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide())
  await emit(second, { event: 'ApprovalPending', data: { approval_id: 'child-private', tool_name: 'run_command', arguments: { command: 'secret' } }, agent_id: 'child' })
  await expect(page.getByRole('region', { name: 'Tool approval' })).toBeVisible()
  expect(await count()).toBe(1)
  await emit(second, { event: 'ApprovalPending', data: { approval_id: 'main-private', tool_name: 'run_command', arguments: { command: 'secret' } } })
  await expect.poll(count).toBe(2)
  expect(await application.evaluate(() => (globalThis as unknown as { productivityNotifications: Electron.Notification[] }).productivityNotifications[1].body)).toBe('Approval needed: run_command')
  await emit(second, { event: 'ApprovalClosed', data: { approval_id: 'main-private' } }, { event: 'ApprovalClosed', data: { approval_id: 'child-private' } })
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show())
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('checkbox', { name: 'Desktop notifications' }).uncheck()
  await page.screenshot({ path: test.info().outputPath('notification-settings.png'), animations: 'disabled' })
  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(page.locator('.titlebar-title')).toHaveText('Focused task')
  expect((await page.evaluate(() => window.praxis.getInfo())).settings.notifications).toBe(false)
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide())
  await emit(second, { event: 'ApprovalPending', data: { approval_id: 'disabled', tool_name: 'read_file' } })
  await expect(page.getByRole('region', { name: 'Tool approval' })).toBeVisible()
  await page.evaluate(() => window.praxis.getInfo())
  expect(await count()).toBe(2)
})
