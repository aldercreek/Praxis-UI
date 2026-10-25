import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FileNavigationContext, MarkdownContent } from './MarkdownContent'

function render(content: string, options: Partial<Parameters<typeof MarkdownContent>[0]> = {}): string {
  return renderToStaticMarkup(createElement(FileNavigationContext.Provider, {
    value: { workspace: '/project', openFile: () => {}, onError: () => {} },
    children: createElement(MarkdownContent, { content, ...options })
  }))
}

describe('file references in Markdown', () => {
  it('collects consecutive file-only paragraphs and reference links without losing their descriptions', () => {
    const html = render('[**项目说明**](docs/brief.md) · [报告][report]\n\n[图片](images/chart.png)\n\n[report]: files/report.pdf')
    expect(html.match(/class="file-reference-group"/g)).toHaveLength(1)
    expect(html.match(/class="file-reference-row"/g)).toHaveLength(3)
    for (const content of ['brief.md', '<strong>项目说明</strong>', 'report.pdf', '报告', 'chart.png', '图片']) expect(html).toContain(content)
    expect(html.replace(/<[^>]+>/g, '')).not.toContain(' · ')
  })

  it('keeps prose, code, headings and ordinary web links in the text flow', () => {
    const html = render('请先读[项目说明](docs/brief.md)，然后查看[官方文档](https://example.com/docs)。\n\n`[代码里的链接](a.ts)`\n\n## [标题](heading.md)')
    expect(html).not.toContain('file-reference-group')
    expect(html).toContain('请先读')
    expect(html).toContain('，然后查看')
    expect(html).toContain('href="https://example.com/docs">官方文档</a>')
    expect(html).toContain('<code>[代码里的链接](a.ts)</code>')
    expect(html).toContain('<h2>')
    expect(html).toContain('aria-label="brief.md · 项目说明"')
  })

  it('uses file rows for simple bullet lists while preserving numbered steps and checklists', () => {
    expect(render('- [说明](brief.md)\n- [报告](report.pdf)')).toContain('file-reference-group')
    for (const content of ['1. [说明](brief.md)\n2. [报告](report.pdf)', '- [ ] [说明](brief.md)\n- [x] [报告](report.pdf)', '- [说明](brief.md)：先检查这一项\n- [报告](report.pdf)', '- [源文件](src/a.ts)、[对应测试](test/a.ts)\n- [另一个源文件](src/b.ts)、[对应测试](test/b.ts)']) {
      expect(render(content)).not.toContain('file-reference-group')
    }
  })

  it('does not group mixed web links or turn linked images into file labels', () => {
    expect(render('[说明](brief.md) · [网站](https://example.com)')).not.toContain('file-reference-group')
    for (const content of ['[![图表](chart.png)](report.pdf)', '[**![图表](chart.png)**](report.pdf) · [说明](brief.md)']) {
      expect(render(content)).not.toContain('file-reference-group')
      expect(render(content)).toContain('content-image')
    }
    expect(render('[说明](brief.md) · [不安全](javascript:alert)')).not.toContain('file-reference-group')
  })

  it('shows decoded filenames and keeps original labels available for inline references', () => {
    const html = render('阅读[项目报告](<file:///D:/work/%E9%A1%B9%E7%9B%AE%20%E6%8A%A5%E5%91%8A.md>)，并检查[配置](<src/settings.ts:20>)。')
    expect(html).toContain('项目 报告.md')
    expect(html).toContain('aria-label="项目 报告.md · 项目报告"')
    expect(html).toContain('settings.ts:20')
    expect(html).toContain('class="file-reference-suffix">.ts:20</span>')
  })

  it('preserves document Markdown and source labels inside the file preview', () => {
    const html = render('[项目说明](brief.md) · [报告](report.pdf)', { decorateFiles: false })
    expect(html).not.toContain('file-reference-')
    expect(html).toContain('<a href="brief.md">项目说明</a> · <a href="report.pdf">报告</a>')
  })

  it('waits for a finished response before regrouping streamed file links', () => {
    const content = '[说明](brief.md) · [报告](report.pdf)'
    expect(render(content, { streaming: true })).not.toContain('file-reference-group')
    expect(render(content, { streaming: true }).match(/class="file-reference-inline"/g)).toHaveLength(2)
    expect(render(content, { streaming: false })).toContain('file-reference-group')
  })

  it('keeps child relative references noninteractive without blocking absolute references', () => {
    const html = render('[子任务文件](a.ts) · [绝对路径](/project/worker/b.ts)', { allowRelativeFiles: false })
    expect(html).toContain('aria-disabled="true"')
    expect(html).not.toContain('href="a.ts"')
    expect(html).toContain('href="/project/worker/b.ts"')
    expect(html).toContain('子任务文件')
  })
})
