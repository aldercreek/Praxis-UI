import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let application: ElectronApplication
let page: Page
let profile: string
const errors: string[] = []

test.beforeEach(async () => {
  profile = await mkdtemp(join(tmpdir(), 'praxis-ui-e2e-'))
  errors.length = 0
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    PRAXIS_UI_DATA_DIR: profile, PRAXIS_UI_TEST_MODE: '1', PRAXIS_UI_TEST_SERVER: resolve('tests/fixtures/ui-server.cjs')
  }
  delete env.ELECTRON_RUN_AS_NODE
  application = await electron.launch({ args: [resolve('.')], env })
  page = await application.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await expect.poll(() => page.evaluate(async () => (await window.praxis.getInfo()).connection.state)).toBe('connected')
})

test.afterEach(async () => {
  await application?.close()
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  expect(errors).toEqual([])
})

async function send(text: string): Promise<void> {
  const input = page.locator('textarea')
  await input.fill(text)
  await input.press('Enter')
}

test('concurrent conversations keep streams isolated; supplementary input and stop stay responsive', async () => {
  await expect(page.getByRole('heading', { name: 'Praxis', exact: true })).toBeVisible()
  await page.screenshot({ animations: 'disabled', path: 'test-results/desktop-empty.png' })
  await send('长任务：检查项目')
  await expect(page.getByText('任务正在执行，可以继续补充要求。')).toBeVisible()
  await send('请保留原来的文件')
  await expect(page.locator('.user-content').filter({ hasText: '请保留原来的文件' })).toHaveCount(1)
  await page.getByRole('button', { name: 'New chat' }).first().click()
  await send('第二个独立任务')
  await expect(page.getByText('已完成这条独立会话中的任务。')).toBeVisible()
  await expect(page.getByText('任务正在执行，可以继续补充要求。')).toHaveCount(0)
  await expect(page.locator('.session-item')).toHaveCount(2)
  await page.locator('.session-item').filter({ hasText: '长任务：检查项目' }).click()
  await expect(page.getByText('任务正在执行，可以继续补充要求。')).toBeVisible()
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  await expect(page.locator('.activity')).toHaveCount(0)
  await expect(page.locator('.tool-message .spin')).toHaveCount(0)
  await page.locator('.session-item').filter({ hasText: '第二个独立任务' }).click()
  await expect(page.locator('pre')).toContainText('print("Praxis")')
  await page.screenshot({ animations: 'disabled', path: 'test-results/desktop-conversation.png' })
})

test('approval accept and reject are real protocol operations; settings remain keyboard accessible', async () => {
  await page.getByRole('button', { name: /^Settings/ }).click()
  await page.getByRole('checkbox', { name: 'Bypass approvals', exact: true }).uncheck()
  await page.getByRole('button', { name: 'Save settings', exact: true }).click()
  await expect(page.getByRole('dialog')).not.toBeVisible()
  expect(await page.evaluate(async () => (await window.praxis.request('initialize')).bypass_approvals)).toBe(false)
  await send('审批：运行命令')
  await expect(page.getByRole('region', { name: 'Tool approval' })).toBeVisible()
  await page.screenshot({ animations: 'disabled', path: 'test-results/desktop-approval.png' })
  await page.getByRole('button', { name: 'Allow', exact: true }).click()
  await expect(page.getByText('操作已获得确认并执行完成。')).toBeVisible()
  await page.getByRole('button', { name: 'New chat' }).first().click()
  await send('审批：另一个命令')
  await page.getByRole('button', { name: 'Deny', exact: true }).click()
  await expect(page.getByText('已按你的要求拒绝执行。')).toBeVisible()
  await expect(page.locator('.tool-summary')).toHaveText('已拒绝运行 echo praxis')
  await page.locator('.tool-message > summary').click()
  await expect(page.locator('.tool-details')).toContainText('用户拒绝执行')
  await page.keyboard.press('Control+,')
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByRole('checkbox', { name: 'Bypass approvals', exact: true })).not.toBeChecked()
  await page.getByRole('button', { name: 'Save settings', exact: true }).click()
  await expect(page.getByRole('dialog')).not.toBeVisible()
  const invalidSettings = await page.evaluate(async () => {
    const before = await window.praxis.getInfo()
    let rejected = false
    try { await window.praxis.updateSettings({ praxisPath: before.settings.praxisPath + '-does-not-exist' }) }
    catch { rejected = true }
    const after = await window.praxis.getInfo()
    return { rejected, unchanged: before.settings.praxisPath === after.settings.praxisPath, connection: after.connection.state }
  })
  expect(invalidSettings).toEqual({ rejected: true, unchanged: true, connection: 'connected' })
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 640))
  await page.screenshot({ animations: 'disabled', path: 'test-results/desktop-compact.png' })
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
  expect(overflow).toBe(false)
})

test('desktop defaults to bypass and cannot change approval mode during a running turn', async () => {
  await expect(page.locator('.approval-mode')).toHaveText('Bypass')
  expect(await page.evaluate(async () => (await window.praxis.request('initialize')).bypass_approvals)).toBe(true)
  await send('审批：默认直接运行')
  await expect(page.getByText('Bypass 模式下已直接执行完成。')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Tool approval' })).toHaveCount(0)
  await expect(page.locator('.tool-summary')).toHaveText('已运行 echo praxis')
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  await send('长任务：检查设置保护')
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
  const change = await page.evaluate(async () => {
    let error = ''
    try { await window.praxis.updateSettings({ bypassApprovals: false }) }
    catch (reason) { error = String(reason) }
    return { error, bypass: (await window.praxis.getInfo()).settings.bypassApprovals }
  })
  expect(change.error).toContain('Stop running sessions')
  expect(change.bypass).toBe(true)
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
})

test('sending still works when the launcher closes its diagnostic pipe', async () => {
  await application.evaluate(({ dialog }) => {
    const state = globalThis as typeof globalThis & { errorDialogs: string[] }
    state.errorDialogs = []
    dialog.showErrorBox = (title, content) => { state.errorDialogs.push(`${title}: ${content}`) }
  })
  // Reproduce a GUI app outliving the command that launched it.
  application.process().stderr!.destroy()
  await send('诊断日志：验证发送消息')
  await expect(page.getByText('已完成这条独立会话中的任务。')).toBeVisible()
  expect(await page.evaluate(async () => (await window.praxis.getInfo()).connection.state)).toBe('connected')
  const dialogs = await application.evaluate(() => (globalThis as typeof globalThis & { errorDialogs: string[] }).errorDialogs)
  expect(dialogs).toEqual([])
})

test('streaming follows the latest message until the user scrolls away', async () => {
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 640))
  await send('滚动测试')
  const transcript = page.locator('.transcript')
  const contentLength = () => page.locator('.markdown').evaluate(element => element.textContent!.length)
  const bottomDistance = () => transcript.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)
  await expect.poll(() => transcript.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(160)
  await expect.poll(bottomDistance).toBeLessThan(2)

  await transcript.evaluate(element => { element.scrollTop = 0 })
  await expect(page.getByRole('button', { name: '回到最新消息' })).toBeVisible()
  const lengthWhenReading = await contentLength()
  await expect.poll(contentLength).toBeGreaterThan(lengthWhenReading + 100)
  expect(await transcript.evaluate(element => element.scrollTop)).toBe(0)

  await page.getByRole('button', { name: '回到最新消息' }).click()
  const lengthWhenFollowing = await contentLength()
  await expect.poll(contentLength).toBeGreaterThan(lengthWhenFollowing + 100)
  await expect.poll(bottomDistance).toBeLessThan(2)
  await expect(page.getByRole('button', { name: '回到最新消息' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(page.locator('.turn-notice')).toHaveText('已停止')
})

test('tool activity stays compact while details, errors and live output remain accessible', async () => {
  await send('工具展示：分析 Praxis 项目')
  await expect(page.locator('.tool-group > summary')).toHaveText(['已浏览目录并读取文件 · 3 项操作', '已编辑文件并运行命令 · 4 项操作'])
  await expect(page.locator('.tool-error > summary')).toContainText('运行失败：')
  await expect(page.locator('.tool-message > summary').filter({ hasText: 'python -m pytest' })).toContainText('正在运行')
  await expect(page.locator('.message-assistant .message-label')).toHaveCount(0)
  await expect(page.locator('.message-user .message-label')).toHaveCount(0)
  await expect(page.locator('.transcript-content > .tool-message > summary .lucide-square-terminal').first()).toBeVisible()
  const bubble = await page.locator('.message-user').boundingBox()
  expect(bubble!.height).toBeLessThan(48)
  await page.screenshot({ animations: 'disabled', path: 'test-results/tool-activity.png' })
  await page.locator('.transcript-content').screenshot({ animations: 'disabled', path: 'test-results/tool-summaries.png' })

  const shell = page.locator('.transcript-content > .tool-message').filter({ hasText: '已运行 Get-ChildItem' })
  await shell.locator(':scope > summary').click()
  const output = shell.getByRole('region', { name: 'Shell output' })
  await expect(output).toBeVisible()
  expect(await output.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
  await output.focus()
  await output.press('End')
  await expect.poll(() => output.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  await output.press('Home')
  await page.locator('textarea').focus()
  await shell.screenshot({ animations: 'disabled', path: 'test-results/tool-shell-refined.png' })
  await page.screenshot({ animations: 'disabled', path: 'test-results/tool-shell-context.png' })
  await shell.locator(':scope > summary').click()

  const group = page.locator('.tool-group > summary').first()
  await group.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.tool-group-items').first()).toBeVisible()
  await expect(page.locator('.tool-group .tool-summary').filter({ hasText: '已读取 src/praxis_agent/agent.py:1–80' })).toBeVisible()
  await group.click()
  const edits = page.locator('.tool-group').filter({ has: page.locator(':scope > summary', { hasText: '已编辑文件并运行命令' }) })
  await edits.locator(':scope > summary').click()
  await edits.locator('.tool-message > summary').first().click()
  await expect(edits.locator('.file-diff')).toContainText('+<span>已读取 README.md</span>')
  await expect(edits.getByText('Updated tool summaries.', { exact: true })).not.toBeVisible()
  await page.screenshot({ animations: 'disabled', path: 'test-results/tool-group-expanded.png' })
  await edits.locator('.tool-arguments > summary').first().click()
  await expect(edits.getByText('Updated tool summaries.', { exact: true })).toBeVisible()
  await edits.locator(':scope > summary').click()
  const failed = page.locator('.tool-error')
  await failed.locator(':scope > summary').click()
  await expect(failed.locator('.tool-details')).toContainText('Cannot find path')
  await failed.locator('.tool-arguments > summary').click()
  await expect(failed.locator('.tool-arguments pre')).toContainText('tests\\\\missing')
  await failed.locator('.tool-details').screenshot({ animations: 'disabled', path: 'test-results/tool-details-fonts.png' })
  const live = page.locator('.tool-message').filter({ has: page.locator('summary', { hasText: 'python -m pytest' }) })
  await live.locator(':scope > summary').click()
  await expect(live.locator('.terminal-output')).toContainText('Checking desktop protocol')
  await page.screenshot({ animations: 'disabled', path: 'test-results/tool-activity-expanded.png' })
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(live.locator(':scope > summary')).toContainText('已停止运行')
  await expect(page.locator('.tool-message .spin')).toHaveCount(0)
  await expect(page.locator('.turn-notice')).toHaveText('已停止')

  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 640))
  await failed.locator(':scope > summary').click()
  await live.locator(':scope > summary').click()
  await expect(page.getByRole('button', { name: '回到最新消息' })).toHaveCount(0)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth || document.querySelector('.transcript')!.scrollWidth > document.querySelector('.transcript')!.clientWidth)
  expect(overflow).toBe(false)
  await page.screenshot({ animations: 'disabled', path: 'test-results/tool-activity-compact.png' })

  await shell.locator(':scope > summary').click()
  await page.locator('.transcript').evaluate(element => { element.scrollTop = 0 })
  await expect(page.getByRole('button', { name: '回到最新消息' })).toBeVisible()
  await page.screenshot({ animations: 'disabled', path: 'test-results/tool-scroll-affordance.png' })
  await page.getByRole('button', { name: '回到最新消息' }).click()
  await expect.poll(() => page.locator('.transcript').evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(2)
  await expect(page.getByRole('button', { name: '回到最新消息' })).toHaveCount(0)
})
