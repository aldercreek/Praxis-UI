import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Message } from './Transcript'
import { ToolMessage } from './ToolMessage'
import { FileNavigationContext, MarkdownContent } from './MarkdownContent'
import { PythonExecution } from './PythonExecution'
import { QuoteContext } from './QuoteContext'
import { cleanTableHtml, copyTable, tableSource } from './tableActions'
import { tableQuoteText } from './quote'
import { formatQuotedInput, readQuotedInput } from './quotedInput'
import type { DisplayMessage } from './state'

let root: Root
let container: HTMLDivElement
const writeText = vi.fn(async (_text: string) => {})
const addQuote = vi.fn()
const table = '| Name | Value |\n| --- | --- |\n| a\\|b | |\n| > quote | **text** |'
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  writeText.mockClear()
  addQuote.mockClear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals() })
const click = async (label: string) => act(async () => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click())

describe('table actions', () => {
  it('slices only the positioned source at the beginning, middle and end', () => {
    for (const source of [table, `${table}\n\nAfter`, `Before\n\n${table}`, `${table}\n\nBetween\n\n${table}`]) {
      const start = source.lastIndexOf(table)
      expect(tableSource(source, { start: { offset: start }, end: { offset: start + table.length } })).toBe(table)
    }
    expect(tableSource(table)).toBe('')
    expect(tableSource(table, { start: { offset: -1 }, end: { offset: 2 } })).toBe('')
  })
  it('keeps table rows, empty cells and pipes when sent as a quote', () => {
    expect(readQuotedInput(formatQuotedInput('Explain this', { text: tableQuoteText(table) }))).toEqual({ text: 'Explain this', quote: table })
  })
  it('copies sanitized rich HTML and falls back to Markdown when rich copy fails', async () => {
    container.innerHTML = '<table class="styled"><tbody><tr><td onclick="bad()"><strong>A</strong><button>Copy</button><script>bad()</script></td><td colspan="2">B</td></tr></tbody></table>'
    const node = container.querySelector('table')!
    expect(cleanTableHtml(node)).toBe('<table><tbody><tr><td>A</td><td colspan="2">B</td></tr></tbody></table>')
    const write = vi.fn(async (_items: unknown[]) => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write, writeText } })
    vi.stubGlobal('ClipboardItem', class { constructor(public data: Record<string, Blob>) {} })
    await copyTable(table, node)
    expect(write).toHaveBeenCalledOnce()
    const item = write.mock.calls[0][0][0] as { data: Record<string, Blob> }
    expect(Object.keys(item.data)).toEqual(['text/plain', 'text/html'])
    expect(item.data['text/plain'].size).toBe(new Blob([table]).size)
    expect(writeText).not.toHaveBeenCalled()
    write.mockRejectedValueOnce(new Error('Not available'))
    await copyTable(table, node)
    expect(writeText).toHaveBeenCalledWith(table)
  })
  it('uses the processed Markdown offsets and exposes quote only on settled main messages', async () => {
    const render = async (agent_id = 'main', status = 'complete', disabled = false) => act(async () => root.render(createElement(QuoteContext.Provider, { value: { addQuote, disabled } }, createElement(Message, {
      message: { id: 'answer', role: 'assistant', content: `\\[x^2\\]\n\n${table}\n\nEnd`, status, agent_id }
    }))))
    await render()
    await click('Copy table')
    expect(writeText).toHaveBeenCalledWith(table)
    await click('Quote table')
    expect(addQuote).toHaveBeenCalledWith({ text: table, messageId: 'answer' })
    await render('main', 'complete', true)
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Quote table"]')!.disabled).toBe(true)
    await render('worker')
    expect(container.querySelector('[title="Copy table"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Quote table"]')).toBeNull()
    await render('main', 'streaming')
    expect(container.querySelector('.table-actions')).toBeNull()
    await act(async () => root.render(createElement(MarkdownContent, { content: table })))
    expect(container.querySelector('.table-actions')).toBeNull()
  })
})

describe('user message actions', () => {
  it.each(['complete', 'queued', 'paused', 'not_sent'])('copies only the body of a %s user message', async status => {
    await act(async () => root.render(createElement(Message, { message: { id: status, role: 'user', agent_id: 'main', status, content: formatQuotedInput('My request', { text: table }) } })))
    await click('Copy message')
    expect(writeText).toHaveBeenCalledWith('My request')
  })
  it('copies unquoted text and omits child user controls', async () => {
    const message: DisplayMessage = { id: 'request', role: 'user', content: 'Original request' }
    await act(async () => root.render(createElement(Message, { message })))
    await click('Copy message')
    expect(writeText).toHaveBeenCalledWith(message.content)
    await act(async () => root.render(createElement(Message, { message: { ...message, agent_id: 'worker' } })))
    expect(container.querySelector('.message-actions')).toBeNull()
  })
})

describe('tool details', () => {
  it('separates Python source, streams and results while hiding runtime metadata', async () => {
    const openFile = vi.fn()
    const message: DisplayMessage = { id: 'python', role: 'tool', tool_name: 'run_code', status: 'complete', arguments: { code: 'print("Hello")\n42' }, content: JSON.stringify({ stdout: '\x1b[32mHello\x1b[0m', stderr: 'A warning', result: 42, state_lost: true, worker_created: true, output_files: { stdout: { path: 'C:/logs/output.log', complete: false }, stderr: { path: 'https://example.com/log' } } }) }
    await act(async () => root.render(createElement(FileNavigationContext.Provider, { value: { workspace: 'C:/work', openFile, onError: vi.fn() } }, createElement(PythonExecution, { message }))))
    expect(container.querySelector('[aria-label="Python code"]')!.textContent).toBe('print("Hello")\n42')
    expect(container.querySelector('[aria-label="Python output"]')!.textContent).toBe('Hello')
    expect(container.querySelector('[aria-label="Python error output"]')!.textContent).toBe('A warning')
    expect(container.querySelector('[aria-label="Python result"]')!.textContent).toBe('42')
    expect(container.textContent).not.toMatch(/state_lost|worker_created/)
    await click('Copy Python code')
    expect(writeText).toHaveBeenLastCalledWith('print("Hello")\n42')
    await click('Copy Python output')
    expect(writeText).toHaveBeenLastCalledWith('Hello\nA warning\n42')
    const links = container.querySelectorAll<HTMLButtonElement>('.tool-file-link')
    expect(links).toHaveLength(1)
    await act(async () => links[0].click())
    expect(openFile).toHaveBeenCalledWith('C:/logs/output.log')
    expect(container.textContent).toContain('Saved log is truncated')
  })
  it.each([0, false])('preserves a Python result of %s', async result => {
    await act(async () => root.render(createElement(PythonExecution, { message: { id: 'python', role: 'tool', tool_name: 'run_code', content: JSON.stringify({ result }), status: 'complete' } })))
    expect(container.querySelector('[aria-label="Python result"]')!.textContent).toBe(String(result))
  })
  it('shows Python exceptions and plain-text tool errors but suppresses cancellation tracebacks', async () => {
    const render = async (content: string) => act(async () => root.render(createElement(ToolMessage, { message: { id: 'python', role: 'tool', tool_name: 'run_code', content, status: 'failed', tool_finished: true } })))
    await render(JSON.stringify({ error: 'ValueError: invalid input', error_kind: 'runtime', state_lost: false }))
    expect(container.querySelector('[aria-label="Python error"]')!.textContent).toBe('ValueError: invalid input')
    expect(container.querySelector('.tool-message')!.getAttribute('data-status')).toBe('failed')
    await render(JSON.stringify({ error: 'ExecutionStopped: cancelled', error_kind: 'cancelled', state_lost: true }))
    expect(container.querySelector('.tool-message')!.getAttribute('data-status')).toBe('cancelled')
    expect(container.textContent).toContain('Execution stopped')
    expect(container.textContent).not.toMatch(/ExecutionStopped|state_lost/)
    await render('Legacy Python failure')
    expect(container.textContent).toContain('Legacy Python failure')
  })
  it('copies a command and clean output and presents its exit code', async () => {
    await act(async () => root.render(createElement(ToolMessage, { message: { id: 'cmd', role: 'tool', tool_name: 'run_command', content: '', output: '\x1b[32mDone\x1b[0m', arguments: { command: 'npm test' }, status: 'complete', tool_finished: true, structured_output: { exit_code: 0 } } })))
    await click('Copy command')
    expect(writeText).toHaveBeenLastCalledWith('npm test')
    await click('Copy output')
    expect(writeText).toHaveBeenLastCalledWith('Done')
    expect(container.querySelector('.terminal-output')!.textContent).toBe('Done')
    expect(container.querySelector('.command-outcome')!.textContent).toBe('Exit code 0')
  })
  it('counts streamed write lines, uses final stats and suppresses failed writes', async () => {
    const message: DisplayMessage = { id: 'write', role: 'tool', content: '', tool_name: 'write_file', arguments: { relative_path: 'a.txt', content: 'one\ntwo\n' }, status: 'running', tool_finished: false }
    const render = async (patch: Partial<DisplayMessage>) => act(async () => root.render(createElement(ToolMessage, { message: { ...message, ...patch } })))
    await render({})
    expect(container.querySelector('.file-stats')!.textContent).toBe('+3')
    await render({ status: 'complete', tool_finished: true, file_change: { path: 'a.txt', diff: '+one', added: 2, removed: 1 } })
    expect(container.querySelector('.file-stats')!.textContent).toBe('+2−1')
    for (const status of ['failed', 'cancelled', 'denied']) {
      await render({ status, tool_finished: true })
      expect(container.querySelector('.file-stats')).toBeNull()
    }
  })
})
