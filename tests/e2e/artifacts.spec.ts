import { stopFixtureService } from './service-fixture'
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let application: ElectronApplication | undefined
let page: Page
let profile = ''
let workspace = ''
const errors: string[] = []
const quotation = '这段结论需要保留来源，并在后续消息中完整发送。'

test.beforeEach(async () => {
  application = undefined
  profile = await mkdtemp(join(tmpdir(), 'praxis-artifacts-e2e-'))
  workspace = join(profile, 'workspace')
  await mkdir(workspace)
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ workspace }), 'utf8')
  errors.length = 0
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    PRAXIS_DATA_DIR: join(profile, 'service'), PRAXIS_UI_DATA_DIR: profile,
    PRAXIS_UI_TEST_MODE: '1',
    PRAXIS_UI_TEST_SERVER: resolve('tests/fixtures/ui-server.cjs'),
    PRAXIS_UI_TEST_WORKSPACE: workspace
  }
  delete env.ELECTRON_RUN_AS_NODE
  application = await electron.launch({ args: [resolve('.')], env })
  const visibility = await application.evaluate(({ app, BrowserWindow }) => {
    const state = globalThis as typeof globalThis & { artifactWindowShows: number }
    const windows = BrowserWindow.getAllWindows()
    state.artifactWindowShows = windows.filter(window => window.isVisible()).length
    for (const window of windows) window.on('show', () => { state.artifactWindowShows += 1 })
    app.on('browser-window-created', (_event, window) => {
      window.on('show', () => { state.artifactWindowShows += 1 })
    })
    return { visible: windows.some(window => window.isVisible()), showCount: state.artifactWindowShows }
  })
  expect(visibility).toEqual({ visible: false, showCount: 0 })
  page = await application.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await expect.poll(() => page.evaluate(async () => (await window.praxis.getInfo()).connection.state)).toBe('connected')
  expect(await page.evaluate(async () => (await window.praxis.getInfo()).settings.workspace)).toBe(workspace)
})

test.afterEach(async () => {
  let visibility: { visible: boolean; showCount: number } | undefined
  try {
    if (application) visibility = await application.evaluate(({ BrowserWindow }) => ({
      visible: BrowserWindow.getAllWindows().some(window => window.isVisible()),
      showCount: (globalThis as typeof globalThis & { artifactWindowShows: number }).artifactWindowShows
    }))
  } finally {
    await stopFixtureService(join(profile, 'service'))
    await application?.close()
    if (profile) {
      // Only delete this test's verified, isolated temporary profile and workspace.
      const expectedParent = resolve(tmpdir())
      const target = resolve(profile)
      expect(target.startsWith(expectedParent + (process.platform === 'win32' ? '\\' : '/'))).toBe(true)
      expect(target.split(/[\\/]/).at(-1)).toMatch(/^praxis-artifacts-e2e-/)
      await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  }
  expect(visibility).toEqual({ visible: false, showCount: 0 })
  expect(errors).toEqual([])
})

async function send(text: string): Promise<void> {
  await page.locator('textarea').fill(text)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
}

async function startArtifactTurn(name: string): Promise<string> {
  const title = `产物验收：第一轮 ${name}`
  await send(title)
  await expect(page.getByRole('link', { name: '项目说明' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  return title
}

async function sessionId(title: string): Promise<string> {
  return page.evaluate(async title => {
    const { settings } = await window.praxis.getInfo()
    const { sessions } = await window.praxis.request<{ sessions: { id: string; title: string }[] }>('session.list', { workspace: settings.workspace })
    const session = sessions.find(item => item.title === title)
    if (!session) throw new Error(`Missing artifact session: ${title}`)
    return session.id
  }, title)
}

async function receivedUserMessages(id: string): Promise<string[]> {
  return page.evaluate(async id => {
    const snapshot = await window.praxis.request<{ messages: { role: string; content: string }[] }>('session.open', { session_id: id })
    return snapshot.messages.filter(message => message.role === 'user').map(message => message.content)
  }, id)
}

async function fileActionCount(): Promise<number> {
  return application!.evaluate(() => ((globalThis as typeof globalThis & { __praxisFileActions?: unknown[] }).__praxisFileActions || []).length)
}

async function selectResponseText(text: string): Promise<void> {
  const paragraph = page.locator('.message-assistant .markdown p').filter({ hasText: text }).first()
  // Reading an older answer starts with an upward wheel gesture. Without this
  // intent, a running agent should keep following new output at the bottom.
  await page.locator('.transcript').hover()
  await page.mouse.wheel(0, -600)
  await paragraph.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await paragraph.scrollIntoViewIfNeeded()
  // Allow scroll events to finish before starting the user's selection. Selection
  // actions are intentionally dismissed while the transcript is scrolling.
  await paragraph.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await expect(paragraph).toBeInViewport({ ratio: 0.01 })
  await paragraph.dispatchEvent('pointerdown', { button: 0 })
  const selected = await paragraph.evaluate((element, text) => {
    const node = element.firstChild
    if (!(node instanceof Text)) throw new Error('The fixture quotation must remain real selectable text')
    const start = node.data.indexOf(text)
    if (start === -1) throw new Error('Quotation text is missing')
    const range = document.createRange()
    range.setStart(node, start)
    range.setEnd(node, start + text.length)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    return selection.toString()
  }, text)
  expect(selected).toBe(text)
  await paragraph.dispatchEvent('pointerup', { button: 0 })
}

async function selectQuotation(text = quotation): Promise<void> {
  await selectResponseText(text)
  const quoteButton = page.getByRole('button', { name: '引用选中文字', exact: true })
  await expect(quoteButton).toBeVisible()
  await quoteButton.click()
  await expect(page.locator('.quote-draft')).toContainText(text)
}

test('turn changes aggregate repeated edits without hiding their order and stay isolated across turns and sessions', async () => {
  const title = await startArtifactTurn('改动聚合')
  const currentChanges = page.getByRole('button', { name: '查看本轮改动', exact: true })
  await expect(currentChanges).toContainText('改动 2')
  await currentChanges.click()
  const panel = page.getByRole('complementary', { name: '文件与改动' })
  await expect(panel).toBeVisible()
  await expect(panel.locator('.changed-file-button')).toHaveCount(2)
  await panel.locator('.changed-file-button').filter({ hasText: 'brief.md' }).click()
  const diffs = panel.locator('.change-diffs .file-diff')
  await expect(diffs).toHaveCount(2)
  await expect(diffs.nth(0)).toContainText('-Status: draft.')
  await expect(diffs.nth(0)).toContainText('+Status: reviewed.')
  await expect(diffs.nth(1)).toContainText('-Status: reviewed.')
  await expect(diffs.nth(1)).toContainText('+Status: final.')
  await expect(diffs.nth(1)).toContainText('+Owner: Praxis.')
  await page.screenshot({ animations: 'disabled', path: 'test-results/artifacts/diff-expanded.png' })
  await panel.getByRole('button', { name: '关闭预览', exact: true }).click()

  await send('产物验收：第二轮，仅修改配置')
  await expect(page.getByText('第二轮只调整了配置文件。', { exact: true })).toBeVisible()
  await expect(currentChanges).toContainText('改动 1')
  await currentChanges.click()
  await expect(panel.locator('.changed-file-button')).toHaveCount(1)
  await expect(panel.locator('.changed-file-button')).toContainText('settings.txt')
  await panel.getByRole('button', { name: '关闭预览', exact: true }).click()
  const turns = page.locator('.turn-changes-summary')
  await expect(turns).toHaveCount(2)
  await expect(turns.nth(0)).toContainText('修改了 2 个文件')
  await expect(turns.nth(1)).toContainText('修改了 1 个文件')
  await turns.first().click()
  await expect(panel.locator('.changed-file-button')).toHaveCount(2)
  await panel.locator('.changed-file-button').filter({ hasText: 'brief.md' }).click()
  await expect(panel.locator('.change-diffs .file-diff')).toHaveCount(2)

  await page.getByRole('button', { name: 'New chat' }).first().click()
  await expect(panel).not.toBeVisible()
  await send('第二个会话：没有文件变更')
  await expect(page.getByText('已完成这条独立会话中的任务。')).toBeVisible()
  await expect(page.locator('.turn-changes-summary')).toHaveCount(0)
  await page.locator('.session-item').filter({ hasText: title }).click()
  await expect(page.locator('.turn-changes-summary')).toHaveCount(2)
  await expect(currentChanges).toContainText('改动 1')
  await page.locator('.turn-changes-summary').first().click()
  await expect(panel.locator('.changed-file-button')).toHaveCount(2)
  expect(await fileActionCount()).toBe(0)
})

test('local links render current Markdown, text, images and PDF inside the hidden app', async () => {
  await startArtifactTurn('文件预览')
  const preview = page.locator('.file-preview')
  await page.getByRole('link', { name: '项目说明' }).click()
  await expect(preview.getByRole('heading', { name: 'Project notes', exact: true })).toBeVisible()
  await expect(preview.locator('.markdown')).toContainText('Status: final.')
  await expect(preview.locator('.markdown')).not.toContainText('Status: draft.')
  await page.screenshot({ animations: 'disabled', path: 'test-results/artifacts/markdown-preview.png' })
  await page.getByRole('link', { name: '纯文本' }).click()
  await expect(preview.locator('pre.file-text')).toContainText('Plain text preview fixture.')
  await page.getByRole('link', { name: '绝对路径文本' }).click()
  await expect(preview.locator('pre.file-text')).toContainText('The second line stays readable.')
  await page.getByRole('link', { name: '图表图片' }).click()
  const picture = preview.locator('img.file-image')
  await expect(picture).toBeVisible()
  await expect.poll(() => picture.evaluate(element => {
    const image = element as HTMLImageElement
    return image.complete && image.naturalWidth > 0 && image.naturalHeight > 0
  })).toBe(true)
  await page.getByRole('link', { name: 'PDF 报告' }).click()
  const canvas = preview.locator('.pdf-viewer canvas')
  await expect(canvas).toBeVisible()
  await expect.poll(() => canvas.evaluate(element => {
    const surface = element as HTMLCanvasElement
    if (!surface.width || !surface.height) return false
    const pixels = surface.getContext('2d')!.getImageData(0, 0, surface.width, surface.height).data
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3] > 200 && pixels[index] < 150 && pixels[index + 1] < 150 && pixels[index + 2] < 150) return true
    }
    return false
  })).toBe(true)
  expect(await fileActionCount()).toBe(0)
})

test('missing files recover on refresh and unsupported Office files require an explicit simulated external action', async () => {
  await startArtifactTurn('文件异常')
  const panel = page.getByRole('complementary', { name: '文件与改动' })
  const preview = page.locator('.file-preview')
  await page.getByRole('link', { name: '缺失文件' }).click()
  await expect(panel.getByRole('alert')).toBeVisible()
  expect(await fileActionCount()).toBe(0)
  await writeFile(join(workspace, 'files', 'missing.md'), '# Recovered preview\n\nThis file was added after the failed preview.\n')
  await page.getByRole('button', { name: '刷新文件', exact: true }).click()
  await expect(preview.getByRole('heading', { name: 'Recovered preview', exact: true })).toBeVisible()
  await expect(panel.getByRole('alert')).toHaveCount(0)
  await page.getByRole('link', { name: 'Office 文档' }).click()
  await expect(preview).toContainText('此文件可在默认应用中查看。')
  await expect(preview.getByRole('button', { name: '用默认应用打开', exact: true })).toBeEnabled()
  expect(await fileActionCount()).toBe(0)
  await preview.getByRole('button', { name: '用默认应用打开', exact: true }).click()
  await expect.poll(fileActionCount).toBe(1)
  await page.getByRole('button', { name: '在文件夹中显示', exact: true }).click()
  await expect.poll(fileActionCount).toBe(2)
  const actions = await application!.evaluate(() => (globalThis as typeof globalThis & {
    __praxisFileActions: { path: string; action: string; simulated: boolean }[]
  }).__praxisFileActions)
  expect(actions.map(action => ({ action: action.action, simulated: action.simulated }))).toEqual([
    { action: 'open', simulated: true }, { action: 'reveal', simulated: true }
  ])
  expect(actions.every(action => action.path.endsWith('report.docx'))).toBe(true)
})

test('quoting selected text sends the actual quotation and instruction to Praxis and clears only after success', async () => {
  const title = await startArtifactTurn('引用发送')
  const id = await sessionId(title)
  await selectQuotation()
  await page.locator('.quote-draft summary').click()
  await expect(page.locator('.quote-draft blockquote')).toBeVisible()
  await page.screenshot({ animations: 'disabled', path: 'test-results/artifacts/quote-expanded.png' })
  const instruction = '请把这段改得简洁些。'
  await send(instruction)
  await expect.poll(async () => (await receivedUserMessages(id)).at(-1)).toContain(quotation)
  const received = (await receivedUserMessages(id)).at(-1)!
  expect(received).toContain(instruction)
  await expect(page.locator('.quote-draft')).toHaveCount(0)
  await expect(page.locator('textarea')).toHaveValue('')
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  await send('现在确认一下。')
  await expect.poll(async () => (await receivedUserMessages(id)).at(-1)).toBe('现在确认一下。')
})

test('failed quotation submission is retained for retry and drafts remain isolated between sessions', async () => {
  const title = await startArtifactTurn('引用草稿')
  const id = await sessionId(title)
  await selectQuotation()
  const instruction = '测试发送失败一次：请按引用调整。'
  await send(instruction)
  await expect(page.getByRole('alert')).toContainText('测试发送失败，请重试。')
  await expect(page.locator('.quote-draft')).toContainText(quotation)
  await expect(page.locator('textarea')).toHaveValue(instruction)
  expect(await receivedUserMessages(id)).toHaveLength(1)
  await page.getByRole('button', { name: 'New chat' }).first().click()
  await expect(page.locator('.quote-draft')).toHaveCount(0)
  await expect(page.locator('textarea')).toHaveValue('')
  const otherTitle = '第二个会话：引用隔离'
  await send(otherTitle)
  await expect(page.getByText('已完成这条独立会话中的任务。')).toBeVisible()
  const otherDraft = '会话 B 尚未发送的内容'
  await page.locator('textarea').fill(otherDraft)
  await page.locator('.session-item').filter({ hasText: title }).click()
  await expect(page.locator('.quote-draft')).toContainText(quotation)
  await expect(page.locator('textarea')).toHaveValue(instruction)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(async () => (await receivedUserMessages(id)).at(-1)).toContain(instruction)
  expect((await receivedUserMessages(id)).at(-1)).toContain(quotation)
  await expect(page.locator('.quote-draft')).toHaveCount(0)
  await expect(page.locator('textarea')).toHaveValue('')
  await page.locator('.session-item').filter({ hasText: otherTitle }).click()
  await expect(page.locator('textarea')).toHaveValue(otherDraft)
  await expect(page.locator('.quote-draft')).toHaveCount(0)
})

test('preview and quoted drafts fit the minimum window without losing controls or causing page overflow', async () => {
  await application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(760, 560))
  await startArtifactTurn('最小窗口')
  const longQuote = (await page.locator('.message-assistant .markdown p').filter({ hasText: '长引用测试：' }).textContent())!.replace(/^长引用测试：/, '')
  expect(longQuote.length).toBeGreaterThan(600)
  await selectQuotation(longQuote)
  const draft = Array.from({ length: 18 }, (_, index) => `补充要求 ${index + 1}：保留引用与未发送内容。`).join('\n')
  await page.locator('textarea').fill(draft)
  await expect.poll(async () => (await page.locator('textarea').boundingBox())!.height).toBe(176)
  await page.locator('.quote-draft summary').click()
  await expect(page.locator('.quote-draft blockquote')).toBeVisible()
  await expect(page.locator('.execution-bar')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeInViewport()
  await expect(page.getByRole('button', { name: '移除引用', exact: true })).toBeInViewport()
  await page.screenshot({ animations: 'disabled', path: 'test-results/artifacts/quote-expanded-compact.png' })
  await page.getByRole('link', { name: '纯文本' }).click()
  const panel = page.getByRole('complementary', { name: '文件与改动' })
  await expect(panel.locator('pre.file-text')).toContainText('Plain text preview fixture.')
  const close = panel.getByRole('button', { name: '关闭预览', exact: true })
  await expect(close).toBeInViewport()
  const bounds = (await panel.boundingBox())!
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth }))
  expect(viewport.overflow).toBe(false)
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.y).toBeGreaterThanOrEqual(0)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1)
  await page.screenshot({ animations: 'disabled', path: 'test-results/artifacts/preview-compact.png' })
  await close.click()
  await expect(panel).not.toBeVisible()
  await expect(page.locator('textarea')).toHaveValue(draft)
  await expect(page.locator('.quote-draft')).toContainText(longQuote)
  await expect(page.getByRole('button', { name: '移除引用', exact: true })).toBeInViewport()
  await page.getByRole('button', { name: '移除引用', exact: true }).click()
  await expect(page.locator('.quote-draft')).toHaveCount(0)
  await expect(page.locator('textarea')).toHaveValue(draft)
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
})

test('a failed in-flight submission preserves its original quotation and merges newly typed draft text', async () => {
  const title = await startArtifactTurn('等待确认时保留引用')
  const id = await sessionId(title)
  await selectQuotation()
  const original = '测试延迟发送失败一次：请按 Q1 调整。'
  const additional = '等待确认期间新增的补充内容 B。'
  const alternative = '文件已经准备好，可以检查结果并继续修改。'
  await send(original)
  await expect.poll(() => page.evaluate(async id => {
    const result = await window.praxis.request<{ pending: boolean }>('input.submit', { session_id: id, test_ack_state: true })
    return result.pending
  }, id)).toBe(true)
  await expect(page.getByRole('button', { name: '移除引用', exact: true })).toBeDisabled()
  await expect(page.locator('textarea')).toBeEnabled()
  await page.locator('textarea').fill(additional)
  await selectResponseText(alternative)
  await expect(page.getByRole('button', { name: '引用选中文字', exact: true })).toHaveCount(0)
  await expect(page.locator('.quote-draft')).toContainText(quotation)
  await expect(page.locator('.quote-draft')).not.toContainText(alternative)
  await expect(page.locator('textarea')).toHaveValue(additional)

  const released = await page.evaluate(async id => window.praxis.request<{ released: boolean }>('input.submit', {
    session_id: id, test_reject_pending_start: true
  }), id)
  expect(released.released).toBe(true)
  await expect(page.getByRole('alert')).toContainText('测试延迟发送失败，请重试。')
  await expect(page.locator('textarea')).toHaveValue(`${original}\n\n${additional}`)
  await expect(page.locator('.quote-draft')).toContainText(quotation)
  await expect(page.getByRole('button', { name: '移除引用', exact: true })).toBeEnabled()
  expect(await receivedUserMessages(id)).toHaveLength(1)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(async () => (await receivedUserMessages(id)).at(-1)).toContain(additional)
  const received = (await receivedUserMessages(id)).at(-1)!
  expect(received).toContain(quotation)
  expect(received).toContain(original)
  expect(received).not.toContain(alternative)
  await expect(page.locator('.quote-draft')).toHaveCount(0)
  await expect(page.locator('textarea')).toHaveValue('')
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)

  // Once the request is acknowledged, an actively running agent still accepts
  // a new quotation and supplementary message; only the pending send is locked.
  await send('长任务：确认接收后仍可引用补充')
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
  await selectQuotation(alternative)
  await expect(page.getByRole('button', { name: '移除引用', exact: true })).toBeEnabled()
  await page.locator('textarea').fill('请参考新的引用继续执行。')
  await page.getByRole('button', { name: 'Send follow-up', exact: true }).click()
  await expect(page.locator('.quote-draft')).toHaveCount(0)
  await expect(page.locator('.user-content').filter({ hasText: '请参考新的引用继续执行。' })).toContainText(alternative)
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
})

test('a child relative file keeps a separate diff and cannot preview the same-named parent file', async () => {
  await send('产物验收：父子同名路径')
  await expect(page.getByText('父任务与子任务各修改了自己的 a.ts。', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '查看本轮改动', exact: true })).toContainText('改动 2')
  await expect(page.getByRole('link', { name: '子任务 a.ts' })).toHaveCount(0)
  await page.locator('.file-reference-inline[aria-disabled="true"]').dispatchEvent('click')
  const panel = page.getByRole('complementary', { name: '文件与改动' })
  await expect(panel).not.toBeVisible()
  await page.getByRole('button', { name: '查看本轮改动', exact: true }).click()
  const files = panel.locator('.changed-file-button')
  await expect(files).toHaveCount(2)
  const child = files.filter({ hasText: '子任务 child-files' })
  const parent = files.filter({ hasNotText: '子任务' })
  await expect(child).toHaveCount(1)
  await expect(parent).toHaveCount(1)
  await child.click()
  await expect(panel.locator('.change-diffs .file-diff')).toHaveCount(1)
  await expect(panel.locator('.change-diffs')).toContainText('source = "child"')
  await expect(panel.locator('.change-diffs')).not.toContainText('source = "parent"')
  await expect(panel.getByRole('button', { name: '文件预览', exact: true })).toBeDisabled()
  await expect(panel.getByRole('button', { name: '查看当前文件', exact: true })).toHaveCount(0)
  await expect(panel).toContainText('子任务未提供完整文件路径')
  await parent.click()
  await expect(panel.locator('.change-diffs .file-diff')).toHaveCount(1)
  await expect(panel.locator('.change-diffs')).toContainText('source = "parent"')
  await panel.getByRole('button', { name: '查看当前文件', exact: true }).click()
  await expect(panel.locator('pre.file-text')).toHaveText('export const source = "parent";\n')
  expect(await fileActionCount()).toBe(0)
})

test('file references form quiet inline labels and compact rows with keyboard preview and narrow-window truncation', async () => {
  await send('整理桌面交互方案')
  const answer = page.locator('.message-assistant .markdown').last()
  const group = answer.getByRole('region', { name: '相关文件', exact: true })
  await expect(group).toBeVisible()
  const rows = group.locator('a.file-reference-row')
  await expect(rows).toHaveCount(4)
  const inline = answer.locator('a.file-reference-inline')
  await expect(inline).toHaveCount(1)
  await expect(inline).toHaveText('interaction-notes.md')
  await expect(inline).toHaveAttribute('aria-label', 'interaction-notes.md · 交互方案')
  expect(await inline.evaluate(element => getComputedStyle(element).textDecorationLine)).toBe('none')
  expect(await rows.first().evaluate(element => getComputedStyle(element).textDecorationLine)).toBe('none')
  await expect(rows.first()).toContainText('interaction-notes.md')
  await expect(rows.first()).toContainText('交互方案')
  await expect(rows.first().locator('.file-reference-label')).toHaveText('交互方案')
  await expect(rows.first().locator('.file-reference-meta')).toHaveText('interaction-notes.md')
  await expect(rows.first()).toHaveAttribute('title', new RegExp('docs/interaction-notes\\.md$'))
  await page.mouse.move(0, 0)
  await page.screenshot({ animations: 'disabled', path: 'test-results/file-links/desktop.png' })
  await answer.screenshot({ animations: 'disabled', path: 'test-results/file-links/message.png' })
  await rows.nth(2).hover()
  await group.screenshot({ animations: 'disabled', path: 'test-results/file-links/hover.png' })

  await rows.first().focus()
  await rows.first().press('Enter')
  const panel = page.getByRole('complementary', { name: '文件与改动' })
  await expect(panel.getByRole('heading', { name: '桌面交互方案', exact: true })).toBeVisible()
  const documentLink = panel.getByRole('link', { name: '验收清单', exact: true })
  await expect(documentLink).not.toHaveClass(/file-reference/)
  await documentLink.click()
  await expect(panel.locator('.file-text')).toContainText('文件预览,已完成')
  await page.keyboard.press('Escape')
  await expect(panel).not.toBeVisible()
  await expect(rows.first()).toBeFocused()

  await application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(760, 560))
  await expect(group).toBeVisible()
  const longName = rows.last().locator('.file-reference-stem')
  expect(await longName.evaluate(element => ({ truncated: element.scrollWidth > element.clientWidth, ellipsis: getComputedStyle(element).textOverflow }))).toEqual({ truncated: true, ellipsis: 'ellipsis' })
  await expect(rows.last().locator('.file-reference-suffix')).toHaveText('.md')
  expect(await rows.last().evaluate(element => element.getBoundingClientRect().height)).toBeLessThanOrEqual(48)
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  const bounds = (await group.boundingBox())!
  const width = await page.evaluate(() => innerWidth)
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(width)
  await group.scrollIntoViewIfNeeded()
  await page.mouse.move(0, 0)
  await page.screenshot({ animations: 'disabled', path: 'test-results/file-links/compact.png' })
  await rows.last().click()
  await expect(panel.getByRole('heading', { name: '完整交互说明', exact: true })).toBeVisible()
  expect(await fileActionCount()).toBe(0)
})
