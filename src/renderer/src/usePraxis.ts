import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectionStatus, DesktopInfo, DesktopSettings, PraxisEvent, SessionSnapshot, SessionSummary } from '../../shared/protocol'
import { applyEvent, applySnapshot, emptyConversation, isBusy, type Conversation } from './state'

export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)
export const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) || path

export function usePraxis() {
  const api = window.praxis
  const [info, setInfo] = useState<DesktopInfo>()
  const [connection, setConnection] = useState<ConnectionStatus>({ state: api ? 'connecting' : 'disconnected', message: api ? undefined : 'Open this interface in the Praxis desktop app.' })
  const [conversations, setConversations] = useState<Record<string, Conversation>>({})
  const [activeId, setActiveId] = useState<string | null>(null)
  const [workspace, setWorkspace] = useState('')
  const [error, setError] = useState('')
  const [loadingSession, setLoadingSession] = useState<string | null>(null)
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>(api ? 'loading' : 'error')
  const [sending, setSending] = useState(false)
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [deleteFailure, setDeleteFailure] = useState<string | null>(null)
  const removed = useRef(new Set<string>())
  const deletionRequests = useRef(new Map<string, Promise<void>>())
  const workspaceRef = useRef('')
  const conversationsRef = useRef(conversations)
  const snapshots = useRef(new Map<string, { events: PraxisEvent[]; generation: number }>())
  const connectionGeneration = useRef(0)
  const refreshing = useRef<number | null>(null)
  conversationsRef.current = conversations
  const removeSession = useCallback((sessionId: string) => {
    removed.current.add(sessionId)
    snapshots.current.delete(sessionId)
    setLoadingSession(previous => previous === sessionId ? null : previous)
    setActiveId(previous => previous === sessionId ? null : previous)
    setConversations(previous => {
      const next = { ...previous }
      delete next[sessionId]
      return next
    })
    try { localStorage.removeItem(`praxis:conversation-bookmarks:v1:${sessionId}`) } catch { /* Storage may be unavailable. */ }
  }, [])
  useEffect(() => {
    for (const [id, conversation] of Object.entries(conversations)) api?.acknowledge(id, conversation.sequence)
  }, [api, conversations])

  const refresh = useCallback(async (quiet = false) => {
    const generation = connectionGeneration.current
    if (!api || refreshing.current === generation) return
    refreshing.current = generation
    const before = conversationsRef.current
    if (!quiet) setListState(previous => previous === 'ready' ? previous : 'loading')
    try {
      if (!quiet) {
        const initialized = await api.request<{ model: string; configured: boolean }>('initialize')
        if (generation !== connectionGeneration.current) return
        setConfigured(initialized.configured)
      }
      const result = await api.request<{ sessions: SessionSummary[] }>('session.list')
      if (generation !== connectionGeneration.current) return
      const listed = new Set(result.sessions.map(session => session.id))
      for (const id of Object.keys(before)) if (!listed.has(id)) removeSession(id)
      setConversations(previous => {
        const next = { ...previous }
        for (const session of result.sessions) {
          if (removed.current.has(session.id)) continue
          const conversation = next[session.id] || emptyConversation()
          // A list response must not undo newer SSE state received during the request.
          if (conversation.sequence > (before[session.id]?.sequence || 0)) continue
          next[session.id] = { ...conversation, summary: session }
        }
        return next
      })
      setListState('ready')
    } catch {
      if (generation === connectionGeneration.current) {
        setListState(previous => previous === 'ready' ? previous : 'error')
      }
    } finally {
      if (refreshing.current === generation) refreshing.current = null
    }
  }, [api, removeSession])

  useEffect(() => {
    if (!api) return
    let previousConnection: ConnectionStatus['state'] = 'connecting'
    const offEvent = api.onEvent(event => {
      if (!event.session_id) return
      if (event.event === 'SessionDeleted') { removeSession(event.session_id); return }
      if (removed.current.has(event.session_id)) return
      const buffered = snapshots.current.get(event.session_id)
      if (buffered) {
        buffered.events.push(event)
        return
      }
      setConversations(previous => ({ ...previous, [event.session_id!]: applyEvent(previous[event.session_id!] || emptyConversation(), event) }))
    })
    const offConnection = api.onConnection(status => {
      const resumed = previousConnection === 'reconnecting'
      previousConnection = status.state
      setConnection(status)
      if (status.state === 'connecting' || status.state === 'reconnecting') {
        setListState(previous => previous === 'ready' ? previous : 'loading')
      }
      if (status.state === 'connected' && resumed) {
        void refresh(true)
      } else if (status.state === 'connected') {
        connectionGeneration.current += 1
        snapshots.current.clear()
        setLoadingSession(null)
        setError('')
        setConversations(previous => Object.fromEntries(Object.entries(previous).map(([id, conversation]) => [id, { ...conversation, loaded: false, sequence: 0, approvals: [] }])))
        void refresh()
      } else if (status.state === 'error' || status.state === 'disconnected') {
        setListState(previous => previous === 'ready' ? previous : 'error')
        connectionGeneration.current += 1
        snapshots.current.clear()
        setLoadingSession(null)
        setConversations(previous => Object.fromEntries(Object.entries(previous).map(([id, conversation]) => [id, {
          ...conversation, loaded: false, approvals: [], activity: '',
          summary: conversation.summary
        }])))
      }
    })
    api.getInfo().then(value => {
      setInfo(value)
      setConnection(value.connection)
      previousConnection = value.connection.state
      workspaceRef.current = value.settings.workspace
      setWorkspace(value.settings.workspace)
      if (value.connection.state === 'connected') void refresh()
      else if (value.connection.state === 'error' || value.connection.state === 'disconnected') {
        setListState(previous => previous === 'ready' ? previous : 'error')
      }
    }).catch(error => {
      setListState(previous => previous === 'ready' ? previous : 'error')
      setError(errorMessage(error))
    })
    return () => { offEvent(); offConnection() }
  }, [api, refresh, removeSession])

  useEffect(() => {
    if (connection.state !== 'connected') return
    // Per-session SSE cannot announce a session that this desktop has never opened.
    const update = () => { void refresh(true) }
    const timer = window.setInterval(update, 2000)
    window.addEventListener('focus', update)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', update) }
  }, [connection.state, refresh])

  const openSession = useCallback(async (sessionId: string) => {
    if (removed.current.has(sessionId)) return
    setActiveId(sessionId)
    setError('')
    if (conversationsRef.current[sessionId]?.loaded) return
    if (snapshots.current.has(sessionId)) { setLoadingSession(sessionId); return }
    setLoadingSession(sessionId)
    const operation = { events: [] as PraxisEvent[], generation: connectionGeneration.current }
    snapshots.current.set(sessionId, operation)
    try {
      const result = await api.request<SessionSnapshot>('session.open', { session_id: sessionId })
      if (operation.generation !== connectionGeneration.current || snapshots.current.get(sessionId) !== operation) return
      const buffered = operation.events
      snapshots.current.delete(sessionId)
      setConversations(previous => ({ ...previous, [sessionId]: applySnapshot(result, buffered) }))
    } catch (error) {
      if (operation.generation !== connectionGeneration.current || snapshots.current.get(sessionId) !== operation) return
      const buffered = operation.events
      snapshots.current.delete(sessionId)
      setConversations(previous => ({ ...previous, [sessionId]: buffered.reduce(applyEvent, previous[sessionId] || emptyConversation()) }))
      setError(errorMessage(error))
    } finally {
      if (operation.generation === connectionGeneration.current) setLoadingSession(previous => previous === sessionId ? null : previous)
    }
  }, [api])

  useEffect(() => {
    if (connection.state === 'connected' && activeId && !conversationsRef.current[activeId]?.loaded) void openSession(activeId)
  }, [connection.state, openSession])

  const newChat = useCallback(() => { setActiveId(null); setError('') }, [])

  const deleteSession = useCallback((sessionId: string): Promise<void> => {
    const pending = deletionRequests.current.get(sessionId)
    if (pending) return pending
    removeSession(sessionId)
    setError('')
    setDeleteFailure(null)
    const operation = (async () => {
      try { await api.request('session.delete', { session_id: sessionId }) }
      catch (failure) {
        // A lost response is ambiguous. Restore only if the service still lists it.
        try {
          const result = await api.request<{ sessions: SessionSummary[] }>('session.list')
          const session = result.sessions.find(item => item.id === sessionId)
          if (session) {
            removed.current.delete(sessionId)
            setConversations(previous => ({ ...previous, [sessionId]: { ...emptyConversation(), summary: session } }))
          }
        } catch { /* Keep it hidden until deletion can be retried. */ }
        setError(`Couldn’t finish deleting the chat. ${errorMessage(failure)}`)
        setDeleteFailure(sessionId)
      } finally { deletionRequests.current.delete(sessionId) }
    })()
    deletionRequests.current.set(sessionId, operation)
    return operation
  }, [api, removeSession])

  const chooseWorkspace = useCallback(async () => {
    try {
      const selected = await api.chooseDirectory('workspace')
      if (!selected) return
      const nextInfo = await api.updateSettings({ workspace: selected })
      setInfo(nextInfo)
      workspaceRef.current = selected
      setWorkspace(selected)
      newChat()
      await refresh()
    } catch (error) { setError(errorMessage(error)) }
  }, [api, newChat, refresh])

  const send = useCallback(async (text: string) => {
    if (!text.trim() || sending || !api) return { success: false, sessionId: activeId }
    setSending(true)
    setError('')
    let sessionId = activeId
    const messageId = `local:${crypto.randomUUID()}`
    let queued = false
    try {
      if (!sessionId) {
        const result = await api.request<{ session: SessionSummary }>('session.create', { workspace })
        sessionId = result.session.id
        if (removed.current.has(sessionId)) throw new Error('This chat has been deleted.')
        setConversations(previous => ({ ...previous, [sessionId!]: { ...(previous[sessionId!] || emptyConversation()), summary: result.session, loaded: true } }))
        setActiveId(sessionId)
      }
      queued = isBusy(conversationsRef.current[sessionId]?.summary?.status)
      if (removed.current.has(sessionId)) throw new Error('This chat has been deleted.')
      setConversations(previous => {
        const conversation = previous[sessionId!] || emptyConversation()
        return { ...previous, [sessionId!]: {
          ...conversation,
          summary: conversation.summary ? { ...conversation.summary, status: queued ? conversation.summary.status : 'running' } : undefined,
          messages: [...conversation.messages, { id: messageId, role: 'user', content: text, status: queued ? 'queued' : 'sending', turn_id: queued ? conversation.activeTurnId : undefined }],
          activity: queued ? conversation.activity : 'Starting'
        } }
      })
      await api.request('input.submit', { session_id: sessionId, command_id: messageId, text })
      setConversations(previous => {
        const conversation = previous[sessionId!]
        return conversation ? { ...previous, [sessionId!]: { ...conversation, pausedInputs: conversation.pausedInputs.filter(pending => pending !== text) } } : previous
      })
      return { success: true, sessionId }
    } catch (error) {
      setError(errorMessage(error))
      if (sessionId) setConversations(previous => {
        const conversation = previous[sessionId!]
        if (!conversation) return previous
        return { ...previous, [sessionId!]: {
          ...conversation,
          summary: !queued && conversation.summary ? { ...conversation.summary, status: 'idle' } : conversation.summary,
          messages: conversation.messages.filter(message => message.id !== messageId),
          activity: queued ? conversation.activity : ''
        } }
      })
      return { success: false, sessionId }
    } finally { setSending(false) }
  }, [activeId, api, sending, workspace])

  const stop = useCallback(async () => {
    if (!activeId) return
    try {
      const turnId = conversationsRef.current[activeId]?.summary?.active_turn?.id
      if (!turnId) return
      const result = await api.request<{ cancel_requested?: boolean }>('turn.cancel', { session_id: activeId, turn_id: turnId })
      if (!result.cancel_requested) return
      setConversations(previous => {
        const conversation = previous[activeId]
        if (!conversation?.summary || conversation.summary.active_turn?.id !== turnId || !isBusy(conversation.summary.status)) return previous
        return { ...previous, [activeId]: { ...conversation, summary: { ...conversation.summary, status: 'stopping' }, activity: 'Stopping' } }
      })
    } catch (error) { setError(errorMessage(error)) }
  }, [activeId, api])

  const approve = useCallback(async (approvalId: string, approved: boolean) => {
    if (!activeId) return
    try {
      await api.request('approval.decide', { session_id: activeId, approval_id: approvalId, approved })
      setConversations(previous => previous[activeId] ? ({ ...previous, [activeId]: { ...previous[activeId], approvals: previous[activeId].approvals.filter(approval => approval.approval_id !== approvalId) } }) : previous)
    } catch (error) { setError(errorMessage(error)); throw error }
  }, [activeId, api])

  const resumeInputs = useCallback(async () => {
    if (!activeId) return
    try { await api.request('input.resume', { session_id: activeId, command_id: crypto.randomUUID() }) }
    catch (error) { setError(errorMessage(error)) }
  }, [activeId, api])

  const deleteInput = useCallback(async (commandId: string) => {
    if (!activeId) return
    try { await api.request('input.delete', { session_id: activeId, command_id: commandId }) }
    catch (error) { setError(errorMessage(error)) }
  }, [activeId, api])

  const saveSettings = useCallback(async (settings: Partial<Omit<DesktopSettings, 'apiKeyConfigured'>> & { apiKey?: string }) => {
    const nextInfo = await api.updateSettings(settings)
    setInfo(nextInfo)
    setConnection(nextInfo.connection)
    if (nextInfo.settings.workspace !== workspaceRef.current) newChat()
    workspaceRef.current = nextInfo.settings.workspace
    setWorkspace(nextInfo.settings.workspace)
    // Explicit configuration changes reattach the client and reload its snapshots.
    const engineChanged = ['praxisPath', 'pythonPath', 'model', 'baseUrl', 'apiKey', 'bypassApprovals'].some(key => key in settings)
    if (engineChanged) {
      setConversations(previous => Object.fromEntries(Object.entries(previous).map(([id, conversation]) => [id, { ...conversation, loaded: false }])))
      setActiveId(null)
    }
    if (nextInfo.connection.state === 'connected') await refresh()
  }, [api, newChat, refresh])

  const sessions = Object.values(conversations).flatMap(conversation => conversation.summary ? [conversation.summary] : [])
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))

  return {
    api, info, connection, conversations, activeId, active: activeId ? conversations[activeId] : undefined,
    workspace, sessions, error, setError, listState, sending, configured, loadingSession,
    refresh, openSession, newChat, chooseWorkspace, send, stop, approve, resumeInputs, deleteInput, saveSettings,
    deleteSession, deleteFailure, removedSessionIds: removed.current
  }
}
