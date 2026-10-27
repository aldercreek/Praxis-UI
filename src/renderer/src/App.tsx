import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, CircleAlert, Folder, GitCompareArrows, LoaderCircle, LockKeyhole, Maximize2, Minus, PanelLeft, Plus, Quote, Square, X } from 'lucide-react'
import type { DesktopSettings, SessionSummary } from '../../shared/protocol'
import { isBusy } from './state'
import { baseName, errorMessage, usePraxis } from './usePraxis'
import { DisclosureState } from './Disclosure'
import { ExecutionBar } from './ExecutionBar'
import { FileNavigationContext } from './MarkdownContent'
import { FilePanel, type PanelTarget } from './FilePanel'
import { collectTurnChanges } from './changeSummary'
import { QuoteSelection, type TextQuote } from './QuoteSelection'
import { formatQuotedInput } from './quotedInput'
import { McpStatusDialog } from './McpStatusDialog'
import { ConversationRail } from './ConversationRail'
import { DeleteChatDialog } from './DeleteChat'
import { Sidebar } from './Sidebar'
import { Transcript } from './Transcript'
import { ApprovalProvider, ApprovalPrompt } from './ApprovalPrompt'
import { ReadingAnchor } from './ReadingAnchor'
import praxisWordmark from '../../../resources/brand/praxis-wordmark.svg'

type Praxis = ReturnType<typeof usePraxis>

function IconButton({ label, children, onClick, disabled, className = '' }: { label: string; children: ReactNode; onClick?: () => void; disabled?: boolean; className?: string }) {
  return <button type="button" className={`icon-button ${className}`} aria-label={label} title={label} onClick={onClick} disabled={disabled}>{children}</button>
}

function SettingsDialog({ praxis, open, close }: { praxis: Praxis; open: boolean; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [draft, setDraft] = useState({ praxisPath: '', pythonPath: '', workspace: '', model: '', baseUrl: '', apiKey: '', bypassApprovals: true })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (open) {
      const settings = praxis.info?.settings
      if (settings) setDraft({ praxisPath: settings.praxisPath, pythonPath: settings.pythonPath, workspace: settings.workspace, model: settings.model, baseUrl: settings.baseUrl, apiKey: '', bypassApprovals: settings.bypassApprovals })
      setError('')
      ref.current?.showModal()
    } else ref.current?.close()
  }, [open, praxis.info])

  const choose = async (kind: 'praxis' | 'workspace' | 'python') => {
    try {
      const selected = kind === 'python' ? await praxis.api.choosePython() : await praxis.api.chooseDirectory(kind)
      if (selected) setDraft(previous => ({ ...previous, [kind === 'praxis' ? 'praxisPath' : kind === 'python' ? 'pythonPath' : 'workspace']: selected }))
    } catch (error) { setError(errorMessage(error)) }
  }
  const save = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setError('')
    const changed: Partial<Omit<DesktopSettings, 'apiKeyConfigured'>> & { apiKey?: string } = {}
    for (const key of ['praxisPath', 'pythonPath', 'workspace', 'model', 'baseUrl'] as const) {
      if (draft[key].trim() !== praxis.info?.settings[key]) changed[key] = draft[key].trim()
    }
    if (draft.apiKey.trim()) changed.apiKey = draft.apiKey.trim()
    if (draft.bypassApprovals !== praxis.info?.settings.bypassApprovals) changed.bypassApprovals = draft.bypassApprovals
    try { await praxis.saveSettings(changed); close() } catch (error) { setError(errorMessage(error)) } finally { setSaving(false) }
  }
  return <dialog ref={ref} className="praxis-dialog settings-dialog" onCancel={event => { if (saving) event.preventDefault(); else close() }} onClose={close} aria-labelledby="settings-title">
    <form onSubmit={event => void save(event)}>
      <div className="dialog-header"><div><h2 id="settings-title">Settings <span className="version">{praxis.info ? `v${praxis.info.version}` : ''}</span></h2><p>Connect to local Praxis and configure your workspace.</p></div><IconButton label="Close settings" disabled={saving} onClick={close}><X size={16} /></IconButton></div>
      <div className="settings-fields">
        <div className="settings-section-title">Local runtime</div>
        <label className="field"><span>Praxis project directory</span><div className="path-field"><input required value={draft.praxisPath} onChange={event => setDraft({ ...draft, praxisPath: event.target.value })} placeholder="Choose your local Praxis project" /><button type="button" className="button" onClick={() => void choose('praxis')} disabled={saving || !praxis.api}>Browse</button></div></label>
        <label className="field"><span>Python interpreter</span><div className="path-field"><input value={draft.pythonPath} onChange={event => setDraft({ ...draft, pythonPath: event.target.value })} placeholder="Use Python from Praxis/.venv automatically" /><button type="button" className="button" onClick={() => void choose('python')} disabled={saving || !praxis.api}>Browse</button></div><small>Use a Python environment with Praxis dependencies installed.</small></label>
        <label className="field"><span>Default working directory</span><div className="path-field"><input value={draft.workspace} onChange={event => setDraft({ ...draft, workspace: event.target.value })} placeholder="Project directory for new chats" /><button type="button" className="button" onClick={() => void choose('workspace')} disabled={saving || !praxis.api}>Browse</button></div></label>
        <label className="setting-toggle"><span><span>Bypass approvals</span><small>Run tools without approval prompts in desktop chats.</small></span><input type="checkbox" aria-label="Bypass approvals" checked={draft.bypassApprovals} onChange={event => setDraft({ ...draft, bypassApprovals: event.target.checked })} /></label>
        <div className="settings-section-title model-section">Model connection</div>
        <label className="field"><span>Model</span><input value={draft.model} onChange={event => setDraft({ ...draft, model: event.target.value })} placeholder="Use Praxis environment settings" /></label>
        <label className="field"><span>API URL</span><input value={draft.baseUrl} onChange={event => setDraft({ ...draft, baseUrl: event.target.value })} placeholder="Use Praxis environment settings" type="url" /></label>
        <label className="field"><span>API Key {praxis.info?.settings.apiKeyConfigured && <span className="saved-key">Configured</span>}</span><input value={draft.apiKey} onChange={event => setDraft({ ...draft, apiKey: event.target.value })} placeholder={praxis.info?.settings.apiKeyConfigured ? 'Leave blank to keep the current key' : 'Leave blank to use the key from the environment'} type="password" autoComplete="new-password" /></label>
        {error && <div className="field-error" role="alert"><CircleAlert size={15} /><span>{error}</span></div>}
      </div>
      <div className="dialog-footer"><span>Runtime or model changes will reconnect Praxis.</span><button type="button" className="button" disabled={saving} onClick={close}>Cancel</button><button type="submit" className="button primary" disabled={saving || !praxis.api}>{saving ? 'Saving…' : 'Save settings'}</button></div>
    </form>
  </dialog>
}

export default function App() {
  const praxis = usePraxis()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [mcpOpen, setMcpOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<SessionSummary | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(window.innerWidth <= 640)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [quotes, setQuotes] = useState<Record<string, TextQuote | undefined>>({})
  const [panel, setPanel] = useState<{ session: string; target: PanelTarget }>()
  const [compactPanel, setCompactPanel] = useState(window.innerWidth <= 1100)
  const [showScroll, setShowScroll] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const stickToBottom = useRef(true)
  const downwardIntentUntil = useRef(0)
  const lastScrollTop = useRef(0)
  const previewTrigger = useRef<HTMLElement | null>(null)
  const disclosureSessions = useRef(new Map<string, Map<string, boolean>>())
  const disclosures = useMemo(() => {
    const key = praxis.activeId || 'new'
    if (!disclosureSessions.current.has(key)) disclosureSessions.current.set(key, new Map())
    return disclosureSessions.current.get(key)!
  }, [praxis.activeId])
  const draftKey = praxis.activeId || `new:${praxis.workspace}`
  const draft = drafts[draftKey] || ''
  const active = praxis.active
  const workspace = active?.summary?.workspace || praxis.workspace
  const quote = quotes[draftKey]
  const panelTarget = panel?.session === draftKey ? panel.target : undefined
  const changes = useMemo(() => collectTurnChanges(active?.messages || [], workspace), [active?.messages, workspace])
  const currentChanges = changes.find(turn => turn.turnId === active?.activeTurnId)
  const openPanel = useCallback((target: PanelTarget) => {
    if (!panel) previewTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    stickToBottom.current = false
    setPanel({ session: draftKey, target })
  }, [draftKey, panel])
  const closePanel = useCallback(() => {
    setPanel(undefined)
    requestAnimationFrame(() => {
      if (previewTrigger.current?.isConnected) previewTrigger.current.focus({ preventScroll: true })
      else textareaRef.current?.focus({ preventScroll: true })
    })
  }, [])
  const openFile = useCallback((path: string) => openPanel({ type: 'file', path, turnId: active?.activeTurnId }), [openPanel, active?.activeTurnId])
  const openChanges = useCallback((turnId: string, fileId?: string) => openPanel({ type: 'changes', turnId, fileId }), [openPanel])
  const fileNavigation = useMemo(() => ({ workspace, openFile, onError: praxis.setError }), [workspace, openFile, praxis.setError])
  const addQuote = useCallback((value: TextQuote) => {
    if (praxis.sending) return
    setQuotes(previous => ({ ...previous, [draftKey]: value }))
    requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }))
  }, [draftKey, praxis.sending])
  const busy = isBusy(active?.summary?.status)
  const stopping = active?.summary?.status === 'stopping'
  const connected = praxis.connection.state === 'connected'
  const loading = praxis.loadingSession === praxis.activeId && Boolean(praxis.activeId)
  const empty = !active?.messages.length && !loading && !busy
  const ready = connected && !loading && praxis.configured !== false
  const mcpCommand = draft.trim().toLowerCase() === '/mcp'
  const deleteCommand = draft.trim().toLowerCase() === '/delete'
  const canSubmit = mcpCommand || deleteCommand ? connected : ready && !praxis.sending && !stopping
  const setDraft = (text: string) => setDrafts(previous => ({ ...previous, [draftKey]: text }))
  const syncScrollState = useCallback(() => {
    const container = scrollRef.current
    if (!container) return
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 24
    setShowScroll(!nearBottom)
  }, [])

  useEffect(() => {
    const compact = window.matchMedia('(max-width: 640px)')
    const onChange = (event: MediaQueryListEvent) => setSidebarCollapsed(event.matches)
    compact.addEventListener('change', onChange)
    return () => compact.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    const media = window.matchMedia('(max-width: 1100px)')
    const resize = () => setCompactPanel(media.matches)
    media.addEventListener('change', resize)
    return () => media.removeEventListener('change', resize)
  }, [])

  useEffect(() => { setPanel(undefined) }, [draftKey])

  useEffect(() => {
    const removed = praxis.removedSessionIds
    setDrafts(previous => Object.keys(previous).some(id => removed.has(id)) ? Object.fromEntries(Object.entries(previous).filter(([id]) => !removed.has(id))) : previous)
    setQuotes(previous => Object.keys(previous).some(id => removed.has(id)) ? Object.fromEntries(Object.entries(previous).filter(([id]) => !removed.has(id))) : previous)
    for (const id of removed) disclosureSessions.current.delete(id)
    if (deleteTarget && removed.has(deleteTarget.id)) setDeleteTarget(null)
  }, [praxis.conversations])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n' && !event.shiftKey && !settingsOpen && !mcpOpen && !deleteTarget && !document.querySelector('dialog[open]')) {
        event.preventDefault(); praxis.newChat(); requestAnimationFrame(() => textareaRef.current?.focus())
      }
      if ((event.ctrlKey || event.metaKey) && event.key === ',') { event.preventDefault(); setSettingsOpen(true) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [praxis.newChat, settingsOpen, mcpOpen, deleteTarget])

  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea) { textarea.style.height = 'auto'; textarea.style.height = `${Math.min(textarea.scrollHeight, empty ? 176 : 140)}px` }
  }, [draft, empty])

  useLayoutEffect(() => {
    stickToBottom.current = true
    setShowScroll(false)
    const container = scrollRef.current
    if (container) container.scrollTop = container.scrollHeight
  }, [praxis.activeId])

  useLayoutEffect(() => {
    if (!stickToBottom.current) return
    const container = scrollRef.current
    if (container) container.scrollTop = container.scrollHeight
  }, [active?.messages, active?.approvals, active?.plansByTurn, loading])

  useEffect(() => {
    const container = scrollRef.current
    if (!container) return
    // Layout changes update the affordance, not the user's scroll intent.
    let frame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (stickToBottom.current) container.scrollTop = container.scrollHeight
        container.closest<HTMLElement>('.conversation-body')?.style.setProperty('--scrollbar-width', `${container.offsetWidth - container.clientWidth}px`)
        syncScrollState()
      })
    })
    observer.observe(container)
    if (container.firstElementChild) observer.observe(container.firstElementChild)
    return () => { observer.disconnect(); cancelAnimationFrame(frame) }
  }, [syncScrollState])

  const submit = async () => {
    if (!draft.trim() || !canSubmit) return
    if (mcpCommand) {
      setDraft('')
      setMcpOpen(true)
      return
    }
    if (deleteCommand) {
      setDraft('')
      if (active?.summary) setDeleteTarget(active.summary)
      else praxis.setError('Open a chat to delete it.')
      return
    }
    const key = draftKey
    const content = draft
    const selectedQuote = quote
    setDrafts(previous => ({ ...previous, [key]: '' }))
    stickToBottom.current = true
    const result = await praxis.send(formatQuotedInput(content, selectedQuote))
    if (!result.success && !praxis.removedSessionIds.has(result.sessionId || key)) {
      setDrafts(previous => {
        const destination = result.sessionId || key
        return { ...previous, [destination]: previous[destination] ? `${content}\n\n${previous[destination]}` : content }
      })
      if (selectedQuote && result.sessionId && result.sessionId !== key) setQuotes(previous => ({ ...previous, [result.sessionId!]: selectedQuote }))
    } else if (selectedQuote) setQuotes(previous => previous[key] === selectedQuote ? { ...previous, [key]: undefined } : previous)
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const connectionProblem = !connected && praxis.connection.state !== 'connecting'
  const title = active?.summary?.title || 'New chat'
  const showNavigation = !loading && Boolean(active?.messages.some(message => message.role === 'user')) && !(panelTarget && compactPanel)
  return <ApprovalProvider approvals={active?.approvals || []} onRespond={praxis.approve}><div className={`app ${sidebarCollapsed ? 'sidebar-is-collapsed' : ''}`}>
    <Sidebar praxis={praxis} collapsed={sidebarCollapsed} toggleSidebar={() => setSidebarCollapsed(value => !value)} openSettings={() => setSettingsOpen(true)} onDelete={setDeleteTarget} />
    <DeleteChatDialog session={deleteTarget ? praxis.conversations[deleteTarget.id]?.summary || deleteTarget : null} close={() => setDeleteTarget(null)} confirm={id => { void praxis.deleteSession(id) }} />
    <main className="main">
      <header className="titlebar">
        <div className="titlebar-leading">{sidebarCollapsed && <IconButton label="Expand sidebar" onClick={() => setSidebarCollapsed(false)}><PanelLeft size={16} /></IconButton>}<span className="titlebar-title" title={title}>{title}</span></div>
        <div className="titlebar-actions">{currentChanges && <button type="button" className="changes-trigger" aria-label="View changes for this turn" aria-expanded={panelTarget?.type === 'changes' && panelTarget.turnId === currentChanges.turnId} onClick={() => openChanges(currentChanges.turnId)}><GitCompareArrows size={14} /><span>View changes</span><span>{currentChanges.files.length}</span></button>}{sidebarCollapsed && <IconButton label="New chat" onClick={praxis.newChat}><Plus size={16} /></IconButton>}
        <div className="window-controls"><IconButton label="Minimize" onClick={() => praxis.api?.windowAction('minimize')}><Minus size={16} /></IconButton><IconButton label="Maximize or restore" onClick={() => praxis.api?.windowAction('maximize')}><Maximize2 size={14} /></IconButton><IconButton label="Close window" className="window-close" onClick={() => praxis.api?.windowAction('close')}><X size={16} /></IconButton></div>
        </div>
      </header>

      {(connectionProblem || praxis.configured === false) && <div className="connection-banner" role="status"><CircleAlert size={16} /><span>{connectionProblem ? praxis.connection.message || 'Unable to connect to local Praxis. Check your runtime settings.' : 'No model API key configured. Add one in Settings or the Praxis environment.'}</span><button type="button" onClick={() => setSettingsOpen(true)}>Open settings</button>{connectionProblem && praxis.api && <button type="button" onClick={() => { void praxis.api.restart().catch(error => praxis.setError(errorMessage(error))) }}>Reconnect</button>}</div>}

      <div className={`workspace-content ${panelTarget ? 'has-panel' : ''} ${showNavigation ? 'has-navigation' : ''}`}>
      <div className={`conversation-body ${empty ? 'is-new' : ''}`} inert={Boolean(panelTarget && compactPanel)}>
      <div className="transcript" ref={scrollRef} onScroll={() => {
        const container = scrollRef.current
        if (container) {
          const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 24
          if (!nearBottom) stickToBottom.current = false
          else if (performance.now() < downwardIntentUntil.current && container.scrollTop >= lastScrollTop.current) stickToBottom.current = true
          lastScrollTop.current = container.scrollTop
        }
        syncScrollState()
      }} onWheel={event => {
        if (event.deltaY < 0) { stickToBottom.current = false; downwardIntentUntil.current = 0 }
        else if (event.deltaY > 0) downwardIntentUntil.current = performance.now() + 350
      }} onPointerDown={event => {
        if (event.target === event.currentTarget) downwardIntentUntil.current = performance.now() + 2000
      }} onClickCapture={event => {
        if (event.target instanceof Element && event.target.closest('summary, .process-summary')) stickToBottom.current = false
      }} onKeyDownCapture={event => {
        if (['End', 'PageDown', 'ArrowDown'].includes(event.key)) downwardIntentUntil.current = performance.now() + 350
        if (['Home', 'PageUp', 'ArrowUp'].includes(event.key)) { stickToBottom.current = false; downwardIntentUntil.current = 0 }
        if ((event.key === 'Enter' || event.key === ' ') && event.target instanceof Element && event.target.closest('summary, .process-summary')) stickToBottom.current = false
      }}>
        <ReadingAnchor container={scrollRef} following={stickToBottom}><div className="transcript-content">
          <DisclosureState.Provider value={disclosures}>
          <FileNavigationContext.Provider value={fileNavigation}>
          {loading ? <div className="transcript-skeleton" aria-label="Loading chat history"><i /><i /><i /><i /></div> : empty ? <div className="empty-state"><h1><img className="welcome-wordmark" src={praxisWordmark} alt="Praxis" width={340} height={97} /></h1></div> : active && <Transcript key={praxis.activeId} conversation={active} changes={changes} onChanges={openChanges} />}
          {!loading && active && busy && !active.approvals.length && <ExecutionBar key={`${praxis.activeId}:${active.activeTurnId || 'current'}`} conversation={active} />}
          </FileNavigationContext.Provider>
          </DisclosureState.Provider>
          {active && active.pendingInputs.length > 0 && <section className="paused-inputs"><div className="detail-label">Pending messages</div>{active.pendingInputs.map(item => <div key={item.command_id}><span>{item.content}</span><button onClick={() => void praxis.deleteInput(item.command_id)}>Remove</button></div>)}{!busy && <button onClick={() => void praxis.resumeInputs()}>Resume</button>}</section>}
        </div></ReadingAnchor>
      </div>

      <div className="composer-region">
        <div className="transcript-bottom-mask" data-visible={showScroll} aria-hidden="true" />
        {showScroll && <button type="button" className="scroll-bottom" aria-label="Scroll to latest message" title="Scroll to latest message" onClick={() => { const container = scrollRef.current; if (container) container.scrollTop = container.scrollHeight; stickToBottom.current = true; setShowScroll(false) }}><ArrowDown size={18} aria-hidden="true" /></button>}
        {praxis.error && <div className="composer-error" role="alert"><CircleAlert size={14} /><span>{praxis.error}</span>{praxis.deleteFailure && <button type="button" className="button" onClick={() => void praxis.deleteSession(praxis.deleteFailure!)}>Retry deletion</button>}<IconButton label="Dismiss error" onClick={() => praxis.setError('')}><X size={13} /></IconButton></div>}
        <ApprovalPrompt onStop={() => void praxis.stop()} stopping={stopping} />
        <form hidden={Boolean(active?.approvals.length)} className={`composer ${busy ? 'composer-running' : ''}`} onSubmit={event => { event.preventDefault(); void submit() }}>
          {quote && <div className="quote-draft"><details><summary><Quote size={14} /><span><strong>Quoted response</strong><span>{quote.text}</span></span><ChevronRight size={12} /></summary><blockquote>{quote.text}</blockquote></details><IconButton label="Remove quote" disabled={praxis.sending} onClick={() => setQuotes(previous => ({ ...previous, [draftKey]: undefined }))}><X size={13} /></IconButton></div>}
          <textarea ref={textareaRef} aria-label={busy ? 'Follow-up message' : 'Send message'} value={draft} onChange={event => setDraft(event.target.value)} rows={2} disabled={loading} placeholder={empty ? 'What would you like to work on?' : stopping ? 'Stopping…' : busy ? 'Add details or adjust the task…' : 'Send a message, or type / for commands'} onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void submit() }
          }} />
          <div className="composer-toolbar">
            <div className="composer-context">
              {empty ? <>
                <button type="button" className="composer-workspace" title={workspace || 'Choose workspace for a new chat'} aria-label="Choose working directory" onClick={() => void praxis.chooseWorkspace()} disabled={!praxis.api}><Folder size={14} /><span>{baseName(workspace) || 'Workspace'}</span><ChevronDown size={12} /></button>
                <span className="model-name" title={praxis.info?.settings.model || 'Praxis environment settings'}>{praxis.info?.settings.model || 'Default model'}</span>
                {praxis.info?.settings.bypassApprovals && <span className="approval-mode" title="Tools run without approval prompts">Bypass</span>}
              </> : <>
                <IconButton label="Choose working directory" onClick={() => void praxis.chooseWorkspace()} disabled={!praxis.api}><Plus size={16} /></IconButton>
                <button type="button" className="permission-button" disabled={busy || !praxis.info} title={busy ? 'Approval mode cannot be changed while a task is running' : 'Approval settings'} onClick={() => setSettingsOpen(true)}><LockKeyhole size={14} /><span>{praxis.info?.settings.bypassApprovals ? 'Auto-approve' : 'Ask for approval'}</span></button>
              </>}
            </div>
            <div className="composer-actions">{!empty && <button type="button" className="model-button" aria-label="Choose model" title="Model and settings" onClick={() => setSettingsOpen(true)}><span>{active?.summary?.model || praxis.info?.settings.model || 'Default model'}</span><ChevronDown size={12} /></button>}{busy && draft.trim() && <button type="button" className="icon-button additional-stop" aria-label="Stop" onClick={() => void praxis.stop()} disabled={stopping} title="Stop task"><Square size={10} fill="currentColor" /></button>}{busy && !draft.trim() ? <button className="send-button" type="button" aria-label="Stop" title="Stop task" disabled={stopping} onClick={() => void praxis.stop()}><Square size={10} fill="currentColor" /></button> : <button className="send-button" type="submit" aria-label={busy ? 'Send follow-up' : 'Send message'} title="Send message · Enter" disabled={!draft.trim() || !canSubmit}>{praxis.sending ? <LoaderCircle className="spin" size={16} /> : <ArrowUp size={18} />}</button>}</div>
          </div>
        </form>
        <div hidden={empty || Boolean(active?.approvals.length)} className="composer-caption"><span title={workspace}><Folder size={12} /><span>{baseName(workspace) || 'Workspace'}</span></span><span>Enter to send · Shift + Enter for a new line</span></div>
      </div>
      {showNavigation && active && praxis.activeId && <ConversationRail key={`navigation:${praxis.activeId}`} sessionId={praxis.activeId} messages={active.messages} scrollRef={scrollRef} onNavigate={() => { stickToBottom.current = false; downwardIntentUntil.current = 0 }} />}
      </div>
      {panelTarget && <FilePanel key={`files:${draftKey}`} target={panelTarget} workspace={workspace} turns={changes} activeTurnId={active?.activeTurnId} onTarget={openPanel} onClose={closePanel} />}
      </div>
    </main>
    {!settingsOpen && !mcpOpen && !praxis.sending && !(panelTarget && compactPanel) && <QuoteSelection rootRef={scrollRef} sessionKey={draftKey} onQuote={addQuote} />}
    <SettingsDialog praxis={praxis} open={settingsOpen} close={() => setSettingsOpen(false)} />
    {mcpOpen && <McpStatusDialog close={() => { setMcpOpen(false); requestAnimationFrame(() => textareaRef.current?.focus()) }} />}
  </div></ApprovalProvider>
}
