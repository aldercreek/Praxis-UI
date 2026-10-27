import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '../../shared/protocol'
import { groupSidebarSessions, PINNED_SESSIONS_KEY, readPinnedSessions, retainPinnedSessions, savePinnedSessions } from './sidebarState'

describe('desktop pinned sessions', () => {
  it('ignores broken or unexpected stored values and unavailable storage', () => {
    for (const raw of ['broken json', '{}', 'null', '7']) {
      expect(readPinnedSessions({ getItem: () => raw })).toEqual([])
    }
    expect(readPinnedSessions({ getItem: () => { throw new Error('Access denied') } })).toEqual([])
    expect(readPinnedSessions({ getItem: () => null })).toEqual([])
  })

  it('keeps stable IDs in their saved order without malformed or duplicate entries', () => {
    expect(readPinnedSessions({ getItem: () => '["session-b",null,3,"session-a","session-b","", "  "]' })).toEqual(['session-b', 'session-a'])
  })

  it('round trips only IDs and reports storage write failures without crashing', () => {
    const stored = new Map<string, string>()
    expect(savePinnedSessions(['b', 'a'], { setItem: (key, value) => { stored.set(key, value) } })).toBe(true)
    expect(stored.get(PINNED_SESSIONS_KEY)).toBe('["b","a"]')
    expect(readPinnedSessions({ getItem: key => stored.get(key) ?? null })).toEqual(['b', 'a'])
    expect(savePinnedSessions(['a'], { setItem: () => { throw new Error('Quota exceeded') } })).toBe(false)
  })

  it('cleans up deleted sessions after a full list refresh without resetting existing pins', () => {
    const original = ['a', 'deleted', 'b']
    expect(retainPinnedSessions(original, new Set(['a', 'b', 'new']))).toEqual(['a', 'b'])
    expect(original).toEqual(['a', 'deleted', 'b'])
    expect(retainPinnedSessions(original, new Set(original))).toBe(original)
    expect(retainPinnedSessions(original, new Set())).toEqual([])
  })
})

describe('sidebar date groups', () => {
  const now = new Date(2026, 9, 27, 12)
  const session = (id: string, date: Date | string, title = id): SessionSummary => ({
    id, title, workspace: '', model: '', status: 'idle', updated_at: typeof date === 'string' ? date : date.toISOString()
  })

  it('groups by local calendar day while giving pinned sessions precedence', () => {
    const values = [
      session('today', new Date(2026, 9, 27)), session('old-pin', new Date(2026, 8, 10)),
      session('yesterday', new Date(2026, 9, 26, 23, 59)), session('older', new Date(2026, 9, 25, 23, 59)),
      session('recent-pin', now), session('invalid', 'unknown'), session('future', new Date(2026, 9, 28))
    ]
    expect(groupSidebarSessions(values, new Set(['old-pin', 'recent-pin']), '', now).map(group => [group.label, group.sessions.map(item => item.id)])).toEqual([
      ['Pinned', ['old-pin', 'recent-pin']], ['Recent chats', ['today', 'invalid', 'future']],
      ['Yesterday', ['yesterday']], ['Earlier', ['older']]
    ])
  })

  it('filters every group, preserves ordering and omits empty groups', () => {
    const values = [session('a', now, 'Praxis API'), session('b', now, 'UI polish'), session('c', now, 'praxis docs')]
    expect(groupSidebarSessions(values, new Set(['b', 'c']), ' PRAXIS ', now).map(group => [group.label, group.sessions.map(item => item.id)])).toEqual([
      ['Pinned', ['c']], ['Recent chats', ['a']]
    ])
    expect(groupSidebarSessions(values, new Set(), 'absent', now)).toEqual([])
    expect(groupSidebarSessions([session('untitled', now, '')], new Set(), 'New chat', now)[0].sessions[0].id).toBe('untitled')
  })
})
