import { describe, expect, it } from 'vitest'
import type { ChangedFile, TurnChanges } from './changeSummary'
import { contentLink } from './fileLinks'
import { fileReferenceChange } from './fileReferenceChange'

const file = (id: string, path: string, previewPath: string | undefined = path): ChangedFile => ({
  id, path, previewPath, edits: [{ id: `edit:${id}`, diff: '-old\n+new', added: 1, removed: 1 }]
})
const turn = (files: ChangedFile[], turnId = 'turn-a'): TurnChanges => ({ turnId, files })

describe('file reference change targets', () => {
  it('matches URL-encoded relative paths, Windows drive forms and local file URLs', () => {
    const changes = turn([file('notes', 'D:\\work\\docs\\my file.md')])
    for (const reference of [
      'docs/my%20file.md', './docs/../docs/my%20file.md', '/D:/work/docs/my%20file.md',
      'd:/WORK/docs/my%20file.md', 'file:///D:/work/docs/my%20file.md',
      'file://localhost/D:/work/docs/my%20file.md#L12'
    ]) expect(fileReferenceChange(reference, 'D:\\work', changes, true)?.file.id, reference).toBe('notes')
  })

  it('resolves preview-relative references and keeps POSIX paths case sensitive', () => {
    const link = contentLink('../my%20file.md', '/project/docs/readme.md')
    expect(link?.kind).toBe('file')
    const changes = turn([file('notes', '/project/my file.md')])
    expect(link?.kind === 'file' && fileReferenceChange(link.path, '/project', changes, true)?.file.id).toBe('notes')
    expect(fileReferenceChange('/Project/my%20file.md', '/project', changes, true)).toBeUndefined()
    expect(fileReferenceChange('my%20file.md', '/other', changes, true)).toBeUndefined()
  })

  it('prefers literal filenames before decoding and supports line and heading references', () => {
    const changes = turn([file('literal-percent', 'docs/my%20file.md'), file('space', 'docs/my file.md'), file('code', 'src/config.ts')])
    expect(fileReferenceChange('docs/my%20file.md', '/project', changes, true)?.file.id).toBe('literal-percent')
    for (const reference of ['src/config.ts:12:3', 'src/config.ts#L12-L18', 'src/config.ts#configuration']) {
      expect(fileReferenceChange(reference, '/project', changes, true)?.file.id).toBe('code')
    }
    expect(fileReferenceChange('docs/100%.md', '/project', turn([file('percent', 'docs/100%.md')]), true)?.file.id).toBe('percent')
  })

  it('does not associate unavailable child links or unresolved child paths with a parent file', () => {
    const parent = file('parent', 'a.ts')
    const child: ChangedFile = { ...file('child', 'a.ts'), previewPath: undefined, source: 'worker' }
    const absoluteChild = file('absolute-child', '/project/worker/a.ts')
    const changes = turn([parent, child, absoluteChild])
    expect(fileReferenceChange('a.ts', '/project', changes, false)).toBeUndefined()
    expect(fileReferenceChange('a.ts', '/project', turn([child]), true)).toBeUndefined()
    expect(fileReferenceChange('a.ts', '/project', changes, true)?.file.id).toBe('parent')
    expect(fileReferenceChange('/project/worker/a.ts', '/project', changes, true)?.file.id).toBe('absolute-child')
  })

  it('targets the selected file in its own historical turn instead of another turn with the same path', () => {
    const original = turn([file('first', 'a.ts'), file('second', 'b.ts')], 'turn-old')
    const current = turn([{ ...file('second-new', 'b.ts'), edits: [{ id: 'new', diff: '+new', added: 9, removed: 0 }] }], 'turn-new')
    expect(fileReferenceChange('b.ts', '/project', original, true)).toEqual({ turnId: 'turn-old', file: original.files[1] })
    expect(fileReferenceChange('b.ts', '/project', current, true)?.file.edits[0].added).toBe(9)
  })

  it('declines unsafe, unsupported or ambiguous references instead of guessing', () => {
    const changes = turn([file('notes', '/project/a.ts')])
    for (const reference of ['https://example.com/a.ts', 'file://server/project/a.ts', 'file:///project/a.ts?download', 'file:///project%2Fa.ts', '//server/a.ts']) {
      expect(fileReferenceChange(reference, '/project', changes, true)).toBeUndefined()
    }
    expect(fileReferenceChange('a.ts', '/project', turn([file('a', 'a.ts'), file('b', '/project/a.ts')]), true)).toBeUndefined()
  })
})
