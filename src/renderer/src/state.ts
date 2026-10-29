import type { Approval, PraxisEvent, SessionSnapshot, SessionSummary, TranscriptMessage } from '../../shared/protocol'
import { readAgentReports } from './messagePresentation'
import { applyAgentEvent, type AgentExecution } from './agentPresentation'

export interface DisplayMessage extends TranscriptMessage {
  output?: string
  command?: string
  error?: boolean
  tool_finished?: boolean
  child_turn_id?: string
  file_change?: { path: string; diff: string; added: number; removed: number }
}

export interface PlanStep { description: string; status: string }

export interface TurnExecution {
  startedAt?: number
  finishedAt?: number
  finalMessageId?: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
}

export interface Conversation {
  /** Stable UI identity while a new local chat is attached to its server session. */
  clientId?: string
  localSession?: boolean
  submission?: { commandId: string; phase: 'creating' | 'sending'; queued: boolean }
  summary?: SessionSummary
  messages: DisplayMessage[]
  approvals: Approval[]
  plan: PlanStep[]
  plansByTurn: Record<string, PlanStep[]>
  turnsById: Record<string, TurnExecution>
  agentExecutions?: Record<string, AgentExecution>
  activeTurnId?: string
  sequence: number
  loaded: boolean
  activity: string
  pendingInputs: { command_id: string; content: string }[]
  sendingInputId?: string
  pausedInputs: string[]
}

export function emptyConversation(): Conversation {
  return { messages: [], approvals: [], plan: [], plansByTurn: {}, turnsById: {}, sequence: 0, loaded: false, activity: '', pausedInputs: [], pendingInputs: [] }
}

export const isBusy = (status?: string) => status === 'running' || status === 'stopping'
export const textOf = (value: unknown): string => typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value, null, 2)
const objectOf = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export const isChildAgent = (agentId?: string) => Boolean(agentId && agentId !== 'root' && agentId !== 'main')
const agentKey = (event: PraxisEvent) => isChildAgent(event.agent_id) ? event.agent_id : 'main'
const executionKey = (event: PraxisEvent) => textOf(event.data.child_turn_id) || event.turn_id
const toolKey = (event: PraxisEvent) => `tool:${event.turn_id}:${agentKey(event)}:${event.data.call_id}`
const assistantKey = (event: PraxisEvent) => `assistant:${event.turn_id}:${agentKey(event)}:${executionKey(event)}:${event.data.request_number ?? 'final'}`
const unfinishedToolStatuses = new Set(['running', 'pending', 'approval'])
const isUnfinishedTool = (message: DisplayMessage) => message.role === 'tool' && (unfinishedToolStatuses.has(message.status || '') || message.status === 'denied' && message.tool_finished === false)
const isCommand = (message: DisplayMessage) => message.tool_name === 'run_command' || message.tool_name === 'wait_command'
const isBackgroundCommand = (message: DisplayMessage) => isCommand(message) && message.tool_finished === true && message.status === 'running'

function readPlan(value: unknown): PlanStep[] {
  if (!Array.isArray(value)) return []
  return value.map(item => {
    const step = objectOf(item)
    return { description: textOf(step.description ?? step.step), status: textOf(step.status) }
  }).filter(step => step.description)
}

// Successful plan calls are part of the saved transcript, so the desktop can
// restore each turn's checklist without extending the backend protocol.
function restorePlans(messages: DisplayMessage[]): Record<string, PlanStep[]> {
  const plans: Record<string, PlanStep[]> = {}
  for (const message of messages) {
    if (message.tool_name !== 'update_plan' || !message.turn_id || isChildAgent(message.agent_id) || message.tool_finished === false
      || !['complete', 'completed'].includes(toolStatus(message) || '')) continue
    const plan = readPlan(message.arguments?.plan)
    if (plan.length) plans[message.turn_id] = plan
  }
  return plans
}

function updateTurnPlan(conversation: Conversation, turnId: string | undefined, plan: PlanStep[]): void {
  if (turnId) conversation.plansByTurn = { ...conversation.plansByTurn, [turnId]: plan }
  if (!conversation.activeTurnId || turnId === conversation.activeTurnId) {
    conversation.activeTurnId = turnId
    conversation.plan = plan
  }
}

function finishTurn(conversation: Conversation, turnId: string | undefined, status: Exclude<TurnExecution['status'], 'running'>, finalMessageId?: string): void {
  if (!turnId) return
  const previous = conversation.turnsById[turnId]
  conversation.turnsById = {
    ...conversation.turnsById,
    [turnId]: { ...previous, status, finishedAt: previous?.finishedAt ?? Date.now(), ...(finalMessageId ? { finalMessageId } : {}) }
  }
}

export function toolStatus(message: DisplayMessage): string | undefined {
  const result = message.structured_output
  if (message.status === 'cancelled' || result?.status === 'cancelled') return 'cancelled'
  if (message.status === 'denied') return 'denied'
  if (message.error || message.status === 'failed' || result?.status === 'failed' || result?.status === 'spawn_failed'
    || isCommand(message) && typeof result?.exit_code === 'number' && result.exit_code !== 0) return 'failed'
  if (result?.status === 'running') return 'running'
  return message.status
}

// A later wait_command result can finish a previously yielded command. Keep its
// original output, but update its status so the earlier row cannot spin forever.
function reconcileCommands(messages: DisplayMessage[]): DisplayMessage[] {
  const latest = new Map<string, DisplayMessage>()
  const next = messages.slice()
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const message = next[index]
    const id = message.structured_output?.session_id
    if (message.role !== 'tool' || !isCommand(message) || typeof id !== 'string') continue
    const key = `${isChildAgent(message.agent_id) ? message.agent_id : 'main'}:${id}`
    const result = latest.get(key)
    if (result && isBackgroundCommand(message)) {
      next[index] = { ...message, status: toolStatus(result), error: result.error,
        structured_output: { ...message.structured_output, status: result.structured_output?.status, exit_code: result.structured_output?.exit_code } }
    }
    if (!result) latest.set(key, message)
  }
  return next
}

function finalizeMessages(messages: DisplayMessage[], event: PraxisEvent, includeChildren: boolean, interruptTools: boolean): DisplayMessage[] {
  return messages.map(message => {
    if (message.turn_id !== event.turn_id) return message
    const messageAgent = isChildAgent(message.agent_id) ? message.agent_id : 'main'
    if ((!includeChildren || isChildAgent(event.agent_id)) && messageAgent !== agentKey(event)) return message
    if (isChildAgent(event.agent_id) && event.data.child_turn_id && message.child_turn_id && message.child_turn_id !== event.data.child_turn_id) return message
    if (interruptTools && isUnfinishedTool(message) && !isBackgroundCommand(message)) return { ...message, status: 'cancelled', error: false }
    if (message.role === 'assistant' && message.status === 'streaming') return { ...message, status: 'complete' }
    return message
  })
}

function updateMessage(messages: DisplayMessage[], id: string, update: (message?: DisplayMessage) => DisplayMessage): DisplayMessage[] {
  const index = messages.findIndex(message => message.id === id)
  if (index === -1) return [...messages, update()]
  const next = messages.slice()
  next[index] = update(messages[index])
  return next
}

function addUserMessage(messages: DisplayMessage[], text: string, event: PraxisEvent): DisplayMessage[] {
  // The command and its echo can arrive in either order. Match only pending local messages.
  const pending = messages.findIndex(message => message.role === 'user' && message.content === text && ['sending', 'queued', 'not_sent'].includes(message.status || ''))
  if (pending !== -1) {
    return messages.map((message, index) => index === pending ? { ...message, status: 'received', turn_id: event.turn_id } : message)
  }
  return [...messages, { id: event.event === 'TurnStarted' ? `user:${event.turn_id}:${agentKey(event)}:${executionKey(event)}` : `user:${event.turn_id}:${event.sequence}:${messages.length}`, role: 'user', content: text, turn_id: event.turn_id, agent_id: event.agent_id }]
}

export function applyEvent(current: Conversation, event: PraxisEvent): Conversation {
  if (event.sequence && event.sequence <= current.sequence) return current
  const data = event.data
  const next: Conversation = { ...current, sequence: event.sequence ?? current.sequence,
    agentExecutions: applyAgentEvent(current.agentExecutions || {}, event) }
  const child = isChildAgent(event.agent_id)
  const toolBase: DisplayMessage = { id: toolKey(event), role: 'tool', content: '', call_id: textOf(data.call_id), tool_name: textOf(data.tool_name), turn_id: event.turn_id, agent_id: event.agent_id, child_turn_id: textOf(data.child_turn_id) || undefined, tool_finished: false }

  switch (event.event) {
    case 'SessionUpdated':
      next.summary = data.session as unknown as SessionSummary
      if (current.submission && !next.summary.title && current.summary?.title) next.summary = { ...next.summary, title: current.summary.title }
      break
    case 'TurnStarted':
      if (child) {
        const raw = textOf(data.task)
        const reports = readAgentReports(raw)
        const content = reports ? reports.map(report => report.content).join('\n\n') : raw
        if (content) next.messages = [...current.messages, { id: `task:${event.turn_id}:${event.agent_id}:${executionKey(event)}`, role: 'user', content,
          turn_id: event.turn_id, agent_id: event.agent_id, child_turn_id: textOf(data.child_turn_id) || undefined, source: 'agent' }]
      } else {
        if (next.summary) next.summary = { ...next.summary, status: 'running' }
        next.messages = addUserMessage(current.messages, textOf(data.task), event)
        next.pausedInputs = current.pausedInputs.filter(text => text !== textOf(data.task))
        next.plan = []
        next.activeTurnId = event.turn_id
        if (event.turn_id) next.turnsById = { ...current.turnsById, [event.turn_id]: { status: 'running', startedAt: Date.now() } }
        next.activity = 'Thinking'
      }
      break
    case 'ModelRequestStarted':
      if (!child) next.activity = 'Thinking'
      break
    case 'AssistantTextDelta':
      next.messages = updateMessage(current.messages, assistantKey(event), message => ({
        ...message, id: assistantKey(event), role: 'assistant', content: (message?.content || '') + textOf(data.text), turn_id: event.turn_id, agent_id: event.agent_id, child_turn_id: textOf(data.child_turn_id) || undefined, status: 'streaming'
      }))
      if (!child) next.activity = 'Responding'
      break
    case 'ModelRequestCompleted': {
      const content = textOf(data.output_text)
      const existing = current.messages.find(message => message.id === assistantKey(event))
      if (existing || content) {
        next.messages = updateMessage(current.messages, assistantKey(event), message => ({
          ...message, id: assistantKey(event), role: 'assistant', content: content || message?.content || '', turn_id: event.turn_id, agent_id: event.agent_id, child_turn_id: textOf(data.child_turn_id) || undefined, status: 'complete'
        }))
      }
      break
    }
    case 'AssistantTextCompleted': {
      const content = textOf(data.text)
      const recent = [...current.messages].reverse().find(message => message.role === 'assistant' && message.turn_id === event.turn_id && (isChildAgent(message.agent_id) ? message.agent_id : 'main') === agentKey(event)
        && (!child || !data.child_turn_id || message.child_turn_id === data.child_turn_id))
      const finalMessageId = content.trim() ? recent?.id || assistantKey(event) : undefined
      if (finalMessageId) {
        next.messages = updateMessage(current.messages, finalMessageId, message => ({
          ...message, id: finalMessageId, role: 'assistant', content: content || message?.content || '', turn_id: event.turn_id, agent_id: event.agent_id, child_turn_id: textOf(data.child_turn_id) || undefined, status: 'complete'
        }))
      }
      // ModelRequestCompleted also ends interim responses. Only this root event
      // confirms which message is the final answer for the whole turn.
      if (!child) finishTurn(next, event.turn_id, 'completed', finalMessageId)
      break
    }
    case 'ToolCallPrepared':
      next.messages = updateMessage(current.messages, toolBase.id, message => ({ ...toolBase, ...message, arguments: objectOf(data.arguments), status: data.requires_approval ? 'approval' : 'pending' }))
      break
    case 'ToolStarted':
      next.messages = updateMessage(current.messages, toolBase.id, message => ({ ...toolBase, ...message, status: 'running' }))
      if (!child) next.activity = `Using ${textOf(data.tool_name)}`
      break
    case 'ToolOutputDelta':
      next.messages = updateMessage(current.messages, toolBase.id, message => ({
        ...toolBase, ...message, output: ((message?.output || '') + textOf(data.text)).slice(-120_000), command: textOf(data.command) || message?.command, status: data.finished ? message?.status || 'running' : 'running'
      }))
      break
    case 'ToolFinished': {
      const result = objectOf(data.result)
      const structured = objectOf(result.structured_output ?? result.output)
      next.messages = reconcileCommands(updateMessage(current.messages, toolBase.id, message => {
        const finished: DisplayMessage = {
          ...toolBase, ...message, content: textOf(result.content ?? result.output ?? data.result),
          status: textOf(result.output).startsWith('ExecutionStopped:') ? 'cancelled' : message?.status === 'denied' ? 'denied' : 'complete',
          error: Boolean(result.success === false || result.is_error || result.error),
          tool_finished: true, structured_output: structured,
          file_change: result.file_change as DisplayMessage['file_change']
        }
        const status = toolStatus(finished)
        return { ...finished, status, error: status === 'failed' }
      }))
      if (!child && toolBase.tool_name === 'update_plan') {
        const message = next.messages.find(item => item.id === toolBase.id)
        const plan = readPlan(message?.arguments?.plan)
        if (message && plan.length && toolStatus(message) === 'complete') updateTurnPlan(next, event.turn_id, plan)
      }
      if (!child && next.activity.startsWith('Using ')) next.activity = 'Running'
      break
    }
    case 'ApprovalPending':
      next.approvals = [...current.approvals.filter(approval => approval.approval_id !== data.approval_id), {
        approval_id: textOf(data.approval_id), tool_name: textOf(data.tool_name), arguments: objectOf(data.arguments), turn_id: event.turn_id, agent_id: event.agent_id
      }]
      if (!child) next.activity = 'Waiting for approval'
      break
    case 'ApprovalClosed':
      next.approvals = current.approvals.filter(approval => approval.approval_id !== data.approval_id)
      break
    case 'ApprovalResolved':
      next.messages = updateMessage(current.messages, toolBase.id, message => ({ ...toolBase, ...message, status: data.approved ? 'pending' : 'denied' }))
      break
    case 'PlanUpdated':
      if (!child && Array.isArray(data.plan)) {
        updateTurnPlan(next, event.turn_id || current.activeTurnId, readPlan(data.plan))
      }
      break
    case 'MessagesReceived':
      if (child && Array.isArray(data.items)) {
        const instructions = data.items.flatMap<DisplayMessage>((item, index) => {
          const value = objectOf(item)
          if (value.role === 'developer') return []
          const raw = Array.isArray(value.content) ? value.content.map(part => textOf(objectOf(part).text)).join('\n') : textOf(value.content)
          const reports = readAgentReports(raw)
          const content = reports ? reports.map(report => report.content).join('\n\n') : raw
          return content ? [{ id: `task:${event.turn_id}:${event.agent_id}:${event.sequence}:${index}`, role: 'user' as const, content,
            turn_id: event.turn_id, agent_id: event.agent_id, child_turn_id: textOf(data.child_turn_id) || undefined, source: 'agent' }] : []
        })
        next.messages = [...current.messages, ...instructions]
      } else if (Array.isArray(data.items)) {
        next.messages = data.items.reduce<DisplayMessage[]>((messages, item) => {
          const value = objectOf(item)
          if (data.source === 'agent' || value.role !== 'user') return messages
          const content = Array.isArray(value.content) ? value.content.map(part => textOf(objectOf(part).text)).join('\n') : textOf(value.content)
          if (content) next.pausedInputs = next.pausedInputs.filter(text => text !== content)
          return content ? addUserMessage(messages, content, event) : messages
        }, current.messages)
      }
      break
    case 'ChildAgentStatus':
      next.messages = updateMessage(current.messages, `agent:${event.turn_id}:${event.agent_id}`, message => ({ ...message, id: `agent:${event.turn_id}:${event.agent_id}`, role: 'system', content: textOf(data.task_summary) || message?.content || 'Subtask', turn_id: event.turn_id, agent_id: event.agent_id, status: textOf(data.status) }))
      break
    case 'ChildAgentMessage':
      next.messages = [...current.messages, { id: `child-message:${event.sequence}`, role: 'assistant', content: textOf(data.content), agent_id: event.agent_id, turn_id: event.turn_id, source: 'agent' }]
      break
    case 'InputsChanged':
      next.pendingInputs = (data.inputs || []) as { command_id: string; content: string }[]
      next.sendingInputId = textOf(data.sending_input_id) || undefined
      next.pausedInputs = next.pendingInputs.map(item => item.content)
      break
    case 'InputsPaused':
      next.pausedInputs = Array.isArray(data.texts) ? data.texts.map(textOf) : []
      next.messages = current.messages.map(message => message.status === 'queued' ? { ...message, status: 'paused' } : message)
      break
    case 'ContextCompaction':
      if (!child) next.activity = data.stage === 'completed' ? 'Thinking' : 'Compacting context'
      break
    case 'TurnFailed':
      next.messages = [...finalizeMessages(current.messages, event, false, child), { id: `error:${event.turn_id}:${agentKey(event)}`, role: 'system', content: textOf(data.message) || 'Task failed', error: true, turn_id: event.turn_id, agent_id: event.agent_id }]
      if (!child) {
        finishTurn(next, event.turn_id, 'failed')
        next.activity = 'Finishing task'
      }
      break
    case 'TurnCancelled':
      next.messages = finalizeMessages(current.messages, event, true, true)
      if (!child) {
        if (next.summary) next.summary = { ...next.summary, status: 'stopping' }
        next.messages = [...next.messages, { id: `cancelled:${event.turn_id}`, role: 'system', content: 'Stopped', status: 'cancelled', turn_id: event.turn_id }]
        finishTurn(next, event.turn_id, 'cancelled')
        next.activity = 'Finishing task'
        next.approvals = []
      }
      break
    case 'TurnCompleted':
      next.messages = finalizeMessages(current.messages, event, false, child)
      if (!child) {
        finishTurn(next, event.turn_id, 'completed')
        next.activity = 'Finishing task'
      }
      break
    case 'TurnSettled':
      next.messages = finalizeMessages(current.messages, event, true, true)
      if (!child) {
        if (next.summary) next.summary = { ...next.summary, status: data.status === 'cancelled' ? 'cancelled' : data.status === 'failed' ? 'failed' : 'idle' }
        finishTurn(next, event.turn_id, data.status === 'cancelled' ? 'cancelled' : data.status === 'failed' ? 'failed' : 'completed')
        next.activity = ''
        next.approvals = []
      }
      break
  }
  return next
}

export function applySnapshot(snapshot: SessionSnapshot, buffered: PraxisEvent[] = []): Conversation {
  // Cold history contains message IDs but no turn IDs. Use stable user-message
  // sections for display only; live protocol IDs always take precedence.
  let historyTurnId = `history:${snapshot.session.id}:start`
  // Older services projected model-only envelopes as ordinary user/system text.
  // Recover their sender identity without exposing the envelope in the main chat.
  const restored: DisplayMessage[] = []
  for (const message of snapshot.messages) {
    const reports = message.source !== 'user' && (message.role === 'user' || message.role === 'system') ? readAgentReports(message.content) : undefined
    if (!reports) { restored.push(message); continue }
    for (const [index, report] of reports.entries()) {
      const agent = isChildAgent(message.agent_id) ? message.agent_id : report.recipient_id === 'parent' ? report.sender_id : undefined
      if (!agent || !isChildAgent(agent)) continue
      if (snapshot.messages.some(other => other.agent_id === agent && other.turn_id === message.turn_id && other.content === report.content)) continue
      restored.push({ ...message, id: `${message.id}:report:${index}`, role: report.recipient_id === 'parent' ? 'assistant' : 'user', agent_id: agent, content: report.content, source: 'agent' })
    }
  }
  const history = restored.map(message => {
    if (message.turn_id) {
      if (!isChildAgent(message.agent_id)) historyTurnId = message.turn_id
      return message
    }
    if (message.role === 'user' && !isChildAgent(message.agent_id)) historyTurnId = `history:${snapshot.session.id}:${message.id}`
    return { ...message, turn_id: historyTurnId }
  })
  const messages = reconcileCommands(history).map(message => {
    if (message.role === 'tool') message = { ...message, status: toolStatus(message) }
    if (message.role === 'tool' && message.tool_finished === false && ['complete', 'completed'].includes(message.status || '')) {
      message = { ...message, status: isBusy(snapshot.session.status) ? 'pending' : 'cancelled' }
    }
    if (isBusy(snapshot.session.status)) return message
    if (isUnfinishedTool(message) && !isBackgroundCommand(message)) return { ...message, status: 'cancelled', error: false }
    if (message.role === 'assistant' && message.status === 'streaming') return { ...message, status: 'complete' }
    return message
  })
  const activeTurnId = snapshot.session.active_turn?.id || [...messages].reverse().find(message => message.turn_id && !isChildAgent(message.agent_id))?.turn_id
  const plansByTurn = restorePlans(messages)
  let current: Conversation = {
    ...emptyConversation(), summary: snapshot.session, messages,
    activeTurnId, plansByTurn, plan: activeTurnId ? plansByTurn[activeTurnId] || [] : [],
    approvals: snapshot.approvals, sequence: snapshot.sequence, loaded: true,
    activity: isBusy(snapshot.session.status) ? 'Running' : '',
    pendingInputs: snapshot.pending_inputs || [],
    sendingInputId: snapshot.sending_input_id || undefined,
    pausedInputs: (snapshot.pending_inputs || []).map(item => item.content)
  }
  current.agentExecutions = (snapshot.view_events || []).reduce((agents, event) => applyAgentEvent(agents, event), {} as Record<string, AgentExecution>)
  for (const event of buffered) current = applyEvent(current, event)
  return current
}
