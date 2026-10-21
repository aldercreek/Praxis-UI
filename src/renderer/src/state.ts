import type { Approval, PraxisEvent, SessionSnapshot, SessionSummary, TranscriptMessage } from '../../shared/protocol'

export interface DisplayMessage extends TranscriptMessage {
  output?: string
  command?: string
  error?: boolean
  tool_finished?: boolean
  child_turn_id?: string
  file_change?: { path: string; diff: string; added: number; removed: number }
}

export interface PlanStep { description: string; status: string }

export interface Conversation {
  summary?: SessionSummary
  messages: DisplayMessage[]
  approvals: Approval[]
  plan: PlanStep[]
  sequence: number
  loaded: boolean
  activity: string
  pausedInputs: string[]
}

export function emptyConversation(): Conversation {
  return { messages: [], approvals: [], plan: [], sequence: 0, loaded: false, activity: '', pausedInputs: [] }
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

function finalizeMessages(messages: DisplayMessage[], event: PraxisEvent, includeChildren: boolean, interruptTools: boolean): DisplayMessage[] {
  return messages.map(message => {
    if (message.turn_id !== event.turn_id) return message
    const messageAgent = isChildAgent(message.agent_id) ? message.agent_id : 'main'
    if ((!includeChildren || isChildAgent(event.agent_id)) && messageAgent !== agentKey(event)) return message
    if (isChildAgent(event.agent_id) && event.data.child_turn_id && message.child_turn_id && message.child_turn_id !== event.data.child_turn_id) return message
    if (interruptTools && isUnfinishedTool(message)) return { ...message, status: 'cancelled', error: false }
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
  const pending = messages.findIndex(message => message.role === 'user' && message.content === text && (message.status === 'sending' || message.status === 'queued'))
  if (pending !== -1) {
    return messages.map((message, index) => index === pending ? { ...message, status: 'received', turn_id: event.turn_id } : message)
  }
  return [...messages, { id: event.event === 'TurnStarted' ? `user:${event.turn_id}:${agentKey(event)}:${executionKey(event)}` : `user:${event.turn_id}:${event.sequence}:${messages.length}`, role: 'user', content: text, turn_id: event.turn_id, agent_id: event.agent_id }]
}

export function applyEvent(current: Conversation, event: PraxisEvent): Conversation {
  if (event.sequence && event.sequence <= current.sequence) return current
  const data = event.data
  const next: Conversation = { ...current, sequence: event.sequence ?? current.sequence }
  const child = isChildAgent(event.agent_id)
  const toolBase: DisplayMessage = { id: toolKey(event), role: 'tool', content: '', call_id: textOf(data.call_id), tool_name: textOf(data.tool_name), turn_id: event.turn_id, agent_id: event.agent_id, child_turn_id: textOf(data.child_turn_id) || undefined, tool_finished: false }

  switch (event.event) {
    case 'SessionUpdated':
      next.summary = data.session as unknown as SessionSummary
      break
    case 'TurnStarted':
      if (!child) {
        if (next.summary) next.summary = { ...next.summary, status: 'running' }
        next.messages = addUserMessage(current.messages, textOf(data.task), event)
        next.pausedInputs = current.pausedInputs.filter(text => text !== textOf(data.task))
        next.plan = []
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
      const recent = [...current.messages].reverse().find(message => message.role === 'assistant' && message.turn_id === event.turn_id && (isChildAgent(message.agent_id) ? message.agent_id : 'main') === agentKey(event))
      if (content && (!recent || recent.content !== content)) {
        next.messages = updateMessage(current.messages, recent?.id || assistantKey(event), message => ({
          ...message, id: recent?.id || assistantKey(event), role: 'assistant', content, turn_id: event.turn_id, agent_id: event.agent_id, child_turn_id: textOf(data.child_turn_id) || undefined, status: 'complete'
        }))
      }
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
      const cancelled = objectOf(result.structured_output).status === 'cancelled' || textOf(result.output).startsWith('ExecutionStopped:')
      next.messages = updateMessage(current.messages, toolBase.id, message => ({
        ...toolBase, ...message, content: textOf(result.content ?? result.output ?? data.result),
        status: cancelled ? 'cancelled' : message?.status === 'denied' ? 'denied' : result.success === false || result.is_error || result.error ? 'failed' : 'complete',
        error: cancelled || message?.status === 'denied' ? false : Boolean(result.success === false || result.is_error || result.error),
        tool_finished: true,
        file_change: result.file_change as DisplayMessage['file_change']
      }))
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
      if (!child && Array.isArray(data.plan)) next.plan = data.plan.map(item => ({ description: textOf(objectOf(item).description ?? objectOf(item).step), status: textOf(objectOf(item).status) }))
      break
    case 'MessagesReceived':
      if (!child && Array.isArray(data.items)) {
        next.messages = data.items.reduce<DisplayMessage[]>((messages, item) => {
          const value = objectOf(item)
          if (data.source !== 'user' && value.role !== 'user') return messages
          const content = Array.isArray(value.content) ? value.content.map(part => textOf(objectOf(part).text)).join('\n') : textOf(value.content)
          if (content) next.pausedInputs = next.pausedInputs.filter(text => text !== content)
          return content ? addUserMessage(messages, content, event) : messages
        }, current.messages)
      }
      break
    case 'ChildAgentStatus':
      next.messages = updateMessage(current.messages, `agent:${event.agent_id}`, message => ({ ...message, id: `agent:${event.agent_id}`, role: 'system', content: textOf(data.task_summary) || message?.content || 'Subtask', agent_id: event.agent_id, status: textOf(data.status) }))
      break
    case 'ChildAgentMessage':
      next.messages = [...current.messages, { id: `child-message:${event.sequence}`, role: 'assistant', content: textOf(data.content), agent_id: event.agent_id, turn_id: event.turn_id }]
      break
    case 'InputsPaused':
      next.pausedInputs = Array.isArray(data.texts) ? data.texts.map(textOf) : []
      next.messages = current.messages.map(message => message.status === 'queued' ? { ...message, status: 'paused' } : message)
      break
    case 'ContextCompaction':
      if (!child) next.activity = data.stage === 'completed' ? 'Thinking' : 'Compacting context'
      break
    case 'TurnFailed':
      next.messages = [...finalizeMessages(current.messages, event, false, child), { id: `error:${event.turn_id}:${agentKey(event)}`, role: 'system', content: textOf(data.message) || 'Task failed', error: true, agent_id: event.agent_id }]
      if (!child) next.activity = 'Finishing task'
      break
    case 'TurnCancelled':
      next.messages = finalizeMessages(current.messages, event, true, true)
      if (!child) {
        if (next.summary) next.summary = { ...next.summary, status: 'stopping' }
        next.messages = [...next.messages, { id: `cancelled:${event.turn_id}`, role: 'system', content: 'Task stopped' }]
        next.activity = 'Finishing task'
        next.approvals = []
      }
      break
    case 'TurnCompleted':
      next.messages = finalizeMessages(current.messages, event, false, child)
      if (!child) next.activity = 'Finishing task'
      break
    case 'TurnSettled':
      next.messages = finalizeMessages(current.messages, event, true, true)
      if (!child) {
        if (next.summary) next.summary = { ...next.summary, status: data.status === 'cancelled' ? 'cancelled' : data.status === 'failed' ? 'failed' : 'idle' }
        next.activity = ''
        next.approvals = []
      }
      break
  }
  return next
}

export function applySnapshot(snapshot: SessionSnapshot, buffered: PraxisEvent[] = []): Conversation {
  const messages = isBusy(snapshot.session.status) ? snapshot.messages : snapshot.messages.map(message => {
    if (isUnfinishedTool(message)) return { ...message, status: 'cancelled', error: false }
    if (message.role === 'assistant' && message.status === 'streaming') return { ...message, status: 'complete' }
    return message
  })
  let current: Conversation = {
    ...emptyConversation(), summary: snapshot.session, messages,
    approvals: snapshot.approvals, sequence: snapshot.sequence, loaded: true,
    activity: isBusy(snapshot.session.status) ? 'Running' : '',
    pausedInputs: (snapshot as SessionSnapshot & { pending_inputs?: string[] }).pending_inputs || []
  }
  for (const event of buffered) current = applyEvent(current, event)
  return current
}
