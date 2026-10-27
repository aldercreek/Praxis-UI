import { test, expect, _electron as electron } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { stopFixtureService } from './service-fixture'

test('approved prototype: rendered typography, stable tools, file chips and context actions', async ({}, testInfo) => {
  const profile = await mkdtemp(join(tmpdir(), 'praxis-prototype-e2e-'))
  const workspace = join(profile, 'Praxis')
  await mkdir(workspace)
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ workspace, bypassApprovals: false }))
  await writeFile(join(workspace, 'session_runtime.py'), 'async def run():\n    await synchronize()\n')
  await writeFile(join(workspace, 'useSession.ts'), 'export const ready = true;\n')
  const env = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined))
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: [resolve('.')], env: { ...env, PRAXIS_UI_TEST_MODE: '1', PRAXIS_DATA_DIR: join(profile, 'service'), PRAXIS_UI_DATA_DIR: profile, PRAXIS_UI_TEST_SERVER: resolve('tests/fixtures/ui-server.cjs'), PRAXIS_UI_TEST_CONTROLLED_INPUT: '1' } })
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(930, 802))
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await expect.poll(() => page.evaluate(async () => (await window.praxis.getInfo()).connection.state)).toBe('connected')
    await expect(page.locator('.welcome-wordmark')).toBeVisible()
    await page.screenshot({ scale: 'css', path: testInfo.outputPath('empty.png') })
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(480, 400); window.setContentSize(600, 460) })
    await page.screenshot({ scale: 'css', path: testInfo.outputPath('empty-compact.png') })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(930, 802))
    await page.locator('textarea').fill('修复终端和桌面之间的会话同步，检查切换会话后消息是否正确。')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
    const id = await page.evaluate(async () => {
      const { sessions } = await window.praxis.request<{ sessions: { id: string }[] }>('session.list')
      return sessions[0].id
    })
    const emit = async (...events: { event: string; data?: Record<string, unknown> }[]) => page.evaluate(async ({ id, events }) => { await window.praxis.request('input.submit', { session_id: id, test_events: events }) }, { id, events })
    await emit(
      { event: 'AssistantTextDelta', data: { request_number: 1, text: '我先检查会话的创建和事件订阅，再修复两端同步。' } },
      { event: 'ToolCallPrepared', data: { call_id: 'inspect', tool_name: 'run_command', arguments: { command: 'python -m pytest tests/test_sessions.py', description: 'Check session synchronization' } } },
      { event: 'ToolStarted', data: { call_id: 'inspect', tool_name: 'run_command' } },
      { event: 'ToolOutputDelta', data: { call_id: 'inspect', text: 'Collecting session tests…\n' } })
    const tool = page.locator('.tool-message').first()
    await tool.locator(':scope > summary').press('Enter')
    await expect(tool.locator('.tool-log')).toBeVisible()
    await page.screenshot({ scale: 'css', path: testInfo.outputPath('running.png'), animations: 'disabled' })
    const node = await tool.elementHandle()
    await emit({ event: 'ToolFinished', data: { call_id: 'inspect', tool_name: 'run_command', result: { success: true, output: '14 passed in 2.40s' } } })
    for (const [call, path, added, removed] of [['runtime', 'session_runtime.py', 18, 6], ['hook', 'useSession.ts', 24, 8]] as const) {
      await emit(
        { event: 'ToolCallPrepared', data: { call_id: call, tool_name: 'edit_file', arguments: { relative_path: path } } },
        { event: 'ToolStarted', data: { call_id: call, tool_name: 'edit_file' } },
        { event: 'ToolFinished', data: { call_id: call, tool_name: 'edit_file', result: { success: true, output: 'Updated', file_change: { path, added, removed, diff: `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old_state\n+shared_state\n` } } } })
    }
    const answer = '## 会话同步已修复\n\n终端和桌面现在会显示相同的会话，切换后的消息也会正确归属。\n\n- 新建会话后，其他客户端会自动更新列表。\n- 切换会话时，旧订阅返回的消息不会混入当前对话。\n\n[session_runtime.py](session_runtime.py) [useSession.ts](useSession.ts)\n\n14 项测试通过';
    await emit({ event: 'ModelRequestStarted', data: { request_number: 2 } }, { event: 'AssistantTextDelta', data: { request_number: 2, text: answer } }, { event: 'AssistantTextCompleted', data: { text: answer } }, { event: 'TurnSettled', data: { status: 'idle' } })
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
    await expect(page.locator('.process-summary').first()).toHaveAttribute('aria-expanded', 'false')
    expect(await node!.evaluate(element => element.isConnected)).toBe(true)
    await expect(page.locator('.file-reference-row')).toHaveCount(2)
    await expect(page.locator('.file-reference-heading')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Copy response', exact: true })).toHaveCount(1)
    await page.screenshot({ scale: 'css', path: testInfo.outputPath('completed.png'), animations: 'disabled' })
    const metrics = await page.evaluate(() => Object.fromEntries(['.titlebar-title', '.ps-session.selected', '.turn-final .markdown > h2', '.turn-final .markdown > p', '.file-reference-name', '.composer textarea', '.process-summary', '.transcript-content', '.message-user', '.message-actions'].map(selector => {
      const node = document.querySelector(selector)!
      const style = getComputedStyle(node)
      return [selector, { fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight, color: style.color, margin: style.margin, padding: style.padding, rect: node.getBoundingClientRect().toJSON() }]
    })))
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('DOM.enable')
    await cdp.send('CSS.enable')
    const dom = await cdp.send('DOM.getDocument')
    const fonts: Record<string, unknown> = {}
    for (const selector of ['.titlebar-title', '.ps-title-static', '.turn-final .markdown > h2', '.turn-final .markdown > p', '.file-reference-name', '.composer textarea', '.process-summary']) {
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: dom.root.nodeId, selector })
      if (nodeId) fonts[selector] = await cdp.send('CSS.getPlatformFontsForNode', { nodeId })
    }
    await writeFile(testInfo.outputPath('rendered-fonts.json'), JSON.stringify({ metrics, fonts }, null, 2))
    await page.locator('.session-item').click({ button: 'right' })
    await expect(page.getByRole('menu')).toBeVisible()
    await page.screenshot({ scale: 'css', path: testInfo.outputPath('context-menu.png'), animations: 'disabled' })
    await page.getByRole('menuitem', { name: 'Pin chat', exact: true }).click()
    await expect(page.locator('.ps-section-label').filter({ hasText: 'Pinned' })).toBeVisible()
    await page.locator('.file-reference-row').last().click()
    await expect(page.locator('.diff-file')).toHaveCount(2)
    await page.screenshot({ scale: 'css', path: testInfo.outputPath('changes.png'), animations: 'disabled' })
    await page.getByRole('button', { name: 'Close preview' }).click()
    await page.locator('textarea').focus()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(800, 802))
    await page.screenshot({ scale: 'css', path: testInfo.outputPath('medium.png'), animations: 'disabled' })
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(480, 400); window.setContentSize(600, 680) })
    await expect(page.locator('.sidebar')).not.toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ scale: 'css', path: testInfo.outputPath('compact.png'), animations: 'disabled' })
    const compact = await page.evaluate(() => Object.fromEntries(['.titlebar', '.titlebar-leading', '.message-user', '.process-summary', '.turn-final .markdown > p', '.composer'].map(selector => {
      const node = document.querySelector(selector)!
      const style = getComputedStyle(node)
      return [selector, { margin: style.margin, padding: style.padding, rect: node.getBoundingClientRect().toJSON() }]
    })))
    await writeFile(testInfo.outputPath('compact-layout.json'), JSON.stringify(compact, null, 2))
    expect(errors).toEqual([])
  } finally {
    await stopFixtureService(join(profile, 'service'))
    await app.close()
    if (resolve(profile).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/')) && /^praxis-prototype-e2e-/.test(profile.split(/[\\/]/).at(-1)!)) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
