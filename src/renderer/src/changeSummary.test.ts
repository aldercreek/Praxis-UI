import { describe, expect, it } from 'vitest'
import { collectTurnChanges, fileChangePreviewPath } from './changeSummary'
import { contentLink, safeContentUrl } from './fileLinks'
import { formatQuotedInput, readQuotedInput } from './quotedInput'
import type { DisplayMessage } from './state'

const edit = (id: string, path: string, turn_id = 'turn-1', diff = '-before\n+after'): DisplayMessage => ({ id, role: 'tool', content: '', turn_id, file_change: { path, diff, added: 1, removed: 1 }, tool_finished: true })

describe('turn changes', () => {
  it('groups repeat edits to a file while retaining their order and exact diffs', () => {
    const changes = collectTurnChanges([edit('a', 'src/app.ts'), edit('b', 'D:\\project\\src\\app.ts', 'turn-1', '-after\n+final'), edit('c', 'src/other.ts')], 'D:\\project')
    expect(changes[0].files).toHaveLength(2)
    expect(changes[0].files[0].edits.map(edit => edit.diff)).toEqual(['-before\n+after', '-after\n+final'])
  })
  it('keeps separate turns and child changes attributed to their parent turn', () => {
    const changes = collectTurnChanges([edit('a', 'a.ts'), { ...edit('b', 'b.ts'), agent_id: 'reviewer', child_turn_id: 'child-turn' }, edit('c', 'a.ts', 'turn-2')], '/project')
    expect(changes.map(turn => [turn.turnId, turn.files.length])).toEqual([['turn-1', 2], ['turn-2', 1]])
  })
  it('does not infer changes from tool arguments or count unfinished/duplicate records', () => {
    const a = edit('a', 'a.ts')
    expect(collectTurnChanges([a, a, { ...edit('b', 'b.ts'), tool_finished: false }, { id: 'c', role: 'tool', content: '', turn_id: 'turn-1', tool_name: 'edit_file', arguments: { path: 'c.ts' } }], '/project')[0].files).toHaveLength(1)
  })
  it('does not merge or open relative child paths against the parent workspace', () => {
    const root = edit('root', 'a.ts')
    const child = { ...edit('child', 'a.ts'), agent_id: 'worker', child_turn_id: 'child-turn' }
    const absoluteChild = { ...edit('absolute-child', '/project/worker/a.ts'), agent_id: 'worker' }
    const files = collectTurnChanges([root, child, absoluteChild], '/project')[0].files
    expect(files).toHaveLength(3)
    expect(new Set(files.map(file => file.id)).size).toBe(3)
    expect(files[1].previewPath).toBeUndefined()
    expect(files[1].source).toBe('worker')
    expect(fileChangePreviewPath(child)).toBeUndefined()
    expect(fileChangePreviewPath(absoluteChild)).toBe('/project/worker/a.ts')
    expect(files[0].previewPath).toBe('a.ts')
  })
})

describe('local content links', () => {
  it('allows Windows/relative/file URLs and line references without accepting active schemes', () => {
    for (const path of ['C:\\work\\输出 #1.md', '/C:/work/file.md', 'file:///C:/work/file.md', 'docs/a.md', 'source.ts:20', 'src/a.ts:20:3']) expect(contentLink(path)?.kind).toBe('file')
    for (const path of ['javascript:alert(1)', 'javascript:20', 'data:text/html,test', 'vscode:open', '\\\\server\\file.md', '//server/file.md']) expect(safeContentUrl(path)).toBe('')
  })
  it('resolves preview document links relative to their source and leaves URLs intact', () => {
    expect(contentLink('../notes.md', 'D:/work/docs/readme.md')).toEqual({ kind: 'file', path: 'D:/work/docs/../notes.md' })
    expect(contentLink('https://example.com/a', 'D:/work/docs/readme.md')).toEqual({ kind: 'external', url: 'https://example.com/a' })
  })
})

it('quotes retain multiline source and the user request through a text-only protocol', () => {
  const text = '只调整这段的措辞'
  const quote = { text: '第一段\n\n> 原文中的引用\n第三段' }
  const payload = formatQuotedInput(text, quote)
  expect(payload.startsWith('Quoted response:\n')).toBe(true)
  expect(readQuotedInput(payload)).toEqual({ text, quote: quote.text })
  expect(readQuotedInput(payload.replace('Quoted response:\n', '引用助手回复：\n'))).toEqual({ text, quote: quote.text })
  expect(formatQuotedInput(text)).toBe(text)
  expect(readQuotedInput('普通消息')).toBeUndefined()
})
