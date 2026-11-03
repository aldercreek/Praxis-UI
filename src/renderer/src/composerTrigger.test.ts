import { describe, expect, it } from 'vitest'
import { applyFileMention, detectTrigger } from './composerTrigger'

describe('composer triggers', () => {
  it.each(['@', 'read @', 'read\n@', 'read\t@'])('opens files after whitespace in %j', text => {
    expect(detectTrigger(text, text.length)).toEqual({ kind: 'file', query: '', start: text.length - 1 })
  })

  it.each(['a@b', '@two words', 'read /new', '/new ', ' /', '@a@b'])('does not open for %j', text => {
    expect(detectTrigger(text, text.length)).toBeUndefined()
  })

  it('uses the query before the caret and supports Chinese', () => {
    expect(detectTrigger('查看 @源代码 后续', 7)).toEqual({ kind: 'file', query: '源代码', start: 3 })
    expect(detectTrigger('/settings', 4)).toEqual({ kind: 'command', query: 'set', start: 0 })
    expect(detectTrigger('/', 1)).toEqual({ kind: 'command', query: '', start: 0 })
    expect(detectTrigger('hello', -1)).toBeUndefined()
    expect(detectTrigger('@', 2)).toBeUndefined()
  })

  it('replaces only the mention and restores the caret after the trailing space', () => {
    const text = '查看 @源 后续'
    const next = applyFileMention(text, detectTrigger(text, 5)!, 5, 'src\\源代码.ts')
    expect(next.text).toBe('查看 @src/源代码.ts  后续')
    expect(next.caret).toBe('查看 @src/源代码.ts '.length)
  })

  it('counts UTF-16 caret positions correctly for emoji filenames', () => {
    const text = '📄 @文'
    const next = applyFileMention(text, detectTrigger(text, text.length)!, text.length, '文档/📄.md')
    expect(next).toEqual({ text: '📄 @文档/📄.md ', caret: '📄 @文档/📄.md '.length })
  })
})
