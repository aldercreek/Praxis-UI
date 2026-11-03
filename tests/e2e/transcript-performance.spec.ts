import { test, expect, _electron as electron } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { stopFixtureService } from './service-fixture'

test('measures a 200-turn transcript during loading, streaming and scrolling', async ({}, testInfo) => {
  test.skip(!process.env.PRAXIS_PERF_PHASE, 'Set PRAXIS_PERF_PHASE to record a performance sample')
  test.setTimeout(180_000)
  await mkdir(testInfo.outputDir, { recursive: true })
  const profile = await mkdtemp(join(testInfo.outputDir, 'profile-'))
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    PRAXIS_DATA_DIR: join(profile, 'service'), PRAXIS_UI_DATA_DIR: profile, PRAXIS_UI_TEST_MODE: '1',
    PRAXIS_UI_TEST_SERVER: resolve('tests/fixtures/ui-server.cjs'), PRAXIS_UI_TEST_CONTROLLED_INPUT: '1'
  }
  delete env.ELECTRON_RUN_AS_NODE
  const application = await electron.launch({ args: [resolve('.'), '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'], env })
  try {
    const page = await application.firstWindow()
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.webContents.setBackgroundThrottling(false)
      window.showInactive()
    })
    await expect.poll(() => page.evaluate(async () => (await window.praxis.getInfo()).connection.state)).toBe('connected')
    await page.locator('.composer textarea').fill('Transcript performance sample')
    await page.locator('.composer textarea').press('Enter')
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
    const sessionId = await page.evaluate(async () => {
      const { sessions } = await window.praxis.request<{ sessions: { id: string }[] }>('session.list')
      const sessionId = sessions[0].id
      const history = Array.from({ length: 200 }, (_, index) => [
        { id: `user-${index}`, role: 'user', content: `Question ${index + 1}: inspect this implementation`, turn_id: `history-${index}`, agent_id: 'main', status: 'complete' },
        ...Array.from({ length: 10 }, (_, tool) => ({ id: `tool-${index}-${tool}`, role: 'tool', tool_name: 'read_file', call_id: `call-${index}-${tool}`, content: 'Source contents '.repeat(30), arguments: { relative_path: `src/module-${tool}.ts` }, turn_id: `history-${index}`, agent_id: 'main', status: 'complete', tool_finished: true })),
        { id: `assistant-${index}`, role: 'assistant', content: `## Result ${index + 1}\n\n` + 'The implementation keeps stable message identities while preserving navigation and readable output. '.repeat(18) + '\n\n```ts\nconst result = inspect(input)\n```', turn_id: `history-${index}`, agent_id: 'main', status: 'complete' }
      ]).flat()
      await window.praxis.request('input.submit', { session_id: sessionId, test_history: history })
      return sessionId
    })
    await page.reload()
    await expect(page.locator('.session-item')).toHaveCount(1)
    const start = Date.now()
    await page.locator('.session-item').click()
    await expect(page.locator('.transcript-turn')).toHaveCount(200, { timeout: 60_000 })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const openMs = Date.now() - start
    await page.locator('.composer textarea').fill('Continue the performance sample')
    await page.locator('.composer textarea').press('Enter')
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
    const streaming = await page.evaluate(async sessionId => {
      const frames: number[] = []
      let active = true
      let previous = performance.now()
      const measure = (now: number) => { frames.push(now - previous); previous = now; if (active) requestAnimationFrame(measure) }
      requestAnimationFrame(measure)
      for (let index = 0; index < 90; index += 1) {
        await window.praxis.request('input.submit', { session_id: sessionId, test_events: [{ event: 'AssistantTextDelta', data: { request_number: 1, text: `Streaming update ${index}. ` } }] })
        await new Promise(resolve => setTimeout(resolve, 16))
      }
      active = false
      return frames
    }, sessionId)
    const scrolling = await page.evaluate(async () => {
      const container = document.querySelector<HTMLElement>('.transcript')!
      container.scrollTop = 0
      const frames: number[] = []
      let previous = performance.now()
      for (let index = 0; index < 120; index += 1) {
        await new Promise<void>(resolve => requestAnimationFrame(now => {
          frames.push(now - previous)
          previous = now
          container.scrollTop = (container.scrollHeight - container.clientHeight) * (index + 1) / 120
          resolve()
        }))
      }
      return frames
    })
    const summarize = (frames: number[]) => {
      const sorted = [...frames].sort((a, b) => a - b)
      return { frames: frames.length, medianMs: sorted[Math.floor(sorted.length * .5)], p95Ms: sorted[Math.floor(sorted.length * .95)], maxMs: Math.max(...frames), over32Ms: frames.filter(value => value > 32).length }
    }
    const result = { phase: process.env.PRAXIS_PERF_PHASE, turns: 200, tools: 2000, openMs, streaming: summarize(streaming), scrolling: summarize(scrolling) }
    await writeFile(testInfo.outputPath('performance.json'), JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result))
    if (process.env.PRAXIS_PERF_PHASE === 'after') {
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide())
      expect(await page.locator('.transcript-turn').evaluateAll(turns => turns.slice(-3).every(turn => getComputedStyle(turn).contentVisibility === 'visible'))).toBe(true)
      const ticks = page.locator('.conversation-tick')
      await ticks.nth(99).click()
      await expect.poll(() => page.locator('[data-nav-message-id="user-99"]').evaluate(element => Math.abs(element.getBoundingClientRect().top - document.querySelector('.transcript')!.getBoundingClientRect().top - 20)), { timeout: 10_000 }).toBeLessThan(4)
      await ticks.first().click()
      await expect.poll(() => page.locator('.transcript').evaluate(element => element.scrollTop), { timeout: 10_000 }).toBeLessThan(30)
      await expect(page.locator('.transcript-turn')).toHaveCount(201)
    }
  } finally {
    await stopFixtureService(join(profile, 'service'))
    await application.close()
    expect(resolve(profile).startsWith(resolve(testInfo.outputDir))).toBe(true)
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
