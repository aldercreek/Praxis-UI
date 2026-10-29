import { stopFixtureService } from './service-fixture'
import { test, expect, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let application: ElectronApplication
let page: Page
let profile: string
const errors: string[] = []

test.beforeEach(async ({}, testInfo) => {
  profile = await mkdtemp(join(tmpdir(), 'praxis-ui-e2e-'))
  errors.length = 0
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    PRAXIS_DATA_DIR: join(profile, 'service'), PRAXIS_UI_DATA_DIR: profile, PRAXIS_UI_TEST_MODE: '1', PRAXIS_UI_TEST_SERVER: resolve('tests/fixtures/ui-server.cjs')
  }
  if (testInfo.tags.includes('@startup')) env.PRAXIS_UI_TEST_PAUSE_STARTUP = '1'
  delete env.ELECTRON_RUN_AS_NODE
  application = await electron.launch({ args: [resolve('.')], env })
  const visibility = await application.evaluate(({ app, BrowserWindow }) => {
    const state = globalThis as typeof globalThis & { e2eWindowShows: number }
    const windows = BrowserWindow.getAllWindows()
    state.e2eWindowShows = windows.filter(window => window.isVisible()).length
    for (const window of windows) window.on('show', () => { state.e2eWindowShows += 1 })
    app.on('browser-window-created', (_event, window) => {
      window.on('show', () => { state.e2eWindowShows += 1 })
    })
    return { visible: windows.some(window => window.isVisible()), showCount: state.e2eWindowShows }
  })
  expect(visibility).toEqual({ visible: false, showCount: 0 })
  page = await application.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  if (!testInfo.tags.includes('@startup')) {
    await expect.poll(() => page.evaluate(async () => (await window.praxis.getInfo()).connection.state)).toBe('connected')
  }
})

test.afterEach(async () => {
  let visibility: { visible: boolean; showCount: number } | undefined
  try {
    visibility = await application.evaluate(({ BrowserWindow }) => ({
      visible: BrowserWindow.getAllWindows().some(window => window.isVisible()),
      showCount: (globalThis as typeof globalThis & { e2eWindowShows: number }).e2eWindowShows
    }))
  } finally {
    await stopFixtureService(join(profile, 'service'))
    await application?.close()
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
  expect(visibility).toEqual({ visible: false, showCount: 0 })
  expect(errors).toEqual([])
})

async function startupService() {
  const directory = join(profile, 'service')
  await expect.poll(async () => {
    try { await readFile(join(directory, 'service.json')); return true } catch { return false }
  }).toBe(true)
  const record = JSON.parse(await readFile(join(directory, 'service.json'), 'utf8'))
  const token = (await readFile(join(directory, 'service.token'), 'utf8')).trim()
  const request = async (path: string, data?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${record.port}${path}`, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(5000)
    })
    expect(response.ok).toBe(true)
    return response.json()
  }
  return { request, connect: () => writeFile(join(directory, 'startup.release'), '') }
}

test('startup shows loading until chats arrive and keeps them during background refresh', { tag: '@startup' }, async () => {
  const loading = page.getByRole('status', { name: 'Loading chats' })
  await expect(page.locator('.sidebar-section-label')).toHaveText('Recent chats')
  await expect(loading).toBeVisible()
  await expect(page.locator('.session-list')).toHaveAttribute('aria-busy', 'true')
  await expect(page.locator('.sidebar-empty')).toHaveCount(0)
  const service = await startupService()
  await service.request('/api/sessions', { workspace: profile })
  await service.connect()
  await expect.poll(() => page.evaluate(async () => (await window.praxis.getInfo()).connection.state)).toBe('connected')
  await expect.poll(async () => (await service.request('/__sessions-test')).pending).toBe(1)
  await expect(loading).toBeVisible()
  await expect(page.locator('.sidebar-empty')).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath('startup-loading.png'), animations: 'disabled' })

  await service.request('/__sessions-test?scenario=normal')
  await expect(page.locator('.session-item')).toHaveCount(1)
  await expect(loading).toHaveCount(0)
  await expect(page.locator('.session-list')).toHaveAttribute('aria-busy', 'false')
  await page.screenshot({ path: test.info().outputPath('startup-loaded.png'), animations: 'disabled' })
  await service.request('/__sessions-test?scenario=hold')
  await expect.poll(async () => (await service.request('/__sessions-test')).pending).toBe(1)
  await expect(page.locator('.session-item')).toHaveCount(1)
  await expect(loading).toHaveCount(0)
  await service.request('/__sessions-test?scenario=error')
  await page.getByLabel('Search chats').fill('no matching conversation')
  await expect(page.getByText('No matching chats', { exact: true })).toBeVisible()
  await expect(loading).toHaveCount(0)
  await page.getByRole('button', { name: 'Clear search' }).click()
  await expect(page.locator('.session-item')).toHaveCount(1)
})

test('startup failure offers retry and only shows empty chats after a successful response', { tag: '@startup' }, async () => {
  await expect(page.getByRole('status', { name: 'Loading chats' })).toBeVisible()
  const service = await startupService()
  await service.request('/__sessions-test?scenario=error')
  await service.connect()
  await expect(page.locator('.sidebar-empty')).toContainText('Unable to load chats.')
  await expect(page.locator('.composer-error')).toHaveCount(0)
  await expect(page.getByText('No chats yet', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('status', { name: 'Loading chats' })).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath('startup-error.png'), animations: 'disabled' })
  await service.request('/__sessions-test?scenario=hold')
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(page.getByRole('status', { name: 'Loading chats' })).toBeVisible()
  await expect(page.getByText('No chats yet', { exact: true })).toHaveCount(0)
  await service.request('/__sessions-test?scenario=normal')
  await expect(page.getByText('No chats yet', { exact: true })).toBeVisible()
  await expect(page.getByRole('status', { name: 'Loading chats' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0)
})

test('/mcp shows only service names and states without creating a chat or model input', async () => {
  const before = await page.evaluate(() => window.praxis.request('session.list'))
  await send('/mcp')
  const dialog = page.getByRole('dialog', { name: 'MCP servers' })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('li')).toHaveText(['数据库Connected', '浏览器Connecting', '代码搜索Retrying', '文档服务Disabled'])
  await expect(dialog).not.toContainText(/\btools?\b|1\s*\/\s*3/i)
  await dialog.getByRole('button', { name: 'Refresh' }).click()
  await expect(dialog.getByRole('button', { name: 'Refresh' })).toBeEnabled()
  expect(await page.evaluate(() => window.praxis.request('session.list'))).toEqual(before)
  await page.screenshot({ path: test.info().outputPath('mcp-status.png'), animations: 'disabled' })
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await expect(page.locator('textarea')).toBeFocused()

  const id = await startControlledTurn('MCP 状态查询')
  const snapshot = await page.evaluate(id => window.praxis.request('session.open', { session_id: id }), id)
  await send('/MCP')
  await expect(dialog).toBeVisible()
  expect(await page.evaluate(id => window.praxis.request('session.open', { session_id: id }), id)).toEqual(snapshot)
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
})

test('/mcp handles an empty configuration, request failure, refresh and a missing model key', async () => {
  const directory = join(profile, 'service')
  const record = JSON.parse(await readFile(join(directory, 'service.json'), 'utf8'))
  const token = (await readFile(join(directory, 'service.token'), 'utf8')).trim()
  const scenario = (mode: string) => fetch(`http://127.0.0.1:${record.port}/__mcp-test?scenario=${mode}`, { headers: { Authorization: `Bearer ${token}` } })
  expect((await scenario('no-model-error')).ok).toBe(true)
  await page.reload()
  await expect(page.getByText('No model API key configured.', { exact: false })).toBeVisible()
  await send('/mcp')
  const dialog = page.getByRole('dialog', { name: 'MCP servers' })
  await expect(dialog.getByRole('alert')).toContainText('MCP status unavailable')
  expect((await scenario('no-model-empty')).ok).toBe(true)
  await dialog.getByRole('button', { name: 'Refresh' }).click()
  await expect(dialog).toContainText('No MCP servers configured')
  await expect(dialog.getByRole('alert')).toHaveCount(0)
  await expect(page.locator('.user-content')).toHaveCount(0)
})

async function send(text: string): Promise<void> {
  const input = page.locator('textarea')
  await input.fill(text)
  await input.press('Enter')
}

test('chat deletion supports keyboard confirmation, cancellation, failure recovery and retry', async () => {
  await send('A chat to delete')
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  const action = page.locator('.session-item').filter({ hasText: 'A chat to delete' })
  await action.focus()
  await action.press('Shift+F10')
  const remove = page.getByRole('menuitem', { name: /^Delete chat$/ })
  await expect(page.getByRole('menuitem', { name: /^Pin chat$/ })).toBeFocused()
  await page.keyboard.press('End')
  await expect(remove).toBeFocused()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Delete chat?' })
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  await expect(dialog).toContainText('Files in your workspace will stay.')
  await page.screenshot({ scale: 'css', path: test.info().outputPath('delete-chat-confirmation.png'), animations: 'disabled' })
  await dialog.getByRole('button', { name: 'Delete chat', exact: true }).hover()
  await page.screenshot({ scale: 'css', path: test.info().outputPath('delete-chat-hover.png'), animations: 'disabled' })
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await expect(page.locator('.session-item')).toHaveCount(1)

  const service = await startupService()
  await service.request('/__deletion-test?deletion=fail')
  await send('/delete')
  await dialog.getByRole('button', { name: 'Delete chat', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Couldn’t finish deleting the chat.')
  await expect(page.locator('.session-item')).toHaveCount(1)
  await service.request('/__deletion-test?deletion=normal')
  await page.getByRole('button', { name: 'Retry deletion' }).click()
  await expect(page.locator('.session-item')).toHaveCount(0)
  await expect(page.locator('.user-content')).toHaveCount(0)
  await page.reload()
  await expect(page.locator('.sidebar-empty')).toContainText('No chats yet')
  await send('A new chat after deletion')
  await expect(page.locator('.session-item')).toHaveCount(1)
})

test('a deleted chat is not restored by a delayed snapshot', async () => {
  await send('Late snapshot chat')
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.locator('.session-item')).toHaveCount(1)
  const service = await startupService()
  await service.request('/__deletion-test?snapshot=hold')
  await page.locator('.session-item').click()
  await expect.poll(async () => (await service.request('/__deletion-test')).pendingSnapshots).toBe(1)
  await page.locator('.session-item').filter({ hasText: 'Late snapshot chat' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: /^Delete chat$/ }).click()
  await page.getByRole('dialog', { name: 'Delete chat?' }).getByRole('button', { name: 'Delete chat', exact: true }).click()
  await expect(page.locator('.session-item')).toHaveCount(0)
  await service.request('/__deletion-test?snapshot=normal')
  await expect(page.locator('.sidebar-empty')).toContainText('No chats yet')
  await expect(page.locator('.user-content')).toHaveCount(0)
  await expect(page.locator('.composer-error')).toHaveCount(0)
})

type TestEvent = { event: string; data?: Record<string, unknown>; agent_id?: string }

async function startControlledTurn(name: string): Promise<string> {
  const title = `可控执行：${name}`
  await send(title)
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
  return page.evaluate(async title => {
    const { settings } = await window.praxis.getInfo()
    const { sessions } = await window.praxis.request<{ sessions: { id: string; title: string }[] }>('session.list', { workspace: settings.workspace })
    const session = sessions.find(item => item.title === title)
    if (!session) throw new Error(`Missing controlled session: ${title}`)
    return session.id
  }, title)
}

async function emitEvents(sessionId: string, ...events: TestEvent[]): Promise<void> {
  await page.evaluate(async ({ sessionId, events }) => {
    await window.praxis.request('input.submit', { session_id: sessionId, test_events: events })
  }, { sessionId, events })
}

test('assistant metadata stays hidden while collaboration reports remain inside their agent', async () => {
  const sessionId = await startControlledTurn('message presentation')
  await emitEvents(sessionId, { event: 'AssistantTextDelta', data: { request_number: 1, text: '[message_id=m' } })
  await expect(page.locator('.message-assistant')).toHaveCount(0)
  const result = '处理完成。\n\n```text\n[message_id=m99]\n```'
  await emitEvents(sessionId,
    { event: 'AssistantTextDelta', data: { request_number: 1, text: '21] ' + result } },
    { event: 'ModelRequestCompleted', data: { request_number: 1, output_text: '[message_id=m21] ' + result } }
  )
  await expect(page.locator('.message-assistant')).toContainText('处理完成。')
  await expect(page.locator('.message-assistant')).not.toContainText('[message_id=m21]')
  await expect(page.locator('.message-assistant code')).toHaveText('[message_id=m99]\n')
  const content = '协作检查完成。'
  const envelope = '[Agent collaboration messages; source-labelled task data]\n' + JSON.stringify([{ sender_id: 'reviewer', recipient_id: 'parent', content }])
  await emitEvents(sessionId,
    { event: 'ChildAgentStatus', agent_id: 'reviewer', data: { task_summary: 'Review', status: 'idle' } },
    { event: 'ChildAgentMessage', agent_id: 'reviewer', data: { content } },
    { event: 'MessagesReceived', data: { source: 'agent', items: [{ role: 'user', content: envelope }] } }
  )
  await expect(page.locator('.message-user')).toHaveCount(1)
  await expect(page.locator('.transcript')).not.toContainText('source-labelled task data')
  const child = page.locator('.child-task[data-agent-id=reviewer]')
  await child.locator(':scope > summary').click()
  await expect(child.locator('.message-assistant')).toHaveText('Subtask · reviewer' + content)
  await emitEvents(sessionId, { event: 'MessagesReceived', data: { source: 'user', items: [{ role: 'user', content: '[message_id=m21] 请解释这个字段' }] } })
  await expect(page.locator('.user-content').last()).toHaveText('[message_id=m21] 请解释这个字段')
})

function startedTool(callId: string, path: string): TestEvent[] {
  return [
    { event: 'ToolCallPrepared', data: { call_id: callId, tool_name: 'read_file', arguments: { relative_path: path } } },
    { event: 'ToolStarted', data: { call_id: callId, tool_name: 'read_file' } }
  ]
}

function finishedTool(callId: string, output = 'File contents'): TestEvent {
  return { event: 'ToolFinished', data: { call_id: callId, tool_name: 'read_file', result: { success: true, output } } }
}

function toolMessage(callId: string): Locator {
  return page.locator(`.tool-message[data-message-id$=":${callId}"]`)
}

async function openGroupFor(tool: Locator): Promise<void> {
  const entry = tool.locator('xpath=ancestor::*[@data-process-controller][1]')
  if (await entry.count() && await entry.getAttribute('hidden') !== null) {
    const controller = await entry.getAttribute('data-process-controller')
    await page.locator(`[id="${controller}"]`).click()
  }
  await expect(tool.locator(':scope > summary')).toBeVisible()
}

test('conversation navigation previews, jumps, scrolls independently and persists colored bookmarks', async () => {
  const sessionId = await startControlledTurn('对话导航验收')
  const history = Array.from({ length: 100 }, (_, index) => [
    { id: `saved-user-${index}`, role: 'user', turn_id: `saved-turn-${index}`, content: `第 ${index + 1} 个问题：检查桌面会话的展示细节` },
    { id: `saved-answer-${index}`, role: 'assistant', turn_id: `saved-turn-${index}`, content: `第 ${index + 1} 个回答：已检查工具聚合、字体与间距。这里保留这段对话的结果摘要，方便快速找到之前的讨论。`, status: 'completed' }
  ]).flat()
  await page.evaluate(({ sessionId, history }) => window.praxis.request('input.submit', { session_id: sessionId, test_history: history }), { sessionId, history })
  await page.reload()
  await page.locator('.session-item').filter({ hasText: '对话导航验收' }).click()
  const rail = page.getByRole('navigation', { name: 'Conversation navigation' })
  const ticks = rail.locator('.conversation-tick')
  const list = rail.locator('.conversation-rail-list')
  const transcript = page.locator('.transcript')
  await expect(ticks).toHaveCount(100)
  await expect(ticks.last()).toHaveAttribute('aria-current', 'location')
  expect((await rail.boundingBox())!.height).toBeLessThanOrEqual(320)
  expect(await list.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
  const readingPosition = await transcript.evaluate(element => element.scrollTop)
  await list.hover()
  await page.mouse.wheel(0, -2000)
  await expect.poll(() => list.evaluate(element => element.scrollTop)).toBe(0)
  expect(await transcript.evaluate(element => element.scrollTop)).toBe(readingPosition)

  await ticks.first().hover()
  const preview = page.getByRole('dialog', { name: 'Conversation preview' })
  await expect(preview).toContainText('第 1 个问题')
  await expect(preview).toContainText('第 1 个回答')
  const beforeColor = await ticks.first().locator('span').evaluate(element => getComputedStyle(element).backgroundColor)
  await preview.getByRole('button', { name: 'Bookmark conversation', exact: true }).click()
  await expect(preview.getByRole('button', { name: 'Remove bookmark', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(ticks.first()).toHaveAttribute('data-bookmarked', 'true')
  expect(await ticks.first().locator('span').evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(beforeColor)
  expect(await ticks.first().evaluate(element => getComputedStyle(element, '::after').content)).toBe('none')
  expect(await transcript.evaluate(element => element.scrollTop)).toBe(readingPosition)
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath('conversation-navigation/bookmarked-preview.png') })

  await page.keyboard.press('Escape')
  await expect(preview).not.toBeVisible()
  await ticks.first().click()
  await expect.poll(() => transcript.evaluate(element => element.scrollTop)).toBeLessThan(30)
  await expect(ticks.first()).toHaveAttribute('aria-current', 'location')
  await ticks.first().focus()
  await page.keyboard.press('End')
  await expect(ticks.last()).toBeFocused()
  await expect(preview).toContainText('第 100 个问题')
  await page.keyboard.press('Tab')
  await expect(preview.getByRole('button', { name: 'Bookmark conversation', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(ticks.last()).toHaveAttribute('data-bookmarked', 'true')
  await page.keyboard.press('Escape')
  await expect(ticks.last()).toBeFocused()
  await page.keyboard.press('Enter')
  await expect.poll(() => transcript.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(2)

  await page.getByRole('button', { name: 'New chat' }).first().click()
  await expect(rail).toHaveCount(0)
  await send('第二个会话：导航标记隔离')
  await expect(page.getByText('已完成这条独立会话中的任务。')).toBeVisible()
  await expect(ticks).toHaveCount(1)
  await expect(ticks.first()).toHaveAttribute('data-bookmarked', 'false')
  await page.reload()
  await page.locator('.session-item').filter({ hasText: '对话导航验收' }).click()
  await expect(ticks).toHaveCount(100)
  await expect(ticks.first()).toHaveAttribute('data-bookmarked', 'true')
  await expect(ticks.last()).toHaveAttribute('data-bookmarked', 'true')
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 640))
  await ticks.last().hover()
  await expect(preview).toBeVisible()
  const bounds = (await preview.boundingBox())!
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.y).toBeGreaterThanOrEqual(0)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(await page.evaluate(() => innerHeight))
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  await preview.getByRole('button', { name: 'Remove bookmark', exact: true }).click()
  await expect(ticks.last()).toHaveAttribute('data-bookmarked', 'false')
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath('conversation-navigation/compact.png') })
})

test('concurrent conversations keep streams isolated; supplementary input and stop stay responsive', async () => {
  await expect(page.locator('.empty-state').getByRole('img', { name: 'Praxis', exact: true })).toBeVisible()
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath('desktop-empty.png') })
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
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath('desktop-conversation.png') })
})

test('approval accept and reject are real protocol operations; settings remain keyboard accessible', async () => {
  await page.getByRole('button', { name: /^Settings/ }).click()
  await page.getByRole('checkbox', { name: 'Bypass approvals', exact: true }).uncheck()
  await page.getByRole('button', { name: 'Save settings', exact: true }).click()
  await expect(page.getByRole('dialog')).not.toBeVisible()
  expect(await page.evaluate(async () => (await window.praxis.request('initialize')).bypass_approvals)).toBe(false)
  await send('审批：运行命令')
  const approval = page.getByRole('region', { name: 'Tool approval' })
  await expect(approval).toBeVisible()
  await expect(page.locator('.tool-message')).toHaveCount(0)
  await expect(page.locator('.inline-permission, .task-tool-permission')).toHaveCount(0)
  await expect(approval.locator('.praxis-approval-detail-preview')).toHaveText('echo praxis')
  await expect(approval.locator('.praxis-approval-detail-trigger')).toBeDisabled()
  await expect(approval.locator('.praxis-approval-option')).toHaveText(['1Reject', '2Allow'])
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath('desktop-approval.png') })
  await approval.getByRole('button', { name: 'Allow', exact: true }).click()
  await expect(page.getByText('操作已获得确认并执行完成。')).toBeVisible()
  await page.getByRole('button', { name: 'New chat' }).first().click()
  await send('审批：另一个命令')
  await approval.getByRole('button', { name: 'Reject', exact: true }).click()
  await expect(page.getByText('已按你的要求拒绝执行。')).toBeVisible()
  await expect(page.locator('.tool-message .tool-summary')).toHaveText('Rejected: Run echo praxis')
  await openGroupFor(page.locator('.tool-message'))
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
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath('desktop-compact.png') })
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
  expect(overflow).toBe(false)
})

test('desktop defaults to bypass and cannot change approval mode during a running turn', async () => {
  await expect(page.locator('.approval-mode')).toHaveText('Bypass')
  expect(await page.evaluate(async () => (await window.praxis.request('initialize')).bypass_approvals)).toBe(true)
  await send('审批：默认直接运行')
  await expect(page.getByText('Bypass 模式下已直接执行完成。')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Tool approval' })).toHaveCount(0)
  await expect(page.locator('.tool-message > summary')).toHaveAttribute('aria-label', 'Ran echo praxis')
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  await send('长任务：检查设置保护')
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
  await expect(page.locator('.permission-button')).toBeDisabled()
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

test('a pending approval can stop the entire turn without approving or executing its tool', async () => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('checkbox', { name: 'Bypass approvals', exact: true }).uncheck()
  await page.getByRole('button', { name: 'Save settings', exact: true }).click()
  await expect(page.getByRole('dialog')).not.toBeVisible()
  await send('审批：停止等待确认的任务')
  const approval = page.getByRole('region', { name: 'Tool approval' })
  await expect(approval).toBeVisible()
  await expect(page.locator('.tool-message')).toHaveCount(0)
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(approval).toHaveCount(0)
  await expect(page.locator('.turn-notice')).toHaveText('Stopped')
  await expect(page.locator('.tool-message')).toHaveAttribute('data-status', 'cancelled')
  await expect(page.getByText('操作已获得确认并执行完成。', { exact: true })).toHaveCount(0)
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
  const sessionId = await startControlledTurn('流式自动跟随')
  const transcript = page.locator('.transcript')
  const bottomDistance = () => transcript.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)
  const paragraphs = (start: number, count: number) => Array.from({ length: count }, (_, index) => `第 ${start + index} 段：持续检查桌面会话中的消息滚动，保留用户正在阅读的位置。`).join('\n\n')
  await emitEvents(sessionId, { event: 'AssistantTextDelta', data: { request_number: 1, text: paragraphs(1, 20) } })
  await expect(page.locator('.markdown p')).toHaveCount(20)
  await expect.poll(() => transcript.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(160)
  await expect.poll(bottomDistance).toBeLessThan(2)

  await transcript.hover()
  await page.mouse.wheel(0, -10_000)
  await expect.poll(() => transcript.evaluate(element => element.scrollTop)).toBe(0)
  await expect(page.getByRole('button', { name: 'Scroll to latest message' })).toBeVisible()
  await emitEvents(sessionId, { event: 'AssistantTextDelta', data: { request_number: 1, text: `\n\n${paragraphs(21, 6)}` } })
  await expect(page.locator('.markdown p')).toHaveCount(26)
  expect(await transcript.evaluate(element => element.scrollTop)).toBe(0)

  await page.getByRole('button', { name: 'Scroll to latest message' }).click()
  await emitEvents(sessionId, { event: 'AssistantTextDelta', data: { request_number: 1, text: `\n\n${paragraphs(27, 6)}` } })
  await expect(page.locator('.markdown p')).toHaveCount(32)
  await expect.poll(bottomDistance).toBeLessThan(2)
  await expect(page.getByRole('button', { name: 'Scroll to latest message' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(page.locator('.turn-notice')).toHaveText('Stopped')
})

test('tool activity stays compact while details, errors and live output remain accessible', async () => {
  test.setTimeout(90_000)
  await send('工具展示：分析 Praxis 项目')
  await expect(page.locator('.tool-group')).toHaveCount(3)
  await expect(page.locator('.tool-group > summary, .tool-attention')).toHaveCount(0)
  await expect(toolMessage('live').locator(':scope > summary')).toHaveAttribute('aria-label', /Running python -m pytest/)
  await expect(page.locator('.message-assistant .message-label')).toHaveCount(0)
  await expect(page.locator('.message-user .message-label')).toHaveCount(0)
  await expect(toolMessage('live').locator(':scope > summary')).toBeVisible()
  await expect(toolMessage('failed').locator(':scope > summary')).toBeVisible()
  const bubble = await page.locator('.message-user').boundingBox()
  expect(bubble!.height).toBeLessThan(48)
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath('tool-activity.png') })
  await page.locator('.transcript-content').screenshot({ animations: 'disabled', path: test.info().outputPath('tool-summaries.png') })

  const shell = toolMessage('command')
  await openGroupFor(shell)
  await shell.locator(':scope > summary').press('Enter')
  const output = shell.getByRole('region', { name: 'Shell output' })
  await expect(output).toBeVisible()
  expect(await output.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
  await shell.locator(':scope > summary').focus()
  await page.keyboard.press('Tab')
  await expect(output).toBeFocused()
  await output.hover()
  await page.mouse.wheel(0, 1000)
  await expect.poll(() => output.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  await page.mouse.wheel(0, -1000)
  await expect.poll(() => output.evaluate(element => element.scrollTop)).toBe(0)
  await page.locator('textarea').focus()
  await shell.screenshot({ animations: 'disabled', path: test.info().outputPath('tool-shell-refined.png') })
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath('tool-shell-context.png') })
  await shell.locator(':scope > summary').press('Enter')

  await expect(page.locator('.tool-group-items').first()).toBeVisible()
  await expect(page.locator('.tool-message > summary[aria-label="Read src/praxis_agent/agent.py:1–80"]')).toBeVisible()
  const edits = page.locator('.tool-group').filter({ has: toolMessage('edit-app') })
  await openGroupFor(toolMessage('edit-app'))
  await edits.locator('.tool-message > summary').first().press('Enter')
  await expect(edits.locator('.file-diff')).toBeVisible()
  await expect(edits.locator('.file-diff')).toContainText('+<span>已读取 README.md</span>')
  await expect(edits.getByText('Updated tool summaries.', { exact: true })).not.toBeVisible()
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath('tool-group-expanded.png') })
  await expect(edits.locator('.tool-arguments')).toHaveCount(0)
  await edits.locator('.tool-message > summary').first().press('Enter')
  const failed = toolMessage('failed')
  await failed.locator(':scope > summary').press('Enter')
  await expect(failed.locator('.tool-details')).toContainText('Cannot find path')
  await expect(failed.locator('.command-line')).toContainText('tests\\missing')
  await failed.locator('.tool-details').screenshot({ animations: 'disabled', path: test.info().outputPath('tool-details-fonts.png') })
  const live = toolMessage('live')
  await live.locator(':scope > summary').press('Enter')
  await expect(live.locator('.terminal-output')).toContainText('Checking desktop protocol')
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath('tool-activity-expanded.png') })
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(live.locator(':scope > summary')).toContainText('Stopped: Run')
  await expect(page.locator('.tool-message .spin')).toHaveCount(0)
  await expect(page.locator('.turn-notice')).toHaveText('Stopped')

  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 640))
  await openGroupFor(failed)
  await failed.locator(':scope > summary').press('Enter')
  await live.locator(':scope > summary').press('Enter')
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth || document.querySelector('.transcript')!.scrollWidth > document.querySelector('.transcript')!.clientWidth)
  expect(overflow).toBe(false)
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath('execution-polish/tools-compact.png') })

  await openGroupFor(shell)
  await shell.locator(':scope > summary').press('Enter')
  await page.locator('.transcript').evaluate(element => { element.scrollTop = 0 })
  await expect(page.getByRole('button', { name: 'Scroll to latest message' })).toBeVisible()
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath('tool-scroll-affordance.png') })
  await page.getByRole('button', { name: 'Scroll to latest message' }).click()
  await expect.poll(() => page.locator('.transcript').evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(2)
  await expect(page.getByRole('button', { name: 'Scroll to latest message' })).toHaveCount(0)
})

// Hidden Electron receives these unprevented keydown events while the output has DOM focus,
// but does not perform native scrolling, even with CDP focus emulation. Keep the original
// keyboard assertion separate so the remaining tool interactions can run without a visible window.
test.fixme('native End/Home output scrolling (unverified in hidden Electron)', async () => {
  await send('工具展示：验证输出键盘滚动')
  const shell = toolMessage('command')
  await openGroupFor(shell)
  await shell.locator(':scope > summary').press('Enter')
  const output = shell.getByRole('region', { name: 'Shell output' })
  await expect(output).toBeVisible()
  expect(await output.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
  await shell.locator(':scope > summary').focus()
  await page.keyboard.press('Tab')
  await expect(output).toBeFocused()
  await output.press('End')
  await expect.poll(() => output.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  await output.press('Home')
  await expect.poll(() => output.evaluate(element => element.scrollTop)).toBe(0)
})

test('tool details keep their DOM and expanded state when the third tool finishes out of order', async () => {
  const sessionId = await startControlledTurn('稳定工具分组')
  await emitEvents(sessionId, ...startedTool('first', 'first.ts'))
  const group = page.locator('.tool-group')
  const first = toolMessage('first')
  await expect(group).toHaveCount(1)
  await expect(first.locator(':scope > summary')).toContainText('Reading first.ts')
  await openGroupFor(first)
  await first.locator(':scope > summary').press('Enter')
  const groupNode = await group.elementHandle()
  const firstNode = await first.elementHandle()
  expect(await group.getAttribute('data-group-id')).toBeTruthy()
  expect(await first.getAttribute('data-message-id')).toBeTruthy()

  await emitEvents(sessionId, finishedTool('first'), ...startedTool('second', 'second.ts'), ...startedTool('third', 'third.ts'))
  await expect(group.locator('.tool-message')).toHaveCount(3)
  const third = toolMessage('third')
  await third.locator(':scope > summary').press('Enter')
  const thirdNode = await third.elementHandle()

  // The third call completes before the second; neither existing disclosure moves.
  await emitEvents(sessionId, finishedTool('third'))
  await expect(third.locator(':scope > summary')).toHaveAttribute('aria-label', 'Read third.ts')
  await expect(toolMessage('second').locator(':scope > summary')).toContainText('Reading second.ts')
  expect(await firstNode!.evaluate(element => element.isConnected)).toBe(true)
  expect(await thirdNode!.evaluate(element => element.isConnected)).toBe(true)
  await expect(first).toHaveJSProperty('open', true)
  await expect(third).toHaveJSProperty('open', true)

  // This is the third completed call, which previously replaced the rows with a new group.
  await emitEvents(sessionId, finishedTool('second'))
  await expect(toolMessage('second').locator(':scope > summary')).toHaveAttribute('aria-label', 'Read second.ts')
  await expect(page.locator('.tool-group')).toHaveCount(1)
  expect(await groupNode!.evaluate(element => element.isConnected)).toBe(true)
  expect(await firstNode!.evaluate(element => element.isConnected)).toBe(true)
  expect(await thirdNode!.evaluate(element => element.isConnected)).toBe(true)
  await expect(group.locator(':scope > summary')).toHaveCount(0)
  await expect(first).toHaveJSProperty('open', true)
  await expect(third).toHaveJSProperty('open', true)
})

test('mixed tools fold by stage and the confirmed final keeps reading anchors while folding process details', async () => {
  const sessionId = await startControlledTurn('连续操作与最终回答')
  const introduction = '我先读取现有实现，再调整执行过程的展示。这里保留完整的分析说明，让用户在任务完成后仍能直接阅读关键结论。'
  const continuation = '修改已完成，接下来检查构建与交互。'
  await emitEvents(sessionId,
    { event: 'ModelRequestCompleted', data: { request_number: 1, output_text: introduction } },
    ...startedTool('inspect', 'src/App.tsx')
  )
  const firstTool = toolMessage('inspect')
  await expect(page.locator('.tool-group > summary')).not.toBeVisible()
  await expect(firstTool.locator(':scope > summary')).toBeVisible()
  await firstTool.locator(':scope > summary').press('Enter')
  await expect(firstTool).toHaveJSProperty('open', true)
  const firstNode = await firstTool.elementHandle()
  await emitEvents(sessionId, finishedTool('inspect'),
    { event: 'ToolCallPrepared', data: { call_id: 'edit', tool_name: 'edit_file', arguments: { relative_path: 'src/App.tsx' } } },
    { event: 'ToolFinished', data: { call_id: 'edit', tool_name: 'edit_file', result: { success: true, output: 'Updated.', file_change: { path: 'src/App.tsx', diff: '-old\n+new', added: 1, removed: 1 } } } },
    { event: 'ToolCallPrepared', data: { call_id: 'build', tool_name: 'run_command', arguments: { command: 'npm run build' } } },
    { event: 'ToolStarted', data: { call_id: 'build', tool_name: 'run_command' } },
    { event: 'ToolOutputDelta', data: { call_id: 'build', tool_name: 'run_command', text: 'Building desktop renderer…\n' } }
  )
  const groups = page.locator('.tool-group')
  const process = page.locator('.process-completed')
  const middle = page.locator('.process-middle')
  await expect(groups).toHaveCount(1)
  await expect(groups.first().locator('.tool-message')).toHaveCount(3)
  await expect(groups.first().locator(':scope > summary')).toHaveCount(0)
  await expect(toolMessage('build').locator(':scope > summary')).toBeVisible()
  expect(await firstNode!.evaluate(element => element.isConnected)).toBe(true)
  await expect(process).toHaveCount(0)
  await expect(page.locator('.turn-time')).toBeVisible()
  await expect(page.getByText(/\d+\/\d+ steps completed/)).toHaveCount(0)

  await emitEvents(sessionId,
    { event: 'ToolFinished', data: { call_id: 'build', tool_name: 'run_command', result: { success: true, output: 'Build completed.' } } },
    { event: 'AssistantTextDelta', data: { request_number: 2, text: continuation } }
  )
  await expect(groups.first().locator(':scope > summary')).toHaveCount(0)
  await expect(firstTool).toHaveJSProperty('open', true)
  await expect(page.getByText(introduction, { exact: true })).toBeVisible()
  await expect(page.getByText(continuation, { exact: true })).toBeVisible()
  await page.evaluate(sessionId => window.praxis.request('input.submit', { session_id: sessionId, test_defer_inputs: true }), sessionId)
  await send('请保留底部的任务状态。')
  const supplement = page.locator('.message-user').filter({ hasText: '请保留底部的任务状态。' })
  await expect(supplement).toHaveCount(0)
  await expect(page.locator('.queue-preview')).toHaveText('请保留底部的任务状态。')
  await emitEvents(sessionId, { event: 'MessagesReceived', data: { source: 'user', items: [{ role: 'user', content: '请保留底部的任务状态。' }] } })
  await expect(page.locator('.message-queue')).toHaveCount(0)
  await expect(supplement).toHaveCount(1)
  const supplementNode = await supplement.elementHandle()
  for (let index = 0; index < 12; index += 1) {
    await emitEvents(sessionId, ...startedTool('verify-' + index, 'src/components/view-' + index + '.tsx'), finishedTool('verify-' + index))
  }
  await emitEvents(sessionId, ...startedTool('last-check', 'src/components/Transcript.tsx'))
  await expect(groups).toHaveCount(2)
  expect(await supplement.evaluate(element => {
    const group = document.querySelectorAll('.tool-group')[1]
    return Boolean(element.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING)
  })).toBe(true)
  expect(await supplementNode!.evaluate(element => element.isConnected)).toBe(true)
  await expect(supplement.locator('.queued-label')).toHaveCount(0)
  const list = groups.last().locator('.tool-group-items')
  expect(await list.evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true)
  await expect(list.locator('.tool-message')).toHaveCount(13)
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath('process-flow/running.png') })
  await emitEvents(sessionId, finishedTool('last-check'),
    { event: 'AssistantTextCompleted', agent_id: 'reviewer', data: { text: '子任务检查完成。' } },
    { event: 'AssistantTextDelta', data: { request_number: 3, text: '已完成执行过程展示调整，构建和交互检查通过。' } }
  )
  await expect(process).toHaveCount(0)
  await expect(page.locator('.turn-final')).toHaveCount(0)
  await emitEvents(sessionId, { event: 'ModelRequestCompleted', data: { request_number: 3, output_text: '已完成执行过程展示调整，构建和交互检查通过。' } })
  await expect(process).toHaveCount(0)
  await emitEvents(sessionId, { event: 'AssistantTextCompleted', data: { text: '已完成执行过程展示调整，构建和交互检查通过。' } })
  await expect(page.locator('.turn-final')).toHaveText('已完成执行过程展示调整，构建和交互检查通过。')
  await expect(process).toHaveCount(0)
  await expect(page.getByText(continuation, { exact: true })).toBeVisible()
  await emitEvents(sessionId, { event: 'TurnCompleted' })
  await expect(process).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
  await emitEvents(sessionId, { event: 'TurnSettled', data: { status: 'idle' } })
  await expect(process).toHaveAttribute('aria-expanded', 'false')
  await expect(process).toContainText(/Completed/)
  await expect(page.locator('.turn-final')).toHaveText('已完成执行过程展示调整，构建和交互检查通过。')
  await expect(page.getByText(introduction, { exact: true })).toBeVisible()
  await expect(page.getByText(continuation, { exact: true })).not.toBeVisible()
  await expect(page.getByText('子任务检查完成。', { exact: true })).not.toBeVisible()
  await expect(page.locator('.user-content').filter({ hasText: '请保留底部的任务状态。' })).toBeVisible()
  await expect(middle).toHaveCount(2)
  await expect(middle.first()).toHaveAttribute('aria-expanded', 'false')
  await expect(middle.last()).toHaveAttribute('aria-expanded', 'false')
  expect(await supplement.evaluate(element => {
    const controls = document.querySelectorAll('.process-middle')
    return Boolean(controls[0].compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)
      && Boolean(element.compareDocumentPosition(controls[1]) & Node.DOCUMENT_POSITION_FOLLOWING)
  })).toBe(true)
  await expect(page.getByRole('button', { name: '1 file changed' })).toBeVisible()
  expect(await firstNode!.evaluate(element => element.isConnected)).toBe(true)
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath('process-flow/complete.png') })

  await process.focus()
  await page.keyboard.press('Enter')
  await expect(process).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByText(introduction, { exact: true })).toBeVisible()
  await openGroupFor(toolMessage('build'))
  await expect(middle.first()).toHaveAttribute('aria-expanded', 'true')
  await expect(middle.last()).toHaveAttribute('aria-expanded', 'false')
  expect(await firstNode!.evaluate(element => element.isConnected)).toBe(true)
  await expect(firstTool).toHaveJSProperty('open', true)
  await expect(page.getByText(continuation, { exact: true })).toBeVisible()
  await toolMessage('build').locator(':scope > summary').press('Enter')
  await expect(toolMessage('build').getByRole('region', { name: 'Shell output' })).toContainText('Build completed.')
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath('process-flow/details.png') })

  await page.getByRole('button', { name: 'New chat' }).first().click()
  await page.locator('.session-item').filter({ hasText: '连续操作与最终回答' }).click()
  await expect(process).toHaveAttribute('aria-expanded', 'true')
  await expect(middle.first()).toHaveAttribute('aria-expanded', 'true')
  await expect(middle.last()).toHaveAttribute('aria-expanded', 'false')
  await expect(toolMessage('build')).toHaveJSProperty('open', true)
  await process.click()
  await middle.first().click()
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 640))
  await expect(page.locator('.turn-final')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false)
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath('process-flow/complete-compact.png') })
})

test('opened tool details and later plan updates preserve the reader scroll position', async () => {
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 640))
  const sessionId = await startControlledTurn('阅读位置保持')
  const history = Array.from({ length: 24 }, (_, index) => `第 ${index + 1} 段：正在核对项目结构、接口行为和验证结果，保留这段已经显示的文字供用户阅读。`).join('\n\n')
  await emitEvents(sessionId,
    { event: 'ModelRequestCompleted', data: { request_number: 1, output_text: history } },
    ...startedTool('reference', 'reference.ts'), finishedTool('reference', Array.from({ length: 32 }, (_, index) => `export const value${index} = ${index}`).join('\n'))
  )
  const reference = toolMessage('reference')
  await openGroupFor(reference)
  await reference.locator(':scope > summary').press('Enter')
  await expect(reference.locator('.tool-details')).toBeVisible()
  const transcript = page.locator('.transcript')
  await expect.poll(() => transcript.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(400)
  await transcript.evaluate(element => { element.scrollTop = 160 })
  await expect(page.getByRole('button', { name: 'Scroll to latest message' })).toBeVisible()
  const readingPosition = await transcript.evaluate(element => element.scrollTop)
  const visibleParagraph = page.locator('.message-assistant .markdown p').nth(3)
  const paragraphTop = (await visibleParagraph.boundingBox())!.y

  await emitEvents(sessionId,
    ...startedTool('later', 'later.ts'), finishedTool('later'),
    { event: 'PlanUpdated', data: { plan: [{ description: '核对项目结构', status: 'completed' }, { description: '核对接口行为', status: 'in_progress' }] } }
  )
  await expect(toolMessage('later').locator(':scope > summary')).toHaveAttribute('aria-label', 'Read later.ts')
  await expect(page.getByRole('button', { name: 'View task plan' })).toBeVisible()
  await expect(reference).toHaveJSProperty('open', true)
  expect(Math.abs(await transcript.evaluate(element => element.scrollTop) - readingPosition)).toBeLessThan(1)
  expect(Math.abs((await visibleParagraph.boundingBox())!.y - paragraphTop)).toBeLessThan(1)

  await emitEvents(sessionId,
    { event: 'PlanUpdated', data: { plan: [{ description: '核对项目结构', status: 'completed' }, { description: '核对接口行为', status: 'completed' }, { description: '整理验证结果', status: 'pending' }] } },
    { event: 'TurnCompleted' }, { event: 'TurnSettled', data: { status: 'idle' } }
  )
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  await expect(page.locator('.execution-status .spin')).toHaveCount(0)
  // The completion header and historical plan can add height above the text;
  // the visible reading anchor must stay put even if scrollTop compensates.
  expect(Math.abs((await visibleParagraph.boundingBox())!.y - paragraphTop)).toBeLessThan(1)
  await expect(page.getByRole('button', { name: 'Scroll to latest message' })).toBeVisible()
})

test('execution status stays mounted in the transcript and the task plan is an explicit keyboard-accessible popover', async () => {
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 640))
  const sessionId = await startControlledTurn('执行状态与计划面板')
  const status = page.locator('.execution-status[role="status"]')
  await expect(status).toHaveCount(1)
  await expect(status).toBeVisible()
  const statusNode = await status.elementHandle()
  await expect(page.locator('.transcript .activity')).toHaveCount(0)
  await emitEvents(sessionId, { event: 'PlanUpdated', data: { plan: [
    { description: '检查执行状态', status: 'in_progress' }, { description: '验证计划交互', status: 'pending' }
  ] } })
  const planButton = page.getByRole('button', { name: 'View task plan' })
  const popover = page.locator('.plan-popover')
  await expect(planButton).toHaveAttribute('aria-expanded', 'false')
  await expect(popover).not.toBeVisible()
  expect(await planButton.evaluate(element => element.closest('.transcript') !== null)).toBe(true)
  expect(await page.locator('.execution-bar').evaluate(element => {
    const composer = document.querySelector('.composer')
    return Boolean(composer && element.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING)
  })).toBe(true)

  await planButton.focus()
  await page.keyboard.press('Enter')
  await expect(planButton).toHaveAttribute('aria-expanded', 'true')
  await expect(popover).toBeVisible()
  await expect(popover.getByRole('button', { name: 'Close task plan' })).toBeInViewport()
  await expect(page.getByRole('dialog')).not.toBeVisible()

  await emitEvents(sessionId, ...startedTool('plan-check', 'plan-check.ts'))
  await expect(toolMessage('plan-check').locator(':scope > summary')).toContainText('Reading plan-check.ts')
  expect(await statusNode!.evaluate(element => element.isConnected)).toBe(true)
  await expect(status).toHaveCount(1)
  await expect(status).toHaveText('检查执行状态')
  expect(await status.evaluate(element => getComputedStyle(element).animationName)).toBe('none')
  await expect(popover).toBeVisible()

  await emitEvents(sessionId, finishedTool('plan-check'), { event: 'ModelRequestStarted', data: { request_number: 2 } },
    { event: 'PlanUpdated', data: { plan: [
      { description: '检查执行状态', status: 'completed' }, { description: '验证计划交互', status: 'in_progress' }, { description: '检查键盘返回', status: 'pending' }
    ] } }
  )
  await expect(popover.locator('li')).toHaveCount(3)
  await expect(popover.locator('li.completed')).toHaveCount(1)
  await expect(planButton).toHaveAttribute('aria-expanded', 'true')
  expect(await statusNode!.evaluate(element => element.isConnected)).toBe(true)
  await expect(page.locator('.transcript .activity')).toHaveCount(0)
  await emitEvents(sessionId, { event: 'AssistantTextDelta', data: { request_number: 2, text: '状态检查已完成，继续验证计划交互。' } })
  await expect(page.locator('.message-assistant')).toContainText('状态检查已完成，继续验证计划交互。')
  await expect(popover).toBeVisible()
  expect(await statusNode!.evaluate(element => element.isConnected)).toBe(true)
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath('execution-polish/plan-open.png') })

  await page.keyboard.press('Escape')
  await expect(popover).not.toBeVisible()
  await expect(planButton).toHaveAttribute('aria-expanded', 'false')
  await expect(planButton).toBeFocused()
  await planButton.click()
  await expect(popover).toBeVisible()
  await page.locator('textarea').click()
  await expect(popover).not.toBeVisible()
  await expect(page.locator('textarea')).toBeFocused()
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath('execution-polish/plan-closed.png') })
})

test('finishing a turn preserves incomplete plan steps and keeps tool failures discoverable', async () => {
  const sessionId = await startControlledTurn('保留真实计划进度')
  await emitEvents(sessionId,
    { event: 'PlanUpdated', data: { plan: [
      { description: '读取现有配置', status: 'completed' }, { description: '运行验证命令', status: 'in_progress' }, { description: '整理检查结果', status: 'pending' }
    ] } },
    { event: 'ToolCallPrepared', data: { call_id: 'broken', tool_name: 'run_command', arguments: { command: 'npm run verify' } } },
    { event: 'ToolStarted', data: { call_id: 'broken', tool_name: 'run_command' } },
    { event: 'ToolFinished', data: { call_id: 'broken', tool_name: 'run_command', result: { success: false, output: 'Verification failed: required configuration is missing.' } } }
  )
  const failed = toolMessage('broken')
  const group = page.locator('.tool-group').filter({ has: failed })
  await expect(failed.locator(':scope > summary')).toBeVisible()
  await expect(failed.locator(':scope > summary')).toContainText('Failed')

  await emitEvents(sessionId, { event: 'TurnCompleted' }, { event: 'TurnSettled', data: { status: 'idle' } })
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  await expect(page.locator('.execution-bar')).toHaveCount(0)
  const process = page.locator('.process-completed')
  await expect(process).toHaveAttribute('aria-expanded', 'false')
  await process.press('Enter')
  const plan = page.locator('.turn-plan')
  await expect(plan.locator(':scope > summary')).toContainText(/1\s*\/\s*3/)
  await plan.locator(':scope > summary').press('Enter')
  await expect(plan.locator('li')).toHaveCount(3)
  await expect(plan.locator('li.completed')).toHaveCount(1)
  await expect(plan.locator('li.pending')).toHaveText('整理检查结果')
  await expect(failed.locator(':scope > summary')).toContainText('Failed')
  await openGroupFor(failed)
  await failed.locator(':scope > summary').press('Enter')
  await expect(failed.locator('.tool-details')).toContainText('Verification failed: required configuration is missing.')
})

test('a long plan stays within a compact window above a fully expanded draft', async () => {
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(760, 560))
  const sessionId = await startControlledTurn('小窗口中的长计划')
  const draft = Array.from({ length: 18 }, (_, index) => `补充要求 ${index + 1}：保留当前草稿并确认计划展开后仍能看到标题和关闭按钮。`).join('\n')
  const input = page.locator('textarea')
  await input.fill(draft)
  await expect.poll(async () => (await input.boundingBox())!.height).toBe(140)

  await emitEvents(sessionId, { event: 'PlanUpdated', data: { plan: Array.from({ length: 24 }, (_, index) => ({
    description: `步骤 ${index + 1}：检查一个较长的执行项目，核对相关文件、接口状态和验证结果，并记录需要后续处理的事项。`,
    status: index === 0 ? 'completed' : index === 1 ? 'in_progress' : 'pending'
  })) } })
  await page.getByRole('button', { name: 'View task plan' }).click()
  const popover = page.locator('.plan-popover')
  const close = popover.getByRole('button', { name: 'Close task plan' })
  await expect(popover).toBeVisible()
  await expect(popover.locator('li')).toHaveCount(24)
  await expect(close).toBeVisible()
  await expect(close).toBeInViewport()
  const bounds = (await popover.boundingBox())!
  expect(bounds.y).toBeGreaterThanOrEqual(8)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(await page.evaluate(() => window.innerHeight))
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false)
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath('execution-polish/plan-compact-long.png') })
  await close.click()
  await expect(popover).not.toBeVisible()
  await expect(input).toHaveValue(draft)
  await expect(page.getByRole('button', { name: 'View task plan' })).toBeFocused()
})
