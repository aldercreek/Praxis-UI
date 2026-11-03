import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { stopFixtureService } from './service-fixture'

let application: ElectronApplication
let page: Page
let profile: string
let workspace: string
const errors: string[] = []

test.beforeEach(async ({}, testInfo) => {
  await mkdir(testInfo.outputDir, { recursive: true })
  profile = await mkdtemp(join(testInfo.outputDir, 'profile-'))
  workspace = join(profile, 'workspace')
  await mkdir(join(workspace, 'src'), { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: workspace, windowsHide: true })
  await Promise.all(Array.from({ length: 12 }, (_, index) => writeFile(join(workspace, 'src', `example-${index}.ts`), 'export const value = 1')))
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    PRAXIS_DATA_DIR: join(profile, 'service'), PRAXIS_UI_DATA_DIR: profile, PRAXIS_UI_TEST_MODE: '1',
    PRAXIS_UI_TEST_SERVER: resolve('tests/fixtures/ui-server.cjs'), PRAXIS_UI_TEST_CONTROLLED_INPUT: '1'
  }
  delete env.ELECTRON_RUN_AS_NODE
  errors.length = 0
  application = await electron.launch({ args: [resolve('.')], env })
  page = await application.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await expect.poll(() => page.evaluate(async () => (await window.praxis.getInfo()).connection.state)).toBe('connected')
  await page.evaluate(workspace => window.praxis.updateSettings({ workspace }), workspace)
  await page.reload()
  await expect.poll(() => page.evaluate(async () => (await window.praxis.getInfo()).connection.state)).toBe('connected')
})

test.afterEach(async () => {
  await stopFixtureService(join(profile, 'service'))
  await application?.close()
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  expect(errors).toEqual([])
})

async function startTurn(title: string) {
  await page.locator('.composer textarea').fill(title)
  await page.locator('.composer textarea').press('Enter')
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
  return page.evaluate(async () => {
    const { sessions } = await window.praxis.request<{ sessions: { id: string }[] }>('session.list')
    return sessions[0].id
  })
}

type TestEvent = { event: string; data?: Record<string, unknown>; agent_id?: string }
async function emit(sessionId: string, ...events: TestEvent[]) {
  await page.evaluate(({ sessionId, events }) => window.praxis.request('input.submit', { session_id: sessionId, test_events: events }), { sessionId, events })
}

test('command and file suggestions support keyboard, IME, focus and narrow windows', async () => {
  const input = page.locator('.composer textarea')
  await input.fill('/')
  const list = page.getByRole('listbox')
  await expect(list.getByRole('option')).toHaveCount(3)
  await input.press('ArrowDown')
  await input.press('Enter')
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(input).toHaveValue('')
  await page.keyboard.press('Escape')
  await input.fill('/mcp')
  await input.press('Enter')
  await expect(page.getByRole('dialog', { name: 'MCP servers' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.session-item')).toHaveCount(0)
  await input.fill('/delete')
  await input.press('Enter')
  await expect(page.getByRole('alert')).toContainText('Open a chat to delete it.')
  await page.getByRole('button', { name: 'Dismiss error' }).click()

  await input.fill('@example')
  await expect(list.getByRole('option')).toHaveCount(12)
  await expect(list).toHaveCSS('max-height', '268px')
  const bounds = await page.evaluate(() => {
    const form = document.querySelector('.composer')!.getBoundingClientRect()
    const panel = document.querySelector('.composer-suggestions')!.getBoundingClientRect()
    return { width: Math.abs(form.width - panel.width), left: Math.abs(form.left - panel.left), gap: form.top - panel.bottom }
  })
  expect(bounds).toEqual({ width: 0, left: 0, gap: 8 })
  await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true })
  await expect(input).toHaveValue('@example')
  await input.dispatchEvent('keydown', { key: 'Enter', keyCode: 229 })
  await expect(input).toHaveValue('@example')
  await expect(page.locator('.session-item')).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath('file-suggestions.png') })
  await input.press('Tab')
  await expect(input).toHaveValue('@src/example-0.ts ')
  expect(await input.evaluate(element => (element as HTMLTextAreaElement).selectionStart)).toBe('@src/example-0.ts '.length)
  await expect(list).toHaveCount(0)
  await input.fill('@example')
  await input.press('Escape')
  await expect(list).toHaveCount(0)
  await input.fill('@example-1')
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await expect(list).toHaveCount(0)

  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(720, 720))
  await input.fill('@example')
  await expect(list).toBeVisible()
  expect(await list.evaluate(element => element.getBoundingClientRect().right <= innerWidth)).toBe(true)
  await page.screenshot({ path: test.info().outputPath('file-suggestions-narrow.png') })
  await page.getByRole('button', { name: 'Settings', exact: true }).focus()
  await expect(list).toHaveCount(0)
})

test('renders Mermaid and math under CSP and restores context across reloads', async () => {
  const loaded: string[] = []
  page.on('request', request => loaded.push(request.url()))
  const sessionId = await startTurn('Diagram and context validation')
  await page.evaluate(() => {
    const state = window as typeof window & { cspViolations: string[] }
    state.cspViolations = []
    document.addEventListener('securitypolicyviolation', event => state.cspViolations.push(event.violatedDirective))
  })
  const content = 'A small workflow and its cost.\n\n```mermaid\nflowchart LR\n  A[Request] --> B[Process] --> C[Result]\n```\n\nInline $$E=mc^2$$ and a price of $5 and $10.\n\n\\[\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\\]'
  await emit(sessionId,
    { event: 'ModelRequestStarted', data: { request_number: 1, context_status: { estimated_input_tokens: 54100, effective_input_limit_tokens: 128000, usage_percent: 42.3, pressure: 'normal' } } },
    { event: 'AssistantTextDelta', data: { request_number: 1, text: content } })
  await expect(page.locator('.code-language')).toHaveText('mermaid')
  await expect(page.locator('.mermaid-diagram')).toHaveCount(0)
  expect(loaded.some(url => url.includes('mermaid.core'))).toBe(false)
  await emit(sessionId, { event: 'ModelRequestCompleted', data: { request_number: 1, output_text: content, usage: { input_tokens: 52800 } } },
    { event: 'TurnSettled', data: { status: 'idle' } })
  await expect(page.locator('.mermaid-diagram svg')).toBeVisible()
  expect(loaded.some(url => url.includes('mermaid.core'))).toBe(true)
  const diagram = page.getByRole('group', { name: 'Mermaid diagram' })
  const toolbar = diagram.locator('.code-block-header')
  await expect(toolbar).toHaveCSS('opacity', '0')
  await expect(diagram).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)')
  const restingBounds = await diagram.boundingBox()
  await page.screenshot({ path: test.info().outputPath('diagram-idle.png') })
  await diagram.hover()
  await expect(toolbar).toHaveCSS('opacity', '1')
  await expect(diagram).toHaveCSS('border-top-color', 'rgb(230, 230, 230)')
  expect(await diagram.boundingBox()).toEqual(restingBounds)
  await page.screenshot({ path: test.info().outputPath('diagram-hover.png') })
  await diagram.click()
  await page.mouse.move(10, 10)
  await expect(toolbar).toHaveCSS('opacity', '1')
  await page.locator('.composer textarea').focus()
  await expect(toolbar).toHaveCSS('opacity', '0')
  await diagram.focus()
  await expect(toolbar).toHaveCSS('opacity', '1')
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Diagram', exact: true })).toBeFocused()
  await page.locator('.composer textarea').focus()
  await expect(page.locator('.katex')).toHaveCount(2)
  await expect(page.locator('.katex-display')).toHaveCount(1)
  await expect(page.locator('.message-assistant')).toContainText('$5 and $10')
  await expect(page.getByRole('img', { name: 'Context 42% used' })).toBeVisible()
  await page.getByRole('img', { name: 'Context 42% used' }).hover()
  await expect(page.getByRole('tooltip')).toContainText('54.1k / 128k tokens (estimated)')
  await expect(page.getByRole('tooltip')).toContainText('Last request: 52.8k input tokens')
  await page.screenshot({ path: test.info().outputPath('diagrams-math-context.png') })
  await diagram.hover()
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
  await expect(page.locator('.mermaid-diagram')).toHaveCSS('transform', 'matrix(1.25, 0, 0, 1.25, 0, 0)')
  await page.getByRole('button', { name: 'Reset zoom' }).click()
  await page.getByRole('button', { name: 'Code', exact: true }).click()
  await expect(page.locator('.mermaid-block pre')).toContainText('flowchart LR')
  await page.getByRole('button', { name: 'Diagram', exact: true }).click()
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: async (text: string) => { (window as typeof window & { copiedDiagram: string }).copiedDiagram = text }
  } }))
  await page.getByRole('button', { name: 'Copy diagram code' }).click()
  expect(await page.evaluate(() => (window as typeof window & { copiedDiagram: string }).copiedDiagram)).toBe('flowchart LR\n  A[Request] --> B[Process] --> C[Result]')
  expect(await page.evaluate(() => (window as typeof window & { cspViolations: string[] }).cspViolations)).toEqual([])

  await emit(sessionId, { event: 'ModelRequestStarted', agent_id: 'worker', data: { context_status: { estimated_input_tokens: 990, effective_input_limit_tokens: 1000, usage_percent: 99, pressure: 'emergency' } } })
  await expect(page.getByRole('img', { name: 'Context 42% used' })).toBeVisible()
  await emit(sessionId, { event: 'ContextCompaction', data: { stage: 'started', before_tokens: 54100 } })
  await expect(page.getByRole('img', { name: 'Compacting context…' })).toBeVisible()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.locator('.context-meter svg')).toHaveCSS('animation-name', 'none')
  await emit(sessionId, { event: 'ContextCompaction', data: { stage: 'completed', after_tokens: 32000 } })
  await expect(page.getByRole('img', { name: 'Context 25% used' })).toBeVisible()
  await page.evaluate(({ sessionId, content }) => window.praxis.request('input.submit', { session_id: sessionId, test_history: [{ id: 'restored', role: 'assistant', status: 'complete', content }] }), { sessionId, content })
  await page.reload()
  await page.locator('.session-item').first().click()
  await expect(page.getByRole('img', { name: 'Context 25% used' })).toBeVisible()
  await expect(page.locator('.mermaid-diagram svg')).toBeVisible()
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(720, 800))
  await page.screenshot({ path: test.info().outputPath('diagrams-math-narrow.png') })
  expect(await page.locator('.composer').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.locator('.composer textarea').fill('/new')
  await page.locator('.composer textarea').press('Enter')
  await expect(page.locator('.context-meter')).toHaveCount(0)
})
