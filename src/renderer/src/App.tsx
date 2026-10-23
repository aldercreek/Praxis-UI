import { memo, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, Check, CheckCheck, ChevronDown, ChevronRight, Circle, CircleAlert, Copy, Folder, GitBranch, LoaderCircle, Maximize2, Minus, PanelLeft, Plus, Search, Settings2, ShieldCheck, Square, X } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import praxisMark from '../../../resources/brand/praxis-mark.svg'
import praxisWordmark from '../../../resources/brand/praxis-wordmark.svg'
import type { Approval, DesktopSettings } from '../../shared/protocol'
import { isBusy, isChildAgent, type DisplayMessage, type PlanStep } from './state'
import { groupTranscript, presentTool } from './toolPresentation'
import { baseName, errorMessage, usePraxis } from './usePraxis'

type Praxis = ReturnType<typeof usePraxis>

function PraxisMark({ small = false }: { small?: boolean }) {
  return <img className="praxis-mark" aria-hidden="true" alt="" src={praxisMark} width={small ? 18 : 28} height={small ? 18 : 28} />
}

function IconButton({ label, children, onClick, disabled, className = '' }: { label: string; children: ReactNode; onClick?: () => void; disabled?: boolean; className?: string }) {
  return <button type="button" className={`icon-button ${className}`} aria-label={label} title={label} onClick={onClick} disabled={disabled}>{children}</button>
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return <IconButton label={copied ? 'Copied' : label} onClick={() => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1800)
    }).catch(() => setCopied(false))
  }}>{copied ? <Check size={13} /> : <Copy size={13} />}</IconButton>
}

function MarkdownContent({ content }: { content: string }) {
  return <div className="markdown"><Markdown remarkPlugins={[remarkGfm]} components={{
    a: ({ href, children }) => <a href={href} onClick={event => { event.preventDefault(); if (href && /^https?:\/\//i.test(href)) void window.praxis?.openExternal(href) }}>{children}</a>,
    img: ({ alt }) => <span className="image-reference">[Image{alt ? `: ${alt}` : ''}]</span>,
    pre: ({ children }) => <CodeBlock>{children}</CodeBlock>
  }}>{content}</Markdown></div>
}

function CodeBlock({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  return <div className="code-block"><pre ref={ref}>{children}</pre><button className="code-copy" type="button" aria-label="Copy code" title="Copy code" onClick={() => {
    void navigator.clipboard.writeText(ref.current?.innerText || '').then(() => setCopied(true)).catch(() => setCopied(false))
  }}>{copied ? <Check size={13} /> : <Copy size={13} />}</button></div>
}

function ToolMessage({ message }: { message: DisplayMessage }) {
  const tool = presentTool(message)
  const argument = message.arguments || {}
  return <details className={`tool-message ${tool.status === 'Failed' ? 'tool-error' : ''}`}>
    <summary aria-label={`${tool.label}${tool.target ? ` ${tool.target}` : ''} · ${tool.status}`}>
      <span className="tool-name" title={tool.name}>{tool.label}</span>
      {tool.target && <span className="tool-target" title={tool.fullTarget}>{tool.target}</span>}
      {tool.context && <span className="tool-context" title={tool.context}>{tool.context}</span>}
      {tool.status !== 'Complete' && <span className={`tool-status ${tool.status === 'Awaiting approval' ? 'tool-approval' : ''}`}>{tool.running ? <><LoaderCircle className="spin" size={12} aria-hidden="true" /><span className="visually-hidden">Running</span></> : tool.status}</span>}
      <ChevronRight className="disclosure-icon" size={12} aria-hidden="true" />
    </summary>
    <div className="tool-details">
      <div className="tool-detail-heading"><span title={tool.name}>{tool.name}</span><span>{tool.status}</span></div>
      {isChildAgent(message.agent_id) && <p className="tool-agent">Subtask · {message.agent_id}</p>}
      {tool.command && <><div className="detail-label">Command <CopyButton text={tool.command} label="Copy command" /></div><pre>{tool.command}</pre></>}
      {message.output && <><div className="detail-label">Live output</div><pre className="terminal-output">{message.output}</pre></>}
      {message.content && message.content !== message.output && <><div className="detail-label">Result <CopyButton text={message.content} /></div><pre className={['Failed', 'Denied', 'Stopped'].includes(tool.status) ? 'tool-result-prose' : undefined}>{message.content}</pre></>}
      {message.file_change?.diff && <><div className="detail-label">{message.file_change.path}<span>+{message.file_change.added} / −{message.file_change.removed}</span></div><pre className="file-diff">{message.file_change.diff.split('\n').map((line, index) => <span key={index} className={line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-remove' : ''}>{line}{'\n'}</span>)}</pre></>}
      {!message.content && !message.output && <div className="tool-waiting">{message.status === 'approval' ? 'Execution will continue after approval.' : message.status === 'denied' ? 'This tool call was denied.' : message.status === 'cancelled' ? 'Tool execution stopped.' : tool.running || message.status === 'pending' ? 'Waiting for tool results…' : 'No output.'}</div>}
      {Object.keys(argument).length > 0 && <details className="tool-arguments"><summary><ChevronRight className="disclosure-icon" size={12} aria-hidden="true" />Parameters</summary><pre>{JSON.stringify(argument, null, 2)}</pre></details>}
    </div>
  </details>
}

const Transcript = memo(function Transcript({ messages }: { messages: DisplayMessage[] }) {
  return groupTranscript(messages).map(item => item.role === 'tool-group'
    ? <details className="tool-group" key={item.id}>
      <summary><span className="tool-group-label">Explored workspace</span><span className="tool-context">{item.messages.length} steps</span><ChevronRight className="disclosure-icon" size={12} aria-hidden="true" /></summary>
      <div className="tool-group-items">{item.messages.map(message => <ToolMessage key={message.id} message={message} />)}</div>
    </details>
    : <Message key={item.id} message={item} />)
})

const Message = memo(function Message({ message }: { message: DisplayMessage }) {
  if (message.role === 'tool') return <ToolMessage message={message} />
  if (message.role === 'system') return <div className={`system-message ${message.error ? 'error-text' : ''}`}>
    {message.error ? <CircleAlert size={14} /> : message.agent_id ? <GitBranch size={14} /> : <Square size={11} />}
    <span>{message.content}{message.agent_id && <span className="muted"> · {message.status || message.agent_id}</span>}</span>
  </div>
  const deliveryStatus = ['queued', 'sending', 'paused'].includes(message.status || '')
  return <article className={`message message-${message.role}`} aria-label={message.role === 'user' ? 'Your message' : 'Assistant response'}>
    {(isChildAgent(message.agent_id) || deliveryStatus) && <div className="message-label">
      {isChildAgent(message.agent_id) && <span>Subtask · {message.agent_id}</span>}
      {message.status === 'queued' && <span className="queued-label">Queued</span>}
      {message.status === 'sending' && <span className="queued-label">Sending</span>}
      {message.status === 'paused' && <span className="queued-label">Not received</span>}
    </div>}
    {message.role === 'user' ? <div className="user-content">{message.content}</div> : <MarkdownContent content={message.content} />}
    {message.role === 'assistant' && message.status !== 'streaming' && <div className="message-actions"><CopyButton text={message.content} label="Copy response" /></div>}
  </article>
})

function Plan({ plan, busy }: { plan: PlanStep[]; busy: boolean }) {
  const completed = plan.filter(step => step.status === 'completed').length
  return <details className="plan" open>
    <summary><ChevronRight className="disclosure-icon" size={13} /><CheckCheck size={14} /><span>Task plan</span><span className="muted">{completed} / {plan.length}</span></summary>
    <ol>{plan.map((step, index) => <li key={index} className={step.status}>{step.status === 'completed' ? <Check size={13} /> : step.status === 'in_progress' && busy ? <LoaderCircle size={13} className="spin" /> : <Circle size={12} />}<span>{step.description}</span></li>)}</ol>
  </details>
}

function ApprovalPrompt({ approval, onRespond }: { approval: Approval; onRespond: (id: string, approved: boolean) => Promise<void> }) {
  const [pending, setPending] = useState(false)
  const respond = async (approved: boolean) => {
    setPending(true)
    try { await onRespond(approval.approval_id, approved) } catch { setPending(false) }
  }
  return <section className="approval-prompt" aria-label="Tool approval">
    <div className="approval-heading"><ShieldCheck size={16} /><strong>Allow this action?</strong></div>
    <p><code>{approval.tool_name}</code>{isChildAgent(approval.agent_id) ? ' · Subtask request' : ''}</p>
    <pre>{JSON.stringify(approval.arguments, null, 2)}</pre>
    <div className="approval-actions"><span>This action requires your approval</span><button type="button" className="button" disabled={pending} onClick={() => void respond(false)}>Deny</button><button type="button" className="button primary" disabled={pending} onClick={() => void respond(true)}>{pending ? 'Submitting…' : 'Allow'}</button></div>
  </section>
}

function Sidebar({ praxis, openSettings, collapsed, toggleSidebar }: { praxis: Praxis; openSettings: () => void; collapsed: boolean; toggleSidebar: () => void }) {
  const [query, setQuery] = useState('')
  const sessions = praxis.sessions.filter(session => session.title.toLowerCase().includes(query.toLowerCase()))
  return <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`} aria-label="Session navigation">
    <div className="brand-row"><span className="brand"><span className="brand-symbol"><PraxisMark small /></span>Praxis</span><IconButton label="Collapse sidebar" onClick={toggleSidebar}><PanelLeft size={16} /></IconButton></div>
    <div className="sidebar-content">
      <button type="button" className="workspace-picker" onClick={() => void praxis.chooseWorkspace()} title={praxis.workspace || 'Choose working directory'} disabled={!praxis.api}><Folder size={16} /><span>{praxis.workspace ? baseName(praxis.workspace) : 'Choose working directory'}</span><ChevronDown size={13} /></button>
      <button type="button" className="new-chat" onClick={praxis.newChat}><Plus size={16} /><span>New chat</span><kbd>Ctrl N</kbd></button>
      <label className="session-search"><Search size={14} /><input aria-label="Search chats" placeholder="Search chats" value={query} onChange={event => setQuery(event.target.value)} />{query && <IconButton label="Clear search" onClick={() => setQuery('')}><X size={12} /></IconButton>}</label>
      <div className="sidebar-section-label">Recent chats</div>
      <div className="session-list">
        {praxis.listing && sessions.length === 0 ? <div className="session-skeleton" aria-label="Loading chats"><i /><i /><i /></div> : sessions.length === 0 ? <div className="sidebar-empty">{query ? 'No matching chats' : 'Your conversations will appear here.'}</div> : sessions.map(session => {
          const pendingApproval = praxis.conversations[session.id]?.approvals.length > 0
          return <button key={session.id} type="button" className={`session-item ${session.id === praxis.activeId ? 'selected' : ''}`} aria-current={session.id === praxis.activeId ? 'page' : undefined} onClick={() => void praxis.openSession(session.id)} title={session.title}>
            <span>{session.title || 'New chat'}</span>
            {isBusy(session.status) && <span className={`session-dot ${pendingApproval ? 'approval-dot' : ''}`} aria-label={pendingApproval ? 'Awaiting approval' : 'Running'} />}
            {session.status === 'failed' && <CircleAlert size={12} className="error-text" />}
          </button>
        })}
      </div>
    </div>
    <div className="sidebar-footer"><button type="button" onClick={openSettings}><Settings2 size={16} /><span>Settings</span><kbd>Ctrl ,</kbd></button></div>
  </aside>
}

function SettingsDialog({ praxis, open, close }: { praxis: Praxis; open: boolean; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [draft, setDraft] = useState({ praxisPath: '', pythonPath: '', workspace: '', model: '', baseUrl: '', apiKey: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (open) {
      const settings = praxis.info?.settings
      if (settings) setDraft({ praxisPath: settings.praxisPath, pythonPath: settings.pythonPath, workspace: settings.workspace, model: settings.model, baseUrl: settings.baseUrl, apiKey: '' })
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
    try { await praxis.saveSettings(changed); close() } catch (error) { setError(errorMessage(error)) } finally { setSaving(false) }
  }
  return <dialog ref={ref} className="settings-dialog" onCancel={event => { if (saving) event.preventDefault(); else close() }} onClose={close} aria-labelledby="settings-title">
    <form onSubmit={event => void save(event)}>
      <div className="dialog-header"><div><h2 id="settings-title">Settings <span className="version">{praxis.info ? `v${praxis.info.version}` : ''}</span></h2><p>Connect to local Praxis and configure your workspace.</p></div><IconButton label="Close settings" disabled={saving} onClick={close}><X size={18} /></IconButton></div>
      <div className="settings-fields">
        <div className="settings-section-title">Local runtime</div>
        <label className="field"><span>Praxis project directory</span><div className="path-field"><input required value={draft.praxisPath} onChange={event => setDraft({ ...draft, praxisPath: event.target.value })} placeholder="Choose your local Praxis project" /><button type="button" className="button" onClick={() => void choose('praxis')} disabled={saving || !praxis.api}>Browse</button></div></label>
        <label className="field"><span>Python interpreter</span><div className="path-field"><input value={draft.pythonPath} onChange={event => setDraft({ ...draft, pythonPath: event.target.value })} placeholder="Use Python from Praxis/.venv automatically" /><button type="button" className="button" onClick={() => void choose('python')} disabled={saving || !praxis.api}>Browse</button></div><small>Use a Python environment with Praxis dependencies installed.</small></label>
        <label className="field"><span>Default working directory</span><div className="path-field"><input value={draft.workspace} onChange={event => setDraft({ ...draft, workspace: event.target.value })} placeholder="Project directory for new chats" /><button type="button" className="button" onClick={() => void choose('workspace')} disabled={saving || !praxis.api}>Browse</button></div></label>
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(window.innerWidth < 900)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [showScroll, setShowScroll] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const stickToBottom = useRef(true)
  const draftKey = praxis.activeId || `new:${praxis.workspace}`
  const draft = drafts[draftKey] || ''
  const active = praxis.active
  const busy = isBusy(active?.summary?.status)
  const toolActivityVisible = active?.messages.some(message => message.role === 'tool' && ['running', 'pending', 'approval'].includes(message.status || ''))
  const stopping = active?.summary?.status === 'stopping'
  const connected = praxis.connection.state === 'connected'
  const loading = praxis.loadingSession === praxis.activeId && Boolean(praxis.activeId)
  const ready = connected && !loading && praxis.configured !== false
  const setDraft = (text: string) => setDrafts(previous => ({ ...previous, [draftKey]: text }))

  useEffect(() => {
    const compact = window.matchMedia('(max-width: 899px)')
    const onChange = (event: MediaQueryListEvent) => setSidebarCollapsed(event.matches)
    compact.addEventListener('change', onChange)
    return () => compact.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n' && !event.shiftKey && !settingsOpen) {
        event.preventDefault(); praxis.newChat(); requestAnimationFrame(() => textareaRef.current?.focus())
      }
      if ((event.ctrlKey || event.metaKey) && event.key === ',') { event.preventDefault(); setSettingsOpen(true) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [praxis.newChat, settingsOpen])

  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea) { textarea.style.height = 'auto'; textarea.style.height = `${Math.min(textarea.scrollHeight, 176)}px` }
  }, [draft])

  useEffect(() => {
    stickToBottom.current = true
    setShowScroll(false)
    requestAnimationFrame(() => {
      const container = scrollRef.current
      if (container) container.scrollTop = container.scrollHeight
    })
  }, [praxis.activeId])

  useEffect(() => {
    if (!stickToBottom.current) return
    const container = scrollRef.current
    if (container) container.scrollTop = container.scrollHeight
  }, [active?.messages, active?.approvals, active?.plan, loading])

  const submit = async () => {
    if (!draft.trim() || !ready || praxis.sending || stopping) return
    const key = draftKey
    const content = draft
    setDrafts(previous => ({ ...previous, [key]: '' }))
    stickToBottom.current = true
    const result = await praxis.send(content)
    if (!result.success) setDrafts(previous => ({ ...previous, [result.sessionId || key]: content }))
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const connectionProblem = !connected && praxis.connection.state !== 'connecting'
  const title = active?.summary?.title || 'New chat'
  const empty = !active?.messages.length && !loading && !busy
  return <div className={`app ${sidebarCollapsed ? 'sidebar-is-collapsed' : ''}`}>
    <Sidebar praxis={praxis} collapsed={sidebarCollapsed} toggleSidebar={() => setSidebarCollapsed(value => !value)} openSettings={() => setSettingsOpen(true)} />
    <main className="main">
      <header className="titlebar">
        <div className="titlebar-leading">{sidebarCollapsed && <IconButton label="Expand sidebar" onClick={() => setSidebarCollapsed(false)}><PanelLeft size={16} /></IconButton>}<span className="titlebar-title" title={title}>{title}</span>{busy && <span className="toolbar-status">{stopping ? 'Stopping' : 'In progress'}</span>}</div>
        <div className="titlebar-actions">{sidebarCollapsed && <IconButton label="New chat" onClick={praxis.newChat}><Plus size={17} /></IconButton>}
        <div className="window-controls"><IconButton label="Minimize" onClick={() => praxis.api?.windowAction('minimize')}><Minus size={15} /></IconButton><IconButton label="Maximize or restore" onClick={() => praxis.api?.windowAction('maximize')}><Maximize2 size={12} /></IconButton><IconButton label="Close window" className="window-close" onClick={() => praxis.api?.windowAction('close')}><X size={16} /></IconButton></div>
        </div>
      </header>

      {(connectionProblem || praxis.configured === false) && <div className="connection-banner" role="status"><CircleAlert size={16} /><span>{connectionProblem ? praxis.connection.message || 'Unable to connect to local Praxis. Check your runtime settings.' : 'No model API key configured. Add one in Settings or the Praxis environment.'}</span><button type="button" onClick={() => setSettingsOpen(true)}>Open settings</button>{connectionProblem && praxis.api && <button type="button" onClick={() => { void praxis.api.restart().catch(error => praxis.setError(errorMessage(error))) }}>Reconnect</button>}</div>}

      <div className={`conversation-body ${empty ? 'is-new' : ''}`}>
      <div className="transcript" ref={scrollRef} onScroll={() => {
        const container = scrollRef.current
        if (!container) return
        const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 96
        stickToBottom.current = nearBottom
        setShowScroll(!nearBottom)
      }}>
        <div className="transcript-content">
          {loading ? <div className="transcript-skeleton" aria-label="Loading chat history"><i /><i /><i /><i /></div> : empty ? <div className="empty-state"><h1><img className="welcome-wordmark" src={praxisWordmark} alt="Praxis" width={340} height={97} /></h1></div> : active && <Transcript messages={active.messages} />}
          {active && active.plan.length > 0 && <Plan plan={active.plan} busy={busy} />}
          {active?.approvals.map(approval => <ApprovalPrompt key={approval.approval_id} approval={approval} onRespond={praxis.approve} />)}
          {active && active.pausedInputs.length > 0 && <section className="paused-inputs"><div className="detail-label">These follow-up messages were not received. Copy them to send again.</div>{active.pausedInputs.map((text, index) => <div key={index}><span>{text}</span><CopyButton text={text} label="Copy unsent message" /></div>)}</section>}
          {busy && !toolActivityVisible && <div className="activity" role="status"><LoaderCircle size={13} className="spin" /><span>{active?.activity || 'Running'}</span></div>}
        </div>
      </div>

      <div className="composer-region">
        {showScroll && <button type="button" className="scroll-bottom" onClick={() => { const container = scrollRef.current; if (container) container.scrollTop = container.scrollHeight; stickToBottom.current = true; setShowScroll(false) }}><ArrowDown size={14} />Jump to latest message</button>}
        {praxis.error && <div className="composer-error" role="alert"><CircleAlert size={14} /><span>{praxis.error}</span><IconButton label="Dismiss error" onClick={() => praxis.setError('')}><X size={13} /></IconButton></div>}
        <form className={`composer ${busy ? 'composer-running' : ''}`} onSubmit={event => { event.preventDefault(); void submit() }}>
          <textarea ref={textareaRef} aria-label={busy ? 'Follow-up message' : 'Send message'} value={draft} onChange={event => setDraft(event.target.value)} rows={2} disabled={loading} placeholder={stopping ? 'Stopping task…' : busy ? 'Add details or adjust the task…' : 'What would you like to work on?'} onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void submit() }
          }} />
          <div className="composer-toolbar"><div className="composer-context"><button type="button" className="composer-workspace" title={active?.summary?.workspace || praxis.workspace || 'Choose workspace for a new chat'} aria-label="Choose working directory" onClick={() => void praxis.chooseWorkspace()} disabled={!praxis.api}><Folder size={14} /><span>{baseName(active?.summary?.workspace || praxis.workspace) || 'Workspace'}</span><ChevronDown size={12} /></button><span className="model-name" title={active?.summary?.model || praxis.info?.settings.model || 'Praxis environment settings'}>{active?.summary?.model || praxis.info?.settings.model || 'Default model'}</span></div><div className="composer-actions">{busy && <button type="button" className="stop-button" onClick={() => void praxis.stop()} disabled={stopping} title="Stop current task"><Square size={10} fill="currentColor" />{stopping ? 'Stopping' : 'Stop'}</button>}<button className="send-button" type="submit" aria-label={busy ? 'Send follow-up' : 'Send message'} title={busy ? 'Send follow-up' : 'Send message (Enter)'} disabled={!draft.trim() || !ready || praxis.sending || stopping}>{praxis.sending ? <LoaderCircle className="spin" size={16} /> : <ArrowUp size={18} />}</button></div></div>
        </form>
      </div>
      </div>
    </main>
    <SettingsDialog praxis={praxis} open={settingsOpen} close={() => setSettingsOpen(false)} />
  </div>
}
