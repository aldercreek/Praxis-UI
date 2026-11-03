import { useEffect, useMemo, useRef, useState } from 'react'
import { draftSnapshot, loadDrafts, persistKey, saveDrafts, type DraftConversations } from './draftStore'
import type { TextQuote } from './quote'

export function useDrafts(conversations: DraftConversations, workspace: string, listReady: boolean, removed: Set<string>) {
  const [initial] = useState(loadDrafts)
  const [drafts, setDrafts] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(initial).map(([key, value]) => [key, value.text])))
  const [quotes, setQuotes] = useState<Record<string, TextQuote | undefined>>(() => Object.fromEntries(Object.entries(initial).map(([key, value]) => [key, value.quote])))
  const latest = useRef(initial)
  const pruned = useRef(false)
  const snapshot = useMemo(() => draftSnapshot(drafts, quotes, conversations, workspace, latest.current, removed), [drafts, quotes, conversations, workspace, removed])
  latest.current = snapshot

  useEffect(() => {
    if (!listReady || pruned.current) return
    pruned.current = true
    const ids = new Set(Object.keys(conversations))
    const keep = (key: string) => key.startsWith('new:') || ids.has(persistKey(key, conversations, workspace)) || Boolean(conversations[key]?.localSession)
    setDrafts(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => keep(key))))
    setQuotes(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => keep(key))))
  }, [listReady, conversations, workspace])

  useEffect(() => {
    const timer = window.setTimeout(() => saveDrafts(latest.current), 300)
    return () => window.clearTimeout(timer)
  }, [snapshot])

  useEffect(() => {
    const flush = () => saveDrafts(latest.current)
    const visibility = () => { if (document.visibilityState === 'hidden') flush() }
    window.addEventListener('beforeunload', flush)
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      flush()
      window.removeEventListener('beforeunload', flush)
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [])

  return { drafts, setDrafts, quotes, setQuotes }
}
