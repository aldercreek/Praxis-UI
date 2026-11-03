import { describe, expect, it } from 'vitest'
import { draftSnapshot, loadDrafts, persistKey, pruneDrafts, saveDrafts, type DraftConversations } from './draftStore'

function storage(initial = '') {
  let value = initial
  return { getItem: () => value, setItem: (_: string, next: string) => { value = next } }
}
const quote = { text: 'Keep this source', messageId: 'assistant:1' }

describe('persistent drafts', () => {
  it('round trips text and quotes and deletes empty records', () => {
    const store = storage()
    saveDrafts({ chat: { text: 'Continue', quote, updatedAt: 1 }, empty: { text: '', updatedAt: 2 }, quoted: { text: '', quote, updatedAt: 3 } }, store)
    expect(loadDrafts(store)).toEqual({ chat: { text: 'Continue', quote, updatedAt: 1 }, quoted: { text: '', quote, updatedAt: 3 } })
    saveDrafts({ chat: { text: '', updatedAt: 4 } }, store)
    expect(loadDrafts(store)).toEqual({})
  })

  it('tolerates invalid versions, malformed entries and blocked storage', () => {
    for (const value of ['', '{', 'null', '[]', '{"version":2,"drafts":{}}', '{"version":1,"drafts":{"bad":{"text":3,"updatedAt":1}}}']) expect(loadDrafts(storage(value))).toEqual({})
    const blocked = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('full') } }
    expect(loadDrafts(blocked)).toEqual({})
    expect(() => saveDrafts({ chat: { text: 'Keep', updatedAt: 1 } }, blocked)).not.toThrow()
  })

  it('keeps the newest 50 drafts and truncates long content', () => {
    const store = storage()
    saveDrafts(Object.fromEntries(Array.from({ length: 51 }, (_, index) => [String(index), { text: 'a'.repeat(100_005), quote, updatedAt: index }])), store)
    const drafts = loadDrafts(store)
    expect(Object.keys(drafts)).toHaveLength(50)
    expect(drafts['0']).toBeUndefined()
    expect(drafts['50'].text).toHaveLength(100_000)
  })

  it('maps existing, migrated and pending local conversations to durable keys', () => {
    const conversations: DraftConversations = { server: { clientId: 'local-session:ready', summary: { id: 'server', workspace: '/one' } }, 'local-session:pending': { localSession: true, summary: { id: 'local-session:pending', workspace: '/two' } } }
    expect(persistKey('server', conversations, '/work')).toBe('server')
    expect(persistKey('local-session:ready', conversations, '/work')).toBe('server')
    expect(persistKey('local-session:pending', conversations, '/work')).toBe('new:/two')
    expect(persistKey('local-session:missing', conversations, '/work')).toBe('new:/work')
    expect(persistKey('new:/original', conversations, '/work')).toBe('new:/original')
  })

  it('preserves workspace drafts while pruning missing chats', () => {
    const draft = { text: 'Keep', updatedAt: 1 }
    expect(pruneDrafts({ chat: draft, missing: draft, 'new:/work': draft }, new Set(['chat']))).toEqual({ chat: draft, 'new:/work': draft })
  })

  it('keeps edit timestamps stable during stream updates and removes sent or deleted drafts', () => {
    const texts = { chat: 'Keep' }
    const first = draftSnapshot(texts, { chat: quote }, {}, '', {}, new Set(), 1)
    expect(draftSnapshot(texts, { chat: { ...quote } }, {}, '', first, new Set(), 2)).toBe(first)
    expect(draftSnapshot({ chat: 'Edited' }, { chat: quote }, {}, '', first, new Set(), 3).chat.updatedAt).toBe(3)
    expect(draftSnapshot({ chat: '' }, {}, {}, '', first, new Set(), 4)).toEqual({})
    expect(draftSnapshot(texts, { chat: quote }, {}, '', first, new Set(['chat']), 4)).toEqual({})
  })

  it('prefers the active client draft over an older copy stored by server id', () => {
    const conversations = { server: { clientId: 'local-session:ready' } }
    expect(draftSnapshot({ server: 'Old', 'local-session:ready': 'New' }, {}, conversations, '', {}, new Set(), 2)).toEqual({ server: { text: 'New', updatedAt: 2 } })
    expect(draftSnapshot({ server: 'Old', 'local-session:ready': '' }, {}, conversations, '', {}, new Set(), 2)).toEqual({})
  })
})
