import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
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
  await mkdir(join(workspace, 'assets'), { recursive: true })
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ workspace }))
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    PRAXIS_DATA_DIR: join(profile, 'service'), PRAXIS_UI_DATA_DIR: profile, PRAXIS_UI_TEST_MODE: '1',
    PRAXIS_UI_TEST_SERVER: resolve('tests/fixtures/ui-server.cjs'), PRAXIS_UI_TEST_CONTROLLED_INPUT: '1'
  }
  delete env.ELECTRON_RUN_AS_NODE
  application = await electron.launch({ args: [resolve('.')], env })
  page = await application.firstWindow()
  errors.length = 0
  page.on('pageerror', error => errors.push(error.message))
  await expect.poll(() => page.evaluate(async () => (await window.praxis.getInfo()).connection.state)).toBe('connected')
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 1200
    canvas.height = 800
    const context = canvas.getContext('2d')!
    context.fillStyle = '#eff5f3'
    context.fillRect(0, 0, 1200, 800)
    context.fillStyle = '#306953'
    context.fillRect(120, 120, 960, 560)
    context.fillStyle = '#ffffff'
    context.font = '48px sans-serif'
    context.fillText('Praxis image preview', 200, 400)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  await writeFile(join(workspace, 'sample.png'), Buffer.from(png, 'base64'))
})

test.afterEach(async () => {
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
  return page.evaluate(async () => (await window.praxis.request<{ sessions: { id: string }[] }>('session.list')).sessions[0].id)
}

async function emit(id: string, ...events: { event: string; data?: Record<string, unknown> }[]) {
  await page.evaluate(({ id, events }) => window.praxis.request('input.submit', { session_id: id, test_events: events }), { id, events })
}

async function answer(id: string, text: string) {
  await emit(id, { event: 'AssistantTextCompleted', data: { text } }, { event: 'TurnSettled', data: { status: 'idle' } })
}

async function paint() {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

test('table actions and user copy preserve source and spacing in compact windows', async () => {
  const id = await start('Inspect this table')
  const table = '| File | State |\n| --- | --- |\n| first | Ready |\n| second | |'
  await emit(id, { event: 'AssistantTextDelta', data: { request_number: 1, text: table } })
  await expect(page.locator('table')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Copy table' })).toHaveCount(0)
  await answer(id, table)
  const actions = page.locator('.table-actions')
  await expect(actions).toHaveCSS('opacity', '0')
  const before = await page.locator('.markdown-table').boundingBox()
  await page.locator('table').hover()
  await expect(actions).toHaveCSS('opacity', '1')
  expect(await page.locator('.markdown-table').boundingBox()).toEqual(before)
  await page.getByRole('button', { name: 'Quote table' }).click()
  await expect(page.locator('.quote-draft blockquote')).toHaveText(table)
  await page.locator('.composer textarea').fill('Explain the empty cell')
  await page.locator('.composer textarea').press('Enter')
  await expect(page.locator('.message-user').last()).toContainText('Explain the empty cell')
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { document.body.dataset.copied = text } } })
  })
  const user = page.locator('.message-user').last()
  await user.hover()
  await user.getByRole('button', { name: 'Copy message' }).click()
  await expect(page.locator('body')).toHaveAttribute('data-copied', 'Explain the empty cell')
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 680))
  const geometry = await user.evaluate(node => {
    const article = node.getBoundingClientRect()
    const actions = node.querySelector('.message-actions')!.getBoundingClientRect()
    return { gap: Math.abs(actions.top - article.bottom), right: actions.right, width: innerWidth, font: getComputedStyle(node).fontSize }
  })
  expect(geometry.gap).toBeLessThan(1)
  expect(geometry.right).toBeLessThanOrEqual(geometry.width)
  await page.locator('table').hover()
  await page.screenshot({ path: test.info().outputPath('table-actions-compact.png') })
})

test('HTML preview loads local styles and scripts while blocking network, bridge and navigation', async () => {
  await writeFile(join(workspace, 'assets/style.css'), 'body{font:16px system-ui;margin:24px;background:#f6f8f7}h1{color:rgb(32,96,64)}img{width:100%;max-width:320px}')
  await writeFile(join(workspace, 'assets/app.js'), "document.documentElement.dataset.script = 'loaded'")
  await writeFile(join(workspace, 'preview.html'), `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="assets/style.css"><script src="assets/app.js" defer></script><h1>Local preview</h1><img src="sample.png"><p>Workspace styles, images and scripts.</p><a id="leave" href="https://example.com">External link</a><script>
document.documentElement.dataset.bridge = typeof window.praxis;
document.documentElement.dataset.node = typeof require;
fetch('https://example.com').then(() => document.documentElement.dataset.fetch = 'allowed').catch(() => document.documentElement.dataset.fetch = 'blocked');
try { top.location = 'https://example.com' } catch { document.documentElement.dataset.top = 'blocked' }
try { parent.praxis.getInfo() } catch { document.documentElement.dataset.parent = 'blocked' }
</script>`)
  const outbound: string[] = []
  await page.route('https://**/*', route => { outbound.push(route.request().url()); return route.abort() })
  const id = await start('Preview the HTML report')
  await answer(id, '[Open HTML](preview.html)')
  await page.locator('a[href="preview.html"]').click()
  const frame = page.frameLocator('.file-html')
  await expect(frame.locator('h1')).toHaveText('Local preview')
  await expect(frame.locator('h1')).toHaveCSS('color', 'rgb(32, 96, 64)')
  await expect(frame.locator('html')).toHaveAttribute('data-script', 'loaded')
  await expect(frame.locator('html')).toHaveAttribute('data-fetch', 'blocked')
  await expect(frame.locator('html')).toHaveAttribute('data-bridge', 'undefined')
  await expect(frame.locator('html')).toHaveAttribute('data-node', 'undefined')
  await expect(frame.locator('html')).toHaveAttribute('data-parent', 'blocked')
  await expect(frame.locator('html')).toHaveAttribute('data-top', 'blocked')
  expect(await frame.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(1200)
  expect(outbound).toEqual([])
  await paint()
  await page.screenshot({ path: test.info().outputPath('html-preview.png') })
  const url = page.url()
  await frame.locator('#leave').click()
  await paint()
  await expect(frame.locator('h1')).toHaveText('Local preview')
  expect(page.url()).toBe(url)
  expect(outbound).toEqual([])
  expect(await application.windows()).toHaveLength(1)
  await page.getByRole('button', { name: 'Source', exact: true }).click()
  await expect(page.locator('.file-text')).toContainText('<h1>Local preview</h1>')
  await page.getByRole('button', { name: 'Preview', exact: true }).click()
  await writeFile(join(workspace, 'preview.html'), '<h1>Refreshed preview</h1>')
  await page.getByRole('button', { name: 'Refresh file' }).click()
  await expect(frame.locator('h1')).toHaveText('Refreshed preview')
})

test('image links preview on hover and lightboxes zoom, pan, restore focus and open the panel', async () => {
  const id = await start('Inspect the image')
  await answer(id, '![Architecture](sample.png)\n\nSee [Preview](sample.png) for details.\n\n[Image file](sample.png)')
  const thumbnail = page.getByRole('button', { name: 'View image: Architecture' })
  await expect(thumbnail.locator('img')).toBeVisible()
  const inline = page.locator('.file-reference-inline')
  await inline.hover()
  await expect(page.locator('.image-preview-tooltip img')).toBeVisible()
  await expect(page.getByRole('tooltip')).toHaveCount(1)
  await paint()
  await expect(page.locator('.image-preview-tooltip img')).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('image-hover.png') })
  await thumbnail.click()
  const modal = page.getByRole('dialog', { name: 'Image: Architecture', exact: true })
  await expect(modal).toBeVisible()
  const image = modal.locator('img')
  await expect.poll(async () => Number(await image.getAttribute('data-zoom'))).toBeLessThan(1)
  await image.dblclick()
  await expect(image).toHaveAttribute('data-zoom', '1')
  await modal.getByRole('button', { name: 'Zoom in' }).click()
  await expect(image).toHaveAttribute('data-zoom', '1.25')
  const bounds = (await image.boundingBox())!
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await page.mouse.down()
  await page.mouse.move(bounds.x + bounds.width / 2 + 80, bounds.y + bounds.height / 2 + 30)
  await page.mouse.up()
  expect(await image.evaluate(node => (node as HTMLElement).style.transform)).not.toContain('translate(0px, 0px)')
  await page.screenshot({ path: test.info().outputPath('image-lightbox.png') })
  await page.keyboard.press('Escape')
  await expect(modal).toHaveCount(0)
  await expect(thumbnail).toBeFocused()
  await thumbnail.click()
  await modal.getByRole('button', { name: 'Open in panel' }).click()
  await expect(modal).toHaveCount(0)
  const panelImage = page.locator('.file-image-button')
  await expect(panelImage).toBeVisible()
  await panelImage.click()
  await expect(page.getByRole('dialog', { name: 'Image: sample.png', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(panelImage).toBeFocused()
  await expect(page.locator('.praxis-file-panel')).toBeVisible()
})

test('command cards copy clean output, show exit status and count lines while writing', async () => {
  const id = await start('Run checks and write a file')
  await emit(id,
    { event: 'ToolCallPrepared', data: { call_id: 'cmd', tool_name: 'run_command', arguments: { command: 'npm test' } } },
    { event: 'ToolStarted', data: { call_id: 'cmd', tool_name: 'run_command' } },
    { event: 'ToolOutputDelta', data: { call_id: 'cmd', tool_name: 'run_command', text: '\x1b[32mChecking\x1b[0m\rAll checks passed\n' } }
  )
  const command = page.locator('.tool-message').first()
  await command.locator(':scope > summary').press('Enter')
  await expect(command).toHaveJSProperty('open', true)
  await expect(command.locator('.terminal-output')).toHaveText('All checks passed')
  await expect(command.getByRole('button', { name: 'Copy command' })).toBeVisible()
  await expect(command.getByRole('button', { name: 'Copy output' })).toBeVisible()
  await emit(id, { event: 'ToolFinished', data: { call_id: 'cmd', tool_name: 'run_command', result: { success: true, output: 'Complete', structured_output: { exit_code: 0 } } } })
  await expect(command.locator('.command-outcome')).toHaveText('Exit code 0')
  await emit(id,
    { event: 'ToolCallPrepared', data: { call_id: 'write', tool_name: 'write_file', arguments: { relative_path: 'notes.txt', content: 'first\nsecond\nthird' } } },
    { event: 'ToolStarted', data: { call_id: 'write', tool_name: 'write_file' } }
  )
  const writing = page.locator('.tool-message').last()
  await expect(writing.locator('.file-stats .added')).toHaveText('+3')
  await emit(id, { event: 'ToolFinished', data: { call_id: 'write', tool_name: 'write_file', result: { success: true, output: 'Written', file_change: { path: 'notes.txt', diff: '-old\n+first\n+second', added: 2, removed: 1 } } } })
  await expect(writing.locator('.file-stats')).toHaveText('+2−1')
  await page.screenshot({ path: test.info().outputPath('command-output.png') })
})
