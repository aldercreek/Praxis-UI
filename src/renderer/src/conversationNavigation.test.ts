import { describe, expect, it } from 'vitest'
import { conversationAnchors } from './conversationNavigation'
import { formatQuotedInput } from './quotedInput'
import type { DisplayMessage } from './state'

const message = (id: string, role: DisplayMessage['role'], content: string, extra: Partial<DisplayMessage> = {}): DisplayMessage => ({ id, role, content, ...extra })

describe('conversation navigation', () => {
  it('previews the latest main reply for each question without mixing in tools or child responses', () => {
    const items = conversationAnchors([
      message('u1', 'user', '先检查配置'), message('a1', 'assistant', '开始检查'),
      message('t1', 'tool', 'internal output'), message('a2', 'assistant', '**检查完成**，配置正确。'),
      message('child-u', 'user', '子任务提问', { agent_id: 'worker' }), message('child-a', 'assistant', '子任务输出', { agent_id: 'worker' }),
      message('u2', 'user', '接下来修改字体'), message('a3', 'assistant', '字体已修改。')
    ])
    expect(items.map(({ question, answer }) => ({ question, answer }))).toEqual([
      { question: '先检查配置', answer: '检查完成，配置正确。' }, { question: '接下来修改字体', answer: '字体已修改。' }
    ])
  })

  it('keeps bookmarks stable when optimistic IDs and history turn IDs change on reload', () => {
    const live = conversationAnchors([message('local:random', 'user', '检查一下\r\n并给出结果', { turn_id: 'live-turn' })])
    const restored = conversationAnchors([message('saved:42', 'user', '检查一下\n并给出结果', { turn_id: 'history-turn' })])
    expect(live[0].bookmarkKey).toBe(restored[0].bookmarkKey)
    expect(live[0].bookmarkKey).not.toContain('检查')
  })

  it('gives repeated prompts separate bookmarks and preserves earlier keys as the conversation grows', () => {
    const messages = [message('1', 'user', '继续'), message('2', 'user', '继续')]
    const original = conversationAnchors(messages)
    const later = conversationAnchors([...messages, message('3', 'user', '继续')])
    expect(new Set(later.map(item => item.bookmarkKey)).size).toBe(3)
    expect(later.slice(0, 2)).toEqual(original)
  })

  it('shows the new instruction as the title of a quoted follow-up and allows an unanswered question', () => {
    const items = conversationAnchors([message('u', 'user', formatQuotedInput('请改短一点', { text: '很长的引用内容' }))])
    expect(items[0]).toMatchObject({ question: '请改短一点', answer: '' })
    expect(conversationAnchors([message('empty', 'user', ' '), message('assistant', 'assistant', 'hi')])).toEqual([])
  })
})
