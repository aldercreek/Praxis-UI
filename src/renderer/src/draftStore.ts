import type { TextQuote } from './quote'

export type StoredDraft = { text: string; quote?: TextQuote; updatedAt: number }
export type DraftFile = { version: 1; drafts: Record<string, StoredDraft> }
export type Drafts = DraftFile['drafts']
export type DraftConversations = Record<string, { clientId?: string; localSession?: boolean; summary?: { id: string; workspace: string } }>
const storageKey = 'praxis.drafts.v1'
const maxLength = 100_000
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

function normalize(value: unknown): Drafts {
  if (!object(value)) return {}
  const entries: [string, StoredDraft][] = []
  for (const [key, item] of Object.entries(value)) {
    if (!key || !object(item) || typeof item.text !== 'string' || typeof item.updatedAt !== 'number' || !Number.isFinite(item.updatedAt) || item.updatedAt < 0) continue
    const text = item.text.slice(0, maxLength)
    const quote = object(item.quote) && typeof item.quote.text === 'string' && item.quote.text && typeof item.quote.messageId === 'string' && item.quote.messageId
      ? { text: item.quote.text.slice(0, maxLength), messageId: item.quote.messageId } : undefined
    if (text || quote) entries.push([key, { text, ...(quote ? { quote } : {}), updatedAt: item.updatedAt }])
  }
  return Object.fromEntries(entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, 50))
}

export function loadDrafts(storage?: Pick<Storage, 'getItem'>): Drafts {
  try {
    const file: unknown = JSON.parse((storage || localStorage).getItem(storageKey) || 'null')
    return object(file) && file.version === 1 ? normalize(file.drafts) : {}
  } catch { return {} }
}

export function saveDrafts(drafts: Drafts, storage?: Pick<Storage, 'setItem'>): void {
  try { (storage || localStorage).setItem(storageKey, JSON.stringify({ version: 1, drafts: normalize(drafts) } satisfies DraftFile)) } catch {}
}

export function persistKey(draftKey: string, conversations: DraftConversations, workspace: string): string {
  if (draftKey.startsWith('new:')) return draftKey
  const entry = Object.entries(conversations).find(([id, conversation]) => id === draftKey || conversation.clientId === draftKey)
  if (entry && !entry[1].localSession) return entry[1].summary?.id || entry[0]
  if (entry?.[1].localSession || draftKey.startsWith('local-session:')) return `new:${entry?.[1].summary?.workspace || workspace}`
  return draftKey
}

export function pruneDrafts(drafts: Drafts, sessionIds: Set<string>): Drafts {
  return Object.fromEntries(Object.entries(drafts).filter(([key]) => key.startsWith('new:') || sessionIds.has(key)))
}

export function draftSnapshot(texts: Record<string, string>, quotes: Record<string, TextQuote | undefined>, conversations: DraftConversations,
  workspace: string, previous: Drafts, removed: Set<string>, now = Date.now()): Drafts {
  const clients = new Set(Object.values(conversations).map(conversation => conversation.clientId).filter(Boolean))
  const keys = [...new Set([...Object.keys(texts), ...Object.keys(quotes)])].sort((a, b) => Number(clients.has(a)) - Number(clients.has(b)))
  const candidates: Drafts = Object.create(null)
  for (const key of keys) {
    const destination = persistKey(key, conversations, workspace)
    if (removed.has(key) || removed.has(destination)) continue
    const text = (texts[key] || '').slice(0, maxLength)
    const quote = quotes[key] ? { ...quotes[key], text: quotes[key].text.slice(0, maxLength) } : undefined
    const old = previous[destination]
    candidates[destination] = old && old.text === text && old.quote?.text === quote?.text && old.quote?.messageId === quote?.messageId
      ? old : { text, quote, updatedAt: now }
  }
  const next = Object.fromEntries(Object.entries(candidates).filter(([, draft]) => draft.text || draft.quote).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, 50))
  return Object.keys(next).length === Object.keys(previous).length && Object.entries(next).every(([key, value]) => previous[key] === value) ? previous : next
}
