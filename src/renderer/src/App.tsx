import { memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, CircleAlert, Copy, FileText, Folder, GitBranch, GitCompareArrows, Images, ListChecks, LoaderCircle, Maximize2, Minus, PanelLeft, Pencil, Plus, Quote, Search, Settings2, ShieldCheck, Square, SquareTerminal, X } from 'lucide-react'
import praxisMark from '../../../resources/brand/praxis-mark.svg'
import praxisWordmark from '../../../resources/brand/praxis-wordmark.svg'
import type { Approval, DesktopSettings, SessionSummary } from '../../shared/protocol'
import { isBusy, isChildAgent, type Conversation, type DisplayMessage, type PlanStep } from './state'
import { presentTool, type ToolGroup, type ToolKind } from './toolPresentation'
import { isProcessItem, presentTranscript, processLabel, type TranscriptTurn } from './transcriptPresentation'
import { baseName, errorMessage, usePraxis } from './usePraxis'
import { Disclosure, DisclosureState, useDisclosure } from './Disclosure'
import { ExecutionBar, TurnPlan } from './ExecutionBar'
import { FileNavigationContext, MarkdownContent } from './MarkdownContent'
import { FilePanel, type PanelTarget } from './FilePanel'
import { collectTurnChanges, fileChangePreviewPath, type TurnChanges } from './changeSummary'
import { QuoteSelection, type TextQuote } from './QuoteSelection'
import { formatQuotedInput, readQuotedInput } from './quotedInput'
import { McpStatusDialog } from './McpStatusDialog'
import { ConversationRail } from './ConversationRail'
import { ChatActions, DeleteChatDialog } from './DeleteChat'

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

function ToolIcon({ kind, failed = false }: { kind: ToolKind; failed?: boolean }) {
  const Icon = failed ? CircleAlert : { read: FileText, search: Search, edit: Pencil, command: SquareTerminal, image: Images, tool: ListChecks }[kind]
  return <Icon size={14} className="tool-icon" aria-hidden="true" />
}

function ToolMessage({ message }: { message: DisplayMessage }) {
  const files = useContext(FileNavigationContext)
  const tool = presentTool(message)
  const argument = message.arguments || {}
  const isCommand = tool.kind === 'command'
  const detailTitle = { command: 'Shell', read: '文件内容', search: '搜索结果', edit: '文件更改', image: '图片', tool: tool.name }[tool.kind]
  const resultText = message.content !== message.output ? message.content : ''
  const hasDiff = Boolean(message.file_change?.diff)
  const previewPath = fileChangePreviewPath(message)
  const deferResult = hasDiff && tool.status === 'Complete'
  const detailText = [tool.command, message.output, resultText, message.file_change?.diff].filter(Boolean).join('\n\n')
  return <Disclosure storageKey={message.id} data-message-id={message.id} className={`tool-message ${tool.status === 'Failed' ? 'tool-error' : tool.status === 'Awaiting approval' ? 'tool-approval' : ''}`}>
    <summary>
      <ToolIcon kind={tool.kind} failed={tool.status === 'Failed'} />
      <span className="tool-summary" title={tool.fullTarget || tool.summary}>{tool.summary}</span>
      <ChevronRight className="disclosure-icon" size={12} aria-hidden="true" />
    </summary>
    <div className="tool-details">
      <div className="tool-detail-heading"><span title={tool.name}>{detailTitle}</span><span className="tool-detail-meta">{tool.status !== 'Complete' && <span>{tool.statusLabel}</span>}{detailText && <CopyButton text={detailText} label="Copy tool details" />}</span></div>
      {isChildAgent(message.agent_id) && <p className="tool-agent">子任务 · {message.agent_id}</p>}
      {!deferResult && (tool.command || message.output || resultText) && <div className={isCommand ? 'tool-log' : 'tool-content'} tabIndex={isCommand ? 0 : undefined} role={isCommand ? 'region' : undefined} aria-label={isCommand ? 'Shell output' : undefined}>
        {tool.command && <pre className="command-line"><span className="command-prompt" aria-hidden="true">$ </span>{tool.command}</pre>}
        {message.output && <pre className="terminal-output">{message.output}</pre>}
        {resultText && <pre className={tool.kind === 'edit' || (!isCommand && ['Failed', 'Denied', 'Stopped'].includes(tool.status)) ? 'tool-result-prose' : undefined}>{resultText}</pre>}
      </div>}
      {message.file_change?.diff && <div className="tool-file-change"><div className="detail-label"><button type="button" className="file-path-button" disabled={!previewPath} title={previewPath || '子任务未提供完整文件路径'} onClick={() => previewPath && files?.openFile(previewPath)}>{message.file_change.path}</button><span>+{message.file_change.added} / −{message.file_change.removed}</span></div><pre className="file-diff">{message.file_change.diff.split('\n').map((line, index) => <span key={index} className={line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-remove' : ''}>{line || '\u00a0'}</span>)}</pre></div>}
      {!hasDiff && !message.content && !message.output && <div className="tool-waiting">{message.status === 'approval' ? '确认后继续执行。' : message.status === 'denied' ? '已拒绝这次操作。' : message.status === 'cancelled' ? '操作已停止。' : tool.running || message.status === 'pending' ? '等待输出…' : '没有输出。'}</div>}
      {(Object.keys(argument).length > 0 || (deferResult && (message.output || resultText))) && <Disclosure storageKey={`${message.id}:arguments`} className="tool-arguments"><summary><ChevronRight className="disclosure-icon" size={12} aria-hidden="true" />{deferResult ? '执行详情' : '参数'}</summary>
        {deferResult && message.output && <pre>{message.output}</pre>}
        {deferResult && resultText && <pre className="tool-result-prose">{resultText}</pre>}
        {Object.keys(argument).length > 0 && <>{deferResult && <div className="detail-label">参数</div>}<pre>{JSON.stringify(argument, null, 2)}</pre></>}
      </Disclosure>}
    </div>
  </Disclosure>
}

function ToolActivity({ group, current }: { group: ToolGroup; current: boolean }) {
  const single = group.messages.length === 1
  const saved = useContext(DisclosureState)
  const inspecting = group.messages.some(message => saved?.get(message.id))
  const list = useRef<HTMLDivElement>(null)
  const followTail = useRef(true)
  useLayoutEffect(() => {
    if (current && !inspecting && followTail.current && list.current) list.current.scrollTop = list.current.scrollHeight
  }, [current, inspecting, group.messages])
  return <Disclosure storageKey={group.id} defaultOpen={current || inspecting} forceOpen={single}
    data-group-id={group.id} data-running={group.running}
    className={`tool-group ${single ? 'tool-group-single' : ''} ${group.attention === 'failed' ? 'tool-error' : group.attention === 'approval' ? 'tool-approval' : ''}`}>
    <summary hidden={single}><ToolIcon kind={group.kind} />
      <span className="tool-summary" title={group.summary}>{group.summary}</span>
      <ChevronRight className="disclosure-icon" size={12} aria-hidden="true" />
      {group.attentionSummary && <span className="tool-attention" title={group.attentionLabel}>{group.attentionSummary}</span>}
    </summary>
    <div className="tool-group-items" ref={list} onScroll={event => {
      const element = event.currentTarget
      followTail.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24
    }}>{group.messages.map(message => <ToolMessage key={message.id} message={message} />)}</div>
  </Disclosure>
}

function ProcessTurn({ turn, plan, changed, onChanges }: { turn: TranscriptTurn; plan?: PlanStep[]; changed?: TurnChanges; onChanges: (turnId: string) => void }) {
  const regionId = useId()
  const ref = useRef<HTMLElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useDisclosure('process:' + turn.id + (turn.finalMessageId ? ':final' : ':live'), !turn.finalMessageId)
  const hasProcess = turn.hasProcess || Boolean(plan?.length)
  const controlledIds = turn.items.flatMap((item, index) => isProcessItem(item, turn.finalMessageId) ? [regionId + '-' + index] : [])
  const failureCount = turn.items.reduce((count, item) => count + (item.role === 'tool-group' ? item.messages.filter(message => presentTool(message).status === 'Failed').length : 0), 0)
  const firstProcessIndex = turn.items.findIndex(item => isProcessItem(item, turn.finalMessageId))
  const headerIndex = firstProcessIndex < 0 ? Math.max(0, turn.items.findIndex(item => item.role !== 'user')) : firstProcessIndex
  const lastItem = turn.items.at(-1)
  useLayoutEffect(() => {
    if (!open && ref.current && [...ref.current.querySelectorAll('.process-entry[hidden]')].some(entry => entry.contains(document.activeElement))) {
      trigger.current?.focus({ preventScroll: true })
    }
  }, [open])
  return <section className="transcript-turn" ref={ref} data-turn-id={turn.id}>
    {turn.items.map((item, index) => {
      const process = isProcessItem(item, turn.finalMessageId)
      return <div className="turn-entry" key={item.id}>
        {hasProcess && index === headerIndex && <>
          <button ref={trigger} type="button" className="process-summary" aria-expanded={open}
            aria-controls={[...controlledIds, ...(plan?.length ? [regionId + '-plan'] : [])].join(' ')} onClick={() => setOpen(!open)}>
            <span>{processLabel(turn.execution)}</span><ChevronRight size={12} className="disclosure-icon" aria-hidden="true" />
            {!open && failureCount > 0 && <span className="process-attention"><CircleAlert size={12} />含失败记录</span>}
          </button>
          {plan?.length ? <div id={regionId + '-plan'} className="process-entry" hidden={!open}><TurnPlan turnId={turn.id} plan={plan} /></div> : null}
        </>}
        <div id={regionId + '-' + index} className={process ? 'process-entry' : item.id === turn.finalMessageId ? 'turn-final' : undefined} hidden={hasProcess && process && !open}>
          {item.role === 'tool-group' ? <ToolActivity group={item} current={turn.running && item === lastItem} /> : <Message message={item} />}
        </div>
      </div>
    })}
    {changed && <button type="button" className="turn-changes-summary" onClick={() => onChanges(changed.turnId)}><GitCompareArrows size={14} /><span>修改了 {changed.files.length} 个文件</span><ChevronRight size={12} /></button>}
  </section>
}

const Transcript = memo(function Transcript({ conversation, changes, onChanges }: { conversation: Conversation; changes: TurnChanges[]; onChanges: (turnId: string) => void }) {
  return presentTranscript(conversation).map(turn => <ProcessTurn key={turn.id} turn={turn}
    plan={turn.id !== conversation.activeTurnId ? conversation.plansByTurn[turn.id] : undefined}
    changed={changes.find(change => change.turnId === turn.id)} onChanges={onChanges} />)
})

const Message = memo(function Message({ message }: { message: DisplayMessage }) {
  if (message.role === 'tool') return <ToolMessage message={message} />
  if (message.role === 'system' && message.status === 'cancelled' && !message.agent_id) return <div className="turn-notice" role="status">{message.content}</div>
  if (message.role === 'system') return <div className={`system-message ${message.error ? 'error-text' : ''}`}>
    {message.error ? <CircleAlert size={14} /> : message.agent_id ? <GitBranch size={14} /> : <Square size={11} />}
    <span>{message.content}{message.agent_id && <span className="muted"> · {message.status || message.agent_id}</span>}</span>
  </div>
  const deliveryStatus = ['queued', 'sending', 'paused'].includes(message.status || '')
  const quoted = message.role === 'user' ? readQuotedInput(message.content) : undefined
  return <article className={`message message-${message.role}`} aria-label={message.role === 'user' ? 'Your message' : 'Assistant response'} data-nav-message-id={message.role === 'user' && !isChildAgent(message.agent_id) ? message.id : undefined} tabIndex={message.role === 'user' ? -1 : undefined} data-quote-message-id={message.role === 'assistant' && !isChildAgent(message.agent_id) ? message.id : undefined}>
    {(isChildAgent(message.agent_id) || deliveryStatus) && <div className="message-label">
      {isChildAgent(message.agent_id) && <span>Subtask · {message.agent_id}</span>}
      {message.status === 'queued' && <span className="queued-label">Queued</span>}
      {message.status === 'sending' && <span className="queued-label">Sending</span>}
      {message.status === 'paused' && <span className="queued-label">Not received</span>}
    </div>}
    {message.role === 'user' ? <div className="user-content">{quoted ? <><details className="sent-quote"><summary><Quote size={12} /><span>{quoted.quote}</span><ChevronRight size={12} /></summary><blockquote>{quoted.quote}</blockquote></details><div>{quoted.text}</div></> : message.content}</div> : <MarkdownContent content={message.content} allowRelativeFiles={!isChildAgent(message.agent_id)} streaming={message.status === 'streaming'} />}
    {message.role === 'assistant' && message.status !== 'streaming' && <div className="message-actions"><CopyButton text={message.content} label="Copy response" /></div>}
  </article>
})

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

function Sidebar({ praxis, openSettings, collapsed, toggleSidebar, onDelete }: { praxis: Praxis; openSettings: () => void; collapsed: boolean; toggleSidebar: () => void; onDelete: (session: SessionSummary) => void }) {
  const [query, setQuery] = useState('')
  const sessions = praxis.sessions.filter(session => `${session.title} ${session.workspace}`.toLowerCase().includes(query.toLowerCase()))
  const loading = praxis.listState === 'loading' && praxis.sessions.length === 0
  const failed = praxis.listState === 'error' && praxis.sessions.length === 0
  const retry = () => {
    const request = praxis.connection.state === 'connected' ? praxis.refresh() : praxis.api.restart()
    void request.catch(error => praxis.setError(errorMessage(error)))
  }
  return <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`} aria-label="Session navigation">
    <div className="brand-row"><span className="brand"><span className="brand-symbol"><PraxisMark small /></span>Praxis</span><IconButton label="Collapse sidebar" onClick={toggleSidebar}><PanelLeft size={16} /></IconButton></div>
    <div className="sidebar-content">
      <button type="button" className="workspace-picker" onClick={() => void praxis.chooseWorkspace()} title={`Default directory for new chats: ${praxis.workspace || 'Choose working directory'}`} disabled={!praxis.api}><Folder size={16} /><span>{praxis.workspace ? baseName(praxis.workspace) : 'Choose working directory'}</span><ChevronDown size={13} /></button>
      <button type="button" className="new-chat" onClick={praxis.newChat}><Plus size={16} /><span>New chat</span><kbd>Ctrl N</kbd></button>
      <label className="session-search"><Search size={14} /><input aria-label="Search chats" placeholder="Search chats" value={query} onChange={event => setQuery(event.target.value)} />{query && <IconButton label="Clear search" onClick={() => setQuery('')}><X size={12} /></IconButton>}</label>
      <div className="sidebar-section-label">Recent chats</div>
      <div className="session-list" aria-busy={loading}>
        {loading ? <div className="session-skeleton" role="status" aria-label="Loading chats"><i aria-hidden="true" /><i aria-hidden="true" /><i aria-hidden="true" /><i aria-hidden="true" /></div>
          : failed ? <div className="sidebar-empty"><span role="status">Couldn’t load chats.</span><button type="button" className="sidebar-retry" onClick={retry} disabled={!praxis.api}>Retry</button></div>
          : sessions.length === 0 ? <div className="sidebar-empty">{query ? 'No matching chats' : 'Your conversations will appear here.'}</div> : sessions.map(session => {
          const pendingApproval = praxis.conversations[session.id]?.approvals.length > 0
          return <div className="session-row" key={session.id}><button type="button" className={`session-item ${session.id === praxis.activeId ? 'selected' : ''}`} aria-current={session.id === praxis.activeId ? 'page' : undefined} onClick={() => void praxis.openSession(session.id)} title={`${session.title || 'New chat'}\n${session.workspace}`}>
            <span>{session.title || 'New chat'}</span>
            {isBusy(session.status) && <span className={`session-dot ${pendingApproval ? 'approval-dot' : ''}`} aria-label={pendingApproval ? 'Awaiting approval' : 'Running'} />}
            {session.status === 'failed' && <CircleAlert size={12} className="error-text" />}
          </button><ChatActions session={session} onDelete={() => onDelete(session)} /></div>
        })}
      </div>
    </div>
    <div className="sidebar-footer"><button type="button" onClick={openSettings}><Settings2 size={16} /><span>Settings</span><kbd>Ctrl ,</kbd></button></div>
  </aside>
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
  return <dialog ref={ref} className="settings-dialog" onCancel={event => { if (saving) event.preventDefault(); else close() }} onClose={close} aria-labelledby="settings-title">
    <form onSubmit={event => void save(event)}>
      <div className="dialog-header"><div><h2 id="settings-title">Settings <span className="version">{praxis.info ? `v${praxis.info.version}` : ''}</span></h2><p>Connect to local Praxis and configure your workspace.</p></div><IconButton label="Close settings" disabled={saving} onClick={close}><X size={18} /></IconButton></div>
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(window.innerWidth < 900)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [quotes, setQuotes] = useState<Record<string, TextQuote | undefined>>({})
  const [panel, setPanel] = useState<{ session: string; target: PanelTarget }>()
  const [compactPanel, setCompactPanel] = useState(window.innerWidth <= 1100)
  const [showScroll, setShowScroll] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const stickToBottom = useRef(true)
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
  const openChanges = useCallback((turnId: string) => openPanel({ type: 'changes', turnId }), [openPanel])
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
  const ready = connected && !loading && praxis.configured !== false
  const mcpCommand = draft.trim().toLowerCase() === '/mcp'
  const deleteCommand = draft.trim().toLowerCase() === '/delete'
  const canSubmit = mcpCommand || deleteCommand ? connected : ready && !praxis.sending && !stopping
  const setDraft = (text: string) => setDrafts(previous => ({ ...previous, [draftKey]: text }))
  const syncScrollState = useCallback(() => {
    const container = scrollRef.current
    if (!container) return
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 64
    setShowScroll(!nearBottom)
  }, [])

  useEffect(() => {
    const compact = window.matchMedia('(max-width: 899px)')
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
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n' && !event.shiftKey && !settingsOpen && !mcpOpen && !deleteTarget) {
        event.preventDefault(); praxis.newChat(); requestAnimationFrame(() => textareaRef.current?.focus())
      }
      if ((event.ctrlKey || event.metaKey) && event.key === ',') { event.preventDefault(); setSettingsOpen(true) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [praxis.newChat, settingsOpen, mcpOpen, deleteTarget])

  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea) { textarea.style.height = 'auto'; textarea.style.height = `${Math.min(textarea.scrollHeight, 176)}px` }
  }, [draft])

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
  const empty = !active?.messages.length && !loading && !busy
  const showNavigation = !loading && Boolean(active?.messages.some(message => message.role === 'user')) && !(panelTarget && compactPanel)
  return <div className={`app ${sidebarCollapsed ? 'sidebar-is-collapsed' : ''}`}>
    <Sidebar praxis={praxis} collapsed={sidebarCollapsed} toggleSidebar={() => setSidebarCollapsed(value => !value)} openSettings={() => setSettingsOpen(true)} onDelete={setDeleteTarget} />
    <DeleteChatDialog session={deleteTarget ? praxis.conversations[deleteTarget.id]?.summary || deleteTarget : null} close={() => setDeleteTarget(null)} confirm={id => { void praxis.deleteSession(id) }} />
    <main className="main">
      <header className="titlebar">
        <div className="titlebar-leading">{sidebarCollapsed && <IconButton label="Expand sidebar" onClick={() => setSidebarCollapsed(false)}><PanelLeft size={16} /></IconButton>}<span className="titlebar-title" title={title}>{title}</span></div>
        <div className="titlebar-actions">{currentChanges && <button type="button" className="changes-trigger" aria-label="查看本轮改动" aria-expanded={panelTarget?.type === 'changes' && panelTarget.turnId === currentChanges.turnId} onClick={() => openChanges(currentChanges.turnId)}><GitCompareArrows size={14} /><span>改动 {currentChanges.files.length}</span></button>}{sidebarCollapsed && <IconButton label="New chat" onClick={praxis.newChat}><Plus size={17} /></IconButton>}
        <div className="window-controls"><IconButton label="Minimize" onClick={() => praxis.api?.windowAction('minimize')}><Minus size={15} /></IconButton><IconButton label="Maximize or restore" onClick={() => praxis.api?.windowAction('maximize')}><Maximize2 size={12} /></IconButton><IconButton label="Close window" className="window-close" onClick={() => praxis.api?.windowAction('close')}><X size={16} /></IconButton></div>
        </div>
      </header>

      {(connectionProblem || praxis.configured === false) && <div className="connection-banner" role="status"><CircleAlert size={16} /><span>{connectionProblem ? praxis.connection.message || 'Unable to connect to local Praxis. Check your runtime settings.' : 'No model API key configured. Add one in Settings or the Praxis environment.'}</span><button type="button" onClick={() => setSettingsOpen(true)}>Open settings</button>{connectionProblem && praxis.api && <button type="button" onClick={() => { void praxis.api.restart().catch(error => praxis.setError(errorMessage(error))) }}>Reconnect</button>}</div>}

      <div className={`workspace-content ${panelTarget ? 'has-panel' : ''} ${showNavigation ? 'has-navigation' : ''}`}>
      <div className={`conversation-body ${empty ? 'is-new' : ''}`} inert={Boolean(panelTarget && compactPanel)}>
      <div className="transcript" ref={scrollRef} onScroll={() => {
        const container = scrollRef.current
        if (container) stickToBottom.current = container.scrollHeight - container.scrollTop - container.clientHeight < 64
        syncScrollState()
      }} onWheel={event => {
        if (event.deltaY < 0) stickToBottom.current = false
      }} onClickCapture={event => {
        if (event.target instanceof Element && event.target.closest('summary, .process-summary')) stickToBottom.current = false
      }} onKeyDownCapture={event => {
        if ((event.key === 'Enter' || event.key === ' ') && event.target instanceof Element && event.target.closest('summary, .process-summary')) stickToBottom.current = false
      }}>
        <div className="transcript-content">
          <DisclosureState.Provider value={disclosures}>
          <FileNavigationContext.Provider value={fileNavigation}>
          {loading ? <div className="transcript-skeleton" aria-label="Loading chat history"><i /><i /><i /><i /></div> : empty ? <div className="empty-state"><h1><img className="welcome-wordmark" src={praxisWordmark} alt="Praxis" width={340} height={97} /></h1></div> : active && <Transcript key={praxis.activeId} conversation={active} changes={changes} onChanges={openChanges} />}
          </FileNavigationContext.Provider>
          </DisclosureState.Provider>
          {active?.approvals.map(approval => <ApprovalPrompt key={approval.approval_id} approval={approval} onRespond={praxis.approve} />)}
          {active && active.pendingInputs.length > 0 && <section className="paused-inputs"><div className="detail-label">待处理输入</div>{active.pendingInputs.map(item => <div key={item.command_id}><span>{item.content}</span><button onClick={() => void praxis.deleteInput(item.command_id)}>删除</button></div>)}{!busy && <button onClick={() => void praxis.resumeInputs()}>继续处理</button>}</section>}
        </div>
      </div>

      <div className="composer-region">
        {showScroll && <button type="button" className="scroll-bottom" aria-label="回到最新消息" title="回到最新消息" onClick={() => { const container = scrollRef.current; if (container) container.scrollTop = container.scrollHeight; stickToBottom.current = true; setShowScroll(false) }}><ArrowDown size={16} aria-hidden="true" /></button>}
        {praxis.error && <div className="composer-error" role="alert"><CircleAlert size={14} /><span>{praxis.error}</span>{praxis.deleteFailure && <button type="button" className="button" onClick={() => void praxis.deleteSession(praxis.deleteFailure!)}>Retry deletion</button>}<IconButton label="Dismiss error" onClick={() => praxis.setError('')}><X size={13} /></IconButton></div>}
        {!loading && active && (busy || active.plan.length > 0) && <ExecutionBar key={`${praxis.activeId}:${active.activeTurnId || 'current'}`} conversation={active} />}
        <form className={`composer ${busy ? 'composer-running' : ''}`} onSubmit={event => { event.preventDefault(); void submit() }}>
          {quote && <div className="quote-draft"><details><summary><Quote size={14} /><span><strong>引用助手回复</strong><span>{quote.text}</span></span><ChevronRight size={12} /></summary><blockquote>{quote.text}</blockquote></details><IconButton label="移除引用" disabled={praxis.sending} onClick={() => setQuotes(previous => ({ ...previous, [draftKey]: undefined }))}><X size={13} /></IconButton></div>}
          <textarea ref={textareaRef} aria-label={busy ? 'Follow-up message' : 'Send message'} value={draft} onChange={event => setDraft(event.target.value)} rows={2} disabled={loading} placeholder={stopping ? 'Stopping task…' : busy ? 'Add details or adjust the task…' : 'What would you like to work on?'} onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void submit() }
          }} />
          <div className="composer-toolbar">
            <div className="composer-context">
              <button type="button" className="composer-workspace" title={active?.summary?.workspace || praxis.workspace || 'Choose workspace for a new chat'} aria-label="Choose working directory" onClick={() => void praxis.chooseWorkspace()} disabled={!praxis.api}><Folder size={14} /><span>{baseName(active?.summary?.workspace || praxis.workspace) || 'Workspace'}</span><ChevronDown size={12} /></button>
              <span className="model-name" title={active?.summary?.model || praxis.info?.settings.model || 'Praxis environment settings'}>{active?.summary?.model || praxis.info?.settings.model || 'Default model'}</span>
              {praxis.info?.settings.bypassApprovals && <span className="approval-mode" title="Tools run without approval prompts">Bypass</span>}
            </div>
            <div className="composer-actions">{busy && <button type="button" className="stop-button" onClick={() => void praxis.stop()} disabled={stopping} title="Stop current task"><Square size={10} fill="currentColor" />{stopping ? 'Stopping' : 'Stop'}</button>}<button className="send-button" type="submit" aria-label={busy ? 'Send follow-up' : 'Send message'} title={busy ? 'Send follow-up' : 'Send message (Enter)'} disabled={!draft.trim() || !canSubmit}>{praxis.sending ? <LoaderCircle className="spin" size={16} /> : <ArrowUp size={18} />}</button></div>
          </div>
        </form>
      </div>
      </div>
      {panelTarget && <FilePanel key={`files:${draftKey}`} target={panelTarget} workspace={workspace} turns={changes} activeTurnId={active?.activeTurnId} onTarget={openPanel} onClose={closePanel} />}
      {showNavigation && active && praxis.activeId && <ConversationRail key={`navigation:${praxis.activeId}`} sessionId={praxis.activeId} messages={active.messages} scrollRef={scrollRef} onNavigate={() => { stickToBottom.current = false }} />}
      </div>
    </main>
    {!settingsOpen && !mcpOpen && !praxis.sending && !(panelTarget && compactPanel) && <QuoteSelection rootRef={scrollRef} sessionKey={draftKey} onQuote={addQuote} />}
    <SettingsDialog praxis={praxis} open={settingsOpen} close={() => setSettingsOpen(false)} />
    {mcpOpen && <McpStatusDialog close={() => { setMcpOpen(false); requestAnimationFrame(() => textareaRef.current?.focus()) }} />}
  </div>
}
