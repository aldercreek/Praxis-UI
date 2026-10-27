import { describe, expect, it } from 'vitest'
import { fileDiffLines } from './fileDiff'

describe('file diff display', () => {
  it('omits patch metadata and uses old and new line positions across hunks', () => {
    const diff = '--- a/file.ts\n+++ b/file.ts\n@@ -5,3 +5,4 @@ function run()\n keep\n-old\n+new\n+extra\n end\n@@ -40 +41 @@\n-before\n+after\n'
    expect(fileDiffLines(diff)).toEqual([
      { kind: 'context', content: 'keep', number: 5 }, { kind: 'remove', content: 'old', number: 6 },
      { kind: 'add', content: 'new', number: 6 }, { kind: 'add', content: 'extra', number: 7 },
      { kind: 'context', content: 'end', number: 8 }, { kind: 'remove', content: 'before', number: 40 },
      { kind: 'add', content: 'after', number: 41 }
    ])
  })

  it('preserves code that looks like a patch header and blank changed lines', () => {
    expect(fileDiffLines('@@ -0,0 +1,3 @@\n+++ code\n+\n+  indent\n\\ No newline at end of file')).toEqual([
      { kind: 'add', content: '++ code', number: 1 }, { kind: 'add', content: '', number: 2 },
      { kind: 'add', content: '  indent', number: 3 }
    ])
  })

  it('renders headerless changes without inventing line numbers', () => {
    expect(fileDiffLines('-before\r\n+after\r\n')).toEqual([
      { kind: 'remove', content: 'before', number: undefined }, { kind: 'add', content: 'after', number: undefined }
    ])
  })
})
