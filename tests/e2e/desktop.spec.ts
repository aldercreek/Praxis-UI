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
  await expect(page.locator('.connection-status')).toContainText('Praxis connected')
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
  await expect(page.getByRole('heading', { name: 'Start your work here' })).toBeVisible()
  await page.screenshot({ path: 'test-results/desktop-empty.png' })
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
  await expect(page.locator('.statusbar')).toContainText('Ready')
  await expect(page.locator('.tool-message .spin')).toHaveCount(0)
  await page.locator('.session-item').filter({ hasText: '第二个独立任务' }).click()
  await expect(page.locator('pre')).toContainText('print("Praxis")')
  await page.screenshot({ path: 'test-results/desktop-conversation.png' })
})

test('approval accept and reject are real protocol operations; settings remain keyboard accessible', async () => {
  await send('审批：运行命令')
  await expect(page.getByRole('region', { name: 'Tool approval' })).toBeVisible()
  await page.screenshot({ path: 'test-results/desktop-approval.png' })
  await page.getByRole('button', { name: 'Allow', exact: true }).click()
  await expect(page.getByText('操作已获得确认并执行完成。')).toBeVisible()
  await page.getByRole('button', { name: 'New chat' }).first().click()
  await send('审批：另一个命令')
  await page.getByRole('button', { name: 'Deny', exact: true }).click()
  await expect(page.getByText('已按你的要求拒绝执行。')).toBeVisible()
  await expect(page.locator('.tool-status')).toHaveText('Denied')
  await page.locator('.tool-message summary').click()
  await expect(page.locator('.tool-details')).toContainText('用户拒绝执行')
  await page.keyboard.press('Control+,')
  await expect(page.getByRole('dialog')).toBeVisible()
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
  await page.screenshot({ path: 'test-results/desktop-compact.png' })
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
  expect(overflow).toBe(false)
})
