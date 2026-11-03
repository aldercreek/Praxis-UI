import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { MarkdownContent, normalizeMath } from './MarkdownContent'
import { diagramMarkup } from './mermaidDiagram'

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }))
vi.mock('mermaid', () => ({ default: mermaid }))

const render = (content: string, streaming = false) => renderToStaticMarkup(createElement(MarkdownContent, { content, streaming }))

describe('markdown content', () => {
  it('frames code with its language, a visible copy action and syntax colors', () => {
    const html = render('```ts\nconst key = buildKey(request)\n```')
    expect(html).toContain('<div class="code-block-header"><span class="code-language">ts</span>')
    expect(html).toContain('aria-label="Copy code"')
    expect(html).toContain('hljs-keyword')
    expect(render('```\nplain text\n```')).toContain('<span class="code-language"></span>')
    expect(render('```unknown-language\nvalue\n```')).toContain('value')
  })

  it('wraps tables in a scrolling frame and keeps task items as checkboxes', () => {
    expect(render('| a | b |\n| --- | --- |\n| 1 | 2 |')).toMatch(/<div class="table-wrap"><table>/)
    const tasks = render('- [x] done\n- [ ] next')
    expect(tasks).toContain('task-list-item')
    expect(tasks.match(/type="checkbox"/g)).toHaveLength(2)
  })

  it('closes half-written markers only while streaming', () => {
    expect(render('原因是 **租户', true)).toContain('<strong>租户</strong>')
    expect(render('原因是 **租户')).not.toContain('<strong>')
    const link = render('详见 [设计文档](https://exa', true)
    expect(link).toContain('设计文档')
    expect(link).not.toContain('https://exa')
    expect(link).not.toContain('[')
  })
})

describe('mathematical markdown', () => {
  it('renders double-dollar inline and display math while retaining currency', () => {
    expect(render('Value $$x^2$$.')).toContain('class="katex"')
    expect(render('Value $$x^2$$.')).not.toContain('katex-display')
    expect(render('$$\nx^2\n$$')).toContain('katex-display')
    expect(render('$5 and $10')).toContain('$5 and $10')
    expect(render('$5 and $10')).not.toContain('class="katex"')
  })

  it('converts LaTeX delimiters while skipping code and escaped openings', () => {
    expect(normalizeMath(String.raw`\(a\)`)).toBe('$$a$$')
    expect(normalizeMath(String.raw`\[b\]`)).toBe('\n$$\nb\n$$\n')
    for (const source of ['```tex\n\\[x\\]\n$$x$$\n```', '~~~tex\n\\(x\\)\n~~~', '`\\(a\\)`', '`` `\\[b\\]` ``', String.raw`\\[x\\]`]) {
      expect(normalizeMath(source)).toBe(source)
      expect(render(source)).not.toContain('class="katex"')
    }
    expect(render(String.raw`\(a\) and \[b\]`)).toContain('class="katex"')
    expect(render(String.raw`\(a\) and \[b\]`)).toContain('katex-display')
  })

  it('keeps malformed math readable and completes streaming dollar delimiters', () => {
    expect(() => render('$$\\notACommand{x}$$')).not.toThrow()
    expect(render('$$\\notACommand{x}$$')).toContain('color:var(--error)')
    expect(render('$$\nx + 1', true)).toContain('katex-display')
    expect(render('$$x^2', true)).toContain('class="katex"')
    expect(render('```text\n$$x^2', true)).not.toContain('class="katex"')
    expect(render(String.raw`\[x\]`, true)).toContain('katex-display')
    expect(render('$$\\text{src/app.ts}$$')).not.toContain('file-reference')
  })
})

describe('Mermaid rendering', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    mermaid.render.mockReset().mockResolvedValue({ svg: '<svg xmlns="http://www.w3.org/2000/svg" id="diagram" viewBox="0 0 240 120"><defs><marker id="arrow" /></defs><path marker-end="url(#arrow)" /><text>Rendered diagram</text></svg>' })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('defers rendering until streaming finishes, then offers diagram controls', async () => {
    const content = '```mermaid\ngraph TD; Streaming-->Done\n```'
    await act(async () => root.render(createElement(MarkdownContent, { content, streaming: true })))
    expect(mermaid.render).not.toHaveBeenCalled()
    expect(container.querySelector('pre')?.textContent).toContain('Streaming-->Done')
    await act(async () => root.render(createElement(MarkdownContent, { content })))
    await vi.waitFor(() => expect(container.querySelector('.mermaid-diagram svg')).not.toBeNull())
    expect(mermaid.render).toHaveBeenCalledTimes(1)
    expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: 'strict', startOnLoad: false }))
    await act(async () => (container.querySelector('[aria-label="Zoom in"]') as HTMLButtonElement).click())
    expect((container.querySelector('.mermaid-diagram') as HTMLElement).style.transform).toBe('scale(1.25)')
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Code')!.click())
    expect(container.querySelector('pre')?.textContent).toContain('Streaming-->Done')
  })

  it('falls back to code if Mermaid rejects a diagram', async () => {
    mermaid.render.mockRejectedValueOnce(new Error('Invalid syntax'))
    await act(async () => root.render(createElement(MarkdownContent, { content: '```mermaid\ninvalid syntax\n```' })))
    await vi.waitFor(() => expect(container.textContent).toContain('Unable to render diagram'))
    expect(container.querySelector('pre')?.textContent).toContain('invalid syntax')
    expect(container.querySelector('.mermaid-diagram')).toBeNull()
  })

  it('reuses a cached SVG without duplicate IDs across diagrams', async () => {
    const content = '```mermaid\ngraph TD; Cache-->Reuse\n```'
    await act(async () => root.render(createElement('div', null, createElement(MarkdownContent, { content }), createElement(MarkdownContent, { content }))))
    await vi.waitFor(() => expect(container.querySelectorAll('.mermaid-diagram svg')).toHaveLength(2))
    expect(mermaid.render).toHaveBeenCalledTimes(1)
    const ids = [...container.querySelectorAll('[id]')].map(element => element.id)
    expect(new Set(ids).size).toBe(ids.length)
    const svg = diagramMarkup('<svg xmlns="http://www.w3.org/2000/svg" id="chart"><style>#chart .line{fill:red}</style><path id="line" /><use href="#line" aria-labelledby="line" /></svg>', 'unique')
    expect(svg).toContain('#unique-0 .line')
    expect(svg).toContain('href="#unique-1"')
    expect(svg).toContain('aria-labelledby="unique-1"')
  })
})
