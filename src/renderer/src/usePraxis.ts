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
  const [listing, setListing] = useState(false)
  const [sending, setSending] = useState(false)
  const [configured, setConfigured] = useState<boolean | null>(null)
  const workspaceRef = useRef('')
  const conversationsRef = useRef(conversations)
  const snapshots = useRef(new Map<string, { events: PraxisEvent[]; generation: number }>())
  const connectionGeneration = useRef(0)
  const refreshGeneration = useRef(0)
  conversationsRef.current = conversations
  useEffect(() => {
    for (const [id, conversation] of Object.entries(conversations)) api?.acknowledge(id, conversation.sequence)
  }, [api, conversations])

  const refresh = useCallback(async (selectedWorkspace = workspaceRef.current) => {
    if (!api) return
    const generation = ++refreshGeneration.current
    setListing(true)
    try {
      const initialized = await api.request<{ model: string; configured: boolean }>('initialize')
      setConfigured(initialized.configured)
      const result = await api.request<{ sessions: SessionSummary[] }>('session.list', { workspace: selectedWorkspace })
      if (generation !== refreshGeneration.current) return
      setConversations(previous => {
        const next = { ...previous }
        for (const session of result.sessions) next[session.id] = { ...(next[session.id] || emptyConversation()), summary: session }
        return next
      })
    } catch (error) {
      if (generation === refreshGeneration.current) setError(errorMessage(error))
    } finally {
      if (generation === refreshGeneration.current) setListing(false)
    }
  }, [api])

  useEffect(() => {
    if (!api) return
    let previousConnection: ConnectionStatus['state'] = 'connecting'
    const offEvent = api.onEvent(event => {
      if (!event.session_id) return
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
      if (status.state === 'connected' && !resumed) {
        connectionGeneration.current += 1
        snapshots.current.clear()
        setLoadingSession(null)
        setError('')
        setConversations(previous => Object.fromEntries(Object.entries(previous).map(([id, conversation]) => [id, { ...conversation, loaded: false, sequence: 0, approvals: [] }])))
        void refresh()
      } else if (status.state === 'error' || status.state === 'disconnected') {
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
      if (value.connection.state === 'connected') void refresh(value.settings.workspace)
    }).catch(error => setError(errorMessage(error)))
    return () => { offEvent(); offConnection() }
  }, [api, refresh])

  const openSession = useCallback(async (sessionId: string) => {
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

  const chooseWorkspace = useCallback(async () => {
    try {
      const selected = await api.chooseDirectory('workspace')
      if (!selected) return
      const nextInfo = await api.updateSettings({ workspace: selected })
      setInfo(nextInfo)
      workspaceRef.current = selected
      setWorkspace(selected)
      newChat()
      await refresh(selected)
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
        setConversations(previous => ({ ...previous, [sessionId!]: { ...(previous[sessionId!] || emptyConversation()), summary: result.session, loaded: true } }))
        setActiveId(sessionId)
      }
      queued = isBusy(conversationsRef.current[sessionId]?.summary?.status)
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
      setConversations(previous => ({ ...previous, [activeId]: { ...previous[activeId], approvals: previous[activeId].approvals.filter(approval => approval.approval_id !== approvalId) } }))
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
    if (nextInfo.connection.state === 'connected') await refresh(nextInfo.settings.workspace)
  }, [api, newChat, refresh])

  const sessions = Object.values(conversations).flatMap(conversation => conversation.summary ? [conversation.summary] : [])
    .filter(session => !workspace || session.workspace.replaceAll('\\', '/').toLowerCase() === workspace.replaceAll('\\', '/').toLowerCase())
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))

  return {
    api, info, connection, conversations, activeId, active: activeId ? conversations[activeId] : undefined,
    workspace, sessions, error, setError, listing, sending, configured, loadingSession,
    refresh, openSession, newChat, chooseWorkspace, send, stop, approve, resumeInputs, deleteInput, saveSettings
  }
}
