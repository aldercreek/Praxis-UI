import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MarkdownContent } from './MarkdownContent'

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
