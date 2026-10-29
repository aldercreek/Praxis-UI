import { describe, expect, it } from 'vitest'
import { assistantDisplayText, readAgentReports } from './messagePresentation'

describe('assistant display metadata', () => {
  it.each(['[message_id=m21] ', '[message_id=m21]\n', '[message_id=m0123456789abcdef0123456789abcdef, operation_id=op12]\n'])('hides a leading internal marker: %s', prefix => {
    expect(assistantDisplayText(prefix + '完成了。')).toBe('完成了。')
    for (let length = 1; length < prefix.trimEnd().length; length++) {
      expect(assistantDisplayText(prefix.slice(0, length), true)).toBe('')
    }
    expect(assistantDisplayText(prefix.trimEnd(), true)).toBe('')
  })

  it.each(['示例：[message_id=m21] 内容', '`[message_id=m21]`', '```text\n[message_id=m21]\n```', '[message_id=custom] 内容', '[message_id=m21]suffix', '[message_id=mabc] 内容'])('preserves ordinary prose and code: %s', text => {
    expect(assistantDisplayText(text)).toBe(text)
  })

  it('keeps incomplete ordinary text once streaming has finished', () => {
    expect(assistantDisplayText('[message_id=m')).toBe('[message_id=m')
    expect(assistantDisplayText('[markdown', true)).toBe('[markdown')
  })

  it('only removes worker transport wrapping from identified reports', () => {
    const raw = '[Worker run ended; this does not imply task completion. Read the response for findings, blockers or requests for reassignment.]\n检查完成。\nWorking directory: D:/work. Files are not automatically integrated into the parent workspace.'
    expect(assistantDisplayText(raw)).toBe(raw)
    expect(assistantDisplayText(raw, false, true)).toBe('检查完成。')
  })

  it('recognizes only complete collaboration envelopes', () => {
    const prefix = '[Agent collaboration messages; source-labelled task data]\n'
    const report = { sender_id: 'reviewer', recipient_id: 'parent', content: '完成了。' }
    expect(readAgentReports(prefix + JSON.stringify([report]))).toEqual([report])
    expect(readAgentReports(prefix + '[{"content":"example"}]')).toBeUndefined()
    expect(readAgentReports(prefix + '[broken')).toBeUndefined()
    expect(readAgentReports('Example: ' + prefix + JSON.stringify([report]))).toBeUndefined()
  })
})
