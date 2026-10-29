import { memo, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { ChevronRight, CircleAlert, GitBranch, FileDiff, Quote, Square } from './icons'
import { isChildAgent, type Conversation, type DisplayMessage, type PlanStep } from './state'
import { presentTranscript, completedLabel, type TranscriptItem, type TranscriptTurn } from './transcriptPresentation'
import { presentTool, type ToolGroup } from './toolPresentation'
import { Disclosure, DisclosureState, useDisclosure } from './Disclosure'
import { TurnPlan } from './ExecutionBar'
import { FileChangesContext, MarkdownContent } from './MarkdownContent'
import { type TurnChanges } from './changeSummary'
import { readQuotedInput } from './quotedInput'
import { CopyButton } from './CopyButton'
import { ToolMessage } from './ToolMessage'
import { processLayout } from './processLayout'
import { assistantDisplayText } from './messagePresentation'
import './timeline-layout.css'

function ChildTool({ message }: { message: DisplayMessage }) {
  const tool = presentTool(message)
  if (tool.status === 'Awaiting approval') return null
  return <div className="task-tool" data-message-id={message.id}>
    <span>{tool.command || tool.operation}</span>
    {(message.output || message.content) && <span>{message.output || message.content}</span>}
  </div>
}

function ToolActivity({ group }: { group: ToolGroup }) {
  return <div data-group-id={group.id} className="tool-group">
    <div className="tool-group-items">{group.messages.map(message => <ToolMessage key={message.id} message={message} />)}</div>
  </div>
}

const childOf = (item: TranscriptItem) => {
  const id = item.role === 'tool-group' ? item.messages[0]?.agent_id : item.agent_id
  return isChildAgent(id) ? id : undefined
}

function ChildTask({ turnId, agentId, messages, running }: { turnId: string; agentId: string; messages: DisplayMessage[]; running: boolean }) {
  const status = [...messages].reverse().find(message => message.role === 'system')
  const tools = messages.filter(message => message.role === 'tool')
  const prompt = messages.find(message => message.role === 'user')
  const active = running && (!status || ['running', 'pending', 'queued'].includes(status.status || ''))
  const failed = status?.error || status?.status === 'failed' || status?.status === 'cancelled'
  return <Disclosure storageKey={`task:${turnId}:${agentId}`} className="child-task" data-agent-id={agentId}>
    <summary>{!active && (failed ? <CircleAlert size={14} /> : <GitBranch size={14} />)}<span className={active ? 'text-sweep' : ''}>Task</span>
      <span className="task-caption">{status?.content || agentId}</span><span className="task-count">{tools.length} tool calls</span><ChevronRight className="disclosure-icon" size={12} /></summary>
    <div className="task-surface">{prompt && <p className="task-description">{prompt.content}</p>}
      {tools.length > 0 && <><div className="task-section-title">Tool executions</div><div className="task-tools">{tools.map(message => <ChildTool key={message.id} message={message} />)}</div></>}
      {messages.filter(message => message.role === 'assistant').map(message => <Message key={message.id} message={message} />)}
      {failed && <p className="error-text">{status?.status === 'cancelled' ? 'Subtask stopped' : 'Subtask failed'}</p>}
    </div>
  </Disclosure>
}

function ElapsedTime({ startedAt }: { startedAt?: number }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [])
  const seconds = startedAt === undefined ? undefined : Math.max(0, Math.floor((now - startedAt) / 1000))
  return <div className="turn-time">{seconds === undefined ? 'Processing' : `Processed ${seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`}`}</div>
}

function ProcessTurn({ turn, plan, changed, onChanges }: { turn: TranscriptTurn; plan?: PlanStep[]; changed?: TurnChanges; onChanges: (turnId: string, fileId?: string) => void }) {
  const regionId = useId()
  const ref = useRef<HTMLElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useDisclosure('process:' + turn.id + ':complete', false)
  const savedDisclosures = useContext(DisclosureState)
  const [middleChoices, setMiddleChoices] = useState<Record<string, boolean>>({})
  const middleOpen = (id: string) => middleChoices[id] ?? savedDisclosures?.get(`process:${turn.id}:${id}`) ?? false
  const toggleMiddle = (id: string) => {
    const next = !middleOpen(id)
    savedDisclosures?.set(`process:${turn.id}:${id}`, next)
    setMiddleChoices(previous => ({ ...previous, [id]: next }))
  }
  const firstAssistant = turn.items.findIndex(item => item.role !== 'user')
  const children = new Map<string, { first: string; messages: DisplayMessage[] }>()
  for (const item of turn.items) {
    const child = childOf(item)
    if (!child) continue
    const entry = children.get(child) || { first: item.id, messages: [] }
    entry.messages.push(...(item.role === 'tool-group' ? item.messages : [item]))
    children.set(child, entry)
  }
  const keepVisible = new Set<string>()
  const omitted = new Set<string>()
  for (const item of turn.items) {
    const child = childOf(item)
    const entry = child ? children.get(child) : undefined
    if (!entry) continue
    if (entry.first !== item.id) omitted.add(item.id)
    else if (entry.messages.some(message => message.role === 'system' && (message.error || ['failed', 'cancelled'].includes(message.status || '')))) keepVisible.add(item.id)
  }
  const layout = processLayout(turn, keepVisible, omitted)
  const hasProcess = layout.groupByItem.size > 0 || Boolean(plan?.length)
  const ids = new Map(turn.items.map((item, index) => [item.id, `${regionId}-${index}`]))
  const completedControl = `${regionId}-completed`
  const planRegion = `${regionId}-plan`
  const completedRegions = layout.completed.items.map(id => ids.get(id)!)
  if (plan?.length) completedRegions.push(planRegion)
  useLayoutEffect(() => {
    const hidden = [...(ref.current?.querySelectorAll<HTMLElement>('.process-entry[hidden]') || [])].find(entry => entry.contains(document.activeElement))
    if (hidden) document.getElementById(hidden.dataset.processController || completedControl)?.focus({ preventScroll: true })
  })
  return <FileChangesContext.Provider value={{ changes: changed, openChanges: onChanges }}><section className="transcript-turn" ref={ref} data-turn-id={turn.id}>
    {turn.items.map((item, index) => {
      const child = childOf(item)
      const childEntry = child ? children.get(child) : undefined
      const process = layout.groupByItem.get(item.id)
      const redundantChild = omitted.has(item.id)
      const localGroup = process?.kind === 'middle' ? process : undefined
      const localStart = localGroup?.items[0] === item.id
      const controller = localGroup ? `${ids.get(localGroup.items[0])}-process` : completedControl
      const showProcess = turn.running || (localGroup ? middleOpen(localGroup.id) : open)
      return <div className="turn-entry" key={item.id}>
        {index === firstAssistant && <>
          {turn.running ? <ElapsedTime startedAt={turn.execution?.startedAt} /> : hasProcess && <button ref={trigger} id={completedControl} type="button" className="process-summary process-completed" aria-expanded={open}
            aria-controls={completedRegions.length ? completedRegions.join(' ') : undefined} onClick={event => { if (event.detail < 2) setOpen(!open) }}>
            <span>{completedLabel(turn.execution || { status: turn.outcome })}</span><ChevronRight size={12} className="disclosure-icon" aria-hidden="true" />
          </button>}
          {plan?.length ? <div id={planRegion} className="process-entry" data-process-controller={completedControl} hidden={!turn.running && !open}><TurnPlan turnId={turn.id} plan={plan} /></div> : null}
        </>}
        {localGroup && localStart && <button key="process-control" id={controller} type="button" className="process-summary process-middle" data-process-group={localGroup.id}
          hidden={turn.running} aria-expanded={middleOpen(localGroup.id)} aria-controls={localGroup.items.map(id => ids.get(id)).join(' ')}
          onClick={event => { if (event.detail < 2) toggleMiddle(localGroup.id) }}>
          <span>Process</span><ChevronRight size={12} className="disclosure-icon" aria-hidden="true" />
        </button>}
        <div key="content" id={ids.get(item.id)} data-scroll-anchor={item.id} data-process-controller={process ? controller : undefined}
          className={item.id === turn.finalMessageId ? 'turn-final' : process ? 'process-entry' : undefined}
          hidden={redundantChild || Boolean(process && !showProcess)}>
          {redundantChild ? null : child && childEntry ? <ChildTask turnId={turn.id} agentId={child} messages={childEntry.messages} running={turn.running} />
            : item.role === 'tool-group' ? <ToolActivity group={item} /> : <Message message={item} showActions={item.id === turn.finalMessageId} />}
        </div>
      </div>
    })}
    {changed && <button type="button" className="turn-changes-summary" onClick={() => onChanges(changed.turnId)}><FileDiff size={14} /><span>{changed.files.length} {changed.files.length === 1 ? 'file' : 'files'} changed</span><ChevronRight size={12} /></button>}
  </section></FileChangesContext.Provider>
}

export const Transcript = memo(function Transcript({ conversation, changes, onChanges }: { conversation: Conversation; changes: TurnChanges[]; onChanges: (turnId: string, fileId?: string) => void }) {
  return presentTranscript(conversation).map(turn => <ProcessTurn key={turn.id} turn={turn}
    plan={!turn.running ? conversation.plansByTurn[turn.id] || (turn.id === conversation.activeTurnId ? conversation.plan : undefined) : undefined}
    changed={changes.find(change => change.turnId === turn.id)} onChanges={onChanges} />)
})

const Message = memo(function Message({ message, showActions = false }: { message: DisplayMessage; showActions?: boolean }) {
  if (message.role === 'tool') return <ToolMessage message={message} />
  if (message.role === 'system' && message.status === 'cancelled' && !message.agent_id) return <div className="turn-notice" role="status">{message.content}</div>
  if (message.role === 'system') return <div className={`system-message ${message.error ? 'error-text' : ''}`}>
    {message.error ? <CircleAlert size={14} /> : message.agent_id ? <GitBranch size={14} /> : <Square size={14} />}
    <span>{message.content}{message.agent_id && <span className="muted"> · {message.status || message.agent_id}</span>}</span>
  </div>
  const deliveryStatus = ['queued', 'sending', 'paused'].includes(message.status || '')
  const quoted = message.role === 'user' ? readQuotedInput(message.content) : undefined
  const displayText = message.role === 'assistant' ? assistantDisplayText(message.content, message.status === 'streaming', message.source === 'agent') : message.content
  if (message.role === 'assistant' && !displayText) return null
  return <article className={`message message-${message.role}`} aria-label={message.role === 'user' ? 'Your message' : 'Assistant response'} data-nav-message-id={message.role === 'user' && !isChildAgent(message.agent_id) ? message.id : undefined} tabIndex={message.role === 'user' ? -1 : undefined} data-quote-message-id={message.role === 'assistant' && !isChildAgent(message.agent_id) ? message.id : undefined}>
    {(isChildAgent(message.agent_id) || deliveryStatus) && <div className="message-label">
      {isChildAgent(message.agent_id) && <span>Subtask · {message.agent_id}</span>}
      {message.status === 'queued' && <span className="queued-label">Queued</span>}
      {message.status === 'sending' && <span className="queued-label">Sending</span>}
      {message.status === 'paused' && <span className="queued-label">Not received</span>}
    </div>}
    {message.role === 'user' ? <div className="user-content">{quoted ? <><details className="sent-quote"><summary><Quote size={12} /><span>{quoted.quote}</span><ChevronRight size={12} /></summary><blockquote>{quoted.quote}</blockquote></details><div>{quoted.text}</div></> : message.content}</div> : <MarkdownContent content={displayText} allowRelativeFiles={!isChildAgent(message.agent_id)} streaming={message.status === 'streaming'} />}
    {showActions && message.role === 'assistant' && message.status !== 'streaming' && <div className="message-actions"><CopyButton text={displayText} label="Copy response" /></div>}
  </article>
})
