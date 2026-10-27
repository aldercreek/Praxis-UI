import type { SessionSummary } from '../../shared/protocol'

export const PINNED_SESSIONS_KEY = 'praxis:pinned-sessions:v1'

export function readPinnedSessions(storage?: Pick<Storage, 'getItem'>): string[] {
  try {
    const value: unknown = JSON.parse((storage ?? window.localStorage).getItem(PINNED_SESSIONS_KEY) ?? '[]')
    if (!Array.isArray(value)) return []
    return [...new Set(value.filter((id): id is string => typeof id === 'string' && id.trim().length > 0))]
  } catch { return [] }
}

export function savePinnedSessions(ids: string[], storage?: Pick<Storage, 'setItem'>): boolean {
  try {
    ;(storage ?? window.localStorage).setItem(PINNED_SESSIONS_KEY, JSON.stringify(ids))
    return true
  } catch { return false }
}

/** Call only after the complete session list has loaded, never on a filtered list. */
export function retainPinnedSessions(ids: string[], available: ReadonlySet<string>): string[] {
  const next = ids.filter(id => available.has(id))
  return next.length === ids.length ? ids : next
}
export function groupSidebarSessions(sessions: readonly SessionSummary[], pinned: ReadonlySet<string>, query: string, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime()
  const groups: { label: string; sessions: SessionSummary[] }[] = [
    { label: 'Pinned', sessions: [] }, { label: 'Recent chats', sessions: [] },
    { label: 'Yesterday', sessions: [] }, { label: 'Earlier', sessions: [] }
  ]
  const search = query.trim().toLocaleLowerCase()
  for (const session of sessions) {
    if (!(session.title || 'New chat').toLocaleLowerCase().includes(search)) continue
    const updated = Date.parse(session.updated_at)
    const index = pinned.has(session.id) ? 0 : !Number.isFinite(updated) || updated >= today ? 1 : updated >= yesterday ? 2 : 3
    groups[index].sessions.push(session)
  }
  return groups.filter(group => group.sessions.length)
}
