import { afterEach, describe, expect, it } from 'vitest'
import { collectText, findMatches, toRanges } from './findInChat'

afterEach(() => { document.body.innerHTML = '' })
const collect = (html: string) => { document.body.innerHTML = html; return collectText([document.body]) }

describe('find in chat', () => {
  it('matches a word split across syntax spans and creates the full DOM range', () => {
    const { text, segments } = collect('<pre><span>docu</span><span>ment</span>.title</pre>')
    const ranges = toRanges(findMatches(text, 'DOCUMENT'), segments)
    expect(ranges).toHaveLength(1)
    expect(ranges[0].toString()).toBe('document')
  })

  it('matches literal regex punctuation, Unicode and mixed case', () => {
    expect(findMatches('a.b A.B axb [x] a+b', 'a.b')).toEqual([{ start: 0, end: 3 }, { start: 4, end: 7 }])
    expect(findMatches('[x] a+b', '[x]')).toEqual([{ start: 0, end: 3 }])
    expect(findMatches('结果：中文查找；中文查找', '中文查找')).toHaveLength(2)
    expect(findMatches('İtext', 'text')).toEqual([{ start: 1, end: 5 }])
    expect(findMatches('anything', '')).toEqual([])
  })

  it('excludes controls, inaccessible content, MathML and code headers', () => {
    const { text } = collect('<p>Content</p><button>Button</button><input value="Input"><textarea>Draft</textarea><svg><text>Icon</text></svg><span aria-hidden="true"><b>Hidden label</b></span><span class="sr-only">Reader label</span><div class="code-block-header">typescript</div><span class="katex-mathml">MathML</span><span class="katex-html" aria-hidden="true">Formula</span>')
    expect(text).toContain('Content')
    expect(text).toContain('Formula')
    for (const excluded of ['Button', 'Input', 'Draft', 'Icon', 'Hidden label', 'Reader label', 'typescript', 'MathML']) expect(text).not.toContain(excluded)
  })

  it('searches hidden process entries and closed details without combining separate paragraphs', () => {
    const { text, segments } = collect('<div hidden><details><summary>Tool</summary><pre>Collapsed needle</pre></details></div><p>first</p><p>second</p>')
    expect(toRanges(findMatches(text, 'needle'), segments)[0].toString()).toBe('needle')
    expect(findMatches(text, 'firstsecond')).toEqual([])
  })

  it('limits the result count and keeps separate roots searchable', () => {
    expect(findMatches('a '.repeat(1100), 'a', 1000)).toHaveLength(1000)
    document.body.innerHTML = '<main>main needle</main><aside>agent needle</aside>'
    const { text, segments } = collectText([document.querySelector('main')!, document.querySelector('aside')!])
    expect(toRanges(findMatches(text, 'needle'), segments).map(range => range.toString())).toEqual(['needle', 'needle'])
  })
})
